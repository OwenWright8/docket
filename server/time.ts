// Calendar dates are "YYYY-MM-DD" strings and times "HH:mm", both in the
// server's own time zone (set TZ). Keeping dates as strings avoids every
// midnight/DST surprise that comes with storing them as instants.

export const pad = (n: number) => String(n).padStart(2, "0");

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function hm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function todayYmd(now: Date = new Date()): string {
  return ymd(now);
}

export function isYmd(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseYmd(s);
  return ymd(d) === s;
}

export function isHm(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** Adds months, landing on `day` (default: the same day) clamped to the month's length. */
export function addMonths(s: string, n: number, day?: number): string {
  const d = parseYmd(s);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day ?? d.getDate(), last));
  return ymd(target);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(s: string): number {
  return parseYmd(s).getDay();
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** The Sunday on or before the date. */
export function startOfWeek(s: string): string {
  return addDays(s, -weekday(s));
}

export function localDateTime(date: string, time: string): Date {
  const d = parseYmd(date);
  const [h, m] = time.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed Nov 12" */
export function shortDate(s: string): string {
  const d = parseYmd(s);
  return `${WEEKDAY_SHORT[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "5:30 PM" */
export function friendlyTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${pad(m)} ${suffix}`;
}

/** "today", "tomorrow", "yesterday", "Wed Nov 12" */
export function relativeDay(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return shortDate(date);
}
