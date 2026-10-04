import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPiCacheWarmingMode, readWarmApproval, resolveWarmGate } from "../warm-gate.js";
import { debugMessages } from "./debug-sink.js";

// spec (fs-qoder-warm-arming CU-01/CU-02/CU-03, SA §7.4):
//   readPiCacheWarmingMode(dir) -> the file's value when it is one of
//     off|streaming|idle; "streaming" when the file is absent, unreadable, not
//     a JSON object, has no cacheWarming key, or carries a value outside the
//     three. Never throws, never undefined. One debugLog per rejection branch,
//     none on the absent-file branch.
//   readWarmApproval(dir) -> the record when well-formed; undefined when absent
//     (silent); undefined + exactly one debugLog when malformed, non-object,
//     non-number version, or a providers map holding any non-boolean.
//   resolveWarmGate(provider, env, dir) -> env "1" arms / env "0" disarms, both
//     layer "env"; any other exported value logs once and falls through to the
//     file; an approval of true arms with layer "file"; anything else is
//     armed:false layer:"off". piMode reported in every verdict.

/** recorded-from: SA §5.2 approval-file example, 2026-10-04. */
const APPROVAL_BOTH = `{"version":1,"providers":{"qoder":true,"qoder-cn":false}}`;

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

describe("readWarmApproval (T-03/AC-02)", () => {
  it("treats absence as off and silently, and presence as the record as written", () => {
    const sink = debugSink();
    expect(readWarmApproval(agentDir())).toBeUndefined();
    expect(debugMessages(sink)).toEqual([]);

    const dir = agentDir();
    write(dir, "qoder-warm-approval.json", APPROVAL_BOTH);
    expect(readWarmApproval(dir)).toEqual({ version: 1, providers: { qoder: true, "qoder-cn": false } });

    // The default parameter resolves through the real getPiAgentDir().
    const viaEnvDir = defaultAgentDir();
    write(viaEnvDir, "qoder-warm-approval.json", `{"version":1,"providers":{"qoder":true}}`);
    expect(readWarmApproval()).toEqual({ version: 1, providers: { qoder: true } });
  });
});

describe("readWarmApproval rejection branches (T-04/AC-02,AC-05)", () => {
  it("rejects the whole file wholesale with exactly one debug entry per branch", () => {
    const rejected = (contents: string, fragment: string): void => {
      const sink = debugSink();
      const dir = agentDir();
      write(dir, "qoder-warm-approval.json", contents);
      expect(readWarmApproval(dir)).toBeUndefined();
      const messages = debugMessages(sink);
      expect(messages, `contents=${contents}`).toHaveLength(1);
      expect(messages[0], `contents=${contents}`).toContain(fragment);
      expect(messages[0], `contents=${contents}`).toContain("qoder-warm-approval.json");
    };

    // invented: one fixture per rejection branch the validator declares.
    rejected("{not json", "warm approval unreadable");
    rejected("[1,2]", "not a JSON object");
    rejected(`{"version":"1","providers":{"qoder":true}}`, 'version "1" is not a number');
    rejected(`{"providers":{"qoder":true}}`, "version undefined is not a number");
    rejected(`{"version":1,"providers":{"qoder":"yes"}}`, "providers is not a map of booleans");
    rejected(`{"version":1}`, "providers is not a map of booleans");
    rejected(`{"version":1,"providers":["qoder"]}`, "providers is not a map of booleans");
  });

  it("does not salvage the valid keys of a half-approved file", () => {
    // The SA's own example shape with one value hand-corrupted: qoder:true must
    // NOT survive, because a salvaged key would arm a provider the operator
    // never approved.
    const sink = debugSink();
    const dir = agentDir();
    write(dir, "qoder-warm-approval.json", `{"version":1,"providers":{"qoder":true,"qoder-cn":"no"}}`);
    expect(readWarmApproval(dir)).toBeUndefined();
    expect(debugMessages(sink)).toHaveLength(1);
    expect(resolveWarmGate("qoder", {}, dir).armed).toBe(false);
  });

  it("accepts an empty providers map, which simply approves nobody", () => {
    const dir = agentDir();
    write(dir, "qoder-warm-approval.json", `{"version":1,"providers":{}}`);
    expect(readWarmApproval(dir)).toEqual({ version: 1, providers: {} });
  });
});

describe("resolveWarmGate precedence (T-05/AC-01,AC-02,AC-03)", () => {
  /** The four file-layer states the matrix crosses the env against. */
  function fileLayer(state: "absent" | "true" | "false" | "malformed", piMode?: string): string {
    const dir = agentDir();
    if (piMode !== undefined) write(dir, "settings.json", JSON.stringify({ cacheWarming: piMode }));
    if (state === "absent") return dir;
    if (state === "malformed") {
      write(dir, "qoder-warm-approval.json", "{not json");
      return dir;
    }
    write(dir, "qoder-warm-approval.json", `{"version":1,"providers":{"qoder":${state}}}`);
    return dir;
  }

  const fileStates = ["absent", "true", "false", "malformed"] as const;

  it("arms env over approval file over off, across the full matrix", () => {
    // Expected [env, file state, armed, layer] — the precedence table from
    // SA §7.4: env wins in both directions, an unusable env falls through to the
    // file, and only an approval of true arms from the file.
    const rows: [string | undefined, (typeof fileStates)[number], boolean, "env" | "file" | "off"][] = [];
    for (const file of fileStates) {
      rows.push([undefined, file, file === "true", file === "true" ? "file" : "off"]);
      rows.push(["1", file, true, "env"]);
      rows.push(["0", file, false, "env"]);
      rows.push(["garbage", file, file === "true", file === "true" ? "file" : "off"]);
    }

    for (const [envValue, file, armed, layer] of rows) {
      const env = envValue === undefined ? {} : { QODER_CACHE_WARM: envValue };
      const verdict = resolveWarmGate("qoder", env, fileLayer(file, "idle"));
      expect(verdict, `env=${String(envValue)} file=${file}`).toEqual({
        armed,
        layer,
        piMode: "idle",
        envValue,
      });
    }
    expect(rows).toHaveLength(16);
  });

  it("reports piMode in every verdict, including a pi-disarmed machine the extension would arm", () => {
    // AC-01's falsifier: pi's OFF must surface even when the extension arms.
    const armed = fileLayer("true", "off");
    expect(resolveWarmGate("qoder", {}, armed)).toEqual({
      armed: true,
      layer: "file",
      piMode: "off",
      envValue: undefined,
    });
    // And the reverse: pi armed while the extension declines.
    const unarmed = fileLayer("false", "idle");
    expect(resolveWarmGate("qoder", {}, unarmed).piMode).toBe("idle");
    expect(resolveWarmGate("qoder", {}, unarmed).armed).toBe(false);
  });

  it("resolves each provider independently from one approval map", () => {
    const dir = agentDir();
    write(dir, "qoder-warm-approval.json", APPROVAL_BOTH);
    expect(resolveWarmGate("qoder", {}, dir)).toMatchObject({ armed: true, layer: "file" });
    expect(resolveWarmGate("qoder-cn", {}, dir)).toMatchObject({ armed: false, layer: "off" });
    // A provider the file omits entirely is not approved.
    expect(resolveWarmGate("qoder-global", {}, dir)).toMatchObject({ armed: false, layer: "off" });
  });

  it("does not read an inherited Object.prototype member as an approval", () => {
    const dir = agentDir();
    write(dir, "qoder-warm-approval.json", `{"version":1,"providers":{}}`);
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(resolveWarmGate(key, {}, dir).armed, key).toBe(false);
    }
  });
});

describe("resolveWarmGate invalid env (T-06/AC-03,AC-06)", () => {
  it("logs the raw value once and falls through to the file instead of arming on the env", () => {
    const sink = debugSink();
    const noFile = agentDir();
    expect(resolveWarmGate("qoder", { QODER_CACHE_WARM: "yes-please" }, noFile)).toMatchObject({
      armed: false,
      layer: "off",
    });
    const messages = debugMessages(sink);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('QODER_CACHE_WARM "yes-please"');
    expect(messages[0]).toContain("falling back to the approval file");

    // A typo must not arm — but a genuinely approved machine still arms through
    // the file layer, decided by the file and not by the env.
    const approved = agentDir();
    write(approved, "qoder-warm-approval.json", `{"version":1,"providers":{"qoder":true}}`);
    expect(resolveWarmGate("qoder", { QODER_CACHE_WARM: "2" }, approved)).toMatchObject({
      armed: true,
      layer: "file",
    });
    expect(debugMessages(sink)).toHaveLength(2);
  });

  it("logs nothing when the env is never exported", () => {
    const sink = debugSink();
    const approved = agentDir();
    write(approved, "qoder-warm-approval.json", `{"version":1,"providers":{"qoder":true}}`);
    expect(resolveWarmGate("qoder", {}, approved).armed).toBe(true);
    expect(debugMessages(sink)).toEqual([]);
  });
});
