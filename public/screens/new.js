// + New / Quick Add (#/new): one box, a live rules preview in the browser, a background
// server parse ("Reading…" -> "Read by AI" / "Read without AI"), 3 visible fields, stage chips.
import { html, useState, useEffect, useRef } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { money, phoneDisplay } from "/shared/format.js";
import { dayLabel } from "/shared/time.js";
import { useApp, PageHeader, plural } from "../ui/common.js";
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
const FIELD_NAMES = ["contact_name", "business_name", "phone", "email", "address", "equipment", "problem", "details", "urgent"];

// The browser rules parser is optional: if /shared/parse.js is missing or broken, the server parse still fills the card.
let parserPromise = null;
function loadParser() {
  parserPromise ??= import("/shared/parse.js").catch(() => null);
  return parserPromise;
}

/** Normalises either a parseMessage() result or an /api/parse response into {fields, stage_hint, ...}. */
function normaliseParse(p) {
  if (!p) return null;
  const src = p.fields || p;
  const fields = {};
  for (const name of FIELD_NAMES) fields[name] = src[name] ?? null;
  fields.problem ??= src.summary ?? null;
  fields.urgent = Boolean(src.urgent ?? p.urgent);
  return {
    fields,
    stage_hint: p.stage_hint ?? null,
    callback_date: p.callback_date ?? null,
    quote_amount: p.quote_amount ?? null,
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
    const t = setTimeout(async () => {
      const mod = await loadParser();
      if (!mod?.parseMessage) return;
      try {
        const s = app.settings || {};
        setLocal(normaliseParse(mod.parseMessage(trimmed, {
          channel: "manual", owner_phone: s.owner_phone, techs: s.techs || [], now: app.nowIso(), tz: app.tz,
        })));
      } catch { setLocal(null); }
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
        if (mine === seq.current) setServer(normaliseParse(res));
      } catch { /* the local preview stays; the badge falls back to "Read without AI" */ }
      if (mine === seq.current) setReading(false);
    }, SERVER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  return { parse: server || local, reading, mode: server?.mode || (local ? "rules" : null) };
}

function ReadBadge({ reading, mode }) {
  if (reading) return html`<span class="read-badge reading"><span class="spinner small" aria-hidden="true"></span>Reading…</span>`;
  if (!mode) return null;
  return html`<span class="read-badge">${mode === "ai" ? "Read by AI" : "Read without AI"}</span>`;
}

function stageChipLabel(chip, choice, now, tz) {
  if (chip.id === "waiting_yes" && choice.stage === "waiting_yes" && choice.quote_amount) return `Quote sent ${money(choice.quote_amount)}`;
  if (chip.id === "scheduled" && choice.stage === "scheduled" && choice.visit_date) {
    const day = dayLabel(choice.visit_date, now, tz);
    return `Scheduled ${day}${choice.tech ? ` · ${choice.tech}` : ""}`;
  }
  return chip.label;
}

/** Sheet for the two stage chips that need a value: Quote sent (amount) and Scheduled (day, then tech). */
function StagePickerSheet({ stage, onDone, onClose }) {
  const app = useApp();
  const [day, setDay] = useState(null);
  const techs = app.settings?.techs || [];
  let body;
  if (stage === "waiting_yes") {
    body = html`<p class="step-title">How much was the quote?</p>
      <${AmountPad} onSave=${(amount) => onDone({ stage, quote_amount: amount })} />`;
  } else if (!day) {
    body = html`<p class="step-title">Which day?</p>
      <${DayPicker} now=${app.nowIso()} tz=${app.tz} onPick=${(d) => (techs.length ? setDay(d) : onDone({ stage, visit_date: d }))} />`;
  } else {
    body = html`<p class="step-title">Which tech?</p>
      <${TechPicker} techs=${techs} onPick=${(tech) => onDone({ stage, visit_date: day, tech })} />`;
  }
  return html`<${Sheet} titleId="stage-pick-title" onClose=${onClose}>
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
  const { parse, reading, mode } = useLiveParse(text, app);

  useEffect(() => { loadParser(); }, []);

  const fields = parse?.fields || {};
  const whoParsed = fields.business_name || fields.contact_name || "";
  const who = edits.who ?? whoParsed;
  const phone = edits.phone ?? (phoneDisplay(fields.phone) || "");
  const problem = edits.problem ?? fields.problem ?? "";
  const urgent = urgentEdit ?? Boolean(fields.urgent);
  const hinted = STAGE_CHIPS.some((c) => c.id === parse?.stage_hint) ? parse.stage_hint : "new";
  const stage = choice?.stage ?? hinted;
  const effectiveChoice = choice || { stage, quote_amount: parse?.quote_amount ?? null };
  // "call back thursday" proposes a snooze for any starting stage except Scheduled (its date is the visit).
  const callbackDate = stage !== "scheduled" ? parse?.callback_date : null;
  const now = app.nowIso();
  const chip = equipmentChip(fields.equipment);
  const repeat = parse?.matched_customer;
  const showPreview = text.trim().length > 0;

  const edit = (name) => (e) => setEdits({ ...edits, [name]: e.currentTarget.value });
  const pickStage = (id) => {
    if (id === "waiting_yes" || id === "scheduled") setPicker(id);
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

  async function add() {
    if (!who.trim() && !phone.trim() && !problem.trim()) {
      setError("Add a name, a phone number, or what's wrong.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const res = await api.createJob({
        text: text.trim() || undefined,
        fields: buildFields(),
        stage,
        visit_date: effectiveChoice.visit_date ?? undefined,
        tech: effectiveChoice.tech ?? undefined,
        quote_amount: effectiveChoice.quote_amount ?? undefined,
        snooze_until: callbackDate && keepCallback ? callbackDate : undefined,
        parse_mode: mode || "rules",
      });
      app.toast(res?.toast || "Added. It's on your list.");
      app.changed();
      location.hash = "#/";
    } catch (err) {
      setBusy(false);
      if (err.status === 401) return;
      setError(err.status === 400 ? "Add a name, a phone number, or what's wrong." : ERROR_COPY);
    }
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
      ${repeat && html`<p class="repeat-banner">${`Repeat customer: ${repeat.title} - ${repeat.past_jobs} past ${plural(repeat.past_jobs, "job", "jobs")}`}</p>`}
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
    <button type="button" class="btn btn-primary btn-block" disabled=${busy} onClick=${add}>Add to my list</button>
    <p class="center-link"><a href="#/new/bulk">Adding a bunch from your notebook? Paste one per line</a></p>
    ${picker && html`<${StagePickerSheet} stage=${picker} onClose=${() => setPicker(null)}
      onDone=${(c) => { setChoice(c); setPicker(null); }} />`}
  </div>`;
}
