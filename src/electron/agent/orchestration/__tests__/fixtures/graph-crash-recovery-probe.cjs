const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const repoRoot = process.cwd();
const enginePath = path.join(
  repoRoot,
  "dist/electron/electron/agent/orchestration/OrchestrationGraphEngine.js",
);
const handlerPath = path.join(repoRoot, "dist/electron/electron/acp/handler.js");
const evidencePath =
  process.env.P05_EVIDENCE_PATH || path.join(os.tmpdir(), "p05-graph-crash-reopen.json");
const workerSource = `
  const Database = require("better-sqlite3");
  const path = require("node:path");
  const { OrchestrationGraphEngine } = require(${JSON.stringify(enginePath)});
  const { getACPRegistry } = require(${JSON.stringify(handlerPath)});
  const db = new Database(process.env.P05_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const registry = getACPRegistry(db);
  const agent = registry.registerRemoteAgent({
    name: "P05 fake remote",
    description: "A loopback endpoint used for the graph crash-recovery probe",
    endpoint: process.env.P05_ENDPOINT,
    icon: "test",
    capabilities: [],
  });
  const engine = new OrchestrationGraphEngine(db, {
    createChildTask: async () => { throw new Error("unexpected local dispatch"); },
    createRootTask: async () => { throw new Error("unexpected local dispatch"); },
    getTaskById: async () => undefined,
    cancelTask: async () => {},
    getActiveAgentRoles: () => [],
  });
  engine.createRun({
    rootTaskId: "p05-crash-root",
    workspaceId: "p05-crash-workspace",
    kind: "acp",
    maxParallel: 1,
    nodes: [{
      key: "remote-effect",
      title: "Create one fake remote effect",
      prompt: "This is a disposable local probe.",
      kind: "acp_task",
      dispatchTarget: "remote_acp",
      acpAgentId: agent.id,
    }],
  }).catch((error) => {
    process.stderr.write(String(error && error.stack || error));
    process.exitCode = 1;
  });
`;
const cancellationWorkerSource = `
  const Database = require("better-sqlite3");
  const { OrchestrationGraphEngine } = require(${JSON.stringify(enginePath)});
  const { getACPRegistry } = require(${JSON.stringify(handlerPath)});
  const db = new Database(process.env.P05_CANCEL_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const registry = getACPRegistry(db);
  const agent = registry.registerRemoteAgent({
    name: "P05 fake cancellation remote",
    description: "A loopback endpoint used for the graph cancellation crash probe",
    endpoint: process.env.P05_ENDPOINT,
    icon: "test",
    capabilities: [],
  });
  const engine = new OrchestrationGraphEngine(db, {
    createChildTask: async () => { throw new Error("unexpected local dispatch"); },
    createRootTask: async () => { throw new Error("unexpected local dispatch"); },
    getTaskById: async () => undefined,
    cancelTask: async () => {},
    getActiveAgentRoles: () => [],
  });
  (async () => {
    await engine.createRun({
      rootTaskId: "p05-cancel-crash-root",
      workspaceId: "p05-cancel-workspace",
      kind: "acp",
      maxParallel: 1,
      nodes: [{
        key: "remote-cancel-effect",
        title: "Cancel one fake remote effect",
        prompt: "This is a disposable local cancellation probe.",
        kind: "acp_task",
        dispatchTarget: "remote_acp",
        acpAgentId: agent.id,
      }],
    });
    await engine.cancelRunForRootTask("p05-cancel-crash-root");
  })().catch((error) => {
    process.stderr.write(String(error && error.stack || error));
    process.exitCode = 1;
  });
`;

function createSchema(db) {
  db.exec(`
    CREATE TABLE acp_agents (
      id TEXT PRIMARY KEY, origin TEXT NOT NULL, endpoint TEXT, name TEXT NOT NULL,
      provider TEXT, status TEXT NOT NULL, registered_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, card_json TEXT NOT NULL
    );
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
      acp_task_id TEXT, metadata TEXT, verification_verdict TEXT,
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

function withDeadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return withDeadline(
    new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    }),
    milliseconds,
    "owned probe process exit",
  );
}

async function main() {
  assert.ok(fs.existsSync(enginePath), `Missing built graph engine at ${enginePath}`);
  assert.ok(fs.existsSync(handlerPath), `Missing built ACP handler at ${handlerPath}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-p05-crash-probe-"));
  const dbPath = path.join(tempDir, "graph.db");
  const effects = new Map();
  const methods = [];
  const pendingResponses = new Set();
  const cancellationEffects = [];
  let resolveEffect;
  const effectCreated = new Promise((resolve) => {
    resolveEffect = resolve;
  });
  let resolveCancelEffect;
  const cancelEffectCreated = new Promise((resolve) => {
    resolveCancelEffect = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    methods.push(payload.method);
    if (payload.method === "tasks/send") {
      const cancellationProbe = payload.params.workspaceId === "p05-cancel-workspace";
      const taskId = cancellationProbe ? "fake-remote-cancel-1" : "fake-remote-effect-1";
      effects.set(taskId, { title: payload.params.title, prompt: payload.params.prompt });
      resolveEffect(taskId);
      if (cancellationProbe) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { status: "running", taskId },
          }),
        );
      } else {
        pendingResponses.add(response);
      }
      return;
    }
    if (payload.method === "tasks/cancel") {
      cancellationEffects.push(payload.params.taskId);
      pendingResponses.add(response);
      resolveCancelEffect(payload.params.taskId);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: { status: "running", taskId: "fake-remote-effect-1" },
      }),
    );
  });
  await withDeadline(
    new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    3000,
    "fake ACP listen",
  );
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let db;
  let child;
  try {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    createSchema(db);
    db.close();
    db = undefined;

    child = spawn(process.execPath, ["-e", workerSource], {
      cwd: repoRoot,
      env: {
        ...process.env,
        P05_DB_PATH: dbPath,
        P05_ENDPOINT: endpoint,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code, signal) => {
      if (code !== null && code !== 0 && signal === null) {
        process.stderr.write(stderr);
      }
    });

    const effectId = await withDeadline(effectCreated, 7000, "fake ACP effect creation");
    assert.equal(effects.size, 1, "the local fake endpoint should have one created effect");
    child.kill("SIGKILL");
    await waitForExit(child, 5000);
    child = undefined;

    db = new Database(dbPath);
    db.pragma("busy_timeout = 5000");
    const { OrchestrationGraphEngine } = require(enginePath);
    let repeatedInvocations = 0;
    const recovered = new OrchestrationGraphEngine(db, {
      createChildTask: async () => {
        repeatedInvocations += 1;
        return { id: "unexpected-local-child", status: "queued" };
      },
      createRootTask: async () => {
        repeatedInvocations += 1;
        return { id: "unexpected-root", status: "queued" };
      },
      getTaskById: async () => undefined,
      cancelTask: async () => {},
      getActiveAgentRoles: () => [],
    });
    await withDeadline(recovered.resumeRunningRuns(), 5000, "graph recovery after process kill");
    const snapshot = recovered.getRepository().findSnapshotByRootTaskId("p05-crash-root");
    assert.equal(snapshot?.nodes.length, 1);
    assert.equal(snapshot.nodes[0].status, "blocked");
    assert.equal(snapshot.nodes[0].remoteTaskId, undefined);
    assert.equal(snapshot.nodes[0].metadata?.dispatchOutcome, "unknown");
    assert.equal(repeatedInvocations, 0, "recovery must not dispatch the effect again");
    assert.deepEqual(
      methods,
      ["tasks/send"],
      "recovery must not contact the fake ACP endpoint again",
    );

    const evidence = {
      result: "passed",
      proof:
        "production graph engine and repository reopened the same SQLite database after SIGKILL",
      effectId,
      fakeAcpRequests: methods.slice(),
      repeatedInvocations,
      recoveredRunStatus: snapshot.run.status,
      recoveredNodeStatus: snapshot.nodes[0].status,
      recoveredDispatchOutcome: snapshot.nodes[0].metadata?.dispatchOutcome,
      recoveredRemoteTaskId: snapshot.nodes[0].remoteTaskId || null,
      ownedProcessSignal: "SIGKILL",
    };

    const cancellationDbPath = path.join(tempDir, "cancelled-graph.db");
    db.close();
    db = new Database(cancellationDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    createSchema(db);
    db.close();
    db = undefined;

    child = spawn(process.execPath, ["-e", cancellationWorkerSource], {
      cwd: repoRoot,
      env: {
        ...process.env,
        P05_CANCEL_DB_PATH: cancellationDbPath,
        P05_ENDPOINT: endpoint,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let cancellationStderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      cancellationStderr += chunk;
    });
    child.once("exit", (code, signal) => {
      if (code !== null && code !== 0 && signal === null) {
        process.stderr.write(cancellationStderr);
      }
    });

    const cancelledEffectId = await withDeadline(
      cancelEffectCreated,
      7000,
      "fake ACP cancellation effect",
    );
    assert.equal(cancelledEffectId, "fake-remote-cancel-1");
    assert.deepEqual(cancellationEffects, [cancelledEffectId]);
    child.kill("SIGKILL");
    await waitForExit(child, 5000);
    child = undefined;

    db = new Database(cancellationDbPath);
    db.pragma("busy_timeout = 5000");
    const recoveredCancellation = new OrchestrationGraphEngine(db, {
      createChildTask: async () => {
        throw new Error("recovery must not dispatch after a cancelled run");
      },
      createRootTask: async () => {
        throw new Error("recovery must not dispatch after a cancelled run");
      },
      getTaskById: async () => undefined,
      cancelTask: async () => {
        throw new Error("recovery must not reissue local cancellation");
      },
      getActiveAgentRoles: () => [],
    });
    await withDeadline(
      recoveredCancellation.resumeRunningRuns(),
      5000,
      "cancellation recovery after process kill",
    );
    const cancellationSnapshot = recoveredCancellation
      .getRepository()
      .findSnapshotByRootTaskId("p05-cancel-crash-root");
    assert.equal(cancellationSnapshot?.run.status, "cancelled");
    assert.equal(cancellationSnapshot?.nodes[0].status, "blocked");
    assert.equal(cancellationSnapshot?.nodes[0].remoteTaskId, cancelledEffectId);
    assert.equal(cancellationSnapshot?.nodes[0].metadata?.cancellation?.outcome, "unresolved");
    assert.match(cancellationSnapshot?.nodes[0].error || "", /interrupted/i);
    assert.deepEqual(
      cancellationEffects,
      [cancelledEffectId],
      "recovery must not repeat a cancellation whose response was lost",
    );
    assert.deepEqual(
      methods,
      ["tasks/send", "tasks/send", "tasks/cancel"],
      "recovery must not contact the fake ACP endpoint again",
    );
    evidence.cancellationCrash = {
      proof:
        "production graph engine and repository reopened the same SQLite database after SIGKILL",
      effectId: cancelledEffectId,
      fakeAcpRequests: methods.slice(1),
      cancellationEffects,
      recoveredRunStatus: cancellationSnapshot.run.status,
      recoveredNodeStatus: cancellationSnapshot.nodes[0].status,
      recoveredCancellationOutcome: cancellationSnapshot.nodes[0].metadata?.cancellation?.outcome,
      recoveredCancellationError: cancellationSnapshot.nodes[0].error,
      recoveredRemoteTaskId: cancellationSnapshot.nodes[0].remoteTaskId,
      ownedProcessSignal: "SIGKILL",
    };

    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath })}\n`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, 5000).catch(() => {});
    }
    for (const response of pendingResponses) response.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (db?.open) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
