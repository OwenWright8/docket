// The ask box: "when did I last feed the gecko?", "what's due this week?",
// "did the vet ever get back to me?". The local model answers from a plain
// list of facts gathered here, and nothing else.
import type { DB, EmailRow, SentRow, TaskRow } from "./db.ts";
import { parseRecurrence } from "./tasks.ts";
import { describe } from "./recurrence.ts";
import { itemsBetween } from "./sources.ts";
import { addDays, friendlyTime, shortDate, todayYmd, ymd } from "./time.ts";

const MAX_CHARS = 14_000;

export function askFacts(db: DB, now = new Date()): string {
  const today = todayYmd(now);
  const when = (date: string | null, time: string | null) => (date ? `${shortDate(date)}${time ? ` ${friendlyTime(time)}` : ""}` : "no date");
  const out: string[] = [`Now: ${shortDate(today)} ${now.toTimeString().slice(0, 5)}`];

  const open = db.prepare("SELECT * FROM tasks WHERE done_at IS NULL ORDER BY due_date IS NULL, due_date, due_time").all() as unknown as TaskRow[];
  out.push("", "OPEN TASKS (title | due | repeat | list)");
  for (const t of open) {
    const rec = parseRecurrence(t);
    out.push(`- ${t.title} | ${when(t.due_date, t.due_time)}${t.due_date && t.due_date < today ? " (overdue)" : ""} | ${rec ? describe(rec) : "once"} | ${t.list ?? "-"}`);
  }

  const log = db
    .prepare(
      `SELECT l.on_date, l.action, l.at, t.title FROM task_log l JOIN tasks t ON t.id = l.task_id
       WHERE l.at > ? ORDER BY l.at DESC LIMIT 400`,
    )
    .all(now.getTime() - 90 * 86_400_000) as { on_date: string; action: string; at: number; title: string }[];
  out.push("", "DONE / SKIPPED, LAST 90 DAYS (newest first)");
  for (const l of log) out.push(`- ${shortDate(l.on_date)} ${new Date(l.at).toTimeString().slice(0, 5)}: ${l.action} "${l.title}"`);

  const finished = db.prepare("SELECT title, done_at FROM tasks WHERE done_at > ? ORDER BY done_at DESC LIMIT 60").all(now.getTime() - 90 * 86_400_000) as {
    title: string;
    done_at: number;
  }[];
  if (finished.length) {
    out.push("", "ONE-OFF TASKS FINISHED");
    for (const f of finished) out.push(`- ${shortDate(ymd(new Date(f.done_at)))}: "${f.title}"`);
  }

  const items = itemsBetween(db, addDays(today, -7), addDays(today, 30));
  if (items.length) {
    out.push("", "CALENDAR AND SCHOOL (kind | when | title | course or calendar | where)");
    for (const i of items) out.push(`- ${i.kind} | ${when(i.date, i.time)} | ${i.title} | ${i.context ?? "-"} | ${i.location ?? "-"}`);
  }

  const emails = db
    .prepare("SELECT * FROM emails WHERE category IN ('important','action','fyi') AND received_at > ? ORDER BY received_at DESC LIMIT 60")
    .all(now.getTime() - 30 * 86_400_000) as unknown as EmailRow[];
  if (emails.length) {
    out.push("", "EMAIL RECEIVED, LAST 30 DAYS (when | from | subject | summary | dealt with?)");
    for (const e of emails) {
      out.push(`- ${shortDate(ymd(new Date(e.received_at)))} | ${e.from_name || e.from_addr} | ${e.subject} | ${e.summary ?? e.snippet ?? ""} | ${e.handled ? "yes" : "no"}`);
    }
  }

  const sent = db.prepare("SELECT * FROM sent_mail WHERE state IN ('waiting','answered') AND sent_at > ? ORDER BY sent_at DESC LIMIT 40").all(now.getTime() - 30 * 86_400_000) as unknown as SentRow[];
  if (sent.length) {
    out.push("", "EMAIL YOU SENT THAT ASKED FOR SOMETHING (sent | to | subject | answered?)");
    for (const s of sent) {
      out.push(`- ${shortDate(ymd(new Date(s.sent_at)))} | ${s.to_name || s.to_addr} | ${s.subject} | ${s.state === "answered" && s.answered_at ? `answered ${shortDate(ymd(new Date(s.answered_at)))}` : "no reply yet"}`);
    }
  }

  let text = out.join("\n");
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n(more not shown)";
  return text;
}
