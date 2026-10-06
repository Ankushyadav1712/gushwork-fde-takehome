// Today (#/): header, ranked sections of cards, stage strip, footer (§4.8, §9).
import { html, useState, useEffect } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { money, plural } from "/shared/format.js";
import { OPEN_STAGES, stageShort } from "/shared/stages.js";
import { useApp, useAsync, ErrorState, mailtoHref } from "../ui/common.js";
import { bucketTone, ERROR_COPY } from "../ui/constants.js";
import { Icon } from "../ui/icons.js";

const REFRESH_MS = 60_000;

/** Header line 2 after an outcome changes the count: none when the list is empty (the empty card says it). */
function headerFor(count) {
  if (count === 0) return null;
  return count === 1 ? "1 person to call" : `${count} people to call`;
}

function repeatBadge(repeat) {
  return repeat?.past_jobs ? `Repeat - ${plural(repeat.past_jobs, "past job", "past jobs")}` : null;
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

function TodayHeader({ today, header }) {
  const pill = demoPillText(today.demo);
  return html`<header class="today-header">
    <div class="today-date-row">
      <p class="today-date">${today.date_label}</p>
      ${pill && html`<a class="demo-pill" href="#/sim"><span class="demo-pill-inner"><${Icon} name="clock" size=${14} />${pill}</span></a>`}
    </div>
    ${header ? html`<h1 class="today-count num">${header}</h1>` : html`<h1 class="visually-hidden">Today</h1>`}
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
    ${emailOnly && html`<a class="btn-text" href=${mailtoHref(card.email)} onClick=${() => onTap("email")}
      aria-label=${`Email ${card.title}`}><${Icon} name="mail" size=${20} /><span>Email</span></a>`}
  </div>`;
}

function Card({ card, leaving, onOpen, onTap }) {
  const badge = repeatBadge(card.repeat);
  const meta = [card.subtitle, card.source_label].filter(Boolean).join(" · ");
  return html`<li class=${`card tone-${bucketTone(card.bucket)} bucket-${card.bucket} ${leaving ? "leaving" : ""}`}>
    <button type="button" class="card-body" onClick=${onOpen}>
      <span class="card-title-row">
        <span class="card-title">${card.title}</span>
        ${Boolean(card.urgent) && card.bucket === "emergency" && html`<span class="badge badge-urgent">URGENT</span>`}
        ${badge && html`<span class="badge badge-repeat">${badge}</span>`}
      </span>
      ${meta && html`<span class="card-meta">${meta}</span>`}
      <span class="card-reason">${card.reason}</span>
      ${card.chip && html`<span class=${`chip chip-${card.chip.tone}`}>${card.chip.text}</span>`}
      <span class="visually-hidden">. Tap to log what happened</span>
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

/** "Scheduled today: {k} · Put off till later: {s}" (§4.8), each half a link to those jobs. */
function TodayFooter({ footer }) {
  if (!footer) return null;
  return html`<footer class="today-footer">
    <p class="footer-links num">
      <a class="footer-link" href="#/jobs?stage=scheduled">${`Scheduled today: ${footer.scheduled_today}`}</a>
      <span aria-hidden="true">·</span>
      <a class="footer-link" href="#/jobs?stage=later">${`Put off till later: ${footer.snoozed}`}</a>
    </p>
    <p class="trust-line">${footer.last24h_text}</p>
  </footer>`;
}

function EmptyState({ empty, putOff }) {
  return html`<div class="empty-state">
    <span class=${`empty-icon ${putOff ? "later" : ""}`}><${Icon} name=${putOff ? "clock" : "check"} size=${32} /></span>
    <p class="empty-title">${empty.title}</p>
    <p class="empty-text">${empty.text}</p>
  </div>`;
}

function TextsFailingBanner() {
  return html`<a class="alert-banner" href="#/settings">
    <${Icon} name="alert" size=${20} /><span>Texts to your phone aren't going through. Check Settings.</span>
    <${Icon} name="chevron" size=${18} />
  </a>`;
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
  const header = countOverride == null ? data.header : headerFor(countOverride);

  return html`<div class="today">
    ${error && !loading && error.status !== 401 && html`<div class="stale-banner" role="status">
      <span>${ERROR_COPY}</span>
      <button type="button" class="link-btn" onClick=${() => reload()}>Retry</button>
    </div>`}
    ${data.texts_failing && html`<${TextsFailingBanner} />`}
    <${TodayHeader} today=${data} header=${header} />
    ${data.empty
      ? html`<${EmptyState} empty=${data.empty} putOff=${data.footer?.snoozed > 0} />`
      : data.sections.map((s) => html`<${Section} key=${s.bucket} section=${s} leavingId=${leavingId}
          onOpen=${openCard} onTap=${tap} />`)}
    <${StageStrip} counts=${data.stage_counts} />
    <${TodayFooter} footer=${data.footer} />
  </div>`;
}
