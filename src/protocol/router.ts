// shape: none — dispatch object does not apply: the protocol choice is 2-way,
//   below the ≥3 dispatch threshold, and the precedence is a guard cascade.
//   Map for the session fallback cache (trigger #6, ad-hoc key→value store).
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { debugLog } from "../debug.js";
import { setDebugSession } from "../debug-log.js";
import type { QoderMode } from "../region.js";
import { type PlanRoute, planSyncProjection, qoderModeFor, resolveUpstreamKey, type TurnPlanSeed } from "./plan.js";
import { getRoutingData, isMarkedLegacyOnly, PROTOCOL, type Protocol } from "./routing.js";
import { filterSamplingParams } from "./sampling.js";
import { streamQoder } from "./stream.js";
import { streamQoderV2 } from "./v2.js";

export interface RouteDecision {
  protocol: Protocol;
  source: "env" | "fallback-cache" | "routing-data" | "default";
}

function envValue(options: SimpleStreamOptions | undefined, name: string): string | undefined {
  return options?.env?.[name] ?? process.env[name];
}

/** One env knob, one meaning, read once per request: on builds the sync seed, off is the pre-migration path. */
function corePlanEnabled(options: SimpleStreamOptions | undefined): boolean {
  return envValue(options, "QODER_CORE_PLAN") === "1";
}

/**
 * Protocol per request, from data rather than a compiled constant. Precedence:
 * QODER_PROTOCOL override → cn guard → self-heal session cache → routing table.
 *
 * Legacy is the default for every key (owner decision 2026-10-09). v2 is the
 * BYOK-oriented transport: Qoder exposes it to bring-your-own-key usage, some
 * accounts cannot reach an upstream through it at all (live: "Access to
 * Anthropic models is not allowed for this account"), and its model server has
 * refused instruction roles and cap values the legacy gateway accepts. Stability
 * wins for a default install, so v2 needs an explicit `QODER_PROTOCOL=v2` AND a
 * key the routing table lists as v2-eligible: the flag is a request, not a
 * capability grant, and an unproven key would fail its turn on the v2 host.
 */
export function resolveProtocol(upstreamKey: string, mode: QoderMode, options?: SimpleStreamOptions): RouteDecision {
  const forced = envValue(options, "QODER_PROTOCOL");
  if (forced === PROTOCOL.LEGACY) return { protocol: PROTOCOL.LEGACY, source: "env" };
  // Before the opt-in: a key v2 already proved legacy-only this session stays
  // legacy even while the flag is set, or the correction would be re-armed into
  // the same failure every turn.
  if (isMarkedLegacyOnly(upstreamKey)) return { protocol: PROTOCOL.LEGACY, source: "fallback-cache" };
  if (forced === PROTOCOL.V2) {
    const eligible = getRoutingData((message) => debugLog(message)).v2Eligible.includes(upstreamKey);
    if (eligible) return { protocol: PROTOCOL.V2, source: "env" };
    debugLog(`provider.routing model_key=${upstreamKey} requested=v2 fell_back=legacy reason=not-v2-eligible`);
    return { protocol: PROTOCOL.LEGACY, source: "default" };
  }
  if (mode === "cn" && !envValue(options, "QODER_MODEL_SERVER_HOST"))
    return { protocol: PROTOCOL.LEGACY, source: "env" };
  // Legacy for every key that did not ask for v2. New Qoder models launch
  // legacy-only, and the legacy gateway serves every key today — so the default
  // can never produce a failed turn on a launch-day model.
  const routing = getRoutingData((message) => debugLog(message));
  return { protocol: PROTOCOL.LEGACY, source: routing.legacyOnly.includes(upstreamKey) ? "routing-data" : "default" };
}

/**
 * Registered entry for the qoder-api provider: shared upstream (mode, catalog
 * config, filter), then one of two peer transports. Legacy keeps the fork's
 * streamQoder untouched; v2 delegates to pi-ai behind the field injector.
 */
export function streamQoderRouter(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const mode = qoderModeFor(model.provider);
  // Attribute extension-level debug records (catalog refresh, routing notes)
  // to the session that triggered them; no-op when QODER_DEBUG is unset.
  setDebugSession(options?.sessionId);
  const resolved = resolveUpstreamKey(model.id, mode);
  if (!resolved) {
    // Mirror the legacy path's fail-fast: unknown model ids error before any
    // network call, on either transport. No plan work happens below this line.
    return streamQoder(model, context, options);
  }
  const { key: upstreamKey, entry: modelConfig } = resolved;
  const decision = resolveProtocol(upstreamKey, mode, options);
  debugLog(`provider.request model_key=${upstreamKey} protocol=${decision.protocol} source=${decision.source}`);

  // One routing-table read per dispatch: the route carries the rejected-sampling
  // list, so the filter no longer needs the second lookup router.ts:63 held.
  // contextConfig hands the plan the tiers the same catalog read already held.
  const route: PlanRoute = {
    protocol: decision.protocol,
    mode,
    upstreamKey,
    rejectedSamplingKeys: getRoutingData().rejectedSamplingKeys,
    contextConfig: modelConfig.context_config,
  };
  const seed: TurnPlanSeed | undefined = corePlanEnabled(options)
    ? { ...route, ...planSyncProjection(model, options, route) }
    : undefined;
  filterSamplingParams(model, options, seed?.rejectedSamplingKeys ?? route.rejectedSamplingKeys);

  if (decision.protocol === PROTOCOL.V2) {
    return streamQoderV2(model, context, options, { ...route, modelConfig, plan: seed });
  }
  return streamQoder(model, context, options, seed);
}
