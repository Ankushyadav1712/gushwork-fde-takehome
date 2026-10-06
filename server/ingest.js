// One intake pipeline for every channel (SPEC §7.1). Adapters build an InboundEvent; ingest()
// stores the raw message first, then matches, attaches or creates a job. A message is never
// dropped: any failure after the raw insert still produces a placeholder job.
import { get, tx } from "./db.js";
import {
  getSettings, matchCustomer, createCustomer, fillCustomerBlanks, getCustomer, findCustomerByPhone,
  findCustomerByEmail, updateCustomer, openJobsForCustomer, insertJob, getJobRow, updateJob,
  insertMessage, updateMessage, getMessage, findMessageByExternal, insertEvent, insertOutbox,
} from "./repo.js";
import { aiEnabled, extractWithAI } from "./ai.js";
import { formExternalId, VOICEMAIL_PLACEHOLDER } from "./adapters.js";
import { parseMessage, mergeParse, unwrapForward, detectUrgency } from "../shared/parse.js";
import { enterStage, stageLabel, OutcomeError, EQUIPMENT, STAGES, OPEN_STAGES, LOST_REASONS } from "../shared/stages.js";
import { normalizePhone, sourceLabel, trunc, shorten } from "../shared/format.js";
import { isYmd, localDate, startOfDay } from "../shared/time.js";

export const FALLBACK_PROBLEM = "Couldn't read this one - tap to look";
export const VALIDATION_MESSAGE = "Add a name, a phone number, or what's wrong.";

const CHANNELS = ["call", "sms", "email", "form", "manual", "bulk"];
const PROVIDERS = ["twilio", "postmark", "mailgun", "form", "generic", "raw", "app"];
const OWN_ENTRY_CHANNELS = ["manual", "bulk"]; // Denise's own entries: always a new job
const CALL_DETAILS = ["missed", "voicemail", "answered"];
const EQUIPMENT_IDS = EQUIPMENT.map((e) => e.id);
const STAGE_IDS = STAGES.map((s) => s.id);
const LOST_REASON_IDS = LOST_REASONS.map((r) => r.id);
const MIN_ANSWERED_S = 15;
const JOB_FIELDS = ["problem", "details", "equipment"];
const CUSTOMER_FIELDS = ["contact_name", "business_name", "phone", "email", "address"];
const FIELD_KEYS = [...CUSTOMER_FIELDS, ...JOB_FIELDS, "urgent", "urgent_source"];
const NANP_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const HOUR_MS = 3_600_000;
const AI_FIELD_LABELS = {
  contact_name: "name", business_name: "name", phone: "phone", email: "email", address: "address",
  problem: "problem", details: "details", equipment: "equipment", urgent: "urgent",
  ai_not_service: "not a job?",
};

/** A request the caller must fix (400 in the API). */
export class IngestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Context and small helpers

/** Everything one ingest call needs besides the event: clock, settings, parser and AI hooks. */
function makeContext(db, opts) {
  const settings = opts.settings ?? getSettings(db);
  const extract = opts.extract ?? extractWithAI;
  return {
    now: opts.now,
    tz: settings.timezone || "America/Chicago",
    settings,
    owner: normalizePhone(settings.owner_phone),
    twilioFrom: opts.twilio_from ?? process.env.TWILIO_FROM ?? null,
    parse: opts.parse ?? parseMessage,
    extract,
    aiOn: opts.ai !== false && (Boolean(opts.extract) || aiEnabled()),
    send: opts.send ?? null,
    fields: opts.fields ?? null,
    start: opts.start ?? null,
  };
}

function normalizeEvent(event, now) {
  if (!CHANNELS.includes(event?.channel)) throw new Error(`ingest: unknown channel ${event?.channel}`);
  if (!PROVIDERS.includes(event.provider)) throw new Error(`ingest: unknown provider ${event.provider}`);
  const receivedAt = event.received_at ?? now;
  const ev = {
    channel: event.channel,
    provider: event.provider,
    external_id: event.external_id == null || event.external_id === "" ? null : String(event.external_id),
    received_at: new Date(receivedAt).toISOString(),
    from_phone: normalizePhone(event.from_phone) ?? null,
    from_email: event.from_email ? String(event.from_email).trim().toLowerCase() : null,
    from_name: event.from_name ?? null,
    subject: event.subject ?? null,
    body: event.body == null ? "" : String(event.body),
    call_status: CALL_DETAILS.includes(event.call_status) ? event.call_status : null,
    call_duration_s: Number.isFinite(Number(event.call_duration_s)) && event.call_duration_s != null
      ? Math.round(Number(event.call_duration_s)) : null,
    form_fields: event.form_fields ?? null,
    raw: event.raw ?? {},
  };
  if (ev.channel === "form" && ev.external_id == null) {
    ev.external_id = formExternalId({ body: ev.body, phone: ev.from_phone, email: ev.from_email }, ev.received_at);
  }
  return ev;
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");

function errorText(err) {
  return String(err?.message ?? err ?? "error").slice(0, 500);
}

/** Logs never include message bodies (§8.5). */
function logWarn(what, err) {
  console.warn(`[ingest] ${what} (${err?.name ?? "Error"}${err?.code ? ` ${err.code}` : ""})`);
}

function isForwardedSms(ev, ctx) {
  return ev.channel === "sms" && ctx.owner != null && ev.from_phone === ctx.owner;
}

/** §7.1 step 4: answered calls under 15 s and in-progress Twilio statuses create nothing. */
function isIgnoredCall(ev) {
  if (ev.channel !== "call") return false;
  if (ev.call_status == null) return true;
  return ev.call_status === "answered" && (ev.call_duration_s ?? 0) < MIN_ANSWERED_S;
}

function sourceDetailFor(ev, forwarded) {
  if (ev.channel === "call") return ev.call_status;
  return forwarded ? "forwarded" : null;
}

/** Override values from opts.fields: undefined is ignored, "" means "clear it". */
function cleanOverrides(fields) {
  const out = {};
  if (!fields || typeof fields !== "object") return out;
  for (const key of [...FIELD_KEYS, "parsed_by"]) {
    if (fields[key] === undefined) continue;
    const value = fields[key];
    out[key] = typeof value === "string" ? (value.trim() || null) : value;
  }
  return out;
}

function urgentSource(fields, rules) {
  if (!fields.urgent) return null;
  if (["rules", "ai", "manual"].includes(fields.urgent_source)) return fields.urgent_source;
  return rules.urgent ? "rules" : "manual";
}

function displayName(name) {
  const s = oneLine(name);
  return s && !s.includes("@") ? s : null;
}

// ---------------------------------------------------------------------------
// Steps 1-2: duplicates and the raw message

function rawMessageRow(ev) {
  return {
    received_at: ev.received_at, channel: ev.channel, provider: ev.provider, external_id: ev.external_id,
    call_status: ev.call_status, call_duration_s: ev.call_duration_s,
    from_phone: ev.from_phone, from_email: ev.from_email, from_name: ev.from_name, subject: ev.subject,
    body: ev.body, forwarded: 0, raw: ev.raw, status: "received",
  };
}

/** Insert the raw message (status 'received'). Returns its id, or null when the external id already exists. */
function storeRaw(db, ev) {
  try {
    return insertMessage(db, rawMessageRow(ev));
  } catch (err) {
    if (ev.external_id != null && err?.errcode === 2067) return null; // UNIQUE(channel, external_id)
    throw err;
  }
}

function duplicateResult(existing, extra = {}) {
  return {
    status: "duplicate", job_id: existing.job_id ?? null, message_id: existing.id,
    customer_id: existing.customer_id ?? null, refine: null, ...extra,
  };
}

const hasTranscript = (body) => !blank(body) && body.trim() !== VOICEMAIL_PLACEHOLDER;

/**
 * §7.1 step 1 voice exception: a later callback for the same CallSid that carries a voicemail
 * (recording or transcript) upgrades the stored message. A job without a problem is re-parsed;
 * urgency can only rise.
 */
function applyVoicemailUpdate(db, existing, ev, ctx) {
  const transcript = hasTranscript(ev.body) && ev.body !== existing.body;
  const messagePatch = {};
  if (existing.call_status !== "voicemail") messagePatch.call_status = "voicemail";
  if (transcript) messagePatch.body = ev.body;
  if (!Object.keys(messagePatch).length) return { updated: false, plan: null };
  updateMessage(db, existing.id, messagePatch);
  const job = existing.job_id ? getJobRow(db, existing.job_id) : null;
  if (!job) return { updated: true, plan: null };

  const createdHere = existing.status === "created_job";
  const jobPatch = {};
  let plan = null;
  if (createdHere && job.source === "call" && job.source_detail !== "voicemail") jobPatch.source_detail = "voicemail";
  if (transcript && createdHere && job.problem == null) {
    const rules = ctx.parse(ev.body, parseOptions({ ...ev, from_phone: existing.from_phone }, ctx));
    Object.assign(jobPatch, reparsePatch(job, rules));
    const before = getCustomer(db, job.customer_id);
    fillCustomerBlanks(db, job.customer_id, customerFieldsFrom(rules, ev), ctx.now);
    updateMessage(db, existing.id, { parse: { rules, ai: null, merged: rules } });
    plan = refinePlan({
      jobId: job.id, customerId: job.customer_id, messageId: existing.id, ev: { ...ev, from_phone: existing.from_phone },
      rules, customerBefore: before,
    });
  }
  if (transcript) {
    const { urgent } = detectUrgency(ev.body, jobPatch.equipment ?? job.equipment);
    if (urgent && !job.urgent) Object.assign(jobPatch, { urgent: 1, urgent_source: "rules" });
  }
  if (Object.keys(jobPatch).length) updateJob(db, job.id, { ...jobPatch, updated_at: ctx.now });
  return { updated: true, plan };
}

function reparsePatch(job, rules) {
  const patch = { problem: rules.problem ?? null };
  if (job.details == null && rules.details) patch.details = rules.details;
  if (job.equipment == null && EQUIPMENT_IDS.includes(rules.equipment)) patch.equipment = rules.equipment;
  return patch;
}

function handleDuplicate(db, ev, ctx) {
  if (ev.external_id == null) return null;
  const existing = findMessageByExternal(db, ev.channel, ev.external_id);
  if (!existing) return null;
  if (ev.channel !== "call" || ev.call_status !== "voicemail") return duplicateResult(existing);
  try {
    const { updated, plan } = tx(db, () => applyVoicemailUpdate(db, existing, ev, ctx));
    const refine = plan && ctx.aiOn ? startRefine(db, plan, ctx) : null;
    return duplicateResult(existing, { refine, updated });
  } catch (err) {
    logWarn(`voicemail update for message ${existing.id} failed`, err);
    return duplicateResult(existing, { updated: false });
  }
}

// ---------------------------------------------------------------------------
// Steps 3-7: forwarded texts, ignored calls, matching, attach or create

function parseOptions(ev, ctx) {
  return {
    channel: ev.channel, from_phone: ev.from_phone, owner_phone: ctx.owner, twilio_from: ctx.twilioFrom,
    form_fields: ev.form_fields, techs: ctx.settings.techs, now: ctx.now, tz: ctx.tz,
  };
}

/** Customer identity and fields from a parse. Plain emails also use the sender's address and name. */
function customerFieldsFrom(fields, ev, overrides = {}) {
  const isEmail = ev.channel === "email";
  return {
    contact_name: fields.contact_name ?? (isEmail && !("contact_name" in overrides) ? displayName(ev.from_name) : null),
    business_name: fields.business_name ?? null,
    phone: normalizePhone(fields.phone) ?? null,
    email: isEmail && !("email" in overrides) ? (ev.from_email ?? fields.email ?? null) : (fields.email ?? null),
    address: fields.address ?? null,
  };
}

function inboundSummary(ev, body, forwarded) {
  const text = trunc(oneLine(body), 80) || "(no text)";
  switch (ev.channel) {
    case "sms": return forwarded ? `Forwarded text: ${text}` : `Texted: ${text}`;
    case "email": return `Emailed: ${text}`;
    case "form": return `Web form: ${text}`;
    case "call":
      if (ev.call_status === "missed") return "Called (missed, no voicemail)";
      if (ev.call_status === "answered") return "Called - you talked";
      return `Voicemail: ${text}`;
    default: return `Wrote: ${text}`;
  }
}

/** §7.1 step 6: attach to the customer's most recently updated open job. */
function attachToJob(db, ev, msgId, job, customer, { body, forwarded, rules }) {
  insertEvent(db, {
    job_id: job.id, at: ev.received_at, kind: "inbound", actor: "customer",
    summary: inboundSummary(ev, body, forwarded), message_id: msgId,
  });
  const patch = { unread_inbound_at: job.unread_inbound_at ?? ev.received_at, updated_at: ev.received_at };
  const { urgent } = detectUrgency(body, job.equipment ?? rules.equipment);
  if (urgent && !job.urgent) Object.assign(patch, { urgent: 1, urgent_source: "rules" });
  updateJob(db, job.id, patch);
  updateMessage(db, msgId, { status: "attached", job_id: job.id, customer_id: customer.id });
  return { status: "attached", job_id: job.id, customer_id: customer.id, matched_customer: true };
}

function createdSummary(source, detail, stage) {
  const head = source === "manual" ? "Added by you"
    : source === "bulk" ? "Added from your notebook"
    : `${sourceLabel(source, detail)} came in`;
  return stage && stage !== "new" ? `${head} - ${stageLabel(stage)}` : head;
}

/** §7.1 step 7 (plus the Quick Add / Brain dump starting stage). */
function createJob(db, ev, msgId, matched, { rules, fields, overrides, forwarded }, ctx) {
  const customerFields = customerFieldsFrom(fields, ev, overrides);
  const customerBefore = matched ? { ...matched } : null;
  const customer = matched
    ? fillCustomerBlanks(db, matched.id, customerFields, ctx.now)
    : createCustomer(db, customerFields, ev.received_at);
  const detail = sourceDetailFor(ev, forwarded);
  const urgent = Boolean(fields.urgent);
  const at = ev.received_at;
  const jobId = insertJob(db, {
    customer_id: customer.id, stage: "new", source: ev.channel, source_detail: detail,
    problem: fields.problem ?? null, details: fields.details ?? null,
    equipment: EQUIPMENT_IDS.includes(fields.equipment) ? fields.equipment : null,
    urgent: urgent ? 1 : 0, urgent_source: urgentSource(fields, rules), ai_not_service: 0,
    parsed_by: fields.parsed_by ?? "rules",
    created_at: at, updated_at: at, stage_entered_at: at, next_due_at: at,
  });
  if (ctx.start) applyStart(db, jobId, ctx.start, ctx);
  insertEvent(db, {
    job_id: jobId, at, kind: "created",
    actor: OWN_ENTRY_CHANNELS.includes(ev.channel) ? "denise" : "customer",
    summary: createdSummary(ev.channel, detail, ctx.start?.stage),
    data: { source: ev.channel, source_detail: detail }, message_id: msgId,
  });
  updateMessage(db, msgId, {
    status: "created_job", job_id: jobId, customer_id: customer.id,
    parse: { rules, ai: null, merged: fields },
  });
  return {
    status: "created_job", job_id: jobId, customer_id: customer.id, matched_customer: Boolean(matched),
    forwarded, plan: refinePlan({ jobId, customerId: customer.id, messageId: msgId, ev, rules, customerBefore }),
  };
}

function processMessage(db, ev, msgId, ctx) {
  const forwarded = isForwardedSms(ev, ctx);
  let body = ev.body;
  let event = ev;
  if (forwarded) {
    const fwd = unwrapForward(ev.body, ctx.owner);
    body = fwd.body;
    event = { ...ev, from_phone: normalizePhone(fwd.phone) ?? null };
    updateMessage(db, msgId, { forwarded: 1, from_phone: event.from_phone });
  }
  if (isIgnoredCall(event)) {
    // Clearing external_id lets a later callback for the same call (e.g. its recording) still create a job.
    updateMessage(db, msgId, { status: "ignored", external_id: null });
    return { status: "ignored", job_id: null, customer_id: null };
  }

  const rules = ctx.parse(ev.body, parseOptions(event, ctx));
  const overrides = cleanOverrides(ctx.fields);
  const fields = { ...rules, ...overrides };
  const ownEntry = OWN_ENTRY_CHANNELS.includes(ev.channel);
  const identity = customerFieldsFrom(fields, event, overrides);
  const customer = matchCustomer(db, { phone: identity.phone, email: identity.email, text: body, forwarded });

  if (customer && !ownEntry) {
    if (customer.blocked) {
      updateMessage(db, msgId, { status: "blocked", customer_id: customer.id });
      return { status: "blocked", job_id: null, customer_id: customer.id, matched_customer: true };
    }
    const open = openJobsForCustomer(db, customer.id)[0];
    if (open) return attachToJob(db, event, msgId, open, customer, { body, forwarded, rules });
  }
  return createJob(db, event, msgId, customer, { rules, fields, overrides, forwarded }, ctx);
}

// ---------------------------------------------------------------------------
// Error path: the message is kept and a placeholder job is created (§7.1 step 2)

function fallbackCustomer(db, ev, ctx) {
  try {
    const phone = ev.from_phone && ev.from_phone !== ctx.owner ? ev.from_phone : null;
    const email = ev.channel === "email" ? ev.from_email : null;
    return findCustomerByPhone(db, phone) ?? findCustomerByEmail(db, email)
      ?? createCustomer(db, { phone, email }, ev.received_at);
  } catch {
    return createCustomer(db, {}, ev.received_at);
  }
}

function recoverFromError(db, ev, msgId, err, ctx) {
  logWarn(`message ${msgId} could not be read; created a placeholder job`, err);
  try {
    return tx(db, () => {
      const customer = fallbackCustomer(db, ev, ctx);
      const detail = ev.channel === "call" ? ev.call_status : isForwardedSms(ev, ctx) ? "forwarded" : null;
      const at = ev.received_at;
      const jobId = insertJob(db, {
        customer_id: customer.id, stage: "new", source: ev.channel, source_detail: detail,
        problem: FALLBACK_PROBLEM, created_at: at, updated_at: at, stage_entered_at: at, next_due_at: at,
      });
      insertEvent(db, {
        job_id: jobId, at, kind: "created",
        actor: OWN_ENTRY_CHANNELS.includes(ev.channel) ? "denise" : "customer",
        summary: createdSummary(ev.channel, detail, null), message_id: msgId,
      });
      updateMessage(db, msgId, { status: "error", error: errorText(err), job_id: jobId, customer_id: customer.id });
      return { status: "error", job_id: jobId, customer_id: customer.id };
    });
  } catch (err2) {
    logWarn(`placeholder job for message ${msgId} failed`, err2);
    try {
      updateMessage(db, msgId, { status: "error", error: errorText(err) });
    } catch { /* the raw row exists; /api/health will report it as unlinked */ }
    return { status: "error", job_id: null, customer_id: null };
  }
}

// ---------------------------------------------------------------------------
// Step 8: automatic acknowledgement (§7.4, off by default)

function ackChannelOk(ev, forwarded, phone) {
  if (ev.channel === "sms") return !forwarded;
  if (ev.channel === "call") return ev.call_status === "missed" || ev.call_status === "voicemail";
  if (ev.channel === "form") return Boolean(phone);
  return false;
}

/** "2026-10-05T00" or "2026-10-05T12": the 12-hour block of an instant (UTC). */
function ackBlock(iso) {
  return `${iso.slice(0, 11)}${Number(iso.slice(11, 13)) < 12 ? "00" : "12"}`;
}

/** Sends (or queues) the acknowledgement for a newly created job. Returns the message or null. */
export function autoAck(db, ev, created, ctx) {
  const settings = ctx.settings;
  if (!settings.auto_ack_enabled || created.status !== "created_job") return null;
  const customer = getCustomer(db, created.customer_id);
  const phone = customer?.phone ?? null;
  if (!customer || customer.blocked || !ackChannelOk(ev, created.forwarded, phone) || !NANP_RE.test(phone ?? "")) return null;
  const since = new Date(Date.parse(ctx.now) - 12 * HOUR_MS).toISOString();
  const recent = get(db, "SELECT id FROM outbox WHERE kind = 'auto_ack' AND to_phone = ? AND created_at > ? LIMIT 1", [phone, since]);
  if (recent) return null;
  const message = {
    to_phone: phone, to_name: customer.contact_name ?? customer.business_name ?? null, kind: "auto_ack",
    body: String(settings.auto_ack_text ?? "").replaceAll("{company}", settings.company_name ?? ""),
    job_id: created.job_id, dedupe_key: `ack:${phone}:${ackBlock(ctx.now)}`,
  };
  if (ctx.send) {
    Promise.resolve().then(() => ctx.send(message)).catch((err) => logWarn("auto-ack send failed", err));
    return message;
  }
  insertOutbox(db, { ...message, created_at: ctx.now, status: "simulated" });
  return message;
}

// ---------------------------------------------------------------------------
// Step 9: AI refine in the background (§7.1 step 9, §8.5)

/**
 * What the refine may touch. The baseline is the rules value of each field; a field is changed
 * only while it still equals that value, so a value Denise edited (or a seed override) is kept.
 * Customer fields that held a value before this message are never refined.
 */
function refinePlan({ jobId, customerId, messageId, ev, rules, customerBefore }) {
  const baseline = customerFieldsFrom(rules, ev);
  const refinable = CUSTOMER_FIELDS.filter((f) => !customerBefore || blank(customerBefore[f]));
  return {
    jobId, customerId, messageId, rules,
    body: ev.body, channel: ev.channel, from_phone: ev.from_phone, from: ev.from_phone ?? ev.from_email ?? null,
    jobBaseline: {
      problem: rules.problem ?? null, details: rules.details ?? null,
      equipment: EQUIPMENT_IDS.includes(rules.equipment) ? rules.equipment : null,
      urgent: rules.urgent ? 1 : 0,
    },
    customerBaseline: baseline,
    customerRefinable: refinable,
  };
}

function sameValue(a, b) {
  return (a ?? null) === (b ?? null);
}

function jobRefinePatch(job, merged, plan) {
  const patch = {};
  for (const f of JOB_FIELDS) {
    const value = f === "equipment" && !EQUIPMENT_IDS.includes(merged[f]) ? null : merged[f];
    if (value != null && value !== job[f] && sameValue(job[f], plan.jobBaseline[f])) patch[f] = value;
  }
  if (merged.urgent && !job.urgent && plan.jobBaseline.urgent === 0 && job.urgent_source !== "manual") {
    Object.assign(patch, { urgent: 1, urgent_source: "ai" });
  }
  if (merged.ai_not_service && !job.ai_not_service) patch.ai_not_service = 1;
  return patch;
}

function customerRefinePatch(db, customer, merged, plan) {
  const patch = {};
  for (const f of plan.customerRefinable) {
    let value = merged[f];
    if (f === "phone") value = normalizePhone(value);
    if (f === "email" && value) value = String(value).trim().toLowerCase();
    if (blank(value) || value === customer[f] || !sameValue(customer[f], plan.customerBaseline[f])) continue;
    if (f === "phone" && findCustomerByPhone(db, value)) continue; // belongs to someone else
    patch[f] = value;
  }
  return patch;
}

function changedLabels(keys) {
  const labels = [];
  for (const key of Object.keys(AI_FIELD_LABELS)) {
    const label = AI_FIELD_LABELS[key];
    if (keys.includes(key) && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function applyRefine(db, plan, ai, merged, ctx) {
  const job = getJobRow(db, plan.jobId);
  const customer = getCustomer(db, plan.customerId);
  const message = getMessage(db, plan.messageId);
  updateMessage(db, plan.messageId, { parse: { ...(message?.parse ?? {}), ai, merged } });
  if (!job || !customer) return { changed: [] };
  const jobPatch = jobRefinePatch(job, merged, plan);
  const customerPatch = customerRefinePatch(db, customer, merged, plan);
  const changed = [...Object.keys(customerPatch), ...Object.keys(jobPatch).filter((k) => k !== "urgent_source")];
  if (!changed.length) return { changed };
  if (Object.keys(customerPatch).length) updateCustomer(db, customer.id, customerPatch, ctx.now);
  const aiRead = changed.some((k) => k !== "ai_not_service") && job.parsed_by === "rules";
  updateJob(db, job.id, { ...jobPatch, ...(aiRead ? { parsed_by: "ai" } : {}) });
  insertEvent(db, {
    job_id: job.id, at: ctx.now, kind: "ai_refined", actor: "system",
    summary: `Details read by AI: ${changedLabels(changed).join(", ")}`,
    data: { fields: changed }, message_id: plan.messageId,
  });
  return { changed };
}

/** Never rejects: resolves to {changed: string[]} (and error: true when something failed). */
async function startRefine(db, plan, ctx) {
  try {
    const ai = await ctx.extract(plan.body, { channel: plan.channel, from: plan.from });
    if (!ai) return { changed: [] };
    const merged = mergeParse(plan.rules, ai, plan.body, {
      channel: plan.channel, from_phone: plan.from_phone, owner_phone: ctx.owner, twilio_from: ctx.twilioFrom,
    });
    return tx(db, () => applyRefine(db, plan, ai, merged, ctx));
  } catch (err) {
    logWarn(`AI refine for job ${plan.jobId} failed`, err);
    return { changed: [], error: true };
  }
}

// ---------------------------------------------------------------------------
// ingest()

/**
 * Run one InboundEvent through §7.1 steps 1-10.
 * opts: {now: ISO (required), ai?: boolean, fields?: Partial<Parse> overrides, settings?,
 *        extract?: AI extract function (tests), parse?: rules parser (tests), send?: notify.send,
 *        start?: internal starting stage for Quick Add / Brain dump}
 * @returns {{status, job_id, message_id, customer_id, matched_customer, refine: Promise|null}}
 */
export function ingest(db, event, opts = {}) {
  if (!opts.now) throw new Error("ingest: opts.now is required");
  const ctx = makeContext(db, opts);
  const ev = normalizeEvent(event, ctx.now);

  const duplicate = handleDuplicate(db, ev, ctx);
  if (duplicate) return duplicate;
  const messageId = storeRaw(db, ev);
  if (messageId == null) return duplicateResult(findMessageByExternal(db, ev.channel, ev.external_id));

  let outcome;
  try {
    outcome = tx(db, () => processMessage(db, ev, messageId, ctx));
  } catch (err) {
    outcome = recoverFromError(db, ev, messageId, err, ctx);
  }

  let refine = null;
  if (outcome.status === "created_job") {
    try {
      autoAck(db, ev, outcome, ctx);
    } catch (err) {
      logWarn("auto-ack failed", err);
    }
    if (ctx.aiOn && !blank(ev.body)) refine = startRefine(db, outcome.plan, ctx);
  }
  return {
    status: outcome.status, job_id: outcome.job_id ?? null, message_id: messageId,
    customer_id: outcome.customer_id ?? null, matched_customer: Boolean(outcome.matched_customer), refine,
  };
}

// ---------------------------------------------------------------------------
// Quick Add (POST /api/jobs) and Brain dump (POST /api/bulk)

function parseWholeDollars(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new IngestError("validation", "quote_amount must be a whole-dollar number");
  return Math.round(n);
}

function hasWhoPhoneOrProblem(fields) {
  return !blank(fields.contact_name) || !blank(fields.business_name) || !blank(fields.phone) || !blank(fields.problem);
}

/** Validated starting stage and its arguments. Throws IngestError / OutcomeError('missing_arg'). */
function startFor(input, stages, { now, tz }) {
  const stage = input.stage ?? "new";
  if (!stages.includes(stage)) throw new IngestError("validation", `Unknown stage: ${stage}`);
  if (stage === "scheduled" && !isYmd(input.visit_date)) {
    throw new OutcomeError("missing_arg", "visit_date (YYYY-MM-DD) is required");
  }
  let snooze = null;
  if (!blank(input.snooze_until)) {
    if (!isYmd(input.snooze_until) || input.snooze_until <= localDate(now, tz)) {
      throw new OutcomeError("missing_arg", "snooze_until must be a future date");
    }
    snooze = input.snooze_until;
  }
  const lostReason = blank(input.lost_reason) ? null : input.lost_reason;
  if (lostReason != null && !LOST_REASON_IDS.includes(lostReason)) {
    throw new IngestError("validation", `Unknown lost_reason: ${lostReason}`);
  }
  const quoteSentAt = blank(input.quote_sent_at) || !Number.isFinite(Date.parse(input.quote_sent_at))
    ? null : new Date(input.quote_sent_at).toISOString();
  return {
    stage,
    visit_date: isYmd(input.visit_date) ? input.visit_date : null,
    tech: blank(input.tech) ? null : String(input.tech).trim(),
    quote_amount: parseWholeDollars(input.quote_amount),
    quote_sent_at: quoteSentAt,
    lost_reason: lostReason,
    snooze_until: snooze,
  };
}

/** Moves a just-created job into its starting stage through enterStage, so §3 holds. */
function applyStart(db, jobId, start, ctx) {
  const job = getJobRow(db, jobId);
  const patch = {};
  if (start.quote_amount != null) patch.quote_amount = start.quote_amount;
  if (start.stage !== "new") {
    const args = {
      quote: { import: true },
      waiting_yes: { amount: start.quote_amount, quote_sent_at: start.quote_sent_at ?? undefined },
      scheduled: { visit_date: start.visit_date, tech: start.tech },
      done: { amount: start.quote_amount },
      lost: { lost_reason: start.lost_reason },
    }[start.stage] ?? {};
    Object.assign(patch, enterStage({ ...job, ...patch }, start.stage, { now: ctx.now, tz: ctx.tz }, args));
  }
  if (start.tech && start.stage === "to_schedule") patch.tech = start.tech;
  if (start.snooze_until && OPEN_STAGES.includes(start.stage) && start.stage !== "scheduled") {
    const until = startOfDay(start.snooze_until, ctx.tz);
    Object.assign(patch, { snoozed_until: until, next_due_at: until });
  }
  if (Object.keys(patch).length) updateJob(db, jobId, patch);
}

function ownEntryEvent(channel, text, raw, now) {
  return {
    channel, provider: "app", external_id: null, received_at: now,
    from_phone: null, from_email: null, from_name: null, subject: null,
    body: text, call_status: null, call_duration_s: null, form_fields: null, raw,
  };
}

function settingsFor(db, opts) {
  const settings = opts.settings ?? getSettings(db);
  return { settings, tz: settings.timezone || "America/Chicago" };
}

/**
 * Quick Add: POST /api/jobs. Writes a 'manual' message holding the original text, creates the
 * job (never attaches) and applies the starting stage. Imports whose next move is hers are due now.
 * Throws IngestError('validation') when who, phone and problem are all empty, and
 * OutcomeError('missing_arg') for a scheduled stage without visit_date or a bad snooze_until.
 */
export function ingestManual(db, input = {}, opts = {}) {
  if (!opts.now) throw new Error("ingestManual: opts.now is required");
  const { settings, tz } = settingsFor(db, opts);
  const text = input.text == null ? "" : String(input.text);
  const overrides = cleanOverrides(input.fields);
  const rules = (opts.parse ?? parseMessage)(text, {
    channel: "manual", owner_phone: settings.owner_phone, techs: settings.techs, now: opts.now, tz,
  });
  if (!hasWhoPhoneOrProblem({ ...rules, ...overrides })) throw new IngestError("validation", VALIDATION_MESSAGE);
  const start = startFor(input, OPEN_STAGES, { now: opts.now, tz });
  const aiPreviewed = input.parse_mode === "ai";
  const parsedBy = blank(text) ? "manual" : aiPreviewed ? "ai" : "rules";
  const raw = { ...input };
  return ingest(db, ownEntryEvent("manual", text, raw, opts.now), {
    ...opts, settings, start,
    fields: { ...overrides, parsed_by: parsedBy },
    ai: aiPreviewed || blank(text) ? false : opts.ai,
  });
}

const PARSE_FIELD_KEYS = [...CUSTOMER_FIELDS, ...JOB_FIELDS, "urgent"];

function bulkRowInput(row) {
  const fields = {};
  for (const key of PARSE_FIELD_KEYS) if (row?.fields?.[key] !== undefined) fields[key] = row.fields[key];
  const line = row?.line == null ? "" : String(row.line);
  if (!hasWhoPhoneOrProblem(fields)) fields.problem = shorten(oneLine(line), 60) || null;
  let stage = STAGE_IDS.includes(row?.stage) ? row.stage : "new";
  if (stage === "scheduled" && !isYmd(row?.visit_date)) stage = "to_schedule";
  return {
    line, fields, stage,
    quote_amount: row?.quote_amount ?? null, quote_sent_at: row?.quote_sent_at ?? null,
    visit_date: row?.visit_date ?? null, tech: row?.tech ?? null, lost_reason: row?.lost_reason ?? null,
  };
}

/**
 * Brain dump: POST /api/bulk. One 'bulk' message and job per row, at the row's stage
 * (a 'scheduled' row without a visit date becomes 'to_schedule'). AI is not used.
 * @returns {{created: number[], results: object[], errors: {index, code, message}[]}}
 */
export function ingestBulk(db, rows, opts = {}) {
  if (!opts.now) throw new Error("ingestBulk: opts.now is required");
  const { settings, tz } = settingsFor(db, opts);
  const created = [];
  const results = [];
  const errors = [];
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    try {
      const input = bulkRowInput(row);
      const start = startFor(input, STAGE_IDS, { now: opts.now, tz });
      const result = ingest(db, ownEntryEvent("bulk", input.line, row ?? {}, opts.now), {
        ...opts, settings, start, ai: false,
        fields: { ...input.fields, parsed_by: input.line.trim() ? "rules" : "manual" },
      });
      results.push(result);
      if (result.job_id != null) created.push(result.job_id);
    } catch (err) {
      errors.push({ index, code: err?.code ?? "error", message: errorText(err) });
    }
  });
  return { created, results, errors };
}
