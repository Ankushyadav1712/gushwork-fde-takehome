// Browser test of the 3-minute demo (docs/DEMO.md) in headless Chrome at phone size (390x844).
// It boots its own server (DEMO=1, a temporary database, a free port or E2E_PORT, AI off), walks the
// script step by step and prints what passed. Any failed step, page error or failed request exits 1.
// Not part of `npm test`; run `npm run e2e`. CHROME_PATH overrides the Chrome binary.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_ENTRY = fileURLToPath(new URL("../server/index.js", import.meta.url));
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const BOOT_TIMEOUT_MS = 15_000;
const WAIT_MS = 5_000;

const DAVE_LINE = "Dave's Deli 312-555-0193 reach-in not cooling, wants someone today";
const BELLA_HISTORY = [
  "Mon 7:00am · In your morning text",
  "Sun 7:00am · In your weekend text",
  "Sat 7:00am · In your weekend text",
  "Fri 5:20pm · Reminder texted to you",
  "Fri 4:47pm · Voicemail came in",
];

// ---------------------------------------------------------------------------
// Server and browser

/** Starts the app on E2E_PORT or a free port, from an empty folder (so no .env is read). Resolves {url, log, stop}. */
function startServer(dir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: dir,
    env: { PATH: process.env.PATH, DEMO: "1", PORT: process.env.E2E_PORT || "0", DB_PATH: join(dir, "callback.db"), AI_PARSING: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const stop = () => new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`server didn't start:\n${log}`));
    }, BOOT_TIMEOUT_MS);
    const read = (chunk) => {
      log += chunk;
      const url = /Callback on (http:\/\/\S+)/.exec(log)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve({ url, log: () => log, stop });
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${log}`));
    });
  });
}

/** A phone-sized page that records tel:/sms: taps instead of following them, and collects problems. */
async function openPhone(browser, baseUrl) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  // The phone's dialer or messages app would take these over; headless Chrome would hang on them.
  await page.evaluateOnNewDocument(() => {
    window.__handoffs = [];
    document.addEventListener("click", (e) => {
      const link = e.target.closest?.("a[href^='tel:'], a[href^='sms:']");
      if (!link) return;
      e.preventDefault();
      window.__handoffs.push(link.getAttribute("href"));
    }, true);
  });
  const problems = [];
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("console", (msg) => { if (msg.type() === "error") problems.push(`console: ${msg.text()}`); });
  page.on("response", (res) => { if (res.status() >= 400) problems.push(`HTTP ${res.status()} ${res.url()}`); });
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()}`));
  await page.goto(`${baseUrl}/#/sim`, { waitUntil: "networkidle0" });
  return { page, problems };
}

// ---------------------------------------------------------------------------
// Page helpers (everything waits, so the run doesn't depend on timing)

const squash = (s) => s.replace(/\s+/g, " ").trim();

function helpers(page) {
  const waitFor = (fn, ...args) => page.waitForFunction(fn, { timeout: WAIT_MS }, ...args);

  /** Clicks the visible element under `selector` whose text is exactly `label`. */
  async function tap(selector, label) {
    const el = await waitFor((sel, want) => [...document.querySelectorAll(sel)]
      .find((e) => e.getClientRects().length && e.textContent.replace(/\s+/g, " ").trim() === want), selector, label)
      .catch(() => { throw new Error(`no "${label}" in ${selector}`); });
    await el.evaluate((e) => e.click());
  }

  const textsOf = (selector) => page.$$eval(selector, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));

  /** Waits until the toast reads `text`. */
  const toast = (text) => waitFor((want) => document.querySelector(".toast-text")?.textContent === want, text)
    .catch(async () => { throw new Error(`toast "${(await textsOf(".toast-text"))[0] ?? "none"}", wanted "${text}"`); });

  async function go(hash, readySelector) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await waitFor((sel) => document.querySelector(sel), readySelector);
  }

  /** Today's cards with their section headings, once the list has loaded. */
  async function todayCards() {
    await waitFor(() => document.querySelector(".card-list .card"));
    return page.$$eval(".today-section", (sections) => sections.flatMap((s) => [...s.querySelectorAll(".card")].map((c) => ({
      section: s.querySelector(".divider").textContent,
      title: c.querySelector(".card-title").textContent,
      badges: [...c.querySelectorAll(".badge")].map((b) => b.textContent),
      meta: c.querySelector(".card-meta")?.textContent ?? "",
      chip: c.querySelector(".chip")?.textContent ?? null,
      textLink: c.querySelector(".btn-text")?.getAttribute("href") ?? null,
    }))));
  }

  const openCard = (title) => tap(".card-body .card-title", title)
    .then(() => waitFor(() => document.querySelector(".sheet .sheet-title")));

  const handoffs = () => page.evaluate(() => window.__handoffs);

  return { waitFor, tap, textsOf, toast, go, todayCards, openCard, handoffs };
}

// ---------------------------------------------------------------------------
// The demo, step by step

function demoSteps(page, server) {
  const { waitFor, tap, textsOf, toast, go, todayCards, openCard, handoffs } = helpers(page);
  const header = async () => (await textsOf(".today-count"))[0];

  return [
    ["Startup line says rules-only AI and simulated texts", async () => {
      assert.match(server.log(), /AI: rules only .*\| SMS: simulated \(outbox\)/);
    }],

    ["Demo controls: Reset demo puts the clock back to Monday 7:00am", async () => {
      await tap(".sim button", "Reset demo");
      await tap(".sim button", "Yes, reset everything");
      await toast("Demo reset. Clock is back to Monday 7:00am.");
    }],

    ["Outbox: the Mon 7:00am text, and its link opens Today", async () => {
      await waitFor(() => document.querySelector(".outbox .bubble"));
      const [latest] = await textsOf(".outbox .bubble");
      assert.ok(latest.startsWith("Morning Denise - 10 to call today: 1. Bella Cucina - Walk-in freezer at 28 degrees and climbing (URGENT)"), latest);
      await page.$eval(".outbox .bubble a", (a) => a.click());
      await waitFor(() => document.querySelector(".today-count"));
    }],

    ["Today at the anchor: 10 cards, Bella Cucina first and URGENT", async () => {
      const cards = await todayCards();
      assert.equal(await header(), "10 people to call");
      assert.equal((await textsOf(".today-money"))[0], "$8,400 waiting on a yes");
      assert.equal(cards.length, 10);
      assert.deepEqual(
        { section: cards[0].section, title: cards[0].title, badges: cards[0].badges, chip: cards[0].chip },
        { section: "Urgent - call first (1)", title: "Bella Cucina", badges: ["URGENT"], chip: "Not contacted - 2d 14h" },
      );
    }],

    ["Bella Cucina's history: voicemail, reminder, weekend and morning texts", async () => {
      await openCard("Bella Cucina");
      assert.equal((await textsOf(".sheet .sheet-title"))[0], "How'd it go with Bella Cucina?");
      await tap(".sheet .quiet-link", "Open job");
      await waitFor(() => document.querySelector(".timeline .tl-line"));
      assert.deepEqual(await textsOf(".timeline .tl-line"), BELLA_HISTORY);
    }],

    ["Booked it -> Today -> Luis: toast with Undo, header drops to 9", async () => {
      await go("#/", ".card-list .card");
      await openCard("Bella Cucina");
      await tap(".sheet button", "Booked it");
      await tap(".sheet button", "Today");
      await tap(".sheet button", "Luis");
      await toast("Booked for today with Luis. I'll ask if it got done tomorrow.");
      assert.ok((await textsOf(".toast .toast-action")).includes("Undo"));
      await waitFor(() => document.querySelector(".today-count")?.textContent === "9 people to call")
        .catch(async () => assert.fail(`header reads "${await header()}"`));
    }],

    ["Rosa's Text opens a pre-written check-in from her own phone", async () => {
      const rosa = (await todayCards()).find((c) => c.title === "Rosa's Taqueria");
      assert.ok(rosa.textLink.startsWith("sms:+13125550118?&body=Hi%20Rosa"), rosa.textLink);
      await page.$$eval(".card", (cards) => cards.find((c) => c.querySelector(".card-title").textContent === "Rosa's Taqueria")
        .querySelector(".btn-text").click());
      assert.ok((await handoffs()).includes(rosa.textLink));
    }],

    ["Rosa texts \"yes go ahead\": Mark as yes? -> Thursday -> Mike", async () => {
      await go("#/sim", ".preset");
      await tap(".preset .preset-label", "Rosa texts \"yes go ahead\"");
      await toast("Added to their open job.");
      await go("#/", ".card-list .card");
      const rosa = (await todayCards()).find((c) => c.title === "Rosa's Taqueria");
      assert.equal(rosa.section, "They got back to you (2)");
      await openCard("Rosa's Taqueria");
      assert.equal((await textsOf(".sheet .stack .btn"))[0], "Mark as yes?");
      await tap(".sheet button", "Mark as yes?");
      assert.deepEqual(await textsOf(".sheet .choice.btn-primary"), ["Thursday asked"], "the day Rosa named is highlighted and tagged");
      await tap(".sheet button", "Thursday asked");
      await tap(".sheet button", "Mike");
      await toast("Booked for Thu with Mike. I'll ask if it got done Fri.");
    }],

    ["Web form: Tony's Bistro lands under Urgent; sending it again is a duplicate", async () => {
      await go("#/sim", ".preset");
      await tap(".preset .preset-label", "Web form: Tony's Bistro");
      await toast("Created a new job.");
      await tap(".preset .preset-label", "Web form: Tony's Bistro");
      await toast("Already had this one, so nothing new was added.");
      await go("#/", ".card-list .card");
      const tony = (await todayCards()).filter((c) => c.title === "Tony's Bistro");
      assert.equal(tony.length, 1);
      assert.equal(tony[0].section.startsWith("Urgent - call first"), true, tony[0].section);
      assert.ok(tony[0].meta.includes("Web form"), tony[0].meta);
    }],

    ["Quick Add: the Dave's Deli line fills in, then Add to my list", async () => {
      await tap(".bottom-nav a", "New");
      await page.waitForSelector("#quick-text", { timeout: WAIT_MS });
      await page.type("#quick-text", DAVE_LINE);
      await waitFor(() => document.querySelector(".read-badge")?.textContent === "Filled in for you - check it");
      const value = (id) => page.$eval(id, (e) => e.value);
      assert.deepEqual(
        { who: await value("#q-who"), phone: await value("#q-phone"), problem: await value("#q-problem") },
        { who: "Dave's Deli", phone: "(312) 555-0193", problem: "Reach-in not cooling, wants someone today" },
      );
      assert.deepEqual(await textsOf(".preview-card .tag"), ["Reach-in"]);
      assert.equal((await textsOf(".preview-card .toggle-chip"))[0], "URGENT");
      assert.ok((await textsOf(".center-link a"))[0].startsWith("Adding a bunch from your notebook?"));
      await tap("button", "Add to my list");
      await toast("Added. It's on your list.");
      const dave = (await todayCards()).find((c) => c.title === "Dave's Deli");
      assert.ok(dave?.section.startsWith("Urgent - call first"), JSON.stringify(dave));
    }],

    ["Jobs -> Numbers: 'Text this to Rick' carries the summary", async () => {
      await tap(".bottom-nav a", "Jobs");
      await waitFor(() => document.querySelector(".filter-chip"));
      await tap(".header-link", "Numbers");
      await waitFor(() => document.querySelector(".tiles .tile"));
      const rick = await page.$$eval("a.btn", (links) => links
        .filter((a) => a.textContent.trim() === "Text this to Rick").map((a) => a.getAttribute("href")));
      assert.equal(rick.length, 1);
      assert.ok(rick[0].startsWith("sms:+13125550108?&body=Frostline%20Refrigeration%20numbers"), rick[0]);
      await tap("a.btn", "Text this to Rick");
      assert.ok((await handoffs()).includes(rick[0]));
    }],
  ];
}

// ---------------------------------------------------------------------------

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "callback-e2e-"));
  let server;
  let browser;
  let failed = false;
  try {
    server = await startServer(dir);
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH, headless: true, userDataDir: join(dir, "chrome"), args: ["--no-first-run", "--disable-gpu"],
    });
    const { page, problems } = await openPhone(browser, server.url);
    for (const [name, run] of demoSteps(page, server)) {
      try {
        await run();
        console.log(`  ok    ${name}`);
      } catch (err) {
        failed = true;
        console.log(`  FAIL  ${name}\n        ${squash(err.message)}`);
        break;
      }
    }
    if (problems.length) {
      failed = true;
      console.log(`  FAIL  page errors or failed requests:\n        ${problems.join("\n        ")}`);
    }
  } catch (err) {
    failed = true;
    console.error(`e2e couldn't run: ${err.message}`);
  } finally {
    await browser?.close();
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? "e2e: FAILED" : "e2e: all demo steps passed");
  process.exitCode = failed ? 1 : 0;
}

await main();
