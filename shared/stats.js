// Numbers for her husband (§10). Rolling windows: (now - N days, now]. Jobs closed as
// `not_a_job` are left out of every metric, and Brain dump imports (her notebook backlog) don't
// count as new work. Pure: `now` comes from ctx.

import { OPEN_STAGES, stageShort } from "./stages.js";
import { shortDateLabel } from "./time.js";
import { money, plural } from "./format.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Stages that mean the customer said yes. A job moved back to a quote isn't won, so no job is both. */
const WON_STAGES = ["to_schedule", "scheduled", "done"];

function inWindow(iso, nowMs, days) {
  if (iso == null) return false;
  const t = Date.parse(iso);
  return t > nowMs - days * DAY_MS && t <= nowMs;
}

const sumAmounts = (jobs) => jobs.reduce((sum, j) => sum + (j.quote_amount ?? 0), 0);

function leakFor(jobs, nowMs) {
  const count = jobs.filter((j) => j.stage === "new" && !j.first_touch_at
    && Date.parse(j.created_at) <= nowMs - 24 * HOUR_MS).length;
  return {
    leak_count: count,
    leak_text: count > 0 ? `Waiting over a day for a first call: ${count}` : "Nobody waiting over a day for a first call",
    leak_tone: count > 0 ? "red" : null,
  };
}

/** The §10 metrics as one flat object (plus `stages` for tiles). */
export function computeNumbers(jobViews, ctx) {
  const nowMs = Date.parse(ctx.now);
  const jobs = jobViews.filter((j) => j.lost_reason !== "not_a_job");
  const open = jobs.filter((j) => OPEN_STAGES.includes(j.stage));
  const stageCounts = Object.fromEntries(OPEN_STAGES.map((s) => [s, open.filter((j) => j.stage === s).length]));
  const waitingYes = open.filter((j) => j.stage === "waiting_yes");
  const won = jobs.filter((j) => WON_STAGES.includes(j.stage) && inWindow(j.won_at, nowMs, 30));
  const lost = jobs.filter((j) => j.stage === "lost" && inWindow(j.lost_at, nowMs, 30));
  return {
    now: ctx.now,
    date_label: shortDateLabel(ctx.now, ctx.tz),
    open_count: open.length,
    stage_counts: stageCounts,
    stages: OPEN_STAGES.map((s) => ({ stage: s, label: stageShort(s), count: stageCounts[s] })),
    waiting_yes_total: sumAmounts(waitingYes),
    waiting_yes_count: waitingYes.length,
    won_30d_count: won.length,
    won_30d_total: sumAmounts(won),
    won_30d_no_amount: won.filter((j) => j.quote_amount == null).length,
    done_7d_count: jobs.filter((j) => j.stage === "done" && inWindow(j.done_at, nowMs, 7)).length,
    lost_30d_count: lost.length,
    lost_30d_went_elsewhere: lost.filter((j) => j.lost_reason === "went_elsewhere").length,
    new_7d_count: jobs.filter((j) => j.source !== "bulk" && inWindow(j.created_at, nowMs, 7)).length,
    ...leakFor(jobs, nowMs),
  };
}

/** The plain-text summary (§10): "Text this to Rick", Copy and the read-only page. */
export function numbersText(numbers, ctx) {
  const company = ctx.settings.company_name;
  const date = shortDateLabel(ctx.now, ctx.tz);
  const byStage = OPEN_STAGES.map((s) => `${stageShort(s)} ${numbers.stage_counts[s] ?? 0}`).join(", ");
  const lostDetail = numbers.lost_30d_count > 0 ? ` (${numbers.lost_30d_went_elsewhere} went with someone else)` : "";
  return [
    `${company} numbers - ${date}`,
    `Open jobs: ${numbers.open_count} (${byStage})`,
    `Waiting on a yes: ${money(numbers.waiting_yes_total)} (${plural(numbers.waiting_yes_count, "quote", "quotes")})`,
    `Won last 30 days: ${plural(numbers.won_30d_count, "job", "jobs")}, ${money(numbers.won_30d_total)}`,
    `Done last 7 days: ${numbers.done_7d_count}`,
    `Lost last 30 days: ${numbers.lost_30d_count}${lostDetail}`,
    `New last 7 days: ${numbers.new_7d_count}`,
  ].join("\n");
}

/** The line under the Numbers title, shared by the app screen and the husband's page. */
export const NUMBERS_WINDOW_NOTE = "Counted over the last 7 or 30 days.";

/** No-break spaces keep a phrase on one line ("Said yes 2", "(2 without a $)"). */
const keep = (s) => s.replace(/ /g, "\u00a0");

/**
 * The Numbers tiles in display order, shared by the app screen and the husband's read-only page:
 * [{key, label, value, detail (string|null), wide}].
 */
export function numbersTiles(n) {
  const stages = n.stages.map((s) => keep(`${s.label} ${s.count}`)).join(" · ");
  const noAmount = n.won_30d_no_amount ? ` ${keep(`(${n.won_30d_no_amount} without a $)`)}` : "";
  return [
    { key: "open", label: "Open jobs", value: String(n.open_count), detail: stages, wide: true },
    {
      key: "waiting_yes", label: "Waiting on a yes", value: money(n.waiting_yes_total) || "$0",
      detail: plural(n.waiting_yes_count, "quote", "quotes"), wide: true,
    },
    {
      key: "won", label: "Won, last 30 days", value: plural(n.won_30d_count, "job", "jobs"),
      detail: `${money(n.won_30d_total) || "$0"}${noAmount}`, wide: false,
    },
    { key: "done", label: "Done, last 7 days", value: String(n.done_7d_count), detail: null, wide: false },
    {
      key: "lost", label: "Lost, last 30 days", value: String(n.lost_30d_count),
      detail: n.lost_30d_count ? `${n.lost_30d_went_elsewhere} went with someone else` : null, wide: false,
    },
    { key: "new", label: "New, last 7 days", value: String(n.new_7d_count), detail: null, wide: false },
  ];
}
