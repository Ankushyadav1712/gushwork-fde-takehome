// Optional single passcode (SPEC §13.5, D20). When APP_PASSCODE is set, every /api/* route needs the
// cb_session cookie except login, health and the inbound webhooks. The cookie is an HMAC made with
// SESSION_SECRET (random per boot when unset), httpOnly, SameSite=Lax, valid for 180 days.
// Cookie ages use real time on purpose: moving the demo clock must not log anyone out.
import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./adapters.js";

export const COOKIE_NAME = "cb_session";
const MAX_AGE_S = 180 * 24 * 60 * 60;
const EXEMPT_PATHS = ["/api/login", "/api/health"];
const EXEMPT_PREFIXES = ["/api/inbound/"];
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function sendUnauthorized(res, message, status = 401) {
  res.status(status).json({ error: { code: "unauthorized", message } });
}

/** The value of one cookie from the Cookie header, or null. */
export function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function isExempt(path) {
  return EXEMPT_PATHS.includes(path) || EXEMPT_PREFIXES.some((p) => path.startsWith(p));
}

/** Counts failed logins per address so a short passcode can't be guessed by brute force. */
function failureTracker() {
  const failures = new Map();
  const fresh = (ip) => {
    const entry = failures.get(ip);
    if (entry && Date.now() - entry.first > FAILURE_WINDOW_MS) failures.delete(ip);
    return failures.get(ip);
  };
  return {
    blocked: (ip) => (fresh(ip)?.count ?? 0) >= MAX_FAILURES,
    fail: (ip) => {
      const entry = fresh(ip) ?? { count: 0, first: Date.now() };
      entry.count += 1;
      failures.set(ip, entry);
    },
    clear: (ip) => failures.delete(ip),
  };
}

/**
 * createAuth({env}) -> {enabled, guard, login, issue, verify}.
 * `guard` is middleware for /api; `login` handles POST /api/login {passcode}.
 */
export function createAuth({ env = process.env } = {}) {
  const passcode = env.APP_PASSCODE || "";
  const secret = env.SESSION_SECRET || randomBytes(32).toString("hex");
  const secureCookie = /^https:/i.test(env.PUBLIC_URL ?? "");
  const tracker = failureTracker();

  // The passcode is part of the signed text, so changing APP_PASSCODE signs everyone out.
  const sign = (issuedMs) => createHmac("sha256", secret).update(`${COOKIE_NAME}.v1.${issuedMs}.${passcode}`).digest("base64url");
  const issue = () => {
    const issued = Date.now();
    return `${issued}.${sign(issued)}`;
  };
  const verify = (token) => {
    const [issued, signature, extra] = String(token ?? "").split(".");
    if (extra !== undefined || !/^\d+$/.test(issued ?? "") || !signature) return false;
    const age = Date.now() - Number(issued);
    return age >= 0 && age < MAX_AGE_S * 1000 && safeEqual(signature, sign(issued));
  };

  function guard(req, res, next) {
    if (!passcode || isExempt(req.originalUrl.split("?")[0]) || verify(readCookie(req, COOKIE_NAME))) {
      next();
      return;
    }
    sendUnauthorized(res, "Enter your passcode.");
  }

  function login(req, res) {
    if (!passcode) {
      res.json({ ok: true });
      return;
    }
    const ip = req.ip ?? "unknown";
    if (tracker.blocked(ip)) {
      sendUnauthorized(res, "Too many tries. Wait a few minutes and try again.", 429);
      return;
    }
    const given = typeof req.body?.passcode === "string" ? req.body.passcode : "";
    if (!given || !safeEqual(given, passcode)) {
      tracker.fail(ip);
      sendUnauthorized(res, "That passcode didn't work.");
      return;
    }
    tracker.clear(ip);
    const secure = secureCookie || req.secure ? "; Secure" : "";
    res.set("Set-Cookie", `${COOKIE_NAME}=${issue()}; Max-Age=${MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure}`);
    res.json({ ok: true });
  }

  return { enabled: Boolean(passcode), guard, login, issue, verify };
}
