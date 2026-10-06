// Demo controls (SPEC §9 "Demo controls", §12.6, §13.5): mounted under /api only when DEMO is on.
// Inbound presets go through the real adapters and ingest(); every clock change runs the scheduler
// once at the new time (skipped-over texts are not backfilled) and persists the offset. Moving the
// clock back forgets the texts sent "in the future", so they can't block that day's real ones.
import express from "express";
import { tx, wipe } from "../db.js";
import * as repo from "../repo.js";
import { ingestPayload } from "./inbound.js";
import { buildPreset, buildCustom, PRESETS } from "../presets.js";
import { tick } from "../scheduler.js";
import { seedDemo } from "../seed.js";
import { invalid } from "../actions.js";
import { contextFor, serializeOutbox } from "../context.js";
import { addDays, addMinutes, atLocal, localDate, localHM, weekdayOf } from "../../shared/time.js";

const CHANNELS = ["sms", "call", "email", "form"];
const FORMATS = ["twilio", "postmark", "generic", "raw"];
const CALL_STATUSES = ["missed", "voicemail", "answered"];

/** The first local `weekday` at `hm` strictly after now (DST-safe). */
function nextLocal(now, tz, weekday, hm) {
  const today = localDate(now, tz);
  for (let i = 0; i <= 7; i += 1) {
    const day = addDays(today, i);
    const at = atLocal(day, hm, tz);
    if (weekdayOf(day) === weekday && Date.parse(at) > Date.parse(now)) return at;
  }
  return atLocal(addDays(today, 7), hm, tz);
}

/** The new demo time for a clock request, or null for "real time". */
function clockTarget(body, now, tz) {
  if (body.set != null) {
    const t = Date.parse(body.set);
    if (!Number.isFinite(t)) throw invalid("set must be an ISO time.");
    return new Date(t).toISOString();
  }
  switch (body.preset) {
    case "real": return null;
    case "plus_30m": return addMinutes(now, 30);
    case "plus_2h": return addMinutes(now, 120);
    case "plus_1d": return atLocal(addDays(localDate(now, tz), 1), localHM(now, tz), tz);
    case "next_mon_0700": return nextLocal(now, tz, 1, "07:00");
    case "next_fri_1500": return nextLocal(now, tz, 5, "15:00");
    default: throw invalid("Unknown clock preset.");
  }
}

function customRequest(body) {
  const { channel, from, body: text, call_status: callStatus, duration_s: duration, format } = body;
  if (!CHANNELS.includes(channel)) throw invalid("channel must be sms, call, email or form.");
  if (format != null && !FORMATS.includes(format)) throw invalid("format must be twilio, postmark, generic or raw.");
  if (callStatus != null && !CALL_STATUSES.includes(callStatus)) throw invalid("call_status must be missed, voicemail or answered.");
  return buildCustom({
    channel, from: String(from ?? ""), body: String(text ?? ""), call_status: callStatus ?? undefined,
    duration_s: duration == null || duration === "" ? undefined : Number(duration), format: format ?? undefined,
  });
}

function presetRequest(name, settings) {
  if (!PRESETS.some((p) => p.id === name)) throw invalid(`Unknown preset: ${name}`);
  return buildPreset(name, { settings });
}

/** The clock went back to `now`: drop the texts dated after it, and their history lines. */
function forgetTextsAfter(db, now) {
  tx(db, () => {
    repo.deleteEventsAfter(db, now, ["notified"]);
    repo.deleteOutboxAfter(db, now);
  });
}

/**
 * deps: {db, now: () => ISO, env, publicUrl, clock: {setNow, now}, fetch?, send?}
 */
export function simRouter(deps) {
  const { db, publicUrl } = deps;
  const router = express.Router();
  const ctxAt = (now) => contextFor(db, now, { publicUrl });
  const runTick = async (now) => {
    const { sent, delivered } = tick(db, now, { env: deps.env, fetch: deps.fetch, publicUrl });
    const final = await delivered;
    return final.map((row, i) => row ?? sent[i]);
  };

  router.get("/sim/presets", (req, res) => {
    res.json({ items: PRESETS.map(({ id, label, note }) => ({ id, label, note })) });
  });

  router.post("/sim/inbound", (req, res) => {
    const body = req.body ?? {};
    const settings = repo.getSettings(db);
    const request = body.preset != null ? presetRequest(body.preset, settings) : customRequest(body);
    const { result } = ingestPayload(request.route, request.body, {
      db, now: deps.now, settings: () => settings, send: deps.send, demo: true,
    });
    const { refine, ...json } = result;
    res.json(json);
  });

  router.post("/sim/clock", async (req, res) => {
    const before = ctxAt(deps.now());
    const target = clockTarget(req.body ?? {}, before.now, before.tz);
    deps.clock.setNow(target);
    const offset = target == null ? 0 : deps.clock.now().getTime() - Date.now();
    repo.putSettings(db, { clock_offset_ms: offset });
    const now = deps.now();
    if (Date.parse(now) < Date.parse(before.now)) forgetTextsAfter(db, now);
    const sent = await runTick(now);
    res.json({ now, offset_ms: offset, sent: serializeOutbox(sent, ctxAt(now)) });
  });

  router.post("/sim/tick", async (req, res) => {
    const now = deps.now();
    const sent = await runTick(now);
    res.json({ sent: serializeOutbox(sent, ctxAt(now)) });
  });

  router.post("/sim/reset", (req, res) => {
    wipe(db);
    seedDemo(db, { env: deps.env, publicUrl });
    res.json({ now: deps.now() });
  });

  return router;
}
