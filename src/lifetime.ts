// shape: none — pure estimators plus validated I/O; no dispatch threshold is
//   reached. The profile path mirrors openConfigStore's file-pair precedent in
//   commands/context.ts; the estimators are straight-line math over sample
//   arrays. The one boundary (session JSONL on disk) is narrowed line by line.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_PROMPT_CACHE } from "./catalog.js";
import { debugLog } from "./debug.js";
import { getPiAgentDir } from "./home.js";
import { parseQoderCreditsUsage } from "./protocol/usage.js";

/** Extension-owned profile of per-model cache lifetimes and learned rate fits. */
export const PROFILE_FILENAME = "qoder-cache-lifetime.json";
/** Session-start scan time budget (SA §3.2 N2: <= 500 ms once per session). */
export const LEARNER_BUDGET_MS = 500;
/** A lifetime needs at least this many natural idle gaps before it may publish. */
export const MIN_NATURAL_SAMPLES = 20;
/** A rate fit needs at least this many Credit-bearing real turns. */
export const MIN_RATE_SAMPLES = 20;
/** Per-bucket publish rule: >= this many gaps and a median survival ratio >= 0.8. */
export const MIN_BUCKET_SAMPLES = 3;
export const SURVIVAL_MEDIAN = 0.8;
export const RATE_FIT_MIN_R_SQUARED = 0.95;
/** Lifetime clamp — the last line of defense against a corrupt-but-valid value. */
export const LIFETIME_MIN_SECONDS = 120;
export const LIFETIME_MAX_SECONDS = 3600;
/** Values older than this are stale; the next session start recomputes them. */
export const PROFILE_STALE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Natural-gap buckets, ascending upper bounds in seconds. Disjoint ranges: a
 * gap belongs to the first bucket whose bound it does not exceed.
 */
export const BUCKET_UPPER_BOUNDS_SECONDS = [30, 120, 300, 600, 1200, 1800, 3600] as const;

/** One survival bucket: the median cache-read share of turns after gaps this long. */
export interface LifetimeBucket {
  upperSeconds: number;
  medianRatio: number;
  samples: number;
}

/** Learned Credits-per-token form; rung 2 of the guard's rate ladder. */
export interface RateFit {
  inputCreditsPerToken: number;
  cacheReadCreditsPerToken: number;
  outputCreditsPerToken: number;
  rSquared: number;
  samples: number;
  fittedAt: string;
}

/** Published per-model estimate; `rateFit` is optional (profile version 2). */
export interface LifetimeEstimate {
  lifetimeSeconds: number;
  samples: number;
  computedAt: string;
  buckets: LifetimeBucket[];
  rateFit?: RateFit;
}

/** The profile file root; version 1 predates `rateFit` and is accepted on read. */
export interface LifetimeProfile {
  version: 1 | 2;
  updatedAt: string;
  models: Record<string, LifetimeEstimate>;
}

/** One natural idle gap: seconds since the previous same-model real turn and
 *  the cache-read share of the turn that followed it. */
export interface LedgerGap {
  seconds: number;
  ratio: number;
}

/** One Credit-bearing real turn: the observed token mix and charged Credits. */
export interface LedgerTurn {
  input: number;
  cacheRead: number;
  output: number;
  credits: number;
}

export interface LedgerModelSamples {
  gaps: LedgerGap[];
  turns: LedgerTurn[];
}

/** One bounded scan of the session ledgers, feeding both estimators. */
export interface LedgerScan {
  models: Record<string, LedgerModelSamples>;
  files: number;
  exceededBudget: boolean;
}

/** Clamp a published lifetime into the declared bounds. */
export function clampLifetimeSeconds(seconds: number): number {
  return Math.min(Math.max(seconds, LIFETIME_MIN_SECONDS), LIFETIME_MAX_SECONDS);
}

interface LedgerAssistantLine {
  kind: "assistant";
  model: string;
  timestamp: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  credits: number | undefined;
}

type LedgerLine = LedgerAssistantLine | { kind: "cache_warm" } | { kind: "context_reset" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrow one JSONL line to the facts the learner reads, or skip it. Unknown
 * fields, corrupt lines, and non-numeric token counts are dropped — a single
 * malformed row must not abort the scan (best-effort posture).
 */
function parseLedgerLine(line: string): LedgerLine | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  if (raw.type === "compaction" || raw.type === "branch_summary") return { kind: "context_reset" };
  if (raw.type === "usage" && raw.kind === "cache_warm") return { kind: "cache_warm" };
  if (raw.type !== "message" || !isRecord(raw.message)) return undefined;

  const message = raw.message;
  if (message.role !== "assistant") return undefined;
  const model = typeof message.model === "string" ? message.model : undefined;
  const timestamp = finiteNumber(message.timestamp);
  if (model === undefined || timestamp === undefined || !isRecord(message.usage)) return undefined;

  const usage = message.usage;
  const input = tokenCount(usage.input);
  const cacheRead = tokenCount(usage.cacheRead);
  const cacheWrite = tokenCount(usage.cacheWrite);
  const output = tokenCount(usage.output);
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined || output === undefined) {
    return undefined;
  }
  return {
    kind: "assistant",
    model,
    timestamp,
    input,
    cacheRead,
    cacheWrite,
    output,
    credits: parseQoderCreditsUsage(usage).credits,
  };
}

function samplesFor(scan: LedgerScan, model: string): LedgerModelSamples {
  let samples = scan.models[model];
  if (samples === undefined) {
    samples = { gaps: [], turns: [] };
    scan.models[model] = samples;
  }
  return samples;
}

/**
 * Walk one session file. A natural gap is a pair of consecutive same-model
 * real turns with no `cache_warm` row and no compaction between them; the
 * later turn's cache-read share measures whether the earlier prompt survived.
 * Warm rows and context resets break a gap — they stop measuring natural
 * survival (a refresh resets the very clock it would be measuring).
 */
function scanSessionText(text: string, scan: LedgerScan, budget: { startedAt: number; budgetMs: number }): void {
  let previous: { model: string; timestamp: number } | undefined;
  let broken = false;
  let linesSinceCheck = 0;
  for (const line of text.split("\n")) {
    linesSinceCheck += 1;
    if (linesSinceCheck >= 512) {
      linesSinceCheck = 0;
      if (Date.now() - budget.startedAt > budget.budgetMs) {
        scan.exceededBudget = true;
        return;
      }
    }
    if (line.trim() === "") continue;
    const entry = parseLedgerLine(line);
    if (entry === undefined) continue;
    if (entry.kind === "context_reset") {
      previous = undefined;
      broken = true;
      continue;
    }
    if (entry.kind === "cache_warm") {
      broken = true;
      continue;
    }

    const promptTokens = entry.input + entry.cacheRead + entry.cacheWrite;
    if (previous !== undefined && previous.model === entry.model && !broken) {
      const seconds = (entry.timestamp - previous.timestamp) / 1000;
      if (seconds > 0 && promptTokens > 0) {
        samplesFor(scan, entry.model).gaps.push({ seconds, ratio: entry.cacheRead / promptTokens });
      }
    }
    if (entry.credits !== undefined) {
      samplesFor(scan, entry.model).turns.push({
        input: entry.input,
        cacheRead: entry.cacheRead,
        output: entry.output,
        credits: entry.credits,
      });
    }
    previous = { model: entry.model, timestamp: entry.timestamp };
    broken = false;
  }
}

/** Newest-first session files under `root/<encoded-cwd>/*.jsonl`. */
function collectLedgerFiles(roots: readonly string[]): string[] {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dirent of readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const dir = join(root, dirent.name);
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        try {
          found.push({ path, mtimeMs: statSync(path).mtimeMs });
        } catch {
          // Unreadable file: skip it, the scan is best-effort.
        }
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.map((file) => file.path);
}

/**
 * Bounded read of the session ledgers feeding both estimators. Stops at the
 * first file that would exceed `budgetMs` (checked between files and every
 * 512 lines inside one); a truncated scan keeps what it already read.
 */
export function scanLedgers(budgetMs: number = LEARNER_BUDGET_MS, dirs?: readonly string[]): LedgerScan {
  const roots = dirs ?? [join(getPiAgentDir(), "sessions")];
  const startedAt = Date.now();
  const scan: LedgerScan = { models: {}, files: 0, exceededBudget: false };
  for (const file of collectLedgerFiles(roots)) {
    if (Date.now() - startedAt > budgetMs) {
      scan.exceededBudget = true;
      break;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      debugLog(`cache-lifetime scan skipped unreadable ledger ${file}`, error);
      continue;
    }
    scanSessionText(text, scan, { startedAt, budgetMs });
    scan.files += 1;
    if (scan.exceededBudget) break;
  }
  return scan;
}

/** Median of an ascending-sorted non-empty array. */
function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface LifetimeEstimateResult {
  lifetimeSeconds?: number;
  samples: number;
  buckets: LifetimeBucket[];
}

/**
 * Publish rule: >= 20 natural samples; the lifetime is the largest bucket
 * boundary whose median survival ratio holds >= 0.8 with >= 3 samples, clamped
 * to 120-3600 s. A sparse or fast-decaying model publishes nothing.
 */
export function estimate(gaps: readonly LedgerGap[]): LifetimeEstimateResult {
  const buckets: LifetimeBucket[] = [];
  for (let index = 0; index < BUCKET_UPPER_BOUNDS_SECONDS.length; index += 1) {
    const upperSeconds = BUCKET_UPPER_BOUNDS_SECONDS[index];
    const lowerSeconds = index === 0 ? 0 : BUCKET_UPPER_BOUNDS_SECONDS[index - 1];
    const ratios = gaps
      .filter((gap) => gap.seconds > lowerSeconds && gap.seconds <= upperSeconds)
      .map((gap) => gap.ratio)
      .sort((a, b) => a - b);
    if (ratios.length === 0) continue;
    buckets.push({ upperSeconds, medianRatio: median(ratios), samples: ratios.length });
  }

  const samples = gaps.length;
  const qualifying = buckets.filter(
    (bucket) => bucket.samples >= MIN_BUCKET_SAMPLES && bucket.medianRatio >= SURVIVAL_MEDIAN,
  );
  if (samples < MIN_NATURAL_SAMPLES || qualifying.length === 0) {
    return { samples, buckets };
  }
  const largest = qualifying[qualifying.length - 1].upperSeconds;
  return { lifetimeSeconds: clampLifetimeSeconds(largest), samples, buckets };
}

/** Solve a 3x3 linear system by Gauss-Jordan with partial pivoting; undefined when singular. */
function solve3(matrix: readonly number[][], rhs: readonly number[]): [number, number, number] | undefined {
  const m = matrix.map((row, index) => [...row, rhs[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(m[row][column]) > Math.abs(m[pivot][column])) pivot = row;
    }
    if (Math.abs(m[pivot][column]) < 1e-12) return undefined;
    [m[column], m[pivot]] = [m[pivot], m[column]];
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = m[row][column] / m[column][column];
      for (let k = column; k < 4; k += 1) m[row][k] -= factor * m[column][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

export interface RateFitResult {
  rateFit?: RateFit;
}

/**
 * Publish rule: >= 20 Credit-bearing real turns and a least-squares fit of
 * `credits` against (input, cacheRead, output) through the origin at
 * R^2 >= 0.95 with non-negative coefficients. A mixed-upstream alias fails the
 * gate by design and publishes nothing — a blended form would price the
 * guard's cap wrong in both directions.
 */
export function fitRates(turns: readonly LedgerTurn[]): RateFitResult {
  if (turns.length < MIN_RATE_SAMPLES) return {};

  const xtx = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const xty = [0, 0, 0];
  for (const turn of turns) {
    const x = [turn.input, turn.cacheRead, turn.output];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) xtx[i][j] += x[i] * x[j];
      xty[i] += x[i] * turn.credits;
    }
  }

  const beta = solve3(xtx, xty);
  if (beta === undefined || beta.some((coefficient) => !Number.isFinite(coefficient) || coefficient < 0)) return {};

  let sumCredits = 0;
  for (const turn of turns) sumCredits += turn.credits;
  const meanCredits = sumCredits / turns.length;
  let sumSquaresResidual = 0;
  let sumSquaresTotal = 0;
  for (const turn of turns) {
    const predicted = beta[0] * turn.input + beta[1] * turn.cacheRead + beta[2] * turn.output;
    sumSquaresResidual += (turn.credits - predicted) ** 2;
    sumSquaresTotal += (turn.credits - meanCredits) ** 2;
  }
  const rSquared = sumSquaresTotal > 0 ? 1 - sumSquaresResidual / sumSquaresTotal : sumSquaresResidual === 0 ? 1 : 0;
  if (!Number.isFinite(rSquared) || rSquared < RATE_FIT_MIN_R_SQUARED) return {};

  return {
    rateFit: {
      inputCreditsPerToken: beta[0],
      cacheReadCreditsPerToken: beta[1],
      outputCreditsPerToken: beta[2],
      rSquared,
      samples: turns.length,
      fittedAt: new Date().toISOString(),
    },
  };
}

/**
 * Compose one profile from a scan, carrying prior values forward where this
 * scan cannot publish (a thin session must not erase a valid earlier
 * estimate; the next sufficient scan recomputes it).
 */
export function learnProfile(
  scan: LedgerScan,
  prior: LifetimeProfile | undefined,
  now: Date = new Date(),
): LifetimeProfile {
  const computedAt = now.toISOString();
  const models: Record<string, LifetimeEstimate> = {};
  for (const [model, samples] of Object.entries(scan.models)) {
    const estimateResult = estimate(samples.gaps);
    const { rateFit } = fitRates(samples.turns);
    const priorEntry = prior?.models[model];
    const publishedLifetime = estimateResult.lifetimeSeconds;
    const carriedLifetime = priorEntry?.lifetimeSeconds;
    if (publishedLifetime === undefined && rateFit === undefined && carriedLifetime === undefined) continue;

    models[model] = {
      lifetimeSeconds: clampLifetimeSeconds(publishedLifetime ?? carriedLifetime ?? MODEL_PROMPT_CACHE.short ?? 300),
      samples:
        publishedLifetime !== undefined ? estimateResult.samples : (priorEntry?.samples ?? estimateResult.samples),
      computedAt: publishedLifetime !== undefined ? computedAt : (priorEntry?.computedAt ?? computedAt),
      buckets:
        publishedLifetime !== undefined ? estimateResult.buckets : (priorEntry?.buckets ?? estimateResult.buckets),
      ...((rateFit ?? priorEntry?.rateFit) ? { rateFit: rateFit ?? priorEntry?.rateFit } : {}),
    };
  }
  return { version: 2, updatedAt: computedAt, models };
}

/** True when the values registration and the guard read actually moved. */
export function profileValuesChanged(prior: LifetimeProfile | undefined, next: LifetimeProfile): boolean {
  if (prior === undefined) return Object.keys(next.models).length > 0;
  const priorIds = Object.keys(prior.models);
  const nextIds = Object.keys(next.models);
  if (priorIds.length !== nextIds.length) return true;
  for (const id of nextIds) {
    const before = prior.models[id];
    const after = next.models[id];
    if (before === undefined) return true;
    if (before.lifetimeSeconds !== after.lifetimeSeconds) return true;
    if ((before.rateFit === undefined) !== (after.rateFit === undefined)) return true;
    if (
      before.rateFit !== undefined &&
      after.rateFit !== undefined &&
      (before.rateFit.inputCreditsPerToken !== after.rateFit.inputCreditsPerToken ||
        before.rateFit.cacheReadCreditsPerToken !== after.rateFit.cacheReadCreditsPerToken ||
        before.rateFit.outputCreditsPerToken !== after.rateFit.outputCreditsPerToken)
    ) {
      return true;
    }
  }
  return false;
}

function parseBuckets(value: unknown): LifetimeBucket[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const buckets: LifetimeBucket[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const upperSeconds = finiteNumber(item.upperSeconds);
    const medianRatio = finiteNumber(item.medianRatio);
    const samples = finiteNumber(item.samples);
    if (upperSeconds === undefined || medianRatio === undefined || samples === undefined) return undefined;
    buckets.push({ upperSeconds, medianRatio, samples });
  }
  return buckets;
}

function parseRateFit(value: unknown): RateFit | undefined {
  if (!isRecord(value)) return undefined;
  const inputCreditsPerToken = finiteNumber(value.inputCreditsPerToken);
  const cacheReadCreditsPerToken = finiteNumber(value.cacheReadCreditsPerToken);
  const outputCreditsPerToken = finiteNumber(value.outputCreditsPerToken);
  const rSquared = finiteNumber(value.rSquared);
  const samples = finiteNumber(value.samples);
  const fittedAt = typeof value.fittedAt === "string" ? value.fittedAt : undefined;
  if (
    inputCreditsPerToken === undefined ||
    cacheReadCreditsPerToken === undefined ||
    outputCreditsPerToken === undefined ||
    rSquared === undefined ||
    samples === undefined ||
    fittedAt === undefined
  ) {
    return undefined;
  }
  if (inputCreditsPerToken < 0 || cacheReadCreditsPerToken < 0 || outputCreditsPerToken < 0) return undefined;
  return { inputCreditsPerToken, cacheReadCreditsPerToken, outputCreditsPerToken, rSquared, samples, fittedAt };
}

/**
 * Validate a profile document. Unknown versions are rejected wholesale, as are
 * documents with a missing version, non-finite numbers, or an empty model set —
 * partial parsing of a newer shape would invent estimates the writer never made.
 */
function parseProfile(raw: unknown, version: 1 | 2): LifetimeProfile | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.updatedAt !== "string") return undefined;
  if (!isRecord(raw.models)) return undefined;
  const models: Record<string, LifetimeEstimate> = {};
  for (const [id, value] of Object.entries(raw.models)) {
    if (!isRecord(value)) return undefined;
    const lifetimeSeconds = finiteNumber(value.lifetimeSeconds);
    const samples = finiteNumber(value.samples);
    const computedAt = typeof value.computedAt === "string" ? value.computedAt : undefined;
    const buckets = parseBuckets(value.buckets);
    if (lifetimeSeconds === undefined || samples === undefined || computedAt === undefined || buckets === undefined) {
      return undefined;
    }
    const rateFit = version === 2 ? parseRateFit(value.rateFit) : undefined;
    if (version === 2 && value.rateFit !== undefined && rateFit === undefined) return undefined;
    models[id] = { lifetimeSeconds, samples, computedAt, buckets, ...(rateFit !== undefined ? { rateFit } : {}) };
  }
  if (Object.keys(models).length === 0) return undefined;
  return { version, updatedAt: raw.updatedAt, models };
}

/** Read and validate the profile; absent or invalid reads as undefined (defaults stand). */
export function readProfile(dir: string = getPiAgentDir()): LifetimeProfile | undefined {
  const path = join(dir, PROFILE_FILENAME);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    debugLog(`cache-lifetime profile unreadable at ${path}`, error);
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const version = raw.version;
  if (version !== 1 && version !== 2) {
    debugLog(`cache-lifetime profile rejected: unsupported version ${String(version)}`);
    return undefined;
  }
  const profile = parseProfile(raw, version);
  if (profile === undefined) debugLog(`cache-lifetime profile rejected at ${path}`);
  return profile;
}

/** Write the profile atomically: temp file plus rename, so no partial file is observable. */
export function writeProfile(profile: LifetimeProfile, dir: string = getPiAgentDir()): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PROFILE_FILENAME);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`);
  renameSync(temporary, path);
}
