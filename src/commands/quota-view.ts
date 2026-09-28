// Loaded only from the TUI branch of /qoder-quota (dynamic import), so hosts
// without the pi-tui virtual module never resolve this file.
// shape: closure returning an object literal — trigger #4, view state plus
//   render/input methods, no subclassing or instanceof anywhere.
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QoderUsageBucket } from "../auth/usage.js";
import { formatRenewalDate, type QuotaSection } from "./quota.js";

const PANEL_WIDTH = 84;
const MIN_PANEL_WIDTH = 48;
const BAR_CELLS = 10;
const LABEL_COLUMN = 21;
const AMOUNT_COLUMN = 14;
const PERCENT_COLUMN = 11;
const COLUMN_GAP = 2;

export interface QuotaPanelInput {
  sections: QuotaSection[];
  /** The command's collector with the cache bypassed. Never rejects: per-region failures become error sections. */
  refresh: () => Promise<QuotaSection[]>;
}

interface PanelDeps {
  tui: TUI;
  theme: Theme;
  sections: QuotaSection[];
  refresh: () => Promise<QuotaSection[]>;
  done: (result: undefined) => void;
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** Pad to a visible width; ANSI and OSC 8 escapes do not count (tui.md). */
function padTo(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function createPanel(deps: PanelDeps) {
  let sections = deps.sections;
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
    sections = await deps.refresh();
    refreshing = false;
    repaint();
  };

  const handleInput = (data: string) => {
    if (matchesKey(data, Key.escape) || data === "q") {
      deps.done(undefined);
      return;
    }
    if (data === "r") {
      // refresh() resolves by contract; its failures arrive as error sections.
      void refresh();
    }
  };

  const renderBar = (fraction: number | undefined, theme: Theme): string => {
    if (fraction === undefined) return " ".repeat(BAR_CELLS);
    const filled = Math.round(fraction * BAR_CELLS);
    return theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_CELLS - filled));
  };

  const renderBucketRow = (bucket: QoderUsageBucket, theme: Theme): string => {
    if (bucket.available === false) {
      return `${padTo(bucket.label, LABEL_COLUMN)}${" ".repeat(COLUMN_GAP)}${theme.fg("muted", "Unavailable")}`;
    }
    const amount =
      bucket.limitDisplay !== undefined ? `${bucket.usedDisplay} / ${bucket.limitDisplay}` : bucket.usedDisplay;
    const percent = bucket.usedPercentDisplay !== undefined ? `(used ${bucket.usedPercentDisplay})` : "";
    const remaining = bucket.remainingDisplay !== undefined ? `Remaining ${bucket.remainingDisplay}` : "";
    return [
      padTo(bucket.label, LABEL_COLUMN),
      padTo(amount, AMOUNT_COLUMN),
      renderBar(bucket.usedFraction, theme),
      padTo(percent, PERCENT_COLUMN),
      remaining,
    ]
      .filter((part) => part.length > 0)
      .join(" ".repeat(COLUMN_GAP));
  };

  const renderHeader = (left: string, right: string, theme: Theme, innerWidth: number): string => {
    if (right.length === 0) return left;
    const gap = Math.max(COLUMN_GAP, innerWidth - visibleWidth(left) - visibleWidth(right));
    return left + " ".repeat(gap) + theme.fg("muted", right);
  };

  const renderContent = (innerWidth: number, theme: Theme): string[] => {
    const content: string[] = [];
    content.push(theme.bold("Qoder quota") + (refreshing ? theme.fg("muted", "  refreshing…") : ""));
    content.push("");
    for (const section of sections) {
      if (section.state.kind === "error") {
        content.push(theme.fg("accent", `[${section.loginName}]`));
        content.push(theme.fg("error", `quota unavailable: ${section.state.message}`));
        content.push("");
        continue;
      }
      const { usage, servedFromCache, cacheAgeMs } = section.state;
      const left = `[${section.loginName}]${usage.userType ? ` · ${usage.userType}` : ""}`;
      const cachedNote = servedFromCache ? `(cached ${Math.round(cacheAgeMs / 1000)}s ago)` : "";
      const right = [usage.resetAt !== undefined ? `Renews on ${formatRenewalDate(usage.resetAt)}` : "", cachedNote]
        .filter((part) => part.length > 0)
        .join("  ");
      content.push(renderHeader(left, right, theme, innerWidth));
      if (usage.exceeded)
        content.push(theme.fg("warning", "Quota exceeded: new requests are blocked until the reset date"));
      for (const bucket of usage.usageBuckets ?? []) content.push(renderBucketRow(bucket, theme));
      if (usage.usageUrl !== undefined) {
        content.push(
          `${theme.fg("muted", "View details: ")}${hyperlink(stripProtocol(usage.usageUrl), usage.usageUrl)}`,
        );
      }
      if (usage.exceeded && usage.upgradeUrl !== undefined) {
        content.push(
          `${theme.fg("muted", "Upgrade plan: ")}${hyperlink(stripProtocol(usage.upgradeUrl), usage.upgradeUrl)}`,
        );
      }
      content.push("");
    }
    content.push(theme.fg("muted", "esc/q close · r refresh"));
    return content;
  };

  const renderPanel = (panelWidth: number): string[] => {
    const theme = deps.theme;
    const innerWidth = panelWidth - 4;
    const content = renderContent(innerWidth, theme);
    const lines = [theme.fg("border", `╭${"─".repeat(panelWidth - 2)}╮`)];
    for (const line of content) {
      lines.push(`${theme.fg("border", "│")} ${padTo(line, innerWidth)} ${theme.fg("border", "│")}`);
    }
    lines.push(theme.fg("border", `╰${"─".repeat(panelWidth - 2)}╯`));
    return lines;
  };

  const render = (width: number): string[] => {
    const panelWidth = Math.max(Math.min(width, PANEL_WIDTH), MIN_PANEL_WIDTH);
    if (cache && cache.width === panelWidth) return cache.lines;
    const lines = renderPanel(panelWidth);
    cache = { width: panelWidth, lines };
    return lines;
  };

  return { render, handleInput, invalidate };
}

/** Open the compact quota panel; resolves when the user closes it. */
export async function showQuotaPanel(ctx: ExtensionCommandContext, input: QuotaPanelInput): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      createPanel({ tui, theme, sections: input.sections, refresh: input.refresh, done }),
    // Default overlay options centre the panel and size it to the component's lines.
    { overlay: true },
  );
}
