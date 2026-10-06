# Callback

**Who to call today, and where each job is at.** This is a working prototype for Denise, who runs a commercial refrigeration repair company with four techs. Every morning it tells her who's waiting on her and why. It also makes sure no request goes quiet, like the Friday "freezer down" call that turned into a $2,000 job lost to a competitor.

<p>
  <img src="docs/screenshots/today.png" width="240" alt="Today: 10 people to call, the Friday freezer voicemail at the top in red">
  <img src="docs/screenshots/sheet.png" width="240" alt="After a call: one tap to log what happened">
  <img src="docs/screenshots/job.png" width="240" alt="Job history: the voicemail, the reminder texts, and Monday's list">
</p>

- **Why I built this, and what I left out:** [docs/WRITEUP.md](docs/WRITEUP.md)
- **3-minute demo script:** [docs/DEMO.md](docs/DEMO.md)
- **Full build spec:** [docs/SPEC.md](docs/SPEC.md)

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:3000>. It's built for a phone, so narrow the browser window or open it on your phone over Wi-Fi.

- **Requirements:** Node 22.13+. It uses Node's built-in SQLite, so there is no database to install. It needs no API keys and no paid services.
- **First boot:** it seeds a realistic demo week and sets a **demo clock** to the most recent Monday 7:00am, the morning after the Friday freezer call.
- **Reset:** **Demo controls → Reset demo** (or `npm run seed`) restores that starting point.
- **Optional AI:** set `ANTHROPIC_API_KEY` to have Claude Sonnet (`claude-sonnet-5-5`) read messy texts and emails. At 20–40 messages a week that's well under $1 a month. Without a key, a free rule-based parser does the reading, and that's what the demo uses.

## What's in it

| Screen | What Denise does there |
|---|---|
| **Today** | Sees one ranked list of who to call and why, under headings in her own words: *Urgent - call first · They got back to you · New - call them back · Said yes - needs scheduling · Waiting on your quote · Waiting on their yes - check in · Did it get done?*. Call and Text use her own phone, and texts come pre-written. |
| **How'd it go?** | After a call, one tap: *No answer · Quote sent · They said yes → day → tech · Not today · Lost*. Every answer sets when the job comes back. Each answer can be undone for 6 seconds. |
| **Jobs** | Where every job is: *New · Waiting on quote · Waiting on their yes · Said yes - needs scheduling · Scheduled · Done · Lost*, with search and full history. |
| **+ New** | Paste or dictate a text, email or notebook line, and the fields fill in. **Brain dump** moves the whole notebook over, one job per line. |
| **Numbers** | Answers her husband's "how many open jobs?". One button texts him the summary. |
| **Texts to Denise** | A 7:00am "who to call" text, a Friday 3pm "before the weekend" text, and a reminder when a new lead sits untouched. They go through an outbox and send via Twilio when configured. |
| **Demo controls** | Moves the clock, simulates inbound texts, calls and emails through the real webhooks, and shows the outbox. Only appears when `DEMO=1`, which is the default outside production. |

**The rule that makes it work.** Every open job always has a next date, and the database enforces this with a CHECK constraint. Today is every open job whose date has arrived, plus every customer who wrote back. Nothing leaves the list until Denise says what happened.

## How it's built

```
shared/      Pure ES modules used by both server and browser. They take `now` as an argument and never read the clock.
  time.js        business days + time-zone math (DST-safe)
  stages.js      the 7 stages; what each "How'd it go?" answer does
  today-rules.js who's on Today, in what order, and the reason line; morning/Friday/reminder texts
  parse.js       rule-based reader for texts, emails, voicemails and notebook lines
  stats.js       Numbers
  templates.js   pre-written texts to customers and techs
server/      Node + Express 5 + built-in SQLite
  ingest.js      ONE intake pipeline: store raw → dedupe → match customer → attach or create → optional AI refine
  adapters.js    Twilio SMS/voice, Postmark, Mailgun, raw email, website-form adapters (+ signature checks)
  routes/        api.js (the app's JSON API), inbound.js (webhooks), sim.js (demo only)
  scheduler.js   7am digest, Friday sweep, untouched-lead reminders (idempotent; outbox)
  notify.js      outbox + Twilio sender (simulated without keys)
  ai.js          optional Claude extraction with structured outputs; never blocks or loses a lead
  db.js, repo.js schema and queries
  seed.js        demo seed: replays the Friday-to-Monday weekend through the real code paths
  runtime.js     boot steps shared by index.js and the Vercel entry
api/         index.js: the Vercel demo function (always a demo; SQLite in /tmp)
public/      Preact + htm, no build step; phone-first, light/dark
test/        node:test, unit + integration (in-memory SQLite, real HTTP)
scripts/     e2e.mjs: the demo script, walked in headless Chrome
```

```bash
npm test        # the whole suite runs in a few seconds
npm run e2e     # walks docs/DEMO.md in headless Chrome on its own server (set CHROME_PATH if Chrome isn't in /Applications)
```

## Going live

The prototype runs every channel through the same `ingest()` the demo simulator uses. Making a channel live means pointing it at a URL.

| Channel | Point it at | What changes for Denise |
|---|---|---|
| Website form (if the form builder has webhooks) | `POST {PUBLIC_URL}/api/inbound/form` | Nothing |
| Website-form emails (Gmail filter → Postmark/Mailgun inbound) | `/api/inbound/email` | Nothing. Her inbox stays the same, and duplicates are dropped by Message-ID. The form mailer's address is never taken for the customer; the customer is read from the form. |
| Customer texts (Twilio number) | `/api/inbound/sms` | Forwards texts to a "New Job" contact. Later, customers text it directly. |
| Missed calls / voicemail (carrier "forward when unanswered" → Twilio) | `/api/inbound/call` | Nothing. One carrier setting, which she can undo. |
| Texts to Denise | set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Nothing |

There is one address per channel, and **Settings → For whoever sets this up** lists all four (with `?token=` when `INBOUND_TOKEN` is set).

Configuration lives in [`.env.example`](.env.example). Copy it to `.env`, which is read at start when it exists. For a real deployment, set:

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | Turns off the demo (seed data, demo clock, Demo controls), whatever `DEMO` says. |
| `APP_PASSCODE` | Required in production. |
| `SESSION_SECRET` | Optional. Signs the login cookie. When blank, one is generated once and kept in the database, so restarts don't log Denise out. |
| `PUBLIC_URL` | The public https address. Used for links in texts and for signature checks. With signature checks on, production won't start without it. |
| `INBOUND_TOKEN` | Webhooks then need `?token=`. |
| `TWILIO_AUTH_TOKEN` / `MAILGUN_SIGNING_KEY` | Turn on signature checks: every request to the text and call webhooks needs a valid Twilio signature, and every request to the email webhook a fresh Mailgun one. |
| `BUSINESS_TZ` | The business time zone. Default `America/Chicago`. |

SQLite lives at `DB_PATH`. Back it up nightly. One small VM with HTTPS in front is enough for 20 jobs a week.

## Deploy a demo

The app is one long-running Node process with a SQLite file. Render or any Docker host runs it as it is. Vercel can run the demo, but only the demo: it has no lasting disk for the database and no always-on process for the 7am text and reminders.

**Render (free, uses [`render.yaml`](render.yaml))**
1. In Render, choose **New → Blueprint** and pick this repo. It builds the [`Dockerfile`](Dockerfile) with `DEMO=1`.
2. Set `PUBLIC_URL` to the Render address, and optionally `APP_PASSCODE`.
3. Leave `ANTHROPIC_API_KEY` unset on a public demo, or anyone with the link can spend your credits.

The free plan sleeps after 15 idle minutes, so the first visit takes up to a minute. Its disk is temporary, so every restart re-seeds the demo week.

**Vercel (demo only, uses [`vercel.json`](vercel.json))**
1. In Vercel, choose **Add New → Project**, import this repo and click **Deploy**. It needs no settings. `vercel.json` serves the page and its modules from Vercel's CDN and sends `/api` and `/n` to one function, [`api/index.js`](api/index.js).
2. Recommended: in **Settings → Environment Variables**, add `NODEJS_HELPERS=0`. That is Vercel's documented switch for handing raw requests to the app; the function already avoids the helpers, and this makes it certain.
3. Optional passcode: set `APP_PASSCODE` **and** `SESSION_SECRET` (any long random string). Without `SESSION_SECRET`, each instance signs logins with its own secret, so visitors get asked again.
4. Leave `ANTHROPIC_API_KEY` unset, or anyone with the link can spend your credits.

Share the production address (`<project>.vercel.app`). By default Vercel puts preview and per-deployment addresses behind a Vercel login.

What to expect:
- **It is always the demo.** The function turns on demo mode in code and keeps SQLite in `/tmp`, so it can't hold real data. No environment variable can do the same to a regular server: under `NODE_ENV=production`, `server/index.js` is never a demo.
- **The data doesn't last.** Each function instance keeps its own demo data in `/tmp`. A cold start or a second instance shows a freshly seeded Monday 7:00am week, so changes don't last.
- **Scheduled texts wait for a visit.** There is no always-on process, so the 7am text, the Friday sweep and the reminders are checked when someone uses the app (at most once a minute). **Demo controls** move the clock as usual.
- **Smaller inbound emails.** Vercel caps a request at 4.5 MB, so an inbound email with large photos is refused there. Docker and Render accept up to 25 MB.

For anything real, use Docker or Render with a persistent disk.

**Any Docker host**

```bash
docker build -t callback .
docker run -p 3000:3000 -e DEMO=1 -v callback-data:/data callback
```

For Denise's real data, set `NODE_ENV=production`, `APP_PASSCODE` and `PUBLIC_URL`, and keep `/data` on a persistent volume.
