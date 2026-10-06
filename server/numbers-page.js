// The husband's read-only page (SPEC §9, §10): GET /n/:key renders the Numbers as plain HTML with
// no buttons and no JavaScript. A wrong key is a 404. Every piece of text is escaped.
import { getSettings, getJobViews } from "./repo.js";
import { safeEqual } from "./adapters.js";
import { contextFor } from "./routes/api.js";
import { computeNumbers, numbersText } from "../shared/stats.js";
import { money } from "../shared/format.js";
import { shortDateLabel, timeLabel } from "../shared/time.js";

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Colours follow the app's tokens (§0.5), light and dark.
const STYLE = `
:root{--bg:#F5F6F8;--surface:#FFFFFF;--text:#13181D;--muted:#5A6670;--border:#E2E6EA;--red:#C3281E;--green:#2D7A35;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0E1317;--surface:#161D23;--text:#E7ECF0;--muted:#9AA7B1;--border:#25303A;--red:#FF6B61;--green:#67BE6E}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:0 auto;padding:24px 16px 40px}
h1{font-size:24px;margin:0 0 4px}
.date{color:var(--muted);margin:0 0 20px;font-size:14px}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;margin:0}
.tile.wide{grid-column:1 / -1}
.tile dt{font-size:14px;color:var(--muted);margin:0 0 4px}
.tile dd{margin:0}
.value{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
.detail{font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums}
.leak{margin:16px 0;font-weight:600}
.leak.bad{color:var(--red)}
.leak.good{color:var(--green)}
pre{white-space:pre-wrap;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
h2{font-size:14px;font-weight:600;color:var(--muted);margin:24px 0 8px}
.foot{color:var(--muted);font-size:14px;margin-top:20px}
`;

function tile(label, value, detail, wide = false) {
  const extra = detail ? `<dd class="detail">${escapeHtml(detail)}</dd>` : "";
  return `<div class="tile${wide ? " wide" : ""}"><dt>${escapeHtml(label)}</dt><dd class="value">${escapeHtml(value)}</dd>${extra}</div>`;
}

function tilesHtml(n) {
  // No-break spaces keep "Said yes 2" and "(2 without a $)" on one line.
  const keep = (s) => s.replace(/ /g, "\u00a0");
  const stages = n.stages.map((s) => keep(`${s.label} ${s.count}`)).join(" · ");
  const noAmount = n.won_30d_no_amount ? ` ${keep(`(${n.won_30d_no_amount} without a $)`)}` : "";
  return [
    tile("Open jobs", n.open_count, stages, true),
    tile("Waiting on a yes", money(n.waiting_yes_total) || "$0", plural(n.waiting_yes_count, "quote", "quotes"), true),
    tile("Won, last 30 days", plural(n.won_30d_count, "job", "jobs"), `${money(n.won_30d_total) || "$0"}${noAmount}`),
    tile("Done, last 7 days", n.done_7d_count),
    tile("Lost, last 30 days", n.lost_30d_count, n.lost_30d_count ? `${n.lost_30d_went_elsewhere} went with someone else` : null),
    tile("New, last 7 days", n.new_7d_count),
  ].join("");
}

/** The full HTML document for the numbers at ctx.now. */
export function renderNumbersPage(numbers, ctx) {
  const company = ctx.settings.company_name || "Callback";
  const updated = `${shortDateLabel(ctx.now, ctx.tz)}, ${timeLabel(ctx.now, ctx.tz)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(company)} numbers</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(company)} numbers</h1>
<p class="date">${escapeHtml(numbers.date_label)} · last 7 or 30 days up to now</p>
<dl class="tiles">${tilesHtml(numbers)}</dl>
<p class="leak ${numbers.leak_count > 0 ? "bad" : "good"}">${escapeHtml(numbers.leak_text)}</p>
<h2>As a text</h2>
<pre>${escapeHtml(numbersText(numbers, ctx))}</pre>
<p class="foot">Read-only. Updated ${escapeHtml(updated)}. Reload for the latest.</p>
</main>
</body>
</html>
`;
}

const NOT_FOUND_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title></head><body><p>This link doesn't work. Ask for a new one.</p></body></html>`;

/** Express handler for GET /n/:key. deps: {db, now: () => ISO, env}. */
export function numbersPageHandler({ db, now, env = process.env }) {
  return (req, res) => {
    res.set(PAGE_HEADERS);
    const settings = getSettings(db);
    if (!settings.readonly_key || !safeEqual(req.params.key, settings.readonly_key)) {
      res.status(404).send(NOT_FOUND_PAGE);
      return;
    }
    const ctx = contextFor(db, now(), env, settings);
    const numbers = computeNumbers(getJobViews(db, { scope: "all" }), ctx);
    res.status(200).send(renderNumbersPage(numbers, ctx));
  };
}
