// shape: none — §Vocabulary dispatch idioms do not apply: the module is a
//   fixed-shape rate record (trigger #7) consulted through one guarded lookup,
//   plus straight-line conversion arithmetic. The pricing ladder has three
//   outcomes but no single discriminator to dispatch on — it is driven by two
//   independent facts (Credits present, rates measured).
import type { QoderMode } from "./region.js";

/** The shared Credits→USD basis: turn costs and quota display both convert here. */
export const CREDITS_PER_USD = 75;

/** USD per 1M tokens for one measured model form. */
export interface RateEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Token counts in pi's Anthropic convention (input excludes cached/written tokens). */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** pi's `usage.cost` shape: four USD buckets whose sum must equal `total`. */
export interface CostBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Measured rate table, keyed by the Qoder **upstream key only** (dfmodel,
 * gmodel, qmodel_38max). Display names are not keys: the static and live
 * catalogs diverge (Qwen3.8-Max is `qmodel_preview` statically but
 * `qmodel_38max` live), so a display-name match could price an unknown
 * upstream; a key miss must stay unmeasured. Values are the R²=1.000000 fitted
 * forms from SA §5.2, USD per 1M tokens at the 75-Credits-per-USD basis.
 * `cacheWrite` mirrors the input rate: observed cache-write tokens are zero,
 * and pricing a future non-zero write at the input rate cannot understate.
 */
export const RATE_TABLE: Readonly<Record<string, RateEntry>> = Object.freeze({
  dfmodel: Object.freeze({ input: 0.126984, cacheRead: 0.00253968, output: 0.507936, cacheWrite: 0.126984 }),
  gmodel: Object.freeze({ input: 1.01592, cacheRead: 0.25398, output: 3.55572, cacheWrite: 1.01592 }),
  qmodel_38max: Object.freeze({ input: 1.428571, cacheRead: 0.114286, output: 3.428571, cacheWrite: 1.428571 }),
});

/** Join one upstream key against the measured table; unknown keys stay unmeasured. */
export function rateForUpstreamKey(key: string | undefined): RateEntry | undefined {
  if (key === undefined) return undefined;
  return Object.hasOwn(RATE_TABLE, key) ? RATE_TABLE[key] : undefined;
}

/** Joins a public model id to its upstream key; injected at call sites. */
export type ResolveUpstreamKey = (modelId: string, mode: QoderMode) => string | undefined;

/**
 * Resolve a measured rate from a public model id. The resolver is a required
 * parameter rather than a catalog-backed default: catalog.ts joins RATE_TABLE
 * at module init (the static builders), so importing the catalog here would
 * form an initialization cycle — TDZ on whichever module evaluates second
 * (a direct `pricing.ts` import from a test is one such entry).
 */
export function rateForModel(modelId: string, mode: QoderMode, resolveKey: ResolveUpstreamKey): RateEntry | undefined {
  return rateForUpstreamKey(resolveKey(modelId, mode));
}

/** Convert charged Credits to USD at the shared basis. */
export function creditsToUsd(credits: number): number {
  return credits / CREDITS_PER_USD;
}

function totalInInputBucket(total: number): CostBuckets {
  return { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total };
}

/**
 * Price token counts directly from measured rates (USD per 1M tokens). Used
 * when a measured model reports no Credits — pi-ai computes the same form on
 * v2; this is the legacy transport's equivalent.
 */
export function buildBucketsFromRates(tokens: TokenCounts, rates: RateEntry): CostBuckets {
  const perMillion = (count: number, rate: number): number => (count * rate) / 1_000_000;
  const input = perMillion(tokens.input, rates.input);
  const output = perMillion(tokens.output, rates.output);
  const cacheRead = perMillion(tokens.cacheRead, rates.cacheRead);
  const cacheWrite = perMillion(tokens.cacheWrite, rates.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Price a charged turn from its Credits: the total is Credits ÷ 75, and the
 * four buckets are scaled from rate-table proportions so their sum equals the
 * total — pi's HTML export rebuilds the total from the buckets and ignores
 * `total`. Without rates there is no measured shape to scale, so the whole
 * total lands in `input` rather than an invented split. Non-finite or negative
 * Credits return `undefined` so the caller takes the rate-table ladder.
 */
export function buildBucketsFromCredits(
  credits: number,
  tokens: TokenCounts,
  rates?: RateEntry,
): CostBuckets | undefined {
  if (!Number.isFinite(credits) || credits < 0) return undefined;
  const total = creditsToUsd(credits);
  if (!rates) return totalInInputBucket(total);
  const weights = {
    input: tokens.input * rates.input,
    output: tokens.output * rates.output,
    cacheRead: tokens.cacheRead * rates.cacheRead,
    cacheWrite: tokens.cacheWrite * rates.cacheWrite,
  };
  const weightSum = weights.input + weights.output + weights.cacheRead + weights.cacheWrite;
  if (!Number.isFinite(weightSum) || weightSum <= 0) return totalInInputBucket(total);
  return {
    input: (total * weights.input) / weightSum,
    output: (total * weights.output) / weightSum,
    cacheRead: (total * weights.cacheRead) / weightSum,
    cacheWrite: (total * weights.cacheWrite) / weightSum,
    total,
  };
}

/** Where a priced row's cost came from: charged Credits, the rate table, or nothing measured. */
export type RateSource = "credits" | "rate-table" | "fallback";

/**
 * The legacy assembly's pricing ladder: charged Credits win; without them a
 * measured model prices from the rate table; anything else is zero-cost with a
 * `fallback` marker. A Credits-bearing row on an unmeasured model keeps the
 * Credits total in the input bucket (never invents proportional shares) and is
 * still marked `fallback` — no measured shape produced its split.
 */
export function priceTurnCost(
  credits: number | undefined,
  tokens: TokenCounts,
  rates: RateEntry | undefined,
): { cost: CostBuckets; rateSource: RateSource } {
  if (credits !== undefined) {
    const cost = buildBucketsFromCredits(credits, tokens, rates);
    if (cost) return { cost, rateSource: rates ? "credits" : "fallback" };
  }
  if (rates) return { cost: buildBucketsFromRates(tokens, rates), rateSource: "rate-table" };
  return { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, rateSource: "fallback" };
}
