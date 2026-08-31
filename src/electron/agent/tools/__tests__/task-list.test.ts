import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../registry";

const validItems = [{ title: "Implement feature", status: "pending" as const }];

describe("ToolRegistry task_list_*", () => {
  it("rejects checklist tools outside execute-capable modes", async () => {
    const fakeThis = {
      taskId: "task-plan",
      daemon: {
        getTaskById: vi.fn().mockResolvedValue({ agentConfig: { executionMode: "plan" } }),
      },
      getTaskExecutionMode: (ToolRegistry as Any).prototype.getTaskExecutionMode,
      taskListHandler: {
        create: vi.fn(),
        update: vi.fn(),
        list: vi.fn(),
      },
    } as Any;

    await expect(
      (ToolRegistry as Any).prototype.taskListCreate.call(fakeThis, { items: validItems }),
    ).rejects.toThrow(/only available in execute, verified, or debug mode/i);
    await expect((ToolRegistry as Any).prototype.taskListList.call(fakeThis)).rejects.toThrow(
      /only available in execute, verified, or debug mode/i,
    );
  });

  it("delegates create and update to the runtime checklist handler in execute mode", async () => {
    const create = vi.fn().mockReturnValue({
      items: [
        { id: "item-1", title: "Implement feature", kind: "implementation", status: "pending" },
      ],
      updatedAt: 1,
      verificationNudgeNeeded: false,
      nudgeReason: null,
    });
    const update = vi.fn().mockReturnValue({
      items: [
        { id: "item-1", title: "Implement feature", kind: "implementation", status: "completed" },
      ],
      updatedAt: 2,
      verificationNudgeNeeded: true,
      nudgeReason: "Add verification.",
    });
    const fakeThis = {
      taskId: "task-exec",
      daemon: {
        getTaskById: vi.fn().mockResolvedValue({ agentConfig: { executionMode: "execute" } }),
      },
      getTaskExecutionMode: (ToolRegistry as Any).prototype.getTaskExecutionMode,
      withImmediateTaskListReminder: (ToolRegistry as Any).prototype.withImmediateTaskListReminder,
      taskListHandler: {
        create,
        update,
        list: vi.fn(),
      },
    } as Any;

    const created = await (ToolRegistry as Any).prototype.taskListCreate.call(fakeThis, {
      items: validItems,
    });
    const updated = await (ToolRegistry as Any).prototype.taskListUpdate.call(fakeThis, {
      items: [{ id: "item-1", title: "Implement feature", status: "completed" }],
    });

    expect(create).toHaveBeenCalledWith(validItems);
    expect(update).toHaveBeenCalledWith([
      { id: "item-1", title: "Implement feature", status: "completed" },
    ]);
    expect(created.verificationNudgeNeeded).toBe(false);
    expect(updated.verificationNudgeNeeded).toBe(true);
    expect(updated.immediateReminder).toContain("CHECKLIST REMINDER");
  });

  it("returns the current checklist state from task_list_list", async () => {
    const list = vi.fn().mockReturnValue({
      items: [{ id: "item-1", title: "Run tests", kind: "verification", status: "pending" }],
      updatedAt: 3,
      verificationNudgeNeeded: false,
      nudgeReason: null,
    });
    const fakeThis = {
      taskId: "task-debug",
      daemon: {
        getTaskById: vi.fn().mockResolvedValue({ agentConfig: { executionMode: "debug" } }),
      },
      getTaskExecutionMode: (ToolRegistry as Any).prototype.getTaskExecutionMode,
      taskListHandler: {
        create: vi.fn(),
        update: vi.fn(),
        list,
      },
    } as Any;

    const result = await (ToolRegistry as Any).prototype.taskListList.call(fakeThis);

    expect(list).toHaveBeenCalledTimes(1);
    expect(result.items[0]?.title).toBe("Run tests");
    expect(result.verificationNudgeNeeded).toBe(false);
  });
});
