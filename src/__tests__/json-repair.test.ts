import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { repairJsonEscapes } from "../protocol/json-repair.ts";
import { ToolCallAccumulator } from "../protocol/tool-calls.ts";

/**
 * Behaviour spec for the escape repair. A model that copies the file it is
 * editing into an `edit` argument produces a *complete* call that is not legal
 * JSON:
 *
 *   text  {"new_text":"line1<RAW 0x0a>line2"}   raw newline inside the literal
 *   value { new_text: "line1\nline2" }          the newline the model meant
 *
 * The error contract is unchanged: repair never completes structure, so a call
 * cut off by the output limit still throws
 * "Invalid or truncated Qoder tool call arguments".
 */
function decode(value: string): unknown {
  return JSON.parse(repairJsonEscapes(value));
}

/** Drive one native tool call through the accumulator the way stream.ts does. */
function finishNativeCall(argumentsValue: unknown): ToolCall {
  const output = { content: [] } as unknown as AssistantMessage;
  const accumulator = new ToolCallAccumulator(output, () => {});
  accumulator.processNativeDelta({ index: 0, id: "call_1", function: { name: "bash", arguments: argumentsValue } });
  accumulator.finalize();
  return output.content[0] as ToolCall;
}

describe("repairJsonEscapes", () => {
  it("decodes a raw newline inside a string to a newline", () => {
    // Two source lines copied into one argument: the bytes are a real newline,
    // which no JSON string literal may carry.
    const argumentsText = '{"path":"a.c","new_text":"line1\nline2"}';

    expect(() => JSON.parse(argumentsText)).toThrow();
    expect(decode(argumentsText)).toEqual({ path: "a.c", new_text: "line1\nline2" });
  });

  it("decodes a backslash that starts no escape to a literal backslash", () => {
    // `\d` is not a JSON escape, so the model meant the characters `\` and `d`.
    const argumentsText = '{"new_text":"print(\\d)"}';

    expect(() => JSON.parse(argumentsText)).toThrow();
    expect(decode(argumentsText)).toEqual({ new_text: "print(\\d)" });
  });

  it("leaves a valid \\u00e9 escape untouched", () => {
    const argumentsText = '{"text":"caf\\u00e9"}';

    expect(repairJsonEscapes(argumentsText)).toBe(argumentsText);
    expect(decode(argumentsText)).toEqual({ text: "café" });
  });

  it("returns clean argument text unchanged", () => {
    const argumentsText = '{"path":"src/a.ts","limit":20}';

    expect(repairJsonEscapes(argumentsText)).toBe(argumentsText);
  });

  it("escapes each raw control character to its JSON form", () => {
    // \t, \r, \b and \f have short forms; 0x01 has none and becomes \u0001.
    const argumentsText = '{"text":"a\tb\rc\bd\fe\u0001f"}';

    expect(decode(argumentsText)).toEqual({ text: "a\tb\rc\bd\fe\u0001f" });
  });

  it("copies a valid escape sequence through", () => {
    const argumentsText = '{"text":"quote:\\" slash:\\/ backslash:\\\\ tab:\\t"}';

    expect(repairJsonEscapes(argumentsText)).toBe(argumentsText);
    expect(decode(argumentsText)).toEqual({ text: 'quote:" slash:/ backslash:\\ tab:\t' });
  });

  it("doubles a trailing backslash without closing the call", () => {
    // A backslash with nothing left to escape is a literal one; the text stays
    // unterminated, so the call still fails rather than being guessed complete.
    expect(repairJsonEscapes('{"path":"a\\')).toBe('{"path":"a\\\\');
    expect(() => JSON.parse(repairJsonEscapes('{"path":"a\\'))).toThrow();
  });

  it("copies bytes outside string literals unchanged", () => {
    // A control character between tokens is structural damage, not escape
    // damage; rewriting it here would be guessing structure.
    const argumentsText = '{"limit":\t20}';

    expect(repairJsonEscapes(argumentsText)).toBe(argumentsText);
  });
});

describe("finished tool arguments", () => {
  it.each([
    ["an opening fragment", '{"command":'],
    ["an unterminated string holding a raw newline", '{"command":"echo one\ntwo'],
  ])("keeps rejecting structurally truncated arguments: %s", (_shape, argumentsText) => {
    // The second payload is repaired and still unterminated: a call cut off by
    // the output limit must fail, never run on guessed arguments.
    expect(() => finishNativeCall(argumentsText)).toThrow("Invalid or truncated Qoder tool call arguments");
  });

  it("serializes an already-parsed arguments object instead of concatenating it", () => {
    // The gateway sometimes delivers the parsed value rather than a string
    // fragment; concatenating it produced "[object Object]" and failed the call.
    const toolCall = finishNativeCall({ path: "/a.c" });

    expect(toolCall.arguments).toEqual({ path: "/a.c" });
  });
});
