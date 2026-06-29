import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENROUTER_DEFAULT_MODEL } from "../openrouter-provider";
import { LLMProviderFactory, type LLMSettings } from "../provider-factory";
import { ANTHROPIC_HEALTHCHECK_MODEL_ID } from "../types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LLMProviderFactory model status", () => {
  it.each([
    {
      name: "anthropic",
      settings: { providerType: "anthropic", modelKey: "sonnet-4-5" } as LLMSettings,
      expectedCurrentModel: "sonnet-4-5",
    },
    {
      name: "anthropic cached",
      settings: {
        providerType: "anthropic",
        modelKey: "opus-4-6",
        cachedAnthropicModels: [
          {
            key: "opus-4-6",
            displayName: "Opus 4.6",
            description: "claude-opus-4-6",
          },
        ],
      } as LLMSettings,
      expectedCurrentModel: "opus-4-6",
    },
    {
      name: "bedrock",
      settings: {
        providerType: "bedrock",
        modelKey: "sonnet-4-5",
        bedrock: { model: "us.anthropic.claude-opus-4-6-20260115-v1:0" },
      } as LLMSettings,
      expectedCurrentModel: "us.anthropic.claude-opus-4-6-20260115-v1:0",
    },
    {
      name: "openai",
      settings: {
        providerType: "openai",
        modelKey: "sonnet-4-5",
        openai: { model: "gpt-4o" },
      } as LLMSettings,
      expectedCurrentModel: "gpt-4o",
    },
    {
      name: "azure",
      settings: {
        providerType: "azure",
        modelKey: "sonnet-4-5",
        azure: { deployment: "my-deployment", deployments: ["my-deployment"] },
      } as LLMSettings,
      expectedCurrentModel: "my-deployment",
    },
    {
      name: "gemini",
      settings: {
        providerType: "gemini",
        modelKey: "sonnet-4-5",
        gemini: { model: "gemini-2.5-pro-preview-05-06" },
      } as LLMSettings,
      expectedCurrentModel: "gemini-2.5-pro-preview-05-06",
    },
    {
      name: "openrouter",
      settings: {
        providerType: "openrouter",
        modelKey: "sonnet-4-5",
        openrouter: {},
      } as LLMSettings,
      expectedCurrentModel: OPENROUTER_DEFAULT_MODEL,
    },
    {
      name: "ollama",
      settings: {
        providerType: "ollama",
        modelKey: "sonnet-4-5",
        ollama: { model: "llama3.2" },
      } as LLMSettings,
      expectedCurrentModel: "llama3.2",
    },
    {
      name: "groq",
      settings: {
        providerType: "groq",
        modelKey: "sonnet-4-5",
        groq: { model: "llama-3.3-70b-versatile" },
      } as LLMSettings,
      expectedCurrentModel: "llama-3.3-70b-versatile",
    },
    {
      name: "xai",
      settings: {
        providerType: "xai",
        modelKey: "sonnet-4-5",
        xai: { model: "grok-4" },
      } as LLMSettings,
      expectedCurrentModel: "grok-4",
    },
    {
      name: "kimi",
      settings: {
        providerType: "kimi",
        modelKey: "sonnet-4-5",
        kimi: { model: "kimi-k2.5" },
      } as LLMSettings,
      expectedCurrentModel: "kimi-k2.5",
    },
  ])("uses provider-specific current model for $name", ({ settings, expectedCurrentModel }) => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);
    vi.spyOn(LLMProviderFactory, "getAvailableProviders").mockReturnValue([]);

    const status = LLMProviderFactory.getConfigStatus();

    expect(status.currentModel).toBe(expectedCurrentModel);
    expect(status.models.some((model) => model.key === expectedCurrentModel)).toBe(true);
  });

  it("defaults OpenAI OAuth model status to ChatGPT subscription models", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        authMethod: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);
    vi.spyOn(LLMProviderFactory, "getAvailableProviders").mockReturnValue([]);

    const status = LLMProviderFactory.getConfigStatus();

    expect(status.currentModel).toBe("gpt-5.5");
    expect(status.models.map((model) => model.key)).toContain("gpt-5.5");
    expect(status.models.map((model) => model.key)).toContain("gpt-5.4");
    expect(status.models.map((model) => model.key)).toContain("gpt-5.3-codex-spark");
  });

  it("lists enabled MoA presets as provider models", () => {
    const settings: LLMSettings = {
      providerType: "moa",
      modelKey: "frontier-council",
      moa: {
        defaultPreset: "frontier-council",
        presets: {
          "frontier-council": {
            id: "frontier-council",
            name: "Frontier Council",
            enabled: true,
            referenceModels: [{ providerType: "openai", modelKey: "gpt-4o" }],
            aggregator: { providerType: "anthropic", modelKey: "sonnet-4-5" },
          },
          disabled: {
            id: "disabled",
            name: "Disabled",
            enabled: false,
            referenceModels: [{ providerType: "openai", modelKey: "gpt-4o" }],
            aggregator: { providerType: "anthropic", modelKey: "sonnet-4-5" },
          },
        },
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);
    vi.spyOn(LLMProviderFactory, "getAvailableProviders").mockReturnValue([]);

    const status = LLMProviderFactory.getConfigStatus();

    expect(status.currentModel).toBe("frontier-council");
    expect(status.models.map((model) => model.key)).toContain("frontier-council");
    expect(status.models.map((model) => model.key)).not.toContain("disabled");
  });

  it("filters retired Claude models from cached Anthropic model lists", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      cachedAnthropicModels: [
        {
          key: "haiku-3-5",
          displayName: "Haiku 3.5",
          description: "Retired",
        },
        {
          key: "haiku-4-5",
          displayName: "Haiku 4.5",
          description: "Active",
        },
      ],
    } as LLMSettings);

    const models = await LLMProviderFactory.getAnthropicModels();

    expect(models.map((model) => model.id)).toEqual(["haiku-4-5"]);
  });

  it("normalizes retired saved Anthropic model keys in model status", () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "anthropic",
      modelKey: "sonnet-3-5",
    } as LLMSettings);
    vi.spyOn(LLMProviderFactory, "getAvailableProviders").mockReturnValue([]);

    const status = LLMProviderFactory.getConfigStatus();

    expect(status.currentModel).toBe("sonnet-4-5");
    expect(status.models.some((model) => model.key === "sonnet-3-5")).toBe(false);
  });

  it("filters retired Claude models from cached Anthropic model status", () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "anthropic",
      modelKey: "haiku-3-5",
      cachedAnthropicModels: [
        {
          key: "haiku-3-5",
          displayName: "Haiku 3.5",
          description: "Retired",
        },
        {
          key: "haiku-4-5",
          displayName: "Haiku 4.5",
          description: "Active",
        },
      ],
    } as LLMSettings);
    vi.spyOn(LLMProviderFactory, "getAvailableProviders").mockReturnValue([]);

    const status = LLMProviderFactory.getConfigStatus();

    expect(status.currentModel).toBe("haiku-4-5");
    expect(status.models.map((model) => model.key)).toEqual(["haiku-4-5"]);
  });

  it("normalizes stale OpenAI API model settings for ChatGPT OAuth", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        authMethod: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        model: "gpt-4o-mini",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const resolved = LLMProviderFactory.resolveTaskModelSelection({
      modelKey: "gpt-4o-mini",
      llmProfile: "cheap",
    });

    expect(resolved.modelSource).toBe("provider_default");
    expect(resolved.modelKey).toBe("gpt-5.5");
    expect(resolved.modelId).toBe("gpt-5.5");
  });

  it("normalizes explicitly allowed stale OpenAI OAuth model overrides", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        authMethod: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        model: "gpt-5.4",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const resolved = LLMProviderFactory.resolveTaskModelSelection(
      {
        providerType: "openai",
        modelKey: "gpt-4o-mini",
      },
      {
        allowProviderOverride: true,
        allowModelOverride: true,
      },
    );

    expect(resolved.modelSource).toBe("explicit_override");
    expect(resolved.modelKey).toBe("gpt-4o-mini");
    expect(resolved.modelId).toBe("gpt-5.5");
  });

  it("runs the stored Anthropic-compatible gateway model even when another provider uses the same id", () => {
    const settings: LLMSettings = {
      providerType: "anthropic-compatible",
      modelKey: "sonnet-4-6",
      kimi: {
        model: "moonshotai/kimi-k2.6:thinking",
      },
      customProviders: {
        "anthropic-compatible": {
          apiKey: "nano-key",
          baseUrl: "https://nano-gpt.com/api/v1",
          model: "moonshotai/kimi-k2.6:thinking",
        },
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const resolved = LLMProviderFactory.resolveTaskModelSelection();

    expect(resolved.providerType).toBe("anthropic-compatible");
    expect(resolved.modelKey).toBe("moonshotai/kimi-k2.6:thinking");
    expect(resolved.modelId).toBe("moonshotai/kimi-k2.6:thinking");
    expect(resolved.modelSource).toBe("provider_default");
  });
});

describe("LLMProviderFactory model selection persistence", () => {
  it("stores selected model in provider-specific fields", () => {
    const openaiSettings: LLMSettings = { providerType: "openai", modelKey: "opus-4-5" };
    const geminiSettings: LLMSettings = { providerType: "gemini", modelKey: "opus-4-5" };
    const openrouterSettings: LLMSettings = { providerType: "openrouter", modelKey: "opus-4-5" };
    const ollamaSettings: LLMSettings = { providerType: "ollama", modelKey: "opus-4-5" };
    const azureSettings: LLMSettings = {
      providerType: "azure",
      modelKey: "opus-4-5",
      azure: { deployments: ["existing"] },
    };
    const groqSettings: LLMSettings = { providerType: "groq", modelKey: "opus-4-5" };
    const xaiSettings: LLMSettings = { providerType: "xai", modelKey: "opus-4-5" };
    const kimiSettings: LLMSettings = { providerType: "kimi", modelKey: "opus-4-5" };
    const bedrockSettings: LLMSettings = { providerType: "bedrock", modelKey: "sonnet-4-5" };

    expect(LLMProviderFactory.applyModelSelection(openaiSettings, "gpt-4o").openai?.model).toBe(
      "gpt-4o",
    );
    expect(
      LLMProviderFactory.applyModelSelection(geminiSettings, "gemini-2.0-flash").gemini?.model,
    ).toBe("gemini-2.0-flash");
    expect(
      LLMProviderFactory.applyModelSelection(openrouterSettings, "anthropic/claude-3.5-sonnet")
        .openrouter?.model,
    ).toBe("anthropic/claude-3.5-sonnet");
    expect(LLMProviderFactory.applyModelSelection(ollamaSettings, "llama3.2").ollama?.model).toBe(
      "llama3.2",
    );
    expect(
      LLMProviderFactory.applyModelSelection(azureSettings, "new-deployment").azure?.deployment,
    ).toBe("new-deployment");
    expect(
      LLMProviderFactory.applyModelSelection(groqSettings, "llama-3.3-70b-versatile").groq?.model,
    ).toBe("llama-3.3-70b-versatile");
    expect(LLMProviderFactory.applyModelSelection(xaiSettings, "grok-4").xai?.model).toBe("grok-4");
    expect(LLMProviderFactory.applyModelSelection(kimiSettings, "kimi-k2.5").kimi?.model).toBe(
      "kimi-k2.5",
    );

    const updatedBedrock = LLMProviderFactory.applyModelSelection(
      bedrockSettings,
      "us.anthropic.claude-opus-4-6-20260115-v1:0",
    );
    expect(updatedBedrock.bedrock?.model).toBe("us.anthropic.claude-opus-4-6-20260115-v1:0");
  });

  it("can switch provider and model in one global selection", () => {
    const settings: LLMSettings = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      openai: { model: "gpt-4o-mini" },
    };

    const updated = LLMProviderFactory.applyModelSelection(
      settings,
      "gpt-4o",
      "openai",
    );

    expect(updated.providerType).toBe("openai");
    expect(updated.openai?.model).toBe("gpt-4o");
    expect(updated.modelKey).toBe("sonnet-4-5");
  });

  it("stores Azure reasoning effort without changing unsupported provider request config", () => {
    const settings: LLMSettings = {
      providerType: "azure",
      modelKey: "sonnet-4-5",
      azure: { deployment: "gpt-5-deployment" },
    };

    const updated = LLMProviderFactory.applyReasoningEffortSelection(
      settings,
      "azure",
      "high",
    );

    expect(updated.azure?.reasoningEffort).toBe("high");
  });

  it("stores selected MoA preset in MoA settings", () => {
    const settings: LLMSettings = {
      providerType: "moa",
      modelKey: "frontier-council",
      moa: {
        defaultPreset: "frontier-council",
        presets: {
          "frontier-council": {
            id: "frontier-council",
            name: "Frontier Council",
            referenceModels: [{ providerType: "openai", modelKey: "gpt-4o" }],
            aggregator: { providerType: "anthropic", modelKey: "sonnet-4-5" },
          },
          "fast-council": {
            id: "fast-council",
            name: "Fast Council",
            referenceModels: [{ providerType: "openai", modelKey: "gpt-4o-mini" }],
            aggregator: { providerType: "openai", modelKey: "gpt-4o" },
          },
        },
      },
    };

    const updated = LLMProviderFactory.applyModelSelection(settings, "fast-council");

    expect(updated.providerType).toBe("moa");
    expect(updated.modelKey).toBe("fast-council");
    expect(updated.moa?.defaultPreset).toBe("fast-council");
  });
});

describe("LLMProviderFactory MoA routing", () => {
  it("resolves the preset as model id and aggregator as context model", () => {
    const settings: LLMSettings = {
      providerType: "moa",
      modelKey: "frontier-council",
      anthropic: { apiKey: "anthropic-key" },
      openai: { apiKey: "openai-key", model: "gpt-4o" },
      moa: {
        defaultPreset: "frontier-council",
        presets: {
          "frontier-council": {
            id: "frontier-council",
            name: "Frontier Council",
            referenceModels: [{ providerType: "openai", modelKey: "gpt-4o" }],
            aggregator: { providerType: "anthropic", modelKey: "sonnet-4-5" },
          },
        },
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const resolved = LLMProviderFactory.resolveTaskModelSelection();

    expect(resolved.providerType).toBe("moa");
    expect(resolved.modelKey).toBe("frontier-council");
    expect(resolved.modelId).toBe("frontier-council");
    expect(resolved.contextModelKey).toBe("sonnet-4-5");
    expect(resolved.contextModelId).toContain("claude-sonnet-4-5");
  });

  it("does not inherit global failover providers for MoA presets", () => {
    const settings: LLMSettings = {
      providerType: "moa",
      modelKey: "frontier-council",
      fallbackProviders: [
        { providerType: "openrouter", modelKey: "openai/gpt-4o" },
      ],
      openai: { apiKey: "openai-key", model: "gpt-4o" },
      openrouter: { apiKey: "openrouter-key", model: "openai/gpt-4o" },
      moa: {
        defaultPreset: "frontier-council",
        presets: {
          "frontier-council": {
            id: "frontier-council",
            name: "Frontier Council",
            referenceModels: [{ providerType: "openai", modelKey: "gpt-4o" }],
            aggregator: { providerType: "openai", modelKey: "gpt-4o" },
          },
        },
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const primary = LLMProviderFactory.resolveTaskModelSelection();
    const chain = LLMProviderFactory.resolveProviderFailoverChain(primary);

    expect(chain.map((entry) => entry.providerType)).toEqual(["moa"]);
  });

  it("honors explicit MoA failover providers", () => {
    const settings: LLMSettings = {
      providerType: "moa",
      modelKey: "frontier-council",
      openai: { apiKey: "openai-key", model: "gpt-4o" },
      openrouter: { apiKey: "openrouter-key", model: "openai/gpt-4o" },
      moa: {
        defaultPreset: "frontier-council",
        fallbackProviders: [
          { providerType: "openrouter", modelKey: "openai/gpt-4o" },
        ],
        presets: {
          "frontier-council": {
            id: "frontier-council",
            name: "Frontier Council",
            referenceModels: [{ providerType: "openai", modelKey: "gpt-4o" }],
            aggregator: { providerType: "openai", modelKey: "gpt-4o" },
          },
        },
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const primary = LLMProviderFactory.resolveTaskModelSelection();
    const chain = LLMProviderFactory.resolveProviderFailoverChain(primary);

    expect(chain.map((entry) => entry.providerType)).toEqual(["moa", "openrouter"]);
  });
});

describe("LLMProviderFactory OpenRouter Pareto configuration", () => {
  it("passes saved Pareto coding score into OpenRouter requests", async () => {
    let capturedBody: Any = null;
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      modelKey: "openrouter/pareto-code",
      openrouter: {
        apiKey: "openrouter-key",
        model: "openrouter/pareto-code",
        paretoMinCodingScore: 0.8,
      },
    } as LLMSettings);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
        } as unknown as Response;
      }),
    );

    const provider = LLMProviderFactory.createProvider();
    await provider.createMessage({
      model: "openrouter/pareto-code",
      maxTokens: 32,
      system: "",
      messages: [{ role: "user", content: "write code" }],
    });

    expect(capturedBody.plugins).toEqual([
      { id: "pareto-router", min_coding_score: 0.8 },
    ]);
  });

  it("uses documented Pareto context length in fallback OpenRouter models", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      modelKey: "openrouter/pareto-code",
      openrouter: {},
    } as LLMSettings);

    const models = await LLMProviderFactory.getOpenRouterModels();

    expect(models.find((model) => model.id === "openrouter/pareto-code")).toMatchObject({
      context_length: 200000,
    });
    expect(models.find((model) => model.id === "openrouter/pareto-code:nitro")).toMatchObject({
      context_length: 200000,
    });
  });

  it("keeps live OpenRouter metadata when appending fallback Pareto models", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      modelKey: "openrouter/pareto-code",
      openrouter: { apiKey: "openrouter-key" },
    } as LLMSettings);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: [
              {
                id: "openrouter/pareto-code",
                name: "Pareto Code Router",
                context_length: 123456,
              },
            ],
          }),
        }) as unknown as Response,
      ),
    );

    const models = await LLMProviderFactory.getOpenRouterModels();

    expect(models.find((model) => model.id === "openrouter/pareto-code")).toMatchObject({
      context_length: 123456,
    });
    expect(models.find((model) => model.id === "openrouter/pareto-code:nitro")).toMatchObject({
      context_length: 200000,
    });
  });
});

describe("LLMProviderFactory profile-based task model routing", () => {
  it("uses the configured provider model instead of task model overrides by default", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "sonnet-4-5",
      openai: {
        model: "gpt-4o-mini",
        profileRoutingEnabled: true,
        strongModelKey: "gpt-4o",
        cheapModelKey: "gpt-4o-mini",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const resolved = LLMProviderFactory.resolveTaskModelSelection({
      providerType: "openai",
      modelKey: "gpt-4.1-mini",
      llmProfile: "cheap",
    });

    expect(resolved.modelSource).toBe("provider_default");
    expect(resolved.modelId).toBe("gpt-4o-mini");
    expect(resolved.modelKey).toBe("gpt-4o-mini");
  });

  it("uses profile model only when legacy profile routing is explicitly allowed", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "sonnet-4-5",
      openai: {
        model: "gpt-4o-mini",
        profileRoutingEnabled: true,
        strongModelKey: "gpt-4o",
        cheapModelKey: "gpt-4o-mini",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const resolved = LLMProviderFactory.resolveTaskModelSelection(
      {
        providerType: "openai",
        llmProfileHint: "strong",
      },
      { allowProfileRouting: true },
    );

    expect(resolved.modelSource).toBe("profile_model");
    expect(resolved.modelId).toBe("gpt-4o");
    expect(resolved.modelKey).toBe("gpt-4o");
  });

  it("ignores invalid profile models by default", () => {
    const settings: LLMSettings = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      anthropic: {
        profileRoutingEnabled: true,
        strongModelKey: "not-a-real-anthropic-key",
        cheapModelKey: "haiku-4-5",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const resolved = LLMProviderFactory.resolveTaskModelSelection({
      providerType: "anthropic",
      llmProfileHint: "strong",
    });

    expect(resolved.modelSource).toBe("provider_default");
    expect(resolved.modelKey).toBe("sonnet-4-5");
    expect(resolved.modelId).toBe("claude-sonnet-4-5");
    expect(resolved.warnings).toHaveLength(0);
  });

  it("normalizes legacy Claude snapshot IDs to current direct API IDs", () => {
    expect(LLMProviderFactory.getModelId("claude-haiku-4-5-20250514", "anthropic")).toBe(
      ANTHROPIC_HEALTHCHECK_MODEL_ID,
    );
    expect(LLMProviderFactory.getModelId("claude-sonnet-4-5-20250514", "anthropic")).toBe(
      "claude-sonnet-4-5",
    );
    expect(LLMProviderFactory.getModelId("opus-4-6", "anthropic")).toBe("claude-opus-4-6");
  });

  it("maps retired Claude 3.5 direct API IDs to active replacements", () => {
    expect(LLMProviderFactory.getModelId("sonnet-3-5", "anthropic")).toBe(
      "claude-sonnet-4-5",
    );
    expect(LLMProviderFactory.getModelId("haiku-3-5", "anthropic")).toBe(
      ANTHROPIC_HEALTHCHECK_MODEL_ID,
    );
    expect(
      LLMProviderFactory.getModelId("claude-3-5-haiku-20241022", "anthropic"),
    ).toBe(ANTHROPIC_HEALTHCHECK_MODEL_ID);
  });

  it("normalizes retired Anthropic profile routing keys", () => {
    const settings: LLMSettings = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      anthropic: {
        profileRoutingEnabled: true,
        strongModelKey: "sonnet-3-5",
        cheapModelKey: "haiku-3-5",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const routing = LLMProviderFactory.getProviderRoutingSettings(
      settings,
      "anthropic",
    );
    const resolved = LLMProviderFactory.resolveTaskModelSelection(
      {
        providerType: "anthropic",
        llmProfileHint: "cheap",
      },
      { allowProfileRouting: true },
    );

    expect(routing.strongModelKey).toBe("sonnet-4-5");
    expect(routing.cheapModelKey).toBe("haiku-4-5");
    expect(resolved.modelSource).toBe("profile_model");
    expect(resolved.modelKey).toBe("haiku-4-5");
    expect(resolved.modelId).toBe(ANTHROPIC_HEALTHCHECK_MODEL_ID);
  });

  it("uses strong profile for verification routing", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "sonnet-4-5",
      openai: {
        model: "gpt-4o-mini",
        profileRoutingEnabled: true,
        strongModelKey: "gpt-4o",
        cheapModelKey: "gpt-4o-mini",
        preferStrongForVerification: true,
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const resolved = LLMProviderFactory.resolveTaskModelSelection(
      {
        providerType: "openai",
        llmProfileHint: "cheap",
      },
      { isVerificationTask: true },
    );

    expect(resolved.llmProfileUsed).toBe("strong");
    expect(resolved.modelKey).toBe("gpt-4o-mini");
  });

  it("keeps forced profiles from changing the configured provider model by default", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "sonnet-4-5",
      openai: {
        model: "gpt-4o-mini",
        profileRoutingEnabled: true,
        strongModelKey: "gpt-4o",
        cheapModelKey: "gpt-4o-mini",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const resolved = LLMProviderFactory.resolveTaskModelSelection({
      providerType: "openai",
      modelKey: "gpt-4.1",
      llmProfile: "cheap",
      llmProfileForced: true,
    });

    expect(resolved.modelSource).toBe("provider_default");
    expect(resolved.modelId).toBe("gpt-4o-mini");
  });
});

describe("LLMProviderFactory provider failover chain", () => {
  it("builds an ordered chain from configured fallback providers", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "sonnet-4-5",
      openai: {
        apiKey: "openai-key",
        model: "gpt-4o-mini",
      },
      anthropic: {
        apiKey: "anthropic-key",
      },
      fallbackProviders: [
        { providerType: "anthropic", modelKey: "sonnet-4-5" },
        { providerType: "gemini", modelKey: "gemini-2.5-flash" },
        { providerType: "openai", modelKey: "gpt-4o-mini" },
      ],
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const primary = LLMProviderFactory.resolveTaskModelSelection();
    const chain = LLMProviderFactory.resolveProviderFailoverChain(primary);

    expect(chain.map((entry) => entry.providerType)).toEqual(["openai", "anthropic"]);
    expect(chain.map((entry) => entry.modelKey)).toEqual(["gpt-4o-mini", "sonnet-4-5"]);
  });

  it("keeps provider-specific failover chains isolated by primary provider", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        apiKey: "openai-key",
        model: "gpt-4o-mini",
        fallbackProviders: [{ providerType: "anthropic", modelKey: "sonnet-4-5" }],
        failoverPrimaryRetryCooldownSeconds: 15,
      },
      anthropic: {
        apiKey: "anthropic-key",
      },
      azure: {
        apiKey: "azure-key",
        endpoint: "https://azure.example.com",
        deployment: "gpt-4o",
        fallbackProviders: [{ providerType: "openrouter", modelKey: "openai/gpt-4o" }],
        failoverPrimaryRetryCooldownSeconds: 120,
      },
      openrouter: {
        apiKey: "openrouter-key",
        model: "openai/gpt-4o",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const openaiPrimary = LLMProviderFactory.resolveTaskModelSelection(
      {
        providerType: "openai",
      },
      { allowProviderOverride: true },
    );
    const openaiChain =
      LLMProviderFactory.resolveProviderFailoverChain(openaiPrimary);
    const openaiFailover = LLMProviderFactory.getProviderFailoverSettings(
      settings,
      "openai",
    );

    expect(openaiChain.map((entry) => entry.providerType)).toEqual([
      "openai",
      "anthropic",
    ]);
    expect(openaiFailover.failoverPrimaryRetryCooldownSeconds).toBe(15);

    const azurePrimary = LLMProviderFactory.resolveTaskModelSelection(
      {
        providerType: "azure",
      },
      { allowProviderOverride: true },
    );
    const azureChain =
      LLMProviderFactory.resolveProviderFailoverChain(azurePrimary);
    const azureFailover = LLMProviderFactory.getProviderFailoverSettings(
      settings,
      "azure",
    );

    expect(azureChain.map((entry) => entry.providerType)).toEqual([
      "azure",
      "openrouter",
    ]);
    expect(azureFailover.failoverPrimaryRetryCooldownSeconds).toBe(120);
  });

  it("disables automatic failover when a task explicitly overrides provider or model", () => {
    const settings: LLMSettings = {
      providerType: "openai",
      modelKey: "sonnet-4-5",
      openai: {
        apiKey: "openai-key",
        model: "gpt-4o-mini",
      },
      anthropic: {
        apiKey: "anthropic-key",
      },
      fallbackProviders: [{ providerType: "anthropic", modelKey: "sonnet-4-5" }],
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const primary = LLMProviderFactory.resolveTaskModelSelection({
      providerType: "openai",
      modelKey: "gpt-4.1-mini",
    });
    const chain = LLMProviderFactory.resolveProviderFailoverChain(primary, {
      providerType: "openai",
      modelKey: "gpt-4.1-mini",
    });

    expect(chain).toHaveLength(1);
    expect(chain[0]?.modelKey).toBe("gpt-4o-mini");
  });

  it("filters known text-only OpenRouter fallbacks for image-bearing requests", () => {
    const settings: LLMSettings = {
      providerType: "openrouter",
      modelKey: "sonnet-4-5",
      openrouter: {
        apiKey: "openrouter-key",
        model: "openai/gpt-4o",
      },
      anthropic: {
        apiKey: "anthropic-key",
      },
      fallbackProviders: [
        { providerType: "openrouter", modelKey: "minimax/minimax-m2.5:free" },
        { providerType: "anthropic", modelKey: "sonnet-4-5" },
      ],
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const primary = LLMProviderFactory.resolveTaskModelSelection();
    const chain = LLMProviderFactory.resolveProviderFailoverChain(primary, undefined, {
      requiresImageInput: true,
    });

    expect(chain.map((entry) => entry.modelId)).toEqual(
      expect.not.arrayContaining(["minimax/minimax-m2.5:free"]),
    );
    expect(chain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerType: "openrouter", modelId: "openai/gpt-4o" }),
        expect.objectContaining({
          providerType: "anthropic",
          modelId: "claude-sonnet-4-5",
        }),
      ]),
    );
  });

  it("prefers image-capable failover selections when the primary route cannot accept image input", () => {
    const settings: LLMSettings = {
      providerType: "openrouter",
      modelKey: "minimax/minimax-m2.5:free",
      openrouter: {
        apiKey: "openrouter-key",
        model: "minimax/minimax-m2.5:free",
      },
      anthropic: {
        apiKey: "anthropic-key",
      },
      fallbackProviders: [{ providerType: "anthropic", modelKey: "sonnet-4-5" }],
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);

    const primary = LLMProviderFactory.resolveTaskModelSelection();
    const chain = LLMProviderFactory.resolveProviderFailoverChain(primary, undefined, {
      requiresImageInput: true,
    });

    expect(chain[0]).toEqual(
      expect.objectContaining({
        providerType: "anthropic",
        modelId: "claude-sonnet-4-5",
      }),
    );
    expect(chain).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: "minimax/minimax-m2.5:free" }),
      ]),
    );
  });
});
