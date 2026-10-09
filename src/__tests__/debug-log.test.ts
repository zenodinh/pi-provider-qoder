// Debug-mode capture (QODER_DEBUG=1): per-session JSONL of requests,
// responses, and debugLog records — file sink only, never console/TUI.
// Behavior spec (SPEC-1..4, owner directive 2026-10-02):
//   SPEC-1 legacy streamQoder + debug on -> <dir>/<session>.jsonl holds a
//          request record (logical body, auth headers redacted, X-Model-Key
//          visible) and a response record (status 200, raw SSE incl [DONE]).
//   SPEC-2 debug off -> no file, stream behavior unchanged.
//   SPEC-3 streamQoderRouter -> debugLog records ("provider.request ...") land
//          in the session file; console.error is never called.
//   SPEC-4 v2 route -> request record body carries prompt_cache_key and the
//          affinity headers are captured; response record carries the SSE.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessageEvent, Context, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQoderModelsMemCache } from "../catalog.ts";
import { capText, createDebugFetch, redactHeadersForDebug, writeDebugRecord } from "../debug-log.js";
import { streamQoderRouter } from "../protocol/router.js";
import { clearQoderFallbackCache, clearQoderRoutingMemCache } from "../protocol/routing.js";
import { streamQoder } from "../protocol/stream.js";
import { readDebugRecords } from "./debug-sink.js";
import { loadLiveFixture } from "./live-fixture.js";
import { fixtureModel } from "./model-fixture.ts";

// Same identity pin as stream.test.ts: the mocked fetch must only ever serve
// the chat request, so /userinfo is short-circuited at the module boundary.
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

// Partial catalog mock: the router needs a keyed config for "Lite" without a
// seeded cache file; every other id falls through to the real implementation
// (which reads the seeded cache for "Ultimate" in the v2 test).
vi.mock("../catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../catalog.js")>();
  return {
    ...actual,
    getCachedModelConfig: (id: string, mode: never) =>
      id === "Lite" ? { key: "qmodel", source: "system" } : actual.getCachedModelConfig(id, mode),
  };
});

// recorded-from: live Qoder global gateway SSE capture bundled as the repo's
// live fixture (src/__fixtures__, loaded via loadLiveFixture("global")).
const SUCCESS_SSE = loadLiveFixture("global").interactions.chat.response.body as string;

// invented: mirrors the OpenAI-style v2 SSE shape pinned by src/__tests__/v2.test.ts
// (delta chunk, finish+usage chunk, [DONE] sentinel).
const V2_SUCCESS_SSE = [
  `data: ${JSON.stringify({ id: "x", model: "ultimate", choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
  `data: ${JSON.stringify({ id: "x", model: "ultimate", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
  "data: [DONE]",
].join("\n\n");

// invented: legacy-envelope shape (statusCodeValue/body wrapper) as recorded in
// the live fixture above; only the inner payload is synthesized.
const LEGACY_SUCCESS_SSE = `data:${JSON.stringify({
  headers: { "Content-Type": ["application/json"] },
  body: JSON.stringify({ choices: [{ delta: { content: "OK" }, index: 0 }], id: "t", model: "auto" }),
  statusCodeValue: 200,
  statusCode: "OK",
})}\n\ndata:${JSON.stringify({
  headers: { "Content-Type": ["application/json"] },
  body: "[DONE]",
  statusCodeValue: 200,
  statusCode: "OK",
})}\n\n`;

function mockFetch(body: string): typeof fetch {
  return vi.fn(
    async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  ) as unknown as typeof fetch;
}

function v2FetchCapture(): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("chat/completions")) {
      return new Response(V2_SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(LEGACY_SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

function makeModel(id: string): Model<Api> {
  return { id, api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
}

// Full static entry (v2.test convention): pi-ai reads fields (input modalities,
// compat) a bare {id,api,provider} cast does not carry.
function staticModelNamed(id: string): Model<Api> {
  return fixtureModel(id);
}

function makeContext(): TranscriptContext {
  return normalizeContext({
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context);
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// boundary: JSONL sink reading lives in the shared debug-sink helper (BND-1).

let tmpHome: string;
let debugDir: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "qoder-debug-test-"));
  debugDir = join(tmpHome, "dbg");
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpHome, "agent"));
  vi.stubEnv("QODER_DEBUG_DIR", debugDir);
  vi.stubEnv("QODER_PROTOCOL", "");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  clearQoderRoutingMemCache();
  clearQoderFallbackCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  errSpy.mockRestore();
  clearQoderRoutingMemCache();
  clearQoderFallbackCache();
  clearQoderModelsMemCache();
});

describe("debug-mode capture (QODER_DEBUG)", () => {
  it("SPEC-1: legacy turn writes request + response records to the session file, console silent", async () => {
    vi.stubEnv("QODER_DEBUG", "1");
    await drain(
      streamQoder(makeModel("Lite"), makeContext(), {
        apiKey: "fake",
        fetch: mockFetch(SUCCESS_SSE),
        sessionId: "sess-t1",
      }),
    );
    // response record lands via the serialized write chain (async tee read)
    await vi.waitFor(() => {
      expect(readDebugRecords(debugDir, "sess-t1").some((r) => r.type === "response")).toBe(true);
    });
    const records = readDebugRecords(debugDir, "sess-t1");
    const req = records.find((r) => r.type === "request");
    const res = records.find((r) => r.type === "response");
    expect(req?.protocol).toBe("legacy");
    const headers = req?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^<redacted \d+ chars>$/);
    expect(headers["cosy-key"]).toMatch(/^<redacted \d+ chars>$/);
    expect(typeof headers["x-model-key"]).toBe("string");
    const body = String(req?.body);
    expect(body).toContain('"session_id"');
    expect(body).not.toContain("fake"); // apiKey never lands in the legacy body
    expect(res?.status).toBe(200);
    expect(String(res?.sse)).toContain("[DONE]");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("SPEC-2: debug off writes nothing and the stream still completes", async () => {
    vi.stubEnv("QODER_DEBUG", "");
    const events = await drain(
      streamQoder(makeModel("Lite"), makeContext(), {
        apiKey: "fake",
        fetch: mockFetch(SUCCESS_SSE),
        sessionId: "sess-t2",
      }),
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(existsSync(join(debugDir, "sess-t2.jsonl"))).toBe(false);
  });

  it("SPEC-3: router routes debugLog records to the session file, console silent", async () => {
    vi.stubEnv("QODER_DEBUG", "1");
    await drain(
      streamQoderRouter(makeModel("Lite"), makeContext(), {
        apiKey: "fake",
        fetch: mockFetch(SUCCESS_SSE),
        sessionId: "sess-t3",
        env: { QODER_PROTOCOL: "legacy" },
      }),
    );
    await vi.waitFor(() => {
      expect(readDebugRecords(debugDir, "sess-t3").some((r) => r.type === "debug")).toBe(true);
    });
    const dbg = readDebugRecords(debugDir, "sess-t3").find((r) => r.type === "debug");
    expect(String(dbg?.message).startsWith("provider.request model_key=qmodel protocol=legacy")).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("SPEC-4: v2 route captures prompt_cache_key, affinity headers, and the response SSE", async () => {
    vi.stubEnv("QODER_DEBUG", "1");
    // Seed the catalog cache the real getCachedModelConfig reads for "Ultimate".
    // Path source: getPiAgentDir() — the PI_CODING_AGENT_DIR stub owns it here.
    const cacheDir = join(tmpHome, "agent");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "qoder-models-cache.json"),
      JSON.stringify({
        updatedAt: Date.now(),
        models: [],
        configs: {
          Ultimate: {
            key: "ultimate",
            enable: true,
            display_name: "Ultimate",
            context_config: { "200K": { token_count: 200_000, is_default: true } },
          },
        },
      }),
      "utf8",
    );
    clearQoderModelsMemCache();
    // v2 is opt-in since 2026-10-09; this row is about the v2 debug records.
    vi.stubEnv("QODER_PROTOCOL", "v2");
    const events = await drain(
      streamQoderRouter(staticModelNamed("Ultimate"), makeContext(), {
        apiKey: "fake",
        fetch: v2FetchCapture(),
        sessionId: "sess-t4",
      }),
    );
    let records: Record<string, unknown>[] = [];
    try {
      await vi.waitFor(() => {
        records = readDebugRecords(debugDir, "sess-t4");
        expect(records.some((r) => r.type === "response")).toBe(true);
      });
    } catch (error) {
      // Diagnostic surface for a route miss: which protocol ran, which files exist.
      process.stdout.write(
        `SPEC4-DEBUG files=${JSON.stringify(existsSync(debugDir) ? readdirSync(debugDir) : [])} ` +
          `records=${JSON.stringify(records.map((r) => [r.type, r.protocol]))} ` +
          `events=${JSON.stringify(events.map((e) => (e.type === "error" ? e : e.type))).slice(0, 600)}\n`,
      );
      throw error;
    }
    const req = records.find((r) => r.type === "request" && r.protocol === "v2");
    const res = records.find((r) => r.type === "response" && r.protocol === "v2");
    expect(String(req?.body)).toContain("prompt_cache_key");
    const headers = req?.headers as Record<string, string>;
    expect(headers["x-session-affinity"]).toBe("sess-t4");
    expect(headers.session_id).toBe("sess-t4");
    expect(res?.status).toBe(200);
    expect(String(res?.sse)).toContain("[DONE]");
    expect(errSpy).not.toHaveBeenCalled();
  });
});

// Unit coverage of the sink's configuration branches. These enter through the
// module's exported API (the same functions the transports call); the
// end-to-end surface is locked by SPEC-1..4 above.
describe("debug sink configuration", () => {
  it("redacts auth-bearing headers by default and includes them verbatim with QODER_DEBUG_HEADERS=1", () => {
    const redacted = redactHeadersForDebug({ authorization: "Bearer secret", "x-model-key": "kmodel" });
    expect(redacted.authorization).toMatch(/^<redacted \d+ chars>$/);
    expect(redacted["x-model-key"]).toBe("kmodel");
    vi.stubEnv("QODER_DEBUG_HEADERS", "1");
    const full = redactHeadersForDebug({ authorization: "Bearer secret" });
    expect(full.authorization).toBe("Bearer secret");
    // boundary: a malformed HeadersInit yields an empty map, never a throw
    expect(redactHeadersForDebug("not-headers" as unknown as HeadersInit)).toEqual({});
  });

  it("caps record text at QODER_DEBUG_MAX_BYTES with a truncated flag", () => {
    expect(capText("short")).toEqual({ text: "short", truncated: false });
    vi.stubEnv("QODER_DEBUG_MAX_BYTES", "4");
    expect(capText("abcdefgh")).toEqual({ text: "abcd", truncated: true });
    // boundary: blank/negative values fall back to the default, never to 0
    vi.stubEnv("QODER_DEBUG_MAX_BYTES", "");
    expect(capText("abcdefgh").truncated).toBe(false);
    vi.stubEnv("QODER_DEBUG_MAX_BYTES", "-3");
    expect(capText("abcdefgh").truncated).toBe(false);
  });

  it("prunes to QODER_DEBUG_KEEP session files, oldest first", () => {
    vi.stubEnv("QODER_DEBUG", "1");
    vi.stubEnv("QODER_DEBUG_KEEP", "2");
    const old = new Date(Date.now() - 60_000);
    writeDebugRecord("s-old", { type: "debug", message: "1" });
    utimesSync(join(debugDir, "s-old.jsonl"), old, old);
    writeDebugRecord("s-mid", { type: "debug", message: "2" });
    writeDebugRecord("s-new", { type: "debug", message: "3" });
    expect(existsSync(join(debugDir, "s-old.jsonl"))).toBe(false);
    expect(existsSync(join(debugDir, "s-mid.jsonl"))).toBe(true);
    expect(existsSync(join(debugDir, "s-new.jsonl"))).toBe(true);
  });

  it("defaults to <piAgentDir>/logs/qoder-debug without QODER_DEBUG_DIR", () => {
    vi.stubEnv("QODER_DEBUG", "1");
    vi.stubEnv("QODER_DEBUG_DIR", "");
    writeDebugRecord("s-default", { type: "debug", message: "here" });
    const expected = join(tmpHome, "agent", "logs", "qoder-debug", "s-default.jsonl");
    expect(existsSync(expected)).toBe(true);
  });

  it("never throws when the sink directory is unwritable (fail-soft contract)", () => {
    vi.stubEnv("QODER_DEBUG", "1");
    const blocker = join(tmpHome, "blocker");
    writeFileSync(blocker, "file, not a directory");
    vi.stubEnv("QODER_DEBUG_DIR", join(blocker, "sub"));
    expect(() => writeDebugRecord("s-broken", { type: "debug", message: "lost" })).not.toThrow();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("captures Uint8Array request bodies and body-less responses via the fetch wrapper", async () => {
    vi.stubEnv("QODER_DEBUG", "1");
    const wrapped = createDebugFetch((async () => new Response(null, { status: 204 })) as unknown as typeof fetch, {
      protocol: "v2",
      session: "sess-unit",
    });
    const response = await wrapped("https://example.test/chat/completions", {
      method: "POST",
      body: new TextEncoder().encode('{"ping":1}'),
    });
    expect(response.status).toBe(204);
    await vi.waitFor(() => {
      expect(readDebugRecords(debugDir, "sess-unit").some((r) => r.type === "response")).toBe(true);
    });
    const records = readDebugRecords(debugDir, "sess-unit");
    const req = records.find((r) => r.type === "request");
    expect(req?.body).toBe('{"ping":1}');
    const res = records.find((r) => r.type === "response");
    expect(res?.status).toBe(204);
    expect(res?.sse).toBeUndefined();
  });
});

/**
 * The unified capture field (spec fs-qoder-turn-plan CU-07, T-16/AC-01, AC-04):
 * both transports' response records carry the session id that went on the wire,
 * and absence stays absence.
 */
describe("wireSessionId on the response records", () => {
  it("T-16 writes it into both response branches and omits the key when the meta has none", async () => {
    vi.stubEnv("QODER_DEBUG", "1");

    // REWRITTEN by spec qoder-capture-neutrality CU-01. This movement used to
    // drive createDebugFetch alone with a body-ful Response and assert the tee'd
    // record. The wrapper no longer forks a body, so a streamed response record
    // is written at the transport seam where the accumulation now happens (S3).
    // Legacy's meta carries no wireSessionId, so absent stays absent — the
    // relocation must not invent the field on a body-ful capture.
    await drain(
      streamQoder(makeModel("Lite"), makeContext(), {
        apiKey: "fake",
        fetch: mockFetch(SUCCESS_SSE),
        sessionId: "sess-wire-legacy",
      }),
    );
    await vi.waitFor(() => {
      expect(readDebugRecords(debugDir, "sess-wire-legacy").some((r) => r.type === "response")).toBe(true);
    });
    const legacyRecord = readDebugRecords(debugDir, "sess-wire-legacy").find((r) => r.type === "response") as Record<
      string,
      unknown
    >;
    expect(typeof legacyRecord.sse).toBe("string");
    expect("wireSessionId" in legacyRecord).toBe(false);

    const bodyless = createDebugFetch(async () => new Response(null, { status: 204 }), {
      protocol: "v2",
      session: "sess-wire-empty",
      wireSessionId: "wire-empty",
    });
    await bodyless("https://example.test/chat/completions", { method: "POST" });
    await vi.waitFor(() => {
      expect(readDebugRecords(debugDir, "sess-wire-empty").some((r) => r.type === "response")).toBe(true);
    });
    expect(readDebugRecords(debugDir, "sess-wire-empty").find((r) => r.type === "response")?.wireSessionId).toBe(
      "wire-empty",
    );

    // No invented values: a record written without the field must not carry the key at all.
    const noId = createDebugFetch(async () => new Response(null, { status: 204 }), {
      protocol: "v2",
      session: "sess-wire-absent",
    });
    await noId("https://example.test/chat/completions", { method: "POST" });
    await vi.waitFor(() => {
      expect(readDebugRecords(debugDir, "sess-wire-absent").some((r) => r.type === "response")).toBe(true);
    });
    const record = readDebugRecords(debugDir, "sess-wire-absent").find((r) => r.type === "response") as Record<
      string,
      unknown
    >;
    expect("wireSessionId" in record).toBe(false);
  });

  it("T-16 a v2 dispatch captures the same session id its body carried", async () => {
    vi.stubEnv("QODER_DEBUG", "1");
    vi.stubEnv("QODER_CORE_PLAN", "1");
    const cacheDir = join(tmpHome, "agent");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "qoder-models-cache.json"),
      JSON.stringify({
        updatedAt: Date.now(),
        models: [],
        configs: {
          Ultimate: {
            key: "ultimate",
            enable: true,
            display_name: "Ultimate",
            context_config: { "200K": { token_count: 200_000, is_default: true } },
          },
        },
      }),
      "utf8",
    );
    clearQoderModelsMemCache();
    // v2 is opt-in since 2026-10-09; this row pins the v2 wire capture end to end.
    vi.stubEnv("QODER_PROTOCOL", "v2");

    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("chat/completions")) bodies.push(JSON.parse(String(init?.body)));
      return new Response(V2_SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;
    await drain(
      streamQoderRouter(staticModelNamed("Ultimate"), makeContext(), {
        apiKey: "fake",
        fetch,
        sessionId: "sess-wire-e2e",
      }),
    );

    await vi.waitFor(() => {
      expect(readDebugRecords(debugDir, "sess-wire-e2e").some((r) => r.type === "response")).toBe(true);
    });
    const metadata = bodies[0]?.metadata as { context: Record<string, unknown> } | undefined;
    const response = readDebugRecords(debugDir, "sess-wire-e2e").find((r) => r.type === "response");
    expect(response?.wireSessionId).toBe(metadata?.context.session_id);
    expect(response?.wireSessionId).toBe("sess-wire-e2e");
    expect(errSpy).not.toHaveBeenCalled();
  });
});

/**
 * Spec qoder-capture-neutrality T-01 (AC-01, AC-02, AC-08).
 *
 * The one claim that cannot be made at a transport seam: the wrapped fetch hands
 * back the inner fetch's OWN Response object, so the body reaches the transport
 * unlocked and unconsumed. This is the exact perturbation BUG-0009 recorded —
 * the wrapper tee'd the body, which locked it, and returned a re-wrapped
 * Response, which lost the identity `onResponse` and teardown rely on.
 */
describe("createDebugFetch response neutrality (T-01)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the inner fetch's own Response, unlocked, unconsumed and still readable", async () => {
    vi.stubEnv("QODER_DEBUG", "1");
    // invented: a two-event SSE body — enough to prove the caller can still read
    // it to completion after the wrapper has observed the request.
    const body = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    let produced: Response | undefined;
    const inner = vi.fn(async () => {
      produced = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      return produced;
    });
    // AC-01's "no tee() call occurs", witnessed directly rather than inferred
    // from the lock state alone.
    const tee = vi.spyOn(ReadableStream.prototype, "tee");

    const wrapped = createDebugFetch(inner as unknown as typeof fetch, {
      protocol: "v2",
      session: "sess-t01",
      wireSessionId: "wire-t01",
    });
    const response = await wrapped("https://example.test/chat/completions", { method: "POST", body: "{}" });

    expect(response).toBe(produced);
    expect(response.body?.locked).toBe(false);
    expect(response.bodyUsed).toBe(false);
    expect(tee).not.toHaveBeenCalled();
    // The caller — the transport — can still consume the whole body.
    expect(await response.text()).toBe(body);

    // AC-08: the request half is untouched. A body-ful response writes no record
    // here, because that record now belongs to the consumer-side read.
    await vi.waitFor(() => {
      expect(readDebugRecords(debugDir, "sess-t01").some((r) => r.type === "request")).toBe(true);
    });
    expect(readDebugRecords(debugDir, "sess-t01").filter((r) => r.type === "response")).toHaveLength(0);
  });
});

/**
 * Spec qoder-capture-neutrality T-06 (AC-07, CU-05) — structural.
 *
 * The module header is where the next reader looks first, and a stale "the
 * wrapper tees the response" claim is how the fork gets reintroduced. Asserted
 * the way retry-docs.test.ts asserts documentation against the code it
 * describes: the source is read as text, not executed.
 */
describe("debug-log header names the consumer-side capture sites (T-06)", () => {
  const source = readFileSync(new URL("../debug-log.ts", import.meta.url), "utf8");

  it("names both capture sites and no longer describes a tee-and-re-wrap", () => {
    expect(source).toContain("CONSUMER-SIDE");
    expect(source).toContain("createResponseCapture");
    expect(source).toContain("protocol/stream.ts");
    expect(source).toContain("protocol/sse-reframe.ts");
    // The defect's own two mechanisms must be absent from the wrapper.
    expect(source).not.toContain("body.tee()");
    expect(source).not.toContain("new Response(main");
  });
});
