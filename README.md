# pi-provider-qoder

A [pi](https://shittycodingagent.ai/) extension that talks to [Qoder](https://qoder.com/) the way the official `qodercli` does — both regions, no separate CLI binary to install.

```bash
pi install npm:@zenodinh/pi-provider-qoder
# or: omp install npm:@zenodinh/pi-provider-qoder
# or straight from the repo: pi install git:github.com/zenodinh/pi-provider-qoder
# remove it later with: pi remove npm:@zenodinh/pi-provider-qoder
```

## Quick start

Log in once. Paste a PAT from the [global](https://qoder.com/account/integrations) or [China](https://qoder.com.cn/account/integrations) integrations page, or leave the prompt empty to sign in through the browser (global region only):

```text
/login qoder
```

Then pick a model with `/model` — or skip the picker:

```bash
pi --list-models qoder                # the ids this account offers
pi --provider qoder --model <id>      # one turn, global
pi --provider qoder-cn --model <id>   # one turn, China
```

## What you get

- **Two regions in one extension** — `qoder` (global) and `qoder-cn` (China), each with its own account, catalog and cache.
- **Two ways to log in** — paste a PAT, or approve a browser sign-in; a PAT in the environment logs the provider in at startup.
- **The live model catalog** — fetched from your account and cached per region, so the picker offers what Qoder actually serves.
- **Thinking where the model has it** — pi's levels map onto each model's `enable_thinking` and `reasoning_effort` support.
- **Agentic tool use** — native tool calls plus DSML markup in the text stream, with tool images passed back to the model.
- **Robust streaming** — Qoder's double `[DONE]` envelope, hidden `<thinking>` markup, queue waits, and one continuation when a stall cuts an answer short.
- **Signed requests** — every request carries the COSY signatures Qoder expects, so nothing sits in the middle.

## Providers

Both register together; each is a separate region with its own account and Credits.

| | `qoder` (global) | `qoder-cn` (China) |
| --- | --- | --- |
| Gateway | `https://api3.qoder.sh/` | `https://gateway.qoder.com.cn/` |
| Login | `/login qoder` — browser sign-in **or** PAT | `/login qoder-cn` — PAT only |
| PAT page | https://qoder.com/account/integrations | https://qoder.com.cn/account/integrations |
| Env PAT (first match) | `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT` | `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT` |
| Browser login | ✅ | ❌ |

## Commands

| Command | What it does |
| --- | --- |
| `/login qoder`, `/login qoder-cn` | Sign in with a PAT, or leave the prompt empty for the browser flow (global only). |
| `/qoder-quota` | Plan and add-on Credits, remaining amounts and renewal date — panel in the TUI, text elsewhere, 60 s cache. |
| `/qoder-cache` | Warming health: refreshes, spend, cache-read share, survival across idle gaps, the learned profile. |
| `/qoder-context` | Windows and compaction thresholds per model; `<model> window=1M reserve=10% keep=15%` sets them, `reset` clears. |

## Models

- **The catalog is live** — `/model/list` per region, cached at `~/.pi/agent/qoder-models-cache.json` and `qoder-cn-models-cache.json`, refetched when over an hour old or tied to another account.
- **The id is the display name** — whitespace stripped, e.g. `Qwen3.8-Max`; that is the id you give `/model` or `--model`.
- **The context window is the largest tier the catalog advertises**; offline, a four-tier fallback (`Auto`, `Ultimate`, `Performance`, `Efficient`) keeps the picker usable.
- **Thinking is per model** — effort-based models expose pi's levels as `reasoning_effort` values, toggle-only models treat any level as on, and `off` sends `enable_thinking: false`.
- **Billing is in Credits, not USD** — Qoder charges Credits and pi's cost figures are derived from them at 75 Credits per USD where a rate is measured; Qoder's own `credits` / `original_credits` / `billable` ride on the usage object.

## Configuration

Everything below is optional; nothing needs to be set to use the extension.

| Variable | What it does |
| --- | --- |
| `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT` | Global PAT; logged in at startup, and an exported PAT wins over a cached token. |
| `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT` | China PAT, same rules. |
| `QODER_STREAM_IDLE_TIMEOUT_MS` | Stream idle timeout (default `120000` ms). |
| `QODER_RESUME_TIMEOUT` | `0` fails a turn that hits the idle timeout instead of finishing it from the partial answer. |
| `QODER_QUEUE_WAIT` | `0` fails a turn queued behind a busy model instead of waiting for it. |
| `QODER_WARM_BUDGET` | Fraction of the protected cache miss an idle warm window may spend (default `0.5`); `off` removes the cap. |
| `QODER_DEBUG` | Diagnostics to per-session JSONL under `~/.pi/agent/logs/qoder-debug/`; nothing on the console. |

## Limits

- **Credits are not dollars.** pi's cost is a conversion of Qoder's Credits, not the bill; the bill itself lives in Qoder's ledger, per account.
- **Retries come from pi's agent loop.** `settings.retry` re-dispatches a failed turn; this provider adds no retry of its own on a billable chat POST.
- **Cache warming follows pi's `cacheWarming` setting.** When pi asks for a refresh, this provider
  approves it; every refresh spends Credits, bounded by `QODER_WARM_BUDGET`. An older
  `qoder-warm-approval.json` is no longer read and is safe to delete.
- **The legacy gateway is the default.** v2 is an opt-in, BYOK-oriented transport that only some models may use; [AGENTS.md](./AGENTS.md) names the switch and the eligibility table.

## Development

```bash
npm install
npm test              # offline suite, replays the recorded fixtures
npm run test:coverage # the same suite plus coverage/lcov.info
npm run test:live     # re-record live protocol fixtures (needs QODER_PAT / QODERCN_PAT)
pi -ne -e ./src/index.ts --list-models qoder   # this checkout, not the npm install
```

CI gates, the release process and the host contracts to re-check on a pi upgrade live in [AGENTS.md](./AGENTS.md).

## Credits

This project is a fork of [OnlyTomInSecond/pi-provider-qoder](https://github.com/OnlyTomInSecond/pi-provider-qoder), which itself is a fork of [simonsmh/pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder). Thanks to both for the protocol work this fork builds on.

## License

MIT
