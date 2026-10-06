import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDue, isOnToday, bucketFor, replySuggestion, reasonFor, chipFor, cardFor,
  compareCards, buildToday, digestText, sweepText, nagText,
} from "../shared/today-rules.js";
import {
  SEED_ANCHOR as A, SETTINGS, at, ctxAt, makeJobView, applyAt, receiveInbound, seedJobViews,
} from "./fixtures/seed-state.js";

const ctx = ctxAt(A); // Mon Oct 5 2026 07:00 America/Chicago
const WED_0000 = "2026-10-07T05:00:00.000Z";

/** The bucket a job lands in on the Today screen at `now` (null when absent). */
function bucketOn(jvs, id, now) {
  const today = buildToday(jvs, ctxAt(now));
  for (const s of today.sections) if (s.items.some((c) => c.job_id === id)) return s.bucket;
  return null;
}

const cardOf = (jvs, id, now) => buildToday(jvs, ctxAt(now)).sections.flatMap((s) => s.items).find((c) => c.job_id === id);

test("isDue and isOnToday (§4.2)", () => {
  assert.equal(isDue({ next_due_at: A }, A), true);
  assert.equal(isDue({ next_due_at: "2026-10-05T12:00:00.001Z" }, A), false);
  assert.equal(isDue({ next_due_at: null }, A), false);
  assert.equal(isOnToday(makeJobView({ stage: "quote", next_due_at: WED_0000, unread_inbound_at: A }), A), true);
  assert.equal(isOnToday(makeJobView({ stage: "done", next_due_at: null, unread_inbound_at: A }), A), false);
});

test("T03 bucket precedence", () => {
  const later = WED_0000;
  const reply = (body = "Any update?") => ({ unread_inbound_at: at("2026-10-05 06:00"), last_inbound: { at: at("2026-10-05 06:00"), channel: "sms", call_status: null, body } });
  const table = [
    ["urgent new", { stage: "new", urgent: 1 }, "emergency"],
    ["urgent new with an unread reply", { stage: "new", urgent: 1, ...reply() }, "emergency"],
    ["urgent quote, due", { stage: "quote", urgent: 1 }, "emergency"],
    ["urgent to_schedule, due", { stage: "to_schedule", urgent: 1 }, "emergency"],
    ["urgent quote, snoozed, no reply", { stage: "quote", urgent: 1, next_due_at: later, snoozed_until: later }, null],
    ["waiting_yes with a reply, not due", { stage: "waiting_yes", next_due_at: later, ...reply() }, "replied"],
    ["snoozed job with a reply", { stage: "to_schedule", next_due_at: later, snoozed_until: later, ...reply() }, "replied"],
    ["new, due", { stage: "new" }, "new"],
    ["to_schedule, due", { stage: "to_schedule" }, "to_schedule"],
    ["quote, due", { stage: "quote" }, "quote"],
    ["waiting_yes, due", { stage: "waiting_yes" }, "nudge"],
    ["urgent waiting_yes, due", { stage: "waiting_yes", urgent: 1 }, "nudge"],
    ["waiting_yes, not due", { stage: "waiting_yes", next_due_at: later }, null],
    ["scheduled in the future", { stage: "scheduled", visit_date: "2026-10-06", next_due_at: later }, null],
    ["scheduled, visit passed", { stage: "scheduled", visit_date: "2026-10-02", next_due_at: "2026-10-05T05:00:00.000Z" }, "check_done"],
    ["urgent scheduled, visit passed", { stage: "scheduled", urgent: 1, visit_date: "2026-10-02", next_due_at: "2026-10-05T05:00:00.000Z" }, "check_done"],
    ["done", { stage: "done", next_due_at: null }, null],
    ["lost, with a stray reply", { stage: "lost", next_due_at: null, ...reply() }, null],
  ];
  const jvs = table.map(([, fields], i) => makeJobView({ id: i + 1, created_at: at("2026-10-02 10:00"), ...fields }));
  table.forEach(([name, , expected], i) => assert.equal(bucketFor(jvs[i], ctx), expected, name));

  const today = buildToday(jvs, ctx);
  const ids = today.sections.flatMap((s) => s.items.map((c) => c.job_id));
  assert.equal(new Set(ids).size, ids.length, "a job never appears twice");
  assert.equal(ids.length, table.filter(([, , b]) => b).length);
  for (const s of today.sections) for (const c of s.items) assert.equal(c.bucket, s.bucket);
  assert.deepEqual(today.sections.map((s) => s.bucket), // all seven, in order
    ["emergency", "replied", "new", "to_schedule", "quote", "nudge", "check_done"]);
});

test("T04 seed: Today at A matches §12.3 exactly", () => {
  const today = buildToday(seedJobViews(), ctx);
  assert.equal(today.date_label, "Monday, Oct 5");
  assert.equal(today.header, "10 people to call");
  assert.equal(today.count, 10);
  assert.equal(today.waiting_yes_text, "$8,400 waiting on a yes");
  assert.equal(today.waiting_yes_total, 8400);
  assert.equal(today.waiting_yes_count, 2);

  assert.deepEqual(today.sections.map((s) => `${s.label} (${s.count})`), [
    "Urgent - call first (1)",
    "They got back to you (1)",
    "New - call them back (2)",
    "Said yes - needs scheduling (1)",
    "Waiting on your quote (3)",
    "Waiting on their yes - check in (1)",
    "Did it get done? (1)",
  ]);

  const rows = today.sections.flatMap((s) => s.items).map((c) => [
    c.rank, c.title, c.badges, c.reason, c.chip && `${c.chip.text} (${c.chip.tone})`,
  ]);
  assert.deepEqual(rows, [
    [1, "Bella Cucina", ["URGENT"], "Walk-in freezer at 28 degrees and climbing - voicemail Fri 4:47pm, nobody's called back", "Not contacted - 2d 14h (red)"],
    [2, "Harbor Grill", [], "Texted yesterday 6:05pm: \"Can Mike come Wednesday instead of Tuesday? We're closed…\"", "Waiting 12h (grey)"],
    [3, "(312) 555-0177", [], "New - missed call Sat 1:12pm - no voicemail", "Not contacted - 1d 17h (amber)"],
    [4, "Fresh Mart #2", [], "New - web form today 6:02am - Deli ice machine making half the ice", "Not contacted - 58m (grey)"],
    [5, "Joe's Diner", ["Repeat - 1 past job"], "Said yes Fri - not scheduled yet - hasn't heard from us in 3 days", "Waiting 2d 17h (red)"],
    [6, "Midway Meats", [], "Waiting on your quote since Wed - hasn't heard from us in 5 days", "Waiting 4d 20h (red)"],
    [7, "Hillside Grocery", [], "Waiting on your quote since Thu - hasn't heard from us in 4 days", "Waiting 3d 20h (red)"],
    [8, "Lakeview Brewing Co.", [], "Waiting on your quote since Fri - hasn't heard from us in 3 days", "Waiting 2d 21h (red)"],
    [9, "Rosa's Taqueria", ["Repeat - 1 past job"], "Quote sent Thu, $2,400 - no answer in 4 days", "Waiting 3d 16h (amber)"],
    [10, "Sal's Pizza", [], "Luis went Fri - done?", null],
  ]);

  const cards = today.sections.flatMap((s) => s.items);
  assert.deepEqual(cards.map((c) => c.job_id), [16, 8, 17, 18, 13, 11, 14, 15, 7, 10]);
  assert.deepEqual(cards.map((c) => c.subtitle), [
    "Marco Rossi", "Ana Ruiz", null, "Priya Shah", "Joe Russo", "Gus Petrakis", "Dave Kowalski", "Nora Lindqvist", "Rosa Medina", "Sal Romano",
  ]);
  assert.deepEqual(cards.map((c) => c.source_label), [
    "Voicemail", "Web form", "Missed call", "Web form", "Text", "Text", "Text", "Web form", "Text", "Text",
  ]);
  assert.deepEqual(cards.map((c) => c.urgent), [true, false, false, false, false, false, false, false, false, false]);
  assert.deepEqual(cards[4].repeat, { past_jobs: 1 });
  assert.equal(cards[0].repeat, null);

  assert.deepEqual(today.stage_counts, { new: 3, quote: 3, waiting_yes: 2, to_schedule: 2, scheduled: 3 });
  assert.equal(today.open_count, 13);
  assert.deepEqual(today.strip.map((s) => `${s.label} ${s.count}`).join(" · "), "New 3 · Waiting on quote 3 · Their yes 2 · Said yes 2 · Scheduled 3");
  assert.deepEqual(today.footer, {
    scheduled_today: 1, snoozed: 1, text: "Scheduled today: 1 · Put off till later: 1",
    last24h_text: "Last 24 hours: 1 came in, 1 not called yet",
  });
  assert.equal(today.empty, null);
  assert.deepEqual(today.demo, { shifted: false, label: null });
  assert.equal(today.now, A);
});

test("seed cards: links, sheet data and outcome buttons", () => {
  const cards = buildToday(seedJobViews(), ctx).sections.flatMap((s) => s.items);
  const bella = cards[0];
  assert.equal(bella.tel_link, "tel:+13125550142");
  assert.equal(bella.phone_display, "(312) 555-0142");
  assert.equal(bella.sms_link, `sms:+13125550142?&body=${encodeURIComponent("Hi Marco, it's Denise at Frostline Refrigeration. Got your message about the walk-in freezer. Is now a good time to call?")}`);
  assert.equal(bella.stage_label, "New - call them back");
  assert.equal(bella.last_inbound, null);

  const harbor = cards[1];
  assert.deepEqual(harbor.last_inbound, {
    at: at("2026-10-04 18:05"), at_label: "yesterday 6:05pm", channel: "sms",
    body: "Can Mike come Wednesday instead of Tuesday? We're closed Tuesdays.",
  });
  assert.equal(harbor.suggestion, "move_day");
  assert.deepEqual(harbor.outcomes.map((b) => b.label),
    ["Move to Wednesday?", "Done", "Needs another visit", "Needs a quote for more work", "Seen it", "Not today", "Cancelled"]);
  assert.deepEqual(harbor.outcomes[0].preset, { visit_date: "2026-10-07" });

  const sals = cards[9];
  assert.deepEqual(sals.outcomes.map((b) => b.label),
    ["Done", "Needs another visit", "Needs a quote for more work", "Moved to another day", "Not today", "Cancelled"]);
});

test("§12.4 texts: weekday and weekend digests, Friday sweep, reminders", () => {
  const digestAt = (local) => {
    const now = at(local);
    return digestText(buildToday(seedJobViews(now), ctxAt(now)), ctxAt(now));
  };
  assert.deepEqual(digestAt("2026-10-05 07:00"), {
    send: true,
    body: [
      "Morning Denise - 10 to call today:",
      "1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)",
      "2. Harbor Grill - texted back",
      "3. (312) 555-0177 - new: missed call, no voicemail",
      "4. Fresh Mart #2 - new: Deli ice machine making half the ice",
      "5. Joe's Diner - said yes, needs scheduling",
      "6. Midway Meats - quote to send",
      "+4 more.",
      "Open: http://localhost:3000/#/",
    ].join("\n"),
  });
  assert.deepEqual(digestAt("2026-10-03 07:00"), {
    send: true,
    body: "Weekend check - 1 waiting on a call back:\n1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)\nOpen: http://localhost:3000/#/",
  });
  assert.deepEqual(digestAt("2026-10-04 07:00"), {
    send: true,
    body: "Weekend check - 2 waiting on a call back:\n1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)\n2. (312) 555-0177 - new: missed call, no voicemail\nOpen: http://localhost:3000/#/",
  });

  const fri3pm = at("2026-10-02 15:00");
  assert.equal(sweepText(buildToday(seedJobViews(fri3pm), ctxAt(fri3pm)), ctxAt(fri3pm)),
    "Before the weekend: 3 people still waiting on you - Joe's Diner, Midway Meats, Hillside Grocery. Open: http://localhost:3000/#/");

  const fri520 = at("2026-10-02 17:20");
  assert.equal(nagText(seedJobViews(fri520).find((j) => j.id === 16), ctxAt(fri520)),
    "Still not called back (URGENT): Bella Cucina - Walk-in freezer at 28 degrees and climbing. Came in today 4:47pm. Call (312) 555-0142. Open: http://localhost:3000/#/job/16");
  const sat315 = at("2026-10-03 15:15");
  assert.equal(nagText(seedJobViews(sat315).find((j) => j.id === 17), ctxAt(sat315)),
    "Still not called back: (312) 555-0177 - missed call, no voicemail. Came in today 1:12pm. Open: http://localhost:3000/#/job/17");
});

test("digest edge cases: nobody waiting, weekend off, more than 6, custom URL", () => {
  const empty = buildToday([], ctx);
  assert.equal(empty.header, null);
  assert.equal(empty.waiting_yes_text, null);
  assert.equal(empty.footer.last24h_text, "Nothing new in the last 24 hours");
  assert.deepEqual(digestText(empty, ctx),
    { body: "Morning Denise - nobody's waiting on you today. Nice. Open: http://localhost:3000/#/", send: true });
  assert.equal(sweepText(empty, ctx), null);

  const sat = at("2026-10-10 07:00");
  const quoteOnly = [makeJobView({ id: 1, stage: "quote", created_at: at("2026-10-07 10:00") })];
  const weekendQuiet = digestText(buildToday(quoteOnly, ctxAt(sat)), ctxAt(sat));
  assert.equal(weekendQuiet.send, false);
  assert.equal(weekendQuiet.body, "Weekend check - nobody's waiting on a call back. Open: http://localhost:3000/#/");

  const lead = [makeJobView({ id: 1, urgent: 1, created_at: at("2026-10-09 20:00"), problem: "Freezer down" })];
  const off = ctxAt(sat, { settings: { ...SETTINGS, weekend_digest: false } });
  assert.equal(digestText(buildToday(lead, off), off).send, false);
  assert.equal(digestText(buildToday(lead, ctxAt(sat)), ctxAt(sat)).send, true);

  const leads = Array.from({ length: 8 }, (_, i) => makeJobView({
    id: i + 1, created_at: at(`2026-10-05 0${i}:00`), problem: `Problem ${i + 1}`,
    customer: { business_name: `Shop ${i + 1}`, phone: `+1312555020${i}` },
  }));
  const custom = ctxAt(at("2026-10-05 09:00"), { publicUrl: "https://callback.example/" });
  const today = buildToday(leads, custom);
  assert.equal(today.header, "8 people to call");
  assert.equal(digestText(today, custom).body.split("\n").slice(-3).join("\n"),
    "6. Shop 6 - new: Problem 6\n+2 more.\nOpen: https://callback.example/#/");
  assert.equal(sweepText(today, custom),
    "Before the weekend: 8 people still waiting on you - Shop 1, Shop 2, Shop 3, +5 more. Open: https://callback.example/#/");
  const one = buildToday(leads.slice(0, 1), custom);
  assert.equal(one.header, "1 person to call");
  assert.equal(sweepText(one, custom), "Before the weekend: 1 person still waiting on you - Shop 1. Open: https://callback.example/#/");
  const sweepOff = { ...custom, settings: { ...SETTINGS, friday_sweep: false } };
  assert.equal(sweepText(one, sweepOff), null);
});

test("T05 her move vs theirs", () => {
  // Job A enters "quote" Mon 10:00 and stays on Today every morning until "Quote sent".
  let a = makeJobView({ id: 1, created_at: at("2026-10-05 09:00") });
  a = applyAt(a, "need_quote", {}, at("2026-10-05 10:00"));
  assert.equal(bucketOn([a], 1, at("2026-10-05 10:01")), null);
  for (const day of ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]) {
    assert.equal(bucketOn([a], 1, at(`${day} 07:00`)), "quote", day);
  }
  a = applyAt(a, "quote_sent", { amount: 900 }, at("2026-10-09 09:00"));
  assert.equal(bucketOn([a], 1, at("2026-10-09 09:01")), null);

  // Job B waits on the customer, snoozed to Thursday.
  let b = makeJobView({ id: 2, created_at: at("2026-09-30 09:00") });
  b = applyAt(b, "quote_sent", { amount: 1500 }, at("2026-10-01 10:00")); // due Mon 00:00
  b = applyAt(b, "snooze", { snooze_until: "2026-10-08" }, at("2026-10-05 06:30"));
  for (const day of ["2026-10-05", "2026-10-06", "2026-10-07"]) {
    assert.equal(bucketOn([b], 2, at(`${day} 07:00`)), null, day);
  }
  const thu = buildToday([b], ctxAt(at("2026-10-08 07:00")));
  assert.equal(thu.sections.length, 1);
  assert.equal(thu.sections[0].label, "Waiting on their yes - check in");
  assert.deepEqual(thu.sections[0].items[0].chip, { text: "Call back today", tone: "amber" });
});

test("T06 chasing a yes runs on business days", () => {
  let job = makeJobView({ id: 1, stage: "quote", created_at: at("2026-10-01 09:00") });
  job = applyAt(job, "quote_sent", {}, at("2026-10-05 10:00")); // Mon
  for (const t of ["2026-10-06 00:00", "2026-10-06 12:00", "2026-10-06 23:59"]) assert.equal(bucketOn([job], 1, at(t)), null, t);
  assert.equal(bucketOn([job], 1, at("2026-10-07 00:00")), "nudge");
  assert.equal(cardOf([job], 1, at("2026-10-07 00:00")).reason, "Quote sent Mon - no answer in 2 days");

  job = applyAt(job, "still_thinking", {}, at("2026-10-07 09:00")); // Wed
  for (const t of ["2026-10-07 09:01", "2026-10-08 12:00", "2026-10-08 23:59"]) assert.equal(bucketOn([job], 1, at(t)), null, t);
  assert.equal(bucketOn([job], 1, at("2026-10-09 00:00")), "nudge");
  assert.equal(cardOf([job], 1, at("2026-10-09 07:00")).reason, "Quote sent Mon - no answer in 2 days - nudged 1x");

  let fri = makeJobView({ id: 2, stage: "quote", created_at: at("2026-09-30 09:00") });
  fri = applyAt(fri, "quote_sent", { amount: 2400 }, at("2026-10-02 11:00")); // Fri
  for (const t of ["2026-10-03 12:00", "2026-10-04 12:00", "2026-10-05 12:00", "2026-10-05 23:59"]) {
    assert.equal(bucketOn([fri], 2, at(t)), null, t);
  }
  assert.equal(bucketOn([fri], 2, at("2026-10-06 00:00")), "nudge");
  assert.equal(cardOf([fri], 2, at("2026-10-06 07:00")).reason, "Quote sent Fri, $2,400 - no answer in 4 days");
});

test("T07 the Friday freezer call is the first card on Monday", () => {
  const freezer = makeJobView({
    id: 5, created_at: at("2026-10-02 16:47"), source: "call", source_detail: "voicemail",
    urgent: 1, urgent_source: "rules", problem: "Freezer down",
    customer: { business_name: "Bella Cucina", contact_name: "Marco Rossi", phone: "+13125550142" },
  });
  const others = [
    makeJobView({ id: 1, stage: "waiting_yes", created_at: at("2026-09-28 09:00"), next_due_at: WED_0000,
      unread_inbound_at: at("2026-10-02 08:00"), last_inbound: { at: at("2026-10-02 08:00"), channel: "sms", call_status: null, body: "Any news?" } }),
    makeJobView({ id: 2, created_at: at("2026-10-01 08:00") }),
    makeJobView({ id: 3, stage: "quote", created_at: at("2026-09-28 08:00"), stage_entered_at: at("2026-09-28 09:00"), next_due_at: at("2026-09-29 00:00") }),
  ];
  const first = buildToday([...others, freezer], ctx).sections[0];
  assert.equal(first.bucket, "emergency");
  assert.equal(first.label, "Urgent - call first");
  const card = first.items[0];
  assert.equal(card.job_id, 5);
  assert.equal(card.rank, 1);
  assert.deepEqual(card.badges, ["URGENT"]);
  assert.deepEqual(card.chip, { text: "Not contacted - 2d 14h", tone: "red" });
  assert.equal(card.reason, "Freezer down - voicemail Fri 4:47pm, nobody's called back");
});

test("T09 an urgent quote outranks a reply", () => {
  const replied = makeJobView({ id: 1, stage: "waiting_yes", created_at: at("2026-09-28 09:00"), next_due_at: WED_0000,
    unread_inbound_at: at("2026-10-02 08:00"), last_inbound: { at: at("2026-10-02 08:00"), channel: "sms", call_status: null, body: "Any news?" } });
  let urgentQuote = makeJobView({ id: 2, urgent: 1, created_at: at("2026-10-05 05:00") });
  urgentQuote = applyAt(urgentQuote, "need_quote", {}, at("2026-10-05 05:30"));
  assert.equal(urgentQuote.next_due_at, at("2026-10-05 07:30")); // now + 2h
  const now = at("2026-10-05 08:00");
  const cards = buildToday([replied, urgentQuote], ctxAt(now)).sections.flatMap((s) => s.items);
  assert.deepEqual(cards.map((c) => [c.job_id, c.bucket]), [[2, "emergency"], [1, "replied"]]);
  assert.equal(cards[0].reason, "Walk-in cooler not cold - waiting on your quote since today");
  assert.deepEqual(cards[0].chip, { text: "Waiting 2h", tone: "red" });
});

test("T10 snooze, a reply during it, Seen it, then back on the snooze date", () => {
  const touched = at("2026-10-02 10:00");
  let job = makeJobView({ id: 1, stage: "quote", created_at: at("2026-10-01 09:00"),
    stage_entered_at: touched, first_touch_at: touched, last_touch_at: touched, next_due_at: at("2026-10-05 00:00") });
  job = applyAt(job, "snooze", { snooze_until: "2026-10-07" }, at("2026-10-05 09:00"));
  assert.equal(job.last_touch_at, touched);
  for (const t of ["2026-10-05 09:01", "2026-10-06 07:00", "2026-10-06 23:59"]) assert.equal(bucketOn([job], 1, at(t)), null, t);
  assert.equal(buildToday([job], ctxAt(at("2026-10-06 07:00"))).footer.snoozed, 1);

  job = receiveInbound(job, { at: at("2026-10-06 10:00"), channel: "sms", body: "Did you get a price together yet?" });
  assert.equal(bucketOn([job], 1, at("2026-10-06 10:05")), "replied");
  const card = cardOf([job], 1, at("2026-10-06 10:05"));
  assert.equal(card.reason, "Texted today 10:00am: \"Did you get a price together yet?\"");
  assert.equal(card.outcomes.find((b) => b.id === "seen").label, "Seen it");
  assert.equal(buildToday([job], ctxAt(at("2026-10-06 10:05"))).footer.snoozed, 0);

  const seen = applyAt(job, "seen", {}, at("2026-10-06 10:10"));
  assert.equal(seen.snoozed_until, WED_0000);
  assert.equal(bucketOn([seen], 1, at("2026-10-06 23:59")), null);
  assert.equal(bucketOn([seen], 1, at("2026-10-07 00:00")), "quote");
  const wed = cardOf([seen], 1, at("2026-10-07 07:00"));
  assert.deepEqual(wed.chip, { text: "Call back today", tone: "red" });
  assert.equal(wed.reason, "Waiting on your quote since Fri - hasn't heard from us in 5 days");
  assert.deepEqual(chipFor(seen, ctxAt(at("2026-10-08 07:00"))), { text: "Call back was yesterday", tone: "red" });
});

test("T11 three tries suggests Mark lost", () => {
  let job = makeJobView({ id: 1, stage: "quote", created_at: at("2026-09-30 09:00") });
  job = applyAt(job, "quote_sent", { amount: 2400 }, at("2026-10-01 14:10"));
  job = applyAt(job, "still_thinking", {}, at("2026-10-05 09:00"));
  job = applyAt(job, "no_answer", {}, at("2026-10-07 09:00"));
  job = applyAt(job, "still_thinking", {}, at("2026-10-09 09:00"));
  assert.equal(job.nudges, 3);
  const card = cardOf([job], 1, at("2026-10-13 07:00"));
  assert.equal(card.reason, "Quote sent Oct 1, $2,400 - 3 tries, no answer. Mark lost?");
  assert.equal(card.suggestion, "mark_lost_tries");
  assert.deepEqual(card.outcomes[0], {
    id: "lost", label: "Mark lost", primary: true, suggested: true, needs: "lost_reason", preset: { lost_reason: "no_response" },
  });

  const tried = makeJobView({ id: 2, created_at: at("2026-10-05 06:00"), attempts: 3, first_touch_at: at("2026-10-05 06:30"), last_touch_at: at("2026-10-05 06:50") });
  const newCard = cardFor(tried, ctx);
  assert.equal(newCard.reason, "New - text today 6:00am - Walk-in cooler not cold - tried 3x");
  assert.deepEqual(newCard.chip, { text: "Tried 3x - 1h", tone: "grey" });
  assert.equal(newCard.outcomes[0].label, "Mark lost");
});

test("reply suggestions (§4.12): yes / no on a quote, another day on a visit", () => {
  const withReply = (stage, body, extra = {}) => makeJobView({ stage, next_due_at: WED_0000, unread_inbound_at: A,
    last_inbound: { at: A, channel: "sms", call_status: null, body }, ...extra });
  assert.equal(replySuggestion(withReply("waiting_yes", "yes go ahead, thursday works for us"), ctx), "mark_yes");
  assert.equal(replySuggestion(withReply("quote", "no thanks, we went with someone else"), ctx), "mark_lost");
  assert.equal(replySuggestion(withReply("waiting_yes", "yes but not right now"), ctx), null, "both");
  assert.equal(replySuggestion(withReply("waiting_yes", "Can Mike come Wednesday?"), ctx), null, "neither");
  assert.equal(replySuggestion(withReply("to_schedule", "yes go ahead"), ctx), null);
  assert.equal(replySuggestion({ ...withReply("waiting_yes", "yes go ahead"), unread_inbound_at: null }, ctx), null);
  const visit = { visit_date: "2026-10-06" };
  assert.equal(replySuggestion(withReply("scheduled", "Can Mike come Wednesday instead?", visit), ctx), "move_day");
  assert.equal(replySuggestion(withReply("scheduled", "See you Tuesday!", visit), ctx), null, "that's the day it's booked");
  assert.equal(replySuggestion(withReply("scheduled", "Thanks!", visit), ctx), null);

  const card = cardFor(withReply("waiting_yes", "yes go ahead, thursday works for us"), ctx);
  assert.equal(card.bucket, "replied");
  assert.equal(card.suggestion, "mark_yes");
  assert.deepEqual(card.outcomes.slice(0, 2).map((b) => b.label), ["Mark as yes?", "Still thinking"]);
  assert.equal(card.stage, "waiting_yes");
  const lostCard = cardFor(withReply("waiting_yes", "no thanks, we went with someone else"), ctx);
  assert.deepEqual(lostCard.outcomes[0].preset, { lost_reason: "went_elsewhere" });
});

test("reason templates for every case (§4.6)", () => {
  const now = A;
  const r = (fields) => reasonFor(makeJobView({ created_at: at("2026-10-02 16:47"), ...fields }), ctxAt(now));
  const msg = (channel, call_status, body) => ({
    next_due_at: WED_0000, unread_inbound_at: at("2026-10-05 06:00"),
    last_inbound: { at: at("2026-10-05 06:00"), channel, call_status, body },
  });
  assert.equal(r({ urgent: 1, source: "call", source_detail: "missed", problem: null, attempts: 2, first_touch_at: A }),
    "no voicemail - missed call Fri 4:47pm, tried 2x, no answer");
  assert.equal(r({ urgent: 1, stage: "quote", stage_entered_at: at("2026-10-01 10:00") }),
    "Walk-in cooler not cold - waiting on your quote since Thu");
  assert.equal(r({ urgent: 1, stage: "to_schedule", stage_entered_at: at("2026-10-02 10:00") }),
    "Walk-in cooler not cold - said yes Fri, not scheduled yet");
  assert.equal(r({ urgent: 1, stage: "quote", ...msg("sms", null, "Still waiting!") }), "Texted today 6:00am: \"Still waiting!\"");
  assert.equal(r({ stage: "waiting_yes", ...msg("email", null, "Any   update\non the quote?") }), "Emailed today 6:00am: \"Any update on the quote?\"");
  assert.equal(r({ stage: "waiting_yes", ...msg("form", null, "Following up") }), "Emailed today 6:00am: \"Following up\"");
  assert.equal(r({ stage: "waiting_yes", ...msg("call", "missed", "") }), "Called today 6:00am (missed, no voicemail)");
  assert.equal(r({ stage: "waiting_yes", ...msg("call", "voicemail", "Hi it's Rosa, call me back about the quote please") }),
    "Called today 6:00am: \"Hi it's Rosa, call me back about the quote please\"");
  assert.equal(r({ stage: "scheduled", ...msg("call", "answered", "") }), "You talked today 6:00am - what happened?");
  assert.equal(r({ stage: "quote", ...msg("manual", null, "any update on that freezer door quote?") }),
    "You pasted in their message today 6:00am: \"any update on that freezer door quote?\"");
  assert.equal(r({ source: "call", source_detail: "answered", problem: null }), "New - call Fri 4:47pm - what was it about?");
  assert.equal(r({ source: "bulk", problem: null }), "New - from your notebook Fri 4:47pm - no details");
  assert.equal(r({ stage: "quote", stage_entered_at: at("2026-10-04 09:00"), last_touch_at: at("2026-10-04 09:00") }),
    "Waiting on your quote since yesterday");
  // Silence counts calendar days since the last touch (or since it came in), from 2 days.
  assert.equal(r({ stage: "quote", stage_entered_at: at("2026-10-03 22:00"), last_touch_at: at("2026-10-03 22:00") }),
    "Waiting on your quote since Sat - hasn't heard from us in 2 days");
  assert.equal(r({ stage: "to_schedule", created_at: at("2026-10-03 23:59"), stage_entered_at: at("2026-10-04 08:00") }),
    "Said yes yesterday - not scheduled yet - hasn't heard from us in 2 days");
  assert.equal(r({ stage: "waiting_yes", quote_sent_at: at("2026-10-02 10:00"), last_touch_at: at("2026-10-04 10:00"), nudges: 2 }),
    "Quote sent Fri - no answer in 1 day - nudged 2x");
  assert.equal(r({ stage: "scheduled", visit_date: "2026-10-02", tech: null, next_due_at: at("2026-10-05 00:00") }),
    "Visit was Fri - done?");
});

test("chips and tones (§4.7)", () => {
  const now = A;
  const chip = (fields) => chipFor(makeJobView(fields), ctxAt(now));
  assert.deepEqual(chip({ created_at: at("2026-10-04 06:00") }), { text: "Not contacted - 1d 1h", tone: "amber" });
  assert.deepEqual(chip({ created_at: at("2026-10-03 07:00") }), { text: "Not contacted - 2d", tone: "red" });
  assert.deepEqual(chip({ urgent: 1, created_at: at("2026-10-05 06:59") }), { text: "Not contacted - 1m", tone: "red" });
  assert.deepEqual(chip({ stage: "quote", stage_entered_at: at("2026-10-04 07:01") }), { text: "Waiting 23h", tone: "grey" });
  assert.deepEqual(chip({ stage: "waiting_yes", quote_sent_at: at("2026-10-01 07:00") }), { text: "Waiting 4d", tone: "amber" });
  assert.deepEqual(chip({ stage: "waiting_yes", next_due_at: WED_0000, unread_inbound_at: A }), { text: "Just now", tone: "grey" });
  assert.deepEqual(chip({ stage: "to_schedule", snoozed_until: at("2026-10-02 00:00"), stage_entered_at: at("2026-10-01 07:00") }),
    { text: "Call back was Fri", tone: "red" });
  assert.equal(chip({ stage: "scheduled", visit_date: "2026-10-02" }), null);
  assert.equal(chip({ stage: "quote", next_due_at: WED_0000 }), null); // not on Today
});

test("compareCards: nudge ties go to the bigger quote, nulls last, then id", () => {
  const sent = at("2026-10-01 14:10");
  const nudge = (id, quote_amount) => cardFor(makeJobView({ id, stage: "waiting_yes", quote_sent_at: sent, last_touch_at: sent, quote_amount }), ctx);
  const sorted = [nudge(1, null), nudge(2, 500), nudge(3, 2400), nudge(4, 500)].sort(compareCards);
  assert.deepEqual(sorted.map((c) => c.job_id), [3, 2, 4, 1]);
});

test("footer trust line (§4.8)", () => {
  const recent = at("2026-10-05 01:00");
  const handled = [
    makeJobView({ id: 1, created_at: recent, stage: "quote", first_touch_at: recent, next_due_at: WED_0000 }),
    makeJobView({ id: 2, created_at: recent, stage: "lost", lost_reason: "not_a_job", next_due_at: null }),
    makeJobView({ id: 3, created_at: at("2026-10-04 07:00"), stage: "new" }), // exactly 24h ago: outside the window
  ];
  assert.equal(buildToday(handled, ctx).footer.last24h_text, "Last 24 hours: 1 came in, all handled");
});

test("regression RT-4: Brain dump imports didn't 'come in' today", () => {
  const imported = [
    makeJobView({ id: 1, source: "bulk", created_at: at("2026-10-05 06:00") }),
    makeJobView({ id: 2, source: "bulk", created_at: at("2026-10-05 06:00"), stage: "to_schedule" }),
  ];
  assert.equal(buildToday(imported, ctx).footer.last24h_text, "Nothing new in the last 24 hours");
  const lead = makeJobView({ id: 3, source: "sms", created_at: at("2026-10-05 06:30") });
  assert.equal(buildToday([...imported, lead], ctx).footer.last24h_text, "Last 24 hours: 1 came in, 1 not called yet");
});

test("UX-2: the empty state says whether jobs are only put off till later", () => {
  const snoozed = makeJobView({ id: 1, stage: "quote", next_due_at: WED_0000, snoozed_until: WED_0000 });
  const putOff = buildToday([snoozed], ctx);
  assert.deepEqual([putOff.count, putOff.header], [0, null]);
  assert.deepEqual(putOff.empty, { title: "Nothing due right now.", text: "1 put off till later - they'll come back on their day." });
  assert.equal(putOff.footer.text, "Scheduled today: 0 · Put off till later: 1");
  assert.deepEqual(buildToday([], ctx).empty, { title: "All caught up.", text: "Nobody's waiting on you." });
});

test("an email-only lead's card carries the email so it can be answered from Today", () => {
  const emailOnly = makeJobView({ source: "email", customer: { phone: null, email: "omar@omarsgrill.example", business_name: null, contact_name: "Omar Haddad" } });
  const card = cardFor(emailOnly, ctx);
  assert.equal(card.email, "omar@omarsgrill.example");
  assert.equal(card.tel_link, null);
  assert.equal(card.sms_link, null);
  assert.equal(cardFor(makeJobView(), ctx).email, null);
});
