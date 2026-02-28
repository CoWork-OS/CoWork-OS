/**
 * Control Plane Settings Manager
 *
 * Manages WebSocket control plane configuration with encrypted storage.
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import * as fs from "fs";
import * as path from "path";
import crypto from "crypto";
import type { TailscaleMode } from "../tailscale/settings";
import type { ControlPlaneConnectionMode, RemoteGatewayConfig } from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";
import { getSafeStorage } from "../utils/safe-storage";
import { createLogger } from "../utils/logger";

const LEGACY_SETTINGS_FILE = "control-plane-settings.json";
const MASKED_VALUE = "***configured***";
const ENCRYPTED_PREFIX = "encrypted:";
const logger = createLogger("ControlPlane Settings");

/**
 * Control plane settings interface
 */
export interface ControlPlaneSettings {
  /** Whether the control plane is enabled */
  enabled: boolean;
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: 127.0.0.1) */
  host: string;
  /** Authentication token */
  token: string;
  /** Handshake timeout in milliseconds */
  handshakeTimeoutMs: number;
  /** Heartbeat interval in milliseconds */
  heartbeatIntervalMs: number;
  /** Maximum payload size in bytes */
  maxPayloadBytes: number;
  /** Tailscale exposure settings */
  tailscale: {
    mode: TailscaleMode;
    resetOnExit: boolean;
  };
  /** Connection mode: 'local' to host server, 'remote' to connect to external gateway */
  connectionMode: ControlPlaneConnectionMode;
  /** Remote gateway configuration (used when connectionMode is 'remote') */
  remote?: RemoteGatewayConfig;
}

/**
 * Default control plane settings
 */
export const DEFAULT_CONTROL_PLANE_SETTINGS: ControlPlaneSettings = {
  enabled: false,
  port: 18789,
  host: "127.0.0.1",
  token: "",
  handshakeTimeoutMs: 10000,
  heartbeatIntervalMs: 30000,
  maxPayloadBytes: 10 * 1024 * 1024, // 10MB
  tailscale: {
    mode: "off",
    resetOnExit: true,
  },
  connectionMode: "local",
  remote: undefined,
};

/**
 * Default remote gateway configuration
 */
export const DEFAULT_REMOTE_GATEWAY_CONFIG: RemoteGatewayConfig = {
  url: "ws://127.0.0.1:18789",
  token: "",
  deviceName: "CoWork Remote Client",
  autoReconnect: true,
  reconnectIntervalMs: 5000,
  maxReconnectAttempts: 10,
};

/**
 * Generate a secure random token
 */
export function generateControlPlaneToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
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
    logger.warn("Failed to encrypt secret:", error);
  }
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
        return safeStorage.decryptString(encrypted);
      }
    } catch (error: Any) {
      logger.error("Failed to decrypt:", error.message || error);
    }
  }

  // Backwards compatibility - unencrypted value
  if (value !== MASKED_VALUE && !value.startsWith(ENCRYPTED_PREFIX)) {
    return value.trim() || undefined;
  }

  return undefined;
}

/**
 * Control Plane Settings Manager
 */
export class ControlPlaneSettingsManager {
  private static legacySettingsPath: string;
  private static cachedSettings: ControlPlaneSettings | null = null;
  private static initialized = false;
  private static migrationCompleted = false;

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

      if (repository.exists("controlplane")) {
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

        const merged: ControlPlaneSettings = {
          ...DEFAULT_CONTROL_PLANE_SETTINGS,
          ...parsed,
          tailscale: {
            ...DEFAULT_CONTROL_PLANE_SETTINGS.tailscale,
            ...parsed.tailscale,
          },
        };

        // Decrypt any existing encrypted values
        merged.token = decryptSecret(merged.token) || "";
        if (parsed.remote) {
          merged.remote = {
            ...DEFAULT_REMOTE_GATEWAY_CONFIG,
            ...parsed.remote,
            token: decryptSecret(parsed.remote.token) || "",
          };
        }

        repository.save("controlplane", merged);
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
   * Ensure the manager is initialized
   */
  private static ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }

  /**
   * Load settings from encrypted database
   */
  static loadSettings(): ControlPlaneSettings {
    this.ensureInitialized();

    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<ControlPlaneSettings>("controlplane");
        if (stored) {
          const merged: ControlPlaneSettings = {
            ...DEFAULT_CONTROL_PLANE_SETTINGS,
            ...stored,
            tailscale: {
              ...DEFAULT_CONTROL_PLANE_SETTINGS.tailscale,
              ...stored.tailscale,
            },
          };
          if (stored.remote) {
            merged.remote = {
              ...DEFAULT_REMOTE_GATEWAY_CONFIG,
              ...stored.remote,
            };
          }
          this.cachedSettings = merged;
          logger.debug("Loaded settings from encrypted database");
          return this.cachedSettings;
        }
      }
    } catch (error) {
      logger.error("Failed to load:", error);
    }

    logger.debug("No settings found, using defaults");
    this.cachedSettings = { ...DEFAULT_CONTROL_PLANE_SETTINGS };
    return this.cachedSettings;
  }

  /**
   * Save settings to encrypted database
   */
  static saveSettings(settings: ControlPlaneSettings): void {
    this.ensureInitialized();

    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error("SecureSettingsRepository not initialized");
      }

      const repository = SecureSettingsRepository.getInstance();
      repository.save("controlplane", settings);
      this.cachedSettings = settings;
      logger.debug("Saved settings to encrypted database");
    } catch (error) {
      logger.error("Failed to save:", error);
      throw error;
    }
  }

  /**
   * Update settings partially
   */
  static updateSettings(updates: Partial<ControlPlaneSettings>): ControlPlaneSettings {
    const settings = this.loadSettings();

    // Handle nested tailscale updates
    const tailscale = updates.tailscale
      ? { ...settings.tailscale, ...updates.tailscale }
      : settings.tailscale;

    // Handle nested remote config updates
    const remote = updates.remote
      ? { ...DEFAULT_REMOTE_GATEWAY_CONFIG, ...settings.remote, ...updates.remote }
      : settings.remote;

    const updated = { ...settings, ...updates, tailscale, remote };
    this.saveSettings(updated);
    return updated;
  }

  /**
   * Enable the control plane with a new token if not set
   */
  static enable(): ControlPlaneSettings {
    const settings = this.loadSettings();
    if (!settings.token) {
      settings.token = generateControlPlaneToken();
    }
    settings.enabled = true;
    this.saveSettings(settings);
    return settings;
  }

  /**
   * Disable the control plane
   */
  static disable(): ControlPlaneSettings {
    const settings = this.loadSettings();
    settings.enabled = false;
    this.saveSettings(settings);
    return settings;
  }

  /**
   * Regenerate the authentication token
   */
  static regenerateToken(): string {
    const settings = this.loadSettings();
    settings.token = generateControlPlaneToken();
    this.saveSettings(settings);
    return settings.token;
  }

  /**
   * Get settings for display (masks sensitive data)
   */
  static getSettingsForDisplay(): ControlPlaneSettings {
    const settings = this.loadSettings();
    const displaySettings: ControlPlaneSettings = {
      ...settings,
      token: settings.token ? MASKED_VALUE : "",
    };

    // Mask remote token if present
    if (settings.remote) {
      displaySettings.remote = {
        ...settings.remote,
        token: settings.remote.token ? MASKED_VALUE : "",
      };
    }

    return displaySettings;
  }

  /**
   * Check if properly configured
   */
  static isConfigured(): boolean {
    const settings = this.loadSettings();
    return settings.enabled && !!settings.token;
  }

  /**
   * Clear the settings cache
   */
  static clearCache(): void {
    this.cachedSettings = null;
  }

  /**
   * Get default settings
   */
  static getDefaults(): ControlPlaneSettings {
    return { ...DEFAULT_CONTROL_PLANE_SETTINGS };
  }
}
