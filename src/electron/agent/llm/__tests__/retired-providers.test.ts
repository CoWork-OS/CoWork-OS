import { describe, expect, it, vi } from "vitest";

vi.mock("../../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: { isInitialized: () => false },
}));

import { CUSTOM_PROVIDER_CATALOG } from "../../../../shared/llm-provider-catalog";
import { LLM_PROVIDER_TYPES } from "../../../../shared/types";
import { LLMProviderFactory, RETIRED_PROVIDER_TYPES, type LLMSettings } from "../provider-factory";

describe("retired Google sign-in routes", () => {
  it("are no longer offered", () => {
    for (const id of Object.keys(RETIRED_PROVIDER_TYPES)) {
      expect(LLM_PROVIDER_TYPES as readonly string[]).not.toContain(id);
      expect(CUSTOM_PROVIDER_CATALOG.some((p) => p.id === id)).toBe(false);
    }
  });

  it("moves saved settings off them and discards their stored tokens", () => {
    const settings = {
      providerType: "google-antigravity",
      modelKey: "gemini-2.0-flash",
      fallbackProviders: [{ providerType: "google-gemini-cli" }, { providerType: "openrouter" }],
      customProviders: {
        "google-antigravity": { apiKey: "ya29.token", baseUrl: "https://proxy.example" },
        "google-gemini-cli": { apiKey: "ya29.other" },
        zai: { apiKey: "zai-key" },
      },
      gemini: { apiKey: "gemini-key" },
    } as unknown as LLMSettings;

    LLMProviderFactory.dropRetiredProviders(settings);

    expect(settings.providerType).toBe("gemini");
    expect(settings.fallbackProviders).toEqual([{ providerType: "openrouter" }]);
    expect(Object.keys(settings.customProviders || {})).toEqual(["zai"]);
  });

  it("falls back to the default provider when nothing else is configured", () => {
    const settings = {
      providerType: "google-gemini-cli",
      modelKey: "gemini-2.0-flash",
    } as unknown as LLMSettings;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    LLMProviderFactory.dropRetiredProviders(settings);
    expect(settings.providerType).toBe("anthropic");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("google-gemini-cli"));
    warn.mockRestore();
  });
});
