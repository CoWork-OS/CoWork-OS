/**
 * Infrastructure Settings Manager
 *
 * Manages infrastructure-specific settings with encrypted storage.
 * Covers: E2B sandbox config, domain registration, wallet, payments.
 */

import { InfraSettings, DEFAULT_INFRA_SETTINGS } from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

const STORAGE_KEY = "infra";

export class InfraSettingsManager {
  private static cachedSettings: InfraSettings | null = null;
  private static initialized = false;

  static initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    console.log("[Infra Settings] Initialized");
  }

  static loadSettings(): InfraSettings {
    this.ensureInitialized();

    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<InfraSettings>(STORAGE_KEY);
        if (stored) {
          this.cachedSettings = {
            ...DEFAULT_INFRA_SETTINGS,
            ...stored,
            e2b: { ...DEFAULT_INFRA_SETTINGS.e2b, ...(stored.e2b || {}) },
            domains: { ...DEFAULT_INFRA_SETTINGS.domains, ...(stored.domains || {}) },
            wallet: { ...DEFAULT_INFRA_SETTINGS.wallet, ...(stored.wallet || {}) },
            payments: { ...DEFAULT_INFRA_SETTINGS.payments, ...(stored.payments || {}) },
            enabledCategories: {
              ...DEFAULT_INFRA_SETTINGS.enabledCategories,
              ...(stored.enabledCategories || {}),
            },
          };
          return this.cachedSettings;
        }
      }
    } catch (error) {
      console.error("[Infra Settings] Failed to load settings:", error);
    }

    this.cachedSettings = { ...DEFAULT_INFRA_SETTINGS };
    return this.cachedSettings;
  }

  static saveSettings(settings: InfraSettings): void {
    this.ensureInitialized();

    this.cachedSettings = settings;

    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error("SecureSettingsRepository not initialized");
      }

      const repository = SecureSettingsRepository.getInstance();
      repository.save(STORAGE_KEY, settings);
      console.log("[Infra Settings] Saved settings to encrypted database");
    } catch (error) {
      console.error("[Infra Settings] Failed to save settings:", error);
      throw error;
    }
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }

  static getDefaults(): InfraSettings {
    return { ...DEFAULT_INFRA_SETTINGS };
  }

  private static ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }
}
