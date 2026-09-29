import type {
  AddObservationInput,
  CreateEdgeInput,
  CreateEntityInput,
  KGEdge,
  KGEntity,
  KGEntityType,
  KGNeighborResult,
  KGObservation,
  KGSearchResult,
  KGStats,
  KGSubgraph,
} from "../../shared/knowledge-graph-types";
import type { MemoryStatementPort } from "../memory/memory-statement-port";

type Source = "manual" | "auto" | "agent";

/**
 * The knowledge graph's storage (async SQLite migration plan, DB6). Every operation is
 * one memory-domain transaction unit running a `KnowledgeGraphStore` method: in the
 * database worker when memory is routed there, in one host transaction otherwise.
 * Multi-step writes (upserting an entity, creating a deduplicated edge) are single
 * operations, so concurrent callers cannot interleave between their check and write.
 */
export class KnowledgeGraphRepository {
  constructor(private readonly sql: MemoryStatementPort) {}

  getEntityTypes(workspaceId: string): Promise<KGEntityType[]> {
    return this.sql.unit("kg_getEntityTypes", [workspaceId]);
  }

  getEntity(entityId: string): Promise<KGEntity | undefined> {
    return this.sql.unit("kg_getEntity", [entityId]);
  }

  upsertEntity(
    workspaceId: string,
    input: CreateEntityInput,
    source: Source,
    sourceTaskId?: string,
  ): Promise<KGEntity> {
    return this.sql.unit("kg_upsertEntity", [workspaceId, input, source, sourceTaskId]);
  }

  updateEntity(
    entityId: string,
    patch: { description?: string; properties?: Record<string, unknown>; confidence?: number },
  ): Promise<KGEntity | undefined> {
    return this.sql.unit("kg_updateEntity", [entityId, patch]);
  }

  deleteEntity(entityId: string): Promise<boolean> {
    return this.sql.unit("kg_deleteEntity", [entityId]);
  }

  createEdgeChecked(
    workspaceId: string,
    input: CreateEdgeInput,
    source: Source,
    sourceTaskId: string | undefined,
    now: number,
  ): Promise<KGEdge> {
    return this.sql.unit("kg_createEdgeChecked", [workspaceId, input, source, sourceTaskId, now]);
  }

  getEdge(edgeId: string): Promise<KGEdge | undefined> {
    return this.sql.unit("kg_getEdge", [edgeId]);
  }

  getEdgesBetween(entityId1: string, entityId2: string, asOf?: number): Promise<KGEdge[]> {
    return this.sql.unit("kg_getEdgesBetween", [entityId1, entityId2, asOf]);
  }

  deleteEdge(edgeId: string): Promise<boolean> {
    return this.sql.unit("kg_deleteEdge", [edgeId]);
  }

  invalidateEdge(edgeId: string, validTo: number): Promise<KGEdge | undefined> {
    return this.sql.unit("kg_invalidateEdge", [edgeId, validTo]);
  }

  addObservationChecked(
    input: AddObservationInput,
    source: Source,
    sourceTaskId?: string,
  ): Promise<KGObservation> {
    return this.sql.unit("kg_addObservationChecked", [input, source, sourceTaskId]);
  }

  getObservations(entityId: string, limit?: number): Promise<KGObservation[]> {
    return this.sql.unit("kg_getObservations", [entityId, limit]);
  }

  searchEntities(workspaceId: string, query: string, limit?: number): Promise<KGSearchResult[]> {
    return this.sql.unit("kg_searchEntities", [workspaceId, query, limit]);
  }

  getNeighbors(
    entityId: string,
    depth?: number,
    edgeTypes?: string[],
    asOf?: number,
  ): Promise<KGNeighborResult[]> {
    return this.sql.unit("kg_getNeighbors", [entityId, depth, edgeTypes, asOf]);
  }

  getSubgraph(entityIds: string[], asOf?: number): Promise<KGSubgraph> {
    return this.sql.unit("kg_getSubgraph", [entityIds, asOf]);
  }

  contextEntities(
    workspaceId: string,
    query: string,
    limit: number,
    asOf?: number,
  ): Promise<Array<{ result: KGSearchResult; neighbors: KGNeighborResult[] }>> {
    return this.sql.unit("kg_contextEntities", [workspaceId, query, limit, asOf]);
  }

  applyConfidenceDecay(
    workspaceId: string,
    decayRate?: number,
    floorConfidence?: number,
  ): Promise<number> {
    return this.sql.unit("kg_applyConfidenceDecay", [workspaceId, decayRate, floorConfidence]);
  }

  getStats(workspaceId: string): Promise<KGStats> {
    return this.sql.unit("kg_getStats", [workspaceId]);
  }
}
