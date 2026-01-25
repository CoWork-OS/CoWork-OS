import { app } from 'electron';
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

const SETTINGS_FILE = 'llm-settings.json';
const MASKED_VALUE = '***configured***';

function normalizeSecret(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === MASKED_VALUE) return undefined;
  return trimmed;
}

function sanitizeSettings(settings: LLMSettings): LLMSettings {
  const sanitized: LLMSettings = { ...settings };

  if (sanitized.anthropic) {
    sanitized.anthropic = {
      ...sanitized.anthropic,
      apiKey: normalizeSecret(sanitized.anthropic.apiKey),
    };
  }

  if (sanitized.bedrock) {
    sanitized.bedrock = {
      ...sanitized.bedrock,
      secretAccessKey: normalizeSecret(sanitized.bedrock.secretAccessKey),
    };
  }

  if (sanitized.ollama) {
    sanitized.ollama = {
      ...sanitized.ollama,
      apiKey: normalizeSecret(sanitized.ollama.apiKey),
    };
  }

  return sanitized;
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
      // Don't save sensitive data in plain text - mask API keys
      const settingsToSave = { ...settings };

      // For Anthropic, we can store a flag that key exists but not the key itself
      // The actual key should come from environment or keychain
      if (settingsToSave.anthropic?.apiKey) {
        settingsToSave.anthropic = {
          ...settingsToSave.anthropic,
          apiKey: MASKED_VALUE, // Marker that key is set
        };
      }

      // Same for AWS credentials
      if (settingsToSave.bedrock?.secretAccessKey) {
        settingsToSave.bedrock = {
          ...settingsToSave.bedrock,
          secretAccessKey: MASKED_VALUE,
        };
      }

      // Same for Ollama API key (for remote servers)
      if (settingsToSave.ollama?.apiKey) {
        settingsToSave.ollama = {
          ...settingsToSave.ollama,
          apiKey: MASKED_VALUE,
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
      model: this.getModelId(settings.modelKey, providerType, settings.ollama?.model),
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
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }

  /**
   * Get the model ID for a provider
   */
  static getModelId(modelKey: ModelKey | string, providerType: LLMProviderType, ollamaModel?: string): string {
    // For Ollama, use the specific Ollama model if provided, or default to 'llama3.2'
    if (providerType === 'ollama') {
      return ollamaModel || 'llama3.2';
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
    const hasAnthropicKey = !!this.getAnthropicKeyFromEnv();

    const awsAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const awsProfile = process.env.AWS_PROFILE;
    const hasAwsCredentials = (awsAccessKey && awsSecretKey) || awsProfile;

    // Also check saved settings
    const settings = this.loadSettings();
    const hasBedrockInSettings = settings.bedrock?.region || settings.bedrock?.profile;
    const hasOllamaInSettings = settings.ollama?.baseUrl || settings.ollama?.model;
    const hasOllamaEnv = !!this.getOllamaBaseUrlFromEnv();

    return [
      {
        type: 'anthropic' as LLMProviderType,
        name: 'Anthropic API',
        configured: hasAnthropicKey,
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
}
