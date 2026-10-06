import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhone, phoneDisplay, money, trunc, shorten, firstName, titleFor, subtitleFor,
  sourceLabel, channelPhrase,
} from "../shared/format.js";

test("normalizePhone", () => {
  assert.equal(normalizePhone("(312) 555-0142"), "+13125550142");
  assert.equal(normalizePhone("312.555.0142"), "+13125550142");
  assert.equal(normalizePhone("1-312-555-0142"), "+13125550142");
  assert.equal(normalizePhone("+1 (312) 555-0142"), "+13125550142");
  assert.equal(normalizePhone("555-444-1212"), "+15554441212");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("555-0142"), null);
  assert.equal(normalizePhone("0123456789"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
});

test("phoneDisplay and money", () => {
  assert.equal(phoneDisplay("+13125550177"), "(312) 555-0177");
  assert.equal(phoneDisplay("+442079460958"), "+442079460958");
  assert.equal(phoneDisplay(null), null);
  assert.equal(money(2400), "$2,400");
  assert.equal(money(0), "$0");
  assert.equal(money(null), "");
});

test("trunc cuts on a word and adds an ellipsis", () => {
  assert.equal(
    trunc("Can Mike come Wednesday instead of Tuesday? We're closed Tuesdays.", 60),
    "Can Mike come Wednesday instead of Tuesday? We're closed…",
  );
  assert.equal(trunc("short", 60), "short");
});

test("shorten prefers a clause break, else truncates", () => {
  assert.equal(shorten("Walk-in freezer at 28 degrees and climbing"), "Walk-in freezer at 28 degrees and climbing");
  const long = "Deli ice machine is making about half the ice it used to, and the bin is warm";
  assert.equal(shorten(long), "Deli ice machine is making about half the ice it used to");
  assert.ok(shorten("x".repeat(30) + " " + "y".repeat(40)).endsWith("…"));
});

test("titles, subtitles and source labels", () => {
  const jv = (customer, extra = {}) => ({ customer, ...extra });
  assert.equal(titleFor(jv({ business_name: "Bella Cucina", contact_name: "Marco Rossi" })), "Bella Cucina");
  assert.equal(subtitleFor(jv({ business_name: "Bella Cucina", contact_name: "Marco Rossi" })), "Marco Rossi");
  assert.equal(titleFor(jv({ contact_name: "Marco" })), "Marco");
  assert.equal(subtitleFor(jv({ contact_name: "Marco" })), null);
  assert.equal(titleFor(jv({ phone: "+13125550177" })), "(312) 555-0177");
  assert.equal(titleFor(jv({}, { source_detail: "forwarded" })), "Forwarded text - who is this?");
  assert.equal(titleFor(jv({})), "Unknown");
  assert.equal(firstName("Marco Rossi"), "Marco");
  assert.equal(sourceLabel("call", "voicemail"), "Voicemail");
  assert.equal(sourceLabel("call", "missed"), "Missed call");
  assert.equal(sourceLabel("sms", "forwarded"), "Forwarded text");
  assert.equal(sourceLabel("form", null), "Web form");
  assert.equal(channelPhrase("form", null), "web form");
  assert.equal(channelPhrase("bulk", null), "from your notebook");
});
