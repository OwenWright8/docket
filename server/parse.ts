// The plain-language parser that works without any AI: "feed the gecko every
// other day", "dentist friday at 3pm", "pay rent on the 1st every month".
// The local model does this better when it's reachable; this is what runs
// when it isn't (your PC is off), and what the AI's answers are checked
// against for obvious slips.
import { type Recurrence, defaultFrom, firstDue } from "./recurrence.ts";
import { addDays, addMonths, isYmd, parseYmd, pad, todayYmd, weekday, ymd } from "./time.ts";

export interface ParsedTask {
  title: string;
  notes: string | null;
  list: string | null;
  dueDate: string | null;
  dueTime: string | null;
  recurrence: Recurrence | null;
  priority: 0 | 1 | 2;
}

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const DAY_RE = "(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
};
const NUM_RE = "(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty)";
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s.toLowerCase()] ?? 1);

const PART_OF_DAY: Record<string, string> = { morning: "09:00", afternoon: "14:00", evening: "18:00", night: "20:00", tonight: "20:00" };

/** Lists guessed from words in the title, for when the AI isn't there to do it. */
const LIST_HINTS: [string, RegExp][] = [
  ["Pets", /\b(feed|frogs?|gecko|lizard|snake|dog|puppy|cat|kitten|fish|tank|terrarium|vivarium|litter|vet|walk the|crickets?|reptile|turtle|tortoise|hamster|bird|parrot|chickens?|mist)\b/i],
  ["School", /\b(homework|assignment|exam|quiz|test|essay|paper|lab|lecture|class|chapter|reading|study|professor|syllabus|midterm|final)\b/i],
  ["Bills", /\b(pay|bill|rent|invoice|subscription|insurance|tax(es)?|utilities|mortgage|loan)\b/i],
  ["Health", /\b(pills?|meds?|medication|vitamins?|doctor|dentist|appointment|prescription|refill|workout|gym)\b/i],
  ["Home", /\b(clean|laundry|dishes|trash|bins?|garbage|recycling|vacuum|mow|water the|plants?|groceries|filter|sheets)\b/i],
];

export function guessList(title: string, known: string[] = []): string | null {
  for (const name of known) {
    if (new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(title)) return name;
  }
  for (const [list, re] of LIST_HINTS) if (re.test(title)) return known.find((k) => k.toLowerCase() === list.toLowerCase()) ?? list;
  return null;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseQuickAdd(text: string, opts: { now?: Date; lists?: string[] } = {}): ParsedTask[] {
  const now = opts.now ?? new Date();
  const out: ParsedTask[] = [];
  for (const line of text.split(/\n|;|\.\s+(?=[A-Z])/).map((l) => l.trim()).filter(Boolean)) {
    // "I feed the frogs every other day and I feed the gecko every other day"
    // is two tasks: split on "and" when every half has a schedule of its own.
    const halves = line.split(new RegExp(`\\s*,?\\s+(?:and|&)\\s+(?:also\\s+)?(?!${DAY_RE}s?\\b)(?=\\S)`, "i"));
    const parsedHalves = halves.length > 1 ? halves.map((h) => parseOne(h, now, opts.lists)) : null;
    if (parsedHalves && parsedHalves.every((p) => p.recurrence || p.dueDate || p.dueTime)) out.push(...parsedHalves);
    else out.push(parseOne(line, now, opts.lists));
  }
  return out.filter((t) => t.title);
}

export function parseOne(input: string, now: Date = new Date(), lists: string[] = []): ParsedTask {
  const today = todayYmd(now);
  let s = ` ${input.trim()} `;
  let recurrence: Recurrence | null = null;
  let dueDate: string | null = null;
  let dueTime: string | null = null;
  let priority: 0 | 1 | 2 = 1;

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = s.match(re);
    if (!m) return false;
    fn(m);
    s = s.replace(m[0], " ");
    return true;
  };
  const rec = (every: number, unit: Recurrence["unit"], extra: Partial<Recurrence> = {}) => {
    if (!recurrence) recurrence = { every, unit, from: defaultFrom(unit, extra.weekdays), ...extra };
  };

  // Priority
  take(/\s(!!+|urgent|asap|high priority|important)(?=[\s,.!]|$)/i, () => (priority = 2));
  take(/\s(low priority|whenever|someday)(?=[\s,.!]|$)/i, () => (priority = 0));

  // --- Repeats -----------------------------------------------------------------
  take(/\s(?:every|each)\s+(morning|evening|night)\b/i, (m) => {
    rec(1, "day");
    dueTime = PART_OF_DAY[m[1].toLowerCase()];
  });
  take(/\s(?:every|each)\s+other\s+day\b/i, () => rec(2, "day"));
  take(new RegExp(`\\s(?:every|each)\\s+${NUM_RE}\\s+days?\\b`, "i"), (m) => rec(toNum(m[1]), "day"));
  take(/\s(?:every\s+(?:single\s+)?day|daily|each\s+day|once\s+a\s+day|every\s+24\s+hours)\b/i, () => rec(1, "day"));
  take(/\s(?:every|on|each)\s+weekdays?\b|\s(?:monday|mon)\s*(?:-|to|through|thru)\s*(?:friday|fri)\b/i, () => rec(1, "week", { weekdays: [1, 2, 3, 4, 5] }));
  take(/\s(?:every|on|each)\s+weekends?\b/i, () => rec(1, "week", { weekdays: [0, 6] }));
  const dayList = `${DAY_RE}s?(?:\\s*(?:,|and|&|\\/|or)\\s*${DAY_RE}s?)*`;
  take(new RegExp(`\\s(?:every|each|on)\\s+(other\\s+)?(${dayList})\\b`, "i"), (m) => {
    // "on friday" alone is a date, not a repeat: only plurals or every/each repeat.
    const plural = /s\b/i.test(m[2]) && !/\b(?:tues|weds|thurs)\b/i.test(m[2]);
    if (!/^\s*(every|each)/i.test(m[0]) && !plural) {
      s = s.replace(m[0], ` @@${m[0].trim()}@@ `); // put it back for the date pass
      return;
    }
    rec(m[1] ? 2 : 1, "week", { weekdays: daysFrom(m[2]) });
  });
  s = s.replace(/@@(.+?)@@/g, "$1");
  take(new RegExp(`\\s(?:on\\s+)?((?:sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)(?:\\s*(?:,|and|&)\\s*(?:sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays))*)\\b`, "i"), (m) =>
    rec(1, "week", { weekdays: daysFrom(m[1]) }),
  );
  take(/\s(?:every|each)\s+other\s+week\b|\s(?:bi-?weekly|fortnightly)\b/i, () => rec(2, "week"));
  take(new RegExp(`\\s(?:every|each)\\s+${NUM_RE}\\s+weeks?\\b`, "i"), (m) => rec(toNum(m[1]), "week"));
  take(/\s(?:every\s+week|weekly|each\s+week|once\s+a\s+week)\b/i, () => rec(1, "week"));
  take(/\s(?:every|each)\s+other\s+month\b/i, () => rec(2, "month"));
  take(new RegExp(`\\s(?:every|each)\\s+${NUM_RE}\\s+months?\\b`, "i"), (m) => rec(toNum(m[1]), "month"));
  take(/\s(?:every\s+month|monthly|each\s+month|once\s+a\s+month)\b/i, () => rec(1, "month"));
  take(/\s(?:every\s+year|yearly|annually|each\s+year|once\s+a\s+year)\b/i, () => rec(1, "year"));

  // "on the 1st" / "the 15th" (monthly)
  take(/\s(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b(\s+of\s+(?:each|every)\s+month)?(?:\s+of\s+the\s+month)?/i, (m) => {
    const day = Number(m[1]);
    if (day < 1 || day > 31) return;
    if (m[2]) rec(1, "month");
    const r = recurrence as Recurrence | null;
    if (r && r.unit === "month") r.day = day;
    else {
      let d = addMonths(today, 0, day);
      if (d < today) d = addMonths(today, 1, day);
      dueDate = d;
    }
  });

  // --- Times -------------------------------------------------------------------
  take(/\s(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=[\s,.!]|$)/i, (m) => {
    let h = Number(m[1]) % 12;
    if (/p/i.test(m[3])) h += 12;
    const min = Number(m[2] ?? 0);
    if (h < 24 && min < 60) dueTime = `${pad(h)}:${pad(min)}`;
  });
  take(/\s(?:at\s+|@\s*)(\d{1,2}):(\d{2})\b/i, (m) => {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 24 && min < 60) dueTime = `${pad(h <= 6 && h !== 0 ? h + 12 : h)}:${pad(min)}`;
  });
  take(/\s(?:at\s+)?noon\b/i, () => (dueTime = "12:00"));
  take(/\sat\s+(\d{1,2})(?=[\s,.!]|$)/i, (m) => {
    const h = Number(m[1]);
    if (h >= 1 && h <= 12) dueTime = `${pad(h <= 6 ? h + 12 : h === 12 ? 12 : h)}:00`;
    else if (h < 24) dueTime = `${pad(h)}:00`;
  });

  // --- Dates -------------------------------------------------------------------
  take(/\s(today|tonight|this\s+(morning|afternoon|evening))\b/i, (m) => {
    dueDate = today;
    const part = (m[2] ?? (m[1].toLowerCase() === "tonight" ? "tonight" : "")).toLowerCase();
    if (part && !dueTime) dueTime = PART_OF_DAY[part];
  });
  take(/\s(?:tomorrow|tmrw|tmr)(?:\s+(morning|afternoon|evening|night))?\b/i, (m) => {
    dueDate = addDays(today, 1);
    if (m[1] && !dueTime) dueTime = PART_OF_DAY[m[1].toLowerCase()];
  });
  take(new RegExp(`\\s(?:in\\s+)${NUM_RE}\\s+(day|week|month|year)s?\\b`, "i"), (m) => {
    const n = toNum(m[1]);
    const unit = m[2].toLowerCase();
    dueDate = unit === "day" ? addDays(today, n) : unit === "week" ? addDays(today, 7 * n) : addMonths(today, unit === "month" ? n : 12 * n);
  });
  take(/\snext\s+week\b/i, () => (dueDate = addDays(today, 7 - weekday(today) + 1)));
  take(/\s(?:this\s+)?weekend\b/i, () => (dueDate = addDays(today, (6 - weekday(today) + 7) % 7)));
  take(/\s(\d{4}-\d{2}-\d{2})\b/, (m) => isYmd(m[1]) && (dueDate = m[1]));
  take(new RegExp(`\\s(?:on\\s+|by\\s+)?(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"), (m) => {
    dueDate = monthDay(MONTH_NAMES[m[1].toLowerCase()], Number(m[2]), today, m[3] ? Number(m[3]) : undefined);
  });
  take(new RegExp(`\\s(?:on\\s+|by\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b`, "i"), (m) => {
    dueDate = monthDay(MONTH_NAMES[m[2].toLowerCase()], Number(m[1]), today);
  });
  take(/\s(?:on\s+|by\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    dueDate = monthDay(Number(m[1]), Number(m[2]), today, year);
  });
  take(new RegExp(`\\s(?:on\\s+|by\\s+|this\\s+|(next)\\s+)?(${DAY_RE})\\b`, "i"), (m) => {
    const target = DAY_NAMES[m[2].toLowerCase()];
    let diff = (target - weekday(today) + 7) % 7;
    if (m[1]) diff += diff === 0 ? 7 : 7;
    dueDate = addDays(today, diff);
  });
  // A bare part of day: "call mom in the evening"
  take(/\s(?:in\s+the\s+)?(morning|afternoon|evening)\b/i, (m) => {
    if (!dueTime) dueTime = PART_OF_DAY[m[1].toLowerCase()];
  });

  if (recurrence) dueDate = firstDue(recurrence, dueDate ?? today);
  if (dueTime && !dueDate) {
    // "at 5pm" with no day: today if it's still ahead, otherwise tomorrow.
    const [h, m] = (dueTime as string).split(":").map(Number);
    dueDate = h * 60 + m > now.getHours() * 60 + now.getMinutes() ? today : addDays(today, 1);
  }

  const title = cleanTitle(s) || cleanTitle(input);
  return { title, notes: null, list: guessList(title, lists), dueDate, dueTime, recurrence, priority };
}

function daysFrom(text: string): number[] {
  const found = text.toLowerCase().match(new RegExp(DAY_RE, "gi")) ?? [];
  return [...new Set(found.map((d) => DAY_NAMES[d.toLowerCase()]).filter((n) => n !== undefined))].sort();
}

function monthDay(month: number, day: number, today: string, year?: number): string | null {
  if (!month || month > 12 || day < 1 || day > 31) return null;
  const y = year ?? parseYmd(today).getFullYear();
  let d = ymd(new Date(y, month - 1, day));
  if (!year && d < today) d = ymd(new Date(y + 1, month - 1, day));
  return d;
}

/** "I need to feed the gecko on" → "Feed the gecko" */
export function cleanTitle(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  const lead =
    /^(?:(?:please|pls|hey|ok|okay|so|also|and)\s+)*(?:remind me to|remind me|remember to|don'?t forget to|make sure (?:i|to)|i need to|i have to|i(?:'ve| have) got to|i gotta|i should|i must|i want to|i'd like to|i'll|i will|need to|have to|gotta|to|i)\s+/i;
  for (let i = 0; i < 3; i++) t = t.replace(lead, "");
  t = t
    .replace(/\s+(?:on|at|by|in|from|starting|every|each|the|and|&|,)$/i, "")
    .replace(/\s+(?:on|at|by|in|from|starting|every|each|the|and|&|,)$/i, "")
    .replace(/^[,.;:\-–\s]+|[,.;:\-–\s]+$/g, "")
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}
