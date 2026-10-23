import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The published-doc pins.
 *
 * `package.json` ships `src/` and `README.md`, so the README's prose is part of
 * the published artifact, not a comment: a user deciding how to install, log in,
 * pick a model or set a variable reads exactly these bytes. The retry, protocol
 * and `text_end` detail moved to AGENTS.md — which is not published — so those
 * assertions moved with their sentences into the agents-file block below instead
 * of being dropped or weakened. Both files are read from the repo root, so the
 * documents and their pins cannot drift apart.
 */
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const agents = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");

describe("README — the public guide", () => {
  it("T-04 drops the blanket no-retry claim", () => {
    // The old single sentence read as "nothing is ever retried automatically".
    expect(readme).not.toContain("Chat POST requests are not automatically retried");
  });

  it("keeps the install and remove lines a reader copies", () => {
    expect(readme).toContain("pi install npm:@zenodinh/pi-provider-qoder");
    expect(readme).toContain("omp install npm:@zenodinh/pi-provider-qoder");
    expect(readme).toContain("pi install git:github.com/zenodinh/pi-provider-qoder");
    expect(readme).toContain("pi remove npm:@zenodinh/pi-provider-qoder");
  });

  it("names the four commands and both provider ids", () => {
    for (const command of [
      "`/login qoder`",
      "`/login qoder-cn`",
      "`/qoder-quota`",
      "`/qoder-cache`",
      "`/qoder-context`",
    ]) {
      expect(readme).toContain(command);
    }
    expect(readme).toContain("pi --provider qoder --model <id>");
    expect(readme).toContain("pi --provider qoder-cn --model <id>");
  });

  it("keeps the configuration table to the knobs a user sets on purpose", () => {
    for (const name of [
      "QODER_API_KEY",
      "QODER_PERSONAL_ACCESS_TOKEN",
      "QODER_PAT",
      "QODERCN_API_KEY",
      "QODERCN_PERSONAL_ACCESS_TOKEN",
      "QODERCN_PAT",
      "QODER_STREAM_IDLE_TIMEOUT_MS",
      "QODER_RESUME_TIMEOUT",
      "QODER_QUEUE_WAIT",
      "QODER_WARM_BUDGET",
      "QODER_DEBUG",
    ]) {
      expect(readme).toContain(name);
    }
  });
});

describe("AGENTS.md — retry and protocol detail (internal, not shipped)", () => {
  it("T-04 names both retry layers and the tripwire", () => {
    // Layer 1: pi's agent-level retry, armed by default and covering both
    // protocols, matching this provider's rendered error text.
    expect(agents).toContain("Agent-level retry");
    expect(agents).toContain("both protocols");
    expect(agents).toContain("isRetryableAssistantError");

    // Layer 2: pi-ai's provider-level HTTP retry, disarmed until the knob is
    // set — and the knob retries v2's billable POSTs.
    expect(agents).toContain("Provider-level HTTP retry");
    expect(agents).toContain("settings.retry.provider.maxRetries");
    expect(agents).toContain("billable");

    // The repo's own fetch layer keeps its GET-only policy, named as unchanged.
    expect(agents).toContain("src/retry.ts");
    expect(agents).toContain("GET-only");
  });

  it("T-05 carries the OB-2 pi-upgrade re-check list", () => {
    expect(agents).toContain("host seam module");
    expect(agents).toContain("parity suite");
    expect(agents).toContain("retry patterns");
    expect(agents).toContain("history-repair dependency");
  });

  it("names the text_end -> message_update frame class legacy now emits", () => {
    // AC-06: legacy closes each text block, and the host renders every text_end
    // as a --json message_update frame. The frame vocabulary is protocol detail
    // now, so a --json consumer is told about the new frame where that detail
    // lives.
    expect(agents).toContain("close each text block with a `text_end` event");
    expect(agents).toContain("maps every `text_end` to a `message_update` frame");
    expect(agents).toContain("`--json` output gains one frame per text block on legacy");
  });

  it("documents the transitional core gates in the environment reference", () => {
    // The two QODER_CORE_* gates are the migration's env-flip rollback units; an
    // undocumented gate cannot be reviewed or deliberately unset. The rows also
    // state the OD-8 truth: the run-identity fixes are ungated, so flipping
    // QODER_CORE_PLAN off restores none of them.
    expect(agents).toContain("`QODER_CORE_PLAN`");
    expect(agents).toContain("`QODER_CORE_STAMP`");
    expect(agents).toContain("pre-migration dispatch path");
    expect(agents).toContain("assembly-site stamps");
    expect(agents).toContain("stay on with the gate off");
  });

  it("documents resume-once as an extra request, not a replay, with its off switch", () => {
    // The distinction is the point of the row: a reader who saw "retried" would
    // expect the same body to be sent again and the same text to reappear. Resume
    // spends a second request whose tail is the partial answer, so the prose says
    // both and names the switch that disables it.
    expect(agents).toContain("`QODER_RESUME_TIMEOUT`");
    expect(agents).toContain("finished once from the partial answer");
    expect(agents).toContain("not a resend of the same body");
    expect(agents).toContain("spends one extra request");
  });

  it("documents pi's cacheWarming setting as warming's only switch", () => {
    // The owner's decision deleted this extension's approval layer, so the
    // published prose must not name a switch that no longer exists: a reader who
    // exported `QODER_CACHE_WARM=0` and expected a veto would be spending
    // Credits they thought they had turned off. The guide carries the surviving
    // fact in one Limits bullet rather than a warming section, and names the
    // retired file once, only to say it is ignored. The health line's INACTIVE
    // copy is command output, pinned by `cache-command.test.ts`; a guide does not
    // reproduce command copy.
    expect(readme).toContain("Cache warming follows pi's `cacheWarming` setting");
    expect(readme).not.toContain("QODER_CACHE_WARM");
    expect(readme).toContain("qoder-warm-approval.json");
    expect(readme).toContain("`QODER_WARM_BUDGET`");
  });

  it("documents onProviderStreamEvent as v2-only (FR-5's second clause)", () => {
    // The host's per-event observation hook is honored on the v2 transport
    // only: pi-ai's completions stream calls it, the legacy adapter does not.
    expect(agents).toContain("`onProviderStreamEvent`");
    expect(agents).toContain("honored on the v2 transport only");
  });
});
