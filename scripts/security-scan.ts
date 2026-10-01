/**
 * PR security scanner: the mechanical floor for accepting outside contributions.
 *
 * A human reviewer cannot reliably spot an exfiltration line inside 800 added
 * lines, and this extension is a bad target to get wrong — it holds a Qoder job
 * token, forges COSY request signatures, and is installed into a user's pi where
 * it runs with their credentials. This scanner fails the build on the small set
 * of patterns that actually carry that risk, and warns on the paths where a
 * human decision is unavoidable.
 *
 * It is deliberately first-party (no third-party action, no SaaS): a scanner
 * that runs on untrusted PR code must itself have no supply chain, and every
 * rule below is readable in one screen.
 *
 * Rule families
 *   SRC-*   added lines under `src/**` — the published artifact that runs in a
 *           user's pi with their credential.
 *   WF-*    added lines under `.github/workflows/**` — the only place a PR can
 *           reach GitHub tokens or the npm publish path.
 *   MANIFEST-* / LOCK-*  `package.json` and `package-lock.json` compared
 *           base-vs-head — dependency identity, install scripts, registries.
 *   PATH-*  high-risk path touched at all (warn): credential, signing,
 *           transport and CI plumbing that deserves a second pair of eyes.
 *
 * Not covered, and why: taint tracking (CodeQL does that, already enabled on
 * this repo), dependency vulnerabilities (Dependabot), and secrets in the diff
 * (GitHub secret scanning + push protection). This scanner only answers "did
 * this diff add a dangerous construct or change the supply chain".
 */
// shape: pure rule functions over parsed inputs → findings array; no state, no
//   I/O beyond `main` reading the files CI already produced.
import { readFileSync } from "node:fs";
import { parseUnifiedDiff } from "./diff.ts";

export type Severity = "fail" | "warn";

export interface Finding {
  severity: Severity;
  rule: string;
  file: string;
  /** 1-based line in the post-image, when the finding is line-attributed. */
  line?: number;
  detail: string;
}

export interface ScanInput {
  diffText: string;
  baseManifestText?: string;
  headManifestText?: string;
  baseLockText?: string;
  headLockText?: string;
}

/* ── Allowlists ──────────────────────────────────────────────────────── */

/**
 * Outbound destinations this provider legitimately talks to, expressed as
 * registered domains so a new Qoder subdomain does not need a scanner change —
 * while any non-Qoder host a PR introduces is a new exfiltration destination
 * and fails.
 */
const ALLOWED_SOURCE_HOST_DOMAINS = ["qoder.sh", "qoder.com", "qoder.com.cn"];
/** The only registry a lockfile entry may resolve from. */
const ALLOWED_LOCK_HOST = "registry.npmjs.org";

/**
 * Tests and recorded fixtures are out of `SRC-*` scope, for the same reason they
 * are out of the coverage gate's scope: a fixture legitimately *quotes* the text
 * these rules look for (`eval(`, an attacker host, a credential env read), and
 * the alternative — a per-line bypass comment — would hand every contributor a
 * hole in the gate. Contributor test code still executes on a maintainer machine
 * under `npm test`, so the practice is: review the diff first, and let CI run an
 * untrusted branch's tests on an ephemeral runner with a read-only token.
 */
const SRC_SCOPE_EXCLUDED = /^src\/(?:__tests__|__fixtures__)\//;

/** Paths whose change warrants human attention even when no pattern fires. */
const HIGH_RISK_PATHS = [
  /^\.github\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^scripts\//,
  /^tsconfig\.json$/,
  /^biome\.json$/,
  /^vitest\.config\.ts$/,
  /^src\/cosy\.ts$/,
  /^src\/http\.ts$/,
  /^src\/home\.ts$/,
  /^src\/region\.ts$/,
  /^src\/auth\//,
  /^src\/protocol\/encoding\.ts$/,
  /^src\/protocol\/request\.ts$/,
];

/** npm lifecycle hooks: these run without anybody invoking them. */
const LIFECYCLE_SCRIPT =
  /^(?:pre|post)?(?:install|prepare|pack|publish|publishOnly|uninstall|restart|start|test|version)$/;

const CODE_EXECUTION =
  /\beval\s*\(|new\s+Function\s*\(|\bchild_process\b|\bnode:child_process\b|process\.binding\s*\(|process\.dlopen|\bnode:vm\b|\bvm\.runIn/;
const URL_LITERAL = /https?:\/\/([A-Za-z0-9._-]+)/g;
const PLAINTEXT_HTTP = /http:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/;
const CREDENTIAL_ENV =
  /process\.env\s*(?:\.|\[\s*["'`])\s*[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|COOKIE|PRIVATE)[A-Za-z0-9_]*/;
const ANY_ENV_READ = /process\.env\b/;
// `Sync` suffixes must stay inside the match: `\bwriteFile\b` cannot match
// `writeFileSync`, because there is no word boundary before `Sync`.
const FS_WRITE = /\b(?:writeFile|appendFile|copyFile|createWriteStream|rm|unlink|rename|mkdir|truncate)(?:Sync)?\b/;
const WORKFLOW_USES = /^\s*(?:-\s*)?uses:\s*["']?([^"'\s#]+)/;
const WORKFLOW_WRITE_PERMISSION =
  /^\s*#?\s*(?:id-token|contents|packages|actions|deployments|statuses|pull-requests|issues)\s*:\s*write/;

/* ── Boundary narrowing ──────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readBooleanField(source: unknown, key: string): boolean | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

/** `JSON.parse` → `unknown`, narrowed before any field is read. */
function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isAllowedSourceHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/:\d+$/, "");
  return ALLOWED_SOURCE_HOST_DOMAINS.some((domain) => bare === domain || bare.endsWith(`.${domain}`));
}

/* ── Rule: added source lines ────────────────────────────────────────── */

function scanSourceFile(path: string, added: readonly { no: number; text: string }[]): Finding[] {
  const findings: Finding[] = [];
  const warned = new Set<string>();
  const warnOnce = (rule: string, detail: string, line: number): void => {
    if (warned.has(rule)) return;
    warned.add(rule);
    findings.push({ severity: "warn", rule, file: path, line, detail });
  };

  for (const { no, text } of added) {
    if (CODE_EXECUTION.test(text)) {
      findings.push({
        severity: "fail",
        rule: "SRC-CODE-EXECUTION",
        file: path,
        line: no,
        detail: `dynamic code execution or subprocess spawn in the published artifact: ${text.trim().slice(0, 140)}`,
      });
    }
    if (PLAINTEXT_HTTP.test(text)) {
      findings.push({
        severity: "fail",
        rule: "SRC-PLAINTEXT-URL",
        file: path,
        line: no,
        detail: `cleartext http:// destination (credential or prompt would travel unencrypted): ${text.trim().slice(0, 140)}`,
      });
    }
    for (const match of text.matchAll(URL_LITERAL)) {
      const host = match[1].toLowerCase();
      if (host.length === 0 || isAllowedSourceHost(host)) continue;
      findings.push({
        severity: "fail",
        rule: "SRC-NEW-OUTBOUND-HOST",
        file: path,
        line: no,
        detail: `new outbound host "${host}" — not a Qoder domain. If legitimate, add it to ALLOWED_SOURCE_HOST_DOMAINS in scripts/security-scan.ts in the same PR so the addition is reviewed.`,
      });
    }
    if (CREDENTIAL_ENV.test(text)) {
      findings.push({
        severity: "fail",
        rule: "SRC-CREDENTIAL-ENV",
        file: path,
        line: no,
        detail: `reads a credential-shaped environment variable: ${text.trim().slice(0, 140)}`,
      });
    } else if (ANY_ENV_READ.test(text)) {
      warnOnce("SRC-ENV-READ", "reads process.env — confirm the variable is one this extension documents", no);
    }
    if (FS_WRITE.test(text)) {
      warnOnce("SRC-FS-WRITE", "writes to the filesystem — confirm the target is the pi agent dir", no);
    }
  }

  return findings;
}

/* ── Rule: workflow files ────────────────────────────────────────────── */

function scanWorkflowFile(path: string, added: readonly { no: number; text: string }[]): Finding[] {
  const findings: Finding[] = [];
  for (const { no, text } of added) {
    if (/^\s*#/.test(text)) continue; // a commented-out line grants nothing
    if (/pull_request_target/.test(text)) {
      findings.push({
        severity: "fail",
        rule: "WF-PULL-REQUEST-TARGET",
        file: path,
        line: no,
        detail: "pull_request_target runs the base workflow with write tokens against untrusted PR code",
      });
    }
    if (/\bsecrets\s*\./.test(text)) {
      findings.push({
        severity: "fail",
        rule: "WF-SECRETS-ACCESS",
        file: path,
        line: no,
        detail: `new secret reference: ${text.trim().slice(0, 140)}`,
      });
    }
    if (WORKFLOW_WRITE_PERMISSION.test(text)) {
      findings.push({
        severity: "fail",
        rule: "WF-PERMISSION-ESCALATION",
        file: path,
        line: no,
        detail: `grants a write permission: ${text.trim().slice(0, 140)}`,
      });
    }
    const uses = WORKFLOW_USES.exec(text);
    if (uses) {
      const ref = uses[1];
      const pinned = /^[^@]+@[0-9a-f]{40}$/i.test(ref);
      if (!pinned && !ref.startsWith("./")) {
        findings.push({
          severity: "fail",
          rule: "WF-UNPINNED-ACTION",
          file: path,
          line: no,
          detail: `"${ref}" is a mutable ref. Pin the full commit SHA (gh api repos/<owner>/<repo>/git/ref/tags/<tag>), or use a local ./ step.`,
        });
      }
    }
  }
  return findings;
}

/* ── Rule: package.json ──────────────────────────────────────────────── */

function scriptsOf(manifest: Record<string, unknown> | undefined): Record<string, string> {
  const scripts = manifest?.scripts;
  if (!isRecord(scripts)) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function depsOf(manifest: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const block = manifest?.[field];
    if (!isRecord(block)) continue;
    for (const [name, value] of Object.entries(block)) {
      if (typeof value === "string") result[name] = value;
    }
  }
  return result;
}

export function scanManifest(baseText: string | undefined, headText: string | undefined): Finding[] {
  const head = parseJson(headText);
  if (head === undefined) return [];
  const base = parseJson(baseText);
  // Without a baseline every script and dependency would look "added", which
  // manufactures failures. Degrade loudly instead of guessing.
  if (base === undefined) {
    return [
      {
        severity: "warn",
        rule: "MANIFEST-BASELINE-MISSING",
        file: "package.json",
        detail: "no base manifest to compare against — lifecycle-script and dependency rules skipped for this run",
      },
    ];
  }
  const findings: Finding[] = [];
  const file = "package.json";

  // Releases are tag-triggered and the tag decides the published version, so a
  // bump in a pull request publishes nothing: this advises rather than blocks.
  // It exists so the reviewer sees that a contributor touched the version, and
  // so the number is not mistaken for the next release.
  const baseVersion = readStringField(base, "version");
  const headVersion = readStringField(head, "version");
  if (baseVersion !== undefined && headVersion !== undefined && baseVersion !== headVersion) {
    findings.push({
      severity: "warn",
      rule: "MANIFEST-VERSION-BUMP",
      file,
      detail: `root version ${baseVersion} -> ${headVersion}. Inert: releases are tag-triggered and the tag decides the published version, so this publishes nothing and package.json on main is not authoritative.`,
    });
  }

  const baseScripts = scriptsOf(base);
  const headScripts = scriptsOf(head);
  for (const [name, value] of Object.entries(headScripts)) {
    if (!LIFECYCLE_SCRIPT.test(name)) continue;
    if (baseScripts[name] === value) continue;
    findings.push({
      severity: "fail",
      rule: "MANIFEST-LIFECYCLE-SCRIPT",
      file,
      detail: `script "${name}" ${name in baseScripts ? "changed" : "added"}: npm or CI executes it without anybody invoking it by hand ("${value.slice(0, 120)}")`,
    });
  }

  const changedScripts = Object.entries(headScripts).filter(
    ([name, value]) => !LIFECYCLE_SCRIPT.test(name) && baseScripts[name] !== value,
  );
  if (changedScripts.length > 0) {
    findings.push({
      severity: "warn",
      rule: "MANIFEST-SCRIPT-CHANGED",
      file,
      detail: `non-lifecycle script(s) changed: ${changedScripts.map(([name]) => name).join(", ")}`,
    });
  }

  const baseDeps = depsOf(base);
  const headDeps = depsOf(head);
  const added = Object.entries(headDeps).filter(([name, spec]) => baseDeps[name] !== spec);
  const removed = Object.keys(baseDeps).filter((name) => !(name in headDeps));
  if (added.length > 0 || removed.length > 0) {
    findings.push({
      severity: "warn",
      rule: "MANIFEST-DEPENDENCY-CHANGED",
      file,
      detail:
        `dependency set changed — added/updated: ${added.map(([name, spec]) => `${name}@${spec}`).join(", ") || "none"};` +
        ` removed: ${removed.join(", ") || "none"}. Check for typosquats and for install scripts in the lock findings below.`,
    });
  }

  return findings;
}

/* ── Rule: package-lock.json ─────────────────────────────────────────── */

function packagesOf(lock: Record<string, unknown> | undefined): Record<string, unknown> {
  const packages = lock?.packages;
  return isRecord(packages) ? packages : {};
}

export function scanLockfile(baseText: string | undefined, headText: string | undefined): Finding[] {
  const baseParsed = parseJson(baseText);
  const base = packagesOf(baseParsed);
  const head = packagesOf(parseJson(headText));
  if (Object.keys(head).length === 0) return [];
  const findings: Finding[] = [];
  const file = "package-lock.json";
  const addedNames: string[] = [];
  const unverifiedInstallScripts = new Set<string>();
  // Registry, source and link rules are per-entry and need no baseline; the
  // "new package" and "integrity changed" rules do, so they are skipped rather
  // than reported against an empty base.
  const hasBaseline = baseParsed !== undefined;
  if (!hasBaseline) {
    findings.push({
      severity: "warn",
      rule: "LOCK-BASELINE-MISSING",
      file,
      detail: "no base lockfile to compare against — new-package and integrity-change rules skipped for this run",
    });
  }

  for (const [key, entry] of Object.entries(head)) {
    if (key === "") continue; // the root project entry
    const previous = base[key];
    const resolved = readStringField(entry, "resolved");
    const name = key.split("node_modules/").pop() ?? key;

    if (resolved !== undefined) {
      const host = hostOf(resolved);
      if (host !== ALLOWED_LOCK_HOST) {
        findings.push({
          severity: "fail",
          rule: "LOCK-NON-NPM-REGISTRY",
          file,
          detail: `"${name}" resolves from ${host ?? resolved} instead of ${ALLOWED_LOCK_HOST}`,
        });
      }
    }
    if (resolved !== undefined && /^(?:git\+|file:|link:|github:)/.test(resolved)) {
      findings.push({
        severity: "fail",
        rule: "LOCK-NON-REGISTRY-SOURCE",
        file,
        detail: `"${name}" resolves from a non-registry source: ${resolved}`,
      });
    }
    if (readBooleanField(entry, "link") === true) {
      findings.push({
        severity: "fail",
        rule: "LOCK-LINKED-PACKAGE",
        file,
        detail: `"${name}" is a link: entry — it installs from a local path, not the registry`,
      });
    }

    const previousIntegrity = readStringField(previous, "integrity");
    const integrity = readStringField(entry, "integrity");
    if (previousIntegrity !== undefined && integrity !== undefined && previousIntegrity !== integrity) {
      findings.push({
        severity: "fail",
        rule: "LOCK-INTEGRITY-CHANGED",
        file,
        detail: `"${name}" integrity changed without the entry being added — the resolved tarball for a known package is different`,
      });
    }

    if (previous === undefined && hasBaseline) {
      addedNames.push(name);
      if (readBooleanField(entry, "hasInstallScript") === true) {
        findings.push({
          severity: "fail",
          rule: "LOCK-NEW-INSTALL-SCRIPT",
          file,
          detail: `new package "${name}" runs an install script — arbitrary code execution during npm ci`,
        });
      }
    } else if (previous === undefined && readBooleanField(entry, "hasInstallScript") === true) {
      // No baseline: an install script is still worth a human look. The lock
      // can carry the same package at several paths, so collapse by name.
      unverifiedInstallScripts.add(name);
    }
  }

  if (unverifiedInstallScripts.size > 0) {
    const names = [...unverifiedInstallScripts].sort();
    findings.push({
      severity: "warn",
      rule: "LOCK-INSTALL-SCRIPT-UNVERIFIED",
      file,
      detail: `${names.length} package(s) run an install script and no baseline was available to tell whether they are new: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}`,
    });
  }

  if (addedNames.length > 0) {
    findings.push({
      severity: "warn",
      rule: "LOCK-NEW-PACKAGES",
      file,
      detail: `${addedNames.length} new lock entr${addedNames.length === 1 ? "y" : "ies"}: ${addedNames.slice(0, 8).join(", ")}${addedNames.length > 8 ? ", …" : ""}`,
    });
  }

  return findings;
}

/* ── Aggregation ─────────────────────────────────────────────────────── */

export function scanPullRequest(input: ScanInput): Finding[] {
  const files = parseUnifiedDiff(input.diffText);
  const findings: Finding[] = [];
  const touched: string[] = [];

  for (const file of files) {
    touched.push(file.path);
    if (file.fromPath !== undefined) touched.push(file.fromPath);
    if (file.isDeleted || file.isBinary) continue;
    if (file.path.startsWith("src/") && !SRC_SCOPE_EXCLUDED.test(file.path)) {
      findings.push(...scanSourceFile(file.path, file.added));
    } else if (file.path.startsWith(".github/workflows/")) {
      findings.push(...scanWorkflowFile(file.path, file.added));
    }
  }

  findings.push(...scanManifest(input.baseManifestText, input.headManifestText));
  findings.push(...scanLockfile(input.baseLockText, input.headLockText));

  const risky = [...new Set(touched)].filter((path) => HIGH_RISK_PATHS.some((pattern) => pattern.test(path))).sort();
  if (risky.length > 0) {
    findings.push({
      severity: "warn",
      rule: "PATH-HIGH-RISK",
      file: risky.join(", "),
      detail: "credential, signing, transport, dependency or CI plumbing changed — review these paths line by line",
    });
  }

  return findings;
}

export function exitCodeFor(findings: readonly Finding[]): number {
  return findings.some((finding) => finding.severity === "fail") ? 1 : 0;
}

export function formatFindings(findings: readonly Finding[], format: "text" | "github" = "text"): string {
  const fails = findings.filter((finding) => finding.severity === "fail");
  const warns = findings.filter((finding) => finding.severity === "warn");

  if (format === "github") {
    const lines: string[] = [];
    for (const finding of fails) {
      const at = finding.line === undefined ? "" : `:${finding.line}`;
      lines.push(`::error title=${finding.rule} file=${finding.file}${at}::${finding.detail}`);
    }
    for (const finding of warns) {
      lines.push(`::warning title=${finding.rule}::${finding.file}: ${finding.detail}`);
    }
    lines.push(`Security scan: ${fails.length} blocking, ${warns.length} advisory.`);
    return lines.join("\n");
  }

  const lines: string[] = [`Security scan: ${fails.length} blocking, ${warns.length} advisory`];
  for (const finding of [...fails, ...warns]) {
    const at = finding.line === undefined ? "" : `:${finding.line}`;
    lines.push(`  [${finding.severity.toUpperCase().padEnd(4)}] ${finding.rule} — ${finding.file}${at}`);
    lines.push(`         ${finding.detail}`);
  }
  if (findings.length === 0) lines.push("  no rule fired on this diff");
  lines.push(fails.length > 0 ? "RESULT: FAIL" : "RESULT: PASS");
  return lines.join("\n");
}

export interface CliOptions {
  diff: string;
  baseManifest?: string;
  headManifest?: string;
  baseLock?: string;
  headLock?: string;
  format: "text" | "github";
}

/** boundary: argv is untrusted text → each flag validated, unknown flags throw. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { diff: "", format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    index += 1;
    if (arg === "--diff") options.diff = value;
    else if (arg === "--base-manifest") options.baseManifest = value;
    else if (arg === "--head-manifest") options.headManifest = value;
    else if (arg === "--base-lock") options.baseLock = value;
    else if (arg === "--head-lock") options.headLock = value;
    else if (arg === "--format") {
      if (value !== "text" && value !== "github")
        throw new Error(`--format must be "text" or "github", got "${value}"`);
      options.format = value;
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (options.diff === "") throw new Error("--diff <patch-file> is required (git diff --unified=0 <base>...HEAD)");
  return options;
}

/**
 * Read a baseline artifact. A declared-but-unreadable path is reported rather
 * than swallowed: a silently skipped comparison is the worst failure mode a
 * gate has, because the build still looks green.
 */
export function readBaseline(path: string | undefined, notes: string[]): string | undefined {
  if (path === undefined) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    if (text.trim().length === 0) {
      notes.push(`baseline "${path}" is empty — the rules that compare against it are skipped`);
    }
    return text;
  } catch {
    notes.push(`baseline "${path}" could not be read — the rules that compare against it are skipped`);
    return undefined;
  }
}

export function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const notes: string[] = [];
  const findings = scanPullRequest({
    diffText: readFileSync(options.diff, "utf8"),
    baseManifestText: readBaseline(options.baseManifest, notes),
    headManifestText: readBaseline(options.headManifest, notes),
    baseLockText: readBaseline(options.baseLock, notes),
    headLockText: readBaseline(options.headLock, notes),
  });
  console.log(formatFindings(findings, options.format));
  for (const note of notes) console.error(`note: ${note}`);
  if (options.baseManifest === undefined && options.headManifest === undefined) {
    console.error("note: manifest/lock rules skipped — pass --base-manifest/--head-manifest/--base-lock/--head-lock");
  }
  return exitCodeFor(findings);
}

const invokedDirectly = process.argv[1]?.endsWith("security-scan.ts") === true;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
