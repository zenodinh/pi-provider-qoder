// SSE builders for the Qoder legacy gateway's wire shape.
//
// A non-test module on purpose: importing helpers out of a sibling `*.test.ts`
// re-registers that file's suites in the importer (verified — importing
// stream.test.js into a file holding one row collects 56 tests) and drags its
// top-level `vi.mock` along with them. Fixture provenance: the envelope and
// chunk shapes mirror the recorded gateway capture that `loadLiveFixture("global")`
// serves and that stream.test.ts's local helpers reproduce; every value passed
// through them here is invented per scenario.
import { MAX_SSE_BUFFER_LENGTH } from "../protocol/stream.js";

/**
 * One SSE `data:` line carrying a Qoder envelope:
 * `{ headers, body: <JSON string>, statusCodeValue, statusCode }`.
 * The gateway wraps the OpenAI-style chunk inside `body` as a JSON string.
 */
export function sseEnvelope(body: object | string, statusCodeValue = 200, statusCode = "OK"): string {
  return (
    "data:" +
    JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: typeof body === "string" ? body : JSON.stringify(body),
      statusCodeValue,
      statusCode,
    }) +
    "\n\n"
  );
}

/** The gateway sends the end sentinel wrapped in an envelope as well as bare. */
export const DONE_SSE = sseEnvelope("[DONE]");

/** A bare `data: [DONE]`, the other sentinel form the read loop accepts. */
export const BARE_DONE_SSE = "data: [DONE]\n\n";

/** An OpenAI-style streaming chunk carrying one delta. */
export function chunk(delta: object, extra: object = {}): object {
  return {
    choices: [{ delta, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    ...extra,
  };
}

/** An OpenAI-style chunk carrying only `finish_reason` plus usage. */
export function finishChunk(finish_reason: string, extra: object = {}): object {
  return {
    choices: [{ finish_reason, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    ...extra,
  };
}

/** The smallest stream that completes: one text delta, a stop, the sentinel. */
export const SUCCESS_SSE = sseEnvelope(chunk({ content: "OK" })) + sseEnvelope(finishChunk("stop")) + DONE_SSE;

/** A `fetch` that always answers 200 with `body` as an event stream. */
export function mockFetch(body: string): typeof globalThis.fetch {
  return (async () => sseResponse(body)) as unknown as typeof globalThis.fetch;
}

/** A 200 event-stream Response. */
export function sseResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

/**
 * Text one character past the buffer cap, with no newline in it.
 *
 * Shared by the two overflow rows so the suite allocates it once. Absence of a
 * newline is load-bearing: stream.ts:593 only rejects an unbounded buffer when
 * `!buffer.includes("\n")`, so this same text wrapped in a well-formed envelope
 * (which appends "\n\n") sails past that gate and trips the DSML cap instead.
 */
export const OVERSIZED_TEXT: string = "x".repeat(MAX_SSE_BUFFER_LENGTH + 1);
