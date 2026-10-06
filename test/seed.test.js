// Demo seed replay (SPEC §12): T04 at the database level, the §12.4 outbox and job 16's history,
// T19 (Friday sweep), R14 (Numbers) and the CLI. Everything runs through the real ingest(),
// performOutcome() and scheduler, then is read back through the HTTP API.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, all, get } from "../server/db.js";
import * as repo from "../server/repo.js";
import * as clock from "../server/clock.js";
import { seedDemo, defaultAnchor } from "../server/seed.js";
import { createApp } from "../server/app.js";
import { seedJobViews, SEED_ANCHOR } from "./fixtures/seed-state.js";
import { mostRecentMonday0700 } from "../shared/time.js";

process.env.AI_PARSING = "off";
const A = SEED_ANCHOR; // Mon 2026-10-05 07:00 America/Chicago
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const servers = [];
after(() => {
  for (const s of servers) s.close();
  clock.setNow(null);
});

function seeded(anchor = A) {
  const db = openDb(":memory:");
  const result = seedDemo(db, { anchor, env: {} });
  return { db, result };
}

async function serve(db, now = () => A) {
  const app = createApp({ db, now, env: {} });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, json: await res.json() };
  };
}

const EXPECTED_ROWS = [
  [1, "Bella Cucina", ["URGENT"], "Walk-in freezer at 28 degrees and climbing - voicemail Fri 4:47pm, nobody's called back", "Not contacted - 2d 14h (red)"],
  [2, "Harbor Grill", [], "Texted yesterday 6:05pm: \"Can Mike come Wednesday instead of Tuesday? We're closed…\"", "12h (grey)"],
  [3, "(312) 555-0177", [], "New - missed call Sat 1:12pm - no voicemail", "Not contacted - 1d 17h (amber)"],
  [4, "Fresh Mart #2", [], "New - web form today 6:02am - Deli ice machine making half the ice", "Not contacted - 58m (grey)"],
  [5, "Joe's Diner", ["Repeat - 1 past job"], "Said yes Fri - not scheduled yet - hasn't heard from us in 3 days", "2d 17h (red)"],
  [6, "Midway Meats", [], "Waiting on your quote since Wed - hasn't heard from us in 5 days", "4d 20h (red)"],
  [7, "Hillside Grocery", [], "Waiting on your quote since Thu - hasn't heard from us in 4 days", "3d 20h (red)"],
  [8, "Lakeview Brewing Co.", [], "Waiting on your quote since Fri - hasn't heard from us in 3 days", "2d 21h (red)"],
  [9, "Rosa's Taqueria", ["Repeat - 1 past job"], "Quote sent Thu, $2,400 - no answer in 4 days", "3d 16h (amber)"],
  [10, "Sal's Pizza", [], "Luis went Fri - done?", null],
];

const cardRows = (today) => today.sections.flatMap((s) => s.items).map((c) => [
  c.rank, c.title, c.badges, c.reason, c.chip && `${c.chip.text} (${c.chip.tone})`,
]);

test("T04 seed: GET /api/today at A equals §12.3 exactly", async () => {
  const { db, result } = seeded();
  assert.deepEqual(result, { anchor: A, jobs: 18, texts: 6 });
  const { status, json: today } = await (await serve(db))("/api/today");
  assert.equal(status, 200);
  assert.equal(today.date_label, "Monday, Oct 5");
  assert.equal(today.header, "10 people to call");
  assert.equal(today.count, 10);
  assert.equal(today.waiting_yes_text, "$8,400 waiting on a yes");
  assert.equal(today.waiting_yes_total, 8400);
  assert.equal(today.waiting_yes_count, 2);
  assert.deepEqual(today.sections.map((s) => `${s.label} (${s.count})`), [
    "Urgent - call first (1)",
    "They got back to you (1)",
    "New - call them back (2)",
    "Said yes - needs scheduling (1)",
    "Waiting on your quote (3)",
    "Waiting on their yes - check in (1)",
    "Did it get done? (1)",
  ]);
  assert.deepEqual(cardRows(today), EXPECTED_ROWS);
  const cards = today.sections.flatMap((s) => s.items);
  assert.deepEqual(cards.map((c) => c.job_id), [16, 8, 17, 18, 13, 11, 14, 15, 7, 10]);
  assert.deepEqual(cards.map((c) => c.source_label), [
    "Voicemail", "Web form", "Missed call", "Web form", "Text", "Text", "Text", "Web form", "Text", "Text",
  ]);
  assert.equal(today.strip.map((s) => `${s.label} ${s.count}`).join(" · "), "New 3 · Waiting on quote 3 · Their yes 2 · Said yes 2 · Scheduled 3");
  assert.deepEqual(today.stage_counts, { new: 3, quote: 3, waiting_yes: 2, to_schedule: 2, scheduled: 3 });
  assert.equal(today.open_count, 13);
  assert.deepEqual(today.footer, {
    scheduled_today: 1, snoozed: 1, text: "Scheduled today: 1 · Snoozed: 1",
    last24h_text: "Last 24 hours: 1 came in, 1 not called yet",
  });
  assert.deepEqual(today.demo, { shifted: true, label: "Demo time: Mon Oct 5, 7:00am" });
});

test("seed rows equal the pure replay of the same records (test/fixtures/seed-state.js)", () => {
  const { db } = seeded();
  const views = repo.getJobViews(db, { scope: "all" });
  const fixture = seedJobViews();
  assert.equal(views.length, 18);
  for (const expected of fixture) {
    const actual = views.find((v) => v.id === expected.id);
    const { customer, last_inbound: lastInbound, past_jobs: pastJobs, ...row } = expected;
    for (const [key, value] of Object.entries(row)) assert.deepEqual(actual[key], value, `job ${expected.id}.${key}`);
    assert.deepEqual(actual.last_inbound, lastInbound, `job ${expected.id} last_inbound`);
    assert.equal(actual.past_jobs, pastJobs, `job ${expected.id} past_jobs`);
    for (const key of ["contact_name", "business_name", "phone", "email", "address"]) {
      assert.equal(actual.customer[key], customer[key] ?? null, `job ${expected.id} customer.${key}`);
    }
  }
  assert.equal(get(db, "SELECT count(*) AS n FROM customers").n, 16);
  assert.equal(repo.unlinkedMessageCount(db), 0);
});

test("§12.4 outbox at A, oldest first, through GET /api/outbox", async () => {
  const { db } = seeded();
  const { json } = await (await serve(db))("/api/outbox?limit=50");
  const rows = [...json.items].reverse().map((o) => [o.at_label, o.kind, o.body]);
  const open = "Open: http://localhost:3000/#/";
  assert.deepEqual(rows, [
    ["Fri 3:00pm", "friday_sweep", `Before the weekend: 3 people still waiting on you - Joe's Diner, Midway Meats, Hillside Grocery. ${open}`],
    ["Fri 5:20pm", "nag", "Still not called back (URGENT): Bella Cucina - Walk-in freezer at 28 degrees and climbing. Came in today 4:47pm. Call (312) 555-0142. Open: http://localhost:3000/#/job/16"],
    ["Sat 7:00am", "digest", ["Weekend check - 1 waiting on a call back:", "1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)", open].join("\n")],
    ["Sat 3:15pm", "nag", "Still not called back: (312) 555-0177 - missed call, no voicemail. Came in today 1:12pm. Open: http://localhost:3000/#/job/17"],
    ["Sun 7:00am", "digest", [
      "Weekend check - 2 waiting on a call back:",
      "1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)",
      "2. (312) 555-0177 - new: missed call, no voicemail",
      open,
    ].join("\n")],
    ["Mon 7:00am", "digest", [
      "Morning Denise - 10 to call today:",
      "1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)",
      "2. Harbor Grill - texted back",
      "3. (312) 555-0177 - new: missed call, no voicemail",
      "4. Fresh Mart #2 - new: Deli ice machine making half the ice",
      "5. Joe's Diner - said yes, needs scheduling",
      "6. Midway Meats - quote to send",
      "+4 more.",
      open,
    ].join("\n")],
  ]);
  for (const o of json.items) {
    assert.equal(o.status, "simulated");
    assert.equal(o.to_phone, "+13125550100");
    assert.equal(o.to_name, "Denise");
  }
  assert.deepEqual(all(db, "SELECT dedupe_key FROM outbox ORDER BY id").map((r) => r.dedupe_key),
    ["sweep:2026-10-02", "nag:16", "digest:2026-10-03", "nag:17", "digest:2026-10-04", "digest:2026-10-05"]);
});

test("T19 the seed replay produces the Fri 3:00pm sweep exactly", () => {
  const { db } = seeded();
  const sweep = get(db, "SELECT created_at, body FROM outbox WHERE kind = 'friday_sweep'");
  assert.deepEqual(sweep, {
    created_at: "2026-10-02T20:00:00.000Z",
    body: "Before the weekend: 3 people still waiting on you - Joe's Diner, Midway Meats, Hillside Grocery. Open: http://localhost:3000/#/",
  });
  const named = all(db, "SELECT job_id, summary FROM events WHERE kind = 'notified' AND at = ? ORDER BY job_id", [sweep.created_at]);
  assert.deepEqual(named, [
    { job_id: 11, summary: "In your before-the-weekend text" },
    { job_id: 13, summary: "In your before-the-weekend text" },
    { job_id: 14, summary: "In your before-the-weekend text" },
  ]);
});

test("job 16's history reads as in §12.4 (GET /api/jobs/16)", async () => {
  const { db } = seeded();
  const { json } = await (await serve(db))("/api/jobs/16");
  const history = [...json.timeline].reverse();
  assert.deepEqual(history.map((t) => `${t.at_label} · ${t.summary}`), [
    "Fri 4:47pm · Voicemail came in",
    "Fri 5:20pm · Reminder texted to you",
    "Sat 7:00am · In your weekend text",
    "Sun 7:00am · In your weekend text",
    "Mon 7:00am · In your morning text",
  ]);
  assert.equal(history[0].body, "Hi, this is Marco at Bella Cucina on Halsted. Our walk-in freezer is at 28 degrees and climbing and we just got a full delivery. Please call me back as soon as you can.");
  assert.equal(history[0].channel, "call");
  assert.equal(history[0].actor, "customer");
  assert.deepEqual(history.slice(1).map((t) => [t.actor, t.kind, t.body]), Array(4).fill(["system", "notified", undefined]));
});

test("job 8's Sunday text is attached as an unread reply; job 9 is snoozed to Wednesday", () => {
  const { db } = seeded();
  const harbor = repo.getJobView(db, 8);
  assert.equal(harbor.stage, "scheduled");
  assert.equal(harbor.visit_date, "2026-10-06");
  assert.equal(harbor.unread_inbound_at, "2026-10-04T23:05:00.000Z");
  assert.equal(repo.messagesForJob(db, 8).length, 2);
  assert.equal(get(db, "SELECT summary FROM events WHERE job_id = 8 AND kind = 'inbound'").summary,
    "Texted: Can Mike come Wednesday instead of Tuesday? We're closed Tuesdays.");
  const maple = repo.getJobRow(db, 9);
  assert.equal(maple.stage, "to_schedule");
  assert.equal(maple.snoozed_until, "2026-10-07T05:00:00.000Z");
  assert.deepEqual(all(db, "SELECT summary FROM events WHERE job_id = 9 AND kind = 'outcome' ORDER BY id").map((r) => r.summary),
    ["Quote sent - $780", "Said yes - needs scheduling", "Snoozed until Wed"]);
  const prev = repo.parseEventRow(get(db, "SELECT * FROM events WHERE job_id = 9 AND summary = 'Snoozed until Wed'")).prev;
  assert.equal(prev.stage, "to_schedule");
  assert.equal(prev.snoozed_until, null);
});

test("R14 GET /api/numbers equals §10 at A", async () => {
  const { db } = seeded();
  const { json: n } = await (await serve(db))("/api/numbers");
  assert.equal(n.open_count, 13);
  assert.deepEqual(n.stage_counts, { new: 3, quote: 3, waiting_yes: 2, to_schedule: 2, scheduled: 3 });
  assert.equal(n.waiting_yes_total, 8400);
  assert.equal(n.waiting_yes_count, 2);
  assert.equal(n.won_30d_count, 7);
  assert.equal(n.won_30d_total, 4750);
  assert.equal(n.won_30d_no_amount, 2);
  assert.equal(n.done_7d_count, 1);
  assert.equal(n.lost_30d_count, 1);
  assert.equal(n.lost_30d_went_elsewhere, 1);
  assert.equal(n.new_7d_count, 12);
  assert.equal(n.leak_count, 2);
  assert.equal(n.leak_text, "Waiting over a day for a first call: 2");
  assert.equal(n.summary_text, [
    "Frostline Refrigeration numbers - Mon Oct 5",
    "Open jobs: 13 (New 3, Waiting on quote 3, Their yes 2, Said yes 2, Scheduled 3)",
    "Waiting on a yes: $8,400 (2 quotes)",
    "Won last 30 days: 7 jobs, $4,750",
    "Done last 7 days: 1",
    "Lost last 30 days: 1 (1 went with someone else)",
    "New last 7 days: 12",
  ].join("\n"));
});

test("the seed sets the demo clock to A and saves clock_offset_ms", () => {
  const { db } = seeded();
  assert.ok(Math.abs(clock.now().getTime() - Date.parse(A)) < 2000);
  assert.ok(clock.isShifted());
  const offset = repo.getSettings(db).clock_offset_ms;
  assert.ok(Math.abs(Date.now() + offset - Date.parse(A)) < 2000);
  assert.equal(repo.getSettings(db).auto_ack_enabled, false);
  assert.equal(get(db, "SELECT count(*) AS n FROM outbox WHERE kind = 'auto_ack'").n, 0);
});

test("the seed is relative to its anchor: another Monday gives the same list", async () => {
  const anchor = "2026-10-12T12:00:00.000Z"; // Mon Oct 12 07:00, no DST change in the replay
  const { db } = seeded(anchor);
  const { json: today } = await (await serve(db, () => anchor))("/api/today");
  assert.equal(today.date_label, "Monday, Oct 12");
  assert.deepEqual(cardRows(today), EXPECTED_ROWS);
  assert.equal(get(db, "SELECT count(*) AS n FROM outbox").n, 6);
});

test("defaultAnchor is the most recent Monday 07:00 at or before the real time", () => {
  const tz = "America/Chicago";
  assert.equal(defaultAnchor(tz), mostRecentMonday0700(new Date().toISOString(), tz));
});

test("CLI: node server/seed.js --reset wipes and reseeds; without --reset it refuses a seeded DB", () => {
  const dir = mkdtempSync(join(tmpdir(), "callback-seed-"));
  try {
    const env = { PATH: process.env.PATH, DB_PATH: join(dir, "demo.db"), AI_PARSING: "off" };
    const first = spawnSync(process.execPath, ["server/seed.js", "--reset"], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^Seeded the demo: 18 jobs, 6 texts in the outbox\. Demo clock: Mon [A-Z][a-z]{2} \d{1,2} 7:00am\.\n$/);
    const again = spawnSync(process.execPath, ["server/seed.js"], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already has jobs/);
    const reset = spawnSync(process.execPath, ["server/seed.js", "--reset"], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(reset.status, 0, reset.stderr);
    const db = openDb(env.DB_PATH);
    assert.equal(get(db, "SELECT count(*) AS n FROM jobs").n, 18);
    assert.equal(get(db, "SELECT max(id) AS n FROM jobs").n, 18);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
