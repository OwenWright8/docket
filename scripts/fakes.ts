// Stand-ins for the outside world, used by the tests and `npm run dev:demo`:
// a fake Ollama that answers like a small local model would, and a fake
// mailbox. Nothing here touches the network beyond localhost.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseQuickAdd } from "../server/parse.ts";
import { basicVerdict } from "../server/triage.ts";
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

  deliver(m: Partial<FetchedMail> & { subject: string; fromAddr: string }) {
    const mail: FetchedMail = { uid: this.nextUid++, messageId: `<${this.nextUid}@fake>`, fromName: "", date: new Date(), text: "", bulk: false, labels: [], ...m };
    this.messages.push(mail);
    return mail;
  }

  async fetch(a: MailAccountRow, opts: { lookbackDays: number; limit: number }) {
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
