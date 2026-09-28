// shape: none — §Vocabulary dispatch idioms do not apply: one boundary seam
//   (type predicates narrowing the unknown payload) feeding a straight-line
//   mapper into display-ready buckets.
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { fetchQoderJson, type QoderRequestOptions } from "../http.js";
import { getQoderRegionConfig, getQoderUsagePageURL, getQoderUsageURL, type QoderMode } from "../region.js";

/** One quota bucket as the command and the panel render it; display fields are preformatted. */
export interface QoderUsageBucket {
  id: string;
  label: string;
  usedDisplay: string;
  limitDisplay?: string;
  unit?: string;
  resetAt?: string;
  remainingDisplay?: string;
  /** "100%" — the desktop app's "(used N%)" value. */
  usedPercentDisplay?: string;
  /** 0..1 fill for the panel bar; absent when the API reports no percentage. */
  usedFraction?: number;
  /** `false` means the package exists but is not distributable right now ("Unavailable"). */
  available?: boolean;
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
  raw?: Record<string, unknown>;
}

const CREDITS_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function formatNumber(value: number): string {
  return CREDITS_FORMAT.format(value);
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

function toBucket(input: BucketInput): QoderUsageBucket {
  const quota = input.quota;
  const limit = quota.cap ?? quota.total;
  const derivedRemaining = limit !== undefined ? Math.max(0, limit - quota.used) : undefined;
  const remaining = input.deriveRemaining ? derivedRemaining : (quota.remaining ?? derivedRemaining);
  const percent = quota.percentage ?? (limit !== undefined && limit > 0 ? quota.used / limit : undefined);
  return {
    id: input.id,
    label: input.label,
    usedDisplay: formatNumber(quota.used),
    limitDisplay: limit !== undefined ? formatNumber(limit) : undefined,
    unit: quota.unit,
    resetAt: input.resetAt,
    remainingDisplay: remaining !== undefined ? formatNumber(remaining) : undefined,
    usedPercentDisplay: percent !== undefined ? `${Math.round(percent * 100)}%` : undefined,
    usedFraction: percent !== undefined ? Math.min(1, Math.max(0, percent)) : undefined,
    available: quota.available,
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
  if (usage.userQuota) {
    buckets.push(
      toBucket({ id: "user-quota", label: "Plan Credits", quota: usage.userQuota, deriveRemaining: false, resetAt }),
    );
  }
  if (usage.addOnQuota) {
    buckets.push(
      toBucket({ id: "add-on-quota", label: "Add-on Credits", quota: usage.addOnQuota, deriveRemaining: false }),
    );
  }
  if (usage.orgResourcePackage) {
    buckets.push(
      toBucket({
        id: "org-resource-package",
        label: "Shared Add-on Credits",
        quota: usage.orgResourcePackage,
        deriveRemaining: true,
      }),
    );
  }
  for (const [index, quota] of usage.dedicatedResourcePackages.entries()) {
    buckets.push(
      toBucket({
        id: `dedicated-resource-package-${index}`,
        label: "Dedicated Credits",
        quota,
        deriveRemaining: false,
      }),
    );
  }

  const planQuota = usage.userQuota;
  const summary =
    planQuota && planQuota.remaining !== undefined
      ? `${formatNumber(planQuota.remaining)} ${planQuota.unit ?? "credits"} remaining`
      : undefined;

  return {
    summary,
    exceeded: usage.isQuotaExceeded === true,
    subscriptionTitle: region.usageTitle,
    resetAt,
    manageUrl: region.manageUrl,
    usageUrl: getQoderUsagePageURL(mode),
    upgradeUrl: usage.upgradeUrl,
    userType: usage.userType,
    usageBuckets: buckets,
    raw: isRecord(payload) ? payload : undefined,
  };
}
