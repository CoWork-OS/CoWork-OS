import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

type HarnessOptions = {
  prompt: string;
  rawPrompt?: string;
  title?: string;
  lastOutput: string;
  createdFiles?: string[];
  planStepDescription?: string;
};

function createExecuteHarness(options: HarnessOptions) {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  const stepDescription = options.planStepDescription || "Do the task";

  executor.task = {
    id: "task-1",
    title: options.title || "Test task",
    prompt: options.prompt,
    ...(options.rawPrompt ? { rawPrompt: options.rawPrompt } : {}),
    createdAt: Date.now() - 1000,
    currentAttempt: 0,
    maxAttempts: 1,
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp",
    isTemp: false,
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = {
    logEvent: vi.fn(),
    updateTaskStatus: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    getTaskEvents: vi.fn().mockReturnValue([]),
    handleTransientTaskFailure: vi.fn().mockReturnValue(false),
    dispatchMentionedAgents: vi.fn(),
    getAgentRoleById: vi.fn().mockReturnValue(null),
  };
  executor.toolRegistry = {
    cleanup: vi.fn(async () => undefined),
  };
  executor.fileOperationTracker = {
    getCreatedFiles: vi.fn().mockReturnValue(options.createdFiles || []),
    getKnowledgeSummary: vi.fn().mockReturnValue(""),
  };
  executor.contextManager = {
    getAvailableTokens: vi.fn().mockReturnValue(1000000),
    compactMessagesWithMeta: vi.fn((messages: Any) => ({ messages, meta: { kind: "none" } })),
  };
  executor.provider = { createMessage: vi.fn() };
  executor.abortController = new AbortController();
  executor.cancelled = false;
  executor.waitingForUserInput = false;
  executor.requiresTestRun = false;
  executor.testRunObserved = false;
  executor.taskCompleted = false;
  executor.lastAssistantOutput = options.lastOutput;
  executor.lastNonVerificationOutput = options.lastOutput;
  executor.lastAssistantText = options.lastOutput;
  executor.saveConversationSnapshot = vi.fn();
  executor.maybeHandleScheduleSlashCommand = vi.fn(async () => false);
  executor.isCompanionPrompt = vi.fn().mockReturnValue(false);
  executor.analyzeTask = vi.fn(async () => ({}));
  executor.dispatchMentionedAgentsAfterPlanning = vi.fn(async () => undefined);
  executor.verifySuccessCriteria = vi.fn(async () => ({ success: true, message: "ok" }));
  executor.isTransientProviderError = vi.fn().mockReturnValue(false);
  executor.executePlan = vi.fn(async function executePlanStub(this: Any) {
    const current = this.plan?.steps?.[0];
    if (current) {
      current.status = "completed";
      current.completedAt = Date.now();
    }
  });
  executor.createPlan = vi.fn(async function createPlanStub(this: Any) {
    this.plan = {
      description: "Plan",
      steps: [
        {
          id: "1",
          description: stepDescription,
          status: "pending",
        },
      ],
    };
  });

  return executor as TaskExecutor & {
    daemon: {
      logEvent: ReturnType<typeof vi.fn>;
      updateTaskStatus: ReturnType<typeof vi.fn>;
      updateTask: ReturnType<typeof vi.fn>;
      completeTask: ReturnType<typeof vi.fn>;
      getTaskEvents: ReturnType<typeof vi.fn>;
    };
  };
}

describe("TaskExecutor completion contract integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits simple non-execute answer-first prompts without running plan execution", async () => {
    const executor = createExecuteHarness({
      title: "Ethics question",
      prompt:
        "Would you feel guilty if your efficiency caused job cuts in companies?\n\n[AGENT_STRATEGY_CONTEXT_V1]\nanswer_first=true\n[/AGENT_STRATEGY_CONTEXT_V1]",
      lastOutput: "",
      planStepDescription: "Draft a plan",
    });
    executor.task.agentConfig = {
      executionMode: "propose",
    };
    (executor as Any).emitAnswerFirstResponse = vi.fn(async function emitAnswerFirstStub(this: Any) {
      const text =
        "I don't feel guilt, but this is a serious ethical risk and should be handled responsibly.";
      this.lastAssistantOutput = text;
      this.lastNonVerificationOutput = text;
      this.lastAssistantText = text;
    });

    await (executor as Any).execute();

    expect((executor as Any).emitAnswerFirstResponse).toHaveBeenCalledTimes(1);
    expect(executor.createPlan).not.toHaveBeenCalled();
    expect(executor.executePlan).not.toHaveBeenCalled();
    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
  });

  it("short-circuits simple advice prompts even if stale executionMode is execute", async () => {
    const executor = createExecuteHarness({
      title: "Ethics question",
      prompt:
        "Would you feel guilty if your efficiency caused job cuts in companies?\n\n[AGENT_STRATEGY_CONTEXT_V1]\nanswer_first=true\n[/AGENT_STRATEGY_CONTEXT_V1]",
      lastOutput: "",
      planStepDescription: "Draft a plan",
    });
    executor.task.agentConfig = {
      executionMode: "execute",
      taskIntent: "advice",
    };
    (executor as Any).emitAnswerFirstResponse = vi.fn(async function emitAnswerFirstStub(this: Any) {
      const text = "I don't feel guilt, but job impacts should be handled responsibly.";
      this.lastAssistantOutput = text;
      this.lastNonVerificationOutput = text;
      this.lastAssistantText = text;
    });

    await (executor as Any).execute();

    expect((executor as Any).emitAnswerFirstResponse).toHaveBeenCalledTimes(1);
    expect(executor.createPlan).not.toHaveBeenCalled();
    expect(executor.executePlan).not.toHaveBeenCalled();
    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
  });

  it("does not complete the task when a direct answer is required but missing", async () => {
    const executor = createExecuteHarness({
      title: "Video decision",
      prompt:
        "Transcribe this video and let me know if I should spend my time watching it or skip it.",
      lastOutput: "Created: Dan_Koe_Video_Review.pdf",
      createdFiles: ["Dan_Koe_Video_Review.pdf"],
      planStepDescription: "Transcribe the video",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing direct answer"),
      }),
    );
  });

  it("does not complete the task when artifact evidence is required but missing", async () => {
    const executor = createExecuteHarness({
      title: "Generate report",
      prompt: "Create a PDF report from the attached data.",
      lastOutput: "Created: report.pdf",
      createdFiles: [],
      planStepDescription: "Generate the report",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing artifact evidence"),
      }),
    );
  });

  it("completes website tasks even when strategy context mentions docx artifacts", async () => {
    const executor = createExecuteHarness({
      title: "Windows 95 website",
      prompt: `Create a fully working website simulating the Windows 95 UI.

[AGENT_STRATEGY_CONTEXT_V1]
relationship_memory:
- Completed task: create a short word document where you write about ... Outcome: inner_world.docx
[/AGENT_STRATEGY_CONTEXT_V1]`,
      lastOutput: "Created files: index.html, styles/win95.css, scripts/desktop.js",
      createdFiles: ["index.html", "styles/win95.css", "scripts/desktop.js"],
      planStepDescription: "Implement website files",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing artifact evidence"),
      }),
    );
  });

  it("uses raw prompt for contract inference when runtime prompt metadata mentions docx", async () => {
    const executor = createExecuteHarness({
      title: "Windows 95 website",
      rawPrompt: "Create a fully working website simulating the Windows 95 UI.",
      prompt: `Create a fully working website simulating the Windows 95 UI.

ADDITIONAL CONTEXT:
DOCUMENT CREATION BEST PRACTICES:
1. ONLY use create_document (docx/pdf) when the user explicitly requests DOCX or PDF format.`,
      lastOutput: "Created files: index.html, styles/win95.css, scripts/desktop.js",
      createdFiles: ["index.html", "styles/win95.css", "scripts/desktop.js"],
      planStepDescription: "Implement website files",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing artifact evidence"),
      }),
    );
  });

  it("does not complete canvas build tasks when write_file and canvas_push evidence is missing", async () => {
    const executor = createExecuteHarness({
      title: "Competition demo",
      prompt: "Build something to win this competition and show it in canvas.",
      lastOutput: "Built and rendered an interactive prototype in canvas.",
      createdFiles: ["prototype.html"],
      planStepDescription: "Build an interactive app and show it in canvas",
    });
    (executor as Any).successfulToolUsageCounts = new Map();

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing required tool evidence"),
      }),
    );
  });

  it("completes canvas build tasks when write_file and canvas_push evidence is present", async () => {
    const executor = createExecuteHarness({
      title: "Competition demo",
      prompt: "Build something to win this competition and show it in canvas.",
      lastOutput: "Built and rendered an interactive prototype in canvas.",
      createdFiles: ["prototype.html"],
      planStepDescription: "Build an interactive app and show it in canvas",
    });
    (executor as Any).successfulToolUsageCounts = new Map([
      ["write_file", 1],
      ["canvas_push", 1],
    ]);

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing required tool evidence"),
      }),
    );
  });

  it("does not complete the task when verification evidence is required but missing", async () => {
    const executor = createExecuteHarness({
      title: "Video decision",
      prompt:
        "Transcribe this video and then let me know if I should spend my time watching it or skip it.",
      lastOutput: "You should skip it because it repeats beginner concepts.",
      planStepDescription: "Transcribe the video",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("accepts reasoned recommendations when evidence tools were used", async () => {
    const executor = createExecuteHarness({
      title: "Video decision",
      prompt:
        "Transcribe this video and then let me know if I should spend my time watching it or skip it.",
      lastOutput: "You should skip it because it repeats beginner concepts.",
      planStepDescription: "Transcribe the video",
    });
    (executor as Any).toolResultMemory = [
      { tool: "web_fetch", summary: "https://example.com/transcript", timestamp: Date.now() },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("does not complete high-risk research summaries without dated fetched evidence", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
    });

    (executor as Any).toolResultMemory = [
      {
        tool: "web_search",
        summary: "query \"AI agent trends\" returned sources",
        timestamp: Date.now(),
      },
    ];
    (executor as Any).webEvidenceMemory = [
      {
        tool: "web_fetch",
        url: "https://example.com/ai-news",
        timestamp: Date.now(),
      },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing source validation"),
      }),
    );
  });

  it("allows high-risk research summaries when fetched sources include publish dates", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
    });

    (executor as Any).webEvidenceMemory = [
      {
        tool: "web_fetch",
        url: "https://example.com/ai-news",
        publishDate: "2026-02-26",
        timestamp: Date.now(),
      },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing source validation"),
      }),
    );
  });

  it("completes only when the completion contract requirements are satisfied", async () => {
    const executor = createExecuteHarness({
      title: "Video review",
      prompt:
        "Create a PDF review document for this video and let me know whether I should watch it.",
      lastOutput:
        "Based on my review, recommendation: You should skip this unless you need beginner-level context.",
      createdFiles: ["video_review.pdf"],
      planStepDescription: "Verify: review transcript and provide recommendation",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("allows watch/skip recommendation tasks without creating an artifact when no file is generated", async () => {
    const executor = createExecuteHarness({
      title: "Video review",
      prompt:
        "Transcribe this YouTube video and create a document for me to review, then tell me if I should watch it.",
      lastOutput:
        "You should watch this only if you specifically need practical examples of creator-income positioning.",
      createdFiles: [],
      planStepDescription: "Review transcript and recommend",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("routes provider request-cancelled errors through timeout recovery instead of failing", async () => {
    const executor = createExecuteHarness({
      title: "Draft whitepaper",
      prompt: "Create a detailed whitepaper draft.",
      lastOutput: "Initial summary",
      planStepDescription: "Write the draft",
    });
    const recoverySpy = vi.fn(async () => true);

    (executor as Any).executePlan = vi.fn(async () => {
      throw new Error("Request cancelled");
    });
    (executor as Any).finalizeWithTimeoutRecovery = recoverySpy;

    await (executor as Any).execute();

    expect(recoverySpy).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });
});
