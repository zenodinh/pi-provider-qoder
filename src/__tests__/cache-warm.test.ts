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
// providers.test.ts), and QODER_CACHE_WARM decides the hook under test.
const patEnvNames = [
  "QODER_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODERCN_API_KEY",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
] as const;
// Save/restore includes the warming switch so each test starts clean, plus the
// debug sink pair the miss-latched row reads the verdict reason through.
const envNames = [...patEnvNames, "QODER_CACHE_WARM", "QODER_DEBUG", "QODER_DEBUG_DIR"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

// The gate's file layer (spec fs-qoder-warm-arming CU-02): a per-machine
// approval record in the agent directory. Unset env is no longer sufficient for
// OFF, so a row that expects OFF has to establish that this file is absent too.
const APPROVAL_FILENAME = "qoder-warm-approval.json";

function approvalPath(): string {
  return join(getPiAgentDir(), APPROVAL_FILENAME);
}

/** recorded-from: SA §5.2 approval-file example, 2026-10-04. */
function seedApproval(providers: Record<string, boolean>): void {
  writeFileSync(approvalPath(), JSON.stringify({ version: 1, providers }), "utf8");
}

function clearApproval(): void {
  rmSync(approvalPath(), { force: true });
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // The harness gives this file one HOME for all its rows, so a seeded approval
  // file would otherwise arm every later row that expects OFF.
  clearApproval();
  vi.resetModules();
});

type CacheWarmingHandler = (event: CacheWarmingDecisionEvent, ctx?: unknown) => unknown;

async function loadHandlers(): Promise<Map<string, CacheWarmingHandler>> {
  // Only the PATs are cleared here; QODER_CACHE_WARM is the subject of the test.
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
// ctx fixtures below share it; the rows witness the arming gate, not the ledger.
function anchorBranch() {
  return [assistantEntry("Lite", 1_000_000, { input: 100_000, cacheRead: 0, output: 10 })];
}

// The guarded handler reads the session branch, so the fixture ctx carries a
// stub session manager whose branch holds one real assistant row. FR-3
// (fs-qoder-guard-governance CU-01) prices every model, so an anchor-less branch
// is no longer the "ungoverned -> legacy force-warm" fixture it was: with a rate
// resolved and no anchor to size the protected miss, the guard stops with
// economics-unavailable. None of the rows below is about the rate ladder — they
// witness the arming gate, the action-only return and env/file precedence — so
// the fixture gives the guard a window it can price and their assertions stand.
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
  it("overrides pi's economics stop when QODER_CACHE_WARM=1", async () => {
    process.env.QODER_CACHE_WARM = "1";
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.(stopDecision, qoderCtx)).toEqual({ action: "warm" });
  });

  it("leaves the decision untouched when neither the env nor an approval file arms it", async () => {
    delete process.env.QODER_CACHE_WARM;
    // Unset env alone no longer decides OFF: the file layer is the second way
    // in. This harness's temp agent directory holds no approval file, which is
    // what makes the outcome OFF rather than what the env says.
    clearApproval();
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.(stopDecision, qoderCtx)).toBeUndefined();
  });

  it("leaves an already-warm decision untouched", async () => {
    process.env.QODER_CACHE_WARM = "1";
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.({ ...stopDecision, action: "warm" }, qoderCtx)).toBeUndefined();
  });

  it("does not override for other providers or an unknown model", async () => {
    process.env.QODER_CACHE_WARM = "1";
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
    process.env.QODER_CACHE_WARM = "1";
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

  it("leaves gate-off decisions untouched, and arms a governed model when the env says so", async () => {
    delete process.env.QODER_CACHE_WARM;
    clearApproval();
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    const governed = governedCtxTwoMisses();
    expect(await handler?.(stopDecision, governed)).toBeUndefined();
    expect(await handler?.({ ...stopDecision, action: "warm" }, governed)).toBeUndefined();

    process.env.QODER_CACHE_WARM = "1";
    expect(await handler?.({ ...stopDecision, action: "stop" }, qoderCtx)).toEqual({ action: "warm" });
  });
});

/**
 * The warming handler's mode now comes from the shared derivation (spec
 * fs-qoder-turn-plan CU-06, T-15/AC-01). The guard receives it, so the spy is
 * the only honest witness of the value handed over.
 */
describe("cache warming mode derivation (T-15/AC-01)", () => {
  it("T-15 passes cn for a qoder-cn model and global otherwise, as the inline ternary did", async () => {
    process.env.QODER_CACHE_WARM = "1";
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
 * Two-layer arming (spec fs-qoder-warm-arming T-08/T-09, SA §7.4). BUG-0002's
 * whole extent was the env-only early return at index.ts:294, so a process whose
 * shell forgot the export never reached the guard and pi's own economics stopped
 * every refresh — the $3.5347/day idle-gap re-bill the bug register records.
 */
describe("two-layer arming gate (T-08/T-09, AC-02/AC-03/AC-06)", () => {
  /** Same registry generation loadHandlers() created, so the spy sees the calls. */
  async function spyOnGuard() {
    const { evaluateGuard } = await import("../warm-guard.js");
    return vi.mocked(evaluateGuard);
  }

  /** A ctx whose ledger read is observable, so "consults nothing" is witnessable. */
  function watchedCtx() {
    // The branch carries an anchor for the same reason qoderCtx's does: the armed
    // half of this row asserts the handler's return, which needs a priceable
    // window. The spy is what the disarmed half witnesses through, unchanged.
    const getBranch = vi.fn(anchorBranch);
    return {
      ctx: { model: { provider: "qoder", id: "Lite" }, sessionManager: { getBranch } },
      getBranch,
    };
  }

  it("T-08 arms from the approval file in a process that never exported the gate", async () => {
    delete process.env.QODER_CACHE_WARM;
    seedApproval({ qoder: true });
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.(stopDecision, qoderCtx)).toEqual({ action: "warm" });
  });

  it("T-08 declines the same event when the approval file is absent", async () => {
    delete process.env.QODER_CACHE_WARM;
    clearApproval();
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    expect(await handler?.(stopDecision, qoderCtx)).toBeUndefined();
  });

  it("T-08 arms only the providers the file approves, read at decision time", async () => {
    delete process.env.QODER_CACHE_WARM;
    seedApproval({ "qoder-cn": true });
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    // qoder is omitted from the map, so it is not approved.
    expect(await handler?.(stopDecision, qoderCtx)).toBeUndefined();

    // Re-seeded without re-registering: the gate is read per decision, not
    // cached at registration, so pi's live mode reconciliation stays truthful.
    seedApproval({ qoder: true });
    expect(await handler?.(stopDecision, qoderCtx)).toEqual({ action: "warm" });

    // An explicit false is a refusal, not an omission.
    seedApproval({ qoder: false, "qoder-cn": true });
    expect(await handler?.(stopDecision, qoderCtx)).toBeUndefined();
  });

  it("T-09 env wins in both directions over an approved machine", async () => {
    seedApproval({ qoder: true });
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();

    // The per-process kill switch SA §10.2.3 documents for rollback.
    process.env.QODER_CACHE_WARM = "0";
    expect(await handler?.(stopDecision, qoderCtx)).toBeUndefined();

    // And env 1 arms a machine that never seeded the file.
    clearApproval();
    process.env.QODER_CACHE_WARM = "1";
    expect(await handler?.(stopDecision, qoderCtx)).toEqual({ action: "warm" });
  });

  it("T-09 a disarmed decision consults nothing, and an armed one returns action only", async () => {
    delete process.env.QODER_CACHE_WARM;
    clearApproval();
    const handler = (await loadHandlers()).get("cache_warming_decision");
    expect(handler, "extension did not register a cache_warming_decision handler").toBeDefined();
    const spy = await spyOnGuard();
    spy.mockClear();
    const { ctx, getBranch } = watchedCtx();

    expect(await handler?.(stopDecision, ctx)).toBeUndefined();
    expect(spy, "guard consulted on a disarmed event").not.toHaveBeenCalled();
    expect(getBranch, "ledger read on a disarmed event").not.toHaveBeenCalled();

    // Armed, the same event reaches the guard and returns {action} alone: the
    // host reads `action` and nothing else (runner.js:843-844), so a reason
    // cannot be transported and must not appear here.
    seedApproval({ qoder: true });
    const result = (await handler?.(stopDecision, ctx)) as Record<string, unknown>;
    expect(result).toEqual({ action: "warm" });
    expect(Object.keys(result)).toEqual(["action"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getBranch).toHaveBeenCalledTimes(1);
  });
});
