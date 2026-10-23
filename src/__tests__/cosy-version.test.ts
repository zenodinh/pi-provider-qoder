import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_GATEWAY_COSY_VERSION,
  clearGatewayCosyVersionMemCache,
  getGatewayCosyVersion,
  refreshGatewayCosyVersion,
} from "../cosy-version.ts";

const agentDir = (): string => join(process.env.HOME as string, ".pi", "agent");
const cacheFile = (): string => join(agentDir(), "qoder-cosy-version.json");

// recorded-from: https://repo.qoder.com/repos/QoderAI/changelog-CLI/releases?per_page=5&page=1,
// 2026-10-23, trimmed to the fields this code reads (tag_name, draft, prerelease)
const RECORDED_FEED: unknown = [
  { tag_name: "1.1.77", draft: false, prerelease: false },
  { tag_name: "1.1.76", draft: false, prerelease: false },
  { tag_name: "1.1.75", draft: false, prerelease: false },
  { tag_name: "1.1.74", draft: false, prerelease: false },
  { tag_name: "1.1.73", draft: false, prerelease: false },
];

// invented: the recorded feed stops at the bundled floor, so a newer-tag case needs a tag
// Qoder has not published; 1.2.0 exercises the major-bump comparison in one step.
const NEWER_FEED: unknown = [
  { tag_name: "1.2.0", draft: false, prerelease: false },
  { tag_name: "1.1.77", draft: false, prerelease: false },
];

// invented: the floor is 1.1.77, so "older than the floor" needs a tag below it.
const OLDER_FEED: unknown = [
  { tag_name: "1.1.70", draft: false, prerelease: false },
  { tag_name: "1.1.38", draft: false, prerelease: false },
];

function stubFeed(payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function writeCache(record: { version: string; checkedAt: number }): void {
  writeFileSync(cacheFile(), JSON.stringify(record), "utf8");
}

beforeEach(() => {
  clearGatewayCosyVersionMemCache();
  rmSync(cacheFile(), { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(cacheFile(), { recursive: true, force: true });
  rmSync(agentDir(), { recursive: true, force: true });
  mkdirSync(agentDir(), { recursive: true });
  clearGatewayCosyVersionMemCache();
});

describe("getGatewayCosyVersion", () => {
  it("returns the bundled floor when nothing has been cached", () => {
    // spec: getGatewayCosyVersion() with no cache file -> "1.1.77"
    expect(BUNDLED_GATEWAY_COSY_VERSION).toBe("1.1.77");
    expect(getGatewayCosyVersion()).toBe("1.1.77");
  });

  it("returns a cached release that is newer than the floor", () => {
    // spec: cache {version:"1.2.0"} -> getGatewayCosyVersion() -> "1.2.0"
    writeCache({ version: "1.2.0", checkedAt: Date.now() });
    expect(getGatewayCosyVersion()).toBe("1.2.0");
  });

  it("returns the floor when the cached release is older, never downgrading", () => {
    // spec: cache {version:"1.1.38"} (the value pinned before this change)
    //   -> getGatewayCosyVersion() -> "1.1.77", not "1.1.38"
    writeCache({ version: "1.1.38", checkedAt: Date.now() });
    expect(getGatewayCosyVersion()).toBe("1.1.77");
  });

  it("ignores a cache file that is not a version record", () => {
    // spec: malformed cache (a tag that is not x.y.z) -> the floor, no throw
    writeFileSync(cacheFile(), '{"version":"latest","checkedAt":1}', "utf8");
    expect(getGatewayCosyVersion()).toBe("1.1.77");

    writeFileSync(cacheFile(), "{ not json", "utf8");
    clearGatewayCosyVersionMemCache();
    expect(getGatewayCosyVersion()).toBe("1.1.77");
  });
});

describe("refreshGatewayCosyVersion", () => {
  it("records a newer stable tag with its check time", async () => {
    // spec: feed newest stable tag 1.2.0, no cache
    //   -> cache file {version:"1.2.0", checkedAt:<now>}; in-memory version advances
    stubFeed(NEWER_FEED);
    await refreshGatewayCosyVersion();

    const record = JSON.parse(readFileSync(cacheFile(), "utf8")) as { version: string; checkedAt: number };
    expect(record.version).toBe("1.2.0");
    expect(typeof record.checkedAt).toBe("number");
    expect(record.checkedAt).toBeGreaterThan(0);
    expect(getGatewayCosyVersion()).toBe("1.2.0");
  });

  it("skips drafts and prereleases and signs with the newest plain tag", async () => {
    // spec: feed [1.3.0-rc.1 prerelease, 1.2.1 draft, 1.2.0 stable] -> "1.2.0"
    stubFeed([
      { tag_name: "1.3.0-rc.1", draft: false, prerelease: true },
      { tag_name: "1.2.1", draft: true, prerelease: false },
      { tag_name: "1.2.0", draft: false, prerelease: false },
    ]);
    await refreshGatewayCosyVersion();

    expect(getGatewayCosyVersion()).toBe("1.2.0");
    expect(JSON.parse(readFileSync(cacheFile(), "utf8"))).toMatchObject({ version: "1.2.0" });
  });

  it("writes nothing when the feed names only the bundled floor", async () => {
    // spec: recorded feed (newest 1.1.77 == floor) -> no cache file, version stays the floor
    stubFeed(RECORDED_FEED);
    await refreshGatewayCosyVersion();

    expect(getGatewayCosyVersion()).toBe("1.1.77");
    expect(() => readFileSync(cacheFile(), "utf8")).toThrow();
  });

  it("writes nothing when the feed is older than the floor", async () => {
    // spec: feed newest 1.1.70 < floor 1.1.77 -> no cache file, no downgrade
    stubFeed(OLDER_FEED);
    await refreshGatewayCosyVersion();

    expect(getGatewayCosyVersion()).toBe("1.1.77");
    expect(() => readFileSync(cacheFile(), "utf8")).toThrow();
  });

  it("keeps the current version when the feed answers an error", async () => {
    // spec: HTTP 404 -> resolves, version unchanged, no cache file, no throw
    const fetchMock = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    writeCache({ version: "1.2.0", checkedAt: 0 });

    await expect(refreshGatewayCosyVersion()).resolves.toBeUndefined();
    expect(getGatewayCosyVersion()).toBe("1.2.0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the current version when the request itself fails", async () => {
    // spec: transport rejects -> resolves, version unchanged
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    writeCache({ version: "1.2.0", checkedAt: 0 });

    const pending = refreshGatewayCosyVersion();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();
    expect(getGatewayCosyVersion()).toBe("1.2.0");
  });

  it("keeps the current version when the body is not a release array", async () => {
    // spec: {message:"Not Found"} -> resolves, version unchanged
    stubFeed({ message: "Not Found" });
    await expect(refreshGatewayCosyVersion()).resolves.toBeUndefined();
    expect(getGatewayCosyVersion()).toBe("1.1.77");
  });

  it("keeps the current version when the body is not JSON at all", async () => {
    // spec: "<html>" -> resolves, version unchanged (fetchQoderJson's parse throws)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    await expect(refreshGatewayCosyVersion()).resolves.toBeUndefined();
    expect(getGatewayCosyVersion()).toBe("1.1.77");
  });

  it("joins concurrent refreshes into one request", async () => {
    // spec: two calls without awaiting between -> one fetch, one cache write
    const fetchMock = stubFeed(NEWER_FEED);
    await Promise.all([refreshGatewayCosyVersion(), refreshGatewayCosyVersion()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getGatewayCosyVersion()).toBe("1.2.0");
  });

  it("checks the feed at most once per day", async () => {
    // spec: a successful check, then a second call -> no second request
    const fetchMock = stubFeed(NEWER_FEED);
    await refreshGatewayCosyVersion();
    await refreshGatewayCosyVersion();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps signing when the cache cannot be written", async () => {
    // spec: cache path occupied by a directory -> rename fails, refresh resolves,
    //   the version still advances in memory and no temp file is left behind
    mkdirSync(cacheFile(), { recursive: true });
    stubFeed(NEWER_FEED);

    await expect(refreshGatewayCosyVersion()).resolves.toBeUndefined();
    expect(getGatewayCosyVersion()).toBe("1.2.0");
    expect(readdirSync(agentDir()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
