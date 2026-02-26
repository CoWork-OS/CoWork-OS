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
