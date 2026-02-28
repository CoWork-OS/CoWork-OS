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

/** Settings categories supported */
export type SettingsCategory =
  | "voice"
  | "memory"
  | "llm"
  | "search"
  | "appearance"
  | "personality"
  | "guardrails"
  | "hooks"
  | "mcp"
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
  | "webaccess"
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
  save<T extends object>(category: SettingsCategory, settings: T): void {
    const now = Date.now();
    const jsonData = JSON.stringify(settings);
    const encryptedData = this.encrypt(jsonData);
    const checksum = this.computeChecksum(jsonData);

    const existing = this.findByCategory(category);

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

    logger.debug(`Saved settings for category: ${category}`);
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
  loadWithStatus<T extends object>(category: SettingsCategory): LoadResult<T> {
    const row = this.findByCategory(category);
    if (!row) {
      return { status: "not_found" };
    }

    try {
      const decrypted = this.decrypt(row.encrypted_data);

      // Verify checksum to detect tampering
      const checksum = this.computeChecksum(decrypted);
      if (checksum !== row.checksum) {
        console.error(
          `[SecureSettingsRepository] Checksum mismatch for category: ${category}. Data may be corrupted.`,
        );
        return {
          status: "checksum_mismatch",
          error: "Data integrity check failed. Settings may be corrupted.",
        };
      }

      return {
        status: "success",
        data: JSON.parse(decrypted) as T,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[SecureSettingsRepository] Failed to decrypt settings for category: ${category}`,
        error,
      );

      // Detect specific failure modes
      if (errorMessage.includes("OS encryption was used but is no longer available")) {
        return {
          status: "os_encryption_unavailable",
          error:
            "Settings were encrypted with OS keychain which is no longer accessible. You may need to re-enter your credentials.",
        };
      }

      return {
        status: "decryption_failed",
        error: errorMessage,
      };
    }
  }

  /**
   * Check if settings can be decrypted (health check)
   * Returns the status without exposing the actual data
   */
  checkHealth(category: SettingsCategory): LoadStatus {
    return this.loadWithStatus(category).status;
  }

  /**
   * Delete settings for a category
   */
  delete(category: SettingsCategory): boolean {
    const stmt = this.db.prepare("DELETE FROM secure_settings WHERE category = ?");
    const result = stmt.run(category);
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
      const categories = this.listCategories();
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
        const existingStatus = this.checkHealth(category as SettingsCategory);

        // Skip if exists and not overwriting
        if (existingStatus === "success" && !overwrite) {
          logger.debug(`Skipping ${category} (exists, overwrite=false)`);
          continue;
        }

        this.save(category as SettingsCategory, data as object);
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
   * Delete corrupted settings for a category
   * Use this when checkHealth returns 'checksum_mismatch' or 'decryption_failed'
   * to allow the user to start fresh
   */
  deleteCorrupted(category: SettingsCategory): boolean {
    const status = this.checkHealth(category);
    if (status === "success" || status === "not_found") {
      console.warn(
        `[SecureSettingsRepository] Category ${category} is not corrupted, not deleting`,
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
    const categories = this.listCategories();
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
      // Fallback: Use app-level AES encryption
      // The key is derived from a combination of app identity and machine-specific data
      const key = this.deriveAppKey();
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

      let encrypted = cipher.update(data, "utf8", "base64");
      encrypted += cipher.final("base64");

      const authTag = cipher.getAuthTag();

      // Format: app:<iv>:<authTag>:<encrypted>
      return `app:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted}`;
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
    } else if (encryptedData.startsWith("app:")) {
      // App-level AES decryption
      const parts = encryptedData.slice(4).split(":");
      if (parts.length !== 3) {
        throw new Error("Invalid encrypted data format");
      }

      const [ivBase64, authTagBase64, encrypted] = parts;
      const key = this.deriveAppKey();
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
   * Derive an app-specific encryption key
   * This key is deterministic per machine but not stored anywhere
   */
  private deriveAppKey(): Buffer {
    // Use a combination of:
    // 1. App identifier (hardcoded, same for all installations)
    // 2. Process info (changes per machine but is consistent)
    const appSalt = "cowork-os-secure-settings-v1";
    const machineId = this.getMachineIdentifier();

    // Derive a 256-bit key using PBKDF2
    return crypto.pbkdf2Sync(appSalt, machineId, 100000, 32, "sha512");
  }

  /**
   * Get a machine-specific identifier for key derivation
   * Uses a stable persistent ID to survive hostname changes, user renames, etc.
   */
  private getMachineIdentifier(): string {
    // Use stable machine ID if available (generated at first launch)
    if (this.machineId) {
      return this.machineId;
    }

    // Fallback: Combine system properties (less stable, for backwards compatibility)
    // This path is only taken if machine ID file operations failed
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const os = require("os");
    const factors = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.homedir(),
      process.env.USER || process.env.USERNAME || "default-user",
    ];
    console.warn("[SecureSettingsRepository] Using volatile machine identifier as fallback");
    return factors.join(":");
  }

  /**
   * Compute a SHA-256 checksum for integrity verification
   */
  private computeChecksum(data: string): string {
    return crypto.createHash("sha256").update(data).digest("hex");
  }
}
