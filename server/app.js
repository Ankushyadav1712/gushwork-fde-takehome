// The Express app (SPEC §13.1, §13.5): inbound webhooks, body parsers, static files, the passcode
// guard, the JSON API, the demo simulator (DEMO only), the husband's page, the SPA fallback and one
// JSON error handler. Besides the app it returns, createApp() only ever stores the session secret
// (passcode on, no SESSION_SECRET), so tests can run it.
import express from "express";
import { fileURLToPath } from "node:url";
import * as clock from "./clock.js";
import * as repo from "./repo.js";
import * as notify from "./notify.js";
import { aiEnabled } from "./ai.js";
import { createAuth } from "./auth.js";
import { ApiError } from "./actions.js";
import { resolvePublicUrl } from "./context.js";
import { inboundRouter } from "./routes/inbound.js";
import { apiRouter } from "./routes/api.js";
import { simRouter } from "./routes/sim.js";
import { numbersPageHandler } from "./numbers-page.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const SHARED_DIR = fileURLToPath(new URL("../shared/", import.meta.url));
const LIMIT = "1mb";
const NON_SPA_PREFIXES = ["/api/", "/n/", "/shared/"];

const APP_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'", "img-src 'self' data:", "style-src 'self' 'unsafe-inline'", "script-src 'self'",
    "connect-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; "),
};

/**
 * Demo mode (seed, demo clock, simulator, Reset demo) as the environment asks for it: on unless DEMO
 * is set to something other than 1/true/on/yes (§13.6), and always off under NODE_ENV=production,
 * whatever the environment says. No variable can turn a production server into a demo; the Vercel
 * entry (api/index.js), which can never hold real data, passes demo: true in code instead.
 */
export function isDemo(env = process.env) {
  if (env.NODE_ENV === "production") return false;
  if (env.DEMO == null || env.DEMO === "") return true;
  return ["1", "true", "on", "yes"].includes(String(env.DEMO).toLowerCase());
}

/** Maps any thrown error to an ApiError JSON body (§13.4). */
function errorStatus(err) {
  if (err instanceof ApiError) return { status: err.status, code: err.code, message: err.message };
  if (err?.name === "OutcomeError") return { status: 422, code: err.code, message: err.message };
  if (err?.name === "IngestError") return { status: 400, code: "validation", message: err.message };
  if (err?.type === "entity.too.large") return { status: 413, code: "validation", message: "That request is over 1 MB." };
  if (err?.status >= 400 && err.status < 500) return { status: err.status, code: "validation", message: "Couldn't read that request." };
  return { status: 500, code: "server_error", message: "Something went wrong on the server." };
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { status, code, message } = errorStatus(err);
  if (status >= 500) console.error(`[api] ${req.method} ${req.path} failed (${err?.name ?? "Error"}: ${err?.message ?? ""})`);
  res.status(status).json({ error: { code, message } });
}

function apiNotFound(req, res) {
  res.status(404).json({ error: { code: "not_found", message: "No such endpoint." } });
}

/** Non-API page GETs get index.html, so a refresh on any hash route still loads the app. */
function spaFallback(req, res, next) {
  const path = req.path;
  if (NON_SPA_PREFIXES.some((p) => path.startsWith(p)) || /\.[a-z0-9]+$/i.test(path) || !req.accepts("html")) {
    next();
    return;
  }
  res.set("Cache-Control", "no-cache");
  res.sendFile("index.html", { root: PUBLIC_DIR });
}

/**
 * createApp({db, now, env, publicUrl, fetch?, extract?, clock?}) -> express app.
 * now() returns the ISO time for each request (default: the demo-aware server clock).
 * publicUrl is the address links in texts point at (default: PUBLIC_URL, else localhost:3000).
 * fetch is used for Twilio sends; extract replaces the AI extractor (tests).
 * demo overrides isDemo(env); only api/index.js passes it (true), because a Vercel instance is a demo by design.
 */
export function createApp({
  db, now = () => clock.now().toISOString(), env = process.env, publicUrl = resolvePublicUrl(env),
  fetch, extract, clock: clockApi = clock, demo = isDemo(env),
} = {}) {
  if (!db) throw new Error("createApp: db is required");
  const sendText = (msg) => notify.send(msg, { db, now: now(), env, fetch });
  const deps = {
    db, now, env, publicUrl, demo, fetch, extract, clock: clockApi, send: sendText,
    aiOn: () => Boolean(extract) || aiEnabled(),
    isShifted: () => clockApi.isShifted(),
    clockOffsetMs: () => (clockApi.isShifted() ? Date.parse(now()) - Date.now() : 0),
  };
  const auth = createAuth({ env, db, publicUrl });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((req, res, next) => {
    res.set(APP_HEADERS);
    next();
  });

  // Webhooks first: they bring their own parsers, size limits and token/signature guards.
  app.use(inboundRouter({ db, now, settings: () => repo.getSettings(db), send: sendText, demo, env, publicUrl }));

  app.use(express.json({ limit: LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: LIMIT }));
  app.use(express.text({ type: ["text/plain", "message/rfc822"], limit: LIMIT }));

  app.use(express.static(PUBLIC_DIR));
  app.use("/shared", express.static(SHARED_DIR));

  app.post("/api/login", auth.login);
  app.use("/api", auth.guard);
  app.use("/api", apiRouter(deps));
  if (demo) app.use("/api", simRouter(deps));
  app.use("/api", apiNotFound);

  app.get("/n/:key", numbersPageHandler({ db, now, publicUrl }));
  app.get("/{*splat}", spaFallback);

  app.use(errorHandler);
  return app;
}
