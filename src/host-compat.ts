/**
 * Host compatibility layer.
 *
 * pi 0.86+ normalizes the request context into a TranscriptContext: the system
 * prompt and tool declarations are folded into the transcript's leading system
 * message and read back with pi-ai's transcript helpers
 * (`getCurrentSystemMessage` / `getSystemMessageText` /
 * `withoutInitialSystemMessage`). Some hosts that embed pi-ai (notably OMP)
 * ship a fork from before those helpers existed and still pass the legacy
 * Context shape — `systemPrompt` (string or string[]) and `tools` alongside a
 * message list that carries no leading system message.
 *
 * This module bridges both worlds:
 *
 *   - The transcript helpers are ported locally and used only when the host
 *     module does not export them, so a host with the real helpers keeps its
 *     live implementation.
 *   - `resolveSystemAndTools` reads the current prompt and tool set from
 *     whichever context shape arrived.
 *   - `hyperlink` and `openAICompletionsApi` fill the remaining host gaps.
 *
 * Keep the local ports behaviorally identical to pi-ai's implementations; the
 * transcript helpers are pure functions over the message list.
 */

import type {
  Api,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  SystemMessage,
  Tool,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import * as hostAi from "@earendil-works/pi-ai";
import * as hostPiCompat from "@earendil-works/pi-ai/compat";
import * as hostTui from "@earendil-works/pi-tui";

// The host module may predate any of the compatibility exports below; read them
// as unknowns through these views so a missing export degrades to the local
// port instead of failing the static import that fetched them.
const hostTranscriptHelpers: {
  getCurrentSystemMessage?: unknown;
  getSystemMessageText?: unknown;
  withoutInitialSystemMessage?: unknown;
} = hostAi;
const hostTuiExports: { hyperlink?: unknown } = hostTui;
const hostCompatExports: { openAICompletionsApi?: unknown } = hostPiCompat;
// pi's types declare no root `streamSimple` (the compat module hosts it), but
// OMP exports it at the package root — read it structurally.
const hostAiExports = hostAi as unknown as { streamSimple?: unknown };

/** Prefer a host-provided function; fall back when the host predates it. */
function hostFunction<T>(candidate: unknown, fallback: T): T {
  return typeof candidate === "function" ? (candidate as T) : fallback;
}

/* ── Transcript helpers (pi-ai ≥0.86), with local fallbacks ──────────── */

function isSystemMessage(message: unknown): message is SystemMessage {
  if (typeof message !== "object" || message === null || !("role" in message)) return false;
  return message.role === "system";
}

/** Flatten a system message's content (string or text blocks) into one string. */
function contentText(content: SystemMessage["content"], separator = "\n"): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join(separator);
}

/** Replay toolsAdded/toolsRemoved deltas into the tool set currently in force. */
function getCurrentToolsFallback(messages: readonly Message[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

/** Local port of pi-ai's `getCurrentSystemMessage`. */
export function fallbackGetCurrentSystemMessage(messages: readonly Message[]): SystemMessage | undefined {
  const content: string[] = [];
  const sections = new Map<string, string>();
  let timestamp: number | undefined;
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    timestamp ??= message.timestamp;
    const text = contentText(message.content);
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  const tools = getCurrentToolsFallback(messages);
  if (timestamp === undefined && tools.length === 0) return undefined;
  return {
    role: "system",
    content: content.join("\n\n"),
    ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
    ...(tools.length > 0 ? { toolsAdded: tools } : {}),
    timestamp: timestamp ?? 0,
  };
}

/** Local port of pi-ai's `getSystemMessageText`. */
export function fallbackGetSystemMessageText(message: SystemMessage): string {
  const parts = [contentText(message.content)];
  for (const text of Object.values(message.sections ?? {})) {
    if (text !== null) parts.push(text);
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/** Local port of pi-ai's `withoutInitialSystemMessage`. */
export function fallbackWithoutInitialSystemMessage(messages: Message[]): Message[] {
  return isSystemMessage(messages[0]) ? messages.slice(1) : messages;
}

/** pi-ai's live helper when the host exports it, else the local port. */
export const getCurrentSystemMessage = hostFunction<typeof fallbackGetCurrentSystemMessage>(
  hostTranscriptHelpers.getCurrentSystemMessage,
  fallbackGetCurrentSystemMessage,
);

/** pi-ai's live helper when the host exports it, else the local port. */
export const getSystemMessageText = hostFunction<typeof fallbackGetSystemMessageText>(
  hostTranscriptHelpers.getSystemMessageText,
  fallbackGetSystemMessageText,
);

/** pi-ai's live helper when the host exports it, else the local port. */
export const withoutInitialSystemMessage = hostFunction<typeof fallbackWithoutInitialSystemMessage>(
  hostTranscriptHelpers.withoutInitialSystemMessage,
  fallbackWithoutInitialSystemMessage,
);

/* ── System prompt + tool extraction across context shapes ───────────── */

/** The subset of either context shape this extension reads. */
export interface RequestContextLike {
  messages?: readonly Message[];
  /** Legacy Context (pi <0.86, OMP): the system prompt outside the message list. */
  systemPrompt?: string | readonly string[];
  /** Legacy Context: tool declarations outside the message list. */
  tools?: readonly Tool[];
}

function normalizeSystemPromptText(value: string | readonly string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      if (typeof part === "string" && part.trim().length > 0) parts.push(part);
    }
    return parts.join("\n\n");
  }
  return "";
}

/**
 * Resolve the current system prompt text and tool set from either context
 * shape: a normalized TranscriptContext (prompt and tools folded into the
 * message list) or the legacy Context with top-level `systemPrompt`/`tools`.
 */
export function resolveSystemAndTools(context: RequestContextLike): { systemText: string; tools: Tool[] } {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const current = getCurrentSystemMessage(messages);
  if (current) {
    return {
      systemText: getSystemMessageText(current),
      tools: current.toolsAdded ? [...current.toolsAdded] : [],
    };
  }
  const tools: Tool[] = Array.isArray(context.tools) ? [...context.tools] : [];
  return { systemText: normalizeSystemPromptText(context.systemPrompt), tools };
}

/* ── Terminal hyperlinks ─────────────────────────────────────────────── */

/** Local port of pi-tui's `hyperlink` (OSC 8 with an ST terminator). */
export function fallbackHyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** pi-tui's live helper when the host exports it, else the local port. */
export const hyperlink = hostFunction<typeof fallbackHyperlink>(hostTuiExports.hyperlink, fallbackHyperlink);

/* ── OpenAI-completions API factory ─────────────────────────────────── */

/** The subset of pi-ai/compat's API object this extension calls. */
export interface OpenAICompletionsCompatApi {
  streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
}

// pi-ai's root `streamSimple` dispatches on `model.api`; the declared signature
// here mirrors pi's TranscriptContext contract while runtime context comes from
// whichever host invoked us (pi: normalized transcript, OMP: legacy Context).
type HostStreamSimple = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * The host's OpenAI-completions API factory. When the host predates the
 * `pi-ai/compat` export (OMP ships `streamSimple` at the package root
 * instead), route through the host's root `streamSimple` — the same dispatch
 * the compat factory wraps (the caller's model pins `api: "openai-completions"`,
 * so the built-in implementation is selected).
 */
export function openAICompletionsApi(): OpenAICompletionsCompatApi {
  const makeApi = hostFunction<(() => OpenAICompletionsCompatApi) | undefined>(
    hostCompatExports.openAICompletionsApi,
    undefined,
  );
  if (makeApi) return makeApi();
  const hostStream = hostFunction<HostStreamSimple | undefined>(hostAiExports.streamSimple, undefined);
  if (hostStream) {
    return { streamSimple: (model, context, options) => hostStream(model, context, options) };
  }
  throw new Error("Host provides neither pi-ai/compat's openAICompletionsApi nor a root streamSimple");
}
