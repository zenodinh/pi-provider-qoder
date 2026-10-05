import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyPrefixMiss,
  clearPrefixChainRegistry,
  extendPrefixChain,
  type PrefixMissRow,
  prefixStampFields,
  tallyPrefixMisses,
} from "../protocol/prefix-chain.js";

/**
 * The chain memo is module state, so every row starts from a cold registry. A row
 * that leaked its predecessor into the next would report `cold: false` on a
 * first turn and silently pass the divergence assertions.
 */
beforeEach(() => clearPrefixChainRegistry());
afterEach(() => clearPrefixChainRegistry());

// invented: a minimal two-turn transcript. The chain digests whatever view the
// adapters hand it, so the literals stand in for pi's message objects; their
// shape (role/content) is the shape withoutInitialSystemMessage yields.
const SYSTEM_TEXT = "you are helpful";
const TOOLS = [{ name: "read", description: "Read a file" }];
const TURN_1 = [{ role: "user", content: "hi" }];
const TURN_2 = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "and again" },
];

function chain(messages: readonly unknown[], sessionKey = "session-a", systemText = SYSTEM_TEXT) {
  return extendPrefixChain({ sessionKey, systemText, tools: TOOLS, messages });
}

/** Warm the registry for `sessionKey` so the next chain step is not cold. */
function warmThen(messages: readonly unknown[], sessionKey = "session-a", systemText = SYSTEM_TEXT) {
  chain(TURN_1, sessionKey, systemText);
  return chain(messages, sessionKey, systemText);
}

// invented: one parameter view per movement, mirroring the keys stream.ts builds
// into `parameters` (max_tokens always, temperature/top_p when the caller set them).
const PARAMS = { max_tokens: 131072, temperature: 0.7, top_p: 0.9, enable_thinking: true };
// invented: the legacy stamp site's logical prompt view — system text, normalized
// messages, tools and parameters, and nothing that varies per dispatch.
const PAYLOAD_VIEW = { systemText: SYSTEM_TEXT, messages: TURN_2, tools: TOOLS, parameters: PARAMS };

describe("extendPrefixChain (spec CU-01)", () => {
  // spec: T-01 / AC-01,AC-02 — an extending turn is stable and a rewritten turn
  // names where it broke.
  it("T-01 reports no divergence for an append-only conversation and extends the hash", () => {
    const first = chain(TURN_1);
    expect(first.cold, "the first turn in a session has no predecessor").toBe(true);
    expect(first.divergedAt, "a cold turn makes no divergence claim").toBeUndefined();

    const appended = chain(TURN_2);
    expect(appended.cold, "the session's second turn is warm").toBe(false);
    expect(appended.divergedAt, "appending messages extends the chain rather than breaking it").toBeUndefined();
    expect(appended.state.hash, "the chain continues from the previous digest").not.toBe(first.state.hash);
    expect(appended.state.units, "one unit per chained message").toBe(TURN_2.length);
    expect(appended.state.length, "the chained length grows by the appended messages' characters").toBeGreaterThan(
      first.state.length,
    );
  });

  // spec: T-01 / AC-03 — a rewritten turn names the message index where it broke.
  it("T-01 reports the rewritten message's index when an earlier message changes", () => {
    chain(TURN_2);
    const rewritten = chain([TURN_2[0], { role: "assistant", content: "DIFFERENT" }, TURN_2[2]]);

    expect(rewritten.divergedAt, "the divergence points at the rewritten message").toBe(1);
    expect(rewritten.cold, "the session already had a chain").toBe(false);
  });

  it("T-01 reports index 0 when the system text changes, because the whole prefix is gone", () => {
    chain(TURN_2, "session-sys");
    const changed = chain(TURN_2, "session-sys", "you are terse");
    expect(changed.divergedAt, "a seed change breaks every message at once").toBe(0);
  });

  // A shrink is not an extension, so it must not read as stable: calling it stable
  // would fabricate the observation the fields exist to make trustworthy.
  it("T-01 reports a divergence when the transcript shrank rather than claiming it was stable", () => {
    chain(TURN_2);
    const shrunk = chain([TURN_2[0]]);
    expect(shrunk.divergedAt, "the first message the previous chain had and this one dropped").toBe(1);
  });

  // spec: T-02 / AC-05 — the chain covers the prompt, not the per-dispatch identifiers.
  it("T-02 is insensitive to a fresh request_id and a rotated business.id", () => {
    // Neither identifier is a chain input — `extendPrefixChain` takes the prompt
    // view only — so two dispatches of one user turn chain identically no matter
    // how the envelope around them rotated.
    const dispatchOne = chain(TURN_2, "session-run-a");
    const dispatchTwo = chain(TURN_2, "session-run-b");

    expect(dispatchTwo.state.hash, "a rotated envelope leaves the prompt untouched").toBe(dispatchOne.state.hash);
    expect(dispatchTwo.state.length, "and neither dispatch chained a character the other did not").toBe(
      dispatchOne.state.length,
    );

    // Contrast: a real prompt change does move the hash, so the equality above is
    // not the artifact of a constant function.
    expect(chain([{ role: "user", content: "a different prompt" }], "session-contrast").state.hash).not.toBe(
      dispatchOne.state.hash,
    );
  });

  // spec: T-02 / AC-02 — the same holds across the two transports' differing
  // envelope shapes for an identical transcript.
  it("T-02 derives the same hash from an identical transcript under a different session envelope", () => {
    const legacyView = chain(TURN_2, "qoder-session-user-lite-pi-session-1");
    const v2View = chain(TURN_2, "pi-session-1");
    expect(legacyView.state.hash, "prefixHash is transport-independent for an identical transcript").toBe(
      v2View.state.hash,
    );
  });

  // spec: T-03 / AC-05 — the memo is bounded and evicts least-recently-used,
  // degrading to class 0 rather than to a wrong verdict.
  it("T-03 evicts the least recently used session past the bound and keeps a newer one", () => {
    const MAX_PREFIX_CHAINS = 64; // mirrors run-identity.ts's MAX_RUN_STATES

    chain(TURN_1, "session-drop");
    chain(TURN_1, "session-keep");
    // 62 more brings the registry to exactly the bound, so nothing has evicted yet.
    for (let index = 0; index < MAX_PREFIX_CHAINS - 2; index++) {
      chain(TURN_1, `session-fill-${index}`);
    }
    // One past the bound evicts the least recently used entry: session-drop.
    chain(TURN_1, "session-overflow");

    // Assert the survivor FIRST: probing a session re-inserts it as most recently
    // used, so probing the evicted one before the survivor would itself evict the
    // survivor and make the row pass or fail on its own assertion order.
    expect(chain(TURN_1, "session-keep").cold, "a more recently touched session still extends").toBe(false);
    expect(chain(TURN_1, "session-drop").cold, "the earliest session was evicted, so it is cold again").toBe(true);
  });
});

describe("prefixStampFields (spec CU-02)", () => {
  // spec: T-04 / AC-03,AC-04 — a cold chain produces absent keys, never a coerced
  // verdict, and the six fields are mutually consistent when present.
  it("T-04 returns undefined for a cold chain so the caller writes none of the six keys", () => {
    const cold = chain(TURN_2);
    expect(cold.cold, "precondition: the registry was cleared, so this turn is cold").toBe(true);
    expect(prefixStampFields(cold, PARAMS, PAYLOAD_VIEW), "cold ⇒ no stamp, so class 0 stays honest").toBeUndefined();
  });

  it("T-04 returns all six fields for a warm chain, with prefixDivergedAt present exactly when unstable", () => {
    const stable = warmThen(TURN_2);
    const stableStamp = prefixStampFields(stable, PARAMS, PAYLOAD_VIEW);
    expect(stableStamp, "a warm chain is stamped").toBeDefined();
    expect(Object.keys(stableStamp ?? {}).sort(), "exactly the six ledger keys, and no others").toEqual([
      "paramsHash",
      "payloadHash",
      "prefixHash",
      "prefixLen",
      "prefixStable",
    ]);
    expect(stableStamp?.prefixStable, "an append-only turn is stable").toBe(true);
    expect(stableStamp?.prefixDivergedAt, "a stable turn carries no divergence index").toBeUndefined();
    expect(stableStamp?.prefixLen, "the chained character length, a character-scale number").toBeGreaterThan(0);
    expect(stableStamp?.prefixHash, "the chain digest").toBe(stable.state.hash);

    // The predecessor must already hold the message being rewritten: a rewrite at
    // an index the previous turn never reached is an append, not a divergence.
    chain(TURN_2);
    const diverged = chain([TURN_2[0], { role: "assistant", content: "REWRITTEN" }, TURN_2[2]]);
    const divergedStamp = prefixStampFields(diverged, PARAMS, PAYLOAD_VIEW);
    expect(divergedStamp?.prefixStable, "a rewritten turn is not stable").toBe(false);
    expect(divergedStamp?.prefixDivergedAt, "an unstable turn names the message index").toBe(1);
  });

  // spec: T-06 / AC-06 — the parameter digest excludes the warm replay's cap and
  // volatile ids, and still detects a real sampling change.
  it("T-06 ignores max_tokens so a warm replay's one-token cap is not a sampling change", () => {
    const warm = warmThen(TURN_2);
    const full = prefixStampFields(warm, PARAMS, PAYLOAD_VIEW);
    const warmReplay = prefixStampFields(warm, { ...PARAMS, max_tokens: 1 }, PAYLOAD_VIEW);

    expect(warmReplay?.paramsHash, "the host's cache warmer caps at one token").toBe(full?.paramsHash);
  });

  it("T-06 detects a genuine sampling change to temperature or top_p", () => {
    const warm = warmThen(TURN_2);
    const base = prefixStampFields(warm, PARAMS, PAYLOAD_VIEW);

    expect(prefixStampFields(warm, { ...PARAMS, temperature: 0.2 }, PAYLOAD_VIEW)?.paramsHash).not.toBe(
      base?.paramsHash,
    );
    expect(prefixStampFields(warm, { ...PARAMS, top_p: 0.5 }, PAYLOAD_VIEW)?.paramsHash).not.toBe(base?.paramsHash);
  });

  it("T-06 ignores volatile identifiers in the parameter view", () => {
    const warm = warmThen(TURN_2);
    const base = prefixStampFields(warm, { ...PARAMS, request_id: "id-1", session_id: "s-1" }, PAYLOAD_VIEW);
    const rotated = prefixStampFields(warm, { ...PARAMS, request_id: "id-2", session_id: "s-2" }, PAYLOAD_VIEW);

    expect(rotated?.paramsHash, "per-dispatch identifiers are not a sampling change").toBe(base?.paramsHash);
  });

  it("T-06 is insensitive to the order the adapter happened to insert parameter keys in", () => {
    const warm = warmThen(TURN_2);
    const one = prefixStampFields(warm, { max_tokens: 8, temperature: 0.7, enable_thinking: true }, PAYLOAD_VIEW);
    const other = prefixStampFields(warm, { enable_thinking: true, temperature: 0.7, max_tokens: 8 }, PAYLOAD_VIEW);

    expect(other?.paramsHash, "parameters are built conditionally, so insertion order is not stable").toBe(
      one?.paramsHash,
    );
  });

  it("T-06 digests a non-record parameter view by its canonical text", () => {
    const warm = warmThen(TURN_2);
    // The adapters both pass a record, but the view is typed `unknown` and the
    // digest must not depend on that: a non-record falls back to its canonical text
    // rather than throwing or silently digesting every such view alike.
    const scalar = prefixStampFields(warm, "no-parameters", PAYLOAD_VIEW)?.paramsHash;
    expect(scalar, "a non-record view still digests").toBeDefined();
    expect(
      prefixStampFields(warm, "other-parameters", PAYLOAD_VIEW)?.paramsHash,
      "and still distinguishes views",
    ).not.toBe(scalar);
  });

  // Ruling Q2 requirement 1's falsifier row: the payload view must contain only
  // prompt-determining content. If any per-request value entered it, payloadHash
  // would move on every turn, prefixStable could never be true, and the divergence
  // signal BUG-0005 exists to collect would be written, hashed and meaningless.
  it("Q2-R1 produces an identical payloadHash for two consecutive turns with an unchanged prompt", () => {
    const warm = warmThen(TURN_2);
    const first = prefixStampFields(warm, PARAMS, PAYLOAD_VIEW);
    const second = prefixStampFields(warm, PARAMS, PAYLOAD_VIEW);

    expect(second?.payloadHash, "an unchanged prompt digests identically turn over turn").toBe(first?.payloadHash);
    expect(second?.prefixStable, "and the row still reads stable").toBe(true);
  });

  it("Q2-R1 moves payloadHash when the prompt view actually changes", () => {
    const warm = warmThen(TURN_2);
    const base = prefixStampFields(warm, PARAMS, PAYLOAD_VIEW);
    const changed = prefixStampFields(warm, PARAMS, { ...PAYLOAD_VIEW, systemText: "you are terse" });

    expect(changed?.payloadHash, "the digest does cover the prompt it claims to").not.toBe(base?.payloadHash);
  });
});

describe("classifyPrefixMiss (spec CU-02)", () => {
  // invented: one stamped row per class, with the six fields a warm turn writes.
  const STAMPED: PrefixMissRow = {
    prefixLen: 412300,
    prefixHash: "9f2c000000000000000000000000abcd",
    prefixStable: true,
    paramsHash: "41ab000000000000000000000000abcd",
    payloadHash: "77e0000000000000000000000000abcd",
    cacheRead: 0,
  };

  // spec: T-05 / AC-04,AC-06 — every miss row classifies into exactly one of class
  // 0-3, and class 0 is never coerced. Class meanings are defects-SA §1.2: stamp
  // absent / prefix diverged vs previous real turn / server-side / sampling-change.
  it("T-05 returns exactly one class per fixture", () => {
    expect(classifyPrefixMiss({ cacheRead: 0 }), "class 0 — stamp absent, reported as unstamped").toBeUndefined();
    expect(
      classifyPrefixMiss({ ...STAMPED, prefixStable: false, prefixDivergedAt: 3 }),
      "class 1 — prefix diverged against the previous real turn",
    ).toBe(1);
    expect(classifyPrefixMiss(STAMPED), "class 2 — server-side: stable prefix, full cache miss").toBe(2);
    expect(
      classifyPrefixMiss({ ...STAMPED, previousParamsHash: "0000000000000000000000000000ffff" }),
      "class 3 — sampling changed against the joined predecessor",
    ).toBe(3);
  });

  it("T-05 never coerces an unstamped row into a divergence class", () => {
    // A partial row is treated as unstamped rather than guessed at: a row carrying
    // some of the six is what a pre-dispatch rejection must never produce (AC-07).
    expect(classifyPrefixMiss({ cacheRead: 0 }), "no fields at all").toBeUndefined();
    expect(classifyPrefixMiss({ prefixLen: 412300, cacheRead: 0 }), "one field only").toBeUndefined();
    expect(classifyPrefixMiss({ ...STAMPED, prefixHash: undefined }), "a partial stamp").toBeUndefined();
  });

  it("T-05 does not claim a sampling change it had no predecessor to compare against", () => {
    // previousParamsHash absent is a first-class state, not an error: a stamped row
    // whose own predecessor was cold has no paramsHash to join, which is the second
    // turn of every session.
    expect(classifyPrefixMiss(STAMPED), "absent predecessor ⇒ class 2, not class 3").toBe(2);
    expect(
      classifyPrefixMiss({ ...STAMPED, previousParamsHash: STAMPED.paramsHash }),
      "a joined predecessor with the same params is not a sampling change",
    ).toBe(2);
  });

  it("T-05 names no cause for a row the cache actually served", () => {
    expect(classifyPrefixMiss({ ...STAMPED, cacheRead: 97076 }), "not a miss, so no class").toBeUndefined();
  });

  // Ruling Q3: the class-2 fall-through is a guess and must be visible. One counter
  // beside the class tally reports how much of class 2 is residual-because-unjoinable
  // rather than genuinely server-side.
  it("Q3 counts a class-2 row assigned without a predecessor comparison, and only that case", () => {
    const unjoined = tallyPrefixMisses([STAMPED]);
    expect(unjoined.classes[2], "the row is class 2").toBe(1);
    expect(unjoined.unjoinedClass2, "and it was assigned with nothing to compare against").toBe(1);

    const joined = tallyPrefixMisses([{ ...STAMPED, previousParamsHash: STAMPED.paramsHash }]);
    expect(joined.classes[2], "still class 2").toBe(1);
    expect(joined.unjoinedClass2, "but the comparison was available, so it is not a guess").toBe(0);

    const sampling = tallyPrefixMisses([{ ...STAMPED, previousParamsHash: "0000000000000000000000000000ffff" }]);
    expect(sampling.classes[3], "a joined predecessor that differs is class 3").toBe(1);
    expect(sampling.unjoinedClass2, "and does not touch the class-2 counter").toBe(0);
  });

  it("Q3 tallies every class once and counts unstamped rows as class 0", () => {
    const tally = tallyPrefixMisses([
      { cacheRead: 0 }, // class 0 — unstamped
      { ...STAMPED, prefixStable: false, prefixDivergedAt: 1 }, // class 1
      STAMPED, // class 2, unjoined
      { ...STAMPED, previousParamsHash: "0000000000000000000000000000ffff" }, // class 3
      { ...STAMPED, cacheRead: 97076 }, // not a miss — joins no class
    ]);

    expect(tally.classes, "one class per miss row, and class 0 counted from the unstamped row").toEqual({
      0: 1,
      1: 1,
      2: 1,
      3: 1,
    });
    expect(tally.unjoinedClass2).toBe(1);
  });
});
