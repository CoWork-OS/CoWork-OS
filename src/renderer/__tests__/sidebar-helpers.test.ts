/**
 * Tests for sidebar pinning/visibility helper functions
 */

import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/types";
import {
  compareTasksByPinAndRecency,
  countHiddenFailedSessions,
  isActiveSessionStatus,
  isAwaitingSessionStatus,
  shouldShowRootTaskInSidebar,
} from "../components/Sidebar";

const createTask = (overrides: Partial<Task>): Task => {
  return {
    id: `task-${Math.random().toString(36).slice(2, 9)}`,
    title: "Test Task",
    prompt: "Do this task",
    status: "pending",
    workspaceId: "workspace-1",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
};

describe("compareTasksByPinAndRecency", () => {
  it("sorts pinned tasks before unpinned tasks", () => {
    const tasks = [
      createTask({ id: "unpinned-old", createdAt: 1, pinned: false }),
      createTask({ id: "pinned-old", createdAt: 2, pinned: true }),
      createTask({ id: "unpinned-new", createdAt: 3, pinned: false }),
      createTask({ id: "pinned-new", createdAt: 4, pinned: true }),
    ];

    const sorted = tasks.sort(compareTasksByPinAndRecency).map((task) => task.id);
    expect(sorted).toEqual(["pinned-new", "pinned-old", "unpinned-new", "unpinned-old"]);
  });
});

describe("shouldShowRootTaskInSidebar", () => {
  it("hides failed/cancelled roots in focused mode by default", () => {
    const task = createTask({ status: "failed" });
    const visible = shouldShowRootTaskInSidebar(task, "focused", false);
    expect(visible).toBe(false);
  });

  it("shows failed/cancelled focused roots when show failed is enabled", () => {
    const task = createTask({ status: "failed" });
    const visible = shouldShowRootTaskInSidebar(task, "focused", true);
    expect(visible).toBe(true);
  });

  it("keeps pinned failed/cancelled roots visible in focused mode", () => {
    const task = createTask({ status: "failed", pinned: true });
    const visible = shouldShowRootTaskInSidebar(task, "focused", false);
    expect(visible).toBe(true);
  });

  it("shows failed root when a descendant is pinned in focused mode", () => {
    const visible = shouldShowRootTaskInSidebar(
      createTask({ id: "failed-root", status: "failed" }),
      "focused",
      false,
      true,
    );
    expect(visible).toBe(true);
  });

  it("shows non-failed roots in focused mode", () => {
    const task = createTask({ status: "completed" });
    const visible = shouldShowRootTaskInSidebar(task, "focused", false);
    expect(visible).toBe(true);
  });

  it("always shows all roots in full mode", () => {
    const task = createTask({ status: "failed" });
    const visible = shouldShowRootTaskInSidebar(task, "full", false);
    expect(visible).toBe(true);
  });
});

describe("countHiddenFailedSessions", () => {
  it("counts only hidden root failed/cancelled unpinned sessions", () => {
    const tasks = [
      createTask({ id: "pinned-failed-root", status: "failed", pinned: true }),
      createTask({ id: "failed-root", status: "failed", pinned: false }),
      createTask({ id: "cancelled-root", status: "cancelled", pinned: false }),
      createTask({
        id: "failed-child",
        status: "failed",
        parentTaskId: "failed-root",
        pinned: false,
      }),
      createTask({ id: "executing-root", status: "executing" }),
    ];

    const count = countHiddenFailedSessions(tasks, "focused");
    expect(count).toBe(2);
  });

  it("does not count hidden failed roots that have pinned descendants", () => {
    const tasks = [
      createTask({
        id: "failed-root-with-pinned-child",
        status: "failed",
        pinned: false,
        parentTaskId: undefined,
      }),
      createTask({
        id: "failed-child-pinned",
        status: "failed",
        pinned: true,
        parentTaskId: "failed-root-with-pinned-child",
      }),
    ];

    const count = countHiddenFailedSessions(tasks, "focused");
    expect(count).toBe(0);
  });

  it("returns zero in full mode", () => {
    const tasks = [createTask({ id: "failed-root", status: "failed" })];
    const count = countHiddenFailedSessions(tasks, "full");
    expect(count).toBe(0);
  });
});

describe("isActiveSessionStatus", () => {
  it("returns true for executing, planning, and interrupted", () => {
    expect(isActiveSessionStatus("executing")).toBe(true);
    expect(isActiveSessionStatus("planning")).toBe(true);
    expect(isActiveSessionStatus("interrupted")).toBe(true);
  });

  it("returns false for non-active statuses", () => {
    expect(isActiveSessionStatus("pending")).toBe(false);
    expect(isActiveSessionStatus("queued")).toBe(false);
    expect(isActiveSessionStatus("paused")).toBe(false);
    expect(isActiveSessionStatus("blocked")).toBe(false);
    expect(isActiveSessionStatus("completed")).toBe(false);
    expect(isActiveSessionStatus("failed")).toBe(false);
    expect(isActiveSessionStatus("cancelled")).toBe(false);
  });
});

describe("isAwaitingSessionStatus", () => {
  it("returns true for paused and blocked", () => {
    expect(isAwaitingSessionStatus("paused")).toBe(true);
    expect(isAwaitingSessionStatus("blocked")).toBe(true);
  });

  it("returns false for non-awaiting statuses", () => {
    expect(isAwaitingSessionStatus("pending")).toBe(false);
    expect(isAwaitingSessionStatus("queued")).toBe(false);
    expect(isAwaitingSessionStatus("planning")).toBe(false);
    expect(isAwaitingSessionStatus("executing")).toBe(false);
    expect(isAwaitingSessionStatus("interrupted")).toBe(false);
    expect(isAwaitingSessionStatus("completed")).toBe(false);
    expect(isAwaitingSessionStatus("failed")).toBe(false);
    expect(isAwaitingSessionStatus("cancelled")).toBe(false);
  });
});
