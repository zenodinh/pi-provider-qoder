// shape: none — one boundary seam: `unknown` gateway payloads unwrapped level
// by level (Qoder double-encodes its envelopes) into a typed queue state.
//
// A request for a busy Qoder model comes back as a queue-admission payload
// nested inside envelopes, e.g. the legacy stream's
//   Upstream status 403: {"code":"403","message":"{\"code\":\"10605\",
//   \"message\":\"{\\\"isQueued\\\":true,\\\"modelKey\\\":\\\"qfmodel\\\", ...
//   \\\"retryAfterSeconds\\\":30,\\\"serviceAvailable\\\":false}\"}"}
// The outer status is the gateway's carrier for that state, not an auth
// failure. Hosts classify error text by pattern (OMP: `503 | 429 | overloaded
// | service unavailable | retry your request | …` → transient, retried with the
// parsed wait; a bare `403` → auth failure, not retried), so forwarding the
// raw envelope mislabels a temporary queue as a broken credential and skips
// the wait the provider asked for. This module extracts the queue state and
// renders one message that reads correctly to a human and to those
// classifiers: transient, with a parseable "try again in Ns" wait hint.
//
// Two invariants keep the rewrite narrow, because a queue rewrite that also
// swallows real faults is worse than the raw envelope:
//   1. Only an explicit queue discriminator counts — `isQueued: true` or the
//      Qoder business code 10605. A bare "service unavailable + a wait" body
//      is NOT evidence of a queue: an expired job token looks exactly like
//      that and must stay a 401 that asks the user to log in again.
//   2. The carrier's own code (the 403/401 on the outer envelope) is never
//      carried into the queue state, so it can never reappear in the rendered
//      message. Only the queue level's own business code is reported.

/** Levels of `message`-in-`message` JSON nesting to follow (observed depth: 3). */
const MAX_ENVELOPE_DEPTH = 4;

/** Qoder's business code for "this model is queued, wait and re-issue". */
export const QODER_QUEUE_CODE = "10605";

export interface QoderQueueState {
  /** Upstream model key the queue applies to (e.g. `qfmodel` = Qwen3.8-Flash). */
  modelKey?: string;
  /** Provider queue class (e.g. `p3`). */
  queueType?: string;
  /** Requests ahead of this one in the queue. */
  queueCount?: number;
  /** Seconds the provider asks the client to wait before re-issuing. */
  waitSeconds?: number;
  /**
   * Business code from the level that actually described the queue. Never the
   * outer envelope's carrier status — see invariant 2 in the file header.
   */
  code?: string;
}

/** Raw field read at the JSON boundary: anything that is not a plain object
 * reads as absent, and the caller narrows the value it needs. Field-level
 * `typeof` checks keep the data contract visible at each use instead of
 * behind a container-wide guard. */
function readValue(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
  return Object.getOwnPropertyDescriptor(source, key)?.value;
}

function readNumber(source: unknown, key: string): number | undefined {
  const value = readValue(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  const value = readValue(source, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Boolean field, tolerating Qoder's stringified `"true"`/`"false"`. */
function readFlag(source: unknown, key: string): boolean | undefined {
  const value = readValue(source, key);
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function findQueueState(value: unknown, depth: number, inheritedQueueCode?: string): QoderQueueState | undefined {
  if (depth > MAX_ENVELOPE_DEPTH) return undefined;
  // The business code is followed DOWN the envelope chain; the carrier is not.
  // Qoder puts `10605` on the level above the one carrying the queue detail,
  // so the deepest level needs it — while the carrier status (403/401) sits on
  // the outermost level and is deliberately never propagated, which is what
  // stops it reappearing in the rendered message.
  const ownCode = readString(value, "code");
  const ownIsQueueCode = ownCode === QODER_QUEUE_CODE;
  const readState = (code?: string): QoderQueueState => ({
    modelKey: readString(value, "modelKey"),
    queueType: readString(value, "queueType"),
    queueCount: readNumber(value, "queueCount"),
    waitSeconds: readNumber(value, "retryAfterSeconds") ?? readNumber(value, "waitTime"),
    code,
  });
  // `isQueued` marks the level that actually describes the queue. The business
  // code alone sits one level ABOVE it (Qoder wraps the detail in its own
  // envelope), so a code-only level is a wrapper: descend for the detail and
  // carry the code down with it. Only if nothing below describes a queue does
  // the code itself stand in as the discriminator.
  if (readFlag(value, "isQueued") === true) return readState(ownIsQueueCode ? ownCode : inheritedQueueCode);
  const nested = readString(value, "message");
  if (nested) {
    try {
      const deeper = findQueueState(JSON.parse(nested), depth + 1, ownIsQueueCode ? ownCode : inheritedQueueCode);
      if (deeper) return deeper;
    } catch {
      // Not JSON: fall through to this level's own reading.
    }
  }
  if (ownIsQueueCode) return readState(ownCode);
  return undefined;
}

/**
 * Extract a Qoder queue state from an error body, if it carries one.
 * Returns undefined for any body that is not JSON, not a queue payload, or
 * not carrying the explicit queue discriminator — so callers keep their
 * original error text for everything else, including real 401 auth failures.
 */
export function parseQoderQueueState(body: string): QoderQueueState | undefined {
  try {
    return findQueueState(JSON.parse(body), 0);
  } catch {
    return undefined;
  }
}

/**
 * Render the queue state as one line that:
 *   - reads correctly to a person ("service unavailable" because that is
 *     literally what the payload's own `serviceAvailable:false` says),

 *   - classifies as transient on host pattern tables, and
 *   - carries the provider's wait as `try again in Ns`, a form hosts parse
 *     into a real delay before re-issuing the request.
 * The code is printed only when it is the queue's own business code, so a
 * carrier status can never ride along in the text a host classifies.
 */
export function describeQoderQueueError(state: QoderQueueState): string {
  const subject = state.modelKey ? `model ${state.modelKey}` : "the model";
  const details: string[] = [];
  if (state.queueType) details.push(`queue ${state.queueType}`);
  if (state.queueCount !== undefined) details.push(`${state.queueCount} ahead`);
  const detail = details.length > 0 ? ` (${details.join(", ")})` : "";
  const code = state.code === QODER_QUEUE_CODE ? ` (code ${state.code})` : "";
  const wait = state.waitSeconds !== undefined ? `try again in ${state.waitSeconds}s.` : "try again in a moment.";
  return `Qoder service unavailable${code}: ${subject} is queued${detail}; ${wait}`;
}

/**
 * A queue refusal, carrying its parsed state as a typed side channel.
 *
 * The rendered message is what a human and a host classifier read; the state
 * is what the provider's own retry path needs (the wait in seconds, the
 * model key for its log line). Re-parsing the rendered text to recover the
 * numbers would discard exactly the structure this module exists to extract,
 * and it would accept any hand-written string that merely looks like one —
 * so the state travels on the error instead.
 */
export class QoderQueueError extends Error {
  readonly state: QoderQueueState;

  constructor(state: QoderQueueState) {
    super(describeQoderQueueError(state));
    this.name = "QoderQueueError";
    this.state = state;
  }
}
