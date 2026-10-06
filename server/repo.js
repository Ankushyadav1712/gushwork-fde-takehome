// Repository: every read and write the server makes against SQLite.
// Every function takes db first. Writes take explicit timestamps from the caller; nothing reads the clock.
import { randomBytes } from "node:crypto";
import { get, all, run, tx } from "./db.js";
import { normalizePhone } from "../shared/format.js";
import { normalizeEmail } from "../shared/parse.js";
import { DEFAULT_TZ } from "../shared/time.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_STAGES = ["done", "lost"];

/** Event kinds that only record that something happened; they never change job state (§5.6). */
const NON_STATE_EVENT_KINDS = ["notified", "call_tap", "text_tap", "tech_text", "ai_refined"];

const CUSTOMER_COLUMNS = [
  "id", "contact_name", "business_name", "phone", "email", "address", "notes", "blocked",
  "created_at", "updated_at",
];
const CUSTOMER_FIELDS = ["contact_name", "business_name", "phone", "email", "address", "notes"];
const CUSTOMER_EDITABLE = [...CUSTOMER_FIELDS, "blocked"];

const JOB_COLUMNS = [
  "id", "customer_id", "stage", "source", "source_detail", "problem", "details", "equipment",
  "urgent", "urgent_source", "ai_not_service", "parsed_by", "quote_amount", "quote_sent_at",
  "visit_date", "tech", "notes", "created_at", "updated_at", "stage_entered_at",
  "first_touch_at", "last_touch_at", "next_due_at", "snoozed_until", "unread_inbound_at",
  "attempts", "nudges", "won_at", "done_at", "lost_at", "lost_reason", "closed_at",
];

const MESSAGE_COLUMNS = [
  "id", "received_at", "channel", "provider", "external_id", "call_status", "call_duration_s",
  "from_phone", "from_email", "from_name", "subject", "body", "forwarded", "raw_json", "status",
  "job_id", "customer_id", "parse_json", "error",
];

const EVENT_COLUMNS = [
  "id", "job_id", "at", "kind", "actor", "summary", "data_json", "prev_json", "message_id", "undone",
];

const OUTBOX_COLUMNS = [
  "id", "created_at", "kind", "to_phone", "to_name", "body", "job_id", "dedupe_key", "status",
  "provider_id", "error",
];

// ---------------------------------------------------------------------------
// Generic row helpers

/** JSON columns accept objects and store them stringified; strings are stored as given. */
function toJsonText(value) {
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseJsonText(text) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Throw on any key that is not a real column, so typos never silently drop data. */
function assertColumns(table, columns, row) {
  for (const key of Object.keys(row)) {
    if (!columns.includes(key)) throw new Error(`Unknown ${table} column: ${key}`);
  }
}

/** Keep defined values only; booleans become 0/1 (null is kept, undefined is dropped). */
function definedEntries(row) {
  return Object.entries(row)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, typeof value === "boolean" ? (value ? 1 : 0) : value]);
}

function insertRow(db, table, columns, row) {
  assertColumns(table, columns, row);
  const entries = definedEntries(row);
  const names = entries.map(([key]) => key);
  const sql = names.length
    ? `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
    : `INSERT INTO ${table} DEFAULT VALUES`;
  return run(db, sql, entries.map(([, value]) => value)).lastInsertRowid;
}

function updateRow(db, table, columns, id, patch) {
  assertColumns(table, columns, patch);
  if ("id" in patch) throw new Error(`Cannot change ${table}.id`);
  const entries = definedEntries(patch);
  if (!entries.length) return 0;
  const sets = entries.map(([key]) => `${key} = ?`).join(", ");
  return run(db, `UPDATE ${table} SET ${sets} WHERE id = ?`, [...entries.map(([, v]) => v), id]).changes;
}

/** Letters and digits only, lowercased: "Rosa's Taqueria" -> "rosastaqueria". */
function squash(text) {
  return String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function isBlank(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

// ---------------------------------------------------------------------------
// Settings (§6). Values are stored as JSON text.

export const SETTINGS_DEFAULTS = Object.freeze({
  company_name: "Frostline Refrigeration",
  owner_name: "Denise",
  owner_phone: "+13125550100",
  owner_email: null, // her own address, so emails she forwards aren't taken for the customer's
  husband_name: "Rick",
  husband_phone: "+13125550108",
  techs: Object.freeze([
    Object.freeze({ name: "Luis", phone: "+13125550121" }),
    Object.freeze({ name: "Mike", phone: "+13125550122" }),
    Object.freeze({ name: "Dee", phone: "+13125550123" }),
    Object.freeze({ name: "Sam", phone: "+13125550124" }),
  ]),
  timezone: DEFAULT_TZ,
  digest_time: "07:00",
  friday_sweep: true,
  weekend_digest: true,
  auto_ack_enabled: false,
  auto_ack_text: "Hi, it's Denise at {company}. Got your message - I'll call you back as soon as I can.",
  readonly_key: null, // generated by ensureSettings
  clock_offset_ms: 0,
});

const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS);

/** 24 characters of base64url. */
function newReadonlyKey() {
  return randomBytes(18).toString("base64url");
}

/**
 * Write any missing settings with their defaults (existing values are kept) and create
 * readonly_key if there is none. `initial` overrides defaults for keys written now, e.g. timezone.
 */
export function ensureSettings(db, initial = {}) {
  return tx(db, () => {
    const stored = new Set(all(db, "SELECT key FROM settings").map((row) => row.key));
    const missing = {};
    for (const key of SETTINGS_KEYS) {
      if (!stored.has(key)) missing[key] = key in initial ? initial[key] : SETTINGS_DEFAULTS[key];
    }
    const settings = putSettings(db, missing);
    return settings.readonly_key ? settings : putSettings(db, { readonly_key: newReadonlyKey() });
  });
}

/** Every known setting: stored values over defaults. Unknown stored keys are ignored. */
export function getSettings(db) {
  const settings = structuredClone({ ...SETTINGS_DEFAULTS });
  for (const row of all(db, "SELECT key, value FROM settings")) {
    if (SETTINGS_KEYS.includes(row.key)) settings[row.key] = parseJsonText(row.value);
  }
  return settings;
}

/** Save known keys from `partial` (unknown and undefined values are ignored). Returns all settings. */
export function putSettings(db, partial = {}) {
  for (const [key, value] of Object.entries(partial)) {
    if (!SETTINGS_KEYS.includes(key) || value === undefined) continue;
    run(
      db,
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, JSON.stringify(value)],
    );
  }
  return getSettings(db);
}

// ---------------------------------------------------------------------------
// Customers and matching (§7.3)

export function getCustomer(db, id) {
  return get(db, "SELECT * FROM customers WHERE id = ?", [id]);
}

/** Exact E.164 match. */
export function findCustomerByPhone(db, phone) {
  const e164 = normalizePhone(phone);
  return e164 ? get(db, "SELECT * FROM customers WHERE phone = ?", [e164]) : null;
}

/** Exact, lowercased email match (oldest customer first if several share it). */
export function findCustomerByEmail(db, email) {
  const clean = normalizeEmail(email);
  return clean ? get(db, "SELECT * FROM customers WHERE email = ? ORDER BY id LIMIT 1", [clean]) : null;
}

/**
 * Forwarded texts: the one customer whose business_name (letters and digits only, lowercased)
 * appears in the text. Zero or several candidates -> null.
 */
export function findCustomerByBusinessInText(db, text) {
  const haystack = squash(text);
  if (!haystack) return null;
  const rows = all(db, "SELECT * FROM customers WHERE business_name IS NOT NULL");
  const hits = rows.filter((row) => {
    const name = squash(row.business_name);
    return name !== "" && haystack.includes(name);
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * §7.3 match order: phone, then email, then (forwarded texts only) business name in the text.
 * A phone that matches nobody marks a different person, so email is then not tried (C4).
 * Returns the customer row (blocked customers included; the caller decides) or null.
 */
export function matchCustomer(db, { phone = null, email = null, text = null, forwarded = false } = {}) {
  const byPhoneOrEmail = normalizePhone(phone) ? findCustomerByPhone(db, phone) : findCustomerByEmail(db, email);
  return byPhoneOrEmail ?? (forwarded ? findCustomerByBusinessInText(db, text) : null);
}

/** Customer fields normalised for storage: E.164 phone, one plain lowercased email (else null). */
function cleanCustomerFields(fields) {
  const clean = { ...fields };
  if ("phone" in clean) clean.phone = normalizePhone(clean.phone);
  if ("email" in clean) clean.email = normalizeEmail(clean.email);
  return clean;
}

function pickCustomerFields(fields) {
  const picked = {};
  for (const key of CUSTOMER_EDITABLE) if (fields[key] !== undefined) picked[key] = fields[key];
  return picked;
}

/** Insert a customer from the known fields in `fields` (others are ignored). Returns the new row. */
export function createCustomer(db, fields, now) {
  const row = { ...cleanCustomerFields(pickCustomerFields(fields ?? {})), created_at: now, updated_at: now };
  const id = insertRow(db, "customers", CUSTOMER_COLUMNS, row);
  return getCustomer(db, id);
}

/**
 * Fill only the customer's blank fields from `fields`; existing values are never overwritten.
 * A phone already used by another customer is skipped. Returns the (possibly unchanged) row.
 */
export function fillCustomerBlanks(db, id, fields, now) {
  const current = getCustomer(db, id);
  if (!current) return null;
  const incoming = cleanCustomerFields(pickCustomerFields(fields ?? {}));
  const patch = {};
  for (const key of CUSTOMER_FIELDS) {
    if (isBlank(current[key]) && !isBlank(incoming[key])) patch[key] = incoming[key];
  }
  if (patch.phone) {
    const owner = findCustomerByPhone(db, patch.phone);
    if (owner && owner.id !== id) delete patch.phone;
  }
  if (!Object.keys(patch).length) return current;
  updateRow(db, "customers", CUSTOMER_COLUMNS, id, { ...patch, updated_at: now });
  return getCustomer(db, id);
}

/** Overwrite customer fields. Throws on keys that are not editable customer fields. */
export function updateCustomer(db, id, patch, now) {
  for (const key of Object.keys(patch)) {
    if (!CUSTOMER_EDITABLE.includes(key)) throw new Error(`Unknown customers column: ${key}`);
  }
  updateRow(db, "customers", CUSTOMER_COLUMNS, id, { ...cleanCustomerFields(patch), updated_at: now });
  return getCustomer(db, id);
}

// ---------------------------------------------------------------------------
// Jobs

/** Insert a job. Keys must be real columns. Returns the new id. */
export function insertJob(db, row) {
  return insertRow(db, "jobs", JOB_COLUMNS, row);
}

export function getJobRow(db, id) {
  return get(db, "SELECT * FROM jobs WHERE id = ?", [id]);
}

/** Patch a job (the caller includes updated_at). Throws on unknown keys. Returns the updated row. */
export function updateJob(db, id, patch) {
  updateRow(db, "jobs", JOB_COLUMNS, id, patch);
  return getJobRow(db, id);
}

/** Delete a job and its history. Only for a job no message or text points at (a just-spawned one). */
export function deleteJob(db, id) {
  tx(db, () => {
    run(db, "DELETE FROM events WHERE job_id = ?", [id]);
    run(db, "DELETE FROM jobs WHERE id = ?", [id]);
  });
}

const JOB_VIEW_SELECT = `
  SELECT ${JOB_COLUMNS.map((col) => `j.${col}`).join(", ")},
    c.contact_name AS c_contact_name, c.business_name AS c_business_name, c.phone AS c_phone,
    c.email AS c_email, c.address AS c_address, c.blocked AS c_blocked,
    m.received_at AS m_at, m.channel AS m_channel, m.call_status AS m_call_status, m.body AS m_body,
    (SELECT count(*) FROM jobs p
      WHERE p.customer_id = j.customer_id AND p.created_at < j.created_at) AS past_jobs
  FROM jobs j
  JOIN customers c ON c.id = j.customer_id
  LEFT JOIN messages m ON m.id = (
    SELECT lm.id FROM messages lm WHERE lm.job_id = j.id ORDER BY lm.received_at DESC, lm.id DESC LIMIT 1
  )`;

/** Split one flat JOB_VIEW_SELECT row into the JobView shape (§6). */
function toJobView(flat) {
  const view = {};
  for (const col of JOB_COLUMNS) view[col] = flat[col];
  view.customer = {
    id: flat.customer_id,
    contact_name: flat.c_contact_name,
    business_name: flat.c_business_name,
    phone: flat.c_phone,
    email: flat.c_email,
    address: flat.c_address,
    blocked: flat.c_blocked,
  };
  view.last_inbound = flat.m_at == null ? null : {
    at: flat.m_at,
    channel: flat.m_channel,
    call_status: flat.m_call_status,
    body: flat.m_body,
  };
  view.past_jobs = flat.past_jobs;
  return view;
}

function scopeClause(scope, now) {
  const closed = CLOSED_STAGES.map((s) => `'${s}'`).join(", ");
  if (scope === "open") return { sql: `j.stage NOT IN (${closed})`, params: [] };
  if (scope === "all") return null;
  if (scope === "closed30") {
    if (!now) throw new Error("getJobViews: scope 'closed30' needs now");
    const cutoff = new Date(Date.parse(now) - 30 * DAY_MS).toISOString();
    return { sql: `j.stage IN (${closed}) AND j.closed_at >= ?`, params: [cutoff] };
  }
  throw new Error(`getJobViews: unknown scope ${scope}`);
}

/** q matches business, contact or problem (case-insensitive), or 3+ digits against the phone's digits. */
function searchClause(q) {
  const text = String(q ?? "").trim().toLowerCase();
  if (!text) return null;
  const parts = ["instr(lower(c.business_name), ?) > 0", "instr(lower(c.contact_name), ?) > 0",
    "instr(lower(j.problem), ?) > 0"];
  const params = [text, text, text];
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 3) {
    parts.push("instr(replace(c.phone, '+', ''), ?) > 0");
    params.push(digits);
  }
  return { sql: `(${parts.join(" OR ")})`, params };
}

/**
 * JobViews (§6) in one query: job row + customer + last_inbound + past_jobs, ordered by id.
 * opts: scope 'open' (default) | 'closed30' | 'all'; stage; ids; customer_id; q; now (for closed30).
 */
export function getJobViews(db, { scope = "open", stage, ids, customer_id, q, now } = {}) {
  const clauses = [scopeClause(scope, now), searchClause(q)];
  if (stage) clauses.push({ sql: "j.stage = ?", params: [stage] });
  if (ids) clauses.push({ sql: "j.id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(ids.map(Number))] });
  if (customer_id != null) clauses.push({ sql: "j.customer_id = ?", params: [customer_id] });
  const active = clauses.filter(Boolean);
  const where = active.length ? ` WHERE ${active.map((c) => c.sql).join(" AND ")}` : "";
  const rows = all(db, `${JOB_VIEW_SELECT}${where} ORDER BY j.id`, active.flatMap((c) => c.params));
  return rows.map(toJobView);
}

export function getJobView(db, id) {
  return getJobViews(db, { scope: "all", ids: [id] })[0] ?? null;
}

/** The customer's other jobs as JobViews, newest first. */
export function listPastJobs(db, customerId, excludeJobId = null) {
  return getJobViews(db, { scope: "all", customer_id: customerId })
    .filter((view) => view.id !== excludeJobId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
}

/** The customer's open job rows, most recently updated first (ingest attaches to the first). */
export function openJobsForCustomer(db, customerId) {
  return all(
    db,
    "SELECT * FROM jobs WHERE customer_id = ? AND stage NOT IN ('done', 'lost') ORDER BY updated_at DESC, id DESC",
    [customerId],
  );
}

// ---------------------------------------------------------------------------
// Messages (raw inbound log, §7.5)

/** Accepts raw / parse objects (raw_json / parse_json win when both are given) and stores JSON text. */
function messageRowForWrite(row) {
  const { raw, parse, ...rest } = row;
  const out = { ...rest };
  if (raw !== undefined && out.raw_json === undefined) out.raw_json = raw;
  if (parse !== undefined && out.parse_json === undefined) out.parse_json = parse;
  if ("raw_json" in out) out.raw_json = toJsonText(out.raw_json);
  if ("parse_json" in out) out.parse_json = toJsonText(out.parse_json);
  return out;
}

/** Adds parsed `raw` and `parse` next to the stored raw_json / parse_json text. */
function parseMessageRow(row) {
  if (!row) return null;
  const raw = parseJsonText(row.raw_json);
  return { ...row, raw: raw ?? row.raw_json, parse: parseJsonText(row.parse_json) };
}

/** Insert a message (raw_json defaults to "{}" when nothing is given). Returns the new id. */
export function insertMessage(db, row) {
  const out = messageRowForWrite(row);
  if (out.raw_json == null) out.raw_json = "{}";
  return insertRow(db, "messages", MESSAGE_COLUMNS, out);
}

export function updateMessage(db, id, patch) {
  updateRow(db, "messages", MESSAGE_COLUMNS, id, messageRowForWrite(patch));
  return getMessage(db, id);
}

export function getMessage(db, id) {
  return parseMessageRow(get(db, "SELECT * FROM messages WHERE id = ?", [id]));
}

export function findMessageByExternal(db, channel, externalId) {
  if (externalId == null) return null;
  return parseMessageRow(
    get(db, "SELECT * FROM messages WHERE channel = ? AND external_id = ?", [channel, String(externalId)]),
  );
}

/** Latest messages first. */
export function listMessages(db, limit = 50) {
  return all(db, "SELECT * FROM messages ORDER BY received_at DESC, id DESC LIMIT ?", [limit])
    .map(parseMessageRow);
}

/** Messages never linked to a job (§7.5). Must always be 0. */
export function unlinkedMessageCount(db) {
  return get(
    db,
    "SELECT count(*) AS n FROM messages WHERE status IN ('received', 'error') AND job_id IS NULL",
  ).n;
}

// ---------------------------------------------------------------------------
// Events (timeline and undo)

/** Adds parsed `data` and `prev` next to the stored data_json / prev_json text. */
function parseEventRow(row) {
  if (!row) return null;
  return { ...row, data: parseJsonText(row.data_json), prev: parseJsonText(row.prev_json) };
}

/**
 * Insert an event. row: job_id, at, kind, actor, summary, data (object), prev (object), message_id.
 * Returns the new id.
 */
export function insertEvent(db, row) {
  const { data, prev, ...rest } = row;
  const out = { ...rest };
  if (data !== undefined) out.data_json = data;
  if (prev !== undefined) out.prev_json = prev;
  if ("data_json" in out) out.data_json = toJsonText(out.data_json);
  if ("prev_json" in out) out.prev_json = toJsonText(out.prev_json);
  return insertRow(db, "events", EVENT_COLUMNS, out);
}

export function getEvent(db, id) {
  return parseEventRow(get(db, "SELECT * FROM events WHERE id = ?", [id]));
}

/** The job's most recently written event that changes state (undone ones included), or null. */
export function latestStateEvent(db, jobId) {
  const skip = NON_STATE_EVENT_KINDS.map((kind) => `'${kind}'`).join(", ");
  return parseEventRow(
    get(db, `SELECT * FROM events WHERE job_id = ? AND kind NOT IN (${skip}) ORDER BY id DESC LIMIT 1`, [jobId]),
  );
}

export function markUndone(db, id) {
  return run(db, "UPDATE events SET undone = 1 WHERE id = ?", [id]).changes;
}

// ---------------------------------------------------------------------------
// Outbox (§11)

const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** Insert a text. Returns the new id, or null when dedupe_key was already used. */
export function insertOutbox(db, row) {
  try {
    return insertRow(db, "outbox", OUTBOX_COLUMNS, row);
  } catch (err) {
    if (err.errcode === SQLITE_CONSTRAINT_UNIQUE && /outbox\.dedupe_key/.test(err.message)) return null;
    throw err;
  }
}

export function updateOutbox(db, id, patch) {
  updateRow(db, "outbox", OUTBOX_COLUMNS, id, patch);
  return getOutbox(db, id);
}

export function getOutbox(db, id) {
  return get(db, "SELECT * FROM outbox WHERE id = ?", [id]);
}

/** Latest texts first. */
export function listOutbox(db, limit = 50) {
  return all(db, "SELECT * FROM outbox ORDER BY created_at DESC, id DESC LIMIT ?", [limit]);
}

/** How many texts of `kind` were queued after `sinceIso`, to one number when `toPhone` is given. */
export function countOutboxSince(db, kind, sinceIso, toPhone = null) {
  const byPhone = toPhone == null ? "" : " AND to_phone = ?";
  const params = toPhone == null ? [kind, sinceIso] : [kind, sinceIso, toPhone];
  return get(db, `SELECT count(*) AS n FROM outbox WHERE kind = ? AND created_at > ?${byPhone}`, params).n;
}

/** Delete outbox rows created after `iso` (the demo clock moved backwards). Returns the count. */
export function deleteOutboxAfter(db, iso) {
  return run(db, "DELETE FROM outbox WHERE created_at > ?", [iso]).changes;
}

// ---------------------------------------------------------------------------
// Event maintenance

/** Delete events of the given kinds dated after `iso` (the demo clock moved backwards). */
export function deleteEventsAfter(db, iso, kinds) {
  if (!kinds?.length) return 0;
  const marks = kinds.map(() => "?").join(", ");
  return run(db, `DELETE FROM events WHERE at > ? AND kind IN (${marks})`, [iso, ...kinds]).changes;
}

/** Rewrite the timeline line of the events tied to a message (e.g. a voicemail transcript arrived later). */
export function updateEventSummary(db, messageId, kind, summary) {
  return run(db, "UPDATE events SET summary = ? WHERE message_id = ? AND kind = ?", [summary, messageId, kind]).changes;
}

// ---------------------------------------------------------------------------
// Server secrets: kept in the settings table under "secret:<name>". getSettings() never returns
// them (it only reads SETTINGS_DEFAULTS keys), so they can't leak through /api/settings.

/** The stored secret `name`, created once (32 random bytes, base64url) and reused across restarts. */
export function getOrCreateSecret(db, name) {
  const key = `secret:${name}`;
  const row = get(db, "SELECT value FROM settings WHERE key = ?", [key]);
  if (row) return parseJsonText(row.value);
  const value = randomBytes(32).toString("base64url");
  run(db, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", [key, JSON.stringify(value)]);
  return parseJsonText(get(db, "SELECT value FROM settings WHERE key = ?", [key]).value);
}
