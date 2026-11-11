import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, firstDue, nextDue, normalizeRecurrence, type Recurrence } from "../server/recurrence.ts";
import { parseQuickAdd } from "../server/parse.ts";
import { cleanAiTask } from "../server/ai.ts";
import { basicVerdict, normalizePattern, ruleFor } from "../server/triage.ts";
import { addMonths } from "../server/time.ts";

// Tuesday, Nov 10 2026, 9 AM local.
const NOW = new Date(2026, 10, 10, 9, 0);

test("every other day, counted from when it's done", () => {
  const r: Recurrence = { every: 2, unit: "day", from: "done" };
  assert.equal(nextDue(r, "2026-11-10", "2026-11-10"), "2026-11-12");
  // Fed a day late: the next feeding is two days after that, not tomorrow.
  assert.equal(nextDue(r, "2026-11-10", "2026-11-11"), "2026-11-13");
});

test("schedule-based repeats skip forward past missed dates", () => {
  const r: Recurrence = { every: 1, unit: "week", from: "due" };
  assert.equal(nextDue(r, "2026-11-03", "2026-11-10"), "2026-11-17");
  // Done early: still the next one after the due date.
  assert.equal(nextDue(r, "2026-11-17", "2026-11-15"), "2026-11-24");
});

test("weekdays, every other week, and month ends", () => {
  const monThu: Recurrence = { every: 1, unit: "week", weekdays: [1, 4], from: "due" };
  assert.equal(nextDue(monThu, "2026-11-12", "2026-11-12"), "2026-11-16"); // Thu → Mon
  assert.equal(nextDue(monThu, "2026-11-16", "2026-11-16"), "2026-11-19"); // Mon → Thu
  assert.equal(firstDue(monThu, "2026-11-10"), "2026-11-12");
  const alt: Recurrence = { every: 2, unit: "week", weekdays: [2], from: "due" };
  assert.equal(nextDue(alt, "2026-11-10", "2026-11-10"), "2026-11-24");
  const monthly: Recurrence = { every: 1, unit: "month", day: 31, from: "due" };
  assert.equal(nextDue(monthly, "2027-01-31", "2027-01-31"), "2027-02-28");
  assert.equal(nextDue(monthly, "2027-02-28", "2027-02-28"), "2027-03-31");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
});

test("describing repeats", () => {
  assert.equal(describe({ every: 2, unit: "day", from: "done" }), "Every other day, from when it's done");
  assert.equal(describe({ every: 1, unit: "week", weekdays: [1, 2, 3, 4, 5], from: "due" }), "Every weekday");
  assert.equal(describe({ every: 3, unit: "week", from: "due" }), "Every 3 weeks");
  assert.equal(describe({ every: 1, unit: "month", day: 1, from: "due" }), "Every month on the 1st");
});

test("normalizing untrusted repeats", () => {
  assert.equal(normalizeRecurrence({ every: 0, unit: "day" }), null);
  assert.equal(normalizeRecurrence({ every: 2, unit: "fortnight" }), null);
  assert.deepEqual(normalizeRecurrence({ every: "2", unit: "day" }), { every: 2, unit: "day", from: "done" });
  assert.equal(normalizeRecurrence({ every: 1, unit: "week", weekdays: [9, 1, 1] })?.weekdays?.join(), "1");
});

test("quick add without AI: the frogs and the gecko are two tasks", () => {
  const tasks = parseQuickAdd("I feed the dart frogs every other day and I feed the gecko every other day", { now: NOW });
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((t) => [t.title, t.dueDate, t.recurrence?.every, t.recurrence?.unit, t.list]),
    [
      ["Feed the dart frogs", "2026-11-10", 2, "day", "Pets"],
      ["Feed the gecko", "2026-11-10", 2, "day", "Pets"],
    ],
  );
});

test("quick add without AI: dates, times and weekdays", () => {
  const one = (s: string) => parseQuickAdd(s, { now: NOW })[0];
  assert.deepEqual([one("dentist friday at 3pm").dueDate, one("dentist friday at 3pm").dueTime], ["2026-11-13", "15:00"]);
  assert.equal(one("call mom tomorrow evening").dueTime, "18:00");
  assert.equal(one("submit lab report by Nov 20 urgent").priority, 2);
  assert.equal(one("submit lab report by Nov 20 urgent").dueDate, "2026-11-20");
  assert.deepEqual(one("water plants on mondays and thursdays").recurrence?.weekdays, [1, 4]);
  assert.equal(one("pay rent on the 1st every month").dueDate, "2026-12-01");
  assert.equal(one("buy crickets").dueDate, null);
  assert.equal(one("take the bins out every tuesday").dueDate, "2026-11-10");
  assert.equal(one("clean the tank next saturday").dueDate, "2026-11-21");
  assert.equal(parseQuickAdd("milk\neggs\nbread", { now: NOW }).length, 3);
});

test("AI answers are checked: bad dates dropped, repeats normalized", () => {
  const t = cleanAiTask(
    { title: "I need to feed the gecko", due_date: "1999-01-01", due_time: "25:00", repeat_every: 2, repeat_unit: "day", repeat_weekdays: [], priority: "normal", list: "pets", notes: "" },
    NOW,
    ["Pets"],
  );
  assert.ok(t);
  assert.equal(t.title, "Feed the gecko");
  assert.equal(t.dueDate, "2026-11-10"); // the bogus date is replaced by the repeat's first day
  assert.equal(t.dueTime, null);
  assert.equal(t.list, "Pets");
  assert.equal(cleanAiTask({ title: "  " }, NOW, []), null);
});

test("email: basic signals and sender rules", () => {
  assert.equal(basicVerdict({ fromAddr: "deals@shop.com", subject: "50% off everything", text: "", bulk: true, labels: [] }).category, "promo");
  assert.equal(basicVerdict({ fromAddr: "billing@power.com", subject: "Your payment is due Nov 20", text: "", bulk: true, labels: [] }).category, "action");
  assert.equal(basicVerdict({ fromAddr: "prof@wabash.edu", subject: "Lab tomorrow", text: "See you there", bulk: false, labels: [] }).category, "important");
  assert.equal(basicVerdict({ fromAddr: "x@y.com", subject: "You've won!", text: "claim your prize", bulk: false, labels: [] }).category, "spam");
  const rules = [
    { id: 1, pattern: "@wabash.edu", action: "important" as const, created_at: 0 },
    { id: 2, pattern: "spammy@wabash.edu", action: "ignore" as const, created_at: 0 },
  ];
  assert.equal(ruleFor(rules, "prof@mail.wabash.edu")?.action, "important");
  assert.equal(ruleFor(rules, "spammy@wabash.edu")?.action, "ignore");
  assert.equal(ruleFor(rules, "a@other.com"), null);
  assert.equal(normalizePattern("Example.com"), "@example.com");
  assert.equal(normalizePattern("Me@Example.com"), "me@example.com");
  assert.equal(normalizePattern("not a domain"), null);
});
