// Stage model and outcome rules (spec §3 and §5). Pure: every instant comes from ctx.now,
// nothing reads the system clock, and no input object is ever mutated.

import {
  localDate, isYmd, nextBusinessDay, addBusinessDays, startOfDay, addMinutes, daysBetween,
  dayLabel, whenLabel, weekdayName,
} from "./time.js";
import { money } from "./format.js";

export const STAGES = Object.freeze([
  { id: "new", label: "New - call them back", short: "New", open: true },
  { id: "quote", label: "Waiting on quote", short: "Waiting on quote", open: true },
  { id: "waiting_yes", label: "Waiting on their yes", short: "Their yes", open: true },
  { id: "to_schedule", label: "Said yes - needs scheduling", short: "Said yes", open: true },
  { id: "scheduled", label: "Scheduled", short: "Scheduled", open: true },
  { id: "done", label: "Done", short: "Done", open: false },
  { id: "lost", label: "Lost", short: "Lost", open: false },
]);

export const OPEN_STAGES = Object.freeze(STAGES.filter((s) => s.open).map((s) => s.id));

/** Stages where the next move is Denise's. */
export const DENISE_OWES = Object.freeze(["new", "quote", "to_schedule"]);

export const LOST_REASONS = Object.freeze([
  { id: "went_elsewhere", label: "Went with someone else" },
  { id: "price", label: "Too pricey" },
  { id: "fixed_themselves", label: "Fixed it themselves" },
  { id: "no_response", label: "Never answered" },
  { id: "not_a_job", label: "Not a real job" },
]);

/** Same ids as server/ai.js. "other" is shown as no chip. */
export const EQUIPMENT = Object.freeze([
  { id: "walk_in_cooler", label: "Walk-in cooler" },
  { id: "walk_in_freezer", label: "Walk-in freezer" },
  { id: "ice_machine", label: "Ice machine" },
  { id: "reach_in", label: "Reach-in" },
  { id: "display_case", label: "Display case" },
  { id: "prep_table", label: "Prep table" },
  { id: "other", label: "Other" },
]);

/**
 * The outcome catalogue (§5.2), in catalogue order. `label` is the default button label,
 * `labels` overrides it per stage, `stages` lists where it is offered, `contact` says whether
 * it counts as contact (sets last_touch_at / first_touch_at).
 */
export const OUTCOMES = Object.freeze([
  { id: "no_answer", label: "No answer", labels: {}, stages: ["new", "waiting_yes", "to_schedule"], needs: null, contact: true },
  { id: "need_quote", label: "Talked - needs a quote", labels: { scheduled: "Needs a quote for more work" }, stages: ["new", "scheduled"], needs: null, contact: true },
  { id: "quote_sent", label: "Quote sent", labels: { new: "Quoted on the call" }, stages: ["new", "quote"], needs: "amount", contact: true },
  { id: "yes", label: "They said yes", labels: { new: "Booked it" }, stages: ["new", "quote", "waiting_yes"], needs: "day_or_none", contact: true },
  { id: "still_thinking", label: "Still thinking", labels: {}, stages: ["waiting_yes"], needs: null, contact: true },
  { id: "scheduled", label: "Scheduled", labels: { scheduled: "Moved to another day" }, stages: ["to_schedule", "scheduled"], needs: "day", contact: true },
  { id: "done", label: "Done", labels: {}, stages: ["scheduled"], needs: "amount", contact: true },
  { id: "another_visit", label: "Needs another visit", labels: {}, stages: ["scheduled"], needs: null, contact: true },
  { id: "snooze", label: "Not today", labels: {}, stages: [...OPEN_STAGES], needs: "snooze_day", contact: false },
  { id: "lost", label: "Lost", labels: { scheduled: "Cancelled" }, stages: [...OPEN_STAGES], needs: "lost_reason", contact: false },
  { id: "not_a_job", label: "Not a job", labels: {}, stages: ["new"], needs: null, contact: false },
  { id: "seen", label: "Seen it", labels: {}, stages: [...OPEN_STAGES], needs: null, contact: false },
]);

const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const STAGE_BY_ID = byId(STAGES);
const OUTCOME_BY_ID = byId(OUTCOMES);
const LOST_REASON_BY_ID = byId(LOST_REASONS);
const EQUIPMENT_BY_ID = byId(EQUIPMENT);

/** Main buttons per stage, in button order (§5.3). The quiet row follows them. */
const MAIN_BUTTONS = {
  new: ["no_answer", "need_quote", "yes", "quote_sent", "not_a_job"],
  quote: ["quote_sent", "yes"],
  waiting_yes: ["yes", "still_thinking", "no_answer"],
  to_schedule: ["scheduled", "no_answer"],
  scheduled_past: ["done", "another_visit", "need_quote", "scheduled"],
  scheduled_upcoming: ["scheduled", "done", "another_visit", "need_quote"],
};
const QUIET_ROW = ["snooze", "lost"];

/** Promotions (§5.3, §4.12), keyed by the card's `suggestion` value. */
const PROMOTIONS = {
  mark_yes: { outcome: "yes", label: "Mark as yes?" },
  mark_lost: { outcome: "lost", label: "Mark lost?" },
  not_a_job: { outcome: "not_a_job", label: "Not a job?" },
  mark_lost_tries: { outcome: "lost", label: "Mark lost", preset: { lost_reason: "no_response" } },
};

const SOMEONE_ELSE = /\b(went with (someone|somebody|another)|found (someone|somebody|another)|(someone|somebody) else|another (company|guy|tech|shop|outfit))\b/i;

export class OutcomeError extends Error {
  /** @param {"invalid_outcome"|"missing_arg"} code */
  constructor(code, message = code) {
    super(message);
    this.name = "OutcomeError";
    this.code = code;
  }
}

export function isOpen(stage) {
  return STAGE_BY_ID[stage]?.open === true;
}

/** Every move is allowed (D3); only "no move" is refused. */
export function canTransition(from, to) {
  return from !== to;
}

export function stageLabel(id) {
  return STAGE_BY_ID[id]?.label ?? null;
}

export function stageShort(id) {
  return STAGE_BY_ID[id]?.short ?? null;
}

export function equipmentLabel(id) {
  return EQUIPMENT_BY_ID[id]?.label ?? null;
}

export function lostReasonLabel(id) {
  return LOST_REASON_BY_ID[id]?.label ?? null;
}

// ---------------------------------------------------------------------------
// enterStage (§3 "On entering this stage" + "What every stage entry does")

/** Per-stage entry fields. `args`: amount, quote_sent_at, visit_date, tech, lost_reason, import. */
const ENTRY = {
  new: (job, { now }) => ({ next_due_at: now }),
  quote: (job, { now, tz }, args) => ({
    next_due_at: args.import ? now
      : job.urgent ? addMinutes(now, 120)
      : startOfDay(nextBusinessDay(localDate(now, tz)), tz),
  }),
  waiting_yes: (job, { now, tz }, args) => {
    const sentAt = args.quote_sent_at ?? now;
    return {
      quote_sent_at: sentAt,
      quote_amount: args.amount ?? job.quote_amount ?? null,
      nudges: 0,
      next_due_at: startOfDay(addBusinessDays(localDate(sentAt, tz), 2), tz),
    };
  },
  to_schedule: (job, { now }) => ({ won_at: job.won_at ?? now, visit_date: null, next_due_at: now }),
  scheduled: (job, { now, tz }, args) => {
    const visitDate = requireDay(args.visit_date, "visit_date");
    return {
      visit_date: visitDate,
      tech: args.tech ?? null,
      won_at: job.won_at ?? now,
      next_due_at: startOfDay(nextBusinessDay(visitDate), tz),
    };
  },
  done: (job, { now }, args) => ({
    done_at: now, closed_at: now, won_at: job.won_at ?? now,
    quote_amount: args.amount ?? job.quote_amount ?? null,
    next_due_at: null,
  }),
  lost: (job, { now }, args) => ({
    lost_at: now, closed_at: now, lost_reason: args.lost_reason ?? null, next_due_at: null,
  }),
};

/**
 * The patch for moving `job` into stage `to` (also used for re-entering the same stage,
 * e.g. "Moved to another day"). Throws OutcomeError("missing_arg") for `scheduled`
 * without a visit_date. `args.import: true` makes a Quick Add / Brain dump `quote` due now.
 */
export function enterStage(job, to, ctx, args = {}) {
  if (!STAGE_BY_ID[to]) throw new OutcomeError("invalid_outcome", `Unknown stage: ${to}`);
  const { now } = ctx;
  const patch = {
    stage: to, stage_entered_at: now, attempts: 0,
    snoozed_until: null, unread_inbound_at: null, updated_at: now,
  };
  if (isOpen(to) && !isOpen(job.stage)) {
    Object.assign(patch, { closed_at: null, done_at: null, lost_at: null, lost_reason: null });
  }
  return Object.assign(patch, ENTRY[to](job, ctx, args ?? {}));
}

// ---------------------------------------------------------------------------
// Outcome buttons (§5.3)

function offeredIds(job) {
  if (!isOpen(job.stage)) return new Set();
  const ids = OUTCOMES.filter((o) => o.stages.includes(job.stage)).map((o) => o.id);
  return new Set(job.unread_inbound_at ? ids : ids.filter((id) => id !== "seen"));
}

/** Ids of the outcomes `applyOutcome` accepts for this job right now. */
export function offeredOutcomes(job) {
  return [...offeredIds(job)];
}

function triedThreeTimes(job) {
  return (job.stage === "new" && (job.attempts ?? 0) >= 3)
    || (job.stage === "waiting_yes" && (job.nudges ?? 0) >= 3);
}

/**
 * The single promotion that applies (§5.3 priority): a reply suggestion ("mark_yes" /
 * "mark_lost", from replySuggestion), then AI "Not a job?", then 3+ failed tries.
 */
export function promotionFor(job, replySuggestion = null) {
  const offered = offeredIds(job);
  if (replySuggestion === "mark_yes" && offered.has("yes")) return "mark_yes";
  if (replySuggestion === "mark_lost" && offered.has("lost")) return "mark_lost";
  if (job.stage === "new" && job.ai_not_service) return "not_a_job";
  if (triedThreeTimes(job)) return "mark_lost_tries";
  return null;
}

function button(id, stage, primary) {
  const def = OUTCOME_BY_ID[id];
  return { id, label: def.labels[stage] ?? def.label, primary, suggested: false, needs: def.needs };
}

function mainButtonIds(job, now, tz) {
  if (job.stage !== "scheduled") return MAIN_BUTTONS[job.stage];
  const upcoming = now && isYmd(job.visit_date) && job.visit_date >= localDate(now, tz);
  return upcoming ? MAIN_BUTTONS.scheduled_upcoming : MAIN_BUTTONS.scheduled_past;
}

function promotedButton(job, promotion) {
  const { outcome, label, preset } = PROMOTIONS[promotion];
  const btn = { id: outcome, label, primary: true, suggested: true, needs: OUTCOME_BY_ID[outcome].needs };
  if (preset) btn.preset = { ...preset };
  if (promotion === "mark_lost" && SOMEONE_ELSE.test(job.last_inbound?.body ?? "")) {
    btn.preset = { lost_reason: "went_elsewhere" };
  }
  return btn;
}

/**
 * Buttons for the outcome sheet: main buttons (primary) then the quiet row (primary:false).
 * Pass `{...ctx, suggestion}`: `now`/`tz` pick the scheduled-stage order (without them the
 * "visit date before today" order is used). "Open job" is navigation, not an outcome, so the
 * UI adds it after the quiet row.
 */
export function outcomesFor(jobView, { suggestion = null, now = null, tz = null } = {}) {
  if (!isOpen(jobView.stage)) return [];
  const stage = jobView.stage;
  const quietIds = jobView.unread_inbound_at ? ["seen", ...QUIET_ROW] : QUIET_ROW;
  let buttons = [
    ...mainButtonIds(jobView, now, tz).map((id) => button(id, stage, true)),
    ...quietIds.map((id) => button(id, stage, false)),
  ];
  const done = buttons.find((b) => b.id === "done");
  if (done && jobView.quote_amount != null) done.preset = { amount: jobView.quote_amount };
  const promotion = promotionFor(jobView, suggestion);
  if (promotion) {
    const promoted = promotedButton(jobView, promotion);
    buttons = [promoted, ...buttons.filter((b) => b.id !== promoted.id)];
  }
  return buttons;
}

// ---------------------------------------------------------------------------
// applyOutcome (§5.1, §5.2, §5.5)

function requireDay(value, name) {
  if (!isYmd(value)) throw new OutcomeError("missing_arg", `${name} (YYYY-MM-DD) is required`);
  return value;
}

function optionalDay(value, name) {
  return value == null || value === "" ? null : requireDay(value, name);
}

function parseAmount(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new OutcomeError("missing_arg", "amount must be a whole-dollar number");
  return Math.round(n);
}

function parseTech(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseLostReason(value) {
  if (value == null || value === "") return null;
  if (!LOST_REASON_BY_ID[value]) throw new OutcomeError("missing_arg", `Unknown lost_reason: ${value}`);
  return value;
}

/** Weekday name within 6 days of now, else "Oct 14": stable wording for the timeline. */
function eventDay(ymd, now, tz) {
  return Math.abs(daysBetween(localDate(now, tz), ymd)) <= 6 ? weekdayName(ymd) : dayLabel(ymd, now, tz);
}

const withTech = (tech) => (tech ? ` with ${tech}` : "");
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** Each handler returns { patch, summary, toast(patch), args } for one outcome. */
const HANDLERS = {
  no_answer(job, args, { now, tz }) {
    const attempts = (job.attempts ?? 0) + 1;
    const today = localDate(now, tz);
    const patch = job.stage === "waiting_yes"
      ? { attempts, nudges: (job.nudges ?? 0) + 1, next_due_at: startOfDay(addBusinessDays(today, 2), tz) }
      : { attempts, next_due_at: job.urgent ? addMinutes(now, 60) : startOfDay(nextBusinessDay(today), tz) };
    return {
      patch, args: {},
      summary: `No answer (try ${attempts})`,
      toast: (p) => `No answer logged. Back on your list ${whenLabel(p.next_due_at, now, tz)}.`,
    };
  },

  need_quote(job, args, ctx) {
    return {
      patch: enterStage(job, "quote", ctx), args: {},
      summary: "Talked - needs a quote",
      toast: (p) => `Moved to Waiting on quote. Back on your list ${whenLabel(p.next_due_at, ctx.now, ctx.tz)}.`,
    };
  },

  quote_sent(job, args, ctx) {
    const amount = parseAmount(args.amount);
    const patch = enterStage(job, "waiting_yes", ctx, { amount });
    const shown = patch.quote_amount;
    return {
      patch, args: { amount },
      summary: shown != null ? `Quote sent - ${money(shown)}` : "Quote sent",
      toast: (p) => `Quote sent${shown != null ? ` (${money(shown)})` : ""}. I'll remind you ${whenLabel(p.next_due_at, ctx.now, ctx.tz)} if no answer.`,
    };
  },

  yes(job, args, ctx) {
    const visitDate = optionalDay(args.visit_date, "visit_date");
    if (!visitDate) {
      return {
        patch: enterStage(job, "to_schedule", ctx), args: { visit_date: null },
        summary: "Said yes - needs scheduling",
        toast: () => "Moved to Said yes - needs scheduling.",
      };
    }
    const tech = parseTech(args.tech);
    const { now, tz } = ctx;
    return {
      patch: enterStage(job, "scheduled", ctx, { visit_date: visitDate, tech }),
      args: { visit_date: visitDate, tech },
      summary: `Booked for ${eventDay(visitDate, now, tz)}${withTech(tech)}`,
      toast: (p) => `Booked for ${dayLabel(visitDate, now, tz)}${withTech(tech)}. I'll ask if it got done ${whenLabel(p.next_due_at, now, tz)}.`,
    };
  },

  still_thinking(job, args, { now, tz }) {
    const nudges = (job.nudges ?? 0) + 1;
    return {
      patch: { nudges, next_due_at: startOfDay(addBusinessDays(localDate(now, tz), 2), tz) }, args: {},
      summary: `Still thinking (nudge ${nudges})`,
      toast: (p) => `Got it. Back on your list ${whenLabel(p.next_due_at, now, tz)}.`,
    };
  },

  scheduled(job, args, ctx) {
    const visitDate = requireDay(args.visit_date, "visit_date");
    const tech = parseTech(args.tech);
    const { now, tz } = ctx;
    return {
      patch: enterStage(job, "scheduled", ctx, { visit_date: visitDate, tech }),
      args: { visit_date: visitDate, tech },
      summary: `Scheduled ${eventDay(visitDate, now, tz)}${withTech(tech)}`,
      toast: (p) => `Scheduled for ${dayLabel(visitDate, now, tz)}${withTech(tech)}. I'll ask if it got done ${whenLabel(p.next_due_at, now, tz)}.`,
    };
  },

  done(job, args, ctx) {
    const amount = parseAmount(args.amount);
    const patch = enterStage(job, "done", ctx, { amount });
    const shown = patch.quote_amount;
    return {
      patch, args: { amount },
      summary: shown != null ? `Done - ${money(shown)}` : "Done",
      toast: () => `Marked done${shown != null ? ` (${money(shown)})` : ""}.`,
    };
  },

  another_visit(job, args, ctx) {
    return {
      patch: enterStage(job, "to_schedule", ctx), args: {},
      summary: "Needs another visit",
      toast: () => "Moved to Said yes - needs scheduling.",
    };
  },

  snooze(job, args, { now, tz }) {
    const day = requireDay(args.snooze_until, "snooze_until");
    if (day <= localDate(now, tz)) throw new OutcomeError("missing_arg", "snooze_until must be a future date");
    const until = startOfDay(day, tz);
    return {
      patch: { snoozed_until: until, next_due_at: until, unread_inbound_at: null },
      args: { snooze_until: day },
      summary: `Snoozed until ${eventDay(day, now, tz)}`,
      toast: (p) => `Snoozed. Back on your list ${whenLabel(p.next_due_at, now, tz)}.`,
    };
  },

  lost(job, args, ctx) {
    const lostReason = parseLostReason(args.lost_reason);
    return {
      patch: enterStage(job, "lost", ctx, { lost_reason: lostReason }),
      args: { lost_reason: lostReason },
      summary: lostReason ? `Lost - ${lowerFirst(lostReasonLabel(lostReason))}` : "Lost",
      toast: () => "Moved to Lost.",
    };
  },

  not_a_job(job, args, ctx) {
    const block = args.block === true;
    return {
      patch: enterStage(job, "lost", ctx, { lost_reason: "not_a_job" }),
      args: block ? { block } : {},
      customerPatch: block ? { blocked: 1 } : null,
      summary: "Not a job",
      toast: () => "Removed - not a job.",
    };
  },

  seen(job, args, { now, tz }) {
    const due = job.next_due_at != null && Date.parse(job.next_due_at) <= Date.parse(now);
    return {
      patch: { unread_inbound_at: null }, args: {},
      summary: "Seen",
      toast: () => (due ? "Marked as seen." : `Marked as seen. Back on your list ${whenLabel(job.next_due_at, now, tz)}.`),
    };
  },
};

/**
 * Apply one outcome tap. Returns { patch, event: {kind:"outcome", summary, data}, toast }
 * (plus `customer_patch: {blocked: 1}` for "Not a job" with `block: true`).
 * Throws OutcomeError("invalid_outcome") when the outcome is not offered for this job,
 * and OutcomeError("missing_arg") when a required picker value is missing or invalid.
 */
export function applyOutcome(jobView, outcomeId, args, ctx) {
  if (!OUTCOME_BY_ID[outcomeId] || !offeredIds(jobView).has(outcomeId)) {
    throw new OutcomeError("invalid_outcome", `"${outcomeId}" is not offered for stage ${jobView.stage}`);
  }
  const { now } = ctx;
  const result = HANDLERS[outcomeId](jobView, args ?? {}, ctx);
  const patch = { ...result.patch };
  if (OUTCOME_BY_ID[outcomeId].contact) {
    patch.last_touch_at = now;
    patch.first_touch_at = jobView.first_touch_at ?? now;
  }
  if (outcomeId !== "snooze" && outcomeId !== "seen") {
    patch.unread_inbound_at = null;
    patch.snoozed_until = null;
  }
  patch.updated_at = now;
  const out = {
    patch,
    event: {
      kind: "outcome",
      summary: result.summary,
      data: { outcome: outcomeId, from: jobView.stage, to: patch.stage ?? jobView.stage, args: result.args },
    },
    toast: result.toast(patch),
  };
  if (result.customerPatch) out.customer_patch = result.customerPatch;
  return out;
}

/**
 * Job detail stage picker (§5.7): any move except "no move", through enterStage. Not contact.
 * Returns { patch, event: {kind:"stage", summary, data}, toast }.
 */
export function moveStage(jobView, to, args, ctx) {
  if (!STAGE_BY_ID[to] || !canTransition(jobView.stage, to)) {
    throw new OutcomeError("invalid_outcome", `Can't move from ${jobView.stage} to ${to}`);
  }
  const a = args ?? {};
  const stageArgs = {
    visit_date: optionalDay(a.visit_date, "visit_date"),
    tech: parseTech(a.tech),
    amount: parseAmount(a.amount),
    lost_reason: parseLostReason(a.lost_reason),
  };
  const patch = enterStage(jobView, to, ctx, stageArgs);
  const reopened = !isOpen(jobView.stage) && isOpen(to);
  const label = stageLabel(to);
  return {
    patch,
    event: {
      kind: "stage",
      summary: reopened ? "Brought back" : `Moved to ${label}`,
      data: { from: jobView.stage, to, args: stageArgs },
    },
    toast: `Moved to ${label}.`,
  };
}
