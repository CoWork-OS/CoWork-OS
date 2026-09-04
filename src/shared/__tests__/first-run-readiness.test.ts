import { describe, expect, it } from "vitest";
import { getFirstRunReadiness } from "../first-run-readiness";
import type { LLMSettingsData } from "../types";

const workspace = { id: "workspace-1", path: "/tmp/workspace", isTemp: true };

describe("first-run readiness", () => {
  it("treats ChatGPT subscription OAuth as the easiest ready path", () => {
    const settings: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      openai: {
        authMethod: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
    };

    expect(getFirstRunReadiness(settings, { workspace })).toMatchObject({
      modelReady: true,
      modelPath: "account_or_subscription",
      providerType: "openai",
      safeStarterReady: true,
    });
  });

  it("requires both ChatGPT OAuth tokens before marking the model ready", () => {
    const settings: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-5.5",
      openai: {
        authMethod: "oauth",
        accessToken: "access-token",
      },
    };

    expect(getFirstRunReadiness(settings, { workspace })).toMatchObject({
      modelReady: false,
      modelPath: "missing",
      safeStarterReady: false,
    });
  });

  it("treats configured Ollama as local ready path without an API key", () => {
    const settings: LLMSettingsData = {
      providerType: "ollama",
      modelKey: "llama3.2",
      ollama: {
        baseUrl: "http://localhost:11434",
        model: "llama3.2",
      },
    };

    expect(getFirstRunReadiness(settings, { workspace })).toMatchObject({
      modelReady: true,
      modelPath: "local_model",
      providerType: "ollama",
    });
  });

  it("treats configured MLX-LM as local ready path without an API key", () => {
    const settings: LLMSettingsData = {
      providerType: "mlx",
      modelKey: "mlx-community/Qwen3-8B-4bit",
      customProviders: {
        mlx: {
          baseUrl: "http://localhost:8080/v1",
          model: "mlx-community/Qwen3-8B-4bit",
        },
      },
    };

    expect(getFirstRunReadiness(settings, { workspace })).toMatchObject({
      modelReady: true,
      modelPath: "local_model",
      providerType: "mlx",
    });
  });

  it("does not treat the default Anthropic route as ready without credentials", () => {
    const settings: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
    };

    expect(getFirstRunReadiness(settings, { workspace })).toMatchObject({
      modelReady: false,
      modelPath: "missing",
    });
  });

  it("classifies Claude account tokens separately from API keys", () => {
    const settings: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      anthropic: {
        authMethod: "subscription",
        subscriptionToken: "sk-ant-oat-example",
      },
    };

    expect(getFirstRunReadiness(settings, { workspace })).toMatchObject({
      modelReady: true,
      modelPath: "account_or_subscription",
      providerType: "anthropic",
    });
  });

  it("recognizes a configured compatible gateway", () => {
    const settings: LLMSettingsData = {
      providerType: "openai-compatible",
      modelKey: "custom-model",
      openaiCompatible: {
        baseUrl: "https://gateway.example.test/v1",
        model: "custom-model",
      },
    };

    expect(getFirstRunReadiness(settings, { workspace })).toMatchObject({
      modelReady: true,
      modelPath: "gateway_or_cloud",
      providerType: "openai-compatible",
    });
  });
});
