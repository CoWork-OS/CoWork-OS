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

describeWithSqlite("DatabaseManager memory embedding cascade migration", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-memory-cascade-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const dbPath = path.join(tmpDir, "cowork-os.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        permissions TEXT NOT NULL
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        tokens INTEGER NOT NULL DEFAULT 0,
        is_compressed INTEGER NOT NULL DEFAULT 0,
        is_private INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );
      CREATE TABLE memory_embeddings (
        memory_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (memory_id) REFERENCES memories(id)
      );
      INSERT INTO workspaces (id, name, path, created_at, permissions)
      VALUES ('workspace-1', 'Workspace', '/tmp/workspace-1', 1, '{}');
      INSERT INTO memories (
        id, workspace_id, type, content, tokens, is_compressed, is_private, created_at, updated_at
      ) VALUES ('memory-1', 'workspace-1', 'observation', 'Old memory', 2, 0, 0, 1, 1);
      INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at)
      VALUES ('memory-1', 'workspace-1', '[0.1,0.2]', 1);
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

  it("preserves embeddings and cascades them when a retained memory is deleted", async () => {
    const { DatabaseManager } = await import("../schema");
    const manager = new DatabaseManager();
    const db = manager.getDatabase();

    const memoryForeignKey = (
      db.prepare("PRAGMA foreign_key_list(memory_embeddings)").all() as Array<{
        table: string;
        from: string;
        on_delete: string;
      }>
    ).find((foreignKey) => foreignKey.table === "memories");

    expect(memoryForeignKey).toMatchObject({ from: "memory_id", on_delete: "CASCADE" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get()).toMatchObject({
      count: 1,
    });

    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    expect(() => db.prepare("DELETE FROM memories WHERE id = ?").run("memory-1")).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get()).toMatchObject({
      count: 0,
    });

    manager.close();
  });
});
