/**
 * X/Twitter Settings Manager
 *
 * Stores X integration settings in encrypted database.
 */

import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { XSettingsData } from "../../shared/types";

const DEFAULT_SETTINGS: XSettingsData = {
  enabled: false,
  authMethod: "browser",
  cookieSource: ["chrome"],
  timeoutMs: 20000,
  cookieTimeoutMs: 20000,
  quoteDepth: 1,
  mentionTrigger: {
    enabled: false,
    commandPrefix: "do:",
    allowedAuthors: [],
    pollIntervalSec: 120,
    fetchCount: 25,
    workspaceMode: "temporary",
  },
};

export class XSettingsManager {
  private static cachedSettings: XSettingsData | null = null;

  static loadSettings(): XSettingsData {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: XSettingsData = { ...DEFAULT_SETTINGS };

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<XSettingsData>("x");
        if (stored) {
          settings = {
            ...DEFAULT_SETTINGS,
            ...stored,
            mentionTrigger: {
              ...DEFAULT_SETTINGS.mentionTrigger,
              ...(stored.mentionTrigger || {}),
            },
          };
        }
      }
    } catch (error) {
      console.error("[XSettingsManager] Failed to load settings:", error);
    }

    this.cachedSettings = settings;
    return settings;
  }

  static saveSettings(settings: XSettingsData): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error("SecureSettingsRepository not initialized");
      }
      const repository = SecureSettingsRepository.getInstance();
      repository.save("x", settings);
      this.cachedSettings = settings;
      console.log("[XSettingsManager] Settings saved");
    } catch (error) {
      console.error("[XSettingsManager] Failed to save settings:", error);
    }
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }
}
