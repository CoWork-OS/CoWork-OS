import { OrchestrationGraphStore } from "../../agent/orchestration/OrchestrationGraphRepository";
import Database from "better-sqlite3";
import { SchedulerLeaseStore } from "../scheduler-lease-store";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { BotWorkControlStore, assertTaskNotStopped } from "../BotWorkControlStore";
import { BotWorkControlService } from "../BotWorkControlService";
import { assertResponsibilityTaskPolicy } from "../responsibility-task-policy";
import type { BotWorkControlRequest } from "../../../shared/bot-work-control";
describe("scoped durable bot work controls", () => {
  let dir: string,
    manager: DatabaseManager,
    tasks: TaskStore,
    scope: { workspaceId: string; agentRoleId: string },
    otherWorkspace: string,
    otherBot: string;
  let root: string, child: string, foreign: string, unrelated: string;
  const request = (
    action: "stop_bot" | "stop_turn" = "stop_bot",
    requestId = "stop",
  ): BotWorkControlRequest => ({
    scope,
    requestId,
    action,
    ...(action === "stop_turn" ? { taskId: root } : {}),
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-stop-fixture-"));
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    const db = manager.getDatabase();
    tasks = new TaskStore(db);
    const workspaces = new WorkspaceStore(db);
    const permissions = { read: true, write: false, delete: false, shell: false, network: false };
    const workspace = workspaces.create("Local", dir, permissions);
    otherWorkspace = workspaces.create("Foreign", path.join(dir, "foreign"), permissions).id;
    const bots = new AgentRoleStore(db);
    const bot = bots.create({
      name: "private-a",
      displayName: "A",
      description: "Fixture",
      systemPrompt: "Keep private instructions",
      capabilities: [],
    });
    otherBot = bots.create({
      name: "private-b",
      displayName: "B",
      description: "Fixture",
      capabilities: [],
    }).id;
    scope = { workspaceId: workspace.id, agentRoleId: bot.id };
    root = tasks.create({
      title: "Root",
      prompt: "Root",
      workspaceId: workspace.id,
      status: "executing",
      assignedAgentRoleId: bot.id,
    }).id;
    child = tasks.create({
      title: "Child",
      prompt: "Child",
      workspaceId: workspace.id,
      status: "queued",
      assignedAgentRoleId: otherBot,
      parentTaskId: root,
    }).id;
    foreign = tasks.create({
      title: "Foreign",
      prompt: "Foreign",
      workspaceId: otherWorkspace,
      status: "executing",
      parentTaskId: root,
    }).id;
    unrelated = tasks.create({
      title: "Unrelated",
      prompt: "Unrelated",
      workspaceId: workspace.id,
      status: "executing",
      assignedAgentRoleId: otherBot,
    }).id;
  });
  afterEach(() => {
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("selects local assignment and descendants, and persists revocation before cleanup", () => {
    const store = new BotWorkControlStore(manager.getDatabase());
    const receipt = store.begin(request(), Date.now());
    expect(receipt.tasks.map((item) => item.taskId).sort()).toEqual([root, child].sort());
    expect(() => assertTaskNotStopped(manager.getDatabase(), root)).toThrow("persisted stop");
    expect(() => assertTaskNotStopped(manager.getDatabase(), foreign)).not.toThrow();
    expect(() =>
      assertResponsibilityTaskPolicy(
        manager.getDatabase(),
        child,
        scope.workspaceId,
        null,
        "node",
        "start",
      ),
    ).toThrow("persisted stop");
    expect(() =>
      tasks.create({
        title: "Late",
        prompt: "Late",
        workspaceId: scope.workspaceId,
        status: "queued",
        parentTaskId: root,
      }),
    ).toThrow("persisted stop");
  });
  it("replays one request and rejects foreign task scope or changed identity", () => {
    const store = new BotWorkControlStore(manager.getDatabase());
    const first = store.begin(request(), 1);
    expect(store.begin(request(), 2)).toEqual(first);
    expect(() => store.begin({ ...request(), action: "stop_turn", taskId: foreign }, 3)).toThrow(
      "identity changed",
    );
    expect(() => store.begin({ ...request("stop_turn", "foreign"), taskId: foreign }, 3)).toThrow(
      "outside",
    );
    expect(() => store.begin({ ...request("stop_turn", "other"), taskId: unrelated }, 3)).toThrow(
      "outside",
    );
  });
  it("handles parent cycles without duplicate selection", () => {
    tasks.update(root, { parentTaskId: child });
    const receipt = new BotWorkControlStore(manager.getDatabase()).begin(request("stop_turn"), 1);
    expect(receipt.tasks).toHaveLength(2);
  });
  it("reports confirmed cleanup and preserves unrelated work", async () => {
    const cancel = vi.fn(async (id: string) => {
      tasks.update(id, { status: "cancelled" });
    });
    const service = new BotWorkControlService(manager.getDatabase(), {
      cancel,
      isStopped: (id) => tasks.findById(id)?.status === "cancelled",
    });
    const receipt = await service.stop(request());
    expect(receipt?.status).toBe("settled");
    expect(receipt?.tasks.every((item) => item.status === "stopped")).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(tasks.findById(foreign)?.status).toBe("executing");
    expect(tasks.findById(unrelated)?.status).toBe("executing");
    await service.stop(request());
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it("keeps a deadline receipt pending until runtime cleanup settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new BotWorkControlService(
      manager.getDatabase(),
      {
        cancel: async (id) => {
          await gate;
          tasks.update(id, { status: "cancelled" });
        },
        isStopped: (id) => tasks.findById(id)?.status === "cancelled",
      },
      1,
    );
    expect((await service.stop(request()))?.status).toBe("pending");
    expect(() => assertTaskNotStopped(manager.getDatabase(), root)).toThrow();
    release();
    await vi.waitFor(async () =>
      expect((await service.read({ scope, requestId: "stop" }))?.status).toBe("settled"),
    );
  });
  it("retains a failed cleanup outcome and retries only that original snapshot", async () => {
    const cancel = vi.fn(async (id: string) => {
      if (id === root && cancel.mock.calls.length < 3) throw new Error("Cleanup failed");
      tasks.update(id, { status: "cancelled" });
    });
    const service = new BotWorkControlService(manager.getDatabase(), {
      cancel,
      isStopped: (id) => tasks.findById(id)?.status === "cancelled",
    });
    const first = await service.stop(request());
    expect(first?.tasks.find((item) => item.taskId === root)?.status).toBe("failed");
    const later = tasks.create({
      title: "Later",
      prompt: "Later",
      workspaceId: scope.workspaceId,
      status: "queued",
      assignedAgentRoleId: scope.agentRoleId,
    });
    await service.stop(request());
    expect(tasks.findById(later.id)?.status).toBe("queued");
  });
  it("requires explicit exact-version release after confirmed cleanup", async () => {
    const service = new BotWorkControlService(manager.getDatabase(), {
      cancel: async (id) => {
        tasks.update(id, { status: "cancelled" });
      },
      isStopped: (id) => tasks.findById(id)?.status === "cancelled",
    });
    const stopped = await service.stop(request("stop_turn"));
    const version = stopped!.tasks.find((item) => item.taskId === root)!.stopVersion;
    await expect(
      service.stop({
        scope,
        requestId: "bad-resume",
        action: "resume_turn",
        taskId: root,
        expectedStopVersion: version + 1,
      }),
    ).rejects.toThrow("version changed");
    const resume = {
      scope,
      requestId: "resume",
      action: "resume_turn" as const,
      taskId: root,
      expectedStopVersion: version,
    };
    expect((await service.stop(resume))?.tasks[0].status).toBe("released");
    expect(() => assertTaskNotStopped(manager.getDatabase(), root)).not.toThrow();
    expect(tasks.findById(root)?.status).toBe("cancelled");
    expect(await service.stop(resume)).toMatchObject({ status: "settled" });
  });
  it("reopens pending control intent and completes the same receipt", async () => {
    new BotWorkControlStore(manager.getDatabase()).begin(request(), 1);
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    tasks = new TaskStore(manager.getDatabase());
    const service = new BotWorkControlService(manager.getDatabase(), {
      cancel: async (id) => {
        tasks.update(id, { status: "cancelled" });
      },
      isStopped: (id) => tasks.findById(id)?.status === "cancelled",
    });
    expect((await service.stop(request()))?.tasks).toHaveLength(2);
  });
  it("includes a completed task only when runtime work remains, without crossing scope", () => {
    tasks.update(root, { status: "completed" });
    tasks.update(child, { status: "completed" });
    const receipt = new BotWorkControlStore(manager.getDatabase()).begin(request(), 1, [
      root,
      foreign,
    ]);
    expect(receipt.tasks.map((item) => item.taskId)).toEqual([root]);
  });
  it("does not replay failed cleanup against a released or newer turn", async () => {
    const store = new BotWorkControlStore(manager.getDatabase());
    const original = request("stop_turn");
    const receipt = store.begin(original, Date.now());
    for (const item of receipt.tasks) {
      tasks.update(item.taskId, { status: "cancelled" });
      store.record(
        { scope, requestId: original.requestId },
        item.taskId,
        "failed",
        "Lost confirmation",
        Date.now(),
      );
    }
    const cancel = vi.fn(async () => {});
    const service = new BotWorkControlService(manager.getDatabase(), {
      cancel,
      isStopped: () => true,
    });
    await service.stop({
      scope,
      requestId: "release",
      action: "resume_turn",
      taskId: root,
      expectedStopVersion: receipt.tasks.find((item) => item.taskId === root)!.stopVersion,
    });
    await service.stop(original);
    expect(cancel.mock.calls.map((call) => call[0])).not.toContain(root);
    cancel.mockClear();
    store.begin(request("stop_turn", "new-stop"), Date.now());
    await service.stop(original);
    expect(cancel).not.toHaveBeenCalled();
  });
  it("recovers a saved stop after database reopen without selecting newer tasks", async () => {
    const db = manager.getDatabase();
    new BotWorkControlStore(db).begin(request(), Date.now());
    const later = tasks.create({
      title: "Later",
      prompt: "Later",
      workspaceId: scope.workspaceId,
      assignedAgentRoleId: scope.agentRoleId,
      status: "paused",
    }).id;
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    tasks = new TaskStore(manager.getDatabase());
    const cancel = vi.fn(async (id: string) => {
      tasks.update(id, { status: "cancelled" });
    });
    const service = new BotWorkControlService(manager.getDatabase(), {
      cancel,
      isStopped: (id) => tasks.findById(id)?.status === "cancelled",
    });
    await service.recover();
    expect(cancel.mock.calls.map(([id]) => id).sort()).toEqual([root, child].sort());
    expect(tasks.findById(later)?.status).toBe("paused");
    expect((await service.read({ scope, requestId: "stop" }))?.stillActiveTaskIds).toEqual([]);
    await service.recover();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it("finishes saved cleanup after the owning bot is removed from active use", async () => {
    new BotWorkControlStore(manager.getDatabase()).begin(request(), Date.now());
    expect(new AgentRoleStore(manager.getDatabase()).delete(scope.agentRoleId)).toBe(true);
    const cancel = vi.fn(async (id: string) => {
      tasks.update(id, { status: "cancelled" });
    });
    const service = new BotWorkControlService(manager.getDatabase(), {
      cancel,
      isStopped: (id) => tasks.findById(id)?.status === "cancelled",
    });
    await service.recover();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(new BotWorkControlStore(manager.getDatabase()).recoverable()).toEqual([]);
  });
  it("rejects stale control writers atomically after another connection takes ownership", () => {
    const db = manager.getDatabase();
    const peer = new Database(path.join(dir, "fixture.db"));
    try {
      const old = new SchedulerLeaseStore(db).acquire({
        owner: "old",
        now: Date.now(),
        leaseMs: 60000,
      })!;
      db.prepare("UPDATE automation_scheduler_lease SET expires_at=0").run();
      const current = new SchedulerLeaseStore(peer).acquire({
        owner: "new",
        now: Date.now(),
        leaseMs: 60000,
      })!;
      const store = new BotWorkControlStore(db);
      expect(() => store.begin(request(), Date.now(), [], old)).toThrow(
        "ownership expired or changed",
      );
      expect(store.read({ scope, requestId: "stop" })).toBeNull();
      expect(() => assertTaskNotStopped(db, root)).not.toThrow();
      store.begin(request(), Date.now(), [], current);
      expect(() => store.syncGraphs({ scope, requestId: "stop" }, [root], old)).toThrow(
        "ownership expired or changed",
      );
      const newer = new BotWorkControlStore(peer);
      newer.record({ scope, requestId: "stop" }, root, "stopped", null, Date.now(), current);
      expect(() =>
        store.record(
          { scope, requestId: "stop" },
          root,
          "failed",
          "Stale failure",
          Date.now(),
          old,
        ),
      ).toThrow("ownership expired or changed");
      expect(
        store.read({ scope, requestId: "stop" })?.tasks.find((item) => item.taskId === root)
          ?.status,
      ).toBe("stopped");
    } finally {
      peer.close();
    }
  });
  it("retains the captured generation across delayed native cleanup", async () => {
    const db = manager.getDatabase();
    const peer = new Database(path.join(dir, "fixture.db"));
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(async () => {
      await waiting;
    });
    const old = new SchedulerLeaseStore(db).acquire({
      owner: "old",
      now: Date.now(),
      leaseMs: 60000,
    })!;
    const input = { ...request("stop_turn"), taskId: child };
    const service = new BotWorkControlService(db, {
      cancel,
      isStopped: () => false,
      captureFence: () => old,
    });
    const result = service.stop(input);
    const rejection = expect(result).rejects.toThrow("ownership expired or changed");
    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      peer.prepare("UPDATE automation_scheduler_lease SET expires_at=0").run();
      const current = new SchedulerLeaseStore(peer).acquire({
        owner: "new",
        now: Date.now(),
        leaseMs: 60000,
      })!;
      new BotWorkControlStore(peer).record(
        { scope, requestId: "stop" },
        child,
        "stopped",
        null,
        Date.now(),
        current,
      );
      release();
      await rejection;
      expect((await service.read({ scope, requestId: "stop" }))?.tasks[0].status).toBe("stopped");
    } finally {
      release();
      await result.catch(() => {});
      peer.close();
    }
  });
  it("confirms a local graph after its selected tasks finish cleanup", async () => {
    const db = manager.getDatabase();
    const graphs = new OrchestrationGraphStore(db);
    const linked = tasks.create({
      title: "Unparented graph task",
      prompt: "Fixture",
      workspaceId: scope.workspaceId,
      assignedAgentRoleId: otherBot,
      status: "paused",
    }).id;
    graphs.createRun({
      run: {
        id: "graph",
        rootTaskId: root,
        workspaceId: scope.workspaceId,
        kind: "delegation",
        status: "running",
        maxParallel: 2,
      },
      nodes: [
        {
          id: "local",
          key: "local",
          title: "Local",
          prompt: "Fixture",
          kind: "child_task",
          status: "running",
          dispatchTarget: "local_role",
          taskId: linked,
        },
        {
          id: "future",
          key: "future",
          title: "Future",
          prompt: "Fixture",
          kind: "child_task",
          status: "ready",
          dispatchTarget: "local_role",
        },
      ],
    });
    const cancel = vi.fn(async (id: string) => {
      expect(graphs.findSnapshotByRunId("graph")?.run.status).toBe("cancelled");
      tasks.update(id, { status: "cancelled" });
    });
    const local = (id: string) => tasks.findById(id)?.status === "cancelled";
    const service = new BotWorkControlService(db, {
      cancel,
      isLocallyStopped: local,
      isStopped: (id) =>
        local(id) &&
        graphs
          .listSnapshotsByRootTaskId(id)
          .every((graph) =>
            graph.nodes.every((node) => ["completed", "failed", "cancelled"].includes(node.status)),
          ),
    });
    const receipt = await service.stop(request("stop_turn"));
    expect(cancel.mock.calls.map(([id]) => id).sort()).toEqual([root, child, linked].sort());
    expect(receipt?.stillActiveTaskIds).toEqual([]);
    expect(graphs.findNodeById("local")?.status).toBe("cancelled");
    expect(graphs.findNodeById("future")?.status).toBe("cancelled");
    expect(tasks.findById(unrelated)?.status).toBe("executing");
  });
  it("keeps foreign and remote graph work unresolved while stopping local work", async () => {
    const db = manager.getDatabase();
    const graphs = new OrchestrationGraphStore(db);
    graphs.createRun({
      run: {
        id: "mixed",
        rootTaskId: root,
        workspaceId: scope.workspaceId,
        kind: "delegation",
        status: "running",
        maxParallel: 3,
      },
      nodes: [
        {
          id: "local",
          key: "local",
          title: "Local",
          prompt: "Fixture",
          kind: "child_task",
          status: "running",
          dispatchTarget: "native_child_task",
          taskId: child,
        },
        {
          id: "foreign",
          key: "foreign",
          title: "Foreign",
          prompt: "Fixture",
          kind: "child_task",
          status: "running",
          dispatchTarget: "native_child_task",
          taskId: foreign,
        },
        {
          id: "remote",
          key: "remote",
          title: "Remote",
          prompt: "Fixture",
          kind: "acp_task",
          status: "running",
          dispatchTarget: "remote_acp",
          remoteTaskId: "remote-task",
          acpAgentId: "remote-agent",
        },
      ],
    });
    const cancel = vi.fn(async (id: string) => {
      tasks.update(id, { status: "cancelled" });
    });
    const local = (id: string) => tasks.findById(id)?.status === "cancelled";
    const service = new BotWorkControlService(db, {
      cancel,
      isLocallyStopped: local,
      isStopped: (id) =>
        local(id) &&
        graphs
          .listSnapshotsByRootTaskId(id)
          .every((graph) =>
            graph.nodes.every((node) => ["completed", "failed", "cancelled"].includes(node.status)),
          ),
    });
    const receipt = await service.stop(request("stop_turn"));
    expect(cancel.mock.calls.map(([id]) => id).sort()).toEqual([root, child].sort());
    expect(receipt?.stillActiveTaskIds).toEqual([root]);
    expect(graphs.findNodeById("foreign")?.status).toBe("running");
    expect(graphs.findNodeById("remote")?.status).toBe("running");
    expect(tasks.findById(foreign)?.status).toBe("executing");
  });
  it("refuses cancellation after a selected task is moved to a foreign workspace", async () => {
    const store = new BotWorkControlStore(manager.getDatabase());
    store.begin(request(), 1);
    tasks.update(root, { workspaceId: otherWorkspace });
    const cancel = vi.fn(async (id: string) => {
      tasks.update(id, { status: "cancelled" });
    });
    const receipt = await new BotWorkControlService(manager.getDatabase(), {
      cancel,
      isStopped: () => true,
    }).stop(request());
    expect(receipt?.tasks.find((item) => item.taskId === root)?.status).toBe("failed");
    expect(cancel.mock.calls.map((call) => call[0])).not.toContain(root);
  });
  it("selects a terminal root whose graph still contains unresolved work", () => {
    const db = manager.getDatabase();
    tasks.update(root, { status: "completed" });
    tasks.update(child, { status: "completed" });
    new OrchestrationGraphStore(db).createRun({
      run: {
        id: "unresolved",
        rootTaskId: root,
        workspaceId: scope.workspaceId,
        kind: "delegation",
        status: "failed",
        maxParallel: 1,
      },
      nodes: [
        {
          id: "unknown",
          key: "unknown",
          title: "Unknown outcome",
          prompt: "Fixture",
          kind: "child_task",
          status: "blocked",
          dispatchTarget: "remote_agent",
          remoteTaskId: "unknown-remote",
        },
      ],
    });
    const store = new BotWorkControlStore(db);
    expect(store.activeGraphRoots()).toContain(root);
    const receipt = store.begin(request(), Date.now(), store.activeGraphRoots());
    expect(receipt.tasks.map((item) => item.taskId)).toEqual([root]);
    expect(receipt.stillActiveTaskIds).toEqual([root]);
  });
  it("persists bot pause, protects resume version, and leaves other scopes admitted", () => {
    const db = manager.getDatabase();
    const store = new BotWorkControlStore(db);
    const paused = store.begin({ scope, requestId: "pause", action: "pause_bot" }, Date.now());
    expect(paused.tasks).toEqual([]);
    expect(paused.stillActiveTaskIds.sort()).toEqual([root, child].sort());
    expect(() =>
      tasks.create({
        title: "Late",
        prompt: "Late",
        workspaceId: scope.workspaceId,
        assignedAgentRoleId: scope.agentRoleId,
        status: "queued",
      }),
    ).toThrow("Bot future runs are paused");
    expect(() =>
      tasks.create({
        title: "Other bot",
        prompt: "Other",
        workspaceId: scope.workspaceId,
        assignedAgentRoleId: otherBot,
        status: "paused",
      }),
    ).not.toThrow();
    expect(() =>
      tasks.create({
        title: "Other workspace",
        prompt: "Other",
        workspaceId: otherWorkspace,
        assignedAgentRoleId: scope.agentRoleId,
        status: "paused",
      }),
    ).not.toThrow();
    expect(tasks.findById(root)?.status).toBe("executing");
    expect(store.begin({ scope, requestId: "pause", action: "pause_bot" }, Date.now())).toEqual(
      paused,
    );
    expect(() =>
      store.begin(
        { scope, requestId: "resume-stale", action: "resume_bot", expectedFutureControlVersion: 0 },
        Date.now(),
      ),
    ).toThrow("version changed");
    store.begin(
      { scope, requestId: "resume", action: "resume_bot", expectedFutureControlVersion: 1 },
      Date.now(),
    );
    expect(store.futureState({ scope })).toMatchObject({
      futurePaused: false,
      futureControlVersion: 2,
    });
    store.begin({ scope, requestId: "pause-again", action: "pause_bot" }, Date.now());
    expect(() =>
      store.begin(
        { scope, requestId: "resume-old", action: "resume_bot", expectedFutureControlVersion: 2 },
        Date.now(),
      ),
    ).toThrow("version changed");
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    tasks = new TaskStore(manager.getDatabase());
    expect(new BotWorkControlStore(manager.getDatabase()).futureState({ scope })).toMatchObject({
      futurePaused: true,
      futureControlVersion: 3,
    });
    expect(() =>
      tasks.create({
        title: "After restart",
        prompt: "Late",
        workspaceId: scope.workspaceId,
        assignedAgentRoleId: scope.agentRoleId,
        status: "queued",
      }),
    ).toThrow("Bot future runs are paused");
  });
  it("commits stop and pause together and rolls both back if stop persistence fails", async () => {
    const db = manager.getDatabase();
    const store = new BotWorkControlStore(db);
    db.exec(
      "CREATE TRIGGER reject_intent BEFORE INSERT ON bot_task_stop_intents BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
    );
    expect(() =>
      store.begin({ scope, requestId: "atomic-fail", action: "stop_and_pause" }, Date.now()),
    ).toThrow("fixture interruption");
    expect(store.futureState({ scope }).futurePaused).toBe(false);
    expect(store.read({ scope, requestId: "atomic-fail" })).toBeNull();
    db.exec("DROP TRIGGER reject_intent");
    const cancel = vi.fn(async (id: string) => {
      expect(store.futureState({ scope }).futurePaused).toBe(true);
      expect(() =>
        tasks.create({
          title: "Due",
          prompt: "Due",
          workspaceId: scope.workspaceId,
          assignedAgentRoleId: scope.agentRoleId,
          status: "queued",
        }),
      ).toThrow("Bot future runs are paused");
      tasks.update(id, { status: "cancelled" });
    });
    const work = new BotWorkControlService(db, {
      cancel,
      isStopped: (id) => tasks.findById(id)?.status === "cancelled",
    });
    const receipt = await work.stop({ scope, requestId: "atomic", action: "stop_and_pause" });
    expect(receipt!.stillActiveTaskIds).toEqual([]);
    expect(receipt!.futureControl?.futurePaused).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(tasks.findById(unrelated)?.status).toBe("executing");
    expect(tasks.findById(foreign)?.status).toBe("executing");
  });
});
