import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor tool allow-list semantics", () => {
  function createExecutor(allowedTools?: string[]) {
    const executor = Object.create(TaskExecutor.prototype) as any;
    executor.task = { agentConfig: { allowedTools } };
    executor.toolRegistry = {
      getTools: vi
        .fn()
        .mockReturnValue([{ name: "read_file" }, { name: "write_file" }, { name: "canvas_push" }]),
    };
    executor.toolFailureTracker = {
      getDisabledTools: vi.fn().mockReturnValue([]),
    };
    executor.isVisualCanvasTask = vi.fn().mockReturnValue(false);
    executor.isCanvasTool = vi.fn((toolName: string) => /^canvas_/.test(toolName));
    executor.logTag = "[Executor:test]";
    return executor;
  }

  it("treats an explicitly configured empty allow-list as deny-all", () => {
    const executor = createExecutor([]);
    const availableTools = (executor as any).getAvailableTools();

    expect(availableTools).toEqual([]);
    expect((executor as any).isToolRestrictedByPolicy("read_file")).toBe(true);
  });

  it("does not enforce allow-list when it is not configured", () => {
    const executor = createExecutor(undefined);
    const availableTools = (executor as any).getAvailableTools();

    expect(availableTools).toEqual([{ name: "read_file" }, { name: "write_file" }]);
    expect((executor as any).isToolRestrictedByPolicy("read_file")).toBe(false);
  });
});
