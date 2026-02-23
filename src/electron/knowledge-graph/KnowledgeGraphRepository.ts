import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  KGEntityType,
  KGEntity,
  KGEdge,
  KGObservation,
  KGSearchResult,
  KGNeighborResult,
  KGSubgraph,
  KGStats,
} from "../../shared/knowledge-graph-types";

function safeJsonParse<T>(jsonString: string | null | undefined, defaultValue: T): T {
  if (!jsonString) return defaultValue;
  try {
    return JSON.parse(jsonString);
  } catch {
    return defaultValue;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class KnowledgeGraphRepository {
  constructor(private db: Database.Database) {}

  // ─── Entity Type CRUD ─────────────────────────────────────────────

  getEntityTypes(workspaceId: string): KGEntityType[] {
    const stmt = this.db.prepare(
      "SELECT * FROM kg_entity_types WHERE workspace_id = ? ORDER BY is_builtin DESC, name ASC",
    );
    const rows = stmt.all(workspaceId) as any[];
    return rows.map((r) => this.mapEntityType(r));
  }

  getEntityTypeByName(workspaceId: string, name: string): KGEntityType | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM kg_entity_types WHERE workspace_id = ? AND name = ?",
    );
    const row = stmt.get(workspaceId, name.toLowerCase().trim()) as any;
    return row ? this.mapEntityType(row) : undefined;
  }

  getOrCreateEntityType(workspaceId: string, name: string, description?: string): KGEntityType {
    const normalized = name.toLowerCase().trim().replace(/\s+/g, "_");
    const existing = this.getEntityTypeByName(workspaceId, normalized);
    if (existing) return existing;

    const id = uuidv4();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO kg_entity_types (id, workspace_id, name, description, is_builtin, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(id, workspaceId, normalized, description || null, now);

    return {
      id,
      workspaceId,
      name: normalized,
      description,
      isBuiltin: false,
      createdAt: now,
    };
  }

  // ─── Entity CRUD ──────────────────────────────────────────────────

  createEntity(
    workspaceId: string,
    entityTypeId: string,
    name: string,
    description?: string,
    properties?: Record<string, unknown>,
    confidence = 1.0,
    source: "manual" | "auto" | "agent" = "manual",
    sourceTaskId?: string,
  ): KGEntity {
    const id = uuidv4();
    const now = Date.now();
    const propsJson = JSON.stringify(properties || {});

    this.db
      .prepare(
        `INSERT INTO kg_entities (id, workspace_id, entity_type_id, name, description, properties, confidence, source, source_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        entityTypeId,
        name.trim(),
        description || null,
        propsJson,
        clamp(confidence, 0, 1),
        source,
        sourceTaskId || null,
        now,
        now,
      );

    return {
      id,
      workspaceId,
      entityTypeId,
      name: name.trim(),
      description,
      properties: properties || {},
      confidence: clamp(confidence, 0, 1),
      source,
      sourceTaskId,
      createdAt: now,
      updatedAt: now,
    };
  }

  getEntity(entityId: string): KGEntity | undefined {
    const stmt = this.db.prepare(`
      SELECT e.*, t.name as entity_type_name
      FROM kg_entities e
      LEFT JOIN kg_entity_types t ON e.entity_type_id = t.id
      WHERE e.id = ?
    `);
    const row = stmt.get(entityId) as any;
    return row ? this.mapEntity(row) : undefined;
  }

  getEntityByName(workspaceId: string, entityTypeId: string, name: string): KGEntity | undefined {
    const stmt = this.db.prepare(`
      SELECT e.*, t.name as entity_type_name
      FROM kg_entities e
      LEFT JOIN kg_entity_types t ON e.entity_type_id = t.id
      WHERE e.workspace_id = ? AND e.entity_type_id = ? AND e.name = ?
    `);
    const row = stmt.get(workspaceId, entityTypeId, name.trim()) as any;
    return row ? this.mapEntity(row) : undefined;
  }

  updateEntity(
    entityId: string,
    patch: {
      description?: string;
      properties?: Record<string, unknown>;
      confidence?: number;
    },
  ): KGEntity | undefined {
    const entity = this.getEntity(entityId);
    if (!entity) return undefined;

    const now = Date.now();
    const updates: string[] = ["updated_at = ?"];
    const params: any[] = [now];

    if (patch.description !== undefined) {
      updates.push("description = ?");
      params.push(patch.description);
    }
    if (patch.properties !== undefined) {
      updates.push("properties = ?");
      params.push(JSON.stringify(patch.properties));
    }
    if (patch.confidence !== undefined) {
      updates.push("confidence = ?");
      params.push(clamp(patch.confidence, 0, 1));
    }

    params.push(entityId);
    this.db.prepare(`UPDATE kg_entities SET ${updates.join(", ")} WHERE id = ?`).run(...params);

    return this.getEntity(entityId);
  }

  deleteEntity(entityId: string): boolean {
    // Cascade delete is handled by FK constraints, but we also do explicit cleanup
    // in case FK enforcement is off
    const deleteEdges = this.db.prepare(
      "DELETE FROM kg_edges WHERE source_entity_id = ? OR target_entity_id = ?",
    );
    const deleteObs = this.db.prepare("DELETE FROM kg_observations WHERE entity_id = ?");
    const deleteEntity = this.db.prepare("DELETE FROM kg_entities WHERE id = ?");

    const transaction = this.db.transaction(() => {
      deleteEdges.run(entityId, entityId);
      deleteObs.run(entityId);
      const result = deleteEntity.run(entityId);
      return result.changes > 0;
    });

    return transaction();
  }

  // ─── Edge CRUD ────────────────────────────────────────────────────

  createEdge(
    workspaceId: string,
    sourceEntityId: string,
    targetEntityId: string,
    edgeType: string,
    properties?: Record<string, unknown>,
    confidence = 1.0,
    source: "manual" | "auto" | "agent" = "manual",
    sourceTaskId?: string,
  ): KGEdge {
    const id = uuidv4();
    const now = Date.now();
    const propsJson = JSON.stringify(properties || {});

    this.db
      .prepare(
        `INSERT INTO kg_edges (id, workspace_id, source_entity_id, target_entity_id, edge_type, properties, confidence, source, source_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        sourceEntityId,
        targetEntityId,
        edgeType.toLowerCase().trim(),
        propsJson,
        clamp(confidence, 0, 1),
        source,
        sourceTaskId || null,
        now,
      );

    return {
      id,
      workspaceId,
      sourceEntityId,
      targetEntityId,
      edgeType: edgeType.toLowerCase().trim(),
      properties: properties || {},
      confidence: clamp(confidence, 0, 1),
      source,
      sourceTaskId,
      createdAt: now,
    };
  }

  getEdge(edgeId: string): KGEdge | undefined {
    const stmt = this.db.prepare("SELECT * FROM kg_edges WHERE id = ?");
    const row = stmt.get(edgeId) as any;
    return row ? this.mapEdge(row) : undefined;
  }

  deleteEdge(edgeId: string): boolean {
    const result = this.db.prepare("DELETE FROM kg_edges WHERE id = ?").run(edgeId);
    return result.changes > 0;
  }

  getEdgesBetween(entityId1: string, entityId2: string): KGEdge[] {
    const stmt = this.db.prepare(`
      SELECT * FROM kg_edges
      WHERE (source_entity_id = ? AND target_entity_id = ?)
         OR (source_entity_id = ? AND target_entity_id = ?)
    `);
    const rows = stmt.all(entityId1, entityId2, entityId2, entityId1) as any[];
    return rows.map((r) => this.mapEdge(r));
  }

  // ─── Observation CRUD ─────────────────────────────────────────────

  addObservation(
    entityId: string,
    content: string,
    source: "manual" | "auto" | "agent" = "manual",
    sourceTaskId?: string,
  ): KGObservation {
    const id = uuidv4();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO kg_observations (id, entity_id, content, source, source_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, entityId, content.trim(), source, sourceTaskId || null, now);

    return {
      id,
      entityId,
      content: content.trim(),
      source,
      sourceTaskId,
      createdAt: now,
    };
  }

  getObservations(entityId: string, limit = 20): KGObservation[] {
    const stmt = this.db.prepare(
      "SELECT * FROM kg_observations WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?",
    );
    const rows = stmt.all(entityId, limit) as any[];
    return rows.map((r) => this.mapObservation(r));
  }

  // ─── Search ───────────────────────────────────────────────────────

  searchEntities(workspaceId: string, query: string, limit = 10): KGSearchResult[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Try FTS5 first
    try {
      const ftsQuery = trimmed
        .replace(/[^a-zA-Z0-9\s]/g, " ")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .map((w) => `"${w}"`)
        .join(" OR ");

      if (ftsQuery) {
        const stmt = this.db.prepare(`
          SELECT e.*, t.name as entity_type_name, rank
          FROM kg_entities_fts fts
          JOIN kg_entities e ON e.rowid = fts.rowid
          LEFT JOIN kg_entity_types t ON e.entity_type_id = t.id
          WHERE kg_entities_fts MATCH ? AND e.workspace_id = ?
          ORDER BY rank
          LIMIT ?
        `);
        const rows = stmt.all(ftsQuery, workspaceId, limit) as any[];
        if (rows.length > 0) {
          return rows.map((r) => ({
            entity: this.mapEntity(r),
            score: Math.abs(r.rank || 0),
          }));
        }
      }
    } catch {
      // FTS5 not available or query error, fall through to LIKE
    }

    // Fallback: LIKE search
    const likePattern = `%${trimmed}%`;
    const stmt = this.db.prepare(`
      SELECT e.*, t.name as entity_type_name
      FROM kg_entities e
      LEFT JOIN kg_entity_types t ON e.entity_type_id = t.id
      WHERE e.workspace_id = ? AND (e.name LIKE ? OR e.description LIKE ?)
      ORDER BY e.confidence DESC, e.updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, likePattern, likePattern, limit) as any[];
    return rows.map((r, i) => ({
      entity: this.mapEntity(r),
      score: 1.0 / (i + 1), // simple rank-based score
    }));
  }

  // ─── Graph Traversal ──────────────────────────────────────────────

  getNeighbors(entityId: string, depth = 1, edgeTypes?: string[]): KGNeighborResult[] {
    const maxDepth = Math.min(Math.max(1, depth), 3);
    const results: KGNeighborResult[] = [];
    const visited = new Set<string>([entityId]);

    // Iterative BFS traversal (SQLite recursive CTEs get complex with edge filtering)
    let currentLevel = [entityId];

    for (let d = 1; d <= maxDepth; d++) {
      if (currentLevel.length === 0) break;

      const placeholders = currentLevel.map(() => "?").join(",");

      let edgeFilter = "";
      const params: any[] = [...currentLevel, ...currentLevel];

      if (edgeTypes && edgeTypes.length > 0) {
        const edgePlaceholders = edgeTypes.map(() => "?").join(",");
        edgeFilter = `AND edge_type IN (${edgePlaceholders})`;
        params.push(...edgeTypes);
      }

      const stmt = this.db.prepare(`
        SELECT * FROM kg_edges
        WHERE (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))
        ${edgeFilter}
      `);
      const edges = stmt.all(...params) as any[];

      const nextLevel: string[] = [];

      for (const edgeRow of edges) {
        const edge = this.mapEdge(edgeRow);
        const isOutgoing = currentLevel.includes(edge.sourceEntityId);
        const neighborId = isOutgoing ? edge.targetEntityId : edge.sourceEntityId;

        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = this.getEntity(neighborId);
        if (!neighbor) continue;

        results.push({
          entity: neighbor,
          edge,
          direction: isOutgoing ? "outgoing" : "incoming",
          depth: d,
        });

        nextLevel.push(neighborId);
      }

      currentLevel = nextLevel;
    }

    return results;
  }

  // ─── Subgraph ─────────────────────────────────────────────────────

  getSubgraph(entityIds: string[]): KGSubgraph {
    if (entityIds.length === 0) return { entities: [], edges: [] };

    const uniqueIds = [...new Set(entityIds)];
    const entities: KGEntity[] = [];

    for (const id of uniqueIds) {
      const entity = this.getEntity(id);
      if (entity) entities.push(entity);
    }

    if (entities.length === 0) return { entities: [], edges: [] };

    // Get all edges between the entities
    const idSet = new Set(entities.map((e) => e.id));
    const placeholders = entities.map(() => "?").join(",");

    const stmt = this.db.prepare(`
      SELECT * FROM kg_edges
      WHERE source_entity_id IN (${placeholders})
        AND target_entity_id IN (${placeholders})
    `);
    const edgeRows = stmt.all(...entities.map((e) => e.id), ...entities.map((e) => e.id)) as any[];

    const edges = edgeRows
      .map((r) => this.mapEdge(r))
      .filter((e) => idSet.has(e.sourceEntityId) && idSet.has(e.targetEntityId));

    return { entities, edges };
  }

  // ─── Confidence Decay ─────────────────────────────────────────────

  applyConfidenceDecay(workspaceId: string, decayRate = 0.95, floorConfidence = 0.3): number {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - thirtyDaysMs;

    const result = this.db
      .prepare(
        `UPDATE kg_entities
       SET confidence = MAX(?, confidence * ?),
           updated_at = ?
       WHERE workspace_id = ?
         AND source = 'auto'
         AND confidence > ?
         AND created_at < ?`,
      )
      .run(floorConfidence, decayRate, Date.now(), workspaceId, floorConfidence, cutoff);

    return result.changes;
  }

  // ─── Stats ────────────────────────────────────────────────────────

  getStats(workspaceId: string): KGStats {
    const entityCount =
      (
        this.db
          .prepare("SELECT COUNT(*) as count FROM kg_entities WHERE workspace_id = ?")
          .get(workspaceId) as any
      )?.count || 0;

    const edgeCount =
      (
        this.db
          .prepare("SELECT COUNT(*) as count FROM kg_edges WHERE workspace_id = ?")
          .get(workspaceId) as any
      )?.count || 0;

    const observationCount =
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM kg_observations o
           JOIN kg_entities e ON o.entity_id = e.id
           WHERE e.workspace_id = ?`,
          )
          .get(workspaceId) as any
      )?.count || 0;

    const typeDistRows = this.db
      .prepare(
        `SELECT t.name as type_name, COUNT(e.id) as count
       FROM kg_entity_types t
       LEFT JOIN kg_entities e ON t.id = e.entity_type_id
       WHERE t.workspace_id = ?
       GROUP BY t.id
       HAVING count > 0
       ORDER BY count DESC`,
      )
      .all(workspaceId) as any[];

    return {
      entityCount,
      edgeCount,
      observationCount,
      entityTypeDistribution: typeDistRows.map((r) => ({
        typeName: r.type_name,
        count: r.count,
      })),
    };
  }

  // ─── Row Mappers ──────────────────────────────────────────────────

  private mapEntityType(row: any): KGEntityType {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description || undefined,
      color: row.color || undefined,
      icon: row.icon || undefined,
      isBuiltin: row.is_builtin === 1,
      createdAt: row.created_at,
    };
  }

  private mapEntity(row: any): KGEntity {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      entityTypeId: row.entity_type_id,
      entityTypeName: row.entity_type_name || undefined,
      name: row.name,
      description: row.description || undefined,
      properties: safeJsonParse(row.properties, {}),
      confidence: typeof row.confidence === "number" ? row.confidence : 1.0,
      source: row.source === "auto" || row.source === "agent" ? row.source : "manual",
      sourceTaskId: row.source_task_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapEdge(row: any): KGEdge {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      edgeType: row.edge_type,
      properties: safeJsonParse(row.properties, {}),
      confidence: typeof row.confidence === "number" ? row.confidence : 1.0,
      source: row.source === "auto" || row.source === "agent" ? row.source : "manual",
      sourceTaskId: row.source_task_id || undefined,
      createdAt: row.created_at,
    };
  }

  private mapObservation(row: any): KGObservation {
    return {
      id: row.id,
      entityId: row.entity_id,
      content: row.content,
      source: row.source === "auto" || row.source === "agent" ? row.source : "manual",
      sourceTaskId: row.source_task_id || undefined,
      createdAt: row.created_at,
    };
  }
}
