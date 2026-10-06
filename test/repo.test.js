import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, get, all, run, tx, wipe, SCHEMA_VERSION } from "../server/db.js";
import {
  SETTINGS_DEFAULTS, ensureSettings, getSettings, putSettings,
  getCustomer, findCustomerByPhone, findCustomerByEmail, findCustomerByBusinessInText, matchCustomer,
  createCustomer, fillCustomerBlanks, updateCustomer,
  insertJob, getJobRow, updateJob, deleteJob, getJobView, getJobViews, listPastJobs, openJobsForCustomer,
  insertMessage, updateMessage, findMessageByExternal, getMessage, listMessages,
  unlinkedMessageCount,
  insertEvent, latestStateEvent, getEvent, markUndone, updateEventSummary, deleteEventsAfter,
  insertOutbox, updateOutbox, listOutbox, countOutboxSince, deleteOutboxAfter, getOrCreateSecret,
} from "../server/repo.js";
import { eventsOf, outboxRow } from "./fixtures/history.js";

const A = "2026-10-05T12:00:00.000Z"; // Mon 2026-10-05 07:00 America/Chicago

/** ISO instant `minutes` before A. */
function before(minutes) {
  return new Date(Date.parse(A) - minutes * 60000).toISOString();
}

function freshDb() {
  return openDb(":memory:");
}

/** A minimal valid open job for a customer, with overrides. */
function openJob(customerId, overrides = {}) {
  return {
    customer_id: customerId, stage: "new", source: "sms",
    created_at: A, updated_at: A, stage_entered_at: A, next_due_at: A,
    ...overrides,
  };
}

function closedJob(customerId, stage, closedAt, overrides = {}) {
  return openJob(customerId, {
    stage, next_due_at: null, closed_at: closedAt, created_at: before(60 * 24 * 60), ...overrides,
  });
}

function message(overrides = {}) {
  return {
    received_at: A, channel: "sms", provider: "twilio", body: "hello", raw: { Body: "hello" },
    status: "received", ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema

test("openDb creates the §6 schema with pragmas and user_version", () => {
  const db = freshDb();
  const tables = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  assert.deepEqual(tables, ["customers", "events", "jobs", "messages", "outbox", "settings"]);
  assert.equal(get(db, "PRAGMA user_version").user_version, 1);
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(get(db, "PRAGMA foreign_keys").foreign_keys, 1);
  const indexes = all(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name);
  assert.deepEqual(indexes, [
    "customers_email", "customers_phone", "events_job", "jobs_customer", "jobs_due", "jobs_stage",
    "messages_external", "messages_job",
  ]);
});

test("openDb creates the parent directory, uses WAL, and reopening keeps data", () => {
  const dir = mkdtempSync(join(tmpdir(), "callback-repo-"));
  try {
    const path = join(dir, "nested", "callback.db");
    const db = openDb(path);
    assert.ok(existsSync(path));
    assert.equal(get(db, "PRAGMA journal_mode").journal_mode, "wal");
    createCustomer(db, { business_name: "Joe's Diner" }, A);
    db.close();
    const again = openDb(path);
    assert.equal(get(again, "PRAGMA user_version").user_version, 1);
    assert.equal(get(again, "SELECT count(*) AS n FROM customers").n, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T02 (SQL): the CHECK rejects a closed job with next_due_at and an open job without it", () => {
  const db = freshDb();
  const c = createCustomer(db, { phone: "+13125550142" }, A);
  assert.throws(() => insertJob(db, openJob(c.id, { stage: "done", next_due_at: A, closed_at: A })),
    /CHECK constraint failed/);
  assert.throws(() => insertJob(db, openJob(c.id, { stage: "lost", next_due_at: A, closed_at: A })),
    /CHECK constraint failed/);
  assert.throws(() => insertJob(db, openJob(c.id, { stage: "quote", next_due_at: null })), /CHECK constraint failed/);
  for (const stage of ["new", "quote", "waiting_yes", "to_schedule", "scheduled"]) {
    assert.equal(typeof insertJob(db, openJob(c.id, { stage })), "number");
  }
  const done = insertJob(db, closedJob(c.id, "done", A));
  assert.throws(() => updateJob(db, done, { next_due_at: A }), /CHECK constraint failed/);
  const open = insertJob(db, openJob(c.id));
  assert.throws(() => updateJob(db, open, { next_due_at: null }), /CHECK constraint failed/);
  assert.throws(() => updateJob(db, open, { stage: "done" }), /CHECK constraint failed/);
  assert.equal(updateJob(db, open, { stage: "done", next_due_at: null, closed_at: A }).stage, "done");
});

test("other CHECKs and foreign keys hold", () => {
  const db = freshDb();
  const c = createCustomer(db, {}, A);
  assert.throws(() => insertJob(db, openJob(c.id, { stage: "open" })), /CHECK/);
  assert.throws(() => insertJob(db, openJob(c.id, { source: "fax" })), /CHECK/);
  assert.throws(() => insertJob(db, openJob(999)), /FOREIGN KEY/);
  assert.throws(() => insertMessage(db, message({ status: "weird" })), /CHECK/);
});

test("run returns numbers; get returns null when empty; helpers bind undefined/booleans safely", () => {
  const db = freshDb();
  const res = run(db, "INSERT INTO settings (key, value) VALUES (?, ?)", ["x", "1"]);
  assert.deepEqual(res, { changes: 1, lastInsertRowid: 1 });
  assert.equal(get(db, "SELECT * FROM customers WHERE id = ?", [1]), null);
  const row = get(db, "SELECT $a AS a, $b AS b", { a: undefined, b: true });
  assert.deepEqual(row, { a: null, b: 1 });
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
});

test("tx commits, rolls back on error, and nested tx joins the outer one", () => {
  const db = freshDb();
  tx(db, () => createCustomer(db, { business_name: "Kept" }, A));
  assert.throws(() => tx(db, () => {
    createCustomer(db, { business_name: "Gone" }, A);
    tx(db, () => createCustomer(db, { business_name: "Also gone" }, A));
    throw new Error("boom");
  }), /boom/);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(all(db, "SELECT business_name FROM customers").map((r) => r.business_name), ["Kept"]);
  assert.equal(tx(db, () => 42), 42);
  assert.throws(() => tx(db, async () => 1), /synchronous/);
  assert.equal(db.isTransaction, false);
});

test("wipe deletes every row in FK-safe order and keeps the schema", () => {
  const db = freshDb();
  ensureSettings(db);
  const c = createCustomer(db, { phone: "3125550142" }, A);
  const jobId = insertJob(db, openJob(c.id));
  const msgId = insertMessage(db, message({ job_id: jobId, customer_id: c.id, status: "created_job" }));
  insertEvent(db, { job_id: jobId, at: A, kind: "created", actor: "customer", summary: "Texted", message_id: msgId });
  insertOutbox(db, { created_at: A, kind: "nag", to_phone: "+13125550100", body: "x", job_id: jobId,
    dedupe_key: "nag:1", status: "simulated" });
  wipe(db);
  for (const table of ["settings", "customers", "jobs", "messages", "events", "outbox"]) {
    assert.equal(get(db, `SELECT count(*) AS n FROM ${table}`).n, 0, table);
  }
  const again = createCustomer(db, {}, A);
  assert.equal(insertJob(db, openJob(again.id)), 1, "ids restart at 1 so the seed gets job ids 1..18");
});

// ---------------------------------------------------------------------------
// Settings

test("ensureSettings writes the §6 defaults and a 24-char base64url readonly_key", () => {
  const db = freshDb();
  const s = ensureSettings(db);
  assert.equal(s.company_name, "Frostline Refrigeration");
  assert.equal(s.owner_name, "Denise");
  assert.equal(s.owner_phone, "+13125550100");
  assert.equal(s.husband_name, "Rick");
  assert.equal(s.husband_phone, "+13125550108");
  assert.deepEqual(s.techs, [
    { name: "Luis", phone: "+13125550121" },
    { name: "Mike", phone: "+13125550122" },
    { name: "Dee", phone: "+13125550123" },
    { name: "Sam", phone: "+13125550124" },
  ]);
  assert.equal(s.timezone, "America/Chicago");
  assert.equal(s.digest_time, "07:00");
  assert.equal(s.friday_sweep, true);
  assert.equal(s.weekend_digest, true);
  assert.equal(s.auto_ack_enabled, false);
  assert.equal(s.auto_ack_text,
    "Hi, it's Denise at {company}. Got your message - I'll call you back as soon as I can.");
  assert.equal(s.clock_offset_ms, 0);
  assert.equal(s.owner_email, null);
  assert.match(s.readonly_key, /^[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(Object.keys(s).sort(), Object.keys(SETTINGS_DEFAULTS).sort());
  assert.equal(get(db, "SELECT count(*) AS n FROM settings").n, Object.keys(SETTINGS_DEFAULTS).length);
  assert.equal(get(db, "SELECT value FROM settings WHERE key = 'friday_sweep'").value, "true");

  // A second ensure keeps existing values, including the key.
  putSettings(db, { owner_name: "Dee Dee" });
  const again = ensureSettings(db);
  assert.equal(again.readonly_key, s.readonly_key);
  assert.equal(again.owner_name, "Dee Dee");
});

test("ensureSettings takes initial values for keys it writes", () => {
  const db = freshDb();
  assert.equal(ensureSettings(db, { timezone: "America/Denver" }).timezone, "America/Denver");
  assert.equal(ensureSettings(db, { timezone: "America/New_York" }).timezone, "America/Denver");
});

test("putSettings saves known keys only and getSettings returns copies", () => {
  const db = freshDb();
  ensureSettings(db);
  const s = putSettings(db, { auto_ack_enabled: true, digest_time: "06:30", techs: [{ name: "Ana", phone: null }],
    bogus: "x", owner_name: undefined });
  assert.equal(s.auto_ack_enabled, true);
  assert.equal(s.digest_time, "06:30");
  assert.deepEqual(s.techs, [{ name: "Ana", phone: null }]);
  assert.equal(s.owner_name, "Denise");
  assert.equal("bogus" in s, false);
  assert.equal(get(db, "SELECT count(*) AS n FROM settings WHERE key = 'bogus'").n, 0);
  s.techs.push({ name: "Mutated" });
  assert.equal(getSettings(db).techs.length, 1);
  assert.equal(getSettings(freshDb()).techs.length, 4, "defaults without a stored row");
});

// ---------------------------------------------------------------------------
// Customers and matching

test("createCustomer normalises phone and email; finders match exactly", () => {
  const db = freshDb();
  const rosa = createCustomer(db, { contact_name: "Rosa Medina", business_name: "Rosa's Taqueria",
    phone: "(312) 555-0118", email: " Rosa@Example.COM ", junk: "ignored" }, A);
  assert.deepEqual(rosa, {
    id: 1, contact_name: "Rosa Medina", business_name: "Rosa's Taqueria", phone: "+13125550118",
    email: "rosa@example.com", address: null, notes: null, blocked: 0, created_at: A, updated_at: A,
  });
  assert.equal(findCustomerByPhone(db, "+13125550118").id, rosa.id);
  assert.equal(findCustomerByPhone(db, "+13125550119"), null);
  assert.equal(findCustomerByPhone(db, null), null);
  assert.equal(findCustomerByEmail(db, "ROSA@example.com").id, rosa.id);
  assert.equal(findCustomerByEmail(db, "rosa@example.org"), null);
  assert.equal(getCustomer(db, 99), null);
  assert.throws(() => createCustomer(db, { phone: "+13125550118" }, A), /UNIQUE/);
  // An address with a query, a list or spaces is not an address (security RT-4).
  for (const email of ["chef@bistro.example?cc=billing@attacker.example", "a@b.example, c@d.example", "a b@c.example"]) {
    assert.equal(createCustomer(db, { email }, A).email, null, email);
  }
  assert.equal(findCustomerByEmail(db, "rosa@example.com?bcc=x@y.example"), null);
});

test("matchCustomer: phone, then email, then business name for forwarded texts only", () => {
  const db = freshDb();
  const midway = createCustomer(db, { business_name: "Midway Meats", phone: "+13125550174" }, A);
  const fresh = createCustomer(db, { business_name: "Fresh Mart #2", email: "priya.shah@freshmart.example" }, A);
  const other = createCustomer(db, { business_name: "Lakeview Brewing Co.", phone: "+13125550151" }, A);

  assert.equal(matchCustomer(db, { phone: "+13125550174" }).id, midway.id);
  // Phone wins over email when both match different customers.
  assert.equal(matchCustomer(db, { phone: "+13125550151", email: "priya.shah@freshmart.example" }).id, other.id);
  // No phone: email matches. A phone that matches nobody is a different person: no email fallback (C4).
  assert.equal(matchCustomer(db, { email: "Priya.Shah@FreshMart.example" }).id, fresh.id);
  assert.equal(matchCustomer(db, { phone: "+13125550999", email: "Priya.Shah@FreshMart.example" }), null);
  // Unless the email is the sender's own address: a customer writing with a new number (intake-N1).
  assert.equal(matchCustomer(db, { phone: "+13125550999", email: "priya.shah@freshmart.example", emailIsSender: true }).id, fresh.id);
  assert.equal(matchCustomer(db, { phone: "+13125550151", email: "priya.shah@freshmart.example", emailIsSender: true }).id, other.id,
    "a phone that matches still wins");
  assert.equal(matchCustomer(db, { phone: "555-0199", email: "priya.shah@freshmart.example" }).id, fresh.id,
    "a phone that doesn't normalize counts as no phone");

  const text = "Midway Meats: hey denise any update on that freezer door quote?";
  assert.equal(matchCustomer(db, { phone: null, text, forwarded: true }).id, midway.id);
  assert.equal(matchCustomer(db, { phone: null, text, forwarded: false }), null, "not forwarded: no name match");
  assert.equal(matchCustomer(db, { text: "FRESHMART 2 - the deli machine", forwarded: true }).id, fresh.id,
    "compared on letters and digits only");
  assert.equal(matchCustomer(db, { text: "who is this", forwarded: true }), null);
  assert.equal(matchCustomer(db, {}), null);
});

test("findCustomerByBusinessInText needs exactly one customer", () => {
  const db = freshDb();
  createCustomer(db, { business_name: "Joe's Diner" }, A);
  createCustomer(db, { business_name: "Golden Wok" }, A);
  createCustomer(db, { business_name: "!!!" }, A); // squashes to nothing; never matches
  assert.equal(findCustomerByBusinessInText(db, "from joes diner: can you come?").business_name, "Joe's Diner");
  assert.equal(findCustomerByBusinessInText(db, "Joe's Diner and Golden Wok both called"), null);
  assert.equal(findCustomerByBusinessInText(db, "!!! anyone"), null);
  assert.equal(findCustomerByBusinessInText(db, ""), null);
  createCustomer(db, { business_name: "JOES DINER" }, A);
  assert.equal(findCustomerByBusinessInText(db, "joe's diner"), null, "two customers share the name");
});

test("blocked customers still match (the caller decides what to do with them)", () => {
  const db = freshDb();
  const c = createCustomer(db, { phone: "+13125550155" }, A);
  const blocked = updateCustomer(db, c.id, { blocked: 1 }, before(-5));
  assert.equal(blocked.blocked, 1);
  assert.equal(blocked.updated_at, before(-5));
  assert.equal(matchCustomer(db, { phone: "+13125550155" }).blocked, 1);
});

test("fillCustomerBlanks never overwrites existing values", () => {
  const db = freshDb();
  const c = createCustomer(db, { contact_name: "Lucia Ortiz", phone: "+13125550101", address: "" }, before(60));
  const taken = createCustomer(db, { phone: "+13125550102" }, before(60));
  const filled = fillCustomerBlanks(db, c.id, {
    contact_name: "Someone Else", business_name: "Lucia's Market", phone: "+13125550199",
    email: "LUCIA@market.example", address: "1645 W 18th St", notes: "  ",
  }, A);
  assert.equal(filled.contact_name, "Lucia Ortiz");
  assert.equal(filled.phone, "+13125550101");
  assert.equal(filled.business_name, "Lucia's Market");
  assert.equal(filled.email, "lucia@market.example");
  assert.equal(filled.address, "1645 W 18th St", "empty string counts as blank");
  assert.equal(filled.notes, null, "blank incoming values are ignored");
  assert.equal(filled.updated_at, A);

  const noPhone = createCustomer(db, { business_name: "No phone yet" }, before(60));
  assert.equal(fillCustomerBlanks(db, noPhone.id, { phone: "+13125550102" }, A).phone, null,
    "a phone owned by another customer is skipped");
  assert.equal(getCustomer(db, taken.id).phone, "+13125550102");
  const unchanged = fillCustomerBlanks(db, c.id, { contact_name: "X" }, before(-60));
  assert.equal(unchanged.updated_at, A, "nothing filled, nothing touched");
  assert.equal(fillCustomerBlanks(db, 999, {}, A), null);
});

test("updateCustomer overwrites and rejects unknown keys", () => {
  const db = freshDb();
  const c = createCustomer(db, { contact_name: "Ray", phone: "+13125550183" }, before(60));
  const updated = updateCustomer(db, c.id, { contact_name: "Ray Dawson", phone: "312-555-0184" }, A);
  assert.equal(updated.contact_name, "Ray Dawson");
  assert.equal(updated.phone, "+13125550184");
  assert.equal(updated.updated_at, A);
  assert.throws(() => updateCustomer(db, c.id, { nickname: "R" }, A), /Unknown customers column: nickname/);
});

// ---------------------------------------------------------------------------
// Jobs and JobViews

test("insertJob / updateJob reject unknown columns; booleans become 0/1", () => {
  const db = freshDb();
  const c = createCustomer(db, {}, A);
  assert.throws(() => insertJob(db, { ...openJob(c.id), title: "x" }), /Unknown jobs column: title/);
  const id = insertJob(db, openJob(c.id, { urgent: true, problem: "Freezer down" }));
  assert.equal(getJobRow(db, id).urgent, 1);
  assert.throws(() => updateJob(db, id, { stagee: "quote" }), /Unknown jobs column: stagee/);
  assert.throws(() => updateJob(db, id, { id: 5 }), /Cannot change jobs.id/);
  const row = updateJob(db, id, { urgent: false, attempts: 2, tech: undefined, updated_at: before(-1) });
  assert.equal(row.urgent, 0);
  assert.equal(row.attempts, 2);
  assert.equal(row.updated_at, before(-1));
  assert.equal(getJobRow(db, 999), null);
});

test("getJobViews builds the §6 JobView: customer, last_inbound and past_jobs", () => {
  const db = freshDb();
  const rosa = createCustomer(db, { contact_name: "Rosa Medina", business_name: "Rosa's Taqueria",
    phone: "+13125550118", address: "3540 W 26th St" }, before(90 * 24 * 60));
  const past = insertJob(db, closedJob(rosa.id, "done", before(50 * 24 * 60), { created_at: before(60 * 24 * 60) }));
  const job7 = insertJob(db, openJob(rosa.id, { stage: "waiting_yes", created_at: before(6 * 24 * 60),
    quote_amount: 2400, problem: "Walk-in cooler compressor short cycling" }));
  insertMessage(db, message({ received_at: before(6 * 24 * 60), body: "short cycling", job_id: job7,
    customer_id: rosa.id, status: "created_job" }));
  insertMessage(db, message({ received_at: before(30), body: "yes go ahead, thursday works for us",
    job_id: job7, customer_id: rosa.id, status: "attached" }));
  insertMessage(db, message({ received_at: before(20), body: "unrelated", status: "ignored" }));

  const views = getJobViews(db, { scope: "open" });
  assert.equal(views.length, 1);
  const v = views[0];
  assert.equal(v.id, job7);
  assert.equal(v.stage, "waiting_yes");
  assert.equal(v.quote_amount, 2400);
  assert.deepEqual(v.customer, { id: rosa.id, contact_name: "Rosa Medina", business_name: "Rosa's Taqueria",
    phone: "+13125550118", email: null, address: "3540 W 26th St", blocked: 0 });
  assert.deepEqual(v.last_inbound, { at: before(30), channel: "sms", call_status: null,
    body: "yes go ahead, thursday works for us" });
  assert.equal(v.past_jobs, 1);

  const pastView = getJobView(db, past);
  assert.equal(pastView.past_jobs, 0);
  assert.equal(pastView.last_inbound, null);
  assert.equal(getJobView(db, 999), null);

  assert.deepEqual(getJobViews(db, { scope: "all" }).map((j) => j.id), [past, job7]);
  assert.deepEqual(getJobViews(db, { scope: "all", stage: "done" }).map((j) => j.id), [past]);
  assert.deepEqual(getJobViews(db, { scope: "all", ids: [job7] }).map((j) => j.id), [job7]);
  assert.deepEqual(getJobViews(db, { scope: "all", ids: [] }), []);
  assert.throws(() => getJobViews(db, { scope: "closed" }), /unknown scope/);
});

test("getJobViews q matches business, contact, problem, or 3+ phone digits", () => {
  const db = freshDb();
  const bella = createCustomer(db, { contact_name: "Marco Rossi", business_name: "Bella Cucina",
    phone: "+13125550142" }, A);
  const unknown = createCustomer(db, { phone: "+13125550177" }, A);
  const sal = createCustomer(db, { contact_name: "Sal Romano", business_name: "Sal's Pizza",
    phone: "+13125550190" }, A);
  const j1 = insertJob(db, openJob(bella.id, { problem: "Walk-in freezer at 28 degrees and climbing" }));
  const j2 = insertJob(db, openJob(unknown.id, { source: "call", source_detail: "missed" }));
  const j3 = insertJob(db, openJob(sal.id, { problem: "Prep table cooler fan grinding" }));
  const ids = (q) => getJobViews(db, { q }).map((j) => j.id);
  assert.deepEqual(ids("bella"), [j1]);
  assert.deepEqual(ids("  CUCINA "), [j1]);
  assert.deepEqual(ids("marco"), [j1]);
  assert.deepEqual(ids("FREEZER"), [j1]);
  assert.deepEqual(ids("sal's"), [j3]);
  assert.deepEqual(ids("555-0177"), [j2]);
  assert.deepEqual(ids("(312) 555"), [j1, j2, j3]);
  assert.deepEqual(ids("0190"), [j3]);
  assert.deepEqual(ids("01"), [], "fewer than 3 digits never matches phones");
  assert.deepEqual(ids("nothing like this"), []);
  assert.deepEqual(ids(""), [j1, j2, j3]);
});

test("getJobViews closed30 returns done/lost jobs closed in the last 30 days", () => {
  const db = freshDb();
  const c = createCustomer(db, {}, A);
  const recentDone = insertJob(db, closedJob(c.id, "done", before(10 * 24 * 60)));
  const recentLost = insertJob(db, closedJob(c.id, "lost", before(29 * 24 * 60), { lost_reason: "price" }));
  insertJob(db, closedJob(c.id, "done", before(31 * 24 * 60)));
  insertJob(db, openJob(c.id));
  const edge = insertJob(db, closedJob(c.id, "lost", before(30 * 24 * 60)));
  assert.deepEqual(getJobViews(db, { scope: "closed30", now: A }).map((j) => j.id), [recentDone, recentLost, edge]);
  assert.deepEqual(getJobViews(db, { scope: "closed30", stage: "lost", now: A }).map((j) => j.id),
    [recentLost, edge]);
  assert.throws(() => getJobViews(db, { scope: "closed30" }), /needs now/);
});

test("listPastJobs and openJobsForCustomer", () => {
  const db = freshDb();
  const lucia = createCustomer(db, { business_name: "Lucia's Market", phone: "+13125550101" }, A);
  const other = createCustomer(db, { phone: "+13125550102" }, A);
  const old = insertJob(db, closedJob(lucia.id, "done", before(21 * 24 * 60), { created_at: before(22 * 24 * 60) }));
  const a = insertJob(db, openJob(lucia.id, { created_at: before(60), updated_at: before(50) }));
  const b = insertJob(db, openJob(lucia.id, { created_at: before(40), updated_at: before(45) }));
  insertJob(db, openJob(other.id));
  assert.deepEqual(listPastJobs(db, lucia.id, b).map((j) => j.id), [a, old]);
  assert.equal(listPastJobs(db, lucia.id, b)[1].customer.business_name, "Lucia's Market");
  assert.deepEqual(openJobsForCustomer(db, lucia.id).map((j) => j.id), [b, a], "most recently updated first");
  updateJob(db, a, { updated_at: A });
  assert.equal(openJobsForCustomer(db, lucia.id)[0].id, a);
  assert.deepEqual(openJobsForCustomer(db, 999), []);
});

test("R25: getJobViews over 100 open jobs is well under 200 ms", () => {
  const db = freshDb();
  tx(db, () => {
    for (let i = 0; i < 40; i++) {
      const c = createCustomer(db, { business_name: `Customer ${i}`, phone: `+1312555${String(1000 + i)}` }, A);
      for (let k = 0; k < 3; k++) insertJob(db, closedJob(c.id, "done", before(5 * 24 * 60)));
    }
    for (let i = 0; i < 100; i++) {
      const jobId = insertJob(db, openJob((i % 40) + 1, { created_at: before(100 - i), problem: `Problem ${i}` }));
      for (let k = 0; k < 3; k++) {
        insertMessage(db, message({ received_at: before(100 - i - k), job_id: jobId, status: "attached",
          body: `msg ${k}` }));
      }
      insertEvent(db, { job_id: jobId, at: A, kind: "created", actor: "customer", summary: "Texted" });
    }
  });
  getJobViews(db); // warm the statement cache
  const start = performance.now();
  const views = getJobViews(db, { scope: "open" });
  const ms = performance.now() - start;
  assert.equal(views.length, 100);
  assert.equal(views[0].past_jobs, 3);
  assert.equal(views[0].last_inbound.body, "msg 2", "the latest of its 3 messages");
  assert.ok(ms < 200, `getJobViews took ${ms.toFixed(1)} ms`);
});

// ---------------------------------------------------------------------------
// Messages

test("messages: insert, external lookup, JSON parsing, listing and unlinked count", () => {
  const db = freshDb();
  const c = createCustomer(db, { phone: "+13125550118" }, A);
  const jobId = insertJob(db, openJob(c.id));
  const raw = { MessageSid: "SM1", Body: "hello", From: "+13125550118" };
  const m1 = insertMessage(db, message({ external_id: "SM1", raw, forwarded: true, received_at: before(10) }));
  const got = getMessage(db, m1);
  assert.equal(got.raw_json, JSON.stringify(raw));
  assert.deepEqual(got.raw, raw);
  assert.equal(got.parse, null);
  assert.equal(got.forwarded, 1);
  assert.equal(findMessageByExternal(db, "sms", "SM1").id, m1);
  assert.equal(findMessageByExternal(db, "email", "SM1"), null);
  assert.equal(findMessageByExternal(db, "sms", null), null);
  assert.throws(() => insertMessage(db, message({ external_id: "SM1" })), /UNIQUE/);
  assert.throws(() => insertMessage(db, message({ nope: 1 })), /Unknown messages column: nope/);

  const rawText = "From: a@b.example\nSubject: hi\n\nbody";
  const m2 = insertMessage(db, message({ channel: "email", provider: "raw", raw_json: rawText }));
  assert.equal(getMessage(db, m2).raw_json, rawText, "a string raw_json is stored verbatim");
  assert.equal(getMessage(db, m2).raw, rawText);

  assert.equal(unlinkedMessageCount(db), 2);
  const parse = { rules: { problem: "x" }, ai: null, merged: { problem: "x" } };
  const updated = updateMessage(db, m1, { status: "created_job", job_id: jobId, parse });
  assert.deepEqual(updated.parse, parse);
  assert.equal(unlinkedMessageCount(db), 1);
  updateMessage(db, m2, { status: "error", error: "parser blew up" });
  assert.equal(unlinkedMessageCount(db), 1, "error rows without a job still count");
  updateMessage(db, m2, { job_id: jobId });
  assert.equal(unlinkedMessageCount(db), 0);
  insertMessage(db, message({ status: "ignored" }));
  insertMessage(db, message({ status: "blocked" }));
  assert.equal(unlinkedMessageCount(db), 0, "ignored and blocked rows are fine unlinked");

  assert.deepEqual(listMessages(db, 2).map((m) => m.id), [4, 3]);
  assert.deepEqual(listMessages(db).map((m) => m.id), [4, 3, 2, 1]);
});

// ---------------------------------------------------------------------------
// Events

test("events: insert with data/prev objects, newest-first listing, undo flags", () => {
  const db = freshDb();
  const c = createCustomer(db, {}, A);
  const jobId = insertJob(db, openJob(c.id));
  const prev = getJobRow(db, jobId);
  const e1 = insertEvent(db, { job_id: jobId, at: before(30), kind: "created", actor: "customer",
    summary: "Voicemail came in" });
  const e2 = insertEvent(db, { job_id: jobId, at: before(10), kind: "outcome", actor: "denise",
    summary: "Quote sent - $2,400", data: { outcome: "quote_sent", args: { amount: 2400 } }, prev });
  const got = getEvent(db, e2);
  assert.deepEqual(got.data, { outcome: "quote_sent", args: { amount: 2400 } });
  assert.deepEqual(got.prev, prev);
  assert.equal(got.undone, 0);
  assert.equal(getEvent(db, e1).data, null);
  assert.deepEqual(eventsOf(db, jobId).map((e) => e.id), [e2, e1]);
  assert.equal(markUndone(db, e2), 1);
  assert.equal(getEvent(db, e2).undone, 1);
  assert.throws(() => insertEvent(db, { job_id: jobId, at: A, kind: "x", actor: "robot", summary: "s" }), /CHECK/);
});

test("latestStateEvent ignores notified, call_tap, text_tap, tech_text and ai_refined", () => {
  const db = freshDb();
  const c = createCustomer(db, {}, A);
  const jobId = insertJob(db, openJob(c.id));
  assert.equal(latestStateEvent(db, jobId), null);
  const outcome = insertEvent(db, { job_id: jobId, at: before(10), kind: "outcome", actor: "denise",
    summary: "No answer (try 1)" });
  for (const kind of ["notified", "call_tap", "text_tap", "tech_text", "ai_refined"]) {
    insertEvent(db, { job_id: jobId, at: before(5), kind, actor: "system", summary: kind });
  }
  assert.equal(latestStateEvent(db, jobId).id, outcome);
  const inbound = insertEvent(db, { job_id: jobId, at: before(1), kind: "inbound", actor: "customer",
    summary: "Texted back" });
  assert.equal(latestStateEvent(db, jobId).id, inbound);
});

// ---------------------------------------------------------------------------
// Outbox

test("outbox: dedupe_key conflicts return null; update and listing", () => {
  const db = freshDb();
  const text = { created_at: A, kind: "digest", to_phone: "+13125550100", to_name: "Denise",
    body: "Morning Denise - 10 to call today:", dedupe_key: "digest:2026-10-05", status: "simulated" };
  const id = insertOutbox(db, text);
  assert.equal(typeof id, "number");
  assert.equal(insertOutbox(db, { ...text, body: "again" }), null);
  assert.equal(get(db, "SELECT count(*) AS n FROM outbox").n, 1);
  assert.throws(() => insertOutbox(db, { ...text, dedupe_key: "digest:x", kind: "spam" }), /CHECK/);

  const manual1 = insertOutbox(db, { ...text, kind: "manual", dedupe_key: null, created_at: before(-1) });
  const manual2 = insertOutbox(db, { ...text, kind: "manual", dedupe_key: null, created_at: before(-2) });
  assert.ok(manual1 && manual2, "null dedupe keys never conflict");

  const sent = updateOutbox(db, id, { status: "sent", provider_id: "SM123" });
  assert.equal(sent.status, "sent");
  assert.equal(sent.provider_id, "SM123");
  assert.equal(outboxRow(db, "digest:2026-10-05").id, id);
  assert.deepEqual(listOutbox(db).map((o) => o.id), [manual2, manual1, id]);
  assert.deepEqual(listOutbox(db, 1).map((o) => o.id), [manual2]);
});

test("countOutboxSince counts one kind after a time, optionally to one number", () => {
  const db = freshDb();
  const ack = (to, minutesAgo) => insertOutbox(db, { created_at: before(minutesAgo), kind: "auto_ack", to_phone: to, body: "x", status: "simulated" });
  ack("+13125550166", 30);
  ack("+13125550166", 90);
  ack("+13125550167", 10);
  insertOutbox(db, { created_at: before(5), kind: "digest", to_phone: "+13125550100", body: "x", status: "simulated" });
  assert.equal(countOutboxSince(db, "auto_ack", before(60)), 2);
  assert.equal(countOutboxSince(db, "auto_ack", before(120), "+13125550166"), 2);
  assert.equal(countOutboxSince(db, "auto_ack", before(60), "+13125550166"), 1);
  assert.equal(countOutboxSince(db, "digest", before(1)), 0);
});

// ---------------------------------------------------------------------------
// Maintenance helpers (the scheduler, the demo clock and auth)

test("deleteOutboxAfter and deleteEventsAfter remove only the rows asked for", () => {
  const db = freshDb();
  ensureSettings(db);
  const c = createCustomer(db, { business_name: "Helper Diner" }, A).id;
  const jobId = insertJob(db, {
    customer_id: c, stage: "new", source: "manual", created_at: A,
    updated_at: A, stage_entered_at: A, next_due_at: A,
  });
  for (const at of [A, "2026-10-12T12:00:00.000Z"]) {
    insertOutbox(db, { created_at: at, kind: "digest", to_phone: "+13125550100", body: "x", dedupe_key: `digest:${at}`, status: "simulated" });
    insertEvent(db, { job_id: jobId, at, kind: "notified", actor: "system", summary: "In your morning text" });
    insertEvent(db, { job_id: jobId, at, kind: "outcome", actor: "denise", summary: "No answer (try 1)" });
  }
  assert.equal(deleteOutboxAfter(db, "2026-10-06T00:00:00.000Z"), 1);
  assert.deepEqual(listOutbox(db).map((row) => row.created_at), [A]);
  assert.equal(deleteEventsAfter(db, "2026-10-06T00:00:00.000Z", ["notified"]), 1);
  assert.deepEqual(eventsOf(db, jobId).map((e) => e.kind).sort(), ["notified", "outcome", "outcome"]);
});

test("deleteJob removes the job and its history", () => {
  const db = freshDb();
  const c = createCustomer(db, { business_name: "Spawned Diner" }, A).id;
  const keep = insertJob(db, openJob(c));
  const gone = insertJob(db, openJob(c));
  insertEvent(db, { job_id: gone, at: A, kind: "created", actor: "denise", summary: "Extra work found at the Fri visit" });
  deleteJob(db, gone);
  assert.equal(getJobRow(db, gone), null);
  assert.equal(eventsOf(db, gone).length, 0);
  assert.ok(getJobRow(db, keep));
});

test("updateEventSummary rewrites the line for one message and kind", () => {
  const db = freshDb();
  const c = createCustomer(db, { phone: "+13125550177" }, A).id;
  const jobId = insertJob(db, {
    customer_id: c, stage: "new", source: "call", source_detail: "missed", created_at: A,
    updated_at: A, stage_entered_at: A, next_due_at: A,
  });
  const msg = insertMessage(db, {
    received_at: A, channel: "call", provider: "twilio", body: "", raw: {}, status: "created_job", job_id: jobId,
  });
  insertEvent(db, { job_id: jobId, at: A, kind: "created", actor: "customer", summary: "Missed call", message_id: msg });
  assert.equal(updateEventSummary(db, msg, "created", "Voicemail came in"), 1);
  assert.equal(eventsOf(db, jobId)[0].summary, "Voicemail came in");
});

test("getOrCreateSecret is stable and never appears in getSettings", () => {
  const db = freshDb();
  ensureSettings(db);
  const a = getOrCreateSecret(db, "session");
  assert.equal(typeof a, "string");
  assert.ok(a.length >= 40);
  assert.equal(getOrCreateSecret(db, "session"), a);
  assert.ok(!JSON.stringify(getSettings(db)).includes(a));
});
