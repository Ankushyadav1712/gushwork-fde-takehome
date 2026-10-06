// Provider adapters (SPEC §7.2): pure functions that turn one webhook payload into an
// InboundEvent for ingest(). They never read the clock: the route stamps received_at and passes
// the real time to the Mailgun check. Also the webhook signature checks for Twilio and Mailgun.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizePhone } from "../shared/format.js";
import { normalizeEmail, looksLikeForm, formFieldFor } from "../shared/parse.js";

export const VOICEMAIL_PLACEHOLDER = "(voicemail - no transcript yet)";
const PHOTO_NOTE = "[photo attached]";

const MISSED_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);
const GENERIC_CALL_STATUSES = new Set(["missed", "voicemail", "answered"]);

const FORM_ID_KEYS = ["submissionid", "entryid", "id"];
// Form-builder plumbing that is never part of the lead.
const FORM_SKIPPED_KEY_RE = /^(?:token|utm|gclid|fbclid|formid|formname|pageurl|referr?er|g?recaptcha)/;
const NAME_FIELDS = new Set(["contact_name", "first_name", "last_name"]);
const MAX_HTML = 2_000_000; // HTML read per email; the tag scan is linear, this bounds its time
const MAX_EMAIL_TEXT = 100_000; // longer email text is cut; raw_json keeps the whole message
const MAX_MIME_DEPTH = 3;
const MAILGUN_MAX_AGE_MS = 5 * 60_000;

const keyOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const str = (v) => (v == null ? "" : String(v));
const orNull = (v) => {
  const s = str(v).trim();
  return s ? s : null;
};
const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Every InboundEvent field (minus received_at), with defaults. Emails are kept only when strictly valid. */
function makeEvent(fields) {
  return {
    channel: fields.channel,
    provider: fields.provider,
    external_id: orNull(fields.external_id),
    from_phone: normalizePhone(fields.from_phone) ?? null,
    from_email: normalizeEmail(fields.from_email),
    from_name: orNull(fields.from_name),
    from_reply_to: Boolean(fields.from_reply_to),
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

/** The text with a note line under it ("[photo attached]", "[2 attachments]"); the note alone when there is no text. */
function withNote(text, note) {
  if (!note) return text;
  return text ? `${text}\n${note}` : note;
}

const attachmentNote = (count) => (count > 0 ? `[${count} attachment${count === 1 ? "" : "s"}]` : null);

// ---------------------------------------------------------------------------
// HTML to text

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
const SKIPPED_ELEMENTS = new Set(["script", "style", "head"]);
const LINE_BREAK_TAGS = new Set(["br", "/p", "/div", "/tr", "/li", "/h1", "/h2", "/h3", "/h4", "/h5", "/h6", "/table", "/blockquote"]);
const CELL_END_TAGS = new Set(["/td", "/th"]);
const TAG_NAME_RE = /^(\/?)([a-z][a-z0-9]*)/i;

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

/** What a tag becomes in plain text: a line break, a tab between table cells, or nothing. */
function tagText(name) {
  if (LINE_BREAK_TAGS.has(name)) return "\n";
  return CELL_END_TAGS.has(name) ? "\t" : "";
}

/**
 * Removes tags, comments and script/style/head blocks in one left-to-right pass. Every search
 * starts where the last one ended and an unclosed construct ends the text, so it stays linear
 * even on hostile input ("<a" repeated a million times). It stops once `maxText` characters are out.
 */
function stripTags(html, maxText) {
  let out = "";
  let i = 0;
  while (i < html.length && out.length < maxText) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return out + html.slice(i);
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) return out;
      i = end + 3;
      continue;
    }
    const tag = TAG_NAME_RE.exec(html.slice(lt + 1, lt + 40));
    const declaration = html[lt + 1] === "!" || html[lt + 1] === "?"; // <!DOCTYPE>, <?xml?>
    if (!tag && !declaration) { // a bare "<" in text ("temp < 40")
      out += "<";
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) return out;
    i = gt + 1;
    if (declaration) continue;
    const [, slash, rawName] = tag;
    const name = rawName.toLowerCase();
    if (!slash && SKIPPED_ELEMENTS.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, "ig");
      close.lastIndex = i;
      const end = close.exec(html);
      if (!end) return out;
      i = end.index + end[0].length;
      continue;
    }
    out += tagText(`${slash}${name}`);
  }
  return out;
}

/**
 * Plain text from an HTML email body: block tags become line breaks, table cells tabs, entities are
 * decoded. It reads up to MAX_HTML of HTML (a long <head><style> included) and keeps MAX_EMAIL_TEXT of text.
 */
export function htmlToText(html) {
  return decodeEntities(stripTags(str(html).slice(0, MAX_HTML), MAX_EMAIL_TEXT).slice(0, MAX_EMAIL_TEXT))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[  ]+/g, " ").replace(/ ?\t[\s]*/g, "\t").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Shared email helpers

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

/**
 * One email as an InboundEvent. The sender is Reply-To when it holds an address (form mailers set
 * it to the customer), else From, and from_reply_to says which. The text is cut at MAX_EMAIL_TEXT
 * and notes how many attachments came with it.
 */
function emailEvent({ provider, text, from, replyTo, subject, messageId, attachments = 0, raw }) {
  const reply = parseAddress(replyTo);
  const replied = normalizeEmail(reply.email) != null;
  const sender = replied ? reply : from;
  const body = withNote(text.slice(0, MAX_EMAIL_TEXT), attachmentNote(attachments));
  return makeEvent({
    channel: looksLikeForm(body) ? "form" : "email", provider,
    external_id: cleanMessageId(messageId),
    from_email: sender.email, from_name: sender.name, from_reply_to: replied, subject, body, raw,
  });
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
    body: withNote(text, media ? PHOTO_NOTE : null),
    raw: p,
  });
}

/**
 * Twilio voice status / Dial action / recording / transcription callbacks:
 * - a transcript or recording is a voicemail;
 * - DialCallStatus completed is answered (Phase 2: <Dial> rang her cell), for DialCallDuration;
 * - no-answer/busy/failed/canceled is missed, and so is a parent CallStatus completed with no
 *   DialCallStatus (Phase 1: her carrier forwards only the calls she didn't pick up);
 * - anything else (queued, ringing, in-progress) has call_status null, which ingest ignores.
 */
export function fromTwilioVoice(p) {
  const transcript = orNull(p.TranscriptionText);
  const base = { channel: "call", provider: "twilio", external_id: p.CallSid, from_phone: p.From, raw: p };
  if (transcript || orNull(p.RecordingUrl)) {
    return makeEvent({ ...base, call_status: "voicemail", body: transcript ?? VOICEMAIL_PLACEHOLDER,
      call_duration_s: toSeconds(p.RecordingDuration) });
  }
  const dial = str(p.DialCallStatus).toLowerCase();
  if (dial === "completed") return makeEvent({ ...base, call_status: "answered", call_duration_s: toSeconds(p.DialCallDuration) ?? 0 });
  const status = dial || str(p.CallStatus).toLowerCase();
  if (MISSED_STATUSES.has(status) || status === "completed") return makeEvent({ ...base, call_status: "missed" });
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

/** Postmark's payload as stored: each attachment keeps its name, type and size, not its base64 contents. */
function postmarkRaw(p) {
  if (!Array.isArray(p.Attachments)) return p;
  const Attachments = p.Attachments.map((a) => ({
    Name: a?.Name ?? null, ContentType: a?.ContentType ?? null, ContentLength: a?.ContentLength ?? null,
  }));
  return { ...p, Attachments };
}

/** Postmark inbound JSON: FromFull{Email,Name}, From, ReplyTo, Subject, TextBody, HtmlBody, MessageID, Headers[], Attachments[]. */
export function fromPostmark(p) {
  const from = p.FromFull?.Email ? { email: p.FromFull.Email, name: orNull(p.FromFull.Name) } : parseAddress(p.From);
  return emailEvent({
    provider: "postmark",
    text: orNull(p.TextBody) ? str(p.TextBody).trim() : htmlToText(p.HtmlBody),
    from,
    replyTo: p.ReplyTo ?? headerValue(p.Headers, "reply-to"),
    subject: p.Subject,
    messageId: headerValue(p.Headers, "message-id") ?? p.MessageID,
    attachments: Array.isArray(p.Attachments) ? p.Attachments.length : 0,
    raw: postmarkRaw(p),
  });
}

/**
 * Mailgun inbound route (urlencoded, or multipart with attachments): sender, from, Reply-To, subject,
 * body-plain, stripped-text, Message-Id, and attachment-N file parts.
 */
export function fromMailgun(p) {
  const parsed = parseAddress(p.from ?? p.From);
  const from = parsed.email ? parsed : { name: parsed.name, email: orNull(p.sender) };
  const text = orNull(p["body-plain"]) ?? orNull(p["stripped-text"]);
  return emailEvent({
    provider: "mailgun",
    text: text ?? htmlToText(p["body-html"] ?? p["stripped-html"]),
    from,
    replyTo: p["Reply-To"] ?? p["reply-to"],
    subject: p.subject ?? p.Subject,
    messageId: p["Message-Id"] ?? p["message-id"] ?? p["Message-ID"],
    attachments: Object.values(p).filter(isFilePart).length,
    raw: p,
  });
}

/** Mailgun's signature fields, top level or nested under `signature` (newer webhooks). */
export function mailgunSignatureFields(p) {
  const nested = p?.signature && typeof p.signature === "object" ? p.signature : null;
  const src = nested ?? p ?? {};
  return { timestamp: src.timestamp, token: src.token, signature: src.signature };
}

/**
 * Mailgun's check: hex HMAC-SHA256 of timestamp + token with the signing key, and a timestamp
 * within 5 minutes of nowMs (the real time, not the demo clock). The route rejects reused tokens.
 */
export function verifyMailgunSignature(signingKey, payload, nowMs) {
  const { timestamp, token, signature } = mailgunSignatureFields(payload);
  if (!signingKey || !timestamp || !token || typeof signature !== "string") return false;
  if (!(Math.abs(nowMs - Number(timestamp) * 1000) <= MAILGUN_MAX_AGE_MS)) return false;
  const expected = createHmac("sha256", str(signingKey)).update(`${str(timestamp)}${str(token)}`).digest("hex");
  return safeEqual(expected, signature);
}

const RFC_HEADERS = new Set([
  "from", "to", "cc", "bcc", "subject", "date", "message-id", "reply-to", "sender", "return-path",
  "received", "mime-version", "content-type", "content-transfer-encoding", "delivered-to",
  "in-reply-to", "references", "dkim-signature", "authentication-results", "user-agent",
  "importance", "thread-topic", "thread-index", "content-language", "received-spf",
]);
const isRfcHeader = (name) => RFC_HEADERS.has(name) || /^(x|arc|list)-/.test(name);

/** Header lines up to the first blank line, as {headers, body}; null when a line is not a header. */
function readHeaderBlock(text, acceptName) {
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
    if (!m || !acceptName(m[1].toLowerCase())) return null;
    last = m[1].toLowerCase();
    headers[last] ??= m[2].trim();
  }
  return { headers, body: end === -1 ? "" : text.slice(end + 2) };
}

/**
 * An email's header block, or null when the leading block is not one (so a pasted
 * "Name: ... / Phone: ..." form body is never eaten as headers).
 */
function splitHeaders(text) {
  const split = readHeaderBlock(text, isRfcHeader);
  if (!split) return null;
  const { headers } = split;
  return headers.from || headers.subject || headers["message-id"] ? split : null;
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
  return Buffer.from(bytes);
}

/** "text/plain; charset=UTF-8" -> {type: "text/plain", params: {charset: "UTF-8"}}. */
function contentType(value) {
  const [type, ...rest] = str(value).split(";");
  const params = {};
  for (const part of rest) {
    const m = /^\s*([a-z0-9-]+)\s*=\s*"?([^";]*)"?\s*$/i.exec(part);
    if (m) params[m[1].toLowerCase()] = m[2];
  }
  return { type: type.trim().toLowerCase() || "text/plain", params };
}

function decodeCharset(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // an unknown charset label
  }
}

/** One MIME entity's text: its transfer encoding and charset decoded; HTML stripped; multipart unpacked. */
function decodeBody(body, headers, depth = 0) {
  const { type, params } = contentType(headers["content-type"]);
  if (type.startsWith("multipart/") && params.boundary && depth < MAX_MIME_DEPTH) {
    return decodeMultipart(body, params.boundary, depth);
  }
  const encoding = str(headers["content-transfer-encoding"]).toLowerCase();
  let bytes = null;
  if (encoding === "quoted-printable") bytes = decodeQuotedPrintable(body);
  else if (encoding === "base64") bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  const text = bytes ? decodeCharset(bytes, params.charset) : body;
  return type === "text/html" ? htmlToText(text) : text.trim();
}

/** The first text/plain part of a multipart body, else the first text/html part (as text). */
function decodeMultipart(body, boundary, depth) {
  const parts = body.split(`--${boundary}`).slice(1).filter((part) => !part.startsWith("--"));
  const entities = parts
    .map((part) => part.replace(/^[ \t]*\n/, ""))
    .map((part) => (part.startsWith("\n") ? { headers: {}, body: part.slice(1) } : readHeaderBlock(part, () => true)))
    .filter(Boolean)
    .map((entity) => ({ ...entity, type: contentType(entity.headers["content-type"]).type }));
  const chosen = entities.find((e) => e.type === "text/plain")
    ?? entities.find((e) => e.type.startsWith("multipart/"))
    ?? entities.find((e) => e.type === "text/html");
  return chosen ? decodeBody(chosen.body, chosen.headers, depth + 1) : "";
}

// RFC 2047 encoded words: "=?UTF-8?B?Sm9zw6k=?=" (base64) or "=?UTF-8?Q?Caf=C3=A9?=" (quoted-printable).
const ENCODED_WORD_RE = /=\?([^?\s]+)\?([BQ])\?([^?\s]*)\?=/gi;

/** A raw header value with its encoded words decoded; the space between two encoded words is dropped. */
function decodeHeader(value) {
  return str(value)
    .replace(/\?=\s+(?==\?)/g, "?=")
    .replace(ENCODED_WORD_RE, (all, charset, encoding, text) => {
      const bytes = encoding.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQuotedPrintable(text.replace(/_/g, " "));
      return decodeCharset(bytes, charset.replace(/\*.*$/, "")); // "UTF-8*en" names a language too
    });
}

/** A raw text/plain or message/rfc822 email: headers (From, Reply-To, Subject, Message-ID) until a blank line, then the body. */
export function fromRawEmail(rawText) {
  const text = str(rawText).replace(/\r\n?/g, "\n");
  const split = splitHeaders(text);
  const headers = split?.headers ?? {};
  return emailEvent({
    provider: "raw",
    text: split ? decodeBody(split.body, headers) : text.trim(),
    from: parseAddress(decodeHeader(headers.from)),
    replyTo: decodeHeader(headers["reply-to"]),
    subject: decodeHeader(headers.subject),
    messageId: headers["message-id"],
    raw: str(rawText),
  });
}

// ---------------------------------------------------------------------------
// multipart/form-data bodies (Mailgun posts with attachments, some form builders)

/** A file part as decodeFormData keeps it: {filename, type, size}, without its contents. */
function isFilePart(value) {
  return isObject(value) && typeof value.filename === "string" && Number.isInteger(value.size);
}

/** The part without the line break that ends it (the one before the next boundary). */
function withoutFinalBreak(part) {
  if (part.endsWith("\r\n")) return part.slice(0, -2);
  return part.endsWith("\n") ? part.slice(0, -1) : part;
}

/**
 * A multipart/form-data body as a plain object: each text part under its name (the first one
 * wins), and each file part as {filename, type, size}; file contents are never kept.
 */
export function decodeFormData(buffer, contentTypeHeader) {
  const fields = {};
  const { boundary } = contentType(contentTypeHeader).params;
  if (!boundary || !Buffer.isBuffer(buffer)) return fields;
  const utf8 = (s) => Buffer.from(s, "latin1").toString("utf8");
  // latin1 keeps one character per byte, so a file part's length is its size.
  for (const part of buffer.toString("latin1").split(`--${boundary}`).slice(1)) {
    if (part.startsWith("--")) break; // the closing delimiter
    const gap = /\r?\n\r?\n/.exec(part);
    if (!gap) continue;
    const head = part.slice(0, gap.index);
    const disposition = /^content-disposition:(.*)$/im.exec(head)?.[1] ?? "";
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    if (!name) continue;
    const body = withoutFinalBreak(part.slice(gap.index + gap[0].length));
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    const type = /^content-type:\s*([^\s;]+)/im.exec(head)?.[1] ?? null;
    fields[utf8(name)] ??= filename == null ? utf8(body) : { filename: utf8(filename), type, size: body.length };
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Website forms

/**
 * A field's value as one line of text: lists and objects ({street, city}) are joined with ", ",
 * or with `separator` (a split name, {first, last}, is joined with a space).
 */
function fieldText(value, separator = ", ") {
  if (value == null) return "";
  if (typeof value === "object") return Object.values(value).map((v) => fieldText(v, separator)).filter(Boolean).join(separator);
  return String(value).trim();
}

/** "fields[name]" -> "name"; an object under an unknown key ({data: {name, phone}}) is flattened one level. */
function formEntries(payload) {
  const entries = [];
  for (const [rawKey, value] of Object.entries(payload)) {
    const key = /\[([^\]]+)\]$/.exec(rawKey)?.[1] ?? rawKey;
    const nested = isObject(value) && !isFilePart(value) && !formFieldFor(key);
    if (nested) entries.push(...Object.entries(value));
    else entries.push([key, value]);
  }
  return entries;
}

/** Free text with no field of its own (the longest unaliased value of 3+ words) stands in for the message. */
function messageFromExtras(extras) {
  const prose = extras.filter((e) => e.text.split(/\s+/).length >= 3);
  return prose.sort((a, b) => b.text.length - a.text.length)[0] ?? null;
}

/**
 * A direct website-form webhook (JSON, urlencoded or multipart). Fields the parser knows
 * (shared/parse.js label names) become form_fields; message-like fields become the body; unknown
 * fields are appended as "Key: value"; uploaded files are counted in a note; ids and tracking
 * fields are dropped.
 */
export function fromForm(p) {
  const payload = p && typeof p === "object" ? p : { message: str(p) };
  const known = {};
  const messages = [];
  const extras = [];
  let externalId = null;
  let files = 0;
  for (const [key, value] of formEntries(payload)) {
    if (isFilePart(value)) {
      files += 1;
      continue;
    }
    const k = keyOf(key);
    const field = formFieldFor(key);
    const text = fieldText(value, NAME_FIELDS.has(field) ? " " : ", ");
    if (FORM_ID_KEYS.includes(k)) externalId ??= orNull(text);
    if (FORM_ID_KEYS.includes(k) || FORM_SKIPPED_KEY_RE.test(k) || !text) continue;
    if (field === "message") messages.push(text);
    else if (field) known[field] ??= text;
    else extras.push({ key, text });
  }
  const standIn = messages.length ? null : messageFromExtras(extras);
  if (standIn) messages.push(standIn.text);
  if (messages.length) known.message = messages.join("\n");
  const name = known.contact_name ?? ([known.first_name, known.last_name].filter(Boolean).join(" ") || null);
  const lines = [...messages, ...extras.filter((e) => e !== standIn).map((e) => `${e.key}: ${e.text}`)];
  return makeEvent({
    channel: "form", provider: "form",
    external_id: externalId,
    from_phone: known.phone, from_email: known.email, from_name: name,
    body: withNote(lines.join("\n"), attachmentNote(files)),
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
    from: { email: from.email, name: orNull(p.from_name) ?? from.name },
    replyTo: p.reply_to,
    subject: p.subject,
    messageId: p.message_id,
    attachments: Object.values(p).filter(isFilePart).length, // a multipart post in this shape (SendGrid's) can carry files
    raw: p,
  });
}

/**
 * Generic JSON payload (an object) for one channel: sms {from, body, id?}, call {from, status,
 * duration_s?, voicemail_text?, id?}, email {from, from_name?, reply_to?, subject?, text, message_id?},
 * form (see fromForm).
 */
export function fromGeneric(channel, p) {
  switch (channel) {
    case "sms": return genericSms(p);
    case "call": return genericCall(p);
    case "email": return genericEmail(p);
    case "form": return { ...fromForm(p), provider: "generic" };
    default: throw new Error(`fromGeneric: unknown channel ${channel}`);
  }
}
