/**
 * Tests for step failure/verification behavior in TaskExecutor.executeStep
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { TaskExecutor } from "../executor";
import type { LLMResponse } from "../llm";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue(""),
    getIdentityPrompt: vi.fn().mockReturnValue(""),
  },
}));

vi.mock("../../memory/MemoryService", () => ({
  MemoryService: {
    getContextForInjection: vi.fn().mockReturnValue(""),
  },
}));

function toolUseResponse(name: string, input: Record<string, Any>): LLMResponse {
  return {
    stopReason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: `tool-${name}`,
        name,
        input,
      },
    ],
  };
}

function textResponse(text: string): LLMResponse {
  return {
    stopReason: "end_turn",
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function applyExecutorFieldDefaults(executor: Any): void {
  executor.testRunObserved = false;
  executor.executionToolRunObserved = false;
  executor.executionToolAttemptObserved = false;
  executor.executionToolLastError = "";
  executor.allowExecutionWithoutShell = false;
  executor.planCompletedEffectively = false;
  executor.cancelled = false;
  executor.cancelReason = null;
  executor.paused = false;
  executor.taskCompleted = false;
  executor.waitingForUserInput = false;
  executor.workspacePreflightAcknowledged = false;
  executor.lastPauseReason = null;
  executor.conversationHistory = [];
  executor.systemPrompt = "";
  executor.recoveryRequestActive = false;
  executor.capabilityUpgradeRequested = false;
  executor.toolResultMemory = [];
  executor.toolUsageCounts = new Map();
  executor.toolUsageEventsSinceDecay = 0;
  executor.toolSelectionEpoch = 0;
  executor.lastAssistantOutput = null;
  executor.lastNonVerificationOutput = null;
  executor.filesReadTracker = new Map();
  executor.currentStepId = null;
  executor.lastRecoveryFailureSignature = "";
  executor.recoveredFailureStepIds = new Set();
  executor.crossStepToolFailures = new Map();
  executor.dispatchedMentionedAgents = false;
  executor.lastAssistantText = null;
  executor.lastPreCompactionFlushAt = 0;
  executor.lastPreCompactionFlushTokenCount = 0;
  executor.observedOutputTokensPerSecond = null;
  executor.unifiedCompatModeNotified = false;
  executor.journalIntervalHandle = undefined;
  executor.journalEntryCount = 0;
  executor.pendingFollowUps = [];
  executor._suppressNextUserMessageEvent = false;
  executor.planRevisionCount = 0;
  executor.maxPlanRevisions = 5;
  executor.failedApproaches = new Set();
  executor.totalInputTokens = 0;
  executor.totalOutputTokens = 0;
  executor.totalCost = 0;
  executor.usageOffsetInputTokens = 0;
  executor.usageOffsetOutputTokens = 0;
  executor.usageOffsetCost = 0;
  executor.iterationCount = 0;
  executor.globalTurnCount = 0;
  executor.maxGlobalTurns = 100;
  executor.turnSoftLandingReserve = 2;
  executor.budgetSoftLandingInjected = false;
  executor.llmCallSequence = 0;
  executor.softDeadlineTriggered = false;
  executor.wrapUpRequested = false;
  executor.useUnifiedTurnLoop = false;
  executor.logTag = "[Executor:test]";
  executor.infraContextProvider = {
    getStatus: () => ({ enabled: false }),
  };
}

function createExecutorWithStubs(responses: LLMResponse[], toolResults: Record<string, Any>) {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  executor.task = {
    id: "task-1",
    title: "Test Task",
    prompt: "Test prompt",
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp",
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = { logEvent: vi.fn() };
  applyExecutorFieldDefaults(executor);
  executor.contextManager = {
    compactMessagesWithMeta: vi.fn((messages: Any) => ({
      messages,
      meta: {
        availableTokens: 1_000_000,
        originalTokens: 0,
        truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 0 },
        removedMessages: { didRemove: false, count: 0, tokensAfter: 0, messages: [] },
        kind: "none",
      },
    })),
    getContextUtilization: vi.fn().mockReturnValue({ utilization: 0 }),
    getAvailableTokens: vi.fn().mockReturnValue(1_000_000),
  };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.getAvailableTools = vi.fn().mockReturnValue([
    { name: "run_command", description: "", input_schema: { type: "object", properties: {} } },
    { name: "glob", description: "", input_schema: { type: "object", properties: {} } },
    { name: "web_search", description: "", input_schema: { type: "object", properties: {} } },
    { name: "write_file", description: "", input_schema: { type: "object", properties: {} } },
    { name: "create_document", description: "", input_schema: { type: "object", properties: {} } },
    { name: "edit_file", description: "", input_schema: { type: "object", properties: {} } },
  ]);
  executor.handleCanvasPushFallback = vi.fn();
  executor.getToolTimeoutMs = vi.fn().mockReturnValue(1000);
  executor.checkFileOperation = vi.fn().mockReturnValue({ blocked: false });
  executor.recordFileOperation = vi.fn();
  executor.recordCommandExecution = vi.fn();
  executor.fileOperationTracker = {
    getKnowledgeSummary: vi.fn().mockReturnValue(""),
    getCreatedFiles: vi.fn().mockReturnValue([]),
  };
  executor.toolFailureTracker = {
    isDisabled: vi.fn().mockReturnValue(false),
    getLastError: vi.fn().mockReturnValue(""),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn().mockReturnValue(false),
  };
  executor.toolCallDeduplicator = {
    checkDuplicate: vi.fn().mockReturnValue({ isDuplicate: false }),
    recordCall: vi.fn(),
  };
  executor.toolResultMemoryLimit = 8;
  executor.toolRegistry = {
    executeTool: vi.fn(async (name: string) => {
      if (name in toolResults) return toolResults[name];
      return { success: true };
    }),
  };
  executor.callLLMWithRetry = vi.fn().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("No more LLM responses configured");
    }
    return response;
  });
  executor.abortController = new AbortController();

  return executor as TaskExecutor & {
    daemon: { logEvent: ReturnType<typeof vi.fn> };
    toolRegistry: { executeTool: ReturnType<typeof vi.fn> };
  };
}

function createExecutorWithLLMHandler(handler: (messages: Any[]) => LLMResponse) {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  executor.task = {
    id: "task-1",
    title: "Today F1 news",
    prompt: "Search for the latest Formula 1 news from today and summarize.",
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp",
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = { logEvent: vi.fn() };
  applyExecutorFieldDefaults(executor);
  executor.contextManager = {
    compactMessagesWithMeta: vi.fn((messages: Any) => ({
      messages,
      meta: {
        availableTokens: 1_000_000,
        originalTokens: 0,
        truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 0 },
        removedMessages: { didRemove: false, count: 0, tokensAfter: 0, messages: [] },
        kind: "none",
      },
    })),
    getContextUtilization: vi.fn().mockReturnValue({ utilization: 0 }),
    getAvailableTokens: vi.fn().mockReturnValue(1_000_000),
  };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.getAvailableTools = vi.fn().mockReturnValue([]);
  executor.handleCanvasPushFallback = vi.fn();
  executor.getToolTimeoutMs = vi.fn().mockReturnValue(1000);
  executor.checkFileOperation = vi.fn().mockReturnValue({ blocked: false });
  executor.recordFileOperation = vi.fn();
  executor.recordCommandExecution = vi.fn();
  executor.fileOperationTracker = {
    getKnowledgeSummary: vi.fn().mockReturnValue(""),
    getCreatedFiles: vi.fn().mockReturnValue([]),
  };
  executor.toolFailureTracker = {
    isDisabled: vi.fn().mockReturnValue(false),
    getLastError: vi.fn().mockReturnValue(""),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn().mockReturnValue(false),
  };
  executor.toolCallDeduplicator = {
    checkDuplicate: vi.fn().mockReturnValue({ isDuplicate: false }),
    recordCall: vi.fn(),
  };
  executor.toolResultMemoryLimit = 8;
  executor.toolRegistry = {
    executeTool: vi.fn(async () => ({ success: true })),
  };
  executor.provider = {
    createMessage: vi.fn(async (args: Any) => handler(args.messages)),
  };
  executor.callLLMWithRetry = vi.fn().mockImplementation(async (requestFn: Any) => {
    return requestFn();
  });
  executor.abortController = new AbortController();

  return executor as TaskExecutor & {
    daemon: { logEvent: ReturnType<typeof vi.fn> };
  };
}

describe("TaskExecutor executeStep failure handling", () => {
  let executor: ReturnType<typeof createExecutorWithStubs>;
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  beforeAll(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it("keeps the step completed when run_command fails but a direct completion text follows", async () => {
    executor = createExecutorWithStubs(
      [toolUseResponse("run_command", { command: "exit 1" }), textResponse("done")],
      {
        run_command: { success: false, exitCode: 1 },
      },
    );

    const step: Any = { id: "1", description: "Execute a command", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(step.error).toBeUndefined();
  });

  it("returns a direct completion response after duplicate non-idempotent tool calls are blocked", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "echo test" }),
        textResponse("Completed with existing context after duplicate tool call was blocked."),
      ],
      {},
    );
    (executor as Any).toolCallDeduplicator.checkDuplicate = vi.fn().mockReturnValue({
      isDuplicate: true,
      reason: "duplicate_call",
      cachedResult: null,
    });

    const step: Any = { id: "1b", description: "Execute command once", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(step.error).toBeUndefined();
  });

  it("blocks create_document for watch-skip recommendation prompts and continues with a text answer", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("create_document", {
          filename: "Dan_Koe_Video_Review.docx",
          format: "docx",
          content: [{ type: "paragraph", text: "placeholder" }],
        }),
        textResponse(
          "Watch it only if you want to improve your creator-economy positioning; otherwise skip it.",
        ),
      ],
      {},
    );
    (executor as Any).task.title = "Video review";
    (executor as Any).task.prompt =
      "Transcribe this YouTube video and create a document so I can review it, then tell me if I should watch it.";

    const step: Any = {
      id: "watch-skip-1",
      description: "Transcribe and decide watchability",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(executor.daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_blocked",
      expect.objectContaining({
        tool: "create_document",
        reason: "watch_skip_recommendation_task",
      }),
    );
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
  });

  it("does not reference follow-up lock state when step tool calls are soft-blocked by turn budget", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("web_search", { query: "latest nokia earnings" }),
        textResponse("Using current evidence only."),
      ],
      {},
    );
    (executor as Any).guardrailPhaseAEnabled = true;
    (executor as Any).getRemainingTurnBudget = vi.fn().mockReturnValue(0);
    (executor as Any).crossStepToolFailures = new Map();
    (executor as Any).pendingFollowUps = [];

    const step: Any = { id: "step-turn-budget", description: "Search for source links", status: "pending" };

    await expect((executor as Any).executeStep(step)).resolves.toBeUndefined();
    expect(String(step.error || "")).not.toContain("followUpToolCallsLocked");
  });

  it("fails fast after repeated policy-blocked tool-only turns with no text output", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("web_search", { query: "first blocked call" }),
        toolUseResponse("web_search", { query: "second blocked call" }),
      ],
      {},
    );
    (executor as Any).guardrailPhaseAEnabled = true;
    (executor as Any).getRemainingTurnBudget = vi.fn().mockReturnValue(0);
    (executor as Any).crossStepToolFailures = new Map();
    (executor as Any).pendingFollowUps = [];

    const step: Any = {
      id: "step-blocked-loop",
      description: "Find sources",
      status: "pending",
    };

    await expect((executor as Any).executeStep(step)).resolves.toBeUndefined();
    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("repeated tool-only turns");
  });

  it("marks verification step failed when no new image is found", async () => {
    const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    executor = createExecutorWithStubs(
      [toolUseResponse("glob", { pattern: "**/*.{png,jpg,jpeg,webp}" }), textResponse("checked")],
      {
        glob: {
          success: true,
          matches: [{ path: "old.png", modified: oldTimestamp }],
        },
      },
    );

    const step: Any = {
      id: "2",
      description: "Verify: Confirm the generated image file exists and report the result",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(step.error).toContain("no newly generated image");
  });

  it("fails executePlan when a step remains unfinished", async () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const step: Any = { id: "plan-1", description: "Do the work", status: "pending" };
    (executor as Any).plan = { description: "Plan", steps: [step] };
    (executor as Any).executeStep = vi.fn(async (target: Any) => {
      // Simulate a broken executor path that never finalizes to completed/failed.
      target.status = "in_progress";
    });

    await expect((executor as Any).executePlan()).rejects.toThrow("Task incomplete");
  });

  it("emits failed-step progress instead of completed-step progress when step execution fails", async () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const step: Any = { id: "plan-2", description: "Fetch transcript", status: "pending" };
    (executor as Any).plan = { description: "Plan", steps: [step] };
    (executor as Any).executeStep = vi.fn(async (target: Any) => {
      target.status = "failed";
      target.error = "All required tools are unavailable or failed. Unable to complete this step.";
      target.completedAt = Date.now();
    });

    await expect((executor as Any).executePlan()).rejects.toThrow("Task failed");

    const progressMessages = (executor as Any).daemon.logEvent.mock.calls
      .filter((call: Any[]) => call[1] === "progress_update")
      .map((call: Any[]) => String(call[2]?.message || ""));

    expect(progressMessages.some((message: string) => message.includes("Step failed"))).toBe(true);
    expect(progressMessages.some((message: string) => message.includes("Completed step"))).toBe(
      false,
    );
  });

  it("fails executePlan when a verification-labeled step fails", async () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const step: Any = {
      id: "plan-verify-1",
      description: "Verify: Read the created document and present recommendation",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };
    (executor as Any).executeStep = vi.fn(async (target: Any) => {
      target.status = "failed";
      target.error = "Verification failed";
      target.completedAt = Date.now();
    });

    await expect((executor as Any).executePlan()).rejects.toThrow("Task failed");
  });

  it("requires a direct answer when prompt asks for a decision and summary is artifact-only", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).task.title = "Review YouTube video";
    (executor as Any).task.prompt =
      "Transcribe this YouTube video and let me know if I should spend my time watching it or skip it.";
    (executor as Any).fileOperationTracker.getCreatedFiles.mockReturnValue([
      "Dan_Koe_Video_Review.pdf",
    ]);
    (executor as Any).lastNonVerificationOutput = "Created: Dan_Koe_Video_Review.pdf";
    (executor as Any).lastAssistantOutput = "Created document successfully.";

    const guardError = (executor as Any).getFinalResponseGuardError();
    expect(guardError).toContain("missing direct answer");
  });

  it("allows completion when recommendation is explicitly present for decision prompts", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).task.title = "Review YouTube video";
    (executor as Any).task.prompt =
      "Transcribe this YouTube video and let me know if I should spend my time watching it or skip it.";
    (executor as Any).fileOperationTracker.getCreatedFiles.mockReturnValue([
      "Dan_Koe_Video_Review.pdf",
    ]);
    (executor as Any).lastNonVerificationOutput =
      "Recommendation: Skip this video unless you are new to creator-economy basics; it is likely not worth your time.";
    (executor as Any).plan = {
      description: "Plan",
      steps: [{ id: "1", description: "Review transcript and recommend", status: "completed" }],
    };

    const guardError = (executor as Any).getFinalResponseGuardError();
    expect(guardError).toBeNull();
  });

  it("does not require direct answer for artifact-only tasks without question intent", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).task.title = "Generate PDF report";
    (executor as Any).task.prompt = "Create a PDF report from the attached data.";
    (executor as Any).fileOperationTracker.getCreatedFiles.mockReturnValue(["report.pdf"]);
    (executor as Any).lastNonVerificationOutput = "Created: report.pdf";

    const guardError = (executor as Any).getFinalResponseGuardError();
    expect(guardError).toBeNull();
  });

  it("requires direct answer for non-video advisory prompts too", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).task.title = "Stack choice";
    (executor as Any).task.prompt =
      "Compare option A and option B and tell me which one I should choose.";
    (executor as Any).lastNonVerificationOutput = "Created: comparison.md";

    const guardError = (executor as Any).getFinalResponseGuardError();
    expect(guardError).toContain("missing direct answer");
  });

  it("pauses when assistant asks blocking questions", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "1) Who is the primary user?\n2) What is the core flow?\n3) List 3 must-have features.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = true;

    const step: Any = { id: "3", description: "Clarify requirements", status: "pending" };

    await expect((executor as Any).executeStep(step)).rejects.toMatchObject({
      name: "AwaitingUserInputError",
    });
  });

  it("does not pause when user input is disabled for the task", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "1) Who is the primary user?\n2) What is the core flow?\n3) List 3 must-have features.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = false;

    const step: Any = { id: "3b", description: "Clarify requirements", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
  });

  it("skips workspace preflight pauses when user input is disabled", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).shouldPauseForQuestions = false;
    (executor as Any).classifyWorkspaceNeed = vi.fn().mockReturnValue("needs_existing");
    (executor as Any).pauseForUserInput = vi.fn();

    const shouldPause = (executor as Any).preflightWorkspaceCheck();

    expect(shouldPause).toBe(false);
    expect((executor as Any).pauseForUserInput).not.toHaveBeenCalled();
  });

  it("treats provider cancellation messages as abort-like errors", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});

    expect((executor as Any).isAbortLikeError(new Error("Request cancelled"))).toBe(true);
    expect((executor as Any).isAbortLikeError(new Error("Request canceled"))).toBe(true);
  });

  it("does not infer write_file content from assistant narration fallback", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).lastAssistantText = "Now let me write the full whitepaper:";
    (executor as Any).lastNonVerificationOutput = "Now let me write the full whitepaper:";
    (executor as Any).lastAssistantOutput = "Now let me write the full whitepaper:";

    const inferred = (executor as Any).inferMissingParameters("write_file", {
      path: "NexusChain-Whitepaper.md",
    });

    expect(inferred.input.content).toBeUndefined();
  });

  it("does not infer create_document content from assistant narration fallback", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).lastAssistantText = "Now let me write the full whitepaper:";
    (executor as Any).lastNonVerificationOutput = "Now let me write the full whitepaper:";
    (executor as Any).lastAssistantOutput = "Now let me write the full whitepaper:";

    const inferred = (executor as Any).inferMissingParameters("create_document", {
      filename: "spec.docx",
      format: "docx",
    });

    expect(inferred.input.content).toBeUndefined();
  });

  it("fails write/create deliverable steps when no file mutation evidence exists", async () => {
    executor = createExecutorWithStubs(
      [textResponse("I wrote the complete whitepaper and it is ready.")],
      {},
    );

    const step: Any = {
      id: "artifact-1",
      description: "Write the complete KARU founding whitepaper document",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(step.error).toContain("written artifact");
  });

  it("keeps write/create deliverable steps completed when a file mutation succeeds", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("write_file", { path: "KARU_Whitepaper.md", content: "# KARU" }),
        textResponse("Saved the complete whitepaper to KARU_Whitepaper.md"),
      ],
      {
        write_file: { success: true, path: "KARU_Whitepaper.md" },
      },
    );

    const step: Any = {
      id: "artifact-2",
      description: "Write the complete KARU founding whitepaper document",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
  });

  it("fails final verification steps unless the response is exactly OK", async () => {
    executor = createExecutorWithStubs(
      [textResponse("The whitepaper is missing required sections.")],
      {},
    );

    const step: Any = {
      id: "verify-1",
      description: "Final verification: Review the completed whitepaper for completeness",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(step.error).toContain("Verification failed");
  });

  it("rethrows abort-like errors without marking step as failed inside executeStep", async () => {
    executor = createExecutorWithStubs([], {});
    (executor as Any).callLLMWithRetry = vi.fn(async () => {
      throw new Error("Request cancelled");
    });

    const step: Any = {
      id: "abort-1",
      description: "Generate a large document",
      status: "pending",
    };

    await expect((executor as Any).executeStep(step)).rejects.toThrow("Request cancelled");
    expect(step.status).not.toBe("failed");
    expect(step.error).toBeUndefined();
    expect((executor as Any).daemon.logEvent).not.toHaveBeenCalledWith(
      "task-1",
      "step_failed",
      expect.objectContaining({ reason: "Request cancelled" }),
    );
  });

  it("does not fail step when only web_search errors occur after a successful tool", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("glob", { pattern: "**/*.md" }),
        toolUseResponse("web_search", { query: "test", searchType: "web" }),
        textResponse("summary"),
      ],
      {
        glob: { success: true, matches: [], totalMatches: 0 },
        web_search: { success: false, error: "timeout" },
      },
    );

    const step: Any = { id: "4", description: "Search and summarize", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
  });

  it("fails fast when tool returns unrecoverable failure (use_skill not currently executable)", async () => {
    const executorWithTools = createExecutorWithStubs(
      [
        toolUseResponse("use_skill", {
          skill_id: "audio-transcribe",
          parameters: { inputPath: "/tmp/audio.mp3" },
        }),
      ],
      {
        use_skill: {
          success: false,
          error: "Skill 'audio-transcribe' is not currently executable",
          reason: "Missing or invalid skill prerequisites.",
          missing_requirements: {
            bins: ["ffmpeg"],
          },
        },
      },
    );
    executorWithTools.getAvailableTools = vi.fn().mockReturnValue([
      { name: "run_command", description: "", input_schema: { type: "object", properties: {} } },
      { name: "glob", description: "", input_schema: { type: "object", properties: {} } },
      { name: "use_skill", description: "", input_schema: { type: "object", properties: {} } },
    ]);

    const step: Any = { id: "7", description: "Create transcript and summary", status: "pending" };

    await (executorWithTools as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect((executorWithTools as Any).callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(step.error).toMatch(
      /not currently executable|All required tools are unavailable or failed/,
    );
  });

  it("normalizes namespaced tool names like functions.web_search", async () => {
    const toolSpy = vi.fn(async () => ({ success: true, results: [] }));
    executor = createExecutorWithStubs(
      [
        toolUseResponse("functions.web_search", { query: "test", searchType: "web" }),
        textResponse("summary"),
      ],
      {
        web_search: { success: true, results: [] },
      },
    );
    (executor as Any).toolRegistry.executeTool = toolSpy;

    const step: Any = { id: "5", description: "Search for info", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(toolSpy).toHaveBeenCalledWith("web_search", { query: "test", searchType: "web" });
    expect(step.status).toBe("completed");
  });

  it("includes recap context for final verify step in today news tasks", async () => {
    let callCount = 0;
    let verifyContextHasFinalStep = false;
    let verifyContextHasDeliverable = false;
    let verifyContextIncludesSummary = false;

    const executor = createExecutorWithLLMHandler((messages) => {
      callCount += 1;
      const stepContext = String(messages?.[0]?.content || "");

      if (callCount === 1) {
        return textResponse("Summary: Key F1 headlines from today.");
      }

      verifyContextHasFinalStep = stepContext.includes("FINAL step");
      verifyContextHasDeliverable = stepContext.includes("MOST RECENT DELIVERABLE");
      verifyContextIncludesSummary = stepContext.includes("Summary: Key F1 headlines from today.");

      return textResponse(
        "Recap: Summary: Key F1 headlines from today. Verification: Sources dated today.",
      );
    });

    const summaryStep: Any = {
      id: "1",
      description: "Write a concise summary of today’s F1 news",
      status: "pending",
    };
    const verifyStep: Any = {
      id: "2",
      description: "Verify: Ensure all summary items are from today’s news",
      status: "pending",
    };

    (executor as Any).plan = { description: "Plan", steps: [summaryStep, verifyStep] };

    await (executor as Any).executeStep(summaryStep);
    await (executor as Any).executeStep(verifyStep);

    expect((executor as Any).lastNonVerificationOutput).toContain(
      "Summary: Key F1 headlines from today.",
    );
    expect(verifyContextHasFinalStep).toBe(true);
    expect(verifyContextHasDeliverable).toBe(true);
    expect(verifyContextIncludesSummary).toBe(true);
  });

  it("detects recovery intent from user messaging in simple phrases", () => {
    const executor = createExecutorWithStubs([textResponse("done")], {});
    expect((executor as Any).isRecoveryIntent("I need you to find another way")).toBe(true);
    expect((executor as Any).isRecoveryIntent("Can't do this in this environment")).toBe(true);
    expect((executor as Any).isRecoveryIntent("Please continue")).toBe(false);
  });

  it("does not treat unrelated phrases as recovery intent", () => {
    const executor = createExecutorWithStubs([textResponse("done")], {});
    expect(
      (executor as Any).isRecoveryIntent(
        "Consider an alternative approach for this design, then resume",
      ),
    ).toBe(false);
    expect(
      (executor as Any).isRecoveryIntent("This is not possible with the current configuration"),
    ).toBe(false);
    expect((executor as Any).isRecoveryIntent("Another approach may be better later")).toBe(false);
  });

  it("resets attempt-level plan revision state on retry", () => {
    const executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).conversationHistory = [];
    const stepOne: Any = {
      id: "1",
      description: "Step one",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      error: "old",
    };
    const stepTwo: Any = {
      id: "2",
      description: "Step two",
      status: "failed",
      startedAt: 1,
      completedAt: 2,
      error: "old",
    };
    executor.task.currentAttempt = 2;
    executor.plan = { description: "Plan", steps: [stepOne, stepTwo] };
    executor.lastAssistantOutput = "summary";
    executor.lastNonVerificationOutput = "summary";
    executor.planRevisionCount = 3;

    (executor as Any).resetForRetry();

    expect(executor.plan!.steps[0].status).toBe("pending");
    expect(executor.plan!.steps[0].startedAt).toBeUndefined();
    expect(executor.plan!.steps[0].error).toBeUndefined();
    expect(executor.plan!.steps[1].status).toBe("pending");
    expect(executor.toolResultMemory).toEqual([]);
    expect(executor.lastAssistantOutput).toBeNull();
    expect(executor.lastNonVerificationOutput).toBeNull();
    expect(executor.planRevisionCount).toBe(0);
    expect((executor as Any).conversationHistory.at(-1)?.content).toContain("This is attempt 2");
  });

  it("does not auto-insert recovery plan steps for repeated failure signatures", async () => {
    const executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "exit 1" }),
        textResponse(""),
        toolUseResponse("run_command", { command: "exit 1" }),
        textResponse(""),
      ],
      {
        run_command: { success: false, error: "cannot complete this task without a workaround" },
      },
    );
    const handlePlanRevisionSpy = vi.spyOn(executor as Any, "handlePlanRevision");
    const failedStep: Any = { id: "1", description: "Run baseline task", status: "pending" };
    const retainedPendingStep: Any = { id: "2", description: "Validate output", status: "pending" };

    executor.plan = { description: "Plan", steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.planRevisionCount = 0;
    executor.recoveryRequestActive = true;

    await (executor as Any).executeStep(failedStep);
    await (executor as Any).executeStep(failedStep);

    expect(handlePlanRevisionSpy).not.toHaveBeenCalled();
    expect(executor.planRevisionCount).toBe(0);
    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("alternative toolchain")),
    ).toBe(false);
    expect(planDescriptions.length).toBe(2);
  });

  it("does not auto-insert recovery steps even when failure reason changes between retries", async () => {
    const executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "exit 1" }),
        textResponse(""),
        toolUseResponse("run_command", { command: "exit 1" }),
        textResponse(""),
      ],
      {},
    );

    let runAttempt = 0;
    (executor as Any).toolRegistry.executeTool = vi.fn(async () => {
      runAttempt += 1;
      return {
        success: false,
        exitCode: 1,
        error:
          runAttempt === 1
            ? "cannot complete this task because of a temporary blocker"
            : "cannot complete this task because a different blocker appeared",
      };
    });

    const handlePlanRevisionSpy = vi.spyOn(executor as Any, "handlePlanRevision");
    const failedStep: Any = { id: "1", description: "Run baseline task", status: "pending" };
    const retainedPendingStep: Any = { id: "2", description: "Validate output", status: "pending" };
    executor.plan = { description: "Plan", steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.planRevisionCount = 0;
    executor.recoveryRequestActive = true;

    await (executor as Any).executeStep(failedStep);
    await (executor as Any).executeStep(failedStep);

    expect(handlePlanRevisionSpy).not.toHaveBeenCalled();
    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("alternative toolchain")),
    ).toBe(false);
    expect(planDescriptions.length).toBe(2);
    expect(executor.planRevisionCount).toBe(0);
  });

  it("keeps existing plan steps unchanged when recovery insertion is not triggered", async () => {
    const executor = createExecutorWithStubs(
      [toolUseResponse("run_command", { command: "exit 1" }), textResponse("")],
      {
        run_command: { success: false, error: "exit code 1" },
      },
    );

    const failedStep: Any = { id: "1", description: "Run baseline task", status: "pending" };
    const retainedPendingStep: Any = { id: "2", description: "Validate output", status: "pending" };
    executor.plan = { description: "Plan", steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.recoveryRequestActive = true;
    executor.planRevisionCount = 0;

    await (executor as Any).executeStep(failedStep);

    expect(failedStep.status).toBe("completed");
    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("alternative toolchain")),
    ).toBe(false);
    expect(planDescriptions).toContain("Validate output");
    expect(planDescriptions.length).toBe(2);
  });

  it("does not auto-trigger recovery planning when user did not explicitly request recovery", async () => {
    const executor = createExecutorWithStubs(
      [toolUseResponse("run_command", { command: "exit 1" }), textResponse("")],
      {
        run_command: { success: false, error: "cannot complete this task without a workaround" },
      },
    );
    executor.recoveryRequestActive = false;
    const failedStep: Any = { id: "1", description: "Run baseline task", status: "pending" };
    const retainedPendingStep: Any = { id: "2", description: "Validate output", status: "pending" };
    executor.plan = { description: "Plan", steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.planRevisionCount = 0;
    (executor as Any).isRecoveryIntent = vi.fn((reason: string) =>
      reason.includes("cannot complete this task"),
    );

    await (executor as Any).executeStep(failedStep);

    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("alternative toolchain")),
    ).toBe(false);
    expect(failedStep.status).toBe("completed");
    expect(executor.planRevisionCount).toBe(0);
  });
});
