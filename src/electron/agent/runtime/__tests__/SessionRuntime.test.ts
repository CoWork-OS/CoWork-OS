import { mkdtempSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import type { LLMMessage } from "../../llm";
import { estimateTotalTokens } from "../../context-manager";
import { FileOperationTracker, ToolFailureTracker } from "../../executor-helpers";
import { DurableContextService } from "../../../memory/DurableContextService";
import {
  ContextCapacityExhaustedError,
  SessionRuntime,
  type SessionRuntimeDeps,
  type SessionRuntimeSnapshotV2,
  type SessionRuntimeState,
} from "../SessionRuntime";
import { QueuedAttachmentStore } from "../queued-attachment-store";

function createBaseState(): SessionRuntimeState {
  return {
    transcript: {
      conversationHistory: [],
      lastUserMessage: "Prompt",
      lastAssistantOutput: null,
      lastNonVerificationOutput: null,
      lastAssistantText: null,
      explicitChatSummaryBlock: null,
      explicitChatSummaryCreatedAt: 0,
      explicitChatSummarySourceMessageCount: 0,
      stepOutcomeSummaries: [],
    },
    tooling: {
      toolFailureTracker: new ToolFailureTracker(),
      toolResultMemory: [],
      webEvidenceMemory: [],
      toolUsageCounts: new Map(),
      successfulToolUsageCounts: new Map(),
      toolUsageEventsSinceDecay: 0,
      toolSelectionEpoch: 0,
      discoveredDeferredToolNames: new Set(),
      availableToolsCacheKey: null,
      availableToolsCache: null,
      lastWebFetchFailure: null,
    },
    files: {
      fileOperationTracker: new FileOperationTracker(),
      filesReadTracker: new Map(),
    },
    loop: {
      globalTurnCount: 0,
      lifetimeTurnCount: 0,
      continuationCount: 0,
      continuationWindow: 1,
      windowStartEventCount: 0,
      noProgressStreak: 0,
      lastLoopFingerprint: "",
      compactionCount: 0,
      lastCompactionAt: 0,
      lastCompactionTokensBefore: 0,
      lastCompactionTokensAfter: 0,
      blockedLoopFingerprintForWindow: null,
      pendingLoopStrategySwitchMessage: "",
      softDeadlineTriggered: false,
      wrapUpRequested: false,
      turnWindowSoftExhaustedNotified: false,
      followUpRecoveryAttemptsInCurrentMessage: 0,
      lastFollowUpRecoveryBlockReason: "",
      iterationCount: 0,
      currentStepId: null,
      lastPreCompactionFlushAt: 0,
      lastPreCompactionFlushTokenCount: 0,
    },
    recovery: {
      recoveryRequestActive: false,
      lastRecoveryFailureSignature: "",
      recoveredFailureStepIds: new Set(),
      lastRecoveryClass: null,
      lastToolDisabledScope: null,
      lastRetryReason: null,
    },
    queues: {
      pendingFollowUps: [],
      stepFeedbackSignal: null,
    },
    skills: {
      pendingParameterCollection: null,
      primarySlashCommandHandled: false,
    },
    worker: {
      dispatchedMentionedAgents: false,
      verificationAgentState: {},
    },
    permissions: {
      mode: "default",
      sessionRules: [],
      temporaryGrants: new Map(),
      denialTracking: new Map(),
      latestPromptContext: null,
      recentSensitiveSources: [],
    },
    verification: {
      verificationEvidenceEntries: [],
      nonBlockingVerificationFailedStepIds: new Set(),
      blockingVerificationFailedStepIds: new Set(),
    },
    checklist: {
      items: [],
      updatedAt: 0,
      verificationNudgeNeeded: false,
      nudgeReason: null,
    },
    promptCache: {
      stableSystemBlocks: [],
      stablePrefixHash: "",
      toolSchemaHash: "",
      promptCacheMode: "disabled",
      promptCacheProviderFamily: "unsupported",
      promptCacheInvalidationReason: null,
    },
    usage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      usageOffsetInputTokens: 0,
      usageOffsetOutputTokens: 0,
      usageOffsetCost: 0,
    },
  };
}

function createV2Snapshot(
  overrides: Partial<SessionRuntimeSnapshotV2> = {},
): SessionRuntimeSnapshotV2 {
  return {
    schema: "session_runtime_v2",
    version: 2,
    timestamp: Date.now(),
    messageCount: 1,
    modelId: "gpt-test",
    modelKey: "gpt-test",
    llmProfileUsed: "strong",
    resolvedModelKey: "gpt-test",
    conversationHistory: [{ role: "user", content: "v2 snapshot" }],
    trackerState: undefined,
    planSummary: undefined,
    transcript: {
      lastUserMessage: "v2 latest message",
      lastAssistantOutput: "assistant output",
      lastNonVerificationOutput: "assistant output",
      lastAssistantText: "assistant output",
      explicitChatSummaryBlock: null,
      explicitChatSummaryCreatedAt: 0,
      explicitChatSummarySourceMessageCount: 0,
      stepOutcomeSummaries: [],
    },
    tooling: {
      toolResultMemory: [],
      webEvidenceMemory: [],
      toolUsageCounts: [],
      successfulToolUsageCounts: [],
      toolUsageEventsSinceDecay: 0,
      toolSelectionEpoch: 0,
      discoveredDeferredToolNames: [],
    },
    files: {
      filesReadTracker: [],
    },
    loop: {
      globalTurnCount: 0,
      lifetimeTurnCount: 4,
      continuationCount: 1,
      continuationWindow: 2,
      windowStartEventCount: 0,
      noProgressStreak: 0,
      lastLoopFingerprint: "fp:v2",
      compactionCount: 0,
      lastCompactionAt: 0,
      lastCompactionTokensBefore: 0,
      lastCompactionTokensAfter: 0,
      blockedLoopFingerprintForWindow: null,
      pendingLoopStrategySwitchMessage: "",
      softDeadlineTriggered: false,
      wrapUpRequested: false,
      turnWindowSoftExhaustedNotified: false,
      followUpRecoveryAttemptsInCurrentMessage: 0,
      lastFollowUpRecoveryBlockReason: "",
      iterationCount: 0,
      currentStepId: null,
      lastPreCompactionFlushAt: 0,
      lastPreCompactionFlushTokenCount: 0,
    },
    recovery: {
      recoveryRequestActive: false,
      lastRecoveryFailureSignature: "",
      recoveredFailureStepIds: [],
      lastRecoveryClass: null,
      lastToolDisabledScope: null,
      lastRetryReason: null,
    },
    queues: {
      pendingFollowUps: [],
      stepFeedbackSignal: null,
    },
    skills: {
      pendingParameterCollection: null,
      primarySlashCommandHandled: false,
    },
    worker: {
      dispatchedMentionedAgents: false,
      verificationAgentState: {},
    },
    permissions: {
      mode: "default",
      sessionRules: [],
      temporaryGrants: [],
      denialTracking: [],
      latestPromptContext: null,
      recentSensitiveSources: [],
    },
    verification: {
      verificationEvidenceEntries: [],
      nonBlockingVerificationFailedStepIds: [],
      blockingVerificationFailedStepIds: [],
    },
    checklist: {
      items: [],
      updatedAt: 0,
      verificationNudgeNeeded: false,
      nudgeReason: null,
    },
    promptCache: {
      stableSystemBlocks: [],
      stablePrefixHash: "",
      toolSchemaHash: "",
      promptCacheMode: "disabled",
      promptCacheProviderFamily: "unsupported",
      promptCacheInvalidationReason: null,
    },
    usageTotals: {
      inputTokens: 11,
      outputTokens: 7,
      cost: 0.2,
    },
    ...overrides,
  };
}

function createHarness() {
  let workspace: Any = {
    id: "workspace-1",
    path: "/tmp/workspace",
    permissions: { shell: true },
  };
  let task: Any = {
    id: "task-1",
    title: "Task",
    prompt: "Prompt",
    agentConfig: {},
  };
  let checkpointPayload: Any = null;
  let toolCatalogVersion = "catalog:v1";
  let taskDomain = "general";
  let currentPlan: Any = {
    description: "Plan",
    steps: [{ id: "step-1", description: "Do work", status: "pending" }],
  };
  let toolRegistry: Any = {
    getTools: vi.fn(() => []),
    getDeferredTools: vi.fn(() => []),
    getToolCatalogVersion: vi.fn(() => toolCatalogVersion),
    cleanup: vi.fn(async () => undefined),
  };
  const emittedEvents: Array<{ type: string; payload: Any }> = [];
  const taskUpdates: Any[] = [];
  const createMessageWithTimeout = vi.fn();
  const executePlan = vi.fn(async () => undefined);
  const verifySuccessCriteria = vi.fn(async () => ({ success: true, message: "ok" }));
  const finalizeTaskWithFallback = vi.fn();
  const cleanupTools = vi.fn(async () => undefined);
  const assessContinuationWindow = vi.fn(() => ({
    progressScore: 0.7,
    loopRiskIndex: 0.2,
    repeatedFingerprintCount: 1,
    dominantFingerprint: "fp:progress",
  }));

  const deps: SessionRuntimeDeps = {
    getTask: () => task,
    getDefaultPermissionMode: () => "default",
    getWorkspace: () => workspace,
    setWorkspace: (nextWorkspace) => {
      workspace = nextWorkspace;
    },
    getToolRegistry: () => toolRegistry,
    setToolRegistry: (nextToolRegistry) => {
      toolRegistry = nextToolRegistry;
    },
    getContextManager: () =>
      ({
        getContextUtilization: () => ({ utilization: 0.2, availableTokens: 100000 }),
        proactiveCompactWithMeta: (messages: LLMMessage[]) => ({
          messages,
          meta: {
            originalTokens: 0,
            removedMessages: { didRemove: false, messages: [], count: 0, tokensAfter: 0 },
          },
        }),
        compactMessagesWithMeta: (messages: LLMMessage[]) => ({
          messages,
          meta: {
            originalTokens: 0,
            removedMessages: { didRemove: false, messages: [], count: 0, tokensAfter: 0 },
          },
        }),
        getAvailableTokens: () => 100000,
      }) as Any,
    getSystemPrompt: () => "system",
    getModelMetadata: () => ({
      providerType: "anthropic",
      modelId: "gpt-test",
      modelKey: "gpt-test",
      llmProfileUsed: "strong" as const,
      resolvedModelKey: "gpt-test",
    }),
    getWebSearchMode: () => "live",
    getTaskToolRestrictions: () => new Set<string>(),
    hasTaskToolAllowlistConfigured: () => false,
    getTaskToolAllowlist: () => new Set<string>(),
    isVisualCanvasTask: () => false,
    isCanvasTool: () => false,
    getToolPolicyContext: () => ({}),
    applyWebSearchModeFilter: (tools) => tools,
    applyAgentPolicyToolFilter: (tools) => tools,
    applyAdaptiveToolAvailabilityFilter: (tools) => tools,
    applyStepScopedToolPolicy: (tools) => tools,
    applyIntentFilter: (tools) => tools,
    sanitizeConversationHistory: (messages) => messages,
    pruneStaleToolErrors: () => {},
    consolidateConsecutiveUserMessages: () => {},
    maybeInjectTurnBudgetSoftLanding: () => {},
    checkBudgets: () => {},
    buildUserProfileBlock: () => "",
    upsertPinnedUserBlock: () => {},
    removePinnedUserBlock: () => {},
    computeSharedContextKey: () => "shared:1",
    buildSharedContextBlock: () => "",
    buildHybridMemoryRecallBlock: () => "",
    maybePreCompactionMemoryFlush: async () => {},
    buildCompactionSummaryBlock: async () => "",
    truncateSummaryBlock: (summary) => summary,
    flushCompactionSummaryToMemory: async () => {},
    extractPinnedBlockContent: (summary) => summary,
    emitEvent: (type, payload) => {
      emittedEvents.push({ type, payload });
    },
    resolveLLMMaxTokens: () => 1024,
    applyRetryTokenCap: (baseMaxTokens) => baseMaxTokens,
    getRetryTimeoutMs: (baseTimeoutMs) => baseTimeoutMs,
    callLLMWithRetry: async (requestFn) => requestFn(0),
    createMessageWithTimeout,
    log: () => {},
    getTaskEvents: () => [],
    getReplayEventType: (event) => event.type,
    loadCheckpointPayload: () => checkpointPayload,
    pruneOldSnapshots: () => {},
    getPlanSummary: () => undefined,
    getBudgetUsage: () => ({
      turns: 0,
      lifetimeTurns: 0,
      toolCalls: 0,
      webSearchCalls: 0,
      duplicatesBlocked: 0,
    }),
    updateTask: (updates) => {
      taskUpdates.push(updates);
    },
    updateTaskStatus: () => {},
    executePlan,
    verifySuccessCriteria,
    finalizeTaskWithFallback,
    buildResultSummary: () => "done",
    emitTerminalFailureOnce: () => {},
    cleanupTools,
    getEffectiveTurnBudgetPolicy: () => "adaptive_unbounded",
    getEmergencyFuseMaxTurns: () => 120,
    isWindowTurnLimitExceededError: (error) =>
      /turn limit exceeded/i.test(String((error as Any)?.message || error || "")),
    assessContinuationWindow,
    getLoopWarningThreshold: () => 2,
    getLoopCriticalThreshold: () => 4,
    getMinProgressScoreForAutoContinue: () => 0.25,
    getContinuationStrategy: () => "adaptive_progress",
    getMaxAutoContinuations: () => 3,
    getMaxLifetimeTurns: () => 100,
    getGlobalNoProgressCircuitBreaker: () => 3,
    getWindowEventsSinceLastReset: () => [],
    getRenderedContextRatio: () => 0.1,
    hasWindowMutationEvidence: () => false,
    getWindowToolUseStopStreak: () => 0,
    getSignatureFromLoopFingerprint: (fingerprint) => fingerprint ?? null,
    shouldCompactOnContinuation: () => false,
    getCompactionThresholdRatio: () => 0.8,
    getPlan: () => currentPlan,
    getEffectiveExecutionMode: () => task.agentConfig?.executionMode ?? "execute",
    getEffectiveTaskDomain: () => taskDomain as Any,
    setTerminalStatus: () => {},
    setFailureClass: () => {},
    isCancelled: () => false,
    getCancelReason: () => null,
    isWaitingForUserInput: () => false,
    getRecoveredFailureStepIds: () => new Set<string>(),
  };

  const runtime = new SessionRuntime(deps, createBaseState());
  return {
    runtime,
    deps,
    emittedEvents,
    taskUpdates,
    createMessageWithTimeout,
    executePlan,
    verifySuccessCriteria,
    finalizeTaskWithFallback,
    cleanupTools,
    assessContinuationWindow,
    setCheckpointPayload: (payload: Any) => {
      checkpointPayload = payload;
    },
    setToolCatalogVersion: (nextVersion: string) => {
      toolCatalogVersion = nextVersion;
    },
    setToolRegistry: (nextToolRegistry: Any) => {
      toolRegistry = nextToolRegistry;
    },
    setWorkspace: (nextWorkspace: Any) => {
      workspace = nextWorkspace;
    },
    setPlan: (nextPlan: Any) => {
      currentPlan = nextPlan;
    },
    setExecutionMode: (mode: string | undefined) => {
      task = {
        ...task,
        agentConfig: {
          ...task.agentConfig,
          ...(mode ? { executionMode: mode } : {}),
        },
      };
      if (!mode) {
        delete task.agentConfig.executionMode;
      }
    },
    setInteractionMode: (selection: Any) => {
      task.agentConfig.interactionMode = selection;
    },
    setTaskDomain: (nextDomain: string) => {
      taskDomain = nextDomain;
    },
  };
}

describe("SessionRuntime", () => {
  it("uses Jev to change strategy at a soft low-progress boundary", async () => {
    const harness = createHarness();
    harness.assessContinuationWindow.mockReturnValue({
      progressScore: 0.1,
      loopRiskIndex: 0.2,
      repeatedFingerprintCount: 1,
      dominantFingerprint: "fp:stuck",
    });
    const evaluateJevLoopDecision = vi.fn(async () => ({
      status: "selected" as const,
      action: "change_strategy" as const,
      model: "jev-test",
      reason: "change_strategy",
      confidence: 0.9,
      probability: 0.9,
    }));
    harness.deps.evaluateJevLoopDecision = evaluateJevLoopDecision;

    await expect(
      harness.runtime.maybeAutoContinueAfterTurnLimit(new Error("turn limit exceeded")),
    ).resolves.toBe(true);

    expect(evaluateJevLoopDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        progressScore: 0.1,
        hardStopReason: undefined,
      }),
    );
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "jev_loop_decision",
        payload: expect.objectContaining({
          action: "change_strategy",
          confidence: 0.9,
          probability: 0.9,
        }),
      }),
    );
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "continuation_decision",
        payload: expect.objectContaining({ allowed: true, jevLoopAction: "change_strategy" }),
      }),
    );
  });

  it("does not ask Jev to override a hard lifetime cap", async () => {
    const harness = createHarness();
    harness.runtime.state.loop.lifetimeTurnCount = 100;
    const evaluateJevLoopDecision = vi.fn();
    harness.deps.evaluateJevLoopDecision = evaluateJevLoopDecision;

    await expect(
      harness.runtime.maybeAutoContinueAfterTurnLimit(new Error("turn limit exceeded")),
    ).resolves.toBe(false);

    expect(evaluateJevLoopDecision).not.toHaveBeenCalled();
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({ type: "safety_stop_triggered" }),
    );
  });

  it("counts usage-free turns toward all budgets without inventing token telemetry", () => {
    const { runtime } = createHarness();
    const initialUsage = { ...runtime.state.usage };
    runtime.recordLlmTurn();
    runtime.recordLlmTurn();
    expect(runtime.state.loop).toMatchObject({
      iterationCount: 2,
      globalTurnCount: 2,
      lifetimeTurnCount: 2,
    });
    expect(runtime.state.usage).toEqual(initialUsage);
    runtime.updateTracking(3, 2);
    expect(runtime.state.loop).toMatchObject({
      iterationCount: 3,
      globalTurnCount: 3,
      lifetimeTurnCount: 3,
    });
  });

  it.each([
    { mode: "smart" },
    { mode: "chat" },
    { mode: "smart", executionOverride: "plan" },
  ] as const)("injects steering with the same selection %j", (selection) => {
    const harness = createHarness();
    harness.setInteractionMode(selection);
    harness.runtime.queueFollowUp(
      "Use the other file",
      undefined,
      undefined,
      undefined,
      undefined,
      selection,
    );
    expect(harness.runtime.drainPendingFollowUp()?.message).toBe("Use the other file");
  });
  it("holds an advanced override change and preserves FIFO behind it", () => {
    const harness = createHarness();
    harness.setInteractionMode({ mode: "smart" });
    harness.runtime.queueFollowUp("Plan first", undefined, undefined, undefined, undefined, {
      mode: "smart",
      executionOverride: "plan",
    });
    harness.runtime.queueFollowUp("Then continue", undefined, undefined, undefined, undefined, {
      mode: "smart",
    });
    expect(harness.runtime.drainPendingFollowUp()).toBeUndefined();
    expect(harness.runtime.takeNextFollowUpAtTurnBoundary()?.message).toBe("Plan first");
    expect(harness.runtime.takeNextFollowUpAtTurnBoundary()?.message).toBe("Then continue");
  });
  it("holds mode-bearing messages for a turn boundary and restores their selections", () => {
    const harness = createHarness();
    harness.runtime.queueFollowUp("Discuss", undefined, undefined, undefined, undefined, {
      mode: "chat",
    });
    harness.runtime.queueFollowUp("Implement", undefined, undefined, undefined, undefined, {
      mode: "smart",
    });
    expect(harness.runtime.drainPendingFollowUp()).toBeUndefined();
    const snapshot = harness.emittedEvents
      .filter((event) => event.type === "conversation_snapshot")
      .at(-1);
    expect(snapshot).toBeDefined();
    const restored = createHarness();
    restored.runtime.restoreFromEvents([
      { type: "conversation_snapshot", payload: snapshot!.payload } as Any,
    ]);
    expect(restored.runtime.takeNextFollowUpAtTurnBoundary()).toMatchObject({
      message: "Discuss",
      interactionMode: { mode: "chat" },
    });
    expect(restored.runtime.takeNextFollowUpAtTurnBoundary()).toMatchObject({
      message: "Implement",
      interactionMode: { mode: "smart" },
    });
  });

  it("continues to inject legacy steering before a mode boundary", () => {
    const harness = createHarness();
    harness.runtime.queueFollowUp("Use the other file");
    harness.runtime.queueFollowUp("Discuss", undefined, undefined, undefined, undefined, {
      mode: "chat",
    });
    expect(harness.runtime.drainPendingFollowUp()?.message).toBe("Use the other file");
    expect(harness.runtime.drainPendingFollowUp()).toBeUndefined();
  });
  it("persists agent message provenance in the follow-up queue", () => {
    const harness = createHarness();
    harness.runtime.queueFollowUp(
      "Prioritize the migration",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "agent",
      "message-1",
      "parent-task",
      "Backend",
      "message",
    );

    expect(harness.runtime.drainPendingFollowUp()).toMatchObject({
      message: "Prioritize the migration",
      messageSource: "agent",
      messageId: "message-1",
      senderTaskId: "parent-task",
      senderLabel: "Backend",
      deliveryMode: "message",
    });
  });

  it("persists reply correlation in the follow-up queue", () => {
    const harness = createHarness();
    harness.runtime.queueFollowUp(
      "The launch communities are ready.",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "agent",
      "reply-1",
      "forge-task",
      "Forge",
      "message",
      "handoff-1",
      "atlas-task",
    );

    expect(harness.runtime.drainPendingFollowUp()).toMatchObject({
      message: "The launch communities are ready.",
      inReplyToMessageId: "handoff-1",
      inReplyToTaskId: "atlas-task",
    });
  });

  it("reports snapshot persistence failure to an acceptance caller", () => {
    const harness = createHarness();
    harness.runtime.appendConversationHistory({ role: "user", content: "Queued input" });
    (harness.runtime as Any).deps.emitEvent = () => {
      throw new Error("database unavailable");
    };
    expect(harness.runtime.saveSnapshot()).toBe(false);
  });

  it("keeps snapshot acceptance successful when later pruning fails", () => {
    const harness = createHarness();
    harness.runtime.appendConversationHistory({ role: "user", content: "Queued input" });
    (harness.runtime as Any).deps.pruneOldSnapshots = () => {
      throw new Error("cleanup unavailable");
    };
    expect(harness.runtime.saveSnapshot()).toBe(true);
    expect(harness.emittedEvents.some((event) => event.type === "conversation_snapshot")).toBe(
      true,
    );
  });

  it("restores an unconsumed receipt that was not yet added to a runtime snapshot", () => {
    const harness = createHarness();
    harness.runtime.restoreFromEvents([
      {
        id: "queued-receipt",
        taskId: "task-1",
        timestamp: 1,
        type: "user_message",
        payload: {
          message: "Inspect the report",
          messageId: "receipt-only",
          deliveryMode: "message",
          deliveryStatus: "queued",
          messageSource: "agent",
          senderTaskId: "parent",
          senderLabel: "Reviewer",
          integrationMentions: ["connector-a"],
          interactionMode: { mode: "chat" },
        },
      } as Any,
    ]);
    expect(harness.runtime.takeNextFollowUpAtTurnBoundary()).toMatchObject({
      message: "Inspect the report",
      messageId: "receipt-only",
      deliveryMode: "message",
      senderTaskId: "parent",
      senderLabel: "Reviewer",
      integrationMentions: ["connector-a"],
      interactionMode: { mode: "chat" },
    });
  });

  it("hydrates receipt-only queued attachments after the runtime snapshot is lost", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-runtime-attachments-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const persisted = store.persist("task-1", "receipt-image", [
        { data: "aGVsbG8=", mimeType: "image/png", filename: "hello.png", sizeBytes: 5 },
      ]);
      const harness = createHarness();
      (harness.runtime as Any).queuedAttachmentStore = store;

      harness.runtime.restoreFromEvents([
        {
          id: "queued-image-receipt",
          taskId: "task-1",
          timestamp: 1,
          type: "user_message",
          payload: {
            message: "Inspect the image",
            messageId: "receipt-image",
            deliveryMode: "message",
            deliveryStatus: "queued",
            queuedAttachmentRefs: persisted.refs,
          },
        } as Any,
      ]);

      expect(harness.runtime.takeNextFollowUpAtTurnBoundary()).toMatchObject({
        message: "Inspect the image",
        images: [
          expect.objectContaining({
            filePath: persisted.images[0].filePath,
            mimeType: "image/png",
            sizeBytes: 5,
          }),
        ],
      });
      expect(JSON.stringify(harness.runtime.state.queues.pendingFollowUps)).not.toContain(
        "aGVsbG8=",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks a receipt-only replay when its durable attachment is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-runtime-attachments-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const persisted = store.persist("task-1", "missing-image", [
        { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
      ]);
      unlinkSync(persisted.images[0].filePath!);
      const harness = createHarness();
      (harness.runtime as Any).queuedAttachmentStore = store;

      harness.runtime.restoreFromEvents([
        {
          id: "missing-image-receipt",
          taskId: "task-1",
          timestamp: 1,
          type: "user_message",
          payload: {
            message: "Inspect the missing image",
            messageId: "missing-image",
            deliveryMode: "message",
            deliveryStatus: "queued",
            queuedAttachmentRefs: persisted.refs,
          },
        } as Any,
      ]);

      expect(harness.runtime.state.queues.pendingFollowUps).toEqual([]);
      expect(harness.taskUpdates).toContainEqual(
        expect.objectContaining({
          awaitingUserInputReasonCode: "queued_attachment_unavailable",
        }),
      );
      expect(harness.emittedEvents).toContainEqual(
        expect.objectContaining({
          type: "error",
          payload: expect.objectContaining({
            code: "QUEUED_ATTACHMENT_RECOVERY_BLOCKED",
            messageId: "missing-image",
            recoveryBlocked: true,
          }),
        }),
      );

      const blockedEvent = harness.emittedEvents.find(
        (event) => event.type === "error" && event.payload.messageId === "missing-image",
      );
      const retried = createHarness();
      (retried.runtime as Any).queuedAttachmentStore = store;
      retried.runtime.restoreFromEvents([
        {
          id: "missing-image-receipt",
          taskId: "task-1",
          timestamp: 1,
          type: "user_message",
          payload: {
            message: "Inspect the missing image",
            messageId: "missing-image",
            deliveryMode: "message",
            deliveryStatus: "queued",
            queuedAttachmentRefs: persisted.refs,
          },
        },
        {
          id: "missing-image-block",
          taskId: "task-1",
          timestamp: 2,
          type: "error",
          payload: blockedEvent!.payload,
        },
      ] as Any);
      expect(retried.runtime.state.queues.pendingFollowUps).toEqual([]);
      expect(retried.taskUpdates).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates store-backed snapshot queue items before overlaying receipts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-runtime-attachments-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const persisted = store.persist("task-1", "snapshot-image", [
        { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
      ]);
      const source = createHarness();
      source.runtime.state.queues.pendingFollowUps.push({
        message: "Inspect the snapshot image",
        messageId: "snapshot-image",
        deliveryMode: "message",
        images: persisted.images,
      });
      source.runtime.appendConversationHistory({ role: "user", content: "Earlier context" });
      expect(source.runtime.saveSnapshot()).toBe(true);
      const snapshot = source.emittedEvents
        .filter((event) => event.type === "conversation_snapshot")
        .at(-1)!.payload;
      unlinkSync(persisted.images[0].filePath!);

      const restored = createHarness();
      (restored.runtime as Any).queuedAttachmentStore = store;
      restored.runtime.restoreFromEvents([
        {
          id: "snapshot-image-receipt",
          taskId: "task-1",
          timestamp: 1,
          type: "user_message",
          payload: {
            message: "Inspect the snapshot image",
            messageId: "snapshot-image",
            deliveryMode: "message",
            deliveryStatus: "queued",
            queuedAttachmentRefs: persisted.refs,
          },
        },
        {
          id: "snapshot-image-state",
          taskId: "task-1",
          timestamp: 2,
          type: "conversation_snapshot",
          payload: JSON.parse(JSON.stringify(snapshot)),
        },
      ] as Any);

      expect(restored.runtime.state.queues.pendingFollowUps).toEqual([]);
      expect(restored.emittedEvents).toContainEqual(
        expect.objectContaining({
          type: "error",
          payload: expect.objectContaining({
            code: "QUEUED_ATTACHMENT_RECOVERY_BLOCKED",
            messageId: "snapshot-image",
          }),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks legacy metadata-only receipts instead of silently dropping image bytes", () => {
    const harness = createHarness();
    harness.runtime.restoreFromEvents([
      {
        id: "legacy-image-receipt",
        taskId: "task-1",
        timestamp: 1,
        type: "user_message",
        payload: {
          message: "Inspect the old image",
          messageId: "legacy-image",
          deliveryMode: "message",
          deliveryStatus: "queued",
          images: [{ mimeType: "image/png", filename: "old.png", sizeBytes: 5 }],
        },
      } as Any,
    ]);

    expect(harness.runtime.state.queues.pendingFollowUps).toEqual([]);
    expect(harness.taskUpdates).toContainEqual(
      expect.objectContaining({ awaitingUserInputReasonCode: "queued_attachment_unavailable" }),
    );
  });

  it("restores the consumed marker and transcript when receipt update fails after the snapshot", () => {
    const harness = createHarness();
    const message: Any = {
      message: "Inspect the report",
      messageId: "consumed-message",
      deliveryMode: "message",
      messageSource: "agent",
    };
    harness.runtime.state.queues.pendingFollowUps.push(message);
    harness.runtime.takeNextFollowUpAtTurnBoundary();
    harness.runtime.appendConversationHistory({ role: "user", content: message.message });
    harness.runtime.markFollowUpMessageConsumed(message.messageId);
    expect(harness.runtime.saveSnapshot()).toBe(true);
    const snapshot = harness.emittedEvents
      .filter((event) => event.type === "conversation_snapshot")
      .at(-1)!.payload;
    expect(snapshot.queues.consumedFollowUpMessageIds).toContain(message.messageId);
    const restored = createHarness();
    restored.runtime.restoreFromEvents([
      {
        id: "queued",
        taskId: "task-1",
        type: "user_message",
        timestamp: 1,
        payload: { ...message, deliveryStatus: "queued" },
      },
      {
        id: "incorporated",
        taskId: "task-1",
        type: "conversation_snapshot",
        timestamp: 2,
        payload: JSON.parse(JSON.stringify(snapshot)),
      },
    ] as Any);
    expect(restored.runtime.isFollowUpMessageConsumed(message.messageId)).toBe(true);
    // A pending copy may be retained for acknowledgement-only retry. The
    // executor uses the consumed marker to avoid injecting or executing it again.
    expect(restored.runtime.state.queues.pendingFollowUps.length).toBeLessThanOrEqual(1);
    for (const pending of restored.runtime.state.queues.pendingFollowUps) {
      expect(restored.runtime.isFollowUpMessageConsumed(pending.messageId!)).toBe(true);
    }
    expect(restored.runtime.getOutputState().conversationHistory).toEqual([
      { role: "user", content: message.message },
    ]);
  });

  it("preserves the entire unaccepted queue payload across a handoff snapshot and restart", () => {
    const harness = createHarness();
    harness.runtime.appendConversationHistory({ role: "user", content: "Earlier context" });
    const message: Any = {
      message: "Inspect this image",
      messageId: "image-message",
      deliveryMode: "message",
      messageSource: "agent",
      senderTaskId: "parent",
      images: [{ id: "image-1", data: "ZmFrZQ==", mimeType: "image/png", filename: "fake.png" }],
      quotedAssistantMessage: { text: "Quoted context", taskId: "task-1" },
      integrationMentions: ["connector-a"],
    };
    harness.runtime.state.queues.pendingFollowUps.push(message);
    expect(harness.runtime.takeNextFollowUpAtTurnBoundary()).toEqual(message);
    expect(harness.runtime.saveSnapshot()).toBe(true);
    const snapshot = harness.emittedEvents
      .filter((event) => event.type === "conversation_snapshot")
      .at(-1)!.payload;
    const restored = createHarness();
    restored.runtime.restoreFromEvents([
      {
        id: "receipt",
        taskId: "task-1",
        type: "user_message",
        timestamp: 1,
        payload: {
          message: message.message,
          messageId: message.messageId,
          deliveryMode: "message",
          deliveryStatus: "queued",
          messageSource: "agent",
        },
      },
      {
        id: "handoff",
        taskId: "task-1",
        type: "conversation_snapshot",
        timestamp: 2,
        payload: JSON.parse(JSON.stringify(snapshot)),
      },
    ] as Any);
    expect(restored.runtime.takeNextFollowUpAtTurnBoundary()).toEqual(message);
  });

  it("requeues the same message id without creating duplicate pending copies", () => {
    const harness = createHarness();
    const message: Any = {
      message: "Retry me",
      messageId: "retry-message",
      deliveryMode: "message",
      messageSource: "agent",
    };
    harness.runtime.state.queues.pendingFollowUps.push(message);
    harness.runtime.requeueFollowUpAtTurnBoundary(message);
    harness.runtime.requeueFollowUpAtTurnBoundary(message);
    expect(harness.runtime.state.queues.pendingFollowUps).toEqual([message]);
  });

  it("acknowledges feedback before clearing it so a consumed marker is emitted", () => {
    const harness = createHarness();

    harness.runtime.setStepFeedback("step-1", "retry", "Try once more");
    const signal = harness.runtime.consumeStepFeedback("step-1");

    expect(signal).toMatchObject({
      stepId: "step-1",
      action: "retry",
      message: "Try once more",
    });
    expect(harness.runtime.state.queues.stepFeedbackSignal).toBeNull();
    expect(harness.emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_feedback",
          payload: expect.objectContaining({ feedbackId: expect.any(String) }),
        }),
        expect.objectContaining({
          type: "step_feedback",
          payload: expect.objectContaining({ consumed: true }),
        }),
      ]),
    );
  });

  it("emits llm_usage with structured provider metadata from model selection", () => {
    const harness = createHarness();

    harness.runtime.updateTracking(120, 45, 10);

    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "llm_usage",
        payload: expect.objectContaining({
          providerType: "anthropic",
          modelId: "gpt-test",
          delta: expect.objectContaining({
            inputTokens: 120,
            outputTokens: 45,
            cachedTokens: 10,
          }),
        }),
      }),
    );
  });

  it("installs and persists a summary when compacting before continuation", async () => {
    const harness = createHarness();
    const runtime = harness.runtime as Any;
    const summaryBuilder = vi
      .fn()
      .mockResolvedValue(
        "<cowork_compaction_summary>Remember the decision.</cowork_compaction_summary>",
      );
    const summaryFlush = vi.fn().mockResolvedValue(undefined);
    runtime.deps.shouldCompactOnContinuation = () => true;
    runtime.deps.getRenderedContextRatio = () => 0.95;
    runtime.deps.getContextManager = () => ({
      getAvailableTokens: () => 1000,
      compactMessagesWithMeta: (messages: LLMMessage[]) => ({
        messages: messages.slice(1),
        meta: {
          originalTokens: 1200,
          removedMessages: {
            didRemove: true,
            messages: [messages[0]],
            count: 1,
            tokensAfter: 400,
          },
        },
      }),
    });
    runtime.deps.buildCompactionSummaryBlock = summaryBuilder;
    runtime.deps.flushCompactionSummaryToMemory = summaryFlush;
    runtime.deps.upsertPinnedUserBlock = (messages: LLMMessage[], opts: Any) => {
      messages.push({ role: "user", content: opts.content });
    };
    runtime.state.transcript.conversationHistory = [
      { role: "user", content: "old context" },
      { role: "assistant", content: "current context" },
    ];

    await harness.runtime.maybeCompactBeforeContinuation({});

    expect(summaryBuilder).toHaveBeenCalledWith(
      expect.objectContaining({
        contextLabel: "continuation compaction",
        removedMessages: [{ role: "user", content: "old context" }],
      }),
    );
    expect(summaryFlush).toHaveBeenCalledWith(
      expect.objectContaining({ summaryBlock: expect.stringContaining("Remember the decision") }),
    );
    expect(harness.runtime.state.transcript.conversationHistory).toEqual([
      { role: "assistant", content: "current context" },
      {
        role: "user",
        content: "<cowork_compaction_summary>Remember the decision.</cowork_compaction_summary>",
      },
    ]);
    const summaryEvent = harness.emittedEvents.find((event) => event.type === "context_summarized");
    expect(summaryEvent).toBeDefined();
    expect(summaryEvent?.payload.summary).toBeUndefined();
    expect(summaryEvent?.payload.summaryPreview).toContain("Remember the decision");
  });

  it("rejects a stale compaction result when history changes during summarization", async () => {
    const harness = createHarness();
    const runtime = harness.runtime as Any;
    const recordHistory = vi
      .spyOn(DurableContextService, "recordHistory")
      .mockImplementation(() => undefined);
    let releaseSummary!: (value: string) => void;
    const summaryPending = new Promise<string>((resolve) => {
      releaseSummary = resolve;
    });
    runtime.deps.shouldCompactOnContinuation = () => true;
    runtime.deps.getRenderedContextRatio = () => 0.95;
    runtime.deps.getContextManager = () => ({
      getAvailableTokens: () => 1000,
      compactMessagesWithMeta: (messages: LLMMessage[]) => ({
        messages: messages.slice(1),
        meta: {
          originalTokens: 1200,
          removedMessages: {
            didRemove: true,
            messages: [messages[0]],
            count: 1,
            tokensAfter: 400,
          },
        },
      }),
    });
    runtime.deps.buildCompactionSummaryBlock = vi.fn(() => summaryPending);
    runtime.state.transcript.conversationHistory = [
      { role: "user", content: "old context" },
      { role: "assistant", content: "current context" },
    ];

    const compaction = harness.runtime.maybeCompactBeforeContinuation({});
    await Promise.resolve();
    harness.runtime.updateConversationHistory([
      ...runtime.state.transcript.conversationHistory,
      { role: "user", content: "new follow-up" },
    ]);
    releaseSummary("<cowork_compaction_summary>stale</cowork_compaction_summary>");
    await compaction;

    expect(runtime.state.transcript.conversationHistory.at(-1)).toEqual({
      role: "user",
      content: "new follow-up",
    });
    expect(
      harness.emittedEvents.some((event) => event.type === "context_compaction_completed"),
    ).toBe(false);
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_compaction_failed",
        payload: expect.objectContaining({
          reason: "history_changed_while_compacting",
          retryable: true,
        }),
      }),
    );
    expect(recordHistory.mock.calls.some(([input]) => input.source === "compaction_source")).toBe(
      false,
    );
    recordHistory.mockRestore();
  });

  it("releases the automatic compaction lock when summary generation fails", async () => {
    const harness = createHarness();
    const messages: LLMMessage[] = [
      { role: "user", content: "Older context" },
      { role: "assistant", content: "Recent context" },
    ];
    harness.runtime.state.transcript.conversationHistory = messages;
    harness.runtime.deps.getContextManager = () =>
      ({
        getContextUtilization: () => ({
          currentTokens: 9_500,
          availableTokens: 10_000,
          utilization: 0.95,
        }),
        proactiveCompactWithMeta: (currentMessages: LLMMessage[]) => ({
          messages: currentMessages.slice(1),
          meta: {
            originalTokens: 9_500,
            removedMessages: {
              didRemove: true,
              messages: [currentMessages[0]],
              count: 1,
              tokensAfter: 4_000,
            },
            truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 4_000 },
          },
        }),
        compactMessagesWithMeta: (currentMessages: LLMMessage[]) => ({
          messages: currentMessages,
          meta: {
            originalTokens: 9_500,
            removedMessages: { didRemove: false, messages: [], count: 0, tokensAfter: 9_500 },
            truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 9_500 },
          },
        }),
        getAvailableTokens: () => 10_000,
      }) as Any;
    harness.runtime.deps.buildCompactionSummaryBlock = vi
      .fn()
      .mockRejectedValue(new Error("summary provider unavailable"));

    const preparation = harness.runtime.prepareMessagesForTurnIteration({
      messages,
      phase: "step",
      systemPromptTokens: 0,
      allowSharedContextInjection: false,
      allowMemoryInjection: false,
      memoryQuery: "",
      contextLabel: "step:compaction",
      lastTurnMemoryRecallQuery: "",
      lastTurnMemoryRecallBlock: "",
      lastSharedContextKey: "",
      lastSharedContextBlock: "",
    });
    const result = await preparation;

    expect(result.messages).toBe(messages);
    expect(harness.runtime.getCompactionSnapshot()).toMatchObject({
      activeCompactionId: null,
      lastCompactionStatus: "failed",
    });
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_compaction_failed",
        payload: expect.objectContaining({
          reason: "summary provider unavailable",
          retryable: true,
        }),
      }),
    );
  });

  it("fails closed when a summary provider returns an empty result", async () => {
    const harness = createHarness();
    const messages: LLMMessage[] = [
      { role: "user", content: "Older context that must be retained" },
      { role: "assistant", content: "Recent context" },
    ];
    harness.runtime.state.transcript.conversationHistory = messages;
    harness.runtime.deps.getContextManager = () =>
      ({
        getContextUtilization: () => ({
          currentTokens: 9_500,
          availableTokens: 10_000,
          utilization: 0.95,
        }),
        proactiveCompactWithMeta: (currentMessages: LLMMessage[]) => ({
          messages: currentMessages.slice(1),
          meta: {
            originalTokens: 9_500,
            removedMessages: {
              didRemove: true,
              messages: [currentMessages[0]],
              count: 1,
              tokensAfter: 4_000,
            },
            truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 4_000 },
          },
        }),
        compactMessagesWithMeta: (currentMessages: LLMMessage[]) => ({
          messages: currentMessages,
          meta: {
            originalTokens: 9_500,
            removedMessages: { didRemove: false, messages: [], count: 0, tokensAfter: 9_500 },
            truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 9_500 },
          },
        }),
        getAvailableTokens: () => 10_000,
      }) as Any;
    harness.runtime.deps.buildCompactionSummaryBlock = vi.fn().mockResolvedValue("   ");

    const result = await harness.runtime.prepareMessagesForTurnIteration({
      messages,
      phase: "step",
      systemPromptTokens: 0,
      allowSharedContextInjection: false,
      allowMemoryInjection: false,
      memoryQuery: "",
      contextLabel: "step:empty-summary",
      lastTurnMemoryRecallQuery: "",
      lastTurnMemoryRecallBlock: "",
      lastSharedContextKey: "",
      lastSharedContextBlock: "",
    });

    expect(result.messages).toBe(messages);
    expect(harness.runtime.state.transcript.conversationHistory).toBe(messages);
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_compaction_failed",
        payload: expect.objectContaining({
          reason: "compaction_summary_empty",
          failureStage: "summarize",
        }),
      }),
    );
    expect(
      harness.emittedEvents.some((event) => event.type === "context_compaction_completed"),
    ).toBe(false);
  });

  it("continues automatic compaction when the start event sink fails", async () => {
    const harness = createHarness();
    const runtime = harness.runtime as Any;
    const messages: LLMMessage[] = [
      { role: "user", content: "Older context" },
      { role: "assistant", content: "Recent context" },
    ];
    runtime.deps.getContextManager = () => ({
      getContextUtilization: () => ({
        currentTokens: 9_500,
        availableTokens: 10_000,
        utilization: 0.95,
      }),
      proactiveCompactWithMeta: (currentMessages: LLMMessage[]) => ({
        messages: currentMessages.slice(1),
        meta: {
          originalTokens: 9_500,
          removedMessages: {
            didRemove: true,
            messages: [currentMessages[0]],
            count: 1,
            tokensAfter: 4_000,
          },
          truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 4_000 },
        },
      }),
      compactMessagesWithMeta: (currentMessages: LLMMessage[]) => ({
        messages: currentMessages,
        meta: {
          originalTokens: 9_500,
          removedMessages: {
            didRemove: false,
            messages: [],
            count: 0,
            tokensAfter: 9_500,
          },
          truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 9_500 },
        },
      }),
      getAvailableTokens: () => 10_000,
    });
    runtime.deps.buildCompactionSummaryBlock = vi
      .fn()
      .mockResolvedValue(
        "<cowork_compaction_summary>Retain this context.</cowork_compaction_summary>",
      );
    const originalEmitEvent = runtime.deps.emitEvent;
    runtime.deps.emitEvent = (type: string, payload: Any) => {
      if (type === "context_compaction_started") {
        throw new Error("timeline unavailable");
      }
      originalEmitEvent(type, payload);
    };

    const result = await runtime.prepareMessagesForTurnIteration({
      messages,
      phase: "step",
      systemPromptTokens: 0,
      allowSharedContextInjection: false,
      allowMemoryInjection: false,
      memoryQuery: "",
      contextLabel: "step:compaction",
      lastTurnMemoryRecallQuery: "",
      lastTurnMemoryRecallBlock: "",
      lastSharedContextKey: "",
      lastSharedContextBlock: "",
    });

    expect(result.messages).toEqual([messages[1]]);
    expect(harness.runtime.getCompactionSnapshot()).toMatchObject({
      activeCompactionId: null,
      lastCompactionStatus: "completed",
    });
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({ type: "context_compaction_completed" }),
    );
    runtime.deps.emitEvent = originalEmitEvent;
  });

  it("persists the replacement snapshot before publishing compaction completion", () => {
    const harness = createHarness();
    const runtime = harness.runtime as Any;
    runtime.state.transcript.conversationHistory = [
      { role: "user", content: "old context" },
      { role: "assistant", content: "recent context" },
    ];
    runtime.historyGeneration = 2;
    const compaction = runtime.beginCompaction({
      trigger: "automatic",
      phase: "pre_turn",
      reason: "threshold",
    });
    expect(compaction).not.toBeNull();

    runtime.updateConversationHistory([{ role: "user", content: "replacement context" }]);
    runtime.completeCompaction({
      compactionId: compaction.compactionId,
      trigger: "automatic",
      phase: "pre_turn",
      reason: "context_replacement_installed",
    });

    const eventTypes = harness.emittedEvents.map((event) => event.type);
    expect(eventTypes.indexOf("conversation_snapshot")).toBeLessThan(
      eventTypes.indexOf("context_compaction_completed"),
    );
  });

  it("does not publish completion when the replacement snapshot cannot be persisted", () => {
    const harness = createHarness();
    const runtime = harness.runtime as Any;
    runtime.state.transcript.conversationHistory = [
      { role: "user", content: "old context" },
      { role: "assistant", content: "recent context" },
    ];
    const compaction = runtime.beginCompaction({
      trigger: "automatic",
      phase: "pre_turn",
      reason: "threshold",
    });
    expect(compaction).not.toBeNull();

    runtime.updateConversationHistory([{ role: "user", content: "replacement context" }]);
    const originalEmitEvent = runtime.deps.emitEvent;
    runtime.deps.emitEvent = (type: string, payload: Any) => {
      if (type === "conversation_snapshot") {
        throw new Error("snapshot unavailable");
      }
      originalEmitEvent(type, payload);
    };
    runtime.completeCompaction({
      compactionId: compaction.compactionId,
      trigger: "automatic",
      phase: "pre_turn",
    });

    expect(harness.emittedEvents).not.toContainEqual(
      expect.objectContaining({ type: "context_compaction_completed" }),
    );
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_compaction_failed",
        payload: expect.objectContaining({
          reason: "compaction_snapshot_persistence_failed",
          failureStage: "snapshot",
        }),
      }),
    );
    expect(harness.runtime.getCompactionSnapshot()).toMatchObject({
      activeCompactionId: null,
      lastCompactionStatus: "failed",
    });
  });

  it("marks a started compaction interrupted when restoring after a restart", () => {
    const source = createHarness();
    const runtime = source.runtime as Any;
    runtime.state.transcript.conversationHistory = [{ role: "user", content: "in-flight context" }];
    runtime.historyGeneration = 4;
    runtime.lastCompactionId = "compaction-restart";
    runtime.lastCompactionAttemptId = "attempt-restart";
    runtime.lastCompactionStatus = "started";
    runtime.lastCompactionInputGeneration = 4;
    expect(source.runtime.saveSnapshot()).toBe(true);
    const snapshot = source.emittedEvents
      .filter((event) => event.type === "conversation_snapshot")
      .at(-1)!.payload;

    const restored = createHarness();
    restored.runtime.restoreFromEvents([
      {
        id: "restart-snapshot",
        taskId: "task-1",
        timestamp: 1,
        type: "conversation_snapshot",
        payload: JSON.parse(JSON.stringify(snapshot)),
      },
    ] as Any);

    expect(restored.runtime.getCompactionSnapshot()).toMatchObject({
      activeCompactionId: null,
      lastCompactionStatus: "interrupted",
    });
    expect(restored.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_compaction_failed",
        payload: expect.objectContaining({
          compactionId: "compaction-restart",
          attemptId: "attempt-restart",
          reason: "compaction_interrupted_by_restart",
          interrupted: true,
        }),
      }),
    );
  });

  it("reconciles an orphaned lifecycle start when the process crashed before any snapshot", () => {
    const restored = createHarness();
    restored.runtime.restoreFromEvents([
      {
        id: "orphaned-start",
        taskId: "task-1",
        timestamp: 1,
        type: "context_compaction_started",
        payload: {
          compactionId: "orphaned-compaction",
          attemptId: "orphaned-attempt",
          status: "started",
          trigger: "automatic",
          phase: "pre_turn",
          reason: "chat_history_threshold",
          historyGenerationBefore: 9,
          accountingSource: "estimate",
        },
      },
    ] as Any);

    expect(restored.runtime.getCompactionSnapshot()).toMatchObject({
      activeCompactionId: null,
      lastCompactionId: "orphaned-compaction",
      lastCompactionStatus: "interrupted",
    });
    expect(restored.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_compaction_failed",
        payload: expect.objectContaining({
          compactionId: "orphaned-compaction",
          attemptId: "orphaned-attempt",
          trigger: "automatic",
          phase: "pre_turn",
          reason: "compaction_interrupted_by_restart",
          interrupted: true,
        }),
      }),
    );
  });

  it("recovers explicit-chat compaction from a start snapshot after restart", () => {
    const source = createHarness();
    source.runtime.state.transcript.conversationHistory = [
      { role: "user", content: "Earlier chat context" },
      { role: "assistant", content: "Recent chat context" },
    ];
    const handle = source.runtime.beginCompactionLifecycle({
      trigger: "automatic",
      phase: "pre_turn",
      reason: "chat_history_threshold",
      inputTokens: 12_000,
      inputMessageCount: 24,
      thresholdRatio: 0.9,
      targetRatio: 0.55,
      extra: { contextLabel: "chat session" },
    });
    expect(handle).not.toBeNull();
    const snapshot = source.emittedEvents
      .filter((event) => event.type === "conversation_snapshot")
      .at(-1)!.payload;

    const restored = createHarness();
    restored.runtime.restoreFromEvents([
      {
        id: "explicit-chat-start-snapshot",
        taskId: "task-1",
        timestamp: 1,
        type: "conversation_snapshot",
        payload: JSON.parse(JSON.stringify(snapshot)),
      },
    ] as Any);

    expect(restored.runtime.getCompactionSnapshot()).toMatchObject({
      activeCompactionId: null,
      lastCompactionId: handle!.compactionId,
      lastCompactionStatus: "interrupted",
    });
    expect(restored.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_compaction_failed",
        payload: expect.objectContaining({
          compactionId: handle!.compactionId,
          trigger: "automatic",
          phase: "pre_turn",
          reason: "compaction_interrupted_by_restart",
        }),
      }),
    );
  });

  it("replays a terminal snapshot when its lifecycle terminal event was lost", () => {
    const source = createHarness();
    source.runtime.state.transcript.conversationHistory = [
      { role: "user", content: "Older context" },
      { role: "assistant", content: "Replacement context" },
    ];
    const handle = source.runtime.beginCompactionLifecycle({
      trigger: "automatic",
      phase: "pre_turn",
      reason: "threshold",
    });
    expect(handle).not.toBeNull();
    source.runtime.updateConversationHistory([{ role: "user", content: "Replacement context" }]);
    source.runtime.completeCompactionLifecycle(handle!, {
      reason: "context_replacement_installed",
    });
    const start = source.emittedEvents.find((event) => event.type === "context_compaction_started");
    const terminalSnapshot = source.emittedEvents
      .filter((event) => event.type === "conversation_snapshot")
      .at(-1);
    expect(start).toBeDefined();
    expect(terminalSnapshot?.payload.compaction.lastCompactionStatus).toBe("completed");

    const restored = createHarness();
    restored.runtime.restoreFromEvents([
      {
        id: "lost-terminal-start",
        taskId: "task-1",
        timestamp: 1,
        type: "context_compaction_started",
        payload: start!.payload,
      },
      {
        id: "terminal-snapshot",
        taskId: "task-1",
        timestamp: 2,
        type: "conversation_snapshot",
        payload: terminalSnapshot!.payload,
      },
    ] as Any);

    expect(restored.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_compaction_completed",
        payload: expect.objectContaining({
          compactionId: handle!.compactionId,
          restoredFromSnapshot: true,
        }),
      }),
    );
  });

  it("fails before the provider call when retained user and pinned context exceeds the hard budget", async () => {
    const harness = createHarness();
    const messages: LLMMessage[] = [
      { role: "user", content: "Original user requirement ".repeat(80) },
      {
        role: "user",
        content: "<cowork_shared_context>Required pinned constraint</cowork_shared_context>",
      },
    ];
    const availableTokens = 20;
    const contextManager = {
      getAvailableTokens: () => availableTokens,
      getContextUtilization: (currentMessages: LLMMessage[]) => {
        const currentTokens = estimateTotalTokens(currentMessages);
        return {
          currentTokens,
          availableTokens,
          utilization: currentTokens / availableTokens,
        };
      },
      proactiveCompactWithMeta: (currentMessages: LLMMessage[]) => ({
        messages: currentMessages,
        meta: {
          availableTokens,
          originalTokens: estimateTotalTokens(currentMessages),
          truncatedToolResults: {
            didTruncate: false,
            count: 0,
            tokensAfter: estimateTotalTokens(currentMessages),
          },
          removedMessages: {
            didRemove: false,
            messages: [],
            count: 0,
            tokensAfter: estimateTotalTokens(currentMessages),
          },
          kind: "none",
        },
      }),
      compactMessagesWithMeta: (currentMessages: LLMMessage[]) => ({
        messages: currentMessages,
        meta: {
          availableTokens,
          originalTokens: estimateTotalTokens(currentMessages),
          truncatedToolResults: {
            didTruncate: false,
            count: 0,
            tokensAfter: estimateTotalTokens(currentMessages),
          },
          removedMessages: {
            didRemove: false,
            messages: [],
            count: 0,
            tokensAfter: estimateTotalTokens(currentMessages),
          },
          kind: "none",
        },
      }),
    };
    harness.runtime.deps.getContextManager = () => contextManager as Any;

    const preparation = harness.runtime.prepareMessagesForTurnIteration({
      messages,
      phase: "step",
      systemPromptTokens: 0,
      allowSharedContextInjection: false,
      allowMemoryInjection: false,
      memoryQuery: "",
      contextLabel: "step:budget",
      lastTurnMemoryRecallQuery: "",
      lastTurnMemoryRecallBlock: "",
      lastSharedContextKey: "",
      lastSharedContextBlock: "",
    });
    await expect(preparation).rejects.toBeInstanceOf(ContextCapacityExhaustedError);
    await expect(preparation).rejects.toMatchObject({
      code: "CONTEXT_CAPACITY_RECOVERY_EXHAUSTED",
      availableTokens,
    });
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_capacity_recovery_exhausted",
        payload: expect.objectContaining({
          phase: "step",
          reason: "required_content_exceeds_available_budget",
          availableTokens,
        }),
      }),
    );
  });

  it("does not report recovery completed when retained context remains over the hard budget", async () => {
    const harness = createHarness();
    const messages: LLMMessage[] = [
      { role: "user", content: "Original user requirement ".repeat(80) },
      {
        role: "user",
        content: "<cowork_shared_context>Required pinned constraint</cowork_shared_context>",
      },
    ];
    const availableTokens = 20;
    const tokensBefore = estimateTotalTokens(messages);
    harness.runtime.deps.getContextManager = () =>
      ({
        getAvailableTokens: () => availableTokens,
        proactiveCompactWithMeta: (currentMessages: LLMMessage[]) => ({
          messages: currentMessages,
          meta: {
            availableTokens,
            originalTokens: tokensBefore,
            truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: tokensBefore },
            removedMessages: {
              didRemove: true,
              messages: [{ role: "assistant", content: "Older context" }],
              count: 1,
              tokensAfter: tokensBefore,
            },
            kind: "message_removal",
          },
        }),
        compactMessagesWithMeta: (currentMessages: LLMMessage[]) => ({
          messages: currentMessages,
          meta: {
            availableTokens,
            originalTokens: tokensBefore,
            truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: tokensBefore },
            removedMessages: {
              didRemove: false,
              messages: [],
              count: 0,
              tokensAfter: tokensBefore,
            },
            kind: "none",
          },
        }),
      }) as Any;
    harness.runtime.deps.buildCompactionSummaryBlock = vi
      .fn()
      .mockResolvedValue("<cowork_compaction_summary>retained context</cowork_compaction_summary>");

    const result = await harness.runtime.recoverFromContextCapacityOverflow({
      error: new Error("Context length exceeded for this model"),
      messages,
      systemPromptTokens: 0,
      phase: "step",
      stepId: "step-1",
      attempt: 0,
      maxAttempts: 2,
    });

    expect(result).toEqual({ recovered: false, exhausted: true, messages });
    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "context_capacity_recovery_exhausted",
        payload: expect.objectContaining({
          phase: "step",
          stepId: "step-1",
          reason: "required_content_exceeds_available_budget",
          availableTokens,
          tokensAfter: tokensBefore,
        }),
      }),
    );
    expect(
      harness.emittedEvents.some((event) => event.type === "context_capacity_recovery_completed"),
    ).toBe(false);
  });

  it("does not strand capacity recovery when its telemetry sink fails", async () => {
    const harness = createHarness();
    const messages: LLMMessage[] = [
      { role: "user", content: "Older context" },
      { role: "assistant", content: "Recent context" },
    ];
    harness.runtime.deps.getContextManager = () =>
      ({
        getAvailableTokens: () => 10_000,
        proactiveCompactWithMeta: (currentMessages: LLMMessage[]) => ({
          messages: currentMessages.slice(1),
          meta: {
            originalTokens: 1200,
            removedMessages: {
              didRemove: true,
              messages: [currentMessages[0]],
              count: 1,
              tokensAfter: 400,
            },
          },
        }),
        compactMessagesWithMeta: (currentMessages: LLMMessage[]) => ({
          messages: currentMessages,
          meta: {
            originalTokens: 1200,
            removedMessages: { didRemove: false, messages: [], count: 0, tokensAfter: 1200 },
          },
        }),
      }) as Any;
    harness.runtime.deps.buildCompactionSummaryBlock = vi
      .fn()
      .mockResolvedValue(
        "<cowork_compaction_summary>Keep the recent context.</cowork_compaction_summary>",
      );
    const originalEmitEvent = harness.runtime.deps.emitEvent;
    harness.runtime.deps.emitEvent = (type: string, payload: Any) => {
      if (
        type === "context_capacity_recovery_started" ||
        type === "context_capacity_recovery_completed" ||
        type === "log"
      ) {
        throw new Error(`${type} sink unavailable`);
      }
      originalEmitEvent(type, payload);
    };

    const result = await harness.runtime.recoverFromContextCapacityOverflow({
      error: new Error("Context length exceeded for this model"),
      messages,
      systemPromptTokens: 0,
      phase: "step",
      stepId: "step-1",
      attempt: 0,
      maxAttempts: 2,
    });

    expect(result.recovered).toBe(true);
    expect(harness.runtime.getCompactionSnapshot()).toMatchObject({
      activeCompactionId: null,
      lastCompactionStatus: "completed",
    });
    expect(
      harness.emittedEvents.some((event) => event.type === "context_compaction_completed"),
    ).toBe(true);
    expect(
      harness.emittedEvents.some((event) => event.type === "context_capacity_recovery_completed"),
    ).toBe(false);
  });

  it("continues a text loop once when the model stops on max_tokens", async () => {
    const harness = createHarness();
    harness.createMessageWithTimeout
      .mockResolvedValueOnce({
        stopReason: "max_tokens",
        content: [{ type: "text", text: "Hello" }],
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      })
      .mockResolvedValueOnce({
        stopReason: "end_turn",
        content: [{ type: "text", text: " world" }],
        usage: { inputTokens: 6, outputTokens: 4, cachedTokens: 0 },
      });

    const result = await harness.runtime.runTextLoop({
      messages: [{ role: "user", content: "Start" }],
      systemPrompt: "system",
      initialMaxTokens: 64,
      continuationMaxTokens: 32,
      mode: "step",
      operationLabel: "test text loop",
      allowContinuation: true,
      emptyFallback: "empty",
    });

    expect(result.assistantText).toBe("Hello world");
    expect(harness.createMessageWithTimeout).toHaveBeenCalledTimes(2);
    expect(harness.runtime.state.loop.lifetimeTurnCount).toBe(2);
  });

  it("replays one same-request escalation before continuation recovery in adaptive mode", async () => {
    const previousPolicy = process.env.COWORK_LLM_OUTPUT_POLICY;
    try {
      process.env.COWORK_LLM_OUTPUT_POLICY = "adaptive";
      const harness = createHarness();
      harness.createMessageWithTimeout
        .mockResolvedValueOnce({
          stopReason: "max_tokens",
          content: [{ type: "text", text: "partial answer" }],
          usage: { inputTokens: 10, outputTokens: 8, cachedTokens: 0 },
        })
        .mockResolvedValueOnce({
          stopReason: "end_turn",
          content: [{ type: "text", text: "complete answer" }],
          usage: { inputTokens: 10, outputTokens: 12, cachedTokens: 0 },
        });

      const result = await harness.runtime.requestLLMResponseWithAdaptiveBudget({
        messages: [{ role: "user", content: "Start" }],
        retryLabel: "adaptive retry",
        operation: "Adaptive retry test",
      });

      expect(harness.createMessageWithTimeout).toHaveBeenCalledTimes(2);
      expect(harness.createMessageWithTimeout.mock.calls[0][0].maxTokens).toBe(8_000);
      expect(harness.createMessageWithTimeout.mock.calls[1][0].maxTokens).toBe(64_000);
      expect(result.response.stopReason).toBe("end_turn");
      expect(result.outputBudget.escalationAttempted).toBe(true);
      expect(result.outputBudget.finalBudget).toBe(64_000);
    } finally {
      if (previousPolicy == null) {
        delete process.env.COWORK_LLM_OUTPUT_POLICY;
      } else {
        process.env.COWORK_LLM_OUTPUT_POLICY = previousPolicy;
      }
    }
  });

  it("preserves cache-write TTL in usage telemetry", async () => {
    const harness = createHarness();
    harness.createMessageWithTimeout.mockResolvedValueOnce({
      stopReason: "end_turn",
      content: [{ type: "text", text: "done" }],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        cacheWriteTokens: 3,
        cacheWriteTtl: "1h",
      },
    });

    await harness.runtime.requestLLMResponseWithAdaptiveBudget({
      messages: [{ role: "user", content: "Start" }],
      retryLabel: "cache ttl",
      operation: "Cache TTL test",
    });

    expect(harness.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: "llm_usage",
        payload: expect.objectContaining({
          delta: expect.objectContaining({
            cacheWriteTokens: 3,
            cacheWriteTtl: "1h",
          }),
        }),
      }),
    );
  });

  it("marks repeated thinking-only truncation as non-continuable after escalation", async () => {
    const previousPolicy = process.env.COWORK_LLM_OUTPUT_POLICY;
    try {
      process.env.COWORK_LLM_OUTPUT_POLICY = "adaptive";
      const harness = createHarness();
      harness.createMessageWithTimeout
        .mockResolvedValueOnce({
          stopReason: "max_tokens",
          content: [{ type: "text", text: "<think>reasoning</think>" }],
          usage: { inputTokens: 10, outputTokens: 8, cachedTokens: 0 },
        })
        .mockResolvedValueOnce({
          stopReason: "max_tokens",
          content: [{ type: "text", text: "<think>still reasoning</think>" }],
          usage: { inputTokens: 10, outputTokens: 12, cachedTokens: 0 },
        });

      const result = await harness.runtime.requestLLMResponseWithAdaptiveBudget({
        messages: [{ role: "user", content: "Start" }],
        retryLabel: "adaptive retry",
        operation: "Adaptive retry test",
      });

      expect(harness.createMessageWithTimeout).toHaveBeenCalledTimes(2);
      expect(result.response.stopReason).toBe("max_tokens");
      expect(result.outputBudget.escalationAttempted).toBe(true);
      expect(result.outputBudget.truncationClassification).toBe("reasoning_exhausted");
      expect(result.outputBudget.continuationAllowed).toBe(false);
      expect(result.outputBudget.guidanceMessage).toContain("output budget");
    } finally {
      if (previousPolicy == null) {
        delete process.env.COWORK_LLM_OUTPUT_POLICY;
      } else {
        process.env.COWORK_LLM_OUTPUT_POLICY = previousPolicy;
      }
    }
  });

  it("can force an adaptive-budget request to run without tools", async () => {
    const harness = createHarness();
    harness.setToolRegistry({
      getTools: vi.fn(() => [{ name: "web_search", description: "Search web" }]),
      getDeferredTools: vi.fn(() => []),
      getToolCatalogVersion: vi.fn(() => "catalog:v1"),
      cleanup: vi.fn(async () => undefined),
    });
    harness.createMessageWithTimeout.mockResolvedValueOnce({
      stopReason: "end_turn",
      content: [{ type: "text", text: "done" }],
      usage: { inputTokens: 10, outputTokens: 3, cachedTokens: 0 },
    });

    const result = await harness.runtime.requestLLMResponseWithAdaptiveBudget({
      messages: [{ role: "user", content: "Finish" }],
      retryLabel: "no tools",
      operation: "No tools test",
      forceNoTools: true,
    });

    expect(result.availableTools).toEqual([]);
    expect(harness.createMessageWithTimeout.mock.calls[0][0].tools).toEqual([]);
  });

  it("refreshes base tool discovery and still invalidates on catalog or workspace changes", () => {
    const harness = createHarness();
    let catalogVersion = "catalog:v1";
    const initialRegistry = {
      getTools: vi.fn(() => [{ name: "read_file" }, { name: "run_command" }]),
      getDeferredTools: vi.fn(() => []),
      getToolCatalogVersion: vi.fn(() => catalogVersion),
      cleanup: vi.fn(async () => undefined),
    };
    harness.setToolRegistry(initialRegistry);

    harness.runtime.getAvailableTools();
    harness.runtime.getAvailableTools();
    expect(initialRegistry.getTools).toHaveBeenCalledTimes(1);

    catalogVersion = "catalog:v2";
    harness.runtime.getAvailableTools();
    expect(initialRegistry.getTools).toHaveBeenCalledTimes(2);

    const updatedRegistry = {
      getTools: vi.fn(() => [{ name: "browser_navigate" }]),
      getDeferredTools: vi.fn(() => []),
      getToolCatalogVersion: vi.fn(() => "catalog:v3"),
      cleanup: vi.fn(async () => undefined),
    };
    harness.runtime.applyWorkspaceUpdate(
      {
        id: "workspace-1",
        path: "/tmp/workspace",
        permissions: { shell: false },
      } as Any,
      updatedRegistry as Any,
    );

    const updatedTools = harness.runtime.getAvailableTools();
    expect(updatedRegistry.getTools).toHaveBeenCalledTimes(1);
    expect(updatedTools.map((tool: Any) => tool.name)).toEqual(["browser_navigate"]);
  });

  it("keeps the verified bot handoff tool visible in plan mode without exposing writes", () => {
    const harness = createHarness();
    harness.setToolRegistry({
      getTools: vi.fn(() => [
        { name: "send_agent_message" },
        { name: "write_file" },
        { name: "read_file" },
      ]),
      getDeferredTools: vi.fn(() => []),
      getToolCatalogVersion: vi.fn(() => "catalog:bot-policy"),
      cleanup: vi.fn(async () => undefined),
    });
    harness.deps.getToolPolicyContext = () => ({
      executionMode: "plan",
      taskDomain: "general",
      botConversation: true,
      botTeamId: "team-1",
      botMessagingAuthorized: true,
    });

    expect(harness.runtime.getAvailableTools().map((tool: Any) => tool.name)).toEqual([
      "send_agent_message",
      "read_file",
    ]);
  });

  it("writes conversation snapshots with the V2 runtime schema", () => {
    const harness = createHarness();
    harness.runtime.state.transcript.conversationHistory = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    harness.runtime.saveSnapshot({ description: "Plan summary" });

    const snapshotEvent = harness.emittedEvents.find(
      (event) => event.type === "conversation_snapshot",
    );
    expect(snapshotEvent?.payload.schema).toBe("session_runtime_v2");
    expect(snapshotEvent?.payload.version).toBe(2);
    expect(snapshotEvent?.payload.messageCount).toBe(2);
  });

  it("persists and restores prompt-cache snapshot state", () => {
    const harness = createHarness();
    harness.runtime.state.transcript.conversationHistory = [
      { role: "user", content: "Resume the cached session" },
    ];
    harness.runtime.state.promptCache = {
      stableSystemBlocks: [
        {
          text: "Stable instructions",
          scope: "session",
          cacheable: true,
          stableKey: "identity:abc",
        },
      ],
      stablePrefixHash: "prefix-hash",
      toolSchemaHash: "tool-hash",
      promptCacheMode: "anthropic_auto",
      promptCacheProviderFamily: "anthropic",
      promptCacheInvalidationReason: "stable_prefix_changed",
    };

    harness.runtime.saveSnapshot();

    const snapshotEvent = harness.emittedEvents.find(
      (event) => event.type === "conversation_snapshot",
    );
    expect(snapshotEvent?.payload.promptCache).toEqual({
      stableSystemBlocks: [
        {
          text: "Stable instructions",
          scope: "session",
          cacheable: true,
          stableKey: "identity:abc",
        },
      ],
      stablePrefixHash: "prefix-hash",
      toolSchemaHash: "tool-hash",
      promptCacheMode: "anthropic_auto",
      promptCacheProviderFamily: "anthropic",
      promptCacheInvalidationReason: "stable_prefix_changed",
    });

    const restoredHarness = createHarness();
    restoredHarness.runtime.restoreFromEvents([
      {
        type: "conversation_snapshot",
        payload: snapshotEvent?.payload,
      } as Any,
    ]);

    expect(restoredHarness.runtime.state.promptCache).toEqual({
      stableSystemBlocks: [
        {
          text: "Stable instructions",
          scope: "session",
          cacheable: true,
          stableKey: "identity:abc",
        },
      ],
      stablePrefixHash: "prefix-hash",
      toolSchemaHash: "tool-hash",
      promptCacheMode: "anthropic_auto",
      promptCacheProviderFamily: "anthropic",
      promptCacheInvalidationReason: "stable_prefix_changed",
    });
  });

  it("restores a legacy snapshot payload and backfills usage totals from llm_usage events", () => {
    const harness = createHarness();
    const events: Any[] = [
      {
        type: "conversation_snapshot",
        payload: {
          conversationHistory: [{ role: "user", content: "Original task context" }],
          planSummary: {
            description: "Investigate runtime",
            completedSteps: ["Read files"],
          },
        },
      },
      {
        type: "llm_usage",
        payload: {
          totals: {
            inputTokens: 12,
            outputTokens: 8,
            cost: 0.5,
          },
        },
      },
    ];

    harness.runtime.restoreFromEvents(events);

    const restoredFirstMessage = harness.runtime.getOutputState().conversationHistory[0];
    expect(typeof restoredFirstMessage?.content).toBe("string");
    expect(String(restoredFirstMessage?.content || "")).toContain("PREVIOUS TASK CONTEXT:");
    expect(harness.runtime.state.usage.totalInputTokens).toBe(12);
    expect(harness.runtime.state.usage.totalOutputTokens).toBe(8);
    expect(harness.emittedEvents.some((event) => event.type === "conversation_snapshot")).toBe(
      true,
    );
  });

  it("prefers a V2 snapshot over a legacy checkpoint payload when restoring", () => {
    const harness = createHarness();
    harness.setCheckpointPayload({
      conversationHistory: [{ role: "user", content: "legacy checkpoint" }],
    });

    harness.runtime.restoreFromEvents([
      {
        type: "conversation_snapshot",
        payload: createV2Snapshot(),
      } as Any,
    ]);

    expect(harness.runtime.getOutputState().lastUserMessage).toBe("v2 latest message");
    expect(harness.runtime.state.loop.lifetimeTurnCount).toBe(4);
    expect(harness.runtime.getOutputState().conversationHistory[0]?.content).toBe("v2 snapshot");
  });

  it("prefers a newer event snapshot over a stale V2 checkpoint", () => {
    const harness = createHarness();
    harness.setCheckpointPayload({
      ...createV2Snapshot({
        timestamp: 100,
        conversationHistory: [{ role: "user", content: "stale checkpoint" }],
      }),
      sourceEventId: "event-old",
      sourceTimestamp: 100,
    });

    harness.runtime.restoreFromEvents([
      {
        id: "event-new",
        taskId: "task-1",
        timestamp: 200,
        type: "conversation_snapshot",
        payload: createV2Snapshot({
          timestamp: 200,
          conversationHistory: [{ role: "user", content: "new snapshot" }],
        }),
        schemaVersion: 2,
        eventId: "event-new",
        seq: 2,
      } as Any,
    ]);

    expect(harness.runtime.getOutputState().conversationHistory[0]?.content).toBe("new snapshot");
  });

  it("keeps feedback state from the selected snapshot over older feedback events", () => {
    const harness = createHarness();
    const snapshot = createV2Snapshot({
      timestamp: 200,
      queues: {
        pendingFollowUps: [],
        stepFeedbackSignal: {
          feedbackId: "new-feedback",
          stepId: "step-1",
          action: "retry",
          message: "Retry the current step",
        },
      },
    });

    harness.runtime.restoreFromEvents([
      {
        id: "old-feedback",
        taskId: "task-1",
        timestamp: 100,
        type: "step_feedback",
        payload: {
          stepId: "step-1",
          action: "stop",
          message: "Stop here",
        },
        schemaVersion: 2,
        seq: 1,
      } as Any,
      {
        id: "new-snapshot",
        taskId: "task-1",
        timestamp: 200,
        type: "conversation_snapshot",
        payload: snapshot,
        schemaVersion: 2,
        eventId: "new-snapshot",
        seq: 2,
      } as Any,
    ]);

    expect(harness.runtime.state.queues.stepFeedbackSignal).toEqual(
      snapshot.queues.stepFeedbackSignal,
    );
  });

  it("replays unresolved step feedback after a restart", () => {
    const harness = createHarness();

    harness.runtime.restoreFromEvents([
      {
        id: "feedback-received",
        taskId: "task-1",
        timestamp: 100,
        type: "step_feedback",
        payload: {
          feedbackId: "feedback-1",
          stepId: "step-1",
          action: "retry",
          message: "Try the step again",
        },
        schemaVersion: 2,
        seq: 1,
      } as Any,
    ]);

    expect(harness.runtime.state.queues.stepFeedbackSignal).toEqual({
      feedbackId: "feedback-1",
      stepId: "step-1",
      action: "retry",
      message: "Try the step again",
    });
  });

  it("uses the legacy timeline feedback event when the runtime receipt was not persisted", () => {
    const harness = createHarness();

    harness.runtime.restoreFromEvents([
      {
        id: "feedback-timeline",
        taskId: "task-1",
        timestamp: 100,
        type: "timeline_step_updated",
        legacyType: "step_feedback" as Any,
        payload: {
          stepId: "step-1",
          action: "skip",
          message: "Skip this step",
        },
        schemaVersion: 2,
        seq: 1,
      } as Any,
    ]);

    expect(harness.runtime.state.queues.stepFeedbackSignal).toMatchObject({
      stepId: "step-1",
      action: "skip",
      message: "Skip this step",
    });
  });

  it("does not replay feedback after a durable consumed marker", () => {
    const harness = createHarness();

    harness.runtime.restoreFromEvents([
      {
        id: "feedback-received",
        taskId: "task-1",
        timestamp: 100,
        type: "step_feedback",
        payload: {
          feedbackId: "feedback-1",
          stepId: "step-1",
          action: "stop",
          message: "Stop here",
        },
        schemaVersion: 2,
        seq: 1,
      } as Any,
      {
        id: "feedback-consumed",
        taskId: "task-1",
        timestamp: 110,
        type: "step_feedback",
        payload: {
          feedbackId: "feedback-1",
          stepId: "step-1",
          action: "stop",
          message: "Stop here",
          consumed: true,
          feedbackSignature: "step-1\u0000stop\u0000Stop here",
        },
        schemaVersion: 2,
        seq: 2,
      } as Any,
    ]);

    expect(harness.runtime.state.queues.stepFeedbackSignal).toBeNull();
  });

  it("rebuilds a summary transcript when no snapshot payload is available", () => {
    const harness = createHarness();

    harness.runtime.restoreFromEvents([
      { type: "user_message", payload: { message: "Need a fix" } },
      { type: "assistant_message", payload: { message: "Investigating now" } },
    ] as Any);

    const messages = harness.runtime.getOutputState().conversationHistory;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(String(messages[0].content)).toContain("Previous conversation summary:");
    expect(messages[1].role).toBe("assistant");
  });

  it("owns verification and worker session-local state", () => {
    const harness = createHarness();

    harness.runtime.recordVerificationEvidence({
      stepId: "step-1",
      status: "pass",
      summary: "ok",
      timestamp: Date.now(),
    } as Any);
    harness.runtime.addBlockingVerificationFailedStep("step-1");
    harness.runtime.markDispatchedMentionedAgents();
    harness.runtime.setVerificationAgentState({ verdict: "PASS" });

    expect(harness.runtime.getVerificationState().verificationEvidenceEntries).toHaveLength(1);
    expect(
      harness.runtime.getVerificationState().blockingVerificationFailedStepIds.has("step-1"),
    ).toBe(true);
    expect(harness.runtime.getVerificationState().dispatchedMentionedAgents).toBe(true);
    expect(harness.runtime.getVerificationState().verificationAgentState).toEqual({
      verdict: "PASS",
    });

    harness.runtime.resetVerificationState();

    expect(harness.runtime.getVerificationState().verificationEvidenceEntries).toHaveLength(0);
    expect(harness.runtime.getVerificationState().blockingVerificationFailedStepIds.size).toBe(0);
    expect(harness.runtime.getVerificationState().dispatchedMentionedAgents).toBe(false);
    expect(harness.runtime.getVerificationState().verificationAgentState).toEqual({});
  });

  it("owns recovery session-local state", () => {
    const harness = createHarness();

    harness.runtime.setRecoveryRequestActive(true);
    harness.runtime.setRecoveryFailureSignature("step-1|failed");
    harness.runtime.markRecoveredFailureStep("step-1");
    harness.runtime.setRecoveryClass("local_runtime");
    harness.runtime.setToolDisabledScope("provider");
    harness.runtime.setRetryReason("retry_started");

    const recoveryState = harness.runtime.getRecoveryState();
    expect(recoveryState.recoveryRequestActive).toBe(true);
    expect(recoveryState.lastRecoveryFailureSignature).toBe("step-1|failed");
    expect(recoveryState.recoveredFailureStepIds.has("step-1")).toBe(true);
    expect(recoveryState.lastRecoveryClass).toBe("local_runtime");
    expect(recoveryState.lastToolDisabledScope).toBe("provider");
    expect(recoveryState.lastRetryReason).toBe("retry_started");

    harness.runtime.clearRecoveryFailureSignature();
    harness.runtime.clearRecoveredFailureStep("step-1");
    harness.runtime.resetRecoveryState();

    const resetState = harness.runtime.getRecoveryState();
    expect(resetState.recoveryRequestActive).toBe(false);
    expect(resetState.lastRecoveryFailureSignature).toBe("");
    expect(resetState.recoveredFailureStepIds.size).toBe(0);
    expect(resetState.lastRecoveryClass).toBeNull();
    expect(resetState.lastToolDisabledScope).toBeNull();
    expect(resetState.lastRetryReason).toBeNull();
  });

  it("creates, updates, and lists a session checklist while preserving ids", () => {
    const harness = createHarness();

    const created = harness.runtime.createTaskList([
      { title: "Inspect code", status: "completed" },
      { title: "Implement fix", status: "in_progress" },
    ]);
    expect(created.items).toHaveLength(2);
    expect(created.items[0]?.kind).toBe("implementation");
    expect(harness.runtime.getTaskListState().items[1]?.status).toBe("in_progress");

    const preservedId = created.items[0]?.id;
    const updated = harness.runtime.updateTaskList([
      { id: preservedId, title: "Inspect code", status: "completed" },
      { title: "Verify fix", kind: "verification", status: "pending" },
    ]);

    expect(updated.items[0]?.id).toBe(preservedId);
    expect(updated.items[1]?.kind).toBe("verification");
    expect(updated.verificationNudgeNeeded).toBe(false);
  });

  it("treats repeated checklist creation as an update while preserving matching item ids", () => {
    const harness = createHarness();

    const created = harness.runtime.createTaskList([
      { title: "Inspect code", status: "completed" },
      { title: "Implement fix", status: "in_progress" },
    ]);
    const preservedId = created.items[0]?.id;

    const recreated = harness.runtime.createTaskList([
      { title: "Inspect code", status: "completed" },
      { title: "Verify fix", kind: "verification", status: "pending" },
    ]);

    expect(recreated.items[0]?.id).toBe(preservedId);
    expect(recreated.items[1]?.title).toBe("Verify fix");
    expect(recreated.items[1]?.kind).toBe("verification");
  });

  it("rejects invalid checklist mutations", () => {
    const harness = createHarness();

    expect(() => harness.runtime.createTaskList([])).toThrow(/at least one item/i);

    expect(() =>
      harness.runtime.createTaskList([
        { id: "dup", title: "One", status: "pending" },
        { id: "dup", title: "Two", status: "pending" },
      ]),
    ).toThrow(/duplicate item id/i);

    expect(() =>
      harness.runtime.createTaskList([
        { title: "One", status: "in_progress" },
        { title: "Two", status: "in_progress" },
      ]),
    ).toThrow(/at most one item with status in_progress/i);
  });

  it("round-trips checklist state through V2 snapshot payloads", () => {
    const sourceHarness = createHarness();
    const created = sourceHarness.runtime.createTaskList([
      { title: "Implement", status: "completed" },
      { title: "Verify", kind: "verification", status: "pending" },
    ]);
    const restoreHarness = createHarness();

    restoreHarness.runtime.restoreFromEvents([
      {
        type: "conversation_snapshot",
        payload: createV2Snapshot({ checklist: created }),
      } as Any,
    ]);

    expect(restoreHarness.runtime.getTaskListState()).toEqual(created);
  });

  it("restores checklist state from snapshot payloads and checklist events", () => {
    const harness = createHarness();
    harness.runtime.restoreFromEvents([
      {
        type: "conversation_snapshot",
        payload: createV2Snapshot({
          checklist: {
            items: [
              {
                id: "item-1",
                title: "Recovered",
                kind: "implementation",
                status: "completed",
                createdAt: 10,
                updatedAt: 20,
              },
            ],
            updatedAt: 20,
            verificationNudgeNeeded: false,
            nudgeReason: null,
          },
        }),
      } as Any,
    ]);

    expect(harness.runtime.getTaskListState().items[0]?.title).toBe("Recovered");

    harness.runtime.restoreFromEvents([
      {
        type: "task_list_updated",
        payload: {
          checklist: {
            items: [
              {
                id: "item-2",
                title: "From event",
                kind: "verification",
                status: "pending",
                createdAt: 30,
                updatedAt: 40,
              },
            ],
            updatedAt: 40,
            verificationNudgeNeeded: false,
            nudgeReason: null,
          },
        },
      } as Any,
    ]);

    expect(harness.runtime.getTaskListState().items[0]?.title).toBe("From event");
    expect(harness.runtime.getTaskListState().items[0]?.kind).toBe("verification");
  });

  it("reuses rendered available tools when the render context is stable and invalidates on context change", () => {
    const harness = createHarness();
    const renderToolsForContext = vi.fn((tools: Any[]) =>
      tools.map((tool) => ({ ...tool, description: `${tool.description} rendered` })),
    );
    harness.setToolRegistry({
      getTools: vi.fn(() => [
        { name: "run_command", description: "Run command" },
        { name: "web_search", description: "Search web" },
      ]),
      getDeferredTools: vi.fn(() => []),
      getToolCatalogVersion: vi.fn(() => "catalog:v1"),
      renderToolsForContext,
      cleanup: vi.fn(async () => undefined),
    });

    const first = harness.runtime.getAvailableTools();
    const second = harness.runtime.getAvailableTools();

    expect(first[0]?.description).toContain("rendered");
    expect(second[0]?.description).toContain("rendered");
    expect(renderToolsForContext).toHaveBeenCalledTimes(1);

    harness.setExecutionMode("verified");
    harness.runtime.getAvailableTools();

    expect(renderToolsForContext).toHaveBeenCalledTimes(2);
  });

  it("invalidates available tools when the active step changes", () => {
    const harness = createHarness();
    const renderToolsForContext = vi.fn((tools: Any[]) => tools);
    harness.setToolRegistry({
      getTools: vi.fn(() => [
        { name: "run_command", description: "Run command" },
        { name: "web_search", description: "Search web" },
      ]),
      getDeferredTools: vi.fn(() => []),
      getToolCatalogVersion: vi.fn(() => "catalog:v1"),
      renderToolsForContext,
      cleanup: vi.fn(async () => undefined),
    });

    harness.runtime.getAvailableTools();
    harness.runtime.getAvailableTools();
    expect(renderToolsForContext).toHaveBeenCalledTimes(1);

    harness.runtime.state.loop.currentStepId = "step-1";
    harness.runtime.getAvailableTools();

    expect(renderToolsForContext).toHaveBeenCalledTimes(2);
  });

  it("restores pending slash-skill parameter collection from replay events", () => {
    const harness = createHarness();

    harness.runtime.restoreFromEvents([
      {
        type: "skill_parameter_collection_started",
        payload: {
          pending: {
            skillId: "novelist",
            skillName: "Novelist",
            trigger: "slash",
            parameters: { genre: "literary" },
            requiredParameterNames: ["seed"],
            currentParameterIndex: 0,
            startedAt: 1,
          },
        },
      } as Any,
      {
        type: "assistant_message",
        payload: { message: "I need one more detail for Novelist." },
      } as Any,
    ]);

    expect(harness.runtime.getPendingSkillParameterCollection()).toEqual(
      expect.objectContaining({
        skillId: "novelist",
        parameters: { genre: "literary" },
        requiredParameterNames: ["seed"],
      }),
    );
    expect(harness.runtime.hasHandledPrimarySlashCommand()).toBe(true);
  });

  it("triggers and clears the verification nudge under the expected conditions", () => {
    const harness = createHarness();

    const updated = harness.runtime.createTaskList([
      { title: "Implement fix", status: "completed" },
    ]);

    expect(updated.verificationNudgeNeeded).toBe(true);
    expect(
      harness.emittedEvents.some((event) => event.type === "task_list_verification_nudged"),
    ).toBe(true);

    const cleared = harness.runtime.updateTaskList([
      { id: updated.items[0]?.id, title: "Implement fix", status: "completed" },
      { title: "Run tests", kind: "verification", status: "pending" },
    ]);

    expect(cleared.verificationNudgeNeeded).toBe(false);
  });

  it("suppresses the verification nudge when plan verification or verified mode already covers it", () => {
    const harness = createHarness();
    harness.setPlan({
      description: "Plan",
      steps: [{ id: "verify", description: "Verify: run tests", status: "pending" }],
    });

    const withPlanVerification = harness.runtime.createTaskList([
      { title: "Implement fix", status: "completed" },
    ]);
    expect(withPlanVerification.verificationNudgeNeeded).toBe(false);

    const verifiedHarness = createHarness();
    verifiedHarness.setExecutionMode("verified");
    const inVerifiedMode = verifiedHarness.runtime.createTaskList([
      { title: "Implement fix", status: "completed" },
    ]);
    expect(inVerifiedMode.verificationNudgeNeeded).toBe(false);
  });
});
