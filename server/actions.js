// The actions that change data (§5): outcome taps, stage moves, undo, edits, Call/Text taps,
// settings and "Send now". Every job action runs in one transaction and logs an event holding the
// job row before it (prev_json) and the columns it changed, so Undo puts back only those (§5.6)
// and never a later AI read. Each action takes ctx = contextFor(db, now) from the caller.
import { randomBytes } from "node:crypto";
import { tx } from "./db.js";
import * as repo from "./repo.js";
import { send } from "./notify.js";
import { applyOutcome, moveStage, stageLabel, EQUIPMENT } from "../shared/stages.js";
import { buildToday, digestText } from "../shared/today-rules.js";
import { titleFor, normalizePhone } from "../shared/format.js";
import { normalizeEmail } from "../shared/parse.js";
import { isYmd, nextBusinessDay, startOfDay } from "../shared/time.js";

const UNDO_WINDOW_MS = 10 * 60 * 1000;
const MAX_TECHS = 6;
const EQUIPMENT_IDS = EQUIPMENT.map((e) => e.id);

/** An error with an HTTP status and an ApiError code (§13.4); the app's error handler renders it. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const invalid = (message) => new ApiError(400, "validation", message);
const notFound = () => new ApiError(404, "not_found", "That job isn't here.");

export function loadJob(db, jobId) {
  const jv = Number.isInteger(jobId) ? repo.getJobView(db, jobId) : null;
  if (!jv) throw notFound();
  return jv;
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k] ?? null]));

// ---------------------------------------------------------------------------
// Outcome, stage move, undo (§5.1, §5.6, §5.7)

function checkExpectedStage(jv, expected) {
  if (expected != null && expected !== "" && expected !== jv.stage) {
    throw new ApiError(409, "stale_stage", `This job already moved to ${stageLabel(jv.stage)}.`);
  }
}

/** Write the patch and its event in the caller's transaction. The event keeps the row before it. */
function commitChange(db, jv, { patch, event, customerPatch = null }, now) {
  const prev = repo.getJobRow(db, jv.id);
  const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== prev[key]));
  const changedKeys = Object.keys(changes);
  if (changedKeys.length) repo.updateJob(db, jv.id, changes);
  const data = { ...event.data, changed_keys: changedKeys };
  if (customerPatch && Object.keys(customerPatch).length) {
    data.customer_prev = pick(repo.getCustomer(db, jv.customer_id), Object.keys(customerPatch));
    repo.updateCustomer(db, jv.customer_id, customerPatch, now);
  }
  return repo.insertEvent(db, {
    job_id: jv.id, at: now, kind: event.kind, actor: "denise", summary: event.summary, data, prev,
  });
}

/** The picker values an outcome or stage move may carry. */
function actionArgs(body) {
  const args = {};
  for (const key of ["visit_date", "tech", "amount", "lost_reason", "snooze_until", "block"]) {
    if (body[key] !== undefined) args[key] = body[key];
  }
  return args;
}

/** The new job "Needs a quote for more work" opens, with its "created" history line. */
function insertSpawnedJob(db, { job, event }, now) {
  const jobId = repo.insertJob(db, job);
  repo.insertEvent(db, { job_id: jobId, at: now, kind: event.kind, actor: "denise", summary: event.summary });
  return jobId;
}

/**
 * One outcome tap (§5.1): load, expected_stage check, applyOutcome, update, event with prev_json.
 * Returns {job_id, event_id, toast, spawned_job_id}. Throws ApiError / OutcomeError.
 */
export function performOutcome(db, jobId, body, ctx) {
  return tx(db, () => {
    const jv = loadJob(db, jobId);
    checkExpectedStage(jv, body.expected_stage);
    const result = applyOutcome(jv, body.outcome, actionArgs(body), ctx);
    const spawnedJobId = result.spawn ? insertSpawnedJob(db, result.spawn, ctx.now) : null;
    const event = { ...result.event, kind: body.outcome === "seen" ? "seen" : result.event.kind };
    if (spawnedJobId) event.data = { ...event.data, spawned_job_id: spawnedJobId };
    const eventId = commitChange(db, jv, { patch: result.patch, event, customerPatch: result.customer_patch }, ctx.now);
    return { job_id: jv.id, event_id: eventId, toast: result.toast, spawned_job_id: spawnedJobId };
  });
}

/** Job detail stage picker (§5.7): enterStage through moveStage. Not contact. */
export function performStage(db, jobId, body, ctx) {
  return tx(db, () => {
    const jv = loadJob(db, jobId);
    checkExpectedStage(jv, body.expected_stage);
    const result = moveStage(jv, body.to, actionArgs(body), ctx);
    const eventId = commitChange(db, jv, result, ctx.now);
    return { job_id: jv.id, event_id: eventId, toast: result.toast };
  });
}

function undoAllowed(event, latest, jobId, now) {
  return Boolean(event) && event.job_id === jobId && latest?.id === event.id && !event.undone
    && event.prev != null && Date.parse(now) - Date.parse(event.at) < UNDO_WINDOW_MS;
}

/** Undo takes back the job "Needs a quote for more work" opened, unless she has worked on it since. */
function removeSpawnedJob(db, jobId) {
  if (repo.latestStateEvent(db, jobId)?.kind === "created") repo.deleteJob(db, jobId);
}

/** §5.6: put back the columns the event changed, mark it undone, log "Undid: …". */
export function performUndo(db, jobId, eventId, ctx) {
  return tx(db, () => {
    const job = repo.getJobRow(db, jobId);
    if (!job) throw notFound();
    const event = Number.isInteger(eventId) ? repo.getEvent(db, eventId) : null;
    if (!undoAllowed(event, repo.latestStateEvent(db, jobId), jobId, ctx.now)) {
      throw new ApiError(409, "undo_not_allowed", "That can't be undone anymore.");
    }
    const changedKeys = event.data?.changed_keys ?? [];
    if (changedKeys.length) repo.updateJob(db, jobId, pick(event.prev, changedKeys));
    if (event.data?.customer_prev) repo.updateCustomer(db, job.customer_id, event.data.customer_prev, ctx.now);
    if (event.data?.spawned_job_id) removeSpawnedJob(db, event.data.spawned_job_id);
    repo.markUndone(db, event.id);
    repo.insertEvent(db, {
      job_id: jobId, at: ctx.now, kind: "undo", actor: "denise", summary: `Undid: ${event.summary}`,
      data: { event_id: event.id },
    });
    return { job_id: jobId };
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:id (inline edits in Job detail)

const JOB_EDIT_KEYS = ["equipment", "problem", "details", "urgent", "quote_amount", "visit_date", "tech", "notes"];
const CUSTOMER_EDIT_KEYS = ["contact_name", "business_name", "phone", "email", "address"];
const EDIT_LABELS = {
  contact_name: "contact", business_name: "business name", phone: "phone", email: "email", address: "address",
  equipment: "equipment", problem: "problem", details: "details", quote_amount: "quote amount",
  visit_date: "visit date", tech: "tech", notes: "notes", urgent: "urgent",
};

function textValue(value, key) {
  if (value == null) return null;
  if (typeof value !== "string" && typeof value !== "number") throw invalid(`${EDIT_LABELS[key]} must be text.`);
  const s = String(value).trim();
  return s === "" ? null : s;
}

/** Validated, normalised value for one editable field. */
function editValue(key, value) {
  switch (key) {
    case "urgent":
      if (![true, false, 0, 1].includes(value)) throw invalid("urgent must be true or false.");
      return value ? 1 : 0;
    case "quote_amount": {
      if (value == null || value === "") return null;
      const n = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0) throw invalid("The quote amount must be a whole-dollar number.");
      return Math.round(n);
    }
    case "visit_date": {
      const s = textValue(value, key);
      if (s != null && !isYmd(s)) throw invalid("The visit date must look like 2026-10-14.");
      return s;
    }
    case "equipment": {
      const s = textValue(value, key);
      if (s != null && !EQUIPMENT_IDS.includes(s)) throw invalid(`Unknown equipment: ${s}`);
      return s;
    }
    case "phone": {
      const s = textValue(value, key);
      if (s == null) return null;
      const phone = normalizePhone(s);
      if (!phone) throw invalid("That phone number doesn't look right.");
      return phone;
    }
    case "email": {
      const s = textValue(value, key);
      const email = normalizeEmail(s);
      if (s != null && !email) throw invalid("That email address doesn't look right.");
      return email;
    }
    default:
      return textValue(value, key);
  }
}

/** Split a PATCH body into changed job and customer fields. Unknown keys are refused. */
function editPatches(jv, body) {
  const jobPatch = {};
  const customerPatch = {};
  for (const [key, raw] of Object.entries(body)) {
    const isJob = JOB_EDIT_KEYS.includes(key);
    if (!isJob && !CUSTOMER_EDIT_KEYS.includes(key)) throw invalid(`Unknown field: ${key}`);
    const value = editValue(key, raw);
    const current = isJob ? jv[key] : jv.customer?.[key];
    if ((current ?? null) !== value) (isJob ? jobPatch : customerPatch)[key] = value;
  }
  return { jobPatch, customerPatch };
}

function editSummary(changed, jobPatch) {
  if (changed.length === 1 && changed[0] === "urgent") return jobPatch.urgent ? "Marked urgent" : "Marked not urgent";
  return `Changed ${changed.map((k) => EDIT_LABELS[k]).join(", ")}`;
}

/** A visit date edit on a scheduled job moves its "Did it get done?" check with it. */
function scheduledFollowUp(jv, jobPatch, tz) {
  if (jv.stage !== "scheduled" || !("visit_date" in jobPatch)) return {};
  if (jobPatch.visit_date == null) throw invalid("A scheduled job needs a visit date. Move it to another stage instead.");
  return { next_due_at: startOfDay(nextBusinessDay(jobPatch.visit_date), tz), snoozed_until: null };
}

function assertPhoneFree(db, customerId, phone) {
  if (phone == null) return;
  const owner = repo.findCustomerByPhone(db, phone);
  if (owner && owner.id !== customerId) {
    throw new ApiError(409, "duplicate", `That number already belongs to ${titleFor({ customer: owner })}.`);
  }
}

/**
 * Where the customer edits go. A new phone for a customer who has another open job may mean this
 * lead was filed under the wrong customer, so the job gets a customer of its own (a copy with the
 * edits) and the other job is left as it was. Returns the job patch (customer_id) and customer patch.
 */
function customerEdits(db, jv, customerPatch, now) {
  const { phone } = customerPatch;
  const newPhone = phone != null && jv.customer?.phone != null && phone !== jv.customer.phone;
  const shared = repo.openJobsForCustomer(db, jv.customer_id).some((job) => job.id !== jv.id);
  if (!newPhone || !shared) return { jobPatch: {}, customerPatch };
  const own = repo.createCustomer(db, { ...pick(jv.customer, CUSTOMER_EDIT_KEYS), ...customerPatch }, now);
  return { jobPatch: { customer_id: own.id }, customerPatch: {} };
}

/** PATCH /api/jobs/:id: one `edit` event for every field that changed. Returns {job_id, event_id|null}. */
export function performEdit(db, jobId, body, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length) {
    throw invalid("Nothing to change.");
  }
  return tx(db, () => {
    const jv = loadJob(db, jobId);
    const { jobPatch, customerPatch } = editPatches(jv, body);
    const changed = [...Object.keys(customerPatch), ...Object.keys(jobPatch)];
    if (!changed.length) return { job_id: jv.id, event_id: null };
    assertPhoneFree(db, jv.customer_id, customerPatch.phone);
    const customer = customerEdits(db, jv, customerPatch, ctx.now);
    const patch = { ...jobPatch, ...customer.jobPatch, ...scheduledFollowUp(jv, jobPatch, ctx.tz) };
    if ("urgent" in jobPatch) patch.urgent_source = "manual";
    if (Object.keys(patch).length) patch.updated_at = ctx.now;
    const eventId = commitChange(db, jv, {
      patch, customerPatch: customer.customerPatch,
      event: { kind: "edit", summary: editSummary(changed, jobPatch), data: { fields: changed } },
    }, ctx.now);
    return { job_id: jv.id, event_id: eventId };
  });
}

// ---------------------------------------------------------------------------
// Call / Text taps (§5.8): history only, no date changes

const TAP_SUMMARIES = {
  call: () => "Tapped Call",
  text: () => "Tapped Text",
  tech_text: (tech) => `Sent details to ${tech ?? "a tech"}`,
};

export function logTap(db, jobId, { kind, tech }, ctx) {
  if (!TAP_SUMMARIES[kind]) throw invalid("kind must be call, text or tech_text.");
  const job = loadJob(db, jobId);
  const techName = String(tech || "").trim() || null;
  repo.insertEvent(db, {
    job_id: job.id, at: ctx.now, kind: kind === "tech_text" ? "tech_text" : `${kind}_tap`, actor: "denise",
    summary: TAP_SUMMARIES[kind](techName), data: kind === "tech_text" ? { tech: techName } : null,
  });
}

// ---------------------------------------------------------------------------
// Settings (§6, §9 Settings)

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const READ_ONLY_SETTING_KEYS = ["readonly_key", "clock_offset_ms", "integrations", "readonly_url", "webhook_urls", "forwarding_number"];

const isBlank = (value) => value == null || (typeof value === "string" && !value.trim());

function settingText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${label} can't be empty.`);
  return value.trim();
}

function settingPhone(value, label) {
  if (isBlank(value)) return null;
  const phone = normalizePhone(value);
  if (!phone) throw invalid(`${label}: that phone number doesn't look right.`);
  return phone;
}

function settingEmail(value, label) {
  if (isBlank(value)) return null;
  const email = normalizeEmail(value);
  if (!email) throw invalid(`${label}: that email address doesn't look right.`);
  return email;
}

function settingBool(value, label) {
  if (typeof value !== "boolean") throw invalid(`${label} must be on or off.`);
  return value;
}

function settingTechs(value) {
  if (!Array.isArray(value)) throw invalid("Techs must be a list.");
  const techs = value
    .filter((t) => t && (String(t.name ?? "").trim() || String(t.phone ?? "").trim()))
    .map((t) => ({ name: settingText(String(t.name ?? ""), "Each tech's name"), phone: settingPhone(t.phone, `${t.name}'s cell`) }));
  if (techs.length > MAX_TECHS) throw invalid(`Up to ${MAX_TECHS} techs.`);
  return techs;
}

function settingTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    throw invalid(`Unknown time zone: ${value}`);
  }
}

const SETTING_RULES = {
  company_name: (v) => settingText(v, "Company"),
  owner_name: (v) => settingText(v, "Your name"),
  owner_phone: (v) => settingPhone(v, "Your cell"),
  owner_email: (v) => settingEmail(v, "Your email"),
  husband_name: (v) => settingText(v, "Name"),
  husband_phone: (v) => settingPhone(v, "Cell"),
  techs: settingTechs,
  timezone: settingTimezone,
  digest_time: (v) => {
    if (typeof v !== "string" || !HM_RE.test(v)) throw invalid("The morning text time must look like 07:00.");
    return v;
  },
  friday_sweep: (v) => settingBool(v, "Friday text"),
  weekend_digest: (v) => settingBool(v, "Weekend texts"),
  auto_ack_enabled: (v) => settingBool(v, "Auto-reply"),
  auto_ack_text: (v) => settingText(v, "Auto-reply text"),
};

function settingsPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Send the settings to change.");
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "regenerate_readonly_key" || READ_ONLY_SETTING_KEYS.includes(key) || value === undefined) continue;
    const rule = SETTING_RULES[key];
    if (!rule) throw invalid(`Unknown setting: ${key}`);
    patch[key] = rule(value);
  }
  if (body.regenerate_readonly_key === true) patch.readonly_key = randomBytes(18).toString("base64url");
  return patch;
}

/** PUT /api/settings: validate, normalise and save. Returns every setting. */
export function updateSettings(db, body) {
  return repo.putSettings(db, settingsPatch(body));
}

// ---------------------------------------------------------------------------
// "Send now" on the morning text preview (§9)

/** Texts today's morning text to her phone right away. Returns {outbox_id, status, error}. */
export async function sendDigestNow(db, ctx, { env, fetch }) {
  const { owner_phone: ownerPhone, owner_name: ownerName } = ctx.settings;
  if (!ownerPhone) throw invalid("Add your cell in Settings first.");
  const today = buildToday(repo.getJobViews(db, { scope: "all" }), ctx);
  const row = await send({
    kind: "manual", to_phone: ownerPhone, to_name: ownerName ?? null,
    body: digestText(today, ctx).body, job_id: null, dedupe_key: null,
  }, { db, now: ctx.now, env, fetch });
  if (!row) throw new Error("The text could not be written to the outbox.");
  return { outbox_id: row.id, status: row.status, error: row.error ?? null };
}
