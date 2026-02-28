/**
 * MCP Settings Manager
 *
 * Manages MCP server configurations with encrypted storage.
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import * as fs from "fs";
import * as path from "path";
import { MCPSettings, MCPServerConfig, MCPAuthConfig, DEFAULT_MCP_SETTINGS } from "./types";
import { v4 as uuidv4 } from "uuid";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";
import { getSafeStorage } from "../utils/safe-storage";
import { createLogger } from "../utils/logger";

const LEGACY_SETTINGS_FILE = "mcp-settings.json";
const MASKED_VALUE = "***configured***";
const ENCRYPTED_PREFIX = "encrypted:";
const CONNECTOR_SCRIPT_PATH_REGEX = /(?:^|[\\/])connectors[\\/]([^\\/]+)[\\/]dist[\\/]index\.js$/;
const logger = createLogger("MCP Settings");

function getElectronApp(): Any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const app = electron?.app;
    if (app && typeof app === "object") return app;
  } catch {
    // Not running under Electron.
  }
  return null;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function getConnectorScriptPathForCurrentRuntime(connectorName: string): string {
  const electronApp = getElectronApp();
  const isPackaged =
    Boolean(electronApp?.isPackaged) && typeof (process as Any).resourcesPath === "string";
  const baseDir = isPackaged
    ? path.join((process as Any).resourcesPath, "connectors")
    : path.join(process.cwd(), "connectors");
  return path.join(baseDir, connectorName, "dist", "index.js");
}

/**
 * Normalize local connector runtime settings.
 * This fixes stale configs that point to a development Electron binary
 * (node_modules/electron) which can surface extra Electron dock icons on macOS.
 */
function normalizeConnectorRuntime(server: MCPServerConfig): {
  server: MCPServerConfig;
  changed: boolean;
} {
  if (server.transport !== "stdio" || !server.args || !server.command) {
    return { server, changed: false };
  }

  const runAsNodeIndex = server.args.indexOf("--runAsNode");
  if (runAsNodeIndex === -1 || runAsNodeIndex >= server.args.length - 1) {
    return { server, changed: false };
  }

  const scriptArg = server.args[runAsNodeIndex + 1];
  const match = scriptArg.match(CONNECTOR_SCRIPT_PATH_REGEX);
  if (!match) {
    return { server, changed: false };
  }

  const connectorName = match[1];
  const expectedScriptPath = getConnectorScriptPathForCurrentRuntime(connectorName);
  const expectedArgs = [...server.args];
  expectedArgs[runAsNodeIndex + 1] = expectedScriptPath;
  const expectedCommand = process.execPath;

  if (server.command === expectedCommand && arraysEqual(server.args, expectedArgs)) {
    return { server, changed: false };
  }

  return {
    server: {
      ...server,
      command: expectedCommand,
      args: expectedArgs,
    },
    changed: true,
  };
}

/**
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
      return ENCRYPTED_PREFIX + encrypted.toString("base64");
    }
  } catch (error) {
    logger.warn("Failed to encrypt secret, storing masked:", error);
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
      const safeStorage = getSafeStorage();
      if (safeStorage?.isEncryptionAvailable()) {
        const encrypted = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), "base64");
        const decrypted = safeStorage.decryptString(encrypted);
        return decrypted;
      } else {
        logger.error("safeStorage encryption not available - cannot decrypt secrets");
      }
    } catch (error: Any) {
      logger.error("Failed to decrypt secret - this can happen after app updates");
      logger.error("Error:", error.message || error);
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
function _encryptSettings(settings: MCPSettings): MCPSettings {
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
  private static legacySettingsPath: string;
  private static cachedSettings: MCPSettings | null = null;
  private static initialized = false;
  private static migrationCompleted = false;
  private static batchMode = false; // When true, defer saves until batch mode ends
  private static pendingSave = false;

  /**
   * Initialize the settings manager (must be called after app is ready)
   */
  static initialize(): void {
    if (this.initialized) return;

    const userDataPath = getUserDataDir();
    this.legacySettingsPath = path.join(userDataPath, LEGACY_SETTINGS_FILE);
    this.initialized = true;

    logger.debug("Initialized");

    // Migrate from legacy JSON file to encrypted database
    this.migrateFromLegacyFile();
  }

  /**
   * Migrate settings from legacy JSON file to encrypted database
   */
  private static migrateFromLegacyFile(): void {
    if (this.migrationCompleted) return;

    try {
      if (!SecureSettingsRepository.isInitialized()) {
        logger.debug("SecureSettingsRepository not yet initialized, skipping migration");
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      if (repository.exists("mcp")) {
        this.migrationCompleted = true;
        return;
      }

      if (!fs.existsSync(this.legacySettingsPath)) {
        logger.debug("No legacy settings file found");
        this.migrationCompleted = true;
        return;
      }

      logger.debug("Migrating settings from legacy JSON file to encrypted database...");

      // Create backup before migration
      const backupPath = this.legacySettingsPath + ".migration-backup";
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        const data = fs.readFileSync(this.legacySettingsPath, "utf-8");
        const parsed = JSON.parse(data);

        const merged = {
          ...DEFAULT_MCP_SETTINGS,
          ...parsed,
          servers: parsed.servers || [],
        };

        // Decrypt any existing encrypted values before saving to the new encrypted database
        const decrypted = decryptSettings(merged);

        repository.save("mcp", decrypted);
        logger.debug("Settings migrated to encrypted database");

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        logger.debug("Migration complete, cleaned up legacy files");

        this.migrationCompleted = true;
      } catch (migrationError) {
        logger.error("Migration failed, backup preserved at:", backupPath);
        throw migrationError;
      }
    } catch (error) {
      logger.error("Migration failed:", error);
    }
  }

  /**
   * Load settings from encrypted database
   */
  static loadSettings(): MCPSettings {
    this.ensureInitialized();

    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<MCPSettings>("mcp");
        if (stored) {
          const merged = {
            ...DEFAULT_MCP_SETTINGS,
            ...stored,
            servers: stored.servers || [],
          };
          let normalizedChanged = false;
          const normalizedServers = merged.servers.map((server) => {
            const normalized = normalizeConnectorRuntime(server);
            if (normalized.changed) {
              normalizedChanged = true;
            }
            return normalized.server;
          });

          this.cachedSettings = {
            ...merged,
            servers: normalizedServers,
          };

          if (normalizedChanged) {
            logger.debug("Normalized local connector runtime paths");
            this.saveSettings(this.cachedSettings);
          }

          logger.debug(`Loaded ${this.cachedSettings.servers.length} server(s) from encrypted database`);
          return this.cachedSettings;
        }
      }
    } catch (error) {
      logger.error("Failed to load settings:", error);
    }

    logger.debug("No settings found, using defaults");
    this.cachedSettings = { ...DEFAULT_MCP_SETTINGS };
    return this.cachedSettings;
  }

  /**
   * Save settings to encrypted database
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
   * Immediately save settings to database (bypasses batch mode)
   */
  private static saveSettingsImmediate(settings: MCPSettings): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error("SecureSettingsRepository not initialized");
      }

      const repository = SecureSettingsRepository.getInstance();
      repository.save("mcp", settings);
      logger.debug(`Saved ${settings.servers.length} server(s) to encrypted database`);
    } catch (error) {
      logger.error("Failed to save settings:", error);
      throw error;
    }
  }

  /**
   * Enter batch mode - defers all saves until endBatch is called
   * Use this during initialization to avoid redundant database writes
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
  static addServer(config: Omit<MCPServerConfig, "id">): MCPServerConfig {
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
      logger.warn(`Server not found: ${id}`);
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
      logger.debug(`Removed server: ${id}`);
      return true;
    }

    logger.warn(`Server not found for removal: ${id}`);
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
  static updateServerTools(id: string, tools: MCPServerConfig["tools"]): void {
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
