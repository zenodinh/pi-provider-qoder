// Writes the on-disk catalog cache that a provider registration reads, so a suite
// can assert against live-shaped rows without borrowing the product's offline
// fallback (which is only the four tier aliases — catalog.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clearQoderModelsMemCache,
  MODEL_PROMPT_CACHE,
  QODER_DEFAULT_MAX_OUTPUT_TOKENS,
  ZERO_COST,
} from "../catalog.ts";
import { rateForUpstreamKey } from "../pricing.ts";

export interface CacheRow {
  /** pi-visible id, i.e. the display name with whitespace stripped. */
  id: string;
  /** Upstream key the id dispatches to. */
  key: string;
  /** Measured rates when the key has them; ZERO_COST otherwise. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Seed the global catalog cache in this suite's HOME and drop the parsed-cache memo. */
export function seedCatalogCache(rows: readonly CacheRow[]): void {
  const path = join(process.env.HOME as string, ".pi", "agent", "qoder-models-cache.json");
  const models = rows.map((row) => ({
    id: row.id,
    name: row.id,
    upstreamKey: row.key,
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    // Same precedence the product uses: measured rates for the key, else zero.
    cost: row.cost ?? rateForUpstreamKey(row.key) ?? ZERO_COST,
    promptCache: MODEL_PROMPT_CACHE,
    contextWindow: 1_000_000,
    maxTokens: QODER_DEFAULT_MAX_OUTPUT_TOKENS,
  }));
  const configs = Object.fromEntries(rows.map((row) => [row.id, { key: row.key, enable: true, display_name: row.id }]));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ updatedAt: Date.now(), userID: "user", models, configs }), "utf8");
  clearQoderModelsMemCache();
}
