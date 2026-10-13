import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  InputRequest,
  ProactiveSuggestion,
  Task,
} from "../../../shared/types";
import {
  AttentionService,
  createDebouncedSignal,
  type AttentionSources,
} from "../AttentionService";

const NOW = 1_800_000_000_000;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Session ${id}`,
    prompt: "",
    status: "completed",
    workspaceId: "ws",
    createdAt: NOW - 1000,
    updatedAt: NOW - 500,
    ...overrides,
  } as Task;
}

function approval(id: string, taskId: string, requestedAt = NOW - 100): ApprovalRequest {
  return {
    id,
    taskId,
    type: "run_command",
    description: `Approve ${id}`,
    details: {},
    status: "pending",
    requestedAt,
  };
}

function sources(overrides: Partial<AttentionSources> = {}): AttentionSources {
  return {
    listPendingApprovals: async () => [],
    listPendingInputRequests: async () => [],
    listRecentTasks: async () => [],
    findTask: async () => undefined,
    listAgentNames: async () => new Map(),
    listWaitingFlowSteps: async () => [],
    listDueCommitments: async () => [],
    listSuggestions: async () => [],
    localLabel: "This Mac",
    now: () => NOW,
    ...overrides,
  };
}

describe("AttentionService", () => {
  it("merges every source into one ranked snapshot", async () => {
    const waiting = task("t1", { status: "blocked", terminalStatus: "awaiting_approval" });
    const service = new AttentionService(
      sources({
        listPendingApprovals: async () => [approval("a1", "t1")],
        listRecentTasks: async () => [
          waiting,
          task("t2", { status: "interrupted", terminalStatus: "resume_available" }),
        ],
        listDueCommitments: async () => [{ id: "c1", text: "Send SOW", dueAt: NOW + 1000 }],
        listSuggestions: async () => [
          {
            workspaceId: "ws",
            suggestion: {
              id: "s1",
              type: "insight",
              title: "Idea",
              description: "",
              actionPrompt: "Do it",
              confidence: 0.5,
              createdAt: NOW,
              expiresAt: NOW + 1,
            } as ProactiveSuggestion,
          },
        ],
      }),
    );
    const snapshot = await service.snapshot();
    expect(snapshot.generatedAt).toBe(NOW);
    expect(snapshot.failedSources).toEqual([]);
    // The approval stands for t1, so t1 has no separate session item.
    expect(snapshot.items.map((item) => item.id)).toEqual([
      "approval:a1",
      "session:t2",
      "commitment:c1",
      "suggestion:s1",
    ]);
  });

  it("reports a failing source and still returns the others", async () => {
    const log = vi.fn();
    const service = new AttentionService(
      sources({
        listPendingApprovals: async () => {
          throw new Error("db locked");
        },
        listDueCommitments: async () => [{ id: "c1", text: "Send SOW", dueAt: NOW + 1000 }],
        log,
      }),
    );
    const snapshot = await service.snapshot();
    expect(snapshot.failedSources).toEqual(["approvals"]);
    expect(snapshot.items.map((item) => item.id)).toEqual(["commitment:c1"]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("hides pending rows whose session finished or is gone, and looks up older sessions", async () => {
    const findTask = vi.fn(async (id: string) =>
      id === "old" ? task("old", { status: "executing" }) : undefined,
    );
    const question: InputRequest = {
      id: "q1",
      taskId: "old",
      status: "pending",
      requestedAt: NOW,
      questions: [{ id: "a", header: "Scope", question: "Which one?", options: [] }],
    };
    const service = new AttentionService(
      sources({
        listPendingApprovals: async () => [approval("done", "finished"), approval("lost", "gone")],
        listPendingInputRequests: async () => [question],
        listRecentTasks: async () => [task("finished", { terminalStatus: "ok" })],
        findTask,
      }),
    );
    const snapshot = await service.snapshot();
    expect(snapshot.items.map((item) => item.id)).toEqual(["question:q1"]);
    expect(findTask).toHaveBeenCalledWith("gone");
    expect(findTask).toHaveBeenCalledWith("old");
    expect(findTask).not.toHaveBeenCalledWith("finished");
  });

  it("leaves waiting sub-agents to their parent session", async () => {
    const service = new AttentionService(
      sources({
        listRecentTasks: async () => [
          task("child", {
            parentTaskId: "p",
            status: "paused",
            terminalStatus: "needs_user_action",
          }),
        ],
      }),
    );
    expect((await service.snapshot()).items).toEqual([]);
  });

  it("names agents when it can and carries on when it cannot", async () => {
    const waiting = task("t1", {
      status: "paused",
      terminalStatus: "needs_user_action",
      assignedAgentRoleId: "r",
    });
    const named = new AttentionService(
      sources({
        listRecentTasks: async () => [waiting],
        listAgentNames: async () => new Map([["r", "Ops bot"]]),
      }),
    );
    expect((await named.snapshot()).items[0].actor).toEqual({ kind: "agent", name: "Ops bot" });
    const unnamed = new AttentionService(
      sources({
        listRecentTasks: async () => [waiting],
        listAgentNames: async () => {
          throw new Error("no roles");
        },
      }),
    );
    const snapshot = await unnamed.snapshot();
    expect(snapshot.failedSources).toEqual([]);
    expect(snapshot.items[0].actor).toEqual({ kind: "you", name: "You" });
  });

  it("lists the roles an item's work belongs to, nearest first", async () => {
    const bot = task("bot", { status: "executing", assignedAgentRoleId: "bot-role" });
    // The sub-agent's own parent is not among the recent sessions, so it is looked up.
    const helper = task("helper", {
      status: "executing",
      parentTaskId: "bot",
      assignedAgentRoleId: "helper-role",
    });
    const worker = task("worker", { status: "executing", parentTaskId: "helper" });
    const elsewhere = task("elsewhere", {
      status: "executing",
      workspaceId: "other",
      assignedAgentRoleId: "other-role",
    });
    const stray = task("stray", { status: "executing", parentTaskId: "elsewhere" });
    const mine = task("mine", { status: "paused", terminalStatus: "needs_user_action" });
    const findTask = vi.fn(async (id: string) =>
      [bot, helper, elsewhere].find((candidate) => candidate.id === id),
    );
    const service = new AttentionService(
      sources({
        listPendingApprovals: async () => [
          approval("a-worker", "worker"),
          approval("a-bot", "bot"),
          approval("a-stray", "stray"),
        ],
        listRecentTasks: async () => [worker, stray, mine],
        findTask,
      }),
    );
    const owners = Object.fromEntries(
      (await service.snapshot()).items.map((item) => [item.id, item.ownerAgentRoleIds]),
    );
    expect(owners).toEqual({
      "approval:a-worker": ["helper-role", "bot-role"],
      "approval:a-bot": ["bot-role"],
      // Delegation never crosses into another workspace.
      "approval:a-stray": undefined,
      "session:mine": undefined,
    });
  });

  it("stops at a cycle of parent links", async () => {
    const a = task("a", { status: "executing", parentTaskId: "b", assignedAgentRoleId: "ra" });
    const b = task("b", { status: "executing", parentTaskId: "a", assignedAgentRoleId: "rb" });
    const service = new AttentionService(
      sources({
        listPendingApprovals: async () => [approval("x", "a")],
        listRecentTasks: async () => [a, b],
      }),
    );
    expect((await service.snapshot()).items[0].ownerAgentRoleIds).toEqual(["ra", "rb"]);
  });
});

describe("createDebouncedSignal", () => {
  it("collapses a burst into one call", () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      const signal = createDebouncedSignal(emit, 100);
      signal.trigger();
      signal.trigger();
      vi.advanceTimersByTime(99);
      expect(emit).not.toHaveBeenCalled();
      signal.trigger();
      vi.advanceTimersByTime(100);
      expect(emit).toHaveBeenCalledOnce();
      signal.trigger();
      signal.dispose();
      vi.advanceTimersByTime(200);
      expect(emit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
