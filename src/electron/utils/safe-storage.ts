/**
 * safeStorage helper
 *
 * In Electron main process, `require('electron').safeStorage` is available.
 * In a plain Node.js process, the `electron` package (if installed) resolves to the Electron binary path
 * rather than Electron's runtime APIs, so `safeStorage` will be unavailable.
 *
 * This helper lets us share code between Electron and future Node-only daemons without hard-depending on Electron.
 *
 * Data key: Electron 45 deprecates, and 46 removes, the synchronous safeStorage calls, while
 * settings are read synchronously all over the main process. So secrets are sealed with one
 * random AES-256 data key instead, which is itself sealed by safeStorage (the OS keychain)
 * and opened once, asynchronously, at startup (`initializeSafeStorageDataKey`). After that,
 * `getSafeStorage()` encrypts and decrypts synchronously in process. Ciphertexts it writes
 * start with `ck1:`; values still sealed by the OS keychain directly are re-encrypted at
 * startup (safe-storage-rewrap.ts) and, until then, read through the synchronous OS call
 * where Electron still has it.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import fs from "fs";
import path from "path";

export type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plaintext: string) => Buffer;
  decryptString: (ciphertext: Buffer) => string;
};

/** Electron's safeStorage, including the async API from Electron 45 on. */
type NativeSafeStorage = Partial<SafeStorageLike> & {
  isAsyncEncryptionAvailable?: () => Promise<boolean>;
  encryptStringAsync?: (plaintext: string) => Promise<Buffer>;
  decryptStringAsync?: (ciphertext: Buffer) => Promise<{ result: string } | string>;
};

export type DataKeyStatus = "loaded" | "created" | "unavailable" | "unreadable";

/** OS keychain blobs start with "v1"; these bytes never do. */
const DATA_KEY_MAGIC = Buffer.from("ck1:", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const SAFE_STORAGE_DATA_KEY_FILE = "safe-storage-key.json";

let dataKey: Buffer | null = null;
let nativeOverride: NativeSafeStorage | null | undefined;
let dataKeyStorage: SafeStorageLike | null = null;
let loggedLegacyRead = false;

function keychainDisabled(): boolean {
  const value = (process.env.COWORK_DISABLE_OS_KEYCHAIN || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function getNativeSafeStorage(): NativeSafeStorage | null {
  if (keychainDisabled()) return null;
  if (nativeOverride !== undefined) return nativeOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // oxlint-disable-next-line typescript/no-require-imports
    const electron = require("electron") as Any;
    const safeStorage = electron?.safeStorage;
    return safeStorage && typeof safeStorage === "object"
      ? (safeStorage as NativeSafeStorage)
      : null;
  } catch {
    return null;
  }
}

function hasSyncApi(native: NativeSafeStorage): native is NativeSafeStorage & SafeStorageLike {
  return (
    typeof native.isEncryptionAvailable === "function" &&
    typeof native.encryptString === "function" &&
    typeof native.decryptString === "function"
  );
}

/** Whether a ciphertext was sealed with the data key (and not by the OS keychain). */
export function isDataKeySealed(ciphertext: Buffer): boolean {
  return (
    ciphertext.length >= DATA_KEY_MAGIC.length + IV_BYTES + TAG_BYTES &&
    ciphertext.subarray(0, DATA_KEY_MAGIC.length).equals(DATA_KEY_MAGIC)
  );
}

function seal(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([DATA_KEY_MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

function open(key: Buffer, ciphertext: Buffer): string {
  const ivStart = DATA_KEY_MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const dataStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(ivStart, tagStart));
  decipher.setAuthTag(ciphertext.subarray(tagStart, dataStart));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(dataStart)),
    decipher.final(),
  ]).toString("utf8");
}

function dataKeySafeStorage(native: NativeSafeStorage, key: Buffer): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => seal(key, plaintext),
    decryptString: (ciphertext) => {
      if (isDataKeySealed(ciphertext)) return open(key, ciphertext);
      // A value the startup rewrap has not reached yet (written by an older version or by
      // a process without the data key). Electron 45 can still read it synchronously.
      if (typeof native.decryptString !== "function") {
        throw new Error(
          "This secret is still sealed by the OS keychain directly, and this Electron version cannot read it synchronously.",
        );
      }
      if (!loggedLegacyRead) {
        loggedLegacyRead = true;
        console.warn(
          "[safe-storage] Read a secret still sealed by the OS keychain directly; it is re-encrypted with the data key at the next start.",
        );
      }
      return native.decryptString(ciphertext);
    },
  };
}

export function getSafeStorage(): SafeStorageLike | null {
  const native = getNativeSafeStorage();
  if (!native) return null;
  if (dataKey) {
    dataKeyStorage ??= dataKeySafeStorage(native, dataKey);
    return dataKeyStorage;
  }
  // Before the data key is open (or in a process that never opens it), the OS keychain
  // seals values directly; the next start re-encrypts them with the data key.
  return hasSyncApi(native) ? native : null;
}

/** Whether this Electron has the asynchronous safeStorage API (Electron 45 and later). */
export function hasAsyncSafeStorage(): boolean {
  const native = getNativeSafeStorage();
  return !!native && typeof native.decryptStringAsync === "function";
}

/**
 * Decrypt a value sealed by the OS keychain directly, without the deprecated synchronous
 * call. Returns null when the OS keychain cannot read it (another keychain identity).
 */
export async function decryptOsSealedAsync(ciphertext: Buffer): Promise<string | null> {
  const native = getNativeSafeStorage();
  if (!native || typeof native.decryptStringAsync !== "function") return null;
  try {
    const opened = await native.decryptStringAsync(ciphertext);
    return typeof opened === "string" ? opened : opened.result;
  } catch {
    return null;
  }
}

type DataKeyFile = { version: 1; sealed: string };

function readDataKeyFile(file: string): DataKeyFile | null | "corrupt" {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DataKeyFile>;
    return parsed?.version === 1 && typeof parsed.sealed === "string"
      ? (parsed as DataKeyFile)
      : "corrupt";
  } catch {
    return "corrupt";
  }
}

/**
 * Open the data key, or create it on first use. Run once at startup, after the macOS
 * Keychain context is primed and before anything reads secure settings. Without the
 * async OS API, or when the key file is sealed by a keychain this process cannot use,
 * secrets stay sealed by the OS keychain directly, as before.
 */
export async function initializeSafeStorageDataKey(userDataDir: string): Promise<DataKeyStatus> {
  const native = getNativeSafeStorage();
  if (
    !native ||
    typeof native.isAsyncEncryptionAvailable !== "function" ||
    typeof native.encryptStringAsync !== "function" ||
    typeof native.decryptStringAsync !== "function"
  ) {
    return "unavailable";
  }
  if (!(await native.isAsyncEncryptionAvailable())) return "unavailable";

  const file = path.join(userDataDir, SAFE_STORAGE_DATA_KEY_FILE);
  // Another process may be writing the file it just created; give it a moment.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = readDataKeyFile(file);
    if (existing === "corrupt") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (existing) {
      const hex = await decryptOsSealedAsync(Buffer.from(existing.sealed, "base64"));
      const key = hex ? Buffer.from(hex, "hex") : null;
      // Never replace a key file that exists: values sealed with it would be lost.
      if (!key || key.length !== 32) return "unreadable";
      setDataKey(key);
      return "loaded";
    }
    const key = randomBytes(32);
    const sealed = await native.encryptStringAsync(key.toString("hex"));
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      // Exclusive create: two processes starting at once must end up with one key.
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, sealed: sealed.toString("base64") } satisfies DataKeyFile),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    setDataKey(key);
    return "created";
  }
  return "unreadable";
}

function setDataKey(key: Buffer): void {
  dataKey = key;
  dataKeyStorage = null;
}

/** Whether `getSafeStorage()` seals with the data key in this process. */
export function hasSafeStorageDataKey(): boolean {
  return dataKey !== null;
}

/** Tests: use a fake Electron safeStorage (`undefined` restores the real one). */
export function setNativeSafeStorageForTests(native: NativeSafeStorage | null | undefined): void {
  nativeOverride = native;
}

export function resetSafeStorageDataKeyForTests(): void {
  dataKey = null;
  dataKeyStorage = null;
  loggedLegacyRead = false;
}
