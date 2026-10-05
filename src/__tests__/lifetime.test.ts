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
