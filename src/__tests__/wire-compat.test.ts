import { describe, expect, it, vi } from "vitest";
import {
  affinityPlacements,
  carrierValue,
  isWireCompatData,
  legacyAffinityCutoverLive,
  QODER_WIRE_COMPAT,
  type QoderWireCompatData,
  type WireCarrier,
} from "../protocol/wire-compat.js";

/**
 * Spec `fs-qoder-wire-compat-table`, T-01..T-07.
 *
 * The module is a frozen literal plus a syntactic guard and two pure accessors,
 * so these rows pin its shape and coverage rather than a collaborator: every
 * per-protocol DATA divergence carries both carriers, a malformed or nested-map
 * row is rejected wholesale, and no file on disk can change the table.
 */

// The fs spies are hoisted so the vi.mock factory below can reference them; the
// mock replaces node:fs for this file's module graph, so a future user-override
// read inside wire-compat.ts would be recorded here as a call.
const fsSpies = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: fsSpies.existsSync, readFileSync: fsSpies.readFileSync };
});

const CARRIERS: readonly WireCarrier[] = ["legacy", "v2"];

// The set of array rows the guard checks one by one; T-04 mutates every one.
const ARRAY_ROWS = [
  "sessionKeyBoundPolicy",
  "osVocabulary",
  "affinityPlacement",
  "affinityPlacementGated",
  "contextLengthEmission",
  "contextLengthEmissionGated",
  "enableThinkingPath",
  "systemSlot",
  "businessLifecycle",
] as const satisfies readonly (keyof QoderWireCompatData)[];

// The seven rows carrying a per-protocol divergence. affinityPlacementGated is
// deliberately legacy-only (the CU-7 gate) and fallbackScope is one process-wide
// value, so neither belongs in the both-carriers assertion.
const PER_PROTOCOL_ROWS = [
  "sessionKeyBoundPolicy",
  "osVocabulary",
  "affinityPlacement",
  "contextLengthEmission",
  "enableThinkingPath",
  "systemSlot",
  "businessLifecycle",
] as const satisfies readonly (keyof QoderWireCompatData)[];

function without(key: keyof QoderWireCompatData): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...QODER_WIRE_COMPAT };
  delete copy[key];
  return copy;
}

describe("QODER_WIRE_COMPAT", () => {
  it("carries both carriers in a flat kind for every per-protocol DATA row (T-01)", () => {
    expect(QODER_WIRE_COMPAT.version).toBe(1);
    expect(QODER_WIRE_COMPAT.fallbackScope).toBe("process");

    for (const key of PER_PROTOCOL_ROWS) {
      const row = QODER_WIRE_COMPAT[key];
      expect(Array.isArray(row)).toBe(true);
      for (const carrier of CARRIERS) {
        expect(carrierValue(row, carrier), `${key} missing ${carrier}`).toBeDefined();
      }
    }

    // Flat kinds only — a nested map is the shape FR-2 names as the defect.
    for (const [key, value] of Object.entries(QODER_WIRE_COMPAT)) {
      const kind = Array.isArray(value) ? "string[]" : typeof value;
      expect(["number", "string", "boolean", "string[]"], key).toContain(kind);
      if (Array.isArray(value)) {
        expect(
          value.every((entry) => typeof entry === "string"),
          key,
        ).toBe(true);
      }
    }

    // Deep-frozen: the shipped policy is data, not mutable state.
    expect(Object.isFrozen(QODER_WIRE_COMPAT)).toBe(true);
    for (const value of Object.values(QODER_WIRE_COMPAT)) {
      if (Array.isArray(value)) expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("turns a probe verdict into a one-string data move between rows (T-02)", () => {
    expect(affinityPlacements("legacy")).toEqual(["session_id"]);
    // fs-qoder-legacy-affinity CU-01 / T-01: both probe-pending legacy carriers
    // — the prompt_cache_key body field and the unsigned header trio — sit in
    // the gated row, out of the live set, until each is individually promoted.
    expect(QODER_WIRE_COMPAT.affinityPlacementGated).toEqual(["legacy:prompt_cache_key", "legacy:header-x-session-id"]);

    // The CU-7 verdict arrives as data: move one string into the live row on a
    // clone — the frozen export must never be mutated by the test. Either
    // carrier promotes on its own, which is the point of per-field verdicts.
    const moved = structuredClone(QODER_WIRE_COMPAT);
    moved.affinityPlacement.push("legacy:prompt_cache_key");
    moved.affinityPlacementGated = moved.affinityPlacementGated.filter((entry) => entry !== "legacy:prompt_cache_key");
    expect(affinityPlacements("legacy", moved)).toEqual(["session_id", "prompt_cache_key"]);

    const movedTrio = structuredClone(QODER_WIRE_COMPAT);
    movedTrio.affinityPlacement.push("legacy:header-x-session-id");
    movedTrio.affinityPlacementGated = movedTrio.affinityPlacementGated.filter(
      (entry) => entry !== "legacy:header-x-session-id",
    );
    expect(affinityPlacements("legacy", movedTrio)).toEqual(["session_id", "header-x-session-id"]);

    // The move is legacy-scoped: v2's live placements are untouched.
    expect(affinityPlacements("v2", moved)).toEqual(affinityPlacements("v2"));
    // With the module source unchanged, the shipped table still emits session_id alone.
    expect(affinityPlacements("legacy")).toEqual(["session_id"]);
  });
});

describe("legacyAffinityCutoverLive", () => {
  // fs-qoder-legacy-affinity CU-06's guard: a reset fires only when a
  // placement BEYOND the identity baseline is live. session_id has always
  // been live — it is not a change — so the shipped build resets nothing and
  // the literal reading of "any placement live" would delete every learned
  // profile at every session start.
  it("is false on the shipped table and true only when a placement beyond the identity baseline is live", () => {
    expect(legacyAffinityCutoverLive()).toBe(false);

    const baselineOnly = structuredClone(QODER_WIRE_COMPAT);
    baselineOnly.affinityPlacement = ["legacy:session_id"];
    expect(legacyAffinityCutoverLive(baselineOnly)).toBe(false);

    for (const carrier of ["prompt_cache_key", "header-x-session-id"]) {
      const promoted = structuredClone(QODER_WIRE_COMPAT);
      promoted.affinityPlacement.push(`legacy:${carrier}`);
      promoted.affinityPlacementGated = promoted.affinityPlacementGated.filter(
        (entry) => entry !== `legacy:${carrier}`,
      );
      expect(legacyAffinityCutoverLive(promoted), `${carrier} promoted is a cutover`).toBe(true);
    }
  });
});

describe("isWireCompatData", () => {
  it("accepts the shipped table and rejects malformed shapes wholesale (T-04)", () => {
    expect(isWireCompatData(QODER_WIRE_COMPAT)).toBe(true);

    const malformed: [string, unknown][] = [
      ["null", null],
      ["a primitive", "not-a-table"],
      ["a missing version", without("version")],
      ["a non-number version", { ...QODER_WIRE_COMPAT, version: "1" }],
      ["a missing fallbackScope", without("fallbackScope")],
      ["a non-string fallbackScope", { ...QODER_WIRE_COMPAT, fallbackScope: 1 }],
      ["a missing row", without("businessLifecycle")],
      ["a partially malformed table", { ...QODER_WIRE_COMPAT, affinityPlacement: null }],
    ];
    // The guard checks each array row the same way, so each row gets both a
    // non-array mutation and a non-string-entry mutation — no guard line untested.
    for (const row of ARRAY_ROWS) {
      malformed.push([`${row} as a non-array`, { ...QODER_WIRE_COMPAT, [row]: "legacy:none" }]);
      malformed.push([`${row} holding a non-string entry`, { ...QODER_WIRE_COMPAT, [row]: ["ok", 7] }]);
    }
    for (const [label, value] of malformed) {
      expect(isWireCompatData(value), label).toBe(false);
    }
  });

  it("rejects a nested-map row by the same rule, with no special case (T-05)", () => {
    const nestedMap: unknown = {
      ...structuredClone(QODER_WIRE_COMPAT),
      sessionKeyBoundPolicy: { legacy: "hash", v2: "clamp" },
    };
    expect(isWireCompatData(nestedMap)).toBe(false);
  });

  it("lets a well-formed but typo'd carrier entry pass and surface as undefined (T-06)", () => {
    const typo = structuredClone(QODER_WIRE_COMPAT);
    typo.sessionKeyBoundPolicy = ["legac:hash", "v2:clamp"];

    expect(isWireCompatData(typo)).toBe(true);
    expect(carrierValue(typo.sessionKeyBoundPolicy, "legacy")).toBeUndefined();
  });
});

describe("carrierValue", () => {
  it("strips the carrier prefix, never invents a value, and skips colon-less entries (T-07)", () => {
    expect(carrierValue(["legacy:hash", "v2:clamp"], "legacy")).toBe("hash");
    expect(carrierValue(["legacy:hash", "v2:clamp"], "v2")).toBe("clamp");
    expect(carrierValue(["legacy:hash"], "v2")).toBeUndefined();
    expect(carrierValue(["no-colon-here", "v2:clamp"], "legacy")).toBeUndefined();
    expect(carrierValue([], "legacy")).toBeUndefined();
    // The prefix is stripped once at the first separator, so a value may contain a colon.
    expect(carrierValue(["v2:a:b"], "v2")).toBe("a:b");
  });
});

describe("wire-compat is code-owned", () => {
  it("performs no filesystem read while the table and its accessors are exercised (T-03)", () => {
    expect(isWireCompatData(QODER_WIRE_COMPAT)).toBe(true);
    expect(carrierValue(QODER_WIRE_COMPAT.affinityPlacement, "v2")).toBeDefined();
    expect(affinityPlacements("legacy")).toEqual(["session_id"]);
    for (const key of PER_PROTOCOL_ROWS) carrierValue(QODER_WIRE_COMPAT[key], "v2");

    expect(fsSpies.existsSync).not.toHaveBeenCalled();
    expect(fsSpies.readFileSync).not.toHaveBeenCalled();
  });
});

/**
 * Spec fs-qoder-legacy-context-length T-01 (AC-02, AC-05): the context-tier
 * emission posture. The owner promoted the legacy top-level number on
 * 2026-10-04, so the live row carries it and the gated row ships empty — the
 * retained mechanism for a future placement form, moved between rows as a
 * data edit with no adapter change.
 */
describe("contextLengthEmission posture (fs-qoder-legacy-context-length)", () => {
  it("ships the legacy tier promoted, holds the gated row empty, and demotes by data alone (T-01)", () => {
    expect(QODER_WIRE_COMPAT.contextLengthEmission).toEqual(["legacy:top-level-number", "v2:both"]);
    expect(QODER_WIRE_COMPAT.contextLengthEmissionGated).toEqual([]);
    expect(carrierValue(QODER_WIRE_COMPAT.contextLengthEmission, "legacy")).toBe("top-level-number");
    expect(carrierValue(QODER_WIRE_COMPAT.contextLengthEmission, "v2")).toBe("both");

    // Demotion is a one-string data move on a clone — never a mutation of the
    // frozen export — and it empties the live legacy value with no code change.
    const demoted = structuredClone(QODER_WIRE_COMPAT);
    demoted.contextLengthEmission = demoted.contextLengthEmission.filter(
      (entry) => entry !== "legacy:top-level-number",
    );
    demoted.contextLengthEmissionGated = ["legacy:top-level-number"];
    expect(carrierValue(demoted.contextLengthEmission, "legacy")).toBeUndefined();
    // The demotion is legacy-scoped: v2's entry is untouched.
    expect(carrierValue(demoted.contextLengthEmission, "v2")).toBe("both");
    // The clone's move left the shipped table promoted.
    expect(carrierValue(QODER_WIRE_COMPAT.contextLengthEmission, "legacy")).toBe("top-level-number");
  });

  it("rejects a table missing the gated row wholesale (T-01 / AC-05)", () => {
    expect(isWireCompatData(QODER_WIRE_COMPAT)).toBe(true);
    expect(isWireCompatData(without("contextLengthEmissionGated"))).toBe(false);
  });
});
