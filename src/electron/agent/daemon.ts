import { EventEmitter } from "events";
import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import { DatabaseManager } from "../database/schema";
import { ControlPlaneCoreService } from "../control-plane/ControlPlaneCoreService";
import type Database from "better-sqlite3";
import {
  TaskRepository,
  TaskEventRepository,
  WorkspaceRepository,
  ApprovalRepository,
  WorkspacePermissionRuleRepository,
  InputRequestRepository,
  ArtifactRepository,
  MemoryType,
} from "../database/repositories";
import { ActivityRepository } from "../activity/ActivityRepository";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { AgentTeamRepository } from "../agents/AgentTeamRepository";
import { AgentTeamMemberRepository } from "../agents/AgentTeamMemberRepository";
import { MentionRepository } from "../agents/MentionRepository";
import { buildAgentDispatchPrompt } from "../agents/agent-dispatch";
import { extractMentionedRoles } from "../agents/mentions";
import { selectAgentsForTask } from "../agents/capabilityMatcher";
import { recordLlmCallError, recordLlmCallSuccess } from "./llm/usage-telemetry";
import {
  Task,
  ApprovalResponseAction,
  ApprovalType,
  DEFAULT_TRUSTED_COMMAND_PATTERNS,
  SensitiveSourceRef,
  PermissionEffect,
  PermissionEvaluationResult,
  PermissionMode,
  PermissionPromptDetails,
  PermissionRule,
  TaskVerificationEvidenceBundle,
  TaskStatus,
  TaskEvent,
  EventType,
  TaskOutputSummary,
  IPC_CHANNELS,
  QueueSettings,
  QueueStatus,
  Workspace,
  WorkspacePermissions,
  AgentConfig,
  AgentType,
  ActivityActorType,
  ActivityType,
  CreateActivityRequest,
  Plan,
  BoardColumn,
  Activity,
  AgentMention,
  AgentRole,
  TeamThoughtEvent,
  isTempWorkspaceId,
  ImageAttachment,
  QuotedAssistantMessage,
  MULTI_LLM_PROVIDER_DISPLAY,
  AgentTeamRun,
  AgentTeamItem,
  StepFeedbackAction,
  TASK_ERROR_CODES,
  EvidenceRef,
  TimelineStage,
  VerificationOutcome,
  VerificationScope,
  VerificationEvidenceMode,
  InputRequest,
  InputRequestResponse,
  RequestUserInputArgs,
  Project,
  ProjectWorkspaceLink,
  Goal,
  Issue,
  IssueFilters,
  LLMProviderType,
  OrchestrationGraphRun,
  OrchestrationNodeNotification,
  WorkerRoleKind,
  VerificationVerdict,
} from "../../shared/types";
import { parseSpawnAgentCount } from "../../shared/spawn-intent-detection";
import { normalizeLlmProviderType } from "../../shared/llmProviderDisplay";
import {
  extractTimelineEvidenceRefs,
  inferTimelineStageForLegacyType,
  inferTimelineSubStageLabel,
  isTimelineEventType,
  normalizeTaskEventToTimelineV2,
} from "../../shared/timeline-v2";
import { deriveCanonicalTaskStatus, isTerminalTaskStatus } from "../../shared/task-status";
import { createTimelineEmitter } from "./timeline-emitter";
import { TaskExecutor } from "./executor";
import { TaskQueueManager } from "./queue-manager";
import { BuiltinToolsSettingsManager } from "./tools/builtin-settings";
import { ComputerUseSessionManager } from "../computer-use/session-manager";
import { decideTaskOutcome, getTaskBestKnownOutcome, hasSubstantiveOutcomeEvidence } from "./outcome-policy";
import { approvalIdempotency, taskIdempotency as _taskIdempotency, IdempotencyManager } from "../security/concurrency";
import { MemoryService } from "../memory/MemoryService";
import { GuardrailManager } from "../guardrails/guardrail-manager";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import {
  appendWorkspacePermissionManifestRule,
  loadWorkspacePermissionManifest,
} from "../security/workspace-permission-manifest";
import {
  permissionScopeFingerprint,
  summarizePermissionScope,
} from "../security/permission-utils";
import { buildPermissionSecurityContext } from "./security/export-permission-context";
import { PlaybookService } from "../memory/PlaybookService";
import { UserProfileService } from "../memory/UserProfileService";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import { AdaptiveStyleEngine } from "../memory/AdaptiveStyleEngine";
import { MemoryConsolidator } from "../memory/MemoryConsolidator";
import { TranscriptStore } from "../memory/TranscriptStore";
import { getAwarenessService } from "../awareness/AwarenessService";
import { PersonalityManager } from "../settings/personality-manager";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { IntentRoute, IntentRouter } from "./strategy/IntentRouter";
import { DerivedTaskStrategy, TaskStrategyService } from "./strategy/TaskStrategyService";
import {
  resolveDefaultWorkerRoleKind,
  resolveWorkerRoleAgentConfig,
  resolveWorkerRoleKind,
} from "./runtime/worker-role-registry";
import { createVerificationRuntime } from "./runtime/VerificationRuntime";
import type { AgentTeamOrchestrator } from "../agents/AgentTeamOrchestrator";
import { AgentTeamItemRepository } from "../agents/AgentTeamItemRepository";
import { AgentTeamRunRepository } from "../agents/AgentTeamRunRepository";
import {
  resolveOperationalAutonomyPolicy,
  buildAgentConfigFromAutonomyPolicy,
} from "../agents/autonomy-policy";
import { PermissionEngine } from "./runtime/PermissionEngine";
import { WorktreeManager } from "../git/WorktreeManager";
import type { ComparisonService } from "../git/ComparisonService";
import {
  deriveEntropySweepDecision,
  deriveReviewGateDecision,
  inferMutationFromSummary,
  resolveEntropySweepPolicy,
  resolveReviewPolicy,
  scoreTaskRisk,
} from "../eval/risk";
import { buildEntropySweepPrompt, collectBlastRadiusPaths } from "./post-task-entropy-sweep";
import { isAutomatedTaskLike } from "../../shared/automated-task-detection";
import { LLMProviderFactory } from "./llm/provider-factory";
import { OrchestrationGraphEngine, type OrchestrationGraphNodeInput } from "./orchestration/OrchestrationGraphEngine";
import { OrchestrationGraphRepository } from "./orchestration/OrchestrationGraphRepository";

// Memory management constants
const MAX_CACHED_EXECUTORS = 10; // Maximum number of completed task executors to keep in memory
const EXECUTOR_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes - time before completed executors are cleaned up

// Mid-conversation correction detection patterns.
// Regex-based (no LLM calls) to detect when a user is correcting the agent during a task.
const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(do it|try|use|make|that'?s not|wrong)\b/i,
  /\bthat'?s\s+wrong\b/i,
  /\bactually\s+i\s+meant\b/i,
  /\bnot\s+like\s+that\b/i,
  /\binstead\s+of\s+that\b/i,
  /\byou\s+should\s+have\b/i,
  /\bthe\s+correct\s+way\s+is\b/i,
  /\bdon'?t\s+do\s+that\b/i,
  /\bstop\b.*\binstead\b/i,
  /\bwrong\s+approach\b/i,
  /\bi\s+didn'?t\s+(mean|ask|want)\b/i,
  /\bnot\s+what\s+i\s+(meant|asked|wanted)\b/i,
];

function detectsCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function buildStructuredInputSelectionMessage(
  request: InputRequest,
  answers?: Record<string, { optionLabel?: string; otherText?: string }>,
): string {
  const normalizeText = (value: unknown): string =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const truncate = (value: string, maxChars: number): string =>
    value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;

  const answerMap = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};

  const lines = ["User selected structured input options:"];
  for (const question of request.questions) {
    const label = normalizeText(question.header) || normalizeText(question.question) || "Question";
    const answer = answerMap[question.id];
    const optionLabel = normalizeText(answer?.optionLabel);
    const otherText = normalizeText(answer?.otherText);

    let selection = optionLabel;
    if (selection && otherText) {
      selection = `${selection} — ${truncate(otherText, 160)}`;
    } else if (!selection) {
      selection = otherText;
    }

    lines.push(`- ${label}: ${truncate(selection || "no selection recorded", 220)}`);
  }

  return lines.join("\n");
}

// Activity throttling constants
const ACTIVITY_THROTTLE_WINDOW_MS = 2000; // 2 seconds - window for deduping similar activities
const THROTTLED_ACTIVITY_TYPES = new Set([
  "tool_call",
  "file_created",
  "file_modified",
  "file_deleted",
]);
const inputRequestIdempotency = new IdempotencyManager();

function parseBooleanEnv(envName: string, fallback = false): boolean {
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

const TASK_OVERRIDE_ALLOWLIST = new Set<keyof Task>([
  "assignedAgentRoleId",
  "workerRole",
  "heartbeatRunId",
  "issueId",
  "companyId",
  "goalId",
  "projectId",
  "requestDepth",
  "billingCode",
  "sessionId",
  "branchFromTaskId",
  "branchFromEventId",
  "branchLabel",
  "resumeStrategy",
]);

function sanitizeTaskOverrides(taskOverrides?: Partial<Task>): Partial<Task> | undefined {
  if (!taskOverrides) return undefined;
  const sanitized: Partial<Task> = {};
  const writableSanitized = sanitized as Record<keyof Task, Task[keyof Task]>;
  for (const [key, value] of Object.entries(taskOverrides) as Array<[keyof Task, Task[keyof Task]]>) {
    if (TASK_OVERRIDE_ALLOWLIST.has(key)) {
      writableSanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

interface CachedExecutor {
  executor: TaskExecutor;
  lastAccessed: number;
  status: "active" | "completed";
}

interface PendingApprovalEntry {
  taskId: string;
  approval: Any;
  resolve: (value: boolean) => void;
  reject: (reason?: unknown) => void;
  resolved: boolean;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

function getAllElectronWindows(): Any[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const BrowserWindow = electron?.BrowserWindow;
    if (BrowserWindow?.getAllWindows) {
      return BrowserWindow.getAllWindows();
    }
  } catch {
    // Not running under Electron (or Electron APIs unavailable).
  }
  return [];
}

/**
 * AgentDaemon is the core orchestrator that manages task execution
 * It coordinates between the database, task executors, and UI
 */
export class AgentDaemon extends EventEmitter {
  private static readonly RENDERER_SUPPRESSED_EVENT_TYPES = new Set([
    "log",
    "llm_usage",
    "task_analysis",
  ]);

  private taskRepo: TaskRepository;
  private eventRepo: TaskEventRepository;
  private workspaceRepo: WorkspaceRepository;
  private approvalRepo: ApprovalRepository;
  private workspacePermissionRuleRepo: WorkspacePermissionRuleRepository;
  private inputRequestRepo: InputRequestRepository;
  private artifactRepo: ArtifactRepository;
  private activityRepo: ActivityRepository;
  private agentRoleRepo: AgentRoleRepository;
  private mentionRepo: MentionRepository;
  private teamOrchestrator: AgentTeamOrchestrator | null = null;
  private orchestrationGraphEngine: OrchestrationGraphEngine;
  private activeTasks: Map<string, CachedExecutor> = new Map();
  private pendingApprovals: Map<string, PendingApprovalEntry> = new Map();
  private pendingInputRequests: Map<
    string,
    {
      taskId: string;
      resolve: (value: InputRequestResponse) => void;
      reject: (reason?: unknown) => void;
      resolved: boolean;
    }
  > = new Map();
  private cleanupIntervalHandle?: ReturnType<typeof setInterval>;
  private queueManager: TaskQueueManager;
  // Activity throttle: Map<taskId:eventType, lastTimestamp>
  private activityThrottle: Map<string, number> = new Map();
  private pendingRetries: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private retryCounts: Map<string, number> = new Map();
  private readonly maxTaskRetries = 2;
  private readonly retryDelayMs = 30 * 1000;
  /** Session-level auto-approve: when true, all approval requests are auto-granted.
   *  Set via IPC when the user clicks "Approve all" in the UI.
   *  Persists for the app lifetime (survives HMR/renderer reloads). */
  private sessionAutoApproveAll = false;
  /** Transient storage for images attached to task creation (not persisted to DB). */
  private pendingTaskImages: Map<string, ImageAttachment[]> = new Map();
  /**
   * Tasks queued via "Continue" after turn-limit exhaustion.
   * When dequeued, these must resume via continuation flow, not normal execution.
   */
  private pendingContinuationTaskIds: Set<string> = new Set();
  private pendingMemoryConsolidations: Set<string> = new Set();
  /** Git worktree manager for task isolation. */
  private worktreeManager: WorktreeManager;
  /** Comparison service for agent comparison mode. */
  private comparisonService: ComparisonService | null = null;
  private taskSeqById: Map<string, number> = new Map();
  private activeTimelineStageByTask: Map<string, TimelineStage> = new Map();
  private activeStepIdsByTask: Map<string, Set<string>> = new Map();
  private failedPlanStepsByTask: Map<string, Set<string>> = new Map();
  private timelineErrorsByTask: Map<string, Set<string>> = new Map();
  private knownPlanStepIdsByTask: Map<string, Set<string>> = new Map();
  private evidenceRefsByTask: Map<string, Map<string, EvidenceRef>> = new Map();
  private mediaPreviewMessagesByTask: Map<string, Set<string>> = new Map();
  private lastKnownLlmProviderByTask: Map<string, string> = new Map();
  private timelineMetrics = {
    totalEvents: 0,
    droppedEvents: 0,
    orderViolations: 0,
    stepStateMismatches: 0,
    completionGateBlocks: 0,
    evidenceGateFails: 0,
  };
  private completionTelemetryBackfilledTaskIds: Set<string> = new Set();
  private readonly verificationOutcomeV2Enabled: boolean;
  private static readonly TRANSIENT_RETRY_ERROR_REGEX =
    /^Transient provider error\.\s*Retry\s+\d+\/\d+\s+in\s+\d+s\./i;

  constructor(private dbManager: DatabaseManager) {
    super();
    const db = dbManager.getDatabase();
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.approvalRepo = new ApprovalRepository(db);
    this.workspacePermissionRuleRepo = new WorkspacePermissionRuleRepository(db);
    this.inputRequestRepo = new InputRequestRepository(db);
    this.artifactRepo = new ArtifactRepository(db);
    this.activityRepo = new ActivityRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
    this.mentionRepo = new MentionRepository(db);

    // Initialize queue manager with callbacks
    this.queueManager = new TaskQueueManager({
      startTaskImmediate: (task: Task) => this.startTaskImmediate(task),
      emitQueueUpdate: (status: QueueStatus) => this.emitQueueUpdate(status),
      getTaskById: (taskId: string) => this.taskRepo.findById(taskId),
      updateTaskStatus: (taskId: string, status: TaskStatus) =>
        this.taskRepo.update(taskId, { status }),
      onTaskTimeout: (taskId: string) => this.handleTaskTimeout(taskId),
    });
    this.verificationOutcomeV2Enabled =
      parseBooleanEnv("COWORK_VERIFICATION_OUTCOME_V2", false) ||
      parseBooleanEnv("verification_outcome_v2", false);

    // Initialize worktree manager
    this.worktreeManager = new WorktreeManager(db);
    this.orchestrationGraphEngine = new OrchestrationGraphEngine(db, {
      createChildTask: (params) => this.createChildTask(params),
      createRootTask: (params) =>
        this.createTask({
          title: params.title,
          prompt: params.prompt,
          workspaceId: params.workspaceId,
          agentConfig: params.agentConfig,
          source: params.source,
          taskOverrides: params.assignedAgentRoleId
            ? { assignedAgentRoleId: params.assignedAgentRoleId }
            : undefined,
        }),
      getTaskById: (taskId) => this.getTaskById(taskId),
      cancelTask: (taskId) => this.cancelTask(taskId),
      getActiveAgentRoles: () => this.getActiveAgentRoles(),
      emitRootEvent: (rootTaskId, eventType, payload) =>
        this.taskRepo.findById(rootTaskId)
          ? this.logEvent(rootTaskId, eventType as EventType, payload)
          : undefined,
    });
    this.orchestrationGraphEngine.on("node_notification", (notification) => {
      void this.handleOrchestrationNodeNotification(notification).catch((error) => {
        console.error("[AgentDaemon] Orchestration notification handling failed:", error);
      });
    });

    // Start periodic cleanup of old executors
    this.cleanupIntervalHandle = setInterval(() => this.cleanupOldExecutors(), 5 * 60 * 1000); // Run every 5 minutes
  }

  /** Get the worktree manager instance. */
  getWorktreeManager(): WorktreeManager {
    return this.worktreeManager;
  }

  /** Set the comparison service (initialized after daemon construction). */
  setComparisonService(service: ComparisonService): void {
    this.comparisonService = service;
  }

  /** Get the comparison service instance. */
  getComparisonService(): ComparisonService | null {
    return this.comparisonService;
  }

  getDatabase(): Database.Database {
    return this.dbManager.getDatabase();
  }

  getOrchestrationGraphEngine(): OrchestrationGraphEngine {
    return this.orchestrationGraphEngine;
  }

  getOrchestrationGraphRepository(): OrchestrationGraphRepository {
    return this.orchestrationGraphEngine.getRepository();
  }

  private isTransientRetryErrorMessage(message: unknown): boolean {
    return (
      typeof message === "string" &&
      AgentDaemon.TRANSIENT_RETRY_ERROR_REGEX.test(message.trim())
    );
  }

  setTeamOrchestrator(orchestrator: AgentTeamOrchestrator | null): void {
    this.teamOrchestrator = orchestrator;
  }

  getTeamOrchestrator(): AgentTeamOrchestrator | null {
    return this.teamOrchestrator;
  }

  private applyTaskWorkspaceOverrides(task: Task, workspace: Workspace): Workspace {
    if (task.agentConfig?.shellAccess !== true || workspace.permissions.shell === true) {
      return workspace;
    }
    return {
      ...workspace,
      permissions: {
        ...workspace.permissions,
        shell: true,
      },
    };
  }

  /**
   * Apply agent role configuration to the task before execution.
   *
   * Agent roles act like worker profiles. We apply role defaults only when the
   * task does not specify its own overrides.
   *
   * - Merge denied tools into AgentConfig.toolRestrictions (deny-wins)
   * - Apply provider/model/personality defaults
   */
  private applyAgentRoleOverrides(task: Task): { task: Task; changed: boolean } {
    const roleId = task.assignedAgentRoleId;
    if (!roleId) return { task, changed: false };

    const role = this.agentRoleRepo.findById(roleId);
    if (!role) return { task, changed: false };

    const nextAgentConfig: AgentConfig = task.agentConfig ? { ...task.agentConfig } : {};
    let changed = false;

    // Apply provider/model/personality defaults only when the task didn't override them.
    if (
      !nextAgentConfig.providerType &&
      typeof role.providerType === "string" &&
      role.providerType.trim().length > 0
    ) {
      nextAgentConfig.providerType = role.providerType.trim() as Any;
      changed = true;
    }

    if (
      !nextAgentConfig.modelKey &&
      typeof role.modelKey === "string" &&
      role.modelKey.trim().length > 0
    ) {
      nextAgentConfig.modelKey = role.modelKey.trim();
      changed = true;
    }

    if (
      !nextAgentConfig.personalityId &&
      typeof role.personalityId === "string" &&
      role.personalityId.trim().length > 0
    ) {
      nextAgentConfig.personalityId = role.personalityId.trim() as Any;
      changed = true;
    }

    const denied = role.toolRestrictions?.deniedTools;
    if (!Array.isArray(denied) || denied.length === 0) {
      // Fall through to autonomy merge
    } else {
      const merged = new Set<string>();

      const addAll = (values: unknown) => {
        if (!Array.isArray(values)) return;
        for (const raw of values) {
          const value = typeof raw === "string" ? raw.trim() : "";
          if (!value) continue;
          merged.add(value);
        }
      };

      addAll(nextAgentConfig.toolRestrictions);
      addAll(denied);

      if (merged.size > 0) {
        nextAgentConfig.toolRestrictions = Array.from(merged);
        changed = true;
      }
    }

    // Per-agent exec approval: when task is gateway-originated, apply agent role's autonomy policy
    // so run_command approvals follow the agent's configured allowlist/autoApproveTypes
    const isGatewayTask = typeof nextAgentConfig.originChannel === "string";
    if (isGatewayTask) {
      const autonomyPolicy = resolveOperationalAutonomyPolicy(role);
      const autonomyConfig = buildAgentConfigFromAutonomyPolicy(autonomyPolicy);
      if (Object.keys(autonomyConfig).length > 0) {
        if (
          nextAgentConfig.autonomousMode === undefined &&
          typeof autonomyConfig.autonomousMode === "boolean"
        ) {
          nextAgentConfig.autonomousMode = autonomyConfig.autonomousMode;
          changed = true;
        }
        if (
          !Array.isArray(nextAgentConfig.autoApproveTypes) &&
          Array.isArray(autonomyConfig.autoApproveTypes) &&
          autonomyConfig.autoApproveTypes.length > 0
        ) {
          nextAgentConfig.autoApproveTypes = autonomyConfig.autoApproveTypes;
          changed = true;
        }
      }
    }

    return { task: changed ? { ...task, agentConfig: nextAgentConfig } : task, changed };
  }

  private maybeCaptureMentionedAgentRoleIds(task: Task): void {
    if (task.parentTaskId) return;
    if ((task.agentType ?? "main") !== "main") return;
    if (
      Array.isArray(task.mentionedAgentRoleIds) &&
      task.mentionedAgentRoleIds.filter(Boolean).length > 0
    )
      return;

    try {
      const activeRoles = this.agentRoleRepo.findAll(false).filter((role) => role.isActive);
      if (activeRoles.length === 0) return;

      const mentioned = extractMentionedRoles(`${task.title}\n${task.prompt}`, activeRoles);
      const ids = mentioned.map((role) => role.id).filter(Boolean);
      if (ids.length === 0) return;

      this.taskRepo.update(task.id, { mentionedAgentRoleIds: ids });
      task.mentionedAgentRoleIds = ids;
    } catch (error) {
      console.warn("[AgentDaemon] Failed to capture mentioned agent roles:", error);
    }
  }

  private sameAgentConfig(a?: AgentConfig, b?: AgentConfig): boolean {
    return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
  }

  private deriveTaskStrategy(input: {
    title: string;
    prompt: string;
    routingPrompt?: string;
    agentConfig?: AgentConfig;
    lastProgressScore?: number;
  }): {
    route: IntentRoute;
    strategy: DerivedTaskStrategy;
    prompt: string;
    agentConfig: AgentConfig;
    promptChanged: boolean;
    agentConfigChanged: boolean;
  } {
    const route = IntentRouter.route(input.title, input.routingPrompt ?? input.prompt);
    const strategy = TaskStrategyService.derive(route, input.agentConfig, {
      title: input.title,
      prompt: input.prompt,
      lastProgressScore: input.lastProgressScore,
    });
    const agentConfig = TaskStrategyService.applyToAgentConfig(input.agentConfig, strategy);
    const hasExplicitModelOverride =
      typeof input.agentConfig?.modelKey === "string" && input.agentConfig.modelKey.trim().length > 0;
    if (hasExplicitModelOverride) {
      delete agentConfig.llmProfileHint;
    } else {
      agentConfig.llmProfileHint = strategy.llmProfileHint;
    }
    // Store detected intent for intent-based tool filtering
    agentConfig.taskIntent = route.intent;
    if (!agentConfig.taskDomain || agentConfig.taskDomain === "auto") {
      agentConfig.taskDomain = route.domain;
    }
    if (!agentConfig.executionMode) {
      agentConfig.executionMode = strategy.executionMode;
    }
    const relationshipContext = RelationshipMemoryService.buildPromptContext({
      maxPerLayer: 2,
      maxChars: 1200,
    });
    const prompt = TaskStrategyService.decoratePrompt(
      input.prompt,
      route,
      strategy,
      relationshipContext,
    );
    return {
      route,
      strategy,
      prompt,
      agentConfig,
      promptChanged: prompt !== input.prompt,
      agentConfigChanged: !this.sameAgentConfig(input.agentConfig, agentConfig),
    };
  }

  /**
   * Cron jobs run unattended. Keep the default "balanced" budget, but
   * escalate to "aggressive" for execution-heavy multi-source research prompts
   * that are likely to exceed the balanced web_search cap.
   */
  private resolveCronBudgetProfile(input: {
    title: string;
    prompt: string;
    route: IntentRoute;
  }): Task["budgetProfile"] {
    const executionLikeIntent =
      input.route.intent === "execution" ||
      input.route.intent === "mixed" ||
      input.route.intent === "workflow" ||
      input.route.intent === "deep_work";
    if (!executionLikeIntent) return "balanced";

    const text = `${String(input.title || "")}\n${String(input.prompt || "")}`.toLowerCase();
    const searchSignal =
      /\b(search|research|scan|look up|latest|breaking|news|trend|developments)\b/.test(text) ||
      /\bweb_search\b/.test(text);
    const sourceMentions = [
      "reddit",
      "x",
      "twitter",
      "tech news",
      "techcrunch",
      "the verge",
      "ars technica",
      "venturebeat",
      "reuters",
      "hacker news",
      "hn",
    ].filter((source) => text.includes(source)).length;
    const boundedWindowSignal =
      /\b(last|past|previous)\s+\d+\s*(hour|hours|day|days|week|weeks|month|months)\b/.test(text) ||
      /\b24-hour\b|\b24h\b|\blast-24h\b/.test(text);

    if ((searchSignal && sourceMentions >= 2) || (searchSignal && boundedWindowSignal)) {
      return "aggressive";
    }

    return "balanced";
  }

  private applyRuntimeTaskStrategy(task: Task): {
    task: Task;
    route: IntentRoute;
    strategy: DerivedTaskStrategy;
    promptChanged: boolean;
    agentConfigChanged: boolean;
  } {
    const derived = this.deriveTaskStrategy({
      title: task.title,
      prompt: task.prompt,
      routingPrompt: task.rawPrompt || task.userPrompt || task.prompt,
      agentConfig: task.agentConfig,
      lastProgressScore: task.lastProgressScore,
    });
    let nextAgentConfig = derived.agentConfig;
    let agentConfigChanged = derived.agentConfigChanged;

    // Reliability default: optionally auto-enable balanced review policy for code/operations tasks.
    // This stays opt-in to preserve backward compatibility.
    const autoReviewPolicyEnabled = parseBooleanEnv("COWORK_REVIEW_POLICY_ENABLE_AUTO", false);
    if (autoReviewPolicyEnabled && !nextAgentConfig.reviewPolicy) {
      if (derived.strategy.taskDomain === "code" || derived.strategy.taskDomain === "operations") {
        const configured = (process.env.COWORK_REVIEW_POLICY_AUTO_DEFAULT || "balanced")
          .trim()
          .toLowerCase();
        nextAgentConfig = {
          ...nextAgentConfig,
          reviewPolicy: configured === "strict" ? "strict" : "balanced",
        };
        agentConfigChanged = true;
      }
    }

    // Automated tasks (cron, improvement, heartbeat, etc.) use a dedicated model when
    // configured, or fall back to Cheap/Execution model when profile routing is enabled.
    const hasExplicitModelOverride =
      typeof nextAgentConfig.modelKey === "string" && nextAgentConfig.modelKey.trim().length > 0;
    if (
      isAutomatedTaskLike(task) &&
      !hasExplicitModelOverride &&
      !task.strategyLock
    ) {
      try {
        const settings = LLMProviderFactory.loadSettings();
        const providerType =
          (nextAgentConfig.providerType || settings.providerType) as LLMProviderType;
        const routing = LLMProviderFactory.getProviderRoutingSettings(settings, providerType);
        if (routing.automatedTaskModelKey) {
          nextAgentConfig = { ...nextAgentConfig, modelKey: routing.automatedTaskModelKey };
          delete nextAgentConfig.llmProfileHint;
          agentConfigChanged = true;
        } else if (routing.profileRoutingEnabled && routing.cheapModelKey) {
          nextAgentConfig = { ...nextAgentConfig, llmProfileHint: "cheap" };
          agentConfigChanged = true;
        }
      } catch {
        // Ignore; fall back to strategy-derived profile
      }
    }

    if (task.strategyLock) {
      return {
        task,
        route: derived.route,
        strategy: derived.strategy,
        promptChanged: false,
        agentConfigChanged: false,
      };
    }
    const nextTask: Task =
      derived.promptChanged || agentConfigChanged
        ? { ...task, prompt: derived.prompt, agentConfig: nextAgentConfig }
        : task;

    return {
      task: nextTask,
      route: derived.route,
      strategy: derived.strategy,
      promptChanged: derived.promptChanged,
      agentConfigChanged,
    };
  }

  /**
   * Initialize the daemon - call after construction to set up queue
   */
  async initialize(): Promise<void> {
    this.orchestrationGraphEngine.start();

    // Hard-switch migration: eagerly normalize active/incomplete task events to timeline v2.
    const activeAndIncompleteTasks = this.taskRepo.findByStatus([
      "queued",
      "planning",
      "executing",
      "interrupted",
      "paused",
      "blocked",
    ]);
    const eagerMigrationCount = this.eventRepo.migrateLegacyEventsForTasks(
      activeAndIncompleteTasks.map((task) => task.id),
    );
    if (eagerMigrationCount > 0) {
      console.log(`[AgentDaemon] Migrated ${eagerMigrationCount} legacy event(s) to timeline v2`);
    }
    for (const task of activeAndIncompleteTasks) {
      this.backfillTaskCompletionTelemetry(task.id);
      this.completionTelemetryBackfilledTaskIds.add(task.id);
    }

    const inconsistentPersistedTasks = activeAndIncompleteTasks.filter(
      (task) => deriveCanonicalTaskStatus(task) !== task.status,
    );
    if (inconsistentPersistedTasks.length > 0) {
      console.warn(
        `[AgentDaemon] Reconciling ${inconsistentPersistedTasks.length} task(s) with stale persisted lifecycle state`,
      );
      for (const task of inconsistentPersistedTasks) {
        this.taskRepo.update(task.id, {
          status: deriveCanonicalTaskStatus(task),
        });
      }
    }

    // Recover stale retry tasks that were incorrectly persisted as executing.
    // These should re-enter the queue on startup so retries can continue.
    const staleTransientRetryTasks = this.taskRepo
      .findByStatus("executing")
      .filter((task) => this.isTransientRetryErrorMessage(task.error));
    if (staleTransientRetryTasks.length > 0) {
      console.warn(
        `[AgentDaemon] Recovering ${staleTransientRetryTasks.length} stale transient-retry task(s) stuck in executing state`,
      );
      for (const task of staleTransientRetryTasks) {
        this.taskRepo.update(task.id, { status: "queued" });
        this.logEvent(task.id, "task_queued", {
          reason: "transient_retry_recovered",
          message:
            "Recovered stale transient-retry state after restart. Task re-queued automatically.",
        });
      }
    }

    // Find queued tasks from database for queue recovery
    const queuedTasks = this.taskRepo.findByStatus("queued");

    // Find tasks that were gracefully interrupted (app shutdown while running).
    // These have a conversation snapshot saved and can be resumed.
    const interruptedTasks = this.taskRepo.findByStatus("interrupted");

    // Find orphaned tasks from a crash / force-kill (still in planning/executing
    // without the explicit "interrupted" marker, e.g. Ctrl+C during npm run dev).
    // If they have a conversation snapshot saved from normal execution we can still
    // resume them; otherwise mark as failed.
    const orphanedTasks = this.taskRepo.findByStatus(["planning", "executing"]);

    const tasksToResume = interruptedTasks.filter((task) => {
      if (this.shouldResumeTaskOnStartup(task)) {
        return true;
      }
      this.skipStartupResume(task);
      return false;
    });

    if (orphanedTasks.length > 0) {
      console.log(
        `[AgentDaemon] Found ${orphanedTasks.length} orphaned task(s) from previous session`,
      );
      for (const task of orphanedTasks) {
        const events = this.getTaskEventsForReplay(task.id);
        const hasSnapshot = events.some((e) => this.isLegacyEventType(e, "conversation_snapshot"));
        const hasPlan = events.some(
          (e) => this.isLegacyEventType(e, "plan_created") && e.payload?.plan,
        );

        if (hasSnapshot || hasPlan) {
          if (!this.shouldResumeTaskOnStartup(task)) {
            this.skipStartupResume(task);
            continue;
          }
          // Recoverable: mark as interrupted and add to the resume list
          console.log(
            `[AgentDaemon] Orphaned task ${task.id} has saved state — scheduling for resume`,
          );
          this.taskRepo.update(task.id, {
            status: "interrupted" as TaskStatus,
            error:
              "Application exited unexpectedly while task was running - will resume on restart",
          });
          this.logEvent(task.id, "task_interrupted", {
            message: "Task interrupted by unexpected application exit. Will resume on restart.",
          });
          tasksToResume.push({ ...task, status: "interrupted" as TaskStatus });
        } else {
          // No saved state — unrecoverable
          console.log(
            `[AgentDaemon] Orphaned task ${task.id} has no saved state — marking as failed`,
          );
          this.failTask(
            task.id,
            "Task interrupted - application crashed before any progress was saved",
          );
        }
      }
    }

    // Initialize queue with queued tasks
    await this.queueManager.initialize(queuedTasks, []);

    // Resume all resumable tasks after a short delay to let the rest of the app
    // (IPC handlers, tray, cron, UI) finish initializing first.
    if (tasksToResume.length > 0) {
      console.log(`[AgentDaemon] ${tasksToResume.length} task(s) scheduled for resume`);
      setTimeout(() => {
        this.resumeInterruptedTasks(tasksToResume);
      }, 2000);
    }

    await this.orchestrationGraphEngine.resumeRunningRuns();
  }

  /**
   * Clean up old completed task executors to prevent memory leaks
   */
  private cleanupOldExecutors(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    let completedCount = 0;

    // Find executors to clean up
    this.activeTasks.forEach((cached, taskId) => {
      if (cached.status === "completed") {
        completedCount++;
        // Remove if older than TTL
        if (now - cached.lastAccessed > EXECUTOR_CACHE_TTL_MS) {
          toDelete.push(taskId);
        }
      }
    });

    // Also remove oldest completed executors if we have too many
    if (completedCount > MAX_CACHED_EXECUTORS) {
      const completedTasks = Array.from(this.activeTasks.entries())
        .filter(([_, cached]) => cached.status === "completed")
        .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

      const excessCount = completedCount - MAX_CACHED_EXECUTORS;
      for (let i = 0; i < excessCount; i++) {
        const [taskId] = completedTasks[i];
        if (!toDelete.includes(taskId)) {
          toDelete.push(taskId);
        }
      }
    }

    // Delete the marked executors
    for (const taskId of toDelete) {
      console.log(`[AgentDaemon] Cleaning up cached executor for task ${taskId}`);
      this.activeTasks.delete(taskId);
    }

    if (toDelete.length > 0) {
      console.log(
        `[AgentDaemon] Cleaned up ${toDelete.length} old executor(s). Active: ${this.activeTasks.size}`,
      );
    }
  }

  /**
   * Queue a task for execution
   * The task will either start immediately or be queued based on concurrency limits
   */
  async startTask(task: Task, images?: ImageAttachment[]): Promise<void> {
    // Store images transiently until the task starts executing
    if (images && images.length > 0) {
      this.pendingTaskImages.set(task.id, images);
    }
    await this.queueManager.enqueue(task);

    // If the task was queued (concurrency full), emit an explicit event so
    // remote gateways (WhatsApp/Telegram/etc) can inform the user instead of
    // appearing to "hang" silently.
    const refreshed = this.taskRepo.findById(task.id);
    if (refreshed?.status === "queued") {
      const status = this.queueManager.getStatus();
      const idx = status.queuedTaskIds.indexOf(task.id);
      const position = idx >= 0 ? idx + 1 : undefined;
      const message = position
        ? `⏳ Queued (position ${position}). I’ll start as soon as a slot is free.`
        : "⏳ Queued. I’ll start as soon as a slot is free.";
      this.logEvent(task.id, "task_queued", {
        position,
        reason: "concurrency",
        message,
      });
    }
  }

  /**
   * Start executing a task immediately (internal - called by queue manager)
   */
  async startTaskImmediate(task: Task): Promise<void> {
    console.log(`[AgentDaemon] Starting task ${task.id}: ${task.title}`);

    if (this.shouldStartAsQueuedContinuation(task)) {
      this.pendingContinuationTaskIds.delete(task.id);
      await this.startQueuedContinuation(task);
      return;
    }

    const { task: effectiveTask, changed: roleOverridesChanged } =
      this.applyAgentRoleOverrides(task);
    if (roleOverridesChanged) {
      try {
        this.taskRepo.update(effectiveTask.id, { agentConfig: effectiveTask.agentConfig });
      } catch (error) {
        console.warn("[AgentDaemon] Failed to persist agent role overrides:", error);
      }
    }

    // Ensure @mentions are recorded for deferred dispatch regardless of task creation entrypoint.
    this.maybeCaptureMentionedAgentRoleIds(effectiveTask);
    const runtimeStrategy = this.applyRuntimeTaskStrategy(effectiveTask);
    const executionTask = runtimeStrategy.task;
    if (runtimeStrategy.agentConfigChanged) {
      try {
        this.taskRepo.update(effectiveTask.id, { agentConfig: executionTask.agentConfig });
      } catch (error) {
        console.warn("[AgentDaemon] Failed to persist runtime strategy agent config:", error);
      }
    }
    if (runtimeStrategy.promptChanged || runtimeStrategy.agentConfigChanged) {
      this.logEvent(effectiveTask.id, "log", {
        message:
          `Execution strategy active: intent=${runtimeStrategy.route.intent}, ` +
          `domain=${runtimeStrategy.strategy.taskDomain}, convoMode=${runtimeStrategy.strategy.conversationMode}, ` +
          `execMode=${runtimeStrategy.strategy.executionMode}, answerFirst=${runtimeStrategy.strategy.answerFirst}, ` +
          `llmProfileHint=${runtimeStrategy.strategy.llmProfileHint}`,
      });
    }

    if (await this.maybeLaunchCollaborativeTask(executionTask)) {
      this.finishQueueSlot(executionTask.id);
      return;
    }

    const wasQueued = effectiveTask.status === "queued";
    if (wasQueued) {
      const isRetry = this.retryCounts.has(effectiveTask.id);
      const count = this.retryCounts.get(effectiveTask.id) ?? 0;
      const retrySuffix = isRetry ? ` (retry ${count}/${this.maxTaskRetries})` : "";
      this.logEvent(effectiveTask.id, "task_dequeued", {
        message: `▶️ Starting now${retrySuffix}.`,
      });
    }

    // Get workspace details
    const workspace = this.workspaceRepo.findById(executionTask.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${executionTask.workspaceId} not found`);
    }
    console.log(`[AgentDaemon] Workspace found: ${workspace.name}`);

    // === WORKTREE ISOLATION ===
    // If worktree isolation is enabled, create an isolated worktree for this task.
    // The executor gets a "virtual workspace" with the path swapped to the worktree directory.
    let effectiveWorkspace = this.applyTaskWorkspaceOverrides(executionTask, workspace);
    const requiresWorktree = executionTask.agentConfig?.requireWorktree === true;
    const canUseWorktree = await this.worktreeManager.shouldUseWorktree(
      workspace.path,
      workspace.isTemp,
      requiresWorktree,
    );
    if (requiresWorktree && !canUseWorktree) {
      const errorMessage =
        "Task requires git worktree isolation, but worktrees are unavailable for this workspace.";
      this.failTask(executionTask.id, errorMessage, {
        terminalStatus: "failed",
        failureClass: "dependency_unavailable",
      });
      this.logEvent(executionTask.id, "error", {
        message: errorMessage,
      });
      return;
    }
    if (canUseWorktree) {
      try {
        const worktreeInfo = await this.worktreeManager.createForTask(
          executionTask.id,
          executionTask.title,
          workspace.id,
          workspace.path,
        );

        // Create a virtual workspace pointing to the worktree
        effectiveWorkspace = {
          ...this.applyTaskWorkspaceOverrides(executionTask, workspace),
          path: worktreeInfo.worktreePath,
        };

        // Update task record with worktree metadata
        this.taskRepo.update(executionTask.id, {
          worktreePath: worktreeInfo.worktreePath,
          worktreeBranch: worktreeInfo.branchName,
          worktreeStatus: "active",
        });
        executionTask.worktreePath = worktreeInfo.worktreePath;
        executionTask.worktreeBranch = worktreeInfo.branchName;
        executionTask.worktreeStatus = "active";

        this.logEvent(executionTask.id, "worktree_created", {
          branch: worktreeInfo.branchName,
          path: worktreeInfo.worktreePath,
          baseBranch: worktreeInfo.baseBranch,
          message: `Working on branch "${worktreeInfo.branchName}" in isolated worktree.`,
        });
        console.log(
          `[AgentDaemon] Worktree created: branch=${worktreeInfo.branchName}, path=${worktreeInfo.worktreePath}`,
        );
      } catch (error: Any) {
        if (requiresWorktree) {
          const errorMessage = `Worktree creation failed: ${error.message}`;
          this.failTask(executionTask.id, errorMessage, {
            terminalStatus: "failed",
            failureClass: "dependency_unavailable",
          });
          this.logEvent(executionTask.id, "error", {
            message: errorMessage,
          });
          return;
        }
        // Non-fatal: fall back to shared workspace
        console.error(
          `[AgentDaemon] Worktree creation failed for task ${executionTask.id}:`,
          error,
        );
        this.logEvent(executionTask.id, "log", {
          message: `Worktree creation failed: ${error.message}. Using shared workspace.`,
        });
      }
    }

    // Create task executor - wrapped in try-catch to handle provider initialization errors
    let executor: TaskExecutor;
    try {
      console.log(`[AgentDaemon] Creating TaskExecutor...`);
      executor = new TaskExecutor(executionTask, effectiveWorkspace, this);
      // Attach any images that were provided at task creation time
      const initialImages = this.pendingTaskImages.get(executionTask.id);
      if (initialImages && initialImages.length > 0) {
        executor.setInitialImages(initialImages);
        this.pendingTaskImages.delete(executionTask.id);
      }
      console.log(`[AgentDaemon] TaskExecutor created successfully`);
    } catch (error: Any) {
      console.error(`[AgentDaemon] Task ${effectiveTask.id} failed to initialize:`, error);
      this.failTask(
        effectiveTask.id,
        error.message || "Failed to initialize task executor",
      );
      this.pendingTaskImages.delete(effectiveTask.id);
      this.logEvent(effectiveTask.id, "error", { error: error.message });
      return;
    }

    this.activeTasks.set(effectiveTask.id, {
      executor,
      lastAccessed: Date.now(),
      status: "active",
    });

    // Update task status
    this.taskRepo.update(effectiveTask.id, { status: "planning", error: undefined });
    this.logEvent(effectiveTask.id, "task_created", { task: executionTask });
    console.log(`[AgentDaemon] Task status updated to 'planning', starting execution...`);

    const guardrails = GuardrailManager.loadSettings();
    MemoryService.applyExecutionSideChannelPolicy(
      guardrails.sideChannelDuringExecution,
      guardrails.sideChannelMaxCallsPerWindow,
    );

    // Start execution (non-blocking)
    executor
      .execute()
      .then(() => {
        MemoryService.clearExecutionSideChannelPolicy();
        // After execution completes, process any follow-ups that were queued
        // while the executor was running but arrived too late for the loop to pick up.
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      })
      .catch((error) => {
        MemoryService.clearExecutionSideChannelPolicy();
        console.error(`[AgentDaemon] Task ${effectiveTask.id} execution failed:`, error);
        this.failTask(effectiveTask.id, error.message);
        this.logEvent(effectiveTask.id, "error", { error: error.message });
        this.activeTasks.delete(effectiveTask.id);
        // Even on failure, process orphaned follow-ups so they aren't silently lost
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      });
  }

  /**
   * Resume tasks that were interrupted by a previous graceful app shutdown.
   * Called from initialize() after a short delay to let the app finish starting.
   */
  private async resumeInterruptedTasks(tasks: Task[]): Promise<void> {
    for (const task of tasks) {
      try {
        console.log(`[AgentDaemon] Resuming interrupted task ${task.id}: ${task.title}`);
        await this.resumeInterruptedTask(task);
      } catch (error: Any) {
        console.error(`[AgentDaemon] Failed to resume task ${task.id}:`, error);
        this.failTask(task.id, `Failed to resume after interruption: ${error.message}`);
        this.logEvent(task.id, "error", {
          message: `Failed to resume interrupted task: ${error.message}`,
        });
      }
    }
  }

  private shouldResumeTaskOnStartup(task: Task): boolean {
    const title = String(task.title || "").trim();
    const source = String(task.source || "manual").trim().toLowerCase();
    if (source === "hook") return false;
    if (source === "subconscious") return false;
    if (task.parentTaskId) return false;
    if (task.agentType === "sub" || task.agentType === "parallel") return false;
    if (task.agentConfig?.collaborativeMode || task.agentConfig?.multiLlmMode) return false;
    if (/^heartbeat:/i.test(title)) return false;
    if (/^routine prep:/i.test(title)) return false;
    return true;
  }

  private skipStartupResume(task: Task): void {
    const current = this.taskRepo.findById(task.id);
    if (!current) return;
    if (current.status !== "interrupted" && current.status !== "planning" && current.status !== "executing") {
      return;
    }
    this.cancelTaskRecord(
      task.id,
      "Skipped automatic resume for background, collaborative, or system task after restart.",
      {
        errorMessage:
          "Skipped automatic resume for background, collaborative, or system task after restart.",
      },
    );
  }

  /**
   * Resume a single interrupted task by reconstructing the executor from saved
   * conversation snapshots and plan events, then continuing execution.
   */
  private async resumeInterruptedTask(task: Task): Promise<void> {
    // Guard against double-resume (e.g. rapid restarts)
    const currentTask = this.taskRepo.findById(task.id);
    if (!currentTask || currentTask.status !== "interrupted") {
      console.log(
        `[AgentDaemon] Task ${task.id} is no longer interrupted (status: ${currentTask?.status}), skipping resume`,
      );
      return;
    }

    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${task.workspaceId} not found - cannot resume task`);
    }

    // Fetch all events for this task
    const events = this.getTaskEventsForReplay(task.id);

    // Check if we have meaningful state to restore from
    const hasSnapshot = events.some((e) => this.isLegacyEventType(e, "conversation_snapshot"));
    const planEvent = events.filter((e) => this.isLegacyEventType(e, "plan_created")).pop();
    const hasPlan = planEvent && planEvent.payload?.plan;

    if (!hasSnapshot && !hasPlan) {
      // Task was interrupted very early (during planning, before any meaningful state).
      // Re-queue it to start from scratch.
      console.log(
        `[AgentDaemon] Task ${task.id} has no snapshot or plan - restarting from scratch`,
      );
      this.taskRepo.update(task.id, { status: "queued", error: undefined });
      this.logEvent(task.id, "log", {
        message: "Task interrupted before meaningful progress. Restarting from scratch.",
      });
      await this.queueManager.enqueue(task);
      return;
    }

    // Apply agent role overrides (same as startTaskImmediate)
    const { task: effectiveTask } = this.applyAgentRoleOverrides(task);

    // Handle worktree workspace if applicable
    let effectiveWorkspace = this.applyTaskWorkspaceOverrides(effectiveTask, workspace);
    if (task.worktreePath && task.worktreeStatus === "active") {
      if (fs.existsSync(task.worktreePath)) {
        effectiveWorkspace = {
          ...this.applyTaskWorkspaceOverrides(effectiveTask, workspace),
          path: task.worktreePath,
        };
      } else {
        console.warn(
          `[AgentDaemon] Worktree path ${task.worktreePath} no longer exists for task ${task.id}`,
        );
      }
    }

    // Create new executor and restore conversation state
    const executor = new TaskExecutor(effectiveTask, effectiveWorkspace, this);
    executor.rebuildConversationFromEvents(events);

    // Reconstruct the Plan from events with correct step statuses
    if (hasPlan) {
      const rawPlan = planEvent!.payload.plan as Plan;
      const completedStepIds = new Set<string>();
      const failedStepIds = new Set<string>();
      for (const event of events) {
        if (this.isLegacyEventType(event, "step_completed") && event.payload?.step?.id) {
          completedStepIds.add(event.payload.step.id);
        }
        if (this.isLegacyEventType(event, "step_failed") && event.payload?.step?.id) {
          failedStepIds.add(event.payload.step.id);
        }
      }
      const restoredPlan: Plan = {
        description: rawPlan.description,
        steps: rawPlan.steps.map((step) => ({
          ...step,
          status: completedStepIds.has(step.id)
            ? ("completed" as const)
            : failedStepIds.has(step.id)
              ? ("failed" as const)
              : ("pending" as const),
        })),
      };
      executor.setPlan(restoredPlan);
    }

    // Register in active tasks map
    this.activeTasks.set(effectiveTask.id, {
      executor,
      lastAccessed: Date.now(),
      status: "active",
    });

    // Register with queue manager for concurrency limits and timeout tracking.
    // If the concurrency limit is already reached, the task is re-queued and
    // will start automatically when a slot opens up.
    const canRun = this.queueManager.registerResumedTask(effectiveTask.id);
    if (!canRun) {
      // Clean up the executor we just created — it will be rebuilt when the
      // task is dequeued via the normal startTaskImmediate path.
      this.activeTasks.delete(effectiveTask.id);
      this.taskRepo.update(effectiveTask.id, { status: "queued" });
      this.logEvent(effectiveTask.id, "task_queued", {
        reason: "concurrency",
        message:
          "⏳ Queued — concurrency limit reached during resume. Will start when a slot opens.",
      });
      return;
    }

    // Update status and log resumption
    this.taskRepo.update(effectiveTask.id, {
      status: "executing",
      error: undefined,
    });
    this.logEvent(effectiveTask.id, "task_resumed", {
      message: "Resuming task after application restart",
      hadSnapshot: hasSnapshot,
      hadPlan: !!hasPlan,
    });

    const guardrails = GuardrailManager.loadSettings();
    MemoryService.applyExecutionSideChannelPolicy(
      guardrails.sideChannelDuringExecution,
      guardrails.sideChannelMaxCallsPerWindow,
    );

    // Start execution (non-blocking, same pattern as startTaskImmediate)
    executor
      .resumeAfterInterruption()
      .then(() => {
        MemoryService.clearExecutionSideChannelPolicy();
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      })
      .catch((error) => {
        MemoryService.clearExecutionSideChannelPolicy();
        console.error(`[AgentDaemon] Resumed task ${effectiveTask.id} failed:`, error);
        this.failTask(effectiveTask.id, error.message);
        this.logEvent(effectiveTask.id, "error", { error: error.message });
        this.activeTasks.delete(effectiveTask.id);
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      });
  }

  /**
   * Continue a failed task that was stopped due to budget/limit exhaustion.
   * Reconstructs the executor from persisted events, resets budgets, and
   * resumes execution from where the plan left off.
   */
  private isTurnLimitContinuationEligible(task: Task, events: TaskEvent[]): boolean {
    const latestErrorEvent = [...events]
      .reverse()
      .find((event) => this.isLegacyEventType(event, "error"));
    if (latestErrorEvent) {
      const errorCode = latestErrorEvent.payload?.errorCode;
      const actionHintType = latestErrorEvent.payload?.actionHint?.type;
      if (
        errorCode === TASK_ERROR_CODES.TURN_LIMIT_EXCEEDED ||
        actionHintType === "continue_task"
      ) {
        return true;
      }

      const latestErrorText =
        latestErrorEvent.payload?.message ||
        latestErrorEvent.payload?.error ||
        latestErrorEvent.payload?.detail ||
        "";
      return /Global turn limit exceeded/i.test(String(latestErrorText));
    }

    // Backward compatibility for older tasks that predate structured error metadata.
    return /Global turn limit exceeded/i.test(String(task.error || ""));
  }

  private shouldStartAsQueuedContinuation(task: Task): boolean {
    if (this.pendingContinuationTaskIds.has(task.id)) {
      return true;
    }
    if (task.status !== "queued") {
      return false;
    }

    const events = this.getTaskEventsForReplay(task.id);
    const latestQueueEvent = [...events]
      .reverse()
      .find((event) => this.isLegacyEventType(event, "task_queued"));
    const wasQueuedForContinuation =
      latestQueueEvent?.payload?.reason === "continuation_concurrency";
    if (!wasQueuedForContinuation) {
      return false;
    }

    return this.isTurnLimitContinuationEligible(task, events);
  }

  private buildContinuationPlan(rawPlan: Plan, events: TaskEvent[]): Plan {
    const terminalStatusByStep = new Map<string, "completed" | "skipped">();
    for (const event of events) {
      const stepId = event.payload?.step?.id;
      if (!stepId) continue;
      if (this.isLegacyEventType(event, "step_completed")) {
        terminalStatusByStep.set(stepId, "completed");
      } else if (this.isLegacyEventType(event, "step_skipped")) {
        terminalStatusByStep.set(stepId, "skipped");
      }
    }

    return {
      description: rawPlan.description,
      steps: rawPlan.steps.map((step) => ({
        ...step,
        status: terminalStatusByStep.get(step.id) ?? ("pending" as const),
      })),
    };
  }

  private createContinuationExecutor(
    task: Task,
    events: TaskEvent[],
  ): { effectiveTask: Task; executor: TaskExecutor } {
    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${task.workspaceId} not found`);
    }

    const planEvent = events.filter((e) => this.isLegacyEventType(e, "plan_created")).pop();
    if (!planEvent?.payload?.plan) {
      throw new Error(
        `Task ${task.id} cannot be continued because no execution plan could be restored`,
      );
    }

    const { task: effectiveTask } = this.applyAgentRoleOverrides(task);

    let effectiveWorkspace = workspace;
    if (task.worktreePath && task.worktreeStatus === "active" && fs.existsSync(task.worktreePath)) {
      effectiveWorkspace = { ...workspace, path: task.worktreePath };
    }

    const executor = new TaskExecutor(effectiveTask, effectiveWorkspace, this);
    executor.rebuildConversationFromEvents(events);

    const rawPlan = planEvent.payload.plan as Plan;
    executor.setPlan(this.buildContinuationPlan(rawPlan, events));

    return { effectiveTask, executor };
  }

  private launchContinuationExecution(effectiveTask: Task, executor: TaskExecutor): void {
    const guardrails = GuardrailManager.loadSettings();
    MemoryService.applyExecutionSideChannelPolicy(
      guardrails.sideChannelDuringExecution,
      guardrails.sideChannelMaxCallsPerWindow,
    );
    executor
      .continueAfterBudgetExhausted()
      .then(() => {
        MemoryService.clearExecutionSideChannelPolicy();
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      })
      .catch((error) => {
        MemoryService.clearExecutionSideChannelPolicy();
        console.error(`[AgentDaemon] Continued task ${effectiveTask.id} failed:`, error);
        this.failTask(effectiveTask.id, error.message);
        if (
          !this.hasRecentEquivalentErrorEvent(
            effectiveTask.id,
            error.message,
            undefined,
            (error as Any)?.terminal_failure_fingerprint,
          )
        ) {
          this.logEvent(effectiveTask.id, "error", { error: error.message });
        }
        this.activeTasks.delete(effectiveTask.id);
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      });
  }

  private hasRecentEquivalentErrorEvent(
    taskId: string,
    message: string,
    windowMs = 10_000,
    fingerprint?: string,
  ): boolean {
    const normalized = String(message || "").trim();
    if (!normalized) return false;
    const now = Date.now();
    const events = this.getTaskEventsForReplay(taskId);
    const latestError = [...events].reverse().find((event) => this.isLegacyEventType(event, "error"));
    if (!latestError || now - (latestError.timestamp || 0) > windowMs) {
      return false;
    }
    const payload = latestError.payload && typeof latestError.payload === "object" ? latestError.payload : {};
    const latestMessage =
      typeof (payload as Any).message === "string"
        ? String((payload as Any).message)
        : typeof (payload as Any).error === "string"
          ? String((payload as Any).error)
          : "";
    const latestFingerprint =
      typeof (payload as Any).terminal_failure_fingerprint === "string"
        ? String((payload as Any).terminal_failure_fingerprint)
        : "";
    if (fingerprint && latestFingerprint && latestFingerprint === fingerprint) {
      return true;
    }
    return latestMessage.trim() === normalized;
  }

  private async startQueuedContinuation(task: Task): Promise<void> {
    console.log(`[AgentDaemon] Starting queued continuation for task ${task.id}: ${task.title}`);
    const events = this.getTaskEventsForReplay(task.id);
    if (!this.isTurnLimitContinuationEligible(task, events)) {
      this.failTask(
        task.id,
        "Task can no longer be continued because latest failure is not turn-limit exhaustion.",
      );
      this.logEvent(task.id, "error", {
        error: "Queued continuation was rejected because latest task error is not turn-limit.",
      });
      return;
    }

    let effectiveTask: Task;
    let executor: TaskExecutor;
    try {
      ({ effectiveTask, executor } = this.createContinuationExecutor(task, events));
    } catch (error: Any) {
      const message = error?.message || String(error);
      this.failTask(task.id, message);
      this.logEvent(task.id, "error", { error: message });
      return;
    }

    this.activeTasks.set(effectiveTask.id, {
      executor,
      lastAccessed: Date.now(),
      status: "active",
    });

    this.taskRepo.update(effectiveTask.id, {
      status: "executing",
      error: undefined,
      completedAt: undefined,
    });
    this.logEvent(effectiveTask.id, "task_resumed", {
      message: "Continuing task after queue wait (turn-limit continuation)",
    });

    this.launchContinuationExecution(effectiveTask, executor);
  }

  async continueTask(taskId: string): Promise<void> {
    // Guard against double-click: if the task is already running, bail out
    if (this.activeTasks.has(taskId)) {
      console.log(`[AgentDaemon] Task ${taskId} is already active, ignoring continue request`);
      return;
    }

    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (task.status !== "failed") {
      throw new Error(`Task ${taskId} is not in failed status (current: ${task.status})`);
    }
    // Fetch all events for this task
    const events = this.getTaskEventsForReplay(taskId);
    if (!this.isTurnLimitContinuationEligible(task, events)) {
      throw new Error(
        `Task ${taskId} cannot be continued because it was not stopped by turn-limit exhaustion`,
      );
    }

    const { effectiveTask, executor } = this.createContinuationExecutor(task, events);

    // Register in active tasks map
    this.activeTasks.set(effectiveTask.id, {
      executor,
      lastAccessed: Date.now(),
      status: "active",
    });

    // Register with queue manager for concurrency limits and timeout tracking.
    const canRun = this.queueManager.registerResumedTask(effectiveTask.id);
    if (!canRun) {
      this.activeTasks.delete(effectiveTask.id);
      this.pendingContinuationTaskIds.add(effectiveTask.id);
      this.taskRepo.update(effectiveTask.id, { status: "queued" });
      this.logEvent(effectiveTask.id, "task_queued", {
        reason: "continuation_concurrency",
        message:
          "Queued — concurrency limit reached. Continuation will resume automatically when a slot opens.",
      });
      return;
    }

    // Update status and log continuation
    this.taskRepo.update(effectiveTask.id, {
      status: "executing",
      error: undefined,
      completedAt: undefined,
    });
    this.logEvent(effectiveTask.id, "task_resumed", {
      message: "Continuing task after budget/limit exhaustion",
    });

    this.launchContinuationExecution(effectiveTask, executor);
  }

  async forkTaskSession(params: {
    taskId: string;
    prompt?: string;
    branchLabel?: string;
    fromEventId?: string;
  }): Promise<Task> {
    const sourceTask = this.taskRepo.findById(params.taskId);
    if (!sourceTask) {
      throw new Error(`Task ${params.taskId} not found`);
    }
    const branchLabel =
      typeof params.branchLabel === "string" && params.branchLabel.trim().length > 0
        ? params.branchLabel.trim()
        : `fork-${new Date().toISOString().slice(11, 19).replace(/:/g, "-")}`;
    const nextPrompt =
      typeof params.prompt === "string" && params.prompt.trim().length > 0
        ? params.prompt.trim()
        : sourceTask.userPrompt || sourceTask.rawPrompt || sourceTask.prompt;

    const forkedTask = await this.createTask({
      title: `${sourceTask.title} (${branchLabel})`,
      prompt: nextPrompt,
      workspaceId: sourceTask.workspaceId,
      agentConfig: sourceTask.agentConfig,
      source: sourceTask.source || "manual",
      taskOverrides: {
        sessionId: crypto.randomUUID(),
        branchFromTaskId: sourceTask.id,
        branchFromEventId: params.fromEventId,
        branchLabel,
      },
    });

    this.logEvent(forkedTask.id, "log", {
      message: "Session fork created",
      sourceTaskId: sourceTask.id,
      branchLabel,
      branchFromEventId: params.fromEventId,
    });

    return forkedTask;
  }

  /**
   * Create a new task in the database and start it
   * This is a convenience method used by the cron service
   */
  async createTask(params: {
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig?: AgentConfig;
    budgetTokens?: number;
    budgetCost?: number;
    source?: Task["source"];
    taskOverrides?: Partial<Task>;
  }): Promise<Task> {
    const derived = this.deriveTaskStrategy({
      title: params.title,
      prompt: params.prompt,
      routingPrompt: params.prompt,
      agentConfig: params.agentConfig,
    });
    const isCronTask = params.source === "cron";
    const cronBudgetProfile = isCronTask
      ? this.resolveCronBudgetProfile({
          title: params.title,
          prompt: params.prompt,
          route: derived.route,
        })
      : undefined;
    const safeTaskOverrides = sanitizeTaskOverrides(params.taskOverrides);
    const task = this.taskRepo.create({
      title: params.title,
      prompt: derived.prompt,
      rawPrompt: params.prompt,
      status: "pending",
      workspaceId: params.workspaceId,
      agentConfig: derived.agentConfig,
      budgetTokens: params.budgetTokens,
      budgetCost: params.budgetCost,
      strategyLock: isCronTask,
      budgetProfile: cronBudgetProfile,
      ...(params.source ? { source: params.source } : {}),
      ...(safeTaskOverrides || {}),
    });
    const memoryFeatures = MemoryFeaturesManager.loadSettings();
    const rootLineageUpdates: Partial<Task> = {
      sessionId:
        typeof safeTaskOverrides?.sessionId === "string" && safeTaskOverrides.sessionId.trim().length > 0
          ? safeTaskOverrides.sessionId.trim()
          : task.id,
      resumeStrategy:
        safeTaskOverrides?.resumeStrategy ||
        (memoryFeatures.transcriptStoreEnabled ? "checkpoint" : "snapshot"),
      ...(safeTaskOverrides?.branchFromTaskId
        ? {
            branchFromTaskId: safeTaskOverrides.branchFromTaskId,
            branchFromEventId: safeTaskOverrides.branchFromEventId,
            branchLabel: safeTaskOverrides.branchLabel,
          }
        : {}),
    };
    this.taskRepo.update(task.id, rootLineageUpdates);
    Object.assign(task, rootLineageUpdates);
    this.logEvent(task.id, "log", {
      message:
        `Intent routed: ${derived.route.intent} | domain=${derived.route.domain} | ` +
        `convoMode=${derived.strategy.conversationMode} | execMode=${derived.strategy.executionMode}`,
      confidence: Number(derived.route.confidence.toFixed(2)),
      signals: derived.route.signals,
    });

    // Start the task (will be queued if necessary)
    await this.startTask(task);

    return task;
  }

  /**
   * Get a task by its ID
   */
  async getTaskById(taskId: string): Promise<Task | undefined> {
    return this.taskRepo.findById(taskId);
  }

  /**
   * Get all child tasks for a given parent task
   */
  async getChildTasks(parentTaskId: string): Promise<Task[]> {
    return this.taskRepo.findByParent(parentTaskId);
  }

  async createOrchestrationGraphRun(params: {
    rootTaskId: string;
    workspaceId: string;
    kind: OrchestrationGraphRun["kind"];
    maxParallel: number;
    metadata?: Record<string, unknown>;
    nodes: OrchestrationGraphNodeInput[];
    edges?: Array<{ fromNodeKey: string; toNodeKey: string }>;
  }) {
    return this.orchestrationGraphEngine.createRun(params);
  }

  async appendOrchestrationGraphNodes(params: {
    runId: string;
    nodes: OrchestrationGraphNodeInput[];
    edges?: Array<{ fromNodeId?: string; fromNodeKey?: string; toNodeId?: string; toNodeKey?: string }>;
  }) {
    return this.orchestrationGraphEngine.appendNodes(params);
  }

  getOrchestrationGraphSnapshot(runId: string) {
    return this.getOrchestrationGraphRepository().findSnapshotByRunId(runId);
  }

  findLatestOrchestrationGraphByRootTask(rootTaskId: string) {
    return this.getOrchestrationGraphRepository().findSnapshotByRootTaskId(rootTaskId);
  }

  listOrchestrationGraphsByRootTask(rootTaskId: string) {
    return this.getOrchestrationGraphRepository().listSnapshotsByRootTaskId(rootTaskId);
  }

  findOrchestrationGraphByTeamRunId(teamRunId: string) {
    return this.getOrchestrationGraphRepository().findSnapshotByTeamRunId(teamRunId);
  }

  findDelegatedNode(rootTaskId: string, handle: string) {
    return this.orchestrationGraphEngine.resolveHandle(rootTaskId, handle);
  }

  async waitForDelegatedNode(rootTaskId: string, handle: string, timeoutSeconds: number) {
    return this.orchestrationGraphEngine.waitForHandle(rootTaskId, handle, timeoutSeconds);
  }

  async cancelDelegatedNode(rootTaskId: string, handle: string): Promise<boolean> {
    return this.orchestrationGraphEngine.cancelHandle(rootTaskId, handle);
  }

  /**
   * Create a child task (sub-agent or parallel agent)
   */
  async createChildTask(params: {
    title: string;
    prompt: string;
    userPrompt?: string;
    workspaceId: string;
    parentTaskId: string;
    agentType: AgentType;
    agentConfig?: AgentConfig;
    depth?: number;
    assignedAgentRoleId?: string;
    workerRole?: WorkerRoleKind;
    boardColumn?: BoardColumn;
    priority?: number;
    budgetTokens?: number;
    budgetCost?: number;
  }): Promise<Task> {
    const parent = this.taskRepo.findById(params.parentTaskId);
    const parentGatewayContext = parent?.agentConfig?.gatewayContext;
    const childGatewayContext = params.agentConfig?.gatewayContext;
    const parentAutonomousMode = parent?.agentConfig?.autonomousMode === true;
    const mergedAutonomousMode =
      parentAutonomousMode || params.agentConfig?.autonomousMode === true;
    const mergedAllowUserInput = mergedAutonomousMode
      ? false
      : (params.agentConfig?.allowUserInput ?? parent?.agentConfig?.allowUserInput);

    // Prevent privilege escalation: a child task may not become "more private" than its parent.
    const mergedGatewayContext: AgentConfig["gatewayContext"] | undefined = (() => {
      const rank: Record<NonNullable<AgentConfig["gatewayContext"]>, number> = {
        private: 0,
        group: 1,
        public: 2,
      };
      const contexts = [parentGatewayContext, childGatewayContext].filter(
        (value): value is NonNullable<AgentConfig["gatewayContext"]> =>
          value === "private" || value === "group" || value === "public",
      );
      if (contexts.length === 0) return undefined;
      return contexts.sort((a, b) => rank[b] - rank[a])[0];
    })();

    // Prevent privilege escalation: tool restrictions are inherited and additive.
    const mergedToolRestrictions: string[] | undefined = (() => {
      const merged = new Set<string>();
      const addAll = (values: unknown) => {
        if (!Array.isArray(values)) return;
        for (const raw of values) {
          const value = typeof raw === "string" ? raw.trim() : "";
          if (!value) continue;
          merged.add(value);
        }
      };
      addAll(parent?.agentConfig?.toolRestrictions);
      addAll(params.agentConfig?.toolRestrictions);
      return merged.size > 0 ? Array.from(merged) : undefined;
    })();

    // Prevent privilege escalation for allow-lists:
    // if both parent and child specify allow-lists, child gets the intersection.
    // if only one side specifies allow-list, keep that scope.
    const allowlistMerge = (() => {
      const normalize = (values: unknown): Set<string> => {
        const set = new Set<string>();
        if (!Array.isArray(values)) return set;
        for (const raw of values) {
          const value = typeof raw === "string" ? raw.trim() : "";
          if (!value) continue;
          set.add(value);
        }
        return set;
      };

      const parentAllowlistRaw = parent?.agentConfig?.allowedTools;
      const childAllowlistRaw = params.agentConfig?.allowedTools;
      const parentAllowed = normalize(parentAllowlistRaw);
      const childAllowed = normalize(childAllowlistRaw);
      const parentHasAllowlist = Array.isArray(parentAllowlistRaw);
      const childHasAllowlist = Array.isArray(childAllowlistRaw);
      const parentAllowsAll = parentAllowed.has("*");
      const childAllowsAll = childAllowed.has("*");

      if (!parentHasAllowlist && !childHasAllowlist) {
        return {
          mergedAllowedTools: undefined as string[] | undefined,
          parentHasAllowlist,
          childHasAllowlist,
          parentAllowsAll,
          childAllowsAll,
          parentAllowlistSize: parentAllowed.size,
          childAllowlistSize: childAllowed.size,
        };
      }
      if (!parentHasAllowlist) {
        return {
          mergedAllowedTools: Array.from(childAllowed),
          parentHasAllowlist,
          childHasAllowlist,
          parentAllowsAll,
          childAllowsAll,
          parentAllowlistSize: parentAllowed.size,
          childAllowlistSize: childAllowed.size,
        };
      }
      if (!childHasAllowlist) {
        return {
          mergedAllowedTools: Array.from(parentAllowed),
          parentHasAllowlist,
          childHasAllowlist,
          parentAllowsAll,
          childAllowsAll,
          parentAllowlistSize: parentAllowed.size,
          childAllowlistSize: childAllowed.size,
        };
      }

      // Handle wildcard semantics before computing concrete intersections.
      // "*" means "allow all", not a literal tool name.
      let mergedAllowedTools: string[];
      if (parentAllowsAll && childAllowsAll) {
        mergedAllowedTools = ["*"];
      } else if (parentAllowsAll) {
        mergedAllowedTools = Array.from(childAllowed).filter((tool) => tool !== "*");
      } else if (childAllowsAll) {
        mergedAllowedTools = Array.from(parentAllowed).filter((tool) => tool !== "*");
      } else {
        mergedAllowedTools = Array.from(childAllowed).filter((tool) => parentAllowed.has(tool));
      }

      return {
        mergedAllowedTools,
        parentHasAllowlist,
        childHasAllowlist,
        parentAllowsAll,
        childAllowsAll,
        parentAllowlistSize: parentAllowed.size,
        childAllowlistSize: childAllowed.size,
      };
    })();
    const mergedAllowedTools = allowlistMerge.mergedAllowedTools;
    if (
      allowlistMerge.parentHasAllowlist &&
      allowlistMerge.childHasAllowlist &&
      Array.isArray(mergedAllowedTools) &&
      mergedAllowedTools.length === 0 &&
      !allowlistMerge.parentAllowsAll &&
      !allowlistMerge.childAllowsAll &&
      allowlistMerge.parentAllowlistSize > 0 &&
      allowlistMerge.childAllowlistSize > 0
    ) {
      throw new Error(
        "Cannot create child task: parent and child tool allow-lists have no overlap.",
      );
    }

    let mergedAgentConfig: AgentConfig | undefined = (() => {
      const next: AgentConfig = params.agentConfig ? { ...params.agentConfig } : {};
      if (mergedGatewayContext) {
        next.gatewayContext = mergedGatewayContext;
      }
      if (mergedToolRestrictions) {
        next.toolRestrictions = mergedToolRestrictions;
      }
      if (mergedAllowedTools) {
        next.allowedTools = mergedAllowedTools;
      }
      if (mergedAutonomousMode !== undefined) {
        next.autonomousMode = mergedAutonomousMode;
      }
      if (mergedAllowUserInput !== undefined) {
        next.allowUserInput = mergedAllowUserInput;
      }
      return Object.keys(next).length > 0 ? next : undefined;
    })();

    const workerRole = resolveWorkerRoleKind(params.workerRole) || resolveDefaultWorkerRoleKind();
    mergedAgentConfig = resolveWorkerRoleAgentConfig(workerRole, mergedAgentConfig);

    const task = this.taskRepo.create({
      title: params.title,
      prompt: params.prompt,
      rawPrompt: params.prompt,
      userPrompt: params.userPrompt,
      status: "pending",
      workspaceId: params.workspaceId,
      parentTaskId: params.parentTaskId,
      agentType: params.agentType,
      agentConfig: mergedAgentConfig,
      workerRole,
      depth: params.depth ?? 0,
      budgetTokens: params.budgetTokens,
      budgetCost: params.budgetCost,
    });
    // Apply agent squad metadata before starting so role context is available immediately.
    const memoryFeatures = MemoryFeaturesManager.loadSettings();
    const initialUpdates: Partial<Task> = {
      sessionId: parent?.sessionId || params.parentTaskId,
      branchFromTaskId: parent?.branchFromTaskId,
      branchFromEventId: parent?.branchFromEventId,
      branchLabel: parent?.branchLabel,
      resumeStrategy: memoryFeatures.transcriptStoreEnabled ? "checkpoint" : "snapshot",
    };
    if (
      typeof params.assignedAgentRoleId === "string" &&
      params.assignedAgentRoleId.trim().length > 0
    ) {
      initialUpdates.assignedAgentRoleId = params.assignedAgentRoleId.trim();
    }
    if (typeof params.boardColumn === "string" && params.boardColumn.trim().length > 0) {
      initialUpdates.boardColumn = params.boardColumn as BoardColumn;
    }
    if (typeof params.priority === "number" && Number.isFinite(params.priority)) {
      initialUpdates.priority = params.priority;
    }
    if (Object.keys(initialUpdates).length > 0) {
      this.taskRepo.update(task.id, initialUpdates);
      Object.assign(task, initialUpdates);
    }

    // Start the task (will be queued if necessary)
    await this.startTask(task);

    return task;
  }

  private buildPlanSummary(plan?: Plan): string | undefined {
    if (!plan) return undefined;
    const lines: string[] = [];
    if (plan.description) {
      lines.push(`Plan: ${plan.description}`);
    }
    if (plan.steps && plan.steps.length > 0) {
      lines.push("Steps:");
      const stepLines = plan.steps.slice(0, 7).map((step) => `- ${step.description}`);
      lines.push(...stepLines);
      if (plan.steps.length > 7) {
        lines.push(`- …and ${plan.steps.length - 7} more steps`);
      }
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  private emitActivityEvent(activity: Activity): void {
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, { type: "created", activity });
        }
      } catch (error) {
        console.error("[AgentDaemon] Error sending activity IPC:", error);
      }
    });
  }

  private emitMentionEvent(mention: AgentMention): void {
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.MENTION_EVENT, { type: "created", mention });
        }
      } catch (error) {
        console.error("[AgentDaemon] Error sending mention IPC:", error);
      }
    });
  }

  private emitTeamRunEvent(event: Any): void {
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.TEAM_RUN_EVENT, event);
        }
      } catch (error) {
        console.error("[AgentDaemon] Error sending team run IPC:", error);
      }
    });
  }

  private async maybeLaunchCollaborativeTask(task: Task): Promise<boolean> {
    if (!task.agentConfig?.collaborativeMode && !task.agentConfig?.multiLlmMode) {
      return false;
    }
    if (!this.teamOrchestrator) {
      throw new Error("Team orchestrator is not initialized");
    }

    this.taskRepo.update(task.id, { status: "executing", updatedAt: Date.now(), error: undefined });
    this.logEvent(task.id, "log", {
      message: task.agentConfig?.multiLlmMode
        ? "Launching multi-LLM collaborative run."
        : "Launching collaborative agent team run.",
    });

    const db = this.dbManager.getDatabase();
    const teamRepo = new AgentTeamRepository(db);
    const teamMemberRepo = new AgentTeamMemberRepository(db);
    const teamRunRepo = new AgentTeamRunRepository(db);
    const teamItemRepo = new AgentTeamItemRepository(db);
    const existingRun = teamRunRepo.findByRootTaskId(task.id);

    if (existingRun) {
      if (!teamRepo.findById(existingRun.teamId)) {
        throw new Error(`Collaborative team not found for run ${existingRun.id}`);
      }
      const updatedRun =
        existingRun.status !== "running"
          ? teamRunRepo.update(existingRun.id, {
              status: "running",
              error: null,
            })
          : existingRun;
      if (updatedRun && updatedRun !== existingRun) {
        this.emitTeamRunEvent({
          type: "team_run_updated",
          timestamp: Date.now(),
          run: updatedRun,
        });
      }
      void this.teamOrchestrator.tickRun(existingRun.id, "daemon_existing_collab_run");
      return true;
    }

    if (task.agentConfig.multiLlmMode && task.agentConfig.multiLlmConfig) {
      const config = task.agentConfig.multiLlmConfig;
      const participants = config.participants;
      const allRoles = this.agentRoleRepo.findAll(false).filter((role) => role.isActive);
      const sentinelRoleId = allRoles.length > 0 ? allRoles[0].id : undefined;
      if (!sentinelRoleId) {
        throw new Error("No agent role available to anchor multi-LLM run");
      }
      const maxParallelAgents =
        typeof config.maxParallelParticipants === "number" && config.maxParallelParticipants > 0
          ? Math.min(participants.length, Math.floor(config.maxParallelParticipants))
          : participants.length;
      const team = teamRepo.create({
        workspaceId: task.workspaceId,
        name: `MultiLLM-${Date.now()}`,
        description: `Programmatic multi-LLM comparison for: ${task.title}`,
        leadAgentRoleId: sentinelRoleId,
        maxParallelAgents,
      });
      const run = teamRunRepo.create({
        teamId: team.id,
        rootTaskId: task.id,
        status: "running",
        collaborativeMode: true,
        multiLlmMode: true,
      });
      for (let i = 0; i < participants.length; i++) {
        const participant = participants[i];
        teamItemRepo.create({
          teamRunId: run.id,
          title: participant.seatLabel || participant.displayName,
          description: task.prompt,
          ownerAgentRoleId: sentinelRoleId,
          status: "todo",
          sortOrder: (i + 1) * 10,
        });
      }
      this.emitTeamRunEvent({ type: "team_run_created", timestamp: Date.now(), run });
      void this.teamOrchestrator.tickRun(run.id, "daemon_programmatic_multi_llm");
      return true;
    }

    const activeRoles = this.agentRoleRepo.findAll(false).filter((role) => role.isActive);
    const fullText = `${task.title}\n${task.prompt}`;
    const requestedCount = parseSpawnAgentCount(fullText);
    const { members, leader } = await selectAgentsForTask(
      fullText,
      activeRoles,
      requestedCount ?? undefined,
    );
    const team = teamRepo.create({
      workspaceId: task.workspaceId,
      name: `Collab-${Date.now()}`,
      description: `Programmatic collaborative team for: ${task.title}`,
      leadAgentRoleId: leader.id,
      maxParallelAgents: members.length,
    });
    const run = teamRunRepo.create({
      teamId: team.id,
      rootTaskId: task.id,
      status: "running",
      collaborativeMode: true,
    });
    for (let i = 0; i < members.length; i++) {
      teamMemberRepo.add({
        teamId: team.id,
        agentRoleId: members[i].id,
        memberOrder: (i + 1) * 10,
        isRequired: true,
      });
      if (members[i].displayName === "Synthesis") continue;
      teamItemRepo.create({
        teamRunId: run.id,
        title: members[i].displayName,
        description: task.prompt,
        ownerAgentRoleId: members[i].id,
        status: "todo",
        sortOrder: (i + 1) * 10,
      });
    }
    this.emitTeamRunEvent({ type: "team_run_created", timestamp: Date.now(), run });
    void this.teamOrchestrator.tickRun(run.id, "daemon_programmatic_collab");
    return true;
  }

  /**
   * Dispatch mentioned agent roles after the main plan is created.
   * This avoids starting sub-agents before the task is clearly defined.
   */
  async dispatchMentionedAgents(taskId: string, plan?: Plan): Promise<void> {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.parentTaskId) return;

    const mentionedRoleIds = (task.mentionedAgentRoleIds || []).filter(Boolean);
    if (mentionedRoleIds.length === 0) return;

    const activeRoles = this.agentRoleRepo.findAll(false).filter((role) => role.isActive);
    const mentionedRoles = activeRoles.filter((role) => mentionedRoleIds.includes(role.id));
    if (mentionedRoles.length === 0) return;

    const existingChildren = this.taskRepo.findByParent(taskId);
    const assignedRoleIds = new Set(
      existingChildren
        .map((child) => child.assignedAgentRoleId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    const rolesToDispatch = mentionedRoles.filter((role) => !assignedRoleIds.has(role.id));
    if (rolesToDispatch.length === 0) return;

    const planSummary = this.buildPlanSummary(plan);

    // Compute file ownership zones to prevent overlapping output directories between agents.
    const roleZones = rolesToDispatch.map((role) => ({
      role: role.displayName,
      zone: `output/${role.displayName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`,
    }));

    for (const role of rolesToDispatch) {
      const workspacePath = task.workspaceId
        ? this.workspaceRepo.findById(task.workspaceId)?.path
        : undefined;

      const myZone = roleZones.find((z) => z.role === role.displayName);
      const peerZones = roleZones.filter((z) => z.role !== role.displayName);

      const childPrompt = buildAgentDispatchPrompt(
        role,
        { title: task.title, prompt: task.prompt },
        {
          ...(planSummary ? { planSummary } : {}),
          includeRoleDetails: false,
          includeRoleProfile: true,
          workspacePath,
          fileOwnershipZone: myZone?.zone,
          peerAgentZones: peerZones,
        },
      );
      const childTask = await this.createChildTask({
        title: `@${role.displayName}: ${task.title}`,
        prompt: childPrompt,
        userPrompt: task.prompt,
        workspaceId: task.workspaceId,
        parentTaskId: task.id,
        agentType: "sub",
        assignedAgentRoleId: role.id,
        boardColumn: "todo" as BoardColumn,
        agentConfig: {
          ...(role.providerType ? { providerType: role.providerType } : {}),
          ...(role.modelKey ? { modelKey: role.modelKey } : {}),
          ...(role.personalityId ? { personalityId: role.personalityId } : {}),
          ...(Array.isArray(role.toolRestrictions?.deniedTools) &&
          role.toolRestrictions!.deniedTools.length > 0
            ? { toolRestrictions: role.toolRestrictions!.deniedTools }
            : {}),
          retainMemory: false,
        },
      });

      const dispatchActivity = this.activityRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        agentRoleId: role.id,
        actorType: "system",
        activityType: "agent_assigned",
        title: `Dispatched to ${role.displayName}`,
        description: childTask.title,
      });
      this.emitActivityEvent(dispatchActivity);

      const mention = this.mentionRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        toAgentRoleId: role.id,
        mentionType: "request",
        context: `New task: ${task.title}`,
      });
      this.emitMentionEvent(mention);

      const mentionActivity = this.activityRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        agentRoleId: role.id,
        actorType: "user",
        activityType: "mention",
        title: `@${role.displayName} mentioned`,
        description: mention.context,
        metadata: { mentionId: mention.id, mentionType: mention.mentionType },
      });
      this.emitActivityEvent(mentionActivity);
    }
  }

  /**
   * Cancel a running or queued task
   */
  async cancelTask(taskId: string): Promise<void> {
    const existing = this.taskRepo.findById(taskId);
    if (!existing) {
      throw new Error(`Task ${taskId} not found`);
    }
    // Don't clobber terminal states.
    if (
      existing.status === "completed" ||
      existing.status === "failed" ||
      existing.status === "cancelled"
    ) {
      return;
    }
    this.pendingContinuationTaskIds.delete(taskId);

    // Check if task is queued (not yet started)
    if (this.queueManager.cancelQueuedTask(taskId)) {
      this.cancelTaskRecord(taskId, "Task removed from queue");
      this.pendingTaskImages.delete(taskId);
      // Cascade cancellation to child tasks even for queued parents
      const queuedChildren = this.taskRepo.findByParent(taskId);
      for (const child of queuedChildren) {
        if (
          child.status !== "completed" &&
          child.status !== "failed" &&
          child.status !== "cancelled"
        ) {
          await this.cancelTask(child.id);
        }
      }
      return;
    }

    // Task is running - cancel it
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      await cached.executor.cancel("user");
      this.activeTasks.delete(taskId);
    }

    // Persist cancellation for running tasks too (important for remote clients querying task status).
    this.cancelTaskRecord(taskId, "Task was stopped by user");

    // Always notify queue manager to remove from running set
    // (handles orphaned tasks that are in runningTaskIds but have no executor)
    this.finishQueueSlot(taskId);

    // Always emit cancelled event so UI updates
    this.pendingTaskImages.delete(taskId);

    // Cascade cancellation to all child tasks (agent sub-tasks)
    const children = this.taskRepo.findByParent(taskId);
    for (const child of children) {
      if (
        child.status !== "completed" &&
        child.status !== "failed" &&
        child.status !== "cancelled"
      ) {
        await this.cancelTask(child.id);
      }
    }
  }

  /**
   * Wrap up a task gracefully - signal the executor to finish with its current progress.
   * Unlike cancelTask, this produces a "completed" task, not a "cancelled" one.
   */
  async wrapUpTask(taskId: string): Promise<void> {
    const existing = this.taskRepo.findById(taskId);
    if (!existing) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Don't wrap up terminal tasks
    if (
      existing.status === "completed" ||
      existing.status === "failed" ||
      existing.status === "cancelled"
    ) {
      return;
    }
    this.pendingContinuationTaskIds.delete(taskId);

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      await cached.executor.wrapUp();
    } else if (this.queueManager.cancelQueuedTask(taskId)) {
      // Task was queued but hadn't started — no work to preserve, just cancel it
      this.cancelTaskRecord(taskId, "Task removed from queue during wrap-up request");
      this.finishQueueSlot(taskId);
    }
  }

  /**
   * Handle transient provider errors by scheduling a retry instead of failing.
   * Returns true if a retry was scheduled, false if retries are exhausted.
   */
  handleTransientTaskFailure(
    taskId: string,
    reason: string,
    delayMs: number = this.retryDelayMs,
  ): boolean {
    const currentCount = this.retryCounts.get(taskId) ?? 0;
    const nextCount = currentCount + 1;
    if (nextCount > this.maxTaskRetries) {
      return false;
    }

    this.retryCounts.set(taskId, nextCount);

    if (this.pendingRetries.has(taskId)) {
      return true;
    }

    // Mark as queued with a helpful message
    const retrySeconds = Math.ceil(delayMs / 1000);
    const queuedError = `Transient provider error. Retry ${nextCount}/${this.maxTaskRetries} in ${retrySeconds}s.`;
    this.taskRepo.update(taskId, {
      status: "queued",
      error: queuedError,
    });

    this.logEvent(taskId, "task_queued", {
      reason: "transient_retry",
      message: `⏳ Temporary provider error. Retrying ${nextCount}/${this.maxTaskRetries} in ${retrySeconds}s.`,
    });

    this.logEvent(taskId, "log", {
      message: `Transient provider error detected. Scheduling retry ${nextCount}/${this.maxTaskRetries} in ${Math.ceil(delayMs / 1000)}s.`,
      reason,
    });

    // Clear executor and free queue slot
    this.activeTasks.delete(taskId);
    this.finishQueueSlot(taskId);

    const handle = setTimeout(async () => {
      this.pendingRetries.delete(taskId);
      const task = this.taskRepo.findById(taskId);
      if (!task) {
        this.retryCounts.delete(taskId);
        return;
      }
      if (task.status === "executing" && this.isTransientRetryErrorMessage(task.error)) {
        // Recover from stale status drift: this task was queued for retry but got
        // flipped back to executing without an active executor.
        this.taskRepo.update(taskId, { status: "queued" });
      }

      const refreshedTask = this.taskRepo.findById(taskId);
      const taskToStart = refreshedTask || task;
      if (taskToStart.status !== "queued") return;
      if (
        this.activeTasks.has(taskId) ||
        this.queueManager.isRunning(taskId) ||
        this.queueManager.isQueued(taskId)
      ) {
        return;
      }
      await this.startTask(taskToStart);
    }, delayMs);

    this.pendingRetries.set(taskId, handle);
    return true;
  }

  getTransientRetryCount(taskId: string): number {
    return this.retryCounts.get(taskId) ?? 0;
  }

  /**
   * Pause a running task
   */
  async pauseTask(taskId: string): Promise<void> {
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.lastAccessed = Date.now();
      await cached.executor.pause();
    }
  }

  /**
   * Resume a paused task
   */
  async resumeTask(taskId: string): Promise<boolean> {
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      const currentTask = this.taskRepo.findById(taskId);
      const currentStatus = currentTask ? deriveCanonicalTaskStatus(currentTask) : undefined;
      if (isTerminalTaskStatus(currentStatus)) {
        cached.lastAccessed = Date.now();
        return false;
      }

      cached.lastAccessed = Date.now();
      cached.status = "active";
      if (currentStatus !== "executing") {
        this.updateTaskStatus(taskId, "executing");
        this.logEvent(taskId, "task_resumed", { message: "Task resumed" });
      }
      await cached.executor.resume();
      return true;
    }
    return false;
  }

  /**
   * Send stdin input to a running command in a task
   */
  sendStdinToTask(taskId: string, input: string): boolean {
    const cached = this.activeTasks.get(taskId);
    if (!cached) {
      return false;
    }
    return cached.executor.sendStdin(input);
  }

  /**
   * Kill the running command in a task (send SIGINT like Ctrl+C)
   * @param taskId - The task ID
   * @param force - If true, send SIGKILL immediately instead of graceful escalation
   */
  killCommandInTask(taskId: string, force?: boolean): boolean {
    const cached = this.activeTasks.get(taskId);
    if (!cached) {
      return false;
    }
    return cached.executor.killShellProcess(force);
  }

  /**
   * Tear down an active computer-use session when a task leaves the queue slot.
   */
  private releaseComputerUseSession(taskId: string): void {
    ComputerUseSessionManager.getInstance().endSessionIfOwner(taskId);
  }

  private finishQueueSlot(taskId: string): void {
    this.releaseComputerUseSession(taskId);
    this.queueManager.onTaskFinished(taskId);
  }

  private async finishQueueSlotAsync(taskId: string): Promise<void> {
    this.releaseComputerUseSession(taskId);
    await this.queueManager.onTaskFinished(taskId);
  }

  /**
   * Request approval from user for an action
   */
  setSessionAutoApproveAll(enabled: boolean): void {
    this.sessionAutoApproveAll = enabled;
    console.log(`[AgentDaemon] Session auto-approve ${enabled ? "ENABLED" : "DISABLED"}`);
  }

  getSessionAutoApproveAll(): boolean {
    return this.sessionAutoApproveAll;
  }

  recordSensitiveSourceRead(taskId: string, source: SensitiveSourceRef): void {
    this.getExecutorForTask(taskId)?.runtime?.recordSensitiveSourceRead(source);
  }

  listRecentSensitiveSources(taskId: string): SensitiveSourceRef[] {
    return this.getExecutorForTask(taskId)?.runtime?.listRecentSensitiveSources() || [];
  }

  private canSessionAutoApproveType(type: ApprovalType | undefined): boolean {
    return type === "run_command" || type === "network_access";
  }

  private getExecutorForTask(taskId: string): TaskExecutor | null {
    const cached = this.activeTasks.get(taskId);
    return cached?.executor || null;
  }

  private buildPermissionMode(taskId: string, task?: Task): PermissionMode {
    const runtime = this.getExecutorForTask(taskId)?.runtime;
    if (runtime?.getPermissionState().mode) {
      return runtime.getPermissionState().mode;
    }
    if (task?.agentConfig?.executionMode === "plan" || task?.agentConfig?.executionMode === "analyze") {
      return "plan";
    }
    if (task?.agentConfig?.permissionMode) {
      return task.agentConfig.permissionMode;
    }
    return PermissionSettingsManager.loadSettings().defaultMode || "default";
  }

  private buildPermissionRules(
    taskId: string,
    task: Task | undefined,
    workspace: Workspace | undefined,
  ): PermissionRule[] {
    const runtime = this.getExecutorForTask(taskId)?.runtime;
    const sessionRules = runtime?.getPermissionState().sessionRules || [];
    const workspaceDbRules = workspace
      ? this.workspacePermissionRuleRepo.listByWorkspaceId(workspace.id)
      : [];
    const manifestRules = workspace?.path
      ? loadWorkspacePermissionManifest(workspace.path).rules
      : [];
    const profileRules = PermissionSettingsManager.loadSettings().rules || [];
    const guardrailSettings = GuardrailManager.loadSettings();
    const trustedCommandRules = guardrailSettings.autoApproveTrustedCommands
      ? [...DEFAULT_TRUSTED_COMMAND_PATTERNS, ...guardrailSettings.trustedCommandPatterns].map(
          (pattern): PermissionRule => ({
            source: "legacy_guardrails",
            effect: "allow",
            scope: {
              kind: "command_prefix",
              prefix: pattern.replace(/\*/g, "").trim(),
            },
          }),
        )
      : [];
    const builtinRules: PermissionRule[] = BuiltinToolsSettingsManager.getToolAutoApprove("run_command")
      ? [
          {
            source: "legacy_builtin_settings",
            effect: "allow",
            scope: {
              kind: "tool",
              toolName: "run_command",
            },
          },
        ]
      : [];
    const autonomyRules: PermissionRule[] =
      task?.agentConfig?.autonomousMode === true
        ? (task.agentConfig.autoApproveTypes || []).map(
            (approvalType): PermissionRule => ({
              source: "session",
              effect: "allow",
              scope: {
                kind: "tool",
                toolName: this.inferToolNameFromApprovalType(approvalType),
              },
              metadata: {
                legacyAutonomyType: approvalType,
              },
            }),
          )
        : [];

    return [
      ...sessionRules,
      ...workspaceDbRules,
      ...manifestRules,
      ...profileRules,
      ...trustedCommandRules,
      ...builtinRules,
      ...autonomyRules,
    ];
  }

  private inferToolNameFromApprovalType(approvalType: string): string {
    switch (approvalType) {
      case "run_command":
        return "run_command";
      case "delete_file":
      case "delete_multiple":
        return "delete_file";
      case "network_access":
        return "web_fetch";
      case "data_export":
        return "http_request";
      default:
        return approvalType === "external_service" ? "external_service" : approvalType;
    }
  }

  private buildPermissionTrackingKey(scope: PermissionRule["scope"]): string {
    return permissionScopeFingerprint(scope);
  }

  private inferPermissionToolName(type: string | undefined, details: Any): string {
    const explicitTool = typeof details?.tool === "string" ? details.tool.trim() : "";
    if (explicitTool) return explicitTool;
    if (!type) return "external_service";
    return this.inferToolNameFromApprovalType(type);
  }

  private evaluatePermissionRequest(
    taskId: string,
    type: ApprovalType | undefined,
    details: Any,
    allowPersistence = true,
  ): {
    evaluation: PermissionEvaluationResult;
    promptDetails: PermissionPromptDetails;
    scope: PermissionRule["scope"];
    trackingKey: string;
    runtime: TaskExecutor["runtime"] | null;
    workspace: Workspace | undefined;
  } {
    const task = this.taskRepo.findById(taskId);
    const workspace = task ? this.workspaceRepo.findById(task.workspaceId) : undefined;
    const runtime = this.getExecutorForTask(taskId)?.runtime || null;
    const toolName = this.inferPermissionToolName(type, details);
    const serverName =
      typeof details?.serverName === "string" && details.serverName.trim()
        ? details.serverName.trim()
        : null;
    const mode = this.buildPermissionMode(taskId, task);
    const bundleGrantKey =
      type === "run_command" && details?.approvalMode === "single_bundle"
        ? "run_command:single_bundle"
        : "";
    if (runtime && bundleGrantKey && runtime.hasActiveTemporaryPermissionGrant(bundleGrantKey)) {
      const scope = PermissionEngine.inferScope({
        workspace: workspace as Workspace,
        toolName,
        toolInput: details?.params ?? details,
        mode,
        approvalType: type,
        command: details?.command,
        path: details?.path,
        serverName,
        allowPersistence,
        rules: [],
      });
      return {
        evaluation: {
          decision: "allow",
          reason: {
            type: "bundle_grant",
            summary: "Temporary bundle grant is active for this task.",
          },
          suggestions: [],
          scopePreview: summarizePermissionScope(scope),
        },
        promptDetails: {
          scope,
          reason: {
            type: "bundle_grant",
            summary: "Temporary bundle grant is active for this task.",
          },
          scopePreview: summarizePermissionScope(scope),
          suggestedActions: [],
        },
        scope,
        trackingKey: this.buildPermissionTrackingKey(scope),
        runtime,
        workspace,
      };
    }

    const rules = this.buildPermissionRules(taskId, task, workspace);
    const evaluation = PermissionEngine.evaluate({
      workspace:
        workspace ||
        ({
          id: "unknown",
          name: "Unknown",
          path: details?.cwd || process.cwd(),
          permissions: {
            read: true,
            write: true,
            delete: false,
            shell: false,
            network: true,
          },
          createdAt: 0,
        } as Workspace),
      toolName,
      toolInput: details?.params ?? details,
      mode,
      rules,
      approvalType: type,
      command: typeof details?.command === "string" ? details.command : null,
      path: typeof details?.path === "string" ? details.path : null,
      serverName,
      allowPersistence,
      denyState: runtime
        ? runtime.getPermissionDenialState(
            this.buildPermissionTrackingKey(
              PermissionEngine.inferScope({
                workspace: workspace as Workspace,
                toolName,
                toolInput: details?.params ?? details,
                mode,
                approvalType: type,
                command: details?.command,
                path: details?.path,
                serverName,
                allowPersistence,
                rules,
              }),
            ),
          )
        : undefined,
    });
    const scope = PermissionEngine.inferScope({
      workspace:
        workspace ||
        ({
          id: "unknown",
          name: "Unknown",
          path: details?.cwd || process.cwd(),
          permissions: {
            read: true,
            write: true,
            delete: false,
            shell: false,
            network: true,
          },
          createdAt: 0,
        } as Workspace),
      toolName,
      toolInput: details?.params ?? details,
      mode,
      approvalType: type,
      command: details?.command,
      path: details?.path,
      serverName,
      allowPersistence,
      rules,
    });
    const promptDetails: PermissionPromptDetails = {
      scope,
      reason: evaluation.reason,
      matchedRule: evaluation.matchedRule,
      scopePreview: evaluation.scopePreview,
      suggestedActions: evaluation.suggestions,
      ...(serverName ? { serverName } : {}),
      ...(() => {
        const securityContext = buildPermissionSecurityContext({
          workspace,
          toolName,
          toolInput: details?.params ?? details,
          recentSensitiveSources: runtime?.listRecentSensitiveSources?.() || [],
        });
        return securityContext ? { securityContext } : {};
      })(),
    };
    runtime?.setLatestPermissionPromptContext(promptDetails);
    return {
      evaluation,
      promptDetails,
      scope,
      trackingKey: this.buildPermissionTrackingKey(scope),
      runtime,
      workspace,
    };
  }

  private persistApprovalActionRule(
    action: ApprovalResponseAction,
    approval: Any,
  ): {
    effect?: PermissionEffect;
    destination?: "session" | "workspace" | "profile";
    dbPersisted?: boolean;
    manifestPersisted?: boolean;
    manifestError?: string;
  } {
    const details =
      approval?.details && typeof approval.details === "object" ? (approval.details as Record<string, unknown>) : {};
    const prompt = details.permissionPrompt as PermissionPromptDetails | undefined;
    if (!prompt?.scope) {
      return {};
    }
    const effect: PermissionEffect = action.startsWith("deny_") ? "deny" : "allow";
    const destination =
      action.endsWith("_session")
        ? "session"
        : action.endsWith("_workspace")
          ? "workspace"
          : action.endsWith("_profile")
            ? "profile"
            : undefined;
    if (!destination) {
      return { effect };
    }

    const rule: PermissionRule = {
      source:
        destination === "session"
          ? "session"
          : destination === "workspace"
            ? "workspace_db"
            : "profile",
      effect,
      scope: prompt.scope,
      metadata: {
        createdByApprovalId: approval.id,
        createdFromApprovalType: approval.type,
      },
    };

    const task = this.taskRepo.findById(approval.taskId);
    const workspace = task ? this.workspaceRepo.findById(task.workspaceId) : undefined;
    const runtime = this.getExecutorForTask(approval.taskId)?.runtime || null;

    if (destination === "session") {
      runtime?.addSessionPermissionRule(rule);
      return { effect, destination };
    }
    if (destination === "profile") {
      PermissionSettingsManager.appendRule({
        ...rule,
        source: "profile",
      });
      return { effect, destination };
    }
    if (workspace) {
      this.workspacePermissionRuleRepo.create({
        workspaceId: workspace.id,
        effect,
        scope: prompt.scope,
        metadata: rule.metadata,
      });
      const manifestResult = appendWorkspacePermissionManifestRule(workspace.path, {
        ...rule,
        source: "workspace_manifest",
      });
      return {
        effect,
        destination,
        dbPersisted: true,
        manifestPersisted: manifestResult.success,
        ...(manifestResult.success ? {} : { manifestError: manifestResult.error }),
      };
    }
    return { effect, destination };
  }

  evaluateToolPermission(taskId: string, opts: {
    approvalType?: ApprovalType;
    toolName: string;
    details?: Any;
    allowPersistence?: boolean;
  }): PermissionEvaluationResult {
    const result = this.evaluatePermissionRequest(
      taskId,
      opts.approvalType,
      {
        ...(opts.details && typeof opts.details === "object" ? opts.details : {}),
        tool: opts.toolName,
      },
      opts.allowPersistence !== false,
    );
    return result.evaluation;
  }

  listInputRequests(params?: {
    limit?: number;
    offset?: number;
    taskId?: string;
    status?: InputRequest["status"];
  }): InputRequest[] {
    const limit = Math.min(Math.max(params?.limit ?? 200, 1), 500);
    const offset = Math.max(params?.offset ?? 0, 0);
    const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
    const status = params?.status;
    return this.inputRequestRepo.list({
      limit,
      offset,
      ...(taskId ? { taskId } : {}),
      ...(status ? { status } : {}),
    });
  }

  async requestUserInput(taskId: string, args: RequestUserInputArgs): Promise<InputRequestResponse> {
    const existingPending = this.inputRequestRepo.findPendingByTaskId(taskId);
    if (existingPending.length > 0) {
      throw new Error(
        `Task ${taskId} already has a pending structured input request. Resolve it before requesting another.`,
      );
    }

    const request = this.inputRequestRepo.create({
      taskId,
      questions: args.questions,
      requestedAt: Date.now(),
      status: "pending",
    });

    this.updateTask(taskId, {
      status: "paused",
      terminalStatus: "needs_user_action",
      failureClass: undefined,
    });
    this.logEvent(taskId, "input_request_created", { request });
    this.logEvent(taskId, "task_paused", {
      message: "Waiting for structured user input.",
      reason: "input_request",
      requestId: request.id,
    });

    return new Promise((resolve, reject) => {
      this.pendingInputRequests.set(request.id, {
        taskId,
        resolve,
        reject,
        resolved: false,
      });
    });
  }

  async requestApproval(
    taskId: string,
    type: string,
    description: string,
    details: Any,
    opts?: { allowAutoApprove?: boolean },
  ): Promise<boolean> {
    const allowAutoApprove = opts?.allowAutoApprove !== false;
    const enrichedDetails =
      details && typeof details === "object" && !Array.isArray(details) ? { ...details } : { value: details };
    const permission = this.evaluatePermissionRequest(
      taskId,
      type as ApprovalType,
      enrichedDetails,
      allowAutoApprove,
    );
    const permissionDetails = {
      ...enrichedDetails,
      permissionPrompt: permission.promptDetails,
    };
    const safeSessionAutoApprove =
      allowAutoApprove &&
      this.sessionAutoApproveAll &&
      this.canSessionAutoApproveType(type as ApprovalType | undefined);

    if (permission.evaluation.decision === "allow") {
      permission.runtime?.recordPermissionSuccess(permission.trackingKey);
      if (type === "run_command" && enrichedDetails.approvalMode === "single_bundle") {
        permission.runtime?.addTemporaryPermissionGrant("run_command:single_bundle");
      }
      const approval = this.approvalRepo.create({
        taskId,
        type: type as Any,
        description,
        details: permissionDetails,
        status: "approved",
        requestedAt: Date.now(),
      });
      this.approvalRepo.update(approval.id, "approved");
      this.logEvent(taskId, "approval_requested", {
        approval,
        autoApproved: true,
      });
      this.logEvent(taskId, "approval_granted", {
        approvalId: approval.id,
        autoApproved: true,
        reason: permission.evaluation.reason.type,
        permissionReason: permission.evaluation.reason,
      });
      return true;
    }

    if (permission.evaluation.decision === "deny") {
      permission.runtime?.recordPermissionDenial(permission.trackingKey);
      const approval = this.approvalRepo.create({
        taskId,
        type: type as Any,
        description,
        details: permissionDetails,
        status: "denied",
        requestedAt: Date.now(),
      });
      this.approvalRepo.update(approval.id, "denied");
      this.logEvent(taskId, "approval_denied", {
        approvalId: approval.id,
        autoResolved: true,
        reason: permission.evaluation.reason.type,
        permissionReason: permission.evaluation.reason,
      });
      return false;
    }

    if (safeSessionAutoApprove) {
      permission.runtime?.recordPermissionSuccess(permission.trackingKey);
      const approval = this.approvalRepo.create({
        taskId,
        type: type as Any,
        description,
        details: permissionDetails,
        status: "approved",
        requestedAt: Date.now(),
      });
      this.approvalRepo.update(approval.id, "approved");
      this.logEvent(taskId, "approval_requested", {
        approval,
        autoApproved: true,
      });
      this.logEvent(taskId, "approval_granted", {
        approvalId: approval.id,
        autoApproved: true,
        reason: "session_auto_approve",
        permissionReason: permission.evaluation.reason,
      });
      return true;
    }

    const approval = this.approvalRepo.create({
      taskId,
      type: type as Any,
      description,
      details: permissionDetails,
      status: "pending",
      requestedAt: Date.now(),
    });

    this.updateTask(taskId, {
      status: "blocked",
      terminalStatus: "awaiting_approval",
      failureClass: undefined,
    });

    // Emit event to UI
    this.logEvent(taskId, "approval_requested", { approval });

    // Wait for user response
    return new Promise((resolve, reject) => {
      // Timeout after 5 minutes
      const timeoutHandle = setTimeout(
        () => {
          const pending = this.pendingApprovals.get(approval.id);
          if (pending && !pending.resolved) {
            const currentTask = this.taskRepo.findById(taskId);
            const currentStatus = currentTask ? deriveCanonicalTaskStatus(currentTask) : undefined;
            pending.resolved = true;
            this.pendingApprovals.delete(approval.id);
            this.approvalRepo.update(approval.id, "denied");
            if (isTerminalTaskStatus(currentStatus)) {
              reject(new Error("Approval request timed out after task completion"));
              return;
            }
            this.updateTask(taskId, {
              status: "paused",
              terminalStatus: "needs_user_action",
              failureClass: undefined,
              error: "Approval request timed out",
            });
            this.logEvent(taskId, "approval_denied", {
              approvalId: approval.id,
              reason: "timeout",
            });
            reject(new Error("Approval request timed out"));
          }
        },
        5 * 60 * 1000,
      );

      this.pendingApprovals.set(approval.id, {
        taskId,
        approval,
        resolve,
        reject,
        resolved: false,
        timeoutHandle,
      });
    });
  }

  /**
   * Respond to an approval request
   * Uses idempotency to prevent double-approval race conditions
   * Implements C6: Approval Gate Enforcement
   */
  async respondToApproval(
    approvalId: string,
    approved: boolean,
    action?: ApprovalResponseAction,
  ): Promise<"handled" | "duplicate" | "not_found" | "in_progress"> {
    // Generate idempotency key for this approval response
    const idempotencyKey = IdempotencyManager.generateKey(
      "approval:respond",
      approvalId,
      action || (approved ? "approve" : "deny"),
    );

    // Check if this exact response was already processed
    const existing = approvalIdempotency.check(idempotencyKey);
    if (existing.exists) {
      console.log(`[AgentDaemon] Duplicate approval response ignored: ${approvalId}`);
      return "duplicate";
    }

    // Start tracking this operation
    if (!approvalIdempotency.start(idempotencyKey)) {
      console.log(`[AgentDaemon] Concurrent approval response in progress: ${approvalId}`);
      return "in_progress";
    }

    try {
      const pending = this.pendingApprovals.get(approvalId);
      if (pending && !pending.resolved) {
        const normalizedAction: ApprovalResponseAction =
          action ||
          (approved ? "allow_once" : "deny_once");
        const persistenceResult = this.persistApprovalActionRule(normalizedAction, pending.approval);
        const didApprove =
          normalizedAction === "allow_once" ||
          normalizedAction === "allow_session" ||
          normalizedAction === "allow_workspace" ||
          normalizedAction === "allow_profile";
        const runtime = this.getExecutorForTask(pending.taskId)?.runtime || null;
        const prompt =
          pending.approval?.details && typeof pending.approval.details === "object"
            ? ((pending.approval.details as Record<string, unknown>)
                .permissionPrompt as PermissionPromptDetails | undefined)
            : undefined;
        const trackingKey = prompt?.scope
          ? this.buildPermissionTrackingKey(prompt.scope)
          : "";
        if (runtime && trackingKey) {
          if (didApprove) {
            runtime.recordPermissionSuccess(trackingKey);
          } else {
            runtime.recordPermissionDenial(trackingKey);
          }
        }
        if (
          didApprove &&
          pending.approval?.type === "run_command" &&
          pending.approval?.details?.approvalMode === "single_bundle"
        ) {
          runtime?.addTemporaryPermissionGrant("run_command:single_bundle");
        }

        // Mark as resolved first to prevent race condition with timeout
        pending.resolved = true;

        // Clear the timeout
        clearTimeout(pending.timeoutHandle);

        this.pendingApprovals.delete(approvalId);
        this.approvalRepo.update(approvalId, didApprove ? "approved" : "denied");
        this.updateTask(pending.taskId, {
          status: didApprove ? "executing" : "paused",
          terminalStatus: didApprove ? undefined : "needs_user_action",
          failureClass: undefined,
          error: didApprove ? null : "User denied approval",
        });

        // Emit event so UI knows the approval has been handled
        const eventType = didApprove ? "approval_granted" : "approval_denied";
        this.logEvent(pending.taskId, eventType, {
          approvalId,
          action: normalizedAction,
          persistence: persistenceResult,
        });

        if (didApprove) {
          pending.resolve(true);
        } else {
          pending.reject(new Error("User denied approval"));
        }

        approvalIdempotency.complete(idempotencyKey, { success: true, status: "handled" });
        return "handled";
      }

      approvalIdempotency.complete(idempotencyKey, { success: true, status: "not_found" });
      return "not_found";
    } catch (error) {
      approvalIdempotency.fail(idempotencyKey, error);
      throw error;
    }
  }

  private cleanupPendingApprovalsForTask(taskId: string, rejectionMessage: string): number {
    let cleared = 0;

    for (const [approvalId, pending] of Array.from(this.pendingApprovals.entries())) {
      if (pending.taskId !== taskId) continue;

      clearTimeout(pending.timeoutHandle);
      this.pendingApprovals.delete(approvalId);

      if (pending.resolved) {
        continue;
      }

      pending.resolved = true;
      this.approvalRepo.update(approvalId, "denied");
      this.logEvent(taskId, "approval_denied", {
        approvalId,
        reason: "task_ended",
      });
      pending.reject(new Error(rejectionMessage));
      cleared += 1;
    }

    return cleared;
  }

  async respondToInputRequest(
    response: InputRequestResponse,
  ): Promise<{ status: "handled" | "duplicate" | "not_found" | "in_progress"; requestId: string }> {
    const idempotencyKey = IdempotencyManager.generateKey(
      "input_request:respond",
      response.requestId,
      response.status,
    );
    const existing = inputRequestIdempotency.check(idempotencyKey);
    if (existing.exists) {
      return { status: "duplicate", requestId: response.requestId };
    }
    if (!inputRequestIdempotency.start(idempotencyKey)) {
      return { status: "in_progress", requestId: response.requestId };
    }

    try {
      const request = this.inputRequestRepo.findById(response.requestId);
      if (!request) {
        inputRequestIdempotency.complete(idempotencyKey, { status: "not_found" });
        return { status: "not_found", requestId: response.requestId };
      }
      if (request.status !== "pending") {
        inputRequestIdempotency.complete(idempotencyKey, { status: "duplicate" });
        return { status: "duplicate", requestId: response.requestId };
      }

      this.inputRequestRepo.resolve(response.requestId, response.status, response.answers);

      if (response.status === "submitted") {
        this.logEvent(request.taskId, "assistant_message", {
          message: buildStructuredInputSelectionMessage(request, response.answers),
          requestId: response.requestId,
          source: "structured_input_selection",
        });
      }

      const latencyMs =
        typeof request.requestedAt === "number" && Number.isFinite(request.requestedAt)
          ? Math.max(0, Date.now() - request.requestedAt)
          : undefined;
      this.logEvent(request.taskId, "log", {
        metric: "input_request_response",
        status: response.status,
        latencyMs,
      });

      const currentTask = this.taskRepo.findById(request.taskId);
      const currentTaskStatus = currentTask?.status;
      const isTerminalTask =
        currentTaskStatus === "completed" ||
        currentTaskStatus === "failed" ||
        currentTaskStatus === "cancelled";

      if (!isTerminalTask) {
        if (response.status === "submitted") {
          this.updateTask(request.taskId, {
            status: "executing",
            terminalStatus: undefined,
            failureClass: undefined,
          });
        } else {
          this.updateTask(request.taskId, {
            status: "paused",
            terminalStatus: "needs_user_action",
            failureClass: undefined,
          });
        }
      }

      this.logEvent(
        request.taskId,
        response.status === "submitted" ? "input_request_resolved" : "input_request_dismissed",
        {
          requestId: response.requestId,
          status: response.status,
          answers: response.answers,
          terminalTask: isTerminalTask,
        },
      );

      const pending = this.pendingInputRequests.get(response.requestId);
      if (pending && !pending.resolved) {
        pending.resolved = true;
        this.pendingInputRequests.delete(response.requestId);
        if (isTerminalTask) {
          pending.reject(
            new Error(
              `Structured input response ignored because task is already terminal (${currentTaskStatus || "unknown"}).`,
            ),
          );
        } else if (response.status === "submitted") {
          pending.resolve(response);
        } else {
          pending.reject(new Error("Structured input request dismissed by user"));
        }
      } else if (response.status === "submitted" && !isTerminalTask) {
        // Restart recovery path: executor waiter may not exist after app restart.
        try {
          const compactAnswers = JSON.stringify(response.answers || {}, null, 2);
          await this.sendMessage(
            request.taskId,
            `Structured input response for request ${response.requestId}:\n${compactAnswers}`,
          );
        } catch (error) {
          console.warn(
            `[AgentDaemon] Failed to replay structured input response for task ${request.taskId}:`,
            error,
          );
        }
      }

      inputRequestIdempotency.complete(idempotencyKey, { status: "handled" });
      return { status: "handled", requestId: response.requestId };
    } catch (error) {
      inputRequestIdempotency.fail(idempotencyKey, error);
      throw error;
    }
  }

  /**
   * Log an event for a task
   */
  logEvent(taskId: string, type: string, payload: Any): void {
    const timestamp = Date.now();
    const payloadObj: Record<string, unknown> =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? ({ ...(payload as Record<string, unknown>) } as Record<string, unknown>)
        : payload === undefined
          ? {}
          : ({ value: payload } as Record<string, unknown>);

    // Drop internal metric telemetry from timeline persistence/rendering.
    // These high-frequency events are not user-facing and can overwhelm UI/event stores.
    if (
      type === "log" &&
      typeof payloadObj.metric === "string" &&
      payloadObj.metric.trim().length > 0
    ) {
      return;
    }

    this.normalizeArtifactEventPayload(taskId, type, payloadObj);
    this.maybeEnrichLlmTelemetryPayload(taskId, type, payloadObj);

    // Streaming progress remains ephemeral, but we bridge it into the v2 timeline
    // as an in-memory step update so UIs can render deterministic progress cards.
    if (type === "llm_streaming") {
      const seq = this.nextEventSeq(taskId);
      const eventId = crypto.randomUUID();
      const streamingEvent = normalizeTaskEventToTimelineV2({
        taskId,
        type: "timeline_step_updated",
        payload: {
          ...payloadObj,
          legacyType: "llm_streaming",
          status: "in_progress",
          actor: "agent",
          ephemeral: true,
          message:
            typeof payloadObj.message === "string"
              ? payloadObj.message
              : "Thinking...",
        },
        timestamp,
        eventId,
        seq,
      });

      this.emitTaskEvent(streamingEvent);
      this.maybeEmitTeamStreamingProgress(taskId, payload);
      return;
    }

    const requestedSeqRaw = payloadObj.seq;
    const requestedSeq =
      typeof requestedSeqRaw === "number" && Number.isFinite(requestedSeqRaw) && requestedSeqRaw > 0
        ? Math.floor(requestedSeqRaw)
        : undefined;
    const currentSeq = this.getCurrentEventSeq(taskId);
    if (requestedSeq !== undefined && requestedSeq <= currentSeq) {
      this.timelineMetrics.orderViolations += 1;
      this.timelineMetrics.droppedEvents += 1;
      const quarantineSeq = this.nextEventSeq(taskId);
      const quarantineEvent = normalizeTaskEventToTimelineV2({
        taskId,
        type: "timeline_error",
        payload: {
          message: "Out-of-order timeline event rejected",
          rejectedType: type,
          rejectedSeq: requestedSeq,
          lastKnownSeq: currentSeq,
          rawPayload: payloadObj,
          legacyType: "error",
        },
        timestamp,
        eventId: crypto.randomUUID(),
        seq: quarantineSeq,
      });
      this.persistTimelineEvent(quarantineEvent, {
        legacyType: "error",
        legacyPayload: {
          message: "Out-of-order timeline event rejected",
          rejectedType: type,
          rejectedSeq: requestedSeq,
          lastKnownSeq: currentSeq,
        },
      });
      return;
    }

    if (requestedSeq !== undefined) {
      this.taskSeqById.set(taskId, requestedSeq);
    }
    const seq = requestedSeq ?? this.nextEventSeq(taskId);
    const eventId = crypto.randomUUID();
    const timelineEvent = normalizeTaskEventToTimelineV2({
      taskId,
      type,
      payload: payloadObj,
      timestamp,
      eventId,
      seq,
    });
    // Stage machine: DISCOVER -> BUILD -> VERIFY -> FIX -> DELIVER
    const shouldInferStageFromEvent =
      !isTimelineEventType(type) ||
      (type !== "timeline_group_started" && type !== "timeline_group_finished");
    const stageSourceType = shouldInferStageFromEvent
      ? !isTimelineEventType(type)
        ? (type as EventType)
        : typeof timelineEvent.legacyType === "string"
          ? (timelineEvent.legacyType as EventType)
          : undefined
      : undefined;
    if (stageSourceType) {
      const inferredStage = inferTimelineStageForLegacyType(stageSourceType);
      if (inferredStage) {
        const currentStage = this.activeTimelineStageByTask.get(taskId);
        // Avoid oscillating FIX ↔ BUILD: when in FIX, tool_call/tool_result/file_* are part of
        // the fix work — stay in FIX until step_started/step_completed signals a new phase.
        const buildWorkEvents: EventType[] = [
          "tool_call",
          "tool_result",
          "file_created",
          "file_modified",
          "file_deleted",
          "command_output",
          "artifact_created",
        ];
        const wouldOscillate =
          currentStage === "FIX" &&
          inferredStage === "BUILD" &&
          buildWorkEvents.includes(stageSourceType);
        if (wouldOscillate) {
          // Stay in FIX; tool_call/tool_result/file_* during fix are part of the fix work
        } else {
          const subStageLabel = inferTimelineSubStageLabel(stageSourceType);
          this.transitionTimelineStage(taskId, inferredStage, subStageLabel);
        }
      }
    }

    this.trackTimelineStepState(taskId, timelineEvent);
    this.trackEvidenceRefs(taskId, timelineEvent);
    this.timelineMetrics.totalEvents += 1;

    const legacyType: string | undefined = isTimelineEventType(type)
      ? timelineEvent.legacyType
      : type;
    const legacyPayload: Record<string, unknown> = (() => {
      if (!isTimelineEventType(type)) return payloadObj;
      const copy = { ...(timelineEvent.payload as Record<string, unknown>) };
      delete copy.legacyType;
      return copy;
    })();

    this.persistTimelineEvent(timelineEvent, {
      legacyType,
      legacyPayload,
    });
    const persistTranscriptArtifacts = (this as Any).persistTranscriptArtifacts;
    if (typeof persistTranscriptArtifacts === "function") {
      void persistTranscriptArtifacts.call(this, taskId, timelineEvent, legacyType, legacyPayload);
    }
    this.maybeEmitAssistantMediaPreview(taskId, type, payloadObj);
  }

  private maybeEmitAssistantMediaPreview(
    taskId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (type !== "file_created" && type !== "artifact_created" && type !== "timeline_artifact_emitted") {
      return;
    }

    const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!rawPath) return;
    const isUrl = /^(https?:\/\/|file:\/\/)/i.test(rawPath);
    const task = this.taskRepo.findById(taskId);
    const workspace =
      task && typeof task.workspaceId === "string"
        ? this.workspaceRepo.findById(task.workspaceId)
        : undefined;
    const workspacePath =
      workspace && typeof workspace.path === "string" && workspace.path.trim().length > 0
        ? workspace.path.trim()
        : "";
    const normalizedPath =
      !isUrl && !path.isAbsolute(rawPath) && workspacePath ? path.resolve(workspacePath, rawPath) : rawPath;

    const mimeType = typeof payload.mimeType === "string" ? payload.mimeType.trim().toLowerCase() : "";
    const extension = path.extname(rawPath).toLowerCase();
    const isPreviewableVideo =
      mimeType === "video/mp4" ||
      mimeType === "video/webm" ||
      extension === ".mp4" ||
      extension === ".webm" ||
      payload.type === "video";
    if (!isPreviewableVideo) return;

    const dedupeKey = `video:${normalizedPath}`;
    let emittedForTask = this.mediaPreviewMessagesByTask.get(taskId);
    if (!emittedForTask) {
      emittedForTask = new Set<string>();
      this.mediaPreviewMessagesByTask.set(taskId, emittedForTask);
    }
    if (emittedForTask.has(dedupeKey)) return;
    emittedForTask.add(dedupeKey);

    const title =
      typeof payload.label === "string" && payload.label.trim().length > 0
        ? payload.label.trim()
        : path.basename(rawPath) || "Generated video";
    const quote = (value: string): string => JSON.stringify(value);
    const message = `Preview ready.\n\n::video{path=${quote(rawPath)} title=${quote(title)}}`;

    this.logEvent(taskId, "assistant_message", {
      message,
      internal: true,
      generatedBy: "media_preview",
    });
  }

  private normalizeProviderTypeValue(value: unknown): string | null {
    return normalizeLlmProviderType(typeof value === "string" ? value : null);
  }

  private getProviderTypeFromLogMessage(message: unknown): string | null {
    if (typeof message !== "string" || message.trim().length === 0) return null;
    const match = message.match(/\bprovider=([a-z0-9._-]+)/i);
    return this.normalizeProviderTypeValue(match?.[1]?.toLowerCase() || null);
  }

  private getProviderTypeFromPayload(payloadObj: Record<string, unknown>): string | null {
    return (
      this.normalizeProviderTypeValue(payloadObj.providerType) ||
      this.normalizeProviderTypeValue(payloadObj.activeProvider) ||
      this.normalizeProviderTypeValue(payloadObj.currentProvider) ||
      this.getProviderTypeFromLogMessage(payloadObj.message)
    );
  }

  private getTaskAgentConfigProviderType(taskId: string): string | null {
    return this.normalizeProviderTypeValue(this.taskRepo.findById(taskId)?.agentConfig?.providerType);
  }

  private getActiveExecutorProviderType(taskId: string): string | null {
    const activeExecutorProvider = (this.activeTasks.get(taskId)?.executor as Any)?.provider?.type;
    return this.normalizeProviderTypeValue(activeExecutorProvider);
  }

  private rememberTaskLlmProviderType(taskId: string, providerType?: string | null): string | null {
    const normalized = this.normalizeProviderTypeValue(providerType);
    if (!normalized) return null;
    this.lastKnownLlmProviderByTask.set(taskId, normalized);
    return normalized;
  }

  private resolveTaskLlmProviderType(
    taskId: string,
    payloadObj: Record<string, unknown>,
  ): string | null {
    return (
      this.getProviderTypeFromPayload(payloadObj) ||
      this.getActiveExecutorProviderType(taskId) ||
      this.lastKnownLlmProviderByTask.get(taskId) ||
      this.getTaskAgentConfigProviderType(taskId)
    );
  }

  private maybeEnrichLlmTelemetryPayload(
    taskId: string,
    type: string,
    payloadObj: Record<string, unknown>,
  ): void {
    const payloadLegacyType =
      typeof payloadObj.legacyType === "string" ? payloadObj.legacyType.trim() : "";
    const effectiveType = payloadLegacyType || type;

    if (effectiveType === "log") {
      this.rememberTaskLlmProviderType(taskId, this.getProviderTypeFromLogMessage(payloadObj.message));
      return;
    }

    if (effectiveType === "llm_routing_changed") {
      const providerType =
        this.getProviderTypeFromPayload(payloadObj) ||
        this.getActiveExecutorProviderType(taskId) ||
        this.getTaskAgentConfigProviderType(taskId);
      if (!providerType) return;
      payloadObj.providerType = providerType;
      this.rememberTaskLlmProviderType(taskId, providerType);
      return;
    }

    if (effectiveType !== "llm_usage" && effectiveType !== "llm_error") {
      return;
    }

    const providerType = this.resolveTaskLlmProviderType(taskId, payloadObj);
    if (!providerType) return;
    payloadObj.providerType = providerType;
    this.rememberTaskLlmProviderType(taskId, providerType);
  }

  private async persistTranscriptArtifacts(
    taskId: string,
    timelineEvent: TaskEvent,
    legacyType: string | undefined,
    legacyPayload: Record<string, unknown>,
  ): Promise<void> {
    let features;
    try {
      features = MemoryFeaturesManager.loadSettings();
    } catch {
      return;
    }

    if (
      !features.transcriptStoreEnabled &&
      !features.backgroundConsolidationEnabled &&
      !features.checkpointCaptureEnabled
    ) {
      return;
    }

    const task = this.taskRepo.findById(taskId);
    if (!task) return;
    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace?.path) return;

    if (features.transcriptStoreEnabled) {
      const legacyEvent: TaskEvent = {
        ...timelineEvent,
        type: (legacyType as EventType) || timelineEvent.type,
        payload: legacyPayload,
        legacyType: (legacyType as EventType) || timelineEvent.legacyType,
      };
      await TranscriptStore.appendEvent(workspace.path, legacyEvent).catch(() => undefined);
    }

    if (features.checkpointCaptureEnabled !== false) {
      await this.maybeCaptureRuntimeCheckpoint({
        task,
        workspacePath: workspace.path,
        event: timelineEvent,
        legacyType,
        legacyPayload,
      }).catch(() => undefined);
    }

    if (features.backgroundConsolidationEnabled && legacyType === "task_completed") {
      this.scheduleMemoryConsolidation(task);
    }
  }

  private extractCheckpointEventText(payload: unknown): string {
    if (typeof payload === "string") {
      return payload.replace(/\s+/g, " ").trim();
    }
    if (!payload || typeof payload !== "object") {
      return "";
    }

    const record = payload as Record<string, unknown>;
    const preferredFields = [
      "message",
      "text",
      "content",
      "summary",
      "result",
      "response",
      "assistantText",
      "userText",
    ];
    for (const field of preferredFields) {
      const value = record[field];
      if (typeof value === "string" && value.trim()) {
        return value.replace(/\s+/g, " ").trim();
      }
    }
    try {
      return JSON.stringify(payload).replace(/\s+/g, " ").trim();
    } catch {
      return "";
    }
  }

  private isMeaningfulExchangeEvent(type: string | undefined, payload: unknown): boolean {
    if (type !== "user_message" && type !== "assistant_message") {
      return false;
    }
    return this.extractCheckpointEventText(payload).length > 0;
  }

  private collectMeaningfulExchangeEvents(taskId: string): TaskEvent[] {
    return this.getTaskEventsForReplay(taskId).filter((event) => {
      const effectiveType =
        typeof event.legacyType === "string" && event.legacyType.trim().length > 0
          ? event.legacyType
          : event.type;
      return this.isMeaningfulExchangeEvent(effectiveType, event.payload);
    });
  }

  private getSnapshotSummaryBlock(payload: Record<string, unknown>): string {
    if (typeof payload.explicitChatSummaryBlock === "string" && payload.explicitChatSummaryBlock.trim()) {
      return payload.explicitChatSummaryBlock.trim();
    }
    const transcript =
      payload.transcript && typeof payload.transcript === "object"
        ? (payload.transcript as Record<string, unknown>)
        : null;
    if (
      transcript &&
      typeof transcript.explicitChatSummaryBlock === "string" &&
      transcript.explicitChatSummaryBlock.trim()
    ) {
      return transcript.explicitChatSummaryBlock.trim();
    }
    return "";
  }

  private parseStructuredCheckpointSummary(rawText: string, source: "snapshot" | "compaction_summary" | "completion" | "fallback"): {
    source: "snapshot" | "compaction_summary" | "completion" | "fallback";
    rawText?: string;
    decisions: string[];
    openLoops: string[];
    nextActions: string[];
    keyFindings: string[];
  } {
    const raw = String(rawText || "").trim();
    const sections = {
      decisions: [] as string[],
      openLoops: [] as string[],
      nextActions: [] as string[],
      keyFindings: [] as string[],
    };
    if (!raw) {
      return { source, decisions: [], openLoops: [], nextActions: [], keyFindings: [] };
    }

    let activeSection: keyof typeof sections | null = null;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase();
      if (normalized.startsWith("decisions:")) {
        activeSection = "decisions";
        continue;
      }
      if (normalized.startsWith("open loops:")) {
        activeSection = "openLoops";
        continue;
      }
      if (normalized.startsWith("next actions:")) {
        activeSection = "nextActions";
        continue;
      }
      if (normalized.startsWith("key findings:")) {
        activeSection = "keyFindings";
        continue;
      }
      if (trimmed.startsWith("- ") && activeSection) {
        sections[activeSection].push(trimmed.replace(/^-+\s*/, ""));
      }
    }

    if (
      sections.decisions.length === 0 &&
      sections.openLoops.length === 0 &&
      sections.nextActions.length === 0 &&
      sections.keyFindings.length === 0
    ) {
      sections.keyFindings.push(raw.slice(0, 400));
    }

    return {
      source,
      rawText: raw,
      ...sections,
    };
  }

  private buildStructuredCheckpointSummary(task: Task, snapshotPayload?: Record<string, unknown>): {
    source: "snapshot" | "compaction_summary" | "completion" | "fallback";
    rawText?: string;
    decisions: string[];
    openLoops: string[];
    nextActions: string[];
    keyFindings: string[];
  } {
    const snapshotSummary = snapshotPayload ? this.getSnapshotSummaryBlock(snapshotPayload) : "";
    if (snapshotSummary) {
      return this.parseStructuredCheckpointSummary(snapshotSummary, "compaction_summary");
    }

    const bestKnownOutcome = getTaskBestKnownOutcome(task);
    const completionSummary =
      (typeof task.resultSummary === "string" && task.resultSummary.trim()) ||
      (typeof bestKnownOutcome?.resultSummary === "string" && bestKnownOutcome.resultSummary.trim()) ||
      "";
    if (completionSummary) {
      return this.parseStructuredCheckpointSummary(completionSummary, "completion");
    }

    return this.parseStructuredCheckpointSummary(task.prompt.slice(0, 400), "fallback");
  }

  private buildCheckpointEvidencePacket(taskId: string, messageEvents: TaskEvent[]): {
    generatedAt: number;
    spanHash: string;
    spanCount: number;
    spans: Array<{
      sourceType: "task_message";
      objectId: string;
      taskId: string;
      timestamp: number;
      type: string;
      excerpt: string;
      eventId?: string;
      seq?: number;
    }>;
  } {
    const spans = messageEvents
      .map((event) => {
        const excerpt = this.extractCheckpointEventText(event.payload).slice(0, 500);
        if (!excerpt) return null;
        const objectId =
          event.eventId || event.id || `${taskId}:${typeof event.seq === "number" ? event.seq : event.timestamp}`;
        return {
          sourceType: "task_message" as const,
          objectId,
          taskId,
          timestamp: event.timestamp,
          type:
            typeof event.legacyType === "string" && event.legacyType.trim().length > 0
              ? event.legacyType
              : event.type,
          excerpt,
          ...(event.eventId ? { eventId: event.eventId } : {}),
          ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
        };
      })
      .filter((span): span is NonNullable<typeof span> => span !== null);

    const hashInput = spans
      .map((span) => `${span.objectId}:${span.timestamp}:${span.type}:${span.excerpt}`)
      .join("|");

    return {
      generatedAt: Date.now(),
      spanHash: crypto.createHash("sha256").update(hashInput).digest("hex"),
      spanCount: spans.length,
      spans,
    };
  }

  private async maybeCaptureRuntimeCheckpoint(params: {
    task: Task;
    workspacePath: string;
    event: TaskEvent;
    legacyType?: string;
    legacyPayload: Record<string, unknown>;
  }): Promise<void> {
    const effectiveType =
      typeof params.legacyType === "string" && params.legacyType.trim().length > 0
        ? params.legacyType
        : params.event.type;
    const meaningfulEvents = this.collectMeaningfulExchangeEvents(params.task.id);
    const meaningfulExchangeCount = meaningfulEvents.length;
    const latestCheckpoint = await TranscriptStore.loadCheckpoint(params.workspacePath, params.task.id);
    const latestSnapshotEvent = [...this.getTaskEventsForReplay(params.task.id)]
      .reverse()
      .find((event) => {
        const type =
          typeof event.legacyType === "string" && event.legacyType.trim().length > 0
            ? event.legacyType
            : event.type;
        return type === "conversation_snapshot";
      });
    const latestSnapshotPayload =
      latestSnapshotEvent?.payload && typeof latestSnapshotEvent.payload === "object"
        ? (latestSnapshotEvent.payload as Record<string, unknown>)
        : undefined;

    if (effectiveType === "conversation_snapshot") {
      const summary = this.buildStructuredCheckpointSummary(params.task, params.legacyPayload);
      const evidencePacket = this.buildCheckpointEvidencePacket(
        params.task.id,
        meaningfulEvents.slice(-Math.max(1, Math.min(meaningfulExchangeCount, 12))),
      );
      const checkpointKind = this.getSnapshotSummaryBlock(params.legacyPayload)
        ? "pre_compaction"
        : "snapshot";
      await TranscriptStore.writeCheckpoint(params.workspacePath, params.task.id, {
        ...(params.legacyPayload as Record<string, unknown>),
        checkpointKind,
        sourceEventId: params.event.eventId,
        sourceTimestamp: params.event.timestamp,
        resumeStrategy: "checkpoint",
        structuredSummary: summary,
        evidencePacket,
        dedupeHash: evidencePacket.spanHash,
        sourceMetadata: {
          triggerEventType: effectiveType,
          meaningfulExchangeCount,
        },
      });
      return;
    }

    if (this.isMeaningfulExchangeEvent(effectiveType, params.legacyPayload) && meaningfulExchangeCount > 0) {
      const PERIODIC_EXCHANGE_INTERVAL = 12;
      if (meaningfulExchangeCount % PERIODIC_EXCHANGE_INTERVAL === 0) {
        const messageWindow = meaningfulEvents.slice(-PERIODIC_EXCHANGE_INTERVAL);
        const evidencePacket = this.buildCheckpointEvidencePacket(params.task.id, messageWindow);
        if (
          latestCheckpoint?.checkpointKind === "periodic" &&
          latestCheckpoint?.dedupeHash === evidencePacket.spanHash
        ) {
          return;
        }
        await TranscriptStore.writeCheckpoint(params.workspacePath, params.task.id, {
          ...(latestSnapshotPayload || {}),
          checkpointKind: "periodic",
          sourceEventId: params.event.eventId,
          sourceTimestamp: params.event.timestamp,
          resumeStrategy: "checkpoint",
          structuredSummary: this.buildStructuredCheckpointSummary(params.task, latestSnapshotPayload),
          evidencePacket,
          dedupeHash: evidencePacket.spanHash,
          sourceMetadata: {
            triggerEventType: effectiveType,
            meaningfulExchangeCount,
          },
        });
      }
      return;
    }

    if (effectiveType === "task_completed") {
      const hasMeaningfulOutcome = hasSubstantiveOutcomeEvidence({
        resultSummary: params.task.resultSummary,
        bestKnownOutcome: getTaskBestKnownOutcome(params.task),
      });
      if (!hasMeaningfulOutcome) {
        return;
      }
      const evidencePacket = this.buildCheckpointEvidencePacket(
        params.task.id,
        meaningfulEvents.slice(-Math.max(1, Math.min(meaningfulExchangeCount, 12))),
      );
      await TranscriptStore.writeCheckpoint(params.workspacePath, params.task.id, {
        ...(latestSnapshotPayload || {}),
        checkpointKind: "completion",
        sourceEventId: params.event.eventId,
        sourceTimestamp: params.event.timestamp,
        resumeStrategy: "checkpoint",
        structuredSummary: this.buildStructuredCheckpointSummary(params.task, latestSnapshotPayload),
        evidencePacket,
        dedupeHash: evidencePacket.spanHash,
        sourceMetadata: {
          triggerEventType: effectiveType,
          meaningfulExchangeCount,
        },
      });
    }
  }

  private scheduleMemoryConsolidation(task: Task): void {
    if (this.pendingMemoryConsolidations.has(task.workspaceId)) {
      return;
    }
    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace?.path) {
      return;
    }
    this.pendingMemoryConsolidations.add(task.workspaceId);
    setTimeout(() => {
      void MemoryConsolidator.run({
        workspaceId: task.workspaceId,
        workspacePath: workspace.path,
        taskId: task.id,
        taskPrompt: task.prompt,
      })
        .then((result) => {
          this.logEvent(task.id, "log", {
            message: result.skipped
              ? "Memory consolidation skipped"
              : "Memory consolidation completed",
            consolidation: result,
          });
        })
        .catch((error) => {
          this.logEvent(task.id, "error", {
            error: error instanceof Error ? error.message : String(error),
            source: "memory_consolidation",
          });
        })
        .finally(() => {
          this.pendingMemoryConsolidations.delete(task.workspaceId);
        });
    }, 1000);
  }

  private normalizeArtifactEventPayload(
    taskId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (type !== "artifact_created" && type !== "timeline_artifact_emitted") {
      return;
    }

    const rawPath =
      typeof payload.path === "string" && payload.path.trim().length > 0 ? payload.path.trim() : "";
    if (!rawPath) return;

    const isUrl = /^(https?:\/\/|file:\/\/)/i.test(rawPath);
    let normalizedPath = rawPath;

    if (!isUrl && !path.isAbsolute(rawPath)) {
      const task = this.taskRepo.findById(taskId);
      const workspace =
        task && typeof task.workspaceId === "string"
          ? this.workspaceRepo.findById(task.workspaceId)
          : undefined;
      const workspacePath =
        workspace && typeof workspace.path === "string" && workspace.path.trim().length > 0
          ? workspace.path.trim()
          : "";
      if (workspacePath) {
        normalizedPath = path.resolve(workspacePath, rawPath);
      }
    }

    payload.path = normalizedPath;

    const label =
      typeof payload.label === "string" && payload.label.trim().length > 0
        ? payload.label.trim()
        : "";
    if (!label) {
      if (isUrl) {
        payload.label = normalizedPath;
      } else {
        const baseName = path.basename(normalizedPath);
        payload.label = baseName || normalizedPath;
      }
    }
  }

  private getCurrentEventSeq(taskId: string): number {
    const cached = this.taskSeqById.get(taskId);
    if (typeof cached === "number") return cached;
    const fromDb = this.eventRepo.getLatestSeq(taskId);
    this.taskSeqById.set(taskId, fromDb);
    return fromDb;
  }

  private nextEventSeq(taskId: string): number {
    const next = this.getCurrentEventSeq(taskId) + 1;
    this.taskSeqById.set(taskId, next);
    return next;
  }

  private transitionTimelineStage(
    taskId: string,
    nextStage: TimelineStage,
    subStageLabel?: string,
  ): void {
    const currentStage = this.activeTimelineStageByTask.get(taskId);
    if (currentStage === nextStage) return;

    const timeline = createTimelineEmitter(taskId, (eventType, payload) => {
      this.logEvent(taskId, eventType, payload);
    });

    if (currentStage) {
      timeline.finishGroup(currentStage, {
        label: currentStage,
        actor: "system",
        legacyType: "step_completed",
      });
    }
    const groupLabel = subStageLabel ?? nextStage;
    timeline.startGroup(nextStage, {
      label: groupLabel,
      actor: "system",
      legacyType: "step_started",
      maxParallel:
        nextStage === "BUILD"
          ? Math.max(1, this.queueManager.getStatus().maxConcurrent || 1)
          : 1,
    });
    this.activeTimelineStageByTask.set(taskId, nextStage);
  }

  private normalizeStepIdForPlanTracking(rawStepId: string): string {
    return String(rawStepId || "")
      .trim()
      .replace(/^step:/i, "");
  }

  private isSyntheticNonPlanStepId(rawStepId: string): boolean {
    const stepId = String(rawStepId || "")
      .trim()
      .toLowerCase();
    if (!stepId) return true;
    return (
      stepId.startsWith("tool:") ||
      stepId.startsWith("tool_lane:") ||
      stepId.startsWith("command:") ||
      stepId.startsWith("task:") ||
      stepId.startsWith("timeline:") ||
      stepId.startsWith("completion_gate:") ||
      stepId.startsWith("evidence_gate:")
    );
  }

  private addKnownPlanStepId(taskId: string, rawStepId: string): void {
    const stepId = String(rawStepId || "").trim();
    if (!stepId || this.isSyntheticNonPlanStepId(stepId)) return;
    const knownStepIds = this.knownPlanStepIdsByTask.get(taskId) || new Set<string>();
    knownStepIds.add(stepId);
    this.knownPlanStepIdsByTask.set(taskId, knownStepIds);
  }

  private isKnownPlanStepId(taskId: string, rawStepId: string): boolean {
    const stepId = String(rawStepId || "").trim();
    if (!stepId || this.isSyntheticNonPlanStepId(stepId)) return false;
    const knownStepIds = this.knownPlanStepIdsByTask.get(taskId);
    if (!knownStepIds || knownStepIds.size === 0) return false;
    if (knownStepIds.has(stepId)) return true;
    const normalizedStepId = this.normalizeStepIdForPlanTracking(stepId);
    for (const candidate of knownStepIds) {
      if (this.normalizeStepIdForPlanTracking(candidate) === normalizedStepId) return true;
    }
    return false;
  }

  private trackTimelineStepState(taskId: string, event: TaskEvent): void {
    if (!isTimelineEventType(event.type)) return;
    const payloadObj =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    const effectiveLegacyType =
      typeof event.legacyType === "string"
        ? event.legacyType
        : typeof payloadObj.legacyType === "string"
          ? payloadObj.legacyType
          : "";
    const stepId = typeof event.stepId === "string" ? event.stepId : "";

    if (effectiveLegacyType === "plan_created" || effectiveLegacyType === "plan_revised") {
      const plan = (payloadObj as Any).plan;
      const steps = Array.isArray(plan?.steps) ? plan.steps : [];
      for (const step of steps) {
        if (typeof step?.id === "string") {
          this.addKnownPlanStepId(taskId, step.id);
        }
      }
    }
    if (event.type === "timeline_step_started" || event.type === "timeline_step_finished") {
      this.addKnownPlanStepId(taskId, stepId);
    }
    if (!stepId) return;

    const activeSteps = this.activeStepIdsByTask.get(taskId) || new Set<string>();
    const failedPlanSteps = this.failedPlanStepsByTask.get(taskId) || new Set<string>();
    const timelineErrors = this.timelineErrorsByTask.get(taskId) || new Set<string>();

    if (event.type === "timeline_step_started") {
      activeSteps.add(stepId);
    } else if (event.type === "timeline_step_finished") {
      const shouldIgnoreUnstartedMismatch =
        effectiveLegacyType === "task_completed" ||
        effectiveLegacyType === "task_cancelled" ||
        effectiveLegacyType === "step_skipped";

      if (!activeSteps.has(stepId) && event.status !== "failed" && !shouldIgnoreUnstartedMismatch) {
        this.timelineMetrics.stepStateMismatches += 1;
      }
      activeSteps.delete(stepId);
      if (event.status === "failed") {
        if (this.isKnownPlanStepId(taskId, stepId)) {
          failedPlanSteps.add(stepId);
          timelineErrors.delete(stepId);
        } else {
          timelineErrors.add(stepId);
        }
      } else if (
        event.status === "completed" ||
        event.status === "skipped" ||
        event.status === "cancelled"
      ) {
        failedPlanSteps.delete(stepId);
        timelineErrors.delete(stepId);
      }
    } else if (event.type === "timeline_error") {
      const isPlanFailureError =
        (effectiveLegacyType === "step_failed" || effectiveLegacyType === "step_timeout") &&
        this.isKnownPlanStepId(taskId, stepId);
      if (isPlanFailureError) {
        failedPlanSteps.add(stepId);
        timelineErrors.delete(stepId);
      } else {
        timelineErrors.add(stepId);
      }
    } else if (
      event.status === "completed" ||
      event.status === "skipped" ||
      event.status === "cancelled"
    ) {
      failedPlanSteps.delete(stepId);
      timelineErrors.delete(stepId);
    }

    if (activeSteps.size > 0) {
      this.activeStepIdsByTask.set(taskId, activeSteps);
    } else {
      this.activeStepIdsByTask.delete(taskId);
    }
    if (failedPlanSteps.size > 0) {
      this.failedPlanStepsByTask.set(taskId, failedPlanSteps);
    } else {
      this.failedPlanStepsByTask.delete(taskId);
    }
    if (timelineErrors.size > 0) {
      this.timelineErrorsByTask.set(taskId, timelineErrors);
    } else {
      this.timelineErrorsByTask.delete(taskId);
    }
  }

  private trackEvidenceRefs(taskId: string, event: TaskEvent): void {
    if (!isTimelineEventType(event.type)) return;
    if (event.type !== "timeline_evidence_attached") return;

    const refs = extractTimelineEvidenceRefs(event);
    if (refs.length === 0) return;

    const existing = this.evidenceRefsByTask.get(taskId) || new Map<string, EvidenceRef>();
    for (const ref of refs) {
      existing.set(ref.evidenceId, ref);
    }
    this.evidenceRefsByTask.set(taskId, existing);
  }

  getEvidenceRefsForTask(taskId: string): EvidenceRef[] {
    return Array.from((this.evidenceRefsByTask.get(taskId) || new Map()).values());
  }

  private persistTimelineEvent(
    event: TaskEvent,
    options: {
      legacyType?: string;
      legacyPayload?: Record<string, unknown>;
    } = {},
  ): void {
    const effectiveLegacyType = options.legacyType || event.legacyType;
    const effectiveLegacyPayload = options.legacyPayload || (event.payload as Record<string, unknown>);
    const effectiveType = effectiveLegacyType || event.type;

    this.eventRepo.create({
      id: event.id,
      taskId: event.taskId,
      timestamp: event.timestamp,
      type: event.type,
      payload: event.payload,
      schemaVersion: 2,
      eventId: event.eventId,
      seq: event.seq,
      ts: event.ts,
      status: event.status,
      stepId: event.stepId,
      groupId: event.groupId,
      actor: event.actor,
      legacyType: effectiveLegacyType as Any,
    });

    const task = this.taskRepo.findById(event.taskId);
    if (task && effectiveType === "llm_usage") {
      const usagePayload = effectiveLegacyPayload as {
        providerType?: string;
        modelKey?: string;
        modelId?: string;
        delta?: {
          inputTokens?: number;
          outputTokens?: number;
          cachedTokens?: number;
        };
      };
      recordLlmCallSuccess(
        {
          workspaceId: task.workspaceId,
          taskId: task.id,
          sourceKind: "task_event",
          sourceId: event.id,
          providerType: usagePayload.providerType,
          modelKey: usagePayload.modelKey,
          modelId: usagePayload.modelId,
          timestamp: event.timestamp,
        },
        {
          inputTokens: usagePayload.delta?.inputTokens || 0,
          outputTokens: usagePayload.delta?.outputTokens || 0,
          cachedTokens: usagePayload.delta?.cachedTokens || 0,
        },
      );
    } else if (task && effectiveType === "llm_error") {
      const errorPayload = effectiveLegacyPayload as {
        providerType?: string;
        modelKey?: string;
        modelId?: string;
        message?: string;
        details?: string;
      };
      recordLlmCallError(
        {
          workspaceId: task.workspaceId,
          taskId: task.id,
          sourceKind: "task_event",
          sourceId: event.id,
          providerType: errorPayload.providerType,
          modelKey: errorPayload.modelKey,
          modelId: errorPayload.modelId,
          timestamp: event.timestamp,
        },
        {
          code: "llm_error",
          message:
            typeof errorPayload.details === "string"
              ? `${errorPayload.message || "LLM error"} ${errorPayload.details}`.trim()
              : errorPayload.message || "LLM error",
        },
      );
    }

    if (effectiveLegacyType) {
      this.logActivityForEvent(event.taskId, effectiveLegacyType, effectiveLegacyPayload);
    } else {
      this.logActivityForEvent(event.taskId, event.type, event.payload);
    }

    this.emitTaskEvent(event);

    const teamThoughtEventTypes = new Set([
      "assistant_message",
      "tool_call",
      "step_completed",
      "file_created",
      "file_modified",
    ]);
    if (effectiveLegacyType && teamThoughtEventTypes.has(effectiveLegacyType)) {
      this.maybeEmitTeamThought(event.taskId, effectiveLegacyType, effectiveLegacyPayload);
    }

    const memoryType = effectiveLegacyType || event.type;
    this.captureToMemory(event.taskId, memoryType, effectiveLegacyPayload).catch((error) => {
      console.debug("[AgentDaemon] Memory capture failed:", error);
    });
  }

  /**
   * Check if a task event from a sub-agent task should be captured as a
   * collaborative thought for its team run.
   */
  private maybeEmitTeamThought(taskId: string, eventType: string, payload: Any): void {
    if (!this.teamOrchestrator) return;

    const task = this.taskRepo.findById(taskId);
    if (!task || !task.parentTaskId) return;

    const thoughtRepo = this.teamOrchestrator.getThoughtRepo();
    if (!thoughtRepo) return;

    const db = this.dbManager.getDatabase();
    const itemRepo = new AgentTeamItemRepository(db);
    const runRepo = new AgentTeamRunRepository(db);

    // Primary path: look up the team item linked to this child task
    let items = itemRepo.listBySourceTaskId(taskId);
    let run: AgentTeamRun | undefined;
    let teamItem: AgentTeamItem | undefined;

    if (items.length > 0) {
      teamItem = items[0];
      run = runRepo.findById(teamItem.teamRunId);
    }

    // Fallback: if no item found yet (race with sourceTaskId assignment),
    // try to find the run via the parent task (root task of the team run)
    if (!run && task.parentTaskId) {
      run = runRepo.findByRootTaskId(task.parentTaskId) || undefined;
      if (run) {
        // Find any item in this run to attach the thought to
        const runItems = itemRepo.listByRun(run.id);
        teamItem = runItems.find((i) => i.sourceTaskId === taskId) || runItems[0];
      }
    }

    if (!run || !run.collaborativeMode) return;

    // Capture thoughts during think, dispatch, and synthesize phases
    const phase = run.phase || "dispatch";
    if (phase !== "think" && phase !== "dispatch" && phase !== "synthesize") return;

    // Extract content based on event type
    let content = "";
    switch (eventType) {
      case "assistant_message":
        content =
          typeof payload?.message === "string" ? payload.message : String(payload?.content || "");
        break;
      case "tool_call":
        content = payload?.tool ? `🔧 Using tool: ${payload.tool}` : "";
        break;
      case "step_completed":
        content = payload?.step?.description
          ? `✅ Step completed: ${payload.step.description}`
          : "";
        break;
      case "file_created":
        content = payload?.path ? `📄 Created: ${payload.path}` : "";
        break;
      case "file_modified":
        content = payload?.path ? `✏️ Modified: ${payload.path}` : "";
        break;
      default:
        content = typeof payload?.message === "string" ? payload.message : "";
    }
    if (!content.trim()) return;

    // Determine agent identity based on mode
    let agentRoleId: string;
    let agentDisplayName: string;
    let agentIcon: string;
    let agentColor: string;

    if (run.multiLlmMode) {
      // Multi-LLM mode: derive identity from task's provider config
      const providerType = task.agentConfig?.providerType || "unknown";
      const modelKey = task.agentConfig?.modelKey || "default";
      const providerInfo = MULTI_LLM_PROVIDER_DISPLAY[providerType];
      agentRoleId = `multi-llm-${providerType}-${modelKey}`;
      agentDisplayName = providerInfo
        ? `${providerInfo.name} (${modelKey})`
        : `${providerType} (${modelKey})`;
      agentIcon = providerInfo?.icon || "\u{1F916}";
      agentColor = providerInfo?.color || "#6366f1";
    } else {
      // Standard collaborative mode: use agent role
      if (!task.assignedAgentRoleId) return;
      const role = this.agentRoleRepo.findById(task.assignedAgentRoleId);
      if (!role) return;
      agentRoleId = role.id;
      agentDisplayName = role.displayName;
      agentIcon = role.icon;
      agentColor = role.color;
    }

    try {
      const thought = thoughtRepo.create({
        teamRunId: run.id,
        teamItemId: teamItem?.id,
        agentRoleId,
        agentDisplayName,
        agentIcon,
        agentColor,
        phase: phase === "think" ? "analysis" : phase === "synthesize" ? "synthesis" : "dispatch",
        content: content.trim(),
        sourceTaskId: taskId,
      });

      // Emit to UI
      this.emitTeamThoughtEvent({
        type: "team_thought_added",
        timestamp: Date.now(),
        runId: run.id,
        thought,
      });
    } catch (error: Any) {
      console.error("[AgentDaemon] Team thought capture failed:", error?.message);
    }
  }

  private async handleOrchestrationNodeNotification(
    notification: OrchestrationNodeNotification,
  ): Promise<void> {
    const repo = this.getOrchestrationGraphRepository();
    const node = repo.findNodeById(notification.nodeId);
    if (!node?.teamItemId || !node.teamRunId) return;

    const itemRepo = new AgentTeamItemRepository(this.dbManager.getDatabase());
    const existing = itemRepo.findById(node.teamItemId);
    if (!existing) return;

    const nextStatus =
      notification.status === "completed"
        ? "done"
        : notification.status === "failed"
          ? "failed"
          : notification.status === "cancelled"
            ? "blocked"
            : "in_progress";

    const updated = itemRepo.update({
      id: existing.id,
      sourceTaskId: node.taskId || existing.sourceTaskId,
      status: nextStatus,
      resultSummary:
        notification.status === "running"
          ? existing.resultSummary
          : notification.result || notification.summary,
    });
    if (!updated) return;

    if (notification.status === "running" && node.taskId) {
      this.emitTeamRunEvent({
        type: "team_item_spawned",
        timestamp: Date.now(),
        runId: node.teamRunId,
        item: updated,
        spawnedTaskId: node.taskId,
      });
      return;
    }

    this.emitTeamRunEvent({
      type: "team_item_updated",
      timestamp: Date.now(),
      teamRunId: node.teamRunId,
      item: updated,
    });
    if (this.teamOrchestrator && notification.status !== "running") {
      await this.teamOrchestrator.tickRun(node.teamRunId, "graph_node_notification");
    }
  }

  /**
   * Broadcast a team thought event to all renderer windows.
   */
  private emitTeamThoughtEvent(event: TeamThoughtEvent): void {
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.TEAM_THOUGHT_EVENT, event);
        }
      } catch {
        // ignore
      }
    });
  }

  /**
   * Forward streaming progress from a child task to the collaborative/multi-LLM
   * thought panel as an ephemeral streaming indicator (no DB write).
   */
  private maybeEmitTeamStreamingProgress(taskId: string, payload: Any): void {
    if (!this.teamOrchestrator) return;

    const task = this.taskRepo.findById(taskId);
    if (!task || !task.parentTaskId) return;

    const db = this.dbManager.getDatabase();
    const itemRepo = new AgentTeamItemRepository(db);
    const runRepo = new AgentTeamRunRepository(db);

    // Find the run this child task belongs to
    let items = itemRepo.listBySourceTaskId(taskId);
    let run: AgentTeamRun | undefined;

    if (items.length > 0) {
      run = runRepo.findById(items[0].teamRunId);
    }

    // Fallback: look up via parent task
    if (!run && task.parentTaskId) {
      run = runRepo.findByRootTaskId(task.parentTaskId) || undefined;
    }

    if (!run || !run.collaborativeMode) return;

    // Only emit during think/dispatch phases (not synthesis)
    const phase = run.phase || "dispatch";
    if (phase !== "think" && phase !== "dispatch") return;

    // Derive agent identity
    let agentRoleId: string;
    let agentDisplayName: string;
    let agentIcon: string;
    let agentColor: string;

    if (run.multiLlmMode) {
      const providerType = task.agentConfig?.providerType || "unknown";
      const modelKey = task.agentConfig?.modelKey || "default";
      const providerInfo = MULTI_LLM_PROVIDER_DISPLAY[providerType];
      agentRoleId = `multi-llm-${providerType}-${modelKey}`;
      agentDisplayName = providerInfo
        ? `${providerInfo.name} (${modelKey})`
        : `${providerType} (${modelKey})`;
      agentIcon = providerInfo?.icon || "\u{1F916}";
      agentColor = providerInfo?.color || "#6366f1";
    } else {
      if (!task.assignedAgentRoleId) return;
      const role = this.agentRoleRepo.findById(task.assignedAgentRoleId);
      if (!role) return;
      agentRoleId = role.id;
      agentDisplayName = role.displayName;
      agentIcon = role.icon;
      agentColor = role.color;
    }

    const outputTokens = payload?.outputTokens ?? 0;
    const elapsedMs = payload?.elapsedMs ?? 0;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    const streaming = payload?.streaming !== false;

    // Build a synthetic (ephemeral) thought — not persisted to DB
    const syntheticThought = {
      id: `streaming-${taskId}`,
      teamRunId: run.id,
      agentRoleId,
      agentDisplayName,
      agentIcon,
      agentColor,
      phase: "analysis" as const,
      content: streaming
        ? `Generating response... (${outputTokens} tokens, ${elapsedSec}s)`
        : `Response complete (${outputTokens} tokens, ${elapsedSec}s)`,
      isStreaming: streaming,
      sourceTaskId: taskId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.emitTeamThoughtEvent({
      type: "team_thought_streaming",
      timestamp: Date.now(),
      runId: run.id,
      thought: syntheticThought as Any,
    });
  }

  /**
   * Capture task event to memory system for cross-session context
   */
  private async captureToMemory(taskId: string, type: string, payload: Any): Promise<void> {
    // Map event types to memory types
    const memoryTypeMap: Record<string, MemoryType> = {
      tool_call: "observation",
      tool_result: "observation",
      tool_error: "error",
      step_started: "observation",
      step_completed: "observation",
      step_failed: "error",
      assistant_message: "observation",
      user_message: "observation",
      user_feedback: "decision",
      plan_created: "decision",
      plan_revised: "decision",
      error: "error",
      verification_passed: "insight",
      verification_failed: "error",
      verification_pending_user_action: "insight",
      file_created: "observation",
      file_modified: "observation",
    };

    const memoryType = memoryTypeMap[type];
    if (!memoryType) return;

    // Guardrail: avoid storing high-volume diagnostic tool payloads in memory.
    // These create low-signal entries and trigger expensive background compression.
    const toolName = String(payload?.tool || payload?.name || "").trim();
    const skipMemoryToolNames = new Set([
      "task_events",
      "task_history",
      "search_memories",
      "search_sessions",
      "memory_topics_load",
      "memory_curated_read",
      "supermemory_profile",
      "supermemory_search",
      "supermemory_remember",
      "supermemory_forget",
      "scratchpad_read",
      "glob",
      "list_directory",
      "list_directory_with_sizes",
    ]);
    if ((type === "tool_call" || type === "tool_result") && skipMemoryToolNames.has(toolName)) {
      return;
    }

    if (type === "tool_call") {
      const inputPreview = JSON.stringify(payload?.input ?? {});
      if (inputPreview.length > 1500) return;
    }
    if (type === "tool_result") {
      const rawResult =
        typeof payload?.result === "string"
          ? payload.result
          : JSON.stringify(payload?.result ?? payload ?? {});
      if (rawResult.length > 1500) return;
    }

    const task = this.taskRepo.findById(taskId);
    if (!task) return;

    // Memory retention:
    // - Sub-agents (child tasks) default to retainMemory=false to avoid leaking sensitive
    //   private context into disposable agents.
    // - Shared gateway contexts (group/public) must never contribute injectable memories.
    const isSubAgentTask = (task.agentType ?? "main") === "sub" || !!task.parentTaskId;
    const retainMemory = task.agentConfig?.retainMemory ?? !isSubAgentTask;
    if (!retainMemory) return;
    const gatewayContext = task.agentConfig?.gatewayContext;
    const isSharedGatewayContext = gatewayContext === "group" || gatewayContext === "public";
    const allowProfileIngest =
      !isSharedGatewayContext || task.agentConfig?.allowSharedContextMemory === true;
    if (allowProfileIngest) {
      if (type === "user_message") {
        const text =
          (typeof payload?.message === "string" ? payload.message : "") ||
          (typeof payload?.content === "string" ? payload.content : "");
        if (text) {
          getAwarenessService().captureConversation(text, task.workspaceId, taskId);
          // Adaptive style observation — learns communication patterns from user messages
          AdaptiveStyleEngine.observe(text);

          // Mid-conversation correction detection: capture when the user corrects the agent.
          if (taskId && task.workspaceId && detectsCorrection(text)) {
            try {
              const correctionContent = [
                `[CORRECTION] User corrected agent during task "${task.title || taskId}"`,
                `User said: ${text.slice(0, 300)}`,
                `Task context: ${(task.prompt || "").slice(0, 200)}`,
              ].join("\n");
              MemoryService.capture(task.workspaceId, taskId, "insight", correctionContent).catch(
                () => {},
              );

              PlaybookService.captureOutcome(
                task.workspaceId,
                taskId,
                task.title || "unknown",
                task.prompt || "",
                "failure",
                "Agent approach was corrected by user mid-task",
                [],
                `[CORRECTION] ${text.slice(0, 200)}`,
              ).catch(() => {});
            } catch {
              // best-effort
            }
          }
        }
      } else if (type === "user_feedback") {
        const feedbackDecision = typeof payload?.decision === "string" ? payload.decision : undefined;
        const feedbackReason = typeof payload?.reason === "string" ? payload.reason : undefined;
        getAwarenessService().captureFeedback(feedbackReason, task.workspaceId, taskId);
        // Adaptive style observation — learns from explicit feedback signals
        AdaptiveStyleEngine.observeFeedback(feedbackDecision, feedbackReason);
      }
    }
    if (isSharedGatewayContext && task.agentConfig?.allowSharedContextMemory !== true) {
      return;
    }

    // Build content string based on event type
    let content = "";
    if (type === "tool_call") {
      content = `Tool called: ${payload.tool || payload.name}\nInput: ${JSON.stringify(payload.input, null, 2)}`;
    } else if (type === "tool_result") {
      const result =
        typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result);
      content = `Tool result for ${payload.tool || payload.name}:\n${result}`;
    } else if (type === "tool_error") {
      content = `Tool error for ${payload.tool || payload.name}: ${payload.error}`;
    } else if (type === "assistant_message") {
      content = payload.content || payload.message || JSON.stringify(payload);
    } else if (type === "user_message") {
      content = payload.message || payload.content || JSON.stringify(payload);
    } else if (type === "user_feedback") {
      const decision = payload?.decision ? `Decision: ${payload.decision}` : "Feedback received";
      const reason = payload?.reason ? `\nReason: ${payload.reason}` : "";
      content = `${decision}${reason}`;
    } else if (type === "plan_created" || type === "plan_revised") {
      content = `Plan ${type === "plan_revised" ? "revised" : "created"}:\n${JSON.stringify(payload.plan || payload, null, 2)}`;
    } else if (type === "step_completed") {
      content = `Step completed: ${payload.step?.description || JSON.stringify(payload)}`;
    } else if (type === "step_failed") {
      content = `Step failed: ${payload.step?.description || ""}\nError: ${payload.error || "Unknown error"}`;
    } else if (type === "file_created" || type === "file_modified") {
      content = `File ${type === "file_created" ? "created" : "modified"}: ${payload.path}`;
    } else if (type === "verification_passed") {
      content = `Verification passed: ${payload.message || "Task completed successfully"}`;
    } else if (type === "verification_failed") {
      content = `Verification failed: ${payload.message || payload.error || "Unknown failure"}`;
    } else {
      content = JSON.stringify(payload);
    }

    // Truncate very long content
    if (content.length > 5000) {
      content = content.slice(0, 5000) + "\n[... truncated]";
    }

    const forcePrivate = gatewayContext === "group" || gatewayContext === "public";
    await MemoryService.capture(task.workspaceId, taskId, memoryType, content, forcePrivate);
  }

  /**
   * Log notable task events to the Activity feed
   */
  private logActivityForEvent(taskId: string, type: string, payload: Any): void {
    const task = this.taskRepo.findById(taskId);
    if (!task) return;

    // Throttle high-frequency activity types to reduce database writes
    if (THROTTLED_ACTIVITY_TYPES.has(type)) {
      const throttleKey = `${taskId}:${type}`;
      const now = Date.now();
      const lastTime = this.activityThrottle.get(throttleKey);

      if (lastTime && now - lastTime < ACTIVITY_THROTTLE_WINDOW_MS) {
        // Skip this activity - too soon after the last one of the same type
        return;
      }

      this.activityThrottle.set(throttleKey, now);

      // Clean up old throttle entries periodically (keep map from growing unbounded)
      if (this.activityThrottle.size > 1000) {
        const cutoff = now - ACTIVITY_THROTTLE_WINDOW_MS * 10;
        for (const [key, time] of this.activityThrottle) {
          if (time < cutoff) {
            this.activityThrottle.delete(key);
          }
        }
      }
    }

    const activity = this.buildActivityFromEvent(task, type, payload);
    if (!activity) return;

    const created = this.activityRepo.create(activity);
    this.emitActivityEvent(created);
  }

  private buildActivityFromEvent(
    task: Task,
    type: string,
    payload: Any,
  ): CreateActivityRequest | undefined {
    const actorType: ActivityActorType = task.assignedAgentRoleId ? "agent" : "system";
    const agentRoleId = task.assignedAgentRoleId;
    const activityType = type as ActivityType;

    switch (type) {
      case "task_created":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "Task created",
          description: task.title,
        };
      case "task_completed":
        {
          const summary = [
            typeof payload?.resultSummary === "string" ? payload.resultSummary.trim() : "",
            typeof payload?.semanticSummary === "string" ? payload.semanticSummary.trim() : "",
          ]
            .filter((value) => value.length > 0)
            .join(" · ");
          const verificationVerdict =
            typeof payload?.verificationVerdict === "string"
              ? payload.verificationVerdict.trim()
              : "";
          const verificationReport =
            typeof payload?.verificationReport === "string"
              ? payload.verificationReport.trim()
              : "";
          const verificationSuffix =
            verificationVerdict || verificationReport
              ? [
                  verificationVerdict ? `Verification: ${verificationVerdict}` : "",
                  verificationReport ? verificationReport : "",
                ]
                  .filter((value) => value.length > 0)
                  .join(" — ")
              : "";
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "Task completed",
          description:
            [summary, verificationSuffix].filter((value) => value.length > 0).join(" · ") ||
            task.title,
          metadata: {
            ...(payload || {}),
            activityKind: "task_completed",
          },
        };
        }
      case "learning_progress":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "What Cowork learned",
          description: payload?.summary || task.title,
          metadata: {
            ...(payload || {}),
            activityKind: "learning_progress",
          },
        };
      case "shell_session_created":
      case "shell_session_updated":
      case "shell_session_reset":
      case "shell_session_closed":
      case "llm_routing_changed":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title:
            type === "llm_routing_changed"
              ? "Model routing updated"
              : type === "shell_session_reset"
                ? "Shell session reset"
                : type === "shell_session_closed"
                  ? "Shell session closed"
                  : "Shell session updated",
          description: payload?.message || payload?.summary || task.title,
          metadata: {
            ...(payload || {}),
            activityKind: type,
          },
        };
      case "executing":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "task_started",
          title: "Task started",
          description: task.title,
        };
      case "task_cancelled":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Task cancelled",
          description: task.title,
        };
      case "task_paused":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "Task paused",
          description: task.title,
        };
      case "task_resumed":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "Task resumed",
          description: task.title,
        };
      case "approval_requested":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Approval requested",
          description: payload?.approval?.description || task.title,
        };
      case "approval_granted":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Approval granted",
          description: task.title,
        };
      case "approval_denied":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Approval denied",
          description: payload?.reason || task.title,
        };
      case "error":
      case "step_failed":
      case "verification_failed":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "error",
          title: type === "error" ? "Task error" : "Execution issue",
          description:
            payload?.report ||
            payload?.error ||
            payload?.message ||
            payload?.step?.description ||
            task.title,
        };
      case "verification_pending_user_action":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Verification pending user action",
          description: payload?.message || task.title,
        };
      case "verification_passed":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Verification passed",
          description: payload?.report || payload?.message || task.title,
        };
      case "file_created":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "File created",
          description: payload?.path || task.title,
        };
      case "file_modified":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "File modified",
          description: payload?.path || task.title,
        };
      case "file_deleted":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "File deleted",
          description: payload?.path || task.title,
        };
      case "tool_call":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "tool_used",
          title: "Tool used",
          description: payload?.tool || payload?.name || task.title,
        };
      default:
        return undefined;
    }
  }

  /**
   * Register an artifact (file created during task execution)
   * This allows files like screenshots to be sent back to the user
   */
  registerArtifact(taskId: string, filePath: string, mimeType: string): void {
    try {
      if (!fs.existsSync(filePath)) {
        console.error(`[AgentDaemon] Artifact file not found: ${filePath}`);
        return;
      }

      const stats = fs.statSync(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");

      this.artifactRepo.create({
        taskId,
        path: filePath,
        mimeType,
        sha256,
        size: stats.size,
        createdAt: Date.now(),
      });

      console.log(`[AgentDaemon] Registered artifact: ${filePath}`);
    } catch (error) {
      console.error(`[AgentDaemon] Failed to register artifact:`, error);
    }
  }

  /**
   * Emit event to renderer process and local listeners
   */
  private emitTaskEvent(event: TaskEvent): void {
    const timelineEnvelope = {
      id: event.id,
      taskId: event.taskId,
      type: event.type,
      payload: event.payload,
      timestamp: event.timestamp,
      schemaVersion: event.schemaVersion || 2,
      eventId: event.eventId || event.id,
      seq: event.seq,
      ts: event.ts || event.timestamp,
      status: event.status,
      stepId: event.stepId,
      groupId: event.groupId,
      actor: event.actor,
      legacyType: event.legacyType,
    };
    const payloadObj =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    const payloadLegacyType =
      payloadObj && typeof payloadObj.legacyType === "string" ? payloadObj.legacyType : "";
    const effectiveType =
      typeof event.legacyType === "string" && event.legacyType.trim().length > 0
        ? event.legacyType.trim()
        : typeof payloadLegacyType === "string" && payloadLegacyType.trim().length > 0
          ? payloadLegacyType.trim()
          : event.type;
    const suppressRendererBroadcast =
      AgentDaemon.RENDERER_SUPPRESSED_EVENT_TYPES.has(effectiveType);

    // Emit timeline event to local EventEmitter listeners.
    try {
      this.emit(event.type, timelineEnvelope);
    } catch (error) {
      console.error(`[AgentDaemon] Error emitting timeline event ${event.type}:`, error);
    }

    // Compatibility bridge: emit legacy aliases for subscribers that still
    // listen on legacy event names (assistant_message/task_completed/etc).
    const legacyAlias = this.resolveLegacyTaskEventAlias(event);
    const shouldEmitLegacyAlias =
      !!legacyAlias && !(legacyAlias.type === "error" && this.listenerCount("error") === 0);
    if (legacyAlias && shouldEmitLegacyAlias) {
      try {
        this.emit(legacyAlias.type, {
          taskId: event.taskId,
          ...legacyAlias.payload,
        });
      } catch (error) {
        console.error(
          `[AgentDaemon] Error emitting legacy alias event ${legacyAlias.type}:`,
          error,
        );
      }
    }

    // Emit to renderer process via IPC
    if (!suppressRendererBroadcast) {
      const windows = getAllElectronWindows();
      windows.forEach((window) => {
        // Check if window is still valid before sending
        try {
          if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.TASK_EVENT, timelineEnvelope);
            if (effectiveType === "learning_progress") {
              window.webContents.send(IPC_CHANNELS.TASK_LEARNING_EVENT, event.payload);
            }
            if (effectiveType === "llm_routing_changed") {
              window.webContents.send(IPC_CHANNELS.LLM_ROUTING_EVENT, event.payload);
            }
          }
        } catch (error) {
          // Window might have been destroyed between check and send
          console.error(`[AgentDaemon] Error sending IPC to window:`, error);
        }
      });
    }
  }

  private resolveLegacyTaskEventAlias(event: TaskEvent): {
    type: string;
    payload: Record<string, unknown>;
  } | null {
    const payloadObj =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? ({ ...(event.payload as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const legacyType =
      typeof event.legacyType === "string" && event.legacyType.trim().length > 0
        ? event.legacyType.trim()
        : typeof payloadObj.legacyType === "string" && payloadObj.legacyType.trim().length > 0
          ? payloadObj.legacyType.trim()
          : "";

    if (!legacyType || legacyType === event.type || legacyType.startsWith("timeline_")) {
      return null;
    }

    delete payloadObj.legacyType;
    return {
      type: legacyType,
      payload: payloadObj,
    };
  }

  /**
   * Update task status
   */
  updateTaskStatus(taskId: string, status: Task["status"]): void {
    const existing = this.taskRepo.findById(taskId);
    const currentStatus = existing ? deriveCanonicalTaskStatus(existing) : undefined;
    if (isTerminalTaskStatus(currentStatus) && !isTerminalTaskStatus(status)) {
      return;
    }
    this.taskRepo.update(taskId, { status });
    if (status === "completed" || status === "failed" || status === "cancelled") {
      this.clearTimelineTaskState(taskId);
      this.clearRetryState(taskId);
      if (this.teamOrchestrator && existing?.status !== status) {
        void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
      }
    }
  }

  /**
   * Get agent role by ID
   */
  getAgentRoleById(agentRoleId: string): AgentRole | undefined {
    return this.agentRoleRepo.findById(agentRoleId);
  }

  getActiveAgentRoles(): AgentRole[] {
    return this.agentRoleRepo.findActive();
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.taskRepo.findById(taskId);
  }

  private getTaskEventsForReplay(taskId: string): TaskEvent[] {
    if (!this.completionTelemetryBackfilledTaskIds.has(taskId)) {
      this.backfillTaskCompletionTelemetry(taskId);
      this.completionTelemetryBackfilledTaskIds.add(taskId);
    }
    return this.eventRepo.findByTaskId(taskId);
  }

  private resolveLegacyEventType(event: TaskEvent): string {
    return typeof event.legacyType === "string" && event.legacyType.length > 0
      ? event.legacyType
      : event.type;
  }

  private isLegacyEventType(event: TaskEvent, expected: string): boolean {
    return this.resolveLegacyEventType(event) === expected;
  }

  private clearTimelineTaskState(taskId: string): void {
    this.activeTimelineStageByTask.delete(taskId);
    this.activeStepIdsByTask.delete(taskId);
    this.failedPlanStepsByTask.delete(taskId);
    this.timelineErrorsByTask.delete(taskId);
    this.knownPlanStepIdsByTask.delete(taskId);
    this.evidenceRefsByTask.delete(taskId);
    this.lastKnownLlmProviderByTask.delete(taskId);
    this.taskSeqById.delete(taskId);
    this.completionTelemetryBackfilledTaskIds.delete(taskId);
  }

  getTaskEvents(taskId: string, options?: { limit?: number; types?: string[] }): TaskEvent[] {
    const all = this.eventRepo.findByTaskId(taskId);
    const normalizedTypes = (options?.types || [])
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter(Boolean);
    const filtered =
      normalizedTypes.length > 0
        ? all.filter(
            (event) =>
              normalizedTypes.includes(event.type) ||
              (typeof event.legacyType === "string" && normalizedTypes.includes(event.legacyType)),
          )
        : all;
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.min(Math.max(options.limit, 1), 200)
        : undefined;
    if (typeof limit !== "number") {
      return filtered;
    }
    // Return the most recent events, preserving chronological order.
    return filtered.slice(Math.max(filtered.length - limit, 0));
  }

  /**
   * Query recent task history across the local database.
   * Intended for answering questions like "what did we talk about yesterday?".
   *
   * Note: This is intentionally read-only and returns truncated text to avoid huge payloads.
   */
  queryTaskHistory(params: {
    period: "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";
    from?: string | number;
    to?: string | number;
    limit?: number;
    workspaceId?: string;
    query?: string;
    includeMessages?: boolean;
  }):
    | {
        success: true;
        period: string;
        range: { startMs: number; endMs: number; startIso: string; endIso: string };
        tasks: Any[];
      }
    | { success: false; error: string } {
    try {
      const period = params?.period;
      if (!period) {
        return { success: false, error: "Missing required field: period" };
      }

      const clampLimit = (value: unknown): number => {
        const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 20;
        return Math.min(Math.max(n, 1), 50);
      };

      const truncate = (value: unknown, maxChars: number): string => {
        const s = typeof value === "string" ? value : "";
        if (!s) return "";
        if (s.length <= maxChars) return s;
        return s.slice(0, maxChars) + "…";
      };

      const now = new Date();
      const startOfDayMs = (d: Date): number =>
        new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

      const parseTime = (v: unknown): number | null => {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v !== "string") return null;
        const raw = v.trim();
        if (!raw) return null;
        const dt = new Date(raw);
        const ms = dt.getTime();
        return Number.isFinite(ms) ? ms : null;
      };

      const nowMs = now.getTime();
      const todayStart = startOfDayMs(now);

      let startMs: number;
      let endMs: number;

      switch (period) {
        case "today": {
          startMs = todayStart;
          endMs = todayStart + 24 * 60 * 60 * 1000;
          break;
        }
        case "yesterday": {
          endMs = todayStart;
          startMs = endMs - 24 * 60 * 60 * 1000;
          break;
        }
        case "last_7_days": {
          startMs = nowMs - 7 * 24 * 60 * 60 * 1000;
          endMs = nowMs;
          break;
        }
        case "last_30_days": {
          startMs = nowMs - 30 * 24 * 60 * 60 * 1000;
          endMs = nowMs;
          break;
        }
        case "custom": {
          const fromMs = parseTime(params?.from);
          const toMs = parseTime(params?.to);
          if (fromMs != null && toMs != null) {
            startMs = fromMs;
            endMs = toMs;
          } else if (fromMs != null) {
            startMs = fromMs;
            endMs = nowMs;
          } else if (toMs != null) {
            endMs = toMs;
            startMs = endMs - 24 * 60 * 60 * 1000;
          } else {
            startMs = nowMs - 7 * 24 * 60 * 60 * 1000;
            endMs = nowMs;
          }
          break;
        }
        default: {
          return { success: false, error: `Unsupported period: ${String(period)}` };
        }
      }

      // Guard against inverted ranges.
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return { success: false, error: "Invalid time range" };
      }

      const limit = clampLimit(params?.limit);
      const workspaceId =
        typeof params?.workspaceId === "string" ? params.workspaceId.trim() : undefined;
      const query = typeof params?.query === "string" ? params.query.trim() : undefined;
      const includeMessages = params?.includeMessages !== false;

      const tasks = this.taskRepo.findByCreatedAtRange({
        startMs,
        endMs,
        limit,
        workspaceId,
        query,
      });

      const taskIds = tasks.map((t) => t.id);
      const messageEvents =
        includeMessages && taskIds.length > 0
          ? this.eventRepo.findByTaskIds(taskIds, ["assistant_message", "user_message"])
          : [];

      const lastAssistant = new Map<string, string>();
      const lastUser = new Map<string, string>();
      for (const evt of messageEvents) {
        const msg = (evt.payload as Any)?.message ?? (evt.payload as Any)?.content;
        const text = typeof msg === "string" ? msg : "";
        if (!text) continue;
        if (evt.type === "assistant_message") lastAssistant.set(evt.taskId, truncate(text, 900));
        if (evt.type === "user_message") lastUser.set(evt.taskId, truncate(text, 900));
      }

      const items = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        workspaceId: t.workspaceId,
        createdAtMs: t.createdAt,
        createdAtIso: new Date(t.createdAt).toISOString(),
        prompt: truncate(t.prompt, 700),
        lastUserMessage: includeMessages ? lastUser.get(t.id) : undefined,
        lastAssistantMessage: includeMessages ? lastAssistant.get(t.id) : undefined,
      }));

      return {
        success: true,
        period,
        range: {
          startMs,
          endMs,
          startIso: new Date(startMs).toISOString(),
          endIso: new Date(endMs).toISOString(),
        },
        tasks: items,
      };
    } catch (error: Any) {
      return { success: false, error: error?.message ? String(error.message) : String(error) };
    }
  }

  /**
   * Query task event logs from the local database (tool calls/results, messages, feedback, file ops).
   * This is privacy-sensitive and may be blocked in shared gateway contexts.
   */
  queryTaskEvents(params: {
    period: "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";
    from?: string | number;
    to?: string | number;
    limit?: number;
    workspaceId?: string;
    types?: string[];
    includePayload?: boolean;
  }):
    | {
        success: true;
        period: string;
        range: { startMs: number; endMs: number; startIso: string; endIso: string };
        stats: Any;
        events: Any[];
      }
    | { success: false; error: string } {
    try {
      const period = params?.period;
      if (!period) {
        return { success: false, error: "Missing required field: period" };
      }

      const clampLimit = (value: unknown): number => {
        const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 200;
        return Math.min(Math.max(n, 1), 500);
      };

      const truncate = (value: unknown, maxChars: number): string => {
        const s = typeof value === "string" ? value : "";
        if (!s) return "";
        if (s.length <= maxChars) return s;
        return s.slice(0, maxChars) + "…";
      };

      const now = new Date();
      const startOfDayMs = (d: Date): number =>
        new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

      const parseTime = (v: unknown): number | null => {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v !== "string") return null;
        const raw = v.trim();
        if (!raw) return null;
        const dt = new Date(raw);
        const ms = dt.getTime();
        return Number.isFinite(ms) ? ms : null;
      };

      const nowMs = now.getTime();
      const todayStart = startOfDayMs(now);

      let startMs: number;
      let endMs: number;

      switch (period) {
        case "today": {
          startMs = todayStart;
          endMs = todayStart + 24 * 60 * 60 * 1000;
          break;
        }
        case "yesterday": {
          endMs = todayStart;
          startMs = endMs - 24 * 60 * 60 * 1000;
          break;
        }
        case "last_7_days": {
          startMs = nowMs - 7 * 24 * 60 * 60 * 1000;
          endMs = nowMs;
          break;
        }
        case "last_30_days": {
          startMs = nowMs - 30 * 24 * 60 * 60 * 1000;
          endMs = nowMs;
          break;
        }
        case "custom": {
          const fromMs = parseTime(params?.from);
          const toMs = parseTime(params?.to);
          if (fromMs != null && toMs != null) {
            startMs = fromMs;
            endMs = toMs;
          } else if (fromMs != null) {
            startMs = fromMs;
            endMs = nowMs;
          } else if (toMs != null) {
            endMs = toMs;
            // Default to last hour when only end is provided (used by scheduled digests).
            startMs = endMs - 60 * 60 * 1000;
          } else {
            // Default to last hour for custom when no bounds provided.
            startMs = nowMs - 60 * 60 * 1000;
            endMs = nowMs;
          }
          break;
        }
        default: {
          return { success: false, error: `Unsupported period: ${String(period)}` };
        }
      }

      // Guard against inverted ranges.
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return { success: false, error: "Invalid time range" };
      }

      const limit = clampLimit(params?.limit);
      const workspaceId = typeof params?.workspaceId === "string" ? params.workspaceId.trim() : "";
      const workspaceFilter = workspaceId.length > 0 ? workspaceId : undefined;
      const normalizedTypes = Array.isArray(params?.types)
        ? params.types
            .map((t) => (typeof t === "string" ? t.trim() : ""))
            .filter(Boolean)
            .slice(0, 50)
        : [];
      const includePayload = params?.includePayload !== false;

      const db = this.dbManager.getDatabase();

      let sql = `
        SELECT
          e.id as id,
          e.task_id as taskId,
          e.timestamp as timestamp,
          e.type as type,
          e.legacy_type as legacy_type,
          e.payload as payload,
          t.title as taskTitle,
          t.workspace_id as workspaceId
        FROM task_events e
        JOIN tasks t ON t.id = e.task_id
        WHERE e.timestamp >= ? AND e.timestamp < ?
      `;

      const args: Any[] = [startMs, endMs];
      if (workspaceFilter) {
        sql += " AND t.workspace_id = ?";
        args.push(workspaceFilter);
      }
      if (normalizedTypes.length > 0) {
        const placeholders = normalizedTypes.map(() => "?").join(", ");
        sql += ` AND (e.type IN (${placeholders}) OR e.legacy_type IN (${placeholders}))`;
        args.push(...normalizedTypes, ...normalizedTypes);
      }

      sql += " ORDER BY e.timestamp ASC LIMIT ?";
      args.push(limit);

      const rows = db.prepare(sql).all(...args) as Array<{
        id: string;
        taskId: string;
        timestamp: number;
        type: string;
        legacy_type?: string;
        payload: string;
        taskTitle: string;
        workspaceId: string;
      }>;

      const byType: Record<string, number> = {};
      const toolCallsByName: Record<string, number> = {};
      const feedbackByDecision: Record<string, number> = {};
      const tasksTouched = new Set<string>();
      let assistantMessages = 0;
      let userMessages = 0;
      let toolCalls = 0;
      let toolErrors = 0;
      let filesCreated = 0;
      let filesModified = 0;
      let filesDeleted = 0;

      const parseJson = (raw: unknown): Any => {
        if (typeof raw !== "string" || !raw) return {};
        try {
          const obj = JSON.parse(raw);
          return obj && typeof obj === "object" ? obj : {};
        } catch {
          return {};
        }
      };

      const compactPayloadPreview = (payload: Any): string => {
        if (!payload || typeof payload !== "object") return "";
        const keys = Object.keys(payload).slice(0, 12);
        const preview: Record<string, Any> = {};
        for (const k of keys) {
          const v = (payload as Any)[k];
          if (typeof v === "string") preview[k] = truncate(v, 260);
          else if (typeof v === "number" || typeof v === "boolean") preview[k] = v;
          else if (v && typeof v === "object") preview[k] = "[object]";
          else preview[k] = v;
        }
        const rendered = JSON.stringify(preview);
        return truncate(rendered, 520);
      };

      const summarizeEvent = (type: string, payload: Any): string => {
        switch (type) {
          case "tool_call": {
            const tool = (payload?.tool || payload?.name || "").toString();
            return tool ? `Tool call: ${tool}` : "Tool call";
          }
          case "tool_result": {
            const tool = (payload?.tool || payload?.name || "").toString();
            return tool ? `Tool result: ${tool}` : "Tool result";
          }
          case "tool_error": {
            const tool = (payload?.tool || payload?.name || "").toString();
            const err = typeof payload?.error === "string" ? payload.error : "";
            return truncate(
              tool
                ? `Tool error: ${tool}${err ? ` - ${err}` : ""}`
                : `Tool error${err ? ` - ${err}` : ""}`,
              520,
            );
          }
          case "assistant_message": {
            const text =
              (typeof payload?.message === "string" ? payload.message : "") ||
              (typeof payload?.content === "string" ? payload.content : "");
            return text ? `Assistant: ${truncate(text, 260)}` : "Assistant message";
          }
          case "user_message": {
            const text =
              (typeof payload?.message === "string" ? payload.message : "") ||
              (typeof payload?.content === "string" ? payload.content : "");
            return text ? `User: ${truncate(text, 260)}` : "User message";
          }
          case "user_feedback": {
            const decision = typeof payload?.decision === "string" ? payload.decision : "";
            const reason = typeof payload?.reason === "string" ? payload.reason : "";
            return truncate(
              `Feedback: ${decision || "unknown"}${reason ? ` - ${reason}` : ""}`,
              520,
            );
          }
          case "file_created":
          case "file_modified":
          case "file_deleted": {
            const p = typeof payload?.path === "string" ? payload.path : "";
            return p ? `${type.replace("_", " ")}: ${truncate(p, 320)}` : type.replace("_", " ");
          }
          case "step_started":
          case "step_completed":
          case "step_failed": {
            const desc =
              typeof payload?.step?.description === "string" ? payload.step.description : "";
            const err = typeof payload?.error === "string" ? payload.error : "";
            const base = desc ? `${type.replace("_", " ")}: ${desc}` : type.replace("_", " ");
            return truncate(err ? `${base} - ${err}` : base, 520);
          }
          default: {
            return type;
          }
        }
      };

      const events = rows.map((row) => {
        const effectiveType = (row.legacy_type || row.type || "").toString();
        tasksTouched.add(row.taskId);
        byType[effectiveType] = (byType[effectiveType] || 0) + 1;

        const payloadObj = parseJson(row.payload);

        if (effectiveType === "assistant_message") assistantMessages += 1;
        if (effectiveType === "user_message") userMessages += 1;
        if (effectiveType === "tool_call") {
          toolCalls += 1;
          const tool = (payloadObj?.tool || payloadObj?.name || "").toString().trim();
          if (tool) {
            toolCallsByName[tool] = (toolCallsByName[tool] || 0) + 1;
          }
        }
        if (effectiveType === "tool_error") toolErrors += 1;

        if (effectiveType === "file_created") filesCreated += 1;
        if (effectiveType === "file_modified") filesModified += 1;
        if (effectiveType === "file_deleted") filesDeleted += 1;

        if (effectiveType === "user_feedback") {
          const decision =
            typeof payloadObj?.decision === "string" ? payloadObj.decision.trim() : "unknown";
          const key = decision || "unknown";
          feedbackByDecision[key] = (feedbackByDecision[key] || 0) + 1;
        }

        return {
          id: row.id,
          taskId: row.taskId,
          taskTitle: row.taskTitle,
          workspaceId: row.workspaceId,
          timestampMs: row.timestamp,
          timestampIso: new Date(row.timestamp).toISOString(),
          type: effectiveType,
          summary: summarizeEvent(effectiveType, payloadObj),
          ...(includePayload ? { payloadPreview: compactPayloadPreview(payloadObj) } : {}),
        };
      });

      // Sort tools by usage desc, keep top 30 for readability.
      const toolsUsed = Object.entries(toolCallsByName)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 30)
        .reduce(
          (acc, [k, v]) => {
            acc[k] = v;
            return acc;
          },
          {} as Record<string, number>,
        );

      const stats = {
        totalEvents: rows.length,
        tasksTouched: tasksTouched.size,
        byType,
        messageCounts: {
          user: userMessages,
          assistant: assistantMessages,
        },
        toolCalls: {
          total: toolCalls,
          errors: toolErrors,
          byTool: toolsUsed,
        },
        fileOps: {
          created: filesCreated,
          modified: filesModified,
          deleted: filesDeleted,
        },
        feedback: {
          byDecision: feedbackByDecision,
        },
      };

      return {
        success: true,
        period,
        range: {
          startMs,
          endMs,
          startIso: new Date(startMs).toISOString(),
          endIso: new Date(endMs).toISOString(),
        },
        stats,
        events,
      };
    } catch (error: Any) {
      return { success: false, error: error?.message ? String(error.message) : String(error) };
    }
  }

  /**
   * Update task workspace ID in database
   */
  updateTaskWorkspace(taskId: string, workspaceId: string): void {
    this.taskRepo.update(taskId, { workspaceId });
  }

  /**
   * Get workspace by ID
   */
  getWorkspaceById(id: string): Workspace | undefined {
    return this.workspaceRepo.findById(id);
  }

  /**
   * Get workspace by path
   */
  getWorkspaceByPath(path: string): Workspace | undefined {
    return this.workspaceRepo.findByPath(path);
  }

  /**
   * Update workspace permissions and return the refreshed workspace.
   */
  updateWorkspacePermissions(
    workspaceId: string,
    patch: Partial<WorkspacePermissions>,
  ): Workspace | undefined {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) return undefined;
    const updatedPermissions: WorkspacePermissions = {
      ...workspace.permissions,
      ...patch,
    };
    this.workspaceRepo.updatePermissions(workspaceId, updatedPermissions);
    const refreshed = this.workspaceRepo.findById(workspaceId);
    this.refreshActiveExecutorsForWorkspace(workspaceId);
    return refreshed;
  }

  /**
   * Refresh active task executors that use the given workspace.
   * Called when workspace permissions change (e.g. Shell toggled in UI) so
   * executors pick up new tool availability (e.g. run_command when shell enabled).
   */
  refreshActiveExecutorsForWorkspace(workspaceId: string): void {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) return;

    let refreshed = 0;
    this.activeTasks.forEach((cached, taskId) => {
      if (cached.status !== "active" || !cached.executor) return;
      if (cached.executor.getWorkspaceId?.() !== workspaceId) return;
      try {
        cached.executor.updateWorkspace(workspace);
        refreshed++;
      } catch (err) {
        console.warn(`[AgentDaemon] Failed to refresh executor for task ${taskId}:`, err);
      }
    });
    if (refreshed > 0) {
      console.log(
        `[AgentDaemon] Refreshed ${refreshed} active executor(s) for workspace ${workspace.name} (permissions updated)`,
      );
    }
  }

  /**
   * Get the most recently used non-temporary workspace, if any.
   */
  getMostRecentNonTempWorkspace(): Workspace | undefined {
    const workspaces = this.workspaceRepo.findAll();
    return workspaces.find(
      (workspace) =>
        !isTempWorkspaceId(workspace.id) &&
        !workspace.isTemp &&
        typeof workspace.path === "string" &&
        workspace.path.trim().length > 0,
    );
  }

  /**
   * List all workspaces known to this daemon.
   */
  listWorkspaces(): Workspace[] {
    return this.workspaceRepo.findAll();
  }

  /**
   * List projects from the control-plane database.
   * Optionally filter to only active projects.
   */
  listProjects(opts?: { includeArchived?: boolean }): Project[] {
    const core = new ControlPlaneCoreService(this.dbManager.getDatabase());
    return core.listProjects({ includeArchived: opts?.includeArchived ?? false });
  }

  /**
   * Link a workspace to a project in the control-plane database.
   * Creates the link if it doesn't exist; updates isPrimary if it does.
   */
  linkProjectWorkspace(input: {
    projectId: string;
    workspaceId: string;
    isPrimary?: boolean;
  }): ProjectWorkspaceLink {
    const core = new ControlPlaneCoreService(this.dbManager.getDatabase());
    return core.linkProjectWorkspace(input);
  }

  /**
   * List workspace links for a project.
   */
  listProjectWorkspaces(projectId: string): ProjectWorkspaceLink[] {
    const core = new ControlPlaneCoreService(this.dbManager.getDatabase());
    return core.listProjectWorkspaces(projectId);
  }

  /**
   * List goals from the control-plane database.
   */
  listGoals(companyId?: string): Goal[] {
    const core = new ControlPlaneCoreService(this.dbManager.getDatabase());
    return core.listGoals(companyId);
  }

  /**
   * List issues from the control-plane database with optional filters.
   */
  listIssues(filters?: IssueFilters): Issue[] {
    const core = new ControlPlaneCoreService(this.dbManager.getDatabase());
    return core.listIssues(filters);
  }

  /**
   * Create an issue in the control-plane database.
   */
  createIssue(input: Partial<Issue> & Pick<Issue, "title">): Issue {
    const core = new ControlPlaneCoreService(this.dbManager.getDatabase());
    return core.createIssue(input);
  }

  /**
   * Create a new workspace with default permissions
   */
  createWorkspace(name: string, path: string): Workspace {
    const defaultPermissions: WorkspacePermissions = {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    };
    return this.workspaceRepo.create(name, path, defaultPermissions);
  }

  /**
   * Update task fields (for retry/verification attempt tracking, etc.)
   */
  updateTask(
    taskId: string,
    updates: Partial<
      Pick<
        Task,
        | "currentAttempt"
        | "status"
        | "error"
        | "completedAt"
        | "terminalStatus"
        | "failureClass"
        | "awaitingUserInputReasonCode"
        | "budgetUsage"
        | "continuationCount"
        | "continuationWindow"
        | "lifetimeTurnsUsed"
        | "lastProgressScore"
        | "autoContinueBlockReason"
        | "compactionCount"
        | "lastCompactionAt"
        | "lastCompactionTokensBefore"
        | "lastCompactionTokensAfter"
        | "noProgressStreak"
        | "lastLoopFingerprint"
        | "bestKnownOutcome"
      >
    >,
  ): void {
    const existing = this.taskRepo.findById(taskId);
    const currentStatus = existing ? deriveCanonicalTaskStatus(existing) : undefined;
    if (isTerminalTaskStatus(currentStatus) && updates.status && !isTerminalTaskStatus(updates.status)) {
      return;
    }
    this.taskRepo.update(taskId, updates);
    if (
      updates.status === "completed" ||
      updates.status === "failed" ||
      updates.status === "cancelled"
    ) {
      this.clearRetryState(taskId);
      if (this.teamOrchestrator && existing?.status !== updates.status) {
        void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
      }
    }
  }

  failTask(
    taskId: string,
    errorMessage: string,
    metadata?: Partial<
      Pick<
        Task,
        | "completedAt"
        | "resultSummary"
        | "terminalStatus"
        | "failureClass"
        | "budgetUsage"
        | "continuationCount"
        | "continuationWindow"
        | "lifetimeTurnsUsed"
        | "lastProgressScore"
        | "autoContinueBlockReason"
        | "compactionCount"
        | "lastCompactionAt"
        | "lastCompactionTokensBefore"
        | "lastCompactionTokensAfter"
        | "noProgressStreak"
        | "lastLoopFingerprint"
        | "bestKnownOutcome"
        | "semanticSummary"
        | "verificationVerdict"
        | "verificationReport"
      >
    >,
  ): void {
    const existingTask = this.taskRepo.findById(taskId);
    const currentStatus = existingTask ? deriveCanonicalTaskStatus(existingTask) : undefined;
    if (isTerminalTaskStatus(currentStatus)) {
      return;
    }

    this.cleanupPendingApprovalsForTask(taskId, "Task ended before the approval request was resolved.");

    const completedAt = metadata?.completedAt ?? Date.now();
    const terminalStatus = metadata?.terminalStatus ?? "failed";
    const updates: Partial<Task> = {
      status: "failed",
      error: errorMessage,
      completedAt,
      terminalStatus,
      ...(typeof metadata?.resultSummary === "string" && metadata.resultSummary.trim().length > 0
        ? { resultSummary: metadata.resultSummary.trim() }
        : {}),
      ...(metadata?.failureClass !== undefined ? { failureClass: metadata.failureClass } : {}),
      ...(metadata?.budgetUsage !== undefined ? { budgetUsage: metadata.budgetUsage } : {}),
      ...(metadata?.continuationCount !== undefined
        ? { continuationCount: metadata.continuationCount }
        : {}),
      ...(metadata?.continuationWindow !== undefined
        ? { continuationWindow: metadata.continuationWindow }
        : {}),
      ...(metadata?.lifetimeTurnsUsed !== undefined
        ? { lifetimeTurnsUsed: metadata.lifetimeTurnsUsed }
        : {}),
      ...(metadata?.lastProgressScore !== undefined
        ? { lastProgressScore: metadata.lastProgressScore }
        : {}),
      ...(metadata?.autoContinueBlockReason !== undefined
        ? { autoContinueBlockReason: metadata.autoContinueBlockReason }
        : {}),
      ...(metadata?.compactionCount !== undefined ? { compactionCount: metadata.compactionCount } : {}),
      ...(metadata?.lastCompactionAt !== undefined
        ? { lastCompactionAt: metadata.lastCompactionAt }
        : {}),
      ...(metadata?.lastCompactionTokensBefore !== undefined
        ? { lastCompactionTokensBefore: metadata.lastCompactionTokensBefore }
        : {}),
      ...(metadata?.lastCompactionTokensAfter !== undefined
        ? { lastCompactionTokensAfter: metadata.lastCompactionTokensAfter }
        : {}),
      ...(metadata?.noProgressStreak !== undefined ? { noProgressStreak: metadata.noProgressStreak } : {}),
      ...(metadata?.lastLoopFingerprint !== undefined
        ? { lastLoopFingerprint: metadata.lastLoopFingerprint }
        : {}),
      ...(metadata?.bestKnownOutcome !== undefined ? { bestKnownOutcome: metadata.bestKnownOutcome } : {}),
      ...(typeof metadata?.semanticSummary === "string" && metadata.semanticSummary.trim().length > 0
        ? { semanticSummary: metadata.semanticSummary.trim() }
        : {}),
      ...(metadata?.verificationVerdict !== undefined
        ? { verificationVerdict: metadata.verificationVerdict }
        : {}),
      ...(typeof metadata?.verificationReport === "string" &&
      metadata.verificationReport.trim().length > 0
        ? { verificationReport: metadata.verificationReport.trim() }
        : {}),
    };

    this.taskRepo.update(taskId, updates);
    this.clearRetryState(taskId);

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.status = "completed";
      cached.lastAccessed = Date.now();
    }

    this.logEvent(taskId, "task_status", {
      status: "failed",
      message: errorMessage,
      terminalStatus,
      ...(typeof metadata?.resultSummary === "string" && metadata.resultSummary.trim().length > 0
        ? { resultSummary: metadata.resultSummary.trim() }
        : {}),
      ...(metadata?.failureClass ? { failureClass: metadata.failureClass } : {}),
      ...(metadata?.bestKnownOutcome !== undefined
        ? { bestKnownOutcome: metadata.bestKnownOutcome }
        : {}),
      ...(metadata?.budgetUsage !== undefined ? { budgetUsage: metadata.budgetUsage } : {}),
      ...(typeof metadata?.semanticSummary === "string" && metadata.semanticSummary.trim().length > 0
        ? { semanticSummary: metadata.semanticSummary.trim() }
        : {}),
      ...(metadata?.verificationVerdict !== undefined
        ? { verificationVerdict: metadata.verificationVerdict }
        : {}),
      ...(typeof metadata?.verificationReport === "string" &&
      metadata.verificationReport.trim().length > 0
        ? { verificationReport: metadata.verificationReport.trim() }
        : {}),
    });

    if (this.teamOrchestrator) {
      void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
    }
    this.clearTimelineTaskState(taskId);
    this.finishQueueSlot(taskId);
  }

  cancelTaskRecord(
    taskId: string,
    message: string,
    metadata?: {
      completedAt?: number;
      errorMessage?: string | null;
    },
  ): void {
    const existing = this.taskRepo.findById(taskId);
    const currentStatus = existing ? deriveCanonicalTaskStatus(existing) : undefined;
    if (isTerminalTaskStatus(currentStatus)) {
      return;
    }

    this.cleanupPendingApprovalsForTask(taskId, "Task ended before the approval request was resolved.");

    const completedAt = metadata?.completedAt ?? Date.now();
    const errorMessage =
      metadata && Object.prototype.hasOwnProperty.call(metadata, "errorMessage")
        ? metadata.errorMessage
        : null;

    this.taskRepo.update(taskId, {
      status: "cancelled",
      completedAt,
      error: errorMessage,
      terminalStatus: undefined,
      failureClass: undefined,
    });
    this.clearRetryState(taskId);
    this.clearTimelineTaskState(taskId);

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.status = "completed";
      cached.lastAccessed = Date.now();
    }

    this.logEvent(taskId, "task_status", {
      status: "cancelled",
      message,
      ...(typeof errorMessage === "string" && errorMessage.trim().length > 0
        ? { error: errorMessage }
        : {}),
    });
    this.logEvent(taskId, "task_cancelled", {
      message,
    });

    if (this.teamOrchestrator && existing?.status !== "cancelled") {
      void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
    }
  }

  private clearRetryState(taskId: string): void {
    const pending = this.pendingRetries.get(taskId);
    if (pending) {
      clearTimeout(pending);
      this.pendingRetries.delete(taskId);
    }
    this.retryCounts.delete(taskId);
  }

  private runQuickQualityPass(params: {
    resultSummary?: string;
    outputSummary?: TaskOutputSummary;
    explicitEvidenceRequired: boolean;
    strictCompletionContract: boolean;
    riskReasons: string[];
    verificationEvidenceBundle?: TaskVerificationEvidenceBundle;
  }): { passed: boolean; issues: string[] } {
    const issues: string[] = [];
    const summary = params.resultSummary?.trim() || "";
    if (!summary) {
      issues.push("missing_result_summary");
    } else if (summary.length < 20) {
      issues.push("result_summary_too_short");
    }

    const hasArtifactEvidence =
      (params.outputSummary?.created?.length || 0) > 0 ||
      (params.outputSummary?.modifiedFallback?.length || 0) > 0;
    if (params.explicitEvidenceRequired && !hasArtifactEvidence) {
      issues.push("missing_artifact_or_file_evidence");
    }
    if (params.explicitEvidenceRequired && params.riskReasons.includes("tests_expected_without_evidence")) {
      issues.push("tests_expected_without_execution_evidence");
    }
    if (params.explicitEvidenceRequired && params.verificationEvidenceBundle) {
      const hasSuccessfulVerificationEvidence = params.verificationEvidenceBundle.entries.some((entry) => entry.ok);
      if (!hasSuccessfulVerificationEvidence) {
        issues.push("missing_successful_verification_evidence");
      }
    }
    if (params.strictCompletionContract && summary.length < 60) {
      issues.push("strict_mode_requires_more_complete_summary");
    }

    return {
      passed: issues.length === 0,
      issues,
    };
  }

  private getUnresolvedFailedSteps(taskId: string): string[] {
    const failedPlanSteps = this.failedPlanStepsByTask.get(taskId);
    if (!failedPlanSteps || failedPlanSteps.size === 0) return [];

    const unresolved: string[] = [];
    const ignoredNonPlanIds: string[] = [];
    for (const stepId of failedPlanSteps.values()) {
      if (this.isKnownPlanStepId(taskId, stepId)) {
        unresolved.push(stepId);
      } else {
        ignoredNonPlanIds.push(stepId);
      }
    }

    if (ignoredNonPlanIds.length > 0) {
      this.logEvent(taskId, "log", {
        metric: "non_plan_failed_step_filtered",
        ignoredFailedStepIds: ignoredNonPlanIds.slice(0, 50),
        ignoredCount: ignoredNonPlanIds.length,
      });
    }

    return unresolved.sort();
  }

  private isTaskCompletedTimelineEvent(event: TaskEvent): boolean {
    if (event.type !== "timeline_step_finished") return false;
    if (typeof event.legacyType === "string" && event.legacyType === "task_completed") {
      return true;
    }
    const payloadObj =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    return payloadObj.legacyType === "task_completed";
  }

  private compareEventOrder(a: TaskEvent, b: TaskEvent): number {
    const aSeq =
      typeof a.seq === "number" && Number.isFinite(a.seq) && a.seq > 0 ? Math.floor(a.seq) : undefined;
    const bSeq =
      typeof b.seq === "number" && Number.isFinite(b.seq) && b.seq > 0 ? Math.floor(b.seq) : undefined;
    if (typeof aSeq === "number" && typeof bSeq === "number" && aSeq !== bSeq) {
      return aSeq - bSeq;
    }
    const aTs =
      typeof a.ts === "number" && Number.isFinite(a.ts) ? a.ts : Number(a.timestamp) || 0;
    const bTs =
      typeof b.ts === "number" && Number.isFinite(b.ts) ? b.ts : Number(b.timestamp) || 0;
    if (aTs !== bTs) return aTs - bTs;
    return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0);
  }

  private computeTimelineTelemetryFromEvents(events: TaskEvent[]): {
    timeline_event_drop_rate: number;
    timeline_order_violation_rate: number;
    step_state_mismatch_rate: number;
    completion_gate_block_count: number;
    evidence_gate_fail_count: number;
  } {
    const sorted = [...events].sort((a, b) => this.compareEventOrder(a, b));
    const activeSteps = new Set<string>();
    let totalEvents = 0;
    let droppedEvents = 0;
    let orderViolations = 0;
    let stepStateMismatches = 0;
    let completionGateBlocks = 0;
    let evidenceGateFails = 0;

    for (const event of sorted) {
      if (!isTimelineEventType(event.type)) continue;
      totalEvents += 1;

      const payloadObj =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      const effectiveLegacyType =
        typeof event.legacyType === "string"
          ? event.legacyType
          : typeof payloadObj.legacyType === "string"
            ? payloadObj.legacyType
            : "";
      const gate = typeof payloadObj.gate === "string" ? payloadObj.gate : "";

      if (
        event.type === "timeline_error" &&
        (typeof payloadObj.rejectedSeq === "number" ||
          String(payloadObj.message || "").toLowerCase().includes("out-of-order"))
      ) {
        orderViolations += 1;
        droppedEvents += 1;
      }
      if (gate === "completion_failed_step_gate") {
        completionGateBlocks += 1;
      }
      if (
        gate === "key_claim_evidence_gate" &&
        event.type === "timeline_step_updated" &&
        event.status === "blocked"
      ) {
        evidenceGateFails += 1;
      }

      const stepId = typeof event.stepId === "string" ? event.stepId : "";
      if (!stepId) continue;

      if (event.type === "timeline_step_started") {
        activeSteps.add(stepId);
        continue;
      }

      if (event.type === "timeline_step_finished") {
        const shouldIgnoreUnstartedMismatch =
          effectiveLegacyType === "task_completed" ||
          effectiveLegacyType === "task_cancelled" ||
          effectiveLegacyType === "step_skipped";
        if (!activeSteps.has(stepId) && event.status !== "failed" && !shouldIgnoreUnstartedMismatch) {
          stepStateMismatches += 1;
        }
        activeSteps.delete(stepId);
        continue;
      }

      if (
        event.status === "completed" ||
        event.status === "skipped" ||
        event.status === "cancelled"
      ) {
        activeSteps.delete(stepId);
      }
    }

    return {
      timeline_event_drop_rate: totalEvents > 0 ? droppedEvents / totalEvents : 0,
      timeline_order_violation_rate: totalEvents > 0 ? orderViolations / totalEvents : 0,
      step_state_mismatch_rate: totalEvents > 0 ? stepStateMismatches / totalEvents : 0,
      completion_gate_block_count: completionGateBlocks,
      evidence_gate_fail_count: evidenceGateFails,
    };
  }

  private backfillTaskCompletionTelemetry(taskId: string): void {
    const updatePayloadById =
      typeof (this.eventRepo as Any).updatePayloadById === "function"
        ? (this.eventRepo as Any).updatePayloadById.bind(this.eventRepo)
        : null;
    if (!updatePayloadById) return;

    const events = this.eventRepo.findByTaskId(taskId);
    if (events.length === 0) return;

    const completionEvents = events.filter((event) => this.isTaskCompletedTimelineEvent(event));
    if (completionEvents.length === 0) return;

    let updated = 0;
    for (const completionEvent of completionEvents) {
      const payloadObj =
        completionEvent.payload &&
        typeof completionEvent.payload === "object" &&
        !Array.isArray(completionEvent.payload)
          ? ({ ...(completionEvent.payload as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      const boundarySeq =
        typeof completionEvent.seq === "number" && Number.isFinite(completionEvent.seq)
          ? completionEvent.seq
          : undefined;
      const boundaryTs =
        typeof completionEvent.ts === "number" && Number.isFinite(completionEvent.ts)
          ? completionEvent.ts
          : completionEvent.timestamp;

      const snapshot = events.filter((event) => {
        const eventSeq =
          typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : undefined;
        const eventTs =
          typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : event.timestamp;
        if (typeof boundarySeq === "number" && typeof eventSeq === "number") {
          return eventSeq <= boundarySeq;
        }
        return eventTs <= boundaryTs;
      });

      const telemetry = this.computeTimelineTelemetryFromEvents(snapshot);
      const existingTelemetry =
        payloadObj.telemetry && typeof payloadObj.telemetry === "object" && !Array.isArray(payloadObj.telemetry)
          ? (payloadObj.telemetry as Record<string, unknown>)
          : null;

      const shouldUpdate =
        !existingTelemetry ||
        Number(existingTelemetry.timeline_event_drop_rate) !== telemetry.timeline_event_drop_rate ||
        Number(existingTelemetry.timeline_order_violation_rate) !==
          telemetry.timeline_order_violation_rate ||
        Number(existingTelemetry.step_state_mismatch_rate) !== telemetry.step_state_mismatch_rate ||
        Number(existingTelemetry.completion_gate_block_count) !==
          telemetry.completion_gate_block_count ||
        Number(existingTelemetry.evidence_gate_fail_count) !== telemetry.evidence_gate_fail_count;
      if (!shouldUpdate) continue;

      payloadObj.telemetry = {
        ...telemetry,
        telemetry_source: "backfill_v2",
      };
      updatePayloadById(completionEvent.id, payloadObj);
      updated += 1;
    }

    if (updated > 0) {
      console.log(
        `[AgentDaemon] Backfilled completion telemetry for ${updated} event(s) in task ${taskId}`,
      );
    }
  }

  private extractKeyClaimSentences(summary: string): string[] {
    const trimmed = summary.trim();
    if (!trimmed) return [];
    const normalizePiece = (piece: string): string =>
      piece
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
    const isInstructionLike = (piece: string): boolean =>
      /^(?:add|assign|audit|check|compare|confirm|create|extract|identify|label|make|queue|record|replace|report|review|run|score|set|state|track|update|use|validate|verify|write)\b/i.test(
        piece,
      );
    const isStructuralListScaffold = (piece: string): boolean => {
      const normalized = normalizePiece(piece);
      if (!normalized) return true;
      if (/^(?:\d+[.)]?|[ivxlcdm]+[.)]?)$/i.test(normalized)) return true;
      if (isInstructionLike(normalized)) return true;
      return /^(?:fascinations|useful tools|signals to watch|next experiment|definition of done|required action|completion gate|operating rule|done condition|file|files|result|results|rule|rules|priority|target|verification):?$/i.test(
        normalized,
      );
    };
    const pieces = trimmed
      .split(/(?<=[.!?])\s+/)
      .map((piece) => piece.trim())
      .filter(Boolean);
    const comparativeSignalRe =
      /\b(less|greater|higher|lower|faster|slower|increase|decrease|median|percentile|best|worst|before|after)\b/i;
    const measurableSignalRe =
      /(\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?%\b|\$?\d[\d,]*(?:\.\d+)?\s*(?:bytes?|kb|mb|gb|tasks?|files?|runs?|steps?|days?|hours?|minutes?|items?|sources?|errors?)\b)/i;
    const declarativeSignalRe =
      /\b(is|are|was|were|has|have|had|contains?|contained|includes?|included|shows?|reported|measured?|equals?|reached|remains?|exists?)\b/i;
    return pieces.filter((piece) => {
      if (isStructuralListScaffold(piece)) return false;
      const normalized = normalizePiece(piece);
      if (comparativeSignalRe.test(normalized)) return true;
      return measurableSignalRe.test(normalized) && declarativeSignalRe.test(normalized);
    });
  }

  private hasEvidenceForKeyClaims(
    taskId: string,
    summary?: string,
    verificationEvidenceBundle?: TaskVerificationEvidenceBundle,
  ): {
    passed: boolean;
    keyClaims: string[];
  } {
    const text = typeof summary === "string" ? summary : "";
    const keyClaims = this.extractKeyClaimSentences(text);
    if (keyClaims.length === 0) return { passed: true, keyClaims: [] };

    const evidenceRefs = this.evidenceRefsByTask.get(taskId);
    if (evidenceRefs && evidenceRefs.size > 0) return { passed: true, keyClaims };

    const hasSuccessfulVerificationEvidence =
      verificationEvidenceBundle?.entries?.some((entry) => Boolean(entry?.ok)) ?? false;
    if (hasSuccessfulVerificationEvidence) return { passed: true, keyClaims };

    const tokenEvidenceRe = /\[(?:evidence|source|cite):[^\]]+\]|\[[0-9]+\]|https?:\/\//i;
    const markdownLinkEvidenceRe = /\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\)/i;
    const labeledEvidenceLineRe =
      /(?:^|\n)\s*(?:sources?|references?|citations?|evidence)\s*:\s*.*(?:\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\)|https?:\/\/|(?:\/|\.{0,2}\/)[^\s,]+:\d+)/im;
    return {
      passed:
        tokenEvidenceRe.test(text) ||
        markdownLinkEvidenceRe.test(text) ||
        labeledEvidenceLineRe.test(text),
      keyClaims,
    };
  }

  private async runPostCompletionVerification(
    parentTask: Task,
    parentSummary?: string,
    verificationEvidenceBundle?: TaskVerificationEvidenceBundle,
    timeoutMs = 120_000,
  ): Promise<void> {
    if (parentTask.parentTaskId || (parentTask.agentType ?? "main") !== "main") return;
    const currentDepth = parentTask.depth ?? 0;
    if (currentDepth >= 3) return;

    const verificationRuntime = createVerificationRuntime({
      runReadOnlyChildTaskAndWait: (params) =>
        this.runReadOnlyChildTaskAndWait({
          ...params,
          workerRole: "verifier",
        }),
    });
    const result = await verificationRuntime.run({
      parentTask,
      parentSummary,
      verificationEvidenceBundle,
      timeoutMs,
    });
    if (!result.gated) return;

    const eventType = result.verdict === "PASS" ? "verification_passed" : "verification_failed";
    this.logEvent(parentTask.id, eventType, {
      source: "post_completion_review_gate",
      childTaskId: result.childTaskId,
      message:
        result.verdict === "PASS"
          ? "Post-completion verifier confirmed deliverables."
          : "Post-completion verifier found issues.",
      report: result.report.slice(0, 2000),
      verificationVerdict: result.verdict,
    });

    const taskUpdates: Partial<Task> = {
      verificationVerdict: result.verdict,
      verificationReport: result.report,
    };
    if (result.verdict === "FAIL" || (result.verdict === "PARTIAL" && result.shouldBlock)) {
      taskUpdates.terminalStatus = "failed";
      taskUpdates.failureClass = "required_verification";
    } else if (result.verdict === "PARTIAL") {
      taskUpdates.terminalStatus = "partial_success";
    }
    this.taskRepo.update(parentTask.id, taskUpdates);
  }

  /**
   * Read-only post-task entropy sweep (stale docs, contradictions, dead-code hints).
   * Non-blocking; does not downgrade parent terminal status on ISSUES (first rollout).
   */
  private async runPostTaskEntropySweep(
    parentTask: Task,
    params: {
      historicalEvents: TaskEvent[];
      outputSummary?: TaskOutputSummary;
      parentSummary?: string;
    },
    timeoutMs = 120_000,
  ): Promise<void> {
    if (parentTask.parentTaskId || (parentTask.agentType ?? "main") !== "main") return;

    const currentDepth = parentTask.depth ?? 0;
    if (currentDepth >= 3) return;

    const blastRadius = collectBlastRadiusPaths(params.historicalEvents, params.outputSummary, 60);
    const sweepPrompt = buildEntropySweepPrompt({
      task: parentTask,
      blastRadiusPaths: blastRadius,
      resultSummary: params.parentSummary,
    });

    const result = await this.runReadOnlyChildTaskAndWait({
      parentTask,
      title: `Entropy sweep: ${parentTask.title}`.slice(0, 200),
      prompt: sweepPrompt,
      timeoutMs,
      workerRole: "researcher",
      agentConfig: {
        maxTurns: 14,
        llmProfile: "strong",
        llmProfileForced: true,
        verificationAgent: false,
        reviewPolicy: "off",
        entropySweepPolicy: "off",
      },
    });
    if (result.status === "completed") {
      const text = result.summary || "";
      const clean = /ENTROPY:\s*CLEAN/i.test(text) || /\bNO_ISSUES_FOUND\b/i.test(text);
      this.logEvent(parentTask.id, "entropy_sweep_completed", {
        source: "post_completion_entropy_sweep",
        childTaskId: result.childTaskId,
        blastRadiusCount: blastRadius.length,
        clean,
        summary: text.slice(0, 2000),
      });
      return;
    }
    if (result.status === "failed" || result.status === "cancelled") {
      this.logEvent(parentTask.id, "entropy_sweep_failed", {
        source: "post_completion_entropy_sweep",
        childTaskId: result.childTaskId,
        message: `Entropy sweep ${result.status}.`,
        summary: String(result.summary || "").slice(0, 2000),
      });
      return;
    }

    this.logEvent(parentTask.id, "entropy_sweep_failed", {
      source: "post_completion_entropy_sweep",
      childTaskId: result.childTaskId,
      message: "Entropy sweep timed out.",
      timeoutMs,
    });
  }

  async runReadOnlyChildTaskAndWait(params: {
    parentTask: Task;
    title: string;
    prompt: string;
    timeoutMs?: number;
    agentConfig?: AgentConfig;
    workerRole?: WorkerRoleKind;
  }): Promise<{
    childTaskId: string;
    status: "completed" | "failed" | "cancelled" | "timeout" | "missing";
    summary: string;
  }> {
    const timeoutMs = params.timeoutMs ?? 120_000;
    const currentDepth = params.parentTask.depth ?? 0;
    const childTask = await this.createChildTask({
      title: params.title,
      prompt: params.prompt,
      workspaceId: params.parentTask.workspaceId,
      parentTaskId: params.parentTask.id,
      agentType: "sub",
      depth: currentDepth + 1,
        agentConfig: {
          autonomousMode: true,
          allowUserInput: false,
          retainMemory: false,
          conversationMode: "task",
          verificationAgent: false,
          toolRestrictions: ["group:write", "group:destructive", "group:image"],
          ...(params.agentConfig || {}),
        },
        workerRole: params.workerRole,
      });

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const child = this.taskRepo.findById(childTask.id);
      if (!child) {
        return {
          childTaskId: childTask.id,
          status: "missing",
          summary: "",
        };
      }
      if (child.status === "completed" || child.status === "failed" || child.status === "cancelled") {
        return {
          childTaskId: childTask.id,
          status: child.status,
          summary: String(child.resultSummary || ""),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return {
      childTaskId: childTask.id,
      status: "timeout",
      summary: "",
    };
  }

  /**
   * Mark task as completed
   * Note: We keep the executor in memory for follow-up messages (with TTL-based cleanup)
   */
  completeTask(
    taskId: string,
    resultSummary?: string,
    metadata?: {
      terminalStatus?: Task["terminalStatus"];
      failureClass?: Task["failureClass"];
      budgetUsage?: Task["budgetUsage"];
      outputSummary?: TaskOutputSummary;
      waiveFailedStepIds?: string[];
      failedMutationRequiredStepIds?: string[];
      waivedVerificationStepIds?: string[];
      terminalStatusReason?: string;
      nonBlockingFailedStepIds?: string[];
      bestKnownOutcome?: Task["bestKnownOutcome"];
      verificationOutcome?: VerificationOutcome;
      verificationScope?: VerificationScope;
      verificationEvidenceMode?: VerificationEvidenceMode;
      pendingChecklist?: string[];
      verificationMessage?: string;
      /** Deterministic checks run in verified mode (shell, files, http, etc.) */
      verificationEvidenceBundle?: TaskVerificationEvidenceBundle;
      semanticSummary?: string;
      verificationVerdict?: VerificationVerdict;
      verificationReport?: string;
    },
  ): void {
    const existingTask = this.taskRepo.findById(taskId);
    if (!existingTask) {
      console.warn(`[AgentDaemon] completeTask called for unknown task ${taskId}`);
      return;
    }
    const currentStatus = deriveCanonicalTaskStatus(existingTask);
    if (isTerminalTaskStatus(currentStatus)) {
      return;
    }

    this.cleanupPendingApprovalsForTask(taskId, "Task ended before the approval request was resolved.");

    const isChatSession =
      existingTask.agentConfig?.executionMode === "chat" &&
      existingTask.agentConfig?.executionModeSource === "user";
    if (isChatSession) {
      const completedAt = Date.now();
      this.taskRepo.update(taskId, {
        status: "completed",
        completedAt,
        error: null,
        terminalStatus: undefined,
        failureClass: undefined,
        resultSummary: undefined,
        bestKnownOutcome: undefined,
        budgetUsage: metadata?.budgetUsage,
        coreOutcome: undefined,
        dependencyOutcome: undefined,
        failureDomains: undefined,
        stopReasons: undefined,
      });
      this.clearRetryState(taskId);
      this.clearTimelineTaskState(taskId);
      const cached = this.activeTasks.get(taskId);
      if (cached) {
        cached.status = "completed";
        cached.lastAccessed = Date.now();
      }
      this.logEvent(taskId, "task_status", {
        status: "completed",
        message: resultSummary || "Chat turn completed",
      });
      this.finishQueueSlot(taskId);
      return;
    }

    const normalizeStepIdForComparison = (raw: string): string =>
      String(raw || "")
        .trim()
        .replace(/^step:/i, "");
    const isVerificationDescription = (description: string): boolean => {
      const desc = String(description || "")
        .trim()
        .toLowerCase();
      if (!desc) return false;
      if (desc.startsWith("verify")) return true;
      if (desc.startsWith("verification")) return true;
      if (desc.startsWith("review")) {
        const hasMutationVerb =
          /\b(tighten|edit|fix|update|rewrite|revise|modify|change|improve|refactor|clean|polish|rework|adjust|correct|enhance|optimize|replace|remove|add|implement|apply|write|create|draft|generate|save)\b/.test(
            desc,
          );
        return !hasMutationVerb;
      }
      return desc.includes("verify:") || desc.includes("verification") || desc.includes("verify ");
    };
    const historicalEvents = this.getTaskEventsForReplay(taskId);
    const trimmedSummary =
      typeof resultSummary === "string" && resultSummary.trim().length > 0
        ? resultSummary.trim()
        : undefined;
    const bestKnownOutcome = metadata?.bestKnownOutcome || getTaskBestKnownOutcome(existingTask);
    const unresolvedFailedSteps = this.getUnresolvedFailedSteps(taskId);
    const timelineErrorStepIds = Array.from(this.timelineErrorsByTask.get(taskId) || new Set<string>())
      .map((id) => String(id || "").trim())
      .filter((id) => id.length > 0)
      .sort();
    const waivedFailedStepIds = new Set(
      (metadata?.waiveFailedStepIds || [])
        .map((id) => String(id || "").trim())
        .filter((id) => id.length > 0),
    );
    const waivedVerificationStepIdsFromExecutor = new Set(
      (metadata?.waivedVerificationStepIds || [])
        .map((id) => String(id || "").trim())
        .filter((id) => id.length > 0),
    );
    for (const stepId of waivedVerificationStepIdsFromExecutor.values()) {
      waivedFailedStepIds.add(stepId);
    }
    const waivedNormalizedStepIds = new Set(
      Array.from(waivedFailedStepIds.values()).map((id) => normalizeStepIdForComparison(id)),
    );
    const failedMutationRequiredStepIds = new Set(
      (metadata?.failedMutationRequiredStepIds || [])
        .map((id) => String(id || "").trim())
        .filter((id) => id.length > 0),
    );
    const failedMutationRequiredNormalizedStepIds = new Set(
      Array.from(failedMutationRequiredStepIds.values()).map((id) => normalizeStepIdForComparison(id)),
    );
    const nonBlockingFailedStepIds = new Set(
      (this.verificationOutcomeV2Enabled ? metadata?.nonBlockingFailedStepIds || [] : [])
        .map((id) => String(id || "").trim())
        .filter((id) => id.length > 0),
    );
    const isVerificationFailureStep = (rawStepId: string): boolean => {
      const stepId = String(rawStepId || "").trim();
      if (!stepId) return false;
      const normalizedStepId = normalizeStepIdForComparison(stepId);

      for (let i = historicalEvents.length - 1; i >= 0; i -= 1) {
        const event = historicalEvents[i];
        const payloadObj =
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {};
        const stepObj =
          payloadObj.step && typeof payloadObj.step === "object" && !Array.isArray(payloadObj.step)
            ? (payloadObj.step as Record<string, unknown>)
            : {};
        const eventStepIdRaw =
          (typeof event.stepId === "string" && event.stepId.trim()) ||
          (typeof stepObj.id === "string" && stepObj.id.trim()) ||
          "";
        if (!eventStepIdRaw) continue;
        const normalizedEventStepId = normalizeStepIdForComparison(eventStepIdRaw);
        if (normalizedEventStepId !== normalizedStepId && eventStepIdRaw !== stepId) continue;

        const stepKind =
          typeof stepObj.kind === "string"
            ? stepObj.kind
            : typeof payloadObj.stepKind === "string"
              ? payloadObj.stepKind
              : "";
        if (stepKind === "verification") return true;

        const stepDescription =
          typeof stepObj.description === "string"
            ? stepObj.description
            : typeof payloadObj.stepDescription === "string"
              ? payloadObj.stepDescription
              : typeof payloadObj.message === "string"
                ? payloadObj.message
                : "";
        if (isVerificationDescription(stepDescription)) return true;
      }

      for (let i = historicalEvents.length - 1; i >= 0; i -= 1) {
        const event = historicalEvents[i];
        const effectiveLegacyType =
          typeof event.legacyType === "string"
            ? event.legacyType
            : typeof event.type === "string"
              ? event.type
              : "";
        if (effectiveLegacyType !== "plan_created") continue;
        const plan = (event.payload as Any)?.plan;
        const steps = Array.isArray(plan?.steps) ? plan.steps : [];
        for (const step of steps) {
          const candidateId = String(step?.id || "").trim();
          if (!candidateId) continue;
          if (
            normalizeStepIdForComparison(candidateId) !== normalizedStepId &&
            candidateId !== stepId
          ) {
            continue;
          }
          if (String(step?.kind || "").trim().toLowerCase() === "verification") {
            return true;
          }
          if (isVerificationDescription(String(step?.description || ""))) {
            return true;
          }
        }
      }

      return false;
    };
    const isBudgetConstrainedFailureStep = (rawStepId: string): boolean => {
      const stepId = String(rawStepId || "").trim();
      if (!stepId) return false;
      const normalizedStepId = normalizeStepIdForComparison(stepId);
      const isMatchingStep = (
        eventStepIdRaw: string,
        candidateStepObj: Record<string, unknown>,
        payloadObj: Record<string, unknown>,
      ): boolean => {
        const stepObjIdRaw = typeof candidateStepObj.id === "string" ? candidateStepObj.id : "";
        const payloadStepIdRaw = typeof payloadObj.stepId === "string" ? payloadObj.stepId : "";
        const options = [eventStepIdRaw, stepObjIdRaw, payloadStepIdRaw].filter(Boolean);
        for (const option of options) {
          const normalizedOption = normalizeStepIdForComparison(option);
          if (option === stepId || normalizedOption === normalizedStepId) {
            return true;
          }
        }
        return false;
      };

      let latestFailurePayload: Record<string, unknown> | null = null;
      let latestFailureStepObj: Record<string, unknown> | null = null;
      for (let i = historicalEvents.length - 1; i >= 0; i -= 1) {
        const event = historicalEvents[i];
        const payloadObj =
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {};
        const stepObj =
          payloadObj.step && typeof payloadObj.step === "object" && !Array.isArray(payloadObj.step)
            ? (payloadObj.step as Record<string, unknown>)
            : {};
        const eventStepIdRaw = typeof event.stepId === "string" ? event.stepId : "";
        if (!isMatchingStep(eventStepIdRaw, stepObj, payloadObj)) {
          continue;
        }
        const effectiveLegacyType =
          typeof event.legacyType === "string"
            ? event.legacyType
            : typeof event.type === "string"
              ? event.type
              : "";
        const isFailureEvent =
          effectiveLegacyType === "step_failed" ||
          (event.type === "timeline_step_finished" && event.status === "failed");
        if (!isFailureEvent) {
          continue;
        }

        latestFailurePayload = payloadObj;
        latestFailureStepObj = stepObj;
        break;
      }

      if (!latestFailurePayload) {
        return false;
      }

      const failureClass =
        typeof latestFailurePayload.failureClass === "string"
          ? latestFailurePayload.failureClass
          : "";
      if (failureClass.toLowerCase() === "budget_exhausted") {
        return true;
      }

      const reasonText = [
        typeof latestFailurePayload.reason === "string" ? latestFailurePayload.reason : "",
        typeof latestFailurePayload.error === "string" ? latestFailurePayload.error : "",
        typeof latestFailurePayload.message === "string" ? latestFailurePayload.message : "",
        latestFailureStepObj && typeof latestFailureStepObj.error === "string"
          ? latestFailureStepObj.error
          : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return /\bweb_search\b/.test(reasonText) && /\bbudget\b/.test(reasonText);
    };

    const autoWaivedVerificationStepIds: string[] = [];
    const autoWaivedBudgetStepIds: string[] = [];
    const autoWaivedEvidenceBackedStepIds = new Set<string>();
    const mutationContractBlockers = Array.from(failedMutationRequiredStepIds.values());
    const mutationContractBlockersNormalized = new Set(
      mutationContractBlockers.map((id) => normalizeStepIdForComparison(id)),
    );
    const allowBudgetAutoWaive =
      metadata?.terminalStatus === "partial_success" &&
      metadata?.failureClass === "budget_exhausted" &&
      ((metadata?.waiveFailedStepIds || []).length === 0);
    const allowEvidenceBackedAutoWaive =
      metadata?.terminalStatus === "partial_success" &&
      hasSubstantiveOutcomeEvidence({
        resultSummary: trimmedSummary,
        outputSummary: metadata?.outputSummary,
        bestKnownOutcome,
      });
    let blockingFailedSteps = unresolvedFailedSteps.filter((id) => {
      const normalized = normalizeStepIdForComparison(id);
      if (waivedFailedStepIds.has(id) || waivedNormalizedStepIds.has(normalized)) {
        return false;
      }
      if (nonBlockingFailedStepIds.has(id)) {
        return false;
      }
      const partialSuccessGate = metadata?.terminalStatus === "partial_success";
      if (partialSuccessGate && isVerificationFailureStep(id)) {
        autoWaivedVerificationStepIds.push(id);
        return false;
      }
      if (allowBudgetAutoWaive && isBudgetConstrainedFailureStep(id)) {
        autoWaivedBudgetStepIds.push(id);
        return false;
      }
      if (allowEvidenceBackedAutoWaive && !isVerificationFailureStep(id)) {
        autoWaivedEvidenceBackedStepIds.add(id);
        return false;
      }
      if (
        failedMutationRequiredStepIds.has(id) ||
        failedMutationRequiredNormalizedStepIds.has(normalized) ||
        mutationContractBlockersNormalized.has(normalized)
      ) {
        return true;
      }
      return true;
    });
    for (const stepId of mutationContractBlockers) {
      if (allowEvidenceBackedAutoWaive && !isVerificationFailureStep(stepId)) {
        autoWaivedEvidenceBackedStepIds.add(stepId);
        continue;
      }
      const normalized = normalizeStepIdForComparison(stepId);
      if (
        !blockingFailedSteps.some(
          (candidate) => normalizeStepIdForComparison(candidate) === normalized,
        )
      ) {
        blockingFailedSteps.push(stepId);
      }
    }

    if (autoWaivedVerificationStepIds.length > 0) {
      for (const stepId of autoWaivedVerificationStepIds) {
        waivedFailedStepIds.add(stepId);
        waivedNormalizedStepIds.add(normalizeStepIdForComparison(stepId));
      }
      this.logEvent(taskId, "log", {
        metric: "completion_gate_blocked_partial_success",
        blocked: false,
        autoWaivedStepIds: autoWaivedVerificationStepIds,
      });
      this.logEvent(taskId, "timeline_step_updated", {
        stepId: "completion_gate:auto_waive_verification",
        status: "in_progress",
        actor: "system",
        message:
          "Auto-waived verification-only failed steps while honoring partial_success completion.",
        autoWaivedStepIds: autoWaivedVerificationStepIds,
        gate: "completion_failed_step_gate",
        legacyType: "progress_update",
      });
      blockingFailedSteps = blockingFailedSteps.filter((id) => !autoWaivedVerificationStepIds.includes(id));
    }
    if (autoWaivedBudgetStepIds.length > 0) {
      for (const stepId of autoWaivedBudgetStepIds) {
        waivedFailedStepIds.add(stepId);
        waivedNormalizedStepIds.add(normalizeStepIdForComparison(stepId));
      }
      this.logEvent(taskId, "log", {
        metric: "completion_gate_auto_waive_budget_steps",
        blocked: false,
        autoWaivedStepIds: autoWaivedBudgetStepIds,
      });
      this.logEvent(taskId, "timeline_step_updated", {
        stepId: "completion_gate:auto_waive_budget",
        status: "in_progress",
        actor: "system",
        message:
          "Auto-waived budget-constrained failed steps while honoring partial_success completion.",
        autoWaivedStepIds: autoWaivedBudgetStepIds,
        gate: "completion_failed_step_gate",
        legacyType: "progress_update",
      });
      blockingFailedSteps = blockingFailedSteps.filter((id) => !autoWaivedBudgetStepIds.includes(id));
    }
    if (autoWaivedEvidenceBackedStepIds.size > 0) {
      const autoWaivedStepIds = Array.from(autoWaivedEvidenceBackedStepIds.values());
      for (const stepId of autoWaivedStepIds) {
        waivedFailedStepIds.add(stepId);
        waivedNormalizedStepIds.add(normalizeStepIdForComparison(stepId));
      }
      this.logEvent(taskId, "log", {
        metric: "completion_gate_auto_waive_evidence_backed_steps",
        blocked: false,
        autoWaivedStepIds,
        outputSummary: metadata?.outputSummary,
        terminalStatusReason: metadata?.terminalStatusReason,
      });
      this.logEvent(taskId, "timeline_step_updated", {
        stepId: "completion_gate:auto_waive_evidence_backed",
        status: "in_progress",
        actor: "system",
        message:
          "Auto-waived failed steps because the task already produced substantive outputs/results and is completing as partial_success.",
        autoWaivedStepIds,
        gate: "completion_failed_step_gate",
        legacyType: "progress_update",
      });
      blockingFailedSteps = blockingFailedSteps.filter((id) => !autoWaivedEvidenceBackedStepIds.has(id));
    }
    blockingFailedSteps = Array.from(
      new Set(
        blockingFailedSteps
          .map((id) => String(id || "").trim())
          .filter((id) => id.length > 0),
      ),
    );

    // Best-effort / wrap-up auto-waive: when the executor explicitly finalized the task
    // via a soft deadline / wrap-up / best-effort path (not a hard failure), waive any
    // non-mutation-required blocking steps so the task can complete as partial_success
    // rather than being hard-blocked by the completion gate.
    const bestEffortReasons = [
      "best_effort",
      "Timeout recovery",
      "Wrap-up",
      "executor_best_effort_finalized",
      "No team member analyses available for synthesis",
    ];
    const terminalStatusReason = metadata?.terminalStatusReason ?? "";
    const isBestEffortFinalization =
      bestEffortReasons.some((r) => terminalStatusReason.includes(r)) &&
      (metadata?.terminalStatus === "ok" || metadata?.terminalStatus === "partial_success");
    if (isBestEffortFinalization && blockingFailedSteps.length > 0) {
      const nonMutationBlockers = blockingFailedSteps.filter((id) => {
        const normalized = normalizeStepIdForComparison(id);
        return (
          !failedMutationRequiredStepIds.has(id) &&
          !failedMutationRequiredNormalizedStepIds.has(normalized)
        );
      });
      if (nonMutationBlockers.length > 0) {
        this.logEvent(taskId, "timeline_step_updated", {
          stepId: "completion_gate:best_effort_auto_waive",
          status: "in_progress",
          actor: "system",
          message: `Best-effort finalization: auto-waiving ${nonMutationBlockers.length} non-mutation-required blocking step(s) to allow partial_success completion.`,
          autoWaivedStepIds: nonMutationBlockers,
          terminalStatusReason,
          gate: "completion_failed_step_gate",
          legacyType: "progress_update",
        });
        blockingFailedSteps = blockingFailedSteps.filter(
          (id) => !nonMutationBlockers.includes(id),
        );
      }
    }

    if (blockingFailedSteps.length > 0) {
      this.timelineMetrics.completionGateBlocks += 1;
      const hasMutationContractBlockers = blockingFailedSteps.some((id) => {
        const normalized = normalizeStepIdForComparison(id);
        return (
          failedMutationRequiredStepIds.has(id) ||
          failedMutationRequiredNormalizedStepIds.has(normalized)
        );
      });
      const terminalFailureClass: Task["failureClass"] = hasMutationContractBlockers
        ? "contract_unmet_write_required"
        : "contract_error";
      const terminalFailureStatus: NonNullable<Task["terminalStatus"]> = hasMutationContractBlockers
        ? "failed"
        : "partial_success";
      if (metadata?.terminalStatus === "partial_success") {
        this.logEvent(taskId, "log", {
          metric: "completion_gate_blocked_partial_success",
          blocked: true,
          blockingFailedSteps,
          failedMutationRequiredStepIds: Array.from(failedMutationRequiredStepIds.values()),
          terminalStatusReason: metadata?.terminalStatusReason,
        });
      }
      const message = hasMutationContractBlockers
        ? `Completion blocked: unresolved mutation-required step(s): ${blockingFailedSteps.join(", ")}`
        : `Completion blocked: unresolved failed step(s): ${blockingFailedSteps.join(", ")}`;
      this.logEvent(taskId, "timeline_error", {
        message,
        unresolvedFailedSteps: blockingFailedSteps,
        failedMutationRequiredStepIds: Array.from(failedMutationRequiredStepIds.values()),
        timelineErrorStepIds,
        waivedFailedStepIds: Array.from(waivedFailedStepIds.values()),
        nonBlockingFailedStepIds: Array.from(nonBlockingFailedStepIds.values()),
        terminalStatusReason: metadata?.terminalStatusReason,
        gate: "completion_failed_step_gate",
        legacyType: "error",
      });
      this.failTask(taskId, message, {
        terminalStatus: terminalFailureStatus,
        failureClass: terminalFailureClass,
        ...(bestKnownOutcome ? { bestKnownOutcome } : {}),
      });
      return;
    }
    if (nonBlockingFailedStepIds.size > 0) {
      this.logEvent(taskId, "verification_pending_user_action", {
        stepId: "completion_gate:non_blocking_verification",
        status: "blocked",
        actor: "system",
        message:
          metadata?.verificationMessage ||
          "Completion has pending verification items that require user action.",
        nonBlockingFailedStepIds: Array.from(nonBlockingFailedStepIds.values()),
        gate: "completion_failed_step_gate",
        legacyType: "progress_update",
      });
    }
    const risk = scoreTaskRisk(
      {
        title: existingTask.title,
        prompt: existingTask.rawPrompt || existingTask.userPrompt || existingTask.prompt,
      },
      historicalEvents,
      metadata?.outputSummary,
    );
    const reviewPolicy = resolveReviewPolicy(existingTask.agentConfig?.reviewPolicy);
    const reviewDecision = deriveReviewGateDecision({
      policy: reviewPolicy,
      riskLevel: risk.level,
      isMutatingTask:
        inferMutationFromSummary(metadata?.outputSummary) || risk.signals.changedFileCount > 0,
    });

    let terminalStatus: NonNullable<Task["terminalStatus"]> = metadata?.terminalStatus || "ok";
    let failureClass: Task["failureClass"] | undefined = metadata?.failureClass || undefined;
    if (this.verificationOutcomeV2Enabled && metadata?.verificationOutcome === "pending_user_action") {
      if (terminalStatus === "ok") {
        terminalStatus = "needs_user_action";
      }
    } else if (
      this.verificationOutcomeV2Enabled &&
      metadata?.verificationOutcome === "warn_non_blocking" &&
      terminalStatus === "ok"
    ) {
      terminalStatus = "partial_success";
      if (!failureClass) {
        failureClass = "contract_error";
      }
    }
    if (terminalStatus === "needs_user_action") {
      failureClass = undefined;
    }
    let quality: { passed: boolean; issues: string[] } | null = null;

    if (reviewDecision.runQualityPass) {
      quality = this.runQuickQualityPass({
        resultSummary: trimmedSummary,
        outputSummary: metadata?.outputSummary,
        explicitEvidenceRequired: reviewDecision.explicitEvidenceRequired,
        strictCompletionContract: reviewDecision.strictCompletionContract,
        riskReasons: risk.reasons,
        verificationEvidenceBundle: metadata?.verificationEvidenceBundle,
      });
      if (!quality.passed && reviewDecision.strictCompletionContract) {
        terminalStatus = "partial_success";
        failureClass = "contract_error";
      }
    }

    const evidenceCheck = this.hasEvidenceForKeyClaims(
      taskId,
      trimmedSummary,
      metadata?.verificationEvidenceBundle,
    );
    if (!evidenceCheck.passed) {
      this.timelineMetrics.evidenceGateFails += 1;
      terminalStatus = "partial_success";
      failureClass = "contract_error";
      this.logEvent(taskId, "timeline_step_updated", {
        stepId: "evidence_gate:key_claims",
        status: "blocked",
        actor: "system",
        message:
          "Key factual claims are missing evidence links. Please attach evidence references.",
        keyClaims: evidenceCheck.keyClaims,
        gate: "key_claim_evidence_gate",
        legacyType: "progress_update",
      });
    } else if (evidenceCheck.keyClaims.length > 0) {
      const evidenceRefs = Array.from((this.evidenceRefsByTask.get(taskId) || new Map()).values()).slice(
        0,
        20,
      );
      if (evidenceRefs.length > 0) {
        this.logEvent(taskId, "timeline_evidence_attached", {
          stepId: "evidence_gate:key_claims",
          status: "completed",
          actor: "system",
          gate: "key_claim_evidence_gate",
          keyClaims: evidenceCheck.keyClaims.slice(0, 8),
          evidenceRefs,
          message: "Attached evidence references for key factual claims.",
          legacyType: "citations_collected",
        });
      }
    }

    const resolvedOutcome = decideTaskOutcome({
      requestedStatus: "completed",
      terminalStatus,
      failureClass,
      resultSummary: trimmedSummary,
      outputSummary: metadata?.outputSummary,
      bestKnownOutcome,
    });
    terminalStatus = resolvedOutcome.terminalStatus;
    failureClass = resolvedOutcome.failureClass;

    const completionTelemetry = {
      ...this.computeTimelineTelemetryFromEvents(this.getTaskEventsForReplay(taskId)),
      telemetry_source: "runtime_v2",
    };

    const updates: Partial<Task> = {
      status: resolvedOutcome.status,
      completedAt: Date.now(),
      // Preserve a helpful prompt for resumable states; otherwise clear stale failures.
      error:
        resolvedOutcome.status === "completed"
          ? null
          : existingTask.error || (resolvedOutcome.terminalStatus === "resume_available" ? "Resume available" : null),
      terminalStatus,
      failureClass,
      ...(bestKnownOutcome ? { bestKnownOutcome } : {}),
      budgetUsage: metadata?.budgetUsage,
      riskLevel: risk.level,
      ...(trimmedSummary ? { resultSummary: trimmedSummary } : {}),
      ...(typeof metadata?.semanticSummary === "string" && metadata.semanticSummary.trim().length > 0
        ? { semanticSummary: metadata.semanticSummary.trim() }
        : {}),
      ...(metadata?.verificationVerdict ? { verificationVerdict: metadata.verificationVerdict } : {}),
      ...(typeof metadata?.verificationReport === "string" && metadata.verificationReport.trim().length > 0
        ? { verificationReport: metadata.verificationReport.trim() }
        : {}),
    };
    this.taskRepo.update(taskId, updates);
    this.clearRetryState(taskId);
    // Mark executor as completed for TTL-based cleanup
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.status = "completed";
      cached.lastAccessed = Date.now();
    }
    const completionMessage =
      terminalStatus === "needs_user_action"
        ? "Task completed - action required"
        : terminalStatus === "partial_success"
          ? "Task completed with partial results"
          : "Task completed successfully";
    this.logEvent(taskId, resolvedOutcome.status === "completed" ? "task_completed" : "task_status", {
      message:
        resolvedOutcome.status === "completed"
          ? completionMessage
          : resolvedOutcome.status === "interrupted"
            ? "Task interrupted - resume available"
            : "Task is waiting for approval or further input",
      ...(updates.resultSummary ? { resultSummary: updates.resultSummary } : {}),
      ...(resolvedOutcome.status !== "completed" ? { status: resolvedOutcome.status } : {}),
      terminalStatus,
      ...(failureClass ? { failureClass } : {}),
      ...(bestKnownOutcome ? { bestKnownOutcome } : {}),
      ...(metadata?.budgetUsage ? { budgetUsage: metadata.budgetUsage } : {}),
      ...(metadata?.outputSummary ? { outputSummary: metadata.outputSummary } : {}),
      ...(typeof metadata?.semanticSummary === "string" && metadata.semanticSummary.trim().length > 0
        ? { semanticSummary: metadata.semanticSummary.trim() }
        : {}),
      ...(metadata?.verificationVerdict ? { verificationVerdict: metadata.verificationVerdict } : {}),
      ...(typeof metadata?.verificationReport === "string" && metadata.verificationReport.trim().length > 0
        ? { verificationReport: metadata.verificationReport.trim() }
        : {}),
      ...(metadata?.verificationOutcome ? { verificationOutcome: metadata.verificationOutcome } : {}),
      ...(metadata?.verificationScope ? { verificationScope: metadata.verificationScope } : {}),
      ...(metadata?.verificationEvidenceMode
        ? { verificationEvidenceMode: metadata.verificationEvidenceMode }
        : {}),
      ...(Array.isArray(metadata?.pendingChecklist) && metadata?.pendingChecklist.length > 0
        ? { pendingChecklist: metadata.pendingChecklist }
        : {}),
      ...(metadata?.verificationMessage ? { verificationMessage: metadata.verificationMessage } : {}),
      ...(Array.isArray(metadata?.failedMutationRequiredStepIds) &&
      metadata.failedMutationRequiredStepIds.length > 0
        ? { failedMutationRequiredStepIds: metadata.failedMutationRequiredStepIds }
        : {}),
      ...(Array.isArray(metadata?.waivedVerificationStepIds) &&
      metadata.waivedVerificationStepIds.length > 0
        ? { waivedVerificationStepIds: metadata.waivedVerificationStepIds }
        : {}),
      ...(metadata?.terminalStatusReason ? { terminalStatusReason: metadata.terminalStatusReason } : {}),
      ...(timelineErrorStepIds.length > 0 ? { timelineErrorStepIds } : {}),
      risk: {
        score: risk.score,
        level: risk.level,
        reasons: risk.reasons,
        signals: risk.signals,
      },
      reviewPolicy,
      reviewGate: reviewDecision,
      telemetry: completionTelemetry,
    });

    if (this.activeTimelineStageByTask.get(taskId) === "DELIVER") {
      const timeline = createTimelineEmitter(taskId, (eventType, payload) => {
        this.logEvent(taskId, eventType, payload);
      });
      timeline.finishGroup("DELIVER", {
        label: "DELIVER",
        actor: "system",
        legacyType: "step_completed",
      });
      this.activeTimelineStageByTask.delete(taskId);
    }

    if (quality) {
      this.logEvent(taskId, quality.passed ? "review_quality_passed" : "review_quality_failed", {
        policy: reviewPolicy,
        tier: reviewDecision.tier,
        issues: quality.issues,
      });
    }

    if (reviewDecision.runVerificationAgent) {
      this.logEvent(taskId, "verification_started", {
        source: "post_completion_review_gate",
        policy: reviewPolicy,
        tier: reviewDecision.tier,
      });
      void this.runPostCompletionVerification(
        existingTask,
        updates.resultSummary,
        metadata?.verificationEvidenceBundle,
      ).catch((error) => {
        console.warn("[AgentDaemon] Post-completion verification failed to launch:", error);
      });
    }

    const entropyPolicy = resolveEntropySweepPolicy(
      existingTask.agentConfig?.entropySweepPolicy,
      reviewPolicy,
    );
    const entropyDecision = deriveEntropySweepDecision({
      policy: entropyPolicy,
      riskLevel: risk.level,
      isMutatingTask:
        inferMutationFromSummary(metadata?.outputSummary) || risk.signals.changedFileCount > 0,
      deepWorkMode: existingTask.agentConfig?.deepWorkMode === true,
    });
    if (entropyDecision.runEntropySweep) {
      this.logEvent(taskId, "entropy_sweep_started", {
        source: "post_completion_entropy_sweep",
        policy: entropyPolicy,
        tier: risk.level,
      });
      void this.runPostTaskEntropySweep(existingTask, {
        historicalEvents,
        outputSummary: metadata?.outputSummary,
        parentSummary: updates.resultSummary,
      }).catch((error) => {
        console.warn("[AgentDaemon] Post-task entropy sweep failed to launch:", error);
      });
    }

    // === WORKTREE AUTO-COMMIT ===
    // If the task has an active worktree, auto-commit changes on completion.
    if (existingTask?.worktreeStatus === "active" && existingTask.worktreePath) {
      const worktreeSettings = this.worktreeManager.getSettings();
      if (worktreeSettings.autoCommitOnComplete) {
        void (async () => {
          try {
            this.taskRepo.update(taskId, { worktreeStatus: "committing" });
            const commitResult = await this.worktreeManager.commitTaskChanges(
              taskId,
              `${worktreeSettings.commitMessagePrefix}${existingTask.title}`,
            );
            if (commitResult) {
              this.logEvent(taskId, "worktree_committed", {
                sha: commitResult.sha,
                filesChanged: commitResult.filesChanged,
                message: `Auto-committed ${commitResult.filesChanged} changed file(s) (${commitResult.sha.slice(0, 7)}).`,
              });
            }
            this.taskRepo.update(taskId, { worktreeStatus: "active" });
          } catch (error: Any) {
            console.error(`[AgentDaemon] Auto-commit failed for task ${taskId}:`, error);
            this.logEvent(taskId, "log", {
              message: `Auto-commit failed: ${error.message}`,
            });
          }
        })();
      }
    }

    // === COMPARISON SESSION CALLBACK ===
    // Notify the comparison service when a task in a comparison session completes.
    // This must be outside the auto-commit block so it fires regardless of worktree settings.
    const comparisonSvc = this.comparisonService;
    if (existingTask?.comparisonSessionId && comparisonSvc) {
      void (async () => {
        try {
          await comparisonSvc.onTaskCompleted(taskId);
        } catch (error: Any) {
          console.error(`[AgentDaemon] Comparison callback failed for task ${taskId}:`, error);
        }
      })();
    }

    try {
      const isTopLevelTask =
        existingTask && !existingTask.parentTaskId && (existingTask.agentType ?? "main") === "main";
      if (isTopLevelTask) {
        const workspaceName = this.workspaceRepo.findById(existingTask.workspaceId)?.name;
        PersonalityManager.recordTaskCompleted(workspaceName);
        const gatewayContext = existingTask.agentConfig?.gatewayContext ?? "private";
        const canCaptureRelationshipMemory =
          gatewayContext === "private" ||
          existingTask.agentConfig?.allowSharedContextMemory === true;
        if (canCaptureRelationshipMemory) {
          RelationshipMemoryService.recordTaskCompletion(
            existingTask.title,
            typeof updates.resultSummary === "string" ? updates.resultSummary : undefined,
            taskId,
            existingTask.source ?? "manual",
          );
        }
        getAwarenessService().captureTaskCompletion(
          existingTask.workspaceId,
          existingTask.title,
          typeof updates.resultSummary === "string" ? updates.resultSummary : undefined,
          taskId,
        );
      }
    } catch (error) {
      console.warn("[AgentDaemon] Failed to record relationship milestone:", error);
    }
    if (this.teamOrchestrator) {
      void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
    }
    this.clearTimelineTaskState(taskId);
    // Notify queue manager so it can start next task
    this.finishQueueSlot(taskId);
  }

  /**
   * Send a follow-up message to a task.
   *
   * If the executor is currently running (mutex held), the message is queued
   * for injection into the active execution loop and a user_message event is
   * emitted immediately so the UI shows the message right away.
   */
  async sendMessage(
    taskId: string,
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
  ): Promise<{ queued: boolean }> {
    let cached = this.activeTasks.get(taskId);
    let executor: TaskExecutor;

    // Always get fresh task and workspace from DB to pick up permission changes
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const { task: effectiveTask } = this.applyAgentRoleOverrides(task);

    const workspace = this.workspaceRepo.findById(effectiveTask.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${effectiveTask.workspaceId} not found`);
    }

    this.taskRepo.touch(taskId);

    if (!cached) {
      // Task executor not in memory - need to recreate it
      // Create new executor
      executor = new TaskExecutor(effectiveTask, workspace, this);

      // Rebuild conversation history from saved events
      const events = this.getTaskEventsForReplay(taskId);
      if (events.length > 0) {
        executor.rebuildConversationFromEvents(events);
      }

      this.activeTasks.set(taskId, {
        executor,
        lastAccessed: Date.now(),
        status: "active",
      });
    } else {
      executor = cached.executor;
      // Update workspace to pick up permission changes (e.g., shell enabled)
      executor.updateWorkspace(workspace);
      cached.lastAccessed = Date.now();
      cached.status = "active";
    }

    // If the executor is busy (mutex locked), queue the message for the running
    // loop to pick up and return immediately so the IPC doesn't block.
    if (executor.isRunning) {
      executor.queueFollowUp(message, images, quotedAssistantMessage);
      // Emit user_message event immediately so the UI shows the message right away.
      // The executor's sendMessageLegacy won't re-emit because the message is
      // injected directly into the conversation loop, not through sendMessage.
      this.logEvent(taskId, "user_message", {
        message,
        ...(quotedAssistantMessage ? { quotedAssistantMessage } : {}),
      });
      return { queued: true };
    }

    // Send the message (executor is idle, acquire mutex normally)
    await executor.sendMessage(message, images, quotedAssistantMessage);
    return { queued: false };
  }

  /**
   * Handle step-level feedback from the user.
   * Routes the feedback signal to the appropriate executor.
   */
  async handleStepFeedback(
    taskId: string,
    stepId: string,
    action: StepFeedbackAction,
    message?: string,
  ): Promise<void> {
    const cached = this.activeTasks.get(taskId);
    if (!cached) {
      throw new Error(`Task ${taskId} not found or not active`);
    }
    cached.lastAccessed = Date.now();

    const executor = cached.executor;
    if (!executor) {
      throw new Error(`No executor found for task ${taskId}`);
    }

    // Re-emit feedback as timeline step transition for deterministic replay.
    const feedbackMessage =
      typeof message === "string" && message.trim().length > 0
        ? message.trim()
        : action === "retry"
          ? "Retry requested"
          : action === "skip"
            ? "Skip requested"
            : action === "stop"
              ? "Stop requested"
              : "Scope adjustment requested";
    const feedbackStatus: TaskEvent["status"] =
      action === "skip"
        ? "skipped"
        : action === "stop"
          ? "cancelled"
          : "in_progress";
    this.logEvent(taskId, "timeline_step_updated", {
      stepId,
      action,
      status: feedbackStatus,
      actor: "user",
      message: feedbackMessage,
      timestamp: Date.now(),
      legacyType: "step_feedback",
    });

    // Route to executor
    executor.setStepFeedback(stepId, action, message);
  }

  /**
   * After execution completes, process any follow-up messages that were queued
   * but never picked up by the execution loop (e.g. arrived on the last iteration).
   */
  private processOrphanedFollowUps(taskId: string, executor: TaskExecutor): void {
    const orphaned = executor.drainAllPendingFollowUps();
    if (orphaned.length === 0) return;

    console.log(
      `[AgentDaemon] Processing ${orphaned.length} orphaned follow-up(s) for task ${taskId}`,
    );

    // Process each follow-up sequentially via sendMessage (mutex is now free).
    // The user_message event was already emitted when the message was queued, so
    // tell the executor to suppress the duplicate emission.
    // Fire-and-forget: each follow-up is independent and errors are logged.
    let _chain: Promise<void> = Promise.resolve();
    for (const followUp of orphaned) {
      _chain = _chain
        .then(() => {
          executor.suppressNextUserMessageEvent();
          return this.sendMessage(
            taskId,
            followUp.message,
            followUp.images,
            followUp.quotedAssistantMessage,
          );
        })
        .then(() => {
          /* result intentionally ignored */
        })
        .catch((err) => {
          console.error(
            `[AgentDaemon] Failed to process orphaned follow-up for task ${taskId}:`,
            err,
          );
        });
    }
  }

  // ===== Queue Management Methods =====

  /**
   * Get current queue status
   */
  getQueueStatus(): QueueStatus {
    return this.queueManager.getStatus();
  }

  /**
   * Get queue settings
   */
  getQueueSettings(): QueueSettings {
    return this.queueManager.getSettings();
  }

  /**
   * Save queue settings
   */
  saveQueueSettings(settings: Partial<QueueSettings>): void {
    this.queueManager.saveSettings(settings);
  }

  /**
   * Clear stuck tasks from the queue
   * Used to recover from stuck state when tasks fail to clean up
   * Also properly cancels running tasks to clean up resources (browser sessions, etc.)
   */
  async clearStuckTasks(): Promise<{ clearedRunning: number; clearedQueued: number }> {
    // Get running task IDs before clearing
    const status = this.queueManager.getStatus();
    const runningTaskIds = [...status.runningTaskIds];
    const queuedTaskIds = [...status.queuedTaskIds];

    console.log(
      `[AgentDaemon] Clearing ${runningTaskIds.length} running tasks and ${queuedTaskIds.length} queued tasks`,
    );

    // Cancel all running tasks properly (this cleans up browser sessions, etc.)
    for (const taskId of runningTaskIds) {
      const cached = this.activeTasks.get(taskId);
      if (cached) {
        try {
          console.log(`[AgentDaemon] Cancelling running task: ${taskId}`);
          await cached.executor.cancel("system");
          this.activeTasks.delete(taskId);
        } catch (error) {
          console.error(`[AgentDaemon] Error cancelling task ${taskId}:`, error);
        }
      }
    }

    // Now clear the queue state
    return this.queueManager.clearStuckTasks();
  }

  /**
   * Handle a task that has timed out
   * Called by queue manager when a task exceeds the configured timeout
   */
  async handleTaskTimeout(taskId: string): Promise<void> {
    console.log(`[AgentDaemon] Task ${taskId} has timed out, cancelling...`);
    const timeoutMessage = "Task timed out - exceeded maximum allowed execution time";

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      try {
        // Cancel the task (this cleans up browser sessions, etc.)
        await cached.executor.cancel("timeout");
        this.activeTasks.delete(taskId);
      } catch (error) {
        console.error(`[AgentDaemon] Error cancelling timed out task ${taskId}:`, error);
      }
    }

    this.failTask(taskId, timeoutMessage);
    this.pendingTaskImages.delete(taskId);

    // Emit timeout event
    this.logEvent(taskId, "step_timeout", {
      message: "Task exceeded maximum execution time and was automatically cancelled",
    });
  }

  /**
   * Emit queue update event to all windows
   */
  private emitQueueUpdate(status: QueueStatus): void {
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.QUEUE_UPDATE, status);
        }
      } catch (error) {
        console.error(`[AgentDaemon] Error sending queue update to window:`, error);
      }
    });
  }

  /**
   * Shutdown daemon
   * Properly awaits all task cancellations and clears intervals
   */
  async shutdown(): Promise<void> {
    console.log("Shutting down agent daemon...");
    this.orchestrationGraphEngine.stop();

    // Clear the cleanup interval
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = undefined;
    }

    // Clear all pending approval timeouts and reject pending promises
    this.pendingApprovals.forEach((pending, _approvalId) => {
      clearTimeout(pending.timeoutHandle);
      if (!pending.resolved) {
        pending.resolved = true;
        pending.reject(new Error("Daemon shutting down"));
      }
    });
    this.pendingApprovals.clear();
    this.pendingInputRequests.forEach((pending, _requestId) => {
      if (!pending.resolved) {
        pending.resolved = true;
        pending.reject(new Error("Daemon shutting down"));
      }
    });
    this.pendingInputRequests.clear();

    // Save conversation snapshots and mark active tasks as "interrupted" so they
    // can be automatically resumed on next startup. Snapshots must be saved BEFORE
    // calling executor.cancel() which aborts in-flight requests.
    this.activeTasks.forEach((cached, taskId) => {
      if (cached.status !== "active") return;

      // Best-effort snapshot save
      try {
        cached.executor.saveConversationSnapshot();
      } catch (err) {
        console.error(`[AgentDaemon] Failed to save snapshot for task ${taskId} on shutdown:`, err);
      }

      // Mark as "interrupted" instead of "cancelled" so we can resume on restart
      try {
        const currentTask = this.taskRepo.findById(taskId);
        const interruptedOutcome = decideTaskOutcome({
          requestedStatus: "interrupted",
          terminalStatus: "resume_available",
          failureClass: currentTask?.failureClass,
          resultSummary: currentTask?.resultSummary,
          bestKnownOutcome: getTaskBestKnownOutcome(currentTask),
          error: "Application shutdown while task was running - will resume on restart",
        });
        this.taskRepo.update(taskId, {
          status: interruptedOutcome.status as TaskStatus,
          terminalStatus: interruptedOutcome.terminalStatus,
          failureClass: interruptedOutcome.failureClass,
          error: "Application shutdown while task was running - will resume on restart",
        });
        this.logEvent(taskId, "task_interrupted", {
          message: "Task interrupted by application shutdown. Will resume on restart.",
          terminalStatus: interruptedOutcome.terminalStatus,
        });
      } catch (err) {
        console.error(`[AgentDaemon] Failed to update task ${taskId} status on shutdown:`, err);
      }
    });

    // Cancel all active tasks and wait for them to complete
    const cancelPromises: Promise<void>[] = [];
    this.activeTasks.forEach((cached, taskId) => {
      const promise = cached.executor.cancel("shutdown").catch((err) => {
        console.error(`Error cancelling task ${taskId}:`, err);
      });
      cancelPromises.push(promise);
    });

    // Wait for all cancellations to complete (with timeout)
    await Promise.race([
      Promise.all(cancelPromises),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)), // 5 second timeout
    ]);

    this.activeTasks.clear();
    this.pendingTaskImages.clear();

    // Remove all EventEmitter listeners to prevent memory leaks
    this.removeAllListeners();

    console.log("Agent daemon shutdown complete");
  }

  /**
   * Prune old conversation snapshots for a task, keeping only the most recent one.
   * This prevents database bloat from accumulating snapshots.
   */
  pruneOldSnapshots(taskId: string): void {
    try {
      this.eventRepo.pruneOldSnapshots(taskId);
    } catch (error) {
      console.debug("[AgentDaemon] Failed to prune old snapshots:", error);
    }
  }
}
