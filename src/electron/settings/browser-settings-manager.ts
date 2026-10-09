/**
 * Settings > Browser, stored encrypted in the settings database.
 */

import {
  type BrowserSettings,
  DEFAULT_BROWSER_SETTINGS,
  normalizeBrowserSettings,
} from "../../shared/browser-settings";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

const CATEGORY = "browser" as const;

export class BrowserSettingsManager {
  private static cached: BrowserSettings | null = null;
  private static listeners = new Set<(settings: BrowserSettings) => void>();

  static loadSettings(): BrowserSettings {
    if (this.cached) return this.cached;
    let stored: unknown;
    try {
      stored = SecureSettingsRepository.isInitialized()
        ? SecureSettingsRepository.getInstance().load<BrowserSettings>(CATEGORY)
        : undefined;
    } catch {
      stored = undefined;
    }
    const settings = normalizeBrowserSettings(stored ?? DEFAULT_BROWSER_SETTINGS);
    if (SecureSettingsRepository.isInitialized()) this.cached = settings;
    return settings;
  }

  static saveSettings(partial: Partial<BrowserSettings>): BrowserSettings {
    const next = normalizeBrowserSettings({ ...this.loadSettings(), ...partial });
    if (SecureSettingsRepository.isInitialized()) {
      SecureSettingsRepository.getInstance().save(CATEGORY, next);
    }
    this.cached = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // One listener failing must not block the others.
      }
    }
    return next;
  }

  static onChange(listener: (settings: BrowserSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test hook. */
  static resetCache(): void {
    this.cached = null;
  }
}
