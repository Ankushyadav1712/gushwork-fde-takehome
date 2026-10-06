// The app's JSON API (SPEC §13.5). Every handler reads `now` once from deps.now() and passes it down.
// Outcome, stage, edit and undo each run in one transaction and log an event with prev_json (§5.1).
// performOutcome is exported so the demo seed replays outcomes through exactly this path.
import express from "express";
import { randomBytes } from "node:crypto";
import { all, get, tx } from "../db.js";
import * as repo from "../repo.js";
import { ingestManual, ingestBulk } from "../ingest.js";
import { aiEnabled, extractWithAI, AI_MODEL } from "../ai.js";
import { send, smsMode } from "../notify.js";
import {
  applyOutcome, moveStage, outcomesFor, promotionFor, isOpen, stageLabel, equipmentLabel, lostReasonLabel,
  OPEN_STAGES, EQUIPMENT,
} from "../../shared/stages.js";
import { buildToday, bucketFor, reasonFor, replySuggestion, isOnToday, digestText, sweepText } from "../../shared/today-rules.js";
import { computeNumbers, numbersText } from "../../shared/stats.js";
import { smsDraft, smsLink, telLink } from "../../shared/templates.js";
import { parseMessage, mergeParse, parseNotebook, replyIntent } from "../../shared/parse.js";
import { titleFor, subtitleFor, sourceLabel, phoneDisplay, normalizePhone } from "../../shared/format.js";
import {
  localDate, daysBetween, weekdayName, dayLabel, timeLabel, whenLabel, shortDateLabel, isYmd,
  nextBusinessDay, startOfDay,
} from "../../shared/time.js";

const DEFAULT_PUBLIC_URL = "http://localhost:3000";
const DEFAULT_TZ = "America/Chicago";
const UNDO_WINDOW_MS = 10 * 60 * 1000;
const ADDED_TOAST = "Added. It's on your list.";
const LIST_LIMIT_MAX = 200;
const BULK_MAX_ROWS = 300;
const MAX_TECHS = 6;
const EQUIPMENT_IDS = EQUIPMENT.map((e) => e.id);
const PARSE_FIELDS = ["contact_name", "business_name", "phone", "email", "address", "equipment", "problem", "details", "urgent"];

// ---------------------------------------------------------------------------
// Errors

/** An error with an HTTP status and an ApiError code (§13.4); the app's error handler renders it. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const notFound = (what = "That job") => new ApiError(404, "not_found", `${what} isn't here.`);
const invalid = (message) => new ApiError(400, "validation", message);

// ---------------------------------------------------------------------------
// Context

export function publicUrlOf(env) {
  return String(env?.PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
}

/** ctx for the shared rules: {now, tz, settings, publicUrl, replyIntent}. */
export function contextFor(db, now, env = process.env, settings = repo.getSettings(db)) {
  return { now, tz: settings.timezone || DEFAULT_TZ, settings, publicUrl: publicUrlOf(env), replyIntent };
}

/** "Fri 4:47pm" within 6 days either way, else "Oct 14 9:30am". Never "today", so history lines stay true. */
export function stampLabel(iso, { now, tz }) {
  const ymd = localDate(iso, tz);
  const near = Math.abs(daysBetween(localDate(now, tz), ymd)) <= 6;
  return `${near ? weekdayName(ymd) : dayLabel(ymd, now, tz)} ${timeLabel(iso, tz)}`;
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Serialization (§13.4)

/** "Back on your list: Thu": when an open job that is not on Today comes back. */
function backOnList(jv, ctx, onToday) {
  if (!isOpen(jv.stage) || onToday) return null;
  const when = whenLabel(jv.next_due_at, ctx.now, ctx.tz);
  return when && !when.startsWith("at ") ? capitalize(when) : when;
}

/** Job = JobView plus display fields (title, labels, Today placement). */
export function serializeJob(jv, ctx) {
  const bucket = bucketFor(jv, ctx);
  const customer = jv.customer ?? {};
  const pastJobs = jv.past_jobs ?? 0;
  return {
    ...jv,
    title: titleFor(jv),
    subtitle: subtitleFor(jv),
    stage_label: stageLabel(jv.stage),
    source_label: sourceLabel(jv.source, jv.source_detail),
    equipment_label: jv.equipment ? equipmentLabel(jv.equipment) : null,
    lost_reason_label: jv.lost_reason ? lostReasonLabel(jv.lost_reason) : null,
    phone: customer.phone ?? null,
    phone_display: phoneDisplay(customer.phone),
    email: customer.email ?? null,
    address: customer.address ?? null,
    repeat: pastJobs >= 1 ? { past_jobs: pastJobs } : null,
    on_today: bucket != null,
    bucket,
    reason: bucket ? reasonFor(jv, ctx, bucket) : null,
    back_on_list: backOnList(jv, ctx, bucket != null),
  };
}

function outboxItem(row, ctx) {
  return {
    id: row.id, created_at: row.created_at, at_label: stampLabel(row.created_at, ctx), kind: row.kind,
    to_phone: row.to_phone, to_name: row.to_name, body: row.body, status: row.status, job_id: row.job_id,
  };
}

export function serializeOutbox(rows, ctx) {
  return rows.map((row) => outboxItem(row, ctx));
}

function messageItem(m) {
  return {
    id: m.id, received_at: m.received_at, channel: m.channel, provider: m.provider, from_phone: m.from_phone,
    from_email: m.from_email, subject: m.subject, body: m.body, status: m.status, job_id: m.job_id,
  };
}

const MESSAGE_KINDS = ["created", "inbound"];

/** History, newest first. Message bodies are shown verbatim on created/inbound lines. */
function timelineFor(db, jobId, ctx) {
  const rows = all(db, `SELECT e.id, e.at, e.actor, e.kind, e.summary, e.undone, e.message_id,
      m.body AS m_body, m.channel AS m_channel
    FROM events e LEFT JOIN messages m ON m.id = e.message_id
    WHERE e.job_id = ? ORDER BY e.at DESC, e.id DESC`, [jobId]);
  return rows.map((r) => {
    const item = { id: r.id, at: r.at, at_label: stampLabel(r.at, ctx), actor: r.actor, kind: r.kind, summary: r.summary };
    if (r.message_id != null && MESSAGE_KINDS.includes(r.kind)) {
      item.channel = r.m_channel;
      if (r.m_body) item.body = r.m_body;
    }
    item.undone = Boolean(r.undone);
    return item;
  });
}

function suggestionFor(jv, ctx) {
  return promotionFor(jv, replySuggestion(jv, ctx));
}

function jobDetail(db, jv, ctx) {
  const job = serializeJob(jv, ctx);
  const phone = jv.customer?.phone ?? null;
  return {
    job,
    customer: repo.getCustomer(db, jv.customer_id),
    timeline: timelineFor(db, jv.id, ctx),
    past_jobs: repo.listPastJobs(db, jv.customer_id, jv.id).map((p) => serializeJob(p, ctx)),
    outcomes: outcomesFor(jv, { suggestion: suggestionFor(jv, ctx), now: ctx.now, tz: ctx.tz }),
    sms_link: smsLink(phone, smsDraft(jv, job.bucket, ctx)),
    tel_link: telLink(phone),
  };
}

/** How many cards Today has right now (§4.2: open and due, or a reply is unread). */
export function todayCount(db, now) {
  return repo.getJobViews(db, { scope: "open" }).filter((jv) => isOnToday(jv, now)).length;
}

// ---------------------------------------------------------------------------
// Job actions: outcome, stage move, undo (§5.1, §5.6, §5.7)

function loadJob(db, jobId) {
  const jv = Number.isInteger(jobId) ? repo.getJobView(db, jobId) : null;
  if (!jv) throw notFound();
  return jv;
}

function checkExpectedStage(jv, expected) {
  if (expected != null && expected !== "" && expected !== jv.stage) {
    throw new ApiError(409, "stale_stage", `This job already moved to ${stageLabel(jv.stage)}.`);
  }
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k] ?? null]));

/** Write the patch and its event (with the job row before it) in the caller's transaction. */
function commitChange(db, jv, { patch, event, customerPatch = null }, now) {
  const prev = repo.getJobRow(db, jv.id);
  if (patch && Object.keys(patch).length) repo.updateJob(db, jv.id, patch);
  let data = event.data ?? null;
  if (customerPatch && Object.keys(customerPatch).length) {
    data = { ...data, customer_prev: pick(repo.getCustomer(db, jv.customer_id), Object.keys(customerPatch)) };
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

/**
 * One outcome tap (§5.1): load, expected_stage check, applyOutcome, update, event with prev_json.
 * opts: {now, settings?, env?}. Returns {job_id, event_id, toast}. Throws ApiError / OutcomeError.
 */
export function performOutcome(db, jobId, body = {}, opts = {}) {
  return tx(db, () => {
    const jv = loadJob(db, jobId);
    checkExpectedStage(jv, body.expected_stage);
    const ctx = contextFor(db, opts.now, opts.env, opts.settings);
    const result = applyOutcome(jv, body.outcome, actionArgs(body), ctx);
    const kind = body.outcome === "seen" ? "seen" : result.event.kind;
    const eventId = commitChange(db, jv, {
      patch: result.patch, event: { ...result.event, kind }, customerPatch: result.customer_patch,
    }, opts.now);
    return { job_id: jv.id, event_id: eventId, toast: result.toast };
  });
}

/** Job detail stage picker (§5.7): enterStage through moveStage. Not contact. */
export function performStage(db, jobId, body = {}, opts = {}) {
  return tx(db, () => {
    const jv = loadJob(db, jobId);
    checkExpectedStage(jv, body.expected_stage);
    const ctx = contextFor(db, opts.now, opts.env, opts.settings);
    const result = moveStage(jv, body.to, actionArgs(body), ctx);
    const eventId = commitChange(db, jv, result, opts.now);
    return { job_id: jv.id, event_id: eventId, toast: result.toast };
  });
}

function undoAllowed(event, latest, jobId, now) {
  return Boolean(event) && event.job_id === jobId && latest?.id === event.id && !event.undone
    && event.prev != null && Date.parse(now) - Date.parse(event.at) < UNDO_WINDOW_MS;
}

/** §5.6: restore prev_json (except id and created_at), mark the event undone, log "Undid: …". */
export function performUndo(db, jobId, eventId, { now }) {
  return tx(db, () => {
    const job = repo.getJobRow(db, jobId);
    if (!job) throw notFound();
    const event = Number.isInteger(eventId) ? repo.getEvent(db, eventId) : null;
    if (!undoAllowed(event, repo.latestStateEvent(db, jobId), jobId, now)) {
      throw new ApiError(409, "undo_not_allowed", "That can't be undone anymore.");
    }
    const { id: _id, created_at: _created, ...restore } = event.prev;
    const columns = Object.fromEntries(Object.entries(restore).filter(([k]) => repo.JOB_COLUMNS.includes(k)));
    repo.updateJob(db, jobId, columns);
    if (event.data?.customer_prev) repo.updateCustomer(db, job.customer_id, event.data.customer_prev, now);
    repo.markUndone(db, event.id);
    repo.insertEvent(db, {
      job_id: jobId, at: now, kind: "undo", actor: "denise", summary: `Undid: ${event.summary}`,
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
      if (s != null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw invalid("That email address doesn't look right.");
      return s == null ? null : s.toLowerCase();
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

export function performEdit(db, jobId, body, { now, settings }) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length) {
    throw invalid("Nothing to change.");
  }
  return tx(db, () => {
    const jv = loadJob(db, jobId);
    const { jobPatch, customerPatch } = editPatches(jv, body);
    const changed = [...Object.keys(customerPatch), ...Object.keys(jobPatch)];
    if (!changed.length) return { job_id: jv.id, event_id: null };
    assertPhoneFree(db, jv.customer_id, customerPatch.phone);
    const patch = { ...jobPatch, ...scheduledFollowUp(jv, jobPatch, settings.timezone || DEFAULT_TZ) };
    if ("urgent" in jobPatch) patch.urgent_source = "manual";
    if (Object.keys(jobPatch).length) patch.updated_at = now;
    const eventId = commitChange(db, jv, {
      patch, customerPatch,
      event: { kind: "edit", summary: editSummary(changed, jobPatch), data: { fields: changed } },
    }, now);
    return { job_id: jv.id, event_id: eventId };
  });
}

// ---------------------------------------------------------------------------
// Settings (§6, §9 Settings)

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const READ_ONLY_SETTING_KEYS = ["readonly_key", "clock_offset_ms", "integrations", "readonly_url", "webhook_urls", "forwarding_number"];

function settingText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${label} can't be empty.`);
  return value.trim();
}

function settingPhone(value, label) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const phone = normalizePhone(value);
  if (!phone) throw invalid(`${label}: that phone number doesn't look right.`);
  return phone;
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

/** GET/PUT /api/settings: settings plus integrations, readonly_url, webhook_urls, forwarding_number. */
export function settingsPayload(settings, deps) {
  const env = deps.env;
  const base = publicUrlOf(env);
  const token = env.INBOUND_TOKEN ? `?token=${encodeURIComponent(env.INBOUND_TOKEN)}` : "";
  return {
    ...settings,
    integrations: {
      ai: deps.aiOn() ? "claude" : "rules", ai_model: AI_MODEL, sms: smsMode(env),
      passcode: Boolean(env.APP_PASSCODE), inbound_token: Boolean(env.INBOUND_TOKEN),
    },
    readonly_url: `${base}/n/${settings.readonly_key}`,
    webhook_urls: {
      sms: `${base}/webhooks/twilio/sms${token}`,
      call: `${base}/webhooks/twilio/voice${token}`,
      email: `${base}/api/inbound/email${token}`,
      form: `${base}/api/inbound/form${token}`,
    },
    forwarding_number: env.TWILIO_FROM || null,
  };
}

// ---------------------------------------------------------------------------
// Quick Add parse and CSV

function matchedCustomer(db, { phone, email }) {
  const customer = repo.matchCustomer(db, { phone, email });
  if (!customer) return null;
  const pastJobs = get(db, "SELECT count(*) AS n FROM jobs WHERE customer_id = ?", [customer.id]).n;
  return { id: customer.id, title: titleFor({ customer }), past_jobs: pastJobs };
}

function parseFields(parse) {
  const fields = pick(parse, PARSE_FIELDS);
  fields.urgent = Boolean(parse.urgent);
  return fields;
}

const CSV_COLUMNS = ["id", "title", "contact", "phone", "email", "stage", "problem", "equipment", "urgent",
  "quote_amount", "created_at", "won_at", "done_at", "lost_at", "lost_reason"];

/** RFC 4180 quoting, plus a leading ' on cells a spreadsheet would run as a formula. */
function csvCell(value) {
  if (value == null) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(jv) {
  const c = jv.customer ?? {};
  return [
    jv.id, titleFor(jv), c.contact_name, phoneDisplay(c.phone), c.email, stageLabel(jv.stage), jv.problem,
    jv.equipment ? equipmentLabel(jv.equipment) : null, jv.urgent ? "yes" : "no", jv.quote_amount,
    jv.created_at, jv.won_at, jv.done_at, jv.lost_at, jv.lost_reason ? lostReasonLabel(jv.lost_reason) : null,
  ].map(csvCell).join(",");
}

export function jobsCsv(views) {
  return `\uFEFF${[CSV_COLUMNS.join(","), ...views.map(csvRow)].join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Jobs list

function listLimit(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, LIST_LIMIT_MAX) : 50;
}

function jobListViews(db, stage, q, now) {
  if (stage === "open") return repo.getJobViews(db, { scope: "open", q });
  if (stage === "closed") return repo.getJobViews(db, { scope: "closed30", q, now });
  if (OPEN_STAGES.includes(stage)) return repo.getJobViews(db, { scope: "open", stage, q });
  if (stage === "done" || stage === "lost") return repo.getJobViews(db, { scope: "closed30", stage, q, now });
  throw invalid(`Unknown stage filter: ${stage}`);
}

/** Open jobs soonest-due first; closed jobs most recently closed first. */
function sortJobs(views) {
  const key = (jv) => (isOpen(jv.stage) ? Date.parse(jv.next_due_at) : -Date.parse(jv.closed_at));
  return [...views].sort((a, b) => key(a) - key(b) || a.id - b.id);
}

function stageCounts(db, now) {
  const counts = Object.fromEntries(OPEN_STAGES.map((s) => [s, 0]));
  for (const row of all(db, "SELECT stage, count(*) AS n FROM jobs WHERE stage NOT IN ('done', 'lost') GROUP BY stage")) {
    counts[row.stage] = row.n;
  }
  counts.open = OPEN_STAGES.reduce((sum, s) => sum + counts[s], 0);
  counts.closed = repo.getJobViews(db, { scope: "closed30", now }).length;
  return counts;
}

// ---------------------------------------------------------------------------
// Router

const jobIdOf = (req) => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN);
const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

/**
 * deps: {db, now: () => ISO, env, demo: boolean, isShifted: () => boolean, clockOffsetMs: () => number,
 *        aiOn: () => boolean, extract?, fetch?}
 */
export function apiRouter(deps) {
  const { db } = deps;
  const router = express.Router();
  const ctxNow = () => contextFor(db, deps.now(), deps.env);
  const actionOpts = (ctx) => ({ now: ctx.now, settings: ctx.settings, env: deps.env });
  const extract = deps.extract ?? extractWithAI;

  const jobResponse = (result, ctx) => {
    const job = serializeJob(repo.getJobView(db, result.job_id), ctx);
    return { job, event_id: result.event_id, toast: result.toast, today_count: todayCount(db, ctx.now), on_today: job.on_today };
  };

  router.get("/health", (req, res) => {
    const ctx = ctxNow();
    res.json({
      ok: true, now: ctx.now, tz: ctx.tz, ai: deps.aiOn() ? "claude" : "rules", ai_model: AI_MODEL,
      sms: smsMode(deps.env), demo: deps.demo, passcode: Boolean(deps.env.APP_PASSCODE),
      unlinked_messages: repo.unlinkedMessageCount(db), clock_offset_ms: deps.clockOffsetMs(),
    });
  });

  router.get("/today", (req, res) => {
    const ctx = ctxNow();
    const today = buildToday(repo.getJobViews(db, { scope: "all" }), ctx);
    const shifted = Boolean(deps.demo && deps.isShifted());
    today.demo = { shifted, label: shifted ? `Demo time: ${shortDateLabel(ctx.now, ctx.tz)}, ${timeLabel(ctx.now, ctx.tz)}` : null };
    res.json(today);
  });

  router.get("/jobs", (req, res) => {
    const ctx = ctxNow();
    const stage = String(req.query.stage || "open");
    const views = sortJobs(jobListViews(db, stage, String(req.query.q ?? ""), ctx.now));
    res.json({ now: ctx.now, counts: stageCounts(db, ctx.now), jobs: views.map((jv) => serializeJob(jv, ctx)) });
  });

  router.get("/jobs/:id", (req, res) => {
    const ctx = ctxNow();
    res.json(jobDetail(db, loadJob(db, jobIdOf(req)), ctx));
  });

  router.patch("/jobs/:id", (req, res) => {
    const ctx = ctxNow();
    const result = performEdit(db, jobIdOf(req), req.body, actionOpts(ctx));
    res.json({ job: serializeJob(repo.getJobView(db, result.job_id), ctx), event_id: result.event_id });
  });

  router.post("/jobs/:id/outcome", (req, res) => {
    const ctx = ctxNow();
    res.json(jobResponse(performOutcome(db, jobIdOf(req), bodyOf(req), actionOpts(ctx)), ctx));
  });

  router.post("/jobs/:id/stage", (req, res) => {
    const ctx = ctxNow();
    res.json(jobResponse(performStage(db, jobIdOf(req), bodyOf(req), actionOpts(ctx)), ctx));
  });

  router.post("/jobs/:id/undo", (req, res) => {
    const ctx = ctxNow();
    const eventId = Number(bodyOf(req).event_id);
    const result = performUndo(db, jobIdOf(req), Number.isInteger(eventId) ? eventId : NaN, ctx);
    res.json({ job: serializeJob(repo.getJobView(db, result.job_id), ctx), today_count: todayCount(db, ctx.now) });
  });

  router.post("/jobs/:id/tap", (req, res) => {
    const { now } = ctxNow();
    const { kind, tech } = bodyOf(req);
    const summaries = { call: "Tapped Call", text: "Tapped Text", tech_text: `Sent details to ${String(tech || "").trim() || "a tech"}` };
    if (!summaries[kind]) throw invalid("kind must be call, text or tech_text.");
    const job = loadJob(db, jobIdOf(req));
    repo.insertEvent(db, {
      job_id: job.id, at: now, kind: kind === "tech_text" ? "tech_text" : `${kind}_tap`, actor: "denise",
      summary: summaries[kind], data: kind === "tech_text" ? { tech: String(tech || "").trim() || null } : null,
    });
    res.status(204).end();
  });

  router.post("/parse", async (req, res) => {
    const ctx = ctxNow();
    const { text: rawText, use_ai: useAi } = bodyOf(req);
    const text = typeof rawText === "string" ? rawText : "";
    const opts = {
      channel: "manual", owner_phone: ctx.settings.owner_phone, twilio_from: deps.env.TWILIO_FROM ?? null,
      techs: ctx.settings.techs, now: ctx.now, tz: ctx.tz,
    };
    let parse = parseMessage(text, opts);
    let mode = "rules";
    if (useAi !== false && deps.aiOn() && text.trim()) {
      const ai = await Promise.resolve(extract(text, { channel: "manual" })).catch(() => null);
      if (ai) {
        parse = mergeParse(parse, ai, text, opts);
        mode = "ai";
      }
    }
    res.json({
      mode, fields: parseFields(parse), urgent_hits: parse.urgent_hits ?? [], stage_hint: parse.stage_hint ?? null,
      callback_date: parse.callback_date ?? null, quote_amount: parse.quote_amount ?? null,
      quote_sent_at: parse.quote_sent_at ?? null, visit_date: parse.visit_date ?? null, tech: parse.tech ?? null,
      matched_customer: matchedCustomer(db, parse),
    });
  });

  router.post("/jobs", (req, res) => {
    const ctx = ctxNow();
    const result = ingestManual(db, bodyOf(req), {
      now: ctx.now, settings: ctx.settings, ...(deps.extract ? { extract: deps.extract } : {}),
    });
    res.status(201).json({
      job_id: result.job_id, customer_id: result.customer_id, matched_customer: result.matched_customer, toast: ADDED_TOAST,
    });
  });

  router.post("/bulk/parse", (req, res) => {
    const ctx = ctxNow();
    const text = typeof bodyOf(req).text === "string" ? bodyOf(req).text : "";
    const rows = parseNotebook(text, { now: ctx.now, tz: ctx.tz, techs: ctx.settings.techs, owner_phone: ctx.settings.owner_phone });
    res.json({
      rows: rows.map((r) => ({
        line: r.line, fields: parseFields(r.fields), stage: r.stage, quote_amount: r.quote_amount ?? null,
        quote_sent_at: r.quote_sent_at ?? null, visit_date: r.visit_date ?? null, tech: r.tech ?? null,
        matched_customer: matchedCustomer(db, r.fields),
      })),
    });
  });

  router.post("/bulk", (req, res) => {
    const ctx = ctxNow();
    const { rows } = bodyOf(req);
    if (!Array.isArray(rows) || !rows.length) throw invalid("Add at least one line.");
    if (rows.length > BULK_MAX_ROWS) throw invalid(`Up to ${BULK_MAX_ROWS} lines at a time.`);
    const result = ingestBulk(db, rows, { now: ctx.now, settings: ctx.settings });
    res.status(201).json({ created: result.created, errors: result.errors });
  });

  router.get("/numbers", (req, res) => {
    const ctx = ctxNow();
    const numbers = computeNumbers(repo.getJobViews(db, { scope: "all" }), ctx);
    res.json({ ...numbers, summary_text: numbersText(numbers, ctx) });
  });

  router.get("/settings", (req, res) => {
    res.json(settingsPayload(repo.getSettings(db), deps));
  });

  router.put("/settings", (req, res) => {
    res.json(settingsPayload(repo.putSettings(db, settingsPatch(req.body)), deps));
  });

  router.get("/digest/preview", (req, res) => {
    const ctx = ctxNow();
    const today = buildToday(repo.getJobViews(db, { scope: "all" }), ctx);
    res.json({ digest: digestText(today, ctx), sweep: sweepText(today, ctx), now: ctx.now });
  });

  router.post("/digest/send", async (req, res) => {
    const ctx = ctxNow();
    if (!ctx.settings.owner_phone) throw invalid("Add your cell in Settings first.");
    const today = buildToday(repo.getJobViews(db, { scope: "all" }), ctx);
    const row = await send({
      kind: "manual", to_phone: ctx.settings.owner_phone, to_name: ctx.settings.owner_name ?? null,
      body: digestText(today, ctx).body, job_id: null, dedupe_key: null,
    }, { db, now: ctx.now, env: deps.env, fetch: deps.fetch });
    if (!row) throw new Error("The text could not be written to the outbox.");
    res.json({ outbox_id: row.id });
  });

  router.get("/outbox", (req, res) => {
    const ctx = ctxNow();
    res.json({ items: serializeOutbox(repo.listOutbox(db, listLimit(req.query.limit)), ctx) });
  });

  router.get("/messages", (req, res) => {
    res.json({ items: repo.listMessages(db, listLimit(req.query.limit)).map(messageItem) });
  });

  router.get("/export/jobs.csv", (req, res) => {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="callback-jobs.csv"');
    res.set("Cache-Control", "no-store");
    res.send(jobsCsv(repo.getJobViews(db, { scope: "all" })));
  });

  return router;
}

/** Whether AI parsing is on: an injected extractor (tests) or server/ai.js's rule. */
export function aiOnFor(extract) {
  return () => Boolean(extract) || aiEnabled();
}
