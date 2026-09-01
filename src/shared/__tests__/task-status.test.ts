import { describe, expect, it } from "vitest";
import {
  deriveCanonicalTaskStatus,
  normalizeTaskLifecycleState,
  resolveTaskStatusUpdateFromEvent,
} from "../task-status";
import type { Task } from "../types";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    title: "Task",
    prompt: "Prompt",
    status: "pending",
    workspaceId: "ws-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("task status normalization", () => {
  it("normalizes active task with completedAt and partial success to completed", () => {
    expect(
      deriveCanonicalTaskStatus(
        makeTask({
          status: "executing",
          completedAt: 123,
          terminalStatus: "partial_success",
        }),
      ),
    ).toBe("completed");
  });

  it("normalizes active task awaiting approval to blocked", () => {
    expect(
      deriveCanonicalTaskStatus(
        makeTask({
          status: "executing",
          terminalStatus: "awaiting_approval",
        }),
      ),
    ).toBe("blocked");
  });

  it("keeps a stale completed row blocked while verification is pending", () => {
    expect(
      deriveCanonicalTaskStatus(
        makeTask({
          status: "completed",
          completedAt: 123,
          terminalStatus: "awaiting_verification",
        }),
      ),
    ).toBe("blocked");
  });

  it("normalizes active task needing user action without completion to paused", () => {
    expect(
      deriveCanonicalTaskStatus(
        makeTask({
          status: "executing",
          terminalStatus: "needs_user_action",
        }),
      ),
    ).toBe("paused");
  });

  it("keeps terminal statuses unchanged", () => {
    const task = makeTask({
      status: "completed",
      completedAt: 123,
      terminalStatus: "partial_success",
    });

    expect(normalizeTaskLifecycleState(task)).toBe(task);
  });

  it("does not regress a completed task back to executing on trailing step events", () => {
    expect(
      resolveTaskStatusUpdateFromEvent(
        makeTask({
          status: "completed",
          completedAt: 123,
          terminalStatus: "ok",
        }),
        "executing",
      ),
    ).toBe("completed");
  });

  it("allows terminal follow-up updates to replace an existing terminal status", () => {
    expect(
      resolveTaskStatusUpdateFromEvent(
        makeTask({
          status: "completed",
          completedAt: 123,
          terminalStatus: "ok",
        }),
        "failed",
      ),
    ).toBe("failed");
  });
});
