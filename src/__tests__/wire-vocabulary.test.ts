import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, type Context, type Model, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache, staticModels } from "../catalog.js";
import { streamQoderRouter } from "../protocol/router.js";
import { clearQoderFallbackCache, clearQoderRoutingMemCache } from "../protocol/routing.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";

// SA rows 1/2/7/8/9 regression: the wire vocabulary the host contract promises.
// Everything enters through the registered streamSimple (streamQoderRouter) with
// options shaped exactly as pi builds them (agent.js:303-311 + sdk.js:178-196):
// reasoning absent when thinking is off, sessionId per session, thinkingBudgets
// from settings, onPayload chaining.

const SYSTEM_PROMPT = "You are a coding assistant.";

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

/** TranscriptContext as pi passes it: prompt + tools fold into a leading system message. */
function fixtureContext() {
  return normalizeContext({
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: "read a file" }],
    tools: [READ_TOOL],
  } as unknown as Context);
}

const context = fixtureContext();
const cachePath = () => join(process.env.HOME as string, ".pi", "agent", "qoder-models-cache.json");

function modelNamed(id: string): Model<Api> {
  const found = staticModels.find((model) => model.id === id);
  if (!found) throw new Error(`fixture model missing from static seed: ${id}`);
  return found as Model<Api>;
}

/** Seed the live-cache shape so a legacy key carries thinking_config.enabled.efforts. */
function seedCache(configs: Record<string, unknown>) {
  writeFileSync(cachePath(), JSON.stringify({ updatedAt: Date.now(), models: [], configs }), "utf8");
  clearQoderModelsMemCache();
}

function seedLegacyEffortKey() {
  seedCache({
    "DeepSeek-V4-Flash": {
      key: "dfmodel",
      enable: true,
      display_name: "DeepSeek-V4-Flash",
      is_reasoning: true,
      thinking_config: { enabled: { efforts: { low: {}, high: {}, max: {} } } },
    },
  });
}

function envelope(inner: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
}
const legacySuccess = `${envelope({ choices: [{ delta: { content: "OK" } }] })}data: [DONE]\n\n`;
const v2Success = [
  `data: ${JSON.stringify({ id: "x", model: "ultimate", choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
  `data: ${JSON.stringify({ id: "x", model: "ultimate", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
  "data: [DONE]",
].join("\n\n");

function v2FetchCapture() {
  const calls: { url: unknown; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("chat/completions")) {
      calls.push({ url: input, body: JSON.parse(String(init?.body)) });
      return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
    }
    calls.push({ url: input });
    return new Response(legacySuccess);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

beforeEach(() => {
  // Neutralize any developer-shell QODER_PROTOCOL so each describe gets the
  // transport the shipped table assigns its keys (v2 vs legacy-only); an
  // override here would reroute both describes and rewrite decision `source`.
  vi.stubEnv("QODER_PROTOCOL", "");
  cacheQoderIdentityForTest("qoder:fake", {
    access: "fake",
    refresh: "",
    expires: 0,
    userID: "user",
    name: "Test",
    email: "test@example.com",
    machineID: "machine",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected global fetch");
    }),
  );
});

afterEach(() => {
  clearQoderAuthMemCache();
  clearQoderFallbackCache();
  clearQoderRoutingMemCache();
  clearQoderFilterMemCache();
  clearQoderModelsMemCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function bodyOf(calls: { url: unknown; body?: Record<string, unknown> }[], index = 0): Record<string, unknown> {
  const body = calls[index]?.body;
  if (!body) throw new Error(`expected a captured request body at calls[${index}]`);
  return body;
}

describe("v2 wire vocabulary (SA rows 1, 8, 9, 10)", () => {
  it("keeps the transcript contract: exactly one system message, the tool set, the upstream key, and the provider.request debug line", async () => {
    vi.stubEnv("QODER_DEBUG", "1");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, fetch } = v2FetchCapture();
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-1",
      reasoning: "high",
    }).result();
    expect(result.stopReason).toBe("stop");

    const body = bodyOf(calls);
    const messages = body.messages as Array<{ role: string; content?: unknown }>;
    // pi-ai renders the prompt as the OpenAI "developer" role for reasoning
    // models and "system" otherwise — exactly one instruction message either way.
    const instruction = messages.filter((m) => m.role === "system" || m.role === "developer");
    expect(instruction).toHaveLength(1);
    expect(String(instruction[0]?.content)).toContain("coding assistant");
    expect(messages.at(-1)?.role).toBe("user");
    const tools = body.tools as Array<{ function: { name: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.function.name).toBe("read");
    expect(body.model).toBe("ultimate");
    expect(body.stream).toBe(true);
    const metadata = body.metadata as { context: { session_id?: string } };
    expect(metadata.context.session_id).toBe("session-1");

    const debugLines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(
      debugLines.some((line) => line.includes("provider.request model_key=ultimate protocol=v2 source=routing-data")),
    ).toBe(true);
  });

  it("maps a pi thinking level to enable_thinking + reasoning_effort + the default budget", async () => {
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      reasoning: "high",
    }).result();
    const body = bodyOf(calls);
    expect(body.enable_thinking).toBe(true);
    expect(body.reasoning_effort).toBe("high");
    // Default thinkingBudgets.high = 16384; ceiling = max_tokens (131072) - 1024.
    expect(body.reasoning_budget_tokens).toBe(16384);
  });

  it("clamps xhigh/max down to the highest supported level on the wire", async () => {
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      reasoning: "xhigh",
    }).result();
    expect(bodyOf(calls).reasoning_effort).toBe("high");
  });

  it("disables thinking explicitly when pi passes no reasoning field (level off)", async () => {
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch }).result();
    const body = bodyOf(calls);
    expect(body.enable_thinking).toBe(false);
    expect("reasoning_effort" in body).toBe(false);
    expect("reasoning_budget_tokens" in body).toBe(false);
  });

  it("disables thinking when the model cannot reason (level clamps to off)", async () => {
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Efficient"), context, {
      apiKey: "fake",
      fetch,
      reasoning: "high",
    }).result();
    const body = bodyOf(calls);
    expect(body.enable_thinking).toBe(false);
    expect("reasoning_effort" in body).toBe(false);
  });

  it("derives reasoning_budget_tokens from the host thinkingBudgets and clamps it to the answer room", async () => {
    const { calls, fetch } = v2FetchCapture();

    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      reasoning: "high",
      thinkingBudgets: { high: 4096 },
    } as SimpleStreamOptions).result();
    expect(bodyOf(calls, 0).reasoning_budget_tokens).toBe(4096);

    // max_tokens 2000 -> answer-room reserve leaves exactly 976 for thinking.
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      reasoning: "high",
      maxTokens: 2000,
    }).result();
    expect(bodyOf(calls, 1).reasoning_budget_tokens).toBe(976);

    // max_tokens 500 -> budget clamps to 0 and is omitted, never sent.
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      reasoning: "high",
      maxTokens: 500,
    }).result();
    expect("reasoning_budget_tokens" in bodyOf(calls, 2)).toBe(false);
  });
});

describe("legacy parameters vocabulary (SA rows 2, 8)", () => {
  /** The legacy body is signed after onPayload, so capture pre-signing. */
  async function runLegacy(options: SimpleStreamOptions) {
    seedLegacyEffortKey();
    let captured: Record<string, unknown> | undefined;
    const fetch = vi.fn(async () => new Response(legacySuccess)) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("DeepSeek-V4-Flash"), context, {
      ...options,
      onPayload: async (payload: unknown) => {
        captured = payload as Record<string, unknown>;
        return undefined;
      },
      fetch,
    }).result();
    expect(result.stopReason).toBe("stop");
    if (!captured) throw new Error("expected the legacy onPayload to receive the request body");
    return captured;
  }

  it("keeps the system prompt and tool set and sends enable_thinking + reasoning_effort for an effort-based key", async () => {
    const body = await runLegacy({ apiKey: "fake", reasoning: "high" });
    // The server ignores the top-level `system` field (pinned as "" in stream.ts),
    // so the prompt must ride as the leading role:system message instead.
    expect(body.system).toBe("");
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.role).toBe("system");
    expect(String(messages[0]?.content)).toContain("coding assistant");
    expect((body.tools as unknown[]).length).toBe(1);
    const parameters = body.parameters as Record<string, unknown>;
    expect(parameters.enable_thinking).toBe(true);
    expect(parameters.reasoning_effort).toBe("high");
    // OB-3 fallback: the legacy envelope never carries v2-only budget fields.
    expect("reasoning_budget_tokens" in parameters).toBe(false);
  });

  it("sends enable_thinking:false and no effort when thinking is off", async () => {
    const body = await runLegacy({ apiKey: "fake" });
    const parameters = body.parameters as Record<string, unknown>;
    expect(parameters.enable_thinking).toBe(false);
    expect("reasoning_effort" in parameters).toBe(false);
  });
});

describe("sampling filter (SA row 7)", () => {
  it("drops rejected keys configured at the model level", async () => {
    const { calls, fetch } = v2FetchCapture();
    const model = {
      ...modelNamed("Ultimate"),
      samplingParams: { presence_penalty: 0.5, frequency_penalty: 0.5, seed: 7, temperature: 0.7 },
    } as Model<Api>;
    await streamQoderRouter(model, context, { apiKey: "fake", fetch }).result();
    const body = bodyOf(calls);
    expect("presence_penalty" in body).toBe(false);
    expect("frequency_penalty" in body).toBe(false);
    expect("seed" in body).toBe(false);
    expect(body.temperature).toBe(0.7);
  });
});
