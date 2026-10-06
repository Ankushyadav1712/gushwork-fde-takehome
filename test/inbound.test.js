// Inbound HTTP routes (SPEC §7.2, §12.6, C1-C4): R01, R02, the guards (T21), every demo preset, and
// the intake review fixes that need the whole route (relay senders, forwarded email, form layouts, calls).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import { openDb, all, get } from "../server/db.js";
import * as repo from "../server/repo.js";
import { inboundRouter, INBOUND_PATHS, webhookUrlWarning } from "../server/routes/inbound.js";
import { resolvePublicUrl } from "../server/context.js";
import { buildPreset, buildCustom, encodeBody, PRESETS } from "../server/presets.js";
import { applyOutcome } from "../shared/stages.js";
import { cardFor } from "../shared/today-rules.js";
import { replyIntent } from "../shared/parse.js";
import { sourceLabel, titleFor } from "../shared/format.js";
import { telLink } from "../shared/templates.js";
import { atLocal } from "../shared/time.js";
import { eventsOf } from "./fixtures/history.js";

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
async function startApp({ now = A, demo, settings = {} } = {}) {
  const db = openDb(":memory:");
  repo.ensureSettings(db);
  repo.putSettings(db, settings);
  const app = express();
  const publicUrl = resolvePublicUrl(process.env);
  app.use(inboundRouter({ db, now: () => now, settings: () => repo.getSettings(db), demo, publicUrl }));
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

test("R01: a missed call creates the same new job via the Twilio form and generic JSON", async () => {
  const twilio = await startApp();
  const sim = buildCustom({ channel: "call", from: "(312) 555-0177", call_status: "missed" });
  const res = await postRequest(twilio.base, sim);
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

  const generic = await startApp();
  const r = await post(generic.base, "/api/inbound/call", json({ from: "(312) 555-0177", status: "missed", id: "call-1" }));
  assert.deepEqual([r.status, r.json.status], [200, "created_job"]);
  assert.deepEqual(jobShape(generic.db, r.json.job_id), shape);
});

test("C1: exactly one path per channel; the old /webhooks/* aliases are gone", async () => {
  assert.deepEqual(INBOUND_PATHS, { sms: "/api/inbound/sms", call: "/api/inbound/call", email: "/api/inbound/email", form: "/api/inbound/form" });
  const { db, base } = await startApp();
  for (const alias of ["/webhooks/twilio/sms", "/webhooks/sms", "/webhooks/twilio/voice", "/webhooks/voice",
    "/webhooks/postmark", "/webhooks/mailgun", "/webhooks/email", "/webhooks/form"]) {
    assert.equal((await post(base, alias, json({ from: "+13125550166", body: "walk-in down" }))).status, 404, alias);
  }
  assert.equal(count(db, "messages"), 0);
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
    const r = await post(base, "/api/inbound/email", { contentType, body: RAW_TONY });
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

/** Mailgun's signature fields for a token, timestamped `ageS` seconds before the real now. */
function mailgunSigned(token, ageS = 0) {
  const timestamp = String(Math.floor(Date.now() / 1000) - ageS);
  return { timestamp, token, signature: createHmac("sha256", "mg-key").update(`${timestamp}${token}`).digest("hex") };
}

test("C2: with MAILGUN_SIGNING_KEY set, email needs a fresh, unused Mailgun signature", withEnv({ MAILGUN_SIGNING_KEY: "mg-key" }, async () => {
  const { db, base } = await startApp();
  const payload = (id) => ({
    sender: "forms@frostline.example", from: "Frostline Website <forms@frostline.example>",
    subject: "New website form submission", "Message-Id": `<${id}@frostline.example>`,
    "body-plain": "Name: Linda Park\nBusiness: Maple Street Bakery\nPhone: 312-555-0138\nMessage: Reach-in door hinge broke",
  });
  const forbidden = async (body) => {
    const r = await post(base, "/api/inbound/email", body);
    assert.deepEqual([r.status, r.json.error.code], [403, "forbidden"]);
  };
  await forbidden(form({ ...payload("mg-0"), ...mailgunSigned("t0"), signature: "0".repeat(64) }));
  await forbidden(form({ ...payload("mg-0"), ...mailgunSigned("t0", 10 * 60) })); // stale
  await forbidden(json({ from: "ann@bistro.example", text: "Walk-in is warm", message_id: "g-1" })); // not signed at all
  await forbidden({ contentType: "text/plain", body: "From: ann@bistro.example\nSubject: hi\n\nWalk-in is warm" });
  assert.equal(count(db, "messages"), 0);

  const signed = mailgunSigned("t1");
  const good = await post(base, "/api/inbound/email", form({ ...payload("mg-1"), ...signed }));
  assert.deepEqual([good.status, good.json.status], [200, "created_job"]);
  const jv = repo.getJobView(db, good.json.job_id);
  assert.deepEqual([jv.source, jv.customer.business_name, jv.customer.phone], ["form", "Maple Street Bakery", "+13125550138"]);
  assert.equal(lastMessage(db).provider, "mailgun");
  await forbidden(form({ ...payload("mg-2"), ...signed })); // the same token again is a replay
  assert.equal(count(db, "messages"), 1);
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
  const r = await post(base, "/api/inbound/form", json(payload));
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
  const twilio = await post(base, "/api/inbound/sms", form({ MessageSid: "SMphoto", From: "+13125550166", Body: "look at this", NumMedia: "1" }));
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

// ---------------------------------------------------------------------------
// Guards (T21)

test("T21: with INBOUND_TOKEN set, a missing or wrong token gets 401 and writes nothing", withEnv({ INBOUND_TOKEN: "s3cret" }, async () => {
  const { db, base } = await startApp();
  const body = json({ from: "+13125550166", body: "walk-in down" });
  for (const path of ["/api/inbound/sms", "/api/inbound/sms?token=nope", "/api/inbound/form?token=s3cret2"]) {
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
    const path = "/api/inbound/sms?token=s3cret";
    const none = await post(base, path, form(params));
    assert.deepEqual([none.status, none.json.error.code], [403, "forbidden"]);
    const wrong = await post(base, path, { ...form(params), headers: { "X-Twilio-Signature": "bm9wZQ==" } });
    assert.equal(wrong.status, 403);
    const forOtherUrl = expectedTwilioSignature("twilio-secret", "https://callback.example/api/inbound/call?token=s3cret", params);
    assert.equal((await post(base, path, { ...form(params), headers: { "X-Twilio-Signature": forOtherUrl } })).status, 403);
    assert.equal(count(db, "messages"), 0);

    const signature = expectedTwilioSignature("twilio-secret", `https://callback.example${path}`, params);
    const good = await post(base, path, { ...form(params), headers: { "X-Twilio-Signature": signature } });
    assert.deepEqual([good.status, good.text], [200, "<Response/>"]);
    assert.equal(lastMessage(db).status, "created_job");
  },
));

test("C2: with TWILIO_AUTH_TOKEN set, sms and call need a signature whatever the payload shape (security RT-2)", withEnv(
  { TWILIO_AUTH_TOKEN: "twilio-secret", PUBLIC_URL: "https://callback.example" },
  async () => {
    const { db, base } = await startApp();
    const generic = {
      "/api/inbound/sms": { from: "+13125550402", body: "Walk-in freezer down at Fake Grill" },
      "/api/inbound/call": { from: "+13125550404", status: "voicemail", voicemail_text: "freezer down" },
    };
    for (const [path, body] of Object.entries(generic)) {
      assert.equal((await post(base, path, json(body))).status, 403, path);
      assert.equal((await post(base, path, form(body))).status, 403, path);
    }
    assert.equal(count(db, "messages"), 0);
    for (const [path, body] of Object.entries(generic)) {
      const signature = expectedTwilioSignature("twilio-secret", `https://callback.example${path}`, body);
      const signed = await post(base, path, { ...json(body), headers: { "X-Twilio-Signature": signature } });
      assert.deepEqual([signed.status, signed.json.status], [200, "created_job"], path);
    }
    // Email and form are not Twilio's: the Twilio key alone doesn't guard them.
    assert.equal((await post(base, "/api/inbound/form", json({ name: "Pat", phone: "3125550187", message: "Prep table warm" }))).status, 200);
  },
));

test("C2: boot warns when signatures are on but PUBLIC_URL can't be the address providers post to", () => {
  assert.equal(webhookUrlWarning({}), null);
  assert.equal(webhookUrlWarning({ TWILIO_AUTH_TOKEN: "t", PUBLIC_URL: "https://callback.example" }), null);
  assert.match(webhookUrlWarning({ TWILIO_AUTH_TOKEN: "t" }), /PUBLIC_URL is not set/);
  assert.match(webhookUrlWarning({ MAILGUN_SIGNING_KEY: "k", PUBLIC_URL: "http://localhost:3000" }), /localhost/);
  assert.match(webhookUrlWarning({ TWILIO_AUTH_TOKEN: "t", PUBLIC_URL: "http://127.0.0.1:4300/" }), /localhost/);
});

test("bodies over 1 MB get 413; an empty body gets 400; plain text to sms or call gets 415 (intake RT-6)", async () => {
  const { db, base } = await startApp();
  const big = await post(base, "/api/inbound/email", json({ from: "a@b.example", text: "x".repeat(1_100_000) }));
  assert.deepEqual([big.status, big.json.error.code], [413, "validation"]);
  const empty = await post(base, "/api/inbound/form", json({}));
  assert.equal(empty.status, 400);
  for (const path of ["/api/inbound/sms", "/api/inbound/call"]) {
    const text = await post(base, path, { contentType: "text/plain", body: "Freezer down at Joe's 312-555-7408" });
    assert.deepEqual([text.status, text.json.error.code], [415, "validation"], path);
    // curl's default content type turns a bare string into one empty field: nothing to call back.
    const stray = await fetch(base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "Freezer down" });
    assert.equal(stray.status, 400, path);
  }
  assert.equal(count(db, "messages"), 0);
  // The form route still reads plain text as the message.
  const formText = await post(base, "/api/inbound/form", { contentType: "text/plain", body: "Freezer down at Joe's 312-555-7408" });
  assert.equal(formText.json.status, "created_job");
  assert.equal(repo.getJobView(db, formText.json.job_id).customer.phone, "+13125557408");
});

test("a 1 MB hostile HTML email is answered quickly instead of freezing the server (security RT-1)", async () => {
  const { base } = await startApp();
  const start = performance.now();
  const r = await post(base, "/api/inbound/email", json({ from: "a@b.example", html: "<a".repeat(450_000), message_id: "redos-1" }));
  assert.equal(r.status, 200);
  assert.ok(performance.now() - start < 1000, "answered within a second");
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
  assert.ok(PRESETS.every((p) => typeof p.label === "string" && typeof p.note === "string" && p.note), "C11: every preset has a note");

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

// ---------------------------------------------------------------------------
// C4: who a lead is (intake RT-1, requirements RT-1)

/** A Postmark inbound email. */
function postmark({ id, from, name = "", subject = "New submission", text, html, headers = [] }) {
  return json({
    From: `${name} <${from}>`, FromFull: { Email: from, Name: name }, Subject: subject, MessageID: id,
    TextBody: text ?? "", HtmlBody: html ?? "", Headers: [{ Name: "Message-ID", Value: `<${id}@x>` }, ...headers],
  });
}

const customerOf = (db, jobId) => repo.getJobView(db, jobId).customer;

test("form mailers: each submission is its own customer, and blocking spam never blocks the mailer (intake RT-1)", async () => {
  const { db, base } = await startApp();
  const wix = (id, name, phone, email, message) => postmark({ id, from: "no-reply@crm.wix.com", name: "Wix Forms",
    text: `You have a new form submission.\n\nFull Name: ${name}\nPhone Number: ${phone}\nEmail: ${email}\nComments: ${message}\n` });
  const carla = await post(base, "/api/inbound/email", wix("wix-1", "Carla Diaz", "(312) 555-7201", "carla@diaz.example", "Display case not cooling"));
  const ben = await post(base, "/api/inbound/email", wix("wix-2", "Ben Ortiz", "(312) 555-7202", "ben@ortiz.example",
    "Walk-in freezer down, losing product, need someone today"));
  assert.deepEqual([carla.json.status, ben.json.status], ["created_job", "created_job"]);
  assert.notEqual(carla.json.customer_id, ben.json.customer_id);
  const benCustomer = customerOf(db, ben.json.job_id);
  assert.deepEqual([benCustomer.contact_name, benCustomer.phone, benCustomer.email], ["Ben Ortiz", "+13125557202", "ben@ortiz.example"]);
  assert.equal(repo.getJobRow(db, ben.json.job_id).urgent, 1);
  assert.equal(get(db, "SELECT count(*) AS n FROM customers WHERE email = 'no-reply@crm.wix.com'").n, 0);

  // WordPress HTML table: the cells give the name and problem. Blocking it blocks that sender only.
  const wordpress = (id, rows) => postmark({ id, from: "wordpress@frostline.example", name: "WordPress",
    html: `<table>${rows.map(([label, value]) => `<tr><td><b>${label}</b></td></tr><tr><td>${value}</td></tr>`).join("")}</table>` });
  const spam = await post(base, "/api/inbound/email", wordpress("wp-1", [["Name", "SEO Guru"], ["Message", "We can rank your site #1 on Google"]]));
  assert.deepEqual([customerOf(db, spam.json.job_id).contact_name, repo.getJobRow(db, spam.json.job_id).problem],
    ["SEO Guru", "We can rank your site #1 on Google"]);
  repo.updateCustomer(db, spam.json.customer_id, { blocked: 1 }, A);
  const real = await post(base, "/api/inbound/email", wordpress("wp-2",
    [["Name", "Rosa Alvarez"], ["Phone", "312-555-7299"], ["Message", "Walk-in freezer is down, losing product"]]));
  assert.equal(real.json.status, "created_job");
  assert.deepEqual([customerOf(db, real.json.job_id).contact_name, customerOf(db, real.json.job_id).phone], ["Rosa Alvarez", "+13125557299"]);
});

test("emails Denise forwards are known by the customer in them, not by her address (requirements RT-1)", async () => {
  const { db, base } = await startApp({ settings: { owner_email: "denise@frostline.example" } });
  const forward = (id, from, text, subject = "Fwd: service") => postmark({ id, from: "denise@frostline.example", name: "Denise Carter", subject,
    text: `---------- Forwarded message ---------\nFrom: ${from}\nDate: Mon, Oct 5, 2026 at 6:30 AM\nSubject: service\nTo: <denise@frostline.example>\n\n${text}\n` });
  const ann = await post(base, "/api/inbound/email", forward("f-1", "Ann Chef <ann@bistro.example>", "Our walk-in cooler is warm, call me 312-555-0181"));
  const bob = await post(base, "/api/inbound/email", forward("f-2", "Bob Grocer <bob@grocer.example>", "Ice machine not making ice. 312-555-0182"));
  assert.deepEqual([ann.json.status, bob.json.status], ["created_job", "created_job"]);
  assert.deepEqual([customerOf(db, bob.json.job_id).contact_name, customerOf(db, bob.json.job_id).phone], ["Bob Grocer", "+13125550182"]);
  assert.equal(get(db, "SELECT count(*) AS n FROM customers WHERE email IS NOT NULL").n, 0);

  // Her own address is never identity, even without a forward marker.
  const note = await post(base, "/api/inbound/email", postmark({ id: "f-3", from: "denise@frostline.example", subject: "note",
    text: "Harbor Grill reach-in is warm, 312-555-0125" }));
  assert.equal(customerOf(db, note.json.job_id).email, null);

  // Forwarded form notifications whose inner sender is the form mailer: two leads, two jobs.
  const formFwd = (id, business, phone, message) => forward(id, "Frostline Website <forms@frostline.example>",
    `Name: ${business}\nPhone: ${phone}\nMessage: ${message}`, "Fwd: New form submission");
  const doyle = await post(base, "/api/inbound/email", formFwd("f-4", "Doyle's Deli", "312-555-0131", "Walk-in is noisy"));
  const lee = await post(base, "/api/inbound/email", formFwd("f-5", "Lee's Noodle Bar", "312-555-0132", "Ice machine leaking"));
  assert.notEqual(doyle.json.customer_id, lee.json.customer_id);
  assert.equal(lee.json.status, "created_job");
});

test("a real customer's own emails still find their open job (no regression)", async () => {
  const { db, base } = await startApp();
  const first = await post(base, "/api/inbound/email", postmark({ id: "a-1", from: "nora@lakeviewbrewing.example", name: "Nora Lindqvist",
    subject: "Keg cooler", text: "Our keg cooler is warm." }));
  const second = await post(base, "/api/inbound/email", postmark({ id: "a-2", from: "Nora@LakeviewBrewing.example", name: "Nora Lindqvist",
    subject: "Re: Keg cooler", text: "Still warm this morning." }));
  assert.deepEqual([second.json.status, second.json.job_id], ["attached", first.json.job_id]);
  assert.equal(eventsOf(db, first.json.job_id)[0].summary, "Emailed back");
});

// ---------------------------------------------------------------------------
// Website-form webhooks with real-world field names (intake RT-9, requirements RT-4)

test("form webhooks: odd field names, bracket keys, nested data and split names become a callable job", async () => {
  const { db, base } = await startApp();
  const fox = await post(base, "/api/inbound/form", json({ "Your Name": "Mia Fox", "Company Name": "Fox Deli", "Phone #": "312.555.7304",
    "E-mail": "mia@foxdeli.example", "What's going on?": "deli case is warm", form_id: "contact-7", utm_source: "google" }));
  const ned = await post(base, "/api/inbound/form", form({ "fields[name]": "Ned", "fields[phone]": "3125557305",
    "fields[message]": "walk in cooler leaking", entry_id: "e-55" }));
  const oli = await post(base, "/api/inbound/form", json({ data: { name: "Oli", phone: "3125557306", message: "freezer warm" }, id: 991 }));
  const jo = await post(base, "/api/inbound/form", json({ "First Name": "Jo", "Last Name": "King", Phone: "312-555-0143", Message: "reach-in not cooling" }));
  const shape = (r) => {
    const jv = repo.getJobView(db, r.json.job_id);
    return [titleFor(jv), jv.customer.phone, jv.problem, jv.urgent];
  };
  assert.deepEqual(shape(fox), ["Fox Deli", "+13125557304", "Deli case is warm", 1]);
  assert.deepEqual(shape(ned), ["Ned", "+13125557305", "Walk in cooler leaking", 1]);
  assert.deepEqual(shape(oli), ["Oli", "+13125557306", "Freezer warm", 1]);
  assert.deepEqual(shape(jo), ["Jo King", "+13125550143", "Reach-in not cooling", 1]);
  assert.equal(repo.getMessage(db, fox.json.message_id).body, "deli case is warm");
});

// ---------------------------------------------------------------------------
// Calls (C3: intake RT-3, RT-7)

test("Phase 1 forwarded calls: a hang-up during the greeting is a missed call, not an answered one", async () => {
  const { db, base } = await startApp();
  const callback = (fields) => post(base, "/api/inbound/call", form({ AccountSid: "AC1", To: "+13125550105", ForwardedFrom: "+13125550100", ...fields }));
  await callback({ CallSid: "CA_C", From: "+13125557003", CallStatus: "ringing" });
  const completed = await callback({ CallSid: "CA_C", From: "+13125557003", CallStatus: "completed", CallDuration: "9" });
  assert.equal(completed.text, "<Response/>");
  const msg = lastMessage(db);
  assert.deepEqual([msg.status, msg.external_id, msg.call_status, count(db, "messages")], ["created_job", "CA_C", "missed", 1]);
  const card = cardFor(repo.getJobView(db, msg.job_id), { now: A, tz: TZ, settings: repo.getSettings(db) });
  assert.equal(card.source_label, "Missed call");

  await callback({ CallSid: "CA_D", From: "+13125557004", CallStatus: "completed", CallDuration: "25" });
  assert.equal(repo.getJobRow(db, lastMessage(db).job_id).source_detail, "missed");
});

test("Phase 2: a short answered call stays ignored when the parent status callback follows", async () => {
  const { db, base } = await startApp();
  const callback = (fields) => post(base, "/api/inbound/call", form({ AccountSid: "AC1", To: "+13125550105", From: "+13125557006", ...fields }));
  await callback({ CallSid: "CA_F", CallStatus: "in-progress", DialCallStatus: "completed", DialCallDuration: "8" });
  await callback({ CallSid: "CA_F", CallStatus: "completed", CallDuration: "30" });
  assert.deepEqual(all(db, "SELECT status, external_id, call_status, call_duration_s FROM messages"),
    [{ status: "ignored", external_id: "CA_F", call_status: "answered", call_duration_s: 8 }]);
  assert.equal(count(db, "jobs"), 0);
});
