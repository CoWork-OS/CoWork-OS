import { describe, expect, it } from "vitest";

import {
  getLlmModelReasoningEfforts,
  withLlmModelSelectionMetadata,
} from "../llm-model-selection";

describe("llm model selection metadata", () => {
  it("declares Intelligence controls only for providers with request-level effort support", () => {
    expect(getLlmModelReasoningEfforts("azure", "deployment-a")).toEqual([
      "low",
      "medium",
      "high",
      "extra_high",
    ]);
    expect(getLlmModelReasoningEfforts("openai", "gpt-5.4")).toEqual([]);
    expect(getLlmModelReasoningEfforts("xai", "grok-4-fast-reasoning")).toEqual([]);
    expect(getLlmModelReasoningEfforts("kimi", "kimi-k2-thinking")).toEqual([]);
  });

  it("adds reasoning metadata to supported provider models only", () => {
    const azureModels = withLlmModelSelectionMetadata("azure", [
      { key: "my-deployment", displayName: "My deployment", description: "Azure" },
    ]);
    const openAiModels = withLlmModelSelectionMetadata("openai", [
      { key: "gpt-5.4", displayName: "GPT-5.4", description: "OpenAI" },
    ]);

    expect(azureModels[0].reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "extra_high",
    ]);
    expect(openAiModels[0].reasoningEfforts).toBeUndefined();
  });
});
