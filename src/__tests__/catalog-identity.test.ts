// shape: none — three regressions for the catalog-refresh identity path, which
// exists because a live bug proved it: the signed catalog request must carry
// the caller's real uid. Qoder rejects the placeholder with
// `403 {"code":"105","message":"Login expired"}` and answers 200 with the model
// list for the real one (both verified against the live endpoint).
//
// The bug only appears on a host that does not persist credentials in
// `~/.pi/agent/auth.json` — OMP keeps them in `agent.db` — so
// `getCachedCredentials` returns null and the old code signed with the literal
// `"qoder-user"`. A test that only exercises the auth-file path would pass
// while the host that broke stays broken, so both cases below drive the
// exported session_start hook with no auth file and stub the catalog update
// they expect it to call, instead of exporting production internals for tests.
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerScan } from "../lifetime.js";

const RESOLVED_UID = "01a0809d-5d53-754f-a80b-a6cb580fa06c";
const patEnvNames = [
  "QODER_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODERCN_API_KEY",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
] as const;

afterEach(() => {
  for (const name of patEnvNames) delete process.env[name];
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function driveSessionStart(flow: {
  resolveQoderIdentity: () => Promise<unknown> | unknown;
}): Promise<{ updateQoderModelsCache: Mock }> {
  // No auth file at all: the host keeps credentials elsewhere, which is
  // exactly the case that regressed. vi.doMock factories are module-mocking
  // boundaries (a static import cannot stage per-test stubs), and the factory
  // import below stays lazy so it loads after those stubs are staged.
  vi.doMock("../auth/storage.js", () => ({
    readAuthFile: () => ({}),
    storeEnvironmentCredentials: vi.fn(),
  }));
  vi.doMock("../auth/oauth.js", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    // The cache misses, so the identity has to come from the token.
    getCachedCredentials: () => null,
    resolveQoderIdentity: vi.fn(flow.resolveQoderIdentity),
  }));

  const updateQoderModelsCache = vi.fn().mockResolvedValue(undefined);
  vi.doMock("../catalog.js", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    // Force the rebuild path regardless of the on-disk cache's age.
    isCacheStale: () => true,
    updateQoderModelsCache,
  }));

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
  };
  // Lazy by necessity: loading the factory here picks up the staged stubs.
  const { default: registerExtension } = await import("../index.js");
  // Empty scan: refreshing the catalog is the subject, not the learner.
  await registerExtension(pi as never, {
    scanLedgers: () => ({ models: {}, warm: [], files: 0, exceededBudget: false }) as LedgerScan,
  });
  // OMP supplies the caller's live token on session_start via the model
  // registry — the API key lookup pi calls with the provider id.
  const ctx = { modelRegistry: { getApiKeyForProvider: async () => "job-token" } };
  await handlers.get("session_start")?.({}, ctx);
  return { updateQoderModelsCache };
}

describe("model catalog refresh identity", () => {
  it("signs the catalog request with the uid resolved from the token, not a placeholder", async () => {
    const { updateQoderModelsCache } = await driveSessionStart({
      resolveQoderIdentity: () =>
        Promise.resolve({
          userID: RESOLVED_UID,
          email: "owner@example.com",
          name: "Owner",
          machineID: "machine",
        }),
    });

    // session_start refreshes both regions with the same caller token; both
    // must sign with the resolved uid, never the placeholder.
    expect(updateQoderModelsCache).toHaveBeenCalledTimes(2);
    for (const [token, uid] of updateQoderModelsCache.mock.calls as Array<[string, string]>) {
      expect(token).toBe("job-token");
      // The regression: this used to be the literal "qoder-user".
      expect(uid).toBe(RESOLVED_UID);
    }
  });

  it("skips the refresh when the identity cannot be resolved", async () => {
    const { updateQoderModelsCache } = await driveSessionStart({
      resolveQoderIdentity: () => Promise.reject(new Error("403")),
    });

    // Signing with a fabricated identity is worse than not refreshing: the
    // request would 403 forever and the cache would never self-heal.
    expect(updateQoderModelsCache).not.toHaveBeenCalled();
  });

  it("skips the refresh when the identity degrades to the placeholder", async () => {
    const { updateQoderModelsCache } = await driveSessionStart({
      resolveQoderIdentity: () =>
        Promise.resolve({
          userID: "qoder-user",
          email: "owner@example.com",
          name: "Owner",
          machineID: "machine",
        }),
    });

    // resolveQoderIdentity falls back to "qoder-user" when /userinfo is
    // unreachable; the catalog signature would 403 (business 105), so the
    // refresh must skip instead of stamping a placeholder-signed list.
    expect(updateQoderModelsCache).not.toHaveBeenCalled();
  });
});
