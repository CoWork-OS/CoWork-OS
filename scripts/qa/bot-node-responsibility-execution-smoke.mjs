#!/usr/bin/env node
/**
 * Run a scoped Observe responsibility through the compiled Node-only daemon and
 * a deterministic loopback OpenAI-compatible provider. No Electron, real model,
 * or external channel is used.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const Database = require("better-sqlite3");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-node-responsibility-"));
const workspacePath = path.join(profile, "workspace");
const dbPath = path.join(profile, "cowork-os.db");
const selectedPath = "selected-evidence.txt";
const selectedContent = "Approved fixture evidence: the service window starts at 07:40 UTC.\n";
const childEnvironment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot", "LANG", "LC_ALL"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(childEnvironment, {
  COWORK_USER_DATA_DIR: profile,
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_PROFILE: "default",
  COWORK_HEADLESS: "1",
});
assert.equal(
  Object.keys(childEnvironment).some((key) => /(?:OPENAI|ANTHROPIC|GEMINI|AZURE).*KEY/i.test(key)),
  false,
  "The Node daemon must not inherit external provider credentials",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function seedProfile() {
  const source = String.raw`
    const {DatabaseManager}=require('./dist/daemon/electron/database/schema.js');
    const {WorkspaceStore}=require('./dist/daemon/electron/database/repositories.js');
    const {AgentRoleStore}=require('./dist/daemon/electron/agents/AgentRoleRepository.js');
    const {RoutineService}=require('./dist/daemon/electron/routines/service.js');
    const manager=new DatabaseManager(); const db=manager.getDatabase();
    const workspace=new WorkspaceStore(db).create('Private Node fixture',process.env.COWORK_FIXTURE_WORKSPACE,{read:true,write:false,delete:false,shell:false,network:false});
    const bot=new AgentRoleStore(db).create({name:'arbitrary-private-node-bot',displayName:'Private Node fixture',description:'Disposable Node-only responsibility fixture',systemPrompt:'Read only the selected source and report its evidence.',capabilities:[],heartbeatEnabled:false});
    const routines=new RoutineService({db,getCronService:()=>null,getEventTriggerService:()=>null,loadHooksSettings:()=>({enabled:false,token:'fixture',path:'/hooks',maxBodyBytes:1024,presets:[],mappings:[]}),saveHooksSettings:()=>{},createTask:async()=>{throw new Error('Fixture setup must not dispatch work');}});
    (async()=>{
      const first=await routines.create({name:'Selected evidence reader',enabled:false,workspaceId:workspace.id,prompt:'Read the selected evidence file and report the service window.',connectors:[],triggers:[{id:'manual',type:'manual',enabled:true}],outputs:[{kind:'task_only'}]});
      const second=await routines.create({name:'Independent paused responsibility',enabled:false,workspaceId:workspace.id,prompt:'Remain paused during this fixture.',connectors:[],triggers:[{id:'manual',type:'manual',enabled:true}],outputs:[{kind:'task_only'}]});
      await routines.stopWorkflowRuntime();
      process.stdout.write('FIXTURE='+JSON.stringify({scope:{workspaceId:workspace.id,agentRoleId:bot.id},routines:[first.id,second.id]})+'\n');
      manager.close();
    })().catch(error=>{console.error(error);manager.close();process.exitCode=1;});
  `;
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd: root,
    env: { ...childEnvironment, COWORK_FIXTURE_WORKSPACE: workspacePath },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `Fixture setup failed: ${result.stderr}`);
  const line = result.stdout.split("\n").find((value) => value.startsWith("FIXTURE="));
  assert(line, `Fixture identifiers missing: ${result.stdout}`);
  return JSON.parse(line.slice("FIXTURE=".length));
}

function startProviderStub() {
  const calls = [];
  let sequence = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "node-fixture-model", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Fixture route not found" } }));
      return;
    }
    if (request.headers.authorization !== "Bearer node-fixture-only") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Fixture credential rejected" } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Malformed fixture request" } }));
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolNames = (Array.isArray(body.tools) ? body.tools : [])
      .map((tool) => tool?.function?.name)
      .filter((name) => typeof name === "string");
    const isPlanning = JSON.stringify(messages).toLowerCase().includes("create an execution plan.");
    const hasToolResult = messages.some(
      (message) => message?.role === "tool" || message?.tool_call_id,
    );
    const toolResultTexts = messages
      .filter((message) => message?.role === "tool" || message?.tool_call_id)
      .map((message) =>
        typeof message?.content === "string" ? message.content : JSON.stringify(message?.content),
      );
    const record = {
      model: body.model,
      toolNames,
      isPlanning,
      hasToolResult,
      readResultHasEvidence: false,
    };
    if (hasToolResult) {
      record.toolResultTexts = toolResultTexts;
      record.readResultHasEvidence = messages.some(
        (message) =>
          (message?.role === "tool" || message?.tool_call_id) &&
          typeof message?.content === "string" &&
          message.content.includes("07:40 UTC"),
      );
    }
    calls.push(record);

    let message;
    let finishReason;
    if (isPlanning) {
      message = {
        role: "assistant",
        content: JSON.stringify({
          description: "Read the selected fixture evidence.",
          steps: [
            {
              id: "1",
              description: `Read ${selectedPath} and report the service window.`,
              kind: "primary",
              status: "pending",
            },
          ],
        }),
      };
      finishReason = "stop";
    } else if (!hasToolResult && toolNames.includes("read_file")) {
      sequence += 1;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_node_fixture_${sequence}`,
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: selectedPath }) },
          },
        ],
      };
      finishReason = "tool_calls";
    } else if (hasToolResult) {
      message = {
        role: "assistant",
        content: record.readResultHasEvidence
          ? "The selected evidence says the service window starts at 07:40 UTC."
          : "The selected evidence could not be verified from the tool result.",
      };
      finishReason = "stop";
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `chatcmpl-node-fixture-${calls.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "node-fixture-model",
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 48, completion_tokens: 16, total_tokens: 64 },
      }),
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      resolve({
        server,
        calls,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

let requestId = 0;
async function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}
async function rpc(socket, method, params = {}) {
  const id = String(++requestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Control Plane request timed out: ${method}`));
    }, 10_000);
    function onMessage(raw) {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch (error) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        reject(error);
        return;
      }
      if (frame.type !== "res" || frame.id !== id) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    }
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

async function waitFor(read, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stopDaemon(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer;
  const drained = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 15_000);
    }),
  ]);
  clearTimeout(timer);
  if (!drained) {
    child.kill("SIGKILL");
    await exited;
    throw new Error("Node fixture daemon did not stop before the deadline");
  }
  assert.equal(child.exitCode, 0, "Node fixture daemon shutdown failed");
}

let provider;
let daemon;
let socket;
let daemonOutput = "";
try {
  await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(workspacePath, selectedPath), selectedContent, { mode: 0o600 });
  await fs.writeFile(
    path.join(workspacePath, "unselected-secret.txt"),
    "must not be read by this responsibility\n",
    { mode: 0o600 },
  );
  const fixture = seedProfile();
  const scope = fixture.scope;
  provider = await startProviderStub();
  const port = await freePort();
  const daemonEntry = path.join(root, "dist/daemon/daemon/main.js");
  daemon = spawn(
    process.execPath,
    [
      daemonEntry,
      "--headless",
      "--enable-control-plane",
      "--print-control-plane-token",
      "--no-import-env-settings",
      "--control-plane-host",
      "127.0.0.1",
      "--control-plane-port",
      String(port),
    ],
    { cwd: root, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] },
  );
  daemon.stdout.on("data", (chunk) => {
    daemonOutput = (daemonOutput + String(chunk)).slice(-80_000);
  });
  daemon.stderr.on("data", (chunk) => {
    daemonOutput = (daemonOutput + String(chunk)).slice(-80_000);
  });
  const token = await waitFor(() => {
    const value = daemonOutput.match(/Control Plane token: (\S+)/)?.[1];
    return value && daemonOutput.includes("Control Plane listening:") ? value : null;
  }, "the Node-only Control Plane");
  assert.equal(path.resolve(daemon.spawnfile), path.resolve(process.execPath));
  socket = await connect(port);
  const auth = await rpc(socket, "connect", { token, deviceName: "node-responsibility-fixture" });
  assert.equal(auth.ok, true, JSON.stringify(auth.error));

  const status = await rpc(socket, "automation.runtime.status");
  assert.equal(status.ok, true, JSON.stringify(status.error));
  assert.equal(status.payload.runtime, "node");
  assert.equal(status.payload.capabilities.desktopInteraction, "waiting_for_desktop");

  const configure = await rpc(socket, "llm.configure", {
    providerType: "openai-compatible",
    apiKey: "node-fixture-only",
    model: "node-fixture-model",
    settings: { baseUrl: provider.baseUrl },
  });
  assert.equal(configure.ok, true, JSON.stringify(configure.error));

  const readOperation = {
    connectorId: "workspace_files",
    method: "read_file",
    resourceId: selectedPath,
  };
  const observeDefinition = (routineId, objective) => ({
    objective,
    engine: { kind: "routine", id: routineId },
    mode: "observe",
    sources: [readOperation],
    permittedActions: [],
    expectedOutput: "A concise report grounded in the selected file.",
    reviewBoundary: "all_effects",
    destination: { channel: "internal", id: "node-fixture-results" },
    backend: "node",
    budget: { maxTokens: 1000, maxCost: 0.25 },
  });
  const first = await rpc(socket, "bot.responsibility.create", {
    scope,
    definition: observeDefinition(fixture.routines[0], "Read the selected service evidence."),
  });
  const second = await rpc(socket, "bot.responsibility.create", {
    scope,
    definition: observeDefinition(
      fixture.routines[1],
      "Remain an independent paused responsibility.",
    ),
  });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(second.ok, true, JSON.stringify(second.error));
  const revised = await rpc(socket, "bot.responsibility.revise", {
    scope,
    id: second.payload.id,
    expectedRevision: second.payload.revision,
    definition: observeDefinition(fixture.routines[1], "Revised independent objective."),
  });
  assert.equal(revised.ok, true, JSON.stringify(revised.error));
  assert.equal(revised.payload.revision, 2);
  assert.equal(first.payload.revision, 1);

  const desktopPreview = await rpc(socket, "bot.responsibility.preview", {
    scope,
    definition: {
      ...observeDefinition(fixture.routines[0], "Desktop-only fixture."),
      backend: "desktop",
    },
  });
  assert.equal(desktopPreview.ok, true, JSON.stringify(desktopPreview.error));
  assert.equal(desktopPreview.payload.backendPresence, "requires_desktop");
  assert.equal(desktopPreview.payload.activationAvailable, false);

  const activated = await rpc(socket, "bot.responsibility.activate", {
    scope,
    id: first.payload.id,
    expectedRevision: first.payload.revision,
    expectedControlVersion: first.payload.controlVersion,
  });
  assert.equal(activated.ok, true, JSON.stringify(activated.error));
  const runRequest = {
    scope,
    id: activated.payload.id,
    expectedRevision: activated.payload.revision,
    expectedControlVersion: activated.payload.controlVersion,
    requestId: "node-fixture-run-once",
  };
  const run = await rpc(socket, "bot.responsibility.run", runRequest);
  assert.equal(run.ok, true, JSON.stringify(run.error));
  const taskId = run.payload.backingTaskId;
  assert.equal(typeof taskId, "string");

  const row = await waitFor(() => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const current = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
      return current && ["completed", "failed", "cancelled", "interrupted"].includes(current.status)
        ? current
        : null;
    } finally {
      db.close();
    }
  }, "the Node responsibility task to reach a terminal state");
  assert.equal(
    row.status,
    "completed",
    `Node responsibility failed: ${row.error || row.result_summary || "no error detail"}`,
  );
  const taskConfig = JSON.parse(row.agent_config || "{}");
  assert.deepEqual(taskConfig.responsibilityRun, {
    id: activated.payload.id,
    workspaceId: scope.workspaceId,
    agentRoleId: scope.agentRoleId,
    revision: 1,
    controlVersion: activated.payload.controlVersion,
    engine: { kind: "routine", id: fixture.routines[0] },
  });
  assert.equal(
    provider.calls.some((call) => call.isPlanning),
    true,
  );
  assert.equal(
    provider.calls.some((call) => call.toolNames.includes("read_file")),
    true,
  );
  assert.equal(
    provider.calls.some((call) => call.hasToolResult && call.readResultHasEvidence),
    true,
    `Selected read did not return fixture evidence: ${JSON.stringify(provider.calls)}`,
  );
  assert.equal(
    provider.calls.some((call) => call.toolNames.includes("write_file")),
    false,
  );
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let completed;
  try {
    completed = db.prepare("SELECT status,result_summary FROM tasks WHERE id=?").get(taskId);
    const runCount = db
      .prepare("SELECT COUNT(*) AS count FROM routine_runs WHERE backing_task_id=?")
      .get(taskId).count;
    assert.equal(runCount, 1, "A manual responsibility run must create one routine receipt");
    const persisted = db
      .prepare(
        `SELECT b.revision,b.state,r.definition_json FROM bot_responsibilities b
         JOIN bot_responsibility_revisions r ON r.responsibility_id=b.id AND r.revision=b.revision
         WHERE b.id=?`,
      )
      .get(revised.payload.id);
    assert.equal(persisted.revision, 2);
    assert.equal(persisted.state, "paused");
    assert.equal(JSON.parse(persisted.definition_json).objective, "Revised independent objective.");
  } finally {
    db.close();
  }
  await stopDaemon(daemon);
  daemon = null;
  socket.terminate();
  socket = null;
  await provider.close();
  provider = null;
  console.log(
    JSON.stringify({
      status: "passed",
      runtime: "compiled Node-only daemon",
      electronProcessStarted: false,
      desktopRequest: "waiting_for_desktop",
      responsibilityTaskStatus: completed.status,
      selectedSourceReadByLocalProviderRun: true,
      ungrantedWriteToolExcluded: true,
      independentPausedRevision: 2,
      routineReceiptCount: 1,
      provider: "deterministic loopback OpenAI-compatible stub",
      realProvider: false,
      channelDelivery: false,
    }),
  );
} catch (error) {
  const diagnostic = daemonOutput
    .replaceAll(profile, "[disposable-profile]")
    .replaceAll("node-fixture-only", "[redacted]")
    .replace(/Control Plane token: \S+/g, "Control Plane token: [redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  console.error(
    `${error.stack || error}\nproviderCalls=${JSON.stringify(provider?.calls ?? [])}\n${diagnostic.slice(-8_000)}`,
  );
  process.exitCode = 1;
} finally {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.terminate();
  if (daemon) await stopDaemon(daemon).catch(() => daemon?.kill("SIGKILL"));
  if (provider) await provider.close().catch(() => {});
  await fs.rm(profile, { recursive: true, force: true });
}
