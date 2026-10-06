// Bottom sheet (§0.5): slides up over a backdrop, aria-modal, focus moved inside,
// closes on Escape or a backdrop tap, and hands focus back when it closes.
import { html, useEffect, useRef } from "/vendor/preact-htm.js";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function trapTab(event, panel) {
  const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function Sheet({ titleId, onClose, children, className = "" }) {
  const panel = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    const el = panel.current;
    // Focus the panel itself first so screen readers announce the title, without scrolling the page.
    el?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key === "Escape") closeRef.current?.();
      else if (event.key === "Tab" && el) trapTab(event, el);
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("sheet-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sheet-open");
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  return html`<div class="sheet-layer">
    <div class="sheet-backdrop" onClick=${() => onClose?.()} aria-hidden="true"></div>
    <div class=${`sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby=${titleId}
      tabindex="-1" ref=${panel}>
      <div class="sheet-handle" aria-hidden="true"></div>
      ${children}
    </div>
  </div>`;
}
