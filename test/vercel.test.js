// The Vercel demo entry (api/index.js, vercel.json) and the shared boot (server/runtime.js): the
// function behind a real HTTP server with NODE_ENV=production, as Vercel may run it; the explicit
// demo opt-in; request-driven scheduling; rewritten URLs; and server/index.js's unchanged startup line.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import handler, { createVercelHandler, demoEnv, routedUrl, ROUTED_PATH_PARAM } from "../api/index.js";
import { isDemo } from "../server/app.js";
import { checkStart, StartError } from "../server/runtime.js";
import * as clock from "../server/clock.js";
import { addDays, atLocal, localDate } from "../shared/time.js";

// The default handler reads process.env on its first request.
const dir = mkdtempSync(join(tmpdir(), "callback-vercel-"));
process.env.NODE_ENV = "production";
process.env.DB_PATH = join(dir, "callback.db");
process.env.AI_PARSING = "off";
for (const key of ["APP_PASSCODE", "PUBLIC_URL", "DEMO", "ALLOW_DEMO_IN_PRODUCTION", "TWILIO_AUTH_TOKEN", "MAILGUN_SIGNING_KEY",
  "TWILIO_ACCOUNT_SID", "TWILIO_FROM", "INBOUND_TOKEN", "BUSINESS_TZ", "VERCEL", "VERCEL_ENV", "VERCEL_URL",
  "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"]) delete process.env[key];

const servers = [];
after(() => {
  for (const s of servers) s.close();
  clock.setNow(null);
  rmSync(dir, { recursive: true, force: true });
});

/** fn behind http.createServer on a free port; resolves {get, post}. */
async function serve(fn) {
  const server = createServer(fn);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, text, json: type.includes("json") && text ? JSON.parse(text) : null };
  };
  return { get: (path) => call("GET", path), post: (path, body = {}) => call("POST", path, body) };
}

const cards = (today) => today.sections.flatMap((s) => s.items);
const vercel = await serve(handler);

// ---------------------------------------------------------------------------
// The function

test("on Vercel (NODE_ENV=production) the function is the demo: seeded, nothing unlinked, Bella Cucina first", async () => {
  const health = await vercel.get("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.demo, true);
  assert.equal(health.json.passcode, false);
  assert.equal(health.json.unlinked_messages, 0);

  const today = (await vercel.get("/api/today")).json;
  assert.equal(today.header, "10 people to call");
  assert.equal(cards(today).length, 10);
  assert.equal(cards(today)[0].title, "Bella Cucina");
  assert.equal(today.demo.shifted, true, "the demo clock is on Monday 7:00am");
});

test("/shared/*.js is served as JavaScript, with the same security headers as the rest of the app", async () => {
  const res = await vercel.get("/shared/time.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^(text|application)\/javascript/);
  assert.match(res.text, /export function/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("a rewritten request routes on ?__cb_path=, whatever path the platform passes along", async () => {
  // As the destination (/api/index) or as the visitor's own path, with the visitor's query kept.
  const viaIndex = await vercel.get(`/api/index?${ROUTED_PATH_PARAM}=%2Fapi%2Fjobs&stage=open`);
  assert.equal(viaIndex.status, 200);
  assert.ok(viaIndex.json.jobs.length > 0);
  const viaOriginal = await vercel.get(`/api/today?${ROUTED_PATH_PARAM}=/api/today`);
  assert.equal(viaOriginal.json.header, "10 people to call");
  const settings = (await vercel.get("/api/settings")).json;
  const page = await vercel.get(`/api/index?${ROUTED_PATH_PARAM}=/n/${settings.readonly_key}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
});

test("Reset demo works on the function", async () => {
  await vercel.post("/api/jobs/16/outcome", { outcome: "no_answer" });
  const reset = await vercel.post("/api/sim/reset");
  assert.equal(reset.status, 200);
  assert.ok(reset.json.now);
  const today = (await vercel.get("/api/today")).json;
  assert.equal(cards(today).length, 10);
  assert.equal(cards(today)[0].title, "Bella Cucina");
});

test("moving the demo clock through the API sends the next morning text to the outbox", async () => {
  await vercel.post("/api/sim/reset");
  const before = (await vercel.get("/api/outbox")).json.items.length;
  const moved = await vercel.post("/api/sim/clock", { preset: "plus_1d" });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.sent.length, 1);
  assert.equal(moved.json.sent[0].kind, "digest");
  const outbox = (await vercel.get("/api/outbox")).json.items;
  assert.equal(outbox.length, before + 1);
  assert.ok(outbox[0].body.endsWith("Open: http://localhost:3000/#/"), outbox[0].body);
});

test("request-driven scheduling: the scheduler runs before a request, at most once a minute", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "callback-vercel-tick-"));
  let ms = 0;
  const own = await serve(createVercelHandler({
    env: { NODE_ENV: "production", DB_PATH: join(tmp, "callback.db") }, nowMs: () => ms,
  }));
  try {
    const seeded = (await own.get("/api/outbox")).json.items.length; // boots, seeds, runs the scheduler
    const tz = (await own.get("/api/health")).json.tz;
    // The next weekday morning, without going through the simulator (which runs the scheduler itself).
    clock.setNow(atLocal(addDays(localDate(clock.now().toISOString(), tz), 1), "07:05", tz));
    ms = 30_000;
    assert.equal((await own.get("/api/outbox")).json.items.length, seeded, "less than a minute since the last run");
    ms = 60_000;
    const items = (await own.get("/api/outbox")).json.items;
    assert.equal(items.length, seeded + 1, "a minute later the morning text goes out");
    assert.equal(items[0].kind, "digest");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("APP_PASSCODE still guards the Vercel demo when it is set", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "callback-vercel-pass-"));
  const own = await serve(createVercelHandler({
    env: { NODE_ENV: "production", APP_PASSCODE: "4321", DB_PATH: join(tmp, "callback.db") },
  }));
  try {
    assert.equal((await own.get("/api/health")).json.passcode, true);
    assert.equal((await own.get("/api/today")).status, 401);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pieces

test("isDemo: no environment can make production a demo", () => {
  assert.equal(isDemo({ NODE_ENV: "production", DEMO: "1" }), false);
  // Regression: an env opt-in let a long-running production server start as a demo with no passcode.
  assert.equal(isDemo({ NODE_ENV: "production", DEMO: "1", ALLOW_DEMO_IN_PRODUCTION: "1" }), false);
  assert.equal(isDemo({ DEMO: "1" }), true);
  assert.equal(isDemo({}), true);
  assert.equal(isDemo({ DEMO: "0" }), false);
  const example = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");
  assert.doesNotMatch(example, /ALLOW_DEMO_IN_PRODUCTION/);
});

test("checkStart: production needs APP_PASSCODE unless the caller runs a demo by design", () => {
  assert.throws(() => checkStart({ NODE_ENV: "production", DEMO: "1" }), (err) => err instanceof StartError && /APP_PASSCODE/.test(err.message));
  assert.throws(() => checkStart({ NODE_ENV: "production", DEMO: "1", ALLOW_DEMO_IN_PRODUCTION: "1" }), StartError);
  assert.equal(checkStart({ NODE_ENV: "production", APP_PASSCODE: "4321" }), null);
  assert.equal(checkStart({ NODE_ENV: "production" }, { demo: true }), null);
  assert.throws(() => checkStart({ NODE_ENV: "production", APP_PASSCODE: "4321", TWILIO_AUTH_TOKEN: "t" }), /PUBLIC_URL/);
  assert.match(checkStart({ TWILIO_AUTH_TOKEN: "t" }), /PUBLIC_URL/);
});

test("demoEnv: always the demo, SQLite in /tmp, links to this deployment", () => {
  const prod = demoEnv({ NODE_ENV: "production", VERCEL_ENV: "production", VERCEL_URL: "cb-abc123.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "cb.vercel.app" });
  assert.deepEqual([prod.DEMO, prod.DB_PATH, prod.PUBLIC_URL], ["1", "/tmp/callback.db", "https://cb.vercel.app"]);
  assert.equal("ALLOW_DEMO_IN_PRODUCTION" in prod, false, "the demo is forced in code, not through env");
  const preview = demoEnv({ VERCEL_ENV: "preview", VERCEL_URL: "cb-abc123.vercel.app", VERCEL_BRANCH_URL: "cb-git-x.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "cb.vercel.app" });
  assert.equal(preview.PUBLIC_URL, "https://cb-git-x.vercel.app");
  assert.equal(demoEnv({ PUBLIC_URL: "https://demo.example.com", VERCEL_URL: "x.vercel.app", DEMO: "0", DB_PATH: "/tmp/x.db" }).PUBLIC_URL, "https://demo.example.com");
  assert.equal(demoEnv({ DEMO: "0" }).DEMO, "1");
  assert.equal(demoEnv({ DB_PATH: "/tmp/x.db" }).DB_PATH, "/tmp/x.db");
  assert.equal(demoEnv({}).PUBLIC_URL, undefined, "off Vercel the app falls back to localhost");
});

test("routedUrl puts back the visitor's path and keeps the rest of the query byte for byte", () => {
  assert.equal(routedUrl("/api/index?__cb_path=/api/today"), "/api/today");
  // What vercel.json compiles to: the prefix escaped, the visitor's path as it came, or escaped too.
  assert.equal(routedUrl("/api/index?__cb_path=%2Fapi%2Fjobs/16/outcome"), "/api/jobs/16/outcome");
  assert.equal(routedUrl("/api/index?__cb_path=%2Fapi%2Fjobs%2F16%2Foutcome"), "/api/jobs/16/outcome");
  assert.equal(routedUrl("/api/index?__cb_path=%2Fshared%2Fa%20b+c.js"), "/shared/a%20b+c.js");
  assert.equal(routedUrl("/api/index?__cb_path=%2Fn%2F%E0%A4%A"), "/n/%E0%A4%A", "a bad escape is kept as it came");
  assert.equal(routedUrl("/api/inbound/sms?token=a%2Bb&__cb_path=/api/inbound/sms"), "/api/inbound/sms?token=a%2Bb");
  assert.equal(routedUrl("/api/index?__cb_path=//evil.example/x"), "/evil.example/x");
  assert.equal(routedUrl("/api/index?__cb_path="), "/");
  assert.equal(routedUrl("/api/today?stage=open"), "/api/today?stage=open");
  assert.equal(routedUrl("/api/today"), "/api/today");
});

test("the default export is server-like: listen() serves the app, and tells Vercel's launcher to leave req and res alone", async () => {
  const server = handler.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.equal((await res.json()).demo, true);
});

test("vercel.json: public/ from the CDN, the server paths to the function, the app's own security headers", async () => {
  const config = JSON.parse(readFileSync(fileURLToPath(new URL("../vercel.json", import.meta.url)), "utf8"));
  assert.equal(config.framework, null, "'Other', so Vercel doesn't look for a zero-config Express entry");
  assert.equal(config.outputDirectory, "public");
  assert.match(config.functions["api/index.js"].includeFiles, /shared\/\*\*/);
  // Unnamed groups: a named :param would also be appended to the query (path=...), which would
  // change the URL Twilio signed.
  assert.deepEqual(config.rewrites, ["/api", "/n", "/shared"].map((prefix) => ({
    source: `${prefix}/(.*)`, destination: `/api/index?${ROUTED_PATH_PARAM}=${prefix}/$1`,
  })));
  const fromExpress = (await vercel.get("/api/health")).headers;
  const rule = config.headers.find((h) => h.source === "/(.*)");
  for (const { key, value } of rule.headers) assert.equal(value, fromExpress.get(key), key);
  assert.deepEqual(rule.headers.map((h) => h.key).sort(), ["Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options"]);
});

// ---------------------------------------------------------------------------
// server/index.js on top of server/runtime.js

const SERVER = fileURLToPath(new URL("../server/index.js", import.meta.url));
const STARTUP_LINE = /^Callback on http:\/\/localhost:\d+ \| AI: rules only \(set ANTHROPIC_API_KEY for claude-sonnet-5-5\) \| SMS: simulated \(outbox\) \| Inbound: \/api\/inbound\/\{sms,call,email,form\} \| Passcode: off \| Demo: on, clock Mon [A-Z][a-z]{2} \d{1,2} 7:0\dam$/;

/** Start server/index.js from an empty folder (so no .env is read); resolves its first stdout line. */
function firstLine(env) {
  const home = mkdtempSync(join(tmpdir(), "callback-boot-"));
  const child = spawn(process.execPath, [SERVER], {
    cwd: home, env: { PATH: process.env.PATH, PORT: "0", DB_PATH: join(home, "boot.db"), ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let line = null;
    const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (line == null && out.includes("\n")) {
        line = out.split("\n")[0];
        child.kill("SIGTERM");
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      if (line == null) reject(new Error(`no startup line (exit ${code}): ${out}${err}`));
      else resolve(line);
    });
  });
}

test("server/index.js still prints the same one-line startup log", async () => {
  assert.match(await firstLine({}), STARTUP_LINE);
});

test("server/index.js: no env opt-in starts a production server as a demo without a passcode", () => {
  const home = mkdtempSync(join(tmpdir(), "callback-boot-"));
  try {
    const res = spawnSync(process.execPath, [SERVER], {
      cwd: home,
      env: { PATH: process.env.PATH, PORT: "0", DB_PATH: join(home, "boot.db"), NODE_ENV: "production", DEMO: "1", ALLOW_DEMO_IN_PRODUCTION: "1" },
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /needs APP_PASSCODE/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("server/index.js: production with DEMO=1 alone still refuses to start without APP_PASSCODE", () => {
  const home = mkdtempSync(join(tmpdir(), "callback-boot-"));
  try {
    const res = spawnSync(process.execPath, [SERVER], {
      cwd: home, env: { PATH: process.env.PATH, PORT: "0", DB_PATH: join(home, "boot.db"), NODE_ENV: "production", DEMO: "1" },
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(res.status, 1);
    assert.equal(res.stderr.trim(), "Callback won't start: NODE_ENV=production needs APP_PASSCODE set (see .env.example).");
    assert.equal(res.stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
