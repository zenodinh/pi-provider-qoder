import { type Api, type Model, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache, staticCnModels } from "../catalog.ts";
import { resolveProtocol, streamQoderRouter } from "../protocol/router.js";
import {
  clearQoderFallbackCache,
  clearQoderRoutingMemCache,
  isMarkedLegacyOnly,
  markLegacyOnly,
} from "../protocol/routing.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";
import { fixtureModel } from "./model-fixture.ts";

// Counting seam for T-08's second clause (AC-07): with byte-identical bodies the
// gate's only remaining observable effect is whether the plan is produced at
// all, so the producer's two entry points are wrapped with pass-through spies.
vi.mock("../protocol/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../protocol/plan.js")>();
  return {
    ...actual,
    planQoderTurn: vi.fn(actual.planQoderTurn),
    planSyncProjection: vi.fn(actual.planSyncProjection),
  };
});

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function modelNamed(id: string): Model<Api> {
  return fixtureModel(id);
}

function envelope(inner: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
}
const legacySuccess = `${envelope({ choices: [{ delta: { content: "OK" } }] })}data: [DONE]\n\n`;
const v2Success = [
  `data: ${JSON.stringify({ id: "x", model: "qmodel", choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
  `data: ${JSON.stringify({ id: "x", model: "qmodel", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
  "data: [DONE]",
].join("\n\n");

beforeEach(() => {
  // Neutralize any developer-shell QODER_PROTOCOL so this suite asserts the
  // shipped default routing, not the local override (hermeticity, PUB).
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
});

describe("resolveProtocol", () => {
  it("sends every key to legacy unless v2 was asked for, and reports why by source", () => {
    // Owner decision 2026-10-09: legacy is the default for every key, so v2 needs
    // the flag. `source` still separates a known-legacy key from an unknown one,
    // which is the whole content of the routing debug line.
    expect(resolveProtocol("qmodel", "global")).toEqual({ protocol: "legacy", source: "default" });
    expect(resolveProtocol("dfmodel", "global")).toEqual({ protocol: "legacy", source: "routing-data" });
    expect(resolveProtocol("lite", "global")).toEqual({ protocol: "legacy", source: "default" });
  });

  it("honors QODER_PROTOCOL over everything, and gates the v2 opt-in on eligibility", () => {
    expect(resolveProtocol("qmodel", "global", { env: { QODER_PROTOCOL: "legacy" } } as SimpleStreamOptions)).toEqual({
      protocol: "legacy",
      source: "env",
    });
    // Requested and proven: the only path to v2.
    expect(resolveProtocol("qmodel", "global", { env: { QODER_PROTOCOL: "v2" } } as SimpleStreamOptions)).toEqual({
      protocol: "v2",
      source: "env",
    });
    // Requested but unproven: the flag is a request, not a capability grant.
    expect(resolveProtocol("dfmodel", "global", { env: { QODER_PROTOCOL: "v2" } } as SimpleStreamOptions)).toEqual({
      protocol: "legacy",
      source: "default",
    });
  });

  it("keeps cn on legacy, and needs both a v2 host and the opt-in to leave it", () => {
    expect(resolveProtocol("qmodel", "cn")).toEqual({ protocol: "legacy", source: "env" });
    // A declared v2 host is not an opt-in by itself: the transport default decides.
    expect(
      resolveProtocol("qmodel", "cn", {
        env: { QODER_MODEL_SERVER_HOST: "https://api2-v2.qoder.sh" },
      } as SimpleStreamOptions),
    ).toEqual({
      protocol: "legacy",
      source: "default",
    });
    expect(
      resolveProtocol("qmodel", "cn", {
        env: { QODER_MODEL_SERVER_HOST: "https://api2-v2.qoder.sh", QODER_PROTOCOL: "v2" },
      } as SimpleStreamOptions),
    ).toEqual({
      protocol: "v2",
      source: "env",
    });
  });

  it("reads the self-heal session cache before the table", () => {
    markLegacyOnly("qmodel");
    expect(resolveProtocol("qmodel", "global")).toEqual({ protocol: "legacy", source: "fallback-cache" });
  });
});

describe("streamQoderRouter", () => {
  it("sends a legacy-only key to the COSY gateway", async () => {
    let url: unknown;
    const fetch = vi.fn(async (input: unknown) => {
      url = input;
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("DeepSeek-V4-Flash"), context, {
      apiKey: "fake",
      fetch,
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(String(url)).toContain("agent_chat_generation");
  });

  it("sends an opted-in v2 key to the model-server and drops rejected sampling keys", async () => {
    let url: unknown;
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      url = input;
      body = JSON.parse(String(init?.body));
      return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-1",
      samplingParams: { presence_penalty: 0.5, temperature: 0.7 },
      env: { QODER_PROTOCOL: "v2" },
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("stop");
    expect(String(url)).toBe("https://api2-v2.qoder.sh/model/v1/chat/completions");
    expect(body).toBeDefined();
    expect("presence_penalty" in (body as object)).toBe(false);
    expect(body?.temperature).toBe(0.7);
  });

  it("forces legacy via QODER_PROTOCOL even for a v2-eligible key", async () => {
    let url: unknown;
    const fetch = vi.fn(async (input: unknown) => {
      url = input;
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_PROTOCOL: "legacy" },
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("stop");
    expect(String(url)).toContain("agent_chat_generation");
  });

  it("routes a key marked legacy-only by the self-heal straight to legacy", async () => {
    markLegacyOnly("ultimate");
    let url: unknown;
    const fetch = vi.fn(async (input: unknown) => {
      url = input;
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    await streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch }).result();
    expect(String(url)).toContain("agent_chat_generation");
    expect(isMarkedLegacyOnly("ultimate")).toBe(true);
  });

  /**
   * T-14 / AC-07 — the combination nothing pinned before: QODER_PROTOCOL=v2
   * forcing v2 in cn mode with no QODER_MODEL_SERVER_HOST. resolveProtocol
   * honours the env override over the cn-legacy rule (router.ts:30-33), so the
   * dispatch reaches streamQoderV2, whose v2BaseUrl returns "" for cn without an
   * override (v2.ts:34-40) and whose allowlist guard rejects it with errorStream
   * before any fetch (v2.ts:44-54, :258-260).
   *
   * This is the class PRD §8.2's outbound allowlist exists to stop: a request to
   * an empty or non-Qoder host. FS-4 moves the mode derivation into TurnPlan and
   * must keep this boundary terminal — the plan is computed after the guard, so a
   * rejected host never triggers identity resolution.
   */
  it("terminates at the outbound allowlist with zero network when v2 is forced in cn mode", async () => {
    vi.stubEnv("QODER_PROTOCOL", "v2");
    // Explicit, even though setup.ts scrubs the QODER_* family: the combination
    // under test is "forced v2 AND no host override", and naming the second half
    // keeps the row honest if the scrub is ever narrowed.
    delete process.env.QODER_MODEL_SERVER_HOST;

    // A cn-provider model from the CN static seed, so getCachedModelConfig
    // resolves in cn mode. This matters: were it unresolved, router.ts:52-56
    // falls back to legacy BEFORE resolveProtocol is consulted, the allowlist is
    // never reached, and the spy below would fire — so the row fails loudly
    // rather than passing for the wrong reason.
    const cnModel = staticCnModels.find((model) => model.id === "Qwen3.7-Plus");
    if (!cnModel) throw new Error("fixture model missing from the cn static seed: Qwen3.7-Plus");
    expect(cnModel.provider).toBe("qoder-cn");

    // The spy throws if invoked, making an accidental dispatch a loud failure
    // instead of a network attempt. Kept as the vi.fn type (not cast to
    // `typeof globalThis.fetch` at declaration) so `.mock` stays readable.
    const fetchSpy = vi.fn(async () => {
      throw new Error("the allowlist guard must reject before any dispatch");
    });
    const fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const result = await streamQoderRouter(cnModel as Model<Api>, context, { apiKey: "fake", fetch }).result();

    expect(result.stopReason).toBe("error");
    // Exact instance: the rendered text names the allowlist and the empty host.
    expect(result.errorMessage).toBe("Qoder v2 host rejected by the outbound allowlist: (empty)");
    // Zero network, and therefore no request body built or serialized.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls).toEqual([]);
  });
});

/**
 * The plan seam at the registered entry (spec fs-qoder-turn-plan CU-03,
 * T-07/T-08).
 *
 * T-07 pins the one thing an async router would break silently: the host's warm
 * path calls `.result()` directly on what streamSimple returns. T-08 pins the
 * gate as a real rollback — same body, same filter position, either setting.
 */
describe("the plan seam keeps the registered entry synchronous (T-07/T-08)", () => {
  afterEach(() => {
    vi.doUnmock("../auth/oauth.js");
    vi.resetModules();
  });

  /** A per-protocol fixture fetch, so one row can drive both transports. */
  function bothProtocols(): { urls: string[]; fetch: typeof globalThis.fetch } {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("chat/completions")) {
        return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    return { urls, fetch };
  }

  /** The ids the run registry rotates per dispatch (OD-5) — not part of the wire contract under test. */
  function withoutRotationIds(body: Record<string, unknown>): Record<string, unknown> {
    const clone = structuredClone(body);
    for (const key of ["request_id", "request_set_id", "chat_record_id", "business"]) delete clone[key];
    const metadata = clone.metadata as { context?: Record<string, unknown> } | undefined;
    if (metadata?.context) {
      delete metadata.context.request_id;
      delete metadata.context.request_set_id;
    }
    return clone;
  }

  it("T-07 returns a stream with a callable .result, never a thenable, on both gates and protocols", async () => {
    for (const gate of ["", "1"]) {
      vi.stubEnv("QODER_CORE_PLAN", gate);
      for (const modelId of ["DeepSeek-V4-Flash", "Ultimate"]) {
        const { fetch } = bothProtocols();
        const returned = streamQoderRouter(modelNamed(modelId), context, { apiKey: "fake", fetch });
        // A promise would pass `await` here and only fail on the host's warm path.
        expect(returned, `${modelId} gate=${gate || "off"} must not be a promise`).not.toBeInstanceOf(Promise);
        expect(typeof (returned as { then?: unknown }).then).toBe("undefined");
        expect(typeof returned.result).toBe("function");
        expect((await returned.result()).stopReason).toBe("stop");
      }
    }
  });

  it("T-08 gate off and gate on produce the same body on both protocols, with the filter still applied", async () => {
    for (const modelId of ["DeepSeek-V4-Flash", "Ultimate"]) {
      const bodies = new Map<string, Record<string, unknown>>();
      for (const gate of ["", "1"]) {
        vi.stubEnv("QODER_CORE_PLAN", gate);
        let captured: Record<string, unknown> | undefined;
        const fixtureFetch = bothProtocols().fetch;
        const spying = vi.fn(async (input: unknown, init?: RequestInit) => {
          if (String(input).includes("chat/completions")) captured = JSON.parse(String(init?.body));
          return fixtureFetch(input as RequestInfo, init);
        }) as typeof globalThis.fetch;
        await streamQoderRouter(
          { ...modelNamed(modelId), samplingParams: { presence_penalty: 0.5, temperature: 0.7 } },
          context,
          {
            apiKey: "fake",
            fetch: spying,
            sessionId: "session-gate",
            samplingParams: { presence_penalty: 0.5, temperature: 0.7 },
            onPayload: (payload: unknown) => {
              captured = payload as Record<string, unknown>;
              return undefined;
            },
          },
        ).result();
        expect(captured).toBeDefined();
        bodies.set(gate, withoutRotationIds(captured as Record<string, unknown>));
        // AC-09: the rejected key never reaches either wire.
        expect("presence_penalty" in (captured as Record<string, unknown>)).toBe(false);
      }
      expect(bodies.get("1"), `${modelId}: gate on matches gate off`).toEqual(bodies.get(""));
    }
  });

  it("T-08 with the gate unset no plan work happens; with it set the seed is produced", async () => {
    // A fresh registry so the counting plan mock reaches every importer in the
    // graph (plan.ts, stream.ts and v2.ts sit in one cycle), plus a resolved
    // identity so neither dispatch needs the network.
    vi.doMock("../auth/oauth.js", () => ({
      resolveQoderIdentity: vi.fn().mockResolvedValue({
        access: "fake",
        refresh: "",
        expires: 0,
        userID: "user",
        name: "Test",
        email: "test@example.com",
        machineID: "machine",
      }),
    }));
    vi.resetModules();
    const planModule = await import("../protocol/plan.js");
    const { streamQoderRouter: freshRouter } = await import("../protocol/router.js");
    const projectionSpy = vi.mocked(planModule.planSyncProjection);
    const planSpy = vi.mocked(planModule.planQoderTurn);
    const { fetch } = bothProtocols();
    const model = modelNamed("DeepSeek-V4-Flash");

    vi.stubEnv("QODER_CORE_PLAN", "");
    projectionSpy.mockClear();
    planSpy.mockClear();
    await freshRouter(model, context, { apiKey: "fake", fetch }).result();
    expect(projectionSpy, "no seed is built with the gate off").not.toHaveBeenCalled();
    expect(planSpy, "no plan is produced with the gate off").not.toHaveBeenCalled();

    vi.stubEnv("QODER_CORE_PLAN", "1");
    await freshRouter(model, context, { apiKey: "fake", fetch }).result();
    expect(projectionSpy, "the sync seed is built with the gate on").toHaveBeenCalledTimes(1);
    expect(planSpy, "the adapter awaits one plan with the gate on").toHaveBeenCalledTimes(1);
  });

  it("T-08 a fail-fast dispatch exits before the sampling filter", async () => {
    vi.stubEnv("QODER_CORE_PLAN", "1");
    const unknown = {
      ...modelNamed("DeepSeek-V4-Flash"),
      id: "no-such-model",
      samplingParams: { presence_penalty: 0.5 },
    };
    const { fetch } = bothProtocols();
    const result = await streamQoderRouter(unknown, context, { apiKey: "fake", fetch }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Unknown Qoder model id");
    // The filter never ran, so the key the sampling guard would have dropped is still there.
    expect(unknown.samplingParams.presence_penalty).toBe(0.5);
  });
});
