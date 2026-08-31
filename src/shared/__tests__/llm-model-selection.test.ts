import { describe, expect, it } from "vitest";

import { getLlmModelReasoningEfforts, withLlmModelSelectionMetadata } from "../llm-model-selection";

describe("llm model selection metadata", () => {
  it("declares model-specific Intelligence controls for GPT-5.6 subscription models", () => {
    expect(getLlmModelReasoningEfforts("azure", "deployment-a")).toEqual([
      "low",
      "medium",
      "high",
      "extra_high",
    ]);
    expect(getLlmModelReasoningEfforts("openai", "gpt-5.4")).toEqual([]);
    expect(getLlmModelReasoningEfforts("openai", "gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getLlmModelReasoningEfforts("openai", "openai-codex/gpt-5.6-terra@fast")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getLlmModelReasoningEfforts("openai", "gpt-5.6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getLlmModelReasoningEfforts("xai", "grok-4-fast-reasoning")).toEqual([]);
    expect(getLlmModelReasoningEfforts("kimi", "kimi-k2-thinking")).toEqual([]);
  });

  it("adds reasoning metadata to supported provider models only", () => {
    const azureModels = withLlmModelSelectionMetadata("azure", [
      { key: "my-deployment", displayName: "My deployment", description: "Azure" },
    ]);
    const openAiModels = withLlmModelSelectionMetadata("openai", [
      { key: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "OpenAI" },
    ]);

    expect(azureModels[0].reasoningEfforts).toEqual(["low", "medium", "high", "extra_high"]);
    expect(openAiModels[0].reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });
});
