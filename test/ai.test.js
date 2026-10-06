// Exercises the Claude extraction path offline with a stubbed fetch: request shape,
// structured-output parsing, normalization, and graceful fallback on refusal / errors.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { extractWithAI, setAIClientForTests, aiEnabled, AI_MODEL } from "../server/ai.js";

const savedEnv = { ...process.env };
beforeEach(() => { process.env.AI_PARSING = "on"; });
afterEach(() => { process.env = { ...savedEnv }; setAIClientForTests(null); });

function stubClient(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const { status = 200, json } = respond(calls.length);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
  };
  return { client: new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 }), calls };
}

function message(content, stop_reason = "end_turn") {
  return {
    id: "msg_test", type: "message", role: "assistant", model: AI_MODEL,
    content: content === null ? [] : [{ type: "text", text: JSON.stringify(content) }],
    stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  };
}

test("sends a structured-output request and normalizes the parsed result", async () => {
  const { client, calls } = stubClient(() => ({
    json: message({
      contact_name: "Tony", business_name: "Tony's Trattoria", phone: "(312) 555-0187", email: null, address: null,
      equipment: "Walk-in freezer", summary: "Walk-in freezer down", details: "Reading 40F, losing product",
      urgency: "EMERGENCY", urgency_reason: "freezer down", is_service_request: true,
    }),
  }));
  setAIClientForTests(client);

  const out = await extractWithAI("hey its tony at tonys trattoria, walk in freezer is at 40 and climbing. call me 312-555-0187", { channel: "sms", from: "+13125550187" });

  assert.equal(calls.length, 1);
  const { url, headers, body } = calls[0];
  assert.match(url, /\/v1\/messages/);
  assert.match(headers.get("anthropic-beta") || "", /server-side-fallback-2026-07-01/);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.fallbacks, "default");
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.ok(body.output_config.format.schema.properties.urgency);
  assert.equal(body.betas, undefined, "betas must travel as a header, not in the body");
  assert.match(body.messages[0].content, /<message>[\s\S]*tonys trattoria[\s\S]*<\/message>/);

  assert.equal(out.parsed_by, "ai");
  assert.equal(out.equipment, "walk_in_freezer");
  assert.equal(out.urgency, "emergency");
  assert.equal(out.business_name, "Tony's Trattoria");
  assert.equal(out.email, null);
});

test("returns null on refusal so the caller uses the rule-based parser", async () => {
  const { client } = stubClient(() => ({ json: message(null, "refusal") }));
  setAIClientForTests(client);
  assert.equal(await extractWithAI("anything"), null);
});

test("returns null on API errors instead of throwing", async () => {
  const { client } = stubClient(() => ({ status: 500, json: { type: "error", error: { type: "api_error", message: "boom" } } }));
  setAIClientForTests(client);
  assert.equal(await extractWithAI("freezer down"), null);
});

test("is disabled without credentials and makes no request", async () => {
  delete process.env.AI_PARSING;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const { client, calls } = stubClient(() => ({ json: message({}) }));
  setAIClientForTests(client);
  assert.equal(aiEnabled(), false);
  assert.equal(await extractWithAI("freezer down"), null);
  assert.equal(calls.length, 0);
});
