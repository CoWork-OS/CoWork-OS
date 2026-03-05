import { describe, expect, it, vi } from "vitest";

import type { LLMToolResult } from "../llm";
import { TaskExecutor } from "../executor";

type ParallelExecutorFixture = {
  executor: Any;
  events: Array<{ type: string; payload: Any }>;
};

function createParallelExecutorFixture(
  overrides: Record<string, unknown> = {},
): ParallelExecutorFixture {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  const events: Array<{ type: string; payload: Any }> = [];

  executor.task = {
    id: "task-parallel",
    prompt: "Run read-only tools",
  };
  executor.currentToolBatchGroupId = "tools:step:test:1";
  executor.toolBatchParallelEnabled = true;
  executor.toolBatchParallelMax = 2;
  executor.totalToolCallCount = 0;
  executor.webSearchToolCallCount = 0;
  executor.crossStepToolFailures = new Map();
  executor.normalizeToolName = vi.fn((name: string) => ({ name }));
  executor.applyPreToolUsePolicyHook = vi.fn(() => ({
    blockedResult: null,
    forcedToolName: null,
    forcedInput: null,
  }));
  executor.getToolPolicyContext = vi.fn(() => ({
    executionMode: "execute",
    taskDomain: "auto",
  }));
  executor.toolFailureTracker = {
    isDisabled: vi.fn(() => false),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(() => false),
  };
  executor.toolCallDeduplicator = {
    checkDuplicate: vi.fn(() => ({ isDuplicate: false, reason: "" })),
    recordCall: vi.fn(),
  };
  executor.checkFileOperation = vi.fn(() => ({ blocked: false }));
  executor.evaluateWebFetchPolicy = vi.fn(() => ({ blocked: false }));
  executor.evaluateWebSearchPolicyAndBudget = vi.fn((_: Any, stepCount: number) => ({
    blocked: false,
    scope: "task",
    used: stepCount,
    limit: 8,
    remaining: Math.max(0, 8 - stepCount),
    stepUsed: stepCount,
    stepLimit: 3,
    stepRemaining: Math.max(0, 3 - stepCount),
  }));
  executor.detectStrictTaskRootPathViolationInInput = vi.fn(() => null);
  executor.rewriteToolInputPathByPinnedRoot = vi.fn((_: string, input: Any) => ({
    rewritten: false,
    input,
  }));
  executor.isParallelToolCallEligible = vi.fn(() => true);
  executor.enforceToolBudget = vi.fn();
  executor.executeToolWithHeartbeat = vi.fn(async (toolName: string, input: Any) => ({
    success: true,
    toolName,
    input,
  }));
  executor.getToolTimeoutMs = vi.fn(() => 1000);
  executor.tryWorkspaceBoundaryRecovery = vi.fn(async () => ({ recovered: false }));
  executor.recordFileOperation = vi.fn();
  executor.recordToolUsage = vi.fn();
  executor.recordToolResult = vi.fn();
  executor.getToolFailureReason = vi.fn((result: Any, fallback: string) =>
    typeof result?.error === "string" ? result.error : fallback,
  );
  executor.isHardToolFailure = vi.fn(() => false);
  executor.emitEvent = vi.fn((type: string, payload: Any) => {
    events.push({ type, payload });
  });
  executor.emitToolLaneStarted = vi.fn();
  executor.emitToolLaneFinished = vi.fn();

  Object.assign(executor, overrides);

  return { executor, events };
}

function makeToolUse(id: string, name: string, input: Record<string, unknown>): Any {
  return {
    type: "tool_use",
    id,
    name,
    input,
  };
}

function makeParallelParams(responseContent: Any[]): Record<string, unknown> {
  return {
    phase: "step",
    stepId: "step-1",
    stepDescription: "Parallel tool step",
    responseContent,
    availableToolNames: new Set(["web_search", "web_fetch"]),
    forceFinalizeWithoutTools: false,
    stepMode: "analysis_only",
    targetPaths: [],
    stepWebSearchCallCount: 0,
    toolErrors: new Set<string>(),
    persistentToolFailures: new Map<string, number>(),
    requiredTools: new Set<string>(),
    requiredToolsAttempted: new Set<string>(),
    requiredToolsSucceeded: new Set<string>(),
  };
}

describe("TaskExecutor parallel tool batches", () => {
  it("executes eligible calls concurrently while preserving tool result index order", async () => {
    const { executor } = createParallelExecutorFixture({
      executeToolWithHeartbeat: vi.fn(async (_toolName: string, input: Any) => {
        const delay = input.delayMs as number;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return { success: true, value: input.value };
      }),
    });
    const responseContent = [
      makeToolUse("use-1", "web_fetch", { value: "first", delayMs: 30 }),
      makeToolUse("use-2", "web_search", { value: "second", delayMs: 5 }),
    ];

    const result = (await (executor as Any).tryExecuteEligibleToolBatchInParallel(
      makeParallelParams(responseContent),
    )) as { toolResults: LLMToolResult[] } | null;

    expect(result).not.toBeNull();
    expect(result?.toolResults.map((entry) => entry.tool_use_id)).toEqual(["use-1", "use-2"]);
  });

  it("returns null to force serial fallback when any call is not parallel-eligible", async () => {
    const { executor, events } = createParallelExecutorFixture({
      isParallelToolCallEligible: vi.fn((_toolName: string, input: Any) => input.parallel !== false),
    });
    const responseContent = [
      makeToolUse("use-1", "web_fetch", { parallel: true }),
      makeToolUse("use-2", "web_search", { parallel: false }),
    ];

    const result = await (executor as Any).tryExecuteEligibleToolBatchInParallel(
      makeParallelParams(responseContent),
    );

    expect(result).toBeNull();
    expect((executor as Any).executeToolWithHeartbeat).not.toHaveBeenCalled();
    expect((executor as Any).enforceToolBudget).not.toHaveBeenCalled();
    expect(events.some((entry) => entry.type === "tool_call")).toBe(false);
  });

  it("falls back to serial when deterministic web_search step budget preflight blocks overflow", async () => {
    const { executor } = createParallelExecutorFixture({
      evaluateWebSearchPolicyAndBudget: vi.fn((_: Any, stepCount: number) =>
        stepCount >= 1
          ? {
              blocked: true,
              reason: "web_search step budget exhausted",
              failureClass: "budget_exhausted",
              scope: "step",
              used: 1,
              limit: 8,
              remaining: 7,
              stepUsed: stepCount,
              stepLimit: 1,
              stepRemaining: 0,
            }
          : {
              blocked: false,
              scope: "step",
              used: 0,
              limit: 8,
              remaining: 8,
              stepUsed: 0,
              stepLimit: 1,
              stepRemaining: 1,
            },
      ),
    });
    const responseContent = [
      makeToolUse("use-1", "web_search", { query: "one" }),
      makeToolUse("use-2", "web_search", { query: "two" }),
    ];

    const result = await (executor as Any).tryExecuteEligibleToolBatchInParallel(
      makeParallelParams(responseContent),
    );

    expect(result).toBeNull();
    expect((executor as Any).executeToolWithHeartbeat).not.toHaveBeenCalled();
    expect((executor as Any).enforceToolBudget).not.toHaveBeenCalled();
  });

  it("keeps sibling lane results stable when one lane fails", async () => {
    const { executor } = createParallelExecutorFixture({
      executeToolWithHeartbeat: vi.fn(async (toolName: string) => {
        if (toolName === "web_search") {
          throw new Error("network timeout");
        }
        return { success: true, data: "ok" };
      }),
    });
    const params = makeParallelParams([
      makeToolUse("use-1", "web_fetch", { url: "https://example.com" }),
      makeToolUse("use-2", "web_search", { query: "example" }),
    ]);
    params.requiredTools = new Set(["web_fetch"]);

    const result = (await (executor as Any).tryExecuteEligibleToolBatchInParallel(params)) as
      | {
          toolResults: LLMToolResult[];
          hadToolError: boolean;
          hadAnyToolSuccess: boolean;
          requiredToolsSucceeded?: Set<string>;
        }
      | null;

    expect(result).not.toBeNull();
    expect(result?.hadToolError).toBe(true);
    expect(result?.hadAnyToolSuccess).toBe(true);
    expect(result?.toolResults).toHaveLength(2);
    expect(result?.toolResults[0]?.is_error).toBe(false);
    expect(result?.toolResults[1]?.is_error).toBe(true);
  });

  it("emits follow-up correlation metadata for lane events with stable indices", async () => {
    const { executor, events } = createParallelExecutorFixture();
    const params = makeParallelParams([
      makeToolUse("follow-1", "web_fetch", { url: "https://one.test" }),
      makeToolUse("follow-2", "web_search", { query: "two" }),
    ]);
    params.phase = "follow_up";
    params.followUp = true;

    const result = await (executor as Any).tryExecuteEligibleToolBatchInParallel(params);

    expect(result).not.toBeNull();
    const toolCalls = events.filter((entry) => entry.type === "tool_call").map((entry) => entry.payload);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      toolUseId: "follow-1",
      toolCallIndex: 1,
      toolBatchPhase: "follow_up",
      groupId: "tools:step:test:1",
    });
    expect(toolCalls[1]).toMatchObject({
      toolUseId: "follow-2",
      toolCallIndex: 2,
      toolBatchPhase: "follow_up",
      groupId: "tools:step:test:1",
    });
  });
});
