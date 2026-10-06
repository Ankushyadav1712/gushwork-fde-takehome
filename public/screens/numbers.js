// Numbers (#/numbers): plain tiles for her husband, no charts (§10), plus "Text this to Rick" and Copy.
import { html, useState } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { money } from "/shared/format.js";
import { useApp, useAsync, ErrorState, Loading, PageHeader, copyText, smsHref, plural } from "../ui/common.js";
import { OPEN_STAGES, stageShort } from "../ui/constants.js";
import { Icon } from "../ui/icons.js";

/** No-break spaces keep a phrase on one line ("Said yes 2", "(2 without a $)"). */
const keep = (s) => s.replace(/ /g, "\u00a0");

function Tile({ label, value, detail, wide = false }) {
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
  const husband = app.settings?.husband_name || "Rick";
  const husbandPhone = app.settings?.husband_phone || "";

  if (!data) {
    return html`<div><${PageHeader} title="Numbers" back="#/jobs" />
      ${error ? html`<${ErrorState} error=${error} onRetry=${reload} />` : html`<${Loading} />`}</div>`;
  }
  const n = data;
  const stages = OPEN_STAGES.map((id) => keep(`${stageShort(id)} ${n.stage_counts?.[id] ?? 0}`)).join(" · ");
  const leak = n.leak_count > 0;
  const copy = async () => {
    setCopied(await copyText(data.summary_text || ""));
    setTimeout(() => setCopied(false), 2500);
  };

  return html`<div class="numbers">
    <${PageHeader} title="Numbers" back="#/jobs" />
    <p class="lede">Rolling windows: the last 7 or 30 days up to now.</p>
    <div class="tiles">
      <${Tile} wide label="Open jobs" value=${n.open_count} detail=${stages} />
      <${Tile} wide label="Waiting on a yes" value=${money(n.waiting_yes_total) || "$0"}
        detail=${`${n.waiting_yes_count} ${plural(n.waiting_yes_count, "quote", "quotes")}`} />
      <${Tile} label="Won, last 30 days" value=${`${n.won_30d_count} ${plural(n.won_30d_count, "job", "jobs")}`}
        detail=${`${money(n.won_30d_total) || "$0"}${n.won_30d_no_amount ? ` ${keep(`(${n.won_30d_no_amount} without a $)`)}` : ""}`} />
      <${Tile} label="Done, last 7 days" value=${n.done_7d_count} />
      <${Tile} label="Lost, last 30 days" value=${n.lost_30d_count}
        detail=${n.lost_30d_count ? `${n.lost_30d_went_elsewhere} went with someone else` : null} />
      <${Tile} label="New, last 7 days" value=${n.new_7d_count} />
    </div>
    <p class=${`leak-line ${leak ? "bad" : "good"}`}>
      <${Icon} name=${leak ? "alert" : "check"} size=${20} />
      ${n.leak_text || (leak ? `Waiting over a day for a first call: ${n.leak_count}` : "Nobody waiting over a day for a first call")}
    </p>
    <section class="panel" aria-labelledby="sum-h">
      <h2 id="sum-h" class="panel-title">${`What ${husband} gets`}</h2>
      <pre class="message-preview">${data.summary_text}</pre>
      <div class="stack">
        <a class="btn btn-primary" href=${smsHref(husbandPhone, data.summary_text)}>
          <${Icon} name="message" size=${20} /> ${`Text this to ${husband}`}</a>
        <button type="button" class="btn btn-secondary" onClick=${copy}>
          <${Icon} name=${copied ? "check" : "copy"} size=${20} /> ${copied ? "Copied" : "Copy"}</button>
      </div>
    </section>
  </div>`;
}
