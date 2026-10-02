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
// Assigned chain (never a floating statement): serializes the async clone
// reads so response records land in request order, rejections handled.
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

// shape: wrapper function — trigger #12 (adds capture behavior to an inner
//   fetch; composes under createReframedFetch, which must see raw bytes).
export function createDebugFetch(inner: typeof fetch, meta: DebugFetchMeta): typeof fetch {
  if (!debugEnabled()) return inner;
  return async (input, init) => {
    // boundary: RequestInfo union narrowed by typeof/instanceof (standard fetch types)
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
      writeDebugRecord(meta.session, {
        type: "response",
        protocol: meta.protocol,
        model: meta.model,
        upstreamKey: meta.upstreamKey,
        ...wireSessionField(meta),
        url,
        status: response.status,
      });
      return response;
    }
    const [main, clone] = response.body.tee();
    enqueueDebugWrite(async () => {
      const text = await new Response(clone).text();
      const capped = capText(text);
      writeDebugRecord(meta.session, {
        type: "response",
        protocol: meta.protocol,
        model: meta.model,
        upstreamKey: meta.upstreamKey,
        ...wireSessionField(meta),
        url,
        status: response.status,
        sse: capped.text,
        truncated: capped.truncated,
      });
    });
    return new Response(main, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
