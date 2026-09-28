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
| `QODER_DEBUG` | When set, log diagnostics for best-effort failures (catalog refresh, PAT exchange fallthrough, userinfo lookup). Malformed SSE and token refresh failures are always surfaced as errors. |
| `QODER_FALLBACK` | Set to `1` to retry a turn once on the legacy transport when the v2 model-server rejects a model key (stale routing); the correction is cached for the session. Off by default. |
| `QODER_PROTOCOL` | Force `v2` or `legacy` for every request, overriding the routing table. |
| `QODER_MODEL_SERVER_HOST` | Override the v2 model-server base URL (for example to reach a v2 host from the China region). |

## How it works (protocol notes)

- **Request signing.** The provider rebuilds Qoder's COSY authorization: an AES-encrypted user blob + RSA-wrapped key, an MD5 signature over path/body, and machine-bound `Cosy-*` headers (client type, OS, machine id/token). This is what lets it talk to the gateway directly.
- **SSE gateway.** Chat streams from the Qoder `/algo/.../agent_chat_generation` endpoint. Qoder wraps events in an outer envelope with a JSON-string `body`, and can send the `[DONE]` sentinel both bare and wrapped — both are handled, plus a body that stays open after the sentinel.
- **Agentic "runs".** Qoder groups billing/records per agentic run. The provider infers run boundaries from the message tail and reuses a run-scoped `request_set_id` + `business` (stable id/name, advancing `init` → `start` → `processing`) across tool rounds, so the credit ledger shows one aggregated entry per user prompt instead of many tiny ones.
- **Tool calls.** Native structured `tool_calls` and DSML tool markup embedded in the text stream are both parsed into pi tool calls. Images returned by tools (e.g. screenshots, `read`) are forwarded to the model as data-URL image parts.
- **Prompt cache.** A stable session id derived from your user id + model keeps prompt-cache affinity across consecutive requests in a session.
- **History repair.** Before sending, orphaned tool results, dropped (error/aborted) assistant turns, and placeholderless tool-call messages are repaired so Qoder never rejects a request with "tool must follow a message with tool_calls".

## Host request compatibility

The custom stream supports pi's `onPayload` (before encoding/signing), `onResponse` (before reading the body, including HTTP errors), injected `fetch` (chat and identity lookup), `headers`, `env`, `timeoutMs`, `temperature`, and model/request `maxTokens`. Header overrides are case-insensitive; `null` removes a default. Overriding COSY authentication headers can invalidate signatures. A model `baseUrl` override must point to a Qoder-compatible gateway, not a generic OpenAI endpoint.

Chat POST requests are not automatically retried, even when `maxRetries` is supplied: replaying a generation may duplicate billing. The host can decide when to retry. Transport remains SSE.

## Usage reporting

Run `/qoder-quota` inside pi — on demand, never on the turn path. In the TUI it opens a compact panel (`esc`/`q` closes, `r` refreshes); every other mode prints the same report as a notification. It fetches the subscription quota and renders, in the Qoder desktop app's wording:

- **Plan Credits** — used / total, used %, remaining, and the renewal date.
- **Shared Add-on Credits** — the organization package (`cap`-shaped, with the legacy `total` fallback); shown as `Unavailable` when the org has suspended distribution.
- **Add-on Credits** / **Dedicated Credits** — rendered when the account's payload carries them.
- **View details** — a link to the account usage page (plus the payload's upgrade link when the quota is exhausted).

Repeat runs within 60 seconds are served from a cache; concurrent runs share a single request; `r` in the panel forces a refresh. Failures print a reason ("quota unavailable") instead of numbers.

## Development

```bash
npm install
npm test           # run the offline unit suite (replays recorded fixtures)
npm run test:live  # re-record live protocol fixtures (needs QODER_PAT / QODERCN_PAT)
pi -e ./src/index.ts  # load the extension from source in pi
```

See [`src/__fixtures__/live/README.md`](https://github.com/zenodinh/pi-provider-qoder/blob/main/src/__fixtures__/live/README.md) for the fixture format and how to re-record it.

## Releasing

Bump the version (`npm version patch --no-git-tag-version`) and merge to `main`. The [Release workflow](https://github.com/zenodinh/pi-provider-qoder/blob/main/.github/workflows/release.yml) detects the version change, re-runs lint/types/tests, publishes to npm via Trusted Publishing (OIDC, with provenance), tags `v<version>`, and creates the GitHub Release with generated notes plus the packaged tarball. Merges that do not change the version are green no-ops. The first-ever npm publish is manual: npm requires the package to exist before a trusted publisher can be configured.

## Credits

This project is a fork of [OnlyTomInSecond/pi-provider-qoder](https://github.com/OnlyTomInSecond/pi-provider-qoder), which itself is a fork of [simonsmh/pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder). Thanks to both for the protocol work this fork builds on.

## License

MIT
