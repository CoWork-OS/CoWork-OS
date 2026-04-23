/**
 * Tests for step failure/verification behavior in TaskExecutor.executeStep
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
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
  executor.totalToolCallCount = 0;
  executor.webSearchToolCallCount = 0;
  executor.webSearchMode = "live";
  executor.webSearchMaxUsesPerTask = 8;
  executor.webSearchMaxUsesPerStep = 3;
  executor.webSearchAllowedDomains = [];
  executor.webSearchBlockedDomains = [];
  executor.toolSemanticsV2Enabled = true;
  executor.mutationEvidenceV2Enabled = true;
  executor.providerRetryV2Enabled = true;
  executor.mutationLoopStopV2Enabled = true;
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
  executor.artifactMutationLedger = Object.create(null);
  executor.stepContractReconciliationLedger = Object.create(null);
  executor.reliabilityContractReconciliationV3Enabled = true;
  executor.reliabilityStepMutationDedupeV3Enabled = true;
  executor.reliabilityBrowserChecklistV3Enabled = true;
  executor.currentStepId = null;
  executor.lastRecoveryFailureSignature = "";
  executor.recoveredFailureStepIds = new Set();
  executor.budgetConstrainedFailedStepIds = new Set();
  executor.nonBlockingVerificationFailedStepIds = new Set();
  executor.blockingVerificationFailedStepIds = new Set();
  executor.crossStepToolFailures = new Map();
  executor.dispatchedMentionedAgents = false;
  executor.lastAssistantText = null;
  executor.lastPreCompactionFlushAt = 0;
  executor.lastPreCompactionFlushTokenCount = 0;
  executor.observedOutputTokensPerSecond = null;
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
  executor.logTag = "[Executor:test]";
  executor.infraContextProvider = {
    getStatus: () => ({ enabled: false }),
  };
}

function createExecutorWithStubs(responses: LLMResponse[], toolResults: Record<string, Any>) {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  const fallbackTextResponse =
    [...responses]
      .reverse()
      .find(
        (response) =>
          response?.stopReason === "end_turn" &&
          Array.isArray(response?.content) &&
          response.content.some((block: Any) => block?.type === "text"),
      ) || null;

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
  executor.daemon = {
    logEvent: vi.fn(),
    getTaskEvents: vi.fn().mockReturnValue([]),
    updateTask: vi.fn(),
  };
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
    { name: "read_file", description: "", input_schema: { type: "object", properties: {} } },
    { name: "parse_document", description: "", input_schema: { type: "object", properties: {} } },
    { name: "read_pdf_visual", description: "", input_schema: { type: "object", properties: {} } },
    { name: "list_directory", description: "", input_schema: { type: "object", properties: {} } },
    { name: "get_file_info", description: "", input_schema: { type: "object", properties: {} } },
    { name: "system_info", description: "", input_schema: { type: "object", properties: {} } },
    { name: "infra_status", description: "", input_schema: { type: "object", properties: {} } },
    { name: "web_search", description: "", input_schema: { type: "object", properties: {} } },
    { name: "web_fetch", description: "", input_schema: { type: "object", properties: {} } },
    { name: "write_file", description: "", input_schema: { type: "object", properties: {} } },
    { name: "create_document", description: "", input_schema: { type: "object", properties: {} } },
    {
      name: "generate_document",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "create_spreadsheet",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "generate_spreadsheet",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "create_presentation",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "generate_presentation",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    { name: "create_diagram", description: "", input_schema: { type: "object", properties: {} } },
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
    resetMutationHistoryForNewStep: vi.fn(),
  };
  executor.toolResultMemoryLimit = 8;
  executor.toolRegistry = {
    executeTool: vi.fn(async (name: string) => {
      if (name in toolResults) return toolResults[name];
      return { success: true };
    }),
  };
  executor.toolExecutionCoordinator = {
    executeTool: vi.fn(async (name: string, input: Any) => {
      const result = await executor.toolRegistry.executeTool(name, input);
      return {
        result,
        durationMs: 0,
        resultJson: JSON.stringify(result),
        envelope: undefined,
        policyTrace: undefined,
      };
    }),
  };
  executor.callLLMWithRetry = vi.fn().mockImplementation(async () => {
    const response = responses.shift();
    if (!response && fallbackTextResponse) {
      return fallbackTextResponse;
    }
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
  executor.daemon = {
    logEvent: vi.fn(),
    getTaskEvents: vi.fn().mockReturnValue([]),
    updateTask: vi.fn(),
  };
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
    resetMutationHistoryForNewStep: vi.fn(),
  };
  executor.toolResultMemoryLimit = 8;
  executor.toolRegistry = {
    executeTool: vi.fn(async () => ({ success: true })),
  };
  executor.toolExecutionCoordinator = {
    executeTool: vi.fn(async (name: string, input: Any) => {
      const result = await executor.toolRegistry.executeTool(name, input);
      return {
        result,
        durationMs: 0,
        resultJson: JSON.stringify(result),
        envelope: undefined,
        policyTrace: undefined,
      };
    }),
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

  it("keeps the step failed when run_command fails even if a direct completion text follows", async () => {
    executor = createExecutorWithStubs(
      [toolUseResponse("run_command", { command: "exit 1" }), textResponse("done")],
      {
        run_command: { success: false, exitCode: 1 },
      },
    );

    const step: Any = { id: "1", description: "Execute a command", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(step.error).toBeDefined();
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

  it("suggests write_file as the fallback when create_document is unavailable for html output", () => {
    executor = createExecutorWithStubs([], {});

    const alternatives = (executor as Any).getUnavailableToolAlternatives(
      "create_document",
      { filename: "index.html" },
      new Set(["write_file", "read_file"]),
    );

    expect(alternatives).toEqual(["write_file"]);
  });

  it("allows a short direct-result final step after a prior successful run_command step", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "echo hello world" }),
        textResponse("Captured stdout."),
        textResponse("hello world"),
      ],
      {
        run_command: { success: true, stdout: "hello world\n", stderr: "", exitCode: 0 },
      },
    );

    const step1: Any = { id: "cmd-1", description: "Execute `echo hello world`.", status: "pending" };
    const step2: Any = { id: "cmd-2", description: "Return the result directly.", status: "pending" };
    (executor as Any).plan = { description: "Plan", steps: [step1, step2] };

    await (executor as Any).executeStep(step1);
    await (executor as Any).executeStep(step2);

    expect(step1.status).toBe("completed");
    expect(step2.status).toBe("completed");
    expect(String(step2.error || "")).toBe("");
  });

  it("allows one duplicate-bypass mutation attempt for mutation-required steps", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("write_file", {
          path: "script.js",
          content: "console.log('timeline');\n",
        }),
        textResponse("Implemented rendering logic."),
      ],
      {},
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-dup-bypass-");
    (executor as Any).workspace.path = tempDir;
    (executor as Any).reliabilityV2DisableBootstrapWrite = true;
    (executor as Any).toolCallDeduplicator.checkDuplicate = vi
      .fn()
      .mockReturnValue({ isDuplicate: true, reason: "duplicate_call" });
    (executor as Any).toolRegistry.executeTool = vi.fn(async (name: string, input: Any) => {
      if (name === "write_file") {
        const filePath = path.resolve(tempDir, String(input?.path || "script.js"));
        fs.writeFileSync(filePath, String(input?.content || ""), "utf8");
        return { success: true, path: "script.js" };
      }
      return { success: true };
    });

    const step: Any = {
      id: "dup-bypass-step",
      description: "Implement horizontal timeline rendering in `script.js`.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status, String(step.error || "")).toBe("completed");
      expect((executor as Any).daemon.logEvent).toHaveBeenCalledWith(
        "task-1",
        "mutation_duplicate_bypass_applied",
        expect.objectContaining({
          stepId: "dup-bypass-step",
          tool: "write_file",
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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

    expect(step.status, String(step.error || "")).toBe("completed");
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
        toolUseResponse("web_search", { query: "latest tech earnings" }),
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
        toolUseResponse("web_search", { query: "third blocked call" }),
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

  it("uses browser_session verification for in-browser UI checks even when mission images are mentioned", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("browser_navigate", { url: "http://localhost:3000" }),
        toolUseResponse("browser_get_content", {}),
        textResponse("OK"),
      ],
      {
        browser_navigate: { success: true, url: "http://localhost:3000" },
        browser_get_content: { success: true, content: "<html>timeline</html>" },
      },
    );
    (executor as Any).getAvailableTools = vi.fn().mockReturnValue([
      { name: "browser_navigate", description: "", input_schema: { type: "object", properties: {} } },
      { name: "browser_get_content", description: "", input_schema: { type: "object", properties: {} } },
      { name: "read_file", description: "", input_schema: { type: "object", properties: {} } },
    ]);

    const step: Any = {
      id: "verify-browser-session",
      description:
        "Final verification: test the site in-browser to confirm smooth horizontal scrolling, working toggles, and correctly sourced mission images.",
      status: "pending",
    };

    expect((executor as Any).resolveVerificationModeForStep(step)).toBe("browser_session");
    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(String(step.error || "")).toBe("");
  });

  it("does not require create_directory for root-file scaffold steps", () => {
    executor = createExecutorWithStubs([], {});

    const step: Any = {
      id: "root-scaffold",
      description:
        "Create the project scaffold in the workspace: add/overwrite index.html, styles.css, and script.js with a minimal layout.",
      status: "pending",
    };

    const contract = (executor as Any).resolveStepExecutionContract(step);
    expect(Array.from(contract.requiredTools)).toContain("write_file");
    expect(Array.from(contract.requiredTools)).not.toContain("create_directory");
  });

  it("passes browser-session final verification via deterministic checklist even when text is not OK", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("browser_navigate", { url: "http://localhost:3000" }),
        toolUseResponse("browser_get_content", {}),
        textResponse(
          "Browser session checks are complete: navigation succeeded, timeline container is visible, and toggle controls are present.",
        ),
      ],
      {
        browser_navigate: { success: true, url: "http://localhost:3000" },
        browser_get_content: {
          success: true,
          content:
            "<div id='timelineViewport'></div><div id='timelineTrack'></div><input id='whatIfToggle' type='checkbox' />",
        },
      },
    );
    (executor as Any).getAvailableTools = vi.fn().mockReturnValue([
      { name: "browser_navigate", description: "", input_schema: { type: "object", properties: {} } },
      { name: "browser_get_content", description: "", input_schema: { type: "object", properties: {} } },
    ]);

    const step: Any = {
      id: "verify-browser-checklist",
      description:
        "Final verification: test in-browser horizontal scroll, timeline track, and What If toggle behavior.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };
    expect((executor as Any).resolveVerificationModeForStep(step)).toBe("browser_session");

    await (executor as Any).executeStep(step);

    expect(step.status, String(step.error || "")).toBe("completed");
    expect((executor as Any).daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "verification_checklist_evaluated",
      expect.objectContaining({
        stepId: "verify-browser-checklist",
        passed: true,
      }),
    );
  });

  it("does not infer browser_session for file verification steps that only mention browser names", () => {
    executor = createExecutorWithStubs([], {});

    const step: Any = {
      id: "verify-markdown-browser-names",
      description:
        "Verify: confirm the target markdown file exists and contains the strings Browser and Microsoft Edge in the recommendations section.",
      status: "pending",
    };

    expect((executor as Any).resolveVerificationModeForStep(step)).toBe("artifact_file");
  });

  it("accepts artifact verification evidence from file inspection tools when step text is generic", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("get_file_info", { path: "inner_world.docx" }),
        toolUseResponse("read_file", { path: "inner_world.docx" }),
        textResponse("OK"),
      ],
      {
        get_file_info: { success: true, path: "inner_world.docx", size: 1234 },
        read_file: { success: true, path: "inner_world.docx", content: "The Quiet Atlas" },
      },
    );
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["inner_world.docx"]),
    };

    const step: Any = {
      id: "verify-artifact-generic",
      description:
        "Verify completion: ensure file exists, is DOCX, content length matches short target (roughly 120–160 words), and report the final path to the user.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(String(step.error || "")).toBe("");
  });

  it("rejects unrelated artifact inspection for generic verification steps", async () => {
    executor = createExecutorWithStubs(
      [toolUseResponse("read_file", { path: "other.docx" }), textResponse("OK")],
      {
        read_file: { success: true, path: "other.docx", content: "Unrelated content" },
      },
    );
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["inner_world.docx"]),
    };

    const step: Any = {
      id: "verify-artifact-unrelated",
      description:
        "Verify completion: ensure file exists, is DOCX, content length matches short target (roughly 120–160 words), and report the final path to the user.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("expected artifact file evidence");
  });

  it("rejects same-basename artifact inspection from a different directory", async () => {
    executor = createExecutorWithStubs(
      [toolUseResponse("read_file", { path: "tmp/report.docx" }), textResponse("OK")],
      {
        read_file: { success: true, path: "tmp/report.docx", content: "Wrong artifact" },
      },
    );
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["deliverables/report.docx"]),
    };

    const step: Any = {
      id: "verify-artifact-same-name-different-dir",
      description: "Verify completion: ensure the Word document is present and readable.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("expected artifact file evidence");
  });

  it("requires all prompt-required artifact types during artifact verification", async () => {
    executor = createExecutorWithStubs(
      [toolUseResponse("read_file", { path: "report.csv" }), textResponse("OK")],
      {
        read_file: { success: true, path: "report.csv", content: "col\n1" },
      },
    );
    (executor as Any).task.prompt = "Create both a CSV and JSON report file from this data.";
    expect((executor as Any).inferRequiredArtifactExtensions()).toEqual(
      expect.arrayContaining([".csv", ".json"]),
    );
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["misc.json", "report.csv"]),
    };

    const step: Any = {
      id: "verify-artifact-missing-type",
      description:
        "Verify completion: ensure all requested artifact files were produced and are readable.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("missing required artifact types");
    expect(String(step.error || "")).toContain(".json");
  });

  it("ignores strategy-context docx cues when inferring required artifact types", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    (executor as Any).task.prompt = `Create a fully working website simulating the Windows 95 UI.

[AGENT_STRATEGY_CONTEXT_V1]
relationship_memory:
- Completed task: create a short word document ... Outcome: inner_world.docx created.
[/AGENT_STRATEGY_CONTEXT_V1]`;

    expect((executor as Any).inferRequiredArtifactExtensions()).not.toContain(".docx");
  });

  it("still infers docx when the user explicitly requests a DOCX report", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    (executor as Any).task.prompt =
      "Create a DOCX report for this quarter and include a short executive summary.";

    expect((executor as Any).inferRequiredArtifactExtensions()).toContain(".docx");
  });

  it("does not require in-app canvas tools for app-internal canvas gameplay wording", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const step: Any = {
      id: "mini-app-canvas-wording",
      kind: "primary",
      description:
        "Implement Paint-lite or Minesweeper-style mini app with interactive canvas/grid gameplay.",
      status: "pending",
    };

    const contract = (executor as Any).resolveStepExecutionContract(step);
    expect(Array.from(contract.requiredTools)).not.toContain("canvas_create");
    expect(Array.from(contract.requiredTools)).not.toContain("canvas_push");
  });

  it("does not classify canvas/web verification wording as image verification", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const step: Any = {
      id: "verify-canvas-mode",
      kind: "primary",
      description:
        "Verify: run through at least one full test attempt to confirm timer behavior, scoring accuracy, results rendering, and restart/reset functionality.",
      status: "pending",
    };

    expect((executor as Any).stepRequiresImageVerification(step)).toBe(false);
    expect((executor as Any).resolveVerificationModeForStep(step)).toBe("canvas_session");
  });

  it("detects follow-up requests that require an in-app canvas action", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    expect(
      (executor as Any).followUpRequiresCanvasAction(
        "open the generated html inside this app canvas, not outside",
      ),
    ).toBe(true);
    expect((executor as Any).followUpRequiresCanvasAction("show it in app canvas")).toBe(true);
  });

  it("does not classify informational canvas follow-ups as required canvas actions", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    expect((executor as Any).followUpRequiresCanvasAction("what is in-app canvas?")).toBe(false);
    expect((executor as Any).followUpRequiresCanvasAction("ok thanks")).toBe(false);
  });

  it("treats inline Mermaid flowchart steps as diagram output rather than file artifacts", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const step: Any = {
      id: "diagram-contract",
      kind: "primary",
      description: "Create a Mermaid flowchart of a typical CI/CD pipeline and display it inline.",
      status: "pending",
    };

    const contract = (executor as Any).resolveStepExecutionContract(step);

    expect(Array.from(contract.requiredTools)).toContain("create_diagram");
    expect(contract.requiresArtifactEvidence).toBe(false);
    expect(contract.requiresMutation).toBe(true);
    expect(contract.artifactKind).toBe("diagram");
  });

  it("does not force artifact-file verification for Mermaid verification wording", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const step: Any = {
      id: "diagram-verify",
      kind: "verification",
      description: "Verify the Mermaid flowchart is displayed inline and includes the main CI/CD stages.",
      status: "pending",
    };

    expect((executor as Any).resolveVerificationModeForStep(step)).toBe("none");
  });

  it("does not classify command stdout and exit-code verification as artifact-file verification", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    (executor as Any).task.prompt = 'run command "echo hello world"';

    const step: Any = {
      id: "verify-command-output",
      kind: "verification",
      description: 'Verify the output is exactly `hello world` and the exit code is `0`.',
      status: "pending",
    };

    expect((executor as Any).resolveVerificationModeForStep(step)).toBe("none");
  });

  it("does not classify standard-output verification as artifact-file verification", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    (executor as Any).task.prompt = 'run command "echo hello world"';

    const step: Any = {
      id: "verify-stdout-output",
      kind: "verification",
      description: 'Verify that standard output is exactly `hello world`.',
      status: "pending",
    };

    expect((executor as Any).resolveVerificationModeForStep(step)).toBe("none");
  });

  it("does not classify heartbeat evidence review steps as artifact-file verification", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});

    const step: Any = {
      id: "verify-heartbeat-review",
      kind: "verification",
      description: "Review the most recent heartbeat evidence for Project Manager.",
      status: "pending",
    };

    expect((executor as Any).resolveVerificationModeForStep(step)).toBe("none");
  });

  it("accepts create_diagram as satisfying a diagram step mutation contract", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("create_diagram", {
          title: "CI/CD Pipeline",
          diagram:
            "flowchart TD\nA[Code] --> B[Build]\nB --> C[Test]\nC --> D[Deploy]",
        }),
        textResponse("Displayed the CI/CD pipeline as a Mermaid flowchart."),
      ],
      {
        create_diagram: { success: true, message: 'Diagram "CI/CD Pipeline" is now displayed in the UI.' },
      },
    );

    const step: Any = {
      id: "diagram-step",
      kind: "primary",
      description: "Create a Mermaid flowchart of a typical CI/CD pipeline and display it inline.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status, String(step.error || "")).toBe("completed");
    expect((executor as Any).toolRegistry.executeTool).toHaveBeenCalledWith(
      "create_diagram",
      expect.objectContaining({
        title: "CI/CD Pipeline",
      }),
    );
  });

  it("enforces required-tool contract when create_document is required but never called", async () => {
    executor = createExecutorWithStubs(
      Array.from({ length: 6 }, () => textResponse("Draft ready, final text prepared.")),
      {},
    );
    const step: Any = {
      id: "doc-contract",
      description:
        "Generate the DOCX via create_document with filename sample_inner_world.docx and validated content.",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toMatch(
      /Missing successful calls for: create_document|artifact_write_checkpoint_failed|written artifact/i,
    );
  });

  it("accepts generate_document when create_document is required by step wording", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("generate_document", {
          filename: "sample_inner_world.docx",
          markdown: "# Sample\n\nBody",
        }),
        textResponse("Generated sample_inner_world.docx"),
      ],
      {
        generate_document: {
          success: true,
          path: "sample_inner_world.docx",
          size: 1024,
        },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-doc-alias-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "sample_inner_world.docx"), "docx-bytes");

    const step: Any = {
      id: "doc-contract-generate-alias",
      description:
        "Generate the DOCX via create_document with filename sample_inner_world.docx and validated content.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      expect(String(step.error || "")).toBe("");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts canvas verification via canvas evidence without requiring image files", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("canvas_create", { title: "Mental Agility Test" }),
        toolUseResponse("canvas_push", {
          session_id: "session-1",
          content: "<!DOCTYPE html><html><body>app</body></html>",
        }),
        textResponse("OK"),
      ],
      {
        canvas_create: { success: true, session_id: "session-1" },
        canvas_push: { success: true },
      },
    );

    (executor as Any).getAvailableTools = vi.fn().mockReturnValue([
      { name: "canvas_create", description: "", input_schema: { type: "object", properties: {} } },
      { name: "canvas_push", description: "", input_schema: { type: "object", properties: {} } },
      { name: "read_file", description: "", input_schema: { type: "object", properties: {} } },
      { name: "glob", description: "", input_schema: { type: "object", properties: {} } },
    ]);

    const step: Any = {
      id: "verify-canvas-interaction",
      description:
        "Verify: run through at least one full test attempt to confirm timer behavior, scoring accuracy, results rendering, and restart/reset functionality.",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(String(step.error || "")).toBe("");
    expect((executor as Any).toolRegistry.executeTool).toHaveBeenCalledWith(
      "canvas_push",
      expect.any(Object),
    );
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

  it("reconciles create_directory-only contract misses when equivalent artifacts were written later", async () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const step1: Any = {
      id: "plan-scaffold-1",
      description:
        "Create scaffold: add/overwrite index.html, styles.css, script.js with timeline structure.",
      status: "pending",
    };
    const step2: Any = {
      id: "plan-impl-2",
      description: "Implement timeline rendering in script.js and wire controls.",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step1, step2] };
    (executor as Any).executeStep = vi.fn(async (target: Any) => {
      if (target.id === "plan-scaffold-1") {
        target.status = "failed";
        target.error =
          "Step required tool contract was not satisfied. Missing successful calls for: create_directory.";
        target.completedAt = Date.now();
        return;
      }

      target.status = "completed";
      target.completedAt = Date.now();
      const record = (executor as Any).recordArtifactMutationLedgerEntry.bind(executor);
      for (const relPath of ["index.html", "styles.css", "script.js"]) {
        record(relPath, {
          stepId: target.id,
          tool: "write_file",
          evidence: {
            tool_success: true,
            canonical_tool: "write_file",
            reported_path: path.resolve("/tmp", relPath),
            artifact_registered: true,
            fs_exists: true,
            mtime_after_step_start: true,
            size_bytes: 42,
          },
        });
      }
    });

    await expect((executor as Any).executePlan()).resolves.toBeUndefined();
    expect((executor as Any).daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "step_contract_reconciled_posthoc",
      expect.objectContaining({
        stepId: "plan-scaffold-1",
      }),
    );
  });

  it("returns from executePlan without emitting a timeout when the task was cancelled by the user", async () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const step: Any = { id: "plan-cancel-1", description: "Keep working", status: "pending" };
    (executor as Any).plan = { description: "Plan", steps: [step] };
    (executor as Any).executeStep = vi.fn(async () => {
      (executor as Any).cancelled = true;
      (executor as Any).cancelReason = "user";
      throw new Error("Request cancelled");
    });

    await expect((executor as Any).executePlan()).resolves.toBeUndefined();

    expect(step.status).not.toBe("failed");
    expect((executor as Any).daemon.logEvent).not.toHaveBeenCalledWith(
      "task-1",
      "step_timeout",
      expect.anything(),
    );
  });

  it("still emits step_timeout when the abort came from an execution timeout", async () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const step: Any = { id: "plan-timeout-1", description: "Keep working", status: "pending" };
    (executor as Any).plan = { description: "Plan", steps: [step] };
    (executor as Any).executeStep = vi.fn(async () => {
      (executor as Any).cancelled = true;
      (executor as Any).cancelReason = "timeout";
      throw new Error("Request cancelled");
    });

    await expect((executor as Any).executePlan()).rejects.toThrow("Task failed");

    expect(step.status).toBe("failed");
    expect((executor as Any).daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "step_timeout",
      expect.objectContaining({
        timeout: 900000,
        message: "Step timed out after 900s",
      }),
    );
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
          "Please choose the required input file path:\n1) inputs/demand-letter.txt\n2) inputs/buyer-demand-letter.txt\nReply with 1 or 2.",
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

  it("uses the last assistant explanation when finalizing a required-decision pause", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    (executor as Any).daemon.updateTaskStatus = vi.fn();
    (executor as Any).lastAwaitingUserInputReasonCode = "required_decision";
    (executor as Any).lastAssistantText =
      "Please choose the required input file path:\n1) inputs/demand-letter.txt\n2) inputs/buyer-demand-letter.txt\nReply with 1 or 2.";
    (executor as Any).lastAssistantOutput = (executor as Any).lastAssistantText;
    (executor as Any).lastNonVerificationOutput = "required_decision";
    (executor as Any).buildResultSummary = vi.fn().mockReturnValue("required_decision");
    (executor as Any).getContentFallback = vi.fn().mockReturnValue("required_decision");

    (executor as Any).pauseForOutstandingRequiredDecision();

    expect((executor as Any).daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "task_paused",
      expect.objectContaining({
        message: expect.stringContaining("Please choose the required input file path"),
        reason: "required_decision",
      }),
    );
  });

  it("planning guidance tells the model to collect missing user-specific facts", () => {
    executor = createExecutorWithStubs([], {});

    const prompt = (executor as Any).buildPlanningTurnGuidancePrompt({
      toolDescriptions: "",
      planningGuidance: "",
    });

    expect(prompt).toContain("user-specific facts");
    expect(prompt).toContain("exact dates, years, amounts, identifiers");
    expect(prompt).toContain("collect those facts from the user instead of inventing them");
  });

  it("pauses when verification feedback requires the user's exact dates", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          'This is not the requested deliverable.\n\nWhat needs to change:\n- Include the user’s actual dates or tax years, not "8+ years".\n- Keep it framed as the legal question, not the answer.',
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = true;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = {
      id: "3-dates",
      description: "Verification: one written problem statement with your dates.",
      status: "pending",
      kind: "verification",
    };

    await expect((executor as Any).executeStep(step)).rejects.toMatchObject({
      name: "AwaitingUserInputError",
    });
  });

  it("fails with user_action_required when required-input pauses are disabled", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "Please choose the required input file path:\n1) inputs/demand-letter.txt\n2) inputs/buyer-demand-letter.txt\nReply with 1 or 2.",
        ),
        textResponse(
          "Please choose the required input file path:\n1) inputs/demand-letter.txt\n2) inputs/buyer-demand-letter.txt\nReply with 1 or 2.",
        ),
        textResponse(
          "Please choose the required input file path:\n1) inputs/demand-letter.txt\n2) inputs/buyer-demand-letter.txt\nReply with 1 or 2.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = false;
    (executor as Any).shouldPauseForRequiredDecision = false;

    const step: Any = { id: "3b", description: "Clarify requirements", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toContain("User action required");
  });

  it("does not treat non-blocking exploratory questions as required-decision blockers", async () => {
    executor = createExecutorWithStubs(
      [textResponse("Who is the primary user for this feature and what outcomes matter most?")],
      {},
    );
    (executor as Any).shouldPauseForQuestions = false;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3d", description: "Explore product context", status: "pending" };

    await (executor as Any).executeStep(step);
    expect(step.status).toBe("completed");
  });

  it("does not pause on optional follow-up offers phrased as questions", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "I finished the scaffold and can keep going. If you want, I can run a quick compile-safety pass next.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = true;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3d2", description: "Continue implementation", status: "pending" };

    await (executor as Any).executeStep(step);
    expect(step.status).toBe("completed");
  });

  it("pauses when the assistant explicitly states it cannot continue without required input", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "I cannot continue until you provide the required App Group ID. Reply with the value to proceed.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = true;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3d3", description: "Configure app group", status: "pending" };

    await expect((executor as Any).executeStep(step)).rejects.toMatchObject({
      name: "AwaitingUserInputError",
    });
  });

  it("does not pause on non-question progress text that mentions integration availability", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "Captured command context and integration availability scope. Ready to proceed with the lightweight health checks.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = true;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3e", description: "Capture mention context", status: "pending" };

    await (executor as Any).executeStep(step);
    expect(step.status).toBe("completed");
  });

  it("pauses for required decisions even when autonomous question pausing is disabled", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          "1) Which counterparty demand file should I use?\n2) Confirm the agreement path.",
        ),
      ],
      {},
    );
    (executor as Any).shouldPauseForQuestions = false;
    (executor as Any).shouldPauseForRequiredDecision = true;

    const step: Any = { id: "3c", description: "Resolve required documents", status: "pending" };

    await expect((executor as Any).executeStep(step)).rejects.toMatchObject({
      name: "AwaitingUserInputError",
    });
  });

  it("does not fail a step as limitation-only when tools already ran and only input-dependent errors occurred", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("glob", { pattern: "**/*" }),
        toolUseResponse("read_file", { path: "." }),
        textResponse(
          "I cannot run deeper telemetry in this environment, but fallback checks completed with current evidence.",
        ),
      ],
      {
        glob: { success: true, matches: ["tmp.txt"] },
      },
    );
    (executor as Any).toolRegistry.executeTool = vi.fn(async (name: string) => {
      if (name === "read_file") {
        throw new Error("Failed to read file: EISDIR: illegal operation on a directory, read");
      }
      if (name === "glob") {
        return { success: true, matches: ["tmp.txt"] };
      }
      return { success: true };
    });

    const step: Any = { id: "3f", description: "Fallback lane checks", status: "pending" };

    await (executor as Any).executeStep(step);
    expect(step.status).toBe("completed");
    expect(String(step.error || "")).not.toContain("limitation statement");
  });

  it("skips quality refine passes for recovery steps even when qualityPasses=2", async () => {
    executor = createExecutorWithStubs([textResponse("Fallback path complete.")], {});
    (executor as Any).task.agentConfig = { qualityPasses: 2 };
    const step: Any = {
      id: "3g",
      description: "Summary fallback lane outcome",
      status: "pending",
      kind: "recovery",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect((executor as Any).callLLMWithRetry).toHaveBeenCalledTimes(1);
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

  it("normalizes web_search region EU to ALL for Brave API compatibility", () => {
    executor = createExecutorWithStubs([], {});

    const inferred = (executor as Any).inferMissingParameters("web_search", {
      query: "AI Act legal personhood",
      region: "EU",
    });

    expect(inferred.modified).toBe(true);
    expect(inferred.input.region).toBe("ALL");
    expect(inferred.inference).toMatch(/EU.*ALL/);
  });

  it("fails write/create deliverable steps when no file mutation evidence exists", async () => {
    executor = createExecutorWithStubs(
      Array.from({ length: 6 }, () =>
        textResponse("I wrote the complete whitepaper and it is ready."),
      ),
      {},
    );

    const step: Any = {
      id: "artifact-1",
      description: "Write the complete KARU founding whitepaper document",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(String(step.error || "")).toMatch(
      /Missing successful calls for: write_file|artifact_write_checkpoint_failed|written artifact/i,
    );
  });

  it("re-prompts mutation-required steps that try to finish with text-only output before writing", async () => {
    const responses: LLMResponse[] = [
      textResponse("I wrote the complete whitepaper and it is ready."),
      toolUseResponse("write_file", {
        path: "KARU_Whitepaper.md",
        content: "# KARU founding whitepaper\n",
      }),
      textResponse("Done."),
    ];

    executor = createExecutorWithStubs(responses, {
      write_file: {
        success: true,
        path: "/tmp/KARU_Whitepaper.md",
      },
    });

    const step: Any = {
      id: "artifact-end-turn-1",
      description: "Write the complete KARU founding whitepaper document",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect((executor.toolRegistry.executeTool as Any).mock.calls).toEqual([
      [
        "write_file",
        {
          path: "KARU_Whitepaper.md",
          content: "# KARU founding whitepaper\n",
        },
      ],
    ]);
    expect((executor.callLLMWithRetry as Any).mock.calls.length).toBeGreaterThanOrEqual(3);

    const finalUserMessage = (executor.conversationHistory as Any[])
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.content)
      .flat()
      .filter((block: Any) => block?.type === "text")
      .map((block: Any) => String(block.text || ""))
      .find((text: string) => text.includes("Do not finalize this step with text-only output."));

    expect(finalUserMessage).toContain("workspace/canvas mutation is still required");
  });

  it("does not treat directory-only mutation evidence as satisfying write contract", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const tempDir = fs.mkdtempSync("/tmp/cowork-dir-evidence-");
    (executor as Any).workspace.path = tempDir;
    const dirPath = path.join(tempDir, "backend/src/services/ais");
    fs.mkdirSync(dirPath, { recursive: true });

    try {
      const satisfies = (executor as Any).mutationEvidenceSatisfiesWriteContract({
        tool_success: true,
        canonical_tool: "create_directory",
        reported_path: dirPath,
        artifact_registered: true,
        fs_exists: true,
        mtime_after_step_start: true,
        size_bytes: null,
      });
      expect(satisfies).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats verified run_command workspace writes as satisfying write_file contract", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", {
          command: "mkdir -p research/wiki && printf '# Research Wiki\\n' > research/wiki/index.md",
        }),
        textResponse("Saved research/wiki/index.md"),
      ],
      {},
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-run-command-write-");
    (executor as Any).workspace.path = tempDir;
    (executor as Any).toolRegistry.executeTool = vi.fn(async (name: string) => {
      if (name === "run_command") {
        const targetPath = path.join(tempDir, "research/wiki/index.md");
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, "# Research Wiki\n");
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      }
      return { success: true };
    });

    const step: Any = {
      id: "artifact-run-command-write",
      description: "Write the research vault home note to `research/wiki/index.md`.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      expect(String(step.error || "")).toBe("");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats run_command task file events as satisfying write_file contract when the command mutates a workspace file", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "node scripts/build-wiki.js" }),
        textResponse("Saved the research wiki home note."),
      ],
      {},
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-run-command-event-write-");
    const mutationEvents: Any[] = [];
    (executor as Any).workspace.path = tempDir;
    (executor as Any).daemon.getTaskEvents = vi.fn((_taskId: string, opts?: Any) => {
      const requestedTypes = Array.isArray(opts?.types) ? new Set(opts.types) : null;
      return mutationEvents.filter((event) => !requestedTypes || requestedTypes.has(event.type));
    });
    (executor as Any).toolRegistry.executeTool = vi.fn(async (name: string) => {
      if (name === "run_command") {
        const relativePath = "research/wiki/home.md";
        const targetPath = path.join(tempDir, relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, "# Home\n");
        mutationEvents.push({
          id: "evt-1",
          taskId: "task-1",
          type: "file_created",
          timestamp: Date.now(),
          payload: { path: relativePath },
        });
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      }
      return { success: true };
    });

    const step: Any = {
      id: "artifact-run-command-event-write",
      description: "Write the research wiki home note.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      expect(String(step.error || "")).toBe("");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat run_command path mentions without a real file write as mutation evidence", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const tempDir = fs.mkdtempSync("/tmp/cowork-run-command-path-only-");
    (executor as Any).workspace.path = tempDir;

    try {
      const evidence = (executor as Any).collectMutationEvidence({
        toolName: "run_command",
        input: {
          command: "printf 'planned output: research/wiki/index.md\\n'",
        },
        result: {
          success: true,
          stdout: "planned output: research/wiki/index.md\n",
          stderr: "",
          exitCode: 0,
        },
        stepStartedAt: Date.now(),
      });
      expect(evidence).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat directory-only run_command mutations as satisfying write contract", () => {
    executor = createExecutorWithStubs([textResponse("done")], {});
    const tempDir = fs.mkdtempSync("/tmp/cowork-run-command-dir-only-");
    (executor as Any).workspace.path = tempDir;

    try {
      fs.mkdirSync(path.join(tempDir, "research/wiki"), { recursive: true });
      const evidence = (executor as Any).collectMutationEvidence({
        toolName: "run_command",
        input: { command: "mkdir -p research/wiki" },
        result: { success: true, stdout: "", stderr: "", exitCode: 0 },
        stepStartedAt: Date.now(),
      });
      expect(evidence).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails fast with write checkpoint when required write_file is never attempted", async () => {
    const responses: LLMResponse[] = Array.from({ length: 16 }, (_, i) =>
      toolUseResponse("create_directory", { path: `backend/src/services/ais/p${i}` }),
    );
    executor = createExecutorWithStubs(responses, {});
    (executor as Any).getAvailableTools = vi.fn().mockReturnValue([
      { name: "create_directory", description: "", input_schema: { type: "object", properties: {} } },
      { name: "write_file", description: "", input_schema: { type: "object", properties: {} } },
      { name: "list_directory", description: "", input_schema: { type: "object", properties: {} } },
      { name: "read_file", description: "", input_schema: { type: "object", properties: {} } },
    ]);
    const tempDir = fs.mkdtempSync("/tmp/cowork-required-write-checkpoint-");
    (executor as Any).workspace.path = tempDir;
    (executor as Any).toolRegistry.executeTool = vi.fn(async (name: string, input: Any) => {
      if (name === "create_directory") {
        const relPath = String(input?.path || "");
        fs.mkdirSync(path.resolve(tempDir, relPath), { recursive: true });
        return { success: true, path: relPath };
      }
      return { success: true };
    });

    const step: Any = {
      id: "ais-ingestion-write-checkpoint",
      description:
        "Implement AIS ingestion in `/backend/src/services/ais/` with separate connectors (`backend/marinetrafficClient.ts`, `backend/unAisClient.ts`) and a normalizer (`backend/normalizeAisRecord.ts`) that outputs a unified schema.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("failed");
      expect(String(step.error || "")).toMatch(
        /artifact_write_checkpoint_failed|tool-only turns with policy-blocked/i,
      );
      expect((executor as Any).callLLMWithRetry.mock.calls.length).toBeLessThanOrEqual(7);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat reported artifact path alone as successful mutation evidence", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training.pptx",
          slides: [{ title: "Intro", bullets: ["A"] }],
        }),
        ...Array.from({ length: 6 }, () => textResponse("Saved contract_negotiation_training.pptx")),
      ],
      {
        generate_presentation: {
          success: true,
          path: "contract_negotiation_training.pptx",
          slideCount: 1,
        },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-pptx-missing-");
    (executor as Any).workspace.path = tempDir;

    const step: Any = {
      id: "artifact-generate-pptx-missing",
      description:
        "Create output file contract_negotiation_training.pptx and ensure the presentation is written",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("failed");
      expect(String(step.error || "")).toMatch(
        /missing successful calls for: write_file|artifact_write_checkpoint_failed|written artifact/i,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
    const tempDir = fs.mkdtempSync("/tmp/cowork-write-file-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "KARU_Whitepaper.md"), "# KARU");

    const step: Any = {
      id: "artifact-2",
      description: "Write the complete KARU founding whitepaper document",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not fail descriptive meta steps for mutation when they do not express read-only intent", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("write_file", { path: "report.md", content: "# Findings" }),
        textResponse("Saved the markdown report."),
      ],
      {
        write_file: { success: true, path: "report.md" },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-meta-step-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "report.md"), "# Findings");

    const step: Any = {
      id: "meta-output-step",
      description: "Output should be a written Markdown report unless you want a different format later.",
      status: "pending",
    };

    try {
      expect((executor as Any).resolveStepExecutionContract(step).mode).toBe("analysis_only");
      await (executor as Any).executeStep(step);
      expect(step.status, String(step.error || "")).toBe("completed");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("still fails true inspection steps when they mutate the workspace", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("write_file", { path: "report.md", content: "# Findings" }),
        textResponse("Saved the markdown report."),
      ],
      {
        write_file: { success: true, path: "report.md" },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-inspection-step-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "report.md"), "# Findings");

    const step: Any = {
      id: "inspection-step",
      description: "Inspect the current landing page structure and review the existing files before changing anything.",
      status: "pending",
    };

    try {
      expect((executor as Any).resolveStepExecutionContract(step).mode).toBe("analysis_only");
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("failed");
      expect(String(step.error || "")).toContain("Analysis/inspection step performed a workspace mutation");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reuses prior mutation evidence for refinement steps when current-step target verification is present", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("read_file", { path: "styles.css" }),
        textResponse("Validated existing style changes."),
      ],
      {
        read_file: { success: true, path: "styles.css", content: "/* styles */" },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-prior-mutation-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "styles.css"), "/* previous */");
    const normalizedTarget = path
      .resolve(tempDir, "styles.css")
      .replace(/\\/g, "/")
      .toLowerCase();
    (executor as Any).artifactMutationLedger = {
      [normalizedTarget]: {
        stepId: "step-previous",
        ts: Date.now() - 5000,
        tool: "write_file",
        evidence: {
          tool_success: true,
          canonical_tool: "write_file",
          reported_path: path.resolve(tempDir, "styles.css"),
          artifact_registered: true,
          fs_exists: true,
          mtime_after_step_start: true,
          size_bytes: 12,
        },
      },
    };

    const step: Any = {
      id: "style-refinement",
      description: "Style interactions in `styles.css`: refine hover states and spacing.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      expect(executor.daemon.logEvent).toHaveBeenCalledWith(
        "task-1",
        "step_contract_satisfied_by_prior_mutation",
        expect.objectContaining({
          stepId: "style-refinement",
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not reuse prior mutation evidence when step explicitly requires new delta creation", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("read_file", { path: "styles.css" }),
        ...Array.from({ length: 6 }, () => textResponse("Reviewed styles file.")),
      ],
      {
        read_file: { success: true, path: "styles.css", content: "/* styles */" },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-prior-mutation-explicit-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "styles.css"), "/* previous */");
    const normalizedTarget = path
      .resolve(tempDir, "styles.css")
      .replace(/\\/g, "/")
      .toLowerCase();
    (executor as Any).artifactMutationLedger = {
      [normalizedTarget]: {
        stepId: "step-previous",
        ts: Date.now() - 5000,
        tool: "write_file",
        evidence: {
          tool_success: true,
          canonical_tool: "write_file",
          reported_path: path.resolve(tempDir, "styles.css"),
          artifact_registered: true,
          fs_exists: true,
          mtime_after_step_start: true,
          size_bytes: 12,
        },
      },
    };

    const step: Any = {
      id: "style-explicit-delta",
      description: "Implement new interactions in `styles.css` and add new animation classes.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("failed");
      expect(String(step.error || "")).toMatch(
        /missing successful calls for: write_file|artifact_write_checkpoint_failed|written artifact/i,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not count deterministic bootstrap as success when target file already exists and is non-empty", async () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const tempDir = fs.mkdtempSync("/tmp/cowork-bootstrap-existing-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "styles.css"), "body { color: red; }\n");

    const step: Any = { id: "bootstrap-existing", description: "Style interactions", status: "pending" };
    const stepContract: Any = {
      requiredTools: new Set(["write_file"]),
      mode: "mutation_required",
      requiresMutation: true,
      requiresArtifactEvidence: true,
      targetPaths: ["styles.css"],
      requiredExtensions: [".css"],
      enforcementLevel: "strict",
      contractReason: "step_requires_artifact_mutation",
      verificationMode: "none",
      artifactKind: "file",
    };

    try {
      const bootstrap = await (executor as Any).performDeterministicArtifactBootstrap(
        step,
        stepContract,
      );
      expect(bootstrap.attempted).toBe(true);
      expect(bootstrap.succeeded).toBe(false);
      expect(bootstrap.error).toBe("target_already_exists_nonempty");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("bootstraps missing css artifacts and records prior-mutation ledger evidence", async () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const tempDir = fs.mkdtempSync("/tmp/cowork-bootstrap-css-");
    (executor as Any).workspace.path = tempDir;

    const step: Any = { id: "bootstrap-css", description: "Style interactions", status: "pending" };
    const stepContract: Any = {
      requiredTools: new Set(["write_file"]),
      mode: "mutation_required",
      requiresMutation: true,
      requiresArtifactEvidence: true,
      targetPaths: ["styles.css"],
      requiredExtensions: [".css"],
      enforcementLevel: "strict",
      contractReason: "step_requires_artifact_mutation",
      verificationMode: "none",
      artifactKind: "file",
    };

    try {
      const bootstrap = await (executor as Any).performDeterministicArtifactBootstrap(
        step,
        stepContract,
      );
      expect(bootstrap.attempted).toBe(true);
      expect(bootstrap.succeeded).toBe(true);

      const written = fs.readFileSync(path.join(tempDir, "styles.css"), "utf8");
      expect(written).toContain("bootstrap artifact stub");

      const normalizedTarget = path
        .resolve(tempDir, "styles.css")
        .replace(/\\/g, "/")
        .toLowerCase();
      expect((executor as Any).artifactMutationLedger[normalizedTarget]).toBeTruthy();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers synthesized directory+basename target for deterministic bootstrap", async () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const tempDir = fs.mkdtempSync("/tmp/cowork-bootstrap-synth-");
    (executor as Any).workspace.path = tempDir;

    const step: Any = {
      id: "bootstrap-synth",
      description:
        "Create chokepoint analytics module in `server/src/chokepoints/` and write `chokepointMonitor.ts`.",
      status: "pending",
    };
    const stepContract: Any = {
      requiredTools: new Set(["write_file"]),
      mode: "mutation_required",
      requiresMutation: true,
      requiresArtifactEvidence: true,
      targetPaths: ["server/src/chokepoints/", "chokepointMonitor.ts"],
      requiredExtensions: [".ts"],
      enforcementLevel: "strict",
      contractReason: "step_requires_artifact_mutation",
      verificationMode: "none",
      artifactKind: "file",
    };

    try {
      const preferred = (executor as Any).getPreferredMutationTargetPath(step, stepContract);
      expect(preferred).toBe(path.join("server/src/chokepoints", "chokepointMonitor.ts"));

      const bootstrap = await (executor as Any).performDeterministicArtifactBootstrap(
        step,
        stepContract,
      );
      expect(bootstrap.attempted).toBe(true);
      expect(bootstrap.succeeded).toBe(true);
      expect(bootstrap.path).toBe(path.resolve(tempDir, "server/src/chokepoints/chokepointMonitor.ts"));
      expect(fs.existsSync(path.join(tempDir, "server/src/chokepoints/chokepointMonitor.ts"))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to second candidate when first target already exists and is non-empty", async () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const tempDir = fs.mkdtempSync("/tmp/cowork-bootstrap-fallback-existing-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "styles.css"), "body { color: red; }\n");

    const step: Any = {
      id: "bootstrap-existing-fallback",
      description: "Update styles in `styles.css` and `alt/styles.css`.",
      status: "pending",
    };
    const stepContract: Any = {
      requiredTools: new Set(["write_file"]),
      mode: "mutation_required",
      requiresMutation: true,
      requiresArtifactEvidence: true,
      targetPaths: ["styles.css", "alt/styles.css"],
      requiredExtensions: [".css"],
      enforcementLevel: "strict",
      contractReason: "step_requires_artifact_mutation",
      verificationMode: "none",
      artifactKind: "file",
    };

    try {
      const bootstrap = await (executor as Any).performDeterministicArtifactBootstrap(
        step,
        stepContract,
      );
      expect(bootstrap.attempted).toBe(true);
      expect(bootstrap.succeeded).toBe(true);
      expect(bootstrap.path).toBe(path.resolve(tempDir, "alt/styles.css"));
      expect(fs.readFileSync(path.join(tempDir, "alt/styles.css"), "utf8")).toContain(
        "bootstrap artifact stub",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips unsupported extensions and succeeds on later supported candidate", async () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const tempDir = fs.mkdtempSync("/tmp/cowork-bootstrap-fallback-ext-");
    (executor as Any).workspace.path = tempDir;

    const step: Any = {
      id: "bootstrap-ext-fallback",
      description: "Write `notes.unsupported` and `server/src/chokepoints/chokepointMonitor.ts`.",
      status: "pending",
    };
    const stepContract: Any = {
      requiredTools: new Set(["write_file"]),
      mode: "mutation_required",
      requiresMutation: true,
      requiresArtifactEvidence: true,
      targetPaths: ["notes.unsupported", "server/src/chokepoints/chokepointMonitor.ts"],
      requiredExtensions: [".unsupported", ".ts"],
      enforcementLevel: "strict",
      contractReason: "step_requires_artifact_mutation",
      verificationMode: "none",
      artifactKind: "file",
    };

    try {
      const bootstrap = await (executor as Any).performDeterministicArtifactBootstrap(
        step,
        stepContract,
      );
      expect(bootstrap.attempted).toBe(true);
      expect(bootstrap.succeeded).toBe(true);
      expect(bootstrap.path).toBe(path.resolve(tempDir, "server/src/chokepoints/chokepointMonitor.ts"));
      expect(fs.existsSync(path.join(tempDir, "server/src/chokepoints/chokepointMonitor.ts"))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds write-recovery hints with preferred writable file target instead of directory token", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const step: Any = {
      id: "write-recovery-path",
      description:
        "Create chokepoint analytics module in `server/src/chokepoints/` and write `chokepointMonitor.ts`.",
      status: "pending",
    };
    const stepContract: Any = {
      requiredTools: new Set(["write_file"]),
      mode: "mutation_required",
      requiresMutation: true,
      requiresArtifactEvidence: true,
      targetPaths: ["server/src/chokepoints/", "chokepointMonitor.ts"],
      requiredExtensions: [".ts"],
      enforcementLevel: "strict",
      contractReason: "step_requires_artifact_mutation",
      verificationMode: "none",
      artifactKind: "file",
    };

    const template = (executor as Any).buildWriteRecoveryTemplate(step, stepContract);
    expect(template.templateId).toContain("write_recovery");
    expect(JSON.stringify(template.steps)).toContain("server/src/chokepoints/chokepointMonitor.ts");
    expect(JSON.stringify(template.steps)).not.toContain('"server/src/chokepoints/"');
  });

  it("uses create_diagram recovery for inline diagram mutation steps", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const step: Any = {
      id: "diagram-recovery-step",
      description: "Build your personal tax timeline",
      status: "pending",
    };
    const stepContract: Any = {
      requiredTools: new Set(["create_diagram"]),
      mode: "mutation_required",
      requiresMutation: true,
      requiresArtifactEvidence: true,
      targetPaths: [],
      requiredExtensions: [],
      enforcementLevel: "strict",
      contractReason: "step_requires_artifact_mutation",
      verificationMode: "none",
      artifactKind: "diagram",
    };

    const template = (executor as Any).buildWriteRecoveryTemplate(step, stepContract);
    expect(template.templateId).toBe("write_recovery:create_diagram");
    expect(JSON.stringify(template.steps)).toContain("create_diagram");
    expect(JSON.stringify(template.steps)).not.toContain("write_file");
  });

  it("treats generate_presentation as valid mutation evidence for write-required steps", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training.pptx",
          slides: [{ title: "Intro", bullets: ["A"] }],
        }),
        textResponse("Saved contract_negotiation_training.pptx"),
      ],
      {
        generate_presentation: {
          success: true,
          path: "contract_negotiation_training.pptx",
          slideCount: 1,
        },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-pptx-alias-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "contract_negotiation_training.pptx"), "pptx-bytes");

    const step: Any = {
      id: "artifact-generate-pptx-1",
      description:
        "Create output file contract_negotiation_training.pptx and ensure the presentation is written",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      expect(String(step.error || "")).not.toContain("artifact_write_checkpoint_failed");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not trigger first-write checkpoint failure after repeated successful generate_presentation calls", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training_v1.pptx",
          slides: [{ title: "Intro", bullets: ["A"] }],
        }),
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training_v2.pptx",
          slides: [{ title: "Scope", bullets: ["B"] }],
        }),
        toolUseResponse("generate_presentation", {
          filename: "contract_negotiation_training_v3.pptx",
          slides: [{ title: "Close", bullets: ["C"] }],
        }),
        textResponse("Completed the presentation outline and generated the deck."),
      ],
      {
        generate_presentation: {
          success: true,
          path: "contract_negotiation_training.pptx",
          slideCount: 3,
        },
      },
    );
    const tempDir = fs.mkdtempSync("/tmp/cowork-pptx-retry-");
    (executor as Any).workspace.path = tempDir;
    fs.writeFileSync(path.join(tempDir, "contract_negotiation_training.pptx"), "pptx-bytes");

    const step: Any = {
      id: "artifact-generate-pptx-2",
      description:
        "Set up workspace and create output file contract_negotiation_training.pptx with a full presentation draft",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      expect(String(step.error || "")).not.toContain("first_write_checkpoint_no_attempt");
      expect(String(step.error || "")).not.toContain("artifact_write_checkpoint_failed");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("inserts a deterministic recovery plan before artifact breaker skips remaining steps", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    (executor as Any).autoRecoveryStepsPlanned = 0;
    (executor as Any).budgetContract = { maxAutoRecoverySteps: 2 };
    (executor as Any).requestPlanRevision = vi.fn().mockReturnValue(true);
    (executor as Any).recoveredFailureStepIds = new Set<string>();

    const failedStep: Any = {
      id: "failed-artifact-step",
      description:
        "Create chokepoint analytics module in `server/src/chokepoints/` and write `chokepointMonitor.ts`.",
      status: "failed",
      error:
        "Step contract failure [contract_unmet_write_required][artifact_write_checkpoint_failed]: iteration 7 reached without successful file/canvas mutation.",
    };

    const inserted = (executor as Any).tryInjectArtifactRecoveryBeforeCircuitBreaker(failedStep, 2);
    expect(inserted).toBe(true);
    expect((executor as Any).requestPlanRevision).toHaveBeenCalledTimes(1);
    expect((executor as Any).autoRecoveryStepsPlanned).toBe(1);
    expect((executor as Any).recoveredFailureStepIds.has("failed-artifact-step")).toBe(true);
  });

  it("keeps breaker behavior when recovery insertion is blocked by budget", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    (executor as Any).autoRecoveryStepsPlanned = 1;
    (executor as Any).budgetContract = { maxAutoRecoverySteps: 1 };
    (executor as Any).requestPlanRevision = vi.fn().mockReturnValue(true);
    (executor as Any).recoveredFailureStepIds = new Set<string>();

    const failedStep: Any = {
      id: "failed-artifact-step-budget",
      description: "Expose backend services in `server/src/api/` and write `routes.ts`.",
      status: "failed",
      error:
        "Step contract failure [contract_unmet_write_required][artifact_write_checkpoint_failed]: iteration 7 reached without successful file/canvas mutation.",
    };

    const inserted = (executor as Any).tryInjectArtifactRecoveryBeforeCircuitBreaker(failedStep, 2);
    expect(inserted).toBe(false);
    expect((executor as Any).requestPlanRevision).not.toHaveBeenCalled();
  });

  it("allows distinct file writes after first mutation success in the same step", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("write_file", {
          path: "win95-ui/scripts/main.js",
          content: "export const start = true;\n",
        }),
        toolUseResponse("write_file", {
          path: "win95-ui/scripts/apps.js",
          content: "export const apps = [];\n",
        }),
        textResponse("Scaffolded launcher scripts."),
      ],
      {},
    );

    const tempDir = fs.mkdtempSync("/tmp/cowork-multi-write-");
    (executor as Any).workspace.path = tempDir;
    (executor as Any).toolRegistry.executeTool = vi.fn(async (name: string, input: Any) => {
      if (name === "write_file") {
        const relPath = String(input?.path || "").trim();
        const absolutePath = path.resolve(tempDir, relPath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, String(input?.content || ""), "utf8");
        return { success: true, path: relPath };
      }
      return { success: true };
    });

    const step: Any = {
      id: "artifact-multi-write-1",
      description: "Create `win95-ui/scripts/main.js` and `win95-ui/scripts/apps.js` with starter code.",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
      const writeCalls = ((executor as Any).toolRegistry.executeTool as Any).mock.calls.filter(
        (call: Any[]) => call[0] === "write_file",
      );
      expect(writeCalls.length).toBe(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts artifact presence for compile/summary steps without requiring new writes", async () => {
    executor = createExecutorWithStubs([textResponse("Compiled summary is complete.")], {});
    const existingArtifact = "/tmp/KARU_Whitepaper.md";
    fs.writeFileSync(existingArtifact, "# Existing artifact\n");
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["KARU_Whitepaper.md"]),
    };

    const step: Any = {
      id: "artifact-presence-1",
      description: "Prepare final summary document for KARU_Whitepaper.md",
      status: "pending",
    };

    try {
      await (executor as Any).executeStep(step);
      expect(step.status).toBe("completed");
    } finally {
      try {
        fs.unlinkSync(existingArtifact);
      } catch {
        // Ignore cleanup failures in test env.
      }
    }
  });

  it("requires step-local artifact evidence for compile/summary steps", async () => {
    executor = createExecutorWithStubs([textResponse("Prepared final summary.")], {});
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      // Simulate a previously created file from earlier steps, with no new writes in this step.
      getCreatedFiles: vi.fn().mockReturnValue(["earlier_artifact.md"]),
    };

    const step: Any = {
      id: "artifact-presence-2",
      description: "Prepare final summary document",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("failed");
    expect(step.error).toContain("artifact reference/presence");
  });

  it("accepts current-step target inspection evidence for compile/summary steps", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("read_file", { path: "deliverables/final-summary.md" }),
        textResponse("Prepared final summary from the inspected artifact."),
      ],
      {
        read_file: {
          success: true,
          path: "deliverables/final-summary.md",
          content: "# Final summary\n",
        },
      },
    );
    (executor as Any).fileOperationTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue(["earlier_artifact.md"]),
    };

    const step: Any = {
      id: "artifact-presence-inspected",
      description: "Prepare final summary document in deliverables/final-summary.md",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status, String(step.error || "")).toBe("completed");
  });

  it("does not require artifact evidence when step explicitly allows inline output", async () => {
    executor = createExecutorWithStubs([textResponse("Here is the inventory inline.")], {});

    const step: Any = {
      id: "artifact-inline-1",
      description: "Compile final output into artifacts/box_file_inventory.md (or return inline)",
      status: "pending",
    };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(step.error).toBeUndefined();
  });

  it("enforces hard tool-call budget contracts", () => {
    executor = createExecutorWithStubs([], {});
    (executor as Any).budgetContractsEnabled = true;
    (executor as Any).budgetContract = {
      maxTurns: 20,
      maxToolCalls: 1,
      maxWebSearchCalls: 1,
      maxConsecutiveSearchSteps: 2,
      maxAutoRecoverySteps: 1,
    };
    (executor as Any).totalToolCallCount = 1;
    (executor as Any).webSearchToolCallCount = 1;
    (executor as Any).webSearchMaxUsesPerTask = 4;
    (executor as Any).webSearchMaxUsesPerStep = 3;

    expect(() => (executor as Any).enforceToolBudget("write_file")).toThrow("Tool-call budget");
    (executor as Any).totalToolCallCount = 0;
    expect(() => (executor as Any).enforceToolBudget("web_search")).not.toThrow();
    const webSearchBudgetCheck = (executor as Any).evaluateWebSearchPolicyAndBudget({ query: "x" }, 0);
    expect(webSearchBudgetCheck.blocked).toBe(true);
    expect(webSearchBudgetCheck.failureClass).toBe("budget_exhausted");
    expect(webSearchBudgetCheck.scope).toBe("task");
  });

  it("clamps per-call web_search maxUses by task and step policy limits", () => {
    executor = createExecutorWithStubs([], {});
    (executor as Any).budgetContractsEnabled = true;
    (executor as Any).budgetContract = {
      maxTurns: 20,
      maxToolCalls: 10,
      maxWebSearchCalls: 4,
      maxConsecutiveSearchSteps: 2,
      maxAutoRecoverySteps: 1,
    };
    (executor as Any).webSearchMaxUsesPerTask = 5;
    (executor as Any).webSearchMaxUsesPerStep = 3;

    const taskLimit = (executor as Any).getEffectiveWebSearchTaskLimit({ maxUses: 10 });
    const stepLimit = (executor as Any).getEffectiveWebSearchStepLimit({ maxUses: 10 });

    expect(taskLimit).toBe(4);
    expect(stepLimit).toBe(3);
  });

  it("accepts structured checklist verification responses when all required checks pass", async () => {
    executor = createExecutorWithStubs(
      [
        textResponse(
          [
            "Final editorial checklist:",
            "- Sections: PASS (all mandatory sections present)",
            "- Claims sourced: PASS (all claims cite sources)",
            "- Links valid: PASS (all links verified)",
            "- Word count: PASS (within target range)",
            "- Style: PASS (tone and style align with template)",
          ].join("\n"),
        ),
      ],
      {},
    );

    const step: Any = {
      id: "verify-checklist-pass",
      description:
        "Verification step: run final editorial checklist in newsletter/weekly/YYYY-WW/final-checklist.md confirming all mandatory template sections exist, claims are sourced, links are valid, and word count and style match target.",
      status: "pending",
      kind: "verification",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status, String(step.error || "")).toBe("completed");
    expect((executor as Any).daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "verification_text_checklist_evaluated",
      expect.objectContaining({
        stepId: "verify-checklist-pass",
        passed: true,
      }),
    );
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

  it("completes analysis steps when PDF vision config is missing but text extraction succeeded", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("read_file", { path: "Sens_et_Dieu_finale.pdf" }),
        toolUseResponse("read_pdf_visual", { path: "Sens_et_Dieu_finale.pdf", pages: "1-3" }),
        textResponse(
          "Metinden yeterli içerik çıkarıldı. Bu belge felsefi değerlendirme için yeterli metinsel kapsam sağlıyor.",
        ),
      ],
      {
        read_file: {
          success: true,
          content:
            "Sens et Dieu\n-- 1 of 130 --\n...\n-- 10 of 130 --\nMetnin orta kısımlarından örnek içerik.",
          format: "pdf",
        },
        read_pdf_visual: {
          success: false,
          error: "OpenAI API key not configured (OpenAI OAuth sign-in does not support image analysis here yet).",
          nonBlocking: true,
          recoverableFallback: true,
          fallbackHint:
            "Vision analysis is unavailable. Continue with read_file or parse_document if the task can be completed from extracted text.",
        },
      },
    );

    const step: Any = {
      id: "pdf-analysis-fallback",
      description:
        "PDF dosyasından çıkan metne dayanarak kitap değerlendirmesi için yeterli içerik olup olmadığını belirle.",
      status: "pending",
      kind: "primary",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status, String(step.error || "")).toBe("completed");
  });

  it("blocks browser fallback for local PDFs and still completes from extracted text", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("read_file", { path: "Sens_et_Dieu_finale.pdf" }),
        toolUseResponse("browser_navigate", { url: "file:///tmp/Sens_et_Dieu_finale.pdf" }),
        textResponse("Metinsel çıkarım yeterli olduğu için değerlendirmeyi tamamladım."),
      ],
      {
        read_file: {
          success: true,
          content:
            "Sens et Dieu\n-- 1 of 130 --\n...\n-- 12 of 130 --\nKitabın temel argümanları metinsel olarak çıkarıldı.",
          format: "pdf",
        },
      },
    );
    (executor as Any).getAvailableTools = vi.fn().mockReturnValue([
      { name: "read_file", description: "", input_schema: { type: "object", properties: {} } },
      {
        name: "browser_navigate",
        description: "",
        input_schema: { type: "object", properties: {} },
      },
    ]);

    const step: Any = {
      id: "pdf-analysis-browser-fallback",
      description: "PDF metnine dayanarak belgeyi değerlendir.",
      status: "pending",
      kind: "primary",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status, String(step.error || "")).toBe("completed");
    expect(executor.toolRegistry.executeTool).toHaveBeenCalledTimes(1);
    expect(executor.toolRegistry.executeTool).toHaveBeenCalledWith("read_file", {
      path: "Sens_et_Dieu_finale.pdf",
    });
  });

  it("blocks alternate OCR probing after reliable PDF extraction already succeeded", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("read_file", { path: "Sens_et_Dieu_finale.pdf" }),
        toolUseResponse("run_command", { command: "which pdftotext && which ocrmypdf" }),
        textResponse("PDF metni zaten güvenilir biçimde çıkarıldı; değerlendirmeyi bu metne dayanarak tamamladım."),
      ],
      {
        read_file: {
          success: true,
          content:
            "[PDF Metadata: Pages: 66 | Extraction: complete via embedded text layer; OCR not needed]\n\nKitabın metni burada.",
          format: "pdf",
          pdf_extraction: {
            status: "complete",
            mode: "pdf-parse",
            used_fallback: false,
            preview_limited: false,
            note: "complete via embedded text layer; OCR not needed",
            page_count: 66,
          },
        },
      },
    );

    const step: Any = {
      id: "pdf-no-probe",
      description: "PDF metnine dayanarak kitabı değerlendir.",
      status: "pending",
      kind: "primary",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status, String(step.error || "")).toBe("completed");
    expect(executor.toolRegistry.executeTool).toHaveBeenCalledTimes(1);
    expect(executor.toolRegistry.executeTool).toHaveBeenCalledWith("read_file", {
      path: "Sens_et_Dieu_finale.pdf",
    });
  });

  it("retries final verification once via rewind and completes after returning OK", async () => {
    executor = createExecutorWithStubs(
      [textResponse("The whitepaper is missing required sections."), textResponse("OK")],
      {},
    );
    (executor as Any).verificationOutcomeV2Enabled = true;

    const step: Any = {
      id: "verify-rewind-1",
      description: "Final verification: Review the completed whitepaper for completeness",
      status: "pending",
    };
    (executor as Any).plan = { description: "Plan", steps: [step] };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect(String(step.error || "")).toBe("");
    expect((executor as Any).callLLMWithRetry).toHaveBeenCalledTimes(2);
    expect((executor as Any).daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "log",
      expect.objectContaining({
        checkpointId: "verify:verify-rewind-1:rewind_attempt_1",
        checkpointType: "rewind",
      }),
    );
    expect((executor as Any).blockingVerificationFailedStepIds.has("verify-rewind-1")).toBe(
      false,
    );
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

  it("soft-blocks web_search on budget exhaustion and still completes the step with prior evidence", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("run_command", { command: "echo ready" }),
        toolUseResponse("web_search", { query: "latest news", maxUses: 2 }),
        toolUseResponse("list_directory", { path: "." }),
        textResponse("Completed from existing evidence."),
      ],
      {
        run_command: { success: true, output: "ready" },
        list_directory: { success: true, path: ".", items: [] },
      },
    );
    (executor as Any).webSearchMaxUsesPerTask = 1;
    (executor as Any).webSearchMaxUsesPerStep = 1;
    (executor as Any).webSearchToolCallCount = 1; // Exhaust before the requested call

    const step: Any = { id: "budget-soft-1", description: "Research and summarize", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect((executor as Any).toolRegistry.executeTool).toHaveBeenCalledWith("list_directory", {
      path: ".",
    });
    expect((executor as Any).toolRegistry.executeTool).not.toHaveBeenCalledWith("web_search", expect.anything());
    expect(executor.daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "log",
      expect.objectContaining({
        metric: "web_search_budget_hit",
      }),
    );
  });

  it("blocks autonomous web_fetch in cached mode when user did not explicitly request a URL", async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse("list_directory", { path: "." }),
        toolUseResponse("web_fetch", { url: "https://example.com/article" }),
        textResponse("Completed from local evidence."),
      ],
      {
        list_directory: { success: true, path: ".", items: [] },
      },
    );
    (executor as Any).webSearchMode = "cached";
    (executor as Any).task.prompt = "Research the latest updates and summarize findings.";
    (executor as Any).lastUserMessage = "Research the latest updates and summarize findings.";

    const step: Any = { id: "cached-fetch-1", description: "Research and summarize", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect((executor as Any).toolRegistry.executeTool).toHaveBeenCalledWith("list_directory", {
      path: ".",
    });
    expect((executor as Any).toolRegistry.executeTool).not.toHaveBeenCalledWith(
      "web_fetch",
      expect.anything(),
    );
    expect(executor.daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_error",
      expect.objectContaining({
        tool: "web_fetch",
        blocked: true,
        scope: "mode",
      }),
    );
  });

  it("allows web_fetch in cached mode when user explicitly requested the exact URL", async () => {
    const targetUrl = "https://example.com/article";
    executor = createExecutorWithStubs(
      [toolUseResponse("web_fetch", { url: targetUrl }), textResponse("Fetched requested URL.")],
      {
        web_fetch: { success: true, url: targetUrl, content: "Article body" },
      },
    );
    (executor as Any).webSearchMode = "cached";
    (executor as Any).task.prompt = `Read this exact URL and summarize it: ${targetUrl}`;
    (executor as Any).lastUserMessage = `Read this exact URL and summarize it: ${targetUrl}`;

    const step: Any = { id: "cached-fetch-2", description: "Fetch requested page", status: "pending" };

    await (executor as Any).executeStep(step);

    expect(step.status).toBe("completed");
    expect((executor as Any).toolRegistry.executeTool).toHaveBeenCalledWith("web_fetch", {
      url: targetUrl,
    });
  });

  it("fails fast when tool returns unrecoverable failure (Skill not currently executable)", async () => {
    const executorWithTools = createExecutorWithStubs(
      [
        toolUseResponse("Skill", {
          skill: "audio-transcribe",
          args: JSON.stringify({ inputPath: "/tmp/audio.mp3" }),
        }),
      ],
      {
        Skill: {
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
      { name: "Skill", description: "", input_schema: { type: "object", properties: {} } },
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

  it("inserts local-runtime recovery steps when recovery mode is active", async () => {
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

    expect(handlePlanRevisionSpy).toHaveBeenCalledTimes(1);
    expect(executor.planRevisionCount).toBe(1);
    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("local-runtime remediation path")),
    ).toBe(true);
    expect(planDescriptions.length).toBeGreaterThan(2);
  });

  it("allows a new recovery revision when the failure signature changes between retries", async () => {
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

    expect(handlePlanRevisionSpy).toHaveBeenCalledTimes(2);
    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(
      planDescriptions.some((desc: string) => desc.includes("local-runtime remediation path")),
    ).toBe(true);
    expect(planDescriptions.length).toBeGreaterThan(2);
    expect(executor.planRevisionCount).toBe(2);
  });

  it("inserts generic recovery steps when recovery mode is active for non-runtime failures", async () => {
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

    expect(failedStep.status).toBe("failed");
    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(planDescriptions).toContain("Validate output");
    expect(planDescriptions.length).toBe(4);
  });

  it("keeps generic recovery read-only for non-mutating steps", async () => {
    const executor = createExecutorWithStubs(
      [
        toolUseResponse("write_file", {
          path: "notes/recommendations.md",
          content: "placeholder",
        }),
        textResponse(""),
      ],
      {
        write_file: { success: false, error: "Tool not available" },
      },
    );

    const failedStep: Any = {
      id: "1",
      description: "Research the current workspace context and summarize the findings.",
      status: "pending",
    };
    const retainedPendingStep: Any = { id: "2", description: "Validate output", status: "pending" };
    executor.plan = { description: "Plan", steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.recoveryRequestActive = true;
    executor.planRevisionCount = 0;

    await (executor as Any).executeStep(failedStep);

    const planDescriptions = executor.plan.steps.map((step: Any) => step.description);
    expect(planDescriptions).toContain(
      "If normal tools are blocked, continue with a read-only fallback path and complete the goal from existing evidence and tool outputs.",
    );
    expect(planDescriptions).not.toContain(
      "If normal tools are blocked, implement the smallest safe code/feature change needed to continue and complete the goal.",
    );
  });

  it("triggers recovery planning when the failure reason itself signals recovery intent", async () => {
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
    expect(planDescriptions.length).toBeGreaterThan(2);
    expect(planDescriptions).toContain("Validate output");
    expect(failedStep.status).toBe("failed");
  });

  it("prunes the generic blocked-tools fallback after alternative recovery succeeds", () => {
    const executor: Any = Object.create(TaskExecutor.prototype);
    executor.logTag = "[Executor:test]";
    const completedRecovery = {
      id: "recovery-1",
      description: "Try an alternative toolchain or different input strategy for: Create the seed record",
      kind: "recovery",
      status: "completed",
    };
    executor.plan = {
      description: "Plan",
      steps: [
        completedRecovery,
        {
          id: "recovery-2",
          description:
            "If normal tools are blocked, continue with a read-only fallback path and complete the goal from existing evidence and tool outputs.",
          kind: "recovery",
          status: "pending",
        },
        {
          id: "next-primary",
          description: "Continue drafting the novel foundation",
          kind: "primary",
          status: "pending",
        },
      ],
    };

    (TaskExecutor as Any).prototype.pruneSatisfiedGenericRecoverySteps.call(
      executor,
      completedRecovery,
    );

    expect(executor.plan.steps.map((step: Any) => step.id)).toEqual([
      "recovery-1",
      "next-primary",
    ]);
  });

  it("requires artifact_write_required for summary/report steps with a concrete target path and write intent", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});

    // This mirrors the exact step that failed: "Write a comprehensive markdown
    // report ... to /tmp/new/ai-agent-trends-2026-03-08.md"
    const step: Any = {
      id: "write-report-concrete-path",
      description:
        "Write a comprehensive markdown report with sources and summaries to /tmp/new/ai-agent-trends-2026-03-08.md.",
      status: "pending",
    };

    const contractMode = (executor as Any).resolveStepArtifactContractMode(step);
    expect(contractMode).toBe("artifact_write_required");
  });

  it("requires artifact_write_required for report steps phrased as saved-as targets", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});

    const step: Any = {
      id: "write-report-saved-as-path",
      description:
        "Synthesize the findings into a report saved as `/tmp/new/ai-agent-trends-2026-03-08.md`.",
      status: "pending",
    };

    expect((executor as Any).isSummaryStep(step)).toBe(false);
    expect((executor as Any).resolveStepArtifactContractMode(step)).toBe("artifact_write_required");
  });

  it("returns artifact_presence_required for summary steps without a concrete target path", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});

    const step: Any = {
      id: "compile-summary-no-path",
      description: "Compile and summarize the key findings into a comprehensive report.",
      status: "pending",
    };

    const contractMode = (executor as Any).resolveStepArtifactContractMode(step);
    expect(contractMode).toBe("artifact_presence_required");
  });

  it("does not classify write-to-file report steps as summary steps", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});

    const writeReportStep: Any = {
      id: "write-report-file",
      description:
        "Write a comprehensive markdown report to /tmp/output/trends-report.md.",
      status: "pending",
    };

    // Step with write intent + concrete path should NOT be a summary step
    expect((executor as Any).isSummaryStep(writeReportStep)).toBe(false);

    // Step without a path SHOULD be a summary step
    const pureSummaryStep: Any = {
      id: "pure-summary",
      description: "Compile and summarize the research findings.",
      status: "pending",
    };
    expect((executor as Any).isSummaryStep(pureSummaryStep)).toBe(true);
  });

  it("requires artifact_write_required for save/create steps with explicit file targets", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});

    // "save" is an explicit write verb, so write intent + concrete path → artifact_write_required
    const saveStep: Any = {
      id: "save-to-file",
      description: "Save the compiled analysis to /workspace/output/final-analysis.json.",
      status: "pending",
    };

    const contractMode = (executor as Any).resolveStepArtifactContractMode(saveStep);
    expect(contractMode).toBe("artifact_write_required");
  });

  it("requires artifact_write_required for research steps that also specify a concrete output file", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});

    const researchWriteStep: Any = {
      id: "research-write-file",
      description:
        "Review changes in this release, shortlist the useful ones for Cowork OS, and write the findings to research/cowork_os_showcase_shortlist.md.",
      status: "pending",
    };

    expect((executor as Any).resolveStepArtifactContractMode(researchWriteStep)).toBe(
      "artifact_write_required",
    );
  });

  it("returns artifact_presence_required for compile-only steps even with a file target", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});

    // "compile" is not a write verb, so even with a concrete path it stays presence_required
    const compileStep: Any = {
      id: "compile-to-file",
      description: "Compile the analysis into /workspace/output/final-analysis.json.",
      status: "pending",
    };

    const contractMode = (executor as Any).resolveStepArtifactContractMode(compileStep);
    expect(contractMode).toBe("artifact_presence_required");
  });

  it("extracts file_path from input when recording file creation", () => {
    executor = createExecutorWithStubs([textResponse("OK")], {});
    const mockTracker = {
      getKnowledgeSummary: vi.fn().mockReturnValue(""),
      getCreatedFiles: vi.fn().mockReturnValue([]),
      recordFileCreation: vi.fn(),
      invalidateFileRead: vi.fn(),
      invalidateDirectoryListing: vi.fn(),
      recordDirectoryListing: vi.fn(),
    };
    (executor as Any).fileOperationTracker = mockTracker;
    (executor as Any).toolCallDeduplicator = {
      checkDuplicate: vi.fn().mockReturnValue({ isDuplicate: false }),
      recordCall: vi.fn(),
      resetMutationHistoryForNewStep: vi.fn(),
      clearReadOnlyHistory: vi.fn(),
    };

    // Call the real recordFileOperation (restore it from prototype)
    const realRecordFileOperation =
      TaskExecutor.prototype["recordFileOperation" as keyof TaskExecutor];
    (executor as Any).recordFileOperation = realRecordFileOperation;

    // Simulate recordFileOperation with file_path in input (no path/filename)
    (executor as Any).recordFileOperation(
      "write_file",
      { file_path: "/tmp/test-output.md" },
      { success: true },
    );

    expect(mockTracker.recordFileCreation).toHaveBeenCalledWith("/tmp/test-output.md");
  });
});
