import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeGraphService } from "../KnowledgeGraphService";

const require = createRequire(import.meta.url);
const BetterSqlite3Module = (() => {
  try {
    return require("better-sqlite3") as typeof import("better-sqlite3");
  } catch {
    return null;
  }
})();

const BetterSqlite3 = (() => {
  if (!BetterSqlite3Module) return null;
  try {
    const probe = new BetterSqlite3Module(":memory:");
    probe.close();
    return BetterSqlite3Module;
  } catch {
    return null;
  }
})();

const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;
const databases: Array<import("better-sqlite3").Database> = [];

function resetService(): void {
  clearTimeout((KnowledgeGraphService as Any).cleanupTimer);
  (KnowledgeGraphService as Any).cleanupTimer = undefined;
  (KnowledgeGraphService as Any).repo = null;
  (KnowledgeGraphService as Any).initialized = false;
  (KnowledgeGraphService as Any).lastDecayRun = new Map();
}

function createDb(): import("better-sqlite3").Database {
  if (!BetterSqlite3) {
    throw new Error("better-sqlite3 unavailable");
  }
  const db = new BetterSqlite3(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE kg_entity_types (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT,
      icon TEXT,
      is_builtin INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(workspace_id, name)
    );

    CREATE TABLE kg_entities (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      entity_type_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      properties TEXT DEFAULT '{}',
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'manual',
      source_task_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

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
      valid_from INTEGER,
      valid_to INTEGER
    );

    CREATE UNIQUE INDEX idx_kg_edges_current_unique
      ON kg_edges(workspace_id, source_entity_id, target_entity_id, edge_type)
      WHERE valid_to IS NULL;
  `);
  return db;
}

beforeEach(() => {
  resetService();
});

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
  resetService();
});

describeWithNativeDb("KnowledgeGraphService", () => {
  it("returns the existing current edge when creating the same open-ended relation twice", async () => {
    const db = createDb();
    KnowledgeGraphService.initialize(db);

    const workspaceId = "ws-service";
    const alpha = await KnowledgeGraphService.createEntity(workspaceId, {
      entityType: "project",
      name: "Alpha",
    });
    const beta = await KnowledgeGraphService.createEntity(workspaceId, {
      entityType: "project",
      name: "Beta",
    });

    const first = await KnowledgeGraphService.createEdge(workspaceId, {
      sourceEntityId: alpha.id,
      targetEntityId: beta.id,
      edgeType: "depends_on",
    });
    const second = await KnowledgeGraphService.createEdge(workspaceId, {
      sourceEntityId: alpha.id,
      targetEntityId: beta.id,
      edgeType: "depends_on",
    });

    expect(second.id).toBe(first.id);
  });
});
