/**
 * Settings > Browser, stored encrypted in the settings database.
 */

import {
  type BrowserSettings,
  type BrowserSettingsPolicy,
  type BrowserSettingsState,
  DEFAULT_BROWSER_SETTINGS,
  normalizeBrowserSettings,
} from "../../shared/browser-settings";
import { getBrowserPolicy } from "../admin/policies";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

const CATEGORY = "browser" as const;
/** policies.json is read from disk; tool listing and permission checks ask often. */
const POLICY_CACHE_MS = 2_000;

export class BrowserSettingsManager {
  private static cached: BrowserSettings | null = null;
  private static listeners = new Set<(settings: BrowserSettings) => void>();
  private static policyCache: { at: number; value: BrowserSettingsPolicy } | null = null;

  /** The admin policy for the in-app browser (cached briefly). */
  static loadPolicy(): BrowserSettingsPolicy {
    const now = Date.now();
    if (this.policyCache && now - this.policyCache.at < POLICY_CACHE_MS) {
      return this.policyCache.value;
    }
    let value: BrowserSettingsPolicy = { developerModeLocked: false, blockedSitePermissions: [] };
    let forcedDeveloperMode: boolean | undefined;
    try {
      const policy = getBrowserPolicy();
      if (policy.developerMode !== "user") forcedDeveloperMode = policy.developerMode === "on";
      value = {
        developerModeLocked: forcedDeveloperMode !== undefined,
        blockedSitePermissions: [...policy.blockedSitePermissions],
      };
    } catch {
      // No readable policy: nothing is locked.
    }
    this.policyCache = { at: now, value };
    this.forcedDeveloperMode = forcedDeveloperMode;
    return value;
  }

  private static forcedDeveloperMode: boolean | undefined;

  /** Effective settings: what the user chose, with the admin policy applied. */
  static loadSettings(): BrowserSettings {
    const stored = this.loadStoredSettings();
    const policy = this.loadPolicy();
    return policy.developerModeLocked && this.forcedDeveloperMode !== undefined
      ? { ...stored, developerMode: this.forcedDeveloperMode }
      : stored;
  }

  /** Effective settings plus what the policy locks, for Settings > Browser. */
  static loadSettingsState(): BrowserSettingsState {
    return { ...this.loadSettings(), policy: this.loadPolicy() };
  }

  /** The user's own choices, before the admin policy. */
  static loadStoredSettings(): BrowserSettings {
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
    // Based on the user's own choices: a policy-forced value is never saved as theirs.
    const next = normalizeBrowserSettings({ ...this.loadStoredSettings(), ...partial });
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
    this.policyCache = null;
    this.forcedDeveloperMode = undefined;
  }
}
