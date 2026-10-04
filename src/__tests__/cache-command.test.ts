import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessCacheHealth, handleCacheCommand, renderCacheHealth } from "../commands/cache.js";
import type { LedgerScan, LedgerWarmSample, LifetimeProfile } from "../lifetime.js";
import { resolveWarmGate } from "../warm-gate.js";
import { assistantEntry, warmEntry } from "./session-fixtures.js";

const MODEL = "DeepSeek-V4-Flash";
const savedEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  QODER_DEBUG: process.env.QODER_DEBUG,
  QODER_CACHE_WARM: process.env.QODER_CACHE_WARM,
  QODER_WARM_BUDGET: process.env.QODER_WARM_BUDGET,
};

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

// invented: samples shaped like the recorded ledgers (probed 2026-10-01):
// refresh rows are near-pure cache reads, with one re-write and a survival curve.
function warmSample(timestampMs: number, promptTokens: number, cacheRead: number, credits?: number): LedgerWarmSample {
  return { model: "auto", timestamp: timestampMs, promptTokens, cacheRead, credits, costTotal: 0 };
}

function scanOf(overrides: Partial<LedgerScan>): LedgerScan {
  return { models: {}, warm: [], files: 3, exceededBudget: false, ...overrides };
}

describe("assessCacheHealth (SA §10.2.1 metrics)", () => {
  it("aggregates refresh spend and cache-read share, flagging re-writes", () => {
    const health = assessCacheHealth(
      scanOf({
        warm: [
          warmSample(1_000, 100_000, 99_000, 2.8673033579999996),
          warmSample(2_000, 100_000, 99_000, 2.8673033579999996),
          warmSample(3_000, 100_000, 10_000, 3.75),
        ],
      }),
      undefined,
    );
    expect(health.refreshes.count).toBe(3);
    // (2.8673033579999996 x 2 + 3.75) / 75
    expect(health.refreshes.spendUsd).toBeCloseTo(0.1264614, 6);
    expect(health.refreshes.medianCacheReadShare).toBeCloseTo(0.99, 6);
    expect(health.refreshes.rewrites).toBe(1);
    expect(health.verdict).toBe("ok");
  });

  it("warns on re-write-heavy refreshes, warns on poor survival, and reports inactive", () => {
    const rewriteHeavy = assessCacheHealth(
      scanOf({
        warm: [
          warmSample(1_000, 100_000, 40_000),
          warmSample(2_000, 100_000, 30_000),
          warmSample(3_000, 100_000, 20_000),
        ],
      }),
      undefined,
    );
    expect(rewriteHeavy.refreshes.medianCacheReadShare).toBeCloseTo(0.3, 6);
    expect(rewriteHeavy.verdict).toBe("warn");

    const poorSurvival = assessCacheHealth(
      scanOf({
        warm: [warmSample(1_000, 100_000, 99_000, 2.8673033579999996)],
        models: {
          [MODEL]: { gaps: Array.from({ length: 6 }, () => ({ seconds: 200, ratio: 0.3 })), turns: [] },
        },
      }),
      undefined,
    );
    expect(poorSurvival.survival[0]?.probableMisses).toBe(6);
    expect(poorSurvival.verdict).toBe("warn");

    // A short record is not flagged: 3 low-survival gaps is noise, not a signal.
    const shortRecord = assessCacheHealth(
      scanOf({
        warm: [warmSample(1_000, 100_000, 99_000, 2.8673033579999996)],
        models: { [MODEL]: { gaps: [{ seconds: 60, ratio: 0.1 }], turns: [] } },
      }),
      undefined,
    );
    expect(shortRecord.verdict).toBe("ok");

    const inactive = assessCacheHealth(scanOf({ warm: [] }), undefined);
    expect(inactive.verdict).toBe("inactive");
    expect(inactive.refreshes.count).toBe(0);
  });
});

describe("renderCacheHealth", () => {
  it("renders published and default profile states with their evidence", () => {
    const now = Date.parse("2026-10-01T12:00:00.000Z");
    // invented: a published profile drawn from the SA §5.5 schema example.
    const profile: LifetimeProfile = {
      version: 2,
      updatedAt: "2026-10-01T06:00:00.000Z",
      models: {
        [MODEL]: {
          lifetimeSeconds: 600,
          samples: 30,
          computedAt: "2026-10-01T10:00:00.000Z",
          buckets: [],
          rateFit: {
            inputCreditsPerToken: 9.5238e-6,
            cacheReadCreditsPerToken: 1.90476e-7,
            outputCreditsPerToken: 3.80952e-5,
            rSquared: 0.9982,
            samples: 42,
            fittedAt: "2026-10-01T10:00:00.000Z",
          },
        },
      },
    };
    const health = assessCacheHealth(
      scanOf({
        warm: [warmSample(1_000, 100_000, 99_000, 2.8673033579999996)],
        models: {
          [MODEL]: { gaps: Array.from({ length: 30 }, () => ({ seconds: 200, ratio: 0.9 })), turns: [] },
          "GLM-5.2": { gaps: Array.from({ length: 12 }, () => ({ seconds: 90, ratio: 0.85 })), turns: [] },
        },
      }),
      profile,
      now,
    );
    const report = renderCacheHealth(health, now);
    expect(report).toContain("Qoder cache warming — OK");
    expect(report).toContain("refreshes: 1 · $0.0382 spent · median cache-read share 0.99 · rewrites 0");
    expect(report).toContain(`survival: ${MODEL} · median 0.90 across 30 gaps`);
    expect(report).toContain(`profile: ${MODEL} · 600 s (30 samples, 2h old · rate fit R² 0.998)`);
    expect(report).toContain("profile: GLM-5.2 · default 300 s stands (12 natural gaps, no published estimate)");
    expect(report).toContain("QODER_DEBUG=1");

    const inactive = renderCacheHealth(assessCacheHealth(scanOf({ warm: [] }), undefined), now);
    expect(inactive).toContain("Qoder cache warming — INACTIVE");
    expect(inactive).toContain("refreshes: none recorded");
    expect(inactive).toContain("survival: no natural idle gaps in the scanned window");
  });
});

/** A temp HOME laid out like the real one: sessions/<encoded>/<file>.jsonl. */
function homeWithSession(lines: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "qoder-cache-cmd-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  const sessions = join(home, ".pi", "agent", "sessions", "encoded-project");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "session.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return home;
}

/**
 * Seed both arming layers in the temp home's agent directory: pi's global
 * settings beside this extension's per-machine approval file.
 */
function seedGateFiles(home: string, piMode: string, providers: Record<string, boolean>): void {
  const dir = join(home, ".pi", "agent");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ cacheWarming: piMode }), "utf8");
  writeFileSync(join(dir, "qoder-warm-approval.json"), JSON.stringify({ version: 1, providers }), "utf8");
}

describe("/qoder-cache command", () => {
  it("reports config, refresh health, and survival from the always-on surfaces", async () => {
    const start = Date.UTC(2026, 9, 1, 0, 0, 0);
    const home = homeWithSession([
      JSON.stringify(assistantEntry(MODEL, start, { input: 1000, cacheRead: 9000, output: 100 })),
      JSON.stringify(assistantEntry(MODEL, start + 200_000, { input: 1000, cacheRead: 9000, output: 100 })),
      JSON.stringify(warmEntry(start + 300_000, { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.8673033579999996)),
    ]);
    process.env.QODER_CACHE_WARM = "1";
    process.env.QODER_WARM_BUDGET = "0.25";
    const notify = vi.fn();
    const ctx = { mode: "rpc", ui: { notify } } as never;

    await handleCacheCommand("", ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, kind] = notify.mock.calls[0] as [string, string];
    expect(kind).toBe("info");
    expect(message).toContain("config: pi streaming · gate qoder=ON(env) qoder-cn=ON(env) · budget 0.25");
    expect(message).toContain("Qoder cache warming — OK");
    expect(message).toContain("refreshes: 1 · $0.0382 spent");
    expect(message).toContain(`survival: ${MODEL} · median 0.90 across 1 gaps`);
    rmSync(home, { recursive: true, force: true });
  });

  it("opens the TUI panel instead of notifying when the host is in TUI mode", async () => {
    const start = Date.UTC(2026, 9, 1, 0, 0, 0);
    const home = homeWithSession([
      JSON.stringify(assistantEntry(MODEL, start, { input: 1000, cacheRead: 9000, output: 100 })),
      JSON.stringify(assistantEntry(MODEL, start + 200_000, { input: 1000, cacheRead: 9000, output: 100 })),
      JSON.stringify(warmEntry(start + 300_000, { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.8673033579999996)),
    ]);
    process.env.QODER_CACHE_WARM = "1";
    const notify = vi.fn();
    const theme = { fg: (_kind: string, text: string) => text, bold: (text: string) => text };
    interface CapturedPanel {
      render(width: number): string[];
      handleInput(data: string): void;
    }
    let panel: CapturedPanel | undefined;
    const custom = vi.fn((factory: (tui: unknown, theme: unknown, kb: unknown, done: unknown) => CapturedPanel) => {
      panel = factory({ requestRender: () => {} }, theme, {}, () => {});
      return Promise.resolve(undefined);
    });
    const ctx = { mode: "tui", ui: { notify, custom } } as never;

    await handleCacheCommand("", ctx);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    const text = panel?.render(80).join("\n") ?? "";
    expect(text).toContain("Qoder cache warming  OK");
    expect(text).toContain("config: pi streaming · gate qoder=ON(env) qoder-cn=ON(env) · budget 0.5");
    expect(text).toContain("Refreshes");
    expect(text).toContain("1 · $0.0382 spent");
    expect(text).toContain("esc/q close · r rescan");
    rmSync(home, { recursive: true, force: true });
  });

  it("raises a warning when survival health degrades", async () => {
    const start = Date.UTC(2026, 9, 1, 0, 0, 0);
    const lines = [JSON.stringify(assistantEntry(MODEL, start, { input: 7000, cacheRead: 3000, output: 100 }))];
    for (let index = 1; index <= 6; index += 1) {
      lines.push(
        JSON.stringify(assistantEntry(MODEL, start + index * 200_000, { input: 7000, cacheRead: 3000, output: 100 })),
      );
    }
    lines.push(JSON.stringify(warmEntry(start + 2_000_000, { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.867)));
    const home = homeWithSession(lines);

    delete process.env.QODER_CACHE_WARM;
    const notify = vi.fn();
    await handleCacheCommand("", { mode: "rpc", ui: { notify } } as never);

    const [message, kind] = notify.mock.calls[0] as [string, string];
    expect(kind).toBe("warning");
    expect(message).toContain("Qoder cache warming — WARN");
    expect(message).toContain("config: pi streaming · gate qoder=OFF(off) qoder-cn=OFF(off)");
    expect(message).toContain("probable misses 6");
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * T-07 (SA §7.4, AC-04/AC-06): the screen names pi's layer, each provider's
   * resolved verdict and the layer that decided it, and agrees with what
   * `resolveWarmGate` returns for the same state — the disagreement FR-2 names
   * as its failure condition.
   */
  it("renders both gate layers per provider, agreeing with resolveWarmGate", async () => {
    const home = homeWithSession([
      JSON.stringify(warmEntry(Date.UTC(2026, 9, 1), { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.867)),
    ]);
    // recorded-from: SA §5.2 approval-file example, 2026-10-04 — the divergent
    // case, where one region is approved and the other explicitly refused.
    seedGateFiles(home, "idle", { qoder: true, "qoder-cn": false });
    delete process.env.QODER_CACHE_WARM;
    process.env.QODER_WARM_BUDGET = "0.25";
    const notify = vi.fn();

    await handleCacheCommand("", { mode: "rpc", ui: { notify } } as never);

    const [message] = notify.mock.calls[0] as [string, string];
    const expected = "config: pi idle · gate qoder=ON(file) qoder-cn=OFF(off) · budget 0.25";
    expect(message).toContain(expected);

    // The screen and the handler read one derivation, so the line must match
    // what the gate itself resolves for the same fixture state.
    expect(resolveWarmGate("qoder")).toMatchObject({ armed: true, layer: "file", piMode: "idle" });
    expect(resolveWarmGate("qoder-cn")).toMatchObject({ armed: false, layer: "off", piMode: "idle" });
    for (const providerId of ["qoder", "qoder-cn"]) {
      const verdict = resolveWarmGate(providerId);
      expect(expected).toContain(`${providerId}=${verdict.armed ? "ON" : "OFF"}(${verdict.layer})`);
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("shows pi's OFF on the screen even when the extension layer would arm", async () => {
    const home = homeWithSession([
      JSON.stringify(warmEntry(Date.UTC(2026, 9, 1), { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.867)),
    ]);
    seedGateFiles(home, "off", { qoder: true, "qoder-cn": true });
    delete process.env.QODER_CACHE_WARM;
    const notify = vi.fn();

    await handleCacheCommand("", { mode: "rpc", ui: { notify } } as never);

    const [message] = notify.mock.calls[0] as [string, string];
    expect(message).toContain("config: pi off · gate qoder=ON(file) qoder-cn=ON(file)");
    rmSync(home, { recursive: true, force: true });
  });

  it("renders the divergent per-provider line untruncated at the panel's width 80", async () => {
    const home = homeWithSession([
      JSON.stringify(warmEntry(Date.UTC(2026, 9, 1), { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.867)),
    ]);
    seedGateFiles(home, "idle", { qoder: true, "qoder-cn": false });
    delete process.env.QODER_CACHE_WARM;
    process.env.QODER_WARM_BUDGET = "0.25";
    const notify = vi.fn();
    const theme = { fg: (_kind: string, text: string) => text, bold: (text: string) => text };
    interface CapturedPanel {
      render(width: number): string[];
      handleInput(data: string): void;
    }
    let panel: CapturedPanel | undefined;
    const custom = vi.fn((factory: (tui: unknown, theme: unknown, kb: unknown, done: unknown) => CapturedPanel) => {
      panel = factory({ requestRender: () => {} }, theme, {}, () => {});
      return Promise.resolve(undefined);
    });

    await handleCacheCommand("", { mode: "tui", ui: { notify, custom } } as never);

    const text = panel?.render(80).join("\n") ?? "";
    // The longest realistic gate line — both ON(file) and OFF(off) present.
    // cache-view.ts:154 renders one bestFit candidate and truncates at
    // innerWidth (width - 2 = 78), so this row is what pins the fit: if the
    // line ever outgrows the panel, it fails here rather than silently losing
    // the arming truth to truncation.
    const expected = "config: pi idle · gate qoder=ON(file) qoder-cn=OFF(off) · budget 0.25";
    expect(expected.length).toBeLessThanOrEqual(78);
    expect(text).toContain(expected);
    expect(notify).not.toHaveBeenCalled();
    rmSync(home, { recursive: true, force: true });
  });

  it("degrades by eating the budget half first, keeping the gate verdicts", async () => {
    const home = homeWithSession([
      JSON.stringify(warmEntry(Date.UTC(2026, 9, 1), { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.867)),
    ]);
    seedGateFiles(home, "streaming", { qoder: true, "qoder-cn": false });
    delete process.env.QODER_CACHE_WARM;
    // The widest budget label, which is what pushes the line past a narrow panel.
    process.env.QODER_WARM_BUDGET = "off";
    const notify = vi.fn();

    await handleCacheCommand("", { mode: "rpc", ui: { notify } } as never);

    const [message] = notify.mock.calls[0] as [string, string];
    expect(message).toContain("config: pi streaming · gate qoder=ON(file) qoder-cn=OFF(off) · budget off (uncapped)");
    // Gate left of budget, so truncation from the right takes the budget first.
    const line = "config: pi streaming · gate qoder=ON(file) qoder-cn=OFF(off) · budget off (uncapped)";
    expect(line.indexOf("gate")).toBeLessThan(line.indexOf("budget"));
    rmSync(home, { recursive: true, force: true });
  });
});
