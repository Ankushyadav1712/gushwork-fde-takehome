// Inbound webhooks (SPEC §7.2): one path per channel. Mount at the app root:
// app.use(inboundRouter({db, now, settings, send})).
import express from "express";
import { ingest } from "../ingest.js";
import {
  fromTwilioSms, fromTwilioVoice, fromPostmark, fromMailgun, fromRawEmail, fromForm, fromGeneric,
  verifyTwilioSignature, verifyMailgunSignature, mailgunSignatureFields, safeEqual,
} from "../adapters.js";
import { getSettings } from "../repo.js";

export const INBOUND_PATHS = Object.freeze({
  sms: "/api/inbound/sms",
  call: "/api/inbound/call",
  email: "/api/inbound/email",
  form: "/api/inbound/form",
});
const ALL_PATHS = new Set(Object.values(INBOUND_PATHS));
const TWILIO_ROUTES = new Set(["sms", "call"]);
const LIMIT = "1mb";
const TWIML_EMPTY = "<Response/>";
const MAILGUN_TOKEN_TTL_MS = 10 * 60_000;

const parsers = [
  express.json({ limit: LIMIT }),
  express.urlencoded({ extended: false, limit: LIMIT }),
  express.text({ type: ["text/plain", "message/rfc822"], limit: LIMIT }),
];

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const has = (p, ...keys) => isObject(p) && keys.some((k) => p[k] !== undefined);

/** Which provider shape a payload has, for one route. */
function detectFormat(route, payload) {
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
  form: { form: fromForm },
};

/** Generic payloads may carry `at` (an ISO time) only in demo mode. */
function receivedAt(format, payload, nowIso, demo) {
  if (!demo || format !== "generic" || !isObject(payload) || payload.at == null) return nowIso;
  const t = Date.parse(payload.at);
  return Number.isFinite(t) ? new Date(t).toISOString() : nowIso;
}

/**
 * Adapt and ingest one payload, without the HTTP guards. The simulator uses this too.
 * deps: {db, now: () => ISO, settings?: () => object, send?, demo?: boolean}
 * @returns {{format, result}} where result is ingest()'s return value
 */
export function ingestPayload(route, payload, deps) {
  const nowIso = deps.now();
  const format = detectFormat(route, payload);
  const event = ADAPTERS[route][format](payload);
  const settings = deps.settings ? deps.settings() : getSettings(deps.db);
  const result = ingest(deps.db, { ...event, received_at: receivedAt(format, payload, nowIso, Boolean(deps.demo)) },
    { now: nowIso, settings, send: deps.send });
  return { format, result };
}

function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

/**
 * Boot check (C2): signed webhooks need PUBLIC_URL to be the address the providers post to.
 * Returns the warning to print, or null when the setup is fine.
 */
export function webhookUrlWarning(env) {
  if (!env.TWILIO_AUTH_TOKEN && !env.MAILGUN_SIGNING_KEY) return null;
  const url = String(env.PUBLIC_URL ?? "").trim();
  if (url && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$)/i.test(url)) return null;
  return "Webhook signatures are on (TWILIO_AUTH_TOKEN or MAILGUN_SIGNING_KEY) but PUBLIC_URL is "
    + `${url ? "a localhost address" : "not set"}; set it to the public https address the providers post to.`;
}

/** Mailgun tokens seen in the last 10 minutes; a repeat is a replayed webhook. */
function mailgunTokenLog() {
  const seen = new Map(); // token -> ms first seen, oldest first
  return {
    isReplay(token, nowMs) {
      for (const [old, at] of seen) {
        if (nowMs - at <= MAILGUN_TOKEN_TTL_MS) break;
        seen.delete(old);
      }
      if (seen.has(token)) return true;
      seen.set(token, nowMs);
      return false;
    },
  };
}

/**
 * C2: the token on every route; Twilio signatures on sms/call and Mailgun's on email whenever
 * their keys are set. Twilio signs the public address it posts to, so that is what is checked.
 */
function guardFailure(route, req, { env, publicUrl }, tokens) {
  if (env.INBOUND_TOKEN && !safeEqual(req.query?.token, env.INBOUND_TOKEN)) {
    return [401, "unauthorized", "Missing or wrong token."];
  }
  if (env.TWILIO_AUTH_TOKEN && TWILIO_ROUTES.has(route)) {
    const params = isObject(req.body) ? req.body : {};
    const url = publicUrl + req.originalUrl;
    if (!verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params, req.get("X-Twilio-Signature"))) {
      return [403, "forbidden", "Bad Twilio signature."];
    }
  }
  if (env.MAILGUN_SIGNING_KEY && route === "email") {
    const nowMs = Date.now(); // real time: the demo clock must not widen the replay window
    const ok = verifyMailgunSignature(env.MAILGUN_SIGNING_KEY, req.body, nowMs)
      && !tokens.isReplay(String(mailgunSignatureFields(req.body).token), nowMs);
    if (!ok) return [403, "forbidden", "Bad Mailgun signature."];
  }
  return null;
}

function hasBody(body) {
  return typeof body === "string" ? body.trim() !== "" : isObject(body) && Object.keys(body).length > 0;
}

/** Why a payload can't be a text or a call: plain text, or generic fields with no sender and nothing said. */
function unreadableTextOrCall(route, payload) {
  if (!TWILIO_ROUTES.has(route)) return null;
  if (typeof payload === "string") return [415, "validation", "This address takes form fields or JSON, not plain text."];
  const said = route === "sms" ? payload.body : payload.voicemail_text;
  if (detectFormat(route, payload) === "generic" && !String(payload.from ?? "").trim() && !String(said ?? "").trim()) {
    return [400, "validation", "Send the sender's number (from) or the message text."];
  }
  return null;
}

/** guardFailure, logged (path and reason only) so a wrong PUBLIC_URL or token shows up in the server log. */
function refusal(route, req, guards, tokens) {
  const failure = guardFailure(route, req, guards, tokens);
  if (failure) console.warn(`[inbound] ${req.method} ${req.path} refused with ${failure[0]}: ${failure[2]}`);
  return failure;
}

function handlerFor(route, deps, tokens) {
  const guards = { env: deps.env ?? process.env, publicUrl: deps.publicUrl };
  return (req, res) => {
    const payload = req.body;
    if (!hasBody(payload)) {
      sendError(res, 400, "validation", "Empty or unreadable body.");
      return;
    }
    const failure = refusal(route, req, guards, tokens) ?? unreadableTextOrCall(route, payload);
    if (failure) {
      sendError(res, ...failure);
      return;
    }
    const { format, result } = ingestPayload(route, payload, deps);
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
 * deps: {db, now: () => ISO, settings: () => object, send?: notify.send, demo?: boolean, env?,
 *        publicUrl: the address providers post to, which Twilio signs (createApp passes it)}
 */
export function inboundRouter(deps) {
  const router = express.Router();
  const mailgunTokens = mailgunTokenLog();
  for (const [route, path] of Object.entries(INBOUND_PATHS)) {
    router.post(path, ...parsers, handlerFor(route, deps, mailgunTokens));
  }
  router.use(inboundErrors);
  return router;
}
