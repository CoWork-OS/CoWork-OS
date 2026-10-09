import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory, type LLMSettings } from "../llm/provider-factory";
import { resolveComposerPredictionModel } from "../composer-prediction-model";
afterEach(() => vi.restoreAllMocks());
describe("prediction model routing", () => {
  it("uses the cheap profile even when the provider default is an expensive model", () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai",
      openai: {
        model: "gpt-4o",
        profileRoutingEnabled: true,
        cheapModelKey: "gpt-4o-mini",
        strongModelKey: "gpt-4o",
      },
    } as LLMSettings);
    expect(
      resolveComposerPredictionModel({
        agentConfig: { providerType: "openai", modelKey: "gpt-4o" },
      }).modelId,
    ).toBe("gpt-4o-mini");
  });

  it("keeps the conversation's selected provider when the app's default provider differs", () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "gemini",
      openai: {
        model: "gpt-4o",
        profileRoutingEnabled: true,
        cheapModelKey: "gpt-4o-mini",
      },
    } as LLMSettings);
    const selection = resolveComposerPredictionModel({ agentConfig: { providerType: "openai" } });
    expect(selection.providerType).toBe("openai");
    expect(selection.modelId).toBe("gpt-4o-mini");
  });

  it("uses the selected provider's default model when profile routing is disabled", () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai",
      openai: {
        model: "gpt-4o",
        profileRoutingEnabled: false,
        cheapModelKey: "gpt-4o-mini",
      },
    } as LLMSettings);
    const selection = resolveComposerPredictionModel({
      agentConfig: { providerType: "openai", modelKey: "gpt-4o-mini" },
    });
    expect(selection.providerType).toBe("openai");
    expect(selection.modelId).toBe("gpt-4o");
  });
});
