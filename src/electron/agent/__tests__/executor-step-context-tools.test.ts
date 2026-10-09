import { describe, expect, it, vi } from "vitest";

import { estimateTokens } from "../context-manager";
import { TaskExecutor } from "../executor";
import { FileOperationTracker } from "../executor-helpers";
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
  MemoryService: {},
}));

vi.mock("../custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    getEnabledGuidelinesPrompt: () => "",
    listModelInvocableSkills: () => [
      { id: "novelist", name: "Novelist", type: "task", enabled: true },
      { id: "pdf-report", name: "PDF Report", type: "task", enabled: true },
    ],
  }),
}));

const WEB_INTERACTION_TOOLS = [
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_press",
];

function textResponse(text: string): LLMResponse {
  return { stopReason: "end_turn", content: [{ type: "text", text }] };
}

function createAllowlistExecutor(): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1", title: "Task", prompt: "", agentConfig: {} };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp/workspace",
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  return executor;
}

function allowlistFor(
  stepText: string,
  stepKind: "analysis" | "mutation_required" | "verification" = "analysis",
  taskDomain = "code",
): Set<string> {
  const executor = createAllowlistExecutor();
  return executor.buildStepToolAllowlist(
    { requiredTools: new Set<string>(), requiresMutation: stepKind === "mutation_required" },
    stepKind,
    taskDomain,
    stepText,
  );
}

// Minimal executeStep harness (same shape as executor-step-failures.test.ts).
function createStepExecutor(handler: (messages: Any[]) => LLMResponse): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-1",
    title: "Fix the date parser",
    prompt: "Fix the failing parseDate test in src/utils/date.ts.",
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp/workspace-step-context",
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = {
    logEvent: vi.fn(),
    getTaskEvents: vi.fn().mockReturnValue([]),
    updateTask: vi.fn(),
    updateTaskStatus: vi.fn(),
  };
  Object.assign(executor, {
    testRunObserved: false,
    executionToolRunObserved: false,
    executionToolAttemptObserved: false,
    executionToolLastError: "",
    allowExecutionWithoutShell: false,
    totalToolCallCount: 0,
    webSearchToolCallCount: 0,
    webSearchMode: "live",
    webSearchMaxUsesPerTask: 8,
    webSearchMaxUsesPerStep: 3,
    webSearchAllowedDomains: [],
    webSearchBlockedDomains: [],
    toolSemanticsV2Enabled: true,
    mutationEvidenceV2Enabled: true,
    providerRetryV2Enabled: true,
    mutationLoopStopV2Enabled: true,
    planCompletedEffectively: false,
    cancelled: false,
    cancelReason: null,
    paused: false,
    taskCompleted: false,
    waitingForUserInput: false,
    workspacePreflightAcknowledged: false,
    lastPauseReason: null,
    conversationHistory: [],
    systemPrompt: "",
    recoveryRequestActive: false,
    capabilityUpgradeRequested: false,
    toolResultMemory: [],
    toolUsageCounts: new Map(),
    toolUsageEventsSinceDecay: 0,
    toolSelectionEpoch: 0,
    lastAssistantOutput: null,
    lastNonVerificationOutput: null,
    filesReadTracker: new Map(),
    artifactMutationLedger: Object.create(null),
    stepContractReconciliationLedger: Object.create(null),
    reliabilityContractReconciliationV3Enabled: true,
    reliabilityStepMutationDedupeV3Enabled: true,
    reliabilityBrowserChecklistV3Enabled: true,
    currentStepId: null,
    lastRecoveryFailureSignature: "",
    recoveredFailureStepIds: new Set(),
    budgetConstrainedFailedStepIds: new Set(),
    nonBlockingVerificationFailedStepIds: new Set(),
    blockingVerificationFailedStepIds: new Set(),
    crossStepToolFailures: new Map(),
    dispatchedMentionedAgents: false,
    lastAssistantText: null,
    lastPreCompactionFlushAt: 0,
    lastPreCompactionFlushTokenCount: 0,
    observedOutputTokensPerSecond: null,
    journalIntervalHandle: undefined,
    journalEntryCount: 0,
    pendingFollowUps: [],
    _suppressNextUserMessageEvent: false,
    planRevisionCount: 0,
    maxPlanRevisions: 5,
    failedApproaches: new Set(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    usageOffsetInputTokens: 0,
    usageOffsetOutputTokens: 0,
    usageOffsetCost: 0,
    iterationCount: 0,
    globalTurnCount: 0,
    maxGlobalTurns: 100,
    turnSoftLandingReserve: 2,
    budgetSoftLandingInjected: false,
    llmCallSequence: 0,
    softDeadlineTriggered: false,
    wrapUpRequested: false,
    logTag: "[Executor:test]",
  });
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
  executor.fileOperationTracker = new FileOperationTracker();
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
  executor.toolRegistry = { executeTool: vi.fn(async () => ({ success: true })) };
  executor.provider = { createMessage: vi.fn(async (args: Any) => handler(args.messages)) };
  executor.callLLMWithRetry = vi.fn().mockImplementation(async (requestFn: Any) => requestFn());
  executor.abortController = new AbortController();
  return executor;
}

describe("step tool allowlists follow the step's intent", () => {
  it.each([
    [
      "web form",
      "Go to example.com/contact, fill the form with my name and email, and submit it",
      WEB_INTERACTION_TOOLS,
    ],
    ["skill", "Run the Novelist skill to draft and package the novel", ["Skill"]],
    [
      "repo status",
      "Check git status and review the uncommitted changes before committing",
      ["git_status", "git_diff"],
    ],
  ])("%s steps get the tools they need", (_label, stepText, expectedTools) => {
    const allowlist = allowlistFor(stepText);
    for (const toolName of expectedTools) {
      expect(allowlist.has(toolName), toolName).toBe(true);
    }
  });

  it("keeps those tools out of unrelated steps", () => {
    const allowlist = allowlistFor("Summarize the README and list the open questions");
    for (const toolName of [...WEB_INTERACTION_TOOLS, "Skill", "git_status", "git_diff"]) {
      expect(allowlist.has(toolName), toolName).toBe(false);
    }
  });

  it("offers the registered read_files tool, not the nonexistent read_multiple_files", () => {
    const allowlist = allowlistFor("Read the date utilities and their tests");
    expect(allowlist.has("read_files")).toBe(true);
    expect(allowlist.has("read_multiple_files")).toBe(false);
  });

  it("lets code verification steps fix what their checks find", () => {
    const codeVerification = allowlistFor("Verify: run the test suite", "verification", "code");
    expect(codeVerification.has("edit_file")).toBe(true);
    expect(codeVerification.has("write_file")).toBe(true);

    const writingVerification = allowlistFor(
      "Verify the essay has five sections",
      "verification",
      "writing",
    );
    expect(writingVerification.has("edit_file")).toBe(false);
  });
});

describe("business-agent tools in plan steps", () => {
  it("keeps tools the business lane admitted, whatever the step wording", () => {
    const executor = createStepExecutor(() => textResponse("unused"));
    const step: Any = {
      id: "1",
      description: "Cancel order A-1 through Example Co.'s PACT business agent.",
      status: "pending",
    };
    executor.task.title = "Cancel order A-1 with Example Co.";
    executor.task.prompt = "Use Example Co.'s PACT business agent to cancel my order A-1.";
    executor.plan = { description: "Cancel the order", steps: [step] };
    executor.currentStepId = step.id;
    const business = { capabilityTags: ["business", "integration"] };
    const catalog = [
      { name: "read_file" },
      { name: "write_file" },
      { name: "pact_discover", runtime: business },
      { name: "pact_send_message", runtime: business },
      { name: "pact_get_conversation", runtime: business },
    ].map((tool) => ({
      description: "",
      input_schema: { type: "object", properties: {} },
      ...tool,
    }));

    const exposed = executor.applyStepScopedToolPolicy(catalog).map((tool: Any) => tool.name);

    expect(exposed).toEqual(
      expect.arrayContaining(["pact_discover", "pact_send_message", "pact_get_conversation"]),
    );
    expect(exposed).not.toContain("write_file");
  });
});

describe("step context for later plan steps", () => {
  async function runSecondStep() {
    const contexts: string[] = [];
    const executor = createStepExecutor((messages) => {
      contexts.push(String(messages?.[0]?.content || ""));
      return textResponse("Findings: the parser drops ISO week numbers.");
    });
    const firstStep: Any = {
      id: "1",
      description: "Inspect the date utilities",
      status: "completed",
    };
    const secondStep: Any = {
      id: "2",
      description: "Explain why parseDate fails for ISO week numbers",
      status: "pending",
    };
    executor.plan = { description: "Fix the date parser", steps: [firstStep, secondStep] };

    executor.currentStepId = "1";
    for (let index = 0; index < 35; index++) {
      const filePath = `src/utils/file-${index}.ts`;
      executor.trackFileRead(
        "read_file",
        { path: filePath, size: 100 + index },
        { path: filePath },
      );
      executor.fileOperationTracker.recordFileRead(filePath, "content");
    }
    // Re-reading an early file makes it the most recent read.
    executor.trackFileRead("read_file", { path: "src/utils/file-3.ts", size: 103 });
    executor.currentStepId = null;

    await executor.executeStep(secondStep);
    return { executor, context: contexts[0] || "", secondStep };
  }

  it("does not claim earlier file contents are in context and lists the newest reads", async () => {
    const { context } = await runSecondStep();

    expect(context).toContain("src/utils/file-34.ts");
    expect(context).toContain("src/utils/file-3.ts");
    expect(context).not.toContain("src/utils/file-0.ts");
    expect(context).not.toMatch(/content is in context/i);
    expect(context).not.toMatch(/do NOT re-read/i);
    expect(context).not.toMatch(/instead of re-reading/i);
  });

  it("only names tools that the step can actually call", async () => {
    const { executor, context, secondStep } = await runSecondStep();
    const catalog = [
      "read_file",
      "read_files",
      "read_multiple_files",
      "glob",
      "grep",
      "list_directory",
      "search_files",
      "scratchpad_read",
      "scratchpad_write",
      "web_search",
      "web_fetch",
      "run_command",
      "edit_file",
      "write_file",
      "git_status",
      "git_diff",
      "browser_navigate",
      "browser_click",
      "Skill",
    ].map((name) => ({ name, description: "", input_schema: { type: "object", properties: {} } }));

    executor.currentStepId = secondStep.id;
    const exposed = new Set(
      executor.applyStepScopedToolPolicy(catalog).map((tool: Any) => String(tool.name)),
    );
    const named = catalog
      .map((tool) => tool.name)
      .filter((name) => new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(context));

    expect(named.length).toBeGreaterThan(0);
    for (const toolName of named) {
      expect(exposed.has(toolName), toolName).toBe(true);
    }
  });
});

describe("knowledge summary", () => {
  it("lists the most recently read files", () => {
    const tracker = new FileOperationTracker();
    for (let index = 0; index < 12; index++) {
      tracker.recordFileRead(`docs/file-${index}.md`, "body");
    }

    const summary = tracker.getKnowledgeSummary();

    expect(summary).toContain("docs/file-11.md");
    expect(summary).toContain("docs/file-2.md");
    expect(summary).not.toContain("docs/file-0.md");
    expect(summary).not.toContain("docs/file-1.md");
  });
});

describe("step context budget", () => {
  it("counts the tool definitions sent with every request", async () => {
    const executor = createStepExecutor(() => textResponse("The parser drops ISO weeks."));
    const largeTool = {
      name: "large_tool",
      description: "d".repeat(8_000),
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "q".repeat(4_000) } },
      },
    };
    executor.getAvailableTools = vi.fn().mockReturnValue([largeTool]);
    const step: Any = { id: "1", description: "Explain why parseDate fails", status: "pending" };
    executor.plan = { description: "Fix the date parser", steps: [step] };

    await executor.executeStep(step);

    const [, systemPromptTokens] = executor.contextManager.getContextUtilization.mock.calls[0];
    // About 3K tokens of tool definitions on top of the system prompt.
    expect(systemPromptTokens - estimateTokens(executor.systemPrompt)).toBeGreaterThanOrEqual(
      3_000,
    );
  });
});
