import { describe, expect, it, vi } from "vitest";

import { AgentDaemon, orphanedTaskRecovery } from "../daemon";

function createDaemonLike(overrides?: Partial<Any>) {
  return {
    activeTasks: new Map([
      [
        "task-1",
        {
          lastAccessed: 0,
          status: "idle",
          executor: {
            resume: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    ]),
    taskRepo: {
      findById: vi.fn().mockReturnValue({
        id: "task-1",
        status: "paused",
        completedAt: null,
        terminalStatus: null,
      }),
    },
    updateTaskStatus: vi.fn(),
    logEvent: vi.fn(),
    ...overrides,
  } as Any;
}

describe("AgentDaemon.resumeTask", () => {
  it.each(["interrupted", "paused"])(
    "restores an executor-less %s task from durable state",
    async (status) => {
      const task = { id: "task-1", status, terminalStatus: "resume_available" };
      const daemon = createDaemonLike({
        activeTasks: new Map(),
        taskRepo: { findById: vi.fn(() => task), update: vi.fn() },
        resumeInterruptedTask: vi.fn().mockResolvedValue(undefined),
      });
      expect(await AgentDaemon.prototype.resumeTask.call(daemon, task.id)).toBe(true);
      expect(daemon.resumeInterruptedTask).toHaveBeenCalledWith({ ...task, status: "interrupted" });
    },
  );
  it("fails interrupted resume when the required worktree is missing", async () => {
    const task = {
      id: "task-missing-worktree",
      status: "interrupted",
      workspaceId: "workspace-1",
      agentConfig: { requireWorktree: true, worktreeMode: "worktree" },
    };
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      shutdownRequested: false,
      taskRepo: { findById: vi.fn().mockReturnValue(task), update: vi.fn() },
      workspaceRepo: {
        findById: vi
          .fn()
          .mockReturnValue({ id: "workspace-1", path: "/tmp/base", permissions: {} }),
      },
      applyTaskWorkspaceOverrides: vi.fn((_task: Any, workspace: Any) => workspace),
      getTaskEventsForResume: vi
        .fn()
        .mockReturnValue([
          { type: "plan_created", payload: { plan: { description: "p", steps: [] } } },
        ]),
      getTaskEventsForReplay: vi.fn().mockReturnValue([]),
      isLegacyEventType: vi.fn((event: Any, type: string) => event.type === type),
      resolveLegacyEventType: vi.fn((event: Any) => event.type),
      applyAgentRoleOverrides: vi.fn((value: Any) => ({ task: value })),
      withLegacyTeamWorkItemLane: vi.fn((value: Any) => value),
      logEvent: vi.fn(),
      queueManager: { enqueue: vi.fn() },
    });

    await expect(
      AgentDaemon.prototype["resumeInterruptedTask"].call(daemonLike, task),
    ).rejects.toThrow(/isolated worktree.*missing/i);
    expect(daemonLike.queueManager.enqueue).not.toHaveBeenCalled();
  });

  it("fails manual continuation when the required worktree is missing", () => {
    const task = {
      id: "task-missing-worktree-continuation",
      workspaceId: "workspace-1",
      agentConfig: { requireWorktree: true, worktreeMode: "worktree" },
    };
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: { update: vi.fn() },
      workspaceRepo: {
        findById: vi
          .fn()
          .mockReturnValue({ id: "workspace-1", path: "/tmp/base", permissions: {} }),
      },
      applyAgentRoleOverrides: vi.fn((value: Any) => ({ task: value })),
      withLegacyTeamWorkItemLane: vi.fn((value: Any) => value),
      isLegacyEventType: vi.fn((event: Any, type: string) => event.type === type),
    });
    const events = [{ type: "plan_created", payload: { plan: { description: "p", steps: [] } } }];

    expect(() =>
      AgentDaemon.prototype["createContinuationExecutor"].call(daemonLike, task, events),
    ).toThrow(/isolated worktree.*missing/i);
  });

  it("does not reopen a task that is already terminal", async () => {
    const daemonLike = createDaemonLike({
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-1",
          status: "executing",
          completedAt: Date.now(),
          terminalStatus: "ok",
        }),
      },
    });

    const resumed = await AgentDaemon.prototype.resumeTask.call(daemonLike, "task-1");

    expect(resumed).toBe(false);
    expect(daemonLike.updateTaskStatus).not.toHaveBeenCalled();
    expect(daemonLike.logEvent).not.toHaveBeenCalled();
    expect(daemonLike.activeTasks.get("task-1")?.executor.resume).not.toHaveBeenCalled();
  });

  it("skips duplicate executing writes when the task is already executing", async () => {
    const daemonLike = createDaemonLike({
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-1",
          status: "executing",
          completedAt: null,
          terminalStatus: null,
        }),
      },
    });

    const resumed = await AgentDaemon.prototype.resumeTask.call(daemonLike, "task-1");

    expect(resumed).toBe(true);
    expect(daemonLike.updateTaskStatus).not.toHaveBeenCalled();
    expect(daemonLike.logEvent).not.toHaveBeenCalled();
    expect(daemonLike.activeTasks.get("task-1")?.executor.resume).toHaveBeenCalledTimes(1);
  });

  it("resumes a paused task and marks it executing once", async () => {
    const daemonLike = createDaemonLike();

    const resumed = await AgentDaemon.prototype.resumeTask.call(daemonLike, "task-1");

    expect(resumed).toBe(true);
    expect(daemonLike.updateTaskStatus).toHaveBeenCalledWith("task-1", "executing");
    expect(daemonLike.logEvent).toHaveBeenCalledWith("task-1", "task_resumed", {
      message: "Task resumed",
    });
    expect(daemonLike.activeTasks.get("task-1")?.executor.resume).toHaveBeenCalledTimes(1);
  });

  it("reconstructs a paused task after its executor was lost on restart", async () => {
    const task = { id: "task-1", status: "paused", completedAt: null, terminalStatus: null };
    const daemonLike = createDaemonLike({
      activeTasks: new Map(),
      taskRepo: {
        findById: vi.fn().mockReturnValue(task),
        update: vi.fn(),
      },
      resumeInterruptedTask: vi.fn().mockResolvedValue(undefined),
    });

    const resumed = await AgentDaemon.prototype.resumeTask.call(daemonLike, task.id);

    expect(resumed).toBe(true);
    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(task.id, { status: "interrupted" });
    expect(daemonLike.resumeInterruptedTask).toHaveBeenCalledWith({
      ...task,
      status: "interrupted",
    });
  });

  it("keeps a paused task recoverable when checkpoint reconstruction fails", async () => {
    const task = { id: "task-1", status: "paused", completedAt: null, terminalStatus: null };
    const daemonLike = createDaemonLike({
      activeTasks: new Map(),
      taskRepo: {
        findById: vi.fn().mockReturnValue(task),
        update: vi.fn(),
      },
      resumeInterruptedTask: vi.fn().mockRejectedValue(new Error("checkpoint unavailable")),
    });

    await expect(AgentDaemon.prototype.resumeTask.call(daemonLike, task.id)).rejects.toThrow(
      "checkpoint unavailable",
    );
    expect(daemonLike.taskRepo.update).toHaveBeenNthCalledWith(1, task.id, {
      status: "interrupted",
    });
    expect(daemonLike.taskRepo.update).toHaveBeenNthCalledWith(2, task.id, { status: "paused" });
  });
});

describe("interrupted turn discard fencing", () => {
  it.each([
    { status: "executing", updatedAt: 1 },
    { status: "interrupted", updatedAt: 2 },
  ])("rejects a stale discard before cleanup ($status, revision $updatedAt)", async (task) => {
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: { findById: () => ({ id: "task-1", ...task }), update: vi.fn() },
      applicationExecutionService: { cancelForTask: vi.fn() },
      logEvent: vi.fn(),
    });
    await expect(daemon.discardInterruptedTask("task-1", 1)).rejects.toThrow(/changed or resumed/);
    expect(daemon.taskRepo.update).not.toHaveBeenCalled();
    expect(daemon.applicationExecutionService.cancelForTask).not.toHaveBeenCalled();
  });
  it("claims the interrupted generation before asynchronous cleanup and refuses resume", async () => {
    let task = { id: "task-1", status: "interrupted", updatedAt: 1 };
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: () => task,
        update: (_id: string, updates: Any) => {
          task = { ...task, ...updates };
        },
      },
      activeTasks: new Map(),
      pendingContinuationTaskIds: new Set(),
      applicationExecutionService: { cancelForTask: vi.fn(() => cleanup) },
      orchestrationGraphEngine: { cancelRunForRootTask: vi.fn(async () => undefined) },
      queueManager: { cancelQueuedTask: () => false },
      settleRunningTaskCancellation: vi.fn(async () => undefined),
      logEvent: vi.fn(),
    });
    const discard = daemon.discardInterruptedTask("task-1", 1);
    expect(daemon.interruptedDiscards.has("task-1")).toBe(true);
    expect(await daemon.resumeTask("task-1")).toBe(false);
    release();
    await discard;
    expect(daemon.settleRunningTaskCancellation).toHaveBeenCalledTimes(1);
    expect(daemon.interruptedDiscards.size).toBe(0);
  });
});

describe("orphaned task recovery after a crash", () => {
  const typed = { promptProvenance: "user_typed" as const, agentConfig: {} };

  it("resumes saved work, or skips it for background and system tasks", () => {
    expect(orphanedTaskRecovery({ hasSavedState: true, resumesOnStartup: true, task: typed })).toBe(
      "resume",
    );
    expect(
      orphanedTaskRecovery({ hasSavedState: true, resumesOnStartup: false, task: typed }),
    ).toBe("skip");
  });

  it("pauses a request typed in the app that saved nothing, for the person to resume", () => {
    expect(
      orphanedTaskRecovery({ hasSavedState: false, resumesOnStartup: true, task: typed }),
    ).toBe("await_user");
  });

  it.each([
    { promptProvenance: undefined, agentConfig: {} },
    { promptProvenance: "user_typed" as const, agentConfig: { originChannel: "whatsapp" } },
    { promptProvenance: "user_typed" as const, agentConfig: { gatewayContext: "private" } },
  ])("fails work that nobody typed in the app when nothing was saved: %j", (task) => {
    expect(
      orphanedTaskRecovery({ hasSavedState: false, resumesOnStartup: true, task: task as Any }),
    ).toBe("fail");
  });

  it("fails background work that saved nothing", () => {
    expect(
      orphanedTaskRecovery({ hasSavedState: false, resumesOnStartup: false, task: typed }),
    ).toBe("fail");
  });
});
