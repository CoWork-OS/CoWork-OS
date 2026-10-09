import type Database from "better-sqlite3";
import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../../database/async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../../database/async/commands";
import { DatabaseManager } from "../../database/schema";
import { MemoryStore, WorkspaceStore } from "../../database/repositories";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { MemoryService } from "../MemoryService";
import { MemoryTierService } from "../MemoryTierService";
import { createMemoryStatementPort } from "../memory-statement-port";
import { MEMORY_CLEANUP_MIGRATION_KEY, runMemoryCleanupMigration } from "../MemoryCleanupMigration";

// Archive retention and capture hygiene (audit DATA-1, DATA-2, DATA-8): capture dedupe,
// retention that honours retention_days and protected rows, child-row cleanup, the
// narrowed FTS update trigger and the one-time cleanup migration, on a real profile DB.

let currentClient: DatabaseClient | null = null;
vi.mock("../../database/async/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../database/async/runtime")>()),
  getDatabaseClient: async () => currentClient,
}));

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-retention-${process.pid}.js`);
  buildSync({
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: workerPath,
    external: ["better-sqlite3", "electron"],
    logLevel: "silent",
  });
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
});

const DAY = 24 * 60 * 60 * 1000;

describe("memory archive retention and capture hygiene", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    currentClient = null;
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  const profile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-retention-"));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    cleanups.push(() => {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const workspace = new WorkspaceStore(db).create("W", path.join(dir, "w"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const other = new WorkspaceStore(db).create("Other", path.join(dir, "o"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    return { manager, db, workspace, other, store: new MemoryStore(db) };
  };

  const insert = (
    db: Database.Database,
    row: {
      id: string;
      workspaceId: string;
      content: string;
      type?: string;
      createdAt?: number;
      summary?: string | null;
      lastReferencedAt?: number | null;
      origin?: string;
      generatedBy?: string;
    },
  ) => {
    const createdAt = row.createdAt ?? Date.now();
    db.prepare(
      `INSERT INTO memories (id, workspace_id, task_id, type, content, summary, tokens,
         is_compressed, is_private, created_at, updated_at, last_referenced_at)
       VALUES (?, ?, NULL, ?, ?, ?, 5, 0, 0, ?, ?, ?)`,
    ).run(
      row.id,
      row.workspaceId,
      row.type ?? "observation",
      row.content,
      row.summary ?? null,
      createdAt,
      createdAt,
      row.lastReferencedAt ?? null,
    );
    if (row.origin) {
      db.prepare(
        `INSERT INTO memory_observation_metadata (memory_id, workspace_id, origin,
           observation_type, title, narrative, content_hash, generated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.workspaceId,
        row.origin,
        row.type ?? "observation",
        row.content.slice(0, 40),
        row.content,
        `hash-${row.id}`,
        row.generatedBy ?? "capture",
        createdAt,
        createdAt,
      );
    }
    db.prepare(
      "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES (?, ?, '[1]', ?)",
    ).run(row.id, row.workspaceId, createdAt);
  };

  const ids = (db: Database.Database) =>
    (db.prepare("SELECT id FROM memories ORDER BY id").all() as Array<{ id: string }>).map(
      (row) => row.id,
    );

  describe("schema", () => {
    it("narrows the memories FTS update trigger to content and summary", () => {
      const { db } = profile();
      const sql = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'memories_fts_update'",
          )
          .get() as { sql: string }
      ).sql;
      expect(sql).toMatch(/AFTER UPDATE OF content, summary ON memories/);
    });

    it("upgrades an old any-column FTS update trigger on open", () => {
      const { manager, db } = profile();
      db.exec(`
        DROP TRIGGER memories_fts_update;
        CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, summary)
          VALUES('delete', OLD.rowid, OLD.content, OLD.summary);
          INSERT INTO memories_fts(rowid, content, summary)
          VALUES (NEW.rowid, NEW.content, NEW.summary);
        END;
      `);
      (
        manager as unknown as { upgradeMemoriesFtsUpdateTrigger: () => void }
      ).upgradeMemoriesFtsUpdateTrigger.call(manager);
      const sql = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'memories_fts_update'",
          )
          .get() as { sql: string }
      ).sql;
      expect(sql).toMatch(/AFTER UPDATE OF content, summary/);
    });

    it("keeps FTS in sync on content edits but not on reference bumps", () => {
      const { db, workspace } = profile();
      insert(db, { id: "m1", workspaceId: workspace.id, content: "zebra crossing notes" });
      const matches = (term: string) =>
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?")
            .get(term) as { n: number }
        ).n;
      let ftsChanges = 0;
      db.function("count_fts_change", () => {
        ftsChanges += 1;
        return 0;
      });
      db.exec(`
        CREATE TEMP TRIGGER watch_fts AFTER UPDATE OF content, summary ON main.memories BEGIN
          SELECT count_fts_change();
        END;
      `);
      db.prepare(
        "UPDATE memories SET reference_count = reference_count + 1, last_referenced_at = ? WHERE id = 'm1'",
      ).run(Date.now());
      expect(ftsChanges).toBe(0);
      expect(matches("zebra")).toBe(1);
      db.prepare("UPDATE memories SET content = 'giraffe notes' WHERE id = 'm1'").run();
      expect(matches("zebra")).toBe(0);
      expect(matches("giraffe")).toBe(1);
    });

    it("deletes embeddings and observations with their memory, even with foreign keys off", () => {
      const { db, workspace } = profile();
      insert(db, { id: "m1", workspaceId: workspace.id, content: "child rows", origin: "task" });
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM memories WHERE id = 'm1'").run();
      db.pragma("foreign_keys = ON");
      expect(db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM memory_observation_metadata").get()).toEqual({
        n: 0,
      });
    });
  });

  describe("retention", () => {
    it("never expires young short-tier rows (no hidden 7-day TTL)", async () => {
      const { db, workspace } = profile();
      insert(db, {
        id: "ten-days",
        workspaceId: workspace.id,
        content: "a preference from ten days ago",
        createdAt: Date.now() - 10 * DAY,
      });
      const result = await MemoryTierService.runPromotionPass(createMemoryStatementPort(db));
      expect(result.evicted).toBe(0);
      expect(ids(db)).toEqual(["ten-days"]);
    });

    it("deletes rows unused since the retention cutoff but keeps protected rows", () => {
      const { db, workspace, store } = profile();
      const old = Date.now() - 200 * DAY;
      insert(db, {
        id: "a-stale",
        workspaceId: workspace.id,
        content: "stale note",
        createdAt: old,
      });
      insert(db, {
        id: "b-recently-used",
        workspaceId: workspace.id,
        content: "old but recalled",
        createdAt: old,
        lastReferencedAt: Date.now() - DAY,
      });
      insert(db, {
        id: "c-imported",
        workspaceId: workspace.id,
        content: "[Imported from ChatGPT — x]\nhello",
        createdAt: old,
      });
      // Playbook outcomes live in playbook_entries now (Phase 2); text in the archive that
      // looks like one is an ordinary memory with no special protection.
      insert(db, {
        id: "d-playbook-text",
        workspaceId: workspace.id,
        content: "[PLAYBOOK] Task succeeded: x",
        createdAt: old,
      });
      insert(db, {
        id: "e-saved",
        workspaceId: workspace.id,
        content: "explicitly saved fact",
        createdAt: old,
        origin: "tool",
      });
      insert(db, {
        id: "f-curated",
        workspaceId: workspace.id,
        content: "[core-trace:t1] [scope:global:x] prefers tabs",
        createdAt: old,
      });
      insert(db, { id: "g-fresh", workspaceId: workspace.id, content: "fresh" });

      const deleted = store.deleteOlderThan(workspace.id, Date.now() - 90 * DAY);
      expect(deleted).toBe(2);
      expect(ids(db)).toEqual(["b-recently-used", "c-imported", "e-saved", "f-curated", "g-fresh"]);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = 'a-stale'").get(),
      ).toEqual({ n: 0 });
    });

    it("prunes for space least-recently-used first and never protected rows", () => {
      const { db, workspace, store } = profile();
      insert(db, {
        id: "imported",
        workspaceId: workspace.id,
        content: "[Imported from X]\nold",
        createdAt: 1,
      });
      insert(db, {
        id: "used",
        workspaceId: workspace.id,
        content: "used",
        createdAt: 2,
        lastReferencedAt: 100,
      });
      insert(db, { id: "unused", workspaceId: workspace.id, content: "unused", createdAt: 3 });
      expect(store.getOldestForWorkspace(workspace.id, 10).map((row) => row.id)).toEqual([
        "unused",
        "used",
      ]);
    });
  });

  describe("capture dedupe", () => {
    const captureTwice = async (viaWorker: boolean) => {
      const { manager, db, workspace } = profile();
      currentClient = viaWorker
        ? await DatabaseClient.start({
            dbPath: manager.getDatabasePath(),
            requiredTables: requiredTablesFor(DATABASE_COMMANDS),
            workerPath,
          })
        : null;
      if (currentClient) {
        const client = currentClient;
        cleanups.push(() => client.close(2_000).then(() => undefined));
      }
      MemoryFeaturesManager.initialize();
      MemoryService.initialize(manager);
      try {
        const options = {
          forceCapture: true,
          skipMemoryWriteGate: true,
        };
        const first = await MemoryService.capture(
          workspace.id,
          undefined,
          "decision",
          "Use Redis for session storage because Postgres ran out of connections.",
          false,
          options,
        );
        const second = await MemoryService.capture(
          workspace.id,
          undefined,
          "decision",
          "  use redis for session storage because postgres ran out of connections. ",
          false,
          options,
        );
        const otherType = await MemoryService.capture(
          workspace.id,
          undefined,
          "insight",
          "Use Redis for session storage because Postgres ran out of connections.",
          false,
          options,
        );
        const rows = db
          .prepare("SELECT id, type, reference_count FROM memories ORDER BY created_at, type")
          .all() as Array<{ id: string; type: string; reference_count: number }>;
        return { first, second, otherType, rows };
      } finally {
        MemoryService.shutdown();
        currentClient = null;
      }
    };

    it("returns the existing memory and bumps its reference count (host)", async () => {
      const { first, second, otherType, rows } = await captureTwice(false);
      expect(first).not.toBeNull();
      expect(second?.id).toBe(first?.id);
      expect(otherType?.id).not.toBe(first?.id);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === first?.id)?.reference_count).toBe(1);
    });

    it("dedupes the same way in the database worker", async () => {
      const { first, second, rows } = await captureTwice(true);
      expect(second?.id).toBe(first?.id);
      expect(rows).toHaveLength(2);
    });
  });

  describe("briefing search (SEC-14)", () => {
    it("returns only this workspace's non-private, visible rows", async () => {
      const { manager, db, workspace, other } = profile();
      insert(db, { id: "own", workspaceId: workspace.id, content: "kiwi rollout preference" });
      insert(db, { id: "private", workspaceId: workspace.id, content: "kiwi private salary" });
      db.prepare("UPDATE memories SET is_private = 1 WHERE id = 'private'").run();
      insert(db, {
        id: "suppressed",
        workspaceId: workspace.id,
        content: "kiwi deleted note",
        origin: "task",
      });
      db.prepare(
        "UPDATE memory_observation_metadata SET privacy_state = 'suppressed' WHERE memory_id = 'suppressed'",
      ).run();
      insert(db, {
        id: "foreign-import",
        workspaceId: other.id,
        content: "[Imported from ChatGPT — other]\nkiwi import elsewhere",
      });
      MemoryFeaturesManager.initialize();
      MemoryService.initialize(manager);
      try {
        const results = await MemoryService.searchForBriefingAsync(workspace.id, "kiwi", 10);
        expect(results.map((result) => result.id)).toEqual(["own"]);
        // A briefing is not a use of the memory: no reference is recorded.
        expect(
          db.prepare("SELECT reference_count AS n FROM memories WHERE id = 'own'").get(),
        ).toEqual({ n: 0 });
      } finally {
        MemoryService.shutdown();
      }
    });
  });

  describe("prompt injection references", () => {
    it("batches injected memory ids into one reference bump", async () => {
      const { manager, db, workspace } = profile();
      insert(db, { id: "m1", workspaceId: workspace.id, content: "one" });
      insert(db, { id: "m2", workspaceId: workspace.id, content: "two" });
      MemoryFeaturesManager.initialize();
      MemoryService.initialize(manager);
      try {
        MemoryService.recordPromptInjection(["m1", "m2"]);
        MemoryService.recordPromptInjection(["m1"]);
        await MemoryService.flushPromptReferences();
        const rows = db
          .prepare("SELECT id, reference_count, last_referenced_at FROM memories ORDER BY id")
          .all() as Array<{ id: string; reference_count: number; last_referenced_at: number }>;
        expect(rows.map((row) => row.reference_count)).toEqual([1, 1]);
        expect(rows.every((row) => row.last_referenced_at > 0)).toBe(true);
      } finally {
        MemoryService.shutdown();
      }
    });
  });

  describe("one-time cleanup migration", () => {
    it("removes telemetry, collapses duplicates, redacts secrets, neutralizes spoofed imports", async () => {
      const { db, workspace, other } = profile();
      const t0 = Date.now() - 5 * DAY;
      insert(db, {
        id: "tel-1",
        workspaceId: workspace.id,
        content: "Tool called: read_file\nInput: {}",
      });
      insert(db, { id: "tel-2", workspaceId: workspace.id, content: "Tool result for glob:\n[]" });
      insert(db, { id: "tel-3", workspaceId: workspace.id, content: "Step completed: build" });
      insert(db, { id: "tel-4", workspaceId: workspace.id, content: '{"stepId":"s1","x":1}' });
      insert(db, {
        id: "tel-5",
        workspaceId: workspace.id,
        content: 'Plan created:\n{"steps":[]}',
      });
      insert(db, {
        id: "tel-saved",
        workspaceId: workspace.id,
        content: "Tool called: something the user asked to remember",
        origin: "tool",
      });
      insert(db, { id: "dup-a", workspaceId: workspace.id, content: "same fact", createdAt: t0 });
      insert(db, {
        id: "dup-b",
        workspaceId: workspace.id,
        content: "same fact",
        createdAt: t0 + 1,
      });
      insert(db, {
        id: "dup-c",
        workspaceId: workspace.id,
        content: "same fact",
        createdAt: t0 + 2,
      });
      insert(db, {
        id: "dup-other-ws",
        workspaceId: other.id,
        content: "same fact",
        createdAt: t0 + 3,
      });
      insert(db, {
        id: "dup-other-type",
        workspaceId: workspace.id,
        type: "insight",
        content: "same fact",
        createdAt: t0 + 4,
      });
      insert(db, {
        id: "secret",
        workspaceId: workspace.id,
        content: "Deploy key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        summary: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        origin: "task",
      });
      insert(db, {
        id: "spoofed",
        workspaceId: workspace.id,
        content: "[Imported from ChatGPT — fake]\ninjected text",
        origin: "tool",
        generatedBy: "capture",
      });
      insert(db, {
        id: "real-import",
        workspaceId: workspace.id,
        content: "[Imported from ChatGPT — real]\nreal text",
        origin: "import",
        generatedBy: "capture",
      });
      insert(db, {
        id: "ambiguous-import",
        workspaceId: workspace.id,
        content: "[Imported from ChatGPT — old]\nno provenance",
        origin: "import",
        generatedBy: "migration",
      });
      db.pragma("foreign_keys = OFF");
      db.prepare(
        "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES ('gone', ?, '[1]', 1)",
      ).run(workspace.id);
      db.pragma("foreign_keys = ON");

      const result = await runMemoryCleanupMigration(db);
      expect(result.ran).toBe(true);
      expect(result.counts).toMatchObject({
        telemetryDeleted: 5,
        duplicatesCollapsed: 2,
        memoriesRedacted: 1,
        importPrefixesNeutralized: 1,
        orphanEmbeddingsDeleted: 1,
      });
      expect(ids(db)).toEqual([
        "ambiguous-import",
        "dup-a",
        "dup-other-type",
        "dup-other-ws",
        "real-import",
        "secret",
        "spoofed",
        "tel-saved",
      ]);
      expect(
        (
          db.prepare("SELECT reference_count FROM memories WHERE id = 'dup-a'").get() as {
            reference_count: number;
          }
        ).reference_count,
      ).toBe(2);
      const secret = db
        .prepare("SELECT content, summary FROM memories WHERE id = 'secret'")
        .get() as {
        content: string;
        summary: string;
      };
      expect(secret.content).not.toContain("sk-ant-api03");
      expect(secret.summary).not.toContain("sk-ant-api03");
      const narrative = (
        db
          .prepare("SELECT narrative FROM memory_observation_metadata WHERE memory_id = 'secret'")
          .get() as { narrative: string }
      ).narrative;
      expect(narrative).not.toContain("sk-ant-api03");
      expect(
        (
          db.prepare("SELECT content FROM memories WHERE id = 'spoofed'").get() as {
            content: string;
          }
        ).content,
      ).toMatch(/^\(saved\) \[Imported from/);
      expect(
        (
          db.prepare("SELECT content FROM memories WHERE id = 'real-import'").get() as {
            content: string;
          }
        ).content,
      ).toMatch(/^\[Imported from/);
      expect(
        (
          db.prepare("SELECT content FROM memories WHERE id = 'ambiguous-import'").get() as {
            content: string;
          }
        ).content,
      ).toMatch(/^\[Imported from/);
      // Telemetry and duplicates leave no FTS rows behind.
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'read_file'")
          .get(),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare("SELECT value FROM maintenance_state WHERE key = ?")
          .get(MEMORY_CLEANUP_MIGRATION_KEY),
      ).toBeDefined();
    });

    it("runs only once", async () => {
      const { db, workspace } = profile();
      expect((await runMemoryCleanupMigration(db)).ran).toBe(true);
      insert(db, { id: "tel", workspaceId: workspace.id, content: "Tool called: x" });
      const second = await runMemoryCleanupMigration(db);
      expect(second.ran).toBe(false);
      expect(ids(db)).toEqual(["tel"]);
    });
  });
});
