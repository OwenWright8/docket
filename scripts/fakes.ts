// Stand-ins for the outside world, used by the tests and `npm run dev:demo`:
// a fake Ollama that answers like a small local model would, and a fake
// mailbox. Nothing here touches the network beyond localhost.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseQuickAdd } from "../server/parse.ts";
import { basicVerdict } from "../server/triage.ts";
import { basicExpectsReply } from "../server/replies.ts";
import type { FetchedMail, MailSource } from "../server/mail.ts";
import type { MailAccountRow } from "../server/db.ts";

const KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface FakeOllama {
  url: string;
  calls: { kind: string; user: string }[];
  /** While true, every chat request fails with a 500 (the model "crashed"). */
  down: boolean;
  close(): Promise<void>;
}

export async function startFakeOllama(port = 0): Promise<FakeOllama> {
  const state: FakeOllama = { url: "", calls: [], down: false, close: async () => {} };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/tags") return send(200, { models: [{ name: "llama3.1:8b" }, { name: "qwen2.5:7b" }] });
    if (req.url !== "/api/chat") return send(404, { error: "not found" });
    if (state.down) return send(500, { error: "model crashed" });
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const system: string = body.messages?.[0]?.content ?? "";
    const user: string = body.messages?.[1]?.content ?? "";
    let reply: unknown;
    if (system.includes("turn what someone types into to-do items")) {
      state.calls.push({ kind: "tasks", user });
      // The fake reads today off the calendar it was given, like a real model would.
      const today = system.match(/(\d{4}-\d{2}-\d{2}) \w+ \(today\)/)?.[1];
      const now = today ? new Date(`${today}T12:00:00`) : new Date();
      reply = {
        tasks: parseQuickAdd(user, { now }).map((t) => ({
          title: t.title,
          notes: "",
          list: t.list ?? "",
          due_date: t.dueDate ?? "",
          due_time: t.dueTime ?? "",
          repeat_every: t.recurrence?.every ?? 0,
          repeat_unit: t.recurrence ? t.recurrence.unit : "none",
          repeat_weekdays: (t.recurrence?.weekdays ?? []).map((d) => KEYS[d]),
          priority: t.priority === 2 ? "high" : t.priority === 0 ? "low" : "normal",
        })),
      };
    } else if (system.includes("sort one person's incoming email")) {
      state.calls.push({ kind: "email", user });
      const subject = user.match(/^Subject: (.*)$/m)?.[1] ?? "";
      const from = user.match(/^From: .*?<?([^<>\s]+@[^<>\s]+)>?$/m)?.[1] ?? "";
      const text = user.split("<<<EMAIL")[1]?.split("EMAIL>>>")[0] ?? "";
      const bulk = /Sent in bulk: yes/.test(user);
      const v = basicVerdict({ fromAddr: from, subject, text, bulk, labels: [] });
      const due = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? "";
      reply = {
        category: v.category,
        summary: `${subject} (from ${from})`,
        reason: v.reason,
        task_title: v.category === "action" ? subject.replace(/^(re|fwd?):\s*/i, "") : "",
        task_due_date: v.category === "action" ? due : "",
        task_due_time: "",
      };
    } else if (system.includes("waiting on an answer from the recipient")) {
      state.calls.push({ kind: "sent", user });
      const text = user.split("<<<EMAIL")[1]?.split("EMAIL>>>")[0] ?? "";
      const v = basicExpectsReply(text);
      reply = { expects_reply: v.expectsReply, reason: v.reason };
    } else if (system.includes("answer one person's question")) {
      state.calls.push({ kind: "ask", user });
      // Like a careful model: quote the most recent fact that mentions what was asked about.
      const words = user.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !["when", "what", "last", "does", "have", "with", "from", "this", "that", "your"].includes(w)) ?? [];
      const facts = system.split("FACTS\n")[1]?.split("\n") ?? [];
      const lines = facts.filter((l) => l.startsWith("- ") && words.some((w) => l.toLowerCase().includes(w)));
      // "When did I last…" is about history, not the open task.
      const hit = (/\blast\b/i.test(user) && lines.find((l) => /: (done|skipped) "/.test(l))) || lines[0];
      reply = { answer: hit ? `From your history: ${hit.slice(2)}` : "I don't have that." };
    } else if (system.includes("morning briefing")) {
      state.calls.push({ kind: "briefing", user });
      reply = { briefing: `Good morning! ${user.split("\n").slice(1).join(" ")}`.trim() };
    } else {
      state.calls.push({ kind: "other", user });
      reply = { ok: true };
    }
    send(200, { model: body.model, message: { role: "assistant", content: JSON.stringify(reply) }, done: true });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

/** A mailbox in memory. Push messages in with `deliver`. */
export class FakeMailbox implements MailSource {
  messages: FetchedMail[] = [];
  uidValidity = "1";
  failWith: string | null = null;
  private nextUid = 100;

  sent: FetchedMail[] = [];

  deliver(m: Partial<FetchedMail> & { subject: string; fromAddr: string }) {
    const mail: FetchedMail = { uid: this.nextUid++, messageId: `<${this.nextUid}@fake>`, fromName: "", date: new Date(), text: "", bulk: false, labels: [], to: [{ name: "", addr: "me@example.com" }], inReplyTo: null, references: [], ...m };
    this.messages.push(mail);
    return mail;
  }

  /** Something you "sent", as it would appear in the Sent folder. */
  send(m: Partial<FetchedMail> & { subject: string; to: { name: string; addr: string }[] }) {
    const mail: FetchedMail = { uid: this.nextUid++, messageId: `<sent-${this.nextUid}@fake>`, fromName: "Me", fromAddr: "me@example.com", date: new Date(), text: "", bulk: false, labels: [], inReplyTo: null, references: [], ...m };
    this.sent.push(mail);
    return mail;
  }

  async fetchSent(a: MailAccountRow, opts: { lookbackDays: number; limit: number }) {
    if (this.failWith) throw new Error(this.failWith);
    const fresh = a.sent_uid_validity !== this.uidValidity || !a.sent_last_uid;
    const since = Date.now() - opts.lookbackDays * 86_400_000;
    const list = this.sent.filter((m) => (fresh ? m.date.getTime() >= since : m.uid > a.sent_last_uid));
    const lastUid = Math.max(fresh ? 0 : a.sent_last_uid, ...this.sent.map((m) => m.uid), 0);
    return { uidValidity: this.uidValidity, messages: list.slice(-opts.limit), lastUid, folder: "Sent" };
  }

  /** The account (with its token, for Microsoft ones) the last check signed in as. */
  lastLogin: MailAccountRow | null = null;

  async fetch(a: MailAccountRow, opts: { lookbackDays: number; limit: number }) {
    this.lastLogin = a;
    if (this.failWith) throw new Error(this.failWith);
    const fresh = a.uid_validity !== this.uidValidity || !a.last_uid;
    const since = Date.now() - opts.lookbackDays * 86_400_000;
    const list = this.messages.filter((m) => (fresh ? m.date.getTime() >= since : m.uid > a.last_uid));
    const lastUid = Math.max(fresh ? 0 : a.last_uid, ...this.messages.map((m) => m.uid), 0);
    return { uidValidity: this.uidValidity, messages: list.slice(-opts.limit), lastUid };
  }

  async test(a: Pick<MailAccountRow, "password">) {
    if (a.password === "wrong") throw new Error("The server rejected the username or password.");
    return { messages: this.messages.length };
  }
}

/** A carrel stand-in: its env.js, sign-in, and the four tables Docket reads. */
export async function startFakeCarrel(data: {
  email: string;
  password: string;
  tasks?: { id: string; title: string; due_at: string; status?: string; type?: string; course?: string }[];
  readings?: { id: string; title: string; pages?: string; due_date: string; status?: string; course?: string }[];
  exams?: { id: string; title: string; exam_at: string; course?: string }[];
  quizzes?: { id: string; title: string; quiz_at: string; course?: string }[];
}, port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const ANON = "fake-anon-key";
  const TOKEN = "fake-access-token";
  const course = (c?: string) => ({ short_code: c ?? null, name: c ?? null, is_archived: false });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/env.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end(`window.__ENV__ = {\n  VITE_SUPABASE_PUBLISHABLE_KEY: "${ANON}",\n  APP_VERSION: "v1"\n};`);
    }
    if (req.headers.apikey !== ANON) return json(401, { message: "no apikey" });
    if (url.pathname === "/auth/v1/token") {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (body.email !== data.email || body.password !== data.password) return json(400, { error_description: "Invalid login credentials" });
      return json(200, { access_token: TOKEN, token_type: "bearer", expires_in: 3600 });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: "JWT expired" });
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "tasks") return json(200, (data.tasks ?? []).filter((t) => !["completed", "archived"].includes(t.status ?? "pending")).map((t) => ({ ...t, status: t.status ?? "pending", type: t.type ?? "assignment", course: course(t.course) })));
    if (table === "readings") return json(200, (data.readings ?? []).filter((r) => r.status !== "done").map((r) => ({ ...r, pages: r.pages ?? null, status: r.status ?? "not_started", course: course(r.course) })));
    if (table === "exams") return json(200, (data.exams ?? []).map((e) => ({ ...e, course: course(e.course) })));
    if (table === "quizzes") return json(200, (data.quizzes ?? []).map((q) => ({ ...q, course: course(q.course) })));
    json(404, { message: "not found" });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) };
}

/** Serves one .ics body at /cal.ics. */
export async function startIcsServer(body: () => string, port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url !== "/cal.ics") {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/calendar" });
    res.end(body());
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/cal.ics`, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * Microsoft's sign-in server, as far as Docket uses it: the device code, the
 * token poll and refresh. `outcome` decides what the sign-in ends in.
 */
export async function startFakeMicrosoft(port = 0) {
  const state = {
    url: "",
    /** "ok", or an AADSTS code the token poll answers with. */
    outcome: "ok" as string,
    account: { email: "odwright28@wabash.edu", name: "Owen Wright", tid: "wabash-tenant" },
    pendingPolls: 1,
    refreshes: 0,
    tokens: 0,
    close: async () => {},
  };
  const jwt = (payload: object) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  let polls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const fail = (code: string, err = "invalid_grant") => json(400, { error: err, error_description: `AADSTS${code}: something Microsoft says.\r\nTrace ID: x` });
    if (req.url?.endsWith("/oauth2/v2.0/devicecode")) {
      if (form.client_id !== "11111111-2222-3333-4444-555555555555") return fail("700016", "unauthorized_client");
      if (state.outcome === "53003") return fail("53003", "access_denied");
      polls = 0;
      return json(200, { device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 1 });
    }
    if (req.url?.endsWith("/oauth2/v2.0/token")) {
      if (form.grant_type === "refresh_token") {
        state.refreshes++;
        if (form.refresh_token === "revoked") return fail("700082");
        state.tokens++;
        return json(200, { access_token: `access-${state.tokens}`, refresh_token: `refresh-${state.tokens}`, expires_in: 3600, scope: "https://outlook.office.com/IMAP.AccessAsUser.All" });
      }
      if (polls++ < state.pendingPolls) return json(400, { error: "authorization_pending" });
      if (state.outcome !== "ok") return fail(state.outcome);
      state.tokens++;
      return json(200, {
        access_token: `access-${state.tokens}`,
        refresh_token: `refresh-${state.tokens}`,
        expires_in: 3600,
        scope: "https://outlook.office.com/IMAP.AccessAsUser.All openid profile email",
        id_token: jwt({ preferred_username: state.account.email, name: state.account.name, tid: state.account.tid }),
      });
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}
