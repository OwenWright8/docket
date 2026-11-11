# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately instead:
[**Report a vulnerability**](https://github.com/OwenWright8/docket/security/advisories/new) (on the repo's **Security** tab).

Say what you found, which version (Settings → About shows it), and how to reproduce it if you can. You'll get a reply within a week. Once it's fixed in a release, the advisory is published, with credit to you if you'd like.

## Supported versions

Only the latest release gets fixes. Updating is a `docker compose pull && docker compose up -d`; see [Updating](README.md#updating).

## What's in scope

Docket holds the passwords for your email accounts and your notification keys, so these matter most:

- Getting past the sign-in, or reading or changing anything without a session
- Getting an email password, Pushover key or ntfy token out of Docket
- An email's content making Docket do something other than sort it (a message that tricks the model into creating tasks or alerts is worth reporting, even though the worst it can do is put a wrong suggestion in the inbox)
- Docket changing anything in a mailbox (it should only ever read)

Out of scope: problems that need someone who's already signed in to Docket (it's your account), Ollama's or your mail provider's own vulnerabilities (report those upstream), and running Docket on the open internet without HTTPS (see [Security notes](README.md#security-notes)).
