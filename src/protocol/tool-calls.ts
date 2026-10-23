import type { AssistantMessage, AssistantMessageEventStream, JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { repairJsonEscapes } from "./json-repair.ts";

export type ToolCallStreamEvent = Parameters<AssistantMessageEventStream["push"]>[0];

type ToolCallDelta = {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    // A string fragment on every documented transport, but the gateway also
    // sends an already-parsed object; see `argumentText`.
    arguments?: unknown;
  };
};

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart: boolean;
  emittedEnd: boolean;
  contentIndex: number;
}

/**
 * Reduces native OpenAI tool-call deltas and leaked DSML calls into the same
 * pi tool-call event sequence. Native indexes and DSML ids stay in separate
 * namespaces, while `ordered` preserves the order in which blocks appeared.
 */
export class ToolCallAccumulator {
  private readonly native = new Map<number, ToolCallState>();
  private readonly dsml = new Map<string, ToolCallState>();
  private readonly ordered: ToolCallState[] = [];

  constructor(
    private readonly output: AssistantMessage,
    private readonly emitEvent: (event: ToolCallStreamEvent) => void,
  ) {}

  processNativeDelta(delta: ToolCallDelta): void {
    const index = delta.index ?? 0;
    let state = this.native.get(index);
    if (!state) {
      state = this.createState();
      this.native.set(index, state);
    }

    if (delta.id) state.id = delta.id;
    if (delta.function?.name) state.name = delta.function.name;
    this.openIfIdentifiable(state);
    if (state.emittedStart) {
      const block = this.output.content[state.contentIndex] as ToolCall;
      block.id = state.id;
      block.name = state.name;
    }

    const argumentsDelta = argumentText(delta.function?.arguments);
    if (argumentsDelta) this.appendArguments(state, argumentsDelta);
  }

  startDsmlCall(id: string, name: string): void {
    const state = this.createState();
    state.id = id;
    state.name = name;
    this.dsml.set(id, state);
    this.openIfIdentifiable(state);
  }

  appendDsmlArguments(id: string, argumentsDelta: string): void {
    const state = this.dsml.get(id);
    if (state) this.appendArguments(state, argumentsDelta);
  }

  finalize(): boolean {
    // Validate the entire batch before exposing any completed executable call.
    const parsed = new Map<ToolCallState, JsonObject>();
    for (const state of this.ordered) {
      if (!state.emittedStart && !state.arguments) continue;
      if (!state.id || !state.name) throw new Error("Incomplete Qoder tool call identity");
      parsed.set(state, parseArguments(state.arguments));
    }
    for (const state of this.ordered) {
      if (!state.emittedStart || state.emittedEnd) continue;
      state.emittedEnd = true;
      const args = parsed.get(state) ?? {};
      const block = this.output.content[state.contentIndex] as ToolCall;
      block.arguments = args;
      this.emitEvent({
        type: "toolcall_end",
        contentIndex: state.contentIndex,
        toolCall: {
          type: "toolCall",
          id: state.id,
          name: state.name,
          arguments: args,
        },
        partial: this.output,
      });
    }
    return this.ordered.some((state) => state.emittedStart);
  }

  private createState(): ToolCallState {
    const state: ToolCallState = {
      arguments: "",
      id: "",
      name: "",
      emittedStart: false,
      emittedEnd: false,
      contentIndex: 0,
    };
    this.ordered.push(state);
    return state;
  }

  private openIfIdentifiable(state: ToolCallState): void {
    if (state.emittedStart || (!state.id && !state.name)) return;
    state.emittedStart = true;
    state.contentIndex = this.output.content.length;
    this.output.content.push({
      type: "toolCall",
      id: state.id,
      name: state.name,
      arguments: {},
    } satisfies ToolCall);
    this.emitEvent({ type: "toolcall_start", contentIndex: state.contentIndex, partial: this.output });

    // Native streams can send arguments before the id/name. Once the call is
    // identifiable, expose the accumulated prefix before accepting new bytes.
    if (state.arguments) {
      this.emitEvent({
        type: "toolcall_delta",
        contentIndex: state.contentIndex,
        delta: state.arguments,
        partial: this.output,
      });
    }
  }

  private appendArguments(state: ToolCallState, argumentsDelta: string): void {
    state.arguments += argumentsDelta;
    if (!state.emittedStart) return;
    this.emitEvent({
      type: "toolcall_delta",
      contentIndex: state.contentIndex,
      delta: argumentsDelta,
      partial: this.output,
    });
  }
}

/**
 * Normalize a streamed argument fragment to text.
 *
 * `function.arguments` is documented as a string fragment, but the gateway
 * sometimes delivers an already-parsed object. String-concatenating that
 * accumulated "[object Object]" and the call then failed with the same
 * "Invalid or truncated Qoder tool call arguments" as a genuine cut-off.
 */
function argumentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return undefined;
}

/**
 * Parse finished argument text as an object.
 *
 * A model copying a source file into an `edit` argument can emit a complete call
 * whose string literals are not legal JSON (a raw control character, or a
 * backslash that starts no escape), so illegal bytes inside string literals are
 * re-escaped once and the call parsed again. Structure is never repaired: a call
 * cut off by the output limit still fails here.
 */
function parseArguments(value: string): JsonObject {
  const parsed = parseJsonObject(value);
  if (parsed) return parsed;

  // Only pay for a second parse when the repair actually changed the bytes.
  const repaired = repairJsonEscapes(value);
  if (repaired !== value) {
    const repairedObject = parseJsonObject(repaired);
    if (repairedObject) return repairedObject;
  }

  throw new Error("Invalid or truncated Qoder tool call arguments");
}

/** Parse argument text as a JSON object, or return null when it is not one. */
function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {}
  return null;
}
