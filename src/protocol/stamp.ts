// shape: none — dispatch object does not apply: one decorator function over the
//   host's event-stream interface plus two pure helpers and a fixed-shape stamp
//   value; there is no discriminator table (straight-line, below the ≥3
//   threshold).
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { debugLog } from "../debug.js";
import type { RateSource } from "../pricing.js";

/**
 * The tail's per-turn values, both optional: the rate source an adapter produced
 * for a priced row, and the reserved hook a later concern (defects-SA CU-6's
 * prefix stamp) rides without editing either adapter.
 */
export interface TerminalStamp {
  rateSource?: RateSource;
  onTerminal?: (message: AssistantMessage) => void;
}

/** A usage row plus the tail-written pricing source (the shape both adapters store). */
type RateStampedUsage = AssistantMessage["usage"] & { rateSource?: RateSource };

/**
 * A proxy for "a usage chunk arrived": true when any token bucket is nonzero.
 * A chunk that reports every bucket zero reads as unpriced — a claim of no
 * money, which is the honest answer for a row whose cost is also zero.
 */
export function hasUsage(message: AssistantMessage): boolean {
  const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
  return input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 || totalTokens > 0;
}

/** The terminal message of a done or error event; every other event type carries none. */
function terminalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return undefined;
}

/**
 * Apply the tail's stamps in place, before the event is pushed: the rate source
 * rides only a row a usage chunk actually priced (an unpriced error row claims
 * no ladder priced it), and the hook sees the same live message the stream
 * pushes. Non-terminal events pass through untouched.
 */
export function stampTerminal(event: AssistantMessageEvent, stamp: TerminalStamp): void {
  const message = terminalMessage(event);
  if (!message) return;
  if (stamp.rateSource !== undefined && hasUsage(message)) {
    (message.usage as RateStampedUsage).rateSource = stamp.rateSource;
  }
  stamp.onTerminal?.(message);
}

/**
 * The message the failure path reports when the inner stream threw before any
 * event existed to carry one. Nothing was produced, so no model identity is
 * known; the tail owns only the error it observed.
 */
function unstartedMessage(error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "",
    provider: "",
    model: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

/**
 * Wrap an adapter's event stream so its terminal write is ordered: every inner
 * event is forwarded unchanged and in order, a done or error message is stamped
 * before it is pushed (a consumer never sees the unstamped then the stamped
 * form), and a terminal is pushed before end() even when this loop itself
 * throws or the inner stream ends without one, so result() settles instead of
 * leaving the host awaiting forever. A push after the terminal is never
 * attempted: the inner iterator ends at its terminal and this loop follows.
 */
export function withTerminalStamp(
  inner: AssistantMessageEventStream,
  stamp: TerminalStamp,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  let lastMessage: AssistantMessage | undefined;
  let ended = false;
  // The stamp must never defeat the order it decorates: a throwing observer is
  // logged and skipped, so it can neither drop a terminal (leaving result()
  // pending) nor rewrite a settled turn's outcome.
  const applyStamp = (event: AssistantMessageEvent): void => {
    try {
      stampTerminal(event, stamp);
    } catch (error) {
      debugLog(`provider.stamp tail: terminal stamp failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const pushFailure = (error: unknown): void => {
    if (ended) return;
    ended = true;
    try {
      const message = lastMessage ?? unstartedMessage(error);
      message.stopReason = "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      const failure: AssistantMessageEvent = { type: "error", reason: "error", error: message };
      applyStamp(failure);
      out.push(failure);
    } catch {}
  };
  void (async () => {
    for await (const event of inner) {
      const terminal = event.type === "done" || event.type === "error";
      lastMessage = terminal ? terminalMessage(event) : event.partial;
      applyStamp(event);
      out.push(event);
      if (terminal) ended = true;
    }
    if (!ended) {
      debugLog("provider.stamp tail: inner stream ended without a terminal event");
      pushFailure(new Error("Qoder stream ended before a terminal response event (stamp tail)"));
    }
    out.end();
  })().catch((error: unknown) => {
    debugLog(`provider.stamp tail failed: ${error instanceof Error ? error.message : String(error)}`);
    pushFailure(error);
    try {
      out.end();
    } catch {}
  });
  return out;
}
