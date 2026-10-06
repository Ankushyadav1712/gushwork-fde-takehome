// Provider adapters (SPEC §7.2): payload -> InboundEvent, HTML stripping, MIME, the call mapping
// (C3), sender addresses (C4, security RT-4) and the Mailgun signature check (C2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  htmlToText, formExternalId, fromRawEmail, fromTwilioVoice, fromPostmark, fromMailgun, fromForm, fromGeneric,
  verifyMailgunSignature, VOICEMAIL_PLACEHOLDER,
} from "../server/adapters.js";

// ---------------------------------------------------------------------------
// HTML

test("htmlToText: block tags, table cells, entities, scripts, declarations and a bare '<'", () => {
  assert.equal(htmlToText("<div>Walk-in&nbsp;down</div><br><b>Call</b> &#8217;asap&#x21;<script>x()</script>"), "Walk-in down\n\nCall ’asap!");
  const table = "<!DOCTYPE html><html><head><style>td{color:red}</style></head><body><table>"
    + "<tr><td><b>Name</b></td></tr><tr><td>SEO Guru</td></tr><tr><th>Phone</th><td>312-555-7299</td></tr>"
    + "</table><!-- tracking --><p>temp < 40 &amp; ok</p></body></html>";
  assert.equal(htmlToText(table), "Name\nSEO Guru\nPhone\t312-555-7299\n\ntemp < 40 & ok");
});

test("htmlToText stays linear on hostile input: 1 MB of unclosed openers in well under 200 ms (security RT-1)", () => {
  for (const opener of ["<a", "<!--", "<style ", "<script>", "<a <b "]) {
    const html = opener.repeat(Math.ceil(1_000_000 / opener.length));
    const start = performance.now();
    htmlToText(html);
    const ms = performance.now() - start;
    assert.ok(ms < 200, `${opener}: ${ms.toFixed(1)} ms`);
  }
  // Long ordinary HTML is cut at 100 KB but keeps its beginning.
  const long = `<p>Freezer down</p>${"<p>filler text</p>".repeat(20_000)}`;
  assert.ok(htmlToText(long).startsWith("Freezer down\nfiller text"));
});

// ---------------------------------------------------------------------------
// Calls (C3)

test("fromTwilioVoice: answered only on DialCallStatus completed; a parent 'completed' is a missed call", () => {
  const call = (p) => fromTwilioVoice({ CallSid: "CA1", From: "+13125550177", ...p });
  const read = (e) => [e.call_status, e.call_duration_s];
  assert.deepEqual(read(call({ CallStatus: "completed", CallDuration: "9", ForwardedFrom: "+13125550100" })), ["missed", null]);
  assert.deepEqual(read(call({ CallStatus: "completed", CallDuration: "25" })), ["missed", null]);
  assert.deepEqual(read(call({ CallStatus: "in-progress", DialCallStatus: "completed", DialCallDuration: "40", CallDuration: "55" })), ["answered", 40]);
  assert.deepEqual(read(call({ CallStatus: "completed", DialCallStatus: "no-answer" })), ["missed", null]);
  for (const status of ["no-answer", "busy", "failed", "canceled"]) assert.equal(call({ CallStatus: status }).call_status, "missed", status);
  for (const status of ["queued", "ringing", "in-progress"]) assert.equal(call({ CallStatus: status }).call_status, null, status);
  const vm = call({ CallStatus: "completed", DialCallStatus: "completed", RecordingUrl: "https://x", RecordingDuration: "24" });
  assert.deepEqual([vm.call_status, vm.body, vm.call_duration_s], ["voicemail", VOICEMAIL_PLACEHOLDER, 24]);
  assert.equal(call({ TranscriptionText: "Walk-in is warm" }).body, "Walk-in is warm");
});

// ---------------------------------------------------------------------------
// Email senders (C4, security RT-4)

test("sender addresses: strictly valid or null, so no hidden cc/bcc reaches a mailto: link", () => {
  const pm = fromPostmark({
    FromFull: { Email: "chef@bistro.example?cc=billing@attacker.example&subject=Updated%20bank%20details", Name: "Chef Bo" },
    Subject: "Freezer", TextBody: "Our walk-in freezer is warm", MessageID: "pm-1",
  });
  assert.equal(pm.from_email, null);
  const generic = fromGeneric("email", { from: "Sam <sam@diner.example?bcc=spy@attacker.example>", text: "Cooler warm" });
  assert.equal(generic.from_email, null);
  assert.equal(fromGeneric("email", { from: "Sam <Sam@Diner.example>", text: "Cooler warm" }).from_email, "sam@diner.example");
});

test("Reply-To wins over From: form mailers set it to the customer", () => {
  const body = "You have a new message from Carla. Our display case is not cooling.";
  const viaField = fromPostmark({ FromFull: { Email: "no-reply@crm.wix.com", Name: "Wix Forms" }, ReplyTo: "Carla Diaz <carla@diaz.example>", TextBody: body, MessageID: "w1" });
  assert.deepEqual([viaField.from_email, viaField.from_name], ["carla@diaz.example", "Carla Diaz"]);
  const viaHeader = fromPostmark({ FromFull: { Email: "no-reply@crm.wix.com" }, Headers: [{ Name: "Reply-To", Value: "carla@diaz.example" }], TextBody: body, MessageID: "w2" });
  assert.equal(viaHeader.from_email, "carla@diaz.example");
  const mailgun = fromMailgun({ from: "Wix <no-reply@crm.wix.com>", "Reply-To": "carla@diaz.example", "body-plain": body, "Message-Id": "<m1@x>" });
  assert.equal(mailgun.from_email, "carla@diaz.example");
  const raw = fromRawEmail("From: Wix <no-reply@crm.wix.com>\nReply-To: carla@diaz.example\nSubject: New message\n\nhi");
  assert.equal(raw.from_email, "carla@diaz.example");
  // A broken Reply-To falls back to From.
  assert.equal(fromPostmark({ FromFull: { Email: "ann@bistro.example" }, ReplyTo: "not an address", TextBody: body, MessageID: "w3" }).from_email, "ann@bistro.example");
});

test("form notification emails are channel 'form' with any label set the parser knows", () => {
  const wix = fromPostmark({ FromFull: { Email: "no-reply@crm.wix.com" }, MessageID: "w4",
    TextBody: "You have a new form submission.\n\nFull Name: Ben Ortiz\nPhone Number: (312) 555-7202\nComments: Walk-in freezer down" });
  assert.equal(wix.channel, "form");
  const wordpress = fromPostmark({ FromFull: { Email: "wordpress@frostline.example" }, MessageID: "w5",
    HtmlBody: "<table><tr><td><b>Name</b></td></tr><tr><td>Rosa Alvarez</td></tr><tr><td><b>Message</b></td></tr><tr><td>Walk-in freezer is down</td></tr></table>" });
  assert.deepEqual([wordpress.channel, wordpress.body], ["form", "Name\nRosa Alvarez\nMessage\nWalk-in freezer is down"]);
  assert.equal(fromPostmark({ FromFull: { Email: "ann@bistro.example" }, TextBody: "Thanks!\nPhone: 312-555-0142", MessageID: "w6" }).channel, "email");
});

// ---------------------------------------------------------------------------
// Raw RFC 822 and MIME (RT-10)

test("raw emails: header block, pasted form bodies and quoted-printable", () => {
  const pasted = fromRawEmail("Name: Tony Russo\nPhone: (312) 555-0187\nMessage: Freezer warm");
  assert.deepEqual([pasted.channel, pasted.body, pasted.external_id], ["form", "Name: Tony Russo\nPhone: (312) 555-0187\nMessage: Freezer warm", null]);
  const mixed = fromRawEmail("Subject: freezer\nName: Tony Russo\nMessage: Freezer warm");
  assert.deepEqual([mixed.subject, mixed.body], [null, "Subject: freezer\nName: Tony Russo\nMessage: Freezer warm"]);
  const qp = fromRawEmail("From: a@b.example\nSubject: Hi\nContent-Transfer-Encoding: quoted-printable\n\nIt=E2=80=99s warm =\nnow");
  assert.deepEqual([qp.channel, qp.body, qp.subject], ["email", "It’s warm now", "Hi"]);
});

test("raw emails: multipart bodies give the text part, decoded, without boundaries", () => {
  const alternative = [
    "From: Lee <lee@x.example>", "Subject: help", "Message-ID: <raw-2@x>", "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=\"b1\"", "", "This is a MIME message.",
    "--b1", "Content-Type: text/plain; charset=UTF-8", "", "Our ice machine is leaking. 312-555-7303", "",
    "--b1", "Content-Type: text/html; charset=UTF-8", "", "<div>Our ice machine is leaking. 312-555-7303</div>", "", "--b1--", "",
  ].join("\r\n");
  const plain = fromRawEmail(alternative);
  assert.deepEqual([plain.body, plain.external_id, plain.from_email], ["Our ice machine is leaking. 312-555-7303", "raw-2@x", "lee@x.example"]);

  const base64 = Buffer.from("Our walk-in freezer is down. Call me at 312-555-7313").toString("base64");
  const mixed = [
    "From: Kim <kim@x.example>", "Subject: down", "Content-Type: multipart/mixed; boundary=outer", "",
    "--outer", "Content-Type: multipart/alternative; boundary=inner", "",
    "--inner", "Content-Type: text/html", "", "<p>html version</p>",
    "--inner", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64,
    "--inner--", "--outer", "Content-Type: image/jpeg", "Content-Transfer-Encoding: base64", "", "AAAA", "--outer--",
  ].join("\n");
  assert.equal(fromRawEmail(mixed).body, "Our walk-in freezer is down. Call me at 312-555-7313");

  const htmlOnly = ["From: a@b.example", "Subject: x", "Content-Type: multipart/alternative; boundary=z", "",
    "--z", "Content-Type: text/html; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable", "",
    "<p>Caf=E9 cooler warm</p>", "--z--"].join("\n");
  assert.equal(fromRawEmail(htmlOnly).body, "Café cooler warm");
});

// ---------------------------------------------------------------------------
// Website-form webhooks (RT-9, RT-4)

test("fromForm: real-world field names, bracket keys, nested data, split names and tracking fields", () => {
  const odd = fromForm({ "Your Name": "Mia Fox", "Company Name": "Fox Deli", "Phone #": "312.555.7304", "E-mail": "mia@foxdeli.example",
    "What's going on?": "deli case is warm", form_id: "contact-7", utm_source: "google" });
  assert.deepEqual(odd.form_fields, { contact_name: "Mia Fox", business_name: "Fox Deli", phone: "312.555.7304",
    email: "mia@foxdeli.example", message: "deli case is warm" });
  assert.deepEqual([odd.body, odd.from_phone, odd.from_email], ["deli case is warm", "+13125557304", "mia@foxdeli.example"]);

  const brackets = fromForm({ "fields[name]": "Ned", "fields[phone]": "3125557305", "fields[message]": "walk in cooler leaking", entry_id: "e-55" });
  assert.deepEqual([brackets.form_fields.contact_name, brackets.from_phone, brackets.body, brackets.external_id],
    ["Ned", "+13125557305", "walk in cooler leaking", "e-55"]);

  const nested = fromForm({ data: { name: "Oli", phone: "3125557306", message: "freezer warm" }, id: 991 });
  assert.deepEqual([nested.form_fields.contact_name, nested.from_phone, nested.body, nested.external_id], ["Oli", "+13125557306", "freezer warm", "991"]);

  const split = fromForm({ "First Name": "Jo", "Last Name": "King", Phone: "312-555-0143", Message: "reach-in not cooling",
    address: { street: "1820 N Halsted St", city: "Chicago" } });
  assert.deepEqual([split.from_name, split.form_fields.address], ["Jo King", "1820 N Halsted St, Chicago"]);

  // With no message field, the longest free-text answer stands in for it.
  const noMessage = fromForm({ name: "Pat", phone: "3125550187", "Tell us more": "the prep table is warm again", "Best time": "mornings" });
  assert.deepEqual([noMessage.form_fields.message, noMessage.body], ["the prep table is warm again", "the prep table is warm again\nBest time: mornings"]);
});

test("formExternalId hashes within 10-minute buckets", () => {
  const hash = formExternalId({ body: "b", phone: "+13125550133", email: null }, "2026-10-05T11:02:00.000Z");
  assert.equal(hash, formExternalId({ body: "b", phone: "+13125550133", email: null }, "2026-10-05T11:09:59.000Z"));
  assert.notEqual(hash, formExternalId({ body: "b", phone: "+13125550133", email: null }, "2026-10-05T11:10:00.000Z"));
});

// ---------------------------------------------------------------------------
// Mailgun signature (C2, security RT-5)

test("verifyMailgunSignature: a valid HMAC with a timestamp within 5 minutes of now", () => {
  const nowMs = Date.parse("2026-10-05T12:00:00.000Z");
  const signed = (seconds) => {
    const timestamp = String(seconds);
    return { timestamp, token: "tok-1", signature: createHmac("sha256", "mg-key").update(`${timestamp}tok-1`).digest("hex") };
  };
  const fresh = signed(nowMs / 1000 - 60);
  assert.equal(verifyMailgunSignature("mg-key", fresh, nowMs), true);
  assert.equal(verifyMailgunSignature("mg-key", { signature: fresh }, nowMs), true, "nested under `signature`");
  assert.equal(verifyMailgunSignature("other-key", fresh, nowMs), false);
  assert.equal(verifyMailgunSignature("mg-key", signed(nowMs / 1000 - 10 * 60), nowMs), false, "10 minutes old");
  assert.equal(verifyMailgunSignature("mg-key", signed(nowMs / 1000 + 10 * 60), nowMs), false, "from the future");
  assert.equal(verifyMailgunSignature("mg-key", { ...fresh, timestamp: "soon" }, nowMs), false);
});
