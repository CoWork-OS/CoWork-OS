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
  /** Linux only: the OS secret store Electron picked ("basic_text" when there is none). */
  getSelectedStorageBackend?: () => string;
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
let dataKeyOpenAttempted = false;
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

/**
 * Linux without a Secret Service: Electron falls back to a fixed, built-in key
 * ("basic_text"), which protects nothing, and a key sealed with it is lost when a keyring
 * appears later. The synchronous probe reported no encryption there and the asynchronous
 * one does, so this keeps the old meaning: no OS keychain.
 */
function usesFixedKeyFallback(native: NativeSafeStorage): boolean {
  try {
    const backend = native.getSelectedStorageBackend?.();
    return backend === "basic_text" || backend === "unknown";
  } catch {
    return false;
  }
}

function dataKeySafeStorage(native: NativeSafeStorage, key: Buffer): SafeStorageLike {
  const getSelectedStorageBackend = native.getSelectedStorageBackend;
  return {
    // Callers that refuse the fixed-key fallback (the browser vault) still see the backend.
    ...(typeof getSelectedStorageBackend === "function"
      ? { getSelectedStorageBackend: () => getSelectedStorageBackend.call(native) }
      : {}),
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
  if (!hasSyncApi(native)) return null;
  if (usesFixedKeyFallback(native)) {
    // No OS keychain: answer as the synchronous probe does there, without calling it.
    return {
      getSelectedStorageBackend: () => native.getSelectedStorageBackend?.() ?? "unknown",
      isEncryptionAvailable: () => false,
      encryptString: (plaintext) => native.encryptString(plaintext),
      decryptString: (ciphertext) => native.decryptString(ciphertext),
    };
  }
  return native;
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
 * A durable copy of the sealed data key kept with the secrets it protects (the settings
 * database), so losing the key file never loses them.
 */
export interface DataKeyStore {
  /** The sealed key (base64) stored with the data, or null when none is stored. */
  readSealedKey(): string | null;
  /** Store the sealed key (base64); a no-op when the same key is already stored. */
  storeSealedKey(sealed: string): void;
  /** Whether any stored secret is already sealed with a data key. */
  hasDataKeySealedSecrets(): boolean;
}

function writeDataKeyFile(file: string, sealed: string, flag: "wx" | "w"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ version: 1, sealed } satisfies DataKeyFile);
  if (flag === "wx") {
    fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
    return;
  }
  // Replace atomically: a reader sees the old file or the new one, never half of it.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, file);
}

async function openSealedKey(sealed: string): Promise<Buffer | null> {
  const hex = await decryptOsSealedAsync(Buffer.from(sealed, "base64"));
  const key = hex ? Buffer.from(hex, "hex") : null;
  return key && key.length === 32 ? key : null;
}

/**
 * Open the data key, or create it on first use. Run once at startup, after the macOS
 * Keychain context is primed and before anything reads secure settings.
 *
 * With a `store` (the settings database), its copy of the sealed key is authoritative for
 * the secrets beside it: a missing or different key file is rewritten from it, and a file
 * key is copied into it. A new key is created only when neither exists and no secret is
 * sealed with a data key yet, so a lost file can never silently orphan secrets.
 *
 * Without the async OS API, on Linux's fixed-key fallback ("unavailable"), or when the
 * keychain cannot open the key ("unreadable"), secrets are sealed as before the data key.
 */
export async function initializeSafeStorageDataKey(
  userDataDir: string,
  store?: DataKeyStore,
): Promise<DataKeyStatus> {
  dataKeyOpenAttempted = true;
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
  const stored = store?.readSealedKey() ?? null;
  // No new key on the fixed-key fallback. One that already exists still opens, so the
  // secrets sealed with it stay readable.
  if (usesFixedKeyFallback(native) && !stored && readDataKeyFile(file) === null) {
    return "unavailable";
  }
  if (stored) {
    const key = await openSealedKey(stored);
    if (!key) return "unreadable";
    const existing = readDataKeyFile(file);
    if (!existing || existing === "corrupt" || existing.sealed !== stored) {
      writeDataKeyFile(file, stored, "w");
    }
    setDataKey(key);
    return "loaded";
  }

  // Another process may be writing the file it just created; give it a moment.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = readDataKeyFile(file);
    if (existing === "corrupt") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (existing) {
      const key = await openSealedKey(existing.sealed);
      // Never replace a key file that exists: values sealed with it would be lost.
      if (!key) return "unreadable";
      store?.storeSealedKey(existing.sealed);
      setDataKey(key);
      return "loaded";
    }
    // The key that sealed these secrets is gone (file lost, no stored copy): a new one
    // would leave them unreadable and look like success. Keep the keychain path instead.
    if (store?.hasDataKeySealedSecrets()) return "unreadable";
    const key = randomBytes(32);
    const sealed = (await native.encryptStringAsync(key.toString("hex"))).toString("base64");
    try {
      // Exclusive create: two processes starting at once must end up with one key.
      writeDataKeyFile(file, sealed, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    store?.storeSealedKey(sealed);
    setDataKey(key);
    return "created";
  }
  return "unreadable";
}

/**
 * Adopt a data key another keychain identity sealed (recovered by the legacy-identity
 * worker): re-seal it with the current keychain, store it in both places and use it. The
 * secrets sealed with it become readable again without rewriting any of them.
 */
export async function adoptRecoveredDataKey(
  userDataDir: string,
  keyHex: string,
  store?: DataKeyStore,
): Promise<boolean> {
  const native = getNativeSafeStorage();
  const key = Buffer.from(keyHex, "hex");
  if (!native || typeof native.encryptStringAsync !== "function" || key.length !== 32) {
    return false;
  }
  const sealed = (await native.encryptStringAsync(keyHex)).toString("base64");
  writeDataKeyFile(path.join(userDataDir, SAFE_STORAGE_DATA_KEY_FILE), sealed, "w");
  store?.storeSealedKey(sealed);
  setDataKey(key);
  return true;
}

/** The sealed data key in the key file (base64), for a recovery attempt; null if none. */
export function readSealedDataKeyFile(userDataDir: string): string | null {
  const existing = readDataKeyFile(path.join(userDataDir, SAFE_STORAGE_DATA_KEY_FILE));
  return existing && existing !== "corrupt" ? existing.sealed : null;
}

function setDataKey(key: Buffer): void {
  dataKey = key;
  dataKeyStorage = null;
}

/** Whether this process has tried to open the data key (whatever the outcome). */
export function wasDataKeyOpenAttempted(): boolean {
  return dataKeyOpenAttempted;
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
  dataKeyOpenAttempted = false;
  dataKeyStorage = null;
  loggedLegacyRead = false;
}
