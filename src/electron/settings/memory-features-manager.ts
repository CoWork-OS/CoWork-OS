/**
 * Memory Features Settings Manager
 *
 * Stores global toggles for memory-related features in encrypted settings storage.
 */

import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { MemoryFeaturesSettings } from "../../shared/types";

const DEFAULT_SETTINGS: MemoryFeaturesSettings = {
  contextPackInjectionEnabled: true,
  heartbeatMaintenanceEnabled: true,
  promptStackV2Enabled: false,
  layeredMemoryEnabled: false,
  transcriptStoreEnabled: false,
  backgroundConsolidationEnabled: false,
  queryOrchestratorEnabled: false,
  sessionLineageEnabled: false,
};

function isEnabled(value: boolean | undefined): boolean {
  return value === true;
}

export class MemoryFeaturesManager {
  private static cachedSettings: MemoryFeaturesSettings | null = null;

  static initialize(): void {
    // No migration required currently; kept for parity with other managers.
    console.log("[MemoryFeaturesManager] Initialized");
  }

  static loadSettings(): MemoryFeaturesSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: MemoryFeaturesSettings = { ...DEFAULT_SETTINGS };

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<MemoryFeaturesSettings>("memory");
        if (stored) {
          settings = { ...DEFAULT_SETTINGS, ...stored };
        }
      }
    } catch (error) {
      console.error("[MemoryFeaturesManager] Failed to load settings:", error);
    }

    // Normalize to booleans (defensive against corrupted values).
    settings = {
      contextPackInjectionEnabled: !!settings.contextPackInjectionEnabled,
      heartbeatMaintenanceEnabled: !!settings.heartbeatMaintenanceEnabled,
      promptStackV2Enabled: isEnabled(settings.promptStackV2Enabled),
      layeredMemoryEnabled: isEnabled(settings.layeredMemoryEnabled),
      transcriptStoreEnabled: isEnabled(settings.transcriptStoreEnabled),
      backgroundConsolidationEnabled: isEnabled(settings.backgroundConsolidationEnabled),
      queryOrchestratorEnabled: isEnabled(settings.queryOrchestratorEnabled),
      sessionLineageEnabled: isEnabled(settings.sessionLineageEnabled),
    };

    this.cachedSettings = settings;
    return settings;
  }

  static saveSettings(settings: MemoryFeaturesSettings): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }

    const normalized: MemoryFeaturesSettings = {
      contextPackInjectionEnabled: !!settings.contextPackInjectionEnabled,
      heartbeatMaintenanceEnabled: !!settings.heartbeatMaintenanceEnabled,
      promptStackV2Enabled: isEnabled(settings.promptStackV2Enabled),
      layeredMemoryEnabled: isEnabled(settings.layeredMemoryEnabled),
      transcriptStoreEnabled: isEnabled(settings.transcriptStoreEnabled),
      backgroundConsolidationEnabled: isEnabled(settings.backgroundConsolidationEnabled),
      queryOrchestratorEnabled: isEnabled(settings.queryOrchestratorEnabled),
      sessionLineageEnabled: isEnabled(settings.sessionLineageEnabled),
    };

    const repository = SecureSettingsRepository.getInstance();
    repository.save("memory", normalized);
    this.cachedSettings = normalized;
    console.log("[MemoryFeaturesManager] Settings saved");
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }
}
