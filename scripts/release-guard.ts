/**
 * Release authority and version guard.
 *
 * The release workflow is deliberately thin: it asks this module whether a tag
 * may be published, and by whom. Keeping the decision here means it is typed,
 * unit-tested and runnable locally — the alternative is shell arithmetic inside
 * a YAML string that nobody can test until it publishes the wrong version.
 *
 * Policy (owner's decision, 2026-10-01):
 *   - the tag is the version source; `package.json` on main is not authoritative
 *     and is stamped from the tag inside the runner before publishing;
 *   - only the owner may release, whatever role a contributor holds;
 *   - a version already on npm is not an error (re-runs must stay idempotent),
 *     but a version *older* than npm's newest is refused — publishing it would
 *     move the `latest` dist-tag backwards for every user;
 *   - a contributor bumping `package.json` is inert: no tag, no release.
 */
// shape: pure decision function over a small input record — trigger #1 (one
//   input shape → one outcome, no state, no subclassing). The CLI wrapper only
//   reads argv and prints.

/** `v1.2.3`, `v1.2.3-rc.1`, `v1.2.3+build.4` — nothing else. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export interface ReleaseDecisionInput {
  /** Tag ref or bare tag name, from `github.ref_name` or `github.event.release.tag_name`. */
  tag: string;
  /** `github.actor` — whoever pushed the tag or published the release. */
  actor: string;
  /** The only login allowed to publish. */
  owner: string;
  /** Newest version on npm, or undefined when the package has nothing published. */
  npmLatest?: string;
  /** True when that exact version is already on npm. */
  alreadyPublished?: boolean;
}

export interface ReleaseDecision {
  ok: boolean;
  /** Version to publish, without the leading `v`. Present only when ok. */
  version?: string;
  reason: string;
}

/** Split a version into comparable numeric parts plus an optional prerelease. */
export function parseVersion(version: string): { core: number[]; prerelease?: string } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  };
}

/**
 * semver-flavoured comparison: -1 when a < b, 0 when equal, 1 when a > b.
 * A prerelease sorts below its release (1.0.0-rc.1 < 1.0.0). Build metadata is
 * ignored, as semver requires. Unparsable input compares as "less", so a guard
 * can never be talked into publishing by a malformed string.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return left === undefined && right === undefined ? 0 : -1;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** The whole policy, in one place, with a reason string fit for a CI annotation. */
export function decideRelease(input: ReleaseDecisionInput): ReleaseDecision {
  const tag = input.tag.replace(/^refs\/tags\//, "");

  if (input.actor !== input.owner) {
    return {
      ok: false,
      reason: `'${input.actor}' pushed ${tag}; only '${input.owner}' may publish.`,
    };
  }

  const match = RELEASE_TAG.exec(tag);
  if (!match) {
    return {
      ok: false,
      reason: `'${tag}' is not a release tag. Expected v<major>.<minor>.<patch> with an optional -prerelease.`,
    };
  }
  const version = tag.slice(1);

  if (input.npmLatest !== undefined && compareVersions(version, input.npmLatest) < 0) {
    return {
      ok: false,
      reason: `${version} is older than ${input.npmLatest}, the newest version on npm. Publishing it would move the \`latest\` dist-tag backwards for every user.`,
    };
  }

  if (input.alreadyPublished === true) {
    return {
      ok: true,
      version,
      reason: `${version} is already on npm — publish will be skipped, the GitHub Release and its tarball will still be refreshed. Re-running a tag is safe.`,
    };
  }

  return { ok: true, version, reason: `authorized: '${input.actor}' publishing ${version}` };
}

export interface CliOptions {
  tag: string;
  actor: string;
  owner: string;
  npmLatest?: string;
  alreadyPublished: boolean;
}

/** boundary: argv is untrusted text → each flag validated, unknown flags throw. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { tag: "", actor: "", owner: "", alreadyPublished: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--already-published") {
      options.alreadyPublished = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    index += 1;
    if (arg === "--tag") options.tag = value;
    else if (arg === "--actor") options.actor = value;
    else if (arg === "--owner") options.owner = value;
    else if (arg === "--npm-latest") options.npmLatest = value;
    else throw new Error(`unknown argument "${arg}"`);
  }
  for (const required of ["tag", "actor", "owner"] as const) {
    if (options[required] === "") throw new Error(`--${required} is required`);
  }
  return options;
}

export function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const decision = decideRelease({
    tag: options.tag,
    actor: options.actor,
    owner: options.owner,
    ...(options.npmLatest === undefined ? {} : { npmLatest: options.npmLatest }),
    alreadyPublished: options.alreadyPublished,
  });
  if (decision.ok) {
    console.log(decision.reason);
    console.log(`RELEASE_VERSION=${decision.version}`);
    return 0;
  }
  console.error(`::error::Release refused: ${decision.reason}`);
  return 1;
}

const invokedDirectly = process.argv[1]?.endsWith("release-guard.ts") === true;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
