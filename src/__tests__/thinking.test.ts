import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripThinkingTags, ThinkingTagParser } from "../protocol/thinking.js";

function createMockStream() {
  const events: AssistantMessageEvent[] = [];
  const push = vi.fn((event: AssistantMessageEvent) => events.push(event));
  const stream = {
    push,
    end: vi.fn(),
    [Symbol.iterator]: function* () {},
    [Symbol.asyncIterator]: function* () {},
    events,
  } as unknown as AssistantMessageEventStream;
  return { stream, push, events };
}

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "qoder-api" as Api,
    provider: "qoder",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

/** Every event the parser pushed, in order. */
function collectEvents(mock: ReturnType<typeof vi.fn>): AssistantMessageEvent[] {
  return mock.mock.calls.map((call) => call[0] as AssistantMessageEvent);
}

/** The text_end events, narrowed to the two fields the parity rows assert. */
function textEndEvents(mock: ReturnType<typeof vi.fn>): Array<{ contentIndex: number; content: string }> {
  return collectEvents(mock)
    .filter((event): event is Extract<AssistantMessageEvent, { type: "text_end" }> => event.type === "text_end")
    .map((event) => ({ contentIndex: event.contentIndex, content: event.content }));
}

describe("ThinkingTagParser", () => {
  let output: AssistantMessage;
  let stream: AssistantMessageEventStream;
  let pushMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    output = createOutput();
    const mock = createMockStream();
    stream = mock.stream;
    pushMock = mock.push;
  });

  // ── Plain text (no thinking tags) ─────────────────────────────────────

  it("passes plain text through without modification", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello world");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "text", text: "Hello world" });
  });

  it("handles empty input", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.finalize();
    expect(output.content).toHaveLength(0);
  });

  // ── Standard <thinking> tags ──────────────────────────────────────────

  it("extracts thinking content from <thinking> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <thinking>reasoning here</thinking> world");
    parser.finalize();

    // Blocks are append-only because contentIndex values are emitted while
    // streaming and cannot be changed retroactively.
    expect(output.content).toEqual([
      { type: "text", text: "Hello " },
      { type: "thinking", thinking: "reasoning here" },
      { type: "text", text: " world" },
    ]);
  });

  it("handles thinking-only content", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>just thinking</thinking>");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "just thinking" });
  });

  // ── Alternative tag variants ──────────────────────────────────────────

  it("handles <think> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <think>reasoning</think> world");
    parser.finalize();

    expect(output.content).toHaveLength(3);
    expect(output.content[0]).toMatchObject({ type: "text", text: "Hello " });
    expect(output.content[1]).toMatchObject({ type: "thinking", thinking: "reasoning" });
    expect(output.content[2]).toMatchObject({ type: "text", text: " world" });
  });

  it("handles <reasoning> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<reasoning>deep thought</reasoning>");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "deep thought" });
  });

  it("handles <thought> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thought>pondering</thought>");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "pondering" });
  });

  it("handles <summary> tags used by Qoder reasoning streams", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<summary>hidden reasoning</summary> visible answer");
    parser.finalize();

    expect(output.content).toEqual([
      { type: "thinking", thinking: "hidden reasoning" },
      { type: "text", text: " visible answer" },
    ]);
  });

  it("keeps a complete matching pair as one thinking block", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thought>only reasoning</thought>");
    parser.finalize();

    expect(output.content).toEqual([{ type: "thinking", thinking: "only reasoning" }]);
    const eventTypes = collectEvents(pushMock).map((event) => event.type);
    expect(eventTypes).toContain("thinking_start");
    expect(eventTypes).not.toContain("text_start");
  });

  // Upstream sometimes pairs an opener of one variant with a closer of another
  // (`<think>` … `</thinking>`). Closing only on the opener's own variant left
  // the block open and appended the rest of the visible answer to it.
  it.each([
    ["<think>h</thinking>", "<think> opener, </thinking> closer"],
    ["<thinking>h</think>", "<thinking> opener, </think> closer"],
    ["<reasoning>h</summary>", "<reasoning> opener, </summary> closer"],
    ["<thought>h</reasoning>", "<thought> opener, </reasoning> closer"],
  ])("closes on any variant's closer: %s (%s)", (tagged) => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk(`BEFORE ${tagged} AFTER`);
    parser.finalize();

    expect(output.content).toEqual([
      { type: "text", text: "BEFORE " },
      { type: "thinking", thinking: "h" },
      { type: "text", text: " AFTER" },
    ]);
  });

  it("closes on a mismatched closer split across chunks", () => {
    // The closer is a partial prefix in the chunk that ends the thinking text, so
    // the parser must hold it instead of leaking `</reason` into the block.
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("BEFORE <thin");
    parser.processChunk("k>hidden</reason");
    parser.processChunk("ing> AFTER");
    parser.finalize();

    expect(output.content).toEqual([
      { type: "text", text: "BEFORE " },
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: " AFTER" },
    ]);
  });

  // invented: reproduces the session 01a102d3 leak, where the assistant listed
  // these very tag variants in prose and the literal `<think>` was taken as an
  // opener with no closer, hiding the rest of the answer.
  it("keeps an unclosed tag in ordinary prose as visible text", () => {
    const parser = new ThinkingTagParser(output, stream);
    const prose = "标签变体（`<think>`/`<reasoning>`/`<thought>`/`<summary>`）都有测试覆盖。";
    parser.processChunk(prose);
    parser.finalize();

    expect(output.content).toEqual([{ type: "text", text: prose }]);
  });

  it("holds a prose opener across chunks and flushes it as text at finalize", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("写法是 `<think>` ");
    parser.processChunk("而不是别的写法");
    parser.finalize();

    expect(output.content).toEqual([{ type: "text", text: "写法是 `<think>` 而不是别的写法" }]);
  });

  // ── Chunked streaming ─────────────────────────────────────────────────

  it("handles thinking content split across multiple chunks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <thin");
    parser.processChunk("king>part1 ");
    parser.processChunk("part2</think");
    parser.processChunk("ing> world");
    parser.finalize();

    expect(output.content).toHaveLength(3);
    expect(output.content[0]).toMatchObject({ type: "text", text: "Hello " });
    expect(output.content[1]).toMatchObject({ type: "thinking", thinking: "part1 part2" });
    expect(output.content[2]).toMatchObject({ type: "text", text: " world" });
  });

  it("handles open tag split across chunks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("text <thin");
    parser.processChunk("king>body</thinking>");
    parser.finalize();

    expect(output.content).toHaveLength(2);
    expect(output.content[0]).toMatchObject({ type: "text", text: "text " });
    expect(output.content[1]).toMatchObject({ type: "thinking", thinking: "body" });
  });

  // ── Multiple thinking blocks ──────────────────────────────────────────

  it("handles multiple thinking blocks without turning the second into text", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>first</thinking> text <thinking>second</thinking>");
    parser.finalize();

    expect(output.content).toEqual([
      { type: "thinking", thinking: "first" },
      { type: "text", text: " text " },
      { type: "thinking", thinking: "second" },
    ]);
  });

  it("re-enters thinking mode when a later tag is split across chunks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>first</thinking> answer <thin");
    parser.processChunk("king>second</thinking> final");
    parser.finalize();

    expect(output.content).toEqual([
      { type: "thinking", thinking: "first" },
      { type: "text", text: " answer " },
      { type: "thinking", thinking: "second" },
      { type: "text", text: " final" },
    ]);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("handles text ending with partial tag prefix", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <think");
    // Don't finalize yet — the parser should hold back "<think" as potential tag
    // But finalize should flush it as text
    parser.finalize();

    const textBlocks = output.content.filter((c) => c.type === "text");
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
    const allText = textBlocks.map((c) => (c as { type: string; text: string }).text).join("");
    expect(allText).toContain("Hello");
    expect(allText).toContain("<think");
  });

  it("strips trailing newline after closing tag", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>thought</thinking>\n\nActual text");
    parser.finalize();

    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "thought" });
    expect(output.content[1]).toMatchObject({ type: "text", text: "Actual text" });
  });

  // ── getTextBlockIndex ─────────────────────────────────────────────────

  it("tracks text block index correctly", () => {
    const parser = new ThinkingTagParser(output, stream);
    expect(parser.getTextBlockIndex()).toBeNull();

    parser.processChunk("Hello");
    expect(parser.getTextBlockIndex()).toBe(0);

    parser.processChunk("<thinking>thought</thinking>");
    parser.processChunk(" World");
    expect(parser.getTextBlockIndex()).not.toBeNull();
  });

  // ── Stream events ─────────────────────────────────────────────────────

  it("emits text_start and text_delta events for plain text", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hi");
    parser.finalize();

    const eventTypes = pushMock.mock.calls.map((c) => c[0].type);
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
  });

  it("emits thinking_start and thinking_delta events for thinking content", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>deep</thinking>");
    parser.finalize();

    const eventTypes = pushMock.mock.calls.map((c) => c[0].type);
    expect(eventTypes).toContain("thinking_start");
    expect(eventTypes).toContain("thinking_delta");
    expect(eventTypes).toContain("thinking_end");
  });

  // ── Finalize with remaining buffer ────────────────────────────────────

  it("finalize flushes remaining text when not in thinking mode", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("partial");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "text", text: "partial" });
  });

  it("keeps emitted content indexes stable when thinking follows text", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("prefix <thinking>reason</thinking> answer");
    parser.finalize();

    const events = pushMock.mock.calls.map((call) => call[0] as AssistantMessageEvent);
    const prefixDelta = events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
        event.type === "text_delta" && event.delta === "prefix ",
    );
    const thinkingDelta = events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
        event.type === "thinking_delta" && event.delta === "reason",
    );

    expect(prefixDelta?.contentIndex).toBe(0);
    expect(thinkingDelta?.contentIndex).toBe(1);
    expect(output.content[prefixDelta?.contentIndex ?? -1]?.type).toBe("text");
    expect(output.content[thinkingDelta?.contentIndex ?? -1]?.type).toBe("thinking");
  });

  it("flushes an unclosed opener as text at finalize", () => {
    // A tag that never closes is ambiguous, so it stays visible text rather than
    // hiding a possibly-long answer inside a thinking block.
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>unfinished");
    parser.finalize();

    expect(output.content).toEqual([{ type: "text", text: "<thinking>unfinished" }]);
  });

  it("flushes an unclosed opener as text at a tool boundary without ending the parser", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>reason<");
    parser.flushAtBoundary();
    parser.processChunk("after");
    parser.finalize();

    expect(output.content).toEqual([
      { type: "text", text: "<thinking>reason<" },
      { type: "text", text: "after" },
    ]);
    const eventTypes = pushMock.mock.calls.map((call) => call[0].type);
    expect(eventTypes.filter((type) => type.startsWith("thinking"))).toEqual([]);
  });

  // ── Orphan closing tags (opener arrived via reasoning_content) ─────────
  // Regression: Qoder's backend splits one `<thinking>...</thinking>` pair
  // across two SSE fields — opener+reasoning into `reasoning_content`, closer
  // +answer into `content`. The closer has no opener in the content stream, so
  // it must be dropped instead of leaking into visible text.

  it("drops an orphan closing tag at the start of content", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("</thinking>\n\n让我查一下这个选项");
    parser.finalize();

    const textBlocks = output.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(1);
    const text = (textBlocks[0] as { type: string; text: string }).text;
    expect(text).toBe("让我查一下这个选项");
    expect(text).not.toContain("</thinking>");
    expect(output.content.some((c) => c.type === "thinking")).toBe(false);
  });

  it("drops an orphan closer split across stream chunks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("</think");
    parser.processChunk("ing>\n\nanswer");
    parser.finalize();

    const textBlocks = output.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(1);
    const text = (textBlocks[0] as { type: string; text: string }).text;
    expect(text).toBe("answer");
    expect(text).not.toContain("</thinking>");
    expect(text).not.toContain("</think");
  });

  it("drops an orphan closer for the <reasoning> variant too", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("</reasoning>\n\nresult");
    parser.finalize();

    const text = (output.content.find((c) => c.type === "text") as { type: string; text: string })?.text ?? "";
    expect(text).toBe("result");
    expect(text).not.toContain("</reasoning>");
  });

  it("drops an orphan <summary> closer from the content channel", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("</summary>\n\nanswer");
    parser.finalize();

    const text = (output.content.find((c) => c.type === "text") as { type: string; text: string })?.text ?? "";
    expect(text).toBe("answer");
    expect(text).not.toContain("</summary>");
  });

  it("emits text before an orphan closer, then drops the closer", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("intro</thinking>\n\noutro");
    parser.finalize();

    const text = (output.content.find((c) => c.type === "text") as { type: string; text: string })?.text ?? "";
    expect(text).not.toContain("</thinking>");
    expect(text).toContain("intro");
    expect(text).toContain("outro");
  });

  // ── Closing text blocks (FS-6) ────────────────────────────────────────

  // T-01 / AC-01: a text block is closed wherever its index is dropped, so the
  // host's block-closing path sees a text_end per block on legacy too.

  it("T-01 closes the text block at a tool-call boundary", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("before");
    parser.flushAtBoundary();
    parser.processChunk("after");
    parser.finalize();

    expect(textEndEvents(pushMock)).toEqual([
      { contentIndex: 0, content: "before" },
      { contentIndex: 1, content: "after" },
    ]);
    // closeText still hands the index to lastTextBlockIndex, so getTextBlockIndex
    // reports the value it did before the end event existed.
    expect(parser.getTextBlockIndex()).toBe(1);
  });

  it("T-01 closes the text block when leaving the thinking phase", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("prefix <thinking>reason</thinking> suffix");
    parser.finalize();

    expect(textEndEvents(pushMock)).toEqual([
      { contentIndex: 0, content: "prefix " },
      { contentIndex: 2, content: " suffix" },
    ]);
  });

  it("T-01 closes the text block before a later thinking block", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("a <thinking>x</thinking> b <thinking>y</thinking>");
    parser.finalize();

    expect(textEndEvents(pushMock)).toEqual([
      { contentIndex: 0, content: "a " },
      { contentIndex: 2, content: " b " },
    ]);
  });

  it("T-01 emits no text_end when no text block is open", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>only thinking</thinking>");
    parser.flushAtBoundary();
    parser.finalize();

    expect(textEndEvents(pushMock)).toEqual([]);

    // A second finalize over an already-closed block stays quiet.
    const emitted = pushMock.mock.calls.length;
    parser.finalize();
    expect(pushMock.mock.calls.length).toBe(emitted);
  });

  // T-02 / AC-02: the end event carries the whole block, not the last delta.
  it("T-02 emits text_end with the block's full text and the text_start's index", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hel");
    parser.processChunk("lo <thinking>thought</thinking> wor");
    parser.processChunk("ld");
    parser.finalize();

    expect(textEndEvents(pushMock)).toEqual([
      { contentIndex: 0, content: "Hello " },
      { contentIndex: 2, content: " world" },
    ]);

    const events = collectEvents(pushMock);
    for (const end of textEndEvents(pushMock)) {
      expect(
        events.some((event) => event.type === "text_start" && event.contentIndex === end.contentIndex),
        `text_end ${end.contentIndex} must match the text_start that opened it`,
      ).toBe(true);
      const streamed = events
        .filter(
          (event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
            event.type === "text_delta" && event.contentIndex === end.contentIndex,
        )
        .reduce((acc, event) => acc + event.delta, "");
      expect(end.content).toBe(streamed);
    }
  });

  // T-04 / AC-01, AC-03: end of stream closes the open block even when the
  // buffer is already empty, which is the common case for an ordinary answer.
  it("T-04 finalize closes an already-drained text block and stays quiet after", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("complete answer");
    parser.finalize();

    expect(textEndEvents(pushMock)).toEqual([{ contentIndex: 0, content: "complete answer" }]);

    const emitted = pushMock.mock.calls.length;
    parser.finalize();
    expect(pushMock.mock.calls.length).toBe(emitted);
  });

  it("T-04 finalize after a complete pair emits thinking_end and no text_end", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>finished</thinking>");
    parser.finalize();

    const types = collectEvents(pushMock).map((event) => event.type);
    expect(types).toContain("thinking_end");
    expect(textEndEvents(pushMock)).toEqual([]);
  });

  // ── stripThinkingTags helper ───────────────────────────────────────────

  it("stripThinkingTags removes opening and closing tag variants", () => {
    expect(stripThinkingTags("<thinking>hello</thinking>")).toBe("hello");
    expect(stripThinkingTags("<reasoning>deep</reasoning>")).toBe("deep");
    expect(stripThinkingTags("<summary>hidden</summary>")).toBe("hidden");
    expect(stripThinkingTags("plain text")).toBe("plain text");
    expect(stripThinkingTags("<thinking>")).toBe("");
    expect(stripThinkingTags("</thinking>")).toBe("");
  });

  it("stripThinkingTags removes every occurrence and mixed variants in one pass", () => {
    expect(stripThinkingTags("<thinking>a</thinking> middle <think>b</think>")).toBe("a middle b");
    expect(stripThinkingTags("<thought>x</thought><reasoning>y</reasoning>")).toBe("xy");
    expect(stripThinkingTags("no tags but a < here")).toBe("no tags but a < here");
  });
});
