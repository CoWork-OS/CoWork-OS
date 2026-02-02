/**
 * Appearance Settings Manager
 *
 * Manages user appearance preferences (theme and accent color).
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppearanceSettings, ThemeMode, AccentColor } from '../../shared/types';
import { SecureSettingsRepository } from '../database/SecureSettingsRepository';

const LEGACY_SETTINGS_FILE = 'appearance-settings.json';

const DEFAULT_SETTINGS: AppearanceSettings = {
  themeMode: 'dark',
  accentColor: 'cyan',
  disclaimerAccepted: false,
  onboardingCompleted: false,
  onboardingCompletedAt: undefined,
};

export class AppearanceManager {
  private static legacySettingsPath: string;
  private static cachedSettings: AppearanceSettings | null = null;
  private static migrationCompleted = false;

  /**
   * Initialize the AppearanceManager
   */
  static initialize(): void {
    const userDataPath = app.getPath('userData');
    this.legacySettingsPath = path.join(userDataPath, LEGACY_SETTINGS_FILE);
    console.log('[AppearanceManager] Initialized');

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
        console.log('[AppearanceManager] SecureSettingsRepository not yet initialized, skipping migration');
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      // Check if already migrated to database
      if (repository.exists('appearance')) {
        console.log('[AppearanceManager] Settings already in database, skipping migration');
        this.migrationCompleted = true;
        return;
      }

      // Check if legacy file exists
      if (!fs.existsSync(this.legacySettingsPath)) {
        console.log('[AppearanceManager] No legacy settings file found');
        this.migrationCompleted = true;
        return;
      }

      console.log('[AppearanceManager] Migrating settings from legacy JSON file to encrypted database...');

      // Create backup before migration
      const backupPath = this.legacySettingsPath + '.migration-backup';
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        // Read legacy settings
        const data = fs.readFileSync(this.legacySettingsPath, 'utf-8');
        const parsed = JSON.parse(data);
        const legacySettings = { ...DEFAULT_SETTINGS, ...parsed };

        // Save to encrypted database
        repository.save('appearance', legacySettings);
        console.log('[AppearanceManager] Settings migrated to encrypted database');

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log('[AppearanceManager] Migration complete, cleaned up legacy files');

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error('[AppearanceManager] Migration failed, backup preserved at:', backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error('[AppearanceManager] Migration failed:', error);
    }
  }

  /**
   * Load settings from encrypted database (with caching)
   */
  static loadSettings(): AppearanceSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: AppearanceSettings = { ...DEFAULT_SETTINGS };

    try {
      // Try to load from encrypted database
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<AppearanceSettings>('appearance');
        if (stored) {
          settings = { ...DEFAULT_SETTINGS, ...stored };
        }
      }

      // Validate values
      if (!isValidThemeMode(settings.themeMode)) {
        settings.themeMode = DEFAULT_SETTINGS.themeMode;
      }
      if (!isValidAccentColor(settings.accentColor)) {
        settings.accentColor = DEFAULT_SETTINGS.accentColor;
      }
    } catch (error) {
      console.error('[AppearanceManager] Failed to load settings:', error);
      settings = { ...DEFAULT_SETTINGS };
    }

    this.cachedSettings = settings;
    return settings;
  }

  /**
   * Save settings to encrypted database
   */
  static saveSettings(settings: AppearanceSettings): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error('SecureSettingsRepository not initialized');
      }

      // Load existing settings to preserve fields not being updated
      const existingSettings = this.loadSettings();

      // Validate and merge with existing settings
      const validatedSettings: AppearanceSettings = {
        themeMode: isValidThemeMode(settings.themeMode) ? settings.themeMode : existingSettings.themeMode,
        accentColor: isValidAccentColor(settings.accentColor) ? settings.accentColor : existingSettings.accentColor,
        disclaimerAccepted: settings.disclaimerAccepted ?? existingSettings.disclaimerAccepted,
        onboardingCompleted: settings.onboardingCompleted ?? existingSettings.onboardingCompleted,
        onboardingCompletedAt: settings.onboardingCompletedAt ?? existingSettings.onboardingCompletedAt,
      };

      const repository = SecureSettingsRepository.getInstance();
      repository.save('appearance', validatedSettings);
      this.cachedSettings = validatedSettings;
      console.log('[AppearanceManager] Settings saved to encrypted database');
    } catch (error) {
      console.error('[AppearanceManager] Failed to save settings:', error);
      throw error;
    }
  }

  /**
   * Clear the settings cache
   */
  static clearCache(): void {
    this.cachedSettings = null;
  }
}

function isValidThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isValidAccentColor(value: unknown): value is AccentColor {
  const validColors: AccentColor[] = ['cyan', 'blue', 'purple', 'pink', 'rose', 'orange', 'green', 'teal'];
  return validColors.includes(value as AccentColor);
}
