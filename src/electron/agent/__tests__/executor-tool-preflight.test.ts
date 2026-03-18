import { describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";

function createPreflightExecutor() {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  executor.normalizeToolName = vi.fn((name: string) => ({
    name,
    original: name,
    modified: false,
  }));
  executor.applyPreToolUsePolicyHook = vi.fn(() => ({
    blockedResult: undefined,
    forcedToolName: undefined,
    forcedInput: undefined,
  }));
  executor.inferMissingParameters = vi.fn((_toolName: string, input: Any) => ({
    modified: false,
    input,
  }));
  executor.emitEvent = vi.fn();
  executor.handleCanvasPushFallback = vi.fn(async () => undefined);
  executor.detectStrictTaskRootPathViolationInInput = vi.fn(() => null);
  executor.rewriteToolInputPathByPinnedRoot = vi.fn((_toolName: string, input: Any) => ({
    rewritten: false,
    input,
  }));
  executor.taskPinnedRoot = "/repo";

  return executor;
}

describe("TaskExecutor shared tool preflight", () => {
  it("returns the same invalid-input result for step and follow-up paths", async () => {
    const executor = createPreflightExecutor();

    const run = async (rewriteReason: "tool_pre_execution" | "tool_pre_execution_follow_up") =>
      (executor as Any).preflightToolInvocation({
        content: {
          id: "tool-1",
          name: "count_text",
          input: {},
        },
        contextText: "count words",
        stepMode: "analysis_only",
        rewriteReason,
        followUp: rewriteReason === "tool_pre_execution_follow_up",
      });

    const stepResult = await run("tool_pre_execution");
    const followUpResult = await run("tool_pre_execution_follow_up");

    expect(stepResult.status).toBe("blocked");
    expect(followUpResult.status).toBe("blocked");
    expect(stepResult.blockedReason).toBe("invalid_input");
    expect(followUpResult.blockedReason).toBe("invalid_input");
    expect(stepResult.blockedToolResult).toEqual(followUpResult.blockedToolResult);
  });

  it("returns the same strict-root failure result for step and follow-up paths", async () => {
    const executor = createPreflightExecutor();
    executor.detectStrictTaskRootPathViolationInInput = vi.fn(() => ({
      key: "path",
      from: "../outside.txt",
      expected: "inside.txt",
    }));

    const run = async (rewriteReason: "tool_pre_execution" | "tool_pre_execution_follow_up") =>
      (executor as Any).preflightToolInvocation({
        content: {
          id: "tool-2",
          name: "read_file",
          input: { path: "../outside.txt" },
        },
        contextText: "read file",
        stepMode: "analysis_only",
        rewriteReason,
        followUp: rewriteReason === "tool_pre_execution_follow_up",
      });

    const stepResult = await run("tool_pre_execution");
    const followUpResult = await run("tool_pre_execution_follow_up");

    expect(stepResult.status).toBe("blocked");
    expect(followUpResult.status).toBe("blocked");
    expect(stepResult.blockedReason).toBe("task_root_strict_fail");
    expect(followUpResult.blockedReason).toBe("task_root_strict_fail");
    expect(stepResult.blockedToolResult).toEqual(followUpResult.blockedToolResult);
  });

  it("applies forced tool rewrites through the shared preflight path", async () => {
    const executor = createPreflightExecutor();
    executor.applyPreToolUsePolicyHook = vi.fn(() => ({
      blockedResult: undefined,
      forcedToolName: "read_file",
      forcedInput: { path: "README.md" },
    }));

    const result = await (executor as Any).preflightToolInvocation({
      content: {
        id: "tool-3",
        name: "functions.read_file",
        input: {},
      },
      contextText: "readme",
      stepMode: "analysis_only",
      rewriteReason: "tool_pre_execution",
    });

    expect(result.status).toBe("ok");
    expect(result.canonicalToolName).toBe("read_file");
    expect(result.forcedToolAction).toEqual({
      originalToolName: "functions.read_file",
      forcedToolName: "read_file",
    });
  });
});
