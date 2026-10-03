import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  AddObservationInput,
  CreateEdgeInput,
  CreateEntityInput,
  KGEntityType,
  KGEntity,
  KGEdge,
  KGObservation,
  KGSearchResult,
  KGNeighborResult,
  KGSubgraph,
  KGStats,
} from "../../shared/knowledge-graph-types";
import {
  buildFtsMatchQuery,
  extractFtsTerms,
  isFtsStopword,
  LIKE_ESCAPE_CLAUSE,
  likeContainsPattern,
  termCoverage,
} from "../database/fts-query";

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

function buildValidityFilter(
  asOf: number | undefined,
  columnPrefix = "",
): { clause: string; params: Any[] } {
  if (!Number.isFinite(asOf)) {
    return { clause: "", params: [] };
  }
  const prefix = columnPrefix ? `${columnPrefix}.` : "";
  return {
    clause: ` AND (${prefix}valid_from IS NULL OR ${prefix}valid_from <= ?) AND (${prefix}valid_to IS NULL OR ${prefix}valid_to > ?)`,
    params: [asOf, asOf],
  };
}

/**
 * Result caps for graph reads (SEC-9). Every by-id operation is also scoped to the
 * caller's workspace, so an id from another workspace behaves as "not found".
 */
export const KG_MAX_NEIGHBOR_DEPTH = 3;
export const KG_MAX_NEIGHBOR_RESULTS = 200;
export const KG_MAX_EDGES_PER_LEVEL = 1000;
export const KG_MAX_EDGE_TYPE_FILTERS = 20;
export const KG_MAX_SUBGRAPH_ENTITIES = 100;
export const KG_MAX_SUBGRAPH_EDGES = 1000;
export const KG_MAX_OBSERVATIONS = 100;

function intervalStart(edge: Pick<KGEdge, "createdAt" | "validFrom">): number {
  return Number.isFinite(edge.validFrom) ? (edge.validFrom as number) : edge.createdAt;
}

function intervalEnd(edge: Pick<KGEdge, "validTo">): number | null {
  return Number.isFinite(edge.validTo) ? (edge.validTo as number) : null;
}

function intervalsOverlap(
  left: Pick<KGEdge, "createdAt" | "validFrom" | "validTo">,
  right: Pick<KGEdge, "createdAt" | "validFrom" | "validTo">,
): boolean {
  const leftStart = intervalStart(left);
  const leftEnd = intervalEnd(left) ?? Number.POSITIVE_INFINITY;
  const rightStart = intervalStart(right);
  const rightEnd = intervalEnd(right) ?? Number.POSITIVE_INFINITY;
  return leftStart < rightEnd && rightStart < leftEnd;
}

/**
 * The knowledge graph's SQL (async SQLite migration plan, DB6): the synchronous store the
 * memory domain's transaction units run, on the host connection or in the database
 * worker. Each unit calls one method, so a method's reads and writes share one
 * transaction. That includes the multi-step writes, such as upserting an entity or
 * creating a deduplicated edge, which callers used to run as separate calls.
 * `KnowledgeGraphRepository` is the async facade over these units.
 */
export class KnowledgeGraphStore {
  constructor(private db: Database.Database) {}

  // ─── Entity Type CRUD ─────────────────────────────────────────────

  getEntityTypes(workspaceId: string): KGEntityType[] {
    const stmt = this.db.prepare(
      "SELECT * FROM kg_entity_types WHERE workspace_id = ? ORDER BY is_builtin DESC, name ASC",
    );
    const rows = stmt.all(workspaceId) as Any[];
    return rows.map((r) => this.mapEntityType(r));
  }

  getEntityTypeByName(workspaceId: string, name: string): KGEntityType | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM kg_entity_types WHERE workspace_id = ? AND name = ?",
    );
    const row = stmt.get(workspaceId, name.toLowerCase().trim()) as Any;
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

  getEntity(workspaceId: string, entityId: string): KGEntity | undefined {
    const stmt = this.db.prepare(`
      SELECT e.*, t.name as entity_type_name
      FROM kg_entities e
      LEFT JOIN kg_entity_types t ON e.entity_type_id = t.id
      WHERE e.id = ? AND e.workspace_id = ?
    `);
    const row = stmt.get(entityId, workspaceId) as Any;
    return row ? this.mapEntity(row) : undefined;
  }

  getEntityByName(workspaceId: string, entityTypeId: string, name: string): KGEntity | undefined {
    const stmt = this.db.prepare(`
      SELECT e.*, t.name as entity_type_name
      FROM kg_entities e
      LEFT JOIN kg_entity_types t ON e.entity_type_id = t.id
      WHERE e.workspace_id = ? AND e.entity_type_id = ? AND e.name = ?
    `);
    const row = stmt.get(workspaceId, entityTypeId, name.trim()) as Any;
    return row ? this.mapEntity(row) : undefined;
  }

  updateEntity(
    workspaceId: string,
    entityId: string,
    patch: {
      description?: string;
      properties?: Record<string, unknown>;
      confidence?: number;
    },
  ): KGEntity | undefined {
    const entity = this.getEntity(workspaceId, entityId);
    if (!entity) return undefined;

    const now = Date.now();
    const updates: string[] = ["updated_at = ?"];
    const params: Any[] = [now];

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

    params.push(entityId, workspaceId);
    this.db
      .prepare(`UPDATE kg_entities SET ${updates.join(", ")} WHERE id = ? AND workspace_id = ?`)
      .run(...params);

    return this.getEntity(workspaceId, entityId);
  }

  deleteEntity(workspaceId: string, entityId: string): boolean {
    if (!this.getEntity(workspaceId, entityId)) return false;
    // Cascade delete is handled by FK constraints, but we also do explicit cleanup
    // in case FK enforcement is off
    const deleteEdges = this.db.prepare(
      "DELETE FROM kg_edges WHERE source_entity_id = ? OR target_entity_id = ?",
    );
    const deleteObs = this.db.prepare("DELETE FROM kg_observations WHERE entity_id = ?");
    const deleteEntity = this.db.prepare(
      "DELETE FROM kg_entities WHERE id = ? AND workspace_id = ?",
    );

    const transaction = this.db.transaction(() => {
      deleteEdges.run(entityId, entityId);
      deleteObs.run(entityId);
      const result = deleteEntity.run(entityId, workspaceId);
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
    validFrom?: number,
    validTo?: number,
  ): KGEdge {
    const id = uuidv4();
    const now = Date.now();
    const propsJson = JSON.stringify(properties || {});
    const normalizedValidFrom = Number.isFinite(validFrom) ? (validFrom as number) : now;
    const normalizedValidTo = Number.isFinite(validTo) ? (validTo as number) : undefined;
    const normalizedEdgeType = edgeType.toLowerCase().trim();
    if (normalizedValidTo !== undefined && normalizedValidFrom >= normalizedValidTo) {
      throw new Error("valid_to must be greater than valid_from");
    }

    const overlappingEdge = this.getRelationEdges(
      workspaceId,
      sourceEntityId,
      targetEntityId,
      normalizedEdgeType,
    ).find((edge) =>
      intervalsOverlap(
        {
          createdAt: now,
          validFrom: normalizedValidFrom,
          validTo: normalizedValidTo,
        },
        edge,
      ),
    );
    if (overlappingEdge) {
      throw new Error(
        `Temporal edge overlaps existing relation interval (${overlappingEdge.id}) for ${normalizedEdgeType}`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO kg_edges (id, workspace_id, source_entity_id, target_entity_id, edge_type, properties, confidence, source, source_task_id, created_at, valid_from, valid_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        sourceEntityId,
        targetEntityId,
        normalizedEdgeType,
        propsJson,
        clamp(confidence, 0, 1),
        source,
        sourceTaskId || null,
        now,
        normalizedValidFrom,
        normalizedValidTo || null,
      );

    return {
      id,
      workspaceId,
      sourceEntityId,
      targetEntityId,
      edgeType: normalizedEdgeType,
      properties: properties || {},
      confidence: clamp(confidence, 0, 1),
      source,
      sourceTaskId,
      createdAt: now,
      validFrom: normalizedValidFrom,
      validTo: normalizedValidTo,
    };
  }

  getEdge(workspaceId: string, edgeId: string): KGEdge | undefined {
    const stmt = this.db.prepare("SELECT * FROM kg_edges WHERE id = ? AND workspace_id = ?");
    const row = stmt.get(edgeId, workspaceId) as Any;
    return row ? this.mapEdge(row) : undefined;
  }

  deleteEdge(workspaceId: string, edgeId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM kg_edges WHERE id = ? AND workspace_id = ?")
      .run(edgeId, workspaceId);
    return result.changes > 0;
  }

  invalidateEdge(workspaceId: string, edgeId: string, validTo = Date.now()): KGEdge | undefined {
    const edge = this.getEdge(workspaceId, edgeId);
    if (!edge) return undefined;
    const effectiveValidFrom = intervalStart(edge);
    if (Number.isFinite(edge.validTo)) {
      if (edge.validTo === validTo) {
        return edge;
      }
      throw new Error(`Edge already invalidated at ${edge.validTo}`);
    }
    if (!Number.isFinite(validTo) || validTo <= effectiveValidFrom) {
      throw new Error("valid_to must be greater than the edge valid_from");
    }
    this.db
      .prepare("UPDATE kg_edges SET valid_to = ? WHERE id = ? AND workspace_id = ?")
      .run(validTo, edgeId, workspaceId);
    return this.getEdge(workspaceId, edgeId);
  }

  getRelationEdges(
    workspaceId: string,
    sourceEntityId: string,
    targetEntityId: string,
    edgeType: string,
  ): KGEdge[] {
    const normalizedType = edgeType.toLowerCase().trim();
    const rows = this.db
      .prepare(
        `SELECT * FROM kg_edges
         WHERE workspace_id = ?
           AND source_entity_id = ?
           AND target_entity_id = ?
           AND edge_type = ?
         ORDER BY COALESCE(valid_from, created_at) ASC, created_at ASC`,
      )
      .all(workspaceId, sourceEntityId, targetEntityId, normalizedType) as Any[];
    return rows.map((row) => this.mapEdge(row));
  }

  getEdgesBetween(
    workspaceId: string,
    entityId1: string,
    entityId2: string,
    asOf?: number,
  ): KGEdge[] {
    const validity = buildValidityFilter(asOf);
    const stmt = this.db.prepare(`
      SELECT * FROM kg_edges
      WHERE workspace_id = ?
        AND ((source_entity_id = ? AND target_entity_id = ?)
         OR (source_entity_id = ? AND target_entity_id = ?))
      ${validity.clause}
      LIMIT ${KG_MAX_SUBGRAPH_EDGES}
    `);
    const rows = stmt.all(
      workspaceId,
      entityId1,
      entityId2,
      entityId2,
      entityId1,
      ...validity.params,
    ) as Any[];
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

  getObservations(workspaceId: string, entityId: string, limit = 20): KGObservation[] {
    const boundedLimit = clamp(Math.floor(limit) || 0, 1, KG_MAX_OBSERVATIONS);
    const stmt = this.db.prepare(
      `SELECT o.* FROM kg_observations o
       JOIN kg_entities e ON o.entity_id = e.id
       WHERE o.entity_id = ? AND e.workspace_id = ?
       ORDER BY o.created_at DESC LIMIT ?`,
    );
    const rows = stmt.all(entityId, workspaceId, boundedLimit) as Any[];
    return rows.map((r) => this.mapObservation(r));
  }

  // ─── Search ───────────────────────────────────────────────────────

  searchEntities(workspaceId: string, query: string, limit = 10): KGSearchResult[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const results: KGSearchResult[] = [];

    // Try FTS5 first (entity name and description).
    try {
      // Shared Unicode builder: accented and non-Latin names and file names are kept
      // (the old ASCII-only filter dropped them), and terms match as prefixes.
      const ftsQuery = buildFtsMatchQuery(trimmed, { mode: "any", prefix: true });

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
        const rows = stmt.all(ftsQuery, workspaceId, limit) as Any[];
        for (const r of rows) {
          results.push({ entity: this.mapEntity(r), score: Math.abs(r.rank || 0) });
        }
      }
    } catch {
      // FTS5 not available or query error, fall through to LIKE
    }

    // Observations are not in the FTS index: entities whose observations mention the
    // query's terms fill the remaining slots ("who owns X" when only an observation says so).
    if (results.length < limit) {
      const seen = new Set(results.map((result) => result.entity.id));
      for (const result of this.searchEntitiesByObservation(workspaceId, trimmed, limit)) {
        if (results.length >= limit) break;
        if (seen.has(result.entity.id)) continue;
        seen.add(result.entity.id);
        results.push(result);
      }
    }
    if (results.length > 0) return results;

    // Fallback: LIKE search, with `%` and `_` in the query matched literally.
    const likePattern = likeContainsPattern(trimmed);
    const stmt = this.db.prepare(`
      SELECT e.*, t.name as entity_type_name
      FROM kg_entities e
      LEFT JOIN kg_entity_types t ON e.entity_type_id = t.id
      WHERE e.workspace_id = ?
        AND (e.name LIKE ? ${LIKE_ESCAPE_CLAUSE} OR e.description LIKE ? ${LIKE_ESCAPE_CLAUSE})
      ORDER BY e.confidence DESC, e.updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, likePattern, likePattern, limit) as Any[];
    return rows.map((r, i) => ({
      entity: this.mapEntity(r),
      score: 1.0 / (i + 1), // simple rank-based score
    }));
  }

  /**
   * Entities of the workspace with an observation containing any of the query's distinctive
   * terms (stopwords dropped), best term coverage first. Score is the coverage in [0, 1];
   * the matching observations (newest first, at most three) come with each result.
   */
  private searchEntitiesByObservation(
    workspaceId: string,
    query: string,
    limit: number,
  ): KGSearchResult[] {
    // Only distinctive terms: a stopword-only query would match nearly every observation.
    const terms = extractFtsTerms(query, {
      maxTerms: 6,
      minTermLength: 2,
      dropStopwords: true,
    }).filter((term) => !isFtsStopword(term));
    if (terms.length === 0) return [];
    const termClause = terms.map(() => `o.content LIKE ? ${LIKE_ESCAPE_CLAUSE}`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT e.*, t.name AS entity_type_name,
                o.id AS obs_id, o.content AS obs_content, o.source AS obs_source,
                o.source_task_id AS obs_source_task_id, o.created_at AS obs_created_at
         FROM kg_observations o
         JOIN kg_entities e ON o.entity_id = e.id
         LEFT JOIN kg_entity_types t ON e.entity_type_id = t.id
         WHERE e.workspace_id = ? AND (${termClause})
         ORDER BY o.created_at DESC
         LIMIT ?`,
      )
      .all(
        workspaceId,
        ...terms.map((term) => likeContainsPattern(term)),
        Math.max(limit, 1) * 10,
      ) as Any[];
    const byEntity = new Map<string, { row: Any; observations: KGObservation[] }>();
    for (const row of rows) {
      const entry = byEntity.get(row.id) ?? { row, observations: [] };
      byEntity.set(row.id, entry);
      if (entry.observations.length < 3) {
        entry.observations.push(
          this.mapObservation({
            id: row.obs_id,
            entity_id: row.id,
            content: row.obs_content,
            source: row.obs_source,
            source_task_id: row.obs_source_task_id,
            created_at: row.obs_created_at,
          }),
        );
      }
    }
    return [...byEntity.values()]
      .map(({ row, observations }) => ({
        entity: this.mapEntity(row),
        observations,
        score: termCoverage(
          [row.name, row.description, ...observations.map((o) => o.content)]
            .filter(Boolean)
            .join(" "),
          terms,
        ),
      }))
      .sort((a, b) => b.score - a.score || (b.entity.confidence ?? 0) - (a.entity.confidence ?? 0))
      .slice(0, limit);
  }

  // ─── Graph Traversal ──────────────────────────────────────────────

  getNeighbors(
    workspaceId: string,
    entityId: string,
    depth = 1,
    edgeTypes?: string[],
    asOf?: number,
  ): KGNeighborResult[] {
    // The root must belong to the caller's workspace; traversal never leaves it.
    if (!this.getEntity(workspaceId, entityId)) return [];
    const maxDepth = Math.min(Math.max(1, depth), KG_MAX_NEIGHBOR_DEPTH);
    const boundedEdgeTypes = edgeTypes?.slice(0, KG_MAX_EDGE_TYPE_FILTERS);
    const results: KGNeighborResult[] = [];
    const visited = new Set<string>([entityId]);

    // Iterative BFS traversal (SQLite recursive CTEs get complex with edge filtering)
    let currentLevel = [entityId];

    for (let d = 1; d <= maxDepth; d++) {
      if (currentLevel.length === 0) break;

      const placeholders = currentLevel.map(() => "?").join(",");

      let edgeFilter = "";
      const params: Any[] = [workspaceId, ...currentLevel, ...currentLevel];
      const validity = buildValidityFilter(asOf);

      if (boundedEdgeTypes && boundedEdgeTypes.length > 0) {
        const edgePlaceholders = boundedEdgeTypes.map(() => "?").join(",");
        edgeFilter = `AND edge_type IN (${edgePlaceholders})`;
        params.push(...boundedEdgeTypes);
      }

      const stmt = this.db.prepare(`
        SELECT * FROM kg_edges
        WHERE workspace_id = ?
          AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))
        ${edgeFilter}
        ${validity.clause}
        LIMIT ${KG_MAX_EDGES_PER_LEVEL}
      `);
      const edges = stmt.all(...params, ...validity.params) as Any[];

      const nextLevel: string[] = [];

      for (const edgeRow of edges) {
        if (results.length >= KG_MAX_NEIGHBOR_RESULTS) break;
        const edge = this.mapEdge(edgeRow);
        const isOutgoing = currentLevel.includes(edge.sourceEntityId);
        const neighborId = isOutgoing ? edge.targetEntityId : edge.sourceEntityId;

        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = this.getEntity(workspaceId, neighborId);
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
      if (results.length >= KG_MAX_NEIGHBOR_RESULTS) break;
    }

    return results;
  }

  // ─── Subgraph ─────────────────────────────────────────────────────

  getSubgraph(workspaceId: string, entityIds: string[], asOf?: number): KGSubgraph {
    if (entityIds.length === 0) return { entities: [], edges: [] };

    const uniqueIds = [...new Set(entityIds)].slice(0, KG_MAX_SUBGRAPH_ENTITIES);
    const entities: KGEntity[] = [];

    for (const id of uniqueIds) {
      const entity = this.getEntity(workspaceId, id);
      if (entity) entities.push(entity);
    }

    if (entities.length === 0) return { entities: [], edges: [] };

    // Get all edges between the entities
    const idSet = new Set(entities.map((e) => e.id));
    const placeholders = entities.map(() => "?").join(",");

    const validity = buildValidityFilter(asOf);
    const stmt = this.db.prepare(`
      SELECT * FROM kg_edges
      WHERE workspace_id = ?
        AND source_entity_id IN (${placeholders})
        AND target_entity_id IN (${placeholders})
      ${validity.clause}
      LIMIT ${KG_MAX_SUBGRAPH_EDGES}
    `);
    const edgeRows = stmt.all(
      workspaceId,
      ...entities.map((e) => e.id),
      ...entities.map((e) => e.id),
      ...validity.params,
    ) as Any[];

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
          .get(workspaceId) as Any
      )?.count || 0;

    const edgeCount =
      (
        this.db
          .prepare("SELECT COUNT(*) as count FROM kg_edges WHERE workspace_id = ?")
          .get(workspaceId) as Any
      )?.count || 0;

    const observationCount =
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM kg_observations o
           JOIN kg_entities e ON o.entity_id = e.id
           WHERE e.workspace_id = ?`,
          )
          .get(workspaceId) as Any
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
      .all(workspaceId) as Any[];

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

  // ─── Composite operations (one transaction each) ─────────────────

  /** Create an entity, or merge into the one with the same type and name. */
  upsertEntity(
    workspaceId: string,
    input: CreateEntityInput,
    source: "manual" | "auto" | "agent",
    sourceTaskId?: string,
  ): KGEntity {
    const entityType = this.getOrCreateEntityType(workspaceId, input.entityType);
    const existing = this.getEntityByName(workspaceId, entityType.id, input.name.trim());
    if (existing) {
      // Merge: update description if provided, boost confidence
      const patch: {
        description?: string;
        properties?: Record<string, unknown>;
        confidence?: number;
      } = {};
      if (input.description && input.description !== existing.description) {
        patch.description = input.description;
      }
      if (input.properties && Object.keys(input.properties).length > 0) {
        patch.properties = { ...existing.properties, ...input.properties };
      }
      // Boost confidence on repeated creation (max 1.0)
      patch.confidence = Math.min(1.0, (existing.confidence || 0.5) + 0.1);
      return this.updateEntity(workspaceId, existing.id, patch) || existing;
    }
    return this.createEntity(
      workspaceId,
      entityType.id,
      input.name,
      input.description,
      input.properties,
      input.confidence ?? (source === "auto" ? 0.85 : 1.0),
      source,
      sourceTaskId,
    );
  }

  /** Create an edge between existing entities, or return the matching current one. */
  createEdgeChecked(
    workspaceId: string,
    input: CreateEdgeInput,
    source: "manual" | "auto" | "agent",
    sourceTaskId: string | undefined,
    now: number,
  ): KGEdge {
    // Both endpoints must belong to this workspace (SEC-9): an id from another
    // workspace is reported as not found rather than linked across the boundary.
    if (!this.getEntity(workspaceId, input.sourceEntityId)) {
      throw new Error(`Source entity not found: ${input.sourceEntityId}`);
    }
    if (!this.getEntity(workspaceId, input.targetEntityId)) {
      throw new Error(`Target entity not found: ${input.targetEntityId}`);
    }
    // Prevent self-loops
    if (input.sourceEntityId === input.targetEntityId) {
      throw new Error("Cannot create an edge from an entity to itself");
    }
    const normalizedValidFrom = Number.isFinite(input.validFrom)
      ? (input.validFrom as number)
      : now;
    const normalizedValidTo = Number.isFinite(input.validTo)
      ? (input.validTo as number)
      : undefined;
    if (normalizedValidTo !== undefined && normalizedValidFrom >= normalizedValidTo) {
      throw new Error("valid_to must be greater than valid_from");
    }
    // Check for duplicate edge
    const existingEdges = this.getRelationEdges(
      workspaceId,
      input.sourceEntityId,
      input.targetEntityId,
      input.edgeType,
    );
    const duplicateCurrent = existingEdges.find(
      (edge) =>
        edge.validTo === undefined &&
        normalizedValidTo === undefined &&
        input.validFrom === undefined &&
        (edge.validFrom ?? edge.createdAt) <= now,
    );
    if (duplicateCurrent) return duplicateCurrent;
    const duplicateInterval = existingEdges.find(
      (edge) =>
        (edge.validFrom ?? edge.createdAt) === normalizedValidFrom &&
        (edge.validTo ?? undefined) === normalizedValidTo,
    );
    if (duplicateInterval) return duplicateInterval;
    return this.createEdge(
      workspaceId,
      input.sourceEntityId,
      input.targetEntityId,
      input.edgeType,
      input.properties,
      input.confidence ?? 1.0,
      source,
      sourceTaskId,
      normalizedValidFrom,
      normalizedValidTo,
    );
  }

  /** Add an observation to an existing entity. */
  addObservationChecked(
    workspaceId: string,
    input: AddObservationInput,
    source: "manual" | "auto" | "agent",
    sourceTaskId?: string,
  ): KGObservation {
    if (!this.getEntity(workspaceId, input.entityId)) {
      throw new Error(`Entity not found: ${input.entityId}`);
    }
    return this.addObservation(input.entityId, input.content, source, sourceTaskId);
  }

  /** Entities matching a task prompt, each with up to three immediate relationships. */
  contextEntities(
    workspaceId: string,
    query: string,
    limit: number,
    asOf?: number,
  ): Array<{ result: KGSearchResult; neighbors: KGNeighborResult[] }> {
    return this.searchEntities(workspaceId, query, limit).map((result) => ({
      result,
      neighbors: this.getNeighbors(workspaceId, result.entity.id, 1, undefined, asOf).slice(0, 3),
    }));
  }

  // ─── Row Mappers ──────────────────────────────────────────────────

  private mapEntityType(row: Any): KGEntityType {
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

  private mapEntity(row: Any): KGEntity {
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

  private mapEdge(row: Any): KGEdge {
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
      validFrom:
        typeof row.valid_from === "number" && Number.isFinite(row.valid_from)
          ? row.valid_from
          : undefined,
      validTo:
        typeof row.valid_to === "number" && Number.isFinite(row.valid_to)
          ? row.valid_to
          : undefined,
    };
  }

  private mapObservation(row: Any): KGObservation {
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
