// Live demo presets (SPEC §12.6): provider-shaped payloads, so the simulator exercises the real
// adapters and the real ingest(). buildCustom() does the same for the simulator's custom form.
import { createHash, randomBytes } from "node:crypto";

/** The Twilio "New Job" number the demo payloads are addressed to (fictional). */
export const DEMO_TWILIO_NUMBER = "+13125550105";
const DEMO_ACCOUNT_SID = `AC${"0".repeat(32)}`;
const FORM_SENDER = { Email: "forms@frostline.example", Name: "Frostline Website" };

export const ROUTE_PATHS = Object.freeze({
  sms: "/api/inbound/sms",
  call: "/api/inbound/call",
  email: "/api/inbound/email",
  form: "/api/inbound/form",
});

const FORM_URLENCODED = "application/x-www-form-urlencoded";
const JSON_TYPE = "application/json";

/** Stable provider ids, so pressing a preset twice is an honest duplicate. */
function stableSid(prefix, name) {
  return prefix + createHash("sha1").update(name).digest("hex").slice(0, 32);
}

function freshSid(prefix) {
  return prefix + randomBytes(16).toString("hex");
}

function twilioSms({ sid, from, to = DEMO_TWILIO_NUMBER, body }) {
  return {
    ToCountry: "US", SmsMessageSid: sid, NumMedia: "0", SmsSid: sid, SmsStatus: "received",
    Body: body, To: to, NumSegments: "1", MessageSid: sid, AccountSid: DEMO_ACCOUNT_SID,
    From: from, ApiVersion: "2010-04-01",
  };
}

function twilioCall({ sid, from, to = DEMO_TWILIO_NUMBER, ...rest }) {
  return { CallSid: sid, AccountSid: DEMO_ACCOUNT_SID, From: from, To: to, Direction: "inbound", ApiVersion: "2010-04-01", ...rest };
}

function voicemailFields(sid, transcript) {
  return {
    CallStatus: "completed",
    RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${DEMO_ACCOUNT_SID}/Recordings/${sid.replace(/^CA/, "RE")}`,
    RecordingDuration: "24",
    TranscriptionStatus: "completed",
    TranscriptionText: transcript,
  };
}

function postmarkEmail({ messageId, from = FORM_SENDER, subject, text }) {
  return {
    From: `${from.Name} <${from.Email}>`, FromName: from.Name, FromFull: { ...from, MailboxHash: "" },
    To: "jobs@inbound.frostline.example", Subject: subject, TextBody: text, HtmlBody: "",
    MessageID: messageId.replace(/[<>@.]/g, "").slice(0, 36),
    Date: "Mon, 5 Oct 2026 08:15:00 -0500",
    Headers: [{ Name: "Message-ID", Value: messageId }],
  };
}

const twilioRequest = (route, body) => ({ route, path: ROUTE_PATHS[route], contentType: FORM_URLENCODED, body });
const jsonRequest = (route, body) => ({ route, path: ROUTE_PATHS[route], contentType: JSON_TYPE, body });

const TONY_FORM = [
  "Name: Tony Russo",
  "Business: Tony's Bistro",
  "Phone: (312) 555-0187",
  "Message: Walk-in freezer at 10F and rising. Please call.",
].join("\n");

const CARLA_TRANSCRIPT = "Hey it's Carla from Westside Diner, our ice machine is leaking all over the kitchen floor. Call me back at 312-555-0164.";

/** Each preset: id, label for the simulator button, the expected result, and its payload builder. */
const DEFINITIONS = [
  {
    id: "rosa_yes", label: "Rosa texts back: yes",
    expected: "Attaches to Rosa's Taqueria's quote. Shows under They got back to you with \"Mark as yes?\".",
    build: () => twilioRequest("sms", twilioSms({ sid: stableSid("SM", "rosa_yes"), from: "+13125550118",
      body: "yes go ahead, thursday works for us" })),
  },
  {
    id: "lucia_repeat", label: "Lucia texts again",
    expected: "New job \"Lucia's Market\" with \"Repeat - 1 past job\", source Text.",
    build: () => twilioRequest("sms", twilioSms({ sid: stableSid("SM", "lucia_repeat"), from: "+13125550101",
      body: "ice machine acting up again, can someone come this week?" })),
  },
  {
    id: "web_form_tony", label: "Web form: Tony's Bistro",
    expected: "New urgent job from the web form. Sending it again returns duplicate.",
    build: () => jsonRequest("email", postmarkEmail({ messageId: "<web-form-tony-bistro@frostline.example>",
      subject: "New website form submission", text: TONY_FORM })),
  },
  {
    id: "voicemail_carla", label: "Voicemail: Carla, Westside Diner",
    expected: "New urgent job (leaking), source Voicemail.",
    build: () => {
      const sid = stableSid("CA", "voicemail_carla");
      return twilioRequest("call", twilioCall({ sid, from: "+13125550164", ...voicemailFields(sid, CARLA_TRANSCRIPT) }));
    },
  },
  {
    id: "forward_midway", label: "Denise forwards a Midway Meats text",
    expected: "Matched by business name and attached to Midway Meats (They got back to you).",
    build: ({ settings }) => twilioRequest("sms", twilioSms({ sid: stableSid("SM", "forward_midway"),
      from: settings?.owner_phone ?? "+13125550100",
      body: "Midway Meats: hey denise any update on that freezer door quote?" })),
  },
  {
    id: "spam_call", label: "Answered call, 8 seconds",
    expected: "Ignored (answered calls under 15 seconds create nothing).",
    build: () => twilioRequest("call", twilioCall({ sid: stableSid("CA", "spam_call"), from: "+13125550155",
      CallStatus: "completed", CallDuration: "8" })),
  },
  {
    id: "answered_call", label: "Answered call, 2 minutes",
    expected: "New job: \"New - call ... - what was it about?\".",
    build: () => twilioRequest("call", twilioCall({ sid: stableSid("CA", "answered_call"), from: "+13125550168",
      CallStatus: "completed", CallDuration: "120" })),
  },
];

/** [{id, label, route, expected}] for the simulator screen. */
export const PRESETS = Object.freeze(
  DEFINITIONS.map(({ id, label, expected, build }) => Object.freeze({ id, label, expected, route: build({}).route })),
);

/**
 * The provider-shaped request for one preset.
 * @returns {{route: 'sms'|'call'|'email'|'form', path: string, contentType: string, body: object|string}}
 */
export function buildPreset(name, { settings } = {}) {
  const def = DEFINITIONS.find((d) => d.id === name);
  if (!def) throw new Error(`Unknown preset: ${name}`);
  return def.build({ settings });
}

function customCall({ from, body, call_status: status = "missed", duration_s: duration, format }) {
  if (format === "generic") {
    return jsonRequest("call", { from, status, duration_s: duration ?? null, voicemail_text: body || null, id: freshSid("CA") });
  }
  const sid = freshSid("CA");
  if (status === "voicemail") return twilioRequest("call", twilioCall({ sid, from, ...voicemailFields(sid, body || "") }));
  if (status === "answered") {
    return twilioRequest("call", twilioCall({ sid, from, CallStatus: "completed", CallDuration: String(duration ?? 60) }));
  }
  return twilioRequest("call", twilioCall({ sid, from, CallStatus: "no-answer", CallDuration: "0" }));
}

function customEmail({ from, body, format }) {
  const messageId = `<${randomBytes(8).toString("hex")}@sim.frostline.example>`;
  if (format === "generic") return jsonRequest("email", { from, text: body, subject: "Message", message_id: messageId });
  if (format === "raw") {
    const raw = [`From: ${from}`, "Subject: Message", `Message-ID: ${messageId}`, "", body].join("\n");
    return { route: "email", path: ROUTE_PATHS.email, contentType: "text/plain", body: raw };
  }
  const address = /@/.test(from ?? "") ? { Email: from, Name: "" } : FORM_SENDER;
  return jsonRequest("email", postmarkEmail({ messageId, from: address, subject: "Message", text: body }));
}

/**
 * The simulator's custom form: {channel, from, body, call_status?, duration_s?, format?:'twilio'|'postmark'|'generic'|'raw'}.
 * Each call gets a fresh provider id.
 */
export function buildCustom(input = {}) {
  const { channel = "sms", from = "", body = "", format } = input;
  switch (channel) {
    case "sms":
      return format === "generic"
        ? jsonRequest("sms", { from, body, id: freshSid("SM") })
        : twilioRequest("sms", twilioSms({ sid: freshSid("SM"), from, body }));
    case "call": return customCall(input);
    case "email": return customEmail({ from, body, format });
    case "form": return jsonRequest("form", { phone: from, message: body, submission_id: freshSid("F") });
    default: throw new Error(`Unknown channel: ${channel}`);
  }
}

/** Serialise a request body for HTTP: urlencoded, JSON or raw text. */
export function encodeBody({ contentType, body }) {
  if (contentType === FORM_URLENCODED) return new URLSearchParams(body).toString();
  if (contentType === JSON_TYPE) return JSON.stringify(body);
  return String(body);
}
