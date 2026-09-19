import { describe, expect, it } from "vitest";

import {
  TaskSelectionGeneration,
  isTaskSelectionCurrent,
  type TaskSelectionIdentity,
} from "../task-selection-generation";

const identity = (taskId: string): TaskSelectionIdentity => ({
  scope: "local",
  workspaceId: "workspace-1",
  taskId,
  surface: "main",
});

describe("TaskSelectionGeneration", () => {
  it("rejects delayed A and B responses after switching A -> B -> C", () => {
    const fence = new TaskSelectionGeneration();
    const a = fence.switchTo(identity("task-a"));
    const b = fence.switchTo(identity("task-b"));
    const c = fence.switchTo(identity("task-c"));

    expect(fence.isCurrent(a)).toBe(false);
    expect(fence.isCurrent(b)).toBe(false);
    expect(fence.isCurrent(c)).toBe(true);
  });

  it("rejects an old A response after returning to A", () => {
    const fence = new TaskSelectionGeneration();
    const firstA = fence.switchTo(identity("task-a"));
    fence.switchTo(identity("task-b"));
    const secondA = fence.switchTo(identity("task-a"));

    expect(fence.isCurrent(firstA)).toBe(false);
    expect(fence.isCurrent(secondA)).toBe(true);
  });

  it("isolates remote device and surface identities", () => {
    const fence = new TaskSelectionGeneration();
    const remote = fence.switchTo({
      scope: "remote",
      workspaceId: "workspace-1",
      taskId: "task-a",
      deviceId: "device-1",
      surface: "main",
    });
    expect(
      isTaskSelectionCurrent(remote, {
        generation: remote.generation,
        identity: { ...remote.identity, deviceId: "device-2" },
      }),
    ).toBe(false);
    expect(
      isTaskSelectionCurrent(remote, {
        generation: remote.generation,
        identity: { ...remote.identity, surface: "side-chat" },
      }),
    ).toBe(false);
  });
});
