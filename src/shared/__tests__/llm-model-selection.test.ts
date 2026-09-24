import { describe, expect, it } from "vitest";

import {
  getLlmReasoningEffortOptions,
  getLlmModelReasoningEfforts,
  withLlmModelSelectionMetadata,
} from "../llm-model-selection";

describe("llm model selection metadata", () => {
  it.each(["gpt-6-astra", "openai-codex/gpt-6-astra@fast", "openai/gpt-6-astra"])(
    "exposes all Astra reasoning efforts for %s",
    (model) => {
      expect(getLlmModelReasoningEfforts("openai", model, "oauth")).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ]);
    },
  );

  it("keeps Ultra subscription-only for Astra", () => {
    expect(getLlmModelReasoningEfforts("openai", "gpt-6-astra", "api_key")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it.each(["gpt-6-sol", "gpt-6-luna"])(
    "exposes documented direct API reasoning levels for %s",
    (model) => {
      expect(getLlmModelReasoningEfforts("openai", model, "api_key")).toEqual([
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(getLlmModelReasoningEfforts("azure", model)).toEqual([
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    },
  );

  it("declares model-specific Intelligence controls for GPT-5.6 subscription models", () => {
    expect(getLlmModelReasoningEfforts("azure", "deployment-a")).toEqual([
      "low",
      "medium",
      "high",
      "extra_high",
    ]);
    expect(getLlmModelReasoningEfforts("openai", "gpt-5.4")).toEqual([]);
    expect(getLlmModelReasoningEfforts("openai", "gpt-5.6-sol", "oauth")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(
      getLlmModelReasoningEfforts("openai", "openai-codex/gpt-5.6-terra@fast", "oauth"),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
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
    expect(openAiModels[0].reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("reasoning effort display labels", () => {
  it("uses Light only for OpenAI ChatGPT subscription access", () => {
    expect(getLlmReasoningEffortOptions("openai", "oauth").map((option) => option.label)).toEqual([
      "Light",
      "Medium",
      "High",
      "Extra High",
      "Max",
      "Ultra",
      "Extra High",
    ]);
    for (const [provider, auth] of [
      ["openai", "api_key"],
      ["openai", undefined],
      ["azure", "oauth"],
    ] as const) {
      expect(getLlmReasoningEffortOptions(provider, auth)[0]).toEqual({
        value: "low",
        label: "Low",
      });
    }
  });

  it("filters display options to the selected model capabilities", () => {
    expect(getLlmReasoningEffortOptions("openai", "oauth", ["low", "high", "ultra"])).toEqual([
      { value: "low", label: "Light" },
      { value: "high", label: "High" },
      { value: "ultra", label: "Ultra" },
    ]);
    expect(getLlmReasoningEffortOptions("azure", undefined, ["extra_high"])).toEqual([
      { value: "extra_high", label: "Extra High" },
    ]);
  });
});
