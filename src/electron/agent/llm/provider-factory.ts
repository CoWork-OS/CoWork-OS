import * as fs from 'fs';
import * as path from 'path';
import { getModels as getPiAiModels } from '@mariozechner/pi-ai';
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
} from './types';
import { AnthropicProvider } from './anthropic-provider';
import { BedrockProvider } from './bedrock-provider';
import { OllamaProvider } from './ollama-provider';
import { GeminiProvider } from './gemini-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { OpenAIProvider } from './openai-provider';
import { AzureOpenAIProvider } from './azure-openai-provider';
import { GroqProvider } from './groq-provider';
import { XAIProvider } from './xai-provider';
import { KimiProvider } from './kimi-provider';
import { PiProvider } from './pi-provider';
import { AnthropicCompatibleProvider } from './anthropic-compatible-provider';
import { OpenAICompatibleProvider } from './openai-compatible-provider';
import { GitHubCopilotProvider } from './github-copilot-provider';
import { SecureSettingsRepository } from '../../database/SecureSettingsRepository';
import {
  CUSTOM_PROVIDER_CATALOG,
  CUSTOM_PROVIDER_MAP,
  CUSTOM_PROVIDER_IDS,
  type ProviderCatalogEntry,
} from '../../../shared/llm-provider-catalog';
import type { CustomProviderConfig } from '../../../shared/types';
import { getUserDataDir } from '../../utils/user-data-dir';
import { getSafeStorage } from '../../utils/safe-storage';

const LEGACY_SETTINGS_FILE = 'llm-settings.json';
const MASKED_VALUE = '***configured***';
const ENCRYPTED_PREFIX = 'encrypted:';
let llmCallLogCounter = 0;
const observedModelMaxTokens = new Map<string, number>();
const CUSTOM_PROVIDER_ALIASES: Partial<Record<LLMProviderType, LLMProviderType>> = {
  'kimi-coding': 'kimi-code',
};

function safeContentLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
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
    if (message?.role === 'user') userMessages++;
    else if (message?.role === 'assistant') assistantMessages++;

    const content: any = (message as any)?.content;
    if (typeof content === 'string') {
      textBlocks++;
      textChars += content.length;
      continue;
    }

    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type = (block as any).type;
      if (type === 'text') {
        const text = (block as any).text;
        if (typeof text === 'string') {
          textBlocks++;
          textChars += text.length;
        }
      } else if (type === 'tool_use') {
        toolUseBlocks++;
      } else if (type === 'tool_result') {
        toolResultBlocks++;
        toolResultChars += safeContentLength((block as any).content);
        if ((block as any).is_error) toolResultErrors++;
      }
    }
  }

  return {
    model: request.model,
    maxTokens: request.maxTokens,
    toolsOffered: request.tools?.length || 0,
    messages: messages.length,
    userMessages,
    assistantMessages,
    textBlocks,
    textChars,
    toolUseBlocks,
    toolResultBlocks,
    toolResultChars,
    toolResultErrors,
    systemChars: typeof request.system === 'string' ? request.system.length : 0,
    signalAborted: request.signal?.aborted === true,
  };
}

function summarizeLLMResponse(response: LLMResponse): Record<string, unknown> {
  const content = Array.isArray(response?.content) ? response.content : [];
  let textBlocks = 0;
  let textChars = 0;
  let toolUseBlocks = 0;

  for (const block of content as any[]) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textBlocks++;
      textChars += block.text.length;
    } else if (block.type === 'tool_use') {
      toolUseBlocks++;
    }
  }

  const inputTokens = response?.usage?.inputTokens ?? null;
  const outputTokens = response?.usage?.outputTokens ?? null;
  const totalTokens = inputTokens != null && outputTokens != null
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

function parseMaxTokensLimitFromError(error: any): number | null {
  const message = String(error?.message || '');
  if (!message) return null;

  const patterns = [
    /model limit of\s+(\d+)/i,
    /lower than\s+(\d+)/i,
    /max(?:imum)?\s+tokens(?:\s+value)?\s+(?:that is\s+)?lower than\s+(\d+)/i,
    /maximum tokens[^0-9]*(\d+)/i,
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

function clampRequestToObservedModelLimit(request: LLMRequest): { request: LLMRequest; adjusted: boolean; observedLimit: number | null } {
  const model = typeof request.model === 'string' ? request.model : '';
  if (!model) return { request, adjusted: false, observedLimit: null };

  const observedLimit = observedModelMaxTokens.get(model) ?? null;
  if (!observedLimit || !Number.isFinite(request.maxTokens) || request.maxTokens <= 0) {
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
  const alreadyWrapped = (provider as any).__detailedLLMLoggingWrapped === true;
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
      const isSideCall = !effectiveRequest.tools?.length &&
        effectiveRequest.maxTokens <= 200 &&
        (typeof effectiveRequest.system === 'string' ? effectiveRequest.system.length : 0) < 120;
      const tag = isSideCall ? ' [side]' : '';
      console.log(`[LLM:${provider.type}] #${callId}${tag} start`, summarizeLLMRequest(effectiveRequest));
      if (preflight.adjusted) {
        console.log(
          `[LLM:${provider.type}] #${callId} using observed model token limit`,
          {
            model: effectiveRequest.model,
            observedLimit: preflight.observedLimit,
            requestedMaxTokens: request.maxTokens,
            adjustedMaxTokens: effectiveRequest.maxTokens,
          }
        );
      }

      try {
        const response = await provider.createMessage(effectiveRequest);
        console.log(
          `[LLM:${provider.type}] #${callId}${tag} success in ${Date.now() - startedAt}ms`,
          summarizeLLMResponse(response)
        );
        return response;
      } catch (error: any) {
        const parsedLimit = parseMaxTokensLimitFromError(error);
        if (
          parsedLimit &&
          Number.isFinite(effectiveRequest.maxTokens) &&
          effectiveRequest.maxTokens >= parsedLimit
        ) {
          const model = typeof effectiveRequest.model === 'string' ? effectiveRequest.model : '';
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
              }
            );
            const retriedRequest: LLMRequest = { ...effectiveRequest, maxTokens: retryMaxTokens };
            try {
              const response = await provider.createMessage(retriedRequest);
              console.log(
                `[LLM:${provider.type}] #${callId}${tag} success in ${Date.now() - startedAt}ms`,
                {
                  ...summarizeLLMResponse(response),
                  retriedWithMaxTokens: retryMaxTokens,
                  learnedModelLimit: parsedLimit,
                }
              );
              return response;
            } catch (retryError: any) {
              error = retryError;
            }
          }
        }

        const message = String(error?.message || '');
        const lower = message.toLowerCase();
        const cancelled = error?.name === 'AbortError' || lower.includes('aborted') || lower.includes('cancel');
        console.error(`[LLM:${provider.type}] #${callId}${tag} ${cancelled ? 'cancelled' : 'error'} in ${Date.now() - startedAt}ms`, {
          name: error?.name,
          message,
          status: error?.status || error?.$metadata?.httpStatusCode,
          requestId: error?.$metadata?.requestId,
        });
        throw error;
      }
    },
    async testConnection(): Promise<{ success: boolean; error?: string }> {
      return provider.testConnection();
    },
  };

  (wrapped as any).__detailedLLMLoggingWrapped = true;
  return wrapped;
}

function resolveCustomProviderId(providerType: LLMProviderType): LLMProviderType {
  return CUSTOM_PROVIDER_ALIASES[providerType] || providerType;
}

function getCustomProviderEntry(providerType: LLMProviderType): ProviderCatalogEntry | undefined {
  return CUSTOM_PROVIDER_MAP.get(resolveCustomProviderId(providerType));
}

function getCustomProviderConfig(
  customProviders: Record<string, CustomProviderConfig> | undefined,
  providerType: LLMProviderType
): CustomProviderConfig | undefined {
  if (!customProviders) return undefined;
  const resolved = resolveCustomProviderId(providerType);
  const resolvedConfig = customProviders[resolved];
  if (resolvedConfig) {
    return resolvedConfig;
  }
  const fallbackConfig = customProviders[providerType];
  if (fallbackConfig && resolved !== providerType) {
    console.log(`[LLMProviderFactory] Custom provider config not found for "${resolved}", falling back to "${providerType}".`);
  }
  return fallbackConfig;
}

function isCustomProviderConfigured(
  entry: ProviderCatalogEntry,
  config?: CustomProviderConfig
): boolean {
  if (!config) return false;
  const hasApiKey = !!config.apiKey?.trim();
  const hasBaseUrl = !!config.baseUrl?.trim() || !!entry.baseUrl;
  const hasUserConfig = hasApiKey || !!config.baseUrl?.trim() || !!config.model?.trim();

  if (!hasUserConfig) return false;

  if (entry.apiKeyOptional) {
    return entry.requiresBaseUrl ? hasBaseUrl : hasApiKey || hasBaseUrl;
  }

  return entry.requiresBaseUrl ? hasApiKey && hasBaseUrl : hasApiKey;
}

function createCustomProvider(
  config: LLMProviderConfig,
  entry: ProviderCatalogEntry,
  resolvedType: LLMProviderType
): LLMProvider {
  if (resolvedType === 'github-copilot') {
    return new GitHubCopilotProvider(config);
  }

  const apiKey = config.providerApiKey || '';
  const baseUrl = config.providerBaseUrl || entry.baseUrl || '';

  if (entry.requiresBaseUrl && !baseUrl) {
    throw new Error(`${entry.name} base URL is required. Configure it in Settings.`);
  }

  if (!apiKey && !entry.apiKeyOptional) {
    throw new Error(`${entry.name} API key is required. Configure it in Settings.`);
  }

  const model = config.model || entry.defaultModel;
  if (!model) {
    throw new Error(`${entry.name} model is required. Configure it in Settings.`);
  }

  if (entry.compatibility === 'openai') {
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
function encryptSecret(value?: string): string | undefined {
  if (!value || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed === MASKED_VALUE) return undefined;

  try {
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(trimmed);
      return ENCRYPTED_PREFIX + encrypted.toString('base64');
    }
  } catch (error) {
    console.warn('Failed to encrypt secret, storing masked:', error);
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
        const encrypted = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
        const decrypted = safeStorage!.decryptString(encrypted);
        return decrypted;
      } else {
        console.error('[LLM Settings] safeStorage encryption not available - cannot decrypt secrets');
        console.error('[LLM Settings] You may need to re-enter your API credentials in Settings');
      }
    } catch (error: any) {
      // This can happen after app updates when the code signature changes
      // The macOS Keychain ties encryption to the app's signature
      console.error('[LLM Settings] Failed to decrypt secret - this can happen after app updates');
      console.error('[LLM Settings] Error:', error.message || error);
      console.error('[LLM Settings] Please re-enter your API credentials in Settings');
    }
  }

  // If not encrypted and not masked, return as-is (for backwards compatibility)
  if (value !== MASKED_VALUE && !value.startsWith(ENCRYPTED_PREFIX)) {
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
  if (!trimmed || trimmed === MASKED_VALUE || trimmed.startsWith(ENCRYPTED_PREFIX)) return undefined;
  return trimmed;
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
    if (sanitized.openai.authMethod === 'oauth') {
      console.log('[LLM Settings] Loading OpenAI OAuth settings:');
      console.log('[LLM Settings]   authMethod:', sanitized.openai.authMethod);
      console.log('[LLM Settings]   hasAccessToken:', !!sanitized.openai.accessToken);
      console.log('[LLM Settings]   decryptedAccessToken:', !!decryptedAccessToken);
      console.log('[LLM Settings]   hasRefreshToken:', !!sanitized.openai.refreshToken);
      console.log('[LLM Settings]   decryptedRefreshToken:', !!decryptedRefreshToken);
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
  contextLength?: number;  // For OpenRouter models
  size?: number;           // For Ollama models (in bytes)
}

/**
 * Stored settings for LLM provider
 */
export interface LLMSettings {
  providerType: LLMProviderType;
  modelKey: ModelKey | string; // String for custom Ollama model names
  anthropic?: {
    apiKey?: string;
  };
  bedrock?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    profile?: string;
    useDefaultCredentials?: boolean;
    model?: string;
  };
  ollama?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string; // Optional, for remote Ollama servers
  };
  gemini?: {
    apiKey?: string;
    model?: string;
  };
  openrouter?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  openai?: {
    apiKey?: string;
    model?: string;
    // OAuth tokens (alternative to API key)
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    authMethod?: 'api_key' | 'oauth';
  };
  azure?: {
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    deployments?: string[];
    apiVersion?: string;
  };
  groq?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  xai?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  kimi?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  pi?: {
    provider?: string;  // pi-ai KnownProvider
    apiKey?: string;
    model?: string;
  };
  customProviders?: Record<string, CustomProviderConfig>;
  // Cached models from API (populated when user refreshes)
  cachedGeminiModels?: CachedModelInfo[];
  cachedOpenRouterModels?: CachedModelInfo[];
  cachedOllamaModels?: CachedModelInfo[];
  cachedBedrockModels?: CachedModelInfo[];
  cachedOpenAIModels?: CachedModelInfo[];
  cachedGroqModels?: CachedModelInfo[];
  cachedXaiModels?: CachedModelInfo[];
  cachedKimiModels?: CachedModelInfo[];
  cachedPiModels?: CachedModelInfo[];
}

const DEFAULT_SETTINGS: LLMSettings = {
  providerType: 'anthropic',
  modelKey: DEFAULT_MODEL,
};

/**
 * Factory for creating LLM providers
 */
export class LLMProviderFactory {
  private static legacySettingsPath: string;
  private static cachedSettings: LLMSettings | null = null;
  private static migrationCompleted = false;

  private static normalizeCustomProviders(settings: LLMSettings): void {
    if (!settings.customProviders) return;

    const legacyKey = settings.customProviders['kimi-coding'];
    if (legacyKey && !settings.customProviders['kimi-code']) {
      settings.customProviders['kimi-code'] = legacyKey;
    }
    if (settings.customProviders['kimi-coding']) {
      delete settings.customProviders['kimi-coding'];
    }

    if (settings.providerType === 'kimi-coding') {
      settings.providerType = 'kimi-code';
    }
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
        console.log('[LLMProviderFactory] SecureSettingsRepository not yet initialized, skipping migration');
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      // Check if already migrated to database
      if (repository.exists('llm')) {
        this.migrationCompleted = true;
        return;
      }

      // Check if legacy file exists
      if (!fs.existsSync(this.legacySettingsPath)) {
        console.log('[LLMProviderFactory] No legacy settings file found');
        this.migrationCompleted = true;
        return;
      }

      console.log('[LLMProviderFactory] Migrating settings from legacy JSON file to encrypted database...');

      // Create backup before migration
      const backupPath = this.legacySettingsPath + '.migration-backup';
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        // Read and decrypt legacy settings
        const data = fs.readFileSync(this.legacySettingsPath, 'utf-8');
        const legacySettings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
        const decryptedSettings = sanitizeSettings(legacySettings);

        // Save to encrypted database
        repository.save('llm', decryptedSettings);
        console.log('[LLMProviderFactory] Settings migrated to encrypted database');

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log('[LLMProviderFactory] Migration complete, cleaned up legacy files');

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error('[LLMProviderFactory] Migration failed, backup preserved at:', backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error('[LLMProviderFactory] Migration failed:', error);
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
        const stored = repository.load<LLMSettings>('llm');
        if (stored) {
          settings = { ...DEFAULT_SETTINGS, ...stored };
          this.normalizeCustomProviders(settings);
          settingsExist = true;
        }
      }
    } catch (error) {
      console.error('[LLMProviderFactory] Failed to load settings from database:', error);
    }

    // Auto-detect provider if no settings exist
    if (!settingsExist) {
      const detectedProvider = this.detectProviderFromSettings(settings);
      if (detectedProvider) {
        settings.providerType = detectedProvider;
        console.log(`[LLMProviderFactory] Auto-detected LLM provider: ${detectedProvider}`);
      }
    }

    this.cachedSettings = settings;
    return settings;
  }

  /**
   * Detect which provider to use based on saved settings
   * Note: Environment variables are no longer used for security reasons.
   * All configuration should be done through the Settings UI.
   */
  private static detectProviderFromSettings(settings: LLMSettings): LLMProviderType | null {
    // Check if any provider has credentials configured in settings
    if (settings.anthropic?.apiKey) {
      return 'anthropic';
    }
    if (settings.gemini?.apiKey) {
      return 'gemini';
    }
    if (settings.openrouter?.apiKey) {
      return 'openrouter';
    }
    if (settings.openai?.apiKey || settings.openai?.accessToken) {
      return 'openai';
    }
    const azureDeployment = settings.azure?.deployment || settings.azure?.deployments?.[0];
    if (settings.azure?.apiKey && settings.azure?.endpoint && azureDeployment) {
      return 'azure';
    }
    if (settings.groq?.apiKey) {
      return 'groq';
    }
    if (settings.xai?.apiKey) {
      return 'xai';
    }
    if (settings.kimi?.apiKey) {
      return 'kimi';
    }
    if (settings.bedrock?.accessKeyId || settings.bedrock?.profile) {
      return 'bedrock';
    }
    if (settings.ollama?.baseUrl || settings.ollama?.model) {
      return 'ollama';
    }
    if (settings.pi?.apiKey && settings.pi?.provider) {
      return 'pi';
    }

    if (settings.customProviders) {
      for (const entry of CUSTOM_PROVIDER_CATALOG) {
        const config = getCustomProviderConfig(settings.customProviders, entry.id);
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
        throw new Error('SecureSettingsRepository not initialized');
      }

      const repository = SecureSettingsRepository.getInstance();

      // Save entire settings object to encrypted database
      // No need for per-field encryption - the entire object is encrypted
      repository.save('llm', settings);
      this.cachedSettings = settings;

      console.log('[LLMProviderFactory] Settings saved to encrypted database');
    } catch (error) {
      console.error('[LLMProviderFactory] Failed to save settings:', error);
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
  static createProvider(overrideConfig?: Partial<LLMProviderConfig>): LLMProvider {
    const settings = this.loadSettings();
    const providerType = overrideConfig?.type || settings.providerType;
    const customConfig = getCustomProviderConfig(settings.customProviders, providerType);
    const azureDeployment = overrideConfig?.azureDeployment
      || settings.azure?.deployment
      || settings.azure?.deployments?.[0];

    const config: LLMProviderConfig = {
      type: providerType,
      model: this.getModelId(
        settings.modelKey,
        providerType,
        settings.ollama?.model,
        settings.gemini?.model,
        settings.openrouter?.model,
        settings.openai?.model,
        azureDeployment,
        settings.groq?.model,
        settings.xai?.model,
        settings.kimi?.model,
        settings.customProviders,
        settings.bedrock?.model
      ),
      // Anthropic config - from settings only
      anthropicApiKey: normalizeSecret(overrideConfig?.anthropicApiKey) || settings.anthropic?.apiKey,
      // Bedrock config - from settings only
      awsRegion: overrideConfig?.awsRegion || settings.bedrock?.region || 'us-east-1',
      awsAccessKeyId: overrideConfig?.awsAccessKeyId || settings.bedrock?.accessKeyId,
      awsSecretAccessKey: normalizeSecret(overrideConfig?.awsSecretAccessKey) || settings.bedrock?.secretAccessKey,
      awsSessionToken: overrideConfig?.awsSessionToken || settings.bedrock?.sessionToken,
      awsProfile: overrideConfig?.awsProfile || settings.bedrock?.profile,
      // Ollama config - from settings only
      ollamaBaseUrl: overrideConfig?.ollamaBaseUrl || settings.ollama?.baseUrl || 'http://localhost:11434',
      ollamaApiKey: normalizeSecret(overrideConfig?.ollamaApiKey) || settings.ollama?.apiKey,
      // Gemini config - from settings only
      geminiApiKey: normalizeSecret(overrideConfig?.geminiApiKey) || settings.gemini?.apiKey,
      // OpenRouter config - from settings only
      openrouterApiKey: normalizeSecret(overrideConfig?.openrouterApiKey) || settings.openrouter?.apiKey,
      openrouterBaseUrl: overrideConfig?.openrouterBaseUrl || settings.openrouter?.baseUrl,
      // OpenAI config - from settings only
      openaiApiKey: normalizeSecret(overrideConfig?.openaiApiKey) || settings.openai?.apiKey,
      openaiAccessToken: normalizeSecret(overrideConfig?.openaiAccessToken) || settings.openai?.accessToken,
      openaiRefreshToken: settings.openai?.refreshToken,
      openaiTokenExpiresAt: settings.openai?.tokenExpiresAt,
      // Azure OpenAI config - from settings only
      azureApiKey: normalizeSecret(overrideConfig?.azureApiKey) || settings.azure?.apiKey,
      azureEndpoint: overrideConfig?.azureEndpoint || settings.azure?.endpoint,
      azureDeployment,
      azureApiVersion: overrideConfig?.azureApiVersion || settings.azure?.apiVersion,
      // Groq config - from settings only
      groqApiKey: normalizeSecret(overrideConfig?.groqApiKey) || settings.groq?.apiKey,
      groqBaseUrl: overrideConfig?.groqBaseUrl || settings.groq?.baseUrl,
      // xAI config - from settings only
      xaiApiKey: normalizeSecret(overrideConfig?.xaiApiKey) || settings.xai?.apiKey,
      xaiBaseUrl: overrideConfig?.xaiBaseUrl || settings.xai?.baseUrl,
      // Kimi config - from settings only
      kimiApiKey: normalizeSecret(overrideConfig?.kimiApiKey) || settings.kimi?.apiKey,
      kimiBaseUrl: overrideConfig?.kimiBaseUrl || settings.kimi?.baseUrl,
      // Pi config - from settings only
      piProvider: overrideConfig?.piProvider || settings.pi?.provider,
      piApiKey: normalizeSecret(overrideConfig?.piApiKey) || settings.pi?.apiKey,
      // Custom provider config
      providerApiKey: normalizeSecret(overrideConfig?.providerApiKey) || customConfig?.apiKey,
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
      return wrapProviderWithDetailedLogging(createCustomProvider(config, customEntry, resolvedType));
    }

    let provider: LLMProvider;
    switch (config.type) {
      case 'anthropic':
        provider = new AnthropicProvider(config);
        break;
      case 'bedrock':
        provider = new BedrockProvider(config);
        break;
      case 'ollama':
        provider = new OllamaProvider(config);
        break;
      case 'gemini':
        provider = new GeminiProvider(config);
        break;
      case 'openrouter':
        provider = new OpenRouterProvider(config);
        break;
      case 'openai':
        provider = new OpenAIProvider(config);
        break;
      case 'azure':
        provider = new AzureOpenAIProvider(config);
        break;
      case 'groq':
        provider = new GroqProvider(config);
        break;
      case 'xai':
        provider = new XAIProvider(config);
        break;
      case 'kimi':
        provider = new KimiProvider(config);
        break;
      case 'pi':
        provider = new PiProvider(config);
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
    groqModel?: string,
    xaiModel?: string,
    kimiModel?: string,
    customProviders?: Record<string, CustomProviderConfig>,
    bedrockModel?: string
  ): string {
    const customEntry = getCustomProviderEntry(providerType);
    if (customEntry) {
      const customConfig = getCustomProviderConfig(customProviders, providerType);
      return customConfig?.model || customEntry.defaultModel;
    }

    // For Ollama, use the specific Ollama model if provided
    if (providerType === 'ollama') {
      return ollamaModel || 'gpt-oss:20b';
    }

    // For Gemini, use the specific Gemini model if provided or default
    if (providerType === 'gemini') {
      return geminiModel || 'gemini-2.0-flash';
    }

    // For OpenRouter, use the specific model if provided or default
    if (providerType === 'openrouter') {
      return openrouterModel || 'anthropic/claude-3.5-sonnet';
    }

    // For OpenAI, use the specific model if provided or default
    if (providerType === 'openai') {
      return openaiModel || 'gpt-4o-mini';
    }

    // For Azure OpenAI, use the deployment name
    if (providerType === 'azure') {
      return azureDeployment || '';
    }

    // For Groq, use the specific model if provided or default
    if (providerType === 'groq') {
      return groqModel || 'llama-3.1-8b-instant';
    }

    // For xAI, use the specific model if provided or default
    if (providerType === 'xai') {
      return xaiModel || 'grok-4-fast-non-reasoning';
    }

    // For Kimi, use the specific model if provided or default
    if (providerType === 'kimi') {
      return kimiModel || 'kimi-k2.5';
    }

    // For Pi, use the specific model from settings
    if (providerType === 'pi') {
      const settings = this.loadSettings();
      return settings.pi?.model || DEFAULT_PI_MODEL;
    }

    // For Bedrock, prefer an explicit Bedrock model ID if configured.
    if (providerType === 'bedrock') {
      const configuredBedrockModel = bedrockModel?.trim();
      if (configuredBedrockModel) {
        return configuredBedrockModel;
      }

      if (typeof modelKey === 'string') {
        const trimmedModelKey = modelKey.trim();
        if (trimmedModelKey.startsWith('anthropic.') || trimmedModelKey.startsWith('us.')) {
          return trimmedModelKey;
        }
      }

      const mappedBedrockModel = MODELS[modelKey as ModelKey]?.bedrock;
      if (mappedBedrockModel) {
        return mappedBedrockModel;
      }

      if (typeof modelKey === 'string' && modelKey.trim().length > 0) {
        return modelKey.trim();
      }
    }

    // For other providers, look up in MODELS
    const model = MODELS[modelKey as ModelKey];
    if (!model) {
      throw new Error(`Unknown model: ${modelKey}`);
    }
    return model[providerType as 'anthropic' | 'bedrock'];
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
        type: 'anthropic' as LLMProviderType,
        name: 'Anthropic API',
        configured: !!settings.anthropic?.apiKey,
      },
      {
        type: 'gemini' as LLMProviderType,
        name: 'Google Gemini',
        configured: !!settings.gemini?.apiKey,
      },
      {
        type: 'openrouter' as LLMProviderType,
        name: 'OpenRouter',
        configured: !!settings.openrouter?.apiKey,
      },
      {
        type: 'openai' as LLMProviderType,
        name: 'OpenAI',
        configured: !!(settings.openai?.apiKey || settings.openai?.accessToken),
      },
      {
        type: 'azure' as LLMProviderType,
        name: 'Azure OpenAI',
        configured: !!(
          settings.azure?.apiKey
          && settings.azure?.endpoint
          && (settings.azure?.deployment || settings.azure?.deployments?.length)
        ),
      },
      {
        type: 'groq' as LLMProviderType,
        name: 'Groq',
        configured: !!settings.groq?.apiKey,
      },
      {
        type: 'xai' as LLMProviderType,
        name: 'xAI (Grok)',
        configured: !!settings.xai?.apiKey,
      },
      {
        type: 'kimi' as LLMProviderType,
        name: 'Kimi',
        configured: !!settings.kimi?.apiKey,
      },
      {
        type: 'bedrock' as LLMProviderType,
        name: 'AWS Bedrock',
        configured: !!(settings.bedrock?.accessKeyId || settings.bedrock?.profile),
      },
      {
        type: 'ollama' as LLMProviderType,
        name: 'Ollama (Local)',
        configured: !!(settings.ollama?.baseUrl || settings.ollama?.model),
      },
      {
        type: 'pi' as LLMProviderType,
        name: 'Pi (Unified)',
        configured: !!(settings.pi?.apiKey && settings.pi?.provider),
      },
    ];

    const customProviders = CUSTOM_PROVIDER_CATALOG.map((entry: ProviderCatalogEntry) => {
      const config = getCustomProviderConfig(settings.customProviders, entry.id);
      return {
        type: entry.id,
        name: entry.name,
        configured: isCustomProviderConfigured(entry, config),
      };
    });

    return [...builtIns, ...customProviders];
  }

  /**
   * Get current configuration status
   */
  static getConfigStatus(): {
    currentProvider: LLMProviderType;
    currentModel: string;
    providers: Array<{ type: LLMProviderType; name: string; configured: boolean }>;
    models: Array<{ key: string; displayName: string; description: string }>;
  } {
    const settings = this.loadSettings();
    const modelStatus = this.getProviderModelStatus(settings);
    return {
      currentProvider: settings.providerType,
      currentModel: modelStatus.currentModel,
      providers: this.getAvailableProviders(),
      models: modelStatus.models,
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
    const customEntry = CUSTOM_PROVIDER_MAP.get(resolvedProviderType as any);
    const ensureCurrentModel = (
      modelList: CachedModelInfo[],
      modelKey: string,
      description = 'Selected model'
    ) => {
      if (!modelKey || modelList.some((model) => model.key === modelKey)) {
        return modelList;
      }
      return [
        {
          key: modelKey,
          displayName: modelKey,
          description,
        },
        ...modelList,
      ];
    };

    if (customEntry) {
      const customConfig = settings.customProviders?.[resolvedProviderType] || settings.customProviders?.[settings.providerType];
      const currentModel = customConfig?.model || customEntry.defaultModel || '';
      return {
        currentModel,
        models: [
          {
            key: currentModel,
            displayName: currentModel,
            description: customEntry.description || `${customEntry.name} model`,
          },
        ],
      };
    }

    switch (settings.providerType) {
      case 'anthropic': {
        const currentModel = settings.modelKey;
        const modelList = Object.entries(MODELS).map(([key, value]) => ({
          key,
          displayName: value.displayName,
          description: key.includes('opus')
            ? 'Most capable for complex work'
            : key.includes('sonnet')
              ? 'Balanced performance and speed'
              : 'Fast and efficient',
        }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'bedrock': {
        const fallbackModel = MODELS[settings.modelKey as ModelKey]?.bedrock;
        const currentModel = settings.bedrock?.model || fallbackModel || settings.modelKey;
        const modelList = settings.cachedBedrockModels && settings.cachedBedrockModels.length > 0
          ? settings.cachedBedrockModels
          : Object.values(MODELS).map((value) => ({
            key: value.bedrock,
            displayName: value.displayName,
            description: value.displayName.toLowerCase().includes('opus')
              ? 'Most capable for complex work'
              : value.displayName.toLowerCase().includes('sonnet')
                ? 'Balanced performance and speed'
                : 'Fast and efficient',
          }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'gemini': {
        const currentModel = settings.gemini?.model || 'gemini-2.0-flash';
        const modelList = settings.cachedGeminiModels && settings.cachedGeminiModels.length > 0
          ? settings.cachedGeminiModels
          : Object.values(GEMINI_MODELS).map((value) => ({
            key: value.id,
            displayName: value.displayName,
            description: value.description,
          }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'openrouter': {
        const currentModel = settings.openrouter?.model || 'anthropic/claude-3.5-sonnet';
        const modelList = settings.cachedOpenRouterModels && settings.cachedOpenRouterModels.length > 0
          ? settings.cachedOpenRouterModels
          : Object.values(OPENROUTER_MODELS).map((value) => ({
            key: value.id,
            displayName: value.displayName,
            description: value.description,
          }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'openai': {
        const currentModel = settings.openai?.model || 'gpt-4o-mini';
        const modelList = settings.cachedOpenAIModels && settings.cachedOpenAIModels.length > 0
          ? settings.cachedOpenAIModels
          : [
            { key: 'gpt-4o', displayName: 'GPT-4o', description: 'Most capable model for complex tasks' },
            { key: 'gpt-4o-mini', displayName: 'GPT-4o Mini', description: 'Fast and affordable for most tasks' },
            { key: 'gpt-4-turbo', displayName: 'GPT-4 Turbo', description: 'Previous generation flagship' },
            { key: 'gpt-3.5-turbo', displayName: 'GPT-3.5 Turbo', description: 'Fast and cost-effective' },
            { key: 'o1', displayName: 'o1', description: 'Advanced reasoning model' },
            { key: 'o1-mini', displayName: 'o1 Mini', description: 'Fast reasoning model' },
          ];
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'azure': {
        const deployments = (settings.azure?.deployments || []).filter(Boolean);
        const currentModel = settings.azure?.deployment || deployments[0] || 'deployment-name';
        const modelList = deployments.map((deployment) => ({
          key: deployment,
          displayName: deployment,
          description: 'Azure OpenAI deployment',
        }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'ollama': {
        const currentModel = settings.ollama?.model || 'llama3.2';
        const modelList = settings.cachedOllamaModels && settings.cachedOllamaModels.length > 0
          ? settings.cachedOllamaModels
          : Object.entries(OLLAMA_MODELS).map(([key, value]) => ({
            key,
            displayName: value.displayName,
            description: `${value.size} parameter model`,
          }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'groq': {
        const currentModel = settings.groq?.model || 'llama-3.1-8b-instant';
        const modelList = settings.cachedGroqModels && settings.cachedGroqModels.length > 0
          ? settings.cachedGroqModels
          : Object.values(GROQ_MODELS).map((value) => ({
            key: value.id,
            displayName: value.displayName,
            description: value.description,
          }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'xai': {
        const currentModel = settings.xai?.model || 'grok-4-fast-non-reasoning';
        const modelList = settings.cachedXaiModels && settings.cachedXaiModels.length > 0
          ? settings.cachedXaiModels
          : Object.values(XAI_MODELS).map((value) => ({
            key: value.id,
            displayName: value.displayName,
            description: value.description,
          }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'kimi': {
        const currentModel = settings.kimi?.model || 'kimi-k2.5';
        const modelList = settings.cachedKimiModels && settings.cachedKimiModels.length > 0
          ? settings.cachedKimiModels
          : Object.values(KIMI_MODELS).map((value) => ({
            key: value.id,
            displayName: value.displayName,
            description: value.description,
          }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      case 'pi': {
        const currentModel = settings.pi?.model || DEFAULT_PI_MODEL;
        const modelList = settings.cachedPiModels && settings.cachedPiModels.length > 0
          ? settings.cachedPiModels
          : PiProvider.getAvailableModels(settings.pi?.provider).map((m) => ({
            key: m.id,
            displayName: m.name,
            description: m.description,
          }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }

      default: {
        const currentModel = settings.modelKey;
        const modelList = Object.entries(MODELS).map(([key, value]) => ({
          key,
          displayName: value.displayName,
          description: 'Claude model',
        }));
        return {
          currentModel,
          models: ensureCurrentModel(modelList, currentModel),
        };
      }
    }
  }

  /**
   * Apply a model selection to provider-specific settings.
   */
  static applyModelSelection(settings: LLMSettings, modelKey: string): LLMSettings {
    const updated: LLMSettings = { ...settings };
    const resolvedProviderType = resolveCustomProviderId(settings.providerType);

    if (CUSTOM_PROVIDER_IDS.has(resolvedProviderType as any)) {
      const existing = settings.customProviders?.[resolvedProviderType] || {};
      updated.customProviders = {
        ...(settings.customProviders || {}),
        [resolvedProviderType]: {
          ...existing,
          model: modelKey,
        },
      };
      return updated;
    }

    switch (settings.providerType) {
      case 'gemini':
        updated.gemini = { ...settings.gemini, model: modelKey };
        break;
      case 'openrouter':
        updated.openrouter = { ...settings.openrouter, model: modelKey };
        break;
      case 'ollama':
        updated.ollama = { ...settings.ollama, model: modelKey };
        break;
      case 'openai':
        updated.openai = { ...settings.openai, model: modelKey };
        break;
      case 'azure': {
        const existingDeployments = (settings.azure?.deployments || []).filter(Boolean);
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
      case 'groq':
        updated.groq = { ...settings.groq, model: modelKey };
        break;
      case 'xai':
        updated.xai = { ...settings.xai, model: modelKey };
        break;
      case 'kimi':
        updated.kimi = { ...settings.kimi, model: modelKey };
        break;
      case 'pi':
        updated.pi = { ...settings.pi, model: modelKey };
        break;
      case 'anthropic':
        updated.modelKey = modelKey as ModelKey;
        break;
      case 'bedrock': {
        const knownBedrockEntry = Object.entries(MODELS).find(([, value]) => value.bedrock === modelKey);
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

  /**
   * Get the current LLM settings
   */
  static getSettings(): LLMSettings {
    return this.loadSettings();
  }

  /**
   * Test a provider configuration
   */
  static async testProvider(config: LLMProviderConfig): Promise<{ success: boolean; error?: string }> {
    try {
      const provider = this.createProviderFromConfig(config);
      return await provider.testConnection();
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to create provider',
      };
    }
  }

  /**
   * Fetch available Bedrock models from AWS
   */
  static async getBedrockModels(config?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
  }): Promise<Array<{ id: string; name: string; provider: string; description: string }>> {
    const settings = this.loadSettings();
    const region = config?.region || settings.bedrock?.region || 'us-east-1';
    const accessKeyId = config?.accessKeyId || settings.bedrock?.accessKeyId;
    const secretAccessKey = config?.secretAccessKey || settings.bedrock?.secretAccessKey;
    const profile = config?.profile || settings.bedrock?.profile;

    // Default Claude models available on Bedrock (these are inference profile IDs).
    const defaultModels = Object.entries(MODELS).map(([key, value]) => ({
      id: value.bedrock,
      name: value.displayName,
      provider: 'Anthropic',
      description: key.includes('opus') ? 'Most capable for complex tasks (inference profile)' :
                   key.includes('sonnet') ? 'Balanced performance and speed (inference profile)' :
                   'Fast and efficient (inference profile)',
    }));

    try {
      // Import BedrockClient for listing inference profiles/models (different from runtime client)
      const { BedrockClient, ListInferenceProfilesCommand } = await import('@aws-sdk/client-bedrock');
      const { fromIni } = await import('@aws-sdk/credential-provider-ini');

      const clientConfig: any = { region };

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
      const inferenceProfiles: Array<{ id: string; name: string; provider: string; description: string }> = [];
      let nextToken: string | undefined;
      let pageCount = 0;

      do {
        pageCount++;
        const response = await client.send(
          new ListInferenceProfilesCommand({
            maxResults: 100,
            nextToken,
          })
        );

        const profiles = response.inferenceProfileSummaries || [];
        for (const profileSummary of profiles as any[]) {
          if (profileSummary?.status && profileSummary.status !== 'ACTIVE') continue;

          const models = (profileSummary?.models || []) as Array<{ modelArn?: string }>;
          const hasClaudeModel = models.some((m) => {
            const arn = (m?.modelArn || '').toLowerCase();
            return arn.includes('anthropic') && arn.includes('claude');
          });
          if (!hasClaudeModel) continue;

          const id = (profileSummary?.inferenceProfileId || profileSummary?.inferenceProfileArn || '').trim();
          if (!id) continue;

          const name = (profileSummary?.inferenceProfileName || id).trim();
          const type = profileSummary?.type ? String(profileSummary.type) : 'INFERENCE_PROFILE';
          const description = profileSummary?.description
            ? String(profileSummary.description)
            : `Inference profile (${type})`;

          inferenceProfiles.push({
            id,
            name,
            provider: 'Anthropic',
            description,
          });
        }

        nextToken = response.nextToken;
        // Safety cap to avoid unexpectedly huge listings.
      } while (nextToken && pageCount < 10);

      const seen = new Set<string>();
      const merged: Array<{ id: string; name: string; provider: string; description: string }> = [];

      for (const entry of [...defaultModels, ...inferenceProfiles]) {
        if (!entry.id || seen.has(entry.id)) continue;
        seen.add(entry.id);
        merged.push(entry);
      }

      return merged.length > 0 ? merged : defaultModels;
    } catch (error: any) {
      console.error('Failed to fetch Bedrock models:', error);
      // Return default models on error
      return defaultModels;
    }
  }

  /**
   * Fetch available Ollama models from the server
   */
  static async getOllamaModels(baseUrl?: string): Promise<Array<{ name: string; size: number; modified: string }>> {
    const settings = this.loadSettings();
    const url = baseUrl || settings.ollama?.baseUrl || 'http://localhost:11434';

    try {
      console.log(`[ProviderFactory] Fetching Ollama models from ${url}...`);
      const provider = new OllamaProvider({
        type: 'ollama',
        model: '',
        ollamaBaseUrl: url,
        ollamaApiKey: settings.ollama?.apiKey,
      });
      const models = await provider.getAvailableModels();
      console.log(`[ProviderFactory] Fetched ${models.length} models from Ollama`);
      return models;
    } catch (error: any) {
      console.error('Failed to fetch Ollama models:', error);
      return [];
    }
  }

  /**
   * Fetch available Gemini models from the API
   */
  static async getGeminiModels(apiKey?: string): Promise<Array<{ name: string; displayName: string; description: string }>> {
    const settings = this.loadSettings();
    // Normalize empty strings to undefined
    const normalizedApiKey = apiKey?.trim() || undefined;
    const settingsKey = settings.gemini?.apiKey;
    const key = normalizedApiKey || settingsKey;

    const defaultModels = [
      { name: 'gemini-2.5-pro-preview-05-06', displayName: 'Gemini 2.5 Pro', description: 'Most capable model for complex tasks' },
      { name: 'gemini-2.5-flash-preview-05-20', displayName: 'Gemini 2.5 Flash', description: 'Fast and efficient for most tasks' },
      { name: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', description: 'Balanced speed and capability' },
      { name: 'gemini-2.0-flash-lite', displayName: 'Gemini 2.0 Flash Lite', description: 'Fastest and most cost-effective' },
      { name: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', description: 'Previous generation pro model' },
      { name: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', description: 'Previous generation flash model' },
    ];

    if (!key) {
      // Return default models if no API key
      return defaultModels;
    }

    try {
      const provider = new GeminiProvider({
        type: 'gemini',
        model: '',
        geminiApiKey: key,
      });
      return await provider.getAvailableModels();
    } catch (error: any) {
      console.error('Failed to fetch Gemini models:', error);
      // Return default models on error instead of empty array
      return defaultModels;
    }
  }

  /**
   * Fetch available OpenRouter models from the API
   */
  static async getOpenRouterModels(apiKey?: string, baseUrl?: string): Promise<Array<{ id: string; name: string; context_length: number }>> {
    const settings = this.loadSettings();
    // Normalize empty strings to undefined
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.openrouter?.apiKey;
    const normalizedBaseUrl = baseUrl?.trim() || undefined;
    const resolvedBaseUrl = normalizedBaseUrl || settings.openrouter?.baseUrl;

    const defaultModels = [
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context_length: 200000 },
      { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', context_length: 200000 },
      { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000 },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', context_length: 128000 },
      { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5', context_length: 1000000 },
      { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', context_length: 131072 },
    ];

    if (!key) {
      // Return default models if no API key
      return defaultModels;
    }

    try {
      const provider = new OpenRouterProvider({
        type: 'openrouter',
        model: '',
        openrouterApiKey: key,
        openrouterBaseUrl: resolvedBaseUrl,
      });
      return await provider.getAvailableModels();
    } catch (error: any) {
      console.error('Failed to fetch OpenRouter models:', error);
      // Return default models on error instead of empty array
      return defaultModels;
    }
  }

  /**
   * Fetch available OpenAI models
   * For API key auth: uses the models.list API via OpenAI SDK
   * For OAuth auth: uses pi-ai SDK's model list for openai-codex provider
   */
  static async getOpenAIModels(apiKey?: string): Promise<Array<{ id: string; name: string; description: string }>> {
    const settings = this.loadSettings();
    // Normalize empty strings to undefined
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.openai?.apiKey;
    // Check for OAuth access token if no API key
    const accessToken = settings.openai?.accessToken;
    const refreshToken = settings.openai?.refreshToken;

    const defaultModels = [
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Most capable model for complex tasks' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast and affordable for most tasks' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: 'Previous generation flagship' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', description: 'Fast and cost-effective' },
      { id: 'o1', name: 'o1', description: 'Advanced reasoning model' },
      { id: 'o1-mini', name: 'o1 Mini', description: 'Fast reasoning model' },
    ];

    // For OAuth users, use pi-ai SDK's model list directly
    if (accessToken && refreshToken && !key) {
      console.log('[OpenAI] Using OAuth - fetching models from pi-ai SDK...');
      try {
        const piAiModels = getPiAiModels('openai-codex');
        const models = piAiModels.map((m) => ({
          id: m.id,
          name: m.name || this.formatOpenAIModelName(m.id),
          description: this.getOpenAIModelDescription(m.id),
        }));

        // Sort by priority (ChatGPT internal models)
        models.sort((a, b) => {
          const priority = (id: string) => {
            if (id.includes('5.1-codex-mini')) return 0;
            if (id.includes('5.1-codex-max')) return 1;
            if (id === 'gpt-5.1') return 2;
            if (id.includes('5.3-codex')) return 3;
            if (id.includes('5.2-codex')) return 3;
            if (id === 'gpt-5.2') return 4;
            return 5;
          };
          return priority(a.id) - priority(b.id);
        });

        console.log(`[OpenAI] Found ${models.length} models via pi-ai SDK`);
        return models;
      } catch (error) {
        console.error('[OpenAI] Failed to get models from pi-ai SDK:', error);
        // Return ChatGPT-specific defaults for OAuth users
        return [
          { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', description: 'Fast and efficient for most tasks' },
          { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', description: 'Maximum capability for complex tasks' },
          { id: 'gpt-5.1', name: 'GPT-5.1', description: 'Balanced performance and capability' },
          { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', description: 'Advanced reasoning model' },
          { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', description: 'Advanced reasoning model' },
          { id: 'gpt-5.2', name: 'GPT-5.2', description: 'Most advanced reasoning' },
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
        type: 'openai',
        model: '',
        openaiApiKey: key,
      });
      return await provider.getAvailableModels();
    } catch (error: any) {
      console.error('Failed to fetch OpenAI models:', error);
      // Return default models on error instead of empty array
      return defaultModels;
    }
  }

  /**
   * Fetch available Groq models from the API
   */
  static async getGroqModels(apiKey?: string, baseUrl?: string): Promise<Array<{ id: string; name: string }>> {
    const settings = this.loadSettings();
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.groq?.apiKey;
    const normalizedBaseUrl = baseUrl?.trim() || undefined;
    const resolvedBaseUrl = normalizedBaseUrl || settings.groq?.baseUrl;

    const defaultModels = [
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
    ];

    if (!key) {
      return defaultModels;
    }

    try {
      const provider = new GroqProvider({
        type: 'groq',
        model: '',
        groqApiKey: key,
        groqBaseUrl: resolvedBaseUrl,
      });
      return await provider.getAvailableModels();
    } catch (error: any) {
      console.error('Failed to fetch Groq models:', error);
      return defaultModels;
    }
  }

  /**
   * Fetch available xAI models from the API
   */
  static async getXAIModels(apiKey?: string, baseUrl?: string): Promise<Array<{ id: string; name: string }>> {
    const settings = this.loadSettings();
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.xai?.apiKey;
    const normalizedBaseUrl = baseUrl?.trim() || undefined;
    const resolvedBaseUrl = normalizedBaseUrl || settings.xai?.baseUrl;

    const defaultModels = [
      { id: 'grok-4', name: 'Grok 4' },
      { id: 'grok-4-fast-non-reasoning', name: 'Grok 4 Fast (Non-Reasoning)' },
      { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast (Reasoning)' },
    ];

    if (!key) {
      return defaultModels;
    }

    try {
      const provider = new XAIProvider({
        type: 'xai',
        model: '',
        xaiApiKey: key,
        xaiBaseUrl: resolvedBaseUrl,
      });
      return await provider.getAvailableModels();
    } catch (error: any) {
      console.error('Failed to fetch xAI models:', error);
      return defaultModels;
    }
  }

  /**
   * Fetch available Kimi models from the API
   */
  static async getKimiModels(apiKey?: string, baseUrl?: string): Promise<Array<{ id: string; name: string }>> {
    const settings = this.loadSettings();
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.kimi?.apiKey;
    const normalizedBaseUrl = baseUrl?.trim() || undefined;
    const resolvedBaseUrl = normalizedBaseUrl || settings.kimi?.baseUrl;

    const defaultModels = [
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'kimi-k2-0905-preview', name: 'Kimi K2.5 Preview' },
      { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo (Preview)' },
      { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
      { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo' },
    ];

    if (!key) {
      return defaultModels;
    }

    try {
      const provider = new KimiProvider({
        type: 'kimi',
        model: '',
        kimiApiKey: key,
        kimiBaseUrl: resolvedBaseUrl,
      });
      return await provider.getAvailableModels();
    } catch (error: any) {
      console.error('Failed to fetch Kimi models:', error);
      return defaultModels;
    }
  }

  /**
   * Fetch available Pi models for a given Pi backend provider
   */
  static async getPiModels(piProvider?: string): Promise<Array<{ id: string; name: string; description: string }>> {
    return PiProvider.getAvailableModels(piProvider);
  }

  /**
   * Get available Pi backend providers
   */
  static getPiProviders(): Array<{ id: string; name: string }> {
    return PiProvider.getAvailableProviders();
  }

  /**
   * Format OpenAI model ID to display name
   */
  private static formatOpenAIModelName(modelId: string): string {
    // Public API models
    if (modelId === 'gpt-4o') return 'GPT-4o';
    if (modelId === 'gpt-4o-mini') return 'GPT-4o Mini';
    if (modelId.includes('gpt-4o-')) return `GPT-4o (${modelId.replace('gpt-4o-', '')})`;
    if (modelId === 'gpt-4-turbo') return 'GPT-4 Turbo';
    if (modelId === 'gpt-4') return 'GPT-4';
    if (modelId === 'gpt-3.5-turbo') return 'GPT-3.5 Turbo';
    if (modelId === 'o1') return 'o1';
    if (modelId === 'o1-mini') return 'o1 Mini';
    if (modelId === 'o1-preview') return 'o1 Preview';
    if (modelId === 'o3-mini') return 'o3 Mini';
    // ChatGPT internal models
    if (modelId === 'gpt-5.1') return 'GPT-5.1';
    if (modelId === 'gpt-5.1-codex-mini') return 'GPT-5.1 Codex Mini';
    if (modelId === 'gpt-5.1-codex-max') return 'GPT-5.1 Codex Max';
    if (modelId === 'gpt-5.2') return 'GPT-5.2';
    if (modelId === 'gpt-5.2-codex') return 'GPT-5.2 Codex';
    if (modelId === 'gpt-5.3-codex') return 'GPT-5.3 Codex';
    return modelId;
  }

  /**
   * Get OpenAI model description
   */
  private static getOpenAIModelDescription(modelId: string): string {
    // Public API models
    if (modelId.includes('gpt-4o') && !modelId.includes('mini')) return 'Most capable model for complex tasks';
    if (modelId.includes('gpt-4o-mini')) return 'Fast and affordable for most tasks';
    if (modelId.includes('gpt-4-turbo')) return 'Previous generation flagship';
    if (modelId.includes('gpt-4')) return 'High capability model';
    if (modelId.includes('gpt-3.5')) return 'Fast and cost-effective';
    if (modelId === 'o1' || modelId === 'o1-preview') return 'Advanced reasoning model';
    if (modelId === 'o1-mini') return 'Fast reasoning model';
    if (modelId.includes('o3')) return 'Next generation reasoning';
    // ChatGPT internal models
    if (modelId === 'gpt-5.1') return 'Balanced performance and capability';
    if (modelId === 'gpt-5.1-codex-mini') return 'Fast and efficient for most tasks';
    if (modelId === 'gpt-5.1-codex-max') return 'Maximum capability for complex tasks';
    if (modelId === 'gpt-5.2') return 'Most advanced reasoning';
    if (modelId === 'gpt-5.2-codex') return 'Advanced reasoning model';
    if (modelId === 'gpt-5.3-codex') return 'Advanced reasoning model';
    return 'OpenAI model';
  }

  /**
   * Save cached models for a provider
   */
  static saveCachedModels(
    providerType: 'gemini' | 'openrouter' | 'ollama' | 'bedrock' | 'openai' | 'groq' | 'xai' | 'kimi' | 'pi',
    models: CachedModelInfo[]
  ): void {
    const settings = this.loadSettings();

    switch (providerType) {
      case 'gemini':
        settings.cachedGeminiModels = models;
        break;
      case 'openrouter':
        settings.cachedOpenRouterModels = models;
        break;
      case 'ollama':
        settings.cachedOllamaModels = models;
        break;
      case 'bedrock':
        settings.cachedBedrockModels = models;
        break;
      case 'openai':
        settings.cachedOpenAIModels = models;
        break;
      case 'groq':
        settings.cachedGroqModels = models;
        break;
      case 'xai':
        settings.cachedXaiModels = models;
        break;
      case 'kimi':
        settings.cachedKimiModels = models;
        break;
      case 'pi':
        settings.cachedPiModels = models;
        break;
    }

    this.saveSettings(settings);
  }

  /**
   * Get cached models for a provider
   */
  static getCachedModels(
    providerType: 'gemini' | 'openrouter' | 'ollama' | 'bedrock' | 'openai' | 'groq' | 'xai' | 'kimi' | 'pi'
  ): CachedModelInfo[] | undefined {
    const settings = this.loadSettings();

    switch (providerType) {
      case 'gemini':
        return settings.cachedGeminiModels;
      case 'openrouter':
        return settings.cachedOpenRouterModels;
      case 'ollama':
        return settings.cachedOllamaModels;
      case 'bedrock':
        return settings.cachedBedrockModels;
      case 'openai':
        return settings.cachedOpenAIModels;
      case 'groq':
        return settings.cachedGroqModels;
      case 'xai':
        return settings.cachedXaiModels;
      case 'kimi':
        return settings.cachedKimiModels;
      case 'pi':
        return settings.cachedPiModels;
      default:
        return undefined;
    }
  }
}
