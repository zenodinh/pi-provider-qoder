import { readFileSync } from "node:fs";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache } from "../catalog.js";
import { buildAuthHeaders } from "../cosy.js";
import { MAX_DSML_BUFFER_LENGTH } from "../protocol/dsml.js";
import { clearQoderFallbackCache, clearQoderRoutingMemCache } from "../protocol/routing.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";
import { MAX_SSE_BUFFER_LENGTH, streamQoder } from "../protocol/stream.js";
import {
  BARE_DONE_SSE,
  chunk,
  DONE_SSE,
  finishChunk,
  mockFetch,
  OVERSIZED_TEXT,
  SUCCESS_SSE,
  sseEnvelope,
  sseResponse,
} from "./sse-fixtures.js";

/**
 * AC-03 — the rendered error-text inventory.
 *
 * The host's retry classifier (`isRetryableAssistantError`) is a bare
 * case-insensitive substring alternation over prose this repo does not own, so a
 * one-word reword of any text below silently moves a failure between retryable
 * and non-retryable. Every row therefore pins an EXACT instance with `toBe` —
 * never `toContain` — so a wording drift is a red row naming the site.
 *
 * Two census facts this file records rather than papers over:
 *
 * 1. `stream.ts:786` (`Qoder generation failed`) is UNREACHABLE. `output.stopReason`
 *    at the `:785` guard can only be `stop`, `length` or `toolUse`: `mapFinishReason`
 *    returns exactly those three, `:756` assigns `stop`, `:781` assigns `toolUse`, and
 *    the only `error`/`aborted` assignment is `:795` inside the catch that this throw
 *    would have to precede. The repo's own coverage report agrees — `stream.ts:785`
 *    carries `missing-if-branch`, "if path not taken". So it is documented here, not
 *    pinned with a fabricated scenario.
 *
 * 2. `cosy.ts:130` and `cosy.ts:133` are reachable inside the `:185-793` try but not
 *    through `streamQoder`'s inputs: `userID` is `ident.userID || "qoder-user"` (`:208`)
 *    so it is never empty, and `authToken` is `accessToken`, which `:191` already
 *    guaranteed non-empty. They are pinned at `buildAuthHeaders`' own exported surface,
 *    because they become host-visible the moment either upstream guard changes.
 *
 * Beyond the spec's 22, two more texts reach the host through `abort(new Error(...))`
 * rather than a `throw` statement, so a census scoped to throw sites misses them:
 * `Qoder request timeout` (`stream.ts:166`) and `Qoder stream idle timeout`
 * (`stream.ts:414`). Both are pinned below and both classify as RETRYABLE.
 *
 * A twenty-fifth text renders from the shared terminal tail rather than the
 * legacy transport: the no-terminal backstop at `stamp.ts` pushes its error as
 * `Qoder stream ended before a terminal response event (stamp tail)` — the
 * same EOF class, so it deliberately carries the host pattern and classifies
 * as RETRYABLE; `stamp.test.ts` pins the exact rendered instance.
 */

function makeModel(provider: "qoder" | "qoder-cn" = "qoder", id = "Lite"): Model<Api> {
  return { id, api: "qoder-api" as Api, provider } as Model<Api>;
}

function makeContext(): TranscriptContext {
  return normalizeContext({
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context);
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "done" || event.type === "error") break;
  }
  return events;
}

const isErrorEvent = (event: AssistantMessageEvent): event is Extract<AssistantMessageEvent, { type: "error" }> =>
  event.type === "error";

/**
 * Drive one crafted upstream condition and return the terminal error event's
 * rendered `errorMessage`. A scenario that terminates cleanly is a loud failure
 * here, not a silent `undefined` — the row exists to prove the site fired.
 */
async function renderedError(options: SimpleStreamOptions, model = makeModel()): Promise<string> {
  const events = await consume(streamQoder(model, makeContext(), options));
  const error = events.find(isErrorEvent);
  if (!error) {
    throw new Error(
      `expected a terminal error event, got: ${events.map((event) => event.type).join(", ") || "(none)"}`,
    );
  }
  const message = error.error.errorMessage;
  if (typeof message !== "string" || message === "") {
    throw new Error(`expected a non-empty errorMessage, got: ${JSON.stringify(message)}`);
  }
  return message;
}

/** The exact message a synchronous throw site renders. */
function thrownMessage(call: () => unknown): string {
  try {
    call();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

/** A fetch whose body never yields, so the idle timer is the only way out. */
function stallingFetch(): typeof globalThis.fetch {
  const stalled = new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return vi.fn(async () => stalled) as unknown as typeof globalThis.fetch;
}

const IDENTITY = {
  access: "fake",
  refresh: "",
  expires: 0,
  userID: "user",
  name: "Test",
  email: "test@example.com",
  machineID: "machine",
};

beforeEach(() => {
  // The cache key is `${providerID}:${accessToken}` (oauth.ts:149), so both
  // providers need an entry or resolveQoderIdentity fetches /userinfo and
  // consumes the injected response.
  cacheQoderIdentityForTest("qoder:fake", IDENTITY);
  cacheQoderIdentityForTest("qoder-cn:fake", IDENTITY);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected global fetch");
    }),
  );
});

afterEach(() => {
  clearQoderAuthMemCache();
  clearQoderFallbackCache();
  clearQoderRoutingMemCache();
  clearQoderFilterMemCache();
  clearQoderModelsMemCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * One crafted upstream condition per throw site, for the texts whose every
 * character this repo controls. `site` is the locator a red row must name.
 */
interface BoundedSite {
  site: string;
  text: string;
  render: () => Promise<string>;
}

/**
 * FS-5's one-word alignment: the rendered EOF text now contains the host's
 * purpose-built pattern verbatim, so pi's agent-level retry re-dispatches the
 * turn. One spelling, shared by the exact-instance row, the verdict table and
 * the FS-5 rows below, so a drift cannot leave them disagreeing.
 */
const ALIGNED_EOF_TEXT = "Qoder stream ended before a terminal response event (unexpected EOF)";
const HOST_EOF_PATTERN = "stream ended before a terminal response event";

const BOUNDED_SITES: BoundedSite[] = [
  {
    site: "stream.ts:181",
    text: "Qoder request aborted",
    // throwIfAborted wraps a non-Error abort reason; an external signal aborted
    // with a string is the only way to reach that branch.
    render: () => {
      const controller = new AbortController();
      controller.abort("not-an-error");
      return renderedError({ apiKey: "fake", signal: controller.signal, fetch: mockFetch(SUCCESS_SSE) });
    },
  },
  {
    site: "stream.ts:191 (cn variant)",
    text: "Qoder CN credentials not set. Run /login qoder-cn or set QODERCN_PERSONAL_ACCESS_TOKEN.",
    render: () => renderedError({}, makeModel("qoder-cn")),
  },
  {
    site: "stream.ts:191 (global variant)",
    text: "Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.",
    render: () => renderedError({}),
  },
  {
    site: "stream.ts:218",
    text: "Unknown Qoder model id: no-such-model",
    render: () => renderedError({ apiKey: "fake", fetch: mockFetch(SUCCESS_SSE) }, makeModel("qoder", "no-such-model")),
  },
  {
    site: "stream.ts:271",
    text: "Qoder maxTokens must be a positive integer",
    render: () => renderedError({ apiKey: "fake", maxTokens: 0, fetch: mockFetch(SUCCESS_SSE) }),
  },
  {
    site: "stream.ts:380",
    text: "Qoder onPayload must return a JSON object or undefined",
    render: () =>
      renderedError({
        apiKey: "fake",
        fetch: mockFetch(SUCCESS_SSE),
        onPayload: async () => "not-an-object",
      } as SimpleStreamOptions),
  },
  {
    site: "stream.ts:499",
    text: "No response body",
    render: () =>
      renderedError({
        apiKey: "fake",
        fetch: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch,
      }),
  },
  {
    site: "stream.ts:594 (and the identical text at :605)",
    text: `Qoder SSE buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters without a complete line`,
    // No newline anywhere in the body: `:593` only rejects an unbounded buffer
    // when `!buffer.includes("\n")`.
    render: () =>
      renderedError({
        apiKey: "fake",
        fetch: vi.fn(
          async () =>
            new Response(`data:${"x".repeat(MAX_SSE_BUFFER_LENGTH + 1)}`, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
        ) as unknown as typeof globalThis.fetch,
      }),
  },
  {
    site: "stream.ts:745",
    text: "Malformed Qoder SSE data",
    render: () =>
      renderedError({
        apiKey: "fake",
        fetch: mockFetch("data: {this is not json\n\n"),
      }),
  },
  {
    site: "stream.ts:754",
    text: ALIGNED_EOF_TEXT,
    // A content delta, no finish_reason and no sentinel: the body just closes.
    render: () => renderedError({ apiKey: "fake", fetch: mockFetch(sseEnvelope(chunk({ content: "hi" }))) }),
  },
  {
    site: "stream.ts:759",
    text: "Qoder tool call was truncated by the output token limit",
    render: () =>
      renderedError({
        apiKey: "fake",
        fetch: mockFetch(
          sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{}" } }] })) +
            sseEnvelope(finishChunk("length")) +
            DONE_SSE,
        ),
      }),
  },
  {
    site: "stream.ts:783",
    text: "Qoder finished with tool_calls but returned no tool calls",
    render: () =>
      renderedError({ apiKey: "fake", fetch: mockFetch(sseEnvelope(finishChunk("tool_calls")) + DONE_SSE) }),
  },
  {
    // Not a throw site: an abort reason, so a throw-site census misses it.
    site: "stream.ts:166 (abort reason, beyond the spec's 22)",
    text: "Qoder request timeout",
    render: () =>
      renderedError({
        apiKey: "fake",
        timeoutMs: 5,
        // Outlive the 5ms request deadline so the timer is what ends the turn.
        fetch: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return sseResponse(SUCCESS_SSE);
        }) as unknown as typeof globalThis.fetch,
      } as SimpleStreamOptions),
  },
  {
    // Not a throw site either, and the only legacy text the host retries that
    // is not an HTTP status.
    site: "stream.ts:414 (abort reason, beyond the spec's 22)",
    text: "Qoder stream idle timeout",
    render: () =>
      renderedError({
        apiKey: "fake",
        env: { QODER_STREAM_IDLE_TIMEOUT_MS: "1" },
        fetch: stallingFetch(),
      } as SimpleStreamOptions),
  },
  {
    site: "tool-calls.ts:78 via ToolCallAccumulator.finalize",
    text: "Incomplete Qoder tool call identity",
    // An id with no function.name: openIfIdentifiable opens the block on the id
    // alone, then finalize rejects the half-identified call.
    render: () =>
      renderedError({
        apiKey: "fake",
        fetch: mockFetch(
          sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "c1" }] })) + sseEnvelope(finishChunk("stop")) + DONE_SSE,
        ),
      }),
  },
  {
    site: "tool-calls.ts:158 via ToolCallAccumulator.finalize",
    text: "Invalid or truncated Qoder tool call arguments",
    render: () =>
      renderedError({
        apiKey: "fake",
        fetch: mockFetch(
          sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"a":' } }] })) +
            sseEnvelope(finishChunk("stop")) +
            DONE_SSE,
        ),
      }),
  },
  {
    site: "dsml.ts:65 via DsmlToolCallParser.processChunk",
    text: `Qoder DSML buffer exceeded ${MAX_DSML_BUFFER_LENGTH} characters`,
    // The envelope's trailing "\n\n" is what lets this past stream.ts:593 and
    // into the DSML cap instead — the same oversized text, different gate.
    render: () =>
      renderedError({ apiKey: "fake", fetch: mockFetch(sseEnvelope(chunk({ content: OVERSIZED_TEXT })) + DONE_SSE) }),
  },
];

describe("rendered error inventory — bounded texts pinned as exact instances", () => {
  it.each(BOUNDED_SITES.map((site) => [site.site, site]))("pins %s", async (_site, { text, render }: BoundedSite) => {
    await expect(render()).resolves.toBe(text);
  });
});

/**
 * The four sites that interpolate a value this repo does not control. Each row
 * pins the template's fixed prefix and suffix, one full rendered sample, and —
 * because a constant would satisfy both of those — a SECOND sample proving the
 * interpolated value really does reach the rendered text.
 */
describe("rendered error inventory — vendor-interpolating templates", () => {
  it("stream.ts:78 renders the upstream finish_reason verbatim", async () => {
    const render = (reason: string) =>
      renderedError({ apiKey: "fake", fetch: mockFetch(sseEnvelope(finishChunk(reason)) + BARE_DONE_SSE) });

    const first = await render("content_filter");
    expect(first).toBe("Qoder generation ended with content_filter");
    expect(first.startsWith("Qoder generation ended with ")).toBe(true);

    const second = await render("insufficient_system_resource");
    expect(second).toBe("Qoder generation ended with insufficient_system_resource");
    expect(second).not.toBe(first);
  });

  it("stream.ts:495 renders status, statusText and the raw response body", async () => {
    const render = (status: number, statusText: string, body: string) =>
      renderedError({
        apiKey: "fake",
        fetch: vi.fn(async () => new Response(body, { status, statusText })) as unknown as typeof globalThis.fetch,
      });

    const first = await render(429, "Too Many Requests", "rate limited");
    expect(first).toBe("Qoder API request failed: 429 Too Many Requests. Response: rate limited");
    expect(first.startsWith("Qoder API request failed: ")).toBe(true);
    expect(first.endsWith(". Response: rate limited")).toBe(true);

    const second = await render(500, "Internal Server Error", "upstream blew up");
    expect(second).toBe("Qoder API request failed: 500 Internal Server Error. Response: upstream blew up");
    expect(second).not.toBe(first);
  });

  it("stream.ts:632 renders the envelope status and its raw body string", async () => {
    const render = (statusCodeValue: number, body: object) =>
      renderedError({ apiKey: "fake", fetch: mockFetch(sseEnvelope(body, statusCodeValue, "Not Acceptable")) });

    const first = await render(406, { code: "blocked" });
    expect(first).toBe('Upstream status 406: {"code":"blocked"}');
    expect(first.startsWith("Upstream status ")).toBe(true);

    const second = await render(503, { code: "unavailable" });
    expect(second).toBe('Upstream status 503: {"code":"unavailable"}');
    expect(second).not.toBe(first);
  });

  it("stream.ts:648 renders a string error as-is and an object error as JSON", async () => {
    const render = (inner: object) =>
      renderedError({ apiKey: "fake", fetch: mockFetch(sseEnvelope(chunk({}, inner)) + BARE_DONE_SSE) });

    const asObject = await render({ error: { message: "boom" } });
    expect(asObject).toBe('Qoder upstream error: {"message":"boom"}');
    expect(asObject.startsWith("Qoder upstream error: ")).toBe(true);

    // The `typeof error === "string"` branch: no JSON quoting around the value.
    const asString = await render({ error: "plain string failure" });
    expect(asString).toBe("Qoder upstream error: plain string failure");

    // The second trigger: code + message with no choices, where the whole
    // inner object is the error. It must NOT go through chunk() — that helper
    // adds a `choices` array, and `:646`'s second branch requires `!inner.choices`.
    const asEnvelope = await renderedError({
      apiKey: "fake",
      fetch: mockFetch(sseEnvelope({ code: "provider_error", message: "Session blocked" }) + BARE_DONE_SSE),
    });
    expect(asEnvelope).toBe('Qoder upstream error: {"code":"provider_error","message":"Session blocked"}');
  });
});

describe("rendered error inventory — sites streamQoder cannot reach", () => {
  const creds = { userID: "user", authToken: "token", name: "Test", email: "test@example.com", machineID: "machine" };
  const url = "https://api.qoder.com/chat";

  it("cosy.ts:130 renders an exact text streamQoder's userID fallback blocks", async () => {
    const message = thrownMessage(() => buildAuthHeaders(Buffer.from("{}"), url, { ...creds, userID: "" }));
    expect(message).toBe("cosy: user id is empty");
  });

  it("cosy.ts:133 renders an exact text streamQoder's credential guard blocks", async () => {
    const message = thrownMessage(() => buildAuthHeaders(Buffer.from("{}"), url, { ...creds, authToken: "" }));
    expect(message).toBe("cosy: auth token is empty");
  });

  it("keeps stream.ts:786 unreachable, so a refactor that revives it fails here", async () => {
    // Structural, not behavioural: no scenario can render this text, so the
    // invariant is pinned instead. The guard at :785 needs stopReason
    // "error"/"aborted", but every assignment upstream of it yields
    // stop/length/toolUse, and the only error/aborted assignment sits in the
    // catch this throw precedes. The repo's own coverage report agrees —
    // :785 carries `missing-if-branch`, "if path not taken".
    //
    // This reads the source ordering directly, so the row goes red the moment a
    // refactor moves that assignment above the guard and a 23rd rendered text
    // becomes host-visible.
    const source = readFileSync(new URL("../protocol/stream.ts", import.meta.url), "utf8");
    const guardAt = source.indexOf('if (output.stopReason === "error" || output.stopReason === "aborted")');
    const catchAssignmentAt = source.indexOf('output.stopReason = options?.signal?.aborted ? "aborted" : "error"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(catchAssignmentAt).toBeGreaterThan(-1);
    expect(catchAssignmentAt).toBeGreaterThan(guardAt);

    // And no scenario in the table renders it, which is the same fact observed
    // from the outside.
    for (const row of BOUNDED_SITES) {
      expect(await row.render()).not.toBe("Qoder generation failed");
    }
  });
});

describe("the buffer-overflow constant is pinned in the only form that catches a digit flip", () => {
  it("renders MAX_SSE_BUFFER_LENGTH as 8388608 inside the overflow text", async () => {
    expect(MAX_SSE_BUFFER_LENGTH).toBe(8 * 1024 * 1024);
    const row = BOUNDED_SITES.find((site) => site.site.startsWith("stream.ts:594"));
    if (!row) throw new Error("the :594 overflow row went missing from the bounded table");
    await expect(row.render()).resolves.toBe("Qoder SSE buffer exceeded 8388608 characters without a complete line");
  });

  it("keeps 8388608 out of every classifier digit pattern, which a neighbouring value would not", () => {
    // The point of pinning the rendered number: the host classifier matches bare
    // "429", "500", "502", "503", "504", "520" and "524" anywhere in the prose, so
    // a buffer cap one digit away flips this failure from final to retried.
    const verdict = (digits: string) =>
      isRetryableAssistantError(
        failedMessage(`Qoder SSE buffer exceeded ${digits} characters without a complete line`),
      );

    expect(verdict("8388608")).toBe(false);
    expect(verdict("8388500")).toBe(true); // contains "500"
    expect(verdict("4294967")).toBe(true); // contains "429"
    expect(verdict("5242880")).toBe(true); // contains "524"
  });
});

/** The minimal failed AssistantMessage the host classifier reads. */
function failedMessage(errorMessage: string, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "qoder-api" as Api,
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
    stopReason,
    timestamp: 0,
    errorMessage,
  };
}

/**
 * AC-03: which shipped texts the host retries is an executed artifact of this
 * repo, not a reading of the host's regex. Every verdict below was produced by
 * calling the real classifier imported read-only from the devDep copy of pi-ai —
 * never stubbed.
 *
 * The shape of the table is the finding: of 24 rendered texts, exactly five
 * retry. Four retry only because a bare HTTP status or the word "timeout"
 * happens to appear in the prose; the fifth — the EOF text — retries because
 * FS-5 (CU-01) aligned it to the host's purpose-built pattern "stream ended
 * before a terminal response event", which is the one intended flip here.
 */
const CLASSIFIER_VERDICTS: Array<{ text: string; retryable: boolean; note?: string }> = [
  { text: "Qoder generation ended with content_filter", retryable: false },
  { text: "Qoder request aborted", retryable: false, note: "stopReason is aborted, and the classifier requires error" },
  {
    text: "Qoder CN credentials not set. Run /login qoder-cn or set QODERCN_PERSONAL_ACCESS_TOKEN.",
    retryable: false,
  },
  { text: "Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.", retryable: false },
  { text: "Unknown Qoder model id: no-such-model", retryable: false },
  { text: "Qoder maxTokens must be a positive integer", retryable: false },
  { text: "Qoder onPayload must return a JSON object or undefined", retryable: false },
  {
    text: "Qoder API request failed: 429 Too Many Requests. Response: rate limited",
    retryable: true,
    note: 'matches "429", "too many requests" and "rate.?limit" at once',
  },
  {
    text: "Qoder API request failed: 500 Internal Server Error. Response: upstream blew up",
    retryable: true,
    note: 'matches "500", "server.?error" and "internal.?error"',
  },
  { text: "No response body", retryable: false },
  { text: "Qoder SSE buffer exceeded 8388608 characters without a complete line", retryable: false },
  { text: 'Upstream status 406: {"code":"blocked"}', retryable: false, note: "406 is in no digit pattern" },
  { text: 'Qoder upstream error: {"message":"boom"}', retryable: false },
  { text: "Malformed Qoder SSE data", retryable: false },
  {
    text: ALIGNED_EOF_TEXT,
    retryable: true,
    note: "FS-5 CU-01: contains the host pattern 'terminal response event' verbatim — the one intended flip",
  },
  {
    text: "Qoder stream ended before a terminal response event (stamp tail)",
    retryable: true,
    note: "the shared tail's no-terminal backstop — same EOF class as the row above, its exact instance pinned by stamp.test.ts",
  },
  { text: "Qoder tool call was truncated by the output token limit", retryable: false },
  { text: "Qoder finished with tool_calls but returned no tool calls", retryable: false },
  { text: "Qoder request timeout", retryable: true, note: 'matches "timeout"' },
  { text: "Qoder stream idle timeout", retryable: true, note: 'matches "timeout" and "timed? out"' },
  { text: "Incomplete Qoder tool call identity", retryable: false },
  { text: "Invalid or truncated Qoder tool call arguments", retryable: false },
  { text: "Qoder DSML buffer exceeded 8388608 characters", retryable: false },
  { text: "cosy: user id is empty", retryable: false },
  { text: "cosy: auth token is empty", retryable: false },
];

describe("host classifier verdicts, executed rather than inferred", () => {
  it.each(CLASSIFIER_VERDICTS.map((row) => [row.text, row]))(
    "classifies %s",
    (_text, { retryable }: { retryable: boolean }) => {
      expect(isRetryableAssistantError(failedMessage(_text as string))).toBe(retryable);
    },
  );

  it("retries exactly six of the shipped texts, and each is transient by nature", () => {
    const retryable = CLASSIFIER_VERDICTS.filter((row) => isRetryableAssistantError(failedMessage(row.text)));
    expect(retryable.map((row) => row.text).sort()).toEqual(
      [
        "Qoder API request failed: 429 Too Many Requests. Response: rate limited",
        "Qoder API request failed: 500 Internal Server Error. Response: upstream blew up",
        "Qoder request timeout",
        "Qoder stream idle timeout",
        ALIGNED_EOF_TEXT,
        "Qoder stream ended before a terminal response event (stamp tail)",
      ].sort(),
    );
  });

  it("returns false for a non-error stopReason even when the prose would match", () => {
    // The classifier's first gate: a message that did not fail is never retryable,
    // so the aborted row above is final regardless of its wording.
    expect(isRetryableAssistantError(failedMessage("Qoder request timeout", "aborted"))).toBe(false);
    expect(isRetryableAssistantError(failedMessage("Qoder request timeout", "stop"))).toBe(false);
  });

  it("returns false when errorMessage is absent, so a textless failure cannot retry", () => {
    const message = failedMessage("Qoder request timeout");
    delete message.errorMessage;
    expect(isRetryableAssistantError(message)).toBe(false);
  });

  it("treats a quota-shaped body inside a retryable status as final, non-retryable", () => {
    // NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN is checked first, so a 429 whose
    // body says the account is out of budget must NOT retry. Pinning the
    // precedence, not just the alternation.
    expect(
      isRetryableAssistantError(
        failedMessage("Qoder API request failed: 429 Too Many Requests. Response: out of budget"),
      ),
    ).toBe(false);
    expect(
      isRetryableAssistantError(
        failedMessage('Qoder upstream error: {"code":"insufficient_quota","message":"billing"}'),
      ),
    ).toBe(false);
  });
});

/**
 * FS-5 — the intended flip, executed end to end.
 *
 * T-01 runs the real legacy transport over a body that closes without the DONE
 * sentinel and hands the rendered text straight to the real host classifier: the
 * prose is the only thing deciding whether pi re-dispatches the turn.
 * T-03 pins that same text as an exact instance, so losing the added word turns
 * the pin red instead of silently reverting the behaviour.
 * T-02 pins that the intended flip does not widen: the four documented misses
 * stay non-retryable, so aligning one text cannot start replaying a billable
 * POST for a deterministic failure.
 */
describe("FS-5 — EOF alignment is the one intended verdict flip", () => {
  it("T-01 retries a legacy stream that ends without a terminal response event", async () => {
    const events = await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        fetch: mockFetch(sseEnvelope(chunk({ content: "hi" }))),
      }),
    );
    const error = events.find(isErrorEvent);
    if (!error) throw new Error("expected the no-sentinel dispatch to terminate with an error event");

    // The rendered string the legacy dispatch actually produces. The classifier
    // is imported read-only from the devDep pi-ai and never stubbed.
    expect(error.error.errorMessage).toBe(ALIGNED_EOF_TEXT);
    expect(isRetryableAssistantError(error.error)).toBe(true);
  });

  it("T-03 pins the rendered text exactly, so dropping the added word turns this red", async () => {
    // Rendered through the real transport and compared against the literal this
    // pin owns, so a wording drift at stream.ts:754 fails here, not only in the
    // table row above.
    const message = await renderedError({
      apiKey: "fake",
      fetch: mockFetch(sseEnvelope(chunk({ content: "hi" }))),
    });
    expect(message).toBe("Qoder stream ended before a terminal response event (unexpected EOF)");
    expect(message).toContain(HOST_EOF_PATTERN);
    // The pre-alignment wording the classifier missed: "before a terminal event"
    // is not a substring of "before a terminal response event", so its absence
    // proves the added word really is in the text.
    expect(message.includes("before a terminal event")).toBe(false);
  });

  it("T-02 keeps the four documented misses non-retryable", () => {
    const misses: Array<{ site: string; text: string }> = [
      { site: "stream.ts:745", text: "Malformed Qoder SSE data" },
      {
        site: "stream.ts:594",
        text: `Qoder SSE buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters without a complete line`,
      },
      { site: "stream.ts:499", text: "No response body" },
      { site: "stream.ts:648", text: 'Qoder upstream error: {"message":"boom"}' },
    ];
    for (const { text } of misses) {
      expect(isRetryableAssistantError(failedMessage(text))).toBe(false);
    }
    expect(isRetryableAssistantError(failedMessage(ALIGNED_EOF_TEXT))).toBe(true);
  });
});
