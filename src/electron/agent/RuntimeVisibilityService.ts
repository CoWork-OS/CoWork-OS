import type { TaskRepository, WorkspaceRepository } from "../database/repository-facades";
import { type TaskEventRepository } from "../database/repositories";
import { type ActivityRepository } from "../activity/activity-repository-facades";
import path from "path";
import { MemoryService } from "../memory/MemoryService";
import { MemoryObservationService } from "../memory/MemoryObservationService";
import { DurableContextService } from "../memory/DurableContextService";
import { extractFtsTerms, termCoverage } from "../database/fts-query";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { ChronicleObservationRepository } from "../chronicle";
import { LLMProviderFactory, type LLMSettings } from "./llm/provider-factory";
import type {
  EvidenceRef,
  LLMRoutingRuntimeState,
  LearningProgressStep,
  Task,
  TaskLearningProgress,
  UnifiedRecallQuery,
  UnifiedRecallResponse,
  UnifiedRecallResult,
  UnifiedRecallSourceType,
} from "../../shared/types";

type RecallRepositories = {
  taskRepo: TaskRepository;
  eventRepo: TaskEventRepository;
  activityRepo: ActivityRepository;
  workspaceRepo: WorkspaceRepository;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(text: string, max = 240): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getTaskSnippet(task: Task): string {
  return truncate(task.resultSummary || task.prompt || task.title, 260);
}

function getMessageText(payload: unknown): string {
  const obj = asObject(payload);
  return normalizeText(obj.message) || normalizeText(obj.content);
}

function sourceWeight(sourceType: UnifiedRecallSourceType): number {
  switch (sourceType) {
    case "task":
      return 0.9;
    case "message":
      return 0.88;
    case "conversation":
      return 0.85;
    case "file":
      return 0.84;
    case "workspace_note":
      return 0.82;
    case "memory":
      return 0.8;
    case "screen_context":
      return 0.79;
    case "knowledge_graph":
      return 0.78;
    default:
      return 0.7;
  }
}

/** Reciprocal-rank fusion constant: lanes contribute weight / (K + position). */
const RRF_K = 60;
/** Lanes that are not full-text indexes must match at least this share of query terms. */
const MIN_TERM_COVERAGE = 0.5;
const KNOWN_SOURCES = new Set<UnifiedRecallSourceType>([
  "task",
  "message",
  "conversation",
  "file",
  "workspace_note",
  "memory",
  "screen_context",
  "knowledge_graph",
]);

type RecallCandidate = Omit<UnifiedRecallResult, "rank">;

/**
 * Fuse per-lane rankings: each lane is ordered by its own relevance (bm25, hybrid score,
 * term coverage...), and only positions are compared across lanes, scaled by the lane's
 * weight. Raw scores of different lanes are never compared. The result rank is in (0, 1]:
 * the top item of the heaviest lane scores close to its weight.
 */
function fuseLanes(lanes: RecallCandidate[][], limit: number): UnifiedRecallResult[] {
  const fused = new Map<string, { result: RecallCandidate; score: number }>();
  for (const lane of lanes) {
    lane.forEach((result, index) => {
      const key = `${result.sourceType}:${result.objectId}`;
      const score = sourceWeight(result.sourceType) / (RRF_K + index + 1);
      const existing = fused.get(key);
      if (existing) existing.score += score;
      else fused.set(key, { result, score });
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || b.result.timestamp - a.result.timestamp)
    .slice(0, limit)
    .map(({ result, score }) => ({
      ...result,
      rank: Number((score * (RRF_K + 1)).toFixed(4)),
    }));
}

export class RuntimeVisibilityService {
  static buildLearningProgress(input: {
    task: Task;
    outcome: "success" | "failure" | "reinforced" | "pending_review" | "noop";
    summary: string;
    memoryCaptured: boolean;
    playbookReinforced: boolean;
    skillProposal?: {
      proposalId?: string;
      proposalStatus?: "pending" | "approved" | "rejected";
      reason: string;
    };
    evidenceRefs?: EvidenceRef[];
    nextAction?: string;
    sourceEventId?: string;
  }): TaskLearningProgress {
    const now = Date.now();
    const hasScreenContextEvidence = (input.evidenceRefs || []).some(
      (ref) => ref.sourceType === "screen_context",
    );
    const steps: LearningProgressStep[] = [
      {
        stage: "screen_context_used",
        status: hasScreenContextEvidence ? "done" : "skipped",
        title: "Chronicle screen context used",
        summary: hasScreenContextEvidence
          ? "Chronicle supplied local screen context that was attached as task evidence."
          : "This task did not promote Chronicle screen context.",
        evidenceRefs: input.evidenceRefs || [],
        createdAt: now,
        details: { hasScreenContextEvidence },
      },
      {
        stage: "memory_captured",
        status: input.memoryCaptured ? "done" : "skipped",
        title: "Memory captured",
        summary: input.memoryCaptured
          ? "Cowork persisted the task outcome as reusable memory."
          : "No new memory was captured for this task.",
        evidenceRefs: input.evidenceRefs || [],
        createdAt: now,
        details: { memoryCaptured: input.memoryCaptured },
      },
      {
        stage: "playbook_reinforced",
        status: input.playbookReinforced
          ? "done"
          : input.outcome === "failure" || input.outcome === "success"
            ? "skipped"
            : "pending",
        title: "Playbook reinforced",
        summary: input.playbookReinforced
          ? "Linked to earlier observed successful executions that used the same approach."
          : input.outcome === "failure"
            ? "No reinforcement because the task did not succeed."
            : "Recorded as an observed successful execution; no earlier execution with a compatible approach was found.",
        evidenceRefs: input.evidenceRefs || [],
        createdAt: now,
        details: { playbookReinforced: input.playbookReinforced },
      },
      {
        stage: "skill_proposed",
        status: input.skillProposal?.proposalId ? "pending" : "skipped",
        title: "Skill proposal",
        summary: input.skillProposal?.proposalId
          ? `Proposal ${input.skillProposal.proposalId} is ${input.skillProposal.proposalStatus || "pending"}.`
          : "No skill proposal was created.",
        evidenceRefs: input.evidenceRefs || [],
        createdAt: now,
        relatedIds: input.skillProposal?.proposalId
          ? { proposalId: input.skillProposal.proposalId }
          : undefined,
        details: input.skillProposal
          ? {
              proposalStatus: input.skillProposal.proposalStatus || "pending",
              reason: input.skillProposal.reason,
            }
          : undefined,
      },
    ];

    if (input.skillProposal?.proposalStatus === "approved") {
      steps.push({
        stage: "skill_approved",
        status: "done",
        title: "Skill approved",
        summary: "The proposal was approved and is now available as a reusable skill.",
        evidenceRefs: input.evidenceRefs || [],
        createdAt: now,
        relatedIds: input.skillProposal.proposalId
          ? { proposalId: input.skillProposal.proposalId, skillId: input.skillProposal.proposalId }
          : undefined,
      });
    } else if (input.skillProposal?.proposalStatus === "rejected") {
      steps.push({
        stage: "skill_rejected",
        status: "done",
        title: "Skill rejected",
        summary: "The proposal was reviewed and rejected.",
        evidenceRefs: input.evidenceRefs || [],
        createdAt: now,
        relatedIds: input.skillProposal.proposalId
          ? { proposalId: input.skillProposal.proposalId }
          : undefined,
        details: { reason: input.skillProposal.reason },
      });
    } else if (input.skillProposal?.proposalId) {
      steps.push({
        stage: "skill_reviewed",
        status: "pending",
        title: "Skill review",
        summary: "Awaiting approval or rejection.",
        evidenceRefs: input.evidenceRefs || [],
        createdAt: now,
        relatedIds: { proposalId: input.skillProposal.proposalId },
      });
    }

    return {
      id: `learn_${input.task.id}_${now}`,
      taskId: input.task.id,
      workspaceId: input.task.workspaceId,
      taskTitle: input.task.title,
      taskStatus: input.task.status,
      outcome: input.outcome,
      completedAt: now,
      summary: truncate(input.summary || "No learning summary available.", 320),
      steps,
      nextAction: input.nextAction,
      evidenceRefs: input.evidenceRefs || [],
      sourceEventId: input.sourceEventId,
    };
  }

  /**
   * Mission Control recall (RECALL-4): one ranked list across the workspace's memory,
   * notes, knowledge graph, screen context, conversation index, tasks, files and
   * activity. Full-text lanes are trusted as returned (no whole-query substring filter
   * on top of FTS); lanes without an index are filtered by query-term coverage. Lanes are
   * fused by reciprocal rank. Browsing records no memory references, and everything is
   * scoped to the workspace: without one, nothing is returned.
   */
  static async collectUnifiedRecall(
    deps: RecallRepositories,
    query: UnifiedRecallQuery & { workspacePath?: string },
  ): Promise<UnifiedRecallResponse> {
    const workspaceId = normalizeText(query.workspaceId) || undefined;
    const normalizedQuery = normalizeText(query.query).slice(0, 2000);
    const limit = Math.min(Math.max(Math.floor(Number(query.limit) || 20), 1), 100);
    const wantedSources = new Set<UnifiedRecallSourceType>(
      (Array.isArray(query.sourceTypes) ? query.sourceTypes : []).filter((source) =>
        KNOWN_SOURCES.has(source),
      ),
    );
    const includeAllSources = wantedSources.size === 0;
    const sourceAllowed = (source: UnifiedRecallSourceType): boolean =>
      includeAllSources || wantedSources.has(source);
    const response = (results: UnifiedRecallResult[]): UnifiedRecallResponse => ({
      query: normalizedQuery,
      workspaceId,
      generatedAt: Date.now(),
      results,
    });

    const terms = extractFtsTerms(normalizedQuery, { maxTerms: 24 });
    if (!workspaceId || terms.length === 0) return response([]);
    const covers = (text: string): number => termCoverage(text, terms);
    const candidateLimit = Math.min(limit * 2, 100);
    const lanes: RecallCandidate[][] = [];
    const lane = async (
      enabled: boolean,
      collect: () => Promise<RecallCandidate[]>,
    ): Promise<RecallCandidate[]> => {
      if (!enabled) return [];
      try {
        return await collect();
      } catch {
        // One failing source must not hide the others.
        return [];
      }
    };

    // Memory: own, non-private, visible rows; browsing is not a use, so no references.
    lanes.push(
      await lane(sourceAllowed("memory"), async () => {
        const memories = await MemoryService.searchForBriefingAsync(
          workspaceId,
          normalizedQuery,
          candidateLimit,
        );
        let observations = new Map<
          string,
          Awaited<ReturnType<typeof MemoryObservationService.details>>[number]
        >();
        try {
          observations = new Map(
            (
              await MemoryObservationService.details(
                memories.map((mem) => mem.id),
                workspaceId,
              )
            ).map((observation) => [observation.memoryId, observation]),
          );
        } catch {
          // Observation metadata is optional.
        }
        return memories.map((mem) => {
          const observation = observations.get(mem.id);
          return {
            sourceType: "memory" as const,
            objectId: mem.id,
            workspaceId,
            taskId: mem.taskId,
            timestamp: mem.createdAt,
            snippet: truncate(mem.snippet || "", 260),
            title: observation?.title || normalizeText(mem.type) || "Memory",
            sourceLabel: "Memory",
            metadata: {
              type: mem.type,
              relevanceScore: mem.relevanceScore,
              observationTitle: observation?.title,
              concepts: observation?.concepts || [],
              filesRead: observation?.filesRead || [],
              filesModified: observation?.filesModified || [],
              privacyState: observation?.privacyState,
              sourceEventIds: observation?.sourceEventIds || [],
            },
          };
        });
      }),
    );

    // Workspace notes: the `.cowork` kit, the same root the agent tools index.
    lanes.push(
      await lane(Boolean(query.workspacePath) && sourceAllowed("workspace_note"), async () =>
        (
          await MemoryService.searchWorkspaceMarkdown(
            workspaceId,
            path.join(query.workspacePath as string, ".cowork"),
            normalizedQuery,
            candidateLimit,
          )
        ).map((note) => ({
          sourceType: "workspace_note" as const,
          objectId: note.id,
          workspaceId,
          timestamp: note.createdAt,
          snippet: truncate(note.snippet || "", 260),
          title: normalizeText(note.type) || "Workspace note",
          sourceLabel: "Workspace note",
          metadata: {
            relevanceScore: note.relevanceScore,
            ...("path" in note ? { path: note.path } : {}),
          },
        })),
      ),
    );

    lanes.push(
      await lane(sourceAllowed("knowledge_graph"), async () =>
        (await KnowledgeGraphService.search(workspaceId, normalizedQuery, candidateLimit)).map(
          (entity) => ({
            sourceType: "knowledge_graph" as const,
            objectId: entity.entity.id,
            workspaceId,
            timestamp: entity.entity.updatedAt,
            snippet: truncate(
              `${entity.entity.name}${entity.entity.description ? ` - ${entity.entity.description}` : ""}`,
              260,
            ),
            title: entity.entity.name,
            sourceLabel: "Knowledge graph",
            metadata: {
              entityType: entity.entity.entityTypeName,
              confidence: entity.entity.confidence,
            },
          }),
        ),
      ),
    );

    // Screen context is scored, not indexed: keep observations that match the query.
    lanes.push(
      await lane(Boolean(query.workspacePath) && sourceAllowed("screen_context"), async () =>
        ChronicleObservationRepository.searchSync(
          query.workspacePath as string,
          normalizedQuery,
          candidateLimit,
        )
          .map((observation) => ({
            observation,
            snippet: truncate(
              [
                observation.appName,
                observation.windowTitle,
                observation.localTextSnippet || observation.query,
              ]
                .filter(Boolean)
                .join(" - "),
              260,
            ),
          }))
          .filter(({ snippet }) => covers(snippet) >= MIN_TERM_COVERAGE)
          .map(({ observation, snippet }) => ({
            sourceType: "screen_context" as const,
            objectId: observation.id,
            workspaceId: observation.workspaceId,
            taskId: observation.taskId,
            timestamp: observation.capturedAt,
            snippet,
            title: observation.windowTitle || observation.appName || "Screen context",
            sourceLabel: "Screen context",
            metadata: {
              appName: observation.appName,
              windowTitle: observation.windowTitle,
              imagePath: observation.imagePath,
              confidence: observation.confidence,
              usedFallback: observation.usedFallback,
              provenance: observation.provenance,
              destinationHints: observation.destinationHints,
              sourceRef: observation.sourceRef || null,
              memoryId: observation.memoryId || null,
              memoryGeneratedAt: observation.memoryGeneratedAt || null,
            },
          })),
      ),
    );

    // The conversation index: user/assistant messages, tool output and summaries of
    // every task in the workspace.
    const wantConversation = sourceAllowed("message") || sourceAllowed("conversation");
    lanes.push(
      await lane(wantConversation, async () =>
        (
          await DurableContextService.searchConversation({
            workspaceId,
            query: normalizedQuery,
            limit: candidateLimit,
            mode: "auto",
          })
        )
          .map((hit) => {
            const isMessage = hit.role === "user" || hit.role === "assistant";
            const sourceType: UnifiedRecallSourceType =
              isMessage && hit.kind === "event" ? "message" : "conversation";
            return {
              sourceType,
              objectId: hit.eventId ? `${hit.taskId}:${hit.eventId}` : `${hit.taskId}:${hit.id}`,
              workspaceId,
              taskId: hit.taskId,
              timestamp: hit.timestamp,
              snippet: truncate(hit.snippet, 260),
              title:
                hit.type === "user_message"
                  ? "User message"
                  : hit.type === "assistant_message"
                    ? "Assistant message"
                    : hit.kind === "summary"
                      ? "Conversation summary"
                      : hit.type,
              sourceLabel: sourceType === "message" ? "Message" : "Conversation",
              metadata: { eventType: hit.type, conversationId: hit.id },
            };
          })
          .filter((result) => sourceAllowed(result.sourceType)),
      ),
    );

    // Tasks of this workspace (title, prompt, result), ranked by query-term coverage.
    let taskMatches: Task[] = [];
    if (sourceAllowed("task") || sourceAllowed("file")) {
      try {
        const recent = await deps.taskRepo.findByCreatedAtRange({
          startMs: Date.now() - 90 * 24 * 60 * 60 * 1000,
          endMs: Date.now() + 1,
          limit: 200,
          workspaceId,
        });
        taskMatches = recent
          .filter((task) => task.workspaceId === workspaceId)
          .map((task) => ({
            task,
            coverage: covers(`${task.title}\n${task.prompt}\n${task.resultSummary || ""}`),
          }))
          .filter((entry) => entry.coverage >= MIN_TERM_COVERAGE)
          .sort(
            (a, b) =>
              b.coverage - a.coverage ||
              (b.task.updatedAt || b.task.createdAt) - (a.task.updatedAt || a.task.createdAt),
          )
          .slice(0, candidateLimit)
          .map((entry) => entry.task);
      } catch {
        taskMatches = [];
      }
    }
    if (sourceAllowed("task")) {
      lanes.push(
        taskMatches.map((task) => ({
          sourceType: "task" as const,
          objectId: task.id,
          workspaceId: task.workspaceId,
          taskId: task.id,
          timestamp: task.updatedAt || task.createdAt,
          snippet: getTaskSnippet(task),
          title: task.title,
          sourceLabel: "Task",
          metadata: { status: task.status, terminalStatus: task.terminalStatus },
        })),
      );
    }

    // Files touched by the matching tasks.
    lanes.push(
      await lane(sourceAllowed("file") && taskMatches.length > 0, async () => {
        const byTask = new Map(taskMatches.map((task) => [task.id, task]));
        const events = await deps.eventRepo.findByTaskIds(taskMatches.map((task) => task.id));
        const files: Array<RecallCandidate & { coverage: number }> = [];
        for (const event of events) {
          const task = byTask.get(event.taskId);
          if (!task) continue;
          const payload = asObject(event.payload);
          const filePath = normalizeText(payload.path || payload.filePath || payload.outputPath);
          if (!filePath) continue;
          const message = getMessageText(payload);
          const coverage = Math.max(covers(filePath), covers(message));
          if (coverage < MIN_TERM_COVERAGE) continue;
          files.push({
            sourceType: "file",
            objectId: filePath,
            workspaceId: task.workspaceId,
            taskId: task.id,
            timestamp: event.timestamp || task.updatedAt || task.createdAt,
            snippet: truncate(message || filePath, 260),
            title: filePath,
            sourceLabel: "File",
            metadata: { eventType: event.type, path: filePath },
            coverage,
          });
        }
        return files
          .sort((a, b) => b.coverage - a.coverage || b.timestamp - a.timestamp)
          .map(({ coverage: _coverage, ...result }) => result);
      }),
    );

    // Activity feed entries; shown as messages, filtered by query-term coverage.
    lanes.push(
      await lane(sourceAllowed("message"), async () =>
        (await deps.activityRepo.list({ workspaceId, limit: candidateLimit }))
          .map((activity) => ({
            activity,
            text: `${activity.title}\n${activity.description || ""}`,
          }))
          .map((entry) => ({ ...entry, coverage: covers(entry.text) }))
          .filter((entry) => entry.coverage >= MIN_TERM_COVERAGE)
          .sort((a, b) => b.coverage - a.coverage || b.activity.createdAt - a.activity.createdAt)
          .map(({ activity, text }) => ({
            sourceType: "message" as const,
            objectId: activity.id,
            workspaceId,
            taskId: activity.taskId,
            timestamp: activity.createdAt,
            snippet: truncate(text, 260),
            title: activity.title,
            sourceLabel: "Activity",
            metadata: { activityType: activity.activityType, actorType: activity.actorType },
          })),
      ),
    );

    return response(fuseLanes(lanes, limit));
  }

  static buildRoutingState(
    settings: LLMSettings,
    options?: {
      task?: Pick<Task, "title" | "prompt" | "agentConfig" | "source" | "status">;
      isVerificationTask?: boolean;
    },
  ): LLMRoutingRuntimeState {
    const currentProvider = settings.providerType as LLMRoutingRuntimeState["currentProvider"];
    const modelStatus = LLMProviderFactory.getProviderModelStatus(settings);
    const selection = LLMProviderFactory.resolveTaskModelSelection(
      options?.task?.agentConfig as Parameters<
        typeof LLMProviderFactory.resolveTaskModelSelection
      >[0],
      {
        isVerificationTask: options?.isVerificationTask,
      },
    );
    const routing = LLMProviderFactory.getProviderRoutingSettings(settings, selection.providerType);
    return {
      currentProvider,
      currentModel: modelStatus.currentModel,
      activeProvider: selection.providerType,
      activeModel: selection.modelId,
      routeReason: routing.profileRoutingEnabled ? "profile_routing" : "manual_override",
      fallbackChain: [],
      fallbackOccurred: false,
      manualOverride: Boolean(options?.task?.agentConfig?.modelKey),
      profileHint: selection.llmProfileUsed,
      updatedAt: Date.now(),
    };
  }
}
