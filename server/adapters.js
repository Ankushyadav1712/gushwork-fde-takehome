// Provider adapters (SPEC §7.2): pure functions that turn one webhook payload into an
// InboundEvent for ingest(). They never read the clock: the route stamps received_at.
// Also the webhook signature checks for Twilio and Mailgun.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizePhone } from "../shared/format.js";

export const VOICEMAIL_PLACEHOLDER = "(voicemail - no transcript yet)";
const PHOTO_NOTE = "[photo attached]";

const MISSED_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);
const GENERIC_CALL_STATUSES = new Set(["missed", "voicemail", "answered"]);

/** Form field aliases (§7.2). Keys are compared lowercased with non-alphanumerics removed. */
const FORM_ALIASES = {
  name: "name", fullname: "name", yourname: "name",
  business: "business", company: "business", restaurant: "business", store: "business", businessname: "business",
  phone: "phone", phonenumber: "phone", tel: "phone", mobile: "phone",
  email: "email", emailaddress: "email",
  address: "address", serviceaddress: "address", location: "address",
  message: "message", details: "message", comments: "message", description: "message",
  howcanwehelp: "message", issue: "message", problem: "message",
};
const FORM_ID_KEYS = ["submissionid", "entryid", "id"];
const FORM_SKIPPED_KEYS = new Set([...FORM_ID_KEYS, "token"]);

const FORM_LABEL_RE = /(?:^|\n|[ \t][/|][ \t])[ \t]*(name|business|phone|email|message)[ \t]*:/gi;

const keyOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const str = (v) => (v == null ? "" : String(v));
const orNull = (v) => {
  const s = str(v).trim();
  return s ? s : null;
};

/** Every InboundEvent field (minus received_at), with defaults. */
function makeEvent(fields) {
  return {
    channel: fields.channel,
    provider: fields.provider,
    external_id: orNull(fields.external_id),
    from_phone: normalizePhone(fields.from_phone) ?? null,
    from_email: orNull(fields.from_email)?.toLowerCase() ?? null,
    from_name: orNull(fields.from_name),
    subject: orNull(fields.subject),
    body: str(fields.body),
    call_status: fields.call_status ?? null,
    call_duration_s: fields.call_duration_s ?? null,
    form_fields: fields.form_fields ?? null,
    raw: fields.raw,
  };
}

function toSeconds(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// ---------------------------------------------------------------------------
// Text helpers

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

/** Plain text from an HTML email body: block tags become line breaks, entities are decoded. */
export function htmlToText(html) {
  return decodeEntities(
    str(html)
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the text carries 2+ different website-form labels (Name:, Business:, Phone:, Email:, Message:). */
export function detectFormEmail(text) {
  const labels = new Set();
  for (const m of str(text).replace(/\r\n?/g, "\n").matchAll(FORM_LABEL_RE)) labels.add(m[1].toLowerCase());
  return labels.size >= 2;
}

/**
 * Content hash for form submissions that carry no id (§7.1 step 1):
 * sha1(body + phone + email + received_at rounded down to 10 minutes).
 */
export function formExternalId({ body, phone, email }, receivedAt) {
  const t = Date.parse(receivedAt);
  const bucket = Number.isFinite(t) ? new Date(t - (t % 600_000)).toISOString() : "";
  return createHash("sha1").update(`${str(body)}|${str(phone)}|${str(email)}|${bucket}`).digest("hex");
}

/** "<abc@host>" -> "abc@host", so the same email dedupes across providers. */
function cleanMessageId(value) {
  const s = str(value).trim().replace(/^<|>$/g, "").trim();
  return s || null;
}

/** "Tony Russo <tony@example.com>" -> {name, email}; a bare address -> {name: null, email}. */
function parseAddress(value) {
  const s = str(value).trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(s);
  if (m) return { name: orNull(m[1]), email: orNull(m[2]) };
  const bare = /[^\s<>"]+@[^\s<>"]+/.exec(s);
  return { name: null, email: bare ? bare[0] : null };
}

function emailChannel(text) {
  return detectFormEmail(text) ? "form" : "email";
}

// ---------------------------------------------------------------------------
// Twilio

/** Twilio Messaging webhook (urlencoded): From, To, Body, MessageSid, NumMedia. */
export function fromTwilioSms(p) {
  const text = str(p.Body);
  const media = Number(p.NumMedia) > 0;
  return makeEvent({
    channel: "sms", provider: "twilio",
    external_id: p.MessageSid ?? p.SmsMessageSid ?? p.SmsSid,
    from_phone: p.From,
    body: media ? (text ? `${text}\n${PHOTO_NOTE}` : PHOTO_NOTE) : text,
    raw: p,
  });
}

/**
 * Twilio voice status / recording / transcription callbacks, mapped per the §7.2 call table:
 * a transcript or recording is a voicemail; no-answer/busy/failed/canceled is missed;
 * completed is answered (with its duration); anything else has call_status null (ingest ignores it).
 */
export function fromTwilioVoice(p) {
  const transcript = orNull(p.TranscriptionText);
  const base = { channel: "call", provider: "twilio", external_id: p.CallSid, from_phone: p.From, raw: p };
  if (transcript || orNull(p.RecordingUrl)) {
    return makeEvent({ ...base, call_status: "voicemail", body: transcript ?? VOICEMAIL_PLACEHOLDER,
      call_duration_s: toSeconds(p.RecordingDuration) });
  }
  const status = str(p.DialCallStatus || p.CallStatus).toLowerCase();
  if (MISSED_STATUSES.has(status)) return makeEvent({ ...base, call_status: "missed" });
  if (status === "completed") {
    return makeEvent({ ...base, call_status: "answered",
      call_duration_s: toSeconds(p.DialCallDuration ?? p.CallDuration) ?? 0 });
  }
  return makeEvent({ ...base, call_status: null });
}

/** X-Twilio-Signature: base64 HMAC-SHA1 of the full URL plus the sorted POST key/value pairs. */
export function twilioSignature(authToken, url, params = {}) {
  let data = str(url);
  for (const key of Object.keys(params ?? {}).sort()) {
    const value = params[key];
    for (const v of Array.isArray(value) ? [...value].sort() : [value]) data += key + str(v);
  }
  return createHmac("sha1", str(authToken)).update(data, "utf8").digest("base64");
}

/** Constant-time string comparison (hashing first so the lengths always match). */
export function safeEqual(a, b) {
  if (a == null || b == null) return false;
  const da = createHash("sha256").update(str(a)).digest();
  const db = createHash("sha256").update(str(b)).digest();
  return timingSafeEqual(da, db);
}

export function verifyTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  return safeEqual(twilioSignature(authToken, url, params), signature);
}

// ---------------------------------------------------------------------------
// Email: Postmark, Mailgun, raw RFC 822 text, generic JSON

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const hit = headers.find((h) => str(h?.Name).toLowerCase() === name);
  return hit ? hit.Value : null;
}

function emailEvent({ provider, text, fromEmail, fromName, subject, messageId, raw }) {
  return makeEvent({
    channel: emailChannel(text), provider,
    external_id: cleanMessageId(messageId),
    from_email: fromEmail, from_name: fromName, subject, body: text, raw,
  });
}

/** Postmark inbound JSON: FromFull{Email,Name}, From, Subject, TextBody, HtmlBody, MessageID, Headers[]. */
export function fromPostmark(p) {
  const from = p.FromFull?.Email ? { email: p.FromFull.Email, name: orNull(p.FromFull.Name) } : parseAddress(p.From);
  return emailEvent({
    provider: "postmark",
    text: orNull(p.TextBody) ? str(p.TextBody).trim() : htmlToText(p.HtmlBody),
    fromEmail: from.email, fromName: from.name, subject: p.Subject,
    messageId: headerValue(p.Headers, "message-id") ?? p.MessageID,
    raw: p,
  });
}

/** Mailgun inbound route (urlencoded): sender, from, subject, body-plain, stripped-text, Message-Id. */
export function fromMailgun(p) {
  const from = parseAddress(p.from ?? p.From);
  const text = orNull(p["body-plain"]) ?? orNull(p["stripped-text"]);
  return emailEvent({
    provider: "mailgun",
    text: text ?? htmlToText(p["body-html"] ?? p["stripped-html"]),
    fromEmail: from.email ?? orNull(p.sender), fromName: from.name, subject: p.subject ?? p.Subject,
    messageId: p["Message-Id"] ?? p["message-id"] ?? p["Message-ID"],
    raw: p,
  });
}

/** Mailgun's signature fields, top level or nested under `signature` (newer webhooks). */
function mailgunSignatureFields(p) {
  const nested = p?.signature && typeof p.signature === "object" ? p.signature : null;
  const src = nested ?? p ?? {};
  return { timestamp: src.timestamp, token: src.token, signature: src.signature };
}

/** Hex HMAC-SHA256 of timestamp + token with the webhook signing key. */
export function mailgunSignature(signingKey, timestamp, token) {
  return createHmac("sha256", str(signingKey)).update(`${str(timestamp)}${str(token)}`).digest("hex");
}

export function verifyMailgunSignature(signingKey, payload) {
  const { timestamp, token, signature } = mailgunSignatureFields(payload);
  if (!signingKey || !timestamp || !token || typeof signature !== "string") return false;
  return safeEqual(mailgunSignature(signingKey, timestamp, token), signature);
}

const RFC_HEADERS = new Set([
  "from", "to", "cc", "bcc", "subject", "date", "message-id", "reply-to", "sender", "return-path",
  "received", "mime-version", "content-type", "content-transfer-encoding", "delivered-to",
  "in-reply-to", "references", "dkim-signature", "authentication-results", "user-agent",
  "importance", "thread-topic", "thread-index", "content-language", "received-spf",
]);
const isRfcHeader = (name) => RFC_HEADERS.has(name) || /^(x|arc|list)-/.test(name);

/**
 * Header lines up to the first blank line, or null when the leading block is not an email
 * header block (so a pasted "Name: ... / Phone: ..." form body is never eaten as headers).
 */
function splitHeaders(text) {
  const end = text.indexOf("\n\n");
  const block = end === -1 ? text : text.slice(0, end);
  const headers = {};
  let last = null;
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] += ` ${line.trim()}`;
      continue;
    }
    const m = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (!m || !isRfcHeader(m[1].toLowerCase())) return null;
    last = m[1].toLowerCase();
    headers[last] ??= m[2].trim();
  }
  if (!headers.from && !headers.subject && !headers["message-id"]) return null;
  return { headers, body: end === -1 ? "" : text.slice(end + 2) };
}

function decodeQuotedPrintable(s) {
  const bytes = [];
  const soft = s.replace(/=\n/g, "");
  for (let i = 0; i < soft.length; i++) {
    const hex = soft[i] === "=" ? soft.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(soft[i], "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeBody(body, headers) {
  const encoding = str(headers["content-transfer-encoding"]).toLowerCase();
  let text = body;
  if (encoding === "quoted-printable") text = decodeQuotedPrintable(body);
  else if (encoding === "base64") text = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  return /text\/html/i.test(str(headers["content-type"])) ? htmlToText(text) : text.trim();
}

/** A raw text/plain or message/rfc822 email: headers (From, Subject, Message-ID) until a blank line, then the body. */
export function fromRawEmail(rawText) {
  const text = str(rawText).replace(/\r\n?/g, "\n");
  const split = splitHeaders(text);
  const headers = split?.headers ?? {};
  const from = parseAddress(headers.from);
  return emailEvent({
    provider: "raw",
    text: split ? decodeBody(split.body, headers) : text.trim(),
    fromEmail: from.email, fromName: from.name, subject: headers.subject,
    messageId: headers["message-id"],
    raw: str(rawText),
  });
}

// ---------------------------------------------------------------------------
// Website forms

function fieldText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

/**
 * A direct website-form webhook (JSON or urlencoded). Aliased fields become form_fields;
 * message-like fields become the body; unknown fields are appended as "Key: value".
 */
export function fromForm(p) {
  const payload = p && typeof p === "object" ? p : { message: str(p) };
  const known = {};
  const messages = [];
  const extras = [];
  let externalId = null;
  for (const [key, value] of Object.entries(payload)) {
    const k = keyOf(key);
    const text = fieldText(value);
    if (FORM_ID_KEYS.includes(k)) externalId ??= orNull(text);
    if (FORM_SKIPPED_KEYS.has(k) || !text) continue;
    const alias = FORM_ALIASES[k];
    if (alias === "message") messages.push(text);
    else if (alias) known[alias] ??= text;
    else extras.push(`${key}: ${text}`);
  }
  if (messages.length) known.message = messages.join("\n");
  return makeEvent({
    channel: "form", provider: "form",
    external_id: externalId,
    from_phone: known.phone, from_email: known.email, from_name: known.name,
    body: [...messages, ...extras].join("\n"),
    form_fields: Object.keys(known).length ? known : null,
    raw: p,
  });
}

// ---------------------------------------------------------------------------
// Generic JSON (§7.2 "Generic JSON" rows). The route decides whether `at` is honoured.

function genericSms(p) {
  return makeEvent({ channel: "sms", provider: "generic", external_id: p.id, from_phone: p.from, body: p.body, raw: p });
}

function genericCall(p) {
  const status = str(p.status).toLowerCase();
  const callStatus = GENERIC_CALL_STATUSES.has(status) ? status : null;
  const voicemail = orNull(p.voicemail_text);
  return makeEvent({
    channel: "call", provider: "generic", external_id: p.id, from_phone: p.from,
    call_status: callStatus,
    call_duration_s: toSeconds(p.duration_s) ?? (callStatus === "answered" ? 0 : null),
    body: voicemail ?? (callStatus === "voicemail" ? VOICEMAIL_PLACEHOLDER : ""),
    raw: p,
  });
}

function genericEmail(p) {
  const from = parseAddress(p.from);
  return emailEvent({
    provider: "generic",
    text: orNull(p.text) ? str(p.text).trim() : htmlToText(p.html),
    fromEmail: from.email, fromName: orNull(p.from_name) ?? from.name, subject: p.subject,
    messageId: p.message_id, raw: p,
  });
}

/** Generic JSON payload for one channel: sms {from, body, id?}, call {from, status, duration_s?, voicemail_text?, id?}, email {from, from_name?, subject?, text, message_id?}, form (see fromForm). */
export function fromGeneric(channel, p) {
  const payload = p && typeof p === "object" ? p : {};
  switch (channel) {
    case "sms": return genericSms(payload);
    case "call": return genericCall(payload);
    case "email": return genericEmail(payload);
    case "form": return { ...fromForm(payload), provider: "generic" };
    default: throw new Error(`fromGeneric: unknown channel ${channel}`);
  }
}
