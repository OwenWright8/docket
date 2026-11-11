// Typed access to the server's /api. Errors carry the server's message.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/login") && !path.startsWith("/account")) {
      window.dispatchEvent(new Event("docket:signed-out"));
    }
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);

// --- Shapes ----------------------------------------------------------------------

export interface Session {
  authenticated: boolean;
  needsAccount: boolean;
  setupComplete: boolean;
  version: string;
}

export interface Recurrence {
  every: number;
  unit: "day" | "week" | "month" | "year";
  weekdays?: number[];
  day?: number;
  month?: number;
  from: "due" | "done";
}

export interface Task {
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
  nagMinutes: number;
  snoozedUntil: number | null;
  createdAt: number;
}

export interface TaskDetail extends Task {
  history: { id: number; at: number; onDate: string; action: string }[];
  email: { id: number; fromName: string | null; fromAddr: string | null; subject: string | null } | null;
}

/** What the quick-add box understood, before it's saved. */
export interface ParsedTask {
  title: string;
  notes: string | null;
  list: string | null;
  dueDate: string | null;
  dueTime: string | null;
  recurrence: Recurrence | null;
  priority: number;
  nagMinutes?: number;
}

export interface DayFacts {
  date: string;
  overdue: { id: number; title: string; due: string; daysLate: number }[];
  today: { id: number; title: string; time: string | null; repeat: string | null }[];
  upcoming: { id: number; title: string; due: string; time: string | null }[];
  emails: { id: number; from: string; subject: string; summary: string | null; category: string }[];
  suggestions: number;
}

export interface Digest {
  date: string;
  briefing: string;
  facts: DayFacts;
  byAi: boolean;
  createdAt: number;
  sentAt: number | null;
}

export interface Today {
  date: string;
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  later: number;
  anytime: Task[];
  done: { logId: number; action: string; at: number; task: Task }[];
  digest: Digest | null;
  inbox: number;
  schedule: ScheduleItem[];
  school: (ScheduleItem & { overdue: boolean })[];
  waiting: number;
}

export interface ScheduleItem {
  id: number;
  source_id: number;
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

export interface Source {
  id: number;
  kind: "ics" | "carrel";
  name: string;
  url: string;
  username: string | null;
  enabled: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
  items: number;
}

export interface SentMail {
  id: number;
  toName: string | null;
  toAddr: string | null;
  subject: string | null;
  snippet: string | null;
  sentAt: number;
  state: "waiting" | "answered" | "dismissed" | "none";
  reason: string | null;
  decidedBy: string;
  answeredAt: number | null;
  overdue: boolean;
}

export interface WidgetKey {
  id: number;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface Status {
  ai: { configured: boolean; ok: boolean | null; error: string | null; checkedAt: number | null };
  aiModel: string;
  due: number;
  inbox: number;
  waiting: number;
  sources: number;
  mailAccounts: number;
  mailBusy: boolean;
  notifications: string[];
}

export type Category = "important" | "action" | "fyi" | "promo" | "spam" | "ignored";

export interface Email {
  id: number;
  accountId: number;
  fromName: string | null;
  fromAddr: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: number;
  category: Category;
  summary: string | null;
  reason: string | null;
  decidedBy: "ai" | "rule" | "basic" | "you";
  aiPending: boolean;
  bulk: boolean;
  suggestion: { title: string; dueDate: string | null; dueTime: string | null } | null;
  suggestionState: "pending" | "accepted" | "dismissed" | null;
  taskId: number | null;
  handled: boolean;
  openUrl: string | null;
}

export interface EmailList {
  emails: Email[];
  counts: { attention: number; other: number; filtered: number; handled: number };
}

export interface MailAccount {
  id: number;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  folder: string;
  enabled: boolean;
  auth: "password" | "microsoft";
  needsSignIn: boolean;
  trackReplies: boolean;
  sentFolder: string | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  emails: number;
}

export interface SenderRule {
  id: number;
  pattern: string;
  action: "important" | "ignore";
  createdAt: number;
}

export interface Settings {
  adminUsername: string;
  setupComplete: boolean;
  aiProvider: "ollama" | "openai" | "none";
  aiUrl: string;
  aiModel: string;
  aiApiKey: string;
  aiApiKeySet: boolean;
  aiContext: number;
  aboutMe: string;
  pushoverToken: string;
  pushoverTokenSet: boolean;
  pushoverUser: string;
  pushoverUserSet: boolean;
  pushoverDevices: string;
  ntfyUrl: string;
  ntfyServer: string;
  ntfyTopic: string;
  ntfyAuth: "none" | "basic" | "token";
  ntfyUsername: string;
  ntfyPassword: string;
  ntfyPasswordSet: boolean;
  ntfyToken: string;
  ntfyTokenSet: boolean;
  ntfyPriority: number;
  publicUrl: string;
  remindersPush: boolean;
  reminderLeadMinutes: number;
  summaryEnabled: boolean;
  summaryTime: string;
  summaryPush: boolean;
  emailPush: boolean;
  mailIntervalMinutes: number;
  mailLookbackDays: number;
  replyWaitDays: number;
  msClientId: string;
  msTenant: string;
}

export interface About {
  version: string;
  repo: string;
  update: { enabled: boolean; latest: string | null; url: string | null; notes: string | null; publishedAt: string | null; checkedAt: number | null };
  updateAvailable: boolean;
}

export interface ActivityEntry {
  id: number;
  at: number;
  kind: string;
  message: string;
}

export interface MicrosoftFlow {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  state: "pending" | "done" | "error";
  error?: string;
  accountId?: number;
  email?: string;
}
