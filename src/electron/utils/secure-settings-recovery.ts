import type { LoadStatus, SettingsCategory } from "../database/SecureSettingsRepository";

export interface SecureSettingsRecoveryRepository {
  checkHealth(category: SettingsCategory, options?: { logErrors?: boolean }): LoadStatus;
  delete(category: SettingsCategory): boolean;
}

export interface SecureSettingsRecoveryResult {
  resetCategories: SettingsCategory[];
  preservedCategories: Array<{ category: SettingsCategory; status: LoadStatus }>;
}

/**
 * Reset known-recoverable settings only after a checksum mismatch proves that
 * the stored row is damaged. Decryption failures can mean the app identity or
 * OS keychain is temporarily unavailable, so those rows must be preserved.
 */
export function resetUnreadableSettings(
  repository: SecureSettingsRecoveryRepository,
  categories: SettingsCategory[],
): SecureSettingsRecoveryResult {
  const resetCategories: SettingsCategory[] = [];
  const preservedCategories: Array<{ category: SettingsCategory; status: LoadStatus }> = [];

  for (const category of categories) {
    const status = repository.checkHealth(category, { logErrors: false });
    if (status === "checksum_mismatch") {
      if (repository.delete(category)) {
        resetCategories.push(category);
      }
    } else if (status === "decryption_failed" || status === "os_encryption_unavailable") {
      preservedCategories.push({ category, status });
    }
  }

  return { resetCategories, preservedCategories };
}
