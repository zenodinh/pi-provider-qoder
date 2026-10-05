import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staticModels } from "../catalog.js";
import { clearPrefixChainRegistry } from "../protocol/prefix-chain.js";
import { clearQoderRunRegistry } from "../protocol/run-identity.js";
import { streamQoder } from "../protocol/stream.js";
import { streamQoderV2 } from "../protocol/v2.js";
import { loadLiveFixture } from "./live-fixture.js";

// Pin the identity so the mocked fetch below only ever serves the chat request.
// Without a resolved identity, streamQoder fetches /userinfo first and consumes
// the mock response, leaving the chat read to fail on a locked stream.
vi.mock("../auth/oauth.js", () => ({
  resolveQoderIdentity: vi.fn().mockResolvedValue({
    access: "fake",
    userID: "test-user",
    email: "test@example.com",
    name: "Test User",
    machineID: "test-machine",
    refresh: "",
    expires: 0,
  }),
}));

/**
 * Build a single SSE `data:` line carrying a Qoder envelope:
 *   { headers, body: <JSON string>, statusCodeValue, statusCode }
 * The server wraps the OpenAI-style chunk inside `body` as a JSON string.
 */
function sseEnvelope(body: object, statusCodeValue = 200, statusCode = "OK"): string {
  return (
    "data:" +
    JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: JSON.stringify(body),
      statusCodeValue,
      statusCode,
    }) +
    "\n\n"
  );
}

const DONE_SSE =
  "data:" +
  JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: "[DONE]",
    statusCodeValue: 200,
    statusCode: "OK",
  }) +
  "\n\n";

function chunk(delta: object, extra: object = {}): object {
  return {
    choices: [{ delta, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    ...extra,
  };
}

function finishChunk(finish_reason: string, extra: object = {}): object {
  return {
    choices: [{ finish_reason, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    ...extra,
  };
}

const SUCCESS_SSE = loadLiveFixture("global").interactions.chat.response.body as string;

const BLOCKED_SSE = sseEnvelope(
  { code: "provider_error", message: "Session blocked", request_id: "r", type: "provider_error" },
  406,
  "Not Acceptable",
);

function mockFetch(body: string): typeof fetch {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function makeModel(provider = "qoder", id = "Lite"): Model<Api> {
  return { id, api: "qoder-api" as Api, provider } as Model<Api>;
}

function makeContext(): TranscriptContext {
  // 0.86.0+ providers receive a normalized TranscriptContext where the system
  // prompt and tools live in a leading system message. normalizeContext folds
  // the legacy Context shape into that form, matching what pi passes at runtime.
  return normalizeContext({
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context);
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return events;
}

/** The stored usage row as pi persists it: pi-ai Usage plus the Qoder extras this extension adds. */
type StoredUsage = AssistantMessage["usage"] & {
  credits?: number;
  original_credits?: number;
  billable?: boolean;
  rateSource?: "credits" | "rate-table" | "fallback";
  prefixLen?: number;
  prefixHash?: string;
  prefixStable?: boolean;
  prefixDivergedAt?: number;
  paramsHash?: string;
  payloadHash?: string;
};

/**
 * The five prefix keys every stamped turn carries. `prefixDivergedAt` is the sixth
 * and rides only an unstable prefix, so the cold-stamp rows append it explicitly.
 */
const PREFIX_FIELDS = ["prefixLen", "prefixHash", "prefixStable", "paramsHash", "payloadHash"] as const;

describe("streamQoder", () => {
  const originalFetch = globalThis.fetch;
  const originalCnPat = process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalCnPat === undefined) delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
    else process.env.QODERCN_PERSONAL_ACCESS_TOKEN = originalCnPat;
    vi.restoreAllMocks();
  });

  it("replays a recorded-format SSE fixture into text + stop", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
  });

  it("forwards tools and system prompt folded into the normalized transcript", async () => {
    // Regression for the 0.86.0 TranscriptContext migration: the system prompt
    // and tool declarations no longer arrive as top-level Context fields but as
    // a leading system message. The provider must read them back with
    // getCurrentSystemPrompt/getCurrentTools, or the model gets no tools and
    // cannot read files or run commands.
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const context = normalizeContext({
      systemPrompt: "you are helpful",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    } as unknown as Context);

    await consume(streamQoder(makeModel("qoder", "Lite"), context, { apiKey: "fake" }));

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const encoded = Buffer.from(init?.body as Uint8Array).toString("utf8");
    const rearranged = [...encoded]
      .map((character) => (character === "$" ? "=" : standard[custom.indexOf(character)] || character))
      .join("");
    const third = Math.floor(rearranged.length / 3);
    const base64 =
      rearranged.slice(rearranged.length - third) +
      rearranged.slice(third, rearranged.length - third) +
      rearranged.slice(0, third);
    const body = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as {
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ type: string; function: { name: string } }>;
    };

    expect(body.messages[0]).toEqual({ role: "system", content: "you are helpful" });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("read");
  });

  it("sends the internal upstream key for a friendly model id", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), { apiKey: "fake" }));

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    expect(init?.headers).toEqual(expect.objectContaining({ "X-Model-Key": "lite" }));

    const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const encoded = Buffer.from(init?.body as Uint8Array).toString("utf8");
    const rearranged = [...encoded]
      .map((character) => (character === "$" ? "=" : standard[custom.indexOf(character)] || character))
      .join("");
    const third = Math.floor(rearranged.length / 3);
    const base64 =
      rearranged.slice(rearranged.length - third) +
      rearranged.slice(third, rearranged.length - third) +
      rearranged.slice(0, third);
    const body = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as {
      chat_context: { extra: { modelConfig: { key: string } } };
      model_config: { key: string };
    };
    expect(body.chat_context.extra.modelConfig.key).toBe("lite");
    expect(body.model_config.key).toBe("lite");
  });

  it("bounds long session ids to the upstream prompt cache key limit", async () => {
    const sessionId = `session-${"x".repeat(80)}`;
    const options = { apiKey: "fake", sessionId };

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), options));
    const firstInit = vi.mocked(globalThis.fetch).mock.calls[0][1];

    const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const decodeBody = (init: RequestInit | undefined): { session_id: string } => {
      const encoded = Buffer.from(init?.body as Uint8Array).toString("utf8");
      const rearranged = [...encoded]
        .map((character) => (character === "$" ? "=" : standard[custom.indexOf(character)] || character))
        .join("");
      const third = Math.floor(rearranged.length / 3);
      const base64 =
        rearranged.slice(rearranged.length - third) +
        rearranged.slice(third, rearranged.length - third) +
        rearranged.slice(0, third);
      return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as { session_id: string };
    };
    const firstBody = decodeBody(firstInit);

    expect(firstBody.session_id.length).toBeLessThanOrEqual(64);
    expect(firstBody.session_id).toMatch(/^qoder-session-[0-9a-f]{16}$/);

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), options));
    const secondInit = vi.mocked(globalThis.fetch).mock.calls[0][1];
    expect(decodeBody(secondInit).session_id).toBe(firstBody.session_id);
  });

  it("binds chat hosts to provider ids even when only a CN PAT is set", async () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-cn-only";

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder"), makeContext(), { apiKey: "fake" }));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api3\.qoder\.sh\//),
      expect.any(Object),
    );

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder-cn", "Qwen3.7-Plus"), makeContext(), { apiKey: "fake" }));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/gateway\.qoder\.com\.cn\//),
      expect.any(Object),
    );
  });

  it("surfaces an upstream 406 'Session blocked' as an error event, not a silent stop", async () => {
    globalThis.fetch = mockFetch(BLOCKED_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/Session blocked/);
    expect(msg.errorMessage).toMatch(/406/);
    // Must NOT emit a silent done/stop.
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it.each(["", sseEnvelope(chunk({ content: "partial" }))])("rejects premature EOF (%s)", async (sse) => {
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { stopReason: "error", errorMessage: expect.stringContaining("unexpected EOF") },
    });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it.each(["stop", "length"])("accepts a terminal %s chunk without a trailing newline or sentinel", async (reason) => {
    globalThis.fetch = mockFetch(sseEnvelope(finishChunk(reason)).trimEnd());
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(events.at(-1)).toMatchObject({ type: "done", reason, message: { rawStopReason: reason } });
  });

  it.each(["content_filter", "unexpected_reason"])(
    "normalizes %s to an error, preserving the raw reason",
    async (reason) => {
      globalThis.fetch = mockFetch(sseEnvelope(finishChunk(reason)) + DONE_SSE);
      const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
      expect(events.at(-1)).toMatchObject({ type: "error", reason: "error", error: { rawStopReason: reason } });
    },
  );

  it("rejects malformed data even when followed by DONE", async () => {
    globalThis.fetch = mockFetch(`data: {broken\n\n${DONE_SSE}`);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(events.at(-1)).toMatchObject({ type: "error", error: { errorMessage: "Malformed Qoder SSE data" } });
  });

  it("surfaces errors carried inside a successful envelope", async () => {
    globalThis.fetch = mockFetch(sseEnvelope({ error: { message: "context_length_exceeded" } }) + DONE_SSE);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { errorMessage: expect.stringContaining("context_length_exceeded") },
    });
  });

  it.each(["tool_calls", "length"])("never executes truncated tool arguments on %s", async (reason) => {
    globalThis.fetch = mockFetch(
      sseEnvelope(
        chunk({ tool_calls: [{ index: 0, id: "call", function: { name: "bash", arguments: '{"command":' } }] }),
      ) +
        sseEnvelope(finishChunk(reason)) +
        DONE_SSE,
    );
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
  });

  it("rejects a tool finish without tool calls", async () => {
    globalThis.fetch = mockFetch(sseEnvelope(finishChunk("tool_calls")) + DONE_SSE);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(events.at(-1)?.type).toBe("error");
  });

  it("preserves finish_reason=length instead of overwriting to stop", async () => {
    const sse =
      sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("length");
  });

  it("captures usage and responseId from the finish chunk, without echoing responseModel", async () => {
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          id: "chatcmpl-abc123",
          model: "qmodel_latest",
          usage: {
            prompt_tokens: 42,
            completion_tokens: 7,
            total_tokens: 49,
            completion_tokens_details: { reasoning_tokens: 3 },
            credits: 2.75,
            original_credits: 3.5,
            billable: true,
            // prompt_tokens (42) INCLUDES cached_tokens (5) per OpenAI
            // semantics; pi-core expects `input` to exclude them
            // (promptTokens = input + cacheRead + cacheWrite), so input =
            // 42 - 5 - 10 = 27. cacheable_tokens is a capacity metric, not a
            // write count, and must not be mapped to cacheWrite.
            prompt_tokens_details: { cacheable_tokens: 99, cache_write_tokens: 10, cached_tokens: 5 },
          },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.responseId).toBe("chatcmpl-abc123");
    // Inverted on purpose (qoder-warm-attribution FR-1, bc_binding: contract).
    // The gateway echoes one constant for every requested model, so copying it
    // made pi's warm stamp (`responseModel ?? model`) key warm rows by that
    // constant while assistant rows keyed by the friendly id — the false
    // "model switch" notice of BUG-0001. Absence, not an empty string: only
    // `undefined` falls through `??` to `model`.
    expect(msg.responseModel).toBeUndefined();
    expect(msg.usage.input).toBe(27);
    expect(msg.usage.output).toBe(7);
    expect(msg.usage.totalTokens).toBe(49);
    expect(msg.usage.cacheRead).toBe(5);
    expect(msg.usage.cacheWrite).toBe(10);
    expect(msg.usage.reasoning).toBe(3);
    const qoderUsage = msg.usage as typeof msg.usage & {
      credits?: number;
      original_credits?: number;
      billable?: boolean;
    };
    expect(qoderUsage.credits).toBe(2.75);
    expect(qoderUsage.original_credits).toBe(3.5);
    expect(qoderUsage.billable).toBe(true);
  });

  it("does not invent zero Credits when usage omits Qoder billing fields", async () => {
    const sse = sseEnvelope(finishChunk("stop")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect("credits" in msg.usage).toBe(false);
    expect("original_credits" in msg.usage).toBe(false);
    expect("billable" in msg.usage).toBe(false);
  });

  // ── cost transparency (spec CU-02, T-04..T-08) ───────────────────────────

  it("prices a 100.0-Credit turn at the shared basis and marks it credits (spec T-04/AC-01)", async () => {
    // recorded-from: the envelope format and finishChunk shape mirror the live
    // legacy SSE captures (SUCCESS_SSE); the Credits amount is the spec's T-04 value.
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          usage: { prompt_tokens: 250_000, completion_tokens: 1_000, total_tokens: 251_000, credits: 100.0 },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(
      streamQoder(makeModel("qoder", "DeepSeek-V4-Flash"), makeContext(), { apiKey: "fake" }),
    );
    const msg = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message;
    const cost = msg.usage.cost;
    expect(cost.total).toBeCloseTo(1.3333333, 6);
    expect(Math.abs(cost.input + cost.output + cost.cacheRead + cost.cacheWrite - cost.total)).toBeLessThanOrEqual(
      1e-9,
    );
    expect(cost.input).toBeGreaterThan(cost.output);
    expect(cost.output).toBeGreaterThan(0);
    expect((msg.usage as StoredUsage).rateSource).toBe("credits");
  });

  it("prices the charged amount, not the list amount, on a discounted turn (spec T-05/AC-02)", async () => {
    // invented: the charged/list pair (0.4 / 1.0) is pinned by spec T-05.
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          usage: {
            prompt_tokens: 1_000,
            completion_tokens: 100,
            total_tokens: 1_100,
            credits: 0.4,
            original_credits: 1.0,
            billable: true,
          },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), { apiKey: "fake" }));
    const usage = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message.usage as StoredUsage;
    expect(usage.cost.total).toBeCloseTo(0.0053333333, 6);
    // The list amount (1.0 → 0.0133333) must not be the stored price.
    expect(Math.abs(usage.cost.total - 0.0133333)).toBeGreaterThan(1e-3);
  });

  it("stores zero cost with a fallback marker when an unmeasured model reports no Credits (spec T-06/AC-04, AC-09)", async () => {
    // invented: finishChunk's default usage carries no Qoder billing fields (spec T-06).
    const sse = sseEnvelope(chunk({ content: "OK", role: "assistant" })) + sseEnvelope(finishChunk("stop")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), { apiKey: "fake" }));
    const usage = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message.usage as StoredUsage;
    expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    expect(usage.rateSource).toBe("fallback");
    expect("credits" in usage).toBe(false);
    expect("original_credits" in usage).toBe(false);
    expect("billable" in usage).toBe(false);
  });

  it("prices an uncharged measured turn from the rate table and marks it rate-table (spec T-07/AC-04)", async () => {
    // invented: token counts are pinned by spec T-07 (100,000 in / 1,000 out on dfmodel).
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", { usage: { prompt_tokens: 100_000, completion_tokens: 1_000, total_tokens: 101_000 } }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(
      streamQoder(makeModel("qoder", "DeepSeek-V4-Flash"), makeContext(), { apiKey: "fake" }),
    );
    const usage = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message.usage as StoredUsage;
    expect(usage.cost.input).toBeCloseTo(0.0126984, 6);
    expect(usage.cost.output).toBeCloseTo(0.000507936, 6);
    expect(usage.cost.total).toBeCloseTo(0.013206336, 6);
    expect(usage.rateSource).toBe("rate-table");
  });

  it("prices a warm-shaped request (maxTokens 1) like any other charged turn (spec T-08/AC-07)", async () => {
    // invented: warm-row Credits (0.423) and token counts mirror SA §9.1 T-5's refresh example.
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          usage: { prompt_tokens: 4_000, completion_tokens: 10, total_tokens: 4_010, credits: 0.423 },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(
      streamQoder(makeModel("qoder", "DeepSeek-V4-Flash"), makeContext(), { apiKey: "fake", maxTokens: 1 }),
    );
    const usage = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message.usage as StoredUsage;
    expect(usage.cost.total).toBeCloseTo(0.00564, 6);
    expect(usage.rateSource).toBe("credits");
  });

  it("coalesces consecutive text deltas without changing the final content", async () => {
    const sse =
      sseEnvelope(chunk({ content: "a", role: "assistant" })) +
      sseEnvelope(chunk({ content: "b" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const textDeltas = events.filter((event) => event.type === "text_delta");
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0] && "delta" in textDeltas[0] ? textDeltas[0].delta : "").toBe("ab");
  });

  it.each(["content", "reasoning_content"])(
    "flushes a lone %s delta on time while the body remains open",
    async (channel) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      globalThis.fetch = vi.fn(async () => new Response(body)) as typeof fetch;
      const events: AssistantMessageEvent[] = [];
      const task = (async () => {
        for await (const event of streamQoder(makeModel(), makeContext(), { apiKey: "fake" })) events.push(event);
      })();
      try {
        controller.enqueue(new TextEncoder().encode(sseEnvelope(chunk({ [channel]: "first" }))));
        // Drain real setImmediate yields used during request encoding.
        for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events.some((event) => event.type.endsWith("_delta"))).toBe(false);
        await vi.advanceTimersByTimeAsync(50);
        expect(events.filter((event) => event.type.endsWith("_delta"))).toHaveLength(1);
        expect(events.some((event) => event.type === "done")).toBe(false);
        controller.enqueue(new TextEncoder().encode(DONE_SSE));
        await task;
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["done", "error"])("clears a pending delta timer on %s without emitting late events", async (ending) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      globalThis.fetch = mockFetch(
        sseEnvelope(chunk({ content: "tail" })) + (ending === "done" ? DONE_SSE : "data: {broken\n\n"),
      );
      const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
      expect(events.at(-1)?.type).toBe(ending);
      expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables delta coalescing when the interval is zero", async () => {
    const previous = process.env.QODER_STREAM_DELTA_INTERVAL_MS;
    process.env.QODER_STREAM_DELTA_INTERVAL_MS = "0";
    try {
      globalThis.fetch = mockFetch(
        sseEnvelope(chunk({ content: "a" })) + sseEnvelope(chunk({ content: "b" })) + DONE_SSE,
      );
      const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
      expect(events.filter((event) => event.type === "text_delta")).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.QODER_STREAM_DELTA_INTERVAL_MS;
      else process.env.QODER_STREAM_DELTA_INTERVAL_MS = previous;
    }
  });

  it("keeps many ordinary reasoning chunks intact without DSML markup", async () => {
    const reasoning = Array.from({ length: 200 }, (_, index) => `thought-${index} `).join("");
    const sse =
      Array.from({ length: 200 }, (_, index) => sseEnvelope(chunk({ reasoning_content: `thought-${index} ` }))).join(
        "",
      ) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([{ type: "thinking", thinking: reasoning }]);
  });

  it("coalesces a fast burst of reasoning deltas into a single event", async () => {
    // A huge throttle window makes the coalescing deterministic: all consecutive
    // reasoning deltas must merge until the next ordering boundary (thinking_end).
    process.env.QODER_STREAM_DELTA_INTERVAL_MS = "100000";
    try {
      const reasoning = Array.from({ length: 200 }, (_, index) => `thought-${index} `).join("");
      const sse =
        Array.from({ length: 200 }, (_, index) => sseEnvelope(chunk({ reasoning_content: `thought-${index} ` }))).join(
          "",
        ) +
        sseEnvelope(finishChunk("stop")) +
        DONE_SSE;
      globalThis.fetch = mockFetch(sse);

      const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
      const deltas = events.filter((event) => event.type === "thinking_delta");
      const streamed = deltas.reduce((acc, event) => acc + ("delta" in event ? event.delta.length : 0), 0);

      // The host re-renders the whole block per delta, so the burst must not
      // produce one event per chunk.
      expect(deltas.length).toBeLessThanOrEqual(2);
      expect(streamed).toBe(reasoning.length);

      const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
      expect(done.message.content).toEqual([{ type: "thinking", thinking: reasoning }]);
    } finally {
      delete process.env.QODER_STREAM_DELTA_INTERVAL_MS;
    }
  });

  it("finishes a large buffered SSE response without a parser loop", async () => {
    const sse =
      Array.from({ length: 100 }, () => sseEnvelope(chunk({ content: "x", role: "assistant" }))).join("") + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const text = msg.content.find((content) => content.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("x".repeat(100));
  });

  it("emits a done event with reason=length when finish_reason is length", async () => {
    const sse =
      sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    expect((done as { reason: string }).reason).toBe("length");
  });

  it("reports a tool_use stop reason when the stream emits tool calls", async () => {
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "bash", arguments: '{"command":"ls"}' },
            },
          ],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("toolUse");
    const toolCall = msg.content.find((c) => c.type === "toolCall");
    expect(toolCall).toBeDefined();
  });

  it("assembles reasoning chunks before the final answer", async () => {
    const sse =
      sseEnvelope(chunk({ reasoning_content: "check " })) +
      sseEnvelope(chunk({ reasoning_content: "twice" })) +
      sseEnvelope(chunk({ content: "done" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: "check twice" },
      { type: "text", text: "done" },
    ]);
    expect(events.map((event) => event.type)).toContain("thinking_delta");
  });

  it("keeps summary reasoning and leaked DSML calls out of visible text", async () => {
    const thought = "And checkSignalValByByte in the new code... let me look at what it actually is.";
    const answer = "好，这是 CS 路由，涉及信号值的验证，流程更复杂。";
    const token = "｜DSML｜";
    const dsml =
      `<${token}tool_calls>\n<${token}invoke name="read">\n` +
      `<${token}parameter name="limit" string="false">20</${token}parameter>\n` +
      `<${token}parameter name="offset" string="false">238</${token}parameter>\n` +
      `<${token}parameter name="path"\n string="true">/home/whh/src/capl_platform/capl/test/test_canroute/canroute_fun.cin</${token}parameter>\n` +
      `</${token}invoke>\n</${token}tool_calls>`;
    const split = Math.floor(dsml.length / 2);
    const sse =
      sseEnvelope(chunk({ reasoning_content: `<summary>${thought}` })) +
      sseEnvelope(chunk({ content: `</summary>\n\n${answer}\n\n${dsml.slice(0, split)}` })) +
      sseEnvelope(chunk({ content: dsml.slice(split) })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: thought },
      { type: "text", text: `${answer}\n\n` },
      {
        type: "toolCall",
        id: "dsml_call_0",
        name: "read",
        arguments: {
          limit: 20,
          offset: 238,
          path: "/home/whh/src/capl_platform/capl/test/test_canroute/canroute_fun.cin",
        },
      },
    ]);
    const visibleText = done.message.content
      .filter(
        (content): content is Extract<AssistantMessage["content"][number], { type: "text" }> => content.type === "text",
      )
      .map((content) => content.text)
      .join("");
    expect(visibleText).not.toContain("</summary>");
    expect(visibleText).not.toContain("DSML");
    expect(done.message.stopReason).toBe("toolUse");
  });

  it("assembles parallel tool calls by their stream indexes", async () => {
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [
            { index: 0, id: "call_a", function: { name: "read", arguments: '{"path":' } },
            { index: 1, id: "call_b", function: { name: "search", arguments: '{"query":' } },
          ],
        }),
      ) +
      sseEnvelope(
        chunk({
          tool_calls: [
            { index: 0, function: { arguments: '"/a"}' } },
            { index: 1, function: { arguments: '"needle"}' } },
          ],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    const calls = done.message.content.filter((block): block is ToolCall => block.type === "toolCall");

    expect(calls).toEqual([
      { type: "toolCall", id: "call_a", name: "read", arguments: { path: "/a" } },
      { type: "toolCall", id: "call_b", name: "search", arguments: { query: "needle" } },
    ]);
  });

  it("keeps tagged thinking event indexes stable after streamed text", async () => {
    const sse =
      sseEnvelope(chunk({ content: "prefix <thinking>reason</thinking> answer" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    const textDelta = events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
        event.type === "text_delta" && event.delta.includes("prefix"),
    );
    const thinkingDelta = events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
        event.type === "thinking_delta" && event.delta === "reason",
    );

    expect(done.message.content).toEqual([
      { type: "text", text: "prefix " },
      { type: "thinking", thinking: "reason" },
      { type: "text", text: " answer" },
    ]);
    expect(textDelta?.contentIndex).toBe(0);
    expect(thinkingDelta?.contentIndex).toBe(1);
    expect(done.message.content[textDelta?.contentIndex ?? -1]?.type).toBe("text");
    expect(done.message.content[thinkingDelta?.contentIndex ?? -1]?.type).toBe("thinking");
  });

  it("recovers thinking after content when the upstream switches channels", async () => {
    const sse =
      sseEnvelope(chunk({ reasoning_content: "first thought" })) +
      sseEnvelope(chunk({ content: "answer" })) +
      sseEnvelope(chunk({ reasoning_content: "second thought" })) +
      sseEnvelope(chunk({ content: " more" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: "first thought" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "second thought" },
      { type: "text", text: " more" },
    ]);
  });

  it("preserves text emitted before and after a tool call", async () => {
    const sse =
      sseEnvelope(chunk({ content: "before" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }] })) +
      sseEnvelope(chunk({ content: " after" })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "text", text: "before after" },
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
    ]);
  });

  it("emits a tool call that arrives with no arguments", async () => {
    // A no-argument tool, or a model that sends id+name and stops. The block
    // used to be created only inside `if (tc.function?.arguments)`, so this
    // produced a toolCallsState entry and NO content block — and the finalizer
    // then set stopReason "toolUse" on a message with no tool call in it. pi's
    // agent loop had nothing to execute and the turn ended silently, mid-task.
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "call_1", function: { name: "advisor", arguments: "" } }],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall, "a named tool call must reach the message even with no arguments").toBeDefined();
    expect(toolCall?.name).toBe("advisor");
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.arguments).toEqual({});
    expect(msg.stopReason).toBe("toolUse");
  });

  it("picks up an id and name that arrive after the block is open", async () => {
    // Streamed the other way round: arguments first, identity later.
    const sse =
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: { name: "bash", arguments: '{"comm' } }] })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_9", function: { arguments: 'and":"ls"}' } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall?.id).toBe("call_9");
    expect(toolCall?.name).toBe("bash");
    expect(toolCall?.arguments).toEqual({ command: "ls" });
  });

  it("does not claim toolUse when no tool call reached the message", async () => {
    // A malformed stream: a tool_calls delta with neither id nor name. Better a
    // clean "stop" than a message that says toolUse and carries nothing, which
    // the agent loop cannot act on and cannot report.
    const sse =
      sseEnvelope(chunk({ content: "thinking about it", role: "assistant" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: {} }] })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.content.find((c) => c.type === "toolCall")).toBeUndefined();
    expect(msg.stopReason).toBe("stop");
  });
  it("finishes when the gateway sends [DONE] but keeps the body open", async () => {
    // Qoder's gateway does not always close the HTTP body after the sentinel.
    // The read loop used to keep awaiting reader.read() until the socket went
    // away, so a fully streamed reply never produced a done event and the
    // agent appeared to hang with no error.
    const sse = sseEnvelope(chunk({ content: "OK", role: "assistant" })) + sseEnvelope(finishChunk("stop")) + DONE_SSE;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        // Deliberately never call controller.close().
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event even though the body stayed open").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
    // The reader is released rather than left holding the connection.
    expect(cancelled).toBe(true);
  });

  it("finishes on a bare 'data: [DONE]' line with the body left open", async () => {
    // Same sentinel, unwrapped.
    const sse = `${sseEnvelope(chunk({ content: "hi", role: "assistant" }))}data: [DONE]\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event for the bare sentinel").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("hi");
  });

  it("rejects an unbounded SSE line and cancels its reader", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(8 * 1024 * 1024)}`));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
    expect(error.error.errorMessage).toMatch(/SSE buffer exceeded/);
    expect(cancelled).toBe(true);
  });

  it("does not start request construction after a pre-abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before request"));
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const events = await consume(
      streamQoder(makeModel(), makeContext(), { apiKey: "fake", signal: controller.signal }),
    );
    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };

    expect(error.error.stopReason).toBe("aborted");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports aborted when the request is cancelled before streaming starts", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;

    const eventsPromise = consume(
      streamQoder(makeModel(), makeContext(), { apiKey: "fake", signal: controller.signal }),
    );
    controller.abort();
    const events = await eventsPromise;

    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
    expect(error.error.stopReason).toBe("aborted");
    expect(events.find((event) => event.type === "done")).toBeUndefined();
  });

  it("aborts an idle SSE response and releases its reader", async () => {
    const originalTimeout = process.env.QODER_STREAM_IDLE_TIMEOUT_MS;
    process.env.QODER_STREAM_IDLE_TIMEOUT_MS = "10";
    try {
      let cancelled = false;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        cancel() {
          cancelled = true;
        },
      });
      globalThis.fetch = vi.fn(async (_input, init) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            bodyController?.error(init.signal?.reason);
          },
          { once: true },
        );
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch;

      const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
      const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
      expect(error.error.errorMessage).toMatch(/idle timeout/);
      expect(cancelled).toBe(true);
    } finally {
      if (originalTimeout === undefined) delete process.env.QODER_STREAM_IDLE_TIMEOUT_MS;
      else process.env.QODER_STREAM_IDLE_TIMEOUT_MS = originalTimeout;
    }
  });

  it("converts leaked DSML content into a tool call", async () => {
    const dsml =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n` +
      `<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const sse =
      sseEnvelope(chunk({ content: dsml.slice(0, 19) })) +
      sseEnvelope(chunk({ content: dsml.slice(19) })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    const toolCall = done.message.content.find((content): content is ToolCall => content.type === "toolCall");

    expect(toolCall).toEqual({
      type: "toolCall",
      id: "dsml_call_0",
      name: "bash",
      arguments: { command: "ls" },
    });
    expect(done.message.content.find((content) => content.type === "text")).toBeUndefined();
    expect(done.message.stopReason).toBe("toolUse");
  });

  it("parses DSML tool markup leaked through reasoning_content", async () => {
    // Some Qoder models dump the whole tool call into the reasoning_content
    // channel. It must become a real tool call, not literal tags inside the
    // thinking block (and any real reasoning ahead of it still shows up).
    const thought = "I should list the files.";
    const dsml =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n` +
      `<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const split = Math.floor(dsml.length / 2);
    const sse =
      sseEnvelope(chunk({ reasoning_content: `${thought}\n\n${dsml.slice(0, split)}` })) +
      sseEnvelope(chunk({ reasoning_content: dsml.slice(split) })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: `${thought}\n\n` },
      { type: "toolCall", id: "dsml_call_0", name: "bash", arguments: { command: "ls" } },
    ]);
    expect(done.message.stopReason).toBe("toolUse");
  });

  it("flushes content thinking before a DSML tool call", async () => {
    const dsml =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n` +
      `<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const sse =
      sseEnvelope(chunk({ content: "<thinking>reason<" })) +
      sseEnvelope(chunk({ content: dsml })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: "reason<" },
      { type: "toolCall", id: "dsml_call_0", name: "bash", arguments: { command: "ls" } },
    ]);
  });

  it("keeps DSML and native tool-call state isolated", async () => {
    const dsml =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n` +
      `<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const sse =
      sseEnvelope(chunk({ content: dsml })) +
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "native_1", function: { name: "search", arguments: '{"q":"x"}' } }],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    const toolCalls = done.message.content.filter((content): content is ToolCall => content.type === "toolCall");

    expect(toolCalls).toEqual([
      { type: "toolCall", id: "dsml_call_0", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "native_1", name: "search", arguments: { q: "x" } },
    ]);
    expect(done.message.stopReason).toBe("toolUse");
  });
});

/**
 * Run identity on the wire (spec CU-05, T-08..T-10).
 *
 * The legacy body is COSY-encoded before it leaves, so it is captured
 * pre-signing through onPayload — the same harness wire-vocabulary.test.ts uses.
 */
describe("run identity on the wire", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearQoderRunRegistry();
    vi.restoreAllMocks();
  });

  function contextWith(messages: unknown[]): TranscriptContext {
    return normalizeContext({ systemPrompt: "test", messages, tools: [] } as unknown as Context);
  }

  /** The raw pi shape the transform consumes for a completed tool round. */
  function imageToolRound(): TranscriptContext {
    return contextWith([
      { role: "user", content: "read the screenshot" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/tmp/shot.png" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "abc123", mimeType: "image/png" },
        ],
      },
    ]);
  }

  /** Capture the pre-signing legacy body once per dispatch. */
  function captureBody(bodies: Record<string, unknown>[]) {
    return (payload: unknown) => {
      bodies.push(payload as Record<string, unknown>);
      return undefined;
    };
  }

  it("continues the run for a tool round that returned an image (T-08/AC-01)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const options = { apiKey: "fake", sessionId: "session-image", onPayload: captureBody(bodies) };

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(
      streamQoder(makeModel("qoder", "Lite"), contextWith([{ role: "user", content: "read the screenshot" }]), options),
    );

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder", "Lite"), imageToolRound(), options));

    expect(bodies, "one captured body per dispatch").toHaveLength(2);
    const prompt = bodies[0];
    const round = bodies[1];
    expect(round.request_set_id, "the image round continues the run").toBe(prompt.request_set_id);
    expect((round.business as { id: string }).id).toBe((prompt.business as { id: string }).id);
    expect((round.business as { begin_at: number }).begin_at).toBe((prompt.business as { begin_at: number }).begin_at);
  });

  it("rotates the run identity across a retry while the cache key stays identical (T-09/AC-05)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const options = { apiKey: "fake", sessionId: "session-retry", onPayload: captureBody(bodies) };

    // Attempt 1 ends in an errored turn.
    globalThis.fetch = mockFetch(sseEnvelope({ error: { message: "upstream boom" } }) + DONE_SSE);
    await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), options));

    // Attempt 2 of the same options: history repair drops the errored assistant
    // turn, so the raw tail is again a fresh user prompt and the run rotates.
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(
      streamQoder(
        makeModel("qoder", "Lite"),
        contextWith([
          { role: "user", content: "hi" },
          { role: "assistant", content: [], stopReason: "error" },
        ]),
        options,
      ),
    );

    expect(bodies, "one captured body per attempt").toHaveLength(2);
    expect(bodies[1].request_set_id, "the retry is billed as its own run").not.toBe(bodies[0].request_set_id);
    expect(bodies[1].session_id, "rotation is cache-neutral").toBe(bodies[0].session_id);
  });

  it("makes one run-identity call per dispatch, visible as the wire stage (T-10/AC-08)", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(
      streamQoder(makeModel("qoder", "Lite"), makeContext(), {
        apiKey: "fake",
        sessionId: "session-stage",
        onPayload: captureBody(bodies),
      }),
    );
    expect((bodies[0].business as { stage: string }).stage, "a run's first request reports start").toBe("start");

    // Self-heal: a v2 dispatch falls back to legacy. v2 resolves its own run
    // identity for metadata.context.request_set_id; the legacy re-dispatch makes
    // its own single call, so the captured legacy body is a fresh "start"
    // rather than a slot v2 had already advanced to "processing".
    clearQoderRunRegistry();
    const selfHealBodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      if (String(input).includes("chat/completions")) {
        return new Response(
          JSON.stringify({ error: { type: "invalid_model_error", message: "model not supported" } }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(SUCCESS_SSE);
    }) as unknown as typeof globalThis.fetch;
    const ultimate = staticModels.find((model) => model.id === "Ultimate");
    if (!ultimate) throw new Error("fixture model missing from static seed: Ultimate");
    await consume(
      streamQoderV2(
        ultimate as Model<Api>,
        makeContext(),
        {
          apiKey: "fake",
          fetch,
          sessionId: "session-heal",
          env: { QODER_FALLBACK: "1" },
          onPayload: captureBody(selfHealBodies),
        } as SimpleStreamOptions,
        { mode: "global", modelConfig: { key: "ultimate" }, upstreamKey: "ultimate" },
      ),
    );
    const legacyBodies = selfHealBodies.filter((body) => "business" in body);
    expect(legacyBodies, "the self-heal produced exactly one legacy body").toHaveLength(1);
    expect((legacyBodies[0].business as { stage: string }).stage, "stage reflects only the legacy dispatch").toBe(
      "start",
    );
  });
});

/**
 * FS-6 T-03 — legacy's text_end is purely additive.
 *
 * The fixture carries text, thinking and a tool call, so every block type the
 * legacy parser owns is in one sequence. The assertions are the pre-change
 * outcomes (final content, block order, stop reason) plus the new event's
 * presence, payload and boundary. Nothing here counts events: legacy coalesces
 * text_delta by design, so a count could only be wrong.
 */
describe("streamQoder closes text blocks additively (FS-6)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("T-03 keeps the message content and block order while adding text_end", async () => {
    const sse =
      sseEnvelope(chunk({ content: "before <thinking>reason</thinking> after" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    // The pre-change outcome: same content, same block order, same tool call.
    expect(done.message.content).toEqual([
      { type: "text", text: "before " },
      { type: "thinking", thinking: "reason" },
      { type: "text", text: " after" },
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
    ]);
    expect(done.message.stopReason).toBe("toolUse");

    // The addition: one text_end per closed block, each carrying the block's
    // full text at the index its text_start opened.
    const textEnds = events.filter(
      (event): event is Extract<AssistantMessageEvent, { type: "text_end" }> => event.type === "text_end",
    );
    expect(textEnds.map((event) => event.contentIndex)).toEqual([0, 2]);
    for (const end of textEnds) {
      const streamed = events
        .filter(
          (event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
            event.type === "text_delta" && event.contentIndex === end.contentIndex,
        )
        .reduce((acc, event) => acc + event.delta, "");
      expect(end.content).toBe(streamed);
    }
    expect(textEnds.at(-1)?.content).toBe(" after");

    // Ordering boundary: the closing event follows its last delta and precedes
    // the terminal. indexOf, not a fixed position.
    const sequence = events.map((event) => event.type);
    const lastEnd = sequence.lastIndexOf("text_end");
    expect(sequence.lastIndexOf("text_delta", lastEnd)).toBeLessThan(lastEnd);
    expect(lastEnd).toBeLessThan(sequence.indexOf("done"));
  });
});

/**
 * The plan seam on the legacy transport (spec fs-qoder-turn-plan CU-04, T-09..T-11).
 *
 * T-09 pins the plan-failure rule through the adapter's existing terminal-error
 * catch; T-10 pins gate parity on the transport carrying all current traffic;
 * T-11 pins the outgoing-key precedence the plan must not flatten.
 */
describe("plan seam on the legacy transport", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** The router's seed shape, built inline so this suite needs no plan-module import. */
  const legacySeed = {
    protocol: "legacy",
    mode: "global",
    upstreamKey: "dfmodel",
    rejectedSamplingKeys: [],
    contextConfig: undefined,
    piSessionId: "session-plan",
    wireSessionV2: { promptCacheKey: "session-plan", envelopeAndHeaders: "session-plan" },
    turnKind: "real",
    capture: { protocol: "legacy", model: "Lite", session: "session-plan" },
    contextLength: undefined,
  } as const;

  /** The ids the run registry rotates per dispatch (OD-5) — not the wire contract under test. */
  function withoutRotationIds(body: Record<string, unknown>): Record<string, unknown> {
    const clone = structuredClone(body);
    for (const key of ["request_id", "request_set_id", "chat_record_id", "business"]) delete clone[key];
    return clone;
  }

  it("T-09 a rejected identity becomes a terminal error event, and result() settles", async () => {
    const { resolveQoderIdentity } = await import("../auth/oauth.js");
    vi.mocked(resolveQoderIdentity).mockRejectedValueOnce(new Error("identity lookup refused"));
    const fetchSpy = vi.fn(async () => {
      throw new Error("the plan rejects before any request is built");
    });

    const stream = streamQoder(
      makeModel(),
      makeContext(),
      { apiKey: "fake", sessionId: "session-plan", fetch: fetchSpy as unknown as typeof fetch },
      legacySeed,
    );
    const events = await consume(stream);
    const terminal = events.at(-1) as { type: string; error: AssistantMessage };
    expect(terminal.type).toBe("error");
    expect(terminal.error.stopReason).toBe("error");
    expect(terminal.error.errorMessage).toContain("identity lookup refused");
    // The host awaits this; an end without a terminal event would leave it pending.
    expect((await stream.result()).stopReason).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("T-10 the legacy body is identical across the gate, session-bearing and session-less alike", async () => {
    const { streamQoderRouter } = await import("../protocol/router.js");
    const model = staticModels.find((candidate) => candidate.id === "DeepSeek-V4-Flash") as Model<Api>;

    for (const sessionId of ["session-gate-parity", undefined]) {
      const bodies: Record<string, unknown>[] = [];
      for (const gate of ["", "1"]) {
        vi.stubEnv("QODER_CORE_PLAN", gate);
        globalThis.fetch = mockFetch(SUCCESS_SSE);
        await consume(
          streamQoderRouter(model, makeContext(), {
            apiKey: "fake",
            sessionId,
            onPayload: (payload: unknown) => {
              bodies.push(withoutRotationIds(payload as Record<string, unknown>));
              return undefined;
            },
          }),
        );
      }
      expect(bodies, `two dispatches for sessionId=${sessionId ?? "(none)"}`).toHaveLength(2);
      expect(bodies[1], `gate parity for sessionId=${sessionId ?? "(none)"}`).toEqual(bodies[0]);
      // The session really is on the wire, so the parity is not vacuous.
      expect(typeof bodies[0].session_id).toBe("string");
    }
  });

  it("T-10 a legacy capture record carries the same wire session id the body did", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readDebugRecords } = await import("./debug-sink.js");
    const dir = mkdtempSync(join(tmpdir(), "qoder-plan-legacy-"));
    process.env.QODER_DEBUG = "1";
    process.env.QODER_DEBUG_DIR = dir;
    process.env.QODER_CORE_PLAN = "1";
    try {
      const { streamQoderRouter } = await import("../protocol/router.js");
      const model = staticModels.find((candidate) => candidate.id === "DeepSeek-V4-Flash") as Model<Api>;
      const bodies: Record<string, unknown>[] = [];
      globalThis.fetch = mockFetch(SUCCESS_SSE);
      await consume(
        streamQoderRouter(model, makeContext(), {
          apiKey: "fake",
          sessionId: "session-capture",
          onPayload: (payload: unknown) => {
            bodies.push(payload as Record<string, unknown>);
            return undefined;
          },
        }),
      );
      // The request record is written before dispatch, so it is on disk already.
      const record = readDebugRecords(dir, "session-capture").find((entry) => entry.type === "request");
      expect(record?.wireSessionId).toBe(bodies[0].session_id);
      expect(record?.wireSessionId).toBe("qoder-session-test-user-dfmodel-session-capture");
    } finally {
      delete process.env.QODER_DEBUG;
      delete process.env.QODER_DEBUG_DIR;
      delete process.env.QODER_CORE_PLAN;
    }
  });

  it("T-11 an onPayload rewrite of model_config.key still decides X-Model-Key", async () => {
    vi.stubEnv("QODER_CORE_PLAN", "1");
    const { streamQoderRouter } = await import("../protocol/router.js");
    const model = staticModels.find((candidate) => candidate.id === "DeepSeek-V4-Flash") as Model<Api>;
    const captured: Record<string, unknown>[] = [];
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (_input: unknown, request?: RequestInit) => {
      init = request;
      return new Response(SUCCESS_SSE, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;

    const result = await streamQoderRouter(model, makeContext(), {
      apiKey: "fake",
      fetch,
      sessionId: "session-model-key",
      onPayload: (payload: unknown) => {
        const body = payload as Record<string, unknown>;
        captured.push(body);
        return { ...body, model_config: { ...(body.model_config as Record<string, unknown>), key: "remapped-key" } };
      },
    }).result();

    expect(result.stopReason).toBe("stop");
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("X-Model-Key")).toBe("remapped-key");
    // The plan's own upstream key and the body's key keep their values.
    expect((captured[0].model_config as { key: string }).key).toBe("dfmodel");
    expect((captured[0].chat_context as { extra: { modelConfig: { key: string } } }).extra.modelConfig.key).toBe(
      "dfmodel",
    );
  });
});

/**
 * The shared stamp tail on the legacy transport (spec qoder-stamp-tail CU-02,
 * T-04/T-05).
 *
 * AC-01's kill evidence lives here: cost is written at the assembly site inside
 * the read loop, so the post-loop toolcall_end frame and every preceding frame
 * are serialized to `--json` already priced. Moving that write into the tail
 * would freeze cost zeros into stdout for every tool-use turn — the in-memory
 * message self-corrects (the frames share the usage object), stdout does not.
 */
describe("stamp tail on the legacy transport", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  /** A tool-use turn whose usage chunk arrives BEFORE the tool deltas. */
  const toolTurnSse =
    sseEnvelope(chunk({ content: "working", role: "assistant" })) +
    sseEnvelope(
      chunk(
        {},
        {
          usage: {
            prompt_tokens: 250_000,
            completion_tokens: 1_000,
            total_tokens: 251_000,
            credits: 100.0,
          },
        },
      ),
    ) +
    sseEnvelope(
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } }] }),
    ) +
    sseEnvelope(finishChunk("tool_calls")) +
    DONE_SSE;

  async function toolTurnEvents(gate: string): Promise<AssistantMessageEvent[]> {
    vi.stubEnv("QODER_CORE_STAMP", gate);
    globalThis.fetch = mockFetch(toolTurnSse);
    return consume(streamQoder(makeModel("qoder", "DeepSeek-V4-Flash"), makeContext(), { apiKey: "fake" }));
  }

  /** The tool turn up to (and including) its finish chunk, without the sentinel. */
  const toolTurnPrefix = toolTurnSse.slice(0, toolTurnSse.length - DONE_SSE.length);

  it("T-04 a tool-use turn's pre-terminal frames carry the priced usage on both gate settings", async () => {
    for (const gate of ["", "1"]) {
      const label = `gate=${gate || "(off)"}`;
      vi.stubEnv("QODER_CORE_STAMP", gate);
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      globalThis.fetch = vi.fn(
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      ) as unknown as typeof fetch;

      const events: AssistantMessageEvent[] = [];
      const task = (async () => {
        for await (const event of streamQoder(makeModel("qoder", "DeepSeek-V4-Flash"), makeContext(), {
          apiKey: "fake",
        })) {
          events.push(event);
        }
      })();
      const encoder = new TextEncoder();
      // Everything except the sentinel, so the body stays open and no terminal
      // exists yet. Only in this window can a terminal-only cost write be
      // distinguished from the in-loop one — after the terminal the shared
      // usage object self-corrects in memory.
      controller.enqueue(encoder.encode(toolTurnPrefix));
      for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));

      const openFrames = events.filter((event) => event.type !== "done" && event.type !== "error");
      expect(openFrames.length, `${label} expected pre-terminal frames while open`).toBeGreaterThan(0);
      const priced = openFrames
        .map((event) => (event as { partial: AssistantMessage }).partial.usage as StoredUsage)
        .filter((usage) => usage.totalTokens > 0);
      expect(priced.length, `${label} expected a priced pre-terminal frame`).toBeGreaterThan(0);
      for (const usage of priced) {
        expect(usage.cost.total, `${label} pre-terminal frame`).toBeCloseTo(1.3333333, 6);
        expect(usage.rateSource, `${label} pre-terminal frame`).toBe("credits");
      }

      // Close the turn: the post-loop toolcall_end and the terminal agree.
      controller.enqueue(encoder.encode(DONE_SSE));
      await task;
      const done = events.find((event) => event.type === "done") as
        | Extract<AssistantMessageEvent, { type: "done" }>
        | undefined;
      const toolEnd = events.find((event) => event.type === "toolcall_end") as
        | Extract<AssistantMessageEvent, { type: "toolcall_end" }>
        | undefined;
      if (!toolEnd || !done) throw new Error(`${label} expected the post-loop toolcall_end and done frames`);
      expect(toolEnd.partial.usage.cost.total).toBeCloseTo(1.3333333, 6);
      expect((toolEnd.partial.usage as StoredUsage).rateSource).toBe("credits");
      expect((done.message.usage as StoredUsage).rateSource).toBe("credits");
    }
  });

  it("T-05 gate off is the pre-migration tail; gate on adds the wrapper without an observable change", async () => {
    const off = await toolTurnEvents("");
    const on = await toolTurnEvents("1");
    expect(on.map((event) => event.type)).toEqual(off.map((event) => event.type));
    const terminalOf = (events: AssistantMessageEvent[]) =>
      (events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message.usage;
    expect(terminalOf(on)).toEqual(terminalOf(off));

    // The same plain fixture under both settings: the ordered event sequence is
    // identical, so the gate is a real off-path, not a behavior fork.
    vi.stubEnv("QODER_CORE_STAMP", "1");
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const wrapped = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(wrapped.at(-1)?.type).toBe("done");
    vi.stubEnv("QODER_CORE_STAMP", "");
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const plain = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(plain.map((event) => event.type)).toEqual(wrapped.map((event) => event.type));
  });
});

/**
 * qoder-warm-attribution (CU-01, T-01/T-02/T-07) — one ledger namespace.
 *
 * The gateway echoes a single constant for every requested model, so the pair pi
 * resolves on a warm row (`responseModel ?? model`, cache-warmer.js:249) and the
 * pair `/session` buckets by (usage-totals.js:47) must both land on the friendly
 * catalog id. T-01/T-02 pin that on the legacy transport; T-07 pins the same
 * namespace on v2, whose wire dispatch uses an upstream key instead.
 */
describe("qoder-warm-attribution: one ledger namespace", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // boundary: `onPayload` hands back the adapter's own outbound body as
  // `unknown`; narrow with a record predicate before reading a field (BND-1),
  // the idiom debug-sink.ts and four production modules already use. No shared
  // export exists to reuse — every copy in this repo is file-local.
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** The exact expression both host consumers resolve a persisted row's key with. */
  const persistedModelKey = (message: AssistantMessage): string => message.responseModel ?? message.model;

  /**
   * invented: a legacy turn in this file's recorded envelope shape, echoing
   * `model` on every chunk (the gateway's real behavior — a constant, not the
   * requested model) and pricing the row on the finish chunk.
   */
  function legacyEchoSse(echoedModel = "auto"): string {
    const usage = {
      prompt_tokens: 42,
      completion_tokens: 7,
      total_tokens: 49,
      prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 10 },
    };
    return (
      sseEnvelope(chunk({ content: "OK", role: "assistant" }, { model: echoedModel })) +
      sseEnvelope(finishChunk("stop", { model: echoedModel, usage })) +
      DONE_SSE
    );
  }

  const doneMessage = (events: AssistantMessageEvent[]): AssistantMessage => {
    const done = events.find((event) => event.type === "done");
    if (!done) throw new Error(`expected a done event, saw: ${events.map((event) => event.type).join(",")}`);
    return (done as { message: AssistantMessage }).message;
  };

  it("T-01/AC-01 leaves responseModel absent on a legacy turn whose chunks echo a model", async () => {
    globalThis.fetch = mockFetch(legacyEchoSse());
    const events = await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), { apiKey: "fake" }));

    const message = doneMessage(events);
    // Absent, not "": pi's stamp is `responseModel ?? model`, and only undefined
    // falls through to the friendly id the legacy closure set at construction.
    expect(message.responseModel).toBeUndefined();
    // The neighbouring captures in the same chunk handler are untouched (AC-05).
    expect(message.responseId).toBe("test-id");
    expect(message.usage.input).toBe(27); // 42 prompt − 5 cached − 10 cache_write
    expect(message.usage.output).toBe(7);
    expect(message.usage.totalTokens).toBe(49);
    expect(message.usage.cacheRead).toBe(5);
    expect(message.usage.cacheWrite).toBe(10);
  });

  it("T-02/AC-03,AC-04 keys the legacy terminal by the requested friendly id, not the echoed value", async () => {
    globalThis.fetch = mockFetch(legacyEchoSse("qmodel_latest"));
    const events = await consume(streamQoder(makeModel("qoder", "Qwen3.7-Max"), makeContext(), { apiKey: "fake" }));

    const message = doneMessage(events);
    expect(message.model).toBe("Qwen3.7-Max");
    expect(message.responseModel).toBeUndefined();
    // The pair pi resolves. A warm row stamped from this message and the
    // assistant rows around it share one key, so pi's miss detector
    // (cache-stats.js:39 against the warm row's :71) cannot report a model
    // switch for a same-model miss.
    expect(persistedModelKey(message)).toBe("Qwen3.7-Max");
  });

  it("T-07/AC-01,AC-02,AC-04 lands one requested model in the same namespace on both transports", async () => {
    const requested = staticModels.find((model) => model.id === "DeepSeek-V4-Flash");
    if (!requested) throw new Error("fixture model missing from static seed: DeepSeek-V4-Flash");
    const model = requested as Model<Api>;
    const upstreamKey = "dfmodel";

    // Legacy: the gateway echoes its constant against a friendly-id request.
    globalThis.fetch = mockFetch(legacyEchoSse());
    const legacyMessage = doneMessage(
      await consume(streamQoder(model, makeContext(), { apiKey: "fake", sessionId: "session-ns" })),
    );

    // v2: an OpenAI-shaped stream echoing the upstream key it dispatched under,
    // so pi-ai's own guard (`chunk.model !== model.id`,
    // openai-completions.js:360-362) is what suppresses responseModel. The
    // outbound body is read through `onPayload`, which receives the built object
    // directly — no second parse of the same payload.
    const v2Bodies: unknown[] = [];
    const v2Urls: string[] = [];
    // invented: OpenAI-shaped chunk trio in the recorded v2 fixture's shape,
    // echoing the upstream key rather than a friendly id.
    const v2Sse = [
      `data: ${JSON.stringify({ id: "x", model: upstreamKey, choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
      `data: ${JSON.stringify({
        id: "x",
        model: upstreamKey,
        choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      })}`,
      "data: [DONE]",
    ].join("\n\n");
    const v2Fetch = vi.fn(async (input: unknown) => {
      v2Urls.push(String(input));
      return new Response(v2Sse, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;
    const v2Message = doneMessage(
      await consume(
        streamQoderV2(
          model,
          makeContext(),
          {
            apiKey: "fake",
            fetch: v2Fetch,
            sessionId: "session-ns",
            onPayload: (payload: unknown) => {
              v2Bodies.push(payload);
              return undefined;
            },
          } as SimpleStreamOptions,
          { mode: "global", modelConfig: { key: upstreamKey }, upstreamKey },
        ),
      ),
    );

    // One model, one namespace: both transports persist the friendly id and
    // neither leaves a competing responseModel for `??` to prefer.
    expect(persistedModelKey(legacyMessage)).toBe("DeepSeek-V4-Flash");
    expect(persistedModelKey(v2Message)).toBe("DeepSeek-V4-Flash");
    expect(legacyMessage.model).toBe(v2Message.model);
    expect(v2Message.responseModel).toBeUndefined();
    // Normalization is a terminal concern only: the v2 wire still dispatches
    // under the upstream key pi-ai was given.
    expect(v2Urls[0]).toContain("chat/completions");
    const dispatchedBody = v2Bodies[0];
    expect(isRecord(dispatchedBody) ? dispatchedBody.model : undefined).toBe(upstreamKey);
  });
});

/**
 * The prefix stamp on the legacy transport (spec CU-03).
 *
 * A cold chain writes NONE of the six keys — that absence is how the ledger
 * represents class 0 — so every stamped row here warms the session's chain with a
 * prior turn first. The registry is module state, hence the reset on both sides.
 */
describe("prefix stamp on the legacy transport (spec CU-03)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => clearPrefixChainRegistry());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearPrefixChainRegistry();
    vi.restoreAllMocks();
  });

  /** A fresh Response per call: one body can only be consumed once, so a multi-turn row needs one each. */
  function freshFetch(body: string): typeof fetch {
    return vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;
  }

  // invented: a second-turn transcript that EXTENDS makeContext()'s single user
  // message, which is what makes the chain stable rather than diverged.
  function extendedContext(): TranscriptContext {
    return normalizeContext({
      systemPrompt: "test",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "and again" },
      ],
      tools: [],
    } as unknown as Context);
  }

  // invented: extendedContext() with the middle message rewritten, so the
  // divergence lands on a known message index.
  function rewrittenContext(): TranscriptContext {
    return normalizeContext({
      systemPrompt: "test",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "REWRITTEN" },
        { role: "user", content: "and again" },
      ],
      tools: [],
    } as unknown as Context);
  }

  function terminalUsage(events: AssistantMessageEvent[]): StoredUsage {
    const terminal = events.find((event) => event.type === "done" || event.type === "error");
    if (!terminal) throw new Error("expected a terminal event");
    const message = terminal.type === "done" ? terminal.message : terminal.error;
    return message.usage as StoredUsage;
  }

  /** Warm the session's chain so the next dispatch on it is not cold. */
  async function warm(sessionId: string, context: TranscriptContext = makeContext()): Promise<void> {
    globalThis.fetch = freshFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel(), context, { apiKey: "fake", sessionId }));
  }

  // spec: T-07 / AC-07 — a first turn in a fresh session carries none of the six.
  it("T-07 leaves a cold first turn unstamped, which is what class 0 means", async () => {
    globalThis.fetch = freshFetch(SUCCESS_SSE);
    const usage = terminalUsage(
      await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", sessionId: "session-cold" })),
    );

    // A cold chain has no predecessor, so it has no divergence verdict to give.
    // Writing the other five anyway would make the census unable to tell a
    // genuinely append-only session from a process that had just started.
    for (const key of [...PREFIX_FIELDS, "prefixDivergedAt"] as const) {
      expect(key in usage, `a cold chain writes no ${key}`).toBe(false);
    }
  });

  // spec: T-07 / AC-01,AC-03 — every legacy terminal carries the six fields.
  it("T-07 stamps all six fields on a done terminal once the chain is warm", async () => {
    await warm("session-done");
    globalThis.fetch = freshFetch(SUCCESS_SSE);
    const usage = terminalUsage(
      await consume(streamQoder(makeModel(), extendedContext(), { apiKey: "fake", sessionId: "session-done" })),
    );

    for (const key of PREFIX_FIELDS) {
      expect(usage[key], `the done terminal carries ${key}`).toBeDefined();
    }
    expect(usage.prefixStable, "the second turn extended the first turn's chain").toBe(true);
    expect(usage.prefixDivergedAt, "an extending turn carries no divergence index").toBeUndefined();
    expect(usage.prefixLen, "a character-scale count, not a message count").toBeGreaterThan(0);
  });

  it("T-07 stamps an error terminal produced after the chain resolved, with the same prefixHash as a done turn", async () => {
    await warm("session-error");

    globalThis.fetch = freshFetch(SUCCESS_SSE);
    const doneUsage = terminalUsage(
      await consume(streamQoder(makeModel(), extendedContext(), { apiKey: "fake", sessionId: "session-error" })),
    );

    globalThis.fetch = freshFetch(BLOCKED_SSE);
    const events = await consume(
      streamQoder(makeModel(), extendedContext(), { apiKey: "fake", sessionId: "session-error" }),
    );
    const errorUsage = terminalUsage(events);

    expect(
      events.find((event) => event.type === "error"),
      "the 406 fixture errors mid-stream",
    ).toBeDefined();
    expect(
      (events.find((event) => event.type === "error") as { error: AssistantMessage }).error.stopReason,
      "and it is an error, not a silent stop",
    ).toBe("error");
    for (const key of PREFIX_FIELDS) {
      expect(errorUsage[key], `the error terminal carries ${key}`).toBeDefined();
    }
    expect(errorUsage.prefixHash, "one transcript, one prefixHash, whatever the terminal").toBe(doneUsage.prefixHash);
  });

  it("T-07 stamps an aborted terminal, because the write precedes every downstream throw site", async () => {
    await warm("session-abort");

    // The abort must land AFTER the chain resolved, or the row is honestly
    // unstamped like any pre-resolution failure. Signalling from inside fetch is
    // what pins that order: the closure cannot reach fetch without having passed
    // the stamp write first.
    let reachedFetch: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      reachedFetch = resolve;
    });
    const controller = new AbortController();
    globalThis.fetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          reachedFetch();
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;

    const pending = consume(
      streamQoder(makeModel(), extendedContext(), {
        apiKey: "fake",
        sessionId: "session-abort",
        signal: controller.signal,
      }),
    );
    await reached;
    controller.abort();
    const events = await pending;
    const usage = terminalUsage(events);

    expect(
      (events.find((event) => event.type === "error") as { error: AssistantMessage }).error.stopReason,
      "the turn was cancelled after the stamp was written",
    ).toBe("aborted");
    for (const key of PREFIX_FIELDS) {
      expect(usage[key], `the aborted terminal carries ${key}`).toBeDefined();
    }
  });

  // spec: T-07 / AC-03 — a rewritten transcript names where it broke.
  it("T-07 marks a rewritten transcript unstable at the message index where it broke", async () => {
    await warm("session-rewrite", extendedContext());

    globalThis.fetch = freshFetch(SUCCESS_SSE);
    const usage = terminalUsage(
      await consume(streamQoder(makeModel(), rewrittenContext(), { apiKey: "fake", sessionId: "session-rewrite" })),
    );

    expect(usage.prefixStable, "the middle message was rewritten, so the prefix broke").toBe(false);
    expect(usage.prefixDivergedAt, "at that message's index in the chained transcript").toBe(1);
  });

  // Ruling Q2 requirement 1's falsifier at the legacy seam: if any per-dispatch
  // value reached the payload view, payloadHash would move every turn and the field
  // would be written, hashed and meaningless.
  it("Q2-R1 holds payloadHash steady across two legacy turns with an unchanged prompt", async () => {
    await warm("session-legacy-steady");

    globalThis.fetch = freshFetch(SUCCESS_SSE);
    const first = terminalUsage(
      await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", sessionId: "session-legacy-steady" })),
    );
    globalThis.fetch = freshFetch(SUCCESS_SSE);
    const second = terminalUsage(
      await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", sessionId: "session-legacy-steady" })),
    );

    // request_id is a fresh UUID and business.id rotates per run, and neither is in
    // the view — which is the whole point of stamping the logical prompt instead of
    // the assembled body.
    expect(second.payloadHash, "an unchanged prompt digests identically turn over turn").toBe(first.payloadHash);
    expect(second.paramsHash, "nor does the sampling view move").toBe(first.paramsHash);
    expect(second.prefixStable, "and the row still reads stable").toBe(true);
  });

  // spec: T-08 / AC-07 — the stamp and the usage-chunk handler coexist on one object.
  it("T-08 carries the full priced usage and all six prefix fields without either overwriting the other", async () => {
    // recorded-from: the envelope and finishChunk shape mirror the live legacy SSE
    // captures (SUCCESS_SSE); the Credits amount is the existing priced-turn row's.
    const priced =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          usage: { prompt_tokens: 250_000, completion_tokens: 1_000, total_tokens: 251_000, credits: 100.0 },
        }),
      ) +
      DONE_SSE;

    globalThis.fetch = freshFetch(priced);
    await consume(
      streamQoder(makeModel("qoder", "DeepSeek-V4-Flash"), makeContext(), {
        apiKey: "fake",
        sessionId: "session-priced",
      }),
    );

    globalThis.fetch = freshFetch(priced);
    const usage = terminalUsage(
      await consume(
        streamQoder(makeModel("qoder", "DeepSeek-V4-Flash"), makeContext(), {
          apiKey: "fake",
          sessionId: "session-priced",
        }),
      ),
    );

    // The usage-chunk handler still owns the token buckets, the cost and the ladder.
    expect(usage.cost.total, "the priced cost is exactly what the existing row asserts").toBeCloseTo(1.3333333, 6);
    expect(usage.rateSource, "and the stamp did not displace the rate source").toBe("credits");
    expect(usage.output, "nor the token buckets").toBe(1_000);
    expect(usage.totalTokens).toBe(251_000);
    // Beside all six prefix fields on the same object.
    for (const key of PREFIX_FIELDS) {
      expect(usage[key], `the priced terminal still carries ${key}`).toBeDefined();
    }
    expect(usage.prefixStable, "the same transcript again, so the chain held").toBe(true);
  });
});
