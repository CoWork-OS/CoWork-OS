/**
 * Prompt-content regression tests for the execution system prompt.
 *
 * These build prompts with the real TaskExecutor prompt builders and the real
 * ContentBuilder so they catch guidance that is missing, contradictory, or
 * spent on routing that is irrelevant to the task.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMResponse } from "../llm";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
    getVersion: () => "0.0.0",
    isPackaged: false,
    getAppPath: () => "/tmp",
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../../memory/MemoryService", () => ({
  MemoryService: {
    getContextForInjection: vi.fn().mockReturnValue(""),
  },
}));

// Real PersonalityManager backed by an in-memory secure settings store, so the
// identity and persona text in these prompts is the shipped default.
const secureSettingsStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({
      save: (category: string, value: unknown) => secureSettingsStore.set(category, value),
      load: (category: string) => secureSettingsStore.get(category),
      exists: (category: string) => secureSettingsStore.has(category),
      getRevision: () => null,
      readRecord: () => ({ status: "not_found", revision: null }),
    }),
  },
}));

import { TaskExecutor } from "../executor";
import { estimateTokens } from "../context-manager";
import { PersonalityManager } from "../../settings/personality-manager";
import { CitationTracker } from "../citation/CitationTracker";
import { closeDebugRuntimeSession } from "../debug/DebugRuntimeServer";
import { TaskStrategyService } from "../strategy/TaskStrategyService";
import { IntentRouter } from "../strategy/IntentRouter";

beforeEach(() => {
  secureSettingsStore.clear();
  PersonalityManager.clearCache();
  PersonalityManager.initialize();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MEMORY_FEATURES_OFF = {
  contextPackInjectionEnabled: false,
  heartbeatMaintenanceEnabled: false,
  promptStackV2Enabled: false,
  layeredMemoryEnabled: false,
  transcriptStoreEnabled: false,
  backgroundConsolidationEnabled: false,
  queryOrchestratorEnabled: false,
  sessionLineageEnabled: false,
};

type ExecutorOptions = {
  title: string;
  prompt: string;
  taskDomain?: string;
  taskIntent?: string;
  executionMode?: string;
  workspacePath?: string;
  agentConfig?: Record<string, unknown>;
};

function makePromptExecutor(options: ExecutorOptions): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-prompt-content",
    title: options.title,
    prompt: options.prompt,
    rawPrompt: options.prompt,
    userPrompt: options.prompt,
    createdAt: Date.now() - 1000,
    agentConfig: {
      ...(options.taskDomain ? { taskDomain: options.taskDomain } : {}),
      ...(options.taskIntent ? { taskIntent: options.taskIntent } : {}),
      ...(options.executionMode ? { executionMode: options.executionMode } : {}),
      ...options.agentConfig,
    },
  };
  executor.workspace = {
    id: "workspace-prompt-content",
    name: "repo",
    path: options.workspacePath ?? "/tmp/cowork-prompt-content-missing-workspace",
    isTemp: false,
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.provider = { type: "anthropic" };
  executor.humanInputPolicy = "hard_blockers";
  executor.webSearchMode = "live";
  executor.requiresExecutionToolRun = false;
  executor.appliedSkills = [];
  executor.taskContextNotes = [];
  executor.daemon = {
    getAgentRoleById: () => undefined,
    getTransientRetryCount: () => 0,
    logEvent: vi.fn(),
    getTaskEvents: vi.fn().mockReturnValue([]),
    updateTask: vi.fn(),
    updateTaskStatus: vi.fn(),
  };
  executor.emitEvent = vi.fn();
  executor.logTag = "[Executor:prompt-content]";
  executor.infraContextProvider = { getStatus: () => ({ enabled: false }) };
  return executor;
}

async function buildExecutionPrompt(
  executor: Any,
  overrides: Record<string, unknown> = {},
): Promise<{ prompt: string; systemBlocks: Array<{ stableKey: string; text: string }> }> {
  return executor.buildExecutionSystemPrompt({
    taskPrompt: executor.getExecutionTaskPrompt(),
    identityPrompt: "YOUR IDENTITY:\nYou are CoWork.",
    executionMode: executor.getEffectiveExecutionMode(),
    taskDomain: executor.getEffectiveTaskDomain(),
    memoryFeatures: MEMORY_FEATURES_OFF,
    ...overrides,
  });
}

function sectionText(
  built: { systemBlocks: Array<{ stableKey: string; text: string }> },
  key: string,
): string {
  return built.systemBlocks.find((block) => block.stableKey.startsWith(`${key}:`))?.text ?? "";
}

function textResponse(text: string): LLMResponse {
  return {
    stopReason: "end_turn",
    content: [{ type: "text", text }],
  };
}

/**
 * Minimal executeStep harness (mirrors executor-step-failures.test.ts) that
 * records the system prompt and the step message the model received.
 */
function makeStepExecutor(options: ExecutorOptions) {
  const executor = makePromptExecutor(options);
  const captured: { systemPrompts: string[]; stepMessages: string[] } = {
    systemPrompts: [],
    stepMessages: [],
  };
  Object.assign(executor, {
    testRunObserved: false,
    executionToolRunObserved: false,
    executionToolAttemptObserved: false,
    executionToolLastError: "",
    allowExecutionWithoutShell: false,
    totalToolCallCount: 0,
    webSearchToolCallCount: 0,
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
  });
  executor.loadExecutionPromptMemoryFeatures = () => MEMORY_FEATURES_OFF;
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
  executor.toolRegistry = { executeTool: vi.fn(async () => ({ success: true })) };
  executor.provider = {
    type: "anthropic",
    createMessage: vi.fn(async (args: Any) => {
      captured.systemPrompts.push(String(executor.systemPrompt || ""));
      captured.stepMessages.push(
        typeof args?.messages?.[0]?.content === "string"
          ? args.messages[0].content
          : JSON.stringify(args?.messages?.[0]?.content ?? ""),
      );
      return textResponse("Done. The requested work is complete.");
    }),
  };
  executor.callLLMWithRetry = vi.fn().mockImplementation(async (requestFn: Any) => requestFn());
  executor.abortController = new AbortController();
  return { executor, captured };
}

const CODING_PROMPT =
  "The test `parseDate handles ISO week numbers` in src/utils/__tests__/date.test.ts is failing after the last refactor. Find the root cause, fix it, and make sure the whole test suite passes.";

describe("execution prompt routing blocks", () => {
  it("keeps maps, messaging, cloud-storage, PDF, and rich-surface routing out of a coding task", async () => {
    const executor = makePromptExecutor({
      title: "Fix failing parseDate test",
      prompt: CODING_PROMPT,
      taskDomain: "code",
      taskIntent: "execution",
      executionMode: "execute",
    });

    const base = executor.buildExecutionBaseInstructionPrompt();

    expect(estimateTokens(base)).toBeLessThan(1000);
    expect(base).not.toContain("LOCAL LOCATION AND MAPS ROUTING");
    expect(base).not.toContain("MESSAGING CHANNEL ROUTING");
    expect(base).not.toContain("CLOUD STORAGE ROUTING");
    expect(base).not.toContain("ATTACHED PDFS");
    expect(base).not.toContain("RICH INLINE SURFACES");
    expect(base).not.toContain("Default rich-frame design language");
    // Core operating guidance stays.
    expect(base).toContain("OPERATING RULES:");
    expect(base).toContain("PATH DISCOVERY (CRITICAL):");
    expect(base).toContain("FINAL ANSWER CONTRACT:");
  });

  it.each([
    [
      "maps",
      "Where can I buy an umbrella near me before my meeting in 20 minutes?",
      "LOCAL LOCATION AND MAPS ROUTING",
    ],
    [
      "messaging",
      "Summarize my unread WhatsApp messages from the family group.",
      "MESSAGING CHANNEL ROUTING",
    ],
    ["cloud storage", "List the files in my Dropbox invoices folder.", "CLOUD STORAGE ROUTING"],
    [
      "pdf",
      "Summarize the attached contract.\n\nPDF attachment: contract.pdf\nPath: uploads/contract.pdf",
      "ATTACHED PDFS",
    ],
    [
      "rich surface",
      "Show my weekly running distance as a chart.",
      "Default rich-frame design language",
    ],
  ])("includes the %s block when its intent detector fires", (_label, prompt, heading) => {
    const executor = makePromptExecutor({
      title: "Help",
      prompt,
      taskDomain: "general",
      taskIntent: "execution",
      executionMode: "execute",
    });

    expect(executor.buildExecutionBaseInstructionPrompt()).toContain(heading);
  });

  it("keeps a routing block for the rest of the session once a follow-up triggered it", () => {
    const executor = makePromptExecutor({
      title: "Fix failing parseDate test",
      prompt: CODING_PROMPT,
      taskDomain: "code",
      taskIntent: "execution",
      executionMode: "execute",
    });
    expect(executor.buildExecutionBaseInstructionPrompt()).not.toContain(
      "MESSAGING CHANNEL ROUTING",
    );

    executor.lastUserMessage = "Now post a short summary to the team Slack channel.";
    const withMessaging = executor.buildExecutionBaseInstructionPrompt();
    executor.lastUserMessage = "Thanks, also bump the version number.";

    expect(withMessaging).toContain("MESSAGING CHANNEL ROUTING");
    expect(executor.buildExecutionBaseInstructionPrompt()).toBe(withMessaging);
  });

  it("does not truncate the novelist skill contract out of the base instruction", async () => {
    const executor = makePromptExecutor({
      title: "Star Wars side story",
      prompt: "Write a Star Wars fanfiction side-story novel about a young smuggler.",
      taskDomain: "writing",
      taskIntent: "execution",
      executionMode: "execute",
    });
    executor.appliedSkills = [
      {
        skillId: "novelist",
        skillName: "Novelist",
        trigger: "model",
        reason: "matches",
        content: "",
        parameters: { canon_mode: "fanfiction", seed: "Star Wars universe smuggler" },
        contextDirectives: {
          artifactDirectories: ["/tmp/cowork-prompt-content/artifacts/skills/task-123/novelist"],
        },
      },
    ];

    const built = await buildExecutionPrompt(executor);
    const base = sectionText(built, "base_instruction");

    expect(base).toContain("NOVELIST SKILL CONTRACT");
    expect(base).toContain("Preserve that universe");
    expect(base).not.toContain("truncated for budget");
  });
});

describe("data evidence and units guidance", () => {
  const DATA_LAYER_PROMPT =
    "Refactor the data access layer in src/db so the summary table query uses the new repository class. Keep the API unchanged and run the tests.";

  it("is not injected into a code-domain refactor that only mentions data/summary/table", async () => {
    const executor = makePromptExecutor({
      title: "Refactor data layer",
      prompt: DATA_LAYER_PROMPT,
      taskDomain: "code",
      taskIntent: "execution",
      executionMode: "execute",
    });

    expect(executor.getDataUnitGuidance()).toBeUndefined();
    expect(executor.getDataUnitGuidance("Update the summary table query.")).toBeUndefined();
  });

  it("still applies to a code-domain task that reports on a tabular data file", () => {
    const executor = makePromptExecutor({
      title: "Sales totals",
      prompt: "Write a Python script that reads sales.csv and reports revenue totals by region.",
      taskDomain: "code",
      taskIntent: "execution",
      executionMode: "execute",
    });

    expect(executor.getDataUnitGuidance()).toContain("DATA EVIDENCE AND UNITS (REQUIRED)");
  });

  it("is injected once per step (step message), not duplicated in the system turn guidance", async () => {
    const request = "Read orders.csv and tell me the total revenue by region.";
    const { executor, captured } = makeStepExecutor({
      title: "Orders revenue",
      prompt: request,
      taskDomain: "general",
      taskIntent: "execution",
      executionMode: "execute",
    });
    const step: Any = {
      id: "1",
      description: "Read orders.csv and calculate the revenue totals by region.",
      status: "pending",
    };
    executor.plan = { description: "Answer the revenue question", steps: [step] };

    await executor.executeStep(step);

    expect(captured.stepMessages[0]).toContain("DATA EVIDENCE AND UNITS (REQUIRED)");
    expect(captured.systemPrompts[0]).toContain("YOUR IDENTITY:");
    expect(captured.systemPrompts[0]).not.toContain("DATA EVIDENCE AND UNITS (REQUIRED)");
  });
});

function makeGitWorkspace(branch = "main"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-prompt-git-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return dir;
}

describe("coding workflow guidance", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds a compact CODING WORKFLOW section to code-domain execution prompts", async () => {
    const executor = makePromptExecutor({
      title: "Fix failing parseDate test",
      prompt: CODING_PROMPT,
      taskDomain: "code",
      taskIntent: "execution",
      executionMode: "execute",
    });

    const built = await buildExecutionPrompt(executor);
    const workflow = sectionText(built, "coding_workflow");

    expect(workflow).toContain("CODING WORKFLOW:");
    expect(workflow).toMatch(/read the relevant code/i);
    expect(workflow).toMatch(/minimal, focused changes/i);
    expect(workflow).toMatch(/git status/i);
    expect(workflow).toMatch(/uncommitted changes you did not make/i);
    expect(workflow).toMatch(/run the relevant tests/i);
    expect(workflow).toMatch(/batch independent read-only tool calls/i);
    expect(workflow).toMatch(/never claim a check passed unless you ran it/i);
    expect(workflow).toContain(".cowork/tmp/");
    expect(estimateTokens(workflow)).toBeLessThanOrEqual(180);
    expect(
      built.systemBlocks.find((b) => b.stableKey.startsWith("coding_workflow:")),
    ).toMatchObject({ scope: "session" });
  });

  it("adds the section for a general-domain task in a git repository", async () => {
    const workspacePath = makeGitWorkspace();
    tempDirs.push(workspacePath);
    const executor = makePromptExecutor({
      title: "Rename helper",
      prompt: "Rename the helper formatDate to formatIsoDate everywhere.",
      taskDomain: "general",
      taskIntent: "execution",
      executionMode: "execute",
      workspacePath,
    });

    const built = await buildExecutionPrompt(executor);

    expect(sectionText(built, "coding_workflow")).toContain("CODING WORKFLOW:");
  });

  it.each([
    ["a non-code task", "general", "execute"],
    ["a writing task", "writing", "execute"],
    ["a read-only analysis of code", "code", "analyze"],
    ["a plan-only coding request", "code", "plan"],
  ])("omits the section for %s", async (_label, taskDomain, executionMode) => {
    const executor = makePromptExecutor({
      title: "Task",
      prompt: "Draft a short note about the quarterly offsite agenda.",
      taskDomain,
      taskIntent: "execution",
      executionMode,
    });

    const built = await buildExecutionPrompt(executor);

    expect(built.prompt).not.toContain("CODING WORKFLOW:");
  });
});

describe("task strategy contracts", () => {
  const DEBUG_TASK_ID = "task-prompt-content-debug";
  afterEach(() => {
    closeDebugRuntimeSession(DEBUG_TASK_ID);
  });

  it("delivers the deep-work contract to the execution prompt without private or machine-only lines", async () => {
    const title = "Migrate the build";
    const rawPrompt =
      "Migrate the whole build from webpack to vite, update every config, and keep the test suite green.";
    const route = { ...IntentRouter.route(title, rawPrompt), intent: "deep_work" as const };
    const strategy = TaskStrategyService.derive(route, undefined, { title, prompt: rawPrompt });
    const executor = makePromptExecutor({
      title,
      prompt: rawPrompt,
      taskDomain: "code",
      taskIntent: "deep_work",
      executionMode: "execute",
      agentConfig: { deepWorkMode: true },
    });
    executor.task.prompt = TaskStrategyService.decoratePrompt(
      rawPrompt,
      route,
      { ...strategy, taskDomain: "code" },
      "RELATIONSHIP MEMORY (continuity context, not hard constraints):\nIdentity:\n- Preferred name: Almarion.",
    );

    const built = await buildExecutionPrompt(executor);
    const strategySection = sectionText(built, "task_strategy");

    expect(strategySection).toContain("TASK STRATEGY:");
    expect(strategySection).toContain("scratchpad_write");
    expect(strategySection).toMatch(/run the relevant tests, lint, and build checks/i);
    expect(built.systemBlocks.find((b) => b.stableKey.startsWith("task_strategy:"))).toMatchObject({
      scope: "session",
    });
    expect(built.prompt).not.toContain("Almarion");
    expect(built.prompt).not.toMatch(/answer_first=|timeout_finalize_bias=|AGENT_STRATEGY_CONTEXT/);
  });

  it("delivers the debug contract and the live runtime ingest URL in debug mode", async () => {
    const executor = makePromptExecutor({
      title: "Debug checkout crash",
      prompt: "The checkout page crashes after clicking Pay. Find out why and fix it.",
      taskDomain: "code",
      taskIntent: "execution",
      executionMode: "debug",
    });
    executor.task.id = DEBUG_TASK_ID;

    const built = await buildExecutionPrompt(executor);
    const strategySection = sectionText(built, "task_strategy");

    expect(strategySection).toMatch(/debug mode/i);
    expect(strategySection).toContain("cowork-debug");
    expect(strategySection).toMatch(
      new RegExp(`http://127\\.0\\.0\\.1:\\d+/cowork-debug/${DEBUG_TASK_ID}/ingest\\?token=\\w+`),
    );
    // The ingest endpoint reports into the timeline, not the model context.
    expect(strategySection).toMatch(/timeline/i);
  });

  it("removes the ingest URL from later prompts once the debug session has ended", async () => {
    const executor = makePromptExecutor({
      title: "Debug checkout crash",
      prompt: "The checkout page crashes after clicking Pay. Find out why and fix it.",
      taskDomain: "code",
      taskIntent: "execution",
      executionMode: "debug",
    });
    executor.task.id = DEBUG_TASK_ID;
    const first = sectionText(await buildExecutionPrompt(executor), "task_strategy");
    const firstUrl = first.match(/http:\/\/127\.0\.0\.1:\d+\/\S+/)?.[0];
    expect(firstUrl).toBeTruthy();

    executor.endDebugRuntimeSessionIfNeeded();
    await new Promise((resolve) => setImmediate(resolve));
    const afterEnd = sectionText(await buildExecutionPrompt(executor), "task_strategy");

    expect(afterEnd).not.toContain(String(firstUrl));
  });

  it("adds no strategy section to a plain execution task", async () => {
    const executor = makePromptExecutor({
      title: "Fix failing parseDate test",
      prompt: CODING_PROMPT,
      taskDomain: "code",
      taskIntent: "execution",
      executionMode: "execute",
    });

    const built = await buildExecutionPrompt(executor);

    expect(built.prompt).not.toContain("TASK STRATEGY:");
  });
});

describe("citation guidance", () => {
  function seedCitations(executor: Any): void {
    executor.citationTracker = new CitationTracker(executor.task.id);
    executor.citationTracker.addFromSearch([
      {
        title: "Announcing Rust 1.90",
        url: "https://blog.rust-lang.org/2026/09/18/Rust-1.90.0.html",
        snippet: "Release announcement",
      },
    ]);
    executor.citationTracker.addFromFetch("https://releases.rs/docs/1.90.0/", "Rust 1.90.0 notes");
  }

  it("lists collected web sources in the final summary step prompt", async () => {
    const { executor, captured } = makeStepExecutor({
      title: "Rust release",
      prompt: "Research what changed in the latest Rust release and summarize it.",
      taskDomain: "research",
      taskIntent: "execution",
      executionMode: "execute",
    });
    seedCitations(executor);
    const research: Any = {
      id: "1",
      description: "Search the web for the latest Rust release notes.",
      status: "completed",
    };
    const summary: Any = {
      id: "2",
      description: "Summarize what changed in the release.",
      status: "pending",
    };
    executor.plan = { description: "Research and summarize", steps: [research, summary] };

    await executor.executeStep(summary);

    expect(captured.systemPrompts[0]).toContain("Sources Collected So Far");
    expect(captured.systemPrompts[0]).toContain("[1] Announcing Rust 1.90");
    expect(captured.systemPrompts[0]).toContain("[N] notation");
  });

  it("keeps the source list out of intermediate research steps", async () => {
    const { executor, captured } = makeStepExecutor({
      title: "Rust release",
      prompt: "Research what changed in the latest Rust release and summarize it.",
      taskDomain: "research",
      taskIntent: "execution",
      executionMode: "execute",
    });
    seedCitations(executor);
    const research: Any = {
      id: "1",
      description: "Search the web for the latest Rust release notes.",
      status: "pending",
    };
    const summary: Any = {
      id: "2",
      description: "Summarize what changed in the release.",
      status: "pending",
    };
    executor.plan = { description: "Research and summarize", steps: [research, summary] };

    await executor.executeStep(research);

    expect(captured.systemPrompts[0]).not.toContain("Sources Collected So Far");
  });
});
