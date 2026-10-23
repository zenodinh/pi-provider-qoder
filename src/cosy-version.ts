import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "./debug.ts";
import { getPiAgentDir } from "./home.ts";
import { fetchQoderJson } from "./http.ts";

/**
 * The COSY client version this provider signs with when no newer release has
 * been read yet.
 *
 * Qoder gates catalog rows on the client identity: the same endpoint, token and
 * account answered 12 chat models under `Cosy-Version: 1.1.38` and 13 under
 * `1.1.77` (measured 2026-10-23 against
 * https://api3.qoder.sh/algo/api/v2/model/list), so a stale pin hides models the
 * account is entitled to. This value is the floor — `getGatewayCosyVersion`
 * only ever returns this or something newer, and `refreshGatewayCosyVersion`
 * only ever raises it.
 */
export const BUNDLED_GATEWAY_COSY_VERSION = "1.1.77";

/**
 * The published Qoder CLI releases feed, shaped like GitHub's
 * `/repos/:owner/:repo/releases` (an array of objects carrying `tag_name`,
 * `draft` and `prerelease`). Reading it is what lets signing follow the CLI
 * without this provider shipping a release for every Qoder release.
 */
const RELEASE_FEED_URL = "https://repo.qoder.com/repos/QoderAI/changelog-CLI/releases?per_page=5&page=1";
const CACHE_FILE_NAME = "qoder-cosy-version.json";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A published CLI version. Tags with a suffix (`1.1.80-beta.1`) are not signable. */
const STABLE_TAG = /^(\d+)\.(\d+)\.(\d+)$/;

interface CosyVersionRecord {
  version: string;
  checkedAt: number;
}

/**
 * What this process signs with, plus the throttle for the next feed read.
 *
 * `checkedAt` lives in memory because it records a *check*, not an identity: it
 * is stamped when an attempt starts (so a failing feed cannot be retried in a
 * loop) and seeded from the cache file, so a restart does not re-read the feed
 * the previous run already read.
 */
interface CosyVersionState {
  /** Absolute cache path the state was derived from, so a relocated home re-reads. */
  key: string;
  version: string;
  checkedAt: number;
}

/**
 * The one source of truth for the signing identity.
 *
 * shape: none — a dispatch object (#1) and a function type (#2) do not apply:
 * there is no discriminator and no algorithm handed to a caller. One memoized
 * value behind two functions is trigger #3 (one instance per process), which
 * module scope already provides.
 */
let mem: CosyVersionState | null = null;

/** In-flight feed read, so concurrent callers join one request. */
let inflight: Promise<void> | null = null;

function cachePath(): string {
  return join(getPiAgentDir(), CACHE_FILE_NAME);
}

function versionParts(version: string): [number, number, number] | null {
  const match = STABLE_TAG.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Strictly newer, so a cache that equals or trails the floor can never lower it. */
function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const now = versionParts(current);
  if (!next || !now) return false;
  if (next[0] !== now[0]) return next[0] > now[0];
  if (next[1] !== now[1]) return next[1] > now[1];
  return next[2] > now[2];
}

/** boundary: the cache file is `unknown` until every field is checked (BND-1). */
function isCosyVersionRecord(value: unknown): value is CosyVersionRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value) || !("checkedAt" in value)) return false;
  return (
    typeof value.version === "string" &&
    STABLE_TAG.test(value.version) &&
    typeof value.checkedAt === "number" &&
    Number.isFinite(value.checkedAt)
  );
}

/** A release entry worth signing as: a plain `x.y.z` tag, not a draft, not a prerelease. */
function isStableRelease(value: unknown): value is { tag_name: string } {
  if (typeof value !== "object" || value === null) return false;
  if (!("tag_name" in value)) return false;
  if (typeof value.tag_name !== "string" || !STABLE_TAG.test(value.tag_name)) return false;
  if ("draft" in value && value.draft === true) return false;
  return !("prerelease" in value && value.prerelease === true);
}

function newestStableTag(feed: unknown): string | null {
  if (!Array.isArray(feed)) return null;
  let newest: string | null = null;
  for (const entry of feed) {
    if (!isStableRelease(entry)) continue;
    if (newest === null || isNewerVersion(entry.tag_name, newest)) newest = entry.tag_name;
  }
  return newest;
}

function readCachedRecord(): CosyVersionRecord | null {
  const path = cachePath();
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isCosyVersionRecord(raw) ? raw : null;
  } catch (error) {
    debugLog("failed to read cosy version cache", error);
    return null;
  }
}

/**
 * Persist the negotiated identity atomically: a reader either sees the previous
 * record or the complete new one, never a half-written file. A read-only home
 * is a supported state (the version simply stays in memory), so a failed write
 * is logged and dropped rather than raised into the refresh's caller.
 */
function writeCachedRecord(record: CosyVersionRecord): void {
  const path = cachePath();
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8");
    renameSync(temp, path);
  } catch (error) {
    debugLog("failed to persist cosy version cache", error);
    rmSync(temp, { force: true });
  }
}

function currentState(): CosyVersionState {
  const key = cachePath();
  if (mem && mem.key === key) return mem;
  const cached = readCachedRecord();
  const version =
    cached && isNewerVersion(cached.version, BUNDLED_GATEWAY_COSY_VERSION)
      ? cached.version
      : BUNDLED_GATEWAY_COSY_VERSION;
  mem = { key, version, checkedAt: cached?.checkedAt ?? 0 };
  return mem;
}

/**
 * The COSY version to sign with: the cached release when it is newer than the
 * bundled floor, otherwise the floor. Never an older value.
 *
 * Synchronous and network-free — the single cache read behind it is memoized per
 * cache path, so `buildAuthHeaders` pays no I/O beyond the first call and a
 * failed feed can never break signing.
 */
export function getGatewayCosyVersion(): string {
  return currentState().version;
}

/**
 * Read the published CLI releases and raise the signing version when a newer
 * stable tag exists.
 *
 * Never rejects. An unreachable feed, a body that is not a release array, and a
 * home directory that cannot be written all leave the current version in place
 * and are logged only under `QODER_DEBUG`, which is why callers may fire this
 * without waiting: no outcome of it can reach, or fail, the turn that started
 * it. Concurrent callers join the in-flight read, and the check is throttled to
 * one attempt per 24 h — the stamp is written when the attempt settles, so a
 * persistently failing feed is retried tomorrow rather than on every turn.
 */
export async function refreshGatewayCosyVersion(): Promise<void> {
  if (inflight) return inflight;
  const current = currentState();
  if (Date.now() - current.checkedAt < REFRESH_INTERVAL_MS) return;

  inflight = (async () => {
    try {
      const feed: unknown = await fetchQoderJson<unknown>(RELEASE_FEED_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const newest = newestStableTag(feed);
      if (newest === null || !isNewerVersion(newest, current.version)) return;
      current.version = newest;
      writeCachedRecord({ version: newest, checkedAt: Date.now() });
    } catch (error) {
      debugLog("cosy version refresh failed", error);
    } finally {
      current.checkedAt = Date.now();
      inflight = null;
    }
  })();
  return inflight;
}

/** Drop the memoized state. For tests that rewrite the cache file or relocate the home. */
export function clearGatewayCosyVersionMemCache(): void {
  mem = null;
  inflight = null;
}
