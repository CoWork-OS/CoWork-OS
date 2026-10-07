import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { DatabaseManager } from "../../../database/schema";
import { TaskStore, WorkspaceStore } from "../../../database/repositories";
import { AgentRoleStore } from "../../../agents/AgentRoleRepository";
import { BotWorkControlStore } from "../../../automation/BotWorkControlStore";
import { OrchestrationGraphStore } from "../OrchestrationGraphRepository";
import { OrchestrationGraphEngine } from "../OrchestrationGraphEngine";
describe("atomic graph task admission and scoped stop selection", () => {
  let dir: string,
    manager: DatabaseManager,
    tasks: TaskStore,
    graphs: OrchestrationGraphStore,
    root: string,
    workspaceId: string,
    botId: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-graph-admit-"));
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    const db = manager.getDatabase();
    tasks = new TaskStore(db);
    graphs = new OrchestrationGraphStore(db);
    workspaceId = new WorkspaceStore(db).create("Fixture", dir, {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    }).id;
    botId = new AgentRoleStore(db).create({
      name: "private-graph-fixture",
      displayName: "Fixture",
      description: "Fixture",
      capabilities: [],
    }).id;
    root = tasks.create({
      title: "Root",
      prompt: "Root",
      workspaceId,
      assignedAgentRoleId: botId,
      status: "paused",
    }).id;
  });
  afterEach(() => {
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function claim() {
    const snapshot = graphs.createRun({
      run: {
        id: "graph",
        rootTaskId: root,
        workspaceId,
        kind: "delegation",
        status: "running",
        maxParallel: 1,
      },
      nodes: [
        {
          id: "node",
          key: "node",
          title: "Local work",
          prompt: "Fixture",
          kind: "child_task",
          status: "ready",
          dispatchTarget: "local_role",
        },
      ],
    });
    graphs.claimReadyNode(snapshot.nodes[0].id, {
      id: "claim",
      claimedAt: Date.now(),
      ownerPid: process.pid,
      phase: "claimed",
    });
    return { runId: "graph", nodeId: "node", claimId: "claim" };
  }
  it("links an unparented local task before a stop can select work", () => {
    const admission = claim();
    const task = tasks.create(
      { title: "Local", prompt: "Local", workspaceId, status: "paused" },
      admission,
    );
    expect(graphs.findNodeById("node")?.taskId).toBe(task.id);
    const receipt = new BotWorkControlStore(manager.getDatabase()).begin(
      {
        scope: { workspaceId, agentRoleId: botId },
        requestId: "stop",
        action: "stop_turn",
        taskId: root,
      },
      Date.now(),
    );
    expect(receipt.tasks.map((item) => item.taskId).sort()).toEqual([root, task.id].sort());
    expect(graphs.findSnapshotByRunId("graph")?.run.status).toBe("cancelled");
  });
  it("rejects a task racing after the stop transaction without leaving an orphan", () => {
    const admission = claim();
    new BotWorkControlStore(manager.getDatabase()).begin(
      {
        scope: { workspaceId, agentRoleId: botId },
        requestId: "stop",
        action: "stop_turn",
        taskId: root,
      },
      Date.now(),
    );
    expect(() =>
      tasks.create({ title: "Late", prompt: "Late", workspaceId, status: "paused" }, admission),
    ).toThrow("admission is closed");
    expect(tasks.findAll()).toHaveLength(1);
    expect(graphs.findNodeById("node")?.taskId).toBeUndefined();
  });
  it("rolls back task creation when its durable node link cannot commit", () => {
    const admission = claim();
    manager
      .getDatabase()
      .exec(
        "CREATE TRIGGER refuse_graph_link BEFORE UPDATE OF task_id ON orchestration_graph_nodes BEGIN SELECT RAISE(ABORT,'link interrupted'); END",
      );
    expect(() =>
      tasks.create({ title: "Late", prompt: "Late", workspaceId, status: "paused" }, admission),
    ).toThrow("link interrupted");
    expect(tasks.findAll()).toHaveLength(1);
  });
  it("rejects stale claims, foreign workspaces and duplicate admission", () => {
    const admission = claim();
    expect(() =>
      tasks.create(
        { title: "Bad", prompt: "Bad", workspaceId, status: "paused" },
        { ...admission, claimId: "stale" },
      ),
    ).toThrow("claim changed");
    expect(() =>
      tasks.create(
        { title: "Bad", prompt: "Bad", workspaceId: "foreign", status: "paused" },
        admission,
      ),
    ).toThrow("admission is closed");
    tasks.create({ title: "Local", prompt: "Local", workspaceId, status: "paused" }, admission);
    expect(() =>
      tasks.create(
        { title: "Duplicate", prompt: "Duplicate", workspaceId, status: "paused" },
        admission,
      ),
    ).toThrow("already linked");
    expect(tasks.findAll()).toHaveLength(2);
  });
  for (const timing of ["before", "after"] as const) {
    it(`closes a real engine dispatch ${timing} task admission without a late broad cancellation`, async () => {
      let entered = false,
        release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cancel = vi.fn(async () => {});
      const create = async (
        params: Parameters<
          import("../OrchestrationGraphEngine").OrchestrationGraphEngineDeps["createRootTask"]
        >[0],
      ) => {
        if (timing === "before") {
          entered = true;
          await gate;
        }
        const task = tasks.create(
          {
            title: params.title,
            prompt: params.prompt,
            workspaceId: params.workspaceId,
            status: "paused",
          },
          params.graphAdmission,
        );
        if (timing === "after") {
          entered = true;
          await gate;
        }
        return task;
      };
      const engine = new OrchestrationGraphEngine(manager.getDatabase(), {
        createRootTask: create,
        createChildTask: create,
        getTaskById: async (id) => tasks.findById(id),
        cancelTask: cancel,
        getActiveAgentRoles: () => [],
      });
      const creating = engine.createRun({
        rootTaskId: root,
        workspaceId,
        kind: "delegation",
        maxParallel: 1,
        nodes: [
          {
            key: "local",
            title: "Local",
            prompt: "Fixture",
            kind: "child_task",
            dispatchTarget: "local_role",
          },
        ],
      });
      await vi.waitFor(() => expect(entered).toBe(true));
      const store = new BotWorkControlStore(manager.getDatabase());
      const request = {
        scope: { workspaceId, agentRoleId: botId },
        requestId: "race-stop",
        action: "stop_turn" as const,
        taskId: root,
      };
      const receipt = store.begin(request, Date.now());
      for (const item of receipt.tasks) tasks.update(item.taskId, { status: "cancelled" });
      store.syncGraphs(
        { scope: request.scope, requestId: request.requestId },
        receipt.tasks.map((item) => item.taskId),
      );
      release();
      const snapshot = await creating;
      expect(snapshot.run.status).toBe("cancelled");
      expect(cancel).not.toHaveBeenCalled();
      expect(tasks.findAll()).toHaveLength(timing === "after" ? 2 : 1);
      expect(snapshot.nodes[0].status).toBe(timing === "after" ? "cancelled" : "failed");
    });
  }
});
