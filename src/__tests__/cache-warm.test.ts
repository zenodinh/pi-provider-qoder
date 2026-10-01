import type { CacheWarmingDecisionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantEntry, warmEntry } from "./session-fixtures.js";

// Keep the extension's startup path offline and deterministic: a visible PAT
// would make it attempt a login exchange against the network (same guard as
// providers.test.ts), and QODER_CACHE_WARM decides the hook under test.
const patEnvNames = [
  "QODER_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODERCN_API_KEY",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
] as const;
// Save/restore includes the warming switch so each test starts clean.
const envNames = [...patEnvNames, "QODER_CACHE_WARM"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

type CacheWarmingHandler = (event: CacheWarmingDecisionEvent, ctx?: unknown) => unknown;

async function loadHandlers(): Promise<Map<string, CacheWarmingHandler>> {
  // Only the PATs are cleared here; QODER_CACHE_WARM is the subject of the test.
  for (const name of patEnvNames) delete process.env[name];
  const handlers = new Map<string, CacheWarmingHandler>();
  const pi = {
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    unregisterProvider: vi.fn(),
    on: vi.fn((name: string, handler: CacheWarmingHandler) => {
      handlers.set(name, handler);
      return () => {};
    }),
  };
  const { default: registerProviders } = await import("../index.js");
  await registerProviders(pi as never);
  return handlers;
}

const stopDecision: CacheWarmingDecisionEvent = {
  type: "cache_warming_decision",
  action: "stop",
  warmCost: 0,
  missCost: 0,
  continuationProbability: 0.15,
};

// The guarded handler reads the session branch, so the fixture ctx carries a
// stub session manager. `Lite` resolves to an unmeasured upstream key, which
// keeps the legacy force-warm outcome these pre-guard tests pinned.
const qoderCtx = {
  model: { provider: "qoder", id: "Lite" },
  sessionManager: { getBranch: () => [] },
};

// invented: governed branch already at the cap — same math as warm-guard T-01
// (anchor 1,607,144 prompt tokens on dfmodel -> protected ~$0.20, two $0.05
// refreshes meet the 0.5 fraction).
function governedCtxAtCap() {
  const anchor = assistantEntry("DeepSeek-V4-Flash", 1_000_000, { input: 1_607_144, cacheRead: 0, output: 10 });
  const refresh = (timestampMs: number) =>
    warmEntry(timestampMs, { input: 1_607_144, cacheRead: 0, output: 4 }, 0, 3.75);
  return {
    model: { provider: "qoder", id: "DeepSeek-V4-Flash" },
    sessionManager: { getBranch: () => [anchor, refresh(1_300_000), refresh(1_600_000)] },
  };
}

describe("cache warming decision hook", () => {
  it("overrides pi's economics stop when QODER_CACHE_WARM=1", async () => {
    process.env.QODER_CACHE_WARM = "1";
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.(stopDecision, qoderCtx)).toEqual({ action: "warm" });
  });

  it("leaves the decision untouched when QODER_CACHE_WARM is unset", async () => {
    delete process.env.QODER_CACHE_WARM;
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.(stopDecision, qoderCtx)).toBeUndefined();
  });

  it("leaves an already-warm decision untouched", async () => {
    process.env.QODER_CACHE_WARM = "1";
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.({ ...stopDecision, action: "warm" }, qoderCtx)).toBeUndefined();
  });

  it("does not override for other providers or an unknown model", async () => {
    process.env.QODER_CACHE_WARM = "1";
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.(stopDecision, { model: { provider: "anthropic" } })).toBeUndefined();
    expect(await handler?.(stopDecision, { model: undefined })).toBeUndefined();
  });

  it("stops pi's warm at the cap on a governed model", async () => {
    process.env.QODER_CACHE_WARM = "1";
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.({ ...stopDecision, action: "warm" }, governedCtxAtCap())).toEqual({ action: "stop" });
  });

  it("leaves gate-off decisions untouched, and ungoverned models on the legacy path", async () => {
    delete process.env.QODER_CACHE_WARM;
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    const governed = governedCtxAtCap();
    expect(await handler?.(stopDecision, governed)).toBeUndefined();
    expect(await handler?.({ ...stopDecision, action: "warm" }, governed)).toBeUndefined();

    process.env.QODER_CACHE_WARM = "1";
    expect(await handler?.({ ...stopDecision, action: "stop" }, qoderCtx)).toEqual({ action: "warm" });
  });
});
