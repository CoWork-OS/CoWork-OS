// Knowledge Graph types shared between main and renderer processes

export type KGBuiltinEntityType =
  | "person"
  | "organization"
  | "project"
  | "technology"
  | "concept"
  | "file"
  | "service"
  | "api_endpoint"
  | "database_table"
  | "environment";

export type KGBuiltinEdgeType =
  | "uses"
  | "depends_on"
  | "part_of"
  | "created_by"
  | "maintained_by"
  | "deployed_to"
  | "connects_to"
  | "extends"
  | "implements"
  | "references"
  | "owns"
  | "belongs_to"
  | "related_to"
  | "blocked_by"
  | "replaced_by";

export interface KGEntityType {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  isBuiltin: boolean;
  createdAt: number;
}

export interface KGEntity {
  id: string;
  workspaceId: string;
  entityTypeId: string;
  entityTypeName?: string; // joined from kg_entity_types for convenience
  name: string;
  description?: string;
  properties: Record<string, unknown>;
  confidence: number;
  source: "manual" | "auto" | "agent";
  sourceTaskId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface KGEdge {
  id: string;
  workspaceId: string;
  sourceEntityId: string;
  targetEntityId: string;
  edgeType: string;
  properties: Record<string, unknown>;
  confidence: number;
  source: "manual" | "auto" | "agent";
  sourceTaskId?: string;
  createdAt: number;
}

export interface KGObservation {
  id: string;
  entityId: string;
  content: string;
  source: "manual" | "auto" | "agent";
  sourceTaskId?: string;
  createdAt: number;
}

export interface KGSearchResult {
  entity: KGEntity;
  score: number;
  observations?: KGObservation[];
}

export interface KGNeighborResult {
  entity: KGEntity;
  edge: KGEdge;
  direction: "outgoing" | "incoming";
  depth: number;
}

export interface KGSubgraph {
  entities: KGEntity[];
  edges: KGEdge[];
}

export interface CreateEntityInput {
  entityType: string; // name of the entity type (e.g. "person", "technology")
  name: string;
  description?: string;
  properties?: Record<string, unknown>;
  confidence?: number;
}

export interface UpdateEntityInput {
  entityId: string;
  description?: string;
  properties?: Record<string, unknown>;
  confidence?: number;
}

export interface CreateEdgeInput {
  sourceEntityId: string;
  targetEntityId: string;
  edgeType: string;
  properties?: Record<string, unknown>;
  confidence?: number;
}

export interface AddObservationInput {
  entityId: string;
  content: string;
}

export interface KGStats {
  entityCount: number;
  edgeCount: number;
  observationCount: number;
  entityTypeDistribution: Array<{ typeName: string; count: number }>;
}
