/**
 * Software update preferences, stored encrypted in the settings database:
 * whether packaged updates download on their own, and the version the user skipped.
 */

import { DEFAULT_UPDATE_PREFERENCES, type UpdatePreferences } from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

const CATEGORY = "updates" as const;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Keep only well-formed fields: the value may come from the renderer or an older build. */
export function normalizeUpdatePreferences(value: unknown): UpdatePreferences {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const next: UpdatePreferences = {
    autoDownload:
      typeof input.autoDownload === "boolean"
        ? input.autoDownload
        : DEFAULT_UPDATE_PREFERENCES.autoDownload,
  };
  if (typeof input.skippedVersion === "string" && VERSION_PATTERN.test(input.skippedVersion)) {
    next.skippedVersion = input.skippedVersion;
  }
  return next;
}

export class UpdatePreferencesStore {
  private static cached: UpdatePreferences | null = null;

  static load(): UpdatePreferences {
    if (this.cached) return this.cached;
    let stored: unknown;
    try {
      stored = SecureSettingsRepository.isInitialized()
        ? SecureSettingsRepository.getInstance().load<UpdatePreferences>(CATEGORY)
        : undefined;
    } catch {
      stored = undefined;
    }
    const preferences = normalizeUpdatePreferences(stored);
    if (SecureSettingsRepository.isInitialized()) this.cached = preferences;
    return preferences;
  }

  /**
   * Merge a change. `skippedVersion: undefined` in the patch clears the skip, so
   * a renderer can only set the two known fields.
   */
  static save(patch: Partial<UpdatePreferences>): UpdatePreferences {
    const current = this.load();
    const merged: Record<string, unknown> = { ...current };
    if ("autoDownload" in patch) merged.autoDownload = patch.autoDownload;
    if ("skippedVersion" in patch) merged.skippedVersion = patch.skippedVersion;
    const next = normalizeUpdatePreferences(merged);
    if (SecureSettingsRepository.isInitialized()) {
      SecureSettingsRepository.getInstance().save(CATEGORY, next);
    }
    this.cached = next;
    return next;
  }

  /** Test hook. */
  static resetCache(): void {
    this.cached = null;
  }
}
