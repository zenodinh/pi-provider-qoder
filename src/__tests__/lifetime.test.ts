import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  estimate,
  fitRates,
  type LedgerTurn,
  type LifetimeProfile,
  learnProfile,
  PROFILE_FILENAME,
  readProfile,
  resetProfileForParity,
  scanLedgers,
  writeProfile,
} from "../lifetime.js";
import { assistantEntry, compactionEntry, warmEntry } from "./session-fixtures.js";

const MODEL = "DeepSeek-V4-Flash";
/** 10% input share keeps the cache-read ratio at 0.9 for every later turn. */
const TOKENS = { input: 1000, cacheRead: 9000, output: 100 };

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A sessions root shaped like ~/.pi/agent/sessions: root/<encoded-cwd>/<file>.jsonl */
function sessionsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qoder-ledger-"));
  createdDirs.push(root);
  mkdirSync(join(root, "encoded-project"), { recursive: true });
  return root;
}

function writeSession(root: string, name: string, lines: string[]): void {
  writeFileSync(join(root, "encoded-project", name), `${lines.join("\n")}\n`, "utf8");
}

// invented: ledger rows built from the recorded row shapes (probed 2026-10-01),
// with gap sizes and token mixes chosen to drive the estimator's publish rule.
/** A same-model chain whose consecutive deltas land in the four AC-05 buckets. */
function gapChain(): string[] {
  const distribution = [
    { count: 12, seconds: 20 },
    { count: 9, seconds: 90 },
    { count: 6, seconds: 200 },
    { count: 3, seconds: 500 },
  ];
  let timestamp = Date.UTC(2026, 8, 30, 0, 0, 0);
  const lines = [JSON.stringify(assistantEntry(MODEL, timestamp, TOKENS))];
  for (const bucket of distribution) {
    for (let index = 0; index < bucket.count; index += 1) {
      timestamp += bucket.seconds * 1000;
      lines.push(JSON.stringify(assistantEntry(MODEL, timestamp, TOKENS)));
    }
  }
  return lines;
}

describe("scanLedgers / estimate (AC-05)", () => {
  it("publishes 500 s for 30 qualifying gaps and keeps the default below 20 samples", () => {
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", gapChain());

    const scan = scanLedgers(5000, [root]);
    expect(scan.files).toBe(1);
    expect(scan.exceededBudget).toBe(false);
    const samples = scan.models[MODEL];
    expect(samples).toBeDefined();
    expect(samples?.gaps).toHaveLength(30);

    // spec CU-03 / AC-01: the published value is the largest observed gap among
    // the qualifying buckets (500 s — the biggest gap in the 600 s bucket), not
    // the bucket's 600 s upper boundary the pre-BUG-0003 rule emitted.
    const result = estimate(samples?.gaps ?? []);
    expect(result.lifetimeSeconds).toBe(500);
    expect(result.samples).toBe(30);
    expect(result.buckets.map((bucket) => [bucket.upperSeconds, bucket.samples])).toEqual([
      [30, 12],
      [120, 9],
      [300, 6],
      [600, 3],
    ]);

    const sparseRoot = sessionsRoot();
    writeSession(sparseRoot, "session.jsonl", [
      JSON.stringify(assistantEntry(MODEL, 1_000_000, TOKENS)),
      ...Array.from({ length: 10 }, (_, index) =>
        JSON.stringify(assistantEntry(MODEL, 1_020_000 + index * 20_000, TOKENS)),
      ),
    ]);
    const sparse = scanLedgers(5000, [sparseRoot]);
    expect(sparse.models[MODEL]?.gaps).toHaveLength(10);
    expect(estimate(sparse.models[MODEL]?.gaps ?? []).lifetimeSeconds).toBeUndefined();
  });

  it("breaks a natural gap with a cache_warm row and with a compaction", () => {
    const root = sessionsRoot();
    const start = Date.UTC(2026, 8, 30, 0, 0, 0);
    writeSession(root, "session.jsonl", [
      JSON.stringify(assistantEntry(MODEL, start, TOKENS)),
      JSON.stringify(warmEntry(start + 20_000, { input: 1000, cacheRead: 9000, output: 4 }, 0, 3.75)),
      JSON.stringify(assistantEntry(MODEL, start + 40_000, TOKENS)),
      JSON.stringify(assistantEntry(MODEL, start + 60_000, TOKENS)),
      JSON.stringify(compactionEntry(start + 70_000)),
      JSON.stringify(assistantEntry(MODEL, start + 80_000, TOKENS)),
      JSON.stringify(assistantEntry(MODEL, start + 100_000, TOKENS)),
    ]);

    const scan = scanLedgers(5000, [root]);
    // The warm row breaks gap 1; gap 2 (m2 -> m3) survives; the compaction
    // resets the chain, so only the post-compaction pair counts again.
    expect(scan.models[MODEL]?.gaps).toHaveLength(2);
  });

  it("ignores other providers' rows and never samples a foreign same-named model", () => {
    const root = sessionsRoot();
    const start = Date.UTC(2026, 8, 30, 0, 0, 0);
    writeSession(root, "session.jsonl", [
      JSON.stringify(assistantEntry("auto", start, TOKENS)),
      JSON.stringify(assistantEntry("auto", start + 20_000, TOKENS, undefined, "anthropic")),
      JSON.stringify(assistantEntry("auto", start + 40_000, TOKENS)),
      JSON.stringify(assistantEntry("auto", start + 60_000, TOKENS)),
      JSON.stringify(warmEntry(start + 80_000, { input: 1000, cacheRead: 9000, output: 4 }, 0, 3.75, "anthropic")),
      JSON.stringify(assistantEntry("auto", start + 100_000, TOKENS)),
      JSON.stringify(warmEntry(start + 120_000, { input: 1000, cacheRead: 9000, output: 4 }, 0, 3.75)),
      JSON.stringify(assistantEntry("auto", start + 140_000, TOKENS)),
    ]);

    const scan = scanLedgers(5000, [root]);
    // The foreign row breaks the chain (no gap across it); the foreign warm
    // row is ignored (a Qoder gap still forms across it); only the Qoder warm
    // row breaks a gap and is counted as a refresh.
    expect(Object.keys(scan.models)).toEqual(["auto"]);
    expect(scan.models.auto?.gaps.map((gap) => gap.seconds)).toEqual([20, 40]);
    expect(scan.warm).toHaveLength(1);
  });
});

describe("fitRates (AC-07)", () => {
  const FORM = { input: 1e-5, cacheRead: 1e-6, output: 3e-5 };
  // invented: per-turn token mixes vary with coprime periods so the design
  // matrix stays invertible; Credits follow one form exactly, or two forms
  // mixed for the alias case.
  function turn(index: number, form: { input: number; cacheRead: number; output: number }): LedgerTurn {
    const input = 1000 + (index % 5) * 313;
    const cacheRead = 5000 + (index % 7) * 617;
    const output = 100 + (index % 3) * 41;
    return {
      input,
      cacheRead,
      output,
      credits: form.input * input + form.cacheRead * cacheRead + form.output * output,
    };
  }

  it("publishes a stable form at R² >= 0.95 and refuses a mixed-upstream set", () => {
    const stable = Array.from({ length: 30 }, (_, index) => turn(index, FORM));
    const { rateFit } = fitRates(stable);
    expect(rateFit).toBeDefined();
    expect(rateFit?.samples).toBe(30);
    expect(rateFit?.rSquared).toBeGreaterThanOrEqual(0.95);
    expect(rateFit?.inputCreditsPerToken).toBeCloseTo(FORM.input, 12);
    expect(rateFit?.cacheReadCreditsPerToken).toBeCloseTo(FORM.cacheRead, 12);
    expect(rateFit?.outputCreditsPerToken).toBeCloseTo(FORM.output, 12);

    const mixed = Array.from({ length: 30 }, (_, index) =>
      turn(index, index % 2 === 0 ? FORM : { ...FORM, output: 3e-4 }),
    );
    expect(fitRates(mixed).rateFit).toBeUndefined();

    const sparse = stable.slice(0, 19);
    expect(fitRates(sparse).rateFit).toBeUndefined();
  });
});

describe("profile read/write (AC-06)", () => {
  it("rejects a truncated profile, accepts versions 1 and 2, and writes atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-profile-"));
    createdDirs.push(dir);
    const path = join(dir, PROFILE_FILENAME);

    writeFileSync(path, '{"version":2,"updatedAt":"2026-10-01T00:00:00.000Z","models":{"M":{"lifetimeSeconds":');
    expect(readProfile(dir)).toBeUndefined();

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-01T00:00:00.000Z",
        models: {
          M: {
            lifetimeSeconds: 600,
            samples: 30,
            computedAt: "2026-09-30T12:00:00.000Z",
            buckets: [{ upperSeconds: 30, medianRatio: 0.9, samples: 12 }],
          },
        },
      }),
    );
    const versionOne = readProfile(dir);
    expect(versionOne?.version).toBe(1);
    expect(versionOne?.models.M?.lifetimeSeconds).toBe(600);
    expect(versionOne?.models.M?.rateFit).toBeUndefined();

    // invented: a published profile drawn from the schema example in SA §5.5.
    const profile: LifetimeProfile = {
      version: 2,
      updatedAt: "2026-10-01T00:00:00.000Z",
      models: {
        "DeepSeek-V4-Flash": {
          lifetimeSeconds: 600,
          samples: 30,
          computedAt: "2026-09-30T12:00:00.000Z",
          buckets: [{ upperSeconds: 600, medianRatio: 0.84, samples: 3 }],
          rateFit: {
            inputCreditsPerToken: 9.5238e-6,
            cacheReadCreditsPerToken: 1.90476e-7,
            outputCreditsPerToken: 3.80952e-5,
            rSquared: 0.9982,
            samples: 42,
            fittedAt: "2026-09-30T12:00:00.000Z",
          },
        },
      },
    };
    writeProfile(profile, dir);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readProfile(dir)).toEqual(profile);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);

    writeFileSync(path, JSON.stringify({ version: 3, updatedAt: "2026-10-01T00:00:00.000Z", models: { M: {} } }));
    expect(readProfile(dir)).toBeUndefined();

    writeFileSync(path, JSON.stringify({ version: 2, updatedAt: "2026-10-01T00:00:00.000Z", models: {} }));
    expect(readProfile(dir)).toBeUndefined();
  });
});

/**
 * The ledger whitelist for the six prefix-identity keys (spec CU-05).
 *
 * `parseLedgerLine` is module-private, so admission is observed through the
 * exported `scanLedgers` by REJECTION ASYMMETRY rather than by field presence: a
 * malformed prefix key must make its row vanish, which it can only do if that
 * branch read the key at all. Sample-structure propagation is FS-E's gap-filter
 * edit at the gap push, not this whitelist's, so a stamped row publishes exactly
 * what the same row unstamped publishes.
 */
describe("parseLedgerLine prefix whitelist (spec CU-05)", () => {
  const STAMPED_AT = Date.UTC(2026, 8, 30, 0, 0, 0);

  // invented: prefixLen 412300 is SA §5.1's own example value; the three digests
  // are that example's truncated forms ("9f2c…", "41ab…", "77e0…") padded to the
  // 32-hex width prefix-chain.ts publishes.
  const PREFIX_FIELDS = {
    prefixLen: 412300,
    prefixHash: "9f2c000000000000000000000000abcd",
    prefixStable: true,
    paramsHash: "41ab000000000000000000000000abcd",
    payloadHash: "77e0000000000000000000000000abcd",
  };

  /** One fixture row as a JSONL line, with extra keys merged into its usage object. */
  function row(entry: unknown, usage: Record<string, unknown>): string {
    const line = structuredClone(entry) as {
      usage?: Record<string, unknown>;
      message?: { usage?: Record<string, unknown> };
    };
    const target = line.message?.usage ?? line.usage;
    if (!target) throw new Error("fixture row carries no usage object");
    Object.assign(target, usage);
    return JSON.stringify(line);
  }

  function assistantRow(at: number, usage: Record<string, unknown> = PREFIX_FIELDS): string {
    return row(assistantEntry(MODEL, at, TOKENS, 1.94), usage);
  }

  function warmRow(at: number, usage: Record<string, unknown> = PREFIX_FIELDS): string {
    return row(warmEntry(at, TOKENS, 0.0259, 1.94), usage);
  }

  // spec: T-11 / AC-08 — both ledger row kinds carry the prefix fields through the
  // parse, and rows without them are unaffected.
  it("T-11 admits all six keys in both branches and publishes exactly what an unstamped ledger publishes", () => {
    const unstampedRoot = sessionsRoot();
    writeSession(unstampedRoot, "session.jsonl", [
      JSON.stringify(assistantEntry(MODEL, STAMPED_AT, TOKENS, 1.94)),
      JSON.stringify(warmEntry(STAMPED_AT + 60_000, TOKENS, 0.0259, 1.94)),
    ]);
    const unstamped = scanLedgers(5000, [unstampedRoot]);

    const stampedRoot = sessionsRoot();
    writeSession(stampedRoot, "session.jsonl", [assistantRow(STAMPED_AT), warmRow(STAMPED_AT + 60_000)]);
    const stamped = scanLedgers(5000, [stampedRoot]);

    // Both rows still parse with all six keys present: the warm row reaches
    // scan.warm and the assistant row reaches the model's turn sample.
    expect(stamped.warm, "the cache_warm branch admitted the stamp").toHaveLength(1);
    expect(stamped.models[MODEL]?.turns, "the assistant branch admitted the stamp").toHaveLength(1);
    // And admitting them changes no published value, which is the additive-field
    // compatibility claim: the sample structures are built fresh, so nothing leaks.
    expect(stamped.warm).toEqual(unstamped.warm);
    expect(stamped.models[MODEL]?.turns).toEqual(unstamped.models[MODEL]?.turns);
    expect(stamped.models[MODEL]?.gaps).toEqual(unstamped.models[MODEL]?.gaps);
  });

  it("T-11 rejects a warm row whose prefixLen is malformed, so the warm branch demonstrably reads the key", () => {
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", [warmRow(STAMPED_AT, { ...PREFIX_FIELDS, prefixLen: "not-a-number" })]);

    // Had the branch ignored the key as unknown, the row would have survived.
    expect(scanLedgers(5000, [root]).warm, "a malformed stamp rejects the row wholesale").toHaveLength(0);
  });

  it("T-11 rejects an assistant row whose prefixLen is malformed, so the assistant branch demonstrably reads it", () => {
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", [assistantRow(STAMPED_AT, { ...PREFIX_FIELDS, prefixLen: "not-a-number" })]);

    expect(scanLedgers(5000, [root]).models[MODEL]?.turns ?? [], "the row was refused, not half-admitted").toHaveLength(
      0,
    );
  });

  // spec: T-12 / AC-09 — the reject-wholesale posture and the unknown-key drop both
  // survive the whitelist extension.
  it("T-12 still refuses a corrupt line and a malformed stamp, and keeps scanning past both", () => {
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", [
      "{not json at all",
      assistantRow(STAMPED_AT),
      assistantRow(STAMPED_AT + 20_000, { ...PREFIX_FIELDS, prefixStable: "true" }),
      assistantRow(STAMPED_AT + 40_000),
    ]);

    const scan = scanLedgers(5000, [root]);
    expect(scan.files, "the scan completed rather than aborting on the corrupt line").toBe(1);
    expect(scan.exceededBudget).toBe(false);
    expect(
      scan.models[MODEL]?.turns,
      "the unparseable line and the non-boolean prefixStable are both refused; the two clean rows survive",
    ).toHaveLength(2);
  });

  it("T-12 still drops unknown keys beyond the six", () => {
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", [
      assistantRow(STAMPED_AT, { ...PREFIX_FIELDS, prefixFromTheFuture: "ignored" }),
    ]);

    const turn = scanLedgers(5000, [root]).models[MODEL]?.turns[0];
    expect(turn, "the row still parses with an unknown key beside the whitelist").toBeDefined();
    expect(Object.keys(turn ?? {}).sort(), "and only the keys the parser names survive it").toEqual([
      "cacheRead",
      "credits",
      "input",
      "output",
    ]);
  });

  it("T-12 rejects a malformed digest key, not only a malformed number", () => {
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", [warmRow(STAMPED_AT, { ...PREFIX_FIELDS, paramsHash: 41 })]);

    expect(
      scanLedgers(5000, [root]).warm,
      "a non-string digest rejects the row like any other malformation",
    ).toHaveLength(0);
  });

  it("T-11 admits prefixDivergedAt, and rejects the row when that index is malformed", () => {
    // The divergence index is the one field that says WHERE a prefix broke, so it
    // must survive the parse on a diverged row rather than being dropped as unknown.
    const divergedRoot = sessionsRoot();
    writeSession(divergedRoot, "session.jsonl", [
      assistantRow(STAMPED_AT, { ...PREFIX_FIELDS, prefixStable: false, prefixDivergedAt: 3 }),
    ]);
    expect(
      scanLedgers(5000, [divergedRoot]).models[MODEL]?.turns,
      "a diverged row carrying a valid index still parses",
    ).toHaveLength(1);

    const malformedRoot = sessionsRoot();
    writeSession(malformedRoot, "session.jsonl", [
      assistantRow(STAMPED_AT, { ...PREFIX_FIELDS, prefixStable: false, prefixDivergedAt: "third" }),
    ]);
    expect(
      scanLedgers(5000, [malformedRoot]).models[MODEL]?.turns ?? [],
      "and a malformed index rejects the row wholesale like any other malformation",
    ).toHaveLength(0);
  });
});

/**
 * The observed-second learner (fs-qoder-cache-learner CUs 01-05, SA CU-4 /
 * BUG-0003). Every row drives the public seam — scanLedgers over a temp
 * fixture ledger, then estimate / learnProfile / readProfile / writeProfile /
 * resetProfileForParity — never the private parser.
 *
 * `learnProfile` is imported at the top of this block's enclosing module scope
 * via the same seam table (S5): it is exercised through the profile it
 * publishes, so a row here needs no mock of node:fs beyond the temp dirs the
 * harness already creates.
 */

// invented: a qualifying-bucket chain whose gaps are all 640 s — the largest
// observed survival the BUG-0003 ledger records — landing in the 1200 s bucket.
function observedSurvivalChain(seconds: number, count: number): string[] {
  let timestamp = Date.UTC(2026, 8, 30, 0, 0, 0);
  const lines = [JSON.stringify(assistantEntry(MODEL, timestamp, TOKENS))];
  for (let index = 0; index < count; index += 1) {
    timestamp += seconds * 1000;
    lines.push(JSON.stringify(assistantEntry(MODEL, timestamp, TOKENS)));
  }
  return lines;
}

/** A MISSED warm refresh attributed to MODEL: nothing came back, so the entry
 *  was dead by this idle offset. */
function warmRowForMiss(at: number): string {
  const line = structuredClone(warmEntry(at, { input: 1000, cacheRead: 0, output: 4 }, 0, 3.75)) as unknown as {
    model: string;
  };
  line.model = MODEL;
  return JSON.stringify(line);
}

/** A HIT warm refresh attributed to MODEL: the cache was read back, so the
 *  entry was alive at this idle offset. */
function warmRowForHit(at: number): string {
  const line = structuredClone(warmEntry(at, { input: 1000, cacheRead: 9000, output: 4 }, 0, 3.75)) as unknown as {
    model: string;
  };
  line.model = MODEL;
  return JSON.stringify(line);
}

describe("observed-second learner (fs-qoder-cache-learner)", () => {
  // spec: CU-01 / T-01 / AC-03 — a zero-usage assistant row anchors no gap.
  it("T-01 excludes a zero-usage assistant row from gap anchoring, while a positive-usage middle row anchors exactly as before", () => {
    const start = Date.UTC(2026, 8, 30, 0, 0, 0);
    const zeroUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

    const zeroRoot = sessionsRoot();
    writeSession(zeroRoot, "session.jsonl", [
      JSON.stringify(assistantEntry(MODEL, start, TOKENS)),
      JSON.stringify(assistantEntry(MODEL, start + 20_000, zeroUsage)),
      JSON.stringify(assistantEntry(MODEL, start + 40_000, TOKENS)),
      JSON.stringify(assistantEntry(MODEL, start + 60_000, TOKENS)),
    ]);
    const zeroScan = scanLedgers(5000, [zeroRoot]);
    // The zero-usage row anchors nothing, so no gap spans it: only the
    // post-zero pair (m2 -> m3) forms, because the anchor was cleared rather
    // than retained across the zero-usage turn.
    expect(zeroScan.models[MODEL]?.gaps.map((gap) => gap.seconds)).toEqual([20]);

    const positiveRoot = sessionsRoot();
    writeSession(positiveRoot, "session.jsonl", [
      JSON.stringify(assistantEntry(MODEL, start, TOKENS)),
      JSON.stringify(assistantEntry(MODEL, start + 20_000, TOKENS)),
      JSON.stringify(assistantEntry(MODEL, start + 40_000, TOKENS)),
    ]);
    const positiveScan = scanLedgers(5000, [positiveRoot]);
    expect(positiveScan.models[MODEL]?.gaps.map((gap) => gap.seconds)).toEqual([20, 20]);
  });

  // spec: CU-02 / T-02 / AC-02, AC-04 — a warm row carries an attributable
  // observation at a known idle offset; a hit is survival, a miss a death.
  it("T-02 harvests idleSeconds and attributedModel on a warm row, both undefined with no same-model predecessor", () => {
    const start = Date.UTC(2026, 8, 30, 0, 0, 0);
    // Post-attribution the warm row's model column is the friendly id, so the
    // fixture overrides the builder's `auto` default for the attributed row.
    function warmRow(at: number, model: string): string {
      const line = structuredClone(warmEntry(at, { input: 1000, cacheRead: 9000, output: 4 }, 0, 3.75)) as unknown as {
        model: string;
      };
      line.model = model;
      return JSON.stringify(line);
    }
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", [
      JSON.stringify(warmEntry(start, { input: 1000, cacheRead: 9000, output: 4 }, 0, 3.75)),
      JSON.stringify(assistantEntry(MODEL, start + 10_000, TOKENS)),
      warmRow(start + 40_000, MODEL),
    ]);
    const scan = scanLedgers(5000, [root]);
    expect(scan.warm).toHaveLength(2);
    const [orphan, attributed] = scan.warm;
    expect(orphan.idleSeconds).toBeUndefined();
    expect(orphan.attributedModel).toBeUndefined();
    expect(attributed.idleSeconds).toBe(30);
    expect(attributed.attributedModel).toBe(MODEL);

    // A different model's last real turn is not the predecessor: it cached a
    // different entry, so the offset would be measured from the wrong marker.
    const foreignRoot = sessionsRoot();
    writeSession(foreignRoot, "session.jsonl", [
      JSON.stringify(assistantEntry("Qwen3-Coder", start, TOKENS)),
      warmRow(start + 25_000, MODEL),
    ]);
    const foreign = scanLedgers(5000, [foreignRoot]);
    expect(foreign.warm[0]?.idleSeconds).toBeUndefined();
    expect(foreign.warm[0]?.attributedModel).toBeUndefined();
  });

  it("T-03 distinguishes a hit warm (survival evidence) from a miss warm (death candidate) in the sample the scan produces", () => {
    const start = Date.UTC(2026, 8, 30, 0, 0, 0);
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", [
      JSON.stringify(assistantEntry(MODEL, start, TOKENS)),
      // A hit: the refresh read the cache back, so the entry was alive at 30 s.
      JSON.stringify(warmEntry(start + 30_000, { input: 1000, cacheRead: 9000, output: 4 }, 0, 3.75)),
      JSON.stringify(assistantEntry(MODEL, start + 40_000, TOKENS)),
      // A miss: nothing came back at the 60 s offset, so the entry was dead by then.
      JSON.stringify(warmEntry(start + 100_000, { input: 1000, cacheRead: 0, output: 4 }, 0, 3.75)),
    ]);
    const scan = scanLedgers(5000, [root]);
    expect(scan.warm.map((row) => row.cacheRead > 0)).toEqual([true, false]);

    // AC-04's falsifier, driven through learnProfile: a cacheRead-positive
    // warm at a low idle offset is survival evidence and must NOT shorten the
    // published lifetime — only misses corroborate a death bound.
    const hitRoot = sessionsRoot();
    const hitStart = Date.UTC(2026, 8, 30, 0, 0, 0);
    const hitLines = [JSON.stringify(assistantEntry(MODEL, hitStart, TOKENS))];
    let hitAt = hitStart;
    for (let index = 0; index < 21; index += 1) {
      hitAt += 640_000;
      hitLines.push(JSON.stringify(assistantEntry(MODEL, hitAt, TOKENS)));
    }
    // Two HIT refreshes at 300 s and 400 s idle — alive at both offsets, so
    // the observed survival stands and the published value stays 640.
    hitLines.push(warmRowForHit(hitStart + 21 * 640_000 + 300_000));
    hitLines.push(warmRowForHit(hitStart + 21 * 640_000 + 400_000));
    writeSession(hitRoot, "session.jsonl", hitLines);
    const hitScan = scanLedgers(5000, [hitRoot]);
    expect(learnProfile(hitScan, undefined).models[MODEL]?.lifetimeSeconds).toBe(640);
  });

  // spec: CU-03 / T-04 / AC-01 — the published lifetime never exceeds an
  // observed survival second.
  it("T-04 publishes the observed survival, not the bucket boundary, and the profile written to the temp agent dir carries it", () => {
    const root = sessionsRoot();
    // 21 same-shape gaps of 640 s: 20 samples meet MIN_NATURAL_SAMPLES and 3+
    // per bucket meet MIN_BUCKET_SAMPLES with a 0.9 median ratio, so the 1200 s
    // bucket qualifies — and its boundary is exactly the overclaim BUG-0003
    // records. The largest observed gap is 640 s.
    writeSession(root, "session.jsonl", observedSurvivalChain(640, 21));

    const scan = scanLedgers(5000, [root]);
    const samples = scan.models[MODEL];
    expect(samples?.gaps).toHaveLength(21);
    const result = estimate(samples?.gaps ?? []);
    expect(result.buckets.map((bucket) => bucket.upperSeconds)).toContain(1200);
    expect(result.lifetimeSeconds).toBe(640);

    // The observed survival is read from the QUALIFYING buckets only: three
    // 3000 s gaps whose median ratio collapses (0.1) put a larger gap inside a
    // non-qualifying bucket, and that gap must not leak into the published
    // value — the qualifying evidence is the 640 s chain.
    const decayed = [...(samples?.gaps ?? []), ...Array.from({ length: 3 }, () => ({ seconds: 3000, ratio: 0.1 }))];
    const decayedResult = estimate(decayed);
    expect(decayedResult.buckets.map((bucket) => [bucket.upperSeconds, bucket.samples])).toContainEqual([3600, 3]);
    expect(decayedResult.lifetimeSeconds).toBe(640);

    const dir = mkdtempSync(join(tmpdir(), "qoder-learner-"));
    createdDirs.push(dir);
    const profile = learnProfile(scan, undefined);
    writeProfile(profile, dir);
    expect(readProfile(dir)?.models[MODEL]?.lifetimeSeconds).toBe(640);
  });

  // spec: CU-03 / T-05 / AC-02, AC-05 — a death bound moves the published value
  // only when at least two independent miss signals support it.
  it("T-05 leaves the published value unchanged on one miss, and takes the earlier of the two bounds on two", () => {
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", observedSurvivalChain(640, 21));
    const scan = scanLedgers(5000, [root]);
    const samples = scan.models[MODEL]?.gaps ?? [];
    expect(samples).toHaveLength(21);

    // One uncorroborated miss at 300 s: the observed-survival term stands.
    expect(estimate(samples, [{ seconds: 300, model: MODEL }]).lifetimeSeconds).toBe(640);
    // Two independent misses at 300 s and 400 s: the earliest bound both
    // support is 400 s (a miss at 400 proves nothing about 300 s), so the
    // published value is min(640, 400) = 400.
    expect(
      estimate(samples, [
        { seconds: 300, model: MODEL },
        { seconds: 400, model: MODEL },
      ]).lifetimeSeconds,
    ).toBe(400);
    // A third miss at 200 s does not move the bound below the second-smallest
    // offset: 200 s alone is uncorroborated, so the earliest bound two signals
    // support is still 300 s.
    expect(
      estimate(samples, [
        { seconds: 200, model: MODEL },
        { seconds: 300, model: MODEL },
        { seconds: 900, model: MODEL },
      ]).lifetimeSeconds,
    ).toBe(300);
    // A corroborated bound below the clamp floor still publishes the floor.
    expect(
      estimate(samples, [
        { seconds: 60, model: MODEL },
        { seconds: 90, model: MODEL },
      ]).lifetimeSeconds,
    ).toBe(120);

    // The same gate flows through learnProfile: a ledger with two missed
    // refreshes publishes the corroborated bound into the profile, while the
    // identical ledger with one miss publishes the observed survival alone.
    // The misses sit inside a gap-broken chain (a warm row breaks the chain),
    // so the gap sample below is built from the real turns only.
    const missRoot = sessionsRoot();
    const missStart = Date.UTC(2026, 8, 30, 0, 0, 0);
    const missLines = [JSON.stringify(assistantEntry(MODEL, missStart, TOKENS))];
    let missAt = missStart;
    for (let index = 0; index < 21; index += 1) {
      missAt += 640_000;
      missLines.push(JSON.stringify(assistantEntry(MODEL, missAt, TOKENS)));
    }
    // Two missed refreshes at 300 s and 400 s idle: both attributed to MODEL.
    missLines.push(warmRowForMiss(missStart + 21 * 640_000 + 300_000));
    missLines.push(warmRowForMiss(missStart + 21 * 640_000 + 400_000));
    writeSession(missRoot, "session.jsonl", missLines);
    const missScan = scanLedgers(5000, [missRoot]);
    expect(learnProfile(missScan, undefined).models[MODEL]?.lifetimeSeconds).toBe(400);

    const oneMissRoot = sessionsRoot();
    const oneMissLines = [...missLines.slice(0, -1)];
    writeSession(oneMissRoot, "session.jsonl", oneMissLines);
    const oneMissScan = scanLedgers(5000, [oneMissRoot]);
    expect(learnProfile(oneMissScan, undefined).models[MODEL]?.lifetimeSeconds).toBe(640);

    // Cross-model isolation: a miss attributed to a DIFFERENT model must not
    // shorten this model's bound — deaths corroborate per model, never pooled.
    const foreignMissRoot = sessionsRoot();
    const foreignMissLines = [...missLines.slice(0, -2)];
    const foreignMissStart = missStart;
    foreignMissLines.push(
      JSON.stringify(
        (() => {
          const line = structuredClone(
            warmEntry(foreignMissStart + 21 * 640_000 + 300_000, { input: 1000, cacheRead: 0, output: 4 }, 0, 3.75),
          ) as unknown as { model: string };
          line.model = "Qwen3-Coder";
          return line;
        })(),
      ),
      JSON.stringify(
        (() => {
          const line = structuredClone(
            warmEntry(foreignMissStart + 21 * 640_000 + 400_000, { input: 1000, cacheRead: 0, output: 4 }, 0, 3.75),
          ) as unknown as { model: string };
          line.model = "Qwen3-Coder";
          return line;
        })(),
      ),
    );
    writeSession(foreignMissRoot, "session.jsonl", foreignMissLines);
    const foreignMissScan = scanLedgers(5000, [foreignMissRoot]);
    expect(learnProfile(foreignMissScan, undefined).models[MODEL]?.lifetimeSeconds).toBe(640);
  });

  // spec: CU-03 / T-06 / AC-06 — the thin-evidence gate and the carry-forward
  // both survive the new bound.
  it("T-06 still publishes nothing for a thin session and still carries the prior estimate forward", () => {
    const thinRoot = sessionsRoot();
    writeSession(thinRoot, "session.jsonl", observedSurvivalChain(640, 10));
    const thinScan = scanLedgers(5000, [thinRoot]);
    expect(estimate(thinScan.models[MODEL]?.gaps ?? []).lifetimeSeconds).toBeUndefined();

    const prior: LifetimeProfile = {
      version: 2,
      updatedAt: "2026-10-01T00:00:00.000Z",
      models: {
        [MODEL]: {
          lifetimeSeconds: 480,
          samples: 21,
          computedAt: "2026-09-30T12:00:00.000Z",
          buckets: [{ upperSeconds: 1200, medianRatio: 0.9, samples: 21 }],
        },
      },
    };
    const learned = learnProfile(thinScan, prior);
    expect(learned.models[MODEL]?.lifetimeSeconds).toBe(480);

    // A well-evidenced session with no death observations at all publishes the
    // observed survival term unchanged.
    const fullRoot = sessionsRoot();
    writeSession(fullRoot, "session.jsonl", observedSurvivalChain(640, 21));
    const fullScan = scanLedgers(5000, [fullRoot]);
    expect(estimate(fullScan.models[MODEL]?.gaps ?? []).lifetimeSeconds).toBe(640);
  });

  // spec: CU-04 / T-07 / AC-07 — the parity reset discards the profile exactly
  // once and is a no-op thereafter.
  it("T-07 removes a present profile once, is a no-op on the second call, and leaves the next learn to rebuild from post-parity rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-parity-"));
    createdDirs.push(dir);
    const path = join(dir, PROFILE_FILENAME);

    const preParity: LifetimeProfile = {
      version: 2,
      updatedAt: "2026-10-01T00:00:00.000Z",
      models: {
        [MODEL]: {
          lifetimeSeconds: 3600,
          samples: 42,
          computedAt: "2026-09-30T12:00:00.000Z",
          buckets: [{ upperSeconds: 3600, medianRatio: 0.9, samples: 42 }],
        },
      },
    };
    writeProfile(preParity, dir);
    expect(existsSync(path)).toBe(true);

    expect(resetProfileForParity(dir)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readProfile(dir)).toBeUndefined();

    // A profile written by a concurrent relearn between two resets is removed
    // by the later one, and a second reset with no profile is a no-op.
    writeProfile(preParity, dir);
    expect(resetProfileForParity(dir)).toBe(true);
    expect(resetProfileForParity(dir)).toBe(false);
    expect(existsSync(path)).toBe(false);

    // The next learn over a post-parity fixture ledger publishes only from
    // those rows — no pre-parity value survives into the rebuilt profile.
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", observedSurvivalChain(640, 21));
    const scan = scanLedgers(5000, [root]);
    const rebuilt = learnProfile(scan, readProfile(dir));
    expect(rebuilt.models[MODEL]?.lifetimeSeconds).toBe(640);
  });

  // spec: CU-05 / T-08 / AC-08 — a diverged-prefix gap is excluded from the
  // lifetime sample; an unmarked gap and a stable-prefix gap are not.
  it("T-08 excludes prefixStable:false gaps, includes absent and prefixStable:true ones", () => {
    const start = Date.UTC(2026, 8, 30, 0, 0, 0);
    const STAMP = { prefixLen: 412300, prefixHash: "9f2c000000000000000000000000abcd" };

    function stampedRow(at: number, prefixStable: boolean): string {
      const line = structuredClone(assistantEntry(MODEL, at, TOKENS, 1.94)) as unknown as {
        message: { usage: Record<string, unknown> };
      };
      Object.assign(line.message.usage, { ...STAMP, prefixStable });
      return JSON.stringify(line);
    }

    // All three ledgers share the same 30-gap qualifying chain; only the later
    // rows of the diverged one are marked unstable, so it falls below the
    // publish gate while the other two publish the same observed survival.
    const chain = observedSurvivalChain(640, 21);

    const unmarkedRoot = sessionsRoot();
    writeSession(unmarkedRoot, "session.jsonl", chain);
    const unmarked = scanLedgers(5000, [unmarkedRoot]);

    const divergedRoot = sessionsRoot();
    writeSession(divergedRoot, "session.jsonl", [
      chain[0],
      ...chain
        .slice(1)
        .map((line, index) => (index % 2 === 0 ? stampedRow(start + (index + 1) * 640_000, false) : line)),
    ]);
    const diverged = scanLedgers(5000, [divergedRoot]);

    const stableRoot = sessionsRoot();
    writeSession(stableRoot, "session.jsonl", [
      chain[0],
      ...chain
        .slice(1)
        .map((line, index) => (index % 2 === 0 ? stampedRow(start + (index + 1) * 640_000, true) : line)),
    ]);
    const stable = scanLedgers(5000, [stableRoot]);

    expect(unmarked.models[MODEL]?.gaps).toHaveLength(21);
    // 11 of the 21 gaps have a marked later row and are excluded; 10 remain —
    // below the 20-sample publish gate, so the diverged ledger publishes nothing.
    expect(diverged.models[MODEL]?.gaps).toHaveLength(10);
    expect(stable.models[MODEL]?.gaps).toHaveLength(21);

    expect(estimate(unmarked.models[MODEL]?.gaps ?? []).lifetimeSeconds).toBe(640);
    expect(estimate(diverged.models[MODEL]?.gaps ?? []).lifetimeSeconds).toBeUndefined();
    expect(estimate(stable.models[MODEL]?.gaps ?? []).lifetimeSeconds).toBe(640);
  });
});
