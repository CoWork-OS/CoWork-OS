import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

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

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue(""),
    getPersonalityPromptById: vi.fn().mockReturnValue(""),
    getIdentityPrompt: vi.fn().mockReturnValue(""),
  },
}));

describe("TaskExecutor chat mode", () => {
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

    executor.shouldEmitAnswerFirst = vi.fn().mockReturnValue(true);
    executor.hasDirectAnswerReady = vi.fn().mockReturnValue(true);
    executor.promptRequestsArtifactOutput = vi.fn().mockReturnValue(false);
    executor.isLikelyTaskRequest = vi.fn().mockReturnValue(false);

    expect((TaskExecutor as Any).prototype.shouldShortCircuitSimpleNonExecuteAnswer.call(executor)).toBe(false);
  });

  it("only exposes the last non-verification step as an assistant bubble", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.plan = {
      description: "Hello plan",
      steps: [
        { id: "1", description: "Interpret the task as a simple chat greeting.", kind: "primary" },
        { id: "2", description: "Draft a concise reply.", kind: "primary" },
        { id: "3", description: "Send the greeting response.", kind: "primary" },
        { id: "4", description: "Verify: confirm the reply includes a greeting and help offer.", kind: "verification" },
      ],
    };

    expect((TaskExecutor as Any).prototype.isLastVisibleAssistantStep.call(executor, executor.plan.steps[0])).toBe(false);
    expect((TaskExecutor as Any).prototype.isLastVisibleAssistantStep.call(executor, executor.plan.steps[1])).toBe(false);
    expect((TaskExecutor as Any).prototype.isLastVisibleAssistantStep.call(executor, executor.plan.steps[2])).toBe(true);
    expect((TaskExecutor as Any).prototype.isLastVisibleAssistantStep.call(executor, executor.plan.steps[3])).toBe(false);
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

  it("reuses a cached explicit chat summary instead of regenerating it every turn", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const buildCompactionSummaryBlock = vi.fn().mockResolvedValue("<cowork_compaction_summary>\nsummary\n</cowork_compaction_summary>");

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
      typeof first[0].content === "string"
        ? first[0].content
        : JSON.stringify(first[0].content),
    ).toContain("<cowork_compaction_summary>");
    expect(
      typeof second[0].content === "string"
        ? second[0].content
        : JSON.stringify(second[0].content),
    ).toContain("<cowork_compaction_summary>");
  });

  it("routes long sub-agent chat synthesis through the shared text turn kernel continuation flow", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const createMessageWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Part one. " }],
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 0 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Part two." }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 8, cachedTokens: 0 },
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
    executor.callLLMWithRetry = vi.fn(async (fn: Any) => fn());
    executor.createMessageWithTimeout = createMessageWithTimeout;
    executor.updateTracking = vi.fn();
    executor.extractTextFromLLMContent = vi
      .fn()
      .mockImplementation((content: Any[]) => content?.map((item) => item.text || "").join("") || "");
    executor.updateConversationHistory = vi.fn();
    executor.buildResultSummary = vi.fn().mockReturnValue("summary");
    executor.finalizeTaskBestEffort = vi.fn();

    await (TaskExecutor as Any).prototype.handleCompanionPrompt.call(executor);

    expect(createMessageWithTimeout).toHaveBeenCalledTimes(2);
    expect(executor.updateConversationHistory).toHaveBeenCalledWith([
      { role: "user", content: [{ type: "text", text: "Synthesis prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "Part one. Part two." }] },
    ]);
    expect(executor.finalizeTaskBestEffort).toHaveBeenCalledWith("summary");
  });
});
