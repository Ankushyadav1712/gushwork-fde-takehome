// Today (#/): header, stage strip, ranked sections of cards, footer (§4.8, §9).
import { html, useState, useEffect } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { money } from "/shared/format.js";
import { useApp, useAsync, ErrorState } from "../ui/common.js";
import { OPEN_STAGES, stageShort, bucketTone, ERROR_COPY } from "../ui/constants.js";
import { Icon } from "../ui/icons.js";

const REFRESH_MS = 60_000;

/** "All caught up" / "1 person to call" / "{n} people to call" (§4.8). */
export function headerFor(count) {
  if (count === 0) return "All caught up";
  if (count === 1) return "1 person to call";
  return `${count} people to call`;
}

export function repeatBadge(repeat) {
  if (!repeat || !repeat.past_jobs) return null;
  return `Repeat - ${repeat.past_jobs} past ${repeat.past_jobs === 1 ? "job" : "jobs"}`;
}

function demoPillText(demo) {
  if (!demo?.shifted || !demo.label) return null;
  return demo.label.startsWith("Demo time") ? demo.label : `Demo time: ${demo.label}`;
}

function useTodayRefresh(reload) {
  useEffect(() => {
    const quiet = () => reload({ quiet: true });
    const onVisible = () => { if (document.visibilityState === "visible") quiet(); };
    const timer = setInterval(quiet, REFRESH_MS);
    window.addEventListener("focus", quiet);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", quiet);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);
}

function TodayHeader({ today, count }) {
  const pill = demoPillText(today.demo);
  return html`<header class="today-header">
    <div class="today-date-row">
      <p class="today-date">${today.date_label}</p>
      ${pill && html`<a class="demo-pill" href="#/sim"><span class="demo-pill-inner"><${Icon} name="clock" size=${14} />${pill}</span></a>`}
    </div>
    <h1 class="today-count num">${headerFor(count)}</h1>
    ${today.waiting_yes_total > 0 && html`<p class="today-money num">${`${money(today.waiting_yes_total)} waiting on a yes`}</p>`}
  </header>`;
}

function StageStrip({ counts }) {
  if (!counts) return null;
  return html`<nav class="stage-strip" aria-label="Open jobs by stage">
    ${OPEN_STAGES.map((id) => html`<a key=${id} class="strip-chip" href=${`#/jobs?stage=${id}`}>
      <span>${stageShort(id)}</span> <span class="strip-count num">${counts[id] ?? 0}</span>
    </a>`)}
  </nav>`;
}

function CardActions({ card, onTap }) {
  // With no phone (an email-only lead), an Email button takes the place of Call and Text.
  const emailOnly = !card.tel_link && card.email;
  return html`<div class="card-actions">
    ${card.tel_link && html`<a class="btn-call" href=${card.tel_link} onClick=${() => onTap("call")}
      aria-label=${`Call ${card.title}`}><${Icon} name="phone" size=${20} /><span>Call</span></a>`}
    ${card.sms_link && html`<a class="btn-text" href=${card.sms_link} onClick=${() => onTap("text")}
      aria-label=${`Text ${card.title}`}><${Icon} name="message" size=${20} /><span>Text</span></a>`}
    ${emailOnly && html`<a class="btn-text" href=${`mailto:${card.email}`} onClick=${() => onTap("email")}
      aria-label=${`Email ${card.title}`}><${Icon} name="mail" size=${20} /><span>Email</span></a>`}
  </div>`;
}

function Card({ card, leaving, onOpen, onTap }) {
  const badge = repeatBadge(card.repeat);
  const meta = [card.subtitle, card.source_label].filter(Boolean).join(" · ");
  return html`<li class=${`card tone-${bucketTone(card.bucket)} ${leaving ? "leaving" : ""}`}>
    <button type="button" class="card-body" onClick=${onOpen} aria-label=${`${card.title}: ${card.reason}. Log what happened`}>
      <span class="card-title-row">
        <span class="card-title">${card.title}</span>
        ${Boolean(card.urgent) && card.bucket === "emergency" && html`<span class="badge badge-urgent">URGENT</span>`}
        ${badge && html`<span class="badge badge-repeat">${badge}</span>`}
      </span>
      ${meta && html`<span class="card-meta">${meta}</span>`}
      <span class="card-reason">${card.reason}</span>
      ${card.chip && html`<span class=${`chip chip-${card.chip.tone}`}>${card.chip.text}</span>`}
    </button>
    <${CardActions} card=${card} onTap=${onTap} />
  </li>`;
}

function Section({ section, leavingId, onOpen, onTap }) {
  const headingId = `section-${section.bucket}`;
  return html`<section class="today-section" aria-labelledby=${headingId}>
    <h2 class="divider" id=${headingId}>${`${section.label} (${section.count})`}</h2>
    <ul class="card-list">
      ${section.items.map((card) => html`<${Card} key=${card.job_id} card=${card} leaving=${leavingId === card.job_id}
        onOpen=${() => onOpen(card)} onTap=${(kind) => onTap(card, kind)} />`)}
    </ul>
  </section>`;
}

function TodayFooter({ footer }) {
  if (!footer) return null;
  return html`<footer class="today-footer">
    <a class="footer-link num" href="#/jobs">${`Scheduled today: ${footer.scheduled_today} · Snoozed: ${footer.snoozed}`}</a>
    <p class="trust-line">${footer.last24h_text}</p>
  </footer>`;
}

function TodaySkeleton() {
  return html`<div class="skeleton" aria-busy="true" aria-label="Loading your list">
    <div class="sk sk-line short"></div><div class="sk sk-line big"></div>
    ${[0, 1, 2].map((i) => html`<div key=${i} class="sk sk-card"></div>`)}
  </div>`;
}

export function TodayScreen() {
  const app = useApp();
  const { data, error, loading, reload } = useAsync(async () => {
    const today = await api.getToday();
    app.setServerNow(today?.now);
    return today;
  }, []);
  const [leavingId, setLeavingId] = useState(null);
  const [countOverride, setCountOverride] = useState(null);

  useTodayRefresh(reload);
  useEffect(() => { if (app.version) reload({ quiet: true }); }, [app.version]);
  useEffect(() => { setLeavingId(null); setCountOverride(null); }, [data]);

  if (!data) return error ? html`<${ErrorState} error=${error} onRetry=${reload} />` : html`<${TodaySkeleton} />`;

  const openCard = (card) => app.openSheet(card, {
    onSaved: (result) => {
      if (typeof result?.today_count === "number") setCountOverride(result.today_count);
      if (result?.on_today === false) setLeavingId(card.job_id);
    },
  });
  const tap = (card, kind) => {
    // Only Call and Text taps are logged (§5.8); every tap arms the sheet for her return.
    if (kind === "call" || kind === "text") api.postTap(card.job_id, kind).catch(() => {});
    app.rememberTap(card);
  };
  const count = countOverride ?? data.count;

  return html`<div class="today">
    ${error && !loading && error.status !== 401 && html`<div class="stale-banner" role="status">
      <span>${ERROR_COPY}</span>
      <button type="button" class="link-btn" onClick=${() => reload()}>Retry</button>
    </div>`}
    <${TodayHeader} today=${data} count=${count} />
    <${StageStrip} counts=${data.stage_counts} />
    ${data.sections.length === 0
      ? html`<div class="empty-state">
          <span class="empty-check"><${Icon} name="check" size=${32} /></span>
          <p class="empty-title">All caught up. Nobody's waiting on you.</p>
          <p class="trust-line">${data.footer?.last24h_text}</p>
        </div>`
      : data.sections.map((s) => html`<${Section} key=${s.bucket} section=${s} leavingId=${leavingId}
          onOpen=${openCard} onTap=${tap} />`)}
    ${data.sections.length > 0 && html`<${TodayFooter} footer=${data.footer} />`}
  </div>`;
}
