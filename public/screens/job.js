// Job detail (#/job/:id): fields saved on blur, stage stepper, history, past jobs,
// and Call · Text · Text a tech · Lost / Bring back (§5.7, §9).
import { html, useState, useEffect, useRef } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { phoneDisplay, plural } from "/shared/format.js";
import { whenLabel } from "/shared/time.js";
import { techText } from "/shared/templates.js";
import { STAGES, EQUIPMENT, isOpen, stageLabel } from "/shared/stages.js";
import { useApp, useAsync, ErrorState, Loading, PageHeader, capitalize, smsHref, mailtoHref } from "../ui/common.js";
import { equipmentChip, ERROR_COPY } from "../ui/constants.js";
import { stageInfo, JobRow } from "../ui/job-info.js";
import { Sheet } from "../ui/sheet.js";
import { DayPicker, TechPicker, AmountPad, LostReasonPicker } from "../ui/pickers.js";
import { Icon } from "../ui/icons.js";
import { ReplyQuote } from "./outcome-sheet.js";

const MAPS_URL = "https://maps.google.com/?q=";

/** The customer's latest message on this job, from the history. */
function latestInbound(timeline = []) {
  return timeline.filter((t) => t.actor === "customer" && t.body).sort(newestFirst)[0] || null;
}

/** The outcome-sheet subject for this job, shaped like a Today card. */
function subjectFrom(detail) {
  const { job, customer, timeline = [], outcomes = [] } = detail;
  const inbound = latestInbound(timeline);
  return {
    job_id: job.id, title: job.title, stage: job.stage, bucket: job.bucket, outcomes,
    unread: Boolean(job.unread_inbound_at),
    last_inbound: inbound ? { body: inbound.body, at_label: inbound.at_label } : null,
    quote_amount: job.quote_amount ?? null,
    phone: customer?.phone ?? null,
    tel_link: detail.tel_link, sms_link: detail.sms_link,
  };
}

function newestFirst(a, b) {
  return b.at === a.at ? (b.id ?? 0) - (a.id ?? 0) : String(b.at).localeCompare(String(a.at));
}

function toPatchValue(name, raw) {
  if (name === "quote_amount") {
    const digits = String(raw ?? "").replace(/[^0-9.]/g, "");
    return digits ? Math.round(Number(digits)) : null;
  }
  const s = String(raw ?? "").trim();
  return s === "" ? null : s;
}

/** A labelled input that saves on blur when its value changed. */
function Field({ label, name, value, onSave, type = "text", multiline = false, inputMode, placeholder, action }) {
  const shown = value == null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const id = `f-${name}`;
  const commit = () => { if (draft !== shown) onSave(name, draft); };
  const props = { id, class: "input", value: draft, placeholder, inputMode, onInput: (e) => setDraft(e.currentTarget.value), onBlur: commit };
  return html`<div class="field">
    <label class="field-label" for=${id}>${label}</label>
    <div class="field-row">
      ${multiline ? html`<textarea ...${props} rows="3"></textarea>` : html`<input ...${props} type=${type} />`}
      ${action}
    </div>
  </div>`;
}

function SelectField({ label, name, value, options, onSave }) {
  const id = `f-${name}`;
  return html`<div class="field">
    <label class="field-label" for=${id}>${label}</label>
    <select id=${id} class="input" value=${value ?? ""} onChange=${(e) => onSave(name, e.currentTarget.value)}>
      ${options.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
    </select>
  </div>`;
}

function UrgentSwitch({ on, onToggle }) {
  return html`<div class="field switch-field">
    <span class="field-label" id="urgent-label">Urgent</span>
    <button type="button" role="switch" aria-checked=${on ? "true" : "false"} aria-labelledby="urgent-label"
      class=${`switch ${on ? "on" : ""}`} onClick=${onToggle}>
      <span class="switch-text">${on ? "URGENT" : "Not urgent"}</span>
      <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
    </button>
  </div>`;
}

function NextDateLine({ job, now, tz, onChange }) {
  if (!isOpen(job.stage)) {
    return html`<p class="next-line">${capitalize(stageInfo(job, now, tz))}</p>`;
  }
  if (job.on_today) {
    return html`<p class="next-line on-today"><${Icon} name="check" size=${18} /> On today's list</p>`;
  }
  const when = job.back_on_list || capitalize(whenLabel(job.next_due_at, now, tz) || "");
  return html`<p class="next-line">
    <span>Back on your list: <strong>${when}</strong></span>
    ${job.stage !== "scheduled" && html` · <button type="button" class="link-btn" onClick=${onChange}>Change</button>`}
  </p>`;
}

function StageStepper({ stage, onPick }) {
  return html`<ol class="stage-stepper" aria-labelledby="stage-h">
    ${STAGES.map((s) => html`<li key=${s.id}>
      <button type="button" class=${`stage-step ${s.id === stage ? "active" : ""} stage-${s.id}`}
        aria-current=${s.id === stage ? "step" : null} onClick=${() => s.id !== stage && onPick(s.id)}>
        ${s.label}
      </button>
    </li>`)}
  </ol>`;
}

function Timeline({ items }) {
  if (!items?.length) return html`<p class="empty-note">Nothing yet.</p>`;
  return html`<ol class="timeline">
    ${[...items].sort(newestFirst).map((t) => html`<li key=${t.id} class=${`tl-item actor-${t.actor} ${t.undone ? "undone" : ""}`}>
      <p class="tl-line"><span class="tl-when num">${t.at_label}</span> · <span class="tl-summary">${t.summary}</span>
        ${t.undone && html` <span class="tl-undone">(undone)</span>`}</p>
      ${t.body && html`<blockquote class="tl-body">${t.body}</blockquote>`}
    </li>`)}
  </ol>`;
}

/** "Move to {label}?" with the pickers that stage needs (§5.7). */
function StageSheet({ job, to, onClose }) {
  const app = useApp();
  const [step, setStep] = useState(to === "scheduled" ? "day" : null);
  const [visitDate, setVisitDate] = useState(null);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);
  const techs = app.settings?.techs || [];

  async function submit(args = {}) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const result = await api.postStage(job.id, { to, ...args });
      onClose();
      app.outcomeSaved(job.id, result, { tech: args.tech });
    } catch (err) {
      inFlight.current = false;
      if (err.status === 409) { onClose(); app.staleStage(); return; }
      if (err.status !== 401) setError(err.status === 0 ? ERROR_COPY : "That didn't save. Please try again.");
    }
  }
  const pickDay = (day) => {
    if (!techs.length) return submit({ visit_date: day });
    setVisitDate(day);
    setStep("tech");
  };

  let body;
  if (to === "scheduled" && step === "day") {
    body = html`<p class="step-title" tabindex="-1">Which day?</p><${DayPicker} now=${app.nowIso()} tz=${app.tz} onPick=${pickDay} />`;
  } else if (to === "scheduled") {
    body = html`<p class="step-title" tabindex="-1">Which tech?</p>
      <${TechPicker} techs=${techs} onPick=${(tech) => submit({ visit_date: visitDate, tech })} />`;
  } else if (to === "waiting_yes") {
    body = html`<p class="step-title">Quote amount (optional)</p>
      <${AmountPad} initial=${job.quote_amount} onSave=${(amount) => submit({ amount })} />`;
  } else if (to === "lost") {
    body = html`<p class="step-title">Why was it lost?</p><${LostReasonPicker} onPick=${(r) => submit({ lost_reason: r })} />`;
  } else {
    body = html`<div class="stack">
      <button type="button" class="btn btn-primary" onClick=${() => submit()}>${`Move to ${stageLabel(to)}`}</button>
      <button type="button" class="btn btn-secondary" onClick=${onClose}>Cancel</button>
    </div>`;
  }
  return html`<${Sheet} titleId="stage-title" step=${step} onClose=${onClose}>
    <h2 id="stage-title" class="sheet-title">${to === "new" && !isOpen(job.stage) ? "Bring this job back?" : `Move to ${stageLabel(to)}?`}</h2>
    ${error && html`<p class="inline-error" role="alert">${error}</p>`}
    ${body}
  </${Sheet}>`;
}

function TechTextSheet({ job, customer, onClose }) {
  const app = useApp();
  const techs = (app.settings?.techs || []).filter((t) => t.name);
  const body = techText({ ...job, customer }, { settings: app.settings });
  return html`<${Sheet} titleId="tech-title" onClose=${onClose}>
    <h2 id="tech-title" class="sheet-title">Text a tech</h2>
    <pre class="message-preview">${body}</pre>
    <div class="stack">
      ${techs.map((t) => html`<a key=${t.name} class="btn btn-secondary btn-split" href=${smsHref(t.phone, body)}
        onClick=${() => { api.postTap(job.id, "tech_text", t.name).catch(() => {}); setTimeout(onClose, 0); }}>
        <span>${t.name}</span><span class="muted num">${phoneDisplay(t.phone) || ""}</span>
      </a>`)}
      ${!techs.length && html`<p class="empty-note">Add your techs in <a href="#/settings">Settings</a> first.</p>`}
    </div>
  </${Sheet}>`;
}

function ActionBar({ detail, open, onTap, onTechText, onLost, onBringBack }) {
  // The sheet's lost outcome is "Cancelled" for a booked visit (§5.2); the bar uses the same word.
  const lostLabel = detail.job.stage === "scheduled" ? "Cancelled" : "Lost";
  return html`<div class="action-bar">
    <div class="action-bar-inner">
      ${detail.tel_link && html`<a class="action btn-call" href=${detail.tel_link} onClick=${() => onTap("call")}><${Icon} name="phone" size=${20} /><span>Call</span></a>`}
      ${detail.sms_link && html`<a class="action btn-text" href=${detail.sms_link} onClick=${() => onTap("text")}><${Icon} name="message" size=${20} /><span>Text</span></a>`}
      <button type="button" class="action btn-plain" onClick=${onTechText}><${Icon} name="truck" size=${20} /><span>Text a tech</span></button>
      ${open
        ? html`<button type="button" class="action btn-plain danger" onClick=${onLost}><${Icon} name="close" size=${20} /><span>${lostLabel}</span></button>`
        : html`<button type="button" class="action btn-plain" onClick=${onBringBack}><${Icon} name="undo" size=${20} /><span>Bring back</span></button>`}
    </div>
  </div>`;
}

export function JobScreen({ id }) {
  const app = useApp();
  const { data, error, reload } = useAsync(() => api.getJob(id), [id]);
  const [stageTo, setStageTo] = useState(null);
  const [techSheet, setTechSheet] = useState(false);
  const [saveState, setSaveState] = useState("");
  useEffect(() => { if (app.version) reload({ quiet: true }); }, [app.version]);

  if (!data) {
    return html`<div class="job-detail"><${PageHeader} title="Job" back="#/jobs" heading=${false} />
      ${error?.status === 404
        ? html`<p class="empty-note">That job isn't here anymore. <a href="#/jobs">See all jobs</a></p>`
        : error ? html`<${ErrorState} error=${error} onRetry=${reload} />` : html`<${Loading} />`}</div>`;
  }

  const { job, customer = {}, timeline, past_jobs: pastJobs = [] } = data;
  const now = app.nowIso();
  const open = isOpen(job.stage);
  const subject = subjectFrom(data);
  const inbound = latestInbound(timeline);
  const techs = app.settings?.techs || [];

  async function save(name, raw) {
    const value = name === "urgent" ? raw : toPatchValue(name, raw);
    setSaveState("Saving…");
    try {
      await api.updateJob(job.id, { [name]: value });
      setSaveState("Saved");
      reload({ quiet: true });
    } catch (err) {
      setSaveState(err.status === 0 ? ERROR_COPY : "Couldn't save that change.");
    }
  }
  const tap = (kind) => {
    api.postTap(job.id, kind).catch(() => {});
    if (open) app.rememberTap(subject);
  };
  const equipmentOptions = [{ value: "", label: "Not set" }, ...EQUIPMENT.map((e) => ({ value: e.id, label: e.label }))];
  const techNames = techs.map((t) => t.name);
  if (job.tech && !techNames.includes(job.tech)) techNames.push(job.tech);
  const techOptions = [{ value: "", label: "No tech" }, ...techNames.map((n) => ({ value: n, label: n }))];
  const chip = equipmentChip(job.equipment);

  return html`<div class="job-detail has-action-bar">
    <${PageHeader} title="Job" back="#/jobs" heading=${false} />
    <section class="panel job-summary">
      <div class="job-title-row">
        <h1 class="job-title">${job.title}</h1>
        <span class=${`stage-pill stage-${job.stage}`}>${job.stage_label || stageLabel(job.stage)}</span>
      </div>
      ${job.subtitle && html`<p class="job-subtitle">${job.subtitle}</p>`}
      <p class="job-meta">
        ${[job.source_label, chip, job.repeat?.past_jobs ? `Repeat - ${plural(job.repeat.past_jobs, "past job", "past jobs")}` : null]
          .filter(Boolean).join(" · ")}
        ${Boolean(job.urgent) && open && html` <span class="badge badge-urgent">URGENT</span>`}
      </p>
      ${job.on_today && job.reason && html`<p class="job-reason">${job.reason}</p>`}
      <${ReplyQuote} inbound=${inbound} />
      <${NextDateLine} job=${job} now=${now} tz=${app.tz} onChange=${() => app.openSheet(subject, { initialOutcome: "snooze" })} />
      ${open && subject.outcomes.length > 0 && html`<button type="button" class="btn btn-primary"
        onClick=${() => app.openSheet(subject)}>${job.bucket === "check_done" ? "Did it get done?" : "How'd it go?"}</button>`}
    </section>

    <section class="panel" aria-labelledby="job-h">
      <div class="panel-head"><h2 id="job-h" class="panel-title">The job</h2>
        <span class="save-state" aria-live="polite">${saveState}</span></div>
      <${Field} label="What's wrong" name="problem" value=${job.problem} onSave=${save} />
      <${SelectField} label="Equipment" name="equipment" value=${job.equipment} options=${equipmentOptions} onSave=${save} />
      <${UrgentSwitch} on=${Boolean(job.urgent)} onToggle=${() => save("urgent", !job.urgent)} />
      <div class="field-pair">
        <${Field} label="Quote $" name="quote_amount" value=${job.quote_amount} inputMode="numeric" placeholder="0" onSave=${save} />
        <${Field} label="Visit date" name="visit_date" type="date" value=${job.visit_date} onSave=${save} />
      </div>
      <${SelectField} label="Tech" name="tech" value=${job.tech} options=${techOptions} onSave=${save} />
      <${Field} label="Notes" name="notes" value=${job.notes} multiline onSave=${save} />
      ${job.details && html`<p class="muted small">${job.details}</p>`}
      ${job.parsed_by === "ai" && html`<p class="muted small">Details filled in by AI</p>`}
    </section>

    <section class="panel" aria-labelledby="cust-h">
      <h2 id="cust-h" class="panel-title">Customer</h2>
      <${Field} label="Business" name="business_name" value=${customer.business_name} onSave=${save} />
      <${Field} label="Contact" name="contact_name" value=${customer.contact_name} onSave=${save} />
      <${Field} label="Phone" name="phone" type="tel" value=${phoneDisplay(customer.phone) || ""} onSave=${save}
        action=${data.tel_link && html`<a class="icon-btn outline" href=${data.tel_link} onClick=${() => tap("call")} aria-label="Call"><${Icon} name="phone" /></a>`} />
      <${Field} label="Email" name="email" type="email" value=${customer.email} onSave=${save}
        action=${customer.email && html`<a class="icon-btn outline" href=${mailtoHref(customer.email)} aria-label="Email"><${Icon} name="mail" /></a>`} />
      <${Field} label="Address" name="address" value=${customer.address} onSave=${save}
        action=${customer.address && html`<a class="icon-btn outline" href=${MAPS_URL + encodeURIComponent(customer.address)}
          target="_blank" rel="noopener" aria-label="Open in maps"><${Icon} name="map" /></a>`} />
    </section>

    <section class="panel" aria-labelledby="stage-h">
      <h2 id="stage-h" class="panel-title">Where it's at</h2>
      <${StageStepper} stage=${job.stage} onPick=${setStageTo} />
    </section>

    <section class="panel" aria-labelledby="hist-h">
      <h2 id="hist-h" class="panel-title">History</h2>
      <${Timeline} items=${timeline} />
    </section>

    ${pastJobs.length > 0 && html`<section class="panel" aria-labelledby="past-h">
      <h2 id="past-h" class="panel-title">Past jobs</h2>
      <ul class="job-list flush">${pastJobs.map((j) => html`<${JobRow} key=${j.id} job=${j} nowIso=${now} tz=${app.tz} />`)}</ul>
    </section>`}

    <${ActionBar} detail=${data} open=${open} onTap=${tap} onTechText=${() => setTechSheet(true)}
      onLost=${() => app.openSheet(subject, { initialOutcome: "lost" })} onBringBack=${() => setStageTo("new")} />
    ${stageTo && html`<${StageSheet} job=${job} to=${stageTo} onClose=${() => setStageTo(null)} />`}
    ${techSheet && html`<${TechTextSheet} job=${job} customer=${customer} onClose=${() => setTechSheet(false)} />`}
  </div>`;
}
