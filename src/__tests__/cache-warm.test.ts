import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheWarmingDecisionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPiAgentDir } from "../home.js";
import { debugMessages } from "./debug-sink.js";
import { assistantEntry, warmEntry } from "./session-fixtures.js";

/**
 * Spy seam for T-15: the mode the handler derives is only observable through the
 * guard call it makes, so the guard module is wrapped with its real behavior.
 * Named rather than inline because the miss-latched row unmocks the guard to
 * share one module generation with it, and has to put this back afterwards.
 */
async function guardSpyMock(importOriginal: () => Promise<typeof import("../warm-guard.js")>) {
  const actual = await importOriginal();
  return { ...actual, evaluateGuard: vi.fn(actual.evaluateGuard) };
}

vi.mock("../warm-guard.js", guardSpyMock);

// Keep the extension's startup path offline and deterministic: a visible PAT
// would make it attempt a login exchange against the network (same guard as
// providers.test.ts). The debug sink pair is saved too, for the miss-latched
// row that reads the verdict reason through it.
const patEnvNames = [
  "QODER_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODERCN_API_KEY",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
] as const;
const envNames = [...patEnvNames, "QODER_DEBUG", "QODER_DEBUG_DIR"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

// The retired approval layer's file (spec fs-qoder-warm-arming CU-02, deleted by
// the owner's decision that pi owns the caching intent). Nothing reads it any
// more; the row below writes one to witness exactly that.
const RETIRED_APPROVAL_FILENAME = "qoder-warm-approval.json";

function retiredApprovalPath(): string {
  return join(getPiAgentDir(), RETIRED_APPROVAL_FILENAME);
}

/** recorded-from: SA §5.2 approval-file example, 2026-10-04. */
function writeRetiredApproval(providers: Record<string, boolean>): void {
  writeFileSync(retiredApprovalPath(), JSON.stringify({ version: 1, providers }), "utf8");
}

function clearRetiredApproval(): void {
  rmSync(retiredApprovalPath(), { force: true });
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // The harness gives this file one HOME for all its rows, so a written record
  // would otherwise sit under every later row that asserts the approved default.
  clearRetiredApproval();
  vi.resetModules();
});

type CacheWarmingHandler = (event: CacheWarmingDecisionEvent, ctx?: unknown) => unknown;

async function loadHandlers(): Promise<Map<string, CacheWarmingHandler>> {
  for (const name of patEnvNames) delete process.env[name];
  const handlers = new Map<string, CacheWarmingHandler>();
  const pi = {
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    unregisterProvider: vi.fn(),
    on: vi.fn((name: string, handler: CacheWarmingHandler) => {
      handlers.set(name, handler);
      return () => {};
    }),
  };
  const { default: registerProviders } = await import("../index.js");
  await registerProviders(pi as never);
  return handlers;
}

const stopDecision: CacheWarmingDecisionEvent = {
  type: "cache_warming_decision",
  action: "stop",
  warmCost: 0,
  missCost: 0,
  continuationProbability: 0.15,
};

// invented: one real assistant row, so the guard has an anchor it can price. Both
// ctx fixtures below share it; the rows witness the approval, not the ledger.
function anchorBranch() {
  return [assistantEntry("Lite", 1_000_000, { input: 100_000, cacheRead: 0, output: 10 })];
}

// The guarded handler reads the session branch, so the fixture ctx carries a
// stub session manager whose branch holds one real assistant row. FR-3
// (fs-qoder-guard-governance CU-01) prices every model, so an anchor-less branch
// is no longer the "ungoverned -> legacy force-warm" fixture it was: with a rate
// resolved and no anchor to size the protected miss, the guard stops with
// economics-unavailable. None of the rows below is about the rate ladder — they
// witness the approval, the action-only return and the retired record — so the
// fixture gives the guard a window it can price and their assertions stand.
const qoderCtx = {
  model: { provider: "qoder", id: "Lite" },
  sessionManager: { getBranch: anchorBranch },
};

// invented: a governed branch whose last two refreshes both MISSED the cache —
// the eviction storm BUG-0004 records. The misses postdate `clock` (a stamped
// real dispatch) so they fall inside one since-last-real-dispatch span, and the
// anchor predates it. The spend window re-bases past both misses, so this branch
// is NOT at the budget cap: the stop it produces is the miss ceiling's.
function governedCtxTwoMisses(clock = Date.now()) {
  const anchor = assistantEntry("DeepSeek-V4-Flash", clock - 60_000, { input: 1_607_144, cacheRead: 0, output: 10 });
  const miss = (timestampMs: number) => warmEntry(timestampMs, { input: 1_607_144, cacheRead: 0, output: 4 }, 0, 3.75);
  return {
    model: { provider: "qoder", id: "DeepSeek-V4-Flash" },
    sessionManager: { getBranch: () => [anchor, miss(clock + 1_000), miss(clock + 2_000)] },
  };
}

describe("cache warming decision hook", () => {
  it("approves pi's economics stop with nothing set on the machine, returning action alone", async () => {
    // The whole contract: pi asked, this provider approves, and the host reads
    // `action` and nothing else (runner.js:843-844) — so no reason can be
    // transported and none may appear beside it.
    clearRetiredApproval();
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    const result = (await handler?.(stopDecision, qoderCtx)) as Record<string, unknown>;
    expect(result).toEqual({ action: "warm" });
    expect(Object.keys(result)).toEqual(["action"]);
  });

  it("leaves an already-warm decision untouched", async () => {
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.({ ...stopDecision, action: "warm" }, qoderCtx)).toBeUndefined();
  });

  it("does not override for other providers or an unknown model", async () => {
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.(stopDecision, { model: { provider: "anthropic" } })).toBeUndefined();
    expect(await handler?.(stopDecision, { model: undefined })).toBeUndefined();
  });

  // spec: fs-qoder-guard-governance CU-04 inversion 3 — base 943459f pinned
  //   `toEqual({ action: "stop" })` here over two `cacheRead: 0` refreshes with an
  //   undefined clock. FR-5 re-bases the spend window past those misses, so the
  //   budget no longer explains the stop; the miss ceiling does. The reason is
  //   asserted through the QODER_DEBUG verdict line, which is the only surface it
  //   has: the host reads `action` and nothing else (runner.js:843-844).
  it("stops pi's warm after two missed refreshes in one real-turn span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-warm-debug-"));
    process.env.QODER_DEBUG = "1";
    process.env.QODER_DEBUG_DIR = dir;
    // The spy seam above is built through `importOriginal`, and vitest pins that
    // module graph to the generation it first resolved in: after this file's
    // `vi.resetModules()` the wrapped evaluateGuard still closes over the FIRST
    // generation's run-identity, so a clock stamped from a later row is invisible
    // to it (measured: the handler approved while the test's own reader was
    // stamped). Unmocking the guard puts index.js and this row on one generation
    // and therefore one real-turn clock; the finally block restores the spy.
    vi.doUnmock("../warm-guard.js");
    vi.resetModules();
    try {
      const handler = (await loadHandlers()).get("cache_warming_decision");
      expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();

      // Stamp the clock the way a dispatch does, through the same generation the
      // freshly imported index.js reads.
      const { lastRealRequestAt, resolveRunIdentity } = await import("../protocol/run-identity.js");
      resolveRunIdentity({
        mode: "global",
        upstreamKey: "dfmodel",
        wireSessionId: "session-warm",
        messages: [],
        lastUserText: "task",
        product: "cli",
        turnKind: "real",
      });
      const clock = lastRealRequestAt();
      expect(clock, "the real dispatch did not stamp the clock").toBeDefined();

      expect(await handler?.({ ...stopDecision, action: "warm" }, governedCtxTwoMisses(clock))).toEqual({
        action: "stop",
      });
      const verdicts = debugMessages(dir).filter((line) => line.startsWith("cache warming verdict:"));
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).toContain("reason=miss-latched");
      expect(verdicts[0]).toContain("rateSource=fitted");
    } finally {
      vi.doMock("../warm-guard.js", guardSpyMock);
      vi.resetModules();
    }
  });
});

/**
 * The warming handler's mode now comes from the shared derivation (spec
 * fs-qoder-turn-plan CU-06, T-15/AC-01). The guard receives it, so the spy is
 * the only honest witness of the value handed over.
 */
describe("cache warming mode derivation (T-15/AC-01)", () => {
  it("T-15 passes cn for a qoder-cn model and global otherwise, as the inline ternary did", async () => {
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    // Same registry generation the freshly imported index.js used, so this is
    // the very function the handler calls.
    const { evaluateGuard } = await import("../warm-guard.js");
    const guardSpy = vi.mocked(evaluateGuard);
    guardSpy.mockClear();

    await handler?.(stopDecision, {
      model: { provider: "qoder", id: "Lite" },
      sessionManager: { getBranch: () => [] },
    });
    expect(guardSpy.mock.calls.at(-1)?.[1]).toMatchObject({ mode: "global" });

    await handler?.(stopDecision, {
      model: { provider: "qoder-cn", id: "Qwen3.7-Plus" },
      sessionManager: { getBranch: () => [] },
    });
    expect(guardSpy.mock.calls.at(-1)?.[1]).toMatchObject({ mode: "cn" });
  });
});

/**
 * The second approval layer is gone by owner decision (spec fs-qoder-warm-arming
 * T-08/T-09, retired). BUG-0002's whole extent was the env-only early return at
 * index.ts:294, so a process whose shell forgot the export never reached the
 * guard and pi's own economics stopped every refresh — the $3.5347/day idle-gap
 * re-bill the bug register records. The fix could have been a better gate; the
 * decision was no gate, because pi is the harness and the caching intent is
 * pi's. What is left to prove is that nothing on disk can still subtract.
 */
describe("no second approval layer (T-08/AC-02)", () => {
  /** Same registry generation loadHandlers() created, so the spy sees the calls. */
  async function spyOnGuard() {
    const { evaluateGuard } = await import("../warm-guard.js");
    return vi.mocked(evaluateGuard);
  }

  /** A ctx whose ledger read is observable, so "the guard ran" is witnessable. */
  function watchedCtx() {
    const getBranch = vi.fn(anchorBranch);
    return {
      ctx: { model: { provider: "qoder", id: "Lite" }, sessionManager: { getBranch } },
      getBranch,
    };
  }

  it("warms a decision pi stopped even with an older version's record saying false", async () => {
    // recorded-from: SA §5.2 approval-file example, 2026-10-04 — the exact record
    // an old build left behind, which used to veto both providers.
    writeRetiredApproval({ qoder: false, "qoder-cn": false });
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    const spy = await spyOnGuard();
    spy.mockClear();
    const { ctx, getBranch } = watchedCtx();

    expect(await handler?.(stopDecision, ctx)).toEqual({ action: "warm" });
    // The guard still runs and the ledger is still read: the file cannot
    // short-circuit the decision, which is what makes it inert rather than
    // merely ignored on the way to the same answer.
    expect(spy, "guard skipped while a retired record sat on disk").toHaveBeenCalledTimes(1);
    expect(getBranch, "ledger skipped while a retired record sat on disk").toHaveBeenCalledTimes(1);
  });
});
