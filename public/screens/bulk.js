// Brain dump (#/new/bulk): paste the notebook, check one row per line, add them all (§9, D23).
import { html, useState } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { localDate, atLocal, addDays } from "/shared/time.js";
import { normalizePhone, phoneDisplay, plural } from "/shared/format.js";
import { STAGES } from "/shared/stages.js";
import { useApp, PageHeader } from "../ui/common.js";
import { ERROR_COPY } from "../ui/constants.js";
import { Icon } from "../ui/icons.js";

const PLACEHOLDER = "One job per line, like: Joe's Diner walk-in, quoted 1800 tues, waiting";
const ROW_STAGES = STAGES.filter((s) => s.id !== "lost");
const QUOTE_SENT_HM = "12:00";

function whoOf(fields = {}) {
  return fields.business_name || fields.contact_name || fields.phone || "";
}

/** The phone as she typed it: shown formatted once it is a full number, saved as E.164 (or as typed until then). */
function PhoneField({ id, phone, onSave }) {
  const [draft, setDraft] = useState(phoneDisplay(phone) || "");
  const commit = (value) => {
    setDraft(value);
    onSave(normalizePhone(value) || value.trim());
  };
  return html`<div class="field">
    <label class="field-label" for=${id}>Phone</label>
    <input id=${id} class="input" type="tel" value=${draft} autocomplete="off"
      onInput=${(e) => commit(e.currentTarget.value)}
      onBlur=${(e) => setDraft(phoneDisplay(normalizePhone(e.currentTarget.value)) || e.currentTarget.value)} />
  </div>`;
}

function BulkRow({ row, index, techs, now, tz, onChange, onRemove }) {
  const id = (name) => `row-${index}-${name}`;
  const set = (patch) => onChange({ ...row, ...patch });
  const setField = (name, value) => set({ fields: { ...row.fields, [name]: value || null } });
  const setWho = (value) => setField(row.fields?.business_name || !row.fields?.contact_name ? "business_name" : "contact_name", value);
  const sentYmd = row.quote_sent_at ? localDate(row.quote_sent_at, tz) : "";
  const showAmount = row.stage === "waiting_yes" || row.stage === "done";
  const urgent = Boolean(row.fields?.urgent);

  return html`<li class="panel bulk-row">
    <div class="bulk-row-head">
      <p class="bulk-line">${row.line}</p>
      <button type="button" class="icon-btn" aria-label=${`Remove line ${index + 1}`} onClick=${onRemove}><${Icon} name="close" /></button>
    </div>
    <div class="field">
      <label class="field-label" for=${id("who")}>Who</label>
      <input id=${id("who")} class="input" value=${whoOf(row.fields)} onInput=${(e) => setWho(e.currentTarget.value)} />
    </div>
    <${PhoneField} id=${id("phone")} phone=${row.fields?.phone} onSave=${(value) => setField("phone", value)} />
    <div class="field">
      <label class="field-label" for=${id("problem")}>What's wrong</label>
      <input id=${id("problem")} class="input" value=${row.fields?.problem || ""} onInput=${(e) => setField("problem", e.currentTarget.value)} />
    </div>
    <div class="chip-row">
      <button type="button" class=${`toggle-chip ${urgent ? "on urgent" : ""}`} aria-pressed=${urgent ? "true" : "false"}
        onClick=${() => set({ fields: { ...row.fields, urgent: !urgent } })}>
        ${urgent ? html`<${Icon} name="check" size=${18} /> URGENT` : "Mark urgent"}</button>
    </div>
    <div class="field">
      <label class="field-label" for=${id("stage")}>Where it's at</label>
      <select id=${id("stage")} class="input" value=${row.stage} onChange=${(e) => set({ stage: e.currentTarget.value })}>
        ${ROW_STAGES.map((s) => html`<option key=${s.id} value=${s.id}>${s.label}</option>`)}
      </select>
    </div>
    <div class="field-pair">
      ${showAmount && html`<div class="field">
        <label class="field-label" for=${id("amount")}>Amount $</label>
        <input id=${id("amount")} class="input num" inputmode="numeric" value=${row.quote_amount ?? ""}
          onInput=${(e) => { const d = e.currentTarget.value.replace(/\D/g, ""); set({ quote_amount: d ? Number(d) : null }); }} />
      </div>`}
      ${row.stage === "waiting_yes" && html`<div class="field">
        <label class="field-label" for=${id("sent")}>Quote sent on</label>
        <input id=${id("sent")} class="input" type="date" value=${sentYmd}
          onChange=${(e) => set({ quote_sent_at: e.currentTarget.value ? atLocal(e.currentTarget.value, QUOTE_SENT_HM, tz) : null })} />
      </div>`}
    </div>
    ${row.stage === "new" && html`<div class="field">
      <label class="field-label" for=${id("callback")}>Call back on (optional)</label>
      <input id=${id("callback")} class="input" type="date" min=${addDays(localDate(now, tz), 1)} value=${row.callback_date || ""}
        onChange=${(e) => set({ callback_date: e.currentTarget.value || null })} />
    </div>`}
    ${row.stage === "scheduled" && html`<div class="field-pair">
      <div class="field">
        <label class="field-label" for=${id("visit")}>Visit date</label>
        <input id=${id("visit")} class="input" type="date" value=${row.visit_date || ""} onChange=${(e) => set({ visit_date: e.currentTarget.value || null })} />
      </div>
      <div class="field">
        <label class="field-label" for=${id("tech")}>Tech</label>
        <select id=${id("tech")} class="input" value=${row.tech || ""} onChange=${(e) => set({ tech: e.currentTarget.value || null })}>
          <option value="">No tech</option>
          ${techs.map((t) => html`<option key=${t.name} value=${t.name}>${t.name}</option>`)}
        </select>
      </div>
    </div>`}
    ${row.matched_customer && html`<p class="field-hint">Repeat customer: ${row.matched_customer.title}</p>`}
  </li>`;
}

export function BulkScreen() {
  const app = useApp();
  const [text, setText] = useState("");
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const techs = app.settings?.techs || [];

  async function read() {
    if (!text.trim()) { setError("Paste or type at least one line."); return; }
    setBusy(true);
    setError("");
    try {
      const res = await api.parseBulk(text);
      setRows(res?.rows || []);
    } catch (err) {
      if (err.status !== 401) setError(ERROR_COPY);
    }
    setBusy(false);
  }

  async function addAll() {
    setBusy(true);
    setError("");
    try {
      const res = await api.createBulk(rows);
      const n = res?.created?.length ?? rows.length;
      app.toast(`Added ${plural(n, "job", "jobs")}. They're on your list.`);
      app.changed();
      location.hash = "#/";
    } catch (err) {
      setBusy(false);
      if (err.status !== 401) setError(err.status === 400 ? "Some lines need a name, a phone number, or what's wrong." : ERROR_COPY);
    }
  }

  const updateRow = (i) => (row) => setRows(rows.map((r, j) => (j === i ? row : r)));
  const removeRow = (i) => () => setRows(rows.filter((_, j) => j !== i));

  return html`<div class="bulk">
    <${PageHeader} title="Bring over your notebook" back="#/new" />
    <p class="lede">Each line becomes a job. Jobs where the next move is yours show up on today's list.</p>
    <label class="visually-hidden" for="bulk-text">Notebook lines</label>
    <textarea id="bulk-text" class="input big-text" rows="7" placeholder=${PLACEHOLDER} value=${text}
      onInput=${(e) => setText(e.currentTarget.value)}></textarea>
    <button type="button" class=${`btn btn-block ${rows ? "btn-secondary" : "btn-primary"}`} disabled=${busy} onClick=${read}>
      ${rows ? "Read them again" : "Read them"}
    </button>
    ${error && html`<p class="inline-error" role="alert">${error}</p>`}
    ${rows && html`<section aria-labelledby="rows-h">
      <h2 class="divider" id="rows-h">${`Check these (${rows.length})`}</h2>
      ${rows.length === 0 && html`<p class="empty-note">No lines to add.</p>`}
      <ol class="bulk-rows">
        ${rows.map((row, i) => html`<${BulkRow} key=${`${i}-${row.line}`} row=${row} index=${i} techs=${techs} now=${app.nowIso()} tz=${app.tz}
          onChange=${updateRow(i)} onRemove=${removeRow(i)} />`)}
      </ol>
      ${rows.length > 0 && html`<button type="button" class="btn btn-primary btn-block" disabled=${busy} onClick=${addAll}>
        ${`Add ${plural(rows.length, "job", "jobs")}`}</button>`}
    </section>`}
  </div>`;
}
