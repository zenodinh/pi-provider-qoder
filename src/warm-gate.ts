// shape: as-const array + derived union for pi's mode set (trigger #5, a fixed
//   set of named constants mirrored from the host); interface + validated loader
//   for the approval record (trigger #7, fixed-shape record on disk);
//   resolveWarmGate is a guard cascade of three outcomes, below the
//   dispatch-object threshold (none).
/**
 * The two-layer warming arming gate (SA §7.4, CU-2).
 *
 * Layer 1 is pi's own master switch, read from the global `settings.json` pi
 * itself reads. It is a disk parse rather than `ExtensionAPI#getSettings()`
 * because that accessor returns MERGED global+project settings while pi's
 * warming gate reads global-only — the clean API cannot report the value pi
 * actually uses, and no global-only accessor is exposed to extensions.
 *
 * Layer 2 is this extension's durable per-machine approval, which survives a
 * shell that forgot the export. `QODER_CACHE_WARM` still wins when set, so an
 * explicit off remains expressible per process.
 *
 * Both layers are read at decision time, never cached at registration: pi
 * reconciles mode changes live (`onModeChanged`), so a cached read would report
 * a stale layer after the owner changes pi's setting mid-session.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { debugLog } from "./debug.js";
import { getPiAgentDir } from "./home.js";

/** pi's own settings file name — `join(resolvedAgentDir, "settings.json")`. */
const PI_SETTINGS_FILENAME = "settings.json";
/** This extension's durable approval record, beside the profile pi's dir holds. */
const WARM_APPROVAL_FILENAME = "qoder-warm-approval.json";

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

export interface WarmApproval {
  version: number;
  providers: Record<string, boolean>;
}

export interface WarmGateVerdict {
  /** Whether this extension votes on the decision at all. */
  armed: boolean;
  /** Which extension layer decided it — reported even when unarmed. */
  layer: "env" | "file" | "off";
  /** pi's own master switch, reported in every verdict including when `off`. */
  piMode: PiCacheWarmingMode;
  /** The raw env value, for the verdict line; undefined when never exported. */
  envValue: string | undefined;
}

// boundary: JSON text read from disk is parsed to `unknown` and narrowed by
// isRecord before any field is read (BND-1) — an annotation here would be a
// cast the compiler accepts unconditionally.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPiCacheWarmingMode(value: unknown): value is PiCacheWarmingMode {
  return typeof value === "string" && (PI_CACHE_WARMING_MODES as readonly string[]).includes(value);
}

/** Reject-wholesale: any non-boolean value rejects the whole map. */
function isBooleanMap(value: unknown): value is Record<string, boolean> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "boolean");
}

// shape: none — a read-plus-validate function; below the dispatch-object
//   threshold, and the repo's local idiom for this shape is the reject-wholesale
//   validator beside a pure entry point (protocol/routing.ts, lifetime.ts).
/**
 * Layer 1: pi's global-only `cacheWarming`, resolved exactly as pi's own
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

// shape: none — one validated read with a guard per rejection branch; the
//   record type is the interface declared above (trigger #7), not a class.
/**
 * Layer 2: this extension's per-machine approval record.
 *
 * Absent reads as undefined with no log — absence is the normal disarmed state,
 * not an error, so a fresh install ships disarmed rather than spending because
 * a file is missing. Any shape defect rejects the whole file rather than
 * salvaging the valid keys, so a half-written or hand-edited record can never
 * arm one provider on a value the operator never approved. Each rejection logs
 * exactly once, naming the file and the branch.
 */
export function readWarmApproval(dir: string = getPiAgentDir()): WarmApproval | undefined {
  const path = join(dir, WARM_APPROVAL_FILENAME);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    debugLog(`warm approval unreadable at ${path}`, error);
    return undefined;
  }
  if (!isRecord(raw)) {
    debugLog(`warm approval rejected at ${path}: not a JSON object`);
    return undefined;
  }
  const version = raw.version;
  if (typeof version !== "number") {
    debugLog(`warm approval rejected at ${path}: version ${JSON.stringify(version)} is not a number`);
    return undefined;
  }
  const providers = raw.providers;
  if (!isBooleanMap(providers)) {
    debugLog(`warm approval rejected at ${path}: providers is not a map of booleans`);
    return undefined;
  }
  return { version, providers };
}

// shape: none — a guard cascade of three outcomes (env, file, off), below the
//   dispatch-object threshold; matches resolveProtocol's shape
//   (protocol/router.ts:34-47).
/**
 * Precedence: env over approval file over off, with pi's layer reported beside
 * the verdict so the screen and the handler cannot disagree — one derivation,
 * two consumers.
 *
 * `1` arms and `0` disarms, both decided by the env layer, so an explicit off
 * stays expressible per process even on an approved machine. Any other exported
 * value logs once and falls through to the file rather than arming: a typo in a
 * shell export must not silently turn on spending.
 *
 * The env arrives as a parameter so the derivation is testable without mutating
 * process state.
 */
export function resolveWarmGate(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  dir: string = getPiAgentDir(),
): WarmGateVerdict {
  const piMode = readPiCacheWarmingMode(dir);
  // boundary: process.env values are `string | undefined` by the host's own
  // index signature and are compared against literals only — no field is read
  // off them, so there is nothing left to narrow (BND-1).
  const envValue = env.QODER_CACHE_WARM;
  if (envValue === "1") return { armed: true, layer: "env", piMode, envValue };
  if (envValue === "0") return { armed: false, layer: "env", piMode, envValue };
  if (envValue !== undefined) {
    debugLog(`QODER_CACHE_WARM "${envValue}" is not "1" or "0"; falling back to the approval file`);
  }
  const approval = readWarmApproval(dir);
  // `=== true` rather than a truthiness test: the map came from JSON, so an
  // inherited Object.prototype member must not read as approved.
  if (approval?.providers[provider] === true) return { armed: true, layer: "file", piMode, envValue };
  return { armed: false, layer: "off", piMode, envValue };
}
