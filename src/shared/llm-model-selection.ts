import {
  getAnthropicDefaultReasoningEffort,
  getAnthropicReasoningEffortOptions,
} from "./anthropic-model-capabilities";
import type { LLMModelInfo, LLMProviderType, LLMReasoningEffort } from "./types";

export const LLM_REASONING_EFFORT_OPTIONS: Array<{
  value: LLMReasoningEffort;
  label: string;
}> = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
  { value: "extra_high", label: "Extra High" },
];

export function getLlmReasoningEffortOptions(
  providerType: LLMProviderType | string,
  openaiAuthMethod?: "api_key" | "oauth",
  supportedEfforts?: readonly LLMReasoningEffort[],
) {
  const options =
    providerType !== "openai" || openaiAuthMethod !== "oauth"
      ? LLM_REASONING_EFFORT_OPTIONS
      : LLM_REASONING_EFFORT_OPTIONS.map((option) =>
          option.value === "low" ? { ...option, label: "Light" } : option,
        );

  if (!supportedEfforts) return options.filter((option) => option.value !== "none");

  const supported = new Set(supportedEfforts);
  return options.filter((option) => supported.has(option.value));
}

const AZURE_REASONING_EFFORTS: LLMReasoningEffort[] = ["low", "medium", "high", "extra_high"];
const GPT_5_6_REASONING_EFFORTS: LLMReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const GPT_6_ASTRA_API_REASONING_EFFORTS: LLMReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const GPT_6_SOL_LUNA_REASONING_EFFORTS: LLMReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

type OpenAIAuthMethod = "api_key" | "oauth";

/** Providers that send Anthropic thinking/effort parameters (see anthropic-thinking.ts). */
function isAnthropicThinkingProvider(providerType: LLMProviderType | string): boolean {
  return providerType === "anthropic" || providerType === "azure-anthropic";
}

export function getLlmModelReasoningEfforts(
  providerType: LLMProviderType | string | undefined,
  modelKey: string | undefined,
  openaiAuthMethod?: OpenAIAuthMethod,
): LLMReasoningEffort[] {
  if (!providerType || !modelKey?.trim()) return [];

  if (isAnthropicThinkingProvider(providerType)) {
    return getAnthropicReasoningEffortOptions(modelKey);
  }

  if (providerType === "azure") {
    if (modelKey === "gpt-6-sol" || modelKey === "gpt-6-luna") {
      return ["none", ...GPT_6_SOL_LUNA_REASONING_EFFORTS];
    }
    return AZURE_REASONING_EFFORTS;
  }

  if (providerType === "openai") {
    const normalizedModelKey = modelKey
      .trim()
      .toLowerCase()
      .replace(/^(?:openai-codex|openai)\//, "")
      .split("@", 1)[0];
    if (normalizedModelKey === "gpt-6.1-sol") {
      return openaiAuthMethod === "oauth"
        ? [...GPT_6_SOL_LUNA_REASONING_EFFORTS, "ultra"]
        : GPT_6_SOL_LUNA_REASONING_EFFORTS;
    }
    if (normalizedModelKey === "gpt-6-astra") {
      return openaiAuthMethod === "oauth"
        ? [...GPT_5_6_REASONING_EFFORTS, "ultra"]
        : GPT_6_ASTRA_API_REASONING_EFFORTS;
    }
    if (normalizedModelKey === "gpt-6-sol" || normalizedModelKey === "gpt-6-luna") {
      return openaiAuthMethod === "oauth" && normalizedModelKey === "gpt-6-sol"
        ? [...GPT_6_SOL_LUNA_REASONING_EFFORTS, "ultra"]
        : openaiAuthMethod === "oauth"
          ? GPT_6_SOL_LUNA_REASONING_EFFORTS
          : ["none", ...GPT_6_SOL_LUNA_REASONING_EFFORTS];
    }
    if (normalizedModelKey === "gpt-5.6-sol" || normalizedModelKey === "gpt-5.6-terra") {
      return openaiAuthMethod === "oauth"
        ? [...GPT_5_6_REASONING_EFFORTS, "ultra"]
        : GPT_5_6_REASONING_EFFORTS;
    }
    if (normalizedModelKey === "gpt-5.6-luna") {
      return GPT_5_6_REASONING_EFFORTS;
    }
  }

  return [];
}

/**
 * Effort to preselect when a model is chosen and the previous selection does not
 * apply. Undefined means the caller's generic default.
 */
export function getLlmModelDefaultReasoningEffort(
  providerType: LLMProviderType | string | undefined,
  modelKey: string | undefined,
): LLMReasoningEffort | undefined {
  if (!providerType || !modelKey?.trim()) return undefined;
  if (isAnthropicThinkingProvider(providerType)) {
    return getAnthropicDefaultReasoningEffort(modelKey);
  }
  return undefined;
}

export function withLlmModelSelectionMetadata<T extends LLMModelInfo>(
  providerType: LLMProviderType | string,
  models: T[],
  openaiAuthMethod?: OpenAIAuthMethod,
): Array<T & { reasoningEfforts?: LLMReasoningEffort[] }> {
  return models.map((model) => {
    const reasoningEfforts = getLlmModelReasoningEfforts(
      providerType,
      model.key,
      openaiAuthMethod || model.openaiAuthMethod,
    );
    return reasoningEfforts.length > 0 ? { ...model, reasoningEfforts } : model;
  });
}
