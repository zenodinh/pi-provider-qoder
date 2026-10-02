// Qoder usage, shaped for a host usage surface (`omp usage`).
//
// Qoder's quota endpoint (already used by the `/qoder-quota` command) answers
// with Credit amounts and a reset date per bucket. Hosts with a built-in usage
// view render a *normalized* report — `limits[]` with numeric amounts, a
// status, and a window carrying an absolute reset timestamp — so this module is
// the seam between the payload the extension already parses and that contract.
//
// Why local structural types: pi's published `ProviderConfig` has no `usage`
// slot (only OMP's does), so importing host types would either fail to resolve
// on pi or force pi's narrower shape onto the registration. The fields below
// mirror the host contract one-for-one; the adapter is a value-level mapping,
// and `src/__tests__/usage-provider.test.ts` asserts the mapping against a
// fixture of the real endpoint's payload so a host-contract drift shows up as
// a failing test rather than an empty `omp usage` row.
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { fetchQoderUsageCached, type QoderProviderUsage, type QoderUsageBucket } from "./auth/usage.js";
import type { QoderMode } from "./region.js";

export interface UsageAmount {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  unit: "percent" | "tokens" | "requests" | "credits" | "usd" | "minutes" | "bytes" | "unknown";
}

export interface UsageWindow {
  id: string;
  label: string;
  resetsAt?: number;
}

export interface UsageLimit {
  id: string;
  label: string;
  scope: { provider: string; tier?: string };
  window?: UsageWindow;
  amount: UsageAmount;
  status?: "ok" | "warning" | "exhausted" | "unknown";
  notes?: string[];
}

export interface UsageReport {
  provider: string;
  fetchedAt: number;
  limits: UsageLimit[];
  notes?: string[];
  metadata?: Record<string, unknown>;
}

export interface UsageProvider {
  id: string;
  fetchUsage(params: { credential: unknown; signal?: AbortSignal }): Promise<UsageReport | null>;
  /** The fetch authenticates the credential upstream, but a failure here must
   * not mark it unhealthy: quota reads are account-wide, not per-credential. */
  validatesCredentials?: boolean;
}

const KNOWN_UNITS = new Set<UsageAmount["unit"]>([
  "percent",
  "tokens",
  "requests",
  "credits",
  "usd",
  "minutes",
  "bytes",
]);

function unitFor(raw: string | undefined): UsageAmount["unit"] {
  const lowered = raw?.toLowerCase();
  if (lowered && KNOWN_UNITS.has(lowered as UsageAmount["unit"])) return lowered as UsageAmount["unit"];
  return lowered ? "unknown" : "credits";
}

function statusFor(
  usedFraction: number | undefined,
  remaining: number | undefined,
  exceeded: boolean,
): "ok" | "warning" | "exhausted" {
  if (exceeded || (remaining !== undefined && remaining <= 0)) return "exhausted";
  if (usedFraction !== undefined && usedFraction >= 0.9) return "warning";
  return "ok";
}

/** Map the parsed quota payload onto the host's normalized report. */
export function toUsageReport(
  usage: QoderProviderUsage,
  providerID: string,
  fetchedAt = Date.now(),
): UsageReport | null {
  const buckets = usage.usageBuckets ?? [];
  if (buckets.length === 0) return null;
  const resetsAt = usage.expiresAt ?? (usage.resetAt !== undefined ? Date.parse(usage.resetAt) : undefined);
  const rowFor = (bucket: QoderUsageBucket): UsageLimit => {
    const usedFraction =
      bucket.usedFraction ??
      (bucket.limit !== undefined && bucket.limit > 0 && bucket.used !== undefined
        ? bucket.used / bucket.limit
        : undefined);
    return {
      id: bucket.id,
      label: bucket.label,
      scope: { provider: providerID },
      ...(resetsAt !== undefined
        ? { window: { id: "period", label: usage.subscriptionTitle ?? "Billing period", resetsAt } }
        : {}),
      amount: {
        unit: unitFor(bucket.unit),
        ...(bucket.used !== undefined ? { used: bucket.used } : {}),
        ...(bucket.limit !== undefined ? { limit: bucket.limit } : {}),
        ...(bucket.remaining !== undefined ? { remaining: bucket.remaining } : {}),
        ...(usedFraction !== undefined ? { usedFraction: Math.min(1, Math.max(0, usedFraction)) } : {}),
      },
      status: statusFor(usedFraction, bucket.remaining, usage.exceeded === true),
      ...(bucket.available === false ? { notes: ["Package exists but is not distributable right now."] } : {}),
    };
  };
  // Account rollups first, then the per-pool breakdown. Qoder's migrations
  // change which pools exist on an account, so a view built from the pool rows
  // alone reports a remaining-and-cost figure that moves for reasons the user
  // cannot see; the rollups are the stable account-level answer and the pools
  // are its breakdown.
  const limits: UsageLimit[] = [
    ...(usage.totalCreditsBucket ? [rowFor(usage.totalCreditsBucket)] : []),
    ...(usage.totalCostBucket ? [rowFor(usage.totalCostBucket)] : []),
    ...buckets.map(rowFor),
  ];
  const notes: string[] = [];
  if (usage.userType) notes.push(`Account kind: ${usage.userType}`);
  if (usage.summary) notes.push(usage.summary);
  if (usage.manageUrl) notes.push(`Manage: ${usage.manageUrl}`);
  return { provider: providerID, fetchedAt, limits, notes };
}

/**
 * The `usage:` slot of the provider registration. Credential access follows the
 * OAuth grant the extension mints (`cred.access`, same field `getApiKey` reads).
 */
export function createQoderUsageProvider(mode: QoderMode, providerID: string): UsageProvider {
  return {
    id: providerID,
    validatesCredentials: false,
    async fetchUsage(params) {
      // OMP stores the grant as an oauth credential; `access` is the same
      // field `oauth.getApiKey` reads. Anything without it is not ours to ask.
      const cred = params.credential as Partial<OAuthCredentials> | undefined;
      // An absent token is not a failure to report — it is nothing to ask with.
      if (typeof cred?.access !== "string" || cred.access.length === 0) return null;
      try {
        // Shared cache: a host usage view re-renders on its own schedule, and
        // this surface must not spend a fresh authenticated read per render.
        const usage = await fetchQoderUsageCached(cred as OAuthCredentials, mode, { signal: params.signal });
        return toUsageReport(usage, providerID);
      } catch {
        // A quota read failing says nothing about the credential
        // (`validatesCredentials: false` already reflects that), and a host
        // usage surface renders "no data" perfectly well. Rejecting instead
        // would surface a network blip as a provider error on a provider that
        // is serving turns fine.
        return null;
      }
    },
  };
}
