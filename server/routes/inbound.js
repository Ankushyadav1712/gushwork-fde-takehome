// Inbound webhooks (SPEC §7.2). Every alias goes to the same handler for its channel.
// Mount at the app root: app.use(inboundRouter({db, now, settings, send})).
import express from "express";
import { ingest } from "../ingest.js";
import {
  fromTwilioSms, fromTwilioVoice, fromPostmark, fromMailgun, fromRawEmail, fromForm, fromGeneric,
  verifyTwilioSignature, verifyMailgunSignature, safeEqual,
} from "../adapters.js";
import { getSettings } from "../repo.js";

export const INBOUND_PATHS = Object.freeze({
  sms: ["/api/inbound/sms", "/webhooks/twilio/sms", "/webhooks/sms"],
  call: ["/api/inbound/call", "/webhooks/twilio/voice", "/webhooks/voice"],
  email: ["/api/inbound/email", "/webhooks/postmark", "/webhooks/mailgun", "/webhooks/email"],
  form: ["/api/inbound/form", "/webhooks/form"],
});
const ALL_PATHS = new Set(Object.values(INBOUND_PATHS).flat());
const LIMIT = "1mb";
const TWIML_EMPTY = "<Response/>";

const parsers = [
  express.json({ limit: LIMIT }),
  express.urlencoded({ extended: false, limit: LIMIT }),
  express.text({ type: ["text/plain", "message/rfc822"], limit: LIMIT }),
];

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const has = (p, ...keys) => isObject(p) && keys.some((k) => p[k] !== undefined);

/** Which provider shape a payload has, for one route. */
export function detectFormat(route, payload) {
  if (route === "sms") return has(payload, "MessageSid", "SmsSid", "SmsMessageSid", "AccountSid") ? "twilio" : "generic";
  if (route === "call") return has(payload, "CallSid") ? "twilio" : "generic";
  if (route === "email") {
    if (typeof payload === "string") return "raw";
    if (has(payload, "TextBody", "HtmlBody", "FromFull", "MessageID")) return "postmark";
    if (has(payload, "body-plain", "stripped-text", "body-html", "sender", "Message-Id")) return "mailgun";
    return "generic";
  }
  if (route === "form") return "form";
  throw new Error(`Unknown inbound route: ${route}`);
}

const ADAPTERS = {
  sms: { twilio: fromTwilioSms, generic: (p) => fromGeneric("sms", p) },
  call: { twilio: fromTwilioVoice, generic: (p) => fromGeneric("call", p) },
  email: { raw: fromRawEmail, postmark: fromPostmark, mailgun: fromMailgun, generic: (p) => fromGeneric("email", p) },
  form: { form: (p) => fromForm(typeof p === "string" ? { message: p } : p) },
};

/** The InboundEvent (minus received_at) for a payload on one route. */
export function eventFromPayload(route, payload) {
  const format = detectFormat(route, payload);
  return { format, event: ADAPTERS[route][format](payload) };
}

function demoOn(deps, env) {
  if (typeof deps.demo === "function") return Boolean(deps.demo());
  if (typeof deps.demo === "boolean") return deps.demo;
  return env.DEMO === "1";
}

/** Generic payloads may carry `at` (an ISO time) only in demo mode. */
function receivedAt(format, payload, nowIso, demo) {
  if (!demo || format !== "generic" || !isObject(payload) || payload.at == null) return nowIso;
  const t = Date.parse(payload.at);
  return Number.isFinite(t) ? new Date(t).toISOString() : nowIso;
}

/**
 * Adapt and ingest one payload, without the HTTP guards. The simulator uses this too.
 * deps: {db, now: () => ISO, settings?: () => object, send?, demo?: boolean | () => boolean}
 * @returns {{format, result}} where result is ingest()'s return value
 */
export function ingestPayload(route, payload, deps, env = process.env) {
  const nowIso = deps.now();
  const { format, event } = eventFromPayload(route, payload);
  const settings = deps.settings ? deps.settings() : getSettings(deps.db);
  const result = ingest(deps.db, { ...event, received_at: receivedAt(format, payload, nowIso, demoOn(deps, env)) },
    { now: nowIso, settings, send: deps.send });
  return { format, result };
}

function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

function publicUrl(env) {
  return String(env.PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
}

/** Runs the token and signature guards. Returns true when the request may proceed. */
function guard(req, res, format, env) {
  if (env.INBOUND_TOKEN && !safeEqual(req.query?.token, env.INBOUND_TOKEN)) {
    sendError(res, 401, "unauthorized", "Missing or wrong token.");
    return false;
  }
  const twilioShaped = format === "twilio" || req.path.startsWith("/webhooks/twilio/");
  if (env.TWILIO_AUTH_TOKEN && twilioShaped) {
    const url = publicUrl(env) + req.originalUrl;
    const params = isObject(req.body) ? req.body : {};
    if (!verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params, req.get("X-Twilio-Signature"))) {
      sendError(res, 403, "forbidden", "Bad Twilio signature.");
      return false;
    }
  }
  const mailgunShaped = format === "mailgun" || req.path === "/webhooks/mailgun";
  if (env.MAILGUN_SIGNING_KEY && mailgunShaped && !verifyMailgunSignature(env.MAILGUN_SIGNING_KEY, req.body)) {
    sendError(res, 403, "forbidden", "Bad Mailgun signature.");
    return false;
  }
  return true;
}

function hasBody(body) {
  return typeof body === "string" ? body.trim() !== "" : isObject(body) && Object.keys(body).length > 0;
}

function handlerFor(route, deps) {
  return (req, res) => {
    const env = deps.env ?? process.env;
    const payload = req.body;
    if (!hasBody(payload)) {
      sendError(res, 400, "validation", "Empty or unreadable body.");
      return;
    }
    const format = detectFormat(route, payload);
    if (!guard(req, res, format, env)) return;
    const { result } = ingestPayload(route, payload, deps, env);
    if (format === "twilio") {
      res.status(200).type("text/xml").send(TWIML_EMPTY);
      return;
    }
    const { refine, ...json } = result;
    res.status(200).json(json);
  };
}

/** Body-parser failures on the inbound routes become JSON errors (413 for bodies over 1 MB). */
function inboundErrors(err, req, res, next) {
  if (!ALL_PATHS.has(req.path) || res.headersSent) {
    next(err);
    return;
  }
  if (err?.type === "entity.too.large") sendError(res, 413, "validation", "Body is over 1 MB.");
  else if (err?.status >= 400 && err.status < 500) sendError(res, err.status, "validation", "Unreadable body.");
  else next(err);
}

/**
 * deps: {db, now: () => ISO, settings: () => object, send?: notify.send, demo?, env?}
 * `demo` defaults to process.env.DEMO === "1"; pass the server's demo flag to apply its defaulting rule.
 */
export function inboundRouter(deps) {
  const router = express.Router();
  for (const [route, paths] of Object.entries(INBOUND_PATHS)) {
    router.post(paths, ...parsers, handlerFor(route, deps));
  }
  router.use(inboundErrors);
  return router;
}
