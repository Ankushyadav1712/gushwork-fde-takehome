// The app's JSON API (SPEC §13.5): request parsing and responses only. Each handler reads `now`
// once and builds ctx with contextFor; writes happen in server/actions.js, and the read models
// and serialization live in server/context.js.
import express from "express";
import * as repo from "../repo.js";
import { ingestManual, ingestBulk, IngestError } from "../ingest.js";
import { extractWithAI, AI_MODEL } from "../ai.js";
import { smsMode } from "../notify.js";
import {
  ApiError, invalid, loadJob, performOutcome, performStage, performUndo, performEdit, logTap, updateSettings, sendDigestNow,
} from "../actions.js";
import {
  contextFor, serializeJob, jobDetail, jobList, todayCount, todayPayload, numbersFor, digestPreview,
  serializeOutbox, serializeMessages, settingsPayload, matchedCustomer, jobsCsv,
} from "../context.js";
import { parseMessage, mergeParse, parseNotebook, PARSE_FIELDS } from "../../shared/parse.js";
import { titleFor } from "../../shared/format.js";

const ADDED_TOAST = "Added. It's on your list.";
const LIST_LIMIT_MAX = 200;
const BULK_MAX_ROWS = 300;

const jobIdOf = (req) => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN);
const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

function listLimit(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, LIST_LIMIT_MAX) : 50;
}

function parseFields(parse) {
  const fields = Object.fromEntries(PARSE_FIELDS.map((key) => [key, parse[key] ?? null]));
  fields.urgent = Boolean(parse.urgent);
  return fields;
}

/** "Rosa's Taqueria's", "Midway Meats'". */
const possessive = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** Quick Add; a paste that isn't from the chosen job's customer is a 409 the screen answers with "It's a new job". */
function quickAdd(db, input, opts) {
  try {
    return ingestManual(db, input, opts);
  } catch (err) {
    if (err instanceof IngestError && err.code === "attach_mismatch") throw new ApiError(409, err.code, err.message);
    throw err;
  }
}

/**
 * deps: {db, now: () => ISO, env, publicUrl, demo: boolean, isShifted: () => boolean,
 *        clockOffsetMs: () => number, aiOn: () => boolean, extract?, fetch?}
 */
export function apiRouter(deps) {
  const { db } = deps;
  const router = express.Router();
  const ctxNow = () => contextFor(db, deps.now(), { publicUrl: deps.publicUrl });
  const extract = deps.extract ?? extractWithAI;
  const settingsResponse = (settings) => settingsPayload(settings, { env: deps.env, publicUrl: deps.publicUrl, aiOn: deps.aiOn() });

  const jobResponse = (result, ctx) => {
    const job = serializeJob(repo.getJobView(db, result.job_id), ctx);
    return { job, event_id: result.event_id, toast: result.toast, today_count: todayCount(db, ctx.now), on_today: job.on_today };
  };

  router.get("/health", (req, res) => {
    const ctx = ctxNow();
    res.json({
      ok: true, now: ctx.now, tz: ctx.tz, ai: deps.aiOn() ? "claude" : "rules", ai_model: AI_MODEL,
      sms: smsMode(deps.env), demo: deps.demo, passcode: Boolean(deps.env.APP_PASSCODE),
      unlinked_messages: repo.unlinkedMessageCount(db), clock_offset_ms: deps.clockOffsetMs(),
    });
  });

  router.get("/today", (req, res) => {
    res.json(todayPayload(db, ctxNow(), { shifted: Boolean(deps.demo && deps.isShifted()) }));
  });

  router.get("/jobs", (req, res) => {
    const filter = String(req.query.stage || "open");
    const list = jobList(db, filter, String(req.query.q ?? ""), ctxNow());
    if (!list) throw invalid(`Unknown stage filter: ${filter}`);
    res.json(list);
  });

  router.get("/jobs/:id", (req, res) => {
    res.json(jobDetail(db, loadJob(db, jobIdOf(req)), ctxNow()));
  });

  router.patch("/jobs/:id", (req, res) => {
    const ctx = ctxNow();
    const result = performEdit(db, jobIdOf(req), req.body, ctx);
    res.json({ job: serializeJob(repo.getJobView(db, result.job_id), ctx), event_id: result.event_id });
  });

  router.post("/jobs/:id/outcome", (req, res) => {
    const ctx = ctxNow();
    const result = performOutcome(db, jobIdOf(req), bodyOf(req), ctx);
    res.json({ ...jobResponse(result, ctx), spawned_job_id: result.spawned_job_id });
  });

  router.post("/jobs/:id/stage", (req, res) => {
    const ctx = ctxNow();
    res.json(jobResponse(performStage(db, jobIdOf(req), bodyOf(req), ctx), ctx));
  });

  router.post("/jobs/:id/undo", (req, res) => {
    const ctx = ctxNow();
    const eventId = Number(bodyOf(req).event_id);
    const result = performUndo(db, jobIdOf(req), Number.isInteger(eventId) ? eventId : NaN, ctx);
    res.json({ job: serializeJob(repo.getJobView(db, result.job_id), ctx), today_count: todayCount(db, ctx.now) });
  });

  router.post("/jobs/:id/tap", (req, res) => {
    logTap(db, jobIdOf(req), bodyOf(req), ctxNow());
    res.status(204).end();
  });

  router.post("/parse", async (req, res) => {
    const ctx = ctxNow();
    const { text: rawText, use_ai: useAi } = bodyOf(req);
    const text = typeof rawText === "string" ? rawText : "";
    const opts = {
      channel: "manual", owner_phone: ctx.settings.owner_phone, owner_email: ctx.settings.owner_email,
      twilio_from: deps.env.TWILIO_FROM ?? null, techs: ctx.settings.techs, now: ctx.now, tz: ctx.tz,
    };
    let parse = parseMessage(text, opts);
    let mode = "rules";
    if (useAi !== false && deps.aiOn() && text.trim()) {
      const ai = await Promise.resolve(extract(text, { channel: "manual" })).catch(() => null);
      if (ai) {
        parse = mergeParse(parse, ai, text, opts);
        mode = "ai";
      }
    }
    res.json({
      mode, fields: parseFields(parse), urgent_hits: parse.urgent_hits ?? [], stage_hint: parse.stage_hint ?? null,
      callback_date: parse.callback_date ?? null, quote_amount: parse.quote_amount ?? null,
      quote_sent_at: parse.quote_sent_at ?? null, visit_date: parse.visit_date ?? null, tech: parse.tech ?? null,
      matched_customer: matchedCustomer(db, parse, ctx.settings),
    });
  });

  // The whole body is ingestManual's input, so `attach_to_job_id` and `expected_customer_id` reach it as sent.
  router.post("/jobs", (req, res) => {
    const ctx = ctxNow();
    const result = quickAdd(db, bodyOf(req), {
      now: ctx.now, settings: ctx.settings, ...(deps.extract ? { extract: deps.extract } : {}),
    });
    if (result.status === "attached") {
      const title = titleFor(repo.getJobView(db, result.job_id));
      res.status(201).json({
        job_id: result.job_id, customer_id: result.customer_id, attached: true, toast: `Added to ${possessive(title)} open job.`,
      });
      return;
    }
    res.status(201).json({
      job_id: result.job_id, customer_id: result.customer_id, matched_customer: result.matched_customer, toast: ADDED_TOAST,
    });
  });

  router.post("/bulk/parse", (req, res) => {
    const ctx = ctxNow();
    const { text } = bodyOf(req);
    const rows = parseNotebook(typeof text === "string" ? text : "", {
      now: ctx.now, tz: ctx.tz, techs: ctx.settings.techs, owner_phone: ctx.settings.owner_phone,
      owner_email: ctx.settings.owner_email,
    });
    res.json({
      rows: rows.map((r) => ({
        line: r.line, fields: parseFields(r.fields), stage: r.stage, quote_amount: r.quote_amount ?? null,
        quote_sent_at: r.quote_sent_at ?? null, visit_date: r.visit_date ?? null, tech: r.tech ?? null,
        callback_date: r.callback_date ?? null, matched_customer: matchedCustomer(db, r.fields, ctx.settings),
      })),
    });
  });

  router.post("/bulk", (req, res) => {
    const ctx = ctxNow();
    const { rows } = bodyOf(req);
    if (!Array.isArray(rows) || !rows.length) throw invalid("Add at least one line.");
    if (rows.length > BULK_MAX_ROWS) throw invalid(`Up to ${BULK_MAX_ROWS} lines at a time.`);
    const result = ingestBulk(db, rows, { now: ctx.now, settings: ctx.settings });
    res.status(201).json({ created: result.created, errors: result.errors });
  });

  router.get("/numbers", (req, res) => {
    res.json(numbersFor(db, ctxNow()));
  });

  router.get("/settings", (req, res) => {
    res.json(settingsResponse(repo.getSettings(db)));
  });

  router.put("/settings", (req, res) => {
    res.json(settingsResponse(updateSettings(db, req.body)));
  });

  router.get("/digest/preview", (req, res) => {
    res.json(digestPreview(db, ctxNow()));
  });

  router.post("/digest/send", async (req, res) => {
    res.json(await sendDigestNow(db, ctxNow(), { env: deps.env, fetch: deps.fetch }));
  });

  router.get("/outbox", (req, res) => {
    res.json({ items: serializeOutbox(repo.listOutbox(db, listLimit(req.query.limit)), ctxNow()) });
  });

  router.get("/messages", (req, res) => {
    res.json({ items: serializeMessages(repo.listMessages(db, listLimit(req.query.limit))) });
  });

  router.get("/export/jobs.csv", (req, res) => {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="callback-jobs.csv"');
    res.set("Cache-Control", "no-store");
    res.send(jobsCsv(repo.getJobViews(db, { scope: "all" })));
  });

  return router;
}
