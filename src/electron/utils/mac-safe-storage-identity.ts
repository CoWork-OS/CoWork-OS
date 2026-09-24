export const LEGACY_MAC_SAFE_STORAGE_APP_NAME = "cowork-os";
/**
 * SafeStorage rows can outlive the Electron bundle identity used by the
 * development build that created them. Keep this list limited to identities
 * used by known CoWork/Electron launch modes; migration leaves rows untouched
 * unless decryption and integrity checks both succeed.
 */
export const LEGACY_MAC_SAFE_STORAGE_APP_NAMES = [
  LEGACY_MAC_SAFE_STORAGE_APP_NAME,
  "Electron",
] as const;
export const MAC_SAFE_STORAGE_MIGRATION_WORKER_FLAG = "--cowork-safe-storage-migration-worker";
