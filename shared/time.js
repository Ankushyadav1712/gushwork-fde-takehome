// Pure date helpers for the business time zone. Never reads the system clock:
// every function takes the instant(s) it needs. Works in Node and the browser.
//
// Instants are ISO UTC strings ("2026-10-02T21:47:00.000Z").
// Local dates are "YYYY-MM-DD" strings in the business time zone.
// Business days are Mon-Fri (no holidays).

/** The business time zone used when settings don't name one. */
export const DEFAULT_TZ = "America/Chicago";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `tz`. */
export function zonedParts(iso, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(iso))) out[p.type] = p.value;
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour % 24, minute: +out.minute, second: +out.second,
  };
}

const pad = (n) => String(n).padStart(2, "0");
const toIso = (ms) => new Date(ms).toISOString();

function ymdToUtcMs(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function utcMsToYmd(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A real calendar date written YYYY-MM-DD ("2026-02-30" and "2026-13-01" round-trip to other dates). */
export function isYmd(s) {
  return typeof s === "string" && YMD.test(s) && utcMsToYmd(ymdToUtcMs(s)) === s;
}

/** Local calendar date ("YYYY-MM-DD") of an instant. */
export function localDate(iso, tz) {
  const p = zonedParts(iso, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local wall time ("HH:MM", 24h) of an instant. */
export function localHM(iso, tz) {
  const p = zonedParts(iso, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(ymd) {
  return new Date(ymdToUtcMs(ymd)).getUTCDay();
}

export function addDays(ymd, n) {
  return utcMsToYmd(ymdToUtcMs(ymd) + n * DAY_MS);
}

export function isBusinessDay(ymd) {
  const w = weekdayOf(ymd);
  return w >= 1 && w <= 5;
}

/** First business day strictly after `ymd`. */
export function nextBusinessDay(ymd) {
  let d = addDays(ymd, 1);
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

/** The nth business day strictly after `ymd` (n = 0 returns `ymd`). Thu+2 = Mon, Fri+2 = Tue, Sat+1 = Mon. */
export function addBusinessDays(ymd, n) {
  let d = ymd;
  for (let i = 0; i < n; i++) d = nextBusinessDay(d);
  return d;
}

/** Whole calendar days from ymdA to ymdB (positive when B is later). */
export function daysBetween(ymdA, ymdB) {
  return Math.round((ymdToUtcMs(ymdB) - ymdToUtcMs(ymdA)) / DAY_MS);
}

/** The instant at local wall time `hm` ("HH:MM") on local date `ymd`. DST-safe. */
export function atLocal(ymd, hm, tz) {
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // offset(t) = wall-clock-as-UTC(t) - t; iterate twice to settle across DST transitions.
  const offsetAt = (t) => {
    const p = zonedParts(toIso(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  let t = wall - offsetAt(wall);
  const o2 = offsetAt(t);
  if (wall - o2 !== t) t = wall - o2;
  return toIso(t);
}

/** Local midnight of `ymd`, as an instant. */
export function startOfDay(ymd, tz) {
  return atLocal(ymd, "00:00", tz);
}

export function addMinutes(iso, n) {
  return toIso(new Date(iso).getTime() + n * 60_000);
}

/** "now", "45m", "5h", "2d 14h", "3d". Floors each unit. */
export function formatAge(fromIso, toIso_) {
  const mins = Math.floor((new Date(toIso_).getTime() - new Date(fromIso).getTime()) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

function toLocalYmd(isoOrYmd, tz) {
  return isYmd(isoOrYmd) ? isoOrYmd : localDate(isoOrYmd, tz);
}

/** "today" / "yesterday" / "tomorrow" / "Fri" (within 6 days either way) / "Oct 14". */
export function dayLabel(isoOrYmd, nowIso, tz) {
  const d = toLocalYmd(isoOrYmd, tz);
  const diff = daysBetween(localDate(nowIso, tz), d);
  if (diff === 0) return "today";
  if (diff === -1) return "yesterday";
  if (diff === 1) return "tomorrow";
  if (Math.abs(diff) <= 6) return WEEKDAYS_SHORT[weekdayOf(d)];
  const [, m, day] = d.split("-").map(Number);
  return `${MONTHS_SHORT[m - 1]} ${day}`;
}

/** "4:47pm", "6:02am", "12:00pm", "12:05am". */
export function timeLabel(iso, tz) {
  const { hour, minute } = zonedParts(iso, tz);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${pad(minute)}${hour < 12 ? "am" : "pm"}`;
}

/** "Fri 4:47pm", "today 6:02am", "yesterday 6:05pm". */
export function dayTimeLabel(iso, nowIso, tz) {
  return `${dayLabel(iso, nowIso, tz)} ${timeLabel(iso, tz)}`;
}

/** When a job is next due: "now" if already due, "at 9:15am" later today, else a day label. */
export function whenLabel(nextDueIso, nowIso, tz) {
  if (!nextDueIso) return null;
  if (new Date(nextDueIso).getTime() <= new Date(nowIso).getTime()) return "now";
  if (localDate(nextDueIso, tz) === localDate(nowIso, tz)) return `at ${timeLabel(nextDueIso, tz)}`;
  return dayLabel(nextDueIso, nowIso, tz);
}

/** "Monday, Oct 5". Accepts an instant or a local date. */
export function longDateLabel(isoOrYmd, tz) {
  const d = toLocalYmd(isoOrYmd, tz);
  const [, m, day] = d.split("-").map(Number);
  return `${WEEKDAYS_LONG[weekdayOf(d)]}, ${MONTHS_SHORT[m - 1]} ${day}`;
}

/** "Mon Oct 5". Accepts an instant or a local date. */
export function shortDateLabel(isoOrYmd, tz) {
  const d = toLocalYmd(isoOrYmd, tz);
  const [, m, day] = d.split("-").map(Number);
  return `${WEEKDAYS_SHORT[weekdayOf(d)]} ${MONTHS_SHORT[m - 1]} ${day}`;
}

export function weekdayName(ymd, { long = false } = {}) {
  return (long ? WEEKDAYS_LONG : WEEKDAYS_SHORT)[weekdayOf(ymd)];
}

/** The most recent Monday 07:00 local at or before `nowIso` (the demo seed anchor). */
export function mostRecentMonday0700(nowIso, tz) {
  let d = localDate(nowIso, tz);
  while (weekdayOf(d) !== 1) d = addDays(d, -1);
  let anchor = atLocal(d, "07:00", tz);
  if (new Date(anchor).getTime() > new Date(nowIso).getTime()) anchor = atLocal(addDays(d, -7), "07:00", tz);
  return anchor;
}
