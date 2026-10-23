import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.ts";
import { clearQoderModelsMemCache } from "../catalog.ts";
import { streamQoder } from "../protocol/stream.ts";
import { chunk, DONE_SSE, finishChunk, sseEnvelope } from "./sse-fixtures.ts";

/**
 * Resume-once for a timed-out turn, at the transport's own entry (`streamQoder`
 * is what the router registers with pi as `streamSimple`).
 *
 * Every row drives a real timeout — no timer is faked — so the row proves the
 * production trigger: a body that stops yielding is ended by the stream's idle
 * timer at `QODER_STREAM_IDLE_TIMEOUT_MS` (120 s in production, a few ms here),
 * and a host deadline ends it at `timeoutMs`. That the 120 s boundary itself is
 * what production hits is pinned by `error-vocabulary.test.ts`'s two abort-reason
 * rows; this file pins what happens to a turn that has already streamed content
 * when it gets there.
 *
 * Fixture provenance: every SSE body here is INVENTED. No live recording of a
 * timeout exists in this repo — 49 recorded debug sessions contain none — so the
 * shape is the recorded gateway chunk shape (`sse-fixtures.ts`) with invented
 * text, and the timeout is produced by stalling the body rather than by a
 * recorded stall.
 */

const CONTINUATION_PROMPT =
  "Continue the original task from exactly where the previous response stopped. " +
  "Do not repeat any reasoning or text already generated; continue and finish the response.";

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

/** One scripted chat answer: the SSE bytes the body yields, then whether it stalls. */
interface ChatAnswer {
  sse: string;
  /** The body never closes and never yields again, so only the idle timer ends it. */
  stall: boolean;
  /** Runs when this answer is requested, which is how an abort lands mid-continuation. */
  onCall?: () => void;
}

/**
 * Serve `answers` in order, once per chat POST. The last answer repeats, so a
 * row that must not send a third request still fails loudly on the request count
 * rather than hanging on an absent script entry.
 */
function scriptedFetch(answers: ChatAnswer[]) {
  let index = 0;
  const fetchMock = vi.fn(async () => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    answer.onCall?.();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(answer.sse));
        if (!answer.stall) controller.close();
      },
      cancel() {
        // The stall is cancelled by the abort; a row asserts on requests, not bytes.
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  return fetchMock as unknown as typeof globalThis.fetch & { mock: { calls: Array<[string, RequestInit]> } };
}

/** The chat POSTs a mock served (the identity lookup is cached, so this is all of them). */
const chatPosts = (fetchMock: { mock: { calls: Array<[string, RequestInit]> } }): number => fetchMock.mock.calls.length;

const doneOf = (events: AssistantMessageEvent[]): AssistantMessage => {
  const done = events.find((event) => event.type === "done");
  if (!done) throw new Error(`no done event; last was ${JSON.stringify(events.at(-1))}`);
  return done.message;
};

const errorOf = (events: AssistantMessageEvent[]): AssistantMessage => {
  const last = events.at(-1);
  if (last?.type !== "error") throw new Error(`no error event; last was ${JSON.stringify(last)}`);
  return last.error;
};

const textOf = (message: AssistantMessage): string =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/** The logical bodies the transport built, in dispatch order. */
function capturedBodies(bodies: Record<string, unknown>[]) {
  return (payload: unknown) => {
    bodies.push(payload as Record<string, unknown>);
    return undefined;
  };
}

const messageAt = (body: Record<string, unknown>, fromEnd: number): Record<string, unknown> => {
  const messages = body.messages as Record<string, unknown>[];
  return messages[messages.length - 1 - fromEnd];
};

beforeEach(() => {
  // The cache key is `${providerID}:${accessToken}` (oauth.ts), so the identity
  // lookup below never spends a request the chat script did not offer.
  cacheQoderIdentityForTest("qoder:fake", {
    access: "fake",
    refresh: "",
    expires: 0,
    userID: "user",
    name: "Test",
    email: "test@example.com",
    machineID: "machine",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected global fetch");
    }),
  );
});

afterEach(() => {
  clearQoderAuthMemCache();
  clearQoderModelsMemCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The idle-timer options every row needs: a real timeout, fast. */
const idleEnv = { QODER_STREAM_IDLE_TIMEOUT_MS: "10" };

describe("resume a timed-out turn once", () => {
  it("continues a timed-out answer and ends with one stop carrying both halves", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = scriptedFetch([
      { sse: sseEnvelope(chunk({ content: "the first half" })), stall: true },
      {
        sse: sseEnvelope(chunk({ content: " and the rest" })) + sseEnvelope(finishChunk("stop")) + DONE_SSE,
        stall: false,
      },
    ]);

    const events = await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        sessionId: "resume-once",
        env: idleEnv,
        fetch: fetchMock,
        onPayload: capturedBodies(bodies),
      } as SimpleStreamOptions),
    );

    const message = doneOf(events);
    const terminals = events.filter((event) => event.type === "done" || event.type === "error");
    expect(terminals, "one terminal event, not an error followed by a done").toHaveLength(1);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([
      { type: "text", text: "the first half" },
      { type: "text", text: " and the rest" },
    ]);
    expect(textOf(message)).toBe("the first half and the rest");
    // The continuation's block is index 1 of the original message, never index 0.
    expect(events.filter((event) => event.type === "text_start").map((event) => event.contentIndex)).toEqual([0, 1]);
    // Every event the host saw belongs to one message: the relay appends to the
    // original rather than handing the host a second one.
    const partials = events.flatMap((event) => ("partial" in event ? [event.partial] : []));
    expect(new Set(partials).size).toBe(1);
    expect(partials[0]).toBe(message);

    expect(chatPosts(fetchMock), "the timed-out attempt plus exactly one continuation").toBe(2);
    const [timedOut, continued] = bodies;
    // The same conversation: same wire session, same prompt-cache key, so the
    // continuation reads the cache the first attempt wrote.
    expect(continued.session_id).toBe(timedOut.session_id);
    expect(continued.prompt_cache_key).toBe(timedOut.prompt_cache_key);
    expect(continued.request_id).not.toBe(timedOut.request_id);
    // The partial answer goes back as a finished assistant turn, then the prompt.
    expect(messageAt(continued, 1)).toMatchObject({ role: "assistant", content: "the first half" });
    expect(messageAt(continued, 0)).toEqual({ role: "user", content: CONTINUATION_PROMPT });
  });

  it("does not continue a turn that already opened a tool call", async () => {
    const fetchMock = scriptedFetch([
      {
        sse:
          sseEnvelope(chunk({ content: "checking " })) +
          sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } }] })),
        stall: true,
      },
      {
        sse: sseEnvelope(chunk({ content: " and the rest" })) + sseEnvelope(finishChunk("stop")) + DONE_SSE,
        stall: false,
      },
    ]);

    const events = await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        sessionId: "resume-tool-call",
        env: idleEnv,
        fetch: fetchMock,
      } as SimpleStreamOptions),
    );

    expect(chatPosts(fetchMock), "half-written arguments are not resumable").toBe(1);
    expect(events.find((event) => event.type === "done")).toBeUndefined();
    expect(errorOf(events).errorMessage).toBe("Qoder stream idle timeout");
  });

  it("does not continue a turn that never streamed answer content", async () => {
    const fetchMock = scriptedFetch([
      { sse: "", stall: true },
      { sse: sseEnvelope(chunk({ content: " and the rest" })) + DONE_SSE, stall: false },
    ]);

    const events = await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        sessionId: "resume-empty",
        env: idleEnv,
        fetch: fetchMock,
      } as SimpleStreamOptions),
    );

    expect(chatPosts(fetchMock), "nothing was said, so there is nothing to finish").toBe(1);
    expect(errorOf(events).errorMessage).toBe("Qoder stream idle timeout");
  });

  it("makes one attempt only, so a second timeout ends the turn", async () => {
    const fetchMock = scriptedFetch([
      { sse: sseEnvelope(chunk({ content: "first" })), stall: true },
      { sse: sseEnvelope(chunk({ content: "second" })), stall: true },
      { sse: sseEnvelope(chunk({ content: "third" })) + DONE_SSE, stall: false },
    ]);

    const events = await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        sessionId: "resume-once-only",
        env: idleEnv,
        fetch: fetchMock,
      } as SimpleStreamOptions),
    );

    expect(chatPosts(fetchMock), "the second timeout is terminal, not a third request").toBe(2);
    expect(events.find((event) => event.type === "done")).toBeUndefined();
    const error = errorOf(events);
    expect(error.errorMessage).toBe("Qoder stream idle timeout");
    expect(error.stopReason).toBe("error");
    // Both halves stay on the message the host rendered; only the terminal differs.
    expect(textOf(error)).toBe("firstsecond");
  });

  it("keeps today's failure with QODER_RESUME_TIMEOUT=0", async () => {
    const fetchMock = scriptedFetch([
      { sse: sseEnvelope(chunk({ content: "the first half" })), stall: true },
      { sse: sseEnvelope(chunk({ content: " and the rest" })) + DONE_SSE, stall: false },
    ]);

    const events = await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        sessionId: "resume-off",
        env: { ...idleEnv, QODER_RESUME_TIMEOUT: "0" },
        fetch: fetchMock,
      } as SimpleStreamOptions),
    );

    expect(chatPosts(fetchMock), "the off switch spends no extra request").toBe(1);
    expect(events.find((event) => event.type === "done")).toBeUndefined();
    const error = errorOf(events);
    expect(error.stopReason).toBe("error");
    expect(error.errorMessage).toBe("Qoder stream idle timeout");
    expect(textOf(error), "the partial answer is kept, exactly as before").toBe("the first half");
  });

  it("ends the turn aborted when the signal aborts during the continuation", async () => {
    const controller = new AbortController();
    const fetchMock = scriptedFetch([
      { sse: sseEnvelope(chunk({ content: "the first half" })), stall: true },
      { sse: sseEnvelope(chunk({ content: " and the rest" })), stall: true, onCall: () => controller.abort() },
    ]);

    const events = await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        sessionId: "resume-abort",
        env: idleEnv,
        fetch: fetchMock,
        signal: controller.signal,
      } as SimpleStreamOptions),
    );

    expect(chatPosts(fetchMock), "the abort lands on the continuation it interrupted").toBe(2);
    expect(events.find((event) => event.type === "done")).toBeUndefined();
    expect(errorOf(events).stopReason).toBe("aborted");
  });

  it("rejects a tool call from a continuation instead of relaying it", async () => {
    // The continuation was asked to finish the answer, not to start work: a tool
    // call there has no tool round behind it, so the turn ends rather than handing
    // the host a call nobody will execute.
    const fetchMock = scriptedFetch([
      { sse: sseEnvelope(chunk({ content: "the first half" })), stall: true },
      {
        sse:
          sseEnvelope(
            chunk({ tool_calls: [{ index: 0, id: "c2", function: { name: "bash", arguments: '{"command":"ls"}' } }] }),
          ) +
          sseEnvelope(chunk({}, { choices: [{ finish_reason: "tool_calls", index: 0 }] })) +
          DONE_SSE,
        stall: false,
      },
    ]);

    const events = await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        sessionId: "resume-tool-answer",
        env: idleEnv,
        fetch: fetchMock,
      } as SimpleStreamOptions),
    );

    expect(chatPosts(fetchMock)).toBe(2);
    expect(events.some((event) => event.type === "toolcall_start")).toBe(false);
    expect(events.find((event) => event.type === "done")).toBeUndefined();
    const error = errorOf(events);
    expect(error.stopReason).toBe("error");
    expect(error.errorMessage).toBe("Qoder resume continuation returned a tool call");
    expect(textOf(error), "the half that did stream is kept").toBe("the first half");
  });

  it("sums the usage of both attempts", async () => {
    const usage = (completion: number, reasoning: number) => ({
      choices: [{ delta: {}, index: 0 }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: completion,
        completion_tokens_details: { reasoning_tokens: reasoning },
      },
    });
    const fetchMock = scriptedFetch([
      { sse: sseEnvelope(chunk({ content: "the first half" })) + sseEnvelope(usage(5, 2)), stall: true },
      {
        sse:
          sseEnvelope(chunk({ content: " and the rest" })) +
          sseEnvelope(usage(7, 3)) +
          sseEnvelope(chunk({}, { choices: [{ finish_reason: "stop", index: 0 }] })) +
          DONE_SSE,
        stall: false,
      },
    ]);

    const events = await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        sessionId: "resume-usage",
        env: idleEnv,
        fetch: fetchMock,
      } as SimpleStreamOptions),
    );

    const message = doneOf(events);
    // Both requests were charged, so what the host records is their sum: 5 + 7,
    // and 2 + 3 reasoning tokens — not the continuation's row alone.
    expect(message.usage.output).toBe(12);
    expect(message.usage.reasoning).toBe(5);
    expect(textOf(message)).toBe("the first half and the rest");
  });
});
