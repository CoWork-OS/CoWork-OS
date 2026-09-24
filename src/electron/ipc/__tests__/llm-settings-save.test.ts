import { describe, expect, it } from "vitest";
import type { LLMSettingsData } from "../../../shared/types";
import { LLMSettingsSchema } from "../../utils/validation";
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
    expect(saved.cachedOpenRouterModels).toEqual(existingSettings.cachedOpenRouterModels);
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

  it("merges Jev routes without dropping either provider credential", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openrouter",
      modelKey: "openrouter/free",
      openrouter: { apiKey: "main-openrouter-key" },
      jev: {
        enabled: true,
        provider: "openrouter",
        teamSelectionEnabled: true,
        harnessEnabled: true,
        toolReviewMode: "observe",
        typesafe: {
          apiKey: "typesafe-key",
          model: "jev-latest",
        },
        openrouter: {
          apiKey: "jev-openrouter-key",
          reuseOpenRouterKey: false,
        },
      },
    };

    const saved = buildSavedLLMSettings(
      {
        providerType: "openrouter",
        modelKey: "openrouter/free",
        jev: {
          provider: "typesafe",
          typesafe: { model: "jev-1.13" },
        },
      },
      existingSettings,
    );

    expect(saved.jev).toEqual({
      enabled: true,
      provider: "typesafe",
      teamSelectionEnabled: true,
      harnessEnabled: true,
      toolReviewMode: "observe",
      typesafe: {
        apiKey: "typesafe-key",
        model: "jev-1.13",
      },
      openrouter: {
        apiKey: "jev-openrouter-key",
        reuseOpenRouterKey: false,
      },
    });
  });

  it("supports an explicit Jev credential clear while preserving omitted credentials", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "typesafe",
      modelKey: "gpt-5.5",
      jev: {
        typesafe: { apiKey: "typesafe-key" },
        openrouter: { apiKey: "jev-openrouter-key" },
      },
    };

    const saved = buildSavedLLMSettings(
      {
        providerType: "typesafe",
        modelKey: "gpt-5.5",
        jev: {
          typesafe: { model: "jev-latest" },
          openrouter: { clearApiKey: true },
        },
      },
      existingSettings,
    );

    expect(saved.jev?.typesafe?.apiKey).toBe("typesafe-key");
    expect(saved.jev?.openrouter?.apiKey).toBeUndefined();
    expect(saved.jev?.openrouter).not.toHaveProperty("clearApiKey");
  });

  it("preserves MoA presets while merging partial saves", () => {
    const existingSettings: LLMSettingsData = {
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
        },
        profileRoutingEnabled: true,
        strongModelKey: "frontier-council",
        cheapModelKey: "frontier-council",
      },
    };

    const validated: LLMSettingsData = {
      providerType: "moa",
      modelKey: "frontier-council",
      moa: {
        defaultPreset: "frontier-council",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.moa?.defaultPreset).toBe("frontier-council");
    expect(saved.moa?.presets?.["frontier-council"]).toEqual(
      existingSettings.moa?.presets?.["frontier-council"],
    );
    expect(saved.moa?.profileRoutingEnabled).toBe(true);
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
      fallbackProviders: [{ providerType: "anthropic", modelKey: "sonnet-4-5" }],
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

  it("persists OpenAI reasoning and verbosity settings", () => {
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

describe("LLMSettingsSchema", () => {
  it("accepts both Jev provider routes and bounded decision settings", () => {
    const parsed = LLMSettingsSchema.parse({
      providerType: "openrouter",
      modelKey: "openrouter/free",
      jev: {
        enabled: true,
        provider: "openrouter",
        harnessEnabled: true,
        toolReviewMode: "observe",
        openrouter: {
          apiKey: "test-key",
          model: "~typesafe/jev-latest",
          baseUrl: "https://openrouter.ai",
          reuseOpenRouterKey: true,
        },
        timeoutMs: 1000,
        maxRetries: 2,
      },
    });

    expect(parsed.jev?.provider).toBe("openrouter");
    expect(parsed.jev?.harnessEnabled).toBe(true);
    expect(parsed.jev?.toolReviewMode).toBe("observe");
    expect(parsed.jev?.openrouter?.reuseOpenRouterKey).toBe(true);
  });

  it("accepts active Jev harness mode", () => {
    const parsed = LLMSettingsSchema.parse({
      providerType: "openrouter",
      modelKey: "openrouter/free",
      jev: {
        enabled: true,
        harnessEnabled: true,
        toolReviewMode: "active",
        typesafe: { apiKey: "test-key" },
      },
    });

    expect(parsed.jev?.toolReviewMode).toBe("active");
  });

  it.each(["max", "ultra"] as const)(
    "accepts the GPT-5.6 %s reasoning effort",
    (reasoningEffort) => {
      const parsed = LLMSettingsSchema.parse({
        providerType: "openai",
        modelKey: "gpt-5.6-sol",
        openai: {
          authMethod: "oauth",
          model: "gpt-5.6-sol",
          reasoningEffort,
        },
      });

      expect(parsed.openai?.reasoningEffort).toBe(reasoningEffort);
    },
  );

  it("accepts GPT-6 Sol API none and Azure Luna max reasoning settings", () => {
    const openai = LLMSettingsSchema.parse({
      providerType: "openai",
      modelKey: "gpt-6-sol",
      openai: { authMethod: "api_key", model: "gpt-6-sol", reasoningEffort: "none" },
    });
    const azure = LLMSettingsSchema.parse({
      providerType: "azure",
      modelKey: "gpt-6-luna",
      azure: { deployment: "gpt-6-luna", reasoningEffort: "max" },
    });

    expect(openai.openai?.reasoningEffort).toBe("none");
    expect(azure.azure?.reasoningEffort).toBe("max");
  });

  it("accepts long OpenAI OAuth tokens and account metadata", () => {
    const accessToken = "a".repeat(5000);
    const refreshToken = "r".repeat(5000);

    const parsed = LLMSettingsSchema.parse({
      providerType: "openai",
      modelKey: "gpt-5.5",
      openai: {
        authMethod: "oauth",
        model: "gpt-5.5",
        accessToken,
        refreshToken,
        tokenExpiresAt: 12345,
        accountId: "acct_test",
        email: "user@example.com",
      },
    });

    expect(parsed.openai?.accessToken).toBe(accessToken);
    expect(parsed.openai?.refreshToken).toBe(refreshToken);
    expect(parsed.openai?.accountId).toBe("acct_test");
    expect(parsed.openai?.email).toBe("user@example.com");
  });

  it("keeps OpenAI OAuth token validation bounded", () => {
    expect(() =>
      LLMSettingsSchema.parse({
        providerType: "openai",
        modelKey: "gpt-5.5",
        openai: {
          authMethod: "oauth",
          model: "gpt-5.5",
          accessToken: "a".repeat(16 * 1024 + 1),
        },
      }),
    ).toThrow();
  });
});
