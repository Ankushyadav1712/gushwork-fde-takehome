// The HTTP API (SPEC §13.5) against a real server on port 0 and a ':memory:' database:
// outcomes, stage moves, undo (T12), edits, Quick Add, Brain dump, parse, settings, CSV, numbers page
// (R15), passcode and token guards (T21), the simulator, speed (R25) and the startup log (T20).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, all, get } from "../server/db.js";
import * as repo from "../server/repo.js";
import * as clock from "../server/clock.js";
import { createApp } from "../server/app.js";
import { seedDemo } from "../server/seed.js";
import { ingest, ingestManual } from "../server/ingest.js";
import { twilioSignature } from "../server/adapters.js";
import { addMinutes } from "../shared/time.js";
import { messagesOf, outboxRow } from "./fixtures/history.js";

process.env.AI_PARSING = "off";
const A = "2026-10-05T12:00:00.000Z"; // Mon Oct 5 2026 07:00 America/Chicago
const servers = [];
after(() => {
  for (const s of servers) s.close();
  clock.setNow(null);
});

/** A seeded (or empty) database behind createApp, listening on port 0. */
async function start({ env = {}, now = () => A, seed = true, extract, twilioFetch, publicUrl } = {}) {
  const db = openDb(":memory:");
  if (seed) seedDemo(db, { anchor: A, env: {} });
  else repo.ensureSettings(db);
  const app = createApp({ db, now, env, extract, fetch: twilioFetch, publicUrl });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, text, json: type.includes("json") && text ? JSON.parse(text) : null };
  };
  return {
    db, base, call,
    get: (path, headers) => call("GET", path, undefined, headers),
    post: (path, body = {}, headers) => call("POST", path, body, headers),
    patch: (path, body, headers) => call("PATCH", path, body, headers),
    put: (path, body, headers) => call("PUT", path, body, headers),
  };
}

const errorOf = (res) => [res.status, res.json?.error?.code];
const cards = (today) => today.sections.flatMap((s) => s.items);
const TWILIO_ENV = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "authtok", TWILIO_FROM: "+13125550105" };

/** A Twilio Messages API stand-in that answers every send with one status. */
function twilioAnswering(status, body = {}) {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Outcomes, stage moves, undo

test("outcome happy path: Booked it -> Today -> Luis (the demo script)", async () => {
  const api = await start();
  const res = await api.post("/api/jobs/16/outcome", { outcome: "yes", visit_date: "2026-10-05", tech: "Luis", expected_stage: "new" });
  assert.equal(res.status, 200);
  assert.equal(res.json.toast, "Booked for today with Luis. I'll ask if it got done tomorrow.");
  assert.equal(res.json.today_count, 9);
  assert.equal(res.json.on_today, false);
  assert.equal(typeof res.json.event_id, "number");
  assert.equal(res.json.job.stage, "scheduled");
  assert.equal(res.json.job.stage_label, "Scheduled");
  assert.equal(res.json.job.visit_date, "2026-10-05");
  assert.equal(res.json.job.tech, "Luis");
  assert.equal(res.json.job.first_touch_at, A);
  assert.equal(res.json.job.back_on_list, "Tomorrow");
  assert.equal(res.json.job.bucket, null);
  const event = repo.getEvent(api.db, res.json.event_id);
  assert.equal(event.kind, "outcome");
  assert.equal(event.actor, "denise");
  assert.equal(event.summary, "Booked for Mon with Luis");
  assert.equal(event.prev.stage, "new");
  assert.equal(event.prev.next_due_at, "2026-10-02T21:47:00.000Z");
  const today = (await api.get("/api/today")).json;
  assert.equal(today.header, "9 people to call");
  assert.ok(!cards(today).some((c) => c.job_id === 16));
});

test("outcome errors: 422 invalid_outcome / missing_arg, 409 stale_stage, 404 not_found", async () => {
  const api = await start();
  assert.deepEqual(errorOf(await api.post("/api/jobs/16/outcome", { outcome: "done" })), [422, "invalid_outcome"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/16/outcome", {})), [422, "invalid_outcome"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/13/outcome", { outcome: "scheduled" })), [422, "missing_arg"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/9/outcome", { outcome: "snooze", snooze_until: "2026-10-05" })), [422, "missing_arg"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/16/outcome", { outcome: "no_answer", expected_stage: "quote" })), [409, "stale_stage"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/999/outcome", { outcome: "no_answer" })), [404, "not_found"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/abc/outcome", { outcome: "no_answer" })), [404, "not_found"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/1/outcome", { outcome: "lost" })), [422, "invalid_outcome"]);
  assert.equal(get(api.db, "SELECT count(*) AS n FROM events WHERE kind = 'outcome' AND at = ?", [A]).n, 0, "nothing written");
});

test("regression: impossible calendar dates are refused everywhere a day is picked", async () => {
  const api = await start();
  assert.deepEqual(errorOf(await api.post("/api/jobs/16/outcome", { outcome: "yes", visit_date: "2026-13-45" })), [422, "missing_arg"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/13/outcome", { outcome: "scheduled", visit_date: "2026-02-30" })), [422, "missing_arg"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/11/outcome", { outcome: "snooze", snooze_until: "2026-10-32" })), [422, "missing_arg"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/14/stage", { to: "scheduled", visit_date: "2026-11-31" })), [422, "missing_arg"]);
  assert.deepEqual(errorOf(await api.patch("/api/jobs/10", { visit_date: "2026-02-29" })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs", { fields: { problem: "Ice machine" }, stage: "scheduled", visit_date: "2026-02-30" })), [422, "missing_arg"]);
  assert.equal(get(api.db, "SELECT count(*) AS n FROM jobs WHERE visit_date IS NOT NULL AND date(visit_date) IS NOT visit_date").n, 0);
});

test("Seen it clears the reply and says when the job is back; a seen event keeps prev_json", async () => {
  const api = await start();
  const res = await api.post("/api/jobs/8/outcome", { outcome: "seen", expected_stage: "scheduled" });
  assert.equal(res.status, 200);
  assert.equal(res.json.toast, "Marked as seen. Back on your list Wed.", "the check after Tuesday's visit");
  assert.equal(res.json.on_today, false);
  assert.equal(res.json.job.unread_inbound_at, null);
  assert.equal(res.json.today_count, 9);
  const event = repo.getEvent(api.db, res.json.event_id);
  assert.equal(event.kind, "seen");
  assert.equal(event.prev.unread_inbound_at, "2026-10-04T23:05:00.000Z");
});

test("Not a job with block blocks the number; undo unblocks it", async () => {
  const api = await start();
  const res = await api.post("/api/jobs/17/outcome", { outcome: "not_a_job", block: true });
  assert.equal(res.json.toast, "Removed - not a job.");
  assert.equal(res.json.job.stage, "lost");
  assert.equal(res.json.job.lost_reason, "not_a_job");
  const detail = (await api.get("/api/jobs/17")).json;
  assert.equal(detail.customer.blocked, 1);
  assert.deepEqual(detail.outcomes, []);
  const undo = await api.post("/api/jobs/17/undo", { event_id: res.json.event_id });
  assert.equal(undo.status, 200);
  assert.equal(undo.json.job.stage, "new");
  assert.equal(undo.json.today_count, 10);
  assert.equal(repo.getCustomer(api.db, undo.json.job.customer_id).blocked, 0);
});

test("T12 undo through the API: quote_sent then undo leaves the row identical; second undo and late undo are 409", async () => {
  let now = A;
  const api = await start({ now: () => now });
  const before = repo.getJobRow(api.db, 11);
  const sent = await api.post("/api/jobs/11/outcome", { outcome: "quote_sent", amount: 900, expected_stage: "quote" });
  assert.equal(sent.json.toast, "Quote sent ($900). I'll remind you Wed if no answer.");
  assert.equal(sent.json.job.stage, "waiting_yes");
  assert.equal(sent.json.today_count, 9);
  now = addMinutes(A, 9);
  const undone = await api.post("/api/jobs/11/undo", { event_id: sent.json.event_id });
  assert.equal(undone.status, 200);
  assert.deepEqual(repo.getJobRow(api.db, 11), before);
  assert.equal(undone.json.job.stage, "quote");
  assert.equal(undone.json.today_count, 10);
  assert.equal(repo.getEvent(api.db, sent.json.event_id).undone, 1);
  const undoEvent = repo.latestStateEvent(api.db, 11);
  assert.equal(undoEvent.kind, "undo");
  assert.equal(undoEvent.summary, "Undid: Quote sent - $900");
  assert.deepEqual(errorOf(await api.post("/api/jobs/11/undo", { event_id: sent.json.event_id })), [409, "undo_not_allowed"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/11/undo", { event_id: undoEvent.id })), [409, "undo_not_allowed"]);

  const again = await api.post("/api/jobs/11/outcome", { outcome: "quote_sent", amount: 900 });
  now = addMinutes(now, 10);
  assert.deepEqual(errorOf(await api.post("/api/jobs/11/undo", { event_id: again.json.event_id })), [409, "undo_not_allowed"]);
  assert.equal(repo.getJobRow(api.db, 11).stage, "waiting_yes");
});

test("undo: only the latest state-changing event; taps and reminders don't count; 404 for a missing job", async () => {
  const api = await start();
  const first = await api.post("/api/jobs/14/outcome", { outcome: "quote_sent" });
  const second = await api.post("/api/jobs/14/outcome", { outcome: "still_thinking" });
  assert.equal(second.json.toast, "Got it. Back on your list Wed.");
  assert.deepEqual(errorOf(await api.post("/api/jobs/14/undo", { event_id: first.json.event_id })), [409, "undo_not_allowed"]);
  assert.equal((await api.post("/api/jobs/14/tap", { kind: "call" })).status, 204);
  assert.equal((await api.post("/api/jobs/14/undo", { event_id: second.json.event_id })).status, 200);
  assert.equal(repo.getJobRow(api.db, 14).stage, "waiting_yes");
  assert.deepEqual(errorOf(await api.post("/api/jobs/13/undo", { event_id: first.json.event_id })), [409, "undo_not_allowed"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/999/undo", { event_id: 1 })), [404, "not_found"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/14/undo", {})), [409, "undo_not_allowed"]);
});

test("stage moves: enterStage, not contact; Bring back; errors", async () => {
  const api = await start();
  const moved = await api.post("/api/jobs/14/stage", { to: "waiting_yes", amount: 3200 });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.toast, "Moved to Waiting on their yes.");
  assert.equal(moved.json.job.stage, "waiting_yes");
  assert.equal(moved.json.job.quote_amount, 3200);
  assert.equal(moved.json.job.last_touch_at, "2026-10-01T16:00:00.000Z", "a stage move is not contact");
  assert.equal(moved.json.today_count, 9);
  const event = repo.getEvent(api.db, moved.json.event_id);
  assert.deepEqual([event.kind, event.summary, event.prev.stage], ["stage", "Moved to Waiting on their yes", "quote"]);

  const back = await api.post("/api/jobs/4/stage", { to: "new" });
  assert.equal(back.json.toast, "Moved to New - call them back.");
  assert.equal(back.json.on_today, true);
  assert.equal(back.json.job.lost_reason, null);
  assert.equal(repo.getEvent(api.db, back.json.event_id).summary, "Brought back");

  assert.deepEqual(errorOf(await api.post("/api/jobs/15/stage", { to: "scheduled" })), [422, "missing_arg"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/15/stage", { to: "quote" })), [422, "invalid_outcome"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/15/stage", { to: "bogus" })), [422, "invalid_outcome"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/15/stage", { to: "new", expected_stage: "new" })), [409, "stale_stage"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/404/stage", { to: "new" })), [404, "not_found"]);
  const scheduled = await api.post("/api/jobs/15/stage", { to: "scheduled", visit_date: "2026-10-08", tech: "Dee" });
  assert.equal(scheduled.json.job.next_due_at, "2026-10-09T05:00:00.000Z");
});

test("regression RT-2 (C7): 'Needs a quote for more work' closes the visit and opens a new quote job", async () => {
  const api = await start();
  const before = (await api.get("/api/numbers")).json;
  const res = await api.post("/api/jobs/10/outcome", { outcome: "need_quote", expected_stage: "scheduled" });
  assert.equal(res.status, 200);
  assert.equal(res.json.toast, "Marked done. The extra work is a new job waiting on your quote.");
  assert.deepEqual([res.json.job.stage, res.json.spawned_job_id], ["done", 19]);
  const extra = (await api.get("/api/jobs/19")).json;
  assert.deepEqual([extra.job.stage, extra.job.title, extra.job.problem, extra.job.source_label, extra.job.customer_id],
    ["quote", "Sal's Pizza", "More work: Prep table cooler fan grinding", "Added by you", res.json.job.customer_id]);
  assert.deepEqual(extra.timeline.map((t) => [t.kind, t.summary]), [["created", "Extra work found at the Fri visit"]]);
  assert.equal((await api.post("/api/jobs/19/outcome", { outcome: "quote_sent", amount: 2400 })).status, 200);
  const after = (await api.get("/api/numbers")).json;
  assert.deepEqual([after.waiting_yes_total, after.won_30d_count, after.won_30d_total, after.done_7d_count],
    [before.waiting_yes_total + 2400, before.won_30d_count, before.won_30d_total, before.done_7d_count + 1]);
  assert.equal((await api.post("/api/jobs/16/outcome", { outcome: "no_answer" })).json.spawned_job_id, null);
});

test("C7 undo of 'more work' restores the visit and removes the new job, unless she has worked on it", async () => {
  const api = await start();
  const visit = repo.getJobRow(api.db, 10);
  const first = await api.post("/api/jobs/10/outcome", { outcome: "need_quote" });
  assert.equal((await api.post("/api/jobs/10/undo", { event_id: first.json.event_id })).status, 200);
  assert.deepEqual(repo.getJobRow(api.db, 10), { ...visit, updated_at: repo.getJobRow(api.db, 10).updated_at });
  assert.equal(repo.getJobRow(api.db, first.json.spawned_job_id), null);
  assert.equal(get(api.db, "SELECT count(*) AS n FROM events WHERE job_id = ?", [first.json.spawned_job_id]).n, 0);

  const again = await api.post("/api/jobs/10/outcome", { outcome: "need_quote" });
  await api.post(`/api/jobs/${again.json.spawned_job_id}/outcome`, { outcome: "quote_sent", amount: 900 });
  assert.equal((await api.post("/api/jobs/10/undo", { event_id: again.json.event_id })).json.job.stage, "scheduled");
  assert.equal(repo.getJobRow(api.db, again.json.spawned_job_id).stage, "waiting_yes", "her quote stays");
});

test("regression CC-4 (C8): undo after a late AI read keeps what the AI read", async () => {
  const api = await start({ seed: false });
  let finishRead;
  const reading = new Promise((resolve) => { finishRead = resolve; });
  const extract = async () => {
    await reading;
    return {
      contact_name: "Dan", business_name: null, phone: null, email: null, address: null, equipment: "walk_in_freezer",
      summary: "Walk-in freezer down, food thawing", details: null, urgency: "emergency", urgency_reason: "food thawing",
      is_service_request: true, parsed_by: "ai",
    };
  };
  const lead = ingest(api.db, {
    channel: "sms", provider: "twilio", external_id: "SMdan", received_at: A, from_phone: "+13125550666",
    body: "hey its dan, deli on main. freezer quit on us",
  }, { now: A, extract });
  assert.equal(repo.getJobRow(api.db, lead.job_id).urgent, 0, "the rules didn't see an emergency");
  const tried = await api.post(`/api/jobs/${lead.job_id}/outcome`, { outcome: "no_answer", expected_stage: "new" });
  finishRead();
  await lead.refine;
  assert.equal(repo.getJobRow(api.db, lead.job_id).urgent, 1);
  const undone = await api.post(`/api/jobs/${lead.job_id}/undo`, { event_id: tried.json.event_id });
  assert.equal(undone.status, 200);
  assert.deepEqual([undone.json.job.urgent, undone.json.job.problem, undone.json.job.attempts, undone.json.job.bucket],
    [1, "Walk-in freezer down, food thawing", 0, "emergency"]);
  assert.deepEqual(repo.getEvent(api.db, tried.json.event_id).data.changed_keys.sort(),
    ["attempts", "first_touch_at", "last_touch_at", "next_due_at"], "only what the outcome changed");
});

test("regression RT-3: a lead wrongly marked Not a job, then moved to Done, counts as done", async () => {
  const api = await start();
  await api.post("/api/jobs/17/outcome", { outcome: "not_a_job" });
  const done = await api.post("/api/jobs/17/stage", { to: "done", amount: 350 });
  assert.deepEqual([done.json.job.stage, done.json.job.lost_reason, done.json.job.lost_reason_label, done.json.job.lost_at],
    ["done", null, null, null]);
  assert.equal((await api.get("/api/numbers")).json.done_7d_count, 2);
});

test("tap logs history only (204), including Text a tech", async () => {
  const api = await start();
  const row = repo.getJobRow(api.db, 16);
  assert.equal((await api.post("/api/jobs/16/tap", { kind: "call" })).status, 204);
  assert.equal((await api.post("/api/jobs/16/tap", { kind: "text" })).status, 204);
  assert.equal((await api.post("/api/jobs/16/tap", { kind: "tech_text", tech: "Luis" })).status, 204);
  assert.deepEqual(repo.getJobRow(api.db, 16), row);
  const timeline = (await api.get("/api/jobs/16")).json.timeline;
  assert.deepEqual(timeline.slice(0, 3).map((t) => [t.kind, t.summary, t.actor]), [
    ["tech_text", "Sent details to Luis", "denise"], ["text_tap", "Tapped Text", "denise"], ["call_tap", "Tapped Call", "denise"],
  ]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/16/tap", { kind: "fax" })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/999/tap", { kind: "call" })), [404, "not_found"]);
});

// ---------------------------------------------------------------------------
// Reading jobs

test("GET /api/jobs: counts, stage filters, closed (30 days), search", async () => {
  const api = await start();
  const open = (await api.get("/api/jobs")).json;
  assert.equal(open.now, A);
  assert.deepEqual(open.counts, { new: 3, quote: 3, waiting_yes: 2, to_schedule: 2, scheduled: 3, open: 13, closed: 3 });
  assert.equal(open.jobs.length, 13);
  assert.deepEqual(open.jobs.slice(0, 4).map((j) => j.id), [11, 14, 13, 16], "soonest due first");
  const bella = open.jobs.find((j) => j.id === 16);
  assert.deepEqual([bella.title, bella.subtitle, bella.source_label, bella.equipment_label, bella.phone_display, bella.address],
    ["Bella Cucina", "Marco Rossi", "Voicemail", "Walk-in freezer", "(312) 555-0142", "1820 N Halsted St"]);
  assert.deepEqual([bella.on_today, bella.bucket, bella.back_on_list], [true, "emergency", null]);
  assert.equal(bella.reason, "Walk-in freezer at 28 degrees and climbing - voicemail Fri 4:47pm, nobody's called back");
  const quote = (await api.get("/api/jobs?stage=quote")).json.jobs;
  assert.deepEqual(quote.map((j) => j.title), ["Midway Meats", "Hillside Grocery", "Lakeview Brewing Co."]);
  const closed = (await api.get("/api/jobs?stage=closed")).json.jobs;
  assert.deepEqual(closed.map((j) => j.id), [6, 4, 3], "last 30 days, newest closed first");
  assert.equal(closed[1].lost_reason_label, "Went with someone else");
  assert.deepEqual((await api.get("/api/jobs?stage=done")).json.jobs.map((j) => j.id), [6, 3]);
  assert.deepEqual((await api.get("/api/jobs?q=midway")).json.jobs.map((j) => j.id), [11]);
  assert.deepEqual((await api.get("/api/jobs?q=0177")).json.jobs.map((j) => j.title), ["(312) 555-0177"]);
  assert.deepEqual((await api.get("/api/jobs?stage=closed&q=seoul")).json.jobs.map((j) => j.id), [4]);
  assert.deepEqual(errorOf(await api.get("/api/jobs?stage=bogus")), [400, "validation"]);
});

test("GET /api/jobs/:id: job, customer, timeline, outcomes, links, past jobs", async () => {
  const api = await start();
  const harbor = (await api.get("/api/jobs/8")).json;
  assert.deepEqual([harbor.job.bucket, harbor.job.on_today, harbor.job.back_on_list], ["replied", true, null]);
  assert.equal(harbor.job.reason, "Texted yesterday 6:05pm: \"Can Mike come Wednesday instead of Tuesday? We're closed…\"");
  assert.deepEqual(harbor.outcomes.map((b) => b.label),
    ["Move to Wednesday?", "Done", "Needs another visit", "Needs a quote for more work", "Seen it", "Not today", "Cancelled"]);
  assert.deepEqual(harbor.timeline.slice(0, 2).map((t) => `${t.at_label} · ${t.summary}`), [
    "Mon 7:00am · In your morning text",
    "Sun 6:05pm · Texted back",
  ]);
  assert.deepEqual(harbor.timeline[1], {
    id: harbor.timeline[1].id, at: "2026-10-04T23:05:00.000Z", at_label: "Sun 6:05pm", actor: "customer", kind: "inbound",
    summary: "Texted back",
    channel: "sms", body: "Can Mike come Wednesday instead of Tuesday? We're closed Tuesdays.", undone: false,
  });
  assert.equal(harbor.tel_link, "tel:+13125550125");
  assert.equal(harbor.sms_link, `sms:+13125550125?&body=${encodeURIComponent("Hi Ana, thanks for your message - I'll get back to you shortly. - Denise")}`);
  assert.equal(harbor.customer.business_name, "Harbor Grill");
  assert.equal(harbor.customer.address, "1120 N State St");

  const maple = (await api.get("/api/jobs/9")).json.job;
  assert.deepEqual([maple.on_today, maple.back_on_list, maple.snoozed_until], [false, "Wed", "2026-10-07T05:00:00.000Z"]);
  const joes = (await api.get("/api/jobs/13")).json;
  assert.deepEqual(joes.past_jobs.map((j) => [j.id, j.title, j.stage]), [[1, "Joe's Diner", "done"]]);
  assert.deepEqual(joes.job.repeat, { past_jobs: 1 });
  const rosa = (await api.get("/api/jobs/7")).json;
  assert.deepEqual(rosa.outcomes.map((b) => b.label), ["They said yes", "Still thinking", "No answer", "Not today", "Lost"]);
  assert.deepEqual(errorOf(await api.get("/api/jobs/999")), [404, "not_found"]);
});

// ---------------------------------------------------------------------------
// Edits

test("PATCH /api/jobs/:id: edits log one event; urgent is manual; validation and conflicts", async () => {
  const api = await start();
  const named = await api.patch("/api/jobs/17", { business_name: "Corner Deli", contact_name: "Sam" });
  assert.equal(named.status, 200);
  assert.equal(named.json.job.title, "Corner Deli");
  assert.equal(named.json.job.subtitle, "Sam");
  assert.equal(repo.getEvent(api.db, named.json.event_id).summary, "Changed business name, contact");

  const urgent = await api.patch("/api/jobs/15", { urgent: true });
  assert.equal(urgent.json.job.urgent, 1);
  assert.equal(urgent.json.job.urgent_source, "manual");
  assert.equal(urgent.json.job.bucket, "emergency");
  const event = repo.getEvent(api.db, urgent.json.event_id);
  assert.deepEqual([event.kind, event.summary, event.prev.urgent], ["edit", "Marked urgent", 0]);
  assert.equal((await api.patch("/api/jobs/15", { urgent: false })).json.job.urgent, 0);

  const phone = await api.patch("/api/jobs/17", { phone: "(312) 555-0199 " });
  assert.deepEqual(errorOf(phone), [409, "duplicate"]);
  assert.equal(phone.json.error.message, "That number already belongs to Hillside Grocery.");
  const ok = await api.patch("/api/jobs/17", { phone: "312.555.0178", email: "Sam@CornerDeli.example", quote_amount: "$1,250", equipment: "reach_in" });
  assert.deepEqual([ok.json.job.phone, ok.json.job.email, ok.json.job.quote_amount, ok.json.job.equipment_label],
    ["+13125550178", "sam@cornerdeli.example", 1250, "Reach-in"]);
  assert.equal(repo.getEvent(api.db, ok.json.event_id).summary, "Changed phone, email, quote amount, equipment");

  const moved = await api.patch("/api/jobs/12", { visit_date: "2026-10-07" });
  assert.equal(moved.json.job.next_due_at, "2026-10-08T05:00:00.000Z");
  assert.deepEqual(errorOf(await api.patch("/api/jobs/12", { visit_date: null })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.patch("/api/jobs/12", { visit_date: "Thursday" })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.patch("/api/jobs/15", { email: "not-an-email" })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.patch("/api/jobs/15", { email: "sam@diner.example?bcc=spy@x.example" })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.patch("/api/jobs/15", { phone: "12345" })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.patch("/api/jobs/15", { equipment: "toaster" })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.patch("/api/jobs/15", { colour: "red" })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.patch("/api/jobs/15", {})), [400, "validation"]);
  assert.deepEqual(errorOf(await api.patch("/api/jobs/999", { notes: "x" })), [404, "not_found"]);
  const same = await api.patch("/api/jobs/15", { problem: "Price on a second walk-in cooler for kegs" });
  assert.equal(same.json.event_id, null, "no change, no event");

  const undo = await api.post("/api/jobs/17/undo", { event_id: ok.json.event_id });
  assert.equal(undo.status, 200);
  const customer = repo.getCustomer(api.db, undo.json.job.customer_id);
  assert.deepEqual([customer.phone, customer.email], ["+13125550177", null]);
  assert.equal(undo.json.job.quote_amount, null);
});

test("regression requirements RT-2: a new phone on a customer with another open job never rewrites that job", async () => {
  const api = await start();
  const first = await api.post("/api/jobs", { text: "Tony's Bistro walk-in freezer at 10F", fields: { phone: "(312) 555-0187" } });
  const second = await api.post("/api/jobs", { text: "Tony's Bistro reach-in not cooling", fields: { phone: "(312) 555-0187" } });
  assert.equal(second.json.customer_id, first.json.customer_id, "the same phone is the same customer");

  const fixed = await api.patch(`/api/jobs/${second.json.job_id}`, { phone: "(312) 555-0186" });
  assert.equal(fixed.status, 200);
  assert.notEqual(fixed.json.job.customer_id, first.json.customer_id, "this job now has its own customer");
  assert.deepEqual([fixed.json.job.title, fixed.json.job.phone], ["Tony's Bistro", "+13125550186"]);
  const other = repo.getJobView(api.db, first.json.job_id);
  assert.deepEqual([other.customer_id, other.customer.phone], [first.json.customer_id, "+13125550187"]);

  const renamed = await api.patch(`/api/jobs/${second.json.job_id}`, { business_name: "Uma's Bakery" });
  assert.equal(renamed.json.job.title, "Uma's Bakery");
  assert.equal(repo.getJobView(api.db, first.json.job_id).customer.business_name, "Tony's Bistro");
});

// ---------------------------------------------------------------------------
// Getting jobs in

test("R04 Quick Add: POST /api/jobs creates an urgent job from one line; validation errors", async () => {
  const api = await start();
  const res = await api.post("/api/jobs", { text: "555-444-1212 ice machine leaking" });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.json).sort(), ["customer_id", "job_id", "matched_customer", "toast"]);
  assert.equal(res.json.toast, "Added. It's on your list.");
  assert.equal(res.json.matched_customer, false);
  assert.equal(res.json.job_id, 19);
  const urgent = (await api.get("/api/today")).json.sections[0];
  assert.equal(urgent.label, "Urgent - call first");
  assert.deepEqual(urgent.items.map((c) => [c.job_id, c.title, c.source_label]), [[16, "Bella Cucina", "Voicemail"], [19, "(555) 444-1212", "Added by you"]]);
  assert.equal(messagesOf(api.db, 19)[0].body, "555-444-1212 ice machine leaking");

  const repeat = await api.post("/api/jobs", { text: "Rosa's ice machine again", fields: { phone: "(312) 555-0118" } });
  assert.equal(repeat.json.matched_customer, true);
  const empty = await api.post("/api/jobs", { text: "   " });
  assert.deepEqual(errorOf(empty), [400, "validation"]);
  assert.equal(empty.json.error.message, "Add a name, a phone number, or what's wrong.");
  assert.deepEqual(errorOf(await api.post("/api/jobs", { text: "Sal's Pizza prep table", stage: "scheduled" })), [422, "missing_arg"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs", { text: "Sal's Pizza prep table", stage: "done" })), [400, "validation"]);
});

test("POST /api/parse: rules, AI (injected), matched customer", async () => {
  const api = await start();
  const dave = await api.post("/api/parse", { text: "Dave's Deli 312-555-0193 reach-in not cooling, wants someone today" });
  assert.equal(dave.json.mode, "rules");
  assert.deepEqual(
    [dave.json.fields.business_name, dave.json.fields.phone, dave.json.fields.equipment, dave.json.fields.urgent, dave.json.fields.problem],
    ["Dave's Deli", "+13125550193", "reach_in", true, "Reach-in not cooling, wants someone today"],
  );
  assert.deepEqual(Object.keys(dave.json.fields), ["contact_name", "business_name", "phone", "email", "address", "equipment", "problem", "details", "urgent"]);
  assert.ok(dave.json.urgent_hits.length > 0);
  assert.equal(dave.json.matched_customer, null);
  const rosa = await api.post("/api/parse", { text: "Rosa called from 312-555-0118 about the cooler again" });
  assert.deepEqual(rosa.json.matched_customer, {
    id: repo.findCustomerByPhone(api.db, "+13125550118").id, title: "Rosa's Taqueria", match: "phone", past_jobs: 1,
    open_job: {
      id: 7, title: "Rosa's Taqueria", stage: "waiting_yes", stage_label: "Waiting on their yes",
      problem: "Walk-in cooler compressor short cycling", quote_amount: 2400,
    },
  });
  const hint = await api.post("/api/parse", { text: "Dave from Hillside Grocery wants a quote on a new ice machine 312-555-0199" });
  assert.equal(hint.json.stage_hint, "quote");
  assert.equal(hint.json.matched_customer.title, "Hillside Grocery");

  const calls = [];
  const ai = await start({
    extract: async (text, meta) => {
      calls.push(meta);
      return {
        contact_name: "Dave", business_name: "Dave's Deli", phone: null, email: null, address: null, equipment: "reach_in",
        summary: "Reach-in not cooling", details: "Wants someone today.", urgency: "emergency", urgency_reason: "not cooling",
        is_service_request: true, parsed_by: "ai",
      };
    },
  });
  const read = await ai.post("/api/parse", { text: "Dave's Deli 312-555-0193 reach-in not cooling, wants someone today" });
  assert.equal(read.json.mode, "ai");
  assert.deepEqual([read.json.fields.contact_name, read.json.fields.problem, read.json.fields.details],
    ["Dave", "Reach-in not cooling", "Wants someone today."]);
  assert.deepEqual(calls, [{ channel: "manual" }]);
  assert.equal((await ai.post("/api/parse", { text: "Dave's Deli reach-in", use_ai: false })).json.mode, "rules");
  const failing = await start({ extract: async () => { throw new Error("model down"); } });
  const fallback = await failing.post("/api/parse", { text: "Dave's Deli reach-in not cooling" });
  assert.deepEqual([fallback.status, fallback.json.mode, fallback.json.fields.business_name], [200, "rules", "Dave's Deli"]);
  assert.equal(calls.length, 1);
  assert.equal((await ai.get("/api/health")).json.ai, "claude");
});

test("C5 previews match a repeat customer by phone, or by email only when no phone was given", async () => {
  const api = await start();
  const byEmail = await api.post("/api/parse", { text: "Nora from the brewery, tbecker@northsidecold.example, freezer fans again" });
  assert.deepEqual([byEmail.json.matched_customer.title, byEmail.json.matched_customer.match, byEmail.json.matched_customer.past_jobs],
    ["Northside Cold Storage", "email", 0]);
  assert.equal(byEmail.json.matched_customer.open_job.id, 5);
  const otherPhone = await api.post("/api/parse", { text: "tbecker@northsidecold.example 312-555-0444 freezer fans" });
  assert.equal(otherPhone.json.matched_customer, null, "a phone that matches nobody is a new customer");
  await api.put("/api/settings", { owner_email: "Denise@Frostline.example" });
  const own = await api.post("/api/parse", { text: "denise@frostline.example ice machine for the new place" });
  assert.equal(own.json.matched_customer, null);
  const joes = await api.post("/api/parse", { text: "Joe's Diner 312-555-0160 gasket again" });
  assert.deepEqual([joes.json.matched_customer.past_jobs, joes.json.matched_customer.open_job.stage], [1, "to_schedule"]);
});

test("C5 Quick Add onto her open job: the text becomes the customer's message on it", async () => {
  const api = await start();
  const res = await api.post("/api/jobs", { text: "Rosa says go ahead with the compressor", attach_to_job_id: 7 });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json, {
    job_id: 7, customer_id: repo.getJobRow(api.db, 7).customer_id, attached: true, toast: "Added to Rosa's Taqueria's open job.",
  });
  assert.equal(get(api.db, "SELECT count(*) AS n FROM jobs").n, 18, "no new job");
  assert.ok(repo.getJobRow(api.db, 7).unread_inbound_at);
  const junk = await api.post("/api/jobs", { fields: { phone: "555-12" } });
  assert.deepEqual(errorOf(junk), [400, "validation"]);
  assert.equal(junk.json.error.message, "Add a name, a phone number, or what's wrong.");
});

test("Quick Add onto an open job: a paste from someone else is 409 attach_mismatch; the toast says Midway Meats' (ux-N1)", async () => {
  const api = await start();
  const midway = repo.getJobRow(api.db, 11).customer_id;
  const attach = (text, expected) => api.post("/api/jobs", { text, attach_to_job_id: 11, expected_customer_id: expected });
  const wrong = await attach("Rosa 312-555-0118: the walk-in is warm again", midway);
  assert.deepEqual([wrong.status, wrong.json.error], [409, {
    code: "attach_mismatch", message: "That text looks like it's from someone else. Add it as a new job instead.",
  }]);
  assert.equal((await attach("Gus here, any update?", midway + 1)).status, 409, "the preview showed another customer");
  const right = await attach("Gus (312) 555-0174: any update on that quote?", midway);
  assert.deepEqual([right.status, right.json.toast], [201, "Added to Midway Meats' open job."]);
});

test("regression RT-4 (C6): a Brain dump backlog is not this week's new, won or done work", async () => {
  const api = await start();
  const before = (await api.get("/api/numbers")).json;
  const lines = ["Corner Deli walk-in noisy", "Bay Cafe said yes on the ice machine", "Hilltop Market reach-in cleaning done"];
  const rows = lines.map((line, i) => ({ line, fields: { business_name: line.split(" ").slice(0, 2).join(" "), problem: line },
    stage: ["new", "to_schedule", "done"][i] }));
  assert.equal((await api.post("/api/bulk", { rows })).status, 201);
  const after = (await api.get("/api/numbers")).json;
  assert.deepEqual([after.new_7d_count, after.won_30d_count, after.done_7d_count],
    [before.new_7d_count, before.won_30d_count, before.done_7d_count]);
  assert.equal((await api.get("/api/today")).json.footer.last24h_text, "Last 24 hours: 1 came in, 1 not called yet");
});

test("R22 Brain dump: /api/bulk/parse reads B1-B5, /api/bulk creates 5 jobs at their stages", async () => {
  const api = await start();
  const text = [
    "Joe's Diner walk-in, quoted 1800 tues, waiting",
    "Fresh Mart ice machine needs scheduling",
    "Harbor Grill reach-in needs a quote 312-555-0125",
    "Sal's Pizza prep table scheduled thu with Luis",
    "Lakeview brewing called about keg cooler, call back",
  ].join("\n");
  const parsed = (await api.post("/api/bulk/parse", { text })).json.rows;
  assert.deepEqual(parsed.map((r) => r.stage), ["waiting_yes", "to_schedule", "quote", "scheduled", "new"]);
  assert.deepEqual([parsed[0].quote_amount, parsed[0].quote_sent_at], [1800, "2026-09-29T17:00:00.000Z"]);
  assert.deepEqual([parsed[3].visit_date, parsed[3].tech], ["2026-10-08", "Luis"]);
  assert.equal(parsed[2].fields.phone, "+13125550125");
  assert.equal(parsed[2].matched_customer.title, "Harbor Grill");
  assert.equal(parsed[0].matched_customer, null);
  const created = await api.post("/api/bulk", { rows: parsed });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json, { created: [19, 20, 21, 22, 23], errors: [] });
  assert.deepEqual(created.json.created.map((id) => repo.getJobRow(api.db, id).stage), ["waiting_yes", "to_schedule", "quote", "scheduled", "new"]);
  const buckets = new Map(cards((await api.get("/api/today")).json).map((c) => [c.job_id, c.bucket]));
  assert.deepEqual([19, 20, 21, 22, 23].map((id) => buckets.get(id) ?? null), ["nudge", "to_schedule", "quote", null, "new"]);
  assert.deepEqual(errorOf(await api.post("/api/bulk", { rows: [] })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.post("/api/bulk", {})), [400, "validation"]);
});

// ---------------------------------------------------------------------------
// Numbers, digest, outbox, messages, settings, CSV

test("digest preview and send; outbox and messages lists", async () => {
  const api = await start();
  const preview = (await api.get("/api/digest/preview")).json;
  assert.equal(preview.now, A);
  assert.equal(preview.digest.send, true);
  assert.equal(preview.digest.body, outboxRow(api.db, "digest:2026-10-05").body);
  assert.equal(preview.sweep, "Before the weekend: 8 people still waiting on you - Bella Cucina, Harbor Grill, (312) 555-0177, +5 more. Open: http://localhost:3000/#/");
  const sent = await api.post("/api/digest/send");
  assert.equal(sent.status, 200);
  const items = (await api.get("/api/outbox?limit=2")).json.items;
  assert.equal(items.length, 2);
  assert.deepEqual(Object.keys(items[0]), ["id", "created_at", "at_label", "kind", "to_phone", "to_name", "body", "status", "job_id"]);
  assert.deepEqual([items[0].id, items[0].kind, items[0].status, items[0].at_label, items[0].body],
    [sent.json.outbox_id, "manual", "simulated", "Mon 7:00am", preview.digest.body]);
  const messages = (await api.get("/api/messages?limit=1")).json.items;
  assert.deepEqual(messages.map((m) => [m.channel, m.provider, m.status, m.job_id, m.from_phone]), [["form", "postmark", "created_job", 18, "+13125550133"]]);
  assert.deepEqual(Object.keys(messages[0]), ["id", "received_at", "channel", "provider", "from_phone", "from_email", "subject", "body", "status", "job_id"]);
  assert.equal((await api.get("/api/messages")).json.items.length, 19);
});

test("regression CC-5 (C10): Send now says what happened to the text; Today flags texts that don't go out", async () => {
  const simulated = await start();
  const ok = await simulated.post("/api/digest/send");
  assert.deepEqual([ok.status, ok.json.status, ok.json.error, typeof ok.json.outbox_id], [200, "simulated", null, "number"]);
  assert.equal((await simulated.get("/api/today")).json.texts_failing, false);

  const refused = await start({ env: TWILIO_ENV, twilioFetch: twilioAnswering(401, { code: 20003, message: "Authenticate" }) });
  const failed = await refused.post("/api/digest/send");
  assert.deepEqual([failed.json.status, failed.json.error], ["failed", "Twilio 401 (code 20003): Authenticate"]);
  assert.equal((await refused.get("/api/today")).json.texts_failing, true);
  const sent = await start({ env: TWILIO_ENV, twilioFetch: twilioAnswering(201, { sid: "SM1" }) });
  assert.deepEqual([(await sent.post("/api/digest/send")).json.status, (await sent.get("/api/today")).json.texts_failing], ["sent", false]);
});

test("GET /api/health", async () => {
  const api = await start();
  const health = (await api.get("/api/health")).json;
  const { clock_offset_ms: offset, ...rest } = health;
  assert.deepEqual(rest, {
    ok: true, now: A, tz: "America/Chicago", ai: "rules", ai_model: "claude-sonnet-5-5", sms: "simulated",
    demo: true, passcode: false, unlinked_messages: 0,
  });
  assert.equal(typeof offset, "number");
  assert.equal((await (await start({ env: { DEMO: "0" } })).get("/api/health")).json.demo, false);
});

test("settings: GET shape, PUT validation and normalisation, link regeneration", async () => {
  const api = await start();
  const s = (await api.get("/api/settings")).json;
  assert.equal(s.company_name, "Frostline Refrigeration");
  assert.deepEqual(s.integrations, { ai: "rules", ai_model: "claude-sonnet-5-5", sms: "simulated", passcode: false, inbound_token: false });
  assert.match(s.readonly_key, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(s.readonly_url, `http://localhost:3000/n/${s.readonly_key}`);
  assert.deepEqual(s.webhook_urls, {
    sms: "http://localhost:3000/api/inbound/sms", call: "http://localhost:3000/api/inbound/call",
    email: "http://localhost:3000/api/inbound/email", form: "http://localhost:3000/api/inbound/form",
  });
  assert.equal(s.forwarding_number, null);

  const saved = await api.put("/api/settings", {
    owner_name: "Dee", husband_phone: "", digest_time: "06:30",
    techs: [{ name: "Luis", phone: "(312) 555-0121" }, { name: " Mike ", phone: "" }, { name: "", phone: "" }],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.json.owner_name, saved.json.husband_phone, saved.json.digest_time], ["Dee", null, "06:30"]);
  assert.deepEqual(saved.json.techs, [{ name: "Luis", phone: "+13125550121" }, { name: "Mike", phone: null }]);
  assert.ok(saved.json.integrations && saved.json.webhook_urls);
  for (const bad of [{ digest_time: "7am" }, { friday_sweep: "yes" }, { bogus: 1 }, { owner_phone: "12" }, { timezone: "Mars/Base" },
    { techs: [{ name: "", phone: "3125550121" }] }, { company_name: "" }]) {
    assert.deepEqual(errorOf(await api.put("/api/settings", bad)), [400, "validation"], JSON.stringify(bad));
  }
  assert.equal(s.owner_email, "denise@frostline.example", "the demo knows Denise's address");
  assert.equal((await api.put("/api/settings", { owner_email: " Denise@Frostline.Example " })).json.owner_email, "denise@frostline.example");
  assert.deepEqual(errorOf(await api.put("/api/settings", { owner_email: "denise at frostline" })), [400, "validation"]);
  assert.equal((await api.put("/api/settings", { owner_email: "" })).json.owner_email, null);
  const ignored = await api.put("/api/settings", { readonly_key: "mine", clock_offset_ms: 5 });
  assert.equal(ignored.json.readonly_key, s.readonly_key);

  const fresh = (await api.put("/api/settings", { regenerate_readonly_key: true })).json;
  assert.notEqual(fresh.readonly_key, s.readonly_key);
  assert.equal((await api.get(`/n/${s.readonly_key}`)).status, 404);
  assert.equal((await api.get(`/n/${fresh.readonly_key}`)).status, 200);

  const wired = await start({ env: { INBOUND_TOKEN: "tok en", TWILIO_FROM: "+13125550105", PUBLIC_URL: "https://callback.example.com/" } });
  const w = (await wired.get("/api/settings")).json;
  assert.equal(w.webhook_urls.form, "https://callback.example.com/api/inbound/form?token=tok%20en");
  assert.equal(w.webhook_urls.sms, "https://callback.example.com/api/inbound/sms?token=tok%20en");
  assert.equal(w.readonly_url, `https://callback.example.com/n/${w.readonly_key}`);
  assert.equal(w.forwarding_number, "+13125550105");
  assert.equal(w.integrations.inbound_token, true);
});

test("CSV export: header, one row per job, readable values, formula guard", async () => {
  const api = await start();
  await api.patch("/api/jobs/15", { problem: "=1+2, \"kegs\"" });
  const res = await api.get("/api/export/jobs.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/csv/);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="callback-jobs.csv"');
  const bytes = new Uint8Array(await (await fetch(`${api.base}/api/export/jobs.csv`)).arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "a UTF-8 BOM so spreadsheets read accents and dashes");
  const lines = res.text.trimEnd().split("\r\n");
  assert.equal(lines[0], "id,title,contact,phone,email,stage,problem,equipment,urgent,quote_amount,created_at,won_at,done_at,lost_at,lost_reason");
  assert.equal(lines.length, 19);
  assert.equal(lines[16], "16,Bella Cucina,Marco Rossi,(312) 555-0142,,New - call them back,Walk-in freezer at 28 degrees and climbing,Walk-in freezer,yes,,2026-10-02T21:47:00.000Z,,,,");
  assert.equal(lines[4], "4,Taste of Seoul,Min-jun Kim,(312) 555-0129,,Lost,Reach-in compressor noisy - wants a quote,Reach-in,no,1200,2026-09-23T16:00:00.000Z,,,2026-10-01T22:00:00.000Z,Went with someone else");
  assert.ok(lines[15].includes(",\"'=1+2, \"\"kegs\"\"\","), "formula cells get a leading ', quotes are doubled");
});

test("R15 the husband's link: /n/{key} shows the numbers as plain HTML; a wrong key is 404", async () => {
  const api = await start({ env: { APP_PASSCODE: "4321" } });
  const key = repo.getSettings(api.db).readonly_key;
  const page = await api.get(`/n/${key}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  for (const text of ["Frostline Refrigeration numbers", "Open jobs", ">13<", "New 3 · Waiting on quote 3 · Their yes 2 · Said yes 2 · Scheduled 3",
    "$8,400", "2 quotes", "7 jobs", "$4,750 (2 without a $)", "1 went with someone else", "Waiting over a day for a first call: 2",
    "Waiting on a yes: $8,400 (2 quotes)", "New last 7 days: 12"]) {
    // Phrases are bound with no-break spaces so they don't wrap mid-phrase; the visible text is the same.
    assert.ok(page.text.replace(/\u00a0/g, " ").includes(text), text);
  }
  assert.ok(!/<script|<button|<form|<input/i.test(page.text));
  assert.equal((await api.get("/n/not-the-key")).status, 404);
  assert.deepEqual(errorOf(await api.get("/api/numbers")), [401, "unauthorized"]);

  repo.updateCustomer(api.db, 1, { business_name: "<b>Joe's</b> & \"Co\"" }, A);
  repo.putSettings(api.db, { company_name: "Frost <i>line</i>" });
  const escaped = (await api.get(`/n/${key}`)).text;
  assert.ok(escaped.includes("Frost &lt;i&gt;line&lt;/i&gt; numbers"));
  assert.ok(!escaped.includes("<i>line</i>"));
});

// ---------------------------------------------------------------------------
// Guards

test("T21 passcode: no cookie is 401; login sets a 180-day httpOnly cookie; health and webhooks stay open", async () => {
  const api = await start({ env: { APP_PASSCODE: "4321", SESSION_SECRET: "test-secret" } });
  assert.deepEqual(errorOf(await api.get("/api/today")), [401, "unauthorized"]);
  assert.deepEqual(errorOf(await api.post("/api/jobs/16/outcome", { outcome: "no_answer" })), [401, "unauthorized"]);
  assert.deepEqual(errorOf(await api.post("/api/sim/tick")), [401, "unauthorized"]);
  assert.equal((await api.get("/api/health")).json.passcode, true);
  assert.equal((await api.get("/")).status, 200, "the app shell loads so it can show Login");
  assert.equal((await api.get("/shared/time.js")).status, 200);
  assert.deepEqual(errorOf(await api.post("/api/login", { passcode: "0000" })), [401, "unauthorized"]);
  assert.deepEqual(errorOf(await api.post("/api/login", {})), [401, "unauthorized"]);
  const login = await api.post("/api/login", { passcode: "4321" });
  assert.equal(login.status, 200);
  assert.deepEqual(login.json, { ok: true });
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /^cb_session=\d+\.[A-Za-z0-9_-]+; Max-Age=15552000; Path=\/; HttpOnly; SameSite=Lax$/);
  const cookie = setCookie.split(";")[0];
  assert.equal((await api.get("/api/today", { cookie })).status, 200);
  assert.equal((await api.get("/api/today", { cookie: `${cookie}x` })).status, 401);
  assert.equal((await api.get("/api/today", { cookie: "cb_session=1.abc" })).status, 401);
  const inbound = await api.post("/api/inbound/sms", { from: "+13125550188", body: "Ice machine is leaking" });
  assert.equal(inbound.status, 200);
  assert.equal(inbound.json.status, "created_job");
  const form = await api.post("/api/inbound/form", { name: "Pat Lee", phone: "(312) 555-0187", message: "Prep table warm", submission_id: "f-1" });
  assert.deepEqual([form.status, form.json.status], [200, "created_job"]);

  const other = await start({ env: { APP_PASSCODE: "4321", SESSION_SECRET: "another-secret" } });
  assert.equal((await other.get("/api/today", { cookie })).status, 401, "a cookie signed with another secret fails");
  const unset = await start({ env: { APP_PASSCODE: "4321" } });
  const restarted = createApp({ db: unset.db, now: () => A, env: { APP_PASSCODE: "4321" } });
  const unsetCookie = (await unset.post("/api/login", { passcode: "4321" })).headers.get("set-cookie").split(";")[0];
  const again = await new Promise((resolve) => { const s = restarted.listen(0, "127.0.0.1", () => resolve(s)); });
  servers.push(again);
  const afterRestart = await fetch(`http://127.0.0.1:${again.address().port}/api/today`, { headers: { cookie: unsetCookie } });
  assert.equal(afterRestart.status, 200, "regression RT-9: without SESSION_SECRET a restart keeps her logged in");
  for (let i = 0; i < 10; i += 1) await unset.post("/api/login", { passcode: `bad${i}` });
  const limited = await unset.post("/api/login", { passcode: "4321" });
  assert.equal(limited.status, 429, "too many wrong passcodes");
});

test("T21 INBOUND_TOKEN: inbound without the token is 401; with it 200; Twilio signature 403", async () => {
  const api = await start({ env: { INBOUND_TOKEN: "t0k" } });
  const body = { from: "+13125550188", body: "Walk-in cooler not cold" };
  assert.deepEqual(errorOf(await api.post("/api/inbound/sms", body)), [401, "unauthorized"]);
  assert.deepEqual(errorOf(await api.post("/api/inbound/sms?token=nope", body)), [401, "unauthorized"]);
  assert.equal((await api.post("/api/inbound/sms?token=t0k", body)).json.status, "created_job");

  const signed = await start({ env: { TWILIO_AUTH_TOKEN: "authtok", PUBLIC_URL: "https://callback.example.com" } });
  const params = { MessageSid: "SMsig1", From: "+13125550189", To: "+13125550105", Body: "Freezer down", NumMedia: "0" };
  const postForm = async (headers) => {
    const res = await fetch(`${signed.base}/api/inbound/sms`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(params),
    });
    return res.status;
  };
  assert.equal(await postForm({ "x-twilio-signature": "bad" }), 403);
  const good = twilioSignature("authtok", "https://callback.example.com/api/inbound/sms", params);
  assert.equal(await postForm({ "x-twilio-signature": good }), 200);
});

test("regression security RT-8: Twilio signatures are checked against the server's own address, not localhost:3000", async () => {
  const api = await start({ env: { TWILIO_AUTH_TOKEN: "authtok" }, publicUrl: "http://localhost:4567" });
  const params = { MessageSid: "SMsig2", From: "+13125550184", To: "+13125550105", Body: "Freezer down", NumMedia: "0" };
  const postSigned = async (url) => (await fetch(`${api.base}/api/inbound/sms`, {
    method: "POST", body: new URLSearchParams(params),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature("authtok", url, params) },
  })).status;
  assert.equal(await postSigned("http://localhost:3000/api/inbound/sms"), 403);
  assert.equal(await postSigned("http://localhost:4567/api/inbound/sms"), 200);
});

test("auto-acknowledgement (off by default) goes through notify.send into the outbox when turned on", async () => {
  const api = await start();
  const first = await api.post("/api/inbound/sms", { from: "+13125550186", body: "Walk-in cooler is warm", id: "SMack1" });
  assert.equal(first.json.status, "created_job");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(get(api.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'auto_ack'").n, 0);
  await api.put("/api/settings", { auto_ack_enabled: true });
  const second = await api.post("/api/inbound/sms", { from: "+13125550185", body: "Ice machine leaking", id: "SMack2" });
  assert.equal(second.json.status, "created_job");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ack = get(api.db, "SELECT * FROM outbox WHERE kind = 'auto_ack'");
  assert.deepEqual([ack.to_phone, ack.status, ack.job_id, ack.created_at], ["+13125550185", "simulated", second.json.job_id, A]);
  assert.equal(ack.body, "Hi, it's Denise at Frostline Refrigeration. Got your message - I'll call you back as soon as I can.");
});

// ---------------------------------------------------------------------------
// Simulator (DEMO only)

test("simulator: presets through the real adapters, custom messages, duplicates", async () => {
  const api = await start();
  const rosa = await api.post("/api/sim/inbound", { preset: "rosa_yes" });
  assert.deepEqual([rosa.status, rosa.json.status, rosa.json.job_id], [200, "attached", 7]);
  assert.equal("refine" in rosa.json, false);
  const replied = (await api.get("/api/today")).json.sections.find((s) => s.bucket === "replied");
  const card = replied.items.find((c) => c.job_id === 7);
  assert.equal(card.outcomes[0].label, "Mark as yes?");
  assert.equal(card.suggestion, "mark_yes");
  const tony = await api.post("/api/sim/inbound", { preset: "web_form_tony" });
  assert.equal(tony.json.status, "created_job");
  assert.equal((await api.post("/api/sim/inbound", { preset: "web_form_tony" })).json.status, "duplicate");
  assert.equal((await api.post("/api/sim/inbound", { preset: "spam_call" })).json.status, "ignored");
  assert.deepEqual(errorOf(await api.post("/api/sim/inbound", { preset: "nope" })), [400, "validation"]);
  const custom = await api.post("/api/sim/inbound", { channel: "call", from: "(312) 555-0177", body: "", call_status: "missed", format: "twilio" });
  assert.deepEqual([custom.json.status, custom.json.job_id], ["attached", 17]);
  const sms = await api.post("/api/sim/inbound", { channel: "sms", from: "312-555-0191", body: "Reach-in is warm", format: "generic" });
  assert.equal(sms.json.status, "created_job");
  assert.deepEqual(errorOf(await api.post("/api/sim/inbound", { channel: "fax", from: "1", body: "x" })), [400, "validation"]);
});

test("simulator clock: presets run the scheduler and persist the offset; reset reseeds; off without DEMO", async () => {
  const api = await start({ now: () => clock.now().toISOString() });
  clock.setNow(A);
  const plus = await api.post("/api/sim/clock", { preset: "plus_30m" });
  assert.equal(plus.status, 200);
  assert.ok(Math.abs(Date.parse(plus.json.now) - Date.parse(addMinutes(A, 30))) < 2000);
  assert.ok(Math.abs(plus.json.offset_ms - repo.getSettings(api.db).clock_offset_ms) < 5);
  assert.deepEqual(plus.json.sent, []);
  const fri = await api.post("/api/sim/clock", { preset: "next_fri_1500" });
  assert.ok(fri.json.now.startsWith("2026-10-09T20:00:0"), fri.json.now);
  const kinds = fri.json.sent.map((o) => o.kind);
  assert.ok(kinds.includes("friday_sweep"), kinds.join());
  assert.ok(kinds.includes("nag"), "job 18's reminder fires when the clock jumps past 8:02am");
  assert.equal(fri.json.sent.find((o) => o.kind === "friday_sweep").at_label, "Fri 3:00pm");
  const mon = await api.post("/api/sim/clock", { preset: "next_mon_0700" });
  assert.ok(mon.json.now.startsWith("2026-10-12T12:00:0"), mon.json.now);
  assert.deepEqual(mon.json.sent.map((o) => o.kind), ["digest"]);
  const set = await api.post("/api/sim/clock", { set: "2026-10-05T14:00:00.000Z" });
  assert.ok(set.json.now.startsWith("2026-10-05T14:00:0"));
  assert.deepEqual(errorOf(await api.post("/api/sim/clock", { set: "soon" })), [400, "validation"]);
  assert.deepEqual(errorOf(await api.post("/api/sim/clock", { preset: "warp" })), [400, "validation"]);
  assert.equal((await api.post("/api/sim/tick")).status, 200);
  const real = await api.post("/api/sim/clock", { preset: "real" });
  assert.equal(real.json.offset_ms, 0);
  assert.equal(clock.isShifted(), false);
  assert.equal(repo.getSettings(api.db).clock_offset_ms, 0);

  await api.post("/api/jobs", { text: "Extra job 312-555-0111" });
  const reset = await api.post("/api/sim/reset");
  assert.equal(reset.status, 200);
  assert.equal(get(api.db, "SELECT count(*) AS n FROM jobs").n, 18);
  assert.equal(get(api.db, "SELECT count(*) AS n FROM outbox").n, 6);
  assert.ok(clock.isShifted());

  const off = await start({ env: { DEMO: "0" } });
  assert.deepEqual(errorOf(await off.post("/api/sim/tick")), [404, "not_found"]);
  assert.deepEqual(errorOf(await off.post("/api/sim/inbound", { preset: "rosa_yes" })), [404, "not_found"]);
  assert.equal((await off.get("/api/today")).json.demo.shifted, false);
});

test("C11 GET /api/sim/presets lists the demo presets", async () => {
  const api = await start();
  const { items } = (await api.get("/api/sim/presets")).json;
  assert.deepEqual(items.map((p) => p.id),
    ["rosa_yes", "lucia_repeat", "web_form_tony", "voicemail_carla", "forward_midway", "spam_call", "answered_call"]);
  for (const p of items) {
    assert.deepEqual(Object.keys(p), ["id", "label", "note"]);
    assert.equal(typeof p.label, "string");
    assert.equal(typeof p.note, "string", p.id);
  }
});

test("regression RT-8: moving the demo clock back forgets the texts sent 'in the future'", async () => {
  const api = await start({ now: () => clock.now().toISOString() });
  clock.setNow(A);
  const monday = await api.post("/api/sim/clock", { preset: "next_mon_0700" });
  assert.ok(monday.json.sent.some((o) => o.kind === "digest"));
  const back = addMinutes(A, 60);
  await api.post("/api/sim/clock", { set: back });
  assert.equal(get(api.db, "SELECT count(*) AS n FROM outbox WHERE created_at > ?", [back]).n, 0);
  assert.equal(get(api.db, "SELECT count(*) AS n FROM events WHERE kind = 'notified' AND at > ?", [back]).n, 0);
  const real = await api.post("/api/sim/clock", { set: "2026-10-12T12:30:00.000Z" });
  assert.deepEqual(real.json.sent.filter((o) => o.kind === "digest").length, 1, "that Monday still gets its morning text");
});

// ---------------------------------------------------------------------------
// Serving the app

test("static files, /shared modules, the SPA fallback and JSON 404s", async () => {
  const api = await start();
  const home = await api.get("/");
  assert.equal(home.status, 200);
  assert.match(home.text, /<div id="app"><\/div>/);
  assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
  const deep = await api.get("/jobs", { accept: "text/html" });
  assert.equal(deep.status, 200);
  assert.match(deep.text, /<div id="app">/);
  const shared = await api.get("/shared/stages.js");
  assert.equal(shared.status, 200);
  assert.match(shared.headers.get("content-type"), /javascript/);
  assert.equal((await api.get("/vendor/preact-htm.js")).status, 200);
  assert.deepEqual(errorOf(await api.get("/api/nope")), [404, "not_found"]);
  assert.equal((await api.get("/missing.png")).status, 404);
  const bad = await api.call("POST", "/api/jobs", undefined, { "content-type": "application/json" });
  assert.deepEqual(errorOf(bad), [400, "validation"]);
  const broken = await fetch(`${api.base}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error.code, "validation");
  const huge = await fetch(`${api.base}/api/parse`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(1_100_000) }),
  });
  assert.equal(huge.status, 413);
});

test("R25 with 100 open jobs, GET /api/today answers in under 200 ms", async () => {
  const api = await start({ seed: false });
  for (let i = 0; i < 100; i += 1) {
    ingestManual(api.db, {
      text: `Customer ${i} walk-in cooler ${i % 4 === 0 ? "down" : "noisy"}`,
      fields: { business_name: `Shop ${i}`, phone: `+1312555${String(3000 + i)}` },
      stage: ["new", "quote", "to_schedule"][i % 3],
    }, { now: addMinutes(A, -i * 30) });
  }
  assert.equal(get(api.db, "SELECT count(*) AS n FROM jobs WHERE stage NOT IN ('done','lost')").n, 100);
  await api.get("/api/today");
  const timings = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    const res = await api.get("/api/today");
    timings.push(performance.now() - t0);
    assert.equal(res.json.count, 100);
  }
  const median = timings.sort((a, b) => a - b)[2];
  assert.ok(median < 200, `median ${median.toFixed(1)} ms`);
});

// ---------------------------------------------------------------------------
// Startup (T20) and the production rule

const SERVER = fileURLToPath(new URL("../server/index.js", import.meta.url));

/**
 * Start server/index.js from an empty folder (so no .env is read) on a free port.
 * Resolves with {line, port, stderr()} once the startup line is printed.
 */
function boot(dir, env) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: "0", ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (chunk) => { err += chunk; });
  const ready = new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no startup line: ${out}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (!out.includes("\n")) return;
      clearTimeout(timer);
      const line = out.trimEnd();
      resolve({ line, port: Number(/^Callback on http:\/\/localhost:(\d+) /.exec(line)?.[1]), stderr: () => err });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code}: ${out}${err}`));
    });
  });
  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => (child.exitCode != null ? resolve() : child.on("exit", resolve)));
  };
  return { ready, stop };
}

function bootOnce(env) {
  const dir = mkdtempSync(join(tmpdir(), "callback-boot-"));
  try {
    return spawnSync(process.execPath, [SERVER], {
      cwd: dir, env: { PATH: process.env.PATH, PORT: "0", DB_PATH: join(dir, "boot.db"), ...env }, encoding: "utf8", timeout: 10_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("T20 startup log: one line with 'AI: rules only' and 'SMS: simulated (outbox)'; links use the real port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "callback-boot-"));
  const server = boot(dir, { DB_PATH: join(dir, "boot.db") });
  try {
    const { line, port, stderr } = await server.ready;
    assert.ok(line.includes("AI: rules only"));
    assert.ok(line.includes("SMS: simulated (outbox)"));
    assert.match(line, /^Callback on http:\/\/localhost:\d+ \| AI: rules only \(set ANTHROPIC_API_KEY for claude-sonnet-5-5\) \| SMS: simulated \(outbox\) \| Inbound: \/api\/inbound\/\{sms,call,email,form\} \| Passcode: off \| Demo: on, clock Mon [A-Z][a-z]{2} \d{1,2} 7:0\dam$/);
    const base = `http://127.0.0.1:${port}`;
    const today = await (await fetch(`${base}/api/today`)).json();
    assert.equal(today.header, "10 people to call");
    assert.equal(today.demo.shifted, true);
    // regression HM-1: every generated link points at the port the server really listens on.
    const settings = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(settings.readonly_url, `http://localhost:${port}/n/${settings.readonly_key}`);
    assert.equal(settings.webhook_urls.sms, `http://localhost:${port}/api/inbound/sms`);
    const preview = await (await fetch(`${base}/api/digest/preview`)).json();
    assert.ok(preview.digest.body.endsWith(`Open: http://localhost:${port}/#/`));
    const outbox = await (await fetch(`${base}/api/outbox`)).json();
    assert.ok(outbox.items[0].body.endsWith(`Open: http://localhost:${port}/#/`), "the seeded texts too");
    assert.equal(stderr(), "", "regression HM-11: no '.env not found' warning");
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production without APP_PASSCODE refuses to start", () => {
  const res = bootOnce({ NODE_ENV: "production" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /APP_PASSCODE/);
  assert.equal(res.stdout, "");
});

test("regression security RT-8: signature checks with no public PUBLIC_URL warn, and refuse in production", async () => {
  const prod = bootOnce({ NODE_ENV: "production", APP_PASSCODE: "4321", TWILIO_AUTH_TOKEN: "authtok" });
  assert.equal(prod.status, 1);
  assert.match(prod.stderr, /PUBLIC_URL/);
  const local = bootOnce({ NODE_ENV: "production", APP_PASSCODE: "4321", MAILGUN_SIGNING_KEY: "key", PUBLIC_URL: "http://localhost:3000" });
  assert.equal(local.status, 1);

  const dir = mkdtempSync(join(tmpdir(), "callback-boot-"));
  const server = boot(dir, { DB_PATH: join(dir, "boot.db"), TWILIO_AUTH_TOKEN: "authtok" });
  try {
    const { stderr } = await server.ready;
    await new Promise((resolve) => setTimeout(resolve, 50)); // the warning follows the startup line on stderr
    assert.match(stderr(), /^Warning: .*PUBLIC_URL/);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression security RT-3: a production boot with DEMO=1 doesn't seed or shift the clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "callback-boot-"));
  const dbPath = join(dir, "prod.db");
  const server = boot(dir, { DB_PATH: dbPath, NODE_ENV: "production", DEMO: "1", APP_PASSCODE: "4321" });
  try {
    const { line } = await server.ready;
    assert.ok(line.endsWith("| Passcode: on | Demo: off"), line);
  } finally {
    await server.stop();
  }
  const db = openDb(dbPath);
  assert.equal(get(db, "SELECT count(*) AS n FROM jobs").n, 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("regression security RT-3: NODE_ENV=production turns the demo off, whatever DEMO says", async () => {
  const api = await start({ seed: false, env: { NODE_ENV: "production", DEMO: "1", APP_PASSCODE: "4321" } });
  assert.equal((await api.get("/api/health")).json.demo, false);
  const login = await api.post("/api/login", { passcode: "4321" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.deepEqual(errorOf(await api.post("/api/sim/reset", {}, { cookie })), [404, "not_found"]);
  assert.equal((await api.get("/api/today", { cookie })).json.demo.shifted, false);
});

test("listing endpoints clamp ?limit and the Today count matches the cards", async () => {
  const api = await start();
  assert.equal((await api.get("/api/outbox?limit=0")).json.items.length, 6);
  assert.equal((await api.get("/api/outbox?limit=abc")).json.items.length, 6);
  assert.equal((await api.get("/api/messages?limit=5")).json.items.length, 5);
  const today = (await api.get("/api/today")).json;
  assert.equal(cards(today).length, today.count);
  assert.equal(all(api.db, "SELECT id FROM jobs").length, 18);
});
