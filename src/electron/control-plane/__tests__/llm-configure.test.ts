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

  it("configures the existing built-in OpenAI-compatible provider node", () => {
    let savedSettings: Any;
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai-compatible",
      openaiCompatible: {
        baseUrl: "http://localhost:1234/v1",
        model: "local-model",
        contextWindow: 32000,
      },
    } as Any);
    vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation((settings: Any) => {
      savedSettings = settings;
    });
    vi.spyOn(LLMProviderFactory, "getConfigStatus").mockReturnValue({
      currentProvider: "openai-compatible",
      currentModel: "local-model",
      providers: [],
    } as Any);

    configureLlmFromControlPlaneParams({
      providerType: "openai-compatible",
      apiKey: "local-test-only",
      settings: { baseUrl: "http://127.0.0.1:4567/v1" },
    });

    expect(savedSettings.openaiCompatible).toEqual({
      baseUrl: "http://127.0.0.1:4567/v1",
      apiKey: "local-test-only",
      model: "local-model",
      contextWindow: 32000,
    });
    expect(savedSettings.customProviders?.["openai-compatible"]).toBeUndefined();
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
