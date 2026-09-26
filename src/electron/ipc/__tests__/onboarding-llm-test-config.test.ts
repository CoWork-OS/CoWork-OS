import { describe, expect, it } from "vitest";

import { isModelPriced } from "../../agent/llm/pricing";
import {
  ONBOARDING_CUSTOM_PROVIDERS,
  buildOnboardingLLMTestConfig,
  getOnboardingDefaultModel,
} from "../../../renderer/hooks/useOnboardingFlow";
import { LLMSettingsSchema } from "../../utils/validation";

describe("buildOnboardingLLMTestConfig", () => {
  it("includes the selected OpenRouter model required by the LLM IPC schema", () => {
    const config = buildOnboardingLLMTestConfig(
      "openrouter",
      "sk-or-test-key",
      "http://localhost:11434",
    );

    expect(config).toMatchObject({
      providerType: "openrouter",
      modelKey: "openrouter/free",
      openrouter: {
        apiKey: "sk-or-test-key",
        model: "openrouter/free",
      },
    });
    expect(LLMSettingsSchema.safeParse(config).success).toBe(true);
  });

  it.each(["opencode-go", "zai", "minimax", "nano-gpt"] as const)(
    "sets up %s with only an API key, using its pay-as-you-go endpoint",
    (provider) => {
      const config = buildOnboardingLLMTestConfig(provider, "test-key", "http://localhost:11434");
      const preset = ONBOARDING_CUSTOM_PROVIDERS[provider];

      expect(config).toMatchObject({
        providerType: provider,
        modelKey: preset?.model,
        customProviders: {
          [provider]: { apiKey: "test-key", baseUrl: preset?.baseUrl, model: preset?.model },
        },
      });
      expect(LLMSettingsSchema.safeParse(config).success).toBe(true);
    },
  );

  it("does not preset Z.ai's coding-plan endpoint", () => {
    expect(ONBOARDING_CUSTOM_PROVIDERS.zai?.baseUrl).not.toContain("/coding/");
  });

  it.each(["opencode-go", "zai", "minimax"] as const)(
    "defaults %s to a model CoWork can price",
    (provider) => {
      expect(isModelPriced(getOnboardingDefaultModel(provider))).toBe(true);
    },
  );
});
