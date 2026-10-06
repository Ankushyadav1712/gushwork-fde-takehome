// Toast (§0.5, §5.1): dark surface above the bottom nav, optional Undo, 6 seconds, aria-live polite.
// An optional `link` ({label, href, onClick}) adds a second action, such as "Text Mike".
import { html, useState, useRef, useCallback, useEffect } from "/vendor/preact-htm.js";

const TOAST_MS = 6000;

/** Returns [toast, show(text, {undo, link}), dismiss]. A new toast replaces the current one. */
export function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setToast(null);
  }, []);
  const show = useCallback((text, { undo = null, link = null } = {}) => {
    clearTimeout(timer.current);
    setToast({ text, undo, link, key: Date.now() });
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [toast, show, dismiss];
}

export function Toast({ toast, onDismiss }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [toast?.key]);
  const undo = async () => {
    if (!toast?.undo || busy) return;
    setBusy(true);
    await toast.undo();
    setBusy(false);
  };
  const link = toast?.link;
  // The live region stays in the DOM so screen readers announce each new message.
  return html`<div class="toast-region" aria-live="polite" aria-atomic="true">
    ${toast && html`<div class=${`toast ${link ? "has-link" : ""}`} key=${toast.key}>
      <span class="toast-text">${toast.text}</span>
      <span class="toast-actions">
        ${link && html`<a class="toast-action" href=${link.href} onClick=${() => { link.onClick?.(); onDismiss(); }}>${link.label}</a>`}
        ${toast.undo
          ? html`<button type="button" class="toast-action" disabled=${busy} onClick=${undo}>Undo</button>`
          : html`<button type="button" class="toast-action toast-close" onClick=${onDismiss}>OK</button>`}
      </span>
    </div>`}
  </div>`;
}
