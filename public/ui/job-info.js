// One-line stage information for job rows (§9 Jobs): "Not contacted - 2d", "$2,400 · sent Thu", ...
import { html } from "/vendor/preact-htm.js";
import { formatAge, dayLabel, daysBetween, localDate } from "/shared/time.js";
import { money } from "/shared/format.js";
import { lostReasonShort } from "./constants.js";
import { capitalize } from "./common.js";
import { Icon } from "./icons.js";

/** formatAge without the trailing hours once it is at least a day: "2d 14h" -> "2d". */
export function shortAge(fromIso, nowIso) {
  return formatAge(fromIso, nowIso).replace(/^(\d+d) \d+h$/, "$1");
}

function daysText(n) {
  if (n <= 0) return "today";
  return n === 1 ? "1 day" : `${n} days`;
}

export function stageInfo(job, nowIso, tz) {
  const day = (x) => (x ? dayLabel(x, nowIso, tz) : null);
  switch (job.stage) {
    case "new":
      if (!job.first_touch_at) return `Not contacted - ${shortAge(job.created_at, nowIso)}`;
      return job.attempts > 0 ? `Tried ${job.attempts}x` : "Talked";
    case "quote":
      return daysText(daysBetween(localDate(job.stage_entered_at, tz), localDate(nowIso, tz)));
    case "waiting_yes":
      return [money(job.quote_amount), job.quote_sent_at && `sent ${day(job.quote_sent_at)}`].filter(Boolean).join(" · ");
    case "to_schedule":
      return `said yes ${day(job.stage_entered_at)}`;
    case "scheduled":
      return [capitalize(day(job.visit_date)), job.tech].filter(Boolean).join(" · ");
    case "done":
      return `done ${day(job.done_at || job.closed_at)}`;
    case "lost":
      return [`lost ${day(job.lost_at || job.closed_at)}`, lostReasonShort(job.lost_reason)].filter(Boolean).join(" · ");
    default:
      return "";
  }
}

/** A tappable job row: title, problem, stage information, chevron. */
export function JobRow({ job, nowIso, tz }) {
  const urgent = Boolean(job.urgent) && !["done", "lost"].includes(job.stage);
  return html`<li><a class="job-row" href=${`#/job/${job.id}`}>
    <span class="job-row-main">
      <span class="job-row-title">${job.title}${urgent && html` <span class="badge badge-urgent">URGENT</span>`}</span>
      ${job.problem && html`<span class="job-row-problem">${job.problem}</span>`}
      <span class="job-row-info">${stageInfo(job, nowIso, tz)}</span>
    </span>
    <${Icon} name="chevron" size=${20} className="chev" />
  </a></li>`;
}
