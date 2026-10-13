import { describe, expect, it } from "vitest";

import {
  formatTaskEstimate,
  getTaskDueInfo,
  getTaskPriorityMeta,
  isTaskStaleForUi,
  resolveMissionColumnForTask,
  resolveTaskAttentionReason,
} from "../useMissionControlData";

describe("Mission Control board helpers", () => {
  it("routes terminal tasks into the done/history lane", () => {
    expect(
      resolveMissionColumnForTask({
        status: "failed",
        boardColumn: "in_progress",
        assignedAgentRoleId: "agent-1",
      }),
    ).toBe("done");

    expect(
      resolveMissionColumnForTask({
        status: "cancelled",
        boardColumn: "todo",
        assignedAgentRoleId: "agent-1",
      }),
    ).toBe("done");
  });

  it("keeps backlog tasks split between inbox and assigned", () => {
    expect(
      resolveMissionColumnForTask({
        status: "queued",
        boardColumn: "backlog",
        assignedAgentRoleId: undefined,
      }),
    ).toBe("inbox");

    expect(
      resolveMissionColumnForTask({
        status: "queued",
        boardColumn: "backlog",
        assignedAgentRoleId: "agent-1",
      }),
    ).toBe("assigned");
  });

  it("shows actively executing backlog tasks in the working lane", () => {
    expect(
      resolveMissionColumnForTask({
        status: "executing",
        boardColumn: "backlog",
        assignedAgentRoleId: undefined,
      }),
    ).toBe("in_progress");

    expect(
      resolveMissionColumnForTask({
        status: "planning",
        boardColumn: "todo",
        assignedAgentRoleId: "agent-1",
      }),
    ).toBe("in_progress");
  });

  it("formats due dates as overdue or due soon", () => {
    const now = Date.UTC(2026, 2, 30, 12, 0, 0);

    expect(getTaskDueInfo(now - 30 * 60 * 1000, now)).toMatchObject({
      tone: "overdue",
      isOverdue: true,
      label: "30m overdue",
    });

    expect(getTaskDueInfo(now + 2 * 60 * 60 * 1000, now)).toMatchObject({
      tone: "soon",
      isDueSoon: true,
      label: "Due in 2h",
    });
  });

  it("formats estimates and priority metadata for decision-ready cards", () => {
    expect(formatTaskEstimate(45)).toBe("45m");
    expect(formatTaskEstimate(180)).toBe("3h");
    expect(getTaskPriorityMeta(4)).toMatchObject({ label: "Urgent", shortLabel: "P4" });
  });

  it("marks long-running active work as stale but ignores closed work", () => {
    const now = Date.UTC(2026, 2, 30, 12, 0, 0);

    expect(
      isTaskStaleForUi(
        {
          status: "executing",
          createdAt: now - 8 * 60 * 60 * 1000,
          updatedAt: now - 7 * 60 * 60 * 1000,
        },
        now,
      ),
    ).toBe(true);

    expect(
      isTaskStaleForUi(
        {
          status: "completed",
          createdAt: now - 8 * 60 * 60 * 1000,
          updatedAt: now - 7 * 60 * 60 * 1000,
        },
        now,
      ),
    ).toBe(false);
  });

  describe("attention reasons", () => {
    const now = Date.UTC(2026, 2, 30, 12, 0, 0);
    const base = {
      status: "executing" as const,
      assignedAgentRoleId: "agent-1",
      createdAt: now - 60 * 60 * 1000,
      updatedAt: now - 60 * 60 * 1000,
    };

    it("never flags completed or cancelled work for an owner, due date, review or age", () => {
      for (const status of ["completed", "cancelled"] as const) {
        expect(
          resolveTaskAttentionReason(
            {
              status,
              assignedAgentRoleId: undefined,
              boardColumn: "review",
              dueDate: now - 2 * 24 * 60 * 60 * 1000,
              createdAt: now - 30 * 24 * 60 * 60 * 1000,
              updatedAt: now - 30 * 24 * 60 * 60 * 1000,
            },
            null,
            now,
          ),
        ).toBeNull();
      }
    });

    it("ignores the outcome left on a run finalized as completed", () => {
      expect(
        resolveTaskAttentionReason(
          { ...base, status: "completed", terminalStatus: "needs_user_action" },
          null,
          now,
        ),
      ).toBeNull();
      expect(
        resolveTaskAttentionReason(
          { ...base, status: "cancelled", failureClass: "user_blocker" },
          null,
          now,
        ),
      ).toBeNull();
    });

    it("still says failed and interrupted runs need attention", () => {
      expect(
        resolveTaskAttentionReason(
          { ...base, status: "failed", assignedAgentRoleId: undefined },
          null,
          now,
        ),
      ).toBe("Run failed");
      expect(resolveTaskAttentionReason({ ...base, status: "interrupted" }, null, now)).toBe(
        "Interrupted",
      );
    });

    it("lets a pending approval or question from the queue win", () => {
      expect(
        resolveTaskAttentionReason({ ...base, status: "completed" }, "Approval needed", now),
      ).toBe("Approval needed");
      expect(
        resolveTaskAttentionReason({ ...base, status: "failed" }, "Response needed", now),
      ).toBe("Response needed");
    });

    it("flags open work without an owner, past due, in review or stale", () => {
      expect(
        resolveTaskAttentionReason(
          { ...base, status: "queued", assignedAgentRoleId: undefined },
          null,
          now,
        ),
      ).toBe("Needs owner");
      expect(
        resolveTaskAttentionReason({ ...base, dueDate: now - 30 * 60 * 1000 }, null, now),
      ).toBe("Overdue");
      expect(
        resolveTaskAttentionReason(
          { ...base, status: "pending", boardColumn: "review" },
          null,
          now,
        ),
      ).toBe("Needs review");
      expect(
        resolveTaskAttentionReason(
          { ...base, updatedAt: now - 7 * 60 * 60 * 1000, createdAt: now - 8 * 60 * 60 * 1000 },
          null,
          now,
        ),
      ).toBe("Stale");
      expect(resolveTaskAttentionReason(base, null, now)).toBeNull();
    });
  });
});
