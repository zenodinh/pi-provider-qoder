// Loaded only from the TUI branch of /qoder-context (dynamic import), so hosts
// without the pi-tui virtual module never resolve this file.
// shape: closure returning an object literal — trigger #4, screen state plus
//   render/input methods, no subclassing or instanceof anywhere (mirrors
//   quota-view.ts). The list mechanics (visible slice, → cursor, (i/n) scroll
//   indicator, wrap-around arrows) follow pi's own model-selector.js.
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import {
  applyCompactionOverride,
  applyWindowOverride,
  effectiveCompaction,
  effectiveWindow,
  listQoderModelLocations,
  openConfigStore,
  parsePercent,
  percentToTokens,
  type QoderModelLocation,
  tierList,
  tokensToPercent,
} from "./context.js";

const MAX_VISIBLE = 10;

// The only characters the inline percentage entry accepts; matched through
// matchesKey so legacy and Kitty keyboard sequences resolve to the same char.
const PERCENT_INPUT_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "%"] as const;

type CompactionField = "reserve" | "keep";

type Screen =
  | { kind: "models"; index: number }
  | { kind: "menu"; index: number }
  | { kind: "context"; index: number }
  | { kind: "compaction"; index: number; editing: CompactionField | undefined; buffer: string };

interface Notice {
  text: string;
  ok: boolean;
}

interface PanelDeps {
  tui: TUI;
  theme: Theme;
  done: (result: undefined) => void;
}

const MENU_ITEMS = ["Edit context window", "Edit compaction (reserve / keep)"];
const DEFAULT_WINDOW_LABEL = "default (Qoder's own)";
const CLEAR_COMPACTION_LABEL = "Clear compaction override";

function fmt(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function createContextPanel(deps: PanelDeps) {
  const store = openConfigStore();
  const models = listQoderModelLocations();
  let modelsJson: Record<string, unknown> = {};
  let settingsJson: Record<string, unknown> = {};
  let readError: string | undefined;
  let screen: Screen = { kind: "models", index: 0 };
  let current: QoderModelLocation | undefined;
  let notice: Notice | undefined;

  const reload = () => {
    try {
      ({ modelsJson, settingsJson } = store.read());
      readError = undefined;
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
  };
  reload();

  const repaint = () => deps.tui.requestRender();

  const save = (nextModels: Record<string, unknown>, nextSettings: Record<string, unknown>, okText: string): void => {
    try {
      store.write(nextModels, nextSettings);
    } catch (error) {
      notice = {
        text: `Could not write pi config: ${error instanceof Error ? error.message : String(error)}`,
        ok: false,
      };
      return;
    }
    reload();
    notice = { text: okText, ok: true };
  };

  const configKey = (loc: QoderModelLocation) => `${loc.providerID}/${loc.modelId}`;

  const count = (): number => {
    switch (screen.kind) {
      case "models":
        return models.length;
      case "menu":
        return MENU_ITEMS.length;
      case "context":
        return current ? tierList(current).length + 1 : 0;
      case "compaction":
        return 3;
    }
  };

  const move = (delta: number) => {
    const total = count();
    if (total === 0) return;
    screen.index = (screen.index + delta + total) % total;
    repaint();
  };

  const contextStartIndex = (loc: QoderModelLocation): number => {
    const tiers = tierList(loc);
    const { window, source } = effectiveWindow(modelsJson, loc);
    if (source === "override") {
      const at = tiers.indexOf(window);
      if (at >= 0) return at;
    }
    return tiers.length;
  };

  const modelRows = (): string[] =>
    models.map((loc) => {
      const { window } = effectiveWindow(modelsJson, loc);
      const compaction = effectiveCompaction(settingsJson, configKey(loc));
      return `${loc.modelId} [${loc.providerID}]  win ${fmt(window)} · r${tokensToPercent(compaction.reserveTokens, window)} k${tokensToPercent(compaction.keepTokens, window)}`;
    });

  const contextRows = (loc: QoderModelLocation): string[] => {
    const tiers = tierList(loc);
    const start = contextStartIndex(loc);
    const rows = tiers.map((tier, i) => `${i === start ? "✓ " : "  "}${fmt(tier)}`);
    rows.push(`${tiers.length === start ? "✓ " : "  "}${DEFAULT_WINDOW_LABEL}`);
    return rows;
  };

  const compactionRows = (loc: QoderModelLocation): string[] => {
    const { window } = effectiveWindow(modelsJson, loc);
    const compaction = effectiveCompaction(settingsJson, configKey(loc));
    const fieldRow = (field: CompactionField, tokens: number): string => {
      if (screen.kind === "compaction" && screen.editing === field) {
        return `${field} = ${screen.buffer}%   (enter save · esc cancel)`;
      }
      return `${field}  ${tokensToPercent(tokens, window)}  (${fmt(tokens)} tokens)`;
    };
    return [
      fieldRow("reserve", compaction.reserveTokens),
      fieldRow("keep", compaction.keepTokens),
      `${compaction.fromOverride ? "✓ " : "  "}${CLEAR_COMPACTION_LABEL}`,
    ];
  };

  const backOrClose = () => {
    if (screen.kind === "models") {
      deps.done(undefined);
      return;
    }
    if (screen.kind === "menu") {
      const at = current ? models.indexOf(current) : 0;
      screen = { kind: "models", index: at < 0 ? 0 : at };
    } else {
      screen = { kind: "menu", index: 0 };
    }
    notice = undefined;
    repaint();
  };

  const commitPercent = (loc: QoderModelLocation) => {
    if (screen.kind !== "compaction" || screen.editing === undefined) return;
    const field = screen.editing;
    const pct = parsePercent(screen.buffer);
    if (pct === undefined) {
      notice = {
        text: `${field}= expects a percentage between 0 and 100, like 10% (got “${screen.buffer}”).`,
        ok: false,
      };
      repaint();
      return;
    }
    const { window } = effectiveWindow(modelsJson, loc);
    const tokens = percentToTokens(pct, window);
    const next = applyCompactionOverride({
      settingsJson,
      providerID: loc.providerID,
      modelId: loc.modelId,
      reserveTokens: field === "reserve" ? tokens : undefined,
      keepTokens: field === "keep" ? tokens : undefined,
    });
    save(modelsJson, next, `${configKey(loc)} ${field} set to ${pct}% (${fmt(tokens)} tokens).`);
    screen.editing = undefined;
    screen.buffer = "";
    repaint();
  };

  const confirm = () => {
    if (screen.kind === "models") {
      current = models[screen.index];
      if (!current) return;
      screen = { kind: "menu", index: 0 };
      notice = undefined;
      repaint();
      return;
    }
    if (!current) return;
    if (screen.kind === "menu") {
      screen =
        screen.index === 0
          ? { kind: "context", index: contextStartIndex(current) }
          : { kind: "compaction", index: 0, editing: undefined, buffer: "" };
      notice = undefined;
      repaint();
      return;
    }
    if (screen.kind === "context") {
      const tiers = tierList(current);
      const isDefault = screen.index >= tiers.length;
      const next = applyWindowOverride({
        modelsJson,
        providerID: current.providerID,
        modelId: current.modelId,
        window: isDefault ? "default" : (tiers[screen.index] ?? "default"),
      });
      save(
        next,
        settingsJson,
        `${configKey(current)} window set to ${isDefault ? DEFAULT_WINDOW_LABEL : fmt(tiers[screen.index] ?? 0)}.`,
      );
      screen = { kind: "models", index: Math.max(0, models.indexOf(current)) };
      repaint();
      return;
    }
    // compaction
    if (screen.index === 0) {
      screen.editing = "reserve";
      screen.buffer = "";
      repaint();
      return;
    }
    if (screen.index === 1) {
      screen.editing = "keep";
      screen.buffer = "";
      repaint();
      return;
    }
    const next = applyCompactionOverride({
      settingsJson,
      providerID: current.providerID,
      modelId: current.modelId,
      reset: true,
    });
    save(modelsJson, next, `${configKey(current)} compaction override cleared.`);
    repaint();
  };

  const handleEditInput = (data: string) => {
    if (screen.kind !== "compaction" || screen.editing === undefined) return;
    if (matchesKey(data, Key.escape)) {
      screen.editing = undefined;
      screen.buffer = "";
      repaint();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (current) commitPercent(current);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      screen.buffer = screen.buffer.slice(0, -1);
      repaint();
      return;
    }
    for (const ch of PERCENT_INPUT_KEYS) {
      if (matchesKey(data, ch)) {
        screen.buffer += ch;
        repaint();
        return;
      }
    }
  };

  const handleInput = (data: string) => {
    if (readError !== undefined) {
      if (matchesKey(data, Key.escape)) deps.done(undefined);
      return;
    }
    if (screen.kind === "compaction" && screen.editing !== undefined) {
      handleEditInput(data);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      backOrClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      move(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      move(1);
      return;
    }
    if (matchesKey(data, Key.enter)) confirm();
  };

  const pushList = (lines: string[], rows: string[], index: number, theme: Theme) => {
    const start = Math.max(0, Math.min(index - Math.floor(MAX_VISIBLE / 2), rows.length - MAX_VISIBLE));
    const end = Math.min(start + MAX_VISIBLE, rows.length);
    for (let i = start; i < end; i++) {
      const cursor = i === index ? theme.fg("accent", "→ ") : "  ";
      lines.push(`${cursor}${rows[i]}`);
    }
    if (start > 0 || end < rows.length) lines.push(theme.fg("dim", `  (${index + 1}/${rows.length})`));
  };

  const footerFor = (): string => {
    if (screen.kind === "compaction" && screen.editing !== undefined) {
      return "type a percentage · enter save · esc cancel";
    }
    switch (screen.kind) {
      case "models":
        return "↑↓ move · enter open · esc close";
      case "menu":
        return "↑↓ move · enter open · esc back";
      default:
        return "↑↓ move · enter save · esc back";
    }
  };

  const render = (width: number): string[] => {
    const theme = deps.theme;
    const lines: string[] = [theme.fg("border", "─".repeat(width)), ""];
    if (readError !== undefined) {
      lines.push(theme.fg("error", `  Could not read pi config: ${readError}`), "");
      lines.push(theme.fg("dim", "  esc close"));
      lines.push(theme.fg("border", "─".repeat(width)));
      return lines;
    }
    if (screen.kind === "models") {
      lines.push(theme.bold("Qoder context"), "");
      pushList(lines, modelRows(), screen.index, theme);
    } else if (current) {
      const { window } = effectiveWindow(modelsJson, current);
      lines.push(theme.bold(`${configKey(current)}  ·  window ${fmt(window)}`), "");
      if (screen.kind === "menu") pushList(lines, MENU_ITEMS, screen.index, theme);
      else if (screen.kind === "context") pushList(lines, contextRows(current), screen.index, theme);
      else pushList(lines, compactionRows(current), screen.index, theme);
    }
    lines.push("", theme.fg("dim", `  ${footerFor()}`));
    if (notice) lines.push(theme.fg(notice.ok ? "success" : "warning", `  ${notice.text}`));
    lines.push(theme.fg("border", "─".repeat(width)));
    return lines;
  };

  return { render, handleInput, invalidate: repaint };
}

// shape: none — a single awaited ctx.ui.custom call; no discriminator, no state.
// No `overlay` option: the panel owns the editor area, matching how /model renders.
export async function showContextPanel(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => createContextPanel({ tui, theme, done }));
}
