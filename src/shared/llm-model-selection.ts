import type { LLMModelInfo, LLMProviderType, LLMReasoningEffort } from "./types";

export const LLM_REASONING_EFFORT_OPTIONS: Array<{
  value: LLMReasoningEffort;
  label: string;
}> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
  { value: "extra_high", label: "Extra High" },
];

const AZURE_REASONING_EFFORTS: LLMReasoningEffort[] = ["low", "medium", "high", "extra_high"];
const GPT_5_6_REASONING_EFFORTS: LLMReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function getLlmModelReasoningEfforts(
  providerType: LLMProviderType | string | undefined,
  modelKey: string | undefined,
): LLMReasoningEffort[] {
  if (!providerType || !modelKey?.trim()) return [];

  if (providerType === "azure") {
    return AZURE_REASONING_EFFORTS;
  }

  if (providerType === "openai") {
    const normalizedModelKey = modelKey
      .trim()
      .replace(/^(?:openai-codex|openai)\//, "")
      .split("@", 1)[0];
    if (normalizedModelKey === "gpt-5.6-sol" || normalizedModelKey === "gpt-5.6-terra") {
      return [...GPT_5_6_REASONING_EFFORTS, "ultra"];
    }
    if (normalizedModelKey === "gpt-5.6-luna") {
      return GPT_5_6_REASONING_EFFORTS;
    }
  }

  return [];
}

export function withLlmModelSelectionMetadata<T extends LLMModelInfo>(
  providerType: LLMProviderType | string,
  models: T[],
): Array<T & { reasoningEfforts?: LLMReasoningEffort[] }> {
  return models.map((model) => {
    const reasoningEfforts = getLlmModelReasoningEfforts(providerType, model.key);
    return reasoningEfforts.length > 0 ? { ...model, reasoningEfforts } : model;
  });
}
