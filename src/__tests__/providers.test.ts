import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerScan, LifetimeProfile } from "../lifetime.js";

const patEnvNames = [
  "QODER_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODERCN_API_KEY",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
] as const;
const originalPats = Object.fromEntries(patEnvNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of patEnvNames) {
    const value = originalPats[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  vi.doUnmock("@earendil-works/pi-ai/compat");
  vi.doUnmock("../host-seam.js");
  vi.resetModules();
});

function liteModel(provider: "qoder" | "qoder-cn") {
  return {
    id: "Lite",
    name: "Lite",
    api: "qoder-api",
    provider,
    baseUrl: provider === "qoder-cn" ? "https://gateway.qoder.com.cn/" : "https://api3.qoder.sh/",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 131072,
  };
}

describe("provider region binding", () => {
  it("binds qoder to global and qoder-cn to CN", async () => {
    for (const name of patEnvNames) delete process.env[name];
    const providers = new Map<string, Record<string, unknown>>();
    const pi = {
      registerProvider(providerID: string, config: Record<string, unknown>) {
        providers.set(providerID, config);
      },
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    const { default: registerProviders } = await import("../index.js");
    await registerProviders(pi as never);

    expect(providers.get("qoder")?.baseUrl).toBe("https://api3.qoder.sh/");
    expect(providers.get("qoder-cn")?.baseUrl).toBe("https://gateway.qoder.com.cn/");

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            userQuota: { total: 100, used: 1, remaining: 99, percentage: 1, unit: "requests" },
            // live shape reports `cap`, not `total` (recorded 2026-09-28).
            orgResourcePackage: { used: 0, remaining: 0, percentage: 0, unit: "requests", cap: 0 },
            totalUsagePercentage: 1,
            isQuotaExceeded: false,
            expiresAt: Date.now() + 3600_000,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const credentials: OAuthCredentials = { access: "test-token", refresh: "", expires: Date.now() + 3600_000 };
    const globalOAuth = providers.get("qoder")?.oauth as {
      fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
    };
    const cnOAuth = providers.get("qoder-cn")?.oauth as {
      fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
    };

    await globalOAuth.fetchUsage(credentials);
    expect(fetchMock).toHaveBeenLastCalledWith("https://openapi.qoder.sh/api/v2/quota/usage", expect.any(Object));

    await cnOAuth.fetchUsage(credentials);
    expect(fetchMock).toHaveBeenLastCalledWith("https://openapi.qoder.com.cn/api/v2/quota/usage", expect.any(Object));
  });
});

describe("qoder-api registry", () => {
  it("registers qoder-api so global streamSimple works for both regions", async () => {
    for (const name of patEnvNames) delete process.env[name];

    const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat");
    const registerSpy = vi.fn((...args: Parameters<typeof actual.registerApiProvider>) => {
      return actual.registerApiProvider(...args);
    });
    vi.doMock("@earendil-works/pi-ai/compat", () => ({
      ...actual,
      registerApiProvider: registerSpy,
    }));

    const { getApiProvider, streamSimple, unregisterApiProviders } = await import("@earendil-works/pi-ai/compat");
    const { default: registerProviders } = await import("../index.js");
    // Node caches node_modules ESM, so a prior test in this file may already
    // have registered qoder-api. Drop that entry before asserting the empty state.
    unregisterApiProviders("provider:qoder");
    const emptyContext = { systemPrompt: "", messages: [] };

    expect(getApiProvider("qoder-api")).toBeUndefined();
    expect(() => streamSimple(liteModel("qoder") as never, emptyContext)).toThrow(
      /No API provider registered for api: qoder-api/,
    );

    const providers = new Map<string, Record<string, unknown>>();
    const registerProvider = vi.fn((providerID: string, config: Record<string, unknown>) => {
      providers.set(providerID, config);
    });
    const pi = {
      registerProvider,
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    await registerProviders(pi as never);

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(providers.has("qoder")).toBe(true);
    expect(providers.has("qoder-cn")).toBe(true);
    expect(providers.get("qoder")?.api).toBe("qoder-api");
    expect(providers.get("qoder-cn")?.api).toBe("qoder-api");
    expect(typeof providers.get("qoder")?.streamSimple).toBe("function");
    expect(typeof providers.get("qoder-cn")?.streamSimple).toBe("function");

    expect(getApiProvider("qoder-api")).toBeDefined();
    expect(() => streamSimple(liteModel("qoder") as never, emptyContext)).not.toThrow(
      /No API provider registered for api: qoder-api/,
    );
    expect(() => streamSimple(liteModel("qoder-cn") as never, emptyContext)).not.toThrow(
      /No API provider registered for api: qoder-api/,
    );
  });

  it("still registers providers when registerApiProvider is absent (OMP-style)", async () => {
    for (const name of patEnvNames) delete process.env[name];

    vi.doMock("@earendil-works/pi-ai/compat", () => ({
      // OMP bundled pi-ai/compat does not export registerApiProvider.
    }));
    // Not the seam's typeof guard: vitest's factory-mock proxy throws on a key the
    // factory omits, so this row reaches host-seam.ts's catch branch — the same one
    // the pre-seam index.ts:70-78 read took. The absent-export branch (typeof guard)
    // is witnessed directly in host-seam.test.ts, T-01.

    const { default: registerProviders } = await import("../index.js");

    const providers = new Map<string, Record<string, unknown>>();
    const registerProvider = vi.fn((providerID: string, config: Record<string, unknown>) => {
      providers.set(providerID, config);
    });
    const pi = {
      registerProvider,
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    await expect(registerProviders(pi as never)).resolves.toBeUndefined();

    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(providers.has("qoder")).toBe(true);
    expect(providers.has("qoder-cn")).toBe(true);
    expect(providers.get("qoder")?.api).toBe("qoder-api");
    expect(providers.get("qoder-cn")?.api).toBe("qoder-api");
    expect(typeof providers.get("qoder")?.streamSimple).toBe("function");
    expect(typeof providers.get("qoder-cn")?.streamSimple).toBe("function");
  });
});

/**
 * The registration handed to the seam (spec fs-qoder-host-seam CU-03, T-06).
 *
 * T-06 pins what the relocation must not change: the api name, the router bound
 * to both `stream` and `streamSimple`, the `provider:qoder` source id — and a
 * factory that still completes when the seam reports no compat registry, which
 * is the OMP path the extension has supported since the a238e42 rename break.
 */
describe("host seam registration (T-06, AC-06)", () => {
  it("T-06 passes the unchanged config and starts on a compat-less host", async () => {
    for (const name of patEnvNames) delete process.env[name];
    // `false` is the seam's answer on a host without a compat registry.
    const seamCalls: { config: Record<string, unknown>; source: string }[] = [];
    const registerQoderApiProvider = vi.fn(async (config: unknown, source: string) => {
      seamCalls.push({ config: config as Record<string, unknown>, source });
      return false;
    });
    vi.doMock("../host-seam.js", () => ({ registerQoderApiProvider }));

    const providers = new Map<string, Record<string, unknown>>();
    const registerProvider = vi.fn((providerID: string, config: Record<string, unknown>) => {
      providers.set(providerID, config);
    });
    const pi = { registerProvider, registerCommand: vi.fn(), on: vi.fn() };

    const { default: registerProviders } = await import("../index.js");
    await expect(registerProviders(pi as never)).resolves.toBeUndefined();

    // A compat-less host still starts and still registers both regions.
    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(providers.has("qoder")).toBe(true);
    expect(providers.has("qoder-cn")).toBe(true);

    expect(seamCalls.length).toBe(1);
    const [{ config, source }] = seamCalls;
    expect(config.api).toBe("qoder-api");
    expect(config.stream).toBe(config.streamSimple);
    expect(typeof config.stream).toBe("function");
    // Same module graph, so this is the identical router binding the host gets.
    expect(config.stream).toBe(providers.get("qoder")?.streamSimple);
    expect(source).toBe("provider:qoder");
  });
});

// invented: a scan shaped like the AC-05/AC-07 publishable cases — 30 natural
// gaps (12/9/6/3 across the 30/120/300/600 buckets at ratio 0.9) and 30 turns
// following one exact linear Credit form.
function publishingScan(): LedgerScan {
  const gaps = [];
  for (const bucket of [
    { count: 12, seconds: 20 },
    { count: 9, seconds: 90 },
    { count: 6, seconds: 200 },
    { count: 3, seconds: 500 },
  ]) {
    for (let index = 0; index < bucket.count; index += 1) gaps.push({ seconds: bucket.seconds, ratio: 0.9 });
  }
  const turns = Array.from({ length: 30 }, (_, index) => {
    const input = 1000 + (index % 5) * 313;
    const cacheRead = 5000 + (index % 7) * 617;
    const output = 100 + (index % 3) * 41;
    return { input, cacheRead, output, credits: 1e-5 * input + 1e-6 * cacheRead + 3e-5 * output };
  });
  return { models: { "DeepSeek-V4-Flash": { gaps, turns } }, warm: [], files: 1, exceededBudget: false };
}

// invented: published values for a hand-fitted model (dfmodel lifetime only)
// and a learned-rate model outside the fitted table (qmodel_preview).
function learnedProfile(): LifetimeProfile {
  return {
    version: 2,
    updatedAt: "2026-10-01T00:00:00.000Z",
    models: {
      "DeepSeek-V4-Flash": { lifetimeSeconds: 600, samples: 30, computedAt: "2026-10-01T00:00:00.000Z", buckets: [] },
      "Qwen3.8-Max": {
        lifetimeSeconds: 900,
        samples: 25,
        computedAt: "2026-10-01T00:00:00.000Z",
        buckets: [],
        rateFit: {
          inputCreditsPerToken: 1e-5,
          cacheReadCreditsPerToken: 1e-6,
          outputCreditsPerToken: 3e-5,
          rSquared: 0.99,
          samples: 30,
          fittedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    },
  };
}

describe("learned profile feed (AC-06)", () => {
  it("stamps learned lifetimes and rates at registration with hand-fitted precedence", async () => {
    for (const name of patEnvNames) delete process.env[name];
    const providers = new Map<string, Record<string, unknown>>();
    const pi = {
      registerProvider(providerID: string, config: Record<string, unknown>) {
        providers.set(providerID, config);
      },
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    const { default: registerProviders } = await import("../index.js");
    await registerProviders(pi as never, { profile: learnedProfile() });

    const models = providers.get("qoder")?.models as Array<{
      id: string;
      promptCache?: { short?: number };
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }>;
    const flash = models.find((model) => model.id === "DeepSeek-V4-Flash");
    expect(flash?.promptCache?.short).toBe(600);
    // dfmodel keeps the hand-fitted measured rates even though a fit exists.
    expect(flash?.cost).toEqual({ input: 0.126984, output: 0.507936, cacheRead: 0.00253968, cacheWrite: 0.126984 });

    const qwen = models.find((model) => model.id === "Qwen3.8-Max");
    expect(qwen?.promptCache?.short).toBe(900);
    expect(qwen?.cost?.input).toBeCloseTo(10 / 75, 12);
    expect(qwen?.cost?.cacheRead).toBeCloseTo(1 / 75, 12);
    expect(qwen?.cost?.output).toBeCloseTo(30 / 75, 12);
    expect(qwen?.cost?.cacheWrite).toBeCloseTo(10 / 75, 12);

    const lite = models.find((model) => model.id === "Lite");
    expect(lite?.promptCache?.short).toBe(300);
  });

  it("re-registers both providers after the learner publishes", async () => {
    for (const name of patEnvNames) delete process.env[name];
    const providers = new Map<string, Record<string, unknown>>();
    const registerProvider = vi.fn((providerID: string, config: Record<string, unknown>) => {
      providers.set(providerID, config);
    });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
      }),
    };

    const scan = publishingScan();
    const writeProfile = vi.fn();
    const { default: registerProviders } = await import("../index.js");
    await registerProviders(pi as never, { scanLedgers: () => scan, writeProfile });
    expect(registerProvider).toHaveBeenCalledTimes(2);

    const ctx = { modelRegistry: { getApiKeyForProvider: async () => undefined } };
    await handlers.get("session_start")?.({}, ctx);

    expect(registerProvider).toHaveBeenCalledTimes(4);
    expect(writeProfile).toHaveBeenCalledTimes(1);
    const reregistered = registerProvider.mock.calls[2][1].models as Array<{
      id: string;
      promptCache?: { short?: number };
    }>;
    expect(reregistered.find((model) => model.id === "DeepSeek-V4-Flash")?.promptCache?.short).toBe(600);
  });

  it("keeps the prior registration when the learner scan throws", async () => {
    for (const name of patEnvNames) delete process.env[name];
    const registerProvider = vi.fn();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      registerProvider,
      unregisterProvider: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
      }),
    };
    const writeProfile = vi.fn();
    const { default: registerProviders } = await import("../index.js");
    await registerProviders(pi as never, {
      scanLedgers: () => {
        throw new Error("scan boom");
      },
      writeProfile,
    });

    const ctx = { modelRegistry: { getApiKeyForProvider: async () => undefined } };
    await expect(handlers.get("session_start")?.({}, ctx)).resolves.toBeUndefined();
    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(writeProfile).not.toHaveBeenCalled();
  });
});
