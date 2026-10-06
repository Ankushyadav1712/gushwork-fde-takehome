# 3-minute demo

`npm run e2e` walks this script in headless Chrome and checks each step.

**Setup.**
- Run `npm start` and open <http://localhost:3000> in a phone-sized window (about 390×844), or on a phone.
- Open **Demo controls**: tap the blue "Demo time" pill on Today. Press **Reset demo**.
- The demo clock now reads **Mon Oct 5, 7:00am**. That's the morning after the weekend in which the Friday "freezer down" call went unanswered. If you run this on another week, dates follow the most recent Monday.

## 0:00. Her words

> "I just want to wake up and know who I need to call today… Who to call today, and where each job is at. Waiting on quote, waiting on their yes, scheduled, done. That is it."

*"She asked for one screen. This is that screen. It runs locally with no keys and no paid services."*

## 0:15. The text she wakes up to

**Demo controls → Outbox.** The **Mon 7:00am** text reads *"Morning Denise - 10 to call today: 1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT) …"*. Tap its link to land on **Today**: *10 people to call · $8,400 waiting on a yes*.

*"It gives her a list of people, not a dashboard. The headings read like her own sentence: three waiting on a quote, one said yes and needs scheduling, and each card says how long they've been waiting on her."*

## 0:35. The $2,000 Friday job can't go quiet

The top card is red: **Bella Cucina · URGENT · Not contacted - 2d 14h**. Tap it, then **Open job**, and scroll to **History**:

| When | What happened |
|---|---|
| Fri 4:47pm | Voicemail came in (verbatim transcript) |
| Fri 5:20pm | Reminder texted to you |
| Sat 7:00am, Sun 7:00am | In your weekend text |
| Mon 7:00am | In your morning text |

*"Last week this job went quiet. Here it can't. Every open job always has a next date, enforced by the database, and nothing leaves the list until she says what happened."*

## 1:10. Three taps after the call

Back on **Today**, tap the Bella Cucina card. Then tap **Booked it → Today → Luis**. The toast reads *"Booked for today with Luis. I'll ask if it got done tomorrow."* with **Undo**, and the header drops to *9 people to call*.

*"She doesn't type anything or pick a date. The app sets the next date for her: tomorrow it asks 'Did it get done?'."*

## 1:30. Follow-ups from her own phone; the customer says yes

1. On **Rosa's Taqueria** ("Quote sent Thu, $2,400 - no answer in 4 days"), tap **Text**. A pre-written check-in opens in her own messaging app.
2. In **Demo controls**, tap **Rosa texts "yes go ahead"**.
3. Rosa jumps to **They got back to you** with her message and a **Mark as yes?** button. Tap **Mark as yes? → Thursday → Mike**. Thursday is already highlighted, because it's the day she named.

*"Texts go from her own number, so customers already know it. When the customer says yes, it's one tap. The app suggests it but never decides."*

## 1:55. Every channel lands on the same list

1. **Demo controls → Web form: Tony's Bistro.** This is a Postmark-style email from her website form, run through the real webhook. It appears under **Urgent** labelled *Web form*. Sending it again is ignored as a duplicate.
2. **+ New.** Paste `Dave's Deli 312-555-0193 reach-in not cooling, wants someone today`. Who, phone and problem fill in, along with *Reach-in* and **URGENT** (*"Filled in for you - check it"*). Tap **Add to my list**.
3. Mention **Brain dump** ("Adding a bunch from your notebook?"): day one, her notebook moves in one line per job.

*"The website form becomes automatic with one Gmail forwarding rule. Texts and calls she catches go in with one paste or dictation. Texts and missed calls can be fully automatic with a Twilio number. Those adapters are built, and they're what the simulator drives."*

## 2:20. Her husband's numbers

**Jobs** shows every open job by stage, in her words. **Jobs → Numbers** shows open jobs, $ waiting on a yes, won/done/lost, and *"Waiting over a day for a first call: 2"*. Tap **Text this to Rick** and the summary is pre-written.

*"Her husband gets his numbers without asking her."*

## 2:40. What's real, what's not

Show the terminal's startup line: `AI: rules only … | SMS: simulated (outbox)`.

*"Not built: dispatch, invoicing, auto-texting customers. Going live needs a Twilio number at a few dollars a month and one Gmail rule. Success is no lead going 24 hours untouched for two weeks."*

---

## More to try

- **Demo controls → +2 hours / +1 day / Next Fri 3:00pm.** Time moves, and the scheduler sends what it would have sent (Friday's "before the weekend" text, reminders for untouched leads). Everything lands in the outbox.
- **Other presets:**
  - *Lucia's Market texts again*: a repeat customer, recognised by phone, with a **Repeat** badge.
  - *Voicemail: Westside Diner*: becomes a new urgent job with its transcript.
  - *You forward Midway Meats' text*: Denise forwards a customer's text from her own phone, and it attaches to that customer's open job.
  - *Answered call, 8 seconds*: ignored as too short to be a job. *Answered call, 2 minutes* becomes "what was it about?".
- **Harbor Grill** asks to move Tuesday's visit to Wednesday: its sheet leads with **Move to Wednesday?**.
- **+ New** with a regular's text (paste Rosa's `Hi Denise its Rosa, the walk in is making that noise again 312-555-0118`): it asks whether this belongs to her open job (**Add this to that job**) or is **a new job**.
- **Not today** hides a job until the day you pick, but the "hasn't heard from us" counter keeps running.
- **Job detail:** edit any field inline (it saves when you leave the field), change stage, **Text a tech** (pre-written details to Luis/Mike/Dee/Sam), or **Bring back** a closed job.
- **Settings:** your name, techs, morning text time, the husband's read-only link (`/n/…`), and the (off) auto-reply to new callers.
- **AI parsing:** run `ANTHROPIC_API_KEY=… npm start`. Quick Add then shows **Filled in by AI - check it**, and messy texts are read by Claude, with guardrails: anything not in the message is dropped, urgency can only go up, and it never sends or decides anything.
