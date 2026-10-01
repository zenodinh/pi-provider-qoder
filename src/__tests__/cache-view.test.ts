import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { CacheHealth, CachePanelData } from "../commands/cache.js";
import { showCachePanel } from "../commands/cache-view.js";

// invented: panel fixtures shaped like the real-ledger probe output
// (2026-10-01, 72 session files: 31 refreshes, DeepSeek-Flash ~1,600 gaps).
function panelData(overrides: Partial<CachePanelData> = {}): CachePanelData {
  const health: CacheHealth = {
    filesScanned: 72,
    scanTruncated: false,
    refreshes: { count: 31, spendUsd: 0.7822, medianCacheReadShare: 1, rewrites: 0 },
    survival: [
      { modelId: "DeepSeek-Flash", gaps: 1595, medianRatio: 0.99, probableMisses: 28, pricedTurns: 1020 },
      { modelId: "gmodel", gaps: 25, medianRatio: 0.83, probableMisses: 9, pricedTurns: 0 },
    ],
    profiles: [
      {
        modelId: "DeepSeek-Flash",
        published: true,
        lifetimeSeconds: 600,
        samples: 30,
        computedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        rSquared: 0.998,
        stale: false,
      },
      {
        modelId: "GLM-5.2",
        published: false,
        lifetimeSeconds: 300,
        samples: 12,
        computedAt: undefined,
        rSquared: undefined,
        stale: false,
      },
    ],
    verdict: "ok",
  };
  return { config: "config: gate ON · budget 0.5", health, ...overrides };
}

interface CapturedComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

/** Fake TUI host: captures the component the panel factory returns (tui.md). */
async function openPanel(options: { data?: CachePanelData; refresh?: () => Promise<CachePanelData> } = {}): Promise<{
  component: CapturedComponent;
  renders: { count: number };
  done: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}> {
  const renders = { count: 0 };
  const fakeTui = {
    requestRender: () => {
      renders.count += 1;
    },
  };
  const fakeTheme = { fg: (_kind: string, text: string) => text, bold: (text: string) => text };
  const done = vi.fn();
  const refresh = vi.fn(options.refresh ?? (async () => options.data ?? panelData()));
  let component: CapturedComponent | undefined;
  const fakeCtx = {
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: unknown) => CapturedComponent) => {
        component = factory(fakeTui, fakeTheme, {}, done);
        return Promise.resolve(undefined);
      },
    },
  };
  await showCachePanel(fakeCtx as never, { ...(options.data ?? panelData()), refresh });
  if (!component) throw new Error("factory did not return a component");
  return { component, renders, done, refresh };
}

describe("showCachePanel", () => {
  it("renders a bordered panel with all three evidence sections", async () => {
    const { component } = await openPanel();
    expect(typeof component.render).toBe("function");
    expect(typeof component.handleInput).toBe("function");
    expect(typeof component.invalidate).toBe("function");

    const lines = component.render(80);
    const rule = "─".repeat(80);
    expect(lines[0]).toBe(rule);
    expect(lines[lines.length - 1]).toBe(rule);

    const text = lines.join("\n");
    expect(text).toContain("Qoder cache warming  OK");
    expect(text).toContain("config: gate ON · budget 0.5");
    expect(text).toContain("scanned 72 session file(s), newest first");
    expect(text).toContain("Refreshes");
    expect(text).toContain("31 · $0.7822 spent · median cache-read share 1.00 · rewrites 0");
    expect(text).toContain("Survival");
    expect(text).toContain("DeepSeek-Flash");
    expect(text).toContain("1595 gaps");
    expect(text).toContain("28 misses");
    expect(text).toContain("Profile");
    expect(text).toContain("600 s");
    expect(text).toContain("30 samples");
    expect(text).toContain("2h old");
    expect(text).toContain("R² 0.998");
    expect(text).toContain("default 300 s");
    expect(text).toContain("12 gaps · not published");
    expect(text).toContain("per-decision detail: QODER_DEBUG=1");
    expect(text).toContain("esc/q close · r rescan");
  });

  it("reports the warn and inactive states without inventing numbers", async () => {
    const warn = panelData({
      health: {
        ...panelData().health,
        verdict: "warn",
        refreshes: { count: 3, spendUsd: 0.0382, medianCacheReadShare: 0.3, rewrites: 2 },
      },
    });
    const warnPanel = await openPanel({ data: warn });
    expect(warnPanel.component.render(100).join("\n")).toContain("WARN");

    const inactive = panelData({
      health: {
        ...panelData().health,
        verdict: "inactive",
        refreshes: { count: 0, spendUsd: 0, medianCacheReadShare: undefined, rewrites: 0 },
      },
    });
    const inactivePanel = await openPanel({ data: inactive });
    expect(inactivePanel.component.render(100).join("\n")).toContain(
      "none recorded — check QODER_CACHE_WARM=1 and pi's cacheWarming setting",
    );
  });

  it("rescans on r and closes on esc/q", async () => {
    const updated = panelData();
    updated.health = {
      ...updated.health,
      refreshes: { count: 32, spendUsd: 0.8204, medianCacheReadShare: 1, rewrites: 0 },
    };
    const { component, renders, done, refresh } = await openPanel({ refresh: async () => updated });

    component.handleInput("r");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(renders.count).toBeGreaterThan(0);
    expect(component.render(100).join("\n")).toContain("32 · $0.8204 spent");

    component.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
    component.handleInput("q");
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("fits every line inside the terminal width when narrow", async () => {
    const { component } = await openPanel();
    for (const width of [40, 60, 80]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }

    // A config line longer than every width still degrades instead of overflowing.
    const long = panelData();
    long.config = "config: gate OFF · budget off (uncapped) · see README for the full monitoring runbook";
    const narrow = await openPanel({ data: long });
    for (const width of [40, 60, 80]) {
      for (const line of narrow.component.render(width)) {
        expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });
});
