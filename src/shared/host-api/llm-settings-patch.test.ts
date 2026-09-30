import { describe, expect, it } from "vitest";
import { createLLMSettingsPatch } from "./llm-settings-patch";

describe("createLLMSettingsPatch", () => {
  it("sends only changed fields and leaves unchanged sibling settings out", () => {
    const patch = createLLMSettingsPatch(
      {
        providerType: "openai",
        modelKey: "gpt-4.1",
        openai: {
          apiKeyConfigured: true,
          model: "gpt-4.1",
          reasoningEffort: "high",
        },
      },
      {
        providerType: "openai",
        modelKey: "gpt-4o",
        openai: {
          apiKeyConfigured: true,
          model: "gpt-4o",
          reasoningEffort: "high",
        },
      },
    );

    expect(patch).toEqual({
      set: [
        { path: ["modelKey"], value: "gpt-4.1" },
        { path: ["openai", "model"], value: "gpt-4.1" },
      ],
      remove: [],
      replaceSecrets: [],
    });
  });

  it("separates explicit secret replacements and never sends blank credentials or host OAuth state", () => {
    const patch = createLLMSettingsPatch(
      {
        openai: {
          apiKey: "  sk-new-key  ",
          accessToken: "renderer-must-not-write-this",
          refreshToken: "renderer-must-not-write-this-either",
          model: "gpt-4o",
        },
        anthropic: { apiKey: "" },
        jev: { typesafe: { clearApiKey: true } },
      },
      {
        openai: { apiKeyConfigured: true, accessTokenConfigured: true, model: "gpt-4o" },
        anthropic: { apiKeyConfigured: true },
      },
    );

    expect(patch).toEqual({
      set: [{ path: ["jev", "typesafe", "clearApiKey"], value: true }],
      remove: [],
      replaceSecrets: [{ path: ["openai", "apiKey"], value: "sk-new-key" }],
    });
  });

  it("distinguishes explicit clears from omitted settings fields", () => {
    const patch = createLLMSettingsPatch(
      { azure: { endpoint: undefined }, openai: {} },
      { azure: { endpoint: "https://example.test" }, openai: { model: "gpt-4o" } },
    );

    expect(patch).toEqual({
      set: [],
      remove: [["azure", "endpoint"]],
      replaceSecrets: [],
    });
  });

  it("does not emit a change for reordered but otherwise equal object values", () => {
    const patch = createLLMSettingsPatch(
      { promptCaching: { enabled: true, ttl: "5m" } },
      { promptCaching: { ttl: "5m", enabled: true } },
    );

    expect(patch).toEqual({ set: [], remove: [], replaceSecrets: [] });
  });
});
