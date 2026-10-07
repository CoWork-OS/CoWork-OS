import Database from "better-sqlite3";
import { createServer, type Server } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Task } from "../../../../shared/types";
import { getACPRegistry } from "../../../acp";
import { OrchestrationGraphEngine } from "../OrchestrationGraphEngine";
import type { OrchestrationGraphEngineDeps } from "../OrchestrationGraphEngine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    const probe = new module.default(":memory:");
    probe.close();
    return true;
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

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

function makeTask(id: string, status: Task["status"] = "queued", parentTaskId?: string): Task {
  return {
    id,
    title: id,
    prompt: "task prompt",
    status,
    workspaceId: "workspace-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    parentTaskId,
  };
}

function makeNode(key: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    title: `Task ${key}`,
    prompt: `Do ${key}`,
    kind: "child_task" as const,
    dispatchTarget: "native_child_task" as const,
    ...extra,
  };
}

function makeDeps(overrides: Partial<OrchestrationGraphEngineDeps> = {}) {
  const tasks = new Map<string, Task>();
  let nextTaskId = 0;
  const deps: OrchestrationGraphEngineDeps = {
    createChildTask: vi.fn(async (params) => {
      const task = makeTask(`child-${++nextTaskId}`, "queued", params.parentTaskId);
      tasks.set(task.id, task);
      return task;
    }),
    createRootTask: vi.fn(async () => {
      const task = makeTask(`root-${++nextTaskId}`, "queued");
      tasks.set(task.id, task);
      return task;
    }),
    getTaskById: vi.fn(async (taskId) => tasks.get(taskId)),
    cancelTask: vi.fn(async (taskId) => {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      tasks.set(taskId, { ...task, status: "cancelled" });
    }),
    getActiveAgentRoles: vi.fn(() => []),
    ...overrides,
  };
  return { deps, tasks };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function startRemoteAgent(statusForCancel: () => string): Promise<{
  server: Server;
  endpoint: string;
  requests: string[];
}> {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: string;
      method: string;
    };
    requests.push(payload.method);
    const result =
      payload.method === "tasks/cancel"
        ? { status: statusForCancel(), taskId: "remote-task-1" }
        : { status: "running", taskId: "remote-task-1" };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${address.port}`, requests };
}

async function startRemoteAgentWithDeferredCancel(): Promise<{
  server: Server;
  endpoint: string;
  requests: string[];
  cancelStarted: Promise<void>;
  resolveCancel: (status: string) => void;
}> {
  const requests: string[] = [];
  const cancelStarted = deferred<void>();
  const cancelResult = deferred<string>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: string;
      method: string;
    };
    requests.push(payload.method);
    if (payload.method === "tasks/cancel") {
      cancelStarted.resolve();
      const status = await cancelResult.promise;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { status, taskId: "remote-task-1" },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: { status: "running", taskId: "remote-task-1" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    cancelStarted: cancelStarted.promise,
    resolveCancel: cancelResult.resolve,
  };
}

describeWithSqlite("OrchestrationGraphEngine dispatch and cancellation recovery", () => {
  let db: Database.Database;
  let tempDir: string;
  const registeredAgentIds: string[] = [];
  const servers: Server[] = [];
  const additionalDatabases: Database.Database[] = [];

  beforeEach(() => {
    db = new Database(":memory:");
    createGraphSchema(db);
    tempDir = mkdtempSync(path.join(tmpdir(), "cowork-graph-recovery-"));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const id of registeredAgentIds.splice(0)) {
      getACPRegistry().unregisterRemoteAgent(id);
    }
    for (const additionalDb of additionalDatabases.splice(0)) {
      if (additionalDb.open) additionalDb.close();
    }
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not dispatch another graph effect after persisted root stop", async () => {
    db.exec("CREATE TABLE bot_task_stop_intents(task_id TEXT PRIMARY KEY,active INTEGER NOT NULL)");
    db.prepare("INSERT INTO bot_task_stop_intents(task_id,active) VALUES('stopped-root',1)").run();
    const { deps } = makeDeps();
    const engine = new OrchestrationGraphEngine(db, deps);
    const result = await engine.createRun({
      rootTaskId: "stopped-root",
      workspaceId: "workspace-1",
      kind: "test",
      maxParallel: 1,
      nodes: [makeNode("next-local")],
    });
    expect(deps.createChildTask).not.toHaveBeenCalled();
    expect(deps.createRootTask).not.toHaveBeenCalled();
    expect(result.nodes[0].status).toBe("failed");
  });
  it("admits a ready node once across two engines sharing the database", async () => {
    const dbPath = path.join(tempDir, "graph.db");
    const dbA = new Database(dbPath);
    additionalDatabases.push(dbA);
    createGraphSchema(dbA);
    dbA.pragma("busy_timeout = 5000");
    const dbB = new Database(dbPath);
    additionalDatabases.push(dbB);
    dbB.pragma("busy_timeout = 5000");
    const createStarted = deferred<void>();
    const createResult = deferred<Task>();
    const depsA = makeDeps({
      createChildTask: vi.fn(() => {
        createStarted.resolve();
        return createResult.promise;
      }),
    });
    const depsB = makeDeps();
    const engineA = new OrchestrationGraphEngine(dbA, depsA.deps);
    const engineB = new OrchestrationGraphEngine(dbB, depsB.deps);

    const createRun = engineA.createRun({
      rootTaskId: "root-atomic",
      workspaceId: "workspace-1",
      kind: "delegation",
      maxParallel: 1,
      nodes: [makeNode("only")],
    });
    await createStarted.promise;
    const runId = String(dbA.prepare("SELECT id FROM orchestration_graph_runs").pluck().get());

    await engineB.tickRun(runId);

    expect(depsA.deps.createChildTask).toHaveBeenCalledTimes(1);
    expect(depsB.deps.createChildTask).not.toHaveBeenCalled();

    createResult.resolve(makeTask("child-atomic", "queued", "root-atomic"));
    const snapshot = await createRun;
    expect(snapshot.nodes[0]).toMatchObject({ status: "running", taskId: "child-atomic" });
    expect(snapshot.nodes[0].metadata).toMatchObject({
      dispatchClaim: { phase: "identity_persisted", taskId: "child-atomic" },
    });
  });

  it("keeps a committed remote send with a dropped response blocked and unknown", async () => {
    const methods: string[] = [];
    const effects: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: string;
        method: string;
      };
      methods.push(payload.method);
      if (payload.method === "tasks/send") {
        effects.push("fake-remote-effect-1");
        response.destroy();
        return;
      }
      effects.push("unexpected-second-effect");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { status: "running", taskId: "fake-remote-effect-2" },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const agent = getACPRegistry().registerRemoteAgent({
      name: `send-response-loss-${Date.now()}`,
      description: "Local fake ACP endpoint that commits then drops its response",
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      capabilities: [],
    });
    registeredAgentIds.push(agent.id);

    const engine = new OrchestrationGraphEngine(db, makeDeps().deps);
    const snapshot = await engine.createRun({
      rootTaskId: "root-send-response-loss",
      workspaceId: "workspace-1",
      kind: "acp",
      maxParallel: 1,
      nodes: [
        makeNode("remote-send", {
          kind: "acp_task",
          dispatchTarget: "remote_acp",
          acpAgentId: agent.id,
        }),
      ],
    });

    expect(methods).toEqual(["tasks/send"]);
    expect(effects).toEqual(["fake-remote-effect-1"]);
    expect(snapshot.nodes[0]).toMatchObject({
      status: "blocked",
      metadata: { dispatchOutcome: "unknown", dispatchClaim: { phase: "unknown" } },
    });
  });

  it("cancels an effect returned after parent cancellation without restoring running state", async () => {
    const createStarted = deferred<void>();
    const createResult = deferred<Task>();
    const { deps, tasks } = makeDeps({
      createChildTask: vi.fn(() => {
        createStarted.resolve();
        return createResult.promise;
      }),
    });
    const engine = new OrchestrationGraphEngine(db, deps);
    const createRun = engine.createRun({
      rootTaskId: "root-cancel-race",
      workspaceId: "workspace-1",
      kind: "delegation",
      maxParallel: 1,
      nodes: [makeNode("late-child")],
    });
    await createStarted.promise;

    await engine.cancelRunForRootTask("root-cancel-race");
    createResult.resolve(makeTask("child-late", "queued", "root-cancel-race"));
    tasks.set("child-late", makeTask("child-late", "queued", "root-cancel-race"));
    await createRun;

    const snapshot = await engine.getRepository().findSnapshotByRootTaskId("root-cancel-race");
    expect(deps.cancelTask).toHaveBeenCalledWith("child-late");
    expect(snapshot?.run.status).toBe("cancelled");
    expect(snapshot?.nodes[0]).toMatchObject({ status: "cancelled", taskId: "child-late" });
    expect(snapshot?.nodes[0].metadata).toMatchObject({
      cancellation: { ownership: "local", outcome: "acknowledged" },
    });
  });

  it("leaves a remote node blocked when cancellation is pending rather than acknowledged", async () => {
    const remote = await startRemoteAgent(() => "running");
    servers.push(remote.server);
    const agent = getACPRegistry().registerRemoteAgent({
      name: `pending-cancel-${Date.now()}`,
      description: "Local test ACP endpoint",
      endpoint: remote.endpoint,
      capabilities: [],
    });
    registeredAgentIds.push(agent.id);
    const engine = new OrchestrationGraphEngine(db, makeDeps().deps);
    await engine.createRun({
      rootTaskId: "root-remote-cancel",
      workspaceId: "workspace-1",
      kind: "acp",
      maxParallel: 1,
      nodes: [makeNode("remote", { dispatchTarget: "remote_acp", acpAgentId: agent.id })],
    });

    const cancelled = await engine.cancelHandle("root-remote-cancel", "remote-task-1");
    const snapshot = await engine.getRepository().findSnapshotByRootTaskId("root-remote-cancel");

    expect(cancelled).toBe(false);
    expect(remote.requests).toEqual(["tasks/send", "tasks/cancel"]);
    expect(snapshot?.nodes[0]).toMatchObject({ status: "blocked", remoteTaskId: "remote-task-1" });
    expect(snapshot?.nodes[0].error).toMatch(/unresolved|not acknowledged/i);
  });

  it("closes graph admission before cancelling remote descendants", async () => {
    const remote = await startRemoteAgent(() => "running");
    servers.push(remote.server);
    const agent = getACPRegistry().registerRemoteAgent({
      name: `parent-cancel-${Date.now()}`,
      description: "Local test ACP endpoint",
      endpoint: remote.endpoint,
      capabilities: [],
    });
    registeredAgentIds.push(agent.id);
    const { deps } = makeDeps();
    const engine = new OrchestrationGraphEngine(db, deps);
    const snapshot = await engine.createRun({
      rootTaskId: "root-parent-remote-cancel",
      workspaceId: "workspace-1",
      kind: "acp",
      maxParallel: 1,
      nodes: [makeNode("remote", { dispatchTarget: "remote_acp", acpAgentId: agent.id })],
    });

    const outcome = await engine.cancelRunForRootTask("root-parent-remote-cancel");
    await engine.appendNodes({ runId: snapshot.run.id, nodes: [makeNode("late-node")] });
    const after = await engine.getRepository().findSnapshotByRunId(snapshot.run.id);

    expect(outcome.unresolvedNodeIds).toContain(snapshot.nodes[0].id);
    expect(after?.run.status).toBe("cancelled");
    expect(after?.nodes.map((node) => node.key)).toEqual(["remote"]);
    expect(after?.nodes[0]).toMatchObject({ status: "blocked", remoteTaskId: "remote-task-1" });
    expect(deps.createChildTask).not.toHaveBeenCalled();
    expect(remote.requests).toEqual(["tasks/send", "tasks/cancel"]);
  });

  it("does not claim remote cancellation when the agent is missing", async () => {
    const remote = await startRemoteAgent(() => "cancelled");
    servers.push(remote.server);
    const agent = getACPRegistry().registerRemoteAgent({
      name: `missing-agent-${Date.now()}`,
      description: "Local test ACP endpoint",
      endpoint: remote.endpoint,
      capabilities: [],
    });
    registeredAgentIds.push(agent.id);
    const engine = new OrchestrationGraphEngine(db, makeDeps().deps);
    await engine.createRun({
      rootTaskId: "root-missing-agent",
      workspaceId: "workspace-1",
      kind: "acp",
      maxParallel: 1,
      nodes: [makeNode("remote", { dispatchTarget: "remote_acp", acpAgentId: agent.id })],
    });
    getACPRegistry().unregisterRemoteAgent(agent.id);

    expect(await engine.cancelHandle("root-missing-agent", "remote-task-1")).toBe(false);
    const node = (await engine.getRepository().findSnapshotByRootTaskId("root-missing-agent"))
      ?.nodes[0];
    expect(node).toMatchObject({ status: "blocked", remoteTaskId: "remote-task-1" });
    expect(node?.error).toMatch(/unavailable|missing/i);
    expect(remote.requests).toEqual(["tasks/send"]);
  });

  it("recovers a closed run whose node cancellation was never persisted as unresolved", async () => {
    const remote = await startRemoteAgent(() => "cancelled");
    servers.push(remote.server);
    const agent = getACPRegistry().registerRemoteAgent({
      name: `closed-before-cancel-attempt-${Date.now()}`,
      description: "Local test ACP endpoint",
      endpoint: remote.endpoint,
      capabilities: [],
    });
    registeredAgentIds.push(agent.id);
    const engine = new OrchestrationGraphEngine(db, makeDeps().deps);
    const snapshot = await engine.createRun({
      rootTaskId: "root-closed-before-cancel-attempt",
      workspaceId: "workspace-1",
      kind: "acp",
      maxParallel: 1,
      nodes: [
        makeNode("remote", { dispatchTarget: "remote_acp", acpAgentId: agent.id }),
        makeNode("never-dispatched"),
      ],
    });

    // Model process loss after run admission closes but before cancellation metadata is written.
    await engine.getRepository().cancelRunningRunsForRootTask("root-closed-before-cancel-attempt");
    const recovered = new OrchestrationGraphEngine(db, makeDeps().deps);
    await recovered.resumeRunningRuns();

    const after = await recovered.getRepository().findSnapshotByRunId(snapshot.run.id);
    expect(after?.run.status).toBe("cancelled");
    expect(after?.nodes[0]).toMatchObject({ status: "blocked", remoteTaskId: "remote-task-1" });
    expect(after?.nodes[0].metadata).toMatchObject({
      cancellation: { outcome: "unresolved", ownership: "remote" },
    });
    expect(after?.nodes[0].metadata?.cancellation).toHaveProperty("recoveredAt");
    expect(after?.nodes[0].error).toMatch(/before node cancellation was recorded/i);
    expect(after?.nodes[1]).toMatchObject({ status: "cancelled" });
    expect(remote.requests).toEqual(["tasks/send"]);
  });

  it("does not mark a live in-process cancellation interrupted during run recovery", async () => {
    const remote = await startRemoteAgentWithDeferredCancel();
    servers.push(remote.server);
    const agent = getACPRegistry().registerRemoteAgent({
      name: `active-cancel-recovery-${Date.now()}`,
      description: "Local test ACP endpoint",
      endpoint: remote.endpoint,
      capabilities: [],
    });
    registeredAgentIds.push(agent.id);
    const engine = new OrchestrationGraphEngine(db, makeDeps().deps);
    const snapshot = await engine.createRun({
      rootTaskId: "root-active-cancel-recovery",
      workspaceId: "workspace-1",
      kind: "acp",
      maxParallel: 1,
      nodes: [makeNode("remote", { dispatchTarget: "remote_acp", acpAgentId: agent.id })],
    });

    const cancellation = engine.cancelRunForRootTask("root-active-cancel-recovery");
    await remote.cancelStarted;
    await engine.resumeRunningRuns();
    const during = await engine.getRepository().findSnapshotByRunId(snapshot.run.id);
    expect(during?.nodes[0]).toMatchObject({ status: "running", remoteTaskId: "remote-task-1" });
    expect(during?.nodes[0].metadata).toMatchObject({ cancellation: { outcome: "in_flight" } });
    expect(remote.requests).toEqual(["tasks/send", "tasks/cancel"]);

    remote.resolveCancel("running");
    await cancellation;
    const after = await engine.getRepository().findSnapshotByRunId(snapshot.run.id);
    expect(after?.nodes[0]).toMatchObject({ status: "blocked", remoteTaskId: "remote-task-1" });
    expect(after?.nodes[0].metadata).toMatchObject({ cancellation: { outcome: "unresolved" } });
  });

  it.each([
    { responseStatus: "cancelled", expectedStatus: "cancelled", expectedOutcome: "acknowledged" },
    {
      responseStatus: "completed",
      expectedStatus: "completed",
      expectedOutcome: "already_terminal",
    },
  ])(
    "records remote cancellation response $responseStatus truthfully",
    async ({ responseStatus, expectedStatus, expectedOutcome }) => {
      const remote = await startRemoteAgent(() => responseStatus);
      servers.push(remote.server);
      const agent = getACPRegistry().registerRemoteAgent({
        name: `terminal-cancel-${Date.now()}-${responseStatus}`,
        description: "Local test ACP endpoint",
        endpoint: remote.endpoint,
        capabilities: [],
      });
      registeredAgentIds.push(agent.id);
      const engine = new OrchestrationGraphEngine(db, makeDeps().deps);
      await engine.createRun({
        rootTaskId: `root-${responseStatus}`,
        workspaceId: "workspace-1",
        kind: "acp",
        maxParallel: 1,
        nodes: [makeNode("remote", { dispatchTarget: "remote_acp", acpAgentId: agent.id })],
      });

      expect(await engine.cancelHandle(`root-${responseStatus}`, "remote-task-1")).toBe(true);
      const node = (await engine.getRepository().findSnapshotByRootTaskId(`root-${responseStatus}`))
        ?.nodes[0];
      expect(node).toMatchObject({ status: expectedStatus, remoteTaskId: "remote-task-1" });
      expect(node?.metadata).toMatchObject({
        cancellation: { outcome: expectedOutcome, resultStatus: responseStatus },
      });
    },
  );

  it("recovers an unidentifiable persisted dispatch as blocked instead of redispatching", async () => {
    const engine = new OrchestrationGraphEngine(db, makeDeps().deps);
    const snapshot = await engine.createRun({
      rootTaskId: "root-blocked-recovery",
      workspaceId: "workspace-1",
      kind: "delegation",
      maxParallel: 1,
      nodes: [makeNode("claimed")],
    });
    const node = snapshot.nodes[0];
    db.prepare(
      `UPDATE orchestration_graph_nodes SET status = 'running', task_id = NULL, remote_task_id = NULL
       WHERE id = ?`,
    ).run(node.id);
    const deps = makeDeps();
    const recovered = new OrchestrationGraphEngine(db, deps.deps);
    const notifications: Array<{ nodeId: string; status: string }> = [];
    recovered.on("node_notification", (notification) => notifications.push(notification));

    await recovered.resumeRunningRuns();

    expect(notifications).toEqual([
      expect.objectContaining({ nodeId: node.id, status: "blocked" }),
    ]);

    const after = await recovered.getRepository().findSnapshotByRunId(snapshot.run.id);
    expect(deps.deps.createChildTask).not.toHaveBeenCalled();
    expect(after?.nodes[0]).toMatchObject({ status: "blocked" });
    expect(after?.nodes[0].metadata).toMatchObject({ dispatchOutcome: "unknown" });
    expect(after?.nodes[0].error).toMatch(/identity|outcome is unknown/i);
  });

  it("notifies node listeners once when a dispatch error after the effect boundary blocks a node", async () => {
    const { deps } = makeDeps({
      createChildTask: vi.fn(() => Promise.reject(new Error("socket hang up"))),
    });
    const engine = new OrchestrationGraphEngine(db, deps);
    const notifications: Array<{ nodeId: string; status: string }> = [];
    engine.on("node_notification", (notification) => notifications.push(notification));

    const snapshot = await engine.createRun({
      rootTaskId: "root-dispatch-error",
      workspaceId: "workspace-1",
      kind: "delegation",
      maxParallel: 1,
      nodes: [makeNode("boom")],
    });

    expect(snapshot.nodes[0]).toMatchObject({ status: "blocked" });
    expect(notifications).toEqual([
      expect.objectContaining({ nodeId: snapshot.nodes[0].id, status: "blocked" }),
    ]);
  });

  it("preserves completed dependency behavior after persisted task recovery", async () => {
    const { deps, tasks } = makeDeps();
    const engine = new OrchestrationGraphEngine(db, deps);
    const snapshot = await engine.createRun({
      rootTaskId: "root-dependencies",
      workspaceId: "workspace-1",
      kind: "workflow",
      maxParallel: 1,
      nodes: [makeNode("first"), makeNode("second")],
      edges: [{ fromNodeKey: "first", toNodeKey: "second" }],
    });
    const first = snapshot.nodes.find((node) => node.key === "first");
    expect(first?.status).toBe("running");
    expect(snapshot.nodes.find((node) => node.key === "second")?.status).toBe("pending");

    tasks.set(first!.taskId!, { ...tasks.get(first!.taskId!)!, status: "completed" });
    const recovered = new OrchestrationGraphEngine(db, deps);
    await recovered.resumeRunningRuns();

    const afterRecovery = await recovered.getRepository().findSnapshotByRunId(snapshot.run.id);
    expect(afterRecovery?.nodes.find((node) => node.key === "first")?.status).toBe("completed");
    expect(afterRecovery?.nodes.find((node) => node.key === "second")?.status).toBe("running");
    expect(deps.createChildTask).toHaveBeenCalledTimes(2);
  });

  it("reopens a completed run when late nodes are appended and dispatches them", async () => {
    const { deps, tasks } = makeDeps();
    const engine = new OrchestrationGraphEngine(db, deps);
    const snapshot = await engine.createRun({
      rootTaskId: "root-reopen",
      workspaceId: "workspace-1",
      kind: "team",
      maxParallel: 2,
      nodes: [makeNode("lane")],
    });
    const lane = snapshot.nodes.find((node) => node.key === "lane");
    expect(lane?.status).toBe("running");

    tasks.set(lane!.taskId!, { ...tasks.get(lane!.taskId!)!, status: "completed" });
    await engine.tickRun(snapshot.run.id);
    const finished = await engine.getRepository().findSnapshotByRunId(snapshot.run.id);
    expect(finished?.run.status).toBe("completed");

    const appended = await engine.appendNodes({
      runId: snapshot.run.id,
      nodes: [makeNode("synthesis", { kind: "synthesis" })],
      edges: [{ fromNodeId: lane!.id, toNodeKey: "synthesis" }],
    });
    const synthesis = appended?.nodes.find((node) => node.key === "synthesis");
    expect(appended?.run.status).toBe("running");
    expect(appended?.run.completedAt).toBeFalsy();
    expect(synthesis?.status).toBe("running");
    expect(synthesis?.taskId).toBeTruthy();
    expect(deps.createChildTask).toHaveBeenCalledTimes(2);

    tasks.set(synthesis!.taskId!, { ...tasks.get(synthesis!.taskId!)!, status: "completed" });
    await engine.tickRun(snapshot.run.id);
    const after = await engine.getRepository().findSnapshotByRunId(snapshot.run.id);
    expect(after?.run.status).toBe("completed");
    expect(after?.nodes.map((node) => node.status)).toEqual(["completed", "completed"]);
  });

  it("still refuses to append nodes to a cancelled run", async () => {
    const { deps } = makeDeps();
    const engine = new OrchestrationGraphEngine(db, deps);
    const snapshot = await engine.createRun({
      rootTaskId: "root-cancelled-append",
      workspaceId: "workspace-1",
      kind: "team",
      maxParallel: 1,
      nodes: [makeNode("lane")],
    });
    await engine.cancelRunForRootTask("root-cancelled-append");
    const appended = await engine.appendNodes({
      runId: snapshot.run.id,
      nodes: [makeNode("late")],
    });
    expect(appended?.run.status).toBe("cancelled");
    expect(appended?.nodes.map((node) => node.key)).toEqual(["lane"]);
  });
});
