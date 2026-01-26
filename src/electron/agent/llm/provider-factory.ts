import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
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
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
        return safeStorage.decryptString(encrypted);
      }
    } catch (error) {
      console.warn('Failed to decrypt secret:', error);
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
  // Cached models from API (populated when user refreshes)
  cachedGeminiModels?: CachedModelInfo[];
  cachedOpenRouterModels?: CachedModelInfo[];
  cachedOllamaModels?: CachedModelInfo[];
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
      const detectedProvider = this.detectProviderFromEnv();
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
   * Get the Anthropic API key from environment variables
   */
  private static getAnthropicKeyFromEnv(): string | undefined {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && apiKey !== 'your_api_key_here' && apiKey.startsWith('sk-')) {
      return apiKey;
    }

    return undefined;
  }

  /**
   * Check if Ollama is configured via environment
   */
  private static getOllamaBaseUrlFromEnv(): string | undefined {
    return process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST;
  }

  /**
   * Get the Gemini API key from environment variables
   */
  private static getGeminiKeyFromEnv(): string | undefined {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (apiKey && apiKey !== 'your_api_key_here') {
      return apiKey;
    }
    return undefined;
  }

  /**
   * Get the OpenRouter API key from environment variables
   */
  private static getOpenRouterKeyFromEnv(): string | undefined {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey && apiKey !== 'your_api_key_here') {
      return apiKey;
    }
    return undefined;
  }

  /**
   * Detect which provider to use based on environment variables
   */
  private static detectProviderFromEnv(): LLMProviderType | null {
    const awsAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const awsProfile = process.env.AWS_PROFILE;
    const hasAwsCredentials = (awsAccessKey && awsSecretKey) || awsProfile;

    // Prefer Anthropic if API key exists
    if (this.getAnthropicKeyFromEnv()) {
      return 'anthropic';
    }

    // Check for Gemini API key
    if (this.getGeminiKeyFromEnv()) {
      return 'gemini';
    }

    // Check for OpenRouter API key
    if (this.getOpenRouterKeyFromEnv()) {
      return 'openrouter';
    }

    // Fall back to Bedrock if AWS credentials exist
    if (hasAwsCredentials) {
      return 'bedrock';
    }

    // Check for Ollama (local server is always available by default)
    if (this.getOllamaBaseUrlFromEnv()) {
      return 'ollama';
    }

    // No valid credentials detected
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
   */
  static createProvider(overrideConfig?: Partial<LLMProviderConfig>): LLMProvider {
    const settings = this.loadSettings();
    const providerType = overrideConfig?.type || settings.providerType;

    const anthropicApiKey =
      normalizeSecret(overrideConfig?.anthropicApiKey) ||
      settings.anthropic?.apiKey ||
      this.getAnthropicKeyFromEnv();

    const config: LLMProviderConfig = {
      type: providerType,
      model: this.getModelId(settings.modelKey, providerType, settings.ollama?.model, settings.gemini?.model, settings.openrouter?.model),
      anthropicApiKey,
      // Bedrock config
      awsRegion: overrideConfig?.awsRegion || settings.bedrock?.region || process.env.AWS_REGION,
      awsAccessKeyId: overrideConfig?.awsAccessKeyId || settings.bedrock?.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
      awsSecretAccessKey:
        normalizeSecret(overrideConfig?.awsSecretAccessKey) ||
        settings.bedrock?.secretAccessKey ||
        process.env.AWS_SECRET_ACCESS_KEY,
      awsSessionToken: overrideConfig?.awsSessionToken || settings.bedrock?.sessionToken || process.env.AWS_SESSION_TOKEN,
      awsProfile: overrideConfig?.awsProfile || settings.bedrock?.profile || process.env.AWS_PROFILE,
      // Ollama config
      ollamaBaseUrl: overrideConfig?.ollamaBaseUrl || settings.ollama?.baseUrl || this.getOllamaBaseUrlFromEnv(),
      ollamaApiKey: normalizeSecret(overrideConfig?.ollamaApiKey) || settings.ollama?.apiKey || process.env.OLLAMA_API_KEY,
      // Gemini config
      geminiApiKey:
        normalizeSecret(overrideConfig?.geminiApiKey) ||
        settings.gemini?.apiKey ||
        this.getGeminiKeyFromEnv(),
      // OpenRouter config
      openrouterApiKey:
        normalizeSecret(overrideConfig?.openrouterApiKey) ||
        settings.openrouter?.apiKey ||
        this.getOpenRouterKeyFromEnv(),
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
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }

  /**
   * Get the model ID for a provider
   */
  static getModelId(modelKey: ModelKey | string, providerType: LLMProviderType, ollamaModel?: string, geminiModel?: string, openrouterModel?: string): string {
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
   * Get available providers based on environment configuration
   */
  static getAvailableProviders(): Array<{
    type: LLMProviderType;
    name: string;
    configured: boolean;
  }> {
    const hasAnthropicKeyEnv = !!this.getAnthropicKeyFromEnv();

    const awsAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const awsProfile = process.env.AWS_PROFILE;
    const hasAwsCredentials = (awsAccessKey && awsSecretKey) || awsProfile;

    // Also check saved settings for API keys
    const settings = this.loadSettings();
    const hasAnthropicKeyInSettings = !!settings.anthropic?.apiKey;
    const hasBedrockInSettings = settings.bedrock?.region || settings.bedrock?.profile;
    const hasOllamaInSettings = settings.ollama?.baseUrl || settings.ollama?.model;
    const hasOllamaEnv = !!this.getOllamaBaseUrlFromEnv();
    const hasGeminiKeyEnv = !!this.getGeminiKeyFromEnv();
    const hasGeminiKeyInSettings = !!settings.gemini?.apiKey;
    const hasOpenRouterKeyEnv = !!this.getOpenRouterKeyFromEnv();
    const hasOpenRouterKeyInSettings = !!settings.openrouter?.apiKey;

    return [
      {
        type: 'anthropic' as LLMProviderType,
        name: 'Anthropic API',
        configured: !!(hasAnthropicKeyEnv || hasAnthropicKeyInSettings),
      },
      {
        type: 'gemini' as LLMProviderType,
        name: 'Google Gemini',
        configured: !!(hasGeminiKeyEnv || hasGeminiKeyInSettings),
      },
      {
        type: 'openrouter' as LLMProviderType,
        name: 'OpenRouter',
        configured: !!(hasOpenRouterKeyEnv || hasOpenRouterKeyInSettings),
      },
      {
        type: 'bedrock' as LLMProviderType,
        name: 'AWS Bedrock',
        configured: !!(hasAwsCredentials || hasBedrockInSettings),
      },
      {
        type: 'ollama' as LLMProviderType,
        name: 'Ollama (Local)',
        configured: !!(hasOllamaInSettings || hasOllamaEnv),
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
   * Fetch available Ollama models from the server
   */
  static async getOllamaModels(baseUrl?: string): Promise<Array<{ name: string; size: number; modified: string }>> {
    const settings = this.loadSettings();
    const url = baseUrl || settings.ollama?.baseUrl || this.getOllamaBaseUrlFromEnv() || 'http://localhost:11434';

    try {
      const provider = new OllamaProvider({
        type: 'ollama',
        model: '',
        ollamaBaseUrl: url,
        ollamaApiKey: settings.ollama?.apiKey,
      });
      return await provider.getAvailableModels();
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
    const envKey = this.getGeminiKeyFromEnv();
    const key = normalizedApiKey || settingsKey || envKey;

    // Debug logging
    const maskKey = (k?: string) => k ? `${k.substring(0, 8)}...${k.slice(-4)}` : 'undefined';
    console.log(`[Gemini] getGeminiModels called:`);
    console.log(`  - passedApiKey: ${maskKey(normalizedApiKey)}`);
    console.log(`  - settingsKey: ${maskKey(settingsKey)}`);
    console.log(`  - envKey: ${maskKey(envKey)}`);
    console.log(`  - finalKey: ${maskKey(key)}`);

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
    const key = normalizedApiKey || settings.openrouter?.apiKey || this.getOpenRouterKeyFromEnv();

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
   * Save cached models for a provider
   */
  static saveCachedModels(
    providerType: 'gemini' | 'openrouter' | 'ollama',
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
    }

    this.saveSettings(settings);
  }

  /**
   * Get cached models for a provider
   */
  static getCachedModels(providerType: 'gemini' | 'openrouter' | 'ollama'): CachedModelInfo[] | undefined {
    const settings = this.loadSettings();

    switch (providerType) {
      case 'gemini':
        return settings.cachedGeminiModels;
      case 'openrouter':
        return settings.cachedOpenRouterModels;
      case 'ollama':
        return settings.cachedOllamaModels;
      default:
        return undefined;
    }
  }
}
