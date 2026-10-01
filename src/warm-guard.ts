// shape: none — pure decision module; one comparison with a reason string,
//   below the dispatch-object threshold (repo shape idiom).

import type { CacheWarmingDecisionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getCachedModelConfig } from "./catalog.js";
import { debugLog } from "./debug.js";
import { type LifetimeProfile, readProfile } from "./lifetime.js";
import { CREDITS_PER_USD, rateForModel } from "./pricing.js";
import { parseQoderCreditsUsage } from "./protocol/usage.js";
import type { QoderMode } from "./region.js";

/** The host's usage-row member of the session-entry union (not re-exported by name). */
type UsageSessionEntry = Extract<SessionEntry, { type: "usage" }>;

/** QODER_WARM_BUDGET=off disables the cap; otherwise a positive spend fraction. */
export type Budget = { kind: "fraction"; fraction: number } | { kind: "off" };
export const DEFAULT_WARM_BUDGET_FRACTION = 0.5;

export type GuardRateSource = "fitted" | "learned" | "none";
export type GuardReason = "approved" | "budget-reached" | "economics-unavailable" | "rate-unavailable" | "budget-off";

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

// shape: none — one pass with three entry-type cases; a dispatch object for
//   three heterogeneous cases would obscure the sequential anchor semantics.
/**
 * Window isolation, mirroring cache-stats.scan anchors: the spend window is the
 * cache_warm rows after the last real assistant message (compaction does not
 * reset it — rows survive), while the anchor is the prompt size of the last
 * real assistant or warm row, reset by compaction/branch_summary.
 */
export function windowEntries(entries: SessionEntry[]): GuardWindowView {
  let lastAssistantIndex = -1;
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
    }
  }
  return { spend: entries.slice(lastAssistantIndex + 1).filter(isCacheWarmEntry), anchorTokens };
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

// shape: none — a two-rung lookup that ends in a sentinel; no dispatcher.
/** Rate-source ladder: fitted table, then the published learned fit, then none. */
function resolveGuardRate(
  modelId: string,
  mode: QoderMode,
  deps: GuardDeps,
): { rate?: GuardRate; source: GuardRateSource } {
  const fitted = rateForModel(modelId, mode, (id, modelMode) => getCachedModelConfig(id, modelMode)?.key);
  if (fitted !== undefined) {
    return {
      rate: { inputUsdPerToken: fitted.input / 1_000_000, cacheReadUsdPerToken: fitted.cacheRead / 1_000_000 },
      source: "fitted",
    };
  }
  const fit = (deps.readProfile ?? readProfile)()?.models[modelId]?.rateFit;
  if (fit !== undefined) {
    return {
      rate: {
        inputUsdPerToken: fit.inputCreditsPerToken / CREDITS_PER_USD,
        cacheReadUsdPerToken: fit.cacheReadCreditsPerToken / CREDITS_PER_USD,
      },
      source: "learned",
    };
  }
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

// shape: none — a fixed sequence of guards ending in one comparison; the
//   verdict reasons are strings, not a dispatch surface.
/**
 * Verdict rule (SA §5.3), USD end-to-end:
 *   budget off            -> warm (legacy force-warm; the cap cannot act)
 *   no fitted/learned rate -> warm (ungoverned fallback, reason rate-unavailable)
 *   no anchor row          -> stop (economics-unavailable)
 *   spend < fraction x protected -> warm (approved), else stop (budget-reached)
 */
export function evaluateGuard(
  _event: CacheWarmingDecisionEvent,
  view: GuardContextView,
  deps: GuardDeps = {},
): GuardVerdict {
  const { spend, anchorTokens } = windowEntries(view.entries);
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
