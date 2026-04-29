import type { LLMSettingsData } from "../../shared/types";

function mergeProviderSettings<T extends object>(
  incoming?: T,
  existing?: T,
): T | undefined {
  if (!incoming && !existing) return undefined;
  if (!incoming) return existing;
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
  };
}

function normalizeAzureSettings(
  incoming?: LLMSettingsData["azure"],
  existing?: LLMSettingsData["azure"],
): LLMSettingsData["azure"] | undefined {
  if (!incoming && !existing) return undefined;
  const mergedDeployments = [...(incoming?.deployments || []), ...(existing?.deployments || [])]
    .map((entry) => entry.trim())
    .filter(Boolean);
  const deployment = (
    incoming?.deployment ||
    existing?.deployment ||
    mergedDeployments[0] ||
    ""
  ).trim();
  if (deployment && !mergedDeployments.includes(deployment)) {
    mergedDeployments.unshift(deployment);
  }
  return {
    ...existing,
    ...incoming,
    deployment: deployment || undefined,
    deployments: mergedDeployments.length > 0 ? Array.from(new Set(mergedDeployments)) : undefined,
  };
}

function normalizeAzureAnthropicSettings(
  incoming?: LLMSettingsData["azureAnthropic"],
  existing?: LLMSettingsData["azureAnthropic"],
): LLMSettingsData["azureAnthropic"] | undefined {
  if (!incoming && !existing) return undefined;
  const mergedDeployments = [...(incoming?.deployments || []), ...(existing?.deployments || [])]
    .map((entry) => entry.trim())
    .filter(Boolean);
  const deployment = (
    incoming?.deployment ||
    existing?.deployment ||
    mergedDeployments[0] ||
    ""
  ).trim();
  if (deployment && !mergedDeployments.includes(deployment)) {
    mergedDeployments.unshift(deployment);
  }
  return {
    ...existing,
    ...incoming,
    deployment: deployment || undefined,
    deployments: mergedDeployments.length > 0 ? Array.from(new Set(mergedDeployments)) : undefined,
  };
}

export function buildSavedLLMSettings(
  validated: LLMSettingsData,
  existingSettings: LLMSettingsData,
): LLMSettingsData {
  const existingOpenAISettings = existingSettings.openai;
  const incomingOpenAISettings = validated.openai;
  let openaiSettings = mergeProviderSettings(
    incomingOpenAISettings,
    existingOpenAISettings,
  );
  const shouldPreserveOpenAIOAuthTokens =
    existingOpenAISettings?.authMethod === "oauth" &&
    validated.openai?.authMethod !== "api_key";
  if (validated.openai?.authMethod === "api_key" && openaiSettings) {
    delete openaiSettings.accessToken;
    delete openaiSettings.refreshToken;
    delete openaiSettings.tokenExpiresAt;
    delete openaiSettings.accountId;
    delete openaiSettings.email;
  }
  if (shouldPreserveOpenAIOAuthTokens && existingOpenAISettings) {
    openaiSettings = {
      ...openaiSettings,
      accessToken: existingOpenAISettings.accessToken,
      refreshToken: existingOpenAISettings.refreshToken,
      tokenExpiresAt: existingOpenAISettings.tokenExpiresAt,
      accountId: existingOpenAISettings.accountId,
      email: existingOpenAISettings.email,
      authMethod:
        incomingOpenAISettings?.authMethod || existingOpenAISettings.authMethod,
    };
  }

  return {
    providerType: validated.providerType,
    modelKey: validated.modelKey,
    fallbackProviders: Object.prototype.hasOwnProperty.call(
      validated,
      "fallbackProviders",
    )
      ? validated.fallbackProviders
      : existingSettings.fallbackProviders,
    failoverPrimaryRetryCooldownSeconds: Object.prototype.hasOwnProperty.call(
      validated,
      "failoverPrimaryRetryCooldownSeconds",
    )
      ? validated.failoverPrimaryRetryCooldownSeconds
      : existingSettings.failoverPrimaryRetryCooldownSeconds,
    promptCaching: validated.promptCaching ?? existingSettings.promptCaching,
    anthropic: mergeProviderSettings(validated.anthropic, existingSettings.anthropic),
    bedrock: mergeProviderSettings(validated.bedrock, existingSettings.bedrock),
    ollama: mergeProviderSettings(validated.ollama, existingSettings.ollama),
    gemini: mergeProviderSettings(validated.gemini, existingSettings.gemini),
    openrouter: mergeProviderSettings(
      validated.openrouter,
      existingSettings.openrouter,
    ),
    openai: openaiSettings,
    azure: normalizeAzureSettings(validated.azure, existingSettings.azure),
    azureAnthropic: normalizeAzureAnthropicSettings(
      validated.azureAnthropic,
      existingSettings.azureAnthropic,
    ),
    groq: mergeProviderSettings(validated.groq, existingSettings.groq),
    xai: mergeProviderSettings(validated.xai, existingSettings.xai),
    kimi: mergeProviderSettings(validated.kimi, existingSettings.kimi),
    openaiCompatible: mergeProviderSettings(
      validated.openaiCompatible,
      existingSettings.openaiCompatible,
    ),
    customProviders: validated.customProviders ?? existingSettings.customProviders,
    imageGeneration: validated.imageGeneration ?? existingSettings.imageGeneration,
    videoGeneration: validated.videoGeneration ?? existingSettings.videoGeneration,
    cachedAnthropicModels: existingSettings.cachedAnthropicModels,
    cachedGeminiModels: existingSettings.cachedGeminiModels,
    cachedOpenRouterModels: existingSettings.cachedOpenRouterModels,
    cachedOllamaModels: existingSettings.cachedOllamaModels,
    cachedBedrockModels: existingSettings.cachedBedrockModels,
    cachedOpenAIModels: existingSettings.cachedOpenAIModels,
    cachedGroqModels: existingSettings.cachedGroqModels,
    cachedXaiModels: existingSettings.cachedXaiModels,
    cachedKimiModels: existingSettings.cachedKimiModels,
    cachedOpenAICompatibleModels: existingSettings.cachedOpenAICompatibleModels,
  };
}
