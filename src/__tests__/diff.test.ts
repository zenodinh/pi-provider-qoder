/**
 * Behavior spec for the shared unified-diff reader (scripts/diff.ts).
 *
 * The contract both CI gates depend on: added-line *numbers* must be exact,
 * because a wrong number silently exempts a real change from the coverage gate
 * and hides a dangerous line from the security scanner.
 */
import { describe, expect, it } from "vitest";
import { changedPaths, parseUnifiedDiff } from "../../scripts/diff.ts";

/** Build a `--unified=0` patch: every listed line is an addition. */
function zeroContextPatch(file: string, addedLines: string[], startAt = 1): string {
  const body = addedLines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startAt},0 +${startAt},${addedLines.length} @@`,
    body,
    "",
  ].join("\n");
}

describe("parseUnifiedDiff", () => {
  it("attributes added line numbers from a --unified=0 patch", () => {
    const files = parseUnifiedDiff(zeroContextPatch("src/protocol/queue.ts", ["const a = 1;", "const b = 2;"], 41));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/protocol/queue.ts");
    expect(files[0].added).toEqual([
      { no: 41, text: "const a = 1;" },
      { no: 42, text: "const b = 2;" },
    ]);
    expect(files[0].isNew).toBe(false);
    expect(files[0].isDeleted).toBe(false);
  });

  it("keeps numbering correct with default 3-line context and multiple hunks", () => {
    const patch = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -8,6 +8,7 @@",
      " context one",
      " context two",
      " context three",
      "+added at eleven",
      " context four",
      " context five",
      " context six",
      "@@ -30,3 +31,4 @@",
      " later context",
      "+added at thirty-two",
      " trailing context",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files[0].added).toEqual([
      { no: 11, text: "added at eleven" },
      { no: 32, text: "added at thirty-two" },
    ]);
  });

  it("counts deletions without attributing them to the new image", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -5,2 +5,1 @@",
      "-removed line",
      "-another removed line",
      "+kept line",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files[0].deletedCount).toBe(2);
    // `+5,1`: the surviving line is new-image line 5 — deleted lines do not
    // advance the new-image counter, only context and added lines do.
    expect(files[0].added).toEqual([{ no: 5, text: "kept line" }]);
  });

  it("marks a new file, a deletion and a rename", () => {
    const created = parseUnifiedDiff(
      [
        "diff --git a/src/new.ts b/src/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1 @@",
        "+export const x = 1;",
        "",
      ].join("\n"),
    );
    expect(created[0].isNew).toBe(true);
    expect(created[0].path).toBe("src/new.ts");
    expect(created[0].added).toEqual([{ no: 1, text: "export const x = 1;" }]);

    const deleted = parseUnifiedDiff(
      [
        "diff --git a/src/old.ts b/src/old.ts",
        "deleted file mode 100644",
        "--- a/src/old.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const x = 1;",
        "",
      ].join("\n"),
    );
    expect(deleted[0].isDeleted).toBe(true);
    expect(deleted[0].added).toEqual([]);

    const renamed = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/b.ts",
        "similarity index 90%",
        "rename from src/a.ts",
        "rename to src/b.ts",
        "--- a/src/a.ts",
        "+++ b/src/b.ts",
        "@@ -3,0 +4 @@",
        "+moved and edited",
        "",
      ].join("\n"),
    );
    expect(renamed[0].path).toBe("src/b.ts");
    expect(renamed[0].fromPath).toBe("src/a.ts");
    expect(changedPaths(renamed)).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("flags a binary file and attributes no lines to it", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/__fixtures__/live/blob.bin b/src/__fixtures__/live/blob.bin",
        "Binary files a/src/__fixtures__/live/blob.bin and b/src/__fixtures__/live/blob.bin differ",
        "",
      ].join("\n"),
    );
    expect(files[0].isBinary).toBe(true);
    expect(files[0].added).toEqual([]);
  });

  it("attributes nothing for a pure-deletion hunk (+0,0)", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,3 +9,0 @@",
        "-one",
        "-two",
        "-three",
        "",
      ].join("\n"),
    );
    expect(files[0].added).toEqual([]);
    expect(files[0].deletedCount).toBe(3);
  });

  it("degrades to no attribution on a malformed hunk header instead of guessing", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ not a hunk header @@",
        "+orphan",
        "",
      ].join("\n"),
    );
    expect(files[0].added).toEqual([]);
  });

  it("ignores the 'no newline' marker", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1,2 @@",
        "-old tail",
        "+new tail",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(files[0].added).toEqual([{ no: 1, text: "new tail" }]);
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
