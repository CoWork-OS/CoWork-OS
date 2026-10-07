import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import {
  countSidebarSessionStates,
  filterSidebarSessionsByState,
  getSidebarSessionActivity,
  getSidebarSessionRowHeight,
} from "../sidebar-session-state";

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  prompt: id,
  workspaceId: "workspace",
  createdAt: 100,
  updatedAt: 100,
  status: "completed",
  ...overrides,
});

interface Node {
  task: Task;
  children: Node[];
  synthetic?: boolean;
}
const node = (value: Task, children: Node[] = []): Node => ({ task: value, children });

describe("sidebar session activity", () => {
  it("uses explicit lifecycle markers instead of displaying a stale executing status", () => {
    expect(
      getSidebarSessionActivity(
        task("approval", { status: "executing", terminalStatus: "awaiting_approval" }),
      ),
    ).toEqual({ category: "needs-you", label: "Approval needed" });
    expect(
      getSidebarSessionActivity(
        task("input", { status: "executing", terminalStatus: "needs_user_action" }),
      ),
    ).toEqual({ category: "needs-you", label: "Response needed" });
    expect(
      getSidebarSessionActivity(
        task("verify", { status: "completed", terminalStatus: "awaiting_verification" }),
      ),
    ).toEqual({ category: "running", label: "Verifying" });
  });

  it("doesn't call paused or interrupted work running or assume a paused session has a question", () => {
    expect(getSidebarSessionActivity(task("paused", { status: "paused" }))).toEqual({
      category: "needs-you",
      label: "Paused",
    });
    expect(getSidebarSessionActivity(task("interrupted", { status: "interrupted" }))).toEqual({
      category: "needs-you",
      label: "Resume available",
    });
    expect(
      getSidebarSessionActivity(
        task("input", { status: "paused", stopReasons: ["awaiting_user_input"] }),
      )?.label,
    ).toBe("Response needed");
  });

  it("distinguishes queued work from running work and keeps finished rows compact", () => {
    expect(getSidebarSessionActivity(task("queued", { status: "queued" }))).toEqual({
      category: null,
      label: "Queued",
    });
    expect(getSidebarSessionActivity(task("planning", { status: "planning" }))).toEqual({
      category: "running",
      label: "Planning",
    });
    expect(getSidebarSessionActivity(task("running", { status: "executing" }))).toEqual({
      category: "running",
      label: "Running",
    });
    expect(getSidebarSessionActivity(task("done"))).toBeNull();
    expect(getSidebarSessionRowHeight(task("done"))).toBe(32);
    expect(getSidebarSessionRowHeight(task("working", { status: "executing" }))).toBe(46);
  });

  it("doesn't surface stale action metadata on failed or cancelled tasks", () => {
    for (const status of ["failed", "cancelled"] as const) {
      expect(
        getSidebarSessionActivity(task("stopped", { status, terminalStatus: "needs_user_action" })),
      ).toBeNull();
    }
    expect(
      getSidebarSessionActivity(task("done", { status: "executing", completedAt: 150 })),
    ).toBeNull();
  });
});

describe("sidebar status filtering", () => {
  const actionableChild = node(
    task("approval", { status: "blocked", terminalStatus: "awaiting_approval" }),
  );
  const runningChild = node(task("running-child", { status: "executing" }));
  const roots = [
    node(task("finished-parent"), [actionableChild, runningChild, node(task("unrelated-child"))]),
    node(task("cron", { source: "cron", status: "executing" })),
    node(task("paused", { status: "paused" })),
    node(task("done")),
  ];

  it("counts root sessions once even when multiple descendants are actionable", () => {
    expect(countSidebarSessionStates(roots)).toEqual({ all: 4, running: 2, "needs-you": 2 });
    expect(
      countSidebarSessionStates([node(task("parent"), [actionableChild, actionableChild])])[
        "needs-you"
      ],
    ).toBe(1);
  });

  it("preserves ancestor context without returning unrelated descendants", () => {
    const result = filterSidebarSessionsByState(roots, "needs-you");
    expect(result.map((item) => item.task.id)).toEqual(["finished-parent", "paused"]);
    expect(result[0].children.map((item) => item.task.id)).toEqual(["approval"]);
    expect(roots[0].children).toHaveLength(3);
  });

  it("includes automated roots and keeps All as the original tree", () => {
    expect(filterSidebarSessionsByState(roots, "running").map((item) => item.task.id)).toEqual([
      "finished-parent",
      "cron",
    ]);
    expect(filterSidebarSessionsByState(roots, "all")).toBe(roots);
  });

  it("uses the children of synthetic campaign groups rather than their copied status", () => {
    const group: Node = {
      ...node(task("campaign", { status: "executing" }), [actionableChild]),
      synthetic: true,
    };
    expect(countSidebarSessionStates([group])).toEqual({ all: 1, running: 0, "needs-you": 1 });
    expect(filterSidebarSessionsByState([group], "running")).toEqual([]);
    expect(filterSidebarSessionsByState([group], "needs-you")[0].children).toEqual([
      actionableChild,
    ]);
  });

  it("returns an empty result for a filter with no matches", () => {
    expect(filterSidebarSessionsByState([node(task("finished"))], "running")).toEqual([]);
  });
});
