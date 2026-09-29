// shape: none — parse-then-apply pipeline: the change set is data
//   (model/window/reserve/keep), not a branch driver, and the TUI/text split
//   is one branch on ctx.mode, below the dispatch-object threshold.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  contextWindowFromCatalog,
  getCachedModelConfig,
  getCachedModels,
  type QoderModelDef,
  staticCnModels,
  staticModels,
} from "../catalog.js";
import { debugLog } from "../debug.js";
import { getPiAgentDir } from "../home.js";
import { getQoderRegionConfig, QODER_MODES, type QoderMode } from "../region.js";

/** pi's built-in fallbacks (settings-manager DEFAULT_COMPACTION_TOKEN_SETTINGS). */
export const PI_DEFAULT_RESERVE_TOKENS = 16_384;
export const PI_DEFAULT_KEEP_RECENT_TOKENS = 20_000;

const USAGE = [
  "Usage: /qoder-context                       — show windows + compaction per model",
  "       /qoder-context <model> window=1M      — set the window (tier value or default)",
  "       /qoder-context <model> reserve=10% keep=15%",
  "       /qoder-context <model> reset          — drop both overrides",
].join("\n");

export interface ContextArgs {
  model?: string;
  window?: number | "default";
  reservePct?: number;
  keepPct?: number;
  reset?: boolean;
}

// shape: none — straight-line regex parse plus a range guard; no discriminator to dispatch on.
/** "10" or "10%" → 10; blank, non-numeric, or outside (0,100) → undefined (never coerce blind). */
export function parsePercent(raw: string): number | undefined {
  const match = /^([0-9]+(?:\.[0-9]+)?)%?$/.exec(raw.trim());
  if (!match) return undefined;
  const pct = Number(match[1]);
  return pct > 0 && pct < 100 ? pct : undefined;
}

export function parseContextArgs(args: string): { ok: true; value: ContextArgs } | { ok: false; error: string } {
  const value: ContextArgs = {};
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    if (token === "reset") {
      value.reset = true;
      continue;
    }
    const eq = token.indexOf("=");
    if (eq === -1) {
      if (value.model === undefined) {
        value.model = token;
        continue;
      }
      return { ok: false, error: `Unrecognized argument “${token}”.` };
    }
    const key = token.slice(0, eq);
    const raw = token.slice(eq + 1);
    if (key === "window") {
      if (raw.toLowerCase() === "default") {
        value.window = "default";
        continue;
      }
      const match = /^([0-9]+(?:\.[0-9]+)?)\s*([KM])?$/i.exec(raw);
      if (!match) return { ok: false, error: `window= expects a tier like 200K/400K/1M or default (got “${raw}”).` };
      const scale = match[2]?.toUpperCase() === "M" ? 1_000_000 : match[2] ? 1_000 : 1;
      value.window = Number(match[1]) * scale;
      continue;
    }
    if (key === "reserve" || key === "keep") {
      const pct = parsePercent(raw);
      if (pct === undefined) {
        return { ok: false, error: `${key}= expects a percentage between 0 and 100, like 10% (got “${raw}”).` };
      }
      if (key === "reserve") value.reservePct = pct;
      else value.keepPct = pct;
      continue;
    }
    return { ok: false, error: `Unknown option “${key}”.` };
  }
  return { ok: true, value };
}

/** Percentage of the effective window → pi's raw token setting (always ≥ 1). */
export function percentToTokens(pct: number, window: number): number {
  return Math.max(1, Math.round((pct / 100) * window));
}

export function tokensToPercent(tokens: number, window: number): string {
  return `${Math.round((tokens / window) * 1000) / 10}%`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (isRecord(existing)) return existing;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

export interface QoderModelLocation {
  mode: QoderMode;
  providerID: string;
  modelId: string;
  def: QoderModelDef;
}

/** Resolve an id (exact or case-insensitive) across both regions' model lists. */
export function findQoderModel(modelArg: string): QoderModelLocation | undefined {
  const wanted = modelArg.toLowerCase();
  for (const mode of QODER_MODES) {
    const cached = getCachedModels(mode);
    const list = cached.length > 0 ? cached : mode === "cn" ? staticCnModels : staticModels;
    const def = list.find((m) => m.id.toLowerCase() === wanted);
    if (def) return { mode, providerID: getQoderRegionConfig(mode).providerID, modelId: def.id, def };
  }
  return undefined;
}

function cloneJson(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

function writeJsonObject(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export interface WindowInput {
  modelsJson: Record<string, unknown>;
  providerID: string;
  modelId: string;
  window: number | "default";
}

/** Set or clear the models.json contextWindow override; returns a new document. */
export function applyWindowOverride(input: WindowInput): Record<string, unknown> {
  const models = cloneJson(input.modelsJson);
  const providers = ensureRecord(models, "providers");
  const provider = ensureRecord(providers, input.providerID);
  const overrides = ensureRecord(provider, "modelOverrides");
  if (input.window === "default") {
    delete overrides[input.modelId];
    if (Object.keys(overrides).length === 0) delete provider.modelOverrides;
    if (Object.keys(provider).length === 0) delete providers[input.providerID];
    if (Object.keys(providers).length === 0) delete models.providers;
    return models;
  }
  const entry = ensureRecord(overrides, input.modelId);
  entry.contextWindow = input.window;
  return models;
}

export interface CompactionInput {
  settingsJson: Record<string, unknown>;
  providerID: string;
  modelId: string;
  reserveTokens?: number;
  keepTokens?: number;
  reset?: boolean;
}

/** Set or clear settings.json compaction.modelOverrides["<provider>/<model>"]; returns a new document. */
export function applyCompactionOverride(input: CompactionInput): Record<string, unknown> {
  const settings = cloneJson(input.settingsJson);
  const compaction = ensureRecord(settings, "compaction");
  const overrides = ensureRecord(compaction, "modelOverrides");
  const key = `${input.providerID}/${input.modelId}`;
  if (input.reset) {
    delete overrides[key];
    if (Object.keys(overrides).length === 0) delete compaction.modelOverrides;
    return settings;
  }
  const entry = ensureRecord(overrides, key);
  if (input.reserveTokens !== undefined) entry.reserveTokens = input.reserveTokens;
  if (input.keepTokens !== undefined) entry.keepRecentTokens = input.keepTokens;
  return settings;
}

interface EffectiveCompaction {
  reserveTokens: number;
  keepTokens: number;
  fromOverride: boolean;
}

/** Mirror pi's resolution: model override → ordinary setting → built-in default. */
export function effectiveCompaction(settingsJson: Record<string, unknown>, key: string): EffectiveCompaction {
  const compaction = isRecord(settingsJson.compaction) ? settingsJson.compaction : {};
  const overrides = isRecord(compaction.modelOverrides) ? compaction.modelOverrides : {};
  const override = isRecord(overrides[key]) ? overrides[key] : undefined;
  const ordinary = (field: string, fallback: number): number =>
    typeof compaction[field] === "number" ? (compaction[field] as number) : fallback;
  const reserve =
    typeof override?.reserveTokens === "number"
      ? override.reserveTokens
      : ordinary("reserveTokens", PI_DEFAULT_RESERVE_TOKENS);
  const keep =
    typeof override?.keepRecentTokens === "number"
      ? override.keepRecentTokens
      : ordinary("keepRecentTokens", PI_DEFAULT_KEEP_RECENT_TOKENS);
  return { reserveTokens: reserve, keepTokens: keep, fromOverride: override !== undefined };
}

function modelOverrideWindow(
  modelsJson: Record<string, unknown>,
  providerID: string,
  modelId: string,
): number | undefined {
  const providers = isRecord(modelsJson.providers) ? modelsJson.providers : {};
  const provider = isRecord(providers[providerID]) ? providers[providerID] : {};
  const overrides = isRecord(provider.modelOverrides) ? provider.modelOverrides : {};
  const entry = isRecord(overrides[modelId]) ? overrides[modelId] : undefined;
  return typeof entry?.contextWindow === "number" ? entry.contextWindow : undefined;
}

/** Effective window: user override → catalog default tier (is_default) → registered window. */
export function effectiveWindow(
  modelsJson: Record<string, unknown>,
  location: QoderModelLocation,
): { window: number; source: string } {
  const override = modelOverrideWindow(modelsJson, location.providerID, location.modelId);
  if (override !== undefined) return { window: override, source: "override" };
  const entry = getCachedModelConfig(location.modelId, location.mode);
  if (entry?.context_config) {
    const tiers = Object.values(entry.context_config);
    const isDefault = tiers.find((tier) => tier?.is_default === true)?.token_count;
    if (typeof isDefault === "number") return { window: isDefault, source: "catalog default tier" };
    return { window: contextWindowFromCatalog(entry), source: "catalog fallback" };
  }
  return { window: location.def.contextWindow, source: "registered" };
}

export function tierList(location: QoderModelLocation): number[] {
  const entry = getCachedModelConfig(location.modelId, location.mode);
  const tiers = entry?.context_config ? Object.values(entry.context_config) : [];
  return tiers
    .map((tier) => tier?.token_count)
    .filter((count): count is number => typeof count === "number" && Number.isFinite(count))
    .sort((a, b) => a - b);
}

// shape: none — a collect loop over the two regions; no discriminator, no held state.
/** Every Qoder model across both regions, cached list first with the static list as fallback. */
export function listQoderModelLocations(): QoderModelLocation[] {
  const locations: QoderModelLocation[] = [];
  for (const mode of QODER_MODES) {
    const cached = getCachedModels(mode);
    const list = cached.length > 0 ? cached : mode === "cn" ? staticCnModels : staticModels;
    const providerID = getQoderRegionConfig(mode).providerID;
    for (const def of list) locations.push({ mode, providerID, modelId: def.id, def });
  }
  return locations;
}

export function renderContextReport(
  modelsJson: Record<string, unknown>,
  settingsJson: Record<string, unknown>,
): string {
  const lines: string[] = [];
  for (const location of listQoderModelLocations()) {
    const { window, source } = effectiveWindow(modelsJson, location);
    const compaction = effectiveCompaction(settingsJson, `${location.providerID}/${location.modelId}`);
    const tiers = tierList(location);
    lines.push(
      `${location.providerID}/${location.modelId} · window ${window.toLocaleString("en-US")} (${source}${tiers.length > 0 ? `; tiers ${tiers.map((t) => t.toLocaleString("en-US")).join("/")}` : ""}) · reserve ${tokensToPercent(compaction.reserveTokens, window)} (${compaction.reserveTokens.toLocaleString("en-US")}) · keep ${tokensToPercent(compaction.keepTokens, window)} (${compaction.keepTokens.toLocaleString("en-US")})`,
    );
  }
  lines.push("", USAGE);
  return lines.join("\n");
}

/**
 * On-demand context/compaction configuration for Qoder models. Writes only the
 * two pi-native surfaces that actually drive behavior: models.json
 * `modelOverrides.<id>.contextWindow` (window shown, compaction basis, and the
 * wire `context_length`) and settings.json
 * `compaction.modelOverrides["<provider>/<id>"]` (raw token thresholds,
 * entered here as percentages of the effective window).
 */
export interface PiConfigStore {
  modelsPath: string;
  settingsPath: string;
  read(): { modelsJson: Record<string, unknown>; settingsJson: Record<string, unknown> };
  write(modelsJson: Record<string, unknown>, settingsJson: Record<string, unknown>): void;
}

// shape: closure returning an object literal — trigger #4, the two config paths
//   are held state with read/write methods; no subclassing or instanceof needed.
export function openConfigStore(): PiConfigStore {
  const modelsPath = join(getPiAgentDir(), "models.json");
  const settingsPath = join(getPiAgentDir(), "settings.json");
  return {
    modelsPath,
    settingsPath,
    read: () => ({ modelsJson: readJsonObject(modelsPath), settingsJson: readJsonObject(settingsPath) }),
    write: (modelsJson, settingsJson) => {
      writeJsonObject(modelsPath, modelsJson);
      writeJsonObject(settingsPath, settingsJson);
    },
  };
}

export async function handleContextCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseContextArgs(args);
  if (!parsed.ok) {
    ctx.ui.notify(`${parsed.error}\n${USAGE}`, "warning");
    return;
  }
  const change = parsed.value;
  const store = openConfigStore();

  let modelsJson: Record<string, unknown>;
  let settingsJson: Record<string, unknown>;
  try {
    ({ modelsJson, settingsJson } = store.read());
  } catch (error) {
    ctx.ui.notify(`Could not read pi config: ${error instanceof Error ? error.message : String(error)}`, "warning");
    return;
  }

  if (change.model === undefined) {
    if (ctx.mode === "tui") {
      try {
        const { showContextPanel } = await import("./context-view.js");
        await showContextPanel(ctx);
        return;
      } catch (error) {
        // The pi-tui virtual module is only guaranteed on TUI-capable hosts; a
        // panel that cannot load must not swallow the report.
        debugLog("qoder context panel unavailable; falling back to text output", error);
      }
    }
    ctx.ui.notify(renderContextReport(modelsJson, settingsJson), "info");
    return;
  }

  const location = findQoderModel(change.model);
  if (!location) {
    ctx.ui.notify(`Unknown Qoder model “${change.model}”. Run /qoder-context to list models.`, "warning");
    return;
  }

  if (change.reset) {
    modelsJson = applyWindowOverride({
      modelsJson,
      providerID: location.providerID,
      modelId: location.modelId,
      window: "default",
    });
    settingsJson = applyCompactionOverride({
      settingsJson,
      providerID: location.providerID,
      modelId: location.modelId,
      reset: true,
    });
    try {
      store.write(modelsJson, settingsJson);
    } catch (error) {
      ctx.ui.notify(`Could not write pi config: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return;
    }
    ctx.ui.notify(`Cleared window and compaction overrides for ${location.providerID}/${location.modelId}.`, "info");
    return;
  }

  if (change.window !== undefined) {
    const tiers = tierList(location);
    if (change.window !== "default" && tiers.length > 0 && !tiers.includes(change.window)) {
      ctx.ui.notify(
        `window=${change.window} is not a Qoder tier for ${location.modelId}. Available: ${tiers.join(", ")} (or default).`,
        "warning",
      );
      return;
    }
    modelsJson = applyWindowOverride({
      modelsJson,
      providerID: location.providerID,
      modelId: location.modelId,
      window: change.window,
    });
  }

  const { window: effectiveAfter } = effectiveWindow(modelsJson, location);
  if (change.reservePct !== undefined || change.keepPct !== undefined) {
    settingsJson = applyCompactionOverride({
      settingsJson,
      providerID: location.providerID,
      modelId: location.modelId,
      reserveTokens: change.reservePct !== undefined ? percentToTokens(change.reservePct, effectiveAfter) : undefined,
      keepTokens: change.keepPct !== undefined ? percentToTokens(change.keepPct, effectiveAfter) : undefined,
    });
  }

  try {
    store.write(modelsJson, settingsJson);
  } catch (error) {
    ctx.ui.notify(`Could not write pi config: ${error instanceof Error ? error.message : String(error)}`, "warning");
    return;
  }

  const compaction = effectiveCompaction(settingsJson, `${location.providerID}/${location.modelId}`);
  const summary = [
    `${location.providerID}/${location.modelId}`,
    `window ${effectiveAfter.toLocaleString("en-US")}`,
    `reserve ${tokensToPercent(compaction.reserveTokens, effectiveAfter)} (${compaction.reserveTokens.toLocaleString("en-US")})`,
    `keep ${tokensToPercent(compaction.keepTokens, effectiveAfter)} (${compaction.keepTokens.toLocaleString("en-US")})`,
    `— written to ${store.modelsPath} and ${store.settingsPath}; takes effect on the next turn`,
  ].join(" · ");
  ctx.ui.notify(summary, "info");
}
