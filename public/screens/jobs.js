// Jobs (#/jobs?stage=): where every job is at, grouped by her stages, with search (§9).
import { html, useState, useEffect } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { pluralWord } from "/shared/format.js";
import { STAGES, OPEN_STAGES, stageShort } from "/shared/stages.js";
import { useApp, useAsync, ErrorState, Loading, PageHeader } from "../ui/common.js";
import { JobRow, isPutOff } from "../ui/job-info.js";
import { Icon } from "../ui/icons.js";

const SEARCH_DEBOUNCE_MS = 250;

// "later" (put off till later) is filtered here from the open list; the others are server filters.
const PUT_OFF = "later";
const FILTERS = [
  { id: "open", label: "All open" },
  ...OPEN_STAGES.map((id) => ({ id, label: stageShort(id) })),
  { id: PUT_OFF, label: "Put off till later" },
  { id: "closed", label: "Closed (last 30 days)" },
];
const UNCOUNTED = [PUT_OFF, "closed"];

function openTotal(counts) {
  if (!counts) return null;
  if (typeof counts.open === "number") return counts.open;
  return OPEN_STAGES.reduce((sum, id) => sum + (counts[id] || 0), 0);
}

function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Groups jobs by stage, in stage order, dropping empty groups. */
function groupByStage(jobs) {
  return STAGES.map((s) => ({ stage: s, jobs: jobs.filter((j) => j.stage === s.id) })).filter((g) => g.jobs.length);
}

function FilterChips({ active, counts }) {
  return html`<nav class="filter-chips" aria-label="Filter by stage">
    ${FILTERS.map((f) => {
      const count = f.id === "open" ? openTotal(counts) : counts?.[f.id];
      const isActive = active === f.id;
      return html`<a key=${f.id} href=${`#/jobs?stage=${f.id}`} class=${`filter-chip ${isActive ? "active" : ""}`}
        aria-current=${isActive ? "page" : null}>
        <span>${f.label}</span>${typeof count === "number" && !UNCOUNTED.includes(f.id) && html` <span class="num chip-count">${count}</span>`}
      </a>`;
    })}
  </nav>`;
}

export function JobsScreen({ stage }) {
  const app = useApp();
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), SEARCH_DEBOUNCE_MS);
  const { data, error, loading, reload } = useAsync(async () => {
    const putOff = stage === PUT_OFF;
    const res = await api.getJobs({ stage: putOff ? "open" : stage, q: query });
    app.setServerNow(res?.now);
    return putOff ? { ...res, jobs: res.jobs.filter((j) => isPutOff(j, res.now)) } : res;
  }, [stage, query]);
  useEffect(() => { if (app.version) reload({ quiet: true }); }, [app.version]);

  const total = openTotal(data?.counts);
  const now = data?.now || app.nowIso();
  const grouped = ["open", "closed", PUT_OFF].includes(stage);

  const list = () => {
    if (!data) return error ? html`<${ErrorState} error=${error} onRetry=${reload} />` : html`<${Loading} />`;
    if (!data.jobs.length) {
      return html`<p class="empty-note">${query ? `Nothing matches "${query}".` : "No jobs here right now."}</p>`;
    }
    if (!grouped) {
      return html`<ul class="job-list">${data.jobs.map((j) => html`<${JobRow} key=${j.id} job=${j} nowIso=${now} tz=${app.tz} />`)}</ul>`;
    }
    return groupByStage(data.jobs).map((g) => html`<section key=${g.stage.id} class="job-group" aria-labelledby=${`g-${g.stage.id}`}>
      <h2 class="divider" id=${`g-${g.stage.id}`}>${`${g.stage.label} (${g.jobs.length})`}</h2>
      <ul class="job-list">${g.jobs.map((j) => html`<${JobRow} key=${j.id} job=${j} nowIso=${now} tz=${app.tz} />`)}</ul>
    </section>`);
  };

  return html`<div class="jobs">
    <${PageHeader} title=${total == null ? "Jobs" : `${total} open ${pluralWord(total, "job", "jobs")}`}>
      ${app.demo && html`<a class="header-link" href="#/sim">Demo</a>`}
      <a class="header-link" href="#/numbers">Numbers</a>
      <a class="icon-btn" href="#/settings" aria-label="Settings"><${Icon} name="gear" /></a>
    </${PageHeader}>
    <${FilterChips} active=${stage} counts=${data?.counts} />
    <div class="search">
      <label class="visually-hidden" for="job-search">Search name, business or phone</label>
      <${Icon} name="search" size=${20} className="search-icon" />
      <input id="job-search" class="input search-input" type="search" placeholder="Search name, business or phone"
        value=${q} onInput=${(e) => setQ(e.currentTarget.value)} autocomplete="off" />
    </div>
    <div aria-busy=${loading ? "true" : "false"}>${list()}</div>
  </div>`;
}
