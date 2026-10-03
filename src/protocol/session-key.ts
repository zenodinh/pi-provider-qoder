// shape: none — three leaf helpers every session-form derivation shares: one
//   bound constant, one clamp, one stable hash. No dispatch, no state, no I/O.
//   A leaf so the plan producer has no import edge back into the adapters it
//   feeds: plan.ts consumes these; stream.ts and v2.ts provide the derivations
//   around them.
import { createHash } from "node:crypto";

/** Both protocols bound their session-derived prompt-cache keys to 64 characters. */
export const MAX_PROMPT_CACHE_KEY_LENGTH = 64;

/**
 * Truncation (not hashing) to the shared bound, mirroring pi-ai's
 * clampOpenAIPromptCacheKey; the same 64-character prompt_cache_key bound the
 * legacy path enforces. The plan's producer applies the identical bound.
 */
export function clampPromptCacheKey(id: string): string {
  return id.length <= MAX_PROMPT_CACHE_KEY_LENGTH ? id : id.slice(0, MAX_PROMPT_CACHE_KEY_LENGTH);
}

/** A stable, bounded hash for session identities that do not fit the readable form. */
export function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}
