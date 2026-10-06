// Pure formatting helpers shared by the server and the browser.

/**
 * E.164 for US/NANP numbers. Keeps digits and a leading "+".
 * 10 digits starting 2-9 -> +1XXXXXXXXXX; 11 digits starting 1 -> +1XXXXXXXXXX; "+..." kept; else null.
 */
export function normalizePhone(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 && /[2-9]/.test(digits[0])) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return null;
}

/** "+13125550142" -> "(312) 555-0142". Non-NANP numbers are returned unchanged. */
export function phoneDisplay(phone) {
  if (!phone) return null;
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
}

/** Whole dollars: 2400 -> "$2,400". Null/undefined -> "". */
export function money(n) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return "";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

/** If longer than n, cut at the last space before character n-1 and add "…". */
export function trunc(s, n) {
  if (s == null) return s;
  const str = String(s);
  if (str.length <= n) return str;
  let cut = str.lastIndexOf(" ", n - 2);
  if (cut < Math.floor(n / 2)) cut = n - 1;
  return `${str.slice(0, cut).trimEnd()}…`;
}

/**
 * Shorten a one-line problem to n chars. Prefers a clean break at the last ", " / " and " / " but "
 * starting between characters 25 and n-1 (no ellipsis); otherwise falls back to trunc().
 */
export function shorten(s, n = 60) {
  if (s == null) return s;
  const str = String(s).trim();
  if (str.length <= n) return str;
  let best = -1;
  for (const sep of [", ", " and ", " but "]) {
    let i = str.indexOf(sep);
    while (i !== -1) {
      if (i >= 25 && i <= n - 1 && i > best) best = i;
      i = str.indexOf(sep, i + 1);
    }
  }
  if (best !== -1) return str.slice(0, best).replace(/[\s,;:]+$/, "");
  return trunc(str, n);
}

/** "1 job", "3 jobs". */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Just the word: pluralWord(1, "quote", "quotes") -> "quote". */
export function pluralWord(n, one, many) {
  return n === 1 ? one : many;
}

export function firstName(name) {
  if (!name) return null;
  const t = String(name).trim().split(/\s+/)[0];
  return t || null;
}

/** Card/job title: business, contact, formatted phone, email, forwarded placeholder, "Unknown". */
export function titleFor(jv) {
  const c = jv?.customer || {};
  return (
    c.business_name ||
    c.contact_name ||
    phoneDisplay(c.phone) ||
    c.email ||
    (jv?.source_detail === "forwarded" ? "Forwarded text - who is this?" : null) ||
    "Unknown"
  );
}

/** Contact name under the title, only when the title is the business name. */
export function subtitleFor(jv) {
  const c = jv?.customer || {};
  return c.business_name && c.contact_name ? c.contact_name : null;
}

const SOURCE_LABELS = {
  "call:voicemail": "Voicemail",
  "call:missed": "Missed call",
  "call:answered": "Call",
  call: "Call",
  "sms:forwarded": "Forwarded text",
  sms: "Text",
  form: "Web form",
  email: "Email",
  manual: "Added by you",
  bulk: "From notebook",
};

/** "Voicemail", "Missed call", "Text", "Web form", "Added by you", ... */
export function sourceLabel(source, sourceDetail) {
  return SOURCE_LABELS[`${source}:${sourceDetail}`] || SOURCE_LABELS[source] || "Other";
}

/** Lowercase phrase used inside sentences: "voicemail", "web form", "from your notebook", ... */
export function channelPhrase(source, sourceDetail) {
  if (source === "bulk") return "from your notebook";
  return sourceLabel(source, sourceDetail).toLowerCase();
}
