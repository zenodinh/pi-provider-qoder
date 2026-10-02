import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AC-09 / BUG-0009: the suite must reach one verdict whichever shell started it.
 *
 * `setup.ts` runs as a vitest `setupFiles` entry, so by the time a test body
 * executes the scrub has already happened — and in CI there is nothing to
 * scrub, which would make a naive assertion here pass vacuously. These rows
 * therefore inject the pollution themselves and re-import the real module, so
 * the scrub is exercised against a known-dirty environment on every run.
 *
 * The subject is the real `setup.ts`, reached the only way vitest reaches it:
 * by importing it. There is no narrower public surface to enter through.
 */

/** The five variables the owner's `~/.zshrc` exports, plus one that does not exist yet. */
const AMBIENT_QODER = {
  QODER_PROTOCOL: "legacy",
  QODER_DEBUG: "1",
  QODER_EXPOSE_TOKEN_USAGE: "1",
  QODER_DEBUG_KEEP: "200",
  QODER_CACHE_WARM: "1",
  // A gate nobody has written yet. The scrub is prefix-based on purpose: an
  // allowlist of known names silently stops covering the next one.
  QODER_SOME_FUTURE_GATE: "on",
} as const;

const qoderKeys = (): string[] => Object.keys(process.env).filter((key) => key.startsWith("QODER_"));

let homeBefore: string | undefined;
let userProfileBefore: string | undefined;

afterEach(() => {
  // Re-importing setup.ts mints a fresh per-file HOME. Restore the one vitest's
  // own setupFile installed so this file leaves the environment as it found it.
  if (homeBefore !== undefined) process.env.HOME = homeBefore;
  if (userProfileBefore !== undefined) process.env.USERPROFILE = userProfileBefore;
  vi.resetModules();
});

/** Inject `AMBIENT_QODER`, then re-run the real setup module against it. */
async function runSetupAgainstDirtyEnv(): Promise<void> {
  homeBefore = process.env.HOME;
  userProfileBefore = process.env.USERPROFILE;
  for (const [key, value] of Object.entries(AMBIENT_QODER)) process.env[key] = value;
  expect(qoderKeys().length).toBeGreaterThanOrEqual(Object.keys(AMBIENT_QODER).length);
  vi.resetModules();
  await import("./setup.js");
}

describe("ambient QODER_* scrub", () => {
  it("removes the whole QODER_ family a developer's shell exported", async () => {
    await runSetupAgainstDirtyEnv();

    // The witness AC-09 names: inside a test body, no QODER_ key survives.
    expect(qoderKeys()).toEqual([]);
  });

  it("covers a gate that does not exist yet, because the scrub is prefix-based", async () => {
    await runSetupAgainstDirtyEnv();

    // Pin the design decision, not just today's variable list: an allowlist
    // would leave a future gate reading the operator's environment.
    expect(process.env.QODER_SOME_FUTURE_GATE).toBeUndefined();
    expect("QODER_SOME_FUTURE_GATE" in process.env).toBe(false);
  });

  it("leaves the rest of the environment alone while it scrubs", async () => {
    process.env.PI_UNRELATED_VAR = "keep-me-too";
    await runSetupAgainstDirtyEnv();

    // The scrub must not overreach into variables it does not own, and the
    // rest of setup.ts must still have run: HOME is a fresh temp dir and the
    // per-file .pi/agent directory exists.
    expect(qoderKeys()).toEqual([]);
    expect(process.env.PI_UNRELATED_VAR).toBe("keep-me-too");
    expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(process.env.HOME).toMatch(/pi-provider-qoder-test-/);

    delete process.env.PI_UNRELATED_VAR;
  });

  it("keeps a gate that a test stubs explicitly, so stubbing stays the way to depend on one", async () => {
    await runSetupAgainstDirtyEnv();
    expect(qoderKeys()).toEqual([]);

    // The scrub runs at import, before any test body. A test that needs a gate
    // states the dependency with vi.stubEnv — the wire-vocabulary.test.ts:128
    // precedent — and the value survives into the assertion.
    vi.stubEnv("QODER_DEBUG", "1");
    expect(process.env.QODER_DEBUG).toBe("1");
    vi.unstubAllEnvs();
    expect(process.env.QODER_DEBUG).toBeUndefined();
  });
});
