// shape: none — a straight-line collector over the shared quota cache; the
//   tui/notify split is one branch on ctx.mode, below the dispatch-object
//   threshold.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  clearQoderQuotaCache,
  fetchQoderUsageCached,
  type QoderProviderUsage,
  type QoderUsageBucket,
  QUOTA_CACHE_TTL_MS,
} from "../auth/usage.js";
import { debugLog } from "../debug.js";
import { getQoderRegionConfig, QODER_MODES, type QoderMode } from "../region.js";

/**
 * The command renders into a local variable, so its own read is bounded
 * tighter than the shared cache default. The host usage view is not
 * user-blocked and keeps the cache's own budget.
 */
const QUOTA_FETCH_TIMEOUT_MS = 3_000;

// Re-exported so the command's public surface (and the tests) keep their
// existing import path while the cache itself now lives beside the fetch.
export { clearQoderQuotaCache };

/** One region's collected data; both the panel and the text report render from it. */
export interface QuotaSection {
  loginName: string;
  state:
    | { kind: "ready"; usage: QoderProviderUsage; servedFromCache: boolean; cacheAgeMs: number }
    | { kind: "error"; message: string };
}

/** Collect every configured region; `forceRefresh` skips the TTL for the panel's `r` key. */
async function collectQuotaSections(ctx: ExtensionCommandContext, forceRefresh = false): Promise<QuotaSection[]> {
  const sections: QuotaSection[] = [];
  for (const mode of QODER_MODES) {
    const region = getQoderRegionConfig(mode);
    const token = await ctx.modelRegistry.getApiKeyForProvider(region.providerID).catch(() => undefined);
    if (!token) continue;
    const before = Date.now();
    try {
      // One cache, one request: the shared cache is keyed by mode and already
      // carries the TTL and the in-flight dedupe, so the command no longer
      // keeps a private copy that a host usage view would bypass.
      const usage = await fetchQoderUsageCached({ access: token, refresh: "", expires: 0 }, mode, {
        timeoutMs: QUOTA_FETCH_TIMEOUT_MS,
        force: forceRefresh,
      });
      const cacheAge = Date.now() - before;
      sections.push({
        loginName: region.loginName,
        state: {
          kind: "ready",
          usage,
          // A cache hit returns in well under the TTL; a miss spends a request.
          servedFromCache: !forceRefresh && cacheAge < QUOTA_CACHE_TTL_MS,
          cacheAgeMs: cacheAge,
        },
      });
    } catch (error) {
      sections.push({
        loginName: region.loginName,
        state: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return sections;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2026-10-19T00:51:10.595Z" → "Oct 19, 2026" (the desktop app's `Renews on` form; UTC-stable). */
export function formatRenewalDate(isoTimestamp: string): string {
  const [year = "", month = "", day = ""] = isoTimestamp.slice(0, 10).split("-");
  const monthName = MONTH_NAMES[Number(month) - 1] ?? month;
  return `${monthName} ${Number(day)}, ${year}`;
}

function renderBucketText(bucket: QoderUsageBucket): string {
  if (bucket.available === false) return `${bucket.label}: Unavailable`;
  const unit = bucket.unit ? ` ${bucket.unit}` : "";
  const amount =
    bucket.limitDisplay !== undefined
      ? `${bucket.usedDisplay} / ${bucket.limitDisplay}${unit}`
      : `${bucket.usedDisplay}${unit}`;
  const percent = bucket.usedPercentDisplay !== undefined ? ` (used ${bucket.usedPercentDisplay})` : "";
  const pieces = [`${bucket.label}: ${amount}${percent}`];
  if (bucket.remainingDisplay !== undefined) pieces.push(`Remaining ${bucket.remainingDisplay}`);
  if (bucket.remainingUsdDisplay !== undefined) pieces.push(bucket.remainingUsdDisplay);
  return pieces.join(" — ");
}

/** Desktop-parity text for hosts without the terminal panel. */
export function renderQuotaText(sections: QuotaSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    if (section.state.kind === "error") {
      lines.push(`[${section.loginName}]`, `quota unavailable: ${section.state.message}`);
      continue;
    }
    const { usage, servedFromCache, cacheAgeMs } = section.state;
    // The renewal date is account-level (usage.resetAt), so it rides the section
    // header: pinning it to the first pool row lost it on a pool-less account —
    // the same coupling the rollup rows removed for remaining and cost.
    const renewal = usage.resetAt !== undefined ? formatRenewalDate(usage.resetAt) : undefined;
    const header = `[${section.loginName}]${usage.userType ? ` · ${usage.userType}` : ""}`;
    lines.push(renewal !== undefined ? `${header} — Renews on ${renewal}` : header);
    if (usage.exceeded) lines.push("Quota exceeded: new requests are blocked until the reset date");
    (usage.usageBuckets ?? []).forEach((bucket) => {
      lines.push(renderBucketText(bucket));
    });
    // Account-level rollup rows: computed from whatever buckets the payload
    // carried, so a pool cut by a Qoder migration cannot take the account's
    // remaining or cost with it.
    if (usage.totalCreditsBucket !== undefined) lines.push(renderBucketText(usage.totalCreditsBucket));
    if (usage.totalCostBucket !== undefined) lines.push(renderBucketText(usage.totalCostBucket));
    if ((usage.usageBuckets ?? []).length > 0) lines.push("Cost basis: 75 Credits/USD");
    if (usage.usageUrl) lines.push(`View details: ${usage.usageUrl}`);
    if (usage.exceeded && usage.upgradeUrl) lines.push(`Upgrade plan: ${usage.upgradeUrl}`);
    if (servedFromCache) lines.push(`(cached ${Math.round(cacheAgeMs / 1000)}s ago)`);
  }
  return lines.join("\n");
}

/**
 * F4: on-demand subscription quota. Manual command only — never touches the
 * turn path; a 60 s cache absorbs repeat invocations; concurrent invocations
 * share one in-flight fetch; failures print the reason with zero fabricated
 * numbers. In TUI mode the report opens as a compact panel; every other mode
 * keeps the text notification.
 */
export async function handleQuotaCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const sections = await collectQuotaSections(ctx);
  if (sections.length === 0) {
    ctx.ui.notify("Qoder quota unavailable: no Qoder credentials are configured.", "warning");
    return;
  }
  if (ctx.mode === "tui") {
    try {
      const { showQuotaPanel } = await import("./quota-view.js");
      await showQuotaPanel(ctx, { sections, refresh: () => collectQuotaSections(ctx, true) });
      return;
    } catch (error) {
      // The pi-tui virtual module is only guaranteed on TUI-capable hosts; a
      // panel that cannot load must not swallow the numbers.
      debugLog("qoder quota panel unavailable; falling back to text output", error);
    }
  }
  const exceeded = sections.some((section) => section.state.kind === "ready" && section.state.usage.exceeded === true);
  ctx.ui.notify(renderQuotaText(sections), exceeded ? "warning" : "info");
}
