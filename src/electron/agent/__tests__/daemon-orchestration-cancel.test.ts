import Database from "better-sqlite3";
import { createServer, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import { getACPRegistry } from "../../acp";
import { OrchestrationGraphEngine } from "../orchestration/OrchestrationGraphEngine";

function createGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE orchestration_graph_runs (
      id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, max_parallel INTEGER NOT NULL,
      metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE orchestration_graph_nodes (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_key TEXT NOT NULL, title TEXT NOT NULL,
      prompt TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, dispatch_target TEXT NOT NULL,
      worker_role TEXT, parent_task_id TEXT, assigned_agent_role_id TEXT, capability_hint TEXT,
      acp_agent_id TEXT, agent_config TEXT, task_id TEXT, remote_task_id TEXT, public_handle TEXT,
      summary TEXT, output TEXT, error TEXT, team_run_id TEXT, team_item_id TEXT,
      workflow_phase_id TEXT, acp_task_id TEXT, metadata TEXT, verification_verdict TEXT,
      verification_report TEXT, semantic_summary TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
    );
    CREATE TABLE orchestration_graph_edges (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL
    );
    CREATE TABLE orchestration_graph_node_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload TEXT, created_at INTEGER NOT NULL
    );
  `);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${milliseconds}ms`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer!));
}

describe("AgentDaemon.cancelTask graph coordination", () => {
  let db: Database.Database;
  let server: Server;
  let agentId: string | undefined;
  const pendingCancelResponses: Array<{ response: ServerResponse; id: string; taskId: string }> =
    [];
  const cancelRequestsStarted = deferred<void>();
  const parentExecutorStopped = deferred<void>();

  beforeEach(() => {
    db = new Database(":memory:");
    createGraphSchema(db);
  });

  afterEach(async () => {
    for (const pending of pendingCancelResponses.splice(0)) pending.response.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (agentId) getACPRegistry().unregisterRemoteAgent(agentId);
    agentId = undefined;
    db.close();
  });

  it("stops the parent and closes every graph run before remote cancel replies arrive", async () => {
    let nextRemoteTask = 0;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: string;
        method: string;
        params: { title?: string; taskId?: string };
      };
      if (payload.method === "tasks/send") {
        const taskId = `remote-task-${++nextRemoteTask}`;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { status: "running", taskId },
          }),
        );
        return;
      }
      if (payload.method === "tasks/cancel") {
        pendingCancelResponses.push({
          response,
          id: payload.id,
          taskId: payload.params.taskId || "unknown-task",
        });
        if (pendingCancelResponses.length === 2) cancelRequestsStarted.resolve();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { status: "running" },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const agent = getACPRegistry().registerRemoteAgent({
      name: `deferred-parent-cancel-${Date.now()}`,
      description: "Local test ACP endpoint",
      endpoint,
      capabilities: [],
    });
    agentId = agent.id;
    const graph = new OrchestrationGraphEngine(db, {
      createChildTask: async () => {
        throw new Error("unexpected local child dispatch");
      },
      createRootTask: async () => {
        throw new Error("unexpected local root dispatch");
      },
      getTaskById: async () => undefined,
      cancelTask: async () => {},
      getActiveAgentRoles: () => [],
    });
    for (const key of ["first-run-node", "second-run-node"]) {
      await graph.createRun({
        rootTaskId: "parent-task",
        workspaceId: "workspace-1",
        kind: "acp",
        maxParallel: 1,
        nodes: [
          {
            key,
            title: key,
            prompt: "A disposable remote task",
            kind: "acp_task",
            dispatchTarget: "remote_acp",
            acpAgentId: agent.id,
          },
        ],
      });
    }

    const rootTask = {
      id: "parent-task",
      title: "Parent",
      prompt: "Parent prompt",
      status: "executing",
      workspaceId: "workspace-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const cancelTaskRecord = vi.fn();
    const logEvent = vi.fn();
    const executorCancel = vi.fn(async () => parentExecutorStopped.resolve());
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue(rootTask),
        findByParent: vi.fn().mockReturnValue([]),
      },
      orchestrationGraphEngine: graph,
      pendingContinuationTaskIds: new Set([rootTask.id]),
      logEvent,
      queueManager: { cancelQueuedTask: vi.fn().mockReturnValue(false) },
      activeTasks: new Map([[rootTask.id, { executor: { cancel: executorCancel } }]]),
      cancelTaskRecord,
      finishQueueSlot: vi.fn(),
      pendingTaskImages: new Map(),
    }) as Any;

    const cancelPromise = AgentDaemon.prototype.cancelTask.call(daemonLike, rootTask.id);
    await withDeadline(
      Promise.all([cancelRequestsStarted.promise, parentExecutorStopped.promise]),
      3000,
    );

    const runsWhileRemoteCancelIsPending = await graph
      .getRepository()
      .listSnapshotsByRootTaskId(rootTask.id);
    expect(runsWhileRemoteCancelIsPending).toHaveLength(2);
    expect(
      runsWhileRemoteCancelIsPending.every((snapshot) => snapshot.run.status === "cancelled"),
    ).toBe(true);
    expect(cancelTaskRecord).toHaveBeenCalledWith(rootTask.id, "Task was stopped by user");
    expect(executorCancel).toHaveBeenCalledWith("user");

    await graph.appendNodes({
      runId: runsWhileRemoteCancelIsPending[0].run.id,
      nodes: [
        {
          key: "must-not-admit",
          title: "Must not run",
          prompt: "A late append after cancellation",
          kind: "acp_task",
          dispatchTarget: "remote_acp",
        },
      ],
    });
    expect(
      (await graph.getRepository().findSnapshotByRunId(runsWhileRemoteCancelIsPending[0].run.id))
        ?.nodes,
    ).toHaveLength(1);

    for (const pending of pendingCancelResponses) {
      pending.response.writeHead(200, { "content-type": "application/json" });
      pending.response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: pending.id,
          result: { status: "running", taskId: pending.taskId },
        }),
      );
    }
    await withDeadline(cancelPromise, 5000);

    const settled = await graph.getRepository().listSnapshotsByRootTaskId(rootTask.id);
    expect(settled.every((snapshot) => snapshot.run.status === "cancelled")).toBe(true);
    expect(settled.every((snapshot) => snapshot.nodes[0].status === "blocked")).toBe(true);
    expect(daemonLike.pendingContinuationTaskIds.has(rootTask.id)).toBe(false);
  });

  it.each([
    ["queued", "user"],
    ["executing", "external_runtime"],
  ] as const)("cancels graph descendants for %s parent cancellation", async (status, path) => {
    const requestMethods: string[] = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: string;
        method: string;
      };
      requestMethods.push(payload.method);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result:
            payload.method === "tasks/cancel"
              ? { status: "cancelled", taskId: "remote-path-task" }
              : { status: "running", taskId: "remote-path-task" },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const agent = getACPRegistry().registerRemoteAgent({
      name: `parent-cancel-path-${Date.now()}`,
      description: "Local test ACP endpoint",
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      capabilities: [],
    });
    agentId = agent.id;
    const graph = new OrchestrationGraphEngine(db, {
      createChildTask: async () => {
        throw new Error("unexpected local child dispatch");
      },
      createRootTask: async () => {
        throw new Error("unexpected local root dispatch");
      },
      getTaskById: async () => undefined,
      cancelTask: async () => {},
      getActiveAgentRoles: () => [],
    });
    await graph.createRun({
      rootTaskId: "parent-path-task",
      workspaceId: "workspace-1",
      kind: "acp",
      maxParallel: 1,
      nodes: [
        {
          key: "remote-path-node",
          title: "Remote descendant",
          prompt: "A disposable remote child",
          kind: "acp_task",
          dispatchTarget: "remote_acp",
          acpAgentId: agent.id,
        },
      ],
    });

    const rootTask = {
      id: "parent-path-task",
      title: "Parent",
      prompt: "Parent prompt",
      status,
      workspaceId: "workspace-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const cancelTaskRecord = vi.fn();
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue(rootTask),
        findByParent: vi.fn().mockReturnValue([]),
      },
      orchestrationGraphEngine: graph,
      pendingContinuationTaskIds: new Set([rootTask.id]),
      logEvent: vi.fn(),
      queueManager: { cancelQueuedTask: vi.fn().mockReturnValue(status === "queued") },
      activeTasks: new Map(),
      cancelTaskRecord,
      finishQueueSlot: vi.fn(),
      pendingTaskImages: new Map(),
    }) as Any;

    if (path === "user") {
      await AgentDaemon.prototype.cancelTask.call(daemonLike, rootTask.id);
    } else {
      AgentDaemon.prototype.recordExternalTaskCancellation.call(
        daemonLike,
        rootTask.id,
        "The parent runtime reported cancellation",
      );
    }

    await vi.waitFor(async () => {
      const snapshot = await graph.getRepository().findSnapshotByRootTaskId(rootTask.id);
      expect(snapshot?.run.status).toBe("cancelled");
      expect(snapshot?.nodes[0]).toMatchObject({
        status: "cancelled",
        remoteTaskId: "remote-path-task",
        metadata: { cancellation: { outcome: "acknowledged", ownership: "remote" } },
      });
    });
    expect(requestMethods).toContain("tasks/cancel");
    expect(daemonLike.pendingContinuationTaskIds.has(rootTask.id)).toBe(false);
    if (path === "user") {
      expect(cancelTaskRecord).toHaveBeenCalledWith(rootTask.id, "Task removed from queue");
    } else {
      expect(cancelTaskRecord).toHaveBeenCalledWith(
        rootTask.id,
        "The parent runtime reported cancellation",
      );
    }
  });
});
