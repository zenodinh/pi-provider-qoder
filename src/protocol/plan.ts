// shape: module — an async producer (planQoderTurn) beside the pure synchronous
//   projection the sync-time consumers read (planSyncProjection), plus the two
//   shared derivations three sites used to duplicate (qoderModeFor,
//   resolveUpstreamKey). No dispatch object: the protocol is a 2-way read that
//   selects which wire session form the producer resolves, below the ≥3
//   threshold.
import crypto from "node:crypto";
import type {
  Api,
  Model,
  SimpleStreamOptions,
  ThinkingBudgets,
  ThinkingLevel,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { resolveQoderIdentity } from "../auth/oauth.js";
import { getCachedModelConfig, type QoderModelEntry } from "../catalog.js";
import type { QoderMode } from "../region.js";
import type { Protocol } from "./routing.js";
import { classifyTurnKind, type QoderTurnKind } from "./run-identity.js";
import { clampPromptCacheKey, MAX_PROMPT_CACHE_KEY_LENGTH, stableHash } from "./session-key.js";
import {
  affinityPlacements,
  carrierValue,
  QODER_WIRE_COMPAT,
  type QoderWireCompatData,
  type WireCarrier,
} from "./wire-compat.js";

/**
 * One process-stable session id for hosts that never pass `options.sessionId`
 * (OD-6, owner-decided 2026-10-02). Both protocols use it, so a session-less
 * legacy turn and a session-less v2 turn report the same id; the run registry
 * key is `mode:upstreamKey:wireSessionId`, so this merges session-less turns
 * into one billing run per mode and model instead of minting one per request.
 */
export const PROCESS_FALLBACK_SESSION_ID = crypto.randomUUID();

/**
 * The router's per-request route facts. Derived once from the model and the
 * catalog, then read by the plan and both adapters — the route is the seed's
 * other half, so no adapter re-derives the mode or the upstream key.
 */
export interface PlanRoute {
  protocol: Protocol;
  mode: QoderMode;
  upstreamKey: string;
  rejectedSamplingKeys: readonly string[];
}

/**
 * What the sync-time consumers can read before any await: the v2 session forms
 * are pure functions of the options, so v2's debug-fetch meta and the warming
 * handler need no turn plan.
 */
export interface TurnPlanSync {
  mode: QoderMode;
  upstreamKey: string;
  piSessionId: string | undefined;
  wireSessionV2: { promptCacheKey: string; envelopeAndHeaders: string };
  turnKind: QoderTurnKind;
  capture: { protocol: Protocol; model: string; session: string | undefined };
}

/** The seed the router hands the adapters when QODER_CORE_PLAN is on: route facts plus their sync projection. */
export type TurnPlanSeed = PlanRoute & TurnPlanSync;

/** Every per-turn fact, produced once by planQoderTurn and read by both adapters. */
export interface TurnPlan {
  piSessionId: string | undefined;
  mode: QoderMode;
  upstreamKey: string;
  wireSession: { legacy: string; v2: { promptCacheKey: string; envelopeAndHeaders: string } };
  affinity: { promptCacheKey: string; placements: Record<WireCarrier, string[]> };
  rejectedSamplingKeys: readonly string[];
  thinkingInputs: { level: ThinkingLevel | undefined; budgets: ThinkingBudgets | undefined };
  turnKind: QoderTurnKind;
  capture: { protocol: Protocol; model: string; session: string | undefined; wireSessionId: string };
}

/**
 * The plan's injected surface. `resolveIdentity` defaults to the real oauth
 * resolver so production call sites are unchanged; `table` lets a test drive
 * the producer with a cloned policy row.
 */
export interface PlanDeps {
  resolveIdentity?: typeof resolveQoderIdentity;
  table?: QoderWireCompatData;
}

/** The provider id → region mapping three sites derived inline. */
export function qoderModeFor(providerId: string): QoderMode {
  return providerId === "qoder-cn" ? "cn" : "global";
}

/**
 * The catalog entry for a model id, or undefined when the catalog does not
 * declare it — never an invented key. The caller fails fast on undefined,
 * exactly as the pre-migration router did.
 */
export function resolveUpstreamKey(
  modelId: string,
  mode: QoderMode,
): { key: string; entry: QoderModelEntry } | undefined {
  const entry = getCachedModelConfig(modelId, mode);
  if (!entry?.key) return undefined;
  return { key: entry.key, entry };
}

/**
 * The v2 wire forms. The clamp is the data row `sessionKeyBoundPolicy: v2:clamp`
 * and the envelope stays unclamped — a split the vendor sees, not an accident
 * to unify.
 */
function v2WireSession(sessionId: string | undefined): { promptCacheKey: string; envelopeAndHeaders: string } {
  const envelope = sessionId ?? PROCESS_FALLBACK_SESSION_ID;
  return { promptCacheKey: clampPromptCacheKey(envelope), envelopeAndHeaders: envelope };
}

/**
 * The legacy wire form. qoder-session-{userID}-{key}-{sessionId} when it fits
 * the 64-char prompt_cache_key bound; otherwise the bounded form the wire-compat
 * table selects for this carrier (hash by default, clamp when a probe verdict
 * moves the row). Session-less turns use the per-process id.
 */
function legacyWireSession(
  userID: string,
  upstreamKey: string,
  sessionId: string | undefined,
  table: QoderWireCompatData,
): string {
  if (!sessionId) return PROCESS_FALLBACK_SESSION_ID;
  const readable = `qoder-session-${userID}-${upstreamKey}-${sessionId}`;
  if (carrierValue(table.sessionKeyBoundPolicy, "legacy") === "clamp") return clampPromptCacheKey(readable);
  return readable.length <= MAX_PROMPT_CACHE_KEY_LENGTH
    ? readable
    : `qoder-session-${stableHash("qoder-session", userID, upstreamKey, sessionId)}`;
}

/** The sync-time subset: no I/O, no await, the same derivations the async producer applies. */
export function planSyncProjection(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  route: PlanRoute,
): TurnPlanSync {
  return {
    mode: route.mode,
    upstreamKey: route.upstreamKey,
    piSessionId: options?.sessionId,
    wireSessionV2: v2WireSession(options?.sessionId),
    turnKind: classifyTurnKind(options?.maxTokens),
    capture: { protocol: route.protocol, model: model.id, session: options?.sessionId },
  };
}

/**
 * Produce every per-turn fact once. The identity resolver is awaited only when
 * the legacy wire form is needed, so a v2-routed plan performs no identity
 * lookup; a rejection propagates to the adapter's existing terminal-error catch
 * rather than being swallowed.
 */
export async function planQoderTurn(
  model: Model<Api>,
  _context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  route: PlanRoute,
  deps: PlanDeps = {},
): Promise<TurnPlan> {
  const table = deps.table ?? QODER_WIRE_COMPAT;
  const resolveIdentity = deps.resolveIdentity ?? resolveQoderIdentity;
  const wireSessionV2 = v2WireSession(options?.sessionId);

  let wireSessionLegacy = options?.sessionId ?? PROCESS_FALLBACK_SESSION_ID;
  if (route.protocol === "legacy") {
    const accessToken = options?.apiKey;
    // The adapters check credentials and throw the user-facing message before
    // they call the plan; this is the producer's own precondition.
    if (!accessToken) throw new Error("planQoderTurn needs options.apiKey to resolve the legacy wire session");
    const identity = await resolveIdentity(accessToken, model.provider, route.mode, {
      signal: options?.signal,
      fetch: options?.fetch,
      timeoutMs: options?.timeoutMs,
    });
    wireSessionLegacy = legacyWireSession(
      identity.userID || "qoder-user",
      route.upstreamKey,
      options?.sessionId,
      table,
    );
  }

  const wireSessionId = route.protocol === "legacy" ? wireSessionLegacy : wireSessionV2.envelopeAndHeaders;
  return {
    piSessionId: options?.sessionId,
    mode: route.mode,
    upstreamKey: route.upstreamKey,
    wireSession: { legacy: wireSessionLegacy, v2: wireSessionV2 },
    affinity: {
      // The value Qoder forwards upstream as prompt_cache_key: legacy forwards
      // session_id, v2 sends the explicit field; the placements say where it goes.
      promptCacheKey: route.protocol === "legacy" ? wireSessionLegacy : wireSessionV2.promptCacheKey,
      placements: {
        legacy: affinityPlacements("legacy", table),
        v2: affinityPlacements("v2", table),
      },
    },
    rejectedSamplingKeys: route.rejectedSamplingKeys,
    thinkingInputs: { level: options?.reasoning, budgets: options?.thinkingBudgets },
    turnKind: classifyTurnKind(options?.maxTokens),
    capture: {
      protocol: route.protocol,
      model: model.id,
      session: options?.sessionId,
      wireSessionId,
    },
  };
}
