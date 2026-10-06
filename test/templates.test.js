import { test } from "node:test";
import assert from "node:assert/strict";
import { smsDraft, techText, smsLink, telLink } from "../shared/templates.js";
import { SEED_ANCHOR as A, SETTINGS, at, ctxAt, makeJobView, seedJobViews } from "./fixtures/seed-state.js";

const ctx = ctxAt(A); // Mon Oct 5 2026 07:00
const seed = (id) => seedJobViews().find((j) => j.id === id);

test("smsLink and telLink", () => {
  assert.equal(smsLink("+13125550118", "Hi Rosa, it's Denise & co? 100%"),
    "sms:+13125550118?&body=Hi%20Rosa%2C%20it's%20Denise%20%26%20co%3F%20100%25");
  assert.equal(smsLink("+13125550118", "a\nb"), "sms:+13125550118?&body=a%0Ab");
  assert.equal(smsLink(null, "Hi"), null);
  assert.equal(telLink("+13125550142"), "tel:+13125550142");
  assert.equal(telLink(null), null);
});

test("smsDraft: one fixed template per situation (§13.3)", () => {
  assert.equal(smsDraft(seed(16), "emergency", ctx),
    "Hi Marco, it's Denise at Frostline Refrigeration. Got your message about the walk-in freezer. Is now a good time to call?");
  assert.equal(smsDraft({ ...seed(16), attempts: 1 }, "emergency", ctx),
    "Hi Marco, it's Denise at Frostline Refrigeration - tried calling about the walk-in freezer. Call or text me back at this number when you can.");
  assert.equal(smsDraft(seed(17), "new", ctx),
    "Hi, it's Denise at Frostline Refrigeration. Got your message about the service request. Is now a good time to call?");
  assert.equal(smsDraft(seed(8), "replied", ctx),
    "Hi Ana, thanks for your message - I'll get back to you shortly. - Denise");
  assert.equal(smsDraft(seed(11), "quote", ctx),
    "Hi Gus, it's Denise at Frostline Refrigeration. I'm working on your quote for the walk-in freezer - you'll have it shortly.");
  assert.equal(smsDraft(seed(7), "nudge", ctx),
    "Hi Rosa, it's Denise at Frostline Refrigeration. Just checking on the quote for the walk-in cooler ($2,400) - want us to get it on the schedule?");
  assert.equal(smsDraft({ ...seed(7), quote_amount: null }, "nudge", ctx),
    "Hi Rosa, it's Denise at Frostline Refrigeration. Just checking on the quote for the walk-in cooler - want us to get it on the schedule?");
  assert.equal(smsDraft(seed(13), "to_schedule", ctx),
    "Hi Joe, it's Denise at Frostline Refrigeration. Thanks for the go-ahead on the walk-in cooler - what day works best for us to come out?");
  assert.equal(smsDraft(seed(10), "check_done", ctx),
    "Hi Sal, it's Denise at Frostline Refrigeration. Just making sure everything's working right with the prep table after Luis's visit.");
  assert.equal(smsDraft({ ...seed(10), tech: null }, "check_done", ctx),
    "Hi Sal, it's Denise at Frostline Refrigeration. Just making sure everything's working right with the prep table after our visit.");
  // An urgent quote card still gets the quote draft.
  assert.equal(smsDraft({ ...seed(11), urgent: 1 }, "emergency", ctx),
    "Hi Gus, it's Denise at Frostline Refrigeration. I'm working on your quote for the walk-in freezer - you'll have it shortly.");
});

test("smsDraft without a bucket follows the stage (Job detail)", () => {
  assert.equal(smsDraft(seed(12), null, ctx),
    "Hi Kevin, it's Denise at Frostline Refrigeration. Confirming Dee for today for the ice machine.");
  assert.equal(smsDraft({ ...seed(12), tech: null, visit_date: "2026-10-06" }, null, ctx),
    "Hi Kevin, it's Denise at Frostline Refrigeration. Confirming our tech for tomorrow for the ice machine.");
  assert.equal(smsDraft(seed(10), null, ctx),
    "Hi Sal, it's Denise at Frostline Refrigeration. Just making sure everything's working right with the prep table after Luis's visit.");
  assert.equal(smsDraft(seed(5), null, ctx),
    "Hi Tom, it's Denise at Frostline Refrigeration. Just checking on the quote for the walk-in freezer ($6,000) - want us to get it on the schedule?");
  assert.equal(smsDraft(seed(9), null, ctx),
    "Hi Linda, it's Denise at Frostline Refrigeration. Thanks for the go-ahead on the reach-in - what day works best for us to come out?");
  assert.equal(smsDraft(seed(4), null, ctx), "Hi Min-jun, it's Denise at Frostline Refrigeration.");
  assert.equal(smsDraft(makeJobView({ equipment: "other" }), "new", ctx),
    "Hi Pat, it's Denise at Frostline Refrigeration. Got your message about the service request. Is now a good time to call?");
});

test("smsDraft uses the owner and company from settings", () => {
  const custom = ctxAt(A, { settings: { ...SETTINGS, owner_name: "Dee", company_name: "Cold Co" } });
  assert.equal(smsDraft(seed(8), "replied", custom), "Hi Ana, thanks for your message - I'll get back to you shortly. - Dee");
  assert.equal(smsDraft(seed(14), "quote", custom),
    "Hi Dave, it's Dee at Cold Co. I'm working on your quote for the ice machine - you'll have it shortly.");
});

test("techText: what a tech needs, signed by Denise (§9)", () => {
  assert.equal(techText(seed(16), ctx),
    "Bella Cucina - 1820 N Halsted St\nWalk-in freezer at 28 degrees and climbing\nContact: Marco Rossi (312) 555-0142\n- Denise");
  assert.equal(techText(seed(11), ctx),
    "Midway Meats - no address\nFreezer door gasket and heater wire\nContact: Gus Petrakis (312) 555-0174\n- Denise");
  assert.equal(techText(seed(17), ctx),
    "(312) 555-0177 - no address\nno details\nContact: (312) 555-0177\n- Denise");
});

test("Today cards carry the drafted text in their sms: link", () => {
  const view = seedJobViews(at("2026-10-05 07:00")).find((j) => j.id === 7);
  assert.ok(view);
  assert.equal(
    smsLink(view.customer.phone, smsDraft(view, "nudge", ctx)),
    `sms:+13125550118?&body=${encodeURIComponent("Hi Rosa, it's Denise at Frostline Refrigeration. Just checking on the quote for the walk-in cooler ($2,400) - want us to get it on the schedule?")}`,
  );
});
