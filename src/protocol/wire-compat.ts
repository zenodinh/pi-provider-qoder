// shape: none — a frozen literal policy table beside its syntactic guard and two
//   pure accessors: no dispatch object (no ≥3-branch discriminator), no loader,
//   no memo, no I/O. Mirrors routing.ts's interface + reject-wholesale validator
//   idiom for the record shape without copying its user-override file.

/** The wire carriers whose per-protocol divergences this table classifies. */
export type WireCarrier = "legacy" | "v2";

export interface QoderWireCompatData {
  version: number;
  fallbackScope: string;
  sessionKeyBoundPolicy: string[];
  osVocabulary: string[];
  affinityPlacement: string[];
  affinityPlacementGated: string[];
  contextLengthEmission: string[];
  enableThinkingPath: string[];
  systemSlot: string[];
  businessLifecycle: string[];
}

// Flattened from the SA's §5 QoderWireCompat literal: every per-protocol row is
// one string[] of `carrier:value` entries, because FR-2's failure condition is a
// nested-map row and the merged draft's D2 restricts rows to RoutingData-flat
// kinds. `affinityPlacementGated` keeps the CU-7 probe-gated legacy placements
// (the prompt_cache_key body field and the unsigned header trio) out of the
// live set so a probe verdict moves one string between two rows. The module is
// the whole policy: no user-override file can change it.
export const QODER_WIRE_COMPAT: QoderWireCompatData = deepFrozen({
  version: 1,
  fallbackScope: "process",
  sessionKeyBoundPolicy: ["legacy:hash", "v2:clamp"],
  osVocabulary: ["legacy:Cosy-Machineos=*_linux-on-macos", "v2:pi-ai-owned"],
  affinityPlacement: ["v2:prompt_cache_key", "v2:header-x-session-id", "v2:envelope-session-id", "legacy:session_id"],
  affinityPlacementGated: ["legacy:prompt_cache_key", "legacy:header-x-session-id"],
  // SA §5 prints this row as {legacy: "envelope-string", v2: "top-level-number"}, but
  // both forms are v2's (v2.ts:146 envelope-string, v2.ts:152 top-level number) and
  // legacy emits context_length in no form (stream.ts:326-371), so the code-evidenced
  // values are none/both — the same domain D2 declares {envelope-string|top-level-number|both|none}.
  contextLengthEmission: ["legacy:none", "v2:both"],
  enableThinkingPath: ["legacy:parameters", "v2:top-level"],
  systemSlot: ["legacy:messages[0]", "v2:pi-ai-instruction"],
  businessLifecycle: ["legacy:full", "v2:omitted"],
});

/** Freeze the table and each row so the shipped policy is immutable data. */
function deepFrozen(table: QoderWireCompatData): QoderWireCompatData {
  for (const value of Object.values(table)) {
    if (Array.isArray(value)) Object.freeze(value);
  }
  return Object.freeze(table);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Syntactic guard mirroring isRoutingData: presence plus typeof for the scalars,
 * isStringArray for every array row, false on the first miss. A well-formed but
 * semantically wrong carrier entry passes — the validator invents no carrier or
 * field rules, so a typo surfaces as undefined at the accessor, not here.
 */
export function isWireCompatData(value: unknown): value is QoderWireCompatData {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value) || typeof value.version !== "number") return false;
  if (!("fallbackScope" in value) || typeof value.fallbackScope !== "string") return false;
  if (!("sessionKeyBoundPolicy" in value) || !isStringArray(value.sessionKeyBoundPolicy)) return false;
  if (!("osVocabulary" in value) || !isStringArray(value.osVocabulary)) return false;
  if (!("affinityPlacement" in value) || !isStringArray(value.affinityPlacement)) return false;
  if (!("affinityPlacementGated" in value) || !isStringArray(value.affinityPlacementGated)) return false;
  if (!("contextLengthEmission" in value) || !isStringArray(value.contextLengthEmission)) return false;
  if (!("enableThinkingPath" in value) || !isStringArray(value.enableThinkingPath)) return false;
  if (!("systemSlot" in value) || !isStringArray(value.systemSlot)) return false;
  if (!("businessLifecycle" in value) || !isStringArray(value.businessLifecycle)) return false;
  return true;
}

/**
 * Every `carrier:value` entry for `carrier`, carrier prefix stripped. The split
 * happens once at the first separator; an entry with no separator is skipped
 * rather than read as an empty value.
 */
function carrierValues(row: readonly string[], carrier: WireCarrier): string[] {
  const values: string[] = [];
  for (const entry of row) {
    const separator = entry.indexOf(":");
    if (separator === -1) continue;
    if (entry.slice(0, separator) === carrier) values.push(entry.slice(separator + 1));
  }
  return values;
}

/** The value `row` carries for `carrier`, or undefined when it carries none — never an invented default. */
export function carrierValue(row: readonly string[], carrier: WireCarrier): string | undefined {
  return carrierValues(row, carrier)[0];
}

/** The live affinity placements for `carrier`; the probe-gated row is never merged into this set. */
export function affinityPlacements(carrier: WireCarrier, table: QoderWireCompatData = QODER_WIRE_COMPAT): string[] {
  return carrierValues(table.affinityPlacement, carrier);
}

/**
 * True when the live legacy row carries an affinity placement beyond the
 * identity baseline `session_id` — i.e. a probe verdict has promoted a gated
 * carrier and the parity cutover (fs-qoder-legacy-affinity CU-06) must
 * discard profiles learned under the pre-promotion wire. The shipped table
 * answers false: `session_id` has always been live and is not a change.
 */
// shape: none — a one-line predicate over the frozen rows; dispatch object does
//   not apply: no discriminator, no state, no I/O.
export function legacyAffinityCutoverLive(table: QoderWireCompatData = QODER_WIRE_COMPAT): boolean {
  return affinityPlacements("legacy", table).some((placement) => placement !== "session_id");
}
