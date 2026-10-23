// shape: as-const array + derived union for pi's mode set (trigger #5, a fixed
//   set of named constants mirrored from the host); readPiCacheWarmingMode is a
//   read-plus-validate function, below the dispatch-object threshold (none).
/**
 * pi's own cache-warming setting — the only switch warming has.
 *
 * pi is the harness and the caching decision belongs to it, so this extension
 * approves every refresh pi asks for and keeps no switch of its own: no env var,
 * no approval file, nothing to keep in sync with pi. What remains here is the
 * read that lets `/qoder-cache` report the mode pi is actually in, resolved from
 * the global `settings.json` pi itself reads. It is a disk parse rather than
 * `ExtensionAPI#getSettings()` because that accessor returns MERGED
 * global+project settings while pi's warming gate reads global-only — the clean
 * API cannot report the value pi actually uses, and no global-only accessor is
 * exposed to extensions.
 *
 * Read on demand by the report, never cached: pi reconciles mode changes live
 * (`onModeChanged`), so a cached value would report a stale mode after the owner
 * changes pi's setting mid-session.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { debugLog } from "./debug.js";
import { getPiAgentDir } from "./home.js";

/** pi's own settings file name — `join(resolvedAgentDir, "settings.json")`. */
const PI_SETTINGS_FILENAME = "settings.json";

// Mirrors the host's `CACHE_WARMING_MODES` (settings-manager.js:15). One
// spelling for the set: the type is derived from the array so the whitelist and
// the union cannot drift apart.
const PI_CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;
export type PiCacheWarmingMode = (typeof PI_CACHE_WARMING_MODES)[number];

/**
 * pi's fallback when `cacheWarming` is unset or unrecognized
 * (`settings-manager.js:681`). Unset means pi-armed, so mirroring this default
 * exactly is what keeps the screen from reporting OFF while pi warms.
 */
const PI_DEFAULT_CACHE_WARMING_MODE: PiCacheWarmingMode = "streaming";

// boundary: JSON text read from disk is parsed to `unknown` and narrowed by
// isRecord before any field is read (BND-1) — an annotation here would be a
// cast the compiler accepts unconditionally.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPiCacheWarmingMode(value: unknown): value is PiCacheWarmingMode {
  return typeof value === "string" && (PI_CACHE_WARMING_MODES as readonly string[]).includes(value);
}

// shape: none — a read-plus-validate function; below the dispatch-object
//   threshold, and the repo's local idiom for this shape is the reject-wholesale
//   validator beside a pure entry point (protocol/routing.ts, lifetime.ts).
/**
 * pi's global-only `cacheWarming`, resolved exactly as pi's own
 * `getCacheWarmingMode()` resolves it for the same file.
 *
 * Never throws and never returns undefined: an absent file, an unreadable file,
 * a non-object document, a missing key, or a value outside pi's accepted set all
 * fall back to `streaming`. Every rejection branch logs once. The absent-file
 * and missing-key branches are silent, because both are pi's normal armed state
 * rather than an error — the posture `readProfile` takes, minus its silent
 * `!isRecord` branch (lifetime.ts:604), which SA §5.2 names as the defect not to
 * repeat.
 */
export function readPiCacheWarmingMode(dir: string = getPiAgentDir()): PiCacheWarmingMode {
  const path = join(dir, PI_SETTINGS_FILENAME);
  if (!existsSync(path)) return PI_DEFAULT_CACHE_WARMING_MODE;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    debugLog(`pi settings unreadable at ${path}; cacheWarming falls back to "${PI_DEFAULT_CACHE_WARMING_MODE}"`, error);
    return PI_DEFAULT_CACHE_WARMING_MODE;
  }
  if (!isRecord(raw)) {
    debugLog(
      `pi settings rejected at ${path}: not a JSON object; cacheWarming falls back to "${PI_DEFAULT_CACHE_WARMING_MODE}"`,
    );
    return PI_DEFAULT_CACHE_WARMING_MODE;
  }
  const mode = raw.cacheWarming;
  if (mode === undefined) return PI_DEFAULT_CACHE_WARMING_MODE;
  if (isPiCacheWarmingMode(mode)) return mode;
  debugLog(
    `pi settings rejected at ${path}: cacheWarming ${JSON.stringify(mode)} is not one of ` +
      `${PI_CACHE_WARMING_MODES.join("|")}; falling back to "${PI_DEFAULT_CACHE_WARMING_MODE}"`,
  );
  return PI_DEFAULT_CACHE_WARMING_MODE;
}
