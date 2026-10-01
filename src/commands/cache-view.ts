// Loaded only from the TUI branch of /qoder-cache (dynamic import), so hosts
// without the pi-tui virtual module never resolve this file.
// shape: closure returning an object literal — trigger #4, view state plus
//   render/input methods, no subclassing or instanceof anywhere (mirrors
//   quota-view.ts).
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { debugLog } from "../debug.js";
import {
  ageText,
  type CacheHealth,
  type CachePanelData,
  type ModelProfileHealth,
  type ModelSurvivalHealth,
  shareText,
} from "./cache.js";

const MIN_INNER_WIDTH = 40;
const MODEL_COLUMN = 18;

export interface CachePanelInput extends CachePanelData {
  /** Re-scan + re-assess; the panel keeps the prior data if this rejects. */
  refresh: () => Promise<CachePanelData>;
}

interface PanelDeps {
  tui: TUI;
  theme: Theme;
  data: CachePanelData;
  refresh: () => Promise<CachePanelData>;
  done: (result: undefined) => void;
}

/** Pad to a visible width; ANSI and OSC 8 escapes do not count (tui.md). */
function padTo(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** First candidate that fits, else the last one truncated — the quota-view idiom. */
function bestFit(candidates: string[], innerWidth: number): string {
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= innerWidth) return candidate;
  }
  return truncateToWidth(candidates[candidates.length - 1] ?? "", innerWidth);
}

function createPanel(deps: PanelDeps) {
  let view = deps.data;
  let refreshing = false;
  let cache: { width: number; lines: string[] } | undefined;

  const invalidate = () => {
    cache = undefined;
  };

  const repaint = () => {
    invalidate();
    deps.tui.requestRender();
  };

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    repaint();
    try {
      view = await deps.refresh();
    } catch (error) {
      // Keep the prior data; a failed rescan must neither wedge nor blank the panel.
      debugLog("qoder cache panel refresh failed", error);
    } finally {
      refreshing = false;
      repaint();
    }
  };

  const handleInput = (chunk: string) => {
    if (matchesKey(chunk, Key.escape) || chunk === "q") {
      deps.done(undefined);
      return;
    }
    if (chunk === "r") {
      // refresh() never rejects; it keeps the prior data on failure.
      void refresh();
    }
  };

  const join = (parts: string[]) => parts.filter((part) => part.length > 0).join(" · ");

  const refreshRow = (health: CacheHealth, innerWidth: number): string => {
    if (health.refreshes.count === 0) {
      return bestFit(
        [
          "none recorded — check QODER_CACHE_WARM=1 and pi's cacheWarming setting",
          "none recorded — QODER_CACHE_WARM=1 enables them",
          "none recorded",
        ],
        innerWidth,
      );
    }
    const { count, spendUsd, medianCacheReadShare, rewrites } = health.refreshes;
    return bestFit(
      [
        `${count} · $${spendUsd.toFixed(4)} spent · median cache-read share ${shareText(medianCacheReadShare)} · rewrites ${rewrites}`,
        `${count} · $${spendUsd.toFixed(4)} spent · share ${shareText(medianCacheReadShare)}`,
        `${count} refreshes · $${spendUsd.toFixed(4)}`,
      ],
      innerWidth,
    );
  };

  const survivalRow = (model: ModelSurvivalHealth, innerWidth: number): string => {
    const head = padTo(model.modelId, MODEL_COLUMN);
    return bestFit(
      [
        join([
          `${head}${shareText(model.medianRatio)}`,
          `${model.gaps} gaps`,
          `${model.pricedTurns} turns`,
          `${model.probableMisses} misses`,
        ]),
        join([`${head}${shareText(model.medianRatio)}`, `${model.gaps} gaps`, `${model.probableMisses} misses`]),
        join([`${head}${shareText(model.medianRatio)}`, `${model.gaps} gaps`]),
      ],
      innerWidth,
    );
  };

  const profileRow = (model: ModelProfileHealth, innerWidth: number): string => {
    const head = padTo(model.modelId, MODEL_COLUMN);
    const status = model.published ? `${model.lifetimeSeconds} s` : `default ${model.lifetimeSeconds} s`;
    const evidence = model.published
      ? `${model.samples} samples · ${ageText(model.computedAt, Date.now())}`
      : `${model.samples} gaps · not published`;
    const fitText = model.rSquared === undefined ? "" : `R² ${model.rSquared.toFixed(3)}`;
    return bestFit(
      [
        join([head + status, evidence, fitText, model.stale ? "stale" : ""]),
        join([head + status, evidence]),
        head + status,
      ],
      innerWidth,
    );
  };

  const renderContent = (innerWidth: number, theme: Theme): string[] => {
    const health = view.health;
    const verdictColor = health.verdict === "ok" ? "success" : health.verdict === "warn" ? "warning" : "muted";
    const lines: string[] = [];
    lines.push(
      `${theme.bold("Qoder cache warming")}  ${theme.fg(verdictColor, health.verdict.toUpperCase())}${refreshing ? theme.fg("muted", "  refreshing…") : ""}`,
    );
    lines.push("");
    lines.push(theme.fg("muted", bestFit([view.config], innerWidth)));
    const scanned = `scanned ${health.filesScanned} session file(s), newest first`;
    lines.push(
      theme.fg(
        "muted",
        bestFit(
          [
            `${scanned}${health.scanTruncated ? " (budget reached — older sessions not scanned)" : ""}`,
            `${scanned}${health.scanTruncated ? " (budget reached)" : ""}`,
            scanned,
          ],
          innerWidth,
        ),
      ),
    );
    lines.push("");
    lines.push(theme.bold("Refreshes"));
    lines.push(`  ${refreshRow(health, innerWidth - 2)}`);
    lines.push("");
    lines.push(theme.bold("Survival"));
    if (health.survival.length === 0) {
      lines.push(theme.fg("muted", "  no natural idle gaps in the scanned window"));
    } else {
      for (const model of health.survival) lines.push(`  ${survivalRow(model, innerWidth - 2)}`);
    }
    lines.push("");
    lines.push(theme.bold("Profile"));
    if (health.profiles.length === 0) {
      lines.push(theme.fg("muted", "  no models in the scanned window"));
    } else {
      for (const model of health.profiles) lines.push(`  ${profileRow(model, innerWidth - 2)}`);
    }
    lines.push("");
    lines.push(theme.fg("muted", "per-decision detail: QODER_DEBUG=1"));
    lines.push(theme.fg("dim", "esc/q close · r rescan"));
    return lines;
  };

  const renderFull = (width: number): string[] => {
    const theme = deps.theme;
    const innerWidth = Math.max(width - 2, MIN_INNER_WIDTH);
    const content = renderContent(innerWidth, theme);
    return [theme.fg("border", "─".repeat(width)), "", ...content, theme.fg("border", "─".repeat(width))];
  };

  const render = (width: number): string[] => {
    if (cache && cache.width === width) return cache.lines;
    const lines = renderFull(width);
    cache = { width, lines };
    return lines;
  };

  return { render, handleInput, invalidate };
}

// shape: none — a single awaited ctx.ui.custom call; no discriminator, no state.
// No `overlay` option: the panel owns the editor area, matching how /model renders.
export async function showCachePanel(ctx: ExtensionCommandContext, input: CachePanelInput): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
    createPanel({ tui, theme, data: { config: input.config, health: input.health }, refresh: input.refresh, done }),
  );
}
