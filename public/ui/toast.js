// Toast (§0.5, §5.1): dark surface above the bottom nav, optional Undo, 6 seconds, aria-live polite.
import { html, useState, useRef, useCallback, useEffect } from "/vendor/preact-htm.js";

export const TOAST_MS = 6000;

/** Returns [toast, show(text, {undo}), dismiss]. A new toast replaces the current one. */
export function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setToast(null);
  }, []);
  const show = useCallback((text, { undo = null } = {}) => {
    clearTimeout(timer.current);
    setToast({ text, undo, key: Date.now() });
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
  // The live region stays in the DOM so screen readers announce each new message.
  return html`<div class="toast-region" aria-live="polite" aria-atomic="true">
    ${toast && html`<div class="toast" key=${toast.key}>
      <span class="toast-text">${toast.text}</span>
      ${toast.undo
        ? html`<button type="button" class="toast-undo" disabled=${busy} onClick=${undo}>Undo</button>`
        : html`<button type="button" class="toast-close" aria-label="Dismiss" onClick=${onDismiss}>OK</button>`}
    </div>`}
  </div>`;
}
