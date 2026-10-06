// Inbound HTTP routes (SPEC §7.2, §12.6): R01, R02, the guards (T21), and every demo preset.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import { openDb, all, get } from "../server/db.js";
import * as repo from "../server/repo.js";
import { inboundRouter } from "../server/routes/inbound.js";
import { buildPreset, buildCustom, encodeBody, PRESETS } from "../server/presets.js";
import { applyOutcome } from "../shared/stages.js";
import { detectFormEmail, htmlToText, formExternalId, fromRawEmail, fromTwilioVoice } from "../server/adapters.js";
import { cardFor } from "../shared/today-rules.js";
import { replyIntent } from "../shared/parse.js";
import { sourceLabel, titleFor } from "../shared/format.js";
import { telLink } from "../shared/templates.js";
import { atLocal } from "../shared/time.js";

const TZ = "America/Chicago";
const A = "2026-10-05T12:00:00.000Z"; // Mon Oct 5 2026 07:00 local
const at = (ymd, hm) => atLocal(ymd, hm, TZ);
const ENV_KEYS = ["INBOUND_TOKEN", "TWILIO_AUTH_TOKEN", "PUBLIC_URL", "MAILGUN_SIGNING_KEY", "DEMO", "AI_PARSING"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.AI_PARSING = "off";

const servers = [];
after(() => {
  for (const s of servers) s.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A fresh database behind an app with only the inbound router, listening on port 0. */
async function startApp({ now = A, demo } = {}) {
  const db = openDb(":memory:");
  repo.ensureSettings(db);
  const app = express();
  app.use(inboundRouter({ db, now: () => now, settings: () => repo.getSettings(db), demo }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base };
}

async function post(base, path, { contentType, body, headers = {} }) {
  const res = await fetch(base + path, {
    method: "POST", headers: { "content-type": contentType, ...headers }, body: encodeBody({ contentType, body }),
  });
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, text, json: type.includes("json") ? JSON.parse(text) : null };
}

const postRequest = (base, request, path = request.path, headers) => post(base, path, { ...request, headers });
const json = (body) => ({ contentType: "application/json", body });
const form = (body) => ({ contentType: "application/x-www-form-urlencoded", body });
const count = (db, table) => get(db, `SELECT count(*) AS n FROM ${table}`).n;
const lastMessage = (db) => repo.listMessages(db, 1)[0];

function withEnv(values, fn) {
  return async () => {
    const before = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
    Object.assign(process.env, values);
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

/** The job and customer fields a channel should fill, for comparing two ways in. */
function jobShape(db, jobId) {
  const job = repo.getJobView(db, jobId);
  const { customer, last_inbound: inbound } = job;
  return {
    stage: job.stage, source: job.source, source_detail: job.source_detail, problem: job.problem,
    equipment: job.equipment, urgent: job.urgent, created_at: job.created_at, next_due_at: job.next_due_at,
    contact_name: customer.contact_name, business_name: customer.business_name, phone: customer.phone,
    email: customer.email, last_inbound: inbound && { channel: inbound.channel, call_status: inbound.call_status, body: inbound.body },
  };
}

// ---------------------------------------------------------------------------
// R01: missed call

test("R01: a missed call creates the same new job via the Twilio form, generic JSON and the alias", async () => {
  const twilio = await startApp();
  const sim = buildCustom({ channel: "call", from: "(312) 555-0177", call_status: "missed" });
  const res = await postRequest(twilio.base, sim, "/webhooks/twilio/voice");
  assert.deepEqual([res.status, res.type.split(";")[0], res.text], [200, "text/xml", "<Response/>"]);
  const jobId = lastMessage(twilio.db).job_id;
  const shape = jobShape(twilio.db, jobId);
  assert.deepEqual(shape, {
    stage: "new", source: "call", source_detail: "missed", problem: null, equipment: null, urgent: 0,
    created_at: A, next_due_at: A, contact_name: null, business_name: null, phone: "+13125550177", email: null,
    last_inbound: { channel: "call", call_status: "missed", body: "" },
  });
  const ctx = { now: A, tz: TZ, settings: repo.getSettings(twilio.db) };
  const card = cardFor(repo.getJobView(twilio.db, jobId), ctx);
  assert.deepEqual([card.source_label, card.tel_link, card.reason, card.title],
    ["Missed call", "tel:+13125550177", "New - missed call today 7:00am - no voicemail", "(312) 555-0177"]);
  assert.equal(telLink("+13125550177"), "tel:+13125550177");

  for (const path of ["/api/inbound/call", "/webhooks/voice"]) {
    const generic = await startApp();
    const r = await post(generic.base, path, json({ from: "(312) 555-0177", status: "missed", id: "call-1" }));
    assert.deepEqual([r.status, r.json.status], [200, "created_job"]);
    assert.deepEqual(jobShape(generic.db, r.json.job_id), shape);
  }
});

// ---------------------------------------------------------------------------
// R02: web-form email

const TONY_FIELDS = {
  stage: "new", source: "form", source_detail: null, problem: "Walk-in freezer at 10F and rising",
  equipment: "walk_in_freezer", urgent: 1, created_at: A, next_due_at: A,
  contact_name: "Tony Russo", business_name: "Tony's Bistro", phone: "+13125550187", email: null,
};

test("R02: the Postmark form email creates an urgent Web form job; the same Message-ID again is a duplicate", async () => {
  const { db, base } = await startApp();
  const request = buildPreset("web_form_tony");
  const first = await postRequest(base, request);
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.json).sort(), ["customer_id", "job_id", "matched_customer", "message_id", "status"]);
  assert.equal(first.json.status, "created_job");
  const { last_inbound: inbound, ...fields } = jobShape(db, first.json.job_id);
  assert.deepEqual(fields, TONY_FIELDS);
  assert.equal(inbound.channel, "form");
  const jv = repo.getJobView(db, first.json.job_id);
  assert.equal(sourceLabel(jv.source, jv.source_detail), "Web form");
  assert.equal(lastMessage(db).external_id, "web-form-tony-bistro@frostline.example");

  const again = await postRequest(base, request);
  assert.deepEqual(again.json, {
    status: "duplicate", job_id: first.json.job_id, message_id: first.json.message_id,
    customer_id: first.json.customer_id,
  });
  assert.equal(count(db, "messages"), 1);
  assert.equal(count(db, "jobs"), 1);
});

const RAW_TONY = [
  "From: Frostline Website <forms@frostline.example>",
  "To: jobs@inbound.frostline.example",
  "Subject: New website form submission",
  "Message-ID: <raw-tony@frostline.example>",
  "Date: Mon, 5 Oct 2026 06:58:00 -0500",
  "",
  "Name: Tony Russo",
  "Business: Tony's Bistro",
  "Phone: (312) 555-0187",
  "Message: Walk-in freezer at 10F and rising. Please call.",
].join("\r\n");

test("R02: a raw pasted email (text/plain or message/rfc822) gives the same fields", async () => {
  for (const contentType of ["text/plain", "message/rfc822"]) {
    const { db, base } = await startApp();
    const r = await post(base, "/webhooks/email", { contentType, body: RAW_TONY });
    assert.equal(r.json.status, "created_job");
    const { last_inbound: inbound, ...fields } = jobShape(db, r.json.job_id);
    assert.deepEqual(fields, TONY_FIELDS);
    const msg = lastMessage(db);
    assert.deepEqual([msg.provider, msg.external_id, msg.subject, msg.from_email, msg.raw_json],
      ["raw", "raw-tony@frostline.example", "New website form submission", "forms@frostline.example", RAW_TONY]);
  }
});

test("email: a plain customer email (generic JSON) stays channel 'email'; HTML is stripped", async () => {
  const { db, base } = await startApp();
  const r = await post(base, "/api/inbound/email", json({
    from: "Ana Ruiz <ana@harborgrill.example>", subject: "Reach-in",
    html: "<p>Hi Denise,</p><p>Our reach-in door gasket is torn &amp; the hinge is loose.</p>", message_id: "<ana-1@x>",
  }));
  assert.equal(r.json.status, "created_job");
  const msg = lastMessage(db);
  assert.deepEqual([msg.channel, msg.body], ["email", "Hi Denise,\nOur reach-in door gasket is torn & the hinge is loose."]);
  const jv = repo.getJobView(db, r.json.job_id);
  assert.deepEqual([jv.customer.email, jv.customer.contact_name, jv.equipment], ["ana@harborgrill.example", "Ana Ruiz", "reach_in"]);
});

test("email: Mailgun urlencoded, with the signature checked when MAILGUN_SIGNING_KEY is set", withEnv({ MAILGUN_SIGNING_KEY: "mg-key" }, async () => {
  const { db, base } = await startApp();
  const payload = {
    sender: "forms@frostline.example", from: "Frostline Website <forms@frostline.example>",
    subject: "New website form submission", "Message-Id": "<mg-1@frostline.example>",
    "body-plain": "Name: Linda Park\nBusiness: Maple Street Bakery\nPhone: 312-555-0138\nMessage: Reach-in door hinge broke",
    timestamp: "1791200000", token: "abc123",
  };
  const bad = await post(base, "/webhooks/mailgun", form({ ...payload, signature: "0".repeat(64) }));
  assert.deepEqual([bad.status, bad.json.error.code], [403, "forbidden"]);
  assert.equal(count(db, "messages"), 0);
  const signature = createHmac("sha256", "mg-key").update("1791200000abc123").digest("hex");
  const good = await post(base, "/webhooks/mailgun", form({ ...payload, signature }));
  assert.deepEqual([good.status, good.json.status], [200, "created_job"]);
  const jv = repo.getJobView(db, good.json.job_id);
  assert.deepEqual([jv.source, jv.customer.business_name, jv.customer.phone], ["form", "Maple Street Bakery", "+13125550138"]);
  assert.equal(lastMessage(db).provider, "mailgun");
}));

// ---------------------------------------------------------------------------
// Website form webhook

test("form webhook: aliases are mapped, unknown fields appended, and the submission id dedupes", async () => {
  const { db, base } = await startApp();
  const payload = {
    "Your Name": "Priya Shah", Restaurant: "Fresh Mart #2", "Phone Number": "(312) 555-0133",
    "E-mail Address": "Priya.Shah@freshmart.example", "Service Address": "4410 W Irving Park Rd",
    "How can we help?": "Deli ice machine is making about half the ice it used to.", "Best time": "mornings",
    submission_id: "sub-77",
  };
  const r = await post(base, "/webhooks/form", json(payload));
  assert.equal(r.json.status, "created_job");
  const msg = lastMessage(db);
  assert.deepEqual([msg.channel, msg.provider, msg.external_id, msg.body],
    ["form", "form", "sub-77", "Deli ice machine is making about half the ice it used to.\nBest time: mornings"]);
  const jv = repo.getJobView(db, r.json.job_id);
  assert.deepEqual(
    [jv.customer.contact_name, jv.customer.business_name, jv.customer.phone, jv.customer.email, jv.customer.address, jv.problem, jv.equipment],
    ["Priya Shah", "Fresh Mart #2", "+13125550133", "priya.shah@freshmart.example", "4410 W Irving Park Rd",
      "Deli ice machine is making about half the ice it used to", "ice_machine"],
  );
  const again = await post(base, "/api/inbound/form", form(payload));
  assert.equal(again.json.status, "duplicate");
});

// ---------------------------------------------------------------------------
// SMS formats

test("sms: Twilio photos add '[photo attached]'; generic JSON answers JSON", async () => {
  const { db, base } = await startApp();
  const twilio = await post(base, "/webhooks/sms", form({ MessageSid: "SMphoto", From: "+13125550166", Body: "look at this", NumMedia: "1" }));
  assert.deepEqual([twilio.status, twilio.text], [200, "<Response/>"]);
  assert.equal(lastMessage(db).body, "look at this\n[photo attached]");
  const generic = await post(base, "/api/inbound/sms", json({ from: "312-555-0167", body: "walk-in down", id: "g1" }));
  assert.equal(generic.json.status, "created_job");
  assert.equal(repo.getJobView(db, generic.json.job_id).customer.phone, "+13125550167");
});

test("generic 'at' is honoured only in demo mode", async () => {
  const earlier = "2026-10-03T18:12:00.000Z";
  const plain = await startApp({ demo: false });
  const r1 = await post(plain.base, "/api/inbound/sms", json({ from: "+13125550177", body: "hi", at: earlier }));
  assert.equal(repo.getJobRow(plain.db, r1.json.job_id).created_at, A);
  const demo = await startApp({ demo: true });
  const r2 = await post(demo.base, "/api/inbound/sms", json({ from: "+13125550177", body: "hi", at: earlier }));
  assert.equal(repo.getJobRow(demo.db, r2.json.job_id).created_at, earlier);
  assert.equal(repo.getMessage(demo.db, r2.json.message_id).received_at, earlier);
});

test("generic 'at' follows DEMO=1 when no demo flag is passed", withEnv({ DEMO: "1" }, async () => {
  const earlier = "2026-10-03T18:12:00.000Z";
  const { db, base } = await startApp();
  const r = await post(base, "/api/inbound/sms", json({ from: "+13125550177", body: "hi", at: earlier }));
  assert.equal(repo.getJobRow(db, r.json.job_id).created_at, earlier);
}));

// ---------------------------------------------------------------------------
// Guards (T21)

test("T21: with INBOUND_TOKEN set, a missing or wrong token gets 401 and writes nothing", withEnv({ INBOUND_TOKEN: "s3cret" }, async () => {
  const { db, base } = await startApp();
  const body = json({ from: "+13125550166", body: "walk-in down" });
  for (const path of ["/api/inbound/sms", "/api/inbound/sms?token=nope", "/webhooks/sms?token=s3cret2"]) {
    const r = await post(base, path, body);
    assert.deepEqual([r.status, r.json], [401, { error: { code: "unauthorized", message: "Missing or wrong token." } }]);
  }
  assert.equal(count(db, "messages"), 0);
  const ok = await post(base, "/api/inbound/sms?token=s3cret", body);
  assert.deepEqual([ok.status, ok.json.status], [200, "created_job"]);
}));

/** Twilio's algorithm, written out independently of the adapter. */
function expectedTwilioSignature(token, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", token).update(data).digest("base64");
}

test("T21: with TWILIO_AUTH_TOKEN set, a bad signature gets 403 and a correct one 200", withEnv(
  { TWILIO_AUTH_TOKEN: "twilio-secret", PUBLIC_URL: "https://callback.example/", INBOUND_TOKEN: "s3cret" },
  async () => {
    const { db, base } = await startApp();
    const params = { MessageSid: "SMsig", From: "+13125550166", To: "+13125550105", Body: "freezer down", NumMedia: "0" };
    const path = "/webhooks/twilio/sms?token=s3cret";
    const none = await post(base, path, form(params));
    assert.deepEqual([none.status, none.json.error.code], [403, "forbidden"]);
    const wrong = await post(base, path, { ...form(params), headers: { "X-Twilio-Signature": "bm9wZQ==" } });
    assert.equal(wrong.status, 403);
    const forOtherUrl = expectedTwilioSignature("twilio-secret", "https://callback.example/webhooks/sms?token=s3cret", params);
    assert.equal((await post(base, path, { ...form(params), headers: { "X-Twilio-Signature": forOtherUrl } })).status, 403);
    assert.equal(count(db, "messages"), 0);

    const signature = expectedTwilioSignature("twilio-secret", `https://callback.example${path}`, params);
    const good = await post(base, path, { ...form(params), headers: { "X-Twilio-Signature": signature } });
    assert.deepEqual([good.status, good.text], [200, "<Response/>"]);
    assert.equal(lastMessage(db).status, "created_job");
  },
));

test("bodies over 1 MB get 413; an empty body gets 400", async () => {
  const { db, base } = await startApp();
  const big = await post(base, "/api/inbound/email", json({ from: "a@b.example", text: "x".repeat(1_100_000) }));
  assert.deepEqual([big.status, big.json.error.code], [413, "validation"]);
  const empty = await post(base, "/api/inbound/form", json({}));
  assert.equal(empty.status, 400);
  assert.equal(count(db, "messages"), 0);
});

// ---------------------------------------------------------------------------
// §12.6 presets through the router

/** The parts of the seed the presets touch: Rosa's quote (job 7), Midway's quote (job 11), Lucia's past job (job 3). */
function seedForPresets(db) {
  const settings = repo.getSettings(db);
  const create = (customer, problem, createdAt) => {
    const c = repo.createCustomer(db, customer, createdAt);
    return repo.insertJob(db, {
      customer_id: c.id, stage: "new", source: "sms", problem,
      created_at: createdAt, updated_at: createdAt, stage_entered_at: createdAt, next_due_at: createdAt,
    });
  };
  const apply = (jobId, id, args, now) => {
    const { patch } = applyOutcome(repo.getJobView(db, jobId), id, args, { now, tz: TZ, settings });
    repo.updateJob(db, jobId, patch);
  };
  const lucia = create({ contact_name: "Lucia Ortiz", business_name: "Lucia's Market", phone: "+13125550101" },
    "Ice machine not making ice", at("2026-09-12", "09:00"));
  apply(lucia, "yes", { visit_date: "2026-09-14", tech: "Luis" }, at("2026-09-12", "09:20"));
  apply(lucia, "done", { amount: 480 }, at("2026-09-14", "16:00"));
  const rosa = create({ contact_name: "Rosa Medina", business_name: "Rosa's Taqueria", phone: "+13125550118" },
    "Walk-in cooler compressor short cycling", at("2026-09-29", "10:05"));
  apply(rosa, "need_quote", {}, at("2026-09-29", "14:00"));
  apply(rosa, "quote_sent", { amount: 2400 }, at("2026-10-01", "14:10"));
  const midway = create({ contact_name: "Gus Petrakis", business_name: "Midway Meats", phone: "+13125550174" },
    "Freezer door gasket and heater wire", at("2026-09-30", "08:45"));
  apply(midway, "need_quote", {}, at("2026-09-30", "10:20"));
  return { rosa, midway, lucia };
}

test("every §12.6 preset through the router produces its expected result", async () => {
  const { db, base } = await startApp();
  const jobs = seedForPresets(db);
  const settings = repo.getSettings(db);
  const ctx = { now: A, tz: TZ, settings, replyIntent };
  const card = (jobId) => cardFor(repo.getJobView(db, jobId), ctx);
  const send = async (name) => {
    const res = await postRequest(base, buildPreset(name, { settings }));
    assert.equal(res.status, 200, name);
    return { res, msg: lastMessage(db) };
  };
  assert.deepEqual(PRESETS.map((p) => p.id),
    ["rosa_yes", "lucia_repeat", "web_form_tony", "voicemail_carla", "forward_midway", "spam_call", "answered_call"]);

  let { res, msg } = await send("rosa_yes");
  assert.deepEqual([res.text, msg.status, msg.job_id], ["<Response/>", "attached", jobs.rosa]);
  assert.equal(card(jobs.rosa).bucket, "replied");
  assert.deepEqual(card(jobs.rosa).outcomes[0], { id: "yes", label: "Mark as yes?", primary: true, suggested: true, needs: "day_or_none" });

  ({ msg } = await send("lucia_repeat"));
  assert.equal(msg.status, "created_job");
  assert.notEqual(msg.job_id, jobs.lucia);
  const lucia = card(msg.job_id);
  assert.deepEqual([lucia.title, lucia.badges, lucia.source_label, lucia.bucket], ["Lucia's Market", ["Repeat - 1 past job"], "Text", "new"]);

  ({ res } = await send("web_form_tony"));
  assert.equal(res.json.status, "created_job");
  const tony = card(res.json.job_id);
  assert.deepEqual([tony.title, tony.bucket, tony.source_label, tony.badges], ["Tony's Bistro", "emergency", "Web form", ["URGENT"]]);
  assert.deepEqual(repo.getJobView(db, res.json.job_id).urgent, 1);
  assert.equal((await send("web_form_tony")).res.json.status, "duplicate");

  ({ msg } = await send("voicemail_carla"));
  assert.equal(msg.status, "created_job");
  const carla = card(msg.job_id);
  assert.deepEqual([carla.title, carla.subtitle, carla.bucket, carla.source_label], ["Westside Diner", "Carla", "emergency", "Voicemail"]);
  assert.equal(carla.reason, "Ice machine is leaking all over the kitchen floor - voicemail today 7:00am, nobody's called back");

  ({ msg } = await send("forward_midway"));
  assert.deepEqual([msg.status, msg.job_id, msg.forwarded], ["attached", jobs.midway, 1]);
  assert.equal(card(jobs.midway).bucket, "replied");

  ({ msg } = await send("spam_call"));
  assert.deepEqual([msg.status, msg.job_id], ["ignored", null]);

  ({ msg } = await send("answered_call"));
  assert.equal(msg.status, "created_job");
  const answered = card(msg.job_id);
  assert.deepEqual([answered.title, answered.reason], ["(312) 555-0168", "New - call today 7:00am - what was it about?"]);

  assert.equal(count(db, "jobs"), 7);
  assert.equal(repo.unlinkedMessageCount(db), 0);
  assert.equal(titleFor(repo.getJobView(db, jobs.midway)), "Midway Meats");
});

test("buildCustom covers the simulator's other formats", async () => {
  const { db, base } = await startApp();
  const vm = await postRequest(base, buildCustom({ channel: "call", from: "312-555-0170", call_status: "voicemail", body: "Walk-in cooler is warm" }));
  assert.equal(vm.text, "<Response/>");
  assert.equal(repo.getJobRow(db, lastMessage(db).job_id).source_detail, "voicemail");
  const raw = await postRequest(base, buildCustom({ channel: "email", from: "dave@hillside.example", body: "Need a price on an ice machine", format: "raw" }));
  assert.equal(raw.json.status, "created_job");
  const generic = await postRequest(base, buildCustom({ channel: "sms", from: "+13125550171", body: "hello", format: "generic" }));
  assert.equal(generic.json.status, "created_job");
  const formReq = await postRequest(base, buildCustom({ channel: "form", from: "312-555-0172", body: "Prep table is warm" }));
  assert.equal(formReq.json.status, "created_job");
  assert.deepEqual(all(db, "SELECT DISTINCT status FROM messages"), [{ status: "created_job" }]);
});

test("adapters: form detection, HTML stripping, form hashes, raw emails and the call mapping", () => {
  assert.equal(detectFormEmail("Thanks!\nPhone: 312-555-0142"), false);
  assert.equal(detectFormEmail("Name: Tony Russo / Business: Tony's Bistro"), true);
  assert.equal(detectFormEmail("name: Priya\nemail: p@x.example"), true);
  assert.equal(htmlToText("<div>Walk-in&nbsp;down</div><br><b>Call</b> &#8217;asap&#x21;<script>x()</script>"), "Walk-in down\n\nCall \u2019asap!");
  const hash = formExternalId({ body: "b", phone: "+13125550133", email: null }, "2026-10-05T11:02:00.000Z");
  assert.equal(hash, formExternalId({ body: "b", phone: "+13125550133", email: null }, "2026-10-05T11:09:59.000Z"));
  assert.notEqual(hash, formExternalId({ body: "b", phone: "+13125550133", email: null }, "2026-10-05T11:10:00.000Z"));
  // A pasted form body without headers is never eaten as a header block.
  const pasted = fromRawEmail("Name: Tony Russo\nPhone: (312) 555-0187\nMessage: Freezer warm");
  assert.deepEqual([pasted.channel, pasted.body, pasted.external_id], ["form", "Name: Tony Russo\nPhone: (312) 555-0187\nMessage: Freezer warm", null]);
  const mixed = fromRawEmail("Subject: freezer\nName: Tony Russo\nMessage: Freezer warm");
  assert.deepEqual([mixed.subject, mixed.body], [null, "Subject: freezer\nName: Tony Russo\nMessage: Freezer warm"]);
  const qp = fromRawEmail("From: a@b.example\nSubject: Hi\nContent-Transfer-Encoding: quoted-printable\n\nIt=E2=80=99s warm =\nnow");
  assert.deepEqual([qp.channel, qp.body, qp.subject], ["email", "It\u2019s warm now", "Hi"]);
  const call = (p) => fromTwilioVoice({ CallSid: "CA1", From: "+13125550177", ...p });
  assert.deepEqual([call({ CallStatus: "busy" }).call_status, call({ DialCallStatus: "no-answer", CallStatus: "completed" }).call_status,
    call({ CallStatus: "completed", DialCallStatus: "completed", DialCallDuration: "42", CallDuration: "50" }).call_duration_s,
    call({ CallStatus: "queued" }).call_status, call({ RecordingUrl: "https://x" }).body],
  ["missed", "missed", 42, null, "(voicemail - no transcript yet)"]);
});
