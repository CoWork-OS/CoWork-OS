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
import { LOCAL_MANAGED_DEVICE_ID } from "../../shared/types";
import type {
  ControlPlaneConnectionMode,
  ManagedDevice,
  ManagedDeviceTransport,
  RemoteGatewayConfig,
  SavedRemoteGatewayDevice,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";
import { getSafeStorage } from "../utils/safe-storage";
import { createLogger } from "../utils/logger";

const LEGACY_SETTINGS_FILE = "control-plane-settings.json";
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
  /** Node authentication token for read-scoped companion clients */
  nodeToken: string;
  /** Handshake timeout in milliseconds */
  handshakeTimeoutMs: number;
  /** Heartbeat interval in milliseconds */
  heartbeatIntervalMs: number;
  /** Maximum payload size in bytes */
  maxPayloadBytes: number;
  /** Trust reverse proxy headers such as X-Forwarded-For */
  trustProxy: boolean;
  /** Explicit browser origins allowed to open Control Plane WebSocket connections */
  allowedOrigins: string[];
  /** Tailscale exposure settings */
  tailscale: {
    mode: TailscaleMode;
    resetOnExit: boolean;
  };
  /** Connection mode: 'local' to host server, 'remote' to connect to external gateway */
  connectionMode: ControlPlaneConnectionMode;
  /** Remote gateway configuration (used when connectionMode is 'remote') */
  remote?: RemoteGatewayConfig;
  /** Saved remote devices shown in the Devices UI */
  savedRemoteDevices?: SavedRemoteGatewayDevice[];
  /** Saved remote device currently mapped to the active remote config */
  activeRemoteDeviceId?: string;
  /** Managed fleet devices shown in the Devices UI */
  managedDevices?: ManagedDevice[];
  /** Selected managed device for legacy remote actions */
  activeManagedDeviceId?: string;
}

/**
 * Default control plane settings
 */
export const DEFAULT_CONTROL_PLANE_SETTINGS: ControlPlaneSettings = {
  enabled: false,
  port: 18789,
  host: "127.0.0.1",
  token: "",
  nodeToken: "",
  handshakeTimeoutMs: 10000,
  heartbeatIntervalMs: 30000,
  maxPayloadBytes: 10 * 1024 * 1024, // 10MB
  trustProxy: false,
  allowedOrigins: [],
  tailscale: {
    mode: "off",
    resetOnExit: true,
  },
  connectionMode: "local",
  remote: undefined,
  savedRemoteDevices: [],
  activeRemoteDeviceId: undefined,
  managedDevices: [],
  activeManagedDeviceId: LOCAL_MANAGED_DEVICE_ID,
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

function inferTransport(config: RemoteGatewayConfig): ManagedDeviceTransport {
  if (config.sshTunnel?.enabled) return "ssh";
  try {
    const url = new URL(config.url);
    if (url.hostname.endsWith(".ts.net")) return "tailscale";
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return config.sshTunnel?.enabled ? "ssh" : "direct";
    }
    return "direct";
  } catch {
    return "unknown";
  }
}

function toManagedDevice(device: SavedRemoteGatewayDevice): ManagedDevice {
  return {
    id: device.id,
    name: device.name || device.config.deviceName || "Remote Device",
    role: "remote",
    purpose: "general",
    transport: inferTransport(device.config),
    status: "disconnected",
    platform: "linux",
    clientId: device.clientId,
    connectedAt: device.connectedAt,
    lastSeenAt: device.lastActivityAt || device.connectedAt,
    taskNodeId: `remote-gateway:${device.id}`,
    config: {
      ...DEFAULT_REMOTE_GATEWAY_CONFIG,
      ...device.config,
    },
    autoConnect: device.autoConnect === true,
    tags: [],
    activeRunCount: 0,
    attentionState: "none",
    storageSummary: {
      workspaceCount: 0,
      artifactCount: 0,
    },
    appsSummary: {
      channelsTotal: 0,
      channelsEnabled: 0,
      workspacesTotal: 0,
      approvalsPending: 0,
      inputRequestsPending: 0,
    },
  };
}

/**
 * Generate a secure random token
 */
export function generateControlPlaneToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Decrypt a secret that was encrypted with safeStorage
 */
function decryptSecret(value?: string): string | undefined {
  if (!value) return undefined;

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
  if (!value.startsWith(ENCRYPTED_PREFIX)) {
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
        merged.nodeToken = decryptSecret(merged.nodeToken) || "";
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
          if (merged.token && !merged.nodeToken) {
            merged.nodeToken = generateControlPlaneToken();
            repository.save("controlplane", merged);
          }
          if (stored.remote) {
            merged.remote = {
              ...DEFAULT_REMOTE_GATEWAY_CONFIG,
              ...stored.remote,
            };
          }
          merged.allowedOrigins = Array.isArray(stored.allowedOrigins)
            ? stored.allowedOrigins.filter((origin): origin is string => typeof origin === "string")
            : [];
          merged.savedRemoteDevices = Array.isArray(stored.savedRemoteDevices)
            ? stored.savedRemoteDevices.map((device) => ({
                ...device,
                config: {
                  ...DEFAULT_REMOTE_GATEWAY_CONFIG,
                  ...device.config,
                },
              }))
            : [];
          merged.managedDevices = Array.isArray(stored.managedDevices)
            ? stored.managedDevices.map((device) => ({
                ...device,
                config: device.config
                  ? {
                      ...DEFAULT_REMOTE_GATEWAY_CONFIG,
                      ...device.config,
                    }
                  : undefined,
              }))
            : merged.savedRemoteDevices.map((device) => toManagedDevice(device));
          merged.activeManagedDeviceId =
            stored.activeManagedDeviceId ||
            stored.activeRemoteDeviceId ||
            merged.managedDevices[0]?.id ||
            LOCAL_MANAGED_DEVICE_ID;
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

    const updated = {
      ...settings,
      ...updates,
      tailscale,
      remote,
      savedRemoteDevices: updates.savedRemoteDevices ?? settings.savedRemoteDevices ?? [],
      managedDevices:
        updates.managedDevices ??
        settings.managedDevices ??
        (updates.savedRemoteDevices ?? settings.savedRemoteDevices ?? []).map((device) =>
          toManagedDevice(device),
        ),
      activeManagedDeviceId:
        updates.activeManagedDeviceId ?? settings.activeManagedDeviceId ?? LOCAL_MANAGED_DEVICE_ID,
    };
    if (updated.token && !updated.nodeToken) {
      updated.nodeToken = generateControlPlaneToken();
    }
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
    if (!settings.nodeToken) {
      settings.nodeToken = generateControlPlaneToken();
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
    settings.nodeToken = generateControlPlaneToken();
    this.saveSettings(settings);
    return settings.token;
  }

  /**
   * Get settings for display
   */
  static getSettingsForDisplay(): ControlPlaneSettings {
    return this.loadSettings();
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
