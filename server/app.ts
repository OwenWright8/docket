// HTTP API and static frontend.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { AiClient, aiParseTasks } from "./ai.ts";
import {
  type DB,
  type EmailRow,
  type MailAccountRow,
  type Settings,
  SECRET_KEYS,
  errorText,
  getSettings,
  saveSettings,
  tx,
} from "./db.ts";
import {
  LoginLimiter,
  SESSION_COOKIE,
  createSession,
  deleteAllSessions,
  deleteSession,
  hashPassword,
  validSession,
  verifyPassword,
} from "./auth.ts";
import { Engine, type EngineDeps } from "./engine.ts";
import { channels } from "./notify.ts";
import { parseQuickAdd } from "./parse.ts";
import { latestDigest } from "./summary.ts";
import {
  completeTask,
  createTask,
  getTask,
  knownLists,
  lastDoneMap,
  openTasks,
  publicTask,
  undoLog,
  updateTask,
} from "./tasks.ts";
import type { TaskRow } from "./db.ts";
import { addDays, isHm, todayYmd } from "./time.ts";
import { ATTENTION, normalizePattern, ruleFor, senderRules } from "./triage.ts";
import { UpdateChecker, isNewer } from "./update-check.ts";

export interface AppOptions extends EngineDeps {
  db: DB;
  version: string;
  repo: string;
  updateCheck: boolean;
  updateApiBase?: string;
  webRoot?: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; engine: Engine; updates: UpdateChecker }> {
  const { db } = opts;
  const engine = new Engine(db, opts);
  const updates = new UpdateChecker(opts.updateCheck, opts.repo, opts.updateApiBase);
  const limiter = new LoginLimiter();
  const now = () => engine.now();

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1024 * 1024 });
  await app.register(cookie);

  const isAuthed = (req: FastifyRequest) => validSession(db, req.cookies[SESSION_COOKIE]);
  const setSessionCookie = (req: FastifyRequest, reply: FastifyReply) => {
    const { token, maxAge } = createSession(db);
    reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: req.protocol === "https", maxAge });
  };

  const PUBLIC = new Set(["/api/health", "/api/session", "/api/login", "/api/account/create"]);
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/") || PUBLIC.has(url)) return;
    if (!isAuthed(req)) return reply.code(401).send({ error: "Sign in first" });
  });

  // --- Session & account ---------------------------------------------------------

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/session", async (req) => {
    const s = getSettings(db);
    return { authenticated: isAuthed(req), needsAccount: !s.adminPasswordHash, setupComplete: s.setupComplete, version: opts.version };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/account/create", async (req, reply) => {
    const s = getSettings(db);
    if (s.adminPasswordHash) return reply.code(409).send({ error: "An account already exists. Sign in instead." });
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!username) return reply.code(400).send({ error: "Choose a username" });
    if (password.length < 8) return reply.code(400).send({ error: "Use at least 8 characters for the password" });
    saveSettings(db, { adminUsername: username, adminPasswordHash: hashPassword(password) });
    setSessionCookie(req, reply);
    return { ok: true };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/login", async (req, reply) => {
    if (limiter.blocked(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a few minutes." });
    const s = getSettings(db);
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const ok = !!s.adminPasswordHash && username.toLowerCase() === s.adminUsername.toLowerCase() && verifyPassword(password, s.adminPasswordHash);
    if (!ok) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: "Wrong username or password" });
    }
    limiter.reset(req.ip);
    setSessionCookie(req, reply);
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    deleteSession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post<{ Body: { current?: string; next?: string } }>("/api/account/password", async (req, reply) => {
    const s = getSettings(db);
    if (!verifyPassword(String(req.body?.current ?? ""), s.adminPasswordHash)) return reply.code(400).send({ error: "The current password is wrong" });
    const next = String(req.body?.next ?? "");
    if (next.length < 8) return reply.code(400).send({ error: "Use at least 8 characters for the password" });
    saveSettings(db, { adminPasswordHash: hashPassword(next) });
    deleteAllSessions(db);
    setSessionCookie(req, reply);
    return { ok: true };
  });

  const about = () => ({ version: opts.version, repo: opts.repo, update: updates.info, updateAvailable: isNewer(updates.info.latest, opts.version) });
  app.get("/api/about", async () => about());
  app.post("/api/about/check", async (_req, reply) => {
    if (!updates.info.enabled) return reply.code(400).send({ error: "The update check is turned off (UPDATE_CHECK=off)" });
    try {
      if (!(await updates.checkNow())) return reply.code(502).send({ error: "GitHub didn't answer. Try again later." });
    } catch (err) {
      return reply.code(502).send({ error: `Couldn't reach GitHub: ${errorText(err)}` });
    }
    return about();
  });

  // --- Status (sidebar badges, AI dot) ---------------------------------------------

  const attentionCount = () =>
    (db.prepare(`SELECT count(*) AS n FROM emails WHERE handled = 0 AND category IN ('important','action')`).get() as { n: number }).n;

  app.get("/api/status", async () => {
    const s = getSettings(db);
    const today = todayYmd(now());
    const due = (db.prepare("SELECT count(*) AS n FROM tasks WHERE done_at IS NULL AND due_date <= ?").get(today) as { n: number }).n;
    const accounts = (db.prepare("SELECT count(*) AS n FROM mail_accounts").get() as { n: number }).n;
    engine.client(s);
    return {
      ai: engine.ai,
      aiModel: s.aiProvider !== "none" ? s.aiModel : "",
      due,
      inbox: attentionCount(),
      mailAccounts: accounts,
      mailBusy: engine.mailBusy,
      notifications: channels(s),
    };
  });

  // --- Today ------------------------------------------------------------------------

  app.get("/api/today", async () => {
    const today = todayYmd(now());
    const week = addDays(today, 7);
    const last = lastDoneMap(db);
    const tasks = openTasks(db).map((t) => publicTask(t, last.get(t.id)));
    const doneToday = db
      .prepare(
        `SELECT l.id AS log_id, l.action, l.at, t.* FROM task_log l JOIN tasks t ON t.id = l.task_id
         WHERE l.on_date = ? ORDER BY l.at DESC`,
      )
      .all(today) as unknown as (TaskRow & { log_id: number; action: string; at: number })[];
    return {
      date: today,
      overdue: tasks.filter((t) => t.dueDate && t.dueDate < today),
      today: tasks.filter((t) => t.dueDate === today),
      upcoming: tasks.filter((t) => t.dueDate && t.dueDate > today && t.dueDate <= week),
      later: tasks.filter((t) => t.dueDate && t.dueDate > week).length,
      anytime: tasks.filter((t) => !t.dueDate),
      done: doneToday.map((r) => ({ logId: r.log_id, action: r.action, at: r.at, task: publicTask(r) })),
      digest: latestDigest(db),
      inbox: attentionCount(),
    };
  });

  // --- Tasks -----------------------------------------------------------------------

  app.get<{ Querystring: { status?: string; q?: string; list?: string } }>("/api/tasks", async (req) => {
    const status = req.query.status === "done" ? "done" : "open";
    const last = lastDoneMap(db);
    let rows: TaskRow[];
    if (status === "open") rows = openTasks(db);
    else rows = db.prepare("SELECT * FROM tasks WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT 200").all() as unknown as TaskRow[];
    const q = (req.query.q ?? "").trim().toLowerCase();
    if (q) rows = rows.filter((t) => `${t.title} ${t.notes ?? ""} ${t.list ?? ""}`.toLowerCase().includes(q));
    if (req.query.list) rows = rows.filter((t) => (req.query.list === "__none" ? !t.list : t.list === req.query.list));
    return rows.map((t) => publicTask(t, last.get(t.id)));
  });

  app.get("/api/lists", async () => {
    const rows = db.prepare("SELECT list, count(*) AS n FROM tasks WHERE done_at IS NULL GROUP BY list ORDER BY list COLLATE NOCASE").all() as { list: string | null; n: number }[];
    return rows.map((r) => ({ name: r.list, count: r.n }));
  });

  app.post<{ Body: Record<string, unknown> }>("/api/tasks", async (req, reply) => {
    const t = createTask(db, req.body ?? {});
    if ("error" in t) return reply.code(400).send({ error: t.error });
    return publicTask(t);
  });

  /** Several at once: what the quick-add preview confirms. */
  app.post<{ Body: { tasks?: unknown[]; source?: string } }>("/api/tasks/bulk", async (req, reply) => {
    const list = Array.isArray(req.body?.tasks) ? req.body.tasks.slice(0, 50) : [];
    if (!list.length) return reply.code(400).send({ error: "Nothing to add" });
    const source = req.body?.source === "ai" ? "ai" : "manual";
    try {
      const created = tx(db, () =>
        list.map((input) => {
          const t = createTask(db, (input ?? {}) as Record<string, unknown>, { source });
          if ("error" in t) throw Object.assign(new Error(t.error), { statusCode: 400 });
          return publicTask(t);
        }),
      );
      return created;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const t = getTask(db, Number(req.params.id));
    if (!t) return reply.code(404).send({ error: "That task is gone" });
    const history = db.prepare("SELECT id, at, on_date AS onDate, action FROM task_log WHERE task_id = ? ORDER BY at DESC LIMIT 30").all(t.id);
    const email = t.email_id ? db.prepare("SELECT id, from_name AS fromName, from_addr AS fromAddr, subject FROM emails WHERE id = ?").get(t.email_id) : null;
    return { ...publicTask(t, lastDoneMap(db).get(t.id)), history, email: email ?? null };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id", async (req, reply) => {
    const t = updateTask(db, Number(req.params.id), req.body ?? {});
    if (!t) return reply.code(404).send({ error: "That task is gone" });
    if ("error" in t) return reply.code(400).send({ error: t.error });
    return publicTask(t);
  });

  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const t = getTask(db, Number(req.params.id));
    if (!t) return reply.code(404).send({ error: "That task is gone" });
    db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
    db.prepare("UPDATE emails SET task_id = NULL WHERE task_id = ?").run(t.id);
    return { ok: true, task: publicTask(t) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/complete", async (req, reply) => {
    const r = completeTask(db, Number(req.params.id), "done", now());
    if (!r) return reply.code(409).send({ error: "That task is already done" });
    return { task: publicTask(r.task), logId: r.logId };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/skip", async (req, reply) => {
    const r = completeTask(db, Number(req.params.id), "skipped", now());
    if (!r) return reply.code(409).send({ error: "Only repeating tasks can be skipped" });
    return { task: publicTask(r.task), logId: r.logId };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/reopen", async (req, reply) => {
    const t = getTask(db, Number(req.params.id));
    if (!t || !t.done_at) return reply.code(404).send({ error: "That task isn't done" });
    db.prepare("UPDATE tasks SET done_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), t.id);
    db.prepare("DELETE FROM task_log WHERE id = (SELECT id FROM task_log WHERE task_id = ? ORDER BY id DESC LIMIT 1)").run(t.id);
    return publicTask(getTask(db, t.id)!);
  });

  app.post<{ Params: { id: string } }>("/api/log/:id/undo", async (req, reply) => {
    const t = undoLog(db, Number(req.params.id));
    if (!t) return reply.code(409).send({ error: "That can't be undone any more" });
    return publicTask(t);
  });

  // --- Quick add (the AI part) ---------------------------------------------------------

  app.post<{ Body: { text?: string } }>("/api/parse", async (req, reply) => {
    const text = String(req.body?.text ?? "").trim().slice(0, 4000);
    if (!text) return reply.code(400).send({ error: "Type what you need to remember" });
    const s = getSettings(db);
    const lists = knownLists(db);
    const ai = engine.client(s);
    if (ai) {
      try {
        const tasks = await aiParseTasks(ai, text, { now: now(), lists, aboutMe: s.aboutMe });
        engine.noteAi(null);
        return { via: "ai", tasks };
      } catch (err) {
        engine.noteAi(errorText(err));
        return { via: "rules", note: `The AI couldn't help (${errorText(err)}), so this was read with the built-in rules.`, tasks: parseQuickAdd(text, { now: now(), lists }) };
      }
    }
    return { via: "rules", tasks: parseQuickAdd(text, { now: now(), lists }) };
  });

  // --- Email --------------------------------------------------------------------------

  const publicEmail = (e: EmailRow, gmail: boolean) => ({
    id: e.id,
    accountId: e.account_id,
    fromName: e.from_name,
    fromAddr: e.from_addr,
    subject: e.subject,
    snippet: e.snippet,
    receivedAt: e.received_at,
    category: e.category,
    summary: e.summary,
    reason: e.reason,
    decidedBy: e.decided_by,
    aiPending: !!e.ai_pending,
    bulk: !!e.bulk,
    suggestion: e.suggestion ? JSON.parse(e.suggestion) : null,
    suggestionState: e.suggestion_state,
    taskId: e.task_id,
    handled: !!e.handled,
    // Gmail can open a message by its Message-ID.
    openUrl: gmail && e.message_id ? `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(e.message_id.replace(/^<|>$/g, ""))}` : null,
  });

  const gmailAccounts = () =>
    new Set((db.prepare("SELECT id, host FROM mail_accounts").all() as { id: number; host: string }[]).filter((a) => /gmail|googlemail/i.test(a.host)).map((a) => a.id));

  app.get<{ Querystring: { view?: string; q?: string } }>("/api/emails", async (req) => {
    const view = req.query.view ?? "attention";
    const where =
      view === "attention"
        ? "handled = 0 AND category IN ('important','action')"
        : view === "other"
          ? "handled = 0 AND category = 'fyi'"
          : view === "filtered"
            ? "category IN ('promo','spam','ignored')"
            : "handled = 1 AND category IN ('important','action','fyi')";
    const rows = db.prepare(`SELECT * FROM emails WHERE ${where} ORDER BY received_at DESC LIMIT 200`).all() as unknown as EmailRow[];
    const gmail = gmailAccounts();
    const q = (req.query.q ?? "").trim().toLowerCase();
    const list = q ? rows.filter((e) => `${e.from_name} ${e.from_addr} ${e.subject} ${e.summary}`.toLowerCase().includes(q)) : rows;
    const counts = db
      .prepare(
        `SELECT
           sum(handled = 0 AND category IN ('important','action')) AS attention,
           sum(handled = 0 AND category = 'fyi') AS other,
           sum(category IN ('promo','spam','ignored')) AS filtered,
           sum(handled = 1 AND category IN ('important','action','fyi')) AS handled
         FROM emails`,
      )
      .get() as Record<string, number | null>;
    return {
      emails: list.map((e) => publicEmail(e, gmail.has(e.account_id))),
      counts: { attention: counts.attention ?? 0, other: counts.other ?? 0, filtered: counts.filtered ?? 0, handled: counts.handled ?? 0 },
    };
  });

  const getEmail = (id: number) => db.prepare("SELECT * FROM emails WHERE id = ?").get(id) as unknown as EmailRow | undefined;

  app.patch<{ Params: { id: string }; Body: { category?: string; handled?: boolean } }>("/api/emails/:id", async (req, reply) => {
    const e = getEmail(Number(req.params.id));
    if (!e) return reply.code(404).send({ error: "That email is gone" });
    const cats = ["important", "action", "fyi", "promo", "spam"];
    if (req.body?.category !== undefined) {
      if (!cats.includes(req.body.category)) return reply.code(400).send({ error: "Unknown category" });
      db.prepare("UPDATE emails SET category = ?, decided_by = 'you', reason = 'You moved it here', ai_pending = 0, pending_text = NULL, handled = 0 WHERE id = ?").run(req.body.category, e.id);
    }
    if (req.body?.handled !== undefined) db.prepare("UPDATE emails SET handled = ? WHERE id = ?").run(req.body.handled ? 1 : 0, e.id);
    return publicEmail(getEmail(e.id)!, gmailAccounts().has(e.account_id));
  });

  /** Clear everything in a view in one go (e.g. "Mark all as dealt with"). */
  app.post<{ Body: { ids?: number[] } }>("/api/emails/handle", async (req) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Number.isInteger) : [];
    const stmt = db.prepare("UPDATE emails SET handled = 1 WHERE id = ?");
    tx(db, () => ids.forEach((id) => stmt.run(id)));
    return { ok: true, count: ids.length };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/emails/:id/accept", async (req, reply) => {
    const e = getEmail(Number(req.params.id));
    if (!e) return reply.code(404).send({ error: "That email is gone" });
    const suggestion = e.suggestion ? JSON.parse(e.suggestion) : {};
    const body = req.body ?? {};
    const t = createTask(
      db,
      {
        title: body.title ?? suggestion.title ?? e.subject,
        dueDate: body.dueDate !== undefined ? body.dueDate : (suggestion.dueDate ?? null),
        dueTime: body.dueTime !== undefined ? body.dueTime : (suggestion.dueTime ?? null),
        list: body.list ?? null,
        notes: `From ${e.from_name || e.from_addr}: “${e.subject}”`,
      },
      { source: "email", emailId: e.id },
    );
    if ("error" in t) return reply.code(400).send({ error: t.error });
    db.prepare("UPDATE emails SET suggestion_state = 'accepted', task_id = ?, handled = 1 WHERE id = ?").run(t.id, e.id);
    return publicTask(t);
  });

  app.post<{ Params: { id: string } }>("/api/emails/:id/dismiss", async (req, reply) => {
    const e = getEmail(Number(req.params.id));
    if (!e) return reply.code(404).send({ error: "That email is gone" });
    db.prepare("UPDATE emails SET suggestion_state = 'dismissed' WHERE id = ?").run(e.id);
    return { ok: true };
  });

  // --- Sender rules ----------------------------------------------------------------------

  /** Re-applies a rule to mail already sorted from that sender. */
  function applyRule(pattern: string, action: "important" | "ignore") {
    const rows = db.prepare("SELECT id, from_addr, category FROM emails").all() as { id: number; from_addr: string | null; category: string }[];
    const rule = [{ id: 0, pattern, action, created_at: 0 }];
    let n = 0;
    for (const r of rows) {
      if (!r.from_addr || !ruleFor(rule, r.from_addr)) continue;
      if (action === "ignore") db.prepare("UPDATE emails SET category = 'ignored', decided_by = 'rule', reason = 'You chose to ignore this sender', handled = 1, ai_pending = 0, pending_text = NULL, suggestion_state = CASE WHEN suggestion_state = 'pending' THEN 'dismissed' ELSE suggestion_state END WHERE id = ?").run(r.id);
      else if (!ATTENTION.includes(r.category)) db.prepare("UPDATE emails SET category = 'important', decided_by = 'rule', reason = 'You marked this sender as important', handled = 0 WHERE id = ?").run(r.id);
      else continue;
      n++;
    }
    return n;
  }

  app.get("/api/sender-rules", async () => senderRules(db).map((r) => ({ id: r.id, pattern: r.pattern, action: r.action, createdAt: r.created_at })));

  app.post<{ Body: { pattern?: string; action?: string } }>("/api/sender-rules", async (req, reply) => {
    const pattern = normalizePattern(String(req.body?.pattern ?? ""));
    if (!pattern) return reply.code(400).send({ error: "Enter an email address or a domain like example.com" });
    const action = req.body?.action === "ignore" ? "ignore" : "important";
    db.prepare(
      "INSERT INTO sender_rules (pattern, action, created_at) VALUES (?, ?, ?) ON CONFLICT (pattern) DO UPDATE SET action = excluded.action",
    ).run(pattern, action, Date.now());
    const changed = applyRule(pattern, action);
    return { ok: true, pattern, action, changed };
  });

  app.delete<{ Params: { id: string } }>("/api/sender-rules/:id", async (req) => {
    db.prepare("DELETE FROM sender_rules WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });

  // --- Mail accounts ----------------------------------------------------------------------

  const publicAccount = (a: MailAccountRow) => ({
    id: a.id,
    label: a.label,
    host: a.host,
    port: a.port,
    secure: !!a.secure,
    username: a.username,
    folder: a.folder,
    enabled: !!a.enabled,
    lastCheckedAt: a.last_checked_at,
    lastError: a.last_error,
    emails: (db.prepare("SELECT count(*) AS n FROM emails WHERE account_id = ?").get(a.id) as { n: number }).n,
  });

  interface AccountBody {
    label?: string;
    host?: string;
    port?: number;
    secure?: boolean;
    username?: string;
    password?: string;
    folder?: string;
    enabled?: boolean;
  }

  function cleanAccount(b: AccountBody, existing?: MailAccountRow) {
    const host = String(b.host ?? existing?.host ?? "").trim().toLowerCase();
    const username = String(b.username ?? existing?.username ?? "").trim();
    const password = b.password ? String(b.password) : (existing?.password ?? "");
    const port = Number(b.port ?? existing?.port ?? 993);
    if (!host) return { error: "Enter the IMAP server (e.g. imap.gmail.com)" };
    if (!username) return { error: "Enter the username (usually your email address)" };
    if (!password) return { error: "Enter the password (an app password for Gmail, iCloud and Outlook)" };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "That port doesn't look right" };
    return {
      label: String(b.label ?? existing?.label ?? "").trim().slice(0, 60) || username,
      host,
      port,
      secure: (b.secure ?? (existing ? !!existing.secure : port === 993)) ? 1 : 0,
      username,
      password,
      folder: String(b.folder ?? existing?.folder ?? "INBOX").trim() || "INBOX",
      enabled: (b.enabled ?? (existing ? !!existing.enabled : true)) ? 1 : 0,
    };
  }

  const getAccount = (id: number) => db.prepare("SELECT * FROM mail_accounts WHERE id = ?").get(id) as unknown as MailAccountRow | undefined;

  app.get("/api/mail-accounts", async () => (db.prepare("SELECT * FROM mail_accounts ORDER BY id").all() as unknown as MailAccountRow[]).map(publicAccount));

  app.post<{ Body: AccountBody }>("/api/mail-accounts/test", async (req, reply) => {
    const existing = (req.body as { id?: number })?.id ? getAccount(Number((req.body as { id?: number }).id)) : undefined;
    const a = cleanAccount(req.body ?? {}, existing);
    if ("error" in a) return reply.code(400).send({ error: a.error });
    try {
      const r = await engine.mail.test(a);
      return { ok: true, messages: r.messages };
    } catch (err) {
      return reply.code(400).send({ error: errorText(err) });
    }
  });

  app.post<{ Body: AccountBody }>("/api/mail-accounts", async (req, reply) => {
    const a = cleanAccount(req.body ?? {});
    if ("error" in a) return reply.code(400).send({ error: a.error });
    const res = db
      .prepare("INSERT INTO mail_accounts (label, host, port, secure, username, password, folder, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.label, a.host, a.port, a.secure, a.username, a.password, a.folder, a.enabled, Date.now());
    const id = Number(res.lastInsertRowid);
    void engine.checkMail(id);
    return publicAccount(getAccount(id)!);
  });

  app.patch<{ Params: { id: string }; Body: AccountBody }>("/api/mail-accounts/:id", async (req, reply) => {
    const existing = getAccount(Number(req.params.id));
    if (!existing) return reply.code(404).send({ error: "That account is gone" });
    const a = cleanAccount(req.body ?? {}, existing);
    if ("error" in a) return reply.code(400).send({ error: a.error });
    const moved = a.host !== existing.host || a.username !== existing.username || a.folder !== existing.folder;
    db.prepare(
      `UPDATE mail_accounts SET label = ?, host = ?, port = ?, secure = ?, username = ?, password = ?, folder = ?, enabled = ?,
         uid_validity = CASE WHEN ? THEN NULL ELSE uid_validity END, last_uid = CASE WHEN ? THEN 0 ELSE last_uid END, last_error = NULL WHERE id = ?`,
    ).run(a.label, a.host, a.port, a.secure, a.username, a.password, a.folder, a.enabled, moved ? 1 : 0, moved ? 1 : 0, existing.id);
    return publicAccount(getAccount(existing.id)!);
  });

  app.delete<{ Params: { id: string } }>("/api/mail-accounts/:id", async (req) => {
    db.prepare("DELETE FROM mail_accounts WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });

  app.post("/api/mail/check", async (_req, reply) => {
    const accounts = (db.prepare("SELECT count(*) AS n FROM mail_accounts WHERE enabled = 1").get() as { n: number }).n;
    if (!accounts) return reply.code(400).send({ error: "Add an email account in Settings first" });
    const results = await engine.checkMail();
    return { results };
  });

  // --- Daily summary ----------------------------------------------------------------------

  app.get("/api/digest", async () => latestDigest(db));

  app.post<{ Body: { push?: boolean } }>("/api/digest", async (req) => {
    const s = getSettings(db);
    const { digest, aiError } = await engine.writeDigest(s, !!req.body?.push);
    return { digest, note: aiError ? `Written without the AI (${aiError}).` : undefined };
  });

  // --- Settings -----------------------------------------------------------------------------

  const publicSettings = (s: Settings) => {
    const out: Record<string, unknown> = { ...s };
    delete out.adminPasswordHash;
    for (const k of SECRET_KEYS) {
      out[`${k}Set`] = !!s[k];
      out[k] = "";
    }
    return out;
  };

  app.get("/api/settings", async () => publicSettings(getSettings(db)));

  app.put<{ Body: Record<string, unknown> }>("/api/settings", async (req, reply) => {
    const b = req.body ?? {};
    const patch: Partial<Settings> = {};
    const str = (k: keyof Settings, max = 500) => {
      if (typeof b[k] === "string") (patch as Record<string, unknown>)[k] = (b[k] as string).trim().slice(0, max);
    };
    const bool = (k: keyof Settings) => {
      if (typeof b[k] === "boolean") (patch as Record<string, unknown>)[k] = b[k];
    };
    const int = (k: keyof Settings, min: number, max: number) => {
      if (b[k] === undefined) return;
      const n = Math.round(Number(b[k]));
      if (Number.isFinite(n)) (patch as Record<string, unknown>)[k] = Math.min(max, Math.max(min, n));
    };
    if (b.aiProvider !== undefined) {
      if (!["ollama", "openai", "none"].includes(String(b.aiProvider))) return reply.code(400).send({ error: "Unknown AI server type" });
      patch.aiProvider = b.aiProvider as Settings["aiProvider"];
    }
    str("aiUrl");
    str("aiModel", 200);
    str("aboutMe", 1000);
    str("pushoverDevices", 200);
    str("ntfyUrl");
    str("publicUrl");
    // Secrets: only replaced when a new value is sent; "clear" removes one.
    for (const k of SECRET_KEYS) {
      if (typeof b[k] === "string" && b[k]) (patch as Record<string, unknown>)[k] = (b[k] as string).trim();
      if (b[`${k}Clear`] === true) (patch as Record<string, unknown>)[k] = "";
    }
    int("aiContext", 2048, 131072);
    int("reminderLeadMinutes", 0, 240);
    int("mailIntervalMinutes", 5, 1440);
    int("mailLookbackDays", 1, 30);
    for (const k of ["remindersPush", "summaryEnabled", "summaryPush", "emailPush", "setupComplete"] as const) bool(k);
    if (b.summaryTime !== undefined) {
      if (!isHm(b.summaryTime)) return reply.code(400).send({ error: "Pick a time for the summary" });
      patch.summaryTime = b.summaryTime as string;
    }
    if (patch.ntfyUrl && !/^https?:\/\/[^/]+\/[^/]+/.test(patch.ntfyUrl)) return reply.code(400).send({ error: "The ntfy address should look like https://ntfy.sh/your-topic" });
    if (patch.publicUrl && !/^https?:\/\//.test(patch.publicUrl)) return reply.code(400).send({ error: "The app's address should start with http:// or https://" });
    saveSettings(db, patch);
    return publicSettings(getSettings(db));
  });

  /** Tries an AI server (the saved one, or what's in the form) and lists its models. */
  app.post<{ Body: { provider?: string; url?: string; apiKey?: string; model?: string } }>("/api/ai/test", async (req, reply) => {
    const s = getSettings(db);
    const provider = (req.body?.provider ?? s.aiProvider) as Settings["aiProvider"];
    if (provider === "none") return reply.code(400).send({ error: "Pick an AI server type first" });
    const url = String(req.body?.url ?? s.aiUrl).trim();
    if (!url) return reply.code(400).send({ error: "Enter the AI server's address" });
    const client = new AiClient({ provider, url, model: String(req.body?.model ?? s.aiModel), apiKey: req.body?.apiKey || s.aiApiKey });
    try {
      const models = await client.listModels();
      const model = String(req.body?.model ?? "");
      let tried: string | null = null;
      if (model) {
        // A tiny real request, so a model that's listed but won't load shows up here and not at 7 AM.
        const started = Date.now();
        const r = await client.json<{ ok?: boolean }>("Reply with {\"ok\": true}.", "ping", {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        });
        if (r.ok !== true && r.ok !== false) throw new Error("The model answered, but not in the expected format");
        tried = `${model} answered in ${((Date.now() - started) / 1000).toFixed(1)} s`;
      }
      if (url === s.aiUrl) engine.noteAi(null);
      return { ok: true, models, tried };
    } catch (err) {
      return reply.code(400).send({ error: errorText(err) });
    }
  });

  app.post("/api/notify/test", async (_req, reply) => {
    const s = getSettings(db);
    if (!channels(s).length) return reply.code(400).send({ error: "Set up Pushover or ntfy first" });
    try {
      const sent = await engine.send(s, { title: "Docket test", message: "Notifications are working. Reminders and your daily summary will arrive like this." });
      return { ok: true, sent };
    } catch (err) {
      return reply.code(400).send({ error: errorText(err) });
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/activity", async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    return db.prepare("SELECT id, at, kind, message FROM activity ORDER BY id DESC LIMIT ?").all(limit);
  });

  // --- Static frontend -------------------------------------------------------------------

  const webRoot = opts.webRoot;
  if (webRoot && fs.existsSync(path.join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, maxAge: "1h" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
  }

  return { app, engine, updates };
}
