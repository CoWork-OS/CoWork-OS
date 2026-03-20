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
});
