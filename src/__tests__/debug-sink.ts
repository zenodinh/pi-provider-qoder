// Shared reader for the QODER_DEBUG file sink (src/debug-log.ts JSONL).
// Records land in `<QODER_DEBUG_DIR>/<session>.jsonl`, or `extension.jsonl`
// when no session attribution is active.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// boundary: sink lines are JSON text — parse to unknown and narrow with a
// record predicate before any field read (BND-1).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function readDebugRecords(dir: string, sessionFile = "extension"): Record<string, unknown>[] {
  const file = join(dir, `${sessionFile}.jsonl`);
  if (!existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const raw: unknown = JSON.parse(line);
    if (isRecord(raw)) out.push(raw);
  }
  return out;
}

export function debugMessages(dir: string, sessionFile = "extension"): string[] {
  return readDebugRecords(dir, sessionFile)
    .filter((record) => record.type === "debug")
    .map((record) => String(record.message));
}
