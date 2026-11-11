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
  ntfyUrl: string;
  ntfyToken: string;
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
}

export const SECRET_KEYS = ["aiApiKey", "pushoverToken", "pushoverUser", "ntfyToken"] as const;

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
  ntfyUrl: "",
  ntfyToken: "",
  publicUrl: "",
  remindersPush: true,
  reminderLeadMinutes: 0,
  summaryEnabled: true,
  summaryTime: "07:00",
  summaryPush: true,
  emailPush: true,
  mailIntervalMinutes: 15,
  mailLookbackDays: 3,
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
  created_at: number;
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
