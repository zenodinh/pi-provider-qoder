// shape: wrapper function — trigger #12 (a function returning the wrapped
//   value, adding stream-repair behavior to an inner fetch). The internals are
//   a buffered text transform; below the ≥3 dispatch threshold.
//
// The v2 gateway (api2-v2.qoder.sh) intermittently emits malformed SSE framing:
// an event's bytes are split by an inserted raw newline at an arbitrary offset —
// observed inside the JSON (36/33/102/198/204…) and inside the `data:` prefix
// itself (`data\n: {...}`, live 2026-09-29). A strict SSE client JSON-parses the
// fragment and throws — the openai SDK (core/streaming.js, JSON.parse of
// sse.data) killed the whole turn with "Unterminated string in JSON at position
// 198". Valid JSON can never contain a raw newline, so plain concatenation of
// the block's lines restores the original event bytes losslessly, wherever the
// split landed; replaying repaired captures through the untouched SDK decoder
// yields zero parse failures.
import { createResponseCapture, type DebugFetchMeta, debugFetchUrl, type ResponseCapture } from "../debug-log.js";
import { MAX_SSE_BUFFER_LENGTH } from "./stream.js";

function reframeBlock(block: string): string {
  // All single newlines inside a block are gateway-inserted splits; the event
  // separator is the blank line the caller already split on.
  const joined = block.split("\n").join("");
  if (!joined.startsWith("data:")) return `${block}\n\n`;
  let payload = joined.slice(5);
  if (payload.startsWith(" ")) payload = payload.slice(1);
  return `data: ${payload}\n\n`;
}

/**
 * The global `Transformer` type omits the spec's `cancel` hook: @types/node
 * declares it with `cancel`, but module-scoped inside `node:stream/web`, so it
 * never merges into the DOM lib's global. Node's runtime does call `cancel` when
 * the readable side is cancelled, and that is the only signal a body was
 * abandoned before EOF — so the hook is typed here rather than given up.
 *
 * boundary: extends the host's own Transformer instead of re-declaring it
 * (BND-3); only the missing hook is added, so the host type stays the source of
 * truth for the rest.
 */
type CancellingTransformer<I, O> = Transformer<I, O> & { cancel?(reason?: unknown): void };

function reframeSseStream(capture?: ResponseCapture): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const transformer: CancellingTransformer<Uint8Array, Uint8Array> = {
    transform(chunk, controller) {
      // Decode once and feed both consumers from that one text: the framing
      // buffer and the capture. Capture therefore records the raw pre-repair
      // bytes, which is the only view of them that exists, and framing repair
      // stays byte-identical whether or not a capture was supplied.
      const decoded = decoder.decode(chunk, { stream: true });
      capture?.push(decoded);
      buffer += decoded;
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        let next = boundary + 2;
        while (buffer[next] === "\n") next += 1;
        buffer = buffer.slice(next);
        if (block.length > 0) controller.enqueue(encoder.encode(reframeBlock(block)));
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > MAX_SSE_BUFFER_LENGTH) {
        // Record the prefix before throwing. An errored TransformStream runs
        // neither flush nor — unless the consumer happens to cancel — cancel, and
        // those are the only other finish() sites; this is precisely the turn an
        // operator enabled QODER_DEBUG to diagnose. finish() is idempotent, so a
        // later cancel cannot double-write.
        capture?.finish();
        throw new Error(
          `Qoder SSE reframe buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters without an event boundary`,
        );
      }
    },
    flush(controller) {
      const tail = decoder.decode();
      capture?.push(tail);
      buffer += tail;
      if (buffer.trim().length > 0) controller.enqueue(encoder.encode(reframeBlock(buffer)));
      capture?.finish();
    },
    cancel() {
      // An aborted turn records the prefix it already saw rather than nothing
      // (SA §7.10 Edge); finish() is idempotent, so flush-then-cancel is safe.
      capture?.finish();
    },
  };
  return new TransformStream<Uint8Array, Uint8Array>(transformer);
}

/**
 * Pass-through observer for a body this module does NOT reframe. It decodes each
 * chunk into the capture and re-enqueues the bytes unchanged, so the caller stays
 * the body's only reader: no fork, exactly one cancel, and the record holds only
 * what the consumer actually read. This is the non-event-stream half of
 * consumer-side capture — there is no reframe transform on that path to ride.
 */
// shape: wrapper function — trigger #12 (wraps a stream to add capture behavior
//   and returns the wrapped stream; the bytes themselves pass through untouched).
function observeBody(capture: ResponseCapture): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const transformer: CancellingTransformer<Uint8Array, Uint8Array> = {
    transform(chunk, controller) {
      capture.push(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      capture.push(decoder.decode());
      capture.finish();
    },
    cancel() {
      // The caller cancelled before EOF — a non-streaming error body the
      // self-heal branch never needed. Record the prefix, do not drain.
      capture.finish();
    },
  };
  return new TransformStream<Uint8Array, Uint8Array>(transformer);
}

/** Wrap a fetch so event-stream bodies from the v2 transport are re-framed. */
export function createReframedFetch(inner: typeof fetch, meta?: DebugFetchMeta): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    // The record names the REQUEST url, resolved before either wrapper below
    // replaces the object: a constructed Response reads back url === "".
    // undefined when debug is off or no meta was supplied, which makes both
    // paths below byte-identical to a capture-free reframe.
    const capture = meta ? createResponseCapture(meta, debugFetchUrl(input), response.status) : undefined;
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
      // Gated on response.body so a body-less response is left to
      // createDebugFetch's own record: exactly one response record per response,
      // whichever of the three early-return conditions tripped.
      if (!capture || !response.body) return response;
      return new Response(response.body.pipeThrough(observeBody(capture)), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return new Response(response.body.pipeThrough(reframeSseStream(capture)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
