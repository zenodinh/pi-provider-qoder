// shape: module scope — trigger #3, one debug sink per process; the only state
//   is the active-session string and the serialized write chain (below the Map
//   threshold; per-session separation lives in file names, not memory).
/**
 * File-based debug capture for QODER_DEBUG=1 (owner directive 2026-10-02).
 *
 * Merges the standalone `~/.pi/agent/extensions/raw-request-probe.ts` capture
 * into the provider and adds the response side it never had: with debug on,
 * every chat request and its raw server response are appended as JSONL to
 * `<QODER_DEBUG_DIR | ~/.pi/agent/logs/qoder-debug>/<sessionId>.jsonl` for
 * offline analytics (cache-miss root-cause work, protocol-parity checks).
 *
 * CAPTURE SITES — response capture is CONSUMER-SIDE and never forks a body.
 * `createDebugFetch` keeps only the request half and returns the inner fetch's
 * own Response object, so the transport sees an unlocked, unconsumed body, the
 * Response keeps its identity, and teardown cancels exactly once. The response
 * half rides reads the transports already perform, through
 * `createResponseCapture`:
 *   1. the legacy read loop in `protocol/stream.ts`, which decodes every chunk
 *      it is about to parse anyway;
 *   2. the v2 reframe transform in `protocol/sse-reframe.ts`, which decodes
 *      every raw chunk before repairing the framing — plus that module's
 *      pass-through observer for the non-event-stream early return, where no
 *      reframe transform exists to ride.
 * Neither a `tee()` nor a `clone()` may be reintroduced here. `tee()` locks the
 * body before `onResponse` runs, and `clone()` leaves a pending branch that
 * makes the caller's `cancel()` never settle on a stalled body — measured, not
 * theorized. Both perturb the transport they are meant to observe (BUG-0009).
 *
 * Contract: this sink NEVER writes to console/TUI and never changes control
 * flow — every fs operation is fail-soft, mirroring the probe's posture.
 *
 * ENV
 *   QODER_DEBUG=1          enable (any truthy value; "" and unset disable)
 *   QODER_DEBUG_DIR=...    override output directory
 *   QODER_DEBUG_KEEP=n     session files retained (default 50, oldest pruned)
 *   QODER_DEBUG_HEADERS=1  include auth-bearing headers (redacted by default)
 *   QODER_DEBUG_MAX_BYTES  per-record body/sse cap (default 2000000)
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getPiAgentDir } from "./home.js";

const DEFAULT_KEEP = 50;
const DEFAULT_MAX_BYTES = 2_000_000;
const AUTH_HEADER = /authorization|cookie|api[-_]?key|token|secret|cosy/i;

let activeSession: string | undefined;
// Assigned chain (never a floating statement): serializes the capture-record
// appends so response records land in terminal order, rejections handled.
let writeChain: Promise<void> = Promise.resolve();
const seenFiles = new Set<string>();

export function debugEnabled(): boolean {
  return Boolean(process.env.QODER_DEBUG);
}

export function setDebugSession(sessionId: string | undefined): void {
  activeSession = sessionId && sessionId.length > 0 ? sessionId : undefined;
}

export function getDebugSession(): string | undefined {
  return activeSession;
}

function debugDir(): string {
  return process.env.QODER_DEBUG_DIR || join(getPiAgentDir(), "logs", "qoder-debug");
}

// boundary: process.env is untrusted text — blank-check before coercion, then
// isFinite (NUM-1); Number("") === 0 would silently pass a finite check.
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// shape: none — dispatch object does not apply: single transform, no discriminator.
export function capText(text: string): { text: string; truncated: boolean } {
  const max = envPositiveInt("QODER_DEBUG_MAX_BYTES", DEFAULT_MAX_BYTES);
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "unknown";
}

// boundary: HeadersInit union is validated by the Headers constructor (BND-3:
// host/standard type, no re-declaration); a malformed value yields {} because
// capture must never break a turn (same fail-soft contract as the probe).
export function redactHeadersForDebug(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const includeAuth = process.env.QODER_DEBUG_HEADERS === "1";
  let entries: [string, string][];
  try {
    entries = [...new Headers(headers).entries()];
  } catch {
    return out;
  }
  for (const [k, v] of entries) {
    out[k] = AUTH_HEADER.test(k) && !includeAuth ? `<redacted ${v.length} chars>` : v;
  }
  return out;
}

function pruneIfNew(file: string): void {
  if (seenFiles.has(file)) return;
  seenFiles.add(file);
  try {
    const dir = debugDir();
    const keep = envPositiveInt("QODER_DEBUG_KEEP", DEFAULT_KEEP);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && !f.startsWith("_"))
      .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    // The session being created counts toward the retention window even
    // though its file does not exist yet — prune runs before the first append.
    if (!existsSync(file)) files.push({ path: file, mtime: Date.now() });
    files.sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(keep)) {
      if (stale.path !== file) unlinkSync(stale.path);
    }
  } catch {
    // retention is best-effort (probe precedent); never break a write
  }
}

function appendRecord(file: string, record: Record<string, unknown>): void {
  try {
    const dir = debugDir();
    mkdirSync(dir, { recursive: true });
    pruneIfNew(file);
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch (error) {
    try {
      appendFileSync(
        join(debugDir(), "_errors.jsonl"),
        `${JSON.stringify({ ts: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    } catch {
      // sink of last resort; swallowing here is the contract
    }
  }
}

export function writeDebugRecord(sessionId: string | undefined, record: Record<string, unknown>): void {
  if (!debugEnabled()) return;
  appendRecord(join(debugDir(), `${safeName(sessionId ?? activeSession ?? "extension")}.jsonl`), record);
}

export function enqueueDebugWrite(job: () => Promise<void>): void {
  writeChain = writeChain.then(() => job().catch(() => {}));
}

export interface DebugFetchMeta {
  protocol: "legacy" | "v2";
  session?: string;
  model?: string;
  upstreamKey?: string;
  /** The session id this request actually put on the wire (legacy's session_id / v2's metadata.context.session_id). */
  wireSessionId?: string;
  /** legacy logs its own request record (logical body pre-encoding); the wire body it would see here is COSY-encoded. */
  logRequest?: boolean;
}

/** The wire-session field for a response record; absent stays absent (no invented values). */
function wireSessionField(meta: DebugFetchMeta): { wireSessionId?: string } {
  return meta.wireSessionId !== undefined ? { wireSessionId: meta.wireSessionId } : {};
}

/**
 * The request url both halves of a capture record name. Derived from the
 * request, never from a Response: a constructed Response reads back
 * `url === ""`, so reading it there would silently blank the field.
 */
// shape: none — dispatch object does not apply: one union narrowing with no
//   discriminator value to dispatch on.
// boundary: RequestInfo | URL is a standard fetch union (BND-3 — host type, not
// re-declared), narrowed by typeof/instanceof before any property read.
export function debugFetchUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/**
 * Consumer-side response capture. A transport read pushes the raw text it just
 * decoded and calls `finish()` at its terminal; the record is written from what
 * was actually processed, so an aborted turn records the prefix it saw instead
 * of draining a body the transport never read.
 */
export interface ResponseCapture {
  /** Add raw response text. Bytes past the cap are dropped and set `truncated`. */
  push(text: string): void;
  /** Write the response record once. Idempotent, so teardown paths may repeat it. */
  finish(): void;
}

/**
 * Build a capture for one response, or `undefined` when debug is off — which is
 * what lets every capture site be a bare `capture?.push(...)` that does no
 * accumulator work and allocates nothing on the off path.
 */
// shape: closure returning an object literal — trigger #4 (per-response mutable
//   state, the accumulated text and the written flag, behind two methods; no
//   instanceof or subclassing, so a class would be ceremony).
export function createResponseCapture(meta: DebugFetchMeta, url: string, status: number): ResponseCapture | undefined {
  if (!debugEnabled()) return undefined;
  // Read the cap once per response: bounding the accumulator is what bounds
  // memory as well as disk, so it cannot wait for capText at write time.
  // NUM-1 satisfied by envPositiveInt, which blank-checks before coercing.
  const max = envPositiveInt("QODER_DEBUG_MAX_BYTES", DEFAULT_MAX_BYTES);
  let text = "";
  let truncated = false;
  let written = false;
  return {
    push(chunk: string): void {
      if (truncated) return;
      const room = max - text.length;
      if (chunk.length > room) {
        text += chunk.slice(0, room);
        truncated = true;
        return;
      }
      text += chunk;
    },
    finish(): void {
      // Idempotency (SA §7.10 4Q): the terminal event is the dedup key, so the
      // done, catch and teardown paths may each call this and still append one
      // line. `text`/`truncated` are snapshotted by value here, before the
      // serialized append runs, so a late push cannot reshape the record.
      if (written) return;
      written = true;
      const record = {
        type: "response",
        protocol: meta.protocol,
        model: meta.model,
        upstreamKey: meta.upstreamKey,
        ...wireSessionField(meta),
        url,
        status,
        sse: text,
        truncated,
      };
      enqueueDebugWrite(async () => {
        writeDebugRecord(meta.session, record);
      });
    },
  };
}

// shape: wrapper function — trigger #12 (adds request capture to an inner fetch
//   and hands back that fetch's own Response object; composes under
//   createReframedFetch, which must see raw bytes). The response half is not
//   here — it rides the consumer-side reads named in the module header, so this
//   wrapper neither tees nor re-wraps a body.
export function createDebugFetch(inner: typeof fetch, meta: DebugFetchMeta): typeof fetch {
  if (!debugEnabled()) return inner;
  return async (input, init) => {
    const url = debugFetchUrl(input);
    if (meta.logRequest !== false) {
      const rawBody = init?.body;
      const bodyText =
        typeof rawBody === "string"
          ? rawBody
          : rawBody instanceof Uint8Array
            ? new TextDecoder().decode(rawBody)
            : undefined;
      const capped = bodyText === undefined ? undefined : capText(bodyText);
      writeDebugRecord(meta.session, {
        type: "request",
        protocol: meta.protocol,
        model: meta.model,
        upstreamKey: meta.upstreamKey,
        url,
        method: init?.method ?? "POST",
        headers: redactHeadersForDebug(init?.headers),
        body: capped?.text,
        bodyTruncated: capped?.truncated,
      });
    }
    const response = await inner(input, init);
    if (!response.body) {
      // There is nothing for a consumer-side read to accumulate, so this record
      // is complete here. A response WITH a body is recorded by the transport
      // read that consumes it — see createResponseCapture.
      writeDebugRecord(meta.session, {
        type: "response",
        protocol: meta.protocol,
        model: meta.model,
        upstreamKey: meta.upstreamKey,
        ...wireSessionField(meta),
        url,
        status: response.status,
      });
    }
    // The caller receives this exact object: body unlocked and unconsumed, with
    // no second Response layer between it and the transport's own teardown.
    return response;
  };
}
