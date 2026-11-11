// The API end to end, against a fake Ollama and a fake mailbox.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.ts";
import { buildApp } from "../server/app.ts";
import type { Push } from "../server/notify.ts";
import { FakeMailbox, startFakeOllama, type FakeOllama } from "../scripts/fakes.ts";

let clock = new Date(2026, 10, 10, 9, 0); // Tue Nov 10 2026, 9 AM
const pushes: Push[] = [];
const mailbox = new FakeMailbox();
let ollama: FakeOllama;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";

async function call<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await ctx.app.inject({ method: method as "GET", url: `/api${url}`, payload: body as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

before(async () => {
  ollama = await startFakeOllama();
  ctx = await buildApp({
    db: openDb(":memory:"),
    version: "test",
    repo: "x/y",
    updateCheck: false,
    mail: mailbox,
    now: () => clock,
    send: async (_s, p) => {
      pushes.push(p);
      return ["fake"];
    },
  });
});

after(async () => {
  await ctx.app.close();
  await ollama.close();
});

test("account, sign-in and the auth wall", async () => {
  assert.equal((await call("GET", "/today")).status, 401);
  const res = await ctx.app.inject({ method: "POST", url: "/api/account/create", payload: { username: "owen", password: "correct horse" } });
  assert.equal(res.statusCode, 200);
  cookie = String(res.headers["set-cookie"]).split(";")[0];
  assert.equal((await call("GET", "/session")).json.authenticated, true);
  assert.equal((await call("POST", "/account/create", { username: "x", password: "12345678" })).status, 409);
});

test("settings: secrets are never sent back", async () => {
  const r = await call("PUT", "/settings", { aiProvider: "ollama", aiUrl: ollama.url, aiModel: "llama3.1:8b", pushoverToken: "tok", pushoverUser: "usr", setupComplete: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.pushoverToken, "");
  assert.equal(r.json.pushoverTokenSet, true);
  assert.equal(r.json.adminPasswordHash, undefined);
  const t = await call("POST", "/ai/test", { provider: "ollama", url: ollama.url, model: "llama3.1:8b" });
  assert.equal(t.status, 200);
  assert.deepEqual(t.json.models, ["llama3.1:8b", "qwen2.5:7b"]);
});

test("quick add through the AI makes two repeating pet tasks", async () => {
  const p = await call("POST", "/parse", { text: "I feed the dart frogs every other day and I feed the gecko every other day" });
  assert.equal(p.json.via, "ai");
  assert.equal(p.json.tasks.length, 2);
  const created = await call("POST", "/tasks/bulk", { tasks: p.json.tasks, source: "ai" });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json.map((t: any) => t.repeatText), ["Every other day, from when it's done", "Every other day, from when it's done"]);
  const today = await call("GET", "/today");
  assert.deepEqual(today.json.today.map((t: any) => t.title).sort(), ["Feed the dart frogs", "Feed the gecko"]);
});

test("done moves a repeating task forward; undo puts it back", async () => {
  const today = await call("GET", "/today");
  const frogs = today.json.today.find((t: any) => t.title === "Feed the dart frogs");
  const done = await call("POST", `/tasks/${frogs.id}/complete`);
  assert.equal(done.json.task.dueDate, "2026-11-12");
  assert.equal((await call("GET", "/today")).json.done.length, 1);
  const undone = await call("POST", `/log/${done.json.logId}/undo`);
  assert.equal(undone.json.dueDate, "2026-11-10");
  // Two days later, still not fed: it's overdue, and feeding it then counts from then.
  clock = new Date(2026, 10, 12, 9, 0);
  assert.equal((await call("GET", "/today")).json.overdue.length, 2);
  const late = await call("POST", `/tasks/${frogs.id}/complete`);
  assert.equal(late.json.task.dueDate, "2026-11-14");
});

test("when the AI is down, quick add falls back to the rules", async () => {
  ollama.down = true;
  const p = await call("POST", "/parse", { text: "dentist friday at 3pm" });
  assert.equal(p.json.via, "rules");
  assert.match(p.json.note, /couldn't help/);
  assert.equal(p.json.tasks[0].dueTime, "15:00");
  assert.equal((await call("GET", "/status")).json.ai.ok, false);
  ollama.down = false;
});

test("a timed task pushes a reminder once", async () => {
  const t = await call("POST", "/tasks", { title: "Vet appointment", dueDate: "2026-11-12", dueTime: "10:00" });
  assert.equal(t.status, 200);
  pushes.length = 0;
  await ctx.engine.reminders((await import("../server/db.ts")).getSettings(ctx.engine.db));
  assert.equal(pushes.length, 0); // 9 AM: not yet
  clock = new Date(2026, 10, 12, 10, 0);
  const s = (await import("../server/db.ts")).getSettings(ctx.engine.db);
  await ctx.engine.reminders(s);
  await ctx.engine.reminders(s);
  assert.deepEqual(pushes.map((p) => p.title), ["Vet appointment"]);
});

test("email: sorted by the AI, a suggested task, and sender rules", async () => {
  clock = new Date();
  mailbox.deliver({ fromAddr: "billing@power.example", fromName: "City Power", subject: "Your payment is due", text: "Amount due $84 by 2026-11-20", bulk: true });
  mailbox.deliver({ fromAddr: "deals@shop.example", subject: "50% off everything this weekend", text: "Shop now", bulk: true });
  mailbox.deliver({ fromAddr: "prof@wabash.example", fromName: "Prof. Lee", subject: "Lab moved to Thursday", text: "Hi Owen, the lab is moving." });
  const acct = await call("POST", "/mail-accounts", { label: "Gmail", host: "imap.gmail.com", username: "me@example.com", password: "app-pass" });
  assert.equal(acct.status, 200);
  await ctx.engine.checkMail();
  const inbox = await call("GET", "/emails?view=attention");
  assert.deepEqual(inbox.json.emails.map((e: any) => e.subject).sort(), ["Lab moved to Thursday", "Your payment is due"]);
  const bill = inbox.json.emails.find((e: any) => e.category === "action");
  assert.equal(bill.decidedBy, "ai");
  assert.equal(bill.suggestion.dueDate, "2026-11-20");
  assert.ok(bill.openUrl?.startsWith("https://mail.google.com/"));
  assert.equal((await call("GET", "/emails?view=filtered")).json.emails.length, 1);
  assert.ok(pushes.some((p) => /Your payment is due/.test(p.title)));

  const task = await call("POST", `/emails/${bill.id}/accept`, {});
  assert.equal(task.json.source, "email");
  assert.equal(task.json.dueDate, "2026-11-20");
  assert.equal((await call("GET", "/emails?view=attention")).json.emails.length, 1);

  // "Always ignore" this shop: future mail from it is filed away.
  await call("POST", "/sender-rules", { pattern: "shop.example", action: "ignore" });
  mailbox.deliver({ fromAddr: "news@shop.example", subject: "Last chance!", text: "Sale ends", bulk: true });
  await ctx.engine.checkMail();
  const filtered = (await call("GET", "/emails?view=filtered")).json.emails;
  assert.ok(filtered.every((e: any) => e.category === "ignored"));
  assert.equal(filtered.length, 2);
});

test("email sorted while the AI was offline is redone when it's back", async () => {
  ollama.down = true;
  mailbox.deliver({ fromAddr: "landlord@rent.example", subject: "Please sign the lease renewal", text: "Sign by 2026-12-01" });
  await ctx.engine.checkMail();
  const before = (await call("GET", "/emails?view=attention")).json.emails.find((e: any) => /lease/.test(e.subject));
  assert.equal(before.decidedBy, "basic");
  assert.equal(before.aiPending, true);
  ollama.down = false;
  assert.equal(await ctx.engine.retryAi(), 1);
  const afterRetry = (await call("GET", "/emails?view=attention")).json.emails.find((e: any) => /lease/.test(e.subject));
  assert.equal(afterRetry.decidedBy, "ai");
  assert.equal(afterRetry.suggestion.dueDate, "2026-12-01");
});

test("the daily summary is written by the AI and pushed once", async () => {
  pushes.length = 0;
  clock = new Date(2026, 10, 14, 7, 5);
  const s = (await import("../server/db.ts")).getSettings(ctx.engine.db);
  await ctx.engine.dailySummary(s);
  await ctx.engine.dailySummary(s);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /^Your day:/);
  const d = (await call("GET", "/digest")).json;
  assert.equal(d.byAi, true);
  assert.equal(d.date, "2026-11-14");
  assert.ok(d.facts.today.some((t: any) => t.title === "Feed the dart frogs"));
  assert.match(d.briefing, /Good morning/);
});
