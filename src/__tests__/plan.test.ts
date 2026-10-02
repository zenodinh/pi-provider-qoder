import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

    expect(plan.affinity.placements.legacy).toEqual(["session_id"]);
    expect(plan.affinity.placements.v2).toEqual(["prompt_cache_key", "header-x-session-id", "envelope-session-id"]);
    // affinityPlacementGated holds v2's probe-gated legacy placement; it is never
    // merged, so no unprobed prompt_cache_key reaches the legacy wire (AC-05).
    expect(plan.affinity.placements.legacy).not.toContain("prompt_cache_key");
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
