import { SchedulerLeaseStore } from "../../automation/scheduler-lease-store";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { BotWorkControlStore } from "../../automation/BotWorkControlStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import { getBackgroundProcessManager } from "../tools/background-processes";

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp") } }));

// run_command background: true processes outlive a finished turn so follow-ups
// can reach them; the daemon stops them when the task is cancelled or deleted
// (deletion cancels first) and when it shuts down.
describe("daemon background process lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["completed", "failed", "cancelled", "executing"])(
    "stops a %s task's background processes when it is cancelled or deleted",
    async (status) => {
      const stopAllForTask = vi
        .spyOn(getBackgroundProcessManager(), "stopAllForTask")
        .mockResolvedValue(1);
      const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
        taskRepo: {
          findById: vi.fn().mockReturnValue({ id: "task-1", status }),
          findByParent: vi.fn().mockReturnValue([]),
        },
        orchestrationGraphEngine: { cancelRunForRootTask: vi.fn(async () => undefined) },
        pendingContinuationTaskIds: new Set(),
        logEvent: vi.fn(),
        queueManager: { cancelQueuedTask: vi.fn().mockReturnValue(true) },
        cancelTaskRecord: vi.fn(),
        pendingTaskImages: new Map(),
        activeTasks: new Map(),
      }) as Any;

      await AgentDaemon.prototype.cancelTask.call(daemon, "task-1");

      expect(stopAllForTask).toHaveBeenCalledWith("task-1", "task_cancelled");
    },
  );

  it("rejects a stale owner's terminal write before approval or task mutation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-cancel-fence-"));
    const manager = new DatabaseManager({ dbPath: path.join(directory, "fixture.db") });
    try {
      const db = manager.getDatabase();
      const workspace = new WorkspaceStore(db).create("Fixture", directory, {
        read: true,
        write: false,
        delete: false,
        shell: false,
        network: false,
      });
      const bot = new AgentRoleStore(db).create({
        name: "private-fence-fixture",
        displayName: "Fixture",
        description: "Fixture",
        capabilities: [],
      });
      const tasks = new TaskStore(db);
      const task = tasks.create({
        title: "Turn",
        prompt: "Fixture",
        workspaceId: workspace.id,
        assignedAgentRoleId: bot.id,
        status: "executing",
      });
      const control = {
        scope: { workspaceId: workspace.id, agentRoleId: bot.id },
        requestId: "stop",
      };
      const fence = new SchedulerLeaseStore(db).acquire({
        owner: "old",
        now: Date.now(),
        leaseMs: 60000,
      })!;
      new BotWorkControlStore(db).begin(
        { ...control, action: "stop_turn", taskId: task.id },
        Date.now(),
        [],
        fence,
      );
      db.prepare("UPDATE automation_scheduler_lease SET expires_at=0").run();
      new SchedulerLeaseStore(db).acquire({ owner: "new", now: Date.now(), leaseMs: 60000 });
      const cleanupPendingApprovalsForTask = vi.fn();
      const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
        getDatabase: () => db,
        taskRepo: tasks,
        cleanupPendingApprovalsForTask,
      });
      expect(() =>
        daemon.cancelTaskRecord(task.id, "Stale stop", { controlAuthority: { control, fence } }),
      ).toThrow("ownership expired or changed");
      expect(cleanupPendingApprovalsForTask).not.toHaveBeenCalled();
      expect(tasks.findById(task.id)?.status).toBe("executing");
    } finally {
      manager.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it("scoped cancellation does not cascade into foreign descendants or a graph", async () => {
    const stopAllForTask = vi
      .spyOn(getBackgroundProcessManager(), "stopAllForTask")
      .mockResolvedValue(0);
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue({ id: "root", workspaceId: "local", status: "queued" }),
        findByParent: vi
          .fn()
          .mockReturnValue([{ id: "foreign", workspaceId: "foreign", status: "executing" }]),
      },
      orchestrationGraphEngine: { cancelRunForRootTask: vi.fn(async () => undefined) },
      pendingContinuationTaskIds: new Set(),
      logEvent: vi.fn(),
      queueManager: { cancelQueuedTask: vi.fn().mockReturnValue(true) },
      cancelTaskRecord: vi.fn(),
      pendingTaskImages: new Map(),
      activeTasks: new Map(),
    });
    await daemon.cancelTask("root", {
      cascade: false,
      scopeWorkspaceId: "local",
      strictCleanup: true,
    });
    expect(stopAllForTask).toHaveBeenCalledTimes(1);
    expect(daemon.taskRepo.findByParent).not.toHaveBeenCalled();
    expect(daemon.orchestrationGraphEngine.cancelRunForRootTask).not.toHaveBeenCalled();
    await expect(
      daemon.cancelTask("root", { cascade: false, scopeWorkspaceId: "foreign" }),
    ).rejects.toThrow("workspace changed");
    expect(stopAllForTask).toHaveBeenCalledTimes(1);
  });
  it("scoped running cancellation retains runtime ownership until its execution is idle", async () => {
    vi.spyOn(getBackgroundProcessManager(), "stopAllForTask").mockResolvedValue(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = { cancel: vi.fn(async () => {}), waitForIdle: vi.fn(() => gate) };
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi
          .fn()
          .mockReturnValue({ id: "root", workspaceId: "local", status: "executing" }),
        findByParent: vi.fn(),
      },
      orchestrationGraphEngine: { cancelRunForRootTask: vi.fn() },
      pendingContinuationTaskIds: new Set(),
      logEvent: vi.fn(),
      queueManager: { cancelQueuedTask: vi.fn().mockReturnValue(false) },
      cancelTaskRecord: vi.fn(),
      finishQueueSlot: vi.fn(),
      pendingTaskImages: new Map(),
      activeTasks: new Map([["root", { executor }]]),
    });
    const stopping = daemon.cancelTask("root", {
      cascade: false,
      scopeWorkspaceId: "local",
      waitForIdle: true,
    });
    await vi.waitFor(() => expect(executor.waitForIdle).toHaveBeenCalled());
    expect(daemon.activeTasks.has("root")).toBe(true);
    expect(daemon.cancelTaskRecord).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(daemon.activeTasks.has("root")).toBe(false);
    expect(daemon.cancelTaskRecord).toHaveBeenCalled();
    expect(daemon.taskRepo.findByParent).not.toHaveBeenCalled();
  });

  it("blocks a stopped task follow-up before metadata or provider admission", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-stopped-followup-"));
    const manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    try {
      const db = manager.getDatabase();
      const workspace = new WorkspaceStore(db).create("Fixture", dir, {
        read: true,
        write: false,
        delete: false,
        shell: false,
        network: false,
      });
      const bot = new AgentRoleStore(db).create({
        name: "private",
        displayName: "Private",
        description: "Fixture",
        capabilities: [],
      });
      const tasks = new TaskStore(db);
      const task = tasks.create({
        title: "Stopped",
        prompt: "Stopped",
        workspaceId: workspace.id,
        assignedAgentRoleId: bot.id,
        status: "paused",
      });
      new BotWorkControlStore(db).begin(
        {
          scope: { workspaceId: workspace.id, agentRoleId: bot.id },
          requestId: "stop",
          action: "stop_turn",
          taskId: task.id,
        },
        1,
      );
      const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
        taskRepo: tasks,
        getDatabase: () => db,
        ensureBotTaskTeam: vi.fn(),
      });
      await expect(daemon.sendMessage(task.id, "Continue")).rejects.toThrow(
        "persisted stop request",
      );
      expect(daemon.ensureBotTaskTeam).not.toHaveBeenCalled();
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("stops every background process on shutdown, including evicted tasks'", async () => {
    const stopAll = vi.spyOn(getBackgroundProcessManager(), "stopAll").mockResolvedValue(2);
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      orchestrationGraphEngine: { stop: vi.fn() },
      workSessionProtocolService: { getReliabilityService: () => ({ stop: vi.fn() }) },
      pendingApprovals: new Map(),
      pendingDurableApprovalGrants: new Map(),
      pendingInputRequests: new Map(),
      pendingRetries: new Map(),
      pendingTaskImages: new Map(),
      activeTasks: new Map(),
      taskRepo: { findById: () => undefined, update: vi.fn() },
      logEvent: vi.fn(),
      removeAllListeners: vi.fn(),
    });

    await daemon.shutdown();

    expect(stopAll).toHaveBeenCalledWith("app_shutdown");
  });
});
