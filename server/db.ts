// SQLite storage (Node's built-in node:sqlite, so nothing native to build for
// arm64). One file in the data volume holds everything: settings, tasks and
// their history, the email the app has sorted, and the daily summaries.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type DB = DatabaseSync;

// Each entry runs once, in order, inside a transaction. Append only: never
// edit a migration that has shipped.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- A to-do. Repeating tasks are one row whose due_date moves forward each
  -- time they're done; every completion is kept in task_log.
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT,
    list TEXT,
    due_date TEXT,                 -- local "YYYY-MM-DD", or null for "whenever"
    due_time TEXT,                 -- local "HH:mm"; a push goes out at this time
    recurrence TEXT,               -- JSON Recurrence, or null
    priority INTEGER NOT NULL DEFAULT 1,   -- 0 low, 1 normal, 2 high
    source TEXT NOT NULL DEFAULT 'manual', -- manual | ai | email
    email_id INTEGER,
    done_at INTEGER,               -- one-off tasks only
    notified_for TEXT,             -- "<due_date> <due_time>" already pushed
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_due ON tasks (done_at, due_date);

  -- Every time a task was done or skipped, and where its due date was before
  -- (so it can be undone).
  CREATE TABLE task_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    on_date TEXT NOT NULL,         -- the local day it was done
    action TEXT NOT NULL,          -- done | skipped
    prev_due TEXT,
    next_due TEXT
  );
  CREATE INDEX task_log_task ON task_log (task_id, at DESC);

  CREATE TABLE mail_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 993,
    secure INTEGER NOT NULL DEFAULT 1,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT 'INBOX',
    enabled INTEGER NOT NULL DEFAULT 1,
    uid_validity TEXT,
    last_uid INTEGER NOT NULL DEFAULT 0,
    last_checked_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );

  -- Email the app has looked at. Only a short excerpt is kept, never the body.
  -- category: important | action | fyi | promo | spam | ignored
  CREATE TABLE emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    message_id TEXT,
    from_name TEXT,
    from_addr TEXT,
    subject TEXT,
    snippet TEXT,
    received_at INTEGER NOT NULL,
    bulk INTEGER NOT NULL DEFAULT 0,       -- had mailing-list / bulk headers
    category TEXT NOT NULL,
    summary TEXT,
    reason TEXT,
    decided_by TEXT NOT NULL,              -- ai | rule | basic | you
    ai_pending INTEGER NOT NULL DEFAULT 0, -- sorted without the AI; retry when it's back
    pending_text TEXT,                     -- the body, kept only until the AI has read it
    suggestion TEXT,                       -- JSON { title, dueDate, dueTime } or null
    suggestion_state TEXT,                 -- pending | accepted | dismissed
    task_id INTEGER,
    handled INTEGER NOT NULL DEFAULT 0,    -- you cleared it from the inbox view
    notified INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, uid)
  );
  CREATE INDEX emails_received ON emails (received_at DESC);

  -- "Always important" / "Always ignore" for a sender address or @domain.
  CREATE TABLE sender_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL UNIQUE,          -- lower-case "a@b.com" or "@b.com"
    action TEXT NOT NULL,                  -- important | ignore
    created_at INTEGER NOT NULL
  );

  CREATE TABLE digests (
    date TEXT PRIMARY KEY,                 -- local day
    created_at INTEGER NOT NULL,
    briefing TEXT NOT NULL,
    data TEXT NOT NULL,                    -- JSON snapshot it was written from
    by_ai INTEGER NOT NULL DEFAULT 0,
    scheduled_at INTEGER,                  -- the morning run happened (pushed or not)
    sent_at INTEGER                        -- actually pushed to your phone
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,                    -- reminder | summary | mail | ai | error
    message TEXT NOT NULL
  );
  CREATE INDEX activity_at ON activity (at DESC);
  `,
  `
  -- Nag mode, snoozing, and buttons on notifications.
  ALTER TABLE tasks ADD COLUMN nag_minutes INTEGER NOT NULL DEFAULT 0;  -- 0: remind once
  ALTER TABLE tasks ADD COLUMN nag_count INTEGER NOT NULL DEFAULT 0;    -- nags sent for the current due date
  ALTER TABLE tasks ADD COLUMN last_pushed_at INTEGER;                  -- last reminder or nag
  ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER;                   -- push again at this time

  -- Threading, to notice when someone answers an email you sent.
  ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
  ALTER TABLE emails ADD COLUMN refs TEXT;                              -- space-separated Message-IDs

  ALTER TABLE mail_accounts ADD COLUMN track_replies INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE mail_accounts ADD COLUMN sent_folder TEXT;
  ALTER TABLE mail_accounts ADD COLUMN sent_uid_validity TEXT;
  ALTER TABLE mail_accounts ADD COLUMN sent_last_uid INTEGER NOT NULL DEFAULT 0;

  -- Email you sent. state: waiting (expects an answer) | answered | dismissed | none (didn't need one)
  CREATE TABLE sent_mail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    message_id TEXT,
    to_name TEXT,
    to_addr TEXT,
    subject TEXT,
    snippet TEXT,
    sent_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    decided_by TEXT NOT NULL,             -- ai | basic | you
    answered_at INTEGER,
    answer_email_id INTEGER,
    nudged INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, uid)
  );
  CREATE INDEX sent_mail_message ON sent_mail (message_id);

  -- Calendars (iCalendar links) and carrel, read on a schedule.
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                   -- ics | carrel
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    username TEXT,
    password TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_synced_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );

  -- What they hold, from a week ago to two months out; replaced on every read.
  -- kind: event | assignment | reading | exam | quiz
  CREATE TABLE external_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
    ext_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,                   -- local "YYYY-MM-DD"
    end_date TEXT,                        -- last day, for events over several days
    time TEXT,                            -- local "HH:mm"; null for all-day / date-only
    end_time TEXT,
    location TEXT,
    context TEXT,                         -- course code, calendar name
    url TEXT,
    UNIQUE (source_id, ext_id)
  );
  CREATE INDEX external_items_date ON external_items (date);

  -- Keys for the read-only stats endpoint (Homepage's Custom API widget).
  -- Only a hash is stored: the key is shown once, when it's created.
  CREATE TABLE widget_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  `,
  `
  -- Accounts that sign in with Microsoft (OAuth) instead of a password.
  ALTER TABLE mail_accounts ADD COLUMN auth TEXT NOT NULL DEFAULT 'password';  -- password | microsoft
  ALTER TABLE mail_accounts ADD COLUMN oauth_refresh TEXT;
  ALTER TABLE mail_accounts ADD COLUMN oauth_access TEXT;
  ALTER TABLE mail_accounts ADD COLUMN oauth_expires INTEGER;
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// --- Settings ------------------------------------------------------------------

export interface Settings {
  adminUsername: string;
  adminPasswordHash: string;
  setupComplete: boolean;

  /** Where the local model runs: Ollama, or anything with an OpenAI-style API (LM Studio, llama.cpp, vLLM). */
  aiProvider: "ollama" | "openai" | "none";
  aiUrl: string;
  aiModel: string;
  aiApiKey: string;
  /** Context window for Ollama, in tokens. */
  aiContext: number;
  /** A few lines about you, so the AI knows what matters (your school, your job, your pets). */
  aboutMe: string;

  pushoverToken: string;
  pushoverUser: string;
  pushoverDevices: string;
  /** ntfy server, without the topic: "https://ntfy.sh", or "http://ntfy:80" on the same Docker network. */
  ntfyServer: string;
  ntfyTopic: string;
  ntfyAuth: "none" | "basic" | "token";
  ntfyUsername: string;
  ntfyPassword: string;
  ntfyToken: string;
  /** 1 (min) to 5 (max). Urgent pushes (nags, high priority, email to act on) go one higher. */
  ntfyPriority: number;
  /** v0.1.0's single "https://ntfy.sh/topic" field; still read if the new ones are empty. */
  ntfyUrl: string;
  /** This app's address, for "open" links in notifications. */
  publicUrl: string;

  /** Push a notification when a task with a time comes due. */
  remindersPush: boolean;
  /** How many minutes before the time to send it. */
  reminderLeadMinutes: number;
  summaryEnabled: boolean;
  summaryTime: string;
  summaryPush: boolean;
  /** Push right away when an email that needs you arrives. */
  emailPush: boolean;
  mailIntervalMinutes: number;
  /** On the first check of an account, look back this many days. */
  mailLookbackDays: number;
  /** Flag email you sent as unanswered after this many days. */
  replyWaitDays: number;
  /** Signs the Done / Snooze links in notifications. */
  actionSecret: string;
  /** Your Microsoft Entra app (for "Sign in with Microsoft" on email accounts). */
  msClientId: string;
  /** "common" (any account), "consumers", "organizations", or your school's tenant id or domain. */
  msTenant: string;
}

export const SECRET_KEYS = ["aiApiKey", "pushoverToken", "pushoverUser", "ntfyToken", "ntfyPassword"] as const;
/** Never sent to the browser at all. */
export const HIDDEN_KEYS = ["adminPasswordHash", "actionSecret"] as const;

export const DEFAULT_SETTINGS: Settings = {
  adminUsername: "",
  adminPasswordHash: "",
  setupComplete: false,
  aiProvider: "ollama",
  aiUrl: "",
  aiModel: "",
  aiApiKey: "",
  aiContext: 8192,
  aboutMe: "",
  pushoverToken: "",
  pushoverUser: "",
  pushoverDevices: "",
  ntfyServer: "",
  ntfyTopic: "",
  ntfyAuth: "none",
  ntfyUsername: "",
  ntfyPassword: "",
  ntfyToken: "",
  ntfyPriority: 3,
  ntfyUrl: "",
  publicUrl: "",
  remindersPush: true,
  reminderLeadMinutes: 0,
  summaryEnabled: true,
  summaryTime: "07:00",
  summaryPush: true,
  emailPush: true,
  mailIntervalMinutes: 15,
  mailLookbackDays: 3,
  replyWaitDays: 3,
  actionSecret: "",
  msClientId: "",
  msTenant: "common",
};

export function getSettings(db: DB): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in DEFAULT_SETTINGS) out[row.key] = JSON.parse(row.value);
  }
  return out as unknown as Settings;
}

export function saveSettings(db: DB, patch: Partial<Settings>) {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  tx(db, () => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
      stmt.run(key, JSON.stringify(value));
    }
  });
}

// --- Rows ----------------------------------------------------------------------

export interface TaskRow {
  id: number;
  title: string;
  notes: string | null;
  list: string | null;
  due_date: string | null;
  due_time: string | null;
  recurrence: string | null;
  priority: number;
  source: string;
  email_id: number | null;
  done_at: number | null;
  notified_for: string | null;
  nag_minutes: number;
  nag_count: number;
  last_pushed_at: number | null;
  snoozed_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface MailAccountRow {
  id: number;
  label: string;
  host: string;
  port: number;
  secure: number;
  username: string;
  password: string;
  folder: string;
  enabled: number;
  uid_validity: string | null;
  last_uid: number;
  last_checked_at: number | null;
  last_error: string | null;
  track_replies: number;
  auth: "password" | "microsoft";
  oauth_refresh: string | null;
  oauth_access: string | null;
  oauth_expires: number | null;
  sent_folder: string | null;
  sent_uid_validity: string | null;
  sent_last_uid: number;
  created_at: number;
}

export interface EmailRow {
  id: number;
  account_id: number;
  uid: number;
  message_id: string | null;
  from_name: string | null;
  from_addr: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number;
  bulk: number;
  category: string;
  summary: string | null;
  reason: string | null;
  decided_by: string;
  ai_pending: number;
  pending_text: string | null;
  suggestion: string | null;
  suggestion_state: string | null;
  task_id: number | null;
  handled: number;
  notified: number;
  in_reply_to: string | null;
  refs: string | null;
  created_at: number;
}

export interface SentRow {
  id: number;
  account_id: number;
  uid: number;
  message_id: string | null;
  to_name: string | null;
  to_addr: string | null;
  subject: string | null;
  snippet: string | null;
  sent_at: number;
  state: "waiting" | "answered" | "dismissed" | "none";
  reason: string | null;
  decided_by: string;
  answered_at: number | null;
  answer_email_id: number | null;
  nudged: number;
  created_at: number;
}

export interface SourceRow {
  id: number;
  kind: "ics" | "carrel";
  name: string;
  url: string;
  username: string | null;
  password: string | null;
  enabled: number;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
}

export interface ExternalItem {
  id: number;
  source_id: number;
  ext_id: string;
  kind: "event" | "assignment" | "reading" | "exam" | "quiz";
  title: string;
  date: string;
  end_date: string | null;
  time: string | null;
  end_time: string | null;
  location: string | null;
  context: string | null;
  url: string | null;
}

export interface SenderRule {
  id: number;
  pattern: string;
  action: "important" | "ignore";
  created_at: number;
}

export function logActivity(db: DB, kind: string, message: string) {
  // The same failure on every check would bury everything else: log a repeated
  // error once, and again only if it's still happening hours later.
  if (kind === "error") {
    const recent = db
      .prepare("SELECT 1 FROM activity WHERE kind = 'error' AND message = ? AND at > ? LIMIT 1")
      .get(message, Date.now() - 6 * 3_600_000);
    if (recent) return;
  }
  db.prepare("INSERT INTO activity (at, kind, message) VALUES (?, ?, ?)").run(Date.now(), kind, message);
  db.prepare("DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET 2000)").run();
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `${err.message} (${cause.code})`;
    return err.message;
  }
  return String(err);
}
