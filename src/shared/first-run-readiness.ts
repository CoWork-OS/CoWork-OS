import type { LLMProviderType, LLMSettingsData, Workspace } from "./types";

export type FirstRunModelPath =
  | "chatgpt_subscription"
  | "local_ollama"
  | "saved_provider"
  | "api_key_provider"
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

function hasConfiguredApiKeyProvider(settings: LLMSettingsData, providerType: LLMProviderType): boolean {
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
      return hasText(settings.xai?.apiKey) || (
        settings.xai?.authMethod === "oauth" &&
        hasText(settings.xai?.accessToken) &&
        hasText(settings.xai?.refreshToken)
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
      return hasText(settings.openaiCompatible?.baseUrl) && hasText(settings.openaiCompatible?.model);
    case "bedrock":
      return Boolean(
        hasText(settings.bedrock?.accessKeyId) ||
          hasText(settings.bedrock?.profile) ||
          settings.bedrock?.useDefaultCredentials === true ||
          hasText(settings.bedrock?.region),
      );
    default:
      return false;
  }
}

function getUsableProvider(settings: LLMSettingsData): {
  providerType?: LLMProviderType;
  modelPath: FirstRunModelPath;
} {
  if (hasOpenAiOAuth(settings)) {
    return { providerType: "openai", modelPath: "chatgpt_subscription" };
  }

  if (
    settings.providerType === "ollama" &&
    (hasText(settings.ollama?.model) || hasText(settings.modelKey))
  ) {
    return { providerType: "ollama", modelPath: "local_ollama" };
  }

  const providerType = settings.providerType;
  if (providerType && hasConfiguredApiKeyProvider(settings, providerType)) {
    return {
      providerType,
      modelPath: providerType === "bedrock" ? "saved_provider" : "api_key_provider",
    };
  }

  const providerOrder: LLMProviderType[] = [
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
  const fallbackProvider = providerOrder.find((candidate) =>
    hasConfiguredApiKeyProvider(settings, candidate),
  );
  if (fallbackProvider) {
    return {
      providerType: fallbackProvider,
      modelPath: fallbackProvider === "bedrock" ? "saved_provider" : "api_key_provider",
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
      : "Connect ChatGPT, local Ollama, or an API key before running AI tasks.",
  };
}

export function getFirstRunReadinessActionLabel(readiness: FirstRunReadiness): string {
  if (readiness.modelReady) return "Ready";
  return "Set up AI";
}
