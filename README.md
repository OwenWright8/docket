<div align="center">

<img src="web/public/icon-512.png" alt="" width="96" height="96" />

# Docket

**A to-do list that fills itself in.**<br/>
Type "I feed the dart frogs every other day and the gecko every other day" and get two repeating reminders. Docket reads your email for the things that matter and sends you one short summary of your day each morning, all with an AI running on your own PC.

[![Latest release](https://img.shields.io/github/v/release/OwenWright8/docket?sort=semver&label=release)](https://github.com/OwenWright8/docket/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/OwenWright8/docket/ci.yml?branch=main&label=CI)](https://github.com/OwenWright8/docket/actions/workflows/ci.yml)
[![Images on GHCR](https://img.shields.io/badge/images-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/OwenWright8/docket/pkgs/container/docket)
![amd64 | arm64](https://img.shields.io/badge/arch-amd64%20%7C%20arm64-555)
[![MIT license](https://img.shields.io/github/license/OwenWright8/docket)](LICENSE)

[Quickstart](#quickstart) · [Your local AI](#connecting-your-local-ai) · [Notifications](#notifications) · [Email](#email) · [Calendars and carrel](#calendars-and-carrel) · [Homepage widget](#homepage-widget) · [How it works](#how-it-works) · [Settings](#settings) · [FAQ](#faq)

</div>

## Why Docket

Reminder apps want you to fill in a form for every chore: title, date, repeat, every other day, from completion… Docket lets you type it the way you'd say it, and a model on your own machine does the form.

- **Say it, don't fill it in.** "Dentist Friday at 3pm", "pay rent on the 1st every month", "water the plants Mondays and Thursdays". One sentence can hold several tasks. You see what it understood before anything is saved.
- **Repeats that make sense for chores.** "Every other day" counts from when you actually did it: feed the frogs a day late and the next feeding moves too. Calendar repeats (every Tuesday, the 1st of the month) keep to the calendar. Each task remembers when you last did it.
- **Your email, sorted.** Docket reads your inbox (read-only) and picks out what needs you: bills, appointments, a professor's email. Promotions, newsletters and spam are filtered out. Email that asks you to do something becomes a suggested task, date included. One click adds it.
- **It learns your senders.** "Always show" or "Always ignore" a sender or a whole domain from any email. Your rules beat the AI.
- **A morning summary.** Every morning, a few sentences on what's overdue, what's on today, what's coming and which email needs you, pushed to your phone.
- **Reminders on your phone, with buttons.** Tasks with a time push through ntfy or Pushover when they're due, with **Done**, **Snooze** and **Tomorrow** right on the notification.
- **Nag mode.** For the things you can't let slide (feeding, meds): it pushes again every 10 minutes to 2 hours until it's done, and stays quiet overnight.
- **Your calendar and carrel.** Today's events from any calendar's private link, and assignments, readings, exams and quizzes from [carrel](https://github.com/OwenWright8/carrel), on your Today page and in the morning summary.
- **Waiting on a reply.** Email you sent that asked for something is tracked until the answer comes in, and you get one nudge if it doesn't.
- **Ask it things.** "When did I last feed the gecko?", "What's due this week?", "Did the vet ever get back to me?" End what you type with a question mark.
- **Outlook and school accounts.** Sign in with Microsoft for Outlook.com and Microsoft 365 work or school mail, which don't allow passwords.
- **Works when your PC is off.** Without the AI, quick add uses built-in rules (they handle all the examples above), email is sorted with basic checks, and the AI goes back over that email once it's reachable again.
- **Yours to run.** One small container, one volume, no accounts anywhere, and nothing sent to a cloud AI. Works on a Raspberry Pi.

## Self-hosting

Docket is a single container with a single volume. It talks to your AI server over the network, to your email over IMAP, and to Pushover or ntfy for notifications. Images are published for `amd64` and `arm64`.

### Quickstart

**1.** Save this as `docker-compose.yml`:

```yaml
services:
  docket:
    image: ghcr.io/owenwright8/docket:latest
    container_name: docket
    restart: unless-stopped
    environment:
      TZ: America/Indiana/Indianapolis   # your time zone: reminders and the summary go by it
    volumes:
      - docket-data:/data
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "8585:8585"

volumes:
  docket-data:
```

**2.** Start it:

```sh
docker compose up -d
```

**3.** Open `http://<your-server-ip>:8585`, create your account, and follow the three setup steps:

| Step | What you need |
|---|---|
| **Local AI** | Your PC's address and a model (see below). You can skip this and add it later. |
| **Notifications** | An [ntfy](https://ntfy.sh) server and topic, and/or a [Pushover](https://pushover.net) application token and user key. **Save and send a test** checks them. |
| **Email** | Optional. Gmail, iCloud, Yahoo, Fastmail or any IMAP server with an app password, or **Sign in with Microsoft** for Outlook and school / work accounts. |

That's it. Type your first task on the Today page.

### Connecting your local AI

Docket works with [Ollama](https://ollama.com), and with anything that has an OpenAI-style API ([LM Studio](https://lmstudio.ai), llama.cpp's `llama-server`, vLLM).

**Ollama on your PC** (Docket on another machine):

1. Install Ollama and pull a model: `ollama pull llama3.1:8b` (or `qwen2.5:7b`, `gemma3:12b`, `mistral-nemo`; anything instruction-tuned around 7B or larger does well).
2. Let other machines reach it: set the environment variable `OLLAMA_HOST=0.0.0.0` and restart Ollama. On Windows that's **Settings → System → About → Advanced system settings → Environment Variables**, then quit Ollama from the tray and start it again. Allow port 11434 through the firewall if Windows asks.
3. In Docket, **Settings → Local AI**: address `http://<your-pc-ip>:11434`, **Connect**, pick the model, **Try it**, **Save**.

**Ollama on the same machine as Docker:** use `http://host.docker.internal:11434` (the `extra_hosts` line in the compose file makes this work on Linux too).

**LM Studio:** turn on **Serve on Local Network** in its Developer tab, load a model, and use `http://<your-pc-ip>:1234` with the "LM Studio, llama.cpp or another OpenAI-style server" option.

The model is asked for JSON that matches a fixed shape, and every answer is checked before it's used: a date that makes no sense is dropped, a repeat is normalised, a category must be one of five. A small model that wanders off can't put nonsense in your list.

**About you** (in the same section) is a line or two the model keeps in mind: "I'm a student at Wabash (wabash.edu). I keep dart frogs and a leopard gecko. Anything from my bank or landlord is important." It makes a real difference to email sorting.

## Notifications

Set up **ntfy**, **Pushover**, or both, under **Settings → Notifications**.

**ntfy** works like Uptime Kuma's ntfy notification:

| Field | What to put |
|---|---|
| **Server URL** | Without the topic: `https://ntfy.sh`, or your own server. On the same Docker network as your ntfy container, its service name works: `http://ntfy:80`. |
| **Topic** | Any name; subscribe to the same topic in the ntfy app. On ntfy.sh, pick something hard to guess. |
| **Priority** | 1–5 (default 3). Urgent pushes (nags, high-priority tasks, email you need to act on) go one higher. |
| **Authentication** | None, **Username and password**, or an **Access token** (`tk_…`) for a protected topic. |

**Done / Snooze buttons.** Reminders come with **Done**, **Snooze 1 h** and **Tomorrow** (or **Skip** for a repeating task). On ntfy they're buttons on the notification itself; Pushover can't show buttons, so tapping its link opens a small page with them. Both need **Docket's address** (in the same section) to be one your phone can reach, like `https://docket.yourdomain.org` behind your reverse proxy or a VPN address. Each button is signed for that one task and due date, works without signing in, and stops working once the task has moved on.

**Nag mode.** In a task's editor, **Nag me** re-pushes it every 10, 15 or 30 minutes, or every 1 or 2 hours, after its time (a task with only a date starts at your summary time) until it's done or snoozed. Nags pause from 10 PM to 7 AM and stop after 12.

## Email

Docket connects to your mailbox over IMAP and opens the folder **read-only**: nothing is marked as read, moved or deleted. It checks every 15 minutes (you can change that) and, on the first check, looks back 3 days.

Most providers need an **app password** rather than your normal one:

| Provider | Where |
|---|---|
| Gmail | Turn on 2-Step Verification, then [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) |
| Outlook, Hotmail, Microsoft 365 work or school | **Sign in with Microsoft** (below): Microsoft doesn't allow passwords for IMAP any more |
| iCloud | [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords |
| Yahoo | Account security → Generate app password |
| Fastmail | Settings → Privacy & Security → App passwords, with IMAP access |

Each new email is sorted into one of:

| | What it is | Where it shows |
|---|---|---|
| **To do** | Asks you to do something: pay, reply, sign, book, show up | **Needs you**, with a suggested task, and a push |
| **Important** | Worth reading soon: a person writing to you, your school, bank, doctor, landlord, security alerts | **Needs you**, and a push |
| **FYI** | Legitimate but routine: receipts, shipping, notifications | **FYI** |
| **Promo** | Marketing, newsletters, sales | **Filtered** |
| **Spam** | Scams, phishing, junk | **Filtered** |

In order, Docket checks: **your sender rules** (always important / always ignore, by address or domain), then **the AI** (sender, subject, whether it came from a mailing list, and the first part of the text), and, if the AI can't be reached, **basic checks** (mailing-list headers, Gmail's own Promotions and Important labels, words like "payment due"). Email sorted without the AI is marked and goes back to the AI when it's reachable.

Only the sender, subject, a short excerpt and the AI's one-line summary are kept. The full body is held only until the AI has read it. Gmail messages get an **Open in Gmail** link.

### Outlook and school / work accounts (Sign in with Microsoft)

Microsoft turned off password sign-in for IMAP, so Outlook.com, Hotmail and Microsoft 365 accounts sign in with Microsoft instead. Docket uses Microsoft's **device code** sign-in: it shows a short code, you enter it at [microsoft.com/devicelogin](https://microsoft.com/devicelogin) on any device and sign in as usual (Authenticator, passkey, your school's sign-in page). It needs no redirect back to Docket, so it works on a plain `http://` LAN address.

**One-time setup:** register Docket as an app with Microsoft. It's free, and the steps are also in the app:

1. Sign in at [entra.microsoft.com → App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade). A school account can usually do this; if it says you don't have permission, use a personal Microsoft account with a free Azure account.
2. **New registration**, name it Docket, and under **Supported account types** choose **Accounts in any organizational directory and personal Microsoft accounts**. Leave the redirect URI empty.
3. **Authentication → Allow public client flows: Yes**, and save.
4. **API permissions → Add a permission → Microsoft Graph → Delegated**: `IMAP.AccessAsUser.All`, `offline_access`, `openid`, `email`, `profile`.
5. Paste the **Application (client) ID** into Docket (**Settings → Email → Add → Outlook, Hotmail, or school / work**), then **Sign in with Microsoft**.

**School and work accounts** are run by your organization's IT, and some policies get in the way. Docket says which one in plain words instead of an error code:

| What Docket says | What to do |
|---|---|
| IT has to approve this app | Your organization requires admin consent. Send IT the client id and ask them to grant consent for `IMAP.AccessAsUser.All`. |
| Your organization blocks this kind of sign-in | A Conditional Access policy blocks device-code sign-in. Ask IT, or forward your school mail to an account Docket can read. |
| Won't open the mailbox over IMAP | IMAP is switched off for your mailbox. IT can turn it on for you. |
| Only lets assigned people use this app | IT has to assign the app to you. |

If IT approved the app for your organization only, set **Accounts** (next to the client id) to your school's domain, like `wabash.edu`, instead of `common`. The mailbox is the account's sign-in name from Microsoft (e.g. `you@school.edu`). Docket keeps a refresh token in the data volume and renews the short-lived access token before each check. If Microsoft ever asks you to sign in again (a password change, or IT revoking sessions), the account shows **Needs sign-in** and **Sign in with Microsoft again** fixes it.

### Waiting on a reply

With **Watch for replies** on (per account; on by default), Docket also reads your **Sent** folder, read-only. The AI picks out what you sent that expects an answer, like a question or a request. Thank-yous and FYIs are left out. Each one waits in **Inbox → Waiting on** until a reply arrives, matched by the email's thread headers or the same person and subject. After 3 days (you can change this) without one, you get a single push and it's mentioned in the morning summary. **Follow-up task** turns it into a task for today.

Got one wrong? Use **Move to** in the email's menu, or **Always show / Ignore** the sender, which also re-sorts the email you already have from them.

## Calendars and carrel

**Settings → Calendars and carrel** adds:

- **Any calendar** by its private iCalendar (`.ics`) link. In Google Calendar, open a calendar's settings → **Integrate calendar → Secret address in iCal format**. In iCloud, share the calendar as a Public Calendar and copy the `webcal://` link. In Outlook.com, go to **Settings → Calendar → Shared calendars → Publish a calendar** and copy the ICS link. Repeating events, moved or cancelled occurrences, all-day and multi-day events and time zones are all handled. The private link is never sent back to the browser.
- **carrel**: its address, your email and password. Docket signs in to carrel's API as you and reads assignments, readings, exams and quizzes from your current courses (archived courses are skipped). Mark things done in carrel; they drop off Docket on the next read.

Both are read every 30 minutes and never changed. Today's items show in a **Schedule** card on the Today page (school work past due and coming this week under it), and in the morning summary and the ask box.

## Asking questions

Type a question ending in `?` into the box on the Today page ("when did I last feed the gecko?", "what do I have Thursday?", "did Prof. Lee reply about the extension?"). Your local AI answers from your open tasks, the last 90 days of what you did, your calendar and carrel, and recent email. It's told to say so when it doesn't know rather than guess. If it was actually a task, **It was a task, add it** adds it.

## Homepage widget

Show today's numbers on a [Homepage](https://gethomepage.dev) dashboard with its [Custom API widget](https://gethomepage.dev/widgets/services/customapi/). **Settings → Homepage widget → Create key** shows the key once with a ready-to-paste snippet:

```yaml
- Docket:
    icon: http://<docket>:8585/icon-192.png
    href: http://<docket>:8585/
    widget:
      type: customapi
      url: http://<docket>:8585/api/widget
      refreshInterval: 60000
      headers:
        X-Api-Key: dkt_your_key_here
      mappings:
        - field: due_today
          label: Today
          format: number
        - field: overdue
          label: Overdue
          format: number
        - field: inbox
          label: Email
          format: number
        - field: waiting
          label: No reply
          format: number
```

Also returned: `done_today`, `open`, `events_today`, `next_task`, `next_event`, and `ai` (`online`, `offline` or `off`). Keys only read these numbers, are stored hashed, and can be revoked in Settings.

## How it works

```mermaid
flowchart LR
    A["You type<br/>“feed the gecko<br/>every other day”"] --> B["Your local AI<br/>(or the built-in rules)"]
    B --> C["You check it<br/>and add"]
    C --> D["Today / Tasks"]
    E["Your inbox<br/>(IMAP, read-only)"] --> F["Sender rules → AI<br/>→ basic checks"]
    F --> G["Inbox: needs you,<br/>FYI, filtered"]
    G -- "suggested task" --> D
    D --> H["Reminders and the<br/>morning summary<br/>(Pushover / ntfy)"]
    G --> H
```

Every 30 seconds the server:

1. **Sends reminders** for tasks whose time has come (at the time, or up to an hour before). A reminder more than two hours late, because the server was off, is skipped rather than sent stale.
2. **Writes the morning summary** once the summary time passes, and pushes it. Set up at 9 PM? Today's summary is written for the app but not pushed.
3. **Checks email** for each account on its interval.
4. **Catches up** on email the AI missed while it was unreachable (every 10 minutes).

**Repeating tasks** are a single task whose date moves forward. **Done** moves it to the next date and records it in the task's history; **Skip this time** moves it without recording it as done; **Undo** puts it back. For repeats counted in days, the next date is counted from the day you did it; for weekdays, weeks, months and years it keeps to the calendar. You can change this per task.

## Settings

Everything is configured in the web UI. The compose file only takes these, all optional ([`.env.example`](.env.example) lists them):

| Setting | What it does |
|---|---|
| `TZ` | Your time zone. "Today", reminder times and the summary time all use it. |
| `APP_PORT` | The port published on the host when using this repo's `docker-compose.yml` (default `8585`). |
| `UPDATE_CHECK` | `off` stops the server checking GitHub for new releases (default `on`). |
| `DOCKET_VERSION` | Pin a release (`v1.0.0`) or a minor series (`1.0`) instead of `latest`. |

And in **Settings** in the app:

| Setting | Default | What it does |
|---|---|---|
| **Daily summary** | On, 7:00 AM, pushed | When the morning summary is written and whether it's pushed. |
| **Push reminders** | On, at the time | Push tasks with a time, at the time or up to an hour before. Date-only tasks appear in the summary instead. |
| **Push email that needs you** | On | Push To do and Important email as soon as it's sorted (four or more at once arrive as one push), and once when something you sent has had no reply. |
| **Waiting on a reply** | 3 days | How long before unanswered email you sent is flagged. |
| **Check every** | 15 min | How often each email account is checked. |
| **First check looks back** | 3 days | How far back the first check of a new account goes. |
| **Docket's address** | — | Tapping a notification opens this. |

## Updating

```sh
docker compose pull && docker compose up -d
```

The database migrates itself. When a new release is out, the sidebar shows a note linking to its release notes, and **Settings → About → Check for updates** checks straight away. The check is one anonymous request to GitHub every 6 hours; `UPDATE_CHECK=off` stops it.

## Backups

Everything (tasks and their history, settings, email account logins, sorted email and summaries) is one SQLite database in the `docket-data` volume. From the folder with your `docker-compose.yml`:

```sh
docker compose stop
docker run --rm -v "$(basename "$PWD")_docket-data":/data -v "$PWD":/backup alpine \
  tar czf "/backup/docket-$(date +%F).tar.gz" -C /data .
docker compose start
```

## Security notes

Found a security problem? Please report it privately; see [SECURITY.md](SECURITY.md).

- **One account.** Sign-in attempts are rate limited per client address.
- **Secrets stay on the server.** Email passwords and notification keys are stored in the data volume and never sent to the browser. Treat the volume like a `.env` file, and use app passwords so you can revoke Docket's access on its own.
- **Read-only email.** Mailboxes are opened read-only. Email text goes only to the AI server you configured. Microsoft accounts give Docket a token for IMAP only; revoke it any time at myaccount.microsoft.com → Apps.
- **Notification buttons are signed.** `/act` and `/api/act` work without a session, but each link is an HMAC for one task at one due date, so it can't be used on anything else and goes stale once the task moves on.
- **Email is untrusted.** The model is told to treat email as data, and its answers are checked against a fixed shape, so the most a crafted email can do is get itself misfiled or suggest a task you then decline.
- **Use HTTPS if it's reachable from outside your network.** The container speaks plain HTTP; put it behind your reverse proxy or keep it on your LAN / VPN.
- **Hardened container.** It runs as an unprivileged user, and this repo's compose file also runs it with a read-only filesystem and `no-new-privileges`.

## FAQ

**Do I need the AI at all?**<br/>
No. The built-in rules understand dates ("Friday", "Nov 20", "in 3 days"), times ("at 5pm", "tomorrow evening") and repeats ("every other day", "Mondays and Thursdays", "the 1st of every month"), and split "X every other day and Y every other day" into two tasks. Email sorting without the AI is cautious but useful. The AI adds better titles and lists, harder sentences, email summaries and suggested tasks, and the written briefing.

**My PC isn't on all the time. What happens?**<br/>
Docket notices (the dot at the bottom of the sidebar turns red) and carries on with its built-in rules. Email that arrived meanwhile is re-sorted by the AI when it's back.

**Which model should I use?**<br/>
Something instruction-tuned around 7–8B parameters or larger: `llama3.1:8b` and `qwen2.5:7b` are good starting points on a gaming GPU. Smaller models work but make more mistakes with dates.

**Does it work with Gmail's "Primary" tab?**<br/>
Docket reads the whole inbox and does its own sorting, but uses Gmail's Promotions, Social and Important labels as hints when the AI isn't available.

**Running it bound to a host folder instead of a named volume?**<br/>
Make the folder writable by uid 1000 (`sudo chown 1000:1000 ./data`), since the container doesn't run as root.

---

## Development

Needs Node 24 (the server is TypeScript that Node runs directly, using its built-in SQLite).

```sh
npm ci
npm run dev        # API on :8585, UI on http://localhost:5173
npm test           # unit tests, and the API end to end against a fake Ollama and mailbox
```

`npm run build && npm run dev:demo` runs the real app on :8585 with a fake Ollama (on :11500) and a mailbox of sample email, so every page can be tried without a model or a real account. Point **Local AI** at `http://127.0.0.1:11500` and add any email account; the details are ignored.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs and send changes.

### Releasing

Push a tag like `v1.0.0`. The release workflow creates the GitHub Release with notes grouped by PR label (`feature`, `fix`, `breaking`…; see `.github/release.yml`) and publishes the image as `:v1.0.0`, `:1.0` and `:latest` for amd64 and arm64.

## License

[MIT](LICENSE) © 2026 Owen Wright
