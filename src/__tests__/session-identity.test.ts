import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache, staticModels } from "../catalog.js";
import { streamQoderRouter } from "../protocol/router.js";
import { clearQoderFallbackCache, clearQoderRoutingMemCache } from "../protocol/routing.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";
import { MAX_PROMPT_CACHE_KEY_LENGTH } from "../protocol/stream.js";

/**
 * AC-04 — the two protocols' session-id wire forms, pinned as they DIVERGE today.
 *
 * This is a cross-protocol fact, so it belongs in neither protocol's suite.
 * FS-4 replaces both derivations with TurnPlan.wireSession and must therefore
 * INVERT the session-less row: what is asserted here as an asymmetry is the
 * thing the migration unifies. Pinning it as today's behaviour is what makes
 * that unification an observed inversion rather than a silent one — including
 * the direction it moves in, which carries OD-6's accepted consequence (two
 * session-less dispatches that today mint two run-scoping keys start sharing
 * one, merging billing runs and gaining affinity).
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
  const found = staticModels.find((model) => model.id === id);
  if (!found) throw new Error(`fixture model missing from static seed: ${id}`);
  return found as Model<Api>;
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

  // T-11 (legacy half): today's per-request uuid. FS-4 unifies this, so the row
  // is written to be inverted — it asserts the divergence, not the desired state.
  it("legacy mints a DIFFERENT session_id on each session-less dispatch, over a stable hash prefix", async () => {
    const first = await legacySessionId({ apiKey: "fake" });
    const second = await legacySessionId({ apiKey: "fake" });

    // stableHash("qoder-session", userID, qoderModel) — identical across both,
    // because the hash input carries no session component.
    const prefix = "b047787bc4afc9f3-";
    expect(first.startsWith(prefix)).toBe(true);
    expect(second.startsWith(prefix)).toBe(true);

    // The suffix is a fresh crypto.randomUUID() per request (stream.ts:263), so
    // two dispatches of one session-less turn carry two run-scoping keys.
    expect(first).not.toBe(second);
    const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(first.slice(prefix.length)).toMatch(uuidShape);
    expect(second.slice(prefix.length)).toMatch(uuidShape);
  });

  // T-11 (v2 half): the other side of the asymmetry.
  it("v2 reuses ONE per-process session_id across session-less dispatches", async () => {
    const first = await v2SessionFields({ apiKey: "fake" });
    const second = await v2SessionFields({ apiKey: "fake" });

    // processFallbackSessionId is a module-level uuid (v2.ts:58): stable across
    // turns of the process with no identity dependency.
    expect(first.promptCacheKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second.promptCacheKey).toBe(first.promptCacheKey);
    expect(first.envelopeSessionId).toBe(first.promptCacheKey);
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
