import { CUSTOM_PROVIDER_MAP } from "./llm-provider-catalog";
import { getModelAccessDescriptor } from "./model-access";
import {
  LLM_PROVIDER_TYPES,
  type LLMProviderType,
  type LLMSettingsData,
  type Workspace,
} from "./types";

export type FirstRunModelPath =
  | "account_or_subscription"
  | "local_model"
  | "gateway_or_cloud"
  | "api_key"
  | "missing";

export interface FirstRunReadiness {
  modelReady: boolean;
  modelPath: FirstRunModelPath;
  workspaceReady: boolean;
  safeStarterReady: boolean;
  providerType?: LLMProviderType;
  blockingReason?: string;
}

interface FirstRunReadinessOptions {
  workspace?: Pick<Workspace, "id" | "path" | "isTemp"> | null;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOpenAiOAuth(settings: LLMSettingsData): boolean {
  return (
    settings.openai?.authMethod === "oauth" &&
    hasText(settings.openai.accessToken) &&
    hasText(settings.openai.refreshToken)
  );
}

function hasOpenAiApiKey(settings: LLMSettingsData): boolean {
  return hasText(settings.openai?.apiKey);
}

function hasClaudeCredential(settings: LLMSettingsData): boolean {
  return hasText(settings.anthropic?.apiKey) || hasText(settings.anthropic?.subscriptionToken);
}

function hasAccountCredential(settings: LLMSettingsData, providerType: LLMProviderType): boolean {
  switch (providerType) {
    case "openai":
      return hasOpenAiOAuth(settings);
    case "anthropic":
      return (
        hasText(settings.anthropic?.subscriptionToken) ||
        (settings.anthropic?.authMethod === "subscription" &&
          hasText(settings.anthropic?.apiKey)) ||
        settings.anthropic?.apiKey?.includes("sk-ant-oat") === true
      );
    case "xai":
    case "xai-oauth":
      return (
        settings.xai?.authMethod === "oauth" &&
        hasText(settings.xai?.accessToken) &&
        hasText(settings.xai?.refreshToken)
      );
    default:
      return false;
  }
}

function modelPathForProvider(
  settings: LLMSettingsData,
  providerType: LLMProviderType,
): FirstRunModelPath {
  if (hasAccountCredential(settings, providerType)) return "account_or_subscription";

  const access = getModelAccessDescriptor(providerType);
  if (access.group === "local") return "local_model";
  if (access.group === "gateways") return "gateway_or_cloud";
  return "api_key";
}

function hasConfiguredApiKeyProvider(
  settings: LLMSettingsData,
  providerType: LLMProviderType,
): boolean {
  switch (providerType) {
    case "anthropic":
      return hasClaudeCredential(settings);
    case "openai":
      return hasOpenAiApiKey(settings) || hasOpenAiOAuth(settings);
    case "gemini":
      return hasText(settings.gemini?.apiKey);
    case "openrouter":
      return hasText(settings.openrouter?.apiKey);
    case "deepseek":
      return hasText(settings.deepseek?.apiKey);
    case "groq":
      return hasText(settings.groq?.apiKey);
    case "xai":
      return (
        hasText(settings.xai?.apiKey) ||
        (settings.xai?.authMethod === "oauth" &&
          hasText(settings.xai?.accessToken) &&
          hasText(settings.xai?.refreshToken))
      );
    case "kimi":
      return hasText(settings.kimi?.apiKey);
    case "nano-gpt":
      return hasText(settings.customProviders?.["nano-gpt"]?.apiKey);
    case "azure":
      return hasText(settings.azure?.apiKey) && hasText(settings.azure?.endpoint);
    case "azure-anthropic":
      return hasText(settings.azureAnthropic?.apiKey) && hasText(settings.azureAnthropic?.endpoint);
    case "openai-compatible":
      return (
        hasText(settings.openaiCompatible?.baseUrl) && hasText(settings.openaiCompatible?.model)
      );
    case "bedrock":
      return Boolean(
        hasText(settings.bedrock?.accessKeyId) ||
        hasText(settings.bedrock?.profile) ||
        settings.bedrock?.useDefaultCredentials === true ||
        hasText(settings.bedrock?.region),
      );
    case "ollama":
      return (
        hasText(settings.ollama?.model) ||
        (settings.providerType === "ollama" && hasText(settings.modelKey))
      );
    case "hf-agents": {
      const config = settings.customProviders?.[providerType];
      return hasText(config?.baseUrl) && hasText(config?.model);
    }
    default:
      if (CUSTOM_PROVIDER_MAP.has(providerType)) {
        const config = settings.customProviders?.[providerType];
        const catalogEntry = CUSTOM_PROVIDER_MAP.get(providerType);
        return (
          hasText(config?.apiKey) ||
          (catalogEntry?.apiKeyOptional === true &&
            hasText(config?.baseUrl) &&
            hasText(config?.model))
        );
      }
      return false;
  }
}

function getUsableProvider(settings: LLMSettingsData): {
  providerType?: LLMProviderType;
  modelPath: FirstRunModelPath;
} {
  if (hasOpenAiOAuth(settings)) {
    return { providerType: "openai", modelPath: "account_or_subscription" };
  }

  if (
    settings.providerType === "ollama" &&
    (hasText(settings.ollama?.model) || hasText(settings.modelKey))
  ) {
    return { providerType: "ollama", modelPath: "local_model" };
  }

  const providerType = settings.providerType;
  if (providerType && hasConfiguredApiKeyProvider(settings, providerType)) {
    return {
      providerType,
      modelPath: modelPathForProvider(settings, providerType),
    };
  }

  const preferredProviderOrder: LLMProviderType[] = [
    "anthropic",
    "openai",
    "gemini",
    "openrouter",
    "deepseek",
    "groq",
    "xai",
    "kimi",
    "nano-gpt",
    "azure",
    "azure-anthropic",
    "openai-compatible",
    "bedrock",
  ];
  const providerOrder = [
    ...preferredProviderOrder,
    ...LLM_PROVIDER_TYPES.filter((provider) => !preferredProviderOrder.includes(provider)),
  ];
  const fallbackProvider = providerOrder.find((candidate) =>
    hasConfiguredApiKeyProvider(settings, candidate),
  );
  if (fallbackProvider) {
    return {
      providerType: fallbackProvider,
      modelPath: modelPathForProvider(settings, fallbackProvider),
    };
  }

  return { providerType, modelPath: "missing" };
}

export function getFirstRunReadiness(
  settings: LLMSettingsData | null | undefined,
  options: FirstRunReadinessOptions = {},
): FirstRunReadiness {
  const workspaceReady = Boolean(options.workspace?.path || options.workspace?.id);
  const selection = settings ? getUsableProvider(settings) : { modelPath: "missing" as const };
  const modelReady = selection.modelPath !== "missing";
  return {
    modelReady,
    modelPath: selection.modelPath,
    workspaceReady,
    safeStarterReady: modelReady && workspaceReady,
    providerType: selection.providerType,
    blockingReason: modelReady
      ? undefined
      : "Connect a supported account, API or gateway, cloud credential, or local model before running AI tasks.",
  };
}

export function getFirstRunReadinessActionLabel(readiness: FirstRunReadiness): string {
  if (readiness.modelReady) return "Ready";
  return "Set up AI";
}
