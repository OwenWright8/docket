// Task rows in and out, and the done / skip / undo moves.
import { type DB, type TaskRow, tx } from "./db.ts";
import type { ParsedTask } from "./parse.ts";
import { type Recurrence, describe, firstDue, nextDue, normalizeRecurrence } from "./recurrence.ts";
import { addDays, isHm, isYmd, todayYmd } from "./time.ts";

export interface PublicTask {
  id: number;
  title: string;
  notes: string | null;
  list: string | null;
  dueDate: string | null;
  dueTime: string | null;
  recurrence: Recurrence | null;
  repeatText: string | null;
  priority: number;
  source: string;
  emailId: number | null;
  doneAt: number | null;
  lastDone: number | null;
  /** Re-push every this many minutes until it's done (0: remind once). */
  nagMinutes: number;
  snoozedUntil: number | null;
  createdAt: number;
}

export function parseRecurrence(row: Pick<TaskRow, "recurrence">): Recurrence | null {
  if (!row.recurrence) return null;
  try {
    return normalizeRecurrence(JSON.parse(row.recurrence));
  } catch {
    return null;
  }
}

export function publicTask(row: TaskRow, lastDone?: number | null): PublicTask {
  const rec = parseRecurrence(row);
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    list: row.list,
    dueDate: row.due_date,
    dueTime: row.due_time,
    recurrence: rec,
    repeatText: rec ? describe(rec) : null,
    priority: row.priority,
    source: row.source,
    emailId: row.email_id,
    doneAt: row.done_at,
    lastDone: lastDone ?? null,
    nagMinutes: row.nag_minutes ?? 0,
    snoozedUntil: row.snoozed_until && row.snoozed_until > Date.now() ? row.snoozed_until : null,
    createdAt: row.created_at,
  };
}

export function getTask(db: DB, id: number): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
}

export function lastDoneMap(db: DB): Map<number, number> {
  const rows = db.prepare("SELECT task_id, max(at) AS at FROM task_log WHERE action = 'done' GROUP BY task_id").all() as { task_id: number; at: number }[];
  return new Map(rows.map((r) => [r.task_id, r.at]));
}

export interface TaskInput {
  title?: unknown;
  notes?: unknown;
  list?: unknown;
  dueDate?: unknown;
  dueTime?: unknown;
  recurrence?: unknown;
  priority?: unknown;
  nagMinutes?: unknown;
}

/** Checks a create/update body. `partial` keeps fields that weren't sent. */
type CleanRow = Pick<TaskRow, "title" | "notes" | "list" | "due_date" | "due_time" | "recurrence" | "priority" | "nag_minutes">;

export const NAG_CHOICES = [0, 10, 15, 30, 60, 120];

export function cleanInput(body: TaskInput, existing?: TaskRow): { ok: true; row: CleanRow } | { ok: false; error: string } {
  const has = (k: keyof TaskInput) => body[k] !== undefined;
  const title = has("title") ? String(body.title ?? "").trim().slice(0, 200) : (existing?.title ?? "");
  if (!title) return { ok: false, error: "Give the task a name" };
  const notes = has("notes") ? (String(body.notes ?? "").trim().slice(0, 4000) || null) : (existing?.notes ?? null);
  const list = has("list") ? (String(body.list ?? "").trim().slice(0, 40) || null) : (existing?.list ?? null);
  let dueDate = has("dueDate") ? (body.dueDate === null || body.dueDate === "" ? null : String(body.dueDate)) : (existing?.due_date ?? null);
  if (dueDate !== null && !isYmd(dueDate)) return { ok: false, error: "That date doesn't look right" };
  let dueTime = has("dueTime") ? (body.dueTime === null || body.dueTime === "" ? null : String(body.dueTime)) : (existing?.due_time ?? null);
  if (dueTime !== null && !isHm(dueTime)) return { ok: false, error: "That time doesn't look right" };
  let rec: Recurrence | null;
  if (has("recurrence")) {
    rec = body.recurrence === null ? null : normalizeRecurrence(body.recurrence, dueDate);
    if (body.recurrence !== null && !rec) return { ok: false, error: "That repeat doesn't look right" };
  } else rec = existing ? parseRecurrence(existing) : null;
  if (rec && !dueDate) dueDate = firstDue(rec, todayYmd());
  if (rec && rec.weekdays?.length && dueDate) dueDate = firstDue(rec, dueDate);
  if (!dueDate) dueTime = null;
  const p = has("priority") ? Number(body.priority) : (existing?.priority ?? 1);
  const priority = p === 0 || p === 2 ? p : 1;
  const n = has("nagMinutes") ? Number(body.nagMinutes) : (existing?.nag_minutes ?? 0);
  const nag = NAG_CHOICES.includes(n) ? n : 0;
  return { ok: true, row: { title, notes, list, due_date: dueDate, due_time: dueTime, recurrence: rec ? JSON.stringify(rec) : null, priority, nag_minutes: nag } };
}

export function createTask(db: DB, input: TaskInput, meta: { source?: string; emailId?: number | null } = {}): TaskRow | { error: string } {
  const c = cleanInput(input);
  if (!c.ok) return { error: c.error };
  const now = Date.now();
  const r = c.row;
  const res = db
    .prepare(
      `INSERT INTO tasks (title, notes, list, due_date, due_time, recurrence, priority, nag_minutes, source, email_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(r.title, r.notes, r.list, r.due_date, r.due_time, r.recurrence, r.priority, r.nag_minutes, meta.source ?? "manual", meta.emailId ?? null, now, now);
  return getTask(db, Number(res.lastInsertRowid))!;
}

export function parsedToInput(p: ParsedTask): TaskInput {
  return { title: p.title, notes: p.notes, list: p.list, dueDate: p.dueDate, dueTime: p.dueTime, recurrence: p.recurrence, priority: p.priority };
}

export function updateTask(db: DB, id: number, input: TaskInput): TaskRow | { error: string } | null {
  const existing = getTask(db, id);
  if (!existing) return null;
  const c = cleanInput(input, existing);
  if (!c.ok) return { error: c.error };
  const r = c.row;
  const moved = r.due_date !== existing.due_date || r.due_time !== existing.due_time;
  db.prepare(
    `UPDATE tasks SET title = ?, notes = ?, list = ?, due_date = ?, due_time = ?, recurrence = ?, priority = ?, nag_minutes = ?, updated_at = ? WHERE id = ?`,
  ).run(r.title, r.notes, r.list, r.due_date, r.due_time, r.recurrence, r.priority, r.nag_minutes, Date.now(), id);
  if (moved) resetPushes(db, id);
  return getTask(db, id)!;
}

/**
 * Done (or skipped). A repeating task moves to its next date and stays open;
 * a one-off is marked done. Returns the log entry, for undo.
 */
export function completeTask(db: DB, id: number, action: "done" | "skipped", now = new Date()): { task: TaskRow; logId: number } | null {
  return tx(db, () => {
    const t = getTask(db, id);
    if (!t) return null;
    const rec = parseRecurrence(t);
    if (!rec && action === "skipped") return null;
    if (!rec && t.done_at) return null;
    const today = todayYmd(now);
    const next = rec ? nextDue(rec, t.due_date, today) : null;
    const log = db
      .prepare("INSERT INTO task_log (task_id, at, on_date, action, prev_due, next_due) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, now.getTime(), today, action, t.due_date, next);
    if (rec) db.prepare("UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?").run(next, now.getTime(), id);
    else db.prepare("UPDATE tasks SET done_at = ?, updated_at = ? WHERE id = ?").run(now.getTime(), now.getTime(), id);
    resetPushes(db, id);
    return { task: getTask(db, id)!, logId: Number(log.lastInsertRowid) };
  });
}

/** Puts a task back where it was before a done/skip. Only the latest entry for a task can be undone. */
export function undoLog(db: DB, logId: number): TaskRow | null {
  return tx(db, () => {
    const entry = db.prepare("SELECT * FROM task_log WHERE id = ?").get(logId) as
      | { id: number; task_id: number; prev_due: string | null; next_due: string | null }
      | undefined;
    if (!entry) return null;
    const latest = db.prepare("SELECT id FROM task_log WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(entry.task_id) as { id: number };
    if (latest.id !== entry.id) return null;
    const t = getTask(db, entry.task_id);
    if (!t) return null;
    // The reminder for the restored date isn't sent again (it already went out).
    if (parseRecurrence(t)) db.prepare("UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?").run(entry.prev_due, Date.now(), t.id);
    else db.prepare("UPDATE tasks SET done_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), t.id);
    db.prepare("DELETE FROM task_log WHERE id = ?").run(entry.id);
    return getTask(db, t.id)!;
  });
}

export function openTasks(db: DB): TaskRow[] {
  return db.prepare("SELECT * FROM tasks WHERE done_at IS NULL ORDER BY due_date IS NULL, due_date, due_time IS NULL, due_time, priority DESC, id").all() as unknown as TaskRow[];
}

export function knownLists(db: DB): string[] {
  return (db.prepare("SELECT DISTINCT list FROM tasks WHERE list IS NOT NULL ORDER BY list COLLATE NOCASE").all() as { list: string }[]).map((r) => r.list);
}

/** A new due date (or done): the reminder, nags and snooze start over. */
export function resetPushes(db: DB, id: number) {
  db.prepare("UPDATE tasks SET notified_for = NULL, nag_count = 0, last_pushed_at = NULL, snoozed_until = NULL WHERE id = ?").run(id);
}

/** Push this task again in `minutes` (and hold off any nag until then). */
export function snoozeTask(db: DB, id: number, minutes: number, now = Date.now()): TaskRow | null {
  const t = getTask(db, id);
  if (!t || t.done_at) return null;
  const until = now + minutes * 60_000;
  db.prepare("UPDATE tasks SET snoozed_until = ?, notified_for = coalesce(notified_for, CASE WHEN due_time IS NOT NULL THEN due_date || ' ' || due_time END) WHERE id = ?").run(until, id);
  return getTask(db, id)!;
}

/** Moves a task to tomorrow, keeping its time. A repeating task's schedule carries on from there. */
export function moveToTomorrow(db: DB, id: number, now = new Date()): TaskRow | null {
  const t = getTask(db, id);
  if (!t || t.done_at) return null;
  const tomorrow = addDays(todayYmd(now), 1);
  db.prepare("UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?").run(tomorrow, now.getTime(), id);
  resetPushes(db, id);
  return getTask(db, id)!;
}
