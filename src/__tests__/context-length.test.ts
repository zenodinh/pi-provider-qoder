import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveContextLength } from "../protocol/context-length.js";

/**
 * Spec fs-qoder-context-window-plan CU-01 (T-01) and CU-04 (T-05).
 *
 * T-01 pins the moved resolver's every branch against v2's pre-move behavior:
 * the tiers literal mirrors the catalog shape v2.test.ts's seedCatalogWithTiers
 * writes (200K default + 400K + 1M), so the rows and the wire capture agree on
 * one fixture set. T-05 pins the structural property AC-06 names — one
 * definition, no adapter-local resolution — against the source text, the way
 * retry-docs.test.ts asserts a documentation claim.
 */

// invented: mirrors QoderModelEntry.context_config's shape and the tier set the
// v2 wire-capture fixture seeds (200K is_default, 400K, 1M) — same tiers so the
// unit rows and the wire rows cannot disagree about what "the catalog" holds.
const TIERS = {
  "200K": { token_count: 200_000, is_default: true },
  "400K": { token_count: 400_000 },
  "1M": { token_count: 1_000_000 },
} as const;

describe("resolveContextLength (spec CU-01, T-01/AC-01, AC-04)", () => {
  it("returns the requested window when it matches a catalog tier", () => {
    expect(resolveContextLength(TIERS, 1_000_000)).toBe(1_000_000);
    expect(resolveContextLength(TIERS, 400_000)).toBe(400_000);
    expect(resolveContextLength(TIERS, 200_000)).toBe(200_000);
  });

  it("returns the is_default tier for a window matching no tier, never the largest", () => {
    // AC-03: v2.test.ts:296 pins 200000 for a mismatched 123456 override.
    expect(resolveContextLength(TIERS, 123_456)).toBe(200_000);
  });

  it("returns undefined when no tier is marked default and the window matches none", () => {
    const noDefault = {
      "200K": { token_count: 200_000 },
      "1M": { token_count: 1_000_000 },
    } as const;
    expect(resolveContextLength(noDefault, 123_456)).toBeUndefined();
  });

  it("returns undefined when the requested window is absent", () => {
    expect(resolveContextLength(TIERS, undefined)).toBeUndefined();
  });

  it("returns the requested value unchanged when there is no tier table", () => {
    // An entry with no context_config: the model's window governs as-is.
    expect(resolveContextLength(undefined, 123_456)).toBe(123_456);
    expect(resolveContextLength({}, 123_456)).toBe(123_456);
  });

  it("ignores non-finite token counts when matching", () => {
    const malformed = {
      "200K": { token_count: 200_000 },
      bad: { token_count: Number.NaN },
    } as const;
    // A NaN window is not a tier, so the match fails and — with no default
    // marked — the field is omitted rather than sent as a non-finite number.
    expect(resolveContextLength(malformed, 123_456)).toBeUndefined();
    expect(resolveContextLength(malformed, Number.NaN)).toBeUndefined();
  });
});

describe("one producer, two readers (spec CU-04, T-05/AC-06)", () => {
  it("the repo source contains exactly one resolveContextLength definition, in context-length.ts", () => {
    const files = ["plan", "router", "v2", "stream", "session-key", "wire-compat"].map(
      (name) => `../protocol/${name}.ts`,
    );
    for (const file of files) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, `${file} must not define its own resolver`).not.toMatch(/function\s+resolveContextLength/);
    }
    const shared = readFileSync(fileURLToPath(new URL("../protocol/context-length.ts", import.meta.url)), "utf8");
    expect(shared).toMatch(/export function resolveContextLength/);
  });

  it("no adapter computes a context tier inline from context_config", () => {
    // Legacy must hold no tier logic at all: its future emission (wave 5) reads
    // the plan's contextLength, never the tier table.
    const legacy = readFileSync(fileURLToPath(new URL("../protocol/stream.ts", import.meta.url)), "utf8");
    expect(legacy.match(/context_config|contextWindow/g) ?? []).toHaveLength(0);

    // v2's single context_config read is the gate-off fallback calling the
    // shared resolver — the plan-or-identical-inline posture, not a second
    // resolution.
    const v2 = readFileSync(fileURLToPath(new URL("../protocol/v2.ts", import.meta.url)), "utf8");
    expect(v2.match(/context_config/g) ?? []).toHaveLength(1);
    expect(v2).toContain("plan?.contextLength ?? resolveContextLength(route.modelConfig.context_config");
  });
});
