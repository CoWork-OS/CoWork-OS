import * as fs from "fs";
import * as path from "path";
import {
  SearchProvider,
  SearchProviderConfig,
  SearchProviderType,
  SearchType,
  SearchQuery,
  SearchResponse,
  SEARCH_PROVIDER_INFO,
} from "./types";
import { TavilyProvider } from "./tavily-provider";
import { BraveProvider } from "./brave-provider";
import { SerpApiProvider } from "./serpapi-provider";
import { GoogleProvider } from "./google-provider";
import { DuckDuckGoProvider } from "./duckduckgo-provider";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import { getUserDataDir } from "../../utils/user-data-dir";

const LEGACY_SETTINGS_FILE = "search-settings.json";

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
  private static async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static isTransientSearchError(error: Any): boolean {
    const message = String(error?.message || "");
    return (
      /rate limit/i.test(message) ||
      /429/.test(message) ||
      /too many requests/i.test(message) ||
      /timeout/i.test(message) ||
      /ETIMEDOUT/i.test(message) ||
      /ECONNRESET/i.test(message) ||
      /EAI_AGAIN/i.test(message) ||
      /503/.test(message) ||
      /502/.test(message) ||
      /504/.test(message) ||
      /service unavailable/i.test(message)
    );
  }

  private static async searchWithRetry(
    provider: SearchProvider,
    query: SearchQuery,
    maxAttempts = 3,
  ): Promise<SearchResponse> {
    let lastError: Any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await provider.search(query);
      } catch (error: Any) {
        lastError = error;
        if (!this.isTransientSearchError(error) || attempt === maxAttempts) {
          throw error;
        }
        // Exponential backoff with jitter: ~1s, ~2s, ~4s
        const baseDelay = 1000 * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 500;
        await this.sleep(baseDelay + jitter);
      }
    }

    throw lastError || new Error("Search failed");
  }
  private static legacySettingsPath: string;
  private static cachedSettings: SearchSettings | null = null;
  private static migrationCompleted = false;

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
          "[SearchProviderFactory] SecureSettingsRepository not yet initialized, skipping migration",
        );
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      // Check if already migrated to database
      if (repository.exists("search")) {
        this.migrationCompleted = true;
        return;
      }

      // Check if legacy file exists
      if (!fs.existsSync(this.legacySettingsPath)) {
        console.log("[SearchProviderFactory] No legacy settings file found");
        this.migrationCompleted = true;
        return;
      }

      console.log(
        "[SearchProviderFactory] Migrating settings from legacy JSON file to encrypted database...",
      );

      // Create backup before migration
      const backupPath = this.legacySettingsPath + ".migration-backup";
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        // Read legacy settings
        const data = fs.readFileSync(this.legacySettingsPath, "utf-8");
        const parsed = JSON.parse(data);

        // Handle migration from old format (providerType -> primaryProvider)
        if (parsed.providerType && !parsed.primaryProvider) {
          parsed.primaryProvider = parsed.providerType;
          delete parsed.providerType;
        }

        const legacySettings = { ...DEFAULT_SETTINGS, ...parsed };

        // Save to encrypted database
        repository.save("search", legacySettings);
        console.log("[SearchProviderFactory] Settings migrated to encrypted database");

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log("[SearchProviderFactory] Migration complete, cleaned up legacy files");

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error("[SearchProviderFactory] Migration failed, backup preserved at:", backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error("[SearchProviderFactory] Migration failed:", error);
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
        const stored = repository.load<SearchSettings>("search");
        if (stored) {
          settings = { ...DEFAULT_SETTINGS, ...stored };
        }
      }
    } catch (error) {
      console.error("[SearchProviderFactory] Failed to load settings from database:", error);
    }

    // Auto-detect and select providers if primaryProvider is not set.
    // Only auto-select paid providers — DuckDuckGo is an implicit last-resort fallback.
    if (!settings.primaryProvider) {
      const orderedProviders = this.getProviderExecutionOrder(settings).filter(
        (p) => p !== "duckduckgo",
      );
      if (orderedProviders.length > 0) {
        settings.primaryProvider = orderedProviders[0];
        console.log(
          `[SearchProviderFactory] Auto-selected primary provider: ${orderedProviders[0]}`,
        );
        if (orderedProviders.length > 1 && !settings.fallbackProvider) {
          settings.fallbackProvider = orderedProviders[1];
          console.log(
            `[SearchProviderFactory] Auto-selected fallback provider: ${orderedProviders[1]}`,
          );
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
  private static getConfiguredProvidersFromSettings(
    settings: SearchSettings,
  ): SearchProviderType[] {
    const configured: SearchProviderType[] = [];

    // Check Tavily
    if (settings.tavily?.apiKey) {
      configured.push("tavily");
    }
    // Check Brave
    if (settings.brave?.apiKey) {
      configured.push("brave");
    }
    // Check SerpAPI
    if (settings.serpapi?.apiKey) {
      configured.push("serpapi");
    }
    // Check Google (requires both API key and Search Engine ID)
    if (settings.google?.apiKey && settings.google?.searchEngineId) {
      configured.push("google");
    }

    return configured;
  }

  /**
   * Save settings to encrypted database
   */
  static saveSettings(settings: SearchSettings): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error("SecureSettingsRepository not initialized");
      }

      const repository = SecureSettingsRepository.getInstance();

      // Load existing settings to preserve API keys that weren't changed
      let existingSettings: SearchSettings = { ...DEFAULT_SETTINGS };
      const stored = repository.load<SearchSettings>("search");
      if (stored) {
        existingSettings = stored;
      }

      // Merge settings, preserving existing API keys if new ones aren't provided
      const settingsToSave: SearchSettings = {
        primaryProvider: settings.primaryProvider,
        fallbackProvider: settings.fallbackProvider,
        tavily: settings.tavily?.apiKey ? settings.tavily : existingSettings.tavily,
        brave: settings.brave?.apiKey ? settings.brave : existingSettings.brave,
        serpapi: settings.serpapi?.apiKey ? settings.serpapi : existingSettings.serpapi,
        google:
          settings.google?.apiKey || settings.google?.searchEngineId
            ? { ...existingSettings.google, ...settings.google }
            : existingSettings.google,
      };

      // Save to encrypted database
      repository.save("search", settingsToSave);
      this.cachedSettings = settingsToSave;

      console.log("[SearchProviderFactory] Settings saved to encrypted database");
    } catch (error) {
      console.error("[SearchProviderFactory] Failed to save settings:", error);
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
      throw new Error("No search provider configured");
    }

    const config = this.getProviderConfig(providerType);
    return this.createProviderFromConfig(config);
  }

  /**
   * Create provider from explicit config
   */
  static createProviderFromConfig(config: SearchProviderConfig): SearchProvider {
    switch (config.type) {
      case "tavily":
        return new TavilyProvider(config);
      case "brave":
        return new BraveProvider(config);
      case "serpapi":
        return new SerpApiProvider(config);
      case "google":
        return new GoogleProvider(config);
      case "duckduckgo":
        return new DuckDuckGoProvider(config);
      default:
        throw new Error(`Unknown search provider type: ${config.type}`);
    }
  }

  /**
   * Execute a search with automatic fallback on failure
   */
  static async searchWithFallback(query: SearchQuery): Promise<SearchResponse> {
    const settings = this.loadSettings();

    // If a specific provider was requested, use it directly
    if (query.provider) {
      const providerConfig = this.getProviderConfig(query.provider);
      const provider = this.createProviderFromConfig(providerConfig);
      return await this.searchWithRetry(provider, query);
    }

    // getProviderExecutionOrder always includes DuckDuckGo as a last-resort fallback
    const providersToTry = this.getProviderExecutionOrder(settings);
    if (!providersToTry.length) {
      throw new Error("No search provider available");
    }

    const providerErrors: Array<{ provider: SearchProviderType; error: string }> = [];

    for (let i = 0; i < providersToTry.length; i++) {
      const providerType = providersToTry[i];

      try {
        const providerConfig = this.getProviderConfig(providerType);
        const provider = this.createProviderFromConfig(providerConfig);
        return await this.searchWithRetry(provider, query);
      } catch (error: Any) {
        const message = error?.message || "Search provider request failed";
        providerErrors.push({ provider: providerType, error: message });
        console.error(`Search provider (${providerType}) failed:`, message);

        const nextProvider = providersToTry[i + 1];
        if (nextProvider) {
          console.log(`Attempting fallback to ${nextProvider}...`);
        }
      }
    }

    if (providerErrors.length === 1) {
      throw new Error(providerErrors[0].error);
    }

    throw new Error(
      `Search failed after trying all configured providers: ${providerErrors
        .map((entry) => `${entry.provider}: ${entry.error}`)
        .join("; ")}`,
    );
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
        type: "tavily",
        name: SEARCH_PROVIDER_INFO.tavily.displayName,
        description: SEARCH_PROVIDER_INFO.tavily.description,
        configured: !!settings.tavily?.apiKey,
        supportedTypes: [...SEARCH_PROVIDER_INFO.tavily.supportedTypes],
      },
      {
        type: "brave",
        name: SEARCH_PROVIDER_INFO.brave.displayName,
        description: SEARCH_PROVIDER_INFO.brave.description,
        configured: !!settings.brave?.apiKey,
        supportedTypes: [...SEARCH_PROVIDER_INFO.brave.supportedTypes],
      },
      {
        type: "serpapi",
        name: SEARCH_PROVIDER_INFO.serpapi.displayName,
        description: SEARCH_PROVIDER_INFO.serpapi.description,
        configured: !!settings.serpapi?.apiKey,
        supportedTypes: [...SEARCH_PROVIDER_INFO.serpapi.supportedTypes],
      },
      {
        type: "google",
        name: SEARCH_PROVIDER_INFO.google.displayName,
        description: SEARCH_PROVIDER_INFO.google.description,
        configured: !!(settings.google?.apiKey && settings.google?.searchEngineId),
        supportedTypes: [...SEARCH_PROVIDER_INFO.google.supportedTypes],
      },
      {
        type: "duckduckgo",
        name: SEARCH_PROVIDER_INFO.duckduckgo.displayName,
        description: SEARCH_PROVIDER_INFO.duckduckgo.description,
        configured: true, // Always available, no API key needed
        supportedTypes: [...SEARCH_PROVIDER_INFO.duckduckgo.supportedTypes],
      },
    ];
  }

  /**
   * Check if any paid search provider is configured (excludes free DuckDuckGo fallback).
   */
  static isAnyProviderConfigured(): boolean {
    return this.getAvailableProviders().some((p) => p.configured && p.type !== "duckduckgo");
  }

  /**
   * Build the provider execution order for automatic search fallback.
   * - If Brave is configured and multiple providers are available, prefer Brave first.
   * - Then preserve explicit primary/fallback ordering when available.
   * - Fill remaining providers from the detected configured list.
   * - DuckDuckGo is always appended as the last-resort fallback.
   */
  private static getProviderExecutionOrder(settings: SearchSettings): SearchProviderType[] {
    const configuredProviders = this.getConfiguredProvidersFromSettings(settings);

    // No paid providers configured — DuckDuckGo is the only option
    if (configuredProviders.length === 0) {
      return ["duckduckgo"];
    }

    if (configuredProviders.length === 1) {
      return [...configuredProviders, "duckduckgo"];
    }

    const orderedProviders: SearchProviderType[] = [];
    const addProviderIfConfigured = (provider?: SearchProviderType | null) => {
      if (
        provider &&
        configuredProviders.includes(provider) &&
        !orderedProviders.includes(provider)
      ) {
        orderedProviders.push(provider);
      }
    };

    // Respect explicit primary/fallback preference where available.
    addProviderIfConfigured(settings.primaryProvider);
    addProviderIfConfigured(settings.fallbackProvider);

    // Fill in any remaining configured providers.
    for (const provider of configuredProviders) {
      addProviderIfConfigured(provider);
    }

    // Prefer Brave when available and multiple providers are configured.
    if (orderedProviders.length > 1 && orderedProviders.includes("brave")) {
      return [
        "brave",
        ...orderedProviders.filter((provider) => provider !== "brave"),
        "duckduckgo",
      ];
    }

    return [...orderedProviders, "duckduckgo"];
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
    providerType: SearchProviderType,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const config = this.getProviderConfig(providerType);
      const provider = this.createProviderFromConfig(config);
      return await provider.testConnection();
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to create provider",
      };
    }
  }
}
