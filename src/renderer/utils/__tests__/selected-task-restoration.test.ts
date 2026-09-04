import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import {
  canRestoreSelectedTask,
  persistSelectedTaskId,
  readPersistedSelectedTaskId,
  selectedTaskStorageKey,
} from "../selected-task-restoration";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("selected task restoration", () => {
  it("stores a selection per workspace and can clear stale ids", () => {
    const store = storage();
    persistSelectedTaskId("workspace-a", "task-1", store);
    persistSelectedTaskId("workspace-b", "task-2", store);
    expect(readPersistedSelectedTaskId("workspace-a", store)).toBe("task-1");
    expect(readPersistedSelectedTaskId("workspace-b", store)).toBe("task-2");
    persistSelectedTaskId("workspace-a", null, store);
    expect(readPersistedSelectedTaskId("workspace-a", store)).toBeNull();
    expect(selectedTaskStorageKey("workspace-b")).toContain("workspace-b");
  });

  it("rejects a task from another workspace", () => {
    const task = { id: "task-1", workspaceId: "workspace-a" } as Task;
    expect(canRestoreSelectedTask(task, "workspace-a")).toBe(true);
    expect(canRestoreSelectedTask(task, "workspace-b")).toBe(false);
    expect(canRestoreSelectedTask(undefined, "workspace-a")).toBe(false);
  });
});
