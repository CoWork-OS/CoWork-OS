import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("DatabaseManager retired Health settings", () => {
  let tmpDir: string;
  let dbPath: string;
  let previousUserDataDir: string | undefined;

  const insertSetting = (db: Database.Database, table: string, category: string) => {
    if (table === "secure_settings") {
      db.prepare(
        `INSERT INTO secure_settings (id, category, encrypted_data, checksum, created_at, updated_at)
         VALUES (?, ?, 'os:ciphertext', 'checksum', 1, 1)`,
      ).run(`${category}-id`, category);
    } else {
      db.prepare(
        `INSERT INTO secure_settings_unreadable_backup
           (id, category, encrypted_data, checksum, status, created_at, updated_at, backed_up_at)
         VALUES (?, ?, 'os:ciphertext', 'checksum', 'decryption_failed', 1, 1, 1)`,
      ).run(`${category}-backup-id`, category);
    }
  };

  const categories = (table: string): string[] => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (
        db.prepare(`SELECT category FROM ${table} ORDER BY category`).all() as Array<{
          category: string;
        }>
      ).map((row) => row.category);
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-retired-health-"));
    dbPath = path.join(tmpDir, "cowork-os.db");
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes Health rows from an upgraded or restored profile and keeps other settings", async () => {
    const { DatabaseManager } = await import("../schema");
    // Create the current schema, then simulate data written by an older release.
    new DatabaseManager().close();

    const legacy = new Database(dbPath);
    // Created lazily by SecureSettingsRepository when an unreadable row is replaced.
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS secure_settings_unreadable_backup (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        encrypted_data TEXT NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        backed_up_at INTEGER NOT NULL
      )
    `);
    insertSetting(legacy, "secure_settings", "health");
    insertSetting(legacy, "secure_settings", "voice");
    insertSetting(legacy, "secure_settings_unreadable_backup", "health");
    insertSetting(legacy, "secure_settings_unreadable_backup", "voice");
    legacy.close();

    const manager = new DatabaseManager();
    const pending = manager
      .getDatabase()
      .prepare(
        "SELECT value FROM maintenance_state WHERE key = 'retired_health_checkpoint_pending'",
      )
      .get() as { value: string } | undefined;
    manager.close();

    expect(categories("secure_settings")).toEqual(["voice"]);
    expect(categories("secure_settings_unreadable_backup")).toEqual(["voice"]);
    expect(pending?.value).toBe("0");
  });

  it("starts cleanly on a profile that never had Health data", async () => {
    const { DatabaseManager } = await import("../schema");
    new DatabaseManager().close();

    const manager = new DatabaseManager();
    const pending = manager
      .getDatabase()
      .prepare(
        "SELECT value FROM maintenance_state WHERE key = 'retired_health_checkpoint_pending'",
      )
      .get();
    manager.close();

    expect(pending).toBeUndefined();
  });
});
