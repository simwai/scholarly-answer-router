/**
 * Router test suite. node:test with zero extra dependencies.
 *
 * Run:  npm test
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { ResponseCache } from "../src/cache.js";
import { TierChain } from "../src/chain.js";
import { scan } from "../src/egress.js";
import type { Provider, TierOutcome } from "../src/providers.js";
import {
  buildKiloRequest,
  buildNimRequest,
  nimCandidateFields,
  parseUnsupportedParameters,
  stripNimFields,
  stripReasoningContent,
} from "../src/reasoning.js";
import type { ChatMessage } from "../src/types.js";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "Hello" }];

function config(overrides: Record<string, unknown> = {}) {
  return { ...loadConfig({}), ...overrides } as ReturnType<typeof loadConfig>;
}

// ------------------------------------------------------------------ config

describe("config", () => {
  it("defaults to a chain whose tiers resolve on the live catalogs", () => {
    assert.deepEqual(loadConfig({}).pin, [
      "stepfun-ai/step-5-preview",
      "nvidia/nemotron-3.5-super-vl:free",
      "kilo-auto/free",
    ]);
  });

  it("parses ROUTER_PIN from the environment", () => {
    assert.deepEqual(loadConfig({ ROUTER_PIN: "a:free, b:free ,," }).pin, ["a:free", "b:free"]);
  });

  it("uses the documented Kilo base url and strips a trailing slash", () => {
    assert.equal(
      loadConfig({ KILO_BASE_URL: "https://ai-gateway.kilo.ai/api/v1/" }).kiloBaseUrl,
      "https://ai-gateway.kilo.ai/api/v1",
    );
  });

  it("keeps reasoning on by default", () => {
    assert.equal(loadConfig({}).reasoning, "high");
  });
});

// ---------------------------------------------------------------- reasoning

describe("Kilo reasoning adapter", () => {
  const base = {
    baseUrl: "https://ai-gateway.kilo.ai/api/v1",
    apiKey: "",
    model: "m",
    messages: MESSAGES,
    reasoning: "high",
  };

  it("sends reasoning:{effort} when the model advertises it", () => {
    const decision = { applied: false, mechanism: "none" as const };
    const request = buildKiloRequest({ ...base, supportedParameters: new Set(["reasoning", "temperature"]), decision });
    assert.deepEqual(request.body.reasoning, { effort: "high" });
    assert.equal(decision.applied, true);
    assert.equal(request.body.stream, false);
  });

  it("falls back to reasoning_effort when only that is advertised", () => {
    const decision = { applied: false, mechanism: "none" as const };
    const request = buildKiloRequest({ ...base, supportedParameters: new Set(["reasoning_effort"]), decision });
    assert.equal(request.body.reasoning_effort, "high");
    assert.equal(request.body.reasoning, undefined);
  });

  it("sends no reasoning field when the model advertises none, and says why", () => {
    const decision = { applied: false, mechanism: "none" as const };
    const request = buildKiloRequest({ ...base, supportedParameters: new Set(["temperature"]), decision });
    assert.equal(request.body.reasoning, undefined);
    assert.equal(request.body.reasoning_effort, undefined);
    assert.equal(decision.applied, false);
  });

  it("speculates a reasoning field when the catalog is unreachable", () => {
    const decision = { applied: false, mechanism: "none" as const };
    buildKiloRequest({ ...base, supportedParameters: null, decision });
    assert.equal(decision.applied, false);
  });

  it("adds Authorization only when a key exists", () => {
    const decision = { applied: false, mechanism: "none" as const };
    const withKey = buildKiloRequest({ ...base, apiKey: "k", supportedParameters: new Set(["reasoning"]), decision });
    const without = buildKiloRequest({ ...base, apiKey: "", supportedParameters: new Set(["reasoning"]), decision });
    assert.equal(withKey.headers.Authorization, "Bearer k");
    assert.equal(without.headers.Authorization, undefined);
  });
});

describe("NIM reasoning adapter", () => {
  const base = {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "nvapi-x",
    model: "stepfun-ai/step-5-preview",
    messages: MESSAGES,
    reasoning: "high",
    reasoningBudget: 16384,
  };

  it("always sets stream false, and sends the key", () => {
    const request = buildNimRequest(base);
    assert.equal(request.body.stream, false, "NIM defaults stream to true");
    assert.equal(request.headers.Authorization, "Bearer nvapi-x");
  });

  it("sends every candidate field for an unknown model, so the 400 fallback can learn", () => {
    const request = buildNimRequest(base);
    assert.equal(request.body.reasoning_effort, "high", "Step 5's knob");
    assert.equal(request.body.reasoning_budget, 16384, "Nemotron's knob");
    assert.deepEqual(request.body.chat_template_kwargs, { enable_thinking: true });
    assert.ok((request.body.max_tokens as number) >= 16384, "max_tokens needs headroom over the budget");
  });

  it("omits fields already known to be rejected, keeping the accepted one", () => {
    const request = buildNimRequest({
      ...base,
      rejectedFields: new Set(["reasoning_budget", "chat_template_kwargs"]),
    });
    assert.equal(request.body.reasoning_budget, undefined);
    assert.equal(request.body.chat_template_kwargs, undefined);
    assert.equal(request.body.reasoning_effort, "high", "the accepted field must survive");
  });

  it("keeps max_tokens headroom only while the budget is still sent", () => {
    assert.ok((buildNimRequest(base).body.max_tokens as number) >= 16384);
    assert.equal(
      buildNimRequest({ ...base, rejectedFields: new Set(["reasoning_budget"]) }).body.max_tokens,
      8192,
    );
  });

  it("respects a caller-supplied larger max_tokens", () => {
    assert.equal(buildNimRequest({ ...base, maxTokens: 20480 }).body.max_tokens, 20480);
  });
});

describe("NIM rejection parsing", () => {
  it("parses the fields named in NIM's 400 message", () => {
    assert.deepEqual(
      parseUnsupportedParameters('{"message":"Validation: Unsupported parameter(s): `reasoning_budget`"}'),
      ["reasoning_budget"],
    );
  });

  it("parses several fields at once", () => {
    assert.deepEqual(
      parseUnsupportedParameters("Unsupported parameter(s): `reasoning`, `reasoning_budget`"),
      ["reasoning", "reasoning_budget"],
    );
  });

  it("returns nothing for an unrelated error", () => {
    assert.deepEqual(parseUnsupportedParameters("Internal error"), []);
  });

  it("strips the named fields from a request body", () => {
    const body: Record<string, unknown> = { model: "m", reasoning_budget: 1, chat_template_kwargs: {}, keep: true };
    stripNimFields(body, ["reasoning_budget", "chat_template_kwargs"]);
    assert.deepEqual(body, { model: "m", keep: true });
  });
});
describe("reasoning stripping", () => {
  it("strips Kilo-style reasoning and reasoning_details", () => {
    const raw = {
      choices: [
        {
          message: {
            content: "answer",
            reasoning: "thinking",
            reasoning_details: [{ type: "reasoning.text", text: "more" }],
          },
        },
      ],
    };
    const result = stripReasoningContent(raw);
    assert.equal(result.content, "answer");
    assert.equal(result.hadReasoning, true);
  });

  it("strips NIM reasoning_content", () => {
    const raw = { choices: [{ message: { content: "answer", reasoning_content: "thinking" } }] };
    assert.equal(stripReasoningContent(raw).hadReasoning, true);
  });

  it("treats a content-free response as reasoning-only, not empty", () => {
    const result = stripReasoningContent({ choices: [{ message: { content: null, reasoning: "thinking" } }] });
    assert.equal(result.content, "");
    assert.equal(result.hadReasoning, true, "must distinguish reasoning-only from nothing");
  });

  it("reports no reasoning for a plain answer", () => {
    assert.equal(stripReasoningContent({ choices: [{ message: { content: "hi" } }] }).hadReasoning, false);
  });

  it("handles malformed payloads without throwing", () => {
    assert.deepEqual(stripReasoningContent(undefined), { content: "", hadReasoning: false });
    assert.deepEqual(stripReasoningContent(null), { content: "", hadReasoning: false });
  });
});

// ------------------------------------------------------------------- cache

describe("response cache", () => {
  const cache = new ResponseCache(600_000, true);
  const parts = {
    model: "stepfun-ai/step-5-preview",
    messages: MESSAGES,
    promptVersion: "v1",
    sourcesDigest: "digest-a",
  };

  it("produces a stable key for identical input", () => {
    assert.equal(cache.buildKey(parts), cache.buildKey({ ...parts }));
  });

  it("changes key when the grounding digest changes", () => {
    assert.notEqual(cache.buildKey(parts), cache.buildKey({ ...parts, sourcesDigest: "digest-b" }));
  });

  it("changes key when the model changes", () => {
    assert.notEqual(cache.buildKey(parts), cache.buildKey({ ...parts, model: "other" }));
  });

  it("stores and retrieves a payload, reporting a hit", () => {
    cache.put("k", { answer: "x" });
    assert.deepEqual(cache.get("k")?.payload, { answer: "x" });
    assert.equal(cache.stats().hits, 1);
  });

  it("expires entries past the TTL", async () => {
    const short = new ResponseCache(1, true);
    short.put("k", { a: 1 });
    assert.ok(short.get("k"), "fresh entry must be readable");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(short.get("k"), null, "entry must expire once the TTL elapses");
  });

  it("never hits when disabled", () => {
    const disabled = new ResponseCache(600_000, false);
    disabled.put("k", { a: 1 });
    assert.equal(disabled.get("k"), null);
  });
});

// ---------------------------------------------------------------- egress

describe("egress guardrail", () => {
  it("allows ordinary text", () => {
    assert.equal(scan("a normal literature question").action, "allow");
  });

  it("detects and redacts an NVIDIA key", () => {
    const result = scan("here is nvapi-abcdefghijklmnopqrstuvwxyz012345");
    assert.equal(result.action, "redact");
    assert.ok(result.findings.includes("NVIDIA NIM key"));
    assert.ok(!/nvapi-abc/.test(result.redacted ?? ""));
  });

  it("detects proxy credentials embedded in a URL", () => {
    assert.ok(scan("proxy https://user:secret123@proxy.example.com:8080").findings.includes("proxy credentials"));
  });

  it("detects private key blocks and OpenAI-style keys", () => {
    assert.ok(scan("-----BEGIN PRIVATE KEY-----").findings.length > 0);
    assert.ok(scan(`sk-${"a".repeat(40)}`).findings.includes("openai-style key"));
  });
});

// ------------------------------------------------------------------ chain

const OK = (content: string, modelUsed = "x"): TierOutcome => ({
  ok: true,
  content,
  modelUsed,
  upstreamSeconds: 0,
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const FAIL = (errorType: "config_error" | "upstream_rate_limited" | "upstream_timeout", error = "failed"): TierOutcome => ({
  ok: false,
  error,
  errorType,
});

interface FakeProvider extends Provider {
  calls: Array<[string, ChatMessage[]]>;
}

function fakeProvider(owns: string[], outcomes: Record<string, unknown>): FakeProvider {
  const calls: Array<[string, ChatMessage[]]> = [];
  return {
    kind: "kilo",
    owns: (modelId: string) => owns.includes(modelId),
    supportedParameters: async () => null,
    calls,
    call: async (modelId: string, messages: ChatMessage[]): Promise<TierOutcome> => {
      calls.push([modelId, messages]);
      const outcome = outcomes[modelId];
      // Real providers report the upstream model name, which for a pinned tier
      // is the requested ID.
      if (typeof outcome === "string") return OK(outcome, modelId);
      if (outcome && typeof outcome === "object" && "ok" in outcome) return outcome as TierOutcome;
      return FAIL("config_error", `unknown model ${modelId}`);
    },
  };
}

describe("tier chain", () => {
  it("returns the first working tier and marks it primary", async () => {
    const provider = fakeProvider(["a", "b"], { a: "answer-a" });
    const chain = new TierChain(config({ pin: ["a", "b"] }), [provider]);
    const result = await chain.run(MESSAGES);
    assert.equal(result.content, "answer-a");
    assert.equal(result.fromFallback, false);
    assert.deepEqual(result.tiersAttempted, ["a"]);
  });

  it("advances to the next tier on failure and reports it as a fallback", async () => {
    const provider = fakeProvider(["a", "b"], { a: FAIL("upstream_rate_limited"), b: "answer-b" });
    const chain = new TierChain(config({ pin: ["a", "b"] }), [provider]);
    const result = await chain.run(MESSAGES);
    assert.equal(result.content, "answer-b");
    assert.equal(result.fromFallback, true);
    assert.deepEqual(result.tiersAttempted, ["a", "b"]);
  });

  it("never attempts the same tier twice in one request", async () => {
    const provider = fakeProvider(["kilo-auto/free"], { "kilo-auto/free": "answer" });
    const chain = new TierChain(config({ pin: ["kilo-auto/free"], lastResort: "kilo-auto/free" }), [provider]);
    const result = await chain.run(MESSAGES);
    assert.equal(result.fromFallback, false, "an identical tier list is not a fallback");
    assert.equal(provider.calls.length, 1);
  });

  it("does not substitute when allow_fallback is false", async () => {
    const provider = fakeProvider(["a", "b"], { a: FAIL("upstream_timeout"), b: "answer-b" });
    const chain = new TierChain(config({ pin: ["a", "b"], allowFallback: false }), [provider]);
    await assert.rejects(() => chain.run(MESSAGES), /no tier produced a completion/);
    assert.equal(provider.calls.length, 1, "b must not be attempted");
  });

  it("throws with the tiers it attempted when every tier fails", async () => {
    const provider = fakeProvider(["a"], { a: FAIL("upstream_timeout", "boom") });
    const chain = new TierChain(config({ pin: ["a"], lastResort: "missing" }), [provider]);
    await assert.rejects(
      () => chain.run(MESSAGES),
      (err: Error & { tiersAttempted?: string[] }) => {
        assert.match(err.message, /boom/);
        assert.deepEqual(err.tiersAttempted, ["a"]);
        return true;
      },
    );
  });

  it("classifies a lone config error as config_error with a 400 status", async () => {
    const provider = fakeProvider(["a"], { a: FAIL("config_error", "needs key") });
    const chain = new TierChain(config({ pin: ["a"], lastResort: "a" }), [provider]);
    await assert.rejects(
      () => chain.run(MESSAGES),
      (err: Error & { type?: string; status?: number }) => {
        assert.equal(err.type, "config_error");
        assert.equal(err.status, 400);
        return true;
      },
    );
  });

  it("opens a circuit on repeated transient failures but never on config errors", async () => {
    const flaky = new TierChain(config({ pin: ["a"], lastResort: "a" }), [fakeProvider(["a"], { a: FAIL("upstream_timeout") })]);
    const broken = new TierChain(config({ pin: ["b"], lastResort: "b" }), [fakeProvider(["b"], { b: FAIL("config_error", "bad id") })]);
    for (let i = 0; i < 3; i += 1) {
      await flaky.run(MESSAGES).catch(() => undefined);
      await broken.run(MESSAGES).catch(() => undefined);
    }
    assert.equal(flaky.isOpen("a"), true, "three transient failures open the breaker");
    assert.equal(broken.isOpen("b"), false, "config errors must never open the breaker");
  });

  it("records consecutive failures and reports the breaker in the snapshot", async () => {
    const chain = new TierChain(config({ pin: ["a"], lastResort: "a" }), [fakeProvider(["a"], { a: FAIL("upstream_timeout") })]);
    for (let i = 0; i < 3; i += 1) await chain.run(MESSAGES).catch(() => undefined);
    const snapshot = chain.breakerSnapshot() as Record<string, { open: boolean; consecutive_failures: number } | undefined>;
    assert.equal(snapshot.a?.open, true);
    assert.equal(snapshot.a?.consecutive_failures, 3);
  });

  it("clears the breaker for the tier that answers, leaving failed tiers open", async () => {
    const provider = fakeProvider(["a", "b"], { a: FAIL("upstream_timeout"), b: "ok" });
    const chain = new TierChain(config({ pin: ["a", "b"] }), [provider]);
    for (let i = 0; i < 3; i += 1) await chain.run(MESSAGES).catch(() => undefined);
    assert.equal((await chain.run(MESSAGES)).content, "ok");
    // b answered, so b is healthy; a never recovered, so its breaker stays open
    // until the cooldown half-opens it.
    assert.equal(chain.isOpen("b"), false);
    assert.equal(chain.isOpen("a"), true);
  });

  it("refuses to start with a tier nobody owns", () => {
    const chain = new TierChain(config({ pin: ["not-a-real/model"], lastResort: "also/not-real" }), []);
    assert.equal(chain.validateTiers().length, 2);
  });
});

// ------------------------------------------------------------------ server

async function getJson(response: Response): Promise<any> {
  return (await response.json()) as any;
}

describe("http surface", () => {
  let url: string;
  let shutdown: () => void;

  before(async () => {
    const { createRouter } = await import("../src/server.js");
    const router = createRouter(config({ pin: ["a"], lastResort: "a", cacheEnabled: false }), [
      fakeProvider(["a"], { a: "hello" }),
    ]);
    await new Promise<void>((resolve) => router.server.listen(0, "127.0.0.1", resolve));
    const address = router.server.address();
    if (typeof address !== "object" || address === null) throw new Error("server did not bind");
    url = `http://127.0.0.1:${address.port}`;
    shutdown = () => router.server.close();
  });

  after(() => shutdown());

  it("reports health with the configured tiers", async () => {
    const response = await fetch(`${url}/healthz`);
    const body = await getJson(response);
    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.deepEqual(body.tiers, ["a"]);
  });

  it("rejects streaming with a clear 400", async () => {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "a", messages: MESSAGES, stream: true }),
    });
    const body = await getJson(response);
    assert.equal(response.status, 400);
    assert.equal(body.error.type, "invalid_request");
    assert.equal(body.error.param, "stream");
  });

  it("rejects a missing messages array", async () => {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "a" }),
    });
    const body = await getJson(response);
    assert.equal(response.status, 400);
    assert.equal(body.error.param, "messages");
  });

  it("rejects a non-JSON body", async () => {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(response.status, 400);
  });

  it("completes a request and returns provenance in the body", async () => {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "a", messages: MESSAGES }),
    });
    const body = await getJson(response);
    assert.equal(response.status, 200);
    assert.equal(body.choices[0].message.content, "hello");
    assert.equal(body.router.model_used, "a");
    assert.equal(body.router.from_fallback, false);
    assert.deepEqual(body.router.tiers_attempted, ["a"]);
    assert.ok(String(body.router.request_id).startsWith("req_"));
    assert.equal(body.router.cached, false);
  });

  it("serves an identical repeat from cache and reports it", async () => {
    const { createRouter } = await import("../src/server.js");
    const router = createRouter(config({ pin: ["a"], lastResort: "a", cacheEnabled: true }), [
      fakeProvider(["a"], { a: "hello" }),
    ]);
    await new Promise<void>((resolve) => router.server.listen(0, "127.0.0.1", resolve));
    const address = router.server.address();
    if (typeof address !== "object" || address === null) throw new Error("server did not bind");
    const local = `http://127.0.0.1:${address.port}`;
    try {
      const payload = JSON.stringify({ model: "a", messages: MESSAGES, sources_digest: "d1" });
      for (let i = 0; i < 2; i += 1) {
        await fetch(`${local}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
      }
      const second = await fetch(`${local}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      const body = await getJson(second);
      assert.equal(body.router.cached, true);
      assert.ok(body.router.cache_age_seconds >= 0);
      assert.equal(body.choices[0].message.content, "hello");
    } finally {
      router.server.close();
    }
  });

  it("returns 404 for an unknown route", async () => {
    const response = await fetch(`${url}/nope`);
    assert.equal(response.status, 404);
  });
});
