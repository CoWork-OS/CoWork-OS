import { EventEmitter } from "events";
import {
  authorizationFingerprint,
  authorizationToolInput,
} from "../security/authorization-identity";
import { prepareInteractionTurn } from "./strategy/interaction-mode";
import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import { createLogger } from "../utils/logger";
import { DatabaseManager } from "../database/schema";
import { ControlPlaneCoreService } from "../control-plane/ControlPlaneCoreService";
import type Database from "better-sqlite3";
import {
  TaskRepository,
  TaskEventRepository,
  TaskSessionMetadataRepository,
  WorkspaceRepository,
  ApprovalRepository,
  WorkspacePermissionRuleRepository,
  InputRequestRepository,
  ArtifactRepository,
  AnnotationRepository,
  MemoryType,
} from "../database/repositories";
import { SessionRetentionService } from "../sessions/SessionRetentionService";
import { SessionProgressService } from "../sessions/SessionProgressService";
import { WorkSessionProtocolService } from "../sessions/WorkSessionProtocolService";
import { WorkSessionContractService } from "../sessions/WorkSessionContractService";
import {
  loadSessionRetentionSettings,
  saveSessionRetentionSettings,
} from "../sessions/session-retention-settings";
import { ActivityRepository } from "../activity/ActivityRepository";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { AgentTeamRepository } from "../agents/AgentTeamRepository";
import { AgentTeamMemberRepository } from "../agents/AgentTeamMemberRepository";
import {
  DEFAULT_BOT_TEAM_NAME,
  ensureDefaultBotRoles,
  ensureDefaultBotTeam,
} from "../agents/bot-team";
import { MentionRepository } from "../agents/MentionRepository";
import { buildAgentDispatchPrompt } from "../agents/agent-dispatch";
import { extractMentionedRoles } from "../agents/mentions";
import { selectAgentsForTask } from "../agents/capabilityMatcher";
import { MultitaskLanePlanner } from "../agents/MultitaskLanePlanner";
import { buildSubagentDisplayName } from "../agents/subagent-display-names";
import { recordLlmCallError, recordLlmCallSuccess } from "./llm/usage-telemetry";
import { TaskMutationLedger } from "./task-mutation-ledger";
import { LLMProviderFactory } from "./llm/provider-factory";
import { createConfiguredJevProvider, isJevActiveHarnessEnabled } from "./jev";
import { routeModelWithJev } from "./jev/model-routing";
import { createDecisionService } from "./decisions";
import { decideTaskStrategyWithJev } from "./jev/task-strategy-decision";
import {
  Task,
  ApprovalRequest,
  ApprovalResponseAction,
  ApprovalType,
  DEFAULT_TRUSTED_COMMAND_PATTERNS,
  SensitiveSourceRef,
  PermissionEffect,
  PermissionEvaluationResult,
  PermissionMode,
  PermissionPromptDetails,
  PermissionRule,
  SessionActionAttribution,
  TaskVerificationEvidenceBundle,
  TaskStatus,
  TaskEvent,
  TaskTimelinePageCursor,
  EventType,
  TaskOutputSummary,
  IPC_CHANNELS,
  QueueSettings,
  QueueStatus,
  Workspace,
  WorkspacePermissions,
  AgentConfig,
  CliTaskOwnership,
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
  Annotation,
  QuotedAssistantMessage,
  TaskFollowUpInput,
  AgentMessageDeliveryStatus,
  AgentMessageSendResult,
  MULTI_LLM_PROVIDER_DISPLAY,
  AgentTeamRun,
  AgentTeamItem,
  AgentTeamItemStatus,
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
  OrchestrationGraphRun,
  OrchestrationNodeNotification,
  WorkerRoleKind,
  VerificationVerdict,
} from "../../shared/types";
import { parseSpawnAgentCount } from "../../shared/spawn-intent-detection";
import { isAutomatedTaskLike } from "../../shared/automated-task-detection";
import { normalizeBotConversationAgentConfig } from "../../shared/bot-conversation-config";
import {
  getCurrentBotHandoffScope,
  getOutstandingBotHandoffReply,
  getPendingBotHandoff,
  type PendingBotHandoff,
} from "../../shared/bot-handoff";
import {
  BUILTIN_ACCESS_PROFILE_IDS,
  hasAccessProfileScope,
  isAccessProfileAtMostPrivileged,
} from "../../shared/access-profiles";
import { normalizeLlmProviderType } from "../../shared/llmProviderDisplay";
import {
  extractTimelineEvidenceRefs,
  inferTimelineStageForLegacyType,
  inferTimelineSubStageLabel,
  isTimelineEventType,
  normalizeTaskEventToTimelineV2,
} from "../../shared/timeline-v2";
import { buildUserMessageAttachmentMetadata } from "../../shared/user-message-attachments";
import { sanitizeTimelinePayloadForStorage } from "./timeline-payload-sanitizer";
import { deriveCanonicalTaskStatus, isTerminalTaskStatus } from "../../shared/task-status";
import { createTimelineEmitter } from "./timeline-emitter";
import { TaskExecutor } from "./executor";
import { APPROVAL_REQUEST_TIMEOUT_MS } from "./approval-timeouts";
import { approvalPromptsDisabled } from "./approval-policy";
import {
  buildAssistantApprovalMessage,
  buildAssistantApprovalRequest,
  isHighImpactApprovalDecision,
  isAssistantApprovalInputRequest,
  parseAssistantApprovalAnswer,
  shouldUseAssistantApprovalInput,
} from "./assistant-approval";
import { TaskQueueManager } from "./queue-manager";
import type { TerminalKind } from "./runtime/TerminalState";
import { BuiltinToolsSettingsManager } from "./tools/builtin-settings";
import { loadPolicies } from "../admin/policies";
import { ComputerUseSessionManager } from "../computer-use/session-manager";
import { getNumbatService } from "../security/numbat";
import {
  decideTaskOutcome,
  getTaskBestKnownOutcome,
  hasSubstantiveOutcomeEvidence,
} from "./outcome-policy";
import {
  approvalIdempotency,
  taskIdempotency as _taskIdempotency,
  IdempotencyManager,
} from "../security/concurrency";
import { MemoryService } from "../memory/MemoryService";
import { taskDisablesMemoryCapture } from "../memory/no-memory-directive";
import { GuardrailManager } from "../guardrails/guardrail-manager";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import {
  applyDefaultAccessProfile,
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
  type EffectiveAccessProfile,
} from "../security/access-profile-resolver";
import {
  appendWorkspacePermissionManifestRule,
  filterTrustedManifestRules,
  loadWorkspacePermissionManifest,
} from "../security/workspace-permission-manifest";
import { permissionScopeFingerprint, summarizePermissionScope } from "../security/permission-utils";
import { buildPermissionSecurityContext } from "./security/export-permission-context";
import { evaluateNetworkPolicy } from "../security/network-policy";
import { PlaybookService } from "../memory/PlaybookService";
import { UserProfileService } from "../memory/UserProfileService";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import { AdaptiveStyleEngine } from "../memory/AdaptiveStyleEngine";
import { MemoryConsolidator } from "../memory/MemoryConsolidator";
import { DreamingRepository } from "../memory/DreamingRepository";
import { DreamingService } from "../memory/DreamingService";
import { MemoryPressureService } from "../memory/MemoryPressureService";
import { TranscriptStore } from "../memory/TranscriptStore";
import { getAwarenessService } from "../awareness/AwarenessService";
import { PersonalityManager } from "../settings/personality-manager";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { IntentRoute, IntentRouter } from "./strategy/IntentRouter";
import { DerivedTaskStrategy, TaskStrategyService } from "./strategy/TaskStrategyService";
import {
  getReadOnlyExecutionToolRestrictions,
  resolveDefaultWorkerRoleKind,
  resolveWorkerRoleAgentConfig,
  resolveWorkerRoleKind,
} from "./runtime/worker-role-registry";
import {
  createVerificationRuntime,
  type VerificationRuntimeResult,
} from "./runtime/VerificationRuntime";
import { QueuedAttachmentStore, type QueuedAttachmentRef } from "./runtime/queued-attachment-store";
import type { AgentTeamOrchestrator } from "../agents/AgentTeamOrchestrator";
import { AgentTeamItemRepository } from "../agents/AgentTeamItemRepository";
import { AgentTeamRunRepository } from "../agents/AgentTeamRunRepository";
import {
  resolveOperationalAutonomyPolicy,
  buildAgentConfigFromAutonomyPolicy,
} from "../agents/autonomy-policy";
import { PermissionEngine } from "./runtime/PermissionEngine";
import { WorktreeManager } from "../git/WorktreeManager";
import {
  assertWorkspaceFilesystemAccess,
  canonicalizeAccessPath,
  evaluateWorkspaceFilesystemAccess,
  isAccessPathWithin,
  resolveAccessControlledPath,
  type AccessFilesystemOperation,
} from "../security/access-profile-paths";
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
import {
  OrchestrationGraphEngine,
  type OrchestrationGraphNodeInput,
} from "./orchestration/OrchestrationGraphEngine";
import { OrchestrationGraphRepository } from "./orchestration/OrchestrationGraphRepository";
import { MCPClientManager } from "../mcp/client/MCPClientManager";
import { getMailboxServiceInstance } from "../mailbox/MailboxService";
import {
  RecurringApprovalService,
  type RecurringApprovalFingerprintInput,
} from "../security/recurring-approval-service";
import {
  extractMailboxComposeDraftInputFromText,
  type ChatInlineFrame,
} from "../../shared/mailbox";
import { extractCanonicalTaskImpactMetrics } from "./canonical-task-impact";

export interface AgentDaemonOptions {
  startupRecovery?: boolean;
  recurringApprovalService?: RecurringApprovalService;
}

const log = createLogger("AgentDaemon");

/** Maximum time a bot coordinator waits for a teammate reply before preserving
 * a partial result and making the missing reply explicit. */
export const BOT_HANDOFF_REPLY_TIMEOUT_MS = 120_000;

function hashBotMessage(message: string): string {
  return crypto.createHash("sha256").update(message, "utf8").digest("hex");
}

const FORK_REPLAY_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "tool_error",
  "tool_warning",
  "tool_blocked",
  "plan_created",
  "plan_updated",
  "plan_revised",
  "step_started",
  "step_completed",
  "step_failed",
  "step_skipped",
  "step_feedback",
  "task_list_created",
  "task_list_updated",
  "task_list_completed",
  "context_compaction_started",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_summarized",
  "conversation_snapshot",
  "command_output",
  "artifact_created",
  "diagram_created",
  "citations_collected",
  "progress_update",
  "task_impact_updated",
]);

const RESUME_PLAN_DEFINITION_EVENT_TYPES = [
  "plan_created",
  "plan_updated",
  "plan_revised",
] as const;
const RESUME_PLAN_STATE_EVENT_TYPES = [
  "step_started",
  "step_completed",
  "step_failed",
  "step_skipped",
  "step_feedback",
] as const;

export function shouldRestartInterruptedTask(input: {
  hasSnapshot: boolean;
  hasPlan: boolean;
  hasRecoveredBotHandoff: boolean;
}): boolean {
  return !input.hasSnapshot && !input.hasPlan && !input.hasRecoveredBotHandoff;
}

const RESUME_STATE_EVENT_TYPES = [
  "conversation_snapshot",
  "user_message",
  "assistant_message",
  "task_list_created",
  "task_list_updated",
  "task_list_completed",
  "context_compaction_started",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_summarized",
  "llm_usage",
  "skill_selected",
  "skill_invoked",
] as const;
const MAX_RESUME_TAIL_EVENTS = 200;
const MAX_RESUME_PLAN_STATE_EVENTS = 400;

// Memory management constants
const MAX_CACHED_EXECUTORS = 2; // Maximum number of completed task executors to keep in memory
const EXECUTOR_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes - time before completed executors are cleaned up

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

  const answerMap =
    answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};

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

const READ_ONLY_SHELL_CAPABLE_SYSTEM_ROLE_NAMES = new Set([
  "reviewer",
  "researcher",
  "finance-data-reader",
  "finance-reviewer",
]);

function normalizeReadOnlyRoleToolRestrictions(
  role: Pick<AgentRole, "name" | "isSystem">,
  deniedTools: unknown,
): string[] | undefined {
  if (!Array.isArray(deniedTools)) return undefined;
  const normalized = deniedTools
    .map((raw) => (typeof raw === "string" ? raw.trim() : ""))
    .filter((value) => value.length > 0);
  if (!role.isSystem || !READ_ONLY_SHELL_CAPABLE_SYSTEM_ROLE_NAMES.has(role.name)) {
    return normalized;
  }
  const next = new Set<string>();
  for (const value of normalized) {
    if (value === "group:destructive") {
      next.add("delete_file");
    } else {
      next.add(value);
    }
  }
  return Array.from(next);
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
  for (const [key, value] of Object.entries(taskOverrides) as Array<
    [keyof Task, Task[keyof Task]]
  >) {
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

type DaemonFollowUpOptions = Pick<
  TaskFollowUpInput,
  | "permissionMode"
  | "shellAccess"
  | "accessProfileId"
  | "integrationMentions"
  | "agentConfigOverride"
  | "expectedTurnId"
  | "interactionMode"
  | "deliveryMode"
  | "messageSource"
  | "messageId"
  | "senderTaskId"
  | "senderLabel"
  | "inReplyToMessageId"
  | "inReplyToTaskId"
> & {
  /** Return to the renderer once the follow-up is durably admitted, not after provider completion. */
  returnOnAccepted?: boolean;
  /** Called once the executor has durably incorporated this message. */
  onAccepted?: () => void | Promise<void>;
  /** Internal queue recovery flag; consumed by the executor before its turn. */
  suppressUserMessageEvent?: boolean;
  /** Explicit bot-team delivery may wake the addressed persistent conversation. */
  startAfterAccepted?: boolean;
  /** Full queue item retained until the executor's acceptance snapshot commits. */
  queuedFollowUp?: TaskFollowUpInput;
};

interface PendingApprovalEntry {
  taskId: string;
  approval: Any;
  resolve: (value: boolean) => void;
  reject: (reason?: unknown) => void;
  resolved: boolean;
  timeoutHandle: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
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

function readDurableTaskEvents(
  host: Any,
  taskId: string,
  type: string,
  limit?: number,
): TaskEvent[] {
  const repository = host?.eventRepo;
  if (typeof repository?.findByTaskIdAndTypes === "function") {
    return repository.findByTaskIdAndTypes(taskId, [type], limit);
  }
  const getTaskEvents = host?.getTaskEvents;
  if (typeof getTaskEvents === "function") {
    const events = getTaskEvents.call(host, taskId, { types: [type], limit });
    return Array.isArray(events) ? events : [];
  }
  return [];
}

function parseSessionRetentionDurationMs(raw: unknown): number | undefined {
  const text = String(raw || "")
    .trim()
    .toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|mo|y)?$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2] || "d";
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };
  return Math.floor(value * multipliers[unit]);
}

/**
 * AgentDaemon is the core orchestrator that manages task execution
 * It coordinates between the database, task executors, and UI
 */
export class AgentDaemon extends EventEmitter {
  private readonly drainingFollowUps = new Set<string>();
  private readonly warnedUntrustedManifestWorkspaces = new Set<string>();
  /** Admission fence raised before shutdown cancellation starts. */
  private shutdownRequested = false;
  /** Repeated quit requests share one shutdown operation. */
  private shutdownPromise?: Promise<void>;
  /** Queue-manager starts admitted before shutdown but not yet registered. */
  private admittedStartOperations?: Set<Promise<void>>;
  private static readonly RENDERER_SUPPRESSED_EVENT_TYPES = new Set([
    "log",
    "llm_usage",
    "task_analysis",
    "jev_decision",
  ]);

  private taskRepo: TaskRepository;
  private eventRepo: TaskEventRepository;
  private workspaceRepo: WorkspaceRepository;
  private approvalRepo: ApprovalRepository;
  private workspacePermissionRuleRepo: WorkspacePermissionRuleRepository;
  private inputRequestRepo: InputRequestRepository;
  private artifactRepo: ArtifactRepository;
  private sessionProgressService: SessionProgressService;
  private workSessionProtocolService: WorkSessionProtocolService;
  private workSessionContractService: WorkSessionContractService;
  private annotationRepo: AnnotationRepository;
  private activityRepo: ActivityRepository;
  private agentRoleRepo: AgentRoleRepository;
  private mentionRepo: MentionRepository;
  private teamOrchestrator: AgentTeamOrchestrator | null = null;
  private orchestrationGraphEngine: OrchestrationGraphEngine;
  private activeTasks: Map<string, CachedExecutor> = new Map();
  private pendingApprovals: Map<string, PendingApprovalEntry> = new Map();
  /** One-shot approval decisions carried across executor reconstruction after a restart. */
  private pendingDurableApprovalGrants: Map<
    string,
    Map<string, { approvalId: string; grantedAt: number }>
  > = new Map();
  /** Per-turn agentConfig overrides used by scheduled/event dispatch. */
  private transientAgentConfigOverrides: Map<string, AgentConfig> = new Map();
  /** One-shot grants consumed by external filesystem operations. */
  private externalFileApprovalGrants: Map<string, number> = new Map();
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
  private maintenanceIntervalHandle?: ReturnType<typeof setInterval>;
  private botHandoffTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
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
  /** Durable copies for queue-only message receipts; initialized lazily for lightweight test hosts. */
  private queuedAttachmentStore?: QueuedAttachmentStore;
  /**
   * Tasks queued via "Continue" after turn-limit exhaustion.
   * When dequeued, these must resume via continuation flow, not normal execution.
   */
  private pendingContinuationTaskIds: Set<string> = new Set();
  private pendingMemoryConsolidations: Set<string> = new Set();
  /** Tasks whose terminalization is waiting for an independent verifier. */
  private pendingCompletionVerifications: Set<string> = new Set();
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
  private taskMutationLedger?: TaskMutationLedger;
  private lastKnownLlmProviderByTask: Map<string, string> = new Map();
  private materializedMailComposeFrameSignatures: Set<string> = new Set();
  private materializedMailComposeFrameTasks: Set<string> = new Set();
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
  private verificationLocks: Map<
    string,
    { promise: Promise<{ success: boolean; output?: string }>; startedAt: number }
  > = new Map();
  private static readonly TRANSIENT_RETRY_ERROR_REGEX =
    /^Transient provider error\.\s*Retry\s+\d+\/\d+\s+in\s+\d+s\./i;

  constructor(
    private dbManager: DatabaseManager,
    private options: AgentDaemonOptions = {},
  ) {
    super();
    const db = dbManager.getDatabase();
    this.options = {
      ...this.options,
      recurringApprovalService:
        this.options.recurringApprovalService || new RecurringApprovalService(db),
    };
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.approvalRepo = new ApprovalRepository(db);
    this.workspacePermissionRuleRepo = new WorkspacePermissionRuleRepository(db);
    this.inputRequestRepo = new InputRequestRepository(db);
    this.artifactRepo = new ArtifactRepository(db);
    this.sessionProgressService = new SessionProgressService(db);
    this.workSessionProtocolService = new WorkSessionProtocolService(db);
    this.workSessionProtocolService.getReliabilityService().start();
    this.workSessionContractService = new WorkSessionContractService(
      db,
      this.workSessionProtocolService,
    );
    this.annotationRepo = new AnnotationRepository(db);
    this.activityRepo = new ActivityRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
    this.mentionRepo = new MentionRepository(db);
    this.taskMutationLedger = new TaskMutationLedger();

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
    this.cleanupIntervalHandle = setInterval(() => this.cleanupOldExecutors(), 120_000); // Run every 2 minutes

    // Deferred database maintenance: prune old events and vacuum
    setTimeout(() => {
      void this.runDatabaseMaintenance();
      this.maintenanceIntervalHandle = setInterval(
        () => void this.runDatabaseMaintenance(),
        24 * 60 * 60 * 1000,
      );
    }, 60_000);
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

  private getAdmittedStartOperations(): Set<Promise<void>> {
    return (this.admittedStartOperations ??= new Set<Promise<void>>());
  }

  private async waitForAdmittedStarts(timeoutMs: number): Promise<boolean> {
    const pending = Array.from(this.getAdmittedStartOperations());
    if (pending.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return !timedOut;
  }

  /** Return the compact durable state used to restore a session after reload/reconnect. */
  getSessionProgress(taskId: string) {
    return this.sessionProgressService.get(taskId);
  }

  /** Return the canonical WorkSession -> Turn -> Item protocol service. */
  getWorkSessionProtocolService(): WorkSessionProtocolService {
    return this.workSessionProtocolService;
  }

  /** Return the durable Phase 4 contracts/evidence/lineage service. */
  getWorkSessionContractService(): WorkSessionContractService {
    return this.workSessionContractService;
  }

  /** Return Phase 5 projection, lease, metrics, replay, and rollout services. */
  getWorkSessionReliabilityService() {
    return this.workSessionProtocolService.getReliabilityService();
  }

  searchSessions(query: string, workspaceId?: string, limit?: number) {
    return this.sessionProgressService.search(query, { workspaceId, limit });
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
      typeof message === "string" && AgentDaemon.TRANSIENT_RETRY_ERROR_REGEX.test(message.trim())
    );
  }

  private isStaleAttachedCliTask(task: Task): boolean {
    if (isTerminalTaskStatus(task.status)) return false;
    const cli = this.getCliTaskOwnership(task);
    if (!cli || cli.mode !== "attached" || cli.endedAt) return false;
    if (this.isPidAlive(cli.pid)) return false;
    const lastSeenAt = cli.lastSeenAt || cli.startedAt || task.updatedAt || task.createdAt;
    return Date.now() - lastSeenAt > 30_000;
  }

  private getCliTaskOwnership(task: Task): CliTaskOwnership | undefined {
    const cli = task.agentConfig?.cli;
    if (!cli || cli.owner !== "cowork-run" || typeof cli.runId !== "string") return undefined;
    return cli;
  }

  private isPidAlive(pid: unknown): boolean {
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code === "EPERM";
    }
  }

  setTeamOrchestrator(orchestrator: AgentTeamOrchestrator | null): void {
    this.teamOrchestrator = orchestrator;
  }

  getTeamOrchestrator(): AgentTeamOrchestrator | null {
    return this.teamOrchestrator;
  }

  /**
   * Deduplicate workspace verification commands so concurrent executors in the
   * same workspace don't redundantly run the same verification (e.g. `tsc --noEmit`).
   * An in-flight lock is reused if the identical workspace+command pair was started
   * less than 120 s ago; the lock is cleaned up 5 s after completion.
   */
  async runWorkspaceVerification(
    workspacePath: string,
    command: string,
    _taskId: string,
    executeTool: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ success: boolean; output?: string }>,
  ): Promise<{ success: boolean; output?: string }> {
    const lockKey = `${workspacePath}::${command}`;
    const existing = this.verificationLocks.get(lockKey);
    if (existing && Date.now() - existing.startedAt < 120_000) {
      return existing.promise;
    }

    const promise = executeTool("run_command", {
      command,
      workingDirectory: workspacePath,
    }).finally(() => {
      setTimeout(() => this.verificationLocks.delete(lockKey), 5_000);
    });

    this.verificationLocks.set(lockKey, { promise, startedAt: Date.now() });
    return promise;
  }

  /**
   * Periodic database maintenance: prune old task events for terminal tasks
   * older than 90 days and vacuum the database if freelist exceeds threshold.
   */
  private async runDatabaseMaintenance(): Promise<void> {
    try {
      const repo = new TaskEventRepository(this.dbManager.getDatabase());
      const pruned = repo.pruneOldEvents(90);
      if (pruned > 0) log.info(`DB maintenance: pruned ${pruned} old events`);
      repo.vacuumIfNeeded(500);
      await this.runSessionAutoPrune(repo);
    } catch (error) {
      log.error("DB maintenance failed:", error);
    }
  }

  private async runSessionAutoPrune(taskEventRepo: TaskEventRepository): Promise<void> {
    const settings = loadSessionRetentionSettings();
    const autoPrune = settings.autoPrune;
    if (autoPrune?.enabled !== true) return;

    const minIntervalHours =
      typeof autoPrune.minIntervalHours === "number" && Number.isFinite(autoPrune.minIntervalHours)
        ? Math.max(1, autoPrune.minIntervalHours)
        : 24;
    const lastRunAt =
      typeof autoPrune.lastRunAt === "number" && Number.isFinite(autoPrune.lastRunAt)
        ? autoPrune.lastRunAt
        : 0;
    if (Date.now() - lastRunAt < minIntervalHours * 60 * 60 * 1000) return;

    const olderThanMs = parseSessionRetentionDurationMs(autoPrune.olderThan || "90d");
    if (!olderThanMs) {
      log.warn("Session auto-prune skipped because olderThan is invalid.");
      return;
    }

    const db = this.dbManager.getDatabase();
    const sessionRetention = new SessionRetentionService(
      new TaskRepository(db),
      taskEventRepo,
      new TaskSessionMetadataRepository(db),
      new WorkspaceRepository(db),
    );
    const result = await sessionRetention.pruneSessions(
      {
        olderThanMs,
        includeArchived: autoPrune.includeArchived === true,
      },
      {
        deleteTask: async (task) => {
          if (!task.worktreePath && !task.worktreeBranch) return;
          try {
            await this.worktreeManager.cleanup(task.id, true);
          } catch (error) {
            log.warn(`Session auto-prune worktree cleanup failed for ${task.id}:`, error);
          }
        },
      },
    );

    if (autoPrune.vacuum === true) {
      taskEventRepo.vacuumIfNeeded(0);
    }
    saveSessionRetentionSettings({
      ...settings,
      autoPrune: {
        ...autoPrune,
        lastRunAt: Date.now(),
      },
    });
    if (result.sessionCount > 0) {
      log.info(
        `Session auto-prune deleted ${result.sessionCount} session(s) and ${result.taskCount} task(s)`,
      );
    }
  }

  private applyTaskWorkspaceOverrides(task: Task, workspace: Workspace): Workspace {
    const profile = resolveEffectiveAccessProfile({
      task,
      workspace,
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    });
    const profileWorkspace = applyAccessProfileToWorkspace(workspace, profile);
    const shellOverride =
      typeof task.agentConfig?.accessProfileId !== "string" &&
      task.agentConfig?.shellAccess === true &&
      profile.definition.shellAccess !== false;
    if (!shellOverride || profileWorkspace.permissions.shell === true) {
      return profileWorkspace;
    }
    return {
      ...profileWorkspace,
      permissions: {
        ...profileWorkspace.permissions,
        shell: true,
      },
    };
  }

  /**
   * Apply a task's access profile to a specific runtime checkout. Worktrees
   * are separate writable surfaces, but the base repository remains the
   * task's workspace for explicit Git merge/promotion operations.
   */
  private applyTaskWorkspaceOverridesForPath(
    task: Task,
    workspace: Workspace,
    runtimePath?: string,
  ): Workspace {
    const pathOverride = runtimePath?.trim();
    if (!pathOverride || path.resolve(pathOverride) === path.resolve(workspace.path)) {
      return this.applyTaskWorkspaceOverrides(task, workspace);
    }

    const runtimeWorkspace = this.applyTaskWorkspaceOverrides(task, {
      ...workspace,
      path: pathOverride,
    });
    // The active checkout is the only filesystem surface exposed to normal
    // task tools. The base repository is a separate promotion capability and
    // must not be added as a generic allowed root (otherwise read/write tools
    // could escape a worktree-scoped task without using Git).
    const baseRoot = path.resolve(workspace.path);
    const filteredLegacyRoots = (runtimeWorkspace.permissions.allowedPaths || []).filter(
      (allowedRoot) => {
        const normalizedRoot = path.resolve(allowedRoot);
        return !(
          isAccessPathWithin(baseRoot, normalizedRoot) ||
          isAccessPathWithin(normalizedRoot, baseRoot)
        );
      },
    );
    return {
      ...runtimeWorkspace,
      permissions: {
        ...runtimeWorkspace.permissions,
        // Legacy allowedPaths may contain the base repository. Do not expose
        // that path as a generic worktree root; Git promotion is the only
        // operation that is allowed to cross back to the base checkout.
        allowedPaths: filteredLegacyRoots,
      },
    };
  }

  /** Return the live task workspace, resolving profile rules against its checkout. */
  getEffectiveWorkspaceForTask(taskId: string): Workspace | undefined {
    const storedTask = this.taskRepo.findById(taskId);
    const transientTaskResolver = (this as Any).getTaskWithTransientAgentConfig;
    const task =
      typeof transientTaskResolver === "function"
        ? transientTaskResolver.call(this, storedTask)
        : storedTask;
    if (!task) return undefined;
    const baseWorkspace = this.workspaceRepo.findById(task.workspaceId);
    if (!baseWorkspace) return undefined;

    const liveWorkspace = this.getExecutorForTask(taskId)?.getWorkspace?.();
    const runtimePath =
      liveWorkspace?.path ||
      (task.worktreeStatus === "active" && task.worktreePath ? task.worktreePath : undefined);
    return this.applyTaskWorkspaceOverridesForPath(task, baseWorkspace, runtimePath);
  }

  private applyTaskFollowUpOverrides(
    task: Task,
    options?: Pick<
      TaskFollowUpInput,
      | "permissionMode"
      | "shellAccess"
      | "accessProfileId"
      | "integrationMentions"
      | "agentConfigOverride"
    >,
  ): { task: Task; changed: boolean } {
    const hasPermissionMode = typeof options?.permissionMode === "string";
    const hasShellAccess = typeof options?.shellAccess === "boolean";
    const hasAccessProfile = typeof options?.accessProfileId === "string";
    const hasIntegrationMentions =
      Boolean(options) && Object.prototype.hasOwnProperty.call(options, "integrationMentions");
    if (!hasPermissionMode && !hasShellAccess && !hasAccessProfile && !hasIntegrationMentions) {
      return { task, changed: false };
    }

    const nextAgentConfig: AgentConfig = { ...task.agentConfig };
    let changed = false;

    if (hasPermissionMode && nextAgentConfig.permissionMode !== options.permissionMode) {
      nextAgentConfig.permissionMode = options.permissionMode;
      changed = true;
    }
    if (hasShellAccess && nextAgentConfig.shellAccess !== options.shellAccess) {
      nextAgentConfig.shellAccess = options.shellAccess;
      changed = true;
    }
    if (hasAccessProfile && nextAgentConfig.accessProfileId !== options.accessProfileId) {
      nextAgentConfig.accessProfileId = options.accessProfileId;
      changed = true;
    }
    if (hasIntegrationMentions) {
      const nextMentions =
        options?.integrationMentions && options.integrationMentions.length > 0
          ? options.integrationMentions
          : undefined;
      if (
        JSON.stringify(nextAgentConfig.integrationMentions ?? null) !==
        JSON.stringify(nextMentions ?? null)
      ) {
        nextAgentConfig.integrationMentions = nextMentions;
        changed = true;
      }
    }

    if (!changed) {
      return { task, changed: false };
    }

    return {
      task: {
        ...task,
        agentConfig: nextAgentConfig,
      },
      changed: true,
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

    const denied = normalizeReadOnlyRoleToolRestrictions(role, role.toolRestrictions?.deniedTools);
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
      if (role.isSystem && READ_ONLY_SHELL_CAPABLE_SYSTEM_ROLE_NAMES.has(role.name)) {
        if (merged.delete("group:destructive")) {
          merged.add("delete_file");
        }
      }

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
    if (input.agentConfig?.interactionMode) {
      input = {
        ...input,
        agentConfig: prepareInteractionTurn(
          input.agentConfig,
          input.agentConfig.interactionMode,
          input.routingPrompt ?? input.prompt,
        ),
      };
    }
    const strategy = TaskStrategyService.derive(route, input.agentConfig, {
      title: input.title,
      prompt: input.prompt,
      lastProgressScore: input.lastProgressScore,
    });
    const agentConfig = TaskStrategyService.applyToAgentConfig(input.agentConfig, strategy);
    const hasExplicitModelOverride =
      typeof input.agentConfig?.modelKey === "string" &&
      input.agentConfig.modelKey.trim().length > 0;
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

  private async applyJevTaskStrategy(
    task: Task,
    route: IntentRoute,
  ): Promise<{
    task: Task;
    changed: boolean;
    profileSelected: boolean;
    status: string;
    strategy?: string;
    reason?: string;
    model?: string;
  }> {
    const config = task.agentConfig;
    if (!config) {
      return {
        task,
        changed: false,
        profileSelected: false,
        status: "skipped",
        reason: "no_agent_config",
      };
    }
    if (
      config.collaborativeMode ||
      config.multitaskMode ||
      config.multiLlmMode ||
      config.verificationAgent ||
      task.parentTaskId ||
      task.source === "cron" ||
      task.source === "subconscious"
    ) {
      return {
        task,
        changed: false,
        profileSelected: false,
        status: "skipped",
        reason:
          task.parentTaskId || task.source === "cron" || task.source === "subconscious"
            ? "explicit_or_background_task"
            : "explicit_or_orchestrated_task",
      };
    }

    let settings: ReturnType<typeof LLMProviderFactory.loadSettings>;
    try {
      settings = LLMProviderFactory.loadSettings();
    } catch {
      return {
        task,
        changed: false,
        profileSelected: false,
        status: "unavailable",
        reason: "settings_unavailable",
      };
    }
    const jevSettings = settings.jev;
    if (
      !jevSettings ||
      jevSettings.adaptiveStrategyEnabled === false ||
      !isJevActiveHarnessEnabled(jevSettings)
    ) {
      return {
        task,
        changed: false,
        profileSelected: false,
        status: "skipped",
        reason: "adaptive_strategy_disabled",
      };
    }
    let resolution: ReturnType<typeof createConfiguredJevProvider>;
    try {
      resolution = createConfiguredJevProvider(settings);
    } catch {
      resolution = null;
    }
    if (!resolution) {
      return {
        task,
        changed: false,
        profileSelected: false,
        status: "unavailable",
        reason: "provider_unavailable",
      };
    }

    const baselineProfile = config.llmProfileHint || "cheap";
    const result = await decideTaskStrategyWithJev({
      provider: resolution.provider,
      decisionService: createDecisionService(resolution.provider, {
        model: resolution.model,
        providerType: resolution.providerType,
        telemetryContext: {
          workspaceId: task.workspaceId,
          taskId: task.id,
          sourceKind: "task-strategy",
        },
        timeoutMs: Math.min(jevSettings.timeoutMs ?? 800, 1_500),
        maxRetries: 0,
        maxCalls: 1,
        maxConcurrent: 1,
        cache: { enabled: true, ttlMs: 30_000, maxEntries: 8 },
      }),
      model: resolution.model,
      title: task.title,
      prompt: task.rawPrompt || task.userPrompt || task.prompt,
      intent: route.intent,
      domain: route.domain,
      executionMode: config.executionMode,
      complexity: route.complexity,
      baselineProfile,
      timeoutMs: Math.min(jevSettings.timeoutMs ?? 800, 1_500),
    });

    const activeRoleCount = this.agentRoleRepo
      .findAll(false)
      .filter((role) => role.isActive).length;
    const strategyCanApply =
      result.strategy === "single_agent" ||
      result.strategy === "verification" ||
      (result.strategy === "team" && activeRoleCount >= 2) ||
      (result.strategy === "multitask" && activeRoleCount >= 2);
    if (result.status !== "selected" || !strategyCanApply) {
      return {
        task,
        changed: false,
        profileSelected: false,
        status: result.status,
        strategy: result.strategy,
        reason: result.reason,
        model: result.model,
      };
    }

    const nextConfig: AgentConfig = {
      ...config,
      ...(result.profile ? { llmProfileHint: result.profile } : {}),
      ...(result.strategy === "team" ? { collaborativeMode: true } : {}),
      ...(result.strategy === "multitask"
        ? {
            collaborativeMode: true,
            multitaskMode: true,
            multitaskLaneCount: Math.max(2, Math.min(4, activeRoleCount)),
            multitaskAssignmentMode: "auto_split" as const,
          }
        : {}),
      ...(result.strategy === "verification"
        ? {
            preflightRequired: true,
            reviewPolicy: "strict" as const,
            qualityPasses: 3 as const,
          }
        : {}),
    };
    return {
      task: { ...task, agentConfig: nextConfig },
      changed: true,
      profileSelected: Boolean(result.profile),
      status: result.status,
      strategy: result.strategy,
      reason: result.reason,
      model: result.model,
    };
  }

  /**
   * Let the active Jev harness choose between profiles that CoWork already
   * considers eligible. This is deliberately advisory: explicit model/profile
   * choices, verification work, collaborative orchestration, and provider
   * failover remain owned by the existing runtime.
   */
  private async applyJevModelRouting(
    task: Task,
    complexity?: "low" | "medium" | "high",
  ): Promise<{
    task: Task;
    changed: boolean;
    status?: string;
    reason?: string;
    route?: "cheap" | "strong";
    model?: string;
  }> {
    const config = task.agentConfig;
    if (!config) return { task, changed: false, status: "skipped", reason: "no_agent_config" };
    if (
      config.modelKey ||
      config.llmProfile ||
      config.llmProfileForced ||
      config.verificationAgent ||
      config.collaborativeMode ||
      config.multitaskMode ||
      config.multiLlmMode ||
      task.parentTaskId
    ) {
      return { task, changed: false, status: "skipped", reason: "explicit_or_orchestrated_task" };
    }

    let settings: ReturnType<typeof LLMProviderFactory.loadSettings>;
    try {
      settings = LLMProviderFactory.loadSettings();
    } catch {
      return { task, changed: false, status: "unavailable", reason: "settings_unavailable" };
    }
    const jevSettings = settings.jev;
    if (
      !jevSettings ||
      jevSettings.modelRoutingEnabled === false ||
      !isJevActiveHarnessEnabled(jevSettings)
    ) {
      return { task, changed: false, status: "skipped", reason: "model_routing_disabled" };
    }

    let resolution: ReturnType<typeof createConfiguredJevProvider>;
    try {
      resolution = createConfiguredJevProvider(settings);
    } catch {
      resolution = null;
    }
    if (!resolution) {
      return { task, changed: false, status: "unavailable", reason: "provider_unavailable" };
    }

    const snapshot = config.taskStrategySnapshot;
    const result = await routeModelWithJev({
      provider: resolution.provider,
      decisionService: createDecisionService(resolution.provider, {
        model: resolution.model,
        providerType: resolution.providerType,
        telemetryContext: {
          workspaceId: task.workspaceId,
          taskId: task.id,
          sourceKind: "model-routing",
        },
        timeoutMs: Math.min(jevSettings.timeoutMs ?? 700, 2_000),
        maxRetries: 0,
        maxCalls: 1,
        maxConcurrent: 1,
        cache: { enabled: true, ttlMs: 30_000, maxEntries: 8 },
      }),
      model: resolution.model,
      title: task.title,
      prompt: task.rawPrompt || task.userPrompt || task.prompt,
      intent: snapshot?.taskIntent,
      domain: snapshot?.taskDomain,
      complexity,
      executionMode: snapshot?.executionMode || config.executionMode,
      baselineProfile: config.llmProfileHint || snapshot?.llmProfileHint || "cheap",
      signal: undefined,
      timeoutMs: Math.min(jevSettings.timeoutMs ?? 700, 2_000),
    });

    if (result.status !== "selected" || !result.route) {
      return {
        task,
        changed: false,
        status: result.status,
        reason: result.reason,
        model: result.model,
      };
    }

    const nextConfig: AgentConfig = {
      ...config,
      llmProfileHint: result.route,
    };
    const nextTask = { ...task, agentConfig: nextConfig };
    return {
      task: nextTask,
      changed: true,
      status: result.status,
      reason: result.reason,
      route: result.route,
      model: result.model,
    };
  }

  /**
   * Initialize the daemon - call after construction to set up queue
   */
  async initialize(): Promise<void> {
    this.orchestrationGraphEngine.start();

    if (this.options.startupRecovery === false) {
      await this.queueManager.initialize([], []);
      return;
    }

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
      try {
        // Rebuild the additive contract/lineage projection before queue
        // recovery so approvals, input requests, and child sessions survive
        // a process restart even when no executor is rehydrated yet.
        this.workSessionContractService.ensureForTask(task);
      } catch (error) {
        log.warn(`[work-session-contracts] Failed to recover task ${task.id}:`, error);
      }
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

    const staleAttachedCliTasks = activeAndIncompleteTasks.filter((task) =>
      this.isStaleAttachedCliTask(task),
    );
    if (staleAttachedCliTasks.length > 0) {
      console.warn(
        `[AgentDaemon] Cancelling ${staleAttachedCliTasks.length} stale attached CLI task(s) whose owner process exited`,
      );
      for (const task of staleAttachedCliTasks) {
        this.cancelTaskRecord(task.id, "CLI task owner exited before completion", {
          completedAt: Date.now(),
        });
      }
    }

    // Approval/input Promises live only in memory.  Rehydrate their durable
    // rows before queue recovery so a restart leaves the task visibly blocked
    // and response handlers can safely resolve the persisted request.
    this.reconcileDurableWaitsOnStartup();

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
        const workspace = this.workspaceRepo.findById(task.workspaceId);
        const effectiveWorkspace = workspace
          ? this.applyTaskWorkspaceOverrides(task, workspace)
          : null;
        const checkpoint = workspace
          ? TranscriptStore.loadCheckpointSync(
              workspace.path,
              task.id,
              (candidatePath) =>
                evaluateWorkspaceFilesystemAccess(effectiveWorkspace!, candidatePath, "read")
                  .decision === "allow",
            )
          : null;
        const snapshot = this.eventRepo.findLatestConversationSnapshot(task.id);
        const planEvents = this.eventRepo.findByTaskIdAndTypes(
          task.id,
          [...RESUME_PLAN_DEFINITION_EVENT_TYPES],
          1,
        );
        const hasSnapshot = Boolean(checkpoint || snapshot);
        const hasPlan = planEvents.some(
          (event) =>
            RESUME_PLAN_DEFINITION_EVENT_TYPES.includes(
              this.resolveLegacyEventType(
                event,
              ) as (typeof RESUME_PLAN_DEFINITION_EVENT_TYPES)[number],
            ) && Boolean(event.payload?.plan),
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

    // Agent handoffs are accepted into a durable target receipt before the
    // recipient worker is woken. If the process exits between those two
    // boundaries, rebuild the exact queue item from the receipt on startup.
    // This is deliberately limited to persistent bot conversations; ordinary
    // user follow-ups retain their existing resume semantics.
    this.recoverQueuedBotMessagesOnStartup();
    this.rehydrateBotHandoffTimeoutsOnStartup();

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

  private reconcileDurableWaitsOnStartup(): void {
    const findByStatus = (this.taskRepo as Any).findByStatus as
      | ((status: TaskStatus | TaskStatus[]) => Task[])
      | undefined;
    const candidateTasks =
      typeof findByStatus === "function"
        ? findByStatus.call(this.taskRepo, [
            "completed",
            "planning",
            "executing",
            "interrupted",
            "paused",
            "blocked",
          ])
        : [];
    const verificationPendingTasks = (Array.isArray(candidateTasks) ? candidateTasks : []).filter(
      (task) => task.terminalStatus === "awaiting_verification",
    );
    for (const task of verificationPendingTasks) {
      if (task.status === "failed" || task.status === "cancelled") continue;

      // The verifier runs in a child task and cannot be resumed in-process
      // after a crash. Re-enter the parent through the normal interrupted-task
      // recovery path instead of leaving it permanently blocked or claiming a
      // completion that was never independently verified.
      this.taskRepo.update(task.id, {
        status: "interrupted",
        completedAt: undefined,
        terminalStatus: undefined,
        failureClass: undefined,
        error: "Verification was interrupted by application restart; resuming the task.",
      });
      this.logEvent(task.id, "verification_wait_rehydrated", {
        reason: "daemon_restart",
      });
      this.logEvent(task.id, "task_interrupted", {
        message: "Verification was interrupted by application restart. Task will resume.",
        reason: "verification_wait_recovered",
      });
    }

    // Restart reconciliation must inspect the complete durable queue. The
    // legacy findPending(limit) API intentionally caps ordinary UI reads, so
    // never use it here or stale approvals beyond the first page could survive
    // a restart.
    const findAllPendingApprovals = (this.approvalRepo as Any).findAllPending;
    const pendingApprovals: ApprovalRequest[] =
      typeof findAllPendingApprovals === "function"
        ? findAllPendingApprovals.call(this.approvalRepo)
        : this.approvalRepo.findPending(1000);
    const promptsDisabled = approvalPromptsDisabled();
    for (const approval of pendingApprovals) {
      const task = this.taskRepo.findById(approval.taskId);
      const explicitHighImpact = isHighImpactApprovalDecision(
        String(approval.type || ""),
        approval.details,
      );
      if (promptsDisabled || explicitHighImpact) {
        // Approval-free runtimes must not resurrect a stale durable wait after
        // restart. Explicit high-impact requests also fail closed even when
        // the legacy popup queue is temporarily enabled for diagnostics.
        this.approvalRepo.update(approval.id, "denied");
        this.logEvent(approval.taskId, "approval_denied", {
          approvalId: approval.id,
          reason: explicitHighImpact
            ? "high_impact_approval_failed_closed_after_restart"
            : "approval_prompts_disabled",
          recoveredAfterRestart: true,
        });
        if (task && !isTerminalTaskStatus(deriveCanonicalTaskStatus(task))) {
          this.taskRepo.update(approval.taskId, {
            status: "failed",
            completedAt: Date.now(),
            terminalStatus: "failed",
            failureClass: "tool_error",
            error: explicitHighImpact
              ? "Approval request removed because the application restarted before a decision."
              : "Approval request removed because approval prompts are disabled.",
          });
        }
        continue;
      }
      if (!task || isTerminalTaskStatus(deriveCanonicalTaskStatus(task))) continue;

      const alreadyRehydrated =
        task.status === "blocked" && task.terminalStatus === "awaiting_approval";
      if (alreadyRehydrated) continue;

      this.taskRepo.update(approval.taskId, {
        status: "blocked",
        completedAt: undefined,
        terminalStatus: "awaiting_approval",
        failureClass: undefined,
        error:
          task.error || "Awaiting approval. Respond to the pending approval request to resume.",
      });
      this.logEvent(approval.taskId, "approval_wait_rehydrated", {
        approvalId: approval.id,
        reason: "daemon_restart",
      });
    }

    // Older builds could leave the task lifecycle marker behind after the
    // approval row had already timed out or been removed. Do not let that stale
    // marker keep a completed/failed task looking approval-blocked forever.
    for (const task of Array.isArray(candidateTasks) ? candidateTasks : []) {
      if (task.terminalStatus !== "awaiting_approval") continue;
      if (this.approvalRepo.findPendingByTaskId(task.id).length > 0) continue;

      const terminal = isTerminalTaskStatus(deriveCanonicalTaskStatus(task));
      this.taskRepo.update(task.id, {
        ...(terminal
          ? { terminalStatus: task.status === "completed" ? "ok" : "failed" }
          : {
              status: "failed",
              completedAt: Date.now(),
              terminalStatus: "failed",
              failureClass: "tool_error",
            }),
        error:
          task.error || "Approval wait cleared because no approval request remains for this task.",
      });
      this.logEvent(task.id, "approval_wait_cleared", {
        reason: "missing_pending_approval",
      });
    }

    const findAllPendingInputs = (this.inputRequestRepo as Any).findAllPending;
    const pendingInputs: InputRequest[] =
      typeof findAllPendingInputs === "function"
        ? findAllPendingInputs.call(this.inputRequestRepo)
        : this.inputRequestRepo.list({
            limit: 1000,
            offset: 0,
            status: "pending",
          });
    for (const request of pendingInputs) {
      const task = this.taskRepo.findById(request.taskId);

      // Assistant approval cards are explicit consent decisions. They must
      // fail closed across a restart just like the legacy approval rows; a
      // fresh task turn can ask again with current authority and context.
      if (isAssistantApprovalInputRequest(request)) {
        if (typeof (this.inputRequestRepo as Any).resolve === "function") {
          this.inputRequestRepo.resolve(request.id, "dismissed");
        }
        this.logEvent(request.taskId, "approval_denied", {
          requestId: request.id,
          reason: "assistant_approval_failed_closed_after_restart",
          recoveredAfterRestart: true,
        });
        if (task && !isTerminalTaskStatus(deriveCanonicalTaskStatus(task))) {
          this.taskRepo.update(request.taskId, {
            status: "failed",
            completedAt: Date.now(),
            terminalStatus: "failed",
            failureClass: "tool_error",
            error: "Approval request removed because the application restarted before a decision.",
          });
        }
        continue;
      }
      if (!task || isTerminalTaskStatus(deriveCanonicalTaskStatus(task))) continue;

      const alreadyRehydrated =
        task.status === "paused" && task.terminalStatus === "needs_user_action";
      if (alreadyRehydrated) continue;

      this.taskRepo.update(request.taskId, {
        status: "paused",
        completedAt: undefined,
        terminalStatus: "needs_user_action",
        failureClass: undefined,
        error:
          task.error ||
          "Waiting for structured user input. Respond to the pending request to resume.",
      });
      this.logEvent(request.taskId, "input_wait_rehydrated", {
        requestId: request.id,
        reason: "daemon_restart",
      });
    }
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
      // Release any MCP server connections held by this executor to prevent process leaks
      try {
        void MCPClientManager.getInstance()
          ?.releaseForExecutor(taskId)
          .catch(() => {
            // Ignore release failures during cache cleanup.
          });
      } catch {
        // Ignore — MCPClientManager may not be initialized
      }
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
    if (this.shutdownRequested) {
      throw new Error("Agent daemon is shutting down; task was not admitted.");
    }
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
    if (this.shutdownRequested) return;
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    this.getAdmittedStartOperations().add(admission);
    try {
      console.log(`[AgentDaemon] Starting task ${task.id}: ${task.title}`);

      if (this.shouldStartAsQueuedContinuation(task)) {
        this.pendingContinuationTaskIds.delete(task.id);
        await this.startQueuedContinuation(task);
        return;
      }

      // Existing bot conversations may have been created before persistent
      // team support was enabled. Normalize them before the executor is
      // created so the current turn gets the hybrid/execute team contract and
      // can see the bot handoff tool.
      const teamNormalizedTask = this.ensureBotTaskTeam(task);
      const { task: effectiveTask, changed: roleOverridesChanged } =
        this.applyAgentRoleOverrides(teamNormalizedTask);
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
      let executionTask = runtimeStrategy.task;
      if (runtimeStrategy.agentConfigChanged) {
        try {
          this.taskRepo.update(effectiveTask.id, { agentConfig: executionTask.agentConfig });
        } catch (error) {
          console.warn("[AgentDaemon] Failed to persist runtime strategy agent config:", error);
        }
      }
      if (runtimeStrategy.promptChanged || runtimeStrategy.agentConfigChanged) {
        this.logEvent(effectiveTask.id, "log", {
          metric: "task_strategy_selected",
          message:
            `Execution strategy active: intent=${runtimeStrategy.route.intent}, ` +
            `domain=${runtimeStrategy.strategy.taskDomain}, convoMode=${runtimeStrategy.strategy.conversationMode}, ` +
            `execMode=${runtimeStrategy.strategy.executionMode}, answerFirst=${runtimeStrategy.strategy.answerFirst}, ` +
            `llmProfileHint=${runtimeStrategy.strategy.llmProfileHint}`,
          routingConfidence: runtimeStrategy.route.confidence,
          directResponseMode: runtimeStrategy.strategy.snapshot.directResponseMode,
          preflightGates: runtimeStrategy.strategy.snapshot.preflightGates,
          workflowMode: runtimeStrategy.strategy.snapshot.workflowMode,
          llmProfileHint: runtimeStrategy.strategy.llmProfileHint,
        });
      }

      const jevStrategy = await this.applyJevTaskStrategy(executionTask, runtimeStrategy.route);
      executionTask = jevStrategy.task;
      if (jevStrategy.changed) {
        try {
          this.taskRepo.update(executionTask.id, { agentConfig: executionTask.agentConfig });
        } catch (error) {
          console.warn("[AgentDaemon] Failed to persist Jev task strategy:", error);
        }
      }
      if (jevStrategy.status && jevStrategy.status !== "skipped") {
        this.logEvent(executionTask.id, "jev_decision", {
          decisionKind: "task_strategy",
          status: jevStrategy.status,
          reason: jevStrategy.reason,
          strategy: jevStrategy.strategy,
          decisionModel: jevStrategy.model,
          message:
            jevStrategy.status === "selected"
              ? `Jev selected the ${jevStrategy.strategy || "single-agent"} task strategy.`
              : "Jev task-strategy selection was unavailable or abstained; continuing with the configured route.",
        });
      }

      if (!jevStrategy.profileSelected) {
        const routed = await this.applyJevModelRouting(
          executionTask,
          runtimeStrategy.route.complexity,
        );
        executionTask = routed.task;
        if (routed.changed) {
          try {
            this.taskRepo.update(executionTask.id, { agentConfig: executionTask.agentConfig });
          } catch (error) {
            console.warn("[AgentDaemon] Failed to persist Jev model route:", error);
          }
        }
        if (routed.status && routed.status !== "skipped") {
          this.logEvent(executionTask.id, "jev_decision", {
            decisionKind: "model_routing",
            status: routed.status,
            reason: routed.reason,
            route: routed.route,
            decisionModel: routed.model,
            message:
              routed.status === "selected"
                ? `Jev selected the ${routed.route} model profile for this task.`
                : "Jev model routing was unavailable or abstained; continuing with the configured route.",
          });
        }
      }

      if (await this.maybeLaunchCollaborativeTask(executionTask)) {
        this.finishQueueSlot(executionTask.id);
        return;
      }
      if (this.shutdownRequested) {
        this.finishQueueSlot(executionTask.id);
        return;
      }

      const wasQueued = executionTask.status === "queued";
      if (wasQueued) {
        const isRetry = this.retryCounts.has(executionTask.id);
        const count = this.retryCounts.get(executionTask.id) ?? 0;
        const retrySuffix = isRetry ? ` (retry ${count}/${this.maxTaskRetries})` : "";
        this.logEvent(executionTask.id, "task_dequeued", {
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
      const effectiveAccessProfile = resolveEffectiveAccessProfile({
        task: executionTask,
        workspace,
        settings: PermissionSettingsManager.loadSettings(),
        adminPolicies: loadPolicies(),
      });
      if (effectiveAccessProfile.profileUnavailable) {
        const errorMessage =
          "The selected access profile is unavailable. Choose a valid profile before running this task.";
        this.updateTask(executionTask.id, {
          status: "paused",
          terminalStatus: "needs_user_action",
          awaitingUserInputReasonCode: "access_profile_unavailable",
          error: errorMessage,
        });
        this.logEvent(executionTask.id, "task_paused", {
          message: errorMessage,
          reason: "access_profile_unavailable",
          accessProfileId: executionTask.agentConfig?.accessProfileId,
        });
        this.finishQueueSlot(executionTask.id);
        return;
      }
      const requiresWorktree = executionTask.agentConfig?.requireWorktree === true;
      const canUseWorktree = await this.worktreeManager.shouldUseWorktree(
        workspace.path,
        workspace.isTemp,
        requiresWorktree,
      );
      if (this.shutdownRequested) {
        this.finishQueueSlot(executionTask.id);
        return;
      }
      if (requiresWorktree && (!canUseWorktree || effectiveWorkspace.permissions.write !== true)) {
        const errorMessage =
          effectiveWorkspace.permissions.write !== true
            ? "Task requires git worktree isolation, but the active access profile does not allow workspace writes."
            : "Task requires git worktree isolation, but worktrees are unavailable for this workspace.";
        this.failTask(executionTask.id, errorMessage, {
          terminalStatus: "failed",
          failureClass: "dependency_unavailable",
        });
        this.logEvent(executionTask.id, "error", {
          message: errorMessage,
        });
        return;
      }
      if (canUseWorktree && effectiveWorkspace.permissions.write === true) {
        try {
          const worktreeStoragePath = await this.worktreeManager.getWorktreeStoragePath(
            workspace.path,
          );
          this.assertTaskBaseWorkspaceFilesystemAccess(
            executionTask.id,
            worktreeStoragePath,
            "write",
            "worktree storage",
          );
          this.assertTaskBaseWorkspaceFilesystemAccess(
            executionTask.id,
            path.join(path.dirname(worktreeStoragePath), ".gitignore"),
            "write",
            "worktree gitignore",
          );
          const worktreeInfo = await this.worktreeManager.createForTask(
            executionTask.id,
            executionTask.title,
            workspace.id,
            workspace.path,
          );

          // Create a virtual workspace pointing to the worktree
          effectiveWorkspace = this.applyTaskWorkspaceOverridesForPath(
            executionTask,
            workspace,
            worktreeInfo.worktreePath,
          );

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

      // Setup can outlive the shutdown request. Never activate a new executor
      // after the fence; the admission tracker keeps shutdown waiting for this
      // starter before dependencies are released.
      if (this.shutdownRequested) {
        this.finishQueueSlot(executionTask.id);
        return;
      }

      try {
        await this.taskMutationLedger?.initializeTask(executionTask.id, effectiveWorkspace.path, {
          isolatedWorktree: Boolean(executionTask.worktreePath),
        });
      } catch (error) {
        console.warn("[AgentDaemon] Failed to initialize task mutation attribution:", error);
      }

      if (this.shutdownRequested) {
        this.finishQueueSlot(executionTask.id);
        return;
      }

      // Create task executor - wrapped in try-catch to handle provider initialization errors.
      // Queue-only bot handoffs create an idle executor first so the durable
      // message can be admitted. Reuse that executor here; replacing it would
      // discard the in-memory follow-up immediately before the worker starts.
      let executor: TaskExecutor;
      const cachedExecutor = this.activeTasks.get(executionTask.id);
      const reusableCache =
        cachedExecutor && !cachedExecutor.executor.isRunning ? cachedExecutor : undefined;
      const reusableExecutor = reusableCache?.executor;
      try {
        if (reusableExecutor) {
          executor = reusableExecutor;
          executor.updateTaskAgentConfig(executionTask.agentConfig);
          executor.updateWorkspace(effectiveWorkspace);
          reusableCache.lastAccessed = Date.now();
          reusableCache.status = "active";
          console.log(`[AgentDaemon] Reusing queued TaskExecutor for ${executionTask.id}`);
        } else {
          console.log(`[AgentDaemon] Creating TaskExecutor...`);
          executor = new TaskExecutor(executionTask, effectiveWorkspace, this);
          // Attach any images that were provided at task creation time
          const initialImages = this.pendingTaskImages.get(executionTask.id);
          if (initialImages && initialImages.length > 0) {
            executor.setInitialImages(initialImages);
            this.pendingTaskImages.delete(executionTask.id);
          }
          console.log(`[AgentDaemon] TaskExecutor created successfully`);
        }
      } catch (error: Any) {
        console.error(`[AgentDaemon] Task ${effectiveTask.id} failed to initialize:`, error);
        this.failTask(effectiveTask.id, error.message || "Failed to initialize task executor");
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
          if (this.shutdownRequested) return;
          // After execution completes, process any follow-ups that were queued
          // while the executor was running but arrived too late for the loop to pick up.
          this.processOrphanedFollowUps(effectiveTask.id, executor);
        })
        .catch((error) => {
          MemoryService.clearExecutionSideChannelPolicy();
          if (this.shutdownRequested) return;
          console.error(`[AgentDaemon] Task ${effectiveTask.id} execution failed:`, error);
          this.failTask(effectiveTask.id, error.message);
          this.logEvent(effectiveTask.id, "error", { error: error.message });
          this.activeTasks.delete(effectiveTask.id);
          // Even on failure, process orphaned follow-ups so they aren't silently lost
          this.processOrphanedFollowUps(effectiveTask.id, executor);
        });
    } finally {
      this.getAdmittedStartOperations().delete(admission);
      releaseAdmission();
    }
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
    const source = String(task.source || "manual")
      .trim()
      .toLowerCase();
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
    if (
      current.status !== "interrupted" &&
      current.status !== "planning" &&
      current.status !== "executing"
    ) {
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
  private async resumeInterruptedTask(task: Task, resumeMessage?: string): Promise<void> {
    if (this.shutdownRequested) return;
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

    const checkpointWorkspace = this.applyTaskWorkspaceOverrides(task, workspace);
    const readGuard = (candidatePath: string): boolean =>
      evaluateWorkspaceFilesystemAccess(checkpointWorkspace, candidatePath, "read").decision ===
      "allow";
    const checkpoint = TranscriptStore.loadCheckpointSync(workspace.path, task.id, readGuard);
    const events = this.getTaskEventsForResume(task.id, workspace.path, readGuard);
    const recoveredBotHandoff =
      task.agentConfig?.botConversation === true
        ? this.findRecoverableBotHandoff(task, this.getTaskEventsForReplay(task.id))
        : undefined;

    // Check if we have meaningful state to restore from
    const hasSnapshot =
      Boolean(checkpoint) || events.some((e) => this.isLegacyEventType(e, "conversation_snapshot"));
    const planEvent = events
      .filter(
        (event) =>
          RESUME_PLAN_DEFINITION_EVENT_TYPES.includes(
            this.resolveLegacyEventType(
              event,
            ) as (typeof RESUME_PLAN_DEFINITION_EVENT_TYPES)[number],
          ) && Boolean(event.payload?.plan),
      )
      .pop();
    const hasPlan = planEvent && planEvent.payload?.plan;

    // A delivered teammate handoff is meaningful durable state even when the
    // receiver has not persisted a conversation snapshot or execution plan
    // yet. Let resumeAfterInterruption replay that exact handoff instead of
    // falling back to the bot persona's synthetic starter prompt.
    if (
      shouldRestartInterruptedTask({
        hasSnapshot,
        hasPlan: Boolean(hasPlan),
        hasRecoveredBotHandoff: Boolean(recoveredBotHandoff),
      })
    ) {
      if (this.shutdownRequested) return;
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

    if (this.shutdownRequested) return;

    // Handle worktree workspace if applicable
    let effectiveWorkspace = this.applyTaskWorkspaceOverrides(effectiveTask, workspace);
    if (task.worktreePath && task.worktreeStatus === "active") {
      if (fs.existsSync(task.worktreePath)) {
        effectiveWorkspace = this.applyTaskWorkspaceOverridesForPath(
          effectiveTask,
          workspace,
          task.worktreePath,
        );
      } else {
        console.warn(
          `[AgentDaemon] Worktree path ${task.worktreePath} no longer exists for task ${task.id}`,
        );
      }
    }

    // Create new executor and restore conversation state
    const executor = new TaskExecutor(effectiveTask, effectiveWorkspace, this);
    executor.rebuildConversationFromEvents(events);

    // A structured input/approval response can arrive after the original
    // executor disappeared. Queue it before starting the resumed executor so
    // the first resumed kernel iteration consumes the answer instead of
    // replaying the same wait and losing the user's decision.
    const queuedResumeMessage = String(resumeMessage || "").trim();
    if (queuedResumeMessage) {
      if (this.shutdownRequested) return;
      executor.queueFollowUp(queuedResumeMessage);
      this.logEvent(effectiveTask.id, "user_message", {
        message: queuedResumeMessage,
        durableWaitResponse: true,
      });
    }

    // Reconstruct the Plan from events with correct step statuses
    if (hasPlan) {
      const rawPlan = planEvent!.payload.plan as Plan;
      const completedStepIds = new Set<string>();
      const failedStepIds = new Set<string>();
      const skippedStepIds = new Set<string>();
      for (const event of events) {
        if (this.isLegacyEventType(event, "step_completed") && event.payload?.step?.id) {
          completedStepIds.add(event.payload.step.id);
        }
        if (this.isLegacyEventType(event, "step_failed") && event.payload?.step?.id) {
          failedStepIds.add(event.payload.step.id);
        }
        if (this.isLegacyEventType(event, "step_skipped") && event.payload?.step?.id) {
          skippedStepIds.add(event.payload.step.id);
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
              : skippedStepIds.has(step.id)
                ? ("skipped" as const)
                : ("pending" as const),
        })),
      };
      executor.setPlan(restoredPlan);
    }

    // Register in active tasks map
    if (this.shutdownRequested) return;
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
      .resumeAfterInterruption(recoveredBotHandoff)
      .then(() => {
        MemoryService.clearExecutionSideChannelPolicy();
        if (this.shutdownRequested) return;
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      })
      .catch((error) => {
        MemoryService.clearExecutionSideChannelPolicy();
        if (this.shutdownRequested) return;
        console.error(`[AgentDaemon] Resumed task ${effectiveTask.id} failed:`, error);
        this.failTask(effectiveTask.id, error.message);
        this.logEvent(effectiveTask.id, "error", { error: error.message });
        this.activeTasks.delete(effectiveTask.id);
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      });
  }

  private findRecoverableBotHandoff(
    task: Task,
    events: TaskEvent[],
  ):
    | Pick<
        TaskFollowUpInput,
        | "message"
        | "messageSource"
        | "messageId"
        | "senderTaskId"
        | "senderLabel"
        | "inReplyToMessageId"
        | "inReplyToTaskId"
      >
    | undefined {
    if (task.agentConfig?.botConversation !== true) return undefined;

    const inbound = events.filter((event) => {
      if (this.resolveLegacyEventType(event) !== "user_message") return false;
      const payload = (event.payload || {}) as Record<string, unknown>;
      return (
        payload.messageSource === "agent" &&
        payload.deliveryMode === "message" &&
        (payload.deliveryStatus === "delivered" || payload.status === "delivered") &&
        typeof payload.messageId === "string" &&
        payload.messageId.trim().length > 0 &&
        typeof payload.senderTaskId === "string" &&
        payload.senderTaskId.trim().length > 0 &&
        typeof payload.message === "string" &&
        payload.message.trim().length > 0
      );
    });

    for (const event of inbound.slice().reverse()) {
      const payload = (event.payload || {}) as Record<string, unknown>;
      const messageId = String(payload.messageId).trim();
      const alreadyReplied = events.some((candidate) => {
        if (this.resolveLegacyEventType(candidate) !== "agent_message") return false;
        const candidatePayload = (candidate.payload || {}) as Record<string, unknown>;
        const matchesInbound =
          candidatePayload.inReplyToMessageId === messageId &&
          (typeof candidatePayload.senderTaskId !== "string" ||
            candidatePayload.senderTaskId === task.id);
        if (!matchesInbound) return false;

        // A queued/started reply is still recoverable from its durable
        // receipt, but failed or quarantined delivery is not a reply. Do not
        // strand the original handoff after a restart just because an
        // attempted reply left an `inReplyToMessageId` behind.
        const deliveryStatus =
          candidatePayload.deliveryStatus ??
          candidatePayload.delivery_status ??
          candidatePayload.status;
        return deliveryStatus !== "failed" && deliveryStatus !== "quarantined";
      });
      if (alreadyReplied) continue;

      return {
        message: String(payload.message),
        messageSource: "agent",
        messageId,
        senderTaskId: String(payload.senderTaskId).trim(),
        ...(typeof payload.senderLabel === "string" && payload.senderLabel.trim()
          ? { senderLabel: payload.senderLabel }
          : {}),
        ...(typeof payload.inReplyToMessageId === "string"
          ? { inReplyToMessageId: payload.inReplyToMessageId }
          : {}),
        ...(typeof payload.inReplyToTaskId === "string"
          ? { inReplyToTaskId: payload.inReplyToTaskId }
          : {}),
      };
    }
    return undefined;
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

    let effectiveWorkspace = this.applyTaskWorkspaceOverrides(effectiveTask, workspace);
    if (task.worktreePath && task.worktreeStatus === "active" && fs.existsSync(task.worktreePath)) {
      effectiveWorkspace = this.applyTaskWorkspaceOverridesForPath(
        effectiveTask,
        workspace,
        task.worktreePath,
      );
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
        if (this.shutdownRequested) return;
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      })
      .catch((error) => {
        MemoryService.clearExecutionSideChannelPolicy();
        if (this.shutdownRequested) return;
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
    const latestError = [...events]
      .reverse()
      .find((event) => this.isLegacyEventType(event, "error"));
    if (!latestError || now - (latestError.timestamp || 0) > windowMs) {
      return false;
    }
    const payload =
      latestError.payload && typeof latestError.payload === "object" ? latestError.payload : {};
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
    if (this.shutdownRequested) return;
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

    if (this.shutdownRequested) return;

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
    if (this.shutdownRequested) {
      throw new Error("Agent daemon is shutting down; continuation was not admitted.");
    }
    // Guard against double-click: if the task is already running, bail out
    if (this.activeTasks.has(taskId)) {
      console.log(`[AgentDaemon] Task ${taskId} is already active, ignoring continue request`);
      return;
    }

    const task = this.getTaskWithTransientAgentConfig(this.taskRepo.findById(taskId));
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
    sideChat?: boolean;
    initialMessage?: string;
  }): Promise<Task> {
    const sourceTask = this.taskRepo.findById(params.taskId);
    if (!sourceTask) {
      throw new Error(`Task ${params.taskId} not found`);
    }
    const sourceEvents = this.getTaskEventsForReplay(sourceTask.id);
    const explicitPrompt =
      typeof params.prompt === "string" && params.prompt.trim().length > 0
        ? params.prompt.trim()
        : undefined;
    const initialMessage =
      params.sideChat && typeof params.initialMessage === "string"
        ? params.initialMessage.trim()
        : "";
    const forkHistory = this.buildForkHistory(sourceEvents, {
      fromEventId: params.fromEventId,
      useSelectedUserMessageAsPrompt: !explicitPrompt,
    });
    const branchLabel =
      typeof params.branchLabel === "string" && params.branchLabel.trim().length > 0
        ? params.branchLabel.trim()
        : `fork-${new Date().toISOString().slice(11, 19).replace(/:/g, "-")}`;
    const nextPrompt =
      explicitPrompt ||
      forkHistory.prefillPrompt ||
      sourceTask.userPrompt ||
      sourceTask.rawPrompt ||
      sourceTask.prompt;

    const sideChatAgentConfig: AgentConfig | undefined = params.sideChat
      ? {
          ...sourceTask.agentConfig,
          conversationMode: "chat",
          executionMode: "chat",
          executionModeSource: "user",
          autonomousMode: false,
          permissionMode: undefined,
          shellAccess: false,
          requireWorktree: false,
          allowUserInput: true,
          humanInputPolicy: "hard_blockers",
          toolRestrictions: ["*"],
          allowedTools: [],
          maxTurns: 2,
          windowTurnCap: 2,
          lifetimeMaxTurns: 8,
        }
      : sourceTask.agentConfig;

    const { task: forkedTask, derived } = this.createTaskRecord({
      title: `${sourceTask.title} (${branchLabel})`,
      prompt: nextPrompt,
      workspaceId: sourceTask.workspaceId,
      agentConfig: sideChatAgentConfig,
      source: params.sideChat ? "side_chat" : sourceTask.source || "manual",
      taskOverrides: {
        sessionId: crypto.randomUUID(),
        branchFromTaskId: sourceTask.id,
        branchFromEventId: params.fromEventId,
        branchLabel,
        ...(sourceTask.assignedAgentRoleId
          ? { assignedAgentRoleId: sourceTask.assignedAgentRoleId }
          : {}),
      },
    });

    this.cloneForkHistoryEvents({
      sourceTaskId: sourceTask.id,
      targetTaskId: forkedTask.id,
      events: forkHistory.events,
    });
    this.logEvent(forkedTask.id, "log", {
      message: "Session fork created",
      sourceTaskId: sourceTask.id,
      branchLabel,
      branchFromEventId: params.fromEventId,
      copiedEvents: forkHistory.events.length,
      sideChat: params.sideChat === true,
    });
    this.logTaskIntentRouted(forkedTask.id, derived);
    if (params.sideChat && initialMessage) {
      void this.sendMessage(forkedTask.id, initialMessage).catch((error) => {
        log.error(`[AgentDaemon] Failed to start sidechat ${forkedTask.id}:`, error);
        this.logEvent(forkedTask.id, "log", {
          message: "Side conversation failed to start",
          error: String((error as Any)?.message || error),
        });
      });
    }

    return forkedTask;
  }

  private buildForkHistory(
    sourceEvents: TaskEvent[],
    options: {
      fromEventId?: string;
      useSelectedUserMessageAsPrompt?: boolean;
    },
  ): { events: TaskEvent[]; prefillPrompt?: string } {
    let cutoff = sourceEvents.length;
    let prefillPrompt: string | undefined;
    const requestedEventId =
      typeof options.fromEventId === "string" && options.fromEventId.trim().length > 0
        ? options.fromEventId.trim()
        : undefined;

    if (requestedEventId) {
      const selectedIndex = sourceEvents.findIndex((event) => {
        return (
          event.id === requestedEventId ||
          event.eventId === requestedEventId ||
          (typeof event.payload?.eventId === "string" && event.payload.eventId === requestedEventId)
        );
      });
      if (selectedIndex < 0) {
        throw new Error(`Event ${requestedEventId} not found in task history`);
      }

      const selectedEvent = sourceEvents[selectedIndex];
      const selectedType = this.resolveLegacyEventType(selectedEvent);
      if (selectedType === "user_message") {
        cutoff = selectedIndex;
        if (
          options.useSelectedUserMessageAsPrompt &&
          typeof selectedEvent.payload?.message === "string"
        ) {
          prefillPrompt = selectedEvent.payload.message.trim() || undefined;
        }
      } else {
        cutoff = selectedIndex + 1;
      }
    }

    return {
      events: sourceEvents.slice(0, cutoff).filter((event) => this.isForkReplayEvent(event)),
      ...(prefillPrompt ? { prefillPrompt } : {}),
    };
  }

  private isForkReplayEvent(event: TaskEvent): boolean {
    const effectiveType = this.resolveLegacyEventType(event);
    if (effectiveType.startsWith("timeline_")) return true;
    return FORK_REPLAY_EVENT_TYPES.has(effectiveType);
  }

  private cloneForkHistoryEvents(params: {
    sourceTaskId: string;
    targetTaskId: string;
    events: TaskEvent[];
    startSeq?: number;
  }): void {
    let seq =
      typeof params.startSeq === "number" && Number.isFinite(params.startSeq)
        ? Math.max(0, Math.floor(params.startSeq))
        : 0;
    for (const event of params.events) {
      seq += 1;
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? {
              ...(event.payload as Record<string, unknown>),
              forkedFromTaskId: params.sourceTaskId,
              forkedFromEventId: event.eventId || event.id,
            }
          : {
              value: event.payload,
              forkedFromTaskId: params.sourceTaskId,
              forkedFromEventId: event.eventId || event.id,
            };
      this.eventRepo.create({
        taskId: params.targetTaskId,
        timestamp: event.timestamp,
        type: event.type,
        payload,
        schemaVersion: event.schemaVersion,
        eventId: crypto.randomUUID(),
        seq,
        ts: event.ts ?? event.timestamp,
        status: event.status,
        stepId: event.stepId,
        groupId: event.groupId,
        actor: event.actor,
        legacyType: event.legacyType,
      });
    }
    this.taskSeqById.set(params.targetTaskId, seq);
  }

  private getForkedFromEventId(event: TaskEvent, sourceTaskId: string): string | undefined {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : undefined;
    if (!payload || Array.isArray(payload)) return undefined;
    if (payload.forkedFromTaskId !== sourceTaskId) return undefined;
    return typeof payload.forkedFromEventId === "string" &&
      payload.forkedFromEventId.trim().length > 0
      ? payload.forkedFromEventId.trim()
      : undefined;
  }

  private refreshSideChatParentSnapshot(task: Task): void {
    if (task.source !== "side_chat") return;
    const parentTaskId = task.branchFromTaskId;
    if (!parentTaskId) return;
    const sourceTask = this.taskRepo.findById(parentTaskId);
    if (!sourceTask) return;
    // Never pull events across a workspace boundary — a side-chat may only
    // mirror the parent it was forked from within the same workspace.
    if (sourceTask.workspaceId !== task.workspaceId) {
      log.warn(
        `[AgentDaemon] Refusing side-chat snapshot refresh across workspaces (side-chat ${task.id} -> parent ${parentTaskId})`,
      );
      return;
    }

    const targetEvents = this.eventRepo.findByTaskId(task.id);
    const clonedSourceEventIds = new Set<string>();
    let maxSeq = 0;
    for (const event of targetEvents) {
      if (typeof event.seq === "number" && Number.isFinite(event.seq)) {
        maxSeq = Math.max(maxSeq, Math.floor(event.seq));
      }
      const sourceEventId = this.getForkedFromEventId(event, parentTaskId);
      if (sourceEventId) clonedSourceEventIds.add(sourceEventId);
    }

    const allMissingEvents = this.getTaskEventsForReplay(parentTaskId).filter((event) => {
      if (!this.isForkReplayEvent(event)) return false;
      const sourceEventId = event.eventId || event.id;
      if (!sourceEventId) return false;
      return !clonedSourceEventIds.has(sourceEventId);
    });
    if (allMissingEvents.length === 0) return;

    // Bound the per-refresh clone so a long-running parent (thousands of events)
    // cannot trigger an unbounded copy on every side-chat turn. We keep the most
    // recent events, which carry the latest status the side-chat asks about.
    const SIDE_CHAT_REFRESH_EVENT_CAP = 200;
    const missingEvents =
      allMissingEvents.length > SIDE_CHAT_REFRESH_EVENT_CAP
        ? allMissingEvents.slice(-SIDE_CHAT_REFRESH_EVENT_CAP)
        : allMissingEvents;

    this.cloneForkHistoryEvents({
      sourceTaskId: parentTaskId,
      targetTaskId: task.id,
      events: missingEvents,
      startSeq: maxSeq,
    });
    this.logEvent(task.id, "log", {
      message: "Side conversation refreshed parent session context",
      sourceTaskId: parentTaskId,
      copiedEvents: missingEvents.length,
    });
  }

  private isSideChatTask(task: Task): boolean {
    return task.source === "side_chat";
  }

  private isSideChatStatusQuestion(message: string): boolean {
    // Note: no bare "now" alternative — it matched unrelated phrases like
    // "not now" or "I know what to do now". Status intent is already covered by
    // the explicit phrases below.
    return /\b(how(?:'s| is)? it going|how(?:'s| is)? this going|status|progress|current(?:ly)?|latest|update|what(?:'s| is) happening|where (?:are we|is it)|still running|done yet|finished yet)\b/i.test(
      message,
    );
  }

  private truncateSideChatContextText(value: string, maxLength = 420): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
  }

  private extractSideChatEventText(event: TaskEvent): string {
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : undefined;
    const candidates = [
      payload?.message,
      payload?.summary,
      payload?.text,
      payload?.content,
      payload?.error,
      payload?.command,
      payload?.cmd,
      payload?.toolName,
      payload?.name,
      payload?.title,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return this.truncateSideChatContextText(candidate);
      }
    }
    if (payload && typeof payload.status === "string" && payload.status.trim().length > 0) {
      return `status=${payload.status.trim()}`;
    }
    return "";
  }

  private formatSideChatStatusEvent(event: TaskEvent): string {
    const type = this.resolveLegacyEventType(event);
    const timestamp =
      typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
        ? new Date(event.timestamp).toISOString()
        : "";
    const text = this.extractSideChatEventText(event);
    const status =
      typeof event.status === "string" && event.status.length > 0 ? ` [${event.status}]` : "";
    return `- ${timestamp ? `${timestamp} ` : ""}${type}${status}${text ? `: ${text}` : ""}`;
  }

  private buildSideChatParentStatusContext(task: Task, message: string): string | undefined {
    if (!this.isSideChatTask(task) || !this.isSideChatStatusQuestion(message)) return undefined;
    const parentTaskId = task.branchFromTaskId;
    if (!parentTaskId) return undefined;
    const parentTask = this.taskRepo.findById(parentTaskId);
    if (!parentTask) return undefined;

    const parentEvents = this.getTaskEventsForReplay(parentTaskId);
    const activeParent = this.activeTasks.get(parentTaskId);
    const runtimeState = activeParent?.executor?.isRunning
      ? "running"
      : activeParent?.status || "not active in memory";
    const activeStage = this.activeTimelineStageByTask.get(parentTaskId);
    const activeStepIds = Array.from(this.activeStepIdsByTask.get(parentTaskId) || []);
    const failedStepIds = Array.from(this.failedPlanStepsByTask.get(parentTaskId) || []);
    const latestEvents = parentEvents
      .filter((event) => {
        const type = this.resolveLegacyEventType(event);
        return (
          type === "user_message" ||
          type === "assistant_message" ||
          type === "task_status" ||
          type === "task_completed" ||
          type === "task_cancelled" ||
          type === "task_failed" ||
          type === "executing" ||
          type === "log" ||
          type === "error" ||
          type === "tool_call" ||
          type === "tool_result" ||
          type.startsWith("timeline_") ||
          type.startsWith("step_")
        );
      })
      .slice(-14)
      .map((event) => this.formatSideChatStatusEvent(event))
      .filter((line) => line.trim().length > 0);

    return [
      "LIVE_PARENT_STATUS",
      `Generated at: ${new Date().toISOString()}`,
      `User side question: ${this.truncateSideChatContextText(message, 240)}`,
      `Parent task id: ${parentTask.id}`,
      `Parent task title: ${parentTask.title || "(untitled)"}`,
      `Parent task status: ${parentTask.status || "unknown"}`,
      `Parent runtime state: ${runtimeState}`,
      parentTask.error ? `Parent error: ${this.truncateSideChatContextText(parentTask.error)}` : "",
      typeof parentTask.resultSummary === "string" && parentTask.resultSummary.trim().length > 0
        ? `Parent result summary: ${this.truncateSideChatContextText(parentTask.resultSummary)}`
        : "",
      activeStage ? `Active timeline stage: ${activeStage}` : "",
      activeStepIds.length > 0 ? `Active step ids: ${activeStepIds.slice(0, 8).join(", ")}` : "",
      failedStepIds.length > 0 ? `Failed step ids: ${failedStepIds.slice(0, 8).join(", ")}` : "",
      latestEvents.length > 0
        ? ["Recent live parent events:", ...latestEvents].join("\n")
        : "Recent live parent events: none available",
      [
        "Side-chat answer policy:",
        "- For progress/status/current-state questions, answer from LIVE_PARENT_STATUS first.",
        "- Treat prior side-chat answers as historical conversation only; do not use them as the current parent status.",
        "- If the live parent events do not contain a newer result, say that directly and name the latest visible parent event/status.",
        "- Do not claim to run tools, change files, or steer the parent task from this side chat.",
      ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildSideChatTurnAgentConfigOverride(
    task: Task,
    message: string,
  ): AgentConfig | undefined {
    const sideChatTurnContext = this.buildSideChatParentStatusContext(task, message);
    return sideChatTurnContext ? { sideChatTurnContext } : undefined;
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
    autoStart?: boolean;
  }): Promise<Task> {
    const { task, derived } = this.createTaskRecord(params);
    this.logTaskIntentRouted(task.id, derived);

    if (params.autoStart !== false) {
      await this.startTask(task);
    }

    return task;
  }

  private createTaskRecord(params: {
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig?: AgentConfig;
    budgetTokens?: number;
    budgetCost?: number;
    source?: Task["source"];
    taskOverrides?: Partial<Task>;
  }) {
    const botTeamAgentConfig = this.attachDefaultBotTeam(
      params.workspaceId,
      params.taskOverrides?.assignedAgentRoleId,
      params.agentConfig,
    );
    const taskAgentConfig = applyDefaultAccessProfile(
      botTeamAgentConfig,
      PermissionSettingsManager.loadSettings(),
    );
    const derived = this.deriveTaskStrategy({
      title: params.title,
      prompt: params.prompt,
      routingPrompt: params.prompt,
      agentConfig: taskAgentConfig,
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
      ...safeTaskOverrides,
    });
    const memoryFeatures = MemoryFeaturesManager.loadSettings();
    const rootLineageUpdates: Partial<Task> = {
      sessionId:
        typeof safeTaskOverrides?.sessionId === "string" &&
        safeTaskOverrides.sessionId.trim().length > 0
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
    try {
      this.workSessionProtocolService.ensureForTask(task);
      this.workSessionContractService.ensureForTask(task);
    } catch (error) {
      // The canonical protocol is an additive projection during rollout. A
      // migration/foreign-key issue must not prevent the compatibility task
      // record from being created.
      log.warn(`[work-session-protocol] Failed to initialize task ${task.id}:`, error);
    }
    return { task, derived };
  }

  /**
   * Give persistent bot conversations an explicit team identity. This is
   * intentionally best-effort so ordinary task creation and lightweight test
   * daemons continue to work when the team tables are unavailable.
   */
  private attachDefaultBotTeam(
    workspaceId: string,
    assignedAgentRoleId: string | undefined,
    agentConfig: AgentConfig | undefined,
  ): AgentConfig | undefined {
    const normalizedAgentConfig = normalizeBotConversationAgentConfig(agentConfig);
    if (
      !normalizedAgentConfig?.botConversation ||
      normalizedAgentConfig.botTeamId ||
      !assignedAgentRoleId ||
      !workspaceId
    ) {
      return normalizedAgentConfig;
    }
    try {
      const seeded = ensureDefaultBotTeam(this.dbManager.getDatabase(), workspaceId);
      if (!seeded || !seeded.roles.some((role) => role.id === assignedAgentRoleId)) {
        return normalizedAgentConfig;
      }
      return this.prepareBotTeamAgentConfig(normalizedAgentConfig, seeded.team.id);
    } catch (error) {
      log.warn("Unable to attach the default bot team to a conversation:", error);
      return normalizedAgentConfig;
    }
  }

  /** Keep team channels conversational while allowing task turns to use tools. */
  private prepareBotTeamAgentConfig(agentConfig: AgentConfig, teamId: string): AgentConfig {
    return (
      normalizeBotConversationAgentConfig({ ...agentConfig, botTeamId: teamId }) || {
        ...agentConfig,
        botTeamId: teamId,
      }
    );
  }

  private logTaskIntentRouted(
    taskId: string,
    derived: ReturnType<AgentDaemon["deriveTaskStrategy"]>,
  ): void {
    this.logEvent(taskId, "log", {
      message:
        `Intent routed: ${derived.route.intent} | domain=${derived.route.domain} | ` +
        `convoMode=${derived.strategy.conversationMode} | execMode=${derived.strategy.executionMode}`,
      confidence: Number(derived.route.confidence.toFixed(2)),
      signals: derived.route.signals,
    });
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

  private getBotTeamContext(task: Task):
    | {
        team: ReturnType<AgentTeamRepository["findById"]>;
        roleIds: Set<string>;
      }
    | undefined {
    const botTeamId = task.agentConfig?.botTeamId;
    if (
      task.agentConfig?.botConversation !== true ||
      typeof botTeamId !== "string" ||
      !botTeamId.trim() ||
      !task.assignedAgentRoleId
    ) {
      return undefined;
    }

    const team = new AgentTeamRepository(this.dbManager.getDatabase()).findById(botTeamId);
    if (!team || !team.isActive || !team.persistent || team.workspaceId !== task.workspaceId) {
      return undefined;
    }
    const members = new AgentTeamMemberRepository(this.dbManager.getDatabase()).listByTeam(team.id);
    const roleIds = new Set([team.leadAgentRoleId, ...members.map((member) => member.agentRoleId)]);
    if (!roleIds.has(task.assignedAgentRoleId)) return undefined;
    return { team, roleIds };
  }

  private ensureBotTaskTeam(task: Task): Task {
    if (task.agentConfig?.botConversation !== true || !task.assignedAgentRoleId) {
      return task;
    }
    try {
      const normalizedConfig = normalizeBotConversationAgentConfig(task.agentConfig);
      if (
        normalizedConfig &&
        JSON.stringify(normalizedConfig) !== JSON.stringify(task.agentConfig)
      ) {
        this.taskRepo.update(task.id, { agentConfig: normalizedConfig });
        task.agentConfig = normalizedConfig;
      }
      const db = this.dbManager.getDatabase();
      const existingTeamId = task.agentConfig.botTeamId;
      const existingTeam = existingTeamId
        ? new AgentTeamRepository(db).findById(existingTeamId)
        : undefined;
      // A non-empty team id is an authorization claim, not a hint that may be
      // silently repaired. Legacy conversations without a team id may attach
      // to the workspace's default team; an explicit stale, inactive, or
      // non-member team fails closed and remains unavailable until repaired by
      // an explicit product action. The one migration exception is the
      // reserved default team crossing between temporary UI workspaces: the
      // Bots pane can adopt a durable conversation into the current temporary
      // workspace, so its built-in team must follow that adoption as well.
      if (existingTeamId && !existingTeam) return task;
      const canReconcileTemporaryDefaultTeam = Boolean(
        existingTeam &&
        existingTeam.name === DEFAULT_BOT_TEAM_NAME &&
        existingTeam.isActive &&
        existingTeam.persistent &&
        existingTeam.workspaceId !== task.workspaceId &&
        isTempWorkspaceId(existingTeam.workspaceId) &&
        isTempWorkspaceId(task.workspaceId),
      );
      if (
        existingTeam &&
        (existingTeam.workspaceId !== task.workspaceId ||
          !existingTeam.isActive ||
          !existingTeam.persistent) &&
        !canReconcileTemporaryDefaultTeam
      ) {
        return task;
      }
      // The built-in team is repairable: older conversations may point at a
      // valid default team whose newer roster members were never attached.
      // Re-seed that one reserved team on every access so named teammates such
      // as the Chief Community Officer cannot disappear from routing.
      const seeded =
        existingTeam?.name === DEFAULT_BOT_TEAM_NAME
          ? ensureDefaultBotTeam(db, task.workspaceId)
          : existingTeam
            ? { team: existingTeam, roles: ensureDefaultBotRoles(db) }
            : ensureDefaultBotTeam(db, task.workspaceId);
      if (
        !seeded ||
        !seeded.team.isActive ||
        !seeded.team.persistent ||
        seeded.team.workspaceId !== task.workspaceId ||
        !seeded.roles.some((role) => role.id === task.assignedAgentRoleId)
      ) {
        return task;
      }
      const agentConfig = this.prepareBotTeamAgentConfig(task.agentConfig, seeded.team.id);
      if (JSON.stringify(agentConfig) !== JSON.stringify(task.agentConfig)) {
        this.taskRepo.update(task.id, { agentConfig });
        task.agentConfig = agentConfig;
        if (canReconcileTemporaryDefaultTeam) {
          this.logEvent(task.id, "log", {
            message: "Reconciled the built-in bot team with the current temporary workspace.",
            previousBotTeamId: existingTeam?.id,
            previousWorkspaceId: existingTeam?.workspaceId,
            botTeamId: seeded.team.id,
            workspaceId: task.workspaceId,
          });
        }
      }
      return task;
    } catch (error) {
      log.warn("Unable to attach the default bot team to an existing conversation:", error);
      return task;
    }
  }

  /**
   * Return true only when the task is an active member of a persistent team.
   * Tool policy uses this daemon-derived value instead of trusting task JSON
   * markers supplied by a renderer or an old database snapshot.
   */
  isBotConversationMessagingAuthorized(taskId: string): boolean {
    return this.getBotConversationMessagingContext(taskId).authorized;
  }

  /**
   * Return the verified bot-team identity and authorization together. The
   * executor may hold an older task object while the daemon repairs a legacy
   * conversation, so callers must use the same normalized snapshot for both
   * the team id and the authorization decision.
   */
  getBotConversationMessagingContext(taskId: string): {
    authorized: boolean;
    botTeamId?: string;
  } {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.agentConfig?.botConversation !== true) {
      return { authorized: false };
    }
    const normalized = this.ensureBotTaskTeam(task);
    const context = this.getBotTeamContext(normalized);
    return context?.team?.id
      ? { authorized: true, botTeamId: context.team.id }
      : { authorized: false };
  }

  private getVerifiedBotTeamContext(task: Task): ReturnType<AgentDaemon["getBotTeamContext"]> {
    if (task.agentConfig?.botConversation !== true) return undefined;
    const normalized = this.ensureBotTaskTeam(task);
    return this.getBotTeamContext(normalized);
  }

  private getBotTeamDiagnostic(task: Task): {
    availability:
      | "available"
      | "conversation_unavailable"
      | "team_unavailable"
      | "membership_revoked";
    message: string;
    team?: ReturnType<AgentTeamRepository["findById"]>;
    roleIds: Set<string>;
  } {
    if (task.agentConfig?.botConversation !== true || !task.assignedAgentRoleId) {
      return {
        availability: "conversation_unavailable",
        message: "This conversation is not attached to an active bot role.",
        roleIds: new Set(),
      };
    }
    const teamId = task.agentConfig?.botTeamId;
    if (typeof teamId !== "string" || !teamId.trim()) {
      return {
        availability: "team_unavailable",
        message: "This bot conversation is not attached to a persistent bot team.",
        roleIds: new Set(),
      };
    }
    const teamRepo = new AgentTeamRepository(this.dbManager.getDatabase());
    const team = teamRepo.findById(teamId);
    if (!team || team.workspaceId !== task.workspaceId || !team.isActive || !team.persistent) {
      return {
        availability: "team_unavailable",
        message: "The bot team is unavailable in the current workspace.",
        roleIds: new Set(),
      };
    }
    const members = new AgentTeamMemberRepository(this.dbManager.getDatabase()).listByTeam(team.id);
    const roleIds = new Set([team.leadAgentRoleId, ...members.map((member) => member.agentRoleId)]);
    if (!roleIds.has(task.assignedAgentRoleId)) {
      return {
        availability: "membership_revoked",
        message: "This bot role is no longer a member of the persistent bot team.",
        team,
        roleIds,
      };
    }
    return { availability: "available", message: "Bot teammate is available.", team, roleIds };
  }

  private canDeliverBotMessageBetween(sender: Task, target: Task): boolean {
    const senderContext = this.getVerifiedBotTeamContext(sender);
    const targetContext = this.getVerifiedBotTeamContext(target);
    if (!senderContext?.team || !targetContext?.team) return false;
    return (
      senderContext.team.id === targetContext.team.id && sender.workspaceId === target.workspaceId
    );
  }

  private recoverQueuedBotMessagesOnStartup(): void {
    let conversations: Task[] = [];
    try {
      conversations = this.taskRepo.findBotConversations("", {
        includeAllWorkspaces: true,
        includeArchivedSessions: false,
        limit: 500,
        offset: 0,
      });
    } catch (error) {
      log.warn("Unable to scan bot conversations for queued handoff recovery:", error);
      return;
    }

    for (const task of conversations) {
      const latestByMessageId = new Map<string, TaskEvent>();
      for (const event of readDurableTaskEvents(this, task.id, "user_message")) {
        const payload = (event.payload || {}) as Record<string, unknown>;
        // Only agent-authored bot receipts are restart-recoverable. A renderer
        // can use the generic queue mode for child-task steering, but that is
        // a user follow-up and must never be replayed as a teammate handoff.
        if (payload.deliveryMode !== "message" || payload.messageSource !== "agent") continue;
        const messageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
        if (!messageId) continue;
        latestByMessageId.set(messageId, event);
      }

      for (const event of latestByMessageId.values()) {
        const payload = (event.payload || {}) as Record<string, unknown>;
        const deliveryStatus =
          payload.deliveryStatus === "delivered" || payload.status === "delivered"
            ? "delivered"
            : payload.deliveryStatus === "quarantined" || payload.status === "quarantined"
              ? "quarantined"
              : payload.deliveryStatus === "failed" || payload.status === "failed"
                ? "failed"
                : payload.deliveryStatus === "started" || payload.status === "started"
                  ? "started"
                  : "queued";
        // A started receipt may be left behind if the process exits between
        // runtime consumption and the final acknowledgement. Reconstruct that
        // exact message; delivered and quarantined are terminal.
        if (deliveryStatus !== "queued" && deliveryStatus !== "started") continue;

        const messageId = String(payload.messageId || "").trim();
        const message = typeof payload.message === "string" ? payload.message.trim() : "";
        const senderTaskId =
          typeof payload.senderTaskId === "string" ? payload.senderTaskId.trim() : "";
        if (!messageId || !message || !senderTaskId) continue;

        const sender = this.taskRepo.findById(senderTaskId);
        if (!sender || !this.canDeliverBotMessageBetween(sender, task)) {
          const error =
            "Bot teammate message was quarantined because the sender and recipient are no longer active members of the same persistent team.";
          this.markQueuedAgentMessageFailed(task.id, messageId, error, {
            quarantined: true,
            failureCode: "BOT_MESSAGE_TEAM_AUTHORIZATION_REVOKED",
          });
          this.logEvent(task.id, "error", {
            message: error,
            code: "BOT_MESSAGE_TEAM_AUTHORIZATION_REVOKED",
            messageId,
            senderTaskId,
            deliveryStatus: "quarantined",
            recovery: true,
          });
          continue;
        }

        try {
          const result = this.queueMessageOnly(
            task,
            message,
            undefined,
            payload.quotedAssistantMessage as QuotedAssistantMessage | undefined,
            {
              deliveryMode: "message",
              messageId,
              messageSource: "agent",
              senderTaskId,
              senderLabel:
                typeof payload.senderLabel === "string" ? payload.senderLabel : undefined,
              inReplyToMessageId:
                typeof payload.inReplyToMessageId === "string"
                  ? payload.inReplyToMessageId
                  : undefined,
              inReplyToTaskId:
                typeof payload.inReplyToTaskId === "string" ? payload.inReplyToTaskId : undefined,
              interactionMode: payload.interactionMode as TaskFollowUpInput["interactionMode"],
              integrationMentions: Array.isArray(payload.integrationMentions)
                ? (payload.integrationMentions as TaskFollowUpInput["integrationMentions"])
                : undefined,
              startAfterAccepted: true,
            },
          );
          this.logEvent(task.id, "log", {
            metric: "bot_message_recovered_after_restart",
            messageId,
            deliveryStatus: result.deliveryStatus || "queued",
            senderTaskId: payload.senderTaskId,
          });
        } catch (error) {
          // Keep the durable queued receipt intact. A later explicit retry or
          // another startup can still reconstruct it without losing content.
          this.logEvent(task.id, "error", {
            message: "Queued bot handoff recovery failed",
            error: String(error),
            messageId,
            deliveryStatus: "queued",
            recovery: true,
          });
        }
      }
    }
  }

  /**
   * Return the latest conversation that can accept a teammate message.
   * Failed/blocked/cancelled bot runs can retain stale queue state; starting
   * a clean conversation for that role is safer than injecting into a broken
   * transcript and leaving the lead waiting forever.
   */
  private findReusableBotConversation(workspaceId: string, agentRoleId: string): Task | undefined {
    const candidates = this.taskRepo.findBotConversations(workspaceId, {
      agentRoleId,
      includeArchivedSessions: false,
      // A failed newest transcript must not hide an older healthy persistent
      // conversation. Keep the scan bounded while covering normal history.
      limit: 50,
    });
    const reusableStatuses = new Set<TaskStatus>([
      "pending",
      "queued",
      "planning",
      "executing",
      "completed",
    ]);
    return candidates.find((candidate) => reusableStatuses.has(candidate.status));
  }

  /** List the persistent bot peers visible to a bot conversation. */
  async listBotTeamPeers(taskId: string): Promise<
    Array<{
      taskId?: string;
      roleId: string;
      name: string;
      displayName: string;
      description?: string;
      status?: TaskStatus;
      available: boolean;
      availability:
        | "available"
        | "conversation_unavailable"
        | "team_unavailable"
        | "membership_revoked";
      reason?: string;
      recoveryAction?: "reopen" | "repair_membership";
    }>
  > {
    const existingSender = this.taskRepo.findById(taskId);
    if (!existingSender) return [];
    const sender = this.ensureBotTaskTeam(existingSender);
    const diagnostic = this.getBotTeamDiagnostic(sender);
    const roleRepo = new AgentRoleRepository(this.dbManager.getDatabase());
    const roles = diagnostic.roleIds.size
      ? Array.from(diagnostic.roleIds)
          .map((roleId) => roleRepo.findById(roleId))
          .filter((role): role is AgentRole => Boolean(role))
      : ensureDefaultBotRoles(this.dbManager.getDatabase());
    return roles.map((role) => {
      const conversation = this.findReusableBotConversation(sender.workspaceId, role.id);
      const isSelf = role.id === sender.assignedAgentRoleId;
      const roleAvailable = diagnostic.availability === "available" && !isSelf;
      const availability = roleAvailable
        ? conversation
          ? "available"
          : "conversation_unavailable"
        : isSelf
          ? "conversation_unavailable"
          : diagnostic.availability;
      return {
        taskId: conversation?.id,
        roleId: role.id,
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        status: conversation?.status,
        available: availability === "available",
        availability,
        ...(availability !== "available"
          ? {
              reason: isSelf
                ? "A bot cannot message itself."
                : diagnostic.availability === "available"
                  ? "No reusable conversation is available yet."
                  : diagnostic.message,
            }
          : {}),
        ...(availability === "conversation_unavailable" || availability === "team_unavailable"
          ? { recoveryAction: "reopen" as const }
          : availability === "membership_revoked"
            ? { recoveryAction: "repair_membership" as const }
            : {}),
      };
    });
  }

  /**
   * Reopen a bot conversation without mutating or borrowing its old
   * transcript. An explicit repair may restore a revoked role membership;
   * ordinary reopen keeps authorization fail-closed.
   */
  async reopenBotConversation(params: {
    workspaceId: string;
    taskId?: string;
    agentRoleId?: string;
    repairMembership?: boolean;
  }): Promise<Task> {
    const workspaceId = String(params.workspaceId || "").trim();
    if (!workspaceId) throw new Error("BOT_WORKSPACE_REQUIRED: workspaceId is required");
    const oldTask = params.taskId ? this.taskRepo.findById(params.taskId) : undefined;
    if (params.taskId && !oldTask) {
      throw new Error("BOT_CONVERSATION_UNAVAILABLE: The bot conversation no longer exists.");
    }
    const roleId = params.agentRoleId?.trim() || oldTask?.assignedAgentRoleId?.trim() || "";
    const role = roleId
      ? new AgentRoleRepository(this.dbManager.getDatabase()).findById(roleId)
      : undefined;
    if (!role) {
      throw new Error("BOT_NOT_FOUND: The bot role is no longer available.");
    }

    const db = this.dbManager.getDatabase();
    const teamRepo = new AgentTeamRepository(db);
    const memberRepo = new AgentTeamMemberRepository(db);
    const oldTeamId = oldTask?.agentConfig?.botTeamId;
    const oldTeam = typeof oldTeamId === "string" ? teamRepo.findById(oldTeamId) : undefined;
    // A temporary UI workspace may continue a transcript from the reserved
    // built-in team as a new branch. Never reassign the source task or borrow
    // its team authorization from another workspace.
    const canBranchBuiltInTeamToTemporaryWorkspace = Boolean(
      oldTeam &&
      oldTeam.name === DEFAULT_BOT_TEAM_NAME &&
      oldTeam.isActive &&
      oldTeam.persistent &&
      oldTeam.workspaceId !== workspaceId &&
      isTempWorkspaceId(workspaceId),
    );
    if (
      oldTask &&
      oldTask.workspaceId !== workspaceId &&
      !canBranchBuiltInTeamToTemporaryWorkspace
    ) {
      throw new Error(
        "BOT_WORKSPACE_CONFLICT: The old bot conversation belongs to another workspace.",
      );
    }
    let team =
      oldTeam && oldTeam.workspaceId === workspaceId && oldTeam.isActive && oldTeam.persistent
        ? oldTeam
        : undefined;
    if (!team) {
      if (oldTeamId && !params.repairMembership && !canBranchBuiltInTeamToTemporaryWorkspace) {
        throw new Error(
          "BOT_TEAM_UNAVAILABLE: The old bot team is unavailable; repair the team before reopening.",
        );
      }
      const seeded = ensureDefaultBotTeam(db, workspaceId);
      team = seeded?.team;
    }
    if (!team) throw new Error("BOT_TEAM_UNAVAILABLE: No persistent bot team is available.");

    const roleIds = new Set([
      team.leadAgentRoleId,
      ...memberRepo.listByTeam(team.id).map((member) => member.agentRoleId),
    ]);
    if (!roleIds.has(role.id)) {
      if (!params.repairMembership) {
        throw new Error(
          "BOT_MEMBERSHIP_REVOKED: This role is no longer a member of the bot team; repair membership to continue.",
        );
      }
      memberRepo.add({
        teamId: team.id,
        agentRoleId: role.id,
        memberOrder: 900,
        isRequired: false,
      });
    }

    const reopened = await this.createTask({
      title: role.displayName,
      prompt: `Resume the ${role.displayName} bot conversation.`,
      workspaceId,
      agentConfig: {
        botConversation: true,
        botTeamId: team.id,
        conversationMode: "hybrid",
        executionMode: "execute",
        executionModeSource: "strategy",
      },
      taskOverrides: {
        assignedAgentRoleId: role.id,
        ...(oldTask
          ? {
              branchFromTaskId: oldTask.id,
              branchLabel: params.repairMembership
                ? "Repaired bot conversation"
                : "Reopened bot conversation",
            }
          : {}),
      },
      autoStart: false,
    });
    this.logEvent(reopened.id, "task_created", {
      recoveryAction: params.repairMembership ? "repair_membership" : "reopen",
      reopenedFromTaskId: oldTask?.id,
      botRoleId: role.id,
      botTeamId: team.id,
    });
    return reopened;
  }

  /**
   * Resolve a bot handle or task ID to a verified teammate conversation. The
   * caller must already be a bot conversation in the same persistent team.
   */
  async resolveBotTeamPeer(
    senderTaskId: string,
    recipient: { taskId?: string; botName?: string },
  ): Promise<
    | { ok: true; task: Task; role: AgentRole }
    | {
        ok: false;
        error:
          | "BOT_TEAM_UNAVAILABLE"
          | "BOT_NOT_FOUND"
          | "BOT_MEMBERSHIP_REVOKED"
          | "BOT_CONVERSATION_UNAVAILABLE"
          | "BOT_RUNTIME_UNAVAILABLE"
          | "FORBIDDEN";
        message: string;
      }
  > {
    const existingSender = this.taskRepo.findById(senderTaskId);
    if (!existingSender) {
      return { ok: false, error: "BOT_TEAM_UNAVAILABLE", message: "Sender task not found" };
    }
    const sender = this.ensureBotTaskTeam(existingSender);
    const context = this.getBotTeamContext(sender);
    if (!context) {
      const diagnostic = this.getBotTeamDiagnostic(sender);
      return {
        ok: false,
        error:
          diagnostic.availability === "conversation_unavailable"
            ? "BOT_CONVERSATION_UNAVAILABLE"
            : diagnostic.availability === "membership_revoked"
              ? "BOT_MEMBERSHIP_REVOKED"
              : "BOT_TEAM_UNAVAILABLE",
        message: diagnostic.message,
      };
    }

    const roleRepo = new AgentRoleRepository(this.dbManager.getDatabase());
    let role: AgentRole | undefined;
    let target: Task | undefined;
    if (recipient.taskId) {
      target = this.taskRepo.findById(recipient.taskId);
      if (!target) {
        return {
          ok: false,
          error: "BOT_CONVERSATION_UNAVAILABLE",
          message: "The target bot conversation no longer exists.",
        };
      }
      role = target?.assignedAgentRoleId
        ? roleRepo.findById(target.assignedAgentRoleId)
        : undefined;
      if (target && (!role || target.agentConfig?.botConversation !== true)) {
        return {
          ok: false,
          error: "BOT_CONVERSATION_UNAVAILABLE",
          message: "The target is not an active bot conversation.",
        };
      }
    } else {
      const normalized = String(recipient.botName || "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();
      if (!normalized) {
        return { ok: false, error: "BOT_NOT_FOUND", message: "bot is required" };
      }
      const matchesHandle = (candidate: AgentRole): boolean => {
        const handle = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const shortHandle = candidate.name.toLowerCase().split(/[^a-z0-9]+/)[0] || "";
        const displayShortHandle = candidate.displayName.toLowerCase().trim().split(/\s+/)[0] || "";
        return (
          handle === normalized ||
          shortHandle === normalized ||
          candidate.name.toLowerCase() === normalized ||
          candidate.displayName.toLowerCase() === normalized ||
          candidate.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-") === normalized ||
          displayShortHandle === normalized
        );
      };
      // Resolve against the stable role registry first so a known role that
      // was removed from the team can produce a truthful membership error
      // instead of looking like a misspelled bot.
      role = roleRepo.findAll(true).find(matchesHandle);
      if (role) {
        target = this.findReusableBotConversation(sender.workspaceId, role.id);
      }
    }

    if (!role || role.id === sender.assignedAgentRoleId) {
      return {
        ok: false,
        error: recipient.taskId ? "FORBIDDEN" : "BOT_NOT_FOUND",
        message: recipient.taskId
          ? "The target is not a teammate in the current bot team"
          : `No teammate named ${String(recipient.botName || "bot")}`,
      };
    }

    if (!context.roleIds.has(role.id)) {
      return {
        ok: false,
        error: "BOT_MEMBERSHIP_REVOKED",
        message: "That bot role is not an active member of the current persistent team.",
      };
    }

    if (target) {
      if (!this.canDeliverBotMessageBetween(sender, target)) {
        const targetDiagnostic = this.getBotTeamDiagnostic(target);
        return {
          ok: false,
          error:
            targetDiagnostic.availability === "membership_revoked"
              ? "BOT_MEMBERSHIP_REVOKED"
              : targetDiagnostic.availability === "conversation_unavailable"
                ? "BOT_CONVERSATION_UNAVAILABLE"
                : "BOT_TEAM_UNAVAILABLE",
          message: targetDiagnostic.message,
        };
      }
      // canDeliverBotMessageBetween() intentionally validates the existing
      // target team. Never overwrite a target's team id as an authorization
      // repair; that could move a stale or foreign conversation into the
      // sender's team merely because it shares a workspace.
      return { ok: true, task: target, role };
    }

    const created = await this.createTask({
      title: role.displayName,
      prompt: `Start chatting with ${role.displayName}.`,
      workspaceId: sender.workspaceId,
      agentConfig: {
        botConversation: true,
        botTeamId: context.team?.id,
        conversationMode: "hybrid",
        executionMode: "execute",
        executionModeSource: "strategy",
      },
      taskOverrides: { assignedAgentRoleId: role.id },
      autoStart: false,
    });
    return { ok: true, task: created, role };
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
    edges?: Array<{
      fromNodeId?: string;
      fromNodeKey?: string;
      toNodeId?: string;
      toNodeKey?: string;
    }>;
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
    teamRunId?: string;
    teamItemId?: string;
    boardColumn?: BoardColumn;
    priority?: number;
    budgetTokens?: number;
    budgetCost?: number;
  }): Promise<Task> {
    const parent = this.taskRepo.findById(params.parentTaskId);
    const requestedWorkerRole = resolveWorkerRoleKind(params.workerRole);
    const workerRole = requestedWorkerRole || resolveDefaultWorkerRoleKind();
    const isVerifierChild = workerRole === "verifier";
    const isReadOnlyExecutionChild =
      isVerifierChild ||
      params.agentConfig?.readOnlyExecution === true ||
      parent?.agentConfig?.readOnlyExecution === true ||
      parent?.workerRole === "verifier";
    const parentGatewayContext = parent?.agentConfig?.gatewayContext;
    const childGatewayContext = params.agentConfig?.gatewayContext;
    const parentAutonomousMode = parent?.agentConfig?.autonomousMode === true;
    const mergedAutonomousMode =
      parentAutonomousMode || params.agentConfig?.autonomousMode === true;
    const mergedAllowUserInput = mergedAutonomousMode
      ? false
      : (params.agentConfig?.allowUserInput ?? parent?.agentConfig?.allowUserInput);
    // Verifiers and internal read-only helpers are a trust boundary. A parent
    // may intentionally bypass approvals for its own work, but that privilege
    // must not flow into a child that is supposed to inspect the result only.
    const mergedPermissionMode = isReadOnlyExecutionChild
      ? "plan"
      : parent?.agentConfig?.permissionMode === "bypass_permissions"
        ? "bypass_permissions"
        : (params.agentConfig?.permissionMode ?? parent?.agentConfig?.permissionMode);
    const mergedShellAccess = isReadOnlyExecutionChild
      ? false
      : parent?.agentConfig?.shellAccess === true
        ? true
        : params.agentConfig?.shellAccess;

    const parentAccessProfileId =
      typeof parent?.agentConfig?.accessProfileId === "string"
        ? parent.agentConfig.accessProfileId
        : undefined;
    const accessProfileInheritance = (() => {
      if (!parent) {
        return {
          accessProfileId: undefined,
          fallbackPermissionMode: undefined,
          stripRequestedProfile: false,
        };
      }

      // An explicitly selected parent profile is a ceiling for every child.
      // A child may choose a strictly narrower profile when the workspace and
      // profile settings are available; otherwise inherit the parent's exact
      // profile so a lightweight daemon cannot accidentally widen access.
      if (parentAccessProfileId) {
        // The built-in full-access profile is unscoped. Drop it for a verifier
        // and use plan mode so the named profile cannot override the role's
        // read-only shell and approval settings.
        if (
          isReadOnlyExecutionChild &&
          parentAccessProfileId === BUILTIN_ACCESS_PROFILE_IDS.fullAccess
        ) {
          return {
            accessProfileId: undefined,
            fallbackPermissionMode: "plan" as PermissionMode,
            stripRequestedProfile: true,
          };
        }
        const childAccessProfileId = params.agentConfig?.accessProfileId;
        const workspace = this.workspaceRepo?.findById(parent.workspaceId || params.workspaceId);
        if (
          workspace &&
          typeof childAccessProfileId === "string" &&
          childAccessProfileId.trim().length > 0
        ) {
          const settings = PermissionSettingsManager.loadSettings();
          const adminPolicies = loadPolicies();
          const parentProfile = resolveEffectiveAccessProfile({
            task: parent,
            workspace,
            settings,
            adminPolicies,
          });
          const childProfile = resolveEffectiveAccessProfile({
            task: { agentConfig: params.agentConfig },
            workspace,
            settings,
            adminPolicies,
          });
          if (isAccessProfileAtMostPrivileged(childProfile.definition, parentProfile.definition)) {
            return {
              accessProfileId: undefined,
              fallbackPermissionMode: undefined,
              stripRequestedProfile: false,
            };
          }
          return {
            accessProfileId: undefined,
            fallbackPermissionMode: parentProfile.permissionMode,
            stripRequestedProfile: true,
          };
        }
        return {
          accessProfileId: parentAccessProfileId,
          fallbackPermissionMode: undefined,
          stripRequestedProfile: false,
        };
      }

      const childAccessProfileId = params.agentConfig?.accessProfileId;
      const workspace = this.workspaceRepo?.findById(parent.workspaceId || params.workspaceId);
      const settings = PermissionSettingsManager.loadSettings();
      const adminPolicies = loadPolicies();
      const parentProfile = resolveEffectiveAccessProfile({
        task: parent,
        workspace,
        settings,
        adminPolicies,
      });

      const childProfile = resolveEffectiveAccessProfile({
        // Include the already-merged legacy mode when comparing a child that
        // does not select a named profile. Otherwise a child could request
        // bypass_permissions while the parent only had a legacy/default mode,
        // or inherit a broad settings default that the parent had overridden.
        task: {
          agentConfig: {
            ...(params.agentConfig || {}),
            ...(mergedPermissionMode ? { permissionMode: mergedPermissionMode } : {}),
          },
        },
        workspace,
        settings,
        adminPolicies,
      });
      const hasChildAccessProfile =
        typeof childAccessProfileId === "string" && childAccessProfileId.trim().length > 0;
      const parentHasScopedRules = hasAccessProfileScope(parentProfile.definition);
      const childHasScopedRules = hasAccessProfileScope(childProfile.definition);
      const childKeepsScopedRules =
        !hasChildAccessProfile ||
        !childHasScopedRules ||
        (parentHasScopedRules && childProfile.definition.id === parentProfile.definition.id);
      const isWithinCeiling =
        isAccessProfileAtMostPrivileged(childProfile.definition, parentProfile.definition) &&
        childKeepsScopedRules;

      if (isWithinCeiling) {
        return {
          accessProfileId: undefined,
          fallbackPermissionMode: undefined,
          stripRequestedProfile: false,
        };
      }

      // A legacy permission-mode override is still an access escalation even
      // when the child did not select a named access profile. Strip it and
      // carry the parent's effective mode forward.
      return {
        accessProfileId: undefined,
        fallbackPermissionMode: parentProfile.permissionMode,
        stripRequestedProfile: true,
      };
    })();

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
      if (mergedPermissionMode !== undefined) {
        next.permissionMode = mergedPermissionMode;
      }
      if (mergedShellAccess !== undefined) {
        next.shellAccess = mergedShellAccess;
      }
      if (isReadOnlyExecutionChild) {
        next.readOnlyExecution = true;
        // External runtimes execute outside CoWork's policy-wrapped tool
        // registry and cannot honor this child-helper boundary.
        delete next.externalRuntime;
      }
      if (accessProfileInheritance.accessProfileId) {
        next.accessProfileId = accessProfileInheritance.accessProfileId;
      } else if (accessProfileInheritance.stripRequestedProfile) {
        delete next.accessProfileId;
        if (accessProfileInheritance.fallbackPermissionMode) {
          next.permissionMode = accessProfileInheritance.fallbackPermissionMode;
        }
      }
      // ACP has its own execution and consent boundary. A native CoWork
      // profile must not silently promote the adapter to approve-all.
      return Object.keys(next).length > 0 ? next : undefined;
    })();

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

    try {
      if (parent) {
        this.workSessionContractService.ensureChildSession(parent, task);
      } else {
        this.workSessionProtocolService.ensureForTask(task);
        this.workSessionContractService.ensureForTask(task);
      }
    } catch (error) {
      log.warn(`[work-session-protocol] Failed to initialize child task ${task.id}:`, error);
    }

    if (!params.teamRunId && !params.teamItemId) {
      this.ensureCollaborativeRunForParentTask(params.parentTaskId);
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

  ensureCollaborativeRunForParentTask(parentTaskId: string): AgentTeamRun | null {
    const parentTask = this.taskRepo.findById(parentTaskId);
    if (!parentTask) return null;

    const childTasks = this.taskRepo.findByParent(parentTaskId);
    if (childTasks.length < 2) {
      const db = this.dbManager.getDatabase();
      return new AgentTeamRunRepository(db).findByRootTaskId(parentTaskId) || null;
    }

    const db = this.dbManager.getDatabase();
    const teamRepo = new AgentTeamRepository(db);
    const teamMemberRepo = new AgentTeamMemberRepository(db);
    const teamRunRepo = new AgentTeamRunRepository(db);
    const teamItemRepo = new AgentTeamItemRepository(db);
    const existingRun = teamRunRepo.findByRootTaskId(parentTaskId);

    if (existingRun) {
      if (parentTask.agentConfig?.childAgentCollaborativeRun === true) {
        this.ensureChildTasksHaveTeamItems(existingRun, childTasks, teamMemberRepo, teamItemRepo);
        if (this.childTasksHaveActiveWork(childTasks) && existingRun.status !== "running") {
          const updatedRun = teamRunRepo.update(existingRun.id, {
            status: "running",
            completedAt: null,
            phase: "dispatch",
            error: null,
          });
          if (updatedRun) {
            this.emitTeamRunEvent({
              type: "team_run_updated",
              timestamp: Date.now(),
              run: updatedRun,
              reason: "child_agent_spawned",
            });
            return updatedRun;
          }
        }
      }
      return existingRun;
    }

    const activeRoles = this.agentRoleRepo.findAll(false).filter((role) => role.isActive);
    const activeRoleIds = new Set(activeRoles.map((role) => role.id));
    const assignedLeadRoleId =
      childTasks.find(
        (task) => task.assignedAgentRoleId && activeRoleIds.has(task.assignedAgentRoleId),
      )?.assignedAgentRoleId || activeRoles[0]?.id;
    if (!assignedLeadRoleId) {
      log.warn(
        `Cannot create collaborative child-agent run for ${parentTaskId}: no active agent roles`,
      );
      return null;
    }

    const nextAgentConfig: AgentConfig = {
      ...(parentTask.agentConfig || {}),
      collaborativeMode: true,
      childAgentCollaborativeRun: true,
    };
    this.taskRepo.update(parentTask.id, { agentConfig: nextAgentConfig });
    parentTask.agentConfig = nextAgentConfig;

    const team = teamRepo.create({
      workspaceId: parentTask.workspaceId,
      name: `ChildAgents-${parentTask.id.slice(0, 8)}-${Date.now()}`,
      description: `Spawned child agents for: ${parentTask.title}`,
      leadAgentRoleId: assignedLeadRoleId,
      maxParallelAgents: Math.max(2, childTasks.length),
    });

    const run = teamRunRepo.create({
      teamId: team.id,
      rootTaskId: parentTask.id,
      status: this.childTasksHaveActiveWork(childTasks) ? "running" : "completed",
      collaborativeMode: true,
    });
    this.ensureChildTasksHaveTeamItems(run, childTasks, teamMemberRepo, teamItemRepo);

    if (!this.childTasksHaveActiveWork(childTasks)) {
      const completedRun = teamRunRepo.update(run.id, {
        status: childTasks.some((task) => task.status === "failed") ? "failed" : "completed",
        phase: "complete",
        summary: this.buildChildAgentRunSummary(childTasks),
      });
      if (completedRun) {
        this.emitTeamRunEvent({
          type: "team_run_created",
          timestamp: Date.now(),
          run: completedRun,
        });
        return completedRun;
      }
    }

    this.emitTeamRunEvent({ type: "team_run_created", timestamp: Date.now(), run });
    return run;
  }

  private ensureChildTasksHaveTeamItems(
    run: AgentTeamRun,
    childTasks: Task[],
    teamMemberRepo: AgentTeamMemberRepository,
    teamItemRepo: AgentTeamItemRepository,
  ): AgentTeamItem[] {
    const existingItems = teamItemRepo.listByRun(run.id);
    const existingSourceTaskIds = new Set(
      existingItems
        .map((item) => item.sourceTaskId)
        .filter((sourceTaskId): sourceTaskId is string => Boolean(sourceTaskId)),
    );
    const items = [...existingItems];

    for (let i = 0; i < childTasks.length; i += 1) {
      const childTask = childTasks[i];
      const assignedRole = childTask.assignedAgentRoleId
        ? this.agentRoleRepo.findById(childTask.assignedAgentRoleId)
        : undefined;
      if (assignedRole) {
        teamMemberRepo.add({
          teamId: run.teamId,
          agentRoleId: assignedRole.id,
          memberOrder: (i + 1) * 10,
          isRequired: true,
        });
      }
      if (existingSourceTaskIds.has(childTask.id)) continue;

      const item = teamItemRepo.create({
        teamRunId: run.id,
        title: childTask.title,
        description: childTask.prompt,
        ownerAgentRoleId: assignedRole?.id,
        sourceTaskId: childTask.id,
        status: this.mapChildTaskStatusToTeamItemStatus(childTask.status),
        sortOrder: (i + 1) * 10,
      });
      items.push(item);
      this.emitTeamRunEvent({
        type: "team_item_spawned",
        timestamp: Date.now(),
        runId: run.id,
        item,
        spawnedTaskId: childTask.id,
      });
    }

    return items;
  }

  private mapChildTaskStatusToTeamItemStatus(status: TaskStatus): AgentTeamItemStatus {
    if (status === "completed") return "done";
    if (status === "failed") return "failed";
    if (status === "cancelled") return "blocked";
    if (status === "planning" || status === "executing" || status === "interrupted") {
      return "in_progress";
    }
    return "todo";
  }

  private childTasksHaveActiveWork(childTasks: Task[]): boolean {
    return childTasks.some((task) => !isTerminalTaskStatus(task.status));
  }

  private buildChildAgentRunSummary(childTasks: Task[]): string {
    const done = childTasks.filter((task) => task.status === "completed").length;
    const failed = childTasks.filter((task) => task.status === "failed").length;
    const blocked = childTasks.filter((task) => task.status === "cancelled").length;
    return `Items: ${done} done, ${failed} failed, ${blocked} blocked (total: ${childTasks.length})`;
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
      {
        workspaceId: task.workspaceId,
        taskId: task.id,
        sourceKind: "team-selection",
      },
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
    }

    if (task.agentConfig?.multitaskMode) {
      const requestedLaneCount =
        typeof task.agentConfig.multitaskLaneCount === "number"
          ? task.agentConfig.multitaskLaneCount
          : members.length;
      let lanes;
      try {
        const settings = LLMProviderFactory.loadSettings();
        const resolution =
          settings.jev && isJevActiveHarnessEnabled(settings.jev)
            ? createConfiguredJevProvider(settings)
            : null;
        const decisionService = resolution
          ? createDecisionService(resolution.provider, {
              model: resolution.model,
              providerType: resolution.providerType,
              telemetryContext: {
                workspaceId: task.workspaceId,
                taskId: task.id,
                sourceKind: "multitask-lane-planning",
              },
              timeoutMs: Math.min(settings.jev?.timeoutMs ?? 1_500, 1_500),
              maxRetries: 0,
              maxCalls: 1,
              maxConcurrent: 1,
              cache: { enabled: true, ttlMs: 5_000, maxEntries: 4 },
            })
          : undefined;
        lanes = await MultitaskLanePlanner.plan(fullText, {
          requestedLaneCount,
          ...(resolution
            ? {
                decisionProvider: resolution.provider,
                decisionModel: resolution.model,
                decisionService,
              }
            : {}),
        });
      } catch {
        lanes = await MultitaskLanePlanner.plan(fullText, { requestedLaneCount });
      }
      for (let i = 0; i < lanes.length; i++) {
        const owner = members[i % members.length];
        teamItemRepo.create({
          teamRunId: run.id,
          title: lanes[i].title,
          description: lanes[i].description,
          ownerAgentRoleId: owner?.id,
          status: "todo",
          sortOrder: (i + 1) * 10,
        });
      }
      this.emitTeamRunEvent({ type: "team_run_created", timestamp: Date.now(), run });
      void this.teamOrchestrator.tickRun(run.id, "daemon_programmatic_multitask");
      return true;
    }

    let subagentIndex = 0;
    for (let i = 0; i < members.length; i++) {
      if (members[i].displayName === "Synthesis") continue;
      teamItemRepo.create({
        teamRunId: run.id,
        title: buildSubagentDisplayName({
          role: members[i],
          workerRole: "researcher",
          index: subagentIndex,
        }),
        description: task.prompt,
        ownerAgentRoleId: members[i].id,
        status: "todo",
        sortOrder: (i + 1) * 10,
      });
      subagentIndex += 1;
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
    const task = this.getTaskWithTransientAgentConfig(this.taskRepo.findById(taskId));
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
      zone: `output/${role.displayName
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")}`,
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
    const interruptRequestedAt = Date.now();
    this.logEvent(taskId, "agent_interrupt_requested", {
      taskId,
      reason: "cancel",
      actor: "user",
      requestedAt: interruptRequestedAt,
    });

    // Check if task is queued (not yet started)
    if (this.queueManager.cancelQueuedTask(taskId)) {
      this.cancelTaskRecord(taskId, "Task removed from queue");
      this.logEvent(taskId, "agent_interrupt_confirmed", {
        taskId,
        reason: "cancel",
        actor: "user",
        requestedAt: interruptRequestedAt,
        confirmedAt: Date.now(),
        status: "cancelled",
      });
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
    this.logEvent(taskId, "agent_interrupt_confirmed", {
      taskId,
      reason: "cancel",
      actor: "user",
      requestedAt: interruptRequestedAt,
      confirmedAt: Date.now(),
      status: "cancelled",
    });

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

    if (existing.status === "paused" || existing.terminalStatus === "needs_user_action") {
      await this.acceptTaskCurrentProgress(
        taskId,
        "Task stopped by user; current progress accepted.",
      );
      return;
    }

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      await cached.executor.wrapUp();
    } else if (this.queueManager.cancelQueuedTask(taskId)) {
      // Task was queued but hadn't started — no work to preserve, just cancel it
      this.cancelTaskRecord(taskId, "Task removed from queue during wrap-up request");
      this.finishQueueSlot(taskId);
    }
  }

  private getLatestPausedTaskBlocker(taskId: string):
    | {
        reasonCode?: string;
        message?: string;
        isVerificationFailure: boolean;
      }
    | undefined {
    const events = this.eventRepo.findByTaskId(taskId);
    let latestPause:
      | {
          reasonCode?: string;
          message?: string;
          isVerificationFailure: boolean;
        }
      | undefined;
    let latestVerificationFailure:
      | {
          reasonCode: string;
          message?: string;
          isVerificationFailure: true;
        }
      | undefined;

    const getPayload = (event: TaskEvent): Record<string, unknown> => {
      if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
        return event.payload as Record<string, unknown>;
      }
      return {};
    };
    const getText = (payload: Record<string, unknown>): string => {
      for (const key of ["message", "reason", "error", "userMessage"]) {
        const value = payload[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return "";
    };
    const isVerificationFailureText = (value: string): boolean =>
      /verification\s+(?:failed|did not pass)|incorrect\s+content|required\s+verification|does not pass|doesn't pass/i.test(
        value,
      );

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const type = this.resolveLegacyEventType(event);
      if (type === "user_message") break;

      const payload = getPayload(event);
      if (type === "verification_failed" && !latestVerificationFailure) {
        latestVerificationFailure = {
          reasonCode: "verification_failed",
          message: getText(payload) || undefined,
          isVerificationFailure: true,
        };
        continue;
      }

      if ((type === "task_paused" || type === "awaiting_user_input") && !latestPause) {
        const reasonCode =
          typeof payload.reasonCode === "string" && payload.reasonCode.trim()
            ? payload.reasonCode.trim()
            : typeof payload.reason === "string" && payload.reason.trim()
              ? payload.reason.trim()
              : undefined;
        const pauseMessage = getText(payload) || undefined;
        latestPause = {
          reasonCode,
          message: pauseMessage,
          isVerificationFailure:
            reasonCode === "verification_failed" || isVerificationFailureText(pauseMessage || ""),
        };
      }
    }

    if (latestPause?.isVerificationFailure) return latestPause;
    if (latestVerificationFailure) return latestVerificationFailure;
    return latestPause;
  }

  private async acceptTaskCurrentProgress(taskId: string, message: string): Promise<void> {
    const existing = this.taskRepo.findById(taskId);
    const currentStatus = existing ? deriveCanonicalTaskStatus(existing) : undefined;
    if (!existing || isTerminalTaskStatus(currentStatus)) {
      return;
    }

    const pendingRequests = this.inputRequestRepo.findPendingByTaskId(taskId);
    for (const request of pendingRequests) {
      this.inputRequestRepo.resolve(request.id, "dismissed");
      const pending = this.pendingInputRequests.get(request.id);
      if (pending && !pending.resolved) {
        pending.resolved = true;
        this.pendingInputRequests.delete(request.id);
        pending.reject(new Error("Task stopped by user; current progress accepted."));
      }
      this.logEvent(taskId, "input_request_dismissed", {
        requestId: request.id,
        status: "dismissed",
        terminalTask: true,
        reason: "user_accepted_current_progress",
      });
    }

    this.cleanupPendingApprovalsForTask(
      taskId,
      "Task ended because the user accepted the current progress.",
    );

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      await cached.executor.cancel("user");
      cached.status = "completed";
      cached.lastAccessed = Date.now();
    }

    const completedAt = Date.now();
    const persistedReasonCode =
      typeof existing.awaitingUserInputReasonCode === "string" &&
      existing.awaitingUserInputReasonCode.trim()
        ? existing.awaitingUserInputReasonCode.trim()
        : undefined;
    const pausedBlocker =
      this.getLatestPausedTaskBlocker(taskId) ||
      (persistedReasonCode
        ? {
            reasonCode: persistedReasonCode,
            message: undefined,
            isVerificationFailure: persistedReasonCode === "verification_failed",
          }
        : undefined);
    const bestKnownOutcome = getTaskBestKnownOutcome(existing);
    const acceptedProgressIsPartial = Boolean(pausedBlocker);
    const blockerMessage = pausedBlocker?.message
      ? pausedBlocker.message.slice(0, 800)
      : pausedBlocker?.reasonCode
        ? `The task paused for ${pausedBlocker.reasonCode}.`
        : "";
    const preservedOutputs = Array.from(
      new Set([
        ...(bestKnownOutcome?.outputSummary?.created || []),
        ...(bestKnownOutcome?.outputSummary?.modifiedFallback || []),
      ]),
    )
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 6);
    const resultSummary = acceptedProgressIsPartial
      ? [
          "Stopped with current progress accepted, but the task did not reach a verified success.",
          preservedOutputs.length > 0
            ? `Preserved output(s) (not verified): ${preservedOutputs.join(", ")}.`
            : "Partial progress was preserved; treat it as unverified.",
          blockerMessage
            ? `${pausedBlocker?.isVerificationFailure ? "Verification blocker" : "Blocker"}: ${blockerMessage}`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : bestKnownOutcome?.resultSummary ||
        existing.resultSummary ||
        "Stopped by user with current progress accepted.";
    const terminalStatus: NonNullable<Task["terminalStatus"]> = acceptedProgressIsPartial
      ? "partial_success"
      : "ok";
    const failureClass: Task["failureClass"] = acceptedProgressIsPartial
      ? pausedBlocker?.isVerificationFailure
        ? "required_verification"
        : "user_blocker"
      : undefined;
    const acceptedBestKnownOutcome = bestKnownOutcome
      ? {
          ...bestKnownOutcome,
          capturedAt: completedAt,
          resultSummary,
          terminalStatus,
          ...(failureClass ? { failureClass } : {}),
          ...(blockerMessage
            ? {
                blockingIssues: Array.from(
                  new Set([...(bestKnownOutcome.blockingIssues || []), blockerMessage]),
                ).slice(-6),
              }
            : {}),
        }
      : undefined;
    const lastRunDurationMs = this.calculateLatestRunDurationMs(
      taskId,
      completedAt,
      existing.createdAt,
    );

    this.taskRepo.update(taskId, {
      status: "completed",
      completedAt,
      lastRunDurationMs,
      error: null,
      terminalStatus,
      failureClass,
      resultSummary,
      ...(acceptedBestKnownOutcome ? { bestKnownOutcome: acceptedBestKnownOutcome } : {}),
    });
    this.clearRetryState(taskId);
    this.clearTimelineTaskState(taskId);

    this.logEvent(taskId, "task_completed", {
      message,
      resultSummary,
      terminalStatus,
      lastRunDurationMs,
      ...(acceptedBestKnownOutcome ? { bestKnownOutcome: acceptedBestKnownOutcome } : {}),
      terminalStatusReason: "user_accepted_current_progress",
    });

    if (this.teamOrchestrator && existing.status !== "completed") {
      void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
    }
    this.finishQueueSlot(taskId);
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
    if (this.shutdownRequested) return false;
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
    // A paused task survives a desktop restart, but its executor does not.
    // Reconstruct it from the same durable checkpoint used for interrupted
    // tasks so the recovery card's Resume action remains functional.
    const task = this.taskRepo.findById(taskId);
    if (task?.status === "paused" && !isTerminalTaskStatus(deriveCanonicalTaskStatus(task))) {
      this.taskRepo.update(taskId, { status: "interrupted" });
      try {
        await this.resumeInterruptedTask({ ...task, status: "interrupted" });
        return true;
      } catch (error) {
        this.taskRepo.update(taskId, { status: "paused" });
        throw error;
      }
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

  /**
   * Release queue bookkeeping when a task reaches a terminal state through a
   * generic status update. Most completion paths call completeTask/failTask,
   * but executor error handling persists `status: failed` directly via
   * updateTask; without this guard the queue slot remains occupied forever.
   */
  private finishQueueSlotIfTracked(taskId: string): void {
    if (!this.queueManager) return;

    const wasQueued = this.queueManager.isQueued(taskId);
    const wasRunning = this.queueManager.isRunning(taskId);
    if (!wasQueued && !wasRunning) return;

    // A terminal update can race with a queued task that has not started yet.
    // Remove it before processing the next queued item so it cannot start after
    // it has already failed/cancelled.
    if (wasQueued) {
      this.queueManager.cancelQueuedTask(taskId);
    }
    this.finishQueueSlot(taskId);
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

  private isAutoReviewSafeCommand(command: string): boolean {
    const normalized = String(command || "").trim();
    if (!normalized) return false;
    if (
      /&&|\|\||[;|`]|>>?|<<?|\$\(|\bsudo\b|\bchmod\b|\bchown\b|\brm\b|\bmv\b|\bcp\b/i.test(
        normalized,
      )
    ) {
      return false;
    }
    const lowered = normalized.toLowerCase();
    return [
      "pwd",
      "ls",
      "tree",
      "head ",
      "tail ",
      "sed -n",
      "grep ",
      "rg ",
      "git status",
      "git diff",
      "git log",
      "git show",
      "git branch",
      "git rev-parse",
      "git ls-files",
    ].some((prefix) => lowered === prefix.trim() || lowered.startsWith(prefix));
  }

  private canAutoReviewApprove(
    taskId: string,
    type: ApprovalType | undefined,
    details: Record<string, unknown>,
    profile?: EffectiveAccessProfile,
  ): { approved: boolean; reason?: string } {
    const policies = loadPolicies();
    if (policies.runtime.autoReview.enabled !== true) {
      return { approved: false };
    }
    if (type === "run_command") {
      const command = typeof details.command === "string" ? details.command : "";
      return this.isAutoReviewSafeCommand(command)
        ? { approved: true, reason: "safe_read_shell_command" }
        : { approved: false };
    }
    if (type === "network_access") {
      const permissionInput =
        details.permissionInput && typeof details.permissionInput === "object"
          ? (details.permissionInput as Record<string, unknown>)
          : details.params && typeof details.params === "object"
            ? (details.params as Record<string, unknown>)
            : details;
      const url = typeof permissionInput.url === "string" ? permissionInput.url : "";
      if (!url) return { approved: false };
      const toolName = typeof details.tool === "string" ? details.tool : "network_access";
      const decision = evaluateNetworkPolicy({
        url,
        toolName,
        networkEnabled: profile?.networkEnabled,
        accessNetworkMode: profile?.definition.network,
        profileDomainRules: profile?.definition.domainRules,
      });
      this.logEvent(taskId, "network_policy_decision", decision);
      return decision.action === "allow"
        ? { approved: true, reason: "allowed_network_read" }
        : { approved: false };
    }
    return { approved: false };
  }

  private getEffectiveAccessProfile(
    taskId: string,
    task?: Task,
    workspace?: Workspace,
  ): EffectiveAccessProfile {
    const resolvedTask = this.getTaskWithTransientAgentConfig(
      task || this.taskRepo.findById(taskId),
    );
    const resolvedWorkspace =
      workspace ||
      this.getExecutorForTask(taskId)?.getWorkspace?.() ||
      (resolvedTask ? this.workspaceRepo?.findById(resolvedTask.workspaceId) : undefined);
    return resolveEffectiveAccessProfile({
      task: resolvedTask,
      workspace: resolvedWorkspace,
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    });
  }

  private getExecutorForTask(taskId: string): TaskExecutor | null {
    const cached = this.activeTasks.get(taskId);
    return cached?.executor || null;
  }

  private buildPermissionMode(taskId: string, task?: Task): PermissionMode {
    const runtime = this.getExecutorForTask(taskId)?.runtime;
    const enforceAllowedMode = (mode: PermissionMode): PermissionMode => {
      const allowedModes = loadPolicies().runtime.allowedPermissionModes;
      if (allowedModes.length === 0 || allowedModes.includes(mode)) {
        return mode;
      }
      const fallback =
        allowedModes.find((candidate) => candidate === "default") ||
        allowedModes.find((candidate) => candidate === "dangerous_only") ||
        allowedModes[0] ||
        "default";
      this.logEvent(taskId, "permission_mode_overridden", {
        requestedMode: mode,
        effectiveMode: fallback,
        reason: "admin_policy",
      });
      return fallback;
    };
    if (task?.agentConfig?.accessProfileId) {
      const profile = this.getEffectiveAccessProfile(taskId, task);
      return enforceAllowedMode(profile.permissionMode);
    }
    if (runtime?.getPermissionState().mode) {
      return enforceAllowedMode(runtime.getPermissionState().mode);
    }
    if (
      task?.agentConfig?.executionMode === "plan" ||
      task?.agentConfig?.executionMode === "analyze"
    ) {
      return enforceAllowedMode("plan");
    }
    if (task?.agentConfig?.permissionMode) {
      return enforceAllowedMode(task.agentConfig.permissionMode);
    }
    if (isAutomatedTaskLike(task)) {
      return enforceAllowedMode("dont_ask");
    }
    return enforceAllowedMode(PermissionSettingsManager.loadSettings().defaultMode || "default");
  }

  /**
   * Surface ignored manifest grants once per workspace. buildPermissionRules
   * runs on every permission request, so this must not log per call.
   */
  private warnOnceAboutUntrustedManifestRules(workspacePath: string, droppedCount: number): void {
    if (this.warnedUntrustedManifestWorkspaces.has(workspacePath)) return;
    this.warnedUntrustedManifestWorkspaces.add(workspacePath);
    log.warn(
      `Ignored ${droppedCount} "allow" rule(s) in ${workspacePath}/.cowork/policy/permissions.json ` +
        "that are not mirrored in this machine's workspace permissions. " +
        "Approve the action once to trust it here.",
    );
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
    // The manifest is a checked-in mirror, so it is untrusted input: permissive
    // rules count only when the workspace database already holds the same rule.
    // See filterTrustedManifestRules.
    let manifestRules: PermissionRule[] = [];
    if (workspace?.path) {
      const manifest = loadWorkspacePermissionManifest(workspace.path);
      const trusted = filterTrustedManifestRules(manifest.rules, workspaceDbRules);
      manifestRules = trusted.rules;
      if (trusted.droppedCount > 0) {
        this.warnOnceAboutUntrustedManifestRules(workspace.path, trusted.droppedCount);
      }
    }
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
    const builtinRules: PermissionRule[] = BuiltinToolsSettingsManager.getToolAutoApprove(
      "run_command",
    )
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
    authorizationKey?: string;
  } {
    const task = this.getTaskWithTransientAgentConfig(this.taskRepo.findById(taskId));
    const storedWorkspace = task ? this.workspaceRepo.findById(task.workspaceId) : undefined;
    // Task-level shell access is an explicit in-memory capability override. Keep
    // permission evaluation aligned with the effective workspace used to build
    // the executor/tool registry; otherwise run_command is advertised and then
    // denied here because this check reloads the unmodified DB workspace.
    const workspace =
      task && storedWorkspace
        ? this.getEffectiveWorkspaceForTask(taskId) ||
          this.applyTaskWorkspaceOverrides(task, storedWorkspace)
        : storedWorkspace;
    const runtime = this.getExecutorForTask(taskId)?.runtime || null;
    const toolName = this.inferPermissionToolName(type, details);
    const serverName =
      typeof details?.serverName === "string" && details.serverName.trim()
        ? details.serverName.trim()
        : null;
    const permissionToolInput = authorizationToolInput(details || {});
    const mode = this.buildPermissionMode(taskId, task);
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
      toolInput: permissionToolInput,
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
                toolInput: permissionToolInput,
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
      toolInput: permissionToolInput,
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
          toolInput: permissionToolInput,
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
      authorizationKey: authorizationFingerprint({
        version: 1,
        policyVersion: process.env.COWORK_ACCESS_POLICY_VERSION || "boundary",
        taskId,
        type,
        toolName,
        input: permissionToolInput,
        workspace: workspace && {
          id: workspace.id,
          path: workspace.path,
          permissions: workspace.permissions,
        },
        restrictions: task?.agentConfig?.toolRestrictions,
        allowedTools: task?.agentConfig?.allowedTools,
        rules,
        runtimePolicy: loadPolicies().runtime,
      }),
    };
  }

  private persistApprovalActionRule(
    action: ApprovalResponseAction,
    approval: Any,
  ): {
    effect?: PermissionEffect;
    destination?: "session" | "workspace" | "profile" | "recurring";
    dbPersisted?: boolean;
    manifestPersisted?: boolean;
    manifestError?: string;
  } {
    const details =
      approval?.details && typeof approval.details === "object"
        ? (approval.details as Record<string, unknown>)
        : {};
    const prompt = details.permissionPrompt as PermissionPromptDetails | undefined;
    if (!prompt?.scope) {
      return {};
    }
    const effect: PermissionEffect = action.startsWith("deny_") ? "deny" : "allow";
    const destination = action.endsWith("_session")
      ? "session"
      : action.endsWith("_workspace")
        ? "workspace"
        : action.endsWith("_profile")
          ? "profile"
          : action.endsWith("_recurring")
            ? "recurring"
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

    if (destination === "recurring") {
      const recurringService = (this as Any).options?.recurringApprovalService as
        | RecurringApprovalService
        | undefined;
      const recurringInput =
        recurringService && workspace
          ? this.buildRecurringApprovalInput(
              String(approval.type || "external_service"),
              details,
              workspace,
              prompt.scope,
            )
          : null;
      if (!recurringService || !recurringInput) {
        return {
          effect,
          destination,
          manifestError: "Recurring approval storage is unavailable for this task.",
        };
      }
      recurringService.create({
        ...recurringInput,
        effect: effect === "deny" ? "deny" : "allow",
        scopePreview: prompt.scopePreview,
        createdByApprovalId: approval.id,
      });
      return { effect, destination, dbPersisted: true };
    }

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

  private rememberDurableApprovalGrant(taskId: string, approval: ApprovalRequest): void {
    const details =
      approval.details && typeof approval.details === "object"
        ? (approval.details as Record<string, unknown>)
        : {};
    const prompt = details.permissionPrompt as PermissionPromptDetails | undefined;
    if (!prompt?.scope) return;
    const authorization = details.authorization as { version?: number; key?: string } | undefined;
    if (authorization?.version !== 1 || typeof authorization.key !== "string") return;

    const grants = (this as Any).pendingDurableApprovalGrants as
      | Map<string, Map<string, { approvalId: string; grantedAt: number }>>
      | undefined;
    if (!grants) return;
    let taskGrants = grants.get(taskId);
    if (!taskGrants) {
      taskGrants = new Map();
      grants.set(taskId, taskGrants);
    }
    taskGrants.set(authorization.key, {
      approvalId: approval.id,
      grantedAt: Date.now(),
    });
  }

  private consumeDurableApprovalGrant(
    taskId: string,
    trackingKey: string,
  ): { approvalId: string; grantedAt: number } | undefined {
    const grants = (this as Any).pendingDurableApprovalGrants as
      | Map<string, Map<string, { approvalId: string; grantedAt: number }>>
      | undefined;
    if (!grants) return undefined;
    const taskGrants = grants.get(taskId);
    if (!taskGrants) return undefined;
    const grant = taskGrants.get(trackingKey);
    if (!grant) return undefined;
    taskGrants.delete(trackingKey);
    if (taskGrants.size === 0) grants.delete(taskId);
    return Date.now() - grant.grantedAt <= 5 * 60 * 1000 ? grant : undefined;
  }

  private buildRecurringApprovalInput(
    type: string,
    details: Record<string, unknown>,
    workspace: Workspace,
    scope: PermissionRule["scope"],
  ): RecurringApprovalFingerprintInput {
    const toolName = this.inferPermissionToolName(type, details);
    const toolInput = Object.prototype.hasOwnProperty.call(details, "permissionInput")
      ? details.permissionInput
      : (details.params ?? details);
    return {
      workspaceId: workspace.id,
      toolName,
      toolInput,
      approvalType: type,
      command: typeof details.command === "string" ? details.command : null,
      path: typeof details.path === "string" ? details.path : null,
      serverName: typeof details.serverName === "string" ? details.serverName : null,
      scope,
    };
  }

  evaluateToolPermission(
    taskId: string,
    opts: {
      approvalType?: ApprovalType;
      toolName: string;
      details?: Any;
      allowPersistence?: boolean;
    },
  ): PermissionEvaluationResult {
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

  /** Authorize a tool operation without manufacturing an approval lifecycle for allowed work. */
  async authorizeToolAction(
    taskId: string,
    request: {
      toolName: string;
      approvalType: ApprovalType;
      details?: Any;
      description?: string;
      allowAutoApprove?: boolean;
      signal?: AbortSignal;
      requireExplicitApproval?: boolean;
    },
  ): Promise<boolean> {
    if (request.signal?.aborted) throw new Error("Tool authorization cancelled");
    const details = { ...(request.details || {}), tool: request.toolName };
    const permission = this.evaluateToolPermission(taskId, {
      toolName: request.toolName,
      approvalType: request.approvalType,
      details,
      allowPersistence: request.approvalType !== "location_access",
    });
    if (permission.decision === "deny") return false;
    if (
      permission.decision === "allow" &&
      !request.requireExplicitApproval &&
      request.allowAutoApprove !== false
    ) {
      return true;
    }
    return this.requestApproval(
      taskId,
      request.approvalType,
      request.description || `Allow ${request.toolName} to access the requested resource?`,
      details,
      {
        allowAutoApprove: request.allowAutoApprove,
        signal: request.signal,
        requireExplicitApproval: request.requireExplicitApproval,
      },
    );
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

  async requestUserInput(
    taskId: string,
    args: RequestUserInputArgs,
  ): Promise<InputRequestResponse> {
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

  /**
   * Replace the legacy approval modal with the same durable, inline task input
   * used by `request_user_input`. The assistant explains the blocked operation
   * in the timeline, while the task card carries the explicit decision. This
   * keeps high-impact work fail-closed without manufacturing a popup approval.
   */
  private async requestAssistantApproval(
    taskId: string,
    type: string,
    description: string,
    details: Any,
    runtime?: {
      recordPermissionSuccess?: (trackingKey: string) => void;
      recordPermissionDenial?: (trackingKey: string) => void;
    } | null,
    trackingKey = type,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) {
      throw new Error("Approval request cancelled because tool execution ended");
    }

    this.logEvent(taskId, "assistant_message", {
      message: buildAssistantApprovalMessage(type, description, details),
      source: "assistant_approval_request",
      approvalType: type,
    });

    let abortListener: (() => void) | undefined;
    try {
      const inputRequester =
        typeof (this as Any).requestUserInput === "function"
          ? (this as Any).requestUserInput
          : AgentDaemon.prototype.requestUserInput;
      const responsePromise = inputRequester.call(
        this,
        taskId,
        buildAssistantApprovalRequest(type, description, details),
      );
      const response = signal
        ? await Promise.race([
            responsePromise,
            new Promise<never>((_, reject) => {
              abortListener = () =>
                reject(new Error("Approval request cancelled because tool execution ended"));
              signal.addEventListener("abort", abortListener, { once: true });
              if (signal.aborted) abortListener();
            }),
          ])
        : await responsePromise;
      if (signal?.aborted) {
        throw new Error("Approval request cancelled because tool execution ended");
      }

      const approved =
        response.status === "submitted" && parseAssistantApprovalAnswer(response.answers);
      if (approved) {
        runtime?.recordPermissionSuccess?.(trackingKey);
        this.logEvent(taskId, "approval_granted", {
          requestId: response.requestId,
          assistantInput: true,
          approvalType: type,
          reason: "assistant_input",
        });
      } else {
        runtime?.recordPermissionDenial?.(trackingKey);
        this.logEvent(taskId, "approval_denied", {
          requestId: response.requestId,
          assistantInput: true,
          approvalType: type,
          reason: "assistant_input_denied",
        });
      }
      return approved;
    } catch (error) {
      if (signal?.aborted) {
        const pending =
          typeof (this.inputRequestRepo as Any)?.findPendingByTaskId === "function"
            ? this.inputRequestRepo.findPendingByTaskId(taskId)[0]
            : undefined;
        if (pending) {
          if (typeof (this.inputRequestRepo as Any)?.resolve === "function") {
            this.inputRequestRepo.resolve(pending.id, "dismissed");
          }
          const pendingWait = this.pendingInputRequests?.get(pending.id);
          if (pendingWait && !pendingWait.resolved) {
            pendingWait.resolved = true;
            this.pendingInputRequests.delete(pending.id);
            pendingWait.reject(error);
          }
          this.logEvent(taskId, "input_request_dismissed", {
            requestId: pending.id,
            reason: "tool_execution_cancelled",
          });
        }
        throw error;
      }
      const errorMessage = String((error as Any)?.message || error || "");
      if (!/structured input request dismissed by user/i.test(errorMessage)) {
        throw error;
      }
      runtime?.recordPermissionDenial?.(trackingKey);
      this.logEvent(taskId, "approval_denied", {
        assistantInput: true,
        approvalType: type,
        reason: "assistant_input_dismissed",
      });
      return false;
    } finally {
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
    }
  }

  async requestApproval(
    taskId: string,
    type: string,
    description: string,
    details: Any,
    opts?: {
      allowAutoApprove?: boolean;
      signal?: AbortSignal;
      requireExplicitApproval?: boolean;
    },
  ): Promise<boolean> {
    if (opts?.signal?.aborted) {
      throw new Error("Approval request cancelled because tool execution ended");
    }
    const allowAutoApprove = opts?.allowAutoApprove !== false;
    const enrichedDetails =
      details && typeof details === "object" && !Array.isArray(details)
        ? { ...details }
        : { value: details };
    const permission = this.evaluatePermissionRequest(
      taskId,
      type as ApprovalType,
      enrichedDetails,
      allowAutoApprove,
    );
    const storedTask = this.taskRepo.findById(taskId);
    const task =
      typeof (this as Any).getTaskWithTransientAgentConfig === "function"
        ? this.getTaskWithTransientAgentConfig(storedTask)
        : storedTask;
    const accessProfile =
      typeof (this as Any).getEffectiveAccessProfile === "function"
        ? this.getEffectiveAccessProfile(taskId, task, permission.workspace)
        : resolveEffectiveAccessProfile({
            task,
            workspace: permission.workspace,
            settings: PermissionSettingsManager.loadSettings(),
            adminPolicies: loadPolicies(),
          });
    // A workspace script or unknown runtime requirement can demand consent even
    // when the ordinary resource policy allows the operation. It cannot override a deny.
    if (
      (opts?.requireExplicitApproval || !allowAutoApprove) &&
      permission.evaluation.decision === "allow"
    ) {
      permission.evaluation = {
        ...permission.evaluation,
        decision: "ask",
        reason: {
          type: "mode",
          mode: accessProfile.permissionMode,
          summary: "Explicit operation consent is required by tool or workspace policy.",
        },
      };
    }
    if (accessProfile.definition.approval === "never" && permission.evaluation.decision === "ask") {
      this.logEvent(taskId, "log", {
        type: "tool_authorization",
        decision: "deny",
        reason: "approval_unavailable",
        approvalType: type,
      });
      return false;
    }
    const permissionDetails = {
      ...enrichedDetails,
      permissionPrompt: permission.promptDetails,
      ...(permission.authorizationKey
        ? { authorization: { version: 1, key: permission.authorizationKey } }
        : {}),
      accessProfile: {
        id: accessProfile.id,
        requestedId: accessProfile.requestedId,
        sandbox: accessProfile.sandboxMode,
        approval: accessProfile.definition.approval,
        reviewer: accessProfile.definition.reviewer,
        network: accessProfile.definition.network,
        adminConstrained: accessProfile.adminConstrained,
        profileUnavailable: accessProfile.profileUnavailable,
        profileScoped: accessProfile.profileScoped,
        constraintReason: accessProfile.constraintReason,
      },
    };
    const consumeDurableApprovalGrant = (this as Any).consumeDurableApprovalGrant as
      | ((
          taskId: string,
          trackingKey: string,
        ) => { approvalId: string; grantedAt: number } | undefined)
      | undefined;
    const durableApprovalGrant =
      permission.evaluation.decision === "ask" && consumeDurableApprovalGrant
        ? consumeDurableApprovalGrant.call(
            this,
            taskId,
            permission.authorizationKey || permission.trackingKey,
          )
        : undefined;
    if (durableApprovalGrant) {
      permission.runtime?.recordPermissionSuccess(permission.trackingKey);
      if (type === "external_file_access") {
        this.grantExternalFileApprovalsFromDetails(taskId, enrichedDetails);
      }
      this.logEvent(taskId, "approval_granted", {
        approvalId: durableApprovalGrant.approvalId,
        autoResolved: true,
        reason: "durable_restart_allow_once",
        grantedAt: durableApprovalGrant.grantedAt,
      });
      return true;
    }
    const recurringApprovalService = (this as Any).options?.recurringApprovalService as
      | RecurringApprovalService
      | undefined;
    if (permission.evaluation.decision === "ask" && recurringApprovalService) {
      const recurringInput = permission.workspace
        ? this.buildRecurringApprovalInput(
            type,
            permissionDetails,
            permission.workspace,
            permission.scope,
          )
        : null;
      const recurringMatch =
        recurringInput && type !== "protected_credential"
          ? recurringApprovalService.findActive(recurringInput)
          : null;
      if (recurringMatch) {
        const approved = recurringMatch.summary.effect === "allow";
        if (approved) permission.runtime?.recordPermissionSuccess(permission.trackingKey);
        else permission.runtime?.recordPermissionDenial(permission.trackingKey);
        if (approved && type === "external_file_access") {
          this.grantExternalFileApprovalsFromDetails(taskId, enrichedDetails);
        }
        this.logEvent(taskId, "log", {
          type: "tool_authorization",
          decision: approved ? "allow" : "deny",
          reason: "recurring_approval",
          recurringApprovalId: recurringMatch.summary.id,
        });
        return approved;
      }
    }
    // `allowAutoApprove=false` is an explicit request for a user decision. Do
    // not let a broad allow rule turn that request into a silent grant in the
    // no-popup runtime; the assistant-input branch below handles it.
    if (permission.evaluation.decision === "allow" && allowAutoApprove) {
      permission.runtime?.recordPermissionSuccess(permission.trackingKey);
      if (type === "external_file_access") {
        this.grantExternalFileApprovalsFromDetails(taskId, enrichedDetails);
      }
      this.logEvent(taskId, "log", {
        type: "tool_authorization",
        decision: "allow",
        approvalType: type,
        reason: permission.evaluation.reason.type,
        permissionReason: permission.evaluation.reason,
      });
      return true;
    }

    if (permission.evaluation.decision === "deny") {
      permission.runtime?.recordPermissionDenial(permission.trackingKey);
      this.logEvent(taskId, "log", {
        type: "tool_authorization",
        decision: "deny",
        approvalType: type,
        reason: permission.evaluation.reason.type,
        permissionReason: permission.evaluation.reason,
      });
      return false;
    }

    // Any decision that remains `ask` is delivered as an inline assistant/task
    // question when popup approvals are disabled. A permission that evaluated
    // to `allow` already returned above; hard denies returned below. Keeping
    // this branch at the final ask boundary means network, credentials,
    // exports, MCP, and external-file requests all share the same no-popup
    // response path.
    if (
      approvalPromptsDisabled() &&
      (permission.evaluation.decision === "ask" ||
        !allowAutoApprove ||
        shouldUseAssistantApprovalInput(type, enrichedDetails, {
          allowAutoApprove,
          requireExplicitApproval: opts?.requireExplicitApproval,
        }))
    ) {
      if (isAutomatedTaskLike(task) || task?.agentConfig?.humanInputPolicy === "none") {
        this.logEvent(taskId, "log", {
          type: "tool_authorization",
          decision: "deny",
          reason: "interactive_approval_unavailable",
          approvalType: type,
        });
        return false;
      }

      const assistantRequester =
        typeof (this as Any).requestAssistantApproval === "function"
          ? (this as Any).requestAssistantApproval
          : AgentDaemon.prototype.requestAssistantApproval;
      const approved = await assistantRequester.call(
        this,
        taskId,
        type,
        description,
        permissionDetails,
        permission.runtime,
        permission.trackingKey,
        opts?.signal,
      );
      if (approved && type === "external_file_access") {
        this.grantExternalFileApprovalsFromDetails(taskId, enrichedDetails);
      }
      return approved;
    }

    const explicitProfileSelected = typeof task?.agentConfig?.accessProfileId === "string";
    const autoReviewEnabledForProfile =
      accessProfile.definition.reviewer === "auto-review" || !explicitProfileSelected;
    const autoReviewProfile =
      explicitProfileSelected ||
      (accessProfile.definition.domainRules?.length || 0) > 0 ||
      accessProfile.definition.network === "disabled"
        ? accessProfile
        : undefined;
    const autoReview =
      allowAutoApprove && autoReviewEnabledForProfile
        ? this.canAutoReviewApprove(
            taskId,
            type as ApprovalType | undefined,
            permissionDetails,
            autoReviewProfile,
          )
        : { approved: false };
    const safeSessionAutoApprove =
      allowAutoApprove &&
      this.sessionAutoApproveAll &&
      this.canSessionAutoApproveType(type as ApprovalType | undefined) &&
      autoReview.approved;

    if (safeSessionAutoApprove) {
      permission.runtime?.recordPermissionSuccess(permission.trackingKey);
      if (type === "external_file_access") {
        this.grantExternalFileApprovalsFromDetails(taskId, enrichedDetails);
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
        reason: "session_auto_approve",
        autoReviewReason: autoReview.reason,
        permissionReason: permission.evaluation.reason,
      });
      return true;
    }

    if (autoReview.approved) {
      permission.runtime?.recordPermissionSuccess(permission.trackingKey);
      if (type === "external_file_access") {
        this.grantExternalFileApprovalsFromDetails(taskId, enrichedDetails);
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
        reason: "auto_review",
        autoReviewReason: autoReview.reason,
        permissionReason: permission.evaluation.reason,
      });
      return true;
    }

    if (isAutomatedTaskLike(task) || task?.agentConfig?.humanInputPolicy === "none") {
      this.logEvent(taskId, "log", {
        type: "tool_authorization",
        decision: "deny",
        reason: "interactive_approval_unavailable",
        approvalType: type,
      });
      return false;
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
      const timeoutHandle = setTimeout(() => {
        const pending = this.pendingApprovals.get(approval.id);
        if (pending && !pending.resolved) {
          const currentTask = this.taskRepo.findById(taskId);
          const currentStatus = currentTask ? deriveCanonicalTaskStatus(currentTask) : undefined;
          pending.resolved = true;
          if (pending.abortSignal && pending.abortListener) {
            pending.abortSignal.removeEventListener("abort", pending.abortListener);
          }
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
      }, APPROVAL_REQUEST_TIMEOUT_MS);

      const pending: PendingApprovalEntry = {
        taskId,
        approval,
        resolve,
        reject,
        resolved: false,
        timeoutHandle,
        abortSignal: opts?.signal,
      };
      const abortListener = () => {
        const current = this.pendingApprovals.get(approval.id);
        if (!current || current.resolved) return;
        current.resolved = true;
        clearTimeout(current.timeoutHandle);
        current.abortSignal?.removeEventListener("abort", abortListener);
        this.pendingApprovals.delete(approval.id);
        this.approvalRepo.update(approval.id, "denied");
        this.logEvent(taskId, "approval_denied", {
          approvalId: approval.id,
          reason: "tool_execution_cancelled",
        });
        reject(new Error("Approval request cancelled because tool execution ended"));
      };
      pending.abortListener = abortListener;
      this.pendingApprovals.set(approval.id, pending);
      if (opts?.signal) {
        opts.signal.addEventListener("abort", abortListener, { once: true });
        if (opts.signal.aborted) abortListener();
      }
    });
  }

  /**
   * Respond to an approval request
   * Uses idempotency to prevent double-approval race conditions
   * Implements C6: Approval Gate Enforcement
   */
  private isApprovalAuthorityCurrent(approval: ApprovalRequest): boolean {
    const task = this.taskRepo.findById(approval.taskId);
    if (!task || isTerminalTaskStatus(deriveCanonicalTaskStatus(task))) return false;
    const details = (approval.details || {}) as Record<string, Any>;
    const current = this.evaluatePermissionRequest(approval.taskId, approval.type, details);
    if (current.evaluation.decision === "deny") return false;
    if (
      current.workspace?.permissions.accessApprovalPolicy === "never" &&
      current.evaluation.decision !== "allow"
    )
      return false;
    const expectedKey = details.authorization?.key;
    return (
      details.authorization?.version === 1 &&
      typeof expectedKey === "string" &&
      current.authorizationKey === expectedKey
    );
  }

  async respondToApproval(
    approvalId: string,
    approved: boolean,
    action?: ApprovalResponseAction,
    attribution?: SessionActionAttribution,
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
        const currentTask = this.taskRepo?.findById(pending.taskId);
        if (
          this.taskRepo &&
          (!currentTask || isTerminalTaskStatus(deriveCanonicalTaskStatus(currentTask)))
        ) {
          pending.resolved = true;
          clearTimeout(pending.timeoutHandle);
          if (pending.abortSignal && pending.abortListener) {
            pending.abortSignal.removeEventListener("abort", pending.abortListener);
          }
          this.pendingApprovals.delete(approvalId);
          this.approvalRepo.update(approvalId, "denied", attribution);
          this.logEvent(pending.taskId, "approval_denied", {
            approvalId,
            reason: "task_terminal_before_response",
          });
          pending.resolve(false);
          approvalIdempotency.complete(idempotencyKey, { success: true, status: "handled" });
          return "handled";
        }
        let normalizedAction: ApprovalResponseAction =
          action || (approved ? "allow_once" : "deny_once");
        let authorityChanged = false;
        if (
          normalizedAction.startsWith("allow_") &&
          typeof (this as Any).isApprovalAuthorityCurrent === "function" &&
          !this.isApprovalAuthorityCurrent(pending.approval)
        ) {
          normalizedAction = "deny_once";
          authorityChanged = true;
        }
        const denialReason = authorityChanged
          ? "Approval expired because task authority changed; retry the operation."
          : "User denied approval";
        const persistenceResult = this.persistApprovalActionRule(
          normalizedAction,
          pending.approval,
        );
        const didApprove =
          normalizedAction === "allow_once" ||
          normalizedAction === "allow_session" ||
          normalizedAction === "allow_workspace" ||
          normalizedAction === "allow_profile" ||
          normalizedAction === "allow_recurring";
        const runtime = this.getExecutorForTask(pending.taskId)?.runtime || null;
        const prompt =
          pending.approval?.details && typeof pending.approval.details === "object"
            ? ((pending.approval.details as Record<string, unknown>).permissionPrompt as
                | PermissionPromptDetails
                | undefined)
            : undefined;
        const trackingKey = prompt?.scope ? this.buildPermissionTrackingKey(prompt.scope) : "";
        if (runtime && trackingKey) {
          if (didApprove) {
            runtime.recordPermissionSuccess(trackingKey);
          } else {
            runtime.recordPermissionDenial(trackingKey);
          }
        }
        if (didApprove && pending.approval?.type === "external_file_access") {
          this.grantExternalFileApprovalsFromDetails(pending.taskId, pending.approval.details);
        }

        // Mark as resolved first to prevent race condition with timeout
        pending.resolved = true;

        // Clear the timeout
        clearTimeout(pending.timeoutHandle);
        if (pending.abortSignal && pending.abortListener) {
          pending.abortSignal.removeEventListener("abort", pending.abortListener);
        }

        this.pendingApprovals.delete(approvalId);
        if (attribution) {
          this.approvalRepo.update(approvalId, didApprove ? "approved" : "denied", attribution);
        } else {
          this.approvalRepo.update(approvalId, didApprove ? "approved" : "denied");
        }
        const awaitingAnotherApproval = [...this.pendingApprovals.values()].some(
          (entry) => entry.taskId === pending.taskId && !entry.resolved,
        );
        this.updateTask(pending.taskId, {
          status: awaitingAnotherApproval ? "blocked" : didApprove ? "executing" : "paused",
          terminalStatus: awaitingAnotherApproval
            ? "awaiting_approval"
            : didApprove
              ? undefined
              : "needs_user_action",
          failureClass: undefined,
          error: didApprove ? null : denialReason,
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
          pending.reject(new Error(denialReason));
        }

        approvalIdempotency.complete(idempotencyKey, { success: true, status: "handled" });
        return "handled";
      }

      // The Promise resolver is process-local, so it is absent after a
      // restart.  Resolve the durable approval row directly and reconstruct
      // the executor from its checkpoint/events instead of returning a false
      // `not_found` response (or silently losing the user's decision).
      const persistedApproval = this.approvalRepo.findById(approvalId);
      if (!persistedApproval || persistedApproval.status !== "pending") {
        approvalIdempotency.complete(idempotencyKey, { success: true, status: "not_found" });
        return "not_found";
      }

      let normalizedAction: ApprovalResponseAction =
        action || (approved ? "allow_once" : "deny_once");
      let authorityChanged = false;
      if (
        normalizedAction.startsWith("allow_") &&
        typeof (this as Any).isApprovalAuthorityCurrent === "function" &&
        !this.isApprovalAuthorityCurrent(persistedApproval)
      ) {
        normalizedAction = "deny_once";
        authorityChanged = true;
      }
      const denialReason = authorityChanged
        ? "Approval expired because task authority changed; retry the operation."
        : "User denied approval";
      const didApprove =
        normalizedAction === "allow_once" ||
        normalizedAction === "allow_session" ||
        normalizedAction === "allow_workspace" ||
        normalizedAction === "allow_profile" ||
        normalizedAction === "allow_recurring";
      const persistedTask = this.taskRepo.findById(persistedApproval.taskId);
      const persistedTaskStatus = persistedTask
        ? deriveCanonicalTaskStatus(persistedTask)
        : undefined;

      // Never apply a late approval to an already terminal task.
      if (!persistedTask || isTerminalTaskStatus(persistedTaskStatus)) {
        if (attribution) {
          this.approvalRepo.update(approvalId, "denied", attribution);
        } else {
          this.approvalRepo.update(approvalId, "denied");
        }
        this.logEvent(persistedApproval.taskId, "approval_denied", {
          approvalId,
          action: normalizedAction,
          reason: "task_terminal_after_restart",
        });
        approvalIdempotency.complete(idempotencyKey, { success: true, status: "handled" });
        return "handled";
      }

      const persistenceResult = this.persistApprovalActionRule(normalizedAction, persistedApproval);
      if (didApprove && normalizedAction === "allow_once") {
        const rememberDurableApprovalGrant = (this as Any).rememberDurableApprovalGrant as
          | ((taskId: string, approval: ApprovalRequest) => void)
          | undefined;
        rememberDurableApprovalGrant?.call(this, persistedApproval.taskId, persistedApproval);
      }
      if (attribution) {
        this.approvalRepo.update(approvalId, didApprove ? "approved" : "denied", attribution);
      } else {
        this.approvalRepo.update(approvalId, didApprove ? "approved" : "denied");
      }
      if (didApprove && persistedApproval.type === "external_file_access") {
        this.grantExternalFileApprovalsFromDetails(
          persistedApproval.taskId,
          persistedApproval.details,
        );
      }

      this.updateTask(persistedApproval.taskId, {
        status: didApprove ? "interrupted" : "paused",
        completedAt: undefined,
        terminalStatus: didApprove ? undefined : "needs_user_action",
        failureClass: undefined,
        error: didApprove ? "Approval granted; resuming task." : denialReason,
      });
      this.logEvent(persistedApproval.taskId, didApprove ? "approval_granted" : "approval_denied", {
        approvalId,
        action: normalizedAction,
        persistence: persistenceResult,
        recoveredAfterRestart: true,
      });

      if (didApprove) {
        void this.resumeTaskAfterDurableWait(persistedApproval.taskId);
      }

      approvalIdempotency.complete(idempotencyKey, { success: true, status: "handled" });
      return "handled";
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
      if (pending.abortSignal && pending.abortListener) {
        pending.abortSignal.removeEventListener("abort", pending.abortListener);
      }
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

  /**
   * Resume a task whose in-memory approval/input waiter disappeared during a
   * daemon restart.  The durable event/checkpoint is the source of truth; a
   * follow-up message is used only when an executor is still alive (for
   * example, during a renderer reload) and can consume it directly.
   */
  private async resumeTaskAfterDurableWait(
    taskId: string,
    responseMessage?: string,
  ): Promise<void> {
    const task = this.taskRepo.findById(taskId);
    if (!task || isTerminalTaskStatus(deriveCanonicalTaskStatus(task))) return;

    if (this.activeTasks.has(taskId)) {
      if (responseMessage) {
        await this.sendMessage(taskId, responseMessage).catch((error) => {
          console.warn(
            `[AgentDaemon] Failed to deliver durable wait response for ${taskId}:`,
            error,
          );
        });
      }
      return;
    }

    this.taskRepo.update(taskId, {
      status: "interrupted",
      completedAt: undefined,
      terminalStatus: undefined,
      failureClass: undefined,
      error: "Resuming after a durable approval/input response.",
    });
    this.logEvent(taskId, "task_interrupted", {
      message: "Resuming after a durable approval/input response.",
      reason: "durable_wait_resolved",
    });

    try {
      await this.resumeInterruptedTask(
        {
          ...task,
          status: "interrupted",
          completedAt: undefined,
          terminalStatus: undefined,
          failureClass: undefined,
        },
        responseMessage,
      );
    } catch (error: Any) {
      this.failTask(
        taskId,
        `Failed to resume after durable wait response: ${error?.message || error}`,
      );
      this.logEvent(taskId, "error", {
        message: `Failed to resume after durable wait response: ${error?.message || error}`,
      });
    }
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
          await this.resumeTaskAfterDurableWait(
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
  async captureTaskMutationBaseline(taskId: string, candidatePath: string): Promise<void> {
    const ledger = this.taskMutationLedger;
    if (!ledger) return;
    const task = this.taskRepo.findById(taskId);
    const workspace = task ? this.workspaceRepo.findById(task.workspaceId) : undefined;
    const workspaceRoot = task?.worktreePath || workspace?.path;
    if (!workspaceRoot) return;
    await ledger.captureBaseline(taskId, workspaceRoot, candidatePath, {
      isolatedWorktree: Boolean(task?.worktreePath),
    });
  }

  private recordTaskMutationImpact(
    taskId: string,
    event: TaskEvent,
    effectiveType: string,
    payload: Record<string, unknown>,
  ): void {
    const ledger = this.taskMutationLedger;
    if (!ledger || effectiveType === "task_impact_updated") return;
    const isFileMutation =
      (effectiveType === "file_created" && payload.type !== "directory") ||
      effectiveType === "file_modified" ||
      effectiveType === "file_deleted";
    const isFinal = effectiveType === "task_completed" || effectiveType === "task_cancelled";
    if (!isFileMutation && !isFinal) return;
    const task = this.taskRepo.findById(taskId);
    const workspace = task ? this.workspaceRepo.findById(task.workspaceId) : undefined;
    const workspaceRoot = task?.worktreePath || workspace?.path;
    if (!workspaceRoot) return;
    const candidatePaths = isFileMutation
      ? payload.action === "rename"
        ? [payload.from, payload.to].filter((value): value is string => typeof value === "string")
        : typeof payload.path === "string"
          ? [payload.path]
          : []
      : [];
    void ledger
      .recordMutation({
        taskId,
        workspaceRoot,
        candidatePaths,
        sourceEventId: event.id,
        final: isFinal,
      })
      .then((metrics) => {
        if (metrics.length === 0) return;
        this.logEvent(taskId, "task_impact_updated", {
          metrics,
          replaceProvenance: "task_mutation_ledger",
        });
      })
      .catch((error) => {
        console.warn("[AgentDaemon] Task mutation impact update failed:", error);
      });
  }

  private recordCanonicalToolImpact(taskId: string, event: TaskEvent, effectiveType: string): void {
    if (effectiveType !== "tool_result") return;
    const metrics = extractCanonicalTaskImpactMetrics(event);
    if (metrics.length > 0) this.logEvent(taskId, "task_impact_updated", { metrics });
  }

  /**
   * Broadcast a persisted task-title change without adding metadata noise to
   * the task's conversation timeline.
   */
  emitTaskTitleUpdated(taskId: string, title: string): void {
    const eventId = crypto.randomUUID();
    this.emitTaskEvent({
      id: eventId,
      taskId,
      type: "task_title_updated",
      payload: { title },
      timestamp: Date.now(),
      schemaVersion: 2,
      eventId,
      actor: "system",
    });
  }

  logEvent(taskId: string, type: string, payload: Any): void {
    const timestamp = Date.now();
    const payloadObj: Record<string, unknown> =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? ({ ...(payload as Record<string, unknown>) } as Record<string, unknown>)
        : payload === undefined
          ? {}
          : ({ value: payload } as Record<string, unknown>);

    const securityLifecycleEvent =
      type === "task_created"
        ? "SessionStart"
        : type === "task_completed" || type === "task_cancelled"
          ? "SessionEnd"
          : type === "user_message"
            ? "UserPromptSubmit"
            : type === "approval_requested"
              ? "PermissionRequested"
              : type === "approval_granted"
                ? "PermissionApproved"
                : type === "approval_denied"
                  ? "PermissionDenied"
                  : null;
    if (securityLifecycleEvent) {
      const numbatService = getNumbatService();
      if (numbatService?.isEnabled()) {
        const task = this.taskRepo.findById(taskId);
        const workspace = task ? this.workspaceRepo.findById(task.workspaceId) : undefined;
        numbatService.observeLifecycle({
          taskId,
          sessionId: taskId,
          workspacePath: workspace?.path,
          hookEventName: securityLifecycleEvent,
          actor: type === "user_message" ? "user" : "system",
        });
      }
    }

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
          message: typeof payloadObj.message === "string" ? payloadObj.message : "Thinking...",
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
    let seq = requestedSeq ?? this.nextEventSeq(taskId);
    const eventId = crypto.randomUUID();
    let timelineEvent = normalizeTaskEventToTimelineV2({
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
    // A tool can finish unwinding after the task has already reached a terminal
    // state (most notably after user cancellation). Do not let those late
    // events reopen a fresh BUILD/VERIFY stage in the timeline.
    const persistedTaskForStage =
      stageSourceType && typeof (this as Any).taskRepo?.findById === "function"
        ? (this as Any).taskRepo.findById(taskId)
        : undefined;
    const terminalLifecycleStatus =
      type === "task_completed"
        ? "completed"
        : type === "task_cancelled"
          ? "cancelled"
          : type === "task_status" &&
              (payloadObj.status === "completed" ||
                payloadObj.status === "failed" ||
                payloadObj.status === "cancelled")
            ? payloadObj.status
            : undefined;
    const suppressTerminalStageInference =
      terminalLifecycleStatus === "failed" ||
      terminalLifecycleStatus === "cancelled" ||
      (!terminalLifecycleStatus &&
        isTerminalTaskStatus(
          persistedTaskForStage ? deriveCanonicalTaskStatus(persistedTaskForStage) : undefined,
        ));
    if (stageSourceType && !suppressTerminalStageInference) {
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

    // Stage transitions emit their own timeline events re-entrantly. When that
    // happens, the sequence reserved above is older than the group-close/open
    // events even though the original event is persisted afterward. Reassign
    // locally generated events so persisted replay order matches live order.
    if (requestedSeq === undefined && this.getCurrentEventSeq(taskId) > seq) {
      seq = this.nextEventSeq(taskId);
      timelineEvent = normalizeTaskEventToTimelineV2({
        taskId,
        type,
        payload: payloadObj,
        timestamp,
        eventId,
        seq,
      });
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
    // Terminal events also cover executor follow-ups, which bypass completeTask.
    // Close the active stage before callers discard their in-memory timeline state.
    const terminalStage = this.activeTimelineStageByTask.get(taskId);
    if (terminalLifecycleStatus && terminalStage) {
      this.activeTimelineStageByTask.delete(taskId);
      const timeline = createTimelineEmitter(taskId, (eventType, payload) => {
        this.logEvent(taskId, eventType, payload);
      });
      timeline.finishGroup(terminalStage, {
        label: terminalStage,
        actor: "system",
        status: terminalLifecycleStatus,
        message: `${terminalLifecycleStatus === "completed" ? "Completed" : terminalLifecycleStatus === "failed" ? "Failed" : "Cancelled"} ${terminalStage}`,
      });
    }
    // Keep the event bridge resilient when `logEvent` is exercised on a
    // lightweight daemon double (as in focused renderer/timeline tests). The
    // concrete daemon always has these methods, but the canonical event should
    // still be persisted if an older/mock host does not expose the optional
    // mutation-impact observers.
    const recordCanonicalToolImpact = (this as Any).recordCanonicalToolImpact;
    if (typeof recordCanonicalToolImpact === "function") {
      recordCanonicalToolImpact.call(this, taskId, timelineEvent, legacyType || type);
    }
    const recordTaskMutationImpact = (this as Any).recordTaskMutationImpact;
    if (typeof recordTaskMutationImpact === "function") {
      recordTaskMutationImpact.call(this, taskId, timelineEvent, legacyType || type, legacyPayload);
    }
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
    if (
      type !== "file_created" &&
      type !== "artifact_created" &&
      type !== "timeline_artifact_emitted"
    ) {
      return;
    }

    const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!rawPath) return;
    const isUrl = /^(https?:\/\/|file:\/\/)/i.test(rawPath);
    const storedTask = this.taskRepo.findById(taskId);
    const transientTaskResolver = (this as Any).getTaskWithTransientAgentConfig;
    const task =
      typeof transientTaskResolver === "function"
        ? transientTaskResolver.call(this, storedTask)
        : storedTask;
    const workspace =
      task && typeof task.workspaceId === "string"
        ? this.workspaceRepo.findById(task.workspaceId)
        : undefined;
    const workspacePath =
      workspace && typeof workspace.path === "string" && workspace.path.trim().length > 0
        ? workspace.path.trim()
        : "";
    const normalizedPath =
      !isUrl && !path.isAbsolute(rawPath) && workspacePath
        ? path.resolve(workspacePath, rawPath)
        : rawPath;

    const mimeType =
      typeof payload.mimeType === "string" ? payload.mimeType.trim().toLowerCase() : "";
    const extension = path.extname(rawPath).toLowerCase();
    const isPreviewableVideo =
      mimeType === "video/mp4" ||
      mimeType === "video/webm" ||
      extension === ".mp4" ||
      extension === ".webm" ||
      payload.type === "video";
    const isPreviewableHtml =
      mimeType === "text/html" ||
      extension === ".html" ||
      extension === ".htm" ||
      payload.type === "html" ||
      payload.type === "web";
    if (!isPreviewableVideo && !isPreviewableHtml) return;
    if (isPreviewableHtml && !this.shouldEmitInlineHtmlFramePreview(task, payload, rawPath)) {
      return;
    }

    const previewKind = isPreviewableVideo ? "video" : "frame";
    const dedupeKey = `${previewKind}:${normalizedPath}`;
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
        : path.basename(rawPath) || (isPreviewableVideo ? "Generated video" : "Generated frame");
    const quote = (value: string): string => JSON.stringify(value);
    const message = isPreviewableVideo
      ? `Preview ready.\n\n::video{path=${quote(rawPath)} title=${quote(title)}}`
      : `::frame{path=${quote(rawPath)} title=${quote(title)} kind="preview" height="640"}`;

    this.logEvent(taskId, "assistant_message", {
      message,
      internal: true,
      generatedBy: "media_preview",
    });
  }

  private shouldEmitInlineHtmlFramePreview(
    task: Any,
    payload: Record<string, unknown>,
    rawPath: string,
  ): boolean {
    const displayMode =
      typeof payload.display === "string" ? payload.display.trim().toLowerCase() : "";
    if (
      payload.inlineFrame === true ||
      payload.richFrame === true ||
      displayMode === "inline_frame" ||
      displayMode === "rich_frame"
    ) {
      return true;
    }
    if (
      payload.inlineFrame === false ||
      displayMode === "artifact" ||
      displayMode === "artifact_card" ||
      displayMode === "sidebar" ||
      displayMode === "full_page"
    ) {
      return false;
    }

    const taskTitle = typeof task?.title === "string" ? task.title : "";
    const taskPrompt = typeof task?.prompt === "string" ? task.prompt : "";
    const payloadLabel = typeof payload.label === "string" ? payload.label : "";
    const payloadKind = typeof payload.kind === "string" ? payload.kind : "";
    const filename = path.basename(rawPath).toLowerCase();
    const haystack = [taskTitle, taskPrompt, payloadLabel, payloadKind, rawPath]
      .join(" ")
      .toLowerCase();

    const fullPageIntent =
      /\b(landing page|homepage|website|web site|webpage|web page|site design|marketing page|portfolio site|single page app|web app|webapp|frontend app|react app|vite app|next\.?js app|static site|full page|page design|html file|standalone html)\b/.test(
        haystack,
      ) || /(^|[-_/])(index|landing|homepage|website|webpage|site|app|page)\.html?$/.test(filename);
    if (fullPageIntent) return false;

    return /\b(frame|card|widget|panel|summary|scorecard|kpi|metric|dashboard|chart|graph|sparkline|visuali[sz]ation|distribution|breakdown|status|sync|syncing|progress|timeline|monitor|health|debug|trace|log viewer|heatmap|calendar|calculator|simulator|comparison|matrix|table|spending|budget|portfolio|investment|payment|cash[-\s]?flow|forecast|invoice preview|receipt preview)\b/.test(
      haystack,
    );
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
    return this.normalizeProviderTypeValue(
      this.taskRepo.findById(taskId)?.agentConfig?.providerType,
    );
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
      this.rememberTaskLlmProviderType(
        taskId,
        this.getProviderTypeFromLogMessage(payloadObj.message),
      );
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

    // Event-driven captures can run after the executor has paused or finished.
    // Resolve the live task profile here so automatic memory mirroring cannot
    // use stale workspace permissions or bypass a newly gated network mode.
    let effectiveMemoryWorkspace: Workspace | undefined;
    try {
      effectiveMemoryWorkspace = this.getEffectiveWorkspaceForTask(taskId);
    } catch {
      effectiveMemoryWorkspace = undefined;
    }
    const memoryPermissions = effectiveMemoryWorkspace?.permissions;
    const allowExternalMirror = Boolean(
      memoryPermissions?.network === true &&
      memoryPermissions.accessProfileUnavailable !== true &&
      memoryPermissions.accessNetworkMode !== "disabled" &&
      memoryPermissions.accessNetworkMode !== "on-request",
    );
    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace?.path) return;
    const effectiveWorkspace = this.applyTaskWorkspaceOverrides(task, workspace);
    const canRead = (candidatePath: string): boolean =>
      evaluateWorkspaceFilesystemAccess(effectiveWorkspace, candidatePath, "read").decision ===
      "allow";
    const canWrite = (candidatePath: string): boolean =>
      evaluateWorkspaceFilesystemAccess(effectiveWorkspace, candidatePath, "write").decision ===
      "allow";
    const transcriptFilePath = path.join(
      workspace.path,
      ".cowork",
      "memory",
      "transcripts",
      "spans",
      `${task.id}.jsonl`,
    );
    const transcriptDirectory = path.dirname(transcriptFilePath);

    if (
      features.transcriptStoreEnabled &&
      canWrite(transcriptDirectory) &&
      canWrite(transcriptFilePath)
    ) {
      const legacyEvent: TaskEvent = {
        ...timelineEvent,
        type: (legacyType as EventType) || timelineEvent.type,
        payload: legacyPayload,
        legacyType: (legacyType as EventType) || timelineEvent.legacyType,
      };
      await TranscriptStore.appendEvent(workspace.path, legacyEvent).catch(() => undefined);
    }

    const checkpointFilePath = path.join(
      workspace.path,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
      `${task.id}.json`,
    );
    if (
      features.checkpointCaptureEnabled !== false &&
      canWrite(path.dirname(checkpointFilePath)) &&
      canWrite(checkpointFilePath)
    ) {
      await this.maybeCaptureRuntimeCheckpoint({
        task,
        workspacePath: workspace.path,
        event: timelineEvent,
        legacyType,
        legacyPayload,
        readGuard: canRead,
        writeGuard: canWrite,
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

  private getSnapshotSummaryBlock(payload: Record<string, unknown>): string {
    if (
      typeof payload.explicitChatSummaryBlock === "string" &&
      payload.explicitChatSummaryBlock.trim()
    ) {
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

  private parseStructuredCheckpointSummary(
    rawText: string,
    source: "snapshot" | "compaction_summary" | "completion" | "fallback",
  ): {
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

  private buildStructuredCheckpointSummary(
    task: Task,
    snapshotPayload?: Record<string, unknown>,
  ): {
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
      (typeof bestKnownOutcome?.resultSummary === "string" &&
        bestKnownOutcome.resultSummary.trim()) ||
      "";
    if (completionSummary) {
      return this.parseStructuredCheckpointSummary(completionSummary, "completion");
    }

    return this.parseStructuredCheckpointSummary(task.prompt.slice(0, 400), "fallback");
  }

  private buildCheckpointEvidencePacket(
    taskId: string,
    messageEvents: TaskEvent[],
  ): {
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
          event.eventId ||
          event.id ||
          `${taskId}:${typeof event.seq === "number" ? event.seq : event.timestamp}`;
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
    readGuard?: (candidatePath: string) => boolean;
    writeGuard?: (candidatePath: string) => boolean;
  }): Promise<void> {
    const effectiveType =
      typeof params.legacyType === "string" && params.legacyType.trim().length > 0
        ? params.legacyType
        : params.event.type;
    const isMeaningfulExchange = this.isMeaningfulExchangeEvent(
      effectiveType,
      params.legacyPayload,
    );
    if (
      effectiveType !== "conversation_snapshot" &&
      effectiveType !== "task_completed" &&
      !isMeaningfulExchange
    ) {
      return;
    }

    const checkpointDirectory = path.join(
      params.workspacePath,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
    );
    const checkpointPath = path.join(checkpointDirectory, `${params.task.id}.json`);
    if (
      (params.writeGuard &&
        (!params.writeGuard(checkpointDirectory) || !params.writeGuard(checkpointPath))) ||
      (params.readGuard && !params.readGuard(checkpointPath))
    ) {
      return;
    }

    const latestCheckpoint = await TranscriptStore.loadCheckpoint(
      params.workspacePath,
      params.task.id,
      params.readGuard,
    );
    const meaningfulEvents = this.eventRepo
      .findByTaskIdAndTypes(params.task.id, ["user_message", "assistant_message"], 24)
      .filter((event) =>
        this.isMeaningfulExchangeEvent(this.resolveLegacyEventType(event), event.payload),
      )
      .slice(-12);
    const checkpointBaseCount = Math.max(
      0,
      Number(latestCheckpoint?.sourceMetadata?.meaningfulExchangeCount) || 0,
    );
    const checkpointSourceEventId = latestCheckpoint?.sourceEventId?.trim() || "";
    const checkpointTimestamp =
      Number(latestCheckpoint?.sourceTimestamp ?? latestCheckpoint?.timestamp ?? 0) || 0;
    const checkpointCursor = checkpointSourceEventId
      ? this.eventRepo.findEventCursorById(params.task.id, checkpointSourceEventId)
      : latestCheckpoint
        ? { order: checkpointTimestamp, timestamp: checkpointTimestamp, id: "" }
        : null;
    const messagesSinceCheckpoint = checkpointCursor
      ? this.eventRepo
          .findReplayTailAfterCursor(
            params.task.id,
            checkpointCursor,
            ["user_message", "assistant_message"],
            12,
          )
          .filter((event) =>
            this.isMeaningfulExchangeEvent(this.resolveLegacyEventType(event), event.payload),
          ).length
      : meaningfulEvents.length;
    const meaningfulExchangeCount = checkpointBaseCount + messagesSinceCheckpoint;
    const latestSnapshotEvent =
      effectiveType === "conversation_snapshot"
        ? params.event
        : this.eventRepo.findLatestConversationSnapshot(params.task.id);
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

    if (isMeaningfulExchange && meaningfulExchangeCount > 0) {
      const PERIODIC_EXCHANGE_INTERVAL = 12;
      if (meaningfulExchangeCount % PERIODIC_EXCHANGE_INTERVAL === 0) {
        const messageWindow = meaningfulEvents;
        const evidencePacket = this.buildCheckpointEvidencePacket(params.task.id, messageWindow);
        if (
          latestCheckpoint?.checkpointKind === "periodic" &&
          latestCheckpoint?.dedupeHash === evidencePacket.spanHash
        ) {
          return;
        }
        await TranscriptStore.writeCheckpoint(params.workspacePath, params.task.id, {
          ...latestSnapshotPayload,
          checkpointKind: "periodic",
          sourceEventId: params.event.eventId,
          sourceTimestamp: params.event.timestamp,
          resumeStrategy: "checkpoint",
          structuredSummary: this.buildStructuredCheckpointSummary(
            params.task,
            latestSnapshotPayload,
          ),
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
        ...latestSnapshotPayload,
        checkpointKind: "completion",
        sourceEventId: params.event.eventId,
        sourceTimestamp: params.event.timestamp,
        resumeStrategy: "checkpoint",
        structuredSummary: this.buildStructuredCheckpointSummary(
          params.task,
          latestSnapshotPayload,
        ),
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
    const effectiveWorkspace = this.applyTaskWorkspaceOverrides(task, workspace);
    const canRead = (candidatePath: string): boolean =>
      evaluateWorkspaceFilesystemAccess(effectiveWorkspace, candidatePath, "read").decision ===
      "allow";
    const canWrite = (candidatePath: string): boolean =>
      evaluateWorkspaceFilesystemAccess(effectiveWorkspace, candidatePath, "write").decision ===
      "allow";
    this.pendingMemoryConsolidations.add(task.workspaceId);
    setTimeout(() => {
      void (async () => {
        const consolidation = await MemoryConsolidator.run({
          workspaceId: task.workspaceId,
          workspacePath: workspace.path,
          taskId: task.id,
          taskPrompt: task.prompt,
          readGuard: canRead,
          writeGuard: canWrite,
        });
        const pressureInstructions = MemoryPressureService.buildCompactionInstructions(
          await MemoryPressureService.analyze(workspace.path, canRead),
        );
        const dreaming = await new DreamingService(
          new DreamingRepository(this.dbManager.getDatabase()),
        ).run({
          workspaceId: task.workspaceId,
          workspacePath: workspace.path,
          triggerSource: "task_completion",
          sourceTaskId: task.id,
          taskPrompt: task.prompt,
          readGuard: canRead,
          instructions: [
            "Review recent task completion evidence for memory drift, corrections, stale context, and open loops.",
            pressureInstructions,
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
        return { consolidation, dreaming };
      })()
        .then((result) => {
          this.logEvent(task.id, "log", {
            message: result.consolidation.skipped
              ? "Memory consolidation skipped; Dreaming reviewed memory evidence"
              : "Memory consolidation and Dreaming completed",
            consolidation: result.consolidation,
            dreaming: {
              runId: result.dreaming.run.id,
              status: result.dreaming.run.status,
              candidateCount: result.dreaming.candidates.length,
            },
          });
        })
        .catch((error) => {
          this.logEvent(task.id, "error", {
            error: error instanceof Error ? error.message : String(error),
            source: "memory_dreaming",
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
        nextStage === "BUILD" ? Math.max(1, this.queueManager.getStatus().maxConcurrent || 1) : 1,
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

  private maybeMaterializeMailComposeInlineFrame(
    event: TaskEvent,
    effectiveType: string | undefined,
    task: Task | undefined,
  ): void {
    if (effectiveType !== "assistant_message" && effectiveType !== "task_completed") {
      return;
    }
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    if (Array.isArray(payload.inlineFrames) && payload.inlineFrames.length > 0) return;
    if (this.materializedMailComposeFrameTasks.has(event.taskId)) return;
    if (effectiveType === "assistant_message" && payload.internal === true) return;

    const message =
      effectiveType === "task_completed"
        ? typeof payload.resultSummary === "string"
          ? payload.resultSummary
          : ""
        : typeof payload.message === "string"
          ? payload.message
          : "";
    if (!message.trim()) return;

    const sourceTask = task || this.taskRepo.findById(event.taskId);
    const sourceUserMessage = [
      typeof (sourceTask as Any)?.rawPrompt === "string" ? (sourceTask as Any).rawPrompt : "",
      typeof (sourceTask as Any)?.userPrompt === "string" ? (sourceTask as Any).userPrompt : "",
      typeof sourceTask?.prompt === "string" ? sourceTask.prompt : "",
      typeof sourceTask?.title === "string" ? sourceTask.title : "",
    ]
      .filter(Boolean)
      .join("\n");
    const draftInput = extractMailboxComposeDraftInputFromText(message, sourceUserMessage);
    if (!draftInput) return;

    const signature = crypto
      .createHash("sha1")
      .update(
        [event.taskId, effectiveType, draftInput.subject || "", draftInput.bodyText || ""].join(
          "\n",
        ),
      )
      .digest("hex");
    if (this.materializedMailComposeFrameSignatures.has(signature)) return;
    this.materializedMailComposeFrameSignatures.add(signature);
    this.materializedMailComposeFrameTasks.add(event.taskId);

    const mailboxService = getMailboxServiceInstance();
    if (!mailboxService) {
      log.warn("[mail-compose-frame] Mailbox service unavailable while materializing inline frame");
      this.materializedMailComposeFrameSignatures.delete(signature);
      this.materializedMailComposeFrameTasks.delete(event.taskId);
      return;
    }

    void (async () => {
      try {
        const draft = await mailboxService.createMailboxDraft(draftInput);
        const clientState = await mailboxService.getMailboxClientState();
        const account = clientState.accounts.find((candidate) => candidate.id === draft.accountId);
        const frame: ChatInlineFrame = {
          kind: "mail_compose",
          draftId: draft.id,
          accountId: draft.accountId,
          provider: account?.provider || "gmail",
          mode: draft.mode,
          origin: "assistant_generated",
          status: draft.status,
        };
        const nextPayload = {
          ...payload,
          inlineFrames: [frame],
        };
        this.eventRepo.updatePayloadById(event.id, nextPayload);
        this.emitTaskEvent({
          ...event,
          payload: nextPayload,
        });
        log.info(
          `[mail-compose-frame] Materialized compose draft ${draft.id} for task ${event.taskId} from ${effectiveType}`,
        );
      } catch (error) {
        this.materializedMailComposeFrameSignatures.delete(signature);
        this.materializedMailComposeFrameTasks.delete(event.taskId);
        log.warn("[mail-compose-frame] Failed to materialize compose draft:", error);
      }
    })();
  }

  private persistTimelineEvent(
    event: TaskEvent,
    options: {
      legacyType?: string;
      legacyPayload?: Record<string, unknown>;
    } = {},
  ): void {
    const effectiveLegacyType = options.legacyType || event.legacyType;
    const effectiveLegacyPayload =
      options.legacyPayload || (event.payload as Record<string, unknown>);
    const effectiveType = effectiveLegacyType || event.type;

    const storedEvent = this.eventRepo.create({
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
    const storedLegacyPayload = sanitizeTimelinePayloadForStorage(effectiveLegacyPayload) as Record<
      string,
      unknown
    >;

    const task = this.taskRepo.findById(event.taskId);
    try {
      const protocol = (this as Any).workSessionProtocolService as
        | WorkSessionProtocolService
        | undefined;
      protocol?.recordTaskEvent(event.taskId, storedEvent);
    } catch (error) {
      // Keep the legacy TaskEvent stream authoritative while the canonical
      // WorkSession projection rolls out across existing databases.
      log.warn(
        `[work-session-protocol] Failed to dual-write event ${event.id} for task ${event.taskId}:`,
        error,
      );
    }
    try {
      const contracts = (this as Any).workSessionContractService as
        | WorkSessionContractService
        | undefined;
      contracts?.recordTaskEvent(event.taskId, storedEvent);
    } catch (error) {
      // Contract/evidence projections are additive and must not interrupt the
      // legacy timeline or task execution if a migrated database is incomplete.
      log.warn(
        `[work-session-contracts] Failed to project event ${event.id} for task ${event.taskId}:`,
        error,
      );
    }
    try {
      this.sessionProgressService.updateFromEvent(storedEvent);
    } catch (error) {
      // A projection failure must never interrupt task execution or timeline persistence.
      log.warn("[session-progress] Failed to update durable projection:", error);
    }
    this.maybeMaterializeMailComposeInlineFrame(storedEvent, effectiveType, task);
    if (task && effectiveType === "llm_usage") {
      const usagePayload = storedLegacyPayload as {
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
      const errorPayload = storedLegacyPayload as {
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
      this.logActivityForEvent(event.taskId, effectiveLegacyType, storedLegacyPayload);
    } else {
      this.logActivityForEvent(event.taskId, event.type, storedEvent.payload);
    }

    this.emitTaskEvent(storedEvent);

    const teamThoughtEventTypes = new Set([
      "assistant_message",
      "tool_call",
      "step_completed",
      "file_created",
      "file_modified",
    ]);
    if (effectiveLegacyType && teamThoughtEventTypes.has(effectiveLegacyType)) {
      this.maybeEmitTeamThought(event.taskId, effectiveLegacyType, storedLegacyPayload);
    }

    const memoryType = effectiveLegacyType || event.type;
    this.captureToMemory(event.taskId, memoryType, storedLegacyPayload).catch((error) => {
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
    if (taskDisablesMemoryCapture(task)) return;

    let effectiveMemoryWorkspace: Workspace | undefined;
    try {
      effectiveMemoryWorkspace = this.getEffectiveWorkspaceForTask(taskId);
    } catch {
      effectiveMemoryWorkspace = undefined;
    }
    const memoryPermissions = effectiveMemoryWorkspace?.permissions;
    const allowExternalMirror = Boolean(
      memoryPermissions?.network === true &&
      memoryPermissions.accessProfileUnavailable !== true &&
      memoryPermissions.accessNetworkMode !== "disabled" &&
      memoryPermissions.accessNetworkMode !== "on-request",
    );

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
                [],
                { allowExternalMirror },
              ).catch(() => {});
            } catch {
              // best-effort
            }
          }
        }
      } else if (type === "user_feedback") {
        const feedbackDecision =
          typeof payload?.decision === "string" ? payload.decision : undefined;
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
    await MemoryService.capture(task.workspaceId, taskId, memoryType, content, forcePrivate, {
      allowExternalMirror,
    });
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
      case "task_completed": {
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
          typeof payload?.verificationReport === "string" ? payload.verificationReport.trim() : "";
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
            ...payload,
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
            ...payload,
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
            ...payload,
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

      const artifact = this.artifactRepo.create({
        taskId,
        path: filePath,
        mimeType,
        sha256,
        size: stats.size,
        createdAt: Date.now(),
      });
      try {
        this.workSessionContractService.recordArtifact(taskId, artifact);
      } catch (error) {
        log.warn(
          `[work-session-contracts] Failed to record artifact revision for ${taskId}:`,
          error,
        );
      }
      this.sessionProgressService.rebuild(taskId);

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
      const cached = this.activeTasks.get(taskId);
      if (cached) {
        cached.status = "completed";
        cached.lastAccessed = Date.now();
      }
      this.clearTimelineTaskState(taskId);
      this.clearRetryState(taskId);
      if (this.teamOrchestrator && existing?.status !== status) {
        void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
      }
      this.finishQueueSlotIfTracked(taskId);
    }
  }

  beginFollowUpRun(taskId: string): Task | undefined {
    const existing = this.taskRepo.findById(taskId);
    if (!existing) return undefined;

    const currentStatus = deriveCanonicalTaskStatus(existing);
    if (!isTerminalTaskStatus(currentStatus)) {
      this.updateTaskStatus(taskId, "executing");
      return this.taskRepo.findById(taskId);
    }

    this.taskRepo.update(taskId, {
      status: "executing",
      error: undefined,
      completedAt: undefined,
      lastRunDurationMs: undefined,
      terminalStatus: undefined,
      failureClass: undefined,
      awaitingUserInputReasonCode: undefined,
    });
    this.clearRetryState(taskId);
    this.clearTimelineTaskState(taskId);
    this.logEvent(taskId, "task_resumed", {
      message: "Processing follow-up message",
      newRunStarted: true,
      previousStatus: currentStatus,
    });

    return this.taskRepo.findById(taskId);
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

  /**
   * Apply a non-persisted agent configuration override to the policy view of
   * a task. Scheduled/event runs use this so approval checks and the executor
   * see the same profile for the whole turn without rewriting the task's
   * user-selected default.
   */
  setTransientTaskAgentConfig(taskId: string, override?: AgentConfig): void {
    const next = override && typeof override === "object" ? { ...override } : undefined;
    const previous = this.transientAgentConfigOverrides.get(taskId);
    if (authorizationFingerprint(previous || {}) !== authorizationFingerprint(next || {})) {
      // One-shot external grants belong to the authority under which they were
      // issued. Restoring a previous override must not revive its old grants.
      for (const key of this.externalFileApprovalGrants?.keys() || []) {
        if (key.startsWith(`${taskId}:`)) this.externalFileApprovalGrants.delete(key);
      }
    }
    if (!next) {
      this.transientAgentConfigOverrides.delete(taskId);
      return;
    }
    this.transientAgentConfigOverrides.set(taskId, next);
  }

  clearTransientTaskAgentConfig(taskId: string): void {
    this.setTransientTaskAgentConfig(taskId);
  }

  private getTaskWithTransientAgentConfig(task?: Task): Task | undefined {
    if (!task) return undefined;
    const override = this.transientAgentConfigOverrides?.get(task.id);
    if (!override) return task;
    return {
      ...task,
      agentConfig: {
        ...(task.agentConfig || {}),
        ...override,
      },
    };
  }

  private getExternalFileApprovalKey(
    taskId: string,
    rawPath: unknown,
    operation: AccessFilesystemOperation,
  ): string | null {
    const value = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!value) return null;
    const storedTask = this.taskRepo.findById(taskId);
    const task =
      typeof this.getTaskWithTransientAgentConfig === "function"
        ? this.getTaskWithTransientAgentConfig(storedTask)
        : storedTask;
    const storedWorkspace = task ? this.workspaceRepo.findById(task.workspaceId) : undefined;
    const workspace =
      typeof this.getEffectiveWorkspaceForTask === "function"
        ? this.getEffectiveWorkspaceForTask(taskId) || storedWorkspace
        : storedWorkspace;
    let absolutePath: string;
    try {
      absolutePath = resolveAccessControlledPath(workspace?.path || process.cwd(), value);
    } catch {
      absolutePath = path.isAbsolute(value)
        ? value
        : path.resolve(workspace?.path || process.cwd(), value);
    }
    const policyIdentity = authorizationFingerprint({
      policyVersion: process.env.COWORK_ACCESS_POLICY_VERSION || "boundary",
      workspace: workspace && {
        id: workspace.id,
        path: workspace.path,
        permissions: workspace.permissions,
      },
      accessProfileId: task?.agentConfig?.accessProfileId,
      permissionMode: task?.agentConfig?.permissionMode,
      shellAccess: task?.agentConfig?.shellAccess,
      toolRestrictions: task?.agentConfig?.toolRestrictions,
      allowedTools: task?.agentConfig?.allowedTools,
      runtimePolicy: loadPolicies().runtime,
      profiles: task?.agentConfig?.accessProfileId
        ? PermissionSettingsManager.loadSettings().accessProfiles
        : undefined,
    });
    return `${taskId}:${policyIdentity}:${operation}:${canonicalizeAccessPath(absolutePath)}`;
  }

  grantExternalFileApproval(
    taskId: string,
    rawPath: unknown,
    operation: AccessFilesystemOperation = "write",
  ): void {
    const key = this.getExternalFileApprovalKey(taskId, rawPath, operation);
    if (key) this.externalFileApprovalGrants.set(key, Date.now() + 5 * 60 * 1000);
  }

  consumeExternalFileApproval(
    taskId: string,
    rawPath: unknown,
    operation: AccessFilesystemOperation,
  ): boolean {
    const key = this.getExternalFileApprovalKey(taskId, rawPath, operation);
    // A write approval can safely cover a later read of the same file, but it
    // must never authorize deletion. Destructive operations require their own
    // exact one-shot grant.
    const fallbackKey =
      operation === "read" ? this.getExternalFileApprovalKey(taskId, rawPath, "write") : null;
    for (const candidateKey of [key, fallbackKey]) {
      if (!candidateKey) continue;
      const expiresAt = this.externalFileApprovalGrants.get(candidateKey);
      if (!expiresAt) continue;
      this.externalFileApprovalGrants.delete(candidateKey);
      return expiresAt >= Date.now();
    }
    return false;
  }

  private grantExternalFileApprovalsFromDetails(taskId: string, details: Any): void {
    const pathOperations = Array.isArray(details?.pathOperations)
      ? details.pathOperations
          .filter(
            (entry: Any) =>
              entry &&
              typeof entry.path === "string" &&
              ["read", "write", "delete"].includes(entry.operation),
          )
          .map((entry: Any) => ({
            path: entry.path as string,
            operation: entry.operation as AccessFilesystemOperation,
          }))
      : [];
    if (pathOperations.length > 0) {
      for (const entry of pathOperations) {
        this.grantExternalFileApproval(taskId, entry.path, entry.operation);
      }
      return;
    }

    const candidates = new Set<string>();
    if (typeof details?.path === "string") candidates.add(details.path);
    if (Array.isArray(details?.paths)) {
      for (const value of details.paths) {
        if (typeof value === "string") candidates.add(value);
      }
    }
    const params = details?.params;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      for (const key of ["path", "filePath", "targetPath", "destPath", "newPath"]) {
        if (typeof params[key] === "string") candidates.add(params[key]);
      }
    }
    const operation: AccessFilesystemOperation =
      details?.operation === "delete" ? "delete" : details?.operation === "read" ? "read" : "write";
    for (const candidate of candidates) {
      this.grantExternalFileApproval(taskId, candidate, operation);
    }
  }

  private isRunTerminalEvent(event: TaskEvent): boolean {
    const type = this.resolveLegacyEventType(event);
    if (type === "task_completed" || type === "task_cancelled") return true;
    if (type !== "task_status") return false;
    const status =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>).status
        : undefined;
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  private isRunActivityEvent(event: TaskEvent): boolean {
    const type = this.resolveLegacyEventType(event);
    if (
      type === "user_message" ||
      type === "assistant_message" ||
      type === "task_created" ||
      type === "task_completed" ||
      type === "task_cancelled" ||
      type === "task_status"
    ) {
      return false;
    }
    return true;
  }

  private calculateLatestRunDurationMs(
    taskId: string,
    completedAt: number,
    fallbackStartedAt?: number,
    eventsOverride?: TaskEvent[],
  ): number {
    const end = Number.isFinite(completedAt) ? Math.floor(completedAt) : Date.now();
    const events = eventsOverride ?? this.eventRepo.findByTaskId(taskId);

    let previousTerminalAt: number | undefined;
    for (const event of events) {
      const ts =
        typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
          ? event.timestamp
          : undefined;
      if (ts === undefined || ts >= end) continue;
      if (!this.isRunTerminalEvent(event)) continue;
      previousTerminalAt = Math.max(previousTerminalAt ?? 0, ts);
    }

    let latestUserMessageAt: number | undefined;
    for (const event of events) {
      const ts =
        typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
          ? event.timestamp
          : undefined;
      if (ts === undefined || ts > end) continue;
      if (previousTerminalAt !== undefined && ts <= previousTerminalAt) continue;
      if (this.resolveLegacyEventType(event) !== "user_message") continue;
      latestUserMessageAt = Math.max(latestUserMessageAt ?? 0, ts);
    }

    const fallbackStart =
      typeof fallbackStartedAt === "number" && Number.isFinite(fallbackStartedAt)
        ? Math.floor(fallbackStartedAt)
        : end;
    const startedAt = latestUserMessageAt ?? fallbackStart;
    let durationMs = Math.max(0, end - startedAt);

    if (durationMs < 1000) {
      let firstActivityAt: number | undefined;
      let lastActivityAt: number | undefined;
      for (const event of events) {
        const ts =
          typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
            ? event.timestamp
            : undefined;
        if (ts === undefined || ts > end) continue;
        if (previousTerminalAt !== undefined && ts <= previousTerminalAt) continue;
        if (!this.isRunActivityEvent(event)) continue;
        firstActivityAt = Math.min(firstActivityAt ?? ts, ts);
        lastActivityAt = Math.max(lastActivityAt ?? ts, ts);
      }
      if (firstActivityAt !== undefined && lastActivityAt !== undefined) {
        durationMs = Math.max(durationMs, lastActivityAt - firstActivityAt);
      }
    }

    return Math.max(0, Math.floor(durationMs));
  }

  private getTaskEventsForReplay(taskId: string): TaskEvent[] {
    if (!this.completionTelemetryBackfilledTaskIds.has(taskId)) {
      this.backfillTaskCompletionTelemetry(taskId);
      this.completionTelemetryBackfilledTaskIds.add(taskId);
    }
    return this.eventRepo.findByTaskId(taskId);
  }

  private getTaskEventsForResume(
    taskId: string,
    workspacePath: string,
    readGuard?: (candidatePath: string) => boolean,
  ): TaskEvent[] {
    const startedAt = Date.now();
    const checkpoint = TranscriptStore.loadCheckpointSync(workspacePath, taskId, readGuard);
    const snapshot = checkpoint ? null : this.eventRepo.findLatestConversationSnapshot(taskId);
    const planDefinitionEvents = this.eventRepo.findByTaskIdAndTypes(
      taskId,
      [...RESUME_PLAN_DEFINITION_EVENT_TYPES],
      1,
    );
    const planStateEvents = this.eventRepo.findByTaskIdAndTypes(
      taskId,
      [...RESUME_PLAN_STATE_EVENT_TYPES],
      MAX_RESUME_PLAN_STATE_EVENTS,
    );

    let boundaryCursor: TaskTimelinePageCursor | null = null;
    if (checkpoint) {
      const sourceEventId =
        typeof checkpoint.sourceEventId === "string" ? checkpoint.sourceEventId.trim() : "";
      boundaryCursor = sourceEventId
        ? this.eventRepo.findEventCursorById(taskId, sourceEventId)
        : null;
      if (!boundaryCursor) {
        const timestamp = Number(checkpoint.sourceTimestamp ?? checkpoint.timestamp ?? 0) || 0;
        boundaryCursor = { order: timestamp, timestamp, id: "" };
      }
    } else if (snapshot) {
      boundaryCursor = {
        order: Number(snapshot.seq ?? snapshot.ts ?? snapshot.timestamp) || 0,
        timestamp: Number(snapshot.timestamp) || 0,
        id: snapshot.id,
      };
    }

    const tailEvents = boundaryCursor
      ? this.eventRepo.findReplayTailAfterCursor(
          taskId,
          boundaryCursor,
          [...RESUME_STATE_EVENT_TYPES],
          MAX_RESUME_TAIL_EVENTS,
        )
      : this.eventRepo.findByTaskIdAndTypes(
          taskId,
          [...RESUME_STATE_EVENT_TYPES],
          MAX_RESUME_TAIL_EVENTS,
        );
    const events = [
      ...(snapshot ? [snapshot] : []),
      ...planDefinitionEvents,
      ...planStateEvents,
      ...tailEvents,
    ];
    const uniqueEvents = Array.from(
      new Map(events.map((event) => [event.eventId || event.id, event])).values(),
    ).sort((a, b) => {
      const aOrder = Number(a.seq ?? a.ts ?? a.timestamp) || 0;
      const bOrder = Number(b.seq ?? b.ts ?? b.timestamp) || 0;
      return aOrder - bOrder || a.timestamp - b.timestamp || a.id.localeCompare(b.id);
    });
    log.info("[TaskResumeReplay]", {
      taskId,
      source: checkpoint ? "checkpoint" : snapshot ? "snapshot" : "legacy_bounded",
      checkpointTimestamp: checkpoint?.timestamp,
      snapshotTimestamp: snapshot?.timestamp,
      boundaryCursor,
      eventCount: uniqueEvents.length,
      dbMs: Date.now() - startedAt,
    });
    return uniqueEvents;
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
    const normalizedTypes = (options?.types || [])
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter(Boolean);
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.min(Math.max(options.limit, 1), 200)
        : undefined;
    const legacyRead = (): TaskEvent[] => {
      if (normalizedTypes.length > 0) {
        return this.eventRepo.findByTaskIdAndTypes(taskId, normalizedTypes, limit);
      }
      if (typeof limit === "number") {
        return this.eventRepo.findRecentByTaskId(taskId, limit);
      }
      return this.eventRepo.findByTaskId(taskId);
    };
    const protocol = (this as Any).workSessionProtocolService as
      | WorkSessionProtocolService
      | undefined;
    if (typeof protocol?.readTaskEvents === "function") {
      return protocol.readTaskEvents(taskId, { limit, types: normalizedTypes }, legacyRead);
    }
    return legacyRead();
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
  updateTaskWorkspace(taskId: string, workspaceId: string): Task {
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    this.taskRepo.update(taskId, { workspaceId });
    const updatedTask = this.taskRepo.findById(taskId);
    if (!updatedTask) {
      throw new Error(`Task ${taskId} not found after workspace update`);
    }

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.executor.updateTaskWorkspace(
        updatedTask,
        this.applyTaskWorkspaceOverridesForPath(
          updatedTask,
          workspace,
          cached.executor.getWorkspace?.().path ||
            (updatedTask.worktreeStatus === "active" ? updatedTask.worktreePath : undefined),
        ),
      );
      cached.lastAccessed = Date.now();
      cached.status = "active";
    }

    this.logEvent(taskId, "log", {
      message: `Workspace changed to "${workspace.name}" (${workspace.path}).`,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
    });

    return updatedTask;
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
   * Enforce the task's effective access profile for a filesystem-backed
   * operation. This evaluates against the persisted workspace root: a task
   * worktree is a child of that root and must not become a way to escape the
   * profile's base/worktree boundary.
   */
  assertTaskWorkspaceFilesystemAccess(
    taskId: string,
    rawPath: string,
    operation: AccessFilesystemOperation,
    label = "path",
  ): string {
    const effectiveWorkspace = this.getEffectiveWorkspaceForTask(taskId);
    if (!effectiveWorkspace) {
      const task = this.taskRepo.findById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      throw new Error(`Workspace not found: ${task.workspaceId}`);
    }
    return assertWorkspaceFilesystemAccess(effectiveWorkspace, rawPath, operation, label);
  }

  /**
   * Validate the repository used for an explicit Git promotion operation.
   * Worktree tasks intentionally do not receive this path as a generic
   * `accessWorkspaceRoots` entry; only Git merge/PR flows may use it.
   */
  assertTaskBaseWorkspaceFilesystemAccess(
    taskId: string,
    rawPath: string,
    operation: AccessFilesystemOperation,
    label = "base repository path",
  ): string {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const baseWorkspace = this.workspaceRepo.findById(task.workspaceId);
    if (!baseWorkspace) throw new Error(`Workspace not found: ${task.workspaceId}`);
    const effectiveBaseWorkspace = this.applyTaskWorkspaceOverrides(task, baseWorkspace);
    return assertWorkspaceFilesystemAccess(effectiveBaseWorkspace, rawPath, operation, label);
  }

  /**
   * Update workspace permissions and return the refreshed workspace.
   */
  updateWorkspacePermissions(
    workspaceId: string,
    patch: Omit<Partial<WorkspacePermissions>, "shell">,
  ): Workspace | undefined {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) return undefined;
    // The public workspace-permission API no longer exposes shell as a
    // mutable workspace switch. Keep the legacy field readable for old task
    // records, but ignore it even if an older renderer sends it at runtime.
    const { shell: _legacyShell, ...profilePatch } = patch as Partial<WorkspacePermissions>;
    const updatedPermissions: WorkspacePermissions = {
      ...workspace.permissions,
      ...profilePatch,
    };
    this.workspaceRepo.updatePermissions(workspaceId, updatedPermissions);
    const refreshed = this.workspaceRepo.findById(workspaceId);
    this.refreshActiveExecutorsForWorkspace(workspaceId);
    return refreshed;
  }

  /**
   * Refresh active task executors that use the given workspace.
   * Called when a legacy workspace permission changes so executors pick up new
   * tool availability. Named access profiles are the primary task-level control.
   */
  refreshActiveExecutorsForWorkspace(workspaceId: string): void {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) return;

    let refreshed = 0;
    this.activeTasks.forEach((cached, taskId) => {
      if (cached.status !== "active" || !cached.executor) return;
      if (cached.executor.getWorkspaceId?.() !== workspaceId) return;
      try {
        const task = this.taskRepo.findById(taskId);
        if (!task) return;
        cached.executor.updateWorkspace(
          this.applyTaskWorkspaceOverridesForPath(
            task,
            workspace,
            cached.executor.getWorkspace?.().path,
          ),
        );
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

  /** Refresh every active executor after access-profile settings change. */
  refreshActiveExecutorsForAccessProfiles(): void {
    let refreshed = 0;
    this.activeTasks.forEach((cached, taskId) => {
      if (cached.status !== "active" || !cached.executor) return;
      const task = this.taskRepo.findById(taskId);
      if (!task) return;
      const workspace = this.workspaceRepo.findById(task.workspaceId);
      if (!workspace) return;
      try {
        cached.executor.updateWorkspace(
          this.applyTaskWorkspaceOverridesForPath(
            task,
            workspace,
            cached.executor.getWorkspace?.().path,
          ),
        );
        refreshed++;
      } catch (err) {
        console.warn(`[AgentDaemon] Failed to refresh access profile for task ${taskId}:`, err);
      }
    });
    if (refreshed > 0) {
      console.log(`[AgentDaemon] Refreshed ${refreshed} active executor(s) for access profiles`);
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
        | "lastRunDurationMs"
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
        | "agentConfig"
        | "rawPrompt"
        | "userPrompt"
      >
    >,
  ): void {
    const existing = this.taskRepo.findById(taskId);
    const currentStatus = existing ? deriveCanonicalTaskStatus(existing) : undefined;
    if (
      isTerminalTaskStatus(currentStatus) &&
      updates.status &&
      !isTerminalTaskStatus(updates.status)
    ) {
      return;
    }
    this.taskRepo.update(taskId, updates);
    if (
      updates.status === "completed" ||
      updates.status === "failed" ||
      updates.status === "cancelled"
    ) {
      this.clearRetryState(taskId);
      const cached = this.activeTasks.get(taskId);
      if (cached) {
        cached.status = "completed";
        cached.lastAccessed = Date.now();
      }
      if (this.teamOrchestrator && existing?.status !== updates.status) {
        void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
      }
      this.finishQueueSlotIfTracked(taskId);
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

    this.cleanupPendingApprovalsForTask(
      taskId,
      "Task ended before the approval request was resolved.",
    );

    const completedAt = metadata?.completedAt ?? Date.now();
    const lastRunDurationMs = this.calculateLatestRunDurationMs(
      taskId,
      completedAt,
      existingTask?.createdAt,
    );
    const terminalStatus = metadata?.terminalStatus ?? "failed";
    const updates: Partial<Task> = {
      status: "failed",
      error: errorMessage,
      completedAt,
      lastRunDurationMs,
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
      ...(metadata?.compactionCount !== undefined
        ? { compactionCount: metadata.compactionCount }
        : {}),
      ...(metadata?.lastCompactionAt !== undefined
        ? { lastCompactionAt: metadata.lastCompactionAt }
        : {}),
      ...(metadata?.lastCompactionTokensBefore !== undefined
        ? { lastCompactionTokensBefore: metadata.lastCompactionTokensBefore }
        : {}),
      ...(metadata?.lastCompactionTokensAfter !== undefined
        ? { lastCompactionTokensAfter: metadata.lastCompactionTokensAfter }
        : {}),
      ...(metadata?.noProgressStreak !== undefined
        ? { noProgressStreak: metadata.noProgressStreak }
        : {}),
      ...(metadata?.lastLoopFingerprint !== undefined
        ? { lastLoopFingerprint: metadata.lastLoopFingerprint }
        : {}),
      ...(metadata?.bestKnownOutcome !== undefined
        ? { bestKnownOutcome: metadata.bestKnownOutcome }
        : {}),
      ...(typeof metadata?.semanticSummary === "string" &&
      metadata.semanticSummary.trim().length > 0
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
      lastRunDurationMs,
      ...(typeof metadata?.resultSummary === "string" && metadata.resultSummary.trim().length > 0
        ? { resultSummary: metadata.resultSummary.trim() }
        : {}),
      ...(metadata?.failureClass ? { failureClass: metadata.failureClass } : {}),
      ...(metadata?.bestKnownOutcome !== undefined
        ? { bestKnownOutcome: metadata.bestKnownOutcome }
        : {}),
      ...(metadata?.budgetUsage !== undefined ? { budgetUsage: metadata.budgetUsage } : {}),
      ...(typeof metadata?.semanticSummary === "string" &&
      metadata.semanticSummary.trim().length > 0
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

    this.cleanupPendingApprovalsForTask(
      taskId,
      "Task ended before the approval request was resolved.",
    );

    const completedAt = metadata?.completedAt ?? Date.now();
    const lastRunDurationMs = this.calculateLatestRunDurationMs(
      taskId,
      completedAt,
      existing?.createdAt,
    );
    const errorMessage =
      metadata && Object.prototype.hasOwnProperty.call(metadata, "errorMessage")
        ? metadata.errorMessage
        : null;

    this.taskRepo.update(taskId, {
      status: "cancelled",
      completedAt,
      lastRunDurationMs,
      error: errorMessage,
      terminalStatus: undefined,
      failureClass: undefined,
    });
    this.clearRetryState(taskId);

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.status = "completed";
      cached.lastAccessed = Date.now();
    }

    this.logEvent(taskId, "task_status", {
      status: "cancelled",
      message,
      lastRunDurationMs,
      ...(typeof errorMessage === "string" && errorMessage.trim().length > 0
        ? { error: errorMessage }
        : {}),
    });
    this.logEvent(taskId, "task_cancelled", {
      message,
    });

    this.clearTimelineTaskState(taskId);

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
    if (
      params.explicitEvidenceRequired &&
      params.riskReasons.includes("tests_expected_without_evidence")
    ) {
      issues.push("tests_expected_without_execution_evidence");
    }
    if (params.explicitEvidenceRequired && params.verificationEvidenceBundle) {
      const hasSuccessfulVerificationEvidence = params.verificationEvidenceBundle.entries.some(
        (entry) => entry.ok,
      );
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
      typeof a.seq === "number" && Number.isFinite(a.seq) && a.seq > 0
        ? Math.floor(a.seq)
        : undefined;
    const bSeq =
      typeof b.seq === "number" && Number.isFinite(b.seq) && b.seq > 0
        ? Math.floor(b.seq)
        : undefined;
    if (typeof aSeq === "number" && typeof bSeq === "number" && aSeq !== bSeq) {
      return aSeq - bSeq;
    }
    const aTs = typeof a.ts === "number" && Number.isFinite(a.ts) ? a.ts : Number(a.timestamp) || 0;
    const bTs = typeof b.ts === "number" && Number.isFinite(b.ts) ? b.ts : Number(b.timestamp) || 0;
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
          String(payloadObj.message || "")
            .toLowerCase()
            .includes("out-of-order"))
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
        if (
          !activeSteps.has(stepId) &&
          event.status !== "failed" &&
          !shouldIgnoreUnstartedMismatch
        ) {
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
        payloadObj.telemetry &&
        typeof payloadObj.telemetry === "object" &&
        !Array.isArray(payloadObj.telemetry)
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
    const splitTableRows = (block: string): string[] => {
      const pieces: string[] = [];
      let proseLines: string[] = [];
      const flushProse = () => {
        if (proseLines.length > 0) pieces.push(proseLines.join("\n"));
        proseLines = [];
      };

      for (const line of block.split(/\r?\n/)) {
        if (!/^\s*\|.*\|\s*$/.test(line)) {
          proseLines.push(line);
          continue;
        }

        flushProse();
        if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) continue;
        pieces.push(
          line
            .split("|")
            .map((cell) => cell.trim())
            .filter(Boolean)
            .join(" | "),
        );
      }
      flushProse();
      return pieces;
    };
    const pieces = trimmed
      .split(/(?=^\s*(?:[-*+]|\d+[.)])\s+)/m)
      .flatMap(splitTableRows)
      .flatMap((piece) => piece.split(/(?<=[.!?])\s+/))
      .map((piece) => normalizePiece(piece))
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
    taskEvents?: TaskEvent[],
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

    const evidenceEvents =
      taskEvents ??
      (typeof this.getTaskEventsForReplay === "function"
        ? this.getTaskEventsForReplay(taskId)
        : []);
    if (this.hasMatchingFileReadEvidenceForKeyClaims(keyClaims, evidenceEvents, text)) {
      return { passed: true, keyClaims };
    }

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

  private hasMatchingFileReadEvidenceForKeyClaims(
    keyClaims: string[],
    events: TaskEvent[],
    summary: string,
  ): boolean {
    if (keyClaims.length === 0 || events.length === 0) return false;

    const asRecord = (value: unknown): Record<string, unknown> =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const successfulReads: Array<{
      path: string;
      content: string;
      size?: number;
    }> = [];

    for (const event of events) {
      if (this.resolveLegacyEventType(event) !== "tool_result" || event.status === "failed") {
        continue;
      }

      const payload = asRecord(event.payload);
      const envelope = asRecord(payload.envelope);
      const toolName =
        (typeof envelope.toolName === "string" && envelope.toolName) ||
        (typeof payload.tool === "string" && payload.tool) ||
        "";
      if (toolName !== "read_file") continue;
      if (typeof envelope.status === "string" && envelope.status !== "success") continue;

      const structuredData = asRecord(envelope.structuredData);
      const result =
        Object.keys(structuredData).length > 0 ? structuredData : asRecord(payload.result);
      if (result.__coworkPayloadTruncated === true || typeof result.content !== "string") continue;

      const window = asRecord(result.window);
      const startsAtBeginning = typeof window.start !== "number" || window.start === 0;
      const reachesEnd =
        typeof window.end !== "number" ||
        typeof window.total !== "number" ||
        window.end >= window.total;
      if (result.truncated === true || !startsAtBeginning || !reachesEnd) continue;

      successfulReads.push({
        path: typeof result.path === "string" ? result.path : "",
        content: result.content,
        size:
          typeof result.size === "number" && Number.isFinite(result.size)
            ? result.size
            : typeof window.total === "number" && Number.isFinite(window.total)
              ? window.total
              : undefined,
      });
    }

    if (successfulReads.length === 0) return false;

    const citedReads = successfulReads.filter((read) => {
      if (!read.path) return false;
      const normalizedPath = read.path.replace(/\\/g, "/");
      const basename = path.basename(normalizedPath);
      return Boolean(basename && (summary.includes(normalizedPath) || summary.includes(basename)));
    });
    const hasCitedSourceLiteralsForClaim = (claim: string): boolean => {
      if (citedReads.length === 0) return false;
      const quotedValues = Array.from(
        claim.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g),
        (match) => match[1] || match[2] || match[3] || "",
      ).filter(Boolean);
      const hasDistinctiveLiteral = quotedValues.some(
        (value) => value.trim().length >= 4 || /[^\w\s]/.test(value),
      );
      if (quotedValues.length === 0 || !hasDistinctiveLiteral) return false;

      return quotedValues.every((value) =>
        citedReads.some((read) => read.content.includes(value)),
      );
    };

    return keyClaims.every((claim) => {
      // A quoted substring cannot establish an exact readback or its byte count.
      const requiresExactReadback = /\bexactly\b|\b[\d,]+\s*bytes?\b/i.test(claim);
      if (!requiresExactReadback && hasCitedSourceLiteralsForClaim(claim)) return true;

      const hasFileReference =
        /\b(?:file|document|report|text|contents?|read[ -]?back)\b/i.test(claim) ||
        /\bit\s+(?:contains?|includes?|is|was)\b/i.test(claim);
      if (hasFileReference) {
        const byteMatch = claim.match(/\b([\d,]+)\s*bytes?\b/i);
        const claimedByteCount = byteMatch ? Number(byteMatch[1].replace(/,/g, "")) : undefined;
        const quotedValues = Array.from(
          claim.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g),
          (match) => match[1] || match[2] || match[3] || "",
        ).filter(Boolean);

        if (claimedByteCount !== undefined || quotedValues.length > 0) {
          const exactContentClaim = /\bexactly\b/i.test(claim);
          const contentHasOneTrailingNewline =
            /\b(?:followed by|with|ending in|ends? in)\s+(?:exactly\s+)?(?:one|a single|a)\s+(?:trailing\s+)?newline\b/i.test(
              claim,
            );
          const matchesReadback = successfulReads.some((read) => {
            const readPaths = [read.path, path.basename(read.path)].filter(Boolean);
            const contentLiterals = quotedValues.filter(
              (value) =>
                !readPaths.some((readPath) => value.toLowerCase() === readPath.toLowerCase()),
            );
            if (
              contentLiterals.some((literal) =>
                exactContentClaim
                  ? read.content !== (contentHasOneTrailingNewline ? `${literal}\n` : literal)
                  : !read.content.includes(literal),
              )
            ) {
              return false;
            }
            if (claimedByteCount !== undefined && read.size !== claimedByteCount) return false;
            return contentLiterals.length > 0 || claimedByteCount !== undefined;
          });
          if (matchesReadback) return true;
        }
      }

      return this.hasVerifiedDerivedCalculationForKeyClaim(claim, successfulReads);
    });
  }

  private hasVerifiedDerivedCalculationForKeyClaim(
    claim: string,
    reads: Array<{ path: string; content: string; size?: number }>,
  ): boolean {
    const equalsIndex = claim.indexOf("=");
    if (equalsIndex < 0) return false;

    const rightSide = claim.slice(equalsIndex + 1);
    const reportedMatch = rightSide.match(/^\s*(-?[\d,]+(?:\.\d+)?)\s*(%)?/);
    if (!reportedMatch) return false;

    const reportedValue = Number(reportedMatch[1].replace(/,/g, ""));
    const leftSide = claim
      .slice(0, equalsIndex)
      .replace(/[−–]/g, "-")
      .replace(/[×·]/g, "*")
      .replace(/÷/g, "/");
    const sourceNumbers = new Set(
      reads.flatMap((read) => {
        const plainNumbers = Array.from(read.content.matchAll(/-?\d+(?:\.\d+)?/g), (match) =>
          String(Number(match[0])),
        );
        const groupedNumbers = Array.from(
          read.content.matchAll(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?/g),
          (match) => String(Number(match[0].replace(/,/g, ""))),
        );
        return [...plainNumbers, ...groupedNumbers];
      }),
    );

    const parseExpression = (
      expression: string,
    ): { value: number; operands: number[] } | undefined => {
      const normalized = expression.replace(/,/g, "").replace(/\s+/g, "");
      const tokens = normalized.match(/\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
      if (tokens.join("") !== normalized || tokens.length === 0) return undefined;

      let cursor = 0;
      const operands: number[] = [];
      const parseFactor = (): number | undefined => {
        const token = tokens[cursor];
        if (token === "+" || token === "-") {
          cursor += 1;
          const value = parseFactor();
          return value === undefined ? undefined : token === "-" ? -value : value;
        }
        if (token === "(") {
          cursor += 1;
          const value = parseSum();
          if (value === undefined || tokens[cursor] !== ")") return undefined;
          cursor += 1;
          return value;
        }
        if (token === undefined || !/^\d/.test(token)) return undefined;
        cursor += 1;
        const value = Number(token);
        operands.push(value);
        return value;
      };
      const parseProduct = (): number | undefined => {
        let value = parseFactor();
        if (value === undefined) return undefined;
        while (tokens[cursor] === "*" || tokens[cursor] === "/") {
          const operator = tokens[cursor++];
          const right = parseFactor();
          if (right === undefined || (operator === "/" && right === 0)) return undefined;
          value = operator === "*" ? value * right : value / right;
        }
        return value;
      };
      const parseSum = (): number | undefined => {
        let value = parseProduct();
        if (value === undefined) return undefined;
        while (tokens[cursor] === "+" || tokens[cursor] === "-") {
          const operator = tokens[cursor++];
          const right = parseProduct();
          if (right === undefined) return undefined;
          value = operator === "+" ? value + right : value - right;
        }
        return value;
      };

      const value = parseSum();
      if (value === undefined || cursor !== tokens.length || !Number.isFinite(value))
        return undefined;
      return { value, operands };
    };

    let parsed: { value: number; operands: number[] } | undefined;
    for (let start = 0; start < leftSide.length; start += 1) {
      if (!/[\d(+-]/.test(leftSide[start])) continue;
      const candidate = parseExpression(leftSide.slice(start));
      if (candidate && /[+\-*/]/.test(leftSide.slice(start))) {
        parsed = candidate;
        break;
      }
    }
    if (!parsed || parsed.operands.length < 2) return false;

    const isPercentageScale = Boolean(reportedMatch[2]) && /\*\s*100\s*$/.test(leftSide);
    const sourceOperands = isPercentageScale ? parsed.operands.slice(0, -1) : parsed.operands;
    if (
      sourceOperands.length === 0 ||
      sourceOperands.some((operand) => !sourceNumbers.has(String(operand)))
    ) {
      return false;
    }

    const decimalPlaces = (reportedMatch[1].split(".")[1] ?? "").length;
    const roundingTolerance =
      0.5 * 10 ** -decimalPlaces + Math.max(1, Math.abs(parsed.value)) * 1e-10;
    return Math.abs(parsed.value - reportedValue) <= roundingTolerance;
  }

  private async runPostCompletionVerification(
    parentTask: Task,
    parentSummary?: string,
    verificationEvidenceBundle?: TaskVerificationEvidenceBundle,
    timeoutMs = 120_000,
    gateContext: { explicit?: boolean; highRisk?: boolean; outputSummary?: TaskOutputSummary } = {},
  ): Promise<VerificationRuntimeResult | undefined> {
    if (parentTask.parentTaskId || (parentTask.agentType ?? "main") !== "main") {
      return undefined;
    }
    const currentDepth = parentTask.depth ?? 0;
    if (currentDepth >= 3) {
      const result: VerificationRuntimeResult = {
        gated: true,
        ran: false,
        status: "missing",
        verdict: "FAIL",
        report: "Independent verification could not run: task depth limit reached.",
        shouldBlock: true,
      };
      this.logEvent(parentTask.id, "verification_failed", {
        source: "post_completion_review_gate",
        message: result.report,
        verificationVerdict: result.verdict,
      });
      return result;
    }

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
      ...gateContext,
    });
    if (!result.gated) return result;

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

    return result;
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
    terminalStatus?: Task["terminalStatus"];
    summary: string;
  }> {
    const timeoutMs = params.timeoutMs ?? 120_000;
    const currentDepth = params.parentTask.depth ?? 0;
    const workerRole = resolveWorkerRoleKind(params.workerRole) || resolveDefaultWorkerRoleKind();
    const childAgentConfig: AgentConfig = {
      autonomousMode: true,
      allowUserInput: false,
      retainMemory: false,
      conversationMode: "task",
      verificationAgent: false,
      toolRestrictions: ["group:write", "delete_file", "group:image"],
      ...params.agentConfig,
      // This is deliberately assigned after caller input. The helper's
      // read-only contract must survive role/config overrides and retain the
      // caller's actual worker prompt (for example researcher for entropy).
      readOnlyExecution: true,
    };
    // Keep the helper's contract explicit at the call boundary as well as in
    // createChildTask/worker-role-registry. Fresh shell/build commands are
    // intentionally unavailable; read-only children consume supplied
    // evidence while retaining their requested role prompt.
    childAgentConfig.permissionMode = "plan";
    childAgentConfig.shellAccess = false;
    delete childAgentConfig.externalRuntime;
    const restrictions = new Set(childAgentConfig.toolRestrictions || []);
    for (const entry of getReadOnlyExecutionToolRestrictions()) {
      restrictions.add(entry);
    }
    childAgentConfig.toolRestrictions = Array.from(restrictions);
    const childTask = await this.createChildTask({
      title: params.title,
      prompt: params.prompt,
      workspaceId: params.parentTask.workspaceId,
      parentTaskId: params.parentTask.id,
      agentType: "sub",
      depth: currentDepth + 1,
      agentConfig: childAgentConfig,
      workerRole,
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
      if (
        child.status === "completed" ||
        child.status === "failed" ||
        child.status === "cancelled"
      ) {
        return {
          childTaskId: childTask.id,
          status: child.status,
          terminalStatus: child.terminalStatus,
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
  async completeTask(
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
      failedStepIds?: string[];
      incompleteStepIds?: string[];
      terminalKind?: TerminalKind;
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
      /**
       * Plan step failures that the executor explicitly recovered via a
       * completed alternate/recovery step. These are not silent waivers: the
       * original failure remains in the timeline, but must not block the final
       * completion gate once the recovery path has succeeded.
       */
      recoveredFailedStepIds?: string[];
      semanticSummary?: string;
      verificationVerdict?: VerificationVerdict;
      verificationReport?: string;
      agentConfig?: AgentConfig;
    },
  ): Promise<void> {
    const existingTask = this.taskRepo.findById(taskId);
    if (!existingTask) {
      console.warn(`[AgentDaemon] completeTask called for unknown task ${taskId}`);
      return;
    }
    // Bot conversations have a second completion contract: a terminal-looking
    // task row is not authoritative until every durable teammate handoff has
    // either received a correlated reply or reached a terminal delivery state.
    // Reconcile before the generic terminal short-circuit because an older
    // runtime could persist `completed` before the handoff gate ran.
    const historicalEvents = this.getTaskEventsForReplay(taskId);
    let botHandoffCompletion: { deferred: boolean; replySent: boolean } = {
      deferred: false,
      replySent: false,
    };
    if (existingTask.agentConfig?.botConversation === true) {
      botHandoffCompletion = this.reconcileBotHandoffBeforeCompletion(
        existingTask,
        historicalEvents,
        typeof resultSummary === "string" && resultSummary.trim().length > 0
          ? resultSummary.trim()
          : undefined,
      );
      if (botHandoffCompletion.deferred) return;
    }
    const currentStatus = deriveCanonicalTaskStatus(existingTask);
    if (isTerminalTaskStatus(currentStatus)) {
      return;
    }

    this.cleanupPendingApprovalsForTask(
      taskId,
      "Task ended before the approval request was resolved.",
    );

    const isChatSession =
      existingTask.agentConfig?.executionMode === "chat" &&
      existingTask.agentConfig?.executionModeSource === "user";
    if (isChatSession) {
      const completedAt = Date.now();
      const lastRunDurationMs = this.calculateLatestRunDurationMs(
        taskId,
        completedAt,
        existingTask.createdAt,
      );
      this.taskRepo.update(taskId, {
        status: "completed",
        completedAt,
        lastRunDurationMs,
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
        lastRunDurationMs,
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
    const trimmedSummary =
      typeof resultSummary === "string" && resultSummary.trim().length > 0
        ? resultSummary.trim()
        : undefined;
    const bestKnownOutcome = metadata?.bestKnownOutcome || getTaskBestKnownOutcome(existingTask);
    const unresolvedFailedSteps = this.getUnresolvedFailedSteps(taskId);
    const timelineErrorStepIds = Array.from(
      this.timelineErrorsByTask.get(taskId) || new Set<string>(),
    )
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
    const recoveredFailedStepIds = new Set(
      (metadata?.recoveredFailedStepIds || [])
        .map((id) => String(id || "").trim())
        .filter((id) => id.length > 0),
    );
    // Executor recovery state is tracked in memory, while this completion
    // gate tracks failures from the persisted timeline. Match by normalized
    // step ID so `step:foo` and `foo` resolve the same recovered failure.
    const recoveredResolvedStepIds = unresolvedFailedSteps.filter((failedStepId) => {
      const normalizedFailedStepId = normalizeStepIdForComparison(failedStepId);
      return Array.from(recoveredFailedStepIds).some(
        (recoveredStepId) =>
          recoveredStepId === failedStepId ||
          normalizeStepIdForComparison(recoveredStepId) === normalizedFailedStepId,
      );
    });
    for (const stepId of recoveredResolvedStepIds) {
      waivedFailedStepIds.add(stepId);
    }
    const waivedNormalizedStepIds = new Set(
      Array.from(waivedFailedStepIds.values()).map((id) => normalizeStepIdForComparison(id)),
    );

    if (recoveredResolvedStepIds.length > 0) {
      this.logEvent(taskId, "timeline_step_updated", {
        stepId: "completion_gate:recovered_failures",
        status: "completed",
        actor: "system",
        message: `Resolved ${recoveredResolvedStepIds.length} failed step(s) via completed recovery steps.`,
        recoveredFailedStepIds: recoveredResolvedStepIds,
        gate: "completion_failed_step_gate",
        legacyType: "progress_update",
      });
    }
    const failedMutationRequiredStepIds = new Set(
      (metadata?.failedMutationRequiredStepIds || [])
        .map((id) => String(id || "").trim())
        .filter((id) => id.length > 0),
    );
    const failedMutationRequiredNormalizedStepIds = new Set(
      Array.from(failedMutationRequiredStepIds.values()).map((id) =>
        normalizeStepIdForComparison(id),
      ),
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
          if (
            String(step?.kind || "")
              .trim()
              .toLowerCase() === "verification"
          ) {
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
      (metadata?.waiveFailedStepIds || []).length === 0;
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
      blockingFailedSteps = blockingFailedSteps.filter(
        (id) => !autoWaivedVerificationStepIds.includes(id),
      );
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
      blockingFailedSteps = blockingFailedSteps.filter(
        (id) => !autoWaivedBudgetStepIds.includes(id),
      );
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
      blockingFailedSteps = blockingFailedSteps.filter(
        (id) => !autoWaivedEvidenceBackedStepIds.has(id),
      );
    }
    blockingFailedSteps = Array.from(
      new Set(
        blockingFailedSteps.map((id) => String(id || "").trim()).filter((id) => id.length > 0),
      ),
    );

    // Best-effort / wrap-up auto-waive: when the executor explicitly finalized the task
    // via a soft deadline / wrap-up / best-effort path (not a hard failure), waive any
    // non-mutation-required blocking steps so the task can complete as partial_success
    // rather than being hard-blocked by the completion gate.
    const bestEffortReasons = [
      "best_effort",
      "Soft deadline",
      "soft deadline",
      "soft-deadline",
      "Timeout recovery",
      "Step timeout detected",
      "Wrap-up",
      "executor_best_effort_finalized",
      "No team member analyses available for synthesis",
    ];
    const terminalStatusReason = metadata?.terminalStatusReason ?? "";
    const isBestEffortFinalization =
      (metadata?.terminalKind === "timed_out" ||
        bestEffortReasons.some((r) => terminalStatusReason.includes(r))) &&
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
        blockingFailedSteps = blockingFailedSteps.filter((id) => !nonMutationBlockers.includes(id));
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
    if (botHandoffCompletion.replySent) {
      terminalStatus = "partial_success";
      failureClass = "contract_error";
    }
    if (metadata?.terminalKind === "failed" && terminalStatus !== "failed") {
      terminalStatus = "failed";
    }
    const explicitFailedTerminalStatus = terminalStatus === "failed";
    if (
      this.verificationOutcomeV2Enabled &&
      metadata?.verificationOutcome === "pending_user_action"
    ) {
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
        if (!explicitFailedTerminalStatus) {
          terminalStatus = "partial_success";
          failureClass = "contract_error";
        } else if (!failureClass) {
          failureClass = "unknown";
        }
      }
    }

    const evidenceCheck = this.hasEvidenceForKeyClaims(
      taskId,
      trimmedSummary,
      metadata?.verificationEvidenceBundle,
      historicalEvents,
    );
    if (!evidenceCheck.passed && reviewDecision.explicitEvidenceRequired) {
      this.timelineMetrics.evidenceGateFails += 1;
      if (!explicitFailedTerminalStatus) {
        terminalStatus = "partial_success";
        failureClass = "contract_error";
      } else if (!failureClass) {
        failureClass = "unknown";
      }
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
      const evidenceRefs = Array.from(
        (this.evidenceRefsByTask.get(taskId) || new Map()).values(),
      ).slice(0, 20);
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

    const shouldGateWithVerification =
      reviewDecision.runVerificationAgent &&
      terminalStatus !== "failed" &&
      terminalStatus !== "needs_user_action" &&
      terminalStatus !== "awaiting_approval" &&
      terminalStatus !== "awaiting_verification" &&
      terminalStatus !== "resume_available" &&
      !existingTask.parentTaskId &&
      (existingTask.agentType ?? "main") === "main";
    let postVerificationResult: VerificationRuntimeResult | undefined;
    if (shouldGateWithVerification) {
      const pendingCompletionVerifications = (this as Any).pendingCompletionVerifications as
        | Set<string>
        | undefined;
      if (pendingCompletionVerifications?.has(taskId)) {
        return;
      }
      pendingCompletionVerifications?.add(taskId);
      // Keep the in-memory projection aligned with the durable marker. This
      // also lets lightweight callers observe the gate without waiting for a
      // database round-trip.
      existingTask.status = "blocked";
      existingTask.completedAt = undefined;
      existingTask.terminalStatus = "awaiting_verification";
      existingTask.failureClass = undefined;
      this.taskRepo.update(taskId, {
        status: "blocked",
        completedAt: undefined,
        terminalStatus: "awaiting_verification",
        failureClass: undefined,
        error: "Awaiting independent verification before completion.",
        ...(trimmedSummary ? { resultSummary: trimmedSummary } : {}),
      });
      this.logEvent(taskId, "task_status", {
        status: "blocked",
        terminalStatus: "awaiting_verification",
        message: "Awaiting independent verification before completion.",
      });
      this.logEvent(taskId, "verification_started", {
        source: "post_completion_review_gate",
        policy: reviewPolicy,
        tier: reviewDecision.tier,
        terminalization: "blocked_until_verification",
      });
      try {
        postVerificationResult = await this.runPostCompletionVerification(
          existingTask,
          trimmedSummary,
          metadata?.verificationEvidenceBundle,
          120_000,
          {
            explicit: true,
            highRisk: risk.level === "high",
            outputSummary: metadata?.outputSummary,
          },
        );
        if (!postVerificationResult?.gated) {
          throw new Error("Required independent verification returned no gated result.");
        }
        if (postVerificationResult.gated) {
          if (
            postVerificationResult.verdict === "FAIL" ||
            (postVerificationResult.verdict === "PARTIAL" && postVerificationResult.shouldBlock)
          ) {
            terminalStatus = "failed";
            failureClass = "required_verification";
          } else if (postVerificationResult.verdict === "PARTIAL") {
            terminalStatus = "partial_success";
            failureClass = "required_verification";
          }
        }
      } catch (error: Any) {
        terminalStatus = "partial_success";
        failureClass = "required_verification";
        postVerificationResult = {
          gated: true,
          ran: false,
          status: "missing",
          verdict: "PARTIAL",
          report: `Independent verification failed to run: ${error?.message || String(error)}`,
          shouldBlock: true,
        };
        this.logEvent(taskId, "verification_failed", {
          source: "post_completion_review_gate",
          message: postVerificationResult.report,
          verificationVerdict: postVerificationResult.verdict,
        });
      } finally {
        pendingCompletionVerifications?.delete(taskId);
      }
    }

    if (shouldGateWithVerification) {
      const taskAfterVerification = this.taskRepo.findById(taskId);
      const taskAfterVerificationStatus = taskAfterVerification
        ? deriveCanonicalTaskStatus(taskAfterVerification)
        : undefined;
      // A user cancellation, retry, follow-up, or another terminal path may
      // race the verifier. Respect whichever durable lifecycle state won the
      // race instead of overwriting it with a stale completion.
      if (
        !taskAfterVerification ||
        isTerminalTaskStatus(taskAfterVerificationStatus) ||
        (taskAfterVerification.status !== "blocked" &&
          taskAfterVerification.terminalStatus !== "awaiting_verification")
      ) {
        return;
      }
    }

    let resolvedOutcome = decideTaskOutcome({
      requestedStatus: "completed",
      terminalStatus,
      failureClass,
      resultSummary: trimmedSummary,
      outputSummary: metadata?.outputSummary,
      bestKnownOutcome,
    });
    terminalStatus = resolvedOutcome.terminalStatus;
    failureClass = resolvedOutcome.failureClass;
    const effectiveVerificationVerdict = postVerificationResult?.gated
      ? postVerificationResult.verdict
      : metadata?.verificationVerdict;
    const effectiveVerificationReport =
      postVerificationResult?.gated && postVerificationResult.report
        ? postVerificationResult.report
        : metadata?.verificationReport;

    const completionTelemetry = {
      ...this.computeTimelineTelemetryFromEvents(this.getTaskEventsForReplay(taskId)),
      telemetry_source: "runtime_v2",
    };
    const isCompletedOutcome = resolvedOutcome.status === "completed";

    const completedAt = Date.now();
    const lastRunDurationMs = this.calculateLatestRunDurationMs(
      taskId,
      completedAt,
      existingTask.createdAt,
      historicalEvents,
    );
    const updates: Partial<Task> = {
      status: resolvedOutcome.status,
      completedAt,
      lastRunDurationMs,
      // Preserve a helpful prompt for resumable states; otherwise clear stale failures.
      error:
        resolvedOutcome.status === "completed"
          ? null
          : existingTask.error ||
            (resolvedOutcome.terminalStatus === "resume_available" ? "Resume available" : null),
      terminalStatus,
      failureClass,
      ...(bestKnownOutcome ? { bestKnownOutcome } : {}),
      budgetUsage: metadata?.budgetUsage,
      riskLevel: risk.level,
      ...(trimmedSummary ? { resultSummary: trimmedSummary } : {}),
      ...(typeof metadata?.semanticSummary === "string" &&
      metadata.semanticSummary.trim().length > 0
        ? { semanticSummary: metadata.semanticSummary.trim() }
        : {}),
      ...(effectiveVerificationVerdict
        ? { verificationVerdict: effectiveVerificationVerdict }
        : {}),
      ...(typeof effectiveVerificationReport === "string" &&
      effectiveVerificationReport.trim().length > 0
        ? { verificationReport: effectiveVerificationReport.trim() }
        : {}),
      ...(metadata?.agentConfig ? { agentConfig: metadata.agentConfig } : {}),
    };
    this.taskRepo.update(taskId, updates);
    this.clearRetryState(taskId);
    // Mark executor as completed for TTL-based cleanup
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.status = "completed";
      cached.lastAccessed = Date.now();
    }

    // Immediately release MCP server connections for sub-agent tasks to prevent process leaks
    // during multitask runs. Sub-agents are short-lived and won't receive follow-ups.
    if (existingTask.agentType === "sub") {
      try {
        void MCPClientManager.getInstance()
          ?.releaseForExecutor(taskId)
          .catch(() => {
            // Ignore release failures after short-lived sub-agent completion.
          });
      } catch {
        // Ignore — MCPClientManager may not be initialized
      }
    }

    const completionMessage =
      terminalStatus === "needs_user_action"
        ? "Task completed - action required"
        : terminalStatus === "partial_success"
          ? "Task completed with partial results"
          : "Task completed successfully";
    const terminalStatusMessage =
      resolvedOutcome.status === "completed"
        ? completionMessage
        : resolvedOutcome.status === "failed"
          ? "Task failed"
          : resolvedOutcome.status === "interrupted"
            ? "Task interrupted - resume available"
            : "Task is waiting for approval or further input";
    this.logEvent(taskId, isCompletedOutcome ? "task_completed" : "task_status", {
      message: terminalStatusMessage,
      lastRunDurationMs,
      ...(updates.resultSummary ? { resultSummary: updates.resultSummary } : {}),
      ...(resolvedOutcome.status !== "completed" ? { status: resolvedOutcome.status } : {}),
      terminalStatus,
      ...(failureClass ? { failureClass } : {}),
      ...(bestKnownOutcome ? { bestKnownOutcome } : {}),
      ...(metadata?.budgetUsage ? { budgetUsage: metadata.budgetUsage } : {}),
      ...(metadata?.outputSummary ? { outputSummary: metadata.outputSummary } : {}),
      ...(typeof metadata?.semanticSummary === "string" &&
      metadata.semanticSummary.trim().length > 0
        ? { semanticSummary: metadata.semanticSummary.trim() }
        : {}),
      ...(effectiveVerificationVerdict
        ? { verificationVerdict: effectiveVerificationVerdict }
        : {}),
      ...(typeof effectiveVerificationReport === "string" &&
      effectiveVerificationReport.trim().length > 0
        ? { verificationReport: effectiveVerificationReport.trim() }
        : {}),
      ...(metadata?.verificationOutcome
        ? { verificationOutcome: metadata.verificationOutcome }
        : {}),
      ...(metadata?.verificationScope ? { verificationScope: metadata.verificationScope } : {}),
      ...(metadata?.verificationEvidenceMode
        ? { verificationEvidenceMode: metadata.verificationEvidenceMode }
        : {}),
      ...(Array.isArray(metadata?.pendingChecklist) && metadata?.pendingChecklist.length > 0
        ? { pendingChecklist: metadata.pendingChecklist }
        : {}),
      ...(metadata?.verificationMessage
        ? { verificationMessage: metadata.verificationMessage }
        : {}),
      ...(Array.isArray(metadata?.failedMutationRequiredStepIds) &&
      metadata.failedMutationRequiredStepIds.length > 0
        ? { failedMutationRequiredStepIds: metadata.failedMutationRequiredStepIds }
        : {}),
      ...(Array.isArray(metadata?.waivedVerificationStepIds) &&
      metadata.waivedVerificationStepIds.length > 0
        ? { waivedVerificationStepIds: metadata.waivedVerificationStepIds }
        : {}),
      ...(metadata?.terminalKind ? { terminalKind: metadata.terminalKind } : {}),
      ...(Array.isArray(metadata?.failedStepIds) && metadata.failedStepIds.length > 0
        ? { failedStepIds: metadata.failedStepIds }
        : {}),
      ...(recoveredResolvedStepIds.length > 0
        ? { recoveredFailedStepIds: recoveredResolvedStepIds }
        : {}),
      ...(Array.isArray(metadata?.incompleteStepIds) && metadata.incompleteStepIds.length > 0
        ? { incompleteStepIds: metadata.incompleteStepIds }
        : {}),
      ...(metadata?.terminalStatusReason
        ? { terminalStatusReason: metadata.terminalStatusReason }
        : {}),
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

    if (quality) {
      this.logEvent(taskId, quality.passed ? "review_quality_passed" : "review_quality_failed", {
        policy: reviewPolicy,
        tier: reviewDecision.tier,
        issues: quality.issues,
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
    if (isCompletedOutcome && entropyDecision.runEntropySweep) {
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
    if (
      isCompletedOutcome &&
      existingTask?.worktreeStatus === "active" &&
      existingTask.worktreePath
    ) {
      const worktreePath = existingTask.worktreePath;
      const worktreeSettings = this.worktreeManager.getSettings();
      if (worktreeSettings.autoCommitOnComplete) {
        void (async () => {
          try {
            this.taskRepo.update(taskId, { worktreeStatus: "committing" });
            this.assertTaskWorkspaceFilesystemAccess(
              taskId,
              worktreePath,
              "write",
              "worktree auto-commit",
            );
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
            this.taskRepo.update(taskId, { worktreeStatus: "active" });
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
    if (isCompletedOutcome && existingTask?.comparisonSessionId && comparisonSvc) {
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
      if (isCompletedOutcome && isTopLevelTask && existingTask.source !== "sample" && !taskDisablesMemoryCapture(existingTask)) {
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

  private buildAnnotationFollowUpContext(
    taskId: string,
    message: string,
  ): {
    message: string;
    annotations: Annotation[];
  } {
    const annotations = this.annotationRepo.listOpenByTask(taskId);
    if (annotations.length === 0) return { message, annotations: [] };

    const lines = [
      "## Pending User Annotations",
      "",
      "Use these annotations as precise user feedback. Address the target(s) explicitly and keep changes scoped to the annotated issues unless the user asks for broader work.",
      "",
      ...annotations.flatMap((annotation, index) => {
        const target = annotation.targetRef as Any;
        const rect = target?.rect
          ? `rect x=${target.rect.x} y=${target.rect.y} w=${target.rect.width} h=${target.rect.height}`
          : "";
        const viewport = target?.viewport
          ? `viewport ${target.viewport.width}x${target.viewport.height}${target.viewport.mobile ? " mobile" : ""}`
          : "";
        const targetParts = [
          target?.url ? `url=${target.url}` : "",
          target?.filePath ? `file=${target.filePath}` : "",
          target?.selector ? `selector=${target.selector}` : "",
          target?.xpath ? `xpath=${target.xpath}` : "",
          target?.tagName ? `tag=${target.tagName}` : "",
          target?.textQuote ? `text=${JSON.stringify(target.textQuote)}` : "",
          rect,
          viewport,
        ].filter(Boolean);
        const stylePatch = annotation.stylePatch
          ? [`Style guidance: ${JSON.stringify(annotation.stylePatch)}`]
          : [];
        const screenshot = annotation.screenshotPath
          ? [`Screenshot: ${annotation.screenshotPath}`]
          : [];
        return [
          `Annotation ${index + 1} (${annotation.id}) [${annotation.surfaceType}, ${annotation.status}]`,
          `User request: ${annotation.body}`,
          targetParts.length > 0 ? `Target: ${targetParts.join("; ")}` : "Target: unavailable",
          ...stylePatch,
          ...screenshot,
          "",
        ];
      }),
      "## User Follow-up",
      message,
    ];

    return { message: lines.join("\n"), annotations };
  }

  /**
   * Send a follow-up message to a task.
   *
   * If the executor is currently running (mutex held), the message is queued
   * for injection into the active execution loop and a user_message event is
   * emitted immediately so the UI shows the message right away.
   */
  private getExistingUserFollowUpResult(
    taskId: string,
    messageId: string,
    message: string,
  ): AgentMessageSendResult | null {
    const event = readDurableTaskEvents(this, taskId, "user_message")
      .slice()
      .reverse()
      .find((candidate) => {
        const payload = candidate.payload as Record<string, unknown> | undefined;
        return payload?.messageId === messageId && payload.deliveryMode !== "message";
      });
    if (!event) return null;
    const payload = (event.payload as Record<string, unknown> | undefined) || {};
    const priorMessage = typeof payload.message === "string" ? payload.message : "";
    if (priorMessage && priorMessage !== message) {
      throw new Error(
        `Message ID ${messageId} was already used for different content; retry with a new message_id.`,
      );
    }
    const rawStatus = payload.deliveryStatus ?? payload.status;
    const status: AgentMessageDeliveryStatus =
      rawStatus === "queued" ||
      rawStatus === "started" ||
      rawStatus === "delivered" ||
      rawStatus === "failed" ||
      rawStatus === "quarantined" ||
      rawStatus === "accepted"
        ? rawStatus
        : "accepted";
    return {
      queued: status === "queued" || status === "started",
      duplicate: true,
      messageId,
      deliveryMode: "follow_up",
      deliveryStatus: status,
      ...(typeof payload.acceptedAt === "number" ? { acceptedAt: payload.acceptedAt } : {}),
      ...(typeof payload.queuedAt === "number" ? { queuedAt: payload.queuedAt } : {}),
      ...(typeof payload.startedAt === "number" ? { startedAt: payload.startedAt } : {}),
      ...(typeof payload.deliveredAt === "number" ? { deliveredAt: payload.deliveredAt } : {}),
      ...(typeof payload.failedAt === "number" ? { failedAt: payload.failedAt } : {}),
      ...(typeof payload.quarantinedAt === "number"
        ? { quarantinedAt: payload.quarantinedAt }
        : {}),
      ...(typeof payload.failureCode === "string" ? { failureCode: payload.failureCode } : {}),
    };
  }

  async sendMessage(
    taskId: string,
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
    options?: DaemonFollowUpOptions,
  ): Promise<AgentMessageSendResult> {
    if (this.shutdownRequested) {
      throw new Error("Agent daemon is shutting down; message was not admitted.");
    }
    let executor: TaskExecutor;

    // Always get fresh task and workspace from DB to pick up permission changes
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    // Bot conversations are created dormant and their first user turn enters
    // through sendMessage rather than startTaskImmediate. Attach the
    // workspace-scoped persistent team here as well so the initial executor
    // gets the team prompt and send_agent_message capability.
    this.ensureBotTaskTeam(task);
    if (options?.expectedTurnId) {
      // Validate before touching task metadata, annotations, or the executor;
      // a stale client must not mutate a newer turn.
      this.workSessionProtocolService.assertExpectedTurnForTask(taskId, options.expectedTurnId);
    }

    // Agent messages are queue-only by contract. They must be durably accepted
    // without implicitly starting a new worker turn; ordinary user follow-ups
    // continue through the existing execution path below.
    if (options?.deliveryMode === "message") {
      return this.queueMessageOnly(task, message, images, quotedAssistantMessage, options);
    }
    // Renderer retries may arrive after the IPC call returned but before the
    // composer receives the acceptance callback. A stable message_id is the
    // idempotency boundary for ordinary follow-ups too; never create a second
    // transcript event or provider turn for the same identity.
    if (options?.messageId && options.messageSource !== "agent") {
      const existing = this.getExistingUserFollowUpResult(taskId, options.messageId, message);
      if (existing) return existing;
    }
    let cached = this.activeTasks.get(taskId);
    if (this.isSideChatTask(task) && !cached?.executor.isRunning) {
      this.refreshSideChatParentSnapshot(task);
      this.activeTasks.delete(taskId);
      cached = undefined;
    }
    const sideChatAgentConfigOverride = this.buildSideChatTurnAgentConfigOverride(task, message);
    const effectiveOptions = sideChatAgentConfigOverride
      ? {
          ...options,
          agentConfigOverride: {
            ...options?.agentConfigOverride,
            ...sideChatAgentConfigOverride,
          },
        }
      : options;
    const overrideResult = this.applyTaskFollowUpOverrides(task, effectiveOptions);
    if (overrideResult.changed) {
      this.taskRepo.update(taskId, { agentConfig: overrideResult.task.agentConfig });
    }
    const { task: roleAdjustedTask } = this.applyAgentRoleOverrides(overrideResult.task);
    const effectiveTask = effectiveOptions?.agentConfigOverride
      ? {
          ...roleAdjustedTask,
          agentConfig: {
            ...roleAdjustedTask.agentConfig,
            ...effectiveOptions.agentConfigOverride,
          },
        }
      : roleAdjustedTask;

    const workspace = this.workspaceRepo.findById(effectiveTask.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${effectiveTask.workspaceId} not found`);
    }
    const effectiveWorkspace = this.applyTaskWorkspaceOverridesForPath(
      effectiveTask,
      workspace,
      cached?.executor.getWorkspace?.().path ||
        (effectiveTask.worktreeStatus === "active" ? effectiveTask.worktreePath : undefined),
    );
    const effectiveAccessProfile = resolveEffectiveAccessProfile({
      task: effectiveTask,
      workspace: effectiveWorkspace,
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    });
    if (effectiveAccessProfile.profileUnavailable) {
      const errorMessage =
        "The selected access profile is unavailable. Choose a valid profile before continuing.";
      this.updateTask(taskId, {
        status: "paused",
        terminalStatus: "needs_user_action",
        awaitingUserInputReasonCode: "access_profile_unavailable",
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }

    this.taskRepo.touch(taskId);
    const annotationContext = this.buildAnnotationFollowUpContext(taskId, message);
    const effectiveMessage = annotationContext.message;
    const userMessageAttachmentMetadata = buildUserMessageAttachmentMetadata(images);
    if (annotationContext.annotations.length > 0) {
      const changedCount = this.annotationRepo.markAddressing(
        taskId,
        annotationContext.annotations.map((annotation) => annotation.id),
      );
      this.logEvent(taskId, "annotation_addressing_started", {
        annotationIds: annotationContext.annotations.map((annotation) => annotation.id),
        changedCount,
      });
    }

    if (!cached) {
      // Task executor not in memory - need to recreate it
      // Create new executor
      executor = new TaskExecutor(effectiveTask, effectiveWorkspace, this);

      // Rebuild conversation history from saved events
      const events = this.getTaskEventsForResume(taskId, effectiveWorkspace.path);
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
      executor.updateTaskAgentConfig(effectiveTask.agentConfig);
      // Update workspace to pick up legacy workspace permission changes.
      executor.updateWorkspace(effectiveWorkspace);
      cached.lastAccessed = Date.now();
      cached.status = "active";
    }

    // If the executor is busy (mutex locked), queue the message for the running
    // loop to pick up and return immediately so the IPC doesn't block.
    if (executor.isRunning) {
      if (effectiveOptions?.queuedFollowUp?.deliveryMode === "message") {
        // Another turn may start while the orphan drain performs preflight.
        // Keep its existing receipt/full queue item instead of creating a
        // second ordinary follow-up and a second user-message event.
        executor.runtime.requeueFollowUpAtTurnBoundary(effectiveOptions.queuedFollowUp);
        return {
          queued: true,
          messageId: effectiveOptions.queuedFollowUp.messageId,
          deliveryMode: "message",
          deliveryStatus: "queued",
        };
      }
      const acceptedAt = Date.now();
      const integrationMentions = effectiveTask.agentConfig?.integrationMentions;
      executor.queueFollowUp(
        effectiveMessage,
        images,
        quotedAssistantMessage,
        integrationMentions,
        effectiveOptions?.agentConfigOverride,
        effectiveOptions?.interactionMode ?? effectiveTask.agentConfig?.interactionMode,
        effectiveOptions?.messageSource,
        effectiveOptions?.messageId,
        effectiveOptions?.senderTaskId,
        effectiveOptions?.senderLabel,
        effectiveOptions?.deliveryMode,
        ...(effectiveOptions?.inReplyToMessageId || effectiveOptions?.inReplyToTaskId
          ? [effectiveOptions.inReplyToMessageId, effectiveOptions.inReplyToTaskId]
          : []),
      );
      this.logEvent(taskId, "agent_follow_up_scheduled", {
        message,
        ...(effectiveOptions?.messageId ? { messageId: effectiveOptions.messageId } : {}),
        deliveryMode: effectiveOptions?.deliveryMode || "follow_up",
        deliveryStatus: "queued",
        acceptedAt,
        queuedAt: acceptedAt,
        ...(effectiveOptions?.messageSource
          ? { messageSource: effectiveOptions.messageSource }
          : {}),
        ...(effectiveOptions?.senderTaskId ? { senderTaskId: effectiveOptions.senderTaskId } : {}),
        ...(effectiveOptions?.senderLabel ? { senderLabel: effectiveOptions.senderLabel } : {}),
        ...(effectiveOptions?.inReplyToMessageId
          ? { inReplyToMessageId: effectiveOptions.inReplyToMessageId }
          : {}),
        ...(effectiveOptions?.inReplyToTaskId
          ? { inReplyToTaskId: effectiveOptions.inReplyToTaskId }
          : {}),
      });
      // Emit user_message event immediately so the UI shows the message right away.
      // The executor's sendMessageLegacy won't re-emit because the message is
      // injected directly into the conversation loop, not through sendMessage.
      this.logEvent(taskId, "user_message", {
        message,
        ...(effectiveOptions?.messageSource
          ? { messageSource: effectiveOptions.messageSource }
          : {}),
        ...(effectiveOptions?.messageId ? { messageId: effectiveOptions.messageId } : {}),
        ...(effectiveOptions?.deliveryMode ? { deliveryMode: effectiveOptions.deliveryMode } : {}),
        ...(effectiveOptions?.deliveryMode === "message" ? { deliveryStatus: "queued" } : {}),
        acceptedAt,
        queuedAt: acceptedAt,
        ...(effectiveOptions?.senderTaskId ? { senderTaskId: effectiveOptions.senderTaskId } : {}),
        ...(effectiveOptions?.senderLabel ? { senderLabel: effectiveOptions.senderLabel } : {}),
        ...(effectiveOptions?.inReplyToMessageId
          ? { inReplyToMessageId: effectiveOptions.inReplyToMessageId }
          : {}),
        ...(effectiveOptions?.inReplyToTaskId
          ? { inReplyToTaskId: effectiveOptions.inReplyToTaskId }
          : {}),
        ...(effectiveMessage !== message ? { annotationContextInjected: true } : {}),
        ...(userMessageAttachmentMetadata.length > 0
          ? { images: userMessageAttachmentMetadata }
          : {}),
        ...(integrationMentions && integrationMentions.length > 0 ? { integrationMentions } : {}),
        ...(quotedAssistantMessage ? { quotedAssistantMessage } : {}),
      });
      return {
        queued: true,
        deliveryMode: effectiveOptions?.deliveryMode || "follow_up",
        deliveryStatus: "queued",
        acceptedAt,
        queuedAt: acceptedAt,
        ...(effectiveOptions?.messageId ? { messageId: effectiveOptions.messageId } : {}),
      };
    }

    // Send the message (executor is idle, acquire mutex normally)
    if (effectiveMessage !== message) {
      executor.suppressNextUserMessageEvent();
      this.logEvent(taskId, "user_message", {
        message,
        annotationContextInjected: true,
        ...(effectiveOptions?.messageSource
          ? { messageSource: effectiveOptions.messageSource }
          : {}),
        ...(effectiveOptions?.messageId ? { messageId: effectiveOptions.messageId } : {}),
        ...(effectiveOptions?.senderTaskId ? { senderTaskId: effectiveOptions.senderTaskId } : {}),
        ...(effectiveOptions?.senderLabel ? { senderLabel: effectiveOptions.senderLabel } : {}),
        ...(userMessageAttachmentMetadata.length > 0
          ? { images: userMessageAttachmentMetadata }
          : {}),
        ...(quotedAssistantMessage ? { quotedAssistantMessage } : {}),
      });
    }
    if (effectiveOptions?.agentConfigOverride) {
      this.setTransientTaskAgentConfig(taskId, effectiveOptions.agentConfigOverride);
    }
    const candidateAgentMessageId = effectiveOptions?.messageId;
    const candidateReceiptStatus = candidateAgentMessageId
      ? this.getQueuedAgentMessageDeliveryStatus(taskId, candidateAgentMessageId)
      : undefined;
    // Only queue-originated agent messages carry this acceptance protocol. A
    // caller may use agent provenance on an ordinary follow-up, which has no
    // target queue receipt to acknowledge here.
    const queuedAgentMessageId =
      candidateReceiptStatus === "queued" ||
      candidateReceiptStatus === "started" ||
      candidateReceiptStatus === "delivered"
        ? candidateAgentMessageId
        : undefined;
    let agentMessageAcceptanceCompleted = false;
    const onAgentMessageAccepted = queuedAgentMessageId
      ? async () => {
          const receiptStatus = this.getQueuedAgentMessageDeliveryStatus(
            taskId,
            queuedAgentMessageId,
          );
          if (receiptStatus === "delivered") {
            agentMessageAcceptanceCompleted = true;
            return;
          }
          if (
            (receiptStatus !== "queued" && receiptStatus !== "started") ||
            !this.markQueuedAgentMessageDelivered(taskId, queuedAgentMessageId)
          ) {
            throw new Error(
              `Queued agent message ${queuedAgentMessageId} could not be durably accepted.`,
            );
          }
          agentMessageAcceptanceCompleted = true;
        }
      : undefined;
    // A delivered receipt is the idempotency boundary. Return before invoking
    // the executor when a stale queue copy is retried after restart.
    if (queuedAgentMessageId && candidateReceiptStatus === "delivered") {
      return {
        queued: false,
        duplicate: true,
        messageId: queuedAgentMessageId,
        deliveryMode: "follow_up",
        deliveryStatus: "delivered",
        deliveredAt: Date.now(),
      };
    }
    // Renderer follow-ups need the durable admission boundary, not the end of
    // the provider turn. Native executors expose that boundary after the task
    // status and user_message event have been persisted. ACP keeps its legacy
    // full-turn response because it does not expose the same guarantee.
    const returnOnAccepted =
      effectiveOptions?.returnOnAccepted === true &&
      effectiveTask.agentConfig?.externalRuntime?.kind !== "acpx";
    let executionAcceptedAt: number | undefined;
    let resolveExecutionAccepted: ((acceptedAt: number) => void) | undefined;
    let rejectExecutionAccepted: ((error: unknown) => void) | undefined;
    const executionAcceptance = returnOnAccepted
      ? new Promise<number>((resolve, reject) => {
          resolveExecutionAccepted = resolve;
          rejectExecutionAccepted = reject;
        })
      : undefined;
    const onExecutionAccepted = returnOnAccepted
      ? () => {
          if (executionAcceptedAt !== undefined) return;
          executionAcceptedAt = Date.now();
          resolveExecutionAccepted?.(executionAcceptedAt);
        }
      : undefined;
    const executeFollowUp = async (): Promise<void> => {
      try {
        await executor.sendMessage(effectiveMessage, images, quotedAssistantMessage, {
          agentConfigOverride: effectiveOptions?.agentConfigOverride,
          interactionMode:
            effectiveOptions?.interactionMode ?? effectiveTask.agentConfig?.interactionMode,
          messageSource: effectiveOptions?.messageSource,
          messageId: effectiveOptions?.messageId,
          senderTaskId: effectiveOptions?.senderTaskId,
          senderLabel: effectiveOptions?.senderLabel,
          inReplyToMessageId: effectiveOptions?.inReplyToMessageId,
          inReplyToTaskId: effectiveOptions?.inReplyToTaskId,
          onAccepted: onAgentMessageAccepted,
          onExecutionAccepted,
          suppressUserMessageEvent:
            effectiveOptions?.suppressUserMessageEvent === true ||
            queuedAgentMessageId !== undefined,
          queuedFollowUp: effectiveOptions?.queuedFollowUp,
        });
        if (onAgentMessageAccepted && !agentMessageAcceptanceCompleted) {
          throw new Error(
            `Queued agent message ${queuedAgentMessageId} did not reach the executor acceptance boundary.`,
          );
        }
      } finally {
        if (effectiveOptions?.agentConfigOverride) {
          this.clearTransientTaskAgentConfig(taskId);
          const stableWorkspace = this.getEffectiveWorkspaceForTask(taskId);
          if (stableWorkspace) executor.updateWorkspace(stableWorkspace);
        }
        this.processOrphanedFollowUps(taskId, executor);
      }
    };

    if (returnOnAccepted && executionAcceptance) {
      void executeFollowUp().then(
        () => {
          if (executionAcceptedAt === undefined) {
            rejectExecutionAccepted?.(
              new Error("Follow-up ended before reaching the durable acceptance boundary."),
            );
          }
        },
        (error) => {
          if (executionAcceptedAt === undefined) {
            rejectExecutionAccepted?.(error);
          } else {
            log.error(`[follow-up] Background execution failed for ${taskId}:`, error);
          }
        },
      );
      const acceptedAt = await executionAcceptance;
      return {
        queued: false,
        deliveryMode: "follow_up",
        deliveryStatus: "accepted",
        acceptedAt,
      };
    }

    await executeFollowUp();
    return {
      queued: false,
      deliveryMode: "follow_up",
      deliveryStatus: "delivered",
      deliveredAt: Date.now(),
    };
  }

  /**
   * Accept a message into the target runtime without starting execution.
   *
   * Agent-to-agent steering uses this path so a parent can continue working
   * after the handoff. The message is stored in the existing SessionRuntime
   * queue and represented by a persisted user_message event. Bot-team callers
   * may explicitly request a worker wake after that durable acceptance.
   */
  private queueMessageOnly(
    task: Task,
    message: string,
    images: ImageAttachment[] | undefined,
    quotedAssistantMessage: QuotedAssistantMessage | undefined,
    options: Pick<
      TaskFollowUpInput,
      | "deliveryMode"
      | "interactionMode"
      | "messageSource"
      | "messageId"
      | "senderTaskId"
      | "senderLabel"
      | "inReplyToMessageId"
      | "inReplyToTaskId"
      | "integrationMentions"
    > &
      Pick<DaemonFollowUpOptions, "startAfterAccepted">,
  ): AgentMessageSendResult {
    if (this.shutdownRequested) {
      throw new Error("Agent daemon is shutting down; message was not admitted.");
    }
    const messageId =
      typeof options.messageId === "string" && options.messageId.trim().length > 0
        ? options.messageId.trim()
        : crypto.randomUUID();
    const messageHash = hashBotMessage(message);

    // The target's persisted user_message event is the receipt. Checking it
    // before touching the runtime makes retries idempotent across restarts.
    // Queue receipts carry delivery metadata that the canonical work-session
    // projection intentionally does not copy into message items. Read the
    // compatibility event for idempotency/acknowledgement decisions.
    const priorEvent = readDurableTaskEvents(this, task.id, "user_message")
      .slice()
      .reverse()
      .find((event) => {
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload?.messageId !== messageId || payload.deliveryMode !== "message") return false;
        return !options.senderTaskId || payload.senderTaskId === options.senderTaskId;
      });
    if (priorEvent) {
      const payload = priorEvent.payload as Record<string, unknown> | undefined;
      const priorMessage = typeof payload?.message === "string" ? payload.message : undefined;
      const priorMessageHash =
        typeof payload?.messageHash === "string" ? payload.messageHash : undefined;
      if (
        (priorMessage !== undefined && priorMessage !== message) ||
        (priorMessageHash !== undefined && priorMessageHash !== messageHash)
      ) {
        throw new Error(
          `Message ID ${messageId} was already used for different content; retry with a new message_id.`,
        );
      }
      const status =
        payload?.deliveryStatus === "delivered" || payload?.status === "delivered"
          ? "delivered"
          : payload?.deliveryStatus === "quarantined" || payload?.status === "quarantined"
            ? "quarantined"
            : payload?.deliveryStatus === "failed" || payload?.status === "failed"
              ? "failed"
              : "queued";
      if (status === "quarantined") {
        throw new Error(
          `BOT_MESSAGE_QUARANTINED: ${typeof payload?.error === "string" ? payload.error : "Repair the bot team before retrying."}`,
        );
      }
      if (status === "delivered") {
        if (typeof (this as Any).releaseQueuedAttachmentRefs === "function") {
          this.releaseQueuedAttachmentRefs(task.id, messageId, payload);
        }
        return {
          queued: false,
          duplicate: true,
          messageId,
          deliveryMode: "message",
          deliveryStatus: status,
          ...(typeof payload?.acceptedAt === "number" ? { acceptedAt: payload.acceptedAt } : {}),
          ...(typeof payload?.queuedAt === "number" ? { queuedAt: payload.queuedAt } : {}),
          ...(typeof payload?.deliveredAt === "number" ? { deliveredAt: payload.deliveredAt } : {}),
        };
      }
      if (status === "failed") {
        const retryAt = Date.now();
        const retryPayload: Record<string, unknown> = {
          ...(payload || {}),
          status: "queued",
          deliveryStatus: "queued",
          queuedAt: retryAt,
          attempt:
            typeof payload?.attempt === "number" && Number.isFinite(payload.attempt)
              ? Math.max(1, Math.floor(payload.attempt) + 1)
              : 1,
        };
        delete retryPayload.failedAt;
        delete retryPayload.quarantinedAt;
        delete retryPayload.failureCode;
        delete retryPayload.error;
        this.eventRepo.updatePayloadById(priorEvent.id, retryPayload);
        try {
          this.emitTaskEvent({ ...priorEvent, payload: retryPayload });
        } catch {
          // The retry receipt is durable even when the renderer is offline.
        }
      }
    }

    if (task.agentConfig?.externalRuntime?.kind === "acpx") {
      throw new Error(
        "Queue-only messages require a native worker. External ACP runtimes do not expose durable prompt acceptance; use a normal follow-up instead.",
      );
    }

    let recoveredImages = images;
    const priorPayload = priorEvent?.payload as Record<string, unknown> | undefined;
    if (priorPayload) {
      const hasLegacyAttachmentMetadata =
        Array.isArray(priorPayload.images) && priorPayload.images.length > 0;
      const hasQueuedAttachmentRefs = Object.prototype.hasOwnProperty.call(
        priorPayload,
        "queuedAttachmentRefs",
      );
      try {
        if (hasQueuedAttachmentRefs) {
          if (
            !Array.isArray(priorPayload.queuedAttachmentRefs) ||
            (priorPayload.queuedAttachmentRefs.length === 0 && hasLegacyAttachmentMetadata)
          ) {
            throw new Error("queued attachment references are incomplete");
          }
          recoveredImages = this.getQueuedAttachmentStore().hydrate(
            task.id,
            messageId,
            priorPayload.queuedAttachmentRefs,
          );
        } else if (hasLegacyAttachmentMetadata && (!images || images.length === 0)) {
          throw new Error("receipt has attachment metadata but no durable attachment reference");
        }
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "durable attachment validation failed";
        try {
          this.updateTask(task.id, {
            awaitingUserInputReasonCode: "queued_attachment_unavailable",
            error: `Queued attachment recovery blocked: ${reason}. Resend the message with its attachments.`,
          });
          this.logEvent(task.id, "error", {
            code: "QUEUED_ATTACHMENT_RECOVERY_BLOCKED",
            messageId,
            recoveryBlocked: true,
            message: `Queued attachment recovery blocked: ${reason}. Resend the message with its attachments.`,
          });
        } catch {
          // The thrown error still prevents an incomplete prompt from running
          // in a lightweight daemon host where task persistence is unavailable.
        }
        throw error;
      }
    }

    const cached = this.activeTasks.get(task.id);
    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Task workspace ${task.workspaceId} not found`);
    }
    const effectiveWorkspace = this.applyTaskWorkspaceOverridesForPath(
      task,
      workspace,
      cached?.executor.getWorkspace?.().path ||
        (task.worktreeStatus === "active" ? task.worktreePath : undefined),
    );
    const effectiveAccessProfile = resolveEffectiveAccessProfile({
      task,
      workspace: effectiveWorkspace,
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    });
    if (effectiveAccessProfile.profileUnavailable) {
      throw new Error(
        "The selected access profile is unavailable. Choose a valid profile before continuing.",
      );
    }

    let executor: TaskExecutor;
    if (!cached) {
      executor = new TaskExecutor(task, effectiveWorkspace, this);
      const events = this.getTaskEventsForResume(task.id, effectiveWorkspace.path);
      if (events.length > 0) executor.rebuildConversationFromEvents(events);
      this.activeTasks.set(task.id, {
        executor,
        lastAccessed: Date.now(),
        status: "active",
      });
    } else {
      executor = cached.executor;
      executor.updateTaskAgentConfig(task.agentConfig);
      executor.updateWorkspace(effectiveWorkspace);
      cached.lastAccessed = Date.now();
      cached.status = "active";
    }

    if (priorEvent) {
      const runtime = executor.runtime as Any;
      if (
        runtime &&
        typeof runtime.isFollowUpMessageConsumed === "function" &&
        runtime.isFollowUpMessageConsumed(messageId)
      ) {
        if (!this.markQueuedAgentMessageDelivered(task.id, messageId)) {
          throw new Error(`Queued agent message ${messageId} could not be acknowledged.`);
        }
        return {
          queued: false,
          duplicate: true,
          messageId,
          deliveryMode: "message",
          deliveryStatus: "delivered",
          deliveredAt: Date.now(),
          ...(typeof priorPayload?.acceptedAt === "number"
            ? { acceptedAt: priorPayload.acceptedAt }
            : {}),
          ...(typeof priorPayload?.queuedAt === "number"
            ? { queuedAt: priorPayload.queuedAt }
            : {}),
        };
      }
      const hasPending =
        typeof executor.hasPendingFollowUpMessage === "function" &&
        executor.hasPendingFollowUpMessage(messageId);
      if (!hasPending && typeof executor.queueFollowUp === "function") {
        // The receipt may predate a crash before queueFollowUp (or a failed
        // queue snapshot). Reconstruct the one exact message instead of
        // treating the queued receipt as a completed duplicate.
        executor.queueFollowUp(
          typeof priorPayload?.message === "string" ? priorPayload.message : message,
          recoveredImages,
          quotedAssistantMessage,
          options.integrationMentions ?? task.agentConfig?.integrationMentions,
          undefined,
          options.interactionMode,
          options.messageSource,
          messageId,
          options.senderTaskId,
          options.senderLabel,
          "message",
          ...(options.inReplyToMessageId || options.inReplyToTaskId
            ? [options.inReplyToMessageId, options.inReplyToTaskId]
            : []),
        );
      }
      if (options.startAfterAccepted) {
        this.wakeBotConversationAfterAccepted(task, messageId, options.senderTaskId);
      }
      return {
        queued: true,
        duplicate: true,
        messageId,
        deliveryMode: "message",
        deliveryStatus: "queued",
        ...(typeof priorPayload?.acceptedAt === "number"
          ? { acceptedAt: priorPayload.acceptedAt }
          : {}),
        ...(typeof priorPayload?.queuedAt === "number" ? { queuedAt: priorPayload.queuedAt } : {}),
      };
    }

    const acceptedAt = Date.now();
    const persistedAttachments = this.getQueuedAttachmentStore().persist(
      task.id,
      messageId,
      images,
    );
    const queuedImages =
      persistedAttachments.images.length > 0 ? persistedAttachments.images : images;
    this.taskRepo.touch(task.id);
    // Persist the target receipt before mutating the runtime queue. If the
    // process dies after this event but before queueFollowUp, restore overlays
    // this queued receipt back into the runtime queue by messageId.
    this.logEvent(task.id, "user_message", {
      message,
      messageHash,
      messageId,
      correlationId: messageId,
      deliveryMode: "message",
      deliveryStatus: "queued",
      acceptedAt,
      queuedAt: acceptedAt,
      attempt: 1,
      ...(options.messageSource ? { messageSource: options.messageSource } : {}),
      ...(options.senderTaskId ? { senderTaskId: options.senderTaskId } : {}),
      ...(options.senderLabel ? { senderLabel: options.senderLabel } : {}),
      ...(options.inReplyToMessageId ? { inReplyToMessageId: options.inReplyToMessageId } : {}),
      ...(options.inReplyToTaskId ? { inReplyToTaskId: options.inReplyToTaskId } : {}),
      ...(options.interactionMode ? { interactionMode: options.interactionMode } : {}),
      ...(persistedAttachments.refs.length > 0
        ? { queuedAttachmentRefs: persistedAttachments.refs }
        : {}),
      ...(options.integrationMentions && options.integrationMentions.length > 0
        ? { integrationMentions: options.integrationMentions }
        : {}),
      ...(quotedAssistantMessage ? { quotedAssistantMessage } : {}),
    });
    this.logEvent(task.id, "agent_follow_up_scheduled", {
      message,
      messageHash,
      messageId,
      correlationId: messageId,
      deliveryMode: "message",
      deliveryStatus: "queued",
      acceptedAt,
      queuedAt: acceptedAt,
      ...(options.messageSource ? { messageSource: options.messageSource } : {}),
      ...(options.senderTaskId ? { senderTaskId: options.senderTaskId } : {}),
      ...(options.senderLabel ? { senderLabel: options.senderLabel } : {}),
      ...(options.inReplyToMessageId ? { inReplyToMessageId: options.inReplyToMessageId } : {}),
      ...(options.inReplyToTaskId ? { inReplyToTaskId: options.inReplyToTaskId } : {}),
    });
    executor.queueFollowUp(
      message,
      queuedImages,
      quotedAssistantMessage,
      options.integrationMentions ?? task.agentConfig?.integrationMentions,
      undefined,
      options.interactionMode,
      options.messageSource,
      messageId,
      options.senderTaskId,
      options.senderLabel,
      "message",
      ...(options.inReplyToMessageId || options.inReplyToTaskId
        ? [options.inReplyToMessageId, options.inReplyToTaskId]
        : []),
    );

    if (options.startAfterAccepted) {
      this.wakeBotConversationAfterAccepted(task, messageId, options.senderTaskId);
    }

    return {
      queued: true,
      messageId,
      deliveryMode: "message",
      deliveryStatus: "queued",
      acceptedAt,
      queuedAt: acceptedAt,
    };
  }

  private wakeBotConversationAfterAccepted(
    task: Task,
    messageId: string,
    senderTaskId?: string,
  ): void {
    const cached = this.activeTasks.get(task.id);
    if (cached?.executor.isRunning) return;
    const refreshed = this.taskRepo.findById(task.id) || task;
    if (refreshed.status === "executing" || refreshed.status === "planning") return;
    // queueMessageOnly creates the executor before reaching this method. Drain
    // that exact accepted message through the normal follow-up path instead of
    // calling startTask: dormant bot conversations have a synthetic seed prompt
    // ("Start chatting with ...") that must never run before the real handoff.
    // processOrphanedFollowUps owns the per-task drain guard, so duplicate
    // retries cannot launch concurrent recipient executions.
    if (cached?.executor) {
      this.processOrphanedFollowUps(task.id, cached.executor);
      return;
    }

    // Defensive recovery for callers that reach the wake boundary without a
    // cached executor (for example a race with runtime eviction). Reconstruct
    // from the durable receipt instead of reporting a false delivery failure.
    const receipt = readDurableTaskEvents(this, task.id, "user_message")
      .slice()
      .reverse()
      .find((candidate) => {
        const payload = candidate.payload as Record<string, unknown> | undefined;
        return payload?.messageId === messageId && payload.deliveryMode === "message";
      });
    const payload = receipt?.payload as Record<string, unknown> | undefined;
    const queuedMessage = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (queuedMessage) {
      try {
        this.queueMessageOnly(task, queuedMessage, undefined, undefined, {
          deliveryMode: "message",
          messageId,
          messageSource: payload?.messageSource === "agent" ? "agent" : undefined,
          senderTaskId:
            typeof payload?.senderTaskId === "string" ? payload.senderTaskId : senderTaskId,
          senderLabel: typeof payload?.senderLabel === "string" ? payload.senderLabel : undefined,
          inReplyToMessageId:
            typeof payload?.inReplyToMessageId === "string"
              ? payload.inReplyToMessageId
              : undefined,
          inReplyToTaskId:
            typeof payload?.inReplyToTaskId === "string" ? payload.inReplyToTaskId : undefined,
          startAfterAccepted: true,
        });
        return;
      } catch (error) {
        this.logEvent(task.id, "error", {
          message: "Bot teammate message recovery could not start the recipient runtime.",
          error: String(error),
          code: "BOT_RUNTIME_RECOVERY_FAILED",
          messageId,
          senderTaskId,
        });
        return;
      }
    }

    this.logEvent(task.id, "error", {
      message: "Bot teammate message was accepted but its durable receipt is missing content.",
      error: "BOT_MESSAGE_RECEIPT_INCOMPLETE",
      messageId,
      senderTaskId,
    });
  }

  private getQueuedAttachmentStore(): QueuedAttachmentStore {
    return (this.queuedAttachmentStore ??= new QueuedAttachmentStore());
  }

  /**
   * Read the legacy event projection for durable delivery metadata. Canonical
   * message items preserve the text and actor, but queue receipts also need
   * messageId/deliveryStatus/sender fields that are intentionally not part of
   * the compact work-session message payload.
   */
  getDurableTaskEvents(taskId: string, type: string): TaskEvent[] {
    return readDurableTaskEvents(this, taskId, type, 200);
  }

  private getQueuedAgentMessageDeliveryStatus(
    taskId: string,
    messageId: string,
  ): "queued" | "started" | "delivered" | "failed" | "quarantined" | undefined {
    const event = readDurableTaskEvents(this, taskId, "user_message")
      .slice()
      .reverse()
      .find((candidate) => {
        const payload = candidate.payload as Record<string, unknown> | undefined;
        return payload?.messageId === messageId && payload.deliveryMode === "message";
      });
    if (!event) return undefined;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload?.deliveryStatus === "delivered" || payload?.status === "delivered") {
      return "delivered";
    }
    if (payload?.deliveryStatus === "quarantined" || payload?.status === "quarantined") {
      return "quarantined";
    }
    if (payload?.deliveryStatus === "failed" || payload?.status === "failed") return "failed";
    if (payload?.deliveryStatus === "started" || payload?.status === "started") return "started";
    return "queued";
  }

  /**
   * Repair the sender projection after its activity row is persisted. The
   * recipient may consume a queue receipt before send_agent_message records
   * that row, so the normal target-side projection can otherwise miss it.
   */
  reconcileAgentMessageSenderProjection(targetTaskId: string, messageId: string): void {
    const event = readDurableTaskEvents(this, targetTaskId, "user_message")
      .slice()
      .reverse()
      .find((candidate) => {
        const payload = candidate.payload as Record<string, unknown> | undefined;
        return payload?.messageId === messageId && payload.deliveryMode === "message";
      });
    if (!event) return;
    const payload = (event.payload as Record<string, unknown> | undefined) || {};
    const status = this.getQueuedAgentMessageDeliveryStatus(targetTaskId, messageId);
    if (
      status !== "started" &&
      status !== "delivered" &&
      status !== "failed" &&
      status !== "quarantined"
    ) {
      return;
    }
    const timestampKey =
      status === "started"
        ? "startedAt"
        : status === "delivered"
          ? "deliveredAt"
          : status === "failed"
            ? "failedAt"
            : "quarantinedAt";
    const timestamp =
      typeof payload[timestampKey] === "number" ? (payload[timestampKey] as number) : Date.now();
    this.updateAgentMessageSenderProjection(targetTaskId, messageId, payload, status, timestamp);
  }

  /** Mark the exact queue receipt when the recipient begins consuming it. */
  markQueuedAgentMessageStarted(taskId: string, messageId: string): boolean {
    const event = readDurableTaskEvents(this, taskId, "user_message")
      .slice()
      .reverse()
      .find((candidate) => {
        const payload = candidate.payload as Record<string, unknown> | undefined;
        return payload?.messageId === messageId && payload.deliveryMode === "message";
      });
    if (!event) return false;
    const existingPayload = (event.payload as Record<string, unknown> | undefined) || {};
    const existingStatus = this.getQueuedAgentMessageDeliveryStatus(taskId, messageId);
    if (
      existingStatus === "delivered" ||
      existingStatus === "failed" ||
      existingStatus === "quarantined"
    ) {
      return false;
    }
    if (existingStatus === "started") return true;
    const startedAt =
      typeof existingPayload.startedAt === "number" ? existingPayload.startedAt : Date.now();
    const payload: Record<string, unknown> = {
      ...existingPayload,
      status: "started",
      deliveryStatus: "started",
      startedAt,
      attempt:
        typeof existingPayload.attempt === "number" && Number.isFinite(existingPayload.attempt)
          ? Math.max(1, Math.floor(existingPayload.attempt))
          : 1,
    };
    this.eventRepo.updatePayloadById(event.id, payload);
    try {
      this.emitTaskEvent({ ...event, payload });
    } catch {
      // Durable state is authoritative if the renderer is unavailable.
    }
    this.updateAgentMessageSenderProjection(taskId, messageId, payload, "started", startedAt);
    return true;
  }

  /** Mark the persisted queue receipt once the worker has incorporated it. */
  markQueuedAgentMessageDelivered(taskId: string, messageId: string): boolean {
    const event = readDurableTaskEvents(this, taskId, "user_message")
      .slice()
      .reverse()
      .find((candidate) => {
        const payload = candidate.payload as Record<string, unknown> | undefined;
        return payload?.messageId === messageId && payload.deliveryMode === "message";
      });
    if (!event) return false;
    const existingPayload = (event.payload as Record<string, unknown> | undefined) || {};
    const alreadyDelivered =
      existingPayload.deliveryStatus === "delivered" || existingPayload.status === "delivered";
    if (
      existingPayload.deliveryStatus === "failed" ||
      existingPayload.status === "failed" ||
      existingPayload.deliveryStatus === "quarantined" ||
      existingPayload.status === "quarantined"
    ) {
      return false;
    }
    const deliveredAt =
      typeof existingPayload.deliveredAt === "number" ? existingPayload.deliveredAt : Date.now();
    const payload: Record<string, unknown> = alreadyDelivered
      ? existingPayload
      : {
          ...existingPayload,
          deliveryStatus: "delivered",
          deliveredAt,
        };
    if (!alreadyDelivered) {
      this.eventRepo.updatePayloadById(event.id, payload);
      try {
        this.emitTaskEvent({ ...event, payload });
      } catch {
        // The durable receipt is already written; a renderer listener must not
        // turn an accepted handoff into a retryable failure.
      }
    }

    // Keep the originating parent activity row in sync with the target
    // receipt. The parent row is the user-visible delivery acknowledgement;
    // the target user_message remains the durable runtime receipt.
    // Parent activity is a best-effort projection. The target receipt above is
    // the acceptance record; lookup, update, or broadcast failures here must
    // never turn an accepted message into a retryable dispatch.
    if (typeof (this as Any).updateAgentMessageSenderProjection === "function") {
      this.updateAgentMessageSenderProjection(taskId, messageId, payload, "delivered", deliveredAt);
    } else {
      // Keep lightweight daemon doubles and older embedders compatible with
      // the projection path while the full prototype is not installed.
      try {
        const senderTaskId =
          typeof payload.senderTaskId === "string" ? payload.senderTaskId.trim() : "";
        const senderEvent = senderTaskId
          ? readDurableTaskEvents(this, senderTaskId, "agent_message")
              .slice()
              .reverse()
              .find((candidate) => {
                const candidatePayload = candidate.payload as Record<string, unknown> | undefined;
                return (
                  candidatePayload?.messageId === messageId &&
                  candidatePayload?.targetTaskId === taskId
                );
              })
          : undefined;
        if (senderEvent) {
          const senderPayload = {
            ...((senderEvent.payload as Record<string, unknown> | undefined) || {}),
            status: "delivered",
            deliveryStatus: "delivered",
            deliveredAt,
          };
          this.eventRepo.updatePayloadById(senderEvent.id, senderPayload);
          this.emitTaskEvent({ ...senderEvent, payload: senderPayload });
        }
      } catch {
        // Parent projection is best effort after target delivery is durable.
      }
    }
    if (typeof (this as Any).releaseQueuedAttachmentRefs === "function") {
      this.releaseQueuedAttachmentRefs(taskId, messageId, payload);
    }
    return true;
  }

  /** Mark a queued handoff as failed, or quarantine it when authorization is gone. */
  markQueuedAgentMessageFailed(
    taskId: string,
    messageId: string,
    error: string,
    options?: { quarantined?: boolean; failureCode?: string },
  ): boolean {
    const event = readDurableTaskEvents(this, taskId, "user_message")
      .slice()
      .reverse()
      .find((candidate) => {
        const payload = candidate.payload as Record<string, unknown> | undefined;
        return payload?.messageId === messageId && payload.deliveryMode === "message";
      });
    if (!event) return false;
    const existingPayload = (event.payload as Record<string, unknown> | undefined) || {};
    if (
      existingPayload.deliveryStatus === "delivered" ||
      existingPayload.status === "delivered" ||
      existingPayload.deliveryStatus === "failed" ||
      existingPayload.status === "failed" ||
      existingPayload.deliveryStatus === "quarantined" ||
      existingPayload.status === "quarantined"
    ) {
      return false;
    }
    const failedAt =
      typeof existingPayload.failedAt === "number" ? existingPayload.failedAt : Date.now();
    const deliveryStatus = options?.quarantined ? "quarantined" : "failed";
    const payload: Record<string, unknown> = {
      ...existingPayload,
      status: deliveryStatus,
      deliveryStatus,
      ...(options?.quarantined ? { quarantinedAt: failedAt } : { failedAt }),
      ...(options?.failureCode ? { failureCode: options.failureCode } : {}),
      error,
    };
    this.eventRepo.updatePayloadById(event.id, payload);
    try {
      this.emitTaskEvent({ ...event, payload });
    } catch {
      // The durable failure is sufficient for a later UI refresh.
    }

    this.updateAgentMessageSenderProjection(taskId, messageId, payload, deliveryStatus, failedAt);
    if (typeof (this as Any).releaseQueuedAttachmentRefs === "function") {
      this.releaseQueuedAttachmentRefs(taskId, messageId, payload);
    }
    return true;
  }

  private updateAgentMessageSenderProjection(
    targetTaskId: string,
    messageId: string,
    targetPayload: Record<string, unknown>,
    status: "started" | "delivered" | "failed" | "quarantined",
    timestamp: number,
  ): void {
    try {
      const senderTaskId =
        typeof targetPayload.senderTaskId === "string" ? targetPayload.senderTaskId.trim() : "";
      if (!senderTaskId) return;
      // A correlated bot reply becomes a reply only after its target-side
      // receipt reaches the durable incorporated state. Queue admission and
      // wake-up are intentionally not enough: the sender UI must continue to
      // say that it is waiting until the receiver has actually consumed the
      // message. Run this before looking up the sender projection so a fast
      // receiver cannot win a race against the sender's activity row.
      if (status === "delivered") {
        const originalMessageId =
          typeof targetPayload.inReplyToMessageId === "string"
            ? targetPayload.inReplyToMessageId.trim()
            : "";
        const originalSenderTaskId =
          typeof targetPayload.inReplyToTaskId === "string"
            ? targetPayload.inReplyToTaskId.trim()
            : "";
        if (originalMessageId && originalSenderTaskId) {
          this.markBotHandoffReplied(
            originalSenderTaskId,
            originalMessageId,
            senderTaskId,
            senderTaskId,
            messageId,
          );
        }
      }
      const senderEvent = readDurableTaskEvents(this, senderTaskId, "agent_message")
        .slice()
        .reverse()
        .find((candidate) => {
          const candidatePayload = candidate.payload as Record<string, unknown> | undefined;
          return (
            candidatePayload?.messageId === messageId &&
            candidatePayload?.targetTaskId === targetTaskId
          );
        });
      if (!senderEvent) return;
      const senderPayload: Record<string, unknown> = {
        ...((senderEvent.payload as Record<string, unknown> | undefined) || {}),
        status,
        deliveryStatus: status,
        ...(status === "started" ? { startedAt: timestamp } : {}),
        ...(status === "delivered" ? { deliveredAt: timestamp } : {}),
        ...(status === "failed" ? { failedAt: timestamp } : {}),
        ...(status === "quarantined" ? { quarantinedAt: timestamp } : {}),
        ...(typeof targetPayload.failureCode === "string"
          ? { failureCode: targetPayload.failureCode }
          : {}),
        ...(typeof targetPayload.error === "string" ? { error: targetPayload.error } : {}),
      };
      try {
        this.eventRepo.updatePayloadById(senderEvent.id, senderPayload);
      } catch {
        // Target state is authoritative if the parent projection fails.
      }
      try {
        this.emitTaskEvent({ ...senderEvent, payload: senderPayload });
      } catch {
        // Parent broadcast is best effort after the target state is durable.
      }
    } catch {
      // Parent lookup is best effort after the target state is durable.
    }
  }

  private markBotHandoffTimedOut(
    historicalEvents: TaskEvent[],
    pendingHandoff: PendingBotHandoff,
    reason: string,
  ): boolean {
    const event = historicalEvents
      .slice()
      .reverse()
      .find((candidate) => {
        if (candidate.type !== "agent_message" && candidate.legacyType !== "agent_message") {
          return false;
        }
        const payload = candidate.payload as Record<string, unknown> | undefined;
        return (
          payload?.messageId === pendingHandoff.messageId &&
          payload?.targetTaskId === pendingHandoff.recipientTaskId
        );
      });
    if (!event) return false;
    const existingPayload = (event.payload as Record<string, unknown> | undefined) || {};
    if (existingPayload.replyStatus === "received") return false;
    const replyTimedOutAt = Date.now();
    const payload = {
      ...existingPayload,
      replyStatus: "timed_out",
      replyTimedOutAt,
      failureCode: "BOT_HANDOFF_REPLY_TIMEOUT",
      replyTimeoutReason: reason,
    } satisfies Record<string, unknown>;
    this.eventRepo.updatePayloadById(event.id, payload);
    this.clearBotHandoffTimeout(event.taskId);
    // Keep this replay buffer consistent so multiple terminal teammates can be
    // expired in one completion pass without waiting for a second turn.
    event.payload = payload;
    try {
      this.emitTaskEvent({ ...event, payload });
    } catch {
      // Durable timeout state is authoritative when the renderer is offline.
    }
    return true;
  }

  private clearBotHandoffTimeout(taskId: string): void {
    const handle = this.botHandoffTimeouts?.get(taskId);
    if (!handle) return;
    clearTimeout(handle);
    this.botHandoffTimeouts.delete(taskId);
  }

  /**
   * Age anchor for a pending handoff's reply deadline. A handoff still queued
   * behind a busy teammate has not been delivered, so it has no anchor yet.
   */
  private getBotHandoffTimeoutAnchor(handoff: PendingBotHandoff): number | undefined {
    return (
      handoff.startedAt ??
      handoff.deliveredAt ??
      (handoff.deliveryStatus === "queued" ? undefined : (handoff.acceptedAt ?? handoff.queuedAt))
    );
  }

  private scheduleBotHandoffTimeout(taskId: string, handoff: PendingBotHandoff): void {
    this.botHandoffTimeouts ||= new Map();
    this.clearBotHandoffTimeout(taskId);
    // Unanchored (still queued) handoffs are re-checked later instead of expired.
    const anchor = this.getBotHandoffTimeoutAnchor(handoff) ?? Date.now();
    const delay = Math.max(
      1,
      Math.min(2_147_483_647, anchor + BOT_HANDOFF_REPLY_TIMEOUT_MS - Date.now()),
    );
    const handle = setTimeout(() => {
      this.botHandoffTimeouts.delete(taskId);
      this.expireBotHandoffWait(taskId, handoff.messageId);
    }, delay);
    if (typeof handle === "object" && "unref" in handle) handle.unref();
    this.botHandoffTimeouts.set(taskId, handle);
  }

  private rehydrateBotHandoffTimeoutsOnStartup(): void {
    const blockedTasks = this.taskRepo.findByStatus("blocked");
    for (const task of blockedTasks) {
      if (
        task.agentConfig?.botConversation !== true ||
        !/^Waiting for .+ to reply before finishing this conversation\.$/i.test(task.error || "")
      ) {
        continue;
      }
      const events = this.eventRepo.findByTaskId(task.id);
      const handoff = getPendingBotHandoff(events, getCurrentBotHandoffScope(events));
      if (handoff) {
        this.scheduleBotHandoffTimeout(task.id, handoff);
        continue;
      }
      // Older runtimes could persist a waiting task_status after the reply was
      // incorporated or after its handoff fell outside the active turn. There
      // is no durable pending handoff to wake, so stop advertising a wait.
      const reason =
        "No outstanding teammate reply is pending for this conversation. Review the prior result or retry.";
      this.taskRepo.update(task.id, {
        status: "blocked",
        terminalStatus: "needs_user_action",
        failureClass: "contract_error",
        error: reason,
      });
      this.logEvent(task.id, "task_status", {
        status: "blocked",
        message: reason,
        recovery: "stale_bot_handoff_wait",
      });
    }
  }

  private expireBotHandoffWait(taskId: string, expectedMessageId: string): void {
    if (this.shutdownRequested) return;
    const task = this.taskRepo.findById(taskId);
    if (task?.status !== "blocked" || task.agentConfig?.botConversation !== true) return;
    const events = this.eventRepo.findByTaskId(taskId);
    const handoff = getPendingBotHandoff(events, getCurrentBotHandoffScope(events));
    if (!handoff) return;
    if (handoff.messageId !== expectedMessageId) {
      // The awaited handoff changed (for example the latest one failed); keep a
      // deadline on the one that is still pending.
      this.scheduleBotHandoffTimeout(taskId, handoff);
      return;
    }
    const anchor = this.getBotHandoffTimeoutAnchor(handoff);
    if (typeof anchor !== "number" || Date.now() - anchor < BOT_HANDOFF_REPLY_TIMEOUT_MS) {
      this.scheduleBotHandoffTimeout(taskId, handoff);
      return;
    }
    const reason = `No correlated reply arrived from ${handoff.recipientLabel} within ${Math.round(BOT_HANDOFF_REPLY_TIMEOUT_MS / 1000)} seconds. Review the partial result or retry.`;
    if (!this.markBotHandoffTimedOut(events, handoff, reason)) return;
    this.taskRepo.update(taskId, {
      status: "blocked",
      terminalStatus: "needs_user_action",
      failureClass: "contract_error",
      error: reason,
    });
    this.logEvent(taskId, "log", {
      metric: "bot_handoff_reply_timeout",
      code: "BOT_HANDOFF_REPLY_TIMEOUT",
      handoffMessageId: handoff.messageId,
      recipientTaskId: handoff.recipientTaskId,
      recipientLabel: handoff.recipientLabel,
      reason,
      partialResultAvailable: Boolean(task.resultSummary),
    });
    this.logEvent(taskId, "task_status", {
      status: "blocked",
      message: reason,
      handoffMessageId: handoff.messageId,
      recipientTaskId: handoff.recipientTaskId,
    });
  }

  private reconcileBotHandoffBeforeCompletion(
    task: Task,
    historicalEvents: TaskEvent[],
    resultSummary?: string,
  ): { deferred: boolean; replySent: boolean } {
    if (task.agentConfig?.botConversation !== true) {
      return { deferred: false, replySent: false };
    }

    const scope = getCurrentBotHandoffScope(historicalEvents);
    let pendingHandoff = getPendingBotHandoff(historicalEvents, scope);
    while (pendingHandoff) {
      const taskRepo = this.taskRepo as Any;
      const canInspectRecipient = typeof taskRepo.findById === "function";
      const recipientTask = canInspectRecipient
        ? (taskRepo.findById(pendingHandoff.recipientTaskId) as Task | undefined)
        : undefined;
      const recipientIsTerminal =
        canInspectRecipient &&
        (!recipientTask || isTerminalTaskStatus(deriveCanonicalTaskStatus(recipientTask)));
      const timeoutAnchor = this.getBotHandoffTimeoutAnchor(pendingHandoff);
      const timedOutByAge =
        typeof timeoutAnchor === "number" &&
        Date.now() - timeoutAnchor >= BOT_HANDOFF_REPLY_TIMEOUT_MS;
      if (!recipientIsTerminal && !timedOutByAge) break;
      // The recipient can finish before its queued correlated reply is
      // consumed by this task. A terminal recipient is not proof of a missing
      // reply while that durable delivery receipt is still in flight.
      const pendingMessageId = pendingHandoff.messageId;
      const correlatedReplyInFlight = historicalEvents.some((event) => {
        if (event.type !== "user_message" && event.legacyType !== "user_message") return false;
        const payload = event.payload as Record<string, unknown> | undefined;
        return (
          payload?.inReplyToMessageId === pendingMessageId &&
          (payload.deliveryStatus === "accepted" ||
            payload.deliveryStatus === "queued" ||
            payload.deliveryStatus === "started")
        );
      });
      if (recipientIsTerminal && correlatedReplyInFlight && !timedOutByAge) break;

      const reason = recipientIsTerminal
        ? `Recipient ${pendingHandoff.recipientLabel} is no longer active.`
        : `No correlated reply arrived within ${Math.round(BOT_HANDOFF_REPLY_TIMEOUT_MS / 1000)} seconds.`;
      if (!this.markBotHandoffTimedOut(historicalEvents, pendingHandoff, reason)) break;
      this.logEvent(task.id, "log", {
        metric: "bot_handoff_reply_timeout",
        code: "BOT_HANDOFF_REPLY_TIMEOUT",
        handoffMessageId: pendingHandoff.messageId,
        recipientTaskId: pendingHandoff.recipientTaskId,
        recipientLabel: pendingHandoff.recipientLabel,
        reason,
        partialResultAvailable: true,
      });
      pendingHandoff = getPendingBotHandoff(historicalEvents, scope);
    }
    if (pendingHandoff) {
      const detail = `Waiting for ${pendingHandoff.recipientLabel} to reply before finishing this conversation.`;
      this.taskRepo.update(task.id, {
        status: "blocked",
        completedAt: undefined,
        terminalStatus: undefined,
        failureClass: undefined,
        error: detail,
        ...(resultSummary ? { resultSummary } : {}),
      });
      this.logEvent(task.id, "task_status", {
        status: "blocked",
        message: detail,
        botHandoffWaiting: true,
        handoffMessageId: pendingHandoff.messageId,
        recipientTaskId: pendingHandoff.recipientTaskId,
        recipientLabel: pendingHandoff.recipientLabel,
        deliveryStatus: pendingHandoff.deliveryStatus,
      });
      this.scheduleBotHandoffTimeout(task.id, pendingHandoff);
      return { deferred: true, replySent: false };
    }

    const requirement = getOutstandingBotHandoffReply(historicalEvents, scope);
    if (!requirement) return { deferred: false, replySent: false };

    const sender = this.taskRepo.findById(requirement.senderTaskId);
    const cannotReply =
      !sender ||
      !this.canDeliverBotMessageBetween(task, sender) ||
      !sender.agentConfig?.botConversation;
    if (cannotReply) {
      const detail =
        "The teammate reply could not be delivered because the sender is no longer available in the same bot team.";
      this.taskRepo.update(task.id, {
        status: "blocked",
        completedAt: undefined,
        terminalStatus: "needs_user_action",
        failureClass: "contract_error",
        error: detail,
        ...(resultSummary ? { resultSummary } : {}),
      });
      this.logEvent(task.id, "error", {
        code: "BOT_HANDOFF_REPLY_REQUIRED",
        message: detail,
        inboundMessageId: requirement.inboundMessageId,
        senderTaskId: requirement.senderTaskId,
      });
      return { deferred: true, replySent: false };
    }

    const fallbackMessage = [
      "BLOCKED: I could not finish this handoff with a verified result.",
      resultSummary
        ? `Partial result: ${resultSummary.slice(0, 600)}`
        : "No verified result was produced.",
      "Please review the partial work and retry with a narrower brief if needed.",
    ].join("\n");
    const replyMessageId = crypto
      .createHash("sha256")
      .update(`bot-handoff-recovery:${task.id}:${requirement.inboundMessageId}`, "utf8")
      .digest("hex");
    try {
      const result = this.queueMessageOnly(sender, fallbackMessage, undefined, undefined, {
        deliveryMode: "message",
        messageSource: "agent",
        messageId: replyMessageId,
        senderTaskId: task.id,
        senderLabel: task.title,
        inReplyToMessageId: requirement.inboundMessageId,
        inReplyToTaskId: requirement.senderTaskId,
        startAfterAccepted: true,
      });
      const status = result.deliveryStatus || (result.queued ? "queued" : "delivered");
      const timestamp = Date.now();
      this.logEvent(task.id, "agent_message", {
        messageId: replyMessageId,
        correlationId: replyMessageId,
        targetTaskId: sender.id,
        message: fallbackMessage,
        status,
        deliveryStatus: status,
        deliveryMode: "message",
        acceptedAt: result.acceptedAt ?? timestamp,
        ...(status === "queued" ? { queuedAt: result.queuedAt ?? timestamp } : {}),
        ...(status === "started" ? { startedAt: result.startedAt ?? timestamp } : {}),
        ...(status === "delivered" ? { deliveredAt: result.deliveredAt ?? timestamp } : {}),
        senderType: "agent",
        senderTaskId: task.id,
        senderLabel: task.title,
        recipientLabel: sender.title,
        ...(task.agentConfig?.botTeamId ? { botTeamId: task.agentConfig.botTeamId } : {}),
        inReplyToMessageId: requirement.inboundMessageId,
        inReplyToTaskId: requirement.senderTaskId,
        replyKind: "automatic_blocked_fallback",
      });
      // Queue-only delivery is not a received reply yet. The originating
      // handoff is marked when the sender consumes this durable receipt; keep
      // the immediate path only for a transport that explicitly reports the
      // receiver-side delivery boundary.
      if (status === "delivered") {
        this.markBotHandoffReplied(
          requirement.senderTaskId,
          requirement.inboundMessageId,
          task.id,
          task.id,
          replyMessageId,
        );
      }
      this.logEvent(task.id, "task_status", {
        status: "partial_success",
        message: "A blocked reply was sent to the requesting teammate.",
        botHandoffReplySent: true,
        inboundMessageId: requirement.inboundMessageId,
        replyMessageId,
        deliveryStatus: status,
      });
      return { deferred: false, replySent: true };
    } catch (error) {
      const detail = `The teammate reply could not be delivered: ${String(error)}`;
      this.taskRepo.update(task.id, {
        status: "blocked",
        completedAt: undefined,
        terminalStatus: "needs_user_action",
        failureClass: "contract_error",
        error: detail,
        ...(resultSummary ? { resultSummary } : {}),
      });
      this.logEvent(task.id, "error", {
        code: "BOT_HANDOFF_REPLY_DELIVERY_FAILED",
        message: detail,
        inboundMessageId: requirement.inboundMessageId,
        senderTaskId: requirement.senderTaskId,
      });
      return { deferred: true, replySent: false };
    }
  }

  /**
   * Follow-up execution has its own terminalization path in TaskExecutor.
   * Keep that path behind the same durable bot-handoff gate as normal task
   * completion so a persisted completed row cannot swallow a pending reply.
   */
  reconcileBotHandoffBeforeFollowUpCompletion(
    taskId: string,
    resultSummary?: string,
  ): { deferred: boolean; replySent: boolean } {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.agentConfig?.botConversation !== true) {
      return { deferred: false, replySent: false };
    }
    return this.reconcileBotHandoffBeforeCompletion(
      task,
      this.getTaskEventsForReplay(taskId),
      resultSummary,
    );
  }

  /** Mark the originating handoff when a teammate sends a correlated reply. */
  markBotHandoffReplied(
    originalSenderTaskId: string,
    originalMessageId: string,
    originalTargetTaskId: string,
    replyTaskId: string,
    replyMessageId: string,
  ): boolean {
    const senderTaskId =
      typeof originalSenderTaskId === "string" ? originalSenderTaskId.trim() : "";
    const messageId = typeof originalMessageId === "string" ? originalMessageId.trim() : "";
    const targetTaskId =
      typeof originalTargetTaskId === "string" ? originalTargetTaskId.trim() : "";
    const replyId = typeof replyMessageId === "string" ? replyMessageId.trim() : "";
    if (!senderTaskId || !messageId || !targetTaskId || !replyId) return false;
    const event = readDurableTaskEvents(this, senderTaskId, "agent_message")
      .slice()
      .reverse()
      .find((candidate) => {
        const payload = candidate.payload as Record<string, unknown> | undefined;
        return payload?.messageId === messageId && payload?.targetTaskId === targetTaskId;
      });
    if (!event) return false;
    const existingPayload = (event.payload as Record<string, unknown> | undefined) || {};
    if (existingPayload.replyStatus === "received" && existingPayload.replyMessageId === replyId) {
      return true;
    }
    const repliedAt = Date.now();
    const payload = {
      ...existingPayload,
      replyStatus: "received",
      replyMessageId: replyId,
      replyTaskId,
      repliedAt,
    } satisfies Record<string, unknown>;
    this.eventRepo.updatePayloadById(event.id, payload);
    this.clearBotHandoffTimeout(senderTaskId);
    try {
      this.emitTaskEvent({ ...event, payload });
    } catch {
      // Durable correlation is authoritative when the renderer is offline.
    }
    return true;
  }

  private releaseQueuedAttachmentRefs(
    taskId: string,
    messageId: string,
    payload: Record<string, unknown> | undefined,
  ): void {
    if (!Array.isArray(payload?.queuedAttachmentRefs)) return;
    try {
      this.getQueuedAttachmentStore().release(taskId, messageId, payload.queuedAttachmentRefs);
    } catch {
      // Receipt delivery is already durable; cleanup is best effort and must
      // never make a delivered message retryable.
    }
  }

  /**
   * Capture schema-valid durable refs before a task row and its events are
   * deleted. The caller must release the captured refs only after deletion
   * succeeds so a failed delete remains retryable.
   */
  captureQueuedAttachmentRefsForTask(taskId: string): Array<{
    messageId: string;
    refs: QueuedAttachmentRef[];
  }> {
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    if (!normalizedTaskId) return [];
    let events: TaskEvent[];
    try {
      events = readDurableTaskEvents(this, normalizedTaskId, "user_message");
    } catch {
      return [];
    }
    const captured: Array<{ messageId: string; refs: QueuedAttachmentRef[] }> = [];
    for (const event of events) {
      const payload = event.payload as Record<string, unknown> | undefined;
      const messageId = typeof payload?.messageId === "string" ? payload.messageId.trim() : "";
      if (!messageId || !Array.isArray(payload?.queuedAttachmentRefs)) continue;
      try {
        const refs = this.getQueuedAttachmentStore().validateRefs(
          normalizedTaskId,
          messageId,
          payload.queuedAttachmentRefs,
        );
        if (refs.length > 0) captured.push({ messageId, refs });
      } catch {
        // Invalid receipt metadata cannot authorize filesystem deletion. It
        // remains retained for the conservative orphan sweep.
      }
    }
    return captured;
  }

  /** Release refs captured before a successful task deletion. */
  releaseCapturedQueuedAttachmentRefs(
    taskId: string,
    captured: Array<{ messageId: string; refs: QueuedAttachmentRef[] }>,
  ): void {
    if (!Array.isArray(captured)) return;
    for (const entry of captured) {
      if (!entry || typeof entry.messageId !== "string" || !Array.isArray(entry.refs)) continue;
      try {
        this.getQueuedAttachmentStore().release(taskId, entry.messageId, entry.refs);
      } catch {
        // Deletion is already durable; cleanup can be retried by orphan GC.
      }
    }
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
      action === "skip" ? "skipped" : action === "stop" ? "cancelled" : "in_progress";
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
    if (this.shutdownRequested || executor.isRunning || this.drainingFollowUps.has(taskId)) return;
    this.drainingFollowUps.add(taskId);
    // Leave later messages in the runtime snapshot while processing each turn.
    const drain = async () => {
      let followUp = executor.takeNextFollowUpAtTurnBoundary();
      while (followUp && !this.shutdownRequested) {
        const currentFollowUp = followUp;
        if (this.shutdownRequested) {
          (executor.runtime as Any)?.requeueFollowUpAtTurnBoundary?.(followUp);
          break;
        }
        const runtime = executor.runtime as Any;
        const queuedAgentMessageStatus =
          followUp.deliveryMode === "message" && followUp.messageId
            ? this.getQueuedAgentMessageDeliveryStatus(taskId, followUp.messageId)
            : undefined;
        if (queuedAgentMessageStatus === "delivered") {
          // A crash can leave an older runtime snapshot containing an item
          // whose receipt was already accepted. The receipt wins, so discard
          // the stale queue copy without dispatching it again.
          if (
            followUp.messageId &&
            runtime &&
            typeof runtime.removeFollowUpAtTurnBoundary === "function"
          ) {
            runtime.removeFollowUpAtTurnBoundary(followUp.messageId);
            if (typeof runtime.saveSnapshot === "function") runtime.saveSnapshot();
          }
          followUp = executor.takeNextFollowUpAtTurnBoundary();
          continue;
        }
        const followUpMessageId =
          followUp.deliveryMode === "message" && typeof followUp.messageId === "string"
            ? followUp.messageId.trim()
            : "";
        if (
          followUpMessageId &&
          runtime &&
          typeof runtime.isFollowUpMessageConsumed === "function" &&
          runtime.isFollowUpMessageConsumed(followUpMessageId)
        ) {
          // The transcript/consumed marker is durable, but receipt persistence
          // may have failed. Retry only that receipt and never call the
          // executor with the already-incorporated message again.
          try {
            if (!this.markQueuedAgentMessageDelivered(taskId, followUpMessageId)) {
              throw new Error(`Queued follow-up ${followUpMessageId} has no durable receipt.`);
            }
          } catch (error) {
            if (typeof runtime.requeueFollowUpAtTurnBoundary === "function") {
              runtime.requeueFollowUpAtTurnBoundary(followUp);
            }
            this.logEvent(taskId, "error", {
              message: "Queued follow-up receipt retry failed",
              error: String(error),
            });
            break;
          }
          if (typeof runtime.removeFollowUpAtTurnBoundary === "function") {
            runtime.removeFollowUpAtTurnBoundary(followUpMessageId);
            if (typeof runtime.saveSnapshot === "function") runtime.saveSnapshot();
          }
          followUp = executor.takeNextFollowUpAtTurnBoundary();
          continue;
        }
        try {
          if (followUpMessageId) {
            const started = this.markQueuedAgentMessageStarted(taskId, followUpMessageId);
            const durableStatus = this.getQueuedAgentMessageDeliveryStatus(
              taskId,
              followUpMessageId,
            );
            if (!started && (durableStatus === "quarantined" || durableStatus === "failed")) {
              if (runtime && typeof runtime.removeFollowUpAtTurnBoundary === "function") {
                runtime.removeFollowUpAtTurnBoundary(followUpMessageId);
                if (typeof runtime.saveSnapshot === "function") runtime.saveSnapshot();
              }
              followUp = executor.takeNextFollowUpAtTurnBoundary();
              continue;
            }
          }
          this.logEvent(taskId, "agent_follow_up_started", {
            ...(followUp.messageId ? { messageId: followUp.messageId } : {}),
            deliveryMode: followUp.deliveryMode || "follow_up",
            startedAt: Date.now(),
            ...(followUp.messageSource ? { messageSource: followUp.messageSource } : {}),
            ...(followUp.senderTaskId ? { senderTaskId: followUp.senderTaskId } : {}),
            ...(followUp.senderLabel ? { senderLabel: followUp.senderLabel } : {}),
            ...(followUp.inReplyToMessageId
              ? { inReplyToMessageId: followUp.inReplyToMessageId }
              : {}),
            ...(followUp.inReplyToTaskId ? { inReplyToTaskId: followUp.inReplyToTaskId } : {}),
          });
          if (!(followUp.deliveryMode === "message" && followUp.messageId)) {
            executor.suppressNextUserMessageEvent();
          }
          const delivery = await this.sendMessage(
            taskId,
            followUp.message,
            followUp.images,
            followUp.quotedAssistantMessage,
            {
              ...(Object.prototype.hasOwnProperty.call(followUp, "integrationMentions")
                ? { integrationMentions: followUp.integrationMentions }
                : {}),
              agentConfigOverride: followUp.agentConfigOverride,
              interactionMode: followUp.interactionMode,
              // A previously accepted queue-only message becomes a normal
              // worker turn only when this recovery path explicitly starts it.
              deliveryMode: "follow_up",
              messageSource: followUp.messageSource,
              messageId: followUp.messageId,
              senderTaskId: followUp.senderTaskId,
              senderLabel: followUp.senderLabel,
              inReplyToMessageId: followUp.inReplyToMessageId,
              inReplyToTaskId: followUp.inReplyToTaskId,
              suppressUserMessageEvent:
                followUp.deliveryMode === "message" && followUp.messageId !== undefined,
              queuedFollowUp: followUp,
            },
          );
          // The running worker will pick up the retained item. Re-reading a
          // peeked queue head here would spin while that worker is active.
          if (delivery?.queued) break;
        } catch (error) {
          const deliveryStatus =
            currentFollowUp.deliveryMode === "message" && currentFollowUp.messageId
              ? this.getQueuedAgentMessageDeliveryStatus(taskId, currentFollowUp.messageId)
              : undefined;
          if (
            currentFollowUp.deliveryMode === "message" &&
            currentFollowUp.messageId &&
            deliveryStatus !== "delivered" &&
            runtime &&
            typeof runtime.requeueFollowUpAtTurnBoundary === "function"
          ) {
            // Pre-acceptance failures remain retryable. Put the exact payload
            // back at the front and stop this drain so a later worker turn can
            // retry it without reordering or silently dropping the message.
            // A consumed marker makes this an acknowledgement-only retry; the
            // branch above suppresses provider replay in that case.
            runtime.requeueFollowUpAtTurnBoundary(currentFollowUp);
          }
          this.logEvent(taskId, "error", {
            message: "Queued follow-up failed",
            error: String(error),
          });
          if (currentFollowUp.deliveryMode === "message" && currentFollowUp.messageId) break;
        }
        followUp = executor.takeNextFollowUpAtTurnBoundary();
      }
    };
    void drain().finally(() => this.drainingFollowUps.delete(taskId));
  }

  // ===== Queue Management Methods =====

  /**
   * Update the initial prompt for a task that is still waiting in the queue.
   * Once execution starts, the prompt is part of the task's immutable run
   * context and must not be changed underneath the executor.
   */
  updateQueuedTaskPrompt(taskId: string, prompt: string): Task {
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    const normalizedPrompt = typeof prompt === "string" ? prompt.trim() : "";
    const task = this.taskRepo.findById(normalizedTaskId);

    if (!task || task.status !== "queued" || !this.queueManager.isQueued(normalizedTaskId)) {
      throw new Error("Only queued tasks can have their prompt edited.");
    }
    if (!normalizedPrompt) {
      throw new Error("Task prompt cannot be empty.");
    }

    this.taskRepo.update(normalizedTaskId, {
      prompt: normalizedPrompt,
      rawPrompt: normalizedPrompt,
      userPrompt: normalizedPrompt,
    });

    const updatedTask = this.taskRepo.findById(normalizedTaskId);
    if (!updatedTask) {
      throw new Error(`Task ${normalizedTaskId} was not found after updating its prompt.`);
    }
    return updatedTask;
  }

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
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    log.info("Shutting down agent daemon...");
    const shutdownErrors: unknown[] = [];
    try {
      this.orchestrationGraphEngine.stop();
    } catch (error) {
      console.error("[AgentDaemon] Failed to stop orchestration graph:", error);
      shutdownErrors.push(error);
    }
    try {
      this.workSessionProtocolService.getReliabilityService().stop();
    } catch (error) {
      console.error("[AgentDaemon] Failed to stop reliability service:", error);
      shutdownErrors.push(error);
    }

    // Clear the cleanup interval
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = undefined;
    }

    // Clear the database maintenance interval
    if (this.maintenanceIntervalHandle) {
      clearInterval(this.maintenanceIntervalHandle);
      this.maintenanceIntervalHandle = undefined;
    }

    // Prevent retry timers that were already scheduled from admitting work
    // after the shutdown fence. The queue manager may still invoke its callback
    // for a late dequeue; startTaskImmediate has its own admission guard.
    this.pendingRetries.forEach((handle) => clearTimeout(handle));
    this.pendingRetries.clear();
    this.botHandoffTimeouts?.forEach((handle) => clearTimeout(handle));
    this.botHandoffTimeouts?.clear();

    // A queue-manager callback may already be inside startTaskImmediate and
    // waiting on worktree/database setup. Let it either finish activation
    // before task snapshots/cancellation, or observe the fence and return.
    if (!(await this.waitForAdmittedStarts(5000))) {
      shutdownErrors.push(new Error("task admission did not quiesce within 5000ms"));
    }

    // Clear all pending approval timeouts and reject pending promises
    this.pendingApprovals.forEach((pending, _approvalId) => {
      clearTimeout(pending.timeoutHandle);
      if (pending.abortSignal && pending.abortListener) {
        pending.abortSignal.removeEventListener("abort", pending.abortListener);
      }
      if (!pending.resolved) {
        pending.resolved = true;
        pending.reject(new Error("Daemon shutting down"));
      }
    });
    this.pendingApprovals.clear();
    this.pendingDurableApprovalGrants.clear();
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
      const currentTask = this.taskRepo.findById(taskId);
      // A retained executor may have completed a follow-up via a direct task
      // update. Never turn a durable terminal result into a restart request.
      if (currentTask && isTerminalTaskStatus(deriveCanonicalTaskStatus(currentTask))) return;

      // Best-effort snapshot save
      try {
        cached.executor.saveConversationSnapshot();
      } catch (err) {
        console.error(`[AgentDaemon] Failed to save snapshot for task ${taskId} on shutdown:`, err);
      }

      // Mark as "interrupted" instead of "cancelled" so we can resume on restart
      try {
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
    const cancellationErrors: unknown[] = [];
    this.activeTasks.forEach((cached, taskId) => {
      const promise = cached.executor.cancel("shutdown").catch((err) => {
        console.error(`Error cancelling task ${taskId}:`, err);
        cancellationErrors.push(err);
      });
      cancelPromises.push(promise);
    });

    // Wait for all cancellations to complete (with timeout)
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    let cancellationTimedOut = false;
    try {
      await Promise.race([
        Promise.all(cancelPromises),
        new Promise<void>((resolve) => {
          cancellationTimer = setTimeout(() => {
            cancellationTimedOut = true;
            resolve();
          }, 5000);
        }),
      ]);
    } finally {
      if (cancellationTimer) clearTimeout(cancellationTimer);
    }

    // A failed or timed-out cancellation does not establish quiescence. Keep
    // active task references and listeners alive so late workers can finish
    // against live dependencies; the graceful-shutdown coordinator will skip
    // MCP/memory/database release steps and let process exit retire them.
    if (cancellationTimedOut || cancellationErrors.length > 0 || shutdownErrors.length > 0) {
      const reasons = [
        ...shutdownErrors.map((error) => String((error as Any)?.message || error)),
        ...cancellationErrors.map((error) => String((error as Any)?.message || error)),
        ...(cancellationTimedOut ? ["task cancellation timed out after 5000ms"] : []),
      ];
      throw new Error(
        `Agent daemon shutdown did not reach quiescence: ${reasons.join("; ") || "unknown stop failure"}`,
      );
    }

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
