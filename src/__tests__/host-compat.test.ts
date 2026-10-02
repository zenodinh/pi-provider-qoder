import { type Message, normalizeContext, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  fallbackGetCurrentSystemMessage,
  fallbackGetSystemMessageText,
  fallbackHyperlink,
  fallbackWithoutInitialSystemMessage,
  resolveSystemAndTools,
} from "../host-compat.js";

const userMessage = { role: "user", content: "hi", timestamp: 1 } as Message;
const readTool = { name: "read", description: "read a file", parameters: {} } as unknown as Tool;

function systemMessage(partial: Partial<SystemMessage> = {}): SystemMessage {
  return { role: "system", content: "prompt", timestamp: 0, ...partial };
}

describe("fallback transcript helpers", () => {
  it("folds content and sections across system messages like pi-ai", () => {
    const messages: Message[] = [
      systemMessage({ content: "base", sections: { env: "e1" } }),
      userMessage,
      systemMessage({ content: "later", sections: { env: null, extra: "e2" } }),
    ];
    const current = fallbackGetCurrentSystemMessage(messages);
    expect(current?.content).toBe("base\n\nlater");
    expect(current?.sections).toEqual({ extra: "e2" });
  });

  it("returns undefined for a transcript without system content or tools", () => {
    expect(fallbackGetCurrentSystemMessage([userMessage])).toBeUndefined();
  });

  it("carries toolsAdded through the resolved message", () => {
    const current = fallbackGetCurrentSystemMessage([systemMessage({ toolsAdded: [readTool] })]);
    expect(current?.toolsAdded?.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("renders content followed by sections", () => {
    const message = systemMessage({ content: "C", sections: { a: "A", b: null } });
    expect(fallbackGetSystemMessageText(message)).toBe("C\n\nA");
  });

  it("strips a leading system message and leaves other transcripts untouched", () => {
    const folded = [systemMessage(), userMessage];
    expect(fallbackWithoutInitialSystemMessage(folded)).toEqual([userMessage]);
    expect(fallbackWithoutInitialSystemMessage([userMessage])).toEqual([userMessage]);
  });
});

describe("resolveSystemAndTools", () => {
  it("reads a normalized transcript (folded prompt and tools)", () => {
    const context = normalizeContext({ systemPrompt: "SYS", tools: [readTool], messages: [userMessage] });
    const result = resolveSystemAndTools(context);
    expect(result.systemText).toContain("SYS");
    expect(result.tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("reads a legacy context with top-level systemPrompt and tools", () => {
    const context = { messages: [userMessage], systemPrompt: ["A", "B"], tools: [readTool] };
    const result = resolveSystemAndTools(context);
    expect(result.systemText).toBe("A\n\nB");
    expect(result.tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("accepts a single-string systemPrompt and empty tools", () => {
    const result = resolveSystemAndTools({ messages: [userMessage], systemPrompt: "S" });
    expect(result.systemText).toBe("S");
    expect(result.tools).toEqual([]);
  });
});

describe("fallbackHyperlink", () => {
  it("emits an OSC 8 sequence with an ST terminator", () => {
    expect(fallbackHyperlink("text", "https://example.com")).toBe(
      "\x1b]8;;https://example.com\x1b\\text\x1b]8;;\x1b\\",
    );
  });
});
