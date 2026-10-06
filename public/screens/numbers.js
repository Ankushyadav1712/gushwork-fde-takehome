// Numbers (#/numbers): plain tiles for her husband, no charts (§10), plus "Text this to Rick" and Copy.
import { html, useState } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { numbersTiles, NUMBERS_WINDOW_NOTE } from "/shared/stats.js";
import { useApp, useAsync, ErrorState, Loading, PageHeader, copyText, smsHref } from "../ui/common.js";
import { Icon } from "../ui/icons.js";

function Tile({ label, value, detail, wide }) {
  return html`<div class=${`tile ${wide ? "wide" : ""}`}>
    <p class="tile-label">${label}</p>
    <p class="tile-value num">${value}</p>
    ${detail && html`<p class="tile-detail num">${detail}</p>`}
  </div>`;
}

export function NumbersScreen() {
  const app = useApp();
  const { data, error, reload } = useAsync(() => api.getNumbers(), []);
  const [copied, setCopied] = useState(false);
  const husband = app.settings?.husband_name;
  const husbandPhone = app.settings?.husband_phone || "";

  if (!data) {
    return html`<div><${PageHeader} title="Numbers" back="#/jobs" />
      ${error ? html`<${ErrorState} error=${error} onRetry=${reload} />` : html`<${Loading} />`}</div>`;
  }
  const leak = data.leak_count > 0;
  const copy = async () => {
    setCopied(await copyText(data.summary_text || ""));
    setTimeout(() => setCopied(false), 2500);
  };

  return html`<div class="numbers">
    <${PageHeader} title="Numbers" back="#/jobs" />
    <p class="lede">${NUMBERS_WINDOW_NOTE}</p>
    <div class="tiles">
      ${numbersTiles(data).map((t) => html`<${Tile} key=${t.key} ...${t} />`)}
    </div>
    <p class=${`leak-line ${leak ? "bad" : "good"}`}>
      <${Icon} name=${leak ? "alert" : "check"} size=${20} />
      ${data.leak_text}
    </p>
    <section class="panel" aria-labelledby="sum-h">
      <h2 id="sum-h" class="panel-title">${husband ? `What ${husband} gets` : "The summary"}</h2>
      <pre class="message-preview">${data.summary_text}</pre>
      <div class="stack">
        <a class="btn btn-primary" href=${smsHref(husbandPhone, data.summary_text)}>
          <${Icon} name="message" size=${20} /> ${husband ? `Text this to ${husband}` : "Text this"}</a>
        <button type="button" class="btn btn-secondary" onClick=${copy}>
          <${Icon} name=${copied ? "check" : "copy"} size=${20} /> ${copied ? "Copied" : "Copy"}</button>
      </div>
    </section>
  </div>`;
}
