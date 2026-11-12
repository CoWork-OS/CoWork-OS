import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory, type LLMSettings } from "../provider-factory";
import { getModelPricing } from "../pricing";
import { isTextToolCallFallbackEnabledByDefault } from "../text-tool-protocol";
import { getModelAccessDescriptor } from "../../../../shared/model-access";
import { getFirstRunReadiness } from "../../../../shared/first-run-readiness";
import { CUSTOM_PROVIDER_MAP } from "../../../../shared/llm-provider-catalog";
import { isLocalInferenceProvider } from "../../runtime/local-model-execution-profile";

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

describe("Rapid-MLX provider integration", () => {
  it("has a keyless OpenAI-compatible catalog entry on localhost:8000/v1", () => {
    expect(CUSTOM_PROVIDER_MAP.get("rapid-mlx")).toMatchObject({
      id: "rapid-mlx",
      name: "Rapid-MLX",
      compatibility: "openai",
      baseUrl: "http://localhost:8000/v1",
      defaultModel: "",
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
    expect(isTextToolCallFallbackEnabledByDefault("rapid-mlx")).toBe(true);
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
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({ model });
  });

  it("discovers models from /v1/models without an Authorization header when no key is set", async () => {
    mockSettings();
    const fetchSpy = mockResponse({ data: [{ id: model }, { id: "other-chat" }] });
    const models = await LLMProviderFactory.getCustomProviderModels("rapid-mlx");
    expect(fetchSpy.mock.calls[0][0]).toBe("http://localhost:8000/v1/models");
    const headers = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
    expect(models.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([model, "other-chat"]),
    );
  });

  it("discovers models with an optional bearer key and caches them without losing selection", async () => {
    mockSettings();
    const fetchSpy = mockResponse({ data: [{ id: "my-chat-alias" }, { id: "other-chat" }] });
    const models = await LLMProviderFactory.getCustomProviderModels("rapid-mlx", {
      apiKey: "local-token",
      baseUrl: "http://my-mac:8000",
    });
    expect(fetchSpy).toHaveBeenCalledWith("http://my-mac:8000/v1/models", {
      headers: { Authorization: "Bearer local-token" },
      signal: expect.any(AbortSignal),
    });
    expect(models.map((entry) => entry.key)).toContain("my-chat-alias");
    expect(LLMProviderFactory.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        customProviders: {
          "rapid-mlx": expect.objectContaining({
            model,
            cachedModels: expect.arrayContaining([
              expect.objectContaining({ key: "my-chat-alias" }),
            ]),
          }),
        },
      }),
    );
  });

  it.each([
    [200, { data: [] }, "Rapid-MLX is reachable but reported no models"],
    [401, { error: { message: "API key required" } }, "Rapid-MLX requires a valid API key"],
    [200, { unexpected: [] }, "Rapid-MLX returned an incompatible model list"],
  ])(
    "reports discovery failures (%s) without overwriting saved models",
    async (status, body, message) => {
      mockSettings();
      mockResponse(body, status);
      await expect(LLMProviderFactory.getCustomProviderModels("rapid-mlx")).rejects.toThrow(
        message,
      );
      expect(LLMProviderFactory.saveSettings).not.toHaveBeenCalled();
    },
  );

  it("reports an offline server without overwriting saved models", async () => {
    mockSettings();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("Offline"), { code: "ECONNREFUSED" }),
    );
    await expect(LLMProviderFactory.getCustomProviderModels("rapid-mlx")).rejects.toThrow(
      "Could not reach Rapid-MLX",
    );
    expect(LLMProviderFactory.saveSettings).not.toHaveBeenCalled();
  });

  it("preserves endpoint and credentials when switching the selected model", () => {
    const configured: LLMSettings = {
      ...settings,
      customProviders: {
        "rapid-mlx": { ...settings.customProviders?.["rapid-mlx"], apiKey: "local-token" },
      },
    };
    const updated = LLMProviderFactory.applyModelSelection(configured, "second-chat", "rapid-mlx");
    expect(updated.customProviders?.["rapid-mlx"]).toMatchObject({
      model: "second-chat",
      apiKey: "local-token",
      baseUrl: "http://localhost:8000/v1",
    });
    expect(LLMProviderFactory.getProviderModelStatus(updated).currentModel).toBe("second-chat");
    expect(configured.customProviders?.["rapid-mlx"]?.model).toBe(model);
  });

  it("requires an explicit chat model instead of sending a guessed model ID", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      LLMProviderFactory.testProvider({ type: "rapid-mlx", model: "" }),
    ).resolves.toEqual({
      success: false,
      error: "Rapid-MLX model is required. Configure it in Settings.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces authentication failures from the server", async () => {
    mockResponse({ error: { message: "Invalid API key" } }, 401);
    await expect(
      LLMProviderFactory.testProvider({ type: "rapid-mlx", model, providerApiKey: "wrong-key" }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining("Invalid API key") });
  });

  it("sends tool definitions and decodes tool calls through the shared task runtime", async () => {
    mockSettings();
    const fetchSpy = mockResponse({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"note.txt"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    const provider = LLMProviderFactory.createProvider();
    expect(provider.type).toBe("rapid-mlx");
    const result = await provider.createMessage({
      model,
      maxTokens: 100,
      system: "Help with files",
      messages: [{ role: "user", content: "Read note.txt" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      model,
      tools: [{ type: "function", function: { name: "read_file" } }],
      tool_choice: "auto",
    });
    expect(result.content).toContainEqual({
      type: "tool_use",
      id: "call-1",
      name: "read_file",
      input: { path: "note.txt" },
    });
  });
});
