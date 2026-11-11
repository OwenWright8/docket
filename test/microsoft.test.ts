// "Sign in with Microsoft" for Outlook and school / work accounts, against a fake Microsoft.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.ts";
import { buildApp } from "../server/app.ts";
import { friendlyMsError } from "../server/microsoft.ts";
import { FakeMailbox, startFakeMicrosoft } from "../scripts/fakes.ts";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const mailbox = new FakeMailbox();
let ms: Awaited<ReturnType<typeof startFakeMicrosoft>>;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
const api = async (method: string, url: string, body?: unknown) => {
  const r = await ctx.app.inject({ method: method as "GET", url: `/api${url}`, payload: body as object, headers: { cookie } });
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
};

/** Starts a sign-in and waits for it to finish, like the Settings page does. */
async function signIn(accountId?: number) {
  const start = await api("POST", "/microsoft/sign-in", accountId ? { accountId } : {});
  if (start.status !== 200) return start.json;
  assert.equal(start.json.userCode, "ABCD-1234");
  for (let i = 0; i < 40; i++) {
    const f = (await api("GET", `/microsoft/sign-in/${start.json.id}`)).json;
    if (f.state !== "pending") return f;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sign-in never finished");
}

before(async () => {
  ms = await startFakeMicrosoft();
  ctx = await buildApp({ db: openDb(":memory:"), version: "t", repo: "x/y", updateCheck: false, mail: mailbox, microsoftBase: ms.url, send: async () => [] });
  const r = await ctx.app.inject({ method: "POST", url: "/api/account/create", payload: { username: "owen", password: "correct horse" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  await api("PUT", "/settings", { setupComplete: true });
});

after(async () => {
  await ctx.app.close();
  await ms.close();
});

test("needs the app's client id, and checks it looks like one", async () => {
  assert.match((await api("POST", "/microsoft/sign-in")).json.error, /client id first/);
  assert.equal((await api("PUT", "/settings", { msClientId: "not-a-guid" })).status, 400);
  assert.equal((await api("PUT", "/settings", { msClientId: "99999999-2222-3333-4444-555555555555" })).status, 200);
  assert.match((await api("POST", "/microsoft/sign-in")).json.error, /doesn't know that client id/);
  await api("PUT", "/settings", { msClientId: CLIENT_ID, msTenant: "common" });
});

test("a school account: signs in, mailbox named by its UPN, read with a token", async () => {
  const f = await signIn();
  assert.equal(f.state, "done", f.error);
  assert.equal(f.email, "odwright28@wabash.edu");
  const acct = (await api("GET", "/mail-accounts")).json.find((a: any) => a.id === f.accountId);
  assert.deepEqual([acct.host, acct.username, acct.auth, acct.label, acct.needsSignIn], ["outlook.office365.com", "odwright28@wabash.edu", "microsoft", "wabash.edu", false]);
  await ctx.engine.checkMail();
  assert.equal(mailbox.lastLogin?.auth, "microsoft");
  assert.equal(mailbox.lastLogin?.oauth_access, "access-1");
  assert.equal(mailbox.lastLogin?.password, ""); // no password anywhere
});

test("an expired access token is renewed from the refresh token before checking", async () => {
  ctx.engine.db.prepare("UPDATE mail_accounts SET oauth_expires = ? WHERE auth = 'microsoft'").run(Date.now() - 1000);
  await ctx.engine.checkMail();
  assert.equal(ms.refreshes, 1);
  assert.equal(mailbox.lastLogin?.oauth_access, "access-2");
  const row = ctx.engine.db.prepare("SELECT oauth_refresh FROM mail_accounts WHERE auth = 'microsoft'").get() as { oauth_refresh: string };
  assert.equal(row.oauth_refresh, "refresh-2"); // Microsoft's newest refresh token is kept
  // Fresh enough: no renewal.
  await ctx.engine.checkMail();
  assert.equal(ms.refreshes, 1);
});

test("a revoked sign-in says to sign in again, and signing in again keeps the account", async () => {
  ctx.engine.db.prepare("UPDATE mail_accounts SET oauth_expires = 0, oauth_refresh = 'revoked' WHERE auth = 'microsoft'").run();
  const [r] = await ctx.engine.checkMail();
  assert.match(r.error!, /sign in again/i);
  const id = (await api("GET", "/mail-accounts")).json[0].id;
  const f = await signIn(id);
  assert.equal(f.state, "done");
  assert.equal(f.accountId, id);
  assert.equal((await api("GET", "/mail-accounts")).json.length, 1);
  ms.account.email = "someone.else@wabash.edu";
  const wrong = await signIn(id);
  assert.match(wrong.error, /this account is odwright28@wabash\.edu/);
  ms.account.email = "odwright28@wabash.edu";
});

test("school policies come back as plain reasons", async () => {
  ms.outcome = "65001";
  assert.match((await signIn()).error, /IT has to approve this app/);
  ms.outcome = "90094";
  assert.match((await signIn()).error, /admin consent/);
  ms.outcome = "53003";
  assert.match((await api("POST", "/microsoft/sign-in")).json.error, /blocks this kind of sign-in/);
  ms.outcome = "ok";
  assert.match(friendlyMsError("invalid_client", "AADSTS7000218: The request body must contain client_assertion"), /Allow public client flows/);
});

test("a personal Outlook.com account works the same way", async () => {
  ms.account = { email: "owen.w@outlook.com", name: "Owen", tid: "9188040d-6c67-4c5b-b112-36a304b66dad" };
  const f = await signIn();
  assert.equal(f.state, "done");
  const acct = (await api("GET", "/mail-accounts")).json.find((a: any) => a.username === "owen.w@outlook.com");
  assert.equal(acct.label, "Outlook");
});
