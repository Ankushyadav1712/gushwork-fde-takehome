// Demo controls (#/sim, DEMO=1 only): clock, inbound presets, custom message, outbox, inbound log, health, reset.
import { html, useState } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { shortDateLabel, timeLabel, dayTimeLabel, localDate, localHM, atLocal } from "/shared/time.js";
import { phoneDisplay, trunc } from "/shared/format.js";
import { useApp, useAsync, ErrorState, Loading, PageHeader } from "../ui/common.js";
import { ERROR_COPY } from "../ui/constants.js";
import { OutboxList } from "./digest.js";

const CLOCK_PRESETS = [
  { id: "real", label: "Real time" },
  { id: "plus_30m", label: "+30 min" },
  { id: "plus_2h", label: "+2 hours" },
  { id: "plus_1d", label: "+1 day" },
  { id: "next_mon_0700", label: "Next Mon 7:00am" },
  { id: "next_fri_1500", label: "Next Fri 3:00pm" },
];

const INBOUND_PRESETS = [
  { id: "rosa_yes", label: "Rosa texts \"yes go ahead\"", note: "Attaches to her quote; suggests Mark as yes" },
  { id: "lucia_repeat", label: "Lucia's Market texts again", note: "New job, Repeat - 1 past job" },
  { id: "web_form_tony", label: "Web form: Tony's Bistro", note: "Freezer at 10F and rising; urgent" },
  { id: "voicemail_carla", label: "Voicemail: Westside Diner", note: "Ice machine leaking; urgent" },
  { id: "forward_midway", label: "You forward Midway Meats' text", note: "Matched by business name" },
  { id: "spam_call", label: "Answered call, 8 seconds", note: "Ignored" },
  { id: "answered_call", label: "Answered call, 2 minutes", note: "New job: what was it about?" },
];

const RESULT_TEXT = {
  created_job: "Created a new job.",
  attached: "Added to their open job.",
  duplicate: "Already had this one, so nothing new was added.",
  ignored: "Ignored (nothing to follow up).",
  blocked: "Blocked number, ignored.",
  error: "Couldn't read it, so a fallback job was made.",
};

const clockLabel = (iso, tz) => `${shortDateLabel(iso, tz)}, ${timeLabel(iso, tz)}`;

function ClockPanel({ health, tz, onMoved }) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const now = health?.now;
  async function move(body) {
    setBusy(true);
    try {
      const res = await api.simClock(body);
      onMoved(res);
    } catch (err) {
      if (err.status !== 401) onMoved(null, err);
    }
    setBusy(false);
  }
  const setCustomTime = () => {
    const [ymd, hm] = custom.split("T");
    if (ymd && hm) move({ set: atLocal(ymd, hm.slice(0, 5), tz) });
  };
  return html`<section class="panel" aria-labelledby="clock-h">
    <h2 id="clock-h" class="panel-title">Clock</h2>
    <p class="clock-now num">${now ? clockLabel(now, tz) : "…"}</p>
    <p class="muted small">${health?.clock_offset_ms ? "Demo time (shifted)" : "Real time"}</p>
    <div class="choice-grid">
      ${CLOCK_PRESETS.map((p) => html`<button type="button" key=${p.id} class="btn btn-secondary" disabled=${busy}
        onClick=${() => move({ preset: p.id })}>${p.label}</button>`)}
    </div>
    <div class="field">
      <label class="field-label" for="clock-set">Set…</label>
      <div class="field-stack">
        <input id="clock-set" class="input" type="datetime-local" value=${custom || (now ? `${localDate(now, tz)}T${localHM(now, tz)}` : "")}
          onInput=${(e) => setCustom(e.currentTarget.value)} />
        <button type="button" class="btn btn-secondary" disabled=${busy || !custom} onClick=${setCustomTime}>Set</button>
      </div>
    </div>
  </section>`;
}

function PresetsPanel({ onResult }) {
  const [busy, setBusy] = useState(null);
  async function send(id) {
    setBusy(id);
    try {
      onResult(await api.simInbound({ preset: id }));
    } catch (err) {
      if (err.status !== 401) onResult(null, err);
    }
    setBusy(null);
  }
  return html`<section class="panel" aria-labelledby="pre-h">
    <h2 id="pre-h" class="panel-title">Inbound presets</h2>
    <ul class="preset-list">
      ${INBOUND_PRESETS.map((p) => html`<li key=${p.id}>
        <button type="button" class="preset" disabled=${busy === p.id} onClick=${() => send(p.id)}>
          <span class="preset-label">${p.label}</span><span class="preset-note">${p.note}</span>
        </button>
      </li>`)}
    </ul>
  </section>`;
}

function CustomInbound({ onResult }) {
  const [form, setForm] = useState({ channel: "sms", from: "", body: "", call_status: "missed", duration_s: "", format: "generic" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });
  async function send(e) {
    e.preventDefault();
    const body = { channel: form.channel, from: form.from, body: form.body, format: form.format };
    if (form.channel === "call") {
      body.call_status = form.call_status;
      if (form.duration_s) body.duration_s = Number(form.duration_s);
    }
    try {
      onResult(await api.simInbound(body));
    } catch (err) {
      if (err.status !== 401) onResult(null, err);
    }
  }
  return html`<form class="panel" aria-labelledby="custom-h" onSubmit=${send}>
    <h2 id="custom-h" class="panel-title">Custom message</h2>
    <div class="field-pair">
      <div class="field"><label class="field-label" for="c-channel">Channel</label>
        <select id="c-channel" class="input" value=${form.channel} onChange=${set("channel")}>
          <option value="sms">Text</option><option value="call">Call</option><option value="email">Email</option><option value="form">Web form</option>
        </select></div>
      <div class="field"><label class="field-label" for="c-format">Format</label>
        <select id="c-format" class="input" value=${form.format} onChange=${set("format")}>
          <option value="generic">Generic JSON</option><option value="twilio">Twilio</option><option value="postmark">Postmark</option><option value="raw">Raw email</option>
        </select></div>
    </div>
    <div class="field"><label class="field-label" for="c-from">From (phone or email)</label>
      <input id="c-from" class="input" value=${form.from} onInput=${set("from")} placeholder="(312) 555-0199" /></div>
    ${form.channel === "call" && html`<div class="field-pair">
      <div class="field"><label class="field-label" for="c-status">Call</label>
        <select id="c-status" class="input" value=${form.call_status} onChange=${set("call_status")}>
          <option value="missed">Missed</option><option value="voicemail">Voicemail</option><option value="answered">Answered</option>
        </select></div>
      <div class="field"><label class="field-label" for="c-dur">Seconds</label>
        <input id="c-dur" class="input" inputmode="numeric" value=${form.duration_s} onInput=${set("duration_s")} /></div>
    </div>`}
    <div class="field"><label class="field-label" for="c-body">Message</label>
      <textarea id="c-body" class="input" rows="3" value=${form.body} onInput=${set("body")}></textarea></div>
    <button type="submit" class="btn btn-primary btn-block">Send it in</button>
  </form>`;
}

function InboundLog({ items, now, tz }) {
  if (!items?.length) return html`<p class="empty-note">No messages yet.</p>`;
  return html`<ol class="inbound-log">
    ${items.map((m) => html`<li key=${m.id} class="log-item">
      <p class="outbox-meta">
        <span class="outbox-kind">${m.channel}</span>
        <span class="num">${m.received_at ? dayTimeLabel(m.received_at, now, tz) : ""}</span>
        <span class=${`status status-${m.status}`}>${m.status}</span>
      </p>
      <p class="log-from">${phoneDisplay(m.from_phone) || m.from_email || "Unknown sender"}${m.subject ? ` · ${m.subject}` : ""}</p>
      ${m.body && html`<p class="log-body">${trunc(m.body, 140)}</p>`}
      ${m.job_id && html`<a class="quiet-link" href=${`#/job/${m.job_id}`}>Open job ${m.job_id}</a>`}
    </li>`)}
  </ol>`;
}

function ResetPanel({ onReset }) {
  const [armed, setArmed] = useState(false);
  return html`<section class="panel" aria-labelledby="reset-h">
    <h2 id="reset-h" class="panel-title">Reset demo</h2>
    <p class="muted small">Wipes everything and replays the Friday-to-Monday seed. Do this right before recording.</p>
    ${armed
      ? html`<div class="stack">
          <button type="button" class="btn btn-danger" onClick=${() => { setArmed(false); onReset(); }}>Yes, reset everything</button>
          <button type="button" class="btn btn-secondary" onClick=${() => setArmed(false)}>Cancel</button>
        </div>`
      : html`<button type="button" class="btn btn-secondary btn-block" onClick=${() => setArmed(true)}>Reset demo</button>`}
  </section>`;
}

export function SimScreen() {
  const app = useApp();
  const outbox = useAsync(() => api.getOutbox(50), [app.version]);
  const messages = useAsync(() => api.getMessages(50), [app.version]);
  const [lastResult, setLastResult] = useState(null);

  if (app.health && !app.demo) {
    return html`<div><${PageHeader} title="Demo controls" back="#/" /><p class="empty-note">Demo controls are off on this server.</p></div>`;
  }

  const refreshAll = async () => {
    await app.reloadHealth();
    app.changed();
  };
  const onMoved = async (res, err) => {
    if (err) { app.toast(ERROR_COPY); return; }
    const sent = res?.sent?.length || 0;
    app.toast(`Clock: ${clockLabel(res.now, app.tz)}. ${sent} ${sent === 1 ? "text" : "texts"} sent.`);
    await refreshAll();
  };
  const onResult = async (res, err) => {
    if (err) { app.toast(ERROR_COPY); return; }
    setLastResult(res);
    app.toast(RESULT_TEXT[res?.status] || "Sent in.");
    await refreshAll();
  };
  const onReset = async () => {
    try {
      await api.simReset();
      app.toast("Demo reset. Clock is back to Monday 7:00am.");
      setLastResult(null);
      await refreshAll();
    } catch (err) {
      if (err.status !== 401) app.toast(ERROR_COPY);
    }
  };
  const health = app.health;
  const now = health?.now || app.nowIso();

  return html`<div class="sim">
    <${PageHeader} title="Demo controls" back="#/" />
    <p class="demo-banner" role="note">Demo controls - not part of the product</p>
    <${ClockPanel} health=${health} tz=${app.tz} onMoved=${onMoved} />
    <${PresetsPanel} onResult=${onResult} />
    ${lastResult && html`<p class="result-line" role="status">${RESULT_TEXT[lastResult.status] || lastResult.status}
      ${lastResult.job_id && html` <a href=${`#/job/${lastResult.job_id}`}>Open job ${lastResult.job_id}</a>`}</p>`}
    <${CustomInbound} onResult=${onResult} />
    <section aria-labelledby="sim-ob-h">
      <h2 id="sim-ob-h" class="divider">Outbox</h2>
      ${outbox.data ? html`<${OutboxList} items=${outbox.data.items} />`
        : outbox.error ? html`<${ErrorState} error=${outbox.error} onRetry=${outbox.reload} />` : html`<${Loading} />`}
    </section>
    <section aria-labelledby="sim-in-h">
      <h2 id="sim-in-h" class="divider">Inbound log</h2>
      ${messages.data ? html`<${InboundLog} items=${messages.data.items} now=${now} tz=${app.tz} />`
        : messages.error ? html`<${ErrorState} error=${messages.error} onRetry=${messages.reload} />` : html`<${Loading} />`}
    </section>
    <section class="panel" aria-labelledby="health-h">
      <h2 id="health-h" class="panel-title">Health</h2>
      <dl class="facts">
        <div><dt>Unlinked messages</dt><dd class="num">${health?.unlinked_messages ?? "…"}</dd></div>
        <div><dt>AI mode</dt><dd>${health?.ai === "claude" ? `AI (${health.ai_model})` : "Rules only"}</dd></div>
        <div><dt>SMS mode</dt><dd>${health?.sms === "twilio" ? "Twilio" : "Simulated (outbox)"}</dd></div>
      </dl>
    </section>
    <${ResetPanel} onReset=${onReset} />
  </div>`;
}
