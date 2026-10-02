// shape: none — dispatch object does not apply: straight-line build (derive
//   model → wrap options → delegate → forward events) with a single
//   first-event self-heal branch, not a discriminator table.
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type TranscriptContext,
  withoutInitialSystemMessage,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { QoderModelEntry } from "../catalog.js";
import { debugLog } from "../debug.js";
import { createDebugFetch } from "../debug-log.js";
import { type RateSource, rateForUpstreamKey } from "../pricing.js";
import type { QoderMode } from "../region.js";
import { PROCESS_FALLBACK_SESSION_ID, planQoderTurn, type TurnPlan, type TurnPlanSeed } from "./plan.js";
import { markLegacyOnly } from "./routing.js";
import { classifyTurnKind, type QoderRunMessage, resolveRunIdentity } from "./run-identity.js";
import { createReframedFetch } from "./sse-reframe.js";
import { MAX_PROMPT_CACHE_KEY_LENGTH, streamQoder } from "./stream.js";
import { contentToText } from "./transform.js";

interface V2Route {
  mode: QoderMode;
  modelConfig: QoderModelEntry;
  upstreamKey: string;
  /** The router's plan seed when QODER_CORE_PLAN is on; absent means the pre-migration inline path. */
  plan?: TurnPlanSeed;
}

function envValue(options: SimpleStreamOptions | undefined, name: string): string | undefined {
  return options?.env?.[name] ?? process.env[name];
}

function v2BaseUrl(route: V2Route, options?: SimpleStreamOptions): string {
  // pi-ai's OpenAI client appends `/chat/completions` to this base.
  return (
    envValue(options, "QODER_MODEL_SERVER_HOST") ?? (route.mode === "cn" ? "" : "https://api2-v2.qoder.sh/model/v1")
  );
}

// PRD §8.2 outbound allowlist: dispatch only to *.qoder.sh, or to the explicit
// QODER_MODEL_SERVER_HOST value. Anything else errors before dispatch.
function isAllowedV2Host(baseUrl: string, options?: SimpleStreamOptions): boolean {
  const override = envValue(options, "QODER_MODEL_SERVER_HOST");
  if (override) return baseUrl === override;
  try {
    const host = new URL(baseUrl).hostname;
    return host === "api2-v2.qoder.sh" || host.endsWith(".qoder.sh");
  } catch {
    return false;
  }
}

// Process-stable fallback for hosts that never pass options.sessionId lives in
// plan.ts (PROCESS_FALLBACK_SESSION_ID): identity resolution is legacy-local by
// design, so both protocols share that one process value (OD-6).

/**
 * The current user prompt's text, for the run display name. v2 omits the
 * `business` object (see injectQoderFields), so this value never reaches the
 * wire — it only fills the slot the shared registry records.
 */
function lastUserTextOf(messages: readonly QoderRunMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return contentToText(messages[i].content);
  }
  return "";
}

function osType(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

// shape: none — dispatch object does not apply: a single length guard on one value.
// Truncation (not hashing) mirrors pi-ai's clampOpenAIPromptCacheKey; this is
// the same 64-character prompt_cache_key bound the legacy path enforces in stream.ts.
// Exported so the plan's producer applies the identical bound.
export function clampPromptCacheKey(id: string): string {
  return id.length <= MAX_PROMPT_CACHE_KEY_LENGTH ? id : id.slice(0, MAX_PROMPT_CACHE_KEY_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Effective `context_length` for one request. The model's window as pi resolved
 * it — `models.json` `provider.modelOverrides.<modelId>.contextWindow` included —
 * wins when it matches one of the catalog's available windows; otherwise the
 * catalog's `is_default` tier (Qoder's own default). No largest-tier fallback:
 * an unmatched window omits the field and the server default governs (owner
 * direction 2026-09-29 — a hidden max can spend more than the user intended).
 * Mirrors qodercli's window validation (its `$6`/`Gf` helpers, decoded
 * 2026-09-29: an invalid selection falls back to the default window).
 */
function resolveContextLength(
  contextConfig: QoderModelEntry["context_config"],
  requested: number | undefined,
): number | undefined {
  if (requested === undefined) return undefined;
  const tiers = Object.values(contextConfig ?? {});
  const windows = tiers
    .map((tier) => tier?.token_count)
    .filter((count): count is number => typeof count === "number" && Number.isFinite(count));
  if (windows.length === 0 || windows.includes(requested)) return requested;
  const fallback = tiers.find((tier) => tier?.is_default)?.token_count;
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : undefined;
}

/**
 * The Qoder field injector. Runs inside pi-ai's onPayload (which replaces the
 * body with a non-undefined return), then CHAINS pi's own hook — replacing it
 * without calling it would silence before_provider_request for every other
 * extension.
 */
function injectQoderFields(
  body: Record<string, unknown>,
  route: V2Route,
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  messages: readonly QoderRunMessage[],
  plan: TurnPlan | undefined,
): void {
  // metadata.context — required envelope; session_id keys prompt caching.
  // qodercli's bundled JS (decoded 2026-09-29) additionally sends
  // request_set_id (run-scoped, resolved by the shared run-identity module),
  // source_session_id, and context_length INSIDE this metadata object
  // (string-valued); the top-level context_length number alone proved
  // ineffective against the ~60K-token wall, so the envelope is mirrored here.
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  // One producer for the session value: the plan's v2 wire form when the gate
  // is on, the same expression inline when it is off (identical by construction).
  const sessionId = plan?.wireSession.v2.envelopeAndHeaders ?? options?.sessionId ?? PROCESS_FALLBACK_SESSION_ID;
  const tier = resolveContextLength(route.modelConfig.context_config, model.contextWindow);
  const { requestSetId } = resolveRunIdentity({
    mode: route.mode,
    upstreamKey: route.upstreamKey,
    wireSessionId: plan?.capture.wireSessionId ?? sessionId,
    messages,
    lastUserText: lastUserTextOf(messages),
    product: "cli",
    turnKind: plan?.turnKind ?? classifyTurnKind(options?.maxTokens),
  });
  body.metadata = {
    ...metadata,
    context: {
      request_id: crypto.randomUUID(),
      request_set_id: requestSetId,
      session_id: sessionId,
      source_session_id: sessionId,
      os_type: osType(),
      task_id: "common",
      client_type: "5",
      ...(tier !== undefined ? { context_length: String(tier) } : {}),
    },
  };
  // Explicit-send set (owner direction 2026-09-25; probes are acceptance
  // checks, server default is never trusted silently).
  body.enable_thinking = resolveReasoningLevel(model, plan?.thinkingInputs.level ?? options?.reasoning) !== undefined;
  if (tier !== undefined) body.context_length = tier;
  body.preserve_thinking = true;
  body.parallel_tool_calls = true;
  // qodercli carries top_k inside `extras`, not top-level (decoded 2026-09-29);
  // pi-ai assigns samplingParams top-level, so mirror its placement when set.
  if (typeof body.top_k === "number") {
    body.extras = { ...(isRecord(body.extras) ? body.extras : {}), top_k: body.top_k };
  }
  // `business` (account-scoped id) and `custom_model` (user-defined models) are
  // sent by qodercli only when its runtime holds them; both stay omitted here
  // rather than synthesized — this extension never receives those values.
  // pi-ai sends prompt_cache_key only for api.openai.com or long retention
  // (openai-completions buildParams), so the OpenAI-convention affinity key is
  // absent from v2 requests unless added here. qodercli sets the same field
  // from its session id in its OpenAI-protocol requests, and the server already
  // receives this exact identity as metadata.context.session_id.
  if (options?.cacheRetention === "none") body.skipCacheWrite = true;
  else body.prompt_cache_key = plan?.wireSession.v2.promptCacheKey ?? clampPromptCacheKey(sessionId);
}

function resolveReasoningLevel(model: Model<Api>, requestedLevel: ThinkingLevel | undefined): string | undefined {
  if (!requestedLevel) return undefined;
  // Same rule as the legacy path (stream.ts): clamp through pi-ai's model-aware
  // helper; "off" (or an unsupported model) disables, anything else enables.
  const clamped = clampThinkingLevel(model, requestedLevel);
  return clamped === "off" ? undefined : clamped;
}

function isInvalidModelErrorEvent(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "error") return false;
  const error = isRecord(event.error) ? event.error : undefined;
  const message = typeof error?.errorMessage === "string" ? error.errorMessage : "";
  // pi-ai formats provider errors as "<status>: <body>". The prefix must be
  // exactly 400 (eligibility), never 401 (auth): a bad token and a bad model
  // key look identical on v2, and retrying legacy on an auth fault would
  // double-spend quota.
  return /^400\D/.test(message) && message.includes("invalid_model_error");
}

function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: output });
  stream.end();
  return stream;
}

type V2QoderUsage = AssistantMessage["usage"] & { rateSource?: RateSource };

/** Stamp the pricing source on a terminal event's message; the cost fields stay pi-ai's. */
function stampRateSource(event: AssistantMessageEvent, rateSource: RateSource): void {
  const message = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
  if (message) (message.usage as V2QoderUsage).rateSource = rateSource;
}

/**
 * Pass-through wrapper that stamps `rateSource` on the terminal message without
 * touching pi-ai's computed cost. Every event is otherwise forwarded unchanged.
 */
function withRateSourceStamp(inner: AssistantMessageEventStream, rateSource: RateSource): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) {
      stampRateSource(event, rateSource);
      out.push(event);
    }
    out.end();
  })().catch((error: unknown) => {
    debugLog(`provider.v2 rate-source stamp failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      out.end();
    } catch {}
  });
  return out;
}

/**
 * v2 transport: delegate the turn to pi-ai's OpenAI Completions implementation
 * so pi contract correctness is inherited on every upgrade, with the Qoder
 * field injector in front and the stale-table self-heal behind.
 */
export function streamQoderV2(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  route: V2Route,
): AssistantMessageEventStream {
  const baseUrl = v2BaseUrl(route, options);
  if (!baseUrl || !isAllowedV2Host(baseUrl, options)) {
    return errorStream(model, `Qoder v2 host rejected by the outbound allowlist: ${baseUrl || "(empty)"}`);
  }
  if (!options?.apiKey) {
    return errorStream(model, "Qoder credentials not set (protocol=v2): no access token available for this request");
  }

  const v2Model: Model<Api> = {
    ...model,
    id: route.upstreamKey,
    baseUrl,
    api: "openai-completions" as Api,
    compat: {
      ...(model.compat as Record<string, unknown> | undefined),
      thinkingTokenBudgetField: "reasoning_budget_tokens",
      supportsLongCacheRetention: false,
      // Replica affinity for prompt-cache routing: pi-ai then sends
      // session_id / x-client-request-id / x-session-affinity from sessionId,
      // matching the OpenAI-protocol convention qodercli follows.
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openai",
    } as Model<Api>["compat"],
  };

  const callerOnPayload = options?.onPayload;
  const wrappedOnPayload = async (payload: unknown, selected: Model<Api>): Promise<unknown> => {
    const body = isRecord(payload) ? payload : {};
    // The raw transcript view, matching the legacy transport's input. Both
    // adapters read the same view so one predicate serves both protocols.
    const messages = withoutInitialSystemMessage(context.messages);
    // One plan per v2 dispatch: no identity lookup happens on this protocol.
    const plan = route.plan ? await planQoderTurn(model, context, options, route.plan) : undefined;
    injectQoderFields(body, route, v2Model, options, messages, plan);
    if (callerOnPayload) {
      const next = await callerOnPayload(body, selected);
      return next !== undefined ? next : body;
    }
    return body;
  };

  // The gateway intermittently splits event JSON across lines (recorded
  // 2026-09-28); repair the framing before the SDK's strict SSE parser sees it.
  // Debug capture wraps the base fetch INSIDE the reframe wrapper: the capture
  // tees raw server bytes, and reframe still repairs the framing downstream.
  const syncSession = options?.sessionId ?? PROCESS_FALLBACK_SESSION_ID;
  const inner = openAICompletionsApi().streamSimple(v2Model, context, {
    ...options,
    fetch: createReframedFetch(
      createDebugFetch(options?.fetch ?? globalThis.fetch, {
        protocol: "v2",
        session: options?.sessionId,
        model: model.id,
        upstreamKey: route.upstreamKey,
        // The value that actually went on the wire: metadata.context.session_id.
        wireSessionId: route.plan?.wireSessionV2.envelopeAndHeaders ?? syncSession,
      }),
    ),
    onPayload: wrappedOnPayload,
  });

  const fallbackEnabled = envValue(options, "QODER_FALLBACK") === "1";
  // pi-ai priced the turn from the registered rates; stamp where those rates
  // came from without touching the cost fields. A legacy self-heal forwards its
  // own events, whose cost stream.ts already stamped at its assembly site.
  const rateSource: RateSource = rateForUpstreamKey(route.upstreamKey) ? "rate-table" : "fallback";
  if (!fallbackEnabled) return withRateSourceStamp(inner, rateSource);

  // Self-heal (opt-in): on a pre-start 400 invalid_model_error, the routing
  // row is wrong — retry exactly once on legacy with the UNWRAPPED options and
  // cache the correction for the session.
  const out = createAssistantMessageEventStream();
  void (async () => {
    let firstEvent = true;
    for await (const event of inner) {
      if (firstEvent) {
        firstEvent = false;
        if (isInvalidModelErrorEvent(event)) {
          markLegacyOnly(route.upstreamKey);
          debugLog(`provider.fallback model_key=${route.upstreamKey} from=v2 to=legacy`);
          const legacyStream = streamQoder(model, context, options, route.plan);
          for await (const legacyEvent of legacyStream) out.push(legacyEvent);
          out.end();
          return;
        }
      }
      stampRateSource(event, rateSource);
      out.push(event);
    }
    out.end();
  })().catch((error: unknown) => {
    debugLog(`provider.fallback wrapper failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      out.end();
    } catch {}
  });
  return out;
}
