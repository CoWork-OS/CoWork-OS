import { describe, expect, it, vi } from "vitest";

import type { LLMMessage } from "../../llm";
import {
  FileOperationTracker,
  ToolFailureTracker,
} from "../../executor-helpers";
import {
  SessionRuntime,
  type SessionRuntimeDeps,
  type SessionRuntimeSnapshotV2,
  type SessionRuntimeState,
} from "../SessionRuntime";

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
    setTaskDomain: (nextDomain: string) => {
      taskDomain = nextDomain;
    },
  };
}

describe("SessionRuntime", () => {
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

  it("writes conversation snapshots with the V2 runtime schema", () => {
    const harness = createHarness();
    harness.runtime.state.transcript.conversationHistory = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    harness.runtime.saveSnapshot({ description: "Plan summary" });

    const snapshotEvent = harness.emittedEvents.find((event) => event.type === "conversation_snapshot");
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

    const snapshotEvent = harness.emittedEvents.find((event) => event.type === "conversation_snapshot");
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
    expect(
      harness.emittedEvents.some((event) => event.type === "conversation_snapshot"),
    ).toBe(true);
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
    expect(harness.runtime.getVerificationState().blockingVerificationFailedStepIds.has("step-1")).toBe(true);
    expect(harness.runtime.getVerificationState().dispatchedMentionedAgents).toBe(true);
    expect(harness.runtime.getVerificationState().verificationAgentState).toEqual({ verdict: "PASS" });

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
