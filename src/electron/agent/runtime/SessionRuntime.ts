import { randomUUID } from "crypto";
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
import { calculateCost } from "../llm/pricing";
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
  TurnKernel,
  type TurnKernelInput,
  type TurnKernelOutcome,
  type TurnKernelPolicy,
} from "./turn-kernel";
import type { ToolRegistry } from "../tools/registry";

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
    stepFeedbackSignal:
      | {
          stepId: string;
          action: "retry" | "skip" | "stop" | "drift";
          message?: string;
        }
      | null;
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
  };
  usageTotals: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
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
    toolUsageEventsSinceDecay: number;
    toolSelectionEpoch: number;
    discoveredDeferredToolNames: Set<string>;
    availableToolsCacheKey: string | null;
    availableToolsCache: Any[] | null;
    lastWebFetchFailure:
      | {
          timestamp: number;
          tool: "web_fetch" | "http_request";
          url?: string;
          error?: string;
          status?: number;
        }
      | null;
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
    stepFeedbackSignal:
      | {
          stepId: string;
          action: "retry" | "skip" | "stop" | "drift";
          message?: string;
        }
      | null;
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
  buildHybridMemoryRecallBlock: (workspaceId: string, query: string) => string;
  maybePreCompactionMemoryFlush: (opts: Any) => Promise<void>;
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
  callLLMWithRetry: (requestFn: (attempt: number) => Promise<Any>, operation: string) => Promise<Any>;
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

export class SessionRuntime {
  private deferredToolCatalog: DeferredToolCatalog | null = null;
  private toolSearchService: ToolSearchService | null = null;
  private taskListVerificationReminderPending = false;

  constructor(
    readonly deps: SessionRuntimeDeps,
    readonly state: SessionRuntimeState,
  ) {}

  createTaskList(items: SessionChecklistToolItemInput[]): SessionChecklistState {
    if (this.state.checklist.items.length > 0) {
      const existingBySignature = new Map(
        this.state.checklist.items.map((item) => [
          `${item.title.toLowerCase()}\u0000${item.kind}`,
          item.id,
        ] as const),
      );
      const mergedItems = (Array.isArray(items) ? items : []).map((item) => {
        const explicitId = String(item?.id || "").trim();
        if (explicitId) return item;
        const title = String(item?.title || "").trim().toLowerCase();
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
    if (!this.state.checklist.verificationNudgeNeeded && !this.taskListVerificationReminderPending) {
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
        maxEmptyResponses: input.maxEmptyResponses,
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
        maxEmptyResponses: input.maxEmptyResponses,
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

  private normalizeTaskListItems(
    items: SessionChecklistToolItemInput[],
  ): SessionChecklistItem[] {
    const rawItems = Array.isArray(items) ? items : [];
    if (rawItems.length === 0) {
      throw new Error("Session checklist must contain at least one item.");
    }

    const seenIds = new Set<string>();
    const existingById = new Map(this.state.checklist.items.map((item) => [item.id, item] as const));
    let inProgressCount = 0;
    const now = Date.now();

    return rawItems.map((rawItem, index) => {
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
    }).map((item, index, list) => {
      if (index === list.length - 1 && inProgressCount > 1) {
        throw new Error("Session checklist may contain at most one item with status in_progress.");
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

  private consumeTaskListVerificationReminder(): string | null {
    if (
      !this.state.checklist.verificationNudgeNeeded ||
      !this.taskListVerificationReminderPending
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
    );

    this.state.usage.totalInputTokens += safeInput;
    this.state.usage.totalOutputTokens += safeOutput;
    this.state.usage.totalCost += deltaCost;
    this.state.loop.iterationCount += 1;
    this.state.loop.globalTurnCount += 1;
    this.state.loop.lifetimeTurnCount += 1;

    if (this.state.loop.lifetimeTurnCount % 5 === 0) {
      this.deps.updateTask({ ...this.projectTaskState() });
    }

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
          cost: deltaCost,
        },
        totals: {
          inputTokens: cumulativeInput,
          outputTokens: cumulativeOutput,
          cost: cumulativeCost,
        },
      });
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

  updateConversationHistory(messages: LLMMessage[]): void {
    this.state.transcript.conversationHistory = this.deps.sanitizeConversationHistory(messages);
  }

  appendConversationHistory(message: LLMMessage): void {
    this.updateConversationHistory([...this.state.transcript.conversationHistory, message]);
  }

  queueFollowUp(
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
    integrationMentions?: TaskFollowUpInput["integrationMentions"],
  ): void {
    this.state.queues.pendingFollowUps.push({
      message,
      images,
      quotedAssistantMessage,
      ...(integrationMentions !== undefined ? { integrationMentions } : {}),
    });
  }

  get hasPendingFollowUps(): boolean {
    return this.state.queues.pendingFollowUps.length > 0;
  }

  setStepFeedback(
    stepId: string,
    action: "retry" | "skip" | "stop" | "drift",
    message?: string,
  ): void {
    this.state.queues.stepFeedbackSignal = { stepId, action, message };
    if (action === "drift" && message) {
      const prefix =
        stepId === "current" ? "[USER FEEDBACK]" : `[STEP FEEDBACK - Step "${stepId}"]`;
      this.state.queues.pendingFollowUps.unshift({
        message: `${prefix}: ${message}`,
      });
    }
  }

  consumeStepFeedback(currentStepId: string): SessionRuntimeState["queues"]["stepFeedbackSignal"] {
    if (!this.state.queues.stepFeedbackSignal) return null;
    if (this.state.queues.stepFeedbackSignal.stepId !== currentStepId) return null;
    const signal = this.state.queues.stepFeedbackSignal;
    this.state.queues.stepFeedbackSignal = null;
    return signal;
  }

  drainPendingFollowUp(): TaskFollowUpInput | undefined {
    return this.state.queues.pendingFollowUps.shift();
  }

  drainAllPendingFollowUps(): TaskFollowUpInput[] {
    const drained = [...this.state.queues.pendingFollowUps];
    this.state.queues.pendingFollowUps = [];
    return drained;
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
    };
  }

  private buildToolAvailabilityCacheKey(params: {
    baseKey: string;
    renderContext: LLMToolPromptRenderContext;
    taskTitle: string;
    taskPrompt: string;
    lastUserMessage: string;
    discoveredDeferredToolNames: string[];
  }): string {
    return JSON.stringify({
      baseKey: params.baseKey,
      renderContext: params.renderContext,
      taskTitle: params.taskTitle,
      taskPrompt: params.taskPrompt,
      lastUserMessage: params.lastUserMessage,
      discoveredDeferredToolNames: params.discoveredDeferredToolNames,
    });
  }

  getAvailableTools(): Any[] {
    const restrictedTools = this.deps.getTaskToolRestrictions();
    const hasAllowlist = this.deps.hasTaskToolAllowlistConfigured();
    const allowedTools = this.deps.getTaskToolAllowlist();
    const restrictedByTask = (name: string) => restrictedTools.has("*") || restrictedTools.has(name);
    const blockedByAllowlist = (name: string) =>
      hasAllowlist && !allowedTools.has("*") && !allowedTools.has(name);
    const disabledTools = this.state.tooling.toolFailureTracker.getDisabledTools();
    const cacheKey = JSON.stringify({
      toolCatalogVersion: this.deps.getToolRegistry().getToolCatalogVersion?.() || null,
      disabledTools,
      restrictedTools: [...restrictedTools].sort(),
      allowedTools: [...allowedTools].sort(),
      hasAllowlist,
      webSearchMode: this.deps.getWebSearchMode(),
      shellEnabled: this.deps.getWorkspace().permissions.shell,
    });
    const task = this.deps.getTask();
    const renderContext = this.buildToolPromptRenderContext();
    const renderedCacheKey = this.buildToolAvailabilityCacheKey({
      baseKey: cacheKey,
      renderContext,
      taskTitle: String(task.title || ""),
      taskPrompt: String(task.prompt || ""),
      lastUserMessage: String(this.state.transcript.lastUserMessage || ""),
      discoveredDeferredToolNames: Array.from(this.state.tooling.discoveredDeferredToolNames).sort(),
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
    const baseTools =
      typeof toolRegistry.getTools === "function" ? toolRegistry.getTools() : [];
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
          !entry.deferred || entry.tool.runtime?.alwaysExpose || deferredMatchNames.has(entry.tool.name),
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
        this.deps.getRetryTimeoutMs(baseTimeoutMs, attempt, hasTools ?? false, maxTokensBudget ?? 0),
      callLLMWithRetry: (requestFn, operation) =>
        this.deps.callLLMWithRetry(requestFn, operation),
      createMessageWithTimeout: (request, timeoutMs, operation) =>
        this.deps.createMessageWithTimeout(request, timeoutMs, operation),
      buildPromptCacheRequestExtras: this.deps.buildPromptCacheRequestExtras,
      updateTracking: (inputTokens, outputTokens, cachedTokens, cacheWriteTokens) =>
        this.updateTracking(inputTokens, outputTokens, cachedTokens, cacheWriteTokens),
      emitEvent: (type, payload) => this.deps.emitEvent(type, payload),
      log: (message) => this.deps.log(message),
    });
  }

  async prepareMessagesForTurnIteration(opts: {
    messages: LLMMessage[];
    phase: "step" | "follow_up";
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
        lastTurnMemoryRecallBlock = this.deps.buildHybridMemoryRecallBlock(
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

    const taskListReminder = this.consumeTaskListVerificationReminder();
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
    const contextManager = this.deps.getContextManager();
    const ctxUtil = contextManager.getContextUtilization(messages, opts.systemPromptTokens);
    if (ctxUtil.utilization >= 0.85) {
      const proactiveResult = contextManager.proactiveCompactWithMeta(
        messages,
        opts.systemPromptTokens,
        0.7,
      );
      messages = proactiveResult.messages;

      if (
        proactiveResult.meta.removedMessages.didRemove &&
        proactiveResult.meta.removedMessages.messages.length > 0
      ) {
        didProactiveCompact = true;
        const postCompactTokens = estimateTotalTokens(messages);
        const slack = Math.max(0, ctxUtil.availableTokens - postCompactTokens);
        const summaryBudget = Math.min(4000, Math.max(800, Math.floor(slack * 0.6)));

        let summaryBlock = await this.deps.buildCompactionSummaryBlock({
          removedMessages: proactiveResult.meta.removedMessages.messages,
          maxOutputTokens: summaryBudget,
          contextLabel: opts.contextLabel,
        });

        if (summaryBlock) {
          const summaryTokens = estimateTokens(summaryBlock);
          const postInsertTokens = estimateTotalTokens(messages) + summaryTokens;
          if (postInsertTokens > ctxUtil.availableTokens * 0.95) {
            const maxSummaryTokens = Math.max(
              200,
              ctxUtil.availableTokens - estimateTotalTokens(messages) - 2000,
            );
            summaryBlock = this.deps.truncateSummaryBlock(summaryBlock, maxSummaryTokens);
          }

          this.deps.upsertPinnedUserBlock(messages, {
            tag: "PINNED_COMPACTION_SUMMARY",
            content: summaryBlock,
          });
          await this.deps.flushCompactionSummaryToMemory({
            workspaceId: this.deps.getWorkspace().id,
            taskId: this.deps.getTask().id,
            allowMemoryInjection: opts.allowMemoryInjection,
            summaryBlock,
          });

          const summaryText = this.deps.extractPinnedBlockContent(
            summaryBlock,
            "PINNED_COMPACTION_SUMMARY",
            "PINNED_COMPACTION_SUMMARY_CLOSE",
          );
          this.deps.emitEvent("context_summarized", {
            summary: summaryText,
            removedCount: proactiveResult.meta.removedMessages.count,
            tokensBefore: proactiveResult.meta.originalTokens,
            tokensAfter: estimateTotalTokens(messages),
            proactive: true,
          });
        }
      }
    }

    if (!didProactiveCompact) {
      const compaction = contextManager.compactMessagesWithMeta(messages, opts.systemPromptTokens);
      messages = compaction.messages;

      if (
        compaction.meta.removedMessages.didRemove &&
        compaction.meta.removedMessages.messages.length > 0
      ) {
        const availableTokens = contextManager.getAvailableTokens(opts.systemPromptTokens);
        const tokensNow = estimateTotalTokens(messages);
        const slack = Math.max(0, availableTokens - tokensNow);
        const summaryBudget = Math.min(4000, Math.max(800, Math.floor(slack * 0.6)));

        let summaryBlock = await this.deps.buildCompactionSummaryBlock({
          removedMessages: compaction.meta.removedMessages.messages,
          maxOutputTokens: summaryBudget,
          contextLabel: opts.contextLabel,
        });

        if (summaryBlock) {
          const summaryTokens = estimateTokens(summaryBlock);
          const postInsertTokens = estimateTotalTokens(messages) + summaryTokens;
          if (postInsertTokens > availableTokens * 0.95) {
            const maxSummaryTokens = Math.max(
              200,
              availableTokens - estimateTotalTokens(messages) - 2000,
            );
            summaryBlock = this.deps.truncateSummaryBlock(summaryBlock, maxSummaryTokens);
          }

          this.deps.upsertPinnedUserBlock(messages, {
            tag: "PINNED_COMPACTION_SUMMARY",
            content: summaryBlock,
          });
          await this.deps.flushCompactionSummaryToMemory({
            workspaceId: this.deps.getWorkspace().id,
            taskId: this.deps.getTask().id,
            allowMemoryInjection: opts.allowMemoryInjection,
            summaryBlock,
          });

          const summaryText = this.deps.extractPinnedBlockContent(
            summaryBlock,
            "PINNED_COMPACTION_SUMMARY",
            "PINNED_COMPACTION_SUMMARY_CLOSE",
          );
          this.deps.emitEvent("context_summarized", {
            summary: summaryText,
            removedCount: compaction.meta.removedMessages.count,
            tokensBefore: compaction.meta.originalTokens,
            tokensAfter: compaction.meta.removedMessages.tokensAfter,
          });
        }
      }
    }

    this.deps.pruneStaleToolErrors(messages);
    this.deps.consolidateConsecutiveUserMessages(messages);

    return {
      messages,
      lastTurnMemoryRecallQuery,
      lastTurnMemoryRecallBlock,
      lastSharedContextKey,
      lastSharedContextBlock,
    };
  }

  recoverFromContextCapacityOverflow(opts: {
    error: unknown;
    messages: LLMMessage[];
    systemPromptTokens: number;
    phase: "step" | "follow_up";
    stepId?: string;
    attempt: number;
    maxAttempts: number;
  }): { recovered: boolean; exhausted: boolean; messages: LLMMessage[] } {
    if (!isContextCapacityError(opts.error)) {
      return { recovered: false, exhausted: false, messages: opts.messages };
    }

    const attemptNumber = opts.attempt + 1;
    const reason = String((opts.error as Any)?.message || opts.error || "context_capacity_error");
    const exhausted = attemptNumber > opts.maxAttempts;
    if (exhausted) {
      this.deps.emitEvent("context_capacity_recovery_failed", {
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
    this.deps.emitEvent("context_capacity_recovery_started", {
      phase: opts.phase,
      stepId: opts.stepId,
      attempt: attemptNumber,
      maxAttempts: opts.maxAttempts,
      providerError: reason,
      tokensBefore,
    });

    try {
      const proactive = this.deps.getContextManager().proactiveCompactWithMeta(
        opts.messages,
        opts.systemPromptTokens,
        0.35,
      );
      let compactedMessages = proactive.messages;
      if (!proactive.meta.removedMessages.didRemove) {
        const fallback = this.deps.getContextManager().compactMessagesWithMeta(
          compactedMessages,
          opts.systemPromptTokens,
        );
        compactedMessages = fallback.messages;
      }

      this.deps.pruneStaleToolErrors(compactedMessages);
      this.deps.consolidateConsecutiveUserMessages(compactedMessages);
      const tokensAfter = estimateTotalTokens(compactedMessages);
      this.deps.emitEvent("context_capacity_recovery_completed", {
        phase: opts.phase,
        stepId: opts.stepId,
        attempt: attemptNumber,
        maxAttempts: opts.maxAttempts,
        tokensBefore,
        tokensAfter,
        removedApproxTokens: Math.max(0, tokensBefore - tokensAfter),
      });
      this.deps.emitEvent("log", {
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
      this.deps.emitEvent("context_capacity_recovery_failed", {
        phase: opts.phase,
        stepId: opts.stepId,
        attempt: attemptNumber,
        maxAttempts: opts.maxAttempts,
        reason: compactionError?.message || String(compactionError),
      });
      return { recovered: false, exhausted: false, messages: opts.messages };
    }
  }

  async maybeCompactBeforeContinuation(assessment: Any): Promise<void> {
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
    this.deps.emitEvent("context_compaction_started", {
      continuationWindow: this.state.loop.continuationWindow,
      contextRatio,
      thresholdRatio: this.deps.getCompactionThresholdRatio(),
      toolUseStopStreak,
      noMutation,
      tokensBefore,
    });

    try {
      const compacted = this.deps
        .getContextManager()
        .compactMessagesWithMeta(this.state.transcript.conversationHistory, systemPromptTokens);
      this.updateConversationHistory(compacted.messages);
      const tokensAfter = estimateTotalTokens(this.state.transcript.conversationHistory);
      this.state.loop.compactionCount += 1;
      this.state.loop.lastCompactionAt = Date.now();
      this.state.loop.lastCompactionTokensBefore = tokensBefore;
      this.state.loop.lastCompactionTokensAfter = tokensAfter;
      this.deps.updateTask({
        ...this.projectTaskState(),
      });
      this.deps.emitEvent("context_compaction_completed", {
        continuationWindow: this.state.loop.continuationWindow,
        tokensBefore,
        tokensAfter,
        removedMessages: compacted.meta.removedMessages.count,
      });
    } catch (error: Any) {
      this.deps.emitEvent("context_compaction_failed", {
        continuationWindow: this.state.loop.continuationWindow,
        reason: error?.message || String(error),
        tokensBefore,
      });
    }
  }

  async maybeAutoContinueAfterTurnLimit(error: unknown): Promise<boolean> {
    if (!this.deps.isWindowTurnLimitExceededError(error)) return false;

    while (true) {
      const pendingSteps = this.deps.getPlan()?.steps?.filter((step) => step.status === "pending").length || 0;
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
      const lifetimeCapHit =
        this.state.loop.lifetimeTurnCount >= this.deps.getMaxLifetimeTurns();
      this.state.loop.noProgressStreak =
        assessment.progressScore <= 0 ? this.state.loop.noProgressStreak + 1 : 0;
      this.state.loop.lastLoopFingerprint =
        assessment.dominantFingerprint || this.state.loop.lastLoopFingerprint;
      const noProgressCircuitBreak =
        this.state.loop.noProgressStreak >= this.deps.getGlobalNoProgressCircuitBreaker();

      let blockReason = "";
      if (lifetimeCapHit) {
        blockReason =
          `Lifetime turn limit reached (${this.state.loop.lifetimeTurnCount}/${this.deps.getMaxLifetimeTurns()}).`;
      } else if (noPendingSteps) {
        blockReason = "No pending plan steps remain to continue.";
      } else if (noProgressCircuitBreak) {
        blockReason =
          `No-progress circuit breaker reached (${this.state.loop.noProgressStreak}/${this.deps.getGlobalNoProgressCircuitBreaker()}).`;
      } else if (reachedContinuationCap) {
        blockReason =
          `Auto continuation limit reached (${this.state.loop.continuationCount}/${this.deps.getMaxAutoContinuations()}).`;
      } else if (reachedLoopCritical) {
        this.state.loop.blockedLoopFingerprintForWindow = this.deps.getSignatureFromLoopFingerprint(
          assessment.dominantFingerprint,
        );
        blockReason =
          `Loop fingerprint repeated too often (${assessment.repeatedFingerprintCount}/${this.deps.getLoopCriticalThreshold()}).`;
      } else if (hasLoopRisk) {
        blockReason = `Loop risk is high (${assessment.loopRiskIndex.toFixed(2)}). Try changing strategy or constraints.`;
      } else if (belowProgressThreshold) {
        blockReason =
          `Recent progress score (${assessment.progressScore.toFixed(2)}) is below threshold (${threshold.toFixed(2)}).`;
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

  saveSnapshot(planSummary?: Any): void {
    try {
      if (this.state.transcript.conversationHistory.length === 0) {
        return;
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
          stepOutcomeSummaries: [...this.state.transcript.stepOutcomeSummaries],
        },
        tooling: {
          toolResultMemory: [...this.state.tooling.toolResultMemory],
          webEvidenceMemory: [...this.state.tooling.webEvidenceMemory],
          toolUsageCounts: Array.from(this.state.tooling.toolUsageCounts.entries()),
          successfulToolUsageCounts: Array.from(
            this.state.tooling.successfulToolUsageCounts.entries(),
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
      };
      const estimatedSize = JSON.stringify(payload).length;
      this.deps.emitEvent("conversation_snapshot", {
        ...payload,
        estimatedSizeBytes: estimatedSize,
      });
      this.deps.pruneOldSnapshots();
    } catch {
      // Best-effort snapshotting.
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

  restoreFromEvents(events: TaskEvent[]): void {
    const checkpointPayload = this.deps.loadCheckpointPayload();
    const snapshotEvents = events.filter((e) => this.deps.getReplayEventType(e) === "conversation_snapshot");
    const latestSnapshotPayload =
      snapshotEvents.length > 0 ? snapshotEvents[snapshotEvents.length - 1]?.payload : null;

    const v2Candidates: Array<{ payload: Any; sourceLabel: string }> = [];
    if (checkpointPayload?.schema === "session_runtime_v2" && checkpointPayload?.version === 2) {
      v2Candidates.push({ payload: checkpointPayload, sourceLabel: "checkpoint" });
    }
    if (
      latestSnapshotPayload?.schema === "session_runtime_v2" &&
      latestSnapshotPayload?.version === 2
    ) {
      v2Candidates.push({ payload: latestSnapshotPayload, sourceLabel: "snapshot" });
    }
    for (const candidate of v2Candidates) {
      if (this.restoreConversationFromPayload(candidate.payload, candidate.sourceLabel)) {
        this.restorePendingSkillStateFromEvents(events);
        this.restoreTaskListStateFromEvents(events);
        return;
      }
    }

    const legacyCandidates: Array<{ payload: Any; sourceLabel: string }> = [];
    if (Array.isArray(checkpointPayload?.conversationHistory)) {
      legacyCandidates.push({ payload: checkpointPayload, sourceLabel: "checkpoint" });
    }
    if (Array.isArray(latestSnapshotPayload?.conversationHistory)) {
      legacyCandidates.push({ payload: latestSnapshotPayload, sourceLabel: "snapshot" });
    }
    for (const candidate of legacyCandidates) {
      if (this.restoreConversationFromPayload(candidate.payload, candidate.sourceLabel)) {
        this.restorePendingSkillStateFromEvents(events);
        if (this.state.usage.totalInputTokens === 0 && this.state.usage.totalOutputTokens === 0) {
          this.restoreUsageTotalsFromEvents(events);
        }
        this.restoreTaskListStateFromEvents(events);
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
  }

  private restoreConversationFromPayload(payload: Any, _sourceLabel: string): boolean {
    if (!payload?.conversationHistory || !Array.isArray(payload.conversationHistory)) {
      return false;
    }

    try {
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
                  content: [{ type: "text" as const, text: planContext }, ...(firstMsg.content as LLMContent[])],
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
        this.restoreFromV2Payload(payload as SessionRuntimeSnapshotV2);
      } else {
        this.state.transcript.explicitChatSummaryBlock =
          typeof payload.explicitChatSummaryBlock === "string" && payload.explicitChatSummaryBlock.trim()
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
      return true;
    } catch {
      return false;
    }
  }

  private restoreFromV2Payload(payload: SessionRuntimeSnapshotV2): void {
    this.state.transcript.lastUserMessage = payload.transcript.lastUserMessage || "";
    this.state.transcript.lastAssistantOutput = payload.transcript.lastAssistantOutput;
    this.state.transcript.lastNonVerificationOutput =
      payload.transcript.lastNonVerificationOutput;
    this.state.transcript.lastAssistantText = payload.transcript.lastAssistantText;
    this.state.transcript.explicitChatSummaryBlock =
      payload.transcript.explicitChatSummaryBlock;
    this.state.transcript.explicitChatSummaryCreatedAt =
      payload.transcript.explicitChatSummaryCreatedAt;
    this.state.transcript.explicitChatSummarySourceMessageCount =
      payload.transcript.explicitChatSummarySourceMessageCount;
    this.state.transcript.stepOutcomeSummaries = payload.transcript.stepOutcomeSummaries || [];

    this.state.tooling.toolResultMemory = payload.tooling.toolResultMemory || [];
    this.state.tooling.webEvidenceMemory = payload.tooling.webEvidenceMemory || [];
    this.state.tooling.toolUsageCounts = new Map(payload.tooling.toolUsageCounts || []);
    this.state.tooling.successfulToolUsageCounts = new Map(
      payload.tooling.successfulToolUsageCounts || [],
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
    this.state.permissions.recentSensitiveSources = Array.isArray(payload.permissions?.recentSensitiveSources)
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
    this.state.promptCache.promptCacheInvalidationReason =
      payload.promptCache?.promptCacheInvalidationReason || null;
    this.restoreTaskListState(this.getTaskListStateFromPayload(payload));
  }

  private restorePendingSkillStateFromEvents(events: TaskEvent[]): void {
    let pending: PendingSkillParameterCollection | null = this.state.skills.pendingParameterCollection;
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
    const deduped = this.state.permissions.recentSensitiveSources.filter((item) => item.path !== next.path);
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
      nonBlockingVerificationFailedStepIds: this.state.verification.nonBlockingVerificationFailedStepIds,
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
    recoveryClass:
      | "user_blocker"
      | "local_runtime"
      | "provider_quota"
      | "external_unknown"
      | null,
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
