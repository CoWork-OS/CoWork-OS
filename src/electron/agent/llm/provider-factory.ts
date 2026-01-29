import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getModels as getPiAiModels } from '@mariozechner/pi-ai';
import {
  LLMProvider,
  LLMProviderConfig,
  LLMProviderType,
  MODELS,
  ModelKey,
  DEFAULT_MODEL,
} from './types';
import { AnthropicProvider } from './anthropic-provider';
import { BedrockProvider } from './bedrock-provider';
import { OllamaProvider } from './ollama-provider';
import { GeminiProvider } from './gemini-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { OpenAIProvider } from './openai-provider';

const SETTINGS_FILE = 'llm-settings.json';
const MASKED_VALUE = '***configured***';
const ENCRYPTED_PREFIX = 'encrypted:';

/**
 * Encrypt a secret using OS keychain via safeStorage
 */
function encryptSecret(value?: string): string | undefined {
  if (!value || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed === MASKED_VALUE) return undefined;

  try {
    if (safeStorage.isEncryptionAvailable()) {
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
 * Decrypt a secret that was encrypted with safeStorage
 */
function decryptSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (value === MASKED_VALUE) return undefined;

  if (value.startsWith(ENCRYPTED_PREFIX)) {
    try {
      const isAvailable = safeStorage.isEncryptionAvailable();
      if (isAvailable) {
        const encrypted = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
        const decrypted = safeStorage.decryptString(encrypted);
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

function normalizeSecret(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === MASKED_VALUE || trimmed.startsWith(ENCRYPTED_PREFIX)) return undefined;
  return trimmed;
}

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
  // Cached models from API (populated when user refreshes)
  cachedGeminiModels?: CachedModelInfo[];
  cachedOpenRouterModels?: CachedModelInfo[];
  cachedOllamaModels?: CachedModelInfo[];
  cachedBedrockModels?: CachedModelInfo[];
  cachedOpenAIModels?: CachedModelInfo[];
}

const DEFAULT_SETTINGS: LLMSettings = {
  providerType: 'anthropic',
  modelKey: DEFAULT_MODEL,
};

/**
 * Factory for creating LLM providers
 */
export class LLMProviderFactory {
  private static settingsPath: string;
  private static cachedSettings: LLMSettings | null = null;

  /**
   * Initialize the settings path
   */
  static initialize(): void {
    const userDataPath = app.getPath('userData');
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE);
  }

  /**
   * Get the path to settings file (for testing)
   */
  static getSettingsPath(): string {
    return this.settingsPath;
  }

  /**
   * Load settings from disk
   */
  static loadSettings(): LLMSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: LLMSettings;
    let settingsFileExists = false;

    try {
      if (fs.existsSync(this.settingsPath)) {
        settingsFileExists = true;
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
      } else {
        settings = { ...DEFAULT_SETTINGS };
      }
    } catch (error) {
      console.error('Failed to load LLM settings:', error);
      settings = { ...DEFAULT_SETTINGS };
    }

    // Auto-detect provider if no settings file exists
    if (!settingsFileExists) {
      const detectedProvider = this.detectProviderFromSettings(settings);
      if (detectedProvider) {
        settings.providerType = detectedProvider;
        console.log(`Auto-detected LLM provider: ${detectedProvider}`);
      }
    }

    const sanitized = sanitizeSettings(settings);
    this.cachedSettings = sanitized;
    return sanitized;
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
    if (settings.bedrock?.accessKeyId || settings.bedrock?.profile) {
      return 'bedrock';
    }
    if (settings.ollama?.baseUrl || settings.ollama?.model) {
      return 'ollama';
    }

    // No valid credentials detected - user needs to configure via Settings
    return null;
  }

  /**
   * Save settings to disk
   */
  static saveSettings(settings: LLMSettings): void {
    try {
      // Encrypt sensitive data using OS keychain before saving
      const settingsToSave = { ...settings };

      // Encrypt API keys using safeStorage (OS keychain)
      if (settingsToSave.anthropic?.apiKey) {
        settingsToSave.anthropic = {
          ...settingsToSave.anthropic,
          apiKey: encryptSecret(settingsToSave.anthropic.apiKey),
        };
      }

      if (settingsToSave.bedrock?.secretAccessKey) {
        settingsToSave.bedrock = {
          ...settingsToSave.bedrock,
          secretAccessKey: encryptSecret(settingsToSave.bedrock.secretAccessKey),
        };
      }

      if (settingsToSave.ollama?.apiKey) {
        settingsToSave.ollama = {
          ...settingsToSave.ollama,
          apiKey: encryptSecret(settingsToSave.ollama.apiKey),
        };
      }

      if (settingsToSave.gemini?.apiKey) {
        settingsToSave.gemini = {
          ...settingsToSave.gemini,
          apiKey: encryptSecret(settingsToSave.gemini.apiKey),
        };
      }

      if (settingsToSave.openrouter?.apiKey) {
        settingsToSave.openrouter = {
          ...settingsToSave.openrouter,
          apiKey: encryptSecret(settingsToSave.openrouter.apiKey),
        };
      }

      if (settingsToSave.openai) {
        settingsToSave.openai = {
          ...settingsToSave.openai,
          apiKey: settingsToSave.openai.apiKey ? encryptSecret(settingsToSave.openai.apiKey) : undefined,
          accessToken: settingsToSave.openai.accessToken ? encryptSecret(settingsToSave.openai.accessToken) : undefined,
          refreshToken: settingsToSave.openai.refreshToken ? encryptSecret(settingsToSave.openai.refreshToken) : undefined,
        };
      }

      fs.writeFileSync(this.settingsPath, JSON.stringify(settingsToSave, null, 2));
      this.cachedSettings = settings;
    } catch (error) {
      console.error('Failed to save LLM settings:', error);
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

    const config: LLMProviderConfig = {
      type: providerType,
      model: this.getModelId(settings.modelKey, providerType, settings.ollama?.model, settings.gemini?.model, settings.openrouter?.model, settings.openai?.model),
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
      // OpenAI config - from settings only
      openaiApiKey: normalizeSecret(overrideConfig?.openaiApiKey) || settings.openai?.apiKey,
      openaiAccessToken: normalizeSecret(overrideConfig?.openaiAccessToken) || settings.openai?.accessToken,
      openaiRefreshToken: settings.openai?.refreshToken,
      openaiTokenExpiresAt: settings.openai?.tokenExpiresAt,
    };

    return this.createProviderFromConfig(config);
  }

  /**
   * Create a provider from explicit config
   */
  static createProviderFromConfig(config: LLMProviderConfig): LLMProvider {
    switch (config.type) {
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'bedrock':
        return new BedrockProvider(config);
      case 'ollama':
        return new OllamaProvider(config);
      case 'gemini':
        return new GeminiProvider(config);
      case 'openrouter':
        return new OpenRouterProvider(config);
      case 'openai':
        return new OpenAIProvider(config);
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }

  /**
   * Get the model ID for a provider
   */
  static getModelId(modelKey: ModelKey | string, providerType: LLMProviderType, ollamaModel?: string, geminiModel?: string, openrouterModel?: string, openaiModel?: string): string {
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

    return [
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
        type: 'bedrock' as LLMProviderType,
        name: 'AWS Bedrock',
        configured: !!(settings.bedrock?.accessKeyId || settings.bedrock?.profile),
      },
      {
        type: 'ollama' as LLMProviderType,
        name: 'Ollama (Local)',
        configured: !!(settings.ollama?.baseUrl || settings.ollama?.model),
      },
    ];
  }

  /**
   * Get current configuration status
   */
  static getConfigStatus(): {
    currentProvider: LLMProviderType;
    currentModel: ModelKey | string;
    providers: Array<{ type: LLMProviderType; name: string; configured: boolean }>;
    models: Array<{ key: ModelKey; displayName: string }>;
  } {
    const settings = this.loadSettings();
    return {
      currentProvider: settings.providerType,
      currentModel: settings.modelKey,
      providers: this.getAvailableProviders(),
      models: this.getAvailableModels(),
    };
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

    // Default Claude models available on Bedrock
    const defaultModels = Object.entries(MODELS).map(([key, value]) => ({
      id: value.bedrock,
      name: value.displayName,
      provider: 'Anthropic',
      description: key.includes('opus') ? 'Most capable for complex tasks' :
                   key.includes('sonnet') ? 'Balanced performance and speed' :
                   'Fast and efficient',
    }));

    try {
      // Import BedrockClient for listing models (different from runtime client)
      const { BedrockClient, ListFoundationModelsCommand } = await import('@aws-sdk/client-bedrock');
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
      const command = new ListFoundationModelsCommand({
        byOutputModality: 'TEXT',
      });

      const response = await client.send(command);
      const models = response.modelSummaries || [];

      // Filter for Claude models and format the response
      const claudeModels = models
        .filter((m: any) => m.providerName === 'Anthropic' && m.modelId?.includes('claude'))
        .map((m: any) => ({
          id: m.modelId || '',
          name: m.modelName || m.modelId || '',
          provider: m.providerName || 'Anthropic',
          description: m.modelId?.includes('opus') ? 'Most capable for complex tasks' :
                       m.modelId?.includes('sonnet') ? 'Balanced performance and speed' :
                       m.modelId?.includes('haiku') ? 'Fast and efficient' :
                       'Claude model',
        }))
        .filter((m: any) => m.id);

      return claudeModels.length > 0 ? claudeModels : defaultModels;
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
  static async getOpenRouterModels(apiKey?: string): Promise<Array<{ id: string; name: string; context_length: number }>> {
    const settings = this.loadSettings();
    // Normalize empty strings to undefined
    const normalizedApiKey = apiKey?.trim() || undefined;
    const key = normalizedApiKey || settings.openrouter?.apiKey;

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
    return 'OpenAI model';
  }

  /**
   * Save cached models for a provider
   */
  static saveCachedModels(
    providerType: 'gemini' | 'openrouter' | 'ollama' | 'bedrock' | 'openai',
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
    }

    this.saveSettings(settings);
  }

  /**
   * Get cached models for a provider
   */
  static getCachedModels(providerType: 'gemini' | 'openrouter' | 'ollama' | 'bedrock' | 'openai'): CachedModelInfo[] | undefined {
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
      default:
        return undefined;
    }
  }
}
