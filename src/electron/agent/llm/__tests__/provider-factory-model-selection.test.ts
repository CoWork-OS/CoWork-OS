import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory, type LLMSettings } from "../provider-factory";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLMProviderFactory model status", () => {
  it.each([
    {
      name: "anthropic",
      settings: { providerType: "anthropic", modelKey: "sonnet-4-5" } as LLMSettings,
      expectedCurrentModel: "sonnet-4-5",
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
        openrouter: { model: "anthropic/claude-3.5-sonnet" },
      } as LLMSettings,
      expectedCurrentModel: "anthropic/claude-3.5-sonnet",
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
});

describe("LLMProviderFactory profile-based task model routing", () => {
  it("prefers explicit task model override when profile is not forced", () => {
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

    expect(resolved.modelSource).toBe("explicit_override");
    expect(resolved.modelId).toBe("gpt-4.1-mini");
    expect(resolved.modelKey).toBe("gpt-4.1-mini");
  });

  it("uses profile model when routing is enabled and no explicit override exists", () => {
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
      llmProfileHint: "strong",
    });

    expect(resolved.modelSource).toBe("profile_model");
    expect(resolved.modelId).toBe("gpt-4o");
    expect(resolved.modelKey).toBe("gpt-4o");
  });

  it("falls back to provider default model when profile model is invalid", () => {
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
    expect(resolved.modelId).toBe("claude-sonnet-4-5-20250514");
    expect(resolved.warnings.length).toBeGreaterThan(0);
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
    expect(resolved.modelKey).toBe("gpt-4o");
  });

  it("respects forced profile routing over explicit model override", () => {
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

    expect(resolved.modelSource).toBe("profile_model");
    expect(resolved.modelId).toBe("gpt-4o-mini");
  });
});
