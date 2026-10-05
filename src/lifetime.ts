// shape: none — pure estimators plus validated I/O; no dispatch threshold is
//   reached. The profile path mirrors openConfigStore's file-pair precedent in
//   commands/context.ts; the estimators are straight-line math over sample
//   arrays. The one boundary (session JSONL on disk) is narrowed line by line.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_PROMPT_CACHE } from "./catalog.js";
import { debugLog } from "./debug.js";
import { getPiAgentDir } from "./home.js";
import type { PrefixStamp } from "./protocol/prefix-chain.js";
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
/** A death bound shortens the published lifetime only when >= this many
 *  independent miss signals support it — one unexplained miss moves nothing. */
export const MIN_DEATH_SIGNALS = 2;
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

/** One warm-refresh row as pi's CacheWarmer writes it (health-monitoring sample). */
export interface LedgerWarmSample {
  /**
   * The row's own model column. Since warm-attribution landed, pi stamps the
   * friendly id here (`responseModel ?? model`), so the column is the
   * attribution key; pre-attribution rows carry `auto` and are unattributable.
   */
  model: string;
  timestamp: number;
  promptTokens: number;
  cacheRead: number;
  credits: number | undefined;
  costTotal: number;
  /**
   * Seconds since the previous same-model real turn — the idle offset this
   * row's hit or miss is observed at. Undefined when no such predecessor
   * exists: without a cache-write marker to measure from, the observation sits
   * on no timeline and can neither corroborate a death nor prove survival.
   */
  idleSeconds?: number | undefined;
  /**
   * The model this row's hit or miss is attributed to: the row's model column
   * when a same-model predecessor anchors the offset, undefined otherwise.
   * Deaths corroborate per model, never pooled.
   */
  attributedModel?: string | undefined;
}

/** One bounded scan of the session ledgers, feeding both estimators. */
export interface LedgerScan {
  models: Record<string, LedgerModelSamples>;
  /** Every cache_warm row seen, in scan order (files newest-first). */
  warm: LedgerWarmSample[];
  files: number;
  exceededBudget: boolean;
}

/** Clamp a published lifetime into the declared bounds. */
export function clampLifetimeSeconds(seconds: number): number {
  return Math.min(Math.max(seconds, LIFETIME_MIN_SECONDS), LIFETIME_MAX_SECONDS);
}

/**
 * The six optional prefix-identity keys a dispatched turn stamps onto its usage
 * row. Derived from the writer's own `PrefixStamp` rather than spelled out again:
 * the ledger carries exactly what protocol/prefix-chain.ts writes, so a field the
 * writer renames is a compile error here instead of a silent desync between the two
 * modules. Absent keys stay absent rather than being defaulted — every row written
 * before this change carries none of them, and inventing a value would make the
 * census unable to distinguish a cold chain from a stale ledger. The same
 * absent-rather-than-coerced posture `credits` follows.
 */
type LedgerPrefixFields = Partial<PrefixStamp>;

interface LedgerAssistantLine extends LedgerPrefixFields {
  kind: "assistant";
  provider: string;
  model: string;
  timestamp: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  credits: number | undefined;
}

interface LedgerWarmLine extends LedgerPrefixFields {
  kind: "cache_warm";
  provider: string;
  model: string;
  timestamp: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  credits: number | undefined;
  costTotal: number;
}

type LedgerLine = LedgerAssistantLine | LedgerWarmLine | { kind: "context_reset" };

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
 * The six optional prefix keys off a usage record, or `undefined` to reject the
 * whole row.
 *
 * A key that is ABSENT stays absent, so a pre-change row parses exactly as before.
 * A key that is PRESENT but malformed rejects the row wholesale rather than being
 * dropped on its own: partially admitting it would hand a reader a row carrying
 * some of the six, which is the one shape the classifier must never see, and it
 * would silently turn a corrupt stamp into a cold-chain verdict. Both branches of
 * parseLedgerLine admit them, because assistant rows feed the gap filter and warm
 * rows feed the death observations — admitting one branch only would strand the
 * other's evidence in the ledger.
 */
function prefixFields(usage: Record<string, unknown>): LedgerPrefixFields | undefined {
  const fields: LedgerPrefixFields = {};

  if (usage.prefixLen !== undefined) {
    const prefixLen = tokenCount(usage.prefixLen);
    if (prefixLen === undefined) return undefined;
    fields.prefixLen = prefixLen;
  }
  if (usage.prefixDivergedAt !== undefined) {
    const prefixDivergedAt = tokenCount(usage.prefixDivergedAt);
    if (prefixDivergedAt === undefined) return undefined;
    fields.prefixDivergedAt = prefixDivergedAt;
  }
  if (usage.prefixStable !== undefined) {
    if (typeof usage.prefixStable !== "boolean") return undefined;
    fields.prefixStable = usage.prefixStable;
  }
  // One loop for the three digests: three structurally identical guards would be
  // the duplication REU-2 extracts, and they share one malformed-value posture.
  for (const key of ["prefixHash", "paramsHash", "payloadHash"] as const) {
    const value = usage[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    fields[key] = value;
  }
  return fields;
}

/**
 * Narrow one JSONL line to the facts the learner reads, or skip it. Unknown
 * fields and corrupt lines are dropped, and a non-numeric token count rejects the
 * row — a single malformed row must not abort the scan (best-effort posture). The
 * whitelisted prefix keys are not "unknown": a malformed one rejects its row too,
 * because dropping just that field would admit a half-stamped row.
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
  if (raw.type === "usage" && raw.kind === "cache_warm") {
    const provider = typeof raw.provider === "string" ? raw.provider : "unknown";
    const model = typeof raw.model === "string" ? raw.model : "unknown";
    const timestamp = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : Number.NaN;
    if (!isRecord(raw.usage) || !Number.isFinite(timestamp)) return undefined;
    const usage = raw.usage;
    const input = tokenCount(usage.input);
    const cacheRead = tokenCount(usage.cacheRead);
    const cacheWrite = tokenCount(usage.cacheWrite);
    if (input === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
    const cost = isRecord(usage.cost) ? finiteNumber(usage.cost.total) : undefined;
    const prefix = prefixFields(usage);
    if (prefix === undefined) return undefined;
    return {
      kind: "cache_warm",
      provider,
      model,
      timestamp,
      input,
      cacheRead,
      cacheWrite,
      credits: parseQoderCreditsUsage(usage).credits,
      costTotal: cost ?? 0,
      ...prefix,
    };
  }
  if (raw.type !== "message" || !isRecord(raw.message)) return undefined;

  const message = raw.message;
  if (message.role !== "assistant") return undefined;
  const provider = typeof message.provider === "string" ? message.provider : "unknown";
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
  const prefix = prefixFields(usage);
  if (prefix === undefined) return undefined;
  return {
    kind: "assistant",
    provider,
    model,
    timestamp,
    input,
    cacheRead,
    cacheWrite,
    output,
    credits: parseQoderCreditsUsage(usage).credits,
    ...prefix,
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

/** This extension owns these two providers; nothing else may enter the profile. */
const QODER_PROVIDERS = new Set(["qoder", "qoder-cn"]);

/**
 * Walk one session file. A natural gap is a pair of consecutive same-model
 * real turns with no `cache_warm` row and no compaction between them; the
 * later turn's cache-read share measures whether the earlier prompt survived.
 * Warm rows and context resets break a gap — they stop measuring natural
 * survival (a refresh resets the very clock it would be measuring). Rows from
 * other providers are ignored and break the chain: the sessions directory is
 * shared, and a foreign `auto` must never be sampled as a Qoder model.
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
      if (!QODER_PROVIDERS.has(entry.provider)) continue;
      broken = true;
      // The idle offset is measured from the last real turn of the SAME model:
      // the cache entry this row hit or missed was written by that turn. A
      // different model's predecessor anchored a different entry, and no
      // predecessor at all leaves the observation on no timeline — both stay
      // undefined rather than being invented. A predecessor timestamped at or
      // after the warm row is an out-of-order ledger, not an observation: the
      // gap push guards `seconds > 0` against the same hazard.
      const sameModelPredecessor =
        previous !== undefined && previous.model === entry.model && entry.timestamp > previous.timestamp
          ? previous
          : undefined;
      scan.warm.push({
        model: entry.model,
        timestamp: entry.timestamp,
        promptTokens: entry.input + entry.cacheRead + entry.cacheWrite,
        cacheRead: entry.cacheRead,
        credits: entry.credits,
        costTotal: entry.costTotal,
        idleSeconds:
          sameModelPredecessor !== undefined ? (entry.timestamp - sameModelPredecessor.timestamp) / 1000 : undefined,
        attributedModel: sameModelPredecessor !== undefined ? entry.model : undefined,
      });
      continue;
    }

    if (!QODER_PROVIDERS.has(entry.provider)) {
      previous = undefined;
      broken = true;
      continue;
    }

    const promptTokens = entry.input + entry.cacheRead + entry.cacheWrite;
    if (previous !== undefined && previous.model === entry.model && !broken) {
      const seconds = (entry.timestamp - previous.timestamp) / 1000;
      // A gap whose later row carries `prefixStable: false` measures a cold
      // start, not cache survival — the prompt the entry cached was never sent
      // — so it is excluded from the sample. An absent field is every
      // pre-prefix-chain ledger row and is included: the exclusion must degrade
      // to the old behaviour, not drop all history.
      if (seconds > 0 && promptTokens > 0 && entry.prefixStable !== false) {
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
    // A zero-usage assistant row anchors nothing: its turn read no prompt, so
    // it wrote no cache entry and its timestamp proves nothing about survival.
    // Clearing (not skipping) the anchor matters — a retained anchor under the
    // reset `broken` below would fabricate a gap measured across the rows in
    // between, which the pre-existing chain discipline already forbids.
    previous = promptTokens > 0 ? { model: entry.model, timestamp: entry.timestamp } : undefined;
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
  const scan: LedgerScan = { models: {}, warm: [], files: 0, exceededBudget: false };
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

/** Median of the values (any order); undefined for an empty input. */
export function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * One miss observation: the cache entry a warm refresh failed to find was
 * dead by this many idle seconds. Carries the model the miss is attributed
 * to, so deaths corroborate per model rather than pooled — but the grouping
 * is the caller's duty: `estimate` applies the list it is given as-is, and
 * `learnProfile` is the caller that groups by `attributedModel`.
 */
export interface WarmDeath {
  seconds: number;
  model: string | undefined;
}

export interface LifetimeEstimateResult {
  lifetimeSeconds?: number;
  samples: number;
  buckets: LifetimeBucket[];
}

/**
 * The earliest death bound at least two independent miss signals support.
 *
 * A miss at X seconds observes "the entry was dead by X" — it proves nothing
 * about any shorter offset — so a bound B is corroborated by every miss at or
 * below B, and the earliest bound two misses support is the SECOND-SMALLEST
 * miss offset. Grouping by exact offset instead would make the gate dead code
 * against real ledgers, where two refreshes never fire at the same idle second.
 */
// shape: none — dispatch object does not apply: one ordering decision over a
//   flat sample array, no discriminator and no per-case handler.
export function earliestCorroboratedDeathSeconds(deaths: readonly WarmDeath[]): number | undefined {
  const seconds = [...deaths].sort((a, b) => a.seconds - b.seconds);
  return seconds.length >= MIN_DEATH_SIGNALS ? seconds[MIN_DEATH_SIGNALS - 1].seconds : undefined;
}

/**
 * Publish rule: >= 20 natural samples; the lifetime is the clamped minimum of
 * the largest observed gap among the qualifying buckets and the earliest
 * corroborated death, never a bucket's upper boundary — the edge beyond the
 * largest observed gap is a claim nobody observed (BUG-0003). A death bound
 * counts only when at least two independent miss signals support it, so one
 * unexplained miss cannot shorten a schedule. A sparse or fast-decaying model
 * publishes nothing.
 */
export function estimate(gaps: readonly LedgerGap[], deaths: readonly WarmDeath[] = []): LifetimeEstimateResult {
  const buckets: LifetimeBucket[] = [];
  // Parallel to `buckets`: the largest observed gap inside each bucket, which
  // is the survival second the publish rule reads — the bucket's boundary is a
  // selection edge, not an observation.
  const bucketMaxGapSeconds: number[] = [];
  for (let index = 0; index < BUCKET_UPPER_BOUNDS_SECONDS.length; index += 1) {
    const upperSeconds = BUCKET_UPPER_BOUNDS_SECONDS[index];
    const lowerSeconds = index === 0 ? 0 : BUCKET_UPPER_BOUNDS_SECONDS[index - 1];
    const inBucket = gaps.filter((gap) => gap.seconds > lowerSeconds && gap.seconds <= upperSeconds);
    const ratios = inBucket.map((gap) => gap.ratio).sort((a, b) => a - b);
    if (ratios.length === 0) continue;
    const medianRatio = medianOf(ratios);
    if (medianRatio === undefined) continue;
    buckets.push({ upperSeconds, medianRatio, samples: ratios.length });
    bucketMaxGapSeconds.push(Math.max(...inBucket.map((gap) => gap.seconds)));
  }

  const samples = gaps.length;
  const qualifying = buckets
    .map((bucket, index) => ({ bucket, maxGapSeconds: bucketMaxGapSeconds[index] }))
    .filter(({ bucket }) => bucket.samples >= MIN_BUCKET_SAMPLES && bucket.medianRatio >= SURVIVAL_MEDIAN);
  if (samples < MIN_NATURAL_SAMPLES || qualifying.length === 0) {
    return { samples, buckets };
  }
  // The observed survival is the largest gap among the qualifying buckets' gaps
  // — the same evidence that qualifies the bucket — never a bucket boundary.
  const observedSurvival = Math.max(...qualifying.map(({ maxGapSeconds }) => maxGapSeconds));
  const corroboratedDeath = earliestCorroboratedDeathSeconds(deaths);
  const published = corroboratedDeath === undefined ? observedSurvival : Math.min(observedSurvival, corroboratedDeath);
  return { lifetimeSeconds: clampLifetimeSeconds(published), samples, buckets };
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
// shape: none — dispatch object does not apply: one fixed derivation per
//   model over the samples the scan already collected; no discriminator.
export function learnProfile(
  scan: LedgerScan,
  prior: LifetimeProfile | undefined,
  now: Date = new Date(),
): LifetimeProfile {
  const computedAt = now.toISOString();
  const models: Record<string, LifetimeEstimate> = {};
  // A miss observation corroborates a death only for the model it is
  // attributed to, so the deaths are grouped by attributedModel before any
  // model's estimate sees them — a miss attributed to no model corroborates
  // nothing, and a miss never shortens another model's bound.
  const deathsByModel = new Map<string, WarmDeath[]>();
  for (const row of scan.warm) {
    if (row.cacheRead > 0 || row.idleSeconds === undefined || row.attributedModel === undefined) continue;
    const deaths = deathsByModel.get(row.attributedModel) ?? [];
    deaths.push({ seconds: row.idleSeconds, model: row.attributedModel });
    deathsByModel.set(row.attributedModel, deaths);
  }
  for (const [model, samples] of Object.entries(scan.models)) {
    const estimateResult = estimate(samples.gaps, deathsByModel.get(model) ?? []);
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

/**
 * Delete the profile once, at the legacy-affinity parity cutover, so no
 * lifetime learned under client-deficient affinity survives into a
 * post-parity schedule. Idempotent by construction: the dedup store is file
 * absence, so a second reset is a no-op, and a reset racing a session-start
 * relearn loses at most one scan's values to writeProfile's atomic rename.
 */
// shape: none — dispatch object does not apply: one guarded filesystem delete
//   with no discriminator; writeProfile two declarations up is the precedent.
export function resetProfileForParity(dir: string = getPiAgentDir()): boolean {
  const path = join(dir, PROFILE_FILENAME);
  if (!existsSync(path)) return false;
  try {
    rmSync(path);
  } catch (error) {
    debugLog(`cache-lifetime parity reset failed at ${path}`, error);
    return false;
  }
  debugLog(`cache-lifetime profile reset for parity at ${path}`);
  return true;
}
