// Vercel entry (README "Deploy a demo"): the whole app as one Vercel Function, and a DEMO by design.
// Vercel gives a function no lasting disk, only a /tmp that lives as long as the instance, so this
// entry can never hold Denise's real data. It always runs in demo mode, decided here in code
// (openRuntime and createApp get demo: true), so no environment variable can make the long-running
// server a demo in production. SQLite lives in /tmp/callback.db. Each instance seeds its own demo week the first time it is used, so a cold start
// or a second instance starts again from Monday 7:00am. There is no always-on process either: instead
// of the 60-second timer, the scheduler runs before a request, at most once a minute per instance.
// APP_PASSCODE still works if set. For real data, run server/index.js (Docker, Render) with a disk.
//
// vercel.json serves public/ from the CDN and rewrites /api/*, /n/* and /shared/* here with the
// path the visitor asked for in ?__cb_path=, so Express routes on that path whatever URL the
// platform hands this function.
import { createServer } from "node:http";
import { createApp } from "../server/app.js";
import { resolvePublicUrl } from "../server/context.js";
import { openRuntime } from "../server/runtime.js";
import { tick } from "../server/scheduler.js";
import * as clock from "../server/clock.js";

export const ROUTED_PATH_PARAM = "__cb_path";
const TICK_EVERY_MS = 60_000;
const TMP_DB_PATH = "/tmp/callback.db";
// What Vercel's Node "helpers" put on res. listen() below keeps them off; if they appear anyway, they
// are dropped so Express's own versions of all four run.
const RES_HELPERS = ["status", "send", "json", "redirect"];

/** This deployment's own address: the production domain in production, else the branch or deployment URL. */
function vercelHost(env) {
  const own = env.VERCEL_BRANCH_URL || env.VERCEL_URL;
  if (env.VERCEL_ENV === "production") return env.VERCEL_PROJECT_PRODUCTION_URL || own;
  return own || env.VERCEL_PROJECT_PRODUCTION_URL;
}

/** The env the app runs with on Vercel: always the demo, SQLite in /tmp, links to this deployment. */
export function demoEnv(base = process.env) {
  const env = { ...base, DEMO: "1", DB_PATH: base.DB_PATH || TMP_DB_PATH };
  const host = vercelHost(base);
  if (!env.PUBLIC_URL && host) env.PUBLIC_URL = `https://${host}`;
  return env;
}

/** A ?__cb_path= value as a path: "%2Fapi%2Fjobs/16" -> "/api/jobs/16", other escapes kept as escapes. */
function pathFrom(value) {
  let path;
  try {
    path = encodeURI(decodeURIComponent(value));
  } catch {
    path = value.replace(/%2F/gi, "/");
  }
  return `/${path.replace(/^\/+/, "")}`;
}

/**
 * The URL to route on. A rewrite passes the visitor's path in ?__cb_path=; it replaces the path and
 * leaves the rest of the query as it came (Twilio signs the exact URL). Other URLs pass unchanged.
 */
export function routedUrl(url = "/") {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const parts = url.slice(q + 1).split("&");
  const isRouted = (part) => part === ROUTED_PATH_PARAM || part.startsWith(`${ROUTED_PATH_PARAM}=`);
  const routed = parts.find(isRouted);
  if (routed === undefined) return url;
  const path = pathFrom(routed.slice(ROUTED_PATH_PARAM.length + 1));
  const rest = parts.filter((part) => part !== "" && !isRouted(part));
  return rest.length ? `${path}?${rest.join("&")}` : path;
}

/**
 * createVercelHandler({env?, nowMs?, tickEveryMs?}) -> async (req, res) handler.
 * env is read on the first request (default: process.env). nowMs is the real clock used to space
 * out scheduler runs (tests replace it); the scheduler itself runs on the demo clock.
 */
export function createVercelHandler({ env: baseEnv, nowMs = Date.now, tickEveryMs = TICK_EVERY_MS } = {}) {
  let instance = null;

  // Once per instance: open /tmp/callback.db (seeding an empty one) and build the Express app.
  const boot = () => {
    const env = demoEnv(baseEnv ?? process.env);
    const publicUrl = resolvePublicUrl(env);
    const runtime = openRuntime(env, { demo: true });
    runtime.seedIfEmpty(publicUrl);
    const app = createApp({ db: runtime.db, env, publicUrl, demo: true });
    // Vercel's edge sets X-Forwarded-For itself (clients can't spoof it), so req.ip is the visitor:
    // the passcode lockout then counts failed logins per visitor, not for everyone at once.
    app.set("trust proxy", true);
    return { db: runtime.db, env, publicUrl, app, lastTickMs: -Infinity };
  };

  // Request-driven scheduling: the 7am text and reminders go out when someone uses the app.
  const tickIfDue = async (rt) => {
    const at = nowMs();
    if (at - rt.lastTickMs < tickEveryMs) return;
    rt.lastTickMs = at;
    try {
      const { delivered } = tick(rt.db, clock.now().toISOString(), { env: rt.env, publicUrl: rt.publicUrl });
      await delivered;
    } catch (err) {
      console.warn(`[scheduler] tick failed (${err?.name ?? "Error"}: ${err?.message ?? ""})`);
    }
  };

  async function handler(req, res) {
    try {
      instance ??= boot();
    } catch (err) {
      console.error(`Callback couldn't start (${err?.name ?? "Error"}: ${err?.message ?? ""})`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { code: "server_error", message: "Callback couldn't start on this instance." } }));
      return;
    }
    req.url = routedUrl(req.url);
    for (const key of RES_HELPERS) if (Object.hasOwn(res, key)) delete res[key];
    await tickIfDue(instance);
    instance.app(req, res);
  }

  // A listen() makes the export server-like, as an Express app is. Vercel's Node launcher then hands
  // req and res over untouched; for a bare function it first reads the body itself and adds its own
  // res helpers, and Express's body parsers would find the body already read. It also runs locally.
  handler.listen = (...args) => createServer(handler).listen(...args);
  return handler;
}

export default createVercelHandler();
