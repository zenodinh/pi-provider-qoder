/**
 * Behavior spec for the shared terminal tail (spec qoder-stamp-tail CU-01,
 * T-01..T-03).
 *
 * The inner stream is a REAL `createAssistantMessageEventStream` driven by the
 * test — terminality is the invariant under test, so stubbing the host's stream
 * type would stub away the behavior. Only the message fixtures are literals.
 */
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { hasUsage, stampTerminal, withTerminalStamp } from "../protocol/stamp.js";

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "qoder-api" as AssistantMessage["api"],
    provider: "qoder",
    model: "Lite",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: 0,
    ...overrides,
  };
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/**
 * A real event stream whose iterator yields one event and then throws. The
 * stream itself is the shipped one; only the fault is injected at the iterator
 * boundary, because a real EventStream's iterator never throws on its own.
 */
function explodingStream(first: AssistantMessageEvent): AssistantMessageEventStream {
  const inner = createAssistantMessageEventStream();
  inner.push(first);
  const source = inner[Symbol.asyncIterator]();
  inner[Symbol.asyncIterator] = () =>
    (async function* () {
      const next = await source.next();
      if (!next.done) yield next.value;
      throw new Error("inner stream exploded");
    })();
  return inner;
}

describe("withTerminalStamp", () => {
  it("T-01 pushes a terminal before end on the happy path and on the tail's own failure path", async () => {
    // Happy path: a terminal always precedes the end of the stream.
    const inner = createAssistantMessageEventStream();
    const partial = assistantMessage();
    const terminal = assistantMessage({ stopReason: "stop" });
    inner.push({ type: "start", partial });
    inner.push({ type: "done", reason: "stop", message: terminal });
    inner.end();

    const happy = withTerminalStamp(inner, {});
    const happyEvents = await consume(happy);
    expect(happyEvents.map((event) => event.type)).toEqual(["start", "done"]);
    expect((await happy.result()).stopReason).toBe("stop");

    // Failure path: the inner iterator throws mid-iteration. Without a terminal
    // push here result() would stay pending and the host would await forever
    // (the live unguarded mode v2.ts's own wrapper carried).
    const failing = withTerminalStamp(
      explodingStream({ type: "text_delta", contentIndex: 0, delta: "x", partial: assistantMessage() }),
      {},
    );
    const failedEvents = await consume(failing);
    expect(failedEvents.map((event) => event.type)).toEqual(["text_delta", "error"]);
    const failed = failedEvents.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
    expect(failed.error.stopReason).toBe("error");
    expect(failed.error.errorMessage).toContain("inner stream exploded");
    // The host's await settles rather than hanging.
    expect((await failing.result()).stopReason).toBe("error");
  });

  it("T-01 settles a stream that throws before any event and one that ends without a terminal", async () => {
    // The tail's own defensive branches: no event ever existed to carry a
    // message, and the inner stream closed without a terminal. Both must
    // resolve result() with an error rather than leaving the host awaiting.
    const threwEarly = createAssistantMessageEventStream();
    threwEarly[Symbol.asyncIterator] = () => ({
      next: async () => {
        throw new Error("threw before any event");
      },
    });
    const early = withTerminalStamp(threwEarly, {});
    const earlyEvents = await consume(early);
    expect(earlyEvents.map((event) => event.type)).toEqual(["error"]);
    const earlyError = earlyEvents[0] as Extract<AssistantMessageEvent, { type: "error" }>;
    expect(earlyError.error.errorMessage).toContain("threw before any event");
    expect((await early.result()).stopReason).toBe("error");

    const silent = createAssistantMessageEventStream();
    silent.end();
    const ended = withTerminalStamp(silent, {});
    const silentEvents = await consume(ended);
    expect(silentEvents.map((event) => event.type)).toEqual(["error"]);
    // The backstop's own text carries the host classifier's EOF pattern, so the
    // no-terminal class retries exactly like stream.ts's unexpected-EOF throw;
    // the exact instance is pinned here so a wording drift in stamp.ts goes red.
    const silentError = silentEvents[0] as Extract<AssistantMessageEvent, { type: "error" }>;
    expect(silentError.error.errorMessage).toBe("Qoder stream ended before a terminal response event (stamp tail)");
    expect((await ended.result()).stopReason).toBe("error");
  });

  it("T-01 never attempts a push after a terminal event", async () => {
    // A stream that yields its terminal and then throws: the wrapper must not
    // produce a second terminal (the host's stream drops the push anyway, but
    // the reserved hook must not fire twice either).
    const inner = createAssistantMessageEventStream();
    const partial = assistantMessage();
    inner.push({ type: "done", reason: "stop", message: partial });
    const source = inner[Symbol.asyncIterator]();
    let hooks = 0;
    inner[Symbol.asyncIterator] = () =>
      (async function* () {
        const next = await source.next();
        if (!next.done) yield next.value;
        throw new Error("threw after the terminal");
      })();

    const events = await consume(withTerminalStamp(inner, { onTerminal: () => hooks++ }));
    expect(events.map((event) => event.type)).toEqual(["done"]);
    expect(hooks).toBe(1);
  });

  it("T-02 stamps a rate source only on a row a usage chunk actually priced", async () => {
    const priced = assistantMessage({
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
      },
    });
    const unpriced = assistantMessage();
    const pricedDone: AssistantMessageEvent = { type: "done", reason: "stop", message: priced };
    const unpricedDone: AssistantMessageEvent = { type: "done", reason: "stop", message: unpriced };
    const unpricedError: AssistantMessageEvent = {
      type: "error",
      reason: "error",
      error: assistantMessage({ stopReason: "error" }),
    };

    expect(hasUsage(priced)).toBe(true);
    expect(hasUsage(unpriced)).toBe(false);

    stampTerminal(pricedDone, { rateSource: "credits" });
    stampTerminal(unpricedDone, { rateSource: "rate-table" });
    stampTerminal(unpricedError, { rateSource: "rate-table" });

    expect((priced.usage as { rateSource?: string }).rateSource).toBe("credits");
    expect("rateSource" in unpricedDone.message.usage).toBe(false);
    expect("rateSource" in unpricedError.error.usage).toBe(false);
  });

  it("T-02 applies the priced-only policy through the wrapper on done and error alike", async () => {
    const pricedInner = createAssistantMessageEventStream();
    const priced = assistantMessage({
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    pricedInner.push({ type: "done", reason: "stop", message: priced });
    pricedInner.end();
    const pricedEvents = await consume(withTerminalStamp(pricedInner, { rateSource: "fallback" }));
    const pricedDone = pricedEvents.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
    expect((pricedDone.message.usage as { rateSource?: string }).rateSource).toBe("fallback");

    const errorInner = createAssistantMessageEventStream();
    const errorMessage = assistantMessage({ stopReason: "error" });
    errorInner.push({ type: "error", reason: "error", error: errorMessage });
    errorInner.end();
    const errorEvents = await consume(withTerminalStamp(errorInner, { rateSource: "fallback" }));
    const errorTerminal = errorEvents.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
    expect("rateSource" in errorTerminal.error.usage).toBe(false);
  });

  it("T-03 fires the reserved hook once with the same live message object the stream pushed", async () => {
    const inner = createAssistantMessageEventStream();
    const seen: AssistantMessage[] = [];
    const stream = withTerminalStamp(inner, {
      onTerminal: (message) => {
        seen.push(message);
        // The hook's own mutation must be visible to the consumer: it is the
        // live object, not a copy.
        message.endTurn = true;
      },
    });
    // Push after the wrapper is listening, mirroring how an adapter drives it.
    const partial = assistantMessage();
    inner.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial });
    inner.push({ type: "done", reason: "stop", message: partial });
    inner.end();

    const events = await consume(stream);
    const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(done.message);
    expect(done.message.endTurn).toBe(true);
  });

  it("a throwing hook cannot unseat the terminal guarantee on either path", async () => {
    const boom = (): void => {
      throw new Error("hook exploded");
    };
    // Happy path: the successful done survives; the failed observer is inert.
    const inner = createAssistantMessageEventStream();
    const terminal = assistantMessage({ stopReason: "stop" });
    inner.push({ type: "done", reason: "stop", message: terminal });
    inner.end();
    const happy = withTerminalStamp(inner, { onTerminal: boom });
    const happyEvents = await consume(happy);
    expect(happyEvents.map((event) => event.type)).toEqual(["done"]);
    expect((await happy.result()).stopReason).toBe("stop");

    // Failure path: the tail's own error terminal is still pushed before end,
    // so result() settles instead of awaiting forever.
    const failing = withTerminalStamp(
      explodingStream({ type: "text_delta", contentIndex: 0, delta: "x", partial: assistantMessage() }),
      { onTerminal: boom },
    );
    const failedEvents = await consume(failing);
    expect(failedEvents.map((event) => event.type)).toEqual(["text_delta", "error"]);
    expect((await failing.result()).stopReason).toBe("error");
  });
});
