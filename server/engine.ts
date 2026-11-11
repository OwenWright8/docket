// The background loop. Every 30 seconds it:
//   - pushes reminders for tasks whose time has come,
//   - writes (and pushes) the daily summary once the summary time passes,
//   - checks each email account on its interval and sorts what's new,
//   - re-sorts email the AI missed while it was unreachable.
import { AiClient, aiConfigFrom, aiTriageEmail } from "./ai.ts";
import { type DB, type EmailRow, type MailAccountRow, type Settings, errorText, getSettings, logActivity } from "./db.ts";
import { type MailSource, imapSource } from "./mail.ts";
import { type Sender, channels, sendPush } from "./notify.ts";
import { buildDigest, digestPush } from "./summary.ts";
import { friendlyTime, hm, localDateTime, todayYmd } from "./time.ts";
import { ATTENTION, senderRules, snippetOf, triage } from "./triage.ts";

export interface EngineDeps {
  mail?: MailSource;
  send?: Sender;
  now?: () => Date;
}

export interface AiStatus {
  configured: boolean;
  ok: boolean | null;
  error: string | null;
  checkedAt: number | null;
}

export interface MailResult {
  account: string;
  added: number;
  attention: number;
  error?: string;
}

const MAX_PER_CHECK = 40;
const LATE_REMINDER_MS = 2 * 3_600_000; // a reminder more than 2 h late (server was off) isn't sent

export class Engine {
  db: DB;
  mail: MailSource;
  send: Sender;
  now: () => Date;
  ai: AiStatus = { configured: false, ok: null, error: null, checkedAt: null };
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private mailRunning: Promise<MailResult[]> | null = null;
  private lastRetry = 0;
  private digestRunning = false;

  constructor(db: DB, deps: EngineDeps = {}) {
    this.db = db;
    this.mail = deps.mail ?? imapSource;
    this.send = deps.send ?? sendPush;
    this.now = deps.now ?? (() => new Date());
  }

  start() {
    const run = () => this.tick().catch((err) => logActivity(this.db, "error", `Background check failed: ${errorText(err)}`));
    setTimeout(run, 5_000).unref();
    this.timer = setInterval(run, 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** An AI client for the current settings, or null when there isn't one. */
  client(s: Settings = getSettings(this.db)): AiClient | null {
    const cfg = aiConfigFrom(s);
    this.ai.configured = !!cfg;
    return cfg ? new AiClient(cfg) : null;
  }

  /** Records how the last call to the model went, for the status shown in the app. */
  noteAi(error?: string | null) {
    this.ai = { ...this.ai, ok: !error, error: error ?? null, checkedAt: Date.now() };
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const s = getSettings(this.db);
      if (!s.setupComplete) return;
      await this.reminders(s);
      await this.dailySummary(s);
      if (this.mailDue(s)) void this.checkMail();
      if (Date.now() - this.lastRetry > 10 * 60_000) {
        this.lastRetry = Date.now();
        void this.retryAi(s);
      }
    } finally {
      this.ticking = false;
    }
  }

  // --- Reminders ------------------------------------------------------------------

  async reminders(s: Settings) {
    const now = this.now();
    const rows = this.db
      .prepare("SELECT id, title, due_date, due_time, notified_for, priority, list FROM tasks WHERE done_at IS NULL AND due_date IS NOT NULL AND due_time IS NOT NULL")
      .all() as { id: number; title: string; due_date: string; due_time: string; notified_for: string | null; priority: number; list: string | null }[];
    for (const t of rows) {
      const key = `${t.due_date} ${t.due_time}`;
      if (t.notified_for === key) continue;
      const at = localDateTime(t.due_date, t.due_time).getTime() - s.reminderLeadMinutes * 60_000;
      if (at > now.getTime()) continue;
      this.db.prepare("UPDATE tasks SET notified_for = ? WHERE id = ?").run(key, t.id);
      if (!s.remindersPush || !channels(s).length || now.getTime() - at > LATE_REMINDER_MS) continue;
      const today = todayYmd(now);
      const when = t.due_date === today ? `Today at ${friendlyTime(t.due_time)}` : `Was due ${t.due_date} at ${friendlyTime(t.due_time)}`;
      try {
        await this.send(s, {
          title: t.title,
          message: [when, t.list ? `List: ${t.list}` : ""].filter(Boolean).join("\n"),
          url: s.publicUrl ? `${s.publicUrl.replace(/\/+$/, "")}/` : undefined,
          urlTitle: "Open Docket",
          priority: t.priority === 2 ? "high" : "normal",
        });
        logActivity(this.db, "reminder", `Reminded you: ${t.title}`);
      } catch (err) {
        logActivity(this.db, "error", `Couldn't send the reminder for "${t.title}": ${errorText(err)}`);
      }
    }
  }

  // --- Daily summary -------------------------------------------------------------

  async dailySummary(s: Settings) {
    if (!s.summaryEnabled || this.digestRunning) return;
    const now = this.now();
    const today = todayYmd(now);
    if (hm(now) < s.summaryTime) return;
    const existing = this.db.prepare("SELECT scheduled_at FROM digests WHERE date = ?").get(today) as { scheduled_at: number | null } | undefined;
    if (existing?.scheduled_at) return;
    // A summary for today written by hand before the summary time still gets sent at that time, rewritten fresh.
    // Hours late (the server was off, or this was just set up at night) it's written but not pushed.
    const late = now.getTime() - localDateTime(today, s.summaryTime).getTime() > 3 * 3_600_000;
    await this.writeDigest(s, s.summaryPush && !late, true);
  }

  /** Writes today's summary; optionally pushes it. */
  async writeDigest(s: Settings, push: boolean, scheduled = false) {
    this.digestRunning = true;
    try {
      const { digest, aiError } = await buildDigest(this.db, this.client(s), { now: this.now(), aboutMe: s.aboutMe });
      if (this.ai.configured) this.noteAi(aiError);
      if (push && channels(s).length) {
        try {
          const p = digestPush(digest);
          await this.send(s, { ...p, url: s.publicUrl ? `${s.publicUrl.replace(/\/+$/, "")}/` : undefined, urlTitle: "Open Docket" });
          logActivity(this.db, "summary", "Sent your daily summary");
          digest.sentAt = Date.now();
          this.db.prepare("UPDATE digests SET sent_at = ? WHERE date = ?").run(digest.sentAt, digest.date);
        } catch (err) {
          logActivity(this.db, "error", `Couldn't send the daily summary: ${errorText(err)}`);
        }
      }
      // The morning run counts as done whether or not it could push, so it isn't redone every 30 seconds.
      if (scheduled) this.db.prepare("UPDATE digests SET scheduled_at = ? WHERE date = ?").run(Date.now(), digest.date);
      return { digest, aiError };
    } finally {
      this.digestRunning = false;
    }
  }

  // --- Email --------------------------------------------------------------------

  private mailDue(s: Settings): boolean {
    const due = Date.now() - Math.max(5, s.mailIntervalMinutes) * 60_000;
    const row = this.db.prepare("SELECT 1 FROM mail_accounts WHERE enabled = 1 AND (last_checked_at IS NULL OR last_checked_at < ?) LIMIT 1").get(due);
    return !!row;
  }

  get mailBusy() {
    return !!this.mailRunning;
  }

  /** Checks every enabled account (or one). Concurrent calls share the run in progress. */
  checkMail(accountId?: number): Promise<MailResult[]> {
    if (this.mailRunning) return this.mailRunning;
    this.mailRunning = this.runMail(accountId).finally(() => (this.mailRunning = null));
    return this.mailRunning;
  }

  private async runMail(accountId?: number): Promise<MailResult[]> {
    const s = getSettings(this.db);
    const accounts = (
      accountId
        ? this.db.prepare("SELECT * FROM mail_accounts WHERE id = ?").all(accountId)
        : this.db.prepare("SELECT * FROM mail_accounts WHERE enabled = 1").all()
    ) as unknown as MailAccountRow[];
    const out: MailResult[] = [];
    for (const a of accounts) out.push(await this.checkAccount(a, s));
    return out;
  }

  private async checkAccount(a: MailAccountRow, s: Settings): Promise<MailResult> {
    const result: MailResult = { account: a.label, added: 0, attention: 0 };
    let batch;
    try {
      batch = await this.mail.fetch(a, { lookbackDays: s.mailLookbackDays, limit: MAX_PER_CHECK });
    } catch (err) {
      const msg = errorText(err);
      this.db.prepare("UPDATE mail_accounts SET last_checked_at = ?, last_error = ? WHERE id = ?").run(Date.now(), msg, a.id);
      logActivity(this.db, "error", `Couldn't check ${a.label}: ${msg}`);
      return { ...result, error: msg };
    }
    const ai = this.client(s);
    const rules = senderRules(this.db);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO emails (account_id, uid, message_id, from_name, from_addr, subject, snippet, received_at, bulk, category, summary, reason,
         decided_by, ai_pending, pending_text, suggestion, suggestion_state, handled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const pushes: { title: string; message: string; high: boolean }[] = [];
    let aiFailed = false;
    for (const m of batch.messages) {
      const seen = m.messageId && this.db.prepare("SELECT 1 FROM emails WHERE message_id = ? AND account_id = ?").get(m.messageId, a.id);
      if (seen) continue;
      // Once the model has failed in this check, don't wait on it for every message.
      const v = await triage(m, { rules, ai: aiFailed ? null : ai, aboutMe: s.aboutMe, now: this.now() });
      if (ai && !aiFailed) this.noteAi(v.aiError);
      if (v.aiError) aiFailed = true;
      const category = v.ignored ? "ignored" : v.category;
      const res = insert.run(
        a.id,
        m.uid,
        m.messageId,
        m.fromName,
        m.fromAddr,
        m.subject,
        snippetOf(m.text),
        m.date.getTime(),
        m.bulk ? 1 : 0,
        category,
        v.summary || null,
        v.reason || null,
        v.decidedBy,
        v.aiPending && ai && !v.ignored ? 1 : 0,
        v.aiPending && ai && !v.ignored ? m.text.slice(0, 4000) : null,
        v.task ? JSON.stringify(v.task) : null,
        v.task ? "pending" : null,
        v.ignored ? 1 : 0,
        Date.now(),
      );
      if (!res.changes) continue;
      result.added++;
      if (ATTENTION.includes(category)) {
        result.attention++;
        // Only fresh mail is pushed: the first look back over old mail stays quiet.
        if (Date.now() - m.date.getTime() < 6 * 3_600_000) {
          pushes.push({
            title: `${category === "action" ? "To do" : "Email"}: ${m.subject}`,
            message: [m.fromName || m.fromAddr, v.summary || snippetOf(m.text).slice(0, 160), v.task ? `Suggested task: ${v.task.title}` : ""].filter(Boolean).join("\n"),
            high: category === "action",
          });
          this.db.prepare("UPDATE emails SET notified = 1 WHERE id = ?").run(Number(res.lastInsertRowid));
        }
      }
    }
    this.db
      .prepare("UPDATE mail_accounts SET uid_validity = ?, last_uid = ?, last_checked_at = ?, last_error = NULL WHERE id = ?")
      .run(batch.uidValidity, batch.lastUid, Date.now(), a.id);
    if (result.added) logActivity(this.db, "mail", `${a.label}: sorted ${result.added} new email${result.added === 1 ? "" : "s"}, ${result.attention} need${result.attention === 1 ? "s" : ""} you`);
    if (s.emailPush && channels(s).length && pushes.length) {
      try {
        if (pushes.length <= 3) for (const p of pushes) await this.send(s, { title: p.title, message: p.message, priority: p.high ? "high" : "normal", url: this.inboxUrl(s), urlTitle: "Open inbox" });
        else
          await this.send(s, {
            title: `${pushes.length} emails need you`,
            message: pushes.map((p) => `• ${p.title}`).join("\n"),
            url: this.inboxUrl(s),
            urlTitle: "Open inbox",
          });
      } catch (err) {
        logActivity(this.db, "error", `Couldn't send the email alert: ${errorText(err)}`);
      }
    }
    return result;
  }

  private inboxUrl(s: Settings) {
    return s.publicUrl ? `${s.publicUrl.replace(/\/+$/, "")}/inbox` : undefined;
  }

  /** Email sorted without the AI (it was unreachable) gets a proper look once it's back. */
  async retryAi(s: Settings = getSettings(this.db)): Promise<number> {
    const ai = this.client(s);
    if (!ai) return 0;
    const rows = this.db.prepare("SELECT * FROM emails WHERE ai_pending = 1 ORDER BY received_at DESC LIMIT 25").all() as unknown as EmailRow[];
    let done = 0;
    for (const e of rows) {
      try {
        const v = await aiTriageEmail(
          ai,
          {
            fromName: e.from_name ?? "",
            fromAddr: e.from_addr ?? "",
            subject: e.subject ?? "",
            date: new Date(e.received_at).toISOString(),
            bulk: !!e.bulk,
            text: e.pending_text ?? e.snippet ?? "",
          },
          { now: this.now(), aboutMe: s.aboutMe },
        );
        this.noteAi(null);
        const keepCategory = e.decided_by === "rule" || e.decided_by === "you";
        this.db
          .prepare(
            `UPDATE emails SET category = ?, summary = ?, reason = ?, decided_by = ?, ai_pending = 0, pending_text = NULL,
               suggestion = coalesce(suggestion, ?), suggestion_state = coalesce(suggestion_state, ?) WHERE id = ?`,
          )
          .run(
            keepCategory ? e.category : v.category,
            v.summary || null,
            keepCategory ? e.reason : v.reason || null,
            keepCategory ? e.decided_by : "ai",
            v.task ? JSON.stringify(v.task) : null,
            v.task ? "pending" : null,
            e.id,
          );
        done++;
      } catch (err) {
        this.noteAi(errorText(err));
        break;
      }
    }
    if (done) logActivity(this.db, "ai", `The AI caught up on ${done} email${done === 1 ? "" : "s"} it missed while it was offline`);
    return done;
  }
}
