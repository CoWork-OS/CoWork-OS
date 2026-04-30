import { describe, expect, it } from "vitest";
import type { LLMSettingsData } from "../../../shared/types";
import { buildSavedLLMSettings } from "../llm-settings-save";

describe("buildSavedLLMSettings", () => {
  it("persists fallbackProviders while preserving cached model metadata", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openrouter",
      modelKey: "openrouter/free",
      cachedOpenRouterModels: [
        {
          key: "openrouter/free",
          displayName: "OpenRouter Free",
          description: "cached",
        },
      ],
    };

    const validated: LLMSettingsData = {
      providerType: "openrouter",
      modelKey: "openrouter/free",
      fallbackProviders: [
        { providerType: "anthropic", modelKey: "sonnet-4-5" },
        { providerType: "openai", modelKey: "gpt-4.1-mini" },
      ],
      failoverPrimaryRetryCooldownSeconds: 90,
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.fallbackProviders).toEqual(validated.fallbackProviders);
    expect(saved.failoverPrimaryRetryCooldownSeconds).toBe(90);
    expect(saved.cachedOpenRouterModels).toEqual(
      existingSettings.cachedOpenRouterModels,
    );
  });

  it("preserves provider-specific failover settings while merging partial saves", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        apiKey: "existing-openai-key",
        model: "gpt-4o-mini",
        fallbackProviders: [
          { providerType: "anthropic", modelKey: "sonnet-4-5" },
          { providerType: "openrouter", modelKey: "openai/gpt-4o" },
        ],
        failoverPrimaryRetryCooldownSeconds: 45,
      },
    };

    const validated: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4.1-mini",
      openai: {
        model: "gpt-4.1-mini",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.openai).toEqual({
      apiKey: "existing-openai-key",
      model: "gpt-4.1-mini",
      fallbackProviders: [
        { providerType: "anthropic", modelKey: "sonnet-4-5" },
        { providerType: "openrouter", modelKey: "openai/gpt-4o" },
      ],
      failoverPrimaryRetryCooldownSeconds: 45,
    });
  });

  it("preserves fallbackProviders and provider credentials when partial saves omit them", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openrouter",
      modelKey: "openrouter/sonoma",
      fallbackProviders: [
        { providerType: "anthropic", modelKey: "sonnet-4-5" },
        { providerType: "openai", modelKey: "gpt-4.1-mini" },
      ],
      openrouter: {
        apiKey: "existing-openrouter-key",
        model: "openrouter/sonoma",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      anthropic: {
        apiKey: "existing-anthropic-key",
      },
    };

    const validated: LLMSettingsData = {
      providerType: "openrouter",
      modelKey: "openrouter/free",
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.fallbackProviders).toEqual(existingSettings.fallbackProviders);
    expect(saved.openrouter).toEqual(existingSettings.openrouter);
    expect(saved.anthropic).toEqual(existingSettings.anthropic);
  });

  it("merges partial provider updates without dropping sibling settings", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openrouter",
      modelKey: "openrouter/free",
      openrouter: {
        apiKey: "existing-openrouter-key",
        model: "openrouter/free",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    };

    const validated: LLMSettingsData = {
      providerType: "openrouter",
      modelKey: "openrouter/pro",
      openrouter: {
        model: "openrouter/pro",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.openrouter).toEqual({
      apiKey: "existing-openrouter-key",
      model: "openrouter/pro",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("preserves OpenAI OAuth tokens when saving unrelated settings changes", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4.1",
      openai: {
        authMethod: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiresAt: 12345,
        accountId: "acct_existing",
        email: "user@example.com",
      },
    };

    const validated: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4.1",
      fallbackProviders: [
        { providerType: "anthropic", modelKey: "sonnet-4-5" },
      ],
      openai: {
        model: "gpt-4.1",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.openai).toMatchObject({
      authMethod: "oauth",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: 12345,
      accountId: "acct_existing",
      email: "user@example.com",
      model: "gpt-4.1",
    });
    expect(saved.fallbackProviders).toEqual(validated.fallbackProviders);
  });

  it("persists OpenAI GPT-5.5 reasoning and verbosity settings", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-5.5",
      openai: {
        apiKey: "sk-existing",
        model: "gpt-5.5",
        authMethod: "api_key",
      },
    };

    const validated: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-5.5",
      openai: {
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        textVerbosity: "low",
        authMethod: "api_key",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.openai).toEqual({
      apiKey: "sk-existing",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      textVerbosity: "low",
      authMethod: "api_key",
    });
  });

  it("allows switching OpenAI auth from OAuth to API key", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4.1",
      openai: {
        authMethod: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiresAt: 12345,
        accountId: "acct_existing",
        email: "user@example.com",
      },
    };

    const validated: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4.1",
      openai: {
        apiKey: "sk-new-api-key",
        model: "gpt-4.1",
        authMethod: "api_key",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.openai).toEqual({
      apiKey: "sk-new-api-key",
      model: "gpt-4.1",
      authMethod: "api_key",
    });
  });

  it("trims pasted provider credentials before saving", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "anthropic-compatible",
      modelKey: "sonnet-4-5",
    };

    const validated: LLMSettingsData = {
      providerType: "anthropic-compatible",
      modelKey: "sonnet-4-5",
      openaiCompatible: {
        apiKey: " nano-openai-key\r\n",
        baseUrl: " https://nano-gpt.com/api/v1/ ",
        model: " openai/gpt-5.2 ",
      },
      customProviders: {
        "anthropic-compatible": {
          apiKey: "\r\nnano-anthropic-key ",
          baseUrl: " https://nano-gpt.com/api/v1 ",
          model: "\tmoonshotai/kimi-k2.6:thinking\n",
        },
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.openaiCompatible).toMatchObject({
      apiKey: "nano-openai-key",
      baseUrl: "https://nano-gpt.com/api/v1/",
      model: "openai/gpt-5.2",
    });
    expect(saved.customProviders?.["anthropic-compatible"]).toMatchObject({
      apiKey: "nano-anthropic-key",
      baseUrl: "https://nano-gpt.com/api/v1",
      model: "moonshotai/kimi-k2.6:thinking",
    });
  });

  it("persists hidden prompt-caching settings without disturbing provider settings", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      anthropic: {
        apiKey: "existing-key",
      },
      promptCaching: {
        mode: "off",
        ttl: "5m",
      },
    };

    const validated: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      anthropic: {
        apiKey: "existing-key",
      },
      promptCaching: {
        mode: "auto",
        ttl: "1h",
        openRouterClaudeStrategy: "explicit_system_and_3",
        strictStablePrefix: true,
        surfaceCoverage: {
          executor: true,
          followUps: true,
          chatMode: true,
          sideCalls: false,
        },
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.promptCaching).toEqual(validated.promptCaching);
    expect(saved.anthropic).toEqual(existingSettings.anthropic);
  });

  it("persists Claude subscription auth settings", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
    };

    const validated: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      anthropic: {
        authMethod: "subscription",
        subscriptionToken: "sk-ant-oat01-subscription-token",
        apiKey: "sk-ant-api-key",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.anthropic).toMatchObject({
      authMethod: "subscription",
      subscriptionToken: "sk-ant-oat01-subscription-token",
      apiKey: "sk-ant-api-key",
    });
  });
});
