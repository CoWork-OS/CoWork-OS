import { describe, expect, it } from "vitest";
import { selectImageProviderOrder } from "../image-generator";

describe("selectImageProviderOrder", () => {
  it("defaults to the best configured image provider even when the active chat model differs", () => {
    const order = selectImageProviderOrder({
      settings: {
        providerType: "openai",
        modelKey: "x",
        gemini: { apiKey: "g" },
        openai: { apiKey: "o" },
        azure: {
          apiKey: "a",
          endpoint: "https://example.openai.azure.com",
          deployments: ["gpt-image-1.5"],
        },
      } as Any,
      prompt: "make a poster",
      providerOverride: "auto",
    });

    expect(order[0]?.provider).toBe("azure");
    expect(order.map((e) => e.provider)).toContain("gemini");
    expect(order.map((e) => e.provider)).toContain("azure");
  });

  it("switches to openai when prompt mentions gpt-image", () => {
    const order = selectImageProviderOrder({
      settings: {
        providerType: "gemini",
        modelKey: "x",
        gemini: { apiKey: "g" },
        openai: { apiKey: "o" },
        azure: {
          apiKey: "a",
          endpoint: "https://example.openai.azure.com",
          deployments: ["gpt-image-1.5"],
        },
      } as Any,
      prompt: "use gpt-image-1.5 for this",
      providerOverride: "auto",
    });

    expect(order[0]?.provider).toBe("azure");
  });

  it("switches to azure when provider override is azure", () => {
    const order = selectImageProviderOrder({
      settings: {
        providerType: "openai",
        modelKey: "x",
        gemini: { apiKey: "g" },
        openai: { apiKey: "o" },
        azure: {
          apiKey: "a",
          endpoint: "https://example.openai.azure.com",
          deployments: ["img-deploy"],
        },
      } as Any,
      prompt: "make a poster",
      providerOverride: "azure",
    });

    expect(order[0]?.provider).toBe("azure");
  });

  it("includes openai-codex when OpenAI OAuth is configured", () => {
    const order = selectImageProviderOrder({
      settings: {
        providerType: "openai",
        modelKey: "x",
        openai: {
          accessToken: "oauth-access-token",
          refreshToken: "oauth-refresh-token",
          authMethod: "oauth",
        },
        openrouter: { apiKey: "or" },
      } as Any,
      prompt: "make a poster",
      providerOverride: "auto",
    });

    expect(order[0]?.provider).toBe("openai-codex");
    expect(order.map((entry) => entry.provider)).toContain("openrouter");
  });

  it("honors an explicit OpenAI OAuth image provider when API key auth is also configured", () => {
    const order = selectImageProviderOrder({
      settings: {
        providerType: "openai",
        modelKey: "x",
        openai: {
          apiKey: "openai-api-key",
          accessToken: "oauth-access-token",
          refreshToken: "oauth-refresh-token",
          authMethod: "oauth",
        },
        imageGeneration: {
          defaultProvider: "openai-codex",
          defaultModel: "gpt-image-1.5",
        },
      } as Any,
      prompt: "make a poster",
      providerOverride: "auto",
    });

    expect(order[0]).toEqual({ provider: "openai-codex", modelPreset: "gpt-image-1.5" });
  });
});
