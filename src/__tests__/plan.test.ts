import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveQoderIdentity } from "../auth/oauth.js";
import { clearQoderModelsMemCache, staticModels } from "../catalog.js";
import {
  type PlanRoute,
  PROCESS_FALLBACK_SESSION_ID,
  planQoderTurn,
  planSyncProjection,
  qoderModeFor,
  resolveUpstreamKey,
} from "../protocol/plan.js";
import { streamQoderRouter } from "../protocol/router.js";
import { clearQoderFallbackCache, clearQoderRoutingMemCache } from "../protocol/routing.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";
import { QODER_WIRE_COMPAT } from "../protocol/wire-compat.js";

/**
 * The plan producer (spec fs-qoder-turn-plan CU-01/CU-02, T-01..T-06).
 *
 * The wire-compat table and the run-identity module stay real — they are pure —
 * while the identity resolver is injected so no row touches the network or
 * auth.json. The three identity variants the spec names (fixed, rejecting, and
 * a fixed one used as an invocation counter) are built per row.
 */

const context = normalizeContext({
  systemPrompt: "test",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
} as unknown as Context);

const cachePath = () => join(process.env.HOME as string, ".pi", "agent", "qoder-models-cache.json");

function modelNamed(id: string): Model<Api> {
  const found = staticModels.find((model) => model.id === id);
  if (!found) throw new Error(`fixture model missing from static seed: ${id}`);
  return found as Model<Api>;
}

/** A fixed identity plus the invocation log T-04 counts. */
function identityStub() {
  const calls: string[] = [];
  const resolveIdentity: typeof resolveQoderIdentity = async (_accessToken, providerID, mode) => {
    calls.push(`${providerID}:${mode}`);
    return { userID: "user", email: "test@example.com", name: "Test", machineID: "machine" };
  };
  return { calls, resolveIdentity };
}

const REJECTED_KEYS = ["presence_penalty", "frequency_penalty", "seed"];

function route(overrides: Partial<PlanRoute> = {}): PlanRoute {
  return {
    protocol: "legacy",
    mode: "global",
    upstreamKey: "dfmodel",
    rejectedSamplingKeys: REJECTED_KEYS,
    contextConfig: undefined,
    ...overrides,
  };
}

/** Seed the live-cache shape the catalog reads, per the wire-vocabulary seedCache precedent. */
function seedCache(configs: Record<string, unknown>): void {
  writeFileSync(cachePath(), JSON.stringify({ updatedAt: Date.now(), models: [], configs }), "utf8");
  clearQoderModelsMemCache();
}

beforeEach(() => {
  clearQoderModelsMemCache();
});

afterEach(() => {
  clearQoderModelsMemCache();
  clearQoderFallbackCache();
  clearQoderRoutingMemCache();
  clearQoderFilterMemCache();
});

describe("planQoderTurn", () => {
  // T-01 / AC-04: OD-6 — one per-process fallback for session-less turns.
  it("T-01 session-less turns share one per-process wire id on both protocols", async () => {
    const { resolveIdentity } = identityStub();
    const options = { apiKey: "fake" };
    const first = await planQoderTurn(modelNamed("DeepSeek-V4-Flash"), context, options, route(), { resolveIdentity });
    const second = await planQoderTurn(modelNamed("DeepSeek-V4-Flash"), context, options, route(), { resolveIdentity });
    const v2 = planSyncProjection(modelNamed("Ultimate"), options, route({ protocol: "v2", upstreamKey: "ultimate" }));

    expect(first.wireSession.legacy).toBe(second.wireSession.legacy);
    expect(first.wireSession.legacy).toBe(PROCESS_FALLBACK_SESSION_ID);
    // The value v2's projection produces for the same session-less options.
    expect(v2.wireSessionV2.envelopeAndHeaders).toBe(first.wireSession.legacy);
  });

  // T-02 / AC-01, AC-05: placements come from the live row; the gated row adds nothing.
  it("T-02 affinity placements are the wire-compat live row only", async () => {
    const { resolveIdentity } = identityStub();
    const plan = await planQoderTurn(
      modelNamed("DeepSeek-V4-Flash"),
      context,
      { apiKey: "fake", sessionId: "session-affinity" },
      route(),
      { resolveIdentity },
    );

    expect(plan.affinity.placements.legacy).toEqual(["session_id", "prompt_cache_key", "header-x-session-id"]); // both carriers promoted 2026-10-05
    expect(plan.affinity.placements.v2).toEqual(["prompt_cache_key", "header-x-session-id", "envelope-session-id"]);
    // Both legacy carriers were promoted 2026-10-05, so the gated row holds
    // nothing for legacy; the AC-05 absence is pinned by the demotion rows in
    // wire-vocabulary.test.ts (a demoted clone un-sends each carrier).
    expect(plan.affinity.promptCacheKey).toBe("qoder-session-user-dfmodel-session-affinity");
  });

  // T-03 / AC-06: the per-carrier policy is table-driven, not hardcoded.
  it("T-03 a changed wire-compat row changes the produced legacy wire value", async () => {
    const { resolveIdentity } = identityStub();
    const sessionId = "s".repeat(80);
    const options = { apiKey: "fake", sessionId };
    const hashed = await planQoderTurn(modelNamed("DeepSeek-V4-Flash"), context, options, route(), { resolveIdentity });
    expect(hashed.wireSession.legacy).toMatch(/^qoder-session-[0-9a-f]{16}$/);

    // A cloned table whose legacy bound policy reads clamp — plan.ts unchanged.
    const table = structuredClone(QODER_WIRE_COMPAT);
    table.sessionKeyBoundPolicy = ["legacy:clamp", "v2:clamp"];
    const clamped = await planQoderTurn(modelNamed("DeepSeek-V4-Flash"), context, options, route(), {
      resolveIdentity,
      table,
    });
    expect(clamped.wireSession.legacy).toBe(`qoder-session-user-dfmodel-${sessionId}`.slice(0, 64));
    expect(clamped.wireSession.legacy).not.toBe(hashed.wireSession.legacy);
  });

  // T-04 / AC-10: identity is legacy-local and at most once per dispatch.
  it("T-04 identity is resolved only for the legacy wire form, once per dispatch", async () => {
    const { calls, resolveIdentity } = identityStub();

    const v2 = await planQoderTurn(modelNamed("Ultimate"), context, { apiKey: "fake" }, route({ protocol: "v2" }), {
      resolveIdentity,
    });
    expect(calls, "a v2-routed plan performs no identity lookup").toHaveLength(0);
    expect(v2.wireSession.legacy).toBe(PROCESS_FALLBACK_SESSION_ID);

    // A warm memo: the resolver still sees exactly one call per legacy dispatch.
    await planQoderTurn(modelNamed("DeepSeek-V4-Flash"), context, { apiKey: "fake" }, route(), { resolveIdentity });
    expect(calls).toHaveLength(1);
    await planQoderTurn(modelNamed("DeepSeek-V4-Flash"), context, { apiKey: "fake" }, route(), { resolveIdentity });
    expect(calls).toHaveLength(2);

    // The pure projection cannot reach the resolver at all.
    planSyncProjection(modelNamed("DeepSeek-V4-Flash"), { apiKey: "fake" }, route());
    expect(calls).toHaveLength(2);
  });

  // T-05 / AC-01: the two producers are one derivation, compared field by field.
  it("T-05 the sync projection agrees with the awaited plan field by field", async () => {
    const { resolveIdentity } = identityStub();
    const options = {
      apiKey: "fake",
      sessionId: "session-projection",
      maxTokens: 1,
      reasoning: "high" as const,
      thinkingBudgets: { high: 4096 },
    };
    const planRoute = route({ protocol: "v2", upstreamKey: "ultimate" });
    const projection = planSyncProjection(modelNamed("Ultimate"), options, planRoute);
    const plan = await planQoderTurn(modelNamed("Ultimate"), context, options, planRoute, { resolveIdentity });

    expect(projection.mode).toBe(plan.mode);
    expect(projection.upstreamKey).toBe(plan.upstreamKey);
    expect(projection.piSessionId).toBe(plan.piSessionId);
    expect(projection.wireSessionV2).toEqual(plan.wireSession.v2);
    expect(projection.turnKind).toBe(plan.turnKind);
    expect(projection.capture.protocol).toBe(plan.capture.protocol);
    expect(projection.capture.model).toBe(plan.capture.model);
    expect(projection.capture.session).toBe(plan.capture.session);
    // The host's cache-warmer literal is classified once, by the run-identity module.
    expect(projection.turnKind).toBe("warm");
    expect(plan.thinkingInputs).toEqual({ level: "high", budgets: { high: 4096 } });
  });

  // T-06 / AC-01: the shared derivations preserve today's mapping and fail-fast.
  it("T-06 the shared derivations preserve the provider mapping and the fail-fast", () => {
    expect(qoderModeFor("qoder-cn")).toBe("cn");
    expect(qoderModeFor("qoder")).toBe("global");
    expect(qoderModeFor("anything-else")).toBe("global");

    seedCache({
      "Plan-Test-Model": { key: "pmodel", enable: true, display_name: "Plan-Test-Model" },
    });
    expect(resolveUpstreamKey("Plan-Test-Model", "global")).toMatchObject({ key: "pmodel" });
    expect(resolveUpstreamKey("Plan-Test-Model", "global")?.entry.display_name).toBe("Plan-Test-Model");
    // An id the catalog never declared is undefined — never an invented key.
    expect(resolveUpstreamKey("no-such-model-id", "global")).toBeUndefined();
    expect(resolveUpstreamKey("no-such-model-id", "cn")).toBeUndefined();
  });
});

/**
 * The context tier joins the plan (spec fs-qoder-context-window-plan CU-02/CU-03,
 * T-02/T-03). One resolution per dispatch, identical on both surfaces, with the
 * tiers handed to the plan by the router rather than looked up twice.
 */
describe("contextLength on the plan", () => {
  // invented: the tier set the v2 wire-capture fixture seeds — 200K is_default,
  // 400K, 1M — so the plan rows and the wire rows hold one fixture set.
  const TIERS = {
    "200K": { token_count: 200_000, is_default: true },
    "400K": { token_count: 400_000 },
    "1M": { token_count: 1_000_000 },
  } as const;

  function tieredRoute(): PlanRoute {
    return route({ contextConfig: TIERS });
  }

  // T-02 / AC-02, AC-03: one resolution, identical on both surfaces.
  it("T-02 resolves the tier once and carries it identically on both plan surfaces", async () => {
    const { resolveIdentity } = identityStub();
    const model = { ...modelNamed("Ultimate"), contextWindow: 1_000_000 } as Model<Api>;
    const planRoute = tieredRoute();
    const projection = planSyncProjection(model, { apiKey: "fake" }, planRoute);
    const plan = await planQoderTurn(model, context, { apiKey: "fake" }, planRoute, { resolveIdentity });

    expect(projection.contextLength).toBe(1_000_000);
    expect(plan.contextLength).toBe(1_000_000);
    expect(plan.contextLength).toBe(projection.contextLength);
  });

  it("T-02 a window matching no tier yields the is_default tier on both surfaces", async () => {
    const { resolveIdentity } = identityStub();
    const mismatched = { ...modelNamed("Ultimate"), contextWindow: 123_456 } as Model<Api>;
    const planRoute = tieredRoute();
    const projection = planSyncProjection(mismatched, { apiKey: "fake" }, planRoute);
    const plan = await planQoderTurn(mismatched, context, { apiKey: "fake" }, planRoute, { resolveIdentity });

    // AC-03: the catalog default tier, never the largest advertised one.
    expect(projection.contextLength).toBe(200_000);
    expect(plan.contextLength).toBe(200_000);
  });

  it("T-02 a model with no context_config carries its window unchanged on both surfaces", async () => {
    const { resolveIdentity } = identityStub();
    const model = { ...modelNamed("Ultimate"), contextWindow: 123_456 } as Model<Api>;
    const planRoute = route(); // contextConfig: undefined
    const projection = planSyncProjection(model, { apiKey: "fake" }, planRoute);
    const plan = await planQoderTurn(model, context, { apiKey: "fake" }, planRoute, {
      resolveIdentity,
    });

    // No tier table: the model's own window governs, exactly as v2 did.
    expect(projection.contextLength).toBe(123_456);
    expect(plan.contextLength).toBe(123_456);
  });

  it("T-02 a tier table with no default marked resolves undefined on both surfaces", async () => {
    const { resolveIdentity } = identityStub();
    const model = { ...modelNamed("Ultimate"), contextWindow: 123_456 } as Model<Api>;
    const planRoute = route({
      contextConfig: { "200K": { token_count: 200_000 }, "1M": { token_count: 1_000_000 } },
    });
    const projection = planSyncProjection(model, { apiKey: "fake" }, planRoute);
    const plan = await planQoderTurn(model, context, { apiKey: "fake" }, planRoute, {
      resolveIdentity,
    });

    // Undefined stays undefined — never zero, never the largest tier.
    expect(projection.contextLength).toBeUndefined();
    expect(plan.contextLength).toBeUndefined();
  });

  // T-03 / AC-02: the router hands the plan the tiers it already resolved.
  // Observed end-to-end with the gate on and a MISMATCHED window, because a
  // route that dropped contextConfig would pass the raw window through and
  // emit 123456 — only the route's tiers can produce the 200000 default here.
  it("T-03 the router route carries the catalog entry's context_config into the plan", async () => {
    seedCache({
      Ultimate: {
        key: "ultimate",
        enable: true,
        display_name: "Ultimate",
        context_config: TIERS,
      },
    });
    const mismatched = { ...modelNamed("Ultimate"), contextWindow: 123_456 } as Model<Api>;
    // invented: the minimal OpenAI-shaped SSE trio v2 needs to complete a turn.
    const v2Success = [
      `data: ${JSON.stringify({ id: "x", model: "ultimate", choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
      `data: ${JSON.stringify({ id: "x", model: "ultimate", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
      "data: [DONE]",
    ].join("\n\n");
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;

    await streamQoderRouter(mismatched, context, {
      apiKey: "fake",
      fetch,
      sessionId: "sess-tiers",
      env: { QODER_PROTOCOL: "v2", QODER_CORE_PLAN: "1" },
    } as SimpleStreamOptions).result();

    // The is_default tier, not the raw window: proof the plan resolved from the
    // route's tiers rather than a lookup that could disagree with them.
    expect(bodies[0]?.context_length).toBe(200_000);
  });
});
