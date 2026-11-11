// Done / Snooze from a notification. Each link is signed for one task at one
// due date, so it works without signing in, can't be used on any other task,
// and stops working once the task has moved on (done, or its date changed).
//   ntfy:     buttons on the notification POST straight to /api/act.
//   Pushover: can't show buttons, so the notification's link opens a small
//             page (GET /act) with the same buttons on it.
import crypto from "node:crypto";
import { type DB, type Settings, getSettings, saveSettings } from "./db.ts";
import type { TaskRow } from "./db.ts";
import { completeTask, getTask, moveToTomorrow, parseRecurrence, snoozeTask } from "./tasks.ts";
import { friendlyTime, relativeDay, todayYmd } from "./time.ts";

export type Act = "done" | "skip" | "snooze1h" | "snooze3h" | "tomorrow";
export const ACTS: Act[] = ["done", "skip", "snooze1h", "snooze3h", "tomorrow"];

export function actionSecret(db: DB): string {
  let s = getSettings(db).actionSecret;
  if (!s) {
    s = crypto.randomBytes(32).toString("base64url");
    saveSettings(db, { actionSecret: s });
  }
  return s;
}

/** Which due date a link was made for: done or moved since, and the link is stale. */
const dueKey = (t: Pick<TaskRow, "due_date" | "due_time">) => `${t.due_date ?? "-"}T${t.due_time ?? "-"}`;

function sign(secret: string, taskId: number, key: string): string {
  return crypto.createHmac("sha256", secret).update(`${taskId}|${key}`).digest("base64url").slice(0, 24);
}

export function verify(db: DB, taskId: number, key: string, sig: string): boolean {
  const expected = Buffer.from(sign(actionSecret(db), taskId, key));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function base(s: Settings): string | null {
  return s.publicUrl ? s.publicUrl.replace(/\/+$/, "") : null;
}

/** The links for a reminder about `t`, or null when Docket's address isn't set (the phone couldn't reach it). */
export function actionLinks(db: DB, s: Settings, t: TaskRow): { page: string; api: (a: Act) => string } | null {
  const root = base(s);
  if (!root) return null;
  const key = dueKey(t);
  const q = `t=${t.id}&k=${encodeURIComponent(key)}&s=${sign(actionSecret(db), t.id, key)}`;
  return { page: `${root}/act?${q}`, api: (a) => `${root}/api/act?${q}&a=${a}` };
}

/** The notification buttons for a task reminder. */
export function reminderButtons(db: DB, s: Settings, t: TaskRow) {
  const links = actionLinks(db, s, t);
  if (!links) return {};
  return {
    actions: [
      { label: "Done", url: links.api("done") },
      { label: "Snooze 1 h", url: links.api("snooze1h") },
      parseRecurrence(t) ? { label: "Skip", url: links.api("skip") } : { label: "Tomorrow", url: links.api("tomorrow") },
    ],
    // Pushover has no buttons: its link opens the page with them on.
    url: links.page,
    urlTitle: "Done / Snooze",
  };
}

export type ActResult = { ok: true; message: string } | { ok: false; status: number; message: string };

export function runAct(db: DB, taskId: number, key: string, sig: string, act: string, now = new Date()): ActResult {
  if (!verify(db, taskId, key, sig)) return { ok: false, status: 403, message: "That link isn't valid." };
  const t = getTask(db, taskId);
  if (!t) return { ok: false, status: 404, message: "That task has been deleted." };
  if (t.done_at || dueKey(t) !== key) return { ok: false, status: 409, message: `“${t.title}” has already been dealt with.` };
  switch (act) {
    case "done": {
      const r = completeTask(db, t.id, "done", now);
      if (!r) return { ok: false, status: 409, message: "Already done." };
      const next = r.task.done_at ? "" : ` Next: ${relativeDay(r.task.due_date!, todayYmd(now))}.`;
      return { ok: true, message: `Done: ${t.title}.${next}` };
    }
    case "skip": {
      const r = completeTask(db, t.id, "skipped", now);
      if (!r) return { ok: false, status: 409, message: "Only repeating tasks can be skipped." };
      return { ok: true, message: `Skipped ${t.title}. Next: ${relativeDay(r.task.due_date!, todayYmd(now))}.` };
    }
    case "snooze1h":
    case "snooze3h": {
      const minutes = act === "snooze1h" ? 60 : 180;
      snoozeTask(db, t.id, minutes, now.getTime());
      const at = new Date(now.getTime() + minutes * 60_000);
      return { ok: true, message: `Snoozed ${t.title} until ${friendlyTime(`${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`)}.` };
    }
    case "tomorrow":
      moveToTomorrow(db, t.id, now);
      return { ok: true, message: `Moved ${t.title} to tomorrow${t.due_time ? ` at ${friendlyTime(t.due_time)}` : ""}.` };
    default:
      return { ok: false, status: 400, message: "Unknown action." };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The little page Pushover's link opens: the task and its buttons (or the result of pressing one). */
export function actPage(db: DB, q: { t: number; k: string; s: string }, result?: ActResult): string {
  const valid = verify(db, q.t, q.k, q.s);
  const t = valid ? getTask(db, q.t) : undefined;
  const stale = !t || !!t.done_at || dueKey(t) !== q.k;
  let body: string;
  if (result) {
    body = `<p class="msg ${result.ok ? "ok" : "err"}">${esc(result.message)}</p>`;
  } else if (!valid) {
    body = `<p class="msg err">That link isn't valid.</p>`;
  } else if (stale) {
    body = `<p class="msg">${t ? `“${esc(t.title)}” has already been dealt with.` : "That task has been deleted."}</p>`;
  } else {
    const today = todayYmd();
    const when = t!.due_date ? `${relativeDay(t!.due_date, today)}${t!.due_time ? ` at ${friendlyTime(t!.due_time)}` : ""}` : "";
    const btn = (a: Act, label: string, primary = false) =>
      `<button name="a" value="${a}" class="${primary ? "primary" : ""}">${label}</button>`;
    body = `<h1>${esc(t!.title)}</h1>${when ? `<p class="when">${esc(when.charAt(0).toUpperCase() + when.slice(1))}</p>` : ""}
      <form method="post" action="/act">
        <input type="hidden" name="t" value="${q.t}"><input type="hidden" name="k" value="${esc(q.k)}"><input type="hidden" name="s" value="${esc(q.s)}">
        ${btn("done", "Done", true)}
        ${btn("snooze1h", "Snooze 1 hour")}
        ${btn("snooze3h", "Snooze 3 hours")}
        ${parseRecurrence(t!) ? btn("skip", "Skip this time") : btn("tomorrow", "Move to tomorrow")}
      </form>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Docket</title><link rel="icon" href="/icon.svg">
<style>
:root{--bg:#f8f6f2;--fg:#2b2620;--muted:#7a7166;--card:#fff;--line:#e6e0d6;--primary:#267a6f;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#181614;--fg:#ede8e0;--muted:#a49b8f;--card:#211f1c;--line:#36322d;--primary:#5cbfae;--on:#141210}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,sans-serif}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px}
h1{font-size:20px;margin:0 0 4px}.when{color:var(--muted);margin:0 0 18px}
form{display:grid;gap:8px}button{font:inherit;font-weight:600;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg)}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--on)}
.msg{margin:0;font-weight:500}.ok{color:var(--primary)}.err{color:#c4483c}
a{display:inline-block;margin-top:16px;color:var(--muted);font-size:14px}
</style></head><body><main>${body}<a href="/">Open Docket</a></main></body></html>`;
}
