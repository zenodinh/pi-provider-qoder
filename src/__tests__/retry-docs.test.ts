import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * FS-5 CU-03 — the README retry truth.
 *
 * `package.json` ships `files: ["src", "README.md"]`, so this prose is part of
 * the published artifact, not a comment: a user deciding whether to set
 * `settings.retry.provider` reads exactly these bytes. The rows read README.md
 * from the repo root rather than a copy, so the document and its pin cannot
 * drift apart.
 */
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

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

  it("T-05 carries the OB-2 pi-upgrade re-check list", () => {
    expect(readme).toContain("host seam module");
    expect(readme).toContain("parity suite");
    expect(readme).toContain("retry patterns");
    expect(readme).toContain("history-repair dependency");
  });

  it("names the text_end -> message_update frame class legacy now emits", () => {
    // AC-06: legacy closes each text block, and the host renders every text_end
    // as a --json message_update frame. The sentence ships in the published
    // README, so a --json consumer is told the new frame exists.
    expect(readme).toContain("close each text block with a `text_end` event");
    expect(readme).toContain("maps every `text_end` to a `message_update` frame");
    expect(readme).toContain("`--json` output gains one frame per text block on legacy");
  });
});
