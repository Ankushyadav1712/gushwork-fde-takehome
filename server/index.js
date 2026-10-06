// Boot (SPEC §13.6): load .env, open the database, write default settings, restore the demo clock,
// listen, then work out the public URL once from the port actually bound, seed an empty demo
// database, start the scheduler (once now, then every 60 s) and print the one-line startup log.
// In production it refuses to start without APP_PASSCODE, or with signature checks on and no
// public PUBLIC_URL; elsewhere that second case is a warning.
import "./env.js";
import { createServer } from "node:http";
import { openDb } from "./db.js";
import { ensureSettings } from "./repo.js";
import * as clock from "./clock.js";
import { createApp, isDemo } from "./app.js";
import { resolvePublicUrl, DEFAULT_PORT } from "./context.js";
import { webhookUrlWarning } from "./routes/inbound.js";
import { seedDemo, hasJobs } from "./seed.js";
import * as scheduler from "./scheduler.js";
import { smsMode } from "./notify.js";
import { aiEnabled, AI_MODEL } from "./ai.js";
import { shortDateLabel, timeLabel } from "../shared/time.js";

function startupLine({ url, env, demo, tz }) {
  const ai = aiEnabled() ? `AI: on (${AI_MODEL})` : `AI: rules only (set ANTHROPIC_API_KEY for ${AI_MODEL})`;
  const sms = smsMode(env) === "twilio" ? `SMS: Twilio (from ${env.TWILIO_FROM})` : "SMS: simulated (outbox)";
  const inbound = `Inbound: /api/inbound/{sms,call,email,form}${env.INBOUND_TOKEN ? " (token required)" : ""}`;
  const passcode = `Passcode: ${env.APP_PASSCODE ? "on" : "off"}`;
  const now = clock.now().toISOString();
  const demoPart = demo ? `Demo: on, clock ${shortDateLabel(now, tz)} ${timeLabel(now, tz)}` : "Demo: off";
  return `Callback on ${url} | ${ai} | ${sms} | ${inbound} | ${passcode} | ${demoPart}`;
}

function refuse(message) {
  console.error(`Callback won't start: ${message}`);
  process.exit(1);
}

function boot(env) {
  const production = env.NODE_ENV === "production";
  if (production && !env.APP_PASSCODE) refuse("NODE_ENV=production needs APP_PASSCODE set (see .env.example).");
  const urlProblem = webhookUrlWarning(env);
  if (production && urlProblem) refuse(urlProblem);

  const demo = isDemo(env);
  const db = openDb(env.DB_PATH || "data/callback.db");
  const settings = ensureSettings(db, env.BUSINESS_TZ ? { timezone: env.BUSINESS_TZ } : {});
  if (demo && Number(settings.clock_offset_ms)) clock.setNow(Date.now() + Number(settings.clock_offset_ms));

  const port = env.PORT === undefined || env.PORT === "" ? DEFAULT_PORT : Number(env.PORT);
  const server = createServer();
  let stopScheduler = () => {};

  server.on("listening", () => {
    const publicUrl = resolvePublicUrl(env, server.address().port);
    if (demo && !hasJobs(db)) seedDemo(db, { env, publicUrl });
    server.on("request", createApp({ db, env, publicUrl }));
    stopScheduler = scheduler.start(db, { env, publicUrl, now: () => clock.now().toISOString() });
    console.log(startupLine({ url: publicUrl, env, demo, tz: settings.timezone }));
    if (urlProblem) console.warn(`Warning: ${urlProblem}`);
  });
  server.on("error", (err) => {
    console.error(`Callback couldn't listen on port ${port} (${err.code ?? err.message}).`);
    process.exit(1);
  });
  server.listen(port);

  const shutdown = () => {
    stopScheduler();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

boot(process.env);
