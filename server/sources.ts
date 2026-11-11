// Things on your schedule that live somewhere else, read every 30 minutes:
//   - calendars, from their private iCalendar (.ics) link: Google, iCloud,
//     Outlook, Proton, Fastmail all have one;
//   - carrel, signed in as you through its own API: assignments, readings,
//     exams and quizzes with their due dates.
// Only a window is kept (a week back, two months ahead), replaced on each read.
// Nothing is ever written back.
import ICAL from "ical.js";
import { type DB, type ExternalItem, type SourceRow, tx } from "./db.ts";
import { addDays, hm, todayYmd, ymd } from "./time.ts";

export type Item = Omit<ExternalItem, "id" | "source_id">;

const PAST_DAYS = 7;
const FUTURE_DAYS = 60;
const MAX_ICS_BYTES = 8 * 1024 * 1024;

export function httpsUrl(url: string): string {
  return url.trim().replace(/^webcals?:\/\//i, "https://");
}

async function get(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.name === "TimeoutError") throw new Error("It didn't answer in time");
    const code = e.cause?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw new Error("That address doesn't resolve from the Docket server");
    if (code === "ECONNREFUSED") throw new Error("Nothing answered at that address");
    throw new Error(`Couldn't connect: ${e.message}`);
  }
  return res;
}

// --- iCalendar ---------------------------------------------------------------------

export async function fetchIcs(url: string): Promise<string> {
  const res = await get(httpsUrl(url), { headers: { Accept: "text/calendar, */*" } });
  if (res.status === 401 || res.status === 403) throw new Error("The calendar refused (is the link still private and valid?)");
  if (res.status === 404) throw new Error("No calendar at that link (it may have been reset)");
  if (!res.ok) throw new Error(`The calendar server answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_ICS_BYTES) throw new Error("That calendar is too big");
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That link isn't an iCalendar (.ics) feed");
  return text;
}

/** Events from an .ics file in the window around `now`, as local dates and times. */
export function parseIcs(text: string, opts: { now?: Date; calendarName?: string } = {}): Item[] {
  const now = opts.now ?? new Date();
  const today = todayYmd(now);
  const from = addDays(today, -PAST_DAYS);
  const to = addDays(today, FUTURE_DAYS);
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const vtz of comp.getAllSubcomponents("vtimezone")) {
    try {
      ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
    } catch {
      // A broken time zone block: its events are read as local time.
    }
  }
  const events = comp.getAllSubcomponents("vevent").map((v) => new ICAL.Event(v));
  // Moved or edited single occurrences of a repeating event replace that occurrence.
  const masters = new Map<string, ICAL.Event>();
  for (const e of events) if (!e.isRecurrenceException()) masters.set(e.uid, e);
  for (const e of events) if (e.isRecurrenceException()) masters.get(e.uid)?.relateException(e);

  const out: Item[] = [];
  const add = (e: ICAL.Event, start: ICAL.Time, end: ICAL.Time | null, key: string) => {
    if (String(e.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    const allDay = start.isDate;
    let date: string, time: string | null, endDate: string | null, endTime: string | null;
    if (allDay) {
      date = `${start.year}-${pad(start.month)}-${pad(start.day)}`;
      // DTEND of an all-day event is the day after it ends.
      endDate = end ? addDays(`${end.year}-${pad(end.month)}-${pad(end.day)}`, -1) : null;
      if (endDate && endDate <= date) endDate = null;
      time = endTime = null;
    } else {
      const s = start.toJSDate();
      date = ymd(s);
      time = hm(s);
      const e2 = end?.toJSDate();
      endDate = e2 && ymd(e2) !== date ? ymd(e2) : null;
      endTime = e2 ? hm(e2) : null;
    }
    if ((endDate ?? date) < from || date > to) return;
    out.push({
      ext_id: key,
      kind: "event",
      title: (e.summary || "(no title)").trim().slice(0, 200),
      date,
      end_date: endDate,
      time,
      end_time: endTime,
      location: e.location ? String(e.location).trim().slice(0, 200) || null : null,
      context: opts.calendarName ?? null,
      url: null,
    });
  };

  const windowEnd = ICAL.Time.fromDateString(to).adjust(1, 0, 0, 0) ?? null;
  void windowEnd;
  const stop = ICAL.Time.fromDateString(addDays(to, 1));
  const begin = ICAL.Time.fromDateString(addDays(from, -1));
  for (const e of masters.values()) {
    if (!e.startDate) continue;
    if (!e.isRecurring()) {
      add(e, e.startDate, e.endDate, e.uid);
      continue;
    }
    const it = e.iterator();
    let next: ICAL.Time | null;
    let n = 0;
    while ((next = it.next()) && n++ < 2000) {
      if (next.compare(stop) > 0) break;
      if (next.compare(begin) < 0) continue;
      const d = e.getOccurrenceDetails(next);
      add(d.item, d.startDate, d.endDate, `${e.uid}@${next.toString()}`);
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

// --- carrel ---------------------------------------------------------------------------

interface CarrelCourse {
  short_code?: string | null;
  name?: string | null;
  is_archived?: boolean | null;
}
const course = (c: CarrelCourse | CarrelCourse[] | null | undefined): CarrelCourse | null => (Array.isArray(c) ? (c[0] ?? null) : (c ?? null));

/** Signs in to carrel as you and reads what's due. Throws with a plain-English reason. */
export async function fetchCarrel(src: Pick<SourceRow, "url" | "username" | "password">, opts: { now?: Date } = {}): Promise<Item[]> {
  const root = src.url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(root)) throw new Error("carrel's address should start with http:// or https://");
  // carrel hands its public API key to the browser in /env.js; Docket reads it the same way.
  const envRes = await get(`${root}/env.js`);
  const env = envRes.ok ? await envRes.text() : "";
  const anon = env.match(/VITE_SUPABASE_PUBLISHABLE_KEY:\s*"([^"]+)"/)?.[1];
  if (!anon) throw new Error("That doesn't look like carrel (no /env.js). Use the address you open carrel at.");

  const login = await get(`${root}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: src.username ?? "", password: src.password ?? "" }),
  });
  const auth = (await login.json().catch(() => ({}))) as { access_token?: string; error_description?: string; msg?: string };
  if (!login.ok || !auth.access_token) {
    if (login.status === 400 || login.status === 401) throw new Error("carrel didn't accept that email and password");
    throw new Error(`carrel's sign-in answered ${login.status}${auth.error_description || auth.msg ? `: ${auth.error_description || auth.msg}` : ""}`);
  }
  const headers = { apikey: anon, Authorization: `Bearer ${auth.access_token}` };

  const now = opts.now ?? new Date();
  const today = todayYmd(now);
  const fromDate = addDays(today, -14);
  const toDate = addDays(today, FUTURE_DAYS);
  const fromIso = new Date(`${fromDate}T00:00:00`).toISOString();
  const toIso = new Date(`${toDate}T23:59:59`).toISOString();

  const rest = async <T,>(path: string): Promise<T[] | null> => {
    const r = await get(`${root}/rest/v1/${path}`, { headers });
    if (r.status === 404 || r.status === 400) return null; // an older carrel without this table or column
    if (!r.ok) throw new Error(`carrel's API answered ${r.status}`);
    return (await r.json()) as T[];
  };
  const link = `${root}/`;
  const out: Item[] = [];
  const at = (iso: string) => {
    const d = new Date(iso);
    return { date: ymd(d), time: hm(d) };
  };

  const tasks = await rest<{ id: string; title: string; due_at: string | null; status: string; type: string; course: CarrelCourse | CarrelCourse[] | null }>(
    `tasks?select=id,title,due_at,status,type,course:courses(short_code,name,is_archived)&due_at=gte.${fromIso}&due_at=lte.${toIso}&status=not.in.(completed,archived,done)`,
  );
  for (const t of tasks ?? []) {
    const c = course(t.course);
    if (!t.due_at || c?.is_archived) continue;
    const { date, time } = at(t.due_at);
    out.push({ ext_id: `task:${t.id}`, kind: "assignment", title: t.title, date, end_date: null, time: time === "23:59" ? null : time, end_time: null, location: null, context: c?.short_code || c?.name || null, url: link });
  }

  const readings = await rest<{ id: string; title: string; pages: string | null; due_date: string | null; course: CarrelCourse | CarrelCourse[] | null }>(
    `readings?select=id,title,pages,due_date,status,course:courses(short_code,name,is_archived)&due_date=gte.${fromDate}&due_date=lte.${toDate}&status=neq.done`,
  );
  for (const r of readings ?? []) {
    const c = course(r.course);
    if (!r.due_date || c?.is_archived) continue;
    out.push({ ext_id: `reading:${r.id}`, kind: "reading", title: `Read ${r.title}${r.pages ? ` (pp. ${r.pages})` : ""}`, date: r.due_date, end_date: null, time: null, end_time: null, location: null, context: c?.short_code || c?.name || null, url: link });
  }

  for (const [table, field, kind] of [
    ["exams", "exam_at", "exam"],
    ["quizzes", "quiz_at", "quiz"],
  ] as const) {
    const rows = await rest<Record<string, unknown> & { id: string; title: string; course: CarrelCourse | CarrelCourse[] | null }>(
      `${table}?select=id,title,${field},course:courses(short_code,name,is_archived)&${field}=gte.${fromIso}&${field}=lte.${toIso}`,
    );
    for (const r of rows ?? []) {
      const c = course(r.course);
      const when = r[field];
      if (typeof when !== "string" || c?.is_archived) continue;
      const { date, time } = at(when);
      out.push({ ext_id: `${kind}:${r.id}`, kind, title: r.title, date, end_date: null, time, end_time: null, location: null, context: c?.short_code || c?.name || null, url: link });
    }
  }
  return out;
}

// --- Storing -------------------------------------------------------------------------

export async function readSource(src: SourceRow, now = new Date()): Promise<Item[]> {
  if (src.kind === "carrel") return fetchCarrel(src, { now });
  return parseIcs(await fetchIcs(src.url), { now, calendarName: src.name });
}

export function storeItems(db: DB, sourceId: number, items: Item[]) {
  tx(db, () => {
    db.prepare("DELETE FROM external_items WHERE source_id = ?").run(sourceId);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO external_items (source_id, ext_id, kind, title, date, end_date, time, end_time, location, context, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const i of items) ins.run(sourceId, i.ext_id, i.kind, i.title, i.date, i.end_date, i.time, i.end_time, i.location, i.context, i.url);
  });
}

/** Items on a day (events that span it included), timed ones in order. */
export function itemsOn(db: DB, date: string): ExternalItem[] {
  return db
    .prepare(
      `SELECT e.* FROM external_items e JOIN sources s ON s.id = e.source_id
       WHERE s.enabled = 1 AND e.date <= ? AND coalesce(e.end_date, e.date) >= ?
       ORDER BY e.time IS NOT NULL, e.time, e.title`,
    )
    .all(date, date) as unknown as ExternalItem[];
}

export function itemsBetween(db: DB, from: string, to: string, kinds?: string[]): ExternalItem[] {
  const rows = db
    .prepare(
      `SELECT e.* FROM external_items e JOIN sources s ON s.id = e.source_id
       WHERE s.enabled = 1 AND e.date >= ? AND e.date <= ? ORDER BY e.date, e.time IS NULL, e.time, e.title`,
    )
    .all(from, to) as unknown as ExternalItem[];
  return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
}

/** carrel work that's past due and still not done there. */
export function overdueSchool(db: DB, today: string): ExternalItem[] {
  return db
    .prepare(
      `SELECT e.* FROM external_items e JOIN sources s ON s.id = e.source_id
       WHERE s.enabled = 1 AND e.kind IN ('assignment','reading') AND e.date < ? ORDER BY e.date`,
    )
    .all(today) as unknown as ExternalItem[];
}
