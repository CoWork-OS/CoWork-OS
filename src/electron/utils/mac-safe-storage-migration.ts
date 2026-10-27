import { createHash } from "crypto";
import fs from "fs";
import { spawn, type ChildProcess } from "child_process";
import type {
  SecureSettingsRepository,
  SettingsCategory,
} from "../database/SecureSettingsRepository";
import {
  decryptOsSealedAsync,
  hasAsyncSafeStorage,
  isDataKeySealed,
  type SafeStorageLike,
} from "./safe-storage";
import {
  LEGACY_MAC_SAFE_STORAGE_APP_NAME,
  LEGACY_MAC_SAFE_STORAGE_APP_NAMES,
  MAC_SAFE_STORAGE_MIGRATION_WORKER_FLAG,
} from "./mac-safe-storage-identity";

export const MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX = "COWORK_SAFE_STORAGE_MIGRATION_RESULT=";

export interface EncryptedSecureSettingRow {
  category: string;
  encrypted_data: string;
  checksum: string;
  /** "text" rows (mailbox content) come back as `{ text }` instead of parsed JSON settings. */
  format?: "json" | "text";
}

export interface DecryptedSecureSetting {
  category: string;
  settings: Record<string, unknown>;
}

interface MigrationDatabase {
  prepare(sql: string): { all(): unknown[] };
}

interface ChannelMigrationDatabase {
  prepare(sql: string): unknown;
}

interface MigrationRepository {
  loadWithStatus<T extends object>(
    category: SettingsCategory,
    options?: { logErrors?: boolean },
  ): { status: string; data?: T };
  save<T extends object>(
    category: SettingsCategory,
    settings: T,
    options?: { allowUnreadableOverwrite?: boolean },
  ): void;
}

interface MigrationLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

type SpawnProcess = typeof spawn;

/**
 * Whether the current identity can read a stored ciphertext. Data-key values always can;
 * others are tried with the asynchronous OS call, so probing a value another keychain
 * identity sealed never reaches the deprecated synchronous one.
 */
async function readableWithCurrentIdentity(
  safeStorage: SafeStorageLike,
  sealed: Buffer,
): Promise<boolean> {
  if (isDataKeySealed(sealed)) return true;
  if (hasAsyncSafeStorage()) return (await decryptOsSealedAsync(sealed)) !== null;
  try {
    safeStorage.decryptString(sealed);
    return true;
  } catch {
    return false;
  }
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Decrypts only valid, integrity-checked `os:` settings under the legacy Keychain identity.
 * `decrypt` is the asynchronous OS call; it yields null for a row it cannot read.
 */
export async function decryptLegacyMacSafeStorageRows(
  rows: EncryptedSecureSettingRow[],
  decrypt: (sealed: Buffer) => Promise<string | null>,
): Promise<DecryptedSecureSetting[]> {
  const decryptedRows: DecryptedSecureSetting[] = [];
  for (const row of rows) {
    if (!row || typeof row.category !== "string" || !row.encrypted_data?.startsWith("os:")) {
      continue;
    }

    try {
      const plaintext = await decrypt(Buffer.from(row.encrypted_data.slice(3), "base64"));
      // A row encrypted under another Keychain identity is expected to stay unreadable.
      if (plaintext === null) continue;
      if (checksum(row.encrypted_data) !== row.checksum && checksum(plaintext) !== row.checksum) {
        continue;
      }
      if (row.format === "text") {
        decryptedRows.push({ category: row.category, settings: { text: plaintext } });
        continue;
      }
      const settings: unknown = JSON.parse(plaintext);
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
      decryptedRows.push({ category: row.category, settings: settings as Record<string, unknown> });
    } catch {
      // A row encrypted under another Keychain identity is expected to fail here.
    }
  }
  return decryptedRows;
}

function runLegacyKeychainWorker(
  executable: string,
  appPath: string,
  rows: EncryptedSecureSettingRow[],
  spawnProcess: SpawnProcess = spawn,
  env: NodeJS.ProcessEnv = process.env,
  legacyAppName: string = LEGACY_MAC_SAFE_STORAGE_APP_NAME,
): Promise<DecryptedSecureSetting[]> {
  return new Promise((resolve, reject) => {
    const workerEnv = { ...env };
    // Electron interprets this variable by presence in some launch modes.
    // The worker must start the app runtime to get app/safeStorage APIs.
    delete workerEnv.ELECTRON_RUN_AS_NODE;

    let child: ChildProcess;
    try {
      child = spawnProcess(
        executable,
        [appPath, MAC_SAFE_STORAGE_MIGRATION_WORKER_FLAG, legacyAppName],
        {
          env: workerEnv,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Legacy Keychain migration worker timed out")));
    }, 30_000);
    timeout.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += String(chunk);
    });
    child.stdin?.on("error", () => {
      // The close event reports a worker that exited before consuming its input.
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(
            new Error(`Legacy Keychain migration worker exited with code ${code ?? "unknown"}`),
          );
          return;
        }
        const resultLine = stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith(MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX));
        if (!resultLine) {
          reject(new Error("Legacy Keychain migration worker returned no result"));
          return;
        }
        try {
          const result: unknown = JSON.parse(
            resultLine.slice(MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX.length),
          );
          if (!Array.isArray(result)) throw new Error("Invalid migration result");
          resolve(
            result.filter(
              (item): item is DecryptedSecureSetting =>
                !!item &&
                typeof item === "object" &&
                typeof item.category === "string" &&
                !!item.settings &&
                typeof item.settings === "object" &&
                !Array.isArray(item.settings),
            ),
          );
        } catch {
          reject(new Error("Legacy Keychain migration worker returned invalid data"));
        }
      });
    });

    child.stdin?.end(JSON.stringify(rows));
  });
}

/**
 * Move settings readable with the former `cowork-os` Keychain identity into
 * the current `CoWork OS` identity. Existing current-keychain values win.
 */
/**
 * Unseal the secrets data key (utils/safe-storage) under a former macOS Keychain identity,
 * for when the current identity cannot open it. Returns the key (hex) or null. The caller
 * re-seals it with the current keychain, so nothing sealed with it has to be rewritten.
 */
export async function recoverDataKeyFromLegacyIdentity(options: {
  platform: NodeJS.Platform;
  sealedKey: string;
  executable: string;
  appPath: string;
  logger: MigrationLogger;
  legacyAppNames?: readonly string[];
  spawnProcess?: SpawnProcess;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  if (options.platform !== "darwin") return null;
  // The worker protocol carries it as a text row; nothing about it is a setting.
  const encrypted_data = `os:${options.sealedKey}`;
  const row: EncryptedSecureSettingRow = {
    category: "data-key",
    encrypted_data,
    checksum: checksum(encrypted_data),
    format: "text",
  };
  const legacyAppNames = [...new Set(options.legacyAppNames ?? LEGACY_MAC_SAFE_STORAGE_APP_NAMES)];
  for (const legacyAppName of legacyAppNames) {
    try {
      const [opened] = await runLegacyKeychainWorker(
        options.executable,
        options.appPath,
        [row],
        options.spawnProcess,
        options.env,
        legacyAppName,
      );
      const text = opened?.settings?.text;
      if (typeof text === "string" && /^[0-9a-f]{64}$/.test(text)) {
        options.logger.info(
          "Recovered the secrets data key from a legacy macOS Keychain identity.",
          {
            legacyAppName,
          },
        );
        return text;
      }
    } catch {
      // This identity cannot read it either; try the next.
    }
  }
  return null;
}

export async function migrateLegacyMacSafeStorageSettings(options: {
  platform: NodeJS.Platform;
  database: MigrationDatabase;
  repository: Pick<SecureSettingsRepository, "loadWithStatus" | "save"> | MigrationRepository;
  executable: string;
  appPath: string;
  logger: MigrationLogger;
  legacyAppNames?: readonly string[];
  spawnProcess?: SpawnProcess;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  if (options.platform !== "darwin") return 0;

  // Only rows the current identity cannot read need a legacy worker; skipping
  // readable rows avoids launching one helper process per identity on every start.
  const rows = (
    options.database
      .prepare(
        "SELECT category, encrypted_data, checksum FROM secure_settings WHERE encrypted_data LIKE 'os:%'",
      )
      .all() as EncryptedSecureSettingRow[]
  ).filter((row) => {
    const status = options.repository.loadWithStatus(row.category as SettingsCategory, {
      logErrors: false,
    }).status;
    return status !== "success" && status !== "not_found";
  });
  if (rows.length === 0) return 0;

  let migratedCount = 0;
  const migratedFrom: string[] = [];
  const legacyAppNames = [...new Set(options.legacyAppNames ?? LEGACY_MAC_SAFE_STORAGE_APP_NAMES)];
  for (const legacyAppName of legacyAppNames) {
    let legacySettings: DecryptedSecureSetting[];
    try {
      legacySettings = await runLegacyKeychainWorker(
        options.executable,
        options.appPath,
        rows,
        options.spawnProcess,
        options.env,
        legacyAppName,
      );
    } catch {
      options.logger.warn(
        "Could not inspect a legacy macOS Keychain identity; encrypted data was left untouched.",
        { legacyAppName },
      );
      continue;
    }

    let migratedFromIdentity = false;
    for (const { category, settings } of legacySettings) {
      const result = options.repository.loadWithStatus(category as SettingsCategory, {
        logErrors: false,
      });
      if (result.status === "success" || result.status === "not_found") continue;

      try {
        options.repository.save(category as SettingsCategory, settings, {
          allowUnreadableOverwrite: true,
        });
        migratedCount += 1;
        migratedFromIdentity = true;
      } catch {
        options.logger.warn(
          "Could not re-encrypt a legacy macOS Keychain setting; encrypted data was left untouched.",
          {
            category,
          },
        );
      }
    }
    if (migratedFromIdentity) migratedFrom.push(legacyAppName);
  }

  if (migratedCount > 0) {
    options.logger.info("Migrated encrypted settings from the legacy macOS Keychain identity.", {
      migratedCount,
      legacyAppNames: migratedFrom,
    });
  }
  return migratedCount;
}

/**
 * Encrypted channel configs (`enc:` + base64) and their conditional rewrite, shared by the
 * legacy-identity migration and the data key rewrap (safe-storage-rewrap.ts).
 */
export function encryptedChannelConfigs(database: ChannelMigrationDatabase): {
  list(): Array<{ id: string; config: string }>;
  /** Writes `next` only if the stored config is still `previous`; true when it wrote. */
  replaceIfUnchanged(id: string, next: string, previous: string): boolean;
} {
  return {
    list: () =>
      (
        database.prepare("SELECT id, config FROM channels WHERE config LIKE 'enc:%'") as {
          all(): unknown[];
        }
      ).all() as Array<{ id: string; config: string }>,
    replaceIfUnchanged: (id, next, previous) => {
      const result = (
        database.prepare(
          "UPDATE channels SET config = ?, updated_at = ? WHERE id = ? AND config = ?",
        ) as { run(...params: unknown[]): { changes?: number } | void }
      ).run(next, Date.now(), id, previous);
      return !!result && typeof result.changes === "number" && result.changes > 0;
    },
  };
}

/**
 * Re-encrypt channel configs that are still readable only with the former
 * `cowork-os` Keychain identity. Writes are conditional on the original value
 * remaining unchanged, and unreadable rows are always preserved.
 */
export async function migrateLegacyMacSafeStorageChannels(options: {
  platform: NodeJS.Platform;
  database: ChannelMigrationDatabase;
  safeStorage: SafeStorageLike | null;
  executable: string;
  appPath: string;
  logger: MigrationLogger;
  legacyAppNames?: readonly string[];
  spawnProcess?: SpawnProcess;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  if (
    options.platform !== "darwin" ||
    !options.safeStorage ||
    !options.safeStorage.isEncryptionAvailable()
  ) {
    return 0;
  }
  const safeStorage = options.safeStorage;

  const channels = encryptedChannelConfigs(options.database);
  const rows = channels.list();
  if (rows.length === 0) return 0;

  const unreadableRows: typeof rows = [];
  for (const row of rows) {
    if (typeof row?.id !== "string" || typeof row.config !== "string") continue;
    if (!row.config.startsWith("enc:")) continue;
    const sealed = Buffer.from(row.config.slice("enc:".length), "base64");
    if (!(await readableWithCurrentIdentity(safeStorage, sealed))) unreadableRows.push(row);
  }
  const encryptedRows: EncryptedSecureSettingRow[] = unreadableRows.map((row) => {
    const encrypted_data = `os:${row.config.slice("enc:".length)}`;
    return { category: row.id, encrypted_data, checksum: checksum(encrypted_data) };
  });
  if (encryptedRows.length === 0) return 0;

  let migratedCount = 0;
  const legacyAppNames = [...new Set(options.legacyAppNames ?? LEGACY_MAC_SAFE_STORAGE_APP_NAMES)];
  for (const legacyAppName of legacyAppNames) {
    let legacyConfigs: DecryptedSecureSetting[];
    try {
      legacyConfigs = await runLegacyKeychainWorker(
        options.executable,
        options.appPath,
        encryptedRows,
        options.spawnProcess,
        options.env,
        legacyAppName,
      );
    } catch {
      options.logger.warn(
        "Could not inspect a legacy macOS Keychain identity for channel configs; encrypted data was left untouched.",
        { legacyAppName },
      );
      continue;
    }

    const legacyById = new Map(legacyConfigs.map((item) => [item.category, item.settings]));
    for (const row of rows) {
      const config = legacyById.get(row.id);
      if (!config || typeof config !== "object" || Array.isArray(config)) continue;

      try {
        const currentCiphertext = safeStorage
          .encryptString(JSON.stringify(config))
          .toString("base64");
        if (channels.replaceIfUnchanged(row.id, `enc:${currentCiphertext}`, row.config)) {
          migratedCount += 1;
        }
      } catch {
        options.logger.warn(
          "Could not re-encrypt a legacy macOS Keychain channel config; encrypted data was left untouched.",
        );
      }
    }
  }

  if (migratedCount > 0) {
    options.logger.info("Migrated channel configs from the legacy macOS Keychain identity.", {
      migratedCount,
      legacyAppName: LEGACY_MAC_SAFE_STORAGE_APP_NAME,
    });
  }
  return migratedCount;
}

const MAILBOX_OS_CIPHER_PREFIX = "mbox:os:";

/**
 * Mailbox data access for the migration, through the mailbox statement catalog (so the
 * work runs where mailbox SQL runs, not as extra synchronous queries on the host).
 */
export interface MailboxEncryptedValueStore<Target extends string = string> {
  targets: readonly Target[];
  list(target: Target): Promise<Array<{ key: string; value: string }>>;
  /** Writes `next` only if the stored value is still `previous`; true when it wrote. */
  replaceIfUnchanged(target: Target, key: string, next: string, previous: string): Promise<boolean>;
}

/** Remembers which set of unreadable mailbox values was last tried. */
export interface MailboxMigrationAttemptStore {
  read(): string | null;
  write(fingerprint: string): void;
}

/** File-backed attempt store; the file holds one hash, never mailbox content. */
export function createMailboxMigrationAttemptStore(filePath: string): MailboxMigrationAttemptStore {
  return {
    read: () => {
      try {
        return fs.readFileSync(filePath, "utf8").trim() || null;
      } catch {
        return null;
      }
    },
    write: (fingerprint) => {
      try {
        if (fingerprint) fs.writeFileSync(filePath, fingerprint, { mode: 0o600 });
        else fs.rmSync(filePath, { force: true });
      } catch {
        // Best effort: without it the next launch simply tries again.
      }
    },
  };
}

/**
 * Re-encrypt mailbox content that the current Keychain identity cannot read but a
 * former one can (the app ran under other names over time, each with its own key).
 * Updates are conditional on the stored value being unchanged; anything no identity
 * can read is left as it is.
 *
 * Values that stay unreadable would otherwise start one helper per identity on every
 * launch, so the set that was tried is remembered (as hashes) and skipped until it
 * or the identity list changes.
 */
export async function migrateLegacyMacSafeStorageMailbox<Target extends string>(options: {
  platform: NodeJS.Platform;
  store: MailboxEncryptedValueStore<Target>;
  safeStorage: SafeStorageLike | null;
  executable: string;
  appPath: string;
  logger: MigrationLogger;
  attempts?: MailboxMigrationAttemptStore;
  legacyAppNames?: readonly string[];
  spawnProcess?: SpawnProcess;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  if (
    options.platform !== "darwin" ||
    !options.safeStorage ||
    !options.safeStorage.isEncryptionAvailable()
  ) {
    return 0;
  }
  const safeStorage = options.safeStorage;
  const canDecrypt = (value: string): Promise<boolean> =>
    readableWithCurrentIdentity(
      safeStorage,
      Buffer.from(value.slice(MAILBOX_OS_CIPHER_PREFIX.length), "base64"),
    );

  type Pending = { target: Target; key: string; value: string; row: EncryptedSecureSettingRow };
  const pending = new Map<string, Pending>();
  for (const target of options.store.targets) {
    let rows: Array<{ key: unknown; value: unknown }>;
    try {
      rows = await options.store.list(target);
    } catch {
      continue; // Table not created in this profile yet.
    }
    for (const { key, value } of rows) {
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!value.startsWith(MAILBOX_OS_CIPHER_PREFIX) || (await canDecrypt(value))) continue;
      const encrypted_data = `os:${value.slice(MAILBOX_OS_CIPHER_PREFIX.length)}`;
      const id = JSON.stringify([target, key]);
      pending.set(id, {
        target,
        key,
        value,
        row: { category: id, encrypted_data, checksum: checksum(encrypted_data), format: "text" },
      });
    }
  }
  if (pending.size === 0) return 0;

  const legacyAppNames = [...new Set(options.legacyAppNames ?? LEGACY_MAC_SAFE_STORAGE_APP_NAMES)];
  const fingerprintPending = (): string =>
    checksum(
      JSON.stringify([
        legacyAppNames,
        [...pending.values()].map((item) => item.row.checksum).sort(),
      ]),
    );
  if (options.attempts?.read() === fingerprintPending()) return 0;

  let migratedCount = 0;
  const migratedFrom: string[] = [];
  for (const legacyAppName of legacyAppNames) {
    if (pending.size === 0) break;
    let recovered: DecryptedSecureSetting[];
    try {
      recovered = await runLegacyKeychainWorker(
        options.executable,
        options.appPath,
        [...pending.values()].map((item) => item.row),
        options.spawnProcess,
        options.env,
        legacyAppName,
      );
    } catch {
      options.logger.warn(
        "Could not inspect a legacy macOS Keychain identity for mailbox content; encrypted data was left untouched.",
        { legacyAppName },
      );
      continue;
    }

    let migratedFromIdentity = false;
    for (const { category, settings } of recovered) {
      const item = pending.get(category);
      const text = (settings as { text?: unknown }).text;
      if (!item || typeof text !== "string") continue;
      try {
        const ciphertext = safeStorage.encryptString(text).toString("base64");
        const written = await options.store.replaceIfUnchanged(
          item.target,
          item.key,
          `${MAILBOX_OS_CIPHER_PREFIX}${ciphertext}`,
          item.value,
        );
        pending.delete(category);
        if (written) {
          migratedCount += 1;
          migratedFromIdentity = true;
        }
      } catch {
        options.logger.warn(
          "Could not re-encrypt legacy macOS Keychain mailbox content; encrypted data was left untouched.",
          { target: item.target },
        );
      }
    }
    if (migratedFromIdentity) migratedFrom.push(legacyAppName);
  }

  if (migratedCount > 0) {
    options.logger.info("Migrated mailbox content from legacy macOS Keychain identities.", {
      migratedCount,
      legacyAppNames: migratedFrom,
    });
  }
  if (pending.size > 0) {
    options.logger.warn(
      "Some mailbox content is encrypted with a Keychain key no known identity can read; it stays hidden until the account re-syncs.",
      { unreadableCount: pending.size },
    );
  }
  // Only the leftovers matter next time: a clean run leaves nothing to remember.
  options.attempts?.write(pending.size === 0 ? "" : fingerprintPending());
  return migratedCount;
}

export async function runMacSafeStorageMigrationWorker(options: {
  platform: NodeJS.Platform;
  decrypt: (sealed: Buffer) => Promise<string | null>;
  readInput: () => Promise<string>;
  writeResult: (result: string) => void;
}): Promise<void> {
  if (options.platform !== "darwin") {
    throw new Error("Legacy macOS Keychain migration can only run on macOS");
  }
  const input = await options.readInput();
  const parsed: unknown = JSON.parse(input);
  if (!Array.isArray(parsed)) throw new Error("Invalid migration input");
  const rows = parsed.filter(
    (item): item is EncryptedSecureSettingRow =>
      !!item &&
      typeof item === "object" &&
      typeof item.category === "string" &&
      typeof item.encrypted_data === "string" &&
      typeof item.checksum === "string" &&
      (item.format === undefined || item.format === "json" || item.format === "text"),
  );
  const result = await decryptLegacyMacSafeStorageRows(rows, options.decrypt);
  options.writeResult(`${MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify(result)}\n`);
}
