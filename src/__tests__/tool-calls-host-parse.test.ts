import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParseToolCallArguments } from "../host-seam.ts";
import { streamQoder } from "../protocol/stream.ts";
import { ToolCallAccumulator, type ToolCallStreamEvent } from "../protocol/tool-calls.ts";
import { chunk, DONE_SSE, finishChunk, mockFetch, sseEnvelope } from "./sse-fixtures.js";

/**
 * Behaviour spec — finished tool arguments when the host can carry the
 * diagnostic.
 *
 * A model that sends a call whose complete text is not a JSON object used to end
 * the turn: `ToolCallAccumulator.finalize()` threw
 * "Invalid or truncated Qoder tool call arguments". On a host that exports
 * `parseToolCallArguments` (pi-ai 1.3.0+), the finished call carries
 * `{ arguments, argumentsError }` on both the content block and the
 * `toolcall_end` event, so the host's tool validation reports the problem to the
 * model instead. A host without the export keeps the old throw, text included.
 *
 * The accumulator's parser is INJECTED below: every row states which host it
 * models and none reads the installed pi-ai version.
 *
 * The one failure that stays terminal is `finish_reason: "length"` — the call
 * was cut off by the output-token cap, so reporting it would spend a retryable
 * model round-trip on a call this provider knows is incomplete. That guard runs
 * in stream.ts before the accumulator finalises, which the last row observes
 * through the parser never being called.
 */

/**
 * The seam is wrapped, not replaced: `override` models the host-carried parser
 * for the stream rows, and every other row uses the installed host as-is.
 */
const seam = vi.hoisted(() => ({ override: undefined as ParseToolCallArguments | undefined }));

vi.mock("../host-seam.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host-seam.ts")>();
  return {
    ...actual,
    hostParseToolCallArguments: () =>
      seam.override === undefined ? actual.hostParseToolCallArguments() : seam.override,
  };
});

// Pin the identity so the mocked fetch only ever serves the chat request.
vi.mock("../auth/oauth.js", () => ({
  resolveQoderIdentity: vi.fn().mockResolvedValue({
    access: "fake",
    userID: "test-user",
    email: "test@example.com",
    name: "Test User",
    machineID: "test-machine",
    refresh: "",
    expires: 0,
  }),
}));

// invented: the bytes a call cut off mid-object leaves behind — the exact
// malformed text stream.test.ts carries in its length-truncation row.
const MALFORMED_ARGUMENTS = '{"command":';
// invented: a complete, well-formed call.
const VALID_ARGUMENTS = '{"command":"ls"}';
const TRUNCATION_ERROR = "Qoder tool call was truncated by the output token limit";

/** Drive one native tool call through the accumulator with the given host parser. */
function finishCall(
  argumentsText: string,
  parseFinishedArguments: ParseToolCallArguments | null,
): { block: ToolCall; events: ToolCallStreamEvent[]; hasToolCalls: boolean } {
  const output = { content: [] } as unknown as AssistantMessage;
  const events: ToolCallStreamEvent[] = [];
  const accumulator = new ToolCallAccumulator(output, (event) => events.push(event), parseFinishedArguments);
  accumulator.processNativeDelta({ index: 0, id: "call_1", function: { name: "bash", arguments: argumentsText } });
  const hasToolCalls = accumulator.finalize();
  return { block: output.content[0] as ToolCall, events, hasToolCalls };
}

describe("host-carried argumentsError", () => {
  it("reports malformed finished arguments on the block and on the toolcall_end event", () => {
    const parser = vi.fn(() => ({ arguments: {}, argumentsError: "bad" }));

    const { block, events, hasToolCalls } = finishCall(MALFORMED_ARGUMENTS, parser);

    expect(parser).toHaveBeenCalledWith(MALFORMED_ARGUMENTS);
    expect(hasToolCalls).toBe(true);
    expect(block.arguments).toEqual({});
    expect(block.argumentsError).toBe("bad");
    expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: {}, argumentsError: "bad" },
    });
  });

  it("produces today's block and event when the host parser returns valid arguments", () => {
    const parser = vi.fn(() => ({ arguments: { command: "ls" } }));

    const { block, events } = finishCall(VALID_ARGUMENTS, parser);

    // The parser is the one that ran — it returns the same object the old strict
    // parse produced for this text, so the observable result is unchanged.
    expect(parser).toHaveBeenCalledWith(VALID_ARGUMENTS);
    expect(block).toEqual({ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } });
    expect("argumentsError" in block).toBe(false);

    const end = events.find((event) => event.type === "toolcall_end");
    if (end?.type !== "toolcall_end") throw new Error("expected the finished call's toolcall_end event");
    expect(end.toolCall).toEqual({ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } });
    expect("argumentsError" in end.toolCall).toBe(false);
  });

  it("keeps the exact legacy failure on a host with no parser", () => {
    let thrown: unknown;
    try {
      finishCall(MALFORMED_ARGUMENTS, null);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Invalid or truncated Qoder tool call arguments");
  });
});

// ---------------------------------------------------------------------------
// The length-truncation guard outranks the host diagnostic
// ---------------------------------------------------------------------------

function makeModel(): Model<Api> {
  return { id: "Lite", api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
}

function makeContext(): TranscriptContext {
  return normalizeContext({
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context);
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "done" || event.type === "error") break;
  }
  return events;
}

/** One turn: a malformed tool call, then `finish_reason`. */
async function turnWithMalformedCall(finishReason: string): Promise<AssistantMessageEvent[]> {
  globalThis.fetch = mockFetch(
    sseEnvelope(
      chunk({ tool_calls: [{ index: 0, id: "call", function: { name: "bash", arguments: MALFORMED_ARGUMENTS } }] }),
    ) +
      sseEnvelope(finishChunk(finishReason)) +
      DONE_SSE,
  );
  return consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
}

describe("length truncation fails before the host parser can report", () => {
  afterEach(() => {
    seam.override = undefined;
  });

  it("still fails a call cut off by the output token limit, without asking the host parser", async () => {
    const parser = vi.fn(() => ({ arguments: {}, argumentsError: "bad" }));
    seam.override = parser;

    const events = await turnWithMalformedCall("length");

    expect(events.at(-1)).toMatchObject({ type: "error", error: { errorMessage: TRUNCATION_ERROR } });
    expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
    // The guard runs before finalisation, so the parser that would have reported
    // this call was never reached.
    expect(parser).not.toHaveBeenCalled();
  });

  it("reports the same bytes when the finish reason is not length (control: the override is live)", async () => {
    const parser = vi.fn(() => ({ arguments: {}, argumentsError: "bad" }));
    seam.override = parser;

    const events = await turnWithMalformedCall("tool_calls");

    expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(parser).toHaveBeenCalledWith(MALFORMED_ARGUMENTS);
    expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
      toolCall: { arguments: {}, argumentsError: "bad" },
    });
  });
});
