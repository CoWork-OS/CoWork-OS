import { modelIdCandidates } from "./model-metadata";
import type { LLMReasoningEffort } from "./types";

/**
 * Thinking and effort capabilities of Anthropic models, keyed by model family.
 *
 * - `adaptive`: the model takes `thinking: {type: "adaptive"}` (Opus/Sonnet 4.6 and
 *   later, Fable, Mythos). `budget_tokens` is deprecated or rejected there.
 * - `budget`: the model takes `thinking: {type: "enabled", budget_tokens}` (Claude 4
 *   models before 4.6, including Haiku 4.5).
 * - `none`: no extended thinking.
 *
 * `adaptiveDefaultOn` says whether the model thinks when the request omits
 * `thinking`. Opus 4.6-4.8 and Sonnet 4.6 do not, so adaptive thinking must be
 * sent explicitly. Some always-thinking models reject `{type: "disabled"}`, so
 * callers never send it: they omit `thinking` and lower the effort instead.
 */
export type AnthropicThinkingMode = "adaptive" | "budget" | "none";
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicModelCapabilities {
  family: string;
  thinkingMode: AnthropicThinkingMode;
  adaptiveDefaultOn: boolean;
  /** Values accepted by `output_config.effort`; empty when the model rejects effort. */
  efforts: readonly AnthropicEffort[];
  /** Effort the API applies when `output_config.effort` is omitted. */
  defaultEffort?: AnthropicEffort;
  /** temperature/top_p/top_k return 400 (they are never valid together with thinking). */
  rejectsSampling: boolean;
  /** tool_choice `any`/`tool` returns 400; send `auto`. */
  rejectsForcedToolChoice: boolean;
  maxOutputTokens: number;
}

export const ANTHROPIC_EFFORT_ORDER: readonly AnthropicEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const ALL_EFFORTS = ANTHROPIC_EFFORT_ORDER;
const EFFORTS_WITHOUT_XHIGH: readonly AnthropicEffort[] = ["low", "medium", "high", "max"];
/** Levels offered for budget-mode models; they only size `budget_tokens` there. */
export const BUDGET_EFFORT_LEVELS: readonly AnthropicEffort[] = ["low", "medium", "high"];

type CapabilityRow = Omit<AnthropicModelCapabilities, "family">;

const ALWAYS_THINKING: CapabilityRow = {
  thinkingMode: "adaptive",
  adaptiveDefaultOn: true,
  efforts: ALL_EFFORTS,
  defaultEffort: "high",
  rejectsSampling: true,
  rejectsForcedToolChoice: true,
  maxOutputTokens: 128_000,
};

const OPUS_4_7_LINE: CapabilityRow = {
  thinkingMode: "adaptive",
  adaptiveDefaultOn: false,
  efforts: ALL_EFFORTS,
  defaultEffort: "high",
  rejectsSampling: true,
  rejectsForcedToolChoice: false,
  maxOutputTokens: 128_000,
};

const ADAPTIVE_4_6: CapabilityRow = {
  thinkingMode: "adaptive",
  adaptiveDefaultOn: false,
  efforts: EFFORTS_WITHOUT_XHIGH,
  defaultEffort: "high",
  rejectsSampling: false,
  rejectsForcedToolChoice: false,
  maxOutputTokens: 128_000,
};

function budgetRow(maxOutputTokens: number, efforts: readonly AnthropicEffort[] = []) {
  return {
    thinkingMode: "budget",
    adaptiveDefaultOn: false,
    efforts,
    ...(efforts.length > 0 ? { defaultEffort: "high" as const } : {}),
    rejectsSampling: false,
    rejectsForcedToolChoice: false,
    maxOutputTokens,
  } satisfies CapabilityRow;
}

const FAMILY_CAPABILITIES: Record<string, CapabilityRow> = {
  "fable-5-1": ALWAYS_THINKING,
  "mythos-5-1": ALWAYS_THINKING,
  // Fable 5 still accepts forced tool_choice; thinking makes it moot (only auto is sent).
  "fable-5": { ...ALWAYS_THINKING, rejectsForcedToolChoice: false },
  "mythos-5": { ...ALWAYS_THINKING, rejectsForcedToolChoice: false },
  "mythos-preview": { ...ALWAYS_THINKING, rejectsForcedToolChoice: false },
  "opus-5-5": { ...ALWAYS_THINKING, defaultEffort: "medium" },
  "opus-5": { ...ALWAYS_THINKING, rejectsForcedToolChoice: false },
  "sonnet-5-5": ALWAYS_THINKING,
  "sonnet-5": { ...ALWAYS_THINKING, rejectsForcedToolChoice: false },
  "opus-4-8": OPUS_4_7_LINE,
  "opus-4-7": OPUS_4_7_LINE,
  "opus-4-6": ADAPTIVE_4_6,
  "sonnet-4-6": ADAPTIVE_4_6,
  "opus-4-5": budgetRow(64_000, ["low", "medium", "high"]),
  "sonnet-4-5": budgetRow(64_000),
  "haiku-4-5": budgetRow(64_000),
  "opus-4-1": budgetRow(32_000),
  "opus-4": budgetRow(32_000),
  "opus-4-0": budgetRow(32_000),
  "sonnet-4": budgetRow(64_000),
  "sonnet-4-0": budgetRow(64_000),
};

const CLAUDE_FAMILY = /^(?:claude-)?((?:opus|sonnet|haiku|fable|mythos)-[a-z0-9-]+?)(?:-\d{8})?$/;
// Later generations (e.g. a future "opus-6") get the conservative 5.x behaviour.
const FUTURE_GENERATION = /^(?:opus|sonnet|fable|mythos)-(?:[5-9]|[1-9]\d)(?:-\d+)?$/;

/** Anthropic thinking/effort capabilities for a model id, or null for unknown models. */
export function getAnthropicModelCapabilities(
  modelId: string | undefined | null,
): AnthropicModelCapabilities | null {
  let futureFamily: string | null = null;
  for (const candidate of modelIdCandidates(String(modelId || ""))) {
    const family = CLAUDE_FAMILY.exec(candidate)?.[1];
    if (!family) continue;
    const row = FAMILY_CAPABILITIES[family];
    if (row) return { family, ...row };
    if (!futureFamily && FUTURE_GENERATION.test(family)) futureFamily = family;
  }
  return futureFamily ? { family: futureFamily, ...ALWAYS_THINKING } : null;
}

/**
 * Map a saved reasoning effort to a level the model accepts: provider-specific
 * aliases ("ultra", "extra_high") become "max", and unsupported levels clamp
 * down to the highest supported level below them. Returns undefined for "none",
 * an unset effort, or a model without effort support.
 */
export function clampAnthropicEffort(
  capabilities: AnthropicModelCapabilities,
  requested: LLMReasoningEffort | string | undefined | null,
): AnthropicEffort | undefined {
  const supported = capabilities.efforts;
  if (supported.length === 0 || !requested) return undefined;
  const normalized = String(requested).trim().toLowerCase();
  const aliased =
    normalized === "ultra" || normalized === "extra_high"
      ? "max"
      : normalized === "minimal"
        ? "low"
        : normalized;
  const rank = ANTHROPIC_EFFORT_ORDER.indexOf(aliased as AnthropicEffort);
  if (rank < 0) return undefined;
  for (let index = rank; index >= 0; index -= 1) {
    const level = ANTHROPIC_EFFORT_ORDER[index];
    if (supported.includes(level)) return level;
  }
  return supported[0];
}

/**
 * Effort levels the model selector offers for an Anthropic model. "none" turns
 * thinking off where the model allows it (explicit-adaptive and budget models);
 * budget models derive their thinking budget from the chosen level.
 */
export function getAnthropicReasoningEffortOptions(
  modelId: string | undefined | null,
): LLMReasoningEffort[] {
  const capabilities = getAnthropicModelCapabilities(modelId);
  if (!capabilities || capabilities.thinkingMode === "none") return [];
  if (capabilities.thinkingMode === "budget") {
    const levels: readonly AnthropicEffort[] =
      capabilities.efforts.length > 0 ? capabilities.efforts : BUDGET_EFFORT_LEVELS;
    return ["none", ...levels];
  }
  return capabilities.adaptiveDefaultOn
    ? [...capabilities.efforts]
    : ["none", ...capabilities.efforts];
}

/** Effort the selector preselects for an Anthropic model (the API default, or off for budget models). */
export function getAnthropicDefaultReasoningEffort(
  modelId: string | undefined | null,
): LLMReasoningEffort | undefined {
  const capabilities = getAnthropicModelCapabilities(modelId);
  if (!capabilities || capabilities.thinkingMode === "none") return undefined;
  if (capabilities.thinkingMode === "budget") return "none";
  return capabilities.defaultEffort;
}
