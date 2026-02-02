/**
 * Tailscale Settings Manager
 *
 * Manages Tailscale configuration persistence.
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { SecureSettingsRepository } from '../database/SecureSettingsRepository';

const LEGACY_SETTINGS_FILE = 'tailscale-settings.json';

/**
 * Tailscale mode options
 * - off: Tailscale integration disabled
 * - serve: Expose to Tailnet (private network)
 * - funnel: Expose to public internet
 */
export type TailscaleMode = 'off' | 'serve' | 'funnel';

/**
 * Tailscale settings interface
 */
export interface TailscaleSettings {
  /** Current mode */
  mode: TailscaleMode;
  /** Whether to reset Tailscale config on app exit */
  resetOnExit: boolean;
  /** Custom path prefix for the exposed endpoint */
  pathPrefix?: string;
  /** Last known hostname */
  lastHostname?: string;
  /** Timestamp of last status check */
  lastStatusCheck?: number;
}

/**
 * Default Tailscale settings
 */
export const DEFAULT_TAILSCALE_SETTINGS: TailscaleSettings = {
  mode: 'off',
  resetOnExit: true,
};

/**
 * Tailscale Settings Manager
 */
export class TailscaleSettingsManager {
  private static legacySettingsPath: string;
  private static cachedSettings: TailscaleSettings | null = null;
  private static initialized = false;
  private static migrationCompleted = false;

  /**
   * Initialize the settings manager (must be called after app is ready)
   */
  static initialize(): void {
    if (this.initialized) return;

    const userDataPath = app.getPath('userData');
    this.legacySettingsPath = path.join(userDataPath, LEGACY_SETTINGS_FILE);
    this.initialized = true;

    console.log('[Tailscale Settings] Initialized');

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
        console.log('[Tailscale Settings] SecureSettingsRepository not yet initialized, skipping migration');
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      if (repository.exists('tailscale')) {
        console.log('[Tailscale Settings] Settings already in database, skipping migration');
        this.migrationCompleted = true;
        return;
      }

      if (!fs.existsSync(this.legacySettingsPath)) {
        console.log('[Tailscale Settings] No legacy settings file found');
        this.migrationCompleted = true;
        return;
      }

      console.log('[Tailscale Settings] Migrating settings from legacy JSON file to encrypted database...');

      // Create backup before migration
      const backupPath = this.legacySettingsPath + '.migration-backup';
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        const data = fs.readFileSync(this.legacySettingsPath, 'utf-8');
        const legacySettings = { ...DEFAULT_TAILSCALE_SETTINGS, ...JSON.parse(data) };

        repository.save('tailscale', legacySettings);
        console.log('[Tailscale Settings] Settings migrated to encrypted database');

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log('[Tailscale Settings] Migration complete, cleaned up legacy files');

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error('[Tailscale Settings] Migration failed, backup preserved at:', backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error('[Tailscale Settings] Migration failed:', error);
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
  static loadSettings(): TailscaleSettings {
    this.ensureInitialized();

    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<TailscaleSettings>('tailscale');
        if (stored) {
          const merged: TailscaleSettings = {
            ...DEFAULT_TAILSCALE_SETTINGS,
            ...stored,
          };
          this.cachedSettings = merged;
          console.log('[Tailscale Settings] Loaded settings from encrypted database');
          return this.cachedSettings;
        }
      }
    } catch (error) {
      console.error('[Tailscale Settings] Failed to load settings:', error);
    }

    console.log('[Tailscale Settings] No settings found, using defaults');
    this.cachedSettings = { ...DEFAULT_TAILSCALE_SETTINGS };
    return this.cachedSettings;
  }

  /**
   * Save settings to encrypted database
   */
  static saveSettings(settings: TailscaleSettings): void {
    this.ensureInitialized();

    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error('SecureSettingsRepository not initialized');
      }

      const repository = SecureSettingsRepository.getInstance();
      repository.save('tailscale', settings);
      this.cachedSettings = settings;
      console.log('[Tailscale Settings] Saved settings to encrypted database');
    } catch (error) {
      console.error('[Tailscale Settings] Failed to save settings:', error);
      throw error;
    }
  }

  /**
   * Update settings partially
   */
  static updateSettings(updates: Partial<TailscaleSettings>): TailscaleSettings {
    const settings = this.loadSettings();
    const updated = { ...settings, ...updates };
    this.saveSettings(updated);
    return updated;
  }

  /**
   * Set the Tailscale mode
   */
  static setMode(mode: TailscaleMode): TailscaleSettings {
    return this.updateSettings({ mode });
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
  static getDefaults(): TailscaleSettings {
    return { ...DEFAULT_TAILSCALE_SETTINGS };
  }
}
