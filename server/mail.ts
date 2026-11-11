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
  to: { name: string; addr: string }[];
  inReplyTo: string | null;
  /** Message-IDs this one follows on from (References + In-Reply-To). */
  references: string[];
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
  /**
   * New mail in the Sent folder (found by its \\Sent flag, or a usual name), the
   * same way. lastUid / uidValidity come from the account's sent_* columns.
   */
  fetchSent(account: MailAccountRow, opts: { lookbackDays: number; limit: number }): Promise<MailBatch & { folder: string }>;
  /** Signs in and opens the folder; resolves with how many messages are in it. */
  test(account: Pick<MailAccountRow, "host" | "port" | "secure" | "username" | "password" | "folder"> & Partial<Pick<MailAccountRow, "auth" | "oauth_access">>): Promise<{ messages: number }>;
}

type Login = Pick<MailAccountRow, "host" | "port" | "secure" | "username" | "password"> & Partial<Pick<MailAccountRow, "auth" | "oauth_access">>;

function client(a: Login) {
  return new ImapFlow({
    host: a.host,
    port: a.port,
    secure: !!a.secure,
    // Microsoft accounts sign in with a token (XOAUTH2), never a password.
    auth: a.auth === "microsoft" ? { user: a.username, accessToken: a.oauth_access ?? "" } : { user: a.username, pass: a.password },
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

  async fetch(a, opts) {
    const c = client(a);
    try {
      await c.connect();
      return await readFolder(c, a.folder || "INBOX", a.uid_validity, a.last_uid, a.host, opts);
    } catch (err) {
      throw new Error(friendlyImapError(err));
    } finally {
      await c.logout().catch(() => {});
    }
  },

  async fetchSent(a, opts) {
    const c = client(a);
    try {
      await c.connect();
      let folder = a.sent_folder;
      if (!folder) {
        const boxes = await c.list();
        folder =
          boxes.find((b) => b.specialUse === "\\Sent")?.path ??
          boxes.find((b) => /^(\[gmail\]\/sent mail|sent|sent items|sent messages|sent mail)$/i.test(b.path))?.path ??
          null;
        if (!folder) throw new Error("Couldn't find a Sent folder on this account");
      }
      const batch = await readFolder(c, folder, a.sent_uid_validity, a.sent_last_uid, a.host, opts);
      return { ...batch, folder };
    } catch (err) {
      throw new Error(friendlyImapError(err));
    } finally {
      await c.logout().catch(() => {});
    }
  },
};

async function readFolder(
  c: ImapFlow,
  folder: string,
  knownValidity: string | null,
  knownLastUid: number,
  host: string,
  { lookbackDays, limit }: { lookbackDays: number; limit: number },
): Promise<MailBatch> {
  const lock = await c.getMailboxLock(folder, { readOnly: true });
  try {
    const box = c.mailbox;
    if (!box) throw new Error("Couldn't open the folder");
    const uidValidity = String(box.uidValidity);
    const fresh = knownValidity !== uidValidity || !knownLastUid;
    let uids: number[];
    if (fresh) {
      const since = new Date(Date.now() - lookbackDays * 86_400_000);
      uids = ((await c.search({ since }, { uid: true })) || []) as number[];
    } else {
      uids = ((await c.search({ uid: `${knownLastUid + 1}:*` }, { uid: true })) || []) as number[];
      uids = uids.filter((u) => u > knownLastUid); // "n:*" always returns the last message
    }
    uids.sort((x, y) => x - y);
    const lastUid = Math.max(fresh ? 0 : knownLastUid, ...uids, 0);
    const wanted = uids.slice(-limit);
    const messages: FetchedMail[] = [];
    if (wanted.length) {
      const gmail = /gmail|googlemail/i.test(host);
      for await (const msg of c.fetch(wanted, { uid: true, source: { maxLength: 200_000 }, internalDate: true, labels: gmail }, { uid: true })) {
        if (!msg.source) continue;
        messages.push(await toMail(msg.uid, msg.source, msg.internalDate, msg.labels));
      }
    }
    return { uidValidity, messages, lastUid };
  } finally {
    lock.release();
  }
}

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
  const toList = (Array.isArray(p.to) ? p.to : p.to ? [p.to] : []).flatMap((a) => a.value);
  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  return {
    uid,
    to: toList.map((v) => ({ name: v.name ?? "", addr: (v.address ?? "").toLowerCase() })).filter((v) => v.addr),
    inReplyTo: p.inReplyTo ?? null,
    references: [...new Set([...refs, ...(p.inReplyTo ? [p.inReplyTo] : [])])].slice(0, 50),
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
  const said = `${e.responseText ?? ""} ${e.message}`;
  // Microsoft 365: signed in fine, but IMAP is switched off for this mailbox (or it has no Exchange licence).
  if (/User is authenticated but not connected/i.test(said)) {
    return "Microsoft accepted the sign-in but won't open the mailbox over IMAP. Your organization may have IMAP turned off for your account; ask IT to enable IMAP for your mailbox.";
  }
  if (/AUTHENTICATE failed|XOAUTH2/i.test(said)) {
    return "Microsoft refused the sign-in token. Use “Sign in again” on the account; if it keeps happening, check the app has the IMAP.AccessAsUser.All permission.";
  }
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(said)) {
    return "The server rejected the username or password. For Gmail, iCloud and Outlook use an app password, not your normal one.";
  }
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") return "That mail server name doesn't resolve. Check the host.";
  if (e.code === "ECONNREFUSED") return "The mail server refused the connection. Check the host and port.";
  if (e.code === "ETIMEDOUT" || /timeout/i.test(e.message)) return "The mail server didn't answer in time.";
  if (/Mailbox doesn't exist|NONEXISTENT|not found/i.test(`${e.responseText ?? ""} ${e.message}`)) return "That folder doesn't exist on the server.";
  return e.responseText || e.message || String(err);
}
