// Texts to Denise on a clock (SPEC §11): the 7:00am digest (weekdays always, weekends only when
// someone is waiting on a call back), the Friday 3pm sweep and one reminder per untouched lead.
// tick() is idempotent: every text has a dedupe key, so running it twice sends nothing new. A text
// that fails to send is tried again within its window 15 and then 45 minutes later (3 tries at
// most), and the jobs it names get their `notified` history line only once it went out.
import { get, all, tx } from "./db.js";
import * as clock from "./clock.js";
import { getJobViews, getJobView, insertEvent } from "./repo.js";
import { enqueue, deliver, deliveryStatus } from "./notify.js";
import { contextFor } from "./context.js";
import { buildToday, digestText, sweepText, nagText, namedInDigest, namedInSweep } from "../shared/today-rules.js";
import { localDate, localHM, weekdayOf, addMinutes } from "../shared/time.js";

const TICK_MS = 60_000;
const WINDOW_MINUTES = 180; // digest and sweep windows are 3 hours long
const NAG_HOURS = ["07:00", "21:00"];
const NAG_SKIP_MINUTES = 60;
const NAG_AFTER_MINUTES = { urgent: 30, normal: 120 };
const MAX_SEND_TRIES = 3;
const RETRY_AFTER_MINUTES = [15, 45]; // try 2 and try 3, counted from the try before

const NOTIFIED_SUMMARY = {
  weekday: "In your morning text",
  weekend: "In your weekend text",
  friday_sweep: "In your before-the-weekend text",
  nag: "Reminder texted to you",
};

function minutesOf(hm) {
  const [h, m] = String(hm).split(":").map(Number);
  return h * 60 + m;
}

/** True when local wall time `hm` is in [start, start + length minutes). */
function inWindow(hm, start, lengthMinutes) {
  const t = minutesOf(hm);
  const s = minutesOf(start);
  return t >= s && t < s + lengthMinutes;
}

const isWeekend = (ymd) => [0, 6].includes(weekdayOf(ymd));
const wentOut = (row) => row?.status === "sent" || row?.status === "simulated";

/**
 * The dedupe key for the next try at the text `key` at `now`, or null when it went out, is still
 * sending, failed MAX_SEND_TRIES times or isn't due again yet (RETRY_AFTER_MINUTES). The first try
 * uses `key`; retries use `key#2`, `key#3`, so every failed try stays in the outbox.
 */
function nextTryKey(db, key, now) {
  const tries = all(db, "SELECT status, error, created_at FROM outbox WHERE dedupe_key = ? OR instr(dedupe_key, ?) = 1 ORDER BY id", [key, `${key}#`]);
  if (!tries.length) return key;
  const last = tries.at(-1);
  if (tries.length >= MAX_SEND_TRIES || deliveryStatus(last, now) !== "failed") return null;
  const due = addMinutes(last.created_at, RETRY_AFTER_MINUTES[tries.length - 1]);
  return Date.parse(now) >= Date.parse(due) ? `${key}#${tries.length + 1}` : null;
}

/** The `notified` history line on each job a text named (actor system). */
function recordNotified(db, { row, named, summary }) {
  for (const jobId of named) {
    insertEvent(db, {
      job_id: jobId, at: row.created_at, kind: "notified", actor: "system", summary,
      data: { outbox_id: row.id, kind: row.kind },
    });
  }
}

/** Queue one text to Denise. A simulated text has gone out already; a Twilio one once delivered. */
function dispatch(db, ctx, deps, { kind, body, job_id = null, dedupe_key, named, summary }) {
  const { settings, now } = ctx;
  if (!settings.owner_phone) return null;
  const row = enqueue(db, {
    kind, body, job_id, dedupe_key, to_phone: settings.owner_phone, to_name: settings.owner_name ?? null,
  }, { now, env: deps.env ?? process.env });
  if (!row) return null;
  const text = { row, named, summary };
  if (wentOut(row)) recordNotified(db, text);
  return text;
}

function digestStep(db, ctx, deps, lazyToday) {
  const ymd = localDate(ctx.now, ctx.tz);
  if (!inWindow(localHM(ctx.now, ctx.tz), ctx.settings.digest_time || "07:00", WINDOW_MINUTES)) return null;
  const dedupeKey = nextTryKey(db, `digest:${ymd}`, ctx.now);
  if (!dedupeKey) return null;
  const today = lazyToday();
  const { body, send } = digestText(today, ctx);
  if (!send) return null;
  return dispatch(db, ctx, deps, {
    kind: "digest", body, dedupe_key: dedupeKey, named: namedInDigest(today, ctx),
    summary: isWeekend(ymd) ? NOTIFIED_SUMMARY.weekend : NOTIFIED_SUMMARY.weekday,
  });
}

function sweepStep(db, ctx, deps, lazyToday) {
  const ymd = localDate(ctx.now, ctx.tz);
  if (weekdayOf(ymd) !== 5 || ctx.settings.friday_sweep === false) return null;
  if (!inWindow(localHM(ctx.now, ctx.tz), "15:00", WINDOW_MINUTES)) return null;
  const dedupeKey = nextTryKey(db, `sweep:${ymd}`, ctx.now);
  if (!dedupeKey) return null;
  const today = lazyToday();
  const body = sweepText(today, ctx);
  if (!body) return null;
  return dispatch(db, ctx, deps, {
    kind: "friday_sweep", body, dedupe_key: dedupeKey, named: namedInSweep(today), summary: NOTIFIED_SUMMARY.friday_sweep,
  });
}

/** Untouched `new` leads. Brain dump imports are her notebook backlog, not new arrivals, so never. */
function nagCandidates(db) {
  return all(db, `SELECT id, urgent, created_at FROM jobs
    WHERE stage = 'new' AND first_touch_at IS NULL AND source <> 'bulk'
    ORDER BY created_at, id`);
}

/** True when a digest or sweep naming this job went out in the last 60 minutes. */
function recentlyNamed(db, jobId, now) {
  const since = addMinutes(now, -NAG_SKIP_MINUTES);
  return Boolean(get(db, `SELECT 1 AS hit FROM events
    WHERE job_id = ? AND kind = 'notified' AND at >= ? AND at <= ?
      AND json_extract(data_json, '$.kind') IN ('digest', 'friday_sweep') LIMIT 1`, [jobId, since, now]));
}

/** Reminders, skipping jobs a digest or sweep named just now (`namedNow`) or in the last hour. */
function nagSteps(db, ctx, deps, namedNow) {
  const [from, until] = NAG_HOURS;
  if (!inWindow(localHM(ctx.now, ctx.tz), from, minutesOf(until) - minutesOf(from))) return [];
  const sent = [];
  for (const job of nagCandidates(db)) {
    const wait = job.urgent ? NAG_AFTER_MINUTES.urgent : NAG_AFTER_MINUTES.normal;
    if (Date.parse(addMinutes(job.created_at, wait)) > Date.parse(ctx.now)) continue;
    const dedupeKey = nextTryKey(db, `nag:${job.id}`, ctx.now);
    if (!dedupeKey || namedNow.has(job.id) || recentlyNamed(db, job.id, ctx.now)) continue;
    const text = dispatch(db, ctx, deps, {
      kind: "nag", body: nagText(getJobView(db, job.id), ctx), job_id: job.id,
      dedupe_key: dedupeKey, named: [job.id], summary: NOTIFIED_SUMMARY.nag,
    });
    if (text) sent.push(text);
  }
  return sent;
}

/** Send one queued Twilio text, then log it on the jobs it names if it went out. Never rejects. */
async function deliverText(db, text, deps) {
  if (wentOut(text.row)) return text.row;
  const final = await deliver(text.row, { db, env: deps.env ?? process.env, fetch: deps.fetch });
  try {
    if (wentOut(final)) recordNotified(db, { ...text, row: final });
  } catch (err) {
    console.warn(`[scheduler] could not log outbox ${text.row.id} on its jobs (${err?.name ?? "Error"})`);
  }
  return final;
}

/**
 * Evaluate every §11 rule at `nowIso` and queue whatever is due.
 * deps: {env?, fetch?, publicUrl?, settings?}. Returns {sent: outbox rows, delivered: Promise}
 * where `delivered` settles once any Twilio sends finish (it never rejects).
 */
export function tick(db, nowIso, deps = {}) {
  const ctx = contextFor(db, nowIso, { publicUrl: deps.publicUrl, settings: deps.settings });
  let today = null;
  const lazyToday = () => (today ??= buildToday(getJobViews(db, { scope: "all" }), ctx));
  const queued = tx(db, () => {
    const lists = [digestStep(db, ctx, deps, lazyToday), sweepStep(db, ctx, deps, lazyToday)].filter(Boolean);
    return lists.concat(nagSteps(db, ctx, deps, new Set(lists.flatMap((text) => text.named))));
  });
  const delivered = Promise.all(queued.map((text) => deliverText(db, text, deps)));
  return { sent: queued.map((text) => text.row), delivered };
}

/**
 * Run tick once now and then every 60 seconds. deps.now() gives the ISO time for each run.
 * Returns stop(). A failing tick is logged and never stops the timer.
 */
export function start(db, deps = {}) {
  const nowFn = deps.now ?? (() => clock.now().toISOString());
  const run = () => {
    try {
      tick(db, nowFn(), deps);
    } catch (err) {
      console.warn(`[scheduler] tick failed (${err?.name ?? "Error"}: ${err?.message ?? ""})`);
    }
  };
  run();
  const timer = setInterval(run, deps.intervalMs ?? TICK_MS);
  return () => clearInterval(timer);
}
