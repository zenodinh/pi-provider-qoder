// Test-only builders for synthetic pi session entries. The shapes mirror the
// recorded session ledgers (probed 2026-10-01 at ~/.pi/agent/sessions), but
// every value here is invented for the scenario under test — no live
// transcript is copied (fixture provenance: invented, recorded shapes).
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { QoderCreditsUsage } from "../protocol/usage.js";

export interface TokenSpec {
  input: number;
  cacheRead: number;
  cacheWrite?: number;
  output: number;
}

function usageWith(tokens: TokenSpec, costTotal: number, credits?: number): Usage & QoderCreditsUsage {
  const cacheWrite = tokens.cacheWrite ?? 0;
  const usage: Usage & QoderCreditsUsage = {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite,
    totalTokens: tokens.input + tokens.cacheRead + cacheWrite + tokens.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
  if (credits !== undefined) {
    usage.credits = credits;
    usage.original_credits = credits;
    usage.billable = true;
  }
  return usage;
}

/** A real assistant turn (`message` entry); Credits are optional like the ledger's. */
export function assistantEntry(model: string, timestampMs: number, tokens: TokenSpec, credits?: number): SessionEntry {
  return {
    type: "message",
    id: `m-${timestampMs}`,
    parentId: null,
    timestamp: new Date(timestampMs).toISOString(),
    message: {
      role: "assistant",
      content: [],
      api: "qoder-api",
      provider: "qoder",
      model,
      usage: usageWith(tokens, 0, credits),
      stopReason: "stop",
      timestamp: timestampMs,
    },
  };
}

/** A pi cache-warm refresh row (`usage` entry, kind cache_warm). */
export function warmEntry(timestampMs: number, tokens: TokenSpec, costTotal = 0, credits?: number): SessionEntry {
  return {
    type: "usage",
    id: `w-${timestampMs}`,
    parentId: null,
    timestamp: new Date(timestampMs).toISOString(),
    kind: "cache_warm",
    provider: "qoder",
    model: "auto",
    usage: usageWith(tokens, costTotal, credits),
    note: "extension override",
  };
}

/** A compaction entry: resets the guard anchor and breaks natural gaps. */
export function compactionEntry(timestampMs: number): SessionEntry {
  return {
    type: "compaction",
    id: `c-${timestampMs}`,
    parentId: null,
    timestamp: new Date(timestampMs).toISOString(),
    summary: "compacted",
    firstKeptEntryId: "first",
    tokensBefore: 1000,
  };
}
