import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import {
  MemoryEmbeddingStore,
  MemoryStore,
  onMemoryEmbeddingChange,
} from "../../database/repositories";
import { createLocalEmbedding } from "../local-embedding";
import { findMissingEmbeddingRows, MemoryEmbeddingCache } from "../memory-embedding-cache";
import { rankHybridMemories } from "../memory-hybrid-rank";

const nativeSqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

// The FTS worker's embedding cache (DB4): same ranking as the host caches, and coherent
// with host writes through the repository's change notifications.
describeWithSqlite("MemoryEmbeddingCache", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let reader: Database.Database;
  let memories: MemoryStore;
  let embeddings: MemoryEmbeddingStore;
  const unsubscribes: Array<() => void> = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-embedding-cache-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    for (const id of ["ws-1", "ws-2"]) {
      db.prepare(
        "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
      ).run(id, id, path.join(tempDir, id), 1, "{}");
    }
    memories = new MemoryStore(db);
    embeddings = new MemoryEmbeddingStore(db);
    reader = new Database(manager.getDatabasePath(), { readonly: true });
  });

  afterEach(() => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    reader.close();
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const addMemory = (workspaceId: string, content: string) => {
    const memory = memories.create({
      workspaceId,
      type: "observation",
      content,
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
    });
    embeddings.upsert(workspaceId, memory.id, createLocalEmbedding(content), memory.updatedAt);
    return memory;
  };

  const hostMap = (rows: Array<{ memoryId: string; embedding: number[] }>) =>
    new Map(rows.map((row) => [row.memoryId, { embedding: Float32Array.from(row.embedding) }]));

  it("ranks exactly like the host caches for the same lexical candidates", () => {
    const words = ["release", "notes", "deploy", "worker", "latency", "budget", "planner"];
    for (let index = 0; index < 60; index += 1) {
      const content = Array.from({ length: 12 }, (_, i) => words[(index * 3 + i * 5) % 7]).join(
        " ",
      );
      addMemory(
        index % 5 === 0 ? "ws-2" : "ws-1",
        index % 7 === 0 ? `[Imported from X] ${content}` : content,
      );
    }
    const cache = new MemoryEmbeddingCache(reader);
    const lexical = memories.search("ws-1", "release notes", 10, true);
    const params = {
      query: "release notes deploy",
      limit: 10,
      lexicalLocal: lexical,
      lexicalImportedGlobal: [],
    };
    const host = rankHybridMemories({
      ...params,
      workspaceEmbeddings: hostMap(embeddings.getByWorkspace("ws-1")).entries(),
      importedEmbeddings: hostMap(embeddings.getImportedGlobal(200_000, 0)).entries(),
      loadRows: (ids) => memories.getFullDetails(ids),
    });
    const worker = rankHybridMemories({
      ...params,
      workspaceEmbeddings: cache.workspace("ws-1").entries(),
      importedEmbeddings: cache.importedGlobal().entries(),
      loadRows: (ids) => new MemoryStore(reader).getFullDetails(ids),
    });
    expect(host.length).toBeGreaterThan(0);
    expect(worker).toEqual(host);
  });

  it("reloads rows the repository reports as changed or deleted", () => {
    const cache = new MemoryEmbeddingCache(reader);
    unsubscribes.push(onMemoryEmbeddingChange((change) => cache.invalidate(change)));
    const first = addMemory("ws-1", "release notes checklist");
    expect([...cache.workspace("ws-1").keys()]).toEqual([first.id]);

    const second = addMemory("ws-1", "deploy worker latency");
    const imported = addMemory("ws-2", "[Imported from ChatGPT] budget planner");
    expect(cache.importedGlobal().has(imported.id)).toBe(true);
    expect(new Set(cache.workspace("ws-1").keys())).toEqual(new Set([first.id, second.id]));

    embeddings.deleteByMemoryIds([first.id]);
    expect([...cache.workspace("ws-1").keys()]).toEqual([second.id]);

    embeddings.deleteImported("ws-2");
    expect(cache.importedGlobal().has(imported.id)).toBe(false);
  });

  it("finds the same missing embeddings as the host repository", () => {
    addMemory("ws-1", "release notes with an embedding");
    const plain = (workspaceId: string, content: string) =>
      memories.create({
        workspaceId,
        type: "observation",
        content,
        tokens: 10,
        isCompressed: false,
        isPrivate: false,
      });
    plain("ws-1", "deploy worker without embedding");
    plain("ws-2", "[Imported from ChatGPT] budget planner without embedding");
    const strip = <T extends { memoryId: string; updatedAt: number; content: string }>(rows: T[]) =>
      rows.map(({ memoryId, updatedAt, content }) => ({ memoryId, updatedAt, content }));
    expect(strip(findMissingEmbeddingRows(reader, "ws-1", 50))).toEqual(
      strip(embeddings.findMissingOrStale("ws-1", 50)),
    );
    expect(findMissingEmbeddingRows(reader, null, 50)).toEqual(
      embeddings.findMissingOrStaleImportedGlobal(50),
    );
    expect(findMissingEmbeddingRows(reader, "ws-1", 50)).toHaveLength(1);
  });

  it("bounds staleness from unreported deletes with a periodic full reload", () => {
    // A negative age reloads on every access, standing in for an elapsed interval.
    const cache = new MemoryEmbeddingCache(reader, -1);
    const memory = addMemory("ws-1", "release notes checklist");
    expect(cache.workspace("ws-1").has(memory.id)).toBe(true);
    // A cascade from a deleted memory bypasses the repository notification.
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
    expect(cache.workspace("ws-1").has(memory.id)).toBe(false);
  });
});
