// The "How'd it go?" sheet (§5, §9). Main buttons, then pickers inside the sheet, then a quiet row.
// Every path from opening the sheet to saved is at most 3 taps.
import { html, useState, useRef } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { Sheet } from "../ui/sheet.js";
import { askedForDay } from "/shared/stages.js";
import { DayPicker, TechPicker, AmountPad, LostReasonPicker, SnoozePicker } from "../ui/pickers.js";
import { useApp } from "../ui/common.js";
import { ERROR_COPY } from "../ui/constants.js";
import { Icon } from "../ui/icons.js";

const STEP_PROMPTS = {
  day: "Which day?",
  tech: "Which tech?",
  amount: "How much?",
  lost_reason: "Why was it lost?",
  snooze_day: "When should it come back?",
  block: "Remove it from your list?",
};

/**
 * Splits the server's buttons (§5.3): `primary` ones are the main column (promoted first),
 * the rest are the quiet row. Only `suggested` (promoted) buttons get the accent colour.
 */
function splitOutcomes(outcomes = []) {
  const main = outcomes.filter((b) => b.primary);
  const quiet = outcomes.filter((b) => !b.primary);
  main.sort((a, b) => Number(Boolean(b.suggested)) - Number(Boolean(a.suggested)));
  return { main: main.map((b) => ({ ...b, accent: Boolean(b.suggested) })), quiet };
}

/** The picker step a button opens first, or null when one tap saves. */
function firstStep(button, subject) {
  if (button.id === "not_a_job" && subject.phone) return "block";
  if (button.needs === "day" || button.needs === "day_or_none") return "day";
  return button.needs || null;
}

function sheetTitle(subject) {
  if (subject.bucket === "check_done") return `Did it get done at ${subject.title}?`;
  if (subject.bucket === "replied") return `${subject.title} wrote back`;
  return `How'd it go with ${subject.title}?`;
}

/** The customer's message, quoted: in the sheet while unread, and at the top of Job detail. */
export function ReplyQuote({ inbound }) {
  if (!inbound?.body) return null;
  return html`<figure class="reply-quote">
    <blockquote>${inbound.body}</blockquote>
    ${inbound.at_label && html`<figcaption>Their message · ${inbound.at_label}</figcaption>`}
  </figure>`;
}

export function OutcomeSheet({ subject, initialOutcome = null, onClose, onSaved }) {
  const app = useApp();
  const { main, quiet } = splitOutcomes(subject.outcomes);
  const initialButton = initialOutcome ? subject.outcomes?.find((b) => b.id === initialOutcome) : null;
  const [button, setButton] = useState(initialButton || null);
  const [step, setStep] = useState(initialButton ? firstStep(initialButton, subject) : null);
  const [args, setArgs] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // State updates land after a re-render; the ref stops a second Enter from posting the outcome twice.
  const inFlight = useRef(false);

  const techs = app.settings?.techs || [];
  const unread = subject.unread ?? (subject.outcomes || []).some((b) => b.id === "seen");

  async function submit(chosen, extra) {
    if (inFlight.current) return;
    inFlight.current = true;
    const body = { outcome: chosen.id, ...extra, expected_stage: subject.stage };
    setBusy(true);
    setError(null);
    try {
      const result = await api.postOutcome(subject.job_id, body);
      onClose();
      onSaved?.(result, chosen.id);
      app.outcomeSaved(subject.job_id, result, { tech: body.tech });
    } catch (err) {
      inFlight.current = false;
      setBusy(false);
      if (err.status === 409 && err.code === "stale_stage") {
        onClose();
        app.staleStage();
      } else if (err.status !== 401) {
        setError({ err, retry: () => submit(chosen, extra) });
      }
    }
  }

  function choose(b) {
    const next = firstStep(b, subject);
    setButton(b);
    setArgs({});
    if (!next) return submit(b, {});
    setStep(next);
  }

  function pickDay(visitDate) {
    if (visitDate === null || !techs.length) return submit(button, { visit_date: visitDate, tech: null });
    setArgs({ visit_date: visitDate });
    setStep("tech");
  }

  /** The day to highlight: the server's suggestion ("Move to Wednesday?"), else the day an unread reply names. */
  const suggestedDay = (b) => b.preset?.visit_date
    ?? (unread ? askedForDay(subject.last_inbound?.body, app.nowIso(), app.tz) : null);

  const back = () => {
    if (step === "tech") return setStep("day");
    setStep(null);
    setButton(null);
  };

  function renderStep() {
    switch (step) {
      case "day":
        return html`<${DayPicker} now=${app.nowIso()} tz=${app.tz} allowNone=${button.needs === "day_or_none"}
          highlight=${suggestedDay(button)} onPick=${pickDay} />`;
      case "tech":
        return html`<${TechPicker} techs=${techs} onPick=${(tech) => submit(button, { ...args, tech })} />`;
      case "amount": {
        // "Done" is prefilled with the quote amount (§5.2); "Quote sent" starts empty.
        const prefill = button.id === "done" ? button.preset?.amount ?? subject.quote_amount ?? null : null;
        return html`<${AmountPad} initial=${prefill} onSave=${(amount) => submit(button, { amount })} />`;
      }
      case "lost_reason":
        return html`<${LostReasonPicker} preset=${button.preset?.lost_reason ?? null}
          onPick=${(reason) => submit(button, { lost_reason: reason })} />`;
      case "snooze_day":
        return html`<${SnoozePicker} now=${app.nowIso()} tz=${app.tz} onPick=${(day) => submit(button, { snooze_until: day })} />`;
      case "block":
        return html`<div class="stack">
          <button type="button" class="btn btn-primary" onClick=${() => submit(button, { block: false })}>Remove it</button>
          <button type="button" class="btn btn-secondary" onClick=${() => submit(button, { block: true })}>Remove and block this number</button>
        </div>`;
      default:
        return null;
    }
  }

  const body = step
    ? html`<div class="sheet-step">
        <div class="step-head">
          <p class="step-eyebrow">${button?.label}</p>
          <button type="button" class="link-btn" onClick=${back}><${Icon} name="back" size=${18} /> Back</button>
        </div>
        <h3 class="step-title" tabindex="-1">${STEP_PROMPTS[step]}</h3>
        ${renderStep()}
      </div>`
    : html`<div class="stack">
        ${main.map((b) => html`<button type="button" key=${b.id} class=${`btn ${b.accent ? "btn-primary" : "btn-secondary"}`}
          onClick=${() => choose(b)}>${b.label}</button>`)}
      </div>
      <div class="quiet-row">
        ${quiet.map((b) => html`<button type="button" key=${b.id} class="quiet-link" onClick=${() => choose(b)}>${b.label}</button>`)}
        <a class="quiet-link" href=${`#/job/${subject.job_id}`} onClick=${() => onClose()}>Open job</a>
      </div>`;

  return html`<${Sheet} titleId="outcome-title" step=${step} onClose=${onClose}>
    <h2 id="outcome-title" class="sheet-title">${sheetTitle(subject)}</h2>
    ${unread && html`<${ReplyQuote} inbound=${subject.last_inbound} />`}
    ${error && html`<div class="inline-error" role="alert">
      <p>${error.err.status === 0 ? ERROR_COPY : "That didn't save. Please try again."}</p>
      <button type="button" class="btn btn-secondary" onClick=${error.retry}>Retry</button>
    </div>`}
    <div class=${busy ? "sheet-body is-busy" : "sheet-body"} aria-busy=${busy ? "true" : "false"}>${body}</div>
  </${Sheet}>`;
}
