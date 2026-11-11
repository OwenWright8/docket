// Deciding what an email is. In order:
//   1. Your rules: "always important" / "always ignore" for a sender or domain.
//   2. The local AI, given the headers, a bulk-mail flag and the start of the body.
//   3. When the AI isn't reachable: basic signals (bulk headers, Gmail's own
//      categories, a few words like "invoice due"), marked to be redone by the
//      AI once it's back.
import { type AiClient, type Category, type EmailVerdict, aiTriageEmail } from "./ai.ts";
import type { DB, SenderRule } from "./db.ts";
import type { FetchedMail } from "./mail.ts";

export function senderRules(db: DB): SenderRule[] {
  return db.prepare("SELECT * FROM sender_rules ORDER BY created_at DESC").all() as unknown as SenderRule[];
}

/** The rule for an address: an exact address beats its @domain (and parent domains). */
export function ruleFor(rules: SenderRule[], addr: string): SenderRule | null {
  const a = addr.toLowerCase();
  const exact = rules.find((r) => r.pattern === a);
  if (exact) return exact;
  const domain = a.split("@")[1] ?? "";
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const d = "@" + parts.slice(i).join(".");
    const hit = rules.find((r) => r.pattern === d);
    if (hit) return hit;
  }
  return null;
}

export function normalizePattern(input: string): string | null {
  const p = input.trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) return p;
  const d = p.replace(/^@/, "");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return "@" + d;
  return null;
}

const ACTION_WORDS =
  /\b(payment (is )?due|amount due|due (date|on|by)|past due|overdue|please (pay|reply|respond|confirm|sign|submit|complete)|action required|deadline|appointment|reservation|renew(al)?|expires?|rsvp|interview|sign (the|this)|verify your|invoice)\b/i;
const IMPORTANT_WORDS = /\b(security alert|new sign-?in|password (was )?changed|grade|offer letter|lease|landlord|prescription|test results|your (doctor|account))\b/i;
const SPAM_WORDS = /\b(you('ve| have)? won|claim your (prize|reward)|bitcoin|crypto (opportunity|investment)|act now|limited time|100% free|wire transfer|gift card)\b/i;
const NOREPLY = /^(no-?reply|do-?not-?reply|notifications?|news(letter)?|marketing|info|hello|team|updates?)@/i;

/** Without the AI: a cautious guess from headers and a few words. */
export function basicVerdict(mail: Pick<FetchedMail, "fromAddr" | "subject" | "text" | "bulk" | "labels">): EmailVerdict {
  const hay = `${mail.subject}\n${mail.text.slice(0, 3000)}`;
  const labels = mail.labels.map((l) => l.toLowerCase());
  let category: Category;
  let reason: string;
  if (labels.includes("\\spam") || SPAM_WORDS.test(hay)) {
    category = "spam";
    reason = "Looks like junk";
  } else if (labels.some((l) => /promotions|social|forums/.test(l))) {
    category = "promo";
    reason = "Gmail filed it under Promotions or Social";
  } else if (mail.bulk && !ACTION_WORDS.test(mail.subject)) {
    category = "promo";
    reason = "Sent to a mailing list";
  } else if (ACTION_WORDS.test(hay)) {
    category = "action";
    reason = "Mentions something due";
  } else if (labels.includes("\\important") || IMPORTANT_WORDS.test(hay) || (!mail.bulk && !NOREPLY.test(mail.fromAddr))) {
    category = "important";
    reason = mail.bulk ? "Gmail marked it important" : "Written to you directly";
  } else {
    category = "fyi";
    reason = "Automatic notification";
  }
  return { category, summary: "", reason, task: null };
}

export interface Triaged extends EmailVerdict {
  decidedBy: "ai" | "rule" | "basic";
  aiPending: boolean;
  ignored: boolean;
}

export async function triage(
  mail: FetchedMail,
  ctx: { rules: SenderRule[]; ai: AiClient | null; aboutMe?: string; now?: Date },
): Promise<Triaged & { aiError?: string }> {
  const rule = ruleFor(ctx.rules, mail.fromAddr);
  if (rule?.action === "ignore") {
    return { category: "fyi", summary: "", reason: "You chose to ignore this sender", task: null, decidedBy: "rule", aiPending: false, ignored: true };
  }
  let verdict: EmailVerdict | null = null;
  let aiError: string | undefined;
  if (ctx.ai) {
    try {
      verdict = await aiTriageEmail(
        ctx.ai,
        { fromName: mail.fromName, fromAddr: mail.fromAddr, subject: mail.subject, date: mail.date.toISOString(), bulk: mail.bulk, text: mail.text },
        { now: ctx.now, aboutMe: ctx.aboutMe },
      );
    } catch (err) {
      aiError = (err as Error).message;
    }
  }
  const decidedBy = rule ? "rule" : verdict ? "ai" : "basic";
  const v = verdict ?? basicVerdict(mail);
  if (rule?.action === "important" && !["important", "action"].includes(v.category)) {
    v.category = "important";
    v.reason = "You marked this sender as important";
  }
  return { ...v, decidedBy, aiPending: !verdict, ignored: false, aiError };
}

export function snippetOf(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

/** "Needs you" in the inbox: important or action, not cleared. */
export const ATTENTION = ["important", "action"];
