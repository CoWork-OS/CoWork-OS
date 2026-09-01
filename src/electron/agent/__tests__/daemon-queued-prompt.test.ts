import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

describe("AgentDaemon.updateQueuedTaskPrompt", () => {
  it("updates the initial prompt only for a task still in the queue", () => {
    const task = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      status: "queued",
      prompt: "old prompt",
    };
    const updatedTask = { ...task, prompt: "new prompt" };
    const daemonLike = {
      taskRepo: {
        findById: vi.fn().mockReturnValueOnce(task).mockReturnValueOnce(updatedTask),
        update: vi.fn(),
      },
      queueManager: { isQueued: vi.fn().mockReturnValue(true) },
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    expect(
      AgentDaemon.prototype.updateQueuedTaskPrompt.call(daemonLike, task.id, "  new prompt  "),
    ).toEqual(updatedTask);
    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(task.id, {
      prompt: "new prompt",
      rawPrompt: "new prompt",
      userPrompt: "new prompt",
    });
  });

  it("rejects edits after the task leaves the queue", () => {
    const daemonLike = {
      taskRepo: { findById: vi.fn().mockReturnValue({ id: "task-1", status: "executing" }) },
      queueManager: { isQueued: vi.fn().mockReturnValue(false) },
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    expect(() =>
      AgentDaemon.prototype.updateQueuedTaskPrompt.call(daemonLike, "task-1", "new"),
    ).toThrow("Only queued tasks can have their prompt edited.");
  });
});
