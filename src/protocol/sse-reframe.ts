// shape: wrapper function — trigger #12 (a function returning the wrapped
//   value, adding stream-repair behavior to an inner fetch). The internals are
//   a buffered text transform; below the ≥3 dispatch threshold.
//
// The v2 gateway (api2-v2.qoder.sh) intermittently emits malformed SSE framing:
// an event's JSON is split at an arbitrary byte offset and continued on the
// next line with no `data:` prefix (recorded 2026-09-28: 35 of 1117 events on
// one GLM-5.3 turn; 11 of 340 on the next, split offsets content-deterministic).
// A strict SSE client JSON-parses the fragment and throws — the openai SDK
// (core/streaming.js, JSON.parse of sse.data) killed the whole turn with
// "Unterminated string in JSON at position 198". Valid JSON can never contain
// a raw newline, so plain concatenation of the continued lines restores the
// original payload losslessly; replaying the repaired capture through the
// untouched SDK decoder yields zero parse failures.
import { MAX_SSE_BUFFER_LENGTH } from "./stream.js";

function reframeBlock(block: string): string {
  const lines = block.split("\n");
  const first = lines[0];
  if (!first.startsWith("data:")) return `${block}\n\n`;
  let payload = first.slice(5);
  if (payload.startsWith(" ")) payload = payload.slice(1);
  // Continuation lines are byte-level remains of the split JSON; they carry no
  // `data:` prefix and must be appended verbatim, never space-trimmed.
  for (let i = 1; i < lines.length; i += 1) payload += lines[i];
  return `data: ${payload}\n\n`;
}

function reframeSseStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
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
        throw new Error(
          `Qoder SSE reframe buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters without an event boundary`,
        );
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim().length > 0) controller.enqueue(encoder.encode(reframeBlock(buffer)));
    },
  });
}

/** Wrap a fetch so event-stream bodies from the v2 transport are re-framed. */
export function createReframedFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) return response;
    return new Response(response.body.pipeThrough(reframeSseStream()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
