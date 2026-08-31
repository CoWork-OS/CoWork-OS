import { afterEach, describe, expect, it, vi } from "vitest";

import { LLMProviderFactory } from "../../agent/llm";
import { configureLlmFromControlPlaneParams } from "../llm-configure";

describe("configureLlmFromControlPlaneParams", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores OpenRouter Pareto coding score from provider settings", () => {
    let savedSettings: Any;
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o-mini",
    } as Any);
    vi.spyOn(LLMProviderFactory, "applyModelSelection").mockImplementation(
      (settings: Any, model: string) => ({
        ...settings,
        modelKey: model,
        openrouter: {
          ...settings.openrouter,
          model,
        },
      }),
    );
    vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation((settings: Any) => {
      savedSettings = settings;
    });
    vi.spyOn(LLMProviderFactory, "getConfigStatus").mockReturnValue({
      currentProvider: "openrouter",
      currentModel: "openrouter/pareto-code",
      providers: [],
    } as Any);

    configureLlmFromControlPlaneParams({
      providerType: "openrouter",
      apiKey: "sk-or-test",
      model: "openrouter/pareto-code",
      settings: {
        paretoMinCodingScore: 0.8,
      },
    });

    expect(savedSettings.openrouter).toMatchObject({
      apiKey: "sk-or-test",
      model: "openrouter/pareto-code",
      paretoMinCodingScore: 0.8,
    });
  });

  it("rejects percent-style OpenRouter Pareto coding scores", () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      modelKey: "openrouter/pareto-code",
    } as Any);

    expect(() =>
      configureLlmFromControlPlaneParams({
        providerType: "openrouter",
        model: "openrouter/pareto-code",
        settings: {
          paretoMinCodingScore: 80,
        },
      }),
    ).toThrow("settings.paretoMinCodingScore must be a number from 0 to 1");
  });
});
