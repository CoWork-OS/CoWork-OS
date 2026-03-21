import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";

describe("AgentDaemon.createChildTask", () => {
  it("persists the original child prompt as rawPrompt", async () => {
    const taskRepo = {
      findById: vi.fn().mockReturnValue(undefined),
      create: vi.fn((task: Any) => ({
        id: "child-task-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...task,
      })),
    };
    const daemonLike = {
      taskRepo,
      startTask: vi.fn(),
    } as Any;

    const child = await AgentDaemon.prototype.createChildTask.call(daemonLike, {
      title: "Architect",
      prompt: "Build the public portal and constitution.",
      workspaceId: "ws-1",
      parentTaskId: "parent-1",
      agentType: "sub",
    });

    expect(taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Build the public portal and constitution.",
        rawPrompt: "Build the public portal and constitution.",
      }),
    );
    expect(child.rawPrompt).toBe("Build the public portal and constitution.");
  });
});

