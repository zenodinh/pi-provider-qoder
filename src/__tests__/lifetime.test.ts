import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  estimate,
  fitRates,
  type LedgerTurn,
  type LifetimeProfile,
  PROFILE_FILENAME,
  readProfile,
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
  it("publishes 600 s for 30 qualifying gaps and keeps the default below 20 samples", () => {
    const root = sessionsRoot();
    writeSession(root, "session.jsonl", gapChain());

    const scan = scanLedgers(5000, [root]);
    expect(scan.files).toBe(1);
    expect(scan.exceededBudget).toBe(false);
    const samples = scan.models[MODEL];
    expect(samples).toBeDefined();
    expect(samples?.gaps).toHaveLength(30);

    const result = estimate(samples?.gaps ?? []);
    expect(result.lifetimeSeconds).toBe(600);
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
