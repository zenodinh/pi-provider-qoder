# pi-provider-qoder

A [pi](https://shittycodingagent.ai/) extension that connects pi to [Qoder](https://qoder.com/). It emulates the official `qodercli` (and its China variant) protocol end-to-end: OAuth device login / PAT exchange, COSY request signing, the live model catalog, and the streaming chat gateway — no standalone CLI binary required. Verified against pi 0.87.1.

```bash
pi install npm:@zenodinh/pi-provider-qoder
# or: omp install npm:@zenodinh/pi-provider-qoder
# or straight from the repo: pi install git:github.com/zenodinh/pi-provider-qoder
# remove it later with: pi remove npm:@zenodinh/pi-provider-qoder
```

## Quick start

Inside pi, log in first:

```text
/login qoder
```

Then pick a model — or start directly from the command line once logged in:

```bash
pi --provider qoder --model Qwen3.8-Max
pi --provider qoder-cn --model Qwen3.7-Plus
```

## Features

- **Two regions registered together** — `qoder` (global) and `qoder-cn` (China) in a single extension.
- **Two auth flows** — paste a PAT, or (global only) sign in through the browser device flow.
- **Startup auto-login** — a PAT found in the environment logs the provider in at startup, before the first request.
- **Live model catalog** — fetched from the authenticated Qoder `/model/list` endpoint and cached per region.
- **Effort-aware thinking** — pi's thinking levels are mapped onto each model's `enable_thinking` / `reasoning_effort` support.
- **Agentic tool use** — native tool calls, plus DSML markup embedded in the text stream, parsed into clean `toolCall` blocks.
- **Robust streaming** — handles Qoder's double-`[DONE]` SSE envelope, hidden `<thinking>` markup, idle timeouts, and orphaned/compacted tool history.
- **Usage reporting** — `/qoder-quota` opens an interactive panel (plan + add-on credits, remaining amounts, renewal date, usage-page link) in the TUI, and prints the same report everywhere else — on demand, with a 60 s cache.
- **Cache warming health** — `/qoder-cache` reports whether the opt-in warm refreshes are actually keeping the prompt cache alive: refresh count and spend, cache-read share, natural-gap survival, and the learned lifetime/rate profile — read from the always-on session ledger, no debug flag required.
- **WAF bypass / COSY signatures** — every request is signed with the same RSA/AES machine-bound headers Qoder expects.

## Providers

Both providers register together; each is a separate region with its own account, catalog, and cache.

| | `qoder` (global) | `qoder-cn` (China) |
| --- | --- | --- |
| Chat gateway | `https://api3.qoder.sh/` | `https://gateway.qoder.com.cn/` |
| Login | `/login qoder` — browser OAuth **or** PAT | `/login qoder-cn` — PAT only |
| PAT page | https://qoder.com/account/integrations | https://qoder.com.cn/account/integrations |
| Account page | https://qoder.com | https://qoder.com.cn |
| Env PAT (first match) | `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT` | `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT` |
| Supports browser login | ✅ | ❌ |

## Authentication

Qoder PATs (`pt-...`) cannot authenticate API calls directly. Every flow ultimately exchanges one for a short-lived **job token** (`jt-...`), optionally alongside a job refresh token (`jrt-...`):

1. **Paste a PAT** — both regions prompt for a PAT and exchange it for a job token.
2. **Browser OAuth (global only)** — leave the PAT prompt empty and pi opens a Qoder sign-in URL; the plugin polls until you approve. This flow is a PKCE device grant.
3. **Environment variable** — set one of the PAT env vars above and the provider logs in automatically at startup. An explicit env PAT is authoritative and is re-exchanged on every startup (so an old cached token never silently shadows a new one).

A job token is short-lived; when it nears expiry the provider transparently refreshes it — by re-exchanging the stored PAT, or by using the job refresh token. Global browser and CN logins both persist credentials through pi. Refresh failures are reported rather than extending an invalid token's local expiry; HTTP 401/403 asks you to log in again.

Authentication, catalog and quota requests have a 15-second deadline covering headers and body. Browser login has a three-minute overall deadline. Login/refresh and chat identity resolution honor cancellation; chat also honors the host's optional `timeoutMs` in addition to the stream idle timeout.

### Credential storage

Credentials are managed by the host (pi uses `~/.pi/agent/`, or `PI_CODING_AGENT_DIR`; OMP uses its own store). Identity lookups are cached only in memory and never overwrite credentials:

- `auth.json` — the exchanged credentials (per provider), plus the resolved user identity (`userID`/`email`/`name`/`machineID`).
- The machine id used for COSY headers is read from `~/.qoder/.auth/machine_id` or, if absent, `~/.pi/agent/qoder-machine-id` (created if missing).

Qoder credits are billed per account; only the region you log into is affected.

## Models

After login, `/model` (or `pi --list-models`) lists what that region offers.

**Catalog source.** At startup and on each new session the provider checks its model cache. If it is missing, older than one hour, or was fetched for a different account it re-fetches the authenticated region catalog from `/model/list` and writes a fresh copy to:

- `~/.pi/agent/qoder-models-cache.json` (global)
- `~/.pi/agent/qoder-cn-models-cache.json` (China)

**Fallback catalog.** When the live catalog is unavailable, an explicit static catalog is used so models work offline. IDs in the fallback are also used as seeds until a live catalog arrives.

**Model ids.** The pi-visible id is the server `display_name` with all whitespace stripped (e.g. `Qwen3.8-Max`, `Kimi-K3`). A hidden `upstreamKey` (`lite`, `qmodel`, `qmodel_latest`, `dmodel`, …) is kept internally and sent to the gateway on each request.

**Context & output.**

- Context window: taken from the **largest** context option the catalog advertises (e.g. 1M when 200K/400K/1M are offered). When the catalog omits context options, a 1M fallback is used for most models; a few models are pinned lower to what they actually advertise (e.g. Kimi 256K, and several CN models 200K).
- Output: capped at 128K tokens (`max_tokens` 131072), which can be lowered per-request by pi (e.g. compaction).
- Cost: Qoder bills in Credits, not USD, so pi's monetary `cost` is left at zero. The relative Credit multiplier (`price_factor`) is exposed as `priceFactor` on each model when the live catalog reports it, and the official per-request `credits` / `original_credits` / `billable` fields are preserved on the runtime usage object when Qoder reports them.

### Thinking & effort

Models flagged as reasoning expose pi's thinking level picker (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, plus `off`). How they behave depends on what the catalog advertises:

- **Effort-based** models (`thinking_config.enabled.efforts`) map pi levels to Qoder's `reasoning_effort` (`low`/`medium`/`xhigh`/`max`, …); unsupported levels are hidden from the picker.
- **Toggle-based** models (thinking on/off only) treat any level as "on" and only send `enable_thinking`.
- Disabling thinking sends `enable_thinking: false` so non-reasoning models don't reason by default.

The streamed response is normalized into pi thinking blocks regardless of how the server delivers it — a dedicated `reasoning_content` channel or inline `<thinking>` / `<think>` / `<reasoning>` / `<summary>` tags split across chunks.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT` | Global PAT (first non-empty wins). |
| `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT` | China PAT (first non-empty wins). |
| `QODER_STREAM_IDLE_TIMEOUT_MS` | Stream idle timeout override (default `120000` ms). |
| `QODER_STREAM_DELTA_INTERVAL_MS` | Minimum gap between streamed text/thinking deltas (default `50` ms). Higher values cut UI CPU on long responses. |
| `QODER_DEBUG` | Debug mode. When set, all diagnostics go to per-session JSONL files under `~/.pi/agent/logs/qoder-debug/<sessionId>.jsonl` — every chat request (decoded body + redacted headers) and its raw server response, on both transports, plus best-effort failure notes (catalog refresh, PAT exchange fallthrough, userinfo lookup) and per-decision cache-warming verdicts. Nothing is written to the console/TUI. Malformed SSE and token refresh failures are always surfaced as errors regardless of this flag. |
| `QODER_DEBUG_DIR` | Override the debug capture directory (default `~/.pi/agent/logs/qoder-debug`). |
| `QODER_DEBUG_KEEP` | Session files retained before oldest-first pruning (default `50`). |
| `QODER_DEBUG_HEADERS` | Set to `1` to include auth-bearing headers verbatim; by default `Authorization`/`Cosy-*`/token-shaped headers are redacted to their length. |
| `QODER_DEBUG_MAX_BYTES` | Per-record cap for request bodies and response SSE text (default `2000000`; longer values are truncated and flagged). |
| `QODER_FALLBACK` | Set to `1` to retry a turn once on the legacy transport when the v2 model-server rejects a model key (stale routing); the correction is cached for the session. Off by default. |
| `QODER_PROTOCOL` | Force `v2` or `legacy` for every request, overriding the routing table. |
| `QODER_CORE_PLAN` | Set to `1` to route every dispatch through the turn-plan producer (one awaited plan feeding both adapters the session forms, affinity placements, thinking inputs and capture metadata). Off (default) keeps the pre-migration dispatch path — an env-flip rollback kept for one release. The run-identity fixes are ungated and stay on with the gate off. |
| `QODER_CORE_STAMP` | Set to `1` to wrap the legacy tail in the shared ordered terminal stamp (terminal-before-end guarantee, priced-only rate-source stamps). Off (default) keeps the pre-migration assembly-site stamps. Transitional, kept one release. |
| `QODER_MODEL_SERVER_HOST` | Override the v2 model-server base URL (for example to reach a v2 host from the China region). |
| `QODER_CACHE_WARM` | Set to `1` to approve pi's cache-warming refreshes (requires pi's `cacheWarming` setting; refreshes spend Credits). With the gate on, refreshes are budget-governed per opportunity (`QODER_WARM_BUDGET`). |
| `QODER_WARM_BUDGET` | Fraction of the protected cache miss an idle window may spend on refreshes (default `0.5`); `off` disables the cap. Invalid values fall back to `0.5` with one debug entry. |

## How it works (protocol notes)

- **Request signing.** The provider rebuilds Qoder's COSY authorization: an AES-encrypted user blob + RSA-wrapped key, an MD5 signature over path/body, and machine-bound `Cosy-*` headers (client type, OS, machine id/token). This is what lets it talk to the gateway directly.
- **SSE gateway.** Chat streams from the Qoder `/algo/.../agent_chat_generation` endpoint. Qoder wraps events in an outer envelope with a JSON-string `body`, and can send the `[DONE]` sentinel both bare and wrapped — both are handled, plus a body that stays open after the sentinel.
- **Agentic "runs".** Qoder groups billing/records per agentic run. The provider infers run boundaries from the message tail and reuses a run-scoped `request_set_id` + `business` (stable id/name, advancing `init` → `start` → `processing`) across tool rounds, so the credit ledger shows one aggregated entry per user prompt instead of many tiny ones.
- **Tool calls.** Native structured `tool_calls` and DSML tool markup embedded in the text stream are both parsed into pi tool calls. Images returned by tools (e.g. screenshots, `read`) are forwarded to the model as data-URL image parts.
- **Prompt cache.** A stable session id derived from your user id + model keeps prompt-cache affinity across consecutive requests in a session: the legacy envelope carries it as `session_id`, and v2 carries it both in `metadata.context.session_id` and — matching qodercli's OpenAI-protocol convention — as `prompt_cache_key` plus `session_id` / `x-client-request-id` / `x-session-affinity` headers. Recorded traffic shows the server-side lifetime is minutes (no large re-bill was observed at a 1-5 minute idle gap; the first deaths appear at ~6 minutes), so the provider declares `promptCache.short` = 300 s and can keep a session warm across short idle gaps (next bullet).
- **Cache warming (opt-in).** With pi's `"cacheWarming": "idle"` setting plus `QODER_CACHE_WARM=1`, pi re-sends the last request with a one-token output cap before the declared lifetime expires, for up to 30 minutes of idle. Each refresh bills a cache read — measured ~50x cheaper than the re-billed input tokens it prevents (DeepSeek-Flash Credit usage, 2026-09-29) — and warming stops on context changes, the 30-minute idle cap, or anything pi considers unsafe to replay. The provider governs each opportunity: spend since the last real turn (USD, from Qoder's own Credits or priced v2 rows) must stay under `QODER_WARM_BUDGET` × the protected miss, models without a usable rate keep the legacy force-warm, and models with a published learned rate are capped by it. At session start the provider also learns per-model lifetimes (natural idle gaps only) and rate fits (R² ≥ 0.95) from the session ledger, writes them atomically to `~/.pi/agent/qoder-cache-lifetime.json`, and re-registers the learned values. Run `/qoder-cache` for the health readout.
- **History repair.** Before sending, orphaned tool results, dropped (error/aborted) assistant turns, and placeholderless tool-call messages are repaired so Qoder never rejects a request with "tool must follow a message with tool_calls".

## Host request compatibility

The custom stream supports pi's `onPayload` (before encoding/signing), `onResponse` (before reading the body, including HTTP errors), injected `fetch` (chat and identity lookup), `headers`, `env`, `timeoutMs`, `temperature`, and model/request `maxTokens`. Header overrides are case-insensitive; `null` removes a default. Overriding COSY authentication headers can invalidate signatures. A model `baseUrl` override must point to a Qoder-compatible gateway, not a generic OpenAI endpoint.

Legacy turns now close each text block with a `text_end` event, matching v2's event vocabulary. The host maps every `text_end` to a `message_update` frame, so `--json` output gains one frame per text block on legacy.

### Retry behavior

This provider never retries a chat POST inside its own `fetch` layer. `src/retry.ts` retries non-billable requests only — `fetchWithRetry` forces a single attempt for every non-GET method — so that layer never replays a POST. That GET-only policy is unchanged. Transport remains SSE. (The one repo-side re-dispatch is the opt-in `QODER_FALLBACK` self-heal, which fires only when the v2 model-server rejects a model key before a generation starts.)

Two retry layers sit above it, and they differ:

- **Agent-level retry (pi; both protocols).** pi's agent loop retries a failed assistant turn by matching the rendered error text against `isRetryableAssistantError`. It is armed by default in pi (`settings.retry.enabled`), covers both the legacy COSY transport and v2, and re-dispatches the turn with bounded exponential backoff. This provider writes its error text to match that classifier, so a stream that ends without a terminal response event is retried where it previously was not.
- **Provider-level HTTP retry (pi-ai; v2's model-server calls).** pi-ai can retry the HTTP request itself, but it is disarmed unless you set `settings.retry.provider.maxRetries`. Arming it silently retries v2's billable chat POSTs, which can duplicate billing and spend — it changes spend with no code change and no test. This is the tripwire: leave it unset unless you have measured the cost. The owner's settings leave it unset.

### Re-check after upgrading pi

The retry classifier and the compat facade are host-owned prose and symbols this provider does not control, so a pi upgrade is a contract review, not just a version bump. Re-check:

- the **host seam module** — the single place the two pi-compat symbols (`openAICompletionsApi`, `registerApiProvider`) are acquired, and where a renamed or deleted facade becomes a named error instead of a silent break;
- the **parity suite** (`src/__tests__/wire-vocabulary.test.ts`, `src/__tests__/error-vocabulary.test.ts`) — body, header and event vocabularies plus every rendered error text;
- the **retry patterns** in `@earendil-works/pi-ai/utils/retry` — an upstream edit to that alternation silently changes which failures this provider retries, and the executed verdict table in `src/__tests__/error-vocabulary.test.ts` is where the change shows;
- the **history-repair dependency** (`src/protocol/transform.ts`) — errored and aborted turns are dropped before dispatch by this repo, not by pi, and the cache-neutral retry rotation rests on it.

## Usage reporting

Run `/qoder-quota` inside pi — on demand, never on the turn path. In the TUI it opens a compact panel (`esc`/`q` closes, `r` refreshes); every other mode prints the same report as a notification. It fetches the subscription quota and renders, in the Qoder desktop app's wording:

- **Plan Credits** — used / total, used %, remaining, and the renewal date.
- **Shared Add-on Credits** — the organization package (`cap`-shaped, with the legacy `total` fallback); shown as `Unavailable` when the org has suspended distribution.
- **Add-on Credits** / **Dedicated Credits** — rendered when the account's payload carries them.
- **View details** — a link to the account usage page (plus the payload's upgrade link when the quota is exhausted).

Repeat runs within 60 seconds are served from a cache; concurrent runs share a single request; `r` in the panel forces a refresh. Failures print a reason ("quota unavailable") instead of numbers.

## Cache warming health

`/qoder-cache` answers "is warming actually working?" from the data that is always on disk — the session ledger and the learned profile — so no debug flag is needed. In the TUI it opens a panel (`esc`/`q` closes, `r` rescans); every other mode prints the same report. It shows the live config plus three evidence sections:

- **Refreshes** — warm-refresh count, spend in USD (Qoder Credits ÷ 75, or the priced v2 total), the median cache-read share (a healthy refresh is a near-pure cache read; a low share means the replay re-wrote the prefix), and how many rows look like re-writes.
- **Survival** — per model, the median cache-read share of real turns that follow a natural idle gap (warm refreshes excluded) and the count of probable misses. This is the signal that the cache survived the idle window warming was meant to bridge.
- **Profile** — per model, the published learned lifetime and rate fit with sample count, age, and R², or the declared default when nothing has been published.

The report reads the newest session files first under a 1.5 s scan budget, and flags `INACTIVE` (no refreshes recorded), `WARN` (median refresh share < 0.9, or a model with ≥ 5 gaps and median survival < 0.8), or `OK`.

Per-decision detail — each verdict's reason, rate source, spend, and protected miss — requires `QODER_DEBUG=1`. Guard **stops** are not persisted to the ledger (only approvals materialize as `cache_warm` rows), so the stop rate is a debug-log metric; approvals, spend, and survival are always visible.

## Development

```bash
npm install
npm test           # run the offline unit suite (replays recorded fixtures)
npm run test:coverage  # the same suite plus coverage/lcov.info
npm run test:live  # re-record live protocol fixtures (needs QODER_PAT / QODERCN_PAT)
pi -e ./src/index.ts  # load the extension from source in pi
```

See [`src/__fixtures__/live/README.md`](https://github.com/zenodinh/pi-provider-qoder/blob/main/src/__fixtures__/live/README.md) for the fixture format and how to re-record it.

## CI gates

Every pull request runs two gates on top of lint, types and the test suite. Both are first-party TypeScript under `scripts/` — no third-party action and no SaaS — because a gate that runs on untrusted PR code must not have a supply chain of its own.

**Changed-line coverage (80%).** `scripts/coverage-diff.ts` reads `coverage/lcov.info` and the PR's diff, then asks the only question a reviewer cannot answer by eye: of the *executable* lines this change adds, how many did a test actually run? Below 80% the build fails. Scope is the published artifact (`src/**` minus `__tests__` and `__fixtures__`, matching `package.json`'s `files`), types and comments stay out of the denominator, and a changed file no test ever loaded fails on its own instead of being averaged away. Pushes to `main` report the same number without failing, because by then the merge has happened.

**Security scan.** `scripts/security-scan.ts` fails the build on the patterns that carry real risk for an extension that holds a job token and forges request signatures:

| Family | Blocks on | Advises on |
| --- | --- | --- |
| `SRC-*` | dynamic code execution (`eval`, `new Function`, `child_process`), an outbound host that is not a Qoder domain, cleartext `http://`, a credential-shaped `process.env` read | any other `process.env` read, filesystem writes |
| `WF-*` | `pull_request_target`, a new `secrets.` reference, a write permission, an action not pinned to a 40-hex SHA | |
| `MANIFEST-*` / `LOCK-*` | an added or changed npm lifecycle script, a `resolved` URL outside `registry.npmjs.org`, a git/file/link source, a changed `integrity` on a known package, a new package with an install script | any dependency-set change, a changed non-lifecycle script, new lock entries, an install script that cannot be compared to a baseline |
| `PATH-*` | | credential, signing, transport, dependency or CI plumbing touched at all |

The security job installs nothing — Node runs the scanner through its built-in type stripping — so `npm ci` cannot execute a PR's install scripts before the scan sees them. And when a diff touches the scanner or the workflows, the scan runs the **base** revision of the scanner rather than the one the PR supplies, so a change cannot weaken its own judge. Baselines are optional by design: with no base manifest, the base-relative rules degrade to a loud warning instead of reporting every script as newly added.

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

Baselines are ordinary files, not process substitutions: `<(...)` hands the scanner a `/dev/fd/N` path that is already closed by the time npm's child shell runs, and the comparison is then skipped. The scanner says so on stderr rather than exiting green in silence.

`src/__tests__/**` and `src/__fixtures__/**` are out of `SRC-*` scope — a fixture legitimately quotes the text those rules look for, and a per-line bypass comment would be a hole any contributor could use. Contributor test code still runs under `npm test`, so on an untrusted branch read the diff first and let CI run the tests on an ephemeral runner with a read-only token.

Around these gates, the repo also relies on GitHub-side controls that live in settings rather than in files: CodeQL code scanning, secret scanning with push protection, Dependabot alerts (`.github/dependabot.yml` drives the update PRs), and a ruleset on `main` requiring both checks plus a code-owner review — without that ruleset, a direct push to `main` reaches the npm publish path unchecked.

## Releasing

Releases are **tag-triggered and owner-only**, and the **tag decides the version** — `package.json` on `main` does not. Merging a pull request can never publish, and a contributor who bumps the version has done nothing but edit a string.

**From the web UI, no terminal:**

1. **Releases → Draft a new release**.
2. Under *Choose a tag*, type the version you want — `v0.0.12`, or `v0.99.0` to skip ahead. GitHub creates the tag when you publish.
3. Target `main`, add notes (or click *Generate release notes*), then **Publish release**.

**From the terminal, the same thing:**

```bash
git switch main && git pull
git tag -a v0.0.12 -m "0.0.12" && git push origin v0.0.12
```

A tag ruleset restricting `v*` creation to admins is the second layer behind the workflow's actor check (Settings → Rules → Rulesets → New ruleset → target **Tag**).

The [Release workflow](https://github.com/zenodinh/pi-provider-qoder/blob/main/.github/workflows/release.yml) then refuses any actor but the owner, refuses a tag that is not `v<major>.<minor>.<patch>` with an optional `-prerelease`, and refuses a version older than npm's newest — publishing one would move the `latest` dist-tag backwards for every user. That decision lives in `scripts/release-guard.ts`, unit-tested rather than embedded in shell. When it authorizes, the workflow stamps `package.json` from the tag, asserts npm ≥ 11.5.1 (the Trusted Publishing floor; Node 26 ships 11.16.0, so nothing is installed over it), re-runs lint/types/tests, publishes with `--provenance` through Trusted Publishing (OIDC, no `NPM_TOKEN`), and attaches the tarball to the GitHub Release. Publishing the same tag again is safe: the publish is skipped and only the Release assets refresh.

**Skipping versions is normal.** Nothing has to exist between two releases — pi published 0.87.1 on 2026-09-22 and then 0.99.0 on 2026-09-29, with 0.88 through 0.98 never on npm at all.

**One consequence worth knowing:** because the tag is authoritative, `package.json` on `main` lags behind what npm holds until someone commits a bump. That is cosmetic — `pi install npm:@zenodinh/pi-provider-qoder` reads the registry — but git-based installs and any version banner show the older number. If it bothers you, bump `package.json` in an ordinary PR after releasing; it changes nothing about what publishes.

The first-ever npm publish is manual: npm requires the package to exist before a trusted publisher can be configured. The trusted publisher binds organization/user, repository, **workflow filename** and optional environment — not a branch or tag — so changing the trigger does not disturb provenance as long as the file stays `release.yml`.

## Credits

This project is a fork of [OnlyTomInSecond/pi-provider-qoder](https://github.com/OnlyTomInSecond/pi-provider-qoder), which itself is a fork of [simonsmh/pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder). Thanks to both for the protocol work this fork builds on.

## License

MIT
