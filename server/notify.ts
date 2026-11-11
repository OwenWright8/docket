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
}

export type Sender = (settings: Settings, push: Push) => Promise<string[]>;

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

export function channels(s: Settings): string[] {
  const out = [];
  if (s.pushoverToken && s.pushoverUser) out.push("Pushover");
  if (s.ntfyUrl) out.push("ntfy");
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
  if (s.ntfyUrl) {
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

async function ntfy(s: Settings, push: Push) {
  const url = s.ntfyUrl.trim();
  if (!/^https?:\/\/[^/]+\/[^/]+/.test(url)) throw new Error("The ntfy address should look like https://ntfy.sh/your-topic");
  const headers: Record<string, string> = {
    // Headers must be ASCII: ntfy decodes RFC 2047 encoded words.
    Title: `=?UTF-8?B?${Buffer.from(clip(push.title, 250)).toString("base64")}?=`,
    Priority: push.priority === "high" ? "4" : push.priority === "low" ? "2" : "3",
  };
  if (push.url) headers.Click = push.url;
  if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
  const res = await fetch(url, { method: "POST", headers, body: clip(push.message, 4000), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
