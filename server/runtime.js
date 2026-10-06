// The boot steps every entry point shares (SPEC §13.6): the production rules, the database, default
// settings, the demo clock and the demo seed. server/index.js (the long-running server) and
// api/index.js (the Vercel demo function) both start here, so the two can't drift apart.
import { openDb } from "./db.js";
import { ensureSettings } from "./repo.js";
import * as clock from "./clock.js";
import { isDemo } from "./app.js";
import { webhookUrlWarning } from "./routes/inbound.js";
import { seedDemo, hasJobs } from "./seed.js";

export const DEFAULT_DB_PATH = "data/callback.db";

/** This configuration must not start. The message says what to set. */
export class StartError extends Error {
  constructor(message) {
    super(message);
    this.name = "StartError";
  }
}

/**
 * The production rules, checked before anything is opened. Production needs APP_PASSCODE unless the
 * caller runs a demo by design (demo: true, passed only by api/index.js), and with signature checks
 * on it needs a public PUBLIC_URL. Throws StartError; otherwise returns the PUBLIC_URL warning to
 * print outside production, or null.
 */
export function checkStart(env = process.env, { demo = isDemo(env) } = {}) {
  const production = env.NODE_ENV === "production";
  if (production && !env.APP_PASSCODE && !demo) {
    throw new StartError("NODE_ENV=production needs APP_PASSCODE set (see .env.example).");
  }
  const urlProblem = webhookUrlWarning(env);
  if (production && urlProblem) throw new StartError(urlProblem);
  return urlProblem;
}

/**
 * openRuntime(env, {demo?}) -> {db, settings, demo, warning, seedIfEmpty(publicUrl)}.
 * demo defaults to isDemo(env), so the long-running server can never be a demo in production.
 * Checks the production rules, opens the database at DB_PATH, writes default settings and, in demo
 * mode, restores the saved demo clock. seedIfEmpty(publicUrl) seeds the demo week into an empty demo
 * database; it is separate because the server only knows its public URL once it is listening.
 */
export function openRuntime(env = process.env, { demo = isDemo(env) } = {}) {
  const warning = checkStart(env, { demo });
  const db = openDb(env.DB_PATH || DEFAULT_DB_PATH);
  const settings = ensureSettings(db, env.BUSINESS_TZ ? { timezone: env.BUSINESS_TZ } : {});
  if (demo && Number(settings.clock_offset_ms)) clock.setNow(Date.now() + Number(settings.clock_offset_ms));
  const seedIfEmpty = (publicUrl) => {
    if (demo && !hasJobs(db)) seedDemo(db, { env, publicUrl });
  };
  return { db, settings, demo, warning, seedIfEmpty };
}
