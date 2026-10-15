/**
 * Simple/terminal image-generation mode with a connected MCP image tool
 * (e.g. a local "Qwen Image" server exposed as mcp_qwen_generate_image).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { runApplicationTool } from "../tools/application-tools";
import type { LLMResponse } from "../llm";
import { MCPSettingsManager } from "../../mcp/settings";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

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

  it("routes an editable Photoshop request through an application mutation contract without forcing raster generation", () => {
    const executor = createImageExecutor([], {});
    const prompt =
      "Create a 1200x630 editable Photoshop banner and save a PSD and PNG in this workspace.";
    executor.task.prompt = executor.task.rawPrompt = prompt;
    executor.task.title = "Photoshop banner";
    executor.toolRegistry.getTools = () => [
      { name: "application_operation" },
      { name: "generate_image" },
      { name: "mcp_qwen_generate_image" },
      { name: "write_file" },
    ];
    const steps = [
      {
        id: "1",
        description: "Identify the background Photoshop capability and select fresh output paths.",
        status: "pending",
      },
      {
        id: "2",
        description:
          'Create a 1200 by 630 pixel banner with navy background #162436, mint accent #51D6B5, editable title text "Every app. One result." and editable subtitle text "Describe the work. See the result." Save cowork-final-banner.psd and export cowork-final-banner.png in the workspace through the background Photoshop service.',
        status: "pending",
      },
      { id: "3", description: "Inspect the saved files and deliver links.", status: "pending" },
      {
        id: "4",
        description:
          "Summarize completed work for the user. Link every requested deliverable that actually exists. Use the completed checks and actual artifact metadata to report the final outcome, page or sheet counts, and remaining limitations. Replace stale intermediate statements about pending checks. Do not modify files or repeat completed work.",
        status: "pending",
      },
    ];
    executor.plan = { steps };
    expect(executor.isTerminalImageGenerationTask()).toBe(false);
    expect(executor.isSimpleImageGenerationTask()).toBe(false);
    const discovery = executor.resolveStepExecutionContract(steps[0]);
    expect(discovery.mode).toBe("analysis_only");
    const creation = executor.resolveStepExecutionContract(steps[1]);
    expect(creation.mode).toBe("mutation_required");
    expect(creation.requiresArtifactEvidence).toBe(true);
    expect([...creation.requiredTools]).toContain("application_operation");
    expect([...creation.requiredTools]).not.toContain("write_file");
    expect([...creation.requiredTools]).not.toContain("edit_file");
    expect(executor.resolveStepExecutionContract(steps[3]).mode).toBe("analysis_only");
    for (const step of steps) {
      const contract = executor.resolveStepExecutionContract(step);
      expect([...contract.requiredTools]).not.toContain("mcp_qwen_generate_image");
      expect([...contract.requiredTools]).not.toContain("write_file");
    }
    executor.task.agentConfig = { readOnlyExecution: true };
    expect(executor.resolveStepExecutionContract(steps[1]).mode).toBe("analysis_only");
  });

  it("gives generic native UI edit/save steps native_app, not a file or scripting writer", () => {
    const executor = createImageExecutor([], {});
    executor.task.prompt = executor.task.rawPrompt =
      "Use native_app to change the selected Brand font size in /tmp/ps/background-edit.psd from 18 pt to 22 pt through Photoshop's UI, save it with a background keypress, then verify the saved PSD with local_photoshop_read. Do not use scripting to make the edit.";
    executor.toolRegistry.getTools = () => [
      { name: "application_operation" },
      { name: "native_app" },
      { name: "local_photoshop_read" },
      { name: "write_file" },
      { name: "edit_file" },
    ];
    const steps = [
      {
        id: "1",
        description:
          "Inspect the workspace file background-edit.psd read-only and record its dimensions, exact Brand layer path and current font size.",
        status: "pending",
      },
      {
        id: "2",
        description:
          "Locate the existing document window in the running com.adobe.Photoshop without launching or activating it, and observe its accessible font-size control.",
        status: "pending",
      },
      {
        id: "3",
        description:
          "Change the selected Brand font-size control from 18 pt to 22 pt using the observed background window and fresh accessibility state, with an expected-value guard.",
        status: "pending",
      },
      {
        id: "4",
        description:
          "Save only the already-open background-edit.psd using a background keypress directed at its document window, then inspect fresh native state for save completion.",
        status: "pending",
      },
      {
        id: "5",
        description:
          "Verify: inspect the saved background-edit.psd read-only and confirm Brand has fontSize 22 and five layers.",
        kind: "verification",
        status: "pending",
      },
    ];
    executor.plan = { steps };
    for (const step of steps.slice(0, 2))
      expect(executor.resolveStepExecutionContract(step).mode).toBe("analysis_only");
    for (const step of steps.slice(2, 4)) {
      const contract = executor.resolveStepExecutionContract(step);
      expect(contract.mode).not.toBe("mutation_required");
      expect([...contract.requiredTools]).toContain("native_app");
      expect(contract.contractReason).toBe("native_ui_action_required");
      for (const tool of ["application_operation", "write_file", "edit_file"])
        expect([...contract.requiredTools]).not.toContain(tool);
    }
    const verify = executor.resolveStepExecutionContract(steps[4]);
    expect(verify.mode).not.toBe("mutation_required");
    expect([...verify.requiredTools]).not.toContain("edit_file");
  });

  it("keeps PSD source inspection and fresh-path checks read-only, with its native reader available", () => {
    const executor = createImageExecutor([], {});
    executor.task.prompt = executor.task.rawPrompt =
      "Edit source.psd in Photoshop, preserve the source and save revised.psd and revised.png.";
    executor.toolRegistry.getTools = () => [
      { name: "application_operation" },
      { name: "local_photoshop_read" },
      { name: "write_file" },
      { name: "read_file" },
    ];
    const steps = [
      {
        id: "1",
        description:
          "Inspect source.psd to obtain its source hash, dimensions and exact nested layer paths.",
        status: "pending",
      },
      {
        id: "2",
        description:
          "Confirm that Title and Brand each resolve to a single editable layer. Confirm revised.psd and revised.png are fresh output paths; resolve any existing-output conflict before editing.",
        status: "pending",
      },
      {
        id: "3",
        description:
          "Apply the requested Photoshop edits and save revised.psd and export revised.png.",
        status: "pending",
      },
    ];
    executor.plan = { steps };
    const inspect = executor.resolveStepExecutionContract(steps[0]);
    expect(inspect.mode).toBe("analysis_only");
    expect([...inspect.requiredTools]).toContain("local_photoshop_read");
    expect([...inspect.requiredTools]).not.toContain("read_file");
    expect(
      executor
        .buildStepToolAllowlist(inspect, "analysis", "design", steps[0].description)
        .has("local_photoshop_read"),
    ).toBe(true);
    const prepare = executor.resolveStepExecutionContract(steps[1]);
    expect(prepare.mode).toBe("analysis_only");
    expect([...prepare.requiredTools]).not.toContain("write_file");
    const proposal = executor.resolveStepExecutionContract({
      id: "proposal",
      status: "pending",
      description:
        'Prepare a background Photoshop edit targeting the exact inspected layer paths, with fresh workspace output paths revised.psd and revised.png. Set Title to "Your apps. Your flow." at 42 points; rename Brand to Signature and hide it. Preserve all other layers.',
    });
    expect(proposal.mode).toBe("analysis_only");
    expect(proposal.requiresArtifactEvidence).toBe(false);
    expect([...proposal.requiredTools]).not.toContain("write_file");
    expect([...proposal.requiredTools]).not.toContain("edit_file");
    const execution = executor.resolveStepExecutionContract({
      id: "execute",
      status: "pending",
      description:
        "Execute the prepared background edit and track the original operation through completion, saving an editable revised.psd and exporting revised.png without overwriting source.psd or modifying its open unsaved state.",
    });
    expect(execution.mode).toBe("mutation_required");
    expect([...execution.requiredTools]).toContain("application_operation");
    expect([...execution.requiredTools]).not.toContain("write_file");
    expect([...execution.requiredTools]).not.toContain("edit_file");
    expect(
      executor.resolveStepExecutionContract({
        id: "combined",
        status: "pending",
        description:
          "Prepare the Photoshop changes and execute the edit, save revised.psd and export revised.png.",
      }).mode,
    ).toBe("mutation_required");
    for (const description of [
      "Produce the complete final reply to Almarion with revised.png displayed inline, a link to editable revised.psd, and a summary of the verified edits and source preservation.",
      "Provide the complete final response with revised.png inline and a link to revised.psd.",
    ]) {
      const presentation = executor.resolveStepExecutionContract({
        id: "present",
        status: "pending",
        description,
      });
      expect(presentation.requiresMutation).toBe(false);
      expect(presentation.mode).not.toBe("mutation_required");
      expect([...presentation.requiredTools]).not.toContain("application_operation");
      expect([...presentation.requiredTools]).not.toContain("write_file");
      expect([...presentation.requiredTools]).not.toContain("edit_file");
    }
    const apply = executor.resolveStepExecutionContract(steps[2]);
    expect(apply.mode).toBe("mutation_required");
    expect([...apply.requiredTools]).toContain("application_operation");
    expect([...apply.requiredTools]).not.toContain("write_file");
  });
  it("keeps fresh native readback read-only even when it describes the original edit", () => {
    const executor = createImageExecutor([], {});
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-readback-")));
    try {
      fs.writeFileSync(path.join(root, "source.psd"), "existing source");
      executor.workspace.path = root;
      executor.task.prompt = executor.task.rawPrompt =
        "Edit source.psd in Photoshop and save revised.psd and revised.png, preserving the source.";
      executor.toolRegistry.getTools = () => [
        { name: "application_operation" },
        { name: "local_photoshop_read" },
        { name: "write_file" },
        { name: "edit_file" },
      ];
      const step = {
        id: "verify",
        kind: "verification",
        status: "pending",
        description:
          "Verify: obtain fresh native readback of the original edit operation; confirm both output files exist with saved artifact hashes, the PSD remains editable, all requested text and layer properties match, Subtitle moved exactly 20 pixels vertically with no horizontal change, other layers and dimensions match the source inspection, and source.psd retains its original SHA-256.",
      };
      const contract = executor.resolveStepExecutionContract(step);
      expect(contract.mode).toBe("analysis_only");
      expect(contract.requiresArtifactEvidence).toBe(false);
      expect([...contract.requiredTools]).not.toContain("edit_file");
      expect([...contract.requiredTools]).not.toContain("write_file");
      expect(executor.classifyVerificationArtifactPathDecision(step, "source.psd").role).toBe(
        "inspect_existing",
      );
      const withReport = {
        ...step,
        description: "Verify the saved outputs, and write a verification report to source.psd.",
      };
      expect(executor.classifyVerificationArtifactPathDecision(withReport, "source.psd").role).toBe(
        "existing_only_write",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(["photoshop.banner.create", "photoshop.document.edit"])(
    "requires verified %s bytes and a fresh original task artifact event before counting a write",
    (capability) => {
      const executor = createImageExecutor([], {});
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "application-evidence-")));
      executor.workspace.path = root;
      const file = path.join(root, "banner.psd");
      const started = Date.now();
      const bytes = Buffer.from("synthetic saved bytes");
      const projection = {
        status: "complete",
        operation: {
          id: "original",
          request: { taskId: executor.task.id, capability },
          verification: "verified",
          verificationResult: { status: "verified" },
          route: { environment: { kind: "isolated_worker" } },
        },
        result: {
          resources: [{ kind: "file", system: "local", locator: file }],
          data: {
            path: file,
            delivered: true,
            persisted: {
              size: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        },
      };
      const collect = (action = "execute", result = projection) =>
        executor.collectMutationEvidence({
          toolName: "application_operation",
          input: { action, operationId: "original" },
          result,
          stepStartedAt: started,
        });
      try {
        executor.daemon.getTaskEvents.mockReturnValue([
          { type: "file_created", timestamp: started, payload: { path: file } },
        ]);
        expect(collect()).toBeNull();
        fs.writeFileSync(file, "synthetic saved bytes");
        expect(collect()?.artifact_registered).toBe(true);
        expect(collect("reconcile")?.fs_exists).toBe(true);
        expect(collect("create")).toBeNull();
        expect(collect("get")).toBeNull();
        expect(collect("execute", { ...projection, status: "unknown" })).toBeNull();
        expect(collect("execute", { ...projection, status: "partial" })).toBeNull();
        executor.daemon.getTaskEvents.mockReturnValue([]);
        expect(collect()).toBeNull();
        executor.daemon.getTaskEvents.mockReturnValue([
          { type: "file_created", timestamp: started - 60000, payload: { path: file } },
        ]);
        expect(collect()).toBeNull();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("accepts original native verification only while exact delivered bytes and ownership still match", () => {
    const executor = createImageExecutor([], {});
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "application-verification-")),
    );
    executor.workspace.path = root;
    const file = path.join(root, "banner.psd");
    const bytes = Buffer.from("native fixture output");
    fs.writeFileSync(file, bytes);
    const projection: Any = {
      status: "complete",
      operation: {
        id: "original",
        request: { taskId: executor.task.id, capability: "photoshop.banner.create" },
        verification: "verified",
        verificationResult: { status: "verified" },
        route: { environment: { kind: "isolated_worker" } },
      },
      result: {
        resources: [{ kind: "file", system: "local", locator: file }],
        data: {
          path: file,
          delivered: true,
          persisted: {
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      },
    };
    const targets = executor.buildArtifactPathTokens(file);
    const check = (result = projection, input: Any = { action: "get", operationId: "original" }) =>
      executor.hasArtifactVerificationToolEvidence(
        "application_operation",
        input,
        result,
        [".psd"],
        targets,
        new Set(),
      );
    try {
      expect(check()).toEqual({ matched: true, matchedExtensions: [".psd"] });
      expect(check(projection, { action: "reconcile", operationId: "original" }).matched).toBe(
        true,
      );
      executor.fileOperationTracker.recordFileCreation = vi.fn();
      executor.toolCallDeduplicator.clearHistoryAfterWorkspaceMutation = vi.fn();
      const record = (action: string, result = projection) =>
        (TaskExecutor as Any).prototype.recordFileOperation.call(
          executor,
          "application_operation",
          { action, operationId: "original" },
          result,
        );
      record("get");
      expect(executor.fileOperationTracker.recordFileCreation).not.toHaveBeenCalled();
      record("reconcile");
      expect(executor.fileOperationTracker.recordFileCreation).toHaveBeenCalledWith(file);
      executor.fileOperationTracker.recordFileCreation.mockClear();
      record("execute", { ...projection, status: "partial" });
      expect(executor.fileOperationTracker.recordFileCreation).not.toHaveBeenCalled();
      expect(
        check(projection, { action: "create", operationId: "original", path: file }).matched,
      ).toBe(false);
      expect(check(projection, { action: "get", operationId: "other" }).matched).toBe(false);
      expect(check({ ...projection, status: "partial" }).matched).toBe(false);
      expect(check({ ...projection, status: "unknown" }).matched).toBe(false);
      const foreign = structuredClone(projection);
      foreign.operation.request.taskId = "other";
      expect(check(foreign).matched).toBe(false);
      const unverified = structuredClone(projection);
      unverified.operation.verificationResult.status = "pending";
      expect(check(unverified).matched).toBe(false);
      const missing = structuredClone(projection);
      missing.result.data.delivered = false;
      expect(check(missing).matched).toBe(false);
      const workerOnly = structuredClone(projection);
      workerOnly.result.resources[0].system = "worker:vm";
      expect(check(workerOnly).matched).toBe(false);
      const admittedAt = Date.now();
      projection.operation.createdAt = admittedAt;
      projection.operation.verificationResult.checkedAt = admittedAt;
      executor.fileOperationTracker.getCreatedFiles.mockReturnValue([file]);
      executor.daemon.getTaskEvents.mockReturnValue([]);
      const mutation = () =>
        executor.collectMutationEvidence({
          toolName: "application_operation",
          input: { action: "execute", operationId: "original" },
          result: projection,
          stepStartedAt: admittedAt,
        });
      expect(mutation()?.observed_event_type).toBe("native_verified_delivery");
      projection.operation.createdAt = admittedAt - 60000;
      expect(mutation()).toBeNull();
      projection.operation.createdAt = admittedAt;
      projection.operation.request.taskId = "other";
      expect(mutation()).toBeNull();
      projection.operation.request.taskId = executor.task.id;
      fs.writeFileSync(file, Buffer.alloc(bytes.length, 42));
      expect(mutation()).toBeNull();
      expect(check().matched).toBe(false);
      record("reconcile");
      expect(executor.fileOperationTracker.recordFileCreation).not.toHaveBeenCalled();
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(root, "missing"), file);
      expect(check().matched).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "completes native creation and verification without shell when the event projection lags: %s",
    async (eventProjectionLagged) => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "application-verification-step-")),
      );
      const file = path.join(root, "banner.psd");
      const bytes = Buffer.from("native fixture output");
      fs.writeFileSync(file, bytes);
      const projection = {
        status: "complete",
        operation: {
          id: "original",
          createdAt: Date.now(),
          request: { taskId: "task-image", capability: "photoshop.banner.create" },
          verification: "verified",
          verificationResult: { status: "verified", checkedAt: Date.now() },
          route: { environment: { kind: "isolated_worker" } },
        },
        result: {
          resources: [{ kind: "file", system: "local", locator: file }],
          data: {
            path: file,
            delivered: true,
            persisted: {
              size: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        },
      };
      const service: Any = {
        get: async () => projection.operation,
        execute: async () => projection.operation,
        reconcile: async () => projection.operation,
        projection: () => ({
          operationId: "original",
          status: projection.status,
          result: projection.result,
        }),
      };
      const daemon: Any = { getApplicationExecutionService: () => service };
      const actualGet = await runApplicationTool(daemon, "task-image", {
        action: "get",
        operationId: "original",
      });
      const actualExecute = await runApplicationTool(daemon, "task-image", {
        action: "execute",
        operationId: "original",
      });
      const actualReconcile = await runApplicationTool(daemon, "task-image", {
        action: "reconcile",
        operationId: "original",
      });
      for (const result of [actualGet, actualExecute, actualReconcile]) {
        expect(result).toMatchObject({
          status: "complete",
          operationId: "original",
          operation: { id: "original" },
          result: projection.result,
        });
      }
      const executor = createImageExecutor(
        [
          toolUseResponse("application_operation", { action: "execute", operationId: "original" }),
          textResponse("Saved banner.psd through Photoshop."),
          toolUseResponse("application_operation", { action: "get", operationId: "original" }),
          {
            content: [{ type: "text", text: "OK" }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ] as Any,
        { application_operation: [actualExecute, actualGet] },
      );
      executor.workspace.path = root;
      executor.workspace.permissions.shell = false;
      executor.daemon.getTaskEvents.mockReturnValue(
        eventProjectionLagged
          ? []
          : [
              {
                type: "timeline_artifact_emitted",
                legacyType: "file_created",
                timestamp: Date.now(),
                payload: { path: file, legacyType: "file_created" },
              },
            ],
      );
      const tracked: string[] = [];
      executor.fileOperationTracker.getCreatedFiles.mockImplementation(() => tracked);
      executor.fileOperationTracker.recordFileCreation = vi.fn((filename) =>
        tracked.push(filename),
      );
      executor.toolCallDeduplicator.clearHistoryAfterWorkspaceMutation = vi.fn();
      executor.recordFileOperation = (TaskExecutor as Any).prototype.recordFileOperation.bind(
        executor,
      );
      executor.task.title = "Photoshop banner";
      executor.task.prompt =
        executor.task.rawPrompt = `Create an editable Photoshop banner and save ${file}.`;
      executor.toolRegistry.getTools = () => [
        { name: "application_operation", input_schema: schema },
      ];
      executor.getAvailableTools.mockReturnValue(executor.toolRegistry.getTools());
      const step: Any = {
        id: "verify",
        kind: "verification",
        description: `Verify the saved editable PSD at ${file}.`,
        status: "pending",
      };
      const creation: Any = {
        id: "create",
        description: `Create the editable banner through background Photoshop and save ${file}.`,
        status: "pending",
      };
      executor.plan = { steps: [creation, step] };
      try {
        await executor.executeStep(creation);
        expect(
          creation.status,
          JSON.stringify({ creation, events: executor.daemon.logEvent.mock.calls.slice(-8) }),
        ).toBe("completed");
        await executor.executeStep(step);
        expect(
          step.status,
          JSON.stringify({ step, events: executor.daemon.logEvent.mock.calls.slice(-8) }),
        ).toBe("completed");
        expect(executedToolNames(executor)).toEqual([
          "application_operation",
          "application_operation",
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

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

  it.each([false, true])(
    "stops after the initial MCP image call fails (throws=%s)",
    async (throws) => {
      const executor = createImageExecutor(
        [
          toolUseResponse("mcp_qwen_generate_image", { prompt: "snow leopard" }),
          toolUseResponse("mcp_qwen_generate_image", { prompt: "retry" }),
          textResponse("Should not be needed."),
        ],
        { mcp_qwen_generate_image: { success: false, error: "Image service unavailable" } },
      );
      if (throws)
        executor.toolRegistry.executeTool = vi.fn(async () => {
          throw new Error("Image service unavailable");
        });
      executor.emitEvent = vi.fn();
      const step: Any = {
        id: "1",
        description: "Generate the requested image.",
        status: "pending",
      };
      await executor.executeStep(step);
      expect(executedToolNames(executor)).toEqual(["mcp_qwen_generate_image"]);
      expect(executor.simpleImageGenerationFailed).toBe(true);
      expect(executor.callLLMWithRetry).toHaveBeenCalledTimes(1);
      expect(step.status).toBe("failed");
    },
  );

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
