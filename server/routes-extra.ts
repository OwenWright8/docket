// Routes for: buttons on notifications, calendars and carrel, email you're
// waiting on a reply to, the ask box, and the Homepage widget.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { actPage, runAct } from "./actions.ts";
import { aiAnswer } from "./ai.ts";
import { askFacts } from "./ask.ts";
import { createWidgetKey, useWidgetKey } from "./auth.ts";
import { type DB, type SentRow, type SourceRow, errorText, getSettings } from "./db.ts";
import type { Engine } from "./engine.ts";
import { readSource } from "./sources.ts";
import { createTask, moveToTomorrow, publicTask, snoozeTask } from "./tasks.ts";
import { todayYmd } from "./time.ts";

export async function registerExtras(app: FastifyInstance, db: DB, engine: Engine) {
  const now = () => engine.now();

  // HTML forms (the Done / Snooze page) post urlencoded bodies.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  // --- Done / Snooze from a notification (no sign-in: the link is signed) ---------------

  type ActQuery = { t?: string; k?: string; s?: string; a?: string };
  const actArgs = (q: ActQuery) => ({ t: Number(q.t), k: String(q.k ?? ""), s: String(q.s ?? ""), a: String(q.a ?? "") });

  // ntfy's buttons: the phone POSTs here in the background.
  app.post<{ Querystring: ActQuery }>("/api/act", async (req, reply) => {
    const q = actArgs(req.query);
    const r = runAct(db, q.t, q.k, q.s, q.a, now());
    if (!r.ok) return reply.code(r.status).send({ error: r.message });
    return { ok: true, message: r.message };
  });

  // Pushover's link: a page with the buttons, which posts back to itself.
  app.get<{ Querystring: ActQuery }>("/act", async (req, reply) => {
    const q = actArgs(req.query);
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    return reply.type("text/html").send(actPage(db, { t: q.t, k: q.k, s: q.s }));
  });
  app.post<{ Body: ActQuery }>("/act", async (req, reply) => {
    const q = actArgs(req.body ?? {});
    const r = runAct(db, q.t, q.k, q.s, q.a, now());
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    return reply.code(r.ok ? 200 : r.status).type("text/html").send(actPage(db, { t: q.t, k: q.k, s: q.s }, r));
  });

  // The same, from the app.
  app.post<{ Params: { id: string }; Body: { minutes?: number } }>("/api/tasks/:id/snooze", async (req, reply) => {
    const minutes = Math.min(24 * 60, Math.max(5, Number(req.body?.minutes) || 60));
    const t = snoozeTask(db, Number(req.params.id), minutes, now().getTime());
    if (!t) return reply.code(404).send({ error: "That task is gone or done" });
    return publicTask(t);
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/tomorrow", async (req, reply) => {
    const t = moveToTomorrow(db, Number(req.params.id), now());
    if (!t) return reply.code(404).send({ error: "That task is gone or done" });
    return publicTask(t);
  });

  // --- Calendars and carrel ------------------------------------------------------------

  const publicSource = (s: SourceRow) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    // A calendar's private link is as good as a password: only its host is shown.
    url: s.kind === "carrel" ? s.url : hostOf(s.url),
    username: s.kind === "carrel" ? s.username : null,
    enabled: !!s.enabled,
    lastSyncedAt: s.last_synced_at,
    lastError: s.last_error,
    items: (db.prepare("SELECT count(*) AS n FROM external_items WHERE source_id = ?").get(s.id) as { n: number }).n,
  });
  const getSource = (id: number) => db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as unknown as SourceRow | undefined;

  interface SourceBody {
    kind?: string;
    name?: string;
    url?: string;
    username?: string;
    password?: string;
    enabled?: boolean;
  }
  function cleanSource(b: SourceBody, existing?: SourceRow) {
    const kind = (existing?.kind ?? (b.kind === "carrel" ? "carrel" : "ics")) as SourceRow["kind"];
    const url = (b.url ? String(b.url) : (existing?.url ?? "")).trim();
    if (!url) return { error: kind === "carrel" ? "Enter carrel's address" : "Paste the calendar's link" };
    if (!/^(https?|webcals?):\/\//i.test(url)) return { error: "The address should start with https:// (or webcal://)" };
    const username = kind === "carrel" ? String(b.username ?? existing?.username ?? "").trim() : null;
    const password = kind === "carrel" ? (b.password ? String(b.password) : (existing?.password ?? "")) : null;
    if (kind === "carrel" && (!username || !password)) return { error: "Enter your carrel email and password" };
    const name = String(b.name ?? existing?.name ?? "").trim().slice(0, 60) || (kind === "carrel" ? "carrel" : "Calendar");
    return { kind, name, url, username, password, enabled: (b.enabled ?? (existing ? !!existing.enabled : true)) ? 1 : 0 };
  }

  app.get("/api/sources", async () => (db.prepare("SELECT * FROM sources ORDER BY id").all() as unknown as SourceRow[]).map(publicSource));

  app.post<{ Body: SourceBody & { id?: number } }>("/api/sources/test", async (req, reply) => {
    const existing = req.body?.id ? getSource(Number(req.body.id)) : undefined;
    const s = cleanSource(req.body ?? {}, existing);
    if ("error" in s) return reply.code(400).send({ error: s.error });
    try {
      const items = await readSource({ id: 0, created_at: 0, last_error: null, last_synced_at: null, ...s }, now());
      const today = todayYmd(now());
      return { ok: true, items: items.length, upcoming: items.filter((i) => i.date >= today).length };
    } catch (err) {
      return reply.code(400).send({ error: errorText(err) });
    }
  });

  app.post<{ Body: SourceBody }>("/api/sources", async (req, reply) => {
    const s = cleanSource(req.body ?? {});
    if ("error" in s) return reply.code(400).send({ error: s.error });
    const res = db
      .prepare("INSERT INTO sources (kind, name, url, username, password, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(s.kind, s.name, s.url, s.username, s.password, s.enabled, Date.now());
    const id = Number(res.lastInsertRowid);
    await engine.syncSource(id).catch(() => {});
    return publicSource(getSource(id)!);
  });

  app.patch<{ Params: { id: string }; Body: SourceBody }>("/api/sources/:id", async (req, reply) => {
    const existing = getSource(Number(req.params.id));
    if (!existing) return reply.code(404).send({ error: "That calendar is gone" });
    const s = cleanSource(req.body ?? {}, existing);
    if ("error" in s) return reply.code(400).send({ error: s.error });
    db.prepare("UPDATE sources SET name = ?, url = ?, username = ?, password = ?, enabled = ?, last_error = NULL WHERE id = ?").run(
      s.name,
      s.url,
      s.username,
      s.password,
      s.enabled,
      existing.id,
    );
    if (s.enabled) await engine.syncSource(existing.id).catch(() => {});
    return publicSource(getSource(existing.id)!);
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/sync", async (req, reply) => {
    try {
      await engine.syncSource(Number(req.params.id));
    } catch (err) {
      return reply.code(400).send({ error: errorText(err) });
    }
    return publicSource(getSource(Number(req.params.id))!);
  });

  app.delete<{ Params: { id: string } }>("/api/sources/:id", async (req) => {
    db.prepare("DELETE FROM sources WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });

  // --- Waiting on a reply ----------------------------------------------------------------

  const publicSent = (r: SentRow, waitDays: number) => ({
    id: r.id,
    toName: r.to_name,
    toAddr: r.to_addr,
    subject: r.subject,
    snippet: r.snippet,
    sentAt: r.sent_at,
    state: r.state,
    reason: r.reason,
    decidedBy: r.decided_by,
    answeredAt: r.answered_at,
    overdue: r.state === "waiting" && r.sent_at < now().getTime() - waitDays * 86_400_000,
  });

  app.get<{ Querystring: { state?: string } }>("/api/sent", async (req) => {
    const s = getSettings(db);
    const state = req.query.state === "answered" ? "answered" : req.query.state === "none" ? "none" : "waiting";
    const rows = db.prepare("SELECT * FROM sent_mail WHERE state = ? ORDER BY sent_at DESC LIMIT 200").all(state) as unknown as SentRow[];
    return rows.map((r) => publicSent(r, s.replyWaitDays));
  });

  app.patch<{ Params: { id: string }; Body: { state?: string } }>("/api/sent/:id", async (req, reply) => {
    const state = String(req.body?.state ?? "");
    if (!["waiting", "answered", "dismissed"].includes(state)) return reply.code(400).send({ error: "Unknown state" });
    const res = db
      .prepare("UPDATE sent_mail SET state = ?, decided_by = 'you', answered_at = CASE WHEN ? = 'answered' THEN ? ELSE answered_at END, nudged = CASE WHEN ? = 'waiting' THEN 0 ELSE nudged END WHERE id = ?")
      .run(state, state, Date.now(), state, Number(req.params.id));
    if (!res.changes) return reply.code(404).send({ error: "That email is gone" });
    return { ok: true };
  });

  /** "Follow up with Prof. Lee about the extension", due today. */
  app.post<{ Params: { id: string } }>("/api/sent/:id/follow-up", async (req, reply) => {
    const r = db.prepare("SELECT * FROM sent_mail WHERE id = ?").get(Number(req.params.id)) as unknown as SentRow | undefined;
    if (!r) return reply.code(404).send({ error: "That email is gone" });
    const who = r.to_name || r.to_addr || "them";
    const t = createTask(db, { title: `Follow up with ${who}: ${r.subject ?? "your email"}`.slice(0, 200), dueDate: todayYmd(now()), notes: r.reason ?? null }, { source: "email" });
    if ("error" in t) return reply.code(400).send({ error: t.error });
    db.prepare("UPDATE sent_mail SET state = 'dismissed' WHERE id = ?").run(r.id);
    return publicTask(t);
  });

  // --- Ask ----------------------------------------------------------------------------------

  app.post<{ Body: { question?: string } }>("/api/ask", async (req, reply) => {
    const question = String(req.body?.question ?? "").trim().slice(0, 500);
    if (!question) return reply.code(400).send({ error: "Ask something" });
    const s = getSettings(db);
    const ai = engine.client(s);
    if (!ai) return reply.code(400).send({ error: "Answering questions needs your local AI. Set it up in Settings." });
    try {
      const answer = await aiAnswer(ai, question, askFacts(db, now()), { aboutMe: s.aboutMe });
      engine.noteAi(null);
      return { answer };
    } catch (err) {
      engine.noteAi(errorText(err));
      return reply.code(502).send({ error: `The AI couldn't answer: ${errorText(err)}` });
    }
  });

  // --- Homepage widget ---------------------------------------------------------------------

  app.get("/api/widget", async (req: FastifyRequest, reply) => {
    const key = String(req.headers["x-api-key"] ?? (req.query as { key?: string }).key ?? "");
    if (!useWidgetKey(db, key)) return reply.code(401).send({ error: "Missing or invalid X-Api-Key" });
    const s = getSettings(db);
    const today = todayYmd(now());
    const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    const next = db
      .prepare("SELECT title, due_date, due_time FROM tasks WHERE done_at IS NULL AND due_date >= ? ORDER BY due_date, due_time IS NULL, due_time LIMIT 1")
      .get(today) as { title: string; due_date: string; due_time: string | null } | undefined;
    const nowHm = now().toTimeString().slice(0, 5);
    const nextEvent = db
      .prepare(
        `SELECT e.title, e.time FROM external_items e JOIN sources s ON s.id = e.source_id
         WHERE s.enabled = 1 AND e.date = ? AND e.time IS NOT NULL AND e.time >= ? ORDER BY e.time LIMIT 1`,
      )
      .get(today, nowHm) as { title: string; time: string } | undefined;
    engine.client(s);
    return {
      due_today: count("SELECT count(*) AS n FROM tasks WHERE done_at IS NULL AND due_date = ?", today),
      overdue: count("SELECT count(*) AS n FROM tasks WHERE done_at IS NULL AND due_date < ?", today),
      done_today: count("SELECT count(*) AS n FROM task_log WHERE on_date = ? AND action = 'done'", today),
      open: count("SELECT count(*) AS n FROM tasks WHERE done_at IS NULL"),
      inbox: count("SELECT count(*) AS n FROM emails WHERE handled = 0 AND category IN ('important','action')"),
      waiting: count("SELECT count(*) AS n FROM sent_mail WHERE state = 'waiting' AND sent_at < ?", now().getTime() - s.replyWaitDays * 86_400_000),
      events_today: count(
        "SELECT count(*) AS n FROM external_items e JOIN sources s ON s.id = e.source_id WHERE s.enabled = 1 AND e.date <= ? AND coalesce(e.end_date, e.date) >= ?",
        today,
        today,
      ),
      next_task: next ? `${next.title}${next.due_date === today ? "" : ` (${next.due_date})`}` : null,
      next_event: nextEvent ? `${nextEvent.time} ${nextEvent.title}` : null,
      ai: !engine.ai.configured ? "off" : engine.ai.ok === false ? "offline" : "online",
    };
  });

  app.get("/api/widget-keys", async () =>
    db.prepare("SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM widget_keys ORDER BY id").all(),
  );
  app.post<{ Body: { label?: string } }>("/api/widget-keys", async (req) => {
    const label = String(req.body?.label ?? "").trim().slice(0, 60) || "Homepage";
    return createWidgetKey(db, label);
  });
  app.delete<{ Params: { id: string } }>("/api/widget-keys/:id", async (req) => {
    db.prepare("DELETE FROM widget_keys WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^webcals?:/i, "https:")).host;
  } catch {
    return "calendar";
  }
}
