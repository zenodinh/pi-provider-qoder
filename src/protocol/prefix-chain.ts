// shape: module-scope bounded memo plus pure entry points — trigger #3 (one
//   chain registry per process; an ESM module is evaluated once, which is the
//   guarantee the memo rests on) and trigger #6 (session keys are not known
//   statically, so a Map rather than an object literal — a plain `{}` would
//   answer a never-set session key with an inherited Object.prototype member).
//   Dispatch object does not apply anywhere in this module: no function branches
//   on one discriminator value, so there is no key to index a table by. The
//   shape mirrors run-identity.ts:1-4, whose bounded per-run registry and
//   node:crypto import this module follows rather than reinvents.
//
// Per-turn request identity for the ledger, so a cache miss can be classified
// into exactly one cause instead of being guessed at from a debug dump
// (defects-SA CU-6 / BUG-0005). The write path stores fields; classification is
// a read, so `classifyPrefixMiss` and `tallyPrefixMisses` deliberately have no
// caller inside this repo's turn path — their consumers are the census runbook
// and FS-E's learner gap filter.
import { createHash } from "node:crypto";

/**
 * Per-session chain states remembered per process, evicting least-recently-used.
 * The bound and the eviction discipline are run-identity.ts's `MAX_RUN_STATES`
 * copied rather than reinvented: an unbounded per-session map in a long-lived pi
 * process is a leak, and eviction degrades to class 0 (cold, so no stamp) rather
 * than to a wrong divergence verdict.
 */
const MAX_PREFIX_CHAINS = 64;

/**
 * Published digest width. 128 bits is collision-free for the ledger equality
 * cross-checks these digests exist to serve, at half the raw sha256 width, so
 * six of them on every usage row stay readable in a JSONL dump.
 */
const DIGEST_HEX_LENGTH = 32;

/**
 * Parameter keys the sampling digest must not see. `max_tokens` because the host's
 * cache warmer replays a turn under a one-token cap and a cap is not a sampling
 * change — digesting it would make every warm replay read as class 3 and swallow
 * the whole warm population. The identifier keys because they rotate per dispatch,
 * which would make every turn look changed for a reason no one debugs toward.
 */
const VOLATILE_PARAM_KEYS: ReadonlySet<string> = new Set([
  "max_tokens",
  "maxTokens",
  "request_id",
  "request_set_id",
  "chat_record_id",
  "session_id",
  "business",
]);

/** The chain's public per-turn state: what the ledger stamps and what the memo keeps. */
export interface PrefixChainState {
  /** The running chain digest — the seed folded with one unit per chained message. */
  hash: string;
  /**
   * The chained character length: every character fed into the chain, counting the
   * resolved system text, the canonical tool set and each canonical message. A
   * character-scale number, deliberately a different unit from `prefixDivergedAt`'s
   * message index — the two answer different questions.
   */
  length: number;
  /** The chained message count. */
  units: number;
}

/** The transcript view both adapters already read, plus the session the chain belongs to. */
export interface PrefixChainInput {
  sessionKey: string;
  systemText: string;
  tools: readonly unknown[];
  messages: readonly unknown[];
}

/** One turn's chain step: the new state, and how it relates to the session's previous one. */
export interface PrefixChainStep {
  state: PrefixChainState;
  /**
   * The message index where this turn's chain first stopped matching the session's
   * previous one, or `undefined` when it extended it. A changed seed (system text
   * or tool set) reports 0, because the whole prefix is gone rather than one
   * message; a transcript that shrank reports the first message the previous chain
   * had and this one no longer does, because a shrink did not extend the chain and
   * calling it stable would fabricate the observation these fields exist to make
   * trustworthy.
   */
  divergedAt: number | undefined;
  /** True when the session had no previous chain state — cold, or evicted past the bound. */
  cold: boolean;
}

/**
 * The six usage fields a dispatched turn stamps. All six are written together or
 * not at all: `prefixStampFields` returns `undefined` for a cold chain rather than
 * a partial stamp, so a row carrying some of the six never reaches the ledger.
 */
export interface PrefixStamp {
  prefixLen: number;
  prefixHash: string;
  prefixStable: boolean;
  prefixDivergedAt?: number;
  /**
   * A digest of the sampling parameters this turn dispatched under, EXCLUDING
   * `max_tokens` and the per-dispatch identifiers — so the host cache warmer's
   * one-token replay cap does not read as a sampling change. Like `payloadHash`,
   * NOT comparable across transports: each digests its own transport's sampling
   * view (legacy the Qoder `parameters` record, v2 the option fields pi-ai merges
   * into its body), so a class-3 comparison only holds within one transport's rows.
   */
  paramsHash: string;
  /**
   * A digest of the whole logical payload view the transport resolved. NOT
   * comparable across transports: legacy digests the prompt view it assembles
   * before the request body, while v2 digests its own prompt view assembled inside
   * the payload hook — neither is pi-ai's or COSY's wire body, and each is resolved
   * before the caller's `onPayload` hook can replace it. FR-6 only ever
   * cross-checks it same-transport ("a same-transport `payloadHash` cross-check
   * contradicts a row's `prefixStable`"), so the asymmetry is contained — but a
   * cross-transport query over this field silently returns nothing. Named
   * `payloadHash` rather than `bodyHash` because cosy.ts's `bodyHash` is a third,
   * distinct value: an md5 over the COSY-encoded bytes.
   */
  payloadHash: string;
}

/** The four miss causes defects-SA §1.2 enumerates, as a closed numeric union. */
export type PrefixMissClass = 0 | 1 | 2 | 3;

/**
 * One ledger row's prefix evidence, as the read side assembles it. The six prefix
 * keys are optional because the ledger is a trust boundary: a row predating this
 * change carries none of them, and a row written by a rejected pre-dispatch turn
 * carries none either. They are spelled once, by `PrefixStamp`, so a field the
 * writer renames is a compile error here rather than a silent desync.
 */
export interface PrefixMissRow extends Partial<PrefixStamp> {
  /**
   * The cache-read token count — what makes the row a miss at all. REQUIRED rather
   * than optional: it is a pi-core usage field every ledger row carries, so a reader
   * that forgets to join it should fail to compile instead of silently classifying
   * every stamped row as "not a miss" and tallying zero causes.
   */
  cacheRead: number;
  /**
   * The previous turn's `paramsHash`, joined by the reader rather than stored on
   * the row. OPTIONAL BY DESIGN, and its absence is a first-class state, not an
   * error: a stamped row whose own predecessor was cold has nothing to compare
   * against, because a cold turn writes none of the six keys — which makes this
   * the second turn of every session, not a rare row. Never default it to `""` or
   * to the row's own hash; either would make class 3 silently unreachable or
   * silently always-false. When it is absent, class 3 cannot be claimed and the
   * row's class-2 assignment is a residual, which `tallyPrefixMisses` counts
   * separately so the guess stays visible.
   */
  previousParamsHash?: string;
}

/** The class tally plus the one counter that keeps class 2's residual honest. */
export interface PrefixMissTally {
  classes: Record<PrefixMissClass, number>;
  /**
   * Class-2 rows assigned with no predecessor `paramsHash` available. A class-2
   * assignment asserts "server-side" — vendor eviction or a missing-affinity
   * routing miss — but it is the residual, reached only after a sampling change
   * was excluded, and with no predecessor nothing was excluded. Reported beside
   * the tally so a reader can see how much of the class-2 total is
   * residual-because-unjoinable rather than genuinely server-side.
   */
  unjoinedClass2: number;
}

/**
 * The memo's private entry: the published state plus the per-unit digests that
 * locate a divergence. The digests stay private because `PrefixChainState` is the
 * ledger-facing shape and a digest list is not a field anyone persists.
 */
interface ChainEntry {
  state: PrefixChainState;
  seed: string;
  units: string[];
}

/** Both protocols' chain registry. Insertion order is the recency order (see rememberChain). */
const chains = new Map<string, ChainEntry>();

// A record predicate rather than a cast: every value this module digests arrives
// as `unknown` from an adapter's transcript view, and reading a field off
// `unknown` is what forces the narrowing (BND-1). No shared export exists to
// reuse — every copy in this repo is file-local, as stream.test.ts's boundary
// comment records.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDigestWidth(hex: string): string {
  return hex.slice(0, DIGEST_HEX_LENGTH);
}

function digest(text: string): string {
  return toDigestWidth(createHash("sha256").update(text).digest("hex"));
}

/**
 * The canonical text of one chain unit. JSON is the serializer these views already
 * round-trip through — pi persists the same message objects as JSONL — so key
 * order is identical for identical content on both transports, which is what makes
 * `prefixHash` comparable between them (AC-02).
 */
function unitText(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/**
 * The seed's digest and character length: the resolved system text plus the tool
 * set. Both adapters read them from the same transcript helpers, so the seed is
 * transport-independent even though the envelopes around it are not.
 */
function seedOf(input: PrefixChainInput): { digest: string; length: number } {
  const hash = createHash("sha256");
  hash.update("system\0");
  hash.update(input.systemText);
  let length = input.systemText.length;
  for (const tool of input.tools) {
    const text = unitText(tool);
    hash.update("\0tool\0");
    hash.update(text);
    length += text.length;
  }
  return { digest: toDigestWidth(hash.digest("hex")), length };
}

/**
 * The message index where this turn first stopped matching the session's previous
 * chain, or `undefined` when it extended it.
 */
function firstDivergence(previous: ChainEntry, seed: string, units: readonly string[]): number | undefined {
  if (previous.seed !== seed) return 0;
  const shared = Math.min(previous.units.length, units.length);
  for (let index = 0; index < shared; index++) {
    if (previous.units[index] !== units[index]) return index;
  }
  return units.length < previous.units.length ? units.length : undefined;
}

/**
 * Store (or refresh) a session's chain as the most recently used one, then evict
 * the least recently used entry past the cap. Re-inserting on every touch is what
 * makes `chains` an LRU rather than an insertion-order FIFO: a session still being
 * continued must not be evicted mid-conversation while an abandoned slot lingers.
 * The discipline is run-identity.ts's `rememberRun`, copied rather than reinvented.
 */
function rememberChain(key: string, entry: ChainEntry): void {
  chains.delete(key);
  chains.set(key, entry);
  if (chains.size > MAX_PREFIX_CHAINS) {
    const leastRecentKey = chains.keys().next().value;
    if (leastRecentKey !== undefined) chains.delete(leastRecentKey);
  }
}

// shape: none — dispatch object does not apply: one entry point over a
//   straight-line derivation whose only branch is the cold/warm guard, below the
//   ≥3 threshold. The registry it reads is the module-scope memo (trigger #3).
/**
 * Chain one turn onto its session's previous chain and remember the result.
 *
 * The chain runs over the transcript view both adapters already read, above both
 * wire transforms, rather than over outgoing bytes: the v2-to-legacy self-heal
 * re-dispatches the same context over a different envelope, so a wire digest would
 * report a divergence between two turns whose prompts were identical — fabricating
 * the exact signal these fields exist to make trustworthy. Routing ids and the
 * `business` object are not inputs for the same reason: `request_id` is a fresh
 * UUID per dispatch and `business.id` rotates per run, so either would make every
 * turn look diverged.
 *
 * Not wrapped in a guard: the unit digests are sha256 over JSON of views pi itself
 * persists as JSONL, so they are acyclic by construction, and a speculative
 * catch-and-continue here would silently publish a wrong-but-stable hash — a
 * fabricated observation, which is worse than the throw.
 */
export function extendPrefixChain(input: PrefixChainInput): PrefixChainStep {
  const seed = seedOf(input);
  const units: string[] = [];
  let length = seed.length;
  for (const message of input.messages) {
    const text = unitText(message);
    length += text.length;
    units.push(digest(text));
  }
  // Merkle–Damgård fold: each unit extends the running digest, so an appended
  // message continues the previous chain rather than restarting it.
  let hash = seed.digest;
  for (const unit of units) hash = digest(hash + unit);

  const previous = chains.get(input.sessionKey);
  const state: PrefixChainState = { hash, length, units: units.length };
  rememberChain(input.sessionKey, { state, seed: seed.digest, units });

  if (previous === undefined) return { state, divergedAt: undefined, cold: true };
  return { state, divergedAt: firstDivergence(previous, seed.digest, units), cold: false };
}

// shape: none — dispatch object does not apply: a one-statement test-only
//   resetter with no branch and no discriminator.
/** Empty the chain registry. Exposed for tests only. */
export function clearPrefixChainRegistry(): void {
  chains.clear();
}

/**
 * The digest input for a parameter view: its own keys in sorted order, minus the
 * volatile ones. Sorted because the adapters build `parameters` conditionally —
 * `temperature` only when the caller set it, `reasoning_effort` only when the
 * model exposes efforts — so insertion order is not stable across turns that
 * differ in which optional parameters were present.
 */
function paramsText(view: unknown): string {
  if (!isRecord(view)) return unitText(view);
  const keys = Object.keys(view)
    .filter((key) => !VOLATILE_PARAM_KEYS.has(key))
    .sort();
  return keys.map((key) => `${key}=${unitText(view[key])}`).join("&");
}

// shape: none — value builder: a straight-line derivation with one cold guard and
//   no discriminator. Trigger #7 for the returned fixed-shape record.
/**
 * Derive the six usage fields from one chain step, or `undefined` when the chain
 * is cold.
 *
 * A cold chain has no predecessor and therefore no divergence verdict to give, so
 * it returns `undefined` and the caller writes NONE of the six keys. That absence
 * is the information: it is how class 0 is represented, and coercing a cold turn
 * into stable or diverged would make the census unable to distinguish a genuinely
 * append-only session from a process that had just started. `undefined` is the
 * encoding of "cold" — there is deliberately no partial-stamp shape.
 */
export function prefixStampFields(chain: PrefixChainStep, params: unknown, payload: unknown): PrefixStamp | undefined {
  if (chain.cold) return undefined;
  const stamp: PrefixStamp = {
    prefixLen: chain.state.length,
    prefixHash: chain.state.hash,
    prefixStable: chain.divergedAt === undefined,
    paramsHash: digest(paramsText(params)),
    payloadHash: digest(unitText(payload)),
  };
  // Present exactly when the prefix is not stable, so the two never disagree.
  if (chain.divergedAt !== undefined) stamp.prefixDivergedAt = chain.divergedAt;
  return stamp;
}

/**
 * Stamped means the writer wrote the stamp: every key that is always present when
 * it does. A partial row is treated as unstamped rather than guessed at, because a
 * row carrying some of the six is what a pre-dispatch rejection must never produce
 * (AC-07) and classifying it would invent the missing half.
 */
function isStamped(row: PrefixMissRow): boolean {
  return (
    typeof row.prefixLen === "number" &&
    typeof row.prefixHash === "string" &&
    typeof row.prefixStable === "boolean" &&
    typeof row.paramsHash === "string" &&
    typeof row.payloadHash === "string"
  );
}

// shape: none — dispatch object does not apply: the four classes are a guard
//   cascade over field CONJUNCTIONS (stamped? a miss? stable? params joined and
//   changed?), not branches on one discriminator value, so there is no key to
//   index a table by. Returns a literal from a closed numeric union, the idiom
//   routing.ts uses for a closed vocabulary.
/**
 * Classify one miss row into exactly one of the four causes defects-SA §1.2 names,
 * or `undefined` when there is no cause to name.
 *
 * The classes, in guard order: class 0 is stamp absent — returned as `undefined`,
 * never coerced to the literal 0, because folding an unstamped row into a
 * divergence class double-counts a cause the owner then debugs toward. Class 1 is
 * a prefix diverged against the session's previous CHAINED ATTEMPT — the memo
 * advances on every dispatch the adapters reach the stamp site for, including one
 * the caller's payload hook or the gateway then rejects, so the baseline is the
 * last chained attempt rather than the last turn the vendor served. Class 3 is a sampling change,
 * which needs the reader's join: `prefixStable` is derivable from one row only
 * because the WRITER resolved that comparison at stamp time and stored the result,
 * while a params comparison has no stored result and so needs `previousParamsHash`.
 * Class 2 — server-side, read as vendor eviction or a missing-affinity routing miss
 * until BUG-0007's probe closes — is the residual for a stamped miss whose prefix
 * held and whose sampling did not change.
 *
 * `undefined` therefore covers two honest cases: an unstamped row (class 0) and a
 * row the cache actually served, which is not a miss and has no cause.
 * `tallyPrefixMisses` separates them.
 */
export function classifyPrefixMiss(row: PrefixMissRow): PrefixMissClass | undefined {
  if (!isStamped(row)) return undefined;
  // `cacheRead` being zero is the miss definition this repo's other reader keys on
  // too, so the two readers cannot disagree about what a miss is.
  if (row.cacheRead !== 0) return undefined;
  if (row.prefixStable === false) return 1;
  if (row.previousParamsHash !== undefined && row.previousParamsHash !== row.paramsHash) return 3;
  return 2;
}

// shape: none — a fold over rows into a fixed-shape record (trigger #7); the
//   per-item work is one classifyPrefixMiss call, with no discriminator to
//   dispatch on and no state beyond the accumulator.
/**
 * Count a ledger scan's miss rows by class, beside the one counter that keeps the
 * class-2 residual honest.
 *
 * Read-side by design, like `classifyPrefixMiss`: the ledger stores fields and
 * classification is a read, so neither is called on the write path. The consumer
 * is the census runbook and FS-E's learner gap filter, which walk the ledger
 * sequentially and therefore have adjacent rows in hand to join
 * `previousParamsHash` from.
 */
export function tallyPrefixMisses(rows: readonly PrefixMissRow[]): PrefixMissTally {
  const tally: PrefixMissTally = { classes: { 0: 0, 1: 0, 2: 0, 3: 0 }, unjoinedClass2: 0 };
  for (const row of rows) {
    const classified = classifyPrefixMiss(row);
    if (classified === undefined) {
      // An unstamped row IS class 0 (FR-6: "class 0 (stamp absent) means the chain
      // was cold"). A stamped row the cache served is not a miss, so it joins no
      // class rather than inflating one.
      if (!isStamped(row)) tally.classes[0] += 1;
      continue;
    }
    tally.classes[classified] += 1;
    if (classified === 2 && row.previousParamsHash === undefined) tally.unjoinedClass2 += 1;
  }
  return tally;
}
