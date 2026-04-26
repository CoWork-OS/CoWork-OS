import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
import {
  LLMProvider,
  LLMProviderConfig,
  LLMProviderType,
  LLMRequest,
  LLMResponse,
  MODELS,
  GEMINI_MODELS,
  OPENROUTER_MODELS,
  OLLAMA_MODELS,
  GROQ_MODELS,
  XAI_MODELS,
  KIMI_MODELS,
  ModelKey,
  DEFAULT_MODEL,
  DEFAULT_PI_MODEL,
  normalizeAnthropicModelId,
} from "./types";
import { AnthropicProvider } from "./anthropic-provider";
import { BedrockProvider } from "./bedrock-provider";
import { OllamaProvider } from "./ollama-provider";
import { GeminiProvider } from "./gemini-provider";
import {
  OPENROUTER_DEFAULT_MODEL,
  OpenRouterProvider,
} from "./openrouter-provider";
import { OpenAIProvider } from "./openai-provider";
import { AzureOpenAIProvider } from "./azure-openai-provider";
import { AzureAnthropicProvider } from "./azure-anthropic-provider";
import { GroqProvider } from "./groq-provider";
import { XAIProvider } from "./xai-provider";
import { KimiProvider } from "./kimi-provider";
import { PiProvider } from "./pi-provider";
import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { GitHubCopilotProvider } from "./github-copilot-provider";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import {
  CUSTOM_PROVIDER_CATALOG,
  CUSTOM_PROVIDER_MAP,
  CUSTOM_PROVIDER_IDS,
  type ProviderCatalogEntry,
} from "../../../shared/llm-provider-catalog";
import { withLlmModelSelectionMetadata } from "../../../shared/llm-model-selection";
import { resolveModelPreferenceToModelKey } from "../../../shared/agent-preferences";
import type {
  AgentConfig,
  CustomProviderConfig,
  LLMReasoningEffort,
  LlmProfile,
  LLMProviderFallbackConfig,
  PromptCachingSettings,
} from "../../../shared/types";
import { getUserDataDir } from "../../utils/user-data-dir";
import { getSafeStorage } from "../../utils/safe-storage";
import { createLogger } from "../../utils/logger";
import { loadPiAiModule } from "./pi-ai-loader";
import { ModelCapabilityRegistry } from "./ModelCapabilityRegistry";
import { normalizePromptCachingSettings } from "./prompt-cache";

const LEGACY_SETTINGS_FILE = "llm-settings.json";
const MASKED_VALUE = "***configured***";
const ENCRYPTED_PREFIX = "encrypted:";
let llmCallLogCounter = 0;
const observedModelMaxTokens = new Map<string, number>();
const logger = createLogger("LLMProviderFactory");
const CUSTOM_PROVIDER_ALIASES: Partial<
  Record<LLMProviderType, LLMProviderType>
> = {
  "kimi-coding": "kimi-code",
};

function safeContentLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value == null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function summarizeLLMRequest(request: LLMRequest): Record<string, unknown> {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  let userMessages = 0;
  let assistantMessages = 0;
  let textBlocks = 0;
  let textChars = 0;
  let toolUseBlocks = 0;
  let toolResultBlocks = 0;
  let toolResultChars = 0;
  let toolResultErrors = 0;

  for (const message of messages) {
    if (message?.role === "user") userMessages++;
    else if (message?.role === "assistant") assistantMessages++;

    const content: Any = (message as Any)?.content;
    if (typeof content === "string") {
      textBlocks++;
      textChars += content.length;
      continue;
    }

    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const type = (block as Any).type;
      if (type === "text") {
        const text = (block as Any).text;
        if (typeof text === "string") {
          textBlocks++;
          textChars += text.length;
        }
      } else if (type === "tool_use") {
        toolUseBlocks++;
      } else if (type === "tool_result") {
        toolResultBlocks++;
        toolResultChars += safeContentLength((block as Any).content);
        if ((block as Any).is_error) toolResultErrors++;
      }
    }
  }

  return {
    model: request.model,
    maxTokens: request.maxTokens,
    toolsOffered: request.tools?.length || 0,
    toolChoice:
      request.toolChoice || (request.tools?.length ? "auto" : undefined),
    messages: messages.length,
    userMessages,
    assistantMessages,
    textBlocks,
    textChars,
    toolUseBlocks,
    toolResultBlocks,
    toolResultChars,
    toolResultErrors,
    systemChars: typeof request.system === "string" ? request.system.length : 0,
    signalAborted: request.signal?.aborted === true,
  };
}

function summarizeLLMResponse(response: LLMResponse): Record<string, unknown> {
  const content = Array.isArray(response?.content) ? response.content : [];
  let textBlocks = 0;
  let textChars = 0;
  let toolUseBlocks = 0;

  for (const block of content as Any[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textBlocks++;
      textChars += block.text.length;
    } else if (block.type === "tool_use") {
      toolUseBlocks++;
    }
  }

  const inputTokens = response?.usage?.inputTokens ?? null;
  const outputTokens = response?.usage?.outputTokens ?? null;
  const totalTokens =
    inputTokens != null && outputTokens != null
      ? inputTokens + outputTokens
      : null;

  return {
    stopReason: response?.stopReason,
    contentBlocks: content.length,
    textBlocks,
    textChars,
    toolUseBlocks,
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function parseMaxTokensLimitFromError(error: Any): number | null {
  const message = String(error?.message || "");
  if (!message) return null;

  const patterns = [
    /model limit of\s+(\d+)/i,
    /lower than\s+(\d+)/i,
    /max(?:imum)?\s+tokens(?:\s+value)?\s+(?:that is\s+)?lower than\s+(\d+)/i,
    /maximum tokens[^0-9]*(\d+)/i,
    // Bedrock Converse API: "must be less than or equal to N"
    /less than or equal to\s+(\d+)/i,
    // Bedrock Converse API: "maxTokens: value (N) ... must be ... N"
    /maxTokens.*?(?:less than|at most|equal to)\s+(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return null;
}

function clampRequestToObservedModelLimit(request: LLMRequest): {
  request: LLMRequest;
  adjusted: boolean;
  observedLimit: number | null;
} {
  const model = typeof request.model === "string" ? request.model : "";
  if (!model) return { request, adjusted: false, observedLimit: null };

  const observedLimit = observedModelMaxTokens.get(model) ?? null;
  if (
    !observedLimit ||
    !Number.isFinite(request.maxTokens) ||
    request.maxTokens <= 0
  ) {
    return { request, adjusted: false, observedLimit };
  }

  const capped = Math.max(1, observedLimit - 1);
  if (request.maxTokens <= capped) {
    return { request, adjusted: false, observedLimit };
  }

  return {
    request: { ...request, maxTokens: capped },
    adjusted: true,
    observedLimit,
  };
}

function wrapProviderWithDetailedLogging(provider: LLMProvider): LLMProvider {
  const alreadyWrapped = (provider as Any).__detailedLLMLoggingWrapped === true;
  if (alreadyWrapped) return provider;

  const wrapped: LLMProvider = {
    type: provider.type,
    async createMessage(request: LLMRequest): Promise<LLMResponse> {
      const callId = ++llmCallLogCounter;
      const startedAt = Date.now();
      const preflight = clampRequestToObservedModelLimit(request);
      const effectiveRequest = preflight.request;
      // Tag side-channel calls (no tools, very short system, small maxTokens) to avoid
      // confusing them with main agentic loop calls in the logs.
      const isSideCall =
        !effectiveRequest.tools?.length &&
        effectiveRequest.maxTokens <= 200 &&
        (typeof effectiveRequest.system === "string"
          ? effectiveRequest.system.length
          : 0) < 120;
      const tag = isSideCall ? " [side]" : "";
      console.log(
        `[LLM:${provider.type}] #${callId}${tag} start`,
        summarizeLLMRequest(effectiveRequest),
      );
      if (preflight.adjusted) {
        console.log(
          `[LLM:${provider.type}] #${callId} using observed model token limit`,
          {
            model: effectiveRequest.model,
            observedLimit: preflight.observedLimit,
            requestedMaxTokens: request.maxTokens,
            adjustedMaxTokens: effectiveRequest.maxTokens,
          },
        );
      }

      // Tag requests so downstream provider logs can correlate with this call ID.
      effectiveRequest._callId = callId;

      try {
        const response = await provider.createMessage(effectiveRequest);
        console.log(
          `[LLM:${provider.type}] #${callId}${tag} success in ${Date.now() - startedAt}ms`,
          summarizeLLMResponse(response),
        );
        return response;
      } catch (error: Any) {
        let effectiveError = error;
        const parsedLimit = parseMaxTokensLimitFromError(error);
        if (
          parsedLimit &&
          Number.isFinite(effectiveRequest.maxTokens) &&
          effectiveRequest.maxTokens >= parsedLimit
        ) {
          const model =
            typeof effectiveRequest.model === "string"
              ? effectiveRequest.model
              : "";
          if (model) {
            observedModelMaxTokens.set(model, parsedLimit);
          }
          const retryMaxTokens = Math.max(1, parsedLimit - 1);
          const shouldRetry = retryMaxTokens !== effectiveRequest.maxTokens;
          if (shouldRetry) {
            console.warn(
              `[LLM:${provider.type}] #${callId} retrying with provider token cap`,
              {
                model: effectiveRequest.model,
                parsedLimit,
                previousMaxTokens: effectiveRequest.maxTokens,
                retryMaxTokens,
              },
            );
            const retriedRequest: LLMRequest = {
              ...effectiveRequest,
              maxTokens: retryMaxTokens,
            };
            try {
              const response = await provider.createMessage(retriedRequest);
              console.log(
                `[LLM:${provider.type}] #${callId}${tag} success in ${Date.now() - startedAt}ms`,
                {
                  ...summarizeLLMResponse(response),
                  retriedWithMaxTokens: retryMaxTokens,
                  learnedModelLimit: parsedLimit,
                },
              );
              return response;
            } catch (retryError: Any) {
              effectiveError = retryError;
            }
          }
        }

        const message = String(effectiveError?.message || "");
        const lower = message.toLowerCase();
        const cancelled =
          effectiveError?.name === "AbortError" ||
          lower.includes("aborted") ||
          lower.includes("cancel");
        console.error(
          `[LLM:${provider.type}] #${callId}${tag} ${cancelled ? "cancelled" : "error"} in ${Date.now() - startedAt}ms`,
          {
            name: effectiveError?.name,
            message,
            status:
              effectiveError?.status ||
              effectiveError?.$metadata?.httpStatusCode,
            requestId: effectiveError?.$metadata?.requestId,
          },
        );
        throw effectiveError;
      }
    },
    async testConnection(): Promise<{ success: boolean; error?: string }> {
      return provider.testConnection();
    },
  };

  (wrapped as Any).__detailedLLMLoggingWrapped = true;
  return wrapped;
}

function resolveCustomProviderId(
  providerType: LLMProviderType,
): LLMProviderType {
  return CUSTOM_PROVIDER_ALIASES[providerType] || providerType;
}

function getCustomProviderEntry(
  providerType: LLMProviderType,
): ProviderCatalogEntry | undefined {
  return CUSTOM_PROVIDER_MAP.get(resolveCustomProviderId(providerType));
}

function getKnownCustomProviderModels(
  entry: ProviderCatalogEntry,
): CachedModelInfo[] {
  return (entry.knownModels || []).map((modelId) => ({
    key: modelId,
    displayName: modelId,
    description: entry.description || `${entry.name} model`,
  }));
}

function mergeCustomProviderModels(
  entry: ProviderCatalogEntry,
  ...modelGroups: Array<CachedModelInfo[] | undefined>
): CachedModelInfo[] {
  const merged: CachedModelInfo[] = [];
  const seen = new Set<string>();

  for (const group of modelGroups) {
    for (const model of group || []) {
      const key = model.key?.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push({
        ...model,
        displayName: model.displayName || key,
        description:
          model.description || entry.description || `${entry.name} model`,
      });
    }
  }

  return merged;
}

function getCustomProviderConfig(
  customProviders: Record<string, CustomProviderConfig> | undefined,
  providerType: LLMProviderType,
): CustomProviderConfig | undefined {
  if (!customProviders) return undefined;
  const resolved = resolveCustomProviderId(providerType);
  const resolvedConfig = customProviders[resolved];
  if (resolvedConfig) {
    return resolvedConfig;
  }
  const fallbackConfig = customProviders[providerType];
  if (fallbackConfig && resolved !== providerType) {
    console.log(
      `[LLMProviderFactory] Custom provider config not found for "${resolved}", falling back to "${providerType}".`,
    );
  }
  return fallbackConfig;
}

function normalizeModelKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isCustomProviderConfigured(
  entry: ProviderCatalogEntry,
  config?: CustomProviderConfig,
): boolean {
  if (!config) return false;
  const hasApiKey = !!config.apiKey?.trim();
  const hasBaseUrl = !!config.baseUrl?.trim() || !!entry.baseUrl;
  const hasUserConfig =
    hasApiKey || !!config.baseUrl?.trim() || !!config.model?.trim();

  if (!hasUserConfig) return false;

  if (entry.apiKeyOptional) {
    return entry.requiresBaseUrl ? hasBaseUrl : hasApiKey || hasBaseUrl;
  }

  return entry.requiresBaseUrl ? hasApiKey && hasBaseUrl : hasApiKey;
}

function createCustomProvider(
  config: LLMProviderConfig,
  entry: ProviderCatalogEntry,
  resolvedType: LLMProviderType,
): LLMProvider {
  if (resolvedType === "github-copilot") {
    return new GitHubCopilotProvider(config);
  }

  const apiKey = config.providerApiKey || "";
  const baseUrl = config.providerBaseUrl || entry.baseUrl || "";

  if (entry.requiresBaseUrl && !baseUrl) {
    throw new Error(
      `${entry.name} base URL is required. Configure it in Settings.`,
    );
  }

  if (!apiKey && !entry.apiKeyOptional) {
    throw new Error(
      `${entry.name} API key is required. Configure it in Settings.`,
    );
  }

  const model = config.model || entry.defaultModel;
  if (!model) {
    throw new Error(
      `${entry.name} model is required. Configure it in Settings.`,
    );
  }

  if (entry.compatibility === "openai") {
    return new OpenAICompatibleProvider({
      type: resolvedType,
      providerName: entry.name,
      apiKey,
      baseUrl,
      defaultModel: model,
    });
  }

  return new AnthropicCompatibleProvider({
    type: resolvedType,
    providerName: entry.name,
    apiKey,
    baseUrl,
    defaultModel: model,
  });
}

// ============ Legacy Encryption Functions (for migration only) ============
// These functions are only used to decrypt settings from legacy JSON files
// during migration to the encrypted database. New settings use full-object
// encryption via SecureSettingsRepository.

/**
 * @deprecated Used only for migration from legacy JSON files
 * Encrypt a secret using OS keychain via safeStorage
 */
function _encryptSecret(value?: string): string | undefined {
  if (!value || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed === MASKED_VALUE) return undefined;

  try {
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(trimmed);
      return ENCRYPTED_PREFIX + encrypted.toString("base64");
    }
  } catch (error) {
    logger.warn("Failed to encrypt secret, storing masked:", error);
  }
  // Fallback to masked value if encryption fails
  return MASKED_VALUE;
}

/**
 * @deprecated Used only for migration from legacy JSON files
 * Decrypt a secret that was encrypted with safeStorage
 */
function decryptSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (value === MASKED_VALUE) return undefined;

  if (value.startsWith(ENCRYPTED_PREFIX)) {
    try {
      const safeStorage = getSafeStorage();
      const isAvailable = safeStorage?.isEncryptionAvailable?.() ?? false;
      if (isAvailable) {
        const encrypted = Buffer.from(
          value.slice(ENCRYPTED_PREFIX.length),
          "base64",
        );
        const decrypted = safeStorage!.decryptString(encrypted);
        return decrypted;
      } else {
        logger.error(
          "[LLM Settings] safeStorage encryption not available - cannot decrypt secrets",
        );
        logger.error(
          "[LLM Settings] You may need to re-enter your API credentials in Settings",
        );
      }
    } catch (error: Any) {
      // This can happen after app updates when the code signature changes
      // The macOS Keychain ties encryption to the app's signature
      logger.error(
        "[LLM Settings] Failed to decrypt secret - this can happen after app updates",
      );
      logger.error("[LLM Settings] Error:", error.message || error);
      logger.error(
        "[LLM Settings] Please re-enter your API credentials in Settings",
      );
    }
  }

  // If not encrypted and not masked, return as-is (for backwards compatibility)
  if (value !== MASKED_VALUE && !value.startsWith(ENCRYPTED_PREFIX)) {
    logger.warn(
      "[LLM Settings] Loaded plaintext legacy secret. Re-save provider settings to migrate it.",
    );
    return value.trim() || undefined;
  }

  return undefined;
}

/**
 * Normalize a secret value, filtering out masked/encrypted values
 */
function normalizeSecret(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === MASKED_VALUE ||
    trimmed.startsWith(ENCRYPTED_PREFIX)
  )
    return undefined;
  return trimmed;
}

function resolveAnthropicCredential(
  anthropic?:
    | LLMSettings["anthropic"]
    | { apiKey?: string; subscriptionToken?: string; authMethod?: string },
): string | undefined {
  if (!anthropic) return undefined;

  const apiKey = normalizeSecret(anthropic.apiKey);
  const subscriptionToken = normalizeSecret(anthropic.subscriptionToken);

  switch (anthropic.authMethod) {
    case "subscription":
      return subscriptionToken || apiKey;
    case "api_key":
      return apiKey || subscriptionToken;
    default:
      return subscriptionToken || apiKey;
  }
}

/**
 * @deprecated Used only for migration from legacy JSON files
 * Decrypt all secrets in legacy settings
 */
function sanitizeSettings(settings: LLMSettings): LLMSettings {
  const sanitized: LLMSettings = { ...settings };

  // Decrypt secrets when loading from disk
  if (sanitized.anthropic) {
    sanitized.anthropic = {
      ...sanitized.anthropic,
      apiKey: decryptSecret(sanitized.anthropic.apiKey),
      subscriptionToken: decryptSecret(sanitized.anthropic.subscriptionToken),
    };
  }

  if (sanitized.bedrock) {
    sanitized.bedrock = {
      ...sanitized.bedrock,
      secretAccessKey: decryptSecret(sanitized.bedrock.secretAccessKey),
    };
  }

  if (sanitized.ollama) {
    sanitized.ollama = {
      ...sanitized.ollama,
      apiKey: decryptSecret(sanitized.ollama.apiKey),
    };
  }

  if (sanitized.gemini) {
    sanitized.gemini = {
      ...sanitized.gemini,
      apiKey: decryptSecret(sanitized.gemini.apiKey),
    };
  }

  if (sanitized.openrouter) {
    sanitized.openrouter = {
      ...sanitized.openrouter,
      apiKey: decryptSecret(sanitized.openrouter.apiKey),
    };
  }

  if (sanitized.openai) {
    const decryptedAccessToken = decryptSecret(sanitized.openai.accessToken);
    const decryptedRefreshToken = decryptSecret(sanitized.openai.refreshToken);

    // Log OAuth token status for debugging
    if (sanitized.openai.authMethod === "oauth") {
      logger.debug("[LLM Settings] Loading OpenAI OAuth settings:");
      logger.debug("[LLM Settings]   authMethod:", sanitized.openai.authMethod);
      logger.debug(
        "[LLM Settings]   hasAccessToken:",
        !!sanitized.openai.accessToken,
      );
      logger.debug(
        "[LLM Settings]   decryptedAccessToken:",
        !!decryptedAccessToken,
      );
      logger.debug(
        "[LLM Settings]   hasRefreshToken:",
        !!sanitized.openai.refreshToken,
      );
      logger.debug(
        "[LLM Settings]   decryptedRefreshToken:",
        !!decryptedRefreshToken,
      );
    }

    sanitized.openai = {
      ...sanitized.openai,
      apiKey: decryptSecret(sanitized.openai.apiKey),
      accessToken: decryptedAccessToken,
      refreshToken: decryptedRefreshToken,
    };
  }

  if (sanitized.azure) {
    sanitized.azure = {
      ...sanitized.azure,
      apiKey: decryptSecret(sanitized.azure.apiKey),
    };
  }

  if (sanitized.azureAnthropic) {
    sanitized.azureAnthropic = {
      ...sanitized.azureAnthropic,
      apiKey: decryptSecret(sanitized.azureAnthropic.apiKey),
    };
  }

  if (sanitized.groq) {
    sanitized.groq = {
      ...sanitized.groq,
      apiKey: decryptSecret(sanitized.groq.apiKey),
    };
  }

  if (sanitized.xai) {
    sanitized.xai = {
      ...sanitized.xai,
      apiKey: decryptSecret(sanitized.xai.apiKey),
    };
  }

  if (sanitized.kimi) {
    sanitized.kimi = {
      ...sanitized.kimi,
      apiKey: decryptSecret(sanitized.kimi.apiKey),
    };
  }

  if (sanitized.pi) {
    sanitized.pi = {
      ...sanitized.pi,
      apiKey: decryptSecret(sanitized.pi.apiKey),
    };
  }

  if (sanitized.customProviders) {
    const normalized: Record<string, CustomProviderConfig> = {};
    for (const [key, value] of Object.entries(sanitized.customProviders)) {
      normalized[key] = {
        ...value,
        apiKey: decryptSecret(value.apiKey),
      };
    }
    sanitized.customProviders = normalized;
  }

  return sanitized;
}

/**
 * Cached model info for dynamic providers
 */
export interface CachedModelInfo {
  key: string;
  displayName: string;
  description: string;
  // Additional fields for provider-specific info
  contextLength?: number; // For OpenRouter models
  size?: number; // For Ollama models (in bytes)
  reasoningEfforts?: LLMReasoningEffort[];
}

interface ProviderRoutingSettings {
  fallbackProviders?: LLMProviderFallbackConfig[];
  failoverPrimaryRetryCooldownSeconds?: number;
  profileRoutingEnabled?: boolean;
  strongModelKey?: string;
  cheapModelKey?: string;
  automatedTaskModelKey?: string;
  preferStrongForVerification?: boolean;
  reasoningEffort?: LLMReasoningEffort;
}

/**
 * Stored settings for LLM provider
 */
export interface LLMSettings {
  providerType: LLMProviderType;
  modelKey: ModelKey | string; // String for custom Ollama model names
  fallbackProviders?: LLMProviderFallbackConfig[];
  failoverPrimaryRetryCooldownSeconds?: number;
  promptCaching?: PromptCachingSettings;
  anthropic?: {
    apiKey?: string;
    subscriptionToken?: string;
    authMethod?: "api_key" | "subscription";
  } & ProviderRoutingSettings;
  bedrock?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    profile?: string;
    useDefaultCredentials?: boolean;
    model?: string;
  } & ProviderRoutingSettings;
  ollama?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string; // Optional, for remote Ollama servers
  } & ProviderRoutingSettings;
  gemini?: {
    apiKey?: string;
    model?: string;
  } & ProviderRoutingSettings;
  openrouter?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  } & ProviderRoutingSettings;
  openai?: {
    apiKey?: string;
    model?: string;
    // OAuth tokens (alternative to API key)
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    authMethod?: "api_key" | "oauth";
  } & ProviderRoutingSettings;
  azure?: {
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    deployments?: string[];
    apiVersion?: string;
    reasoningEffort?: "low" | "medium" | "high" | "extra_high";
  } & ProviderRoutingSettings;
  azureAnthropic?: {
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    deployments?: string[];
    apiVersion?: string;
  } & ProviderRoutingSettings;
  groq?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  } & ProviderRoutingSettings;
  xai?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  } & ProviderRoutingSettings;
  kimi?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  } & ProviderRoutingSettings;
  pi?: {
    provider?: string; // pi-ai KnownProvider
    apiKey?: string;
    model?: string;
  } & ProviderRoutingSettings;
  openaiCompatible?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  } & ProviderRoutingSettings;
  customProviders?: Record<string, CustomProviderConfig>;
  /** Text-to-image model selection. Default tried first; backup used on failure. */
  imageGeneration?: {
    defaultProvider?: "openai" | "openai-codex" | "azure" | "openrouter" | "gemini";
    defaultModel?: "gpt-image-2" | "gpt-image-1.5" | "nano-banana-2";
    backupProvider?: "openai" | "openai-codex" | "azure" | "openrouter" | "gemini";
    backupModel?: "gpt-image-2" | "gpt-image-1.5" | "nano-banana-2";
    timeouts?: {
      openai?: number;
      openaiCodex?: number;
      azure?: number;
      openrouter?: number;
      gemini?: number;
    };
    openai?: {
      apiKey?: string;
      model?: string;
    };
    azure?: {
      imageApiKey?: string;
      imageEndpoint?: string;
      imageDeployment?: string;
      imageApiVersion?: string;
    };
    gemini?: {
      apiKey?: string;
      model?: "nano-banana-2";
    };
    openrouter?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };
    openaiCodex?: {
      model?: string;
    };
  };
  /** Text-to-video generation settings. Provider-specific config + routing. */
  videoGeneration?: {
    defaultProvider?: "openai" | "azure" | "gemini" | "vertex" | "kling";
    fallbackProvider?: "openai" | "azure" | "gemini" | "vertex" | "kling";
    openai?: {
      defaultModel?: string;
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
      defaultResolution?: "480p" | "720p" | "1080p";
    };
    azure?: {
      /** Dedicated API key for video (overrides the main Azure chat API key if set) */
      videoApiKey?: string;
      /** Dedicated endpoint for video (overrides the main Azure chat endpoint if set) */
      videoEndpoint?: string;
      videoDeployment?: string;
      videoApiVersion?: string;
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
      defaultResolution?: "480p" | "720p" | "1080p";
    };
    gemini?: {
      defaultModel?: "veo-3.1" | "veo-3.1-fast-preview" | "veo-3.0";
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
    };
    vertex?: {
      model?: "veo-3" | "veo-3.1";
      projectId?: string;
      location?: string;
      outputGcsUri?: string;
      accessToken?: string;
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
    };
    kling?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      defaultDuration?: number;
      defaultAspectRatio?: "16:9" | "9:16" | "1:1";
    };
  };
  // Cached models from API (populated when user refreshes)
  cachedAnthropicModels?: CachedModelInfo[];
  cachedGeminiModels?: CachedModelInfo[];
  cachedOpenRouterModels?: CachedModelInfo[];
  cachedOllamaModels?: CachedModelInfo[];
  cachedBedrockModels?: CachedModelInfo[];
  cachedOpenAIModels?: CachedModelInfo[];
  cachedGroqModels?: CachedModelInfo[];
  cachedXaiModels?: CachedModelInfo[];
  cachedKimiModels?: CachedModelInfo[];
  cachedPiModels?: CachedModelInfo[];
  cachedOpenAICompatibleModels?: CachedModelInfo[];
}

const DEFAULT_SETTINGS: LLMSettings = {
  providerType: "anthropic",
  modelKey: DEFAULT_MODEL,
};

export interface ResolvedTaskModelSelection {
  providerType: LLMProviderType;
  modelId: string;
  modelKey: string;
  llmProfileUsed: LlmProfile;
  resolvedModelKey: string;
  modelSource: "explicit_override" | "profile_model" | "provider_default";
  warnings: string[];
}

/**
 * Factory for creating LLM providers
 */
export class LLMProviderFactory {
  private static legacySettingsPath: string;
  private static cachedSettings: LLMSettings | null = null;
  private static migrationCompleted = false;

  private static normalizeCustomProviders(settings: LLMSettings): void {
    if (settings.customProviders) {
      const legacyKey = settings.customProviders["kimi-coding"];
      if (legacyKey && !settings.customProviders["kimi-code"]) {
        settings.customProviders["kimi-code"] = legacyKey;
      }
      if (settings.customProviders["kimi-coding"]) {
        delete settings.customProviders["kimi-coding"];
      }

      // Migrate openai-compatible from custom providers to built-in
      const legacyOpenAICompat = settings.customProviders["openai-compatible"];
      if (legacyOpenAICompat && !settings.openaiCompatible) {
        settings.openaiCompatible = {
          apiKey: legacyOpenAICompat.apiKey,
          baseUrl: legacyOpenAICompat.baseUrl,
          model: legacyOpenAICompat.model,
        };
        delete settings.customProviders["openai-compatible"];
      }
    }

    const rawProviderType = String(
      (settings as { providerType?: string }).providerType || "",
    );
    if (rawProviderType === "kimi-coding") {
      settings.providerType = "kimi-code";
    } else if (rawProviderType === "amazon-bedrock") {
      settings.providerType = "bedrock";
    }

    this.normalizeProviderFailoverSettings(settings);
  }

  private static normalizeProviderFailoverSettings(
    settings: LLMSettings,
  ): void {
    const normalizeNode = (node: ProviderRoutingSettings | undefined): void => {
      if (!node) return;

      if (Array.isArray(node.fallbackProviders)) {
        const normalized: LLMProviderFallbackConfig[] = [];
        const seen = new Set<string>();
        for (const entry of node.fallbackProviders) {
          const providerType = resolveCustomProviderId(
            entry?.providerType as LLMProviderType,
          );
          if (!providerType) continue;
          const modelKey = normalizeModelKey(entry?.modelKey);
          const dedupeKey = `${providerType}:${modelKey || ""}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          normalized.push({
            providerType,
            ...(modelKey ? { modelKey } : {}),
          });
        }
        node.fallbackProviders = normalized.slice(0, 5);
      }

      const parsedCooldown = Number(node.failoverPrimaryRetryCooldownSeconds);
      if (Number.isFinite(parsedCooldown)) {
        node.failoverPrimaryRetryCooldownSeconds = Math.max(
          0,
          Math.min(3600, Math.floor(parsedCooldown)),
        );
      } else {
        delete node.failoverPrimaryRetryCooldownSeconds;
      }
    };

    normalizeNode(settings);
    normalizeNode(settings.anthropic);
    normalizeNode(settings.bedrock);
    normalizeNode(settings.ollama);
    normalizeNode(settings.gemini);
    normalizeNode(settings.openrouter);
    normalizeNode(settings.openai);
    normalizeNode(settings.azure);
    normalizeNode(settings.azureAnthropic);
    normalizeNode(settings.groq);
    normalizeNode(settings.xai);
    normalizeNode(settings.kimi);
    normalizeNode(settings.pi);
    normalizeNode(settings.openaiCompatible);

    if (settings.customProviders) {
      for (const provider of Object.values(settings.customProviders)) {
        normalizeNode(provider);
      }
    }
  }

  private static isProviderConfigured(
    settings: LLMSettings,
    providerType: LLMProviderType,
  ): boolean {
    const resolvedProviderType = resolveCustomProviderId(providerType);
    const customEntry = getCustomProviderEntry(resolvedProviderType);
    if (customEntry) {
      return isCustomProviderConfigured(
        customEntry,
        getCustomProviderConfig(settings.customProviders, resolvedProviderType),
      );
    }

    switch (resolvedProviderType) {
      case "anthropic":
        return Boolean(resolveAnthropicCredential(settings.anthropic));
      case "bedrock":
        return Boolean(
          settings.bedrock?.accessKeyId ||
          settings.bedrock?.profile ||
          settings.bedrock?.useDefaultCredentials ||
          settings.bedrock?.region,
        );
      case "ollama":
        return Boolean(settings.ollama?.baseUrl || settings.ollama?.model);
      case "gemini":
        return Boolean(settings.gemini?.apiKey);
      case "openrouter":
        return Boolean(settings.openrouter?.apiKey);
      case "openai":
        return Boolean(settings.openai?.apiKey || settings.openai?.accessToken);
      case "azure":
        return Boolean(
          settings.azure?.apiKey &&
          settings.azure?.endpoint &&
          (settings.azure?.deployment || settings.azure?.deployments?.length),
        );
      case "azure-anthropic":
        return Boolean(
          settings.azureAnthropic?.apiKey &&
          settings.azureAnthropic?.endpoint &&
          (settings.azureAnthropic?.deployment ||
            settings.azureAnthropic?.deployments?.length),
        );
      case "groq":
        return Boolean(settings.groq?.apiKey);
      case "xai":
        return Boolean(settings.xai?.apiKey);
      case "kimi":
        return Boolean(settings.kimi?.apiKey);
      case "pi":
        return Boolean(settings.pi?.apiKey && settings.pi?.provider);
      case "openai-compatible":
        return Boolean(
          settings.openaiCompatible?.baseUrl &&
          settings.openaiCompatible?.model,
        );
      default:
        return false;
    }
  }

  private static getProviderRoutingSettingsNode(
    settings: LLMSettings,
    providerType: LLMProviderType,
    createIfMissing = false,
  ): ProviderRoutingSettings | undefined {
    const resolvedProviderType = resolveCustomProviderId(providerType);
    if (CUSTOM_PROVIDER_IDS.has(resolvedProviderType as Any)) {
      if (!settings.customProviders) {
        if (!createIfMissing) return undefined;
        settings.customProviders = {};
      }

      const existing =
        settings.customProviders[resolvedProviderType] ||
        settings.customProviders[providerType];
      if (existing) {
        if (
          settings.customProviders[providerType] &&
          resolvedProviderType !== providerType
        ) {
          delete settings.customProviders[providerType];
        }
        settings.customProviders[resolvedProviderType] = existing;
        return settings.customProviders[resolvedProviderType];
      }

      if (!createIfMissing) return undefined;
      settings.customProviders[resolvedProviderType] = {};
      return settings.customProviders[resolvedProviderType];
    }

    switch (resolvedProviderType) {
      case "anthropic":
        if (!settings.anthropic && createIfMissing) settings.anthropic = {};
        return settings.anthropic;
      case "bedrock":
        if (!settings.bedrock && createIfMissing) settings.bedrock = {};
        return settings.bedrock;
      case "ollama":
        if (!settings.ollama && createIfMissing) settings.ollama = {};
        return settings.ollama;
      case "gemini":
        if (!settings.gemini && createIfMissing) settings.gemini = {};
        return settings.gemini;
      case "openrouter":
        if (!settings.openrouter && createIfMissing) settings.openrouter = {};
        return settings.openrouter;
      case "openai":
        if (!settings.openai && createIfMissing) settings.openai = {};
        return settings.openai;
      case "azure":
        if (!settings.azure && createIfMissing) settings.azure = {};
        return settings.azure;
      case "azure-anthropic":
        if (!settings.azureAnthropic && createIfMissing)
          settings.azureAnthropic = {};
        return settings.azureAnthropic;
      case "groq":
        if (!settings.groq && createIfMissing) settings.groq = {};
        return settings.groq;
      case "xai":
        if (!settings.xai && createIfMissing) settings.xai = {};
        return settings.xai;
      case "kimi":
        if (!settings.kimi && createIfMissing) settings.kimi = {};
        return settings.kimi;
      case "pi":
        if (!settings.pi && createIfMissing) settings.pi = {};
        return settings.pi;
      case "openai-compatible":
        if (!settings.openaiCompatible && createIfMissing)
          settings.openaiCompatible = {};
        return settings.openaiCompatible;
      default:
        return undefined;
    }
  }

  private static getProviderDefaultModelKey(
    settings: LLMSettings,
    providerType: LLMProviderType,
  ): string {
    const fallback = normalizeModelKey(String(settings.modelKey)) || "";
    try {
      const status = this.getProviderModelStatus({ ...settings, providerType });
      return normalizeModelKey(status.currentModel) || fallback;
    } catch {
      return fallback;
    }
  }

  private static applyProfileRoutingDefaults(
    settings: LLMSettings,
  ): LLMSettings {
    const next: LLMSettings = { ...settings };
    next.promptCaching = normalizePromptCachingSettings(next.promptCaching);

    const applyDefaults = (
      providerType: LLMProviderType,
      createIfMissing = false,
    ): void => {
      const target = this.getProviderRoutingSettingsNode(
        next,
        providerType,
        createIfMissing,
      );
      if (!target) return;

      const providerDefaultModel = this.getProviderDefaultModelKey(
        next,
        providerType,
      );
      if (!normalizeModelKey(target.strongModelKey) && providerDefaultModel) {
        target.strongModelKey = providerDefaultModel;
      }
      if (!normalizeModelKey(target.cheapModelKey) && providerDefaultModel) {
        target.cheapModelKey = providerDefaultModel;
      }
      if (typeof target.preferStrongForVerification !== "boolean") {
        target.preferStrongForVerification = true;
      }
    };

    applyDefaults(next.providerType, true);
    if (next.anthropic) applyDefaults("anthropic");
    if (next.bedrock) applyDefaults("bedrock");
    if (next.ollama) applyDefaults("ollama");
    if (next.gemini) applyDefaults("gemini");
    if (next.openrouter) applyDefaults("openrouter");
    if (next.openai) applyDefaults("openai");
    if (next.azure) applyDefaults("azure");
    if (next.azureAnthropic) applyDefaults("azure-anthropic");
    if (next.groq) applyDefaults("groq");
    if (next.xai) applyDefaults("xai");
    if (next.kimi) applyDefaults("kimi");
    if (next.pi) applyDefaults("pi");
    if (next.openaiCompatible) applyDefaults("openai-compatible");

    if (next.customProviders) {
      for (const customProviderType of Object.keys(next.customProviders)) {
        applyDefaults(customProviderType as LLMProviderType);
      }
    }

    return next;
  }

  static getProviderRoutingSettings(
    settings: LLMSettings,
    providerType: LLMProviderType,
  ): Required<
    Pick<
      ProviderRoutingSettings,
      "profileRoutingEnabled" | "preferStrongForVerification"
    >
  > &
    Pick<
      ProviderRoutingSettings,
      | "strongModelKey"
      | "cheapModelKey"
      | "automatedTaskModelKey"
      | "reasoningEffort"
    > {
    const configured = this.getProviderRoutingSettingsNode(
      settings,
      providerType,
      false,
    );
    const defaultModel = this.getProviderDefaultModelKey(
      settings,
      providerType,
    );
    return {
      profileRoutingEnabled: configured?.profileRoutingEnabled === true,
      strongModelKey:
        normalizeModelKey(configured?.strongModelKey) ||
        defaultModel ||
        undefined,
      cheapModelKey:
        normalizeModelKey(configured?.cheapModelKey) ||
        defaultModel ||
        undefined,
      automatedTaskModelKey:
        normalizeModelKey(configured?.automatedTaskModelKey) || undefined,
      reasoningEffort: configured?.reasoningEffort,
      preferStrongForVerification:
        configured?.preferStrongForVerification !== false,
    };
  }

  static getProviderFailoverSettings(
    settings: LLMSettings,
    providerType: LLMProviderType,
  ): Required<
    Pick<ProviderRoutingSettings, "fallbackProviders" | "failoverPrimaryRetryCooldownSeconds">
  > {
    const configured = this.getProviderRoutingSettingsNode(
      settings,
      providerType,
      false,
    );
    return {
      fallbackProviders:
        configured?.fallbackProviders ?? settings.fallbackProviders ?? [],
      failoverPrimaryRetryCooldownSeconds:
        configured?.failoverPrimaryRetryCooldownSeconds ??
        settings.failoverPrimaryRetryCooldownSeconds ??
        60,
    };
  }

  private static resolveModelIdForProvider(
    settings: LLMSettings,
    providerType: LLMProviderType,
    modelKey: string,
    source: ResolvedTaskModelSelection["modelSource"],
  ): string {
    const azureDeployment =
      settings.azure?.deployment || settings.azure?.deployments?.[0];

    if (providerType === "anthropic") {
      if (modelKey.startsWith("claude-")) {
        return normalizeAnthropicModelId(modelKey);
      }
      return this.getModelId(
        modelKey,
        providerType,
        settings.ollama?.model,
        settings.gemini?.model,
        settings.openrouter?.model,
        settings.openai?.model,
        azureDeployment,
        settings.azureAnthropic?.deployment ||
          settings.azureAnthropic?.deployments?.[0],
        settings.groq?.model,
        settings.xai?.model,
        settings.kimi?.model,
        settings.customProviders,
        settings.bedrock?.model,
      );
    }

    if (providerType === "bedrock") {
      if (modelKey.startsWith("us.") || modelKey.startsWith("anthropic.")) {
        return modelKey;
      }
      return this.getModelId(
        modelKey,
        providerType,
        settings.ollama?.model,
        settings.gemini?.model,
        settings.openrouter?.model,
        settings.openai?.model,
        azureDeployment,
        settings.azureAnthropic?.deployment ||
          settings.azureAnthropic?.deployments?.[0],
        settings.groq?.model,
        settings.xai?.model,
        settings.kimi?.model,
        settings.customProviders,
        source === "provider_default" ? settings.bedrock?.model : undefined,
      );
    }

    return modelKey;
  }

  static resolveTaskModelSelection(
    taskAgentConfig?: Pick<
      AgentConfig,
      | "providerType"
      | "modelKey"
      | "llmProfile"
      | "llmProfileHint"
      | "llmProfileForced"
      | "capabilityHint"
      | "verificationAgent"
    >,
    options?: {
      forceProfile?: LlmProfile;
      isVerificationTask?: boolean;
    },
  ): ResolvedTaskModelSelection {
    const settings = this.loadSettings();
    const providerType = (taskAgentConfig?.providerType ||
      settings.providerType) as LLMProviderType;
    const routing = this.getProviderRoutingSettings(settings, providerType);
    const warnings: string[] = [];

    let llmProfileUsed: LlmProfile =
      options?.forceProfile ||
      taskAgentConfig?.llmProfile ||
      taskAgentConfig?.llmProfileHint ||
      "cheap";

    const shouldForceStrongForVerification =
      options?.isVerificationTask === true ||
      taskAgentConfig?.verificationAgent === true;
    if (
      shouldForceStrongForVerification &&
      routing.preferStrongForVerification &&
      !options?.forceProfile
    ) {
      llmProfileUsed = "strong";
    }

    const explicitModelOverride = normalizeModelKey(taskAgentConfig?.modelKey);
    const profileForced =
      taskAgentConfig?.llmProfileForced === true &&
      Boolean(taskAgentConfig?.llmProfile || options?.forceProfile);
    const allowExplicitModelOverride =
      Boolean(explicitModelOverride) && !profileForced;

    let modelSource: ResolvedTaskModelSelection["modelSource"] =
      "provider_default";
    let resolvedModelKey = "";

    if (allowExplicitModelOverride && explicitModelOverride) {
      modelSource = "explicit_override";
      resolvedModelKey = explicitModelOverride;
    } else if (taskAgentConfig?.capabilityHint) {
      const capabilityModelKey = resolveModelPreferenceToModelKey(
        ModelCapabilityRegistry.selectForCapability(
          taskAgentConfig.capabilityHint,
        ),
      );
      if (capabilityModelKey) {
        modelSource = "profile_model";
        resolvedModelKey = capabilityModelKey;
      }
    } else if (routing.profileRoutingEnabled) {
      const profileModelKey =
        llmProfileUsed === "strong"
          ? routing.strongModelKey
          : routing.cheapModelKey;
      const normalizedProfileModelKey = normalizeModelKey(profileModelKey);
      if (normalizedProfileModelKey) {
        modelSource = "profile_model";
        resolvedModelKey = normalizedProfileModelKey;
      } else {
        warnings.push(
          `[LLMProviderFactory] Missing ${llmProfileUsed} profile model for provider "${providerType}". Falling back to provider default model.`,
        );
      }
    }

    if (!resolvedModelKey) {
      resolvedModelKey = this.getProviderDefaultModelKey(
        settings,
        providerType,
      );
      modelSource = "provider_default";
    }

    let modelId: string;
    try {
      modelId = this.resolveModelIdForProvider(
        settings,
        providerType,
        resolvedModelKey,
        modelSource,
      );
    } catch (error: Any) {
      if (modelSource === "profile_model") {
        warnings.push(
          `[LLMProviderFactory] Invalid profile model "${resolvedModelKey}" for provider "${providerType}". Falling back to provider default model.`,
        );
        resolvedModelKey = this.getProviderDefaultModelKey(
          settings,
          providerType,
        );
        modelSource = "provider_default";
        modelId = this.resolveModelIdForProvider(
          settings,
          providerType,
          resolvedModelKey,
          modelSource,
        );
      } else {
        throw error;
      }
    }

    return {
      providerType,
      modelId,
      modelKey: resolvedModelKey,
      llmProfileUsed,
      resolvedModelKey,
      modelSource,
      warnings,
    };
  }

  static resolveProviderFailoverChain(
    primarySelection: ResolvedTaskModelSelection,
    taskAgentConfig?: Pick<
      AgentConfig,
      | "providerType"
      | "modelKey"
      | "llmProfile"
      | "llmProfileHint"
      | "llmProfileForced"
      | "capabilityHint"
      | "verificationAgent"
    >,
    options?: {
      forceProfile?: LlmProfile;
      isVerificationTask?: boolean;
      requiresImageInput?: boolean;
    },
  ): ResolvedTaskModelSelection[] {
    if (taskAgentConfig?.providerType || taskAgentConfig?.modelKey) {
      return [primarySelection];
    }

    const settings = this.loadSettings();
    const chain: ResolvedTaskModelSelection[] = [primarySelection];
    const seen = new Set<string>([
      `${resolveCustomProviderId(primarySelection.providerType)}:${normalizeModelKey(primarySelection.modelKey) || ""}`,
    ]);
    const failoverSettings = this.getProviderFailoverSettings(
      settings,
      primarySelection.providerType,
    );

    for (const entry of failoverSettings.fallbackProviders || []) {
      const providerType = resolveCustomProviderId(entry.providerType);
      if (!this.isProviderConfigured(settings, providerType)) {
        continue;
      }

      const selection = this.resolveTaskModelSelection(
        {
          ...taskAgentConfig,
          providerType,
          modelKey: normalizeModelKey(entry.modelKey),
        },
        options,
      );
      const dedupeKey = `${resolveCustomProviderId(selection.providerType)}:${normalizeModelKey(selection.modelKey) || ""}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      chain.push(selection);
    }

    if (!options?.requiresImageInput) {
      return chain;
    }

    const imageCapableChain = chain.filter((selection) => this.selectionSupportsImageInput(selection));
    return imageCapableChain.length > 0 ? imageCapableChain : [primarySelection];
  }

  private static selectionSupportsImageInput(
    selection: Pick<ResolvedTaskModelSelection, "providerType" | "modelId">,
  ): boolean {
    if (selection.providerType !== "openrouter") {
      return true;
    }
    return OpenRouterProvider.getImageSupportHint(selection.modelId) !== false;
  }

  /**
   * Initialize the factory
   */
  static initialize(): void {
    const userDataPath = getUserDataDir();
    this.legacySettingsPath = path.join(userDataPath, LEGACY_SETTINGS_FILE);

    // Migrate from legacy JSON file to encrypted database
    this.migrateFromLegacyFile();
  }

  /**
   * Migrate settings from legacy JSON file to encrypted database
   */
  private static migrateFromLegacyFile(): void {
    if (this.migrationCompleted) return;

    try {
      // Check if SecureSettingsRepository is initialized
      if (!SecureSettingsRepository.isInitialized()) {
        console.log(
          "[LLMProviderFactory] SecureSettingsRepository not yet initialized, skipping migration",
        );
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      // Check if already migrated to database
      if (repository.exists("llm")) {
        this.migrationCompleted = true;
        return;
      }

      // Check if legacy file exists
      if (!fs.existsSync(this.legacySettingsPath)) {
        console.log("[LLMProviderFactory] No legacy settings file found");
        this.migrationCompleted = true;
        return;
      }

      console.log(
        "[LLMProviderFactory] Migrating settings from legacy JSON file to encrypted database...",
      );

      // Create backup before migration
      const backupPath = this.legacySettingsPath + ".migration-backup";
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        // Read and decrypt legacy settings
        const data = fs.readFileSync(this.legacySettingsPath, "utf-8");
        const legacySettings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
        const decryptedSettings = sanitizeSettings(legacySettings);

        // Save to encrypted database
        repository.save("llm", decryptedSettings);
        console.log(
          "[LLMProviderFactory] Settings migrated to encrypted database",
        );

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log(
          "[LLMProviderFactory] Migration complete, cleaned up legacy files",
        );

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error(
          "[LLMProviderFactory] Migration failed, backup preserved at:",
          backupPath,
        );
        throw migrationError;
      }
    } catch (error) {
      console.error("[LLMProviderFactory] Migration failed:", error);
    }
  }

  /**
   * Get the path to legacy settings file (for testing)
   */
  static getSettingsPath(): string {
    return this.legacySettingsPath;
  }

  /**
   * Load settings from encrypted database
   */
  static loadSettings(): LLMSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: LLMSettings = { ...DEFAULT_SETTINGS };
    let settingsExist = false;

    try {
      // Try to load from encrypted database
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<LLMSettings>("llm");
        if (stored) {
          settings = { ...DEFAULT_SETTINGS, ...stored };
          this.normalizeCustomProviders(settings);
          settingsExist = true;
        }
      }
    } catch (error) {
      console.error(
        "[LLMProviderFactory] Failed to load settings from database:",
        error,
      );
    }

    // Auto-detect provider if no settings exist
    if (!settingsExist) {
      const detectedProvider = this.detectProviderFromSettings(settings);
      if (detectedProvider) {
        settings.providerType = detectedProvider;
        console.log(
          `[LLMProviderFactory] Auto-detected LLM provider: ${detectedProvider}`,
        );
      }
    }

    const normalizedSettings = this.applyProfileRoutingDefaults(settings);
    this.cachedSettings = normalizedSettings;
    return normalizedSettings;
  }

  /**
   * Detect which provider to use based on saved settings
   * Note: Environment variables are no longer used for security reasons.
   * All configuration should be done through the Settings UI.
   */
  private static detectProviderFromSettings(
    settings: LLMSettings,
  ): LLMProviderType | null {
    // Check if any provider has credentials configured in settings
    if (resolveAnthropicCredential(settings.anthropic)) {
      return "anthropic";
    }
    if (settings.gemini?.apiKey) {
      return "gemini";
    }
    if (settings.openrouter?.apiKey) {
      return "openrouter";
    }
    if (settings.openai?.apiKey || settings.openai?.accessToken) {
      return "openai";
    }
    const azureDeployment =
      settings.azure?.deployment || settings.azure?.deployments?.[0];
    if (settings.azure?.apiKey && settings.azure?.endpoint && azureDeployment) {
      return "azure";
    }
    const azureAnthropicDeployment =
      settings.azureAnthropic?.deployment ||
      settings.azureAnthropic?.deployments?.[0];
    if (
      settings.azureAnthropic?.apiKey &&
      settings.azureAnthropic?.endpoint &&
      azureAnthropicDeployment
    ) {
      return "azure-anthropic";
    }
    if (settings.groq?.apiKey) {
      return "groq";
    }
    if (settings.xai?.apiKey) {
      return "xai";
    }
    if (settings.kimi?.apiKey) {
      return "kimi";
    }
    if (settings.bedrock?.accessKeyId || settings.bedrock?.profile) {
      return "bedrock";
    }
    if (settings.ollama?.baseUrl || settings.ollama?.model) {
      return "ollama";
    }
    if (settings.pi?.apiKey && settings.pi?.provider) {
      return "pi";
    }

    if (settings.customProviders) {
      for (const entry of CUSTOM_PROVIDER_CATALOG) {
        const config = getCustomProviderConfig(
          settings.customProviders,
          entry.id,
        );
        if (isCustomProviderConfigured(entry, config)) {
          return entry.id;
        }
      }
    }

    // No valid credentials detected - user needs to configure via Settings
    return null;
  }

  /**
   * Save settings to encrypted database
   */
  static saveSettings(settings: LLMSettings): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error("SecureSettingsRepository not initialized");
      }

      const repository = SecureSettingsRepository.getInstance();
      const normalizedSettings = this.applyProfileRoutingDefaults(settings);

      // Save entire settings object to encrypted database
      // No need for per-field encryption - the entire object is encrypted
      repository.save("llm", normalizedSettings);
      this.cachedSettings = normalizedSettings;

      console.log("[LLMProviderFactory] Settings saved to encrypted database");
    } catch (error) {
      console.error("[LLMProviderFactory] Failed to save settings:", error);
      throw error;
    }
  }

  /**
   * Clear cached settings
   */
  static clearCache(): void {
    this.cachedSettings = null;
  }

  /**
   * Create a provider based on current settings
   * Note: All credentials must be configured via the Settings UI.
   * Environment variables are no longer used for security reasons.
   */
  static createProvider(
    overrideConfig?: Partial<LLMProviderConfig>,
  ): LLMProvider {
    const settings = this.loadSettings();
    const providerType = overrideConfig?.type || settings.providerType;
    const customConfig = getCustomProviderConfig(
      settings.customProviders,
      providerType,
    );
    const azureDeployment =
      overrideConfig?.azureDeployment ||
      settings.azure?.deployment ||
      settings.azure?.deployments?.[0];
    const azureAnthropicDeployment =
      overrideConfig?.azureAnthropicDeployment ||
      settings.azureAnthropic?.deployment ||
      settings.azureAnthropic?.deployments?.[0];

    const config: LLMProviderConfig = {
      type: providerType,
      model:
        normalizeModelKey(overrideConfig?.model) ||
        this.getModelId(
          settings.modelKey,
          providerType,
          settings.ollama?.model,
          settings.gemini?.model,
          settings.openrouter?.model,
          settings.openai?.model,
          azureDeployment,
          azureAnthropicDeployment,
          settings.groq?.model,
          settings.xai?.model,
          settings.kimi?.model,
          settings.customProviders,
          settings.bedrock?.model,
        ),
      // Anthropic config - from settings only
      anthropicApiKey:
        normalizeSecret(overrideConfig?.anthropicApiKey) ||
        resolveAnthropicCredential(settings.anthropic),
      // Bedrock config - from settings only
      awsRegion:
        overrideConfig?.awsRegion || settings.bedrock?.region || "us-east-1",
      awsAccessKeyId:
        overrideConfig?.awsAccessKeyId || settings.bedrock?.accessKeyId,
      awsSecretAccessKey:
        normalizeSecret(overrideConfig?.awsSecretAccessKey) ||
        settings.bedrock?.secretAccessKey,
      awsSessionToken:
        overrideConfig?.awsSessionToken || settings.bedrock?.sessionToken,
      awsProfile: overrideConfig?.awsProfile || settings.bedrock?.profile,
      // Ollama config - from settings only
      ollamaBaseUrl:
        overrideConfig?.ollamaBaseUrl ||
        settings.ollama?.baseUrl ||
        "http://localhost:11434",
      ollamaApiKey:
        normalizeSecret(overrideConfig?.ollamaApiKey) ||
        settings.ollama?.apiKey,
      // Gemini config - from settings only
      geminiApiKey:
        normalizeSecret(overrideConfig?.geminiApiKey) ||
        settings.gemini?.apiKey,
      // OpenRouter config - from settings only
      openrouterApiKey:
        normalizeSecret(overrideConfig?.openrouterApiKey) ||
        settings.openrouter?.apiKey,
      openrouterBaseUrl:
        overrideConfig?.openrouterBaseUrl || settings.openrouter?.baseUrl,
      // OpenAI config - from settings only
      openaiApiKey:
        normalizeSecret(overrideConfig?.openaiApiKey) ||
        settings.openai?.apiKey,
      openaiAccessToken:
        normalizeSecret(overrideConfig?.openaiAccessToken) ||
        settings.openai?.accessToken,
      openaiRefreshToken: settings.openai?.refreshToken,
      openaiTokenExpiresAt: settings.openai?.tokenExpiresAt,
      // Azure OpenAI config - from settings only
      azureApiKey:
        normalizeSecret(overrideConfig?.azureApiKey) || settings.azure?.apiKey,
      azureEndpoint: overrideConfig?.azureEndpoint || settings.azure?.endpoint,
      azureDeployment,
      azureApiVersion:
        overrideConfig?.azureApiVersion || settings.azure?.apiVersion,
      azureReasoningEffort:
        overrideConfig?.azureReasoningEffort || settings.azure?.reasoningEffort,
      // Azure Anthropic config - from settings only
      azureAnthropicApiKey:
        normalizeSecret(overrideConfig?.azureAnthropicApiKey) ||
        settings.azureAnthropic?.apiKey,
      azureAnthropicEndpoint:
        overrideConfig?.azureAnthropicEndpoint ||
        settings.azureAnthropic?.endpoint,
      azureAnthropicDeployment,
      azureAnthropicApiVersion:
        overrideConfig?.azureAnthropicApiVersion ||
        settings.azureAnthropic?.apiVersion,
      // Groq config - from settings only
      groqApiKey:
        normalizeSecret(overrideConfig?.groqApiKey) || settings.groq?.apiKey,
      groqBaseUrl: overrideConfig?.groqBaseUrl || settings.groq?.baseUrl,
      // xAI config - from settings only
      xaiApiKey:
        normalizeSecret(overrideConfig?.xaiApiKey) || settings.xai?.apiKey,
      xaiBaseUrl: overrideConfig?.xaiBaseUrl || settings.xai?.baseUrl,
      // Kimi config - from settings only
      kimiApiKey:
        normalizeSecret(overrideConfig?.kimiApiKey) || settings.kimi?.apiKey,
      kimiBaseUrl: overrideConfig?.kimiBaseUrl || settings.kimi?.baseUrl,
      // Pi config - from settings only
      piProvider: overrideConfig?.piProvider || settings.pi?.provider,
      piApiKey:
        normalizeSecret(overrideConfig?.piApiKey) || settings.pi?.apiKey,
      // OpenAI-compatible config - from settings only
      openaiCompatibleApiKey:
        normalizeSecret(overrideConfig?.openaiCompatibleApiKey) ||
        settings.openaiCompatible?.apiKey,
      openaiCompatibleBaseUrl:
        overrideConfig?.openaiCompatibleBaseUrl ||
        settings.openaiCompatible?.baseUrl,
      // Custom provider config
      providerApiKey:
        normalizeSecret(overrideConfig?.providerApiKey) || customConfig?.apiKey,
      providerBaseUrl: overrideConfig?.providerBaseUrl || customConfig?.baseUrl,
    };

    return this.createProviderFromConfig(config);
  }

  /**
   * Create a provider from explicit config
   */
  static createProviderFromConfig(config: LLMProviderConfig): LLMProvider {
    const customEntry = getCustomProviderEntry(config.type);
    if (customEntry) {
      const resolvedType = resolveCustomProviderId(config.type);
      return wrapProviderWithDetailedLogging(
        createCustomProvider(config, customEntry, resolvedType),
      );
    }

    let provider: LLMProvider;
    switch (config.type) {
      case "anthropic":
        provider = new AnthropicProvider(config);
        break;
      case "bedrock":
        provider = new BedrockProvider(config);
        break;
      case "ollama":
        provider = new OllamaProvider(config);
        break;
      case "gemini":
        provider = new GeminiProvider(config);
        break;
      case "openrouter":
        provider = new OpenRouterProvider(config);
        break;
      case "openai":
        provider = new OpenAIProvider(config);
        break;
      case "azure":
        provider = new AzureOpenAIProvider(config);
        break;
      case "azure-anthropic":
        provider = new AzureAnthropicProvider(config);
        break;
      case "groq":
        provider = new GroqProvider(config);
        break;
      case "xai":
        provider = new XAIProvider(config);
        break;
      case "kimi":
        provider = new KimiProvider(config);
        break;
      case "pi":
        provider = new PiProvider(config);
        break;
      case "openai-compatible":
        provider = new OpenAICompatibleProvider({
          type: "openai-compatible",
          providerName: "OpenAI-Compatible",
          apiKey: config.openaiCompatibleApiKey || "",
          baseUrl: config.openaiCompatibleBaseUrl || "http://localhost:1234/v1",
          defaultModel: config.model,
        });
        break;
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }

    return wrapProviderWithDetailedLogging(provider);
  }

  /**
   * Get the model ID for a provider
   */
  static getModelId(
    modelKey: ModelKey | string,
    providerType: LLMProviderType,
    ollamaModel?: string,
    geminiModel?: string,
    openrouterModel?: string,
    openaiModel?: string,
    azureDeployment?: string,
    azureAnthropicDeployment?: string,
    groqModel?: string,
    xaiModel?: string,
    kimiModel?: string,
    customProviders?: Record<string, CustomProviderConfig>,
    bedrockModel?: string,
  ): string {
    const customEntry = getCustomProviderEntry(providerType);
    if (customEntry) {
      const customConfig = getCustomProviderConfig(
        customProviders,
        providerType,
      );
      return customConfig?.model || customEntry.defaultModel;
    }

    // For Ollama, use the specific Ollama model if provided
    if (providerType === "ollama") {
      return ollamaModel || "gpt-oss:20b";
    }

    // For Gemini, use the specific Gemini model if provided or default
    if (providerType === "gemini") {
      return geminiModel || "gemini-2.0-flash";
    }

    // For OpenRouter, use the specific model if provided or default
    if (providerType === "openrouter") {
      return openrouterModel || OPENROUTER_DEFAULT_MODEL;
    }

    // For OpenAI, use the specific model if provided or default
    if (providerType === "openai") {
      return openaiModel || "gpt-4o-mini";
    }

    // For Azure OpenAI, use the deployment name
    if (providerType === "azure") {
      return azureDeployment || "";
    }

    // For Azure Anthropic, use the deployment name
    if (providerType === "azure-anthropic") {
      return azureAnthropicDeployment || "";
    }

    // For Groq, use the specific model if provided or default
    if (providerType === "groq") {
      return groqModel || "llama-3.1-8b-instant";
    }

    // For xAI, use the specific model if provided or default
    if (providerType === "xai") {
      return xaiModel || "grok-4-fast-non-reasoning";
    }

    // For Kimi, use the specific model if provided or default
    if (providerType === "kimi") {
      return kimiModel || "kimi-k2.5";
    }

    // For Pi, use the specific model from settings
    if (providerType === "pi") {
      const settings = this.loadSettings();
      return settings.pi?.model || DEFAULT_PI_MODEL;
    }

    // For OpenAI-compatible, use the specific model from settings
    if (providerType === "openai-compatible") {
      const settings = this.loadSettings();
      return settings.openaiCompatible?.model || "";
    }

    // For Bedrock, prefer an explicit Bedrock model ID if configured.
    if (providerType === "bedrock") {
      const configuredBedrockModel = bedrockModel?.trim();
      if (configuredBedrockModel) {
        return configuredBedrockModel;
      }

      if (typeof modelKey === "string") {
        const trimmedModelKey = modelKey.trim();
        if (
          trimmedModelKey.startsWith("anthropic.") ||
          trimmedModelKey.startsWith("us.")
        ) {
          return trimmedModelKey;
        }
      }

      const mappedBedrockModel = MODELS[modelKey as ModelKey]?.bedrock;
      if (mappedBedrockModel) {
        return mappedBedrockModel;
      }

      if (typeof modelKey === "string" && modelKey.trim().length > 0) {
        return modelKey.trim();
      }
    }

    if (providerType === "anthropic" && typeof modelKey === "string") {
      const trimmedModelKey = modelKey.trim();
      if (trimmedModelKey.startsWith("claude-")) {
        return normalizeAnthropicModelId(trimmedModelKey);
      }
    }

    // For other providers, look up in MODELS
    const model = MODELS[modelKey as ModelKey];
    if (!model) {
      throw new Error(`Unknown model: ${modelKey}`);
    }
    const resolvedModel = model[providerType as "anthropic" | "bedrock"];
    return providerType === "anthropic"
      ? normalizeAnthropicModelId(resolvedModel)
      : resolvedModel;
  }

  /**
   * Get display name for a model
   */
  static getModelDisplayName(modelKey: ModelKey): string {
    return MODELS[modelKey]?.displayName || modelKey;
  }

  /**
   * Get all available models
   */
  static getAvailableModels(): Array<{ key: ModelKey; displayName: string }> {
    return Object.entries(MODELS).map(([key, value]) => ({
      key: key as ModelKey,
      displayName: value.displayName,
    }));
  }

  /**
   * Get available providers based on saved settings configuration
   * Note: Environment variables are no longer checked for security reasons.
   */
  static getAvailableProviders(): Array<{
    type: LLMProviderType;
    name: string;
    configured: boolean;
  }> {
    const settings = this.loadSettings();

    const builtIns = [
      {
        type: "openrouter" as LLMProviderType,
        name: "OpenRouter",
        configured: !!settings.openrouter?.apiKey,
      },
      {
        type: "anthropic" as LLMProviderType,
        name: "Claude",
        configured: !!resolveAnthropicCredential(settings.anthropic),
      },
      {
        type: "gemini" as LLMProviderType,
        name: "Google Gemini",
        configured: !!settings.gemini?.apiKey,
      },
      {
        type: "openai" as LLMProviderType,
        name: "OpenAI",
        configured: !!(settings.openai?.apiKey || settings.openai?.accessToken),
      },
      {
        type: "azure" as LLMProviderType,
        name: "Azure OpenAI",
        configured: !!(
          settings.azure?.apiKey &&
          settings.azure?.endpoint &&
          (settings.azure?.deployment || settings.azure?.deployments?.length)
        ),
      },
      {
        type: "azure-anthropic" as LLMProviderType,
        name: "Azure Anthropic",
        configured: !!(
          settings.azureAnthropic?.apiKey &&
          settings.azureAnthropic?.endpoint &&
          (settings.azureAnthropic?.deployment ||
            settings.azureAnthropic?.deployments?.length)
        ),
      },
      {
        type: "groq" as LLMProviderType,
        name: "Groq",
        configured: !!settings.groq?.apiKey,
      },
      {
        type: "xai" as LLMProviderType,
        name: "xAI (Grok)",
        configured: !!settings.xai?.apiKey,
      },
      {
        type: "kimi" as LLMProviderType,
        name: "Kimi",
        configured: !!settings.kimi?.apiKey,
      },
      {
        type: "bedrock" as LLMProviderType,
        name: "AWS Bedrock",
        configured: !!(
          settings.bedrock?.accessKeyId ||
          settings.bedrock?.profile ||
          settings.bedrock?.useDefaultCredentials ||
          settings.bedrock?.region
        ),
      },
      {
        type: "ollama" as LLMProviderType,
        name: "Ollama (Local)",
        configured: !!(settings.ollama?.baseUrl || settings.ollama?.model),
      },
      {
        type: "pi" as LLMProviderType,
        name: "Pi (Unified)",
        configured: !!(settings.pi?.apiKey && settings.pi?.provider),
      },
      {
        type: "openai-compatible" as LLMProviderType,
        name: "OpenAI-Compatible",
        configured: !!(
          settings.openaiCompatible?.baseUrl && settings.openaiCompatible?.model
        ),
      },
    ];

    const customProviders = CUSTOM_PROVIDER_CATALOG.map(
      (entry: ProviderCatalogEntry) => {
        const config = getCustomProviderConfig(
          settings.customProviders,
          entry.id,
        );
        return {
          type: entry.id,
          name: entry.name,
          configured: isCustomProviderConfigured(entry, config),
        };
      },
    );

    return [...builtIns, ...customProviders];
  }

  /**
   * Get current configuration status
   */
  static getConfigStatus(): {
    currentProvider: LLMProviderType;
    currentModel: string;
    currentReasoningEffort?: LLMReasoningEffort;
    providers: Array<{
      type: LLMProviderType;
      name: string;
      configured: boolean;
    }>;
    models: Array<{
      key: string;
      displayName: string;
      description: string;
      reasoningEfforts?: LLMReasoningEffort[];
    }>;
    routing?: {
      currentProvider: LLMProviderType;
      currentModel: string;
      activeProvider: LLMProviderType;
      activeModel: string;
      routeReason:
        | "manual_override"
        | "profile_routing"
        | "automatic_execution"
        | "verification"
        | "fallback"
        | "provider_outage"
        | "quota"
        | "model_capability"
        | "unknown";
      fallbackChain: Array<{
        providerType: LLMProviderType;
        modelKey: string;
        reason: string;
        attemptedAt: number;
        success: boolean;
        error?: string;
      }>;
      fallbackOccurred: boolean;
      manualOverride: boolean;
      profileHint?: LlmProfile;
      updatedAt: number;
    };
  } {
    const settings = this.loadSettings();
    const modelStatus = this.getProviderModelStatus(settings);
    const routingSettings = this.getProviderRoutingSettings(
      settings,
      settings.providerType,
    );
    const currentModel = modelStatus.currentModel;
    return {
      currentProvider: settings.providerType,
      currentModel,
      currentReasoningEffort: routingSettings.reasoningEffort,
      providers: this.getAvailableProviders(),
      models: modelStatus.models,
      routing: {
        currentProvider: settings.providerType,
        currentModel,
        activeProvider: settings.providerType,
        activeModel: currentModel,
        routeReason: routingSettings.profileRoutingEnabled
          ? "profile_routing"
          : "manual_override",
        fallbackChain: [],
        fallbackOccurred: false,
        manualOverride: false,
        profileHint: routingSettings.profileRoutingEnabled ? "cheap" : "strong",
        updatedAt: Date.now(),
      },
    };
  }

  /**
   * Get the currently selected provider type
   */
  static getSelectedProvider(): LLMProviderType {
    const settings = this.loadSettings();
    return settings.providerType;
  }

  /**
   * Get the currently selected model key
   */
  static getSelectedModel(): string {
    const settings = this.loadSettings();
    return this.getProviderModelStatus(settings).currentModel;
  }

  /**
   * Get model list and selected model for the active provider.
   * This is the shared source of truth used by both renderer IPC and gateway commands.
   */
  static getProviderModelStatus(settings: LLMSettings): {
    currentModel: string;
    models: CachedModelInfo[];
  } {
    const resolvedProviderType = resolveCustomProviderId(settings.providerType);
    const attachMetadata = (models: CachedModelInfo[]) =>
      withLlmModelSelectionMetadata(settings.providerType, models);
    const customEntry = CUSTOM_PROVIDER_MAP.get(resolvedProviderType as Any);
    const ensureCurrentModel = (
      modelList: CachedModelInfo[],
      modelKey: string,
      description = "Selected model",
    ) => {
      if (!modelKey || modelList.some((model) => model.key === modelKey)) {
        return modelList;
      }
      // For Bedrock, try to format the raw model ID into a readable display name
      const displayName =
        settings.providerType === "bedrock"
          ? this.formatBedrockProfileName(modelKey)
          : modelKey;
      return [
        {
          key: modelKey,
          displayName,
          description,
        },
        ...modelList,
      ];
    };

    if (customEntry) {
      const customConfig =
        settings.customProviders?.[resolvedProviderType] ||
        settings.customProviders?.[settings.providerType];

      // Guard against cross-provider model contamination: if the stored model for this
      // custom provider matches a model that belongs to a different provider (e.g. an
      // Azure deployment name stored as minimax-portal's model), ignore it and fall
      // back to this provider's catalog default.
      const storedModel = customConfig?.model;
      const isFromAnotherProvider =
        storedModel != null &&
        (settings.azure?.deployments?.includes(storedModel) ||
          settings.azure?.deployment === storedModel ||
          settings.openai?.model === storedModel ||
          settings.gemini?.model === storedModel ||
          settings.openrouter?.model === storedModel ||
          settings.ollama?.model === storedModel ||
          settings.groq?.model === storedModel ||
          settings.xai?.model === storedModel ||
          settings.kimi?.model === storedModel ||
          settings.openaiCompatible?.model === storedModel);
      const currentModel =
        (!isFromAnotherProvider && storedModel) ||
        customEntry.defaultModel ||
        "";
      const cachedModels =
        customConfig?.cachedModels && customConfig.cachedModels.length > 0
          ? customConfig.cachedModels
          : currentModel
            ? [
                {
                  key: currentModel,
                  displayName: currentModel,
                  description:
                    customEntry.description || `${customEntry.name} model`,
                },
              ]
            : [];
      const modelList = mergeCustomProviderModels(
        customEntry,
        cachedModels,
        getKnownCustomProviderModels(customEntry),
      );
      return {
        currentModel,
        models: attachMetadata(
          ensureCurrentModel(
            modelList,
            currentModel,
            customEntry.description || `${customEntry.name} model`,
          ),
        ),
      };
    }

    switch (settings.providerType) {
      case "bedrock": {
        const fallbackModel = MODELS[settings.modelKey as ModelKey]?.bedrock;
        const currentModel =
          settings.bedrock?.model || fallbackModel || settings.modelKey;
        const modelList =
          settings.cachedBedrockModels &&
          settings.cachedBedrockModels.length > 0
            ? settings.cachedBedrockModels
            : Object.values(MODELS).map((value) => ({
                key: value.bedrock,
                displayName: value.displayName,
                description: value.displayName.toLowerCase().includes("opus")
                  ? "Most capable for complex work"
                  : value.displayName.toLowerCase().includes("sonnet")
                    ? "Balanced performance and speed"
                    : "Fast and efficient",
              }));
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "gemini": {
        const currentModel = settings.gemini?.model || "gemini-2.0-flash";
        const modelList =
          settings.cachedGeminiModels && settings.cachedGeminiModels.length > 0
            ? settings.cachedGeminiModels
            : Object.values(GEMINI_MODELS).map((value) => ({
                key: value.id,
                displayName: value.displayName,
                description: value.description,
              }));
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "openrouter": {
        const currentModel =
          settings.openrouter?.model || OPENROUTER_DEFAULT_MODEL;
        const modelList =
          settings.cachedOpenRouterModels &&
          settings.cachedOpenRouterModels.length > 0
            ? settings.cachedOpenRouterModels
            : Object.values(OPENROUTER_MODELS).map((value) => ({
                key: value.id,
                displayName: value.displayName,
                description: value.description,
              }));
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "openai": {
        const currentModel = settings.openai?.model || "gpt-4o-mini";
        const modelList =
          settings.cachedOpenAIModels && settings.cachedOpenAIModels.length > 0
            ? settings.cachedOpenAIModels
            : [
                {
                  key: "gpt-4o",
                  displayName: "GPT-4o",
                  description: "Most capable model for complex tasks",
                },
                {
                  key: "gpt-4o-mini",
                  displayName: "GPT-4o Mini",
                  description: "Fast and affordable for most tasks",
                },
                {
                  key: "gpt-4-turbo",
                  displayName: "GPT-4 Turbo",
                  description: "Previous generation flagship",
                },
                {
                  key: "gpt-3.5-turbo",
                  displayName: "GPT-3.5 Turbo",
                  description: "Fast and cost-effective",
                },
                {
                  key: "o1",
                  displayName: "o1",
                  description: "Advanced reasoning model",
                },
                {
                  key: "o1-mini",
                  displayName: "o1 Mini",
                  description: "Fast reasoning model",
                },
              ];
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "azure": {
        const deployments = (settings.azure?.deployments || []).filter(Boolean);
        const currentModel =
          settings.azure?.deployment || deployments[0] || "deployment-name";
        const modelList = deployments.map((deployment) => ({
          key: deployment,
          displayName: deployment,
          description: "Azure OpenAI deployment",
        }));
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "azure-anthropic": {
        const deployments = (settings.azureAnthropic?.deployments || []).filter(
          Boolean,
        );
        const currentModel =
          settings.azureAnthropic?.deployment ||
          deployments[0] ||
          "claude-opus-4-6";
        const modelList = deployments.length
          ? deployments.map((d) => ({
              key: d,
              displayName: d,
              description: "Azure Anthropic deployment",
            }))
          : [
              {
                key: "claude-opus-4-6",
                displayName: "Claude Opus 4.6",
                description: "Azure Anthropic",
              },
              {
                key: "claude-sonnet-4-6",
                displayName: "Claude Sonnet 4.6",
                description: "Azure Anthropic",
              },
              {
                key: "claude-haiku-4-6",
                displayName: "Claude Haiku 4.6",
                description: "Azure Anthropic",
              },
            ];
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "ollama": {
        const currentModel = settings.ollama?.model || "llama3.2";
        const modelList =
          settings.cachedOllamaModels && settings.cachedOllamaModels.length > 0
            ? settings.cachedOllamaModels
            : Object.entries(OLLAMA_MODELS).map(([key, value]) => ({
                key,
                displayName: value.displayName,
                description: `${value.size} parameter model`,
              }));
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "anthropic": {
        const currentModel = settings.modelKey;
        const modelList =
          settings.cachedAnthropicModels &&
          settings.cachedAnthropicModels.length > 0
            ? settings.cachedAnthropicModels
            : [
                {
                  key: "opus-4-6",
                  displayName: "Opus 4.6",
                  description: "Most capable model for complex tasks",
                },
                {
                  key: "opus-4-5",
                  displayName: "Opus 4.5",
                  description: "Previous flagship Claude model",
                },
                {
                  key: "sonnet-4-6",
                  displayName: "Sonnet 4.6",
                  description: "Best model for everyday coding tasks",
                },
                {
                  key: "sonnet-4-5",
                  displayName: "Sonnet 4.5",
                  description: "Previous generation balanced model",
                },
                {
                  key: "haiku-4-5",
                  displayName: "Haiku 4.5",
                  description: "Fastest Claude model",
                },
                {
                  key: "sonnet-4",
                  displayName: "Sonnet 4",
                  description: "Older Claude 4 model",
                },
                {
                  key: "sonnet-3-5",
                  displayName: "Sonnet 3.5",
                  description: "Legacy balanced model",
                },
                {
                  key: "haiku-3-5",
                  displayName: "Haiku 3.5",
                  description: "Legacy fast model",
                },
              ];
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "groq": {
        const currentModel = settings.groq?.model || "llama-3.1-8b-instant";
        const modelList =
          settings.cachedGroqModels && settings.cachedGroqModels.length > 0
            ? settings.cachedGroqModels
            : Object.values(GROQ_MODELS).map((value) => ({
                key: value.id,
                displayName: value.displayName,
                description: value.description,
              }));
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "xai": {
        const currentModel = settings.xai?.model || "grok-4-fast-non-reasoning";
        const modelList =
          settings.cachedXaiModels && settings.cachedXaiModels.length > 0
            ? settings.cachedXaiModels
            : Object.values(XAI_MODELS).map((value) => ({
                key: value.id,
                displayName: value.displayName,
                description: value.description,
              }));
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "kimi": {
        const currentModel = settings.kimi?.model || "kimi-k2.5";
        const modelList =
          settings.cachedKimiModels && settings.cachedKimiModels.length > 0
            ? settings.cachedKimiModels
            : Object.values(KIMI_MODELS).map((value) => ({
                key: value.id,
                displayName: value.displayName,
                description: value.description,
              }));
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      case "pi": {
        const currentModel = settings.pi?.model || DEFAULT_PI_MODEL;
        const modelList =
          settings.cachedPiModels && settings.cachedPiModels.length > 0
            ? settings.cachedPiModels
            : [
                {
                  key: currentModel,
                  displayName: currentModel,
                  description: "Selected Pi model",
                },
              ];
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(
            modelList,
            currentModel,
            "Selected Pi model",
          )),
        };
      }

      case "openai-compatible": {
        const currentModel = settings.openaiCompatible?.model || "";
        const modelList =
          settings.cachedOpenAICompatibleModels &&
          settings.cachedOpenAICompatibleModels.length > 0
            ? settings.cachedOpenAICompatibleModels
            : currentModel
              ? [
                  {
                    key: currentModel,
                    displayName: currentModel,
                    description: "OpenAI-compatible model",
                  },
                ]
              : [];
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }

      default: {
        const currentModel = settings.modelKey;
        const modelList = Object.entries(MODELS).map(([key, value]) => ({
          key,
          displayName: value.displayName,
          description: "Claude model",
        }));
        return {
          currentModel,
          models: attachMetadata(ensureCurrentModel(modelList, currentModel)),
        };
      }
    }
  }

  /**
   * Apply a model selection to provider-specific settings.
   */
  static applyModelSelection(
    settings: LLMSettings,
    modelKey: string,
    providerTypeOverride?: LLMProviderType,
  ): LLMSettings {
    const providerType = providerTypeOverride || settings.providerType;
    const updated: LLMSettings = { ...settings, providerType };
    const resolvedProviderType = resolveCustomProviderId(providerType);

    if (CUSTOM_PROVIDER_IDS.has(resolvedProviderType as Any)) {
      const existing = settings.customProviders?.[resolvedProviderType] || {};
      updated.customProviders = {
        ...settings.customProviders,
        [resolvedProviderType]: {
          ...existing,
          model: modelKey,
        },
      };
      return updated;
    }

    switch (providerType) {
      case "gemini":
        updated.gemini = { ...settings.gemini, model: modelKey };
        break;
      case "openrouter":
        updated.openrouter = { ...settings.openrouter, model: modelKey };
        break;
      case "ollama":
        updated.ollama = { ...settings.ollama, model: modelKey };
        break;
      case "openai":
        updated.openai = { ...settings.openai, model: modelKey };
        break;
      case "azure": {
        const existingDeployments = (settings.azure?.deployments || []).filter(
          Boolean,
        );
        const nextDeployments = existingDeployments.includes(modelKey)
          ? existingDeployments
          : [modelKey, ...existingDeployments];
        updated.azure = {
          ...settings.azure,
          deployment: modelKey,
          deployments: nextDeployments.length > 0 ? nextDeployments : undefined,
        };
        break;
      }
      case "azure-anthropic": {
        const existingDeployments = (
          settings.azureAnthropic?.deployments || []
        ).filter(Boolean);
        const nextDeployments = existingDeployments.includes(modelKey)
          ? existingDeployments
          : [modelKey, ...existingDeployments];
        updated.azureAnthropic = {
          ...settings.azureAnthropic,
          deployment: modelKey,
          deployments: nextDeployments.length > 0 ? nextDeployments : undefined,
        };
        break;
      }
      case "groq":
        updated.groq = { ...settings.groq, model: modelKey };
        break;
      case "xai":
        updated.xai = { ...settings.xai, model: modelKey };
        break;
      case "kimi":
        updated.kimi = { ...settings.kimi, model: modelKey };
        break;
      case "pi":
        updated.pi = { ...settings.pi, model: modelKey };
        break;
      case "openai-compatible":
        updated.openaiCompatible = {
          ...settings.openaiCompatible,
          model: modelKey,
        };
        break;
      case "anthropic":
        updated.modelKey = modelKey as ModelKey;
        break;
      case "bedrock": {
        const knownBedrockEntry = Object.entries(MODELS).find(
          ([, value]) => value.bedrock === modelKey,
        );
        const resolvedBedrockModel = knownBedrockEntry
          ? knownBedrockEntry[1].bedrock
          : MODELS[modelKey as ModelKey]?.bedrock || modelKey;

        updated.bedrock = {
          ...settings.bedrock,
          model: resolvedBedrockModel,
        };

        if (knownBedrockEntry) {
          updated.modelKey = knownBedrockEntry[0] as ModelKey;
        } else if (MODELS[modelKey as ModelKey]) {
          updated.modelKey = modelKey as ModelKey;
        }
        break;
      }
      default:
        updated.modelKey = modelKey as ModelKey;
        break;
    }

    return updated;
  }

  static applyReasoningEffortSelection(
    settings: LLMSettings,
    providerType: LLMProviderType,
    reasoningEffort?: LLMReasoningEffort,
  ): LLMSettings {
    if (!reasoningEffort) return settings;

    if (providerType === "azure") {
      return {
        ...settings,
        azure: {
          ...settings.azure,
          reasoningEffort,
        },
      };
    }

    const resolvedProviderType = resolveCustomProviderId(providerType);
    if (CUSTOM_PROVIDER_IDS.has(resolvedProviderType as Any)) {
      const existing = settings.customProviders?.[resolvedProviderType] || {};
      return {
        ...settings,
        customProviders: {
          ...settings.customProviders,
          [resolvedProviderType]: {
            ...existing,
            reasoningEffort,
          },
        },
      };
    }

    const patchProviderRouting = <K extends keyof LLMSettings>(
      key: K,
    ): LLMSettings => ({
      ...settings,
      [key]: {
        ...(settings[key] as Record<string, unknown> | undefined),
        reasoningEffort,
      },
    });

    switch (providerType) {
      case "anthropic":
        return patchProviderRouting("anthropic");
      case "bedrock":
        return patchProviderRouting("bedrock");
      case "ollama":
        return patchProviderRouting("ollama");
      case "gemini":
        return patchProviderRouting("gemini");
      case "openrouter":
        return patchProviderRouting("openrouter");
      case "openai":
        return patchProviderRouting("openai");
      case "azure-anthropic":
        return patchProviderRouting("azureAnthropic");
      case "groq":
        return patchProviderRouting("groq");
      case "xai":
        return patchProviderRouting("xai");
      case "kimi":
        return patchProviderRouting("kimi");
      case "pi":
        return patchProviderRouting("pi");
      case "openai-compatible":
        return patchProviderRouting("openaiCompatible");
      default:
        return settings;
    }
  }

  /**
   * Get the current LLM settings
   */
  static getSettings(): LLMSettings {
    return this.loadSettings();
  }

  /**
   * Test a provider configuration
   */
  static async testProvider(
    config: LLMProviderConfig,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const provider = this.createProviderFromConfig(config);
      return await provider.testConnection();
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to create provider",
      };
    }
  }

  /**
   * Format verbose AWS Bedrock inference profile names into concise display names.
   *
   * Handles both human-readable profile names and raw Bedrock model IDs:
   *   "US Anthropic Claude Opus 4.6"               → "Opus 4.6 US"
   *   "Global Anthropic Claude Sonnet 4.6"          → "Sonnet 4.6 GL"
   *   "US Anthropic Claude 3.5 Sonnet"              → "Sonnet 3.5 US"
   *   "US Claude Opus 4"                            → "Opus 4 US"
   *   "GLOBAL Anthropic Claude Haiku 4.5"           → "Haiku 4.5 GL"
   *   "us.anthropic.claude-sonnet-4-6-v1:0"         → "Sonnet 4.6 US"
   *   "anthropic.claude-opus-4-5-20251101"           → "Opus 4.5"
   *   "eu.anthropic.claude-3-5-sonnet-20241022-v2:0" → "Sonnet 3.5 EU"
   */
  private static formatBedrockProfileName(rawName: string): string {
    const name = rawName.trim();
    if (!name) return name;

    // Try to parse raw Bedrock model IDs first (e.g. "us.anthropic.claude-opus-4-5-20251101-v1:0")
    const idResult = this.formatBedrockModelId(name);
    if (idResult) return idResult;

    // Extract region prefix (US / Global / EU / AP / SA etc.)
    let regionTag = "";
    let rest = name;
    const regionMatch = name.match(/^(US|Global|EU|AP(?:-\w+)?|SA)\s+/i);
    if (regionMatch) {
      const prefix = regionMatch[1].toUpperCase();
      regionTag = prefix === "GLOBAL" ? "GL" : prefix;
      rest = name.slice(regionMatch[0].length);
    }

    // Strip "Anthropic" and "Claude" keywords
    rest = rest
      .replace(/\bAnthropic\b/gi, "")
      .replace(/\bClaude\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    // Extract model family and version from whatever remains.
    // Handles both "Family Version" (Opus 4.6) and "Version Family" (3.5 Sonnet).
    const families = ["Opus", "Sonnet", "Haiku"];
    let family = "";
    let version = "";

    for (const f of families) {
      // Pattern: "Family Version" e.g. "Opus 4.6"
      const fv = rest.match(new RegExp(`\\b${f}\\s+([\\d.]+)`, "i"));
      if (fv) {
        family = f;
        version = fv[1];
        break;
      }
      // Pattern: "Version Family" e.g. "3.5 Sonnet"
      const vf = rest.match(new RegExp(`([\\d.]+)\\s+${f}`, "i"));
      if (vf) {
        family = f;
        version = vf[1];
        break;
      }
    }

    if (family && version) {
      return regionTag
        ? `${family} ${version} ${regionTag}`
        : `${family} ${version}`;
    }

    // Couldn't parse — return cleaned-up name with region suffix if available
    return regionTag ? `${rest} ${regionTag}` : name;
  }

  /**
   * Parse a raw Bedrock model/inference-profile ID into a concise display name.
   *
   * Examples:
   *   "us.anthropic.claude-sonnet-4-6-v1:0"           → "Sonnet 4.6 US"
   *   "eu.anthropic.claude-3-5-sonnet-20241022-v2:0"   → "Sonnet 3.5 EU"
   *   "anthropic.claude-opus-4-5-20251101"              → "Opus 4.5"
   *   "us.anthropic.claude-3-5-haiku-20241022-v1:0"    → "Haiku 3.5 US"
   *
   * Returns null if the string doesn't look like a Bedrock model ID.
   */
  private static formatBedrockModelId(raw: string): string | null {
    // Match Bedrock model ID patterns:
    //  [region.]anthropic.claude-<family>-<version>[-date][-vN:M]
    //  [region.]anthropic.claude-<version>-<family>[-date][-vN:M]
    const idMatch = raw.match(
      /^(?:(us|eu|ap[\w-]*|sa)\.)?anthropic\.claude-(.+?)(?:-\d{8,})?(?:-v\d+:\d+)?$/i,
    );
    if (!idMatch) return null;

    const regionPrefix = idMatch[1]?.toUpperCase() || "";
    const slug = idMatch[2]; // e.g. "opus-4-5", "3-5-sonnet", "sonnet-4-6"

    const families = ["opus", "sonnet", "haiku"];
    let family = "";
    let version = "";

    for (const f of families) {
      // "family-M-N" e.g. "opus-4-5" → Opus 4.5
      const fv = slug.match(new RegExp(`^${f}-(\\d+(?:-\\d+)?)$`, "i"));
      if (fv) {
        family = f.charAt(0).toUpperCase() + f.slice(1);
        version = fv[1].replace(/-/g, ".");
        break;
      }
      // "M-N-family" e.g. "3-5-sonnet" → Sonnet 3.5
      const vf = slug.match(new RegExp(`^(\\d+(?:-\\d+)?)-${f}$`, "i"));
      if (vf) {
        family = f.charAt(0).toUpperCase() + f.slice(1);
        version = vf[1].replace(/-/g, ".");
        break;
      }
    }

    if (!family || !version) return null;

    return regionPrefix
      ? `${family} ${version} ${regionPrefix}`
      : `${family} ${version}`;
  }

  /**
   * Fetch available Bedrock models from AWS
   */
  static async getBedrockModels(config?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
  }): Promise<
    Array<{ id: string; name: string; provider: string; description: string }>
  > {
    const settings = this.loadSettings();
    const region = config?.region || settings.bedrock?.region || "us-east-1";
    const accessKeyId = config?.accessKeyId || settings.bedrock?.accessKeyId;
    const secretAccessKey =
      config?.secretAccessKey || settings.bedrock?.secretAccessKey;
    const profile = config?.profile || settings.bedrock?.profile;

    // Default Claude models available on Bedrock (these are inference profile IDs).
    const defaultModels = Object.entries(MODELS).map(([key, value]) => ({
      id: value.bedrock,
      name: value.displayName,
      provider: "Anthropic",
      description: key.includes("opus")
        ? "Most capable for complex tasks (inference profile)"
        : key.includes("sonnet")
          ? "Balanced performance and speed (inference profile)"
          : "Fast and efficient (inference profile)",
    }));

    try {
      // Import BedrockClient for listing inference profiles/models (different from runtime client)
      const { BedrockClient, ListInferenceProfilesCommand } =
        await import("@aws-sdk/client-bedrock");
      const { fromIni } = await import("@aws-sdk/credential-provider-ini");

      const clientConfig: Any = { region };

      if (accessKeyId && secretAccessKey) {
        clientConfig.credentials = {
          accessKeyId,
          secretAccessKey,
        };
      } else if (profile) {
        clientConfig.credentials = fromIni({ profile });
      }

      const client = new BedrockClient(clientConfig);

      // Prefer inference profiles for Claude models; many newer Bedrock models
      // require an inference profile ID/ARN instead of the foundation model ID.
      const inferenceProfiles: Array<{
        id: string;
        name: string;
        provider: string;
        description: string;
      }> = [];
      let nextToken: string | undefined;
      let pageCount = 0;

      do {
        pageCount++;
        const response = await client.send(
          new ListInferenceProfilesCommand({
            maxResults: 100,
            nextToken,
          }),
        );

        const profiles = response.inferenceProfileSummaries || [];
        for (const profileSummary of profiles as Any[]) {
          if (profileSummary?.status && profileSummary.status !== "ACTIVE")
            continue;

          const models = (profileSummary?.models || []) as Array<{
            modelArn?: string;
          }>;
          const hasClaudeModel = models.some((m) => {
            const arn = (m?.modelArn || "").toLowerCase();
            return arn.includes("anthropic") && arn.includes("claude");
          });
          if (!hasClaudeModel) continue;

          const id = (
            profileSummary?.inferenceProfileId ||
            profileSummary?.inferenceProfileArn ||
            ""
          ).trim();
          if (!id) continue;

          const name = this.formatBedrockProfileName(
            (profileSummary?.inferenceProfileName || id).trim(),
          );
          const type = profileSummary?.type
            ? String(profileSummary.type)
            : "INFERENCE_PROFILE";
          const description = profileSummary?.description
            ? String(profileSummary.description)
            : `Inference profile (${type})`;

          inferenceProfiles.push({
            id,
            name,
            provider: "Anthropic",
            description,
          });
        }

        nextToken = response.nextToken;
        // Safety cap to avoid unexpectedly huge listings.
      } while (nextToken && pageCount < 10);

      // When we have API results, prefer inference profiles over defaults.
      // Defaults use bare model IDs (e.g. "anthropic.claude-opus-4-5-20251101")
      // while API profiles use inference profile IDs (e.g. "us.anthropic.claude-opus-4-5-20251101-v1:0").
      // Deduplicate so users see only the formatted API profiles with region tags.
      if (inferenceProfiles.length > 0) {
        // Build a set of model family+version keys from API profiles for dedup
        const apiNameKeys = new Set(
          inferenceProfiles.map((p) => p.name.toLowerCase()),
        );
        const seen = new Set<string>();
        const merged: Array<{
          id: string;
          name: string;
          provider: string;
          description: string;
        }> = [];

        // Add inference profiles first (they have region info)
        for (const entry of inferenceProfiles) {
          if (!entry.id || seen.has(entry.id)) continue;
          seen.add(entry.id);
          merged.push(entry);
        }

        // Only add defaults that don't overlap with an API profile by display name
        for (const entry of defaultModels) {
          if (!entry.id || seen.has(entry.id)) continue;
          // Skip defaults whose display name (e.g. "Opus 4.5") is a prefix of an API profile name
          // (e.g. "Opus 4.5 US"), since the API version is more informative
          const baseName = entry.name.toLowerCase();
          const hasApiEquivalent =
            apiNameKeys.has(baseName) ||
            [...apiNameKeys].some((k) => k.startsWith(baseName + " "));
          if (hasApiEquivalent) continue;
          seen.add(entry.id);
          merged.push(entry);
        }

        return merged;
      }

      return defaultModels;
    } catch (error: Any) {
      console.error("Failed to fetch Bedrock models:", error);
      // Return default models on error
      return defaultModels;
    }
  }

  /**
   * Fetch available Ollama models from the server
   */
  static async getOllamaModels(
    baseUrl?: string,
  ): Promise<Array<{ name: string; size: number; modified: string }>> {
    const settings = this.loadSettings();
    const url = baseUrl || settings.ollama?.baseUrl || "http://localhost:11434";

    try {
      console.log(`[ProviderFactory] Fetching Ollama models from ${url}...`);
      const provider = new OllamaProvider({
        type: "ollama",
        model: "",
        ollamaBaseUrl: url,
        ollamaApiKey: settings.ollama?.apiKey,
      });
      const models = await provider.getAvailableModels();
      console.log(
        `[ProviderFactory] Fetched ${models.length} models from Ollama`,
      );
      return models;
    } catch (error: Any) {
      console.error("Failed to fetch Ollama models:", error);
      return [];
    }
  }

  /**
   * Fetch available Gemini models from the API
   */
  static async getGeminiModels(
    apiKey?: string,
  ): Promise<
    Array<{ name: string; displayName: string; description: string }>
  > {
    const settings = this.loadSettings();
    // Normalize empty strings to undefined
    const normalizedApiKey = apiKey?.trim() || undefined;
    const settingsKey = settings.gemini?.apiKey;
    const key = normalizedApiKey || settingsKey;

    const defaultModels = [
      {
        name: "gemini-2.5-pro-preview-05-06",
        displayName: "Gemini 2.5 Pro",
        description: "Most capable model for complex tasks",
      },
      {
        name: "gemini-2.5-flash-preview-05-20",
        displayName: "Gemini 2.5 Flash",
        description: "Fast and efficient for most tasks",
      },
      {
        name: "gemini-2.0-flash",
        displayName: "Gemini 2.0 Flash",
        description: "Balanced speed and capability",
      },
      {
        name: "gemini-2.0-flash-lite",
        displayName: "Gemini 2.0 Flash Lite",
        description: "Fastest and most cost-effective",
      },
      {
        name: "gemini-1.5-pro",
        displayName: "Gemini 1.5 Pro",
        description: "Previous generation pro model",
      },
      {
        name: "gemini-1.5-flash",
        displayName: "Gemini 1.5 Flash",
        description: "Previous generation flash model",
      },
    ];

    if (!key) {
      // Return default models if no API key
      return defaultModels;
    }

    try {
      const provider = new GeminiProvider({
        type: "gemini",
        model: "",
        geminiApiKey: key,
      });
      return await provider.getAvailableModels();
    } catch (error: Any) {
      console.error("Failed to fetch Gemini models:", error);
      // Return default models on error instead of empty array
      return defaultModels;
    }
  }

  /**
   * Fetch available Claude models from Anthropic's Models API
   */
  static async getAnthropicModels(credentials?: {
    apiKey?: string;
    subscriptionToken?: string;
    authMethod?: "api_key" | "subscription";
  }): Promise<Array<{ id: string; displayName: string; description: string }>> {
    const settings = this.loadSettings();
    const credential = resolveAnthropicCredential(
      credentials || settings.anthropic,
    );

    const defaultModels = [
      {
        id: "opus-4-6",
        displayName: "Opus 4.6",
        description: "Most capable model for complex tasks",
      },
      {
        id: "opus-4-5",
        displayName: "Opus 4.5",
        description: "Previous flagship Claude model",
      },
      {
        id: "sonnet-4-6",
        displayName: "Sonnet 4.6",
        description: "Best model for everyday coding tasks",
      },
      {
        id: "sonnet-4-5",
        displayName: "Sonnet 4.5",
        description: "Previous generation balanced model",
      },
      {
        id: "haiku-4-5",
        displayName: "Haiku 4.5",
        description: "Fastest Claude model",
      },
      {
        id: "sonnet-4",
        displayName: "Sonnet 4",
        description: "Older Claude 4 model",
      },
      {
        id: "sonnet-3-5",
        displayName: "Sonnet 3.5",
        description: "Legacy balanced model",
      },
      {
        id: "haiku-3-5",
        displayName: "Haiku 3.5",
        description: "Legacy fast model",
      },
    ];

    const cachedModels = settings.cachedAnthropicModels?.map((model) => ({
      id: model.key,
      displayName: model.displayName,
      description: model.description,
    }));

    if (!credential) {
      return cachedModels && cachedModels.length > 0
        ? cachedModels
        : defaultModels;
    }

    try {
      const isSubscriptionToken = credential.includes("sk-ant-oat");
      const client = isSubscriptionToken
        ? new Anthropic({
            apiKey: null,
            authToken: credential,
            defaultHeaders: {
              "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
              "x-app": "cli",
            },
          })
        : new Anthropic({ apiKey: credential });

      const page = await client.models.list({ limit: 100 });
      const knownIds = new Map<string, { key: string; displayName: string }>();
      for (const [key, value] of Object.entries(MODELS)) {
        knownIds.set(normalizeAnthropicModelId(value.anthropic), {
          key,
          displayName: value.displayName,
        });
      }

      const models = page.data
        .filter((model) => model.id.startsWith("claude-"))
        .map((model) => {
          const normalizedId = normalizeAnthropicModelId(model.id);
          const known = knownIds.get(normalizedId);
          return {
            id: known?.key || normalizedId,
            displayName: known?.displayName || model.display_name || normalizedId,
            description: normalizedId,
          };
        });

      return models.length > 0 ? models : defaultModels;
    } catch (error: Any) {
      console.error("Failed to fetch Claude models:", error);
      return cachedModels && cachedModels.length > 0
        ? cachedModels
        : defaultModels;
    }
  }

  /**
   * Fetch available OpenRouter models from the API
   */
  static async getOpenRouterModels(
    apiKey?: string,
    baseUrl?: string,
  ): Promise<Array<{ id: string; name: string; context_length: number }>> {
    const settings = this.loadSettings();
    // Normalize empty strings to undefined
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.openrouter?.apiKey;
    const normalizedBaseUrl = baseUrl?.trim() || undefined;
    const resolvedBaseUrl = normalizedBaseUrl || settings.openrouter?.baseUrl;

    const defaultModels = [
      {
        id: "anthropic/claude-3.5-sonnet",
        name: "Claude 3.5 Sonnet",
        context_length: 200000,
      },
      {
        id: "anthropic/claude-3-opus",
        name: "Claude 3 Opus",
        context_length: 200000,
      },
      { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 },
      { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", context_length: 128000 },
      {
        id: "google/gemini-pro-1.5",
        name: "Gemini Pro 1.5",
        context_length: 1000000,
      },
      {
        id: "meta-llama/llama-3.1-405b-instruct",
        name: "Llama 3.1 405B",
        context_length: 131072,
      },
    ];

    if (!key) {
      // Return default models if no API key
      return defaultModels;
    }

    try {
      const provider = new OpenRouterProvider({
        type: "openrouter",
        model: "",
        openrouterApiKey: key,
        openrouterBaseUrl: resolvedBaseUrl,
      });
      return await provider.getAvailableModels();
    } catch (error: Any) {
      console.error("Failed to fetch OpenRouter models:", error);
      // Return default models on error instead of empty array
      return defaultModels;
    }
  }

  /**
   * Fetch available OpenAI models
   * For API key auth: uses the models.list API via OpenAI SDK
   * For OAuth auth: uses pi-ai SDK's model list for openai-codex provider
   */
  static async getOpenAIModels(
    apiKey?: string,
  ): Promise<Array<{ id: string; name: string; description: string }>> {
    const settings = this.loadSettings();
    // Normalize empty strings to undefined
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.openai?.apiKey;
    // Check for OAuth access token if no API key
    const accessToken = settings.openai?.accessToken;
    const refreshToken = settings.openai?.refreshToken;

    const defaultModels = [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        description: "Most capable model for complex tasks",
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        description: "Fast and affordable for most tasks",
      },
      {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
        description: "Previous generation flagship",
      },
      {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5 Turbo",
        description: "Fast and cost-effective",
      },
      { id: "o1", name: "o1", description: "Advanced reasoning model" },
      { id: "o1-mini", name: "o1 Mini", description: "Fast reasoning model" },
    ];

    // For OAuth users, use pi-ai SDK's model list directly
    if (accessToken && refreshToken && !key) {
      console.log("[OpenAI] Using OAuth - fetching models from pi-ai SDK...");
      try {
        const { getModels } = await loadPiAiModule();
        const piAiModels = getModels("openai-codex");
        const models = piAiModels.map((m) => ({
          id: m.id,
          name: m.name || this.formatOpenAIModelName(m.id),
          description: this.getOpenAIModelDescription(m.id),
        }));

        // Sort by priority (ChatGPT internal models)
        models.sort((a, b) => {
          const priority = (id: string) => {
            if (id.includes("5.1-codex-mini")) return 0;
            if (id.includes("5.1-codex-max")) return 1;
            if (id === "gpt-5.1") return 2;
            if (id.includes("5.3-codex")) return 3;
            if (id.includes("5.2-codex")) return 3;
            if (id === "gpt-5.2") return 4;
            return 5;
          };
          return priority(a.id) - priority(b.id);
        });

        console.log(`[OpenAI] Found ${models.length} models via pi-ai SDK`);
        return models;
      } catch (error) {
        console.error("[OpenAI] Failed to get models from pi-ai SDK:", error);
        // Return ChatGPT-specific defaults for OAuth users
        return [
          {
            id: "gpt-5.1-codex-mini",
            name: "GPT-5.1 Codex Mini",
            description: "Fast and efficient for most tasks",
          },
          {
            id: "gpt-5.1-codex-max",
            name: "GPT-5.1 Codex Max",
            description: "Maximum capability for complex tasks",
          },
          {
            id: "gpt-5.1",
            name: "GPT-5.1",
            description: "Balanced performance and capability",
          },
          {
            id: "gpt-5.2-codex",
            name: "GPT-5.2 Codex",
            description: "Advanced reasoning model",
          },
          {
            id: "gpt-5.3-codex",
            name: "GPT-5.3 Codex",
            description: "Advanced reasoning model",
          },
          {
            id: "gpt-5.2",
            name: "GPT-5.2",
            description: "Most advanced reasoning",
          },
        ];
      }
    }

    if (!key) {
      // Return default models if no authentication
      return defaultModels;
    }

    try {
      // For API key, use the OpenAI provider
      const provider = new OpenAIProvider({
        type: "openai",
        model: "",
        openaiApiKey: key,
      });
      return await provider.getAvailableModels();
    } catch (error: Any) {
      console.error("Failed to fetch OpenAI models:", error);
      // Return default models on error instead of empty array
      return defaultModels;
    }
  }

  /**
   * Fetch available Groq models from the API
   */
  static async getGroqModels(
    apiKey?: string,
    baseUrl?: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const settings = this.loadSettings();
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.groq?.apiKey;
    const normalizedBaseUrl = baseUrl?.trim() || undefined;
    const resolvedBaseUrl = normalizedBaseUrl || settings.groq?.baseUrl;

    const defaultModels = [
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant" },
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile" },
    ];

    if (!key) {
      return defaultModels;
    }

    try {
      const provider = new GroqProvider({
        type: "groq",
        model: "",
        groqApiKey: key,
        groqBaseUrl: resolvedBaseUrl,
      });
      return await provider.getAvailableModels();
    } catch (error: Any) {
      console.error("Failed to fetch Groq models:", error);
      return defaultModels;
    }
  }

  /**
   * Fetch available xAI models from the API
   */
  static async getXAIModels(
    apiKey?: string,
    baseUrl?: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const settings = this.loadSettings();
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.xai?.apiKey;
    const normalizedBaseUrl = baseUrl?.trim() || undefined;
    const resolvedBaseUrl = normalizedBaseUrl || settings.xai?.baseUrl;

    const defaultModels = [
      { id: "grok-4", name: "Grok 4" },
      { id: "grok-4-fast-non-reasoning", name: "Grok 4 Fast (Non-Reasoning)" },
      { id: "grok-4-fast-reasoning", name: "Grok 4 Fast (Reasoning)" },
    ];

    if (!key) {
      return defaultModels;
    }

    try {
      const provider = new XAIProvider({
        type: "xai",
        model: "",
        xaiApiKey: key,
        xaiBaseUrl: resolvedBaseUrl,
      });
      return await provider.getAvailableModels();
    } catch (error: Any) {
      console.error("Failed to fetch xAI models:", error);
      return defaultModels;
    }
  }

  /**
   * Fetch available Kimi models from the API
   */
  static async getKimiModels(
    apiKey?: string,
    baseUrl?: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const settings = this.loadSettings();
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.kimi?.apiKey;
    const normalizedBaseUrl = baseUrl?.trim() || undefined;
    const resolvedBaseUrl = normalizedBaseUrl || settings.kimi?.baseUrl;

    const defaultModels = [
      { id: "kimi-k2.5", name: "Kimi K2.5" },
      { id: "kimi-k2-0905-preview", name: "Kimi K2.5 Preview" },
      { id: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo (Preview)" },
      { id: "kimi-k2-thinking", name: "Kimi K2 Thinking" },
      { id: "kimi-k2-thinking-turbo", name: "Kimi K2 Thinking Turbo" },
    ];

    if (!key) {
      return defaultModels;
    }

    try {
      const provider = new KimiProvider({
        type: "kimi",
        model: "",
        kimiApiKey: key,
        kimiBaseUrl: resolvedBaseUrl,
      });
      return await provider.getAvailableModels();
    } catch (error: Any) {
      console.error("Failed to fetch Kimi models:", error);
      return defaultModels;
    }
  }

  /**
   * Fetch available Pi models for a given Pi backend provider
   */
  static async getPiModels(
    piProvider?: string,
  ): Promise<Array<{ id: string; name: string; description: string }>> {
    return await PiProvider.getAvailableModels(piProvider);
  }

  /**
   * Get available Pi backend providers
   */
  static async getPiProviders(): Promise<Array<{ id: string; name: string }>> {
    return await PiProvider.getAvailableProviders();
  }

  /**
   * Format OpenAI model ID to display name
   */
  private static formatOpenAIModelName(modelId: string): string {
    // Public API models
    if (modelId === "gpt-4o") return "GPT-4o";
    if (modelId === "gpt-4o-mini") return "GPT-4o Mini";
    if (modelId.includes("gpt-4o-"))
      return `GPT-4o (${modelId.replace("gpt-4o-", "")})`;
    if (modelId === "gpt-4-turbo") return "GPT-4 Turbo";
    if (modelId === "gpt-4") return "GPT-4";
    if (modelId === "gpt-3.5-turbo") return "GPT-3.5 Turbo";
    if (modelId === "o1") return "o1";
    if (modelId === "o1-mini") return "o1 Mini";
    if (modelId === "o1-preview") return "o1 Preview";
    if (modelId === "o3-mini") return "o3 Mini";
    // ChatGPT internal models
    if (modelId === "gpt-5.1") return "GPT-5.1";
    if (modelId === "gpt-5.1-codex-mini") return "GPT-5.1 Codex Mini";
    if (modelId === "gpt-5.1-codex-max") return "GPT-5.1 Codex Max";
    if (modelId === "gpt-5.2") return "GPT-5.2";
    if (modelId === "gpt-5.2-codex") return "GPT-5.2 Codex";
    if (modelId === "gpt-5.3-codex") return "GPT-5.3 Codex";
    return modelId;
  }

  /**
   * Get OpenAI model description
   */
  private static getOpenAIModelDescription(modelId: string): string {
    // Public API models
    if (modelId.includes("gpt-4o") && !modelId.includes("mini"))
      return "Most capable model for complex tasks";
    if (modelId.includes("gpt-4o-mini"))
      return "Fast and affordable for most tasks";
    if (modelId.includes("gpt-4-turbo")) return "Previous generation flagship";
    if (modelId.includes("gpt-4")) return "High capability model";
    if (modelId.includes("gpt-3.5")) return "Fast and cost-effective";
    if (modelId === "o1" || modelId === "o1-preview")
      return "Advanced reasoning model";
    if (modelId === "o1-mini") return "Fast reasoning model";
    if (modelId.includes("o3")) return "Next generation reasoning";
    // ChatGPT internal models
    if (modelId === "gpt-5.1") return "Balanced performance and capability";
    if (modelId === "gpt-5.1-codex-mini")
      return "Fast and efficient for most tasks";
    if (modelId === "gpt-5.1-codex-max")
      return "Maximum capability for complex tasks";
    if (modelId === "gpt-5.2") return "Most advanced reasoning";
    if (modelId === "gpt-5.2-codex") return "Advanced reasoning model";
    if (modelId === "gpt-5.3-codex") return "Advanced reasoning model";
    return "OpenAI model";
  }

  /**
   * Save cached models for a provider
   */
  static saveCachedModels(
    providerType:
      | "anthropic"
      | "gemini"
      | "openrouter"
      | "ollama"
      | "bedrock"
      | "openai"
      | "groq"
      | "xai"
      | "kimi"
      | "pi"
      | "openai-compatible",
    models: CachedModelInfo[],
  ): void {
    const settings = this.loadSettings();

    switch (providerType) {
      case "anthropic":
        settings.cachedAnthropicModels = models;
        break;
      case "gemini":
        settings.cachedGeminiModels = models;
        break;
      case "openrouter":
        settings.cachedOpenRouterModels = models;
        break;
      case "ollama":
        settings.cachedOllamaModels = models;
        break;
      case "bedrock":
        settings.cachedBedrockModels = models;
        break;
      case "openai":
        settings.cachedOpenAIModels = models;
        break;
      case "groq":
        settings.cachedGroqModels = models;
        break;
      case "xai":
        settings.cachedXaiModels = models;
        break;
      case "kimi":
        settings.cachedKimiModels = models;
        break;
      case "pi":
        settings.cachedPiModels = models;
        break;
      case "openai-compatible":
        settings.cachedOpenAICompatibleModels = models;
        break;
    }

    this.saveSettings(settings);
  }

  /**
   * Get cached models for a provider
   */
  static getCachedModels(
    providerType:
      | "anthropic"
      | "gemini"
      | "openrouter"
      | "ollama"
      | "bedrock"
      | "openai"
      | "groq"
      | "xai"
      | "kimi"
      | "pi"
      | "openai-compatible",
  ): CachedModelInfo[] | undefined {
    const settings = this.loadSettings();

    switch (providerType) {
      case "anthropic":
        return settings.cachedAnthropicModels;
      case "gemini":
        return settings.cachedGeminiModels;
      case "openrouter":
        return settings.cachedOpenRouterModels;
      case "ollama":
        return settings.cachedOllamaModels;
      case "bedrock":
        return settings.cachedBedrockModels;
      case "openai":
        return settings.cachedOpenAIModels;
      case "groq":
        return settings.cachedGroqModels;
      case "xai":
        return settings.cachedXaiModels;
      case "kimi":
        return settings.cachedKimiModels;
      case "pi":
        return settings.cachedPiModels;
      case "openai-compatible":
        return settings.cachedOpenAICompatibleModels;
      default:
        return undefined;
    }
  }

  /**
   * Fetch available models from an OpenAI-compatible endpoint
   */
  static async getOpenAICompatibleModels(
    baseUrl: string,
    apiKey?: string,
  ): Promise<CachedModelInfo[]> {
    const provider = new OpenAICompatibleProvider({
      type: "openai-compatible",
      providerName: "OpenAI-Compatible",
      apiKey: apiKey || "",
      baseUrl,
      defaultModel: "",
    });

    const models = await provider.getAvailableModels();
    const cachedModels = models.map((m) => ({
      key: m.id,
      displayName: m.name || m.id,
      description: "OpenAI-compatible model",
    }));

    this.saveCachedModels("openai-compatible", cachedModels);
    return cachedModels;
  }

  static async getCustomProviderModels(
    providerType: LLMProviderType,
    overrides?: {
      apiKey?: string;
      baseUrl?: string;
    },
  ): Promise<CachedModelInfo[]> {
    const resolvedProviderType = resolveCustomProviderId(providerType);
    const entry = getCustomProviderEntry(resolvedProviderType);
    if (!entry) {
      return [];
    }

    const settings = this.loadSettings();
    const existingConfig =
      getCustomProviderConfig(settings.customProviders, resolvedProviderType) ||
      {};
    const apiKey = overrides?.apiKey?.trim() || existingConfig.apiKey || "";
    const baseUrl =
      overrides?.baseUrl?.trim() ||
      existingConfig.baseUrl ||
      entry.baseUrl ||
      "";
    const documentedModels = getKnownCustomProviderModels(entry);
    const selectedModel = existingConfig.model?.trim();
    const defaultModel = entry.defaultModel?.trim();
    const fallbackCachedModels = mergeCustomProviderModels(
      entry,
      selectedModel
        ? [
            {
              key: selectedModel,
              displayName: selectedModel,
              description: entry.description || `${entry.name} model`,
            },
          ]
        : undefined,
      documentedModels,
      defaultModel
        ? [
            {
              key: defaultModel,
              displayName: defaultModel,
              description: entry.description || `${entry.name} model`,
            },
          ]
        : undefined,
    );

    // MiniMax documents its supported model IDs, but the Anthropic-compatible
    // endpoint does not expose a usable public /models listing endpoint.
    if (
      documentedModels.length > 0 &&
      (resolvedProviderType === "minimax" ||
        resolvedProviderType === "minimax-portal")
    ) {
      const updatedSettings = this.loadSettings();
      updatedSettings.customProviders = {
        ...updatedSettings.customProviders,
        [resolvedProviderType]: {
          ...updatedSettings.customProviders?.[resolvedProviderType],
          cachedModels: fallbackCachedModels,
        },
      };
      this.saveSettings(updatedSettings);
      return fallbackCachedModels;
    }

    if (!baseUrl) {
      return mergeCustomProviderModels(
        entry,
        existingConfig.cachedModels,
        fallbackCachedModels,
      );
    }

    const provider =
      entry.compatibility === "anthropic"
        ? new AnthropicCompatibleProvider({
            type: resolvedProviderType,
            providerName: entry.name,
            apiKey,
            baseUrl,
            defaultModel: entry.defaultModel,
          })
        : new OpenAICompatibleProvider({
            type: resolvedProviderType,
            providerName: entry.name,
            apiKey,
            baseUrl,
            defaultModel: entry.defaultModel,
          });

    const models = await provider.getAvailableModels();
    const cachedModels = mergeCustomProviderModels(
      entry,
      models.map((model) => ({
        key: model.id,
        displayName: model.name || model.id,
        description: entry.description || `${entry.name} model`,
      })),
      fallbackCachedModels,
    );

    if (cachedModels.length > 0) {
      const updatedSettings = this.loadSettings();
      updatedSettings.customProviders = {
        ...updatedSettings.customProviders,
        [resolvedProviderType]: {
          ...updatedSettings.customProviders?.[resolvedProviderType],
          cachedModels,
        },
      };
      this.saveSettings(updatedSettings);
      return cachedModels;
    }

    if (fallbackCachedModels.length > 0) {
      const updatedSettings = this.loadSettings();
      updatedSettings.customProviders = {
        ...updatedSettings.customProviders,
        [resolvedProviderType]: {
          ...updatedSettings.customProviders?.[resolvedProviderType],
          cachedModels: fallbackCachedModels,
        },
      };
      this.saveSettings(updatedSettings);
      return fallbackCachedModels;
    }

    return mergeCustomProviderModels(
      entry,
      existingConfig.cachedModels,
      fallbackCachedModels,
    );
  }
}
