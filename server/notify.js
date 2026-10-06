// Texts the system sends (SPEC §11 "Delivery"): every message goes to the outbox first, deduped
// by dedupe_key, then out through Twilio when all three Twilio variables are set. Without them the
// row is marked 'simulated'. Nothing here ever throws to the caller.
import { insertOutbox, getOutbox, updateOutbox } from "./repo.js";

const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";
const SEND_TIMEOUT_MS = 15_000;
/** Set while a Twilio send is in flight; the outbox status column only allows simulated/sent/failed. */
export const SENDING_NOTE = "sending";

/** 'twilio' when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are all set, else 'simulated'. */
export function smsMode(env = process.env) {
  return env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM ? "twilio" : "simulated";
}

const nowIsoOf = (now) => (typeof now === "function" ? now() : now) ?? new Date().toISOString();

/** Logs carry ids and status codes only, never message bodies. */
function logWarn(what, err) {
  console.warn(`[notify] ${what}${err ? ` (${err.name ?? "Error"}${err.code ? ` ${err.code}` : ""})` : ""}`);
}

/**
 * Insert one text into the outbox, synchronously. Returns the new row, or null when the
 * dedupe_key was already used. In Twilio mode the row starts as failed/"sending" until deliver() runs.
 */
export function enqueue(db, msg, { now, env = process.env } = {}) {
  const twilio = smsMode(env) === "twilio";
  const id = insertOutbox(db, {
    created_at: nowIsoOf(now),
    kind: msg.kind,
    to_phone: msg.to_phone,
    to_name: msg.to_name ?? null,
    body: msg.body,
    job_id: msg.job_id ?? null,
    dedupe_key: msg.dedupe_key ?? null,
    status: twilio ? "failed" : "simulated",
    error: twilio ? SENDING_NOTE : null,
  });
  return id == null ? null : getOutbox(db, id);
}

function twilioRequest(row, env) {
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  return {
    url: `${TWILIO_API}/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`,
    init: {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: row.to_phone, From: env.TWILIO_FROM, Body: row.body }).toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    },
  };
}

function failureText(status, data) {
  const code = data?.code ? ` (code ${data.code})` : "";
  const message = typeof data?.message === "string" ? `: ${data.message}` : "";
  return `Twilio ${status}${code}${message}`.slice(0, 500);
}

function safeUpdate(db, id, patch) {
  try {
    return updateOutbox(db, id, patch);
  } catch (err) {
    logWarn(`could not record the result for outbox ${id}`, err);
    return null;
  }
}

/** Send an enqueued row through Twilio (no-op when simulated). Resolves to the updated row; never rejects. */
export async function deliver(row, { db, env = process.env, fetch: fetchFn = globalThis.fetch } = {}) {
  if (!row || smsMode(env) !== "twilio") return row;
  const { url, init } = twilioRequest(row, env);
  try {
    const res = await fetchFn(url, init);
    const data = await res.json().catch(() => null);
    if (res.ok) return safeUpdate(db, row.id, { status: "sent", provider_id: data?.sid ?? null, error: null });
    logWarn(`Twilio refused outbox ${row.id} (HTTP ${res.status})`);
    return safeUpdate(db, row.id, { status: "failed", error: failureText(res.status, data) });
  } catch (err) {
    logWarn(`Twilio send for outbox ${row.id} failed`, err);
    return safeUpdate(db, row.id, { status: "failed", error: `${err?.name ?? "Error"}: ${err?.message ?? "send failed"}`.slice(0, 500) });
  }
}

/**
 * send({to_phone, to_name, kind, body, job_id, dedupe_key}, {db, now, env, fetch}).
 * The outbox insert happens synchronously, before this returns its promise. Resolves to the final
 * outbox row, or null when deduped or when the row could not be written. Never rejects.
 */
export async function send(msg, deps = {}) {
  let row;
  try {
    row = enqueue(deps.db, msg, deps);
  } catch (err) {
    logWarn(`could not queue a ${msg?.kind ?? "text"}`, err);
    return null;
  }
  return row && deliver(row, deps);
}
