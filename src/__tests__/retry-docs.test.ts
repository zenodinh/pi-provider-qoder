import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * FS-5 CU-03 — the README retry truth.
 *
 * `package.json` ships `src/` and `README.md`, so this prose is part of the
 * published artifact, not a comment: a user deciding whether to set
 * `settings.retry.provider` reads exactly these bytes. The rows read the files
 * from the repo root rather than a copy, so the documents and their pins cannot
 * drift apart. Internal repo rules live in AGENTS.md, which is not published;
 * T-05 pins the pi-upgrade re-check list there, where it now lives.
 */
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const agents = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");

describe("README retry documentation", () => {
  it("T-04 names both retry layers and the tripwire, and drops the blanket no-retry claim", () => {
    // The old single sentence read as "nothing is ever retried automatically".
    expect(readme).not.toContain("Chat POST requests are not automatically retried");

    // Layer 1: pi's agent-level retry, armed by default and covering both
    // protocols, matching this provider's rendered error text.
    expect(readme).toContain("Agent-level retry");
    expect(readme).toContain("both protocols");
    expect(readme).toContain("isRetryableAssistantError");

    // Layer 2: pi-ai's provider-level HTTP retry, disarmed until the knob is
    // set — and the knob retries v2's billable POSTs.
    expect(readme).toContain("Provider-level HTTP retry");
    expect(readme).toContain("settings.retry.provider.maxRetries");
    expect(readme).toContain("billable");

    // The repo's own fetch layer keeps its GET-only policy, named as unchanged.
    expect(readme).toContain("src/retry.ts");
    expect(readme).toContain("GET-only");
  });

  it("T-05 carries the OB-2 pi-upgrade re-check list (AGENTS.md — internal, not shipped)", () => {
    expect(agents).toContain("host seam module");
    expect(agents).toContain("parity suite");
    expect(agents).toContain("retry patterns");
    expect(agents).toContain("history-repair dependency");
  });

  it("names the text_end -> message_update frame class legacy now emits", () => {
    // AC-06: legacy closes each text block, and the host renders every text_end
    // as a --json message_update frame. The sentence ships in the published
    // README, so a --json consumer is told the new frame exists.
    expect(readme).toContain("close each text block with a `text_end` event");
    expect(readme).toContain("maps every `text_end` to a `message_update` frame");
    expect(readme).toContain("`--json` output gains one frame per text block on legacy");
  });

  it("documents the transitional core gates in the environment table", () => {
    // The two QODER_CORE_* gates are the migration's env-flip rollback units; an
    // undocumented gate cannot be reviewed or deliberately unset. The rows also
    // state the OD-8 truth: the run-identity fixes are ungated, so flipping
    // QODER_CORE_PLAN off restores none of them.
    expect(readme).toContain("`QODER_CORE_PLAN`");
    expect(readme).toContain("`QODER_CORE_STAMP`");
    expect(readme).toContain("pre-migration dispatch path");
    expect(readme).toContain("assembly-site stamps");
    expect(readme).toContain("stay on with the gate off");
  });

  it("documents onProviderStreamEvent as v2-only (FR-5's second clause)", () => {
    // The host's per-event observation hook is honored on the v2 transport
    // only: pi-ai's completions stream calls it, the legacy adapter does not.
    // The published README states the asymmetry so it is reviewable.
    expect(readme).toContain("`onProviderStreamEvent`");
    expect(readme).toContain("honored on the v2 transport only");
  });
});
