// + New / Quick Add (#/new): one box, a live rules preview in the browser, a background
// server parse ("Reading…" -> "Filled in by AI - check it"), 3 visible fields, stage chips.
// A text from a customer with an open job can be added to that job instead of starting a new one.
import { html, useState, useEffect, useRef } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { money, phoneDisplay, plural } from "/shared/format.js";
import { dayLabel } from "/shared/time.js";
import { parseMessage, PARSE_FIELDS } from "/shared/parse.js";
import { useApp, PageHeader } from "../ui/common.js";
import { equipmentChip, ERROR_COPY } from "../ui/constants.js";
import { Sheet } from "../ui/sheet.js";
import { DayPicker, TechPicker, AmountPad } from "../ui/pickers.js";
import { Icon } from "../ui/icons.js";

const PREVIEW_DEBOUNCE_MS = 300;
const SERVER_DEBOUNCE_MS = 700;
const PLACEHOLDER = "Who is it and what's wrong? Paste a text or email, or tap the mic on your keyboard.";
const STAGE_CHIPS = [
  { id: "new", label: "Just came in" },
  { id: "quote", label: "I owe them a quote" },
  { id: "waiting_yes", label: "Quote sent" },
  { id: "to_schedule", label: "Said yes" },
  { id: "scheduled", label: "Scheduled" },
];

/** Normalises either a parseMessage() result or an /api/parse response into {fields, stage_hint, ...}. */
function normaliseParse(p) {
  if (!p) return null;
  const src = p.fields || p;
  const fields = Object.fromEntries(PARSE_FIELDS.map((name) => [name, src[name] ?? null]));
  fields.urgent = Boolean(src.urgent);
  return {
    fields,
    stage_hint: p.stage_hint ?? null,
    callback_date: p.callback_date ?? null,
    quote_amount: p.quote_amount ?? null,
    quote_sent_at: p.quote_sent_at ?? null,
    visit_date: p.visit_date ?? null,
    tech: p.tech ?? null,
    matched_customer: p.matched_customer ?? null,
    mode: p.mode ?? null,
  };
}

function useLiveParse(text, app) {
  const [local, setLocal] = useState(null);
  const [server, setServer] = useState(null);
  const [reading, setReading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) { setLocal(null); setServer(null); setReading(false); return undefined; }
    const t = setTimeout(() => {
      const s = app.settings || {};
      setLocal({
        text: trimmed,
        parse: normaliseParse(parseMessage(trimmed, {
          channel: "manual", owner_phone: s.owner_phone, owner_email: s.owner_email, techs: s.techs || [],
          now: app.nowIso(), tz: app.tz,
        })),
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const trimmed = text.trim();
    const mine = ++seq.current;
    if (!trimmed) return undefined;
    setReading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.parseText(trimmed, true);
        if (mine === seq.current) setServer({ text: trimmed, parse: normaliseParse(res) });
      } catch { /* the local preview stays; the badge falls back to "Filled in for you" */ }
      if (mine === seq.current) setReading(false);
    }, SERVER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  // A server parse of earlier text is dropped at once: its matched customer (and open-job banner)
  // belongs to that text, not this one. The local preview stands in until the new one is back.
  // Until either parse is of this text (`pending`, up to 300 ms), the fields shown are the old text's.
  const trimmed = text.trim();
  const fresh = server?.text === trimmed ? server.parse : null;
  const pending = Boolean(trimmed) && !fresh && local?.text !== trimmed;
  return { parse: fresh || local?.parse || null, reading, pending, mode: fresh?.mode || (local ? "rules" : null) };
}

function ReadBadge({ reading, mode }) {
  if (reading) return html`<span class="read-badge reading"><span class="spinner small" aria-hidden="true"></span>Reading…</span>`;
  if (!mode) return null;
  return html`<span class="read-badge">${mode === "ai" ? "Filled in by AI - check it" : "Filled in for you - check it"}</span>`;
}

function stageChipLabel(chip, choice, now, tz) {
  if (chip.id === "waiting_yes" && choice.stage === "waiting_yes" && choice.quote_amount) return `Quote sent ${money(choice.quote_amount)}`;
  if (chip.id === "scheduled" && choice.stage === "scheduled") {
    if (!choice.visit_date) return "Scheduled - pick a day";
    const day = dayLabel(choice.visit_date, now, tz);
    return `Scheduled ${day}${choice.tech ? ` · ${choice.tech}` : ""}`;
  }
  return chip.label;
}

/** "Rosa's Taqueria already has an open job: Walk-in compressor (Waiting on their yes, $2,400)". */
function openJobText(customer) {
  const job = customer.open_job;
  const detail = [job.stage_label, money(job.quote_amount)].filter(Boolean).join(", ");
  return `${customer.title} already has an open job: ${job.problem || "no details yet"} (${detail})`;
}

function repeatText(customer) {
  const past = customer.past_jobs ? ` - ${plural(customer.past_jobs, "past job", "past jobs")}` : "";
  return `Repeat customer: ${customer.title}${past}`;
}

/** Banner for a known customer; with an open job it asks whether this text belongs to that job. */
function CustomerBanner({ customer, asking, busy, onAttach, onNewJob }) {
  if (!asking) return html`<p class="repeat-banner">${repeatText(customer)}</p>`;
  return html`<div class="repeat-banner open-job-banner" role="group" aria-labelledby="open-job-text">
    <p id="open-job-text">${openJobText(customer)}</p>
    <div class="stack">
      <button type="button" class="btn btn-primary" disabled=${busy} onClick=${onAttach}>Add this to that job</button>
      <button type="button" class="btn btn-secondary" disabled=${busy} onClick=${onNewJob}>It's a new job</button>
    </div>
  </div>`;
}

/** Copy for a failed save: the form's own problems, else a retry, else the offline line. */
function saveErrorText(err) {
  if (err.code === "attach_mismatch") return err.message;
  if (err.status === 400) return "Add a name, a phone number, or what's wrong.";
  if (err.status === 422) return "That stage needs a bit more. Tap it to fill in the details.";
  return err.status === 0 ? ERROR_COPY : "That didn't save. Please try again.";
}

/** Sheet for the two stage chips that need a value: Quote sent (amount) and Scheduled (day, then tech). */
function StagePickerSheet({ stage, onDone, onClose }) {
  const app = useApp();
  const [day, setDay] = useState(null);
  const techs = app.settings?.techs || [];
  let body;
  if (stage === "waiting_yes") {
    body = html`<p class="step-title" tabindex="-1">How much was the quote?</p>
      <${AmountPad} onSave=${(amount) => onDone({ stage, quote_amount: amount })} />`;
  } else if (!day) {
    body = html`<p class="step-title" tabindex="-1">Which day?</p>
      <${DayPicker} now=${app.nowIso()} tz=${app.tz} onPick=${(d) => (techs.length ? setDay(d) : onDone({ stage, visit_date: d }))} />`;
  } else {
    body = html`<p class="step-title" tabindex="-1">Which tech?</p>
      <${TechPicker} techs=${techs} onPick=${(tech) => onDone({ stage, visit_date: day, tech })} />`;
  }
  return html`<${Sheet} titleId="stage-pick-title" step=${day ? "tech" : "day"} onClose=${onClose}>
    <h2 id="stage-pick-title" class="sheet-title">${stage === "waiting_yes" ? "Quote sent" : "Scheduled"}</h2>
    ${body}
  </${Sheet}>`;
}

export function NewScreen() {
  const app = useApp();
  const [text, setText] = useState("");
  const [edits, setEdits] = useState({});
  const [choice, setChoice] = useState(null);
  const [urgentEdit, setUrgentEdit] = useState(null);
  const [keepCallback, setKeepCallback] = useState(true);
  const [picker, setPicker] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newJobFor, setNewJobFor] = useState(null);
  const { parse, reading, pending, mode } = useLiveParse(text, app);

  const fields = parse?.fields || {};
  const whoParsed = fields.business_name || fields.contact_name || "";
  const who = edits.who ?? whoParsed;
  const phone = edits.phone ?? (phoneDisplay(fields.phone) || "");
  const problem = edits.problem ?? fields.problem ?? "";
  const urgent = urgentEdit ?? Boolean(fields.urgent);
  const hinted = STAGE_CHIPS.some((c) => c.id === parse?.stage_hint) ? parse.stage_hint : "new";
  const stage = choice?.stage ?? hinted;
  // With no stage chip tapped, the parse's own values (visit day, tech, quote) go with the hinted stage.
  const effectiveChoice = choice || {
    stage, quote_amount: parse?.quote_amount ?? null, quote_sent_at: parse?.quote_sent_at ?? null,
    visit_date: parse?.visit_date ?? null, tech: parse?.tech ?? null,
  };
  // "call back thursday" proposes a snooze for any starting stage except Scheduled (its date is the visit).
  const callbackDate = stage !== "scheduled" ? parse?.callback_date : null;
  const now = app.nowIso();
  const chip = equipmentChip(fields.equipment);
  const customer = parse?.matched_customer;
  const openJob = customer?.open_job;
  const askAttach = Boolean(openJob) && newJobFor !== openJob.id;
  const showPreview = text.trim().length > 0;

  const edit = (name) => (e) => setEdits({ ...edits, [name]: e.currentTarget.value });
  const pickStage = (id) => {
    if (id === "waiting_yes" || id === "scheduled") setPicker({ stage: id });
    else setChoice({ stage: id });
  };

  function buildFields() {
    const out = { ...fields, phone: phone.trim() || null, problem: problem.trim() || null, urgent };
    if (edits.who !== undefined) {
      const name = edits.who.trim() || null;
      if (fields.business_name || !fields.contact_name) out.business_name = name;
      else out.contact_name = name;
    }
    return out;
  }

  async function save(body) {
    setError("");
    setBusy(true);
    try {
      const res = await api.createJob({ text: text.trim() || undefined, fields: buildFields(), parse_mode: mode || "rules", ...body });
      app.toast(res?.toast || "Added. It's on your list.");
      app.changed();
      location.hash = "#/";
    } catch (err) {
      setBusy(false);
      // The text isn't from the open job's customer (attach_mismatch): offer it as a new job instead.
      if (err.code === "attach_mismatch") setNewJobFor(openJob.id);
      if (err.status !== 401) setError(saveErrorText(err));
    }
  }

  /** `picked` is the stage choice just made in the picker sheet, when Add opened it. */
  function add(picked = effectiveChoice) {
    if (!who.trim() && !phone.trim() && !problem.trim()) {
      setError("Add a name, a phone number, or what's wrong.");
      return;
    }
    // A booked job needs its visit day; ask for it rather than letting the save fail.
    if (picked.stage === "scheduled" && !picked.visit_date) {
      setPicker({ stage: "scheduled", thenAdd: true });
      return;
    }
    save({
      stage: picked.stage,
      visit_date: picked.visit_date ?? undefined,
      tech: picked.tech ?? undefined,
      quote_amount: picked.quote_amount ?? undefined,
      quote_sent_at: picked.quote_sent_at ?? undefined,
      snooze_until: callbackDate && keepCallback ? callbackDate : undefined,
    });
  }

  const attach = () => save({ attach_to_job_id: openJob.id, expected_customer_id: customer.id });

  function pickerDone(picked) {
    const thenAdd = picker?.thenAdd;
    setChoice(picked);
    setPicker(null);
    if (thenAdd) add(picked);
  }

  return html`<div class="new-job">
    <${PageHeader} title="Add a job" />
    <label class="visually-hidden" for="quick-text">${PLACEHOLDER}</label>
    <textarea id="quick-text" class="input big-text" rows="5" placeholder=${PLACEHOLDER} value=${text}
      onInput=${(e) => { setText(e.currentTarget.value); setError(""); }}></textarea>

    ${showPreview && html`<section class="panel preview-card" aria-labelledby="preview-h">
      <div class="panel-head">
        <h2 id="preview-h" class="panel-title">Check the details</h2>
        <${ReadBadge} reading=${reading} mode=${mode} />
      </div>
      ${customer && html`<${CustomerBanner} customer=${customer} asking=${askAttach} busy=${busy || reading}
        onAttach=${attach} onNewJob=${() => setNewJobFor(openJob.id)} />`}
      <div class="field">
        <label class="field-label" for="q-who">Who</label>
        <input id="q-who" class="input" value=${who} onInput=${edit("who")} autocomplete="off" />
        ${fields.business_name && fields.contact_name && edits.who === undefined && html`<p class="field-hint">Contact: ${fields.contact_name}</p>`}
      </div>
      <div class="field">
        <label class="field-label" for="q-phone">Phone</label>
        <input id="q-phone" class="input" type="tel" value=${phone} onInput=${edit("phone")} autocomplete="off" />
      </div>
      <div class="field">
        <label class="field-label" for="q-problem">What's wrong</label>
        <textarea id="q-problem" class="input" rows="2" value=${problem} onInput=${edit("problem")}></textarea>
        ${chip && html`<p class="field-hint"><span class="tag">${chip}</span></p>`}
      </div>
      <div class="chip-row" role="group" aria-label="Urgency">
        <button type="button" class=${`toggle-chip ${urgent ? "on urgent" : ""}`} aria-pressed=${urgent ? "true" : "false"}
          onClick=${() => setUrgentEdit(!urgent)}>${urgent ? html`<${Icon} name="check" size=${18} /> URGENT` : "Mark urgent"}</button>
        ${callbackDate && html`<button type="button" class=${`toggle-chip ${keepCallback ? "on" : ""}`} aria-pressed=${keepCallback ? "true" : "false"}
          onClick=${() => setKeepCallback(!keepCallback)}>${`Call back ${dayLabel(callbackDate, now, app.tz)}`}</button>`}
      </div>
      <div class="chip-row" role="radiogroup" aria-label="Where is it at?">
        ${STAGE_CHIPS.map((c) => html`<button type="button" key=${c.id} role="radio" aria-checked=${stage === c.id ? "true" : "false"}
          class=${`toggle-chip ${stage === c.id ? "on" : ""}`} onClick=${() => pickStage(c.id)}>
          ${stageChipLabel(c, effectiveChoice, now, app.tz)}</button>`)}
      </div>
    </section>`}

    ${error && html`<p class="inline-error" role="alert">${error}</p>`}
    ${!(showPreview && askAttach) && html`<button type="button" class="btn btn-primary btn-block" disabled=${busy || pending}
      onClick=${() => add()}>Add to my list</button>`}
    <p class="center-link"><a href="#/new/bulk">Adding a bunch from your notebook? Paste one per line</a></p>
    ${picker && html`<${StagePickerSheet} stage=${picker.stage} onClose=${() => setPicker(null)} onDone=${pickerDone} />`}
  </div>`;
}
