/**
 * Behavior spec for the release guard (scripts/release-guard.ts).
 *
 * This module is the only thing standing between a tag and an npm publish under
 * the owner's identity, so the negatives matter as much as the positives: every
 * refusal below is a release that must NOT happen.
 */
import { describe, expect, it } from "vitest";
import { compareVersions, decideRelease, parseArgs, parseVersion } from "../../scripts/release-guard.ts";

const OWNER = "zenodinh";

function decide(overrides: Partial<Parameters<typeof decideRelease>[0]> = {}) {
  return decideRelease({ tag: "v0.0.12", actor: OWNER, owner: OWNER, npmLatest: "0.0.11", ...overrides });
}

describe("decideRelease — who may publish", () => {
  it("authorizes the owner and refuses anyone else, whatever the tag", () => {
    expect(decide().ok).toBe(true);
    expect(decide().version).toBe("0.0.12");

    const contributor = decide({ actor: "Qiiks" });
    expect(contributor.ok).toBe(false);
    expect(contributor.reason).toContain("only 'zenodinh' may publish");
    // A contributor with a perfectly valid, newer tag is still refused.
    expect(decide({ actor: "Qiiks", tag: "v9.9.9" }).ok).toBe(false);
  });

  it("accepts a full tag ref as well as a bare tag name", () => {
    expect(decide({ tag: "refs/tags/v0.0.12" }).version).toBe("0.0.12");
  });
});

describe("decideRelease — what may be published", () => {
  it("refuses a tag that is not a release version", () => {
    for (const tag of ["main", "v1", "v1.2", "v1.2.3.4", "release-1", "V0.0.12", "v0.0.12 ", ""]) {
      expect(decide({ tag }).ok, `expected refusal for "${tag}"`).toBe(false);
    }
    expect(decide({ tag: "v1.2" }).reason).toContain("not a release tag");
  });

  it("accepts prerelease and build metadata forms", () => {
    expect(decide({ tag: "v0.0.12-rc.1" }).version).toBe("0.0.12-rc.1");
    expect(decide({ tag: "v0.99.0+build.4" }).version).toBe("0.99.0+build.4");
  });

  it("refuses to publish a version older than npm's newest", () => {
    const older = decide({ tag: "v0.0.9", npmLatest: "0.0.11" });
    expect(older.ok).toBe(false);
    expect(older.reason).toContain("would move the `latest` dist-tag backwards");
  });

  it("allows a version equal to npm's newest so a re-run stays idempotent", () => {
    const same = decide({ tag: "v0.0.11", npmLatest: "0.0.11", alreadyPublished: true });
    expect(same.ok).toBe(true);
    expect(same.reason).toContain("already on npm");
    expect(same.reason).toContain("Re-running a tag is safe");
  });

  it("allows a big jump, which is how skipped versions happen", () => {
    const jump = decide({ tag: "v0.99.0", npmLatest: "0.0.11" });
    expect(jump.ok).toBe(true);
    expect(jump.version).toBe("0.99.0");
  });

  it("allows a first-ever publish when nothing is on npm yet", () => {
    expect(decide({ npmLatest: undefined }).ok).toBe(true);
  });
});

describe("compareVersions", () => {
  it("orders core versions numerically, not lexically", () => {
    expect(compareVersions("0.0.9", "0.0.11")).toBe(-1);
    expect(compareVersions("0.0.11", "0.0.9")).toBe(1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.0.11", "0.0.11")).toBe(0);
  });

  it("sorts a prerelease below its release and ignores build metadata", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
  });

  it("never lets a malformed string compare as newer", () => {
    expect(parseVersion("nope")).toBeUndefined();
    expect(compareVersions("nope", "0.0.1")).toBe(-1);
    expect(compareVersions("nope", "also-nope")).toBe(0);
  });
});

describe("cli", () => {
  it("validates argv at the boundary", () => {
    expect(parseArgs(["--tag", "v0.0.12", "--actor", "zenodinh", "--owner", "zenodinh"])).toEqual({
      tag: "v0.0.12",
      actor: "zenodinh",
      owner: "zenodinh",
      npmLatest: undefined,
      alreadyPublished: false,
    });
    expect(
      parseArgs(["--tag", "v1", "--actor", "a", "--owner", "o", "--npm-latest", "0.0.1", "--already-published"]),
    ).toMatchObject({
      npmLatest: "0.0.1",
      alreadyPublished: true,
    });
    expect(() => parseArgs(["--tag", "v0.0.12"])).toThrow(/is required/);
    expect(() => parseArgs(["--tag", "v0.0.12", "--actor", "a", "--owner", "o", "--nope", "x"])).toThrow(
      /unknown argument/,
    );
    expect(() => parseArgs(["--tag"])).toThrow(/missing value/);
  });
});
