import { GuardrailManager } from "../../guardrails/guardrail-manager";
import { LLMProviderFactory } from "../llm/provider-factory";
import { randomUUID } from "crypto";
import { getInteractionModeSelection } from "../../../shared/interaction-mode";
import {
  compactPreview,
  CONTEXT_COMPACTION_OVERFLOW_TARGET_RATIO,
  DEFAULT_CONTEXT_COMPACTION_TARGET_RATIO,
  DEFAULT_CONTEXT_COMPACTION_TRIGGER_RATIO,
  isContextCompactionEventPayload,
  isContextCompactionEventType,
  resolveContextCompactionPolicy,
  type ContextCompactionEventType,
  type ContextCompactionEventPayload,
  type ContextCompactionPhase,
  type ContextCompactionStatus,
  type ContextCompactionTrigger,
} from "../../../shared/context-compaction";
import type {
  ImageAttachment,
  LlmProfile,
  PendingSkillParameterCollection,
  PermissionMode,
  PermissionPromptDetails,
  PermissionRule,
  Plan,
  QuotedAssistantMessage,
  SensitiveSourceRef,
  SessionChecklistItem,
  SessionChecklistState,
  SessionChecklistToolItemInput,
  TaskDomain,
  TaskFollowUpInput,
  Task,
  TaskEvent,
  VerificationEvidenceEntry,
  WebSearchMode,
  Workspace,
} from "../../../shared/types";
import { TASK_ERROR_CODES } from "../../../shared/types";
import { planHasVerificationStep } from "../../../shared/plan-utils";
import type {
  LLMContent,
  LLMMessage,
  LLMRequest,
  LLMPromptCacheMode,
  LLMSystemBlock,
  LLMTool,
  LLMToolPromptRenderContext,
  PromptCacheProviderFamily,
  StreamProgressCallback,
} from "../llm";
import { estimateTokens, estimateTotalTokens, type ContextManager } from "../context-manager";
import { calculateCost, getCacheTokenAccounting, isModelPriced } from "../llm/pricing";
import { sanitizeToolCallHistory } from "../llm/openai-compatible";
import {
  FileOperationTracker,
  ToolFailureTracker,
  isContextCapacityError,
} from "../executor-helpers";
import { requestLLMResponseWithAdaptiveBudget as requestLLMResponseWithAdaptiveBudgetUtil } from "../executor-llm-turn-utils";
import { filterToolsByPolicy } from "../tool-policy-engine";
import { DeferredToolCatalog } from "./DeferredToolCatalog";
import { ToolSearchService } from "./ToolSearchService";
import {
  QueuedAttachmentRecoveryError,
  QueuedAttachmentStore,
  type QueuedAttachmentRef,
} from "./queued-attachment-store";
import {
  TurnKernel,
  type TurnKernelInput,
  type TurnKernelOutcome,
  type TurnKernelPolicy,
} from "./turn-kernel";
import type { ToolRegistry } from "../tools/registry";
import type { JevContextCompactionResult } from "../jev/context-compaction-decision";
import { DurableContextService } from "../../memory/DurableContextService";
import { InputSanitizer } from "../security/input-sanitizer";

interface WebEvidenceEntry {
  tool: "web_search" | "web_fetch";
  url: string;
  title?: string;
  sourceClass?: "reddit" | "x" | "tech_news";
  publishDate?: string;
  timestamp: number;
}

export interface SessionRuntimeTaskProjection {
  budgetUsage?: Task["budgetUsage"];
  continuationCount: number;
  continuationWindow: number;
  lifetimeTurnsUsed: number;
  compactionCount: number;
  lastCompactionAt?: number;
  lastCompactionTokensBefore?: number;
  lastCompactionTokensAfter?: number;
  noProgressStreak: number;
  lastLoopFingerprint?: string;
}

export interface SessionRuntimeOutputState {
  conversationHistory: LLMMessage[];
  lastUserMessage: string;
  lastAssistantOutput: string | null;
  lastNonVerificationOutput: string | null;
  lastAssistantText: string | null;
  explicitChatSummaryBlock: string | null;
  explicitChatSummaryCreatedAt: number;
  explicitChatSummarySourceMessageCount: number;
  explicitChatSummaryInputSignature?: string;
}

export interface SessionRuntimeCompactionSnapshot {
  historyGeneration: number;
  activeCompactionId?: string | null;
  activeCompactionAttemptId?: string | null;
  lastCompactionId?: string | null;
  lastCompactionAttemptId?: string | null;
  lastCompactionStatus?: ContextCompactionStatus | null;
  lastCompactionTrigger?: ContextCompactionTrigger | null;
  lastCompactionPhase?: ContextCompactionPhase | null;
  lastCompactionInputGeneration?: number;
  lastCompactionInstalledGeneration?: number;
}

export interface SessionRuntimeCompactionLifecycleHandle {
  compactionId: string;
  attemptId: string;
  trigger: ContextCompactionTrigger;
  phase: ContextCompactionPhase;
}

export interface SessionRuntimeCompactionLifecycleOptions {
  trigger: ContextCompactionTrigger;
  phase: ContextCompactionPhase;
  reason: string;
  inputTokens?: number;
  inputMessageCount?: number;
  thresholdRatio?: number;
  targetRatio?: number;
  contextWindowTokens?: number;
  extra?: Record<string, unknown>;
}

export interface SessionRuntimeVerificationState {
  verificationEvidenceEntries: VerificationEvidenceEntry[];
  nonBlockingVerificationFailedStepIds: Set<string>;
  blockingVerificationFailedStepIds: Set<string>;
  dispatchedMentionedAgents: boolean;
  verificationAgentState: Record<string, unknown>;
}

export interface SessionRuntimeRecoveryState {
  recoveryRequestActive: boolean;
  lastRecoveryFailureSignature: string;
  recoveredFailureStepIds: Set<string>;
  lastRecoveryClass:
    | "user_blocker"
    | "local_runtime"
    | "provider_quota"
    | "external_unknown"
    | null;
  lastToolDisabledScope: "provider" | "global" | null;
  lastRetryReason: string | null;
}

export interface SessionRuntimePermissionDenialState {
  consecutiveDenials: number;
  totalDenials: number;
}

export interface SessionRuntimePermissionState {
  mode: PermissionMode;
  sessionRules: PermissionRule[];
  temporaryGrants: Map<string, { grantedAt: number; expiresAt?: number }>;
  denialTracking: Map<string, SessionRuntimePermissionDenialState>;
  latestPromptContext: PermissionPromptDetails | null;
  recentSensitiveSources: SensitiveSourceRef[];
}

export interface SessionRuntimeSnapshotV2 {
  schema: "session_runtime_v2";
  version: 2;
  timestamp: number;
  messageCount: number;
  modelId?: string;
  modelKey?: string;
  llmProfileUsed?: LlmProfile;
  resolvedModelKey?: string;
  conversationHistory: Any[];
  trackerState?: Any;
  planSummary?: Any;
  transcript: {
    lastUserMessage: string;
    lastAssistantOutput: string | null;
    lastNonVerificationOutput: string | null;
    lastAssistantText: string | null;
    explicitChatSummaryBlock: string | null;
    explicitChatSummaryCreatedAt: number;
    explicitChatSummarySourceMessageCount: number;
    explicitChatSummaryInputSignature?: string;
    stepOutcomeSummaries: Array<{
      stepId: string;
      description: string;
      status: "completed" | "failed";
      mutatedFiles: string[];
      outcomeSummary: string;
    }>;
  };
  tooling: {
    toolResultMemory: Array<{ tool: string; summary: string; timestamp: number }>;
    webEvidenceMemory: WebEvidenceEntry[];
    toolUsageCounts: Array<[string, number]>;
    successfulToolUsageCounts: Array<[string, number]>;
    /** Tool successes since the most recent user-request turn. Optional for older V2 snapshots. */
    turnSuccessfulToolUsageCounts?: Array<[string, number]>;
    toolUsageEventsSinceDecay: number;
    toolSelectionEpoch: number;
    discoveredDeferredToolNames: string[];
  };
  files: {
    filesReadTracker: Array<[string, { step: string; sizeBytes: number }]>;
  };
  loop: {
    globalTurnCount: number;
    lifetimeTurnCount: number;
    continuationCount: number;
    continuationWindow: number;
    windowStartEventCount: number;
    noProgressStreak: number;
    lastLoopFingerprint: string;
    compactionCount: number;
    lastCompactionAt: number;
    lastCompactionTokensBefore: number;
    lastCompactionTokensAfter: number;
    blockedLoopFingerprintForWindow: string | null;
    pendingLoopStrategySwitchMessage: string;
    softDeadlineTriggered: boolean;
    wrapUpRequested: boolean;
    turnWindowSoftExhaustedNotified: boolean;
    followUpRecoveryAttemptsInCurrentMessage: number;
    lastFollowUpRecoveryBlockReason: string;
    iterationCount: number;
    currentStepId: string | null;
    lastPreCompactionFlushAt: number;
    lastPreCompactionFlushTokenCount: number;
  };
  recovery: {
    recoveryRequestActive: boolean;
    lastRecoveryFailureSignature: string;
    recoveredFailureStepIds: string[];
    lastRecoveryClass:
      | "user_blocker"
      | "local_runtime"
      | "provider_quota"
      | "external_unknown"
      | null;
    lastToolDisabledScope: "provider" | "global" | null;
    lastRetryReason: string | null;
  };
  queues: {
    pendingFollowUps: TaskFollowUpInput[];
    /** Queue-only follow-ups incorporated into transcript and persisted. */
    consumedFollowUpMessageIds?: string[];
    stepFeedbackSignal: {
      feedbackId?: string;
      stepId: string;
      action: "retry" | "skip" | "stop" | "drift";
      message?: string;
    } | null;
  };
  skills: {
    pendingParameterCollection: PendingSkillParameterCollection | null;
    primarySlashCommandHandled: boolean;
  };
  worker: {
    dispatchedMentionedAgents: boolean;
    verificationAgentState: Record<string, unknown>;
  };
  permissions: {
    mode: PermissionMode;
    sessionRules: PermissionRule[];
    temporaryGrants: Array<[string, { grantedAt: number; expiresAt?: number }]>;
    denialTracking: Array<[string, SessionRuntimePermissionDenialState]>;
    latestPromptContext: PermissionPromptDetails | null;
    recentSensitiveSources: SensitiveSourceRef[];
  };
  verification: {
    verificationEvidenceEntries: VerificationEvidenceEntry[];
    nonBlockingVerificationFailedStepIds: string[];
    blockingVerificationFailedStepIds: string[];
  };
  checklist: SessionChecklistState;
  promptCache: {
    stableSystemBlocks: LLMSystemBlock[];
    stablePrefixHash: string;
    toolSchemaHash: string;
    promptCacheMode: LLMPromptCacheMode;
    promptCacheProviderFamily: PromptCacheProviderFamily;
    promptCacheInvalidationReason: string | null;
    promptCacheTtl?: "5m" | "1h";
  };
  usageTotals: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
  /** Versioned replacement-history metadata. Optional for legacy V2 snapshots. */
  compaction?: SessionRuntimeCompactionSnapshot;
}

export interface SessionRuntimeState {
  transcript: {
    conversationHistory: LLMMessage[];
    lastUserMessage: string;
    lastAssistantOutput: string | null;
    lastNonVerificationOutput: string | null;
    lastAssistantText: string | null;
    explicitChatSummaryBlock: string | null;
    explicitChatSummaryCreatedAt: number;
    explicitChatSummarySourceMessageCount: number;
    explicitChatSummaryInputSignature?: string;
    stepOutcomeSummaries: Array<{
      stepId: string;
      description: string;
      status: "completed" | "failed";
      mutatedFiles: string[];
      outcomeSummary: string;
    }>;
  };
  tooling: {
    toolFailureTracker: ToolFailureTracker;
    toolResultMemory: Array<{ tool: string; summary: string; timestamp: number }>;
    webEvidenceMemory: WebEvidenceEntry[];
    toolUsageCounts: Map<string, number>;
    successfulToolUsageCounts: Map<string, number>;
    turnSuccessfulToolUsageCounts: Map<string, number>;
    toolUsageEventsSinceDecay: number;
    toolSelectionEpoch: number;
    discoveredDeferredToolNames: Set<string>;
    availableToolsCacheKey: string | null;
    availableToolsCache: Any[] | null;
    lastWebFetchFailure: {
      timestamp: number;
      tool: "web_fetch" | "http_request";
      url?: string;
      error?: string;
      status?: number;
    } | null;
  };
  files: {
    fileOperationTracker: FileOperationTracker;
    filesReadTracker: Map<string, { step: string; sizeBytes: number }>;
  };
  loop: {
    globalTurnCount: number;
    lifetimeTurnCount: number;
    continuationCount: number;
    continuationWindow: number;
    windowStartEventCount: number;
    noProgressStreak: number;
    lastLoopFingerprint: string;
    compactionCount: number;
    lastCompactionAt: number;
    lastCompactionTokensBefore: number;
    lastCompactionTokensAfter: number;
    blockedLoopFingerprintForWindow: string | null;
    pendingLoopStrategySwitchMessage: string;
    softDeadlineTriggered: boolean;
    wrapUpRequested: boolean;
    turnWindowSoftExhaustedNotified: boolean;
    followUpRecoveryAttemptsInCurrentMessage: number;
    lastFollowUpRecoveryBlockReason: string;
    iterationCount: number;
    currentStepId: string | null;
    lastPreCompactionFlushAt: number;
    lastPreCompactionFlushTokenCount: number;
  };
  recovery: {
    recoveryRequestActive: boolean;
    lastRecoveryFailureSignature: string;
    recoveredFailureStepIds: Set<string>;
    lastRecoveryClass:
      | "user_blocker"
      | "local_runtime"
      | "provider_quota"
      | "external_unknown"
      | null;
    lastToolDisabledScope: "provider" | "global" | null;
    lastRetryReason: string | null;
  };
  queues: {
    pendingFollowUps: TaskFollowUpInput[];
    /** Queue-only follow-ups incorporated into transcript and persisted. */
    consumedFollowUpMessageIds?: Set<string>;
    stepFeedbackSignal: {
      feedbackId?: string;
      stepId: string;
      action: "retry" | "skip" | "stop" | "drift";
      message?: string;
    } | null;
  };
  skills: {
    pendingParameterCollection: PendingSkillParameterCollection | null;
    primarySlashCommandHandled: boolean;
  };
  worker: {
    dispatchedMentionedAgents: boolean;
    verificationAgentState: Record<string, unknown>;
  };
  permissions: SessionRuntimePermissionState;
  verification: {
    verificationEvidenceEntries: VerificationEvidenceEntry[];
    nonBlockingVerificationFailedStepIds: Set<string>;
    blockingVerificationFailedStepIds: Set<string>;
  };
  checklist: SessionChecklistState;
  promptCache: {
    stableSystemBlocks: LLMSystemBlock[];
    stablePrefixHash: string;
    toolSchemaHash: string;
    promptCacheMode: LLMPromptCacheMode;
    promptCacheProviderFamily: PromptCacheProviderFamily;
    promptCacheInvalidationReason: string | null;
    promptCacheTtl?: "5m" | "1h";
  };
  usage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    usageOffsetInputTokens: number;
    usageOffsetOutputTokens: number;
    usageOffsetCost: number;
  };
}

export interface SessionRuntimeDeps {
  /** Shared durable store used to recover queue-only visual attachments. */
  queuedAttachmentStore?: QueuedAttachmentStore;
  getTask: () => Task;
  getDefaultPermissionMode: () => PermissionMode;
  getWorkspace: () => Workspace;
  setWorkspace: (workspace: Workspace) => void;
  getToolRegistry: () => ToolRegistry;
  setToolRegistry: (toolRegistry: ToolRegistry) => void;
  getContextManager: () => ContextManager;
  getSystemPrompt: () => string;
  buildPromptCacheRequestExtras?: (args: {
    systemPrompt: string;
    tools: LLMTool[];
  }) => Partial<Pick<LLMRequest, "systemBlocks" | "promptCache">>;
  getModelMetadata: () => {
    providerType: string;
    modelId: string;
    modelKey: string;
    llmProfileUsed: LlmProfile;
    resolvedModelKey: string;
  };
  getWebSearchMode: () => WebSearchMode;
  getEffectiveTaskDomain: () => TaskDomain;
  getTaskToolRestrictions: () => Set<string>;
  hasTaskToolAllowlistConfigured: () => boolean;
  getTaskToolAllowlist: () => Set<string>;
  isVisualCanvasTask: () => boolean;
  isCanvasTool: (toolName: string) => boolean;
  getToolPolicyContext: () => Any;
  applyWebSearchModeFilter: (tools: Any[]) => Any[];
  applyAgentPolicyToolFilter: (tools: Any[]) => Any[];
  applyAdaptiveToolAvailabilityFilter: (tools: Any[]) => Any[];
  applyStepScopedToolPolicy: (tools: Any[]) => Any[];
  applyIntentFilter: (tools: Any[]) => Any[];
  sanitizeConversationHistory: (messages: LLMMessage[]) => LLMMessage[];
  pruneStaleToolErrors: (messages: LLMMessage[]) => void;
  consolidateConsecutiveUserMessages: (messages: LLMMessage[]) => void;
  maybeInjectTurnBudgetSoftLanding: (messages: LLMMessage[], phase: string) => void;
  checkBudgets: () => void;
  buildUserProfileBlock: (maxLines: number) => string;
  upsertPinnedUserBlock: (messages: LLMMessage[], opts: Any) => void;
  removePinnedUserBlock: (messages: LLMMessage[], tag: string) => void;
  computeSharedContextKey: () => string;
  buildSharedContextBlock: () => string;
  buildHybridMemoryRecallBlock: (workspaceId: string, query: string) => Promise<string>;
  maybePreCompactionMemoryFlush: (opts: Any) => Promise<void>;
  evaluateJevContextCompaction?: (input: {
    messages: LLMMessage[];
    availableTokens: number;
    targetTokens: number;
    taskPrompt?: string;
    contextLabel: string;
  }) => Promise<JevContextCompactionResult>;
  buildCompactionSummaryBlock: (opts: Any) => Promise<string>;
  truncateSummaryBlock: (summary: string, maxTokens: number) => string;
  flushCompactionSummaryToMemory: (opts: Any) => Promise<void>;
  extractPinnedBlockContent: (summary: string, openTag: string, closeTag: string) => string;
  emitEvent: (type: string, payload: Any) => void;
  resolveLLMMaxTokens: (opts: {
    messages: LLMMessage[];
    system: string;
    requestedMaxTokens?: number;
  }) => number;
  applyRetryTokenCap: (
    baseMaxTokens: number,
    attempt: number,
    timeoutMs: number,
    hasTools: boolean,
  ) => number;
  getRetryTimeoutMs: (
    baseTimeoutMs: number,
    attempt: number,
    hasTools: boolean,
    maxTokensBudget: number,
  ) => number;
  callLLMWithRetry: (
    requestFn: (attempt: number) => Promise<Any>,
    operation: string,
  ) => Promise<Any>;
  createMessageWithTimeout: (request: Any, timeoutMs: number, operation: string) => Promise<Any>;
  log: (message: string) => void;
  getTaskEvents: () => TaskEvent[];
  getReplayEventType: (event: TaskEvent) => string;
  loadCheckpointPayload: () => Any;
  pruneOldSnapshots: () => void;
  getPlanSummary: () => Any;
  getBudgetUsage: () => Task["budgetUsage"];
  updateTask: (updates: Record<string, unknown>) => void;
  updateTaskStatus: (status: Task["status"]) => void;
  executePlan: () => Promise<void>;
  verifySuccessCriteria: () => Promise<{ success: boolean; message: string }>;
  finalizeTaskWithFallback: (resultSummary?: string) => void;
  buildResultSummary: () => string | undefined;
  emitTerminalFailureOnce: (payload: Record<string, unknown>) => void;
  cleanupTools: () => Promise<void>;
  getEffectiveTurnBudgetPolicy: () => string;
  getEmergencyFuseMaxTurns: () => number;
  isWindowTurnLimitExceededError: (error: unknown) => boolean;
  assessContinuationWindow: () => Any;
  /** Optional bounded Jev advice after deterministic loop evidence is available. */
  evaluateJevLoopDecision?: (input: {
    progressScore: number;
    loopRiskIndex: number;
    repeatedFingerprintCount: number;
    noProgressStreak: number;
    pendingSteps: number;
    dominantFingerprint?: string;
    hardStopReason?: string;
  }) => Promise<{
    status: "selected" | "abstain" | "unavailable";
    action: "continue" | "change_strategy" | "stop" | "ask_user" | "abstain";
    model?: string;
    reason?: string;
    confidence?: number;
    probability?: number;
  }>;
  getLoopWarningThreshold: () => number;
  getLoopCriticalThreshold: () => number;
  getMinProgressScoreForAutoContinue: () => number;
  getContinuationStrategy: () => "adaptive_progress" | "fixed_caps";
  getMaxAutoContinuations: () => number;
  getMaxLifetimeTurns: () => number;
  getGlobalNoProgressCircuitBreaker: () => number;
  getEffectiveExecutionMode: () => NonNullable<Task["agentConfig"]>["executionMode"] | undefined;
  getWindowEventsSinceLastReset: () => Any[];
  getRenderedContextRatio: () => number;
  hasWindowMutationEvidence: (events: Any[]) => boolean;
  getWindowToolUseStopStreak: (events: Any[]) => number;
  getSignatureFromLoopFingerprint: (fingerprint?: string) => string | null;
  shouldCompactOnContinuation: () => boolean;
  getCompactionThresholdRatio: () => number;
  getPlan: () => Plan | undefined;
  setTerminalStatus: (status: Task["terminalStatus"]) => void;
  setFailureClass: (failureClass: Task["failureClass"]) => void;
  isCancelled: () => boolean;
  getCancelReason: () => string | null;
  isWaitingForUserInput: () => boolean;
  getRecoveredFailureStepIds: () => Set<string>;
}

export interface SessionRuntimeTextLoopInput {
  messages: LLMMessage[];
  systemPrompt: string;
  initialMaxTokens: number;
  continuationMaxTokens: number;
  mode: "step" | "follow_up";
  operationLabel: string;
  allowContinuation: boolean;
  emptyFallback: string;
  onStreamProgress?: StreamProgressCallback;
}

export interface SessionRuntimePreparedTurnInput extends Omit<TurnKernelInput, "mode"> {
  mode: "step" | "follow_up";
  policy: TurnKernelPolicy;
}

interface RuntimeRecoverySourceFreshness {
  sequence: number | null;
  timestamp: number | null;
  position: number;
}

export const CONTEXT_CAPACITY_RECOVERY_EXHAUSTED_CODE =
  "CONTEXT_CAPACITY_RECOVERY_EXHAUSTED" as const;

export class ContextCapacityExhaustedError extends Error {
  readonly code = CONTEXT_CAPACITY_RECOVERY_EXHAUSTED_CODE;
  readonly phase: "step" | "follow_up";
  readonly contextLabel: string;
  readonly availableTokens: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly reason = "required_content_exceeds_available_budget" as const;

  constructor(opts: {
    phase: "step" | "follow_up";
    contextLabel: string;
    availableTokens: number;
    tokensBefore: number;
    tokensAfter: number;
  }) {
    super(
      `Context capacity recovery exhausted during ${opts.contextLabel}: retained user and pinned ` +
        `context requires ${opts.tokensAfter} tokens but only ${opts.availableTokens} are available.`,
    );
    this.name = "ContextCapacityExhaustedError";
    this.phase = opts.phase;
    this.contextLabel = opts.contextLabel;
    this.availableTokens = opts.availableTokens;
    this.tokensBefore = opts.tokensBefore;
    this.tokensAfter = opts.tokensAfter;
  }
}

export class SessionRuntime {
  private deferredToolCatalog: DeferredToolCatalog | null = null;
  private toolSearchService: ToolSearchService | null = null;
  private taskListVerificationReminderPending = false;
  /** Models used in this session that have no known price, so totalCost is a lower bound. */
  private readonly unpricedModelIds = new Set<string>();
  private readonly queuedAttachmentStore: QueuedAttachmentStore;
  /** Monotonic identity for the live model-visible history projection. */
  private historyGeneration = 0;
  private activeCompactionId: string | null = null;
  private activeCompactionAttemptId: string | null = null;
  private lastCompactionId: string | null = null;
  private lastCompactionAttemptId: string | null = null;
  private lastCompactionStatus: ContextCompactionStatus | null = null;
  private lastCompactionTrigger: ContextCompactionTrigger | null = null;
  private lastCompactionPhase: ContextCompactionPhase | null = null;
  private lastCompactionInputGeneration = 0;
  private lastCompactionInstalledGeneration = 0;
  private readonly restartRecoveredCompactionIds = new Set<string>();

  constructor(
    readonly deps: SessionRuntimeDeps,
    readonly state: SessionRuntimeState,
  ) {
    this.queuedAttachmentStore = deps.queuedAttachmentStore ?? new QueuedAttachmentStore();
    this.historyGeneration = state.transcript.conversationHistory.length > 0 ? 1 : 0;
  }

  createTaskList(items: SessionChecklistToolItemInput[]): SessionChecklistState {
    if (this.state.checklist.items.length > 0) {
      const existingBySignature = new Map(
        this.state.checklist.items.map(
          (item) => [`${item.title.toLowerCase()}\u0000${item.kind}`, item.id] as const,
        ),
      );
      const mergedItems = (Array.isArray(items) ? items : []).map((item) => {
        const explicitId = String(item?.id || "").trim();
        if (explicitId) return item;
        const title = String(item?.title || "")
          .trim()
          .toLowerCase();
        const kind: SessionChecklistItem["kind"] =
          item?.kind === "verification" || item?.kind === "other" || item?.kind === "implementation"
            ? item.kind
            : "implementation";
        const existingId = existingBySignature.get(`${title}\u0000${kind}`);
        return existingId ? { ...item, id: existingId } : item;
      });
      return this.applyTaskListState(mergedItems, "task_list_updated");
    }
    return this.applyTaskListState(items, "task_list_created");
  }

  updateTaskList(items: SessionChecklistToolItemInput[]): SessionChecklistState {
    if (this.state.checklist.items.length === 0) {
      throw new Error("task_list_update failed: no session checklist exists yet.");
    }
    return this.applyTaskListState(items, "task_list_updated");
  }

  listTaskList(): SessionChecklistItem[] {
    return this.getTaskListState().items.map((item) => ({ ...item }));
  }

  getTaskListState(): SessionChecklistState {
    this.reconcileTaskListVerificationState();
    return this.cloneTaskListState();
  }

  clearTaskListVerificationNudge(): void {
    if (
      !this.state.checklist.verificationNudgeNeeded &&
      !this.taskListVerificationReminderPending
    ) {
      return;
    }
    this.state.checklist.verificationNudgeNeeded = false;
    this.state.checklist.nudgeReason = null;
    this.state.checklist.updatedAt = Date.now();
    this.taskListVerificationReminderPending = false;
  }

  runStepLoop(input: SessionRuntimePreparedTurnInput): Promise<TurnKernelOutcome> {
    return new TurnKernel(
      {
        mode: "step",
        messages: input.messages,
        maxIterations: input.maxIterations,
        maxLlmCalls: input.maxLlmCalls,
        maxEmptyResponses: input.maxEmptyResponses,
        maxRecoveredResponses: input.maxRecoveredResponses,
        maxRepeatedIterations: input.maxRepeatedIterations,
      },
      input.policy,
    ).run();
  }

  runFollowUpLoop(input: SessionRuntimePreparedTurnInput): Promise<TurnKernelOutcome> {
    return new TurnKernel(
      {
        mode: "follow_up",
        messages: input.messages,
        maxIterations: input.maxIterations,
        maxLlmCalls: input.maxLlmCalls,
        maxEmptyResponses: input.maxEmptyResponses,
        maxRecoveredResponses: input.maxRecoveredResponses,
        maxRepeatedIterations: input.maxRepeatedIterations,
      },
      input.policy,
    ).run();
  }

  async runTextLoop(opts: SessionRuntimeTextLoopInput): Promise<{
    messages: LLMMessage[];
    assistantText: string;
  }> {
    let messages = opts.messages;
    let continuationPrefix = "";
    let continuationAttempts = 0;
    let assistantText = "";

    const outcome = await new TurnKernel(
      {
        mode: opts.mode,
        messages,
        maxIterations: opts.allowContinuation ? 2 : 1,
        maxEmptyResponses: 1,
      },
      {
        requestResponse: async () => {
          const requestMessages =
            continuationPrefix.trim().length > 0
              ? [
                  ...messages,
                  {
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: continuationPrefix }],
                  },
                ]
              : messages;
          const promptCacheExtras = this.deps.buildPromptCacheRequestExtras
            ? this.deps.buildPromptCacheRequestExtras({
                systemPrompt: opts.systemPrompt,
                tools: [],
              })
            : {};
          if (promptCacheExtras.promptCache?.ttl) {
            this.state.promptCache.promptCacheTtl = promptCacheExtras.promptCache.ttl;
          }
          const response = await this.deps.callLLMWithRetry(
            () =>
              this.deps.createMessageWithTimeout(
                {
                  model: this.deps.getModelMetadata().modelId,
                  maxTokens:
                    continuationPrefix.trim().length > 0
                      ? opts.continuationMaxTokens
                      : opts.initialMaxTokens,
                  system: opts.systemPrompt,
                  messages: requestMessages,
                  ...promptCacheExtras,
                  ...(opts.onStreamProgress ? { onStreamProgress: opts.onStreamProgress } : {}),
                },
                120_000,
                continuationPrefix.trim().length > 0
                  ? `${opts.operationLabel} (continuation)`
                  : opts.operationLabel,
              ),
            continuationPrefix.trim().length > 0
              ? `${opts.operationLabel} (continuation)`
              : opts.operationLabel,
          );
          if (response.usage) {
            this.updateTracking(
              response.usage.inputTokens,
              response.usage.outputTokens,
              response.usage.cachedTokens,
              response.usage.cacheWriteTokens,
              response.usage.cacheWriteTtl,
            );
          }
          return {
            response,
            availableTools: [],
          };
        },
        handleResponse: async ({ response }, state) => {
          const text = this.extractTextFromLLMContent(response.content || []);
          if (
            opts.allowContinuation &&
            response.stopReason === "max_tokens" &&
            text &&
            continuationAttempts < 1
          ) {
            continuationPrefix = `${continuationPrefix}${text}`;
            continuationAttempts += 1;
            return { continueLoop: true, emptyResponseCount: 0 };
          }

          assistantText = String(`${continuationPrefix}${text || ""}`).trim() || opts.emptyFallback;
          messages = [
            ...messages,
            {
              role: "assistant",
              content: [{ type: "text", text: assistantText }],
            },
          ];
          state.messages = messages;
          return { continueLoop: false, emptyResponseCount: 0 };
        },
      },
    ).run();

    return {
      messages: outcome.messages,
      assistantText: String(assistantText || "").trim() || opts.emptyFallback,
    };
  }

  private extractTextFromLLMContent(content: Any[]): string {
    return (content || [])
      .filter((c: Any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: Any) => c.text)
      .join("\n");
  }

  private applyTaskListState(
    items: SessionChecklistToolItemInput[],
    eventType: "task_list_created" | "task_list_updated",
  ): SessionChecklistState {
    const nextItems = this.normalizeTaskListItems(items);
    const previousNudgeNeeded = this.state.checklist.verificationNudgeNeeded;

    this.state.checklist.items = nextItems;
    this.state.checklist.updatedAt = Date.now();
    this.reconcileTaskListVerificationState();

    const snapshot = this.cloneTaskListState();
    this.deps.emitEvent(eventType, { checklist: snapshot });
    if (!previousNudgeNeeded && this.state.checklist.verificationNudgeNeeded) {
      this.deps.emitEvent("task_list_verification_nudged", {
        checklist: snapshot,
      });
    }
    return snapshot;
  }

  private normalizeTaskListItems(items: SessionChecklistToolItemInput[]): SessionChecklistItem[] {
    const rawItems = Array.isArray(items) ? items : [];
    if (rawItems.length === 0) {
      throw new Error("Session checklist must contain at least one item.");
    }

    const seenIds = new Set<string>();
    const existingById = new Map(
      this.state.checklist.items.map((item) => [item.id, item] as const),
    );
    let inProgressCount = 0;
    const now = Date.now();

    return rawItems
      .map((rawItem, index) => {
        const title = String(rawItem?.title || "").trim();
        if (!title) {
          throw new Error(`Checklist item ${index + 1} is missing a title.`);
        }

        const status = String(rawItem?.status || "").trim() as SessionChecklistItem["status"];
        if (!["pending", "in_progress", "completed", "blocked"].includes(status)) {
          throw new Error(`Checklist item "${title}" has an invalid status.`);
        }
        if (status === "in_progress") {
          inProgressCount += 1;
        }

        const kind = (rawItem?.kind || "implementation") as SessionChecklistItem["kind"];
        if (!["implementation", "verification", "other"].includes(kind)) {
          throw new Error(`Checklist item "${title}" has an invalid kind.`);
        }

        const normalizedId = String(rawItem?.id || "").trim() || `task_item_${randomUUID()}`;
        if (seenIds.has(normalizedId)) {
          throw new Error(`Checklist contains duplicate item id "${normalizedId}".`);
        }
        seenIds.add(normalizedId);

        const existing = existingById.get(normalizedId);
        return {
          id: normalizedId,
          title,
          kind,
          status,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
      })
      .map((item, index, list) => {
        if (index === list.length - 1 && inProgressCount > 1) {
          throw new Error(
            "Session checklist may contain at most one item with status in_progress.",
          );
        }
        return item;
      });
  }

  private cloneTaskListState(): SessionChecklistState {
    return {
      items: this.state.checklist.items.map((item) => ({ ...item })),
      updatedAt: this.state.checklist.updatedAt,
      verificationNudgeNeeded: this.state.checklist.verificationNudgeNeeded,
      nudgeReason: this.state.checklist.nudgeReason,
    };
  }

  private getTaskListStateFromPayload(payload: Any): SessionChecklistState | null {
    const checklist =
      payload?.checklist && typeof payload.checklist === "object" ? payload.checklist : null;
    if (!checklist || !Array.isArray(checklist.items)) {
      return null;
    }

    const items = checklist.items
      .map((item: Any) => this.normalizePersistedChecklistItem(item))
      .filter((item: SessionChecklistItem | null): item is SessionChecklistItem => Boolean(item));

    return {
      items,
      updatedAt: Number(checklist.updatedAt || 0),
      verificationNudgeNeeded: checklist.verificationNudgeNeeded === true,
      nudgeReason:
        typeof checklist.nudgeReason === "string" && checklist.nudgeReason.trim().length > 0
          ? checklist.nudgeReason
          : null,
    };
  }

  private normalizePersistedChecklistItem(item: Any): SessionChecklistItem | null {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    const kind = typeof item?.kind === "string" ? item.kind : "";
    const status = typeof item?.status === "string" ? item.status : "";
    if (!id || !title) return null;
    if (!["implementation", "verification", "other"].includes(kind)) return null;
    if (!["pending", "in_progress", "completed", "blocked"].includes(status)) return null;
    return {
      id,
      title,
      kind: kind as SessionChecklistItem["kind"],
      status: status as SessionChecklistItem["status"],
      createdAt: Number(item?.createdAt || 0),
      updatedAt: Number(item?.updatedAt || 0),
    };
  }

  private restoreTaskListState(state: SessionChecklistState | null): void {
    if (!state) return;
    this.state.checklist = {
      items: state.items.map((item) => ({ ...item })),
      updatedAt: Number(state.updatedAt || 0),
      verificationNudgeNeeded: state.verificationNudgeNeeded === true,
      nudgeReason: state.nudgeReason ?? null,
    };
    this.taskListVerificationReminderPending = this.state.checklist.verificationNudgeNeeded;
  }

  private restoreTaskListStateFromEvents(events: TaskEvent[]): void {
    const latestChecklistPayload = [...events]
      .reverse()
      .map((event) => {
        if (
          event.type === "task_list_created" ||
          event.type === "task_list_updated" ||
          event.type === "task_list_verification_nudged"
        ) {
          return this.getTaskListStateFromPayload(event.payload);
        }
        if (event.type === "conversation_snapshot") {
          return this.getTaskListStateFromPayload(event.payload);
        }
        return null;
      })
      .find((state): state is SessionChecklistState => Boolean(state));

    if (latestChecklistPayload) {
      this.restoreTaskListState(latestChecklistPayload);
      this.reconcileTaskListVerificationState();
    }
  }

  private reconcileTaskListVerificationState(): void {
    if (this.state.checklist.items.length === 0) {
      this.clearTaskListVerificationNudge();
      return;
    }

    const executionMode = this.deps.getEffectiveExecutionMode() || "execute";
    const coveredByExplicitVerification =
      executionMode === "verified" || planHasVerificationStep(this.deps.getPlan());
    if (coveredByExplicitVerification) {
      this.clearTaskListVerificationNudge();
      return;
    }

    const implementationItems = this.state.checklist.items.filter(
      (item) => item.kind === "implementation",
    );
    const hasVerificationItem = this.state.checklist.items.some(
      (item) => item.kind === "verification",
    );
    const shouldNudge =
      implementationItems.length > 0 &&
      implementationItems.every((item) => item.status === "completed") &&
      !hasVerificationItem;

    if (shouldNudge) {
      this.state.checklist.verificationNudgeNeeded = true;
      this.state.checklist.nudgeReason =
        "All implementation checklist items are complete. Add and run a verification item before finishing.";
      this.taskListVerificationReminderPending = true;
      return;
    }

    this.clearTaskListVerificationNudge();
  }

  private consumeTaskListVerificationReminder(updatedAfter?: number): string | null {
    if (
      !this.state.checklist.verificationNudgeNeeded ||
      !this.taskListVerificationReminderPending ||
      (updatedAfter !== undefined &&
        !this.state.checklist.items.some((item) => item.updatedAt >= updatedAfter))
    ) {
      return null;
    }
    this.taskListVerificationReminderPending = false;
    return [
      "CHECKLIST REMINDER:",
      "- All implementation checklist items are complete.",
      "- Before finishing, add a verification checklist item and run it when appropriate.",
    ].join("\n");
  }

  updateTracking(
    inputTokens: number,
    outputTokens: number,
    cachedTokens = 0,
    cacheWriteTokens = 0,
    cacheWriteTtl?: "5m" | "1h",
  ): void {
    const safeInput = Number.isFinite(inputTokens) ? inputTokens : 0;
    const safeOutput = Number.isFinite(outputTokens) ? outputTokens : 0;
    const safeCached = Number.isFinite(cachedTokens) ? cachedTokens : 0;
    const safeCacheWrite = Number.isFinite(cacheWriteTokens) ? cacheWriteTokens : 0;
    const deltaCost = calculateCost(
      this.deps.getModelMetadata().modelId,
      safeInput,
      safeOutput,
      safeCached,
      safeCacheWrite,
      getCacheTokenAccounting(
        this.deps.getModelMetadata().providerType,
        this.deps.getModelMetadata().modelId,
      ),
      {
        providerType: this.deps.getModelMetadata().providerType,
        cacheTtl: cacheWriteTtl || this.state.promptCache.promptCacheTtl,
      },
    );

    const { modelId, providerType } = this.deps.getModelMetadata();
    const costKnown = isModelPriced(modelId, providerType);
    if (!costKnown && (safeInput > 0 || safeOutput > 0)) this.unpricedModelIds.add(modelId);

    this.state.usage.totalInputTokens += safeInput;
    this.state.usage.totalOutputTokens += safeOutput;
    this.state.usage.totalCost += deltaCost;
    this.recordLlmTurn();

    if (safeInput > 0 || safeOutput > 0 || safeCached > 0 || safeCacheWrite > 0 || deltaCost > 0) {
      const cumulativeInput = this.getCumulativeInputTokens();
      const cumulativeOutput = this.getCumulativeOutputTokens();
      const cumulativeCost = this.getCumulativeCost();
      this.deps.emitEvent("llm_usage", {
        providerType: this.deps.getModelMetadata().providerType,
        modelId: this.deps.getModelMetadata().modelId,
        delta: {
          inputTokens: safeInput,
          outputTokens: safeOutput,
          cachedTokens: safeCached,
          ...(safeCacheWrite > 0 ? { cacheWriteTokens: safeCacheWrite } : {}),
          ...(cacheWriteTtl ? { cacheWriteTtl } : {}),
          cost: deltaCost,
          costKnown,
        },
        totals: {
          inputTokens: cumulativeInput,
          outputTokens: cumulativeOutput,
          cost: cumulativeCost,
          costKnown: this.unpricedModelIds.size === 0,
          ...(() => {
            const cap = GuardrailManager.isCostBudgetExceeded(cumulativeCost, {
              taskBudget: this.deps.getTask().budgetCost,
              subscriptionBilled: LLMProviderFactory.isSubscriptionBilledRoute(providerType),
            });
            return {
              costLimit: cap.source === "none" ? null : cap.limit,
              costLimitSource: cap.source,
            };
          })(),
        },
      });
    }
  }

  /**
   * Record one successful LLM response even when the provider omitted usage
   * telemetry. Token/cost accounting stays in updateTracking; turn budgets
   * must not depend on provider-specific usage fields.
   */
  recordLlmTurn(): void {
    this.state.loop.iterationCount += 1;
    this.state.loop.globalTurnCount += 1;
    this.state.loop.lifetimeTurnCount += 1;

    if (this.state.loop.lifetimeTurnCount % 5 === 0) {
      this.deps.updateTask({ ...this.projectTaskState() });
    }
  }

  getCumulativeInputTokens(): number {
    return this.state.usage.usageOffsetInputTokens + this.state.usage.totalInputTokens;
  }

  getCumulativeOutputTokens(): number {
    return this.state.usage.usageOffsetOutputTokens + this.state.usage.totalOutputTokens;
  }

  getCumulativeCost(): number {
    return this.state.usage.usageOffsetCost + this.state.usage.totalCost;
  }

  getHistoryGeneration(): number {
    return this.historyGeneration;
  }

  getCompactionSnapshot(): SessionRuntimeCompactionSnapshot {
    return {
      historyGeneration: this.historyGeneration,
      activeCompactionId: this.activeCompactionId,
      activeCompactionAttemptId: this.activeCompactionAttemptId,
      lastCompactionId: this.lastCompactionId,
      lastCompactionAttemptId: this.lastCompactionAttemptId,
      lastCompactionStatus: this.lastCompactionStatus,
      lastCompactionTrigger: this.lastCompactionTrigger,
      lastCompactionPhase: this.lastCompactionPhase,
      lastCompactionInputGeneration: this.lastCompactionInputGeneration,
      lastCompactionInstalledGeneration: this.lastCompactionInstalledGeneration,
    };
  }

  private captureHistoryProjection(): {
    generation: number;
    history: LLMMessage[];
    length: number;
    lastMessage: LLMMessage | undefined;
    fingerprint: string;
  } {
    const history = this.state.transcript.conversationHistory;
    return {
      generation: this.historyGeneration,
      history,
      length: history.length,
      lastMessage: history.at(-1),
      fingerprint: this.getHistoryProjectionFingerprint(history),
    };
  }

  private getHistoryProjectionFingerprint(history: LLMMessage[]): string {
    try {
      return JSON.stringify(history);
    } catch {
      return history
        .map(
          (message) =>
            `${message.role}:${typeof message.content === "string" ? message.content : "[content]"}`,
        )
        .join("\u0000");
    }
  }

  private isHistoryProjectionCurrent(
    projection: ReturnType<SessionRuntime["captureHistoryProjection"]>,
  ): boolean {
    const current = this.state.transcript.conversationHistory;
    return (
      this.historyGeneration === projection.generation &&
      current === projection.history &&
      current.length === projection.length &&
      current.at(-1) === projection.lastMessage &&
      this.getHistoryProjectionFingerprint(current) === projection.fingerprint
    );
  }

  private emitCompactionEvent(
    type: ContextCompactionEventType,
    payload: ContextCompactionEventPayload,
  ): void {
    try {
      this.deps.emitEvent(type, payload);
    } catch {
      // Timeline persistence is best-effort for compaction. The runtime must
      // still release its lock and persist replacement history when a
      // transient event sink/database failure occurs.
    }
  }

  private emitBestEffortEvent(type: string, payload: Record<string, unknown>): void {
    try {
      this.deps.emitEvent(type, payload);
    } catch {
      // Telemetry and timeline narration must never turn a committed context
      // replacement into a reported recovery failure.
    }
  }

  private beginCompaction(opts: {
    trigger: ContextCompactionTrigger;
    phase: ContextCompactionPhase;
    reason: string;
    inputTokens?: number;
    inputMessageCount?: number;
    thresholdRatio?: number;
    targetRatio?: number;
    contextWindowTokens?: number;
    extra?: Record<string, unknown>;
  }): {
    compactionId: string;
    attemptId: string;
    projection: ReturnType<SessionRuntime["captureHistoryProjection"]>;
  } | null {
    if (this.activeCompactionId) return null;

    const projection = this.captureHistoryProjection();
    const compactionId = randomUUID();
    const attemptId = randomUUID();
    this.activeCompactionId = compactionId;
    this.activeCompactionAttemptId = attemptId;
    this.lastCompactionId = compactionId;
    this.lastCompactionAttemptId = attemptId;
    this.lastCompactionStatus = "started";
    this.lastCompactionTrigger = opts.trigger;
    this.lastCompactionPhase = opts.phase;
    this.lastCompactionInputGeneration = projection.generation;
    const startPayload = {
      compactionId,
      attemptId,
      status: "started",
      trigger: opts.trigger,
      phase: opts.phase,
      reason: opts.reason,
      historyGenerationBefore: projection.generation,
      ...(typeof opts.inputTokens === "number" ? { inputTokens: opts.inputTokens } : {}),
      ...(typeof opts.inputMessageCount === "number"
        ? { inputMessageCount: opts.inputMessageCount }
        : {}),
      ...(typeof opts.thresholdRatio === "number" ? { thresholdRatio: opts.thresholdRatio } : {}),
      ...(typeof opts.targetRatio === "number" ? { targetRatio: opts.targetRatio } : {}),
      ...(typeof opts.contextWindowTokens === "number"
        ? { contextWindowTokens: opts.contextWindowTokens }
        : {}),
      accountingSource: "estimate",
      ...(opts.extra || {}),
    } satisfies ContextCompactionEventPayload;
    // Timeline persistence is best-effort for compaction. A transient event
    // sink or database failure must not skip the actual history replacement
    // or send an otherwise recoverable turn with its oversized history.
    this.emitCompactionEvent("context_compaction_started", startPayload);
    // Persist the in-flight marker as a best-effort checkpoint. Event replay
    // also reconciles unmatched starts, but this closes the window where the
    // process dies before the event stream flushes the lifecycle start.
    this.saveSnapshot();
    return { compactionId, attemptId, projection };
  }

  /**
   * Start a compaction owned by a caller that builds a replacement history
   * outside the normal turn-preparation method (for example explicit Chat).
   * The runtime owns the durable lifecycle marker so a restart can recover it.
   */
  beginCompactionLifecycle(
    opts: SessionRuntimeCompactionLifecycleOptions,
  ): SessionRuntimeCompactionLifecycleHandle | null {
    const session = this.beginCompaction(opts);
    if (!session) return null;
    return {
      compactionId: session.compactionId,
      attemptId: session.attemptId,
      trigger: opts.trigger,
      phase: opts.phase,
    };
  }

  completeCompactionLifecycle(
    handle: SessionRuntimeCompactionLifecycleHandle,
    opts: Omit<
      Parameters<SessionRuntime["completeCompaction"]>[0],
      "compactionId" | "trigger" | "phase"
    > = {},
  ): boolean {
    if (this.activeCompactionId !== handle.compactionId) return false;
    this.completeCompaction({
      ...opts,
      compactionId: handle.compactionId,
      trigger: handle.trigger,
      phase: handle.phase,
    });
    return this.lastCompactionStatus === "completed";
  }

  failCompactionLifecycle(
    handle: SessionRuntimeCompactionLifecycleHandle,
    opts: Omit<
      Parameters<SessionRuntime["failCompaction"]>[0],
      "compactionId" | "trigger" | "phase"
    >,
  ): void {
    if (this.activeCompactionId !== handle.compactionId) return;
    this.failCompaction({
      ...opts,
      compactionId: handle.compactionId,
      trigger: handle.trigger,
      phase: handle.phase,
    });
  }

  private completeCompaction(opts: {
    compactionId: string;
    trigger: ContextCompactionTrigger;
    phase: ContextCompactionPhase;
    reason?: string;
    inputTokens?: number;
    replacementTokens?: number;
    inputMessageCount?: number;
    replacementMessageCount?: number;
    removedMessageCount?: number;
    removedApproxTokens?: number;
    thresholdRatio?: number;
    targetRatio?: number;
    summaryPreview?: string;
    fallbackUsed?: boolean;
    extra?: Record<string, unknown>;
  }): void {
    const attemptId = this.activeCompactionAttemptId ?? this.lastCompactionAttemptId;
    this.lastCompactionId = opts.compactionId;
    this.lastCompactionAttemptId = attemptId ?? null;
    this.lastCompactionStatus = "completed";
    this.lastCompactionInstalledGeneration = this.historyGeneration;
    this.activeCompactionId = null;
    this.activeCompactionAttemptId = null;
    const completionPayload = {
      compactionId: opts.compactionId,
      ...(attemptId ? { attemptId } : {}),
      status: "completed",
      trigger: opts.trigger,
      phase: opts.phase,
      reason: opts.reason,
      historyGenerationBefore: this.lastCompactionInputGeneration,
      historyGenerationAfter: this.historyGeneration,
      ...(typeof opts.inputTokens === "number" ? { inputTokens: opts.inputTokens } : {}),
      ...(typeof opts.replacementTokens === "number"
        ? { replacementTokens: opts.replacementTokens }
        : {}),
      ...(typeof opts.inputMessageCount === "number"
        ? { inputMessageCount: opts.inputMessageCount }
        : {}),
      ...(typeof opts.replacementMessageCount === "number"
        ? { replacementMessageCount: opts.replacementMessageCount }
        : {}),
      ...(typeof opts.removedMessageCount === "number"
        ? { removedMessageCount: opts.removedMessageCount }
        : {}),
      ...(typeof opts.removedApproxTokens === "number"
        ? { removedApproxTokens: opts.removedApproxTokens }
        : {}),
      ...(typeof opts.thresholdRatio === "number" ? { thresholdRatio: opts.thresholdRatio } : {}),
      ...(typeof opts.targetRatio === "number" ? { targetRatio: opts.targetRatio } : {}),
      ...(opts.summaryPreview
        ? {
            summaryPreview: compactPreview(
              InputSanitizer.sanitizeMemoryContent(opts.summaryPreview),
            ),
          }
        : {}),
      ...(opts.fallbackUsed !== undefined ? { fallbackUsed: opts.fallbackUsed } : {}),
      accountingSource: "estimate",
      ...(opts.extra || {}),
    } satisfies ContextCompactionEventPayload;
    const snapshotSaved = this.saveSnapshot();
    if (snapshotSaved) {
      this.emitCompactionEvent("context_compaction_completed", completionPayload);
      return;
    }

    // Do not publish completion before the replacement history crosses the
    // snapshot durability boundary. If the first snapshot attempt fails,
    // retain the in-memory replacement but make the lifecycle retryable and
    // try to persist that state once more.
    this.lastCompactionStatus = "failed";
    this.emitCompactionEvent("context_compaction_failed", {
      ...completionPayload,
      status: "failed",
      reason: "compaction_snapshot_persistence_failed",
      retryable: true,
      failureStage: "snapshot",
    });
    this.saveSnapshot();
  }

  private failCompaction(opts: {
    compactionId: string;
    trigger: ContextCompactionTrigger;
    phase: ContextCompactionPhase;
    reason: string;
    retryable?: boolean;
    failureStage?: string;
    errorCode?: string;
    inputTokens?: number;
    extra?: Record<string, unknown>;
  }): void {
    const attemptId = this.activeCompactionAttemptId ?? this.lastCompactionAttemptId;
    this.lastCompactionId = opts.compactionId;
    this.lastCompactionAttemptId = attemptId ?? null;
    this.lastCompactionStatus = "failed";
    this.activeCompactionId = null;
    this.activeCompactionAttemptId = null;
    const failurePayload = {
      compactionId: opts.compactionId,
      ...(attemptId ? { attemptId } : {}),
      status: "failed",
      trigger: opts.trigger,
      phase: opts.phase,
      reason: opts.reason,
      historyGenerationBefore: this.lastCompactionInputGeneration,
      ...(typeof opts.inputTokens === "number" ? { inputTokens: opts.inputTokens } : {}),
      ...(opts.retryable !== undefined ? { retryable: opts.retryable } : {}),
      ...(opts.failureStage ? { failureStage: opts.failureStage } : {}),
      ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
      accountingSource: "estimate",
      ...(opts.extra || {}),
    } satisfies ContextCompactionEventPayload;
    this.saveSnapshot();
    this.emitCompactionEvent("context_compaction_failed", failurePayload);
  }

  updateConversationHistory(messages: LLMMessage[]): void {
    const sanitized = this.deps.sanitizeConversationHistory(messages);
    this.state.transcript.conversationHistory = sanitized;
    this.historyGeneration += 1;
    try {
      DurableContextService.recordHistory({
        workspaceId: this.deps.getWorkspace().id,
        taskId: this.deps.getTask().id,
        messages: sanitized,
        source: "runtime_history",
      });
    } catch {
      // Durable context is an experimental continuity layer; never block runtime turns.
    }
  }

  appendConversationHistory(message: LLMMessage): void {
    this.updateConversationHistory([...this.state.transcript.conversationHistory, message]);
  }

  queueFollowUp(
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
    integrationMentions?: TaskFollowUpInput["integrationMentions"],
    agentConfigOverride?: TaskFollowUpInput["agentConfigOverride"],
    interactionMode?: TaskFollowUpInput["interactionMode"],
    messageSource?: TaskFollowUpInput["messageSource"],
    messageId?: TaskFollowUpInput["messageId"],
    senderTaskId?: TaskFollowUpInput["senderTaskId"],
    senderLabel?: TaskFollowUpInput["senderLabel"],
    deliveryMode?: TaskFollowUpInput["deliveryMode"],
    inReplyToMessageId?: TaskFollowUpInput["inReplyToMessageId"],
    inReplyToTaskId?: TaskFollowUpInput["inReplyToTaskId"],
  ): void {
    this.state.queues.pendingFollowUps.push({
      message,
      images,
      quotedAssistantMessage,
      ...(integrationMentions !== undefined ? { integrationMentions } : {}),
      ...(agentConfigOverride !== undefined ? { agentConfigOverride } : {}),
      ...(interactionMode !== undefined ? { interactionMode } : {}),
      ...(deliveryMode !== undefined ? { deliveryMode } : {}),
      ...(messageSource !== undefined ? { messageSource } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
      ...(senderTaskId !== undefined ? { senderTaskId } : {}),
      ...(senderLabel !== undefined ? { senderLabel } : {}),
      ...(inReplyToMessageId !== undefined ? { inReplyToMessageId } : {}),
      ...(inReplyToTaskId !== undefined ? { inReplyToTaskId } : {}),
    });
    this.saveSnapshot();
  }

  get hasPendingFollowUps(): boolean {
    return this.state.queues.pendingFollowUps.length > 0;
  }

  hasPendingFollowUpMessage(messageId: string): boolean {
    const normalized = typeof messageId === "string" ? messageId.trim() : "";
    return (
      normalized.length > 0 &&
      this.state.queues.pendingFollowUps.some(
        (followUp) =>
          followUp.deliveryMode === "message" && followUp.messageId?.trim() === normalized,
      )
    );
  }

  private getConsumedFollowUpMessageIds(): Set<string> {
    if (!(this.state.queues.consumedFollowUpMessageIds instanceof Set)) {
      this.state.queues.consumedFollowUpMessageIds = new Set<string>();
    }
    return this.state.queues.consumedFollowUpMessageIds;
  }

  markFollowUpMessageConsumed(messageId: string): void {
    const normalized = typeof messageId === "string" ? messageId.trim() : "";
    if (normalized) this.getConsumedFollowUpMessageIds().add(normalized);
  }

  unmarkFollowUpMessageConsumed(messageId: string): void {
    const normalized = typeof messageId === "string" ? messageId.trim() : "";
    if (normalized) this.getConsumedFollowUpMessageIds().delete(normalized);
  }

  isFollowUpMessageConsumed(messageId: string): boolean {
    const normalized = typeof messageId === "string" ? messageId.trim() : "";
    return normalized.length > 0 && this.getConsumedFollowUpMessageIds().has(normalized);
  }

  getConsumedFollowUpMessageIdsSnapshot(): string[] {
    return Array.from(this.getConsumedFollowUpMessageIds());
  }

  setStepFeedback(
    stepId: string,
    action: "retry" | "skip" | "stop" | "drift",
    message?: string,
  ): void {
    const feedbackId = randomUUID();
    this.state.queues.stepFeedbackSignal = { feedbackId, stepId, action, message };
    if (action === "drift" && message) {
      const prefix =
        stepId === "current" ? "[USER FEEDBACK]" : `[STEP FEEDBACK - Step "${stepId}"]`;
      this.state.queues.pendingFollowUps.unshift({
        message: `${prefix}: ${message}`,
      });
    }

    // The daemon records the legacy timeline event before routing the signal
    // here. Emit a second known step_feedback event with the stable id so the
    // bounded resume query can reconstruct feedback even when the next
    // conversation snapshot never ran. (The resume query already retains this
    // event family for the legacy feedback path.)
    try {
      this.deps.emitEvent("step_feedback", {
        feedbackId,
        stepId,
        action,
        ...(message !== undefined ? { message } : {}),
        feedbackSignature: this.getStepFeedbackSignature(stepId, action, message),
      });
    } catch {
      // The snapshot below remains a best-effort fallback if event persistence
      // is unavailable for a lightweight host or a transient database error.
    }
    this.saveSnapshot();
  }

  consumeStepFeedback(currentStepId: string): SessionRuntimeState["queues"]["stepFeedbackSignal"] {
    if (!this.state.queues.stepFeedbackSignal) return null;
    if (this.state.queues.stepFeedbackSignal.stepId !== currentStepId) return null;
    const signal = this.state.queues.stepFeedbackSignal;

    // Persist the consumed marker before clearing the in-memory signal. If the
    // process dies after the action is observed but before the next snapshot,
    // replay can still suppress the already-applied feedback. Reuse the
    // retained step_feedback event family so this marker survives the bounded
    // daemon resume query without widening daemon-owned allowlists.
    try {
      this.deps.emitEvent("step_feedback", {
        ...(signal.feedbackId ? { feedbackId: signal.feedbackId } : {}),
        stepId: signal.stepId,
        action: signal.action,
        consumed: true,
        feedbackSignature: this.getStepFeedbackSignature(
          signal.stepId,
          signal.action,
          signal.message,
        ),
        consumedAt: Date.now(),
      });
    } catch {
      // Do not consume a signal that could not be durably acknowledged; the
      // next iteration can retry it instead of silently dropping user input.
      return null;
    }
    this.state.queues.stepFeedbackSignal = null;
    this.saveSnapshot();
    return signal;
  }

  private getStepFeedbackSignature(
    stepId: string,
    action: "retry" | "skip" | "stop" | "drift",
    message?: string,
  ): string {
    return `${stepId}\u0000${action}\u0000${message || ""}`;
  }

  drainPendingFollowUp(): TaskFollowUpInput | undefined {
    // Only a change in user preference requires a new turn. Keep ordinary
    // same-mode steering available, without letting later messages jump the queue.
    const pending = this.state.queues.pendingFollowUps[0];
    const requested = pending?.interactionMode;
    const active = getInteractionModeSelection(this.deps.getTask().agentConfig);
    if (
      requested &&
      (requested.mode !== active?.mode ||
        (requested.mode === "smart" &&
          active.mode === "smart" &&
          requested.executionOverride !== active.executionOverride))
    )
      return undefined;
    // Preserve the complete queue-only payload until the executor's acceptance
    // snapshot commits. The acceptance helper removes this exact message ID;
    // pre-acceptance failures can therefore retry images and quoted context.
    // Trim to match the executor's consume path, which requires
    // `messageId.trim().length > 0` before it will accept and remove the item.
    // An untrimmed truthiness test here made a whitespace-only id peek forever
    // without ever shifting: the executor could not consume it, and the drain
    // loop returned the same object on every pass.
    if (pending?.deliveryMode === "message" && pending.messageId?.trim()) return pending;
    return this.state.queues.pendingFollowUps.shift();
  }

  drainAllPendingFollowUps(): TaskFollowUpInput[] {
    const drained = [...this.state.queues.pendingFollowUps];
    this.state.queues.pendingFollowUps = [];
    return drained;
  }

  takeNextFollowUpAtTurnBoundary(): TaskFollowUpInput | undefined {
    const followUp = this.state.queues.pendingFollowUps[0];
    // Queue-only messages carry a durable receipt and may include payload data
    // (for example image bytes) that the compact receipt event intentionally
    // does not store. Keep the full item in the runtime snapshot until the
    // executor has incorporated it and removes it at the acceptance boundary.
    // Legacy/non-receipted follow-ups retain the old drain semantics.
    if (followUp?.deliveryMode === "message" && followUp.messageId) return followUp;
    const drained = this.state.queues.pendingFollowUps.shift();
    if (drained) this.saveSnapshot();
    return drained;
  }

  removeFollowUpAtTurnBoundary(messageId: string): boolean {
    const normalized = typeof messageId === "string" ? messageId.trim() : "";
    if (!normalized) return false;
    const index = this.state.queues.pendingFollowUps.findIndex(
      (followUp) =>
        followUp.deliveryMode === "message" && followUp.messageId?.trim() === normalized,
    );
    if (index < 0) return false;
    this.state.queues.pendingFollowUps.splice(index, 1);
    return true;
  }

  requeueFollowUpAtTurnBoundary(followUp: TaskFollowUpInput): boolean {
    const messageId = typeof followUp.messageId === "string" ? followUp.messageId.trim() : "";
    const alreadyPending = messageId
      ? this.state.queues.pendingFollowUps.some(
          (pending) =>
            pending.deliveryMode === "message" && pending.messageId?.trim() === messageId,
        )
      : this.state.queues.pendingFollowUps.includes(followUp);
    if (!alreadyPending) this.state.queues.pendingFollowUps.unshift(followUp);
    return this.saveSnapshot();
  }

  getPendingSkillParameterCollection(): PendingSkillParameterCollection | null {
    return this.state.skills.pendingParameterCollection
      ? { ...this.state.skills.pendingParameterCollection }
      : null;
  }

  setPendingSkillParameterCollection(
    pending: PendingSkillParameterCollection | null,
  ): PendingSkillParameterCollection | null {
    this.state.skills.pendingParameterCollection = pending ? { ...pending } : null;
    return this.getPendingSkillParameterCollection();
  }

  markPrimarySlashCommandHandled(): void {
    this.state.skills.primarySlashCommandHandled = true;
  }

  hasHandledPrimarySlashCommand(): boolean {
    return this.state.skills.primarySlashCommandHandled === true;
  }

  private invalidateToolAvailabilityCache(): void {
    this.state.tooling.availableToolsCacheKey = null;
    this.state.tooling.availableToolsCache = null;
    this.deferredToolCatalog = null;
    this.toolSearchService = null;
  }

  private buildToolPromptRenderContext(): LLMToolPromptRenderContext {
    const task = this.deps.getTask();
    return {
      executionMode: this.deps.getEffectiveExecutionMode() || "execute",
      taskDomain: this.deps.getEffectiveTaskDomain(),
      webSearchMode: this.deps.getWebSearchMode(),
      shellEnabled: this.deps.getWorkspace().permissions.shell,
      agentType: task.agentType ?? "main",
      workerRole: task.workerRole ?? null,
      allowUserInput: task.agentConfig?.allowUserInput !== false,
      humanInputPolicy: task.agentConfig?.humanInputPolicy,
    };
  }

  private buildToolAvailabilityCacheKey(params: {
    baseKey: string;
    renderContext: LLMToolPromptRenderContext;
    taskTitle: string;
    taskPrompt: string;
    lastUserMessage: string;
    currentStepId: string | null;
    discoveredDeferredToolNames: string[];
  }): string {
    return JSON.stringify({
      baseKey: params.baseKey,
      renderContext: params.renderContext,
      taskTitle: params.taskTitle,
      taskPrompt: params.taskPrompt,
      lastUserMessage: params.lastUserMessage,
      currentStepId: params.currentStepId,
      discoveredDeferredToolNames: params.discoveredDeferredToolNames,
    });
  }

  getAvailableTools(): Any[] {
    const restrictedTools = this.deps.getTaskToolRestrictions();
    const hasAllowlist = this.deps.hasTaskToolAllowlistConfigured();
    const allowedTools = this.deps.getTaskToolAllowlist();
    const restrictedByTask = (name: string) =>
      restrictedTools.has("*") || restrictedTools.has(name);
    const blockedByAllowlist = (name: string) =>
      hasAllowlist && !allowedTools.has("*") && !allowedTools.has(name);
    const disabledTools = this.state.tooling.toolFailureTracker.getDisabledTools();
    const botPolicyContext = this.deps.getToolPolicyContext();
    const cacheKey = JSON.stringify({
      toolCatalogVersion: this.deps.getToolRegistry().getToolCatalogVersion?.() || null,
      disabledTools,
      restrictedTools: [...restrictedTools].sort(),
      allowedTools: [...allowedTools].sort(),
      hasAllowlist,
      webSearchMode: this.deps.getWebSearchMode(),
      shellEnabled: this.deps.getWorkspace().permissions.shell,
      botConversation: botPolicyContext?.botConversation === true,
      botTeamId: botPolicyContext?.botTeamId || "",
      botMessagingAuthorized: botPolicyContext?.botMessagingAuthorized === true,
      turnSuccessfulToolUsageCounts: Array.from(
        this.state.tooling.turnSuccessfulToolUsageCounts.entries(),
      )
        .filter(([, count]) => count > 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    });
    const task = this.deps.getTask();
    const renderContext = this.buildToolPromptRenderContext();
    const renderedCacheKey = this.buildToolAvailabilityCacheKey({
      baseKey: cacheKey,
      renderContext,
      taskTitle: String(task.title || ""),
      taskPrompt: String(task.prompt || ""),
      lastUserMessage: String(this.state.transcript.lastUserMessage || ""),
      currentStepId: this.state.loop.currentStepId,
      discoveredDeferredToolNames: Array.from(
        this.state.tooling.discoveredDeferredToolNames,
      ).sort(),
    });
    if (
      this.state.tooling.availableToolsCacheKey === renderedCacheKey &&
      this.state.tooling.availableToolsCache
    ) {
      return this.state.tooling.availableToolsCache.slice();
    }
    const toolRegistry = this.deps.getToolRegistry();
    if ((toolRegistry as Any).__legacyFilteredGetTools === true) {
      const legacyTools =
        typeof (toolRegistry as Any).getTools === "function"
          ? ((toolRegistry as Any).getTools() as Any[])
          : [];
      this.state.tooling.availableToolsCacheKey = renderedCacheKey;
      this.state.tooling.availableToolsCache = legacyTools.slice();
      return legacyTools;
    }
    const baseTools = typeof toolRegistry.getTools === "function" ? toolRegistry.getTools() : [];
    const deferredTools =
      typeof toolRegistry.getDeferredTools === "function" ? toolRegistry.getDeferredTools() : [];

    this.deferredToolCatalog = new DeferredToolCatalog(baseTools);
    this.toolSearchService = new ToolSearchService(deferredTools);
    const deferredMatches = this.toolSearchService.search(
      [task.title, task.prompt, this.state.transcript.lastUserMessage].filter(Boolean).join(" "),
      8,
    );
    const deferredMatchNames = new Set([
      ...deferredMatches.map((match) => match.name),
      ...this.state.tooling.discoveredDeferredToolNames,
    ]);
    const allTools = this.deferredToolCatalog
      .getAll()
      .filter(
        (entry) =>
          !entry.deferred ||
          entry.tool.runtime?.alwaysExpose ||
          deferredMatchNames.has(entry.tool.name),
      )
      .map((entry) => entry.tool);
    let finalTools: Any[];

    if (disabledTools.length === 0 && restrictedTools.size === 0 && !hasAllowlist) {
      let tools = allTools;
      if (!this.deps.isVisualCanvasTask()) {
        tools = tools.filter((tool) => !this.deps.isCanvasTool(tool.name));
      }
      const policyFiltered = filterToolsByPolicy(tools, this.deps.getToolPolicyContext());
      const modeFiltered = this.deps.applyWebSearchModeFilter(policyFiltered.tools);
      const agentPolicyFiltered = this.deps.applyAgentPolicyToolFilter(modeFiltered);
      finalTools = this.deps.applyAdaptiveToolAvailabilityFilter(
        this.deps.applyStepScopedToolPolicy(this.deps.applyIntentFilter(agentPolicyFiltered)),
      );
      const renderedTools =
        typeof (toolRegistry as Any).renderToolsForContext === "function"
          ? (toolRegistry as Any).renderToolsForContext(finalTools as LLMTool[], renderContext)
          : finalTools;
      this.state.tooling.availableToolsCacheKey = renderedCacheKey;
      this.state.tooling.availableToolsCache = renderedTools.slice();
      return renderedTools;
    }

    let filtered = allTools
      .filter((tool) => !restrictedByTask(tool.name))
      .filter((tool) => !blockedByAllowlist(tool.name))
      .filter((tool) => !disabledTools.includes(tool.name));

    if (!this.deps.isVisualCanvasTask()) {
      filtered = filtered.filter((tool) => !this.deps.isCanvasTool(tool.name));
    }

    const policyFiltered = filterToolsByPolicy(filtered, this.deps.getToolPolicyContext());
    const modeFiltered = this.deps.applyWebSearchModeFilter(policyFiltered.tools);
    const agentPolicyFiltered = this.deps.applyAgentPolicyToolFilter(modeFiltered);
    finalTools = this.deps.applyAdaptiveToolAvailabilityFilter(
      this.deps.applyStepScopedToolPolicy(this.deps.applyIntentFilter(agentPolicyFiltered)),
    );
    const renderedTools =
      typeof (toolRegistry as Any).renderToolsForContext === "function"
        ? (toolRegistry as Any).renderToolsForContext(finalTools as LLMTool[], renderContext)
        : finalTools;
    this.state.tooling.availableToolsCacheKey = renderedCacheKey;
    this.state.tooling.availableToolsCache = renderedTools.slice();
    return renderedTools;
  }

  async requestLLMResponseWithAdaptiveBudget(opts: {
    messages: LLMMessage[];
    retryLabel: string;
    operation: string;
    forceNoTools?: boolean;
  }): Promise<{ response: Any; availableTools: Any[] }> {
    return requestLLMResponseWithAdaptiveBudgetUtil({
      ...opts,
      llmTimeoutMs: 120_000,
      providerType: this.deps.getModelMetadata().providerType,
      modelId: this.deps.getModelMetadata().modelId,
      systemPrompt: this.deps.getSystemPrompt(),
      getTaskMaxTokens: () => {
        const maxTokens = this.deps.getTask()?.agentConfig?.maxTokens;
        return typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
          ? Math.floor(maxTokens)
          : null;
      },
      getContextManager: () => this.deps.getContextManager(),
      getAvailableTools: () => this.getAvailableTools(),
      applyRetryTokenCap: (baseMaxTokens, attempt, timeoutMs, hasTools) =>
        this.deps.applyRetryTokenCap(baseMaxTokens, attempt, timeoutMs, hasTools ?? false),
      getRetryTimeoutMs: (baseTimeoutMs, attempt, hasTools, maxTokensBudget) =>
        this.deps.getRetryTimeoutMs(
          baseTimeoutMs,
          attempt,
          hasTools ?? false,
          maxTokensBudget ?? 0,
        ),
      callLLMWithRetry: (requestFn, operation) => this.deps.callLLMWithRetry(requestFn, operation),
      createMessageWithTimeout: (request, timeoutMs, operation) =>
        this.deps.createMessageWithTimeout(request, timeoutMs, operation),
      buildPromptCacheRequestExtras: this.deps.buildPromptCacheRequestExtras,
      updateTracking: (inputTokens, outputTokens, cachedTokens, cacheWriteTokens, cacheWriteTtl) =>
        this.updateTracking(
          inputTokens,
          outputTokens,
          cachedTokens,
          cacheWriteTokens,
          cacheWriteTtl,
        ),
      emitEvent: (type, payload) => this.deps.emitEvent(type, payload),
      log: (message) => this.deps.log(message),
    });
  }

  private getHardContextBudget(
    messages: LLMMessage[],
    systemPromptTokens: number,
  ): { availableTokens: number; currentTokens: number } | null {
    const contextManager = this.deps.getContextManager() as Any;
    let availableTokens: unknown;
    try {
      if (typeof contextManager?.getContextUtilization === "function") {
        availableTokens = contextManager.getContextUtilization(
          messages,
          systemPromptTokens,
        )?.availableTokens;
      }
      if (
        (typeof availableTokens !== "number" || !Number.isFinite(availableTokens)) &&
        typeof contextManager?.getAvailableTokens === "function"
      ) {
        availableTokens = contextManager.getAvailableTokens(systemPromptTokens);
      }
    } catch {
      return null;
    }

    if (typeof availableTokens !== "number" || !Number.isFinite(availableTokens)) return null;
    return {
      availableTokens: Math.max(0, Math.floor(availableTokens)),
      currentTokens: estimateTotalTokens(messages),
    };
  }

  private createContextCapacityExhaustedError(opts: {
    phase: "step" | "follow_up";
    contextLabel: string;
    availableTokens: number;
    tokensBefore: number;
    tokensAfter: number;
  }): ContextCapacityExhaustedError {
    return new ContextCapacityExhaustedError(opts);
  }

  private emitContextCapacityRecoveryExhausted(
    error: ContextCapacityExhaustedError,
    opts: {
      phase: "step" | "follow_up";
      contextLabel: string;
      stepId?: string;
      attempt?: number;
      maxAttempts?: number;
    },
  ): void {
    this.emitBestEffortEvent("context_capacity_recovery_exhausted", {
      phase: opts.phase,
      contextLabel: opts.contextLabel,
      ...(opts.stepId ? { stepId: opts.stepId } : {}),
      ...(typeof opts.attempt === "number" ? { attempt: opts.attempt } : {}),
      ...(typeof opts.maxAttempts === "number" ? { maxAttempts: opts.maxAttempts } : {}),
      reason: error.reason,
      errorCode: error.code,
      availableTokens: error.availableTokens,
      tokensBefore: error.tokensBefore,
      tokensAfter: error.tokensAfter,
      message: error.message,
    });
  }

  async prepareMessagesForTurnIteration(opts: {
    messages: LLMMessage[];
    phase: "step" | "follow_up";
    checklistUpdatedAfter?: number;
    systemPromptTokens: number;
    allowSharedContextInjection: boolean;
    allowMemoryInjection: boolean;
    memoryQuery: string;
    contextLabel: string;
    lastTurnMemoryRecallQuery: string;
    lastTurnMemoryRecallBlock: string;
    lastSharedContextKey: string;
    lastSharedContextBlock: string;
  }): Promise<{
    messages: LLMMessage[];
    lastTurnMemoryRecallQuery: string;
    lastTurnMemoryRecallBlock: string;
    lastSharedContextKey: string;
    lastSharedContextBlock: string;
  }> {
    let {
      messages,
      lastTurnMemoryRecallQuery,
      lastTurnMemoryRecallBlock,
      lastSharedContextKey,
      lastSharedContextBlock,
    } = opts;

    // Whether `messages` IS the session transcript, or a turn-local array that
    // merely starts from it. Plan steps build their own array
    // (`[{ role: "user", content: stepUserContent }]`), so installing a
    // compaction of it into the transcript would replace the whole
    // conversation with those few messages — and then alias the caller's
    // `messages` to the live history, so later pushes mutate it directly.
    // recoverFromContextCapacityOverflow computes the same fact.
    const installsInHistory = this.state.transcript.conversationHistory === opts.messages;

    this.deps.maybeInjectTurnBudgetSoftLanding(
      messages,
      opts.phase === "follow_up" ? "follow-up" : "step",
    );
    this.deps.checkBudgets();

    const userProfileBlock = this.deps.buildUserProfileBlock(10);
    if (userProfileBlock) {
      this.deps.upsertPinnedUserBlock(messages, {
        tag: "PINNED_USER_PROFILE",
        content: userProfileBlock,
        insertAfterTag: "PINNED_COMPACTION_SUMMARY",
      });
    } else {
      this.deps.removePinnedUserBlock(messages, "PINNED_USER_PROFILE");
    }

    if (opts.allowSharedContextInjection) {
      const key = this.deps.computeSharedContextKey();
      if (key !== lastSharedContextKey) {
        lastSharedContextKey = key;
        lastSharedContextBlock = this.deps.buildSharedContextBlock();
      }

      if (lastSharedContextBlock) {
        this.deps.upsertPinnedUserBlock(messages, {
          tag: "PINNED_SHARED_CONTEXT",
          content: lastSharedContextBlock,
          insertAfterTag: "PINNED_USER_PROFILE",
        });
      } else {
        this.deps.removePinnedUserBlock(messages, "PINNED_SHARED_CONTEXT");
      }
    } else {
      this.deps.removePinnedUserBlock(messages, "PINNED_SHARED_CONTEXT");
    }

    if (opts.allowMemoryInjection) {
      const query = opts.memoryQuery.slice(0, 2500);
      if (query !== lastTurnMemoryRecallQuery) {
        lastTurnMemoryRecallQuery = query;
        lastTurnMemoryRecallBlock = await this.deps.buildHybridMemoryRecallBlock(
          this.deps.getWorkspace().id,
          query,
        );
      }

      if (lastTurnMemoryRecallBlock) {
        this.deps.upsertPinnedUserBlock(messages, {
          tag: "PINNED_MEMORY_RECALL",
          content: lastTurnMemoryRecallBlock,
          insertAfterTag: lastSharedContextBlock
            ? "PINNED_SHARED_CONTEXT"
            : "PINNED_COMPACTION_SUMMARY",
        });
      } else {
        this.deps.removePinnedUserBlock(messages, "PINNED_MEMORY_RECALL");
      }
    }

    const taskListReminder = this.consumeTaskListVerificationReminder(opts.checklistUpdatedAfter);
    if (taskListReminder) {
      this.deps.upsertPinnedUserBlock(messages, {
        tag: "PINNED_TASK_LIST_REMINDER",
        content: taskListReminder,
        insertAfterTag: lastTurnMemoryRecallBlock
          ? "PINNED_MEMORY_RECALL"
          : lastSharedContextBlock
            ? "PINNED_SHARED_CONTEXT"
            : "PINNED_COMPACTION_SUMMARY",
      });
    } else {
      this.deps.removePinnedUserBlock(messages, "PINNED_TASK_LIST_REMINDER");
    }

    await this.deps.maybePreCompactionMemoryFlush({
      messages,
      systemPromptTokens: opts.systemPromptTokens,
      allowMemoryInjection: opts.allowMemoryInjection,
      contextLabel: opts.contextLabel,
    });

    let didProactiveCompact = false;
    let compactionSession: ReturnType<SessionRuntime["beginCompaction"]> = null;
    let compactionChanged = false;
    let compactionSummaryBlock: string | undefined;
    let compactionSummaryRemovedMessages: LLMMessage[] = [];
    let compactionSummaryProactive = false;
    let compactionRemovedCount = 0;
    let compactionOriginalTokens = 0;
    let jevCompactionRemovedMessages: LLMMessage[] = [];
    const contextManager = this.deps.getContextManager();
    const contextTokensBeforeCompaction = estimateTotalTokens(messages);
    const ctxUtil = contextManager.getContextUtilization(messages, opts.systemPromptTokens);
    const compactionPolicy = resolveContextCompactionPolicy({
      availableTokens: ctxUtil.availableTokens,
      currentTokens:
        typeof ctxUtil.currentTokens === "number"
          ? ctxUtil.currentTokens
          : contextTokensBeforeCompaction,
      triggerRatio: DEFAULT_CONTEXT_COMPACTION_TRIGGER_RATIO,
      targetRatio: DEFAULT_CONTEXT_COMPACTION_TARGET_RATIO,
    });
    if (compactionPolicy.shouldCompact) {
      compactionSession = this.beginCompaction({
        trigger: "automatic",
        phase: opts.phase === "follow_up" ? "mid_turn" : "pre_turn",
        reason:
          (typeof ctxUtil.currentTokens === "number"
            ? ctxUtil.currentTokens
            : contextTokensBeforeCompaction) > ctxUtil.availableTokens
            ? "context_capacity"
            : "threshold",
        inputTokens: contextTokensBeforeCompaction,
        thresholdRatio: compactionPolicy.triggerRatio,
        targetRatio: compactionPolicy.targetRatio,
        contextWindowTokens: ctxUtil.availableTokens,
        extra: { contextLabel: opts.contextLabel },
      });
    }
    if (compactionSession) {
      try {
        const messagesBeforeJevCompaction = messages;
        if (this.deps.evaluateJevContextCompaction) {
          const jevResult = await this.deps.evaluateJevContextCompaction({
            messages: messagesBeforeJevCompaction,
            availableTokens: ctxUtil.availableTokens,
            targetTokens: Math.floor(ctxUtil.availableTokens * compactionPolicy.targetRatio),
            taskPrompt: this.deps.getTask().rawPrompt || this.deps.getTask().prompt,
            contextLabel: opts.contextLabel,
          });
          if (jevResult.status === "applied" && jevResult.droppedIndices.length > 0) {
            const dropped = new Set(jevResult.droppedIndices);
            jevCompactionRemovedMessages = messagesBeforeJevCompaction.filter((_message, index) =>
              dropped.has(index),
            );
            messages = jevResult.messages;
            this.emitBestEffortEvent("jev_context_compaction", {
              compactionId: compactionSession.compactionId,
              status: jevResult.status,
              reason: jevResult.reason,
              model: jevResult.model,
              candidateCount: jevResult.candidates.length,
              droppedIndices: jevResult.droppedIndices.slice(0, 32),
              droppedCount: jevCompactionRemovedMessages.length,
              tokensBefore: estimateTotalTokens(messagesBeforeJevCompaction),
              tokensAfter: estimateTotalTokens(messages),
              reversible: true,
              contextLabel: opts.contextLabel,
            });
          } else if (jevResult.status !== "skipped") {
            this.emitBestEffortEvent("jev_context_compaction", {
              compactionId: compactionSession.compactionId,
              status: jevResult.status,
              reason: jevResult.reason,
              model: jevResult.model,
              candidateCount: jevResult.candidates.length,
              droppedCount: 0,
              reversible: true,
              contextLabel: opts.contextLabel,
            });
          }
        }
        const proactiveResult = contextManager.proactiveCompactWithMeta(
          messages,
          opts.systemPromptTokens,
          compactionPolicy.targetRatio,
        );
        messages = proactiveResult.messages;
        compactionOriginalTokens = proactiveResult.meta.originalTokens;
        const proactiveRemovedMessages = proactiveResult.meta.removedMessages.messages;
        const allProactiveRemovedMessages = [
          ...jevCompactionRemovedMessages,
          ...proactiveRemovedMessages,
        ];
        compactionRemovedCount = allProactiveRemovedMessages.length;
        compactionChanged =
          jevCompactionRemovedMessages.length > 0 ||
          proactiveResult.meta.removedMessages.didRemove ||
          proactiveResult.meta.truncatedToolResults.didTruncate;
        if (jevCompactionRemovedMessages.length > 0) {
          compactionOriginalTokens = contextTokensBeforeCompaction;
        }

        if (allProactiveRemovedMessages.length > 0) {
          didProactiveCompact = true;
          const postCompactTokens = estimateTotalTokens(messages);
          const slack = Math.max(0, ctxUtil.availableTokens - postCompactTokens);
          const summaryBudget = Math.min(6144, Math.max(800, Math.floor(slack * 0.6)));
          const summaryResult = await this.installCompactionSummary({
            messages,
            removedMessages: allProactiveRemovedMessages,
            systemPromptTokens: opts.systemPromptTokens,
            maxOutputTokens: summaryBudget,
            availableTokens: ctxUtil.availableTokens,
            contextLabel: opts.contextLabel,
            proactive: true,
            allowMemoryInjection: opts.allowMemoryInjection,
          });
          messages = summaryResult.messages;
          compactionSummaryBlock = summaryResult.summaryBlock;
          if (summaryResult.summaryBlock) {
            compactionSummaryRemovedMessages = allProactiveRemovedMessages;
            compactionSummaryProactive = true;
          }

          if (summaryResult.summaryBlock) {
            const summaryText = this.deps.extractPinnedBlockContent(
              summaryResult.summaryBlock,
              "PINNED_COMPACTION_SUMMARY",
              "PINNED_COMPACTION_SUMMARY_CLOSE",
            );
            this.emitBestEffortEvent("context_summarized", {
              compactionId: compactionSession.compactionId,
              summaryPreview: compactPreview(InputSanitizer.sanitizeMemoryContent(summaryText)),
              summaryRef: `compaction:${compactionSession.compactionId}`,
              removedCount: allProactiveRemovedMessages.length,
              tokensBefore: proactiveResult.meta.originalTokens,
              tokensAfter: estimateTotalTokens(messages),
              proactive: true,
            });
          }
        }
        if (!didProactiveCompact && compactionSession) {
          const compaction = contextManager.compactMessagesWithMeta(
            messages,
            opts.systemPromptTokens,
          );
          messages = compaction.messages;
          compactionOriginalTokens = compaction.meta.originalTokens;
          compactionRemovedCount = compaction.meta.removedMessages.count;
          compactionChanged =
            compaction.meta.removedMessages.didRemove ||
            compaction.meta.truncatedToolResults.didTruncate;

          if (
            compaction.meta.removedMessages.didRemove &&
            compaction.meta.removedMessages.messages.length > 0
          ) {
            const availableTokens = contextManager.getAvailableTokens(opts.systemPromptTokens);
            const tokensNow = estimateTotalTokens(messages);
            const slack = Math.max(0, availableTokens - tokensNow);
            const summaryBudget = Math.min(6144, Math.max(800, Math.floor(slack * 0.6)));
            const summaryResult = await this.installCompactionSummary({
              messages,
              removedMessages: compaction.meta.removedMessages.messages,
              systemPromptTokens: opts.systemPromptTokens,
              maxOutputTokens: summaryBudget,
              availableTokens,
              contextLabel: opts.contextLabel,
              proactive: false,
              allowMemoryInjection: opts.allowMemoryInjection,
            });
            messages = summaryResult.messages;
            compactionSummaryBlock = summaryResult.summaryBlock;
            if (summaryResult.summaryBlock) {
              compactionSummaryRemovedMessages = compaction.meta.removedMessages.messages;
              compactionSummaryProactive = false;
            }

            if (summaryResult.summaryBlock) {
              const summaryText = this.deps.extractPinnedBlockContent(
                summaryResult.summaryBlock,
                "PINNED_COMPACTION_SUMMARY",
                "PINNED_COMPACTION_SUMMARY_CLOSE",
              );
              this.emitBestEffortEvent("context_summarized", {
                compactionId: compactionSession.compactionId,
                summaryPreview: compactPreview(InputSanitizer.sanitizeMemoryContent(summaryText)),
                summaryRef: `compaction:${compactionSession.compactionId}`,
                removedCount: compaction.meta.removedMessages.count,
                tokensBefore: compaction.meta.originalTokens,
                tokensAfter: compaction.meta.removedMessages.tokensAfter,
              });
            }
          }
        }
      } catch (compactionError: Any) {
        this.failCompaction({
          compactionId: compactionSession.compactionId,
          trigger: "automatic",
          phase: opts.phase === "follow_up" ? "mid_turn" : "pre_turn",
          reason: compactionError?.message || String(compactionError),
          retryable: true,
          failureStage: "summarize",
          inputTokens: contextTokensBeforeCompaction,
          extra: { contextLabel: opts.contextLabel },
        });
        if (installsInHistory) messages = this.state.transcript.conversationHistory;
        compactionSession = null;
      }
    }

    if (compactionSession && compactionChanged) {
      if (installsInHistory && !this.isHistoryProjectionCurrent(compactionSession.projection)) {
        this.failCompaction({
          compactionId: compactionSession.compactionId,
          trigger: "automatic",
          phase: opts.phase === "follow_up" ? "mid_turn" : "pre_turn",
          reason: "history_changed_while_compacting",
          retryable: true,
          failureStage: "install",
          inputTokens: contextTokensBeforeCompaction,
          extra: { contextLabel: opts.contextLabel },
        });
        messages = this.state.transcript.conversationHistory;
      } else {
        // Only write back when `messages` is the transcript. A turn-local
        // array (plan steps) keeps its own compacted copy.
        if (installsInHistory) {
          this.updateConversationHistory(messages);
          messages = this.state.transcript.conversationHistory;
        }
        if (compactionSummaryBlock && compactionSummaryRemovedMessages.length > 0) {
          await this.persistCompactionSummaryMemory({
            removedMessages: compactionSummaryRemovedMessages,
            summaryBlock: compactionSummaryBlock,
            contextLabel: opts.contextLabel,
            proactive: compactionSummaryProactive,
            allowMemoryInjection: opts.allowMemoryInjection,
          });
        }
        const summaryText = compactionSummaryBlock
          ? this.deps.extractPinnedBlockContent(
              compactionSummaryBlock,
              "PINNED_COMPACTION_SUMMARY",
              "PINNED_COMPACTION_SUMMARY_CLOSE",
            )
          : undefined;
        this.completeCompaction({
          compactionId: compactionSession.compactionId,
          trigger: "automatic",
          phase: opts.phase === "follow_up" ? "mid_turn" : "pre_turn",
          reason: "context_replacement_installed",
          inputTokens: contextTokensBeforeCompaction,
          replacementTokens: estimateTotalTokens(messages),
          inputMessageCount: compactionSession.projection.length,
          replacementMessageCount: messages.length,
          removedMessageCount: compactionRemovedCount,
          removedApproxTokens: Math.max(
            0,
            compactionOriginalTokens - estimateTotalTokens(messages),
          ),
          thresholdRatio: compactionPolicy.triggerRatio,
          targetRatio: compactionPolicy.targetRatio,
          summaryPreview: summaryText,
          fallbackUsed: !compactionSummaryBlock,
          extra: { contextLabel: opts.contextLabel },
        });
      }
    }
    if (compactionSession && !compactionChanged) {
      this.failCompaction({
        compactionId: compactionSession.compactionId,
        trigger: "automatic",
        phase: opts.phase === "follow_up" ? "mid_turn" : "pre_turn",
        reason: "compaction_produced_no_replacement",
        retryable: false,
        failureStage: "compact",
        inputTokens: contextTokensBeforeCompaction,
        extra: { contextLabel: opts.contextLabel },
      });
    }

    this.deps.pruneStaleToolErrors(messages);
    this.deps.consolidateConsecutiveUserMessages(messages);

    const hardBudget = this.getHardContextBudget(messages, opts.systemPromptTokens);
    if (hardBudget && hardBudget.currentTokens > hardBudget.availableTokens) {
      const error = this.createContextCapacityExhaustedError({
        phase: opts.phase,
        contextLabel: opts.contextLabel,
        availableTokens: hardBudget.availableTokens,
        tokensBefore: contextTokensBeforeCompaction,
        tokensAfter: hardBudget.currentTokens,
      });
      this.emitContextCapacityRecoveryExhausted(error, {
        phase: opts.phase,
        contextLabel: opts.contextLabel,
      });
      throw error;
    }

    return {
      messages,
      lastTurnMemoryRecallQuery,
      lastTurnMemoryRecallBlock,
      lastSharedContextKey,
      lastSharedContextBlock,
    };
  }

  /**
   * Install one durable compaction summary for every compaction path.
   *
   * Compaction is a lossy operation unless the removed transcript is both
   * persisted and represented in the retry context.  Keeping that work in one
   * helper prevents continuation/overflow recovery from silently dropping the
   * summary that normal turn preparation already preserves.
   */
  private async installCompactionSummary(opts: {
    messages: LLMMessage[];
    removedMessages: LLMMessage[];
    systemPromptTokens: number;
    maxOutputTokens?: number;
    availableTokens?: number;
    contextLabel: string;
    historySource?: string;
    proactive?: boolean;
    allowMemoryInjection?: boolean;
  }): Promise<{ messages: LLMMessage[]; summaryBlock?: string }> {
    const removedMessages = (opts.removedMessages || []).filter(Boolean);
    if (removedMessages.length === 0) return { messages: opts.messages };

    const buildSummary = (this.deps as Any).buildCompactionSummaryBlock as
      | ((args: Any) => Promise<string>)
      | undefined;
    if (typeof buildSummary !== "function") {
      throw new Error("compaction_summary_generator_unavailable");
    }

    const contextManager = this.deps.getContextManager() as Any;
    const contextManagerAvailableTokens =
      typeof contextManager?.getAvailableTokens === "function"
        ? contextManager.getAvailableTokens(opts.systemPromptTokens)
        : undefined;
    const availableTokens =
      typeof opts.availableTokens === "number" && Number.isFinite(opts.availableTokens)
        ? Math.max(0, opts.availableTokens)
        : typeof contextManagerAvailableTokens === "number" &&
            Number.isFinite(contextManagerAvailableTokens)
          ? Math.max(0, contextManagerAvailableTokens)
          : Number.MAX_SAFE_INTEGER;
    const currentTokens = estimateTotalTokens(opts.messages);
    const slack = Math.max(0, availableTokens - currentTokens);
    const requestedMaxOutputTokens =
      typeof opts.maxOutputTokens === "number" && Number.isFinite(opts.maxOutputTokens)
        ? Math.max(200, Math.floor(opts.maxOutputTokens))
        : Math.min(4000, Math.max(800, Math.floor(slack * 0.6)));

    let summaryBlock = await buildSummary({
      removedMessages,
      maxOutputTokens: requestedMaxOutputTokens,
      contextLabel: opts.contextLabel,
    });
    if (typeof summaryBlock !== "string" || summaryBlock.trim().length === 0) {
      throw new Error("compaction_summary_empty");
    }

    const truncateSummaryBlock = (this.deps as Any).truncateSummaryBlock as
      | ((summary: string, maxTokens: number) => string)
      | undefined;
    const summaryTokens = estimateTokens(summaryBlock);
    const postInsertTokens = currentTokens + summaryTokens;
    if (postInsertTokens > availableTokens * 0.95 && typeof truncateSummaryBlock === "function") {
      const maxSummaryTokens = Math.max(200, availableTokens - currentTokens - 2000);
      summaryBlock = truncateSummaryBlock(summaryBlock, maxSummaryTokens);
    }
    if (summaryBlock.trim().length === 0) {
      throw new Error("compaction_summary_empty_after_truncation");
    }

    const replacementMessages = opts.messages.slice();
    const upsertPinnedUserBlock = (this.deps as Any).upsertPinnedUserBlock as
      | ((messages: LLMMessage[], opts: Any) => void)
      | undefined;
    if (typeof upsertPinnedUserBlock === "function") {
      upsertPinnedUserBlock(replacementMessages, {
        tag: "PINNED_COMPACTION_SUMMARY",
        content: summaryBlock,
      });
    }

    return { messages: replacementMessages, summaryBlock };
  }

  /**
   * Commit compaction source/summary memory only after the caller has fenced
   * the replacement against the live history generation. These writes are
   * best-effort continuity aids and must never invalidate a committed model
   * history when a memory backend or optional flush fails.
   */
  private async persistCompactionSummaryMemory(opts: {
    removedMessages: LLMMessage[];
    summaryBlock: string;
    contextLabel: string;
    historySource?: string;
    proactive?: boolean;
    allowMemoryInjection?: boolean;
  }): Promise<void> {
    try {
      DurableContextService.recordHistory({
        workspaceId: this.deps.getWorkspace().id,
        taskId: this.deps.getTask().id,
        messages: opts.removedMessages,
        source: opts.historySource || "compaction_source",
      });
    } catch {
      // Optional durable context must not block the replacement transcript.
    }
    try {
      DurableContextService.recordCompactionSummary({
        workspaceId: this.deps.getWorkspace().id,
        taskId: this.deps.getTask().id,
        removedMessages: opts.removedMessages,
        summaryBlock: opts.summaryBlock,
        contextLabel: opts.contextLabel,
        proactive: opts.proactive === true,
      });
    } catch {
      // Optional durable context must not block the replacement transcript.
    }

    if (!opts.allowMemoryInjection) return;
    const flushSummary = (this.deps as Any).flushCompactionSummaryToMemory as
      | ((args: Any) => Promise<void>)
      | undefined;
    if (typeof flushSummary !== "function") return;
    try {
      await flushSummary({
        workspaceId: this.deps.getWorkspace().id,
        taskId: this.deps.getTask().id,
        allowMemoryInjection: true,
        summaryBlock: opts.summaryBlock,
      });
    } catch {
      // Memory injection is an optional side effect.
    }
  }

  async recoverFromContextCapacityOverflow(opts: {
    error: unknown;
    messages: LLMMessage[];
    systemPromptTokens: number;
    phase: "step" | "follow_up";
    stepId?: string;
    attempt: number;
    maxAttempts: number;
  }): Promise<{ recovered: boolean; exhausted: boolean; messages: LLMMessage[] }> {
    if (!isContextCapacityError(opts.error)) {
      return { recovered: false, exhausted: false, messages: opts.messages };
    }

    const attemptNumber = opts.attempt + 1;
    const reason = String((opts.error as Any)?.message || opts.error || "context_capacity_error");
    const exhausted = attemptNumber > opts.maxAttempts;
    if (exhausted) {
      this.emitBestEffortEvent("context_capacity_recovery_failed", {
        phase: opts.phase,
        stepId: opts.stepId,
        attempt: attemptNumber,
        maxAttempts: opts.maxAttempts,
        reason: "retries_exhausted",
        providerError: reason,
      });
      return { recovered: false, exhausted: true, messages: opts.messages };
    }

    const tokensBefore = estimateTotalTokens(opts.messages);
    const installsInHistory = this.state.transcript.conversationHistory === opts.messages;
    const compactionSession = this.beginCompaction({
      trigger: "capacity_recovery",
      phase: "mid_turn",
      reason: "provider_context_capacity_error",
      inputTokens: tokensBefore,
      targetRatio: CONTEXT_COMPACTION_OVERFLOW_TARGET_RATIO,
      extra: {
        phase: opts.phase,
        stepId: opts.stepId,
        attempt: attemptNumber,
        maxAttempts: opts.maxAttempts,
        historyInstall: installsInHistory,
      },
    });
    this.emitBestEffortEvent("context_capacity_recovery_started", {
      phase: opts.phase,
      stepId: opts.stepId,
      attempt: attemptNumber,
      maxAttempts: opts.maxAttempts,
      providerError: reason,
      tokensBefore,
    });

    try {
      const proactive = this.deps
        .getContextManager()
        .proactiveCompactWithMeta(
          opts.messages,
          opts.systemPromptTokens,
          CONTEXT_COMPACTION_OVERFLOW_TARGET_RATIO,
        );
      let compactedMessages = proactive.messages;
      let removedMessages = proactive.meta.removedMessages.messages;
      if (!proactive.meta.removedMessages.didRemove) {
        const fallback = this.deps
          .getContextManager()
          .compactMessagesWithMeta(compactedMessages, opts.systemPromptTokens);
        compactedMessages = fallback.messages;
        removedMessages = fallback.meta.removedMessages.messages;
      }
      const summaryResult = await this.installCompactionSummary({
        messages: compactedMessages,
        removedMessages,
        systemPromptTokens: opts.systemPromptTokens,
        maxOutputTokens: 1200,
        contextLabel: `${opts.phase} context-capacity recovery`,
        historySource: "context_capacity_recovery_source",
        proactive: true,
      });
      compactedMessages = summaryResult.messages;

      this.deps.pruneStaleToolErrors(compactedMessages);
      this.deps.consolidateConsecutiveUserMessages(compactedMessages);
      const hardBudget = this.getHardContextBudget(compactedMessages, opts.systemPromptTokens);
      const tokensAfter = hardBudget?.currentTokens ?? estimateTotalTokens(compactedMessages);
      if (hardBudget && tokensAfter > hardBudget.availableTokens) {
        const exhaustedError = this.createContextCapacityExhaustedError({
          phase: opts.phase,
          contextLabel: `${opts.phase} context-capacity recovery`,
          availableTokens: hardBudget.availableTokens,
          tokensBefore,
          tokensAfter,
        });
        this.emitContextCapacityRecoveryExhausted(exhaustedError, {
          phase: opts.phase,
          contextLabel: `${opts.phase} context-capacity recovery`,
          stepId: opts.stepId,
          attempt: attemptNumber,
          maxAttempts: opts.maxAttempts,
        });
        if (compactionSession) {
          this.failCompaction({
            compactionId: compactionSession.compactionId,
            trigger: "capacity_recovery",
            phase: "mid_turn",
            reason: exhaustedError.reason,
            retryable: attemptNumber < opts.maxAttempts,
            failureStage: "budget_check",
            inputTokens: tokensBefore,
            extra: { phase: opts.phase, stepId: opts.stepId },
          });
        }
        return { recovered: false, exhausted: true, messages: opts.messages };
      }

      if (compactionSession) {
        if (installsInHistory && !this.isHistoryProjectionCurrent(compactionSession.projection)) {
          this.failCompaction({
            compactionId: compactionSession.compactionId,
            trigger: "capacity_recovery",
            phase: "mid_turn",
            reason: "history_changed_while_compacting",
            retryable: true,
            failureStage: "install",
            inputTokens: tokensBefore,
            extra: { phase: opts.phase, stepId: opts.stepId },
          });
          return { recovered: false, exhausted: false, messages: opts.messages };
        }
        if (installsInHistory) {
          this.updateConversationHistory(compactedMessages);
          compactedMessages = this.state.transcript.conversationHistory;
        }
        if (summaryResult.summaryBlock && removedMessages.length > 0) {
          await this.persistCompactionSummaryMemory({
            removedMessages,
            summaryBlock: summaryResult.summaryBlock,
            contextLabel: `${opts.phase} context-capacity recovery`,
            historySource: "context_capacity_recovery_source",
            proactive: true,
          });
        }
        this.completeCompaction({
          compactionId: compactionSession.compactionId,
          trigger: "capacity_recovery",
          phase: "mid_turn",
          reason: "context_replacement_installed",
          inputTokens: tokensBefore,
          replacementTokens: tokensAfter,
          inputMessageCount: installsInHistory
            ? compactionSession.projection.length
            : opts.messages.length,
          replacementMessageCount: compactedMessages.length,
          removedMessageCount: removedMessages.length,
          removedApproxTokens: Math.max(0, tokensBefore - tokensAfter),
          targetRatio: CONTEXT_COMPACTION_OVERFLOW_TARGET_RATIO,
          summaryPreview: summaryResult.summaryBlock
            ? this.deps.extractPinnedBlockContent(
                summaryResult.summaryBlock,
                "PINNED_COMPACTION_SUMMARY",
                "PINNED_COMPACTION_SUMMARY_CLOSE",
              )
            : undefined,
          fallbackUsed: !summaryResult.summaryBlock,
          extra: {
            phase: opts.phase,
            stepId: opts.stepId,
            historyInstalled: installsInHistory,
          },
        });
      }
      this.emitBestEffortEvent("context_capacity_recovery_completed", {
        phase: opts.phase,
        stepId: opts.stepId,
        attempt: attemptNumber,
        maxAttempts: opts.maxAttempts,
        tokensBefore,
        tokensAfter,
        removedApproxTokens: Math.max(0, tokensBefore - tokensAfter),
      });
      this.emitBestEffortEvent("log", {
        metric: "context_capacity_recovery_completed",
        phase: opts.phase,
        stepId: opts.stepId,
        attempt: attemptNumber,
        maxAttempts: opts.maxAttempts,
        tokensBefore,
        tokensAfter,
      });
      return { recovered: true, exhausted: false, messages: compactedMessages };
    } catch (compactionError: Any) {
      if (compactionSession) {
        this.failCompaction({
          compactionId: compactionSession.compactionId,
          trigger: "capacity_recovery",
          phase: "mid_turn",
          reason: compactionError?.message || String(compactionError),
          retryable: true,
          failureStage: "summarize",
          inputTokens: tokensBefore,
          extra: { phase: opts.phase, stepId: opts.stepId },
        });
      }
      this.emitBestEffortEvent("context_capacity_recovery_failed", {
        phase: opts.phase,
        stepId: opts.stepId,
        attempt: attemptNumber,
        maxAttempts: opts.maxAttempts,
        reason: compactionError?.message || String(compactionError),
      });
      return { recovered: false, exhausted: false, messages: opts.messages };
    }
  }

  async maybeCompactBeforeContinuation(_assessment: Any): Promise<void> {
    if (!this.deps.shouldCompactOnContinuation()) return;

    const windowEvents = this.deps.getWindowEventsSinceLastReset();
    const contextRatio = this.deps.getRenderedContextRatio();
    const noMutation = !this.deps.hasWindowMutationEvidence(windowEvents);
    const toolUseStopStreak = this.deps.getWindowToolUseStopStreak(windowEvents);
    const shouldCompact =
      contextRatio >= this.deps.getCompactionThresholdRatio() ||
      (toolUseStopStreak >= 6 && noMutation);
    if (!shouldCompact) return;

    const systemPromptTokens = estimateTokens(this.deps.getSystemPrompt() || "");
    const tokensBefore = estimateTotalTokens(this.state.transcript.conversationHistory);
    const compactionSession = this.beginCompaction({
      trigger: "continuation",
      phase: "mid_turn",
      reason: toolUseStopStreak >= 6 && noMutation ? "no_progress" : "threshold",
      inputTokens: tokensBefore,
      thresholdRatio: this.deps.getCompactionThresholdRatio(),
      targetRatio: DEFAULT_CONTEXT_COMPACTION_TARGET_RATIO,
      extra: {
        continuationWindow: this.state.loop.continuationWindow,
        contextRatio,
        toolUseStopStreak,
        noMutation,
      },
    });
    if (!compactionSession) return;

    try {
      const compacted = this.deps
        .getContextManager()
        .compactMessagesWithMeta(this.state.transcript.conversationHistory, systemPromptTokens);
      let continuationMessages = compacted.messages;
      let summaryBlock: string | undefined;
      if (
        compacted.meta.removedMessages.didRemove &&
        compacted.meta.removedMessages.messages.length > 0
      ) {
        const summaryResult = await this.installCompactionSummary({
          messages: continuationMessages,
          removedMessages: compacted.meta.removedMessages.messages,
          systemPromptTokens,
          maxOutputTokens: 1200,
          availableTokens: (() => {
            const contextManager = this.deps.getContextManager() as Any;
            const availableTokens =
              typeof contextManager?.getAvailableTokens === "function"
                ? contextManager.getAvailableTokens(systemPromptTokens)
                : Number.MAX_SAFE_INTEGER;
            return typeof availableTokens === "number" && Number.isFinite(availableTokens)
              ? availableTokens
              : Number.MAX_SAFE_INTEGER;
          })(),
          contextLabel: "continuation compaction",
          proactive: false,
          allowMemoryInjection: true,
        });
        continuationMessages = summaryResult.messages;
        summaryBlock = summaryResult.summaryBlock;
      }
      if (!this.isHistoryProjectionCurrent(compactionSession.projection)) {
        this.failCompaction({
          compactionId: compactionSession.compactionId,
          trigger: "continuation",
          phase: "mid_turn",
          reason: "history_changed_while_compacting",
          retryable: true,
          failureStage: "install",
          inputTokens: tokensBefore,
          extra: { continuationWindow: this.state.loop.continuationWindow },
        });
        return;
      }

      this.updateConversationHistory(continuationMessages);
      if (summaryBlock && compacted.meta.removedMessages.messages.length > 0) {
        await this.persistCompactionSummaryMemory({
          removedMessages: compacted.meta.removedMessages.messages,
          summaryBlock,
          contextLabel: "continuation compaction",
          proactive: false,
          allowMemoryInjection: true,
        });
      }
      const tokensAfter = estimateTotalTokens(this.state.transcript.conversationHistory);
      this.state.loop.compactionCount += 1;
      this.state.loop.lastCompactionAt = Date.now();
      this.state.loop.lastCompactionTokensBefore = tokensBefore;
      this.state.loop.lastCompactionTokensAfter = tokensAfter;
      this.deps.updateTask({
        ...this.projectTaskState(),
      });
      const summaryText = summaryBlock
        ? this.deps.extractPinnedBlockContent(
            summaryBlock,
            "PINNED_COMPACTION_SUMMARY",
            "PINNED_COMPACTION_SUMMARY_CLOSE",
          )
        : undefined;
      this.completeCompaction({
        compactionId: compactionSession.compactionId,
        trigger: "continuation",
        phase: "mid_turn",
        reason: "context_replacement_installed",
        inputTokens: tokensBefore,
        replacementTokens: tokensAfter,
        inputMessageCount: compactionSession.projection.length,
        replacementMessageCount: this.state.transcript.conversationHistory.length,
        removedMessageCount: compacted.meta.removedMessages.count,
        removedApproxTokens: Math.max(0, tokensBefore - tokensAfter),
        thresholdRatio: this.deps.getCompactionThresholdRatio(),
        targetRatio: DEFAULT_CONTEXT_COMPACTION_TARGET_RATIO,
        summaryPreview: summaryText,
        fallbackUsed: !summaryBlock,
        extra: {
          continuationWindow: this.state.loop.continuationWindow,
        },
      });
      if (summaryBlock) {
        this.emitBestEffortEvent("context_summarized", {
          compactionId: compactionSession.compactionId,
          summaryPreview: compactPreview(
            InputSanitizer.sanitizeMemoryContent(
              this.deps.extractPinnedBlockContent(
                summaryBlock,
                "PINNED_COMPACTION_SUMMARY",
                "PINNED_COMPACTION_SUMMARY_CLOSE",
              ),
            ),
          ),
          summaryRef: `compaction:${compactionSession.compactionId}`,
          removedCount: compacted.meta.removedMessages.count,
          tokensBefore: compacted.meta.originalTokens,
          tokensAfter,
          proactive: false,
        });
      }
    } catch (error: Any) {
      this.failCompaction({
        compactionId: compactionSession.compactionId,
        trigger: "continuation",
        phase: "mid_turn",
        reason: error?.message || String(error),
        retryable: true,
        failureStage: "summarize",
        inputTokens: tokensBefore,
        extra: { continuationWindow: this.state.loop.continuationWindow },
      });
    }
  }

  async maybeAutoContinueAfterTurnLimit(error: unknown): Promise<boolean> {
    if (!this.deps.isWindowTurnLimitExceededError(error)) return false;

    while (true) {
      const pendingSteps =
        this.deps.getPlan()?.steps?.filter((step) => step.status === "pending").length || 0;
      const assessment = this.deps.assessContinuationWindow();
      const threshold = this.deps.getMinProgressScoreForAutoContinue();
      const continuationBudgetRemaining = Math.max(
        0,
        this.deps.getMaxAutoContinuations() - this.state.loop.continuationCount,
      );
      const reachedContinuationCap = continuationBudgetRemaining <= 0;
      const hasLoopRisk =
        assessment.loopRiskIndex >= 0.7 || assessment.repeatedFingerprintCount >= 3;
      const reachedLoopWarning =
        assessment.repeatedFingerprintCount >= this.deps.getLoopWarningThreshold();
      const reachedLoopCritical =
        assessment.repeatedFingerprintCount >= this.deps.getLoopCriticalThreshold();
      const belowProgressThreshold =
        this.deps.getContinuationStrategy() === "adaptive_progress" &&
        assessment.progressScore < threshold;
      const noPendingSteps = pendingSteps <= 0;
      const lifetimeCapHit = this.state.loop.lifetimeTurnCount >= this.deps.getMaxLifetimeTurns();
      this.state.loop.noProgressStreak =
        assessment.progressScore <= 0 ? this.state.loop.noProgressStreak + 1 : 0;
      this.state.loop.lastLoopFingerprint =
        assessment.dominantFingerprint || this.state.loop.lastLoopFingerprint;
      const noProgressCircuitBreak =
        this.state.loop.noProgressStreak >= this.deps.getGlobalNoProgressCircuitBreaker();
      const lowProgressBlockReason = belowProgressThreshold
        ? `Recent progress score (${assessment.progressScore.toFixed(2)}) is below threshold (${threshold.toFixed(2)}).`
        : "";

      let blockReason = "";
      if (lifetimeCapHit) {
        blockReason = `Lifetime turn limit reached (${this.state.loop.lifetimeTurnCount}/${this.deps.getMaxLifetimeTurns()}).`;
      } else if (noPendingSteps) {
        blockReason = "No pending plan steps remain to continue.";
      } else if (noProgressCircuitBreak) {
        blockReason = `No-progress circuit breaker reached (${this.state.loop.noProgressStreak}/${this.deps.getGlobalNoProgressCircuitBreaker()}).`;
      } else if (reachedContinuationCap) {
        blockReason = `Auto continuation limit reached (${this.state.loop.continuationCount}/${this.deps.getMaxAutoContinuations()}).`;
      } else if (reachedLoopCritical) {
        this.state.loop.blockedLoopFingerprintForWindow = this.deps.getSignatureFromLoopFingerprint(
          assessment.dominantFingerprint,
        );
        blockReason = `Loop fingerprint repeated too often (${assessment.repeatedFingerprintCount}/${this.deps.getLoopCriticalThreshold()}).`;
      } else if (hasLoopRisk) {
        blockReason = `Loop risk is high (${assessment.loopRiskIndex.toFixed(2)}). Try changing strategy or constraints.`;
      } else if (belowProgressThreshold) {
        blockReason = lowProgressBlockReason;
      }

      // Low progress is a soft stop: Jev may recommend one changed-strategy
      // continuation, while hard caps and policy circuit breakers remain
      // non-overridable by an external decision provider.
      const softProgressBlock = Boolean(
        lowProgressBlockReason && blockReason === lowProgressBlockReason,
      );
      const hardStopReason = blockReason && !softProgressBlock ? blockReason : undefined;

      let jevLoopAction:
        | "continue"
        | "change_strategy"
        | "stop"
        | "ask_user"
        | "abstain"
        | undefined;
      const shouldAskJevForLoopAdvice =
        !hardStopReason &&
        Boolean(this.deps.evaluateJevLoopDecision) &&
        (reachedLoopWarning || belowProgressThreshold || this.state.loop.noProgressStreak > 0);
      if (shouldAskJevForLoopAdvice) {
        try {
          const jevDecision = await this.deps.evaluateJevLoopDecision!({
            progressScore: assessment.progressScore,
            loopRiskIndex: assessment.loopRiskIndex,
            repeatedFingerprintCount: assessment.repeatedFingerprintCount,
            noProgressStreak: this.state.loop.noProgressStreak,
            pendingSteps,
            dominantFingerprint: assessment.dominantFingerprint,
            hardStopReason,
          });
          jevLoopAction = jevDecision.action;
          this.deps.emitEvent("jev_loop_decision", {
            action: jevDecision.action,
            status: jevDecision.status,
            reason: jevDecision.reason,
            model: jevDecision.model,
            repeatedFingerprintCount: assessment.repeatedFingerprintCount,
            progressScore: assessment.progressScore,
            ...(typeof jevDecision.confidence === "number"
              ? { confidence: jevDecision.confidence }
              : {}),
            ...(typeof jevDecision.probability === "number"
              ? { probability: jevDecision.probability }
              : {}),
          });
          if (jevDecision.action === "change_strategy") {
            if (softProgressBlock) blockReason = "";
            this.state.loop.pendingLoopStrategySwitchMessage =
              "Jev loop advice: change strategy before retrying the same target.";
          } else if (jevDecision.action === "stop" || jevDecision.action === "ask_user") {
            blockReason =
              jevDecision.action === "ask_user"
                ? "Jev loop controller requested a user decision before continuing."
                : "Jev loop controller recommended stopping the repeated or low-progress path.";
          }
        } catch {
          jevLoopAction = "abstain";
        }
      }

      this.deps.emitEvent("continuation_decision", {
        policy: this.deps.getContinuationStrategy(),
        continuationWindow: this.state.loop.continuationWindow,
        continuationCount: this.state.loop.continuationCount,
        maxAutoContinuations: this.deps.getMaxAutoContinuations(),
        progressScore: assessment.progressScore,
        progressThreshold: threshold,
        loopRiskIndex: assessment.loopRiskIndex,
        repeatedFingerprintCount: assessment.repeatedFingerprintCount,
        dominantFingerprint: assessment.dominantFingerprint,
        noProgressStreak: this.state.loop.noProgressStreak,
        jevLoopAction,
        loopWarningThreshold: this.deps.getLoopWarningThreshold(),
        loopCriticalThreshold: this.deps.getLoopCriticalThreshold(),
        allowed: !blockReason,
        reason: blockReason || "Continuation approved.",
      });

      if (reachedLoopWarning && !blockReason) {
        this.state.loop.pendingLoopStrategySwitchMessage =
          "Loop warning: switch strategy now. Use a different tool family or change input class before retrying the same operation.";
        this.deps.emitEvent("step_contract_escalated", {
          reason: "loop_warning_threshold_reached",
          repeatedFingerprintCount: assessment.repeatedFingerprintCount,
          threshold: this.deps.getLoopWarningThreshold(),
          dominantFingerprint: assessment.dominantFingerprint,
        });
      }

      this.deps.updateTask({
        ...this.projectTaskState(),
        lastProgressScore: assessment.progressScore,
        autoContinueBlockReason: blockReason || undefined,
      });

      if (blockReason) {
        this.deps.emitEvent("safety_stop_triggered", {
          taskId: this.deps.getTask().id,
          policy: this.deps.getEffectiveTurnBudgetPolicy(),
          reason: blockReason,
          progressScore: assessment.progressScore,
          loopRiskIndex: assessment.loopRiskIndex,
          repeatedFingerprintCount: assessment.repeatedFingerprintCount,
          noProgressStreak: this.state.loop.noProgressStreak,
          continuationCount: this.state.loop.continuationCount,
          maxAutoContinuations: this.deps.getMaxAutoContinuations(),
          nextActions: [
            "Narrow the requested scope",
            "Provide exact target paths/commands",
            "Change strategy constraints before continuing",
          ],
        });
        if (noProgressCircuitBreak) {
          this.deps.setTerminalStatus("needs_user_action");
          this.deps.setFailureClass("budget_exhausted");
          this.deps.emitEvent("no_progress_circuit_breaker", {
            noProgressStreak: this.state.loop.noProgressStreak,
            threshold: this.deps.getGlobalNoProgressCircuitBreaker(),
            dominantFingerprint: assessment.dominantFingerprint,
            nextActions: [
              "Narrow the requested scope",
              "Provide exact target paths/commands",
              "Change strategy constraints before continuing",
            ],
          });
          this.deps.updateTask({
            terminalStatus: "needs_user_action",
            failureClass: "budget_exhausted",
          });
        }
        this.deps.emitEvent("auto_continuation_blocked", {
          reason: blockReason,
          suggestion:
            "Try narrowing scope, providing precise constraints, or giving a different approach before continuing manually.",
          progressScore: assessment.progressScore,
          loopRiskIndex: assessment.loopRiskIndex,
          noProgressStreak: this.state.loop.noProgressStreak,
        });
        return false;
      }

      await this.maybeCompactBeforeContinuation(assessment);
      this.state.loop.continuationCount += 1;
      this.state.loop.continuationWindow += 1;
      this.deps.emitEvent("auto_continuation_started", {
        mode: "auto",
        continuationCount: this.state.loop.continuationCount,
        continuationWindow: this.state.loop.continuationWindow,
        maxAutoContinuations: this.deps.getMaxAutoContinuations(),
        progressScore: assessment.progressScore,
        loopRiskIndex: assessment.loopRiskIndex,
      });
      this.deps.updateTask({
        ...this.projectTaskState(),
        lastProgressScore: assessment.progressScore,
        autoContinueBlockReason: undefined,
      });

      try {
        await this.continueAfterBudgetExhausted("auto", assessment, true);
        return true;
      } catch (continuationError) {
        if (this.deps.isWindowTurnLimitExceededError(continuationError)) {
          continue;
        }
        throw continuationError;
      }
    }
  }

  resetTurnBudgetWindow(opts: { mode: "manual" | "auto" | "follow_up"; reason: string }): void {
    const preResetUsage = {
      inputTokens: this.getCumulativeInputTokens(),
      outputTokens: this.getCumulativeOutputTokens(),
      totalTokens: this.getCumulativeInputTokens() + this.getCumulativeOutputTokens(),
      cost: this.getCumulativeCost(),
    };
    this.deps.emitEvent("budget_reset_for_continuation", {
      reason: opts.reason,
      mode: opts.mode,
      continuationCount: this.state.loop.continuationCount,
      continuationWindow: this.state.loop.continuationWindow,
      previousUsageTotals: preResetUsage,
    });

    this.state.usage.usageOffsetInputTokens = preResetUsage.inputTokens;
    this.state.usage.usageOffsetOutputTokens = preResetUsage.outputTokens;
    this.state.usage.usageOffsetCost = preResetUsage.cost;
    this.state.loop.globalTurnCount = 0;
    this.state.loop.iterationCount = 0;
    this.state.usage.totalInputTokens = 0;
    this.state.usage.totalOutputTokens = 0;
    this.state.usage.totalCost = 0;
    this.state.loop.softDeadlineTriggered = false;
    this.state.loop.wrapUpRequested = false;
    this.state.loop.blockedLoopFingerprintForWindow = null;
    this.state.loop.turnWindowSoftExhaustedNotified = false;
    this.state.loop.windowStartEventCount = this.deps.getTaskEvents().length;
    this.deps.updateTask({
      ...this.projectTaskState(),
      autoContinueBlockReason: undefined,
    });
  }

  resetForRetry(): void {
    this.state.tooling.toolFailureTracker = new ToolFailureTracker();
    this.state.tooling.toolResultMemory = [];
    this.state.tooling.availableToolsCacheKey = null;
    this.state.tooling.availableToolsCache = null;
    this.state.transcript.lastAssistantOutput = null;
    this.state.transcript.lastNonVerificationOutput = null;
    this.state.transcript.lastAssistantText = null;
    this.state.recovery.recoveryRequestActive = false;
    this.state.recovery.lastRecoveryFailureSignature = "";
    this.state.recovery.recoveredFailureStepIds.clear();
    this.state.recovery.lastRecoveryClass = null;
    this.state.recovery.lastToolDisabledScope = null;
    this.state.recovery.lastRetryReason = null;
    this.state.loop.pendingLoopStrategySwitchMessage = "";
    this.state.loop.blockedLoopFingerprintForWindow = null;
  }

  async continueAfterBudgetExhausted(
    mode: "manual" | "auto",
    continuationAssessment?: Any,
    rethrowOnError = false,
  ): Promise<void> {
    try {
      if (mode === "manual") {
        this.state.loop.continuationCount += 1;
        this.state.loop.continuationWindow += 1;
      }
      const assessment = continuationAssessment ?? this.deps.assessContinuationWindow();
      this.state.loop.noProgressStreak =
        assessment.progressScore <= 0 ? this.state.loop.noProgressStreak + 1 : 0;
      if (assessment.dominantFingerprint) {
        this.state.loop.lastLoopFingerprint = assessment.dominantFingerprint;
      }
      if (mode === "manual") {
        this.deps.emitEvent("continuation_decision", {
          policy: this.deps.getContinuationStrategy(),
          continuationWindow: this.state.loop.continuationWindow,
          continuationCount: this.state.loop.continuationCount,
          maxAutoContinuations: this.deps.getMaxAutoContinuations(),
          progressScore: assessment.progressScore,
          progressThreshold: this.deps.getMinProgressScoreForAutoContinue(),
          loopRiskIndex: assessment.loopRiskIndex,
          repeatedFingerprintCount: assessment.repeatedFingerprintCount,
          dominantFingerprint: assessment.dominantFingerprint,
          allowed: true,
          reason: "Manual continuation requested by user.",
        });
      }
      if (!(mode === "auto" && continuationAssessment)) {
        await this.maybeCompactBeforeContinuation(assessment);
      }
      this.resetTurnBudgetWindow({
        mode,
        reason: "turn_limit_exhausted",
      });

      const plan = this.deps.getPlan();
      if (!plan) {
        throw new Error(
          "Cannot continue task after budget exhaustion because no execution plan could be restored.",
        );
      }

      const pendingSteps = plan.steps.filter((s) => s.status === "pending");
      if (pendingSteps.length === 0) {
        this.deps.finalizeTaskWithFallback(this.deps.buildResultSummary());
        return;
      }

      const completedSteps = plan.steps.filter((s) => s.status === "completed");
      const continuationLines = [
        "TASK CONTINUATION CONTEXT:",
        mode === "auto"
          ? "This task hit the turn window. Auto continuation is enabled and progress checks passed."
          : "This task was stopped because it reached its turn/budget limit. The user has chosen to continue.",
        `Plan: ${plan.description}`,
      ];
      if (completedSteps.length > 0) {
        continuationLines.push(`Completed steps (${completedSteps.length}):`);
        for (const s of completedSteps) {
          continuationLines.push(`  - [DONE] ${s.description}`);
        }
      }
      continuationLines.push(`Remaining steps (${pendingSteps.length}):`);
      for (const s of pendingSteps) {
        continuationLines.push(`  - [PENDING] ${s.description}`);
      }
      continuationLines.push(
        "",
        "Continue execution from where you left off. Do not repeat already-completed steps.",
      );
      if (this.state.loop.pendingLoopStrategySwitchMessage) {
        continuationLines.push("", this.state.loop.pendingLoopStrategySwitchMessage);
        this.state.loop.pendingLoopStrategySwitchMessage = "";
      }

      this.appendConversationHistory({
        role: "user",
        content: continuationLines.join("\n"),
      });
      this.appendConversationHistory({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Understood. Continuing execution from where I left off.",
          },
        ],
      });

      this.deps.updateTaskStatus("executing");
      this.deps.emitEvent("executing", {
        message:
          mode === "auto"
            ? "Auto-continuing execution after turn window"
            : "Continuing execution after budget limit",
      });

      await this.deps.executePlan();

      if (this.deps.isWaitingForUserInput() || this.deps.isCancelled()) {
        return;
      }

      if (this.deps.getTask().successCriteria) {
        const result = await this.deps.verifySuccessCriteria();
        if (result.success) {
          this.deps.emitEvent("verification_passed", {
            attempt: this.deps.getTask().currentAttempt || 1,
            message: result.message,
          });
        } else {
          this.deps.emitEvent("verification_failed", {
            attempt: this.deps.getTask().currentAttempt || 1,
            maxAttempts: this.deps.getTask().maxAttempts || 1,
            message: result.message,
            willRetry: false,
          });
          throw new Error(`Failed to meet success criteria: ${result.message}`);
        }
      }

      this.deps.finalizeTaskWithFallback(this.deps.buildResultSummary());
    } catch (error: Any) {
      if (this.deps.isCancelled()) {
        return;
      }

      if (rethrowOnError) {
        throw error;
      }

      this.saveSnapshot();
      const errorPayload: Record<string, unknown> = {
        message: error?.message || String(error),
        stack: error?.stack,
      };
      if (this.deps.isWindowTurnLimitExceededError(error)) {
        errorPayload.actionHint = {
          type: "continue_task",
          label: "Continue",
        };
        errorPayload.errorCode = TASK_ERROR_CODES.TURN_LIMIT_EXCEEDED;
      }
      this.deps.updateTask({
        status: "failed",
        error: error?.message || String(error),
        completedAt: Date.now(),
        ...this.projectTaskState(),
      });
      this.deps.emitTerminalFailureOnce(errorPayload);
    } finally {
      await this.deps.cleanupTools().catch(() => {});
    }
  }

  saveSnapshot(planSummary?: Any): boolean {
    try {
      if (
        this.state.transcript.conversationHistory.length === 0 &&
        !this.hasPendingFollowUps &&
        this.getConsumedFollowUpMessageIds().size === 0
      ) {
        return true;
      }

      const serializedHistory = this.serializeConversationWithSizeLimit(
        this.state.transcript.conversationHistory,
      );
      const trackerState = this.state.files.fileOperationTracker.serialize();
      const meta = this.deps.getModelMetadata();
      const payload: SessionRuntimeSnapshotV2 = {
        schema: "session_runtime_v2",
        version: 2,
        conversationHistory: serializedHistory,
        trackerState,
        planSummary: planSummary ?? this.deps.getPlanSummary(),
        transcript: {
          lastUserMessage: this.state.transcript.lastUserMessage,
          lastAssistantOutput: this.state.transcript.lastAssistantOutput,
          lastNonVerificationOutput: this.state.transcript.lastNonVerificationOutput,
          lastAssistantText: this.state.transcript.lastAssistantText,
          explicitChatSummaryBlock: this.state.transcript.explicitChatSummaryBlock,
          explicitChatSummaryCreatedAt: this.state.transcript.explicitChatSummaryCreatedAt,
          explicitChatSummarySourceMessageCount:
            this.state.transcript.explicitChatSummarySourceMessageCount,
          ...(this.state.transcript.explicitChatSummaryInputSignature
            ? {
                explicitChatSummaryInputSignature:
                  this.state.transcript.explicitChatSummaryInputSignature,
              }
            : {}),
          stepOutcomeSummaries: [...this.state.transcript.stepOutcomeSummaries],
        },
        tooling: {
          toolResultMemory: [...this.state.tooling.toolResultMemory],
          webEvidenceMemory: [...this.state.tooling.webEvidenceMemory],
          toolUsageCounts: Array.from(this.state.tooling.toolUsageCounts.entries()),
          successfulToolUsageCounts: Array.from(
            this.state.tooling.successfulToolUsageCounts.entries(),
          ),
          turnSuccessfulToolUsageCounts: Array.from(
            this.state.tooling.turnSuccessfulToolUsageCounts.entries(),
          ),
          toolUsageEventsSinceDecay: this.state.tooling.toolUsageEventsSinceDecay,
          toolSelectionEpoch: this.state.tooling.toolSelectionEpoch,
          discoveredDeferredToolNames: Array.from(
            this.state.tooling.discoveredDeferredToolNames.values(),
          ),
        },
        files: {
          filesReadTracker: Array.from(this.state.files.filesReadTracker.entries()),
        },
        loop: {
          ...this.state.loop,
        },
        recovery: {
          ...this.state.recovery,
          recoveredFailureStepIds: Array.from(this.state.recovery.recoveredFailureStepIds.values()),
        },
        queues: {
          pendingFollowUps: [...this.state.queues.pendingFollowUps],
          consumedFollowUpMessageIds: this.getConsumedFollowUpMessageIdsSnapshot(),
          stepFeedbackSignal: this.state.queues.stepFeedbackSignal,
        },
        skills: {
          pendingParameterCollection: this.state.skills.pendingParameterCollection
            ? { ...this.state.skills.pendingParameterCollection }
            : null,
          primarySlashCommandHandled: this.state.skills.primarySlashCommandHandled,
        },
        worker: {
          dispatchedMentionedAgents: this.state.worker.dispatchedMentionedAgents,
          verificationAgentState: { ...this.state.worker.verificationAgentState },
        },
        permissions: {
          mode: this.state.permissions.mode,
          sessionRules: [...this.state.permissions.sessionRules],
          temporaryGrants: Array.from(this.state.permissions.temporaryGrants.entries()),
          denialTracking: Array.from(this.state.permissions.denialTracking.entries()),
          latestPromptContext: this.state.permissions.latestPromptContext,
          recentSensitiveSources: [...this.state.permissions.recentSensitiveSources],
        },
        verification: {
          verificationEvidenceEntries: [...this.state.verification.verificationEvidenceEntries],
          nonBlockingVerificationFailedStepIds: Array.from(
            this.state.verification.nonBlockingVerificationFailedStepIds.values(),
          ),
          blockingVerificationFailedStepIds: Array.from(
            this.state.verification.blockingVerificationFailedStepIds.values(),
          ),
        },
        checklist: this.cloneTaskListState(),
        promptCache: {
          stableSystemBlocks: [...this.state.promptCache.stableSystemBlocks],
          stablePrefixHash: this.state.promptCache.stablePrefixHash,
          toolSchemaHash: this.state.promptCache.toolSchemaHash,
          promptCacheMode: this.state.promptCache.promptCacheMode,
          promptCacheProviderFamily: this.state.promptCache.promptCacheProviderFamily,
          promptCacheTtl: this.state.promptCache.promptCacheTtl,
          promptCacheInvalidationReason: this.state.promptCache.promptCacheInvalidationReason,
        },
        timestamp: Date.now(),
        messageCount: serializedHistory.length,
        modelId: meta.modelId,
        modelKey: meta.modelKey,
        llmProfileUsed: meta.llmProfileUsed,
        resolvedModelKey: meta.resolvedModelKey,
        usageTotals: {
          inputTokens: this.getCumulativeInputTokens(),
          outputTokens: this.getCumulativeOutputTokens(),
          cost: this.getCumulativeCost(),
        },
        compaction: this.getCompactionSnapshot(),
      };
      const estimatedSize = JSON.stringify(payload).length;
      this.deps.emitEvent("conversation_snapshot", {
        ...payload,
        estimatedSizeBytes: estimatedSize,
      });
      try {
        this.deps.pruneOldSnapshots();
      } catch {
        // Pruning is housekeeping. The snapshot event above is the durability
        // boundary and remains successful when cleanup fails.
      }
      return true;
    } catch {
      // Callers that use this as a durability boundary must be able to retain
      // their queue item and retry when persistence fails.
      return false;
    }
  }

  private serializeConversationWithSizeLimit(history: LLMMessage[]): Any[] {
    const MAX_CONTENT_LENGTH = 50000;
    const MAX_TOOL_RESULT_LENGTH = 10000;
    const sanitizedHistory = sanitizeToolCallHistory(history);

    return sanitizedHistory.map((msg) => {
      if (typeof msg.content === "string") {
        return {
          role: msg.role,
          content:
            msg.content.length > MAX_CONTENT_LENGTH
              ? msg.content.slice(0, MAX_CONTENT_LENGTH) +
                "\n[... content truncated for snapshot ...]"
              : msg.content,
        };
      }

      if (Array.isArray(msg.content)) {
        const truncatedContent = msg.content.map((block: Any) => {
          if (block.type === "tool_result" && block.content) {
            const content =
              typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            return {
              ...block,
              content:
                content.length > MAX_TOOL_RESULT_LENGTH
                  ? content.slice(0, MAX_TOOL_RESULT_LENGTH) + "\n[... truncated ...]"
                  : block.content,
            };
          }
          if (block.type === "text" && block.text && block.text.length > MAX_CONTENT_LENGTH) {
            return {
              ...block,
              text: block.text.slice(0, MAX_CONTENT_LENGTH) + "\n[... truncated ...]",
            };
          }
          if (block.type === "image") {
            return {
              type: "text",
              text: `[Image was attached: ${block.mimeType || "unknown"}, ${((block.originalSizeBytes || 0) / 1024).toFixed(0)}KB]`,
            };
          }
          return block;
        });
        return { role: msg.role, content: truncatedContent };
      }

      return { role: msg.role, content: msg.content };
    });
  }

  private getRuntimeEventFreshness(
    event: TaskEvent,
    position: number,
  ): RuntimeRecoverySourceFreshness {
    const sequence = typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : null;
    const rawTimestamp = typeof event.ts === "number" ? event.ts : event.timestamp;
    const timestamp =
      typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) ? rawTimestamp : null;
    return { sequence, timestamp, position };
  }

  private compareRuntimeRecoveryFreshness(
    left: RuntimeRecoverySourceFreshness,
    right: RuntimeRecoverySourceFreshness,
  ): number {
    // Sequence numbers are the canonical ordering signal when both sources
    // have them. Timestamps remain the compatible fallback for older events
    // and checkpoints that predate sequence persistence.
    if (left.sequence !== null && right.sequence !== null && left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    if (left.timestamp !== null || right.timestamp !== null) {
      if (left.timestamp === null) return -1;
      if (right.timestamp === null) return 1;
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    }
    return left.position - right.position;
  }

  private getCheckpointRecoveryFreshness(
    checkpointPayload: Any,
    events: TaskEvent[],
  ): RuntimeRecoverySourceFreshness {
    const sourceEventId =
      typeof checkpointPayload?.sourceEventId === "string"
        ? checkpointPayload.sourceEventId.trim()
        : "";
    if (sourceEventId) {
      const sourcePosition = events.findIndex(
        (event) => event.id === sourceEventId || event.eventId === sourceEventId,
      );
      if (sourcePosition >= 0) {
        const sourceEvent = events[sourcePosition];
        if (sourceEvent) {
          return this.getRuntimeEventFreshness(sourceEvent, sourcePosition);
        }
      }
    }

    const rawTimestamp =
      typeof checkpointPayload?.sourceTimestamp === "number"
        ? checkpointPayload.sourceTimestamp
        : checkpointPayload?.timestamp;
    const timestamp =
      typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) ? rawTimestamp : null;
    return { sequence: null, timestamp, position: -1 };
  }

  private getLatestSnapshotEvent(
    events: TaskEvent[],
  ): { event: TaskEvent; freshness: RuntimeRecoverySourceFreshness } | null {
    let latest: { event: TaskEvent; freshness: RuntimeRecoverySourceFreshness } | null = null;
    events.forEach((event, position) => {
      if (this.deps.getReplayEventType(event) !== "conversation_snapshot") return;
      const freshness = this.getRuntimeEventFreshness(event, position);
      if (!latest || this.compareRuntimeRecoveryFreshness(freshness, latest.freshness) > 0) {
        latest = { event, freshness };
      }
    });
    return latest;
  }

  private restoreStepFeedbackStateFromEvents(
    events: TaskEvent[],
    snapshotFreshness?: RuntimeRecoverySourceFreshness | null,
  ): void {
    const consumedFeedbackIds = new Set<string>();
    const consumedFeedbackSignatures = new Set<string>();
    const relevantEvents = events
      .map((event, position) => ({
        event,
        position,
        freshness: this.getRuntimeEventFreshness(event, position),
      }))
      .filter(({ event, freshness }) => {
        if (
          snapshotFreshness &&
          this.compareRuntimeRecoveryFreshness(freshness, snapshotFreshness) <= 0
        ) {
          return false;
        }
        const type = this.deps.getReplayEventType(event);
        const payload = event.payload as Any;
        const isFeedbackEvent =
          type === "step_feedback_received" ||
          (type === "step_feedback" && payload?.consumed !== true) ||
          event.legacyType === "step_feedback" ||
          payload?.legacyType === "step_feedback";
        const isConsumedEvent =
          type === "step_feedback_consumed" ||
          (type === "step_feedback" && payload?.consumed === true);
        return isFeedbackEvent || isConsumedEvent;
      })
      .sort((left, right) => this.compareRuntimeRecoveryFreshness(left.freshness, right.freshness));

    let signal = this.state.queues.stepFeedbackSignal;
    for (const { event } of relevantEvents) {
      const type = this.deps.getReplayEventType(event);
      const payload = event.payload as Any;
      if (
        type === "step_feedback_consumed" ||
        (type === "step_feedback" && payload?.consumed === true)
      ) {
        const feedbackId = typeof payload?.feedbackId === "string" ? payload.feedbackId.trim() : "";
        const signature =
          typeof payload?.feedbackSignature === "string" && payload.feedbackSignature
            ? payload.feedbackSignature
            : typeof payload?.stepId === "string" &&
                typeof payload?.action === "string" &&
                this.isStepFeedbackAction(payload.action)
              ? this.getStepFeedbackSignature(
                  payload.stepId,
                  payload.action,
                  typeof payload.message === "string" ? payload.message : undefined,
                )
              : "";
        if (feedbackId) consumedFeedbackIds.add(feedbackId);
        if (signature) consumedFeedbackSignatures.add(signature);
        if (
          signal &&
          ((feedbackId && signal.feedbackId === feedbackId) ||
            (signature &&
              this.getStepFeedbackSignature(signal.stepId, signal.action, signal.message) ===
                signature))
        ) {
          signal = null;
        }
        continue;
      }

      const stepId =
        typeof payload?.stepId === "string"
          ? payload.stepId.trim()
          : typeof payload?.step?.id === "string"
            ? payload.step.id.trim()
            : "";
      const action = this.isStepFeedbackAction(payload?.action) ? payload.action : null;
      if (!stepId || !action) continue;
      const message = typeof payload?.message === "string" ? payload.message : undefined;
      const feedbackId = typeof payload?.feedbackId === "string" ? payload.feedbackId.trim() : "";
      const signature =
        typeof payload?.feedbackSignature === "string" && payload.feedbackSignature
          ? payload.feedbackSignature
          : this.getStepFeedbackSignature(stepId, action, message);

      if (feedbackId && consumedFeedbackIds.has(feedbackId)) {
        continue;
      }
      // A new explicitly identified feedback supersedes an older legacy
      // fallback with the same text; preserve repeated identical decisions.
      if (feedbackId) consumedFeedbackSignatures.delete(signature);
      if (!feedbackId && consumedFeedbackSignatures.has(signature)) continue;

      signal = {
        ...(feedbackId ? { feedbackId } : {}),
        stepId,
        action,
        ...(message !== undefined ? { message } : {}),
      };
    }
    this.state.queues.stepFeedbackSignal = signal;
  }

  private isStepFeedbackAction(value: unknown): value is "retry" | "skip" | "stop" | "drift" {
    return value === "retry" || value === "skip" || value === "stop" || value === "drift";
  }

  private hasPersistedStepFeedbackState(payload: Any): boolean {
    return Boolean(
      payload?.queues &&
      typeof payload.queues === "object" &&
      Object.prototype.hasOwnProperty.call(payload.queues, "stepFeedbackSignal"),
    );
  }

  restoreFromEvents(events: TaskEvent[]): void {
    const checkpointPayload = this.deps.loadCheckpointPayload();
    const latestSnapshot = this.getLatestSnapshotEvent(events);
    const latestSnapshotPayload = latestSnapshot?.event.payload || null;

    const checkpointFreshness = checkpointPayload
      ? this.getCheckpointRecoveryFreshness(checkpointPayload, events)
      : null;
    const snapshotFreshness = latestSnapshot?.freshness || null;
    // A checkpoint is a durable fallback, while the event stream is the
    // authoritative source when both represent the same or a newer state.
    // Prefer the snapshot on ties so an asynchronous checkpoint capture cannot
    // roll a restarted task back to an older conversation.
    const checkpointFirst =
      Boolean(checkpointPayload) &&
      (!latestSnapshot ||
        (checkpointFreshness &&
          snapshotFreshness &&
          this.compareRuntimeRecoveryFreshness(checkpointFreshness, snapshotFreshness) > 0));

    const v2Candidates: Array<{ payload: Any; sourceLabel: string }> = [];
    const orderedCandidates = checkpointFirst
      ? (["checkpoint", "snapshot"] as const)
      : (["snapshot", "checkpoint"] as const);
    for (const sourceLabel of orderedCandidates) {
      const payload = sourceLabel === "checkpoint" ? checkpointPayload : latestSnapshotPayload;
      if (payload?.schema === "session_runtime_v2" && payload?.version === 2) {
        v2Candidates.push({ payload, sourceLabel });
      }
    }
    for (const candidate of v2Candidates) {
      const restored = this.restoreConversationFromPayload(
        candidate.payload,
        candidate.sourceLabel,
      );
      if (restored.restored) {
        this.restorePendingSkillStateFromEvents(events);
        this.restoreTaskListStateFromEvents(events);
        this.restoreStepFeedbackStateFromEvents(
          events,
          this.hasPersistedStepFeedbackState(candidate.payload)
            ? candidate.sourceLabel === "checkpoint"
              ? checkpointFreshness
              : snapshotFreshness
            : null,
        );
        this.restoreQueuedAgentFollowUpsFromEvents(events);
        this.reconcileCompactionLifecycleFromEvents(
          events,
          restored.interruptedCompaction ? [restored.interruptedCompaction] : [],
        );
        return;
      }
    }

    const legacyCandidates: Array<{ payload: Any; sourceLabel: string }> = [];
    for (const sourceLabel of orderedCandidates) {
      const payload = sourceLabel === "checkpoint" ? checkpointPayload : latestSnapshotPayload;
      if (Array.isArray(payload?.conversationHistory)) {
        legacyCandidates.push({ payload, sourceLabel });
      }
    }
    for (const candidate of legacyCandidates) {
      const restored = this.restoreConversationFromPayload(
        candidate.payload,
        candidate.sourceLabel,
      );
      if (restored.restored) {
        this.restorePendingSkillStateFromEvents(events);
        if (this.state.usage.totalInputTokens === 0 && this.state.usage.totalOutputTokens === 0) {
          this.restoreUsageTotalsFromEvents(events);
        }
        this.restoreTaskListStateFromEvents(events);
        this.restoreStepFeedbackStateFromEvents(
          events,
          this.hasPersistedStepFeedbackState(candidate.payload)
            ? candidate.sourceLabel === "checkpoint"
              ? checkpointFreshness
              : snapshotFreshness
            : null,
        );
        this.restoreQueuedAgentFollowUpsFromEvents(events);
        this.reconcileCompactionLifecycleFromEvents(
          events,
          restored.interruptedCompaction ? [restored.interruptedCompaction] : [],
        );
        return;
      }
    }

    const conversationParts: string[] = [];
    const task = this.deps.getTask();
    conversationParts.push(`Original task: ${task.title}`);
    conversationParts.push(`Task details: ${task.prompt}`);
    conversationParts.push("");
    conversationParts.push("Previous conversation summary:");

    for (const event of events) {
      switch (this.deps.getReplayEventType(event)) {
        case "user_message":
          if (event.payload?.message) {
            conversationParts.push(`User: ${event.payload.message}`);
          }
          break;
        case "log":
          if (event.payload?.message) {
            if (event.payload.message.startsWith("User: ")) {
              conversationParts.push(`User: ${event.payload.message.slice(6)}`);
            } else {
              conversationParts.push(`System: ${event.payload.message}`);
            }
          }
          break;
        case "assistant_message":
          if (event.payload?.message) {
            const msg =
              event.payload.message.length > 500
                ? event.payload.message.slice(0, 500) + "..."
                : event.payload.message;
            conversationParts.push(`Assistant: ${msg}`);
          }
          break;
        case "tool_call":
          if (event.payload?.tool) {
            conversationParts.push(`[Used tool: ${event.payload.tool}]`);
          }
          break;
        case "tool_result":
          if (event.payload?.tool && event.payload?.result) {
            const result =
              typeof event.payload.result === "string"
                ? event.payload.result
                : JSON.stringify(event.payload.result);
            const truncated = result.length > 1000 ? result.slice(0, 1000) + "..." : result;
            conversationParts.push(`[Tool result from ${event.payload.tool}: ${truncated}]`);
          }
          break;
        case "plan_created":
          if (event.payload?.plan?.description) {
            conversationParts.push(`[Created plan: ${event.payload.plan.description}]`);
          }
          break;
        case "error":
          if (event.payload?.message || event.payload?.error) {
            conversationParts.push(`[Error: ${event.payload.message || event.payload.error}]`);
          }
          break;
      }
    }

    if (conversationParts.length > 4) {
      let lastEventAssistantMessage: string | null = null;
      for (const event of events) {
        if (this.deps.getReplayEventType(event) === "assistant_message" && event.payload?.message) {
          const msg = String(event.payload.message).trim();
          if (msg) lastEventAssistantMessage = msg;
        }
      }
      if (lastEventAssistantMessage) {
        this.state.transcript.lastAssistantOutput = lastEventAssistantMessage;
        this.state.transcript.lastNonVerificationOutput = lastEventAssistantMessage;
        this.state.transcript.lastAssistantText = lastEventAssistantMessage;
      }

      this.updateConversationHistory([
        {
          role: "user",
          content: conversationParts.join("\n"),
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I understand the context from our previous conversation. How can I help you now?",
            },
          ],
        },
      ]);
    }

    this.restorePendingSkillStateFromEvents(events);
    this.restoreTaskListStateFromEvents(events);
    this.restoreStepFeedbackStateFromEvents(events);
    this.restoreQueuedAgentFollowUpsFromEvents(events);
    this.reconcileCompactionLifecycleFromEvents(events);
  }

  /**
   * A lifecycle start is intentionally durable before provider work begins,
   * but a hard process crash can still occur before the terminal event or its
   * replacement snapshot is written. Reconcile the event stream on restart
   * so an orphaned spinner becomes an explicit, retryable interruption.
   */
  private reconcileCompactionLifecycleFromEvents(
    events: TaskEvent[],
    snapshotPending: Array<{
      compactionId: string;
      attemptId?: string;
      historyGenerationBefore: number;
      trigger: ContextCompactionTrigger;
      phase: ContextCompactionPhase;
    }> = [],
  ): void {
    const latestByCompactionId = new Map<
      string,
      {
        type: ContextCompactionEventType;
        payload: ContextCompactionEventPayload;
      }
    >();

    for (const event of events) {
      const type = this.deps.getReplayEventType(event);
      if (!isContextCompactionEventType(type)) continue;
      if (!isContextCompactionEventPayload(event.payload)) continue;
      latestByCompactionId.set(event.payload.compactionId, {
        type,
        payload: event.payload,
      });
    }

    const pendingByCompactionId = new Map<
      string,
      {
        compactionId: string;
        attemptId?: string;
        historyGenerationBefore: number;
        trigger: ContextCompactionTrigger;
        phase: ContextCompactionPhase;
      }
    >();
    for (const pending of snapshotPending) {
      pendingByCompactionId.set(pending.compactionId, pending);
    }
    for (const [compactionId, lifecycle] of latestByCompactionId) {
      if (lifecycle.type !== "context_compaction_started") continue;
      pendingByCompactionId.set(compactionId, {
        compactionId,
        ...(lifecycle.payload.attemptId ? { attemptId: lifecycle.payload.attemptId } : {}),
        historyGenerationBefore: lifecycle.payload.historyGenerationBefore,
        trigger: lifecycle.payload.trigger,
        phase: lifecycle.payload.phase,
      });
    }

    for (const [compactionId, pending] of pendingByCompactionId) {
      const latest = latestByCompactionId.get(compactionId);
      if (latest && latest.type !== "context_compaction_started") {
        this.lastCompactionId = compactionId;
        this.lastCompactionAttemptId = latest.payload.attemptId ?? pending.attemptId ?? null;
        this.lastCompactionStatus =
          latest.type === "context_compaction_completed" ? "completed" : "failed";
        this.lastCompactionTrigger = latest.payload.trigger;
        this.lastCompactionPhase = latest.payload.phase;
        this.lastCompactionInputGeneration = latest.payload.historyGenerationBefore;
        this.lastCompactionInstalledGeneration =
          latest.payload.historyGenerationAfter ?? this.historyGeneration;
        continue;
      }

      // A snapshot already records a terminal state for this unique ID. This
      // can happen when the terminal event itself was lost after the snapshot
      // crossed the durability boundary.
      if (
        this.lastCompactionId === compactionId &&
        (this.lastCompactionStatus === "completed" ||
          this.lastCompactionStatus === "failed" ||
          this.lastCompactionStatus === "interrupted")
      ) {
        if (!this.restartRecoveredCompactionIds.has(compactionId)) {
          this.restartRecoveredCompactionIds.add(compactionId);
          const trigger = this.lastCompactionTrigger ?? pending.trigger;
          const phase = this.lastCompactionPhase ?? pending.phase;
          if (this.lastCompactionStatus === "completed") {
            this.emitCompactionEvent("context_compaction_completed", {
              compactionId,
              ...(this.lastCompactionAttemptId || pending.attemptId
                ? { attemptId: this.lastCompactionAttemptId ?? pending.attemptId }
                : {}),
              status: "completed",
              trigger,
              phase,
              reason: "compaction_terminal_state_restored_from_snapshot",
              historyGenerationBefore: this.lastCompactionInputGeneration,
              historyGenerationAfter:
                this.lastCompactionInstalledGeneration || this.historyGeneration,
              restoredFromSnapshot: true,
              accountingSource: "estimate",
            });
          } else {
            this.emitCompactionEvent("context_compaction_failed", {
              compactionId,
              ...(this.lastCompactionAttemptId || pending.attemptId
                ? { attemptId: this.lastCompactionAttemptId ?? pending.attemptId }
                : {}),
              status: "failed",
              trigger,
              phase,
              reason:
                this.lastCompactionStatus === "interrupted"
                  ? "compaction_interrupted_by_restart"
                  : "compaction_failure_restored_from_snapshot",
              historyGenerationBefore: this.lastCompactionInputGeneration,
              historyGenerationAfter:
                this.lastCompactionInstalledGeneration || this.historyGeneration,
              retryable: this.lastCompactionStatus !== "failed",
              failureStage: "restart",
              restoredFromSnapshot: true,
              accountingSource: "estimate",
            });
          }
        }
        continue;
      }
      if (this.restartRecoveredCompactionIds.has(compactionId)) continue;

      this.restartRecoveredCompactionIds.add(compactionId);
      this.activeCompactionId = null;
      this.activeCompactionAttemptId = null;
      this.lastCompactionId = compactionId;
      this.lastCompactionAttemptId = pending.attemptId ?? null;
      this.lastCompactionTrigger = pending.trigger;
      this.lastCompactionPhase = pending.phase;
      this.lastCompactionInputGeneration = pending.historyGenerationBefore;
      this.lastCompactionInstalledGeneration = this.historyGeneration;
      this.lastCompactionStatus = "interrupted";
      this.emitCompactionEvent("context_compaction_failed", {
        compactionId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
        status: "failed",
        trigger: pending.trigger,
        phase: pending.phase,
        reason: "compaction_interrupted_by_restart",
        historyGenerationBefore: pending.historyGenerationBefore,
        historyGenerationAfter: this.historyGeneration,
        retryable: true,
        failureStage: "restart",
        interrupted: true,
        accountingSource: "estimate",
      });
      // Persist the terminal marker even if the event sink was unavailable so
      // a repeated restore cannot recreate the same in-flight operation.
      this.saveSnapshot();
    }
  }

  /**
   * Reconcile queue-only agent receipts with the last runtime snapshot.
   *
   * A receipt is written before the in-memory queue snapshot during enqueue,
   * and the queue item is removed before a recovery turn starts. Either order
   * can therefore leave a short crash window. The event is the durable source
   * for a queued message that is missing from the snapshot; a delivered
   * receipt suppresses any stale snapshot copy so an accepted message is not
   * dispatched twice after restart.
   */
  private restoreQueuedAgentFollowUpsFromEvents(events: TaskEvent[]): void {
    const latestReceipts = new Map<string, Record<string, unknown>>();
    const blockedMessageIds = new Set<string>();
    for (const event of events) {
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const eventType = this.deps.getReplayEventType(event);
      if (
        eventType === "error" &&
        payload.code === "QUEUED_ATTACHMENT_RECOVERY_BLOCKED" &&
        payload.recoveryBlocked === true &&
        typeof payload.messageId === "string" &&
        payload.messageId.trim()
      ) {
        blockedMessageIds.add(payload.messageId.trim());
        continue;
      }
      if (eventType !== "user_message") continue;
      const messageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
      if (!messageId || payload.deliveryMode !== "message") continue;
      latestReceipts.set(messageId, payload as Record<string, unknown>);
    }

    const deliveredMessageIds = new Set<string>();
    for (const [messageId, payload] of latestReceipts) {
      const status = payload.deliveryStatus ?? payload.status;
      if (status === "delivered") {
        deliveredMessageIds.add(messageId);
        this.markFollowUpMessageConsumed(messageId);
      }
    }

    const pending: TaskFollowUpInput[] = [];
    for (const originalFollowUp of this.state.queues.pendingFollowUps) {
      const messageId =
        originalFollowUp.deliveryMode === "message" &&
        typeof originalFollowUp.messageId === "string"
          ? originalFollowUp.messageId.trim()
          : "";
      if (messageId && (deliveredMessageIds.has(messageId) || blockedMessageIds.has(messageId))) {
        continue;
      }
      let followUp = originalFollowUp;
      if (
        messageId &&
        Array.isArray(originalFollowUp.images) &&
        originalFollowUp.images.length > 0
      ) {
        try {
          const recoveredImages = this.queuedAttachmentStore.hydrateStoredImages(
            this.deps.getTask().id,
            messageId,
            originalFollowUp.images,
          );
          if (recoveredImages) followUp = { ...originalFollowUp, images: recoveredImages };
        } catch (error) {
          this.blockQueuedAttachmentRecovery(messageId, error);
          continue;
        }
      }
      pending.push(followUp);
    }
    const pendingMessageIds = new Set(
      pending
        .filter(
          (followUp) =>
            followUp.deliveryMode === "message" && typeof followUp.messageId === "string",
        )
        .map((followUp) => followUp.messageId as string),
    );

    for (const [messageId, payload] of latestReceipts) {
      if (
        deliveredMessageIds.has(messageId) ||
        blockedMessageIds.has(messageId) ||
        pendingMessageIds.has(messageId)
      ) {
        continue;
      }
      if (typeof payload.message !== "string") continue;

      let recoveredImages: ImageAttachment[] | undefined;
      const hasLegacyAttachmentMetadata =
        Array.isArray(payload.images) && payload.images.length > 0;
      const hasQueuedAttachmentRefs = Object.prototype.hasOwnProperty.call(
        payload,
        "queuedAttachmentRefs",
      );
      if (hasQueuedAttachmentRefs) {
        try {
          if (
            !Array.isArray(payload.queuedAttachmentRefs) ||
            (payload.queuedAttachmentRefs.length === 0 && hasLegacyAttachmentMetadata)
          ) {
            throw new QueuedAttachmentRecoveryError(
              this.deps.getTask().id,
              messageId,
              "Queued attachment recovery blocked: attachment references are incomplete. Resend the message with its attachments.",
            );
          }
          recoveredImages = this.queuedAttachmentStore.hydrate(
            this.deps.getTask().id,
            messageId,
            payload.queuedAttachmentRefs as QueuedAttachmentRef[],
          );
        } catch (error) {
          this.blockQueuedAttachmentRecovery(messageId, error);
          continue;
        }
      } else if (hasLegacyAttachmentMetadata) {
        // Older receipts intentionally persisted only display metadata. Once
        // the runtime snapshot is gone those bytes cannot be reconstructed;
        // never silently execute the text-only prompt.
        this.blockQueuedAttachmentRecovery(
          messageId,
          new QueuedAttachmentRecoveryError(
            this.deps.getTask().id,
            messageId,
            "Queued attachment recovery blocked: this receipt has metadata but no durable attachment reference. Resend the message with its attachments.",
          ),
        );
        continue;
      }

      const interactionMode = payload.interactionMode;
      pending.push({
        message: payload.message,
        deliveryMode: "message",
        ...(recoveredImages ? { images: recoveredImages } : {}),
        messageSource:
          payload.messageSource === "agent" || payload.messageSource === "user"
            ? payload.messageSource
            : undefined,
        messageId,
        ...(typeof payload.senderTaskId === "string" ? { senderTaskId: payload.senderTaskId } : {}),
        ...(typeof payload.senderLabel === "string" ? { senderLabel: payload.senderLabel } : {}),
        ...(typeof payload.inReplyToMessageId === "string"
          ? { inReplyToMessageId: payload.inReplyToMessageId }
          : {}),
        ...(typeof payload.inReplyToTaskId === "string"
          ? { inReplyToTaskId: payload.inReplyToTaskId }
          : {}),
        ...(interactionMode && typeof interactionMode === "object"
          ? { interactionMode: interactionMode as TaskFollowUpInput["interactionMode"] }
          : {}),
        ...(Array.isArray(payload.integrationMentions)
          ? {
              integrationMentions:
                payload.integrationMentions as TaskFollowUpInput["integrationMentions"],
            }
          : {}),
        ...(payload.quotedAssistantMessage &&
        typeof payload.quotedAssistantMessage === "object" &&
        !Array.isArray(payload.quotedAssistantMessage)
          ? {
              quotedAssistantMessage:
                payload.quotedAssistantMessage as TaskFollowUpInput["quotedAssistantMessage"],
            }
          : {}),
      });
      pendingMessageIds.add(messageId);
    }

    this.state.queues.pendingFollowUps = pending;
  }

  private blockQueuedAttachmentRecovery(messageId: string, error: unknown): void {
    const reason =
      error instanceof QueuedAttachmentRecoveryError
        ? error.message
        : "Queued attachment recovery blocked: durable attachment validation failed. Resend the message with its attachments.";
    try {
      this.deps.updateTask({
        awaitingUserInputReasonCode: "queued_attachment_unavailable",
        error: reason,
      });
    } catch {
      // Recovery must still suppress the incomplete follow-up if task status
      // persistence is unavailable in a lightweight host.
    }
    try {
      this.deps.emitEvent("error", {
        code: "QUEUED_ATTACHMENT_RECOVERY_BLOCKED",
        messageId,
        recoveryBlocked: true,
        message: reason,
      });
    } catch {
      // The durable task update above is the primary block marker.
    }
  }

  private restoreConversationFromPayload(
    payload: Any,
    _sourceLabel: string,
  ): {
    restored: boolean;
    interruptedCompaction?: {
      compactionId: string;
      attemptId?: string;
      historyGenerationBefore: number;
      trigger: ContextCompactionTrigger;
      phase: ContextCompactionPhase;
    } | null;
  } {
    if (!payload?.conversationHistory || !Array.isArray(payload.conversationHistory)) {
      return { restored: false };
    }

    try {
      let interruptedCompaction: {
        compactionId: string;
        attemptId?: string;
        historyGenerationBefore: number;
        trigger: ContextCompactionTrigger;
        phase: ContextCompactionPhase;
      } | null = null;
      let restoredHistory: LLMMessage[] = payload.conversationHistory.map((msg: Any) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      }));
      restoredHistory = sanitizeToolCallHistory(restoredHistory);

      if (payload.trackerState) {
        this.state.files.fileOperationTracker.restore(payload.trackerState);
      }

      if (payload.planSummary && restoredHistory.length > 0) {
        const planContext = this.buildPlanContextSummary(payload.planSummary);
        if (planContext && restoredHistory[0].role === "user") {
          const firstMsg = restoredHistory[0];

          if (typeof firstMsg.content === "string") {
            if (!firstMsg.content.includes("PREVIOUS TASK CONTEXT")) {
              restoredHistory = [
                {
                  role: "user",
                  content: `${planContext}\n\n${firstMsg.content}`,
                },
                ...restoredHistory.slice(1),
              ];
            }
          } else if (Array.isArray(firstMsg.content)) {
            const existingText = firstMsg.content
              .filter((b: Any) => b.type === "text")
              .map((b: Any) => b.text)
              .join("\n");
            if (!existingText.includes("PREVIOUS TASK CONTEXT")) {
              restoredHistory = [
                {
                  role: "user",
                  content: [
                    { type: "text" as const, text: planContext },
                    ...(firstMsg.content as LLMContent[]),
                  ],
                },
                ...restoredHistory.slice(1),
              ];
            }
          }
        }
      }

      this.updateConversationHistory(restoredHistory);

      if (payload.usageTotals) {
        this.state.usage.usageOffsetInputTokens = 0;
        this.state.usage.usageOffsetOutputTokens = 0;
        this.state.usage.usageOffsetCost = 0;
        this.state.usage.totalInputTokens = payload.usageTotals.inputTokens || 0;
        this.state.usage.totalOutputTokens = payload.usageTotals.outputTokens || 0;
        this.state.usage.totalCost = payload.usageTotals.cost || 0;
      }

      if (payload.schema === "session_runtime_v2" && payload.version === 2) {
        interruptedCompaction = this.restoreFromV2Payload(payload as SessionRuntimeSnapshotV2);
      } else {
        this.state.transcript.explicitChatSummaryBlock =
          typeof payload.explicitChatSummaryBlock === "string" &&
          payload.explicitChatSummaryBlock.trim()
            ? payload.explicitChatSummaryBlock
            : null;
        this.state.transcript.explicitChatSummaryCreatedAt =
          typeof payload.explicitChatSummaryCreatedAt === "number"
            ? payload.explicitChatSummaryCreatedAt
            : 0;
        this.state.transcript.explicitChatSummarySourceMessageCount =
          typeof payload.explicitChatSummarySourceMessageCount === "number"
            ? payload.explicitChatSummarySourceMessageCount
            : 0;
        this.state.transcript.explicitChatSummaryInputSignature =
          typeof payload.explicitChatSummaryInputSignature === "string"
            ? payload.explicitChatSummaryInputSignature
            : "";
      }

      const lastAssistant = [...restoredHistory]
        .reverse()
        .find((message) => message.role === "assistant");
      const lastAssistantText = lastAssistant
        ? this.extractTextFromLLMContent(
            Array.isArray(lastAssistant.content)
              ? lastAssistant.content
              : [{ type: "text", text: String(lastAssistant.content || "") }],
          )
        : "";
      if (lastAssistantText.trim()) {
        this.state.transcript.lastAssistantOutput = lastAssistantText;
        this.state.transcript.lastNonVerificationOutput = lastAssistantText;
        this.state.transcript.lastAssistantText = lastAssistantText;
      }

      if (payload.schema !== "session_runtime_v2") {
        this.saveSnapshot(payload.planSummary);
      }
      return { restored: true, interruptedCompaction };
    } catch {
      return { restored: false };
    }
  }

  private restoreFromV2Payload(payload: SessionRuntimeSnapshotV2): {
    compactionId: string;
    attemptId?: string;
    historyGenerationBefore: number;
    trigger: ContextCompactionTrigger;
    phase: ContextCompactionPhase;
  } | null {
    let interruptedCompaction: {
      compactionId: string;
      attemptId?: string;
      historyGenerationBefore: number;
      trigger: ContextCompactionTrigger;
      phase: ContextCompactionPhase;
    } | null = null;
    if (payload.compaction && typeof payload.compaction === "object") {
      this.historyGeneration = Math.max(
        0,
        Number(payload.compaction.historyGeneration || this.historyGeneration),
      );
      // Provider calls cannot survive a process restart.  A snapshot that was
      // captured mid-compaction must therefore reopen the operation instead
      // of restoring an in-memory lock that can never be released.
      this.activeCompactionId = null;
      this.activeCompactionAttemptId = null;
      this.lastCompactionId =
        typeof payload.compaction.lastCompactionId === "string"
          ? payload.compaction.lastCompactionId
          : null;
      this.lastCompactionAttemptId =
        typeof payload.compaction.lastCompactionAttemptId === "string"
          ? payload.compaction.lastCompactionAttemptId
          : null;
      this.lastCompactionTrigger =
        payload.compaction.lastCompactionTrigger === "automatic" ||
        payload.compaction.lastCompactionTrigger === "manual" ||
        payload.compaction.lastCompactionTrigger === "continuation" ||
        payload.compaction.lastCompactionTrigger === "capacity_recovery"
          ? payload.compaction.lastCompactionTrigger
          : null;
      this.lastCompactionPhase =
        payload.compaction.lastCompactionPhase === "pre_turn" ||
        payload.compaction.lastCompactionPhase === "mid_turn" ||
        payload.compaction.lastCompactionPhase === "post_turn" ||
        payload.compaction.lastCompactionPhase === "manual"
          ? payload.compaction.lastCompactionPhase
          : null;
      const restoredStatus =
        payload.compaction.lastCompactionStatus === "started" ||
        payload.compaction.lastCompactionStatus === "completed" ||
        payload.compaction.lastCompactionStatus === "failed" ||
        payload.compaction.lastCompactionStatus === "interrupted"
          ? payload.compaction.lastCompactionStatus
          : null;
      this.lastCompactionStatus = restoredStatus;
      this.lastCompactionInputGeneration = Number(
        payload.compaction.lastCompactionInputGeneration || 0,
      );
      this.lastCompactionInstalledGeneration = Number(
        payload.compaction.lastCompactionInstalledGeneration || 0,
      );
      if (restoredStatus === "started") {
        if (this.lastCompactionId) {
          interruptedCompaction = {
            compactionId: this.lastCompactionId,
            ...(this.lastCompactionAttemptId ? { attemptId: this.lastCompactionAttemptId } : {}),
            historyGenerationBefore: this.lastCompactionInputGeneration,
            trigger: this.lastCompactionTrigger ?? "automatic",
            phase: this.lastCompactionPhase ?? "pre_turn",
          };
        }
      }
    }
    this.state.transcript.lastUserMessage = payload.transcript.lastUserMessage || "";
    this.state.transcript.lastAssistantOutput = payload.transcript.lastAssistantOutput;
    this.state.transcript.lastNonVerificationOutput = payload.transcript.lastNonVerificationOutput;
    this.state.transcript.lastAssistantText = payload.transcript.lastAssistantText;
    this.state.transcript.explicitChatSummaryBlock = payload.transcript.explicitChatSummaryBlock;
    this.state.transcript.explicitChatSummaryCreatedAt =
      payload.transcript.explicitChatSummaryCreatedAt;
    this.state.transcript.explicitChatSummarySourceMessageCount =
      payload.transcript.explicitChatSummarySourceMessageCount;
    this.state.transcript.explicitChatSummaryInputSignature =
      typeof payload.transcript.explicitChatSummaryInputSignature === "string"
        ? payload.transcript.explicitChatSummaryInputSignature
        : "";
    this.state.transcript.stepOutcomeSummaries = payload.transcript.stepOutcomeSummaries || [];

    this.state.tooling.toolResultMemory = payload.tooling.toolResultMemory || [];
    this.state.tooling.webEvidenceMemory = payload.tooling.webEvidenceMemory || [];
    this.state.tooling.toolUsageCounts = new Map(payload.tooling.toolUsageCounts || []);
    this.state.tooling.successfulToolUsageCounts = new Map(
      payload.tooling.successfulToolUsageCounts || [],
    );
    this.state.tooling.turnSuccessfulToolUsageCounts = new Map(
      payload.tooling.turnSuccessfulToolUsageCounts ??
        payload.tooling.successfulToolUsageCounts ??
        [],
    );
    this.state.tooling.toolUsageEventsSinceDecay = payload.tooling.toolUsageEventsSinceDecay || 0;
    this.state.tooling.toolSelectionEpoch = payload.tooling.toolSelectionEpoch || 0;
    this.state.tooling.discoveredDeferredToolNames = new Set(
      payload.tooling.discoveredDeferredToolNames || [],
    );
    this.state.files.filesReadTracker = new Map(payload.files.filesReadTracker || []);

    this.state.loop = { ...this.state.loop, ...payload.loop };
    this.state.recovery = {
      ...this.state.recovery,
      ...payload.recovery,
      recoveredFailureStepIds: new Set(payload.recovery.recoveredFailureStepIds || []),
    };
    this.state.queues.pendingFollowUps = payload.queues.pendingFollowUps || [];
    this.state.queues.consumedFollowUpMessageIds = new Set(
      payload.queues.consumedFollowUpMessageIds || [],
    );
    this.state.queues.stepFeedbackSignal = payload.queues.stepFeedbackSignal;
    this.state.skills.pendingParameterCollection = payload.skills?.pendingParameterCollection
      ? { ...payload.skills.pendingParameterCollection }
      : null;
    this.state.skills.primarySlashCommandHandled =
      payload.skills?.primarySlashCommandHandled === true;
    this.state.worker.dispatchedMentionedAgents = payload.worker.dispatchedMentionedAgents;
    this.state.worker.verificationAgentState = payload.worker.verificationAgentState || {};
    this.state.permissions.mode = payload.permissions?.mode || this.state.permissions.mode;
    this.state.permissions.sessionRules = Array.isArray(payload.permissions?.sessionRules)
      ? payload.permissions.sessionRules
      : [];
    this.state.permissions.temporaryGrants = new Map(payload.permissions?.temporaryGrants || []);
    this.state.permissions.denialTracking = new Map(payload.permissions?.denialTracking || []);
    this.state.permissions.latestPromptContext = payload.permissions?.latestPromptContext || null;
    this.state.permissions.recentSensitiveSources = Array.isArray(
      payload.permissions?.recentSensitiveSources,
    )
      ? payload.permissions.recentSensitiveSources
      : [];
    this.state.verification.verificationEvidenceEntries =
      payload.verification.verificationEvidenceEntries || [];
    this.state.verification.nonBlockingVerificationFailedStepIds = new Set(
      payload.verification.nonBlockingVerificationFailedStepIds || [],
    );
    this.state.verification.blockingVerificationFailedStepIds = new Set(
      payload.verification.blockingVerificationFailedStepIds || [],
    );
    this.state.promptCache.stableSystemBlocks = payload.promptCache?.stableSystemBlocks || [];
    this.state.promptCache.stablePrefixHash = payload.promptCache?.stablePrefixHash || "";
    this.state.promptCache.toolSchemaHash = payload.promptCache?.toolSchemaHash || "";
    this.state.promptCache.promptCacheMode = payload.promptCache?.promptCacheMode || "disabled";
    this.state.promptCache.promptCacheProviderFamily =
      payload.promptCache?.promptCacheProviderFamily || "unsupported";
    this.state.promptCache.promptCacheTtl = payload.promptCache?.promptCacheTtl;
    this.state.promptCache.promptCacheInvalidationReason =
      payload.promptCache?.promptCacheInvalidationReason || null;
    this.restoreTaskListState(this.getTaskListStateFromPayload(payload));
    return interruptedCompaction;
  }

  private restorePendingSkillStateFromEvents(events: TaskEvent[]): void {
    let pending: PendingSkillParameterCollection | null =
      this.state.skills.pendingParameterCollection;
    let handled = this.state.skills.primarySlashCommandHandled;
    for (const event of events) {
      const type = this.deps.getReplayEventType(event);
      if (type === "skill_parameter_collection_started") {
        pending =
          event.payload?.pending && typeof event.payload.pending === "object"
            ? ({ ...event.payload.pending } as PendingSkillParameterCollection)
            : pending;
        handled = true;
        continue;
      }
      if (type === "skill_parameter_answered") {
        pending =
          event.payload?.pending && typeof event.payload.pending === "object"
            ? ({ ...event.payload.pending } as PendingSkillParameterCollection)
            : pending;
        handled = true;
        continue;
      }
      if (type === "skill_parameter_collection_finished") {
        pending = null;
        handled = true;
      }
    }
    this.state.skills.pendingParameterCollection = pending;
    this.state.skills.primarySlashCommandHandled = handled;
  }

  private restoreUsageTotalsFromEvents(events: TaskEvent[]): void {
    const usageEvents = events.filter((e) => e.type === "llm_usage");
    if (usageEvents.length === 0) return;
    const latest = usageEvents[usageEvents.length - 1];
    const totals = latest.payload?.totals;
    if (totals) {
      this.state.usage.usageOffsetInputTokens = 0;
      this.state.usage.usageOffsetOutputTokens = 0;
      this.state.usage.usageOffsetCost = 0;
      this.state.usage.totalInputTokens = totals.inputTokens || 0;
      this.state.usage.totalOutputTokens = totals.outputTokens || 0;
      this.state.usage.totalCost = totals.cost || 0;
    }
  }

  private buildPlanContextSummary(planSummary: {
    description?: string;
    completedSteps?: string[];
    failedSteps?: { description: string; error?: string }[];
  }): string {
    const parts: string[] = ["PREVIOUS TASK CONTEXT:"];

    if (planSummary.description) {
      parts.push(`Task plan: ${planSummary.description}`);
    }

    if (planSummary.completedSteps && planSummary.completedSteps.length > 0) {
      parts.push(
        `Completed steps:\n${planSummary.completedSteps.map((s) => `  - ${s}`).join("\n")}`,
      );
    }

    if (planSummary.failedSteps && planSummary.failedSteps.length > 0) {
      parts.push(
        `Failed steps:\n${planSummary.failedSteps.map((s) => `  - ${s.description}${s.error ? ` (${s.error})` : ""}`).join("\n")}`,
      );
    }

    return parts.length > 1 ? parts.join("\n") : "";
  }

  projectTaskState(): SessionRuntimeTaskProjection {
    return {
      budgetUsage: this.deps.getBudgetUsage(),
      continuationCount: this.state.loop.continuationCount,
      continuationWindow: this.state.loop.continuationWindow,
      lifetimeTurnsUsed: this.state.loop.lifetimeTurnCount,
      compactionCount: this.state.loop.compactionCount,
      lastCompactionAt: this.state.loop.lastCompactionAt || undefined,
      lastCompactionTokensBefore: this.state.loop.lastCompactionTokensBefore || undefined,
      lastCompactionTokensAfter: this.state.loop.lastCompactionTokensAfter || undefined,
      noProgressStreak: this.state.loop.noProgressStreak,
      lastLoopFingerprint: this.state.loop.lastLoopFingerprint || undefined,
    };
  }

  getOutputState(): SessionRuntimeOutputState {
    return {
      conversationHistory: this.state.transcript.conversationHistory,
      lastUserMessage: this.state.transcript.lastUserMessage,
      lastAssistantOutput: this.state.transcript.lastAssistantOutput,
      lastNonVerificationOutput: this.state.transcript.lastNonVerificationOutput,
      lastAssistantText: this.state.transcript.lastAssistantText,
      explicitChatSummaryBlock: this.state.transcript.explicitChatSummaryBlock,
      explicitChatSummaryCreatedAt: this.state.transcript.explicitChatSummaryCreatedAt,
      explicitChatSummarySourceMessageCount:
        this.state.transcript.explicitChatSummarySourceMessageCount,
      explicitChatSummaryInputSignature:
        this.state.transcript.explicitChatSummaryInputSignature || "",
    };
  }

  getPermissionState(): SessionRuntimePermissionState {
    return {
      mode: this.state.permissions.mode,
      sessionRules: this.state.permissions.sessionRules,
      temporaryGrants: this.state.permissions.temporaryGrants,
      denialTracking: this.state.permissions.denialTracking,
      latestPromptContext: this.state.permissions.latestPromptContext,
      recentSensitiveSources: this.state.permissions.recentSensitiveSources,
    };
  }

  setPermissionMode(mode: PermissionMode): void {
    this.state.permissions.mode = mode;
  }

  addSessionPermissionRule(rule: PermissionRule): void {
    const normalized: PermissionRule = {
      ...rule,
      source: "session",
      createdAt: rule.createdAt || Date.now(),
    };
    const fingerprint = JSON.stringify({
      effect: normalized.effect,
      scope: normalized.scope,
    });
    if (
      !this.state.permissions.sessionRules.some(
        (existing) =>
          JSON.stringify({ effect: existing.effect, scope: existing.scope }) === fingerprint,
      )
    ) {
      this.state.permissions.sessionRules.push(normalized);
    }
  }

  setLatestPermissionPromptContext(details: PermissionPromptDetails | null): void {
    this.state.permissions.latestPromptContext = details;
  }

  getLatestPermissionPromptContext(): PermissionPromptDetails | null {
    return this.state.permissions.latestPromptContext;
  }

  clearLatestPermissionPromptContext(): void {
    this.state.permissions.latestPromptContext = null;
  }

  recordSensitiveSourceRead(source: SensitiveSourceRef): void {
    const normalizedPath = String(source?.path || "").trim();
    if (!normalizedPath) return;
    const next = {
      ...source,
      path: normalizedPath,
      recordedAt: typeof source.recordedAt === "number" ? source.recordedAt : Date.now(),
    };
    const deduped = this.state.permissions.recentSensitiveSources.filter(
      (item) => item.path !== next.path,
    );
    deduped.push(next);
    this.state.permissions.recentSensitiveSources = deduped.slice(-12);
  }

  listRecentSensitiveSources(): SensitiveSourceRef[] {
    return [...this.state.permissions.recentSensitiveSources];
  }

  addTemporaryPermissionGrant(key: string, opts?: { ttlMs?: number }): void {
    const grantedAt = Date.now();
    const expiresAt =
      typeof opts?.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
        ? grantedAt + opts.ttlMs
        : undefined;
    this.state.permissions.temporaryGrants.set(String(key || ""), {
      grantedAt,
      ...(typeof expiresAt === "number" ? { expiresAt } : {}),
    });
  }

  hasActiveTemporaryPermissionGrant(key: string): boolean {
    const grant = this.state.permissions.temporaryGrants.get(String(key || ""));
    if (!grant) return false;
    if (typeof grant.expiresAt === "number" && grant.expiresAt <= Date.now()) {
      this.state.permissions.temporaryGrants.delete(String(key || ""));
      return false;
    }
    return true;
  }

  clearTemporaryPermissionGrant(key: string): void {
    this.state.permissions.temporaryGrants.delete(String(key || ""));
  }

  getPermissionDenialState(fingerprint: string): SessionRuntimePermissionDenialState {
    return (
      this.state.permissions.denialTracking.get(String(fingerprint || "")) || {
        consecutiveDenials: 0,
        totalDenials: 0,
      }
    );
  }

  recordPermissionDenial(fingerprint: string): void {
    const key = String(fingerprint || "");
    const current = this.getPermissionDenialState(key);
    this.state.permissions.denialTracking.set(key, {
      consecutiveDenials: current.consecutiveDenials + 1,
      totalDenials: current.totalDenials + 1,
    });
  }

  recordPermissionSuccess(fingerprint: string): void {
    const key = String(fingerprint || "");
    const current = this.getPermissionDenialState(key);
    if (current.consecutiveDenials === 0 && current.totalDenials === 0) {
      return;
    }
    this.state.permissions.denialTracking.set(key, {
      consecutiveDenials: 0,
      totalDenials: current.totalDenials,
    });
  }

  getVerificationState(): SessionRuntimeVerificationState {
    return {
      verificationEvidenceEntries: this.state.verification.verificationEvidenceEntries,
      nonBlockingVerificationFailedStepIds:
        this.state.verification.nonBlockingVerificationFailedStepIds,
      blockingVerificationFailedStepIds: this.state.verification.blockingVerificationFailedStepIds,
      dispatchedMentionedAgents: this.state.worker.dispatchedMentionedAgents,
      verificationAgentState: this.state.worker.verificationAgentState,
    };
  }

  getRecoveryState(): SessionRuntimeRecoveryState {
    return {
      recoveryRequestActive: this.state.recovery.recoveryRequestActive,
      lastRecoveryFailureSignature: this.state.recovery.lastRecoveryFailureSignature,
      recoveredFailureStepIds: this.state.recovery.recoveredFailureStepIds,
      lastRecoveryClass: this.state.recovery.lastRecoveryClass,
      lastToolDisabledScope: this.state.recovery.lastToolDisabledScope,
      lastRetryReason: this.state.recovery.lastRetryReason,
    };
  }

  resetVerificationState(): void {
    this.state.worker.dispatchedMentionedAgents = false;
    this.state.worker.verificationAgentState = {};
    this.state.verification.verificationEvidenceEntries = [];
    this.state.verification.nonBlockingVerificationFailedStepIds.clear();
    this.state.verification.blockingVerificationFailedStepIds.clear();
  }

  hasDispatchedMentionedAgents(): boolean {
    return this.state.worker.dispatchedMentionedAgents;
  }

  markDispatchedMentionedAgents(): void {
    this.state.worker.dispatchedMentionedAgents = true;
  }

  setVerificationAgentState(state: Record<string, unknown>): void {
    this.state.worker.verificationAgentState = { ...state };
  }

  recordVerificationEvidence(entry: VerificationEvidenceEntry): void {
    this.state.verification.verificationEvidenceEntries.push(entry);
  }

  addNonBlockingVerificationFailedStep(stepId: string): void {
    this.state.verification.nonBlockingVerificationFailedStepIds.add(stepId);
    this.state.verification.blockingVerificationFailedStepIds.delete(stepId);
  }

  addBlockingVerificationFailedStep(stepId: string): void {
    this.state.verification.blockingVerificationFailedStepIds.add(stepId);
    this.state.verification.nonBlockingVerificationFailedStepIds.delete(stepId);
  }

  clearVerificationFailedStep(stepId: string): void {
    this.state.verification.nonBlockingVerificationFailedStepIds.delete(stepId);
    this.state.verification.blockingVerificationFailedStepIds.delete(stepId);
  }

  setRecoveryRequestActive(active: boolean): void {
    this.state.recovery.recoveryRequestActive = active === true;
  }

  setRecoveryFailureSignature(signature: string): void {
    this.state.recovery.lastRecoveryFailureSignature = String(signature || "");
  }

  clearRecoveryFailureSignature(): void {
    this.state.recovery.lastRecoveryFailureSignature = "";
  }

  markRecoveredFailureStep(stepId: string): void {
    this.state.recovery.recoveredFailureStepIds.add(stepId);
  }

  clearRecoveredFailureStep(stepId: string): void {
    this.state.recovery.recoveredFailureStepIds.delete(stepId);
  }

  setRecoveryClass(
    recoveryClass: "user_blocker" | "local_runtime" | "provider_quota" | "external_unknown" | null,
  ): void {
    this.state.recovery.lastRecoveryClass = recoveryClass;
  }

  setToolDisabledScope(scope: "provider" | "global" | null): void {
    this.state.recovery.lastToolDisabledScope = scope;
  }

  setRetryReason(reason: string | null): void {
    this.state.recovery.lastRetryReason = typeof reason === "string" ? reason : null;
  }

  resetRecoveryState(): void {
    this.state.recovery.recoveryRequestActive = false;
    this.state.recovery.lastRecoveryFailureSignature = "";
    this.state.recovery.recoveredFailureStepIds.clear();
    this.state.recovery.lastRecoveryClass = null;
    this.state.recovery.lastToolDisabledScope = null;
    this.state.recovery.lastRetryReason = null;
  }

  applyWorkspaceUpdate(workspace: Workspace, nextToolRegistry: ToolRegistry): void {
    this.deps.setWorkspace(workspace);
    this.deps.setToolRegistry(nextToolRegistry);
    this.setToolDisabledScope(null);
    this.state.loop.pendingLoopStrategySwitchMessage = "";
    this.state.loop.blockedLoopFingerprintForWindow = null;
    this.state.tooling.lastWebFetchFailure = null;
    this.invalidateToolAvailabilityCache();
  }
}
