import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Probe = module.default;
      const probe = new Probe(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("DatabaseManager temporal kg edge migration", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-kg-temporal-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const dbPath = path.join(tmpDir, "cowork-os.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE kg_edges (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        properties TEXT DEFAULT '{}',
        confidence REAL DEFAULT 1.0,
        source TEXT DEFAULT 'manual',
        source_task_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(workspace_id, source_entity_id, target_entity_id, edge_type)
      );
    `);
    db.close();
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rebuilds legacy kg_edges safely and restores temporal indexes", async () => {
    const { DatabaseManager } = await import("../schema");
    const manager = new DatabaseManager();
    const db = manager.getDatabase();

    const columns = db.prepare("PRAGMA table_info(kg_edges)").all() as Array<{ name: string }>;
    const indexes = db.prepare("PRAGMA index_list(kg_edges)").all() as Array<{ name: string }>;
    const foreignKeysEnabled = db.pragma("foreign_keys", { simple: true }) as number;
    const legacyTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kg_edges_legacy_temporal'")
      .get() as { name?: string } | undefined;

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["valid_from", "valid_to"]));
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["idx_kg_edges_validity", "idx_kg_edges_current_unique"]),
    );
    expect(foreignKeysEnabled).toBe(1);
    expect(legacyTable).toBeUndefined();

    manager.close();
  });
});
