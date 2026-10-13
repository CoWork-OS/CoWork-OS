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

  it("reads a waiting session in full to say why it stopped", async () => {
    const summary = task("t1", { status: "paused", terminalStatus: "needs_user_action" });
    const findTask = vi.fn(async (id: string) =>
      id === "t1" ? { ...summary, error: "Approval request timed out" } : undefined,
    );
    const service = new AttentionService(
      sources({ listRecentTasks: async () => [summary], findTask }),
    );
    const [item] = (await service.snapshot()).items;
    expect(item).toMatchObject({
      id: "session:t1",
      state: "Response needed",
      detail: "Its approval request timed out, so it stopped before that step.",
    });
    // A session with a recorded pause reason needs no extra read.
    findTask.mockClear();
    const coded = new AttentionService(
      sources({
        listRecentTasks: async () => [
          task("t2", {
            status: "paused",
            terminalStatus: "needs_user_action",
            awaitingUserInputReasonCode: "skill_parameters",
          }),
        ],
        findTask,
      }),
    );
    expect((await coded.snapshot()).items[0].detail).toBe(
      "It needs a few details from you before it can go on.",
    );
    expect(findTask).not.toHaveBeenCalled();
  });

  it("names the remote device a waiting session runs on, and carries on without names", async () => {
    const remote = task("t1", {
      status: "paused",
      terminalStatus: "needs_user_action",
      targetNodeId: "remote-gateway:mini",
      error: "Approval request timed out",
    });
    const named = new AttentionService(
      sources({
        listRecentTasks: async () => [remote],
        listDevices: async () => [{ id: "mini", name: "Mac mini" }],
      }),
    );
    expect((await named.snapshot()).items[0].place).toEqual({
      kind: "remote",
      label: "Mac mini",
      deviceId: "mini",
    });
    const unnamed = new AttentionService(
      sources({
        listRecentTasks: async () => [remote],
        listDevices: async () => {
          throw new Error("no settings");
        },
      }),
    );
    const snapshot = await unnamed.snapshot();
    expect(snapshot.failedSources).toEqual([]);
    expect(snapshot.items[0].place.label).toBe("Another device");
  });

  it("lists undoable memory changes as handled work, and reports a failing read", async () => {
    const change = (id: string, overrides = {}) => ({
      id,
      op: "expire_commitment" as const,
      origin: "auto" as const,
      summary: "Closed: the report was sent on Monday.",
      rationale: null,
      items: [
        {
          id: `m-${id}`,
          kind: "commitment" as const,
          content: "Send the report",
          before: "active",
          after: "archived",
        },
      ],
      appliedAt: NOW - 1000,
      undoneAt: null,
      canUndo: true,
      ...overrides,
    });
    const service = new AttentionService(
      sources({
        listMemoryChanges: async () => [
          { workspaceId: "ws", change: change("c1") },
          { workspaceId: "ws", change: change("c2", { canUndo: false }) },
          { workspaceId: "ws", change: change("c3", { undoneAt: NOW }) },
        ],
      }),
    );
    expect((await service.snapshot()).items).toEqual([
      expect.objectContaining({
        id: "memory_change:c1",
        kind: "memory_change",
        title: "Send the report",
        urgent: false,
        ref: { type: "memory_change", changeId: "c1", workspaceId: "ws" },
      }),
    ]);
    const failing = new AttentionService(
      sources({
        listMemoryChanges: async () => {
          throw new Error("engine not running");
        },
      }),
    );
    expect((await failing.snapshot()).failedSources).toEqual(["memory"]);
  });

  it("adds calendar proposals, and offers a hold on the first suggestion about making time", async () => {
    const suggestionOf = (id: string, title: string) => ({
      workspaceId: "ws",
      suggestion: {
        id,
        type: "insight",
        title,
        description: "",
        actionPrompt: "Do it",
        confidence: 0.5,
        createdAt: NOW,
        expiresAt: NOW + 1,
      } as ProactiveSuggestion,
    });
    const findCalendarHold = vi.fn(async () => ({ start: NOW + 10, end: NOW + 20 }));
    const service = new AttentionService(
      sources({
        listSuggestions: async () => [
          suggestionOf("s1", "Reply to Ana"),
          suggestionOf("s2", "Block focus time for the deck"),
          suggestionOf("s3", "Set aside time for planning"),
        ],
        listCalendarProposals: async () => [
          {
            kind: "conflict",
            id: "conflict:a:b",
            first: { eventId: "a", title: "A", start: NOW + 5, end: NOW + 50 },
            second: { eventId: "b", title: "B", start: NOW + 10, end: NOW + 60 },
            canDeclineSecond: false,
          },
        ],
        findCalendarHold,
      }),
    );
    const { items, failedSources } = await service.snapshot();
    expect(failedSources).toEqual([]);
    expect(items[0]).toMatchObject({ id: "calendar:conflict:a:b", urgent: true });
    const held = items.filter((item) => item.calendarHold);
    expect(held.map((item) => item.id)).toEqual(["suggestion:s2"]);
    expect(held[0].calendarHold).toEqual({ start: NOW + 10, end: NOW + 20 });
    expect(findCalendarHold).toHaveBeenCalledOnce();
  });

  it("keeps the rest when the calendar can't be read", async () => {
    const service = new AttentionService(
      sources({
        listPendingApprovals: async () => [approval("a1", "t1")],
        listRecentTasks: async () => [task("t1", { status: "blocked" })],
        listCalendarProposals: async () => {
          throw new Error("offline");
        },
        findCalendarHold: async () => {
          throw new Error("offline");
        },
      }),
    );
    const snapshot = await service.snapshot();
    expect(snapshot.failedSources).toEqual(["calendar"]);
    expect(snapshot.items.map((item) => item.id)).toEqual(["approval:a1"]);
  });

  it("lists drafted replies, and the offer to draft them when asked", async () => {
    const draft = {
      draftId: "d1",
      threadId: "t1",
      accountId: "gmail:me@example.com",
      provider: "gmail" as const,
      subject: "Q3 proposal",
      to: ["Dana", "Lee", "Kim", "Ray"],
      sender: "Dana",
      bodyText: "Thanks Dana, sending it Friday.",
      createdAt: NOW - 60_000,
    };
    const service = new AttentionService(
      sources({
        listMailReplyDrafts: async () => [draft],
        shouldOfferMailReplyDrafts: async () => true,
      }),
    );
    const { items, failedSources } = await service.snapshot();
    expect(failedSources).toEqual([]);
    expect(items.map((item) => item.id)).toEqual(["mail_reply:d1", "mail_reply:offer"]);

    const failing = new AttentionService(
      sources({
        listMailReplyDrafts: async () => {
          throw new Error("locked");
        },
        shouldOfferMailReplyDrafts: async () => {
          throw new Error("locked");
        },
      }),
    );
    const snapshot = await failing.snapshot();
    expect(snapshot.failedSources).toEqual(["mail"]);
    expect(snapshot.items).toEqual([]);
  });

  it("doesn't wait on a calendar that never answers", async () => {
    vi.useFakeTimers();
    try {
      const service = new AttentionService(
        sources({
          listPendingApprovals: async () => [approval("a1", "t1")],
          listRecentTasks: async () => [task("t1", { status: "blocked" })],
          listCalendarProposals: () => new Promise(() => {}),
        }),
      );
      const pending = service.snapshot();
      await vi.advanceTimersByTimeAsync(5000);
      const snapshot = await pending;
      expect(snapshot.failedSources).toEqual(["calendar"]);
      expect(snapshot.items.map((item) => item.id)).toEqual(["approval:a1"]);
    } finally {
      vi.useRealTimers();
    }
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
