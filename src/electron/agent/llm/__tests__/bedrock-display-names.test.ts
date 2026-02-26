/**
 * Tests for Bedrock display name formatting.
 *
 * Covers both human-readable inference profile names
 * (formatBedrockProfileName) and raw model IDs (formatBedrockModelId).
 */

import { describe, it, expect } from "vitest";
import { LLMProviderFactory } from "../provider-factory";

// Access private static methods via cast
const factory = LLMProviderFactory as Any;

describe("formatBedrockProfileName", () => {
  it.each([
    ["US Anthropic Claude Opus 4.6", "Opus 4.6 US"],
    ["Global Anthropic Claude Sonnet 4.6", "Sonnet 4.6 GL"],
    ["US Anthropic Claude 3.5 Sonnet", "Sonnet 3.5 US"],
    ["US Claude Opus 4", "Opus 4 US"],
    ["GLOBAL Anthropic Claude Haiku 4.5", "Haiku 4.5 GL"],
    ["EU Anthropic Claude Sonnet 3.5", "Sonnet 3.5 EU"],
    ["SA Anthropic Claude Opus 4.6", "Opus 4.6 SA"],
  ])("formats profile name %j → %j", (input, expected) => {
    expect(factory.formatBedrockProfileName(input)).toBe(expected);
  });

  it("returns empty string for empty input", () => {
    expect(factory.formatBedrockProfileName("")).toBe("");
    expect(factory.formatBedrockProfileName("  ")).toBe("");
  });

  it("returns name as-is when pattern is not recognised", () => {
    expect(factory.formatBedrockProfileName("Some Unknown Model")).toBe("Some Unknown Model");
  });
});

describe("formatBedrockModelId", () => {
  it.each([
    // family-version pattern
    ["us.anthropic.claude-sonnet-4-6-v1:0", "Sonnet 4.6 US"],
    ["us.anthropic.claude-opus-4-6-20260115-v1:0", "Opus 4.6 US"],
    ["eu.anthropic.claude-haiku-4-5-20251101-v2:0", "Haiku 4.5 EU"],
    // version-family pattern
    ["eu.anthropic.claude-3-5-sonnet-20241022-v2:0", "Sonnet 3.5 EU"],
    ["us.anthropic.claude-3-5-haiku-20241022-v1:0", "Haiku 3.5 US"],
    // No region prefix
    ["anthropic.claude-opus-4-5-20251101", "Opus 4.5"],
    ["anthropic.claude-sonnet-4-6", "Sonnet 4.6"],
    // SA region
    ["sa.anthropic.claude-sonnet-4-6-v1:0", "Sonnet 4.6 SA"],
    // AP region variants
    ["ap-northeast-1.anthropic.claude-opus-4-5-v1:0", "Opus 4.5 AP-NORTHEAST-1"],
    // Single-digit version (edge case)
    ["us.anthropic.claude-opus-4-20250101-v1:0", "Opus 4 US"],
  ])("formats model ID %j → %j", (input, expected) => {
    expect(factory.formatBedrockModelId(input)).toBe(expected);
  });

  it("returns null for non-Bedrock-ID strings", () => {
    expect(factory.formatBedrockModelId("US Anthropic Claude Opus 4.6")).toBeNull();
    expect(factory.formatBedrockModelId("gpt-4")).toBeNull();
    expect(factory.formatBedrockModelId("")).toBeNull();
  });

  it("routes raw model IDs through formatBedrockProfileName correctly", () => {
    // formatBedrockProfileName should delegate to formatBedrockModelId for IDs
    expect(factory.formatBedrockProfileName("us.anthropic.claude-sonnet-4-6-v1:0")).toBe(
      "Sonnet 4.6 US",
    );
    expect(factory.formatBedrockProfileName("anthropic.claude-opus-4-5-20251101")).toBe("Opus 4.5");
  });
});
