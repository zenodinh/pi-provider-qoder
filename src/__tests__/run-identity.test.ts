import type { Message } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyTurnKind,
  clearQoderRunRegistry,
  isRunContinuation,
  type QoderRunBusiness,
  type QoderRunIdentity,
  type QoderRunMessage,
  type QoderTurnKind,
  resolveRunIdentity,
} from "../protocol/run-identity.js";
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
  turnKind: QoderTurnKind = "real",
): QoderRunIdentity {
  return resolveRunIdentity({
    mode: "global",
    upstreamKey: "lite",
    wireSessionId: SESSION,
    messages,
    lastUserText,
    product: "cli",
    turnKind,
  });
}

function identityFor(
  wireSessionId: string,
  messages: QoderRunMessage[],
  turnKind: QoderTurnKind = "real",
): QoderRunIdentity {
  return resolveRunIdentity({
    mode: "global",
    upstreamKey: "lite",
    wireSessionId,
    messages,
    lastUserText: "task",
    product: "cli",
    turnKind,
  });
}

function businessStage(business: QoderRunBusiness): string {
  return business.stage;
}

describe("isRunContinuation", () => {
  it("is false for a plain user prompt", () => {
    expect(isRunContinuation([user("do it")])).toBe(false);
  });

  it("is true when tool results follow the assistant tool calls that declared them", () => {
    const messages = [user("do it"), assistantWithTools(["call-1"]), toolResult("call-1")];
    expect(isRunContinuation(messages)).toBe(true);
  });

  it("is true across multiple completed tool rounds in one run", () => {
    const messages = [
      user("do it"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools(["call-2"]),
      toolResult("call-2"),
    ];
    expect(isRunContinuation(messages)).toBe(true);
  });

  it("is false when the conversation tail is a fresh user message", () => {
    const messages = [
      user("first task"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools([]), // final answer without tool calls
      user("next task"),
    ];
    expect(isRunContinuation(messages)).toBe(false);
  });
});

/**
 * The raw pi view a tool round produces, built with the shapes
 * transformMessagesForQoder consumes (transform.ts:127,147-148,215,247-251):
 * a `toolResult` role carrying `toolCallId`, and an assistant `toolCall`
 * content block. `withImage` puts an image block in the tool result, which the
 * real transform then defers into a trailing user message.
 */
function rawToolRound(withImage: boolean): QoderRunMessage[] {
  const toolContent = withImage
    ? [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "abc123", mimeType: "image/png" },
      ]
    : [{ type: "text", text: "plain text result" }];
  return [
    { role: "user", content: "read the screenshot" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/tmp/shot.png" } },
      ],
    },
    { role: "toolResult", toolCallId: "call_1", content: toolContent },
  ] as unknown as QoderRunMessage[];
}

/** The normalized tail the REAL transform produces for the same round. */
function normalizedToolRound(withImage: boolean): QoderRunMessage[] {
  return transformMessagesForQoder(rawToolRound(withImage) as unknown as Message[]) as unknown as QoderRunMessage[];
}

describe("isRunContinuation across both message vocabularies", () => {
  /**
   * T-03 / AC-04 — one predicate, one registry, two views. The adapter's
   * message view is the only input that differs between the protocols; if the
   * verdict or the identity sequence depended on the vocabulary, the same
   * conversation would bill as one run on legacy and several on v2.
   */
  it("returns the same verdict and identity for the raw pi and the normalized shape of one conversation", () => {
    const rawView = rawToolRound(false);
    const normalizedView = normalizedToolRound(false);

    expect(isRunContinuation(rawView)).toBe(true);
    expect(isRunContinuation(normalizedView)).toBe(true);

    clearQoderRunRegistry();
    const fromRaw = request(rawView);
    const fromNormalized = request(normalizedView);
    expect(fromNormalized.requestSetId).toBe(fromRaw.requestSetId);
    expect(fromNormalized.business.id).toBe(fromRaw.business.id);
  });

  /**
   * T-04 / AC-01 — the FS-1 image-round pin, inverted from observed red.
   *
   * The transform STILL defers the image into a trailing synthetic user
   * message, so the normalized tail reads as a fresh prompt (asserted below).
   * The fix is the view the predicate reads: the raw transcript's tail is the
   * tool result, so the round continues the run instead of starting a new one.
   */
  it("continues the run for a tool round that returned an image, because the predicate reads the raw view", () => {
    const rawView = rawToolRound(true);
    const normalizedView = normalizedToolRound(true);

    expect(normalizedView.at(-1)?.role, "the deferred image message ends the normalized list").toBe("user");
    expect(isRunContinuation(normalizedView), "the post-flush tail is not a continuation").toBe(false);
    expect(isRunContinuation(rawView), "the raw tail is still the tool result").toBe(true);
    // The image is the ONLY difference between the two rounds, so the split is
    // attributable to it and not to the extra message count.
    expect(normalizedView).toHaveLength(normalizedToolRound(false).length + 1);

    clearQoderRunRegistry();
    const prompt = request([user("read the screenshot")]);
    const round = request(rawView);
    expect(round.requestSetId).toBe(prompt.requestSetId);
    expect(round.business.id).toBe(prompt.business.id);
    expect(round.business.begin_at).toBe(prompt.business.begin_at);
  });
});

describe("resolveRunIdentity", () => {
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
    const otherSession = identityFor("session-2", [user("do it")]);
    const first = request([user("do it")]);
    const otherContinuation = identityFor("session-2", [
      user("do it"),
      assistantWithTools(["call-9"]),
      toolResult("call-9"),
    ]);
    expect(otherContinuation.requestSetId).toBe(otherSession.requestSetId);
    expect(otherContinuation.requestSetId).not.toBe(first.requestSetId);
  });

  /**
   * T-01 / AC-02 — a cache-warming replay is not a user turn.
   *
   * Pins the fix for the second FS-1 hazard: a maxTokens:1 re-dispatch must not
   * advance the established slot's stage, must not overwrite it with a fresh
   * tail, and when no slot exists it must register nothing (otherwise the next
   * real tool round continues the WARM identity and bills under the wrong run).
   */
  it("leaves the slot untouched on a warm re-dispatch and registers nothing on a warm miss", () => {
    const continuationTail = [user("do it"), assistantWithTools(["call-1"]), toolResult("call-1")];
    const real = request([user("do it")]);
    expect(real.business.stage).toBe("start");

    // Warm hit over the established slot: same identity, stage NOT advanced.
    const warm = request(continuationTail, "Refactor the build script", "warm");
    expect(warm.requestSetId, "the warm replay reuses the established slot").toBe(real.requestSetId);
    expect(warm.business.stage, "a warm turn must not advance the stage").toBe("start");

    // A fresh-tail warm must not overwrite the slot either, and the next real
    // tool round must still continue the pre-warm identity.
    const warmOverSlot = request([user("do it")], "do it", "warm");
    expect(warmOverSlot.requestSetId, "the fresh-tail warm did not rotate the slot").toBe(real.requestSetId);
    expect(warmOverSlot.business.stage, "no phantom advance on a turn nobody sent").toBe("start");
    const nextRealRound = request(continuationTail);
    expect(nextRealRound.requestSetId, "the real round continues the pre-warm identity").toBe(real.requestSetId);

    // Warm miss: an ephemeral identity that is never registered.
    clearQoderRunRegistry();
    const warmFresh = request([user("do it")], "do it", "warm");
    const afterWarm = request(continuationTail);
    expect(afterWarm.requestSetId, "the warm identity was never registered").not.toBe(warmFresh.requestSetId);
  });

  /**
   * T-02 / AC-06 — cap-64 plus LRU for both protocols, with reuse refreshing
   * recency. Without the recency refresh a long run is evicted mid-flight by
   * 64 unrelated keys and silently splits; without the cap the registry grows
   * without bound.
   */
  it("caps the registry at 64 and evicts the least recently used slot, refreshing recency on reuse", () => {
    const fresh = (session: string) => identityFor(session, [user("task")]);
    const continuation = (session: string) =>
      identityFor(session, [user("task"), assistantWithTools(["call-1"]), toolResult("call-1")]);

    const original: string[] = [];
    for (let i = 0; i < 64; i++) original.push(fresh(`session-${i}`).requestSetId);

    // Reusing the first-inserted slot must move it to the most-recent end, so
    // the 65th distinct key evicts session-1 rather than session-0.
    expect(continuation("session-0").requestSetId).toBe(original[0]);

    const latest = fresh("session-64"); // 65th distinct key: the cap evicts the LRU

    expect(continuation("session-0").requestSetId, "the recently reused slot survived").toBe(original[0]);
    expect(continuation("session-1").requestSetId, "the least recently used slot was evicted").not.toBe(original[1]);
    expect(continuation("session-64").requestSetId).toBe(latest.requestSetId);
  });
});

describe("classifyTurnKind", () => {
  /**
   * T-06 / AC-02 — the warm classification is exactly the host cache warmer's
   * replay literal. If that literal changes upstream, this row goes red instead
   * of warm turns silently starting to mutate run state again.
   */
  it("classifies exactly maxTokens 1 as warm, and every other value as real", () => {
    expect(classifyTurnKind(1)).toBe("warm");
    expect(classifyTurnKind(undefined)).toBe("real");
    expect(classifyTurnKind(0)).toBe("real");
    expect(classifyTurnKind(2)).toBe("real");
    expect(classifyTurnKind("1" as unknown as number)).toBe("real");
  });
});
