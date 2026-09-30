import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureSettingsRepository } from "../../../database/SecureSettingsRepository";
import { LLMProviderFactory } from "../provider-factory";

afterEach(() => {
  LLMProviderFactory.clearCache();
  vi.restoreAllMocks();
});

describe("provider settings persistence", () => {
  it("does not publish account credentials when encrypted storage refuses the write", () => {
    const existing = { providerType: "openai", openai: { model: "gpt-6-astra" } };
    const repository = { load: vi.fn(() => existing), save: vi.fn(() => false) };
    vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
    vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue(repository as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    LLMProviderFactory.clearCache();
    const previous = LLMProviderFactory.loadSettings();
    expect(() =>
      LLMProviderFactory.saveSettings({
        ...previous,
        openai: {
          ...previous.openai,
          authMethod: "oauth",
          accessToken: "disposable-private-access",
        },
      }),
    ).toThrow("storage refused");
    expect(LLMProviderFactory.loadSettings()).toEqual(previous);
    expect(LLMProviderFactory.loadSettings().openai?.accessToken).toBeUndefined();
  });
});
