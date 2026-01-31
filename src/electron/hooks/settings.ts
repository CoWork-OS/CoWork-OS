/**
 * Hooks Settings Manager
 *
 * Manages webhook configuration with encrypted credential storage.
 * Follows the same pattern as MCP Settings Manager.
 */

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import {
  HooksConfig,
  GmailHooksConfig,
  HookMappingConfig,
  DEFAULT_HOOKS_CONFIG,
  DEFAULT_HOOKS_PATH,
  DEFAULT_HOOKS_MAX_BODY_BYTES,
  DEFAULT_GMAIL_LABEL,
  DEFAULT_GMAIL_SERVE_BIND,
  DEFAULT_GMAIL_SERVE_PORT,
  DEFAULT_GMAIL_SERVE_PATH,
  DEFAULT_GMAIL_MAX_BYTES,
  DEFAULT_GMAIL_RENEW_MINUTES,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_TOPIC,
} from './types';

const SETTINGS_FILE = 'hooks-settings.json';
const MASKED_VALUE = '***configured***';
const ENCRYPTED_PREFIX = 'encrypted:';

/**
 * Generate a secure random token
 */
export function generateHookToken(bytes = 24): string {
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
    console.warn('[Hooks Settings] Failed to encrypt secret, storing masked:', error);
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
        console.error('[Hooks Settings] safeStorage encryption not available - cannot decrypt secrets');
      }
    } catch (error: any) {
      console.error('[Hooks Settings] Failed to decrypt secret:', error.message || error);
    }
  }

  // If not encrypted and not masked, return as-is (for backwards compatibility)
  if (value !== MASKED_VALUE && !value.startsWith(ENCRYPTED_PREFIX)) {
    return value.trim() || undefined;
  }

  return undefined;
}

/**
 * Encrypt all credentials in settings before saving to disk
 */
function encryptSettings(settings: HooksConfig): HooksConfig {
  return {
    ...settings,
    token: encryptSecret(settings.token) || '',
    gmail: settings.gmail ? {
      ...settings.gmail,
      pushToken: encryptSecret(settings.gmail.pushToken),
    } : undefined,
  };
}

/**
 * Decrypt all credentials in settings after loading from disk
 */
function decryptSettings(settings: HooksConfig): HooksConfig {
  return {
    ...settings,
    token: decryptSecret(settings.token) || '',
    gmail: settings.gmail ? {
      ...settings.gmail,
      pushToken: decryptSecret(settings.gmail.pushToken),
    } : undefined,
  };
}

/**
 * Hooks Settings Manager
 */
export class HooksSettingsManager {
  private static settingsPath: string;
  private static cachedSettings: HooksConfig | null = null;
  private static initialized = false;

  /**
   * Initialize the settings manager (must be called after app is ready)
   */
  static initialize(): void {
    if (this.initialized) return;

    const userDataPath = app.getPath('userData');
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE);
    this.initialized = true;

    console.log('[Hooks Settings] Initialized with path:', this.settingsPath);
  }

  /**
   * Load settings from disk
   */
  static loadSettings(): HooksConfig {
    this.ensureInitialized();

    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        const parsed = JSON.parse(data);

        // Merge with defaults to handle missing fields from older versions
        const merged: HooksConfig = {
          ...DEFAULT_HOOKS_CONFIG,
          ...parsed,
          mappings: parsed.mappings || [],
          presets: parsed.presets || [],
        };

        // Decrypt credentials
        this.cachedSettings = decryptSettings(merged);
        console.log('[Hooks Settings] Loaded settings');
      } else {
        console.log('[Hooks Settings] No settings file found, using defaults');
        this.cachedSettings = { ...DEFAULT_HOOKS_CONFIG };
      }
    } catch (error) {
      console.error('[Hooks Settings] Failed to load settings:', error);
      this.cachedSettings = { ...DEFAULT_HOOKS_CONFIG };
    }

    return this.cachedSettings;
  }

  /**
   * Save settings to disk
   */
  static saveSettings(settings: HooksConfig): void {
    this.ensureInitialized();

    try {
      // Encrypt credentials before saving
      const encrypted = encryptSettings(settings);
      fs.writeFileSync(this.settingsPath, JSON.stringify(encrypted, null, 2));
      // Only update cache AFTER successful file write to avoid cache/disk inconsistency
      this.cachedSettings = settings;
      console.log('[Hooks Settings] Saved settings');
    } catch (error) {
      console.error('[Hooks Settings] Failed to save settings:', error);
      throw error;
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
  static getDefaults(): HooksConfig {
    return { ...DEFAULT_HOOKS_CONFIG };
  }

  /**
   * Update hooks configuration
   */
  static updateConfig(updates: Partial<HooksConfig>): HooksConfig {
    const settings = this.loadSettings();
    const updated = { ...settings, ...updates };
    this.saveSettings(updated);
    return updated;
  }

  /**
   * Enable hooks with a new token if not already configured
   */
  static enableHooks(): HooksConfig {
    const settings = this.loadSettings();
    if (!settings.token) {
      settings.token = generateHookToken();
    }
    settings.enabled = true;
    this.saveSettings(settings);
    return settings;
  }

  /**
   * Disable hooks
   */
  static disableHooks(): HooksConfig {
    const settings = this.loadSettings();
    settings.enabled = false;
    this.saveSettings(settings);
    return settings;
  }

  /**
   * Regenerate the hook token
   */
  static regenerateToken(): string {
    const settings = this.loadSettings();
    settings.token = generateHookToken();
    this.saveSettings(settings);
    return settings.token;
  }

  /**
   * Add or update a preset
   */
  static addPreset(preset: string): HooksConfig {
    const settings = this.loadSettings();
    const presets = new Set(settings.presets);
    presets.add(preset);
    settings.presets = Array.from(presets);
    this.saveSettings(settings);
    return settings;
  }

  /**
   * Remove a preset
   */
  static removePreset(preset: string): HooksConfig {
    const settings = this.loadSettings();
    settings.presets = settings.presets.filter((p) => p !== preset);
    this.saveSettings(settings);
    return settings;
  }

  /**
   * Add a custom mapping
   */
  static addMapping(mapping: HookMappingConfig): HooksConfig {
    const settings = this.loadSettings();
    settings.mappings.push(mapping);
    this.saveSettings(settings);
    return settings;
  }

  /**
   * Update a mapping by ID
   */
  static updateMapping(id: string, updates: Partial<HookMappingConfig>): HooksConfig | null {
    const settings = this.loadSettings();
    const index = settings.mappings.findIndex((m) => m.id === id);
    if (index === -1) return null;

    settings.mappings[index] = { ...settings.mappings[index], ...updates };
    this.saveSettings(settings);
    return settings;
  }

  /**
   * Remove a mapping by ID
   */
  static removeMapping(id: string): HooksConfig {
    const settings = this.loadSettings();
    settings.mappings = settings.mappings.filter((m) => m.id !== id);
    this.saveSettings(settings);
    return settings;
  }

  /**
   * Configure Gmail hooks
   */
  static configureGmail(gmailConfig: GmailHooksConfig): HooksConfig {
    const settings = this.loadSettings();
    settings.gmail = {
      ...settings.gmail,
      ...gmailConfig,
    };

    // Auto-add gmail preset if account is configured
    if (gmailConfig.account && !settings.presets.includes('gmail')) {
      settings.presets.push('gmail');
    }

    this.saveSettings(settings);
    return settings;
  }

  /**
   * Get Gmail configuration with defaults filled in
   */
  static getGmailConfig(): GmailHooksConfig {
    const settings = this.loadSettings();
    const gmail = settings.gmail || {};

    return {
      account: gmail.account,
      label: gmail.label || DEFAULT_GMAIL_LABEL,
      topic: gmail.topic || DEFAULT_GMAIL_TOPIC,
      subscription: gmail.subscription || DEFAULT_GMAIL_SUBSCRIPTION,
      pushToken: gmail.pushToken,
      hookUrl: gmail.hookUrl,
      includeBody: gmail.includeBody ?? true,
      maxBytes: gmail.maxBytes || DEFAULT_GMAIL_MAX_BYTES,
      renewEveryMinutes: gmail.renewEveryMinutes || DEFAULT_GMAIL_RENEW_MINUTES,
      model: gmail.model,
      thinking: gmail.thinking,
      allowUnsafeExternalContent: gmail.allowUnsafeExternalContent,
      serve: {
        bind: gmail.serve?.bind || DEFAULT_GMAIL_SERVE_BIND,
        port: gmail.serve?.port || DEFAULT_GMAIL_SERVE_PORT,
        path: gmail.serve?.path || DEFAULT_GMAIL_SERVE_PATH,
      },
      tailscale: {
        mode: gmail.tailscale?.mode || 'off',
        path: gmail.tailscale?.path || DEFAULT_GMAIL_SERVE_PATH,
        target: gmail.tailscale?.target,
      },
    };
  }

  /**
   * Get settings for UI display (masks sensitive data)
   */
  static getSettingsForDisplay(): HooksConfig {
    const settings = this.loadSettings();

    return {
      ...settings,
      token: settings.token ? MASKED_VALUE : '',
      gmail: settings.gmail ? {
        ...settings.gmail,
        pushToken: settings.gmail.pushToken ? MASKED_VALUE : undefined,
      } : undefined,
    };
  }

  /**
   * Check if hooks are properly configured
   */
  static isConfigured(): boolean {
    const settings = this.loadSettings();
    return settings.enabled && !!settings.token;
  }

  /**
   * Check if Gmail hooks are configured
   */
  static isGmailConfigured(): boolean {
    const settings = this.loadSettings();
    return !!(settings.gmail?.account && settings.gmail?.topic && settings.gmail?.pushToken);
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
