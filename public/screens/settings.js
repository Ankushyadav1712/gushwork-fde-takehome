// Settings (#/settings): each field saves on blur or toggle with PUT /api/settings (§9).
import { html, useState, useEffect } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { phoneDisplay } from "/shared/format.js";
import { useApp, useAsync, ErrorState, Loading, PageHeader, copyText } from "../ui/common.js";
import { ERROR_COPY } from "../ui/constants.js";
import { Icon } from "../ui/icons.js";

const MAX_TECHS = 6;

/** "07:00" -> "7:00am". */
export function hmLabel(hm) {
  const [h, m] = String(hm || "07:00").split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

function TextSetting({ label, name, value, onSave, type = "text", multiline = false, hint }) {
  const shown = value == null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const id = `s-${name}`;
  const props = { id, class: "input", value: draft, onInput: (e) => setDraft(e.currentTarget.value),
    onBlur: () => draft !== shown && onSave({ [name]: draft.trim() }) };
  return html`<div class="field">
    <label class="field-label" for=${id}>${label}</label>
    ${multiline ? html`<textarea ...${props} rows="3"></textarea>` : html`<input ...${props} type=${type} />`}
    ${hint && html`<p class="field-hint">${hint}</p>`}
  </div>`;
}

function Toggle({ label, name, on, onSave, hint }) {
  const id = `s-${name}`;
  return html`<div class="field switch-field">
    <span class="field-label" id=${id}>${label}</span>
    <button type="button" role="switch" aria-checked=${on ? "true" : "false"} aria-labelledby=${id}
      class=${`switch ${on ? "on" : ""}`} onClick=${() => onSave({ [name]: !on })}>
      <span class="switch-text">${on ? "On" : "Off"}</span>
      <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
    </button>
    ${hint && html`<p class="field-hint full">${hint}</p>`}
  </div>`;
}

function TechsEditor({ techs, onSave }) {
  const [rows, setRows] = useState(techs);
  useEffect(() => setRows(techs), [JSON.stringify(techs)]);
  const clean = (list) => list.filter((t) => t.name.trim()).map((t) => ({ name: t.name.trim(), phone: t.phone.trim() || null }));
  const commit = (list) => onSave({ techs: clean(list) });
  const edit = (i, key) => (e) => setRows(rows.map((t, j) => (j === i ? { ...t, [key]: e.currentTarget.value } : t)));
  const remove = (i) => { const next = rows.filter((_, j) => j !== i); setRows(next); commit(next); };
  return html`<div>
    <ul class="tech-list">
      ${rows.map((t, i) => html`<li key=${i} class="tech-row">
        <label class="visually-hidden" for=${`tech-name-${i}`}>Tech ${i + 1} name</label>
        <input id=${`tech-name-${i}`} class="input" placeholder="Name" value=${t.name} onInput=${edit(i, "name")} onBlur=${() => commit(rows)} />
        <label class="visually-hidden" for=${`tech-phone-${i}`}>Tech ${i + 1} cell</label>
        <input id=${`tech-phone-${i}`} class="input" type="tel" placeholder="Cell" value=${t.phone} onInput=${edit(i, "phone")} onBlur=${() => commit(rows)} />
        <button type="button" class="icon-btn" aria-label=${`Remove ${t.name || "tech"}`} onClick=${() => remove(i)}><${Icon} name="close" /></button>
      </li>`)}
    </ul>
    ${rows.length < MAX_TECHS && html`<button type="button" class="btn btn-secondary btn-block"
      onClick=${() => setRows([...rows, { name: "", phone: "" }])}><${Icon} name="plus" size=${20} /> Add a tech</button>`}
  </div>`;
}

function CopyRow({ label, value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => { setCopied(await copyText(value)); setTimeout(() => setCopied(false), 2000); };
  return html`<div class="copy-row">
    <div class="copy-text"><p class="field-label">${label}</p><p class="mono">${value}</p></div>
    <button type="button" class="icon-btn outline" aria-label=${`Copy ${label}`} onClick=${copy}><${Icon} name=${copied ? "check" : "copy"} /></button>
  </div>`;
}

function connectionLines({ ai, ai_model: model, sms }) {
  return {
    reading: ai === "claude" ? `AI (${model})` : "Rules only",
    texts: sms === "twilio" ? "Twilio" : "Simulated (outbox)",
  };
}

const WEBHOOK_LABELS = { sms: "Texts (Twilio)", call: "Calls (Twilio)", email: "Email (Postmark / Mailgun)", form: "Website form" };

export function SettingsScreen() {
  const app = useApp();
  const { data, error, reload, setData } = useAsync(() => api.getSettings(), []);
  const [status, setStatus] = useState("");

  if (!data) {
    return html`<div><${PageHeader} title="Settings" back="#/jobs" />
      ${error ? html`<${ErrorState} error=${error} onRetry=${reload} />` : html`<${Loading} />`}</div>`;
  }
  const s = data;

  async function save(partial) {
    setStatus("Saving…");
    try {
      const next = await api.saveSettings(partial);
      setData(next || { ...data, ...partial });
      app.setSettings(next || { ...data, ...partial });
      setStatus("Saved");
    } catch (err) {
      setStatus(err.status === 0 ? ERROR_COPY : err.status === 400 ? "That didn't look right, so it wasn't saved." : "Couldn't save that change.");
    }
  }
  const lines = connectionLines(data.integrations);
  const hooks = data.webhook_urls || {};
  const techs = (s.techs || []).map((t) => ({ name: t.name || "", phone: phoneDisplay(t.phone) || t.phone || "" }));

  return html`<div class="settings">
    <${PageHeader} title="Settings" back="#/jobs"><span class="save-state" aria-live="polite">${status}</span></${PageHeader}>

    <section class="panel" aria-labelledby="you-h">
      <h2 id="you-h" class="panel-title">You</h2>
      <${TextSetting} label="Your name" name="owner_name" value=${s.owner_name} onSave=${save} />
      <${TextSetting} label="Company" name="company_name" value=${s.company_name} onSave=${save} />
      <${TextSetting} label="Your cell" name="owner_phone" type="tel" value=${phoneDisplay(s.owner_phone) || s.owner_phone} onSave=${save} />
      <${TextSetting} label="Your email" name="owner_email" type="email" value=${s.owner_email} onSave=${save}
        hint="So emails you send or forward aren't mistaken for a customer's." />
    </section>

    <section class="panel" aria-labelledby="techs-h">
      <h2 id="techs-h" class="panel-title">Techs</h2>
      <${TechsEditor} techs=${techs} onSave=${save} />
    </section>

    <section class="panel" aria-labelledby="texts-h">
      <h2 id="texts-h" class="panel-title">Texts to you</h2>
      <${TextSetting} label="Morning text time" name="digest_time" type="time" value=${s.digest_time} onSave=${save} />
      <${Toggle} label="Friday 3pm before-the-weekend text" name="friday_sweep" on=${Boolean(s.friday_sweep)} onSave=${save} />
      <${Toggle} label="Weekend texts" name="weekend_digest" on=${Boolean(s.weekend_digest)} onSave=${save}
        hint="Only when someone is waiting on a call back." />
      <a class="btn btn-secondary btn-block" href="#/digest">${`Preview my ${hmLabel(s.digest_time)} text`}</a>
    </section>

    <section class="panel" aria-labelledby="ack-h">
      <h2 id="ack-h" class="panel-title">Auto-reply to new callers</h2>
      <${Toggle} label="Send an automatic reply" name="auto_ack_enabled" on=${Boolean(s.auto_ack_enabled)} onSave=${save}
        hint="Off unless you turn it on. Goes to new texters, missed callers and web forms with a phone." />
      <${TextSetting} label="Reply text" name="auto_ack_text" value=${s.auto_ack_text} multiline onSave=${save}
        hint="{company} becomes your company name." />
    </section>

    <section class="panel" aria-labelledby="husband-h">
      <h2 id="husband-h" class="panel-title">${`${s.husband_name || "Husband"}'s link`}</h2>
      <${TextSetting} label="Name" name="husband_name" value=${s.husband_name} onSave=${save} />
      <${TextSetting} label="Cell" name="husband_phone" type="tel" value=${phoneDisplay(s.husband_phone) || s.husband_phone} onSave=${save} />
      <${CopyRow} label="Read-only numbers link" value=${data.readonly_url} />
      <button type="button" class="btn btn-secondary btn-block" onClick=${() => save({ regenerate_readonly_key: true })}>
        Make a new link (the old one stops working)</button>
    </section>

    <details class="panel setup">
      <summary class="setup-summary"><span class="panel-title">For whoever sets this up</span>
        <${Icon} name="chevron" size=${20} className="setup-chev" /></summary>
      <h2 class="field-label setup-h">Connections</h2>
      <dl class="facts">
        <div><dt>Reading messages</dt><dd>${lines.reading}</dd></div>
        <div><dt>Texts</dt><dd>${lines.texts}</dd></div>
        <div><dt>"New Job" number</dt><dd>${phoneDisplay(data.forwarding_number) || data.forwarding_number || "Not set up yet"}</dd></div>
      </dl>
      ${Object.entries(hooks).map(([k, url]) => html`<${CopyRow} key=${k} label=${WEBHOOK_LABELS[k] || k} value=${url} />`)}
    </details>

    <section class="panel" aria-labelledby="export-h">
      <h2 id="export-h" class="panel-title">Export</h2>
      <a class="btn btn-secondary btn-block" href=${api.exportCsvUrl()} download="callback-jobs.csv">Export jobs as CSV</a>
    </section>
  </div>`;
}
