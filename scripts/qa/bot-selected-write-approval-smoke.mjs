#!/usr/bin/env node
/**
 * Compiled default-inline responsibility write acceptance. Uses one disposable
 * profile/workspace and a local OpenAI-compatible stub; it never contacts a
 * real provider or channel.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const electronExecutable = require("electron");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const daemonEntry = path.join(root, "dist/daemon/daemon/main.js");
const manifestPath = path.join(root, "dist/web/web-manifest.json");
const expectedContent =
  "Stage73 reviewed write: exact bytes survive browser approval and restart.\n" +
  "UTF-8 proof: Lisbon · CoWork.\n";
const relativePath = "stage73-selected-write.txt";
const baseContent = "Existing target before approval.\n";
const baseSha256 = crypto.createHash("sha256").update(baseContent, "utf8").digest("hex");
const baseBytes = Buffer.byteLength(baseContent, "utf8");
const contentSha256 = crypto.createHash("sha256").update(expectedContent, "utf8").digest("hex");
const contentBytes = Buffer.byteLength(expectedContent, "utf8");
const operation = { connectorId: "workspace_files", method: "write_file" };
const decisionQuestionId = "responsibility_action_review_decision";
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-stage73-profile-"));
const workspacePath = path.join(profileDir, "company-workspaces", "local");
const databasePath = path.join(profileDir, "cowork-os.db");
const environment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(environment, {
  COWORK_USER_DATA_DIR: profileDir,
  COWORK_PROFILE: "default",
  COWORK_HEADLESS: "0",
  COWORK_TEST_HIDE_MAIN_WINDOW: "1",
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_DISABLE_OS_KEYCHAIN: "1",
  COWORK_WEB_ENABLED: "1",
  COWORK_WEB_PUBLIC_ORIGIN: "",
  COWORK_WEB_TRUSTED_PROXY_ADDRESSES: "",
});
assert.equal(
  Object.keys(environment).some((key) => /(?:OPENAI|ANTHROPIC|GEMINI|AZURE).*KEY/i.test(key)),
  false,
  "The disposable daemon must not inherit provider credentials",
);
assert.equal(environment.COWORK_APPROVAL_PROMPTS, undefined, "Legacy popup opt-in must stay off");

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

async function waitFor(read, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${last ? `; last=${JSON.stringify(last)}` : ""}`,
  );
}

function seedDisposableProfile() {
  const seedCode = `
    const path = require('node:path');
    const { DatabaseManager } = require('./dist/daemon/electron/database/schema.js');
    const { WorkspaceStore } = require('./dist/daemon/electron/database/repositories.js');
    const { AgentRoleStore } = require('./dist/daemon/electron/agents/AgentRoleRepository.js');
    const { RoutineService } = require('./dist/daemon/electron/routines/service.js');
    const manager = new DatabaseManager({ dbPath: process.env.COWORK_FIXTURE_DB });
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create(
      'Company: Local Company',
      process.env.COWORK_FIXTURE_WORKSPACE,
      { read: true, write: true, delete: false, shell: false, network: false },
    );
    const bot = new AgentRoleStore(db).create({
      name: 'stage73-private-writer',
      displayName: 'Stage73 Private Writer',
      description: 'Disposable selected-write acceptance fixture',
      systemPrompt: 'Keep this private fixture identity and write only the exact reviewed file.',
      capabilities: [],
    });
    const routines = new RoutineService({
      db,
      getCronService: () => null,
      getEventTriggerService: () => null,
      loadHooksSettings: () => ({
        enabled: false, token: 'fixture', path: '/hooks', maxBodyBytes: 1024, presets: [], mappings: [],
      }),
      saveHooksSettings: () => {},
      createTask: async () => { throw new Error('Seed routine must not dispatch work'); },
    });
    (async () => {
      const act = await routines.create({
        name: 'Stage73 Act writer', enabled: false, workspaceId: workspace.id,
        prompt: 'Write the exact content supplied by the local acceptance provider.',
        connectors: [], triggers: [{ id: 'manual', type: 'manual', enabled: true }],
        outputs: [{ kind: 'task_only' }],
      });
      const observe = await routines.create({
        name: 'Stage73 Observe reader', enabled: false, workspaceId: workspace.id,
        prompt: 'Observe the selected workspace file and prepare an internal note.',
        connectors: [], triggers: [{ id: 'manual', type: 'manual', enabled: true }],
        outputs: [{ kind: 'task_only' }],
      });
      await routines.stopWorkflowRuntime();
      process.stdout.write('FIXTURE=' + JSON.stringify({
        workspaceId: workspace.id, agentRoleId: bot.id, actRoutineId: act.id,
        observeRoutineId: observe.id,
      }) + '\\n');
      manager.close();
    })().catch((error) => { console.error(error); manager.close(); process.exitCode = 1; });
  `;
  const seeded = spawnSync(process.execPath, ["-e", seedCode], {
    cwd: root,
    env: {
      ...environment,
      COWORK_FIXTURE_DB: databasePath,
      COWORK_FIXTURE_WORKSPACE: workspacePath,
    },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(seeded.error, undefined, seeded.error?.message);
  assert.equal(seeded.status, 0, `Disposable fixture setup failed: ${seeded.stderr}`);
  const line = seeded.stdout.split("\n").find((entry) => entry.startsWith("FIXTURE="));
  assert(line, "Disposable fixture setup did not return its identifiers");
  return JSON.parse(line.slice("FIXTURE=".length));
}

async function startProviderStub() {
  const requests = [];
  let toolCallCount = 0;
  let planResponseCount = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === "/v1/models" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "stage73-local-model", object: "model" }] }));
      return;
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Stage73 stub route not found" } }));
      return;
    }
    if (request.headers.authorization !== "Bearer stage73-local-only") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Stage73 synthetic key rejected" } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Malformed Stage73 completion request" } }));
      return;
    }
    const record = {
      model: body.model,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      hasWriteTool:
        Array.isArray(body.tools) &&
        body.tools.some((tool) => tool?.function?.name === "write_file"),
      hasToolResult:
        Array.isArray(body.messages) &&
        body.messages.some((message) => message?.role === "tool" || message?.tool_call_id),
      isPlanningRequest: JSON.stringify(body.messages ?? [])
        .toLowerCase()
        .includes("create an execution plan."),
    };
    requests.push(record);
    let message;
    let finishReason;
    if (record.isPlanningRequest) {
      planResponseCount += 1;
      message = {
        role: "assistant",
        content: JSON.stringify({
          description: "Write the exact reviewed acceptance file.",
          steps: [
            {
              id: "1",
              description: `Write the exact reviewed content to ${relativePath}.`,
              kind: "primary",
              status: "pending",
            },
          ],
        }),
      };
      finishReason = "stop";
    } else if (record.hasWriteTool && !record.hasToolResult) {
      toolCallCount += 1;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_stage73_${toolCallCount}`,
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: relativePath, content: expectedContent }),
            },
          },
        ],
      };
      finishReason = "tool_calls";
    } else {
      message = { role: "assistant", content: "The exact Stage73 reviewed file was written." };
      finishReason = "stop";
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: `chatcmpl-stage73-${requests.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "stage73-local-model",
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 72, completion_tokens: 20, total_tokens: 92 },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    server,
    requests,
    get planResponseCount() {
      return planResponseCount;
    },
    get toolCallCount() {
      return toolCallCount;
    },
    diagnostics() {
      return {
        requestCount: requests.length,
        planResponseCount,
        toolCallCount,
        recentRequests: requests.slice(-8),
      };
    },
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function startDaemon(port) {
  const childEnvironment = {
    ...environment,
    COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
    COWORK_CONTROL_PLANE_PORT: String(port),
    COWORK_CONTROL_PLANE_TOKEN: "",
  };
  const child = spawn(
    electronExecutable,
    [
      root,
      "--enable-control-plane",
      "--print-control-plane-token",
      "--no-import-env-settings",
      "--user-data-dir",
      profileDir,
      "--control-plane-host",
      "127.0.0.1",
      "--control-plane-port",
      String(port),
    ],
    { cwd: root, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] },
  );
  const host = { child, port, base: `http://127.0.0.1:${port}`, output: "" };
  child.stdout.on("data", (data) => {
    host.output = (host.output + String(data)).slice(-128_000);
  });
  child.stderr.on("data", (data) => {
    host.output = (host.output + String(data)).slice(-128_000);
  });
  host.exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return host;
}

function safeHostOutput(host) {
  return host.output
    .replaceAll(profileDir, "[disposable-profile]")
    .replaceAll(workspacePath, "[disposable-workspace]")
    .replaceAll("stage73-local-only", "[redacted]")
    .replace(/Control Plane token: \S+/g, "Control Plane token: [redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

async function waitForReady(host) {
  const deadline = Date.now() + 60_000;
  const connectionPath = path.join(profileDir, "control-plane-local.json");
  while (Date.now() < deadline) {
    let connection;
    try {
      connection = JSON.parse(await fs.readFile(connectionPath, "utf8"));
    } catch {
      // The desktop runtime writes the connection file after binding its actual port.
    }
    if (connection?.pid === host.child.pid && typeof connection.url === "string") {
      const address = new URL(connection.url);
      const port = Number(address.port);
      if (
        address.protocol === "ws:" &&
        address.hostname === "127.0.0.1" &&
        Number.isSafeInteger(port) &&
        port > 0 &&
        typeof connection.token === "string" &&
        connection.token.length > 0
      ) {
        host.port = port;
        host.base = `http://127.0.0.1:${port}`;
        const response = await fetch(`${host.base}/api/web/v1/bootstrap`).catch(() => null);
        if (response?.ok) return connection.token;
      }
    }
    if (host.child.exitCode !== null || host.child.signalCode !== null)
      throw new Error(
        `Disposable desktop runtime exited during startup: ${safeHostOutput(host).slice(-3000)}`,
      );
    await sleep(100);
  }
  throw new Error(
    `Disposable desktop runtime startup timed out: ${safeHostOutput(host).slice(-3000)}`,
  );
}

async function stopDaemon(host) {
  if (!host || host.child.exitCode !== null || host.child.signalCode !== null) return;
  host.child.kill("SIGTERM");
  const stopped = await Promise.race([
    host.exited.then(() => true),
    sleep(15_000).then(() => false),
  ]);
  if (!stopped) {
    host.child.kill("SIGKILL");
    await host.exited;
    throw new Error("Disposable daemon required forced termination");
  }
  const outcome = await host.exited;
  assert.equal(outcome.code, 0, `Disposable daemon shutdown failed (${outcome.signal})`);
}

let controlRequestId = 0;
async function controlRequest(socket, method, params = {}, timeoutMs = 90_000) {
  const id = `stage73-${++controlRequestId}`;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Control Plane timed out: ${method}`));
    }, timeoutMs);
    const onMessage = (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type !== "res" || frame.id !== id) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

async function connectControlPlane(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const connected = await controlRequest(socket, "connect", {
    token,
    deviceName: "stage73-disposable-acceptance",
  });
  assert.equal(
    connected.ok,
    true,
    `Control Plane authentication failed: ${connected.error?.message}`,
  );
  return socket;
}

async function callControlPlane(socket, method, params = {}) {
  const frame = await controlRequest(socket, method, params);
  assert.equal(
    frame.ok,
    true,
    `Control Plane ${method} failed: ${frame.error?.message ?? "unknown error"}`,
  );
  return frame.payload;
}

function readOnlyDb() {
  const Database = require("better-sqlite3");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

function readInputAndApproval(taskId) {
  const db = readOnlyDb();
  try {
    const linked = db
      .prepare(`
      SELECT i.id AS input_id, i.task_id, i.questions, i.status AS input_status,
             i.answers, i.requested_at, i.resolved_at, l.approval_id, l.revision_hash
      FROM input_requests i JOIN approval_input_links l ON l.input_id=i.id
      WHERE i.task_id=? ORDER BY i.requested_at DESC LIMIT 1
    `)
      .get(taskId);
    if (!linked) return null;
    const approval = db
      .prepare(`
      SELECT id,task_id,type,description,details,status,requested_at
      FROM approvals WHERE id=?
    `)
      .get(linked.approval_id);
    return {
      linked,
      approval,
      questions: JSON.parse(linked.questions),
      details: JSON.parse(approval.details),
    };
  } finally {
    db.close();
  }
}

function assertPersistedReview(taskId, expectedRun) {
  const persisted = readInputAndApproval(taskId);
  assert(persisted, "The live task must have a persisted inline input linked to its approval");
  const { linked, approval, questions, details } = persisted;
  assert.equal(linked.input_status, "pending");
  assert.equal(approval.status, "pending");
  assert.equal(approval.type, "workspace_write");
  assert.match(linked.revision_hash, /^[0-9a-f]{64}$/);
  assert.equal(details.tool, "write_file");
  assert.deepEqual(details.reviewFiles, [relativePath]);
  assert.deepEqual(details.params, { path: relativePath });
  const review = details.responsibilityActionReview;
  assert(review, "The approval must persist the exact proposed action");
  assert.equal(review.version, 1);
  assert.deepEqual(review.operation, operation);
  assert.equal(review.canonicalPath, relativePath);
  assert.equal(review.content, expectedContent);
  assert.equal(review.contentSha256, contentSha256);
  assert.equal(review.contentBytes, contentBytes);
  assert.deepEqual(review.responsibilityRun, {
    id: expectedRun.id,
    workspaceId: expectedRun.workspaceId,
    agentRoleId: expectedRun.agentRoleId,
    revision: expectedRun.revision,
    controlVersion: expectedRun.controlVersion,
  });
  const question = questions.find((entry) => entry.id === decisionQuestionId);
  assert(question, "The durable inline question must carry the mandatory review marker");
  assert.deepEqual(
    question.options.map((entry) => entry.label),
    ["Deny once", "Allow once"],
  );
  const draft = details.draftRevision;
  assert.equal(draft?.state, "bound", "The original target revision must be separately bound");
  assert.equal(draft.workspaceId, expectedRun.workspaceId);
  assert.equal(draft.entries?.length, 1);
  assert.equal(draft.entries[0]?.reference, relativePath);
  assert.equal(draft.entries[0]?.status, "present");
  assert.equal(draft.entries[0]?.sha256, baseSha256);
  assert.equal(draft.entries[0]?.size, baseBytes);
  const realWorkspacePath = require("node:fs").realpathSync.native(workspacePath);
  assert.equal(path.resolve(draft.entries[0]?.path), path.resolve(realWorkspacePath, relativePath));
  const { approvalRequestRevisionHash } = require(
    path.join(root, "dist/daemon/electron/agent/approval-revision.js"),
  );
  assert.equal(
    linked.revision_hash,
    approvalRequestRevisionHash({
      taskId: approval.task_id,
      type: approval.type,
      description: approval.description,
      details,
      requestedAt: approval.requested_at,
    }),
  );
  return { ...persisted, review };
}

function listInputStatus(taskId) {
  const persisted = readInputAndApproval(taskId);
  return persisted?.linked.input_status ?? null;
}

function getClaimRows(taskId) {
  const db = readOnlyDb();
  try {
    return db
      .prepare(`
      SELECT c.approval_id,c.task_id,c.request_revision_hash,c.execution_id,c.outcome,
             d.action,d.request_revision_hash AS decision_revision_hash
      FROM responsibility_action_review_claims c
      JOIN responsibility_action_review_decisions d ON d.approval_id=c.approval_id
      WHERE c.task_id=?
    `)
      .all(taskId);
  } finally {
    db.close();
  }
}

function getFileEvents(taskId) {
  const db = readOnlyDb();
  try {
    return db
      .prepare(`
      SELECT id,type,legacy_type,payload,timestamp FROM task_events
      WHERE task_id=? AND (type='file_created' OR legacy_type='file_created')
    `)
      .all(taskId)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  } finally {
    db.close();
  }
}

function readTaskRecoveryDiagnostics(taskId) {
  const db = readOnlyDb();
  try {
    const task = db.prepare("SELECT status,terminal_status FROM tasks WHERE id=?").get(taskId);
    const events = db
      .prepare(
        "SELECT type,legacy_type,payload FROM task_events WHERE task_id=? ORDER BY timestamp DESC LIMIT 20",
      )
      .all(taskId)
      .map((event) => {
        let payload = {};
        try {
          payload = JSON.parse(event.payload);
        } catch {}
        return {
          type: event.legacy_type || event.type,
          reason: typeof payload.reason === "string" ? payload.reason : undefined,
        };
      });
    const approvals = db
      .prepare("SELECT id,status FROM approvals WHERE task_id=? ORDER BY requested_at DESC")
      .all(taskId);
    const inputs = db
      .prepare("SELECT id,status FROM input_requests WHERE task_id=? ORDER BY requested_at DESC")
      .all(taskId);
    const recentRecoveryEvents = db
      .prepare(
        "SELECT task_id,type,legacy_type,payload FROM task_events WHERE task_id=? AND (type IN ('approval_wait_rehydrated','input_wait_rehydrated','task_interrupted','approval_denied') OR legacy_type IN ('approval_wait_rehydrated','input_wait_rehydrated','task_interrupted','approval_denied')) ORDER BY timestamp DESC LIMIT 20",
      )
      .all(taskId)
      .map((event) => {
        let payload = {};
        try {
          payload = JSON.parse(event.payload);
        } catch {}
        return {
          type: event.legacy_type || event.type,
          reason: typeof payload.reason === "string" ? payload.reason : undefined,
        };
      });
    const tasks = db
      .prepare(
        "SELECT id,title,status,terminal_status,parent_task_id FROM tasks ORDER BY created_at DESC LIMIT 12",
      )
      .all();
    return { task, events, approvals, inputs, recentRecoveryEvents, tasks };
  } finally {
    db.close();
  }
}

function inputRunBinding(taskId) {
  const db = readOnlyDb();
  try {
    const task = db
      .prepare("SELECT status,terminal_status,agent_config FROM tasks WHERE id=?")
      .get(taskId);
    assert(task, `Missing admitted task ${taskId}`);
    return { ...task, agentConfig: JSON.parse(task.agent_config ?? "{}") };
  } finally {
    db.close();
  }
}

async function runResponsibility(socket, scope, responsibility, requestId) {
  const result = await callControlPlane(socket, "bot.responsibility.run", {
    scope,
    id: responsibility.id,
    expectedRevision: responsibility.revision,
    expectedControlVersion: responsibility.controlVersion,
    requestId,
  });
  assert.equal(typeof result?.backingTaskId, "string", "Responsibility run must admit one task");
  return result;
}

async function waitForPendingInput(taskId, timeoutMs = 60_000) {
  return await waitFor(
    () => {
      const persisted = readInputAndApproval(taskId);
      return persisted?.linked.input_status === "pending" &&
        persisted.approval?.status === "pending"
        ? persisted
        : null;
    },
    `a live inline approval for task ${taskId}`,
    timeoutMs,
  );
}

async function pairBrowser(host, socket, manifest, browser, routeHarness) {
  const pairing = await callControlPlane(socket, "web.pair");
  assert.equal(typeof pairing?.code, "string");
  const page = await browser.newPage();
  await routeHarness.install(page);
  await page.goto(`${host.base}/app/`);
  await page.setDefaultTimeout(15_000);
  await page.getByLabel("Pairing code").fill(pairing.code);
  await page.getByRole("button", { name: "Connect" }).click();
  const skip = page.getByRole("button", { name: "Skip onboarding" });
  await skip.waitFor({ state: "visible" });
  await skip.click();
  const understand = page.getByText("Yes, I understand", { exact: true });
  await understand.waitFor({ state: "visible" });
  await understand.click();
  const proceed = page.getByRole("button", { name: "Continue", exact: true });
  await proceed.waitFor({ state: "visible" });
  await proceed.click();
  try {
    await waitFor(
      () =>
        routeHarness.taskRows.some((task) => task.id === routeHarness.targetTaskId) ? true : null,
      `task.list response containing ${routeHarness.targetTaskId}`,
    );
  } catch (error) {
    const failureBase = path.join(os.tmpdir(), `cowork-stage73-pair-failure-${Date.now()}`);
    await page.screenshot({ path: `${failureBase}.png`, fullPage: true }).catch(() => undefined);
    const diagnostic = {
      url: page.url(),
      title: await page.title().catch(() => "unavailable"),
      body: (
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      ).slice(0, 8000),
    };
    await fs.writeFile(`${failureBase}.json`, `${JSON.stringify(diagnostic, null, 2)}\n`);
    process.stderr.write(`Browser pair evidence: ${failureBase}.png and ${failureBase}.json\n`);
    throw error;
  }
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name.startsWith("cw_"));
  assert(
    sessionCookie,
    `The paired browser must retain its scoped host cookie (cookie names: ${cookies.map((cookie) => cookie.name).join(", ") || "none"})`,
  );
  const cookie = `${sessionCookie.name}=${sessionCookie.value}`;
  const bootstrapResponse = await fetch(`${host.base}/api/web/v1/session/bootstrap`, {
    headers: { Cookie: cookie, Origin: host.base },
  });
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(typeof bootstrap.csrfToken, "string");
  const manifestResponse = await fetch(`${host.base}/app/web-manifest.json`);
  assert.equal(manifestResponse.ok, true);
  const builtManifest = await manifestResponse.json();
  assert.equal(builtManifest.apiVersion, manifest.apiVersion);
  return { page, pairedSession: { cookie, csrfToken: bootstrap.csrfToken } };
}

function createBrowserRouteHarness() {
  let mode = "pass";
  let targetTaskId = null;
  let held = null;
  let heldResolve;
  let lastRespond = null;
  let taskRows = [];
  let installCount = 0;
  return {
    setMode(nextMode, taskId = targetTaskId) {
      mode = nextMode;
      targetTaskId = taskId;
    },
    get taskRows() {
      return taskRows;
    },
    get targetTaskId() {
      return targetTaskId;
    },
    get lastRespond() {
      return lastRespond;
    },
    async install(page) {
      installCount += 1;
      await page.routeWebSocket("**/api/web/v1/ws", (client) => {
        const server = client.connectToServer();
        const requests = new Map();
        client.onMessage((raw) => {
          let frame;
          try {
            frame = JSON.parse(String(raw));
          } catch {
            server.send(raw);
            return;
          }
          if (frame.type === "request" && typeof frame.id === "string")
            requests.set(frame.id, {
              method: frame.method,
              params: frame.params,
              operationKey: frame.operationKey,
            });
          server.send(raw);
        });
        server.onMessage((raw) => {
          let frame;
          try {
            frame = JSON.parse(String(raw));
          } catch {
            client.send(raw);
            return;
          }
          const request = requests.get(frame.id);
          if (request?.method === "task.list" && Array.isArray(frame.result?.tasks))
            taskRows = frame.result.tasks;
          if (request?.method === "input_request.respond")
            lastRespond = {
              params: request.params,
              operationKey: request.operationKey,
              response: frame,
            };
          if (
            request?.method === "input_request.get" &&
            request.params?.taskId === targetTaskId &&
            frame.result?.inputRequest
          ) {
            const original = structuredClone(frame);
            if (mode === "loading") {
              held = { client, frame: original };
              const releaseWait = heldResolve;
              heldResolve = undefined;
              releaseWait?.();
              return;
            }
            mutateInputReviewFrame(frame, targetTaskId, mode);
          }
          requests.delete(frame.id);
          client.send(typeof frame === "string" ? raw : JSON.stringify(frame));
        });
      });
    },
    waitForHeldResponse(timeoutMs = 15_000) {
      if (held) return Promise.resolve();
      return Promise.race([
        new Promise((resolve) => {
          heldResolve = resolve;
        }),
        sleep(timeoutMs).then(() => {
          throw new Error("Browser did not reach the held input review response");
        }),
      ]);
    },
    releaseHeld(nextMode) {
      assert(held, "No browser review response is held");
      mutateInputReviewFrame(held.frame, targetTaskId, nextMode);
      held.client.send(JSON.stringify(held.frame));
      held = null;
      mode = nextMode;
    },
    get installCount() {
      return installCount;
    },
  };
}

function mutateInputReviewFrame(frame, taskId, mode) {
  if (mode === "pass") return;
  const item = frame.result?.inputRequest;
  assert(
    item?.id && item.taskId === taskId,
    `Browser host response did not contain the expected linked input for ${taskId}`,
  );
  if (mode === "missing") {
    delete item.responsibilityActionReview;
    return;
  }
  if (mode === "tampered") {
    assert.equal(item.responsibilityActionReview?.state, "valid");
    item.responsibilityActionReview.review.content += "tampered after approval";
    return;
  }
  if (mode === "stale") {
    item.responsibilityActionReview = { required: true, state: "invalid" };
    return;
  }
  throw new Error(`Unknown browser fixture mutation: ${mode}`);
}

async function webRpc(host, pairedSession, manifest, method, params, operationKey) {
  const response = await fetch(`${host.base}/api/web/v1/rpc`, {
    method: "POST",
    headers: {
      Origin: host.base,
      Cookie: pairedSession.cookie,
      "X-CoWork-CSRF": pairedSession.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiVersion: manifest.apiVersion,
      type: "request",
      id: `stage73-web-${crypto.randomUUID()}`,
      method,
      params,
      ...(operationKey ? { operationKey } : {}),
    }),
  });
  assert.equal(response.status, 200, `${method} web RPC failed with HTTP ${response.status}`);
  return response.json();
}

async function inspectReviewUi(page, expectedTaskId, mode) {
  const allow = page.getByRole("button", { name: /Allow once/i });
  const deny = page.getByRole("button", { name: /Deny once/i });
  const submit = page.getByRole("button", { name: "Submit", exact: true });
  if (mode === "loading") {
    await page.getByText(/Loading the exact proposed content/).waitFor({ state: "visible" });
    await allow.waitFor({ state: "visible" });
    await deny.waitFor({ state: "visible" });
    assert.equal(await allow.isDisabled(), true, "Allow once stays unavailable while review loads");
    assert.equal(await deny.isDisabled(), false, "Deny once remains available while review loads");
    return;
  }
  await allow.waitFor({ state: "visible" });
  await deny.waitFor({ state: "visible" });
  assert.equal(
    await deny.isDisabled(),
    false,
    "The reviewer can still deny a blocked or invalid review",
  );
  if (mode === "missing" || mode === "tampered" || mode === "stale") {
    await page.getByText(/The proposed write review is invalid/).waitFor({ state: "visible" });
    assert.equal(
      await allow.isDisabled(),
      true,
      `${mode} mandatory review must disable Allow once`,
    );
    assert.equal(
      await submit.isDisabled(),
      false,
      `${mode} review should still permit the preselected deny decision`,
    );
    return;
  }
  const proposalCard = page.getByRole("region", {
    name: "Proposed write for responsibility review",
  });
  await proposalCard.waitFor({ state: "visible" });
  assert.equal(
    await proposalCard.locator("pre[aria-label='Full proposed file content']").innerText(),
    expectedContent,
  );
  await proposalCard.getByText(relativePath, { exact: true }).waitFor({ state: "visible" });
  await proposalCard.getByText(contentSha256, { exact: true }).waitFor({ state: "visible" });
  await proposalCard
    .getByText(`${contentBytes.toLocaleString()} bytes`, { exact: true })
    .waitFor({ state: "visible" });
  const baseCard = page.getByRole("region", { name: "Draft revision for review" });
  await baseCard.waitFor({ state: "visible" });
  await baseCard
    .getByText(`${relativePath} · ${baseBytes.toLocaleString()} bytes`)
    .waitFor({ state: "visible" });
  await baseCard.getByText(`File version ${baseSha256.slice(0, 12)}`).waitFor({ state: "visible" });
  assert.equal(await allow.isDisabled(), false, "A valid exact review should enable Allow once");
  assert(expectedTaskId.length > 0);
  const screenshotPath = path.join(
    os.tmpdir(),
    `cowork-stage73-review-${expectedTaskId}-${Date.now()}.png`,
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(
    screenshotPath.replace(/\.png$/, ".txt"),
    `${await page.locator("body").innerText()}\n`,
  );
  renderedEvidencePaths.push(screenshotPath, screenshotPath.replace(/\.png$/, ".txt"));
}

const renderedEvidencePaths = [];

async function selectTaskById(page, harness, taskId) {
  const rows = await waitFor(
    () => (harness.taskRows.some((task) => task.id === taskId) ? harness.taskRows : null),
    `task.list response containing ${taskId}`,
  );
  const rowIndex = rows.findIndex((task) => task.id === taskId);
  assert(rowIndex >= 0);
  const taskRows = page.locator(".task-item");
  await taskRows.nth(rowIndex).waitFor({ state: "visible" });
  await taskRows.nth(rowIndex).click();
}

async function main() {
  let host;
  let socket;
  let browser;
  let stub;
  let activePage;
  let phase = "disposable profile setup";
  const begunAt = Date.now();
  try {
    await fs.mkdir(workspacePath, { recursive: true });
    assert.deepEqual(
      await fs.readdir(workspacePath),
      [],
      "The isolated review workspace starts empty",
    );
    await fs.writeFile(path.join(workspacePath, relativePath), baseContent, {
      flag: "wx",
      mode: 0o600,
    });
    const fixture = seedDisposableProfile();
    const scope = { workspaceId: fixture.workspaceId, agentRoleId: fixture.agentRoleId };
    const actionDefinition = {
      objective: "Write the exact reviewed Stage73 acceptance content to the selected file.",
      engine: { kind: "routine", id: fixture.actRoutineId },
      mode: "act",
      sources: [],
      permittedActions: [{ ...operation, resourceId: relativePath }],
      expectedOutput: "The selected file contains the exact reviewed content.",
      reviewBoundary: "all_effects",
      destination: { channel: "internal", id: "results" },
      backend: "node",
      budget: { maxTokens: 1000, maxCost: 0.25 },
    };
    const observeDefinition = {
      objective: "Observe the selected file and prepare an internal note.",
      engine: { kind: "routine", id: fixture.observeRoutineId },
      mode: "observe",
      sources: [{ connectorId: "workspace_files", method: "read_file", resourceId: relativePath }],
      permittedActions: [],
      expectedOutput: "An internal observation only.",
      reviewBoundary: "all_effects",
      destination: { channel: "internal", id: "results" },
      backend: "node",
      budget: { maxTokens: 800, maxCost: 0.1 },
    };
    phase = "starting local provider stub";
    stub = await startProviderStub();
    const webManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const { chromium } = require("playwright");
    let finalTaskId;
    let firstTaskId;
    let firstRequest;
    let finalInput;
    let approvalResolutionWaitMs = null;
    let workQueryLatencyMs = null;
    phase = "starting disposable daemon";
    host = startDaemon(await freePort());
    let token = await waitForReady(host);
    socket = await connectControlPlane(host.port, token);
    phase = "configuring disposable local provider";
    const configured = await callControlPlane(socket, "llm.configure", {
      providerType: "openai-compatible",
      apiKey: "stage73-local-only",
      model: "stage73-local-model",
      settings: { baseUrl: stub.baseUrl },
    });
    assert.equal(configured?.llm?.currentProvider, "openai-compatible");
    assert.equal(configured?.llm?.currentModel, "stage73-local-model");

    const actPaused = await callControlPlane(socket, "bot.responsibility.create", {
      scope,
      definition: actionDefinition,
    });
    const observePaused = await callControlPlane(socket, "bot.responsibility.create", {
      scope,
      definition: observeDefinition,
    });
    const act = await callControlPlane(socket, "bot.responsibility.activate", {
      scope,
      id: actPaused.id,
      expectedRevision: actPaused.revision,
      expectedControlVersion: actPaused.controlVersion,
    });
    const observeRevised = await callControlPlane(socket, "bot.responsibility.revise", {
      scope,
      id: observePaused.id,
      expectedRevision: observePaused.revision,
      definition: {
        ...observeDefinition,
        objective: "Independently revised observe-only objective.",
      },
    });
    assert.equal(act.state, "active");
    assert.equal(act.revision, 1);
    assert.equal(observeRevised.revision, 2);
    assert.equal(observeRevised.state, "paused");

    phase = "admitting selected-write responsibility run";
    const firstRun = await runResponsibility(socket, scope, act, "stage73-pending-before-restart");
    firstTaskId = firstRun.backingTaskId;
    const duplicateAdmission = await runResponsibility(
      socket,
      scope,
      act,
      "stage73-pending-before-restart",
    );
    assert.equal(
      duplicateAdmission.backingTaskId,
      firstTaskId,
      "Replaying a routine admission must not create another task",
    );
    const firstRunBinding = inputRunBinding(firstTaskId).agentConfig.responsibilityRun;
    assert.deepEqual(firstRunBinding, {
      id: act.id,
      workspaceId: fixture.workspaceId,
      agentRoleId: fixture.agentRoleId,
      revision: 1,
      controlVersion: act.controlVersion,
      engine: { kind: "routine", id: fixture.actRoutineId },
    });
    phase = "waiting for local planning request";
    const firstProviderRequest = await waitFor(
      () => stub.requests[0] ?? null,
      "the admitted task to reach the local provider stub",
      30_000,
    );
    assert.equal(
      firstProviderRequest.isPlanningRequest,
      true,
      "The first local provider request must be recognized as the execution-plan request",
    );
    phase = "waiting for original pending inline review";
    firstRequest = await waitForPendingInput(firstTaskId);
    assertPersistedReview(firstTaskId, firstRunBinding);
    assert.equal(
      await fs.readFile(path.join(workspacePath, relativePath), "utf8"),
      baseContent,
      "The original target revision must remain unchanged while approval is pending",
    );
    assert.equal(
      stub.toolCallCount,
      1,
      "The local provider must issue one native write_file tool call before waiting",
    );
    assert.equal(stub.planResponseCount, 1, "The local provider must return one valid JSON plan");
    assert.deepEqual(getClaimRows(firstTaskId), []);

    const pendingWorkStart = performance.now();
    const workPage = await callControlPlane(socket, "bot.work.list", {
      ...scope,
      view: "needs_you",
      limit: 25,
    });
    workQueryLatencyMs = performance.now() - pendingWorkStart;
    assert(workPage && Array.isArray(workPage.items));

    phase = "checking browser review controls before restart";
    browser = await chromium.launch({
      headless: true,
      env: environment,
      ...(process.env.COWORK_WEB_UI_BROWSER_EXECUTABLE
        ? { executablePath: process.env.COWORK_WEB_UI_BROWSER_EXECUTABLE }
        : {}),
    });
    const oldUi = createBrowserRouteHarness();
    oldUi.setMode("loading", firstTaskId);
    let { page } = await pairBrowser(host, socket, webManifest, browser, oldUi);
    activePage = page;
    await selectTaskById(page, oldUi, firstTaskId);
    await oldUi.waitForHeldResponse();
    await inspectReviewUi(page, firstTaskId, "loading");
    oldUi.releaseHeld("missing");
    await inspectReviewUi(page, firstTaskId, "missing");
    oldUi.setMode("tampered", firstTaskId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await inspectReviewUi(page, firstTaskId, "tampered");
    oldUi.setMode("stale", firstTaskId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await inspectReviewUi(page, firstTaskId, "stale");
    const staleAllow = page.getByRole("button", { name: /Allow once/i });
    await page.keyboard.press("2");
    await sleep(150);
    assert.equal(await staleAllow.isDisabled(), true);
    assert.equal(
      oldUi.lastRespond,
      null,
      "The disabled stale Allow once option must not submit a decision",
    );
    oldUi.setMode("pass", firstTaskId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await inspectReviewUi(page, firstTaskId, "valid");

    const firstProviderCount = stub.requests.length;
    const pendingBinding = readInputAndApproval(firstTaskId);
    assert.equal(pendingBinding.linked.input_id, firstRequest.linked.input_id);
    await browser.close();
    browser = undefined;
    activePage = undefined;
    socket.close();
    socket = undefined;
    await stopDaemon(host);
    host = undefined;
    await sleep(800);
    phase = "restarting daemon with the original inline review pending";
    host = startDaemon(await freePort());
    token = await waitForReady(host);
    socket = await connectControlPlane(host.port, token);
    await sleep(1200);
    const restartDiagnostics = readTaskRecoveryDiagnostics(firstTaskId);
    const recoveryLogLines = safeHostOutput(host)
      .split("\n")
      .filter((line) =>
        /Resuming interrupted task|scheduled for resume|no longer interrupted/i.test(line),
      )
      .slice(-12);
    assert.equal(
      stub.requests.length,
      firstProviderCount,
      `Restart must not replay the suspended model/tool invocation; diagnostics=${JSON.stringify({
        ...restartDiagnostics,
        recoveryLogLines,
      })}`,
    );
    const recoveredFirst = readInputAndApproval(firstTaskId);
    assert(
      recoveredFirst,
      "The original linked request and exact operation must remain inspectable after restart",
    );
    assert.equal(recoveredFirst.linked.input_id, firstRequest.linked.input_id);
    assert.equal(recoveredFirst.details.responsibilityActionReview.contentSha256, contentSha256);
    assert.equal(recoveredFirst.linked.input_status, "pending");
    assert.equal(recoveredFirst.approval.status, "pending");
    assert.equal(
      await fs.readFile(path.join(workspacePath, relativePath), "utf8"),
      baseContent,
      "The reviewed write must leave the original target revision untouched until approval",
    );
    assert.deepEqual(getClaimRows(firstTaskId), []);
    const recoveredDb = readOnlyDb();
    try {
      assert.equal(
        recoveredDb
          .prepare(
            "SELECT COUNT(*) AS count FROM responsibility_action_review_decisions WHERE approval_id=?",
          )
          .get(recoveredFirst.linked.approval_id).count,
        0,
        "No one-time allow/deny decision should be invented during restart recovery",
      );
    } finally {
      recoveredDb.close();
    }
    finalTaskId = firstTaskId;
    finalInput = recoveredFirst;
    assertPersistedReview(finalTaskId, firstRunBinding);

    phase = "resolving the recovered review in the browser";
    browser = await chromium.launch({
      headless: true,
      env: environment,
      ...(process.env.COWORK_WEB_UI_BROWSER_EXECUTABLE
        ? { executablePath: process.env.COWORK_WEB_UI_BROWSER_EXECUTABLE }
        : {}),
    });
    const recoveryUi = createBrowserRouteHarness();
    recoveryUi.setMode("pass", finalTaskId);
    const recoveredBrowserSession = await pairBrowser(
      host,
      socket,
      webManifest,
      browser,
      recoveryUi,
    );
    page = recoveredBrowserSession.page;
    activePage = page;
    await selectTaskById(page, recoveryUi, finalTaskId);
    await page.getByRole("button", { name: /Allow once/i }).waitFor({ state: "visible" });
    await inspectReviewUi(page, finalTaskId, "valid");
    const allow = page.getByRole("button", { name: /Allow once/i });
    assert.equal(await allow.isDisabled(), false);
    await allow.click();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await waitFor(
      () => (recoveryUi.lastRespond?.response?.result?.decision === "submitted" ? true : null),
      "the host to confirm the browser's submitted review decision",
    );
    await waitFor(async () => {
      const exists = await fs
        .readFile(path.join(workspacePath, relativePath), "utf8")
        .then((text) => text === expectedContent)
        .catch(() => false);
      if (!exists) return null;
      const claims = getClaimRows(finalTaskId);
      return claims.length === 1 &&
        claims[0].outcome === "committed" &&
        stub.toolCallCount === 2 &&
        stub.requests.length >= firstProviderCount + 2
        ? true
        : null;
    }, "the recovered task's exact write, committed claim, resumed tool call, and model continuation");
    assert(recoveryUi.lastRespond, "The browser must submit a real input_request.respond decision");
    assert.equal(recoveryUi.lastRespond.params.status, "submitted");
    assert.equal(
      recoveryUi.lastRespond.params.answers?.[decisionQuestionId]?.optionLabel,
      "Allow once",
    );
    assert.equal(
      stub.toolCallCount,
      2,
      "The explicit post-restart decision must resume one exact matching write tool call",
    );
    const resolvedReplay = await webRpc(
      host,
      recoveredBrowserSession.pairedSession,
      webManifest,
      "input_request.respond",
      recoveryUi.lastRespond.params,
      recoveryUi.lastRespond.operationKey,
    );
    assert.equal(
      resolvedReplay.error,
      undefined,
      "Replaying the same browser decision key should return its receipt",
    );
    assert.equal(resolvedReplay.result?.decision, "submitted");

    const finishedInput = readInputAndApproval(finalTaskId);
    assert.equal(finishedInput.linked.input_status, "submitted");
    assert.equal(
      JSON.parse(finishedInput.linked.answers)[decisionQuestionId].optionLabel,
      "Allow once",
    );
    assert.equal(finishedInput.approval.status, "approved");
    const decisionRows = readOnlyDb();
    let decision;
    try {
      decision = decisionRows
        .prepare(`
        SELECT action,request_revision_hash FROM responsibility_action_review_decisions WHERE approval_id=?
      `)
        .get(finishedInput.linked.approval_id);
    } finally {
      decisionRows.close();
    }
    assert.deepEqual(decision, {
      action: "allow_once",
      request_revision_hash: finishedInput.linked.revision_hash,
    });
    const claims = getClaimRows(finalTaskId);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].outcome, "committed");
    assert.equal(claims[0].action, "allow_once");
    assert.equal(claims[0].request_revision_hash, finishedInput.linked.revision_hash);
    assert.equal(claims[0].decision_revision_hash, finishedInput.linked.revision_hash);
    assert.equal(claims[0].execution_id.length > 0, true);
    const fileContents = await fs.readFile(path.join(workspacePath, relativePath));
    assert.equal(fileContents.toString("utf8"), expectedContent);
    assert.equal(crypto.createHash("sha256").update(fileContents).digest("hex"), contentSha256);
    const fileEvents = getFileEvents(finalTaskId);
    assert.equal(
      fileEvents.length,
      1,
      "One reviewed operation must emit exactly one file-created event",
    );
    assert.equal(fileEvents[0].payload.path, relativePath);
    assert.equal(fileEvents[0].payload.contentPreview, expectedContent);
    assert.equal(fileEvents[0].payload.previewTruncated, false);

    const { claimResponsibilityActionReviewInUnit } = require(
      path.join(root, "dist/daemon/electron/automation/responsibility-task-policy.js"),
    );
    const replayClaimDb = readOnlyDb();
    try {
      const replayed = claimResponsibilityActionReviewInUnit(replayClaimDb, {
        taskId: finalTaskId,
        workspaceId: fixture.workspaceId,
        workspacePath,
        approvalId: claims[0].approval_id,
        requestRevisionHash: claims[0].request_revision_hash,
        executionId: crypto.randomUUID(),
        canonicalPath: relativePath,
        contentSha256,
        contentBytes,
        responsibilityRun: firstRunBinding,
        runtime: "desktop",
      });
      assert.equal(
        replayed,
        false,
        "A fresh execution ID must not replay an already consumed one-time claim",
      );
    } finally {
      replayClaimDb.close();
    }
    assert.equal(getFileEvents(finalTaskId).length, 1);
    approvalResolutionWaitMs = Math.max(
      0,
      (finishedInput.linked.resolved_at ?? Date.now()) - finalInput.linked.requested_at,
    );

    const completionCountAfterCommit = stub.requests.length;
    assert.equal(
      stub.toolCallCount,
      2,
      "Decision replay must not issue another native write request",
    );
    await browser.close();
    browser = undefined;
    activePage = undefined;
    socket.close();
    socket = undefined;
    await stopDaemon(host);
    host = undefined;
    host = startDaemon(await freePort());
    token = await waitForReady(host);
    socket = await connectControlPlane(host.port, token);
    await sleep(1200);
    assert.equal(
      stub.requests.length,
      completionCountAfterCommit,
      "Completed work must not replay a provider request after restart",
    );
    const persisted = readOnlyDb();
    try {
      const role = persisted
        .prepare("SELECT name,display_name,system_prompt FROM agent_roles WHERE id=?")
        .get(fixture.agentRoleId);
      assert.equal(role.name, "stage73-private-writer");
      assert.equal(
        role.system_prompt,
        "Keep this private fixture identity and write only the exact reviewed file.",
      );
      const responsibilities = persisted
        .prepare(`
        SELECT b.id,b.revision,b.state,r.definition_json FROM bot_responsibilities b
        JOIN bot_responsibility_revisions r ON r.responsibility_id=b.id AND r.revision=b.revision
        WHERE b.workspace_id=? AND b.agent_role_id=? ORDER BY b.id
      `)
        .all(scope.workspaceId, scope.agentRoleId);
      assert.equal(responsibilities.length, 2);
      const actPersisted = responsibilities.find((row) => row.id === act.id);
      const observePersisted = responsibilities.find((row) => row.id === observeRevised.id);
      assert.equal(actPersisted.revision, 1);
      assert.equal(actPersisted.state, "active");
      assert.equal(JSON.parse(actPersisted.definition_json).mode, "act");
      assert.equal(observePersisted.revision, 2);
      assert.equal(observePersisted.state, "paused");
      assert.equal(JSON.parse(observePersisted.definition_json).mode, "observe");
      assert.equal(
        persisted
          .prepare("SELECT COUNT(*) AS count FROM routine_runs WHERE backing_task_id=?")
          .get(finalTaskId).count,
        1,
      );
    } finally {
      persisted.close();
    }
    assert.equal(
      await fs.readFile(path.join(workspacePath, relativePath), "utf8"),
      expectedContent,
    );
    assert.equal(getClaimRows(finalTaskId)[0]?.outcome, "committed");
    assert.equal(getFileEvents(finalTaskId).length, 1);
    const completedBinding = inputRunBinding(finalTaskId).agentConfig.responsibilityRun;
    assert.deepEqual(completedBinding, firstRunBinding);
    assert.equal(getInputStatusForDecision(finalTaskId), "submitted");

    const result = {
      status: "passed",
      phase: "compiled-default-inline-browser-write-approval",
      provider: "localhost deterministic OpenAI-compatible stub",
      providerEnvProvided: false,
      legacyPopupOptIn: false,
      realProviderOrChannelUsed: false,
      channelDelivery: false,
      customRoleAndResponsibilitiesPersisted: true,
      actRevision: act.revision,
      independentObserveRevision: observeRevised.revision,
      firstPendingRequestSurvivedRestartWithoutAutomaticReplay: true,
      originalPendingRunResolvedAfterRestart: true,
      exactContentSha256: contentSha256,
      exactContentBytes: contentBytes,
      committedClaimOutcome: "committed",
      duplicateWriteCount: Math.max(0, getFileEvents(finalTaskId).length - 1),
      rerunCount: 1,
      duplicateAdmissionReplayCount: 1,
      responsibilityRunCount: 1,
      providerRequestCount: stub.requests.length,
      postRestartProviderRequestCount: stub.requests.length - firstProviderCount,
      nativeWriteToolCalls: stub.toolCallCount,
      postRestartNativeWriteToolCalls: stub.toolCallCount - 1,
      humanWaitMs: null,
      approvalResolutionWaitMs,
      workQueryLatencyMs,
      configuredBudget: {
        maxTokens: actionDefinition.budget.maxTokens,
        maxCostUsd: actionDefinition.budget.maxCost,
      },
      actualCostUsd: null,
      effectUnknownCount: getClaimRows(finalTaskId).filter((row) => row.outcome === "uncertain")
        .length,
      elapsedMs: Date.now() - begunAt,
      renderedBrowserEvidence: renderedEvidencePaths,
      profileDeletedOnExit: true,
      buildNotRunByFixture: true,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (activePage) {
      const failureBase = path.join(os.tmpdir(), `cowork-stage73-failure-${Date.now()}`);
      await activePage
        .screenshot({ path: `${failureBase}.png`, fullPage: true })
        .catch(() => undefined);
      const body = await activePage
        .locator("body")
        .innerText()
        .catch(() => "<browser body unavailable>");
      await fs.writeFile(`${failureBase}.txt`, `${body}\n`).catch(() => undefined);
      process.stderr.write(`Browser failure evidence: ${failureBase}.png and ${failureBase}.txt\n`);
    }
    const daemonTail = host ? safeHostOutput(host).slice(-2400) : "unavailable";
    const safeStack = String(error?.stack || error)
      .replaceAll(profileDir, "[disposable-profile]")
      .replaceAll(workspacePath, "[disposable-workspace]")
      .replaceAll("stage73-local-only", "[redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .slice(0, 8_000);
    process.stderr.write(
      `Stage73 diagnostic summary: phase=${phase}; provider=${JSON.stringify(stub?.diagnostics() ?? { reached: false })}; daemonTail=${daemonTail}\n`,
    );
    throw new Error(safeStack);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    activePage = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    if (host)
      await stopDaemon(host).catch((error) => {
        process.stderr.write(`Stage73 daemon cleanup: ${error.message}\n`);
      });
    await stub?.close().catch(() => undefined);
    await fs.rm(profileDir, { recursive: true, force: true });
  }
}

function getInputStatusForDecision(taskId) {
  return listInputStatus(taskId);
}

main().catch((error) => {
  process.stderr.write(`Stage73 acceptance failed: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
