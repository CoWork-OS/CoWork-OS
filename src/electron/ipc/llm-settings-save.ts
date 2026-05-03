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

function cleanString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

const PROVIDER_STRING_KEYS = [
  "apiKey",
  "subscriptionToken",
  "baseUrl",
  "model",
  "provider",
  "endpoint",
  "deployment",
  "apiVersion",
  "region",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "profile",
] as const;

function cleanProviderSettings<T extends object>(
  settings?: T,
): T | undefined {
  if (!settings) return undefined;
  const cleaned = { ...settings };
  const mutableCleaned = cleaned as Record<string, unknown>;
  for (const key of PROVIDER_STRING_KEYS) {
    const value = mutableCleaned[key];
    if (typeof value === "string") {
      mutableCleaned[key] = cleanString(value);
    }
  }
  return cleaned;
}

function cleanCustomProviders(
  providers?: LLMSettingsData["customProviders"],
): LLMSettingsData["customProviders"] | undefined {
  if (!providers) return undefined;
  const cleaned: NonNullable<LLMSettingsData["customProviders"]> = {};
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    cleaned[providerId] = cleanProviderSettings(providerConfig) ?? {};
  }
  return cleaned;
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
    anthropic: cleanProviderSettings(
      mergeProviderSettings(validated.anthropic, existingSettings.anthropic),
    ),
    bedrock: cleanProviderSettings(
      mergeProviderSettings(validated.bedrock, existingSettings.bedrock),
    ),
    ollama: cleanProviderSettings(
      mergeProviderSettings(validated.ollama, existingSettings.ollama),
    ),
    gemini: cleanProviderSettings(
      mergeProviderSettings(validated.gemini, existingSettings.gemini),
    ),
    openrouter: cleanProviderSettings(
      mergeProviderSettings(validated.openrouter, existingSettings.openrouter),
    ),
    deepseek: cleanProviderSettings(
      mergeProviderSettings(validated.deepseek, existingSettings.deepseek),
    ),
    openai: cleanProviderSettings(openaiSettings),
    azure: normalizeAzureSettings(validated.azure, existingSettings.azure),
    azureAnthropic: normalizeAzureAnthropicSettings(
      validated.azureAnthropic,
      existingSettings.azureAnthropic,
    ),
    groq: cleanProviderSettings(
      mergeProviderSettings(validated.groq, existingSettings.groq),
    ),
    xai: cleanProviderSettings(
      mergeProviderSettings(validated.xai, existingSettings.xai),
    ),
    kimi: cleanProviderSettings(
      mergeProviderSettings(validated.kimi, existingSettings.kimi),
    ),
    openaiCompatible: cleanProviderSettings(
      mergeProviderSettings(
        validated.openaiCompatible,
        existingSettings.openaiCompatible,
      ),
    ),
    customProviders: cleanCustomProviders(
      validated.customProviders ?? existingSettings.customProviders,
    ),
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
    cachedDeepSeekModels: existingSettings.cachedDeepSeekModels,
    cachedOpenAICompatibleModels: existingSettings.cachedOpenAICompatibleModels,
  };
}
