import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localDate, localHM, weekdayOf, addDays, isBusinessDay, nextBusinessDay, addBusinessDays,
  daysBetween, atLocal, startOfDay, addMinutes, formatAge, dayLabel, timeLabel, dayTimeLabel,
  whenLabel, longDateLabel, shortDateLabel, mostRecentMonday0700, isYmd,
} from "../shared/time.js";

const TZ = "America/Chicago";
const A = "2026-10-05T12:00:00.000Z"; // Mon Oct 5 2026 07:00 CDT (the seed anchor)

test("business days (T01)", () => {
  assert.equal(addBusinessDays("2026-10-01", 2), "2026-10-05"); // Thu + 2 = Mon
  assert.equal(addBusinessDays("2026-10-02", 2), "2026-10-06"); // Fri + 2 = Tue
  assert.equal(addBusinessDays("2026-10-03", 1), "2026-10-05"); // Sat + 1 = Mon
  assert.equal(addBusinessDays("2026-10-04", 1), "2026-10-05"); // Sun + 1 = Mon
  assert.equal(addBusinessDays("2026-10-05", 0), "2026-10-05");
  assert.equal(nextBusinessDay("2026-10-02"), "2026-10-05");
  assert.equal(nextBusinessDay("2026-10-05"), "2026-10-06");
  assert.equal(isBusinessDay("2026-10-03"), false);
  assert.equal(isBusinessDay("2026-10-05"), true);
  assert.equal(weekdayOf("2026-10-05"), 1);
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(daysBetween("2026-10-01", "2026-10-05"), 4);
  assert.equal(daysBetween("2026-10-05", "2026-10-01"), -4);
});

test("local midnight is DST-safe (T01)", () => {
  assert.equal(startOfDay("2026-10-30", TZ), "2026-10-30T05:00:00.000Z"); // CDT, UTC-5
  assert.equal(startOfDay("2026-11-02", TZ), "2026-11-02T06:00:00.000Z"); // CST after DST ends Nov 1
  assert.equal(startOfDay("2026-11-01", TZ), "2026-11-01T05:00:00.000Z"); // the fall-back day itself
  assert.equal(atLocal("2026-03-08", "07:00", TZ), "2026-03-08T12:00:00.000Z"); // spring-forward day, after the jump
  assert.equal(atLocal("2026-10-05", "07:00", TZ), A);
  assert.equal(atLocal("2026-10-02", "16:47", TZ), "2026-10-02T21:47:00.000Z");
});

test("local parts of instants", () => {
  assert.equal(localDate(A, TZ), "2026-10-05");
  assert.equal(localHM(A, TZ), "07:00");
  assert.equal(localDate("2026-10-05T04:30:00.000Z", TZ), "2026-10-04"); // 11:30pm Sunday local
  assert.equal(addMinutes(A, 90), "2026-10-05T13:30:00.000Z");
});

test("formatAge (T01)", () => {
  assert.equal(formatAge("2026-10-02T21:47:00.000Z", A), "2d 14h"); // Fri 4:47pm -> Mon 7:00am
  assert.equal(formatAge(A, A), "now");
  assert.equal(formatAge("2026-10-05T11:02:00.000Z", A), "58m");
  assert.equal(formatAge("2026-10-04T23:05:00.000Z", A), "12h");
  assert.equal(formatAge("2026-10-02T12:00:00.000Z", A), "3d");
});

test("day, time and when labels (T01)", () => {
  assert.equal(dayLabel("2026-10-05", A, TZ), "today");
  assert.equal(dayLabel("2026-10-04T23:05:00.000Z", A, TZ), "yesterday");
  assert.equal(dayLabel("2026-10-06", A, TZ), "tomorrow");
  assert.equal(dayLabel("2026-10-02T21:47:00.000Z", A, TZ), "Fri");
  assert.equal(dayLabel("2026-10-09", A, TZ), "Fri");
  assert.equal(dayLabel("2026-10-14", A, TZ), "Oct 14");
  assert.equal(timeLabel("2026-10-02T21:47:00.000Z", TZ), "4:47pm");
  assert.equal(timeLabel("2026-10-05T11:02:00.000Z", TZ), "6:02am");
  assert.equal(timeLabel("2026-10-05T17:00:00.000Z", TZ), "12:00pm");
  assert.equal(timeLabel("2026-10-05T05:05:00.000Z", TZ), "12:05am");
  assert.equal(dayTimeLabel("2026-10-02T21:47:00.000Z", A, TZ), "Fri 4:47pm");
  assert.equal(whenLabel("2026-10-05T11:00:00.000Z", A, TZ), "now");
  assert.equal(whenLabel("2026-10-05T14:15:00.000Z", A, TZ), "at 9:15am");
  assert.equal(whenLabel(startOfDay("2026-10-06", TZ), A, TZ), "tomorrow");
  assert.equal(whenLabel(startOfDay("2026-10-08", TZ), A, TZ), "Thu");
  assert.equal(longDateLabel(A, TZ), "Monday, Oct 5");
  assert.equal(shortDateLabel(A, TZ), "Mon Oct 5");
  assert.equal(shortDateLabel("2026-10-09", TZ), "Fri Oct 9");
});

test("seed anchor is the most recent Monday 07:00 at or before now", () => {
  assert.equal(mostRecentMonday0700(A, TZ), A);
  assert.equal(mostRecentMonday0700("2026-10-06T15:00:00.000Z", TZ), A); // Tue
  assert.equal(mostRecentMonday0700("2026-10-05T11:00:00.000Z", TZ), "2026-09-28T12:00:00.000Z"); // Mon 6am -> last week
  assert.equal(mostRecentMonday0700("2026-10-11T22:00:00.000Z", TZ), A); // Sun evening
});

test("isYmd accepts only real calendar dates", () => {
  // Regression: a digits-only check let "2026-13-45" through as a visit date.
  for (const ok of ["2026-10-05", "2028-02-29", "2026-12-31"]) assert.equal(isYmd(ok), true, ok);
  for (const bad of ["2026-13-45", "2026-02-30", "2026-02-29", "2026-00-10", "2026-10-00", "2026-10-5", "Oct 5", "", null, 20261005]) {
    assert.equal(isYmd(bad), false, String(bad));
  }
});
