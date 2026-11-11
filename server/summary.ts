// The daily summary: what's overdue, what's on today, what's coming, and the
// email that needs you. The AI writes it up as a short briefing; without the
// AI it's a plain list that says the same things.
import { type AiClient, aiBriefing } from "./ai.ts";
import type { DB, EmailRow, TaskRow } from "./db.ts";
import { openTasks, parseRecurrence } from "./tasks.ts";
import { addDays, daysBetween, friendlyTime, relativeDay, shortDate, todayYmd, ymd } from "./time.ts";
import { itemsBetween, itemsOn, overdueSchool } from "./sources.ts";
import { describe } from "./recurrence.ts";

export interface DayFacts {
  date: string;
  overdue: { id: number; title: string; due: string; daysLate: number }[];
  today: { id: number; title: string; time: string | null; repeat: string | null }[];
  upcoming: { id: number; title: string; due: string; time: string | null }[];
  emails: { id: number; from: string; subject: string; summary: string | null; category: string }[];
  suggestions: number;
  /** Today's calendar and carrel items, timed ones in order. */
  schedule: { title: string; kind: string; time: string | null; endTime: string | null; location: string | null; context: string | null }[];
  /** carrel work due soon, and exams / quizzes within a week. */
  school: { title: string; kind: string; date: string; time: string | null; context: string | null; overdue: boolean }[];
  /** Email you sent that's past the wait period without an answer. */
  waiting: { to: string; subject: string; sentAt: number }[];
}

export function dayFacts(db: DB, now = new Date(), waitDays = 3): DayFacts {
  const date = todayYmd(now);
  const soon = addDays(date, 3);
  const tasks = openTasks(db);
  const label = (t: TaskRow) => t.title;
  const since = now.getTime() - 36 * 3_600_000;
  const emails = db
    .prepare(
      `SELECT * FROM emails WHERE category IN ('important','action') AND handled = 0 AND received_at > ?
       ORDER BY category = 'action' DESC, received_at DESC LIMIT 8`,
    )
    .all(since) as unknown as EmailRow[];
  return {
    date,
    overdue: tasks
      .filter((t) => t.due_date && t.due_date < date)
      .map((t) => ({ id: t.id, title: label(t), due: t.due_date!, daysLate: daysBetween(t.due_date!, date) })),
    today: tasks
      .filter((t) => t.due_date === date)
      .map((t) => {
        const rec = parseRecurrence(t);
        return { id: t.id, title: label(t), time: t.due_time, repeat: rec ? describe(rec) : null };
      }),
    upcoming: tasks
      .filter((t) => t.due_date && t.due_date > date && t.due_date <= soon)
      .map((t) => ({ id: t.id, title: label(t), due: t.due_date!, time: t.due_time })),
    emails: emails.map((e) => ({ id: e.id, from: e.from_name || e.from_addr || "someone", subject: e.subject ?? "", summary: e.summary, category: e.category })),
    suggestions: (db.prepare("SELECT count(*) AS n FROM emails WHERE suggestion_state = 'pending' AND handled = 0").get() as { n: number }).n,
    schedule: itemsOn(db, date).map((i) => ({ title: i.title, kind: i.kind, time: i.time, endTime: i.end_time, location: i.location, context: i.context })),
    school: [
      ...overdueSchool(db, date).map((i) => ({ title: i.title, kind: i.kind, date: i.date, time: i.time, context: i.context, overdue: true })),
      ...itemsBetween(db, addDays(date, 1), addDays(date, 7))
        .filter((i) => i.kind === "exam" || i.kind === "quiz" || ((i.kind === "assignment" || i.kind === "reading") && i.date <= soon))
        .map((i) => ({ title: i.title, kind: i.kind, date: i.date, time: i.time, context: i.context, overdue: false })),
    ],
    waiting: (
      db.prepare("SELECT to_name, to_addr, subject, sent_at FROM sent_mail WHERE state = 'waiting' AND sent_at < ? ORDER BY sent_at").all(
        now.getTime() - waitDays * 86_400_000,
      ) as { to_name: string | null; to_addr: string | null; subject: string | null; sent_at: number }[]
    ).map((w) => ({ to: w.to_name || w.to_addr || "someone", subject: w.subject ?? "", sentAt: w.sent_at })),
  };
}

/** The facts as plain lines, which is both the AI's input and the no-AI briefing. */
export function factsText(f: DayFacts): string {
  const lines: string[] = [`Today is ${shortDate(f.date)}.`];
  const at = (t: string | null) => (t ? ` at ${friendlyTime(t)}` : "");
  if (f.overdue.length) {
    lines.push(`Overdue (${f.overdue.length}): ${f.overdue.map((t) => `${t.title} (${t.daysLate === 1 ? "since yesterday" : `${t.daysLate} days late`})`).join("; ")}.`);
  }
  if (f.today.length) {
    const timed = f.today.filter((t) => t.time).sort((a, b) => a.time!.localeCompare(b.time!));
    const untimed = f.today.filter((t) => !t.time);
    lines.push(`Today (${f.today.length}): ${[...timed.map((t) => `${t.title}${at(t.time)}`), ...untimed.map((t) => t.title)].join("; ")}.`);
  } else lines.push("Nothing is due today.");
  // carrel items get their course ("BIO 111: Lab report 4"); calendar events don't get the calendar's name.
  const label = (i: { title: string; context: string | null; kind: string }) => (i.kind !== "event" && i.context && !i.title.includes(i.context) ? `${i.context}: ${i.title}` : i.title);
  if (f.schedule?.length) {
    lines.push(
      `On the calendar today: ${f.schedule
        .map((e) => `${label(e)}${e.kind !== "event" ? ` (${e.kind})` : ""}${e.time ? ` at ${friendlyTime(e.time)}` : " (all day)"}${e.location ? `, ${e.location}` : ""}`)
        .join("; ")}.`,
    );
  }
  const late = f.school?.filter((i) => i.overdue) ?? [];
  const ahead = f.school?.filter((i) => !i.overdue) ?? [];
  if (late.length) lines.push(`School work past due in carrel: ${late.map((i) => `${label(i)} (was due ${relativeDay(i.date, f.date)})`).join("; ")}.`);
  if (ahead.length) lines.push(`School coming up: ${ahead.map((i) => `${label(i)}${i.kind === "exam" || i.kind === "quiz" ? ` ${i.kind}` : ""} ${relativeDay(i.date, f.date)}${at(i.time)}`).join("; ")}.`);
  if (f.upcoming.length) lines.push(`Coming up: ${f.upcoming.map((t) => `${t.title} (${relativeDay(t.due, f.date)}${at(t.time)})`).join("; ")}.`);
  if (f.emails.length) {
    lines.push(
      `Email that needs you (${f.emails.length}): ${f.emails
        .map((e) => `${e.category === "action" ? "to do: " : ""}${e.from}, "${e.subject}"${e.summary ? ` (${e.summary})` : ""}`)
        .join("; ")}.`,
    );
  }
  if (f.waiting?.length) {
    lines.push(`Still no reply to: ${f.waiting.map((w) => `${w.to}, "${w.subject}" (sent ${daysBetween(ymd(new Date(w.sentAt)), f.date)} days ago)`).join("; ")}.`);
  }
  if (f.suggestions) lines.push(`${f.suggestions} email${f.suggestions === 1 ? " has" : "s have"} a suggested task waiting for a yes or no.`);
  return lines.join("\n");
}

export interface Digest {
  date: string;
  briefing: string;
  facts: DayFacts;
  byAi: boolean;
  createdAt: number;
  sentAt: number | null;
}

export async function buildDigest(db: DB, ai: AiClient | null, opts: { now?: Date; aboutMe?: string; waitDays?: number } = {}): Promise<{ digest: Digest; aiError?: string }> {
  const now = opts.now ?? new Date();
  const facts = dayFacts(db, now, opts.waitDays);
  const text = factsText(facts);
  let briefing = text;
  let byAi = false;
  let aiError: string | undefined;
  if (ai) {
    try {
      briefing = await aiBriefing(ai, text, { aboutMe: opts.aboutMe });
      byAi = true;
    } catch (err) {
      aiError = (err as Error).message;
    }
  }
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO digests (date, created_at, briefing, data, by_ai) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (date) DO UPDATE SET created_at = excluded.created_at, briefing = excluded.briefing, data = excluded.data, by_ai = excluded.by_ai`,
  ).run(facts.date, createdAt, briefing, JSON.stringify(facts), byAi ? 1 : 0);
  return { digest: { date: facts.date, briefing, facts, byAi, createdAt, sentAt: null }, aiError };
}

export function latestDigest(db: DB): Digest | null {
  const row = db.prepare("SELECT * FROM digests ORDER BY date DESC LIMIT 1").get() as
    | { date: string; briefing: string; data: string; by_ai: number; created_at: number; sent_at: number | null }
    | undefined;
  if (!row) return null;
  return { date: row.date, briefing: row.briefing, facts: JSON.parse(row.data), byAi: !!row.by_ai, createdAt: row.created_at, sentAt: row.sent_at };
}

/** A push-sized version: the briefing, then the day's list so it can be read at a glance. */
export function digestPush(d: Digest): { title: string; message: string } {
  const f = d.facts;
  const bits = [];
  if (f.overdue.length) bits.push(`${f.overdue.length} overdue`);
  bits.push(f.today.length ? `${f.today.length} today` : "nothing due");
  if (f.emails.length) bits.push(`${f.emails.length} email${f.emails.length === 1 ? "" : "s"}`);
  if (f.schedule?.length) bits.push(`${f.schedule.length} on the calendar`);
  const list = [
    ...(f.schedule ?? []).filter((e) => e.time).map((e) => `• ${friendlyTime(e.time!)} ${e.title}`),
    ...f.overdue.map((t) => `• ${t.title} (late)`),
    ...f.today.map((t) => `• ${t.title}${t.time ? ` ${friendlyTime(t.time)}` : ""}`),
  ];
  const message = d.byAi && list.length ? `${d.briefing}\n\n${list.slice(0, 12).join("\n")}` : d.briefing;
  return { title: `Your day: ${bits.join(", ")}`, message };
}
