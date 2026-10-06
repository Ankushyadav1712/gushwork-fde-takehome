// The §12.2 demo seed as plain JobViews, derived by replaying each record's actions through
// the real rules (applyOutcome) at the stated local times. A tiny in-memory stand-in for
// ingest + the job table: no SQLite, no server. Also exports small helpers the rule tests share.

import { atLocal } from "../../shared/time.js";
import { applyOutcome } from "../../shared/stages.js";

export const SEED_TZ = "America/Chicago";
/** Mon 2026-10-05 07:00 America/Chicago. */
export const SEED_ANCHOR = "2026-10-05T12:00:00.000Z";
export const PUBLIC_URL = "http://localhost:3000";

/** §6 defaults. `readonly_key` is random on first boot in the app; fixed here. */
export const SETTINGS = Object.freeze({
  company_name: "Frostline Refrigeration",
  owner_name: "Denise",
  owner_phone: "+13125550100",
  husband_name: "Rick",
  husband_phone: "+13125550108",
  techs: [
    { name: "Luis", phone: "+13125550121" },
    { name: "Mike", phone: "+13125550122" },
    { name: "Dee", phone: "+13125550123" },
    { name: "Sam", phone: "+13125550124" },
  ],
  timezone: "America/Chicago",
  digest_time: "07:00",
  friday_sweep: true,
  weekend_digest: true,
  auto_ack_enabled: false,
  auto_ack_text: "Hi, it's Denise at {company}. Got your message - I'll call you back as soon as I can.",
  readonly_key: "test-readonly-key-000000",
  clock_offset_ms: 0,
});

/** "2026-10-02 16:47" (local, business time zone) -> ISO instant. */
export function at(localDateTime) {
  const [ymd, hm] = localDateTime.split(" ");
  return atLocal(ymd, hm, SEED_TZ);
}

export function ctxAt(now, overrides = {}) {
  return { now, tz: SEED_TZ, settings: SETTINGS, publicUrl: PUBLIC_URL, ...overrides };
}

/** A complete JobView with ingest-style defaults (stage new, due when it came in). */
export function makeJobView(overrides = {}) {
  const createdAt = overrides.created_at ?? SEED_ANCHOR;
  const { customer, ...rest } = overrides;
  return {
    id: 1, customer_id: 1, stage: "new", source: "sms", source_detail: null,
    problem: "Walk-in cooler not cold", details: null, equipment: "walk_in_cooler",
    urgent: 0, urgent_source: null, ai_not_service: 0, parsed_by: "rules",
    quote_amount: null, quote_sent_at: null, visit_date: null, tech: null, notes: null,
    created_at: createdAt, updated_at: createdAt, stage_entered_at: createdAt,
    first_touch_at: null, last_touch_at: null,
    next_due_at: createdAt, snoozed_until: null, unread_inbound_at: null,
    attempts: 0, nudges: 0, won_at: null, done_at: null, lost_at: null, lost_reason: null, closed_at: null,
    last_inbound: { at: createdAt, channel: "sms", call_status: null, body: "Walk-in cooler not cold" },
    past_jobs: 0,
    ...rest,
    customer: {
      contact_name: "Pat Lee", business_name: "Corner Cafe", phone: "+13125550199",
      email: null, address: null, blocked: 0, ...customer,
    },
  };
}

/** Apply an outcome at `now` and return the merged JobView (what the server would store). */
export function applyAt(jv, outcome, args, now) {
  return { ...jv, ...applyOutcome(jv, outcome, args, ctxAt(now)).patch };
}

/** A customer message attached to an open job (ingest §7.1 step 6). */
export function receiveInbound(jv, { at: when, channel = "sms", call_status = null, body = "" }) {
  return {
    ...jv,
    unread_inbound_at: jv.unread_inbound_at ?? when,
    updated_at: when,
    last_inbound: { at: when, channel, call_status, body },
  };
}

// ---------------------------------------------------------------------------
// §12.2 records. All phones are (312) numbers.

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

const TEXT = { source: "sms", source_detail: null, channel: "sms", call_status: null };
const FORM = { source: "form", source_detail: null, channel: "form", call_status: null };
const VOICEMAIL = { source: "call", source_detail: "voicemail", channel: "call", call_status: "voicemail" };
const MISSED = { source: "call", source_detail: "missed", channel: "call", call_status: "missed" };

// Each action is [local time, outcome id | "inbound", args].
const RECORDS = [
  {
    id: 1, customer: "joes", came_in: "2026-07-07 09:30", ...TEXT,
    body: "Joe here from Joe's Diner. Walk-in door gasket is torn, can you replace it?",
    problem: "Walk-in door gasket torn", equipment: "walk_in_cooler",
    actions: [
      ["2026-07-07 10:15", "yes", { visit_date: "2026-07-09", tech: "Mike" }],
      ["2026-07-09 16:00", "done", { amount: 275 }],
    ],
  },
  {
    id: 2, customer: "rosas", came_in: "2026-08-06 10:00", ...TEXT,
    body: "Rosa from Rosa's Taqueria. Can you clean the ice machine? It's been a while.",
    problem: "Ice machine cleaning", equipment: "ice_machine",
    actions: [
      ["2026-08-06 10:30", "yes", { visit_date: "2026-08-07", tech: "Dee" }],
      ["2026-08-07 14:00", "done", { amount: 350 }],
    ],
  },
  {
    // The rules parser flags "isn't making ice" as urgent; it is closed long before the anchor.
    id: 3, customer: "lucias", came_in: "2026-09-12 09:00", ...TEXT, urgent: 1,
    body: "Hi it's Lucia from Lucia's Market, the ice machine isn't making ice",
    problem: "Ice machine not making ice", equipment: "ice_machine",
    actions: [
      ["2026-09-12 09:20", "yes", { visit_date: "2026-09-14", tech: "Luis" }],
      ["2026-09-14 16:00", "done", { amount: 480 }],
    ],
  },
  {
    id: 4, customer: "seoul", came_in: "2026-09-23 11:00", ...FORM,
    body: "Our reach-in cooler compressor is really noisy. Can you quote a replacement?",
    problem: "Reach-in compressor noisy - wants a quote", equipment: "reach_in",
    actions: [
      ["2026-09-23 13:00", "need_quote", {}],
      ["2026-09-24 10:00", "quote_sent", { amount: 1200 }],
      ["2026-10-01 17:00", "lost", { lost_reason: "went_elsewhere" }],
    ],
  },
  {
    id: 5, customer: "northside", came_in: "2026-09-26 10:00", ...FORM,
    body: "Two evaporator fan motors in the freezer room are failing. Need a quote to replace both.",
    problem: "Freezer room evaporator fan motors failing", equipment: "walk_in_freezer",
    actions: [
      ["2026-09-28 09:30", "need_quote", {}],
      ["2026-10-02 11:00", "quote_sent", { amount: 6000 }],
    ],
  },
  {
    id: 6, customer: "union", came_in: "2026-09-27 08:30", ...VOICEMAIL,
    body: "Ray Dawson at Union Warehouse. The condensing unit on the dock freezer is making a racket. Can you send someone this week?",
    problem: "Dock freezer condensing unit making a racket", equipment: "walk_in_freezer",
    actions: [
      ["2026-09-28 08:10", "need_quote", {}],
      ["2026-09-28 15:00", "quote_sent", { amount: 1800 }],
      ["2026-09-29 09:00", "yes", { visit_date: "2026-10-02", tech: "Sam" }],
      ["2026-10-02 15:30", "done", {}],
    ],
  },
  {
    id: 7, customer: "rosas", came_in: "2026-09-29 10:05", ...TEXT,
    body: "Hi Denise, the walk-in cooler keeps short cycling and the compressor sounds rough. Can you take a look?",
    problem: "Walk-in cooler compressor short cycling", equipment: "walk_in_cooler",
    actions: [
      ["2026-09-29 14:00", "need_quote", {}],
      ["2026-10-01 14:10", "quote_sent", { amount: 2400 }],
    ],
  },
  {
    id: 8, customer: "harbor", came_in: "2026-09-29 11:15", ...FORM,
    body: "Our reach-in by the line needs a new door gasket and the hinge is loose. When can you come?",
    problem: "Reach-in door gasket and loose hinge", equipment: "reach_in",
    actions: [
      ["2026-09-30 09:30", "quote_sent", { amount: 540 }],
      ["2026-10-02 10:00", "yes", { visit_date: "2026-10-06", tech: "Mike" }],
      ["2026-10-04 18:05", "inbound", { channel: "sms", body: "Can Mike come Wednesday instead of Tuesday? We're closed Tuesdays." }],
    ],
  },
  {
    id: 9, customer: "maple", came_in: "2026-09-29 13:00", ...VOICEMAIL,
    body: "This is Linda at Maple Street Bakery. The reach-in door hinge broke and the gasket is torn. Please call me.",
    problem: "Reach-in door hinge broke, gasket torn", equipment: "reach_in",
    actions: [
      ["2026-09-29 15:00", "quote_sent", { amount: 780 }],
      ["2026-10-01 10:30", "yes", { visit_date: null }],
      ["2026-10-01 10:31", "snooze", { snooze_until: "2026-10-07" }],
    ],
  },
  {
    id: 10, customer: "sals", came_in: "2026-09-29 16:00", ...TEXT,
    body: "Sal here from Sal's Pizza. Prep table cooler fan is making a grinding noise, can someone swap it?",
    problem: "Prep table cooler fan grinding", equipment: "prep_table",
    actions: [["2026-09-30 15:00", "yes", { visit_date: "2026-10-02", tech: "Luis" }]],
  },
  {
    id: 11, customer: "midway", came_in: "2026-09-30 08:45", ...TEXT,
    body: "Gus at Midway Meats. Freezer door gasket is shot and the heater wire is out. Need a price.",
    problem: "Freezer door gasket and heater wire", equipment: "walk_in_freezer",
    actions: [["2026-09-30 10:20", "need_quote", {}]],
  },
  {
    id: 12, customer: "wok", came_in: "2026-09-30 09:00", ...TEXT,
    body: "Kevin at Golden Wok, time for the ice machine cleaning again",
    problem: "Ice machine cleaning and descale", equipment: "ice_machine",
    actions: [["2026-10-01 12:00", "yes", { visit_date: "2026-10-05", tech: "Dee" }]],
  },
  {
    id: 13, customer: "joes", came_in: "2026-09-30 12:00", ...TEXT,
    body: "Joe again from Joe's Diner. The walk-in cooler fan motor is squealing pretty loud.",
    problem: "Walk-in cooler fan motor squealing", equipment: "walk_in_cooler",
    actions: [
      ["2026-09-30 13:00", "need_quote", {}],
      ["2026-10-01 16:00", "quote_sent", { amount: 1150 }],
      ["2026-10-02 13:30", "yes", { visit_date: null }],
    ],
  },
  {
    id: 14, customer: "hillside", came_in: "2026-10-01 09:10", ...TEXT,
    body: "Hi Denise, Dave from Hillside Grocery. Looking for a price on a new ice machine for the front, no rush.",
    problem: "Price on a new ice machine", equipment: "ice_machine",
    actions: [["2026-10-01 11:00", "need_quote", {}]],
  },
  {
    id: 15, customer: "lakeview", came_in: "2026-10-02 08:15", ...FORM,
    body: "Name: Nora Lindqvist\nBusiness: Lakeview Brewing Co.\nPhone: (312) 555-0151\nMessage: We need a price on a second walk-in cooler for kegs.",
    problem: "Price on a second walk-in cooler for kegs", equipment: "walk_in_cooler",
    actions: [["2026-10-02 09:40", "need_quote", {}]],
  },
  {
    id: 16, customer: "bella", came_in: "2026-10-02 16:47", ...VOICEMAIL, urgent: 1,
    body: "Hi, this is Marco at Bella Cucina on Halsted. Our walk-in freezer is at 28 degrees and climbing and we just got a full delivery. Please call me back as soon as you can.",
    problem: "Walk-in freezer at 28 degrees and climbing", equipment: "walk_in_freezer",
    actions: [],
  },
  {
    id: 17, customer: "unknown0177", came_in: "2026-10-03 13:12", ...MISSED,
    body: "", problem: null, equipment: null,
    actions: [],
  },
  {
    id: 18, customer: "freshmart", came_in: "2026-10-05 06:02", ...FORM,
    body: "Name: Priya Shah\nBusiness: Fresh Mart #2\nPhone: (312) 555-0133\nMessage: Deli ice machine is making about half the ice it used to. Can someone look at it this week?",
    problem: "Deli ice machine making half the ice", equipment: "ice_machine",
    actions: [],
  },
];

const CUSTOMER_IDS = Object.fromEntries(
  [...new Set(RECORDS.map((r) => r.customer))].map((key, i) => [key, i + 1]),
);

function customerRecord(key) {
  return {
    contact_name: null, business_name: null, phone: null, email: null, address: null,
    ...CUSTOMERS[key], blocked: 0,
  };
}

/** The job row + latest message as ingest would store them when the record came in. */
function createdJob(record) {
  const createdAt = at(record.came_in);
  const urgent = record.urgent ? 1 : 0;
  return {
    customerKey: record.customer,
    row: {
      id: record.id, customer_id: CUSTOMER_IDS[record.customer], stage: "new",
      source: record.source, source_detail: record.source_detail,
      problem: record.problem, details: null, equipment: record.equipment,
      urgent, urgent_source: urgent ? "rules" : null, ai_not_service: 0, parsed_by: "rules",
      quote_amount: null, quote_sent_at: null, visit_date: null, tech: null, notes: null,
      created_at: createdAt, updated_at: createdAt, stage_entered_at: createdAt,
      first_touch_at: null, last_touch_at: null,
      next_due_at: createdAt, snoozed_until: null, unread_inbound_at: null,
      attempts: 0, nudges: 0, won_at: null, done_at: null, lost_at: null, lost_reason: null, closed_at: null,
    },
    lastInbound: { at: createdAt, channel: record.channel, call_status: record.call_status, body: record.body },
  };
}

function viewOf(entry, entries) {
  const { row } = entry;
  const pastJobs = entries.filter((e) => e.row.customer_id === row.customer_id
    && Date.parse(e.row.created_at) < Date.parse(row.created_at)).length;
  return { ...row, customer: customerRecord(entry.customerKey), last_inbound: { ...entry.lastInbound }, past_jobs: pastJobs };
}

/** Every create / outcome / inbound step, in time order (creation first on ties). */
function steps() {
  const list = [];
  for (const record of RECORDS) {
    list.push({ at: at(record.came_in), record, kind: "create" });
    for (const [when, kind, args] of record.actions) list.push({ at: at(when), record, kind, args });
  }
  return list
    .map((step, seq) => ({ ...step, seq }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
}

function applyStep(step, jobs) {
  if (step.kind === "create") {
    jobs.set(step.record.id, createdJob(step.record));
    return;
  }
  const entry = jobs.get(step.record.id);
  if (step.kind === "inbound") {
    const view = receiveInbound(viewOf(entry, [...jobs.values()]), { at: step.at, ...step.args });
    entry.row = { ...entry.row, unread_inbound_at: view.unread_inbound_at, updated_at: view.updated_at };
    entry.lastInbound = view.last_inbound;
    return;
  }
  const { patch } = applyOutcome(viewOf(entry, [...jobs.values()]), step.kind, step.args, ctxAt(step.at));
  entry.row = { ...entry.row, ...patch };
}

/** The seed's JobViews as stored at `atIso` (records not yet created are absent). */
export function seedJobViews(atIso = SEED_ANCHOR) {
  const cutoff = Date.parse(atIso);
  const jobs = new Map();
  for (const step of steps()) {
    if (Date.parse(step.at) > cutoff) break;
    applyStep(step, jobs);
  }
  const entries = [...jobs.values()];
  return entries.map((entry) => viewOf(entry, entries)).sort((a, b) => a.id - b.id);
}
