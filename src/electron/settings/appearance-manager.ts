/**
 * Appearance Settings Manager
 *
 * Manages user appearance preferences (theme and accent color).
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AppearanceSettings, ThemeMode, VisualTheme, AccentColor, UiDensity } from '../../shared/types';
import { SecureSettingsRepository } from '../database/SecureSettingsRepository';
import { getUserDataDir } from '../utils/user-data-dir';

const LEGACY_SETTINGS_FILE = 'appearance-settings.json';

const DEFAULT_SETTINGS: AppearanceSettings = {
  themeMode: 'dark',
  visualTheme: 'warm',
  accentColor: 'cyan',
  uiDensity: 'focused',
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
    const userDataPath = getUserDataDir();
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
    let needsWrite = false;

    try {
      // Try to load from encrypted database
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<AppearanceSettings>('appearance');
        if (stored) {
          settings = { ...DEFAULT_SETTINGS, ...stored };
          // If stored data was missing uiDensity, persist the default back
          if (!isValidUiDensity(stored.uiDensity)) {
            needsWrite = true;
          }
        }
      }

      // Validate values
      if (!isValidThemeMode(settings.themeMode)) {
        settings.themeMode = DEFAULT_SETTINGS.themeMode;
      }
      if (!isValidVisualTheme(settings.visualTheme)) {
        settings.visualTheme = DEFAULT_SETTINGS.visualTheme;
      }
      // Normalize deprecated 'oblivion' theme to 'warm'
      if (settings.visualTheme === 'oblivion') {
        settings.visualTheme = 'warm';
      }
      if (!isValidAccentColor(settings.accentColor)) {
        settings.accentColor = DEFAULT_SETTINGS.accentColor;
      }
      if (!isValidUiDensity(settings.uiDensity)) {
        settings.uiDensity = DEFAULT_SETTINGS.uiDensity;
        needsWrite = true;
      }
    } catch (error) {
      console.error('[AppearanceManager] Failed to load settings:', error);
      settings = { ...DEFAULT_SETTINGS };
    }

    this.cachedSettings = settings;

    // Persist defaults for newly added fields so they survive future saves
    if (needsWrite && SecureSettingsRepository.isInitialized()) {
      try {
        const repository = SecureSettingsRepository.getInstance();
        repository.save('appearance', settings);
        console.log('[AppearanceManager] Persisted default uiDensity:', settings.uiDensity);
      } catch (e) {
        // Non-fatal: cache is correct, DB will catch up on next save
      }
    }

    console.debug('[AppearanceManager] Loaded settings → uiDensity:', settings.uiDensity);
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
      // Normalize deprecated 'oblivion' to 'warm' before saving
      let normalizedVisualTheme = isValidVisualTheme(settings.visualTheme) ? settings.visualTheme : existingSettings.visualTheme;
      if (normalizedVisualTheme === 'oblivion') {
        normalizedVisualTheme = 'warm';
      }
      const validatedSettings: AppearanceSettings = {
        themeMode: isValidThemeMode(settings.themeMode) ? settings.themeMode : existingSettings.themeMode,
        visualTheme: normalizedVisualTheme,
        accentColor: isValidAccentColor(settings.accentColor) ? settings.accentColor : existingSettings.accentColor,
        language: settings.language ?? existingSettings.language,
        disclaimerAccepted: settings.disclaimerAccepted ?? existingSettings.disclaimerAccepted,
        onboardingCompleted: settings.onboardingCompleted ?? existingSettings.onboardingCompleted,
        onboardingCompletedAt: settings.onboardingCompletedAt ?? existingSettings.onboardingCompletedAt,
        assistantName: settings.assistantName ?? existingSettings.assistantName,
        uiDensity: isValidUiDensity(settings.uiDensity) ? settings.uiDensity : existingSettings.uiDensity,
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

function isValidVisualTheme(value: unknown): value is VisualTheme {
  return value === 'terminal' || value === 'warm' || value === 'oblivion';
}

function isValidAccentColor(value: unknown): value is AccentColor {
  const validColors: AccentColor[] = ['cyan', 'blue', 'purple', 'pink', 'rose', 'orange', 'green', 'teal', 'coral'];
  return validColors.includes(value as AccentColor);
}

function isValidUiDensity(value: unknown): value is UiDensity {
  return value === 'focused' || value === 'full';
}
