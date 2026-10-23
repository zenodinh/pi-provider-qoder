import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPiCacheWarmingMode } from "../warm-gate.js";
import { debugMessages } from "./debug-sink.js";

// spec (fs-qoder-warm-arming CU-01, SA §7.4 — the read that survives):
//   readPiCacheWarmingMode(dir) -> the file's value when it is one of
//     off|streaming|idle; "streaming" when the file is absent, unreadable, not
//     a JSON object, has no cacheWarming key, or carries a value outside the
//     three. Never throws, never undefined. One debugLog per rejection branch,
//     none on the absent-file branch.
//
// This is the whole module now: pi owns the caching decision, so the provider
// keeps no approval layer of its own and nothing else here decides anything.
// What remains feeds `/qoder-cache`'s `config:` line.

const temps: string[] = [];
const originalHome = process.env.HOME;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A fresh agent directory the reads are pointed at explicitly. */
function agentDir(): string {
  return tempDir("qoder-warm-gate-");
}

/** Point the default `getPiAgentDir()` parameter at a fresh directory. */
function defaultAgentDir(): string {
  const dir = agentDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

/** Turn the debug sink on into its own temp directory and return that dir. */
function debugSink(): string {
  const dir = tempDir("qoder-warm-gate-log-");
  process.env.QODER_DEBUG = "1";
  process.env.QODER_DEBUG_DIR = dir;
  return dir;
}

function write(dir: string, name: string, contents: string): void {
  writeFileSync(join(dir, name), contents, "utf8");
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.QODER_DEBUG;
  delete process.env.QODER_DEBUG_DIR;
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("readPiCacheWarmingMode (T-01/AC-01)", () => {
  it("reports what pi's own global-only reader would resolve for the same file", () => {
    // invented: the three states an operator can put pi's master switch in.
    const withMode = (mode: string): string => {
      const dir = agentDir();
      write(dir, "settings.json", JSON.stringify({ cacheWarming: mode }));
      return dir;
    };
    expect(readPiCacheWarmingMode(withMode("idle"))).toBe("idle");
    expect(readPiCacheWarmingMode(withMode("off"))).toBe("off");
    expect(readPiCacheWarmingMode(withMode("streaming"))).toBe("streaming");

    // No cacheWarming key is pi's normal armed state, not a rejection.
    const noKey = agentDir();
    write(noKey, "settings.json", JSON.stringify({ theme: "dark" }));
    expect(readPiCacheWarmingMode(noKey)).toBe("streaming");

    // The default parameter resolves through the real getPiAgentDir(), which is
    // what makes the extension's read and pi's read the same file.
    const viaEnvDir = defaultAgentDir();
    write(viaEnvDir, "settings.json", JSON.stringify({ cacheWarming: "idle" }));
    expect(readPiCacheWarmingMode()).toBe("idle");
  });

  it("reads the file pi reads, honouring PI_CODING_AGENT_DIR's ~ form", () => {
    // The owner's live value (SA CU-01 code_evidence, read 2026-10-04).
    const home = tempDir("qoder-warm-gate-home-");
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = "~";
    write(home, "settings.json", JSON.stringify({ cacheWarming: "idle" }));
    expect(readPiCacheWarmingMode()).toBe("idle");
  });
});

describe("readPiCacheWarmingMode rejection branches (T-02/AC-01,AC-05)", () => {
  it("falls back to pi's default with exactly one debug entry per rejection, and never throws", () => {
    // Absent file: silent, because absence is pi's normal armed state.
    const absentSink = debugSink();
    expect(readPiCacheWarmingMode(agentDir())).toBe("streaming");
    expect(debugMessages(absentSink)).toEqual([]);

    // Missing key: silent for the same reason.
    const missingKeySink = debugSink();
    const missingKey = agentDir();
    write(missingKey, "settings.json", "{}");
    expect(readPiCacheWarmingMode(missingKey)).toBe("streaming");
    expect(debugMessages(missingKeySink)).toEqual([]);

    // invented: an unreadable file, as the parse-failure branch sees it.
    const unreadableSink = debugSink();
    const unreadable = agentDir();
    write(unreadable, "settings.json", "{not json");
    expect(readPiCacheWarmingMode(unreadable)).toBe("streaming");
    const unreadableMessages = debugMessages(unreadableSink);
    expect(unreadableMessages).toHaveLength(1);
    expect(unreadableMessages[0]).toContain("pi settings unreadable");

    // invented: valid JSON that is not an object.
    const nonObjectSink = debugSink();
    const nonObject = agentDir();
    write(nonObject, "settings.json", "[1,2]");
    expect(readPiCacheWarmingMode(nonObject)).toBe("streaming");
    const nonObjectMessages = debugMessages(nonObjectSink);
    expect(nonObjectMessages).toHaveLength(1);
    expect(nonObjectMessages[0]).toContain("not a JSON object");

    // invented: a value outside pi's own accepted set.
    const outsideSink = debugSink();
    const outside = agentDir();
    write(outside, "settings.json", JSON.stringify({ cacheWarming: "turbo" }));
    expect(readPiCacheWarmingMode(outside)).toBe("streaming");
    const outsideMessages = debugMessages(outsideSink);
    expect(outsideMessages).toHaveLength(1);
    expect(outsideMessages[0]).toContain('cacheWarming "turbo"');
    expect(outsideMessages[0]).toContain("off|streaming|idle");
  });

  it("rejects a non-string cacheWarming value the way pi's typeof-free whitelist does", () => {
    const sink = debugSink();
    const dir = agentDir();
    write(dir, "settings.json", JSON.stringify({ cacheWarming: 5 }));
    expect(readPiCacheWarmingMode(dir)).toBe("streaming");
    expect(debugMessages(sink)).toHaveLength(1);
  });
});
