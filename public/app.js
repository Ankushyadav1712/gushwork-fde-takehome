// Callback web app: hash router, bottom nav, and the app-wide services every screen uses
// (server clock, settings, outcome sheet, toast with Undo, auto-open after Call/Text).
import { html, render, useState, useEffect, useCallback, useRef, useMemo } from "/vendor/preact-htm.js";
import * as api from "./api.js";
import { AppContext } from "./ui/common.js";
import { DEFAULT_TZ, ERROR_COPY } from "./ui/constants.js";
import { Icon } from "./ui/icons.js";
import { useToast, Toast } from "./ui/toast.js";
import { OutcomeSheet } from "./screens/outcome-sheet.js";
import { TodayScreen } from "./screens/today.js";
import { JobsScreen } from "./screens/jobs.js";
import { JobScreen } from "./screens/job.js";
import { NewScreen } from "./screens/new.js";
import { BulkScreen } from "./screens/bulk.js";
import { NumbersScreen } from "./screens/numbers.js";
import { SettingsScreen } from "./screens/settings.js";
import { DigestScreen } from "./screens/digest.js";
import { SimScreen } from "./screens/sim.js";
import { LoginScreen } from "./screens/login.js";

// §5.8: the sheet opens on return only between 3 seconds and 30 minutes after a Call/Text tap.
const TAP_MIN_MS = 3000;
const TAP_MAX_MS = 30 * 60 * 1000;
const TAP_KEY = "callback.pendingTap";
const SAVED_SLIDE_MS = 200;

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, search = ""] = raw.split("?");
  return { path: path || "/", params: new URLSearchParams(search) };
}

function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

function screenFor({ path, params }) {
  const job = /^\/job\/(\d+)$/.exec(path);
  if (job) return html`<${JobScreen} id=${Number(job[1])} />`;
  switch (path) {
    case "/jobs": return html`<${JobsScreen} stage=${params.get("stage") || "open"} />`;
    case "/new": return html`<${NewScreen} />`;
    case "/new/bulk": return html`<${BulkScreen} />`;
    case "/numbers": return html`<${NumbersScreen} />`;
    case "/settings": return html`<${SettingsScreen} />`;
    case "/digest": return html`<${DigestScreen} />`;
    case "/sim": return html`<${SimScreen} />`;
    default: return html`<${TodayScreen} />`;
  }
}

function navSection(path) {
  if (path.startsWith("/new")) return "new";
  if (path === "/" || path === "") return "today";
  return "jobs";
}

function BottomNav({ path }) {
  const active = navSection(path);
  // `name` is the accessible name; the plus icon already shows the "+" of "+ New".
  const item = (id, href, icon, label, name = null) => html`<a href=${href} class=${`nav-item ${active === id ? "active" : ""}`}
    aria-label=${name} aria-current=${active === id ? "page" : null}><${Icon} name=${icon} size=${24} /><span>${label}</span></a>`;
  return html`<nav class="bottom-nav" aria-label="Main">
    <div class="bottom-nav-inner">
      ${item("today", "#/", "today", "Today")}
      ${item("jobs", "#/jobs", "list", "Jobs")}
      ${item("new", "#/new", "plus", "New", "+ New")}
    </div>
  </nav>`;
}

function readPendingTap() {
  try {
    return JSON.parse(sessionStorage.getItem(TAP_KEY) || "null");
  } catch {
    return null;
  }
}
function writePendingTap(value) {
  try {
    if (value) sessionStorage.setItem(TAP_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(TAP_KEY);
  } catch { /* storage can be unavailable (private mode); the in-memory copy still works */ }
}

function App() {
  const route = useRoute();
  const [health, setHealth] = useState(null);
  const [settings, setSettings] = useState(null);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [version, setVersion] = useState(0);
  const [toast, showToast, dismissToast] = useToast();
  const offset = useRef(0);
  const pendingTap = useRef(readPendingTap());

  const setServerNow = useCallback((iso) => {
    if (iso) offset.current = new Date(iso).getTime() - Date.now();
  }, []);
  const nowIso = useCallback(() => new Date(Date.now() + offset.current).toISOString(), []);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const loadHealth = useCallback(async () => {
    try {
      const h = await api.getHealth();
      setServerNow(h?.now);
      setHealth(h);
    } catch { /* screens show their own error state */ }
  }, []);
  const loadSettings = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadSettings();
    const onUnauthorized = () => setAuthNeeded(true);
    window.addEventListener(api.UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(api.UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const openSheet = useCallback((subject, opts = {}) => {
    setSheet({ subject, initialOutcome: opts.initialOutcome || null, onSaved: opts.onSaved || null, key: Date.now() });
  }, []);
  // The sheet belongs to the screen it was opened on: leaving that screen (back gesture, link) closes it.
  useEffect(() => setSheet(null), [route.path, route.params.toString()]);

  // §5.8: remember the Call/Text tap; reopen that job's sheet when she comes back to the page.
  const rememberTap = useCallback((subject) => {
    pendingTap.current = { at: Date.now(), subject };
    writePendingTap(pendingTap.current);
  }, []);
  useEffect(() => {
    const maybeReopen = () => {
      if (document.visibilityState !== "visible" || !pendingTap.current) return;
      const { at, subject } = pendingTap.current;
      const elapsed = Date.now() - at;
      pendingTap.current = null;
      writePendingTap(null);
      if (elapsed > TAP_MIN_MS && elapsed <= TAP_MAX_MS && subject) openSheet(subject);
    };
    maybeReopen();
    document.addEventListener("visibilitychange", maybeReopen);
    return () => document.removeEventListener("visibilitychange", maybeReopen);
  }, []);

  const undo = useCallback(async (jobId, eventId) => {
    try {
      await api.postUndo(jobId, eventId);
      showToast("Undone.");
    } catch (err) {
      if (err.status === 401) return;
      showToast(err.code === "undo_not_allowed" ? "Too late to undo that one." : ERROR_COPY);
    }
    bump();
  }, []);

  const outcomeSaved = useCallback((jobId, result) => {
    const undoable = result?.event_id != null;
    showToast(result?.toast || "Saved.", { undo: undoable ? () => undo(jobId, result.event_id) : null });
    // Let the card slide out before the list refetches.
    setTimeout(bump, SAVED_SLIDE_MS);
  }, []);

  const staleStage = useCallback(() => {
    showToast("That job had already moved on. Here's the latest.");
    bump();
  }, []);

  const services = useMemo(() => ({
    health,
    settings,
    tz: health?.tz || settings?.timezone || DEFAULT_TZ,
    demo: Boolean(health?.demo),
    version,
    nowIso,
    setServerNow,
    reloadHealth: loadHealth,
    reloadSettings: loadSettings,
    setSettings,
    openSheet,
    rememberTap,
    outcomeSaved,
    staleStage,
    toast: showToast,
    changed: bump,
  }), [health, settings, version]);

  const onLoggedIn = async () => {
    setAuthNeeded(false);
    await Promise.all([loadHealth(), loadSettings()]);
    bump();
  };

  if (authNeeded) {
    return html`<${AppContext.Provider} value=${services}><${LoginScreen} onLoggedIn=${onLoggedIn} /></${AppContext.Provider}>`;
  }

  return html`<${AppContext.Provider} value=${services}>
    <main id="main" class="app-main" key=${route.path}>${screenFor(route)}</main>
    <${Toast} toast=${toast} onDismiss=${dismissToast} />
    <${BottomNav} path=${route.path} />
    ${sheet && html`<${OutcomeSheet} key=${sheet.key} subject=${sheet.subject} initialOutcome=${sheet.initialOutcome}
      onSaved=${sheet.onSaved} onClose=${() => setSheet(null)} />`}
  </${AppContext.Provider}>`;
}

render(html`<${App} />`, document.getElementById("app"));
