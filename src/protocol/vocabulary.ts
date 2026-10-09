// shape: as-const enum objects — one named constant per provider-owned value,
//   each carrying the fields a reader needs to use it correctly (wire name,
//   authority rank, override rule, evidence). Trigger #5: a fixed set of named
//   constants, not a discriminated table.
//
// THE RULE FOR THIS FILE: a value belongs here when the choice is not obvious —
// Qoder's wire vocabulary for a concept, or a value the host would otherwise
// pick differently. Each member carries the evidence that established it, so a
// provider change is a one-line edit here and a future reader cannot guess.
// Plain field names with no alternative (`enable_thinking`, `reasoning_effort`,
// `temperature`) stay at their assignment site next to their evidence comment;
// the parity suite bans the two literals a future change must not resurrect —
// the instruction role and the host's own cap field name.

/**
 * Model Spec levels of authority, highest first. The spec assigns a level to
 * each *message role* and each *spec section*; `rank` is the tie-breaker when
 * two instructions conflict, and `overridableBy` says who may set the text
 * aside. Source: OpenAI Model Spec, "Instructions and levels of authority" and
 * the chain-of-command ordering (fetched 2026-10-08).
 *
 * The distinction that matters for hooks and extensions: `developer` text can
 * only be overridden by the developer, while `guideline` text can be overridden
 * *implicitly* (contextual cues, background knowledge, user history). No tag
 * and no message role creates the guideline level — it belongs to spec sections
 * only, so content inherits the level of the channel that carries it.
 */
export const AUTHORITY = {
  root: {
    rank: 1,
    overridableBy: "nothing",
    source: "Model Spec root sections",
  },
  system: {
    rank: 2,
    overridableBy: "system messages only",
    source: "Model Spec system sections and system messages",
  },
  developer: {
    rank: 3,
    overridableBy: "root, system, or the developer itself",
    source: "developer messages",
  },
  user: {
    rank: 4,
    overridableBy: "any higher level, or a later user message",
    source: "user messages",
  },
  guideline: {
    rank: 5,
    overridableBy: "implicit cues from the user or developer",
    source: "Model Spec guideline sections ONLY — never a message role",
  },
  none: {
    rank: 6,
    overridableBy: "nothing — read as data unless a higher level delegates",
    source: "assistant and tool messages, quoted or untrusted text",
  },
} as const;

/**
 * Message roles, with the authority each one carries and where pi puts it.
 *
 * HOOK AUTHORS: the level of your text comes from the channel it lands in, not
 * from a tag around it. Wrapping content in `<guideline>` inside a system
 * prompt does not make it a guideline — it is still developer-authority text the
 * user cannot override. To get guideline behaviour, deliver it where implicit
 * override is possible (the user channel), or write it in the developer channel
 * as an explicit default. Content that lands in a tool result
 * (`authority: AUTHORITY.none`) has no authority at all and may be ignored.
 *
 * Qoder specifics: the legacy body carries the instruction text as exactly one
 * leading `role: "system"` message (`prepareLegacyRequest`), and qodercli does
 * the same (`messages.unshift({ role: "system", content })` in both 1.1.63 and
 * the active 1.1.66). The gateway's own validator accepts
 * `system/assistant/user/tool/function` and rejects `developer`, so `system` is
 * the only instruction role this provider ever writes.
 */
export const WIRE_ROLE = {
  system: {
    wire: "system",
    authority: AUTHORITY.system,
    piChannel: "system prompt (pi builds it from sections and context files)",
    evidence: "qodercli 1.1.63 dN() and 1.1.66 BN(): messages.unshift({role:'system',...})",
  },
  user: {
    wire: "user",
    authority: AUTHORITY.user,
    piChannel: "user message",
  },
  assistant: {
    wire: "assistant",
    authority: AUTHORITY.none,
    piChannel: "assistant message",
  },
  tool: {
    wire: "tool",
    authority: AUTHORITY.none,
    piChannel: "tool result",
    evidence: "no authority unless a higher level delegates to it",
  },
} as const;

/**
 * Groups of the `/model/list` response. Each group is a *scene*: qodercli keys
 * them all by name (`parseModelList`) and then reads the account's configured
 * scene (`r$(t) = t.isServiceAccount() ? "service_account" : settings.scene`).
 *
 * `chat` is what this extension reads. Today it is byte-identical in key set and
 * order to `assistant`, `quest` and `qwake`, and equal in set to `app` (order
 * differs), so the choice is equivalent for the 15 live models; the enum exists
 * so a future divergence is a one-line edit instead of a guess.
 */
export const SCENE = {
  chat: { group: "chat", note: "read by this extension; matches qodercli --list-models order" },
  assistant: { group: "assistant", note: "identical set and order to chat (2026-10-08)" },
  inline: { group: "inline", note: "inline-completion surface, 4 models" },
  quest: { group: "quest", note: "adds quest-prefixed keys" },
  nap: { group: "nap", note: "1 model (nap-auto)" },
  qwork: { group: "qwork", note: "adds qwork-prefixed keys, 7 models" },
  experts: { group: "experts", note: "adds experts-prefixed keys and minimal_version gates" },
  qwake: { group: "qwake", note: "identical set and order to chat (2026-10-08)" },
  app: { group: "app", note: "same set as chat, different order" },
  byokTeams: { group: "byok_teams", note: "user BYOK models, UUID keys" },
  byokEnterprise: { group: "byok_enterprise", note: "enterprise BYOK scene (qodercli's `fl`)" },
  serviceAccount: { group: "service_account", note: "scene qodercli reads for service accounts (its `lr`)" },
} as const;

/**
 * Transport routing, derived from the catalog entry's own fields instead of a
 * hand-maintained key list. qodercli classifies every model this way
 * (`function r2(t,r,o,i)` in 1.1.63, `Yj` in 1.1.66):
 *   server_byok  when a custom-model override is present, or `server_scene`
 *                equals `byok_enterprise`, or `source` is `user`;
 *   direct_byok  when `source` is `custom`;
 *   qoder        otherwise.
 *
 * Verified 2026-10-08: all 15 live `chat` entries carry `source: "system"`, so
 * every one of them routes legacy — and qodercli, with
 * `QODER_MODEL_SERVER_HOST` pointed at a dead port, still answered normally,
 * which proves it never sends a Qoder-hosted model to the model server. The
 * model server (`api2-v2.qoder.sh/model/v1/chat/completions`) is the BYOK
 * relay; we keep that path for `user` models and default everything else to
 * legacy. `QODER_PROTOCOL=v2` remains the per-run override for A/B work.
 */
export const MODEL_ORIGIN = {
  system: { source: "system", target: "qoder", transport: "legacy" },
  user: { source: "user", target: "server_byok", transport: "v2" },
  custom: { source: "custom", target: "direct_byok", transport: "unsupported" },
} as const;

/** qodercli `--thinking` modes. `auto`/`adaptive` send no explicit effort. */
export const THINKING_MODE = {
  auto: "auto",
  adaptive: "adaptive",
  enabled: "enabled",
  disabled: "disabled",
} as const;

/**
 * `reasoning_effort` values. Qoder advertises a subset per model through
 * `thinking_config.enabled.efforts`, whose keys are already pi level names, so
 * the map is identity where present and `null` (hidden in the picker) where
 * absent. `none` is what qodercli sends alongside `enable_thinking: false`.
 */
export const EFFORT = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

/**
 * Which key carries the output cap. Both of qodercli's bodies use `max_tokens`
 * (`parameters.max_tokens` on the legacy path, the same name in its model-server
 * body); `max_completion_tokens` appears only for custom/BYOK provider
 * descriptors, whose own default is `"max_tokens"`. The host would otherwise
 * choose `max_completion_tokens` for a non-standard provider, so we pin it.
 */
export const MAX_TOKENS_FIELD = {
  maxTokens: "max_tokens",
  maxCompletionTokens: "max_completion_tokens",
} as const;
