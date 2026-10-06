// Pickers used inside sheets (§5.4, §4.10). Each one ends in a single onPick/onSave call,
// so an outcome stays within 3 taps of opening the sheet.
import { html, useState, useEffect, useRef } from "/vendor/preact-htm.js";
import { localDate, addDays, nextBusinessDay, weekdayName, shortDateLabel } from "/shared/time.js";
import { money } from "/shared/format.js";
import { LOST_REASONS } from "/shared/stages.js";
import { Icon } from "./icons.js";

const NEXT_WEEKDAYS = 3;

/**
 * Day chips for "yes" and "scheduled": Today, Tomorrow, then the next 3 weekdays (Mon-Fri)
 * after tomorrow, by name.
 */
function dayChoices(nowIso, tz) {
  const today = localDate(nowIso, tz);
  const tomorrow = addDays(today, 1);
  const choices = [{ label: "Today", value: today }, { label: "Tomorrow", value: tomorrow }];
  let day = tomorrow;
  for (let i = 0; i < NEXT_WEEKDAYS; i += 1) {
    day = nextBusinessDay(day);
    choices.push({ label: weekdayName(day, { long: true }), value: day });
  }
  return choices;
}

/** Snooze chips (§4.10): next business day ("Tomorrow" when it is), then the business day after. */
function snoozeChoices(nowIso, tz) {
  const today = localDate(nowIso, tz);
  const first = nextBusinessDay(today);
  const second = nextBusinessDay(first);
  return [
    { label: first === addDays(today, 1) ? "Tomorrow" : weekdayName(first, { long: true }), value: first },
    { label: weekdayName(second, { long: true }), value: second },
  ];
}

function ChoiceButton({ label, onClick, accent = false, wide = false, className = "" }) {
  const cls = `btn choice ${accent ? "btn-primary" : "btn-secondary"} ${wide ? "wide" : ""} ${className}`;
  return html`<button type="button" class=${cls} onClick=${onClick}>${label}</button>`;
}

/** "Pick a day": a native date input plus a confirm button. */
function PickADay({ min, onPick, tz, wide = true, label = "Pick a day" }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef(null);
  useEffect(() => {
    if (!open || !input.current) return;
    input.current.focus();
    try { input.current.showPicker?.(); } catch { /* not allowed without a gesture in some browsers */ }
  }, [open]);
  if (!open) return html`<${ChoiceButton} label=${label} wide=${wide} onClick=${() => setOpen(true)} />`;
  return html`<div class="pick-day wide">
    <label class="field-label" for="pick-day-input">Day</label>
    <input id="pick-day-input" ref=${input} class="input" type="date" min=${min} value=${value}
      onInput=${(e) => setValue(e.currentTarget.value)} />
    <button type="button" class="btn btn-primary" disabled=${!value} onClick=${() => onPick(value)}>
      ${value ? `Use ${shortDateLabel(value, tz)}` : "Choose a day"}
    </button>
  </div>`;
}

/**
 * `highlight` (a YYYY-MM-DD: the day the customer asked for, or a suggested visit date) gets the
 * accent colour, and is added as its own chip when it isn't one of the usual days.
 */
export function DayPicker({ now, tz, allowNone = false, highlight = null, onPick }) {
  const today = localDate(now, tz);
  const choices = dayChoices(now, tz);
  if (highlight && highlight >= today && !choices.some((c) => c.value === highlight)) {
    choices.push({ label: weekdayName(highlight, { long: true }), value: highlight });
  }
  const chipCount = choices.length + (allowNone ? 1 : 0);
  return html`<div class="choice-grid">
    ${choices.map((c) => html`<${ChoiceButton} key=${c.value} label=${c.label} accent=${c.value === highlight}
      onClick=${() => onPick(c.value)} />`)}
    ${allowNone && html`<${ChoiceButton} label="No date yet" onClick=${() => onPick(null)} />`}
    <${PickADay} min=${today} tz=${tz} wide=${chipCount % 2 === 0} onPick=${onPick} />
  </div>`;
}

export function SnoozePicker({ now, tz, onPick }) {
  const tomorrow = addDays(localDate(now, tz), 1);
  return html`<div class="choice-grid">
    ${snoozeChoices(now, tz).map((c) => html`<${ChoiceButton} key=${c.value} label=${c.label} onClick=${() => onPick(c.value)} />`)}
    <${PickADay} min=${tomorrow} tz=${tz} onPick=${onPick} />
  </div>`;
}

export function TechPicker({ techs, onPick }) {
  return html`<div class="choice-grid">
    ${techs.map((t) => html`<${ChoiceButton} key=${t.name} label=${t.name} onClick=${() => onPick(t.name)} />`)}
    <${ChoiceButton} label="Skip" className="quiet-choice" onClick=${() => onPick(null)} />
  </div>`;
}

export function LostReasonPicker({ preset, onPick }) {
  return html`<div class="choice-grid">
    ${LOST_REASONS.map((r) => html`<${ChoiceButton} key=${r.id} label=${r.label} accent=${r.id === preset}
      onClick=${() => onPick(r.id)} />`)}
    <${ChoiceButton} label="Skip" className="quiet-choice" onClick=${() => onPick(null)} />
  </div>`;
}

const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"];
const MAX_DIGITS = 7;

/** Large keypad for whole dollars, with "Save $n" and an equally large "Skip". */
export function AmountPad({ initial, onSave }) {
  const [digits, setDigits] = useState(initial ? String(Math.round(initial)) : "");
  const press = (key) => {
    setDigits((d) => {
      if (key === "back") return d.slice(0, -1);
      if (key === "clear") return "";
      if (d.length >= MAX_DIGITS || (d === "" && key === "0")) return d;
      return d + key;
    });
  };
  const amount = digits ? Number(digits) : null;
  const latest = useRef(amount);
  latest.current = amount;

  useEffect(() => {
    const onKey = (e) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("back");
      else if (e.key === "Enter" && latest.current) onSave(latest.current);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const keyLabel = (k) => {
    if (k === "back") return html`<${Icon} name="backspace" />`;
    if (k === "clear") return "Clear";
    return k;
  };
  const keyAria = (k) => (k === "back" ? "Delete last digit" : k === "clear" ? "Clear amount" : null);
  return html`<div class="amount-pad">
    <output class="amount-display num" aria-live="polite">${amount ? money(amount) : "$0"}</output>
    <div class="keypad">
      ${PAD_KEYS.map((k) => html`<button type="button" key=${k} class=${`key ${k.length > 1 ? "key-fn" : ""}`}
        aria-label=${keyAria(k)} onClick=${() => press(k)}>${keyLabel(k)}</button>`)}
    </div>
    <div class="pad-actions">
      <button type="button" class="btn btn-primary" disabled=${!amount} onClick=${() => onSave(amount)}>
        ${amount ? `Save ${money(amount)}` : "Save"}
      </button>
      <button type="button" class="btn btn-secondary" onClick=${() => onSave(null)}>Skip</button>
    </div>
  </div>`;
}
