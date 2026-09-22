import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { DurableContextService } from "../../memory/DurableContextService";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("../custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    getEnabledGuidelinesPrompt: () => "",
    rankModelInvocableSkillsForQuery: () => [],
  }),
}));

vi.mock("../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: {
    loadSettings: vi.fn().mockReturnValue({ contextPackInjectionEnabled: false }),
  },
}));

vi.mock("../../memory/DurableContextService", () => ({
  DurableContextService: {
    recordHistory: vi.fn(),
  },
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue(""),
    getPersonalityPromptById: vi.fn().mockReturnValue(""),
    getIdentityPrompt: vi.fn().mockReturnValue(""),
  },
}));

describe("TaskExecutor chat mode", () => {
  it.each([false, true])(
    "incorporates queued chat before provider execution (snapshot fails=%s)",
    async (fails) => {
      const executor = Object.create(TaskExecutor.prototype) as Any;
      executor.task = {
        id: "queued-chat",
        agentConfig: { executionMode: "chat", retainMemory: false },
      };
      executor.provider = { type: "openai" };
      executor.conversationHistory = [];
      executor.buildUserProfileBlock = () => "";
      executor.getRoleContextPrompt = () => "";
      executor.getEffectiveExecutionMode = () => "chat";
      executor.getEffectiveTaskDomain = () => "general";
      executor.isExplicitChatExecutionMode = () => true;
      executor.buildChatOrThinkSystemBlocks = () => [];
      executor.setPromptCacheContext = () => "system";
      executor.buildExplicitChatMessages = async () => [{ role: "user", content: "Queued chat" }];
      executor.buildUserContent = async (message: string) => [{ type: "text", text: message }];
      executor.appendConversationHistory = (message: Any) =>
        executor.conversationHistory.push(message);
      executor.updateConversationHistory = (messages: Any[]) => {
        executor.conversationHistory = messages;
      };
      executor.resolveLLMMaxTokens = () => 1024;
      executor.emitEvent = vi.fn();
      executor.saveConversationSnapshot = vi.fn(() => true);
      executor.finalizeFollowUpCompletion = vi.fn();
      executor.generateCompanionFallbackResponse = () => "fallback";
      executor.restoreFollowUpStatusAfterFailure = vi.fn();
      executor.runTextTurnKernel = vi.fn(async () => ({
        assistantText: "Done",
        messages: [
          { role: "user", content: "Queued chat" },
          { role: "assistant", content: "Done" },
        ],
      }));
      const onIncorporated = vi.fn(async () => {
        expect(executor.conversationHistory).toEqual([
          { role: "user", content: [{ type: "text", text: "Queued chat" }] },
        ]);
        expect(executor.runTextTurnKernel).not.toHaveBeenCalled();
        if (fails) throw new Error("snapshot unavailable");
      });
      const turn = executor.respondInChatMode("Queued chat", undefined, undefined, onIncorporated);
      if (fails) {
        await expect(turn).rejects.toThrow("snapshot unavailable");
        expect(executor.runTextTurnKernel).not.toHaveBeenCalled();
        expect(executor.emitEvent).not.toHaveBeenCalledWith("assistant_message", expect.anything());
      } else {
        await turn;
        expect(executor.runTextTurnKernel).toHaveBeenCalledTimes(1);
      }
      expect(onIncorporated).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "does not persist temporary overrides when a turn fails=%s",
    async (fails) => {
      const executor = Object.create(TaskExecutor.prototype) as Any;
      const stored = {
        agentConfig: { interactionMode: { mode: "smart" }, accessProfileId: "read_only" },
      } as Any;
      const override = { autonomousMode: true, toolRestrictions: ["shell"] };
      executor.task = { id: "temporary", agentConfig: { ...stored.agentConfig, ...override } };
      executor.daemon = {
        getTask: () => stored,
        updateTask: (_id: string, patch: Any) => {
          stored.agentConfig = patch.agentConfig;
        },
      };
      executor.getLifecycleMutex = () => ({ runExclusive: (fn: Any) => fn() });
      executor.isAcpxExternalRuntimeTask = () => false;
      executor.updateTaskAgentConfig = (config: Any) => {
        executor.task.agentConfig = config;
      };
      executor.sendMessageUnified = async () => {
        expect(executor.task.agentConfig).toMatchObject(override);
        if (fails) throw new Error("turn failed");
      };
      const turn = executor.sendMessage("Discuss this", undefined, undefined, {
        interactionMode: { mode: "chat" },
        agentConfigOverride: override,
      });
      if (fails) await expect(turn).rejects.toThrow("turn failed");
      else await turn;
      expect(stored.agentConfig.autonomousMode).toBeUndefined();
      expect(stored.agentConfig.toolRestrictions).toBeUndefined();
      expect(stored.agentConfig.interactionMode).toEqual({ mode: "chat" });
      expect(stored.agentConfig.accessProfileId).toBe("read_only");
      expect(executor.task.agentConfig).toEqual(stored.agentConfig);
    },
  );

  it("includes follow-up images in the explicit Chat model messages", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.provider = { type: "openai" };
    executor.conversationHistory = [];
    const messages = await executor.buildExplicitChatMessages("Describe this", "system", [
      { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
    ]);
    expect(messages.at(-1).content).toEqual(
      expect.arrayContaining([
        { type: "text", text: "Describe this" },
        expect.objectContaining({ type: "image", data: "aGVsbG8=", mimeType: "image/png" }),
      ]),
    );
  });
  it("applies a follow-up selection before routing and persists it", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { id: "mode-turn", agentConfig: { executionMode: "plan" } };
    executor.isAcpxExternalRuntimeTask = () => false;
    executor.updateTaskAgentConfig = vi.fn((config) => {
      executor.task.agentConfig = config;
    });
    executor.daemon = { updateTask: vi.fn() };
    executor.sendMessageUnified = vi.fn(async () => {
      expect(executor.task.agentConfig.executionMode).toBe("chat");
    });
    await executor.sendMessageUnlocked("Discuss this", undefined, undefined, {
      interactionMode: { mode: "chat" },
    });
    expect(executor.daemon.updateTask).toHaveBeenCalledWith("mode-turn", {
      agentConfig: expect.objectContaining({
        interactionMode: { mode: "chat" },
        executionMode: "chat",
      }),
    });
  });
  it("keeps interactive Chat in Chat even with execution requests and PDF paths", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      agentConfig: {
        interactionMode: { mode: "chat" },
        executionMode: "chat",
        executionModeSource: "user",
        conversationMode: "chat",
      },
    };
    executor.hasUploadedPdfAttachmentContext = () => true;
    expect(executor.shouldUseReadOnlyPdfAttachmentMode()).toBe(false);
    expect(executor.resolveConversationMode("Run npm install")).toBe("chat");
    expect(executor.getEffectiveExecutionMode()).toBe("chat");
  });
  const createInferredChatExecutor = (
    prompt: string,
    agentConfig: Record<string, unknown> = {},
  ) => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-inferred-chat",
      title: prompt,
      prompt,
      userPrompt: prompt,
      rawPrompt: prompt,
      createdAt: Date.now(),
      agentConfig: {
        executionMode: "execute",
        executionModeSource: "strategy",
        conversationMode: "chat",
        taskIntent: "chat",
        ...agentConfig,
      },
    };
    return executor;
  };

  const createExecuteUnlockedRoutingExecutor = (
    prompt: string,
    agentConfig: Record<string, unknown> = {},
  ) => {
    const executor = createInferredChatExecutor(prompt, agentConfig);
    executor.workspace = {
      id: "ws-routing",
      path: "/tmp",
      isTemp: true,
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
    };
    executor.daemon = {
      updateTaskStatus: vi.fn(),
      updateTask: vi.fn(),
      getTransientRetryCount: vi.fn().mockReturnValue(0),
    };
    executor.toolRegistry = {
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
    executor.emitEvent = vi.fn();
    executor.handleCompanionPrompt = vi.fn().mockResolvedValue(undefined);
    executor.maybeHandleExplicitClaudeCodeDelegation = vi.fn().mockResolvedValue(false);
    executor.maybeHandleOnboardingSlashCommand = vi.fn().mockResolvedValue(false);
    executor.maybePrepareInitialGoalSlashCommand = vi.fn().mockResolvedValue(false);
    executor.maybeHandleScheduleSlashCommand = vi.fn().mockResolvedValue(false);
    executor.maybeHandleSkillSlashCommandOrInlineChain = vi.fn().mockResolvedValue(false);
    executor.maybeHandleNaturalLlmWikiPrompt = vi.fn().mockResolvedValue(undefined);
    executor.maybeAutoApplyExplicitSkillInvocation = vi.fn().mockResolvedValue(undefined);
    executor.maybeHandleHighConfidenceSkillRouting = vi.fn().mockResolvedValue(undefined);
    executor.analyzeTask = vi.fn().mockResolvedValue({ complexity: "simple" });
    executor.ensureVerificationOutcomeSets = vi.fn();
    executor.getBudgetConstrainedFailureStepIdSet = vi.fn().mockReturnValue(new Set());
    executor.nonBlockingVerificationFailedStepIds = new Set();
    executor.blockingVerificationFailedStepIds = new Set();
    executor.stepStopReasons = new Map();
    executor.taskFailureDomains = new Set();
    executor.completionVerificationMetadata = null;
    executor.terminalStatus = "ok";
    executor.failureClass = undefined;
    executor.cancelled = false;
    executor.lastUserMessage = prompt;
    executor.cancelReason = undefined;
    return executor;
  };

  it("records executor conversation history into durable context", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { id: "task-durable-history" };
    executor.workspace = {
      id: "ws-durable-history",
      path: "/tmp",
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
    };
    vi.mocked(DurableContextService.recordHistory).mockClear();

    (TaskExecutor as Any).prototype.updateConversationHistory.call(executor, [
      { role: "user", content: "Project codename: Lantern Harbor" },
      { role: "assistant", content: [{ type: "text", text: "Rollback phrase: blue anchor" }] },
    ]);

    expect(DurableContextService.recordHistory).toHaveBeenCalledWith({
      workspaceId: "ws-durable-history",
      taskId: "task-durable-history",
      source: "executor_history",
      messages: [
        { role: "user", content: "Project codename: Lantern Harbor" },
        { role: "assistant", content: [{ type: "text", text: "Rollback phrase: blue anchor" }] },
      ],
    });
    expect(executor.conversationHistory).toHaveLength(2);
  });

  it("promotes explicit chat PDF attachment turns to read-only analysis mode", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-chat-pdf",
      title: "PDF chat",
      prompt: [
        "Summarize this PDF",
        "",
        "Attached files (relative to workspace):",
        "- report.pdf (.cowork/uploads/123/report.pdf)",
        "  Extracted content:",
        "    PDF attachment: report.pdf",
        "    Path: .cowork/uploads/123/report.pdf",
      ].join("\n"),
      userPrompt: "Summarize this PDF",
      rawPrompt: "Summarize this PDF",
      createdAt: Date.now(),
      agentConfig: {
        executionMode: "chat",
        executionModeSource: "user",
        conversationMode: "hybrid",
      },
    };

    expect((TaskExecutor as Any).prototype.getEffectiveExecutionMode.call(executor)).toBe(
      "analyze",
    );
    expect((TaskExecutor as Any).prototype.getEffectiveExecutionModeSource.call(executor)).toBe(
      "auto_promote",
    );
    expect((TaskExecutor as Any).prototype.isExplicitChatExecutionMode.call(executor)).toBe(false);
  });

  it("injects live parent status as a turn-scoped sidechat system block", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "side-task",
      source: "side_chat",
      branchLabel: "side-chat",
      agentConfig: {
        conversationMode: "chat",
        executionMode: "chat",
        sideChatTurnContext: "LIVE_PARENT_STATUS\nParent task status: executing",
      },
    };
    executor.workspace = { path: "/tmp" };

    const blocks = (TaskExecutor as Any).prototype.buildChatOrThinkSystemBlocks.call(
      executor,
      false,
      {
        identityPrompt: "",
        roleContext: "",
        profileContext: "",
        personalityPrompt: "",
        extraChatRules: [],
      },
    );

    expect(blocks.some((block: Any) => block.text.includes("LIVE_PARENT_STATUS"))).toBe(true);
    expect(blocks.some((block: Any) => block.text.includes("authoritative for progress"))).toBe(
      true,
    );
  });

  it("returns a single chat response without entering the task pipeline", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const companionPrompt = vi.fn().mockResolvedValue(undefined);
    const schedule = vi.fn().mockResolvedValue(false);
    const skillRouting = vi.fn().mockResolvedValue(false);
    const highConfidenceRouting = vi.fn().mockResolvedValue(false);

    executor.task = {
      id: "task-chat",
      title: "Who are you?",
      prompt: "Who are you?",
      userPrompt: "Who are you?",
      rawPrompt: "Who are you?",
      createdAt: Date.now(),
      agentConfig: {
        executionMode: "chat",
        conversationMode: "hybrid",
      },
    };
    executor.workspace = {
      id: "ws-chat",
      path: "/tmp",
      isTemp: true,
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
    };
    executor.daemon = {
      updateTaskStatus: vi.fn(),
      updateTask: vi.fn(),
    };
    executor.toolRegistry = {
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
    executor.emitEvent = vi.fn();
    executor.handleCompanionPrompt = companionPrompt;
    executor.maybeHandleScheduleSlashCommand = schedule;
    executor.maybeHandleSkillSlashCommandOrInlineChain = skillRouting;
    executor.maybeHandleHighConfidenceSkillRouting = highConfidenceRouting;
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("chat");
    executor.ensureVerificationOutcomeSets = vi.fn();
    executor.getBudgetConstrainedFailureStepIdSet = vi.fn().mockReturnValue(new Set());
    executor.nonBlockingVerificationFailedStepIds = new Set();
    executor.blockingVerificationFailedStepIds = new Set();
    executor.stepStopReasons = new Map();
    executor.taskFailureDomains = new Set();
    executor.completionVerificationMetadata = null;
    executor.terminalStatus = "ok";
    executor.failureClass = undefined;
    executor.cancelled = false;
    executor.lastUserMessage = "Who are you?";
    executor.cancelReason = undefined;
    executor.daemon.updateTaskStatus.mockClear();

    await (TaskExecutor as Any).prototype.executeUnlocked.call(executor);

    expect(companionPrompt).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    expect(skillRouting).not.toHaveBeenCalled();
    expect(highConfidenceRouting).not.toHaveBeenCalled();
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({
        reason: "initial_companion_prompt",
        explicitChat: true,
      }),
    );
  });

  it("does not treat inferred chat intent as explicit chat mode", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      id: "task-inferred-chat",
      title: "hello",
      prompt: "hello",
      userPrompt: "hello",
      rawPrompt: "hello",
      createdAt: Date.now(),
      agentConfig: {
        executionMode: "execute",
        executionModeSource: "strategy",
        conversationMode: "chat",
        taskIntent: "chat",
      },
    };

    expect((TaskExecutor as Any).prototype.isExplicitChatExecutionMode.call(executor)).toBe(false);
    expect(
      (TaskExecutor as Any).prototype.shouldHandleInitialPromptAsCompanion.call(executor, "hello"),
    ).toBe(true);

    executor.shouldEmitAnswerFirst = vi.fn().mockReturnValue(true);
    executor.hasDirectAnswerReady = vi.fn().mockReturnValue(true);
    executor.promptRequestsArtifactOutput = vi.fn().mockReturnValue(false);
    executor.isLikelyTaskRequest = vi.fn().mockReturnValue(false);

    expect(
      (TaskExecutor as Any).prototype.shouldShortCircuitSimpleNonExecuteAnswer.call(executor),
    ).toBe(false);
  });

  it("does not route local walking errand prompts through companion mode", () => {
    const prompt =
      "My kid just fell into the duck pond and the wedding starts in 30 minutes. Where can I walk and buy her a new dress?";
    const executor = createInferredChatExecutor(prompt, {
      conversationMode: "chat",
      taskIntent: "chat",
    });

    expect(
      (TaskExecutor as Any).prototype.shouldHandleInitialPromptAsCompanion.call(executor, prompt),
    ).toBe(false);
  });

  it("prefers the latest follow-up assistant text over stale prior summaries", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      id: "task-follow-up-summary",
      title: "Research Analyst run",
      prompt: "Research prompt",
      resultSummary: "Research Analyst - Awaiting Input",
    };
    executor.bestKnownOutcome = {
      resultSummary: "Yo! What's up? How can I help you today?",
    };
    executor.lastNonVerificationOutput = "Research Analyst - Awaiting Input";
    executor.lastAssistantOutput = "Research Analyst - Awaiting Input";
    executor.lastAssistantText =
      "Premier League fixtures: Liverpool vs Chelsea; Brentford vs Manchester City.";
    executor.getContentFallback = vi.fn().mockReturnValue("");

    expect((TaskExecutor as Any).prototype.buildFollowUpResultSummary.call(executor)).toBe(
      "Premier League fixtures: Liverpool vs Chelsea; Brentford vs Manchester City.",
    );
  });

  it("prefers the latest persisted follow-up assistant message over stale assistant text", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      id: "task-follow-up-history-summary",
      title: "Persistent goal",
      prompt: "Track release blockers",
      resultSummary: "Release blocker analysis from the prior run.",
    };
    executor.bestKnownOutcome = {
      resultSummary: "Older best-known release blocker summary.",
    };
    executor.conversationHistory = [
      { role: "user", content: [{ type: "text", text: "/goal status" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Goal active.\n\nObjective: Track release blockers" }],
      },
    ];
    executor.lastAssistantText = "A stale assistant reply from before the follow-up.";
    executor.lastNonVerificationOutput = "Goal active.\n\nObjective: Track release blockers";
    executor.lastAssistantOutput = "Goal active.\n\nObjective: Track release blockers";
    executor.getContentFallback = vi.fn().mockReturnValue("");

    expect((TaskExecutor as Any).prototype.buildFollowUpResultSummary.call(executor)).toBe(
      "Goal active.\n\nObjective: Track release blockers",
    );
  });

  it("keeps local goal follow-up messages aligned with last assistant text", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      id: "task-goal-follow-up",
      title: "Persistent goal",
      prompt: "Track release blockers",
    };
    executor.workspace = {
      id: "ws-goal-follow-up",
      path: "/tmp",
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
    };
    executor.emitEvent = vi.fn();

    (TaskExecutor as Any).prototype.emitGoalAssistantMessage.call(
      executor,
      "/goal status",
      "Goal active.\n\nObjective: Track release blockers",
    );

    expect(executor.lastAssistantText).toBe("Goal active.\n\nObjective: Track release blockers");
    expect((TaskExecutor as Any).prototype.buildFollowUpResultSummary.call(executor)).toBe(
      "Goal active.\n\nObjective: Track release blockers",
    );
  });

  it("does not route inferred chat live-lookup prompts through companion mode", () => {
    const executor = createInferredChatExecutor(
      "please tell me which football clubs have games tomorrow in premier league",
    );

    expect(
      (TaskExecutor as Any).prototype.shouldHandleInitialPromptAsCompanion.call(
        executor,
        "please tell me which football clubs have games tomorrow in premier league",
      ),
    ).toBe(false);
  });

  it("keeps ambiguous inferred chat prompts in the normal executor path", () => {
    const prompts = [
      "are there premier league games tomorrow",
      "weather in paris today",
      "is apple stock up today",
      "/schedule tomorrow remind me to send the report",
      "/goal keep an eye on deploy health",
      "/skill pdf summarize report.pdf",
      "Use the Codex CLI Agent skill to review this change",
      "answer_first=true explain the tradeoffs before planning",
      "summarize report.pdf",
      "describe this image",
      "Attached files:\n- photo.png\nWhat is in this image?",
      "PDF attachment: report.pdf\nPath: .cowork/uploads/123/report.pdf\nSummarize it",
    ];

    for (const prompt of prompts) {
      const executor = createInferredChatExecutor(prompt);

      expect(
        (TaskExecutor as Any).prototype.shouldHandleInitialPromptAsCompanion.call(executor, prompt),
      ).toBe(false);
    }
  });

  it("keeps external runtime tasks out of inferred companion routing", () => {
    const executor = createInferredChatExecutor("hello", {
      externalRuntime: {
        kind: "acpx",
        agent: "claude",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
    });

    expect(
      (TaskExecutor as Any).prototype.shouldHandleInitialPromptAsCompanion.call(executor, "hello"),
    ).toBe(false);
  });

  it("keeps explicit chat ACP tasks on the external runtime path", async () => {
    const executor = createExecuteUnlockedRoutingExecutor("hello", {
      executionMode: "chat",
      executionModeSource: "user",
      conversationMode: "hybrid",
      externalRuntime: {
        kind: "acpx",
        agent: "claude",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
    });
    executor.executeWithAcpxRuntime = vi.fn().mockResolvedValue(undefined);

    await (TaskExecutor as Any).prototype.executeUnlocked.call(executor);

    expect(executor.executeWithAcpxRuntime).toHaveBeenCalledWith("hello");
    expect(executor.handleCompanionPrompt).not.toHaveBeenCalled();
    expect(executor.maybeHandleScheduleSlashCommand).not.toHaveBeenCalled();
  });

  it("keeps slash commands on the executor entrypoint path", async () => {
    const executor = createExecuteUnlockedRoutingExecutor(
      "/schedule tomorrow remind me to send the report",
    );
    executor.maybeHandleScheduleSlashCommand = vi.fn().mockResolvedValue(true);

    await (TaskExecutor as Any).prototype.executeUnlocked.call(executor);

    expect(executor.handleCompanionPrompt).not.toHaveBeenCalled();
    expect(executor.maybeHandleScheduleSlashCommand).toHaveBeenCalledTimes(1);
    expect(executor.analyzeTask).not.toHaveBeenCalled();
  });

  it("only exposes the last non-verification step as an assistant bubble", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.plan = {
      description: "Hello plan",
      steps: [
        { id: "1", description: "Interpret the task as a simple chat greeting.", kind: "primary" },
        { id: "2", description: "Draft a concise reply.", kind: "primary" },
        { id: "3", description: "Send the greeting response.", kind: "primary" },
        {
          id: "4",
          description: "Verify: confirm the reply includes a greeting and help offer.",
          kind: "verification",
        },
      ],
    };

    expect(
      (TaskExecutor as Any).prototype.isLastVisibleAssistantStep.call(
        executor,
        executor.plan.steps[0],
      ),
    ).toBe(false);
    expect(
      (TaskExecutor as Any).prototype.isLastVisibleAssistantStep.call(
        executor,
        executor.plan.steps[1],
      ),
    ).toBe(false);
    expect(
      (TaskExecutor as Any).prototype.isLastVisibleAssistantStep.call(
        executor,
        executor.plan.steps[2],
      ),
    ).toBe(true);
    expect(
      (TaskExecutor as Any).prototype.isLastVisibleAssistantStep.call(
        executor,
        executor.plan.steps[3],
      ),
    ).toBe(false);
  });

  it("uses the 48K cap for explicit chat sessions", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const createMessageWithTimeout = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "reply" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    executor.task = {
      id: "task-chat-cap",
      title: "Chat session",
      prompt: "Say hello",
      userPrompt: "Say hello",
      rawPrompt: "Say hello",
      createdAt: Date.now(),
      agentConfig: {
        executionMode: "chat",
        conversationMode: "hybrid",
      },
    };
    executor.workspace = {
      id: "ws-chat-cap",
      path: "/tmp",
      isTemp: true,
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
    };
    executor.daemon = {
      updateTaskStatus: vi.fn(),
      updateTask: vi.fn(),
    };
    executor.emitEvent = vi.fn();
    executor.buildChatOrThinkSystemPrompt = vi.fn().mockReturnValue("system prompt");
    executor.getRoleContextPrompt = vi.fn().mockReturnValue("");
    executor.buildUserProfileBlock = vi.fn().mockReturnValue("");
    executor.buildUserContent = vi.fn().mockResolvedValue("Say hello");
    executor.callLLMWithRetry = vi.fn(async (fn: Any) => fn());
    executor.createMessageWithTimeout = createMessageWithTimeout;
    executor.updateTracking = vi.fn();
    executor.extractTextFromLLMContent = vi.fn().mockReturnValue("reply");
    executor.updateConversationHistory = vi.fn();
    executor.saveConversationSnapshot = vi.fn();
    executor.finalizeTaskBestEffort = vi.fn();
    executor.capturePlaybookOutcome = vi.fn();
    executor.generateCompanionFallbackResponse = vi.fn().mockReturnValue("fallback");
    executor.getCumulativeInputTokens = vi.fn().mockReturnValue(0);
    executor.getCumulativeOutputTokens = vi.fn().mockReturnValue(0);
    executor.taskCompleted = false;
    executor.cancelled = false;

    await (TaskExecutor as Any).prototype.handleCompanionPrompt.call(executor);

    expect(createMessageWithTimeout).toHaveBeenCalled();
    expect(createMessageWithTimeout.mock.calls[0][0].maxTokens).toBe(48_000);
  });

  it("replaces unexecuted tool-call syntax in chat streaming events", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.cancelled = false;
    executor.taskCompleted = false;
    executor.emitEvent = vi.fn();
    executor.getCumulativeInputTokens = vi.fn().mockReturnValue(0);
    executor.getCumulativeOutputTokens = vi.fn().mockReturnValue(0);

    const onStreamProgress = (TaskExecutor as Any).prototype.createLlmStreamingProgressHandler.call(
      executor,
      {
        suppressUnexecutedToolCallText: true,
        fallbackText: "I could not complete that chat response.",
      },
    );
    const progress = (text: string, streaming = true) =>
      onStreamProgress({
        inputTokens: 1,
        outputTokens: 1,
        outputChars: text.length,
        elapsedMs: 10,
        streaming,
        text,
      });

    progress("I will check.");
    progress('I will check. search_web:0{"queries":[]}');
    progress('I will check. search_web:0{"queries":[]}', false);

    const streamingEvents = executor.emitEvent.mock.calls
      .filter(([type]: [string]) => type === "llm_streaming")
      .map(([, payload]: [string, Any]) => payload);
    expect(streamingEvents[0].text).toBe("I will check.");
    expect(
      streamingEvents
        .slice(1)
        .every((payload: Any) => payload.text === "I could not complete that chat response."),
    ).toBe(true);
    expect(
      streamingEvents.some((payload: Any) => String(payload.text).includes("search_web:0")),
    ).toBe(false);
  });

  it("does not emit or persist an unexecuted tool call from a companion response", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const fakeToolText = 'I will check. search_web:0{"queries":["fixtures"]}';
    const createMessageWithTimeout = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: fakeToolText }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const updateConversationHistory = vi.fn();

    executor.task = {
      id: "task-companion-fake-tool",
      title: "Fixture lookup",
      prompt: "Which fixtures are scheduled tomorrow?",
      userPrompt: "Which fixtures are scheduled tomorrow?",
      rawPrompt: "Which fixtures are scheduled tomorrow?",
      createdAt: Date.now(),
      agentConfig: {
        executionMode: "chat",
        executionModeSource: "user",
        conversationMode: "chat",
      },
    };
    executor.workspace = {
      id: "ws-companion-fake-tool",
      path: "/tmp",
      isTemp: true,
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
    };
    executor.daemon = { updateTaskStatus: vi.fn(), updateTask: vi.fn() };
    executor.emitEvent = vi.fn();
    executor.getRoleContextPrompt = vi.fn().mockReturnValue("");
    executor.buildUserProfileBlock = vi.fn().mockReturnValue("");
    executor.buildUserContent = vi.fn().mockResolvedValue(executor.task.prompt);
    executor.callLLMWithRetry = vi.fn(async (fn: Any) => fn());
    executor.createMessageWithTimeout = createMessageWithTimeout;
    executor.updateTracking = vi.fn();
    executor.extractTextFromLLMContent = vi.fn().mockReturnValue(fakeToolText);
    executor.updateConversationHistory = updateConversationHistory;
    executor.saveConversationSnapshot = vi.fn();
    executor.finalizeTaskBestEffort = vi.fn();
    executor.capturePlaybookOutcome = vi.fn();
    executor.generateCompanionFallbackResponse = vi.fn().mockReturnValue("fallback");
    executor.getCumulativeInputTokens = vi.fn().mockReturnValue(0);
    executor.getCumulativeOutputTokens = vi.fn().mockReturnValue(0);
    executor.taskCompleted = false;
    executor.cancelled = false;

    await (TaskExecutor as Any).prototype.handleCompanionPrompt.call(executor);

    const assistantMessages = executor.emitEvent.mock.calls
      .filter(([type]: [string]) => type === "assistant_message")
      .map(([, payload]: [string, Any]) => String(payload.message));
    expect(assistantMessages).toEqual([expect.stringContaining("did not execute a tool")]);
    expect(assistantMessages.some((message: string) => message.includes("search_web:0"))).toBe(
      false,
    );
    expect(JSON.stringify(updateConversationHistory.mock.calls)).not.toContain("search_web:0");
  });

  it("reuses a cached explicit chat summary instead of regenerating it every turn", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const buildCompactionSummaryBlock = vi
      .fn()
      .mockResolvedValue("<cowork_compaction_summary>\nsummary\n</cowork_compaction_summary>");

    executor.conversationHistory = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `${index % 2 === 0 ? "User" : "Assistant"} turn ${index}` }],
    }));
    executor.buildCompactionSummaryBlock = buildCompactionSummaryBlock;
    executor.explicitChatSummaryBlock = null;
    executor.explicitChatSummaryCreatedAt = 0;
    executor.explicitChatSummarySourceMessageCount = 0;

    const first = await (TaskExecutor as Any).prototype.buildExplicitChatMessages.call(
      executor,
      "Follow up question",
      "system prompt",
    );
    const second = await (TaskExecutor as Any).prototype.buildExplicitChatMessages.call(
      executor,
      "Another follow up",
      "system prompt",
    );

    expect(buildCompactionSummaryBlock).toHaveBeenCalledTimes(1);
    expect(executor.explicitChatSummaryBlock).toContain("summary");
    expect(
      typeof first[0].content === "string" ? first[0].content : JSON.stringify(first[0].content),
    ).toContain("<cowork_compaction_summary>");
    expect(
      typeof second[0].content === "string" ? second[0].content : JSON.stringify(second[0].content),
    ).toContain("<cowork_compaction_summary>");
  });

  it("merges newly aged chat messages into the cached summary", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const buildCompactionSummaryBlock = vi
      .fn()
      .mockResolvedValueOnce("<cowork_compaction_summary>first summary</cowork_compaction_summary>")
      .mockResolvedValueOnce(
        "<cowork_compaction_summary>merged summary</cowork_compaction_summary>",
      );

    executor.conversationHistory = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `${index % 2 === 0 ? "User" : "Assistant"} turn ${index}` }],
    }));
    executor.buildCompactionSummaryBlock = buildCompactionSummaryBlock;
    executor.explicitChatSummaryBlock = null;
    executor.explicitChatSummaryCreatedAt = 0;
    executor.explicitChatSummarySourceMessageCount = 0;

    const first = await (TaskExecutor as Any).prototype.buildExplicitChatMessages.call(
      executor,
      "First follow up",
      "system prompt",
    );
    executor.conversationHistory = [
      first[0],
      { role: "user", content: [{ type: "text", text: "newly dropped user fact" }] },
      { role: "assistant", content: [{ type: "text", text: "newly dropped answer" }] },
      { role: "user", content: [{ type: "text", text: "newly dropped correction" }] },
      ...first.slice(1, -1),
    ];

    await (TaskExecutor as Any).prototype.buildExplicitChatMessages.call(
      executor,
      "Second follow up",
      "system prompt",
    );

    expect(buildCompactionSummaryBlock).toHaveBeenCalledTimes(2);
    expect(buildCompactionSummaryBlock.mock.calls[1][0]).toMatchObject({
      contextLabel: "incremental chat session compaction",
    });
    expect(buildCompactionSummaryBlock.mock.calls[1][0].removedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("first summary") }),
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining("newly dropped correction") }),
          ]),
        }),
      ]),
    );
  });

  it("correlates explicit chat lifecycle events with the history generation", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    let historyGeneration = 7;
    executor.task = { id: "chat-compaction" };
    executor.daemon = {};
    executor._runtime = { getHistoryGeneration: () => historyGeneration };
    executor.emitEvent = vi.fn();

    (TaskExecutor as Any).prototype.beginExplicitChatCompaction.call(executor, 9000, 18);
    historyGeneration = 8;
    (TaskExecutor as Any).prototype.completeExplicitChatCompaction.call(executor, [
      { role: "user", content: "replacement" },
    ]);

    const started = executor.emitEvent.mock.calls.find(
      ([type]: [string]) => type === "context_compaction_started",
    )?.[1];
    const completed = executor.emitEvent.mock.calls.find(
      ([type]: [string]) => type === "context_compaction_completed",
    )?.[1];
    expect(started.compactionId).toBe(completed.compactionId);
    expect(started.attemptId).toBe(completed.attemptId);
    expect(started.historyGenerationBefore).toBe(7);
    expect(completed.historyGenerationBefore).toBe(7);
    expect(completed.historyGenerationAfter).toBe(8);
  });

  it("delegates explicit chat lifecycle durability to SessionRuntime", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const handle = {
      compactionId: "runtime-compaction",
      attemptId: "runtime-attempt",
      trigger: "automatic",
      phase: "pre_turn",
    };
    executor._runtime = {
      getHistoryGeneration: () => 4,
      beginCompactionLifecycle: vi.fn().mockReturnValue(handle),
      completeCompactionLifecycle: vi.fn().mockReturnValue(true),
      failCompactionLifecycle: vi.fn(),
    };
    executor.task = { id: "runtime-chat" };

    (TaskExecutor as Any).prototype.beginExplicitChatCompaction.call(executor, 12_000, 24);
    const completed = (TaskExecutor as Any).prototype.completeExplicitChatCompaction.call(
      executor,
      [{ role: "user", content: "replacement" }],
    );

    expect(executor._runtime.beginCompactionLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "automatic",
        phase: "pre_turn",
        reason: "chat_history_threshold",
      }),
    );
    expect(executor._runtime.completeCompactionLifecycle).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({ reason: "context_replacement_installed" }),
    );
    expect(completed).toBe(true);
  });

  it("uses a deterministic handoff when the compaction provider returns an empty summary", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.contextManager = { getAvailableTokens: () => 20_000 };
    executor.modelId = "test-model";
    executor.callLLMWithRetry = vi.fn(async (request: Any) => request(0));
    executor.createMessageWithTimeout = vi.fn().mockResolvedValue({ content: [] });
    executor.updateTracking = vi.fn();

    const summary = await (TaskExecutor as Any).prototype.buildCompactionSummaryBlock.call(
      executor,
      {
        removedMessages: [
          { role: "user", content: "Remember this user decision." },
          { role: "assistant", content: "The decision was recorded." },
        ],
        maxOutputTokens: 512,
        contextLabel: "chat session",
      },
    );

    expect(summary).toContain("<cowork_compaction_summary>");
    expect(summary).toContain("Dropped context (raw, truncated):");
    expect(summary).toContain("Remember this user decision.");
  });

  it("uses the bounded deterministic handoff for oversized bot research transcripts", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { botConversation: true } };
    executor.contextManager = { getAvailableTokens: () => 20_000 };
    executor.callLLMWithRetry = vi.fn();
    executor.updateTracking = vi.fn();

    const summary = await (TaskExecutor as Any).prototype.buildCompactionSummaryBlock.call(
      executor,
      {
        removedMessages: [
          ...Array.from({ length: 10 }, (_, index) => ({
            role: "user",
            content:
              index === 0 ? "Research brief" : `Research result ${index} ` + "x".repeat(4000),
          })),
        ],
        maxOutputTokens: 512,
        contextLabel: "bot research",
      },
    );

    expect(executor.callLLMWithRetry).not.toHaveBeenCalled();
    expect(summary).toContain("<cowork_compaction_summary>");
    expect(summary).toContain("Dropped context (raw, truncated):");
    expect(summary).toContain("Research brief");
  });

  it("compacts a single oversized prior chat message instead of bypassing the token trigger", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const summary =
      "<cowork_compaction_summary>Oversized context retained.</cowork_compaction_summary>";
    executor.conversationHistory = [{ role: "user", content: "x".repeat(60_000) }];
    executor.buildCompactionSummaryBlock = vi.fn().mockResolvedValue(summary);
    executor.explicitChatSummaryBlock = null;
    executor.explicitChatSummaryInputSignature = "";
    executor.explicitChatSummaryCreatedAt = 0;
    executor.explicitChatSummarySourceMessageCount = 0;

    const messages = await (TaskExecutor as Any).prototype.buildExplicitChatMessages.call(
      executor,
      "Keep going",
      "system prompt",
    );

    expect(executor.buildCompactionSummaryBlock).toHaveBeenCalledTimes(1);
    expect(messages[0]).toMatchObject({ role: "user", content: summary });
    expect(messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("routes long sub-agent chat synthesis through the shared text turn kernel flow", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const runTextTurnKernel = vi.fn().mockResolvedValue({
      assistantText: "Part one. Part two.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Synthesis prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "Part one. Part two." }] },
      ],
    });

    executor.task = {
      id: "task-sub-chat",
      title: "Synthesis child",
      prompt: "x".repeat(2200),
      userPrompt: "x".repeat(2200),
      rawPrompt: "x".repeat(2200),
      parentTaskId: "parent-1",
      createdAt: Date.now(),
      agentType: "sub",
      agentConfig: {
        executionMode: "chat",
        conversationMode: "chat",
        maxTokens: 16000,
      },
    };
    executor.workspace = {
      id: "ws-sub-chat",
      path: "/tmp",
      isTemp: true,
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
    };
    executor.daemon = {
      updateTaskStatus: vi.fn(),
      updateTask: vi.fn(),
    };
    executor.emitEvent = vi.fn();
    executor.getRoleContextPrompt = vi.fn().mockReturnValue("");
    executor.buildUserContent = vi.fn().mockResolvedValue("Synthesis prompt");
    executor.runTextTurnKernel = runTextTurnKernel;
    executor.updateTracking = vi.fn();
    executor.updateConversationHistory = vi.fn();
    executor.buildResultSummary = vi.fn().mockReturnValue("summary");
    executor.finalizeTaskBestEffort = vi.fn();

    await (TaskExecutor as Any).prototype.handleSubAgentChatMode.call(executor, "x".repeat(2200));

    expect(runTextTurnKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: [{ type: "text", text: "Synthesis prompt" }] }],
        systemPrompt: expect.stringContaining("Respond thoroughly and completely"),
        initialMaxTokens: 16000,
        continuationMaxTokens: 1200,
        mode: "follow_up",
        operationLabel: "Sub-agent chat response",
        allowContinuation: true,
      }),
    );
    expect(executor.updateConversationHistory).toHaveBeenCalledWith([
      { role: "user", content: [{ type: "text", text: "Synthesis prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "Part one. Part two." }] },
    ]);
    expect(executor.finalizeTaskBestEffort).toHaveBeenCalledWith("summary");
  });
});
