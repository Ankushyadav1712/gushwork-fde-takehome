// Small shared hooks and components used by every screen.
import { html, useState, useEffect, useCallback, useRef, createContext, useContext } from "/vendor/preact-htm.js";
import { ERROR_COPY } from "./constants.js";
import { Icon } from "./icons.js";

/** App-wide services: health, tz, settings, sheet, toast and change notifications (filled in by app.js). */
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

/**
 * Runs `loader` on mount and whenever `deps` change. Keeps the last good data while reloading,
 * so a background refresh never blanks the screen.
 */
export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(async ({ quiet = false } = {}) => {
    const mine = ++seq.current;
    if (!quiet) setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loader();
      if (mine === seq.current) setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (mine === seq.current) setState((s) => ({ ...s, error, loading: false }));
      return null;
    }
  }, deps);
  useEffect(() => { run(); }, [run]);
  const setData = useCallback((update) => {
    setState((s) => ({ ...s, data: typeof update === "function" ? update(s.data) : update }));
  }, []);
  return { ...state, reload: run, setData };
}

/** The §9 error copy with a Retry button. 401s are handled globally (Login), so they show nothing here. */
export function ErrorState({ error, onRetry }) {
  if (error?.status === 401) return null;
  return html`<div class="error-state" role="alert">
    <${Icon} name="alert" size=${28} />
    <p>${ERROR_COPY}</p>
    ${onRetry && html`<button type="button" class="btn btn-primary" onClick=${() => onRetry()}>Retry</button>`}
  </div>`;
}

export function Loading({ label = "Loading…" }) {
  return html`<div class="loading" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span><span>${label}</span>
  </div>`;
}

/** Page title row with an optional back link and trailing actions. */
export function PageHeader({ title, back, children }) {
  // Prefer the browser's back so filters and scroll position are kept; the href is the fallback.
  const goBack = (event) => {
    if (history.length > 1) {
      event.preventDefault();
      history.back();
    }
  };
  return html`<header class="page-header">
    ${back && html`<a class="icon-btn back-link" href=${back} onClick=${goBack} aria-label="Back"><${Icon} name="back" /></a>`}
    <h1 class="page-title">${title}</h1>
    ${children && html`<div class="page-header-actions">${children}</div>`}
  </header>`;
}

export const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const plural = (n, one, many) => (n === 1 ? one : many);

const URL_RE = /(https?:\/\/[^\s]+)/g;

/**
 * Renders plain text with any http(s) URLs as links. A link back into this app becomes an
 * in-app hash link, so "Open: http://localhost:3000/#/" in a text bubble opens Today.
 */
export function Linkified({ text }) {
  const parts = String(text ?? "").split(URL_RE);
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const hashAt = part.indexOf("/#/");
    const sameApp = hashAt !== -1 && part.slice(0, hashAt) === location.origin;
    const href = sameApp ? part.slice(hashAt + 1) : part;
    return html`<a href=${href} target=${sameApp ? null : "_blank"} rel="noopener">${part}</a>`;
  });
}

/** Copies text to the clipboard, falling back to a hidden textarea for older browsers. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** sms: link in the §13.2 format, for links the UI builds itself (tech texts, Numbers). */
export const smsHref = (phone, body) => `sms:${phone || ""}?&body=${encodeURIComponent(body || "")}`;
