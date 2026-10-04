import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { CacheWarmingDecisionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifetimeEstimate, LifetimeProfile } from "../lifetime.js";
import { priceTurnCost, type RateSource } from "../pricing.js";
import { stampTerminal } from "../protocol/stamp.js";
import { type Budget, evaluateGuard, type GuardRateSource, parseBudgetEnv } from "../warm-guard.js";
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
/**
 * invented: a refresh that HIT the cache. Its prompt tokens still total
 * ANCHOR_TOKENS, so the anchor and the protected value are unchanged and only
 * the spend side moves — FR-5 re-bases the spend window past misses, so a budget
 * ladder built from `cacheRead: 0` rows would be empty by construction.
 */
const HIT_TOKENS = { input: 7_144, cacheRead: 1_600_000, output: 4 };
/** invented: a refresh that read nothing from cache — a miss, billed at input price. */
const MISS_TOKENS = { input: ANCHOR_TOKENS, cacheRead: 0, output: 4 };
const REFRESH_CREDITS = 3.75; // 3.75 / 75 = $0.05
// invented: one eviction billed at the whole cap, so a single miss is enough to
// refuse the next refresh on the pre-change guard (7.5 / 75 = $0.10).
const EVICTION_CREDITS = 7.5;

/**
 * invented: a published learned fit for an unmeasured model, shaped like the
 * SA §5.5 example (Credits per token, the R² gate already applied). The lifetime
 * fields are the profile's required shape and play no part in the rate ladder.
 */
function estimateWithFit(inputCreditsPerToken: number, cacheReadCreditsPerToken: number): LifetimeEstimate {
  return {
    lifetimeSeconds: 300,
    samples: 20,
    computedAt: "2026-10-01T00:00:00.000Z",
    buckets: [],
    rateFit: {
      inputCreditsPerToken,
      cacheReadCreditsPerToken,
      outputCreditsPerToken: 3e-5,
      rSquared: 0.99,
      samples: 30,
      fittedAt: "2026-10-01T00:00:00.000Z",
    },
  };
}

/** invented: the profile envelope's required fields; only `models` carries rate data. */
function profileWith(models: Record<string, LifetimeEstimate>): LifetimeProfile {
  return { version: 2, updatedAt: "2026-10-01T00:00:00.000Z", models };
}

/**
 * invented: the rung-2 fixture — the model under test publishes its own fit. The
 * two rates are the base file's inline `learnedProfile` values carried over
 * unchanged, so the rung-2 movement's $0.018 expectation still means what it did.
 */
const LEARNED_FIT_FOR_LITE = profileWith({ Lite: estimateWithFit(1.5e-5, 1.5e-6) });

/**
 * invented: two learned fits placed OUTSIDE the fitted table's range in opposite
 * directions, so rung 3's two ends come from two different models and no wrong
 * pairing can coincide with the right one. Aurora's input 3e-4 Credits/token =
 * $4.00/1M beats the table's max (qmodel_38max $1.428571/1M); Borealis's
 * cache-read 7.5e-8 Credits/token = $0.001/1M undercuts its min (dfmodel
 * $0.00253968/1M). Neither is the model under test, so rung 2 cannot fire.
 */
const TWO_FITS = profileWith({ Aurora: estimateWithFit(3e-4, 3e-5), Borealis: estimateWithFit(6e-6, 7.5e-8) });

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

// spec: fs-qoder-guard-governance T-06/AC-08 — evaluateGuard governed at
//   protected ~$0.20 / fraction 0.5 / refresh $0.05 -> warm/approved,
//   warm/approved, stop/budget-reached (USD end-to-end). The ladder is built from
//   cache-read HITS: FR-5 re-bases the spend window past the last miss, so the
//   budget binds on hits, which is what it was always meant to cap. (Base 943459f
//   built it from `cacheRead: 0` rows — inversion 2 of the spec's three quoted
//   backward-compatibility rows.)
describe("budget guard (AC-01/AC-02/AC-03)", () => {
  it("approves exactly two refreshes then stops at the cap", () => {
    const anchor = assistantEntry(MODEL, 1_000_000, { input: ANCHOR_TOKENS, cacheRead: 0, output: 10 });
    let entries = [anchor];
    const view = { modelId: MODEL, mode: "global" as const, budget: BUDGET };

    const first = evaluateGuard(EVENT, { ...view, entries }, NO_LEARNED_FIT);
    expect(first).toMatchObject({ action: "warm", reason: "approved", rateSource: "fitted" });
    expect(first.spendUsd).toBe(0);
    expect(first.protectedUsd).toBeCloseTo(0.2, 6);

    entries = [...entries, warmEntry(1_300_000, HIT_TOKENS, 0, REFRESH_CREDITS)];
    const second = evaluateGuard(EVENT, { ...view, entries }, NO_LEARNED_FIT);
    expect(second).toMatchObject({ action: "warm", reason: "approved" });
    expect(second.spendUsd).toBeCloseTo(0.05, 9);

    entries = [...entries, warmEntry(1_600_000, HIT_TOKENS, 0, REFRESH_CREDITS)];
    const third = evaluateGuard(EVENT, { ...view, entries }, NO_LEARNED_FIT);
    expect(third).toMatchObject({ action: "stop", reason: "budget-reached" });
    expect(third.spendUsd).toBeCloseTo(0.1, 9);
  });

  // spec: fs-qoder-guard-governance T-05/AC-04 — a miss is billed at full input
  //   price precisely because the entry was lost, so charging that cost against
  //   the entry the NEXT refresh protects lets one eviction consume the whole
  //   budget (BUG-0004). The re-base moves the window's start; it does not empty
  //   the window, so hits after the miss still accumulate and still bind the cap.
  it("re-bases the spend window past a missed warm instead of charging it forward", () => {
    const view = { modelId: MODEL, mode: "global" as const, budget: BUDGET };
    const anchor = assistantEntry(MODEL, 1_000_000, { input: ANCHOR_TOKENS, cacheRead: 0, output: 10 });
    // One eviction at $0.10 meets the whole $0.09999997 cap on its own: this is
    // the window the pre-change guard refused the next refresh on.
    const eviction = warmEntry(1_300_000, MISS_TOKENS, 0, EVICTION_CREDITS);

    const afterMiss = evaluateGuard(EVENT, { ...view, entries: [anchor, eviction] }, NO_LEARNED_FIT);
    expect(afterMiss.spendUsd, "the miss's own cost was charged forward").toBe(0);
    expect(afterMiss).toMatchObject({ action: "warm", reason: "approved" });
    expect(afterMiss.protectedUsd).toBeCloseTo(0.2, 6);

    const hit = warmEntry(1_600_000, HIT_TOKENS, 0, REFRESH_CREDITS);
    const afterHit = evaluateGuard(EVENT, { ...view, entries: [anchor, eviction, hit] }, NO_LEARNED_FIT);
    expect(afterHit.spendUsd).toBeCloseTo(0.05, 9);
    expect(afterHit).toMatchObject({ action: "warm", reason: "approved" });

    const secondHit = warmEntry(1_900_000, HIT_TOKENS, 0, REFRESH_CREDITS);
    const atCap = evaluateGuard(EVENT, { ...view, entries: [anchor, eviction, hit, secondHit] }, NO_LEARNED_FIT);
    expect(atCap.spendUsd).toBeCloseTo(0.1, 9);
    expect(atCap).toMatchObject({ action: "stop", reason: "budget-reached" });

    // The window re-bases past the LAST miss, not the first: a second eviction
    // after a paid hit empties the window again, including the hit that sat
    // between the two misses. The clock is passed explicitly rather than left to
    // the module default, so two in-span misses cannot latch this row through a
    // stamp some other row left behind.
    const secondEviction = warmEntry(2_100_000, MISS_TOKENS, 0, EVICTION_CREDITS);
    const rebased = evaluateGuard(
      EVENT,
      { ...view, entries: [anchor, eviction, hit, secondEviction] },
      {
        ...NO_LEARNED_FIT,
        lastRealRequestAt: () => undefined,
      },
    );
    expect(rebased.spendUsd, "a miss before the last one was still charged forward").toBe(0);
    expect(rebased).toMatchObject({ action: "warm", reason: "approved" });
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

// spec: fs-qoder-guard-governance CU-01 inversion 1 — base 943459f pinned
//   `toEqual({ action: "warm", reason: "rate-unavailable", rateSource: "none",
//   spendUsd: 0, protectedUsd: 0 })` for `Lite` under `readProfile: () =>
//   undefined`. FR-3 removes exactly that outcome: the conservative universe is
//   the fitted table, which is non-empty for other models, so a rate-less model
//   is priced from the worst observed economics and governed. The row's second
//   and third movements stay true and stay asserted.
describe("rate-source ladder (AC-08)", () => {
  it("prices a rate-less model conservatively, prefers a learned fit, and honours budget off", () => {
    const entries = [assistantEntry("Lite", 1_000_000, { input: 100_000, cacheRead: 0, output: 10 })];
    const view = { entries, modelId: "Lite", mode: "global" as const, budget: BUDGET };

    // invented: no learned fit anywhere, so rung 3 draws both ends from the
    // fitted table alone — max input qmodel_38max $1.428571/1M, min cache-read
    // dfmodel $0.00253968/1M -> 100,000 x (1.428571e-6 - 2.53968e-9) = $0.142603132.
    const priced = evaluateGuard(EVENT, view, NO_LEARNED_FIT);
    expect(priced).toMatchObject({ action: "warm", reason: "approved", rateSource: "conservative", spendUsd: 0 });
    expect(priced.protectedUsd).toBeCloseTo(0.142603132, 12);

    const governed = evaluateGuard(EVENT, view, { readProfile: () => LEARNED_FIT_FOR_LITE });
    expect(governed).toMatchObject({ action: "warm", reason: "approved", rateSource: "learned" });
    expect(governed.protectedUsd).toBeCloseTo(0.018, 9);

    const uncapped = evaluateGuard(
      EVENT,
      { ...view, budget: { kind: "off" } },
      { readProfile: () => LEARNED_FIT_FOR_LITE },
    );
    expect(uncapped).toMatchObject({ action: "warm", reason: "budget-off" });
  });
});

// spec: fs-qoder-guard-governance T-01/T-02/T-03/T-04 — AC-01 (worst observed
//   economics, max-input/min-cache-read), AC-02 (the source is guard-only),
//   AC-03 (nothing is fabricated for a window no rate can price).
describe("conservative rate rung (T-01/T-02/T-03/T-04, AC-01/AC-02/AC-03)", () => {
  const LITE_ANCHOR = { input: 100_000, cacheRead: 0, output: 10 };

  it("prices a rate-less model from the worst observed economics and governs it (T-01/AC-01)", () => {
    const entries = [assistantEntry("Lite", 1_000_000, LITE_ANCHOR)];
    const view = { entries, modelId: "Lite", mode: "global" as const, budget: BUDGET };
    const deps = { readProfile: () => TWO_FITS };

    // invented: 100,000 x (Aurora's $4.00/1M input - Borealis's $0.001/1M
    // cache-read) = $0.3999. Both ends come from the profile, not the table.
    const governed = evaluateGuard(EVENT, view, deps);
    expect(governed).toMatchObject({ action: "warm", reason: "approved", rateSource: "conservative", spendUsd: 0 });
    expect(governed.protectedUsd).toBeCloseTo(0.3999, 12);

    // The verdict is the budget comparison's outcome, not an unconditional warm:
    // $0.40 of spend meets the 0.5 x $0.3999 cap.
    const spent = [...entries, warmEntry(1_300_000, { input: 0, cacheRead: 100_000, output: 4 }, 0, 30)];
    const capped = evaluateGuard(EVENT, { ...view, entries: spent }, deps);
    expect(capped.spendUsd).toBeCloseTo(0.4, 9);
    expect(capped).toMatchObject({ action: "stop", reason: "budget-reached" });
  });

  it("pairs the max input rate with the min cache-read rate, not any other combination (T-02/AC-01)", () => {
    const view = {
      entries: [assistantEntry("Lite", 1_000_000, LITE_ANCHOR)],
      modelId: "Lite",
      mode: "global" as const,
      budget: BUDGET,
    };
    const protectedValue = evaluateGuard(EVENT, view, { readProfile: () => TWO_FITS }).protectedUsd;

    // invented: the same fixture's three wrong pairings — min-input/min-cache-read
    // $0.0079, max-input/max-cache-read $0.36, min-input/max-cache-read $0
    // (clamped). Each is computable from the two fits plus the fitted table, and
    // none coincides with the $0.3999 the right pairing gives.
    expect(protectedValue).toBeCloseTo(0.3999, 12);
    expect(protectedValue).not.toBeCloseTo(0.0079, 9);
    expect(protectedValue).not.toBeCloseTo(0.36, 9);
    expect(protectedValue).not.toBeCloseTo(0, 9);
  });

  // spec: fs-qoder-guard-governance T-03/AC-03, RE-SCOPED by supervisor ruling
  //   2026-10-04 (option A1). As written, T-03's witness — "no fitted entry
  //   reachable and a profile publishing no rateFit for any model" yielding the
  //   `{ rateSource: "none" }` sentinel — is UNREACHABLE: rung 3's universe is
  //   RATE_TABLE union the published learned fits, and RATE_TABLE is
  //   Object.freeze'd with three entries at pricing.ts:46-50 and never mutated,
  //   so the union is never empty. CU-01's own REWRITE row requires `Lite` to
  //   resolve `conservative` on exactly the fixture T-03 names. What stays
  //   witnessable is that rung 3 fabricates nothing.
  it("prices a rate-less model from the observed universe and invents nothing for an unpriceable window (T-03/AC-03)", () => {
    const view = { modelId: "Lite", mode: "global" as const, budget: BUDGET };

    // invented: 250,000 x (1.428571e-6 - 2.53968e-9) = $0.35650783 — a real
    // finite pair from the fitted table, never the zero pair that would price the
    // protected miss at nothing and stop every refresh.
    const anchored = evaluateGuard(
      EVENT,
      { ...view, entries: [assistantEntry("Lite", 1_000_000, { input: 250_000, cacheRead: 0, output: 10 })] },
      NO_LEARNED_FIT,
    );
    expect(anchored).toMatchObject({ action: "warm", reason: "approved", rateSource: "conservative" });
    expect(anchored.protectedUsd).toBeCloseTo(0.35650783, 12);
    expect(Number.isFinite(anchored.protectedUsd)).toBe(true);

    // The reachable face of "cannot be priced": no anchor row, so no rate —
    // conservative or otherwise — can size the protected miss.
    const unpriceable = evaluateGuard(EVENT, { ...view, entries: [] }, NO_LEARNED_FIT);
    expect(unpriceable).toEqual({
      action: "stop",
      reason: "economics-unavailable",
      rateSource: "conservative",
      spendUsd: 0,
      protectedUsd: 0,
    });
  });

  it("keeps the guard's conservative source out of a persisted usage row (T-04/AC-02)", () => {
    const view = {
      entries: [assistantEntry("Lite", 1_000_000, LITE_ANCHOR)],
      modelId: "Lite",
      mode: "global" as const,
      budget: BUDGET,
    };
    expect(evaluateGuard(EVENT, view, { readProfile: () => TWO_FITS }).rateSource).toBe("conservative");

    // The transport's own stamp path prices the same unmeasured model and writes
    // pricing.ts's vocabulary — no Credits and no fitted rate is `fallback`. The
    // guard's value has no route onto a persisted row.
    const priced = priceTurnCost(undefined, { input: 100_000, output: 4, cacheRead: 0, cacheWrite: 0 }, undefined);
    expect(priced.rateSource).toBe("fallback");
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "qoder-api" as AssistantMessage["api"],
      provider: "qoder",
      model: "Lite",
      usage: {
        input: 100_000,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100_004,
        cost: { ...priced.cost },
      },
      stopReason: "stop",
      timestamp: 1_000_000,
    };
    const done: AssistantMessageEvent = { type: "done", reason: "stop", message };
    stampTerminal(done, { rateSource: priced.rateSource });
    const persisted = (message.usage as { rateSource?: string }).rateSource;
    expect(persisted).toBe("fallback");
    expect(persisted).not.toBe("conservative");

    // AC-02's type half: the two unions are disjoint, so a guard source is not
    // assignable where a persisted one is expected. tsc is the witness; if the
    // unions ever overlap this row stops compiling rather than silently passing.
    type LeakedSource = GuardRateSource & RateSource;
    const disjoint: LeakedSource extends never ? true : false = true;
    expect(disjoint).toBe(true);
  });
});

// spec: fs-qoder-guard-governance T-07/T-08/T-09 — AC-05 (two misses in one
//   since-last-real-dispatch span stop at any fraction), AC-07 (an unstamped
//   clock leaves the ceiling inert), AC-09 (the ceiling never pre-empts the
//   guards above it). AC-06's half — a warm replay never stamps the clock — is
//   witnessed in run-identity.test.ts T-10.
describe("missed-warm ceiling (T-07/T-08/T-09, AC-05/AC-07/AC-09)", () => {
  // invented: a clock after the anchor (1,000,000) and before both misses
  // (1,300,000 / 1,600,000), so the span holds exactly two misses.
  const CLOCK = 1_200_000;
  const view = { modelId: MODEL, mode: "global" as const, budget: BUDGET };
  // invented: cheap misses ($0.0005 each) so no budget fraction can explain the
  // stop — the ceiling is the only thing that can produce it.
  const cheapMiss = (timestampMs: number) => warmEntry(timestampMs, MISS_TOKENS, 0, 0.0375);
  const anchor = () => assistantEntry(MODEL, 1_000_000, { input: ANCHOR_TOKENS, cacheRead: 0, output: 10 });

  it("latches at two misses in one span, at any budget fraction (T-07/AC-05)", () => {
    const entries = [anchor(), cheapMiss(1_300_000), cheapMiss(1_600_000)];
    const deps = { ...NO_LEARNED_FIT, lastRealRequestAt: () => CLOCK };

    for (const fraction of [0.5, 0.99]) {
      const verdict = evaluateGuard(EVENT, { ...view, entries, budget: { kind: "fraction", fraction } }, deps);
      expect(verdict).toMatchObject({ action: "stop", reason: "miss-latched", rateSource: "fitted" });
      // The latch moves the action and the reason only.
      expect(verdict.spendUsd).toBe(0);
      expect(verdict.protectedUsd).toBeCloseTo(0.2, 6);
    }

    // One miss is the budget comparison's business, not the ceiling's.
    const single = evaluateGuard(EVENT, { ...view, entries: [anchor(), cheapMiss(1_300_000)] }, deps);
    expect(single).toMatchObject({ action: "warm", reason: "approved" });

    // A miss that predates the clock is outside the span, so only the later one
    // counts: the span is bounded by real turns, not by the ledger. The clock sits
    // exactly ON the first miss's timestamp, which pins "after" as strict — a
    // `>=` comparison would latch here.
    const later = evaluateGuard(EVENT, { ...view, entries }, { ...NO_LEARNED_FIT, lastRealRequestAt: () => 1_300_000 });
    expect(later).toMatchObject({ action: "warm", reason: "approved" });

    // And a cache-read HIT is never a miss, however many of them postdate the
    // clock: two paid refreshes in one span are the budget's business.
    const hits = [
      anchor(),
      warmEntry(1_300_000, HIT_TOKENS, 0, REFRESH_CREDITS),
      warmEntry(1_600_000, HIT_TOKENS, 0, REFRESH_CREDITS),
    ];
    const paid = evaluateGuard(EVENT, { ...view, entries: hits }, deps);
    expect(paid).toMatchObject({ action: "stop", reason: "budget-reached" });
    expect(paid.spendUsd).toBeCloseTo(0.1, 9);
  });

  it("stays inert until a real dispatch stamps the clock (T-08/AC-07)", () => {
    const entries = [anchor(), cheapMiss(1_300_000), cheapMiss(1_600_000)];

    const unstamped = evaluateGuard(
      EVENT,
      { ...view, entries },
      { ...NO_LEARNED_FIT, lastRealRequestAt: () => undefined },
    );
    expect(unstamped).toMatchObject({ action: "warm", reason: "approved", spendUsd: 0 });

    // The production wiring: no dep at all, and this module generation has
    // dispatched no real turn, so the real run-identity reader is undefined too.
    // Every other row in this file depends on that same inertness.
    const defaulted = evaluateGuard(EVENT, { ...view, entries }, NO_LEARNED_FIT);
    expect(defaulted).toMatchObject({ action: "warm", reason: "approved" });
  });

  it("never pre-empts the guards above it (T-09/AC-09)", () => {
    const entries = [anchor(), cheapMiss(1_300_000), cheapMiss(1_600_000)];
    const deps = { ...NO_LEARNED_FIT, lastRealRequestAt: () => CLOCK };

    // Budget off: the cap cannot act, so neither can the ceiling.
    const uncapped = evaluateGuard(EVENT, { ...view, entries, budget: { kind: "off" } }, deps);
    expect(uncapped).toMatchObject({ action: "warm", reason: "budget-off" });

    // No anchor row: compaction reset it and neither refresh reported prompt
    // tokens, so nothing can price the miss. Two post-clock misses are present,
    // which is what makes this a precedence witness rather than a vacuous one —
    // "cannot be priced" must not be reported as "the cache is evicting".
    const zeroTokens = { input: 0, cacheRead: 0, output: 0 };
    const unpriceable = evaluateGuard(
      EVENT,
      {
        ...view,
        entries: [compactionEntry(1_000_000), warmEntry(1_300_000, zeroTokens), warmEntry(1_600_000, zeroTokens)],
      },
      deps,
    );
    expect(unpriceable).toEqual({
      action: "stop",
      reason: "economics-unavailable",
      rateSource: "fitted",
      spendUsd: 0,
      protectedUsd: 0,
    });

    // The spec's third movement — "with an empty rate universe it stays
    // rate-unavailable" — is unreachable under ruling A1: see the T-03 comment.
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
