// Texts to Denise on a clock (SPEC §11): the 7:00am digest (weekdays always, weekends only when
// someone is waiting on a call back), the Friday 3pm sweep and one reminder per untouched lead.
// tick() is idempotent: every text has a dedupe key, so running it twice sends nothing new.
import { get, all, tx } from "./db.js";
import * as clock from "./clock.js";
import { getSettings, getJobViews, getJobView, outboxByDedupe, insertEvent } from "./repo.js";
import { enqueue, deliver } from "./notify.js";
import { buildToday, digestText, sweepText, nagText, CALL_FIRST } from "../shared/today-rules.js";
import { replyIntent } from "../shared/parse.js";
import { localDate, localHM, weekdayOf, addMinutes } from "../shared/time.js";

const TICK_MS = 60_000;
const WINDOW_MINUTES = 180; // digest and sweep windows are 3 hours long
const DIGEST_MAX_LINES = 6; // mirrors digestText
const SWEEP_MAX_TITLES = 3; // mirrors sweepText
/** Buckets the Friday sweep counts (mirrors shared/today-rules.js). */
const SWEEP_BUCKETS = ["emergency", "replied", "new", "to_schedule", "quote"];
const NAG_HOURS = ["07:00", "21:00"];
const NAG_SKIP_MINUTES = 60;
const NAG_AFTER_MINUTES = { urgent: 30, normal: 120 };
const DEFAULT_PUBLIC_URL = "http://localhost:3000";

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
const todayCards = (today) => today.sections.flatMap((s) => s.items);

/** The context every shared rule gets at this tick. */
export function tickContext(db, nowIso, deps = {}) {
  const settings = deps.settings ?? getSettings(db);
  const env = deps.env ?? process.env;
  return {
    now: nowIso,
    tz: settings.timezone || "America/Chicago",
    settings,
    publicUrl: deps.publicUrl ?? env.PUBLIC_URL ?? DEFAULT_PUBLIC_URL,
    replyIntent,
  };
}

/** Jobs a digest lists by name: up to 6 lines (weekends: Call-first buckets only). */
function digestJobIds(today, ymd) {
  const cards = todayCards(today);
  const listed = isWeekend(ymd) ? cards.filter((c) => CALL_FIRST.includes(c.bucket)) : cards;
  return listed.slice(0, DIGEST_MAX_LINES).map((c) => c.job_id);
}

/** Jobs the Friday sweep lists by name: the first 3 titles. */
function sweepJobIds(today) {
  return todayCards(today).filter((c) => SWEEP_BUCKETS.includes(c.bucket))
    .slice(0, SWEEP_MAX_TITLES).map((c) => c.job_id);
}

/** Queue one text to Denise and log a `notified` event on each job it names. */
function dispatch(db, ctx, deps, { kind, body, job_id = null, dedupe_key, named, summary }) {
  const { settings, now } = ctx;
  if (!settings.owner_phone) return null;
  const row = enqueue(db, {
    kind, body, job_id, dedupe_key, to_phone: settings.owner_phone, to_name: settings.owner_name ?? null,
  }, { now, env: deps.env ?? process.env });
  if (!row) return null;
  for (const jobId of named) {
    insertEvent(db, {
      job_id: jobId, at: now, kind: "notified", actor: "system", summary,
      data: { outbox_id: row.id, kind },
    });
  }
  return row;
}

function digestStep(db, ctx, deps, lazyToday) {
  const ymd = localDate(ctx.now, ctx.tz);
  const key = `digest:${ymd}`;
  if (!inWindow(localHM(ctx.now, ctx.tz), ctx.settings.digest_time || "07:00", WINDOW_MINUTES)) return null;
  if (outboxByDedupe(db, key)) return null;
  const today = lazyToday();
  const { body, send } = digestText(today, ctx);
  if (!send) return null;
  return dispatch(db, ctx, deps, {
    kind: "digest", body, dedupe_key: key, named: digestJobIds(today, ymd),
    summary: isWeekend(ymd) ? NOTIFIED_SUMMARY.weekend : NOTIFIED_SUMMARY.weekday,
  });
}

function sweepStep(db, ctx, deps, lazyToday) {
  const ymd = localDate(ctx.now, ctx.tz);
  const key = `sweep:${ymd}`;
  if (weekdayOf(ymd) !== 5 || ctx.settings.friday_sweep === false) return null;
  if (!inWindow(localHM(ctx.now, ctx.tz), "15:00", WINDOW_MINUTES)) return null;
  if (outboxByDedupe(db, key)) return null;
  const today = lazyToday();
  const body = sweepText(today, ctx);
  if (!body) return null;
  return dispatch(db, ctx, deps, {
    kind: "friday_sweep", body, dedupe_key: key, named: sweepJobIds(today), summary: NOTIFIED_SUMMARY.friday_sweep,
  });
}

/** Untouched `new` jobs that have never had a reminder. */
function nagCandidates(db) {
  return all(db, `SELECT id, urgent, created_at FROM jobs
    WHERE stage = 'new' AND first_touch_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.dedupe_key = 'nag:' || jobs.id)
    ORDER BY created_at, id`);
}

/** True when a digest or sweep naming this job went out in the last 60 minutes. */
function recentlyNamed(db, jobId, now) {
  const since = addMinutes(now, -NAG_SKIP_MINUTES);
  return Boolean(get(db, `SELECT 1 AS hit FROM events
    WHERE job_id = ? AND kind = 'notified' AND at >= ? AND at <= ?
      AND json_extract(data_json, '$.kind') IN ('digest', 'friday_sweep') LIMIT 1`, [jobId, since, now]));
}

function nagSteps(db, ctx, deps) {
  const [from, until] = NAG_HOURS;
  if (!inWindow(localHM(ctx.now, ctx.tz), from, minutesOf(until) - minutesOf(from))) return [];
  const sent = [];
  for (const job of nagCandidates(db)) {
    const wait = job.urgent ? NAG_AFTER_MINUTES.urgent : NAG_AFTER_MINUTES.normal;
    if (Date.parse(addMinutes(job.created_at, wait)) > Date.parse(ctx.now)) continue;
    if (recentlyNamed(db, job.id, ctx.now)) continue;
    const row = dispatch(db, ctx, deps, {
      kind: "nag", body: nagText(getJobView(db, job.id), ctx), job_id: job.id,
      dedupe_key: `nag:${job.id}`, named: [job.id], summary: NOTIFIED_SUMMARY.nag,
    });
    if (row) sent.push(row);
  }
  return sent;
}

/**
 * Evaluate every §11 rule at `nowIso` and queue whatever is due.
 * deps: {env?, fetch?, publicUrl?, settings?}. Returns {sent: outbox rows, delivered: Promise}
 * where `delivered` settles once any Twilio sends finish (it never rejects).
 */
export function tick(db, nowIso, deps = {}) {
  const ctx = tickContext(db, nowIso, deps);
  let today = null;
  const lazyToday = () => (today ??= buildToday(getJobViews(db, { scope: "all" }), ctx));
  const sent = tx(db, () => [digestStep(db, ctx, deps, lazyToday), sweepStep(db, ctx, deps, lazyToday)]
    .filter(Boolean)
    .concat(nagSteps(db, ctx, deps)));
  const env = deps.env ?? process.env;
  const delivered = Promise.all(sent.map((row) => deliver(row, { db, env, fetch: deps.fetch })));
  return { sent, delivered };
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
