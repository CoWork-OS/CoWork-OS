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

    expect(order[0]).toBe("azure");
    expect(order).toContain("gemini");
    expect(order).toContain("azure");
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

    expect(order[0]).toBe("azure");
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

    expect(order[0]).toBe("azure");
  });
});
