// shape: none — §Vocabulary dispatch idioms do not apply: one boundary seam
//   (type predicates narrowing the unknown payload) feeding a straight-line
//   mapper into display-ready buckets.
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { fetchQoderJson, type QoderRequestOptions } from "../http.js";
import { CREDITS_PER_USD } from "../pricing.js";
import { getQoderRegionConfig, getQoderUsagePageURL, getQoderUsageURL, type QoderMode } from "../region.js";

/** One quota bucket as the command and the panel render it; display fields are preformatted. */
export interface QoderUsageBucket {
  id: string;
  label: string;
  usedDisplay: string;
  limitDisplay?: string;
  /** Limit value in USD at the shared 75-Credits-per-USD basis, floored to cents. */
  limitUsdDisplay?: string;
  unit?: string;
  resetAt?: string;
  remainingDisplay?: string;
  /** Remaining value in USD at the shared basis, floored to cents. */
  remainingUsdDisplay?: string;
  /** "100%" — the desktop app's "(used N%)" value. */
  usedPercentDisplay?: string;
  /** 0..1 fill for the panel bar; absent when the API reports no percentage. */
  usedFraction?: number;
  /** `false` means the package exists but is not distributable right now ("Unavailable"). */
  available?: boolean;
  /**
   * Raw numeric amounts. The panel renders the preformatted `*Display`
   * strings; a host usage surface (`omp usage`) draws its own bars and
   * countdowns from numbers, so both forms are carried.
   */
  used?: number;
  limit?: number;
  remaining?: number;
}

export interface QoderProviderUsage {
  summary?: string;
  /** True when the account is over quota (raw `isQuotaExceeded`). */
  exceeded?: boolean;
  subscriptionTitle?: string;
  resetAt?: string;
  manageUrl?: string;
  /** "View details" target on the Qoder account page. */
  usageUrl?: string;
  /** Payload-provided pricing link, offered when the quota is exhausted. */
  upgradeUrl?: string;
  /** Account kind as reported by the API ("teams", "personal", …). */
  userType?: string;
  usageBuckets?: QoderUsageBucket[];
  /**
   * Account-level rollup row: Σused / Σlimit and the summed remaining over
   * every bucket the payload provided. Qoder's migrations change which pools
   * exist (the default/base pool was cut in the 2026 migration), so the
   * account's remaining and cost live here, computed from whatever buckets
   * are present — never tied to one pool's row. Present whenever any bucket is.
   */
  totalCreditsBucket?: QoderUsageBucket;
  /** The same rollup in USD at the shared basis: cost so far / USD granted. */
  totalCostBucket?: QoderUsageBucket;
  raw?: Record<string, unknown>;
  /** Raw `expiresAt` from the payload, for hosts that need a numeric reset. */
  expiresAt?: number;
}

const CREDITS_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function formatNumber(value: number): string {
  return CREDITS_FORMAT.format(value);
}

/**
 * Floor a Credit amount to cents at the shared basis. Display-only: the result
 * is never fed back into arithmetic, so flooring cannot accumulate error.
 */
function formatUsd(credits: number): string {
  const cents = Math.floor((credits / CREDITS_PER_USD) * 100);
  return `$${(cents / 100).toFixed(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Narrowed quota shape. The org package reports `cap`; plan and add-on quotas
 * report `total` — the desktop client's normalizer accepts `cap ?? total`, and
 * that tolerance is why the org bucket used to vanish when only `cap` was sent.
 * `used` gates inclusion: a package without a numeric `used` has nothing to show.
 */
interface NarrowedQuota {
  used: number;
  cap?: number;
  total?: number;
  remaining?: number;
  percentage?: number;
  unit?: string;
  available?: boolean;
}

function narrowQuota(source: Record<string, unknown>): NarrowedQuota | undefined {
  const used = readNumber(source, "used");
  if (used === undefined) return undefined;
  return {
    used,
    cap: readNumber(source, "cap"),
    total: readNumber(source, "total"),
    remaining: readNumber(source, "remaining"),
    percentage: readNumber(source, "percentage"),
    unit: readString(source, "unit"),
    available: readBoolean(source, "available"),
  };
}

interface NarrowedUsage {
  userQuota?: NarrowedQuota;
  addOnQuota?: NarrowedQuota;
  orgResourcePackage?: NarrowedQuota;
  dedicatedResourcePackages: NarrowedQuota[];
  expiresAt?: number;
  isQuotaExceeded?: boolean;
  upgradeUrl?: string;
  userType?: string;
}

function narrowUsage(payload: unknown): NarrowedUsage {
  if (!isRecord(payload)) return { dedicatedResourcePackages: [] };
  const dedicated: NarrowedQuota[] = [];
  const dedicatedRaw = payload.dedicatedResourcePackages;
  if (Array.isArray(dedicatedRaw)) {
    for (const item of dedicatedRaw) {
      if (!isRecord(item)) continue;
      const quota = narrowQuota(item);
      if (quota) dedicated.push(quota);
    }
  }
  return {
    userQuota: isRecord(payload.userQuota) ? narrowQuota(payload.userQuota) : undefined,
    addOnQuota: isRecord(payload.addOnQuota) ? narrowQuota(payload.addOnQuota) : undefined,
    orgResourcePackage: isRecord(payload.orgResourcePackage) ? narrowQuota(payload.orgResourcePackage) : undefined,
    dedicatedResourcePackages: dedicated,
    expiresAt: readNumber(payload, "expiresAt"),
    isQuotaExceeded: readBoolean(payload, "isQuotaExceeded"),
    upgradeUrl: readString(payload, "upgradeUrl"),
    userType: readString(payload, "userType"),
  };
}

interface BucketInput {
  id: string;
  label: string;
  quota: NarrowedQuota;
  /** Desktop re-derives org-package remaining from `cap - used`; other quotas keep the payload value. */
  deriveRemaining: boolean;
  resetAt?: string;
}

interface MadeBucket {
  bucket: QoderUsageBucket;
  limit?: number;
  remaining?: number;
}

function toBucket(input: BucketInput): MadeBucket {
  const quota = input.quota;
  const limit = quota.cap ?? quota.total;
  const derivedRemaining = limit !== undefined ? Math.max(0, limit - quota.used) : undefined;
  const remaining = input.deriveRemaining ? derivedRemaining : (quota.remaining ?? derivedRemaining);
  const percent = quota.percentage ?? (limit !== undefined && limit > 0 ? quota.used / limit : undefined);
  return {
    bucket: {
      id: input.id,
      label: input.label,
      usedDisplay: formatNumber(quota.used),
      limitDisplay: limit !== undefined ? formatNumber(limit) : undefined,
      limitUsdDisplay: limit !== undefined ? formatUsd(limit) : undefined,
      unit: quota.unit,
      resetAt: input.resetAt,
      remainingDisplay: remaining !== undefined ? formatNumber(remaining) : undefined,
      remainingUsdDisplay: remaining !== undefined ? formatUsd(remaining) : undefined,
      usedPercentDisplay: percent !== undefined ? `${Math.round(percent * 100)}%` : undefined,
      usedFraction: percent !== undefined ? Math.min(1, Math.max(0, percent)) : undefined,
      available: quota.available,
      used: quota.used,
      limit,
      remaining,
    },
    limit,
    remaining,
  };
}

export async function fetchQoderUsageForMode(
  credentials: OAuthCredentials,
  mode: QoderMode,
  options: QoderRequestOptions = {},
): Promise<QoderProviderUsage> {
  const region = getQoderRegionConfig(mode);
  // boundary: HTTP JSON → `unknown`, then isRecord + typeof readers before any field read (BND-1).
  const payload = await fetchQoderJson<unknown>(
    getQoderUsageURL(mode),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/json",
        "User-Agent": "pi-provider-qoder",
      },
    },
    options,
  );
  const usage = narrowUsage(payload);
  const resetAt = usage.expiresAt !== undefined ? new Date(usage.expiresAt).toISOString() : undefined;

  const buckets: QoderUsageBucket[] = [];
  // shape: none — accumulator closure inside the existing mapper; the rollup
  //   sums share toBucket's derivation via MadeBucket, no duplicated logic.
  let usedSum = 0;
  let limitSum = 0;
  let remainingSum = 0;
  let hasLimit = false;
  let hasRemaining = false;
  const pushBucket = (input: BucketInput): void => {
    const made = toBucket(input);
    usedSum += input.quota.used;
    if (made.limit !== undefined) {
      limitSum += made.limit;
      hasLimit = true;
    }
    if (made.remaining !== undefined) {
      remainingSum += made.remaining;
      hasRemaining = true;
    }
    buckets.push(made.bucket);
  };
  if (usage.userQuota) {
    pushBucket({ id: "user-quota", label: "Plan Credits", quota: usage.userQuota, deriveRemaining: false, resetAt });
  }
  if (usage.addOnQuota) {
    pushBucket({ id: "add-on-quota", label: "Add-on Credits", quota: usage.addOnQuota, deriveRemaining: false });
  }
  if (usage.orgResourcePackage) {
    pushBucket({
      id: "org-resource-package",
      label: "Shared Add-on Credits",
      quota: usage.orgResourcePackage,
      deriveRemaining: true,
    });
  }
  for (const [index, quota] of usage.dedicatedResourcePackages.entries()) {
    pushBucket({
      id: `dedicated-resource-package-${index}`,
      label: "Dedicated Credits",
      quota,
      deriveRemaining: false,
    });
  }
  const totalPercent = hasLimit && limitSum > 0 ? usedSum / limitSum : undefined;
  const totalPercentDisplay = totalPercent !== undefined ? `${Math.round(totalPercent * 100)}%` : undefined;
  const totalFraction = totalPercent !== undefined ? Math.min(1, Math.max(0, totalPercent)) : undefined;
  const totalCreditsBucket: QoderUsageBucket | undefined =
    buckets.length > 0
      ? {
          id: "total-credits",
          label: "Total Credits",
          usedDisplay: formatNumber(usedSum),
          limitDisplay: hasLimit ? formatNumber(limitSum) : undefined,
          remainingDisplay: hasRemaining ? formatNumber(remainingSum) : undefined,
          usedPercentDisplay: totalPercentDisplay,
          usedFraction: totalFraction,
        }
      : undefined;
  const totalCostBucket: QoderUsageBucket | undefined =
    buckets.length > 0
      ? {
          id: "total-cost",
          label: "Total Cost (USD)",
          usedDisplay: formatUsd(usedSum),
          limitDisplay: hasLimit ? formatUsd(limitSum) : undefined,
          // The remaining figure on this USD row is itself USD (owner's
          // prototype: "Remaining $159.69" lives on the cost row).
          remainingDisplay: hasRemaining ? formatUsd(remainingSum) : undefined,
          usedPercentDisplay: totalPercentDisplay,
          usedFraction: totalFraction,
        }
      : undefined;

  const planQuota = usage.userQuota;
  const summary =
    planQuota && planQuota.remaining !== undefined
      ? `${formatNumber(planQuota.remaining)} ${planQuota.unit ?? "credits"} remaining`
      : undefined;

  return {
    summary,
    exceeded: usage.isQuotaExceeded === true,
    resetAt,
    subscriptionTitle: region.usageTitle,
    expiresAt: usage.expiresAt,
    manageUrl: region.manageUrl,
    usageUrl: getQoderUsagePageURL(mode),
    upgradeUrl: usage.upgradeUrl,
    userType: usage.userType,
    usageBuckets: buckets,
    totalCreditsBucket,
    totalCostBucket,
    raw: isRecord(payload) ? payload : undefined,
  };
}

/**
 * One quota read per mode per TTL, shared by every surface.
 *
 * The cache lives here, beside the fetch, rather than in the command: a host
 * usage view can re-render or poll on its own schedule, and the command's
 * documented 60s cache is worthless if the host path bypasses it and spends a
 * fresh authenticated request per render. Keyed by mode because the regions are
 * separate accounts with separate quotas.
 */
export const QUOTA_CACHE_TTL_MS = 60_000;
const quotaCache = new Map<QoderMode, { usage: QoderProviderUsage; fetchedAt: number }>();
const quotaInflight = new Map<QoderMode, Promise<QoderProviderUsage>>();

/** Drop every cached quota read; the command's `r` key and the tests use it. */
export function clearQoderQuotaCache(): void {
  quotaCache.clear();
  quotaInflight.clear();
}

/**
 * `fetchQoderUsageForMode` with the shared TTL and single-flight dedupe.
 *
 * `force` skips the TTL only (a user-pressed refresh), never the in-flight
 * dedupe: two callers already waiting on the same request should share it even
 * if the second one asked for a refresh.
 */
export async function fetchQoderUsageCached(
  credentials: OAuthCredentials,
  mode: QoderMode,
  options: QoderRequestOptions & { force?: boolean } = {},
): Promise<QoderProviderUsage> {
  const cached = quotaCache.get(mode);
  if (!options.force && cached && Date.now() - cached.fetchedAt < QUOTA_CACHE_TTL_MS) return cached.usage;
  const pending = quotaInflight.get(mode);
  if (pending) return pending;
  const request = fetchQoderUsageForMode(credentials, mode, options).finally(() => quotaInflight.delete(mode));
  quotaInflight.set(mode, request);
  const usage = await request;
  quotaCache.set(mode, { usage, fetchedAt: Date.now() });
  return usage;
}
