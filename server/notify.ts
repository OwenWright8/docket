// Push notifications: Pushover and/or ntfy (ntfy.sh or your own server).
// Whatever's configured gets every message.
import type { Settings } from "./db.ts";

export interface Push {
  title: string;
  message: string;
  /** Opens this when the notification is tapped. */
  url?: string;
  urlTitle?: string;
  priority?: "low" | "normal" | "high";
  /** Buttons on the notification (ntfy shows up to three; Pushover can't, so it gets `url` instead). */
  actions?: { label: string; url: string }[];
}

export type Sender = (settings: Settings, push: Push) => Promise<string[]>;

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

export function channels(s: Settings): string[] {
  const out = [];
  if (s.pushoverToken && s.pushoverUser) out.push("Pushover");
  if (ntfyTarget(s)) out.push("ntfy");
  return out;
}

/** Sends to every configured channel. Returns the channels it reached; throws only if all of them failed. */
export const sendPush: Sender = async (s, push) => {
  const sent: string[] = [];
  const errors: string[] = [];
  if (s.pushoverToken && s.pushoverUser) {
    try {
      await pushover(s, push);
      sent.push("Pushover");
    } catch (err) {
      errors.push(`Pushover: ${(err as Error).message}`);
    }
  }
  if (ntfyTarget(s)) {
    try {
      await ntfy(s, push);
      sent.push("ntfy");
    } catch (err) {
      errors.push(`ntfy: ${(err as Error).message}`);
    }
  }
  if (!sent.length && errors.length) throw new Error(errors.join("; "));
  return sent;
};

async function pushover(s: Settings, push: Push) {
  const form = new URLSearchParams({
    token: s.pushoverToken,
    user: s.pushoverUser,
    title: clip(push.title, 250),
    message: clip(push.message, 1024),
  });
  if (s.pushoverDevices.trim()) form.set("device", s.pushoverDevices.replace(/\s+/g, ""));
  if (push.priority === "high") form.set("priority", "1");
  if (push.priority === "low") form.set("priority", "-1");
  if (push.url) {
    form.set("url", push.url.slice(0, 512));
    if (push.urlTitle) form.set("url_title", push.urlTitle.slice(0, 100));
  }
  const res = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: form, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { errors?: string[] };
    throw new Error(body.errors?.join("; ") || `HTTP ${res.status}`);
  }
}

/** Where ntfy messages go: the server and topic fields, or v0.1.0's single topic address. */
export function ntfyTarget(s: Settings): { server: string; topic: string } | null {
  if (s.ntfyServer.trim() && s.ntfyTopic.trim()) return { server: s.ntfyServer.trim().replace(/\/+$/, ""), topic: s.ntfyTopic.trim() };
  const m = s.ntfyUrl.trim().replace(/\/+$/, "").match(/^(https?:\/\/.+)\/([^/]+)$/);
  return m && /^https?:\/\/[^/]+/.test(m[1]) ? { server: m[1], topic: m[2] } : null;
}

async function ntfy(s: Settings, push: Push) {
  const target = ntfyTarget(s);
  if (!target) throw new Error("Set the ntfy server and topic");
  const base = Math.min(5, Math.max(1, Math.round(s.ntfyPriority) || 3));
  // Published as JSON to the server root: it carries UTF-8 titles and action buttons cleanly.
  const body: Record<string, unknown> = {
    topic: target.topic,
    title: clip(push.title, 250),
    message: clip(push.message, 4000),
    priority: push.priority === "high" ? Math.min(5, base + 1) : push.priority === "low" ? Math.max(1, base - 1) : base,
  };
  if (push.url) body.click = push.url;
  if (push.actions?.length) {
    // "http" actions are sent by the phone itself, in the background: tapping Done doesn't open anything.
    body.actions = push.actions.slice(0, 3).map((a) => ({ action: "http", label: a.label, url: a.url, method: "POST", clear: true }));
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.ntfyAuth === "basic" && s.ntfyUsername) headers.Authorization = `Basic ${Buffer.from(`${s.ntfyUsername}:${s.ntfyPassword}`).toString("base64")}`;
  else if (s.ntfyAuth === "token" && s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
  else if (s.ntfyAuth === "none" && s.ntfyToken && !s.ntfyServer) headers.Authorization = `Bearer ${s.ntfyToken}`; // v0.1.0 setups
  let res: Response;
  try {
    res = await fetch(target.server, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const code = (err as Error & { cause?: { code?: string } }).cause?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw new Error(`Can't find ${target.server} from the Docket container (same Docker network?)`);
    if (code === "ECONNREFUSED") throw new Error(`Nothing answered at ${target.server}`);
    throw new Error(`Couldn't reach ${target.server}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 || res.status === 403) throw new Error(`ntfy refused: ${err.error || "check the username and password, or the token"}`);
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}
