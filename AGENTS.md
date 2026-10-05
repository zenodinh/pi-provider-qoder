# AGENTS.md

Working rules for this repository. The [README](./README.md) is the public
product document — what the extension is, and how someone installs and uses it.
This file holds what only a person *changing* the repo needs: the commands, the
gates a pull request must pass, the release process, and the host contracts that
have to be re-checked when pi moves.

## Repository map

- `src/` — the extension. `index.ts` is the pi entry; `protocol/` holds the
  Qoder wire formats and transforms; `auth/`, `commands/` (slash commands and
  TUI panels), and the caching, pricing and host-seam modules sit beside them.
- `src/__tests__/` — the offline suite. `src/__fixtures__/` — recorded protocol
  fixtures. Neither ships to npm (see [What publishes](#what-publishes)).
- `scripts/` — first-party CI tooling: the changed-line coverage gate, the
  security scanner, the release guard, and the diff/lock readers they share.
- `.github/workflows/` — `ci.yml` gates every pull request; `release.yml` is the
  only path to npm.

## Local development

```bash
npm install
npm test           # run the offline unit suite (replays recorded fixtures)
npm run test:coverage  # the same suite plus coverage/lcov.info
npm run test:live  # re-record live protocol fixtures (needs QODER_PAT / QODERCN_PAT)
pi -e ./src/index.ts  # load the extension from source in pi
```

See [`src/__fixtures__/live/README.md`](https://github.com/zenodinh/pi-provider-qoder/blob/main/src/__fixtures__/live/README.md) for the fixture format and how to re-record it.

## What publishes

`package.json`'s `files` allowlist ships `src/` and `README.md` only, minus the
test suite and the recorded fixtures:

```json
"files": ["src", "README.md", "!src/__tests__", "!src/__fixtures__"]
```

The test suite and fixtures are development-only: they run under `npm test` in
CI, but a user installing the package has no use for them. npm's `!` entries keep
the whole allowlist in one place, and `pi.extensions` (`./src/index.ts`) stays
inside it — `src/__tests__/package.test.ts` pins both facts. There is no build
step: pi loads TypeScript through jiti, so `src/` *is* the published artifact and
`dist/` is never shipped.

## CI gates

Every pull request runs two gates on top of lint, types and the test suite. Both
are first-party TypeScript under `scripts/` — no third-party action and no SaaS —
because a gate that runs on untrusted PR code must not have a supply chain of
its own.

**Changed-line coverage (80%).** `scripts/coverage-diff.ts` reads
`coverage/lcov.info` and the PR's diff, then asks the only question a reviewer
cannot answer by eye: of the *executable* lines this change adds, how many did a
test actually run? Below 80% the build fails. Scope is the published artifact
(`src/**` minus `__tests__` and `__fixtures__`, matching `package.json`'s
`files`), types and comments stay out of the denominator, and a changed file no
test ever loaded fails on its own instead of being averaged away. Pushes to
`main` report the same number without failing, because by then the merge has
happened.

**Security scan.** `scripts/security-scan.ts` fails the build on the patterns
that carry real risk for an extension that holds a job token and forges request
signatures:

| Family | Blocks on | Advises on |
| --- | --- | --- |
| `SRC-*` | dynamic code execution (`eval`, `new Function`, `child_process`), an outbound host that is not a Qoder domain, cleartext `http://`, a credential-shaped `process.env` read | any other `process.env` read, filesystem writes |
| `WF-*` | `pull_request_target`, a new `secrets.` reference, a write permission, an action not pinned to a 40-hex SHA | |
| `MANIFEST-*` / `LOCK-*` | an added or changed npm lifecycle script, a `resolved` URL outside `registry.npmjs.org`, a git/file/link source, a changed `integrity` on a known package, a new package with an install script | any dependency-set change, a changed non-lifecycle script, new lock entries, an install script that cannot be compared to a baseline |
| `PATH-*` | | credential, signing, transport, dependency or CI plumbing touched at all |

The security job installs nothing — Node runs the scanner through its built-in
type stripping — so `npm ci` cannot execute a PR's install scripts before the
scan sees them. And when a diff touches the scanner or the workflows, the scan
runs the **base** revision of the scanner rather than the one the PR supplies,
so a change cannot weaken its own judge. Baselines are optional by design: with
no base manifest, the base-relative rules degrade to a loud warning instead of
reporting every script as newly added.

Run either gate locally:

```bash
git diff --unified=0 origin/main...HEAD > /tmp/changes.patch
npm run test:coverage
npm run coverage:diff -- --diff /tmp/changes.patch --lcov coverage/lcov.info

git show origin/main:package.json > /tmp/base-package.json
git show origin/main:package-lock.json > /tmp/base-lock.json
npm run scan -- --diff /tmp/changes.patch \
  --base-manifest /tmp/base-package.json --head-manifest package.json \
  --base-lock /tmp/base-lock.json --head-lock package-lock.json
```

Baselines are ordinary files, not process substitutions: `<(...)` hands the
scanner a `/dev/fd/N` path that is already closed by the time npm's child shell
runs, and the comparison is then skipped. The scanner says so on stderr rather
than exiting green in silence.

`src/__tests__/**` and `src/__fixtures__/**` are out of `SRC-*` scope — a
fixture legitimately quotes the text those rules look for, and a per-line bypass
comment would be a hole any contributor could use. Contributor test code still
runs under `npm test`, so on an untrusted branch read the diff first and let CI
run the tests on an ephemeral runner with a read-only token.

Around these gates, the repo also relies on GitHub-side controls that live in
settings rather than in files: CodeQL code scanning, secret scanning with push
protection, Dependabot alerts (`.github/dependabot.yml` drives the update PRs),
and a ruleset on `main` requiring both checks plus a code-owner review — without
that ruleset, a direct push to `main` reaches the npm publish path unchecked.

## Releasing

Releases are **tag-triggered and owner-only**, and the **tag is the only version
source** — `package.json` carries no `version` field at all, so there is nothing
on `main` to drift and no string a contributor can edit to publish.

**From the web UI, no terminal:**

1. **Releases → Draft a new release**.
2. Under *Choose a tag*, type the version you want — `v0.0.12`, or `v0.99.0` to skip ahead. GitHub creates the tag when you publish.
3. Target `main`, add notes (or click *Generate release notes*), then **Publish release**.

**From the terminal, the same thing:**

```bash
git switch main && git pull
git tag -a v0.0.12 -m "0.0.12" && git push origin v0.0.12
```

A tag ruleset restricting `v*` creation to admins is the second layer behind the
workflow's actor check (Settings → Rules → Rulesets → New ruleset → target
**Tag**).

The [Release workflow](https://github.com/zenodinh/pi-provider-qoder/blob/main/.github/workflows/release.yml)
then refuses any actor but the owner, refuses a tag that is not
`v<major>.<minor>.<patch>` with an optional `-prerelease`, and refuses a version
older than npm's newest — publishing one would move the `latest` dist-tag
backwards for every user. That decision lives in `scripts/release-guard.ts`,
unit-tested rather than embedded in shell. When it authorizes, the workflow
stamps `package.json` from the tag, asserts npm ≥ 11.5.1 (the Trusted Publishing
floor; Node 26 ships 11.16.0, so nothing is installed over it), re-runs
lint/types/tests, publishes with `--provenance` through Trusted Publishing
(OIDC, no `NPM_TOKEN`), and attaches the tarball to the GitHub Release.
Publishing the same tag again is safe: the publish is skipped and only the
Release assets refresh.

**Skipping versions is normal.** Nothing has to exist between two releases — pi
published 0.87.1 on 2026-09-22 and then 0.99.0 on 2026-09-29, with 0.88 through
0.98 never on npm at all.

**Why the manifest has no `version` field.** A committed version could only
drift: it would read one number on `main` while npm served another, and a
contributor "fixing" it would publish nothing. The workflow's *Stamp the version
from the tag* step runs `npm version --no-git-tag-version "$VERSION"` inside the
runner, writing the version into `package.json` **and** the lockfile before
lint, types, tests and publish — so the tarball on npm always carries the tag's
number while the repository never shows a stale one. The cost is local:
`npm pack` and `npm publish` on an unstamped checkout fail with
`Invalid package, must have name and version`. Release from a tag, not from a
working copy.

The first-ever npm publish is manual: npm requires the package to exist before a
trusted publisher can be configured. The trusted publisher binds
organization/user, repository, **workflow filename** and optional environment —
not a branch or tag — so changing the trigger does not disturb provenance as
long as the file stays `release.yml`.

## Contracts to re-check after upgrading pi

The retry classifier and the compat facade are host-owned prose and symbols this
provider does not control, so a pi upgrade is a contract review, not just a
version bump. Re-check:

- the **host seam module** — the single place the two pi-compat symbols
  (`openAICompletionsApi`, `registerApiProvider`) are acquired, and where a
  renamed or deleted facade becomes a named error instead of a silent break;
- the **parity suite** (`src/__tests__/wire-vocabulary.test.ts`,
  `src/__tests__/error-vocabulary.test.ts`) — body, header and event
  vocabularies plus every rendered error text;
- the **retry patterns** in `@earendil-works/pi-ai/utils/retry` — an upstream
  edit to that alternation silently changes which failures this provider
  retries, and the executed verdict table in
  `src/__tests__/error-vocabulary.test.ts` is where the change shows;
- the **history-repair dependency** (`src/protocol/transform.ts`) — errored and
  aborted turns are dropped before dispatch by this repo, not by pi, and the
  cache-neutral retry rotation rests on it.

## Conventions

- **The published docs are pinned by tests.** `README.md` ships to npm, so the
  text a user reads is asserted in `src/__tests__/retry-docs.test.ts` and
  `src/__tests__/package.test.ts`. Move a pinned sentence out of the README and
  the suite fails — update the pin in the same change, as this file's
  [Releasing](#releasing) and [Contracts to re-check](#contracts-to-re-check-after-upgrading-pi)
  sections do.
- **This file is not published.** `files` ships `src/` and `README.md` only, so
  repo rules stay out of the user's install.
- **Conventional commits**, one logical change per commit, pull requests only —
  `main` takes no direct push.
