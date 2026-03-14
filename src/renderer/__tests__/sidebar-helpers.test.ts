/**
 * Tests for sidebar pinning/visibility helper functions
 */

import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/types";
import {
  compareTasksByPinAndRecency,
  countHiddenFailedSessions,
  isActiveSessionStatus,
  isAutomatedSession,
  isAwaitingSessionStatus,
  shouldShowTaskInSidebarSessions,
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
  it("ignores remote-device shadow tasks", () => {
    const tasks = [
      createTask({ id: "remote-failed", status: "failed", targetNodeId: "node-1" }),
      createTask({ id: "local-failed", status: "failed" }),
    ];

    const count = countHiddenFailedSessions(tasks, "focused");
    expect(count).toBe(1);
  });

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

describe("shouldShowTaskInSidebarSessions", () => {
  it("hides remote-device shadow tasks from the sidebar", () => {
    expect(shouldShowTaskInSidebarSessions(createTask({ targetNodeId: "node-1" }))).toBe(false);
  });

  it("keeps local tasks visible in the sidebar", () => {
    expect(shouldShowTaskInSidebarSessions(createTask({}))).toBe(true);
  });
});

describe("isAutomatedSession", () => {
  it("treats scheduled and self-improvement tasks as automated", () => {
    expect(isAutomatedSession(createTask({ source: "cron" }))).toBe(true);
    expect(isAutomatedSession(createTask({ source: "improvement" }))).toBe(true);
  });

  it("keeps webhook and generic api tasks out of the automated bucket", () => {
    expect(isAutomatedSession(createTask({ source: "hook" }))).toBe(false);
    expect(isAutomatedSession(createTask({ source: "api" }))).toBe(false);
  });

  it("treats company and heartbeat api tasks as automated", () => {
    expect(isAutomatedSession(createTask({ source: "api", companyId: "company-123" }))).toBe(true);
    expect(isAutomatedSession(createTask({ source: "api", issueId: "issue-123" }))).toBe(true);
    expect(isAutomatedSession(createTask({ source: "api", heartbeatRunId: "run-123" }))).toBe(true);
  });

  it("keeps explicit manual tasks out of the automated bucket even when attached to a run", () => {
    expect(
      isAutomatedSession(
        createTask({
          source: "manual",
          heartbeatRunId: "run-123",
          issueId: "issue-123",
        }),
      ),
    ).toBe(false);
  });

  it("still treats legacy heartbeat tasks without an explicit manual source as automated", () => {
    expect(isAutomatedSession(createTask({ heartbeatRunId: "run-123" }))).toBe(true);
  });

  it("treats explicit Heartbeat titled tasks as automated even when linkage fields are missing", () => {
    expect(isAutomatedSession(createTask({ source: "api", title: "Heartbeat: CoWork OS Ops Lead" }))).toBe(true);
    expect(isAutomatedSession(createTask({ title: "Heartbeat: cowork os inc Company Planner" }))).toBe(true);
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
