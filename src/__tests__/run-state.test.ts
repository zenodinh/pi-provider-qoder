import type { Message } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearQoderRunRegistry,
  getQoderRunIdentity,
  isToolRoundContinuation,
  type QoderRunBusiness,
  type QoderRunMessage,
} from "../protocol/run-state.js";
import { transformMessagesForQoder } from "../protocol/transform.js";

const SESSION = "session-1";

function user(text: string): QoderRunMessage {
  return { role: "user", content: text };
}

function assistantWithTools(ids: string[]): QoderRunMessage {
  return { role: "assistant", content: " ", tool_calls: ids.map((id) => ({ id, type: "function" })) };
}

function toolResult(id: string): QoderRunMessage {
  return { role: "tool", tool_call_id: id, content: "result" };
}

function request(
  messages: QoderRunMessage[],
  lastUserText = "Refactor the build script",
): ReturnType<typeof getQoderRunIdentity> {
  return getQoderRunIdentity({
    mode: "global",
    model: "lite",
    sessionId: SESSION,
    messages,
    lastUserText,
    product: "cli",
  });
}

function businessStage(business: QoderRunBusiness): string {
  return business.stage;
}

describe("isToolRoundContinuation", () => {
  it("is false for a plain user prompt", () => {
    expect(isToolRoundContinuation([user("do it")])).toBe(false);
  });

  it("is true when tool results follow the assistant tool calls that declared them", () => {
    const messages = [user("do it"), assistantWithTools(["call-1"]), toolResult("call-1")];
    expect(isToolRoundContinuation(messages)).toBe(true);
  });

  it("is true across multiple completed tool rounds in one run", () => {
    const messages = [
      user("do it"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools(["call-2"]),
      toolResult("call-2"),
    ];
    expect(isToolRoundContinuation(messages)).toBe(true);
  });

  it("is false when the conversation tail is a fresh user message", () => {
    const messages = [
      user("first task"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools([]), // final answer without tool calls
      user("next task"),
    ];
    expect(isToolRoundContinuation(messages)).toBe(false);
  });
});

describe("getQoderRunIdentity", () => {
  beforeEach(() => {
    clearQoderRunRegistry();
  });

  it("keeps request_set_id and business.id stable across tool rounds of one run", () => {
    const first = request([user("do it")]);
    const second = request([user("do it"), assistantWithTools(["call-1"]), toolResult("call-1")]);
    const third = request([
      user("do it"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools(["call-2"]),
      toolResult("call-2"),
    ]);

    expect(second.requestSetId).toBe(first.requestSetId);
    expect(third.requestSetId).toBe(first.requestSetId);
    expect(second.business.id).toBe(first.business.id);
    expect(third.business.id).toBe(first.business.id);
    expect(second.business.begin_at).toBe(first.business.begin_at);
    expect(second.business.name).toBe(first.business.name);
  });

  it("rotates request_set_id and business.id when a new user prompt starts a run", () => {
    const first = request([user("first task")]);
    // Same session but the tail is a fresh user prompt -> new run.
    const next = request([
      user("first task"),
      assistantWithTools([]), // completed run
      user("second task"),
    ]);

    expect(next.requestSetId).not.toBe(first.requestSetId);
    expect(next.business.id).not.toBe(first.business.id);
  });

  it("advances the business stage like qodercli: start, then processing", () => {
    const first = request([user("do it")]);
    expect(businessStage(first.business)).toBe("start");

    const second = request([user("do it"), assistantWithTools(["call-1"]), toolResult("call-1")]);
    expect(businessStage(second.business)).toBe("processing");

    const third = request([
      user("do it"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools(["call-2"]),
      toolResult("call-2"),
    ]);
    expect(businessStage(third.business)).toBe("processing");
  });

  it("truncates the business display name to 10 characters like qodercli", () => {
    const longPrompt = "This is a very long prompt text for a run name";
    const identity = request([user(longPrompt)], longPrompt);
    expect(identity.business.name).toBe("This is a ");
  });

  it("keeps separate sessions independent", () => {
    const otherSession = getQoderRunIdentity({
      mode: "global",
      model: "lite",
      sessionId: "session-2",
      messages: [user("do it")],
      lastUserText: "do it",
      product: "cli",
    });
    const first = request([user("do it")]);
    const otherContinuation = getQoderRunIdentity({
      mode: "global",
      model: "lite",
      sessionId: "session-2",
      messages: [user("do it"), assistantWithTools(["call-9"]), toolResult("call-9")],
      lastUserText: "do it",
      product: "cli",
    });
    expect(otherContinuation.requestSetId).toBe(otherSession.requestSetId);
    expect(otherContinuation.requestSetId).not.toBe(first.requestSetId);
  });

  /**
   * The normalized tail a completed tool round produces, through the REAL
   * transform. AC-05 forbids a hand-written approximation, because the hazard
   * lives in the transform: transform.ts:270-296 defers image-bearing user
   * messages and flushes them at the end of the loop (:295), so a tool round
   * that returned an image ends the normalized list with role:"user".
   */
  function normalizedToolRound(withImage: boolean): QoderRunMessage[] {
    const toolContent = withImage
      ? [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "abc123", mimeType: "image/png" },
        ]
      : [{ type: "text", text: "plain text result" }];
    const messages = [
      { role: "user", content: "read the screenshot" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/tmp/shot.png" } },
        ],
      },
      { role: "toolResult", toolCallId: "call_1", content: toolContent },
    ] as unknown as Message[];
    return transformMessagesForQoder(messages) as unknown as QoderRunMessage[];
  }

  /**
   * T-12 / AC-05 — pins TODAY'S SPLIT, not the desired continuity.
   *
   * FS-3's pre-flush continuation check must invert this row from an observed
   * red to green. Asserting continuity instead would make the fix unfalsifiable,
   * and a hand-written tail would hide the deferred-flush shape that causes it.
   */
  it("splits the billing run when a tool round returned an image, while a plain round continues it", () => {
    // Control: a plain tool result keeps the run. The tail is role:"tool", so
    // the continuation predicate holds and the slot is reused.
    const plainPrompt = request([user("read the screenshot")]);
    const plainTail = normalizedToolRound(false);
    expect(plainTail.at(-1)?.role).toBe("tool");
    expect(isToolRoundContinuation(plainTail)).toBe(true);
    const plainRound = request(plainTail);
    expect(plainRound.requestSetId).toBe(plainPrompt.requestSetId);
    expect(plainRound.business.id).toBe(plainPrompt.business.id);

    // Hazard: the SAME round, with an image in the tool result. The transform
    // defers the image into a trailing user message, isToolRoundContinuation
    // breaks on the first non-tool role, and a fresh identity is minted — one
    // user turn billed as two runs on the vendor ledger (OB-6).
    clearQoderRunRegistry();
    const imagePrompt = request([user("read the screenshot")]);
    const imageTail = normalizedToolRound(true);
    expect(imageTail.at(-1)?.role, "the deferred image message ends the normalized list").toBe("user");
    expect(isToolRoundContinuation(imageTail)).toBe(false);
    const imageRound = request(imageTail);
    expect(imageRound.requestSetId).not.toBe(imagePrompt.requestSetId);
    expect(imageRound.business.id).not.toBe(imagePrompt.business.id);
    // The image is the ONLY difference between the two rounds, so the split is
    // attributable to it and not to the extra message count.
    expect(imageTail).toHaveLength(plainTail.length + 1);
  });

  /**
   * T-13 / AC-06 — pins TODAY'S MUTATION of run state by a warm re-dispatch.
   *
   * A cache-warm refresh re-sends a turn the user never sent (maxTokens:1
   * upstream). getQoderRunIdentity cannot tell it from a real turn, so it
   * advances the stage and can overwrite the slot. FS-3's turnKind reuse must
   * invert both phases; asserting "no mutation today" would make that fix
   * unfalsifiable.
   */
  it("advances the stage and overwrites the slot on a warm re-dispatch the user never sent", () => {
    // Phase (a) — phantom advance. A continuation-shaped warm replay over a
    // slot at "start" pushes it to "processing" with no new user turn.
    const continuationTail = [user("do it"), assistantWithTools(["call-1"]), toolResult("call-1")];
    const real = request([user("do it")]);
    expect(real.business.stage).toBe("start");

    const warm = request(continuationTail);
    expect(warm.requestSetId, "the warm replay lands on the established slot").toBe(real.requestSetId);
    expect(warm.business.stage, "phantom advance: start -> processing on a turn nobody sent").toBe("processing");

    // Phase (b) — slot overwrite. A fresh-tail warm mints a NEW identity and
    // replaces the slot, so the next real tool round continues the WARM run and
    // the vendor bills it under an id the user's turn never had.
    clearQoderRunRegistry();
    const established = request([user("do it")]);
    const warmFresh = request([user("do it")]);
    expect(warmFresh.requestSetId, "the fresh-tail warm overwrote the slot").not.toBe(established.requestSetId);

    const nextRealRound = request(continuationTail);
    expect(nextRealRound.requestSetId, "the real round now continues the WARM identity").toBe(warmFresh.requestSetId);
    expect(nextRealRound.requestSetId).not.toBe(established.requestSetId);
  });
});
