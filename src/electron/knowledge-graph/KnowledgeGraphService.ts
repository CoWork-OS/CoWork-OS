import type Database from "better-sqlite3";
import { KnowledgeGraphRepository } from "./KnowledgeGraphRepository";
import { createMemoryStatementPort } from "../memory/memory-statement-port";
import type { MailboxEvent } from "../../shared/mailbox";
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
import { MemoryFeaturesManager } from "../settings/memory-features-manager";

const MAX_CONTEXT_ENTITIES = 5;
const MAX_CONTEXT_CHARS = 1500;
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
}

function compactText(text: string, max = 240): string {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function normalizeEdgeTime(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

export class KnowledgeGraphService {
  private static repo: KnowledgeGraphRepository | null = null;
  private static initialized = false;
  private static lastDecayRun = new Map<string, number>();

  static initialize(db: Database.Database): void {
    if (this.initialized) return;
    this.repo = new KnowledgeGraphRepository(createMemoryStatementPort(db));
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

  /** Create an entity, or merge into the existing one of the same type and name. */
  static createEntity(
    workspaceId: string,
    input: CreateEntityInput,
    source: "manual" | "auto" | "agent" = "agent",
    sourceTaskId?: string,
  ): Promise<KGEntity> {
    return this.getRepo().upsertEntity(workspaceId, input, source, sourceTaskId);
  }

  static updateEntity(input: UpdateEntityInput): Promise<KGEntity | undefined> {
    const repo = this.getRepo();
    return repo.updateEntity(input.entityId, {
      description: input.description,
      properties: input.properties,
      confidence: input.confidence,
    });
  }

  static deleteEntity(entityId: string): Promise<boolean> {
    return this.getRepo().deleteEntity(entityId);
  }

  static getEntity(entityId: string): Promise<KGEntity | undefined> {
    return this.getRepo().getEntity(entityId);
  }

  // ─── Edge Operations ──────────────────────────────────────────────

  /** Create an edge between existing entities, or return the matching current one. */
  static createEdge(
    workspaceId: string,
    input: CreateEdgeInput,
    source: "manual" | "auto" | "agent" = "agent",
    sourceTaskId?: string,
  ): Promise<KGEdge> {
    return this.getRepo().createEdgeChecked(workspaceId, input, source, sourceTaskId, Date.now());
  }

  static deleteEdge(edgeId: string): Promise<boolean> {
    return this.getRepo().deleteEdge(edgeId);
  }

  static invalidateEdge(edgeId: string, validTo = Date.now()): Promise<KGEdge | undefined> {
    return this.getRepo().invalidateEdge(edgeId, validTo);
  }

  // ─── Observation Operations ───────────────────────────────────────

  static addObservation(
    input: AddObservationInput,
    source: "manual" | "auto" | "agent" = "agent",
    sourceTaskId?: string,
  ): Promise<KGObservation> {
    return this.getRepo().addObservationChecked(input, source, sourceTaskId);
  }

  // ─── Search & Traversal ───────────────────────────────────────────

  static search(workspaceId: string, query: string, limit = 10): Promise<KGSearchResult[]> {
    return this.getRepo().searchEntities(workspaceId, query, limit);
  }

  static getNeighbors(
    entityId: string,
    depth = 1,
    edgeTypes?: string[],
    asOf?: number,
  ): Promise<KGNeighborResult[]> {
    return this.getRepo().getNeighbors(entityId, depth, edgeTypes, asOf);
  }

  static getSubgraph(entityIds: string[], asOf?: number): Promise<KGSubgraph> {
    return this.getRepo().getSubgraph(entityIds, asOf);
  }

  static getStats(workspaceId: string): Promise<KGStats> {
    return this.getRepo().getStats(workspaceId);
  }

  static getEntityTypes(workspaceId: string) {
    return this.getRepo().getEntityTypes(workspaceId);
  }

  static getObservations(entityId: string, limit = 20): Promise<KGObservation[]> {
    return this.getRepo().getObservations(entityId, limit);
  }

  static async ingestMailboxEvent(workspaceId: string, event: MailboxEvent): Promise<void> {
    if (!this.initialized) return;
    try {
      const payload = event.payload || {};
      const primaryEmail =
        asString(payload.primaryContactEmail) ||
        asString(payload.contactEmail) ||
        asString(payload.senderEmail);
      const primaryName =
        asString(payload.primaryContactName) ||
        asString(payload.contactName) ||
        asString(payload.senderName);
      const company =
        asString(payload.company) ||
        asString(payload.organization) ||
        (primaryEmail?.includes("@") ? primaryEmail.split("@")[1]?.split(".")[0] : undefined);
      const projectHints = [
        asString(payload.projectHint),
        ...asStringArray(payload.projectHints),
        ...asStringArray(payload.projectNames),
        ...asStringArray(payload.relatedProjects),
      ];
      const commitmentTitles = asStringArray(payload.commitmentTitles);
      const summary = compactText(
        [event.subject, event.summary, asString(payload.summary), asString(payload.reason)]
          .filter(Boolean)
          .join(" "),
        280,
      );

      const person =
        primaryEmail || primaryName
          ? await this.createEntity(
              workspaceId,
              {
                entityType: "person",
                name: primaryName || primaryEmail || "Mailbox contact",
                description: primaryEmail ? `Email contact ${primaryEmail}` : primaryName,
                properties: {
                  email: primaryEmail,
                  source: "mailbox",
                  threadId: event.threadId,
                },
                confidence: 0.82,
              },
              "auto",
              event.threadId,
            )
          : undefined;

      const org =
        company && company.length > 1
          ? await this.createEntity(
              workspaceId,
              {
                entityType: "organization",
                name: company.charAt(0).toUpperCase() + company.slice(1),
                description: `Mailbox contact organization ${company}`,
                properties: {
                  source: "mailbox",
                  domain: primaryEmail?.split("@")[1],
                },
                confidence: 0.72,
              },
              "auto",
              event.threadId,
            )
          : undefined;

      const projectName = projectHints[0];
      const project =
        projectName && projectName.length > 2
          ? await this.createEntity(
              workspaceId,
              {
                entityType: "project",
                name: projectName,
                description: `Mailbox thread context for ${projectName}`,
                properties: {
                  source: "mailbox",
                  threadId: event.threadId,
                  subject: event.subject,
                },
                confidence: 0.68,
              },
              "auto",
              event.threadId,
            )
          : undefined;

      if (person && org) {
        try {
          await this.createEdge(
            workspaceId,
            {
              sourceEntityId: person.id,
              targetEntityId: org.id,
              edgeType: "works_at",
              properties: { source: "mailbox" },
              confidence: 0.72,
            },
            "auto",
            event.threadId,
          );
        } catch {
          // best effort
        }
      }

      if (person && project) {
        try {
          await this.createEdge(
            workspaceId,
            {
              sourceEntityId: person.id,
              targetEntityId: project.id,
              edgeType: "related_to",
              properties: { source: "mailbox", threadId: event.threadId },
              confidence: 0.7,
            },
            "auto",
            event.threadId,
          );
        } catch {
          // best effort
        }
      }

      const observationContent = compactText(
        [
          `Mailbox event: ${event.type}`,
          summary || null,
          event.evidenceRefs.length > 0 ? `Evidence: ${event.evidenceRefs.join(", ")}` : null,
          commitmentTitles.length > 0 ? `Commitments: ${commitmentTitles.join(" | ")}` : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join(" · "),
        500,
      );

      if (person && observationContent) {
        await this.addObservation(
          {
            entityId: person.id,
            content: observationContent,
          },
          "auto",
          event.threadId,
        );
      }
      if (org && observationContent) {
        await this.addObservation(
          {
            entityId: org.id,
            content: observationContent,
          },
          "auto",
          event.threadId,
        );
      }
      if (project && observationContent) {
        await this.addObservation(
          {
            entityId: project.id,
            content: observationContent,
          },
          "auto",
          event.threadId,
        );
      }
    } catch {
      // best-effort mailbox enrichment
    }
  }

  // ─── Context Injection ────────────────────────────────────────────

  /**
   * Build a concise knowledge graph context string for injection into an agent's
   * system prompt. Searches for entities relevant to the task prompt.
   */
  static async buildContextForTask(workspaceId: string, taskPrompt: string): Promise<string> {
    if (!this.initialized) return "";

    try {
      const temporalKnowledgeEnabled =
        MemoryFeaturesManager.loadSettings().temporalKnowledgeEnabled !== false;
      const asOf = temporalKnowledgeEnabled ? Date.now() : undefined;
      // One snapshot: matching entities with their immediate relationships.
      const results = await this.getRepo().contextEntities(
        workspaceId,
        taskPrompt,
        MAX_CONTEXT_ENTITIES,
        asOf,
      );
      if (results.length === 0) return "";

      const lines: string[] = ["KNOWLEDGE GRAPH (known entities and relationships):"];

      for (const { result, neighbors } of results) {
        const e = result.entity;
        const typeName = e.entityTypeName || "entity";
        let line = `- [${typeName}] ${e.name}`;
        if (e.description) {
          line += `: ${e.description.slice(0, 120)}`;
        }

        // Add immediate relationships
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
  static async extractEntitiesFromTaskResult(
    workspaceId: string,
    taskId: string,
    taskPrompt: string,
    resultSummary: string,
  ): Promise<void> {
    if (!this.initialized || !resultSummary) return;

    try {
      const text = `${taskPrompt}\n${resultSummary}`;

      // Extract technology mentions (common framework/language names)
      const techPatterns =
        /\b(React|Vue|Angular|Next\.js|Node\.js|TypeScript|JavaScript|Python|Rust|Go|Docker|Kubernetes|PostgreSQL|MongoDB|Redis|GraphQL|REST|Tailwind|Vite|Webpack|Express|FastAPI|Django|Flask|Electron|SQLite)\b/gi;
      const techMatches = [...new Set(Array.from(text.matchAll(techPatterns), (m) => m[1]))];

      for (const tech of techMatches.slice(0, 5)) {
        try {
          await this.createEntity(
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
          await this.createEntity(
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
          await this.createEntity(
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
      await this.maybeRunDecay(workspaceId);
    } catch {
      // Non-critical — don't disrupt task flow
    }
  }

  // ─── Confidence Decay ─────────────────────────────────────────────

  /**
   * Run confidence decay for auto-extracted entities if enough time has passed.
   */
  private static async maybeRunDecay(workspaceId: string): Promise<void> {
    const lastRun = this.lastDecayRun.get(workspaceId) || 0;
    if (Date.now() - lastRun < DECAY_INTERVAL_MS) return;

    try {
      await this.getRepo().applyConfidenceDecay(workspaceId);
      this.lastDecayRun.set(workspaceId, Date.now());
    } catch {
      // best-effort
    }
  }

  static async runDecay(workspaceId: string): Promise<number> {
    const updated = await this.getRepo().applyConfidenceDecay(workspaceId);
    this.lastDecayRun.set(workspaceId, Date.now());
    return updated;
  }
}
