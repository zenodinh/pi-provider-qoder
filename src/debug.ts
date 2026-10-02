/**
 * Diagnostic logging for best-effort paths.
 *
 * Several code paths intentionally swallow errors (catalog refresh, env PAT
 * exchange fallthrough, token refresh, userinfo lookup). Reporting only when
 * `QODER_DEBUG` is set keeps normal runs quiet while making those failures
 * diagnosable without changing control flow.
 *
 * Sink contract (owner directive 2026-10-02): debug output goes to the
 * per-session JSONL file sink (debug-log.ts), never to console/TUI.
 */
import { getDebugSession, writeDebugRecord } from "./debug-log.js";

function serializeError(error: unknown): Record<string, unknown> {
  // boundary: `unknown` narrowed by instanceof before any field is read (BND-1)
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { value: String(error) };
}

export function debugLog(message: string, error?: unknown): void {
  if (!process.env.QODER_DEBUG) return;
  writeDebugRecord(getDebugSession(), {
    type: "debug",
    message,
    ...(error !== undefined ? { error: serializeError(error) } : {}),
  });
}
