// Rule-based message parser: the always-on fallback behind the AI refine (SPEC §8.5-8.7).
// Pure and browser-safe: imports only ./format.js, ./time.js and ./stages.js, and never reads the
// clock. Every public entry point that reads text runs behind one logged guard (see guard()).
import { normalizePhone, shorten } from "./format.js";
import { localDate, addDays, weekdayOf, atLocal, DEFAULT_TZ } from "./time.js";
import { EQUIPMENT } from "./stages.js";

const MAX_INPUT = 20000; // longer bodies are stored verbatim by ingest; we only read the start
const EQUIPMENT_IDS = EQUIPMENT.map((e) => e.id);
const URGENCY_RANK = { routine: 0, normal: 1, emergency: 2 };
const STAGE_CHANNELS = new Set(["manual", "bulk"]); // Quick Add and Brain dump carry stage hints

/**
 * The parser's one safety net: a lead must never be lost to a parser bug (§8.5). An unexpected
 * error is logged by name only, never with the message text, and the caller gets empty(...args).
 */
function guard(name, read, empty) {
  return (...args) => {
    try {
      return read(...args);
    } catch (err) {
      console.warn(`[parse] ${name} failed (${err?.name ?? "Error"})`);
      return empty(...args);
    }
  };
}

// ---------------------------------------------------------------------------
// Text helpers

const isObject = (v) => v != null && typeof v === "object";

/** Strings as given, numbers as digits; anything else reads as empty text. */
function toText(value) {
  if (typeof value === "string") return value;
  return typeof value === "number" || typeof value === "bigint" ? String(value) : "";
}

/** Bounded, newline- and quote-normalised working copy of an input. */
function normalizeText(value) {
  return toText(value)
    .slice(0, MAX_INPUT)
    .replace(/\r\n?/g, "\n")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[   ]/g, " ");
}

const collapse = (s) => s.replace(/[ \t]+/g, " ").trim();
const alnumLower = (s) => toText(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const digitsOf = (s) => toText(s).replace(/\D/g, "");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordCount = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) || []).length;
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Phones, emails, URLs

const PHONE_SRC = String.raw`(?<!\d)(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b`;
// A seven-digit local number is never the customer's phone (§8.6), but it is still not a problem.
const LOCAL_PHONE_SRC = String.raw`(?<![\d-])\d{3}[-.]\d{4}(?![\d-])`;
const EMAIL_CORE = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`;
// The lookbehind makes a match start only at a token boundary, keeping long inputs linear.
const EMAIL_SRC = String.raw`(?<![A-Za-z0-9._%+-])${EMAIL_CORE}`;
const EMAIL_ONLY_RE = new RegExp(`^${EMAIL_CORE}$`);
const MAX_EMAIL_LENGTH = 254;
const URL_SRC = String.raw`\b(?:https?:\/\/|www\.)\S+`;

/** Lowercased, when `value` is exactly one plain address; anything with "?", "&", "#", ",", ";" or spaces is null. */
export function normalizeEmail(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length <= MAX_EMAIL_LENGTH && EMAIL_ONLY_RE.test(s) ? s.toLowerCase() : null;
}

const RELAY_LOCAL_RE = /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|wordpress|forms?|notifications?|submissions?)(?![a-z0-9])/;
const FORM_SERVICE_RE = /(?:^|[.-])(?:wix|squarespace|jotform|wufoo|typeform|formspree|hubspot)[a-z]*(?=[.-]|$)/;

/**
 * True for an address that speaks for someone else, so it is never a customer's identity:
 * no-reply and system mailers, website-form services, and the owner's own address.
 */
export function isRelayAddress(email, ownerEmail = null) {
  const address = normalizeEmail(email);
  if (!address) return false;
  if (address === normalizeEmail(ownerEmail)) return true;
  const [local, domain] = address.split("@");
  return RELAY_LOCAL_RE.test(local) || FORM_SERVICE_RE.test(domain);
}

function findPhones(text) {
  return [...text.matchAll(new RegExp(PHONE_SRC, "g"))].map((m) => normalizePhone(m[0])).filter(Boolean);
}

/** First phone in the text that is not the owner's, the Twilio number or a tech's. */
function firstCustomerPhone(text, excluded) {
  return findPhones(text).find((p) => !excluded.has(p)) || null;
}

// Header lines quoted inside a body ("From: Frostline Website <forms@...>") name mailers, not customers.
const ADDRESS_HEADER_LINE_RE = /^[\s>*]*(?:from|sender|reply-to|to|cc|bcc)\*?\s*:/i;

/** First customer email in the text: header lines and relay addresses are skipped. */
function firstEmail(text, ownerEmail) {
  for (const line of text.split("\n")) {
    if (ADDRESS_HEADER_LINE_RE.test(line)) continue;
    for (const m of line.matchAll(new RegExp(EMAIL_SRC, "g"))) {
      if (!isRelayAddress(m[0], ownerEmail)) return m[0].toLowerCase();
    }
  }
  return null;
}

function removeContacts(text) {
  return text
    .replace(new RegExp(URL_SRC, "gi"), " ")
    .replace(new RegExp(EMAIL_SRC, "g"), " ")
    .replace(new RegExp(PHONE_SRC, "g"), " ")
    .replace(new RegExp(LOCAL_PHONE_SRC, "g"), " ");
}

const ADDRESS_RE = /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Pkwy|Parkway|Ct|Court|Pl|Place|Hwy|Highway)\b\.?/;

// ---------------------------------------------------------------------------
// Words that are never names, and words that mark a business

const STOP_WORDS = new Set(`
  hi hey hello hiya yo dear good morning afternoon evening thanks thank thx
  i im i'm it its it's this that these those we we're our my you your they he she us me a an
  please can could would will need needs want wants just so also still not no yes yeah ok okay sorry
  any anyone someone somebody when what where who why how is are was there here
  call called calling text texted quote quoted price estimate urgent emergency asap fwd fw re fyi note
  update reminder attn important help question customer job new done scheduled booked
  today tomorrow tonight yesterday monday tuesday wednesday thursday friday saturday sunday
  mon tue tues wed thu thur thurs fri sat sun
  january february march april may june july august september october november december
  jan feb mar apr jun jul aug sep sept oct nov dec
  walk-in walkin walk ice icemaker freezer freezers cooler coolers fridge reach-in reachin prep display
  compressor condenser evaporator machine unit denise from subject sent to date message voicemail missed
`.trim().split(/\s+/));

const BUSINESS_WORDS = new Set(`
  diner grill grille market markets mart cafe café bistro pizza pizzeria grocery groceries deli bakery
  brewing brewery warehouse kitchen restaurant taqueria foods meats storage bar pub hotel wok cucina
  trattoria co co. inc inc. llc tavern steakhouse cafeteria supermarket liquor liquors catering creamery
  butcher seafood sushi bbq farms dairy distributing distributors supply inn club lounge bodega coffee
  roasters cantina eatery smokehouse
`.trim().split(/\s+/));

const CONNECTORS = new Set(["of", "the", "and", "&"]);

/** "Joe's" -> "joe", "Diner," -> "diner", "Co." -> "co". */
const bareWord = (tok) => tok.toLowerCase().replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, "").replace(/'s$/, "");
const isStopWord = (tok) => STOP_WORDS.has(tok.toLowerCase().replace(/[^\p{L}'-]/gu, ""));
const isBusinessWord = (tok) => BUSINESS_WORDS.has(bareWord(tok));
const hasBusinessWord = (s) => toText(s).split(/\s+/).some(isBusinessWord);
const isLoneBusinessWord = (s) => !s.includes(" ") && isBusinessWord(s); // "Deli:" alone names nobody

// Capitalised words in any script: "José", "Café Olé", "Ömer from Döner House".
const CAPITAL_WORD = String.raw`\p{Lu}\p{Ll}+`;
const NAME = String.raw`${CAPITAL_WORD}(?:[ -]${CAPITAL_WORD})?`;
const NAME_END = String.raw`(?![\p{L}\p{N}_'])`;
const BIZ_CHAR = String.raw`[\p{L}\p{N}_'&.#-]`;
const BIZ = String.raw`[\p{Lu}\p{N}]${BIZ_CHAR}*(?:[ \t]+(?:[\p{Lu}\p{N}#]${BIZ_CHAR}*|(?:of|the|and)\b|&)){0,4}`;
const INTRO_WORDS = "[Tt]his is|[Ii]t'?s|[Ii]t is|[Ii]'?m|[Mm]y name is";
const INTRO_NAME_SRC = String.raw`(?:${INTRO_WORDS})\s+(${NAME})${NAME_END}(?:\s+(?:over at|at|from|with)\s+(${BIZ}))?`;
const INTRO_BIZ_SRC = String.raw`(?:${INTRO_WORDS})\s+(${BIZ})`;
const LEAD_NAME_RE = new RegExp(String.raw`^(${NAME})${NAME_END}\s+(?:here\s+)?(?:again\s+)?(?:at|from|with)\s+(${BIZ})`, "u");
const LEAD_BIZ_COLON_RE = new RegExp(String.raw`^(${BIZ})\s*:(?=\s|$)`, "u");
const CLEAN_NAME_RE = new RegExp(String.raw`^(${CAPITAL_WORD})(?:([ -])(${CAPITAL_WORD}))?$`, "u");

/** A captured NAME, or null when it is really a common word ("I'm Calling about..."). */
function cleanName(raw) {
  const m = CLEAN_NAME_RE.exec(toText(raw).trim());
  if (!m) return null;
  const [, first, sep, second] = m;
  if (isStopWord(first) || (first.length >= 6 && first.endsWith("ing"))) return null;
  if (!second || isStopWord(second)) return first;
  return `${first}${sep}${second}`;
}

const STARTS_WITH_PHONE_RE = new RegExp(`^${PHONE_SRC}`);

/**
 * A captured BIZ, trimmed at the first common word or phone number ("Corner Market 312-555-0176"
 * -> "Corner Market") and of trailing connectors/punctuation.
 */
function cleanBiz(raw) {
  const tokens = toText(raw).trim().split(/[ \t]+/).filter(Boolean);
  const kept = [];
  for (const [i, tok] of tokens.entries()) {
    if (isStopWord(tok) || STARTS_WITH_PHONE_RE.test(tokens.slice(i).join(" "))) break;
    kept.push(tok);
  }
  while (kept.length && CONNECTORS.has(kept[kept.length - 1].toLowerCase())) kept.pop();
  if (!kept.length) return null;
  let s = kept.join(" ");
  if (!/\b(?:co|inc|ltd|corp)\.$/i.test(s)) s = s.replace(/[.'#&-]+$/, "");
  if (!/\p{L}/u.test(s) || normalizePhone(s)) return null;
  return s;
}

/** A capitalised run is a business if it has a business word or 2+ words, else a person. */
function classify(run) {
  const tokens = run.split(/\s+/);
  return hasBusinessWord(run) || tokens.length >= 2 ? "business" : "contact";
}

/** Intro at the very start of `s`: {length, contact?, business?, droppable}. */
function leadingIntro(s, opts = {}) {
  let m = new RegExp(`^${INTRO_NAME_SRC}`, "u").exec(s);
  if (m) {
    const name = cleanName(m[1]);
    if (name) {
      const nameEnd = m[0].indexOf(m[1]) + name.length;
      const biz = m[2] ? cleanBiz(m[2]) : null;
      const bizEnd = biz ? m[0].length - m[2].length + biz.length : nameEnd;
      return withHere(s, { length: bizEnd, ...nameParts(name, biz), droppable: true });
    }
  }
  m = new RegExp(`^${INTRO_BIZ_SRC}`, "u").exec(s);
  if (m) {
    const biz = cleanBiz(m[1]);
    if (biz && hasBusinessWord(biz)) {
      return withHere(s, { length: m[0].length - m[1].length + biz.length, business: biz, droppable: true });
    }
  }
  m = LEAD_NAME_RE.exec(s);
  if (m) {
    const name = cleanName(m[1]);
    const biz = cleanBiz(m[2]);
    if (name && biz) return withHere(s, { length: m[0].length - m[2].length + biz.length, contact: name, business: biz, droppable: true });
  }
  m = LEAD_BIZ_COLON_RE.exec(s);
  if (m) {
    const biz = cleanBiz(m[1]);
    if (biz && biz === m[1].trim() && !isLoneBusinessWord(biz)) {
      return { length: m[0].length, [classify(biz)]: biz, droppable: false };
    }
  }
  if (opts.leadingRun) {
    const run = leadingRun(s);
    if (run) return { length: run.length, [run.kind]: run.text, droppable: false };
  }
  return null;
}

function nameParts(name, biz) {
  if (hasBusinessWord(name) && !biz) return { business: name };
  return { contact: name, business: biz || undefined };
}

/** Absorb a trailing " here" ("Dave from Hillside Grocery here, ..."). */
function withHere(s, intro) {
  const here = /^\s+here\b/i.exec(s.slice(intro.length));
  return here ? { ...intro, length: intro.length + here[0].length } : intro;
}

const RUN_TOKEN_RE = /^\p{Lu}[\p{L}\p{N}_'&.-]*$/u;
const LOWERCASE_NEXT_WORD_RE = /^[ \t]+(\p{Ll}+)(?![\p{L}\p{N}])/u;

/**
 * Quick Add / notebook lines: the leading run of up to 4 capitalised tokens
 * ("Dave's Deli 312-..." -> business "Dave's Deli"; "Gus ice machine..." -> contact "Gus").
 */
function leadingRun(s) {
  const tokenRe = /([^\s,;:!?()]+)([,;:!?]?)/y;
  const tokens = [];
  let pos = s.length - s.trimStart().length;
  let end = pos;
  while (tokens.length < 4) {
    tokenRe.lastIndex = pos;
    const m = tokenRe.exec(s);
    if (!m) break;
    let tok = m[1];
    const sentenceEnd = tok.endsWith(".") && !/^(co|inc)\.$/i.test(tok);
    if (sentenceEnd) tok = tok.replace(/\.+$/, "");
    if (!isRunToken(tok)) break;
    tokens.push(tok);
    end = m.index + tok.length;
    if (m[2] || sentenceEnd) break;
    pos = tokenRe.lastIndex;
    const gap = /^[ \t]+/.exec(s.slice(pos));
    if (!gap) break;
    pos += gap[0].length;
  }
  if (tokens.length === 0 || (tokens.length === 1 && /^the$/i.test(tokens[0]))) return null;
  // A lowercase business word right after the run belongs to it ("Lakeview brewing").
  const next = LOWERCASE_NEXT_WORD_RE.exec(s.slice(end));
  if (next && tokens.length < 4 && isBusinessWord(next[1]) && !isBusinessWord(tokens[tokens.length - 1])) {
    tokens.push(capitalize(next[1]));
    end += next[0].length;
  }
  if (tokens.length === 1 && isLoneBusinessWord(tokens[0])) return null; // "Deli case leaking"
  const text = tokens.join(" ");
  return { text, length: end, kind: classify(text) };
}

function isRunToken(tok) {
  if (tok === "&" || /^#\d+$/.test(tok)) return true;
  if (!RUN_TOKEN_RE.test(tok)) return false;
  return !isStopWord(tok) || /^the$/i.test(tok);
}

// ---------------------------------------------------------------------------
// Forwarded texts (§7.1 step 3)

const FORWARD_MARKER_RE = /^\s*(?:begin forwarded message:?|-{2,}\s*original message\s*-{2,}|-{2,}\s*forwarded message\s*-{2,})\s*$/i;
const FORWARD_PREFIX_RE = /^\s*(?:fwd?|fw)\s*:\s*/i;
const FROM_PHONE_LINE_RE = new RegExp(
  String.raw`^\s*(?:From|FROM|from):?\s+(?:(${NAME})\s*[,-]?\s*)?((?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b\s*:?\s*(.*)$`,
  "u",
);

function readForward(text, ownerPhone) {
  const owner = normalizePhone(ownerPhone);
  let s = normalizeText(text);
  let forwarded = false;
  if (FORWARD_PREFIX_RE.test(s)) {
    s = s.replace(FORWARD_PREFIX_RE, "");
    forwarded = true;
  }
  let phone = null;
  let name = null;
  const lines = [];
  for (const line of s.split("\n")) {
    if (FORWARD_MARKER_RE.test(line)) {
      forwarded = true;
      continue;
    }
    const m = phone || name ? null : FROM_PHONE_LINE_RE.exec(line);
    if (m) {
      const p = normalizePhone(m[2]);
      phone = p && p !== owner ? p : null;
      name = m[1] ? cleanName(m[1]) || m[1] : null;
      forwarded = true;
      if (m[3].trim()) lines.push(m[3]);
      continue;
    }
    lines.push(line);
  }
  return { body: lines.join("\n").trim(), phone, name, forwarded };
}

/**
 * Strips forwarding wrappers and captures the original sender.
 * @returns {{body: string, phone: string|null, name: string|null, forwarded: boolean}}
 */
export const unwrapForward = guard("unwrapForward", readForward,
  (text) => ({ body: normalizeText(text).trim(), phone: null, name: null, forwarded: false }));

// ---------------------------------------------------------------------------
// Form labels and email headers

// Label text is compared lowercased with everything but letters and digits removed ("Phone #" -> phone).
const LABEL_FIELDS = {
  name: "contact_name", fullname: "contact_name", yourname: "contact_name", contactname: "contact_name",
  firstname: "first_name", lastname: "last_name", surname: "last_name",
  business: "business_name", company: "business_name", companyname: "business_name", yourcompany: "business_name",
  restaurant: "business_name", store: "business_name", businessname: "business_name",
  phone: "phone", phonenumber: "phone", yourphone: "phone", telephone: "phone", tel: "phone", mobile: "phone", cell: "phone",
  email: "email", emailaddress: "email", youremail: "email",
  address: "address", serviceaddress: "address", location: "address",
  message: "message", yourmessage: "message", details: "message", comments: "message", description: "message",
  howcanwehelp: "message", howcanwehelpyou: "message", whatsgoingon: "message", issue: "message", problem: "message",
};
// These take one line; message and address run until the next label.
const SINGLE_LINE_FIELDS = new Set(["contact_name", "first_name", "last_name", "business_name", "phone", "email"]);
const HEADER_KEYS = new Set(["from", "to", "cc", "bcc", "subject", "date", "sent", "replyto", "messageid"]);
const LABEL_TEXT = String.raw`[A-Za-z][A-Za-z ?'/#-]{0,30}?`;
// "Label: value", or "Label<tab>value" from an HTML table row (see server/adapters.js htmlToText).
const LABEL_LINE_RE = new RegExp(String.raw`^\s*(${LABEL_TEXT})(?:\s*:|[ ]*\t)\s*(.*)$`);
// A label alone on its line, its value on the next one (forms laid out as label/value rows).
const BARE_LABEL_RE = new RegExp(String.raw`^\s*(${LABEL_TEXT})\s*:?\s*$`);
const INLINE_LABEL_SPLIT_RE = new RegExp(String.raw`(?<![ \t])[ \t]+[/|][ \t]+(?=(${LABEL_TEXT})\s*:)`, "g");
const labelKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The form field a label names ("Phone Number" -> "phone", "Last Name" -> "last_name"), or null. */
export function formFieldFor(label) {
  return LABEL_FIELDS[labelKey(toText(label))] ?? null;
}

/** "Name: Tony / Business: Tony's Bistro" -> one label per line. */
function formLines(text) {
  return text.replace(INLINE_LABEL_SPLIT_RE, (sep, label) => (formFieldFor(label) ? "\n" : sep)).split("\n");
}

/** {field, value} for a form label line, {header, value} for an email header line, else null. */
function readLabel(line, allowBare) {
  const m = LABEL_LINE_RE.exec(line) ?? (allowBare ? BARE_LABEL_RE.exec(line) : null);
  if (!m) return null;
  const key = labelKey(m[1]);
  const value = (m[2] ?? "").trim();
  if (LABEL_FIELDS[key]) return { field: LABEL_FIELDS[key], value };
  return HEADER_KEYS.has(key) ? { header: key, value } : null;
}

function labelledFields(lines, allowBare) {
  const found = new Set();
  for (const line of lines) {
    const label = readLabel(line, allowBare);
    if (label?.field) found.add(label.field);
  }
  return found;
}

/** Bare label lines count only in text that is clearly a form (2+ different fields labelled). */
const isFormLayout = (lines) => labelledFields(lines, true).size >= 2;

/** True when the text labels 2+ different form fields, as a website-form notification does. */
export const looksLikeForm = guard("looksLikeForm", (text) => isFormLayout(formLines(normalizeText(text))), () => false);

/** Splits labelled fields from the rest. */
function parseLabels(body) {
  const lines = formLines(body);
  const allowBare = isFormLayout(lines);
  const fields = {};
  const headers = {};
  const rest = [];
  let current = null; // the field still collecting lines
  for (const line of lines) {
    const label = readLabel(line, allowBare);
    if (label?.field) {
      fields[label.field] = label.value;
      current = label.value && SINGLE_LINE_FIELDS.has(label.field) ? null : label.field;
    } else if (label?.header) {
      headers[label.header] = label.value;
      current = null;
    } else if (current) {
      if (!line.trim()) continue;
      fields[current] = fields[current] ? `${fields[current]}\n${line.trim()}` : line.trim();
      if (SINGLE_LINE_FIELDS.has(current)) current = null;
    } else {
      rest.push(line);
    }
  }
  for (const k of Object.keys(fields)) if (!fields[k]) delete fields[k];
  return { fields, headers, rest };
}

/** Already-labelled website-form fields ({"Your Name": "...", ...}) mapped onto the same keys. */
function formFieldValues(formFields) {
  const out = {};
  if (!isObject(formFields)) return out;
  for (const [k, v] of Object.entries(formFields)) {
    const field = formFieldFor(k);
    const value = toText(v).trim();
    if (field && value && !out[field]) out[field] = normalizeText(value);
  }
  return out;
}

/** "Jo" + "King" -> "Jo King" (forms that split the name). */
function joinName(first, last) {
  return [first, last].map((s) => collapse(s ?? "")).filter(Boolean).join(" ") || null;
}

// ---------------------------------------------------------------------------
// Content: the human-written part (no labels, headers, signatures or attachments)

const SIGN_OFF_RE = /^(?:thanks|thank you|thx|ty|cheers|regards|best regards|best|sincerely|appreciate it)\b[\s,!.]*$/i;
const SIGNATURE_LINE_RE = new RegExp(String.raw`^\s*[-–—~]\s*(${NAME})\s*(?:,\s*(${BIZ}))?\s*$`, "u");
const SIGN_OFF_NAME_RE = new RegExp(String.raw`^\s*(?:thanks|thank you|thx|cheers|regards|best)[,!.]?\s+(${NAME})[.!]?\s*$`, "iu");
const NOISE_LINE_RE = /^\s*(?:sent from my .*|\[photo attached\]|\(voicemail - no transcript yet\))\s*$/i;

/** Removes signature blocks and noise lines; returns the content and any signed name. */
function contentFrom(lines) {
  const kept = [];
  for (const line of lines) {
    if (/^\s*--\s*$/.test(line)) break; // email signature block
    if (NOISE_LINE_RE.test(line)) continue;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  let signedName = null;
  const last = kept.length ? kept[kept.length - 1] : "";
  const prev = kept.length > 1 ? kept[kept.length - 2].trim() : "";
  let m = SIGNATURE_LINE_RE.exec(last);
  if (m && cleanName(m[1])) {
    signedName = { contact: cleanName(m[1]), business: m[2] ? cleanBiz(m[2]) : null };
    kept.pop();
  } else if ((m = SIGN_OFF_NAME_RE.exec(last)) && cleanName(m[1])) {
    signedName = { contact: cleanName(m[1]) };
    kept.pop();
  } else if (SIGN_OFF_RE.test(prev) && cleanName(last.trim())) {
    signedName = { contact: cleanName(last.trim()) };
    kept.splice(-2, 2);
  }
  return { content: kept.join("\n").trim(), signedName };
}

// ---------------------------------------------------------------------------
// Names (§8.6 "Names")

const EMAIL_DISPLAY_RE = /^\s*from:\s*"?([^"<\n]+?)"?\s*<([^>\n]*@[^>\n]*)>/im;

function findNames({ content, raw, signedName, forwardName, channel, ownerEmail }) {
  const out = { contact_name: null, business_name: null };
  const put = (key, value) => {
    if (value && !out[key]) out[key] = value;
  };
  const keyFor = (kind) => (kind === "business" ? "business_name" : "contact_name");

  if (forwardName) put(keyFor(classify(forwardName)), forwardName);

  // 1. Intro patterns in the first 200 characters, then ^NAME from BIZ / ^BIZ: at the start.
  const head = content.slice(0, 200);
  const intro = searchIntro(head) || leadingIntro(stripGreeting(collapse(firstLine(content))));
  if (intro) {
    put("contact_name", intro.contact);
    put("business_name", intro.business);
  }
  // 2. Signature: a last line of "- NAME".
  if (signedName) {
    put("contact_name", signedName.contact);
    put("business_name", signedName.business);
  }
  // 3. Email display name: "From: Name <email>", unless the address is a mailer's ("Frostline Website").
  const display = EMAIL_DISPLAY_RE.exec(raw);
  if (display && !isRelayAddress(display[2], ownerEmail)) {
    const value = collapse(display[1]);
    if (cleanName(value) === value) put("contact_name", value);
    else if (hasBusinessWord(value)) put("business_name", value);
  }
  // 4. Quick Add and notebook lines: the leading capitalised run.
  if (!out.contact_name && !out.business_name && isStageChannel(channel)) {
    const run = leadingRun(collapse(firstLine(content)));
    if (run) put(keyFor(run.kind), run.text);
  }
  return out;
}

/** First valid "this is NAME (at BIZ)" / "it's BIZ" anywhere in the text. */
function searchIntro(text) {
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}'])${INTRO_NAME_SRC}`, "gu"))) {
    const name = cleanName(m[1]);
    if (name) return nameParts(name, m[2] ? cleanBiz(m[2]) : null);
  }
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}'])${INTRO_BIZ_SRC}`, "gu"))) {
    const biz = cleanBiz(m[1]);
    if (biz && hasBusinessWord(biz)) return { business: biz };
  }
  return null;
}

const firstLine = (s) => s.split("\n").find((l) => l.trim()) || "";
const isStageChannel = (channel) => channel == null || STAGE_CHANNELS.has(channel);

// ---------------------------------------------------------------------------
// Equipment and urgency (§8.6)

const EQUIPMENT_RULES = [
  ["ice_machine", /\b(?:ice (?:machine|maker)s?|icemakers?|(?:no|not making|isn'?t making|stopped making) ice)\b/i],
  ["display_case", /\b(?:display case|deli case|merchandiser)s?\b/i],
  ["prep_table", /\b(?:prep (?:table|cooler)|pizza table|sandwich (?:unit|table)|make ?line)s?\b/i],
  ["reach_in", /\b(?:reach[- ]?in|under ?counter)s?\b/i],
  ["walk_in_freezer", /\bfreez(?:e?r|or)s?\b/i], // also the common typos "freezr", "freezor"
  ["walk_in_cooler", /\b(?:walk[- ]?in|cooler|fridge|refrigerator)s?\b/i],
  ["other", /\b(?:compressor|condens(?:er|ing unit)|evaporator)s?\b/i],
];

function equipmentIn(s) {
  return EQUIPMENT_RULES.find(([, re]) => re.test(s))?.[0] ?? null;
}

/** First matching equipment id, or null. */
export const detectEquipment = guard("detectEquipment", (text) => equipmentIn(normalizeText(text)), () => null);

const URGENT_RULES = [
  // Equipment down
  /\bdown\b/gi,
  /\bnot (?:cooling|cold|freezing|working|holding(?: temp(?:erature)?)?)\b/gi,
  /\bisn'?t (?:cooling|cold|freezing|working)\b/gi,
  /\bwon'?t (?:cool|freeze|get cold)\b/gi,
  /\bstopped (?:working|cooling)\b/gi,
  /\b(?:not|isn'?t|stopped) making ice\b/gi,
  // Temperature rising, leaks and alarms
  /\bwarm(?:ing|er)?\b/gi,
  /\bthaw(?:s|ing|ed)?\b/gi,
  /\bmelt(?:s|ing|ed)?\b/gi,
  /\bclimbing\b/gi,
  /\brising\b/gi,
  /\bleak(?:s|ing|ed)?\b/gi,
  /\bflood(?:s|ing|ed)?\b/gi,
  /\biced (?:up|over)\b/gi,
  /\balarms?\b/gi,
  // Product at risk
  /\bspoil(?:s|ing|ed)?\b/gi,
  /\b(?:losing|lose|lost) (?:product|food|stock)\b/gi,
  /\b(?:food|product) (?:is )?at risk\b/gi,
  // Asked for speed
  /\bemergency\b/gi,
  /\burgent(?:ly)?\b/gi,
  /\basap\b/gi,
  /\bas soon as (?:possible|you can)\b/gi,
  /\bright away\b/gi,
  /\btoday\b/gi,
  /\btonight\b/gi,
  // Inspections
  /\bhealth (?:inspector|inspection)\b/gi,
  /\binspection\b/gi,
];
const TEMP_RULES = [
  /(?<![\w.])(-?\d{1,3})\s*(?:°|º|degrees?\b|deg\b)\s*(?:f(?![a-z]))?/gi,
  /(?<![\w.])(-?\d{1,3})\s*f(?![a-z])/gi,
];
const COLD_HOLDING = new Set(["walk_in_cooler", "reach_in", "prep_table", "display_case"]);

function urgencyIn(s, equipment) {
  const found = [];
  for (const re of URGENT_RULES) for (const m of s.matchAll(re)) found.push({ index: m.index, text: m[0] });
  const limit = temperatureLimit(s, equipment);
  if (limit != null) {
    for (const re of TEMP_RULES) {
      for (const m of s.matchAll(re)) if (Number(m[1]) > limit) found.push({ index: m.index, text: m[0] });
    }
  }
  found.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const hits = [];
  let covered = -1;
  for (const f of found) {
    if (f.index < covered) continue; // overlaps an earlier hit
    const hit = collapse(f.text.toLowerCase());
    if (!hits.includes(hit)) hits.push(hit);
    covered = f.index + f.text.length;
  }
  return { urgent: hits.length > 0, hits };
}

/** Urgency keywords and the temperature rule. Hits are in text order, lowercased. */
export const detectUrgency = guard("detectUrgency", (text, equipment) => urgencyIn(normalizeText(text), equipment),
  () => ({ urgent: false, hits: [] }));

/** Above 10°F in a freezer, above 41°F in a cooler; no rule without equipment. */
function temperatureLimit(s, equipment) {
  if (equipment === "walk_in_freezer" || (equipment && /\bfreez/i.test(s))) return 10;
  if (COLD_HOLDING.has(equipment)) return 41;
  return null;
}

const ROUTINE_RE = /\b(?:quote|price|estimate|maintenance|clean(?:ing)?|descale|no rush|whenever|next (?:week|month)|new (?:ice machine|walk-in|unit))\b|(?<!\d\s?)\bPM\b/i;

function urgencyLevel(urgent, text) {
  if (urgent) return "emergency";
  return ROUTINE_RE.test(text) ? "routine" : "normal";
}

// ---------------------------------------------------------------------------
// Summary -> problem (§8.6 "Summary")

const GREETING_RE = /^(?:hi|hey|hello|hiya|yo|good (?:morning|afternoon|evening))\b[,!.]?\s*(?:(?:denise|there|guys|all)\b[,!.]?\s*)?/i;
const LEADING_FILLER_RE = /^(?:our|my|the)\s+/i;
const LEADING_WANT_RE = /^(?:wants|needs|is asking for|asking for|looking for|would like|want|need)\s+/i;
const LEADING_ARTICLE_RE = /^(?:a|an|the)\s+/i;
const ASK_SRC = String.raw`(?:can|could|would|will) (?:you(?: guys| all)?|someone|somebody|u)\b`;
const TRAILING_ASK_RE = new RegExp(String.raw`,?\s*\b${ASK_SRC}.*$`, "i");
const LEADING_ASK_RE = new RegExp(String.raw`^(?:please\s+)?${ASK_SRC}\s*(?:please\s+)?`, "i");
// What is left of "..., call me at 312-555-0181" once the number is removed.
const TRAILING_CALL_ME_RE = /,?\s*\b(?:please\s+)?call (?:me|us)(?: back)?(?: (?:at|on))?$/i;

const stripGreeting = (s) => s.replace(GREETING_RE, "").trim();

/** Sentences split on [.!?] (followed by a space or the end) or a newline, punctuation kept. */
function splitSentences(text) {
  const out = [];
  for (const line of text.split("\n")) {
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const s = collapse(part);
      if (s) out.push(s);
    }
  }
  return mergeFalseBreaks(out);
}

/** Re-joins pieces split on a dot that was not a sentence end ("28.5", "Co.", "#2."). */
function mergeFalseBreaks(parts) {
  const out = [];
  for (const p of parts) {
    if (out.length && /\b(?:co|inc|st|ave|mr|mrs|ms|dr|no)\.$/i.test(out[out.length - 1])) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

// Trailing punctuation, spaces and emoji (anything but letters, digits and closing brackets/quotes).
const stripEndPunct = (s) => s.replace(/(?<![^\p{L}\p{N})\]%"'])[^\p{L}\p{N})\]%"']+$/u, "");
const isSignOffSentence = (s) => SIGN_OFF_RE.test(s) || SIGN_OFF_NAME_RE.test(s) || /^-+$/.test(s);

/** "Can you send someone?" asks for help without saying what for. */
function isBareAsk(s) {
  const ask = LEADING_ASK_RE.exec(s);
  return ask != null && wordCount(s.slice(ask[0].length)) < 3;
}

/**
 * Problem (<= 60 chars) and details (the original sentences after it) from the content.
 * `strip` (notebook lines) removes phrases already read into other fields.
 */
function summarize(content, { leadingRun: useRun, address, strip }) {
  const originals = splitSentences(content);
  const cleaned = originals.map((s) => collapse(removeContacts(address ? s.split(address).join(" ") : s)));
  const isMeaningful = (x) => x && !isSignOffSentence(x);
  const moreAfter = []; // moreAfter[i]: a meaningful sentence follows sentence i
  for (let i = cleaned.length - 1, seen = false; i >= 0; i--) {
    moreAfter[i] = seen;
    seen ||= Boolean(isMeaningful(cleaned[i]));
  }
  for (let i = 0; i < cleaned.length; i++) {
    let s = stripGreeting(stripEndPunct(cleaned[i]));
    if (!s) continue;
    const intro = leadingIntro(s, { leadingRun: useRun && i === 0 }) || looseIntro(s);
    if (intro) {
      let rest = s.slice(intro.length);
      const afterComma = /^\s*,/.test(rest);
      rest = stripGreeting(rest.replace(/^[\s,:;.!–—-]+/, ""));
      if (!rest) continue;
      if (intro.droppable && !afterComma && wordCount(rest) < 4 && moreAfter[i]) continue;
      s = rest;
    }
    if (isSignOffSentence(s) || (isBareAsk(s) && moreAfter[i])) continue;
    const problem = finishProblem(strip ? strip(s) : s);
    if (!problem) continue;
    const details = originals.slice(i + 1).filter(isMeaningful).join(" ");
    return { problem, details: details ? shorten(details, 280) : null };
  }
  return { problem: null, details: null };
}

// All-lowercase intro followed by a comma ("its marco from bella cucina, walk in ..."): stripped
// from the summary only (lowercase texts never yield names).
const LOOSE_INTRO_RE = /^(?:this is|it'?s|i'?m|my name is) ([a-z]+)(?: [a-z]+)? (?:over at|at|from|with) [^,]{1,40}(?=,)/i;

function looseIntro(s) {
  const m = LOOSE_INTRO_RE.exec(s);
  if (!m || isStopWord(m[1]) || /(?:ing|ed)$/i.test(m[1])) return null;
  return { length: m[0].length, droppable: false };
}

/** Drops the ask: a leading "Can you" ("Can you come look at it" -> "come look at it"), else a trailing ", can someone come?". */
function withoutAsk(s) {
  const ask = LEADING_ASK_RE.exec(s);
  return ask ? s.slice(ask[0].length) : s.replace(TRAILING_ASK_RE, "");
}

function finishProblem(sentence) {
  let s = sentence.replace(LEADING_FILLER_RE, "");
  s = s.replace(LEADING_WANT_RE, "").replace(LEADING_ARTICLE_RE, "");
  s = withoutAsk(s);
  s = stripEndPunct(s).replace(TRAILING_CALL_ME_RE, "").replace(/\s+(?:at|on|@)$/i, "");
  s = stripEndPunct(collapse(s));
  if (!s || !/[\p{L}\p{N}]/u.test(s)) return null;
  return capitalize(shorten(s, 60));
}

// ---------------------------------------------------------------------------
// Dates: callback day, visit day, quote-sent day

const DAY_SRC = String.raw`\b(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday|s)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b`;
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const dayIndexOf = (word) => DAY_INDEX[word.toLowerCase().slice(0, 3)];
const CALLBACK_RE = new RegExp(String.raw`\bcall (?:(?:me|him|her|them|us) )?(?:back )?(?:on )?(?:(tomorrow)\b|${DAY_SRC})`, "i");
const MONTH_DAY_RE = /(?<![\d/])(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?:\/(\d{2}|\d{4}))?(?![\d/])/;

function todayOf(ctx) {
  return ctx.now ? localDate(ctx.now, ctx.tz || DEFAULT_TZ) : null;
}

/** The first date on or after (or strictly after) `today` with weekday `wd`. */
function nextWeekday(today, wd, { strict }) {
  const start = strict ? 1 : 0;
  for (let i = start; i < start + 7; i++) {
    const d = addDays(today, i);
    if (weekdayOf(d) === wd) return d;
  }
  return null;
}

function lastWeekdayOnOrBefore(today, wd) {
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, -i);
    if (weekdayOf(d) === wd) return d;
  }
  return null;
}

/** "call me back Thursday" / "call back tomorrow" -> the next such date after today. */
function callbackDate(text, today) {
  if (!today) return null;
  const m = CALLBACK_RE.exec(text);
  if (!m) return null;
  if (m[1]) return addDays(today, 1);
  return nextWeekday(today, dayIndexOf(m[2]), { strict: true });
}

/** Visit day: the earliest of a named day (on or after today), today, tomorrow or M/D. */
function visitDate(text, today) {
  if (!today) return null;
  const candidates = [];
  const day = new RegExp(DAY_SRC, "i").exec(text);
  if (day) candidates.push({ index: day.index, ymd: nextWeekday(today, dayIndexOf(day[1]), { strict: false }) });
  const rel = /\b(today|tomorrow)\b/i.exec(text);
  if (rel) candidates.push({ index: rel.index, ymd: addDays(today, rel[1].toLowerCase() === "today" ? 0 : 1) });
  const md = MONTH_DAY_RE.exec(text);
  if (md) {
    const ymd = monthDayToYmd(md, today);
    if (ymd) candidates.push({ index: md.index, ymd });
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates.length ? candidates[0].ymd : null;
}

/** M/D in the current year; a date more than ~6 months back means next year. */
function monthDayToYmd(m, today) {
  const [month, day] = [Number(m[1]), Number(m[2])];
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(today.slice(0, 4));
  const pad = (n) => String(n).padStart(2, "0");
  let ymd = `${year}-${pad(month)}-${pad(day)}`;
  const check = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== day) return null;
  if (!m[3] && ymd < addDays(today, -180)) {
    year += 1;
    ymd = `${year}-${pad(month)}-${pad(day)}`;
  }
  return ymd;
}

/** The latest named weekday (or "yesterday") on or before today at 12:00 local, else now. */
function quoteSentAt(text, today, ctx) {
  const tz = ctx.tz || DEFAULT_TZ;
  const day = new RegExp(DAY_SRC, "i").exec(text);
  const yesterday = /\byesterday\b/i.exec(text);
  let ymd = null;
  if (day && (!yesterday || day.index < yesterday.index)) ymd = lastWeekdayOnOrBefore(today, dayIndexOf(day[1]));
  else if (yesterday) ymd = addDays(today, -1);
  return ymd ? atLocal(ymd, "12:00", tz) : ctx.now;
}

// ---------------------------------------------------------------------------
// Stage hints for Quick Add and notebook lines (§8.6 "Notebook lines")

const STAGE_RULES = [
  ["done", /\b(?:done|finished|completed)\b/i],
  ["scheduled", /\b(?:scheduled|booked|going out|coming out|on the schedule)\b/i],
  ["to_schedule", /\b(?:said yes|approved|go ahead|needs? (?:a )?(?:date|scheduling)|to schedule)\b/i],
  ["waiting_yes", /\b(?:quoted|sent (?:a |the )?quote|quote sent|waiting on (?:their )?yes)\b|\$\s?\d/i],
  ["quote", /\b(?:(?:needs?|wants?) (?:a )?(?:quote|price)|quote|price|estimate)\b/i],
];

const DOLLAR_AMOUNT_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s?(k)\b)?/i;
const BARE_AMOUNT_RE = /(?<![\d,.#/:$-])(\d{1,3}(?:,\d{3})+|\d{3,6})(?!\d|,\d|\s*(?:°|º|degrees?\b|deg\b|f\b|am\b|pm\b)|[/:])/i;
const K_AMOUNT_RE = /(?<![\d.])(\d{1,3}(?:\.\d)?)\s?k\b/i;

/** Dollar amount: "$1,800", "$2k", or (when bare numbers count) "1800", "1.8k". */
function amountFrom(text, { allowBare }) {
  const dollar = DOLLAR_AMOUNT_RE.exec(text);
  if (dollar) {
    const n = Number(dollar[1].replace(/,/g, "")) + (dollar[2] ? Number(`0.${dollar[2]}`) : 0);
    return Math.round(dollar[3] ? n * 1000 : n);
  }
  if (!allowBare) return null;
  const k = K_AMOUNT_RE.exec(text);
  if (k) return Math.round(Number(k[1]) * 1000);
  const bare = BARE_AMOUNT_RE.exec(text.replace(MONTH_DAY_RE, " "));
  return bare ? Number(bare[1].replace(/,/g, "")) : null;
}

function stageFields(text, rawLine, today, ctx) {
  const stage = (STAGE_RULES.find(([, re]) => re.test(text)) || ["new"])[0];
  const out = { stage_hint: stage, quote_amount: null, quote_sent_at: null, visit_date: null, tech: null };
  out.quote_amount = amountFrom(text, { allowBare: stage === "waiting_yes" });
  if (stage === "waiting_yes" && today) out.quote_sent_at = quoteSentAt(text, today, ctx);
  if (stage === "scheduled") {
    out.visit_date = visitDate(text, today);
    out.tech = techIn(rawLine, ctx.techs);
  }
  return out;
}

function techList(techs) {
  if (!Array.isArray(techs)) return [];
  return techs
    .map((t) => (typeof t === "string" ? { name: t, phone: null } : { name: toText(t?.name), phone: t?.phone ?? null }))
    .filter((t) => t.name.trim());
}

/** The first settings tech named in the line (by position). */
function techIn(text, techs) {
  let best = null;
  for (const t of techList(techs)) {
    const m = new RegExp(`\\b${escapeRe(t.name.trim())}\\b`, "i").exec(text);
    if (m && (!best || m.index < best.index)) best = { index: m.index, name: t.name.trim() };
  }
  return best ? best.name : null;
}

// Notebook lines: what stageFields and callbackDate read, so the row's problem doesn't repeat it
// ("Joe's Diner walk-in, quoted 1800 tues, waiting" -> "Walk-in").
const ON_DAY_SRC = String.raw`(?:\b(?:on|for|next|this)\s+)?`;
const NOTEBOOK_PHRASES = {
  every: [DOLLAR_AMOUNT_RE, CALLBACK_RE],
  waiting_yes: [K_AMOUNT_RE, BARE_AMOUNT_RE, /\bwaiting\b(?: on (?:their |the |a )?(?:yes|answer|reply))?/,
    new RegExp(ON_DAY_SRC + DAY_SRC), /\byesterday\b/],
  scheduled: [new RegExp(ON_DAY_SRC + DAY_SRC), new RegExp(String.raw`${ON_DAY_SRC}\b(?:today|tomorrow)\b`),
    new RegExp(ON_DAY_SRC + MONTH_DAY_RE.source)],
};

function notebookPhrases(stage, techs) {
  const stageWords = STAGE_RULES.find(([id]) => id === stage)?.[1];
  const techNames = stage === "scheduled"
    ? techList(techs).map((t) => new RegExp(String.raw`(?:\b(?:with|w\/)\s+)?\b${escapeRe(t.name.trim())}\b`))
    : [];
  return [...NOTEBOOK_PHRASES.every, ...(stageWords ? [stageWords] : []), ...(NOTEBOOK_PHRASES[stage] ?? []), ...techNames];
}

function withoutNotebookPhrases(s, stage, techs) {
  let out = s;
  for (const re of notebookPhrases(stage, techs)) out = out.replace(new RegExp(re.source, "gi"), " ");
  return collapse(out)
    .replace(/\s+([,;:])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/^[\s,;:.-]+/, "");
}

// ---------------------------------------------------------------------------
// parseMessage

/** The Parse fields a Quick Add or Brain dump preview shows and saves (server and browser share this list). */
export const PARSE_FIELDS = Object.freeze([
  "contact_name", "business_name", "phone", "email", "address", "equipment", "problem", "details", "urgent",
]);

function emptyParse() {
  return {
    contact_name: null, business_name: null, phone: null, email: null, address: null,
    equipment: null, problem: null, details: null, urgent: false, urgent_hits: [], urgency: "normal",
    callback_date: null, quote_amount: null, stage_hint: null, visit_date: null, tech: null,
    quote_sent_at: null, parsed_by: "rules",
  };
}

function readMessage(text, opts) {
  const channel = opts.channel ?? null;
  const owner = normalizePhone(opts.owner_phone);
  const ownerEmail = opts.owner_email ?? null;
  const excluded = new Set([owner, normalizePhone(opts.twilio_from), ...techList(opts.techs).map((t) => normalizePhone(t.phone))].filter(Boolean));

  const fwd = readForward(text, owner);
  const { fields: labelled, headers, rest } = parseLabels(fwd.body);
  const fields = { ...labelled, ...formFieldValues(opts.form_fields) };
  const { content: freeText, signedName } = contentFrom(rest);
  const content = fields.message || freeText || headers.subject || "";

  const names = findNames({ content, raw: fwd.body, signedName, forwardName: fwd.name, channel, ownerEmail });
  const contact_name = fields.contact_name ? collapse(fields.contact_name) : joinName(fields.first_name, fields.last_name) ?? names.contact_name;
  const business_name = fields.business_name ? collapse(fields.business_name) : names.business_name;

  const detection = withoutNames(removeContacts([content, headers.subject].filter(Boolean).join("\n")), [contact_name, business_name]);
  const equipment = equipmentIn(detection);
  const { urgent, hits } = urgencyIn(detection, equipment);
  const address = fields.address ? collapse(fields.address) : (ADDRESS_RE.exec(content)?.[0] ?? null);
  const today = todayOf(opts);
  const stage = isStageChannel(channel) ? stageFields(detection, content, today, opts) : null;
  const strip = channel === "bulk" ? (s) => withoutNotebookPhrases(s, stage.stage_hint, opts.techs) : null;
  const { problem, details } = summarize(content, { leadingRun: isStageChannel(channel), address, strip });

  return {
    ...emptyParse(),
    contact_name: contact_name || null,
    business_name: business_name || null,
    phone: pickPhone({ channel, sender: normalizePhone(opts.from_phone), fwd, fields, body: fwd.body, excluded }),
    email: firstEmail(fields.email ?? "", ownerEmail) ?? firstEmail(fwd.body, ownerEmail),
    address,
    equipment,
    problem,
    details,
    urgent,
    urgent_hits: hits,
    urgency: urgencyLevel(urgent, detection),
    callback_date: callbackDate(detection, today),
    ...stage,
  };
}

/**
 * Rule-based parse of one inbound message or Quick Add text.
 * @param {string} text
 * @param {{channel?, from_phone?, owner_phone?, owner_email?, twilio_from?, form_fields?, techs?, now?, tz?}} [opts]
 *   A missing channel is treated like Quick Add ('manual'): stage hints and the leading-name rule apply.
 * @returns {object} Parse (see SPEC §8.6)
 */
export const parseMessage = guard("parseMessage", (text, opts) => readMessage(text, isObject(opts) ? opts : {}), emptyParse);

/** SMS/call sender, then the forwarded sender, then the Phone: field, then the first number in the text. */
function pickPhone({ channel, sender, fwd, fields, body, excluded }) {
  if ((channel === "sms" || channel === "call") && sender && !excluded.has(sender)) return sender;
  if (fwd.phone && !excluded.has(fwd.phone)) return fwd.phone;
  if (fields.phone) {
    const p = firstCustomerPhone(fields.phone, excluded) || normalizePhone(fields.phone);
    if (p && !excluded.has(p)) return p;
  }
  return firstCustomerPhone(body, excluded);
}

/** Removes the detected names so "Down Home Diner" or "Sun Market" don't trigger rules. */
function withoutNames(text, names) {
  let s = text;
  for (const name of names) if (name) s = s.replace(new RegExp(escapeRe(name), "gi"), " ");
  return s;
}

// ---------------------------------------------------------------------------
// mergeParse (§8.5 guardrails)

/** True when the value's letters and digits, lowercased, appear in the raw text's. */
function grounded(value, rawAlnum) {
  const v = alnumLower(value);
  return v.length > 0 && rawAlnum.includes(v);
}

/** National digits of an E.164 number (drops the +1 country code). */
function nationalDigits(e164) {
  const d = digitsOf(e164);
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The rules parse in merged form, as when the AI added nothing. */
function rulesOnly(rules) {
  const base = { ...emptyParse(), ...(isObject(rules) ? rules : {}) };
  return {
    ...base, urgent: Boolean(base.urgent), urgent_source: base.urgent ? "rules" : null,
    ai_not_service: 0, urgency_reason: null, parsed_by: "rules",
  };
}

function mergeWithAI(rules, ai, raw, rawOpts) {
  const opts = isObject(rawOpts) ? rawOpts : {};
  const merged = rulesOnly(rules);
  if (!isObject(ai)) return merged;

  const rawText = normalizeText(raw);
  const rawAlnum = alnumLower(rawText);
  const accepted = [];
  const accept = (key, value) => {
    merged[key] = value;
    accepted.push(key);
  };

  // Phone: SMS/call sender, then the rules regex, then a grounded AI phone.
  const sender = normalizePhone(opts.from_phone);
  const excluded = new Set([normalizePhone(opts.owner_phone), normalizePhone(opts.twilio_from)].filter(Boolean));
  if ((opts.channel === "sms" || opts.channel === "call") && sender && !excluded.has(sender)) merged.phone = sender;
  else if (!merged.phone) {
    const aiPhone = normalizePhone(nonEmpty(ai.phone));
    if (aiPhone && !excluded.has(aiPhone) && digitsOf(rawText).includes(nationalDigits(aiPhone))) accept("phone", aiPhone);
  }

  // Email: the rules regex wins; an AI email must be a plain customer address that appears verbatim.
  const aiEmail = normalizeEmail(ai.email);
  if (!merged.email && aiEmail && !isRelayAddress(aiEmail, opts.owner_email) && rawText.toLowerCase().includes(aiEmail)) {
    accept("email", aiEmail);
  }

  // Names and address: accepted only when grounded in the raw text. Blank beats wrong.
  for (const key of ["contact_name", "business_name", "address"]) {
    const value = nonEmpty(ai[key]);
    if (value && grounded(value, rawAlnum) && value !== merged[key]) accept(key, value);
  }

  const summary = nonEmpty(ai.summary);
  if (summary && !/^service request\.?$/i.test(summary)) accept("problem", shorten(summary, 60));
  const details = nonEmpty(ai.details);
  if (details) accept("details", details);

  if ((!merged.equipment || merged.equipment === "other") && EQUIPMENT_IDS.includes(ai.equipment) && ai.equipment !== merged.equipment) {
    accept("equipment", ai.equipment);
  }

  // Urgency: AI can raise it, never lower it.
  const rulesUrgent = merged.urgent;
  if (!rulesUrgent && ai.urgency === "emergency") {
    merged.urgent = true;
    merged.urgent_source = "ai";
    accepted.push("urgent");
  }
  const ruleLevel = rulesUrgent ? "emergency" : URGENCY_RANK[merged.urgency] != null ? merged.urgency : "normal";
  const aiLevel = URGENCY_RANK[ai.urgency] != null ? ai.urgency : ruleLevel;
  merged.urgency = merged.urgent ? "emergency" : URGENCY_RANK[aiLevel] > URGENCY_RANK[ruleLevel] ? aiLevel : ruleLevel;
  merged.urgency_reason = nonEmpty(ai.urgency_reason);

  merged.ai_not_service = ai.is_service_request === false ? 1 : 0;
  merged.parsed_by = accepted.length ? "ai" : "rules";
  return merged;
}

/**
 * Combines the rules parse with an AI extraction under the §8.5 guardrails.
 * opts: {channel, from_phone?, owner_phone?, owner_email?, twilio_from?}
 * @returns Parse + {urgent_source, ai_not_service, urgency_reason, parsed_by}
 */
export const mergeParse = guard("mergeParse", mergeWithAI, rulesOnly);

// ---------------------------------------------------------------------------
// parseNotebook (Brain dump)

const BULLET_RE = /^\s*(?:[-*•]+|\d{1,3}[.)])\s+/;

function readNotebook(text, ctx) {
  const c = isObject(ctx) ? ctx : {};
  const opts = {
    channel: "bulk",
    now: c.now,
    tz: c.tz || c.settings?.timezone,
    techs: c.techs ?? c.settings?.techs,
    owner_phone: c.owner_phone ?? c.settings?.owner_phone,
    owner_email: c.owner_email ?? c.settings?.owner_email,
  };
  return normalizeText(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = parseMessage(line.replace(BULLET_RE, ""), opts);
      const { stage_hint: stage, quote_amount, quote_sent_at, visit_date, tech, callback_date } = fields;
      return { line, fields, stage: stage || "new", quote_amount, quote_sent_at, visit_date, tech, callback_date };
    });
}

/**
 * One row per non-empty notebook line.
 * @param {string} text
 * @param {{now, tz, techs?, owner_phone?, owner_email?, settings?}} ctx
 * @returns {{line, fields, stage, quote_amount, quote_sent_at, visit_date, tech, callback_date}[]}
 */
export const parseNotebook = guard("parseNotebook", readNotebook, () => []);

// ---------------------------------------------------------------------------
// replyIntent (§4.12, D14: keywords, never AI)

const YES_RE = /\b(?:yes|yep|yeah|yup|go ahead|sounds good|let'?s do it|do it|approved?|book (?:it|us)|deal)\b/i;
const NO_RE = /\b(?:no thanks|not (?:right )?now|we'?ll pass|pass on|went with (?:someone|somebody|another)|found (?:someone|somebody)|too (?:much|expensive|pricey)|not interested|cancel)\b/i;

function intentOf(s) {
  const yes = YES_RE.test(s);
  const no = NO_RE.test(s);
  if (yes === no) return null;
  return yes ? "yes" : "no";
}

/** 'yes' | 'no' | null (both or neither). */
export const replyIntent = guard("replyIntent", (text) => intentOf(normalizeText(text)), () => null);
