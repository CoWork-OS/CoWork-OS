import {
  type TaskEventRepository,
  type TaskRepository,
  type WorkspaceRepository,
} from "../database/repositories";
import { type ActivityRepository } from "../activity/ActivityRepository";
import { MemoryService } from "../memory/MemoryService";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { ChronicleObservationRepository } from "../chronicle";
import { LLMProviderFactory, type LLMSettings } from "./llm/provider-factory";
import type {
  EvidenceRef,
  LLMRoutingRuntimeState,
  LearningProgressStep,
  Task,
  TaskLearningProgress,
  LLMRoutingReason,
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

function recencyBoost(timestamp: number): number {
  const ageHours = Math.max(0, Date.now() - timestamp) / (60 * 60 * 1000);
  if (!Number.isFinite(ageHours)) return 0;
  return Math.max(0, 1 - Math.min(ageHours / 168, 1) * 0.35);
}

function rankFrom(sourceType: UnifiedRecallSourceType, timestamp: number, base = 0): number {
  return Number((base + sourceWeight(sourceType) * 0.7 + recencyBoost(timestamp) * 0.3).toFixed(4));
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
        status: input.playbookReinforced ? "done" : input.outcome === "failure" ? "skipped" : "pending",
        title: "Playbook reinforced",
        summary: input.playbookReinforced
          ? "Successful pattern was reinforced for future reuse."
          : input.outcome === "failure"
            ? "No reinforcement because the task did not succeed."
            : "Playbook reinforcement is pending confirmation.",
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

  static collectUnifiedRecall(
    deps: RecallRepositories,
    query: UnifiedRecallQuery & { workspacePath?: string },
  ): UnifiedRecallResponse {
    const workspaceId = normalizeText(query.workspaceId) || undefined;
    const normalizedQuery = normalizeText(query.query);
    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const wantedSources = new Set<UnifiedRecallSourceType>(query.sourceTypes || []);
    const includeAllSources = wantedSources.size === 0;
    const sourceAllowed = (source: UnifiedRecallSourceType): boolean =>
      includeAllSources || wantedSources.has(source);

    const results: UnifiedRecallResult[] = [];
    const seen = new Set<string>();
    const queryLower = normalizedQuery.toLowerCase();
    const matchesQuery = (text: string): boolean =>
      !queryLower || text.toLowerCase().includes(queryLower);

    const addResult = (result: UnifiedRecallResult): void => {
      const key = `${result.sourceType}:${result.objectId}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push(result);
    };

    if (workspaceId && sourceAllowed("memory")) {
      for (const mem of MemoryService.searchForPromptRecall(workspaceId, normalizedQuery, limit * 2)) {
        const snippet = truncate(mem.snippet || "", 260);
        if (!matchesQuery(snippet)) continue;
        addResult({
          sourceType: "memory",
          objectId: mem.id,
          workspaceId,
          taskId: mem.taskId,
          timestamp: mem.createdAt,
          rank: rankFrom("memory", mem.createdAt, mem.relevanceScore ?? 0),
          snippet,
          title: normalizeText(mem.type) || "Memory",
          sourceLabel: "Memory",
          metadata: { type: mem.type, relevanceScore: mem.relevanceScore },
        });
      }
    }

    if (workspaceId && query.workspacePath && sourceAllowed("workspace_note")) {
      for (const note of MemoryService.searchWorkspaceMarkdown(
        workspaceId,
        query.workspacePath,
        normalizedQuery,
        limit * 2,
      )) {
        const snippet = truncate(note.snippet || "", 260);
        if (!matchesQuery(snippet)) continue;
        addResult({
          sourceType: "workspace_note",
          objectId: note.id,
          workspaceId,
          timestamp: note.createdAt,
          rank: rankFrom("workspace_note", note.createdAt, note.relevanceScore ?? 0),
          snippet,
          title: normalizeText(note.type) || "Workspace note",
          sourceLabel: "Workspace note",
          metadata: {
            relevanceScore: note.relevanceScore,
            ...("path" in note ? { path: note.path } : {}),
          },
        });
      }
    }

    if (workspaceId && sourceAllowed("knowledge_graph")) {
      for (const entity of KnowledgeGraphService.search(workspaceId, normalizedQuery, limit * 2)) {
        const snippet = truncate(
          `${entity.entity.name}${entity.entity.description ? ` - ${entity.entity.description}` : ""}`,
          260,
        );
        if (!matchesQuery(snippet)) continue;
        addResult({
          sourceType: "knowledge_graph",
          objectId: entity.entity.id,
          workspaceId,
          timestamp: entity.entity.updatedAt,
          rank: rankFrom("knowledge_graph", entity.entity.updatedAt, entity.score),
          snippet,
          title: entity.entity.name,
          sourceLabel: "Knowledge graph",
          metadata: { entityType: entity.entity.entityTypeName, confidence: entity.entity.confidence },
        });
      }
    }

    if (workspaceId && query.workspacePath && sourceAllowed("screen_context")) {
      for (const observation of ChronicleObservationRepository.searchSync(
        query.workspacePath,
        normalizedQuery,
        limit * 2,
      )) {
        const snippet = truncate(
          [
            observation.appName,
            observation.windowTitle,
            observation.localTextSnippet || observation.query,
          ]
            .filter(Boolean)
            .join(" - "),
          260,
        );
        if (!matchesQuery(snippet)) continue;
        addResult({
          sourceType: "screen_context",
          objectId: observation.id,
          workspaceId: observation.workspaceId,
          taskId: observation.taskId,
          timestamp: observation.capturedAt,
          rank: rankFrom("screen_context", observation.capturedAt, observation.confidence),
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
        });
      }
    }

    const taskCandidates = deps.taskRepo.findByCreatedAtRange({
      startMs: Date.now() - 90 * 24 * 60 * 60 * 1000,
      endMs: Date.now(),
      limit: limit * 2,
      workspaceId,
      query: normalizedQuery,
    });

    if (sourceAllowed("task") || sourceAllowed("message") || sourceAllowed("file")) {
      const taskIds = taskCandidates.map((task) => task.id);
      const taskEvents =
        taskIds.length > 0 ? deps.eventRepo.findByTaskIds(taskIds) : [];
      const eventsByTask = new Map<string, any[]>();
      for (const event of taskEvents) {
        const list = eventsByTask.get(event.taskId) || [];
        list.push(event);
        eventsByTask.set(event.taskId, list);
      }

      for (const task of taskCandidates) {
        const taskText = `${task.title}\n${task.prompt}\n${task.resultSummary || ""}`;
        if (!matchesQuery(taskText)) continue;
        if (sourceAllowed("task")) {
          addResult({
            sourceType: "task",
            objectId: task.id,
            workspaceId: task.workspaceId,
            taskId: task.id,
            timestamp: task.updatedAt || task.createdAt,
            rank: rankFrom("task", task.updatedAt || task.createdAt, 1),
            snippet: getTaskSnippet(task),
            title: task.title,
            sourceLabel: "Task",
            metadata: { status: task.status, terminalStatus: task.terminalStatus },
          });
        }

        const taskEventsForTask = eventsByTask.get(task.id) || [];
        for (const event of taskEventsForTask) {
          const payload = asObject(event.payload);
          const message = getMessageText(payload);
          const filePath = normalizeText(payload.path || payload.filePath || payload.outputPath);
          const createdAt = event.timestamp || task.updatedAt || task.createdAt;
          if (sourceAllowed("message") && (event.type === "assistant_message" || event.type === "user_message")) {
            if (message && matchesQuery(message)) {
              addResult({
                sourceType: "message",
                objectId: `${task.id}:${event.id}`,
                workspaceId: task.workspaceId,
                taskId: task.id,
                timestamp: createdAt,
                rank: rankFrom("message", createdAt, 0.95),
                snippet: truncate(message, 260),
                title: event.type === "assistant_message" ? "Assistant message" : "User message",
                sourceLabel: "Message",
                metadata: { eventType: event.type },
              });
            }
          }
          if (sourceAllowed("file") && filePath) {
            if (matchesQuery(filePath) || matchesQuery(message)) {
              addResult({
                sourceType: "file",
                objectId: filePath,
                workspaceId: task.workspaceId,
                taskId: task.id,
                timestamp: createdAt,
                rank: rankFrom("file", createdAt, 0.9),
                snippet: truncate(message || filePath, 260),
                title: filePath,
                sourceLabel: "File",
                metadata: { eventType: event.type, path: filePath },
              });
            }
          }
        }
      }
    }

    if (workspaceId) {
      for (const activity of deps.activityRepo.list({ workspaceId, limit: limit * 2 })) {
        const text = `${activity.title}\n${activity.description || ""}`;
        if (!matchesQuery(text)) continue;
        addResult({
          sourceType: "message",
          objectId: activity.id,
          workspaceId,
          taskId: activity.taskId,
          timestamp: activity.createdAt,
          rank: rankFrom("message", activity.createdAt, 0.7),
          snippet: truncate(text, 260),
          title: activity.title,
          sourceLabel: "Activity",
          metadata: { activityType: activity.activityType, actorType: activity.actorType },
        });
      }
    }

    results.sort((a, b) => b.rank - a.rank || b.timestamp - a.timestamp);
    return {
      query: normalizedQuery,
      workspaceId,
      generatedAt: Date.now(),
      results: results.slice(0, limit),
    };
  }

  static buildRoutingState(
    settings: LLMSettings,
    options?: {
      task?: Pick<Task, "title" | "prompt" | "agentConfig" | "source" | "status">;
      isVerificationTask?: boolean;
    },
  ): LLMRoutingRuntimeState {
    const currentProvider = settings.providerType as any;
    const modelStatus = LLMProviderFactory.getProviderModelStatus(settings);
    const selection = LLMProviderFactory.resolveTaskModelSelection(options?.task?.agentConfig as any, {
      isVerificationTask: options?.isVerificationTask,
    });
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
