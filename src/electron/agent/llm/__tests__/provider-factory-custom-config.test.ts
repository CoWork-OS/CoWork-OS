/**
 * Tests for custom provider config resolution
 * Ensures alias fallback is logged and resolved configs are preferred.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { LLMProviderFactory } from "../provider-factory";
import type { CustomProviderConfig } from "../../../../shared/types";

const dummyModelKey = "sonnet";

function getModelIdWithCustomProviders(
  providerType: "kimi-coding" | "kimi-code",
  customProviders: Record<string, CustomProviderConfig>,
) {
  return LLMProviderFactory.getModelId(
    dummyModelKey,
    providerType,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    customProviders,
    undefined,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLMProviderFactory custom provider config resolution", () => {
  it("logs when falling back from resolved alias to providerType config", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const customProviders: Record<string, CustomProviderConfig> = {
      "kimi-coding": {
        apiKey: "test-key",
        model: "custom-model",
      },
    };

    const modelId = getModelIdWithCustomProviders("kimi-coding", customProviders);

    expect(modelId).toBe("custom-model");
    expect(logSpy).toHaveBeenCalledWith(
      '[LLMProviderFactory] Custom provider config not found for "kimi-code", falling back to "kimi-coding".',
    );
  });

  it("prefers resolved alias config when present without logging", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const customProviders: Record<string, CustomProviderConfig> = {
      "kimi-code": {
        apiKey: "resolved-key",
        model: "resolved-model",
      },
      "kimi-coding": {
        apiKey: "fallback-key",
        model: "fallback-model",
      },
    };

    const modelId = getModelIdWithCustomProviders("kimi-coding", customProviders);

    expect(modelId).toBe("resolved-model");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("uses Azure deployment name when provider type is azure", () => {
    const modelId = LLMProviderFactory.getModelId(
      dummyModelKey,
      "azure",
      undefined,
      undefined,
      undefined,
      undefined,
      "my-deployment",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(modelId).toBe("my-deployment");
  });

  it("prefers explicit bedrock model ID when provider type is bedrock", () => {
    const modelId = LLMProviderFactory.getModelId(
      "sonnet-3-5",
      "bedrock",
      undefined, // ollamaModel
      undefined, // geminiModel
      undefined, // openrouterModel
      undefined, // openaiModel
      undefined, // azureDeployment
      undefined, // azureAnthropicDeployment
      undefined, // groqModel
      undefined, // xaiModel
      undefined, // kimiModel
      undefined, // customProviders
      "us.anthropic.claude-opus-4-6-20260115-v1:0", // bedrockModel
    );

    expect(modelId).toBe("us.anthropic.claude-opus-4-6-20260115-v1:0");
  });

  it("keeps cached custom-provider models and adds documented models", () => {
    const modelStatus = LLMProviderFactory.getProviderModelStatus({
      providerType: "minimax-portal",
      modelKey: "sonnet-3-5",
      customProviders: {
        "minimax-portal": {
          apiKey: "minimax-test",
          model: "MiniMax-M2.5",
          cachedModels: [
            {
              key: "MiniMax-M2.5",
              displayName: "MiniMax M2.5",
              description: "MiniMax Portal model",
            },
            {
              key: "MiniMax-M2.1",
              displayName: "MiniMax M2.1",
              description: "MiniMax Portal model",
            },
          ],
        },
      },
    } as Any);

    expect(modelStatus.currentModel).toBe("MiniMax-M2.5");
    expect(modelStatus.models.map((model) => model.key)).toEqual([
      "MiniMax-M2.5",
      "MiniMax-M2.1",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ]);
  });

  it("returns documented MiniMax Portal models when refreshing custom-provider models", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "minimax-portal",
      modelKey: "sonnet-3-5",
      customProviders: {
        "minimax-portal": {
          apiKey: "minimax-test",
          model: "MiniMax-M2.5",
        },
      },
    } as Any);
    const saveSpy = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => {});

    await expect(LLMProviderFactory.getCustomProviderModels("minimax-portal")).resolves.toEqual([
      {
        key: "MiniMax-M2.5",
        displayName: "MiniMax-M2.5",
        description: "MiniMax Portal model",
      },
      {
        key: "MiniMax-M2.7",
        displayName: "MiniMax-M2.7",
        description: "MiniMax Portal model",
      },
      {
        key: "MiniMax-M2.7-highspeed",
        displayName: "MiniMax-M2.7-highspeed",
        description: "MiniMax Portal model",
      },
      {
        key: "MiniMax-M2.5-highspeed",
        displayName: "MiniMax-M2.5-highspeed",
        description: "MiniMax Portal model",
      },
      {
        key: "MiniMax-M2.1",
        displayName: "MiniMax-M2.1",
        description: "MiniMax Portal model",
      },
      {
        key: "MiniMax-M2.1-highspeed",
        displayName: "MiniMax-M2.1-highspeed",
        description: "MiniMax Portal model",
      },
      {
        key: "MiniMax-M2",
        displayName: "MiniMax-M2",
        description: "MiniMax Portal model",
      },
    ]);

    expect(saveSpy).toHaveBeenCalled();
  });

  it("adds documented Z.AI coding-plan models to partial refresh results", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "zai",
      modelKey: "sonnet-3-5",
      customProviders: {
        zai: {
          apiKey: "zai-test",
          baseUrl: "https://api.z.ai/api/paas/v4",
          model: "glm-4.7",
        },
      },
    } as Any);
    vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "glm-4.7" }] }),
    } as Response);

    const models = await LLMProviderFactory.getCustomProviderModels("zai");

    expect(models.map((model) => model.key)).toEqual([
      "glm-4.7",
      "GLM-5.1",
      "GLM-5-Turbo",
      "GLM-5V-Turbo",
      "glm-4.5-air",
    ]);
  });
});
