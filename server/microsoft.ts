// "Sign in with Microsoft" for email: Outlook.com, Hotmail, and Microsoft 365
// work and school accounts, which don't allow IMAP with a password.
//
// It uses Microsoft's device-code sign-in: Docket shows a short code, you
// enter it at microsoft.com/devicelogin on any device and sign in as usual
// (Authenticator, passkey, your school's sign-in page). That needs no
// redirect back to Docket, so it works on a plain-http LAN address, which
// Microsoft's redirect sign-in doesn't allow.
//
// You register your own app in Microsoft Entra (free); Docket only stores
// its public client id. Tokens: a refresh token (kept in the data volume),
// and a short-lived access token renewed before each mail check.
import { type DB, type MailAccountRow, type Settings, getSettings } from "./db.ts";

export const IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All";
const SCOPES = `${IMAP_SCOPE} offline_access openid profile email`;
export const MS_IMAP_HOST = "outlook.office365.com";

export class MicrosoftError extends Error {}

/** Microsoft's AADSTS codes, said plainly. School and work accounts hit most of these. */
export function friendlyMsError(code: string | undefined, description: string | undefined): string {
  const d = description ?? "";
  const aadsts = d.match(/AADSTS(\d+)/)?.[1] ?? "";
  // The AADSTS code is the specific reason; the OAuth error code ("access_denied", "invalid_grant") is generic.
  switch (aadsts) {
    case "65001":
    case "90094":
    case "90095":
      return "Your organization's IT has to approve this app before it can read your mail. Ask them to grant admin consent for it (the app's client id is in Settings), or use a personal account.";
    case "53003":
      return "Your organization blocks this kind of sign-in (a Conditional Access policy, often one that blocks device-code sign-in). Ask IT, or forward your mail to an account Docket can read.";
    case "50105":
      return "Your organization only lets assigned people use this app. Ask IT to assign it to you.";
    case "700016":
      return "Microsoft doesn't know that client id in this directory. Check the Application (client) ID, and that the app accepts accounts in any organizational directory and personal accounts.";
    case "7000218":
    case "700025":
      return "In the app's Authentication page, turn on “Allow public client flows”, save, and try again.";
    case "50059":
      return "Microsoft couldn't tell which organization to use. Set Tenant to “common”, or to your school's domain (like wabash.edu).";
    case "50020":
      return "That account isn't allowed in this app's directory. Set the app to accept accounts in any organizational directory and personal accounts.";
    case "9002331":
      return "This app only accepts personal accounts. Set it to also accept accounts in any organizational directory.";
    case "500200":
    case "50034":
      return "Microsoft didn't recognise that account.";
    case "70000":
    case "700082":
    case "50173":
    case "50078":
      return "Microsoft needs you to sign in again (the saved sign-in expired, or your password changed).";
  }
  if (code === "access_denied" || code === "authorization_declined") return "The sign-in was cancelled or declined.";
  if (code === "expired_token") return "The code expired before the sign-in finished. Start again (it lasts 15 minutes).";
  return d.split(/\r?\n/)[0].replace(/^AADSTS\d+:\s*/, "") || code || "Microsoft refused the sign-in.";
}

async function post(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new MicrosoftError(`Couldn't reach Microsoft: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

const tenantOf = (s: Pick<Settings, "msTenant">) => (s.msTenant || "common").trim().replace(/[^A-Za-z0-9.-]/g, "") || "common";

/** The name to sign in to IMAP with, from the ID token: the UPN (e.g. odwright28@wabash.edu). */
export function accountFromIdToken(idToken: unknown): { email: string; name: string; tenantId: string | null } | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const email = String(payload.preferred_username ?? payload.email ?? payload.upn ?? "").toLowerCase();
    if (!email.includes("@")) return null;
    return { email, name: String(payload.name ?? ""), tenantId: typeof payload.tid === "string" ? payload.tid : null };
  } catch {
    return null;
  }
}

export interface Flow {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  state: "pending" | "done" | "error";
  error?: string;
  accountId?: number;
  email?: string;
}

/** Sign-ins in progress. Each polls Microsoft in the background until it's done, refused or expired. */
export class MicrosoftSignIn {
  db: DB;
  base: string;
  flows = new Map<string, Flow>();
  /** Called with the tokens once someone finishes signing in; returns the mail account it made or updated. */
  onSignedIn: (r: { email: string; name: string; refresh: string; access: string; expiresAt: number; accountId?: number }) => number;

  constructor(db: DB, onSignedIn: MicrosoftSignIn["onSignedIn"], base = "https://login.microsoftonline.com") {
    this.db = db;
    this.base = base.replace(/\/+$/, "");
    this.onSignedIn = onSignedIn;
  }

  async start(opts: { accountId?: number } = {}): Promise<Flow> {
    const s = getSettings(this.db);
    if (!s.msClientId.trim()) throw new MicrosoftError("Set your app's client id first (Settings → Email → Microsoft sign-in).");
    const r = await post(`${this.base}/${tenantOf(s)}/oauth2/v2.0/devicecode`, { client_id: s.msClientId.trim(), scope: SCOPES });
    if (r.status !== 200 || typeof r.body.device_code !== "string") {
      throw new MicrosoftError(friendlyMsError(String(r.body.error ?? ""), String(r.body.error_description ?? "")));
    }
    const flow: Flow = {
      id: crypto.randomUUID(),
      userCode: String(r.body.user_code),
      verificationUri: String(r.body.verification_uri ?? "https://microsoft.com/devicelogin"),
      expiresAt: Date.now() + Number(r.body.expires_in ?? 900) * 1000,
      state: "pending",
    };
    this.flows.set(flow.id, flow);
    void this.poll(flow, String(r.body.device_code), Math.max(1, Number(r.body.interval ?? 5)), s, opts.accountId);
    // Forget finished ones after a while.
    for (const [id, f] of this.flows) if (f.expiresAt < Date.now() - 3_600_000) this.flows.delete(id);
    return flow;
  }

  private async poll(flow: Flow, deviceCode: string, interval: number, s: Settings, accountId?: number) {
    let wait = interval;
    while (flow.state === "pending") {
      await new Promise((r) => setTimeout(r, wait * 1000));
      if (Date.now() > flow.expiresAt) {
        Object.assign(flow, { state: "error", error: friendlyMsError("expired_token", "") });
        return;
      }
      let r;
      try {
        r = await post(`${this.base}/${tenantOf(s)}/oauth2/v2.0/token`, {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: s.msClientId.trim(),
          device_code: deviceCode,
        });
      } catch {
        continue; // a network blip: try again next round
      }
      const err = String(r.body.error ?? "");
      if (err === "authorization_pending") continue;
      if (err === "slow_down") {
        wait += 5;
        continue;
      }
      if (r.status !== 200 || typeof r.body.access_token !== "string") {
        Object.assign(flow, { state: "error", error: friendlyMsError(err, String(r.body.error_description ?? "")) });
        return;
      }
      if (typeof r.body.refresh_token !== "string") {
        Object.assign(flow, { state: "error", error: "Microsoft didn't give a lasting sign-in (offline access). Check the app's API permissions include offline_access." });
        return;
      }
      if (!String(r.body.scope ?? "").includes("IMAP.AccessAsUser.All")) {
        Object.assign(flow, { state: "error", error: "Microsoft didn't grant mail access. Add the IMAP.AccessAsUser.All permission (Office 365 Exchange Online) to the app." });
        return;
      }
      const who = accountFromIdToken(r.body.id_token);
      if (!who) {
        Object.assign(flow, { state: "error", error: "Microsoft didn't say which mailbox this is. Add the openid, email and profile permissions to the app." });
        return;
      }
      try {
        const id = this.onSignedIn({
          email: who.email,
          name: who.name,
          refresh: r.body.refresh_token,
          access: r.body.access_token,
          expiresAt: Date.now() + Number(r.body.expires_in ?? 3600) * 1000,
          accountId,
        });
        Object.assign(flow, { state: "done", accountId: id, email: who.email });
      } catch (e) {
        Object.assign(flow, { state: "error", error: (e as Error).message });
      }
      return;
    }
  }
}

/**
 * The account with an access token good for the next few minutes, renewing it
 * from the refresh token when needed (Microsoft hands out a new refresh token
 * each time; the latest is kept).
 */
export async function freshAccount(db: DB, a: MailAccountRow, base = "https://login.microsoftonline.com"): Promise<MailAccountRow> {
  if (a.auth !== "microsoft") return a;
  if (a.oauth_access && (a.oauth_expires ?? 0) > Date.now() + 5 * 60_000) return a;
  if (!a.oauth_refresh) throw new MicrosoftError("This account needs to sign in with Microsoft again (Settings → Email).");
  const s = getSettings(db);
  const r = await post(`${base.replace(/\/+$/, "")}/${tenantOf(s)}/oauth2/v2.0/token`, {
    grant_type: "refresh_token",
    client_id: s.msClientId.trim(),
    refresh_token: a.oauth_refresh,
    scope: `${IMAP_SCOPE} offline_access`,
  });
  if (r.status !== 200 || typeof r.body.access_token !== "string") {
    const msg = friendlyMsError(String(r.body.error ?? ""), String(r.body.error_description ?? ""));
    // A refresh token that's been revoked or expired won't come back: ask for a new sign-in.
    if (r.body.error === "invalid_grant") db.prepare("UPDATE mail_accounts SET oauth_access = NULL, oauth_expires = NULL WHERE id = ?").run(a.id);
    throw new MicrosoftError(`${msg} Use “Sign in again” on the account in Settings → Email.`);
  }
  const access = r.body.access_token;
  const expires = Date.now() + Number(r.body.expires_in ?? 3600) * 1000;
  const refresh = typeof r.body.refresh_token === "string" ? r.body.refresh_token : a.oauth_refresh;
  db.prepare("UPDATE mail_accounts SET oauth_access = ?, oauth_expires = ?, oauth_refresh = ? WHERE id = ?").run(access, expires, refresh, a.id);
  return { ...a, oauth_access: access, oauth_expires: expires, oauth_refresh: refresh };
}
