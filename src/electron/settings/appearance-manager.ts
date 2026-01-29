/**
 * Appearance Settings Manager
 *
 * Manages user appearance preferences (theme and accent color).
 * Settings are persisted to disk in the userData directory.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppearanceSettings, ThemeMode, AccentColor } from '../../shared/types';

const SETTINGS_FILE = 'appearance-settings.json';

const DEFAULT_SETTINGS: AppearanceSettings = {
  themeMode: 'dark',
  accentColor: 'cyan',
  disclaimerAccepted: false,
};

export class AppearanceManager {
  private static settingsPath: string;
  private static cachedSettings: AppearanceSettings | null = null;

  /**
   * Initialize the AppearanceManager with the settings path
   */
  static initialize(): void {
    const userDataPath = app.getPath('userData');
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE);
    console.log('[AppearanceManager] Initialized with path:', this.settingsPath);
  }

  /**
   * Load settings from disk (with caching)
   */
  static loadSettings(): AppearanceSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: AppearanceSettings = { ...DEFAULT_SETTINGS };

    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        const parsed = JSON.parse(data);
        // Merge with defaults to handle missing fields
        settings = { ...DEFAULT_SETTINGS, ...parsed };
        // Validate values
        if (!isValidThemeMode(settings.themeMode)) {
          settings.themeMode = DEFAULT_SETTINGS.themeMode;
        }
        if (!isValidAccentColor(settings.accentColor)) {
          settings.accentColor = DEFAULT_SETTINGS.accentColor;
        }
      }
    } catch (error) {
      console.error('[AppearanceManager] Failed to load settings:', error);
      settings = { ...DEFAULT_SETTINGS };
    }

    this.cachedSettings = settings;
    return settings;
  }

  /**
   * Save settings to disk
   */
  static saveSettings(settings: AppearanceSettings): void {
    try {
      // Load existing settings to preserve fields not being updated
      const existingSettings = this.loadSettings();

      // Validate and merge with existing settings
      const validatedSettings: AppearanceSettings = {
        themeMode: isValidThemeMode(settings.themeMode) ? settings.themeMode : existingSettings.themeMode,
        accentColor: isValidAccentColor(settings.accentColor) ? settings.accentColor : existingSettings.accentColor,
        disclaimerAccepted: settings.disclaimerAccepted ?? existingSettings.disclaimerAccepted,
      };

      fs.writeFileSync(this.settingsPath, JSON.stringify(validatedSettings, null, 2));
      this.cachedSettings = validatedSettings;
      console.log('[AppearanceManager] Settings saved:', validatedSettings);
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
