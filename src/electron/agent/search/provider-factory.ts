import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  SearchProvider,
  SearchProviderConfig,
  SearchProviderType,
  SearchType,
  SearchQuery,
  SearchResponse,
  SEARCH_PROVIDER_INFO,
} from './types';
import { TavilyProvider } from './tavily-provider';
import { BraveProvider } from './brave-provider';
import { SerpApiProvider } from './serpapi-provider';
import { GoogleProvider } from './google-provider';
import { SecureSettingsRepository } from '../../database/SecureSettingsRepository';

const LEGACY_SETTINGS_FILE = 'search-settings.json';

/**
 * Stored settings for Search provider
 */
export interface SearchSettings {
  primaryProvider: SearchProviderType | null;
  fallbackProvider: SearchProviderType | null;
  tavily?: {
    apiKey?: string;
  };
  brave?: {
    apiKey?: string;
  };
  serpapi?: {
    apiKey?: string;
  };
  google?: {
    apiKey?: string;
    searchEngineId?: string;
  };
}

const DEFAULT_SETTINGS: SearchSettings = {
  primaryProvider: null,
  fallbackProvider: null,
};

/**
 * Factory for creating Search providers with fallback support
 */
export class SearchProviderFactory {
  private static legacySettingsPath: string;
  private static cachedSettings: SearchSettings | null = null;
  private static migrationCompleted = false;

  /**
   * Initialize the factory
   */
  static initialize(): void {
    const userDataPath = app.getPath('userData');
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
        console.log('[SearchProviderFactory] SecureSettingsRepository not yet initialized, skipping migration');
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      // Check if already migrated to database
      if (repository.exists('search')) {
        console.log('[SearchProviderFactory] Settings already in database, skipping migration');
        this.migrationCompleted = true;
        return;
      }

      // Check if legacy file exists
      if (!fs.existsSync(this.legacySettingsPath)) {
        console.log('[SearchProviderFactory] No legacy settings file found');
        this.migrationCompleted = true;
        return;
      }

      console.log('[SearchProviderFactory] Migrating settings from legacy JSON file to encrypted database...');

      // Create backup before migration
      const backupPath = this.legacySettingsPath + '.migration-backup';
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        // Read legacy settings
        const data = fs.readFileSync(this.legacySettingsPath, 'utf-8');
        const parsed = JSON.parse(data);

        // Handle migration from old format (providerType -> primaryProvider)
        if (parsed.providerType && !parsed.primaryProvider) {
          parsed.primaryProvider = parsed.providerType;
          delete parsed.providerType;
        }

        const legacySettings = { ...DEFAULT_SETTINGS, ...parsed };

        // Save to encrypted database
        repository.save('search', legacySettings);
        console.log('[SearchProviderFactory] Settings migrated to encrypted database');

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log('[SearchProviderFactory] Migration complete, cleaned up legacy files');

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error('[SearchProviderFactory] Migration failed, backup preserved at:', backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error('[SearchProviderFactory] Migration failed:', error);
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
  static loadSettings(): SearchSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: SearchSettings = { ...DEFAULT_SETTINGS };

    try {
      // Try to load from encrypted database
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<SearchSettings>('search');
        if (stored) {
          settings = { ...DEFAULT_SETTINGS, ...stored };
        }
      }
    } catch (error) {
      console.error('[SearchProviderFactory] Failed to load settings from database:', error);
    }

    // Auto-detect and select providers if primaryProvider is not set
    if (!settings.primaryProvider) {
      const configuredProviders = this.getConfiguredProvidersFromSettings(settings);
      if (configuredProviders.length > 0) {
        settings.primaryProvider = configuredProviders[0];
        console.log(`[SearchProviderFactory] Auto-selected primary provider: ${configuredProviders[0]}`);
        if (configuredProviders.length > 1 && !settings.fallbackProvider) {
          settings.fallbackProvider = configuredProviders[1];
          console.log(`[SearchProviderFactory] Auto-selected fallback provider: ${configuredProviders[1]}`);
        }
      }
    }

    this.cachedSettings = settings;
    return settings;
  }

  /**
   * Get list of configured provider types from settings only
   * Note: Environment variables are no longer used for security reasons.
   */
  private static getConfiguredProvidersFromSettings(settings: SearchSettings): SearchProviderType[] {
    const configured: SearchProviderType[] = [];

    // Check Tavily
    if (settings.tavily?.apiKey) {
      configured.push('tavily');
    }
    // Check Brave
    if (settings.brave?.apiKey) {
      configured.push('brave');
    }
    // Check SerpAPI
    if (settings.serpapi?.apiKey) {
      configured.push('serpapi');
    }
    // Check Google (requires both API key and Search Engine ID)
    if (settings.google?.apiKey && settings.google?.searchEngineId) {
      configured.push('google');
    }

    return configured;
  }

  /**
   * Save settings to encrypted database
   */
  static saveSettings(settings: SearchSettings): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error('SecureSettingsRepository not initialized');
      }

      const repository = SecureSettingsRepository.getInstance();

      // Load existing settings to preserve API keys that weren't changed
      let existingSettings: SearchSettings = { ...DEFAULT_SETTINGS };
      const stored = repository.load<SearchSettings>('search');
      if (stored) {
        existingSettings = stored;
      }

      // Merge settings, preserving existing API keys if new ones aren't provided
      const settingsToSave: SearchSettings = {
        primaryProvider: settings.primaryProvider,
        fallbackProvider: settings.fallbackProvider,
        tavily: settings.tavily?.apiKey
          ? settings.tavily
          : existingSettings.tavily,
        brave: settings.brave?.apiKey
          ? settings.brave
          : existingSettings.brave,
        serpapi: settings.serpapi?.apiKey
          ? settings.serpapi
          : existingSettings.serpapi,
        google: settings.google?.apiKey || settings.google?.searchEngineId
          ? { ...existingSettings.google, ...settings.google }
          : existingSettings.google,
      };

      // Save to encrypted database
      repository.save('search', settingsToSave);
      this.cachedSettings = settingsToSave;

      console.log('[SearchProviderFactory] Settings saved to encrypted database');
    } catch (error) {
      console.error('[SearchProviderFactory] Failed to save settings:', error);
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
   * Get the config for creating a provider
   * Note: All credentials must be configured via the Settings UI.
   */
  private static getProviderConfig(providerType: SearchProviderType): SearchProviderConfig {
    const settings = this.loadSettings();
    return {
      type: providerType,
      tavilyApiKey: settings.tavily?.apiKey,
      braveApiKey: settings.brave?.apiKey,
      serpApiKey: settings.serpapi?.apiKey,
      googleApiKey: settings.google?.apiKey,
      googleSearchEngineId: settings.google?.searchEngineId,
    };
  }

  /**
   * Create a provider based on current settings or override
   */
  static createProvider(overrideType?: SearchProviderType): SearchProvider {
    const settings = this.loadSettings();
    const providerType = overrideType || settings.primaryProvider;

    if (!providerType) {
      throw new Error('No search provider configured');
    }

    const config = this.getProviderConfig(providerType);
    return this.createProviderFromConfig(config);
  }

  /**
   * Create provider from explicit config
   */
  static createProviderFromConfig(config: SearchProviderConfig): SearchProvider {
    switch (config.type) {
      case 'tavily':
        return new TavilyProvider(config);
      case 'brave':
        return new BraveProvider(config);
      case 'serpapi':
        return new SerpApiProvider(config);
      case 'google':
        return new GoogleProvider(config);
      default:
        throw new Error(`Unknown search provider type: ${config.type}`);
    }
  }

  /**
   * Execute a search with automatic fallback on failure
   */
  static async searchWithFallback(query: SearchQuery): Promise<SearchResponse> {
    const settings = this.loadSettings();
    const primaryType = query.provider || settings.primaryProvider;

    if (!primaryType) {
      throw new Error('No search provider configured');
    }

    // Try primary provider
    try {
      const primaryConfig = this.getProviderConfig(primaryType);
      const primaryProvider = this.createProviderFromConfig(primaryConfig);
      return await primaryProvider.search(query);
    } catch (primaryError: any) {
      console.error(`Primary search provider (${primaryType}) failed:`, primaryError.message);

      // If a specific provider was requested, don't fallback
      if (query.provider) {
        throw primaryError;
      }

      // Try fallback provider if configured
      const fallbackType = settings.fallbackProvider;
      if (fallbackType && fallbackType !== primaryType) {
        console.log(`Attempting fallback to ${fallbackType}...`);
        try {
          const fallbackConfig = this.getProviderConfig(fallbackType);
          const fallbackProvider = this.createProviderFromConfig(fallbackConfig);
          const response = await fallbackProvider.search(query);
          // Indicate this came from fallback
          console.log(`Fallback search with ${fallbackType} succeeded`);
          return response;
        } catch (fallbackError: any) {
          console.error(`Fallback search provider (${fallbackType}) also failed:`, fallbackError.message);
          // Throw the original error
          throw new Error(
            `Primary provider (${primaryType}) failed: ${primaryError.message}. ` +
            `Fallback provider (${fallbackType}) also failed: ${fallbackError.message}`
          );
        }
      }

      throw primaryError;
    }
  }

  /**
   * Get available providers based on saved configuration
   * Note: Environment variables are no longer checked for security reasons.
   */
  static getAvailableProviders(): Array<{
    type: SearchProviderType;
    name: string;
    description: string;
    configured: boolean;
    supportedTypes: SearchType[];
  }> {
    const settings = this.loadSettings();
    return [
      {
        type: 'tavily',
        name: SEARCH_PROVIDER_INFO.tavily.displayName,
        description: SEARCH_PROVIDER_INFO.tavily.description,
        configured: !!settings.tavily?.apiKey,
        supportedTypes: [...SEARCH_PROVIDER_INFO.tavily.supportedTypes],
      },
      {
        type: 'brave',
        name: SEARCH_PROVIDER_INFO.brave.displayName,
        description: SEARCH_PROVIDER_INFO.brave.description,
        configured: !!settings.brave?.apiKey,
        supportedTypes: [...SEARCH_PROVIDER_INFO.brave.supportedTypes],
      },
      {
        type: 'serpapi',
        name: SEARCH_PROVIDER_INFO.serpapi.displayName,
        description: SEARCH_PROVIDER_INFO.serpapi.description,
        configured: !!settings.serpapi?.apiKey,
        supportedTypes: [...SEARCH_PROVIDER_INFO.serpapi.supportedTypes],
      },
      {
        type: 'google',
        name: SEARCH_PROVIDER_INFO.google.displayName,
        description: SEARCH_PROVIDER_INFO.google.description,
        configured: !!(settings.google?.apiKey && settings.google?.searchEngineId),
        supportedTypes: [...SEARCH_PROVIDER_INFO.google.supportedTypes],
      },
    ];
  }

  /**
   * Check if any search provider is configured
   */
  static isAnyProviderConfigured(): boolean {
    return this.getAvailableProviders().some((p) => p.configured);
  }

  /**
   * Get current configuration status
   */
  static getConfigStatus(): {
    primaryProvider: SearchProviderType | null;
    fallbackProvider: SearchProviderType | null;
    providers: Array<{
      type: SearchProviderType;
      name: string;
      description: string;
      configured: boolean;
      supportedTypes: SearchType[];
    }>;
    isConfigured: boolean;
  } {
    const settings = this.loadSettings();
    return {
      primaryProvider: settings.primaryProvider,
      fallbackProvider: settings.fallbackProvider,
      providers: this.getAvailableProviders(),
      isConfigured: this.isAnyProviderConfigured(),
    };
  }

  /**
   * Test a provider configuration
   */
  static async testProvider(
    providerType: SearchProviderType
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const config = this.getProviderConfig(providerType);
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
