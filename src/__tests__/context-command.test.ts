import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearQoderModelsMemCache } from "../catalog.js";
import {
  applyCompactionOverride,
  applyWindowOverride,
  effectiveCompaction,
  effectiveWindow,
  findQoderModel,
  parseContextArgs,
  parsePercent,
  percentToTokens,
  renderContextReport,
  tokensToPercent,
} from "../commands/context.js";
import { getPiAgentDir } from "../home.js";
import type { LifetimeProfile } from "../lifetime.js";

const CACHE_PATH = join(getPiAgentDir(), "qoder-models-cache.json");

/** Controlled catalog so these tests never read the developer's live cache. */
function seedCatalog(defaultTier200K: boolean): void {
  writeFileSync(
    CACHE_PATH,
    JSON.stringify({
      updatedAt: Date.now(),
      models: [{ id: "Ultimate", name: "Ultimate", contextWindow: 1000000, maxTokens: 131072 }],
      configs: {
        Ultimate: {
          key: "ultimate",
          enable: true,
          display_name: "Ultimate",
          context_config: {
            "200K": defaultTier200K ? { token_count: 200000, is_default: true } : { token_count: 200000 },
            "1M": { token_count: 1000000 },
          },
        },
      },
    }),
    "utf8",
  );
  clearQoderModelsMemCache();
}

beforeEach(() => seedCatalog(false));
afterEach(() => clearQoderModelsMemCache());

describe("parsePercent", () => {
  it("accepts bare and %-suffixed percentages inside (0,100)", () => {
    expect(parsePercent("10")).toBe(10);
    expect(parsePercent("10%")).toBe(10);
    expect(parsePercent("2.5")).toBe(2.5);
  });
  it("rejects blank, non-numeric, and out-of-range input", () => {
    expect(parsePercent("")).toBeUndefined();
    expect(parsePercent("abc")).toBeUndefined();
    expect(parsePercent("0")).toBeUndefined();
    expect(parsePercent("120%")).toBeUndefined();
  });
});

describe("parseContextArgs", () => {
  it("parses model, window tiers, and percentages", () => {
    expect(parseContextArgs("Ultimate window=400K reserve=10% keep=15")).toEqual({
      ok: true,
      value: { model: "Ultimate", window: 400000, reservePct: 10, keepPct: 15 },
    });
    expect(parseContextArgs("GLM-5.3 window=1M")).toEqual({ ok: true, value: { model: "GLM-5.3", window: 1000000 } });
    expect(parseContextArgs("Ultimate window=default")).toEqual({
      ok: true,
      value: { model: "Ultimate", window: "default" },
    });
    expect(parseContextArgs("Ultimate reset")).toEqual({ ok: true, value: { model: "Ultimate", reset: true } });
  });

  it("rejects malformed options with a specific message", () => {
    const bad = parseContextArgs("Ultimate window=abc");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("window=");
    const pct = parseContextArgs("Ultimate reserve=120%");
    expect(pct.ok).toBe(false);
    if (!pct.ok) expect(pct.error).toContain("between 0 and 100");
    const unknown = parseContextArgs("Ultimate nope=1");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("Unknown option");
  });
});

describe("percentToTokens / tokensToPercent", () => {
  it("converts against the effective window with rounding and a 1-token floor", () => {
    expect(percentToTokens(10, 200000)).toBe(20000);
    expect(percentToTokens(15, 400000)).toBe(60000);
    expect(percentToTokens(0.1, 1000)).toBe(1);
    expect(percentToTokens(0.01, 1000)).toBe(1);
    expect(tokensToPercent(20000, 200000)).toBe("10%");
    expect(tokensToPercent(100000, 300000)).toBe("33.3%");
  });
});

describe("applyWindowOverride", () => {
  it("sets the override without touching unrelated config", () => {
    const models = { providers: { antochat: { models: [{ id: "GLM-5.3" }] } } };
    const next = applyWindowOverride({ modelsJson: models, providerID: "qoder", modelId: "GLM-5.3", window: 400000 });
    const providers = next.providers as Record<string, Record<string, unknown>>;
    expect((providers.qoder.modelOverrides as Record<string, { contextWindow: number }>)["GLM-5.3"].contextWindow).toBe(
      400000,
    );
    expect(providers.antochat).toEqual({ models: [{ id: "GLM-5.3" }] });
    expect((models.providers as Record<string, unknown>).qoder).toBeUndefined();
  });

  it("removes the override and cleans up empty containers on default", () => {
    const models = { providers: { qoder: { modelOverrides: { "GLM-5.3": { contextWindow: 400000 } } } } };
    const next = applyWindowOverride({
      modelsJson: models,
      providerID: "qoder",
      modelId: "GLM-5.3",
      window: "default",
    });
    expect(next).toEqual({});
  });
});

describe("applyCompactionOverride / effectiveCompaction", () => {
  it("writes percent-derived tokens under the provider/model key", () => {
    const settings = { compaction: { enabled: true, reserveTokens: 400000, keepRecentTokens: 100000 } };
    const next = applyCompactionOverride({
      settingsJson: settings,
      providerID: "qoder",
      modelId: "GLM-5.3",
      reserveTokens: 20000,
      keepTokens: 30000,
    });
    const compaction = next.compaction as Record<string, unknown>;
    expect(compaction.enabled).toBe(true);
    expect(compaction.reserveTokens).toBe(400000);
    expect((compaction.modelOverrides as Record<string, Record<string, number>>)["qoder/GLM-5.3"]).toEqual({
      reserveTokens: 20000,
      keepRecentTokens: 30000,
    });
  });

  it("resolves override → ordinary → pi default and clears on reset", () => {
    const withOverride = {
      compaction: { modelOverrides: { "qoder/GLM-5.3": { reserveTokens: 20000, keepRecentTokens: 30000 } } },
    };
    expect(effectiveCompaction(withOverride, "qoder/GLM-5.3")).toEqual({
      reserveTokens: 20000,
      keepTokens: 30000,
      fromOverride: true,
    });
    const ordinary = { compaction: { reserveTokens: 400000, keepRecentTokens: 100000 } };
    expect(effectiveCompaction(ordinary, "qoder/GLM-5.3")).toEqual({
      reserveTokens: 400000,
      keepTokens: 100000,
      fromOverride: false,
    });
    expect(effectiveCompaction({}, "qoder/GLM-5.3")).toEqual({
      reserveTokens: 16384,
      keepTokens: 20000,
      fromOverride: false,
    });
    const reset = applyCompactionOverride({
      settingsJson: withOverride,
      providerID: "qoder",
      modelId: "GLM-5.3",
      reset: true,
    });
    expect(effectiveCompaction(reset, "qoder/GLM-5.3").fromOverride).toBe(false);
  });
});

describe("effectiveWindow", () => {
  it("uses the models.json override when present, else the catalog fallback", () => {
    const location = findQoderModel("Ultimate");
    if (!location) throw new Error("seed is missing Ultimate");
    expect(effectiveWindow({}, location)).toEqual({ window: 1000000, source: "catalog fallback" });
    const models = { providers: { qoder: { modelOverrides: { Ultimate: { contextWindow: 400000 } } } } };
    expect(effectiveWindow(models, location)).toEqual({ window: 400000, source: "override" });
  });

  it("prefers Qoder's is_default tier when the catalog marks one", () => {
    seedCatalog(true);
    const location = findQoderModel("Ultimate");
    if (!location) throw new Error("seed is missing Ultimate");
    expect(effectiveWindow({}, location)).toEqual({ window: 200000, source: "catalog default tier" });
  });
});

describe("renderContextReport", () => {
  it("lists a model line with window and percent-derived compaction", () => {
    const location = findQoderModel("Ultimate");
    if (!location) throw new Error("seed is missing Ultimate");
    const report = renderContextReport({}, {});
    expect(report).toContain(`${location.providerID}/Ultimate`);
    expect(report).toContain("window 1,000,000");
    expect(report).toContain("reserve 1.6% (16,384)");
  });

  it("appends learned estimates with their evidence, or an unmeasured note", () => {
    // invented: a published profile drawn from the schema example in SA §5.5.
    const profile: LifetimeProfile = {
      version: 2,
      updatedAt: "2026-10-01T00:00:00.000Z",
      models: {
        "DeepSeek-V4-Flash": {
          lifetimeSeconds: 600,
          samples: 30,
          computedAt: "2026-09-30T12:00:00.000Z",
          buckets: [{ upperSeconds: 600, medianRatio: 0.84, samples: 3 }],
          rateFit: {
            inputCreditsPerToken: 9.5238e-6,
            cacheReadCreditsPerToken: 1.90476e-7,
            outputCreditsPerToken: 3.80952e-5,
            rSquared: 0.9982,
            samples: 42,
            fittedAt: "2026-09-30T12:00:00.000Z",
          },
        },
      },
    };
    const published = renderContextReport({}, {}, profile);
    expect(published).toContain("Cache estimates (learned):");
    expect(published).toContain("DeepSeek-V4-Flash · lifetime 600 s (30 samples, computed 2026-09-30T12:00:00.000Z)");
    expect(published).toContain("rate fit R² 0.998 (42 turns)");

    const unmeasured = renderContextReport({}, {});
    expect(unmeasured).toContain("unmeasured");
    expect(unmeasured).not.toContain("lifetime 600");
  });
});
