import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Model, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { streamQoder } from "../protocol/stream.js";
import { readDebugRecords } from "./debug-sink.js";
import { fixtureModel } from "./model-fixture.ts";

const model = fixtureModel("Lite");
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
function envelope(inner: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
}
const text = (content: string) => envelope({ choices: [{ delta: { content } }] });
const success = `${text("OK")}data: [DONE]\n\n`;

function decodeBody(body: BodyInit | null | undefined): Record<string, unknown> {
  const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
  const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const encoded = Buffer.from(body as Uint8Array).toString("utf8");
  const rearranged = [...encoded].map((c) => (c === "$" ? "=" : standard[custom.indexOf(c)])).join("");
  const third = Math.floor(rearranged.length / 3);
  const base64 = rearranged.slice(-third) + rearranged.slice(third, -third) + rearranged.slice(0, third);
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

beforeEach(() => {
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function run(options: SimpleStreamOptions, selected = model) {
  return streamQoder(selected, context, { apiKey: "fake", ...options }).result();
}

describe("pi request contract", () => {
  it.each(["replace", "mutate"])("runs onPayload before signing (%s)", async (kind) => {
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (_url, request) => {
      init = request;
      return new Response(success);
    }) as typeof globalThis.fetch;
    const onPayload = vi.fn(async (value: unknown) => {
      const payload = value as Record<string, unknown>;
      if (kind === "replace") return { ...payload, custom: "replacement" };
      payload.custom = "mutation";
      return undefined;
    });
    const result = await run({ fetch, onPayload });
    expect(result.stopReason).toBe("stop");
    expect(onPayload).toHaveBeenCalledWith(expect.any(Object), model);
    expect(decodeBody(init?.body).custom).toBe(kind === "replace" ? "replacement" : "mutation");
    const bytes = Buffer.from(init?.body as Uint8Array);
    const headers = new Headers(init?.headers);
    expect(headers.get("Cosy-Bodylength")).toBe(String(bytes.length));
    expect(headers.get("Cosy-Bodyhash")).toBe(crypto.createHash("md5").update(bytes).digest("hex"));
    const [, payload, signature] = (headers.get("Authorization") ?? "").split(".");
    const expected = crypto
      .createHash("md5")
      .update(`${payload}\n${headers.get("Cosy-Key")}\n${headers.get("Cosy-Date")}\n`)
      .update(bytes)
      .update(`\n${headers.get("Cosy-Sigpath")}`)
      .digest("hex");
    expect(signature).toBe(expected);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([200, 429])("invokes onResponse before consuming HTTP %s", async (status) => {
    const response = new Response(status === 200 ? success : "rate limited", {
      status,
      headers: { "X-Trace": "trace" },
    });
    let called = false;
    const result = await run({
      fetch: vi.fn(async () => response),
      onResponse: async (info, selected) => {
        expect(info).toMatchObject({ status, headers: { "x-trace": "trace" } });
        expect(selected).toBe(model);
        expect(response.bodyUsed).toBe(false);
        expect(response.body?.locked).toBe(false);
        called = true;
      },
    });
    expect(called).toBe(true);
    expect(result.stopReason).toBe(status === 200 ? "stop" : "error");
  });

  it("merges caller headers case-insensitively, supports deletion, and honors baseUrl", async () => {
    let url: unknown;
    let headers: Headers | undefined;
    const result = await run(
      {
        fetch: vi.fn(async (input, init) => {
          url = input;
          headers = new Headers(init?.headers);
          return new Response(success);
        }),
        headers: { "x-test": "caller", "cache-control": null, ACCEPT: "text/event-stream" },
      },
      { ...model, baseUrl: "https://proxy.example.test/qoder", headers: { "X-Test": "model" } },
    );
    expect(result.stopReason).toBe("stop");
    expect(String(url)).toMatch(/^https:\/\/proxy.example.test\/qoder\/algo\//);
    expect(headers?.get("x-test")).toBe("caller");
    expect(headers?.has("cache-control")).toBe(false);
    expect(headers?.get("accept")).toBe("text/event-stream");
    expect(headers?.get("Cosy-Sigpath")).toContain("/qoder/algo/");
  });

  it("uses injected fetch for identity as well as chat", async () => {
    clearQoderAuthMemCache();
    const fetch = vi.fn(async (input) =>
      String(input).includes("userinfo") ? new Response(JSON.stringify({ id: "user" })) : new Response(success),
    );
    expect((await run({ fetch })).stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("respects model maxTokens and zero temperature", async () => {
    let payload: Record<string, unknown> | undefined;
    await run(
      {
        fetch: vi.fn(async () => new Response(success)),
        maxTokens: 8000,
        temperature: 0,
        onPayload(value) {
          payload = value as Record<string, unknown>;
        },
      },
      { ...model, maxTokens: 4096 },
    );
    expect(payload?.parameters).toMatchObject({ max_tokens: 4096, temperature: 0 });
  });

  it("honors provider env over process env for delta coalescing", async () => {
    vi.stubEnv("QODER_STREAM_DELTA_INTERVAL_MS", "999999");
    const stream = streamQoder(model, context, {
      apiKey: "fake",
      fetch: vi.fn(async () => new Response(`${text("a")}${text("b")}data: [DONE]\n\n`)),
      env: { QODER_STREAM_DELTA_INTERVAL_MS: "0" },
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(2);
  });

  it("cleans up the response when onResponse throws", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const result = await run({
      fetch: vi.fn(async () => response),
      onResponse() {
        throw new Error("hook failure");
      },
    });
    expect(result.errorMessage).toBe("hook failure");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["onPayload", "onResponse"])("cancels a stalled %s hook", async (hook) => {
    const controller = new AbortController();
    const result = await run({
      signal: controller.signal,
      fetch: vi.fn(async () => new Response(success)),
      [hook]: () => {
        controller.abort(new Error("cancelled hook"));
        return new Promise(() => {});
      },
    });
    expect(result.stopReason).toBe("aborted");
  });

  it("does not send chat when onPayload rejects or returns an invalid payload", async () => {
    const fetch = vi.fn(async () => new Response(success));
    expect(
      (
        await run({
          fetch,
          onPayload() {
            throw new Error("payload hook failed");
          },
        })
      ).errorMessage,
    ).toBe("payload hook failed");
    expect((await run({ fetch, onPayload: () => null })).errorMessage).toContain("JSON object");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors provider-scoped idle timeout while an injected body stalls", async () => {
    vi.stubEnv("QODER_STREAM_IDLE_TIMEOUT_MS", "999999");
    const cancel = vi.fn();
    const result = await run({
      env: { QODER_STREAM_IDLE_TIMEOUT_MS: "10" },
      fetch: vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    });
    expect(result.errorMessage).toContain("idle timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("releases a stalled HTTP error body on timeout", async () => {
    const cancel = vi.fn();
    const result = await run({
      timeoutMs: 20,
      fetch: vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 500 })),
    });
    expect(result.errorMessage).toContain("timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not retry billable chat POSTs", async () => {
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    expect((await run({ fetch, maxRetries: 3 })).stopReason).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds an injected fetch that ignores the abort signal", async () => {
    const result = await run({ timeoutMs: 10, fetch: vi.fn(() => new Promise<Response>(() => {})) });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("timeout");
  });

  it("cancels an open body and its pending delta timer", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = streamQoder(model, context, {
      apiKey: "fake",
      signal: controller.signal,
      fetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(text("partial")));
              },
              cancel,
            }),
          ),
      ),
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "text_start") controller.abort(new Error("cancelled"));
    }
    expect(events.at(-1)?.type).toBe("error");
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("derives totalTokens when upstream omits it", async () => {
    const result = await run({
      fetch: vi.fn(
        async () =>
          new Response(
            envelope({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) +
              "data: [DONE]\n\n",
          ),
      ),
    });
    expect(result.usage.totalTokens).toBe(12);
  });
});

/**
 * Spec qoder-capture-neutrality T-02/T-03 — FR-8's failure condition stated as a
 * positive (AC-01, AC-03, AC-05, AC-06).
 *
 * Every body-lifecycle shape above is re-run with QODER_DEBUG stubbed ON and the
 * observable must not move. These are the rows BUG-0009 turned red in the owner's
 * own shell: the fetch wrapper tee'd the body before `onResponse` ran and
 * re-wrapped the Response, so the hook saw a locked stream and teardown
 * cancelled twice. Capture now rides the read loop, so both states are one run.
 *
 * setup.ts scrubs the ambient QODER_* family; setup.test.ts:87-94 pins that
 * vi.stubEnv survives that scrub, which is what makes the two states expressible
 * inside one hermetic suite rather than depending on an operator's shell.
 */
describe("capture neutrality (QODER_DEBUG off vs on)", () => {
  // `recordsBody` is false where the transport never reads a byte of the body, so
  // consumer-side capture has nothing to record in EITHER state. Asserting a
  // record there would be asserting the very drain this spec removes.
  const shapes: {
    name: string;
    recordsBody: boolean;
    sseContains?: string;
    run(sessionId: string): Promise<Record<string, unknown>>;
  }[] = [
    {
      name: "cleans up the response when onResponse throws",
      recordsBody: false,
      async run(sessionId) {
        const cancel = vi.fn();
        const response = new Response(new ReadableStream({ cancel }));
        const seen: Record<string, unknown> = {};
        const result = await run({
          sessionId,
          fetch: vi.fn(async (input: unknown) => {
            seen.requestedUrl = String(input);
            return response;
          }),
          onResponse() {
            // AC-01: the hook must see the inner fetch's own body, unlocked.
            seen.bodyLockedInHook = response.body?.locked;
            seen.bodyUsedInHook = response.bodyUsed;
            throw new Error("hook failure");
          },
        });
        return {
          ...seen,
          cancelCalls: cancel.mock.calls.length,
          errorMessage: result.errorMessage,
          stopReason: result.stopReason,
        };
      },
    },
    {
      name: "releases a stalled HTTP error body on timeout",
      recordsBody: false,
      async run(sessionId) {
        const cancel = vi.fn();
        const result = await run({
          sessionId,
          timeoutMs: 20,
          fetch: vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 500 })),
        });
        return {
          cancelCalls: cancel.mock.calls.length,
          errorMessage: result.errorMessage,
          stopReason: result.stopReason,
        };
      },
    },
    {
      name: "cancels an open body and its pending delta timer",
      recordsBody: true,
      sseContains: "partial",
      async run(sessionId) {
        const controller = new AbortController();
        const cancel = vi.fn();
        const seen: Record<string, unknown> = {};
        const stream = streamQoder(model, context, {
          apiKey: "fake",
          sessionId,
          signal: controller.signal,
          fetch: vi.fn(async (input: unknown) => {
            seen.requestedUrl = String(input);
            return new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode(text("partial")));
                },
                cancel,
              }),
            );
          }),
        });
        const events: string[] = [];
        for await (const event of stream) {
          events.push(event.type);
          if (event.type === "text_start") controller.abort(new Error("cancelled"));
        }
        const result = await stream.result();
        return { ...seen, events, cancelCalls: cancel.mock.calls.length, stopReason: result.stopReason };
      },
    },
    {
      name: "records an HTTP error body the transport reads itself",
      recordsBody: true,
      sseContains: "rate limited",
      async run(sessionId) {
        const cancel = vi.fn();
        const seen: Record<string, unknown> = {};
        const result = await run({
          sessionId,
          // A COMPLETE error body, unlike the stalled one above: the transport
          // reads it itself in readResponseText and never reaches the read loop,
          // so this is the path where consumer-side capture has no loop to ride.
          fetch: vi.fn(async (input: unknown) => {
            seen.requestedUrl = String(input);
            return new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode("rate limited"));
                  c.close();
                },
                cancel,
              }),
              { status: 429 },
            );
          }),
        });
        return {
          ...seen,
          cancelCalls: cancel.mock.calls.length,
          errorMessage: result.errorMessage,
          stopReason: result.stopReason,
        };
      },
    },
    {
      name: "invokes onResponse before consuming a complete stream",
      recordsBody: true,
      sseContains: "[DONE]",
      async run(sessionId) {
        const response = new Response(success, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
        const seen: Record<string, unknown> = {};
        const result = await run({
          sessionId,
          fetch: vi.fn(async (input: unknown) => {
            seen.requestedUrl = String(input);
            return response;
          }),
          onResponse: async () => {
            seen.bodyLockedInHook = response.body?.locked;
            seen.bodyUsedInHook = response.bodyUsed;
          },
        });
        return {
          ...seen,
          stopReason: result.stopReason,
          answer: result.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
        };
      },
    },
  ];

  let debugDir: string;

  beforeEach(() => {
    debugDir = mkdtempSync(join(tmpdir(), "qoder-neutral-"));
    vi.stubEnv("QODER_DEBUG_DIR", debugDir);
  });

  for (const shape of shapes) {
    it(`T-02 ${shape.name} — identical with capture off and on`, async () => {
      const observed: Record<string, unknown>[] = [];
      const sessions: string[] = [];
      for (const debug of ["", "1"]) {
        vi.stubEnv("QODER_DEBUG", debug);
        const sessionId = debug === "1" ? "neutral-on" : "neutral-off";
        sessions.push(sessionId);
        observed.push(await shape.run(sessionId));
      }
      const [off, on] = observed;
      // FR-8's failure condition, negated: no observable differs between states.
      expect(on).toEqual(off);

      const responses = (session: string) =>
        readDebugRecords(debugDir, session).filter((record) => record.type === "response");
      expect(responses(sessions[0])).toHaveLength(0);
      if (!shape.recordsBody) {
        expect(responses(sessions[1])).toHaveLength(0);
        return;
      }
      await vi.waitFor(() => {
        expect(responses(sessions[1])).toHaveLength(1);
      });
      const record = responses(sessions[1])[0];
      expect(record?.protocol).toBe("legacy");
      // The record names the REQUEST url — the field's pre-relocation value. A
      // constructed Response reads back url === "", so this catches sourcing it
      // from a wrapper instead of the request.
      expect(record?.url).toBe(off?.requestedUrl);
      expect(String(record?.sse)).toContain(shape.sseContains ?? "");
    });
  }

  it("T-03 an aborted turn records the prefix it saw and cancels exactly once", async () => {
    vi.stubEnv("QODER_DEBUG", "1");
    const sessionId = "neutral-abort-prefix";
    const controller = new AbortController();
    const cancel = vi.fn();
    // invented: the body yields `prefix` on the first read and then stalls, so no
    // second read ever resolves. Bytes past the prefix are unreachable by
    // construction, which is what makes "prefix, not full body" falsifiable.
    const prefix = text("partial");
    const stream = streamQoder(model, context, {
      apiKey: "fake",
      sessionId,
      signal: controller.signal,
      fetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(prefix));
              },
              cancel,
            }),
          ),
      ),
    });
    for await (const event of stream) {
      if (event.type === "text_start") controller.abort(new Error("cancelled"));
    }
    expect((await stream.result()).stopReason).toBe("aborted");
    // Exactly one cancel: recording the prefix must not also drain the body.
    expect(cancel).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(readDebugRecords(debugDir, sessionId).filter((record) => record.type === "response")).toHaveLength(1);
    });
    const record = readDebugRecords(debugDir, sessionId).find((r) => r.type === "response");
    // Not nothing, and not a drain: the body was cancelled before EOF, yet the
    // record holds exactly the prefix the read loop decoded.
    expect(record?.sse).toBe(prefix);
    expect(record?.truncated).toBe(false);
  });

  it("T-02b a body-less response is recorded exactly once, by the wrapper", async () => {
    vi.stubEnv("QODER_DEBUG", "1");
    const sessionId = "neutral-bodyless";
    const result = await run({
      sessionId,
      fetch: vi.fn(async () => new Response(null, { status: 500 })),
    });
    expect(result.stopReason).toBe("error");
    const responses = readDebugRecords(debugDir, sessionId).filter((record) => record.type === "response");
    // Exactly one record, in the wrapper's body-less shape: no sse field at all.
    // A second record here would mean a consumer-side capture fired on a body it
    // never read — the double-write the response.body gate exists to prevent.
    expect(responses).toHaveLength(1);
    expect(responses[0]?.status).toBe(500);
    expect("sse" in (responses[0] as Record<string, unknown>)).toBe(false);
  });
});
