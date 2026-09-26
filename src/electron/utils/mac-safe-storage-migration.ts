import { createHash } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import type {
  SecureSettingsRepository,
  SettingsCategory,
} from "../database/SecureSettingsRepository";
import type { SafeStorageLike } from "./safe-storage";
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

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Decrypts only valid, integrity-checked `os:` settings under the legacy Keychain identity. */
export function decryptLegacyMacSafeStorageRows(
  rows: EncryptedSecureSettingRow[],
  safeStorage: SafeStorageLike,
): DecryptedSecureSetting[] {
  if (!safeStorage.isEncryptionAvailable()) return [];

  const decryptedRows: DecryptedSecureSetting[] = [];
  for (const row of rows) {
    if (!row || typeof row.category !== "string" || !row.encrypted_data?.startsWith("os:")) {
      continue;
    }

    try {
      const plaintext = safeStorage.decryptString(
        Buffer.from(row.encrypted_data.slice(3), "base64"),
      );
      if (checksum(row.encrypted_data) !== row.checksum && checksum(plaintext) !== row.checksum) {
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
 * Re-encrypt channel configs that are still readable only with the former
 * `cowork-os` Keychain identity. Writes are conditional on the original value
 * remaining unchanged, and unreadable rows are always preserved.
 */
export async function migrateLegacyMacSafeStorageChannels(options: {
  platform: NodeJS.Platform;
  database: ChannelMigrationDatabase;
  safeStorage: SafeStorageLike;
  executable: string;
  appPath: string;
  logger: MigrationLogger;
  legacyAppNames?: readonly string[];
  spawnProcess?: SpawnProcess;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  if (options.platform !== "darwin" || !options.safeStorage.isEncryptionAvailable()) return 0;

  const rows = (
    options.database.prepare("SELECT id, config FROM channels WHERE config LIKE 'enc:%'") as {
      all(): unknown[];
    }
  ).all() as Array<{ id: string; config: string }>;
  if (rows.length === 0) return 0;

  const canDecryptWithCurrentIdentity = (config: string): boolean => {
    try {
      options.safeStorage.decryptString(Buffer.from(config.slice("enc:".length), "base64"));
      return true;
    } catch {
      return false;
    }
  };
  const encryptedRows: EncryptedSecureSettingRow[] = rows
    .filter(
      (row) =>
        typeof row?.id === "string" &&
        typeof row.config === "string" &&
        row.config.startsWith("enc:") &&
        !canDecryptWithCurrentIdentity(row.config),
    )
    .map((row) => {
      const encrypted_data = `os:${row.config.slice("enc:".length)}`;
      return { category: row.id, encrypted_data, checksum: checksum(encrypted_data) };
    });
  if (encryptedRows.length === 0) return 0;

  const update = options.database.prepare(
    "UPDATE channels SET config = ?, updated_at = ? WHERE id = ? AND config = ?",
  ) as {
    run(...params: unknown[]): { changes?: number } | void;
  };
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
        const currentCiphertext = options.safeStorage
          .encryptString(JSON.stringify(config))
          .toString("base64");
        const result = update.run(`enc:${currentCiphertext}`, Date.now(), row.id, row.config);
        if (result && typeof result.changes === "number" && result.changes > 0) {
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

export async function runMacSafeStorageMigrationWorker(options: {
  platform: NodeJS.Platform;
  safeStorage: SafeStorageLike;
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
      typeof item.checksum === "string",
  );
  const result = decryptLegacyMacSafeStorageRows(rows, options.safeStorage);
  options.writeResult(`${MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify(result)}\n`);
}
