/**
 * Qoder's "this request is queued" notice, and the wait it describes.
 *
 * A busy model does not answer with an ordinary error: the gateway replies with
 * an envelope whose `statusCodeValue` is 403 and whose body carries the code
 * `10605`, nested through two or three JSON-string layers. Inside sits a queue
 * record — `isQueued`, `serviceAvailable`, `modelKey`, `queueType`,
 * `queueCount`, `retryAfterSeconds` and `waitTime` (SECONDS) — which says either
 * "resend the same conversation in a moment" (`isQueued:false` +
 * `serviceAvailable:true`) or "poll the queue-status endpoint for your turn"
 * (`isQueued:true`).
 *
 * Evidence for the wire names and their nesting:
 * Loongphy 2c5c19a / d201b4a / 3e92bb7, summer-tt 48ab32e, jischeng 20f4b20 —
 * three independent forks of this provider observing the same envelope — plus
 * `@qoder-ai/qodercli` 1.1.70, which auto-waits and retries on rate/concurrency
 * limits and clamps its queue poll interval to [500 ms, 30 s].
 *
 * Everything here is a pure transform of bytes to a record: no fetch, no clock,
 * no environment. The transport (stream.ts) owns the I/O, the abort signal and
 * the wait bound; this module owns the wire vocabulary so no literal above is
 * re-spelled at the call site.
 */

/** Gateway status code for a queued request. String form: the record may carry either. */
const QUEUE_NOTICE_CODE = "10605";
/** Absolute-millisecond retry hint some gateways emit beside the seconds one. */
const RETRY_AFTER_MS = "retry_after_ms";
/** JSON-string layers a notice is nested through; three is the deepest observed. */
const MAX_JSON_STRING_LAYERS = 3;
/** Cap on records collected from one body, so a pathological body cannot balloon the walk. */
const MAX_COLLECTED_RECORDS = 64;
/** qodercli's own clamp on the queue poll interval, in milliseconds. */
export const QUEUE_MIN_POLL_MS = 500;
export const QUEUE_MAX_POLL_MS = 30_000;
/** Interval when the record carries no hint at all. */
export const QUEUE_DEFAULT_WAIT_MS = 1000;

/**
 * A queue record normalised out of the wire shapes that carry one.
 * Booleans survive only when they really are booleans; numbers accept their
 * digit-string form; absent stays `undefined` so a caller can tell "unset" from
 * a real `false` (an absent `isQueued` never authorises a resend).
 */
export interface QueueInfo {
  readonly isQueued?: boolean;
  readonly serviceAvailable?: boolean;
  readonly modelKey?: string;
  readonly queueCount?: number;
  readonly queueType?: number | string;
  /** `retry_after_ms` as-is. */
  readonly retryAfterMs?: number;
  /** `retryAfterSeconds`, converted to nothing — kept in seconds as the wire states it. */
  readonly retryAfterSeconds?: number;
  /** `waitTime`, which the gateway states in SECONDS. */
  readonly waitTimeSeconds?: number;
  readonly requestSetId?: string;
}

/** What to do next with a queued turn, and how long to wait first. */
export interface QueueWaitDecision {
  readonly action: "resend" | "poll";
  readonly waitMs: number;
}

/** The query the queue-status endpoint reads. */
export interface QueueStatusQuery {
  readonly requestSetId?: string;
  readonly modelKey?: string;
  readonly queueType?: number | string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON body this module cannot read is not an error: it is simply not a queue notice. */
function tryParse(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** NUM-1: blank is checked before coercion, so `""` never becomes a real zero. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Every object reachable from `body` through at most MAX_JSON_STRING_LAYERS
 * `JSON.parse` calls — the envelope's own string, then any string member (a
 * notice nests through `body`, a status reply through `data`/`result`/`message`)
 * — plus objects nested directly, which cost no parse.
 */
function collectRecords(body: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  /** Pending work: text still to parse at `layer`, or an already-parsed object to walk. */
  const pending: Array<{ text: string; layer: number } | { record: Record<string, unknown>; layer: number }> = [
    { text: body, layer: 1 },
  ];
  for (let i = 0; i < pending.length; i++) {
    const node = pending[i];
    let record: Record<string, unknown> | undefined = "record" in node ? node.record : undefined;
    if (!record) {
      if (node.layer > MAX_JSON_STRING_LAYERS) continue;
      const parsed = tryParse("text" in node ? node.text : "");
      if (typeof parsed === "string") {
        pending.push({ text: parsed, layer: node.layer + 1 });
        continue;
      }
      if (!isRecord(parsed)) continue;
      record = parsed;
    }
    records.push(record);
    if (records.length >= MAX_COLLECTED_RECORDS) return records;
    for (const value of Object.values(record)) {
      if (typeof value === "string") pending.push({ text: value, layer: node.layer + 1 });
      else if (isRecord(value)) pending.push({ record: value, layer: node.layer });
    }
  }
  return records;
}

/** shape: none — a field-mapping transform, no discriminator and no state. */
function normaliseQueueInfo(records: ReadonlyArray<Record<string, unknown>>): QueueInfo | null {
  const record = records.find((candidate) => "isQueued" in candidate || "serviceAvailable" in candidate);
  if (!record) return null;
  return {
    isQueued: asBoolean(record.isQueued),
    serviceAvailable: asBoolean(record.serviceAvailable),
    modelKey: asText(record.modelKey),
    queueCount: asNumber(record.queueCount),
    queueType: asNumber(record.queueType) ?? asText(record.queueType),
    retryAfterMs: asNumber(record[RETRY_AFTER_MS]),
    retryAfterSeconds: asNumber(record.retryAfterSeconds),
    waitTimeSeconds: asNumber(record.waitTime),
    requestSetId: asText(record.requestSetId),
  };
}

/**
 * Read the queue record out of a non-200 SSE envelope body.
 *
 * shape: none — a total function from text to `QueueInfo | null`; the dispatch
 *   object and closure idioms both need a discriminator or state that this does
 *   not have.
 */
export function parseQueueNotice(body: string): QueueInfo | null {
  const records = collectRecords(body);
  const carriesQueueCode = records.some((record) => asText(record.code) === QUEUE_NOTICE_CODE);
  if (!carriesQueueCode) return null;
  return normaliseQueueInfo(records);
}

/**
 * Read the queue record out of the queue-status endpoint's reply, whose body may
 * be a plain object or a JSON string under `data`, `result`, `message` or `body`.
 *
 * shape: none — same total transform as parseQueueNotice, minus the code gate:
 *   the status endpoint answers with a normal 200 body around the same record.
 */
export function parseQueueStatus(body: string): QueueInfo | null {
  return normaliseQueueInfo(collectRecords(body));
}

/**
 * The one hint chain: explicit milliseconds win over the seconds forms, and the
 * record's own `waitTime` estimate is the last hint before the default.
 */
function hintedWaitMs(info: QueueInfo): number | undefined {
  if (info.retryAfterMs !== undefined) return info.retryAfterMs;
  if (info.retryAfterSeconds !== undefined) return info.retryAfterSeconds * 1000;
  if (info.waitTimeSeconds !== undefined) return info.waitTimeSeconds * 1000;
  return undefined;
}

/**
 * Decide whether to re-POST the conversation or to poll for the turn, and how
 * long to wait first.
 *
 * Resend is authorised only by the record's own words — `isQueued:false` with
 * `serviceAvailable:true`. A missing or `true` `isQueued`, or a missing
 * `serviceAvailable`, keeps polling: an absent field must never be read as
 * permission to send a second billable request. The poll interval is clamped to
 * qodercli's [500 ms, 30 s]; the resend delay is the server's hint as stated
 * (a hint of zero means "now"), because clamping it would silently ignore the
 * wait the gateway asked for.
 *
 * shape: none — two guards over one record, no discriminator to dispatch on.
 */
export function queueWaitDecision(info: QueueInfo): QueueWaitDecision {
  const hint = hintedWaitMs(info);
  if (info.isQueued === false && info.serviceAvailable === true) {
    return { action: "resend", waitMs: Math.max(0, hint ?? QUEUE_DEFAULT_WAIT_MS) };
  }
  const waitMs = Math.min(Math.max(hint ?? QUEUE_DEFAULT_WAIT_MS, QUEUE_MIN_POLL_MS), QUEUE_MAX_POLL_MS);
  return { action: "poll", waitMs };
}

/**
 * The queue-status URL for a given gateway base (the chat URL is on the same
 * origin, so a `baseUrl` override carries over unchanged).
 *
 * shape: none — a straight-line URL assembly; region.ts's builder table does not
 *   apply because there is one endpoint and no per-region value.
 */
export function queueStatusUrl(baseUrl: string, query: QueueStatusQuery): string {
  const url = new URL("/algo/api/v2/service/ask/queue/status", baseUrl);
  if (query.requestSetId) url.searchParams.set("requestSetId", query.requestSetId);
  if (query.modelKey) url.searchParams.set("modelKey", query.modelKey);
  if (query.queueType !== undefined) url.searchParams.set("queueType", String(query.queueType));
  return url.toString();
}
