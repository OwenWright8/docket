// Reading email over IMAP. Works with Gmail (with an app password), Outlook,
// iCloud, Fastmail, Proton Bridge or your own server. The folder is opened
// read-only: nothing is ever marked as read, moved or deleted.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { MailAccountRow } from "./db.ts";

export interface FetchedMail {
  uid: number;
  messageId: string | null;
  fromName: string;
  fromAddr: string;
  subject: string;
  date: Date;
  /** Plain text of the body (trimmed). */
  text: string;
  /** Mailing-list / bulk headers present (List-Unsubscribe, Precedence: bulk…). */
  bulk: boolean;
  /** Gmail's own labels, when it's Gmail (e.g. "\\Important", "Promotions"). */
  labels: string[];
}

export interface MailBatch {
  uidValidity: string;
  messages: FetchedMail[];
  /** The highest UID in the folder that's been looked at. */
  lastUid: number;
}

export interface MailSource {
  /** New mail since lastUid (or the last `lookbackDays` on the first run), at most `limit` of the newest. */
  fetch(account: MailAccountRow, opts: { lookbackDays: number; limit: number }): Promise<MailBatch>;
  /** Signs in and opens the folder; resolves with how many messages are in it. */
  test(account: Pick<MailAccountRow, "host" | "port" | "secure" | "username" | "password" | "folder">): Promise<{ messages: number }>;
}

function client(a: Pick<MailAccountRow, "host" | "port" | "secure" | "username" | "password">) {
  return new ImapFlow({
    host: a.host,
    port: a.port,
    secure: !!a.secure,
    auth: { user: a.username, pass: a.password },
    logger: false,
    clientInfo: { name: "Docket" },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
}

export const imapSource: MailSource = {
  async test(a) {
    const c = client(a);
    try {
      await c.connect();
      const lock = await c.getMailboxLock(a.folder || "INBOX", { readOnly: true });
      try {
        return { messages: c.mailbox ? c.mailbox.exists : 0 };
      } finally {
        lock.release();
      }
    } catch (err) {
      throw new Error(friendlyImapError(err));
    } finally {
      await c.logout().catch(() => {});
    }
  },

  async fetch(a, { lookbackDays, limit }) {
    const c = client(a);
    try {
      await c.connect();
      const lock = await c.getMailboxLock(a.folder || "INBOX", { readOnly: true });
      try {
        const box = c.mailbox;
        if (!box) throw new Error("Couldn't open the folder");
        const uidValidity = String(box.uidValidity);
        const fresh = a.uid_validity !== uidValidity || !a.last_uid;
        let uids: number[];
        if (fresh) {
          const since = new Date(Date.now() - lookbackDays * 86_400_000);
          uids = ((await c.search({ since }, { uid: true })) || []) as number[];
        } else {
          uids = ((await c.search({ uid: `${a.last_uid + 1}:*` }, { uid: true })) || []) as number[];
          uids = uids.filter((u) => u > a.last_uid); // "n:*" always returns the last message
        }
        uids.sort((x, y) => x - y);
        const lastUid = Math.max(fresh ? 0 : a.last_uid, ...uids, 0);
        const wanted = uids.slice(-limit);
        const messages: FetchedMail[] = [];
        if (wanted.length) {
          const gmail = /gmail|googlemail/i.test(a.host);
          for await (const msg of c.fetch(wanted, { uid: true, source: { maxLength: 200_000 }, internalDate: true, labels: gmail }, { uid: true })) {
            if (!msg.source) continue;
            messages.push(await toMail(msg.uid, msg.source, msg.internalDate, msg.labels));
          }
        }
        return { uidValidity, messages, lastUid };
      } finally {
        lock.release();
      }
    } catch (err) {
      throw new Error(friendlyImapError(err));
    } finally {
      await c.logout().catch(() => {});
    }
  },
};

async function toMail(uid: number, source: Buffer, internalDate: Date | string | undefined, labels?: Set<string>): Promise<FetchedMail> {
  const p = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const from = p.from?.value?.[0];
  const h = (name: string) => {
    const v = p.headers.get(name);
    return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  };
  const bulk =
    !!h("list-unsubscribe") ||
    !!h("list-id") ||
    /bulk|list|junk/i.test(h("precedence")) ||
    /auto-generated|auto-replied/i.test(h("auto-submitted")) ||
    !!h("x-campaign") ||
    !!h("x-mailchimp-campaign");
  const text = (p.text || htmlToText(typeof p.html === "string" ? p.html : "")).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    uid,
    messageId: p.messageId ?? null,
    fromName: from?.name ?? "",
    fromAddr: (from?.address ?? "").toLowerCase(),
    subject: p.subject ?? "(no subject)",
    date: p.date ?? (internalDate ? new Date(internalDate) : new Date()),
    text: text.slice(0, 20_000),
    bulk,
    labels: labels ? [...labels] : [],
  };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n");
}

function friendlyImapError(err: unknown): string {
  const e = err as Error & { code?: string; authenticationFailed?: boolean; responseText?: string };
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(`${e.responseText ?? ""} ${e.message}`)) {
    return "The server rejected the username or password. For Gmail, iCloud and Outlook use an app password, not your normal one.";
  }
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") return "That mail server name doesn't resolve. Check the host.";
  if (e.code === "ECONNREFUSED") return "The mail server refused the connection. Check the host and port.";
  if (e.code === "ETIMEDOUT" || /timeout/i.test(e.message)) return "The mail server didn't answer in time.";
  if (/Mailbox doesn't exist|NONEXISTENT|not found/i.test(`${e.responseText ?? ""} ${e.message}`)) return "That folder doesn't exist on the server.";
  return e.responseText || e.message || String(err);
}
