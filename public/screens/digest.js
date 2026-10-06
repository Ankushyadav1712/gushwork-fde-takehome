// Digest preview (#/digest): the exact morning text, the Friday sweep, and the last 20 outbox items (§9, §11).
import { html, useState } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { useApp, useAsync, ErrorState, Loading, PageHeader, Linkified } from "../ui/common.js";
import { ERROR_COPY } from "../ui/constants.js";
import { hmLabel } from "./settings.js";

const OUTBOX_LIMIT = 20;

const KIND_LABELS = {
  digest: "Morning text",
  friday_sweep: "Before the weekend",
  nag: "Reminder",
  auto_ack: "Auto-reply",
  husband_summary: "Numbers",
  manual: "Sent from preview",
};
const STATUS_LABELS = { simulated: "Simulated", sent: "Sent", failed: "Failed" };

/** Toast after Send now, by the outbox row's final status (§11). */
const SEND_TOASTS = {
  sent: "Sent to your phone.",
  simulated: "Saved to the outbox (texts are simulated here).",
  failed: "That text didn't go through. Check Settings.",
};

/** The weekend digest shares the `digest` kind; its body starts "Weekend check" (§11). */
function kindLabel(item) {
  if (item.kind === "digest" && String(item.body || "").startsWith("Weekend check")) return "Weekend text";
  return KIND_LABELS[item.kind] || item.kind;
}

function Bubble({ text }) {
  return html`<div class="bubble"><${Linkified} text=${text} /></div>`;
}

/** Her own list shows a pill only when a text didn't send; Demo controls (`allStatuses`) show every status. */
function StatusPill({ status, allStatuses }) {
  if (allStatuses) return html`<span class=${`status status-${status}`}>${STATUS_LABELS[status] || status}</span>`;
  return status === "failed" ? html`<span class="status status-failed">Didn't send</span>` : null;
}

export function OutboxList({ items, allStatuses = false }) {
  if (!items?.length) return html`<p class="empty-note">Nothing sent yet.</p>`;
  return html`<ol class="outbox">
    ${items.map((m) => html`<li key=${m.id} class="outbox-item">
      <p class="outbox-meta">
        <span class="outbox-kind">${kindLabel(m)}</span>
        <span class="num">${m.at_label}</span>
        <${StatusPill} status=${m.status} allStatuses=${allStatuses} />
      </p>
      <${Bubble} text=${m.body} />
      ${m.to_name && html`<p class="muted small">To ${m.to_name}</p>`}
    </li>`)}
  </ol>`;
}

export function DigestScreen() {
  const app = useApp();
  const preview = useAsync(() => api.getDigestPreview(), []);
  const outbox = useAsync(() => api.getOutbox(OUTBOX_LIMIT), []);
  const [sending, setSending] = useState(false);
  const time = hmLabel(app.settings?.digest_time);

  async function sendNow() {
    setSending(true);
    try {
      const res = await api.sendDigestNow();
      app.toast(SEND_TOASTS[res?.status] || "Saved to the outbox.");
      outbox.reload({ quiet: true });
    } catch (err) {
      // 400 carries the reason in her words ("Add your cell in Settings first.").
      if (err.status !== 401) app.toast(err.status === 400 ? err.message : ERROR_COPY);
    }
    setSending(false);
  }

  const d = preview.data;
  return html`<div class="digest">
    <${PageHeader} title="Texts to you" back="#/settings" />
    ${!d && (preview.error ? html`<${ErrorState} error=${preview.error} onRetry=${preview.reload} />` : html`<${Loading} />`)}
    ${d && html`<section class="panel" aria-labelledby="dg-h">
      <h2 id="dg-h" class="panel-title">${`Your ${time} text`}</h2>
      <${Bubble} text=${d.digest?.body} />
      ${d.digest && !d.digest.send && html`<p class="muted small">Today this one wouldn't go out: nobody's waiting on a call back.</p>`}
      <button type="button" class="btn btn-primary btn-block" disabled=${sending} onClick=${sendNow}>Send now</button>
    </section>`}
    ${d?.sweep && html`<section class="panel" aria-labelledby="sw-h">
      <h2 id="sw-h" class="panel-title">Before the weekend (Fridays 3:00pm)</h2>
      <${Bubble} text=${d.sweep} />
    </section>`}
    <section aria-labelledby="ob-h">
      <h2 id="ob-h" class="divider">Last 20 texts</h2>
      ${outbox.data ? html`<${OutboxList} items=${outbox.data.items} />`
        : outbox.error ? html`<${ErrorState} error=${outbox.error} onRetry=${outbox.reload} />` : html`<${Loading} />`}
    </section>
  </div>`;
}
