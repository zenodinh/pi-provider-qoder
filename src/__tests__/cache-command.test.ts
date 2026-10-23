import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessCacheHealth, handleCacheCommand, renderCacheHealth } from "../commands/cache.js";
import type { LedgerScan, LedgerWarmSample, LifetimeProfile } from "../lifetime.js";
import { assistantEntry, warmEntry } from "./session-fixtures.js";

const MODEL = "DeepSeek-V4-Flash";
const savedEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  QODER_DEBUG: process.env.QODER_DEBUG,
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

describe("assessCacheHealth — missed-deadline inference (unwarmed windows)", () => {
  // invented: gap shapes modelled on the 2026-10-11 ledger probe of session
  // 6f1c167e — 163 recorded idle windows, 12 of them long enough to owe a
  // refresh and ending cold — scaled to three gaps so the counts are checkable
  // by eye. With no profile, lifetime resolves to the declared 300 s default,
  // so a refresh is owed from 270 s (WARM_DELAY_RATIO 0.9, pi's default).
  const nearPureRead = (): LedgerWarmSample => warmSample(1_000, 100_000, 99_000, 2.8673033579999996);

  it("counts a long gap as an unwarmed window, and a cold one as an unwarmed rewrite", () => {
    const health = assessCacheHealth(
      scanOf({
        warm: [nearPureRead()],
        models: {
          [MODEL]: {
            gaps: [
              { seconds: 300, ratio: 0.2 }, // owed a refresh, ended cold
              { seconds: 280, ratio: 0.95 }, // owed a refresh, cache survived
              { seconds: 200, ratio: 0.1 }, // too short to owe one
            ],
            turns: [],
          },
        },
      }),
      undefined,
    );
    const survival = health.survival[0];
    expect(survival?.delaySeconds).toBe(270);
    expect(survival?.unwarmedWindows).toBe(2);
    expect(survival?.unwarmedRewrites).toBe(1);
    // The pre-existing counters are untouched: all three gaps still count, and
    // two of the three still read below REWRITE_SHARE.
    expect(survival?.gaps).toBe(3);
    expect(survival?.probableMisses).toBe(2);
  });

  it("warns on one unwarmed rewrite even with a healthy median and a short record", () => {
    const health = assessCacheHealth(
      scanOf({
        warm: [nearPureRead()],
        models: { [MODEL]: { gaps: [{ seconds: 300, ratio: 0.2 }], turns: [] } },
      }),
      undefined,
    );
    // gaps=1 is below SURVIVAL_MIN_GAPS and the refreshes are near-pure reads,
    // so neither pre-existing warn condition can fire — this one must.
    expect(health.verdict).toBe("warn");
  });

  it("stays ok when every owed window survived — an unwarmed window is not itself a failure", () => {
    const health = assessCacheHealth(
      scanOf({
        warm: [nearPureRead()],
        models: { [MODEL]: { gaps: [{ seconds: 300, ratio: 0.95 }], turns: [] } },
      }),
      undefined,
    );
    expect(health.survival[0]?.unwarmedWindows).toBe(1);
    expect(health.survival[0]?.unwarmedRewrites).toBe(0);
    expect(health.verdict).toBe("ok");
  });

  it("takes the threshold from a published profile lifetime, not the declared default", () => {
    // invented: the SA §5.5 profile shape, with a lifetime long enough that a
    // 500 s window is no longer owed a refresh.
    const profile: LifetimeProfile = {
      version: 2,
      updatedAt: "2026-10-01T06:00:00.000Z",
      models: {
        [MODEL]: {
          lifetimeSeconds: 1000,
          samples: 30,
          computedAt: "2026-10-01T10:00:00.000Z",
          buckets: [],
        },
      },
    };
    const health = assessCacheHealth(
      scanOf({
        warm: [nearPureRead()],
        // 500 s owes a refresh against the 300 s default (delay 270) but not
        // against the published 1000 s (delay 900).
        models: { [MODEL]: { gaps: [{ seconds: 500, ratio: 0.1 }], turns: [] } },
      }),
      profile,
    );
    expect(health.survival[0]?.delaySeconds).toBe(900);
    expect(health.survival[0]?.unwarmedWindows).toBe(0);
    expect(health.survival[0]?.unwarmedRewrites).toBe(0);
    expect(health.verdict).toBe("ok");
  });

  it("renders the missed line only when a window was owed a refresh", () => {
    const now = Date.parse("2026-10-01T12:00:00.000Z");
    const missed = renderCacheHealth(
      assessCacheHealth(
        scanOf({
          warm: [nearPureRead()],
          models: {
            [MODEL]: {
              gaps: [
                { seconds: 300, ratio: 0.2 },
                { seconds: 280, ratio: 0.95 },
              ],
              turns: [],
            },
          },
        }),
        undefined,
        now,
      ),
      now,
    );
    expect(missed).toContain(
      `missed:   ${MODEL} · 2 idle window(s) ≥ 270 s owed a refresh, none recorded · 1 ended in a re-write`,
    );

    const clean = renderCacheHealth(
      assessCacheHealth(
        scanOf({
          warm: [nearPureRead()],
          models: { [MODEL]: { gaps: [{ seconds: 200, ratio: 0.95 }], turns: [] } },
        }),
        undefined,
        now,
      ),
      now,
    );
    expect(clean).not.toContain("missed:");
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

/** Point pi's global settings in the temp home at one `cacheWarming` mode. */
function seedPiMode(home: string, piMode: string): void {
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ cacheWarming: piMode }), "utf8");
}

describe("/qoder-cache command", () => {
  it("reports config, refresh health, and survival from the always-on surfaces", async () => {
    const start = Date.UTC(2026, 9, 1, 0, 0, 0);
    const home = homeWithSession([
      JSON.stringify(assistantEntry(MODEL, start, { input: 1000, cacheRead: 9000, output: 100 })),
      JSON.stringify(assistantEntry(MODEL, start + 200_000, { input: 1000, cacheRead: 9000, output: 100 })),
      JSON.stringify(warmEntry(start + 300_000, { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.8673033579999996)),
    ]);
    process.env.QODER_WARM_BUDGET = "0.25";
    const notify = vi.fn();
    const ctx = { mode: "rpc", ui: { notify } } as never;

    await handleCacheCommand("", ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, kind] = notify.mock.calls[0] as [string, string];
    expect(kind).toBe("info");
    expect(message).toContain("config: pi streaming · warming on · budget 0.25");
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
    expect(text).toContain("config: pi streaming · warming on · budget 0.5");
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

    const notify = vi.fn();
    await handleCacheCommand("", { mode: "rpc", ui: { notify } } as never);

    const [message, kind] = notify.mock.calls[0] as [string, string];
    expect(kind).toBe("warning");
    expect(message).toContain("Qoder cache warming — WARN");
    // Nothing set anywhere: pi's streaming default is the only mode there is.
    expect(message).toContain("config: pi streaming · warming on · budget 0.5");
    expect(message).toContain("probable misses 6");
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * T-07 (SA §7.4, AC-04) as it stands after the retired approval layer: the
   * line names pi's warming mode — the only switch either side has — and the
   * budget that governs an approved refresh.
   */
  it("renders pi's mode and the budget on the config line", async () => {
    const home = homeWithSession([
      JSON.stringify(warmEntry(Date.UTC(2026, 9, 1), { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.867)),
    ]);
    seedPiMode(home, "idle");
    process.env.QODER_WARM_BUDGET = "0.25";
    const notify = vi.fn();

    await handleCacheCommand("", { mode: "rpc", ui: { notify } } as never);

    const [message] = notify.mock.calls[0] as [string, string];
    expect(message).toContain("config: pi idle · warming on · budget 0.25");
    rmSync(home, { recursive: true, force: true });
  });

  it("ignores an approval record an older version left behind", async () => {
    // The retired layer's durable record, in the shape an old build wrote: an
    // explicit `false` for both providers, which used to veto warming. Upgrading
    // leaves that file on disk, so it has to change nothing at all — not the
    // config line, not the report.
    const render = async (seed: (dir: string) => void): Promise<string> => {
      const home = homeWithSession([
        JSON.stringify(warmEntry(Date.UTC(2026, 9, 1), { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.867)),
      ]);
      seed(join(home, ".pi", "agent"));
      delete process.env.QODER_WARM_BUDGET;
      const notify = vi.fn();
      await handleCacheCommand("", { mode: "rpc", ui: { notify } } as never);
      const [message] = notify.mock.calls[0] as [string, string];
      rmSync(home, { recursive: true, force: true });
      return message;
    };

    // recorded-from: SA §5.2 approval-file example, 2026-10-04. The control arm
    // seeds nothing at all — a fresh install, which is the only other state.
    const withRecord = await render((dir) =>
      writeFileSync(
        join(dir, "qoder-warm-approval.json"),
        `{"version":1,"providers":{"qoder":false,"qoder-cn":false}}`,
        "utf8",
      ),
    );
    const withoutRecord = await render(() => {});

    expect(withRecord).toContain("config: pi streaming · warming on · budget 0.5");
    // Byte-identical: no rendered field may read the leftover record.
    expect(withRecord).toBe(withoutRecord);
  });

  it("reports pi's OFF on the line, and states its own half as on", async () => {
    // pi is the only switch: OFF is pi's value, and the extension's posture —
    // it approves whatever pi asks for — does not flip with it.
    const home = homeWithSession([
      JSON.stringify(warmEntry(Date.UTC(2026, 9, 1), { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.867)),
    ]);
    seedPiMode(home, "off");
    const notify = vi.fn();

    await handleCacheCommand("", { mode: "rpc", ui: { notify } } as never);

    const [message] = notify.mock.calls[0] as [string, string];
    expect(message).toContain("config: pi off · warming on · budget 0.5");
    rmSync(home, { recursive: true, force: true });
  });

  it("renders the widest config line untruncated at the panel's width 80", async () => {
    const home = homeWithSession([
      JSON.stringify(warmEntry(Date.UTC(2026, 9, 1), { input: 159, cacheRead: 141_568, output: 4 }, 0, 2.867)),
    ]);
    // `off (uncapped)` is the widest budget label there is. cache-view.ts renders
    // this line through a single bestFit candidate and truncates at innerWidth
    // (width - 2 = 78 at width 80), so the whole line has to fit there — a
    // future per-provider section would push it past the edge and fail here.
    process.env.QODER_WARM_BUDGET = "off";
    const full = "config: pi streaming · warming on · budget off (uncapped)";
    expect(full.length).toBeLessThanOrEqual(78);

    // rpc mode notifies the raw string, so nothing truncates.
    const notify = vi.fn();
    await handleCacheCommand("", { mode: "rpc", ui: { notify } } as never);
    const [message] = notify.mock.calls[0] as [string, string];
    expect(message).toContain(full);

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
    expect(text).toContain(full);
    rmSync(home, { recursive: true, force: true });
  });
});
