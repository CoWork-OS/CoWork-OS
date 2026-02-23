import type Database from "better-sqlite3";
import { KnowledgeGraphRepository } from "./KnowledgeGraphRepository";
import type {
  KGEntity,
  KGEdge,
  KGObservation,
  KGSearchResult,
  KGNeighborResult,
  KGSubgraph,
  KGStats,
  CreateEntityInput,
  UpdateEntityInput,
  CreateEdgeInput,
  AddObservationInput,
} from "../../shared/knowledge-graph-types";

const MAX_CONTEXT_ENTITIES = 5;
const MAX_CONTEXT_CHARS = 1500;
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class KnowledgeGraphService {
  private static repo: KnowledgeGraphRepository | null = null;
  private static initialized = false;
  private static lastDecayRun = new Map<string, number>();

  static initialize(db: Database.Database): void {
    if (this.initialized) return;
    this.repo = new KnowledgeGraphRepository(db);
    this.initialized = true;
  }

  static isInitialized(): boolean {
    return this.initialized;
  }

  private static getRepo(): KnowledgeGraphRepository {
    if (!this.repo) {
      throw new Error("KnowledgeGraphService not initialized. Call initialize(db) first.");
    }
    return this.repo;
  }

  // ─── Entity Operations ────────────────────────────────────────────

  static createEntity(
    workspaceId: string,
    input: CreateEntityInput,
    source: "manual" | "auto" | "agent" = "agent",
    sourceTaskId?: string,
  ): KGEntity {
    const repo = this.getRepo();

    // Resolve or create entity type
    const entityType = repo.getOrCreateEntityType(workspaceId, input.entityType);

    // Check for existing entity (upsert: update if exists)
    const existing = repo.getEntityByName(workspaceId, entityType.id, input.name.trim());
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

      if (Object.keys(patch).length > 0) {
        return repo.updateEntity(existing.id, patch) || existing;
      }
      return existing;
    }

    return repo.createEntity(
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

  static updateEntity(input: UpdateEntityInput): KGEntity | undefined {
    const repo = this.getRepo();
    return repo.updateEntity(input.entityId, {
      description: input.description,
      properties: input.properties,
      confidence: input.confidence,
    });
  }

  static deleteEntity(entityId: string): boolean {
    return this.getRepo().deleteEntity(entityId);
  }

  static getEntity(entityId: string): KGEntity | undefined {
    return this.getRepo().getEntity(entityId);
  }

  // ─── Edge Operations ──────────────────────────────────────────────

  static createEdge(
    workspaceId: string,
    input: CreateEdgeInput,
    source: "manual" | "auto" | "agent" = "agent",
    sourceTaskId?: string,
  ): KGEdge {
    const repo = this.getRepo();

    // Validate entities exist
    const sourceEntity = repo.getEntity(input.sourceEntityId);
    if (!sourceEntity) {
      throw new Error(`Source entity not found: ${input.sourceEntityId}`);
    }
    const targetEntity = repo.getEntity(input.targetEntityId);
    if (!targetEntity) {
      throw new Error(`Target entity not found: ${input.targetEntityId}`);
    }

    // Prevent self-loops
    if (input.sourceEntityId === input.targetEntityId) {
      throw new Error("Cannot create an edge from an entity to itself");
    }

    // Check for duplicate edge
    const existingEdges = repo.getEdgesBetween(input.sourceEntityId, input.targetEntityId);
    const duplicate = existingEdges.find(
      (e) =>
        e.edgeType === input.edgeType.toLowerCase().trim() &&
        e.sourceEntityId === input.sourceEntityId &&
        e.targetEntityId === input.targetEntityId,
    );
    if (duplicate) {
      return duplicate; // Idempotent
    }

    return repo.createEdge(
      workspaceId,
      input.sourceEntityId,
      input.targetEntityId,
      input.edgeType,
      input.properties,
      input.confidence ?? 1.0,
      source,
      sourceTaskId,
    );
  }

  static deleteEdge(edgeId: string): boolean {
    return this.getRepo().deleteEdge(edgeId);
  }

  // ─── Observation Operations ───────────────────────────────────────

  static addObservation(
    input: AddObservationInput,
    source: "manual" | "auto" | "agent" = "agent",
    sourceTaskId?: string,
  ): KGObservation {
    const repo = this.getRepo();

    // Validate entity exists
    const entity = repo.getEntity(input.entityId);
    if (!entity) {
      throw new Error(`Entity not found: ${input.entityId}`);
    }

    return repo.addObservation(input.entityId, input.content, source, sourceTaskId);
  }

  // ─── Search & Traversal ───────────────────────────────────────────

  static search(workspaceId: string, query: string, limit = 10): KGSearchResult[] {
    return this.getRepo().searchEntities(workspaceId, query, limit);
  }

  static getNeighbors(entityId: string, depth = 1, edgeTypes?: string[]): KGNeighborResult[] {
    return this.getRepo().getNeighbors(entityId, depth, edgeTypes);
  }

  static getSubgraph(entityIds: string[]): KGSubgraph {
    return this.getRepo().getSubgraph(entityIds);
  }

  static getStats(workspaceId: string): KGStats {
    return this.getRepo().getStats(workspaceId);
  }

  static getEntityTypes(workspaceId: string) {
    return this.getRepo().getEntityTypes(workspaceId);
  }

  static getObservations(entityId: string, limit = 20): KGObservation[] {
    return this.getRepo().getObservations(entityId, limit);
  }

  // ─── Context Injection ────────────────────────────────────────────

  /**
   * Build a concise knowledge graph context string for injection into an agent's
   * system prompt. Searches for entities relevant to the task prompt.
   */
  static buildContextForTask(workspaceId: string, taskPrompt: string): string {
    if (!this.initialized) return "";

    try {
      const results = this.getRepo().searchEntities(workspaceId, taskPrompt, MAX_CONTEXT_ENTITIES);
      if (results.length === 0) return "";

      const lines: string[] = ["KNOWLEDGE GRAPH (known entities and relationships):"];

      for (const result of results) {
        const e = result.entity;
        const typeName = e.entityTypeName || "entity";
        let line = `- [${typeName}] ${e.name}`;
        if (e.description) {
          line += `: ${e.description.slice(0, 120)}`;
        }

        // Add immediate relationships
        const neighbors = this.getRepo().getNeighbors(e.id, 1);
        if (neighbors.length > 0) {
          const rels = neighbors
            .slice(0, 3)
            .map((n) => {
              const dir = n.direction === "outgoing" ? "->" : "<-";
              return `${dir}[${n.edge.edgeType}] ${n.entity.name}`;
            })
            .join("; ");
          line += ` (${rels})`;
        }

        lines.push(line);
      }

      let text = lines.join("\n");
      if (text.length > MAX_CONTEXT_CHARS) {
        text = `${text.slice(0, MAX_CONTEXT_CHARS - 16)}\n[... truncated]`;
      }

      return text;
    } catch {
      return "";
    }
  }

  // ─── Auto-Extraction ──────────────────────────────────────────────

  /**
   * Extract entities and relationships from task results using simple
   * pattern matching. This is a best-effort extraction that runs after
   * task completion. No LLM calls — uses regex-based heuristics.
   */
  static extractEntitiesFromTaskResult(
    workspaceId: string,
    taskId: string,
    taskPrompt: string,
    resultSummary: string,
  ): void {
    if (!this.initialized || !resultSummary) return;

    try {
      const text = `${taskPrompt}\n${resultSummary}`;

      // Extract technology mentions (common framework/language names)
      const techPatterns =
        /\b(React|Vue|Angular|Next\.js|Node\.js|TypeScript|JavaScript|Python|Rust|Go|Docker|Kubernetes|PostgreSQL|MongoDB|Redis|GraphQL|REST|Tailwind|Vite|Webpack|Express|FastAPI|Django|Flask|Electron|SQLite)\b/gi;
      const techMatches = [...new Set(Array.from(text.matchAll(techPatterns), (m) => m[1]))];

      for (const tech of techMatches.slice(0, 5)) {
        try {
          this.createEntity(
            workspaceId,
            { entityType: "technology", name: tech, description: `Technology: ${tech}` },
            "auto",
            taskId,
          );
        } catch {
          // best-effort
        }
      }

      // Extract file paths
      const filePatterns =
        /(?:^|\s)((?:src|lib|app|components|pages|api|utils|hooks)\/[\w/.-]+\.\w+)/gm;
      const fileMatches = [...new Set(Array.from(text.matchAll(filePatterns), (m) => m[1]))];

      for (const filePath of fileMatches.slice(0, 5)) {
        try {
          this.createEntity(
            workspaceId,
            { entityType: "file", name: filePath, description: `File: ${filePath}` },
            "auto",
            taskId,
          );
        } catch {
          // best-effort
        }
      }

      // Extract API endpoints
      const apiPatterns = /(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[\w/:.-]+)/gi;
      const apiMatches = [...new Set(Array.from(text.matchAll(apiPatterns), (m) => m[1]))];

      for (const endpoint of apiMatches.slice(0, 3)) {
        try {
          this.createEntity(
            workspaceId,
            {
              entityType: "api_endpoint",
              name: endpoint,
              description: `API endpoint: ${endpoint}`,
            },
            "auto",
            taskId,
          );
        } catch {
          // best-effort
        }
      }

      // Run decay periodically
      this.maybeRunDecay(workspaceId);
    } catch {
      // Non-critical — don't disrupt task flow
    }
  }

  // ─── Confidence Decay ─────────────────────────────────────────────

  /**
   * Run confidence decay for auto-extracted entities if enough time has passed.
   */
  private static maybeRunDecay(workspaceId: string): void {
    const lastRun = this.lastDecayRun.get(workspaceId) || 0;
    if (Date.now() - lastRun < DECAY_INTERVAL_MS) return;

    try {
      this.getRepo().applyConfidenceDecay(workspaceId);
      this.lastDecayRun.set(workspaceId, Date.now());
    } catch {
      // best-effort
    }
  }

  static runDecay(workspaceId: string): number {
    const updated = this.getRepo().applyConfidenceDecay(workspaceId);
    this.lastDecayRun.set(workspaceId, Date.now());
    return updated;
  }
}
