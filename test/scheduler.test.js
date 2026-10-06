// Scheduler and outbox (SPEC §11): R20 (digest via the outbox, Twilio with a stubbed fetch),
// R10 (one reminder per untouched lead), the Friday sweep, idempotency and T08 (never auto-closes).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openDb, all, get } from "../server/db.js";
import * as repo from "../server/repo.js";
import * as clock from "../server/clock.js";
import { tick, start } from "../server/scheduler.js";
import { send, enqueue, smsMode, SENDING_NOTE } from "../server/notify.js";
import { seedDemo } from "../server/seed.js";
import { ingest, ingestManual } from "../server/ingest.js";
import { isOnToday } from "../shared/today-rules.js";
import { isOpen } from "../shared/stages.js";
import { atLocal, addMinutes } from "../shared/time.js";

process.env.AI_PARSING = "off";
const TZ = "America/Chicago";
const A = "2026-10-05T12:00:00.000Z"; // Mon Oct 5 2026 07:00 local
const at = (ymd, hm) => atLocal(ymd, hm, TZ);
const SIMULATED = { env: {} };
const TWILIO_ENV = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "secret", TWILIO_FROM: "+13125550105" };
after(() => clock.setNow(null));

function emptyDb() {
  const db = openDb(":memory:");
  repo.ensureSettings(db);
  return db;
}

const outbox = (db) => all(db, "SELECT * FROM outbox ORDER BY id");

/** A new lead as a text, the way the SMS webhook would store it. */
function textIn(db, { from, body, when }) {
  return ingest(db, {
    channel: "sms", provider: "twilio", external_id: `SM-${from}-${when}`, received_at: when,
    from_phone: from, body,
  }, { now: when, ai: false }).job_id;
}

/** A Twilio Messages API stub that records each call. */
function twilioStub(response = { status: 201, body: { sid: "SM123" } }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

test("R20 the Mon 07:00 digest is in the outbox, simulated, when Twilio is not set", () => {
  const db = openDb(":memory:");
  seedDemo(db, { anchor: A, env: {} });
  const digest = repo.outboxByDedupe(db, "digest:2026-10-05");
  assert.equal(digest.created_at, A);
  assert.equal(digest.status, "simulated");
  assert.equal(digest.to_phone, "+13125550100");
  assert.equal(digest.to_name, "Denise");
  assert.equal(digest.body.split("\n")[0], "Morning Denise - 10 to call today:");
  assert.equal(digest.body.split("\n").at(-2), "+4 more.");
  assert.equal(tick(db, A, SIMULATED).sent.length, 0, "a second tick at A sends nothing");
  assert.equal(tick(db, addMinutes(A, 1), SIMULATED).sent.length, 0);
});

test("R20 with the Twilio variables set, the digest is POSTed to the Twilio Messages API", async () => {
  const db = emptyDb();
  textIn(db, { from: "+13125550142", body: "Freezer is down, call me", when: at("2026-10-05", "06:30") });
  const stub = twilioStub();
  const { sent, delivered } = tick(db, A, { env: TWILIO_ENV, fetch: stub.fetch });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, "failed");
  assert.equal(sent[0].error, SENDING_NOTE);
  const [final] = await delivered;
  assert.equal(stub.calls.length, 1);
  const { url, init } = stub.calls[0];
  assert.equal(url, "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from("ACtest:secret").toString("base64")}`);
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(init.body);
  assert.equal(form.get("To"), "+13125550100");
  assert.equal(form.get("From"), "+13125550105");
  assert.equal(form.get("Body"), final.body);
  assert.match(final.body, /^Morning Denise - 1 to call today:\n1\. \(312\) 555-0142 - Freezer is down/);
  assert.equal(final.status, "sent");
  assert.equal(final.provider_id, "SM123");
  assert.equal(final.error, null);
  assert.deepEqual(repo.getOutbox(db, final.id), final);
});

test("notify.send: Twilio errors mark the row failed; a dedupe hit returns null; it never throws", async () => {
  const db = emptyDb();
  const msg = { to_phone: "+13125550100", to_name: "Denise", kind: "manual", body: "hi", job_id: null };
  const refused = await send({ ...msg, dedupe_key: "a" }, {
    db, now: A, env: TWILIO_ENV, fetch: twilioStub({ status: 400, body: { code: 21211, message: "Invalid 'To' Phone Number" } }).fetch,
  });
  assert.equal(refused.status, "failed");
  assert.equal(refused.error, "Twilio 400 (code 21211): Invalid 'To' Phone Number");
  const down = await send({ ...msg, dedupe_key: "b" }, { db, now: A, env: TWILIO_ENV, fetch: twilioStub(new TypeError("fetch failed")).fetch });
  assert.equal(down.status, "failed");
  assert.equal(down.error, "TypeError: fetch failed");
  assert.equal(await send({ ...msg, dedupe_key: "a" }, { db, now: A, env: TWILIO_ENV }), null);
  assert.equal(await send({ ...msg, to_phone: null, dedupe_key: "c" }, { db, now: A, env: {} }), null);
  assert.equal(await send(null, { db, now: A }), null);
  const simulated = await send({ ...msg, dedupe_key: "d" }, { db, now: () => A, env: {} });
  assert.equal(simulated.status, "simulated");
  assert.equal(simulated.created_at, A);
  assert.equal(smsMode({ TWILIO_ACCOUNT_SID: "x", TWILIO_AUTH_TOKEN: "y" }), "simulated");
  assert.equal(smsMode(TWILIO_ENV), "twilio");
  assert.equal(enqueue(db, { ...msg, dedupe_key: "d" }, { now: A, env: {} }), null);
});

test("R20 a weekday with nobody waiting sends the 'nobody's waiting' text", () => {
  const db = emptyDb();
  const tue = at("2026-10-06", "07:00");
  const { sent } = tick(db, tue, SIMULATED);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "digest");
  assert.equal(sent[0].dedupe_key, "digest:2026-10-06");
  assert.equal(sent[0].body, "Morning Denise - nobody's waiting on you today. Nice. Open: http://localhost:3000/#/");
});

test("R20 a weekend with no Call-first items sends nothing", () => {
  const db = emptyDb();
  ingestManual(db, { text: "Hillside Grocery wants a quote on a new ice machine", stage: "quote" }, { now: at("2026-10-09", "10:00") });
  assert.equal(tick(db, at("2026-10-10", "07:00"), SIMULATED).sent.length, 0);
  assert.equal(tick(db, at("2026-10-11", "08:30"), SIMULATED).sent.length, 0);
  assert.equal(outbox(db).length, 0);
});

test("digest window is [digest_time, +3h); weekend digest only with weekend_digest on", () => {
  const db = emptyDb();
  textIn(db, { from: "+13125550142", body: "Walk-in freezer warm", when: at("2026-10-09", "22:00") });
  repo.putSettings(db, { weekend_digest: false });
  assert.equal(tick(db, at("2026-10-10", "07:00"), SIMULATED).sent.filter((r) => r.kind === "digest").length, 0);
  repo.putSettings(db, { weekend_digest: true, digest_time: "08:00" });
  assert.equal(tick(db, at("2026-10-11", "07:59"), SIMULATED).sent.filter((r) => r.kind === "digest").length, 0);
  assert.equal(tick(db, at("2026-10-11", "11:00"), SIMULATED).sent.filter((r) => r.kind === "digest").length, 0);
  const [digest] = tick(db, at("2026-10-11", "10:59"), SIMULATED).sent.filter((r) => r.kind === "digest");
  assert.equal(digest.body, "Weekend check - 1 waiting on a call back:\n1. (312) 555-0142 - Walk-in freezer warm (URGENT)\nOpen: http://localhost:3000/#/");
  const notified = all(db, "SELECT summary, actor FROM events WHERE kind = 'notified' AND at = ?", [at("2026-10-11", "10:59")]);
  assert.deepEqual(notified, [{ summary: "In your weekend text", actor: "system" }]);
});

test("Friday sweep: Friday 15:00-18:00 only, when on, with up to 3 titles", () => {
  const db = emptyDb();
  const thu = at("2026-10-08", "09:00");
  for (const [i, name] of ["Alpha Diner", "Bravo Grill", "Charlie Market", "Delta Cafe"].entries()) {
    ingestManual(db, { text: `${name} needs a quote on a walk-in`, fields: { business_name: name }, stage: "quote" }, { now: addMinutes(thu, i) });
  }
  const sweeps = (when) => tick(db, when, SIMULATED).sent.filter((r) => r.kind === "friday_sweep");
  assert.equal(sweeps(at("2026-10-08", "15:00")).length, 0, "not on Thursday");
  assert.equal(sweeps(at("2026-10-09", "14:59")).length, 0);
  repo.putSettings(db, { friday_sweep: false });
  assert.equal(sweeps(at("2026-10-09", "15:00")).length, 0, "off in settings");
  repo.putSettings(db, { friday_sweep: true });
  const [sweep] = sweeps(at("2026-10-09", "17:55"));
  assert.equal(sweep.body, "Before the weekend: 4 people still waiting on you - Alpha Diner, Bravo Grill, Charlie Market, +1 more. Open: http://localhost:3000/#/");
  assert.equal(sweep.dedupe_key, "sweep:2026-10-09");
  assert.equal(sweeps(at("2026-10-09", "17:59")).length, 0, "once per Friday");
  assert.deepEqual(all(db, "SELECT job_id FROM events WHERE kind = 'notified' ORDER BY job_id").map((r) => r.job_id), [1, 2, 3]);
});

test("R10 an urgent untouched lead gets exactly one reminder after 30 minutes", () => {
  const db = emptyDb();
  const came = at("2026-10-06", "10:00");
  const jobId = textIn(db, { from: "+13125550142", body: "Hi this is Marco at Bella Cucina, walk-in freezer at 28 and climbing", when: came });
  assert.equal(tick(db, addMinutes(came, 29), SIMULATED).sent.length, 0);
  const { sent } = tick(db, addMinutes(came, 30), SIMULATED);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "nag");
  assert.equal(sent[0].job_id, jobId);
  assert.equal(sent[0].dedupe_key, `nag:${jobId}`);
  assert.equal(sent[0].body, `Still not called back (URGENT): Bella Cucina - Walk-in freezer at 28 and climbing. Came in today 10:00am. Call (312) 555-0142. Open: http://localhost:3000/#/job/${jobId}`);
  for (let m = 31; m <= 90; m += 5) assert.equal(tick(db, addMinutes(came, m), SIMULATED).sent.length, 0);
  assert.equal(outbox(db).filter((r) => r.kind === "nag").length, 1);
  assert.deepEqual(all(db, "SELECT kind, actor, summary FROM events WHERE job_id = ? AND kind = 'notified'", [jobId]),
    [{ kind: "notified", actor: "system", summary: "Reminder texted to you" }]);
});

test("reminders: 2 hours for normal leads, never once touched, only 7am-9pm, not right after a digest", () => {
  const db = emptyDb();
  const came = at("2026-10-06", "12:00");
  const normal = textIn(db, { from: "+13125550118", body: "Rosa here from Rosa's Taqueria, can you clean the ice machine", when: came });
  const touched = textIn(db, { from: "+13125550160", body: "Joe here from Joe's Diner, need a gasket", when: came });
  repo.updateJob(db, touched, { first_touch_at: addMinutes(came, 5) });
  assert.equal(tick(db, addMinutes(came, 119), SIMULATED).sent.length, 0);
  assert.deepEqual(tick(db, addMinutes(came, 120), SIMULATED).sent.map((r) => r.job_id), [normal]);

  const late = at("2026-10-06", "22:00");
  const night = textIn(db, { from: "+13125550142", body: "Freezer down", when: late });
  assert.equal(tick(db, addMinutes(late, 30), SIMULATED).sent.length, 0, "no texts after 9pm");
  const morning = tick(db, at("2026-10-07", "07:00"), SIMULATED).sent;
  assert.deepEqual(morning.map((r) => r.kind), ["digest"], "the digest names it, so no reminder yet");
  assert.equal(tick(db, at("2026-10-07", "08:00"), SIMULATED).sent.length, 0, "within 60 minutes of the digest");
  assert.deepEqual(tick(db, at("2026-10-07", "08:01"), SIMULATED).sent.map((r) => r.job_id), [night]);
});

test("scheduler.start runs once at once and then on its interval; stop() ends it", async () => {
  const db = emptyDb();
  const times = [];
  const stop = start(db, { env: {}, intervalMs: 15, now: () => { times.push(Date.now()); return at("2026-10-06", "07:00"); } });
  assert.equal(times.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 70));
  stop();
  const count = times.length;
  assert.ok(count >= 3, `ticked ${count} times`);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(times.length, count);
  assert.equal(outbox(db).length, 1, "idempotent across ticks");
});

test("T08 never auto-closes: seed + 20 untouched leads, 14 days of ticks every 15 minutes", () => {
  const db = openDb(":memory:");
  seedDemo(db, { anchor: A, env: {} });
  for (let i = 0; i < 20; i += 1) {
    const phone = `+1312555${String(2000 + i)}`;
    textIn(db, { from: phone, body: `Walk-in cooler ${i % 3 === 0 ? "down" : "making noise"}`, when: addMinutes(A, i * 7) });
  }
  const before = new Map(all(db, "SELECT id, stage FROM jobs").map((r) => [r.id, r.stage]));
  const openBefore = [...before.values()].filter(isOpen).length;
  const end = Date.parse(A) + 14 * 24 * 60 * 60 * 1000;
  let now = A;
  for (let t = Date.parse(A); t <= end; t += 15 * 60 * 1000) {
    now = new Date(t).toISOString();
    tick(db, now, SIMULATED);
  }
  const after = new Map(all(db, "SELECT id, stage FROM jobs").map((r) => [r.id, r.stage]));
  assert.deepEqual(after, before);
  assert.equal([...after.values()].filter(isOpen).length, openBefore);
  for (const jv of repo.getJobViews(db, { scope: "open" })) {
    assert.ok(isOnToday(jv, now) || Date.parse(jv.next_due_at) > Date.parse(now), `job ${jv.id} is reachable`);
  }
  const systemKinds = all(db, "SELECT DISTINCT kind FROM events WHERE actor = 'system'").map((r) => r.kind);
  assert.deepEqual(systemKinds, ["notified"]);
  assert.equal(get(db, "SELECT count(*) AS n FROM events WHERE actor = 'system' AND prev_json IS NOT NULL").n, 0);
  const nags = all(db, "SELECT job_id, count(*) AS n FROM outbox WHERE kind = 'nag' GROUP BY job_id");
  assert.ok(nags.every((r) => r.n === 1));
  assert.equal(nags.length, 23, "jobs 16, 17, 18 and the 20 new leads");
  assert.equal(get(db, "SELECT count(*) AS n FROM outbox WHERE kind = 'digest' AND created_at > ?", [A]).n, 14, "one every day, weekends too");
});
