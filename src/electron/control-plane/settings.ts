/**
 * Control Plane Settings Manager
 *
 * Manages WebSocket control plane configuration with secure token storage.
 */

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import type { TailscaleMode } from '../tailscale/settings';
import type {
  ControlPlaneConnectionMode,
  RemoteGatewayConfig,
} from '../../shared/types';

const SETTINGS_FILE = 'control-plane-settings.json';
const MASKED_VALUE = '***configured***';
const ENCRYPTED_PREFIX = 'encrypted:';

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
  host: '127.0.0.1',
  token: '',
  handshakeTimeoutMs: 10000,
  heartbeatIntervalMs: 30000,
  maxPayloadBytes: 10 * 1024 * 1024, // 10MB
  tailscale: {
    mode: 'off',
    resetOnExit: true,
  },
  connectionMode: 'local',
  remote: undefined,
};

/**
 * Default remote gateway configuration
 */
export const DEFAULT_REMOTE_GATEWAY_CONFIG: RemoteGatewayConfig = {
  url: 'ws://127.0.0.1:18789',
  token: '',
  deviceName: 'CoWork Remote Client',
  autoReconnect: true,
  reconnectIntervalMs: 5000,
  maxReconnectAttempts: 10,
};

/**
 * Generate a secure random token
 */
export function generateControlPlaneToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

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
    console.warn('[ControlPlane Settings] Failed to encrypt secret:', error);
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
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
        return safeStorage.decryptString(encrypted);
      }
    } catch (error: any) {
      console.error('[ControlPlane Settings] Failed to decrypt:', error.message || error);
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
  private static settingsPath: string;
  private static cachedSettings: ControlPlaneSettings | null = null;
  private static initialized = false;

  /**
   * Initialize the settings manager (must be called after app is ready)
   */
  static initialize(): void {
    if (this.initialized) return;

    const userDataPath = app.getPath('userData');
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE);
    this.initialized = true;

    console.log('[ControlPlane Settings] Initialized with path:', this.settingsPath);
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
   * Load settings from disk
   */
  static loadSettings(): ControlPlaneSettings {
    this.ensureInitialized();

    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        const parsed = JSON.parse(data);

        // Merge with defaults
        const merged: ControlPlaneSettings = {
          ...DEFAULT_CONTROL_PLANE_SETTINGS,
          ...parsed,
          tailscale: {
            ...DEFAULT_CONTROL_PLANE_SETTINGS.tailscale,
            ...parsed.tailscale,
          },
        };

        // Decrypt local token
        merged.token = decryptSecret(merged.token) || '';

        // Handle remote config with encrypted token
        if (parsed.remote) {
          merged.remote = {
            ...DEFAULT_REMOTE_GATEWAY_CONFIG,
            ...parsed.remote,
            token: decryptSecret(parsed.remote.token) || '',
          };
        }

        this.cachedSettings = merged;
        console.log('[ControlPlane Settings] Loaded settings');
      } else {
        console.log('[ControlPlane Settings] No settings file, using defaults');
        this.cachedSettings = { ...DEFAULT_CONTROL_PLANE_SETTINGS };
      }
    } catch (error) {
      console.error('[ControlPlane Settings] Failed to load:', error);
      this.cachedSettings = { ...DEFAULT_CONTROL_PLANE_SETTINGS };
    }

    return this.cachedSettings;
  }

  /**
   * Save settings to disk
   */
  static saveSettings(settings: ControlPlaneSettings): void {
    this.ensureInitialized();

    try {
      // Encrypt tokens before saving
      const toSave: any = {
        ...settings,
        token: encryptSecret(settings.token) || '',
      };

      // Encrypt remote token if present
      if (settings.remote) {
        toSave.remote = {
          ...settings.remote,
          token: encryptSecret(settings.remote.token) || '',
        };
      }

      fs.writeFileSync(this.settingsPath, JSON.stringify(toSave, null, 2));
      this.cachedSettings = settings;
      console.log('[ControlPlane Settings] Saved settings');
    } catch (error) {
      console.error('[ControlPlane Settings] Failed to save:', error);
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
      token: settings.token ? MASKED_VALUE : '',
    };

    // Mask remote token if present
    if (settings.remote) {
      displaySettings.remote = {
        ...settings.remote,
        token: settings.remote.token ? MASKED_VALUE : '',
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
