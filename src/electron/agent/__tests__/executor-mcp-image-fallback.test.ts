/**
 * Simple/terminal image-generation mode with a connected MCP image tool
 * (e.g. a local "Qwen Image" server exposed as mcp_qwen_generate_image).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import type { LLMResponse } from "../llm";
import { MCPSettingsManager } from "../../mcp/settings";

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

function toolUseResponse(name: string, input: Record<string, Any>, id = `tool-${name}`) {
  return {
    stopReason: "tool_use",
    content: [{ type: "tool_use", id, name, input }],
  } as LLMResponse;
}

function textResponse(text: string): LLMResponse {
  return { stopReason: "end_turn", content: [{ type: "text", text }] };
}

const schema = { type: "object", properties: {} };
const MCP_IMAGE_TOOLS = [
  "mcp_qwen_generate_image",
  "mcp_qwen_edit_image",
  "mcp_qwen_get_image_result",
  "mcp_qwen_list_images",
];

function createImageExecutor(
  responses: LLMResponse[],
  toolResults: Record<string, Any | Any[]>,
  options: { mcpTools?: string[] } = {},
) {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-image",
    title: "Create image",
    prompt: "create an image of a snow leopard",
    rawPrompt: "create an image of a snow leopard",
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp",
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: true,
    },
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
    simpleImageGenerationAttempted: false,
    simpleImageGenerationCompleted: false,
    simpleImageGenerationFailed: false,
    mcpImageGenerationAttempted: false,
  });
  executor.contextManager = {
    compactMessagesWithMeta: vi.fn((messages: Any) => ({
      messages,
      meta: {
        availableTokens: 1_000_000,
        originalTokens: 0,
        truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 0 },
        removedMessages: {
          didRemove: false,
          count: 0,
          tokensAfter: 0,
          messages: [],
        },
        kind: "none",
      },
    })),
    getContextUtilization: vi.fn().mockReturnValue({ utilization: 0 }),
    getAvailableTokens: vi.fn().mockReturnValue(1_000_000),
  };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  const mcpTools = options.mcpTools ?? MCP_IMAGE_TOOLS;
  executor.getAvailableTools = vi.fn().mockReturnValue([
    { name: "generate_image", description: "", input_schema: schema },
    { name: "write_file", description: "", input_schema: schema },
    { name: "web_search", description: "", input_schema: schema },
    ...mcpTools.map((name) => ({
      name,
      description: "",
      input_schema: schema,
    })),
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
  const queuedResults = new Map<string, Any[]>(
    Object.entries(toolResults).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );
  executor.toolRegistry = {
    executeTool: vi.fn(async (name: string) => {
      const queue = queuedResults.get(name);
      if (!queue || queue.length === 0) return { success: true };
      return queue.length > 1 ? queue.shift() : queue[0];
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
    if (!response) return textResponse("Done.");
    return response;
  });
  executor.abortController = new AbortController();
  return executor;
}

function executedToolNames(executor: Any): string[] {
  return executor.toolRegistry.executeTool.mock.calls.map(([name]: [string]) => name);
}

function blockedReasons(executor: Any): string[] {
  return executor.emitEvent.mock.calls
    .filter(([type]: [string]) => type === "tool_blocked")
    .map(([, payload]: [string, Any]) => String(payload?.reason || ""));
}

describe("TaskExecutor MCP image-generation fallback", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  beforeAll(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterAll(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({
      toolNamePrefix: "mcp_",
    } as Any);
  });

  describe("isMcpImageGenerationToolName", () => {
    it.each([
      "mcp_qwen_generate_image",
      "mcp_qwen_edit_image",
      "mcp_qwen_get_image_result",
      "mcp_generate_image",
      "mcp_image_result",
    ])("matches %s", (name) => {
      const executor = createImageExecutor([], {});
      expect(executor.isMcpImageGenerationToolName(name)).toBe(true);
    });

    it.each([
      "mcp_list_images",
      "mcp_qwen_list_images",
      "generate_image",
      "qwen_generate_image",
      "mcp_qwen_generate_image_batch",
      "mcp_qwen_regenerate_image",
      "mcp_",
      "",
    ])("does not match %s", (name) => {
      const executor = createImageExecutor([], {});
      expect(executor.isMcpImageGenerationToolName(name)).toBe(false);
    });

    it("uses the configured MCP tool-name prefix", () => {
      vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({
        toolNamePrefix: "ext_",
      } as Any);
      const executor = createImageExecutor([], {});
      expect(executor.isMcpImageGenerationToolName("ext_qwen_generate_image")).toBe(true);
      expect(executor.isMcpImageGenerationToolName("mcp_qwen_generate_image")).toBe(false);
    });

    it("only treats generate-type tools as fallback candidates", () => {
      const executor = createImageExecutor([], {});
      expect(executor.isMcpImageGenerateToolName("mcp_qwen_generate_image")).toBe(true);
      expect(executor.isMcpImageGenerateToolName("mcp_qwen_get_image_result")).toBe(false);
      expect(
        executor.findMcpImageGenerationFallbackTool(["generate_image", "mcp_qwen_edit_image"]),
      ).toBeNull();
      expect(
        executor.findMcpImageGenerationFallbackTool(["generate_image", "mcp_qwen_generate_image"]),
      ).toBe("mcp_qwen_generate_image");
      executor.mcpImageGenerationAttempted = true;
      expect(executor.findMcpImageGenerationFallbackTool(["mcp_qwen_generate_image"])).toBeNull();
    });
  });

  it("detects an image only when formatMCPResult saved one", () => {
    const executor = createImageExecutor([], {});
    expect(
      executor.mcpImageToolResultContainsImage("Generated in 41s\nSaved image: qwen-1.png"),
    ).toBe(true);
    expect(
      executor.mcpImageToolResultContainsImage(
        "Still generating (step 7 of 8). Call qwen_get_image_result with job_id=2 to get the image.",
      ),
    ).toBe(false);
    expect(
      executor.mcpImageToolResultContainsImage({
        success: false,
        error: "boom",
      }),
    ).toBe(false);
    expect(executor.mcpImageToolResultContainsImage(undefined)).toBe(false);
  });

  it("keeps MCP image tools in the image-only tool list", () => {
    const executor = createImageExecutor([], {});
    const scoped = executor.applyStepScopedToolPolicy(
      executor.getAvailableTools().map((tool: Any) => ({ name: tool.name })),
    );
    expect(scoped.map((tool: Any) => tool.name)).toEqual([
      "generate_image",
      "mcp_qwen_generate_image",
      "mcp_qwen_edit_image",
      "mcp_qwen_get_image_result",
    ]);
  });

  it("falls back to the MCP image tool after the built-in generator fails", async () => {
    const executor = createImageExecutor(
      [
        toolUseResponse("generate_image", { prompt: "snow leopard" }),
        toolUseResponse("mcp_qwen_generate_image", { prompt: "snow leopard" }),
        toolUseResponse("mcp_qwen_get_image_result", { job_id: 2 }),
        textResponse("Should not be needed."),
      ],
      {
        generate_image: {
          success: false,
          error: "No image provider configured",
        },
        mcp_qwen_generate_image:
          "Still generating (step 7 of 8). Call qwen_get_image_result with job_id=2 to get the image.",
        mcp_qwen_get_image_result: "Image ready.\nSaved image: snow-leopard.png",
      },
    );
    executor.emitEvent = vi.fn();
    const step: Any = {
      id: "1",
      description: "Generate the requested image.",
      status: "pending",
    };

    await executor.executeStep(step);

    expect(executedToolNames(executor)).toEqual([
      "generate_image",
      "mcp_qwen_generate_image",
      "mcp_qwen_get_image_result",
    ]);
    expect(blockedReasons(executor)).toEqual([]);
    expect(executor.simpleImageGenerationCompleted).toBe(true);
    expect(executor.simpleImageGenerationFailed).toBe(false);
    expect(step.status).toBe("completed");
    expect(executor.callLLMWithRetry).toHaveBeenCalledTimes(3);
    // The final answer shows the saved image inline.
    expect(executor.lastAssistantOutput).toBe(
      "Created the requested image.\n\n![snow leopard](snow-leopard.png)",
    );
    // The model was pointed at the MCP fallback after the built-in failure.
    expect(JSON.stringify(executor.conversationHistory)).toContain(
      "a local MCP image tool (mcp_qwen_generate_image) is available",
    );
  });

  it("falls back after a thrown built-in failure and completes on an immediate MCP image", async () => {
    const executor = createImageExecutor(
      [
        toolUseResponse("generate_image", { prompt: "snow leopard" }),
        toolUseResponse("mcp_qwen_generate_image", { prompt: "snow leopard" }),
      ],
      {
        mcp_qwen_generate_image: "Saved image: snow-leopard.png",
      },
    );
    const originalExecute = executor.toolRegistry.executeTool;
    executor.toolRegistry.executeTool = vi.fn(async (name: string, input: Any) => {
      if (name === "generate_image") throw new Error("Provider request failed (401)");
      return originalExecute(name, input);
    });
    executor.emitEvent = vi.fn();
    const step: Any = {
      id: "1",
      description: "Generate the requested image.",
      status: "pending",
    };

    await executor.executeStep(step);

    expect(executedToolNames(executor)).toEqual(["generate_image", "mcp_qwen_generate_image"]);
    expect(executor.simpleImageGenerationCompleted).toBe(true);
    expect(step.status).toBe("completed");
  });

  it("falls back instead of pausing when the user denies the built-in generator", async () => {
    const executor = createImageExecutor(
      [
        toolUseResponse("generate_image", { prompt: "snow leopard" }),
        toolUseResponse("mcp_qwen_generate_image", { prompt: "snow leopard" }),
      ],
      {
        mcp_qwen_generate_image: "Saved image: snow-leopard.png",
      },
    );
    const originalExecute = executor.toolRegistry.executeTool;
    executor.toolRegistry.executeTool = vi.fn(async (name: string, input: Any) => {
      if (name === "generate_image") throw new Error('Tool "generate_image" approval denied');
      return originalExecute(name, input);
    });
    executor.emitEvent = vi.fn();
    const step: Any = {
      id: "1",
      description: "Generate the requested image.",
      status: "pending",
    };

    await executor.executeStep(step);

    expect(executedToolNames(executor)).toEqual(["generate_image", "mcp_qwen_generate_image"]);
    expect(executor.simpleImageGenerationCompleted).toBe(true);
    expect(step.status).toBe("completed");
    const pausedForUser = (executor.emitEvent as Any).mock.calls.some(
      ([type, payload]: [string, Any]) =>
        type === "awaiting_user_input" && payload?.reasonCode === "user_action_required_tool",
    );
    expect(pausedForUser).toBe(false);
  });

  it("embeds the built-in generator's image in the final answer", async () => {
    const executor = createImageExecutor([toolUseResponse("generate_image", { prompt: "x" })], {
      generate_image: {
        success: true,
        model: "test-model",
        images: [
          {
            path: "/tmp/art/snow_leopard.png",
            filename: "snow_leopard.png",
            mimeType: "image/png",
            size: 10,
          },
        ],
      },
    });
    executor.emitEvent = vi.fn();
    const step: Any = { id: "1", description: "Generate the requested image.", status: "pending" };

    await executor.executeStep(step);

    expect(step.status).toBe("completed");
    expect(executor.lastAssistantOutput).toBe(
      "Created the requested image.\n\n![snow leopard](art/snow_leopard.png)",
    );
  });

  it("makes the created-image answer the final result over earlier commentary", async () => {
    const executor = createImageExecutor(
      [toolUseResponse("mcp_qwen_generate_image", { prompt: "snow leopard" })],
      { mcp_qwen_generate_image: "Saved image: snow-leopard.png" },
    );
    executor.emitEvent = vi.fn();
    executor.lastNonVerificationOutput = "I’ll use the local image tool to create it.";
    const step: Any = { id: "1", description: "Generate the requested image.", status: "pending" };

    await executor.executeStep(step);
    // Commentary that arrived with the tool call is recorded after the tool ran.
    executor.lastNonVerificationOutput = "I’ll generate the banner now.";
    executor.lastAssistantText = "I’ll generate the banner now.";

    expect(executor.buildResultSummary()).toBe(
      "Created the requested image.\n\n![snow leopard](snow-leopard.png)",
    );
  });

  it("prefers a connected MCP image tool in the step contract", () => {
    const executor = createImageExecutor([], {});
    executor.toolRegistry.getTools = () => [
      { name: "generate_image" },
      { name: "mcp_qwen_generate_image" },
    ];
    expect(executor.findConnectedMcpImageGenerateTool()).toBe("mcp_qwen_generate_image");
    executor.mcpImageGenerationAttempted = true;
    expect(executor.findConnectedMcpImageGenerateTool()).toBeNull();
    executor.mcpImageGenerationAttempted = false;
    executor.toolRegistry.getTools = () => [{ name: "generate_image" }];
    expect(executor.findConnectedMcpImageGenerateTool()).toBeNull();
  });

  it("requires the MCP image tool, not write_file, when it is connected", () => {
    const executor = createImageExecutor([], {});
    executor.toolRegistry.getTools = () => [
      { name: "generate_image" },
      { name: "mcp_qwen_generate_image" },
    ];
    const contract = executor.resolveStepExecutionContract({
      id: "1",
      description: "Generate the requested image and share the resulting file.",
      status: "pending",
    });
    expect(Array.from(contract.requiredTools)).toContain("mcp_qwen_generate_image");
    expect(contract.requiredTools.has("write_file")).toBe(false);
  });

  it("completes the step contract when the required MCP image tool succeeds", async () => {
    const executor = createImageExecutor(
      [toolUseResponse("mcp_qwen_generate_image", { prompt: "snow leopard" })],
      { mcp_qwen_generate_image: "Saved image: snow-leopard.png" },
    );
    executor.toolRegistry.getTools = () => [
      { name: "generate_image" },
      { name: "mcp_qwen_generate_image" },
    ];
    executor.emitEvent = vi.fn();
    const step: Any = {
      id: "1",
      description: "Generate the requested image and share the resulting file.",
      status: "pending",
    };

    await executor.executeStep(step);

    expect(step.status).toBe("completed");
    expect(executor.simpleImageGenerationCompleted).toBe(true);
  });

  it("embeds every image an MCP tool saved", () => {
    const executor = createImageExecutor([], {});
    const filenames = executor.extractMcpSavedImageFilenames(
      "Done.\nSaved image: first-shot.png\nSaved image: my banner (2).png\nSaved video: clip.mp4",
    );
    expect(filenames).toEqual(["first-shot.png", "my banner (2).png"]);
    expect(executor.buildCreatedImageAnswer(filenames)).toBe(
      "Created the requested image.\n\n![first shot](first-shot.png)\n\n![my banner (2)](<my banner (2).png>)",
    );
    expect(executor.buildCreatedImageAnswer([])).toBe("Created the requested image.");
  });

  it("still stops after a built-in failure when no MCP image tool is available", async () => {
    const executor = createImageExecutor(
      [
        toolUseResponse("generate_image", { prompt: "snow leopard" }),
        toolUseResponse("web_search", { query: "snow leopard" }),
      ],
      {
        generate_image: {
          success: false,
          error: "No image provider configured",
        },
      },
      { mcpTools: ["mcp_qwen_list_images"] },
    );
    executor.emitEvent = vi.fn();
    const step: Any = {
      id: "1",
      description: "Generate the requested image.",
      status: "pending",
    };

    await executor.executeStep(step);

    expect(executedToolNames(executor)).toEqual(["generate_image"]);
    expect(executor.callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(executor.simpleImageGenerationFailed).toBe(true);
    expect(step.status).toBe("failed");
  });

  it("ends as failed when the MCP fallback also fails", async () => {
    const executor = createImageExecutor(
      [
        toolUseResponse("generate_image", { prompt: "snow leopard" }),
        toolUseResponse("mcp_qwen_generate_image", { prompt: "snow leopard" }),
        toolUseResponse("mcp_qwen_generate_image", { prompt: "snow leopard" }, "retry"),
      ],
      {
        generate_image: {
          success: false,
          error: "No image provider configured",
        },
        mcp_qwen_generate_image: { success: false, error: "Model not loaded" },
      },
    );
    executor.emitEvent = vi.fn();
    const step: Any = {
      id: "1",
      description: "Generate the requested image.",
      status: "pending",
    };

    await executor.executeStep(step);

    expect(executedToolNames(executor)).toEqual(["generate_image", "mcp_qwen_generate_image"]);
    expect(executor.callLLMWithRetry).toHaveBeenCalledTimes(2);
    expect(executor.simpleImageGenerationCompleted).toBe(false);
    expect(step.status).toBe("failed");
  });

  it("blocks MCP image tools once the image was generated, and other tools after a failure", async () => {
    const completed = createImageExecutor(
      [toolUseResponse("mcp_qwen_generate_image", { prompt: "again" }), textResponse("Done.")],
      {},
    );
    completed.simpleImageGenerationCompleted = true;
    completed.emitEvent = vi.fn();
    await completed.executeStep({
      id: "1",
      description: "Generate the image.",
      status: "pending",
    });
    expect(executedToolNames(completed)).toEqual([]);
    expect(blockedReasons(completed)).toContain("simple_image_generation_already_completed");

    const failed = createImageExecutor(
      [
        toolUseResponse("generate_image", { prompt: "retry" }),
        toolUseResponse("mcp_qwen_generate_image", { prompt: "fallback" }, "fallback"),
      ],
      { mcp_qwen_generate_image: "Saved image: fallback.png" },
    );
    failed.simpleImageGenerationAttempted = true;
    failed.simpleImageGenerationFailed = true;
    failed.emitEvent = vi.fn();
    const step: Any = {
      id: "1",
      description: "Generate the image.",
      status: "pending",
    };
    await failed.executeStep(step);
    // The built-in retry is blocked, the MCP fallback is not.
    expect(blockedReasons(failed)).toEqual(["simple_image_generation_already_failed"]);
    expect(executedToolNames(failed)).toEqual(["mcp_qwen_generate_image"]);
    expect(failed.simpleImageGenerationCompleted).toBe(true);
    expect(step.status).toBe("completed");
  });
});
