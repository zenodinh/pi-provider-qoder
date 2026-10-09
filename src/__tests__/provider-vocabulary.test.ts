// shape: none — this unit is a parity suite over two constant modules; it
//   introduces no runtime construct, so no §Vocabulary idiom applies.
//
// Spec: the vocabulary module is the single home of every provider-owned value.
// covered behaviors:
//   1. the thinking levels Qoder can express == the host's own level vocabulary
//      minus `off` (input: the host's getSupportedThinkingLevels; observable: the
//      exported EFFORT members; error contract: n/a — pure parity);
//   2. AUTHORITY ranks are unique and ordered highest-first, and every WIRE_ROLE
//      carries a member of AUTHORITY (input: the exported tables; observable:
//      the rank sequence);
//   3. no module outside vocabulary.ts writes the instruction role or the
//      non-client cap field name (input: the source tree; observable: an empty
//      offender list). This is what makes the enum binding rather than decorative:
//      a future change must pick a member instead of guessing a literal.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY,
  EFFORT,
  MAX_TOKENS_FIELD,
  MODEL_ORIGIN,
  SCENE,
  THINKING_MODE,
  WIRE_ROLE,
} from "../protocol/vocabulary.ts";

/** Every .ts file under src/, excluding the suite and the recorded fixtures. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^(__tests__|__fixtures__|node_modules)$/.test(entry.name)) continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("provider vocabulary", () => {
  it("names every thinking level the host can offer, minus the off switch", () => {
    // The host hides `xhigh`/`max` behind an explicit map entry, and hides any
    // level mapped to null (getSupportedThinkingLevels). Supplying a map for every
    // level this provider can express therefore returns the host's whole
    // vocabulary: a level pi adds later makes this assertion red instead of
    // leaving that level silently unreachable for Qoder models.
    const named = Object.keys(EFFORT).filter((key) => key !== "none");
    const fullyMapped: Record<string, string> = { off: "off" };
    for (const level of named) fullyMapped[level] = level;
    const offered = getSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: fullyMapped,
    } as unknown as Model<Api>);
    expect(offered).toEqual(["off", ...named]);
  });

  it("orders authority highest-first and gives every role a real authority", () => {
    const ranks = Object.values(AUTHORITY).map((level) => level.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
    for (const role of Object.values(WIRE_ROLE)) {
      expect(Object.values(AUTHORITY)).toContain(role.authority);
    }
    // The only instruction role this provider writes.
    expect(WIRE_ROLE.system.wire).toBe("system");
    // The guideline level belongs to spec sections, never to a message role; the
    // type already forbids one, and this pins that none is ever added.
    expect(Object.keys(WIRE_ROLE)).not.toContain("guideline");
  });

  it("pins the cap field name to the one both client bodies use", () => {
    expect(MAX_TOKENS_FIELD.maxTokens).toBe("max_tokens");
  });

  it("routes every catalog source through a named origin", () => {
    expect(MODEL_ORIGIN.system.transport).toBe("legacy");
    expect(MODEL_ORIGIN.user.transport).toBe("v2");
    expect(MODEL_ORIGIN.custom.transport).toBe("unsupported");
    expect(SCENE.chat.group).toBe("chat");
    expect(THINKING_MODE.disabled).toBe("disabled");
  });

  it("writes no provider-owned literal outside the vocabulary module", () => {
    const banned: Array<[string, RegExp]> = [
      ["instruction role literal", /role\s*:\s*"(system|developer)"/],
      ["non-client cap field", /max_completion_tokens/],
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      if (file.endsWith(join("protocol", "vocabulary.ts"))) continue;
      const text = readFileSync(file, "utf8");
      for (const [label, pattern] of banned) {
        if (pattern.test(text)) offenders.push(`${file.replace(/\\/g, "/")}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
