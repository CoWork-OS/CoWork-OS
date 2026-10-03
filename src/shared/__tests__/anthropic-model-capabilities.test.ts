import { describe, expect, it } from "vitest";

import {
  clampAnthropicEffort,
  getAnthropicDefaultReasoningEffort,
  getAnthropicModelCapabilities,
  getAnthropicReasoningEffortOptions,
} from "../anthropic-model-capabilities";

function caps(modelId: string) {
  const result = getAnthropicModelCapabilities(modelId);
  if (!result) throw new Error(`no capabilities for ${modelId}`);
  return result;
}

describe("getAnthropicModelCapabilities", () => {
  it.each([
    ["claude-opus-4-6", "opus-4-6"],
    ["opus-4-6", "opus-4-6"],
    ["anthropic.claude-opus-4-6", "opus-4-6"],
    ["us.anthropic.claude-opus-4-6-v1:0", "opus-4-6"],
    ["anthropic/claude-opus-4.6", "opus-4-6"],
    ["claude-opus-4-5-20251101", "opus-4-5"],
    ["claude-sonnet-4-20250514", "sonnet-4"],
    ["claude-haiku-4-5-20251001", "haiku-4-5"],
    ["claude-opus-5-5", "opus-5-5"],
    ["claude-fable-5-1", "fable-5-1"],
  ])("resolves %s to the %s family", (modelId, family) => {
    expect(caps(modelId).family).toBe(family);
  });

  it("returns null for models without extended thinking or unknown ids", () => {
    expect(getAnthropicModelCapabilities("claude-3-5-haiku-20241022")).toBeNull();
    expect(getAnthropicModelCapabilities("MiniMax-M2")).toBeNull();
    expect(getAnthropicModelCapabilities("")).toBeNull();
  });

  it("separates explicit-adaptive, default-adaptive and budget families", () => {
    expect(caps("claude-opus-4-6")).toMatchObject({
      thinkingMode: "adaptive",
      adaptiveDefaultOn: false,
      efforts: ["low", "medium", "high", "max"],
      rejectsSampling: false,
    });
    expect(caps("claude-opus-4-8")).toMatchObject({
      thinkingMode: "adaptive",
      adaptiveDefaultOn: false,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      rejectsSampling: true,
    });
    expect(caps("claude-opus-5-5")).toMatchObject({
      thinkingMode: "adaptive",
      adaptiveDefaultOn: true,
      defaultEffort: "medium",
      rejectsForcedToolChoice: true,
    });
    expect(caps("claude-sonnet-4-5")).toMatchObject({ thinkingMode: "budget", efforts: [] });
    expect(caps("claude-haiku-4-5")).toMatchObject({ thinkingMode: "budget", efforts: [] });
    expect(caps("claude-opus-4-5")).toMatchObject({
      thinkingMode: "budget",
      efforts: ["low", "medium", "high"],
    });
  });

  it("treats unknown later generations like the current always-thinking models", () => {
    expect(caps("claude-opus-6")).toMatchObject({
      thinkingMode: "adaptive",
      adaptiveDefaultOn: true,
      rejectsSampling: true,
    });
  });
});

describe("clampAnthropicEffort", () => {
  it("clamps unsupported levels down and maps provider aliases", () => {
    expect(clampAnthropicEffort(caps("claude-opus-4-6"), "xhigh")).toBe("high");
    expect(clampAnthropicEffort(caps("claude-opus-4-8"), "xhigh")).toBe("xhigh");
    expect(clampAnthropicEffort(caps("claude-opus-4-8"), "ultra")).toBe("max");
    expect(clampAnthropicEffort(caps("claude-opus-4-5"), "max")).toBe("high");
    expect(clampAnthropicEffort(caps("claude-haiku-4-5"), "high")).toBeUndefined();
    expect(clampAnthropicEffort(caps("claude-opus-4-6"), "none")).toBeUndefined();
    expect(clampAnthropicEffort(caps("claude-opus-4-6"), undefined)).toBeUndefined();
  });
});

describe("Anthropic effort options", () => {
  it("offers none only where thinking can be turned off", () => {
    expect(getAnthropicReasoningEffortOptions("claude-opus-4-6")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(getAnthropicReasoningEffortOptions("claude-opus-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getAnthropicReasoningEffortOptions("claude-sonnet-4-5")).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(getAnthropicReasoningEffortOptions("claude-3-5-haiku-20241022")).toEqual([]);
  });

  it("preselects the API default, and no thinking for budget models", () => {
    expect(getAnthropicDefaultReasoningEffort("claude-opus-5-5")).toBe("medium");
    expect(getAnthropicDefaultReasoningEffort("claude-opus-4-8")).toBe("high");
    expect(getAnthropicDefaultReasoningEffort("claude-haiku-4-5")).toBe("none");
    expect(getAnthropicDefaultReasoningEffort("gpt-6-sol")).toBeUndefined();
  });
});
