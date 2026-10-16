import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";
import type { Task } from "../../../shared/types";

function createDaemonLike(task: Task) {
  const rows = new Map<string, Task>([[task.id, task]]);
  const daemon = Object.create(AgentDaemon.prototype) as Any;
  daemon.taskRepo = {
    findById: (id: string) => rows.get(id),
    update: (id: string, updates: Partial<Task>) => {
      const current = rows.get(id);
      if (current) rows.set(id, { ...current, ...updates });
    },
  };
  daemon.activeTasks = new Map([[task.id, { lastAccessed: 0 }]]);
  daemon.logEvent = vi.fn();
  return { daemon, rows };
}

describe("AgentDaemon.setTaskModelSelection", () => {
  it("pins the model on the task only and keeps the rest of its config", () => {
    const { daemon, rows } = createDaemonLike({
      id: "task-1",
      title: "Chat with Ember",
      prompt: "hi",
      status: "completed",
      workspaceId: "ws",
      createdAt: 1,
      updatedAt: 1,
      agentConfig: {
        botConversation: true,
        modelKey: "stale-model",
        llmProfile: "strong",
        llmProfileForced: true,
      },
    } as Any);

    const updated = daemon.setTaskModelSelection("task-1", {
      providerType: "anthropic",
      modelKey: "opus-4-5",
    });

    expect(updated.agentConfig).toEqual({
      botConversation: true,
      providerType: "anthropic",
      modelKey: "opus-4-5",
      modelPinned: true,
      llmProfile: "strong",
    });
    expect(rows.get("task-1")?.agentConfig?.modelPinned).toBe(true);
    expect(daemon.activeTasks.get("task-1").lastAccessed).toBeGreaterThan(0);
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "log",
      expect.objectContaining({ providerType: "anthropic", modelKey: "opus-4-5" }),
    );
  });

  it("rejects an unknown task", () => {
    const { daemon } = createDaemonLike({ id: "task-1", agentConfig: {} } as Any);
    expect(() =>
      daemon.setTaskModelSelection("missing", { providerType: "openai", modelKey: "gpt-4o" }),
    ).toThrow("Task missing not found");
  });
});
