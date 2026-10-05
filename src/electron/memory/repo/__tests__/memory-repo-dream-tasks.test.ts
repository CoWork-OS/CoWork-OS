import { describe, expect, it, vi } from "vitest";
import type { Task, TaskEvent } from "../../../../shared/types";
import {
  createDreamTaskLister,
  extractDreamConversation,
  isDreamCandidateTask,
} from "../memory-repo-dream-tasks";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    prompt: "decorated prompt",
    rawPrompt: `Please do ${overrides.id}`,
    status: "completed",
    workspaceId: "ws-1",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as Task;
}

let seq = 0;
function event(taskId: string, type: string, payload: Record<string, unknown>): TaskEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    taskId,
    timestamp: seq,
    type: type as TaskEvent["type"],
    payload,
    schemaVersion: 2,
  };
}

describe("isDreamCandidateTask", () => {
  it("accepts a finished top-level owner task", () => {
    expect(isDreamCandidateTask(task({ id: "a" }))).toBe(true);
    expect(isDreamCandidateTask(task({ id: "a", status: "failed" }))).toBe(true);
  });

  it("leaves out unfinished, child, automated, no-memory and gateway tasks", () => {
    expect(isDreamCandidateTask(task({ id: "a", status: "executing" }))).toBe(false);
    expect(isDreamCandidateTask(task({ id: "a", parentTaskId: "p" }))).toBe(false);
    expect(isDreamCandidateTask(task({ id: "a", agentType: "sub" }))).toBe(false);
    expect(isDreamCandidateTask(task({ id: "a", depth: 1 }))).toBe(false);
    expect(isDreamCandidateTask(task({ id: "a", source: "subconscious" }))).toBe(false);
    expect(isDreamCandidateTask(task({ id: "a", source: "hook" }))).toBe(false);
    expect(isDreamCandidateTask(task({ id: "a", rawPrompt: "secret <no-memory>" }))).toBe(false);
    expect(isDreamCandidateTask(task({ id: "a", agentConfig: { gatewayContext: "group" } }))).toBe(
      false,
    );
    expect(
      isDreamCandidateTask(
        task({ id: "a", agentConfig: { originChannel: "telegram", gatewayContext: "private" } }),
      ),
    ).toBe(false);
    expect(
      isDreamCandidateTask(
        task({
          id: "a",
          agentConfig: {
            originChannel: "telegram",
            gatewayContext: "private",
            gatewaySenderIsOwner: true,
          },
        }),
      ),
    ).toBe(true);
    expect(isDreamCandidateTask(task({ id: "a", source: "cron" }))).toBe(true);
  });
});

describe("extractDreamConversation", () => {
  it("reads the original prompt, the user's messages and the last visible reply", () => {
    const t = task({ id: "a", rawPrompt: "Use pnpm, not npm" });
    const result = extractDreamConversation(t, [
      event("a", "user_message", { message: "Use pnpm, not npm" }),
      event("a", "assistant_message", { message: "Working on it" }),
      event("a", "user_message", { message: "  Also   keep tabs  " }),
      event("a", "user_message", { message: "from a peer agent", messageSource: "agent" }),
      event("a", "assistant_message", { message: "Done with pnpm." }),
      event("a", "assistant_message", { message: "internal note", internal: true }),
      event("a", "task_completed", { resultSummary: "Summary" }),
    ]);
    expect(result).toEqual({
      userMessages: ["Use pnpm, not npm", "Also keep tabs"],
      finalReply: "Done with pnpm.",
    });
  });

  it("falls back to the completion summary and drops tasks whose messages opt out", () => {
    const t = task({ id: "a" });
    expect(
      extractDreamConversation(t, [event("a", "task_completed", { resultSummary: "All set" })]),
    ).toEqual({ userMessages: ["Please do a"], finalReply: "All set" });
    expect(
      extractDreamConversation(t, [event("a", "user_message", { message: "x <no-memory/>" })]),
    ).toBeNull();
  });

  it("bounds the number and length of messages", () => {
    const t = task({ id: "a", rawPrompt: "first" });
    const events = Array.from({ length: 20 }, (_, i) =>
      event("a", "user_message", { message: `follow-up ${i} ${"x".repeat(900)}` }),
    );
    const result = extractDreamConversation(t, events);
    expect(result?.userMessages).toHaveLength(8);
    expect(result?.userMessages[0]).toBe("first");
    expect(result?.userMessages[7]).toMatch(/^follow-up 19/);
    expect(result?.userMessages.every((m) => m.length <= 600)).toBe(true);
  });
});

describe("createDreamTaskLister", () => {
  it("lists eligible tasks created after the cursor, oldest first, up to the limit", async () => {
    const tasks = [
      task({ id: "old", createdAt: 100 }),
      task({ id: "t1", createdAt: 200 }),
      task({ id: "child", createdAt: 300, parentTaskId: "t1" }),
      task({ id: "t2", createdAt: 400, workspaceId: "ws-2" }),
      task({ id: "strict", createdAt: 450, workspaceId: "ws-strict" }),
      task({ id: "t3", createdAt: 500 }),
      task({ id: "silent", createdAt: 600 }),
    ];
    const findTasksCreatedBetween = vi.fn(async (params: { startMs: number; endMs: number }) =>
      tasks
        .filter((t) => t.createdAt >= params.startMs && t.createdAt < params.endMs)
        .sort((a, b) => b.createdAt - a.createdAt),
    );
    const findTaskEvents = vi.fn(async (taskId: string) =>
      taskId === "silent"
        ? [event(taskId, "user_message", { message: "<no-memory> keep this out" })]
        : [event(taskId, "assistant_message", { message: `reply ${taskId}` })],
    );
    const workspaceName = vi.fn(async (id: string) => `Name of ${id}`);
    const list = createDreamTaskLister({
      findTasksCreatedBetween,
      findTaskEvents,
      workspaceName,
      getWorkspacePolicy: async (id) =>
        id === "ws-strict" ? { enabled: true, privacyMode: "strict" } : { enabled: true },
      now: () => 1_000,
    });

    const result = await list(100, 2);

    expect(findTasksCreatedBetween).toHaveBeenCalledWith({
      startMs: 101,
      endMs: 1_001,
      limit: 200,
    });
    expect(result.map((t) => t.taskId)).toEqual(["t1", "t2"]);
    expect(result[1]).toEqual({
      taskId: "t2",
      title: "Task t2",
      workspaceName: "Name of ws-2",
      createdAt: 400,
      userMessages: ["Please do t2"],
      finalReply: "reply t2",
    });
    expect(findTaskEvents).not.toHaveBeenCalledWith("strict", expect.anything(), expect.anything());
    expect(await list(100, 0)).toEqual([]);
  });

  it("never reads past a task that is still running", async () => {
    const list = createDreamTaskLister({
      findTasksCreatedBetween: async () => [
        task({ id: "after", createdAt: 30 }),
        task({ id: "running", createdAt: 20, status: "executing" as Any }),
        task({ id: "before", createdAt: 10 }),
      ],
      findTaskEvents: async (taskId) => [event(taskId, "assistant_message", { message: "ok" })],
      now: () => 100,
    });
    expect((await list(0, 5)).map((t) => t.taskId)).toEqual(["before"]);
  });

  it("skips a task whose events cannot be read", async () => {
    const list = createDreamTaskLister({
      findTasksCreatedBetween: async () => [
        task({ id: "bad", createdAt: 5 }),
        task({ id: "ok", createdAt: 4 }),
      ],
      findTaskEvents: async (taskId) => {
        if (taskId === "bad") throw new Error("db closed");
        return [];
      },
      now: () => 10,
    });
    expect((await list(0, 5)).map((t) => t.taskId)).toEqual(["ok"]);
  });
});
