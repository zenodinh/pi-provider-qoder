import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQoderModelsMemCache,
  contextWindowFromCatalog,
  DEFAULT_CONTEXT_WINDOW,
  getCachedModelConfig,
  staticCnModels,
  staticModels,
  toQoderModelId,
  updateQoderModelsCache,
  ZERO_COST,
} from "../catalog.js";

const cachePath = (): string => join(process.env.HOME as string, ".pi", "agent", "qoder-models-cache.json");

beforeEach(() => {
  clearQoderModelsMemCache();
  rmSync(cachePath(), { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(cachePath(), { force: true });
  clearQoderModelsMemCache();
});

// ── staticModels ──────────────────────────────────────────────────────────

describe("staticModels", () => {
  it("carries the four permanent tier aliases and nothing else", () => {
    // A model-named row is a snapshot a release invalidates — `Lite`, `Qwen3.7
    // Plus` and `DeepSeek-V4-Flash` all stopped resolving — and a dead id is only
    // discovered at dispatch. The tiers are Qoder's stable interface (present in
    // the live catalog 2026-10-09), so the offline fallback is exactly these four.
    expect(staticModels.map((m) => m.upstreamKey).sort()).toEqual(["auto", "efficient", "performance", "ultimate"]);
  });

  it("has auto as first entry", () => {
    expect(staticModels[0].id).toBe("Auto");
  });

  it("every model has required fields", () => {
    for (const m of staticModels) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.api).toBe("qoder-api");
      expect(m.provider).toBe("qoder");
      expect(m.baseUrl).toBeTruthy();
      expect(typeof m.reasoning).toBe("boolean");
      expect(typeof m.supportsEffort).toBe("boolean");
      expect(Array.isArray(m.input)).toBe(true);
      expect(m.cost).toEqual(
        expect.objectContaining({
          input: expect.any(Number),
          output: expect.any(Number),
          cacheRead: expect.any(Number),
          cacheWrite: expect.any(Number),
        }),
      );
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it("has unique IDs", () => {
    const ids = staticModels.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses a 1M context window for the tiers confirmed to support it", () => {
    // Global lite was live-tested through 1,000K tokens (issue #13). auto and
    // efficient share the same Qoder 1M catalog family. The model-named keys that
    // did too (lite, gm51model) left the fallback, and the live path takes their
    // context from the catalog itself.
    for (const key of ["auto", "efficient"]) {
      const model = staticModels.find((m) => m.upstreamKey === key);
      expect(model, key).toBeDefined();
      expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
      expect(model?.contextWindow).toBe(1_000_000);
    }
  });

  it("declares the prompt-cache lifetime so pi can warm it", () => {
    for (const m of [...staticModels, ...staticCnModels]) {
      expect(m.promptCache).toEqual({ short: 300 });
    }
  });

  it("maps friendly ids to static upstream keys without raw-key aliases", () => {
    // Asserted on a surviving tier row; the model-named mapping (Qwen3.8-Max →
    // qmodel_preview) now belongs to the live-catalog suite, where the rows come
    // from the catalog instead of from a hand-maintained snapshot.
    expect(getCachedModelConfig("Ultimate", "global")?.key).toBe("ultimate");
    expect(getCachedModelConfig("Efficient", "global")?.key).toBe("efficient");
    expect(getCachedModelConfig("ultimate", "global")).toBeNull();
    expect(getCachedModelConfig("efficient", "global")).toBeNull();
  });

  it("still resolves an id the fallback no longer offers, so a stored model keeps dispatching", () => {
    // Two roles: `staticModels` is what a picker shows offline (the four tiers);
    // the resolution seed behind getCachedModelConfig keeps the older display
    // names (`Lite`, `Qwen3.8-Max`) mapping to their upstream keys.
    expect(getCachedModelConfig("Lite", "global")?.key).toBe("lite");
    expect(getCachedModelConfig("Qwen3.8-Max", "global")?.key).toBe("qmodel_preview");
    expect(getCachedModelConfig("lite", "global")).toBeNull();
  });

  it("leaves every fallback row at ZERO_COST (measured pricing lives on the live path)", () => {
    // The rate table keys on upstream names a fallback row no longer carries
    // (dfmodel, qmodel_preview). "live catalog builder rates (spec T-09)" below
    // asserts the measured fit where the rows come from the catalog.
    for (const m of staticModels) expect(m.cost).toBe(ZERO_COST);
  });
});

// ── staticCnModels ────────────────────────────────────────────────────────

describe("staticCnModels", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(staticCnModels)).toBe(true);
    expect(staticCnModels.length).toBeGreaterThan(0);
  });

  it("has Auto as first entry", () => {
    expect(staticCnModels[0].id).toBe("Auto");
  });

  it("every CN model has required fields", () => {
    for (const m of staticCnModels) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.api).toBe("qoder-api");
      expect(m.api).not.toBe("qoder-cn-api");
      expect(m.provider).toBe("qoder-cn");
      expect(m.baseUrl).toContain("qoder.com.cn");
      expect(typeof m.reasoning).toBe("boolean");
      expect(typeof m.supportsEffort).toBe("boolean");
      expect(Array.isArray(m.input)).toBe(true);
      expect(m.cost).toEqual(
        expect.objectContaining({
          input: expect.any(Number),
          output: expect.any(Number),
          cacheRead: expect.any(Number),
          cacheWrite: expect.any(Number),
        }),
      );
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it("applies the measured rate table to CN rows whose upstream key is measured (dfmodel)", () => {
    // The rate join is by upstream key, so the CN catalog's DeepSeek-V4-Flash
    // (upstreamKey dfmodel) carries the same measured rates as the global row.
    expect(staticCnModels.find((m) => m.upstreamKey === "dfmodel")?.cost).toEqual({
      input: 0.126984,
      cacheRead: 0.00253968,
      output: 0.507936,
      cacheWrite: 0.126984,
    });
  });

  it("has unique IDs", () => {
    const ids = staticCnModels.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses friendly IDs only in both static region catalogs", () => {
    for (const model of [...staticModels, ...staticCnModels]) {
      expect(model.id).toBe(toQoderModelId(model.name));
      expect(model.id).not.toBe(model.upstreamKey);
    }
  });

  it("every CN model has a description", () => {
    for (const m of staticCnModels) {
      expect(m.description).toBeTruthy();
    }
  });

  it("does not copy global 1M onto CN models whose live catalog is smaller", () => {
    expect(staticCnModels.find((m) => m.id === "Auto")?.contextWindow).toBe(200000);
    expect(staticCnModels.find((m) => m.id === "GLM-5.2")?.contextWindow).toBe(200000);
    expect(staticCnModels.find((m) => m.id === "MiniMax-M2.7")?.contextWindow).toBe(200000);
    expect(staticCnModels.find((m) => m.id === "Kimi-K2.7-Code")?.contextWindow).toBe(256000);
  });
});

describe("contextWindowFromCatalog", () => {
  it("prefers Qoder's is_default tier over the largest advertised window", () => {
    expect(
      contextWindowFromCatalog({
        context_config: {
          small: { token_count: 200000, is_default: true },
          large: { token_count: 1000000 },
        },
      }),
    ).toBe(200000);
  });

  it("uses the largest advertised token_count when no default is marked", () => {
    expect(
      contextWindowFromCatalog({
        context_config: {
          small: { token_count: 200000 },
          large: { token_count: 400000 },
        },
      }),
    ).toBe(400000);
  });

  it("keeps an advertised 200K window instead of the 1M fallback", () => {
    expect(
      contextWindowFromCatalog({
        context_config: { default: { token_count: 200000, is_default: true } },
      }),
    ).toBe(200000);
  });

  it("falls back to 1M when the catalog omits context_config", () => {
    expect(contextWindowFromCatalog({ key: "lite", max_input_tokens: 180000 })).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("toQoderModelId", () => {
  it("strips whitespace from catalog display names", () => {
    expect(toQoderModelId("Qwen3.8-Flash")).toBe("Qwen3.8-Flash");
    expect(toQoderModelId("Qwen 3.8 Max")).toBe("Qwen3.8Max");
    expect(toQoderModelId("DeepSeek V4 Pro")).toBe("DeepSeekV4Pro");
  });

  it("uses a stable fallback when the display name is absent", () => {
    expect(toQoderModelId()).toBe("QoderModel");
    expect(toQoderModelId("")).toBe("QoderModel");
  });
});

describe("live catalog builder rates (spec T-09)", () => {
  it("assigns the measured table by upstream key and ZERO_COST to the rest", async () => {
    // invented: entries mirror the recorded /model/list chat shape (catalog-cache.test.ts fixtures);
    // the keys pin the measured/unmeasured split.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "dfmodel", enable: true, display_name: "DeepSeek-V4-Flash" },
              { key: "gmodel", enable: true, display_name: "GLM-5.3" },
              { key: "qmodel_38max", enable: true, display_name: "Qwen3.8-Max" },
              { key: "qwmodel", enable: true, display_name: "Qwen3.8-Flash" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(cachePath(), "utf8"));
    const byId: Record<string, { cost: unknown }> = Object.fromEntries(
      cache.models.map((model: { id: string; cost: unknown }) => [model.id, model]),
    );
    expect(byId["DeepSeek-V4-Flash"].cost).toEqual({
      input: 0.126984,
      cacheRead: 0.00253968,
      output: 0.507936,
      cacheWrite: 0.126984,
    });
    expect(byId["GLM-5.3"].cost).toEqual({
      input: 1.01592,
      cacheRead: 0.25398,
      output: 3.55572,
      cacheWrite: 1.01592,
    });
    expect(byId["Qwen3.8-Max"].cost).toEqual({
      input: 1.428571,
      cacheRead: 0.114286,
      output: 3.428571,
      cacheWrite: 1.428571,
    });
    expect(byId["Qwen3.8-Flash"].cost).toEqual(ZERO_COST);
  });
});

// ── ZERO_COST ─────────────────────────────────────────────────────────────

describe("ZERO_COST", () => {
  it("has all zero values", () => {
    expect(ZERO_COST).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ZERO_COST)).toBe(true);
  });
});
