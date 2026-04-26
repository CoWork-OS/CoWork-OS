import type {
  LLMModelInfo,
  LLMProviderType,
  LLMReasoningEffort,
} from "./types";

export const LLM_REASONING_EFFORT_OPTIONS: Array<{
  value: LLMReasoningEffort;
  label: string;
}> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "extra_high", label: "Extra High" },
];

const ALL_REASONING_EFFORTS = LLM_REASONING_EFFORT_OPTIONS.map(
  (option) => option.value,
);

export function getLlmModelReasoningEfforts(
  providerType: LLMProviderType | string | undefined,
  modelKey: string | undefined,
): LLMReasoningEffort[] {
  if (!providerType || !modelKey?.trim()) return [];

  // Azure deployments can be custom-named, but Azure OpenAI is the only provider
  // currently wired to send a separate request-level reasoning effort.
  if (providerType === "azure") {
    return ALL_REASONING_EFFORTS;
  }

  return [];
}

export function withLlmModelSelectionMetadata<T extends LLMModelInfo>(
  providerType: LLMProviderType | string,
  models: T[],
): Array<T & { reasoningEfforts?: LLMReasoningEffort[] }> {
  return models.map((model) => {
    const reasoningEfforts = getLlmModelReasoningEfforts(
      providerType,
      model.key,
    );
    return reasoningEfforts.length > 0
      ? { ...model, reasoningEfforts }
      : model;
  });
}
