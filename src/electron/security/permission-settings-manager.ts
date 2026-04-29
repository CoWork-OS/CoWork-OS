import type { PermissionMode, PermissionRule } from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import {
  normalizePermissionScope,
  permissionRuleFingerprint,
} from "./permission-utils";

export interface PermissionSettings {
  version: 1;
  defaultMode: PermissionMode;
  defaultShellEnabled: boolean;
  defaultPermissionAccess: "default" | "full";
  rules: PermissionRule[];
}

const DEFAULT_SETTINGS: PermissionSettings = {
  version: 1,
  defaultMode: "dangerous_only",
  defaultShellEnabled: false,
  defaultPermissionAccess: "default",
  rules: [],
};

export class PermissionSettingsManager {
  private static cachedSettings: PermissionSettings | null = null;

  static loadSettings(): PermissionSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<PermissionSettings>("permissions");
        if (stored) {
          this.cachedSettings = this.normalizeSettings(stored);
          return this.cachedSettings;
        }
      }
    } catch (error) {
      console.error("[PermissionSettingsManager] Failed to load settings:", error);
    }

    this.cachedSettings = this.normalizeSettings(DEFAULT_SETTINGS);
    return this.cachedSettings;
  }

  static saveSettings(settings: PermissionSettings): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }
    const normalized = this.normalizeSettings(settings);
    const repository = SecureSettingsRepository.getInstance();
    repository.save("permissions", normalized);
    this.cachedSettings = normalized;
  }

  static appendRule(rule: PermissionRule): PermissionSettings {
    const current = this.loadSettings();
    const nextRules = [...current.rules];
    const fingerprint = permissionRuleFingerprint(rule);
    if (!nextRules.some((existing) => permissionRuleFingerprint(existing) === fingerprint)) {
      nextRules.push({
        ...rule,
        source: "profile",
        scope: normalizePermissionScope(rule.scope),
        createdAt: rule.createdAt || Date.now(),
      });
    }
    const next = {
      ...current,
      rules: nextRules,
    };
    this.saveSettings(next);
    return next;
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }

  private static normalizeSettings(settings: PermissionSettings): PermissionSettings {
    return {
      version: 1,
      defaultMode: settings?.defaultMode || "dangerous_only",
      defaultShellEnabled: settings?.defaultShellEnabled === true,
      defaultPermissionAccess: settings?.defaultPermissionAccess === "full" ? "full" : "default",
      rules: Array.isArray(settings?.rules)
        ? settings.rules
            .filter((rule): rule is PermissionRule => !!rule && typeof rule === "object")
            .map((rule) => ({
              ...rule,
              source: "profile",
              scope: normalizePermissionScope(rule.scope),
              createdAt: rule.createdAt || Date.now(),
            }))
        : [],
    };
  }
}
