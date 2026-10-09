import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache } from "../catalog.ts";
import { streamQoderRouter } from "../protocol/router.js";
import { clearQoderFallbackCache, clearQoderRoutingMemCache } from "../protocol/routing.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";
import { MAX_PROMPT_CACHE_KEY_LENGTH } from "../protocol/session-key.js";
import { fixtureModel } from "./model-fixture.ts";

/**
 * AC-04 — the two protocols' session-id wire forms.
 *
 * This is a cross-protocol fact, so it belongs in neither protocol's suite.
 * FS-1 pinned the two protocols' forms as they diverged; FS-4 replaced both
 * derivations with TurnPlan.wireSession and INVERTED the session-less row
 * (OD-6, owner-decided 2026-10-02): what used to be a fresh run-scoping uuid
 * per request on legacy versus one per-process value on v2 is now one shared
 * per-process id on both, which merges session-less legacy turns into one
 * billing run per mode and model and gives them cache affinity. The readable /
 * bounded / clamped forms below stay exactly as recorded.
 *
 * Every literal below was RECORDED from a live capture of the real transports
 * under a fixed identity (userID "user", upstream key "dfmodel"), not recomputed
 * from the derivation. Recomputing would reproduce a changed hash-input order
 * and so could never catch one.
 */

const SYSTEM_PROMPT = "You are a coding assistant.";
const context = normalizeContext({
  systemPrompt: SYSTEM_PROMPT,
  messages: [{ role: "user", content: "read a file" }],
  tools: [],
} as unknown as Context);

/** 75 characters: past the 64-char prompt_cache_key bound, so both forms show. */
const LONG_SESSION_ID = "session-that-is-deliberately-longer-than-the-64-char-prompt-cache-key-bound";
const SHORT_SESSION_ID = "short-session";

function modelNamed(id: string): Model<Api> {
  return fixtureModel(id);
}

const cachePath = () => join(process.env.HOME as string, ".pi", "agent", "qoder-models-cache.json");

/** Seed the catalog so the legacy key resolves to upstream key "dfmodel". */
function seedLegacyKey(): void {
  writeFileSync(
    cachePath(),
    JSON.stringify({
      updatedAt: Date.now(),
      models: [],
      configs: {
        "DeepSeek-V4-Flash": {
          key: "dfmodel",
          enable: true,
          display_name: "DeepSeek-V4-Flash",
          is_reasoning: true,
          thinking_config: { enabled: { efforts: { low: {}, high: {}, max: {} } } },
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

/** Drive the legacy transport and return the pre-signing body's session_id. */
async function legacySessionId(options: SimpleStreamOptions): Promise<string> {
  seedLegacyKey();
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
  const sessionId = captured.session_id;
  if (typeof sessionId !== "string") throw new Error(`expected a string session_id, got ${typeof sessionId}`);
  return sessionId;
}

interface V2Capture {
  promptCacheKey: string;
  envelopeSessionId: string;
  sourceSessionId: string;
  headerNames: string[];
}

/** Drive the v2 transport and return the session-bearing wire fields. */
async function v2SessionFields(options: SimpleStreamOptions): Promise<V2Capture> {
  let body: Record<string, unknown> | undefined;
  let headerNames: string[] = [];
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    // boundary: the v2 body is JSON this test itself asked pi-ai to serialize,
    // and pi-ai hands headers as a Headers instance rather than a plain record
    // (the legacy path hands a plain record) — so narrow both instead of casting.
    const raw: unknown = JSON.parse(String(init?.body));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("expected the v2 request body to be a JSON object");
    }
    body = raw as Record<string, unknown>;
    headerNames =
      init?.headers instanceof Headers
        ? [...init.headers.keys()]
        : Object.keys((init?.headers ?? {}) as Record<string, string>);
    return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;

  // v2 is opt-in since 2026-10-09, and these rows are about the v2 transport's
  // identity fields, so the request states the flag itself.
  vi.stubEnv("QODER_PROTOCOL", "v2");
  const result = await streamQoderRouter(modelNamed("Ultimate"), context, { ...options, fetch }).result();
  expect(result.stopReason).toBe("stop");
  if (!body) throw new Error("expected the v2 transport to receive a request body");

  const metadata: unknown = body.metadata;
  const contextBlock =
    typeof metadata === "object" && metadata !== null && "context" in metadata
      ? (metadata as { context: Record<string, unknown> }).context
      : undefined;
  if (!contextBlock) throw new Error("expected the v2 body to carry metadata.context");

  const read = (value: unknown, field: string): string => {
    if (typeof value !== "string") throw new Error(`expected ${field} to be a string, got ${typeof value}`);
    return value;
  };
  return {
    promptCacheKey: read(body.prompt_cache_key, "prompt_cache_key"),
    envelopeSessionId: read(contextBlock.session_id, "metadata.context.session_id"),
    sourceSessionId: read(contextBlock.source_session_id, "metadata.context.source_session_id"),
    headerNames: headerNames.map((name) => name.toLowerCase()).sort(),
  };
}

beforeEach(() => {
  // A fixed userID makes the hash input deterministic, so the recorded literals
  // below stay valid across runs.
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

describe("wire session forms (AC-04)", () => {
  // T-10: legacy's two session-id forms, including which input order feeds the hash.
  it("legacy sends the readable session_id when it fits in 64 and a stableHash form when it does not", async () => {
    expect(LONG_SESSION_ID.length).toBeGreaterThan(MAX_PROMPT_CACHE_KEY_LENGTH);

    // Readable form: `qoder-session-{userID}-{qoderModel}-{sessionId}`.
    const readable = await legacySessionId({ apiKey: "fake", sessionId: SHORT_SESSION_ID });
    expect(readable).toBe("qoder-session-user-dfmodel-short-session");
    expect(readable.length).toBeLessThanOrEqual(MAX_PROMPT_CACHE_KEY_LENGTH);

    // Hashed form: `qoder-session-{stableHash("qoder-session", userID, qoderModel, sessionId)}`.
    // The 16-hex digest is pinned as recorded, so a change to the prefix, the
    // input ORDER or the algorithm is a red row — recomputing it here would
    // reproduce any of the three and catch none.
    const hashed = await legacySessionId({ apiKey: "fake", sessionId: LONG_SESSION_ID });
    expect(hashed).toBe("qoder-session-8fb8783e053d017c");
    expect(hashed.length).toBeLessThanOrEqual(MAX_PROMPT_CACHE_KEY_LENGTH);
    expect(hashed).not.toBe(readable);
  });

  // T-11 (legacy half): OD-6 inverted today's per-request uuid. The gate is left
  // unset here on purpose: the unified per-process fallback is what the inline
  // (pre-migration) derivation produces too, which is what keeps the legacy body
  // byte-identical across the QODER_CORE_PLAN settings (T-10).
  it("legacy reuses ONE per-process session_id across session-less dispatches", async () => {
    const first = await legacySessionId({ apiKey: "fake" });
    const second = await legacySessionId({ apiKey: "fake" });

    // stable across dispatches of the process, unlike the fresh uuid each
    // request used to mint (stream.ts:263 before FS-4).
    expect(first).toBe(second);
    const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(first).toMatch(uuidShape);
  });

  // T-11 (v2 half): the same unified value, so a session-less legacy turn and a
  // session-less v2 turn key the identical run and the identical prompt cache.
  it("v2 reuses ONE per-process session_id across session-less dispatches, shared with legacy", async () => {
    const first = await v2SessionFields({ apiKey: "fake" });
    const second = await v2SessionFields({ apiKey: "fake" });

    // processFallbackSessionId is now plan.ts's PROCESS_FALLBACK_SESSION_ID: one
    // value per process, the same one legacy sends for a session-less turn.
    expect(first.promptCacheKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second.promptCacheKey).toBe(first.promptCacheKey);
    expect(first.envelopeSessionId).toBe(first.promptCacheKey);
    expect(await legacySessionId({ apiKey: "fake" })).toBe(first.promptCacheKey);
  });

  // T-11 / AC-04: the clamp split, and the affinity trio legacy does not send.
  it("v2 clamps only prompt_cache_key while its envelope carries the unclamped value, and sends the affinity trio", async () => {
    const captured = await v2SessionFields({ apiKey: "fake", sessionId: LONG_SESSION_ID });

    // prompt_cache_key is TRUNCATED to the 64-char bound — v2 clamps, it does
    // not hash, so the bounded key is a prefix of the readable session id.
    expect(captured.promptCacheKey).toBe(LONG_SESSION_ID.slice(0, MAX_PROMPT_CACHE_KEY_LENGTH));
    expect(captured.promptCacheKey).toBe("session-that-is-deliberately-longer-than-the-64-char-prompt-cach");
    expect(captured.promptCacheKey.length).toBe(MAX_PROMPT_CACHE_KEY_LENGTH);

    // The envelope is NOT clamped: both fields carry all 75 characters on the
    // same request that carried the 64-char key. That is the split FS-4 closes.
    expect(captured.envelopeSessionId).toBe(LONG_SESSION_ID);
    expect(captured.sourceSessionId).toBe(LONG_SESSION_ID);
    expect(captured.envelopeSessionId.length).toBeGreaterThan(MAX_PROMPT_CACHE_KEY_LENGTH);

    // The affinity trio CU-02 pins as ABSENT from legacy is present here, on the
    // same request — read off the Headers instance pi-ai hands the transport.
    for (const name of ["session_id", "x-client-request-id", "x-session-affinity"]) {
      expect(captured.headerNames, `v2 must send the ${name} header`).toContain(name);
    }
  });
});
