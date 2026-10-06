// Demo seed (SPEC §12): replays the §12.2 records in time order through the real ingest(), the real
// outcome path (performOutcome: applyOutcome + event with prev_json) and the real scheduler, which
// ticks every 5 minutes from Friday 12:00 to the anchor A (the most recent Monday 07:00).
// The weekend's texts and job 16's history therefore come out of the same code the app runs.
// CLI: node server/seed.js --reset   (wipe the database and reseed)
import "./env.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, get, wipe } from "./db.js";
import { ensureSettings, getSettings, putSettings } from "./repo.js";
import { ingest } from "./ingest.js";
import { performOutcome } from "./actions.js";
import { contextFor, resolvePublicUrl, DEFAULT_PORT } from "./context.js";
import { tick } from "./scheduler.js";
import * as clock from "./clock.js";
import {
  DEFAULT_TZ, addDays, addMinutes, atLocal, localDate, mostRecentMonday0700, shortDateLabel, timeLabel,
} from "../shared/time.js";

const TICK_MINUTES = 5;
/** Denise's own address in the demo, so her emails are never taken for a customer's (§7.3). */
const DEMO_OWNER_EMAIL = "denise@frostline.example";
/** The scheduler replay starts on the Friday before the anchor, at noon (§12.1). */
const TICKS_FROM = { days: -3, hm: "12:00" };

// Customers (§12.2). All phone numbers are fictional (312) 555-01xx numbers.
const CUSTOMERS = {
  joes: { contact_name: "Joe Russo", business_name: "Joe's Diner", phone: "+13125550160", address: "2301 S Halsted St" },
  rosas: { contact_name: "Rosa Medina", business_name: "Rosa's Taqueria", phone: "+13125550118", address: "3540 W 26th St" },
  lucias: { contact_name: "Lucia Ortiz", business_name: "Lucia's Market", phone: "+13125550101", address: "1645 W 18th St" },
  seoul: { contact_name: "Min-jun Kim", business_name: "Taste of Seoul", phone: "+13125550129" },
  northside: {
    contact_name: "Tom Becker", business_name: "Northside Cold Storage", phone: "+13125550112",
    email: "tbecker@northsidecold.example", address: "4800 N Ravenswood Ave",
  },
  union: { contact_name: "Ray Dawson", business_name: "Union Warehouse", phone: "+13125550183" },
  harbor: { contact_name: "Ana Ruiz", business_name: "Harbor Grill", phone: "+13125550125", address: "1120 N State St" },
  maple: { contact_name: "Linda Park", business_name: "Maple Street Bakery", phone: "+13125550138" },
  sals: { contact_name: "Sal Romano", business_name: "Sal's Pizza", phone: "+13125550190" },
  midway: { contact_name: "Gus Petrakis", business_name: "Midway Meats", phone: "+13125550174" },
  wok: { contact_name: "Kevin Chen", business_name: "Golden Wok", phone: "+13125550147" },
  hillside: { contact_name: "Dave Kowalski", business_name: "Hillside Grocery", phone: "+13125550199" },
  lakeview: {
    contact_name: "Nora Lindqvist", business_name: "Lakeview Brewing Co.", phone: "+13125550151",
    email: "nora@lakeviewbrewing.example",
  },
  bella: { contact_name: "Marco Rossi", business_name: "Bella Cucina", phone: "+13125550142", address: "1820 N Halsted St" },
  unknown0177: { phone: "+13125550177" },
  freshmart: {
    contact_name: "Priya Shah", business_name: "Fresh Mart #2", phone: "+13125550133",
    email: "priya.shah@freshmart.example", address: "4410 W Irving Park Rd",
  },
};

// How a record came in (`via`): the InboundEvent channel, provider and call status.
const TEXT = { channel: "sms", provider: "twilio", call_status: null };
const FORM = { channel: "form", provider: "form", call_status: null };
const FORM_EMAIL = { channel: "form", provider: "postmark", call_status: null };
const VOICEMAIL = { channel: "call", provider: "twilio", call_status: "voicemail" };
const MISSED = { channel: "call", provider: "twilio", call_status: "missed" };

/**
 * The §12.2 records. Times are [days from the anchor's Monday, "HH:MM" local]; visit and snooze
 * days are day offsets too, so the seed works for any Monday anchor. Actions: [when, outcome, args].
 */
const RECORDS = [
  {
    id: 1, customer: "joes", came_in: [-90, "09:30"], via: TEXT,
    body: "Joe here from Joe's Diner. Walk-in door gasket is torn, can you replace it?",
    problem: "Walk-in door gasket torn", equipment: "walk_in_cooler",
    actions: [[[-90, "10:15"], "yes", { visit_date: -88, tech: "Mike" }], [[-88, "16:00"], "done", { amount: 275 }]],
  },
  {
    id: 2, customer: "rosas", came_in: [-60, "10:00"], via: TEXT,
    body: "Rosa from Rosa's Taqueria. Can you clean the ice machine? It's been a while.",
    problem: "Ice machine cleaning", equipment: "ice_machine",
    actions: [[[-60, "10:30"], "yes", { visit_date: -59, tech: "Dee" }], [[-59, "14:00"], "done", { amount: 350 }]],
  },
  {
    id: 3, customer: "lucias", came_in: [-23, "09:00"], via: TEXT, urgent: true,
    body: "Hi it's Lucia from Lucia's Market, the ice machine isn't making ice",
    problem: "Ice machine not making ice", equipment: "ice_machine",
    actions: [[[-23, "09:20"], "yes", { visit_date: -21, tech: "Luis" }], [[-21, "16:00"], "done", { amount: 480 }]],
  },
  {
    id: 4, customer: "seoul", came_in: [-12, "11:00"], via: FORM,
    body: "Our reach-in cooler compressor is really noisy. Can you quote a replacement?",
    problem: "Reach-in compressor noisy - wants a quote", equipment: "reach_in",
    actions: [
      [[-12, "13:00"], "need_quote", {}],
      [[-11, "10:00"], "quote_sent", { amount: 1200 }],
      [[-4, "17:00"], "lost", { lost_reason: "went_elsewhere" }],
    ],
  },
  {
    id: 5, customer: "northside", came_in: [-9, "10:00"], via: FORM,
    body: "Two evaporator fan motors in the freezer room are failing. Need a quote to replace both.",
    problem: "Freezer room evaporator fan motors failing", equipment: "walk_in_freezer",
    actions: [[[-7, "09:30"], "need_quote", {}], [[-3, "11:00"], "quote_sent", { amount: 6000 }]],
  },
  {
    id: 6, customer: "union", came_in: [-8, "08:30"], via: VOICEMAIL,
    body: "Ray Dawson at Union Warehouse. The condensing unit on the dock freezer is making a racket. Can you send someone this week?",
    problem: "Dock freezer condensing unit making a racket", equipment: "walk_in_freezer",
    actions: [
      [[-7, "08:10"], "need_quote", {}],
      [[-7, "15:00"], "quote_sent", { amount: 1800 }],
      [[-6, "09:00"], "yes", { visit_date: -3, tech: "Sam" }],
      [[-3, "15:30"], "done", {}],
    ],
  },
  {
    id: 7, customer: "rosas", came_in: [-6, "10:05"], via: TEXT,
    body: "Hi Denise, the walk-in cooler keeps short cycling and the compressor sounds rough. Can you take a look?",
    problem: "Walk-in cooler compressor short cycling", equipment: "walk_in_cooler",
    actions: [[[-6, "14:00"], "need_quote", {}], [[-4, "14:10"], "quote_sent", { amount: 2400 }]],
  },
  {
    id: 8, customer: "harbor", came_in: [-6, "11:15"], via: FORM,
    body: "Our reach-in by the line needs a new door gasket and the hinge is loose. When can you come?",
    problem: "Reach-in door gasket and loose hinge", equipment: "reach_in",
    actions: [
      [[-5, "09:30"], "quote_sent", { amount: 540 }],
      [[-3, "10:00"], "yes", { visit_date: 1, tech: "Mike" }],
      [[-1, "18:05"], "inbound", { body: "Can Mike come Wednesday instead of Tuesday? We're closed Tuesdays." }],
    ],
  },
  {
    id: 9, customer: "maple", came_in: [-6, "13:00"], via: VOICEMAIL,
    body: "This is Linda at Maple Street Bakery. The reach-in door hinge broke and the gasket is torn. Please call me.",
    problem: "Reach-in door hinge broke, gasket torn", equipment: "reach_in",
    actions: [
      [[-6, "15:00"], "quote_sent", { amount: 780 }],
      [[-4, "10:30"], "yes", { visit_date: null }],
      [[-4, "10:31"], "snooze", { snooze_until: 2 }],
    ],
  },
  {
    id: 10, customer: "sals", came_in: [-6, "16:00"], via: TEXT,
    body: "Sal here from Sal's Pizza. Prep table cooler fan is making a grinding noise, can someone swap it?",
    problem: "Prep table cooler fan grinding", equipment: "prep_table",
    actions: [[[-5, "15:00"], "yes", { visit_date: -3, tech: "Luis" }]],
  },
  {
    id: 11, customer: "midway", came_in: [-5, "08:45"], via: TEXT,
    body: "Gus at Midway Meats. Freezer door gasket is shot and the heater wire is out. Need a price.",
    problem: "Freezer door gasket and heater wire", equipment: "walk_in_freezer",
    actions: [[[-5, "10:20"], "need_quote", {}]],
  },
  {
    id: 12, customer: "wok", came_in: [-5, "09:00"], via: TEXT,
    body: "Kevin at Golden Wok, time for the ice machine cleaning again",
    problem: "Ice machine cleaning and descale", equipment: "ice_machine",
    actions: [[[-4, "12:00"], "yes", { visit_date: 0, tech: "Dee" }]],
  },
  {
    id: 13, customer: "joes", came_in: [-5, "12:00"], via: TEXT,
    body: "Joe again from Joe's Diner. The walk-in cooler fan motor is squealing pretty loud.",
    problem: "Walk-in cooler fan motor squealing", equipment: "walk_in_cooler",
    actions: [
      [[-5, "13:00"], "need_quote", {}],
      [[-4, "16:00"], "quote_sent", { amount: 1150 }],
      [[-3, "13:30"], "yes", { visit_date: null }],
    ],
  },
  {
    id: 14, customer: "hillside", came_in: [-4, "09:10"], via: TEXT,
    body: "Hi Denise, Dave from Hillside Grocery. Looking for a price on a new ice machine for the front, no rush.",
    problem: "Price on a new ice machine", equipment: "ice_machine",
    actions: [[[-4, "11:00"], "need_quote", {}]],
  },
  {
    id: 15, customer: "lakeview", came_in: [-3, "08:15"], via: FORM_EMAIL,
    body: "Name: Nora Lindqvist\nBusiness: Lakeview Brewing Co.\nPhone: (312) 555-0151\nMessage: We need a price on a second walk-in cooler for kegs.",
    problem: "Price on a second walk-in cooler for kegs", equipment: "walk_in_cooler",
    actions: [[[-3, "09:40"], "need_quote", {}]],
  },
  {
    id: 16, customer: "bella", came_in: [-3, "16:47"], via: VOICEMAIL, urgent: true,
    body: "Hi, this is Marco at Bella Cucina on Halsted. Our walk-in freezer is at 28 degrees and climbing and we just got a full delivery. Please call me back as soon as you can.",
    problem: "Walk-in freezer at 28 degrees and climbing", equipment: "walk_in_freezer",
    actions: [],
  },
  {
    id: 17, customer: "unknown0177", came_in: [-2, "13:12"], via: MISSED,
    body: "", problem: null, equipment: null,
    actions: [],
  },
  {
    id: 18, customer: "freshmart", came_in: [0, "06:02"], via: FORM_EMAIL,
    body: "Name: Priya Shah\nBusiness: Fresh Mart #2\nPhone: (312) 555-0133\nMessage: Deli ice machine is making about half the ice it used to. Can someone look at it this week?",
    problem: "Deli ice machine making half the ice", equipment: "ice_machine",
    actions: [],
  },
];

// ---------------------------------------------------------------------------
// Turning records into timed steps

function placer(anchor, tz) {
  const monday = localDate(anchor, tz);
  return {
    at: ([days, hm]) => atLocal(addDays(monday, days), hm, tz),
    day: (days) => (days == null ? null : addDays(monday, days)),
  };
}

/** Ingest overrides, so names and problems don't depend on the parser (§12.1). */
function fieldsFor(record) {
  const customer = { contact_name: null, business_name: null, phone: null, email: null, address: null, ...CUSTOMERS[record.customer] };
  const urgent = Boolean(record.urgent);
  return {
    ...customer, problem: record.problem, details: null, equipment: record.equipment,
    urgent, urgent_source: urgent ? "rules" : null,
  };
}

/** The InboundEvent for one message on a record, sent `via` a channel (TEXT, FORM, VOICEMAIL, ...). */
function inboundEvent(record, via, body, receivedAt, seq) {
  const { channel, provider, call_status } = via;
  const phone = CUSTOMERS[record.customer].phone ?? null;
  const externalId = `seed-${record.id}-${seq}`;
  return {
    channel, provider, external_id: externalId, received_at: receivedAt,
    from_phone: phone, from_email: null, from_name: null, subject: null, body,
    call_status, call_duration_s: call_status ? 0 : null, form_fields: null,
    raw: { seed: true, record: record.id, channel, from: phone, body },
  };
}

/** Outcome args with day offsets turned into local dates. */
function outcomeArgs(args, place) {
  const out = { ...args };
  if ("visit_date" in out) out.visit_date = place.day(out.visit_date);
  if ("snooze_until" in out) out.snooze_until = place.day(out.snooze_until);
  return out;
}

/** Every create / outcome / inbound step, in time order (record order breaks ties). */
function actionSteps(place) {
  const steps = [];
  for (const record of RECORDS) {
    steps.push({ at: place.at(record.came_in), type: "create", record });
    record.actions.forEach(([when, outcome, args], i) => {
      steps.push({ at: place.at(when), type: outcome === "inbound" ? "inbound" : "outcome", record, outcome, args, seq: i + 1 });
    });
  }
  return steps
    .map((step, order) => ({ ...step, order }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order);
}

/** Scheduler ticks every 5 minutes from Friday 12:00 to the anchor, inclusive. */
function tickTimes(anchor, place) {
  const times = [];
  const end = Date.parse(anchor);
  for (let t = place.at([TICKS_FROM.days, TICKS_FROM.hm]); Date.parse(t) <= end; t = addMinutes(t, TICK_MINUTES)) {
    times.push(t);
  }
  return times;
}

/** Actions and ticks merged in time order; an action at the same instant as a tick runs first. */
function timeline(anchor, place) {
  const ticks = tickTimes(anchor, place).map((at) => ({ at, type: "tick" }));
  const steps = actionSteps(place);
  const merged = [];
  let i = 0;
  for (const tickStep of ticks) {
    while (i < steps.length && Date.parse(steps[i].at) <= Date.parse(tickStep.at)) merged.push(steps[i++]);
    merged.push(tickStep);
  }
  return merged.concat(steps.slice(i).filter((s) => Date.parse(s.at) <= Date.parse(anchor)));
}

// ---------------------------------------------------------------------------
// seedDemo

function runStep(db, step, state) {
  const { settings, jobIds, tickDeps } = state;
  if (step.type === "tick") {
    tick(db, step.at, tickDeps);
    return;
  }
  const { record } = step;
  if (step.type === "create") {
    const result = ingest(db, inboundEvent(record, record.via, record.body, step.at, 0), {
      now: step.at, ai: false, fields: fieldsFor(record), settings,
    });
    jobIds.set(record.id, result.job_id);
    return;
  }
  if (step.type === "inbound") {
    ingest(db, inboundEvent(record, TEXT, step.args.body, step.at, step.seq), { now: step.at, ai: false, settings });
    return;
  }
  const body = { outcome: step.outcome, ...outcomeArgs(step.args, state.place) };
  performOutcome(db, jobIds.get(record.id), body, contextFor(db, step.at, { settings }));
}

/**
 * Replay the demo into `db` (expected to have no jobs).
 * opts: {anchor? (default: the most recent Monday 07:00, §12.1), env?, publicUrl?, setClock?: true}.
 * At the end the demo clock is set to the anchor and clock_offset_ms is saved.
 * @returns {{anchor, jobs: number, texts: number}}
 */
export function seedDemo(db, { anchor, env = process.env, publicUrl = resolvePublicUrl(env), setClock = true } = {}) {
  ensureSettings(db, env.BUSINESS_TZ ? { timezone: env.BUSINESS_TZ } : {});
  const base = putSettings(db, { owner_email: DEMO_OWNER_EMAIL });
  const tz = base.timezone || DEFAULT_TZ;
  const at = anchor ?? mostRecentMonday0700(new Date().toISOString(), tz);
  const settings = { ...base, auto_ack_enabled: false };
  const state = {
    settings,
    jobIds: new Map(),
    place: placer(at, tz),
    // Replayed texts are always simulated: never send last weekend's texts through Twilio.
    tickDeps: { env: {}, settings, publicUrl },
  };
  for (const step of timeline(at, state.place)) runStep(db, step, state);

  if (setClock) {
    clock.setNow(at);
    putSettings(db, { clock_offset_ms: clock.now().getTime() - Date.now() });
  }
  return {
    anchor: at,
    jobs: get(db, "SELECT count(*) AS n FROM jobs").n,
    texts: get(db, "SELECT count(*) AS n FROM outbox").n,
  };
}

export function hasJobs(db) {
  return Boolean(get(db, "SELECT 1 AS hit FROM jobs LIMIT 1"));
}

// ---------------------------------------------------------------------------
// CLI

function main(argv) {
  const db = openDb(process.env.DB_PATH || "data/callback.db");
  try {
    if (argv.includes("--reset")) wipe(db);
    else if (hasJobs(db)) {
      console.error("The database already has jobs. Run `npm run seed` (node server/seed.js --reset) to wipe it and reseed.");
      process.exitCode = 1;
      return;
    }
    const result = seedDemo(db, { env: process.env, publicUrl: resolvePublicUrl(process.env, process.env.PORT || DEFAULT_PORT) });
    const tz = getSettings(db).timezone;
    console.log(`Seeded the demo: ${result.jobs} jobs, ${result.texts} texts in the outbox. Demo clock: ${shortDateLabel(result.anchor, tz)} ${timeLabel(result.anchor, tz)}.`);
  } finally {
    db.close();
  }
}

/** True when run as `node server/seed.js` (import.meta.main needs Node 24.2+; fall back to argv). */
const isCli = import.meta.main ?? (Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isCli) main(process.argv.slice(2));
