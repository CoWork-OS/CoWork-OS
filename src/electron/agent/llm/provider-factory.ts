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

  return sanitized;
}

/**
 * Stored settings for LLM provider
 */
export interface LLMSettings {
  providerType: LLMProviderType;
  modelKey: ModelKey;
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
   * Detect which provider to use based on environment variables
   */
  private static detectProviderFromEnv(): LLMProviderType | null {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const hasValidAnthropicKey = anthropicKey &&
      anthropicKey !== 'your_api_key_here' &&
      anthropicKey.startsWith('sk-');

    const awsAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const awsProfile = process.env.AWS_PROFILE;
    const hasAwsCredentials = (awsAccessKey && awsSecretKey) || awsProfile;

    // Prefer Anthropic if valid key exists
    if (hasValidAnthropicKey) {
      return 'anthropic';
    }

    // Fall back to Bedrock if AWS credentials exist
    if (hasAwsCredentials) {
      return 'bedrock';
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

    const config: LLMProviderConfig = {
      type: overrideConfig?.type || settings.providerType,
      model: this.getModelId(settings.modelKey, overrideConfig?.type || settings.providerType),
      // Anthropic config
      anthropicApiKey:
        normalizeSecret(overrideConfig?.anthropicApiKey) ||
        settings.anthropic?.apiKey ||
        process.env.ANTHROPIC_API_KEY,
      // Bedrock config
      awsRegion: overrideConfig?.awsRegion || settings.bedrock?.region || process.env.AWS_REGION,
      awsAccessKeyId: overrideConfig?.awsAccessKeyId || settings.bedrock?.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
      awsSecretAccessKey:
        normalizeSecret(overrideConfig?.awsSecretAccessKey) ||
        settings.bedrock?.secretAccessKey ||
        process.env.AWS_SECRET_ACCESS_KEY,
      awsSessionToken: overrideConfig?.awsSessionToken || settings.bedrock?.sessionToken || process.env.AWS_SESSION_TOKEN,
      awsProfile: overrideConfig?.awsProfile || settings.bedrock?.profile || process.env.AWS_PROFILE,
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
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }

  /**
   * Get the model ID for a provider
   */
  static getModelId(modelKey: ModelKey, providerType: LLMProviderType): string {
    const model = MODELS[modelKey];
    if (!model) {
      throw new Error(`Unknown model: ${modelKey}`);
    }
    return model[providerType];
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
  static getAvailableProviders(): Array<{ type: LLMProviderType; name: string; configured: boolean }> {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const hasValidAnthropicKey = anthropicKey &&
      anthropicKey !== 'your_api_key_here' &&
      anthropicKey.startsWith('sk-');

    const awsAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const awsProfile = process.env.AWS_PROFILE;
    const hasAwsCredentials = (awsAccessKey && awsSecretKey) || awsProfile;

    // Also check saved settings
    const settings = this.loadSettings();
    const hasBedrockInSettings = settings.bedrock?.region || settings.bedrock?.profile;

    return [
      {
        type: 'anthropic' as LLMProviderType,
        name: 'Anthropic API',
        configured: !!hasValidAnthropicKey,
      },
      {
        type: 'bedrock' as LLMProviderType,
        name: 'AWS Bedrock',
        configured: !!(hasAwsCredentials || hasBedrockInSettings),
      },
    ];
  }

  /**
   * Get current configuration status
   */
  static getConfigStatus(): {
    currentProvider: LLMProviderType;
    currentModel: ModelKey;
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
}
