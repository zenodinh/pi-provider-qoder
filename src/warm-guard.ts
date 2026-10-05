// shape: none — pure decision module; one comparison with a reason string,
//   below the dispatch-object threshold (repo shape idiom).

import type { CacheWarmingDecisionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getCachedModelConfig } from "./catalog.js";
import { debugLog } from "./debug.js";
import { type LifetimeProfile, type RateFit, readProfile } from "./lifetime.js";
import { CREDITS_PER_USD, RATE_TABLE, type RateEntry, rateForModel } from "./pricing.js";
import { lastRealRequestAt } from "./protocol/run-identity.js";
import { parseQoderCreditsUsage } from "./protocol/usage.js";
import type { QoderMode } from "./region.js";

/** The host's usage-row member of the session-entry union (not re-exported by name). */
type UsageSessionEntry = Extract<SessionEntry, { type: "usage" }>;

/** QODER_WARM_BUDGET=off disables the cap; otherwise a positive spend fraction. */
export type Budget = { kind: "fraction"; fraction: number } | { kind: "off" };
export const DEFAULT_WARM_BUDGET_FRACTION = 0.5;

/** Missed warms in one since-last-real-dispatch span that latch the guard off. */
const MISS_LATCH_THRESHOLD = 2;

/**
 * Where the guard's rate came from. `conservative` is guard-only: it names a
 * pair derived from other models' economics, so persisting it onto a usage row
 * would claim a provenance the ledger never had. The persisted vocabulary is
 * pricing.ts's disjoint `credits | rate-table | fallback`.
 */
export type GuardRateSource = "fitted" | "learned" | "conservative" | "none";
export type GuardReason =
  | "approved"
  | "budget-reached"
  | "economics-unavailable"
  | "rate-unavailable"
  | "budget-off"
  | "miss-latched";

/** Everything the guard needs beyond the pi event; assembled by the handler. */
export interface GuardContextView {
  entries: SessionEntry[];
  modelId: string;
  mode: QoderMode;
  budget: Budget;
}

/** Injectable seams; production callers pass nothing and get the real profile read. */
export interface GuardDeps {
  readProfile?: () => LifetimeProfile | undefined;
  /**
   * Epoch milliseconds of the last real dispatch. Absent means the real
   * run-identity reader; a reader returning undefined (a process that has
   * dispatched no real turn) leaves the miss ceiling inert.
   */
  lastRealRequestAt?: () => number | undefined;
}

export interface GuardVerdict {
  action?: "warm" | "stop";
  reason: GuardReason;
  rateSource: GuardRateSource;
  spendUsd: number;
  protectedUsd: number;
}

/** The spend window and its anchor, derived from the branch on every decision. */
export interface GuardWindowView {
  spend: UsageSessionEntry[];
  anchorTokens: number | undefined;
  /**
   * The zero-cacheRead warm rows since the last real assistant row. Deliberately
   * NOT re-based with `spend` and not filtered by the real-turn clock: the
   * ceiling counts misses the spend window was made blind to, and the clock
   * filter is the verdict's job.
   */
  misses: UsageSessionEntry[];
}

/** USD-per-token pair for the protected-miss arithmetic (fitted or learned). */
export interface GuardRate {
  inputUsdPerToken: number;
  cacheReadUsdPerToken: number;
}

function promptTokensOf(usage: { input: number; cacheRead: number; cacheWrite: number }): number {
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function isCacheWarmEntry(entry: SessionEntry): entry is UsageSessionEntry {
  return entry.type === "usage" && entry.kind === "cache_warm";
}

/** A refresh that read nothing from cache: the entry it was meant to protect is gone. */
function isMissedWarm(row: UsageSessionEntry): boolean {
  return row.usage.cacheRead === 0;
}

// shape: none — one pass with three entry-type cases; a dispatch object for
//   three heterogeneous cases would obscure the sequential anchor semantics.
/**
 * Window isolation, mirroring cache-stats.scan anchors: the spend window is the
 * cache_warm rows after the last real assistant message (compaction does not
 * reset it — rows survive), while the anchor is the prompt size of the last
 * real assistant or warm row, reset by compaction/branch_summary.
 *
 * The spend slice also re-bases past the last missed warm: a miss is billed at
 * full input price precisely because the cache entry was lost, so charging that
 * cost against the entry the next refresh is meant to protect lets one eviction
 * consume the whole budget (BUG-0004). Cache-read hits stay in the window and
 * still bind the cap.
 */
export function windowEntries(entries: SessionEntry[]): GuardWindowView {
  let lastAssistantIndex = -1;
  let lastMissIndex = -1;
  let anchorTokens: number | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      // The context legitimately changed: the next decision needs a fresh anchor.
      anchorTokens = undefined;
      continue;
    }
    if (entry.type === "message" && entry.message.role === "assistant") {
      lastAssistantIndex = index;
      const tokens = promptTokensOf(entry.message.usage);
      if (tokens > 0) anchorTokens = tokens;
      continue;
    }
    if (isCacheWarmEntry(entry)) {
      const tokens = promptTokensOf(entry.usage);
      if (tokens > 0) anchorTokens = tokens;
      if (isMissedWarm(entry)) lastMissIndex = index;
    }
  }
  const warmSinceRealTurn = entries.slice(lastAssistantIndex + 1).filter(isCacheWarmEntry);
  return {
    spend: entries.slice(Math.max(lastAssistantIndex, lastMissIndex) + 1).filter(isCacheWarmEntry),
    anchorTokens,
    misses: warmSinceRealTurn.filter(isMissedWarm),
  };
}

// shape: none — one accumulator loop; USD end-to-end by construction.
/**
 * Sum the window in USD: charged Credits divided by the shared basis when
 * reported, else the row's priced `cost.total` (v2). Rows from before the cost
 * upgrade contribute exactly $0 (no Credits, zero priced cost) — a
 * one-directional under-count bounded by one straddling window.
 */
export function spendUsd(rows: readonly UsageSessionEntry[]): number {
  let total = 0;
  for (const row of rows) {
    const credits = parseQoderCreditsUsage(row.usage).credits;
    if (credits !== undefined) {
      total += credits / CREDITS_PER_USD;
      continue;
    }
    const priced = row.usage.cost.total;
    if (typeof priced === "number" && Number.isFinite(priced) && priced > 0) total += priced;
  }
  return total;
}

/** Extra USD the next real request pays if the cache entry is lost, for the
 *  anchor prompt: prompt tokens x (input rate - cache-read rate), per token. */
export function protectedUsd(anchorTokens: number, rate: GuardRate): number {
  const extraPerToken = Math.max(0, rate.inputUsdPerToken - rate.cacheReadUsdPerToken);
  return anchorTokens * extraPerToken;
}

/** A fitted-table entry (USD per 1M tokens) in the guard's per-token pair form. */
function fittedRate(entry: RateEntry): GuardRate {
  return { inputUsdPerToken: entry.input / 1_000_000, cacheReadUsdPerToken: entry.cacheRead / 1_000_000 };
}

/** A published learned fit (Credits per token) in the guard's per-token pair form. */
function learnedRate(fit: RateFit): GuardRate {
  return {
    inputUsdPerToken: fit.inputCreditsPerToken / CREDITS_PER_USD,
    cacheReadUsdPerToken: fit.cacheReadCreditsPerToken / CREDITS_PER_USD,
  };
}

// shape: none — one max/min accumulator over a list already normalized to the
//   guard's pair form; there is no discriminator left to dispatch on.
/**
 * The worst economics the extension has ever observed: the highest input rate
 * and the lowest cache-read rate over the fitted table union every published
 * learned fit. Taking each end from a different model is the point — a rate-less
 * model is priced at the top of the observed range, so its protected miss is
 * never understated and its refresh is never governed by a number invented for
 * it. Both ends stay finite and the pair is never all-zero: the fitted table's
 * members are frozen positive constants and `readProfile` rejects a non-finite
 * or negative fit (lifetime.ts parseRateFit), so the union cannot degenerate.
 * An empty union returns undefined and the sentinel stands.
 */
function conservativeRate(profile: LifetimeProfile | undefined): GuardRate | undefined {
  const universe: GuardRate[] = Object.values(RATE_TABLE).map(fittedRate);
  for (const estimate of Object.values(profile?.models ?? {})) {
    if (estimate.rateFit !== undefined) universe.push(learnedRate(estimate.rateFit));
  }
  let inputUsdPerToken: number | undefined;
  let cacheReadUsdPerToken: number | undefined;
  for (const rate of universe) {
    if (inputUsdPerToken === undefined || rate.inputUsdPerToken > inputUsdPerToken) {
      inputUsdPerToken = rate.inputUsdPerToken;
    }
    if (cacheReadUsdPerToken === undefined || rate.cacheReadUsdPerToken < cacheReadUsdPerToken) {
      cacheReadUsdPerToken = rate.cacheReadUsdPerToken;
    }
  }
  if (inputUsdPerToken === undefined || cacheReadUsdPerToken === undefined) return undefined;
  return { inputUsdPerToken, cacheReadUsdPerToken };
}

// shape: none — a three-rung lookup that ends in a sentinel; no dispatcher.
/**
 * Rate-source ladder: fitted table, then the published learned fit, then the
 * worst observed economics anywhere (conservative), then none.
 */
function resolveGuardRate(
  modelId: string,
  mode: QoderMode,
  deps: GuardDeps,
): { rate?: GuardRate; source: GuardRateSource } {
  const fitted = rateForModel(modelId, mode, (id, modelMode) => getCachedModelConfig(id, modelMode)?.key);
  if (fitted !== undefined) {
    return { rate: fittedRate(fitted), source: "fitted" };
  }
  // Read once for both remaining rungs, and only after the fitted rung: a
  // measured model must not pay a profile read per decision, as before.
  const profile = (deps.readProfile ?? readProfile)();
  const fit = profile?.models[modelId]?.rateFit;
  if (fit !== undefined) {
    return { rate: learnedRate(fit), source: "learned" };
  }
  const conservative = conservativeRate(profile);
  if (conservative !== undefined) {
    return { rate: conservative, source: "conservative" };
  }
  // Fail-safe for an empty universe, unreachable today: RATE_TABLE is
  // Object.freeze'd with three entries at pricing.ts:46-50 and is never mutated,
  // so the union rung 3 reads is never empty. It stays because the sentinel is
  // what evaluateGuard's rate-unavailable force-warm keys on, and because a
  // future table built from live data could legitimately come back empty —
  // inventing a rate there would be worse than reporting that nothing can price
  // the miss.
  return { source: "none" };
}

// shape: none — a single parse with two outcomes; one guard per failure mode.
/**
 * Parse QODER_WARM_BUDGET: positive fraction, `off` disables the cap, and any
 * other value falls back to the 0.5 default with exactly one debug entry
 * naming the raw value (a typo must not silently change the cap).
 */
export function parseBudgetEnv(raw: string | undefined): Budget {
  if (raw === undefined) return { kind: "fraction", fraction: DEFAULT_WARM_BUDGET_FRACTION };
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "fraction", fraction: DEFAULT_WARM_BUDGET_FRACTION };
  if (trimmed.toLowerCase() === "off") return { kind: "off" };
  const fraction = Number(trimmed);
  if (Number.isFinite(fraction) && fraction > 0) return { kind: "fraction", fraction };
  debugLog(`QODER_WARM_BUDGET "${trimmed}" is not a positive number or "off"; using ${DEFAULT_WARM_BUDGET_FRACTION}`);
  return { kind: "fraction", fraction: DEFAULT_WARM_BUDGET_FRACTION };
}

// shape: none — a single count over a homogeneous row set; no discriminator.
/** How many of the span's misses postdate the clock. An unparseable stamp is NaN,
 *  which fails the comparison, so a corrupt row cannot latch the guard. */
function missesSince(misses: readonly UsageSessionEntry[], clock: number): number {
  let count = 0;
  for (const row of misses) {
    if (Date.parse(row.timestamp) > clock) count += 1;
  }
  return count;
}

// shape: none — a fixed sequence of guards ending in one comparison; the
//   verdict reasons are strings, not a dispatch surface.
/**
 * Verdict rule (SA §5.3), USD end-to-end:
 *   budget off            -> warm (legacy force-warm; the cap cannot act)
 *   no fitted/learned rate -> warm (ungoverned fallback, reason rate-unavailable)
 *   no anchor row          -> stop (economics-unavailable)
 *   2+ misses since the last real dispatch -> stop (miss-latched, any fraction)
 *   spend < fraction x protected -> warm (approved), else stop (budget-reached)
 */
export function evaluateGuard(
  _event: CacheWarmingDecisionEvent,
  view: GuardContextView,
  deps: GuardDeps = {},
): GuardVerdict {
  const { spend, anchorTokens, misses } = windowEntries(view.entries);
  const spent = spendUsd(spend);
  const { rate, source } = resolveGuardRate(view.modelId, view.mode, deps);
  const protectedValue = rate !== undefined && anchorTokens !== undefined ? protectedUsd(anchorTokens, rate) : 0;

  if (view.budget.kind === "off") {
    return {
      action: "warm",
      reason: "budget-off",
      rateSource: source,
      spendUsd: spent,
      protectedUsd: protectedValue,
    };
  }
  if (source === "none") {
    return { action: "warm", reason: "rate-unavailable", rateSource: source, spendUsd: spent, protectedUsd: 0 };
  }
  if (anchorTokens === undefined) {
    return { action: "stop", reason: "economics-unavailable", rateSource: source, spendUsd: spent, protectedUsd: 0 };
  }
  // The re-based spend window is blind to misses by construction, so a cache
  // that evicts faster than the warmer can hold it would otherwise refresh at
  // full input price forever: two misses inside one since-last-real-dispatch
  // span latch the guard off at any fraction. An unstamped clock (fresh process,
  // subagent, module reset) leaves the ceiling inert rather than counting every
  // miss as postdating it.
  const clock = (deps.lastRealRequestAt ?? lastRealRequestAt)();
  if (clock !== undefined && missesSince(misses, clock) >= MISS_LATCH_THRESHOLD) {
    return {
      action: "stop",
      reason: "miss-latched",
      rateSource: source,
      spendUsd: spent,
      protectedUsd: protectedValue,
    };
  }
  const budgetUsd = view.budget.fraction * protectedValue;
  if (spent < budgetUsd) {
    return {
      action: "warm",
      reason: "approved",
      rateSource: source,
      spendUsd: spent,
      protectedUsd: protectedValue,
    };
  }
  return {
    action: "stop",
    reason: "budget-reached",
    rateSource: source,
    spendUsd: spent,
    protectedUsd: protectedValue,
  };
}
