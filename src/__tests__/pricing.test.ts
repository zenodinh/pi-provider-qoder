import { describe, expect, it } from "vitest";
import {
  buildBucketsFromCredits,
  buildBucketsFromRates,
  CREDITS_PER_USD,
  creditsToUsd,
  priceTurnCost,
  rateForModel,
  rateForUpstreamKey,
} from "../pricing.js";

// recorded-from: SA §5.2 measured rate table (owner ledger fits, R²=1.000000, 2026-09-30).
// Pinned as literals rather than imported from RATE_TABLE so these tests can fail
// if the table drifts (the test owns its expected values).
const DFMODEL_RATES = { input: 0.126984, cacheRead: 0.00253968, output: 0.507936, cacheWrite: 0.126984 };
const GMODEL_RATES = { input: 1.01592, cacheRead: 0.25398, output: 3.55572, cacheWrite: 1.01592 };
const QMODEL_38MAX_RATES = { input: 1.428571, cacheRead: 0.114286, output: 3.428571, cacheWrite: 1.428571 };

describe("CREDITS_PER_USD", () => {
  it("pins the shared 75-Credits-per-USD basis", () => {
    expect(CREDITS_PER_USD).toBe(75);
    expect(creditsToUsd(150)).toBe(2);
  });
});

describe("rateForUpstreamKey", () => {
  it("resolves only the three measured keys and never their display names", () => {
    expect(rateForUpstreamKey("dfmodel")).toEqual(DFMODEL_RATES);
    expect(rateForUpstreamKey("gmodel")).toEqual(GMODEL_RATES);
    expect(rateForUpstreamKey("qmodel_38max")).toEqual(QMODEL_38MAX_RATES);
    expect(rateForUpstreamKey("qmodel_preview")).toBeUndefined();
    expect(rateForUpstreamKey("DeepSeek-V4-Flash")).toBeUndefined();
    expect(rateForUpstreamKey(undefined)).toBeUndefined();
    expect(rateForUpstreamKey("toString")).toBeUndefined();
  });
});

describe("rateForModel", () => {
  it("resolves by upstream key via the injected lookup; divergent keys stay unmeasured (spec T-03)", () => {
    // recorded-from: T-03's stub — the live catalog resolves Qwen3.8-Max to
    // qmodel_preview, which is not a measured key; only the real measured keys
    // resolve, so a name-only match can never price an unknown upstream.
    const resolveKey = (modelId: string): string | undefined => {
      if (modelId === "DeepSeek-Flash") return "dfmodel";
      if (modelId === "Qwen3.8-Max") return "qmodel_preview";
      return undefined;
    };
    expect(rateForModel("DeepSeek-Flash", "global", resolveKey)).toEqual(DFMODEL_RATES);
    expect(rateForModel("Qwen3.8-Max", "global", resolveKey)).toBeUndefined();
    expect(rateForModel("Unknown", "global", resolveKey)).toBeUndefined();
  });
});

describe("buildBucketsFromCredits", () => {
  it("scales 100.0 Credits across measured proportions with the bucket sum equal to the total (spec T-01/AC-01)", () => {
    // invented: token split chosen to exercise proportional scaling; the Credits
    // amount and total are pinned by the spec (100.0 → 1.333333 ± 1e-6).
    const tokens = { input: 250_000, output: 1_000, cacheRead: 0, cacheWrite: 0 };
    const cost = buildBucketsFromCredits(100.0, tokens, DFMODEL_RATES);
    expect(cost).toBeDefined();
    const buckets = cost as NonNullable<typeof cost>;
    expect(buckets.total).toBeCloseTo(1.3333333, 6);
    expect(
      Math.abs(buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite - buckets.total),
    ).toBeLessThanOrEqual(1e-9);
    // Proportional to the weights (250,000×0.126984 vs 1,000×0.507936): input dominates.
    expect(buckets.input).toBeGreaterThan(buckets.output);
    expect(buckets.output).toBeGreaterThan(0);
    expect(buckets.cacheRead).toBe(0);
    expect(buckets.cacheWrite).toBe(0);
  });

  it("parks the whole total in the input bucket when no measured rates exist (spec T-02)", () => {
    // invented: token split is irrelevant on this path — no proportions may be invented.
    const cost = buildBucketsFromCredits(0.4, { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 });
    expect(cost?.total).toBeCloseTo(0.0053333333, 9);
    expect(cost?.input).toBeCloseTo(0.0053333333, 9);
    expect(cost?.output).toBe(0);
    expect(cost?.cacheRead).toBe(0);
    expect(cost?.cacheWrite).toBe(0);
  });

  it("returns undefined for non-finite or negative Credits so the caller takes the ladder", () => {
    const tokens = { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 };
    expect(buildBucketsFromCredits(Number.NaN, tokens, DFMODEL_RATES)).toBeUndefined();
    expect(buildBucketsFromCredits(Number.POSITIVE_INFINITY, tokens, DFMODEL_RATES)).toBeUndefined();
    expect(buildBucketsFromCredits(-0.5, tokens, DFMODEL_RATES)).toBeUndefined();
  });
});

describe("buildBucketsFromRates", () => {
  it("prices tokens directly at USD per 1M tokens", () => {
    const cost = buildBucketsFromRates({ input: 100_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }, DFMODEL_RATES);
    expect(cost.input).toBeCloseTo(0.0126984, 9);
    expect(cost.output).toBeCloseTo(0.000507936, 9);
    expect(cost.total).toBeCloseTo(0.013206336, 9);
  });
});

describe("priceTurnCost ladder", () => {
  const tokens = { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 };

  it("uses charged Credits and marks the measured shape credits", () => {
    const priced = priceTurnCost(1.5, tokens, DFMODEL_RATES);
    expect(priced.rateSource).toBe("credits");
    expect(priced.cost.total).toBeCloseTo(0.02, 9);
  });

  it("keeps the Credits total in input and marks fallback for an unmeasured model", () => {
    const priced = priceTurnCost(1.5, tokens, undefined);
    expect(priced.rateSource).toBe("fallback");
    expect(priced.cost.input).toBeCloseTo(0.02, 9);
    expect(priced.cost.output).toBe(0);
    expect(priced.cost.total).toBeCloseTo(0.02, 9);
  });

  it("prices from the rate table when Credits are absent", () => {
    const priced = priceTurnCost(undefined, tokens, DFMODEL_RATES);
    expect(priced.rateSource).toBe("rate-table");
    expect(priced.cost.input).toBeCloseTo(0.000126984, 9);
    expect(priced.cost.output).toBeCloseTo(0.0001015872, 9);
    expect(priced.cost.total).toBeCloseTo(0.0002285712, 9);
  });

  it("stores zeros and marks fallback when neither Credits nor rates exist", () => {
    const priced = priceTurnCost(undefined, tokens, undefined);
    expect(priced.rateSource).toBe("fallback");
    expect(priced.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });
});

describe("write-once pricing invariant (spec T-14/AC-12)", () => {
  it("keeps every generated row's bucket sum equal to its total and aggregate sums within 0.01", () => {
    // Deterministic LCG: the property must be reproducible without a dependency.
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const rateForms = [DFMODEL_RATES, GMODEL_RATES, QMODEL_38MAX_RATES];
    let sumTotals = 0;
    let sumBuckets = 0;
    let sumCreditsUsd = 0;
    for (let i = 0; i < 1000; i++) {
      const credits = rand() * 500;
      const tokens = {
        input: Math.floor(rand() * 1_000_000),
        output: Math.floor(rand() * 20_000),
        cacheRead: Math.floor(rand() * 500_000),
        cacheWrite: 0,
      };
      const rates = rand() < 0.7 ? rateForms[i % rateForms.length] : undefined;
      const cost = buildBucketsFromCredits(credits, tokens, rates);
      expect(cost).toBeDefined();
      const buckets = cost as NonNullable<typeof cost>;
      expect(
        Math.abs(buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite - buckets.total),
      ).toBeLessThanOrEqual(1e-9);
      sumTotals += buckets.total;
      sumBuckets += buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite;
      sumCreditsUsd += creditsToUsd(credits);
    }
    expect(sumTotals).toBeCloseTo(sumCreditsUsd, 9);
    expect(Math.abs(sumBuckets - sumTotals)).toBeLessThan(0.01);
  });
});
