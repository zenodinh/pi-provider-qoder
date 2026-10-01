/**
 * Changed-line ("diff") coverage gate.
 *
 * Total-project coverage is the wrong gate for a repo that already ships
 * untested corners: it either starts red and gets ignored, or it lets a large
 * new module ride in on the existing average. This gate asks the only question
 * a reviewer cannot answer by eye — *of the executable lines this change adds,
 * how many did a test actually run?* — and fails below a threshold (default
 * 80%).
 *
 * Inputs are files, not subprocesses: CI produces the diff with git and the
 * report with `vitest run --coverage`, so this module stays pure text-in /
 * verdict-out and testable without a repository.
 *
 * Scope is the published artifact (`src/**`, excluding tests and fixtures —
 * `package.json` ships `files: ["src", "README.md"]`). Dev tooling under
 * `scripts/` is deliberately out of scope: it never runs inside a user's pi.
 */
// shape: pure function module + thin CLI — trigger #1 (stateless transforms,
//   one input shape → one verdict); `main` only reads files and maps the
//   verdict to an exit code.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { changedPaths, parseUnifiedDiff } from "./diff.ts";

/** One file record of an lcov report. */
export interface LcovFile {
  /** Path exactly as the `SF:` record states it (usually absolute). */
  path: string;
  /** line number → hit count. Lines absent here are not executable. */
  lines: Map<number, number>;
}

export interface CoverageFileRow {
  path: string;
  /** Changed lines the report considers executable. */
  changedExecutable: number;
  covered: number;
  /** Executable changed lines with zero hits (1-based, ascending). */
  uncoveredLines: number[];
  /** Changed lines with no instrumentation record (types, comments, blanks). */
  uninstrumented: number;
  /** True when the file changed but no test ever loaded it. */
  missingFromReport: boolean;
}

export interface CoverageGateResult {
  rows: CoverageFileRow[];
  changedExecutable: number;
  covered: number;
  /** Percentage of changed executable lines covered; null when there are none. */
  percent: number | null;
  threshold: number;
  pass: boolean;
  reasons: string[];
}

export interface CoverageGateInput {
  diffText: string;
  lcovText: string;
  threshold: number;
  /** Repo root the diff paths are relative to; used to relativize `SF:` paths. */
  root?: string;
}

/** The published artifact: `src/**` minus its tests and recorded fixtures. */
const GATED_SOURCE = /^src\/.+\.ts$/;
const GATE_EXCLUDED = /^src\/(?:__tests__|__fixtures__)\//;

export function isGatedSource(path: string): boolean {
  return GATED_SOURCE.test(path) && !GATE_EXCLUDED.test(path);
}

/** Normalize any path form to a repo-relative POSIX path. */
export function toRepoRelative(path: string, root: string): string {
  const posix = path.replaceAll(sep, "/");
  if (!isAbsolute(posix)) return posix.replace(/^\.\//, "");
  const rel = relative(root.replaceAll(sep, "/"), posix);
  return rel.startsWith("..") ? posix.replace(/^\//, "") : rel;
}

/**
 * Parse an lcov report. Only `SF:` / `DA:` / `end_of_record` records are read;
 * anything malformed is skipped rather than guessed at, because a wrong hit
 * count would flip the gate.
 */
export function parseLcov(text: string): LcovFile[] {
  const files: LcovFile[] = [];
  let current: LcovFile | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = { path: line.slice(3), lines: new Map() };
      files.push(current);
      continue;
    }
    if (line === "end_of_record") {
      current = undefined;
      continue;
    }
    if (current === undefined || !line.startsWith("DA:")) continue;
    const [lineNo, hits] = line.slice(3).split(",");
    const no = Number.parseInt(lineNo ?? "", 10);
    const hit = Number.parseInt(hits ?? "", 10);
    if (!Number.isInteger(no) || no < 1 || !Number.isInteger(hit)) continue;
    // A line reported twice keeps the higher count (merged records).
    current.lines.set(no, Math.max(hit, current.lines.get(no) ?? 0));
  }

  return files;
}

/** Find the report record for a diff path: exact repo-relative match first,
 * then a unique `/`-suffixed match (absolute `SF:` paths outside `root`). */
export function matchLcovFile(diffPath: string, lcovFiles: readonly LcovFile[], root: string): LcovFile | undefined {
  const wanted = toRepoRelative(diffPath, root);
  const exact = lcovFiles.find((file) => toRepoRelative(file.path, root) === wanted);
  if (exact) return exact;
  const suffix = `/${wanted}`;
  const candidates = lcovFiles.filter((file) => file.path.replaceAll(sep, "/").endsWith(suffix));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The gate itself: pure, so CI and the tests run the identical code path. */
export function runCoverageGate(input: CoverageGateInput): CoverageGateResult {
  const root = input.root ?? process.cwd();
  const lcovFiles = parseLcov(input.lcovText);
  const rows: CoverageFileRow[] = [];
  const reasons: string[] = [];
  let changedExecutable = 0;
  let covered = 0;

  for (const file of parseUnifiedDiff(input.diffText)) {
    if (file.isDeleted || !isGatedSource(file.path)) continue;
    const addedNumbers = file.added.map((line) => line.no);
    if (addedNumbers.length === 0) continue;

    const record = matchLcovFile(file.path, lcovFiles, root);
    if (record === undefined) {
      rows.push({
        path: file.path,
        changedExecutable: 0,
        covered: 0,
        uncoveredLines: [],
        uninstrumented: addedNumbers.length,
        missingFromReport: true,
      });
      reasons.push(`${file.path}: changed but absent from the coverage report — no test loaded it`);
      continue;
    }

    const uncoveredLines: number[] = [];
    let fileCovered = 0;
    let executable = 0;
    for (const no of addedNumbers) {
      const hits = record.lines.get(no);
      if (hits === undefined) continue; // not executable: type, comment, brace, blank
      executable += 1;
      if (hits > 0) fileCovered += 1;
      else uncoveredLines.push(no);
    }

    changedExecutable += executable;
    covered += fileCovered;
    rows.push({
      path: file.path,
      changedExecutable: executable,
      covered: fileCovered,
      uncoveredLines,
      uninstrumented: addedNumbers.length - executable,
      missingFromReport: false,
    });
  }

  rows.sort((a, b) => a.path.localeCompare(b.path));
  const percent = changedExecutable === 0 ? null : (covered / changedExecutable) * 100;

  if (percent === null) {
    reasons.push("no gated source lines changed (src/** outside tests and fixtures)");
  } else if (percent < input.threshold) {
    reasons.push(
      `changed-line coverage ${percent.toFixed(1)}% is below the ${input.threshold}% threshold ` +
        `(${covered}/${changedExecutable} executable changed lines covered)`,
    );
  }

  return {
    rows,
    changedExecutable,
    covered,
    percent,
    threshold: input.threshold,
    pass: reasons.every((reason) => !reason.includes("below the")) && !rows.some((row) => row.missingFromReport),
    reasons,
  };
}

/** Human/CI-log rendering of the verdict. */
export function formatCoverageReport(result: CoverageGateResult, touched: readonly string[]): string {
  const lines: string[] = [];
  const headline =
    result.percent === null
      ? `Changed-line coverage: n/a (threshold ${result.threshold}%)`
      : `Changed-line coverage: ${result.percent.toFixed(1)}% (threshold ${result.threshold}%)`;
  lines.push(headline);
  lines.push(
    `${result.covered}/${result.changedExecutable} executable changed lines covered across ${result.rows.length} file(s);` +
      ` gated scope: src/** minus __tests__ and __fixtures__`,
  );

  for (const row of result.rows) {
    if (row.missingFromReport) {
      lines.push(`  MISSING  ${row.path} — not in the coverage report (no test imported it)`);
      continue;
    }
    if (row.changedExecutable === 0) {
      lines.push(`  n/a      ${row.path} — ${row.uninstrumented} changed line(s), none executable`);
      continue;
    }
    const pct = ((row.covered / row.changedExecutable) * 100).toFixed(1);
    const detail = row.uncoveredLines.length > 0 ? ` uncovered: ${compressLines(row.uncoveredLines)}` : "";
    lines.push(`  ${pct.padStart(6)}%  ${row.path} — ${row.covered}/${row.changedExecutable}${detail}`);
  }

  const untouchedGated = touched.filter((path) => isGatedSource(path));
  if (untouchedGated.length === 0) lines.push("No gated source file changed.");
  for (const reason of result.reasons) lines.push(`reason: ${reason}`);
  lines.push(result.pass ? "RESULT: PASS" : "RESULT: FAIL");
  return lines.join("\n");
}

/** `[12,13,14,20]` → `12-14, 20` for readable CI output. */
export function compressLines(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const value of sorted.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = value;
    previous = value;
  }
  if (start !== undefined) parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return parts.join(", ");
}

export interface CliOptions {
  diff: string;
  lcov: string;
  threshold: number;
  reportOnly: boolean;
}

const DEFAULT_THRESHOLD = 80;

/** boundary: argv is untrusted text → validated field by field, never cast. */
export function parseArgs(argv: readonly string[]): CliOptions {
  let diff: string | undefined;
  let lcov = "coverage/lcov.info";
  let threshold = DEFAULT_THRESHOLD;
  let reportOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--report-only") {
      reportOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    index += 1;
    if (arg === "--diff") diff = value;
    else if (arg === "--lcov") lcov = value;
    else if (arg === "--threshold") {
      const parsed = Number.parseFloat(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        throw new Error(`--threshold must be a percentage between 0 and 100, got "${value}"`);
      }
      threshold = parsed;
    } else throw new Error(`unknown argument "${arg}"`);
  }

  if (diff === undefined) throw new Error("--diff <patch-file> is required (git diff --unified=0 <base>...HEAD)");
  return { diff, lcov, threshold, reportOnly };
}

export function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const diffText = readFileSync(options.diff, "utf8");
  const lcovText = readFileSync(options.lcov, "utf8");
  const result = runCoverageGate({ diffText, lcovText, threshold: options.threshold });
  const touched = changedPaths(parseUnifiedDiff(diffText));
  console.log(formatCoverageReport(result, touched));
  if (result.pass) return 0;
  if (options.reportOnly) {
    console.log("report-only: threshold not enforced on this event");
    return 0;
  }
  return 1;
}

const invokedDirectly = process.argv[1]?.endsWith("coverage-diff.ts") === true;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
