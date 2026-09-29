import type Database from "better-sqlite3";
import { randomUUID } from "crypto";

/**
 * Storage half of encrypted settings (async SQLite migration plan, DB5). Encryption and
 * decryption stay on the host (Electron `safeStorage` is a main-process API); this module
 * only moves ciphertext, so the same functions run on the host connection or in the
 * database worker, and no transaction ever waits on a keychain or key-derivation call.
 *
 * Every write takes a fresh value from one monotonic clock, so a row's `revision` is
 * never reused, even after the row is deleted and created again. Writers that read
 * before they write pass the revision they read; a changed revision is a conflict, and
 * the caller re-reads, re-applies its change, re-encrypts, and tries again.
 */

export interface SecureSettingsRecord {
  encryptedData: string;
  checksum: string;
}

export interface SecureSettingsWrite {
  category: string;
  /**
   * The revision the writer read: a number, `null` for "the row must not exist", or
   * `"any"` for an unconditional write (plain settings saves).
   */
  expectedRevision: number | null | "any";
  /** The new ciphertext, or `null` to delete the row. */
  record: SecureSettingsRecord | null;
  /**
   * Set when the writer found the stored row unreadable: its ciphertext is copied to
   * `secure_settings_unreadable_backup` (with this status) before it is replaced.
   */
  backupUnreadableAs?: string;
}

export type SecureSettingsCommitResult =
  | { status: "committed"; revisions: Record<string, number | null> }
  | {
      status: "conflict";
      category: string;
      expectedRevision: number | null;
      actualRevision: number | null;
    };

export const MAX_SECURE_SETTINGS_WRITES = 16;

/** Create the settings tables and the revision column; idempotent. */
export function ensureSecureSettingsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secure_settings (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      encrypted_data TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(category)
    );
    CREATE INDEX IF NOT EXISTS idx_secure_settings_category ON secure_settings(category);
    CREATE TABLE IF NOT EXISTS secure_settings_revision_clock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO secure_settings_revision_clock (id, value) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS secure_settings_unreadable_backup (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      encrypted_data TEXT NOT NULL,
      checksum TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      backed_up_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secure_settings_keychain_canary (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      encrypted_data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const columns = db.pragma("table_info(secure_settings)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "revision")) {
    try {
      // Existing rows read as revision 0 until their next write.
      db.exec("ALTER TABLE secure_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    } catch (error) {
      // Another process sharing this profile may have added it first.
      if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
}

/** The stored revision of a category, or `null` when it has no row. */
export function readSecureSettingsRevision(db: Database.Database, category: string): number | null {
  const row = db
    .prepare("SELECT revision FROM secure_settings WHERE category = ?")
    .get(category) as { revision: number } | undefined;
  // A row from before the column existed reads as revision 0.
  return row ? Number(row.revision ?? 0) : null;
}

/**
 * Apply the writes atomically if every expected revision still holds. Must run inside
 * the caller's IMMEDIATE transaction. Checks all writes before changing anything, so a
 * conflict leaves the database untouched even without a rollback.
 */
export function commitSecureSettingsWrites(
  db: Database.Database,
  writes: readonly SecureSettingsWrite[],
  now = Date.now(),
): SecureSettingsCommitResult {
  for (const write of writes) {
    if (write.expectedRevision === "any") continue;
    const actual = readSecureSettingsRevision(db, write.category);
    if (actual !== write.expectedRevision) {
      return {
        status: "conflict",
        category: write.category,
        expectedRevision: write.expectedRevision,
        actualRevision: actual,
      };
    }
  }
  const revisions: Record<string, number | null> = {};
  for (const write of writes) {
    if (write.backupUnreadableAs) {
      db.prepare(
        `INSERT INTO secure_settings_unreadable_backup
           (id, category, encrypted_data, checksum, status, created_at, updated_at, backed_up_at)
         SELECT ?, category, encrypted_data, checksum, ?, created_at, updated_at, ?
         FROM secure_settings WHERE category = ?`,
      ).run(randomUUID(), write.backupUnreadableAs, now, write.category);
    }
    if (!write.record) {
      db.prepare("DELETE FROM secure_settings WHERE category = ?").run(write.category);
      revisions[write.category] = null;
      continue;
    }
    const { value: revision } = db
      .prepare(
        "UPDATE secure_settings_revision_clock SET value = value + 1 WHERE id = 1 RETURNING value",
      )
      .get() as { value: number };
    db.prepare(
      `INSERT INTO secure_settings
         (id, category, encrypted_data, checksum, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(category) DO UPDATE SET
         encrypted_data = excluded.encrypted_data,
         checksum = excluded.checksum,
         updated_at = excluded.updated_at,
         revision = excluded.revision`,
    ).run(
      randomUUID(),
      write.category,
      write.record.encryptedData,
      write.record.checksum,
      now,
      now,
      revision,
    );
    revisions[write.category] = revision;
  }
  return { status: "committed", revisions };
}
