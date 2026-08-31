import { describe, expect, it, vi } from "vitest";
import { StreamingToolExecutor } from "../runtime/StreamingToolExecutor";

describe("StreamingToolExecutor", () => {
  it("flushes queued tool uses in order", async () => {
    const executeTool = vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: 1 } })
      .mockResolvedValueOnce({ result: { ok: 2 } });
    const executor = new StreamingToolExecutor({ executeTool } as Any, {
      taskId: "task-1",
      phase: "step",
    });

    executor.addToolUse({ type: "tool_use", id: "1", name: "read_file", input: {} });
    executor.addToolUse({ type: "tool_use", id: "2", name: "glob", input: {} });

    const updates = await executor.flush();

    expect(updates.map((update) => update.toolUse.id)).toEqual(["1", "2"]);
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("discards pending tool uses", async () => {
    const executeTool = vi.fn();
    const executor = new StreamingToolExecutor({ executeTool } as Any, {
      taskId: "task-1",
      phase: "step",
    });

    executor.addToolUse({ type: "tool_use", id: "1", name: "read_file", input: {} });
    executor.discard();

    const updates = await executor.flush();
    expect(updates).toEqual([]);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("discards the queue when a non read-parallel tool is added", async () => {
    const executeTool = vi.fn();
    const executor = new StreamingToolExecutor(
      { executeTool } as Any,
      {
        taskId: "task-1",
        phase: "step",
      },
      (toolName) =>
        toolName === "write_file"
          ? {
              concurrencyClass: "exclusive",
              readOnly: false,
              idempotent: false,
            }
          : {
              concurrencyClass: "read_parallel",
              readOnly: true,
              idempotent: true,
            },
    );

    executor.addToolUse({ type: "tool_use", id: "1", name: "read_file", input: {} });
    executor.addToolUse({ type: "tool_use", id: "2", name: "write_file", input: {} });

    const updates = await executor.flush();
    expect(updates).toEqual([]);
    expect(executeTool).not.toHaveBeenCalled();
  });
});
