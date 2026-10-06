// The only module in the browser that talks to the server (spec §0.3).
// One named async function per endpoint in §13.5. Every function resolves with the
// parsed JSON body (or null for 204) and rejects with an Error carrying
// `.status` and `.code` taken from the ApiError body ({error:{code,message}}).
// A 401 also fires the "callback:unauthorized" window event so the app can show Login.

export const UNAUTHORIZED_EVENT = "callback:unauthorized";

export class ApiRequestError extends Error {
  constructor(status, code, message) {
    super(message || code || `Request failed (${status})`);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

function query(params) {
  const pairs = Object.entries(params || {}).filter(([, v]) => v != null && v !== "");
  if (!pairs.length) return "";
  return `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
}

async function readBody(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(method, path, body, { keepalive = false } = {}) {
  const init = { method, headers: { Accept: "application/json" }, credentials: "same-origin", keepalive };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiRequestError(0, "network", err?.message || "Network error");
  }
  const data = await readBody(res);
  if (res.ok) return data;
  const apiError = data && typeof data === "object" ? data.error : null;
  const code = apiError?.code || (res.status === 401 ? "unauthorized" : "http_error");
  if (res.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  throw new ApiRequestError(res.status, code, apiError?.message);
}

const get = (path, params) => request("GET", `${path}${query(params)}`);
const post = (path, body = {}, opts) => request("POST", path, body, opts);
const put = (path, body = {}) => request("PUT", path, body);
const patch = (path, body = {}) => request("PATCH", path, body);
const jobPath = (id, suffix = "") => `/api/jobs/${encodeURIComponent(id)}${suffix}`;

// Health and auth
export const getHealth = () => get("/api/health");
export const login = (passcode) => post("/api/login", { passcode });

// Today and jobs
export const getToday = () => get("/api/today");
export const getJobs = ({ stage = "open", q = "" } = {}) => get("/api/jobs", { stage, q });
export const getJob = (id) => get(jobPath(id));
export const createJob = (body) => post("/api/jobs", body);
export const updateJob = (id, fields) => patch(jobPath(id), fields);
export const postOutcome = (id, body) => post(jobPath(id, "/outcome"), body);
export const postStage = (id, body) => post(jobPath(id, "/stage"), body);
export const postUndo = (id, eventId) => post(jobPath(id, "/undo"), { event_id: eventId });
/**
 * Logs a Call/Text tap. The tel:/sms: navigation that follows the tap cancels an ordinary fetch
 * (and shows a failed request), so a beacon is used; keepalive fetch is the fallback.
 */
export function postTap(id, kind, tech) {
  const body = tech ? { kind, tech } : { kind };
  const path = jobPath(id, "/tap");
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
    if (navigator.sendBeacon(path, blob)) return Promise.resolve(null);
  }
  return post(path, body, { keepalive: true });
}

// Quick Add and Brain dump
export const parseText = (text, useAi = true) => post("/api/parse", { text, use_ai: useAi });
export const parseBulk = (text) => post("/api/bulk/parse", { text });
export const createBulk = (rows) => post("/api/bulk", { rows });

// Numbers, settings, texts to Denise
export const getNumbers = () => get("/api/numbers");
export const getSettings = () => get("/api/settings");
export const saveSettings = (partial) => put("/api/settings", partial);
export const getDigestPreview = () => get("/api/digest/preview");
export const sendDigestNow = () => post("/api/digest/send");
export const getOutbox = (limit = 50) => get("/api/outbox", { limit });
export const getMessages = (limit = 50) => get("/api/messages", { limit });
/** Not a fetch: the CSV is downloaded by navigating to this URL. */
export const exportCsvUrl = () => "/api/export/jobs.csv";

// Demo controls (DEMO=1 only)
export const simInbound = (body) => post("/api/sim/inbound", body);
export const simClock = (body) => post("/api/sim/clock", body);
export const simTick = () => post("/api/sim/tick");
export const simReset = () => post("/api/sim/reset");
