import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeGraphRepository } from "../KnowledgeGraphRepository";

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

function createRepository(): KnowledgeGraphRepository {
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
  return new KnowledgeGraphRepository(db);
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

describeWithNativeDb("KnowledgeGraphRepository temporal edges", () => {
  it("invalidates current edges and supports historical asOf traversal", () => {
    const repo = createRepository();
    const workspaceId = "ws-temporal";
    const entityType = repo.getOrCreateEntityType(workspaceId, "project");
    const alpha = repo.createEntity(workspaceId, entityType.id, "Alpha");
    const beta = repo.createEntity(workspaceId, entityType.id, "Beta");

    const startA = 1_000;
    const endA = 2_000;
    const startB = 3_000;

    const oldEdge = repo.createEdge(
      workspaceId,
      alpha.id,
      beta.id,
      "depends_on",
      undefined,
      1,
      "agent",
      "task-1",
      startA,
    );
    repo.invalidateEdge(oldEdge.id, endA);

    const currentAt1500 = repo.getNeighbors(alpha.id, 1, undefined, 1_500);
    expect(currentAt1500).toHaveLength(1);
    expect(currentAt1500[0]?.edge.id).toBe(oldEdge.id);

    const noneAt2500 = repo.getNeighbors(alpha.id, 1, undefined, 2_500);
    expect(noneAt2500).toHaveLength(0);

    const newEdge = repo.createEdge(
      workspaceId,
      alpha.id,
      beta.id,
      "depends_on",
      { reason: "reintroduced" },
      1,
      "agent",
      "task-2",
      startB,
    );

    const currentNow = repo.getNeighbors(alpha.id, 1, undefined, 3_500);
    expect(currentNow).toHaveLength(1);
    expect(currentNow[0]?.edge.id).toBe(newEdge.id);

    const historicalSubgraph = repo.getSubgraph([alpha.id, beta.id], 1_500);
    expect(historicalSubgraph.edges).toHaveLength(1);
    expect(historicalSubgraph.edges[0]?.id).toBe(oldEdge.id);

    const allEdges = repo.getEdgesBetween(alpha.id, beta.id);
    expect(allEdges).toHaveLength(2);
    expect(allEdges.map((edge) => edge.id)).toEqual(expect.arrayContaining([oldEdge.id, newEdge.id]));
  });

  it("rejects overlapping intervals for the same directed relation", () => {
    const repo = createRepository();
    const workspaceId = "ws-overlap";
    const entityType = repo.getOrCreateEntityType(workspaceId, "project");
    const alpha = repo.createEntity(workspaceId, entityType.id, "Alpha");
    const beta = repo.createEntity(workspaceId, entityType.id, "Beta");

    repo.createEdge(workspaceId, alpha.id, beta.id, "depends_on", undefined, 1, "agent", "task-1", 1_000, 2_000);

    expect(() =>
      repo.createEdge(
        workspaceId,
        alpha.id,
        beta.id,
        "depends_on",
        undefined,
        1,
        "agent",
        "task-2",
        1_500,
        2_500,
      ),
    ).toThrow(/overlaps existing relation interval/i);
  });

  it("rejects invalidation timestamps that do not close the interval", () => {
    const repo = createRepository();
    const workspaceId = "ws-invalid-close";
    const entityType = repo.getOrCreateEntityType(workspaceId, "project");
    const alpha = repo.createEntity(workspaceId, entityType.id, "Alpha");
    const beta = repo.createEntity(workspaceId, entityType.id, "Beta");

    const edge = repo.createEdge(workspaceId, alpha.id, beta.id, "depends_on", undefined, 1, "agent", "task-1", 2_000);

    expect(() => repo.invalidateEdge(edge.id, 2_000)).toThrow(/valid_to must be greater than the edge valid_from/i);
  });
});
