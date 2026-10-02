import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache, staticModels } from "../catalog.js";
import { streamQoderRouter } from "../protocol/router.js";
import { clearQoderFallbackCache, clearQoderRoutingMemCache } from "../protocol/routing.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";
import { debugMessages } from "./debug-sink.js";

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
    const debugDir = mkdtempSync(join(tmpdir(), "wire-vocab-debug-"));
    vi.stubEnv("QODER_DEBUG_DIR", debugDir);
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

    // Sink contract (owner directive 2026-10-02): the provider.request debug
    // line lands in the session's JSONL file; the console stays silent.
    expect(errorSpy).not.toHaveBeenCalled();
    const sinkMessages = debugMessages(debugDir, "session-1");
    expect(
      sinkMessages.some((line) => line.includes("provider.request model_key=ultimate protocol=v2 source=routing-data")),
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

/**
 * stream.ts:326-371 — the legacy body's 24 keys in the shipped order.
 *
 * COSY hashes whatever bytes it is handed, so a dropped, renamed or reordered
 * key still signs cleanly and nothing downstream notices: the gateway either
 * rejects the turn or silently mis-bills it. Order is part of the pin because
 * the signature is computed over the serialized bytes.
 */
const LEGACY_BODY_KEYS = [
  "request_id",
  "request_set_id",
  "chat_record_id",
  "session_id",
  "stream",
  "chat_task",
  "is_reply",
  "is_retry",
  "source",
  "version",
  "session_type",
  "agent_id",
  "task_id",
  "code_language",
  "chat_prompt",
  "image_urls",
  "aliyun_user_type",
  "system",
  "messages",
  "tools",
  "parameters",
  "chat_context",
  "model_config",
  "business",
];

/**
 * The 6 base names stream.ts:419-431 merges over the 19 names cosy.ts:183-203
 * returns, sorted for comparison. The COSY names are load-bearing for the
 * signature path; the base names are what the gateway's SSE contract expects.
 * Values are deliberately NOT compared: X-Request-Id is a fresh uuid, Cosy-Date
 * a timestamp and Authorization a signature, so all three differ per request.
 */
const LEGACY_HEADER_NAMES = [
  // stream.ts:419-431
  "Accept",
  "Accept-Encoding",
  "Cache-Control",
  "Content-Type",
  "X-Model-Key",
  "X-Model-Source",
  // cosy.ts:183-203
  "Authorization",
  "Cosy-Bodyhash",
  "Cosy-Bodylength",
  "Cosy-Clientip",
  "Cosy-Clienttype",
  "Cosy-Data-Policy",
  "Cosy-Date",
  "Cosy-Key",
  "Cosy-Machineid",
  "Cosy-Machineos",
  "Cosy-Machinetoken",
  "Cosy-Machinetype",
  "Cosy-Organization-Id",
  "Cosy-Organization-Tags",
  "Cosy-Sigpath",
  "Cosy-User",
  "Cosy-Version",
  "Login-Version",
  "X-Request-Id",
].sort();

/** The affinity trio v2 sends and legacy does not (AC-08's negative pin). */
const AFFINITY_HEADER_NAMES = ["session_id", "x-client-request-id", "x-session-affinity"];

/** True for the plain record mergeQoderHeaders returns, false for the other HeadersInit arms. */
function isPlainHeaderRecord(value: HeadersInit): value is Record<string, string> {
  return !Array.isArray(value) && !(value instanceof Headers);
}

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

  /**
   * Capture the pre-signing body AND the RequestInit the transport receives.
   *
   * Headers are read off the RequestInit, not off the COSY signer's return
   * value: the subject is the merged set the gateway actually sees, which is
   * mergeQoderHeaders' output, not buildAuthHeaders'.
   */
  async function runLegacyCapture(options: SimpleStreamOptions) {
    seedLegacyEffortKey();
    let captured: Record<string, unknown> | undefined;
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (_input: unknown, requestInit?: RequestInit) => {
      init = requestInit;
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
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
    // boundary: stream.ts:419 passes mergeQoderHeaders' plain Record straight
    // through as RequestInit.headers. Anything else means the transport seam
    // changed shape, and this row must fail loudly rather than assert over an
    // empty header set and pass vacuously.
    if (!init) throw new Error("expected the legacy transport to receive a RequestInit");
    if (!init.headers || !isPlainHeaderRecord(init.headers)) {
      throw new Error(`expected a plain header record, got: ${String(init.headers)}`);
    }
    return { body: captured, headers: init.headers };
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

  // T-02 / AC-01: the ordered 24-key body. Element-by-element, so a reorder is
  // as red as a drop -- the COSY signature is over the serialized bytes.
  it("sends exactly the 24 legacy body keys, request_id first and business last, in the shipped order", async () => {
    const { body } = await runLegacyCapture({ apiKey: "fake", reasoning: "high" });
    const keys = Object.keys(body);
    expect(keys).toEqual(LEGACY_BODY_KEYS);
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe("request_id");
    expect(keys.at(-1)).toBe("business");
  });

  // T-03 / AC-01: the merged 25-name header set.
  it("merges the 6 base header names over the 19 COSY names into one 25-name set", async () => {
    const { headers } = await runLegacyCapture({ apiKey: "fake", reasoning: "high" });
    const names = Object.keys(headers);
    expect([...names].sort()).toEqual(LEGACY_HEADER_NAMES);
    expect(names).toHaveLength(25);
    // mergeQoderHeaders is case-insensitive, so a set that lost that property
    // would show two spellings of one name and 26 entries.
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(25);
    // The non-deterministic values are present but not compared; pin only that
    // they are non-empty, so a blanked signature is still caught.
    expect(String(headers.Authorization).startsWith("Bearer COSY.")).toBe(true);
    expect(String(headers["X-Request-Id"]).length).toBeGreaterThan(0);
    expect(String(headers["Cosy-Date"]).length).toBeGreaterThan(0);
  });

  // T-04 / AC-08: the affinity gap, pinned as a negative so the CU-7 probe
  // verdict flips this row deliberately instead of silently.
  it("sends no prompt_cache_key field and none of the three affinity headers", async () => {
    // sessionId is supplied on purpose: were affinity implemented, this is the
    // value it would carry, so the negative is meaningful rather than trivial.
    const { body, headers } = await runLegacyCapture({
      apiKey: "fake",
      reasoning: "high",
      sessionId: "session-1",
    });
    expect("prompt_cache_key" in body).toBe(false);
    const lower = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
    for (const name of AFFINITY_HEADER_NAMES) {
      expect(lower.has(name), `legacy must not send the ${name} header`).toBe(false);
    }
  });
});

/**
 * AC-01/AC-05 — each protocol's emitted event-type vocabulary is the same
 * twelve types.
 *
 * Count-based assertions are deliberately absent. Legacy coalesces text_delta
 * by design (stream.ts:139-158), so comparing event COUNTS across protocols can
 * only be wrong; the comparable dimension is which TYPES a protocol can emit.
 * That is the dimension the migration promises to unify, and the one the host's
 * block-closing path depends on. Every row here compares type Sets; none counts
 * events.
 *
 * One stream cannot emit both terminals, so each protocol's vocabulary is the
 * union of a rich success stream and an error stream -- measured, not assumed:
 * both protocols now emit all 12 types, legacy having gained text_end.
 */
describe("event vocabulary parity (SA FR-5)", () => {
  /** The 12 types pi-ai's AssistantMessageEvent union declares, in declaration order. */
  const FULL_VOCABULARY = [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
    "error",
  ];

  const deltaChunk = (delta: object) => ({ choices: [{ delta, index: 0 }], id: "probe", model: "auto" });
  const finish = (reason: string) => ({
    choices: [{ finish_reason: reason, index: 0 }],
    id: "probe",
    model: "auto",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

  async function collectTypes(stream: AssistantMessageEventStream): Promise<string[]> {
    const sequence: string[] = [];
    for await (const event of stream) {
      sequence.push(event.type);
      if (event.type === "done" || event.type === "error") break;
    }
    return sequence;
  }

  /** start before any update, and the terminal is last with no terminal before it. */
  function assertBoundaryContract(sequence: string[], label: string): void {
    expect(sequence[0], `${label} must open with start`).toBe("start");
    const terminal = sequence.at(-1);
    expect(terminal === "done" || terminal === "error", `${label} must end on its terminal`).toBe(true);
    // Expressed without a length/count comparison: a count over an event array
    // is exactly the assertion class D8 forbids in this describe.
    const earlierTerminal = sequence.slice(0, -1).find((type) => type === "done" || type === "error");
    expect(earlierTerminal, `${label} must terminate exactly once`).toBeUndefined();
  }

  const runLegacyStream = async (sse: string): Promise<string[]> => {
    seedLegacyEffortKey();
    const fetch = vi.fn(
      async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as typeof globalThis.fetch;
    return collectTypes(
      streamQoderRouter(modelNamed("DeepSeek-V4-Flash"), context, { apiKey: "fake", fetch, reasoning: "high" }),
    );
  };

  const runV2Stream = async (sse: string): Promise<string[]> => {
    const fetch = vi.fn(
      async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as typeof globalThis.fetch;
    return collectTypes(
      streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch, reasoning: "high" }),
    );
  };

  /** Thinking, then text, then a tool call split across two deltas, then a terminal. */
  const legacyRich =
    envelope(deltaChunk({ reasoning_content: "<thinking>hmm</thinking>" })) +
    envelope(deltaChunk({ content: "hello" })) +
    envelope(deltaChunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"p":' } }] })) +
    envelope(deltaChunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] })) +
    envelope(finish("tool_calls")) +
    "data: [DONE]\n\n";

  /** A text delta and then the body closes with no finish_reason and no sentinel. */
  const legacyTruncated = envelope(deltaChunk({ content: "hello" }));

  const v2Frame = (payload: object) => `data:${JSON.stringify({ id: "probe", model: "ultimate", ...payload })}`;
  const v2Rich = [
    v2Frame({ choices: [{ delta: { reasoning_content: "thinking hard" }, index: 0 }] }),
    v2Frame({ choices: [{ delta: { content: "answer" }, index: 0 }] }),
    v2Frame({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: '{"p":"x"}' } }],
          },
          index: 0,
        },
      ],
    }),
    v2Frame({
      choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    "data:[DONE]",
  ].join("\n\n");

  const v2Failed = `${v2Frame({ error: { message: "boom" } })}\n\ndata:[DONE]`;

  // T-05 / AC-01
  it("legacy emits the full twelve-type vocabulary, text_end included", async () => {
    const success = await runLegacyStream(legacyRich);
    const failed = await runLegacyStream(legacyTruncated);
    assertBoundaryContract(success, "legacy success");
    assertBoundaryContract(failed, "legacy failure");

    const emitted = new Set([...success, ...failed]);
    expect([...emitted].sort()).toEqual([...FULL_VOCABULARY].sort());
    // The gap FS-6 closes, asserted by name so a regression to an unclosed text
    // block is a red row rather than a quiet set difference.
    expect(emitted.has("text_end"), "legacy now closes its text blocks").toBe(true);
    // Sanity on the channels the fixture drives, without counting events.
    for (const expected of [
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]) {
      expect(emitted.has(expected), `legacy rich stream should emit ${expected}`).toBe(true);
    }
    expect(failed.at(-1)).toBe("error");
  });

  // T-06 / AC-01
  it("v2 emits the same full twelve-type union", async () => {
    const success = await runV2Stream(v2Rich);
    const failed = await runV2Stream(v2Failed);
    assertBoundaryContract(success, "v2 success");
    assertBoundaryContract(failed, "v2 failure");

    const emitted = new Set([...success, ...failed]);
    expect([...emitted].sort()).toEqual([...FULL_VOCABULARY].sort());
    expect(emitted.has("text_end"), "v2 closes its text block").toBe(true);
    expect(failed.at(-1)).toBe("error");
  });

  // T-05 / AC-01: the migration's parity claim in one assertion -- neither
  // protocol emits a type the other does not.
  it("puts both protocols on the same type set, with no parity gap left", async () => {
    seedLegacyEffortKey();
    const legacyFetch = vi.fn(
      async () => new Response(legacyRich, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as typeof globalThis.fetch;
    const v2Fetch = vi.fn(
      async () => new Response(v2Rich, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as typeof globalThis.fetch;

    const legacy = new Set(
      await collectTypes(
        streamQoderRouter(modelNamed("DeepSeek-V4-Flash"), context, {
          apiKey: "fake",
          fetch: legacyFetch,
          reasoning: "high",
        }),
      ),
    );
    const v2 = new Set(
      await collectTypes(
        streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch: v2Fetch, reasoning: "high" }),
      ),
    );

    expect([...legacy].filter((type) => !v2.has(type)).sort()).toEqual([]);
    expect([...v2].filter((type) => !legacy.has(type)).sort()).toEqual([]);
  });

  // T-05 / AC-01: the ordering boundary. The coalescer force-flushes a pending
  // delta before any non-delta event (stream.ts:139-158), so a text_end lands
  // after its block's last text_delta and before whatever follows. indexOf
  // comparisons, never fixed positions: legacy coalesces deltas, so how many
  // events precede any of these varies by fixture.
  it("orders text_end after its last delta and before the following block or terminal", async () => {
    // End of an ordinary answer: the block closes with the stream, before done.
    const plain = await runLegacyStream(legacySuccess);
    const plainEnd = plain.indexOf("text_end");
    expect(plain.lastIndexOf("text_delta", plainEnd)).toBeLessThan(plainEnd);
    expect(plainEnd).toBeLessThan(plain.indexOf("done"));

    // A DSML tool call embedded in content is an ordering boundary: the text
    // block closes before the tool block opens.
    const dsmlCall =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read">\n` +
      `<｜DSML｜parameter name="path" string="true">x</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const withTool = [
      envelope(deltaChunk({ content: "hello " })),
      envelope(deltaChunk({ content: dsmlCall })),
      "data: [DONE]\n\n",
    ].join("");
    const tool = await runLegacyStream(withTool);
    const toolEnd = tool.lastIndexOf("text_end");
    expect(tool.lastIndexOf("text_delta", toolEnd)).toBeLessThan(toolEnd);
    expect(toolEnd).toBeLessThan(tool.indexOf("toolcall_start"));

    // A text block closed before a later thinking block sits before that
    // block's thinking_start.
    const twoThinking =
      envelope(deltaChunk({ content: "alpha <thinking>one</thinking> beta <thinking>two</thinking>" })) +
      envelope(finish("stop")) +
      "data: [DONE]\n\n";
    const nested = await runLegacyStream(twoThinking);
    const beforeThinking = nested.indexOf("text_end", nested.lastIndexOf("text_delta"));
    expect(beforeThinking).toBeLessThan(nested.lastIndexOf("thinking_start"));
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
