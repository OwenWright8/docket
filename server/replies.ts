// "Waiting on a reply": email you sent that asked for something, until an
// answer comes in. An answer is an email in your inbox that follows on from
// yours (In-Reply-To / References), or, failing that, one from the same
// person with the same subject after you sent it.
import { type AiClient, aiExpectsReply } from "./ai.ts";
import type { DB, EmailRow, SentRow } from "./db.ts";
import type { FetchedMail } from "./mail.ts";

const ASKS =
  /\?|\b(let me know|please (confirm|let|send|reply|respond|advise|get back)|can you|could you|would you|will you|are you able|get back to me|looking forward to (hearing|your)|when (can|could|would|will)|any update|is it possible|do you know|waiting (for|on) your)\b/i;
const NO_REPLY_ADDR = /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce)/i;

/** The part of a reply you wrote, without the quoted message under it. */
export function ownText(text: string): string {
  const lines = [];
  for (const line of text.split("\n")) {
    if (/^On .+wrote:\s*$/i.test(line) || /^-{2,}\s*(Original Message|Forwarded message)/i.test(line) || /^From: .+/.test(line) || /^_{5,}/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

export function normalizeSubject(s: string | null | undefined): string {
  return (s ?? "").replace(/^(\s*(re|fwd?|aw|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, "").trim().toLowerCase();
}

/** Without the AI: it asked something, to a real person. */
export function basicExpectsReply(text: string): { expectsReply: boolean; reason: string } {
  const own = ownText(text);
  if (ASKS.test(own)) return { expectsReply: true, reason: /\?/.test(own) ? "You asked a question" : "You asked them for something" };
  return { expectsReply: false, reason: "Didn't ask for anything" };
}

/** Decides whether a sent email expects an answer. Skips mail to yourself, to no-reply addresses, or to big groups. */
export async function judgeSent(
  m: FetchedMail,
  ctx: { ai: AiClient | null; self: string[]; aboutMe?: string },
): Promise<{ state: "waiting" | "none"; reason: string; decidedBy: "ai" | "basic"; aiError?: string } | null> {
  const to = m.to.filter((t) => !ctx.self.includes(t.addr));
  if (!to.length || to.length > 6 || to.every((t) => NO_REPLY_ADDR.test(t.addr)) || m.bulk) return null;
  const own = ownText(m.text);
  if (!own) return null;
  if (ctx.ai) {
    try {
      const v = await aiExpectsReply(ctx.ai, { toName: to[0].name, toAddr: to[0].addr, subject: m.subject, text: own }, { aboutMe: ctx.aboutMe });
      return { state: v.expectsReply ? "waiting" : "none", reason: v.reason, decidedBy: "ai" };
    } catch (err) {
      const v = basicExpectsReply(m.text);
      return { state: v.expectsReply ? "waiting" : "none", reason: v.reason, decidedBy: "basic", aiError: (err as Error).message };
    }
  }
  const v = basicExpectsReply(m.text);
  return { state: v.expectsReply ? "waiting" : "none", reason: v.reason, decidedBy: "basic" };
}

/** Marks sent mail answered by inbox email (all of it, or just `emailIds`). Returns how many. */
export function matchReplies(db: DB, emailIds?: number[]): number {
  const waiting = db.prepare("SELECT * FROM sent_mail WHERE state = 'waiting'").all() as unknown as SentRow[];
  if (!waiting.length) return 0;
  const emails = (
    emailIds
      ? emailIds.map((id) => db.prepare("SELECT * FROM emails WHERE id = ?").get(id))
      : db.prepare("SELECT * FROM emails WHERE received_at > ?").all(Date.now() - 60 * 86_400_000)
  ).filter(Boolean) as unknown as EmailRow[];
  const mark = db.prepare("UPDATE sent_mail SET state = 'answered', answered_at = ?, answer_email_id = ? WHERE id = ?");
  let n = 0;
  for (const s of waiting) {
    const subj = normalizeSubject(s.subject);
    const hit = emails.find((e) => {
      if (e.received_at <= s.sent_at) return false;
      if (s.message_id && (e.in_reply_to === s.message_id || (e.refs ?? "").split(" ").includes(s.message_id))) return true;
      return !!s.to_addr && e.from_addr === s.to_addr && !!subj && normalizeSubject(e.subject) === subj;
    });
    if (hit) {
      mark.run(hit.received_at, hit.id, s.id);
      n++;
    }
  }
  return n;
}
