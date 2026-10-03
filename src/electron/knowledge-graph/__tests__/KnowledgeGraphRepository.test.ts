import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";
import { KG_MAX_NEIGHBOR_RESULTS, KnowledgeGraphStore } from "../knowledge-graph-sql";

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

function createRepository(): KnowledgeGraphStore {
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

    CREATE TABLE kg_observations (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      source_task_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX idx_kg_edges_current_unique
      ON kg_edges(workspace_id, source_entity_id, target_entity_id, edge_type)
      WHERE valid_to IS NULL;
  `);
  return new KnowledgeGraphStore(db);
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

describeWithNativeDb("KnowledgeGraphStore temporal edges", () => {
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
    repo.invalidateEdge(workspaceId, oldEdge.id, endA);

    const currentAt1500 = repo.getNeighbors(workspaceId, alpha.id, 1, undefined, 1_500);
    expect(currentAt1500).toHaveLength(1);
    expect(currentAt1500[0]?.edge.id).toBe(oldEdge.id);

    const noneAt2500 = repo.getNeighbors(workspaceId, alpha.id, 1, undefined, 2_500);
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

    const currentNow = repo.getNeighbors(workspaceId, alpha.id, 1, undefined, 3_500);
    expect(currentNow).toHaveLength(1);
    expect(currentNow[0]?.edge.id).toBe(newEdge.id);

    const historicalSubgraph = repo.getSubgraph(workspaceId, [alpha.id, beta.id], 1_500);
    expect(historicalSubgraph.edges).toHaveLength(1);
    expect(historicalSubgraph.edges[0]?.id).toBe(oldEdge.id);

    const allEdges = repo.getEdgesBetween(workspaceId, alpha.id, beta.id);
    expect(allEdges).toHaveLength(2);
    expect(allEdges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining([oldEdge.id, newEdge.id]),
    );
  });

  it("rejects overlapping intervals for the same directed relation", () => {
    const repo = createRepository();
    const workspaceId = "ws-overlap";
    const entityType = repo.getOrCreateEntityType(workspaceId, "project");
    const alpha = repo.createEntity(workspaceId, entityType.id, "Alpha");
    const beta = repo.createEntity(workspaceId, entityType.id, "Beta");

    repo.createEdge(
      workspaceId,
      alpha.id,
      beta.id,
      "depends_on",
      undefined,
      1,
      "agent",
      "task-1",
      1_000,
      2_000,
    );

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

    const edge = repo.createEdge(
      workspaceId,
      alpha.id,
      beta.id,
      "depends_on",
      undefined,
      1,
      "agent",
      "task-1",
      2_000,
    );

    expect(() => repo.invalidateEdge(workspaceId, edge.id, 2_000)).toThrow(
      /valid_to must be greater than the edge valid_from/i,
    );
  });
});

describeWithNativeDb("KnowledgeGraphStore workspace scoping (SEC-9)", () => {
  function seed(repo: KnowledgeGraphStore) {
    const typeA = repo.getOrCreateEntityType("ws-a", "project");
    const typeB = repo.getOrCreateEntityType("ws-b", "project");
    const a1 = repo.createEntity("ws-a", typeA.id, "A1");
    const a2 = repo.createEntity("ws-a", typeA.id, "A2");
    const b1 = repo.createEntity("ws-b", typeB.id, "B1");
    const b2 = repo.createEntity("ws-b", typeB.id, "B2");
    const edgeB = repo.createEdge("ws-b", b1.id, b2.id, "depends_on");
    repo.addObservation(b1.id, "secret note");
    return { a1, a2, b1, b2, edgeB };
  }

  it("treats ids from another workspace as not found for reads and writes", () => {
    const repo = createRepository();
    const { b1, b2, edgeB } = seed(repo);

    expect(repo.getEntity("ws-a", b1.id)).toBeUndefined();
    expect(repo.getEntity("ws-b", b1.id)?.name).toBe("B1");
    expect(repo.updateEntity("ws-a", b1.id, { description: "pwned" })).toBeUndefined();
    expect(repo.getEntity("ws-b", b1.id)?.description).toBeUndefined();
    expect(repo.deleteEntity("ws-a", b1.id)).toBe(false);
    expect(repo.getEntity("ws-b", b1.id)).toBeDefined();
    expect(repo.getEdge("ws-a", edgeB.id)).toBeUndefined();
    expect(repo.invalidateEdge("ws-a", edgeB.id, Date.now() + 1_000)).toBeUndefined();
    expect(repo.deleteEdge("ws-a", edgeB.id)).toBe(false);
    expect(repo.getEdge("ws-b", edgeB.id)?.validTo).toBeUndefined();
    expect(repo.getEdgesBetween("ws-a", b1.id, b2.id)).toEqual([]);
    expect(repo.getObservations("ws-a", b1.id)).toEqual([]);
    expect(repo.getObservations("ws-b", b1.id)).toHaveLength(1);
    expect(() =>
      repo.addObservationChecked("ws-a", { entityId: b1.id, content: "x" }, "agent"),
    ).toThrow(/Entity not found/);
    expect(repo.getNeighbors("ws-a", b1.id)).toEqual([]);
    expect(repo.getSubgraph("ws-a", [b1.id, b2.id])).toEqual({ entities: [], edges: [] });
  });

  it("refuses to create an edge to an entity in another workspace", () => {
    const repo = createRepository();
    const { a1, b1 } = seed(repo);
    expect(() =>
      repo.createEdgeChecked(
        "ws-a",
        { sourceEntityId: a1.id, targetEntityId: b1.id, edgeType: "related_to" },
        "agent",
        undefined,
        Date.now(),
      ),
    ).toThrow(/Target entity not found/);
    expect(() =>
      repo.createEdgeChecked(
        "ws-a",
        { sourceEntityId: b1.id, targetEntityId: a1.id, edgeType: "related_to" },
        "agent",
        undefined,
        Date.now(),
      ),
    ).toThrow(/Source entity not found/);
  });

  it("does not traverse into another workspace and caps neighbor results", () => {
    const repo = createRepository();
    const { a1, b1 } = seed(repo);
    // A legacy cross-workspace edge row (created before the check) is not followed.
    repo.createEdge("ws-a", a1.id, b1.id, "related_to");
    expect(repo.getNeighbors("ws-a", a1.id).map((n) => n.entity.id)).not.toContain(b1.id);

    const type = repo.getOrCreateEntityType("ws-a", "file");
    for (let i = 0; i < KG_MAX_NEIGHBOR_RESULTS + 20; i++) {
      const leaf = repo.createEntity("ws-a", type.id, `leaf-${i}`);
      repo.createEdge("ws-a", a1.id, leaf.id, "contains");
    }
    expect(repo.getNeighbors("ws-a", a1.id, 3)).toHaveLength(KG_MAX_NEIGHBOR_RESULTS);
  });
});

describeWithNativeDb("KnowledgeGraphStore search", () => {
  it("finds entities through their observations, ranked by term coverage", () => {
    const repo = createRepository();
    const workspaceId = "ws-search";
    const person = repo.getOrCreateEntityType(workspaceId, "person");
    const juergen = repo.createEntity(workspaceId, person.id, "Jürgen Weiß", "Backend lead");
    const mira = repo.createEntity(workspaceId, person.id, "Mira", "Designer");
    repo.addObservation(juergen.id, "Owns the payments service since March.");
    repo.addObservation(mira.id, "Reviews the service landing page.");
    const foreign = repo.createEntity(
      "ws-other",
      repo.getOrCreateEntityType("ws-other", "person").id,
      "Other",
    );
    repo.addObservation(foreign.id, "Owns the payments service elsewhere.");

    const results = repo.searchEntities(workspaceId, "who owns the payments service");
    expect(results.map((result) => result.entity.name)).toEqual(["Jürgen Weiß", "Mira"]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 1);
    // Stopwords alone ("who", "the") do not match every observation.
    expect(repo.searchEntities(workspaceId, "who the")).toEqual([]);
  });
});
