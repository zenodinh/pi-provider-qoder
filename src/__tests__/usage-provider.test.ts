/**
 * OMP usage-surface mapping. The extension already parses Qoder's quota
 * payload for `/qoder-quota`; `omp usage` instead consumes a normalized
 * report (numeric amounts, status, absolute reset). These checks pin that
 * mapping against a fixture of the endpoint's real field names — a host
 * contract the extension does not own — so drift fails here rather than
 * showing up as an empty row in the host's usage view.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQoderUsageForMode } from "../auth/usage.js";
import { createQoderUsageProvider, toUsageReport } from "../usage-provider.js";

/** `GET /api/v2/quota/usage` as the account answers it today. */
const QUOTA_PAYLOAD = {
  userQuota: { used: 1200, total: 3000, remaining: 1800, unit: "Credits" },
  addOnQuota: { used: 50, cap: 50, remaining: 0, unit: "Credits" },
  orgResourcePackage: { used: 10, cap: 100 },
  expiresAt: 1790000000000,
  isQuotaExceeded: false,
  upgradeUrl: "https://qoder.com/pricing",
  userType: "personal",
};

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

const CREDENTIAL = { access: "access-token", refresh: "refresh-token", expires: Date.now() + 3_600_000 };

afterEach(() => vi.unstubAllGlobals());

describe("Qoder usage report for a host usage surface", () => {
  it("maps each quota bucket to a limit with numeric amounts and a reset window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(QUOTA_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const usage = await fetchQoderUsageForMode(CREDENTIAL, "global");
    const report = toUsageReport(usage, "qoder");

    expect(report).not.toBeNull();
    // Account rollups lead (Qoder's migrations change which pools exist, so a
    // pool-only view moves for reasons the user cannot see), then the pools.
    expect(report?.limits.map((limit) => limit.id)).toEqual([
      "total-credits",
      "total-cost",
      "user-quota",
      "add-on-quota",
      "org-resource-package",
    ]);

    const plan = report?.limits[2];
    expect(plan?.amount).toMatchObject({ used: 1200, limit: 3000, remaining: 1800, unit: "credits" });
    expect(plan?.status).toBe("ok");
    expect(plan?.label).toBe("Plan Credits");
    // `expiresAt` is the payload's own reset boundary, carried as an absolute
    // timestamp because the host renders the countdown itself.
    expect(plan?.window?.resetsAt).toBe(1790000000000);

    // A bucket with nothing left is exhausted, whatever the fraction says.
    expect(report?.limits[3]?.status).toBe("exhausted");
    expect(report?.limits[3]?.amount.remaining).toBe(0);

    // The org package reports `cap` and no remaining: derived, not invented.
    expect(report?.limits[4]?.amount).toMatchObject({ used: 10, limit: 100, remaining: 90 });

    expect(report?.notes?.join(" ")).toContain("personal");
  });

  it("flags a plan at ninety percent or above as a warning", () => {
    const report = toUsageReport(
      {
        usageBuckets: [
          {
            id: "user-quota",
            label: "Plan Credits",
            usedDisplay: "2,700",
            used: 2700,
            limit: 3000,
            remaining: 300,
            usedFraction: 0.9,
          },
        ],
      },
      "qoder",
      1750000000000,
    );
    expect(report?.limits[0]?.status).toBe("warning");
    expect(report?.fetchedAt).toBe(1750000000000);
  });

  it("honours the endpoint's exceeded flag over the per-bucket arithmetic", () => {
    const report = toUsageReport(
      {
        exceeded: true,
        usageBuckets: [
          { id: "user-quota", label: "Plan Credits", usedDisplay: "100", used: 100, limit: 3000, remaining: 2900 },
        ],
      },
      "qoder",
    );
    expect(report?.limits[0]?.status).toBe("exhausted");
  });

  it("reports an unrecognized unit as unknown instead of guessing credits", () => {
    const report = toUsageReport(
      { usageBuckets: [{ id: "requests", label: "Requests", usedDisplay: "1", unit: "seats", used: 1, limit: 10 }] },
      "qoder",
    );
    expect(report?.limits[0]?.amount.unit).toBe("unknown");
  });

  it("returns no report when the account has no quota buckets to show", () => {
    expect(toUsageReport({ usageBuckets: [] }, "qoder")).toBeNull();
  });

  it("fetches through the provider using the stored grant and names the provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(QUOTA_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createQoderUsageProvider("global", "qoder");

    expect(provider.id).toBe("qoder");
    const report = await provider.fetchUsage({ credential: CREDENTIAL });
    expect(report?.provider).toBe("qoder");
    expect(report?.limits).toHaveLength(5);
    // The quota endpoint is account-wide, so a failure here must not be read
    // as a broken credential by the host's health checks.
    expect(provider.validatesCredentials).toBe(false);

    await expect(provider.fetchUsage({ credential: { access: "" } })).resolves.toBeNull();
  });
});
