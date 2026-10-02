// shape: adapter — the host's compat facade does not match the local need for a
//   guaranteed-present, named-failure acquisition, so the conversion happens
//   here once instead of at every use site.
import * as qoderCompat from "@earendil-works/pi-ai/compat";
import { debugLog } from "./debug.js";

/**
 * The host seam: the single module that acquires the two pi-compat symbols this
 * extension depends on — `openAICompletionsApi` (streaming) and
 * `registerApiProvider` (registration). A pi upgrade that renames or deletes
 * either one fails here, named, instead of surfacing as `undefined` three files
 * away from the stack frame that explains it.
 *
 * Import-specifier trap: `/compat` is the only pi-ai subpath allowed in
 * host-loadable code. The host loads extensions through jiti, whose alias
 * whitelist covers four specifiers — the package root, `/compat`, `/oauth` and
 * `/providers/all` — and resolves an aliased package before the package's own
 * `exports` map. So `@earendil-works/pi-ai/api/openai-completions` (or any other
 * `/api/*` path) passes local `tsc` and then fails at host load.
 * `host-seam.test.ts` enforces this over the `src` tree.
 *
 * Re-check after every pi upgrade (OB-2): this module, the wire/error parity
 * suites, the host's retry-classifier prose, and the history-repair dependency
 * in `protocol/transform.ts` (errored turns are dropped by this repo, not by
 * the host).
 */

/** Named prefix on every seam failure, so the acquisition point is one grep away. */
export const QODER_HOST_SEAM_MISSING = "Qoder host seam: @earendil-works/pi-ai/compat";

function missingCompatibility(symbol: string): Error {
  return new Error(
    `${QODER_HOST_SEAM_MISSING} no longer exports ${symbol}. ` +
      "Fix the acquisition in src/host-seam.ts, never at a call site. " +
      "OB-2 re-check after the upgrade: (1) this module, (2) the wire and error parity suites, " +
      "(3) the host's retry-pattern alternation, (4) the history-repair dependency. " +
      "Keep the specifier on /compat: the host's jiti alias whitelist covers only the package root, " +
      "/compat, /oauth and /providers/all, so an /api/* specifier typechecks locally and fails at host load.",
  );
}

/**
 * The host's OpenAI-completions Api, acquired synchronously: the v2 adapter
 * builds the stream it must return without awaiting, so this cannot become an
 * async import.
 */
export function openAICompletionsApi(): ReturnType<typeof qoderCompat.openAICompletionsApi> {
  const acquire = qoderCompat.openAICompletionsApi;
  if (typeof acquire !== "function") throw missingCompatibility("openAICompletionsApi");
  return acquire();
}

/**
 * Register this extension's api with the host's compat registry when the host
 * has one. `true` on success, and `false` when the registry or its export is
 * absent (OMP, or a pi whose facade is gone) — the independent
 * `pi.registerProvider(streamSimple)` path still serves dispatch, so startup
 * continues either way. A present export that throws reports the same way, plus
 * a debugLog record.
 */
export async function registerQoderApiProvider(config: unknown, source: string): Promise<boolean> {
  try {
    const compat = await import("@earendil-works/pi-ai/compat");
    const register = (compat as Record<string, unknown>).registerApiProvider;
    if (typeof register !== "function") return false; // OMP / hosts without the export
    (register as (config: unknown, source: string) => void)(config, source);
    return true;
  } catch (error) {
    // Host has no compat registry; registerProvider(streamSimple) is enough.
    debugLog("pi-ai/compat registerApiProvider unavailable", error);
    return false;
  }
}
