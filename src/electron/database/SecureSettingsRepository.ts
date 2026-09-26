/**
 * SecureSettingsRepository
 *
 * Stores all application settings in an encrypted format in the database.
 * Uses Electron's safeStorage API which leverages the OS keychain:
 * - macOS: Keychain
 * - Windows: DPAPI (Data Protection API)
 * - Linux: libsecret
 *
 * This ensures settings can ONLY be accessed by this app.
 */

import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../utils/user-data-dir";
import { getSafeStorage, type SafeStorageLike } from "../utils/safe-storage";
import { createLogger } from "../utils/logger";

/** Result status for load operations */
export type LoadStatus =
  | "success"
  | "not_found"
  | "decryption_failed"
  | "checksum_mismatch"
  | "os_encryption_unavailable";

/** Extended result for load operations with status information */
export interface LoadResult<T> {
  status: LoadStatus;
  data?: T;
  error?: string;
}

export interface SaveOptions {
  /**
   * Replace an unreadable row without backing it up first; only for recovery paths that
   * already hold its plaintext.
   */
  allowUnreadableOverwrite?: boolean;
}

/** Settings categories supported */
export type SettingsCategory =
  | "skills"
  | "acp"
  | "voice"
  | "memory"
  | "chronicle"
  | "llm"
  | "search"
  | "appearance"
  | "personality"
  | "guardrails"
  | "permissions"
  | "protected-credentials"
  | "hooks"
  | "mcp"
  | "secure-mcp-tunnels"
  | "controlplane"
  | "channels"
  | "builtintools"
  | "tailscale"
  | "claude-auth"
  | "queue"
  | "tray"
  | "x"
  | "notion"
  | "box"
  | "onedrive"
  | "google-drive"
  | "dropbox"
  | "sharepoint"
  | "user-profile"
  | "relationship-memory"
  | "conway"
  | "conway-wallet"
  | "infra"
  | "infra-wallet"
  | "proactive-suggestions-state"
  | "improvement-loop"
  | "improvement-owner"
  | "improvement-history"
  | "worktree"
  | "subconscious-loop"
  | "subconscious-migration-v1"
  | "webaccess"
  | "browser-use"
  | "adaptive-style-engine"
  | "routine-workflow-secrets"
  | "awareness-state"
  | "autonomy-chief-of-staff"
  | "supermemory"
  | "pulse"
  | "plugin-packs"
  | "meeting-artifacts"
  | `plugin:${string}`;

interface SecureSettingsRow {
  id: string;
  category: string;
  encrypted_data: string;
  checksum: string;
  created_at: number;
  updated_at: number;
}

/** Machine ID file name - persisted for stable key derivation */
const MACHINE_ID_FILE = ".cowork-machine-id";
const logger = createLogger("SecureSettingsRepository");

/**
 * Repository for securely storing encrypted settings in the database
 */
export class SecureSettingsRepository {
  private static instance: SecureSettingsRepository | null = null;
  private encryptionAvailable: boolean;
  private safeStorage: SafeStorageLike | null;
  private machineId: string | null = null;
  private unreadableCategories = new Map<string, LoadResult<never>>();

  constructor(private db: Database.Database) {
    this.safeStorage = getSafeStorage();
    try {
      this.encryptionAvailable = this.safeStorage?.isEncryptionAvailable() ?? false;
    } catch (error) {
      this.encryptionAvailable = false;
      console.warn(
        "[SecureSettingsRepository] safeStorage encryption probe failed; falling back to app-level encryption:",
        error,
      );
    }
    if (!this.encryptionAvailable) {
      console.warn(
        "[SecureSettingsRepository] OS encryption not available. Settings will be stored with app-level encryption only.",
      );
    }
    // Initialize stable machine ID for fallback encryption
    this.initializeMachineId();
    // Set as singleton instance
    SecureSettingsRepository.instance = this;
  }

  /**
   * Initialize or load the stable machine ID
   * This ID persists across hostname changes, making fallback encryption stable
   */
  private initializeMachineId(): void {
    try {
      const userDataPath = getUserDataDir();
      const machineIdPath = path.join(userDataPath, MACHINE_ID_FILE);

      if (fs.existsSync(machineIdPath)) {
        this.machineId = fs.readFileSync(machineIdPath, "utf-8").trim();
        logger.debug("Loaded existing machine ID");
      } else {
        // Generate a new stable machine ID
        this.machineId = uuidv4();
        // Write with restrictive permissions (owner read/write only)
        fs.writeFileSync(machineIdPath, this.machineId, { mode: 0o600 });
        logger.debug("Generated new machine ID");
      }
    } catch (error) {
      console.warn(
        "[SecureSettingsRepository] Failed to initialize machine ID, using fallback:",
        error,
      );
      // Fallback to old method if file operations fail
      this.machineId = null;
    }
  }

  /**
   * Get the singleton instance of SecureSettingsRepository.
   * Must be called after the instance has been created.
   */
  static getInstance(): SecureSettingsRepository {
    if (!SecureSettingsRepository.instance) {
      throw new Error(
        "SecureSettingsRepository has not been initialized. Initialize it in main.ts first.",
      );
    }
    return SecureSettingsRepository.instance;
  }

  /**
   * Check if the repository has been initialized
   */
  static isInitialized(): boolean {
    return SecureSettingsRepository.instance !== null;
  }

  /**
   * Save settings for a category (creates or updates)
   */
  save<T extends object>(category: SettingsCategory, settings: T, options: SaveOptions = {}): void {
    if (String(category) === "health") {
      throw new Error("The personal Health settings category has been retired");
    }
    const existing = this.findByCategory(category);
    if (existing && !options.allowUnreadableOverwrite) {
      const health = this.loadWithStatus(category, { logErrors: false, skipMigration: true });
      if (health.status !== "success" && health.status !== "not_found") {
        // Keep the unreadable ciphertext recoverable (e.g. if the original keychain
        // identity returns) instead of blocking every future save of this category.
        this.backupUnreadableRow(existing, health.status);
      }
    }

    const now = Date.now();
    const jsonData = JSON.stringify(settings);
    const encryptedData = this.encrypt(jsonData);
    // Checksum the ciphertext, not the plaintext. An unkeyed SHA-256 of the
    // plaintext stored beside the ciphertext is a brute-force oracle for
    // low-entropy secrets. Integrity of the plaintext is already guaranteed by
    // AES-GCM's auth tag (and by safeStorage for `os:` records); this column
    // only needs to detect a corrupted or swapped stored blob.
    const checksum = this.computeChecksum(encryptedData);

    if (existing) {
      // Update existing
      const stmt = this.db.prepare(`
        UPDATE secure_settings
        SET encrypted_data = ?, checksum = ?, updated_at = ?
        WHERE category = ?
      `);
      stmt.run(encryptedData, checksum, now, category);
    } else {
      // Insert new
      const stmt = this.db.prepare(`
        INSERT INTO secure_settings (id, category, encrypted_data, checksum, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(uuidv4(), category, encryptedData, checksum, now, now);
    }

    this.unreadableCategories.delete(category);
    logger.debug(`Saved settings for category: ${category}`);
  }

  /** Copy an unreadable row's ciphertext (never plaintext) aside before it is replaced. */
  private backupUnreadableRow(row: SecureSettingsRow, status: LoadStatus): void {
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS secure_settings_unreadable_backup (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          encrypted_data TEXT NOT NULL,
          checksum TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          backed_up_at INTEGER NOT NULL
        )`,
      )
      .run();
    this.db
      .prepare(
        `INSERT INTO secure_settings_unreadable_backup
          (id, category, encrypted_data, checksum, status, created_at, updated_at, backed_up_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv4(),
        row.category,
        row.encrypted_data,
        row.checksum,
        status,
        row.created_at,
        row.updated_at,
        Date.now(),
      );
    logger.warn(
      `Replacing unreadable settings for category ${row.category} (${status}); the previous encrypted data was backed up.`,
    );
  }

  /**
   * Load settings for a category
   * Returns undefined if no settings exist or if decryption fails
   */
  load<T extends object>(category: SettingsCategory): T | undefined {
    const result = this.loadWithStatus<T>(category);
    return result.data;
  }

  /**
   * Load settings with detailed status information
   * Use this when you need to distinguish between "not found" vs "corrupted" vs "decryption failed"
   */
  loadWithStatus<T extends object>(
    category: SettingsCategory,
    options: { logErrors?: boolean; skipMigration?: boolean } = {},
  ): LoadResult<T> {
    const row = this.findByCategory(category);
    if (!row) {
      this.unreadableCategories.delete(category);
      return { status: "not_found" };
    }

    const knownUnreadable = this.unreadableCategories.get(category);
    if (knownUnreadable) {
      return knownUnreadable as LoadResult<T>;
    }

    try {
      const decrypted = this.decrypt(row.encrypted_data);

      // Verify checksum to detect tampering. Records written before the
      // checksum moved off the plaintext still carry a plaintext digest, so
      // accept either; `save()` rewrites them to the ciphertext form.
      const ciphertextChecksum = this.computeChecksum(row.encrypted_data);
      const legacyPlaintextChecksum = this.computeChecksum(decrypted);
      if (ciphertextChecksum !== row.checksum && legacyPlaintextChecksum !== row.checksum) {
        const result: LoadResult<never> = {
          status: "checksum_mismatch",
          error: "Data integrity check failed. Settings may be corrupted.",
        };
        if (options.logErrors !== false) {
          console.warn(
            `[SecureSettingsRepository] Marked secure settings category ${category} unreadable: ${result.error}`,
          );
        }
        this.unreadableCategories.set(category, result);
        return result;
      }

      const parsed = JSON.parse(decrypted) as T;

      // Opportunistic migration, for two independent legacy conditions:
      //
      // 1. `app:` records were encrypted with the v1 key derivation, whose
      //    fallback is derivable from public paths.
      // 2. A stored checksum that only matches the plaintext is an unkeyed
      //    SHA-256 of the secret sitting next to its ciphertext — a
      //    brute-force oracle for low-entropy values. This applies to `os:`
      //    (safeStorage) records too, which is the common case on desktop;
      //    keying the migration off the `app:` prefix alone would leave those
      //    oracles in the database indefinitely, since nothing else rewrites a
      //    category that is only ever read.
      const usesLegacyKeyDerivation = row.encrypted_data.startsWith("app:");
      const usesLegacyPlaintextChecksum =
        ciphertextChecksum !== row.checksum && legacyPlaintextChecksum === row.checksum;
      if ((usesLegacyKeyDerivation || usesLegacyPlaintextChecksum) && !options.skipMigration) {
        try {
          this.save(category, parsed as object);
          console.info(
            `[SecureSettingsRepository] Re-wrote secure settings category ${category} in the current format.`,
          );
        } catch (migrationError) {
          // Non-fatal: the caller still gets its settings. A failure here just
          // means the record stays readable in the old format.
          console.warn(
            `[SecureSettingsRepository] Could not re-encrypt category ${category}: ${
              migrationError instanceof Error ? migrationError.message : migrationError
            }`,
          );
        }
      }

      return {
        status: "success",
        data: parsed,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Detect specific failure modes
      if (errorMessage.includes("OS encryption was used but is no longer available")) {
        const result: LoadResult<never> = {
          status: "os_encryption_unavailable",
          error:
            "Settings were encrypted with OS keychain which is no longer accessible. You may need to re-enter your credentials.",
        };
        if (options.logErrors !== false) {
          console.warn(
            `[SecureSettingsRepository] Marked secure settings category ${category} unreadable: ${result.error}`,
          );
        }
        this.unreadableCategories.set(category, result);
        return result;
      }

      const result: LoadResult<never> = {
        status: "decryption_failed",
        error: errorMessage,
      };
      if (options.logErrors !== false) {
        console.warn(
          `[SecureSettingsRepository] Marked secure settings category ${category} unreadable: ${errorMessage}`,
        );
      }
      this.unreadableCategories.set(category, result);
      return result;
    }
  }

  /**
   * Check if settings can be decrypted (health check)
   * Returns the status without exposing the actual data
   */
  checkHealth(category: SettingsCategory, options: { logErrors?: boolean } = {}): LoadStatus {
    return this.loadWithStatus(category, options).status;
  }

  /**
   * Delete settings for a category
   */
  delete(category: SettingsCategory): boolean {
    const stmt = this.db.prepare("DELETE FROM secure_settings WHERE category = ?");
    const result = stmt.run(category);
    this.unreadableCategories.delete(category);
    return result.changes > 0;
  }

  /**
   * Check if settings exist for a category
   */
  exists(category: SettingsCategory): boolean {
    const stmt = this.db.prepare("SELECT 1 FROM secure_settings WHERE category = ? LIMIT 1");
    const row = stmt.get(category);
    return row !== undefined;
  }

  /**
   * Get all categories that have settings stored
   */
  listCategories(): SettingsCategory[] {
    const stmt = this.db.prepare("SELECT category FROM secure_settings ORDER BY category");
    const rows = stmt.all() as Array<{ category: string }>;
    return rows.map((r) => r.category as SettingsCategory);
  }

  /**
   * Get metadata about stored settings (without decrypting)
   */
  getMetadata(category: SettingsCategory): { createdAt: number; updatedAt: number } | undefined {
    const stmt = this.db.prepare(
      "SELECT created_at, updated_at FROM secure_settings WHERE category = ?",
    );
    const row = stmt.get(category) as { created_at: number; updated_at: number } | undefined;
    return row ? { createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  // ============ Backup & Recovery ============

  /**
   * Create an encrypted backup of all settings to a file
   * The backup is encrypted with OS keychain when available
   */
  createBackup(backupPath: string): {
    success: boolean;
    categoriesBackedUp: string[];
    error?: string;
  } {
    try {
      // Older profiles can still have this retired category before startup migration runs.
      const categories = this.listCategories().filter((category) => String(category) !== "health");
      const backupData: Record<string, unknown> = {};

      for (const category of categories) {
        const result = this.loadWithStatus(category);
        if (result.status === "success" && result.data) {
          backupData[category] = result.data;
        }
      }

      const jsonData = JSON.stringify({
        version: 1,
        timestamp: Date.now(),
        categories: backupData,
      });

      // Encrypt the backup
      const encryptedBackup = this.encrypt(jsonData);

      fs.writeFileSync(backupPath, encryptedBackup, { mode: 0o600 });
      logger.debug(`Created backup with ${categories.length} categories`);

      return { success: true, categoriesBackedUp: categories };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[SecureSettingsRepository] Backup failed:", error);
      return { success: false, categoriesBackedUp: [], error: errorMessage };
    }
  }

  /**
   * Restore settings from an encrypted backup file
   * @param backupPath Path to the backup file
   * @param overwrite Whether to overwrite existing settings (default: false)
   */
  restoreBackup(
    backupPath: string,
    overwrite = false,
  ): { success: boolean; categoriesRestored: string[]; error?: string } {
    try {
      if (!fs.existsSync(backupPath)) {
        return { success: false, categoriesRestored: [], error: "Backup file not found" };
      }

      const encryptedBackup = fs.readFileSync(backupPath, "utf-8");
      const jsonData = this.decrypt(encryptedBackup);
      const backup = JSON.parse(jsonData);

      if (!backup.version || !backup.categories) {
        return { success: false, categoriesRestored: [], error: "Invalid backup format" };
      }

      const categoriesRestored: string[] = [];

      for (const [category, data] of Object.entries(backup.categories)) {
        if (category === "health") continue;
        const existingStatus = this.checkHealth(category as SettingsCategory);

        // Skip if exists and not overwriting
        if (existingStatus !== "not_found" && !overwrite) {
          logger.debug(`Skipping ${category} (exists, overwrite=false)`);
          continue;
        }

        this.save(category as SettingsCategory, data as object, {
          allowUnreadableOverwrite: overwrite,
        });
        categoriesRestored.push(category);
      }

      logger.debug(`Restored ${categoriesRestored.length} categories from backup`);
      return { success: true, categoriesRestored };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[SecureSettingsRepository] Restore failed:", error);
      return { success: false, categoriesRestored: [], error: errorMessage };
    }
  }

  /**
   * Delete settings only when a checksum mismatch confirms stored data corruption.
   * A decryption failure can mean the original OS keychain identity is unavailable,
   * so those records must remain available for recovery.
   */
  deleteCorrupted(category: SettingsCategory): boolean {
    const status = this.checkHealth(category);
    if (status !== "checksum_mismatch") {
      console.warn(
        `[SecureSettingsRepository] Category ${category} is not confirmed corrupt (status: ${status}), not deleting`,
      );
      return false;
    }

    logger.debug(`Deleting corrupted settings for ${category} (status: ${status})`);
    return this.delete(category);
  }

  /**
   * Re-encrypt all settings with current encryption method
   * Useful after OS keychain becomes available or for migration
   */
  reEncryptAll(): { success: boolean; categoriesProcessed: string[]; errors: string[] } {
    const categories = this.listCategories().filter((category) => String(category) !== "health");
    const processed: string[] = [];
    const errors: string[] = [];

    for (const category of categories) {
      try {
        const result = this.loadWithStatus(category);
        if (result.status === "success" && result.data) {
          // Re-save with current encryption method
          this.save(category, result.data);
          processed.push(category);
        } else {
          errors.push(`${category}: ${result.error || result.status}`);
        }
      } catch (error) {
        errors.push(`${category}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    logger.debug(`Re-encrypted ${processed.length}/${categories.length} categories`);
    return { success: errors.length === 0, categoriesProcessed: processed, errors };
  }

  // ============ Private Methods ============

  private findByCategory(category: SettingsCategory): SecureSettingsRow | undefined {
    const stmt = this.db.prepare("SELECT * FROM secure_settings WHERE category = ?");
    return stmt.get(category) as SecureSettingsRow | undefined;
  }

  /**
   * Encrypt data using OS keychain (safeStorage) when available,
   * otherwise use app-level encryption with a derived key
   */
  private encrypt(data: string): string {
    if (this.encryptionAvailable && this.safeStorage) {
      // Use OS keychain encryption
      const encryptedBuffer = this.safeStorage.encryptString(data);
      return "os:" + encryptedBuffer.toString("base64");
    } else {
      // Fallback: app-level AES-256-GCM with a key derived from the per-install
      // machine ID and a fresh random salt stored with the ciphertext.
      //
      // Refuses to run when no machine ID could be established. The previous
      // code fell back to a key derived from well-known paths plus a constant,
      // which made the ciphertext decryptable by anyone who knew the platform's
      // default user-data location — i.e. not encrypted in any useful sense.
      const machineId = this.machineId;
      if (!machineId) {
        throw new Error(
          "Secure settings cannot be written: OS keychain encryption is unavailable and no machine identifier could be established.",
        );
      }

      const salt = crypto.randomBytes(16);
      const key = this.deriveAppKeyV2(machineId, salt);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

      let encrypted = cipher.update(data, "utf8", "base64");
      encrypted += cipher.final("base64");

      const authTag = cipher.getAuthTag();

      // Format: app2:<salt>:<iv>:<authTag>:<encrypted>
      return `app2:${salt.toString("base64")}:${iv.toString("base64")}:${authTag.toString(
        "base64",
      )}:${encrypted}`;
    }
  }

  /**
   * Decrypt data using the appropriate method based on prefix
   */
  private decrypt(encryptedData: string): string {
    if (encryptedData.startsWith("os:")) {
      // OS keychain decryption
      if (!this.encryptionAvailable || !this.safeStorage) {
        throw new Error("OS encryption was used but is no longer available");
      }
      const base64Data = encryptedData.slice(3);
      const encryptedBuffer = Buffer.from(base64Data, "base64");
      return this.safeStorage.decryptString(encryptedBuffer);
    } else if (encryptedData.startsWith("app2:")) {
      // Current app-level format: salt is stored with the ciphertext.
      const parts = encryptedData.slice(5).split(":");
      if (parts.length !== 4) {
        throw new Error("Invalid encrypted data format");
      }
      const [saltBase64, ivBase64, authTagBase64, encrypted] = parts;
      const machineId = this.machineId;
      if (!machineId) {
        throw new Error(
          "Secure settings cannot be read: no machine identifier could be established.",
        );
      }
      const key = this.deriveAppKeyV2(machineId, Buffer.from(saltBase64, "base64"));
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
      decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));

      let decrypted = decipher.update(encrypted, "base64", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } else if (encryptedData.startsWith("app:")) {
      // Legacy v1 format, kept only so existing installs can still be read and
      // migrated. Its key derivation put a hardcoded constant in the password
      // position and the machine ID in the salt position, and fell back to a
      // fully path-derived value. `save()` re-writes anything read through here
      // in the v2 format.
      const parts = encryptedData.slice(4).split(":");
      if (parts.length !== 3) {
        throw new Error("Invalid encrypted data format");
      }

      const [ivBase64, authTagBase64, encrypted] = parts;
      const key = this.deriveLegacyAppKey();
      const iv = Buffer.from(ivBase64, "base64");
      const authTag = Buffer.from(authTagBase64, "base64");

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted, "base64", "utf8");
      decrypted += decipher.final("utf8");

      return decrypted;
    } else {
      // Legacy unencrypted data (shouldn't happen, but handle gracefully)
      console.warn("[SecureSettingsRepository] Found unencrypted data, returning as-is");
      return encryptedData;
    }
  }

  /**
   * Derive the v2 app-level key.
   *
   * The per-install random machine ID is the PBKDF2 *password* and a random
   * per-record value is the *salt* — the way round PBKDF2 expects. v1 had these
   * inverted, passing a constant shared by every installation as the password.
   */
  private deriveAppKeyV2(machineId: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(machineId, salt, 210000, 32, "sha512");
  }

  /**
   * Reproduce the v1 key so existing records can be read once and re-saved in
   * the v2 format. Do not use for new writes.
   */
  private deriveLegacyAppKey(): Buffer {
    const appSalt = "cowork-os-secure-settings-v1";
    const machineId = this.getLegacyMachineIdentifier();
    return crypto.pbkdf2Sync(appSalt, machineId, 100000, 32, "sha512");
  }

  /**
   * v1 machine identifier, including its path-derived fallback.
   *
   * The fallback is why v1 records need migrating: it is fully derivable from
   * the platform's default user-data path, so anyone who obtained the database
   * could recompute the key. Retained for reading old records only.
   */
  private getLegacyMachineIdentifier(): string {
    if (this.machineId) {
      return this.machineId;
    }

    const factors = [
      getUserDataDir(),
      path.join(getUserDataDir(), MACHINE_ID_FILE),
      "cowork-os-secure-settings-fallback-v2",
    ];
    console.warn(
      "[SecureSettingsRepository] Reading a legacy record with the path-derived fallback identifier; it will be re-encrypted on next save.",
    );
    return factors.join(":");
  }

  /**
   * Compute a SHA-256 checksum for integrity verification
   */
  private computeChecksum(data: string): string {
    return crypto.createHash("sha256").update(data).digest("hex");
  }
}
