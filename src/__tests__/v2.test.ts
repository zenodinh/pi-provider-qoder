import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache, staticModels } from "../catalog.js";
import { streamQoderRouter } from "../protocol/router.js";
import { clearQoderFallbackCache, clearQoderRoutingMemCache, isMarkedLegacyOnly } from "../protocol/routing.js";
import { clearQoderRunRegistry } from "../protocol/run-identity.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";
import { streamQoderV2 } from "../protocol/v2.js";
import { readDebugRecords } from "./debug-sink.js";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
// A completed tool round in the raw pi shape, so the run continuation predicate
// has the same view the legacy transport feeds it.
const completedAssistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/tmp/x" } }],
  api: "openai-completions" as Api,
  provider: "qoder" as AssistantMessage["provider"],
  model: "ultimate",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 0,
};
const toolRoundContext = normalizeContext({
  messages: [
    { role: "user", content: "hi", timestamp: 0 },
    completedAssistant,
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read_file",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 0,
    },
  ],
} as unknown as Context);

/** True when `key` appears at any depth of the captured JSON body. */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, key));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([name, child]) => name === key || hasKeyDeep(child, key),
  );
}
// v2.ts maps the host platform the way osType() does; CI runs linux, so derive it.
const expectedOsType = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const cachePath = () => join(process.env.HOME as string, ".pi", "agent", "qoder-models-cache.json");

function modelNamed(id: string): Model<Api> {
  const found = staticModels.find((model) => model.id === id);
  if (!found) throw new Error(`fixture model missing from static seed: ${id}`);
  return found as Model<Api>;
}

function seedCatalogWithTiers() {
  writeFileSync(
    cachePath(),
    JSON.stringify({
      updatedAt: Date.now(),
      models: [],
      configs: {
        Ultimate: {
          key: "ultimate",
          enable: true,
          display_name: "Ultimate",
          context_config: {
            "200K": { token_count: 200_000, is_default: true },
            "400K": { token_count: 400_000 },
            "1M": { token_count: 1_000_000 },
          },
        },
      },
    }),
    "utf8",
  );
  clearQoderModelsMemCache();
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
  const calls: { url: unknown; body?: Record<string, unknown>; headers?: HeadersInit }[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("chat/completions")) {
      calls.push({ url: input, body: JSON.parse(String(init?.body)), headers: init?.headers });
      return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
    }
    calls.push({ url: input });
    return new Response(legacySuccess);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

beforeEach(() => {
  // Neutralize any developer-shell QODER_PROTOCOL so routing follows the shipped
  // table (v2 for allowlisted keys); an override here would also rewrite the
  // decision `source` these assertions pin (hermeticity).
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
  clearQoderRunRegistry();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function bodyOf(calls: { url: unknown; body?: Record<string, unknown> }[], index = 0): Record<string, unknown> {
  const body = calls[index]?.body;
  if (!body) throw new Error(`expected a captured request body at calls[${index}]`);
  return body;
}

describe("v2 field injector", () => {
  it("injects metadata.context and the explicit-send set on every v2 request", async () => {
    seedCatalogWithTiers();
    const { calls, fetch } = v2FetchCapture();
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-1",
      reasoning: "high",
    }).result();
    expect(result.stopReason).toBe("stop");
    const body = bodyOf(calls);
    const metadata = body.metadata as { context: Record<string, unknown> };
    expect(metadata.context.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.context.session_id).toBe("session-1");
    expect(metadata.context.os_type).toBe(expectedOsType);
    expect(metadata.context.task_id).toBe("common");
    expect(metadata.context.client_type).toBe("5");
    expect(metadata.context.request_set_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.context.source_session_id).toBe("session-1");
    expect(metadata.context.context_length).toBe("1000000");
    expect(body.enable_thinking).toBe(true);
    expect(body.context_length).toBe(1_000_000);
    expect(body.preserve_thinking).toBe(true);
    expect(body.parallel_tool_calls).toBe(true);
    expect("skipCacheWrite" in body).toBe(false);
  });

  it("rotates request_set_id per user submit and stays distinct across sessions (OD-5, spec T-11/AC-03)", async () => {
    seedCatalogWithTiers();
    const a = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch: a.fetch,
      sessionId: "session-a",
    }).result();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch: a.fetch,
      sessionId: "session-a",
    }).result();
    const b = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch: b.fetch,
      sessionId: "session-b",
    }).result();
    const metaAt = (calls: { url: unknown; body?: Record<string, unknown> }[], i: number) =>
      bodyOf(calls, i).metadata as { context: Record<string, unknown> };
    // OD-5, owner-signed: two submits in one session are two runs now, not one.
    expect(metaAt(a.calls, 1).context.request_set_id).not.toBe(metaAt(a.calls, 0).context.request_set_id);
    expect(metaAt(b.calls, 0).context.request_set_id).not.toBe(metaAt(a.calls, 0).context.request_set_id);
  });

  it("matches the run identity across a tool round between two user submits (T-11/AC-03)", async () => {
    seedCatalogWithTiers();
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-run",
    }).result();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-run",
    }).result();
    await streamQoderRouter(modelNamed("Ultimate"), toolRoundContext, {
      apiKey: "fake",
      fetch,
      sessionId: "session-run",
    }).result();
    const metaAt = (i: number) => bodyOf(calls, i).metadata as { context: Record<string, unknown> };
    expect(metaAt(1).context.request_set_id).not.toBe(metaAt(0).context.request_set_id);
    expect(metaAt(2).context.request_set_id).toBe(metaAt(1).context.request_set_id);
  });

  it("changes only the rotation rule: the v2 body carries no business key at any level (T-12/AC-08)", async () => {
    seedCatalogWithTiers();
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-business",
    }).result();
    const body = bodyOf(calls);
    expect(hasKeyDeep(body, "business"), "no business object reaches a v2 request").toBe(false);
    const metadata = body.metadata as { context: Record<string, unknown> };
    expect(metadata.context.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.context.request_set_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.context.session_id).toBe("session-business");
    expect(metadata.context.source_session_id).toBe("session-business");
    expect(metadata.context.os_type).toBe(expectedOsType);
    expect(metadata.context.task_id).toBe("common");
    expect(metadata.context.client_type).toBe("5");
    expect(typeof metadata.context.context_length).toBe("string");
  });

  it("leaves the v2 run slot untouched on a warm replay (T-13/AC-02)", async () => {
    seedCatalogWithTiers();
    const { calls, fetch } = v2FetchCapture();
    const dispatch = (ctx: typeof context, options: Record<string, unknown> = {}) =>
      streamQoderRouter(modelNamed("Ultimate"), ctx, {
        apiKey: "fake",
        fetch,
        sessionId: "session-warm",
        ...options,
      } as SimpleStreamOptions).result();

    await dispatch(context); // a real user submit establishes the slot
    await dispatch(context, { maxTokens: 1 }); // the host cache warmer replays it
    await dispatch(toolRoundContext); // the next real tool round continues

    const metaAt = (i: number) => bodyOf(calls, i).metadata as { context: Record<string, unknown> };
    expect(metaAt(1).context.request_set_id, "the warm replay reuses the slot").toBe(metaAt(0).context.request_set_id);
    expect(metaAt(2).context.request_set_id, "the real round continues the pre-warm identity").toBe(
      metaAt(0).context.request_set_id,
    );
  });

  it("honors a models.json contextWindow override for context_length", async () => {
    seedCatalogWithTiers();
    const overridden = { ...modelNamed("Ultimate"), contextWindow: 400000 } as Model<Api>;
    const a = v2FetchCapture();
    await streamQoderRouter(overridden, context, { apiKey: "fake", fetch: a.fetch, sessionId: "session-a" }).result();
    const meta = bodyOf(a.calls, 0).metadata as { context: Record<string, unknown> };
    expect(bodyOf(a.calls, 0).context_length).toBe(400000);
    expect(meta.context.context_length).toBe("400000");
    const mismatched = { ...modelNamed("Ultimate"), contextWindow: 123456 } as Model<Api>;
    const b = v2FetchCapture();
    await streamQoderRouter(mismatched, context, { apiKey: "fake", fetch: b.fetch, sessionId: "session-b" }).result();
    expect(bodyOf(b.calls, 0).context_length).toBe(200000);
  });

  it("sends enable_thinking:false when the level is unset or clamps to off", async () => {
    const { calls, fetch } = v2FetchCapture();
    // Efficient is reasoning:false in the static seed, so "high" clamps to off.
    await streamQoderRouter(modelNamed("Efficient"), context, { apiKey: "fake", fetch, reasoning: "high" }).result();
    expect(bodyOf(calls).enable_thinking).toBe(false);
    calls.length = 0;
    await streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch }).result();
    expect(bodyOf(calls).enable_thinking).toBe(false);
  });

  it("sets skipCacheWrite only when cacheRetention is none", async () => {
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      cacheRetention: "none",
    } as SimpleStreamOptions).result();
    expect(bodyOf(calls).skipCacheWrite).toBe(true);
  });

  it("sends the session-derived prompt_cache_key and affinity headers", async () => {
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-1",
    }).result();
    expect(bodyOf(calls).prompt_cache_key).toBe("session-1");
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get("session_id")).toBe("session-1");
    expect(headers.get("x-client-request-id")).toBe("session-1");
    expect(headers.get("x-session-affinity")).toBe("session-1");
  });

  it("bounds prompt_cache_key to the upstream 64-character limit", async () => {
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: `session-${"x".repeat(80)}`,
    }).result();
    const key = String(bodyOf(calls).prompt_cache_key);
    expect(key).toHaveLength(64);
    expect(key.startsWith("session-")).toBe(true);
  });

  it("omits prompt_cache_key when cacheRetention is none", async () => {
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-1",
      cacheRetention: "none",
    } as SimpleStreamOptions).result();
    expect("prompt_cache_key" in bodyOf(calls)).toBe(false);
  });

  it("chains the caller onPayload after injecting, honoring its replacement", async () => {
    const { calls, fetch } = v2FetchCapture();
    const onPayload = vi.fn(async (payload: unknown) => {
      const body = payload as Record<string, unknown>;
      expect(body.metadata).toMatchObject({ context: { session_id: "session-1" } });
      return { ...body, custom_marker: "from-caller" };
    });
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-1",
      onPayload,
    }).result();
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(bodyOf(calls).custom_marker).toBe("from-caller");
  });

  it("honors the QODER_MODEL_SERVER_HOST override as the explicit escape hatch", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_MODEL_SERVER_HOST: "https://gateway.internal.example.com/v2" },
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("stop");
    expect(urls[0]).toBe("https://gateway.internal.example.com/v2/chat/completions");
  });

  it("errors naming protocol=v2 when credentials are missing", async () => {
    const fetchMock = v2FetchCapture().fetch;
    const events: AssistantMessageEvent[] = [];
    const stream = streamQoderRouter(modelNamed("Ultimate"), context, { fetch: fetchMock });
    for await (const event of stream) events.push(event);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    expect(String((terminal as { error?: { errorMessage?: string } }).error?.errorMessage)).toContain("protocol=v2");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fragmented SSE repair", () => {
  // recorded-from: api2-v2.qoder.sh GLM-5.3 turns, 2026-09-28/29 (sessions
  // 01a0e86b + the 2026-09-29 live run); trimmed from raw wire captures
  // 1790605741332-1.sse (35/1117 events malformed), 1790605774370-2.sse
  // (11/340), and 1790613832783-1.sse (19/700, including a split inside the
  // `data:` prefix itself: `data\n: {...}`). Malformed events keep their exact
  // bytes: 36/33/102-char mid-JSON splits, a zero-length first fragment,
  // 198/204-char splits, and the prefix split. The terminal pair
  // (finish_reason tool_calls + usage) is the recorded one — the captured turns
  // were an agentic tool loop, so the contract they pin is pi-ai's "toolUse"
  // mapping, not "stop".
  const fixture = readFileSync(fileURLToPath(new URL("../__fixtures__/v2-fragmented.sse", import.meta.url)), "utf8");
  // Concatenation of every delta's reasoning text in the fixture, via the
  // repaired form — the answer text a consumer must observe after the turn.
  const EXPECTED_TEXT =
    'Let me think carefully about this start writing feature code? The project is at seed stage, and the AGENTS.md already points to three folders (background/, requirements/, system-analysis/) with existing doc links (current-state-pi-pretty-tui, prd-pi-pretty-tui, at ~/. observable acceptance reason about "';

  function sseResponse(body: string, chunkSize?: number): Response {
    const headers = { "content-type": "text/event-stream" };
    if (!chunkSize) return new Response(body, { headers });
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < body.length; i += chunkSize) chunks.push(encoder.encode(body.slice(i, i + chunkSize)));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { headers },
    );
  }

  function answerText(result: AssistantMessage): string {
    return result.content
      .map((block) => (block.type === "thinking" ? block.thinking : block.type === "text" ? block.text : ""))
      .join("");
  }

  it("repairs a recorded fragmented stream and completes the turn", async () => {
    seedCatalogWithTiers();
    const fetch = vi.fn(async () => sseResponse(fixture)) as unknown as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch }).result();
    expect(result.stopReason).toBe("toolUse");
    expect(answerText(result)).toBe(EXPECTED_TEXT);
  });

  it("repairs the same stream when delivered in 7-byte chunks", async () => {
    seedCatalogWithTiers();
    const fetch = vi.fn(async () => sseResponse(fixture, 7)) as unknown as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch }).result();
    expect(result.stopReason).toBe("toolUse");
    expect(answerText(result)).toBe(EXPECTED_TEXT);
  });

  it("passes non-event-stream responses through untouched", async () => {
    seedCatalogWithTiers();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { type: "invalid_model_error", message: "model not supported" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;
    const events: AssistantMessageEvent[] = [];
    const stream = streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch });
    for await (const event of stream) events.push(event);
    const terminal = events.at(-1) as { type: string; error?: { errorMessage?: string } };
    expect(terminal.type).toBe("error");
    expect(String(terminal.error?.errorMessage)).toContain("invalid_model_error");
  });
});

describe("self-heal", () => {
  const invalidModelResponse = () =>
    new Response(JSON.stringify({ error: { type: "invalid_model_error", message: "model not supported" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  it("retries once on legacy with QODER_FALLBACK=1 and caches the correction", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("chat/completions")) return invalidModelResponse();
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_FALLBACK: "1" },
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("stop");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe("https://api2-v2.qoder.sh/model/v1/chat/completions");
    expect(urls[1]).toContain("agent_chat_generation");
    expect(isMarkedLegacyOnly("ultimate")).toBe(true);
  });

  it("makes zero v2 attempts on the next turn with the same key", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      if (String(input).includes("chat/completions")) return invalidModelResponse();
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_FALLBACK: "1" },
    } as SimpleStreamOptions).result();
    urls.length = 0;
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_FALLBACK: "1" },
    } as SimpleStreamOptions).result();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("agent_chat_generation");
  });

  it("surfaces an actionable error and makes zero legacy attempts when the flag is off", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return invalidModelResponse();
    }) as typeof globalThis.fetch;
    const events: AssistantMessageEvent[] = [];
    const stream = streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch });
    for await (const event of stream) events.push(event);
    expect(events.at(-1)?.type).toBe("error");
    expect(urls).toHaveLength(1);
    expect(isMarkedLegacyOnly("ultimate")).toBe(false);
  });

  it("never retries legacy on a 401, even with the flag on", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ error: { type: "invalid_model_error", message: "unauthorized" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const events: AssistantMessageEvent[] = [];
    const stream = streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_FALLBACK: "1" },
    } as SimpleStreamOptions);
    for await (const event of stream) events.push(event);
    expect(events.at(-1)?.type).toBe("error");
    expect(urls).toHaveLength(1);
    expect(isMarkedLegacyOnly("ultimate")).toBe(false);
  });
});

describe("v2 cost rate source (spec CU-07, T-12/T-13)", () => {
  // invented: chunk shape mirrors the recorded v2 fixture bytes; token counts are the spec's T-12 values.
  function v2UsageSuccess(usage: Record<string, number>): string {
    return [
      `data: ${JSON.stringify({ id: "x", model: "dfmodel", choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
      `data: ${JSON.stringify({ id: "x", model: "dfmodel", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage })}`,
      "data: [DONE]",
    ].join("\n\n");
  }

  function usageFetch(usage: Record<string, number>): typeof globalThis.fetch {
    return vi.fn(
      async () => new Response(v2UsageSuccess(usage), { headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof globalThis.fetch;
  }

  it("prices a measured v2 turn from the registered rates and marks it rate-table (spec T-12/AC-03)", async () => {
    const result = await streamQoderV2(
      modelNamed("DeepSeek-V4-Flash"),
      context,
      {
        apiKey: "fake",
        fetch: usageFetch({ prompt_tokens: 100_000, completion_tokens: 1_000, total_tokens: 101_000 }),
      },
      { mode: "global", modelConfig: { key: "dfmodel" }, upstreamKey: "dfmodel" },
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(result.usage.cost.input).toBeCloseTo(0.0126984, 6);
    expect(result.usage.cost.output).toBeCloseTo(0.000507936, 6);
    expect((result.usage as AssistantMessage["usage"] & { rateSource?: string }).rateSource).toBe("rate-table");
  });

  it("marks an unmeasured v2 turn fallback with zero cost (spec T-13/AC-04)", async () => {
    const result = await streamQoderV2(
      modelNamed("Ultimate"),
      context,
      { apiKey: "fake", fetch: usageFetch({ prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 }) },
      { mode: "global", modelConfig: { key: "ultimate" }, upstreamKey: "ultimate" },
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(result.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    expect((result.usage as AssistantMessage["usage"] & { rateSource?: string }).rateSource).toBe("fallback");
  });
});

/**
 * The plan seam on the v2 transport (spec fs-qoder-turn-plan CU-05,
 * T-12..T-14).
 *
 * T-12 pins capture == wire for the session value; T-13 pins the plan-failure
 * rule through pi-ai's own terminal-error route; T-14 pins the clamped/unclamped
 * split that must survive the single-producer change.
 */
describe("plan seam on the v2 transport", () => {
  afterEach(() => {
    vi.doUnmock("../protocol/plan.js");
    vi.resetModules();
  });

  it("T-12 the debug record's wireSessionId equals the session_id the wire carried", async () => {
    seedCatalogWithTiers();
    const dir = mkdtempSync(join(tmpdir(), "qoder-v2-plan-"));
    vi.stubEnv("QODER_DEBUG", "1");
    vi.stubEnv("QODER_DEBUG_DIR", dir);
    vi.stubEnv("QODER_CORE_PLAN", "1");

    for (const sessionId of ["sess-plan", undefined]) {
      const { calls, fetch } = v2FetchCapture();
      await streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch, sessionId }).result();
      const metadata = bodyOf(calls).metadata as { context: Record<string, unknown> };
      // A session-less dispatch is keyed by the extension's file name, like legacy's record.
      const debugFile = sessionId ?? "extension";
      await vi.waitFor(() => {
        expect(readDebugRecords(dir, debugFile).some((record) => record.type === "response")).toBe(true);
      });
      const response = readDebugRecords(dir, debugFile).find((record) => record.type === "response");
      expect(typeof response?.wireSessionId).toBe("string");
      expect(response?.wireSessionId, `sessionId=${sessionId ?? "(none)"}`).toBe(metadata.context.session_id);
    }
  });

  it("T-13 a rejected plan inside wrappedOnPayload becomes a terminal error event", async () => {
    // AC-10 forbids an identity lookup on v2, so a v2 plan cannot reject through
    // its resolver; the plan boundary itself is rejected here to exercise the
    // rule the spec pins (pi-ai's own terminal-error route, never a hang).
    vi.doMock("../protocol/plan.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../protocol/plan.js")>();
      return {
        ...actual,
        planQoderTurn: async () => {
          throw new Error("plan rejected for test");
        },
      };
    });
    vi.resetModules();
    const { streamQoderV2: streamQoderV2WithRejectedPlan } = await import("../protocol/v2.js");
    const fetchSpy = vi.fn(async () => {
      throw new Error("the plan rejects before any request is built");
    });

    const events: AssistantMessageEvent[] = [];
    const stream = streamQoderV2WithRejectedPlan(
      modelNamed("Ultimate"),
      context,
      { apiKey: "fake", fetch: fetchSpy as unknown as typeof globalThis.fetch, sessionId: "sess-plan" },
      {
        mode: "global",
        modelConfig: { key: "ultimate" },
        upstreamKey: "ultimate",
        plan: {
          protocol: "v2",
          mode: "global",
          upstreamKey: "ultimate",
          rejectedSamplingKeys: [],
          piSessionId: "sess-plan",
          wireSessionV2: { promptCacheKey: "sess-plan", envelopeAndHeaders: "sess-plan" },
          turnKind: "real",
          capture: { protocol: "v2", model: "Ultimate", session: "sess-plan" },
        } as const,
      },
    );
    for await (const event of stream) events.push(event);

    expect(events.at(-1)?.type).toBe("error");
    // The host awaits result(); an end without a terminal event leaves it pending.
    expect((await stream.result()).stopReason).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("T-14 the long session keeps the clamped prompt_cache_key and the unclamped envelope", async () => {
    seedCatalogWithTiers();
    vi.stubEnv("QODER_CORE_PLAN", "1");
    const long = `session-${"x".repeat(80)}`;

    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch, sessionId: long }).result();
    const body = bodyOf(calls);
    const metadata = body.metadata as { context: Record<string, unknown> };

    expect(body.prompt_cache_key).toBe(long.slice(0, 64));
    expect(metadata.context.session_id).toBe(long);
    expect(metadata.context.source_session_id).toBe(long);
  });
});
