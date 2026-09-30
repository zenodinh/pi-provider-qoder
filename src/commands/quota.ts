// shape: none — module-scope cache state (trigger #3, one instance per
//   process) plus a straight-line collector; the tui/notify split is one branch
//   on ctx.mode, below the dispatch-object threshold.
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchQoderUsageForMode, type QoderProviderUsage, type QoderUsageBucket } from "../auth/usage.js";
import { debugLog } from "../debug.js";
import { getQoderRegionConfig, QODER_MODES, type QoderMode } from "../region.js";

const QUOTA_CACHE_TTL_MS = 60_000;
const QUOTA_FETCH_TIMEOUT_MS = 3_000;

interface QuotaCacheEntry {
  usage: QoderProviderUsage;
  fetchedAt: number;
}

const quotaCache = new Map<QoderMode, QuotaCacheEntry>();
const inflight = new Map<QoderMode, Promise<QoderProviderUsage>>();

/** Test-only resetter, alongside the fork's existing resetter pattern. */
export function clearQoderQuotaCache(): void {
  quotaCache.clear();
  inflight.clear();
}

function fetchUsage(credentials: OAuthCredentials, mode: QoderMode): Promise<QoderProviderUsage> {
  const pending = inflight.get(mode);
  if (pending) return pending;
  const request = fetchQoderUsageForMode(credentials, mode, { timeoutMs: QUOTA_FETCH_TIMEOUT_MS }).finally(() => {
    inflight.delete(mode);
  });
  inflight.set(mode, request);
  return request;
}

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
    const cached = quotaCache.get(mode);
    const cacheAge = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
    if (!forceRefresh && cached && cacheAge < QUOTA_CACHE_TTL_MS) {
      sections.push({
        loginName: region.loginName,
        state: { kind: "ready", usage: cached.usage, servedFromCache: true, cacheAgeMs: cacheAge },
      });
      continue;
    }
    try {
      const usage = await fetchUsage({ access: token, refresh: "", expires: 0 }, mode);
      quotaCache.set(mode, { usage, fetchedAt: Date.now() });
      sections.push({
        loginName: region.loginName,
        state: { kind: "ready", usage, servedFromCache: false, cacheAgeMs: 0 },
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

function renderBucketText(bucket: QoderUsageBucket, renewal?: string): string {
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
  if (renewal !== undefined) pieces.push(`Renews on ${renewal}`);
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
    lines.push(`[${section.loginName}]${usage.userType ? ` · ${usage.userType}` : ""}`);
    if (usage.exceeded) lines.push("Quota exceeded: new requests are blocked until the reset date");
    const renewal = usage.resetAt !== undefined ? formatRenewalDate(usage.resetAt) : undefined;
    (usage.usageBuckets ?? []).forEach((bucket, index) => {
      lines.push(renderBucketText(bucket, index === 0 ? renewal : undefined));
    });
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
