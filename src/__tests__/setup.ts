import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Give every test file its own HOME.
 *
 * The provider stores credentials and the model catalog under
 * `~/.pi/agent/*.json`, and several suites write those paths. Vitest runs test
 * files in parallel, so a shared HOME let one file truncate a file another was
 * reading (an intermittent failure in the stream suite). A per-file HOME also
 * keeps the suite from touching the real `~/.pi` of whoever runs it.
 */
const home = mkdtempSync(join(tmpdir(), "pi-provider-qoder-test-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.PI_CODING_AGENT_DIR;

/**
 * Scrub the ambient `QODER_*` family, for the same reason as HOME above.
 *
 * These variables are feature gates the provider reads at request time
 * (`QODER_PROTOCOL`, `QODER_DEBUG`, `QODER_CACHE_WARM`, ...). A developer who
 * exports them for daily use — the owner's `~/.zshrc` sets five — hands vitest
 * a different provider than CI does, and the suite reports two verdicts for
 * one commit: 9 red transport rows in that shell, 476 green in CI. Worse, the
 * reds are not the gates' fault: debug capture consumes the response body it is
 * tee-ing, so the rows fail on teardown, not on behaviour.
 *
 * Deleting the whole prefix rather than a named list keeps the scrub correct
 * when a new gate ships — an allowlist of known names silently stops covering
 * the next one. A test that needs a gate stubs it explicitly with
 * `vi.stubEnv`, which states the dependency instead of inheriting it.
 *
 * boundary: `Object.keys(process.env)` yields strings by construction and no
 * value is read, parsed or narrowed here — the loop only deletes — so there is
 * no untrusted-input crossing to validate.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("QODER_")) {
    delete process.env[key];
  }
}

mkdirSync(join(home, ".pi", "agent"), { recursive: true });
