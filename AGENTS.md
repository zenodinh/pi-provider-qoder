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
pi -e ./src/index.ts  # load the extension from source in pi (see Dog fooding)
```

See [`src/__fixtures__/live/README.md`](https://github.com/zenodinh/pi-provider-qoder/blob/main/src/__fixtures__/live/README.md) for the fixture format and how to re-record it.

## Dog fooding (UAT against real Qoder)

Run this checkout inside pi against the live gateway **without touching the npm
install** — no `pi uninstall`, no settings edit:

```bash
pi -ne -e ./src/index.ts --list-models qoder   # the source, not the install
QODER_DEBUG=1 pi -ne -e ./src/index.ts --provider qoder --model qoder/<id> -p "Reply with exactly: OK"
```

`-ne` turns off extension discovery and `-e ./src/index.ts` loads this checkout.
Both flags matter: this provider is also installed as `npm:@zenodinh/pi-provider-qoder`
(see `pi list`), and with discovery left on pi loads that copy as well — the model
list does not say which of the two answered. `-ne` leaves the checkout as the only
extension in the process, so what you observe belongs to the code you are testing.
Authentication is your existing login in `~/.pi/agent/auth.json` — a dog-fooding
run needs no PAT.

Read the proof, not the answer. `QODER_DEBUG=1` appends each request's logical
body (pre-encoding, i.e. what Qoder receives) to
`~/.pi/agent/logs/qoder-debug/<sessionId>.jsonl`, where the `type:"request"`
record carries `body.parameters` and `body.messages`. For a turn whose model
advertises no output cap, that body must show `parameters` with
`enable_thinking` / `reasoning_effort` and **no `max_tokens`**,
`messages[0].role === "system"` with no `developer` role, and a
`prompt_cache_key`.

Re-recording the protocol fixtures is a different job with a different
requirement — a regional PAT supplied through the environment only, never a
file. See [`src/__fixtures__/live/README.md`](https://github.com/zenodinh/pi-provider-qoder/blob/main/src/__fixtures__/live/README.md).

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

## Wire protocol and request behaviour

The [README](./README.md) is the user guide — install, log in, pick a model, run a
command. The detail below is what a person *changing the transport* needs, so it
lives here rather than in the published text.

- **Request signing.** The provider rebuilds Qoder's COSY authorization: an
  AES-encrypted user blob + RSA-wrapped key, an MD5 signature over path/body, and
  machine-bound `Cosy-*` headers (client type, OS, machine id/token). The machine
  id is read from `~/.qoder/.auth/machine_id` or, if absent,
  `~/.pi/agent/qoder-machine-id` (created if missing).
- **SSE gateway.** Chat streams from the Qoder `/algo/.../agent_chat_generation`
  endpoint. Qoder wraps events in an outer envelope with a JSON-string `body`, and
  can send the `[DONE]` sentinel both bare and wrapped — both are handled, plus a
  body that stays open after the sentinel.
- **Agentic "runs".** Qoder groups billing/records per agentic run. The provider
  infers run boundaries from the message tail and reuses a run-scoped
  `request_set_id` + `business` (stable id/name, advancing `init` → `start` →
  `processing`) across tool rounds, so the Credit ledger shows one aggregated
  entry per user prompt instead of many tiny ones. The run-identity fixes are
  ungated; see `QODER_CORE_PLAN` below.
- **Tool calls.** Native structured `tool_calls` and DSML tool markup embedded in
  the text stream are both parsed into pi tool calls. Images returned by tools
  (e.g. screenshots, `read`) are forwarded to the model as data-URL image parts.
- **Prompt cache.** A stable session id derived from your user id + model keeps
  prompt-cache affinity across consecutive requests in a session: the legacy
  envelope carries it as `session_id`, and v2 carries it both in
  `metadata.context.session_id` and — matching qodercli's OpenAI-protocol
  convention — as `prompt_cache_key` plus `session_id` / `x-client-request-id` /
  `x-session-affinity` headers. Recorded traffic shows the server-side lifetime is
  minutes (no large re-bill was observed at a 1-5 minute idle gap; the first
  deaths appear at ~6 minutes), so the provider declares `promptCache.short` =
  300 s.
- **History repair.** Before sending, orphaned tool results, dropped
  (error/aborted) assistant turns, and placeholderless tool-call messages are
  repaired so Qoder never rejects a request with "tool must follow a message with
  tool_calls". `src/protocol/transform.ts` owns this, not pi.
- **Credential storage.** Credentials are managed by the host (pi uses
  `~/.pi/agent/`, or `PI_CODING_AGENT_DIR`; OMP uses its own store). Identity
  lookups are cached only in memory and never overwrite credentials;
  `auth.json` holds the exchanged credentials per provider plus the resolved user
  identity (`userID`/`email`/`name`/`machineID`).
- **Cache warming (opt-in).** With pi's `cacheWarming` setting **and** this
  extension's approval (`QODER_CACHE_WARM=1`, or `qoder-warm-approval.json` —
  env over file over off, re-evaluated at every decision), pi re-sends the last
  request with a one-token output cap before the declared lifetime expires, for
  up to 30 minutes of idle. Each opportunity is budget-governed: spend since the
  last real turn (USD, from Qoder's own Credits or priced v2 rows) must stay
  under `QODER_WARM_BUDGET` × the protected miss, and models with a published
  learned rate are capped by it. At session start the provider learns per-model
  lifetimes and rate fits from the session ledger, writes them atomically to
  `~/.pi/agent/qoder-cache-lifetime.json`, and re-registers the learned values.
  Rolling warming back takes **both** deleting the approval file and unsetting
  the env — either alone leaves the other armed. Code: `src/warm-gate.ts`,
  `src/warm-guard.ts`, `src/lifetime.ts`; per-decision detail is a
  `QODER_DEBUG=1` metric, and `/qoder-cache` reads the always-on ledger.

### Host request compatibility

The custom stream supports pi's `onPayload` (before encoding/signing),
`onResponse` (before reading the body, including HTTP errors), injected `fetch`
(chat and identity lookup), `headers`, `env`, `timeoutMs`, `temperature`, and
model/request `maxTokens`. Header overrides are case-insensitive; `null` removes a
default. Overriding COSY authentication headers can invalidate signatures. A
model `baseUrl` override must point to a Qoder-compatible gateway, not a generic
OpenAI endpoint. `onProviderStreamEvent` is honored on the v2 transport only:
pi-ai's completions stream invokes the host hook for each parsed event before
normalization, while the legacy transport does not call it.

### `text_end` frames

Legacy turns now close each text block with a `text_end` event, matching v2's
event vocabulary. The host maps every `text_end` to a `message_update` frame, so
`--json` output gains one frame per text block on legacy. A `--json` consumer
that counted frames before this change sees one more per text block.

### Protocol choice

Legacy is the default for every key (owner decision 2026-10-09). v2 is the
BYOK-oriented transport — Qoder exposes it to bring-your-own-key usage, some
accounts cannot reach an upstream through it at all, and its model server has
refused instruction roles and cap values the legacy gateway accepts — so opting
in needs an explicit `QODER_PROTOCOL=v2` **and** a key the bundled routing table
lists as v2-eligible (`~/.pi/agent/qoder-routing.json` overrides the table).
`QODER_PROTOCOL=legacy` forces the legacy path, `QODER_MODEL_SERVER_HOST`
overrides the v2 model-server base URL (for example to reach a v2 host from the
China region), and `QODER_FALLBACK=1` retries a turn once on the legacy transport
when the v2 model-server rejects a model key, caching the correction for the
session. `src/protocol/router.ts` is the resolver.

### Retry behavior

This provider never retries a chat POST inside its own `fetch` layer. `src/retry.ts` retries non-billable requests only — `fetchWithRetry` forces a single attempt for every non-GET method — so that layer never replays a POST. That GET-only policy is unchanged. Transport remains SSE. (There are two deliberate exceptions to that, both outside the `fetch` layer. The first is the opt-in `QODER_FALLBACK` self-heal, which fires only when the v2 model-server rejects a model key before a generation starts. The second is the queue wait: when the gateway answers that the model is busy — status 403 with code `10605` — the turn waits instead of failing, then re-sends the same conversation with a new request id and a fresh signature. That wait is bounded by `QODER_QUEUE_MAX_WAIT_MS` and three episodes, and `QODER_QUEUE_WAIT=0` turns it off.)

A turn that hits the stream idle timeout or the request deadline with an answer already streaming is not replayed either: it is finished once from the partial answer, which is a NEW request whose tail is that partial answer plus a continuation prompt — not a resend of the same body — so it spends one extra request, and `QODER_RESUME_TIMEOUT=0` turns it off.

Two retry layers sit above it, and they differ:

- **Agent-level retry (pi; both protocols).** pi's agent loop retries a failed
  assistant turn by matching the rendered error text against
  `isRetryableAssistantError`. It is armed by default in pi (`settings.retry.enabled`),
  covers both the legacy COSY transport and v2, and re-dispatches the turn with
  bounded exponential backoff. This provider writes its error text to match that
  classifier, so a stream that ends without a terminal response event is retried
  where it previously was not.
- **Provider-level HTTP retry (pi-ai; v2's model-server calls).** pi-ai can retry
  the HTTP request itself, but it is disarmed unless you set
  `settings.retry.provider.maxRetries`. Arming it silently retries v2's billable
  chat POSTs, which can duplicate billing and spend — it changes spend with no
  code change and no test. This is the tripwire: leave it unset unless you have
  measured the cost. The owner's settings leave it unset.

## Environment reference

Every knob, including the rollout gates and debug switches the published README
leaves out.

| Variable | Purpose |
| --- | --- |
| `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT` | Global PAT (first non-empty wins); an exported PAT is authoritative and re-exchanged on every startup, so an old cached token never shadows it. |
| `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT` | China PAT (first non-empty wins), same rules. |
| `QODER_STREAM_IDLE_TIMEOUT_MS` | Stream idle timeout override (default `120000` ms). |
| `QODER_RESUME_TIMEOUT` | Set to `0` to fail a turn that hits the stream idle timeout or the request deadline instead of finishing it (the pre-resume behaviour: the turn ends with that error, no extra request). Any other value, or unset, finishes it once from the partial answer. |
| `QODER_QUEUE_WAIT` | Set to `0` to fail a queued turn immediately instead of waiting for it (the pre-queue behaviour: the gateway's status 403 with code `10605` becomes an error, no polling, no replay). Any other value, or unset, waits. |
| `QODER_QUEUE_MAX_WAIT_MS` | How long one turn may spend waiting in a busy model's queue before it fails (default `3600000` ms). While queued, the provider polls the queue-status endpoint and re-sends the same conversation with a fresh request id when the gateway says its turn has come, for at most three episodes per turn. |
| `QODER_STREAM_DELTA_INTERVAL_MS` | Minimum gap between streamed text/thinking deltas (default `50` ms). Higher values cut UI CPU on long responses. |
| `QODER_PROTOCOL` | Force `v2` or `legacy` for every request, overriding the routing table. |
| `QODER_MODEL_SERVER_HOST` | Override the v2 model-server base URL (for example to reach a v2 host from the China region). |
| `QODER_FALLBACK` | Set to `1` to retry a turn once on the legacy transport when the v2 model-server rejects a model key (stale routing); the correction is cached for the session. Off by default. |
| `QODER_CORE_PLAN` | Set to `1` to route every dispatch through the turn-plan producer (one awaited plan feeding both adapters the session forms, affinity placements, thinking inputs and capture metadata). Off (default) keeps the pre-migration dispatch path — an env-flip rollback kept for one release. The run-identity fixes are ungated and stay on with the gate off. |
| `QODER_CORE_STAMP` | Set to `1` to wrap the legacy tail in the shared ordered terminal stamp (terminal-before-end guarantee, priced-only rate-source stamps). Off (default) keeps the pre-migration assembly-site stamps. Transitional, kept one release. |
| `QODER_LEGACY_AFFINITY` | Set to `off` to suppress every legacy cache-affinity placement (the probe-gated `prompt_cache_key` body field and the unsigned header trio) at request time, no rebuild — the rollback path for a promoted placement. |
| `QODER_LEGACY_CONTEXT_LENGTH` | Set to `off` to remove `context_length` from the legacy request body at request time, no rebuild — the rollback path for the promoted top-level-number placement. |
| `QODER_CACHE_WARM` | Set to `1` to approve pi's cache-warming refreshes on every provider, or `0` to veto them even where the approval file arms one (still requires pi's `cacheWarming` setting; refreshes spend Credits). Either value overrides `qoder-warm-approval.json`. With the gate on, refreshes are budget-governed per opportunity (`QODER_WARM_BUDGET`). |
| `QODER_WARM_BUDGET` | Fraction of the protected cache miss an idle window may spend on refreshes (default `0.5`); `off` disables the cap. Invalid values fall back to `0.5` with one debug entry. |
| `QODER_DEBUG` | Capture diagnostics to per-session JSONL files under `~/.pi/agent/logs/qoder-debug/<sessionId>.jsonl` — every chat request (decoded body + redacted headers) and its raw server response, on both transports, plus best-effort failure notes (catalog refresh, PAT exchange fallthrough, userinfo lookup) and per-decision cache-warming verdicts. Nothing is written to the console/TUI. Malformed SSE and token refresh failures are always surfaced as errors regardless of this flag. |
| `QODER_DEBUG_DIR` | Override the debug capture directory (default `~/.pi/agent/logs/qoder-debug`). |
| `QODER_DEBUG_KEEP` | Session files retained before oldest-first pruning (default `50`). |
| `QODER_DEBUG_HEADERS` | Set to `1` to include auth-bearing headers verbatim; by default `Authorization`/`Cosy-*`/token-shaped headers are redacted to their length. |
| `QODER_DEBUG_MAX_BYTES` | Per-record cap for request bodies and response SSE text (default `2000000`; longer values are truncated and flagged). |

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
- the **cache-warming economics and delay constants** (`src/index.ts`,
  `src/commands/cache.ts`) — pi hardcodes `IDLE_CONTINUATION_PROBABILITY = 0.15`
  and `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05`, which is the real reason
  the `cache_warming_decision` override exists (a model with no published rate
  stops earlier still, on `economicsAvailable: false`), and derives its refresh
  delay as `min(ttlMs * 0.9, ttlMs - 10_000)` in `getCacheWarmingDelayMs`, whose
  0.9 `WARM_DELAY_RATIO` mirrors to decide whether an idle window owed a
  refresh. `MAX_IDLE_WARMING_AGE_MS` (30 min) caps an idle chain, anchored to
  the last *real* request, so a parked session stops being warmed 30 minutes
  after work ended no matter how many pings went out. None is configurable; if
  pi ever exposes them, the override and the `/qoder-cache` `missed:` line
  should read pi's value instead of restating it.

## Conventions

- **The published docs are pinned by tests.** `README.md` ships to npm, so the
  text a user reads is asserted in `src/__tests__/retry-docs.test.ts` and
  `src/__tests__/package.test.ts`. Move a pinned sentence out of the README and
  the suite fails — update the pin in the same change, as this file's
  [Releasing](#releasing) and [Contracts to re-check](#contracts-to-re-check-after-upgrading-pi)
  sections do. The retry, protocol and `text_end` facts below are pinned in the
  AGENTS.md block of that test, because the detail moved here and the README now
  carries the guide instead.
- **This file is not published.** `files` ships `src/` and `README.md` only, so
  repo rules stay out of the user's install.
- **Conventional commits**, one logical change per commit, pull requests only —
  `main` takes no direct push.
