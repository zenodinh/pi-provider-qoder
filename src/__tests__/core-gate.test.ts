import { afterEach, describe, expect, it, vi } from "vitest";
import { corePlanEnabled, coreStampEnabled } from "../protocol/core-gate.ts";

// spec (owner decision 2026-10-10, the turn-core default flip):
//   corePlanEnabled(options) / coreStampEnabled(options) -> true unless the
//     gate's value is exactly "0". Unset, empty, "1" and any other spelling are
//     true, so the ordinary dispatch takes the plan producer and the shared
//     terminal stamp; "0" is the one-release rollback to the pre-migration path.
//   The host's options.env is read before process.env.

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The two predicates with the env var name each one reads. */
const GATES = [
  { name: "QODER_CORE_PLAN", enabled: corePlanEnabled },
  { name: "QODER_CORE_STAMP", enabled: coreStampEnabled },
] as const;

describe("the two turn-core gates are opt-out", () => {
  it("is on when unset, and for every value except an exact 0", () => {
    for (const gate of GATES) {
      vi.unstubAllEnvs();
      expect(gate.enabled(), `${gate.name} unset`).toBe(true);
      // A host may hand an explicit empty string; it is still the default path.
      expect(gate.enabled({ env: { [gate.name]: "" } }), `${gate.name} empty`).toBe(true);
      for (const on of ["1", "true", "00", " 0", "off"]) {
        expect(gate.enabled({ env: { [gate.name]: on } }), `${gate.name}=${JSON.stringify(on)}`).toBe(true);
      }
      expect(gate.enabled({ env: { [gate.name]: "0" } }), `${gate.name}=0`).toBe(false);
    }
  });

  it("reads the host's options.env ahead of a shell export, in both directions", () => {
    for (const gate of GATES) {
      vi.stubEnv(gate.name, "1");
      expect(gate.enabled({ env: { [gate.name]: "0" } }), `${gate.name}: options.env=0 beats process.env=1`).toBe(
        false,
      );

      vi.stubEnv(gate.name, "0");
      expect(gate.enabled({ env: { [gate.name]: "1" } }), `${gate.name}: options.env=1 beats process.env=0`).toBe(true);
      // No host env at all: the process env decides.
      expect(gate.enabled({}), `${gate.name}: process.env=0 with no host env`).toBe(false);
    }
  });
});
