// Notification buttons, nag mode, calendars, carrel, waiting on replies,
// the ask box and the Homepage widget, against fakes.
process.env.TZ = "America/New_York";

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { getSettings, openDb } from "../server/db.ts";
import { buildApp } from "../server/app.ts";
import type { Push } from "../server/notify.ts";
import { parseIcs } from "../server/sources.ts";
import { FakeMailbox, startFakeCarrel, startFakeOllama, startIcsServer, type FakeOllama } from "../scripts/fakes.ts";

let clock = new Date(2026, 10, 10, 9, 0); // Tue Nov 10 2026, 9 AM New York
const pushes: Push[] = [];
const mailbox = new FakeMailbox();
let ollama: FakeOllama;
let carrel: Awaited<ReturnType<typeof startFakeCarrel>>;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";

async function call<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T; text: string }> {
  const res = await ctx.app.inject({ method: method as "GET", url, payload: body as object, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  let json: any = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    // HTML
  }
  return { status: res.statusCode, json, text: res.body };
}
const api = <T = any>(m: string, u: string, b?: unknown) => call<T>(m, `/api${u}`, b);
const settings = () => getSettings(ctx.engine.db);

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VTIMEZONE
TZID:America/Chicago
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
TZNAME:CST
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
TZNAME:CDT
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:bio-lab
SUMMARY:Bio lab
LOCATION:Hays 104
DTSTART;TZID=America/Chicago:20261103T130000
DTEND;TZID=America/Chicago:20261103T150000
RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6
EXDATE;TZID=America/Chicago:20261117T130000
END:VEVENT
BEGIN:VEVENT
UID:bio-lab
RECURRENCE-ID;TZID=America/Chicago:20261124T130000
SUMMARY:Bio lab (moved)
DTSTART;TZID=America/Chicago:20261125T100000
DTEND;TZID=America/Chicago:20261125T120000
END:VEVENT
BEGIN:VEVENT
UID:break
SUMMARY:Thanksgiving break
DTSTART;VALUE=DATE:20261125
DTEND;VALUE=DATE:20261130
END:VEVENT
BEGIN:VEVENT
UID:dentist
SUMMARY:Dentist
DTSTART:20261110T200000Z
DTEND:20261110T210000Z
END:VEVENT
BEGIN:VEVENT
UID:cancelled
SUMMARY:Club meeting
STATUS:CANCELLED
DTSTART:20261110T230000Z
END:VEVENT
END:VCALENDAR`;

before(async () => {
  ollama = await startFakeOllama();
  carrel = await startFakeCarrel({
    email: "owen@example.com",
    password: "carrel-pass",
    tasks: [
      { id: "t1", title: "Lab report 4", due_at: "2026-11-12T04:59:00Z", course: "BIO 111" }, // Wed 11:59 PM New York
      { id: "t2", title: "Problem set 7", due_at: "2026-11-09T17:00:00Z", course: "MAT 223" }, // yesterday noon: overdue
      { id: "t3", title: "Old essay", due_at: "2026-11-05T17:00:00Z", status: "completed", course: "ENG 101" },
    ],
    readings: [{ id: "r1", title: "Campbell ch. 9", pages: "160-185", due_date: "2026-11-10", course: "BIO 111" }],
    exams: [{ id: "e1", title: "Midterm 2", exam_at: "2026-11-16T14:00:00Z", course: "BIO 111" }],
  });
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
  const res = await ctx.app.inject({ method: "POST", url: "/api/account/create", payload: { username: "owen", password: "correct horse" } });
  cookie = String(res.headers["set-cookie"]).split(";")[0];
  await api("PUT", "/settings", {
    aiProvider: "ollama",
    aiUrl: ollama.url,
    aiModel: "llama3.1:8b",
    ntfyUrl: "https://ntfy.example/docket-test",
    publicUrl: "http://docket.lan:8585",
    setupComplete: true,
  });
});

after(async () => {
  await ctx.app.close();
  await ollama.close();
  await carrel.close();
});

test("iCalendar: time zones, repeats, exceptions, all-day and cancelled events", () => {
  const items = parseIcs(ICS, { now: clock, calendarName: "School" });
  const by = (t: string) => items.filter((i) => i.title.startsWith(t));
  // 1 PM Chicago is 2 PM New York.
  assert.deepEqual(
    by("Bio lab").map((i) => [i.date, i.time, i.title]),
    [
      ["2026-11-03", "14:00", "Bio lab"],
      ["2026-11-10", "14:00", "Bio lab"],
      ["2026-11-25", "11:00", "Bio lab (moved)"],
      ["2026-12-01", "14:00", "Bio lab"],
      ["2026-12-08", "14:00", "Bio lab"],
    ],
  ); // Nov 17 was cancelled (EXDATE), Nov 24 moved to the 25th
  assert.equal(by("Bio lab")[0].location, "Hays 104");
  const brk = by("Thanksgiving")[0];
  assert.deepEqual([brk.date, brk.end_date, brk.time], ["2026-11-25", "2026-11-29", null]);
  assert.deepEqual([by("Dentist")[0].date, by("Dentist")[0].time], ["2026-11-10", "15:00"]);
  assert.equal(by("Club").length, 0);
});

test("a calendar link and carrel feed Today and the summary", async () => {
  const ics = await startIcsServer(() => ICS);
  try {
    const cal = await api("POST", "/sources", { kind: "ics", name: "School", url: ics.url.replace("http://", "http://") });
    assert.equal(cal.status, 200);
    assert.equal(cal.json.lastError, null);
    assert.equal(cal.json.url, new URL(ics.url).host); // the private link itself isn't sent back
  } finally {
    await ics.close();
  }
  const bad = await api("POST", "/sources/test", { kind: "carrel", url: carrel.url, username: "owen@example.com", password: "nope" });
  assert.match(bad.json.error, /didn't accept/);
  const c = await api("POST", "/sources", { kind: "carrel", url: carrel.url, username: "owen@example.com", password: "carrel-pass" });
  assert.equal(c.json.lastError, null);
  assert.equal(c.json.items, 4); // the completed essay isn't there

  const today = (await api("GET", "/today")).json;
  assert.deepEqual(today.schedule.map((i: any) => [i.time, i.title]), [
    [null, "Read Campbell ch. 9 (pp. 160-185)"],
    ["14:00", "Bio lab"],
    ["15:00", "Dentist"],
  ]);
  const school = today.school.map((i: any) => [i.title, i.date, i.time, i.overdue]);
  assert.deepEqual(school, [
    ["Problem set 7", "2026-11-09", "12:00", true],
    ["Lab report 4", "2026-11-11", null, false], // due 11:59 PM is "end of the day", no time shown
    ["Midterm 2", "2026-11-16", "09:00", false],
  ]);

  const d = (await api("POST", "/digest", {})).json.digest;
  assert.match(d.briefing, /On the calendar today: BIO 111: Read Campbell.*Bio lab at 2 PM, Hays 104; Dentist at 3 PM/);
  assert.match(d.briefing, /past due in carrel: MAT 223: Problem set 7/);
  assert.match(d.briefing, /BIO 111: Midterm 2 exam/);
});

test("a timed reminder has Done / Snooze buttons; nag mode repeats until it's done", async () => {
  const t = (await api("POST", "/tasks", { title: "Give the gecko calcium", dueDate: "2026-11-10", dueTime: "10:00", nagMinutes: 30 })).json;
  assert.equal(t.nagMinutes, 30);
  pushes.length = 0;
  const tick = () => ctx.engine.reminders(settings());

  clock = new Date(2026, 10, 10, 10, 0);
  await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "Give the gecko calcium");
  assert.deepEqual(pushes[0].actions?.map((a) => a.label), ["Done", "Snooze 1 h", "Tomorrow"]);
  assert.match(pushes[0].url!, /^http:\/\/docket\.lan:8585\/act\?t=/); // Pushover's link: the page with the buttons

  clock = new Date(2026, 10, 10, 10, 20);
  await tick();
  assert.equal(pushes.length, 1); // not yet

  clock = new Date(2026, 10, 10, 10, 30);
  await tick();
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].title, "Still to do: Give the gecko calcium");

  // Snooze from the notification: quiet for an hour, then one more push.
  const snooze = new URL(pushes[1].actions![1].url);
  const r = await call("POST", `${snooze.pathname}${snooze.search}`);
  assert.equal(r.status, 200);
  assert.match(r.json.message, /Snoozed .* until 11:30 AM/);
  clock = new Date(2026, 10, 10, 11, 0);
  await tick();
  assert.equal(pushes.length, 2);
  clock = new Date(2026, 10, 10, 11, 30);
  await tick();
  assert.equal(pushes.length, 3);

  // Done from the notification; the old link then stops working.
  const done = new URL(pushes[2].actions![0].url);
  assert.equal((await call("POST", `${done.pathname}${done.search}`)).json.message, "Done: Give the gecko calcium.");
  assert.equal((await call("POST", `${done.pathname}${done.search}`)).status, 409);
  const forged = new URL(done.href.replace(/s=[^&]+/, "s=AAAAAAAAAAAAAAAAAAAAAAAA"));
  assert.equal((await call("POST", `${forged.pathname}${forged.search}`)).status, 403);
  clock = new Date(2026, 10, 10, 12, 30);
  await tick();
  assert.equal(pushes.length, 3);
});

test("nags hold off overnight", async () => {
  await api("POST", "/tasks", { title: "Take out the trash", dueDate: "2026-11-10", dueTime: "21:30", nagMinutes: 10 });
  pushes.length = 0;
  clock = new Date(2026, 10, 10, 21, 30);
  await ctx.engine.reminders(settings());
  clock = new Date(2026, 10, 10, 21, 45);
  await ctx.engine.reminders(settings());
  clock = new Date(2026, 10, 10, 22, 30);
  await ctx.engine.reminders(settings());
  assert.deepEqual(pushes.map((p) => p.title), ["Take out the trash", "Still to do: Take out the trash"]);
  clock = new Date(2026, 10, 11, 7, 0);
  await ctx.engine.reminders(settings());
  assert.equal(pushes.length, 3);
});

test("the Pushover page shows the buttons and works without signing in", async () => {
  const t = (await api("POST", "/tasks", { title: "Mist the vivarium", dueDate: "2026-11-11", dueTime: "08:00" })).json;
  pushes.length = 0;
  clock = new Date(2026, 10, 11, 8, 0);
  await ctx.engine.reminders(settings());
  const page = new URL(pushes.find((p) => p.title === "Mist the vivarium")!.url!);
  const saved = cookie;
  cookie = "";
  try {
    const html = (await call("GET", `${page.pathname}${page.search}`)).text;
    assert.match(html, /Mist the vivarium/);
    assert.match(html, /value="done"/);
    const form = Object.fromEntries(page.searchParams);
    const res = await ctx.app.inject({ method: "POST", url: "/act", payload: new URLSearchParams({ ...form, a: "tomorrow" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.match(res.body, /Moved Mist the vivarium to tomorrow at 8 AM/);
  } finally {
    cookie = saved;
  }
  assert.equal((await api("GET", `/tasks/${t.id}`)).json.dueDate, "2026-11-12");
});

test("waiting on a reply: questions are tracked until the answer arrives", async () => {
  clock = new Date();
  clock.setHours(12, 0, 0, 0); // midday, so the nudge isn't held for quiet hours
  const ask = mailbox.send({ to: [{ name: "Prof. Lee", addr: "lee@wabash.example" }], subject: "Extension on lab 4?", text: "Hi Professor, could I have until Friday for lab 4?\n\nThanks,\nOwen" });
  mailbox.send({ to: [{ name: "Sam", addr: "sam@example.com" }], subject: "Re: notes", text: "Thanks, got them!\n\nOn Mon, Sam wrote:\n> here are the notes, can you check them?" });
  mailbox.send({ to: [{ name: "Vet", addr: "office@vet.example" }], subject: "Pickles' checkup", text: "Can we move Pickles' checkup to next week?", date: new Date(Date.now() - 5 * 86_400_000) });
  await api("POST", "/mail-accounts", { host: "imap.example.com", username: "me@example.com", password: "x" });
  await ctx.engine.checkMail();
  const waiting = (await api("GET", "/sent")).json;
  assert.deepEqual(waiting.map((w: any) => [w.subject, w.overdue]).sort(), [
    ["Extension on lab 4?", false],
    ["Pickles' checkup", true],
  ]);
  assert.equal((await api("GET", "/sent?state=none")).json[0].subject, "Re: notes"); // a thank-you doesn't expect an answer

  // Five days with no word from the vet: one nudge, not one every 30 seconds.
  pushes.length = 0;
  await ctx.engine.nudgeReplies(settings());
  await ctx.engine.nudgeReplies(settings());
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "No reply yet from Vet");

  mailbox.deliver({ fromAddr: "lee@wabash.example", fromName: "Prof. Lee", subject: "Re: Extension on lab 4?", text: "Friday is fine.", inReplyTo: ask.messageId, references: [ask.messageId!] });
  await ctx.engine.checkMail();
  assert.deepEqual((await api("GET", "/sent")).json.map((w: any) => w.subject), ["Pickles' checkup"]);
  assert.equal((await api("GET", "/sent?state=answered")).json[0].subject, "Extension on lab 4?");

  const vet = (await api("GET", "/sent")).json[0];
  const fu = (await api("POST", `/sent/${vet.id}/follow-up`)).json;
  assert.equal(fu.title, "Follow up with Vet: Pickles' checkup");
  assert.equal((await api("GET", "/sent")).json.length, 0);
});

test("the ask box answers from your history", async () => {
  clock = new Date(2026, 10, 12, 18, 0);
  const t = (await api("POST", "/tasks", { title: "Feed the gecko", dueDate: "2026-11-12", recurrence: { every: 2, unit: "day" } })).json;
  await api("POST", `/tasks/${t.id}/complete`);
  const r = await api("POST", "/ask", { question: "When did I last feed the gecko?" });
  assert.equal(r.status, 200);
  assert.match(r.json.answer, /Thu Nov 12 18:00: done "Feed the gecko"/);
  ollama.down = true;
  assert.equal((await api("POST", "/ask", { question: "anything?" })).status, 502);
  ollama.down = false;
});

test("Homepage widget: a key reads the numbers, nothing else", async () => {
  assert.equal((await call("GET", "/api/widget")).status, 401);
  const { key, id } = (await api("POST", "/widget-keys", { label: "Homepage" })).json;
  assert.match(key, /^dkt_/);
  const saved = cookie;
  cookie = "";
  try {
    const w = await call("GET", "/api/widget", undefined, { "x-api-key": key });
    assert.equal(w.status, 200);
    for (const f of ["due_today", "overdue", "done_today", "inbox", "waiting", "events_today"]) assert.equal(typeof w.json[f], "number", f);
    assert.ok(["online", "offline"].includes(w.json.ai)); // the last test left it "offline" on purpose
    assert.equal((await call("GET", "/api/today", undefined, { "x-api-key": key })).status, 401);
  } finally {
    cookie = saved;
  }
  assert.ok((await api("GET", "/widget-keys")).json[0].lastUsedAt);
  await api("DELETE", `/widget-keys/${id}`);
  assert.equal((await call("GET", "/api/widget", undefined, { "x-api-key": key })).status, 401);
});

test("ntfy: server + topic, priority, sign-in and buttons, the way the ntfy server expects them", async () => {
  const http = await import("node:http");
  const got: { url?: string; auth?: string; body?: any }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(req.headers.authorization === `Basic ${Buffer.from("owen:hunter22").toString("base64")}` ? 200 : 401, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const { sendPush } = await import("../server/notify.ts");
    const base = { ...settings(), pushoverToken: "", pushoverUser: "", ntfyUrl: "", ntfyServer: `http://127.0.0.1:${port}`, ntfyTopic: "Docket", ntfyPriority: 4 };
    await assert.rejects(sendPush({ ...base, ntfyAuth: "basic", ntfyUsername: "owen", ntfyPassword: "wrong" }, { title: "x", message: "y" }), /ntfy refused/);
    const sent = await sendPush({ ...base, ntfyAuth: "basic", ntfyUsername: "owen", ntfyPassword: "hunter22" }, {
      title: "Feed the gecko",
      message: "Today",
      priority: "high",
      actions: [{ label: "Done", url: "http://docket.lan/api/act?x=1" }],
    });
    assert.deepEqual(sent, ["ntfy"]);
    const last = got.at(-1)!;
    assert.equal(last.url, "/"); // the topic goes in the body, not the URL
    assert.equal(last.body.topic, "Docket");
    assert.equal(last.body.priority, 5); // 4, one higher for urgent
    assert.deepEqual(last.body.actions, [{ action: "http", label: "Done", url: "http://docket.lan/api/act?x=1", method: "POST", clear: true }]);
  } finally {
    server.close();
  }
  // The settings API takes the same fields, and never hands the password back.
  const r = await api("PUT", "/settings", { ntfyServer: "http://ntfy:80/", ntfyTopic: "Docket", ntfyAuth: "basic", ntfyUsername: "owen", ntfyPassword: "secret", ntfyPriority: 5 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ntfyServer, r.json.ntfyPassword, r.json.ntfyPasswordSet, r.json.ntfyUrl], ["http://ntfy:80", "", true, ""]);
  assert.equal((await api("PUT", "/settings", { ntfyTopic: "has spaces" })).status, 400);
});
