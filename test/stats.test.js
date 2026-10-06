import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNumbers, numbersText } from "../shared/stats.js";
import { SEED_ANCHOR as A, SETTINGS, ctxAt, makeJobView, seedJobViews } from "./fixtures/seed-state.js";

const ctx = ctxAt(A); // Mon Oct 5 2026 07:00
const DAY_MS = 86_400_000;
const daysBefore = (days, extraMs = 0) => new Date(Date.parse(A) - days * DAY_MS + extraMs).toISOString();

test("R14 Numbers at the seed anchor equal §10 / §12.5", () => {
  assert.deepEqual(computeNumbers(seedJobViews(), ctx), {
    now: A,
    date_label: "Mon Oct 5",
    open_count: 13,
    stage_counts: { new: 3, quote: 3, waiting_yes: 2, to_schedule: 2, scheduled: 3 },
    stages: [
      { stage: "new", label: "New", count: 3 },
      { stage: "quote", label: "Waiting on quote", count: 3 },
      { stage: "waiting_yes", label: "Their yes", count: 2 },
      { stage: "to_schedule", label: "Said yes", count: 2 },
      { stage: "scheduled", label: "Scheduled", count: 3 },
    ],
    waiting_yes_total: 8400,
    waiting_yes_count: 2,
    won_30d_count: 7,
    won_30d_total: 4750,
    won_30d_no_amount: 2,
    done_7d_count: 1,
    lost_30d_count: 1,
    lost_30d_went_elsewhere: 1,
    new_7d_count: 12,
    leak_count: 2,
    leak_text: "Waiting over a day for a first call: 2",
    leak_tone: "red",
  });
});

test("R14 numbersText equals the §10 block", () => {
  assert.equal(numbersText(computeNumbers(seedJobViews(), ctx), ctx), [
    "Frostline Refrigeration numbers - Mon Oct 5",
    "Open jobs: 13 (New 3, Waiting on quote 3, Their yes 2, Said yes 2, Scheduled 3)",
    "Waiting on a yes: $8,400 (2 quotes)",
    "Won last 30 days: 7 jobs, $4,750",
    "Done last 7 days: 1",
    "Lost last 30 days: 1 (1 went with someone else)",
    "New last 7 days: 12",
  ].join("\n"));
});

test("windows are rolling: (now - N days, now]", () => {
  const jobs = [
    makeJobView({ id: 1, created_at: daysBefore(7) }), // exactly 7 days ago: out
    makeJobView({ id: 2, created_at: daysBefore(7, 1) }), // just inside
    makeJobView({ id: 3, created_at: A }), // now: in
    makeJobView({ id: 4, created_at: daysBefore(40), stage: "done", next_due_at: null,
      won_at: daysBefore(30), done_at: daysBefore(7), closed_at: daysBefore(7) }), // both on the edge: out
    makeJobView({ id: 5, created_at: daysBefore(40), stage: "done", next_due_at: null, quote_amount: 600,
      won_at: daysBefore(30, 60_000), done_at: daysBefore(7, 60_000), closed_at: daysBefore(7, 60_000) }),
    makeJobView({ id: 6, created_at: daysBefore(20), stage: "lost", next_due_at: null,
      won_at: daysBefore(10), lost_at: daysBefore(2), closed_at: daysBefore(2), lost_reason: "price" }), // won then lost: not won
  ];
  const n = computeNumbers(jobs, ctx);
  assert.equal(n.new_7d_count, 2);
  assert.equal(n.won_30d_count, 1);
  assert.equal(n.won_30d_total, 600);
  assert.equal(n.done_7d_count, 1);
  assert.equal(n.lost_30d_count, 1);
  assert.equal(n.lost_30d_went_elsewhere, 0);
  assert.equal(n.open_count, 3);
  assert.equal(n.leak_count, 2); // ids 1 and 2 are untouched and older than a day
});

test("leak line counts untouched new leads older than a day", () => {
  const jobs = [
    makeJobView({ id: 1, created_at: daysBefore(1) }), // exactly 24h: counts
    makeJobView({ id: 2, created_at: daysBefore(1, 1) }), // under a day
    makeJobView({ id: 3, created_at: daysBefore(3), first_touch_at: daysBefore(2), attempts: 1 }), // tried
    makeJobView({ id: 4, created_at: daysBefore(3), stage: "quote" }),
  ];
  const n = computeNumbers(jobs, ctx);
  assert.deepEqual([n.leak_count, n.leak_text, n.leak_tone], [1, "Waiting over a day for a first call: 1", "red"]);
  const none = computeNumbers([jobs[1]], ctx);
  assert.deepEqual([none.leak_count, none.leak_text, none.leak_tone], [0, "Nobody waiting over a day for a first call", null]);
});

test("not_a_job jobs are left out of every metric", () => {
  const spam = makeJobView({ id: 9, created_at: daysBefore(0, -3_600_000), stage: "lost", next_due_at: null,
    lost_at: A, closed_at: A, lost_reason: "not_a_job" });
  const withSpam = computeNumbers([...seedJobViews(), spam], ctx);
  assert.deepEqual(withSpam, computeNumbers(seedJobViews(), ctx));
});

test("numbersText singulars and empty values", () => {
  const jobs = [
    makeJobView({ id: 1, stage: "waiting_yes", quote_amount: 2000, created_at: daysBefore(3), won_at: null, next_due_at: A }),
    makeJobView({ id: 2, stage: "to_schedule", created_at: daysBefore(3), won_at: daysBefore(1) }),
  ];
  const custom = ctxAt(A, { settings: { ...SETTINGS, company_name: "Cold Co" } });
  assert.equal(numbersText(computeNumbers(jobs, custom), custom), [
    "Cold Co numbers - Mon Oct 5",
    "Open jobs: 2 (New 0, Waiting on quote 0, Their yes 1, Said yes 1, Scheduled 0)",
    "Waiting on a yes: $2,000 (1 quote)",
    "Won last 30 days: 1 job, $0",
    "Done last 7 days: 0",
    "Lost last 30 days: 0",
    "New last 7 days: 2",
  ].join("\n"));
});
