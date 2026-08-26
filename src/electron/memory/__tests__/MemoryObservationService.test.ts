import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryObservationService } from "../MemoryObservationService";

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

function createDb(): import("better-sqlite3").Database {
  if (!BetterSqlite3) throw new Error("better-sqlite3 unavailable");
  const db = new BetterSqlite3(":memory:");
  databases.push(db);
  db.exec(`
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
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE memory_observation_metadata (
      memory_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      task_id TEXT,
      origin TEXT NOT NULL DEFAULT 'unknown',
      observation_type TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      narrative TEXT NOT NULL,
      facts TEXT NOT NULL DEFAULT '[]',
      concepts TEXT NOT NULL DEFAULT '[]',
      files_read TEXT NOT NULL DEFAULT '[]',
      files_modified TEXT NOT NULL DEFAULT '[]',
      tools TEXT NOT NULL DEFAULT '[]',
      source_event_ids TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      capture_reason TEXT NOT NULL DEFAULT 'memory_capture',
      privacy_state TEXT NOT NULL DEFAULT 'normal',
      generated_by TEXT NOT NULL DEFAULT 'capture',
      migration_status TEXT NOT NULL DEFAULT 'current',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE memory_observation_metadata_fts USING fts5(
      title, subtitle, narrative, facts, concepts, files_read, files_modified, tools,
      content='memory_observation_metadata',
      content_rowid='rowid'
    );
    CREATE TRIGGER memory_observation_metadata_fts_insert
    AFTER INSERT ON memory_observation_metadata BEGIN
      INSERT INTO memory_observation_metadata_fts(
        rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified, tools
      )
      VALUES (
        NEW.rowid, NEW.title, NEW.subtitle, NEW.narrative, NEW.facts, NEW.concepts,
        NEW.files_read, NEW.files_modified, NEW.tools
      );
    END;
    CREATE TRIGGER memory_observation_metadata_fts_update
    AFTER UPDATE ON memory_observation_metadata BEGIN
      INSERT INTO memory_observation_metadata_fts(
        memory_observation_metadata_fts, rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified, tools
      )
      VALUES (
        'delete', OLD.rowid, OLD.title, OLD.subtitle, OLD.narrative, OLD.facts, OLD.concepts,
        OLD.files_read, OLD.files_modified, OLD.tools
      );
      INSERT INTO memory_observation_metadata_fts(
        rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified, tools
      )
      VALUES (
        NEW.rowid, NEW.title, NEW.subtitle, NEW.narrative, NEW.facts, NEW.concepts,
        NEW.files_read, NEW.files_modified, NEW.tools
      );
    END;
  `);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  (MemoryObservationService as Any).db = null;
});

describeWithNativeDb("MemoryObservationService", () => {
  it("backfills legacy memories into structured observations", () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO memories (
        id, workspace_id, task_id, type, content, summary, tokens, is_compressed, is_private, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "mem-1",
      "ws-1",
      "task-1",
      "decision",
      "Updated src/auth/login.ts and decided to keep session validation local.",
      null,
      20,
      0,
      0,
      100,
      100,
    );

    MemoryObservationService.initialize(db);
    MemoryObservationService.startBackfill();
    const status = MemoryObservationService.getBackfillStatus();
    const details = MemoryObservationService.details(["mem-1"])[0];

    expect(status.processed).toBe(1);
    expect(details?.title).toContain("Updated");
    expect(details?.concepts).toContain("session");
    expect(details?.filesModified).toContain("src/auth/login.ts");
    expect(details?.migrationStatus).toBe("backfilled");
  });

  it("searches metadata and returns compact index rows", () => {
    const db = createDb();
    MemoryObservationService.initialize(db);
    const memory = {
      id: "mem-2",
      workspaceId: "ws-1",
      taskId: "task-2",
      type: "insight",
      content: "Verifier failures should be stored as high-signal memory observations.",
      tokens: 18,
      isCompressed: false,
      isPrivate: false,
      createdAt: 200,
      updatedAt: 200,
    } as const;
    db.prepare(`
      INSERT INTO memories (
        id, workspace_id, task_id, type, content, summary, tokens, is_compressed, is_private, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id,
      memory.workspaceId,
      memory.taskId,
      memory.type,
      memory.content,
      null,
      memory.tokens,
      0,
      0,
      memory.createdAt,
      memory.updatedAt,
    );
    MemoryObservationService.createForMemory(memory);

    const results = MemoryObservationService.search({
      workspaceId: "ws-1",
      query: "verifier",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.memoryId).toBe("mem-2");
    expect(results[0]?.estimatedDetailTokens).toBeGreaterThan(0);
  });

  it("marks redacted observations private and suppressible", () => {
    const db = createDb();
    MemoryObservationService.initialize(db);
    db.prepare(`
      INSERT INTO memories (
        id, workspace_id, task_id, type, content, summary, tokens, is_compressed, is_private, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("mem-3", "ws-1", null, "observation", "Sensitive text", null, 5, 0, 0, 300, 300);
    MemoryObservationService.startBackfill(true);

    const redacted = MemoryObservationService.redact("ws-1", "mem-3");
    const memoryRow = db.prepare("SELECT content, is_private FROM memories WHERE id = ?").get("mem-3") as Any;

    expect(redacted?.privacyState).toBe("redacted");
    expect(memoryRow.content).toBe("[redacted]");
    expect(memoryRow.is_private).toBe(1);
    expect(MemoryObservationService.isPromptSuppressed("mem-3")).toBe(true);
  });
});
