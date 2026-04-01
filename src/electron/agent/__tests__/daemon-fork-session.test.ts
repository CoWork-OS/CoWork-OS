import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

describe("AgentDaemon.forkTaskSession", () => {
  it("creates a forked task with session lineage metadata", async () => {
    const createTask = vi.fn().mockResolvedValue({
      id: "forked-task",
      title: "Original task (investigate)",
    });
    const logEvent = vi.fn();
    const daemonLike = {
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-1",
          title: "Original task",
          prompt: "Fix the bug",
          rawPrompt: "Fix the bug",
          userPrompt: "Fix the bug",
          workspaceId: "workspace-1",
          agentConfig: { executionMode: "execute" },
          source: "manual",
        }),
      },
      createTask,
      logEvent,
    } as Any;

    const result = await AgentDaemon.prototype.forkTaskSession.call(daemonLike, {
      taskId: "task-1",
      branchLabel: "investigate",
      fromEventId: "event-7",
    });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskOverrides: expect.objectContaining({
          branchFromTaskId: "task-1",
          branchFromEventId: "event-7",
          branchLabel: "investigate",
        }),
      }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "forked-task",
      "log",
      expect.objectContaining({
        message: "Session fork created",
        sourceTaskId: "task-1",
      }),
    );
    expect(result.id).toBe("forked-task");
  });
});
