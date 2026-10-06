# Callback: detailed spec

This is the detailed reference behind the prototype: what goes on Today and in what order, what each button does, how messages come in, and what the texts say.

- **Why I built it this way:** [WRITEUP.md](WRITEUP.md).
- **How to run and demo it:** [README](../README.md) and [DEMO.md](DEMO.md).

The spec is exact on purpose. Many strings and expected outputs here, like the Monday-morning list for the demo week in §12.3, are asserted word for word by the tests. **Section R lists what changed after the independent review. Where R and the body disagree, R wins.**

## R. Revisions after the review

An independent review of the working build tested intake integrity, security, the rules, the UX and the code. A second round then re-checked the fixes. Each confirmed finding is fixed with a regression test, and the two rounds produced these rule changes:

1. **Customer identity (§7.3).**
   - **Never an identity:** relay and system senders (no-reply, form-service domains, wordpress@…) and Denise's own address (setting `owner_email`).
   - **Form notifications:** the customer comes from the form. A non-relay Reply-To also counts.
   - **Denise's own forwards:** known by the customer quoted inside, from the first `From:` line after the forward marker. A forward from anyone else keeps its sender as the customer. Until `owner_email` is set, a forward from an address no customer has is taken as hers.
   - Reply-To beats From.
   - When a message carries a phone number that matches no one, it isn't matched by email instead. The exception: a customer writing from their own address, once `owner_email` is set; the new phone then only fills a blank.
   - Quick Add and Brain dump link to an existing customer only on a phone match, or an email match when no phone was typed.

   *Why:* website-form notifications all come from one `no-reply@` address, so different customers' leads were being merged into one job.
2. **Calls (§7.2).**
   - A call counts as answered only when Twilio reports that the forwarded leg to Denise was answered (`DialCallStatus=completed`).
   - When a carrier forwards a call she didn't answer and the caller hangs up during the greeting, that is a **missed call**, which creates a job. Before, it was ignored as "answered, under 15 s".
   - A recording or transcript upgrades the call to a voicemail.
   - Every callback for the same call is a duplicate unless it brings the recording.
3. **One URL per channel:** `/api/inbound/{sms,call,email,form}`.
   - With `TWILIO_AUTH_TOKEN` set, every request to the SMS and call paths needs a valid Twilio signature.
   - With `MAILGUN_SIGNING_KEY` set, email needs a fresh, unreplayed Mailgun signature.
   - `INBOUND_TOKEN` guards all four paths.
4. **Quick Add on a customer who has an open job.** Quick Add offers "Add this to that job" (the default) or "It's a new job". It no longer creates a duplicate.
5. **Brain dump.** Imported lines never send "Still not called back" texts. They don't count as this week's new or won work. A line ending "call back Fri" is due Friday.
6. **"Needs a quote for more work"** on a visit marks that visit **done** and opens a new job for the extra work, waiting on her quote. Undo reverts both. *Why:* before, one quote counted as both Won and Waiting on a yes.
7. **Undo** restores only what the action changed, so it never wipes details the AI filled in afterwards.
8. **Texts to Denise.** A text that fails to send is retried on later checks, up to 3 attempts in its window. It is never recorded as sent. Today shows "Texts to your phone aren't going through" until texts get through again.
9. **Wording:**

   | Where | Before | After |
   |---|---|---|
   | Waiting chips | "4d 20h" | "Waiting 4d 20h" |
   | "Not today" toast | — | "OK, it'll be back on your list Wed." |
   | Today footer | "…Snoozed: 1" | "Scheduled today: 1 · Put off till later: 1" |
   | Empty state | — | "All caught up. Nobody's waiting on you." (or "Nothing due right now." when some jobs are put off) |
   | Scheduled job whose customer asked for a new day | — | Offers "Move to Wednesday?" |

10. **Configuration.**
   - Demo mode is always off when `NODE_ENV=production`.
   - The session secret persists in the database when `SESSION_SECRET` is unset.
   - Links in texts use the real port when `PUBLIC_URL` is unset.
   - `.env` is read without Node's warning.
   - AI parsing uses **Claude Sonnet** (`claude-sonnet-5-5`); `ANTHROPIC_MODEL` overrides it.

11. **Attachments.** `/api/inbound/email` accepts up to 25 MB, including `multipart/form-data` (Mailgun) and Postmark JSON with photos. Attachment contents are never stored; their name, type and size are. The message notes "[N attachment(s)]". `INBOUND_TOKEN` is checked before the body is read.
12. **Quick Add attach guard.** "Add this to that job" sends `expected_customer_id`. The server answers 409 `attach_mismatch` ("That text looks like it's from someone else. Add it as a new job instead.") when either is true:
    - the job belongs to someone else;
    - the pasted text's phone differs from that customer's.
13. **Unblocking.** Bringing back a job that "Not a job" had blocked also unblocks the number ("Brought back - unblocked the number").
14. **Text retries.** A failed text is retried 15 minutes after the first try and 45 minutes after the second, at most 3 tries, inside its window. A text stuck "sending" for 5 minutes counts as failed.
15. **Day picker and links.**
    - The day the customer asked for carries an "asked" tag.
    - A day more than 6 days out is labelled by its date ("Mon Oct 12").
    - "Scheduled today" opens Jobs filtered to today's visits.
16. **Vercel demo entry.** `api/index.js` runs the app as one Vercel function:
    - It is always a demo. That is decided in code; no environment variable can make `server/index.js` a demo in production.
    - SQLite lives in `/tmp`, one copy per instance.
    - The scheduler is checked on requests, at most once a minute.
    - The page and the `shared/` modules come from the CDN.

## 0. Engineering conventions

**0.1 Stack.**
- Node ≥ 22.13: built-in `node:sqlite`, ESM, Express 5.
- A no-build Preact + htm front end (vendored in `public/vendor/`).
- `node:test` for the tests.
- Runtime dependencies are only `express`, `@anthropic-ai/sdk` and `zod`. `puppeteer-core` is used only by `npm run e2e`.

**0.2 Rules are pure functions.**
- `shared/` modules are browser-safe ESM: no `node:*` imports.
- Each takes `now` (an ISO string) and a time zone, or `ctx = {now, tz, settings, publicUrl}`, and never reads the system clock.
- The server reads the (demo-aware) clock once, at the HTTP or scheduler edge, and passes it down.
- That is what makes weekends, daylight-saving changes and the demo week testable to the exact string.

**0.3 Data.**
- snake_case everywhere: DB column = JSON field = JS key.
- Instants are ISO UTC strings. Local dates are `YYYY-MM-DD` in the business time zone (default `America/Chicago`).
- Money is whole dollars.
- The front end talks to the server only through `public/api.js`.

**0.4 Text formats checked by tests.**
- The weekday and weekend digests join their lines with `"\n"`:
  1. the header line;
  2. up to 6 lines of the form `"{i}. {title} - {reason}"`;
  3. `"+{k} more."` on its own line, when there are more;
  4. `"Open: {publicUrl}/#/"` as the last line.
- The zero-card weekday digest is a single line. So are the Friday sweep and each reminder.

**0.5 Visual design.**
- **Overall feel:** a calm, sturdy work tool. Think of a well-kept clipboard on a truck dashboard, not a SaaS dashboard. Big, readable type and generous spacing. Few colours, each with a meaning.
- **Colour tokens** (light/dark):

  | Token | Light | Dark | Used for |
  |---|---|---|---|
  | `--accent` | #1D6FB8 | #5AA8E6 | Primary actions only |
  | `--red` | #C3281E | #FF6B61 | Urgent |
  | `--amber` | #A86400 | #F0B43C | Waiting |
  | `--green` | #2D7A35 | #67BE6E | Done |

- **Type:** system font, 17px base.
- **Cards:** a 4px left edge in the bucket's tone; **Call** and **Text** buttons on the right, at least 48×48px.
- **Layout:** one 520px column, no sideways scroll at 375px, 16px gutters.
- **Motion:** 150–200ms, off under `prefers-reduced-motion`.
- **Accessibility:** real buttons and links, visible focus, `aria-modal` sheets with focus kept inside, and status shown with colour **and** text.

**0.6 Scope of the prototype.**
- Everything marked MUST and SHOULD in §2 is built, plus:
  - Text a tech;
  - blocking a number (via "Not a job");
  - CSV export;
  - Twilio and Mailgun signature checks;
  - dark mode;
  - an automatic reply to new callers, built but OFF by default.
- Not built: Mailgun multipart uploads, an email digest, a Monday text to her husband, moving a message to another job, and fuzzy "same customer?" matching by name.

---

## 1. Problem framing (in Denise's words) and core insight

**What she asked for**
- "I just want to wake up and know who I need to call today."
- "Who to call today, and where each job is at. Waiting on quote, waiting on their yes, scheduled, done. That is it. If it just did that I would use it every single morning."

**What it costs her**
- "Last week a restaurant called on a Friday, freezer down, and I forgot to follow up because I was slammed, and by Monday they had called someone else. That is a two thousand dollar job gone."
- "If someone is waiting on me and I forget, that is money walking out the door."

**Why it happens**
- "It is not a huge volume, it is just that I drop the ball because it is scattered in five places." The five places are:
  - the office line, which rings her cell;
  - the website-form inbox;
  - texts from repeat customers and referrals;
  - a notebook;
  - her memory.
- "Did I send the quote? Did they say yes? Is tech scheduled? I do not have a good picture."

**Second user:** "My husband keeps asking me for numbers and I cannot even tell him how many open jobs we have."

**Limits:** "I do not need anything fancy." On tech schedules: "That would be nice later but I kind of know where everyone is."

**Diagnosis, in order of importance**
1. **Main leak: nothing makes her follow up.** She took the Friday call. The job was lost because nothing gave it a next step with a date that would still be there after her busy moment passed.
2. **Second leak: getting jobs in depends on her writing them down.** That writing happens in five different places.

**Core insight.** Nobody should have to keep the morning list up to date by hand. Instead, the app works it out from the jobs.
- Every job sits in one of her stages, and the stage says whose move it is.
- Every open job always has a next-action date (`next_due_at`), and a database CHECK constraint enforces this. The date says when the job comes back.
- Today is every open job whose date has arrived, plus every customer who has written back. The list is ranked, and each item has a plain-English reason.
- Her only input is one tap after a call. That tap sets the next date.
- Nothing leaves the list until she says what happened.
- Pulling every channel into one list is the second fix, not the first.

The first fix alone would have saved the Friday job. Once the call is on the list, it cannot go quiet:
- a reminder text 30 minutes later;
- the Saturday and Sunday morning texts;
- then the top of Monday's list, in red, marked "Not contacted - 2d 14h".

---

## 2. What we are building, and explicit non-goals

**What we are building.**

Callback is a phone-first web app. Denise adds it to her home screen.

- **Today (home screen).** One ranked list of who to call and why. Each card has Call and Text buttons that use her own phone. A one-tap "How'd it go?" sheet logs what happened, and every answer sets the job's next date.
- **Jobs.** Shows where every job is, grouped by her stages, with counts.
- **Ways jobs get in:**
  - a one-box Quick Add: she pastes or dictates, rules or AI fill the fields, and she confirms;
  - a Brain dump, for moving her notebook in on day one;
  - one real automatic channel: website-form emails forwarded to a webhook;
  - SMS and missed-call adapters that use the same `ingest()` and are shown through a demo simulator.
- **Repeat customers** are recognised by phone number.
- **Numbers** answers her husband in one text.
- **Texts to Denise.** A 7:00am digest, a Friday 3pm "before the weekend" text, and one reminder for each untouched new lead. These go to an outbox, which sends through Twilio only when keys exist.
- **Demo.** A demo clock and seed data replay the weekend of the Friday freezer call.

It runs with `npm install && npm start` and needs no keys.

**Non-goals**

| Not building | Reason |
|---|---|
| Tech schedule, dispatch board, calendar, maps, tech logins or app | "That would be nice later but I kind of know where everyone is." A scheduled job holds a date and an optional tech first name, nothing else. |
| Quote or estimate builder, PDFs, e-signature | She already sends quotes her own way. We only record that a quote went out, plus an optional $ amount. |
| Invoicing, payments, QuickBooks sync | Her husband does the books. He asked for numbers, not software. |
| Automatic texts to customers by default | A wrong or badly timed text in her name damages trust, and she didn't ask for it. The auto-reply is built but **off** (see §7.4). Follow-up texts are drafted, and she sends them from her own phone. |
| AI replies, AI list ranking, AI morning summary, chatbot | Who is on the list, and why, must be explainable and testable. The reason line is the summary. |
| Reading her personal texts, call log or Gmail (OAuth) | Reading texts isn't possible on iPhone. Email access adds privacy and setup burden. Forwarding and webhooks cover both. |
| Charts, close rate, response-time stats, source attribution | These are vanity numbers for a business with four techs. Her husband asked "how many open jobs". One measure of the leak is kept (§10). |
| Custom stages or fields, tags, drag-and-drop board, multi-user roles | "Nothing fancy." There are seven fixed stages, named in her words. |
| Native app, offline service worker | An installable web page is enough. Offline caching adds bugs. |
| Recording answered calls | Consent-law risk. Only voicemails are recorded, once voice is wired. |
| Holiday calendar, multiple time zones | Business days are Mon–Fri, in one business time zone. |
| Customer portal, marketing, review requests, lead generation | The problem is follow-up, not getting more leads. |

**Decisions (conflicts resolved)**
- **D1.** The headline is follow-up; capture comes second. The Friday call was answered and then forgotten (hiring-manager critique beats the draft's capture-first ordering).
- **D2.** There are seven fixed stages. `to_schedule` ("Said yes - needs scheduling") stays a separate stage because she named it. Proposal 4's "Scheduled with no date" is too subtle.
- **D3.** Stage moves are never blocked. Any stage can move to any other through Job detail. The outcome buttons only offer the common moves. Side effects are defined by the target stage, so the data stays consistent.
- **D4.** Today is one ranked list. It has seven buckets, shown as small dividers in her words. Each card is in exactly one bucket, set by a fixed precedence, and empty dividers are hidden. This follows the critique's "one ranked list", and the dividers read like her own sentence.
- **D5.** Bucket precedence is: urgent, then texted back, then new, then said yes, then owe a quote, then chase a yes, then did it get done. Reaching new leads quickly comes first, then the jobs closest to money.
- **D6.** "Two days" means 2 business days, and it only applies to chasing a customer's yes. Jobs where the next move is hers stay on the list every day until handled. This replaces R19's 48-hour clock and follows the critique about weekends.
- **D7.** New leads and emergencies ignore business days and never pause over a weekend. That is exactly the Friday story.
- **D8.** There is no separate silence override (Proposal 1 R3) and no automatic closing (Proposal 1 R9).
  - The next-date rule already brings every job back.
  - Snoozes she chose on purpose are respected.
  - R07 forbids automatic closing.
  - After 3 failed tries, the card suggests "Mark lost?". She decides.
- **D9.** Tapping Call or Text only logs history. Dates change only when she taps an outcome, so there is one source of truth. The outcome sheet opens automatically when she comes back to the app, which keeps logging to one tap.
- **D10.** "Not today" never counts as contact. Snoozing can't hide a leak (Proposal 4).
- **D11.** How jobs get in is tiered:
  - **Must:** Quick Add and the website-form email channel. The email channel is real.
  - **Should:** SMS and missed-call adapters. They are built and demoed through the simulator, using the same `ingest()`. The adapter for R01 is cheap.
  - **Write-up only:** wiring the live phone line.
- **D12.** The automatic acknowledgement text to customers is built but OFF by default, because she didn't ask for it. It is on the list of questions for her.
- **D13.** AI has one call site: extraction, using the existing `server/ai.js`.
  - The model is `claude-sonnet-5-5`, as the fixed stack requires, and the `ANTHROPIC_MODEL` environment variable can override it. The critique asked for it to be configurable. Choosing a cheaper model is Gushwork's call, after measuring against the parser fixtures.
  - AI can raise urgency but never lower it.
  - AI never changes a stage and never sends a message.
- **D14.** When a customer replies "yes go ahead", keywords detect it, and it shows as a suggestion button. There is no second AI call site.
- **D15.** Follow-up texts go from her own phone through `sms:` links with fixed templates. There is no AI drafting, because customers know her number and this needs no compliance setup.
- **D16.** Notifications are limited to:
  - the daily digest: every weekday, and on weekends only if someone is waiting on a call back;
  - the Friday 3pm sweep;
  - one reminder for each untouched new lead, after 30 minutes if urgent or 2 hours otherwise, once per job, ever.
  
  This merges proposals 1, 3 and 4 and avoids alert fatigue.
- **D17.** Numbers is cut down to: open jobs, count per stage, $ waiting on a yes, won, done, lost, and new. One leak line is kept. This follows the critique, which called the larger set vanity metrics.
- **D18.** Numbers uses rolling windows (last 7 or 30 days), not the calendar week or month, so Monday-morning numbers aren't zero.
- **D19.** The demo seed is anchored at Monday 7:00am, and the weekend is replayed through the real scheduler. The Friday story then shows in the outbox and in the job's history without moving time backwards.
- **D20.** Access control is an optional single passcode plus a read-only link for her husband. Webhooks require `INBOUND_TOKEN` when it is set, and Twilio signatures are checked when `TWILIO_AUTH_TOKEN` is set (§7.2). The critique flagged customer PII on a public URL.
- **D21.** The closed stage is labelled "Lost", with optional reason chips. "Went with someone else" measures the leak.
- **D22.** Tech information is limited to a tech first-name chip and a "Text a tech" `sms:` link. That replaces what she does today without building a schedule.
- **D23.** Brain dump is a must, because the critique rated onboarding as high severity. It is a rules-based line parser with stage hints. Imported jobs where the next move is hers are due today, so day one shows her real business.

**Scope tiers**

**MUST**
- Shared rules core (§3–§5) and its tests.
- SQLite schema.
- `ingest()` with the email, form and generic-JSON adapters.
- Rules parser, plus the existing AI hook.
- Today screen, with the outcome sheet and undo.
- Jobs, Job detail, Quick Add and Brain dump.
- Numbers, with "Text this to Rick".
- Digest preview, the outbox and the scheduler (digest, sweep and reminders).
- Demo clock and simulator.
- Seed replay.
- README, write-up and demo script.

**SHOULD**
- Twilio-shaped SMS and voice adapters, with their URL aliases.
- Handling of texts Denise forwards.
- Passcode and `INBOUND_TOKEN`.
- The husband's read-only link.
- Real Twilio sending.
- Settings screen.
- PWA manifest and icons.

**COULD**
- Automatic acknowledgement (off).
- Text a tech.
- Block a number.
- CSV export.
- Mailgun multipart.
- Twilio signature check.
- Email digest.
- Monday text to her husband.
- Dark mode.



---

## 3. Stage model

Stage IDs are fixed strings and are used everywhere. Labels are shown exactly as written. All separators are ASCII " - ".

| id | Label (UI) | Short (chips, strip) | Whose move | Open? | On entering this stage (`enterStage`) |
|---|---|---|---|---|---|
| `new` | New - call them back | New | Denise | yes | `next_due_at = now` |
| `quote` | Waiting on quote | Waiting on quote | Denise owes a price | yes | `next_due_at` = start of next business day. If the job is urgent: now + 2h. Brain dump / Quick Add import: now. |
| `waiting_yes` | Waiting on their yes | Their yes | Customer | yes | `quote_sent_at = args.quote_sent_at ?? now`; `quote_amount = args.amount ?? existing`; `nudges = 0`; `next_due_at = startOfDay(addBusinessDays(localDate(quote_sent_at), 2))` |
| `to_schedule` | Said yes - needs scheduling | Said yes | Denise | yes | `won_at ??= now`; `visit_date = null`; `next_due_at = now` |
| `scheduled` | Scheduled | Scheduled | Tech (Denise confirms after) | yes | Requires `visit_date` (YYYY-MM-DD, local). `tech = args.tech ?? null`; `won_at ??= now`; `next_due_at = startOfDay(nextBusinessDay(visit_date))`. That date is the "Did it get done?" check. |
| `done` | Done | Done | Nobody | no | `done_at = closed_at = now`; `won_at ??= now`; `quote_amount = args.amount ?? existing`; `next_due_at = null` |
| `lost` | Lost | Lost | Nobody | no | `lost_at = closed_at = now`; `lost_reason = args.lost_reason ?? null`; `next_due_at = null` |

**What every stage entry does:**
- sets `stage` and `stage_entered_at = now`;
- resets `attempts` to 0;
- clears `snoozed_until` and `unread_inbound_at`.

Entering an open stage from `done` or `lost` (reopening) also clears `closed_at`, `done_at`, `lost_at` and `lost_reason`. `won_at` is kept.

**Invariant, enforced in SQL (§6):** a job is closed exactly when `next_due_at IS NULL`.

**Allowed transitions**
- `canTransition(from, to)` returns `from !== to`. Every move is allowed (D3).
- Outcome buttons (§5) cover the common moves:
  - `new` to `quote`, `waiting_yes`, `to_schedule`, `scheduled` or `lost`;
  - `quote` to `waiting_yes`, `to_schedule` or `scheduled`;
  - `waiting_yes` to `to_schedule` or `scheduled`;
  - `to_schedule` to `scheduled`;
  - `scheduled` to `done`, `to_schedule` or `quote`;
  - any open stage to `lost`.
- The Job detail stage picker (§5.7) covers everything else, including going backwards (for example `waiting_yes` back to `quote` for a revised quote) and "Bring back", which moves a closed job to `new`.

**"Denise owes" stages:** `new`, `quote`, `to_schedule`. **Customer's court:** `waiting_yes`. **Tech's court:** `scheduled`.

**Lost reasons**

| id | Label | Notes |
|---|---|---|
| `went_elsewhere` | Went with someone else | |
| `price` | Too pricey | |
| `fixed_themselves` | Fixed it themselves | |
| `no_response` | Never answered | |
| `not_a_job` | Not a real job | Excluded from every metric |
| (null) | | "Skip" |

**Equipment** (same set as `server/ai.js`):

| id | Label |
|---|---|
| `walk_in_cooler` | Walk-in cooler |
| `walk_in_freezer` | Walk-in freezer |
| `ice_machine` | Ice machine |
| `reach_in` | Reach-in |
| `display_case` | Display case |
| `prep_table` | Prep table |
| `other` | Other (shown as no chip) |

---

## 4. Today list rules

All rules live in pure shared modules (`shared/time.js`, `shared/today-rules.js`). They take `now` (an ISO UTC string) and `tz` as arguments and never read the system clock.

### 4.1 Time definitions (`shared/time.js`)
- **Storage and time zone.**
  - Instants are ISO UTC strings, for example `2026-10-02T21:47:00.000Z`.
  - Local dates are `YYYY-MM-DD` in the business time zone. The default is `America/Chicago`, from the `BUSINESS_TZ` environment variable or settings.
  - All conversions use `Intl.DateTimeFormat` and are safe across daylight-saving changes. Do not use `Temporal`.
- **Business days.** Business days are Mon–Fri, with no holidays.
  - `nextBusinessDay(d)` is the first business day strictly after `d`.
  - `addBusinessDays(d, n)` is the nth business day strictly after `d`.
  - Thu + 2 = Mon; Fri + 2 = Tue; Sat + 1 = Mon; Sun + 1 = Mon.
- **Due.** `startOfDay(d)` is local midnight of `d`, as an instant. A job is due when `next_due_at <= now`. Something "due Monday" counts from 00:00 Monday, so it is in the 7:00am digest.
- **`daysBetween(a, b)`** is the number of whole local calendar days between two dates. It is used only for display.
- **`formatAge(from, to)`:**
  - Under 1 minute: "now".
  - Under 60 minutes: `"{m}m"`.
  - Under 24 hours: `"{h}h"`.
  - Otherwise `"{d}d {h}h"`, or `"{d}d"` when h = 0.
  - Example: Fri 4:47pm to Mon 7:00am is "2d 14h".
- **`dayLabel(x, now)`:**
  - Same local date: "today". Previous date: "yesterday". Next date: "tomorrow".
  - Within 6 days before or after: the weekday, for example "Fri".
  - Otherwise: "Oct 14".
- **`timeLabel`:** "4:47pm", "6:02am", "12:00pm". **`dayTimeLabel`** = `dayLabel + " " + timeLabel`.
- **`whenLabel(next_due_at, now)`:**
  - Already due: "now".
  - Same date: "at 9:15am".
  - Otherwise the same rules as `dayLabel`.
- **`longDateLabel`:** "Monday, Oct 5". **`shortDateLabel`:** "Mon Oct 5".

### 4.2 Inclusion
A job is on Today if and only if all of these hold:
- its stage is open;
- and at least one of these is true:
  - `next_due_at <= now`;
  - `unread_inbound_at IS NOT NULL`.

Snoozed jobs drop out on their own, because a snooze sets `next_due_at` in the future. An unread reply shows even when the job is snoozed. A job never appears twice.

### 4.3 Buckets and precedence

Each card goes in the first bucket whose rule matches, checked from top to bottom (`bucketFor`):

| # | Bucket id | Divider label (shown as "{label} ({count})") | Rule |
|---|---|---|---|
| 1 | `emergency` | Urgent - call first | `urgent = 1` AND stage is `new`, `quote` or `to_schedule` AND (due OR unread) |
| 2 | `replied` | They got back to you | `unread_inbound_at` is set |
| 3 | `new` | New - call them back | stage `new`, due |
| 4 | `to_schedule` | Said yes - needs scheduling | stage `to_schedule`, due |
| 5 | `quote` | Waiting on your quote | stage `quote`, due |
| 6 | `nudge` | Waiting on their yes - check in | stage `waiting_yes`, due |
| 7 | `check_done` | Did it get done? | stage `scheduled`, due (the next business day after the visit, or a snooze date) |

Urgent jobs in `waiting_yes` or `scheduled` are not emergencies; they use their normal bucket. Dividers with no cards are hidden.

### 4.4 Sort order
Cards are sorted by bucket number. Within a bucket, they sort by the key below, ascending. The final tie-breaker is `id` ascending.

| Bucket | Sort key |
|---|---|
| `emergency` | Waiting since: `unread_inbound_at` if the customer replied, else `created_at` for `new`, else `stage_entered_at`. Oldest first. |
| `replied` | `unread_inbound_at`, oldest first |
| `new` | `created_at`, oldest first |
| `to_schedule`, `quote` | `stage_entered_at`, oldest first |
| `nudge` | `last_touch_at ?? quote_sent_at`, oldest first. Ties: larger `quote_amount` first, with nulls last. |
| `check_done` | `visit_date`, oldest first |

### 4.5 Card fields
- **`title`** is the first of these that exists: `business_name`, `contact_name`, `phoneDisplay(phone)` (for example "(312) 555-0177"), `email`, "Forwarded text - who is this?" (when `source_detail = 'forwarded'`), "Unknown".
- **`subtitle`** is `contact_name` when the title is the business name; otherwise null.
- **Badges:**
  - "URGENT", shown only in the `emergency` bucket.
  - "Repeat - {n} past job(s)", when `past_jobs >= 1`. `past_jobs` counts the customer's jobs created before this one.
- **`source_label`:**

| Source | Label |
|---|---|
| call + voicemail | Voicemail |
| call + missed | Missed call |
| call + answered | Call |
| sms + forwarded | Forwarded text |
| sms | Text |
| form | Web form |
| email | Email |
| manual | Added by you |
| bulk | From notebook |

- **`channelPhrase`** is the same as the source label, in lowercase: voicemail, missed call, call, forwarded text, text, web form, email, added by you, from your notebook.
- **`problem` fallback when null:**
  - missed call: "no voicemail";
  - answered call: "what was it about?";
  - anything else: "no details".

### 4.6 Reason templates (exact; `reasonFor`)

**Helpers**
- `trunc(s, 60)`: if `s` is over 60 characters, cut at the last space before character 59 and add "…" (U+2026).
- `money`: "$2,400" style.
- **`silence`:** applies to `quote` and `to_schedule` only.
  - When `daysBetween(localDate(last_touch_at ?? created_at), today) >= 2`, add `" - hasn't heard from us in {n} days"`.
  - These are her words: "has not heard from us in two days".

| Bucket / case | Template | Example at the seed anchor |
|---|---|---|
| emergency, stage `new`, untouched | `{problem} - {channelPhrase} {dayTime(created_at)}, nobody's called back` | Walk-in freezer at 28 degrees and climbing - voicemail Fri 4:47pm, nobody's called back |
| emergency, stage `new`, tried | `{problem} - {channelPhrase} {dayTime(created_at)}, tried {attempts}x, no answer` | |
| emergency, stage `quote` | `{problem} - waiting on your quote since {day(stage_entered_at)}` | |
| emergency, stage `to_schedule` | `{problem} - said yes {day(stage_entered_at)}, not scheduled yet` | |
| emergency or replied, customer wrote back | **sms:** `Texted {dayTime}: "{trunc(body,60)}"`<br>**email/form:** `Emailed {dayTime}: "…"`<br>**missed call:** `Called {dayTime} (missed, no voicemail)`<br>**voicemail:** `Called {dayTime}: "{trunc(transcript,60)}"`<br>**answered call (≥15s):** `You talked {dayTime} - what happened?` | Texted yesterday 6:05pm: "Can Mike come Wednesday instead of Tuesday? We're closed…" |
| new | `New - {channelPhrase} {dayTime(created_at)} - {problem}`<br>If tried, add ` - tried {attempts}x`. At 3 or more attempts the button becomes "Mark lost?" (§5.3). | New - missed call Sat 1:12pm - no voicemail |
| to_schedule | `Said yes {day(stage_entered_at)} - not scheduled yet{silence}` | Said yes Fri - not scheduled yet - hasn't heard from us in 3 days |
| quote | `Waiting on your quote since {day(stage_entered_at)}{silence}` | Waiting on your quote since Wed - hasn't heard from us in 5 days |
| nudge, nudges < 3 | `Quote sent {day(quote_sent_at)}{", " + money(amount) if set} - no answer in {n} day(s)`<br>If `nudges >= 1`, add ` - nudged {nudges}x`. `n = daysBetween(last_touch_at ?? quote_sent_at, today)`. | Quote sent Thu, $2,400 - no answer in 4 days |
| nudge, nudges ≥ 3 | `Quote sent {day}{, $} - {nudges} tries, no answer. Mark lost?` | |
| check_done | `{tech} went {day(visit_date)} - done?`, or with no tech: `Visit was {day(visit_date)} - done?` | Luis went Fri - done? |

### 4.7 Chips (`chipFor`)

**Text**
- Stage `new`, never touched: `Not contacted - {formatAge(created_at, now)}`.
- Stage `new`, touched: `Tried {attempts}x - {age}`.
- Snooze date reached (`snoozed_until` set and `<= now`):
  - `Call back today` when the snooze date is today;
  - otherwise `Call back was {day}`.
- Any other bucket except `check_done`: `Waiting {formatAge(waitingSince, now)}` ("Just now" when the age is "now"), where `waitingSince` is the sort key in §4.4.
- `check_done`: no chip.

**Tone**
- `emergency`: red.
- `nudge`: amber.
- `new`, `replied`, `to_schedule`, `quote`:
  - age of 48h or more (her two-day rule): red;
  - 24h or more: amber;
  - otherwise grey.

### 4.8 Header, stage strip, footer, empty state
- **Header.**
  - Line 1: `longDateLabel(now)`, for example "Monday, Oct 5".
  - Line 2 (large):
    - 0 cards: none (`header` is null; the empty state says it);
    - 1 card: "1 person to call";
    - otherwise "{n} people to call".
  - Line 3 (small, grey): "{money(sum of quote_amount for waiting_yes)} waiting on a yes". Hidden when the sum is 0.
  - When the demo clock is shifted, add a pill: "Demo time: Mon Oct 5, 7:00am". Tapping it opens the simulator.
- **Stage strip.** Counts of open jobs per stage, wrapping onto two lines. Never scroll sideways.
  - Format: "New 3 · Waiting on quote 3 · Their yes 2 · Said yes 2 · Scheduled 3".
  - Tapping a chip opens `#/jobs?stage=<id>`.
- **Footer.**
  - Line 1: "Scheduled today: {k} · Put off till later: {s}".
    - `k` = stage `scheduled` with `visit_date` = today.
    - `s` = open jobs with `snoozed_until > now` and no unread reply.
    - Each half is a link: Jobs › Scheduled, and Jobs › Put off till later.
  - Line 2, the trust line: "Last 24 hours: {n} came in, all handled" or "Last 24 hours: {n} came in, {k} not called yet".
    - `n` = jobs created in (now−24h, now].
    - `k` = of those, still in stage `new` with `first_touch_at` null.
    - If `n` = 0: "Nothing new in the last 24 hours".
- **Empty state** (`Today.empty`, null when there are cards):
  - jobs put off till later: "Nothing due right now." / "{s} put off till later - they'll come back on their day.";
  - otherwise: "All caught up." / "Nobody's waiting on you."
  - The footer and trust line still show.

### 4.9 Business-day handling (summary)

| Situation | Clock |
|---|---|
| New lead, emergency, customer reply | Calendar time. Due at once on any day, weekends included. |
| Chasing a yes (`waiting_yes`) | +2 business days after the quote and after each nudge |
| Owe a quote: after "Talked - needs a quote", "Not today" or "No answer" | Next business day at 00:00. If urgent: +2h, or +1h for No answer. |
| Said yes, needs scheduling | Due now. It stays due until scheduled. |
| Scheduled | Due the next business day after the visit date ("Did it get done?") |
| Items due but not handled | Stay due ("overdue carries forward"). They are shown on weekends too, but weekend texts only mention Call-first items (§11). |
| Display ages ("4 days", "2d 14h") | Calendar days and real hours |

### 4.10 Snooze and callback semantics
- "Not today" (outcome `snooze`) offers these day chips:
  1. The next business day, labelled "Tomorrow" when it is tomorrow, otherwise its weekday name.
  2. The business day after that, by weekday name.
  3. "Pick a day", a date input that allows any future date, including weekends, if she chooses one.
- The snooze sets `snoozed_until = next_due_at = startOfDay(picked)` and clears `unread_inbound_at`.
- It does **not** change `last_touch_at`. The silence counter keeps running, so a snoozed job comes back visibly late (D10).
- When the snooze date arrives, the job is due in its normal bucket and its chip reads "Call back today".
- A customer message during a snooze puts the job in `replied` straight away (§4.2). "Seen it" hides it again until the snooze date.
- Any outcome other than snooze or "Seen it" clears `snoozed_until`.

### 4.11 Emergencies
- **Setting the flag.**
  - At intake: rules OR AI (§8). AI can only set it to 1.
  - A later inbound message can raise it to 1. Rules never clear it.
  - Denise toggles it in Job detail. That records `urgent_source = 'manual'` and logs an event.
- **Effects:**
  - bucket 1 (§4.3) while the job is in a stage where the next move is hers;
  - "No answer" brings it back after 1 hour;
  - owing a quote brings it back after 2 hours;
  - a reminder text 30 minutes after it arrives if untouched (§11).

### 4.12 Unanswered inbound messages and reply suggestions
- **Setting `unread_inbound_at`.** Any inbound message attached to an existing open job sets it, unless it is already set.
  - The message that created the job does not set it.
  - Answered calls of 15 seconds or more set it with the reason "You talked … - what happened?"
- **Clearing it.** Any outcome clears it, as do "Seen it" and snooze.
- **Reply suggestion (`replySuggestion(job)`), for stage `waiting_yes` or `quote`:**
  - `replyIntent(last_inbound.body)` returns `yes`: suggest `mark_yes`. The `yes` outcome is promoted first with the label "Mark as yes?".
  - It returns `no`: suggest `mark_lost`. The `lost` outcome is promoted with the label "Mark lost?" and the reason preset to `went_elsewhere` if the text says someone else, otherwise null.
  - Both or neither: no suggestion.
  - This is never applied automatically.
- **AI flag.** `ai_not_service = 1` on a `new` job promotes `not_a_job` with the label "Not a job?".

---

## 5. Outcome actions per stage

### 5.1 Rules common to every outcome
- `applyOutcome(job, outcomeId, args, ctx)` in `shared/stages.js` is pure. It returns `{ patch, event: {kind:'outcome', summary, data}, toast }`.
  - It throws `OutcomeError('invalid_outcome')` if the outcome isn't offered for this stage.
  - It throws `OutcomeError('missing_arg')` if a required picker value is missing.
- **Outcomes that count as contact.** These set `last_touch_at = now` and `first_touch_at ??= now`: everything except `snooze`, `seen`, `lost` and `not_a_job`.
- Every outcome except `snooze` and `seen` clears `unread_inbound_at` and `snoozed_until`. Most do this through `enterStage`; `no_answer` and `still_thinking` clear them explicitly.
- **The server, in one transaction:**
  1. loads the job;
  2. checks `expected_stage` if one was sent (409 `stale_stage`);
  3. applies the patch;
  4. writes the event with `prev_json` (the full job row before the change);
  5. returns the toast and the new Today count.
- The UI shows the toast for 6 seconds with an **Undo** button.

### 5.2 Outcome catalogue

| id | Button label (by stage) | Offered in | Picker | Effect |
|---|---|---|---|---|
| `no_answer` | No answer | `new`, `waiting_yes`, `to_schedule` | none | `attempts += 1`; contact.<br>**waiting_yes:** `nudges += 1`, `next_due_at = startOfDay(addBusinessDays(today, 2))`.<br>**Other stages:** `next_due_at` = urgent ? now + 1h : start of next business day. |
| `need_quote` | new: "Talked - needs a quote"<br>scheduled: "Needs a quote for more work" | `new`, `scheduled` | none | `enterStage('quote')`; contact |
| `quote_sent` | new: "Quoted on the call"<br>quote: "Quote sent" | `new`, `quote` | amount (optional) | `enterStage('waiting_yes', {amount})`; contact |
| `yes` | new: "Booked it"<br>quote / waiting_yes: "They said yes" | `new`, `quote`, `waiting_yes` | day, or "No date yet", then tech (optional) | Date given: `enterStage('scheduled', {visit_date, tech})`. Otherwise `enterStage('to_schedule')`. `won_at ??= now`; contact. |
| `still_thinking` | Still thinking | `waiting_yes` | none | `nudges += 1`; `next_due_at = startOfDay(addBusinessDays(today, 2))`; contact |
| `scheduled` | to_schedule: "Scheduled"<br>scheduled: "Moved to another day" | `to_schedule`, `scheduled` | day (required), then tech (optional) | `enterStage('scheduled', {visit_date, tech})`; contact |
| `done` | Done | `scheduled` | amount (optional; prefilled with `quote_amount`) | `enterStage('done', {amount})`; contact |
| `another_visit` | Needs another visit | `scheduled` | none | `enterStage('to_schedule')` (tech is kept); contact |
| `snooze` | Not today | any open stage | snooze day | §4.10; not contact |
| `lost` | Lost (Cancelled for scheduled) | any open stage | reason chips or Skip | `enterStage('lost', {lost_reason})`; not contact |
| `not_a_job` | Not a job | `new` | none (optional `block: true`) | `enterStage('lost', {lost_reason:'not_a_job'})`. If `block`, set `customers.blocked = 1`. Not contact. |
| `seen` | Seen it | any open stage with an unread reply | none | `unread_inbound_at = null`; nothing else |

### 5.3 Buttons per stage

The order is the button order. The quiet row is small links under the main buttons.

| Stage | Main buttons | Quiet row |
|---|---|---|
| `new` | No answer · Talked - needs a quote · Booked it · Quoted on the call · Not a job | Not today · Lost · Open job |
| `quote` | Quote sent · They said yes | Not today · Lost · Open job |
| `waiting_yes` | They said yes · Still thinking · No answer | Not today · Lost · Open job |
| `to_schedule` | Scheduled · No answer | Not today · Lost · Open job |
| `scheduled`, visit date before today | Done · Needs another visit · Needs a quote for more work · Moved to another day | Not today · Cancelled · Open job |
| `scheduled`, visit date today or later | Moved to another day · Done · Needs another visit · Needs a quote for more work | Not today · Cancelled · Open job |

**Additions**
- When a reply is unread, "Seen it" is added at the start of the quiet row.
- Promoted buttons are shown first with an accent colour, and only the highest-priority promotion applies:
  1. a reply suggestion (`mark_yes` or `mark_lost`);
  2. AI "Not a job?";
  3. 3 or more failed tries (`attempts >= 3` on `new`, or `nudges >= 3` on `waiting_yes`), which promotes "Mark lost" with the reason preset to `no_response`.

### 5.4 Pickers
At most 3 taps from the sheet opening to saved (R29).

- **Day (for `yes` and `scheduled`).** Chips: "Today", "Tomorrow", the weekday name for today + 2, "Pick a day". `yes` also has "No date yet". These are calendar days, because techs sometimes work Saturdays.
- **Tech.** After a day is picked, show chips for each tech name in settings plus "Skip".
- **Amount.** A large numeric keypad, "Save ${n}", and an equally large "Skip". Whole dollars only.
- **Lost reason.** The five reason chips plus "Skip".
- **Snooze.** §4.10.

### 5.5 Toast copy (exact)
`{when}` = `whenLabel(new next_due_at)`. `{day}` = `dayLabel(visit_date)`. `{check}` = `whenLabel` of the check-done date.

| Outcome | Toast |
|---|---|
| no_answer | No answer logged. Back on your list {when}. |
| need_quote | Moved to Waiting on quote. Back on your list {when}. |
| quote_sent | Quote sent{ ($2,400)}. I'll remind you {when} if no answer. |
| yes, with a date | Booked for {day}{ with Luis}. I'll ask if it got done {check}. |
| yes, no date | Moved to Said yes - needs scheduling. |
| still_thinking | Got it. Back on your list {when}. |
| scheduled | Scheduled for {day}{ with Mike}. I'll ask if it got done {check}. |
| done | Marked done{ ($600)}. |
| another_visit | Moved to Said yes - needs scheduling. |
| snooze | OK, it'll be back on your list {when}. |
| lost | Moved to Lost. |
| not_a_job | Removed - not a job. |
| seen | Marked as seen. If the job isn't due, add: " Back on your list {when}." |

**Event summaries** (for the timeline):

| Outcome | Summary |
|---|---|
| no_answer | No answer (try {n}) |
| need_quote | Talked - needs a quote |
| quote_sent | Quote sent - $2,400 |
| yes | Booked for Mon with Luis, or "Said yes - needs scheduling" |
| still_thinking | Still thinking (nudge {n}) |
| scheduled | Scheduled Tue with Mike |
| done | Done - $600 |
| another_visit | Needs another visit |
| snooze | Put off until Wed |
| lost | Lost - went with someone else |
| not_a_job | Not a job |
| seen | Seen |

### 5.6 Undo
`POST /api/jobs/:id/undo {event_id}` is accepted only when all of these hold:
- the event is the job's latest event that changes state (ignore `notified`, `call_tap`, `text_tap`, `tech_text` and `ai_refined`);
- it hasn't already been undone;
- it is less than 10 minutes old.

Undo restores `prev_json`, except `id` and `created_at`. It marks the event `undone = 1` and logs an `undo` event ("Undid: {summary}"). Otherwise it returns 409 `undo_not_allowed`.

### 5.7 Job detail stage picker and reopening
- **Stage picker.** Tapping a stage chip opens a confirmation sheet: "Move to {label}?".
  - Required pickers are shown when needed: day for `scheduled`, amount (optional) for `waiting_yes`, reason for `lost`.
  - It calls `POST /api/jobs/:id/stage`, which runs `enterStage`. This does **not** count as contact.
- **Reopening.** "Bring back" on a closed job calls stage `new`.
- **Editing the next date.** "Back on your list: Thu · Change" uses the snooze picker. It is not offered for `scheduled` jobs; she changes the visit date instead.

### 5.8 Call and Text taps
- Tapping **Call** or **Text** opens the `tel:` or `sms:` link and calls `POST /api/jobs/:id/tap {kind}`. This logs `call_tap` or `text_tap` only, with no date changes (D9).
- The client remembers `{jobId, at}`.
- When the page becomes visible again (`visibilitychange`) more than 3 seconds later and within 30 minutes, the outcome sheet for that job opens automatically.

---

## 6. Data model (SQLite via `node:sqlite` `DatabaseSync`)

- The file is `DB_PATH`, default `data/callback.db`.
- Run `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA user_version=1`.
- Timestamps are ISO UTC text. `visit_date` is local `YYYY-MM-DD`. Money is whole dollars (INTEGER).

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- value = JSON

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  contact_name TEXT, business_name TEXT,
  phone TEXT,                         -- E.164, e.g. +13125550142
  email TEXT,                         -- lowercased
  address TEXT, notes TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE INDEX customers_email ON customers(email);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  stage TEXT NOT NULL CHECK (stage IN ('new','quote','waiting_yes','to_schedule','scheduled','done','lost')),
  source TEXT NOT NULL CHECK (source IN ('call','sms','email','form','manual','bulk')),
  source_detail TEXT CHECK (source_detail IS NULL OR source_detail IN ('voicemail','missed','answered','forwarded')),
  problem TEXT,                       -- one line, <= 60 chars
  details TEXT,
  equipment TEXT CHECK (equipment IS NULL OR equipment IN
    ('walk_in_cooler','walk_in_freezer','ice_machine','reach_in','display_case','prep_table','other')),
  urgent INTEGER NOT NULL DEFAULT 0,
  urgent_source TEXT,                 -- 'rules' | 'ai' | 'manual'
  ai_not_service INTEGER NOT NULL DEFAULT 0,
  parsed_by TEXT,                     -- 'rules' | 'ai' | 'manual'
  quote_amount INTEGER, quote_sent_at TEXT,
  visit_date TEXT, tech TEXT, notes TEXT,
  created_at TEXT NOT NULL,           -- when the request came in (message received_at)
  updated_at TEXT NOT NULL,
  stage_entered_at TEXT NOT NULL,
  first_touch_at TEXT, last_touch_at TEXT,
  next_due_at TEXT, snoozed_until TEXT, unread_inbound_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, nudges INTEGER NOT NULL DEFAULT 0,
  won_at TEXT, done_at TEXT, lost_at TEXT,
  lost_reason TEXT CHECK (lost_reason IS NULL OR lost_reason IN
    ('went_elsewhere','price','fixed_themselves','no_response','not_a_job')),
  closed_at TEXT,
  CHECK ((stage IN ('done','lost')) = (next_due_at IS NULL))   -- the invariant: open <=> has a next date
);
CREATE INDEX jobs_stage ON jobs(stage);
CREATE INDEX jobs_customer ON jobs(customer_id);
CREATE INDEX jobs_due ON jobs(next_due_at);

CREATE TABLE messages (                -- raw inbound log; written BEFORE any parsing
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('call','sms','email','form','manual','bulk')),
  provider TEXT NOT NULL,             -- 'twilio' | 'postmark' | 'mailgun' | 'form' | 'generic' | 'raw' | 'app'
  external_id TEXT,                   -- MessageSid / CallSid / Message-ID / submission id / content hash
  call_status TEXT,                   -- 'missed' | 'voicemail' | 'answered' | NULL
  call_duration_s INTEGER,
  from_phone TEXT, from_email TEXT, from_name TEXT, subject TEXT,
  body TEXT NOT NULL DEFAULT '',
  forwarded INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,             -- original payload, verbatim
  status TEXT NOT NULL CHECK (status IN ('received','created_job','attached','ignored','blocked','error')),
  job_id INTEGER REFERENCES jobs(id),
  customer_id INTEGER REFERENCES customers(id),
  parse_json TEXT,                    -- {rules:{...}, ai:{...}|null, merged:{...}}
  error TEXT
);
CREATE UNIQUE INDEX messages_external ON messages(channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX messages_job ON messages(job_id);

CREATE TABLE events (                  -- job timeline + undo
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- created|inbound|outcome|stage|edit|seen|undo|call_tap|text_tap|tech_text|ai_refined|notified
  actor TEXT NOT NULL CHECK (actor IN ('denise','customer','system')),
  summary TEXT NOT NULL,              -- one human line for the timeline
  data_json TEXT,                     -- {outcome, from, to, args, fields...}
  prev_json TEXT,                     -- full job row before (outcome/stage/edit/seen only)
  message_id INTEGER REFERENCES messages(id),
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_job ON events(job_id, id);

CREATE TABLE outbox (                  -- every text the system sends or would have sent
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('digest','friday_sweep','nag','auto_ack','husband_summary','manual')),
  to_phone TEXT NOT NULL, to_name TEXT,
  body TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs(id),
  dedupe_key TEXT UNIQUE,             -- digest:2026-10-05 | sweep:2026-10-02 | nag:16 | ack:+1312...:2026-10-05T1
  status TEXT NOT NULL CHECK (status IN ('simulated','sent','failed')),
  provider_id TEXT, error TEXT
);
```

**Settings keys** (JSON values; defaults are written by the seed):

| Key | Default |
|---|---|
| `company_name` | "Frostline Refrigeration" |
| `owner_name` | "Denise" |
| `owner_phone` | "+13125550100" |
| `husband_name` | "Rick" |
| `husband_phone` | "+13125550108" |
| `techs` | `[{"name":"Luis","phone":"+13125550121"},{"name":"Mike","phone":"+13125550122"},{"name":"Dee","phone":"+13125550123"},{"name":"Sam","phone":"+13125550124"}]` |
| `timezone` | "America/Chicago" |
| `digest_time` | "07:00" |
| `friday_sweep` | true |
| `weekend_digest` | true |
| `auto_ack_enabled` | false |
| `auto_ack_text` | "Hi, it's Denise at {company}. Got your message - I'll call you back as soon as I can." |
| `readonly_key` | random 24-character base64url, created on first boot |
| `clock_offset_ms` | 0 (persisted demo clock; restored on boot with `setNow(Date.now() + offset)`) |

**`JobView`** is the input to every shared rule. `repo.getJobViews()` builds it: a job row joined to its customer, its latest message, and a count of past jobs.

```ts
type JobView = JobRow & {
  customer: { contact_name, business_name, phone, email, address, blocked };
  last_inbound: { at: ISO, channel, call_status, body } | null;   // latest message linked to the job
  past_jobs: number;                                              // customer's jobs with created_at < this job's
};
```

---

## 7. Intake channels

### 7.1 One pipeline: `ingest(event, opts)` in `server/ingest.js`

Every channel, including the simulator, Quick Add and Brain dump, is a thin adapter that builds an `InboundEvent` and calls `ingest`.

```ts
type InboundEvent = {
  channel: 'call'|'sms'|'email'|'form'|'manual'|'bulk';
  provider: 'twilio'|'postmark'|'mailgun'|'form'|'generic'|'raw'|'app';
  external_id: string|null;
  received_at: ISO;                         // adapters use clock now; generic payloads may pass `at` only when DEMO=1
  from_phone: string|null; from_email: string|null; from_name: string|null;
  subject: string|null; body: string;
  call_status: 'missed'|'voicemail'|'answered'|null; call_duration_s: number|null;
  form_fields: Record<string,string>|null;  // already-labelled fields (direct form webhooks)
  raw: object;
};
// opts: { now: ISO, ai?: boolean (default aiEnabled()), fields?: Partial<Parse> /* seed overrides */ }
// returns { status: 'created_job'|'attached'|'duplicate'|'ignored'|'blocked'|'error', job_id, message_id, refine: Promise|null }
```

**Steps, in order**
1. **Duplicates.** If `external_id` already exists for this channel, return `duplicate` with the existing `job_id`. Write no new row.
   - Voice exception: if a callback with the same `CallSid` carries `TranscriptionText`, update that message's `body`. If the job's `problem` is null, re-parse it, and urgency can only rise.
   - Forms with no ID: `external_id = sha1(body + phone + email + received_at rounded down to 10 minutes)`.
2. **Store the raw message first.** Insert the `messages` row with `status='received'` and `raw_json` before any parsing. Wrap every later step in try/catch. On any error, set `status='error'` and `error` on the message, then still create a fallback `new` job whose `problem` is "Couldn't read this one - tap to look". A message is never dropped.
3. **Forwarded texts.** A text counts as forwarded when `channel='sms'` and `normalizePhone(from_phone) === settings.owner_phone`.
   - Set `forwarded=1` and run `unwrapForward(body)` to get `{body, phone, name}`.
   - Set `from_phone` to the extracted phone, or null.
   - Set `source_detail='forwarded'`.
4. **Calls that create nothing.**
   - Answered calls with `call_duration_s < 15` are logged with `status='ignored'`.
   - Twilio statuses `queued`, `ringing` and `in-progress` are also `ignored`.
5. **Match the customer** (§7.3). If the customer is `blocked=1`, set `status='blocked'` and stop.
6. **Attach to an open job, if the customer has one.** The target is the open job with the latest `updated_at`.
   - Write an `inbound` event (actor `customer`, `message_id`).
   - Set `unread_inbound_at ??= received_at`.
   - Run `detectUrgency(body, job.equipment)`. It can only raise urgency (`urgent_source='rules'`).
   - Set the message's `status='attached'`.
7. **Otherwise create a job.**
   - Parse: `parseMessage(body, {channel, from_phone, owner_phone, form_fields, techs, now, tz})`. Values in `opts.fields` override the parse.
   - Create the customer, or fill in its blank fields. Existing values are never overwritten.
   - Insert the job with:
     - `stage='new'`, `created_at = stage_entered_at = next_due_at = received_at`;
     - `source = channel`, `source_detail`;
     - `problem`, `details`, `equipment`, `urgent`, `urgent_source`, `parsed_by='rules'`.
   - Write a `created` event, for example "Voicemail came in", with `message_id`.
   - Set the message's `status='created_job'`, its `job_id`, and `parse_json.rules`.
8. **Automatic acknowledgement**, if it is on (§7.4).
9. **AI refine.** This runs in the background, and only for created jobs.
   - Condition: `opts.ai !== false && aiEnabled()`.
   - Call `extractWithAI(body, {channel, from})`, then `mergeParse` (§8.5).
   - Only change job and customer fields whose current value still equals the rules value. If Denise has edited a field, the AI never overwrites it.
   - Write an `ai_refined` event, for example "Details read by AI: name, problem".
   - Store `parse_json.ai`.
   - The promise is returned as `refine`, so tests can await it.
10. **Return** `{status, job_id, message_id, refine}`.

### 7.2 Endpoints and accepted payload formats

All routes are in `server/routes/inbound.js`, one path per channel (`INBOUND_PATHS`). Settings lists the four URLs.

| Route | Formats accepted | Normalisation | Response |
|---|---|---|---|
| `POST /api/inbound/sms` | **Twilio** (urlencoded): `From`, `To`, `Body`, `MessageSid`, `NumMedia`.<br>**Generic JSON:** `{from, body, id?, at?}` | `external_id` = `MessageSid` or `id`. If `NumMedia>0`, add "\n[photo attached]" to the body. | Twilio: `200 text/xml` `<Response/>` (never a TwiML reply).<br>Generic: JSON result. |
| `POST /api/inbound/call` | **Twilio status, recording or transcription callbacks:** `CallSid`, `From`, `To`, `CallStatus`, `CallDuration`, `DialCallStatus`, `DialCallDuration`, `RecordingUrl`, `TranscriptionText`, `ForwardedFrom`.<br>**Generic JSON:** `{from, status:'missed'\|'voicemail'\|'answered', duration_s?, voicemail_text?, id?, at?}` | See the call mapping below. | `200 text/xml` `<Response/>`, or JSON for generic. |
| `POST /api/inbound/email` | **Postmark inbound JSON:** `FromFull{Email,Name}`, `From`, `Subject`, `TextBody`, `HtmlBody`, `MessageID`, `Headers[]`.<br>**Mailgun** (urlencoded; multipart is a could): `sender`, `from`, `subject`, `body-plain`, `stripped-text`, `Message-Id`, `timestamp`, `token`, `signature`.<br>**Raw** `text/plain` or `message/rfc822`: header lines until the first blank line (From, Reply-To, Subject, Message-ID, Date), then the body; multipart bodies give their text part (else the HTML part), decoded.<br>**Generic JSON:** `{from, from_name?, subject?, text, message_id?}` | `external_id`: the RFC `Message-ID` header if present, else the provider ID.<br>HTML is stripped to text.<br>`channel='form'` if the body has 2 or more of the parser's form labels (Name, Full Name, First/Last Name, Business, Phone Number, Email, Message, Comments, …), else `'email'`. The sender is Reply-To when valid, else From. | 200 JSON |
| `POST /api/inbound/form` | Direct website-form webhook, JSON or urlencoded. | See the form aliases below. Unknown fields are appended to the body as "Key: value".<br>`external_id` = `submission_id`, `entry_id` or `id`, else a hash. | 200 JSON |

**Call mapping**

| Twilio payload | Becomes |
|---|---|
| `TranscriptionText` or `RecordingUrl` present | `voicemail`, with body = transcript or "(voicemail - no transcript yet)" |
| `DialCallStatus` is `completed` | `answered`, with duration = `DialCallDuration` |
| `CallStatus` `completed` with no `DialCallStatus` (Phase 1: the caller hung up during the greeting) | `missed` |
| `DialCallStatus ?? CallStatus` is `no-answer`, `busy`, `failed` or `canceled` | `missed` |
| anything else (queued, ringing, in-progress) | `ignored` |

An ignored row keeps its `CallSid`. A later callback for the same `CallSid` is a duplicate unless it brings a recording or transcript, or the row only saw a progress status and this callback has the outcome.

**Form field aliases.** Matching ignores case and non-alphanumeric characters.
- `name`, `fullname`, `yourname` become `contact_name`.
- `business`, `company`, `restaurant`, `store`, `businessname` become `business_name`.
- `phone`, `phonenumber`, `tel`, `mobile` become the phone.
- `email`, `emailaddress` become the email.
- `address`, `serviceaddress`, `location` become the address.
- `message`, `details`, `comments`, `description`, `howcanwehelp`, `issue`, `problem` become the body.

**Guards**
- **Token.** When `INBOUND_TOKEN` is set, a `?token=` query parameter must match, compared in constant time. Otherwise return 401.
- **Twilio signature** (could). When `TWILIO_AUTH_TOKEN` is set, every request to the sms and call routes, whatever its shape, needs an `X-Twilio-Signature` equal to the base64 HMAC-SHA1 over `PUBLIC_URL + originalUrl` plus the sorted POST key-value pairs. Otherwise return 403.
- **Mailgun signature** (could). When `MAILGUN_SIGNING_KEY` is set, every request to the email route needs a valid HMAC-SHA256 of `timestamp + token`, a timestamp within 5 minutes of real time (not the demo clock) and a token not seen in the last 10 minutes. Otherwise return 403.
- **PUBLIC_URL.** With either signature key set and `PUBLIC_URL` unset or on localhost, boot prints a warning; in production it refuses to start.
- **Body size.** Reject bodies over 1 MB.
- **Generic `at`.** The `at` field is honoured only when `DEMO=1`.

### 7.3 Repeat-customer matching
- **`normalizePhone(raw)`.** Strip everything except digits and a leading `+`.
  - 10 digits whose first digit is 2–9: `+1` + digits.
  - 11 digits starting with 1: `+` + digits.
  - Starts with `+`: keep as is.
  - Anything else: null.
- **Match order:**
  1. phone, exact E.164;
  2. email, exact and lowercased, only when the message has no phone (a phone that matches nobody never falls back to email);
  3. forwarded texts only: the body contains exactly one existing customer's `business_name`, compared on letters and digits only;
  4. no match: create a new customer.
- **Never an identity:** relay and system senders (no-reply, wordpress@, forms@, notifications@, submissions@, form-service domains such as wix, squarespace, jotform, wufoo, typeform, formspree, hubspot), her own address (`owner_email`), and the sender of a form notification or a forwarded email. Those are read from the body instead; Reply-To beats From.
- **Her own entries** (Quick Add, Brain dump) join a customer only on a phone match, or an email match when no phone was typed. A typed phone that contradicts the matched customer's phone makes a new customer.
- **No fuzzy merging, ever.** Name similarity is only shown as a "Same as Rosa's Taqueria?" banner on the Quick Add preview (could).
- **Customer has an open job:** attach to the most recently updated open job.
  - In the timeline the event reads by its channel ("Texted back", "Emailed back", "Left a voicemail") above the message itself.
  - With 2 or more open jobs, it still goes to the most recently updated one. Job detail gets a "Move to other job" action (could).
- **Customer has only closed jobs:** create a new job. It shows the Repeat badge and the past jobs are listed in Job detail. There is no time-window merging, because a "thanks!" costs one tap ("Not a job"), while hiding "it broke again" would cost a job.

### 7.4 Automatic acknowledgement (built, OFF by default)
When `auto_ack_enabled` is on, it sends only if every condition holds:
- the ingest result is `created_job`;
- the channel is `sms` (not forwarded), a `call` that was `missed` or `voicemail`, or a `form` that has a phone;
- the customer isn't blocked;
- the number is a 10-digit NANP number;
- no `auto_ack` has gone to this number in the last 12 hours (`dedupe_key = ack:{phone}:{YYYY-MM-DDTHH rounded down to a 12-hour block}`).

The body is `auto_ack_text` with `{company}` filled in. It goes to the outbox as kind `auto_ack`, addressed to the customer. Sending it for real needs A2P registration (§7.6). It is shown in Settings with the exact text and an on/off switch.

### 7.5 Raw inbound log
- `messages` rows are never deleted, and `raw_json` is stored verbatim.
- Job detail shows every message body verbatim, in a quote box, labelled with its channel and time.
- `/#/sim` "Inbound log" lists the last 50 messages with status and a link to the job.
- `GET /api/health` returns `unlinked_messages`: the count of `status IN ('received','error') AND job_id IS NULL`. It must always be 0, because the error path creates a fallback job.
- Side benefit: Gmail's forwarding-confirmation email lands in this log, so the setup code can be read there.

### 7.6 Real-world wiring

Costs are approximate and must be checked against current pricing.

| Channel | Built in the prototype | To go live | Approx. cost | What Denise changes |
|---|---|---|---|---|
| **Quick Add / Brain dump** | Fully | Nothing | $0 | Types or dictates about 10 seconds per job. A 15-minute notebook session on day 1. |
| **Website form email** (the one real automatic channel) | Postmark, Mailgun, raw and generic adapters; direct form webhook | **Option A:** if the form builder supports webhooks, point it at `{PUBLIC_URL}/api/inbound/form?token=…`.<br>**Option B:** a Gmail filter on the form sender auto-forwards to a Postmark inbound address, whose webhook is `{PUBLIC_URL}/api/inbound/email?token=…`. Gmail asks for a confirmation code, which appears in the inbound log.<br>**Fallbacks:** a free Cloudflare Email Routing worker, or a Google Apps Script that posts new messages under a label every 5 minutes. | $0–15/mo | Nothing. Her inbox is unchanged and duplicates are dropped by Message-ID. |
| **Customer texts** | Twilio-shaped SMS adapter, forwarded-text unwrapping, simulator | Buy a Twilio local number and set its Messaging webhook to `/api/inbound/sms?token=…`. Denise saves it as the contact "New Job" and forwards customer texts to it. **Honest limit:** an iPhone forward drops the original sender, so she types the customer's name in front, or the card says "Forwarded text - who is this?". Later, give customers the number as the "text us" line. | ~$1–2/mo plus about 1¢ per text | A new 4-tap habit. This is the biggest adoption risk, so paste into Quick Add is the zero-setup default. |
| **Missed calls and voicemail** | Twilio-shaped voice adapter, simulator | **Phase 1, no number porting:** her carrier's conditional forwarding (no answer or busy) sends calls to the Twilio number. TwiML plays her greeting and records with transcription, and the callbacks go to `/api/inbound/call?token=…`. Test on day 2 that the caller ID comes through.<br>**Phase 2, to also see answered calls:** route every call through Twilio with `<Dial timeout="18">` to her cell, shorter than her own voicemail's pickup time, plus a fallback URL that dials her cell directly if the server is down. | Number + ~1–2¢/min + ~5¢/min transcription | Day to day, nothing. One carrier setting, and it can be undone. |
| **Texts to Denise** (digest, reminders) | Outbox, Twilio sender | Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`. US A2P 10DLC registration (or toll-free verification) is required even to text herself, so start it on day 0; it takes days to weeks. Until it is approved, she opens the home-screen icon, and an email digest is a could. | Small one-off fees plus a few $/mo (verify) | None |
| **Automatic acknowledgement** | Built, off | The same Twilio number and registration, plus her approval of the wording | Pennies | None (it's her choice) |
| **Server** | n/a | One small VM (1 vCPU, 1 GB), Node 25, Caddy for automatic HTTPS, a systemd service, a nightly `VACUUM INTO` backup copied off the box, and a `/api/health` uptime ping | ~$5–6/mo | None |

---

## 8. AI usage

### 8.1 Where AI is used, and where it isn't
- **Used at exactly one call site:** `extractWithAI(text, meta)` in `server/ai.js`, which already exists and is tested. It is called from:
  1. `ingest()`, as a background refine of newly created jobs (§7.1 step 9);
  2. `POST /api/parse`, the Quick Add "Reading…" refine;
  3. Brain dump rows (could; up to 3 at a time).
- **Not used for:**
  - reply intent: keywords (D14);
  - who is on the list, its order, due dates, digests, numbers, matching, or stage changes;
  - customer texts: fixed templates (D15);
  - sending anything.

### 8.2 The call
```js
client.beta.messages.parse({
  model: AI_MODEL,                                  // process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"
  max_tokens: 4096,
  betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",   // refusal fallback, on by default
  output_config: { effort: "low", format: betaZodOutputFormat(Extraction) },  // structured output
  system: SYSTEM,
  messages: [{ role: "user", content: `Channel: ${channel}\nFrom: ${from}\n<message>\n${text.slice(0, 8000)}\n</message>` }],
})   // client: new Anthropic({ timeout: 20_000, maxRetries: 1 })
```
- **When it runs.** `aiEnabled()` decides:
  - `AI_PARSING=off`: false;
  - `AI_PARSING=on`: true;
  - otherwise: true when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set.
- **What it returns.** The normalised object, or `null` when AI is disabled, the model refused (`stop_reason === "refusal"`), the output didn't parse, or there was any error or timeout. On `null`, callers use the rules result.
- **Cost.** About 20–40 messages a week comes to a few dollars a month, at $2 / $10 per million tokens (input / output).

### 8.3 Extraction schema (`Extraction` in `server/ai.js`)

| Field | Type | Meaning | How it is used |
|---|---|---|---|
| `contact_name` | string \| null | The person's name, only if stated | Kept only if it appears in the raw text (§8.5) |
| `business_name` | string \| null | The business name, only if stated | Same check |
| `phone` | string \| null | The phone number, exactly as written | Kept only if its digits appear in the raw text. Never overrides the sender or caller ID. |
| `email` | string \| null | | Kept only if it appears verbatim, ignoring case |
| `address` | string \| null | | Kept only if it appears in the raw text |
| `equipment` | one of the 7 ids | Closest category, "other" if none | Used only if the rules found nothing or `other` |
| `summary` | string, max 8 words | What's wrong or wanted | Becomes `problem` (shortened to 60 characters) |
| `details` | string \| null | 1–2 more sentences | Becomes `details` |
| `urgency` | emergency \| normal \| routine | | `emergency` can set `urgent=1` and nothing else |
| `urgency_reason` | string \| null | | Shown in Job detail |
| `is_service_request` | boolean | false for spam, vendors or sales calls | false sets `ai_not_service=1`, which shows a "Not a job?" suggestion and never closes anything |

### 8.4 Prompt intent (`SYSTEM` in `server/ai.js`)
- The model reads messages sent to a small commercial refrigeration repair company.
- It extracts only what is stated, uses null for everything else, and never invents names, numbers or addresses.
- **Urgency:**
  - `emergency`: equipment is down, not holding temperature, leaking, food or product is at risk, or the customer says urgent, ASAP or today;
  - `routine`: maintenance, cleaning, a quote for new equipment, or "whenever".
- The message is customer-written data, not instructions to the model.

### 8.5 Guardrails: `mergeParse(rules, ai, raw, {channel})` in `shared/parse.js`
1. The raw message is stored first. The job is created from the rules. AI only refines.
2. **Phone.**
   - For SMS and calls, the sender or caller ID always wins.
   - Otherwise the regex result wins.
   - An AI phone is accepted only if `normalizePhone(ai.phone)`'s digits appear in the raw text's digits.
3. **Email.** The regex result wins. An AI email is accepted only if it appears in the raw text, ignoring case.
4. **Names and address.** An AI value is accepted only if its letters and digits, lowercased, appear in the raw text's letters and digits, lowercased. So "Tony's Trattoria" passes for "tonys trattoria". Otherwise it is discarded: blank beats wrong.
5. **Problem.** `problem = shorten(ai.summary, 60)` unless the summary is empty or "Service request". `details = ai.details`.
6. **Equipment.** The AI value is used only when the rules returned null or `other`.
7. **Urgency.** `urgent = rules.urgent || ai.urgency === 'emergency'`. `urgent_source` records which one set it.
8. **Spam flag.** `ai_not_service = ai.is_service_request === false ? 1 : 0`.
9. A late refine never overwrites a field that Denise has edited (§7.1 step 9).
10. Logs never include message bodies.
11. **Badges.** The UI shows "Filled in by AI - check it" or "Filled in for you - check it" on the Quick Add preview, and Job detail says "Details filled in by AI" when `parsed_by` is `ai`.

### 8.6 Rule-based parser: `parseMessage(text, opts)`, the always-on fallback

It returns the same shape as the AI result, plus `parsed_by:'rules'`, `urgent`, `urgent_hits[]`, `callback_date`, `quote_amount` and `stage_hint`.

- **Form labels.** Lines such as `Name:`, `Business:`, `Company:`, `Restaurant:`, `Store:`, `Phone:`, `Email:`, `Address:`, `Message:`, `Details:`, `Comments:`, `Description:` and `How can we help?:` (any case). A value runs until the next label line.
- **Phone.** `(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b`. Take the first match that is neither `owner_phone` nor `TWILIO_FROM`. For SMS and calls, the sender wins (§8.5). Seven-digit numbers are ignored.
- **Email.** `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`.
- **Unwrapping forwarded text** (`unwrapForward`).
  - Remove a leading `Fwd:` or `FW:`.
  - Remove lines reading "Begin forwarded message:", "-----Original Message-----" and "---------- Forwarded message ---------".
  - A line `From:? NAME (PHONE):` or `From: NAME PHONE` captures the name and phone.
- **Names.** Rules are tried in order; capitalised words only.
  - NAME = `[A-Z][a-z]+(?:[ -][A-Z][a-z]+)?`.
  - BIZ = `[A-Z0-9][\w'’&.#-]*(?:\s+(?:[A-Z0-9#][\w'’&.#-]*|of|the|and|&)){0,4}`. It stops at the first other lowercase word or punctuation.
  1. Intro patterns in the first 200 characters: `(this is|it's|its|it is|i'm|im|my name is) NAME( (at|from|with|over at) BIZ)?`, `^NAME (here )?(again )?(at|from|with) BIZ`, and `^BIZ:` (forwarded texts).
  2. Signature: a last line of `- NAME`.
  3. Email display name, from `From: Name <email>`.
  4. Quick Add and notebook lines only: the leading run of up to 4 capitalised tokens.
     - It is a business if it contains a business word (Diner, Grill, Market, Mart, Cafe, Bistro, Pizza, Pizzeria, Grocery, Deli, Bakery, Brewing, Brewery, Warehouse, Kitchen, Restaurant, Taqueria, Foods, Meats, Storage, Bar, Pub, Hotel, Wok, Cucina, Trattoria, Co., Inc, LLC) or has 2 or more tokens.
     - Otherwise it is a contact name.
  - All-lowercase texts get no names, so the title falls back to the phone number.
- **Equipment.** First match wins, in this order:
  1. `ice_machine`: `ice (machine|maker)|icemaker|(no|not making|isn'?t making|stopped making) ice`
  2. `display_case`: `display case|deli case|merchandiser`
  3. `prep_table`: `prep (table|cooler)|pizza table|sandwich (unit|table)|make ?line`
  4. `reach_in`: `reach[- ]?in|under ?counter`
  5. `walk_in_freezer`: `freezer`
  6. `walk_in_cooler`: `walk[- ]?in|cooler|fridge|refrigerator`
  7. `other`: `compressor|condens(er|ing unit)|evaporator`
  8. Otherwise null.
- **Urgency.** Case-insensitive, matched on word boundaries. Any hit sets `urgent=true`, and each hit is recorded.
  - **Equipment down:** `\bdown\b`; `not (cooling|cold|freezing|working|holding( temp(erature)?)?)`; `isn'?t (cooling|cold|freezing|working)`; `won'?t (cool|freeze|get cold)`; `stopped (working|cooling)`; `(not|isn'?t|stopped) making ice`.
  - **Temperature rising, leaks and alarms:** `warm(ing)?`, `thaw(ing|ed)?`, `melt(ing|ed)?`, `climbing`, `rising`, `leak(s|ing)?`, `flood(ing|ed)?`, `iced (up|over)`, `alarm`.
  - **Product at risk:** `spoil(ing|ed)?`, `(losing|lose|lost) (product|food|stock)`, `(food|product) (is )?at risk`.
  - **Asked for speed:** `emergency`, `urgent`, `asap`, `as soon as (possible|you can)`, `right away`, `\btoday\b`, `\btonight\b`.
  - **Inspections:** `health (inspector|inspection)`, `inspection`.
  - **Temperature rule:** `\b(-?\d{1,3})\s*(?:°|º|degrees?|deg)\s*f?\b` or `\b(-?\d{1,3})\s*f\b`.
    - With a freezer, a reading above 10 is urgent.
    - With `walk_in_cooler`, `reach_in`, `prep_table` or `display_case`, a reading above 41 is urgent.
  - **Routine and normal.** `urgency` is `routine` when there is no urgent hit and the text matches `quote|price|estimate|maintenance|clean(ing)?|descale|\bPM\b|no rush|whenever|next (week|month)|new (ice machine|walk-in|unit)`. Otherwise it is `normal`.
- **Summary** (becomes `problem`):
  1. Start from the form `Message` if there is one, else the text without label, header and forward lines.
  2. Remove phones, emails and URLs.
  3. Split into sentences on `[.!?]` or a newline.
  4. Strip greetings: `^(hi|hey|hello|good (morning|afternoon|evening))[,!.]?\s*(denise[,!.]?\s*)?`.
  5. Drop a leading sentence that is only an intro, meaning fewer than 4 words remain after NAME/BIZ. If an intro is followed by a comma, strip everything up to the comma.
  6. Take the first remaining sentence.
  7. Strip a leading `our|my|the`.
  8. Strip a leading `wants|needs|is asking for|asking for|looking for|would like|want|need`, then a leading `a|an|the`.
  9. Strip a trailing `,?\s*(can|could|would|will) (you|someone|somebody|u)\b.*$` and trailing punctuation.
  10. Apply `shorten(s, 60)`:
      - if over 60 characters, cut at the last ", ", " and " or " but " that starts between characters 25 and 59, with no ellipsis;
      - otherwise cut at the last space before character 59 and add "…".
  11. Capitalise the first letter. An empty result becomes null.
- **Reply intent** (`replyIntent`):
  - **yes:** `\b(yes|yep|yeah|yup|go ahead|sounds good|let'?s do it|do it|approved?|book (it|us)|deal)\b`
  - **no:** `\b(no thanks|not (right )?now|we'?ll pass|pass on|went with (someone|somebody|another)|found (someone|somebody)|too (much|expensive|pricey)|not interested|cancel)\b`
  - Both or neither: null.
- **Callback day** (Quick Add proposes a snooze). `call (me )?(back )?(on )?(mon|tue|wed|thu|fri|sat|sun)[a-z]*` or "tomorrow" gives the next such date after today.
- **Notebook lines** (`parseNotebook(text, ctx)`). For each non-empty line, run `parseMessage(line, {channel:'bulk'})`, then set `stage_hint` from the first match below:
  1. `(done|finished|completed)`: `done`.
  2. `(scheduled|booked|going out|coming out|on the schedule)`: `scheduled`.
     - `visit_date` is the next named day on or after today, or today or tomorrow, or `M/D`.
     - `tech` is the first settings tech name in the line.
  3. `(said yes|approved|go ahead|needs? (a )?(date|scheduling)|to schedule)`: `to_schedule`.
  4. `(quoted|sent (a |the )?quote|quote sent|waiting on (their )?yes)`, or a `$` amount: `waiting_yes`.
     - `quote_amount` comes from `\$?(\d{1,3}(?:,\d{3})+|\d{3,6})`, after phones are removed.
     - `quote_sent_at` is the latest named weekday on or before today at 12:00, else now.
  5. `(needs?|wants?) (a )?(quote|price)|quote|price|estimate`: `quote`.
  6. Otherwise `new`.

### 8.7 Parser fixtures (tests run with AI off; `owner_phone` = +13125550100)

**Message fixtures**

| # | Input (channel, from) | Expected |
|---|---|---|
| F1 | sms, +13125550142: "Hi its Marco at Bella Cucina, walk-in freezer at 28 and climbing, can someone come?" | contact "Marco"; business "Bella Cucina"; phone +13125550142; `walk_in_freezer`; urgent (climbing); problem "Walk-in freezer at 28 and climbing" |
| F2 | form (Postmark TextBody): "Name: Priya Shah\nBusiness: Fresh Mart #2\nPhone: (312) 555-0133\nEmail: priya.shah@freshmart.example\nMessage: Deli ice machine is making about half the ice it used to. Can someone look at it this week?" | contact "Priya Shah"; business "Fresh Mart #2"; phone +13125550133; email; `ice_machine`; not urgent; problem "Deli ice machine is making about half the ice it used to" |
| F3 | call voicemail, +13125550142: "Hi, this is Marco at Bella Cucina on Halsted. Our walk-in freezer is at 28 degrees and climbing and we just got a full delivery. Please call me back as soon as you can." | contact "Marco"; business "Bella Cucina"; `walk_in_freezer`; urgent (28 degrees, climbing, as soon as you can); problem "Walk-in freezer is at 28 degrees and climbing" |
| F4 | manual: "Dave from Hillside Grocery wants a quote on a new ice machine 312-555-0199" | contact "Dave"; business "Hillside Grocery"; phone +13125550199; `ice_machine`; routine; problem "Quote on a new ice machine"; stage_hint `quote` |
| F5 | sms, +13125550100 (owner): "Fwd: From Gus (312) 555-0174: hey denise any update on that freezer door quote?" | forwarded; phone +13125550174; contact "Gus"; `walk_in_freezer`; not urgent; problem "Any update on that freezer door quote" |
| F6 | manual: "555-444-1212 ice machine leaking" | phone +15554441212; `ice_machine`; urgent; problem "Ice machine leaking" |
| F7 | manual: "quote for PM cleaning next month" | equipment null; not urgent (routine); problem "Quote for PM cleaning next month" |
| F8 | manual: "walk-in cooler down, food at risk" | `walk_in_cooler`; urgent; problem "Walk-in cooler down, food at risk" |

**Notebook fixtures** (today = Mon Oct 5 2026)

| # | Line | Expected |
|---|---|---|
| B1 | "Joe's Diner walk-in, quoted 1800 tues, waiting" | business "Joe's Diner"; `waiting_yes`; $1,800; quote sent Tue Sep 29 |
| B2 | "Fresh Mart ice machine needs scheduling" | `to_schedule` |
| B3 | "Harbor Grill reach-in needs a quote 312-555-0125" | `quote`; phone set; no amount |
| B4 | "Sal's Pizza prep table scheduled thu with Luis" | `scheduled`; visit Thu Oct 8; tech Luis |
| B5 | "Lakeview brewing called about keg cooler, call back" | `new` |

---

## 9. Screens

### Global rules
- **Layout.**
  - Phone-first: one column, max width 520px, centred on desktop.
  - 16px side gutter. No sideways scrolling at 375px.
  - Base font 17px, system font stack. Every tap target at least 48px.
  - Urgency is shown with colour **and** text ("URGENT", "Not contacted").
  - htm escapes all text. Never use `dangerouslySetInnerHTML`.
- **Navigation.**
  - Hash routes; `public/app.js` imports from `/vendor/preact-htm.js` and `/shared/*.js`.
  - A bottom bar with 3 items: **Today**, **Jobs**, **+ New**.
  - Numbers and Settings are reached from the Jobs header. The Demo pill appears only when `DEMO=1`.
- **Refreshing.** Today refetches when it gains focus, every 60 seconds, and after every action.
- **Errors.** "Can't reach Callback right now. Your list will be back when the connection is." plus a **Retry** button.
- **PWA.** `manifest.webmanifest`: name and short name "Callback", `start_url "/#/"`, `display: "standalone"`, plus 192 and 512 px PNG icons and an apple-touch-icon. There is no service worker.

### Per screen

| Screen (route) | Contents | Interactions and key copy |
|---|---|---|
| **Today** `#/` | Header and stage strip (§4.8). Sections in bucket order, each with a divider "{label} ({count})" and its cards.<br>**Card:**<br>• line 1: bold title, URGENT and Repeat badges;<br>• line 2: subtitle · source label;<br>• line 3: the reason (2 lines at most);<br>• line 4: the chip;<br>• right side: **Call** (`tel:`) and **Text** (`sms:` with the draft from §13.3) buttons, 48px.<br>Footer (§4.8). | **Tapping the card body** opens the outcome sheet.<br>**Call / Text** log a tap, and the sheet opens automatically on return (§5.8).<br>**After an outcome**, the card slides out, or moves if it is still due. The header count updates and the toast (§5.5) offers **Undo**.<br>**Empty:** "All caught up. Nobody's waiting on you." |
| **Outcome sheet** (bottom sheet) | Title "How'd it go with {title}?", or "Did it get done at {title}?" for `check_done`.<br>When there is an unread reply, the customer's message is shown in a quote box above the buttons.<br>Main buttons (§5.3), full width. Pickers (§5.4) appear inside the sheet.<br>A quiet row of links. | No typing is required. At most 3 taps. Tapping outside the sheet closes it. |
| **Jobs** `#/jobs?stage=` | Header "{n} open jobs" · "Numbers" · gear icon (Settings).<br>Chips, wrapping: All open · New · Waiting on quote · Their yes · Said yes · Scheduled · Closed (last 30 days).<br>Search box: "Search name, business or phone".<br>"All open" is grouped by stage in stage order, with counts. | **Each row:** title, problem, and stage information:<br>• new: "Not contacted - 2d" or "Tried 2x";<br>• quote: "5 days";<br>• waiting_yes: "$2,400 · sent Thu";<br>• to_schedule: "said yes Fri";<br>• scheduled: "Tue · Mike";<br>• done: "done Fri";<br>• lost: "lost Thu · went elsewhere".<br>Tapping a row opens Job detail. |
| **Job detail** `#/job/:id` | Title, subtitle and stage pill. Then "Back on your list: Thu · Change", or "On today's list".<br>Phone (Call and Text), email, address (opens maps at `https://maps.google.com/?q=`).<br>Equipment chip, problem, urgent toggle, then optional fields: quote $, visit date, tech, notes. Fields are edited inline and saved on blur.<br>A stage stepper with the 7 stages (§5.7).<br>**History**, newest first: messages verbatim, outcomes, stage changes and "Reminder texted to you" lines, each as "Fri 4:47pm · …".<br>**Past jobs** for this customer.<br>Bottom: **Call** · **Text** · **Text a tech** (could) · **Lost**, or **Bring back** for closed jobs. | **Text a tech:** choose a tech, which opens `sms:{tech phone}` with "{business} - {address or 'no address'}\n{problem}\nContact: {contact} {phone}\n- Denise" and logs `tech_text` ("Sent details to Luis"). |
| **+ New** `#/new` | A large textarea: "Who is it and what's wrong? Paste a text or email, or tap the mic on your keyboard."<br>A live preview card using the rules in the browser (300 ms debounce). In the background it calls `POST /api/parse`, shows "Reading…", then "Filled in by AI - check it" or "Filled in for you - check it".<br>**Visible fields (3):** Who · Phone · What's wrong.<br>Chips: Urgent toggle; stage chips "Just came in" (default, or the `stage_hint`) / "I owe them a quote" / "Quote sent" (amount) / "Said yes" / "Scheduled" (day).<br>Repeat banner: "Repeat customer: Rosa's Taqueria - 1 past job". When that customer has an open job, it asks instead: "Add this to that job" (the text joins that job) or "It's a new job".<br>Button: "Add to my list". | **Validation:** "Add a name, a phone number, or what's wrong."<br>**Toast:** "Added. It's on your list."<br>**Link:** "Adding a bunch from your notebook? Paste one per line". |
| **Brain dump** `#/new/bulk` | Title "Bring over your notebook".<br>Textarea placeholder "One job per line, like: Joe's Diner walk-in, quoted 1800 tues, waiting".<br>**Read them** shows a row per line with a stage chip, amount and date, all editable.<br>**Add {n} jobs**. | Imported jobs whose next move is hers are due today. `waiting_yes` and `scheduled` follow the §3 rules. |
| **Numbers** `#/numbers` | Plain tiles, with no charts (§10). | **Text this to {husband_name}** opens `sms:{husband_phone}` with the summary. **Copy**. |
| **Husband's read-only page** `/n/:key` | A plain server-rendered HTML page with the same numbers (§10). | No buttons and no JS. |
| **Settings** `#/settings` | **You:** name, company, cell.<br>**Techs:** name and cell, up to 6.<br>**Texts to you:** morning time (7:00), Friday sweep and weekend texts, each on/off; "Preview my 7:00am text".<br>**Auto-reply to new callers:** OFF, with its text editable.<br>**Connections** (read-only status): "Reading messages: AI (claude-sonnet-5-5) / Rules only"; "Texts: Twilio / Simulated (outbox)"; webhook URLs; the "New Job" number.<br>**Husband's link:** copy or regenerate.<br>**Export CSV** (could). | Saves with `PUT /api/settings`. |
| **Digest preview** `#/digest` | "Your 7:00am text" as a message bubble with the exact text. "Before the weekend (Fridays 3:00pm)", when there is one. The last 20 outbox items. | **Send now** (kind `manual`). |
| **Demo controls** `#/sim` (only when `DEMO=1`) | Banner "Demo controls - not part of the product".<br>**Clock:** shows the demo time; buttons "Real time", "+30 min", "+2 hours", "+1 day", "Next Mon 7:00am", "Next Fri 3:00pm", and "Set…".<br>**Inbound presets** (§12.6), plus a custom form for channel, from and body.<br>**Outbox** and **Inbound log**.<br>**Health:** unlinked messages, AI mode, SMS mode.<br>**Reset demo**. | Every clock change runs the scheduler once. Messages that would have been sent in skipped-over time are not backfilled. |
| **Login** (only when `APP_PASSCODE` is set) | "Callback" · "Enter your passcode" · **Open** | A 180-day cookie. |

---

## 10. Numbers (for her husband)

All windows are rolling: the interval is (now − N days, now]. `not_a_job` jobs are excluded everywhere.

| Metric | Exact definition | At the seed anchor |
|---|---|---|
| Open jobs | Count of stage in (`new`, `quote`, `waiting_yes`, `to_schedule`, `scheduled`) | 13 |
| By stage | The count for each open stage | New 3, Waiting on quote 3, Their yes 2, Said yes 2, Scheduled 3 |
| Waiting on a yes | Sum of `quote_amount` where stage = `waiting_yes`, plus the count of those jobs | $8,400 (2 quotes) |
| Won, last 30 days | Count where `won_at` is in the window AND stage ≠ `lost`. $ = sum of `quote_amount` (nulls count as 0), plus a count of jobs with no amount. | 7 jobs, $4,750 (2 without a $) |
| Done, last 7 days | Count where `done_at` is in the window AND stage = `done` | 1 |
| Lost, last 30 days | Count where `lost_at` is in the window, stage = `lost`, and the reason ≠ `not_a_job`. Plus the subcount with reason `went_elsewhere`. | 1 (1 went with someone else) |
| New, last 7 days | Count where `created_at` is in the window | 12 |
| Leak line (screen only) | Open jobs in stage `new` with `first_touch_at` null and `created_at` ≤ now − 24h. Wording: "Waiting over a day for a first call: {n}", shown red when n > 0, or "Nobody waiting over a day for a first call". | 2 |

**Summary text** (`numbersText`; used by "Text this to Rick", the Copy button and `/n/:key`):
```
Frostline Refrigeration numbers - Mon Oct 5
Open jobs: 13 (New 3, Waiting on quote 3, Their yes 2, Said yes 2, Scheduled 3)
Waiting on a yes: $8,400 (2 quotes)
Won last 30 days: 7 jobs, $4,750
Done last 7 days: 1
Lost last 30 days: 1 (1 went with someone else)
New last 7 days: 12
```

---

## 11. Morning digest (plus the Friday sweep and reminders)

### Scheduler
`server/scheduler.js` exports `tick(nowIso)`.
- **When it runs:**
  - every 60 seconds (`setInterval`);
  - once at boot;
  - after every demo clock change;
  - during the seed replay.
- **What it does:** it builds Today at `now` and evaluates the rules below. Sends are idempotent through `outbox.dedupe_key`.
- **Side effect:** each job named in a sent text gets a `notified` event (actor `system`): "In your morning text", "In your weekend text", "In your before-the-weekend text" or "Reminder texted to you".

| Text | When | Condition | Dedupe key |
|---|---|---|---|
| **Weekday digest** | Local time in [`digest_time`, `digest_time`+3h), Mon–Fri | Always sent. Zero cards gets the "nobody" version. | `digest:{localDate}` |
| **Weekend digest** | Same window, Sat and Sun, when `weekend_digest` is on | Only if Call-first buckets (`emergency`, `replied`, `new`) are non-empty | `digest:{localDate}` |
| **Friday sweep** | Friday, local time in [15:00, 18:00), when `friday_sweep` is on | Only if `emergency`, `replied`, `new`, `to_schedule` or `quote` is non-empty | `sweep:{localDate}` |
| **Reminder for an untouched lead** | Local time in [07:00, 21:00) | Stage `new`, `first_touch_at` null, `now − created_at` ≥ 30 min if urgent or 120 min otherwise. Skipped if a digest or sweep naming the job went out in the last 60 minutes. | `nag:{jobId}`: once per job, ever |
| Monday summary to her husband (could) | Monday at `digest_time` | `husband_phone` is set and the setting is on | `husband:{localDate}` |

### Content (exact)

The link is `{PUBLIC_URL}/#/`. Each line is `{title} - {line reason}`.

**Weekday digest**
- First line: "Morning {owner_name} - {n} to call today:".
- Then up to 6 lines: "{i}. {title} - {line reason}".
- Then "+{k} more." if there are more.
- Then "Open: {link}".
- With 0 cards: "Morning {owner_name} - nobody's waiting on you today. Nice. Open: {link}".

**Weekend digest**
- First line: "Weekend check - {n} waiting on a call back:".
- Then the Call-first lines only.
- Then "Open: {link}".

**Line reasons** (`problem50` is the problem shortened to 50 characters):

| Bucket | Line reason |
|---|---|
| emergency | `{problem50} (URGENT)` |
| replied | `texted back`, `called (missed)` or `emailed back` |
| new | `new: {problem50 or fallback}`. The fallback is "missed call, no voicemail" or "what was it about?". |
| to_schedule | `said yes, needs scheduling` |
| quote | `quote to send` |
| nudge | `chase quote{ ($2,400)}` |
| check_done | `done? ({tech} went {day})` |

**Friday sweep:** "Before the weekend: {n} {people\|person} still waiting on you - {up to 3 titles, comma-separated}{, +k more}. Open: {link}"

**Reminder:** "Still not called back{ (URGENT)}: {title} - {problem50 or fallback}. Came in {dayTime(created_at)}.{ Call {phoneDisplay}.} Open: {PUBLIC_URL}/#/job/{id}"
- The " Call …" part is left out when the title is already the phone number.

### Delivery
`notify.send({to_phone, to_name, kind, body, job_id, dedupe_key})`:
1. Insert into the outbox. On a unique conflict, skip.
2. If `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` are all set, POST to `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json` with Basic auth and form fields `To`, `From`, `Body`, using `fetch`. Set `status='sent'` with `provider_id`, or `'failed'` with `error`.
3. Otherwise set `status='simulated'`.

It never throws.

- **Email delivery** (could): through the Postmark send API, when `POSTMARK_SERVER_TOKEN` and `DIGEST_EMAIL_TO` are set.
- **Preview:** `#/digest` and `GET /api/digest/preview`.

---

## 12. Demo seed data

### 12.1 Anchor and rules
- **The anchor.** The anchor A is **the most recent Monday 07:00 in the business time zone, at or before the real now**. Tests use the fixed anchor **Mon 2026-10-05 07:00 America/Chicago (= 2026-10-05T12:00:00.000Z)**.
- **How the seed is built.** `server/seed.js` exports `seedDemo(db, {anchor})` and runs from the CLI with `--reset`. It replays the action script below in time order through the real `ingest()`, `applyOutcome()` and the snooze path:
  - each action gets an explicit `now`;
  - AI is off (`{ai:false}`) and auto-acknowledgement is off;
  - ingest receives `fields` overrides so names and problems don't depend on parser quality.
- **Replaying the scheduler.** `tick()` runs every 5 minutes from **Fri 12:00** to **A** inclusive, interleaved with the actions.
- **At the end** it sets the clock to A (`setNow(A)`) and persists `clock_offset_ms`.
- **When it runs:** automatically on first boot with an empty database when `DEMO=1`; `npm run seed` and the "Reset demo" button wipe the database and reseed. **Press Reset demo right before recording.**
- **Settings:** the defaults from §6.
- **Phone numbers** are all fictional (555-01xx).

### 12.2 Records

Job IDs equal the creation order. Times are local. The dates assume the test anchor.

| ID | Customer (contact · phone · address) | Came in | Problem · equipment | Then | State at A | Today |
|---|---|---|---|---|---|---|
| 1 | Joe's Diner (Joe Russo · 555-0160 · 2301 S Halsted St) | Tue Jul 7 9:30am text: "Joe here from Joe's Diner. Walk-in door gasket is torn, can you replace it?" | Walk-in door gasket torn · walk_in_cooler | yes Jul 7 10:15am (visit Thu Jul 9, Mike) → done Jul 9 4:00pm, $275 | done | – |
| 2 | Rosa's Taqueria (Rosa Medina · 555-0118 · 3540 W 26th St) | Thu Aug 6 10:00am text: "Rosa from Rosa's Taqueria. Can you clean the ice machine? It's been a while." | Ice machine cleaning · ice_machine | yes 10:30am (visit Fri Aug 7, Dee) → done Aug 7 2:00pm, $350 | done | – |
| 3 | Lucia's Market (Lucia Ortiz · 555-0101 · 1645 W 18th St) | Sat Sep 12 9:00am text: "Hi it's Lucia from Lucia's Market, the ice machine isn't making ice" | Ice machine not making ice · ice_machine | yes 9:20am (visit Mon Sep 14, Luis) → done Sep 14 4:00pm, $480 | done | – |
| 4 | Taste of Seoul (Min-jun Kim · 555-0129) | Wed Sep 23 11:00am web form: "Our reach-in cooler compressor is really noisy. Can you quote a replacement?" | Reach-in compressor noisy - wants a quote · reach_in | need_quote 1:00pm → quote_sent Thu Sep 24 10:00am $1,200 → lost Thu Oct 1 5:00pm (went_elsewhere) | lost | – |
| 5 | Northside Cold Storage (Tom Becker · 555-0112 · tbecker@northsidecold.example · 4800 N Ravenswood Ave) | Sat Sep 26 10:00am web form: "Two evaporator fan motors in the freezer room are failing. Need a quote to replace both." | Freezer room evaporator fan motors failing · walk_in_freezer | need_quote Mon Sep 28 9:30am → quote_sent Fri Oct 2 11:00am $6,000 | waiting_yes, due Tue Oct 6 | no (comes back Tuesday) |
| 6 | Union Warehouse (Ray Dawson · 555-0183) | Sun Sep 27 8:30am voicemail: "Ray Dawson at Union Warehouse. The condensing unit on the dock freezer is making a racket. Can you send someone this week?" | Dock freezer condensing unit making a racket · walk_in_freezer | need_quote Mon Sep 28 8:10am → quote_sent 3:00pm $1,800 → yes Tue Sep 29 9:00am (visit Fri Oct 2, Sam) → done Fri Oct 2 3:30pm | done | – |
| 7 | Rosa's Taqueria (repeat of #2) | Tue Sep 29 10:05am text: "Hi Denise, the walk-in cooler keeps short cycling and the compressor sounds rough. Can you take a look?" | Walk-in cooler compressor short cycling · walk_in_cooler | need_quote 2:00pm → quote_sent Thu Oct 1 2:10pm $2,400 | waiting_yes, due Mon 00:00 | nudge |
| 8 | Harbor Grill (Ana Ruiz · 555-0125 · 1120 N State St) | Tue Sep 29 11:15am web form: "Our reach-in by the line needs a new door gasket and the hinge is loose. When can you come?" | Reach-in door gasket and loose hinge · reach_in | quote_sent ("Quoted on the call") Wed Sep 30 9:30am $540 → yes Fri Oct 2 10:00am (visit Tue Oct 6, Mike). **Sun Oct 4 6:05pm** text: "Can Mike come Wednesday instead of Tuesday? We're closed Tuesdays." | scheduled Tue, unread reply | replied |
| 9 | Maple Street Bakery (Linda Park · 555-0138) | Tue Sep 29 1:00pm voicemail: "This is Linda at Maple Street Bakery. The reach-in door hinge broke and the gasket is torn. Please call me." | Reach-in door hinge broke, gasket torn · reach_in | quote_sent (on the call) 3:00pm $780 → yes Thu Oct 1 10:30am (no date) → snooze Thu 10:31am until Wed Oct 7 | to_schedule, snoozed | no (footer "Put off till later: 1") |
| 10 | Sal's Pizza (Sal Romano · 555-0190) | Tue Sep 29 4:00pm text: "Sal here from Sal's Pizza. Prep table cooler fan is making a grinding noise, can someone swap it?" | Prep table cooler fan grinding · prep_table | yes Wed Sep 30 3:00pm (visit Fri Oct 2, Luis) | scheduled, visit has passed, due Mon | check_done |
| 11 | Midway Meats (Gus Petrakis · 555-0174) | Wed Sep 30 8:45am text: "Gus at Midway Meats. Freezer door gasket is shot and the heater wire is out. Need a price." | Freezer door gasket and heater wire · walk_in_freezer | need_quote 10:20am | quote since Wed | quote |
| 12 | Golden Wok (Kevin Chen · 555-0147) | Wed Sep 30 9:00am text: "Kevin at Golden Wok, time for the ice machine cleaning again" | Ice machine cleaning and descale · ice_machine | yes Thu Oct 1 12:00pm (visit Mon Oct 5, Dee) | scheduled today | no (footer "Scheduled today: 1") |
| 13 | Joe's Diner (repeat of #1) | Wed Sep 30 12:00pm text: "Joe again from Joe's Diner. The walk-in cooler fan motor is squealing pretty loud." | Walk-in cooler fan motor squealing · walk_in_cooler | need_quote 1:00pm → quote_sent Thu Oct 1 4:00pm $1,150 → yes Fri Oct 2 1:30pm (no date) | to_schedule since Fri | to_schedule |
| 14 | Hillside Grocery (Dave Kowalski · 555-0199) | Thu Oct 1 9:10am text: "Hi Denise, Dave from Hillside Grocery. Looking for a price on a new ice machine for the front, no rush." | Price on a new ice machine · ice_machine | need_quote 11:00am | quote since Thu | quote |
| 15 | Lakeview Brewing Co. (Nora Lindqvist · 555-0151 · nora@lakeviewbrewing.example) | Fri Oct 2 8:15am web form by email (Postmark): "Name: Nora Lindqvist / Business: Lakeview Brewing Co. / Phone: (312) 555-0151 / Message: We need a price on a second walk-in cooler for kegs." | Price on a second walk-in cooler for kegs · walk_in_cooler | need_quote 9:40am | quote since Fri | quote |
| 16 | **Bella Cucina** (Marco Rossi · 555-0142 · 1820 N Halsted St) | **Fri Oct 2 4:47pm voicemail:** "Hi, this is Marco at Bella Cucina on Halsted. Our walk-in freezer is at 28 degrees and climbing and we just got a full delivery. Please call me back as soon as you can." | Walk-in freezer at 28 degrees and climbing · walk_in_freezer · urgent (rules) | nothing (Denise was slammed) | new, urgent, untouched | **emergency** |
| 17 | (unknown) 555-0177 | Sat Oct 3 1:12pm missed call, no voicemail | – | nothing | new | new |
| 18 | Fresh Mart #2 (Priya Shah · 555-0133 · priya.shah@freshmart.example · 4410 W Irving Park Rd) | Mon Oct 5 6:02am web form by email (Postmark): "Name: Priya Shah / Business: Fresh Mart #2 / Phone: (312) 555-0133 / Message: Deli ice machine is making about half the ice it used to. Can someone look at it this week?" | Deli ice machine making half the ice · ice_machine | nothing | new | new |

All phone numbers in this table are (312) numbers.

### 12.3 Today at A (exact; test T04)

Header: "Monday, Oct 5" / "10 people to call" / "$8,400 waiting on a yes".

| # | Divider | Title (badges) | Reason | Chip (tone) |
|---|---|---|---|---|
| 1 | Urgent - call first (1) | Bella Cucina (URGENT) | Walk-in freezer at 28 degrees and climbing - voicemail Fri 4:47pm, nobody's called back | Not contacted - 2d 14h (red) |
| 2 | They got back to you (1) | Harbor Grill | Texted yesterday 6:05pm: "Can Mike come Wednesday instead of Tuesday? We're closed…" | Waiting 12h (grey) |
| 3 | New - call them back (2) | (312) 555-0177 | New - missed call Sat 1:12pm - no voicemail | Not contacted - 1d 17h (amber) |
| 4 | | Fresh Mart #2 | New - web form today 6:02am - Deli ice machine making half the ice | Not contacted - 58m (grey) |
| 5 | Said yes - needs scheduling (1) | Joe's Diner (Repeat - 1 past job) | Said yes Fri - not scheduled yet - hasn't heard from us in 3 days | Waiting 2d 17h (red) |
| 6 | Waiting on your quote (3) | Midway Meats | Waiting on your quote since Wed - hasn't heard from us in 5 days | Waiting 4d 20h (red) |
| 7 | | Hillside Grocery | Waiting on your quote since Thu - hasn't heard from us in 4 days | Waiting 3d 20h (red) |
| 8 | | Lakeview Brewing Co. | Waiting on your quote since Fri - hasn't heard from us in 3 days | Waiting 2d 21h (red) |
| 9 | Waiting on their yes - check in (1) | Rosa's Taqueria (Repeat - 1 past job) | Quote sent Thu, $2,400 - no answer in 4 days | Waiting 3d 16h (amber) |
| 10 | Did it get done? (1) | Sal's Pizza | Luis went Fri - done? | – |

- Strip: "New 3 · Waiting on quote 3 · Their yes 2 · Said yes 2 · Scheduled 3".
- Footer: "Scheduled today: 1 · Put off till later: 1" / "Last 24 hours: 1 came in, 1 not called yet".

### 12.4 Outbox at A (produced by the scheduler replay)

All bodies end with "Open: http://localhost:3000/#/", or with the job link for reminders.

| Local time | Kind | Body |
|---|---|---|
| Fri 3:00pm | friday_sweep | Before the weekend: 3 people still waiting on you - Joe's Diner, Midway Meats, Hillside Grocery. Open: … |
| Fri 5:20pm | nag (job 16) | Still not called back (URGENT): Bella Cucina - Walk-in freezer at 28 degrees and climbing. Came in today 4:47pm. Call (312) 555-0142. Open: http://localhost:3000/#/job/16 |
| Sat 7:00am | digest | Weekend check - 1 waiting on a call back:<br>1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)<br>Open: … |
| Sat 3:15pm | nag (job 17) | Still not called back: (312) 555-0177 - missed call, no voicemail. Came in today 1:12pm. Open: http://localhost:3000/#/job/17 |
| Sun 7:00am | digest | Weekend check - 2 waiting on a call back:<br>1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)<br>2. (312) 555-0177 - new: missed call, no voicemail<br>Open: … |
| Mon 7:00am | digest | Morning Denise - 10 to call today:<br>1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)<br>2. Harbor Grill - texted back<br>3. (312) 555-0177 - new: missed call, no voicemail<br>4. Fresh Mart #2 - new: Deli ice machine making half the ice<br>5. Joe's Diner - said yes, needs scheduling<br>6. Midway Meats - quote to send<br>+4 more. Open: … |

Job 16's history then reads:
1. Fri 4:47pm · Voicemail came in (with the verbatim quote)
2. Fri 5:20pm · Reminder texted to you
3. Sat 7:00am · In your weekend text
4. Sun 7:00am · In your weekend text
5. Mon 7:00am · In your morning text

### 12.5 Numbers at A
As in §10: 13 open · $8,400 waiting on a yes (2 quotes) · won 7 jobs, $4,750 · done 1 · lost 1 (1 went with someone else) · new 12 · leak line 2.

### 12.6 Live demo presets (`POST /api/sim/inbound {preset}`)

Each preset builds a provider-shaped payload and runs it through the real adapter.

| Preset | Payload | Expected result |
|---|---|---|
| `rosa_yes` | Twilio SMS from 555-0118: "yes go ahead, thursday works for us" | Attaches to job 7. Shows under They got back to you with a "Mark as yes?" button. |
| `lucia_repeat` | Twilio SMS from 555-0101: "ice machine acting up again, can someone come this week?" | New job "Lucia's Market", with "Repeat - 1 past job" and source Text |
| `web_form_tony` | Postmark JSON: "Name: Tony Russo / Business: Tony's Bistro / Phone: (312) 555-0187 / Message: Walk-in freezer at 10F and rising. Please call." | New job, urgent (rising), source Web form. Repeating it returns `duplicate`. |
| `voicemail_carla` | Twilio voice from 555-0164 with TranscriptionText "Hey it's Carla from Westside Diner, our ice machine is leaking all over the kitchen floor. Call me back at 312-555-0164." | New job, urgent (leaking), source Voicemail |
| `forward_midway` | Twilio SMS from the owner (555-0100): "Midway Meats: hey denise any update on that freezer door quote?" | Matched by business name and attached to job 11 (replied) |
| `spam_call` | Twilio voice from 555-0155, answered, 8 seconds | `ignored` |
| `answered_call` | Twilio voice from 555-0168, answered, 120 seconds | New job: "New - call … - what was it about?" |

All numbers in these presets are (312) numbers.

- **Quick Add demo text:** "Dave's Deli 312-555-0193 reach-in not cooling, wants someone today".
- **Expected result:** business "Dave's Deli", reach_in, urgent, problem "Reach-in not cooling, wants someone today".

---

## 13. API contract

### 13.1 Code layout

```
shared/     pure ES modules, used by both server and browser (served at /shared/*)
  time.js         business days + time-zone math (DST-safe)
  format.js       phones, money, titles, source labels
  stages.js       the 7 stages; enterStage, outcomesFor, applyOutcome (every "How'd it go?" answer)
  today-rules.js  buckets, order, reasons, chips; digest / sweep / reminder text
  parse.js        rule-based reader for texts, emails, voicemails and notebook lines; mergeParse guardrails
  stats.js        Numbers, the summary text and the tiles
  templates.js    pre-written texts to customers and techs
server/
  index.js        boot: env, database, demo clock, seed, scheduler, startup line
  runtime.js      the boot steps index.js and the Vercel entry share (production rules, DB, seed)
  env.js          reads .env when it exists
  app.js          the Express app: webhooks, static files, passcode guard, API, demo routes
  auth.js         passcode login and the session cookie
  context.js      ctx for the rules, job/settings serialization
  actions.js      outcomes, stage moves, edits and undo, each in one transaction
  ingest.js       the one intake pipeline: store raw, dedupe, match, attach or create, AI refine
  adapters.js     Twilio SMS/voice, Postmark, Mailgun, raw email and form adapters; signature checks
  presets.js      the simulator's provider-shaped payloads
  ai.js           optional Claude extraction (structured outputs); never blocks or loses a lead
  scheduler.js    7am digest, Friday sweep, untouched-lead reminders (idempotent)
  notify.js       outbox + Twilio sender (simulated without keys)
  seed.js         demo week, replayed through the real ingest / outcomes / scheduler
  numbers-page.js the husband's read-only page (/n/:key)
  clock.js        the demo-aware clock
  db.js, repo.js  schema and queries
  routes/         api.js (JSON API), inbound.js (webhooks), sim.js (demo only)
public/      Preact + htm, no build step: app.js, api.js, screens/, ui/, styles.css
test/        node:test: unit + integration (in-memory SQLite, real HTTP)
api/         index.js: the Vercel demo function (always a demo; SQLite in /tmp)
scripts/     e2e.mjs: walks docs/DEMO.md in headless Chrome
```

### 13.2 Shared module contracts

Every function is pure. `ctx = {now: ISO, tz, settings, publicUrl}`.

- **`time.js`:**
  - `localDate(iso,tz)`, `localHM(iso,tz)`, `weekdayOf(ymd)` (0 = Sun);
  - `addDays`, `isBusinessDay`, `nextBusinessDay`, `addBusinessDays`;
  - `startOfDay(ymd,tz)`, `atLocal(ymd,'HH:MM',tz)`, `addMinutes(iso,n)`, `daysBetween(ymdA,ymdB)`;
  - `formatAge(fromIso,toIso)`, `dayLabel(isoOrYmd,nowIso,tz)`, `timeLabel(iso,tz)`, `dayTimeLabel`, `whenLabel`;
  - `longDateLabel(iso,tz)`, `shortDateLabel(iso,tz)`;
  - `mostRecentMonday0700(nowIso,tz)`, which returns an ISO instant.
- **`format.js`:**
  - `normalizePhone`, `phoneDisplay`, `money`, `trunc(s,n)`, `shorten(s,n=60)`, `firstName`;
  - `titleFor(jobView)`, `subtitleFor(jobView)`.
- **`stages.js`:**
  - Constants: `STAGES`, `OPEN_STAGES`, `DENISE_OWES`, `LOST_REASONS`, `EQUIPMENT`, `OUTCOMES`.
  - `isOpen(stage)`, `canTransition(from,to)`.
  - `enterStage(job,to,ctx,opts)` returns a patch.
  - `outcomesFor(jobView,{suggestion})` returns `OutcomeButton[]`.
  - `applyOutcome(jobView,id,args,ctx)` returns `{patch,event,toast}`, or throws `OutcomeError(code)`.
- **`today-rules.js`:**
  - `isDue(job,now)`, `bucketFor(jobView,ctx)`, `replySuggestion(jobView)`.
  - `reasonFor`, `chipFor`, `cardFor(jobView,ctx)` (returns a `Card`), `compareCards`.
  - `buildToday(jobViews,ctx)` returns a `Today`.
  - `digestText(today,ctx)` returns `{body, send:boolean}` (handles the weekday and weekend rules).
  - `sweepText(today,ctx)` returns a string or null.
  - `nagText(jobView,ctx)`.
- **`templates.js`:**
  - `smsDraft(jobView,bucket,ctx)`, `techText(jobView,ctx)`;
  - `smsLink(phone,body)`, which returns `sms:${phone}?&body=${encodeURIComponent(body)}`;
  - `telLink(phone)`.
- **`parse.js`:**
  - `parseMessage(text,opts)` returns a `Parse`.
  - `mergeParse(rules,ai,raw,opts)`, `parseNotebook(text,ctx)`.
  - `detectUrgency(text,equipment)` returns `{urgent,hits}`.
  - `detectEquipment(text)`, `unwrapForward(text,ownerPhone)`, `replyIntent(text)`.
- **`stats.js`:** `computeNumbers(jobViews,ctx)` returns `Numbers`; `numbersText(numbers,ctx)`.

### 13.3 SMS draft templates (`smsDraft`)

- `{first}` is the contact's first name; the greeting becomes "Hi," when there is none.
- `{thing}` is the equipment label in lowercase, or "service request".
- `{company}` comes from settings.

| Situation | Draft |
|---|---|
| new, emergency (not yet tried) | Hi {first}, it's Denise at {company}. Got your message about the {thing}. Is now a good time to call? |
| new, emergency (already tried) | Hi {first}, it's Denise at {company} - tried calling about the {thing}. Call or text me back at this number when you can. |
| replied | Hi {first}, thanks for your message - I'll get back to you shortly. - Denise |
| quote | Hi {first}, it's Denise at {company}. I'm working on your quote for the {thing} - you'll have it shortly. |
| nudge | Hi {first}, it's Denise at {company}. Just checking on the quote for the {thing}{ ($2,400)} - want us to get it on the schedule? |
| to_schedule | Hi {first}, it's Denise at {company}. Thanks for the go-ahead on the {thing} - what day works best for us to come out? |
| check_done | Hi {first}, it's Denise at {company}. Just making sure everything's working right with the {thing} after {tech or "our"} visit. |
| scheduled (future) | Hi {first}, it's Denise at {company}. Confirming {tech or "our tech"} for {day} for the {thing}. |

### 13.4 Types (JSON)

```ts
type Card = { job_id: number; bucket: Bucket; rank: number; title: string; subtitle: string|null;
  urgent: boolean; repeat: { past_jobs: number }|null; reason: string; chip: { text: string; tone: 'red'|'amber'|'grey' }|null;
  source: Source; source_label: string; stage: StageId; stage_label: string;
  phone: string|null; phone_display: string|null; tel_link: string|null; sms_link: string|null;
  suggestion: 'mark_yes'|'mark_lost'|'not_a_job'|'mark_lost_tries'|null;
  last_inbound: { at: ISO; at_label: string; channel: string; body: string }|null;
  outcomes: OutcomeButton[] };
type OutcomeButton = { id: OutcomeId; label: string; primary: boolean; suggested: boolean;
  needs: null|'day'|'day_or_none'|'amount'|'lost_reason'|'snooze_day'; preset?: { lost_reason?: string } };
type Today = { now: ISO; date_label: string; count: number; header: string;
  waiting_yes_total: number; waiting_yes_count: number;
  sections: { bucket: Bucket; label: string; count: number; items: Card[] }[];
  stage_counts: Record<'new'|'quote'|'waiting_yes'|'to_schedule'|'scheduled', number>; open_count: number;
  footer: { scheduled_today: number; snoozed: number; last24h_text: string };
  demo: { shifted: boolean; label: string|null } };
type Job = JobRow & { title; subtitle; stage_label; source_label; equipment_label; phone_display; email; address;
  repeat; on_today: boolean; bucket: Bucket|null; reason: string|null; back_on_list: string|null };
type TimelineItem = { id; at: ISO; at_label: string; actor: 'denise'|'customer'|'system'; kind: string;
  summary: string; body?: string; channel?: string; undone: boolean };
type ApiError = { error: { code: 'validation'|'unauthorized'|'forbidden'|'not_found'|'invalid_outcome'|'missing_arg'
  |'stale_stage'|'undo_not_allowed'|'duplicate'; message: string } };
```

### 13.5 Endpoints

**Auth.** When `APP_PASSCODE` is set, every `/api/*` route needs the `cb_session` cookie, except `/api/login`, `/api/health` and `/api/inbound/*`. The cookie is an HMAC of `SESSION_SECRET`, httpOnly, SameSite=Lax, valid for 180 days.

| Method and path | Request | Response |
|---|---|---|
| GET `/api/health` | – | `{ok:true, now, tz, ai:'claude'\|'rules', ai_model, sms:'twilio'\|'simulated', demo, passcode, unlinked_messages, clock_offset_ms}` |
| POST `/api/login` | `{passcode}` | `200 {ok:true}` plus the cookie, or 401 |
| GET `/api/today` | – | `Today` |
| GET `/api/jobs` | `?stage=open\|closed\|<StageId>&q=` (default `open`; `q` matches title, contact, problem, or 3+ digits of a phone) | `{now, counts:{…stage}, jobs: Job[]}` (closed = the last 30 days) |
| GET `/api/jobs/:id` | – | `{job: Job, customer, timeline: TimelineItem[], past_jobs: Job[], outcomes: OutcomeButton[], sms_link, tel_link}` |
| POST `/api/parse` | `{text, use_ai?:true}` | `{mode:'ai'\|'rules', fields:{contact_name,business_name,phone,email,address,equipment,problem,details,urgent}, urgent_hits, stage_hint, callback_date, quote_amount, matched_customer:{id,title,past_jobs}\|null}` |
| POST `/api/jobs` | `{text?, fields:{…}, stage?:'new'\|'quote'\|'waiting_yes'\|'to_schedule'\|'scheduled', visit_date?, tech?, quote_amount?, snooze_until?, parse_mode?}` | `201 {job_id, customer_id, matched_customer:boolean, toast:"Added. It's on your list."}`. Writes a `manual` message row holding the original text. 400 if who, phone and problem are all empty. |
| POST `/api/bulk/parse` | `{text}` | `{rows:[{line, fields, stage, quote_amount, quote_sent_at, visit_date, tech, matched_customer}]}` |
| POST `/api/bulk` | `{rows:[…as above, edited]}` | `201 {created:[job_id]}` |
| PATCH `/api/jobs/:id` | any of `{contact_name, business_name, phone, email, address, equipment, problem, details, urgent, quote_amount, visit_date, tech, notes}` | `{job}`. Logs an `edit` event, for example "Changed phone" or "Marked urgent". |
| POST `/api/jobs/:id/outcome` | `{outcome, visit_date?:YMD\|null, tech?, amount?, lost_reason?, snooze_until?:YMD, block?:boolean, expected_stage?}` | `{job, event_id, toast, today_count, on_today}`. Errors: 422 `invalid_outcome` / `missing_arg`, 409 `stale_stage`. |
| POST `/api/jobs/:id/stage` | `{to, visit_date?, tech?, amount?, lost_reason?}` | Same as outcome. This is not contact. |
| POST `/api/jobs/:id/undo` | `{event_id}` | `{job, today_count}`, or 409 `undo_not_allowed` |
| POST `/api/jobs/:id/tap` | `{kind:'call'\|'text'\|'tech_text', tech?}` | 204 |
| GET `/api/numbers` | – | `Numbers` plus `summary_text` |
| GET `/n/:key` | – | Read-only HTML. A wrong key returns 404. |
| GET / PUT `/api/settings` | partial settings on PUT | settings plus `integrations`, `readonly_url`, `webhook_urls`, `forwarding_number` |
| GET `/api/digest/preview` | – | `{digest:{body, send}, sweep: string\|null, now}` |
| POST `/api/digest/send` | – | `{outbox_id}` (kind `manual`) |
| GET `/api/outbox?limit=50` | – | `{items:[{id, created_at, at_label, kind, to_phone, to_name, body, status, job_id}]}` |
| GET `/api/messages?limit=50` | – | `{items:[{id, received_at, channel, provider, from_phone, from_email, subject, body, status, job_id}]}` |
| GET `/api/export/jobs.csv` (could) | – | CSV with id, title, contact, phone, email, stage, problem, equipment, urgent, quote_amount, created_at, won_at, done_at, lost_at, lost_reason |
| POST `/api/inbound/{sms\|call\|email\|form}` and the aliases | §7.2 | §7.2 |
| POST `/api/sim/inbound` (`DEMO=1` only) | `{preset}` or `{channel, from, body, call_status?, duration_s?, format?:'twilio'\|'postmark'\|'generic'\|'raw'}` | The ingest result |
| POST `/api/sim/clock` (`DEMO=1` only) | `{preset:'real'\|'plus_30m'\|'plus_2h'\|'plus_1d'\|'next_mon_0700'\|'next_fri_1500'}` or `{set: ISO}` | `{now, offset_ms, sent: OutboxItem[]}` (runs `tick`; persists the offset) |
| POST `/api/sim/tick` (`DEMO=1` only) | – | `{sent}` |
| POST `/api/sim/reset` (`DEMO=1` only) | – | `{now}` (reseeds) |

Every domain function on the server takes an explicit `now`. HTTP handlers pass `clock.now().toISOString()`.

### 13.6 Runtime and configuration

**`.env.example`:**
```
PORT=3000
PUBLIC_URL=
DB_PATH=data/callback.db
BUSINESS_TZ=America/Chicago
DEMO=
APP_PASSCODE=
SESSION_SECRET=
INBOUND_TOKEN=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5-5
AI_PARSING=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
MAILGUN_SIGNING_KEY=
```

**Rules**
- `DEMO` defaults to on; `NODE_ENV=production` always turns it off.
- `PUBLIC_URL` defaults to `http://localhost:{the port actually bound}`.
- `SESSION_SECRET` is optional: when blank, one is generated once and stored in the database.
- If `NODE_ENV=production` and `APP_PASSCODE` is empty, refuse to start. The same with a signature key set and no public `PUBLIC_URL`.

**Startup log** (one line):

`Callback on http://localhost:3000 | AI: rules only (set ANTHROPIC_API_KEY for claude-sonnet-5-5) | SMS: simulated (outbox) | Inbound: /api/inbound/{sms,call,email,form} | Passcode: off | Demo: on, clock Mon Oct 5 7:00am`

---

## 14. Acceptance tests

**M** = must-have, S = should, C = could, W = won't (checks a cut). Unit tests use `node:test` with the fixed anchor Mon 2026-10-05 07:00 America/Chicago. Integration tests use `:memory:` SQLite.

| ID | Pri | Test |
|---|---|---|
| T01 | M | **Time.** `addBusinessDays('2026-10-01',2)='2026-10-05'`; `('2026-10-02',2)='2026-10-06'`; `('2026-10-03',1)='2026-10-05'`. `nextBusinessDay('2026-10-02')='2026-10-05'`. `startOfDay('2026-10-30')='2026-10-30T05:00:00.000Z'`; `startOfDay('2026-11-02')='2026-11-02T06:00:00.000Z'` (after DST ends). `formatAge` from Fri 16:47 to Mon 07:00 = "2d 14h". `dayLabel` covers today, yesterday, tomorrow, a weekday, and "Oct 14". |
| T02 | M | **Invariant.** For every stage × every outcome it offers (with sample args), `applyOutcome` leaves closed jobs with `next_due_at` null and open jobs with a valid ISO date. Outcomes not offered throw `invalid_outcome`. An `INSERT` that breaks the rule fails the SQL CHECK. |
| T03 | M | **Bucket precedence** on a table of synthetic jobs:<br>• urgent `new` → emergency;<br>• urgent `new` with an unread reply → emergency;<br>• `waiting_yes` with a reply, not due → replied;<br>• snoozed job with a reply → replied;<br>• urgent `waiting_yes`, due → nudge;<br>• `scheduled` in the future → none;<br>• `scheduled` with the visit passed → check_done;<br>• closed → none.<br>Each job lands in exactly one bucket. |
| T04 | M | **Seed.** At A, `buildToday` returns exactly the 10 cards in §12.3, in order, with the exact reasons, chips, tones, header, strip and footer. |
| T05 | M | **R24 (her move vs theirs).** Job A enters `quote` on Mon 10:00 → on Today at 07:00 on Tue, Wed, Thu and Fri until "Quote sent". Job B is `waiting_yes`, snoozed to Thu → absent at 07:00 Mon–Wed, present Thu 07:00 under "Waiting on their yes - check in". |
| T06 | M | **R19 (changed to business days).**<br>• `quote_sent` Mon 10:00 → absent all of Tuesday; present from Wed 00:00 with "Quote sent Mon - no answer in 2 days".<br>• `still_thinking` Wed 09:00 → absent until Fri 00:00.<br>• `quote_sent` Fri 11:00 → absent Sat, Sun and Mon; present Tue. |
| T07 | M | **R08 (Friday freezer).** A call lead from Fri 16:47, "freezer down", untouched: at Mon 07:00 it is the first card, bucket emergency, chip "Not contacted - 2d 14h", red. |
| T08 | M | **R07 (never auto-closes).** Seed plus 20 untouched leads, then 14 days of `tick` every 15 minutes. The open count is unchanged; every open job is on Today or has a future `next_due_at`; no event with actor `system` changed a stage. |
| T09 | M | **Emergency handling.** An urgent `quote` job outranks a `replied` job. `no_answer` on an urgent job gives `next_due_at` = now + 1h. `need_quote` on an urgent job gives now + 2h. |
| T10 | M | **Snooze.** Snoozing to Wed hides the job until Wed 00:00 and leaves `last_touch_at` unchanged. A text during the snooze shows the job under replied. "Seen it" hides it again until Wed, where its chip is "Call back today". |
| T11 | S | **Three tries.** A `waiting_yes` job with `nudges=3` reads "… - 3 tries, no answer. Mark lost?", and its first button is "Mark lost" with `no_response`. |
| T12 | M | **Undo.** `quote_sent` then undo leaves the job row identical to before. A second undo returns 409. Undo after 10 minutes returns 409. |
| T13 | M | **Parser.** Fixtures F1–F8 (§8.7) give exactly the listed fields with AI off. |
| T14 | M | **`mergeParse` guardrails.** An AI phone not in the text is dropped. An AI name not in the text is dropped. AI `normal` cannot clear a rules `urgent`. AI `emergency` raises it. The SMS sender beats an AI phone. AI `is_service_request=false` adds a suggestion and closes nothing. |
| T15 | S | **Notebook.** Fixtures B1–B5 give the listed stages, amounts and dates. |
| R01 | S | **Missed call.** With no Twilio variables, the simulator's missed call from (312) 555-0177 creates a `new` job: source label "Missed call", a `tel:` link, the time it came in. The same call POSTed to `/api/inbound/call` as a Twilio form or as generic JSON gives an identical job. |
| R02 | M | **Web-form email.** The Postmark JSON (Tony's Bistro preset) POSTed to `/api/inbound/email` creates a `new` job with name, phone and problem filled in, source "Web form", and urgent. POSTing the same Message-ID again returns `{status:'duplicate'}` and adds no row. A raw pasted email gives the same fields. |
| R03 | S | **Repeat text.** An SMS from (312) 555-0101, "ice machine acting up again", creates a job titled "Lucia's Market" with "Repeat - 1 past job" and source "Text". An unknown number gets its formatted phone as the title. |
| R04 | M | **Quick Add, minimal.** At 390px: tap "+ New", type "555-444-1212 ice machine leaking", tap "Add to my list". The job is saved with no other required field, urgent, under "Urgent - call first", in at most 3 taps besides typing. |
| R05/R26 | M | **One list.** One lead each by call, form email, SMS, forwarded email and manual entry all appear on the single Today list with distinct source labels. No other screen is needed to find them. |
| T16 | M | **Raw message first.** With an injected parser error, the message row exists with `status='error'`, a job "Couldn't read this one - tap to look" is created, and `/api/health` reports `unlinked_messages: 0`. |
| T17 | S | **Forwarded texts.** The owner-number preset `forward_midway` attaches to Midway Meats and shows it under replied. A forwarded text with no phone and no matching business creates "Forwarded text - who is this?". |
| T18 | M | **Attach and reply suggestions.** An inbound message from a customer with an open job attaches to it with no new job and sets `unread_inbound_at`. On `waiting_yes`: "yes go ahead…" suggests `mark_yes`; "no thanks, we went with someone else" suggests `mark_lost`. No stage changes until she taps. |
| R06 | C | **Text a tech.** "Text a tech" then Luis opens `sms:+13125550121` with the business, address, problem, contact and phone, and logs "Sent details to Luis". |
| R09 | S | **Urgency without AI.** With no key, "quote for PM cleaning next month" and "walk-in cooler down, food at risk", created at the same time: the second is URGENT and ranks first. |
| R10 | S | **Reminder.** An urgent untouched lead plus 30 minutes produces exactly one reminder to Denise, naming the customer, with the job link. Another hour produces no second reminder. |
| R11 | C | **Money header.** One `waiting_yes` job with $2,000, the rest blank: the header reads "$2,000 waiting on a yes". Saving without an amount works. |
| R12/R28 | M | **Stages.** Every job shows one stage; there are no NULL stages. The picker offers exactly the 7 stages in §3. Marking a job Done removes it from Today and from the open count. |
| R13 | M | **Stage moves.** Waiting on quote → "Quote sent" → Waiting on their yes (history time stamped) → "They said yes" → day "Thu" → tech "Skip" → Scheduled Thu. Each step is 1 tap plus pickers. |
| R14 | M | **Numbers.** Numbers at A equal §10 exactly. `numbersText` equals the block in §10. |
| R15 | S | **Husband's link.** `/n/{key}` in a second browser shows the same numbers with no buttons. A request to `/api/*` without the owner cookie, when a passcode is set, returns 401. |
| R16 | M | **Home.** The root URL lands on Today. Every card has Call (`tel:`) and Text (`sms:`) buttons at least 48px. Only due or replied jobs are listed. |
| R17 | M | **Quotes owed.** At A, "Waiting on your quote (3)" lists Midway, Hillside and Lakeview, oldest first. "Quote sent" on one makes it "(2)". |
| R18 | M | **Said yes.** "They said yes" (no date) on Mon 3:00pm: it shows that day and at Tue 07:00 under "Said yes - needs scheduling". "Scheduled" with a date removes it and it appears under Jobs › Scheduled. |
| R19 | M | See T06. |
| R20 | S | **Digest.** At Mon 07:00 with Twilio unset, the outbox holds the exact digest from §12.4. With the Twilio variables set (`fetch` stubbed), it POSTs to the Twilio Messages API. A weekday with 0 items sends the "nobody's waiting" text. A weekend with no Call-first items sends nothing. |
| R21 | M | **Nothing fancy.** `npm install && npm start` with no environment variables works end to end. The Quick Add confirm card shows 3 fields. Today has no charts and no setup prompts. |
| R22 | S | **Day-one import.** (a) A form email forwarded by Postmark creates a job, as in R02. (b) Five Brain dump lines create 5 jobs at the parsed stages, grouped correctly on Today. |
| R23 | W | No calendar, map, dispatch or tech-availability screen exists. A Scheduled job holds a date and an optional tech, and nothing else is required. |
| R25 | S | **Repeat customer and speed.** Two jobs from 555-0101 three weeks apart share a customer, and Job detail lists the earlier one under Past jobs. With 100 open jobs, `/api/today` takes under 200 ms on the server and Today renders in under 1 second locally. |
| R27 | M | **Stage strip.** At 390×844, Today shows the strip with counts. Tapping a count opens Jobs filtered to that stage. No sideways scroll. |
| R29 | M | **Phone fit.** At 375px there is no sideways scroll and every tap target is at least 44px. Opening the app, calling the top item and logging the outcome takes 3 or fewer taps after the call. |
| R30 | C | **Equipment tags.** With no key, "ice machine not making ice" is tagged "Ice machine" and "walk-in freezer warm" is tagged "Walk-in freezer". The tag can be edited and is never required. |
| T19 | S | **Friday sweep.** The seed replay produces the Fri 3:00pm sweep text exactly as in §12.4. |
| T20 | M | **Startup log.** With no environment variables, it contains "AI: rules only" and "SMS: simulated (outbox)". |
| T21 | S | **Security.** `APP_PASSCODE` set and no cookie: 401. `INBOUND_TOKEN` set and no token: 401. With `TWILIO_AUTH_TOKEN` set, a bad signature returns 403 (C). |
| T22 | M | **Existing AI tests.** `test/ai.test.js` still passes. |

---

## 15. Write-up and demo

- **Write-up:** [WRITEUP.md](WRITEUP.md).
- **3-minute demo script:** [DEMO.md](DEMO.md).
- **Automated walkthrough:** `npm run e2e` drives that demo in a headless browser.

## 16. Open questions for Denise

Each question shows what we shipped as the default until she answers.

1. **What counts as "heard from us"?** Does a voicemail or a text count, or only a real conversation? Is 2 business days the right wait before chasing a quote? *Default: any logged attempt counts; 2 business days.*
2. **Freezer-down emergencies.** How fast do you need to call back? Should we text you at night and on weekends, or only between 7am and 9pm? *Default: a reminder after 30 minutes, 7am–9pm only; anything later goes into the morning text.*
3. **Automatic reply.** Do you want an automatic "Got your message, Denise will call you shortly" text to new callers and texters? If so, in what words? *Default: off.*
4. **The office line.** Is it a separate number forwarded to your cell, or your cell itself? Who is your carrier? Is it OK to send missed calls to a new number that rings you? *Default: not wired; simulator only.*
5. **The website form.** Which website builder and form do you use, and which email (Gmail, Google Workspace, Outlook)? Can we add one forwarding rule? *Default: Postmark forwarding or the form's own webhook.*
6. **Quotes.** How do you send quotes today (text, email, paper, on site)? Who prices them, you or the tech? Do emergencies go out without a quote? *Default: one "Quote sent" tap with an optional $; emergencies can be booked straight away.*
7. **Your phone.** iPhone or Android? Is adding Callback to your home screen OK? Would you forward customer texts to a "New Job" contact? *Default: paste into Quick Add.*
8. **Mornings.** What time does your day start? Is a 7:00am text right, and do you want weekend texts? *Default: 7:00; weekends only if someone is waiting on a call back.*
9. **Your husband.** Does he want counts or dollars? Should he have his own read-only link? Does "Done" mean "ready to invoice" for him? *Default: both counts and $; his link exists but is only shared if you want.*
10. **Finished jobs.** When a tech finishes a job, how do you hear about it? Should techs be able to text "done"? *Default: you confirm it the next business day ("Did it get done?").*
11. **Recurring work.** Do you have maintenance contracts or regular PM visits that should come up on their own? *Default: not built.*
12. **Lost jobs.** Do you want to record why a job was lost? *Default: optional chips; "went with someone else" tracks the leak.*
13. **Day one.** About how many open jobs are in the notebook and your texts right now? Can you spend 15 minutes with us on day one to move them in? *Default: a Brain dump session.*
14. **Access.** Does anyone else answer the phone or need the list, such as your husband or a lead tech? *Default: one passcode for you, a read-only link for him.*