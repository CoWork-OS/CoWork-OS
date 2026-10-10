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
import {
  commitSecureSettingsWrites,
  ensureSecureSettingsSchema,
  readSecureSettingsRevision,
  type SecureSettingsCommitResult,
  type SecureSettingsRecord,
  type SecureSettingsWrite,
} from "./secure-settings-sql";
import { settingsCommitClientFor } from "./secure-settings-commit-route";
import { mergeSettingsValues } from "./secure-settings-merge";

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

/** A load result together with the row revision it was read at (DB5). */
export interface RecordResult<T> extends LoadResult<T> {
  /** The stored revision, or `null` when the category has no row. */
  revision: number | null;
}

/** Returned by an `update` mutation to delete the category. */
export const DELETE_SECURE_SETTINGS = Symbol("delete-secure-settings");

export interface UpdateOptions {
  /** Replace an unreadable row (its ciphertext is backed up first) instead of failing. */
  replaceUnreadable?: boolean;
  /** Conflict retries before giving up; each re-reads and re-applies the mutation. */
  maxAttempts?: number;
}

/**
 * The OS keychain key differs from the one that encrypted existing settings, so this
 * write is refused rather than encrypted under the new key. Decisions surface it;
 * they never report a refused write as saved.
 */
export class SecureSettingsWriteRefusedError extends Error {
  readonly code = "settings_write_refused";
  constructor(readonly category: string) {
    super(`Settings for ${category} cannot be saved: the OS keychain key changed.`);
  }
}

/** The stored row cannot be decrypted, so a read-modify-write would lose its contents. */
export class SecureSettingsUnreadableError extends Error {
  readonly code = "settings_unreadable";
  constructor(
    readonly category: string,
    readonly status: LoadStatus,
  ) {
    super(`Settings for ${category} are unreadable (${status}).`);
  }
}

/** Another writer kept changing the row; the update gave up after its retries. */
export class SecureSettingsConflictError extends Error {
  readonly code = "settings_conflict";
  constructor(readonly category: string) {
    super(`Settings for ${category} changed concurrently; the update was not applied.`);
  }
}

const DEFAULT_UPDATE_ATTEMPTS = 5;

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
  | "notion"
  | "box"
  | "onedrive"
  | "google-drive"
  | "dropbox"
  | "sharepoint"
  | "user-profile"
  | "relationship-memory"
  | "conway"
  // Encrypted wallet keys of the retired Infrastructure tools; kept so an export remains possible.
  | "conway-wallet"
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
  // In-app browser site permissions (camera, location, ...) the user chose "Always" for.
  | "browser-site-permissions"
  // Saved logins for the in-app browser: each password is sealed separately with the OS keychain.
  | "browser-vault"
  // Settings > Browser (search engine, downloads, agent permissions, developer mode).
  | "browser"
  | "adaptive-style-engine"
  | "routine-workflow-secrets"
  | "acp-remote-agent-secrets"
  | "awareness-state"
  | "pulse"
  | "plugin-packs"
  | "meeting-artifacts"
  | "checkpoint-signing"
  // PACT business-agent protocol: settings, and secrets that never enter the pact_* tables.
  | "pact"
  | "pact:grants"
  | "pact:authorization"
  | "pact:signer"
  | "pact:receipts"
  | `plugin:${string}`;

interface SecureSettingsRow {
  id: string;
  category: string;
  encrypted_data: string;
  checksum: string;
  created_at: number;
  updated_at: number;
  revision?: number;
}

/** Machine ID file name - persisted for stable key derivation */
const MACHINE_ID_FILE = ".cowork-machine-id";
/** Known plaintext encrypted once with the OS keychain key to detect a key change. */
const KEYCHAIN_CANARY_VALUE = "cowork-os-keychain-canary-v1";

/**
 * - `verified`: the stored canary decrypts with the current OS keychain key.
 * - `created`: first check on this profile; the current key was adopted.
 * - `mismatch`: the current key cannot read the stored canary (or any existing
 *   settings), so writes are refused to avoid encrypting under a new key.
 * - `not_applicable`: OS keychain encryption is not in use.
 */
export type KeychainIdentityStatus = "verified" | "created" | "mismatch" | "not_applicable";
const logger = createLogger("SecureSettingsRepository");

/**
 * Repository for securely storing encrypted settings in the database
 */
export class SecureSettingsRepository {
  private static instance: SecureSettingsRepository | null = null;
  private encryptionAvailable: boolean;
  private safeStorage: SafeStorageLike | null;
  private machineId: string | null = null;
  /** Failed reads, per category and revision: a rewrite by any process re-checks. */
  private unreadableCategories = new Map<string, { revision: number; result: LoadResult<never> }>();
  private keychainIdentityMismatch = false;
  private refusedWriteCategories = new Set<string>();
  /**
   * What this process last read or wrote per category: the revision and its ciphertext
   * (never plaintext). `save()` commits against it and, when another writer changed the
   * row meanwhile, merges against the value it describes instead of overwriting (DB5).
   */
  private readBaselines = new Map<
    string,
    { revision: number | null; encryptedData: string | null }
  >();

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
    try {
      ensureSecureSettingsSchema(db);
    } catch (error) {
      logger.debug("Could not ensure the secure settings schema here:", error);
    }
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
   * Save settings for a category (creates or updates), unconditionally: the last writer
   * wins. Encryption runs before the transaction. Returns false when the write was
   * refused because the OS keychain key changed; decisions that must not be lost use
   * `update`, which throws instead.
   */
  save<T extends object>(
    category: SettingsCategory,
    settings: T,
    options: SaveOptions = {},
  ): boolean {
    if (String(category) === "health") {
      throw new Error("The personal Health settings category has been retired");
    }
    if (this.refusesWrites()) {
      this.noteRefusedWrite(category);
      return false;
    }
    const baseline = this.readBaselines.get(category);
    let mine: unknown = JSON.parse(JSON.stringify(settings));
    let expectedRevision: number | null | "any" = baseline ? baseline.revision : "any";
    let base: unknown = baseline?.encryptedData
      ? this.tryDecryptBaseline(baseline.encryptedData)
      : undefined;
    for (let attempt = 0; attempt < DEFAULT_UPDATE_ATTEMPTS; attempt += 1) {
      let backupUnreadableAs: string | undefined;
      if (!options.allowUnreadableOverwrite && this.findByCategory(category)) {
        const health = this.loadWithStatus(category, {
          logErrors: false,
          skipMigration: true,
          recordBaseline: false,
        });
        if (health.status === "os_encryption_unavailable") {
          // Encrypted with the OS keychain, which this process (the daemon or CLI, or a
          // run without a keychain) cannot use. Another process can still read it, so it
          // is not replaced: the write is refused (DB5).
          this.noteRefusedWrite(
            category,
            "it is encrypted with an OS keychain key this process cannot use",
          );
          return false;
        }
        if (health.status !== "success" && health.status !== "not_found") {
          // Keep the unreadable ciphertext recoverable (e.g. if the original keychain
          // identity returns) instead of blocking every future save of this category.
          backupUnreadableAs = health.status;
          expectedRevision = "any";
          this.logReplacedUnreadable(category, health.status);
        }
      } else if (options.allowUnreadableOverwrite) {
        expectedRevision = "any";
      }
      const result = this.commitOnHost([
        {
          category,
          expectedRevision,
          record: this.encryptRecord(mine as object),
          backupUnreadableAs,
        },
      ]);
      if (result.status === "committed") {
        logger.debug(`Saved settings for category: ${category}`);
        return true;
      }
      // Another writer changed the row since this process read it: keep its changes
      // to fields this save did not touch.
      const current = this.readRecord<object>(category, { recordBaseline: false });
      if (current.status !== "success" && current.status !== "not_found") {
        expectedRevision = "any";
        continue;
      }
      const merged = mergeSettingsValues(base, mine, current.data);
      if (merged.conflicts.length > 0) {
        logger.warn(
          `Settings ${category} changed in another writer; this save's values were kept for: ${merged.conflicts.join(", ")}`,
        );
      }
      mine = merged.value;
      base = current.data;
      expectedRevision = current.revision;
    }
    throw new SecureSettingsConflictError(category);
  }

  /**
   * Read, change and write a category under a revision check (DB5). `mutate` receives a
   * private copy of the current value (`undefined` when absent) and returns the next
   * value, `undefined` to leave the row as it is, or `DELETE_SECURE_SETTINGS`. When
   * another writer (any process) changed the row in between, the mutation is re-applied
   * to the newer value. Throws `SecureSettingsWriteRefusedError` instead of reporting a
   * refused write as saved.
   */
  update<T extends object>(
    category: SettingsCategory,
    mutate: (current: T | undefined) => T | undefined | typeof DELETE_SECURE_SETTINGS,
    options: UpdateOptions = {},
  ): { value: T | undefined; revision: number | null } {
    const attempts = options.maxAttempts ?? DEFAULT_UPDATE_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const planned = this.planUpdate(category, mutate, options);
      if (planned.unchanged) return planned.unchanged;
      const result = this.commitOnHost([planned.write]);
      if (result.status === "committed") {
        return { value: planned.value, revision: result.revisions[category] ?? null };
      }
    }
    throw new SecureSettingsConflictError(category);
  }

  /**
   * `update` plus one more change in the same transaction, for decisions that span a
   * settings row and a plain table (DB5). `alsoApply` runs first inside the IMMEDIATE
   * transaction and must be SQL only (no keychain, network or timers); returning false
   * aborts without writing anything and yields `null`. On a revision conflict both are
   * rolled back and the whole update is retried.
   */
  updateWithin<T extends object>(
    category: SettingsCategory,
    mutate: (current: T | undefined) => T | undefined | typeof DELETE_SECURE_SETTINGS,
    alsoApply: (db: Database.Database) => boolean,
    options: UpdateOptions = {},
  ): { value: T | undefined; revision: number | null } | null {
    const attempts = options.maxAttempts ?? DEFAULT_UPDATE_ATTEMPTS;
    const conflict = Symbol("conflict");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const planned = this.planUpdate(category, mutate, options);
      try {
        const outcome = this.db
          .transaction(() => {
            if (!alsoApply(this.db)) return null;
            if (planned.unchanged) return planned.unchanged;
            const result = commitSecureSettingsWrites(this.db, [planned.write]);
            // Throwing rolls back `alsoApply` too.
            if (result.status !== "committed") throw conflict;
            return { value: planned.value, revision: result.revisions[category] ?? null };
          })
          .immediate();
        if (!planned.unchanged && outcome) {
          this.afterCommit([planned.write], { [category]: outcome.revision });
        }
        return outcome;
      } catch (error) {
        if (error !== conflict) throw error;
      }
    }
    throw new SecureSettingsConflictError(category);
  }

  /**
   * `update`, committing through the database worker when this run routes settings
   * there (DB5); otherwise on the host connection. Reads and encryption stay here.
   */
  async updateAsync<T extends object>(
    category: SettingsCategory,
    mutate: (current: T | undefined) => T | undefined | typeof DELETE_SECURE_SETTINGS,
    options: UpdateOptions = {},
  ): Promise<{ value: T | undefined; revision: number | null }> {
    const attempts = options.maxAttempts ?? DEFAULT_UPDATE_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const planned = this.planUpdate(category, mutate, options);
      if (planned.unchanged) return planned.unchanged;
      const result = await this.commitWrites([planned.write]);
      if (result.status === "committed") {
        return { value: planned.value, revision: result.revisions[category] ?? null };
      }
    }
    throw new SecureSettingsConflictError(category);
  }

  /**
   * Commit prepared writes atomically: in the database worker when this run routes
   * settings there, otherwise in one IMMEDIATE host transaction.
   */
  async commitWrites(writes: SecureSettingsWrite[]): Promise<SecureSettingsCommitResult> {
    const client = settingsCommitClientFor(this.db);
    if (!client) return this.commitOnHost(writes);
    const result = await client.execute("secureSettings.commit", { writes });
    if (result.status === "committed") this.afterCommit(writes, result.revisions);
    return result;
  }

  /** Encrypt a value into the stored record form (ciphertext and its checksum). */
  encryptRecord(settings: object): SecureSettingsRecord {
    if (this.refusesWrites()) throw new SecureSettingsWriteRefusedError("(record)");
    const encryptedData = this.encrypt(JSON.stringify(settings));
    // Checksum the ciphertext, not the plaintext. An unkeyed SHA-256 of the
    // plaintext stored beside the ciphertext is a brute-force oracle for
    // low-entropy secrets. Integrity of the plaintext is already guaranteed by
    // AES-GCM's auth tag (and by safeStorage for `os:` records); this column
    // only needs to detect a corrupted or swapped stored blob.
    return { encryptedData, checksum: this.computeChecksum(encryptedData) };
  }

  /** Decode a sealed host record without accepting legacy plaintext. */
  decryptRecord<T extends object>(record: SecureSettingsRecord): T {
    if (
      !record ||
      typeof record.encryptedData !== "string" ||
      typeof record.checksum !== "string" ||
      !(record.encryptedData.startsWith("os:") || record.encryptedData.startsWith("app2:")) ||
      record.checksum !== this.computeChecksum(record.encryptedData)
    )
      throw new Error("Invalid encrypted settings record");
    const value: unknown = JSON.parse(this.decrypt(record.encryptedData));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid encrypted settings payload");
    }
    return value as T;
  }

  /** Load a category together with the revision it was read at. */
  readRecord<T extends object>(
    category: SettingsCategory,
    options: { recordBaseline?: boolean } = {},
  ): RecordResult<T> {
    const revision = readSecureSettingsRevision(this.db, category);
    if (revision === null) {
      this.unreadableCategories.delete(category);
      if (options.recordBaseline !== false) {
        this.readBaselines.set(category, { revision: null, encryptedData: null });
      }
      return { status: "not_found", revision: null };
    }
    const result = this.loadWithStatus<T>(category, {
      skipMigration: true,
      recordBaseline: options.recordBaseline,
    });
    // The row may have changed between the two reads; report the older revision so a
    // conditional write based on this result conflicts instead of overwriting.
    return { ...result, revision };
  }

  /** The stored revision of a category (`null` when absent); one indexed read. */
  getRevision(category: SettingsCategory): number | null {
    return readSecureSettingsRevision(this.db, category);
  }

  private planUpdate<T extends object>(
    category: SettingsCategory,
    mutate: (current: T | undefined) => T | undefined | typeof DELETE_SECURE_SETTINGS,
    options: UpdateOptions,
  ):
    | { unchanged: { value: T | undefined; revision: number | null }; write?: never; value?: never }
    | { unchanged?: never; write: SecureSettingsWrite; value: T | undefined } {
    if (String(category) === "health") {
      throw new Error("The personal Health settings category has been retired");
    }
    if (this.refusesWrites()) {
      this.noteRefusedWrite(category);
      throw new SecureSettingsWriteRefusedError(category);
    }
    const current = this.readRecord<T>(category);
    if (current.status === "os_encryption_unavailable") {
      // Another process can read it with its keychain; this one must not replace it.
      this.noteRefusedWrite(
        category,
        "it is encrypted with an OS keychain key this process cannot use",
      );
      throw new SecureSettingsWriteRefusedError(category);
    }
    const unreadable = current.status !== "success" && current.status !== "not_found";
    if (unreadable && !options.replaceUnreadable) {
      throw new SecureSettingsUnreadableError(category, current.status);
    }
    const base = current.status === "success" ? structuredClone(current.data) : undefined;
    const next = mutate(base);
    if (next === undefined) {
      return { unchanged: { value: base, revision: current.revision } };
    }
    if (unreadable) this.logReplacedUnreadable(category, current.status);
    return {
      value: next === DELETE_SECURE_SETTINGS ? undefined : next,
      write: {
        category,
        expectedRevision: current.revision,
        record: next === DELETE_SECURE_SETTINGS ? null : this.encryptRecord(next),
        backupUnreadableAs: unreadable ? current.status : undefined,
      },
    };
  }

  private commitOnHost(writes: SecureSettingsWrite[]): SecureSettingsCommitResult {
    const result = this.db
      .transaction(() => commitSecureSettingsWrites(this.db, writes))
      .immediate();
    if (result.status === "committed") this.afterCommit(writes, result.revisions);
    return result;
  }

  private afterCommit(
    writes: readonly SecureSettingsWrite[],
    revisions: Record<string, number | null> = {},
  ): void {
    for (const write of writes) {
      this.unreadableCategories.delete(write.category);
      this.readBaselines.set(write.category, {
        revision: revisions[write.category] ?? null,
        encryptedData: write.record?.encryptedData ?? null,
      });
    }
  }

  /** The baseline value for a merge; `undefined` when it cannot be read any more. */
  private tryDecryptBaseline(encryptedData: string): unknown {
    try {
      return JSON.parse(this.decrypt(encryptedData));
    } catch {
      return undefined;
    }
  }

  private noteRefusedWrite(
    category: string,
    reason = "the OS keychain key differs from the one that encrypted existing settings",
  ): void {
    if (this.refusedWriteCategories.has(category)) return;
    this.refusedWriteCategories.add(category);
    logger.warn(`Not saving ${category}: ${reason}.`);
  }

  private logReplacedUnreadable(category: string, status: LoadStatus): void {
    logger.warn(
      `Replacing unreadable settings for category ${category} (${status}); the previous encrypted data was backed up.`,
    );
  }

  /**
   * Check that safeStorage is using the same OS keychain key that encrypted the
   * stored settings. A different key (for example after the app's keychain
   * identity changed) would otherwise make every later save unreadable to the
   * original identity. Call after legacy-identity migrations have run.
   */
  verifyKeychainIdentity(): KeychainIdentityStatus {
    if (!this.encryptionAvailable || !this.safeStorage) return "not_applicable";

    const canary = this.db
      .prepare("SELECT encrypted_data FROM secure_settings_keychain_canary WHERE id = 1")
      .get() as { encrypted_data: string } | undefined;

    if (canary) {
      this.keychainIdentityMismatch =
        this.tryDecryptOs(canary.encrypted_data) !== KEYCHAIN_CANARY_VALUE;
      return this.keychainIdentityMismatch ? "mismatch" : "verified";
    }

    // No canary yet: adopt the current key only if it can read existing
    // keychain-encrypted settings, or if there are none.
    const osRows = this.db
      .prepare("SELECT encrypted_data FROM secure_settings WHERE encrypted_data LIKE 'os:%'")
      .all() as Array<{ encrypted_data: string }>;
    if (
      osRows.length > 0 &&
      !osRows.some((row) => this.tryDecryptOs(row.encrypted_data) !== null)
    ) {
      this.keychainIdentityMismatch = true;
      return "mismatch";
    }
    this.writeKeychainCanary();
    return "created";
  }

  isKeychainIdentityMismatch(): boolean {
    return this.keychainIdentityMismatch;
  }

  /** Whether save() currently refuses writes (keychain key changed while encryption is on). */
  refusesWrites(): boolean {
    return this.keychainIdentityMismatch && this.encryptionAvailable;
  }

  /**
   * Explicitly accept the current OS keychain key after a mismatch. Settings the
   * current key cannot read are moved to the unreadable backup table (ciphertext
   * only) and a new canary is written. Returns the archived categories.
   */
  adoptCurrentKeychainIdentity(): string[] {
    if (!this.encryptionAvailable || !this.safeStorage) return [];
    const rows = this.db
      .prepare("SELECT * FROM secure_settings WHERE encrypted_data LIKE 'os:%'")
      .all() as SecureSettingsRow[];
    // Keychain calls happen before the transaction (DB5): it only moves rows.
    const unreadable = rows.filter((row) => this.tryDecryptOs(row.encrypted_data) === null);
    const canary = this.encrypt(KEYCHAIN_CANARY_VALUE);
    const archived: string[] = [];
    this.db.transaction(() => {
      for (const row of unreadable) {
        // Only the row that was found unreadable: if another writer replaced it since
        // (for example re-entered credentials under the current key), keep that write.
        const result = commitSecureSettingsWrites(this.db, [
          {
            category: row.category,
            expectedRevision: Number(row.revision ?? 0),
            record: null,
            backupUnreadableAs: "decryption_failed",
          },
        ]);
        if (result.status !== "committed") continue;
        this.unreadableCategories.delete(row.category);
        archived.push(row.category);
      }
      this.db.prepare("DELETE FROM secure_settings_keychain_canary WHERE id = 1").run();
      this.writeKeychainCanary(canary);
    })();
    this.keychainIdentityMismatch = false;
    this.refusedWriteCategories.clear();
    return archived;
  }

  private writeKeychainCanary(encryptedCanary = this.encrypt(KEYCHAIN_CANARY_VALUE)): void {
    this.db
      .prepare(
        "INSERT INTO secure_settings_keychain_canary (id, encrypted_data, created_at) VALUES (1, ?, ?)",
      )
      .run(encryptedCanary, Date.now());
  }

  private tryDecryptOs(encryptedData: string): string | null {
    if (!encryptedData.startsWith("os:") || !this.safeStorage) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(encryptedData.slice(3), "base64"));
    } catch {
      return null;
    }
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
    options: { logErrors?: boolean; skipMigration?: boolean; recordBaseline?: boolean } = {},
  ): LoadResult<T> {
    const row = this.findByCategory(category);
    if (!row) {
      this.unreadableCategories.delete(category);
      if (options.recordBaseline !== false) {
        this.readBaselines.set(category, { revision: null, encryptedData: null });
      }
      return { status: "not_found" };
    }

    const rowRevision = Number(row.revision ?? 0);
    const knownUnreadable = this.unreadableCategories.get(category);
    if (knownUnreadable && knownUnreadable.revision === rowRevision) {
      return knownUnreadable.result as LoadResult<T>;
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
        this.unreadableCategories.set(category, { revision: rowRevision, result });
        return result;
      }

      const parsed = JSON.parse(decrypted) as T;
      if (options.recordBaseline !== false) {
        this.readBaselines.set(category, {
          revision: rowRevision,
          encryptedData: row.encrypted_data,
        });
      }

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
        this.unreadableCategories.set(category, { revision: rowRevision, result });
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
      this.unreadableCategories.set(category, { revision: rowRevision, result });
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
    this.readBaselines.set(category, { revision: null, encryptedData: null });
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
