// shape: none — unit tests for the queue-admission boundary seam. The nesting
// built here reproduces the exact triple-encoded body Qoder sent for a busy
// Qwen3.8-Flash (2026-10-01): {"code":"403","message":"{\"code\":\"10605\",
// \"message\":\"{\\\"isQueued\\\":true,...retryAfterSeconds:30...}\"}")"}.
// The host-facing assertions pin the contract stream.ts relies on: the
// rendered line must classify as transient (not auth) on host pattern tables
// and carry the provider's wait in a form hosts parse into a real delay.
//
// Two of these cases are the maintainer's repros from the PR #21 review, kept
// verbatim because both failed against the first implementation:
//   - a 401 whose nested body reports serviceAvailable:false + a wait, with no
//     queue discriminator, must NOT be rewritten into a retryable queue wait
//     (an expired job token looks exactly like that and must stay a 401);
//   - a queue payload whose own level carries no code must not re-print the
//     outer envelope's 403, which is the token the module exists to drop.
import { describe, expect, it } from "vitest";
import { describeQoderQueueError, parseQoderQueueState, type QoderQueueState } from "../protocol/queue.js";

/** The live queue state for `qfmodel` (Qwen3.8-Flash), as decoded from the wire. */
const LIVE_QUEUE_STATE = {
  isQueued: true,
  modelKey: "qfmodel",
  queueCount: 0,
  queueType: "p3",
  retryAfterSeconds: 30,
  serviceAvailable: false,
  waitTime: 30,
};

/** Build the triple-encoded envelope body exactly as the gateway sends it. */
function envelopeBody(queueState: unknown): string {
  return JSON.stringify({
    code: "403",
    message: JSON.stringify({ code: "10605", message: JSON.stringify(queueState) }),
  });
}

describe("parseQoderQueueState", () => {
  it("unwraps the live triple-encoded envelope into the queue state", () => {
    expect(parseQoderQueueState(envelopeBody(LIVE_QUEUE_STATE))).toEqual({
      modelKey: "qfmodel",
      queueType: "p3",
      queueCount: 0,
      waitSeconds: 30,
      code: "10605",
    });
  });

  it("accepts a single-level queue object and tolerates stringified flags", () => {
    expect(
      parseQoderQueueState(JSON.stringify({ isQueued: "true", modelKey: "qmodel_38max", waitTime: 15.5 })),
    ).toEqual({
      modelKey: "qmodel_38max",
      waitSeconds: 15.5,
      code: undefined,
      queueCount: undefined,
      queueType: undefined,
    });
  });

  it("recognises the business code alone, with no isQueued flag", () => {
    expect(parseQoderQueueState(JSON.stringify({ code: "10605", retryAfterSeconds: 30 }))?.waitSeconds).toBe(30);
  });

  it("leaves a 401 with a service-down body alone (maintainer repro)", () => {
    // Everything except the queue discriminator matches the live payload. If
    // this rewrites, an expired job token becomes a silent retry loop and the
    // user is never told to log in again.
    const body = JSON.stringify({
      code: "401",
      message: JSON.stringify({ serviceAvailable: false, retryAfterSeconds: 60, error: "invalid token" }),
    });
    expect(parseQoderQueueState(body)).toBeUndefined();
  });

  it("returns undefined for non-queue bodies so callers keep their error text", () => {
    expect(parseQoderQueueState("Internal failure")).toBeUndefined();
    expect(parseQoderQueueState(JSON.stringify({ code: "401", message: "bad token" }))).toBeUndefined();
    // A wait without the queue flag and with the service up is not a queue:
    // mislabeling it would steal the payload's own classification.
    expect(parseQoderQueueState(JSON.stringify({ retryAfterSeconds: 30, serviceAvailable: true }))).toBeUndefined();
  });
});

describe("describeQoderQueueError", () => {
  it("renders the observed state as one transient, retryable line", () => {
    const state: QoderQueueState = {
      modelKey: "qfmodel",
      queueType: "p3",
      queueCount: 0,
      waitSeconds: 30,
      code: "10605",
    };
    expect(describeQoderQueueError(state)).toBe(
      "Qoder service unavailable (code 10605): model qfmodel is queued (queue p3, 0 ahead); try again in 30s.",
    );
  });

  it("degrades gracefully when the payload omits the wait or the model key", () => {
    expect(describeQoderQueueError({})).toBe("Qoder service unavailable: the model is queued; try again in a moment.");
  });

  it("never re-prints a carrier status as the queue's own code (maintainer repro)", () => {
    // The outer envelope's 403 is a carrier, not a diagnosis. Inheriting it into
    // the message would put the exact auth token back into the text a host
    // classifies.
    const state = parseQoderQueueState(
      JSON.stringify({ code: "403", message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30 }) }),
    );
    expect(state?.code).toBeUndefined();
    const message = describeQoderQueueError(state ?? {});
    expect(message).not.toMatch(/\b(?:401|403|unauthorized|forbidden|authentication)\b/i);
    expect(message).toBe("Qoder service unavailable: the model is queued; try again in 30s.");
  });

  it("stays in the host transient lane and out of the auth lane", () => {
    const message = describeQoderQueueError({
      modelKey: "qfmodel",
      queueType: "p3",
      queueCount: 0,
      waitSeconds: 30,
      code: "10605",
    });
    // `service unavailable` is the transient token host pattern tables match.
    expect(message).toMatch(/service ?unavailable/i);
    // The wait hint is what hosts parse into a real retry delay.
    expect(message).toMatch(/try again in ([\d.]+)(ms|s)/i);
    expect(message).not.toMatch(/\b(?:401|403|unauthorized|forbidden|authentication)\b/i);
  });
});
