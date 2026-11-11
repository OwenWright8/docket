// Repeating tasks. A repeating task is one row whose due date moves forward
// each time it's done (or skipped); every completion is kept in history.
//
// `from` decides where the next date is counted from:
//   "done" — from the day you actually did it. Feeding the frogs a day late
//            means the next feeding is two days after that, not tomorrow.
//   "due"  — from the schedule. Bins go out every Tuesday however late you
//            were last week.
import { addDays, addMonths, daysBetween, parseYmd, startOfWeek, weekday, WEEKDAY_SHORT } from "./time.ts";

export type Unit = "day" | "week" | "month" | "year";

export interface Recurrence {
  every: number;
  unit: Unit;
  /** Weekly only: which days (0 = Sunday). */
  weekdays?: number[];
  /** Monthly and yearly: the day of the month to land on (so Jan 31 → Feb 28 → Mar 31). */
  day?: number;
  /** Yearly only: the month (1-12) to land on. */
  month?: number;
  from: "due" | "done";
}

const UNITS: Unit[] = ["day", "week", "month", "year"];

/** A clean Recurrence from untrusted input (API body or the AI), or null. */
export function normalizeRecurrence(v: unknown, due?: string | null): Recurrence | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const unit = UNITS.includes(o.unit as Unit) ? (o.unit as Unit) : null;
  const every = Math.round(Number(o.every));
  if (!unit || !Number.isFinite(every) || every < 1 || every > 365) return null;
  const rec: Recurrence = { every, unit, from: o.from === "done" ? "done" : o.from === "due" ? "due" : defaultFrom(unit, o.weekdays) };
  if (unit === "week" && Array.isArray(o.weekdays)) {
    const days = [...new Set(o.weekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    if (days.length) rec.weekdays = days;
  }
  if (rec.weekdays) rec.from = "due"; // "every Mon and Thu" is a schedule by nature
  if (unit === "month" || unit === "year") {
    const day = Math.round(Number(o.day));
    rec.day = day >= 1 && day <= 31 ? day : due ? parseYmd(due).getDate() : undefined;
    if (rec.day === undefined) delete rec.day;
  }
  if (unit === "year") {
    const month = Math.round(Number(o.month));
    rec.month = month >= 1 && month <= 12 ? month : due ? parseYmd(due).getMonth() + 1 : undefined;
    if (rec.month === undefined) delete rec.month;
  }
  return rec;
}

/**
 * Chores counted in days ("every other day") restart from when they're done;
 * anything on a calendar (weekdays, weeks, months, years) keeps its schedule.
 */
export function defaultFrom(unit: Unit, weekdays?: unknown): "due" | "done" {
  return unit === "day" && !(Array.isArray(weekdays) && weekdays.length) ? "done" : "due";
}

/** One step forward from `from`. Weekly-with-days uses `anchor` to count "every other week". */
function advance(rec: Recurrence, from: string, anchor: string): string {
  if (rec.unit === "week" && rec.weekdays?.length) {
    let d = addDays(from, 1);
    for (let i = 0; i < 7 * (rec.every + 1); i++, d = addDays(d, 1)) {
      if (!rec.weekdays.includes(weekday(d))) continue;
      const weeks = Math.round(daysBetween(startOfWeek(anchor), startOfWeek(d)) / 7);
      if (weeks % rec.every === 0) return d;
    }
    return d;
  }
  switch (rec.unit) {
    case "day":
      return addDays(from, rec.every);
    case "week":
      return addDays(from, 7 * rec.every);
    case "month":
      return addMonths(from, rec.every, rec.day);
    case "year":
      return addMonths(from, 12 * rec.every, rec.day);
  }
}

/** The next due date after the task (due `due`) was done or skipped on `doneOn`. */
export function nextDue(rec: Recurrence, due: string | null, doneOn: string): string {
  if (rec.from === "done" || !due) return advance(rec, doneOn, doneOn);
  let next = advance(rec, due, due);
  for (let guard = 0; next <= doneOn && guard < 5000; guard++) next = advance(rec, next, due);
  return next;
}

/** The first date on or after `start` that fits the schedule (e.g. the next Monday). */
export function firstDue(rec: Recurrence, start: string): string {
  if (rec.unit === "week" && rec.weekdays?.length) {
    let d = start;
    for (let i = 0; i < 7; i++, d = addDays(d, 1)) if (rec.weekdays.includes(weekday(d))) return d;
  }
  if ((rec.unit === "month" || rec.unit === "year") && rec.day) {
    const s = parseYmd(start);
    let candidate = addMonths(start, 0, rec.day);
    if (rec.unit === "year" && rec.month) {
      const months = (rec.month - 1 - s.getMonth() + 12) % 12;
      candidate = addMonths(start, months, rec.day);
    }
    if (candidate < start) candidate = advance(rec, candidate, candidate);
    return candidate;
  }
  return start;
}

/** "Every other day", "Every Mon, Thu", "Every 3 weeks", "Monthly on the 15th". */
export function describe(rec: Recurrence): string {
  const n = rec.every;
  const each = (singular: string, plural: string) =>
    n === 1 ? `Every ${singular}` : n === 2 ? `Every other ${singular}` : `Every ${n} ${plural}`;
  let text: string;
  if (rec.unit === "week" && rec.weekdays?.length) {
    const days = rec.weekdays;
    const key = days.join(",");
    const names =
      key === "1,2,3,4,5" ? "weekday" : key === "0,6" ? "weekend" : key === "0,1,2,3,4,5,6" ? "day" : days.map((d) => WEEKDAY_SHORT[d]).join(", ");
    text = n === 1 ? `Every ${names}` : n === 2 ? `Every other week on ${names}` : `Every ${n} weeks on ${names}`;
  } else if (rec.unit === "day") text = each("day", "days");
  else if (rec.unit === "week") text = each("week", "weeks");
  else if (rec.unit === "month") text = each("month", "months") + (rec.day ? ` on the ${ordinal(rec.day)}` : "");
  else text = each("year", "years");
  return rec.from === "done" && !(rec.unit === "week" && rec.weekdays?.length) ? `${text}, from when it's done` : text;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}
