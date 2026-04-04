import { describe, expect, it } from "vitest";

import {
  getLlmProviderDisplayName,
  normalizeLlmProviderType,
} from "../llmProviderDisplay";
import { LLM_PROVIDER_TYPES } from "../types";

describe("llmProviderDisplay", () => {
  it("resolves every registered provider type to a canonical id and display name", () => {
    for (const providerType of LLM_PROVIDER_TYPES) {
      const normalized = normalizeLlmProviderType(providerType);
      expect(normalized).toBeTruthy();
      expect(getLlmProviderDisplayName(providerType).trim().length).toBeGreaterThan(0);
    }
  });

  it("canonicalizes kimi-coding to kimi-code", () => {
    expect(normalizeLlmProviderType("kimi-coding")).toBe("kimi-code");
    expect(getLlmProviderDisplayName("kimi-coding")).toBe("Kimi Code");
  });
});
