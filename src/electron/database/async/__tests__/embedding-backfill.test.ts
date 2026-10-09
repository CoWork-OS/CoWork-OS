import Database from "better-sqlite3";
import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../commands";
import { DatabaseManager } from "../../schema";
import { MemoryEmbeddingStore, MemoryStore, WorkspaceStore } from "../../repositories";
import type { MemoryEmbeddingRow } from "../../memory-embedding-sql";
import { createLocalEmbedding } from "../../../memory/local-embedding";
import {
  findMissingEmbeddingRows,
  MemoryEmbeddingCache,
} from "../../../memory/memory-embedding-cache";
import { MemoryFeaturesManager } from "../../../settings/memory-features-manager";
import { MemoryService } from "../../../memory/MemoryService";

// Embedding backfill writes in the database worker (DB4): batches land there, the FTS
// worker's cache hears about them, stale batches cannot overwrite newer embeddings,
// and host and worker writes produce the same rows.

let currentClient: DatabaseClient | null = null;
vi.mock("../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime")>()),
  getDatabaseClient: async () => currentClient,
}));

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-embeddings-${process.pid}.js`);
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

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("embedding backfill writes", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    currentClient = null;
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  /** A fresh profile with two memories that have no embeddings yet. */
  const profile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-embedding-backfill-"));
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
    const memories = new MemoryStore(db);
    const created = ["release notes checklist", "deploy worker latency"].map((content) =>
      memories.create({
        workspaceId: workspace.id,
        type: "observation",
        content,
        tokens: 10,
        isCompressed: false,
        isPrivate: false,
      }),
    );
    return { manager, db, workspace, memories: created };
  };

  const startWriter = async (manager: DatabaseManager) => {
    const client = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
    });
    cleanups.push(() => client.close(2_000).then(() => undefined));
    return client;
  };

  const rowsFor = (
    workspaceId: string,
    memories: Array<{ id: string; content: string; updatedAt: number }>,
  ): MemoryEmbeddingRow[] =>
    memories.map((memory) => ({
      memoryId: memory.id,
      workspaceId,
      updatedAt: memory.updatedAt,
      embedding: createLocalEmbedding(memory.content),
    }));

  const storedRows = (db: Database.Database) =>
    db
      .prepare(
        "SELECT memory_id, workspace_id, embedding, updated_at FROM memory_embeddings ORDER BY memory_id",
      )
      .all();

  it("runs a workspace backfill through the worker and the FTS cache sees it", async () => {
    const { manager, db, workspace, memories } = profile();
    currentClient = await startWriter(manager);
    const reader = new Database(manager.getDatabasePath(), { readonly: true });
    cleanups.push(() => reader.close());
    const cache = new MemoryEmbeddingCache(reader);
    // Loaded before the backfill: empty, so only an invalidation can fill it.
    expect(cache.workspace(workspace.id).size).toBe(0);
    const worker = {
      findMissingEmbeddings: vi.fn(async (workspaceId: string | null, limit: number) =>
        findMissingEmbeddingRows(reader, workspaceId, limit),
      ),
      invalidateEmbeddings: vi.fn((change: Parameters<MemoryEmbeddingCache["invalidate"]>[0]) =>
        cache.invalidate(change),
      ),
    };
    MemoryFeaturesManager.initialize();
    MemoryService.initialize(manager);
    MemoryService.initFtsWorker(worker as never);
    cleanups.push(() => {
      MemoryService.shutdown();
      (MemoryService as unknown as { ftsWorker: unknown }).ftsWorker = null;
    });
    const execute = vi.spyOn(currentClient, "execute");

    await (
      MemoryService as unknown as { runEmbeddingBackfill(id: string): Promise<void> }
    ).runEmbeddingBackfill(workspace.id);

    expect(execute.mock.calls.map(([name]) => name)).toEqual(["memory.upsertEmbeddings"]);
    await waitFor(() => storedRows(db).length === 2);
    expect(worker.invalidateEmbeddings).toHaveBeenCalledWith({
      kind: "memories",
      memoryIds: expect.arrayContaining(memories.map((memory) => memory.id)),
    });
    expect(new Set(cache.workspace(workspace.id).keys())).toEqual(
      new Set(memories.map((memory) => memory.id)),
    );
  });

  it("does not let a stale batch overwrite a newer embedding", async () => {
    const { manager, db, workspace, memories } = profile();
    const client = await startWriter(manager);
    const [first, second] = memories;
    // A newer version of `first` already has its embedding.
    const newerAt = first.updatedAt + 1_000;
    db.prepare("UPDATE memories SET updated_at = ?, content = ? WHERE id = ?").run(
      newerAt,
      "release notes checklist, revised",
      first.id,
    );
    new MemoryEmbeddingStore(db).upsert(
      workspace.id,
      first.id,
      createLocalEmbedding("release notes checklist, revised"),
      newerAt,
    );
    const before = storedRows(db);

    const { written } = await client.execute("memory.upsertEmbeddings", {
      rows: rowsFor(workspace.id, [first, second]),
    });
    expect(written).toEqual([second.id]);
    const after = storedRows(db) as Array<{ memory_id: string }>;
    expect(after.find((row) => row.memory_id === first.id)).toEqual(before[0]);

    // The host batch path applies the same rule.
    expect(
      new MemoryEmbeddingStore(db).upsertBackfillBatch(rowsFor(workspace.id, [first])),
    ).toEqual([]);
    expect(storedRows(db)).toEqual(after);
  });

  it("writes the same rows from the host and from the worker", async () => {
    // Two profiles with identical workspaces and memories, so the rows can match exactly.
    const seedFixed = (db: Database.Database) => {
      db.prepare(
        "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES ('ws-fixed', 'F', '/tmp/f', 1, '{}')",
      ).run();
      const insert = db.prepare(
        `INSERT INTO memories (id, workspace_id, type, content, tokens, is_compressed, is_private, created_at, updated_at)
         VALUES (?, 'ws-fixed', 'observation', ?, 10, 0, 0, ?, ?)`,
      );
      const fixed = [
        { id: "m-fixed-1", content: "release notes checklist", updatedAt: 5_000 },
        { id: "m-fixed-2", content: "[Imported from ChatGPT] budget planner", updatedAt: 6_000 },
      ];
      for (const memory of fixed) insert.run(memory.id, memory.content, 1_000, memory.updatedAt);
      return rowsFor("ws-fixed", fixed);
    };
    const host = profile();
    const hostRows = seedFixed(host.db);
    expect(new MemoryEmbeddingStore(host.db).upsertBackfillBatch(hostRows)).toHaveLength(2);

    const viaWorker = profile();
    const workerRows = seedFixed(viaWorker.db);
    const client = await startWriter(viaWorker.manager);
    const { written } = await client.execute("memory.upsertEmbeddings", { rows: workerRows });
    expect(written).toHaveLength(2);
    expect(storedRows(viaWorker.db)).toEqual(storedRows(host.db));
  });

  it("captures a memory in one worker transaction, with the same rows as the host path", async () => {
    const capture = async (viaWorker: boolean) => {
      const { manager, db, workspace } = profile();
      currentClient = viaWorker ? await startWriter(manager) : null;
      const invalidations: unknown[] = [];
      MemoryFeaturesManager.initialize();
      MemoryService.initialize(manager);
      MemoryService.initFtsWorker({
        invalidateEmbeddings: (change: unknown) => invalidations.push(change),
      } as never);
      const execute = currentClient ? vi.spyOn(currentClient, "execute") : null;
      try {
        const memory = await MemoryService.capture(
          workspace.id,
          undefined,
          "observation",
          "Deploy the worker after the release notes checklist passes review.",
          false,
          { forceCapture: true, skipMemoryWriteGate: true },
        );
        expect(memory).not.toBeNull();
        if (execute) {
          expect(execute.mock.calls.map(([name]) => name)).toContain("memory.capture");
        }
        expect(invalidations).toContainEqual({ kind: "memories", memoryIds: [memory!.id] });
        const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(memory!.id) as Record<
          string,
          unknown
        >;
        const embedding = db
          .prepare("SELECT embedding, updated_at FROM memory_embeddings WHERE memory_id = ?")
          .get(memory!.id) as { embedding: string; updated_at: number } | undefined;
        const observation = db
          .prepare(
            "SELECT observation_type, title, narrative, facts, concepts, content_hash, capture_reason, privacy_state FROM memory_observation_metadata WHERE memory_id = ?",
          )
          .get(memory!.id);
        return {
          row: {
            type: row.type,
            content: row.content,
            summary: row.summary,
            tokens: row.tokens,
            is_compressed: row.is_compressed,
            is_private: row.is_private,
          },
          embedding: embedding?.embedding,
          embeddingCurrent: embedding?.updated_at === row.updated_at,
          observation,
        };
      } finally {
        MemoryService.shutdown();
        (MemoryService as unknown as { ftsWorker: unknown }).ftsWorker = null;
        currentClient = null;
      }
    };
    const host = await capture(false);
    const worker = await capture(true);
    expect(worker).toEqual(host);
    expect(host.row.summary).toBeTruthy();
    expect(host.embedding).toBeTruthy();
    expect(host.embeddingCurrent).toBe(true);
    expect(host.observation).toBeTruthy();
  });

  it("rejects malformed batches in the worker", async () => {
    const { manager } = profile();
    const client = await startWriter(manager);
    await expect(
      client.execute("memory.upsertEmbeddings", {
        rows: [{ memoryId: "m", workspaceId: "w", updatedAt: 1, embedding: ["x"] }] as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.execute("memory.upsertEmbeddings", {
        rows: Array.from({ length: 501 }, () => ({
          memoryId: "m",
          workspaceId: "w",
          updatedAt: 1,
          embedding: [1],
        })),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
