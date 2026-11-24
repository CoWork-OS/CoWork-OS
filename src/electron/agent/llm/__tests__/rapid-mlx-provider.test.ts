import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory, type LLMSettings } from "../provider-factory";
import { getModelPricing } from "../pricing";
import { getModelAccessDescriptor } from "../../../../shared/model-access";
import { getFirstRunReadiness } from "../../../../shared/first-run-readiness";
import { CUSTOM_PROVIDER_MAP } from "../../../../shared/llm-provider-catalog";
import { isLocalInferenceProvider } from "../../runtime/local-model-execution-profile";
import { isTextToolCallFallbackEnabledByDefault } from "../text-tool-protocol";

const model = "qwen3.5-4b-4bit";
const settings: LLMSettings = {
  providerType: "rapid-mlx",
  modelKey: model,
  customProviders: { "rapid-mlx": { baseUrl: "http://localhost:8000/v1", model } },
};

function mockSettings() {
  vi.spyOn(LLMProviderFactory, "loadSettings").mockImplementation(() => structuredClone(settings));
  vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => undefined);
}

function mockResponse(data: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  LLMProviderFactory.clearCache();
});

describe("Rapid-MLX provider integration (#890)", () => {
  it("has a keyless catalog entry at localhost:8000/v1", () => {
    expect(CUSTOM_PROVIDER_MAP.get("rapid-mlx")).toMatchObject({
      name: "Rapid-MLX",
      compatibility: "openai",
      baseUrl: "http://localhost:8000/v1",
      apiKeyOptional: true,
    });
  });

  it("appears as a configured local provider with local execution and zero token pricing", () => {
    mockSettings();
    expect(LLMProviderFactory.getAvailableProviders()).toContainEqual(
      expect.objectContaining({ type: "rapid-mlx", name: "Rapid-MLX", configured: true }),
    );
    expect(getModelAccessDescriptor("rapid-mlx").group).toBe("local");
    expect(isLocalInferenceProvider("rapid-mlx")).toBe(true);
    expect(getModelPricing("gpt-4o", "rapid-mlx")).toMatchObject({
      inputPer1M: 0,
      outputPer1M: 0,
    });
    expect(getFirstRunReadiness(settings)).toMatchObject({
      modelReady: true,
      modelPath: "local_model",
    });
    expect(
      getFirstRunReadiness({
        ...settings,
        customProviders: { "rapid-mlx": { baseUrl: "http://localhost:8000/v1" } },
      }).modelReady,
    ).toBe(false);
    expect(isTextToolCallFallbackEnabledByDefault("rapid-mlx")).toBe(
      isTextToolCallFallbackEnabledByDefault("omlx"),
    );
  });

  it.each([
    "http://localhost:8000",
    "http://localhost:8000/v1/",
    "http://localhost:8000/v1/chat/completions",
  ])("tests the chat endpoint from %s without requiring an API key", async (baseUrl) => {
    const fetchSpy = mockResponse({ choices: [{ message: { content: "ok" } }] });
    await expect(
      LLMProviderFactory.testProvider({ type: "rapid-mlx", model, providerBaseUrl: baseUrl }),
    ).resolves.toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8000/v1/chat/completions",
      expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json" } }),
    );
  });

  it("discovers models from /v1/models with an optional bearer key and caches them", async () => {
    mockSettings();
    const fetchSpy = mockResponse({ data: [{ id: model }, { id: "qwen3.6-35b-a3b-4bit" }] });
    const models = await LLMProviderFactory.getCustomProviderModels("rapid-mlx", {
      apiKey: "local-secret",
      baseUrl: "http://localhost:8003",
    });
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:8003/v1/models", {
      headers: { Authorization: "Bearer local-secret" },
      signal: expect.any(AbortSignal),
    });
    expect(models.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([model, "qwen3.6-35b-a3b-4bit"]),
    );
    expect(LLMProviderFactory.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        customProviders: {
          "rapid-mlx": expect.objectContaining({
            model,
            cachedModels: expect.arrayContaining([expect.objectContaining({ key: model })]),
          }),
        },
      }),
    );
  });

  it.each([
    [200, { data: [] }, "rapid-mlx serve <model>"],
    [401, { error: { message: "API key required" } }, "RAPID_MLX_API_KEY"],
    [200, { unexpected: [] }, "incompatible model list"],
  ])(
    "reports discovery failures (%s) with Rapid-MLX guidance and keeps saved models",
    async (status, body, message) => {
      mockSettings();
      mockResponse(body, status);
      await expect(LLMProviderFactory.getCustomProviderModels("rapid-mlx")).rejects.toThrow(
        message,
      );
      expect(LLMProviderFactory.saveSettings).not.toHaveBeenCalled();
    },
  );

  it("points to the port range when the server is unreachable", async () => {
    mockSettings();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("Offline"), { code: "ECONNREFUSED" }),
    );
    await expect(LLMProviderFactory.getCustomProviderModels("rapid-mlx")).rejects.toThrow(
      /Could not reach Rapid-MLX.*8009/,
    );
    expect(LLMProviderFactory.saveSettings).not.toHaveBeenCalled();
  });

  it("requires an explicit chat model instead of guessing one", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      LLMProviderFactory.testProvider({ type: "rapid-mlx", model: "" }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining("Rapid-MLX") });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
