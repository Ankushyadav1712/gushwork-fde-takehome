import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseMessage, mergeParse, parseNotebook, detectUrgency, detectEquipment, unwrapForward, replyIntent,
  looksLikeForm, formFieldFor, isRelayAddress, normalizeEmail,
} from "../shared/parse.js";

const TZ = "America/Chicago";
const NOW = "2026-10-05T12:00:00.000Z"; // Mon Oct 5 2026 07:00 CDT
const OWNER = "+13125550100";
const TECHS = [
  { name: "Luis", phone: "+13125550121" },
  { name: "Mike", phone: "+13125550122" },
  { name: "Dee", phone: "+13125550123" },
  { name: "Sam", phone: "+13125550124" },
];
const BASE = { owner_phone: OWNER, techs: TECHS, now: NOW, tz: TZ };

const parse = (text, channel, from_phone = null, extra = {}) => parseMessage(text, { ...BASE, channel, from_phone, ...extra });

const PARSE_KEYS = [
  "contact_name", "business_name", "phone", "email", "address", "equipment", "problem", "details",
  "urgent", "urgent_hits", "urgency", "callback_date", "quote_amount", "stage_hint", "visit_date", "tech",
  "quote_sent_at", "parsed_by",
].sort();

/** Asserts each listed field exactly; unlisted fields are not checked. */
function assertFields(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `field ${key}`);
}

// ---------------------------------------------------------------------------
// §8.7 message fixtures (T13)

test("F1: SMS intro with business, freezer climbing", () => {
  const p = parse("Hi its Marco at Bella Cucina, walk-in freezer at 28 and climbing, can someone come?", "sms", "+13125550142");
  assert.deepEqual(Object.keys(p).sort(), PARSE_KEYS);
  assertFields(p, {
    contact_name: "Marco", business_name: "Bella Cucina", phone: "+13125550142", equipment: "walk_in_freezer",
    urgent: true, urgent_hits: ["climbing"], urgency: "emergency", problem: "Walk-in freezer at 28 and climbing",
    parsed_by: "rules", stage_hint: null,
  });
});

test("F2: labelled website form (Postmark TextBody)", () => {
  const text = "Name: Priya Shah\nBusiness: Fresh Mart #2\nPhone: (312) 555-0133\nEmail: priya.shah@freshmart.example\n"
    + "Message: Deli ice machine is making about half the ice it used to. Can someone look at it this week?";
  assertFields(parse(text, "form"), {
    contact_name: "Priya Shah", business_name: "Fresh Mart #2", phone: "+13125550133",
    email: "priya.shah@freshmart.example", equipment: "ice_machine", urgent: false, urgent_hits: [], urgency: "normal",
    problem: "Deli ice machine is making about half the ice it used to",
    details: "Can someone look at it this week?",
  });
});

test("F3: voicemail with intro sentence, temperature and speed", () => {
  const text = "Hi, this is Marco at Bella Cucina on Halsted. Our walk-in freezer is at 28 degrees and climbing and we just got a full delivery. Please call me back as soon as you can.";
  assertFields(parse(text, "call", "+13125550142"), {
    contact_name: "Marco", business_name: "Bella Cucina", phone: "+13125550142", equipment: "walk_in_freezer",
    urgent: true, urgent_hits: ["28 degrees", "climbing", "as soon as you can"], urgency: "emergency",
    problem: "Walk-in freezer is at 28 degrees and climbing",
  });
});

test("F4: Quick Add, NAME from BIZ, quote request", () => {
  assertFields(parse("Dave from Hillside Grocery wants a quote on a new ice machine 312-555-0199", "manual"), {
    contact_name: "Dave", business_name: "Hillside Grocery", phone: "+13125550199", equipment: "ice_machine",
    urgent: false, urgency: "routine", problem: "Quote on a new ice machine", stage_hint: "quote", quote_amount: null,
  });
});

test("F5: forwarded text from the owner's number", () => {
  const p = parse("Fwd: From Gus (312) 555-0174: hey denise any update on that freezer door quote?", "sms", OWNER);
  assertFields(p, {
    phone: "+13125550174", contact_name: "Gus", business_name: null, equipment: "walk_in_freezer", urgent: false,
    problem: "Any update on that freezer door quote",
  });
});

test("F6: bare phone plus problem", () => {
  assertFields(parse("555-444-1212 ice machine leaking", "manual"), {
    phone: "+15554441212", equipment: "ice_machine", urgent: true, urgent_hits: ["leaking"], problem: "Ice machine leaking",
    contact_name: null, business_name: null,
  });
});

test("F7: routine maintenance quote", () => {
  assertFields(parse("quote for PM cleaning next month", "manual"), {
    equipment: null, urgent: false, urgent_hits: [], urgency: "routine", problem: "Quote for PM cleaning next month",
  });
});

test("F8: cooler down, food at risk", () => {
  assertFields(parse("walk-in cooler down, food at risk", "manual"), {
    equipment: "walk_in_cooler", urgent: true, urgent_hits: ["down", "food at risk"], urgency: "emergency",
    problem: "Walk-in cooler down, food at risk",
  });
});

test("§12.6 Quick Add demo text", () => {
  assertFields(parse("Dave's Deli 312-555-0193 reach-in not cooling, wants someone today", "manual"), {
    business_name: "Dave's Deli", contact_name: null, phone: "+13125550193", equipment: "reach_in", urgent: true,
    urgent_hits: ["not cooling", "today"], problem: "Reach-in not cooling, wants someone today", stage_hint: "new",
  });
});

test("§12.6 presets parse as expected", () => {
  assertFields(parse("Hey it's Carla from Westside Diner, our ice machine is leaking all over the kitchen floor. Call me back at 312-555-0164.", "call", "+13125550164"), {
    contact_name: "Carla", business_name: "Westside Diner", phone: "+13125550164", equipment: "ice_machine", urgent: true,
    problem: "Ice machine is leaking all over the kitchen floor", details: "Call me back at 312-555-0164.",
  });
  // The preset table writes the form's line breaks as " / ".
  assertFields(parse("Name: Tony Russo / Business: Tony's Bistro / Phone: (312) 555-0187 / Message: Walk-in freezer at 10F and rising. Please call.", "email"), {
    contact_name: "Tony Russo", business_name: "Tony's Bistro", phone: "+13125550187", equipment: "walk_in_freezer",
    urgent: true, urgent_hits: ["rising"], problem: "Walk-in freezer at 10F and rising",
  });
  assertFields(parse("Midway Meats: hey denise any update on that freezer door quote?", "sms", OWNER), {
    business_name: "Midway Meats", contact_name: null, phone: null, problem: "Any update on that freezer door quote",
  });
  assertFields(parse("ice machine acting up again, can someone come this week?", "sms", "+13125550101"), {
    phone: "+13125550101", equipment: "ice_machine", urgent: false, problem: "Ice machine acting up again",
    contact_name: null, business_name: null,
  });
});

// ---------------------------------------------------------------------------
// R09, R30

test("R09: urgency without AI", () => {
  const routine = parse("quote for PM cleaning next month", "manual");
  const urgent = parse("walk-in cooler down, food at risk", "manual");
  assert.equal(routine.urgent, false);
  assert.equal(urgent.urgent, true);
});

test("R30: equipment tags without AI", () => {
  assert.equal(parse("ice machine not making ice", "manual").equipment, "ice_machine");
  assert.equal(parse("walk-in freezer warm", "manual").equipment, "walk_in_freezer");
});

// ---------------------------------------------------------------------------
// §8.7 notebook fixtures (T15)

test("B1-B5: notebook lines", () => {
  const rows = parseNotebook([
    "Joe's Diner walk-in, quoted 1800 tues, waiting",
    "Fresh Mart ice machine needs scheduling",
    "",
    "Harbor Grill reach-in needs a quote 312-555-0125",
    "Sal's Pizza prep table scheduled thu with Luis",
    "Lakeview brewing called about keg cooler, call back",
  ].join("\n"), { now: NOW, tz: TZ, techs: TECHS });
  assert.equal(rows.length, 5);

  const [b1, b2, b3, b4, b5] = rows;
  assert.equal(b1.line, "Joe's Diner walk-in, quoted 1800 tues, waiting");
  assert.equal(b1.fields.business_name, "Joe's Diner");
  assert.equal(b1.stage, "waiting_yes");
  assert.equal(b1.quote_amount, 1800);
  assert.equal(b1.quote_sent_at, "2026-09-29T17:00:00.000Z"); // Tue Sep 29, 12:00 CDT

  assert.equal(b2.stage, "to_schedule");
  assert.equal(b2.fields.business_name, "Fresh Mart");

  assert.equal(b3.stage, "quote");
  assert.equal(b3.fields.phone, "+13125550125");
  assert.equal(b3.quote_amount, null);

  assert.equal(b4.stage, "scheduled");
  assert.equal(b4.visit_date, "2026-10-08");
  assert.equal(b4.tech, "Luis");
  assert.equal(b4.fields.business_name, "Sal's Pizza");

  assert.equal(b5.stage, "new");
  assert.equal(b5.fields.equipment, "walk_in_cooler");
});

test("notebook: other stage words, dates and amounts", () => {
  const rows = parseNotebook([
    "- Rosa's Taqueria walk-in done, $2,400",
    "2) Midway Meats freezer said yes",
    "Tony's Bistro ice machine booked 10/14 Dee",
    "Hillside Grocery sent the quote $3k yesterday",
    "Corner Deli going out tomorrow with mike",
  ].join("\n"), { now: NOW, tz: TZ, settings: { techs: TECHS } });
  assert.deepEqual(rows.map((r) => r.stage), ["done", "to_schedule", "scheduled", "waiting_yes", "scheduled"]);
  assert.equal(rows[0].quote_amount, 2400);
  assert.equal(rows[0].fields.business_name, "Rosa's Taqueria");
  assert.equal(rows[1].fields.business_name, "Midway Meats");
  assert.equal(rows[2].visit_date, "2026-10-14");
  assert.equal(rows[2].tech, "Dee");
  assert.equal(rows[3].quote_amount, 3000);
  assert.equal(rows[3].quote_sent_at, "2026-10-04T17:00:00.000Z");
  assert.equal(rows[4].visit_date, "2026-10-06");
  assert.equal(rows[4].tech, "Mike");
});

test("notebook: waiting_yes with no day uses now", () => {
  const [row] = parseNotebook("Harbor Grill quote sent 950", { now: NOW, tz: TZ, techs: TECHS });
  assert.equal(row.stage, "waiting_yes");
  assert.equal(row.quote_amount, 950);
  assert.equal(row.quote_sent_at, NOW);
});

// ---------------------------------------------------------------------------
// mergeParse guardrails (T14)

const AI_BASE = {
  contact_name: null, business_name: null, phone: null, email: null, address: null, equipment: "other",
  summary: "Service request", details: null, urgency: "normal", urgency_reason: null, is_service_request: true,
  parsed_by: "ai",
};

test("T14: AI phone not in the text is dropped; a grounded one is kept", () => {
  const raw = "walk-in cooler making noise";
  const rules = parse(raw, "manual");
  const merged = mergeParse(rules, { ...AI_BASE, phone: "(312) 555-0199" }, raw, { channel: "manual" });
  assert.equal(merged.phone, null);

  const raw2 = "walk-in noise, call 312-555-01-99"; // the regex can't read this one, the digits are there
  const rules2 = parse(raw2, "manual");
  assert.equal(rules2.phone, null);
  const merged2 = mergeParse(rules2, { ...AI_BASE, phone: "312-555-0199" }, raw2, { channel: "manual" });
  assert.equal(merged2.phone, "+13125550199");
  assert.equal(merged2.parsed_by, "ai");
});

test("T14: AI name not in the text is dropped; punctuation-insensitive grounding", () => {
  const raw = "tonys trattoria walk in is warm";
  const rules = parse(raw, "sms", "+13125550150");
  const merged = mergeParse(rules, { ...AI_BASE, contact_name: "Robert", business_name: "Tony's Trattoria", address: "12 Main St" }, raw, { channel: "sms", from_phone: "+13125550150" });
  assert.equal(merged.contact_name, null);
  assert.equal(merged.business_name, "Tony's Trattoria");
  assert.equal(merged.address, null);
});

test("T14: AI normal cannot clear a rules urgent; AI emergency raises it", () => {
  const raw = "walk-in cooler down, food at risk";
  const rules = parse(raw, "manual");
  const kept = mergeParse(rules, { ...AI_BASE, urgency: "normal" }, raw, { channel: "manual" });
  assert.equal(kept.urgent, true);
  assert.equal(kept.urgency, "emergency");
  assert.equal(kept.urgent_source, "rules");

  const raw2 = "the walk-in is making a weird noise";
  const rules2 = parse(raw2, "manual");
  assert.equal(rules2.urgent, false);
  const raised = mergeParse(rules2, { ...AI_BASE, urgency: "emergency", urgency_reason: "cooler failing" }, raw2, { channel: "manual" });
  assert.equal(raised.urgent, true);
  assert.equal(raised.urgency, "emergency");
  assert.equal(raised.urgent_source, "ai");
  assert.equal(raised.urgency_reason, "cooler failing");

  const routine = parse("quote for PM cleaning next month", "manual");
  const notLowered = mergeParse({ ...routine, urgency: "normal" }, { ...AI_BASE, urgency: "routine" }, "x", { channel: "manual" });
  assert.equal(notLowered.urgency, "normal");
});

test("T14: the SMS sender beats an AI phone", () => {
  const raw = "this is Gus, my other number is 312-555-0177. freezer door broke";
  const rules = parse(raw, "sms", "+13125550174");
  const merged = mergeParse(rules, { ...AI_BASE, phone: "312-555-0177" }, raw, { channel: "sms", from_phone: "+13125550174" });
  assert.equal(merged.phone, "+13125550174");
});

test("T14: is_service_request=false flags it and closes nothing", () => {
  const raw = "ACME SUPPLY - 20% off compressors this week only";
  const rules = parse(raw, "sms", "+13125550155");
  const merged = mergeParse(rules, { ...AI_BASE, is_service_request: false }, raw, { channel: "sms", from_phone: "+13125550155" });
  assert.equal(merged.ai_not_service, 1);
  assert.equal(merged.stage_hint, rules.stage_hint);
  assert.equal(merged.urgent, rules.urgent);
  assert.equal(merged.problem, rules.problem); // "Service request" summary is ignored
  assert.equal(mergeParse(rules, AI_BASE, raw, { channel: "sms" }).ai_not_service, 0);
});

test("mergeParse: summary, details, equipment and email rules", () => {
  const raw = "Hi Denise - walk in unit is acting weird, email me lucia@LuciasMarket.example";
  const rules = parse(raw, "email");
  assert.equal(rules.email, "lucia@luciasmarket.example");
  const merged = mergeParse(rules, {
    ...AI_BASE, summary: "Walk-in cooler behaving strangely and needs a technician to come and look at it soon",
    details: "Customer asked for email.", equipment: "ice_machine", email: "someone@else.example",
  }, raw, { channel: "email" });
  assert.equal(merged.problem, "Walk-in cooler behaving strangely"); // shorten() cuts at " and "
  assert.equal(merged.details, "Customer asked for email.");
  assert.equal(merged.equipment, "walk_in_cooler"); // rules found one; AI equipment ignored
  assert.equal(merged.email, "lucia@luciasmarket.example");
  assert.equal(merged.parsed_by, "ai");

  const raw2 = "compressor is loud. reach me at Gus@Midway.example";
  const rules2 = { ...parse(raw2, "manual"), email: null };
  assert.equal(rules2.equipment, "other");
  const merged2 = mergeParse(rules2, { ...AI_BASE, equipment: "walk_in_freezer", email: "gus@midway.example" }, raw2, { channel: "manual" });
  assert.equal(merged2.equipment, "walk_in_freezer");
  assert.equal(merged2.email, "gus@midway.example");
});

test("mergeParse with no AI result keeps the rules parse", () => {
  const raw = "walk-in cooler down, food at risk";
  const rules = parse(raw, "manual");
  const merged = mergeParse(rules, null, raw, { channel: "manual" });
  assert.equal(merged.parsed_by, "rules");
  assert.equal(merged.urgent_source, "rules");
  assert.equal(merged.ai_not_service, 0);
  assert.equal(merged.urgency_reason, null);
  assert.equal(merged.problem, rules.problem);
});

// ---------------------------------------------------------------------------
// replyIntent (§4.12)

test("replyIntent: yes, no, both and neither", () => {
  assert.equal(replyIntent("yes go ahead, thursday works for us"), "yes");
  assert.equal(replyIntent("Sounds good, book it"), "yes");
  assert.equal(replyIntent("let’s do it"), "yes");
  assert.equal(replyIntent("no thanks, we went with someone else"), "no");
  assert.equal(replyIntent("too expensive for us right now"), "no");
  assert.equal(replyIntent("We'll pass"), "no");
  assert.equal(replyIntent("yes but it's too much"), null);
  assert.equal(replyIntent("can you send the quote again?"), null);
  assert.equal(replyIntent("yesterday the tech left the door open"), null);
  assert.equal(replyIntent(""), null);
  assert.equal(replyIntent(null), null);
});

// ---------------------------------------------------------------------------
// unwrapForward (§7.1 step 3)

test("unwrapForward: Fwd: prefix with inline From line", () => {
  assert.deepEqual(unwrapForward("Fwd: From Gus (312) 555-0174: hey denise any update?", OWNER), {
    body: "hey denise any update?", phone: "+13125550174", name: "Gus", forwarded: true,
  });
});

test("unwrapForward: Begin forwarded message block", () => {
  const r = unwrapForward("Begin forwarded message:\n\nFrom: Gus (312) 555-0174:\nfreezer door still sticking", OWNER);
  assert.deepEqual(r, { body: "freezer door still sticking", phone: "+13125550174", name: "Gus", forwarded: true });
});

test("unwrapForward: From: NAME PHONE, FW: and email-style markers", () => {
  const r = unwrapForward("FW: ---------- Forwarded message ---------\nFrom: Rosa Diaz 312-555-0118\nprep table is warm", OWNER);
  assert.deepEqual(r, { body: "prep table is warm", phone: "+13125550118", name: "Rosa Diaz", forwarded: true });
  const r2 = unwrapForward("-----Original Message-----\nwalk-in is down", OWNER);
  assert.deepEqual(r2, { body: "walk-in is down", phone: null, name: null, forwarded: true });
});

test("unwrapForward: the owner's own number is never the customer's", () => {
  assert.deepEqual(unwrapForward("From: (312) 555-0100: test", OWNER), { body: "test", phone: null, name: null, forwarded: true });
});

test("unwrapForward: plain text passes through", () => {
  assert.deepEqual(unwrapForward("walk-in down at Joe's", OWNER), { body: "walk-in down at Joe's", phone: null, name: null, forwarded: false });
});

// ---------------------------------------------------------------------------
// detectUrgency / detectEquipment

test("detectUrgency: temperature rule depends on equipment", () => {
  assert.deepEqual(detectUrgency("freezer reading 15°F", "walk_in_freezer"), { urgent: true, hits: ["15°f"] });
  assert.deepEqual(detectUrgency("freezer reading 5 degrees", "walk_in_freezer"), { urgent: false, hits: [] });
  assert.deepEqual(detectUrgency("cooler is at 45F", "walk_in_cooler"), { urgent: true, hits: ["45f"] });
  assert.deepEqual(detectUrgency("cooler is at 38 degrees", "walk_in_cooler"), { urgent: false, hits: [] });
  assert.deepEqual(detectUrgency("it says 50 degrees", null), { urgent: false, hits: [] });
  assert.deepEqual(detectUrgency("reach-in freezer at 20 degrees", "reach_in"), { urgent: true, hits: ["20 degrees"] });
});

test("detectUrgency: keyword groups, word boundaries and no double counting", () => {
  assert.deepEqual(detectUrgency("Health inspector coming tonight, cooler isn't cooling").hits, ["health inspector", "tonight", "isn't cooling"]);
  assert.deepEqual(detectUrgency("ice machine stopped making ice").hits, ["stopped making ice"]);
  assert.deepEqual(detectUrgency("we're losing product, ASAP please").hits, ["losing product", "asap"]);
  assert.deepEqual(detectUrgency("Downtown location, rundown sign").hits, []);
  assert.deepEqual(detectUrgency("whenever is fine"), { urgent: false, hits: [] });
});

test("detectEquipment: order and categories", () => {
  assert.equal(detectEquipment("ice maker in the walk-in"), "ice_machine");
  assert.equal(detectEquipment("deli case lights out"), "display_case");
  assert.equal(detectEquipment("pizza table not cold"), "prep_table");
  assert.equal(detectEquipment("undercounter unit"), "reach_in");
  assert.equal(detectEquipment("walk-in freezer"), "walk_in_freezer");
  assert.equal(detectEquipment("beer fridge"), "walk_in_cooler");
  assert.equal(detectEquipment("condensing unit noisy"), "other");
  assert.equal(detectEquipment("the thing broke"), null);
  assert.equal(detectEquipment(undefined), null);
});

// ---------------------------------------------------------------------------
// Callback day and Quick Add stage hints

test("callback day proposes the next such date after today", () => {
  assert.equal(parse("Joe's Diner walk-in noise, call me back thursday", "manual").callback_date, "2026-10-08");
  assert.equal(parse("call back mon about the cooler", "manual").callback_date, "2026-10-12");
  assert.equal(parse("Gus needs it fixed by tomorrow", "manual").callback_date, null);
  assert.equal(parse("Gus freezer quote, call him back tomorrow", "manual").callback_date, "2026-10-06");
  assert.equal(parse("call me back thursday", "manual", null, { now: undefined }).callback_date, null);
});

test("stage hints apply only to Quick Add and notebook text", () => {
  assert.equal(parse("Rosa's Taqueria said yes to the $2,000 quote", "manual").stage_hint, "to_schedule");
  assert.equal(parse("Rosa's Taqueria said yes to the $2,000 quote", "manual").quote_amount, 2000);
  assert.equal(parse("can you send me a quote?", "sms", "+13125550150").stage_hint, null);
  assert.equal(parse("can you send me a quote?", "sms", "+13125550150").quote_amount, null);
});

// ---------------------------------------------------------------------------
// Messy real-world messages

test("messy: all lowercase with emoji, typo and a lowercase intro", () => {
  const p = parse("hey its marco from bella cucina, walk in freezr is warm!! \u{1F976} pls hurry", "sms", "+13125550111");
  assertFields(p, {
    contact_name: null, business_name: null, phone: "+13125550111", equipment: "walk_in_freezer", urgent: true,
    urgent_hits: ["warm"], problem: "Walk in freezr is warm",
  });
});

test("messy: slang greeting, trailing emoji, text-speak ask", () => {
  assertFields(parse("yo our icemaker stopped making ice \u{1F629} can u come tmrw", "sms", "+13125550111"), {
    equipment: "ice_machine", urgent: true, problem: "Icemaker stopped making ice",
  });
});

test("messy: email with greeting, sign-off name and iPhone footer", () => {
  const text = "Hi Denise,\n\nOur reach-in under the bar keeps icing up and the alarm goes off at night.\nCould you send someone this week?\n\nThanks,\nJanet\n\nSent from my iPhone";
  assertFields(parse(text, "email"), {
    contact_name: "Janet", equipment: "reach_in", urgent: true, urgent_hits: ["alarm"],
    problem: "Reach-in under the bar keeps icing up", details: "Could you send someone this week?",
  });
});

test("messy: two phone numbers, display case temperature, dash signature", () => {
  const text = "Good morning! This is Sam Patel from Sunrise Cafe. The display case is reading 50 degrees. Call me at 312-555-0161 or my cell 773-555-0162.\n- Sam";
  assertFields(parse(text, "email"), {
    contact_name: "Sam Patel", business_name: "Sunrise Cafe", phone: "+13125550161", equipment: "display_case",
    urgent: true, urgent_hits: ["50 degrees"], problem: "Display case is reading 50 degrees",
  });
});

test("messy: the owner's own number in the text is skipped", () => {
  assertFields(parse("Gus 312-555-0100 312-555-0174 ice maker making noise", "manual"), {
    contact_name: "Gus", phone: "+13125550174", equipment: "ice_machine", problem: "Ice maker making noise", urgent: false,
  });
  // A tech's number is never taken for the customer's either.
  assert.equal(parse("Luis says call 312-555-0121, Harbor Grill walk-in down", "manual").phone, null);
});

test("messy: forwarded email headers give the display name but never the header address (C4)", () => {
  const text = "From: Lucia Romano <lucia@luciasmarket.example>\nTo: denise@coldfix.example\nSubject: Walk-in not cooling\n\nThe walk-in is at 45 and climbing. Please call ASAP. 312-555-0101";
  assertFields(parse(text, "email"), {
    contact_name: "Lucia Romano", email: null, phone: "+13125550101", equipment: "walk_in_cooler",
    urgent: true, urgent_hits: ["climbing", "asap", "not cooling"], problem: "Walk-in is at 45 and climbing",
  });
});

test("messy: spaced phone, short temperature, callback day in Quick Add", () => {
  assertFields(parse("Rosa's Taqueria 312 555 0118 prep table 48 deg, call her back thursday", "manual"), {
    business_name: "Rosa's Taqueria", phone: "+13125550118", equipment: "prep_table", urgent: true,
    urgent_hits: ["48 deg"], callback_date: "2026-10-08", problem: "Prep table 48 deg, call her back thursday",
  });
});

test("messy: Quick Add with street address", () => {
  assertFields(parse("Mike's Diner 1520 N Halsted St walk-in compressor making noise", "manual"), {
    business_name: "Mike's Diner", address: "1520 N Halsted St", equipment: "walk_in_cooler",
    problem: "Walk-in compressor making noise", urgent: false,
  });
});

test("regression: a phone right after the business keeps the business name", () => {
  // cleanBiz once ran normalizePhone over "Corner Market 312-555-0176" and threw the business away.
  for (const text of ["Gina at Corner Market 312-555-0176 deli case is warm", "Gina from Corner Market (312) 555-0176, deli case is warm"]) {
    assertFields(parse(text, "manual"), {
      contact_name: "Gina", business_name: "Corner Market", phone: "+13125550176", equipment: "display_case",
      problem: "Deli case is warm", urgent: true,
    });
  }
  assertFields(parse("Hi this is Pat at Pat's Pizza 312 555 0173, prep table won't cool", "sms", "+13125550173"), {
    contact_name: "Pat", business_name: "Pat's Pizza", phone: "+13125550173",
  });
});

test("messy: capitalised sentence starts are not names", () => {
  for (const text of ["Walk-in cooler at Harbor Grill making a rattling noise, no rush", "Deli case not cold at Fresh Mart", "The walk-in at Joe's is leaking water"]) {
    const p = parse(text, "manual");
    assert.equal(p.contact_name, null, text);
    assert.equal(p.business_name, null, text);
  }
  const p = parse("I'm Calling about the freezer", "sms", "+13125550145");
  assert.equal(p.contact_name, null);
  assert.equal(parse("It's leaking everywhere, please hurry", "sms", "+13125550145").problem, "It's leaking everywhere, please hurry");
});

test("messy: lowercase form values, multi-line message, routine", () => {
  assertFields(parse("Name: priya\nPhone: 3125550133\nMessage: need maintenance on 2 coolers\nnext month is fine", "form"), {
    contact_name: "priya", phone: "+13125550133", equipment: "walk_in_cooler", urgency: "routine", urgent: false,
    problem: "Maintenance on 2 coolers", details: "next month is fine",
  });
});

test("messy: vendor spam in caps with a URL", () => {
  const p = parse("ACME REFRIGERATION SUPPLY - 20% OFF COMPRESSORS THIS WEEK ONLY! visit www.acme.example", "sms", "+13125550155");
  assertFields(p, { urgent: false, equipment: "other", phone: "+13125550155", problem: "ACME REFRIGERATION SUPPLY - 20% OFF COMPRESSORS THIS WEEK…" });
});

test("messy: answered call with no body and the voicemail placeholder", () => {
  assertFields(parse("", "call", "+13125550168"), { phone: "+13125550168", problem: null, urgent: false, equipment: null });
  assertFields(parse("(voicemail - no transcript yet)", "call", "+13125550168"), { problem: null });
  assertFields(parse("freezer is warm\n[photo attached]", "sms", "+13125550168"), { problem: "Freezer is warm", details: null });
});

test("form_fields override label parsing", () => {
  const p = parse("Name: Wrong Name\nMessage: walk-in is warm", "form", null, {
    form_fields: { "Your Name": "Ana Lopez", "Business Name": "Lopez Foods", "Phone Number": "312.555.0190", "How can we help?": "Reach-in not cooling", Extra: "x" },
  });
  assertFields(p, {
    contact_name: "Ana Lopez", business_name: "Lopez Foods", phone: "+13125550190", problem: "Reach-in not cooling",
    equipment: "reach_in", urgent: true,
  });
});

test("Twilio's own number is never the customer's", () => {
  assert.equal(parse("text 312-555-0199 back, walk-in down", "manual", null, { twilio_from: "+13125550199" }).phone, null);
});

// ---------------------------------------------------------------------------
// Never throws

test("fuzz: odd inputs never throw and keep the Parse shape", () => {
  const odd = [
    "", "   ", "\n\n\t", null, undefined, 42, {}, [], "0".repeat(5000), "1234567890123456789",
    "x".repeat(100000), "\u{1F976}\u{1F525}\u{1F4A6}", "日本語のテキスト", "Ñandú Café: ¿hola?", "Name:", "Message:\nPhone:",
    "Fwd:", "From:", "$", "$$$ 999999999", "call me back", ":::", "- ", "..!!??", "(((312)))", "\u0000\u0001",
    "Hi", "this is", "From Gus (312) 555-0174:", "12/45 scheduled", "Joe's Diner scheduled 13/40", "\uD800",
    "A B C D E F G H", "It's It's It's", Object.create(null),
  ];
  for (const input of odd) {
    for (const channel of ["sms", "call", "form", "email", "manual", "bulk", undefined]) {
      const p = parseMessage(input, { ...BASE, channel, from_phone: "garbage", form_fields: "nope" });
      assert.deepEqual(Object.keys(p).sort(), PARSE_KEYS);
      assert.equal(typeof p.urgent, "boolean");
      assert.ok(Array.isArray(p.urgent_hits));
      assert.ok(p.problem === null || p.problem.length <= 60);
    }
    assert.doesNotThrow(() => parseMessage(input));
    assert.doesNotThrow(() => parseMessage(input, null));
    assert.ok(Array.isArray(parseNotebook(input, { now: NOW, tz: TZ })));
    assert.ok(Array.isArray(parseNotebook(input)));
    assert.ok(["yes", "no", null].includes(replyIntent(input)));
    assert.equal(typeof detectUrgency(input, "walk_in_freezer").urgent, "boolean");
    assert.doesNotThrow(() => detectEquipment(input));
    assert.equal(typeof unwrapForward(input, OWNER).body, "string");
    const merged = mergeParse(parseMessage(input), { ...AI_BASE, contact_name: input, phone: input, summary: input }, input, {});
    assert.ok(["ai", "rules"].includes(merged.parsed_by));
    assert.doesNotThrow(() => mergeParse(null, input, input, null));
  }
});

test("fuzz: very long text parses quickly", () => {
  const long = `Hi this is Marco at Bella Cucina. ${"The walk-in freezer is warm and the door won't close. ".repeat(4000)}`;
  const start = Date.now();
  const p = parseMessage(long, { ...BASE, channel: "email" });
  assert.ok(Date.now() - start < 2000);
  assert.equal(p.contact_name, "Marco");
  assert.equal(p.urgent, true);
  assert.ok(p.problem.length <= 60);
  assert.ok(p.details.length <= 280);
});

test("browser-safe: imports only ./format.js, ./time.js and ./stages.js", () => {
  const source = readFileSync(new URL("../shared/parse.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./format.js", "./time.js", "./stages.js"]);
  assert.doesNotMatch(source, /\b(?:require\(|process\.|Date\.now\(|new Date\(\))/);
});

// ---------------------------------------------------------------------------
// Review fixes: asks, accents, form layouts, identity, notebook rows, the guard

test("a sentence that starts with 'Can you' keeps what it asks for (intake RT-8)", () => {
  assert.equal(parse("Can you come look at our ice machine tomorrow?", "sms", "+13125557801").problem,
    "Come look at our ice machine tomorrow");
  assertFields(parse("Could someone check our walk-in freezer, it's at 15 degrees", "sms", "+13125557802"), {
    problem: "Check our walk-in freezer, it's at 15 degrees", urgent: true,
  });
  // A bare ask is skipped when a later sentence says what's wrong.
  assert.equal(parse("Can you send someone? walk-in cooler is at 50", "sms", "+13125557803").problem, "Walk-in cooler is at 50");
  assert.equal(parse("can you come look at the ice machine tomorrow", "sms", OWNER).problem, "Come look at the ice machine tomorrow");
  // A trailing ask is still dropped, and so is a "call me" left without its number.
  assert.equal(parse("Our walk-in cooler is warm, call me 312-555-0181", "email").problem, "Walk-in cooler is warm");
});

test("names and businesses with accents (intake RT-8)", () => {
  assertFields(parse("Hi this is José at Café Olé, our reach-in is warm", "sms", "+13125557804"), {
    contact_name: "José", business_name: "Café Olé", problem: "Reach-in is warm",
  });
  assertFields(parse("Hi this is Sunrise Café, our reach-in is warm", "sms", "+13125557805"), {
    contact_name: null, business_name: "Sunrise Café", problem: "Reach-in is warm",
  });
  assertFields(parse("Ömer from Döner House: walk-in is down", "sms", "+13125557806"), {
    contact_name: "Ömer", business_name: "Döner House",
  });
});

test("form layouts: aliases, split names, label rows and single-line fields (RT-1, RT-4, RT-9)", () => {
  assertFields(parse("You have a new form submission.\n\nFull Name: Carla Diaz\nPhone Number: (312) 555-7201\nEmail: carla@diaz.example\nComments: Display case not cooling", "email"), {
    contact_name: "Carla Diaz", phone: "+13125557201", email: "carla@diaz.example", problem: "Display case not cooling",
  });
  assertFields(parse("First Name: Jo\nLast Name: King\nPhone: 312-555-0143\nMessage: reach-in not cooling", "email"), {
    contact_name: "Jo King", phone: "+13125550143", problem: "Reach-in not cooling",
  });
  // HTML-table forms arrive as a label on one line and its value on the next, or label<tab>value.
  assertFields(parse("Name\nSEO Guru\nMessage\nWe can rank your site #1 on Google", "email"), {
    contact_name: "SEO Guru", problem: "We can rank your site #1 on Google",
  });
  assertFields(parse("Name\tRosa Alvarez\nPhone\t312-555-7299\nMessage\tWalk-in freezer is down, losing product", "email"), {
    contact_name: "Rosa Alvarez", phone: "+13125557299", urgent: true,
  });
  // A business or phone value ends at its line; it never swallows the labels after it.
  assertFields(parse("Business: Fox Deli\nWhat's going on?: deli case is warm\nBest time: mornings", "form"), {
    business_name: "Fox Deli", problem: "Deli case is warm", urgent: true,
  });
  // A lone label word in an ordinary text is not a form.
  assert.equal(parse("Problem\nThe walk-in is warm", "sms", "+13125550150").problem, "Problem");
});

test("looksLikeForm and formFieldFor use one label list", () => {
  assert.equal(looksLikeForm("Thanks!\nPhone: 312-555-0142"), false);
  assert.equal(looksLikeForm("Name: Tony Russo / Business: Tony's Bistro"), true);
  assert.equal(looksLikeForm("name: Priya\nemail: p@x.example"), true);
  assert.equal(looksLikeForm("Full Name: Hank Moody\nPhone Number: 312-555-0157\nHow can we help?: freezer warm"), true);
  assert.equal(looksLikeForm("Name\nSEO Guru\nMessage\nWe can rank your site"), true);
  assert.equal(looksLikeForm("Hi Denise, the walk-in is warm.\nCall me: 312-555-0142"), false);
  assert.deepEqual(["Your Name", "Company Name", "Phone #", "E-mail", "What's going on?", "Last Name", "Best time"].map(formFieldFor),
    ["contact_name", "business_name", "phone", "email", "message", "last_name", null]);
});

test("emails: one strict address, never a relay, header line or the owner's own (C4, security RT-4)", () => {
  assert.equal(normalizeEmail(" Rosa@Example.COM "), "rosa@example.com");
  for (const bad of ["chef@bistro.example?cc=billing@attacker.example", "a b@c.example", "a@b.example,c@d.example", "a@b", "", null, 42]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
  const relays = ["no-reply@crm.wix.com", "noreply@x.example", "donotreply@x.example", "mailer-daemon@x.example",
    "wordpress@frostline.example", "forms@frostline.example", "form-submission@squarespace.info",
    "notifications@x.example", "submissions@x.example", "hello@jotform.com", "x@typeform.com", "x@formspree.io"];
  for (const email of relays) assert.equal(isRelayAddress(email), true, email);
  assert.equal(isRelayAddress("rosa@taqueria.example"), false);
  assert.equal(isRelayAddress("formica@counters.example"), false);
  assert.equal(isRelayAddress("Denise@Frostline.example", "denise@frostline.example"), true);

  const pasted = "From: Frostline Website <forms@frostline.example>\nReply-To: forms@frostline.example\nSubject: New form submission\n\n"
    + "Name: Tony Russo\nBusiness: Tony's Bistro\nPhone: (312) 555-0187\nMessage: Walk-in freezer at 10F and rising.";
  assertFields(parse(pasted, "manual"), { email: null, contact_name: "Tony Russo", business_name: "Tony's Bistro", phone: "+13125550187" });
  assertFields(parse("Email: forms@frostline.example\nAlso try me at ana@harbor.example", "email"), { email: "ana@harbor.example" });
  assert.equal(parse("forward from denise@frostline.example: walk-in warm", "email", null, { owner_email: "denise@frostline.example" }).email, null);
});

test("notebook rows: the parsed phrases leave the problem; 'call back fri' is a callback day (UX-7)", () => {
  const rows = parseNotebook([
    "Joe's Diner walk-in, quoted 1800 tues, waiting",
    "Fresh Mart ice machine needs scheduling",
    "Harbor Grill reach-in needs a quote 312-555-0125",
    "Sal's Pizza prep table scheduled thu with Luis",
    "- Rosa's Taqueria walk-in done, $2,400",
    "Pete's Pub ice machine leaking call back fri 312-555-0111",
    "Marie 555-0122 reach in warm",
  ].join("\n"), { now: NOW, tz: TZ, techs: TECHS });
  assert.deepEqual(rows.map((r) => r.fields.problem),
    ["Walk-in", "Ice machine", "Reach-in", "Prep table", "Walk-in", "Ice machine leaking", "Reach in warm"]);
  assert.deepEqual(rows.map((r) => r.callback_date), [null, null, null, null, null, "2026-10-09", null]);
  assertFields(rows[5].fields, { business_name: "Pete's Pub", phone: "+13125550111", urgent: true });
  assertFields(rows[6].fields, { contact_name: "Marie", phone: null }); // seven digits are not a phone
  // Quick Add keeps its text: only notebook rows are trimmed.
  assert.equal(parse("Joe's Diner walk-in, quoted 1800 tues, waiting", "manual").problem, "Walk-in, quoted 1800 tues, waiting");
});

test("the guard: a parser error is logged by name only and the caller gets the empty result (HM-8)", () => {
  const warn = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args.join(" "));
  try {
    const rules = parse("walk-in cooler down", "manual");
    const hostile = { get summary() { throw new Error("secret walk-in text"); } };
    const merged = mergeParse(rules, hostile, "walk-in cooler down", { channel: "manual" });
    assert.deepEqual([merged.problem, merged.parsed_by, merged.urgent_source], [rules.problem, "rules", "rules"]);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(logged, ["[parse] mergeParse failed (Error)"]);
});
