// The server's read side: the ctx every shared rule gets, and the JSON (and CSV) the API answers
// with (§13.4). Nothing here writes to the database; the actions that do live in server/actions.js.
import { all, get } from "./db.js";
import * as repo from "./repo.js";
import { smsMode, SENDING_NOTE } from "./notify.js";
import { AI_MODEL } from "./ai.js";
import { INBOUND_PATHS } from "./routes/inbound.js";
import {
  outcomesFor, promotionFor, isOpen, stageLabel, equipmentLabel, lostReasonLabel, OPEN_STAGES,
} from "../shared/stages.js";
import {
  buildToday, bucketFor, reasonFor, replySuggestion, isOnToday, digestText, sweepText,
} from "../shared/today-rules.js";
import { computeNumbers, numbersText } from "../shared/stats.js";
import { smsDraft, smsLink, telLink } from "../shared/templates.js";
import { titleFor, subtitleFor, sourceLabel, phoneDisplay, normalizePhone } from "../shared/format.js";
import { isRelayAddress } from "../shared/parse.js";
import {
  DEFAULT_TZ, localDate, daysBetween, weekdayName, dayLabel, timeLabel, whenLabel, shortDateLabel,
} from "../shared/time.js";

export const DEFAULT_PORT = 3000;

/** PUBLIC_URL without a trailing slash, else this machine on `port`. Worked out once at boot. */
export function resolvePublicUrl(env = {}, port = DEFAULT_PORT) {
  return String(env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, "");
}

/** ctx for the shared rules: {now, tz, settings, publicUrl}. */
export function contextFor(db, now, { publicUrl = resolvePublicUrl(), settings = repo.getSettings(db) } = {}) {
  return { now, tz: settings.timezone || DEFAULT_TZ, settings, publicUrl };
}

/** "Fri 4:47pm" within 6 days either way, else "Oct 14 9:30am". Never "today", so history lines stay true. */
function stampLabel(iso, { now, tz }) {
  const ymd = localDate(iso, tz);
  const near = Math.abs(daysBetween(localDate(now, tz), ymd)) <= 6;
  return `${near ? weekdayName(ymd) : dayLabel(ymd, now, tz)} ${timeLabel(iso, tz)}`;
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Jobs

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

/** GET /api/jobs/:id: the job, its customer, history, past jobs, outcome buttons and links. */
export function jobDetail(db, jv, ctx) {
  const job = serializeJob(jv, ctx);
  const phone = jv.customer?.phone ?? null;
  return {
    job,
    customer: repo.getCustomer(db, jv.customer_id),
    timeline: timelineFor(db, jv.id, ctx),
    past_jobs: repo.listPastJobs(db, jv.customer_id, jv.id).map((p) => serializeJob(p, ctx)),
    outcomes: outcomesFor(jv, { suggestion: promotionFor(jv, replySuggestion(jv, ctx)), now: ctx.now, tz: ctx.tz }),
    sms_link: smsLink(phone, smsDraft(jv, job.bucket, ctx)),
    tel_link: telLink(phone),
  };
}

/** How many cards Today has right now (§4.2: open and due, or a reply is unread). */
export function todayCount(db, now) {
  return repo.getJobViews(db, { scope: "open" }).filter((jv) => isOnToday(jv, now)).length;
}

function jobListViews(db, filter, q, now) {
  if (filter === "open") return repo.getJobViews(db, { scope: "open", q });
  if (filter === "closed") return repo.getJobViews(db, { scope: "closed30", q, now });
  if (OPEN_STAGES.includes(filter)) return repo.getJobViews(db, { scope: "open", stage: filter, q });
  if (filter === "done" || filter === "lost") return repo.getJobViews(db, { scope: "closed30", stage: filter, q, now });
  return null;
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

/**
 * GET /api/jobs: {now, counts, jobs} for a filter ("open", "closed" = the last 30 days, or a stage id),
 * or null when the filter is unknown.
 */
export function jobList(db, filter, q, ctx) {
  const views = jobListViews(db, filter, q, ctx.now);
  if (!views) return null;
  return { now: ctx.now, counts: stageCounts(db, ctx.now), jobs: sortJobs(views).map((jv) => serializeJob(jv, ctx)) };
}

// ---------------------------------------------------------------------------
// Today, Numbers, outbox and messages

/** True when the latest text to her own phone didn't go out (a text still sending doesn't count). */
function textsFailing(db, ownerPhone) {
  if (!ownerPhone) return false;
  const latest = get(db, "SELECT status, error FROM outbox WHERE to_phone = ? ORDER BY created_at DESC, id DESC LIMIT 1", [ownerPhone]);
  return latest?.status === "failed" && latest.error !== SENDING_NOTE;
}

/** GET /api/today: buildToday plus the demo-clock pill and whether texts are reaching her. */
export function todayPayload(db, ctx, { shifted }) {
  const today = buildToday(repo.getJobViews(db, { scope: "all" }), ctx);
  const label = shifted ? `Demo time: ${shortDateLabel(ctx.now, ctx.tz)}, ${timeLabel(ctx.now, ctx.tz)}` : null;
  return { ...today, demo: { shifted, label }, texts_failing: textsFailing(db, ctx.settings.owner_phone) };
}

/** The §10 numbers plus their plain-text summary (Numbers screen and the husband's page). */
export function numbersFor(db, ctx) {
  const numbers = computeNumbers(repo.getJobViews(db, { scope: "all" }), ctx);
  return { ...numbers, summary_text: numbersText(numbers, ctx) };
}

/** GET /api/digest/preview: the morning text and the Friday sweep as they would read right now. */
export function digestPreview(db, ctx) {
  const today = buildToday(repo.getJobViews(db, { scope: "all" }), ctx);
  return { digest: digestText(today, ctx), sweep: sweepText(today, ctx), now: ctx.now };
}

export function serializeOutbox(rows, ctx) {
  return rows.map((row) => ({
    id: row.id, created_at: row.created_at, at_label: stampLabel(row.created_at, ctx), kind: row.kind,
    to_phone: row.to_phone, to_name: row.to_name, body: row.body, status: row.status, job_id: row.job_id,
  }));
}

export function serializeMessages(rows) {
  return rows.map((m) => ({
    id: m.id, received_at: m.received_at, channel: m.channel, provider: m.provider, from_phone: m.from_phone,
    from_email: m.from_email, subject: m.subject, body: m.body, status: m.status, job_id: m.job_id,
  }));
}

// ---------------------------------------------------------------------------
// Settings

/**
 * GET/PUT /api/settings: settings plus integrations, readonly_url, webhook_urls (one per channel)
 * and forwarding_number. deps: {env, publicUrl, aiOn: boolean}.
 */
export function settingsPayload(settings, { env, publicUrl, aiOn }) {
  const token = env.INBOUND_TOKEN ? `?token=${encodeURIComponent(env.INBOUND_TOKEN)}` : "";
  const webhookUrls = Object.entries(INBOUND_PATHS).map(([channel, path]) => [channel, `${publicUrl}${path}${token}`]);
  return {
    ...settings,
    integrations: {
      ai: aiOn ? "claude" : "rules", ai_model: AI_MODEL, sms: smsMode(env),
      passcode: Boolean(env.APP_PASSCODE), inbound_token: Boolean(env.INBOUND_TOKEN),
    },
    readonly_url: `${publicUrl}/n/${settings.readonly_key}`,
    webhook_urls: Object.fromEntries(webhookUrls),
    forwarding_number: env.TWILIO_FROM || null,
  };
}

// ---------------------------------------------------------------------------
// Repeat customers in the Quick Add and Brain dump previews

/**
 * The customer her own entry would be filed under: a phone match, or an email match when no phone
 * was given (repo.matchCustomer). Her own address and relay mailers never identify a customer.
 */
function entryMatch(db, { phone, email }, settings) {
  const customer = repo.matchCustomer(db, { phone, email: isRelayAddress(email, settings.owner_email) ? null : email });
  return customer && { customer, match: normalizePhone(phone) ? "phone" : "email" };
}

/**
 * matched_customer for a preview: {id, title, match: 'phone'|'email', past_jobs (closed jobs),
 * open_job: {id, title, stage, stage_label, problem, quote_amount}|null}, or null.
 */
export function matchedCustomer(db, fields, settings) {
  const found = entryMatch(db, fields, settings);
  if (!found) return null;
  const { customer, match } = found;
  const title = titleFor({ customer });
  const closed = get(db, "SELECT count(*) AS n FROM jobs WHERE customer_id = ? AND stage IN ('done', 'lost')", [customer.id]).n;
  const open = repo.openJobsForCustomer(db, customer.id)[0] ?? null;
  return {
    id: customer.id, title, match, past_jobs: closed,
    open_job: open && {
      id: open.id, title, stage: open.stage, stage_label: stageLabel(open.stage),
      problem: open.problem, quote_amount: open.quote_amount,
    },
  };
}

// ---------------------------------------------------------------------------
// CSV export

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

/** Every job as CSV, with a UTF-8 BOM so spreadsheets read accents and dashes. */
export function jobsCsv(views) {
  return `﻿${[CSV_COLUMNS.join(","), ...views.map(csvRow)].join("\r\n")}\r\n`;
}
