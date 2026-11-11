// The background loop. Every 30 seconds it:
//   - pushes reminders for tasks whose time has come,
//   - writes (and pushes) the daily summary once the summary time passes,
//   - checks each email account on its interval and sorts what's new,
//   - re-sorts email the AI missed while it was unreachable.
import { AiClient, aiConfigFrom, aiTriageEmail } from "./ai.ts";
import { type DB, type EmailRow, type MailAccountRow, type SentRow, type Settings, type SourceRow, errorText, getSettings, logActivity } from "./db.ts";
import { judgeSent, matchReplies, ownText } from "./replies.ts";
import { readSource, storeItems } from "./sources.ts";
import { freshAccount } from "./microsoft.ts";
import { type MailSource, imapSource } from "./mail.ts";
import { type Sender, channels, sendPush } from "./notify.ts";
import { buildDigest, digestPush } from "./summary.ts";
import { reminderButtons } from "./actions.ts";
import type { TaskRow } from "./db.ts";
import { addDays, friendlyTime, hm, localDateTime, relativeDay, todayYmd } from "./time.ts";
import { ATTENTION, senderRules, snippetOf, triage } from "./triage.ts";

export interface EngineDeps {
  mail?: MailSource;
  /** Microsoft's sign-in server (tests point this at a fake). */
  microsoftBase?: string;
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
const MAX_NAGS = 12;
const SOURCE_INTERVAL_MS = 30 * 60_000;
const daysAgo = (ms: number, now: Date) => {
  const d = Math.floor((now.getTime() - ms) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};
/** Nags hold off overnight. */
export const QUIET_START = "22:00";
export const QUIET_END = "07:00";
const isQuiet = (d: Date) => {
  const t = hm(d);
  return t >= QUIET_START || t < QUIET_END;
};
const nagText = (m: number) => (m < 60 ? `${m} min` : m === 60 ? "hour" : `${m / 60} hours`);

export class Engine {
  db: DB;
  mail: MailSource;
  send: Sender;
  now: () => Date;
  microsoftBase: string;
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
    this.microsoftBase = deps.microsoftBase ?? "https://login.microsoftonline.com";
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
      // Calendars first, so the morning summary has today's schedule in it.
      await this.syncDueSources();
      await this.dailySummary(s);
      await this.nudgeReplies(s);
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

  /**
   * One pass over open tasks that are due. A task with a time gets one push at
   * that time. Snoozed, it's pushed again when the snooze ends. With nag mode
   * on, it's pushed again every N minutes until it's done (quietly overnight,
   * and at most MAX_NAGS times per due date). A date-only task in nag mode
   * starts at the summary time.
   */
  async reminders(s: Settings) {
    const now = this.now();
    const nowMs = now.getTime();
    const today = todayYmd(now);
    const quiet = isQuiet(now);
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE done_at IS NULL AND due_date IS NOT NULL AND due_date <= ?")
      .all(addDays(today, 1)) as unknown as TaskRow[];
    for (const t of rows) {
      const startTime = t.due_time ?? (t.nag_minutes ? s.summaryTime : null);
      if (!startTime || !t.due_date) continue;
      const at = localDateTime(t.due_date, startTime).getTime() - (t.due_time ? s.reminderLeadMinutes * 60_000 : 0);
      if (at > nowMs) continue;
      const key = `${t.due_date} ${startTime}`;
      let kind: "first" | "snooze" | "nag" | null = null;
      if (t.snoozed_until) {
        if (t.snoozed_until > nowMs) continue;
        kind = "snooze";
      } else if (t.notified_for !== key) kind = "first";
      else if (t.nag_minutes && t.nag_count < MAX_NAGS && !quiet && nowMs - (t.last_pushed_at ?? 0) >= t.nag_minutes * 60_000) kind = "nag";
      if (!kind) continue;
      this.db
        .prepare("UPDATE tasks SET notified_for = ?, last_pushed_at = ?, snoozed_until = NULL, nag_count = nag_count + ? WHERE id = ?")
        .run(key, nowMs, kind === "nag" ? 1 : 0, t.id);
      if (!s.remindersPush || !channels(s).length) continue;
      // Hours late (the server was off): don't send a stale one-off reminder, and nothing in the middle of the night.
      if (kind === "first" && nowMs - at > LATE_REMINDER_MS && (quiet || !t.nag_minutes)) continue;
      const when =
        t.due_date === today
          ? t.due_time
            ? `Today at ${friendlyTime(t.due_time)}`
            : "Today"
          : t.due_date < today
            ? `Was due ${relativeDay(t.due_date, today)}${t.due_time ? ` at ${friendlyTime(t.due_time)}` : ""}`
            : `${relativeDay(t.due_date, today)} at ${friendlyTime(t.due_time!)}`;
      const lines = [when.charAt(0).toUpperCase() + when.slice(1)];
      if (t.list) lines.push(`List: ${t.list}`);
      if (t.nag_minutes) lines.push(`Reminding you every ${nagText(t.nag_minutes)} until it's done`);
      const buttons = reminderButtons(this.db, s, t);
      try {
        await this.send(s, {
          title: kind === "nag" ? `Still to do: ${t.title}` : t.title,
          message: lines.join("\n"),
          url: s.publicUrl ? `${s.publicUrl.replace(/\/+$/, "")}/` : undefined,
          urlTitle: "Open Docket",
          priority: t.priority === 2 || kind === "nag" ? "high" : "normal",
          ...buttons,
        });
        if (kind !== "nag") logActivity(this.db, "reminder", `${kind === "snooze" ? "Snooze over" : "Reminded you"}: ${t.title}`);
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
      const { digest, aiError } = await buildDigest(this.db, this.client(s), { now: this.now(), aboutMe: s.aboutMe, waitDays: s.replyWaitDays });
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
      a = await freshAccount(this.db, a, this.microsoftBase);
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
         decided_by, ai_pending, pending_text, suggestion, suggestion_state, handled, created_at, in_reply_to, refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const pushes: { title: string; message: string; high: boolean }[] = [];
    const newIds: number[] = [];
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
        m.inReplyTo,
        m.references.join(" ") || null,
      );
      if (!res.changes) continue;
      result.added++;
      newIds.push(Number(res.lastInsertRowid));
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
    const answered = newIds.length ? matchReplies(this.db, newIds) : 0;
    if (answered) logActivity(this.db, "mail", `${answered} email${answered === 1 ? "" : "s"} you were waiting on got a reply`);
    if (a.track_replies) await this.checkSent(a, s, ai);
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

  /** Reads new mail in the Sent folder and keeps the ones that expect an answer. A problem here never stops the inbox check. */
  private async checkSent(a: MailAccountRow, s: Settings, ai: AiClient | null) {
    let batch;
    try {
      // A longer look back than the inbox, so a question sent last week is still followed.
      batch = await this.mail.fetchSent(a, { lookbackDays: Math.max(s.mailLookbackDays, s.replyWaitDays + 7), limit: 30 });
    } catch (err) {
      logActivity(this.db, "error", `Couldn't read the Sent folder of ${a.label}: ${errorText(err)}`);
      return;
    }
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO sent_mail (account_id, uid, message_id, to_name, to_addr, subject, snippet, sent_at, state, reason, decided_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const self = [a.username.toLowerCase()];
    let aiFailed = false;
    let waiting = 0;
    for (const m of batch.messages) {
      if (m.messageId && this.db.prepare("SELECT 1 FROM sent_mail WHERE message_id = ?").get(m.messageId)) continue;
      const v = await judgeSent(m, { ai: aiFailed ? null : ai, self, aboutMe: s.aboutMe });
      if (!v) continue;
      if (v.aiError) {
        aiFailed = true;
        this.noteAi(v.aiError);
      }
      const to = m.to.find((t) => !self.includes(t.addr)) ?? m.to[0];
      insert.run(a.id, m.uid, m.messageId, to?.name || null, to?.addr || null, m.subject, snippetOf(ownText(m.text)), m.date.getTime(), v.state, v.reason, v.decidedBy, Date.now());
      if (v.state === "waiting") waiting++;
    }
    this.db.prepare("UPDATE mail_accounts SET sent_folder = ?, sent_uid_validity = ?, sent_last_uid = ? WHERE id = ?").run(batch.folder, batch.uidValidity, batch.lastUid, a.id);
    if (waiting) matchReplies(this.db);
  }

  /** Once, when something you sent has gone unanswered for the wait period. */
  async nudgeReplies(s: Settings) {
    const cutoff = this.now().getTime() - s.replyWaitDays * 86_400_000;
    const due = this.db.prepare("SELECT * FROM sent_mail WHERE state = 'waiting' AND nudged = 0 AND sent_at < ?").all(cutoff) as unknown as SentRow[];
    if (!due.length) return;
    this.db.prepare(`UPDATE sent_mail SET nudged = 1 WHERE id IN (${due.map(() => "?").join(",")})`).run(...due.map((d) => d.id));
    if (!s.emailPush || !channels(s).length || isQuiet(this.now())) return;
    const who = (d: SentRow) => d.to_name || d.to_addr || "them";
    try {
      await this.send(s, {
        title: due.length === 1 ? `No reply yet from ${who(due[0])}` : `${due.length} emails still waiting on a reply`,
        message: due.map((d) => `• ${who(d)}: “${d.subject}” (sent ${daysAgo(d.sent_at, this.now())})`).join("\n"),
        url: s.publicUrl ? `${s.publicUrl.replace(/\/+$/, "")}/inbox?view=waiting` : undefined,
        urlTitle: "Open Waiting on",
      });
    } catch (err) {
      logActivity(this.db, "error", `Couldn't send the follow-up reminder: ${errorText(err)}`);
    }
  }

  // --- Calendars and carrel ---------------------------------------------------------

  private syncing = new Set<number>();

  /** Reads one calendar or carrel now. Returns how many items it holds, or throws. */
  async syncSource(id: number): Promise<number> {
    const src = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as unknown as SourceRow | undefined;
    if (!src) throw new Error("That calendar is gone");
    if (this.syncing.has(id)) return (this.db.prepare("SELECT count(*) AS n FROM external_items WHERE source_id = ?").get(id) as { n: number }).n;
    this.syncing.add(id);
    try {
      const items = await readSource(src, this.now());
      storeItems(this.db, src.id, items);
      this.db.prepare("UPDATE sources SET last_synced_at = ?, last_error = NULL WHERE id = ?").run(Date.now(), src.id);
      return items.length;
    } catch (err) {
      const msg = errorText(err);
      this.db.prepare("UPDATE sources SET last_synced_at = ?, last_error = ? WHERE id = ?").run(Date.now(), msg, src.id);
      logActivity(this.db, "error", `Couldn't read ${src.name}: ${msg}`);
      throw err;
    } finally {
      this.syncing.delete(id);
    }
  }

  private async syncDueSources() {
    const due = this.db
      .prepare("SELECT id FROM sources WHERE enabled = 1 AND (last_synced_at IS NULL OR last_synced_at < ?)")
      .all(Date.now() - SOURCE_INTERVAL_MS) as { id: number }[];
    for (const { id } of due) await this.syncSource(id).catch(() => {});
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
