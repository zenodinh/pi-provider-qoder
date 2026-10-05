// shape: none — dispatch object does not apply: one pure two-argument
//   resolver with no discriminator and no state. Beside session-key.ts, the
//   shared wire-value leaf both adapters read: plan.ts consumes this, v2.ts
//   provides the identical inline fallback when the gate is off.
import type { QoderModelEntry } from "../catalog.js";

/**
 * Effective `context_length` for one request. The model's window as pi resolved
 * it — `models.json` `provider.modelOverrides.<modelId>.contextWindow` included —
 * wins when it matches one of the catalog's available windows; otherwise the
 * catalog's `is_default` tier (Qoder's own default). No largest-tier fallback:
 * an unmatched window takes the `is_default` tier, and the field is omitted only
 * when no tier is marked default or the requested window is absent; an entry
 * with no usable tiers passes the requested window through unchanged (owner
 * direction 2026-09-29 — a hidden max can spend more than the user intended).
 * Mirrors qodercli's window validation (its `$6`/`Gf` helpers, decoded
 * 2026-09-29: an invalid selection falls back to the default window).
 */
export function resolveContextLength(
  contextConfig: QoderModelEntry["context_config"],
  requested: number | undefined,
): number | undefined {
  if (requested === undefined) return undefined;
  const tiers = Object.values(contextConfig ?? {});
  const windows = tiers
    .map((tier) => tier?.token_count)
    .filter((count): count is number => typeof count === "number" && Number.isFinite(count));
  if (windows.length === 0 || windows.includes(requested)) return requested;
  const fallback = tiers.find((tier) => tier?.is_default)?.token_count;
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : undefined;
}
