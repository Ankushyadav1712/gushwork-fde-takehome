import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGES, OPEN_STAGES, DENISE_OWES, LOST_REASONS, EQUIPMENT, OUTCOMES, OutcomeError,
  isOpen, canTransition, enterStage, outcomesFor, applyOutcome, promotionFor, moveStage, askedForDay,
  stageLabel, equipmentLabel,
} from "../shared/stages.js";
import { SEED_ANCHOR as A, at, ctxAt, makeJobView } from "./fixtures/seed-state.js";

const ctx = ctxAt(A); // Mon Oct 5 2026 07:00 America/Chicago
const MON_0000 = "2026-10-05T05:00:00.000Z";
const TUE_0000 = "2026-10-06T05:00:00.000Z";
const WED_0000 = "2026-10-07T05:00:00.000Z";

const isIso = (s) => typeof s === "string" && new Date(s).toISOString() === s;
/** The outcome ids the sheet offers for this job (every one of them must be accepted by applyOutcome). */
const offeredIds = (job) => outcomesFor(job, ctx).map((b) => b.id);
const outcomeError = (code) => (err) => err instanceof OutcomeError && err instanceof Error && err.code === code;

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(obj);
}

/** A job in `stage` as the rules would leave it (unread reply set so "Seen it" is offered). */
function jobIn(stage, extra = {}) {
  const base = {
    new: {},
    quote: { stage_entered_at: at("2026-10-01 11:00"), next_due_at: "2026-10-02T05:00:00.000Z" },
    waiting_yes: { quote_sent_at: at("2026-10-01 14:10"), quote_amount: 2400, next_due_at: MON_0000 },
    to_schedule: { won_at: at("2026-10-02 13:30"), next_due_at: at("2026-10-02 13:30") },
    scheduled: { visit_date: "2026-10-02", tech: "Luis", won_at: at("2026-09-30 15:00"), next_due_at: MON_0000 },
    done: { done_at: at("2026-10-02 15:30"), closed_at: at("2026-10-02 15:30"), won_at: at("2026-09-29 09:00"), next_due_at: null },
    lost: { lost_at: at("2026-10-01 17:00"), closed_at: at("2026-10-01 17:00"), lost_reason: "went_elsewhere", next_due_at: null },
  }[stage];
  return makeJobView({ id: 7, created_at: at("2026-09-29 10:05"), stage, ...base, ...extra });
}

const SAMPLE_ARGS = {
  no_answer: {},
  need_quote: {},
  quote_sent: { amount: 1200 },
  yes: { visit_date: "2026-10-06", tech: "Luis" },
  still_thinking: {},
  scheduled: { visit_date: "2026-10-07", tech: "Mike" },
  done: { amount: 600 },
  another_visit: {},
  snooze: { snooze_until: "2026-10-07" },
  lost: { lost_reason: "price" },
  not_a_job: { block: true },
  seen: {},
};

test("stage constants (§3)", () => {
  assert.deepEqual(STAGES.map((s) => [s.id, s.label, s.short, s.open]), [
    ["new", "New - call them back", "New", true],
    ["quote", "Waiting on quote", "Waiting on quote", true],
    ["waiting_yes", "Waiting on their yes", "Their yes", true],
    ["to_schedule", "Said yes - needs scheduling", "Said yes", true],
    ["scheduled", "Scheduled", "Scheduled", true],
    ["done", "Done", "Done", false],
    ["lost", "Lost", "Lost", false],
  ]);
  assert.deepEqual(OPEN_STAGES, ["new", "quote", "waiting_yes", "to_schedule", "scheduled"]);
  assert.deepEqual(DENISE_OWES, ["new", "quote", "to_schedule"]);
  assert.deepEqual(LOST_REASONS.map((r) => [r.id, r.label]), [
    ["went_elsewhere", "Went with someone else"],
    ["price", "Too pricey"],
    ["fixed_themselves", "Fixed it themselves"],
    ["no_response", "Never answered"],
    ["not_a_job", "Not a real job"],
  ]);
  assert.deepEqual(EQUIPMENT.map((e) => [e.id, e.label]), [
    ["walk_in_cooler", "Walk-in cooler"],
    ["walk_in_freezer", "Walk-in freezer"],
    ["ice_machine", "Ice machine"],
    ["reach_in", "Reach-in"],
    ["display_case", "Display case"],
    ["prep_table", "Prep table"],
    ["other", "Other"],
  ]);
  assert.deepEqual(OUTCOMES.map((o) => o.id), [
    "no_answer", "need_quote", "quote_sent", "yes", "still_thinking", "scheduled",
    "done", "another_visit", "snooze", "lost", "not_a_job", "seen",
  ]);
  assert.equal(stageLabel("to_schedule"), "Said yes - needs scheduling");
  assert.equal(equipmentLabel("reach_in"), "Reach-in");
  assert.equal(equipmentLabel(null), null);
});

test("isOpen and canTransition", () => {
  for (const s of OPEN_STAGES) assert.equal(isOpen(s), true);
  assert.equal(isOpen("done"), false);
  assert.equal(isOpen("lost"), false);
  assert.equal(isOpen("bogus"), false);
  assert.equal(canTransition("waiting_yes", "quote"), true);
  assert.equal(canTransition("lost", "new"), true);
  assert.equal(canTransition("quote", "quote"), false);
});

test("enterStage: what every stage entry does", () => {
  const job = jobIn("quote", { attempts: 2, snoozed_until: TUE_0000, unread_inbound_at: at("2026-10-05 06:00") });
  for (const to of ["new", "quote", "waiting_yes", "to_schedule", "done", "lost"]) {
    const patch = enterStage(job, to, ctx, {});
    assert.equal(patch.stage, to);
    assert.equal(patch.stage_entered_at, A);
    assert.equal(patch.attempts, 0);
    assert.equal(patch.snoozed_until, null);
    assert.equal(patch.unread_inbound_at, null);
    assert.equal(patch.updated_at, A);
  }
  assert.throws(() => enterStage(job, "bogus", ctx), outcomeError("invalid_outcome"));
});

test("enterStage: per-stage dates and fields (§3)", () => {
  const job = jobIn("new");
  assert.equal(enterStage(job, "new", ctx).next_due_at, A);

  // quote: start of next business day; urgent now + 2h; import now.
  const friCtx = ctxAt(at("2026-10-02 09:40"));
  assert.equal(enterStage(job, "quote", friCtx).next_due_at, MON_0000);
  assert.equal(enterStage({ ...job, urgent: 1 }, "quote", ctx).next_due_at, "2026-10-05T14:00:00.000Z");
  assert.equal(enterStage(job, "quote", ctx, { import: true }).next_due_at, A);

  // waiting_yes: 2 business days after the quote day, from local midnight.
  const thu = ctxAt(at("2026-10-01 14:10"));
  assert.deepEqual(
    pick(enterStage({ ...job, quote_amount: 900, nudges: 2 }, "waiting_yes", thu, { amount: 2400 }),
      ["quote_sent_at", "quote_amount", "nudges", "next_due_at"]),
    { quote_sent_at: at("2026-10-01 14:10"), quote_amount: 2400, nudges: 0, next_due_at: MON_0000 },
  );
  assert.equal(enterStage({ ...job, quote_amount: 900 }, "waiting_yes", thu).quote_amount, 900);
  const imported = enterStage(job, "waiting_yes", ctx, { quote_sent_at: at("2026-09-29 12:00") });
  assert.equal(imported.quote_sent_at, at("2026-09-29 12:00"));
  assert.equal(imported.next_due_at, "2026-10-01T05:00:00.000Z"); // Tue + 2 = Thu, already due

  // to_schedule: won_at kept when set, visit_date cleared, due now.
  const toSchedule = enterStage({ ...job, won_at: at("2026-10-01 10:30"), visit_date: "2026-10-02" }, "to_schedule", ctx);
  assert.deepEqual(pick(toSchedule, ["won_at", "visit_date", "next_due_at"]),
    { won_at: at("2026-10-01 10:30"), visit_date: null, next_due_at: A });
  assert.equal(enterStage(job, "to_schedule", ctx).won_at, A);

  // scheduled: needs a visit_date; due the next business day after the visit.
  assert.deepEqual(pick(enterStage(job, "scheduled", ctx, { visit_date: "2026-10-09", tech: "Dee" }),
    ["visit_date", "tech", "won_at", "next_due_at"]),
  { visit_date: "2026-10-09", tech: "Dee", won_at: A, next_due_at: "2026-10-12T05:00:00.000Z" });
  assert.equal(enterStage(job, "scheduled", ctx, { visit_date: "2026-10-09" }).tech, null);
  assert.throws(() => enterStage(job, "scheduled", ctx, {}), outcomeError("missing_arg"));

  // done / lost close the job.
  assert.deepEqual(pick(enterStage({ ...job, quote_amount: 540 }, "done", ctx), ["done_at", "closed_at", "won_at", "quote_amount", "next_due_at"]),
    { done_at: A, closed_at: A, won_at: A, quote_amount: 540, next_due_at: null });
  assert.equal(enterStage({ ...job, quote_amount: 540 }, "done", ctx, { amount: 600 }).quote_amount, 600);
  assert.deepEqual(pick(enterStage(job, "lost", ctx, { lost_reason: "price" }), ["lost_at", "closed_at", "lost_reason", "next_due_at"]),
    { lost_at: A, closed_at: A, lost_reason: "price", next_due_at: null });
  assert.equal(enterStage(job, "lost", ctx).lost_reason, null);
});

test("regression RT-3: moving between done and lost drops the other closed stage's fields", () => {
  const notAJob = jobIn("lost", { lost_reason: "not_a_job" });
  assert.deepEqual(pick(enterStage(notAJob, "done", ctx, { amount: 350 }), ["stage", "lost_at", "lost_reason", "done_at", "quote_amount"]),
    { stage: "done", lost_at: null, lost_reason: null, done_at: A, quote_amount: 350 });
  assert.deepEqual(pick(enterStage(jobIn("done"), "lost", ctx, { lost_reason: "price" }), ["stage", "done_at", "lost_at", "lost_reason"]),
    { stage: "lost", done_at: null, lost_at: A, lost_reason: "price" });
  // A visit date only belongs to a job that is (or was) booked: leaving for an earlier stage drops it.
  for (const to of ["new", "quote", "waiting_yes", "to_schedule"]) {
    assert.equal(enterStage(jobIn("scheduled"), to, ctx).visit_date, null, to);
  }
});

test("enterStage: reopening clears the closed fields and keeps won_at", () => {
  const lost = jobIn("lost", { won_at: at("2026-09-30 10:00") });
  const patch = enterStage(lost, "new", ctx);
  assert.deepEqual(pick(patch, ["closed_at", "done_at", "lost_at", "lost_reason", "next_due_at"]),
    { closed_at: null, done_at: null, lost_at: null, lost_reason: null, next_due_at: A });
  assert.equal("won_at" in patch, false);
  assert.equal("closed_at" in enterStage(jobIn("quote"), "new", ctx), false);
});

test("T02 invariant: every offered outcome keeps open <=> next_due_at", () => {
  let checked = 0;
  for (const stage of OPEN_STAGES) {
    const job = deepFreeze(jobIn(stage, { unread_inbound_at: at("2026-10-05 06:00") }));
    const offered = offeredIds(job);
    const tries = offered.map((id) => [id, SAMPLE_ARGS[id]]);
    if (offered.includes("yes")) tries.push(["yes", { visit_date: null }]);
    for (const [id, args] of tries) {
      const { patch, event, toast } = applyOutcome(job, id, args, ctx);
      const after = { ...job, ...patch };
      if (isOpen(after.stage)) assert.ok(isIso(after.next_due_at), `${stage} ${id}: ${after.next_due_at}`);
      else assert.equal(after.next_due_at, null, `${stage} ${id}`);
      assert.equal(patch.updated_at, A);
      assert.equal(event.kind, "outcome");
      assert.equal(event.data.outcome, id);
      assert.equal(event.data.from, stage);
      assert.equal(event.data.to, after.stage);
      assert.equal(typeof toast, "string");
      checked++;
    }
    for (const o of OUTCOMES.filter((x) => !offered.includes(x.id))) {
      assert.throws(() => applyOutcome(job, o.id, SAMPLE_ARGS[o.id], ctx), outcomeError("invalid_outcome"), `${stage} ${o.id}`);
    }
  }
  // Offered per stage, "Seen it" included: new 8, quote 5, waiting_yes 6, to_schedule 5, scheduled 7;
  // plus a "No date yet" tap wherever "yes" is offered.
  assert.equal(checked, 8 + 5 + 6 + 5 + 7 + 3);
  for (const stage of ["done", "lost"]) {
    for (const o of OUTCOMES) {
      assert.throws(() => applyOutcome(jobIn(stage), o.id, SAMPLE_ARGS[o.id], ctx), outcomeError("invalid_outcome"));
    }
  }
  assert.throws(() => applyOutcome(jobIn("new"), "bogus", {}, ctx), outcomeError("invalid_outcome"));
  assert.throws(() => applyOutcome(jobIn("quote"), "seen", {}, ctx), outcomeError("invalid_outcome")); // no unread reply
});

test("applyOutcome never mutates its input", () => {
  const job = deepFreeze(jobIn("waiting_yes", { unread_inbound_at: at("2026-10-05 06:00") }));
  const before = JSON.stringify(job);
  for (const id of offeredIds(job)) applyOutcome(job, id, SAMPLE_ARGS[id], ctx);
  assert.equal(JSON.stringify(job), before);
});

test("missing or invalid picker values throw missing_arg", () => {
  const missing = outcomeError("missing_arg");
  assert.throws(() => applyOutcome(jobIn("to_schedule"), "scheduled", {}, ctx), missing);
  assert.throws(() => applyOutcome(jobIn("to_schedule"), "scheduled", { visit_date: "Thursday" }, ctx), missing);
  assert.throws(() => applyOutcome(jobIn("quote"), "yes", { visit_date: "10/8" }, ctx), missing);
  assert.throws(() => applyOutcome(jobIn("quote"), "snooze", {}, ctx), missing);
  assert.throws(() => applyOutcome(jobIn("quote"), "snooze", { snooze_until: "2026-10-05" }, ctx), missing); // not in the future
  assert.throws(() => applyOutcome(jobIn("quote"), "lost", { lost_reason: "bored" }, ctx), missing);
  assert.throws(() => applyOutcome(jobIn("quote"), "quote_sent", { amount: "lots" }, ctx), missing);
  assert.throws(() => applyOutcome(jobIn("quote"), "quote_sent", { amount: -5 }, ctx), missing);
  assert.equal(applyOutcome(jobIn("quote"), "quote_sent", { amount: "$2,400" }, ctx).patch.quote_amount, 2400);
  assert.equal(applyOutcome(jobIn("quote"), "yes", {}, ctx).patch.stage, "to_schedule"); // "No date yet"
});

test("contact outcomes set last_touch_at / first_touch_at; the rest leave them alone (§5.1)", () => {
  const earlier = at("2026-10-01 11:00");
  for (const stage of OPEN_STAGES) {
    const fresh = jobIn(stage, { unread_inbound_at: at("2026-10-05 06:00") });
    const touched = { ...fresh, first_touch_at: earlier, last_touch_at: earlier };
    for (const id of offeredIds(fresh)) {
      const contact = OUTCOMES.find((o) => o.id === id).contact;
      const p1 = applyOutcome(fresh, id, SAMPLE_ARGS[id], ctx).patch;
      const p2 = applyOutcome(touched, id, SAMPLE_ARGS[id], ctx).patch;
      if (contact) {
        assert.deepEqual([p1.first_touch_at, p1.last_touch_at], [A, A], `${stage} ${id}`);
        assert.deepEqual([p2.first_touch_at, p2.last_touch_at], [earlier, A], `${stage} ${id}`);
      } else {
        assert.equal("last_touch_at" in p1 || "first_touch_at" in p1, false, `${stage} ${id}`);
      }
    }
  }
  assert.deepEqual(OUTCOMES.filter((o) => !o.contact).map((o) => o.id), ["snooze", "lost", "not_a_job", "seen"]);
});

test("every outcome except snooze and seen clears unread_inbound_at and snoozed_until", () => {
  const job = jobIn("waiting_yes", { unread_inbound_at: at("2026-10-05 06:00"), snoozed_until: WED_0000 });
  for (const id of offeredIds(job)) {
    const { patch } = applyOutcome(job, id, SAMPLE_ARGS[id], ctx);
    const after = { ...job, ...patch };
    if (id === "seen") {
      assert.equal(after.unread_inbound_at, null);
      assert.equal(after.snoozed_until, WED_0000);
    } else if (id === "snooze") {
      assert.equal(after.unread_inbound_at, null);
      assert.equal(after.snoozed_until, WED_0000);
    } else {
      assert.equal(after.unread_inbound_at, null, id);
      assert.equal(after.snoozed_until, null, id);
    }
  }
});

test("outcome buttons per stage, in order (§5.3)", () => {
  const view = (b) => `${b.primary ? "" : "~"}${b.label}`;
  const labels = (jv, opts = ctx) => outcomesFor(jv, opts).map(view);
  assert.deepEqual(labels(jobIn("new")),
    ["No answer", "Talked - needs a quote", "Booked it", "Quoted on the call", "Not a job", "~Not today", "~Lost"]);
  assert.deepEqual(labels(jobIn("quote")), ["Quote sent", "They said yes", "~Not today", "~Lost"]);
  assert.deepEqual(labels(jobIn("waiting_yes")), ["They said yes", "Still thinking", "No answer", "~Not today", "~Lost"]);
  assert.deepEqual(labels(jobIn("to_schedule")), ["Scheduled", "No answer", "~Not today", "~Lost"]);
  assert.deepEqual(labels(jobIn("scheduled", { visit_date: "2026-10-02" })),
    ["Done", "Needs another visit", "Needs a quote for more work", "Moved to another day", "~Not today", "~Cancelled"]);
  assert.deepEqual(labels(jobIn("scheduled", { visit_date: "2026-10-05" })),
    ["Moved to another day", "Done", "Needs another visit", "Needs a quote for more work", "~Not today", "~Cancelled"]);
  assert.deepEqual(labels(jobIn("scheduled", { visit_date: "2026-10-05" }), {}),
    ["Done", "Needs another visit", "Needs a quote for more work", "Moved to another day", "~Not today", "~Cancelled"]);
  assert.deepEqual(labels(jobIn("quote", { unread_inbound_at: A })), ["Quote sent", "They said yes", "~Seen it", "~Not today", "~Lost"]);
  assert.deepEqual(outcomesFor(jobIn("done"), ctx), []);

  const needs = Object.fromEntries(outcomesFor(jobIn("new"), ctx).map((b) => [b.id, b.needs]));
  assert.deepEqual(needs, {
    no_answer: null, need_quote: null, yes: "day_or_none", quote_sent: "amount", not_a_job: null,
    snooze: "snooze_day", lost: "lost_reason",
  });
  const sched = outcomesFor(jobIn("scheduled", { quote_amount: 540 }), ctx);
  assert.deepEqual(sched.find((b) => b.id === "scheduled").needs, "day");
  assert.deepEqual(sched.find((b) => b.id === "done"),
    { id: "done", label: "Done", primary: true, suggested: false, needs: "amount", preset: { amount: 540 } });
});

test("promotions: one at a time, shown first (§5.3, §4.12)", () => {
  const reply = { unread_inbound_at: A, last_inbound: { at: A, channel: "sms", call_status: null, body: "yes go ahead, thursday works for us" } };
  const yes = outcomesFor(jobIn("waiting_yes", { ...reply, nudges: 3 }), { ...ctx, suggestion: "mark_yes" });
  assert.deepEqual(yes[0], { id: "yes", label: "Mark as yes?", primary: true, suggested: true, needs: "day_or_none" });
  assert.deepEqual(yes.map((b) => b.label), ["Mark as yes?", "Still thinking", "No answer", "Seen it", "Not today", "Lost"]);

  const elsewhere = { ...reply, last_inbound: { ...reply.last_inbound, body: "no thanks, we went with someone else" } };
  const lost = outcomesFor(jobIn("waiting_yes", elsewhere), { ...ctx, suggestion: "mark_lost" });
  assert.deepEqual(lost[0], { id: "lost", label: "Mark lost?", primary: true, suggested: true, needs: "lost_reason", preset: { lost_reason: "went_elsewhere" } });
  assert.equal(lost.filter((b) => b.id === "lost").length, 1);
  const tooPricey = { ...reply, last_inbound: { ...reply.last_inbound, body: "too expensive for us right now" } };
  assert.deepEqual(outcomesFor(jobIn("quote", tooPricey), { ...ctx, suggestion: "mark_lost" })[0],
    { id: "lost", label: "Mark lost?", primary: true, suggested: true, needs: "lost_reason" });

  const spam = outcomesFor(jobIn("new", { ai_not_service: 1, attempts: 3 }), ctx);
  assert.deepEqual(spam[0], { id: "not_a_job", label: "Not a job?", primary: true, suggested: true, needs: null });
  assert.deepEqual(spam.map((b) => b.label),
    ["Not a job?", "No answer", "Talked - needs a quote", "Booked it", "Quoted on the call", "Not today", "Lost"]);

  const tries = outcomesFor(jobIn("new", { attempts: 3 }), ctx);
  assert.deepEqual(tries[0], { id: "lost", label: "Mark lost", primary: true, suggested: true, needs: "lost_reason", preset: { lost_reason: "no_response" } });
  assert.equal(tries.at(-1).id, "snooze");
  assert.equal(outcomesFor(jobIn("new", { attempts: 2 }), ctx)[0].id, "no_answer");

  assert.equal(promotionFor(jobIn("waiting_yes", { nudges: 3 })), "mark_lost_tries");
  assert.equal(promotionFor(jobIn("waiting_yes", { nudges: 3 }), "mark_yes"), "mark_yes");
  assert.equal(promotionFor(jobIn("to_schedule"), "mark_yes"), null); // "yes" isn't offered there
  assert.equal(promotionFor(jobIn("quote", { ai_not_service: 1 })), null); // AI flag only on new
});

test("toasts and event summaries are exact (§5.5)", () => {
  const run = (jv, id, args, now = A) => {
    const r = applyOutcome(jv, id, args, ctxAt(now));
    return [r.toast, r.event.summary];
  };
  assert.deepEqual(run(jobIn("new"), "no_answer", {}),
    ["No answer logged. Back on your list tomorrow.", "No answer (try 1)"]);
  assert.deepEqual(run(jobIn("new", { urgent: 1, attempts: 1 }), "no_answer", {}),
    ["No answer logged. Back on your list at 8:00am.", "No answer (try 2)"]);
  assert.deepEqual(run(jobIn("new"), "need_quote", {}),
    ["Moved to Waiting on quote. Back on your list tomorrow.", "Talked - needs a quote"]);
  assert.deepEqual(run(jobIn("quote"), "quote_sent", { amount: 2400 }, at("2026-10-01 14:10")),
    ["Quote sent ($2,400). I'll remind you Mon if no answer.", "Quote sent - $2,400"]);
  assert.deepEqual(run(jobIn("quote"), "quote_sent", {}),
    ["Quote sent. I'll remind you Wed if no answer.", "Quote sent"]);
  assert.deepEqual(run(jobIn("new"), "yes", { visit_date: "2026-10-05", tech: "Luis" }),
    ["Booked for today with Luis. I'll ask if it got done tomorrow.", "Booked for Mon with Luis"]);
  assert.deepEqual(run(jobIn("waiting_yes"), "yes", { visit_date: "2026-10-08" }),
    ["Booked for Thu. I'll ask if it got done Fri.", "Booked for Thu"]);
  assert.deepEqual(run(jobIn("waiting_yes"), "yes", { visit_date: null }),
    ["Moved to Said yes - needs scheduling.", "Said yes - needs scheduling"]);
  assert.deepEqual(run(jobIn("waiting_yes"), "still_thinking", {}, at("2026-10-07 09:00")),
    ["Got it. Back on your list Fri.", "Still thinking (nudge 1)"]);
  assert.deepEqual(run(jobIn("to_schedule"), "scheduled", { visit_date: "2026-10-06", tech: "Mike" }),
    ["Scheduled for tomorrow with Mike. I'll ask if it got done Wed.", "Scheduled Tue with Mike"]);
  assert.deepEqual(run(jobIn("scheduled"), "done", { amount: 600 }), ["Marked done ($600).", "Done - $600"]);
  assert.deepEqual(run(jobIn("scheduled", { quote_amount: 540 }), "done", {}), ["Marked done ($540).", "Done - $540"]);
  assert.deepEqual(run(jobIn("scheduled"), "done", {}), ["Marked done.", "Done"]);
  assert.deepEqual(run(jobIn("scheduled"), "another_visit", {}), ["Moved to Said yes - needs scheduling.", "Needs another visit"]);
  assert.deepEqual(run(jobIn("quote"), "snooze", { snooze_until: "2026-10-07" }), ["OK, it'll be back on your list Wed.", "Put off until Wed"]);
  assert.deepEqual(run(jobIn("quote"), "lost", { lost_reason: "went_elsewhere" }), ["Moved to Lost.", "Lost - went with someone else"]);
  assert.deepEqual(run(jobIn("quote"), "lost", {}), ["Moved to Lost.", "Lost"]);
  assert.deepEqual(run(jobIn("new"), "not_a_job", {}), ["Removed - not a job.", "Not a job"]);
  assert.deepEqual(run(jobIn("quote", { next_due_at: WED_0000, unread_inbound_at: A }), "seen", {}),
    ["Marked as seen. Back on your list Wed.", "Seen"]);
  assert.deepEqual(run(jobIn("quote", { unread_inbound_at: A }), "seen", {}), ["Marked as seen.", "Seen"]);
  assert.deepEqual(run(jobIn("new"), "need_quote", {}, at("2026-10-09 08:00")), // Friday
    ["Moved to Waiting on quote. Back on your list Mon.", "Talked - needs a quote"]);
  // A visit more than 6 days out is named by date in the timeline.
  assert.deepEqual(run(jobIn("to_schedule"), "scheduled", { visit_date: "2026-10-14" }),
    ["Scheduled for Oct 14. I'll ask if it got done Oct 15.", "Scheduled Oct 14"]);
});

test("outcome effects (§5.2)", () => {
  const apply = (jv, id, args, now = A) => ({ ...jv, ...applyOutcome(jv, id, args, ctxAt(now)).patch });

  // T09: urgent jobs come back fast.
  assert.equal(apply(jobIn("new", { urgent: 1 }), "no_answer", {}).next_due_at, "2026-10-05T13:00:00.000Z");
  assert.equal(apply(jobIn("to_schedule", { urgent: 1 }), "no_answer", {}).next_due_at, "2026-10-05T13:00:00.000Z");
  assert.equal(apply(jobIn("new", { urgent: 1 }), "need_quote", {}).next_due_at, "2026-10-05T14:00:00.000Z");

  // No answer on waiting_yes is a nudge: +2 business days from today.
  const nudged = apply(jobIn("waiting_yes", { nudges: 1 }), "no_answer", {}, at("2026-10-08 10:00"));
  assert.deepEqual(pick(nudged, ["attempts", "nudges", "next_due_at"]), { attempts: 1, nudges: 2, next_due_at: "2026-10-12T05:00:00.000Z" });

  // Still thinking: nudges + 1, +2 business days, stage unchanged.
  const thinking = apply(jobIn("waiting_yes"), "still_thinking", {}, at("2026-10-09 09:00"));
  assert.deepEqual(pick(thinking, ["stage", "nudges", "next_due_at"]), { stage: "waiting_yes", nudges: 1, next_due_at: "2026-10-13T05:00:00.000Z" });

  // Booked it with a date: scheduled, won.
  const booked = apply(jobIn("new"), "yes", { visit_date: "2026-10-05", tech: "Luis" });
  assert.deepEqual(pick(booked, ["stage", "visit_date", "tech", "won_at", "next_due_at"]),
    { stage: "scheduled", visit_date: "2026-10-05", tech: "Luis", won_at: A, next_due_at: TUE_0000 });

  // Needs another visit keeps the tech and clears the date.
  const again = apply(jobIn("scheduled"), "another_visit", {});
  assert.deepEqual(pick(again, ["stage", "visit_date", "tech", "next_due_at"]), { stage: "to_schedule", visit_date: null, tech: "Luis", next_due_at: A });

  // Snooze: next date = snooze date, last touch unchanged, attempts kept.
  const snoozed = apply(jobIn("new", { attempts: 2, last_touch_at: at("2026-10-02 10:00") }), "snooze", { snooze_until: "2026-10-07" });
  assert.deepEqual(pick(snoozed, ["snoozed_until", "next_due_at", "last_touch_at", "attempts"]),
    { snoozed_until: WED_0000, next_due_at: WED_0000, last_touch_at: at("2026-10-02 10:00"), attempts: 2 });

  // Not a job closes the job; block asks for the customer to be blocked.
  const spam = applyOutcome(jobIn("new"), "not_a_job", { block: true }, ctx);
  assert.equal(spam.patch.lost_reason, "not_a_job");
  assert.equal(spam.patch.next_due_at, null);
  assert.deepEqual(spam.customer_patch, { blocked: 1 });
  assert.deepEqual(spam.event.data, { outcome: "not_a_job", from: "new", to: "lost", args: { block: true } });
  assert.equal("customer_patch" in applyOutcome(jobIn("new"), "not_a_job", {}, ctx), false);

  // Seen only clears the unread flag.
  const seen = applyOutcome(jobIn("quote", { unread_inbound_at: A }), "seen", {}, ctx).patch;
  assert.deepEqual(seen, { unread_inbound_at: null, updated_at: A });

  const event = applyOutcome(jobIn("to_schedule"), "scheduled", { visit_date: "2026-10-06", tech: " Mike " }, ctx).event;
  assert.deepEqual(event, {
    kind: "outcome", summary: "Scheduled Tue with Mike",
    data: { outcome: "scheduled", from: "to_schedule", to: "scheduled", args: { visit_date: "2026-10-06", tech: "Mike" } },
  });
});

test("regression RT-2: 'Needs a quote for more work' closes the visit and opens a new quote job", () => {
  const visit = jobIn("scheduled", { id: 10, customer_id: 9, quote_amount: 600, problem: "Prep table cooler fan grinding", equipment: "prep_table" });
  const result = applyOutcome(visit, "need_quote", {}, ctx);
  assert.deepEqual(pick({ ...visit, ...result.patch }, ["stage", "quote_amount", "won_at", "done_at", "next_due_at"]),
    { stage: "done", quote_amount: 600, won_at: visit.won_at, done_at: A, next_due_at: null });
  assert.equal(result.toast, "Marked done. The extra work is a new job waiting on your quote.");
  assert.equal(result.event.summary, "Done - needs a quote for more work");
  assert.deepEqual([result.event.data.from, result.event.data.to], ["scheduled", "done"]);
  assert.deepEqual(result.spawn.event, { kind: "created", summary: "Extra work found at the Fri visit" });
  const extra = result.spawn.job;
  assert.deepEqual(pick(extra, ["customer_id", "stage", "source", "problem", "equipment", "created_at", "stage_entered_at", "next_due_at"]), {
    customer_id: 9, stage: "quote", source: "manual", problem: "More work: Prep table cooler fan grinding",
    equipment: "prep_table", created_at: A, stage_entered_at: A, next_due_at: TUE_0000,
  });
  assert.equal("won_at" in extra || "quote_amount" in extra, false, "the new quote isn't won and has no price yet");
  assert.equal(applyOutcome(visit, "need_quote", {}, ctxAt(at("2026-10-14 09:00"))).spawn.event.summary,
    "Extra work found at the Oct 2 visit");
  assert.equal(applyOutcome(jobIn("scheduled", { problem: "x".repeat(70) }), "need_quote", {}, ctx).spawn.job.problem.length <= 60, true);
  assert.equal("spawn" in applyOutcome(jobIn("new"), "need_quote", {}, ctx), false, "on a new lead it's still a talk");
});

test("askedForDay: the weekday a reply asks for, as the next such date after today", () => {
  assert.equal(askedForDay("Can Mike come Wednesday instead of Tuesday? We're closed Tuesdays.", A, ctx.tz), "2026-10-07");
  assert.equal(askedForDay("Not Tuesday - thursday works", A, ctx.tz), "2026-10-08");
  assert.equal(askedForDay("monday is better for us", A, ctx.tz), "2026-10-12", "never today: next week's Monday");
  assert.equal(askedForDay("We're closed Tuesdays", A, ctx.tz), null);
  assert.equal(askedForDay("Thanks, see you then", A, ctx.tz), null);
  assert.equal(askedForDay(null, A, ctx.tz), null);
});

test("UX-9: a reply asking for another day promotes 'Move to {Weekday}?' with that day preset", () => {
  const reply = { unread_inbound_at: A, last_inbound: { at: A, channel: "sms", call_status: null, body: "Can Mike come Wednesday instead of Tuesday?" } };
  const harbor = jobIn("scheduled", { visit_date: "2026-10-06", ...reply });
  const buttons = outcomesFor(harbor, { ...ctx, suggestion: "move_day" });
  assert.deepEqual(buttons[0], {
    id: "scheduled", label: "Move to Wednesday?", primary: true, suggested: true, needs: "day", preset: { visit_date: "2026-10-07" },
  });
  assert.equal(buttons.filter((b) => b.id === "scheduled").length, 1);
  assert.equal(promotionFor(harbor, "move_day"), "move_day");
  assert.equal(promotionFor(jobIn("quote", reply), "move_day"), null, "only where 'Moved to another day' is offered");
});

test("moveStage: the Job detail stage picker (§5.7)", () => {
  const back = moveStage(jobIn("lost"), "new", {}, ctx);
  assert.equal(back.patch.stage, "new");
  assert.equal(back.patch.next_due_at, A);
  assert.equal(back.patch.lost_reason, null);
  assert.equal(back.event.kind, "stage");
  assert.equal(back.event.summary, "Brought back");
  assert.equal(back.toast, "Moved to New - call them back.");
  assert.equal("last_touch_at" in back.patch, false); // not contact

  const revised = moveStage(jobIn("waiting_yes"), "quote", {}, ctx);
  assert.equal(revised.event.summary, "Moved to Waiting on quote");
  assert.equal(revised.patch.next_due_at, TUE_0000);

  assert.throws(() => moveStage(jobIn("quote"), "quote", {}, ctx), outcomeError("invalid_outcome"));
  assert.throws(() => moveStage(jobIn("quote"), "scheduled", {}, ctx), outcomeError("missing_arg"));
  assert.equal(moveStage(jobIn("quote"), "waiting_yes", { amount: "900" }, ctx).patch.quote_amount, 900);
});

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}
