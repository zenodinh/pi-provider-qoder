// shape: module-scope memo plus a pure entry point — the run registry and the
//   real-turn clock are one instance per process (routing.ts:1-4 states the same
//   shape for its memo), and the adapters differ in their input view, not in a
//   step sequence, so there is no dispatch object to build.
import crypto from "node:crypto";
import { QODER_GATEWAY_COSY_VERSION } from "../cosy.js";

/**
 * Run-scoped request identity, mirroring the official qodercli (>=1.1.x)
 * lifecycle instead of minting a fresh identity per HTTP request.
 *
 * qodercli creates one AgentLifecycle per user prompt ("run") and threads that
 * run's `requestSetId` + `business` (stable `id`/`name`/`begin_at`, with a
 * `stage` that advances init -> start -> processing) through *every* model
 * request of the run — including tool rounds, retries and subagent calls. The
 * server therefore groups the whole agentic execution under one request set,
 * and the Qoder credit ledger shows it as a single aggregated entry.
 *
 * pi drives one HTTP request per model round, and this plugin previously
 * previously re-derived `request_set_id` from a hash of the whole (growing)
 * message list, while minting a brand-new `business.id` with `stage:"start"`
 * on every request. Each round therefore looked like a separate, never-finished
 * run — which is why the ledger filled with many short, small credit rows.
 *
 * A run boundary is inferred from the message tail: when the conversation ends
 * with tool results that pair with the previous assistant message's tool_calls,
 * the request continues the current run; otherwise (a fresh user message, a
 * retry from a clean state, a new session) a new run starts.
 *
 * One module serves both protocols. Each adapter passes its own raw message
 * view — the legacy transport reads the transcript pi handed it, v2 reads the
 * same transcript — because the transformed list is not a safe input: the
 * transform defers an image-bearing tool result into a trailing synthetic user
 * message (transform.ts flushDeferredImages), which would make the predicate
 * read a tool round as a fresh prompt and split one user turn into several
 * billing runs. The predicate tolerates both vocabularies, so neither adapter
 * needs to normalize before asking.
 *
 * Warm turns (host cache-warmer replays, `maxTokens: 1`) are not user turns:
 * they reuse an existing slot WITHOUT advancing its stage, and when no slot
 * exists they get an ephemeral identity that is never registered — registering
 * it would let the next real tool round continue the warm identity and the
 * vendor would bill it under a run the user never started.
 *
 * Retry attempts rotate the run identity, and that is accepted rather than
 * engineered around (OD-7): the vendor ledger shows one line per attempt, which
 * is the tuple the ledger must reconcile against. Rotation is cache-neutral
 * because every attempt reuses the same options object, so the session-derived
 * cache key is identical and the prefix is append-stable under the repo's
 * history repair, which drops error/aborted assistant turns before dispatch.
 */

export type QoderRunMessage = {
  role: "user" | "assistant" | "tool" | "system" | "toolResult";
  content?: unknown;
  /** Tool-result id in the normalized (post-transform) vocabulary. */
  tool_call_id?: string;
  /** Tool-result id in the raw pi vocabulary (ToolResultMessage.toolCallId). */
  toolCallId?: string;
  /** Assistant tool calls in the normalized (post-transform) vocabulary. */
  tool_calls?: Array<{ id?: string }>;
};

export interface QoderRunBusiness {
  product: string;
  version: string;
  type: string;
  id: string;
  name: string;
  begin_at: number;
  stage: "init" | "start" | "processing";
}

/** A real user turn, or a host cache-warmer replay (`maxTokens: 1`). */
export type QoderTurnKind = "real" | "warm";

export interface QoderRunRequest {
  mode: string;
  upstreamKey: string;
  wireSessionId: string;
  /** The adapter's own message view: raw pi for both protocols today. */
  messages: readonly QoderRunMessage[];
  /** Text of the current user prompt (used for the business display name). */
  lastUserText: string;
  product: string;
  turnKind: QoderTurnKind;
}

export interface QoderRunIdentity {
  /** Stable for every model request that belongs to the same agentic run. */
  requestSetId: string;
  /** Run-scoped business object, stable id/name/begin_at with advancing stage. */
  business: QoderRunBusiness;
}

interface QoderRunState {
  key: string;
  requestSetId: string;
  business: QoderRunBusiness;
}

/** Maximum number of in-flight runs remembered per process (evict least recent). */
const MAX_RUN_STATES = 64;

/** Both protocols' registries. Insertion order is the recency order (see rememberRun). */
const runStates = new Map<string, QoderRunState>();

/** Empty the run registry. Exposed for tests only. */
export function clearQoderRunRegistry(): void {
  runStates.clear();
}

// shape: inherited — module-scope state beside the run registry (DSG-3),
//   trigger #3 one instance per process; the reader and the test-only clearer
//   follow the clearQoderRunRegistry precedent directly above.
/**
 * Epoch milliseconds of the most recent real dispatch, or undefined until one
 * happens. It lives here rather than at the two adapter call sites because both
 * already resolve identity exactly once per dispatch with `turnKind` in hand, so
 * the module that owns the real/warm distinction also owns the clock and
 * neither adapter is edited (OD-D).
 */
let realTurnClock: number | undefined;

/** The last real dispatch's epoch milliseconds; undefined in a process that had none. */
export function lastRealRequestAt(): number | undefined {
  return realTurnClock;
}

/** Reset the real-turn clock. Exposed for tests only. */
export function clearQoderRealTurnClock(): void {
  realTurnClock = undefined;
}

/**
 * `warm` if and only if the host cache warmer's replay literal `maxTokens: 1`
 * is present. Strict equality: a string "1" from an env-driven option is not
 * the host's literal and must not be misclassified.
 */
export function classifyTurnKind(maxTokens: number | undefined): QoderTurnKind {
  return maxTokens === 1 ? "warm" : "real";
}

function isToolResultRole(role: QoderRunMessage["role"]): boolean {
  return role === "tool" || role === "toolResult";
}

function toolCallIdOf(message: QoderRunMessage): string | undefined {
  const id = message.tool_call_id ?? message.toolCallId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** The tool-call ids an assistant message declared, in either vocabulary. */
function declaredToolCallIds(message: QoderRunMessage): string[] {
  const ids = (message.tool_calls ?? [])
    .map((tc) => tc?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  // Raw pi assistant messages carry tool calls as `toolCall` content blocks
  // (transform.ts:127) rather than the normalized `tool_calls` array.
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const candidate = block as { type?: unknown; id?: unknown };
      if (candidate.type === "toolCall" && typeof candidate.id === "string" && candidate.id.length > 0) {
        ids.push(candidate.id);
      }
    }
  }
  return ids;
}

/**
 * True when `messages` ends in an unfinished tool round: trailing tool results
 * whose ids were declared by the nearest preceding assistant tool-call message.
 * Tolerates both message vocabularies, so each adapter can pass its own view.
 * A user message reached before such an assistant ends the walk as false.
 */
export function isRunContinuation(messages: readonly QoderRunMessage[]): boolean {
  let i = messages.length - 1;
  const openToolCallIds = new Set<string>();
  while (i >= 0) {
    const message = messages[i];
    if (!isToolResultRole(message.role)) break;
    const id = toolCallIdOf(message);
    if (id) openToolCallIds.add(id);
    i--;
  }
  if (openToolCallIds.size === 0) return false;

  while (i >= 0) {
    const message = messages[i];
    if (message.role === "assistant") {
      return declaredToolCallIds(message).some((id) => openToolCallIds.has(id));
    }
    if (message.role === "user") return false;
    i--;
  }
  return false;
}

/** qodercli truncates the run display name to 10 chars for agent runs. */
function runDisplayName(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 10 ? trimmed.slice(0, 10) : trimmed;
}

function createBusiness(product: string, name: string): QoderRunBusiness {
  return {
    product,
    // business.version carries the client version (qodercli pins its own);
    // mirror the COSY client identity this plugin emulates.
    version: QODER_GATEWAY_COSY_VERSION,
    type: "agent",
    id: crypto.randomUUID(),
    name: runDisplayName(name),
    begin_at: Date.now(),
    stage: "init",
  };
}

function advanceStage(business: QoderRunBusiness): void {
  // init -> start (first request) -> processing (all later requests).
  if (business.stage === "init") business.stage = "start";
  else if (business.stage === "start") business.stage = "processing";
}

/**
 * Store (or refresh) a slot as the most recently used one, then evict the least
 * recently used entry once the cap is exceeded. Re-inserting on every touch is
 * what makes `runStates` an LRU instead of an insertion-order FIFO: a run that
 * is still being continued must not be evicted mid-flight while an abandoned
 * slot lingers.
 */
function rememberRun(key: string, state: QoderRunState): void {
  runStates.delete(key);
  runStates.set(key, state);
  if (runStates.size > MAX_RUN_STATES) {
    const leastRecentKey = runStates.keys().next().value;
    if (leastRecentKey !== undefined) runStates.delete(leastRecentKey);
  }
}

/**
 * Return the run identity for this request, reusing the run-scoped slot when the
 * message tail continues it and rotating (minting + registering a new one)
 * otherwise.
 */
export function resolveRunIdentity(input: QoderRunRequest): QoderRunIdentity {
  // Stamped before any branch so a rotating identity stamps too, and only for a
  // real turn: a warm replay that advanced the clock would empty the guard's
  // since-last-real-dispatch span and make its miss ceiling unreachable.
  if (input.turnKind === "real") realTurnClock = Date.now();
  const key = `${input.mode}:${input.upstreamKey}:${input.wireSessionId}`;
  const existing = runStates.get(key);

  if (input.turnKind === "warm") {
    // A cache-warming replay is not a user turn: reuse the slot without
    // advancing it, or mint an EPHEMERAL identity that is never registered.
    if (existing) {
      rememberRun(key, existing);
      return { requestSetId: existing.requestSetId, business: { ...existing.business } };
    }
    const business = createBusiness(input.product, input.lastUserText);
    advanceStage(business);
    return { requestSetId: crypto.randomUUID(), business };
  }

  let state = isRunContinuation(input.messages) ? existing : undefined;
  if (!state) {
    state = {
      key,
      requestSetId: crypto.randomUUID(),
      business: createBusiness(input.product, input.lastUserText),
    };
  }
  rememberRun(key, state);
  advanceStage(state.business);

  return { requestSetId: state.requestSetId, business: { ...state.business } };
}
