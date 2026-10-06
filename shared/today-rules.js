// Today list rules (spec §4) plus the texts to Denise (§11). Pure: `now` and `tz` come from
// ctx = {now, tz, settings, publicUrl}. Optional ctx.replyIntent(text) -> "yes"|"no"|null
// (shared/parse.js); without it a local keyword check with the §8.6 regexes is used.

import { isOpen, DENISE_OWES, OPEN_STAGES, stageLabel, stageShort, outcomesFor, promotionFor } from "./stages.js";
import {
  localDate, daysBetween, formatAge, dayLabel, dayTimeLabel, longDateLabel, weekdayOf,
} from "./time.js";
import {
  titleFor, subtitleFor, sourceLabel, channelPhrase, phoneDisplay, money, trunc, shorten,
} from "./format.js";
import { smsDraft, smsLink, telLink } from "./templates.js";

export const BUCKETS = Object.freeze([
  { id: "emergency", label: "Urgent - call first" },
  { id: "replied", label: "They got back to you" },
  { id: "new", label: "New - call them back" },
  { id: "to_schedule", label: "Said yes - needs scheduling" },
  { id: "quote", label: "Waiting on your quote" },
  { id: "nudge", label: "Waiting on their yes - check in" },
  { id: "check_done", label: "Did it get done?" },
]);

/** Buckets that weekend texts mention. */
export const CALL_FIRST = Object.freeze(["emergency", "replied", "new"]);
/** Buckets where the next move is Denise's: what the Friday sweep counts. */
const SWEEP_BUCKETS = ["emergency", "replied", "new", "to_schedule", "quote"];
const BUCKET_INDEX = Object.fromEntries(BUCKETS.map((b, i) => [b.id, i]));

const HOUR_MS = 3_600_000;
const DIGEST_MAX_LINES = 6;
const DEFAULT_PUBLIC_URL = "http://localhost:3000";

const YES_WORDS = /\b(yes|yep|yeah|yup|go ahead|sounds good|let'?s do it|do it|approved?|book (it|us)|deal)\b/i;
const NO_WORDS = /\b(no thanks|not (right )?now|we'?ll pass|pass on|went with (someone|somebody|another)|found (someone|somebody)|too (much|expensive|pricey)|not interested|cancel)\b/i;

const ms = (iso) => Date.parse(iso);

/** Keyword reply intent (§8.6), used when ctx.replyIntent is not supplied. */
export function localReplyIntent(text) {
  const s = String(text ?? "");
  const yes = YES_WORDS.test(s);
  const no = NO_WORDS.test(s);
  if (yes === no) return null;
  return yes ? "yes" : "no";
}

export function isDue(job, now) {
  return job.next_due_at != null && ms(job.next_due_at) <= ms(now);
}

/** True when the job belongs on Today (§4.2). */
export function isOnToday(job, now) {
  return isOpen(job.stage) && (isDue(job, now) || job.unread_inbound_at != null);
}

/** The single bucket a job falls in (§4.3), or null when it is not on Today. */
export function bucketFor(jv, ctx) {
  if (!isOnToday(jv, ctx.now)) return null;
  const due = isDue(jv, ctx.now);
  if (jv.urgent && DENISE_OWES.includes(jv.stage)) return "emergency";
  if (jv.unread_inbound_at) return "replied";
  if (!due) return null;
  switch (jv.stage) {
    case "new": return "new";
    case "to_schedule": return "to_schedule";
    case "quote": return "quote";
    case "waiting_yes": return "nudge";
    case "scheduled": return "check_done";
    default: return null;
  }
}

/** "mark_yes" / "mark_lost" for an unread reply on a quote or waiting_yes job (§4.12), else null. */
export function replySuggestion(jv, ctx = {}) {
  if (jv.stage !== "waiting_yes" && jv.stage !== "quote") return null;
  if (!jv.unread_inbound_at || !jv.last_inbound?.body) return null;
  const intent = (ctx.replyIntent ?? localReplyIntent)(jv.last_inbound.body);
  if (intent === "yes") return "mark_yes";
  if (intent === "no") return "mark_lost";
  return null;
}

// ---------------------------------------------------------------------------
// Reason lines (§4.6)

function isMissedCall(jv) {
  return jv.source === "call" && jv.source_detail === "missed";
}

function isAnsweredCall(jv) {
  return jv.source === "call" && jv.source_detail === "answered";
}

/** `problem`, or the §4.5 fallback when it is null. */
function problemText(jv) {
  if (jv.problem) return jv.problem;
  if (isMissedCall(jv)) return "no voicemail";
  if (isAnsweredCall(jv)) return "what was it about?";
  return "no details";
}

/** `problem` shortened to 50 characters, or the §11 fallback, for texts to Denise. */
function problem50(jv) {
  if (jv.problem) return shorten(jv.problem, 50);
  if (isMissedCall(jv)) return "missed call, no voicemail";
  if (isAnsweredCall(jv)) return "what was it about?";
  return "no details";
}

function quoted(body) {
  return `"${trunc(String(body ?? "").replace(/\s+/g, " ").trim(), 60)}"`;
}

/** "Texted yesterday 6:05pm: "..."" and friends: the customer wrote back. */
function inboundReason(jv, { now, tz }) {
  const msg = jv.last_inbound;
  const when = dayTimeLabel(msg?.at ?? jv.unread_inbound_at, now, tz);
  switch (msg?.channel) {
    case "sms": return `Texted ${when}: ${quoted(msg.body)}`;
    case "email":
    case "form": return `Emailed ${when}: ${quoted(msg.body)}`;
    case "call":
      if (msg.call_status === "missed") return `Called ${when} (missed, no voicemail)`;
      if (msg.call_status === "answered") return `You talked ${when} - what happened?`;
      return `Called ${when}: ${quoted(msg.body)}`;
    default:
      return msg?.body ? `Wrote ${when}: ${quoted(msg.body)}` : `Got back to you ${when}`;
  }
}

/** " - hasn't heard from us in {n} days" once 2+ calendar days have passed (quote, to_schedule). */
function silence(jv, { now, tz }) {
  const n = daysBetween(localDate(jv.last_touch_at ?? jv.created_at, tz), localDate(now, tz));
  return n >= 2 ? ` - hasn't heard from us in ${n} days` : "";
}

function emergencyReason(jv, ctx) {
  if (jv.unread_inbound_at) return inboundReason(jv, ctx);
  const { now, tz } = ctx;
  const problem = problemText(jv);
  const day = dayLabel(jv.stage_entered_at, now, tz);
  if (jv.stage === "quote") return `${problem} - waiting on your quote since ${day}`;
  if (jv.stage === "to_schedule") return `${problem} - said yes ${day}, not scheduled yet`;
  const came = `${problem} - ${channelPhrase(jv.source, jv.source_detail)} ${dayTimeLabel(jv.created_at, now, tz)}`;
  return jv.attempts > 0 ? `${came}, tried ${jv.attempts}x, no answer` : `${came}, nobody's called back`;
}

function newReason(jv, { now, tz }) {
  const tried = jv.attempts > 0 ? ` - tried ${jv.attempts}x` : "";
  return `New - ${channelPhrase(jv.source, jv.source_detail)} ${dayTimeLabel(jv.created_at, now, tz)} - ${problemText(jv)}${tried}`;
}

function nudgeReason(jv, { now, tz }) {
  const sentAt = jv.quote_sent_at ?? jv.stage_entered_at;
  const amount = jv.quote_amount != null ? `, ${money(jv.quote_amount)}` : "";
  const head = `Quote sent ${dayLabel(sentAt, now, tz)}${amount}`;
  const nudges = jv.nudges ?? 0;
  if (nudges >= 3) return `${head} - ${nudges} tries, no answer. Mark lost?`;
  const n = daysBetween(localDate(jv.last_touch_at ?? sentAt, tz), localDate(now, tz));
  const nudged = nudges >= 1 ? ` - nudged ${nudges}x` : "";
  return `${head} - no answer in ${n} ${n === 1 ? "day" : "days"}${nudged}`;
}

function checkDoneReason(jv, { now, tz }) {
  const day = dayLabel(jv.visit_date, now, tz);
  return jv.tech ? `${jv.tech} went ${day} - done?` : `Visit was ${day} - done?`;
}

/** The card's plain-English reason line (§4.6), or null when the job is not on Today. */
export function reasonFor(jv, ctx, bucket = bucketFor(jv, ctx)) {
  const { now, tz } = ctx;
  switch (bucket) {
    case "emergency": return emergencyReason(jv, ctx);
    case "replied": return inboundReason(jv, ctx);
    case "new": return newReason(jv, ctx);
    case "to_schedule": return `Said yes ${dayLabel(jv.stage_entered_at, now, tz)} - not scheduled yet${silence(jv, ctx)}`;
    case "quote": return `Waiting on your quote since ${dayLabel(jv.stage_entered_at, now, tz)}${silence(jv, ctx)}`;
    case "nudge": return nudgeReason(jv, ctx);
    case "check_done": return checkDoneReason(jv, ctx);
    default: return null;
  }
}

function repliedLineReason(msg) {
  switch (msg?.channel) {
    case "sms": return "texted back";
    case "email":
    case "form": return "emailed back";
    case "call": return msg.call_status === "answered" ? "you talked - what happened?" : "called (missed)";
    default: return "got back to you";
  }
}

/** The short reason used in texts to Denise (§11 "Line reasons"). */
export function lineReason(jv, ctx, bucket = bucketFor(jv, ctx)) {
  switch (bucket) {
    case "emergency": return `${problem50(jv)} (URGENT)`;
    case "replied": return repliedLineReason(jv.last_inbound);
    case "new": return `new: ${problem50(jv)}`;
    case "to_schedule": return "said yes, needs scheduling";
    case "quote": return "quote to send";
    case "nudge": return `chase quote${jv.quote_amount != null ? ` (${money(jv.quote_amount)})` : ""}`;
    case "check_done": {
      const day = dayLabel(jv.visit_date, ctx.now, ctx.tz);
      return jv.tech ? `done? (${jv.tech} went ${day})` : `done? (visit was ${day})`;
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Chips (§4.7) and ordering (§4.4)

/** The bucket's "waiting since" sort key: an ISO instant, or visit_date for check_done. */
export function waitingSince(jv, bucket) {
  switch (bucket) {
    case "emergency":
      return jv.unread_inbound_at ?? (jv.stage === "new" ? jv.created_at : jv.stage_entered_at);
    case "replied": return jv.unread_inbound_at;
    case "new": return jv.created_at;
    case "nudge": return jv.last_touch_at ?? jv.quote_sent_at ?? jv.stage_entered_at;
    case "check_done": return jv.visit_date;
    default: return jv.stage_entered_at;
  }
}

function toneFor(bucket, ageMs) {
  if (bucket === "emergency") return "red";
  if (bucket === "nudge") return "amber";
  if (bucket === "check_done") return "grey";
  if (ageMs >= 48 * HOUR_MS) return "red";
  if (ageMs >= 24 * HOUR_MS) return "amber";
  return "grey";
}

/** { text, tone } for the card chip, or null (check_done, or not on Today). */
export function chipFor(jv, ctx, bucket = bucketFor(jv, ctx)) {
  if (!bucket) return null;
  const { now, tz } = ctx;
  const chip = (text, since) => ({ text, tone: toneFor(bucket, ms(now) - ms(since)) });
  if (jv.stage === "new" && jv.attempts > 0) {
    return chip(`Tried ${jv.attempts}x - ${formatAge(jv.created_at, now)}`, jv.created_at);
  }
  if (jv.stage === "new" && !jv.first_touch_at) {
    return chip(`Not contacted - ${formatAge(jv.created_at, now)}`, jv.created_at);
  }
  const since = waitingSince(jv, bucket);
  if (jv.snoozed_until && ms(jv.snoozed_until) <= ms(now)) {
    const text = localDate(jv.snoozed_until, tz) === localDate(now, tz)
      ? "Call back today"
      : `Call back was ${dayLabel(jv.snoozed_until, now, tz)}`;
    return chip(text, since);
  }
  if (bucket === "check_done") return null;
  return chip(formatAge(since, now), since);
}

const sortMs = (key) => (key == null ? Infinity : ms(key));

/** Bucket order, then the bucket's sort key, then (nudge) bigger quote first, then id. */
export function compareCards(a, b) {
  const byBucket = BUCKET_INDEX[a.bucket] - BUCKET_INDEX[b.bucket];
  if (byBucket) return byBucket;
  const byKey = sortMs(a.sort_key) - sortMs(b.sort_key);
  if (byKey) return byKey;
  if (a.bucket === "nudge" && a.quote_amount !== b.quote_amount) {
    if (a.quote_amount == null) return 1;
    if (b.quote_amount == null) return -1;
    return b.quote_amount - a.quote_amount;
  }
  return a.job_id - b.job_id;
}

// ---------------------------------------------------------------------------
// Cards and the Today screen (§4.5, §4.8, §13.4)

function badgesFor(urgent, pastJobs) {
  const badges = [];
  if (urgent) badges.push("URGENT");
  if (pastJobs >= 1) badges.push(`Repeat - ${pastJobs} past job${pastJobs === 1 ? "" : "s"}`);
  return badges;
}

/**
 * One Today card (§13.4 Card), plus `badges` (display text), `line_reason` (for texts),
 * `sort_key` and `quote_amount` (for compareCards). `last_inbound` is set only while a reply
 * is unread, which is when the outcome sheet shows it. `rank` is filled in by buildToday.
 */
export function cardFor(jv, ctx) {
  const { now, tz } = ctx;
  const bucket = bucketFor(jv, ctx);
  const suggestion = promotionFor(jv, replySuggestion(jv, ctx));
  const phone = jv.customer?.phone ?? null;
  const pastJobs = jv.past_jobs ?? 0;
  const urgent = bucket === "emergency";
  const unread = jv.unread_inbound_at && jv.last_inbound ? jv.last_inbound : null;
  return {
    job_id: jv.id,
    bucket,
    rank: 0,
    title: titleFor(jv),
    subtitle: subtitleFor(jv),
    urgent,
    repeat: pastJobs >= 1 ? { past_jobs: pastJobs } : null,
    badges: badgesFor(urgent, pastJobs),
    reason: reasonFor(jv, ctx, bucket),
    line_reason: lineReason(jv, ctx, bucket),
    chip: chipFor(jv, ctx, bucket),
    source: jv.source,
    source_label: sourceLabel(jv.source, jv.source_detail),
    stage: jv.stage,
    stage_label: stageLabel(jv.stage),
    phone,
    phone_display: phoneDisplay(phone),
    email: jv.customer?.email ?? null, // lets an email-only lead still be answered from its card
    tel_link: telLink(phone),
    sms_link: smsLink(phone, smsDraft(jv, bucket, ctx)),
    suggestion,
    last_inbound: unread && {
      at: unread.at, at_label: dayTimeLabel(unread.at, now, tz), channel: unread.channel, body: unread.body,
    },
    outcomes: outcomesFor(jv, { suggestion, now, tz }),
    sort_key: bucket ? waitingSince(jv, bucket) : null,
    quote_amount: jv.quote_amount ?? null,
  };
}

function headerFor(count) {
  if (count === 0) return "All caught up";
  return count === 1 ? "1 person to call" : `${count} people to call`;
}

/** "Last 24 hours: ..." trust line (§4.8). `not_a_job` jobs are left out. */
function last24hText(jobs, now) {
  const nowMs = ms(now);
  const recent = jobs.filter((j) => j.lost_reason !== "not_a_job"
    && ms(j.created_at) > nowMs - 24 * HOUR_MS && ms(j.created_at) <= nowMs);
  if (recent.length === 0) return "Nothing new in the last 24 hours";
  const notCalled = recent.filter((j) => j.stage === "new" && !j.first_touch_at).length;
  return notCalled === 0
    ? `Last 24 hours: ${recent.length} came in, all handled`
    : `Last 24 hours: ${recent.length} came in, ${notCalled} not called yet`;
}

/** "New 3 · Waiting on quote 3 · Their yes 2 · Said yes 2 · Scheduled 3". */
export function stripText(stageCounts) {
  return OPEN_STAGES.map((s) => `${stageShort(s)} ${stageCounts[s] ?? 0}`).join(" · ");
}

/**
 * The Today screen (§13.4 Today). Extra display fields: `waiting_yes_text` (header line 3,
 * null when $0), `strip` and `footer.text`. `demo` is always unshifted here; the server sets it.
 */
export function buildToday(jobViews, ctx) {
  const { now, tz } = ctx;
  const open = jobViews.filter((jv) => isOpen(jv.stage));
  const cards = open.filter((jv) => bucketFor(jv, ctx)).map((jv) => cardFor(jv, ctx)).sort(compareCards);
  cards.forEach((card, i) => { card.rank = i + 1; });

  const sections = BUCKETS
    .map((b) => {
      const items = cards.filter((c) => c.bucket === b.id);
      return { bucket: b.id, label: b.label, count: items.length, items };
    })
    .filter((s) => s.count > 0);

  const stageCounts = Object.fromEntries(OPEN_STAGES.map((s) => [s, open.filter((j) => j.stage === s).length]));
  const waitingYes = open.filter((j) => j.stage === "waiting_yes");
  const waitingYesTotal = waitingYes.reduce((sum, j) => sum + (j.quote_amount ?? 0), 0);
  const today = localDate(now, tz);
  const scheduledToday = open.filter((j) => j.stage === "scheduled" && j.visit_date === today).length;
  const snoozed = open.filter((j) => j.snoozed_until && ms(j.snoozed_until) > ms(now) && !j.unread_inbound_at).length;

  return {
    now,
    date_label: longDateLabel(now, tz),
    count: cards.length,
    header: headerFor(cards.length),
    waiting_yes_total: waitingYesTotal,
    waiting_yes_count: waitingYes.length,
    waiting_yes_text: waitingYesTotal > 0 ? `${money(waitingYesTotal)} waiting on a yes` : null,
    sections,
    stage_counts: stageCounts,
    strip: OPEN_STAGES.map((s) => ({ stage: s, label: stageShort(s), count: stageCounts[s] })),
    open_count: open.length,
    footer: {
      scheduled_today: scheduledToday,
      snoozed,
      text: `Scheduled today: ${scheduledToday} · Snoozed: ${snoozed}`,
      last24h_text: last24hText(jobViews, now),
    },
    demo: { shifted: false, label: null },
  };
}

// ---------------------------------------------------------------------------
// Texts to Denise (§11, §0.4)

function baseUrl(ctx) {
  return String(ctx.publicUrl || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
}

function todayCards(today) {
  return today.sections.flatMap((s) => s.items);
}

/** Header, up to 6 numbered lines, "+k more.", then the link, joined with "\n" (§0.4). */
function listText(header, cards, link) {
  const lines = [header];
  cards.slice(0, DIGEST_MAX_LINES).forEach((c, i) => lines.push(`${i + 1}. ${c.title} - ${c.line_reason}`));
  if (cards.length > DIGEST_MAX_LINES) lines.push(`+${cards.length - DIGEST_MAX_LINES} more.`);
  lines.push(`Open: ${link}`);
  return lines.join("\n");
}

/**
 * The morning text. Weekdays: always sent ({send:true}). Weekends: only the Call-first
 * buckets, and only sent when there are some and `weekend_digest` is on.
 */
export function digestText(today, ctx) {
  const now = ctx.now ?? today.now;
  const settings = ctx.settings ?? {};
  const owner = settings.owner_name || "Denise";
  const link = `${baseUrl(ctx)}/#/`;
  const cards = todayCards(today);
  const weekday = weekdayOf(localDate(now, ctx.tz));
  if (weekday !== 0 && weekday !== 6) {
    if (cards.length === 0) return { body: `Morning ${owner} - nobody's waiting on you today. Nice. Open: ${link}`, send: true };
    return { body: listText(`Morning ${owner} - ${cards.length} to call today:`, cards, link), send: true };
  }
  const callFirst = cards.filter((c) => CALL_FIRST.includes(c.bucket));
  if (callFirst.length === 0) return { body: `Weekend check - nobody's waiting on a call back. Open: ${link}`, send: false };
  return {
    body: listText(`Weekend check - ${callFirst.length} waiting on a call back:`, callFirst, link),
    send: settings.weekend_digest !== false,
  };
}

/** The Friday 3pm "before the weekend" text, or null when nobody is waiting on her (or it is off). */
export function sweepText(today, ctx) {
  if (ctx.settings?.friday_sweep === false) return null;
  const waiting = todayCards(today).filter((c) => SWEEP_BUCKETS.includes(c.bucket));
  if (waiting.length === 0) return null;
  const n = waiting.length;
  const titles = waiting.slice(0, 3).map((c) => c.title).join(", ");
  const more = n > 3 ? `, +${n - 3} more` : "";
  return `Before the weekend: ${n} ${n === 1 ? "person" : "people"} still waiting on you - ${titles}${more}. Open: ${baseUrl(ctx)}/#/`;
}

/** The one-time reminder for an untouched new lead (§11). */
export function nagText(jv, ctx) {
  const { now, tz } = ctx;
  const title = titleFor(jv);
  const urgent = jv.urgent ? " (URGENT)" : "";
  const what = problem50(jv);
  const sentenceEnd = /[.!?]$/.test(what) ? "" : ".";
  const phone = phoneDisplay(jv.customer?.phone);
  const call = phone && phone !== title ? ` Call ${phone}.` : "";
  return `Still not called back${urgent}: ${title} - ${what}${sentenceEnd} Came in ${dayTimeLabel(jv.created_at, now, tz)}.${call} Open: ${baseUrl(ctx)}/#/job/${jv.id}`;
}
