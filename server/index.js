// Boot (SPEC §13.6): open the database, write default settings, restore the demo clock, seed an
// empty demo database, start the scheduler (once now, then every 60 s), listen, and print the
// one-line startup log. Refuses to start in production without APP_PASSCODE.
import { openDb } from "./db.js";
import { ensureSettings } from "./repo.js";
import * as clock from "./clock.js";
import { createApp, isDemo } from "./app.js";
import { seedDemo, hasJobs } from "./seed.js";
import * as scheduler from "./scheduler.js";
import { smsMode } from "./notify.js";
import { aiEnabled, AI_MODEL } from "./ai.js";
import { shortDateLabel, timeLabel } from "../shared/time.js";

const DEFAULT_PORT = 3000;

function startupLine({ url, env, demo, tz }) {
  const ai = aiEnabled() ? `AI: on (${AI_MODEL})` : `AI: rules only (set ANTHROPIC_API_KEY for ${AI_MODEL})`;
  const sms = smsMode(env) === "twilio" ? `SMS: Twilio (from ${env.TWILIO_FROM})` : "SMS: simulated (outbox)";
  const inbound = `Inbound: /api/inbound/{sms,call,email,form}${env.INBOUND_TOKEN ? " (token required)" : ""}`;
  const passcode = `Passcode: ${env.APP_PASSCODE ? "on" : "off"}`;
  const now = clock.now().toISOString();
  const demoPart = demo ? `Demo: on, clock ${shortDateLabel(now, tz)} ${timeLabel(now, tz)}` : "Demo: off";
  return `Callback on ${url} | ${ai} | ${sms} | ${inbound} | ${passcode} | ${demoPart}`;
}

function boot(env) {
  if (env.NODE_ENV === "production" && !env.APP_PASSCODE) {
    console.error("Callback won't start: NODE_ENV=production needs APP_PASSCODE set (see .env.example).");
    process.exit(1);
  }
  const demo = isDemo(env);
  const db = openDb(env.DB_PATH || "data/callback.db");
  const settings = ensureSettings(db, env.BUSINESS_TZ ? { timezone: env.BUSINESS_TZ } : {});
  if (demo && Number(settings.clock_offset_ms)) clock.setNow(Date.now() + Number(settings.clock_offset_ms));
  if (demo && !hasJobs(db)) seedDemo(db, { env });

  const app = createApp({ db, env });
  const port = env.PORT === undefined || env.PORT === "" ? DEFAULT_PORT : Number(env.PORT);
  const server = app.listen(port);
  let stopScheduler = () => {};

  server.on("listening", () => {
    const url = env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, "") : `http://localhost:${server.address().port}`;
    stopScheduler = scheduler.start(db, { env, now: () => clock.now().toISOString() });
    console.log(startupLine({ url, env, demo, tz: settings.timezone }));
  });
  server.on("error", (err) => {
    console.error(`Callback couldn't listen on port ${port} (${err.code ?? err.message}).`);
    process.exit(1);
  });

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
