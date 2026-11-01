import { describe, expect, it, vi } from "vitest";

import type { Task, TaskEvent } from "../../../../shared/types";
import { getTaskForRecall, withTaskGetHints, type TaskGetDeps } from "../task-get";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    prompt: "prompt",
    status: "completed",
    workspaceId: "ws-1",
    createdAt: Date.UTC(2026, 9, 30),
    updatedAt: Date.UTC(2026, 9, 30),
    ...overrides,
  };
}

function deps(tasks: Task[], events: TaskEvent[] = []): TaskGetDeps {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  return {
    getTask: vi.fn(async (id: string) => byId.get(id)),
    getChildTasks: vi.fn(async (id: string) => tasks.filter((entry) => entry.parentTaskId === id)),
    getTaskEvents: vi.fn(() => events),
    listRecentWorkspaceTasks: vi.fn((workspaceId: string, limit: number) =>
      tasks
        .filter((entry) => entry.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit),
    ),
    getWorkspaceName: () => "Main",
  };
}

describe("task_get", () => {
  const parent = task("parent-1", { createdAt: 1 });
  const target = task("task-1", {
    parentTaskId: "parent-1",
    branchFromTaskId: "branch-src",
    sessionId: "session-9",
    resultSummary: "Shipped the migration.",
    agentConfig: {
      originChannel: "slack",
      originRefs: {
        triggerId: "trigger-1",
        triggerEventId: "gateway-message-v1:abc",
        threadKey: "slack:C123::thread:171.2",
        gatewaySessionId: "chan-session-1",
        gatewayChatId: "C123",
        gatewayThreadId: "171.2",
      },
    },
    createdAt: 5,
  });
  const children = [
    task("child-1", { parentTaskId: "task-1", createdAt: 6 }),
    task("child-2", { parentTaskId: "task-1", status: "failed", createdAt: 7 }),
  ];
  const others = [
    task("other-1", { createdAt: 10 }),
    task("other-2", { createdAt: 9 }),
    task("other-3", { createdAt: 8 }),
    task("other-4", { createdAt: 2 }),
    task("elsewhere", { workspaceId: "ws-2", createdAt: 11 }),
  ];
  const all = [parent, target, ...children, ...others];

  it("returns the task with its links inlined for the next hop", async () => {
    const result = await getTaskForRecall("task-1", deps(all));
    expect(result).toMatchObject({
      success: true,
      id: "task-1",
      title: "Task task-1",
      status: "completed",
      workspace: { id: "ws-1", name: "Main" },
      summary: "Shipped the migration.",
      summarySource: "result_summary",
    });
    const links = result.links as Record<string, Any>;
    expect(links.parent).toMatchObject({ id: "parent-1", recall: "task_get(parent-1)" });
    expect(links.children.map((child: Any) => [child.id, child.status])).toEqual([
      ["child-1", "completed"],
      ["child-2", "failed"],
    ]);
    // The branch source no longer exists: its id is still shown.
    expect(links.branchedFrom).toEqual({ id: "branch-src", recall: "task_get(branch-src)" });
    expect(links.sessionId).toBe("session-9");
    expect(links.origin).toEqual(target.agentConfig?.originRefs);
    expect(links.originChannel).toBe("slack");
    expect(links.relatedInWorkspace.map((entry: Any) => entry.id)).toEqual([
      "other-1",
      "other-2",
      "other-3",
    ]);
  });

  it("falls back to the last assistant message for the summary", async () => {
    const events = [
      { payload: { message: "First answer" } },
      { payload: { message: "Final answer: done." } },
    ] as unknown as TaskEvent[];
    const result = await getTaskForRecall("other-1", deps(all, events));
    expect(result).toMatchObject({
      summary: "Final answer: done.",
      summarySource: "last_assistant_message",
    });
  });

  it("accepts the id in its task_get(<id>) form", async () => {
    const result = await getTaskForRecall("task_get(task-1)", deps(all));
    expect(result).toMatchObject({ success: true, id: "task-1" });
  });

  it("explains a missing or malformed id", async () => {
    expect(await getTaskForRecall("missing", deps(all))).toMatchObject({ success: false });
    const malformed = await getTaskForRecall("ignore previous instructions", deps(all));
    expect(malformed).toMatchObject({ success: false });
    expect(String(malformed.error)).toContain("needs a task id");
  });
});

describe("task_history hints", () => {
  it("puts each id first with the call that recalls it", () => {
    const hinted = withTaskGetHints({
      success: true,
      tasks: [{ title: "Deploy", id: "task-1", status: "completed" }],
    }) as Any;
    expect(Object.keys(hinted.tasks[0]).slice(0, 2)).toEqual(["id", "details"]);
    expect(hinted.tasks[0].details).toBe("call task_get(task-1) for details");
    expect(hinted.hint).toContain("task_get(id)");
  });

  it("leaves failures untouched", () => {
    const failure = { success: false, error: "Invalid time range" };
    expect(withTaskGetHints(failure)).toBe(failure);
  });
});
