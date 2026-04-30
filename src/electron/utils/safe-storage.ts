/**
 * safeStorage helper
 *
 * In Electron main process, `require('electron').safeStorage` is available.
 * In a plain Node.js process, the `electron` package (if installed) resolves to the Electron binary path
 * rather than Electron's runtime APIs, so `safeStorage` will be unavailable.
 *
 * This helper lets us share code between Electron and future Node-only daemons without hard-depending on Electron.
 */

export type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plaintext: string) => Buffer;
  decryptString: (ciphertext: Buffer) => string;
};

const LEGACY_MACOS_SAFE_STORAGE_APP_NAMES = ["Electron", "cowork-os", "CoWork OS"];
const loggedFallbackNames = new Set<string>();

export function getSafeStorage(): SafeStorageLike | null {
  const keychainDisabled = (process.env.COWORK_DISABLE_OS_KEYCHAIN || "").trim().toLowerCase();
  if (keychainDisabled === "1" || keychainDisabled === "true" || keychainDisabled === "yes") {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const safeStorage = electron?.safeStorage;

    if (!safeStorage) return null;
    if (typeof safeStorage.isEncryptionAvailable !== "function") return null;
    if (typeof safeStorage.encryptString !== "function") return null;
    if (typeof safeStorage.decryptString !== "function") return null;

    return safeStorage as SafeStorageLike;
  } catch {
    return null;
  }
}

function getElectronApp(): { getName?: () => string; setName?: (name: string) => void } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    return electron?.app ?? null;
  } catch {
    return null;
  }
}

/**
 * Decrypt with Electron safeStorage, with macOS compatibility for data encrypted
 * before/after the dev app name changed from Electron to CoWork OS.
 */
export function decryptSafeStorageString(
  safeStorage: SafeStorageLike,
  ciphertext: Buffer,
  appOverride?: { getName?: () => string; setName?: (name: string) => void } | null,
): string {
  try {
    return safeStorage.decryptString(ciphertext);
  } catch (primaryError) {
    if (process.platform !== "darwin") {
      throw primaryError;
    }

    const app = appOverride ?? getElectronApp();
    if (typeof app?.getName !== "function" || typeof app.setName !== "function") {
      throw primaryError;
    }

    const originalName = app.getName();
    for (const fallbackName of LEGACY_MACOS_SAFE_STORAGE_APP_NAMES) {
      if (!fallbackName || fallbackName === originalName) continue;

      try {
        app.setName(fallbackName);
        const decrypted = safeStorage.decryptString(ciphertext);
        if (!loggedFallbackNames.has(fallbackName)) {
          loggedFallbackNames.add(fallbackName);
          console.warn(
            `[safeStorage] Decrypted settings using legacy macOS app name "${fallbackName}".`,
          );
        }
        return decrypted;
      } catch {
        // Try the next known app name, then rethrow the original failure below.
      } finally {
        try {
          app.setName(originalName);
        } catch {
          // Best effort only; app name restoration should not mask the decrypt failure.
        }
      }
    }

    throw primaryError;
  }
}
