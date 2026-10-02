import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheWarmingDecisionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifetimeProfile } from "../lifetime.js";
import { type Budget, evaluateGuard, parseBudgetEnv } from "../warm-guard.js";
import { debugMessages } from "./debug-sink.js";
import { assistantEntry, compactionEntry, warmEntry } from "./session-fixtures.js";

const MODEL = "DeepSeek-V4-Flash";
/**
 * invented: the AC-01 budget scenario. Anchor prompt = 1,607,144 tokens on the
 * fitted dfmodel rates -> protected miss = 1,607,144 x (0.126984 - 0.00253968)
 * / 1e6 = $0.19999994; fraction 0.5 -> cap $0.09999997. Two $0.05 refreshes fit,
 * the third does not.
 */
const ANCHOR_TOKENS = 1_607_144;
const WARM_TOKENS = { input: ANCHOR_TOKENS, cacheRead: 0, output: 4 };
const REFRESH_CREDITS = 3.75; // 3.75 / 75 = $0.05

const EVENT: CacheWarmingDecisionEvent = {
  type: "cache_warming_decision",
  warmCost: 0,
  missCost: 0,
  continuationProbability: 0.15,
  action: "stop",
};
const BUDGET: Budget = { kind: "fraction", fraction: 0.5 };
const NO_LEARNED_FIT = { readProfile: () => undefined };

const originalDebug = process.env.QODER_DEBUG;
afterEach(() => {
  if (originalDebug === undefined) delete process.env.QODER_DEBUG;
  else process.env.QODER_DEBUG = originalDebug;
  vi.restoreAllMocks();
});

// spec: evaluateGuard governed at protected ~$0.20 / fraction 0.5 / refresh $0.05
//   -> warm/approved, warm/approved, stop/budget-reached (USD end-to-end)
describe("budget guard (AC-01/AC-02/AC-03)", () => {
  it("approves exactly two refreshes then stops at the cap", () => {
    const anchor = assistantEntry(MODEL, 1_000_000, { input: ANCHOR_TOKENS, cacheRead: 0, output: 10 });
    let entries = [anchor];
    const view = { modelId: MODEL, mode: "global" as const, budget: BUDGET };

    const first = evaluateGuard(EVENT, { ...view, entries }, NO_LEARNED_FIT);
    expect(first).toMatchObject({ action: "warm", reason: "approved", rateSource: "fitted" });
    expect(first.spendUsd).toBe(0);
    expect(first.protectedUsd).toBeCloseTo(0.2, 6);

    entries = [...entries, warmEntry(1_300_000, WARM_TOKENS, 0, REFRESH_CREDITS)];
    const second = evaluateGuard(EVENT, { ...view, entries }, NO_LEARNED_FIT);
    expect(second).toMatchObject({ action: "warm", reason: "approved" });
    expect(second.spendUsd).toBeCloseTo(0.05, 9);

    entries = [...entries, warmEntry(1_600_000, WARM_TOKENS, 0, REFRESH_CREDITS)];
    const third = evaluateGuard(EVENT, { ...view, entries }, NO_LEARNED_FIT);
    expect(third).toMatchObject({ action: "stop", reason: "budget-reached" });
    expect(third.spendUsd).toBeCloseTo(0.1, 9);
  });

  it("recomputes spend from the window after the last real turn, counting priced v2 rows", () => {
    const view = { modelId: MODEL, mode: "global" as const, budget: BUDGET };
    const anchor = assistantEntry(MODEL, 1_000_000, { input: ANCHOR_TOKENS, cacheRead: 0, output: 10 });
    const legacy = warmEntry(1_300_000, { input: 7_144, cacheRead: 1_600_000, output: 4 }, 0, REFRESH_CREDITS);
    const priced = warmEntry(1_600_000, { input: 7_144, cacheRead: 1_600_000, output: 4 }, 0.05);

    const atCap = evaluateGuard(EVENT, { ...view, entries: [anchor, legacy, priced] }, NO_LEARNED_FIT);
    expect(atCap).toMatchObject({ action: "stop", reason: "budget-reached" });
    expect(atCap.spendUsd).toBeCloseTo(0.1, 9);

    const nextTurn = assistantEntry(MODEL, 1_900_000, { input: ANCHOR_TOKENS, cacheRead: 0, output: 10 });
    const reset = evaluateGuard(EVENT, { ...view, entries: [anchor, legacy, priced, nextTurn] }, NO_LEARNED_FIT);
    expect(reset.spendUsd).toBe(0);
    expect(reset).toMatchObject({ action: "warm", reason: "approved" });
  });

  it("counts pre-upgrade v2 warm rows as $0 and heals at the next real turn", () => {
    const view = { modelId: MODEL, mode: "global" as const, budget: BUDGET };
    const anchor = assistantEntry(MODEL, 1_000_000, { input: ANCHOR_TOKENS, cacheRead: 0, output: 10 });
    const preUpgrade = [
      warmEntry(1_300_000, { input: 7_144, cacheRead: 1_600_000, output: 4 }, 0),
      warmEntry(1_600_000, { input: 7_144, cacheRead: 1_600_000, output: 4 }, 0),
    ];

    const before = evaluateGuard(EVENT, { ...view, entries: [anchor, ...preUpgrade] }, NO_LEARNED_FIT);
    expect(before.spendUsd).toBe(0);
    expect(before).toMatchObject({ action: "warm", reason: "approved" });

    const nextTurn = assistantEntry(MODEL, 1_900_000, { input: ANCHOR_TOKENS, cacheRead: 0, output: 10 });
    const postUpgrade = warmEntry(2_100_000, { input: 7_144, cacheRead: 1_600_000, output: 4 }, 0.02);
    const after = evaluateGuard(
      EVENT,
      { ...view, entries: [anchor, ...preUpgrade, nextTurn, postUpgrade] },
      NO_LEARNED_FIT,
    );
    expect(after.spendUsd).toBeCloseTo(0.02, 9);
    expect(after).toMatchObject({ action: "warm", reason: "approved" });
  });
});

// spec: no fitted or learned rate -> warm/rate-unavailable (rateSource none);
//   a learned fit governs the same model; budget off -> legacy force-warm
describe("rate-source ladder (AC-08)", () => {
  // invented: a learned Credits-per-token fit for an unmeasured model, shaped
  // like the SA §5.5 example (credits per token, R² gate already applied).
  const learnedProfile: LifetimeProfile = {
    version: 2,
    updatedAt: "2026-10-01T00:00:00.000Z",
    models: {
      Lite: {
        lifetimeSeconds: 300,
        samples: 20,
        computedAt: "2026-10-01T00:00:00.000Z",
        buckets: [],
        rateFit: {
          inputCreditsPerToken: 1.5e-5,
          cacheReadCreditsPerToken: 1.5e-6,
          outputCreditsPerToken: 3e-5,
          rSquared: 0.99,
          samples: 30,
          fittedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    },
  };

  it("keeps force-warm without a rate, governs once a learned fit exists, and honours budget off", () => {
    const entries = [assistantEntry("Lite", 1_000_000, { input: 100_000, cacheRead: 0, output: 10 })];
    const view = { entries, modelId: "Lite", mode: "global" as const, budget: BUDGET };

    const ungoverned = evaluateGuard(EVENT, view, NO_LEARNED_FIT);
    expect(ungoverned).toEqual({
      action: "warm",
      reason: "rate-unavailable",
      rateSource: "none",
      spendUsd: 0,
      protectedUsd: 0,
    });

    const governed = evaluateGuard(EVENT, view, { readProfile: () => learnedProfile });
    expect(governed).toMatchObject({ action: "warm", reason: "approved", rateSource: "learned" });
    expect(governed.protectedUsd).toBeCloseTo(0.018, 9);

    const uncapped = evaluateGuard(EVENT, { ...view, budget: { kind: "off" } }, { readProfile: () => learnedProfile });
    expect(uncapped).toMatchObject({ action: "warm", reason: "budget-off" });
  });
});

// spec: parseBudgetEnv(undefined) -> 0.5; ("off") -> uncapped; ("abc"/"-1"/"0")
//   -> 0.5 with exactly one debug entry naming the raw value. Sink contract
//   (owner directive 2026-10-02): entries are JSONL file records, console silent.
describe("QODER_WARM_BUDGET parsing (AC-04)", () => {
  it("defaults, disables, and falls back with one debug entry per invalid value", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "warm-guard-debug-"));
    process.env.QODER_DEBUG_DIR = dir;
    delete process.env.QODER_DEBUG;

    expect(parseBudgetEnv(undefined)).toEqual({ kind: "fraction", fraction: 0.5 });
    expect(parseBudgetEnv("")).toEqual({ kind: "fraction", fraction: 0.5 });
    expect(parseBudgetEnv("off")).toEqual({ kind: "off" });
    expect(parseBudgetEnv("OFF")).toEqual({ kind: "off" });
    expect(parseBudgetEnv("0.25")).toEqual({ kind: "fraction", fraction: 0.25 });
    expect(errorSpy).not.toHaveBeenCalled();

    process.env.QODER_DEBUG = "1";
    expect(parseBudgetEnv("abc")).toEqual({ kind: "fraction", fraction: 0.5 });
    expect(parseBudgetEnv("-1")).toEqual({ kind: "fraction", fraction: 0.5 });
    expect(parseBudgetEnv("0")).toEqual({ kind: "fraction", fraction: 0.5 });
    expect(errorSpy).not.toHaveBeenCalled();
    const logged = debugMessages(dir);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toContain('"abc"');
    expect(logged[1]).toContain('"-1"');
    expect(logged[2]).toContain('"0"');
    delete process.env.QODER_DEBUG;
    delete process.env.QODER_DEBUG_DIR;
  });
});

// spec: no anchor row (empty or compaction-only branch) -> stop/economics-unavailable
describe("missing anchor (AC-01 falsifier)", () => {
  it("stops with economics-unavailable when no row can price the miss", () => {
    const view = { modelId: MODEL, mode: "global" as const, budget: BUDGET };
    for (const entries of [[], [compactionEntry(1_000_000)]]) {
      const verdict = evaluateGuard(EVENT, { ...view, entries }, NO_LEARNED_FIT);
      expect(verdict).toEqual({
        action: "stop",
        reason: "economics-unavailable",
        rateSource: "fitted",
        spendUsd: 0,
        protectedUsd: 0,
      });
    }
  });
});
