import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Api, ModelCost, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  autoLoginQoderFromEnvironment,
  getCachedCredentials,
  loginQoderForMode,
  refreshQoderTokenForMode,
} from "./auth/oauth.js";
import { fetchQoderUsageForMode } from "./auth/usage.js";
import {
  getCachedModelConfig,
  getCachedModels,
  isCacheStale,
  MODEL_PROMPT_CACHE,
  staticCnModels,
  staticModels,
  updateQoderModelsCache,
} from "./catalog.js";
import { handleContextCommand } from "./commands/context.js";
import { handleQuotaCommand } from "./commands/quota.js";
import { debugLog } from "./debug.js";
import { getPiAgentDir } from "./home.js";
import {
  clampLifetimeSeconds,
  LEARNER_BUDGET_MS,
  type LedgerScan,
  type LifetimeProfile,
  learnProfile,
  profileValuesChanged,
  type RateFit,
  readProfile,
  scanLedgers,
  writeProfile,
} from "./lifetime.js";
import { CREDITS_PER_USD, rateForUpstreamKey } from "./pricing.js";
import { streamQoderRouter } from "./protocol/router.js";
import { getQoderBaseUrl, getQoderRegionConfig, QODER_MODES, type QoderMode } from "./region.js";
import { evaluateGuard, parseBudgetEnv } from "./warm-guard.js";

// pi reads a `fetchUsage` hook off the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Extend it locally so the hook is
// typed instead of smuggled through an `as unknown` cast.
type QoderOAuth = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

type QoderProviderModel = NonNullable<ProviderConfig["models"]>[number];

/**
 * Test seams for the extension factory. Production pi calls the factory with
 * only the API; tests inject the learned profile and the learner's scan/write
 * steps so no session file or network is touched.
 */
export interface QoderExtensionDeps {
  /** Factory-time learned profile; each registration falls back to readProfile(). */
  profile?: LifetimeProfile;
  scanLedgers?: (budgetMs: number) => LedgerScan;
  writeProfile?: (profile: LifetimeProfile) => void;
}

const QODER_API = "qoder-api" as Api;

async function registerQoderApi(): Promise<void> {
  try {
    const compat = await import("@earendil-works/pi-ai/compat");
    const register = (compat as Record<string, unknown>).registerApiProvider;
    if (typeof register !== "function") return; // OMP / hosts without the export
    (register as (config: unknown, source: string) => void)(
      { api: QODER_API, stream: streamQoderRouter, streamSimple: streamQoderRouter },
      "provider:qoder",
    );
  } catch (error) {
    // Host has no compat registry; registerProvider(streamSimple) is enough.
    debugLog("pi-ai/compat registerApiProvider unavailable", error);
  }
}

/** USD per 1M tokens from a learned Credits-per-token fit (cacheWrite mirrors input). */
function costFromRateFit(fit: RateFit): ModelCost {
  const perMillion = (creditsPerToken: number): number => (creditsPerToken * 1_000_000) / CREDITS_PER_USD;
  return {
    input: perMillion(fit.inputCreditsPerToken),
    output: perMillion(fit.outputCreditsPerToken),
    cacheRead: perMillion(fit.cacheReadCreditsPerToken),
    cacheWrite: perMillion(fit.inputCreditsPerToken),
  };
}

function modelsForProvider(
  mode: QoderMode,
  providerID: string,
  profile: LifetimeProfile | undefined = readProfile(),
): QoderProviderModel[] {
  const cached = getCachedModels(mode);
  const modelsToUse = cached.length > 0 ? cached : mode === "cn" ? staticCnModels : staticModels;

  return modelsToUse.map((m) => {
    const learned = profile?.models[m.id];
    const upstreamKey = m.upstreamKey ?? getCachedModelConfig(m.id, mode)?.key;
    return {
      ...m,
      provider: providerID,
      baseUrl: getQoderBaseUrl(mode),
      // A catalog parsed from disk may predate the declared lifetime; without it
      // pi treats the cache as unknown and never warms. A published learned
      // lifetime overrides the declared one, clamped to its defensive bounds.
      promptCache:
        learned?.lifetimeSeconds !== undefined
          ? { ...(m.promptCache ?? MODEL_PROMPT_CACHE), short: clampLifetimeSeconds(learned.lifetimeSeconds) }
          : (m.promptCache ?? MODEL_PROMPT_CACHE),
      // Learned rates price only models the hand-fitted table cannot: a fitted
      // key already carries its measured rates, and overriding it would trade a
      // measured form for a modeled one.
      ...(learned?.rateFit !== undefined && rateForUpstreamKey(upstreamKey) === undefined
        ? { cost: costFromRateFit(learned.rateFit) }
        : {}),
    };
  });
}

function createQoderOAuth(mode: QoderMode): QoderOAuth {
  const region = getQoderRegionConfig(mode);
  return {
    name: region.loginName,
    login: (callbacks) => loginQoderForMode(callbacks, mode),
    refreshToken: (credentials, signal) => refreshQoderTokenForMode(credentials, mode, signal),
    getApiKey: (cred: OAuthCredentials) => cred.access,
    // NOTE: no `modifyModels` hook on purpose. OMP (Bun) does a whole-catalog
    // structuredClone before invoking it, and its bundled catalog contains a
    // model with a non-cloneable property -> "The object can not be cloned."
    // removes qoder from `omp models`. Models are supplied at registration
    // via `modelsForProvider` and refreshed by the startup/session cache hooks.
    fetchUsage: (credentials) => fetchQoderUsageForMode(credentials, mode),
  };
}

function registerQoderProvider(pi: ExtensionAPI, mode: QoderMode, profile?: LifetimeProfile): void {
  const providerID = getQoderRegionConfig(mode).providerID;
  pi.registerProvider(providerID, {
    baseUrl: getQoderBaseUrl(mode),
    api: QODER_API,
    models: modelsForProvider(mode, providerID, profile),
    oauth: createQoderOAuth(mode),
    streamSimple: streamQoderRouter,
  });
}

/**
 * Install-time migration (F1): the published pi-provider-qoder@0.4.5 must never
 * run alongside this package — pi silently merges duplicate provider ids
 * per-key into a franken-config with zero diagnostics. pi exposes no install
 * hook, so migration happens at startup: detect the old package on disk, evict
 * its queued registration before ours, and tell the owner the one removal
 * command. The `.orig-0.4.5` backup from the diagnostic patch rides along with
 * npm's whole-dir uninstall.
 */
function detectLegacyPackage(): { present: boolean; patched: boolean } {
  const dir = join(getPiAgentDir(), "npm", "node_modules", "pi-provider-qoder");
  return {
    present: existsSync(join(dir, "package.json")),
    patched: existsSync(join(dir, "dist", "index.js.orig-0.4.5")),
  };
}

function warnLegacyPackage(patched: boolean): void {
  console.error(
    `[pi-provider-qoder] The published pi-provider-qoder package is still installed alongside this one. ` +
      `Remove it with: pi remove npm:pi-provider-qoder` +
      (patched ? " (its patched dist/ files, including index.js.orig-0.4.5, are removed with it)" : ""),
  );
}

/**
 * Rebuild the model cache for `mode` when it is missing, stale (>1h old), or
 * was fetched for a different account. Identity comes from the auth file
 * (keyed by token) with region fallbacks, so a registry/startup token and an
 * auth-file record both work. Login/refresh are the other rebuild triggers;
 * this covers startup and the case where the cache was deleted while the token
 * is still valid.
 */
async function refreshQoderModelsCache(mode: QoderMode, accessToken?: string): Promise<void> {
  const region = getQoderRegionConfig(mode);
  const providerID = region.providerID;
  const token = accessToken ?? getCachedCredentials("", providerID)?.access;
  if (!token) return;
  const creds = getCachedCredentials(token, providerID);
  // Rebuild when the cache is missing, older than an hour, or was fetched for
  // a different account.
  if (!isCacheStale(mode, creds?.userID)) return;
  await updateQoderModelsCache(
    token,
    creds?.userID || "qoder-user",
    creds?.name || region.userNameFallback,
    creds?.email || region.userEmailFallback,
    mode,
  );
}

export default async function (pi: ExtensionAPI, deps: QoderExtensionDeps = {}) {
  await registerQoderApi();

  const legacy = detectLegacyPackage();
  if (legacy.present) {
    for (const mode of QODER_MODES) pi.unregisterProvider(getQoderRegionConfig(mode).providerID);
    warnLegacyPackage(legacy.patched);
  }

  // Global and CN are independent (separate PAT env vars, cache files, base
  // URLs), so initialize them concurrently to cut startup time in half instead
  // of chaining their network round-trips sequentially. Each mode keeps its own
  // failure boundary so one bad region cannot block the other. They share
  // auth.json; the host credential store serializes updates under its lock.
  await Promise.all(
    QODER_MODES.map(async (mode) => {
      const providerID = getQoderRegionConfig(mode).providerID;
      try {
        await autoLoginQoderFromEnvironment(providerID, mode);
        await refreshQoderModelsCache(mode);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[pi-provider-qoder] Automatic login failed for ${providerID}: ${message}`);
      }
    }),
  );

  // Refresh once per session at startup if the cache is missing or stale,
  // rather than on every message in the stream hot path.
  pi.on("session_start", async (_event, ctx) => {
    if (legacy.present) {
      // Post-bind re-check: a user-reordered package list can make the
      // factory-time eviction miss; post-bind unregister closes that gap.
      for (const mode of QODER_MODES) {
        const providerID = getQoderRegionConfig(mode).providerID;
        pi.unregisterProvider(providerID);
        registerQoderProvider(pi, mode);
      }
    }
    // The two regions are independent (own token, cache file, base URL), so
    // refresh them concurrently instead of letting a slow catalog fetch for one
    // delay the other.
    await Promise.all(
      QODER_MODES.map(async (mode) => {
        try {
          const providerID = getQoderRegionConfig(mode).providerID;
          const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerID);
          if (!accessToken) return;
          await refreshQoderModelsCache(mode, accessToken);
        } catch (error) {
          // Best-effort: fall back to the existing cache / static models.
          debugLog(`session_start model catalog refresh failed for ${mode}`, error);
        }
      }),
    );

    // Learn per-model cache lifetimes and rates from the session ledgers, write
    // them atomically, and feed them back through re-registration. Best-effort:
    // a failed scan or write keeps the prior profile in force and never blocks
    // startup (the extension must not die from an auxiliary failure).
    try {
      const prior = readProfile();
      const scan = (deps.scanLedgers ?? scanLedgers)(LEARNER_BUDGET_MS);
      const learned = learnProfile(scan, prior);
      if (Object.keys(learned.models).length === 0) return;
      (deps.writeProfile ?? writeProfile)(learned);
      if (profileValuesChanged(prior, learned)) {
        for (const mode of QODER_MODES) registerQoderProvider(pi, mode, learned);
      }
    } catch (error) {
      debugLog("session_start cache-lifetime learning failed", error);
    }
  });

  // Cache warming is inert for these models by default: pi prices them at $0
  // (Qoder bills in Credits, which pi's monetary cost cannot express), so the
  // "$0.05 expected savings" floor can never be cleared and pi stops every
  // refresh before sending it. QODER_CACHE_WARM=1 approves the refresh anyway;
  // each one costs a cache read plus one output token, ~50x cheaper than the
  // idle re-bill it prevents. Warming still requires the model's declared
  // promptCache tier (catalog.ts) and pi's `cacheWarming: "idle"` setting, and
  // the override is scoped to this extension's two providers so it never
  // spends another provider's tokens. With the gate on, the refresh budget is
  // governed per opportunity: spend since the last real turn is compared in
  // USD against a fraction of the protected miss, and models without a usable
  // rate keep the legacy force-warm (warm-guard.ts).
  // shape: none — dispatch object does not apply: one env gate over pi's own decision.
  pi.on("cache_warming_decision", (event, ctx) => {
    if (process.env.QODER_CACHE_WARM !== "1") return undefined;
    const model = ctx.model;
    if (!model || (model.provider !== "qoder" && model.provider !== "qoder-cn")) return undefined;
    const mode: QoderMode = model.provider === "qoder-cn" ? "cn" : "global";
    const budget = parseBudgetEnv(process.env.QODER_WARM_BUDGET);
    const verdict = evaluateGuard(event, {
      entries: ctx.sessionManager.getBranch(),
      modelId: model.id,
      mode,
      budget,
    });
    debugLog(
      `cache warming verdict: action=${verdict.action} reason=${verdict.reason} rateSource=${verdict.rateSource} ` +
        `spendUsd=${verdict.spendUsd.toFixed(6)} protectedUsd=${verdict.protectedUsd.toFixed(6)} ` +
        `fraction=${budget.kind === "fraction" ? budget.fraction : "off"}`,
    );
    if (verdict.action === undefined || verdict.action === event.action) return undefined;
    return { action: verdict.action };
  });

  pi.registerCommand("qoder-quota", {
    description: "Show Qoder subscription quota (remaining and reset date), on demand",
    handler: handleQuotaCommand,
  });

  pi.registerCommand("qoder-context", {
    description: "Show or set Qoder model context window and compaction thresholds (percent-based), on demand",
    handler: handleContextCommand,
  });

  for (const mode of QODER_MODES) registerQoderProvider(pi, mode, deps.profile);
}
