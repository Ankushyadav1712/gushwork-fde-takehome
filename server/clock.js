// Single source of "now" for the server. The demo can shift it (e.g. "jump to Monday 7:00am")
// to show what Denise sees after a weekend, without touching the system clock.
// Every server-side read of the current time must go through now().
let offsetMs = 0;

export function now() {
  return new Date(Date.now() + offsetMs);
}

/** Pretend it is `when` (Date | ISO string). Pass null to return to real time. Time keeps moving from there. */
export function setNow(when) {
  offsetMs = when ? new Date(when).getTime() - Date.now() : 0;
  if (Number.isNaN(offsetMs)) offsetMs = 0;
}

export function isShifted() {
  return offsetMs !== 0;
}
