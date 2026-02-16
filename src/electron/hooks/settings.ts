/**
 * Hooks Settings Manager
 *
 * Manages webhook configuration with encrypted storage.
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import {
  HooksConfig,
  GmailHooksConfig,
  ResendHooksConfig,
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
import { SecureSettingsRepository } from '../database/SecureSettingsRepository';
import { getUserDataDir } from '../utils/user-data-dir';
import { getSafeStorage } from '../utils/safe-storage';

const LEGACY_SETTINGS_FILE = 'hooks-settings.json';
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
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable()) {
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
      const safeStorage = getSafeStorage();
      if (safeStorage?.isEncryptionAvailable()) {
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
    resend: settings.resend
      ? {
          ...settings.resend,
          webhookSecret: encryptSecret(settings.resend.webhookSecret),
        }
      : undefined,
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
    resend: settings.resend
      ? {
          ...settings.resend,
          webhookSecret: decryptSecret(settings.resend.webhookSecret),
        }
      : undefined,
  };
}

/**
 * Hooks Settings Manager
 */
export class HooksSettingsManager {
  private static legacySettingsPath: string;
  private static cachedSettings: HooksConfig | null = null;
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

    console.log('[Hooks Settings] Initialized');

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
        console.log('[Hooks Settings] SecureSettingsRepository not yet initialized, skipping migration');
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      if (repository.exists('hooks')) {
        this.migrationCompleted = true;
        return;
      }

      if (!fs.existsSync(this.legacySettingsPath)) {
        console.log('[Hooks Settings] No legacy settings file found');
        this.migrationCompleted = true;
        return;
      }

      console.log('[Hooks Settings] Migrating settings from legacy JSON file to encrypted database...');

      // Create backup before migration
      const backupPath = this.legacySettingsPath + '.migration-backup';
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        const data = fs.readFileSync(this.legacySettingsPath, 'utf-8');
        const parsed = JSON.parse(data);

        const merged: HooksConfig = {
          ...DEFAULT_HOOKS_CONFIG,
          ...parsed,
          mappings: parsed.mappings || [],
          presets: parsed.presets || [],
        };

        // Decrypt any existing encrypted values before saving to the new encrypted database
        const decrypted = decryptSettings(merged);

        repository.save('hooks', decrypted);
        console.log('[Hooks Settings] Settings migrated to encrypted database');

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log('[Hooks Settings] Migration complete, cleaned up legacy files');

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error('[Hooks Settings] Migration failed, backup preserved at:', backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error('[Hooks Settings] Migration failed:', error);
    }
  }

  /**
   * Load settings from encrypted database
   */
  static loadSettings(): HooksConfig {
    this.ensureInitialized();

    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<HooksConfig>('hooks');
        if (stored) {
          const merged: HooksConfig = {
            ...DEFAULT_HOOKS_CONFIG,
            ...stored,
            mappings: stored.mappings || [],
            presets: stored.presets || [],
          };
          this.cachedSettings = merged;
          console.log('[Hooks Settings] Loaded settings from encrypted database');
          return this.cachedSettings;
        }
      }
    } catch (error) {
      console.error('[Hooks Settings] Failed to load settings:', error);
    }

    console.log('[Hooks Settings] No settings found, using defaults');
    this.cachedSettings = { ...DEFAULT_HOOKS_CONFIG };
    return this.cachedSettings;
  }

  /**
   * Save settings to encrypted database
   */
  static saveSettings(settings: HooksConfig): void {
    this.ensureInitialized();

    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error('SecureSettingsRepository not initialized');
      }

      const repository = SecureSettingsRepository.getInstance();
      repository.save('hooks', settings);
      this.cachedSettings = settings;
      console.log('[Hooks Settings] Saved settings to encrypted database');
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
      resend: settings.resend
        ? {
            ...settings.resend,
            webhookSecret: settings.resend.webhookSecret ? MASKED_VALUE : undefined,
          }
        : undefined,
    };
  }

  /**
   * Configure Resend webhook settings
   */
  static configureResend(resendConfig: ResendHooksConfig): HooksConfig {
    const settings = this.loadSettings();
    settings.resend = {
      ...settings.resend,
      ...resendConfig,
    };

    if (resendConfig.webhookSecret && !settings.presets.includes('resend')) {
      settings.presets.push('resend');
    }

    this.saveSettings(settings);
    return settings;
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
