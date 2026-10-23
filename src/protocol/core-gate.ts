// shape: none — two named predicates over one env read; a 2-way boolean is
//   below the ≥3 dispatch-object threshold, and the repo's idiom for a gate is
//   a pure predicate over its input (warm-gate.ts resolves three outcomes in a
//   cascade; this decides one).
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * The two turn-core gates, decided in one place each so the default and the
 * rollback cannot drift apart between the router and the legacy adapter.
 *
 * Both are ON unless the value is exactly `"0"`: unset, empty, `"1"` and any
 * other spelling mean ON, the way `QODER_QUEUE_WAIT` reads. The plan producer
 * and the shared terminal stamp ARE this provider's dispatch, so the ordinary
 * turn takes them; `=0` is the one-release env-flip rollback to the
 * pre-migration path, not an opt-in.
 *
 * The host's `options.env` is honoured before the process env, which is how
 * every other knob in this provider reads.
 */
function gateEnabled(options: SimpleStreamOptions | undefined, name: string): boolean {
  // boundary: process.env values are `string | undefined` by the host's own
  // index signature and are compared against one literal only — no field is
  // read off them, so there is nothing left to narrow (BND-1).
  const value = options?.env?.[name] ?? process.env[name];
  return value !== "0";
}

/** `QODER_CORE_PLAN=0` restores the pre-migration inline dispatch path. */
export function corePlanEnabled(options?: SimpleStreamOptions): boolean {
  return gateEnabled(options, "QODER_CORE_PLAN");
}

/** `QODER_CORE_STAMP=0` restores the pre-migration assembly-site stamps. */
export function coreStampEnabled(options?: SimpleStreamOptions): boolean {
  return gateEnabled(options, "QODER_CORE_STAMP");
}
