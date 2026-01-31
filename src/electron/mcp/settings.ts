/**
 * MCP Settings Manager
 *
 * Manages MCP server configurations with encrypted credential storage.
 * Follows the same pattern as LLMProviderFactory for settings management.
 */

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  MCPSettings,
  MCPServerConfig,
  MCPAuthConfig,
  DEFAULT_MCP_SETTINGS,
} from './types';
import { v4 as uuidv4 } from 'uuid';

const SETTINGS_FILE = 'mcp-settings.json';
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
    console.warn('[MCP Settings] Failed to encrypt secret, storing masked:', error);
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
        const decrypted = safeStorage.decryptString(encrypted);
        return decrypted;
      } else {
        console.error('[MCP Settings] safeStorage encryption not available - cannot decrypt secrets');
      }
    } catch (error: any) {
      console.error('[MCP Settings] Failed to decrypt secret - this can happen after app updates');
      console.error('[MCP Settings] Error:', error.message || error);
    }
  }

  // If not encrypted and not masked, return as-is (for backwards compatibility)
  if (value !== MASKED_VALUE && !value.startsWith(ENCRYPTED_PREFIX)) {
    return value.trim() || undefined;
  }

  return undefined;
}

/**
 * Encrypt auth credentials in a server config
 */
function encryptServerAuth(auth?: MCPAuthConfig): MCPAuthConfig | undefined {
  if (!auth) return undefined;

  return {
    ...auth,
    token: encryptSecret(auth.token),
    apiKey: encryptSecret(auth.apiKey),
    password: encryptSecret(auth.password),
  };
}

/**
 * Decrypt auth credentials in a server config
 */
function decryptServerAuth(auth?: MCPAuthConfig): MCPAuthConfig | undefined {
  if (!auth) return undefined;

  return {
    ...auth,
    token: decryptSecret(auth.token),
    apiKey: decryptSecret(auth.apiKey),
    password: decryptSecret(auth.password),
  };
}

/**
 * Encrypt all credentials in settings before saving to disk
 */
function encryptSettings(settings: MCPSettings): MCPSettings {
  return {
    ...settings,
    servers: settings.servers.map((server) => ({
      ...server,
      auth: encryptServerAuth(server.auth),
    })),
  };
}

/**
 * Decrypt all credentials in settings after loading from disk
 */
function decryptSettings(settings: MCPSettings): MCPSettings {
  return {
    ...settings,
    servers: settings.servers.map((server) => ({
      ...server,
      auth: decryptServerAuth(server.auth),
    })),
  };
}

/**
 * MCP Settings Manager
 */
export class MCPSettingsManager {
  private static settingsPath: string;
  private static cachedSettings: MCPSettings | null = null;
  private static initialized = false;
  private static batchMode = false; // When true, defer saves until batch mode ends
  private static pendingSave = false;

  /**
   * Initialize the settings manager (must be called after app is ready)
   */
  static initialize(): void {
    if (this.initialized) return;

    const userDataPath = app.getPath('userData');
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE);
    this.initialized = true;

    console.log('[MCP Settings] Initialized with path:', this.settingsPath);
  }

  /**
   * Load settings from disk
   */
  static loadSettings(): MCPSettings {
    this.ensureInitialized();

    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        const parsed = JSON.parse(data);

        // Merge with defaults to handle missing fields from older versions
        const merged = {
          ...DEFAULT_MCP_SETTINGS,
          ...parsed,
          // Ensure servers array exists
          servers: parsed.servers || [],
        };

        // Decrypt credentials
        this.cachedSettings = decryptSettings(merged);
        console.log(`[MCP Settings] Loaded ${this.cachedSettings.servers.length} server(s)`);
      } else {
        console.log('[MCP Settings] No settings file found, using defaults');
        this.cachedSettings = { ...DEFAULT_MCP_SETTINGS };
      }
    } catch (error) {
      console.error('[MCP Settings] Failed to load settings:', error);
      this.cachedSettings = { ...DEFAULT_MCP_SETTINGS };
    }

    return this.cachedSettings;
  }

  /**
   * Save settings to disk
   */
  static saveSettings(settings: MCPSettings): void {
    this.ensureInitialized();

    // Update cache immediately
    this.cachedSettings = settings;

    // If in batch mode, mark as pending and defer the actual save
    if (this.batchMode) {
      this.pendingSave = true;
      return;
    }

    this.saveSettingsImmediate(settings);
  }

  /**
   * Immediately save settings to disk (bypasses batch mode)
   */
  private static saveSettingsImmediate(settings: MCPSettings): void {
    try {
      // Encrypt credentials before saving
      const encrypted = encryptSettings(settings);
      fs.writeFileSync(this.settingsPath, JSON.stringify(encrypted, null, 2));
      console.log(`[MCP Settings] Saved ${settings.servers.length} server(s)`);
    } catch (error) {
      console.error('[MCP Settings] Failed to save settings:', error);
      throw error;
    }
  }

  /**
   * Enter batch mode - defers all saves until endBatch is called
   * Use this during initialization to avoid redundant disk writes
   */
  static beginBatch(): void {
    this.batchMode = true;
    this.pendingSave = false;
  }

  /**
   * Exit batch mode and save if there were any pending changes
   */
  static endBatch(): void {
    this.batchMode = false;
    if (this.pendingSave && this.cachedSettings) {
      this.saveSettingsImmediate(this.cachedSettings);
      this.pendingSave = false;
    }
  }

  /**
   * Clear the settings cache (forces reload on next access)
   */
  static clearCache(): void {
    this.cachedSettings = null;
  }

  /**
   * Get default settings
   */
  static getDefaults(): MCPSettings {
    return { ...DEFAULT_MCP_SETTINGS };
  }

  /**
   * Add a new server configuration
   */
  static addServer(config: Omit<MCPServerConfig, 'id'>): MCPServerConfig {
    const settings = this.loadSettings();
    const newServer: MCPServerConfig = {
      ...config,
      id: uuidv4(),
      installedAt: Date.now(),
    };

    settings.servers.push(newServer);
    this.saveSettings(settings);

    return newServer;
  }

  /**
   * Update an existing server configuration
   */
  static updateServer(id: string, updates: Partial<MCPServerConfig>): MCPServerConfig | null {
    const settings = this.loadSettings();
    const index = settings.servers.findIndex((s) => s.id === id);

    if (index === -1) {
      console.warn(`[MCP Settings] Server not found: ${id}`);
      return null;
    }

    // Don't allow changing the ID
    const { id: _ignoredId, ...validUpdates } = updates;

    settings.servers[index] = {
      ...settings.servers[index],
      ...validUpdates,
    };

    this.saveSettings(settings);
    return settings.servers[index];
  }

  /**
   * Remove a server configuration
   */
  static removeServer(id: string): boolean {
    const settings = this.loadSettings();
    const initialLength = settings.servers.length;
    settings.servers = settings.servers.filter((s) => s.id !== id);

    if (settings.servers.length < initialLength) {
      this.saveSettings(settings);
      console.log(`[MCP Settings] Removed server: ${id}`);
      return true;
    }

    console.warn(`[MCP Settings] Server not found for removal: ${id}`);
    return false;
  }

  /**
   * Toggle a server's enabled state
   */
  static toggleServer(id: string, enabled: boolean): MCPServerConfig | null {
    return this.updateServer(id, { enabled });
  }

  /**
   * Get a specific server by ID
   */
  static getServer(id: string): MCPServerConfig | undefined {
    const settings = this.loadSettings();
    return settings.servers.find((s) => s.id === id);
  }

  /**
   * Get all enabled servers
   */
  static getEnabledServers(): MCPServerConfig[] {
    const settings = this.loadSettings();
    return settings.servers.filter((s) => s.enabled);
  }

  /**
   * Check if any servers are configured
   */
  static hasServers(): boolean {
    const settings = this.loadSettings();
    return settings.servers.length > 0;
  }

  /**
   * Update the tools cache for a server
   */
  static updateServerTools(id: string, tools: MCPServerConfig['tools']): void {
    const settings = this.loadSettings();
    const server = settings.servers.find((s) => s.id === id);

    if (server) {
      server.tools = tools;
      server.lastConnectedAt = Date.now();
      this.saveSettings(settings);
    }
  }

  /**
   * Update server error state
   */
  static updateServerError(id: string, error: string | undefined): void {
    const settings = this.loadSettings();
    const server = settings.servers.find((s) => s.id === id);

    if (server) {
      server.lastError = error;
      this.saveSettings(settings);
    }
  }

  /**
   * Get settings for UI display (masks sensitive data)
   */
  static getSettingsForDisplay(): MCPSettings {
    const settings = this.loadSettings();

    return {
      ...settings,
      servers: settings.servers.map((server) => ({
        ...server,
        auth: server.auth
          ? {
              ...server.auth,
              token: server.auth.token ? MASKED_VALUE : undefined,
              apiKey: server.auth.apiKey ? MASKED_VALUE : undefined,
              password: server.auth.password ? MASKED_VALUE : undefined,
            }
          : undefined,
      })),
    };
  }

  /**
   * Ensure the manager is initialized
   */
  private static ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }
}
