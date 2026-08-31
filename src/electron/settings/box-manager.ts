/**
 * Box Settings Manager
 *
 * Stores Box integration settings in encrypted database.
 */

import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { BoxBrainSettings, BoxSettingsData } from "../../shared/types";

export const DEFAULT_BOX_BRAIN_SETTINGS: BoxBrainSettings = {
  enabled: false,
  rootFolderId: "0",
  syncIntervalMinutes: 60,
  maxItemsPerRun: 200,
  includeContent: true,
  useBoxAiSummaries: false,
  improvementEnabled: true,
  maxContentChars: 10000,
};

const DEFAULT_SETTINGS: BoxSettingsData = {
  enabled: false,
  timeoutMs: 20000,
  brain: DEFAULT_BOX_BRAIN_SETTINGS,
};

function normalizeBrainSettings(settings?: Partial<BoxBrainSettings>): BoxBrainSettings {
  const merged = { ...DEFAULT_BOX_BRAIN_SETTINGS, ...settings };
  return {
    enabled: Boolean(merged.enabled),
    workspaceId:
      typeof merged.workspaceId === "string" && merged.workspaceId.trim()
        ? merged.workspaceId.trim()
        : undefined,
    rootFolderId: String(merged.rootFolderId || "0").trim() || "0",
    syncIntervalMinutes: Math.min(
      Math.max(Math.floor(Number(merged.syncIntervalMinutes) || 60), 5),
      10080,
    ),
    maxItemsPerRun: Math.min(Math.max(Math.floor(Number(merged.maxItemsPerRun) || 200), 1), 1000),
    includeContent: Boolean(merged.includeContent),
    useBoxAiSummaries: Boolean(merged.useBoxAiSummaries),
    improvementEnabled: Boolean(merged.improvementEnabled),
    maxContentChars: Math.min(
      Math.max(Math.floor(Number(merged.maxContentChars) || 10000), 500),
      10000,
    ),
  };
}

export function normalizeBoxSettings(settings: BoxSettingsData): BoxSettingsData {
  return {
    ...settings,
    brain: normalizeBrainSettings(settings.brain),
  };
}

export class BoxSettingsManager {
  private static cachedSettings: BoxSettingsData | null = null;

  static loadSettings(): BoxSettingsData {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: BoxSettingsData = { ...DEFAULT_SETTINGS };

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<BoxSettingsData>("box");
        if (stored) {
          settings = normalizeBoxSettings({ ...DEFAULT_SETTINGS, ...stored });
        }
      }
    } catch (error) {
      console.error("[BoxSettingsManager] Failed to load settings:", error);
    }

    this.cachedSettings = settings;
    return settings;
  }

  static saveSettings(settings: BoxSettingsData): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error("SecureSettingsRepository not initialized");
      }
      const repository = SecureSettingsRepository.getInstance();
      const normalized = normalizeBoxSettings(settings);
      repository.save("box", normalized);
      this.cachedSettings = normalized;
      console.log("[BoxSettingsManager] Settings saved");
    } catch (error) {
      console.error("[BoxSettingsManager] Failed to save settings:", error);
    }
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }
}
