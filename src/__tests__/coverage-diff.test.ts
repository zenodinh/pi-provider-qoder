/**
 * Behavior spec for the changed-line coverage gate (scripts/coverage-diff.ts).
 *
 * Contract: of the executable lines a change adds under the gated scope
 * (`src/**` minus `__tests__` and `__fixtures__`), at least `threshold` percent
 * must have been executed by a test. Non-executable added lines (types,
 * comments, braces) are excluded from the denominator, and a changed file no
 * test ever loaded fails on its own rather than being averaged away.
 */
import { describe, expect, it } from "vitest";
import {
  compressLines,
  formatCoverageReport,
  isGatedSource,
  matchLcovFile,
  parseArgs,
  parseLcov,
  runCoverageGate,
  toRepoRelative,
} from "../../scripts/coverage-diff.ts";

const ROOT = "/repo";

function patch(file: string, addedLines: string[], startAt = 1): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startAt},0 +${startAt},${addedLines.length} @@`,
    ...addedLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

/** lcov for one file: `hits` is a sparse line→hit map. */
function lcovFor(path: string, hits: Record<number, number>): string {
  const records = Object.entries(hits).map(([line, count]) => `DA:${line},${count}`);
  return ["TN:", `SF:${path}`, ...records, "end_of_record", ""].join("\n");
}

describe("runCoverageGate", () => {
  it("fails when covered changed lines fall below the threshold", () => {
    const result = runCoverageGate({
      diffText: patch("src/protocol/queue.ts", ["export function f() {", "  return 1;", "}"], 10),
      lcovText: lcovFor("/repo/src/protocol/queue.ts", { 10: 3, 11: 3, 12: 0 }),
      threshold: 80,
      root: ROOT,
    });
    // Line 12 (the closing brace) has a DA record with 0 hits, so it counts.
    expect(result.changedExecutable).toBe(3);
    expect(result.covered).toBe(2);
    expect(result.percent).toBeCloseTo(66.7, 1);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("below the 80% threshold");
  });

  it("reports 100% and passes when every executable changed line ran", () => {
    const result = runCoverageGate({
      diffText: patch("src/a.ts", ["const x = 1;", "const y = 2;"], 5),
      lcovText: lcovFor("/repo/src/a.ts", { 5: 1, 6: 4 }),
      threshold: 80,
      root: ROOT,
    });
    expect(result.percent).toBe(100);
    expect(result.pass).toBe(true);
    expect(result.rows[0].uncoveredLines).toEqual([]);
  });

  it("excludes non-executable changed lines from the denominator", () => {
    const result = runCoverageGate({
      diffText: patch("src/a.ts", ["/** doc */", "export interface Q {", "  id: string;", "}", "const real = 1;"], 1),
      lcovText: lcovFor("/repo/src/a.ts", { 5: 2 }),
      threshold: 80,
      root: ROOT,
    });
    expect(result.rows[0].changedExecutable).toBe(1);
    expect(result.rows[0].uninstrumented).toBe(4);
    expect(result.percent).toBe(100);
    expect(result.pass).toBe(true);
  });

  it("fails a changed file that no test ever loaded, without averaging it away", () => {
    const result = runCoverageGate({
      diffText: patch("src/brand-new.ts", ["export const x = 1;"], 1),
      lcovText: lcovFor("/repo/src/other.ts", { 1: 1 }),
      threshold: 80,
      root: ROOT,
    });
    expect(result.rows[0].missingFromReport).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toContain("no test loaded it");
  });

  it("passes with a null percentage when no gated source changed", () => {
    const result = runCoverageGate({
      diffText: [patch("README.md", ["docs"], 1), patch("src/__tests__/a.test.ts", ["it('x', () => {});"], 1)].join(
        "\n",
      ),
      lcovText: lcovFor("/repo/src/a.ts", { 1: 1 }),
      threshold: 80,
      root: ROOT,
    });
    expect(result.percent).toBeNull();
    expect(result.pass).toBe(true);
    expect(result.rows).toEqual([]);
  });

  it("ignores deletions and uncovered lines are listed for the CI log", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const x = 1;",
      "",
      patch("src/kept.ts", ["const a = 1;", "const b = 2;", "const c = 3;"], 20),
    ].join("\n");
    const result = runCoverageGate({
      diffText: diff,
      lcovText: lcovFor("/repo/src/kept.ts", { 20: 1, 21: 0, 22: 5 }),
      threshold: 60,
      root: ROOT,
    });
    expect(result.rows.map((row) => row.path)).toEqual(["src/kept.ts"]);
    expect(result.rows[0].uncoveredLines).toEqual([21]);
    expect(result.percent).toBeCloseTo(66.7, 1);
    expect(result.pass).toBe(true);
  });

  it("renders the RESULT contract line the CI step greps", () => {
    const pass = runCoverageGate({
      diffText: patch("src/a.ts", ["const x = 1;"], 1),
      lcovText: lcovFor("/repo/src/a.ts", { 1: 1 }),
      threshold: 80,
      root: ROOT,
    });
    expect(formatCoverageReport(pass, ["src/a.ts"]).split("\n").at(-1)).toBe("RESULT: PASS");
    const fail = runCoverageGate({
      diffText: patch("src/a.ts", ["const x = 1;"], 1),
      lcovText: lcovFor("/repo/src/a.ts", { 1: 0 }),
      threshold: 80,
      root: ROOT,
    });
    expect(formatCoverageReport(fail, ["src/a.ts"]).split("\n").at(-1)).toBe("RESULT: FAIL");
    expect(formatCoverageReport(fail, ["src/a.ts"])).toContain("uncovered: 1");
  });
});

describe("coverage gate helpers", () => {
  it("gates src/** but not its tests or fixtures, and not dev tooling", () => {
    expect(isGatedSource("src/index.ts")).toBe(true);
    expect(isGatedSource("src/protocol/stream.ts")).toBe(true);
    expect(isGatedSource("src/__tests__/stream.test.ts")).toBe(false);
    expect(isGatedSource("src/__fixtures__/live/chat.json")).toBe(false);
    expect(isGatedSource("scripts/security-scan.ts")).toBe(false);
    expect(isGatedSource("README.md")).toBe(false);
  });

  it("parses lcov, keeps the higher count on duplicate DA records, and skips malformed ones", () => {
    const text = [
      "SF:/repo/src/a.ts",
      "DA:1,0",
      "DA:1,4",
      "DA:not-a-number,3",
      "DA:3",
      "LF:2",
      "LH:1",
      "end_of_record",
      "",
    ].join("\n");
    const files = parseLcov(text);
    expect(files).toHaveLength(1);
    expect(files[0].lines.get(1)).toBe(4);
    expect(files[0].lines.has(3)).toBe(false);
  });

  it("matches absolute SF paths to repo-relative diff paths", () => {
    const files = parseLcov(
      ["SF:/repo/src/a.ts", "DA:1,1", "end_of_record", "SF:/elsewhere/src/a.ts", "DA:1,1", "end_of_record", ""].join(
        "\n",
      ),
    );
    expect(matchLcovFile("src/a.ts", files, ROOT)?.path).toBe("/repo/src/a.ts");
    // Two suffix candidates: refuse to guess.
    expect(matchLcovFile("src/a.ts", [files[0], files[1]], "/neither")).toBeUndefined();
    expect(toRepoRelative("/repo/src/a.ts", ROOT)).toBe("src/a.ts");
    expect(toRepoRelative("./src/a.ts", ROOT)).toBe("src/a.ts");
  });

  it("compresses line lists into ranges", () => {
    expect(compressLines([12, 13, 14, 20, 21, 9])).toBe("9, 12-14, 20-21");
    expect(compressLines([7])).toBe("7");
  });

  it("validates argv at the boundary", () => {
    expect(parseArgs(["--diff", "p.diff"])).toEqual({
      diff: "p.diff",
      lcov: "coverage/lcov.info",
      threshold: 80,
      reportOnly: false,
    });
    expect(parseArgs(["--diff", "p.diff", "--threshold", "65", "--report-only"])).toMatchObject({
      threshold: 65,
      reportOnly: true,
    });
    expect(() => parseArgs([])).toThrow(/--diff/);
    expect(() => parseArgs(["--diff", "p.diff", "--threshold", "150"])).toThrow(/between 0 and 100/);
    expect(() => parseArgs(["--diff", "p.diff", "--nope", "x"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--diff"])).toThrow(/missing value/);
  });
});
