// shape: none — collect-and-render: one aggregation pass over the scan samples
//   plus straight-line string assembly (context.ts precedent); the verdict is
//   two boolean conditions, below any dispatch threshold.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MODEL_PROMPT_CACHE } from "../catalog.js";
import {
  type LedgerScan,
  type LifetimeProfile,
  medianOf,
  PROFILE_STALE_MS,
  readProfile,
  SURVIVAL_MEDIAN,
  scanLedgers,
} from "../lifetime.js";
import { CREDITS_PER_USD } from "../pricing.js";
import { type Budget, parseBudgetEnv } from "../warm-guard.js";

/** On-demand scan budget: larger than the learner's 500 ms; files newest-first. */
export const CACHE_MONITOR_BUDGET_MS = 1500;
/** A refresh that read less than half its prompt from cache re-wrote the prefix. */
export const REWRITE_SHARE = 0.5;
/** Refreshes should be near-pure cache reads; below this the median is a warning. */
export const REFRESH_CACHE_READ_OK = 0.9;
/** Below this many gaps a model's survival median is too noisy to flag on. */
export const SURVIVAL_MIN_GAPS = 5;

export interface RefreshHealth {
  count: number;
  spendUsd: number;
  medianCacheReadShare: number | undefined;
  rewrites: number;
}

export interface ModelSurvivalHealth {
  modelId: string;
  gaps: number;
  medianRatio: number | undefined;
  probableMisses: number;
  pricedTurns: number;
}

export interface ModelProfileHealth {
  modelId: string;
  published: boolean;
  lifetimeSeconds: number;
  samples: number;
  computedAt: string | undefined;
  rSquared: number | undefined;
  stale: boolean;
}

export interface CacheHealth {
  filesScanned: number;
  scanTruncated: boolean;
  refreshes: RefreshHealth;
  survival: ModelSurvivalHealth[];
  profiles: ModelProfileHealth[];
  verdict: "ok" | "warn" | "inactive";
}

// shape: none — one aggregation pass plus two threshold conditions.
/**
 * Turn a ledger scan (always-on data) into warming health: did refreshes
 * happen, were they cheap cache reads rather than re-writes, did the cache
 * survive the idle windows between real turns, and what has the learner
 * published. Nothing here needs QODER_DEBUG.
 */
export function assessCacheHealth(
  scan: LedgerScan,
  profile: LifetimeProfile | undefined,
  now: number = Date.now(),
): CacheHealth {
  let spendUsd = 0;
  const shares: number[] = [];
  for (const row of scan.warm) {
    spendUsd += row.credits !== undefined ? row.credits / CREDITS_PER_USD : row.costTotal;
    if (row.promptTokens > 0) shares.push(row.cacheRead / row.promptTokens);
  }
  const refreshes: RefreshHealth = {
    count: scan.warm.length,
    spendUsd,
    medianCacheReadShare: medianOf(shares),
    rewrites: shares.filter((share) => share < REWRITE_SHARE).length,
  };

  const survival: ModelSurvivalHealth[] = Object.entries(scan.models)
    .filter(([, samples]) => samples.gaps.length > 0)
    .map(([modelId, samples]) => ({
      modelId,
      gaps: samples.gaps.length,
      medianRatio: medianOf(samples.gaps.map((gap) => gap.ratio)),
      probableMisses: samples.gaps.filter((gap) => gap.ratio < REWRITE_SHARE).length,
      pricedTurns: samples.turns.length,
    }))
    .sort((a, b) => b.gaps - a.gaps || a.modelId.localeCompare(b.modelId));

  const declaredDefault = MODEL_PROMPT_CACHE.short ?? 300;
  const ids = new Set([...Object.keys(scan.models), ...Object.keys(profile?.models ?? {})]);
  const profiles: ModelProfileHealth[] = [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((modelId) => {
      const entry = profile?.models[modelId];
      return {
        modelId,
        published: entry !== undefined,
        lifetimeSeconds: entry?.lifetimeSeconds ?? declaredDefault,
        samples: entry?.samples ?? scan.models[modelId]?.gaps.length ?? 0,
        computedAt: entry?.computedAt,
        rSquared: entry?.rateFit?.rSquared,
        stale: entry?.computedAt !== undefined && now - Date.parse(entry.computedAt) > PROFILE_STALE_MS,
      };
    });

  const refreshWarn =
    refreshes.count > 0 &&
    refreshes.medianCacheReadShare !== undefined &&
    refreshes.medianCacheReadShare < REFRESH_CACHE_READ_OK;
  const survivalWarn = survival.some(
    (model) => model.gaps >= SURVIVAL_MIN_GAPS && (model.medianRatio ?? 1) < SURVIVAL_MEDIAN,
  );
  const verdict = refreshes.count === 0 ? "inactive" : refreshWarn || survivalWarn ? "warn" : "ok";

  return {
    filesScanned: scan.files,
    scanTruncated: scan.exceededBudget,
    refreshes,
    survival,
    profiles,
    verdict,
  };
}

function shareText(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(2);
}

function ageText(computedAt: string | undefined, now: number): string {
  if (computedAt === undefined) return "age unknown";
  const ageMs = now - Date.parse(computedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "age unknown";
  if (ageMs < 3_600_000) return `${Math.max(1, Math.round(ageMs / 60_000))}m old`;
  if (ageMs < 48 * 3_600_000) return `${Math.round(ageMs / 3_600_000)}h old`;
  return `${Math.round(ageMs / 86_400_000)}d old`;
}

// shape: none — straight-line line assembly; one placeholder per empty section.
/** Render the health report. Every number comes from the scan or the profile —
 *  an empty section says so instead of inventing a value. */
export function renderCacheHealth(health: CacheHealth, now: number = Date.now()): string {
  const lines: string[] = [`Qoder cache warming — ${health.verdict.toUpperCase()}`];
  const truncation = health.scanTruncated ? " (budget reached — older sessions not scanned)" : "";
  lines.push(`  scanned ${health.filesScanned} session file(s), newest first${truncation}`);

  if (health.refreshes.count === 0) {
    lines.push("  refreshes: none recorded — check QODER_CACHE_WARM=1 and pi's cacheWarming setting");
  } else {
    lines.push(
      `  refreshes: ${health.refreshes.count} · $${health.refreshes.spendUsd.toFixed(4)} spent · ` +
        `median cache-read share ${shareText(health.refreshes.medianCacheReadShare)} · rewrites ${health.refreshes.rewrites}`,
    );
  }

  if (health.survival.length === 0) {
    lines.push("  survival: no natural idle gaps in the scanned window");
  } else {
    for (const model of health.survival) {
      lines.push(
        `  survival: ${model.modelId} · median ${shareText(model.medianRatio)} across ${model.gaps} gaps · ` +
          `${model.pricedTurns} priced turns · probable misses ${model.probableMisses}`,
      );
    }
  }

  for (const model of health.profiles) {
    const fit = model.rSquared === undefined ? "" : ` · rate fit R² ${model.rSquared.toFixed(3)}`;
    lines.push(
      model.published
        ? `  profile: ${model.modelId} · ${model.lifetimeSeconds} s (${model.samples} samples, ${ageText(model.computedAt, now)}${fit})${model.stale ? " [stale]" : ""}`
        : `  profile: ${model.modelId} · default ${model.lifetimeSeconds} s stands (${model.samples} natural gaps, no published estimate)`,
    );
  }

  lines.push(
    "  per-decision detail: QODER_DEBUG=1 (reason, rateSource, spend, protected, fraction); guard stops are not persisted",
  );
  return lines.join("\n");
}

function budgetLabel(budget: Budget): string {
  return budget.kind === "off" ? "off (uncapped)" : `${budget.fraction}`;
}

/**
 * `/qoder-cache` — warming health from the always-on surfaces (session ledgers
 * plus the learned profile), with the live knob state in front of it. On
 * demand, never on the turn path.
 */
export async function handleCacheCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const gateOn = process.env.QODER_CACHE_WARM === "1";
  const budget = parseBudgetEnv(process.env.QODER_WARM_BUDGET);
  const scan = scanLedgers(CACHE_MONITOR_BUDGET_MS);
  const health = assessCacheHealth(scan, readProfile(), Date.now());
  const config = `config: gate ${gateOn ? "ON" : "OFF (QODER_CACHE_WARM=1 enables)"} · budget ${budgetLabel(budget)}`;
  ctx.ui.notify(`${config}\n${renderCacheHealth(health)}`, health.verdict === "warn" ? "warning" : "info");
}
