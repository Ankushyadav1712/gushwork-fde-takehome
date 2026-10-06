// ingest() pipeline (SPEC §7.1, §7.3, §7.4, §8.5): T16, T17, T18, R03 and the intake edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, all, get } from "../server/db.js";
import * as repo from "../server/repo.js";
import {
  ingest, ingestManual, ingestBulk, IngestError, FALLBACK_PROBLEM, VALIDATION_MESSAGE,
} from "../server/ingest.js";
import { fromGeneric, fromTwilioSms, fromTwilioVoice, fromForm, VOICEMAIL_PLACEHOLDER } from "../server/adapters.js";
import { applyOutcome, outcomesFor, OutcomeError } from "../shared/stages.js";
import { bucketFor, replySuggestion, cardFor } from "../shared/today-rules.js";
import { parseNotebook, replyIntent } from "../shared/parse.js";
import { titleFor, sourceLabel } from "../shared/format.js";
import { atLocal, startOfDay } from "../shared/time.js";

const TZ = "America/Chicago";
const A = "2026-10-05T12:00:00.000Z"; // Mon Oct 5 2026 07:00 local
const at = (ymd, hm) => atLocal(ymd, hm, TZ);

function freshDb(settings = {}) {
  const db = openDb(":memory:");
  repo.ensureSettings(db);
  repo.putSettings(db, settings);
  return db;
}

const ctxAt = (db, now) => ({ now, tz: TZ, settings: repo.getSettings(db), replyIntent });
const count = (db, table) => get(db, `SELECT count(*) AS n FROM ${table}`).n;
const sms = (from, body, id = null) => fromGeneric("sms", { from, body, id });

/** Apply one outcome the way the API does (patch only), for building state. */
function outcome(db, jobId, id, args, now) {
  const { patch } = applyOutcome(repo.getJobView(db, jobId), id, args, { now, tz: TZ });
  return repo.updateJob(db, jobId, patch);
}

function ingestAt(db, event, now, opts = {}) {
  return ingest(db, { ...event, received_at: now }, { now, ai: false, ...opts });
}

/** Rosa's Taqueria with a $2,400 quote out (waiting_yes), like seed job 7. */
function rosaWaitingYes(db) {
  const { job_id } = ingestAt(db, sms("+13125550118", "Rosa from Rosa's Taqueria. The walk-in cooler keeps short cycling."),
    at("2026-09-29", "10:05"));
  outcome(db, job_id, "need_quote", {}, at("2026-09-29", "14:00"));
  outcome(db, job_id, "quote_sent", { amount: 2400 }, at("2026-10-01", "14:10"));
  return job_id;
}

/** Midway Meats owed a quote, like seed job 11. */
function midwayQuote(db) {
  const { job_id } = ingestAt(db, sms("+13125550174", "Gus at Midway Meats. Freezer door gasket is shot. Need a price."),
    at("2026-09-30", "08:45"));
  outcome(db, job_id, "need_quote", {}, at("2026-09-30", "10:20"));
  return job_id;
}

// ---------------------------------------------------------------------------
// T16: raw message first

test("T16: a parser error keeps the raw message, creates the placeholder job, and leaves nothing unlinked", () => {
  const db = freshDb();
  const event = fromTwilioSms({ MessageSid: "SM_t16", From: "+13125550166", Body: "freezer is down!!", NumMedia: "0" });
  let seenDuringParse = null;
  const result = ingestAt(db, event, A, {
    parse: () => {
      seenDuringParse = get(db, "SELECT status, body FROM messages");
      throw new Error("parser exploded");
    },
  });
  assert.deepEqual(seenDuringParse, { status: "received", body: "freezer is down!!" });
  assert.equal(result.status, "error");
  const msg = repo.getMessage(db, result.message_id);
  assert.equal(msg.status, "error");
  assert.equal(msg.error, "parser exploded");
  assert.equal(msg.job_id, result.job_id);
  assert.deepEqual(msg.raw, { MessageSid: "SM_t16", From: "+13125550166", Body: "freezer is down!!", NumMedia: "0" });
  const job = repo.getJobView(db, result.job_id);
  assert.equal(job.problem, "Couldn't read this one - tap to look");
  assert.equal(FALLBACK_PROBLEM, "Couldn't read this one - tap to look");
  assert.equal(job.stage, "new");
  assert.equal(job.source, "sms");
  assert.equal(job.next_due_at, A);
  assert.equal(job.customer.phone, "+13125550166");
  assert.equal(repo.unlinkedMessageCount(db), 0);
  assert.equal(bucketFor(job, ctxAt(db, A)), "new");
});

test("duplicates: the same external id returns 'duplicate' with the job and writes no new row", () => {
  const db = freshDb();
  const event = fromTwilioSms({ MessageSid: "SM_dup", From: "+13125550166", Body: "ice machine leaking" });
  const first = ingestAt(db, event, A);
  const second = ingestAt(db, event, at("2026-10-05", "07:05"));
  assert.equal(first.status, "created_job");
  assert.deepEqual({ ...second, refine: null }, {
    status: "duplicate", job_id: first.job_id, message_id: first.message_id, customer_id: first.customer_id, refine: null,
  });
  assert.equal(count(db, "messages"), 1);
  assert.equal(count(db, "jobs"), 1);
});

test("created job: fields, created event and parse_json.rules (§7.1 step 7)", () => {
  const db = freshDb();
  const event = fromTwilioSms({ MessageSid: "SM_f1", From: "+13125550142",
    Body: "Hi its Marco at Bella Cucina, walk-in freezer at 28 and climbing, can someone come?" });
  const r = ingestAt(db, event, A);
  const jv = repo.getJobView(db, r.job_id);
  assert.equal(r.status, "created_job");
  assert.equal(r.refine, null);
  assert.deepEqual(
    { stage: jv.stage, source: jv.source, source_detail: jv.source_detail, problem: jv.problem, equipment: jv.equipment,
      urgent: jv.urgent, urgent_source: jv.urgent_source, parsed_by: jv.parsed_by, created_at: jv.created_at,
      stage_entered_at: jv.stage_entered_at, next_due_at: jv.next_due_at, unread_inbound_at: jv.unread_inbound_at },
    { stage: "new", source: "sms", source_detail: null, problem: "Walk-in freezer at 28 and climbing",
      equipment: "walk_in_freezer", urgent: 1, urgent_source: "rules", parsed_by: "rules", created_at: A,
      stage_entered_at: A, next_due_at: A, unread_inbound_at: null },
  );
  assert.equal(jv.customer.contact_name, "Marco");
  assert.equal(jv.customer.business_name, "Bella Cucina");
  assert.equal(jv.customer.phone, "+13125550142");
  const [created] = repo.listEvents(db, r.job_id);
  assert.deepEqual([created.kind, created.actor, created.summary, created.message_id, created.at],
    ["created", "customer", "Text came in", r.message_id, A]);
  const msg = repo.getMessage(db, r.message_id);
  assert.equal(msg.status, "created_job");
  assert.equal(msg.parse.rules.problem, "Walk-in freezer at 28 and climbing");
  assert.equal(msg.parse.ai, null);
});

test("seed overrides: opts.fields win over the parse", () => {
  const db = freshDb();
  const event = fromTwilioVoice({ CallSid: "CA16", From: "+13125550142", CallStatus: "completed",
    RecordingUrl: "https://example.test/r", TranscriptionText: "Hi, this is Marco at Bella Cucina on Halsted. Our walk-in freezer is at 28 degrees and climbing and we just got a full delivery. Please call me back as soon as you can." });
  const r = ingestAt(db, event, at("2026-10-02", "16:47"), {
    fields: { contact_name: "Marco Rossi", address: "1820 N Halsted St", problem: "Walk-in freezer at 28 degrees and climbing" },
  });
  const jv = repo.getJobView(db, r.job_id);
  assert.equal(jv.customer.contact_name, "Marco Rossi");
  assert.equal(jv.customer.address, "1820 N Halsted St");
  assert.equal(jv.problem, "Walk-in freezer at 28 degrees and climbing");
  assert.equal(jv.source_detail, "voicemail");
  assert.equal(jv.urgent_source, "rules");
  assert.equal(repo.listEvents(db, r.job_id)[0].summary, "Voicemail came in");
});

// ---------------------------------------------------------------------------
// T17: forwarded texts

test("T17: a forwarded text attaches by business name and shows under replied", () => {
  const db = freshDb();
  const jobId = midwayQuote(db);
  const event = fromTwilioSms({ MessageSid: "SM_fwd", From: "+13125550100",
    Body: "Midway Meats: hey denise any update on that freezer door quote?" });
  const r = ingestAt(db, event, A);
  assert.equal(r.status, "attached");
  assert.equal(r.job_id, jobId);
  assert.equal(count(db, "jobs"), 1);
  const msg = repo.getMessage(db, r.message_id);
  assert.deepEqual([msg.forwarded, msg.from_phone, msg.status, msg.job_id], [1, null, "attached", jobId]);
  const jv = repo.getJobView(db, jobId);
  assert.equal(jv.unread_inbound_at, A);
  assert.equal(bucketFor(jv, ctxAt(db, A)), "replied");
  assert.equal(repo.listEvents(db, jobId)[0].summary,
    "Forwarded text: Midway Meats: hey denise any update on that freezer door quote?");
});

test("T17: a forwarded text with no phone and no matching business creates 'Forwarded text - who is this?'", () => {
  const db = freshDb();
  midwayQuote(db);
  const r = ingestAt(db, sms("+13125550100", "Fwd: can you guys look at our walk-in this week?"), A);
  assert.equal(r.status, "created_job");
  const jv = repo.getJobView(db, r.job_id);
  assert.equal(jv.source_detail, "forwarded");
  assert.equal(jv.customer.phone, null);
  assert.equal(titleFor(jv), "Forwarded text - who is this?");
  assert.equal(sourceLabel(jv.source, jv.source_detail), "Forwarded text");
  assert.equal(repo.listEvents(db, r.job_id)[0].summary, "Forwarded text came in");
});

test("T17: a forwarded text keeps the original sender's phone (F5)", () => {
  const db = freshDb();
  const r = ingestAt(db, sms("+13125550100", "Fwd: From Gus (312) 555-0174: hey denise any update on that freezer door quote?"), A);
  const jv = repo.getJobView(db, r.job_id);
  assert.equal(jv.customer.phone, "+13125550174");
  assert.equal(jv.customer.contact_name, "Gus");
  assert.equal(repo.getMessage(db, r.message_id).from_phone, "+13125550174");
});

// ---------------------------------------------------------------------------
// T18: attach and reply suggestions

test("T18: a reply attaches to the open job, sets unread_inbound_at, and suggests mark_yes without a stage change", () => {
  const db = freshDb();
  const jobId = rosaWaitingYes(db);
  const before = repo.getJobRow(db, jobId);
  const r = ingestAt(db, sms("+13125550118", "yes go ahead, thursday works for us"), A);
  assert.deepEqual([r.status, r.job_id], ["attached", jobId]);
  assert.equal(count(db, "jobs"), 1);
  const jv = repo.getJobView(db, jobId);
  assert.equal(jv.stage, "waiting_yes");
  assert.equal(jv.next_due_at, before.next_due_at);
  assert.equal(jv.unread_inbound_at, A);
  assert.equal(jv.updated_at, A);
  assert.equal(jv.last_inbound.body, "yes go ahead, thursday works for us");
  const ctx = ctxAt(db, A);
  assert.equal(replySuggestion(jv, ctx), "mark_yes");
  const card = cardFor(jv, ctx);
  assert.equal(card.bucket, "replied");
  assert.deepEqual(card.outcomes[0], { id: "yes", label: "Mark as yes?", primary: true, suggested: true, needs: "day_or_none" });
  const [inbound] = repo.listEvents(db, jobId);
  assert.deepEqual([inbound.kind, inbound.actor, inbound.summary, inbound.message_id],
    ["inbound", "customer", "Texted: yes go ahead, thursday works for us", r.message_id]);

  // A second message keeps the first unread time (??=).
  ingestAt(db, sms("+13125550118", "also the door sticks"), at("2026-10-05", "08:00"));
  assert.equal(repo.getJobRow(db, jobId).unread_inbound_at, A);
});

test("T18: 'no thanks, we went with someone else' suggests mark_lost with went_elsewhere", () => {
  const db = freshDb();
  const jobId = rosaWaitingYes(db);
  ingestAt(db, sms("+13125550118", "no thanks, we went with someone else"), A);
  const jv = repo.getJobView(db, jobId);
  assert.equal(jv.stage, "waiting_yes");
  const suggestion = replySuggestion(jv, ctxAt(db, A));
  assert.equal(suggestion, "mark_lost");
  assert.deepEqual(outcomesFor(jv, { suggestion, now: A, tz: TZ })[0], {
    id: "lost", label: "Mark lost?", primary: true, suggested: true, needs: "lost_reason",
    preset: { lost_reason: "went_elsewhere" },
  });
});

test("attach: an inbound message can raise urgency, never lower it, and goes to the latest updated open job", () => {
  const db = freshDb();
  const jobId = rosaWaitingYes(db);
  // A web form from the same phone attaches too.
  const form = ingestAt(db, fromForm({ phone: "(312) 555-0118", message: "Also need the ice machine cleaned", id: "f1" }),
    at("2026-10-02", "09:00"));
  assert.deepEqual([form.status, form.job_id], ["attached", jobId]);
  assert.equal(repo.listEvents(db, jobId)[0].summary, "Web form: Also need the ice machine cleaned");
  assert.equal(repo.getJobRow(db, jobId).urgent, 0);
  const r = ingestAt(db, sms("+13125550118", "the walk-in is warm now, food at risk"), A);
  const job = repo.getJobRow(db, r.job_id);
  assert.deepEqual([job.urgent, job.urgent_source], [1, "rules"]);
  repo.updateJob(db, jobId, { urgent: 0, urgent_source: "manual", updated_at: A });
  ingestAt(db, sms("+13125550118", "never mind, all good"), A);
  assert.equal(repo.getJobRow(db, jobId).urgent, 0);
});

test("attach target: with two open jobs the most recently updated one gets the message", () => {
  const db = freshDb();
  const first = rosaWaitingYes(db);
  const customerId = repo.getJobRow(db, first).customer_id;
  const second = repo.insertJob(db, {
    customer_id: customerId, stage: "quote", source: "manual", problem: "Ice machine cleaning",
    created_at: at("2026-10-02", "09:00"), updated_at: at("2026-10-02", "09:00"),
    stage_entered_at: at("2026-10-02", "09:00"), next_due_at: at("2026-10-05", "00:00"),
  });
  const r = ingestAt(db, sms("+13125550118", "any news?"), A);
  assert.equal(r.job_id, second);
});

// ---------------------------------------------------------------------------
// R03: repeat customers

test("R03: a text from a past customer creates a new job titled by business, with the Repeat badge and source Text", () => {
  const db = freshDb();
  const old = ingestAt(db, sms("+13125550101", "Hi it's Lucia from Lucia's Market, the ice machine isn't making ice"),
    at("2026-09-12", "09:00")).job_id;
  outcome(db, old, "yes", { visit_date: "2026-09-14", tech: "Luis" }, at("2026-09-12", "09:20"));
  outcome(db, old, "done", { amount: 480 }, at("2026-09-14", "16:00"));

  const r = ingestAt(db, sms("+13125550101", "ice machine acting up again"), A);
  assert.equal(r.status, "created_job");
  assert.equal(r.matched_customer, true);
  assert.notEqual(r.job_id, old);
  const jv = repo.getJobView(db, r.job_id);
  assert.equal(jv.customer_id, repo.getJobRow(db, old).customer_id);
  const card = cardFor(jv, ctxAt(db, A));
  assert.equal(card.title, "Lucia's Market");
  assert.deepEqual(card.badges, ["Repeat - 1 past job"]);
  assert.equal(card.source_label, "Text");
});

test("R03: an unknown number gets its formatted phone as the title", () => {
  const db = freshDb();
  const r = ingestAt(db, sms("+13125550166", "ice machine acting up again"), A);
  assert.equal(titleFor(repo.getJobView(db, r.job_id)), "(312) 555-0166");
});

test("repeat matching: a plain email matches the customer by sender address", () => {
  const db = freshDb();
  const customer = repo.createCustomer(db, { business_name: "Lakeview Brewing Co.", email: "nora@lakeviewbrewing.example" }, A);
  const r = ingestAt(db, fromGeneric("email", { from: "Nora Lindqvist <Nora@LakeviewBrewing.example>", text: "Our keg cooler is warm." }), A);
  assert.equal(r.status, "created_job");
  assert.equal(repo.getJobRow(db, r.job_id).customer_id, customer.id);
  assert.equal(repo.getCustomer(db, customer.id).contact_name, "Nora Lindqvist"); // filled a blank
});

// ---------------------------------------------------------------------------
// Blocked numbers and calls that create nothing

test("blocked customer: the message is logged as 'blocked' and no job is created", () => {
  const db = freshDb();
  const customer = repo.createCustomer(db, { phone: "+13125550155" }, A);
  repo.setBlocked(db, customer.id, true, A);
  const r = ingestAt(db, sms("+13125550155", "Lower your merchant fees today!"), A);
  assert.deepEqual([r.status, r.job_id], ["blocked", null]);
  const msg = repo.getMessage(db, r.message_id);
  assert.deepEqual([msg.status, msg.customer_id, msg.job_id], ["blocked", customer.id, null]);
  assert.equal(count(db, "jobs"), 0);
  assert.equal(repo.unlinkedMessageCount(db), 0);
});

test("answered calls under 15 seconds and in-progress statuses are ignored; 15 seconds creates a job", () => {
  const db = freshDb();
  const short = ingestAt(db, fromTwilioVoice({ CallSid: "CA_short", From: "+13125550155", CallStatus: "completed", CallDuration: "14" }), A);
  assert.deepEqual([short.status, short.job_id], ["ignored", null]);
  assert.equal(repo.getMessage(db, short.message_id).status, "ignored");
  const ringing = ingestAt(db, fromTwilioVoice({ CallSid: "CA_ring", From: "+13125550156", CallStatus: "ringing" }), A);
  assert.equal(ringing.status, "ignored");
  const generic = ingestAt(db, fromGeneric("call", { from: "+13125550157", status: "answered", duration_s: 3 }), A);
  assert.equal(generic.status, "ignored");
  assert.equal(count(db, "jobs"), 0);

  const long = ingestAt(db, fromTwilioVoice({ CallSid: "CA_long", From: "+13125550168", CallStatus: "completed", CallDuration: "15" }), A);
  assert.equal(long.status, "created_job");
  const jv = repo.getJobView(db, long.job_id);
  assert.deepEqual([jv.source, jv.source_detail, jv.problem], ["call", "answered", null]);
  assert.equal(cardFor(jv, ctxAt(db, A)).reason, "New - call today 7:00am - what was it about?");
  assert.equal(repo.unlinkedMessageCount(db), 0);
});

test("an ignored callback does not block a later callback for the same call", () => {
  const db = freshDb();
  ingestAt(db, fromTwilioVoice({ CallSid: "CA_seq", From: "+13125550164", CallStatus: "in-progress" }), A);
  const vm = ingestAt(db, fromTwilioVoice({ CallSid: "CA_seq", From: "+13125550164", CallStatus: "completed",
    RecordingUrl: "https://example.test/rec" }), A);
  assert.equal(vm.status, "created_job");
  assert.equal(repo.getJobRow(db, vm.job_id).source_detail, "voicemail");
});

test("voice: a transcription for the same CallSid updates the message, fills the problem and raises urgency", () => {
  const db = freshDb();
  const sid = "CA_carla";
  const first = ingestAt(db, fromTwilioVoice({ CallSid: sid, From: "+13125550164", CallStatus: "completed",
    RecordingUrl: "https://example.test/rec" }), A);
  assert.equal(first.status, "created_job");
  assert.equal(repo.getMessage(db, first.message_id).body, VOICEMAIL_PLACEHOLDER);
  assert.equal(repo.getJobRow(db, first.job_id).problem, null);

  const transcript = "Hey it's Carla from Westside Diner, our ice machine is leaking all over the kitchen floor. Call me back at 312-555-0164.";
  const later = at("2026-10-05", "07:02");
  const second = ingestAt(db, fromTwilioVoice({ CallSid: sid, From: "+13125550164", TranscriptionStatus: "completed",
    TranscriptionText: transcript }), later);
  assert.deepEqual([second.status, second.job_id, second.message_id, second.updated],
    ["duplicate", first.job_id, first.message_id, true]);
  assert.equal(count(db, "messages"), 1);
  assert.equal(count(db, "jobs"), 1);
  assert.equal(repo.getMessage(db, first.message_id).body, transcript);
  const jv = repo.getJobView(db, first.job_id);
  assert.deepEqual(
    [jv.problem, jv.equipment, jv.urgent, jv.urgent_source, jv.source_detail],
    ["Ice machine is leaking all over the kitchen floor", "ice_machine", 1, "rules", "voicemail"],
  );
  assert.deepEqual([jv.customer.contact_name, jv.customer.business_name], ["Carla", "Westside Diner"]);
});

test("voice: a voicemail after a missed-call callback turns the job into a voicemail", () => {
  const db = freshDb();
  const missed = ingestAt(db, fromTwilioVoice({ CallSid: "CA_m", From: "+13125550177", CallStatus: "no-answer" }), A);
  assert.equal(repo.getJobRow(db, missed.job_id).source_detail, "missed");
  ingestAt(db, fromTwilioVoice({ CallSid: "CA_m", From: "+13125550177", TranscriptionText: "Walk-in cooler is down, call me" }), A);
  const job = repo.getJobRow(db, missed.job_id);
  assert.deepEqual([job.source_detail, job.problem, job.urgent], ["voicemail", "Walk-in cooler is down, call me", 1]);
});

// ---------------------------------------------------------------------------
// Web forms

test("forms without an id dedupe on a content hash within 10 minutes", () => {
  const db = freshDb();
  const payload = { name: "Priya Shah", phone: "(312) 555-0133", message: "Deli ice machine is making half the ice" };
  const first = ingestAt(db, fromForm(payload), at("2026-10-05", "06:02"));
  const again = ingestAt(db, fromForm(payload), at("2026-10-05", "06:08"));
  assert.equal(first.status, "created_job");
  assert.deepEqual([again.status, again.job_id], ["duplicate", first.job_id]);
  assert.match(repo.getMessage(db, first.message_id).external_id, /^[0-9a-f]{40}$/);
});

// ---------------------------------------------------------------------------
// AI refine (§7.1 step 9, §8.5)

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const MARCO_TEXT = "hi this is marco at bella cucina, the walk-in is making a weird noise";
const MARCO_AI = {
  contact_name: "Marco", business_name: "Bella Cucina", phone: "+13125559999", email: null,
  address: "1820 N Halsted St", equipment: "walk_in_freezer", summary: "Walk-in making weird noise",
  details: "Customer hears a weird noise from the walk-in.", urgency: "emergency", urgency_reason: "noise",
  is_service_request: true, parsed_by: "ai",
};

test("AI refine runs in the background, applies grounded values, and never overwrites what Denise edited", async () => {
  const db = freshDb();
  const ai = deferred();
  const calls = [];
  const extract = (text, meta) => {
    calls.push({ text, meta });
    return ai.promise;
  };
  const r = ingest(db, { ...sms("+13125550142", MARCO_TEXT, "SM_ai"), received_at: A }, { now: A, extract });
  assert.equal(r.status, "created_job");
  assert.ok(r.refine instanceof Promise);
  assert.deepEqual(calls, [{ text: MARCO_TEXT, meta: { channel: "sms", from: "+13125550142" } }]);
  const rulesJob = repo.getJobView(db, r.job_id);
  assert.deepEqual([rulesJob.problem, rulesJob.urgent, rulesJob.customer.contact_name], ["Walk-in is making a weird noise", 0, null]);

  // Denise edits the problem and the business name while the AI is still reading.
  repo.updateJob(db, r.job_id, { problem: "Walk-in compressor noise", updated_at: A });
  repo.updateCustomer(db, rulesJob.customer_id, { business_name: "Bella Cucina Ristorante" }, A);

  ai.resolve(MARCO_AI);
  assert.deepEqual(await r.refine, { changed: ["contact_name", "details", "urgent"] });
  const jv = repo.getJobView(db, r.job_id);
  assert.equal(jv.problem, "Walk-in compressor noise"); // Denise's edit kept
  assert.equal(jv.customer.business_name, "Bella Cucina Ristorante"); // Denise's edit kept
  assert.equal(jv.customer.contact_name, "Marco"); // grounded, was blank
  assert.equal(jv.customer.phone, "+13125550142"); // SMS sender beats the AI phone
  assert.equal(jv.customer.address, null); // not in the text: dropped
  assert.equal(jv.equipment, "walk_in_cooler"); // rules found equipment: AI ignored
  assert.equal(jv.details, "Customer hears a weird noise from the walk-in.");
  assert.deepEqual([jv.urgent, jv.urgent_source, jv.parsed_by], [1, "ai", "ai"]);
  const [refined] = repo.listEvents(db, r.job_id);
  assert.deepEqual([refined.kind, refined.actor, refined.summary], ["ai_refined", "system", "Details read by AI: name, details, urgent"]);
  const msg = repo.getMessage(db, r.message_id);
  assert.equal(msg.parse.ai.summary, "Walk-in making weird noise");
  assert.equal(msg.parse.merged.phone, "+13125550142");
});

test("AI refine: without edits it updates the problem; a spam flag only marks ai_not_service", async () => {
  const db = freshDb();
  const r = ingest(db, { ...sms("+13125550142", MARCO_TEXT), received_at: A },
    { now: A, extract: async () => ({ ...MARCO_AI, is_service_request: false, urgency: "routine" }) });
  assert.deepEqual(await r.refine, { changed: ["contact_name", "business_name", "problem", "details", "ai_not_service"] });
  const jv = repo.getJobView(db, r.job_id);
  assert.deepEqual([jv.problem, jv.stage, jv.ai_not_service, jv.urgent], ["Walk-in making weird noise", "new", 1, 0]);
  assert.equal(repo.listEvents(db, r.job_id)[0].summary, "Details read by AI: name, problem, details, not a job?");
  assert.equal(outcomesFor(jv, { suggestion: "not_a_job", now: A, tz: TZ })[0].label, "Not a job?");
});

test("AI refine never touches a repeat customer's existing values", async () => {
  const db = freshDb();
  const customer = repo.createCustomer(db, { business_name: "Rosa's Taqueria", contact_name: "Rosa Medina", phone: "+13125550118" }, A);
  // The rules read "Rosa's Taqueria" here too, so only the "held a value before" rule protects it.
  const r = ingest(db, { ...sms("+13125550118", "Rosa from Rosa's Taqueria. The ice machine is leaking."), received_at: A },
    { now: A, extract: async () => ({ ...MARCO_AI, contact_name: "Rosa", business_name: "Rosa's", summary: "Ice machine leaking" }) });
  assert.equal(repo.getMessage(db, r.message_id).parse.rules.business_name, "Rosa's Taqueria");
  assert.deepEqual(await r.refine, { changed: ["problem", "details"] });
  const after = repo.getCustomer(db, customer.id);
  assert.deepEqual([after.business_name, after.contact_name], ["Rosa's Taqueria", "Rosa Medina"]);
});

test("AI refine never throws, and is skipped with ai:false", async () => {
  const db = freshDb();
  const warn = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args.join(" "));
  try {
    const failing = ingest(db, { ...sms("+13125550142", MARCO_TEXT), received_at: A },
      { now: A, extract: async () => { throw new Error(`secret body ${MARCO_TEXT}`); } });
    assert.deepEqual(await failing.refine, { changed: [], error: true });
    assert.ok(logged.length === 1 && !logged[0].includes("marco"), "logs never include message bodies");
  } finally {
    console.warn = warn;
  }
  const empty = ingest(db, { ...sms("+13125550143", MARCO_TEXT), received_at: A }, { now: A, extract: async () => null });
  assert.deepEqual(await empty.refine, { changed: [] });
  const off = ingest(db, { ...sms("+13125550144", MARCO_TEXT), received_at: A }, { now: A, ai: false, extract: async () => MARCO_AI });
  assert.equal(off.refine, null);
  assert.equal(get(db, "SELECT count(*) AS n FROM events WHERE kind = 'ai_refined'").n, 0);
});

// ---------------------------------------------------------------------------
// Automatic acknowledgement (§7.4)

const ACK_TEXT = "Hi, it's Denise at Frostline Refrigeration. Got your message - I'll call you back as soon as I can.";

test("auto-ack: off by default", () => {
  const db = freshDb();
  ingestAt(db, sms("+13125550166", "walk-in is warm"), A);
  assert.equal(count(db, "outbox"), 0);
});

test("auto-ack: when on, one simulated text per number per 12 hours, never for forwarded texts", () => {
  const db = freshDb({ auto_ack_enabled: true });
  const t0 = at("2026-10-05", "06:30"); // 11:30Z, in the 00-12 UTC block
  const first = ingestAt(db, sms("+13125550166", "walk-in is warm"), t0);
  assert.deepEqual(
    all(db, "SELECT kind, to_phone, body, job_id, dedupe_key, status, created_at FROM outbox"),
    [{ kind: "auto_ack", to_phone: "+13125550166", body: ACK_TEXT, job_id: first.job_id,
      dedupe_key: "ack:+13125550166:2026-10-05T00", status: "simulated", created_at: t0 }],
  );
  // One hour later is a new 12-hour block but still inside 12 hours: no second ack.
  const closeAndText = (when) => {
    const open = repo.openJobsForCustomer(db, first.customer_id)[0];
    outcome(db, open.id, "not_a_job", {}, when);
    return ingestAt(db, sms("+13125550166", "hello?"), when);
  };
  assert.equal(closeAndText(at("2026-10-05", "07:30")).status, "created_job");
  assert.equal(count(db, "outbox"), 1);
  ingestAt(db, sms("+13125550100", "Fwd: From Gus (312) 555-0174: need a price on a door"), A);
  ingestAt(db, fromTwilioVoice({ CallSid: "CA_ans", From: "+13125550168", CallStatus: "completed", CallDuration: "60" }), A);
  assert.equal(count(db, "outbox"), 1);
  // More than 12 hours after the first: acknowledged again.
  closeAndText(at("2026-10-05", "18:31"));
  assert.deepEqual(all(db, "SELECT dedupe_key FROM outbox ORDER BY id").map((r) => r.dedupe_key),
    ["ack:+13125550166:2026-10-05T00", "ack:+13125550166:2026-10-05T12"]);
});

test("auto-ack: goes through opts.send when given", async () => {
  const db = freshDb({ auto_ack_enabled: true });
  const sent = [];
  const r = ingestAt(db, fromTwilioVoice({ CallSid: "CA_x", From: "+13125550177", CallStatus: "no-answer" }), A,
    { send: async (msg) => { sent.push(msg); } });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(sent, [{ to_phone: "+13125550177", to_name: null, kind: "auto_ack", body: ACK_TEXT,
    job_id: r.job_id, dedupe_key: "ack:+13125550177:2026-10-05T12" }]);
  assert.equal(count(db, "outbox"), 0);
});

// ---------------------------------------------------------------------------
// Quick Add (ingestManual) and Brain dump (ingestBulk)

test("Quick Add: the demo text becomes an urgent job with a 'manual' message holding the original text", () => {
  const db = freshDb();
  const text = "Dave's Deli 312-555-0193 reach-in not cooling, wants someone today";
  const r = ingestManual(db, { text }, { now: A });
  assert.equal(r.status, "created_job");
  assert.equal(r.matched_customer, false);
  const jv = repo.getJobView(db, r.job_id);
  assert.deepEqual(
    [jv.customer.business_name, jv.customer.phone, jv.equipment, jv.urgent, jv.urgent_source, jv.problem, jv.source, jv.parsed_by],
    ["Dave's Deli", "+13125550193", "reach_in", 1, "rules", "Reach-in not cooling, wants someone today", "manual", "rules"],
  );
  assert.equal(bucketFor(jv, ctxAt(db, A)), "emergency");
  const msg = repo.getMessage(db, r.message_id);
  assert.deepEqual([msg.channel, msg.provider, msg.body, msg.status, msg.job_id], ["manual", "app", text, "created_job", r.job_id]);
  const [created] = repo.listEvents(db, r.job_id);
  assert.deepEqual([created.actor, created.summary], ["denise", "Added by you"]);
});

test("Quick Add: minimal input, field edits and the 'who, phone or problem' validation", () => {
  const db = freshDb();
  const minimal = ingestManual(db, { text: "555-444-1212 ice machine leaking" }, { now: A });
  assert.equal(bucketFor(repo.getJobView(db, minimal.job_id), ctxAt(db, A)), "emergency");

  const edited = ingestManual(db, { text: "Joe 312-555-0161 walk-in", fields: { problem: "Walk-in door won't close", urgent: false } }, { now: A });
  const job = repo.getJobRow(db, edited.job_id);
  assert.deepEqual([job.problem, job.urgent, job.urgent_source], ["Walk-in door won't close", 0, null]);

  const messages = count(db, "messages");
  assert.throws(() => ingestManual(db, { text: "", fields: { contact_name: "", phone: "" } }, { now: A }),
    (err) => err instanceof IngestError && err.code === "validation" && err.message === VALIDATION_MESSAGE);
  assert.equal(VALIDATION_MESSAGE, "Add a name, a phone number, or what's wrong.");
  assert.equal(count(db, "messages"), messages);
});

test("Quick Add: starting stages go through enterStage; her moves are due now", () => {
  const db = freshDb();
  const ctx = ctxAt(db, A);
  const quote = ingestManual(db, { text: "Harbor Grill reach-in needs a quote 312-555-0125", stage: "quote" }, { now: A });
  const qjob = repo.getJobView(db, quote.job_id);
  assert.deepEqual([qjob.stage, qjob.next_due_at, bucketFor(qjob, ctx)], ["quote", A, "quote"]);
  assert.equal(repo.listEvents(db, quote.job_id)[0].summary, "Added by you - Waiting on quote");

  const yes = ingestManual(db, { text: "Fresh Mart ice machine", stage: "to_schedule", tech: "Dee" }, { now: A });
  const yjob = repo.getJobView(db, yes.job_id);
  assert.deepEqual([yjob.stage, yjob.next_due_at, yjob.won_at, yjob.tech, bucketFor(yjob, ctx)], ["to_schedule", A, A, "Dee", "to_schedule"]);

  const sent = ingestManual(db, { text: "Joe's Diner walk-in", stage: "waiting_yes", quote_amount: "1,800" }, { now: A });
  const sjob = repo.getJobRow(db, sent.job_id);
  assert.deepEqual([sjob.stage, sjob.quote_amount, sjob.quote_sent_at, sjob.next_due_at],
    ["waiting_yes", 1800, A, startOfDay("2026-10-07", TZ)]);

  const booked = ingestManual(db, { text: "Sal's Pizza prep table", stage: "scheduled", visit_date: "2026-10-08", tech: "Luis" }, { now: A });
  const bjob = repo.getJobRow(db, booked.job_id);
  assert.deepEqual([bjob.stage, bjob.visit_date, bjob.tech, bjob.next_due_at], ["scheduled", "2026-10-08", "Luis", startOfDay("2026-10-09", TZ)]);

  const snoozed = ingestManual(db, { text: "Golden Wok ice machine, call back thursday", snooze_until: "2026-10-08" }, { now: A });
  const zjob = repo.getJobRow(db, snoozed.job_id);
  assert.deepEqual([zjob.stage, zjob.snoozed_until, zjob.next_due_at], ["new", startOfDay("2026-10-08", TZ), startOfDay("2026-10-08", TZ)]);

  assert.throws(() => ingestManual(db, { text: "Sal's Pizza", stage: "scheduled" }, { now: A }),
    (err) => err instanceof OutcomeError && err.code === "missing_arg");
  assert.throws(() => ingestManual(db, { text: "Sal's Pizza", snooze_until: "2026-10-05" }, { now: A }),
    (err) => err instanceof OutcomeError && err.code === "missing_arg");
  assert.throws(() => ingestManual(db, { text: "Sal's Pizza", stage: "done" }, { now: A }),
    (err) => err instanceof IngestError && err.code === "validation");
});

test("Quick Add: an existing customer gets a new job (never attached), matched_customer true, blanks filled", () => {
  const db = freshDb();
  const jobId = rosaWaitingYes(db);
  const r = ingestManual(db, { text: "Rosa's Taqueria 312-555-0118 ice machine cleaning", fields: { address: "3540 W 26th St" } }, { now: A });
  assert.equal(r.status, "created_job");
  assert.equal(r.matched_customer, true);
  assert.notEqual(r.job_id, jobId);
  assert.equal(repo.getJobRow(db, jobId).unread_inbound_at, null);
  assert.equal(repo.getCustomer(db, r.customer_id).address, "3540 W 26th St");
});

test("Brain dump: notebook rows B1-B5 become jobs at their parsed stages", () => {
  const db = freshDb();
  const settings = repo.getSettings(db);
  const rows = parseNotebook([
    "Joe's Diner walk-in, quoted 1800 tues, waiting",
    "Fresh Mart ice machine needs scheduling",
    "Harbor Grill reach-in needs a quote 312-555-0125",
    "Sal's Pizza prep table scheduled thu with Luis",
    "Lakeview brewing called about keg cooler, call back",
  ].join("\n"), { now: A, tz: TZ, settings });
  const { created, errors } = ingestBulk(db, rows, { now: A });
  assert.deepEqual(errors, []);
  assert.equal(created.length, 5);
  const jobs = created.map((id) => repo.getJobView(db, id));
  assert.deepEqual(jobs.map((j) => j.stage), ["waiting_yes", "to_schedule", "quote", "scheduled", "new"]);
  assert.deepEqual([jobs[0].quote_amount, jobs[0].quote_sent_at, jobs[0].customer.business_name],
    [1800, "2026-09-29T17:00:00.000Z", "Joe's Diner"]);
  assert.equal(jobs[2].customer.phone, "+13125550125");
  assert.deepEqual([jobs[3].visit_date, jobs[3].tech], ["2026-10-08", "Luis"]);
  assert.ok(jobs.every((j) => j.source === "bulk"));
  const ctx = ctxAt(db, A);
  assert.deepEqual(jobs.map((j) => bucketFor(j, ctx)), ["nudge", "to_schedule", "quote", null, "new"]);
  assert.equal(repo.listEvents(db, created[1])[0].summary, "Added from your notebook - Said yes - needs scheduling");
  assert.deepEqual(all(db, "SELECT DISTINCT channel, status FROM messages"), [{ channel: "bulk", status: "created_job" }]);
});

test("Brain dump: a scheduled row without a day becomes to_schedule; an empty row's line becomes the problem", () => {
  const db = freshDb();
  const { created } = ingestBulk(db, [
    { line: "Golden Wok booked", fields: { business_name: "Golden Wok" }, stage: "scheduled", visit_date: null },
    { line: "remember the thing on 18th", fields: {}, stage: "new" },
  ], { now: A });
  assert.equal(repo.getJobRow(db, created[0]).stage, "to_schedule");
  assert.equal(repo.getJobRow(db, created[1]).problem, "remember the thing on 18th");
});

test("invariant: every job ingest creates is open with a next date, and every message is linked or explained", () => {
  const db = freshDb();
  rosaWaitingYes(db);
  midwayQuote(db);
  ingestAt(db, sms("+13125550100", "Fwd: who is this"), A);
  ingestManual(db, { text: "quote for PM cleaning next month" }, { now: A });
  for (const job of all(db, "SELECT stage, next_due_at FROM jobs")) {
    assert.equal(["done", "lost"].includes(job.stage), job.next_due_at == null);
  }
  assert.equal(repo.unlinkedMessageCount(db), 0);
});
