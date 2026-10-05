import type Database from "better-sqlite3";
import { KnowledgeGraphRepository } from "./KnowledgeGraphRepository";
import {
  createMemoryStatementPort,
  type MemoryStatementPort,
} from "../memory/memory-statement-port";
import { containsNoMemoryDirective } from "../memory/no-memory-directive";
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
import { createLogger } from "../utils/logger";
import {
  domainOrganizationLabel,
  extractTechnologyMentions,
  isAutomatedSenderAddress,
  isFreeMailDomain,
} from "./kg-extraction";

const logger = createLogger("KnowledgeGraph");

const MAX_CONTEXT_ENTITIES = 5;
const MAX_CONTEXT_CHARS = 1500;
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
/** The one-time data-quality cleanup runs this long after startup (off the hot path). */
const CLEANUP_DELAY_MS = 120_000;

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
  private static port: MemoryStatementPort | null = null;
  private static initialized = false;
  private static lastDecayRun = new Map<string, number>();
  private static cleanupTimer?: ReturnType<typeof setTimeout>;

  static initialize(db: Database.Database, options: { scheduleCleanup?: boolean } = {}): void {
    if (this.initialized) return;
    this.port = createMemoryStatementPort(db);
    this.repo = new KnowledgeGraphRepository(this.port);
    this.initialized = true;
    if (options.scheduleCleanup !== false) this.scheduleCleanup();
  }

  /** Schedule the one-time data-quality cleanup (KnowledgeGraphCleanup.ts) after startup. */
  private static scheduleCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      void this.runCleanupNow();
    }, CLEANUP_DELAY_MS);
    this.cleanupTimer.unref?.();
  }

  /** Run the one-time cleanup now (idempotent; a no-op once its marker exists). */
  static async runCleanupNow(): Promise<void> {
    const port = this.port;
    if (!this.initialized || !port) return;
    try {
      const { runKnowledgeGraphCleanup } = await import("./KnowledgeGraphCleanup");
      await runKnowledgeGraphCleanup(port, {
        pause: () => new Promise((resolve) => setImmediate(resolve)),
      });
    } catch (error) {
      logger.warn("Knowledge graph cleanup failed; it will be retried on the next start:", error);
    }
  }

  /**
   * Whether automatic writes (task extraction, mailbox ingest) may add to this
   * workspace's graph: not when its memory is disabled (off or privacy mode "disabled")
   * or the source text opts out with `<no-memory>`. Explicit `kg_*` tool writes are
   * gated by the tool layer instead (they honor `<no-memory>` only).
   */
  static async automaticWritesAllowed(workspaceId: string, ...texts: unknown[]): Promise<boolean> {
    if (texts.some(containsNoMemoryDirective)) return false;
    try {
      const policy = await this.getRepo().getWritePolicy(workspaceId);
      return policy.enabled && policy.privacyMode !== "disabled";
    } catch {
      // Fail closed: without the settings, automatic writes wait.
      return false;
    }
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

  // By-id operations are scoped to the caller's workspace (SEC-9): an id that belongs
  // to another workspace is treated as not found.
  /**
   * Update an entity. A description written by a higher-precedence source (manual >
   * agent > auto) is kept; the rest of the patch applies.
   */
  static updateEntity(
    workspaceId: string,
    input: UpdateEntityInput,
    source: "manual" | "auto" | "agent" = "agent",
  ): Promise<KGEntity | undefined> {
    const repo = this.getRepo();
    return repo.updateEntity(
      workspaceId,
      input.entityId,
      {
        description: input.description,
        properties: input.properties,
        confidence: input.confidence,
      },
      source,
    );
  }

  static deleteEntity(workspaceId: string, entityId: string): Promise<boolean> {
    return this.getRepo().deleteEntity(workspaceId, entityId);
  }

  static getEntity(workspaceId: string, entityId: string): Promise<KGEntity | undefined> {
    return this.getRepo().getEntity(workspaceId, entityId);
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

  static deleteEdge(workspaceId: string, edgeId: string): Promise<boolean> {
    return this.getRepo().deleteEdge(workspaceId, edgeId);
  }

  static invalidateEdge(
    workspaceId: string,
    edgeId: string,
    validTo = Date.now(),
  ): Promise<KGEdge | undefined> {
    return this.getRepo().invalidateEdge(workspaceId, edgeId, validTo);
  }

  // ─── Observation Operations ───────────────────────────────────────

  static addObservation(
    workspaceId: string,
    input: AddObservationInput,
    source: "manual" | "auto" | "agent" = "agent",
    sourceTaskId?: string,
  ): Promise<KGObservation> {
    return this.getRepo().addObservationChecked(workspaceId, input, source, sourceTaskId);
  }

  // ─── Search & Traversal ───────────────────────────────────────────

  static search(workspaceId: string, query: string, limit = 10): Promise<KGSearchResult[]> {
    return this.getRepo().searchEntities(workspaceId, query, limit);
  }

  static getNeighbors(
    workspaceId: string,
    entityId: string,
    depth = 1,
    edgeTypes?: string[],
    asOf?: number,
  ): Promise<KGNeighborResult[]> {
    return this.getRepo().getNeighbors(workspaceId, entityId, depth, edgeTypes, asOf);
  }

  static getSubgraph(workspaceId: string, entityIds: string[], asOf?: number): Promise<KGSubgraph> {
    return this.getRepo().getSubgraph(workspaceId, entityIds, asOf);
  }

  static getStats(workspaceId: string): Promise<KGStats> {
    return this.getRepo().getStats(workspaceId);
  }

  static getEntityTypes(workspaceId: string) {
    return this.getRepo().getEntityTypes(workspaceId);
  }

  static getObservations(
    workspaceId: string,
    entityId: string,
    limit = 20,
  ): Promise<KGObservation[]> {
    return this.getRepo().getObservations(workspaceId, entityId, limit);
  }

  /**
   * Enrich the graph from a mailbox event: the contact (person), their organization, a
   * project hint, and one observation per entity. Skipped when the workspace's memory is
   * disabled or the event text carries `<no-memory>`. Free-mail and relay domains
   * (gmail.com, outlook.com, privaterelay.appleid.com, ...) never become organizations or
   * `works_at` edges, the organization is named after the registrable domain
   * (`news.acme.com` → "Acme"), automated senders (noreply, notifications) are not
   * people, and re-ingesting an event adds no observation twice.
   */
  static async ingestMailboxEvent(workspaceId: string, event: MailboxEvent): Promise<void> {
    if (!this.initialized) return;
    try {
      const payload = event.payload || {};
      if (
        !(await this.automaticWritesAllowed(
          workspaceId,
          event.subject,
          event.summary,
          payload.summary,
        ))
      ) {
        return;
      }
      const primaryEmail =
        asString(payload.primaryContactEmail) ||
        asString(payload.contactEmail) ||
        asString(payload.senderEmail);
      const primaryName =
        asString(payload.primaryContactName) ||
        asString(payload.contactName) ||
        asString(payload.senderName);
      const emailDomain = primaryEmail?.includes("@")
        ? primaryEmail.split("@")[1]?.trim().toLowerCase()
        : undefined;
      const freeMail = isFreeMailDomain(emailDomain);
      const automatedSender = isAutomatedSenderAddress(primaryEmail);
      const explicitCompany = asString(payload.company) || asString(payload.organization);
      const company =
        explicitCompany ||
        (emailDomain && !freeMail ? domainOrganizationLabel(emailDomain) : undefined);
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
        !automatedSender && (primaryEmail || primaryName)
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
                name: explicitCompany
                  ? company
                  : company.charAt(0).toUpperCase() + company.slice(1),
                description: `Mailbox contact organization ${company}`,
                properties: {
                  source: "mailbox",
                  ...(emailDomain && !freeMail ? { domain: emailDomain } : {}),
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
      // One observation per event and entity, however often the event is delivered.
      const eventKey = asString(event.fingerprint) || asString(event.id);
      const fingerprint = eventKey ? `mailbox:${event.type}:${eventKey}` : undefined;

      for (const entity of [person, org, project]) {
        if (!entity || !observationContent) continue;
        await this.addObservation(
          workspaceId,
          { entityId: entity.id, content: observationContent, fingerprint },
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
   * Extract entities from task results using pattern matching (no LLM calls), after task
   * completion. Technology names follow the precision rules in kg-extraction.ts (English
   * words such as "go" or "rest" only in a code-ish context). Skipped when the
   * workspace's memory is disabled or the task opted out with `<no-memory>`.
   */
  static async extractEntitiesFromTaskResult(
    workspaceId: string,
    taskId: string,
    taskPrompt: string,
    resultSummary: string,
  ): Promise<void> {
    if (!this.initialized || !resultSummary) return;

    try {
      if (!(await this.automaticWritesAllowed(workspaceId, taskPrompt, resultSummary))) return;
      const text = `${taskPrompt}\n${resultSummary}`;

      for (const tech of extractTechnologyMentions(text).slice(0, 5)) {
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

      // Extract API endpoints (upper-case HTTP verbs only: "get /path" is prose)
      const apiPatterns = /\b(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[\w/:.-]+)/g;
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
