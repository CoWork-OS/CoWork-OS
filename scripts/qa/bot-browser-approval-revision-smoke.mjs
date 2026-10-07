#!/usr/bin/env node
/** Compiled Node/browser approval revision proof; synthetic fixture only. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const daemonEntry = path.join(root, "dist/daemon/daemon/main.js");
const controlCli = path.join(root, "bin/coworkctl.js");
const manifestPath = path.join(root, "dist/web/web-manifest.json");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-approval-revision-"));
const profile = path.join(directory, "profile");
const workspacePath = path.join(directory, "workspace");
const databasePath = path.join(profile, "cowork-os.db");

const environment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(environment, {
  COWORK_USER_DATA_DIR: profile,
  COWORK_PROFILE: "default",
  COWORK_HEADLESS: "1",
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_DISABLE_OS_KEYCHAIN: "1",
  COWORK_APPROVAL_PROMPTS: "on",
});

const seedCode = `
  const { DatabaseManager } = require('./dist/daemon/electron/database/schema.js');
  const { WorkspaceStore, TaskStore, ApprovalStore } = require('./dist/daemon/electron/database/repositories.js');
  const manager = new DatabaseManager();
  try {
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create(
      'Synthetic browser approval workspace',
      process.env.COWORK_FIXTURE_WORKSPACE,
      { read: true, write: false, delete: false, shell: false, network: false },
    );
    const task = new TaskStore(db).create({
      title: 'Synthetic pending approval',
      prompt: 'Fixture metadata only. Do not execute a model task.',
      workspaceId: workspace.id,
      status: 'blocked',
      terminalStatus: 'awaiting_approval',
    });
    const requestedAt = Date.now();
    const approval = new ApprovalStore(db).create({
      taskId: task.id,
      type: 'run_command',
      description: 'Review this synthetic command',
      details: { command: 'node fixture --mode first', params: { mode: 'first' } },
      status: 'pending',
      requestedAt,
    });
    process.stdout.write('FIXTURE=' + JSON.stringify({
      workspaceId: workspace.id,
      taskId: task.id,
      approvalId: approval.id,
      requestedAt,
    }) + '\\n');
  } finally {
    manager.close();
  }
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function runSeed() {
  const result = spawnSync(process.execPath, ["-e", seedCode], {
    cwd: root,
    env: { ...environment, COWORK_FIXTURE_WORKSPACE: workspacePath },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `Synthetic fixture setup failed: ${result.stderr}`);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("FIXTURE="));
  assert(line, "Synthetic fixture setup did not return its IDs");
  return JSON.parse(line.slice("FIXTURE=".length));
}

function startDaemon(port) {
  const childEnvironment = {
    ...environment,
    COWORK_WEB_ENABLED: "1",
    COWORK_WEB_PUBLIC_ORIGIN: "",
    COWORK_WEB_TRUSTED_PROXY_ADDRESSES: "",
    COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
    COWORK_CONTROL_PLANE_PORT: String(port),
    COWORK_CONTROL_PLANE_TOKEN: "",
    COWORK_BOOTSTRAP_WORKSPACE_PATH: workspacePath,
    COWORK_BOOTSTRAP_WORKSPACE_NAME: "Synthetic approval acceptance workspace",
  };
  const child = spawn(
    process.execPath,
    [
      daemonEntry,
      "--headless",
      "--enable-control-plane",
      "--print-control-plane-token",
      "--no-import-env-settings",
      "--user-data-dir",
      profile,
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
  host.exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return host;
}

function redactedOutput(host) {
  return host.output.replace(/Control Plane token: \S+/g, "Control Plane token: [redacted]");
}

async function waitForReady(host) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const token = host.output.match(/Control Plane token: ([A-Za-z0-9_-]+)/)?.[1];
    if (token && host.output.includes("Browser app enabled.")) return token;
    if (host.child.exitCode !== null || host.child.signalCode !== null) {
      throw new Error(
        `Disposable daemon exited during startup: ${redactedOutput(host).slice(-3_000)}`,
      );
    }
    await sleep(100);
  }
  throw new Error(`Disposable daemon startup timed out: ${redactedOutput(host).slice(-3_000)}`);
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

async function callControlPlane(port, token, method) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [controlCli, "--url", `ws://127.0.0.1:${port}`, "call", method],
    {
      cwd: root,
      env: { ...environment, COWORK_CONTROL_PLANE_TOKEN: token },
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  );
  const response = JSON.parse(stdout);
  assert.equal(response.ok, true, `Control Plane ${method} failed`);
  return response.payload;
}

async function pairBrowser(host, token, manifest) {
  const pairing = await callControlPlane(host.port, token, "web.pair");
  assert.equal(typeof pairing?.code, "string");
  const pair = await fetch(`${host.base}/api/web/v1/session/pair`, {
    method: "POST",
    headers: { Origin: host.base, "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(pair.status, 200, "Browser pairing failed");
  const cookie = pair.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, "Browser pairing did not set a session cookie");
  const bootstrapResponse = await fetch(`${host.base}/api/web/v1/session/bootstrap`, {
    headers: { Cookie: cookie, Origin: host.base },
  });
  assert.equal(bootstrapResponse.status, 200, "Browser session bootstrap failed");
  const session = await bootstrapResponse.json();
  assert.equal(session.apiVersion, manifest.apiVersion);
  return { cookie, session };
}

async function rpc(host, paired, manifest, method, params, operationKey) {
  const response = await fetch(`${host.base}/api/web/v1/rpc`, {
    method: "POST",
    headers: {
      Origin: host.base,
      Cookie: paired.cookie,
      "X-CoWork-CSRF": paired.session.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiVersion: manifest.apiVersion,
      type: "request",
      id: `fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method,
      params,
      ...(operationKey ? { operationKey } : {}),
    }),
  });
  assert.equal(response.status, 200, `${method} HTTP ${response.status}`);
  return response.json();
}

async function call(host, paired, manifest, method, params, operationKey) {
  const frame = await rpc(host, paired, manifest, method, params, operationKey);
  assert.equal(frame.error, undefined, `${method}: ${frame.error?.message ?? "RPC error"}`);
  return frame.result;
}

function expectStale(frame, label) {
  assert.equal(frame.error?.code, "STALE_STATE", `${label} did not reject the stale review`);
}

function mutateApprovalDetails(fixture) {
  const Database = require("better-sqlite3");
  const db = new Database(databasePath);
  try {
    db.pragma("busy_timeout = 5000");
    const before = db
      .prepare("SELECT requested_at, status FROM approvals WHERE id = ?")
      .get(fixture.approvalId);
    assert.equal(before?.requested_at, fixture.requestedAt);
    assert.equal(before?.status, "pending");
    const changed = db
      .prepare(
        "UPDATE approvals SET details = ? WHERE id = ? AND requested_at = ? AND status = 'pending'",
      )
      .run(
        JSON.stringify({ command: "node fixture --mode revised", params: { mode: "revised" } }),
        fixture.approvalId,
        fixture.requestedAt,
      );
    assert.equal(changed.changes, 1, "Synthetic approval details were not updated");
    const after = db
      .prepare("SELECT requested_at, status, details FROM approvals WHERE id = ?")
      .get(fixture.approvalId);
    assert.equal(
      after.requested_at,
      fixture.requestedAt,
      "Fixture unexpectedly changed requestedAt",
    );
    assert.equal(after.status, "pending");
    assert.equal(JSON.parse(after.details).command, "node fixture --mode revised");
  } finally {
    db.close();
  }
}

function assertDatabaseState(fixture, expectedApprovalStatus, expectedTaskStatus) {
  const Database = require("better-sqlite3");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const approvals = db
      .prepare("SELECT status, requested_at FROM approvals WHERE id = ?")
      .get(fixture.approvalId);
    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(fixture.taskId);
    assert(approvals, "Fixture approval disappeared");
    assert(task, "Fixture task disappeared");
    assert.equal(approvals.status, expectedApprovalStatus);
    assert.equal(approvals.requested_at, fixture.requestedAt);
    assert.equal(task.status, expectedTaskStatus);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
  } finally {
    db.close();
  }
}

function assertPendingFixtureState(fixture, boundary) {
  const Database = require("better-sqlite3");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const approval = db
      .prepare("SELECT status, requested_at FROM approvals WHERE id = ?")
      .get(fixture.approvalId);
    const task = db
      .prepare("SELECT status, terminal_status FROM tasks WHERE id = ?")
      .get(fixture.taskId);
    assert.equal(approval?.status, "pending", `${boundary}: seeded approval must remain pending`);
    assert.equal(approval?.requested_at, fixture.requestedAt);
    assert.equal(task?.status, "blocked", `${boundary}: fixture task must remain blocked`);
    assert.equal(
      task?.terminal_status,
      "awaiting_approval",
      `${boundary}: fixture task must retain its durable approval wait state`,
    );
  } finally {
    db.close();
  }
}

function listParams(fixture) {
  return { workspaceId: fixture.workspaceId, taskId: fixture.taskId, limit: 20, offset: 0 };
}

function lookupParams(fixture, approval) {
  return {
    approvalId: fixture.approvalId,
    workspaceId: fixture.workspaceId,
    taskId: fixture.taskId,
    expectedVersion: approval.expectedVersion,
    expectedRevisionHash: approval.revisionHash,
  };
}

function decisionParams(fixture, approval, approved = false) {
  return { ...lookupParams(fixture, approval), approved };
}

async function main() {
  let host;
  try {
    await fs.access(daemonEntry);
    await fs.access(controlCli);
    await fs.access(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert(Number.isSafeInteger(manifest.apiVersion));
    await fs.mkdir(workspacePath, { recursive: true });
    const fixture = runSeed();
    const proof = {};
    assertPendingFixtureState(fixture, "before daemon start");

    host = startDaemon(await freePort());
    const firstToken = await waitForReady(host);
    assertPendingFixtureState(fixture, "after daemon ready");
    const firstSession = await pairBrowser(host, firstToken, manifest);
    const firstList = await call(
      host,
      firstSession,
      manifest,
      "approval.list",
      listParams(fixture),
    );
    const displayedBeforeRestart = firstList.approvals?.find(
      (row) => row.id === fixture.approvalId,
    );
    assert(displayedBeforeRestart, "Seeded approval was absent from the browser pending list");
    assert.match(displayedBeforeRestart.revisionHash, /^[0-9a-f]{64}$/);
    assert.equal(displayedBeforeRestart.expectedVersion, fixture.requestedAt);
    assert.equal(displayedBeforeRestart.details.command, "node fixture --mode first");
    assert.equal(displayedBeforeRestart.status, "pending");
    await stopDaemon(host);
    host = undefined;

    host = startDaemon(await freePort());
    const secondToken = await waitForReady(host);
    const secondSession = await pairBrowser(host, secondToken, manifest);
    const unchanged = await call(
      host,
      secondSession,
      manifest,
      "approval.get",
      lookupParams(fixture, displayedBeforeRestart),
    );
    assert.equal(unchanged.approval.status, "pending");
    assert.equal(unchanged.approval.revisionHash, displayedBeforeRestart.revisionHash);
    proof.restartPreservedDisplayedRevision = true;

    mutateApprovalDetails(fixture);
    const staleRead = await rpc(
      host,
      secondSession,
      manifest,
      "approval.get",
      lookupParams(fixture, displayedBeforeRestart),
    );
    expectStale(staleRead, "approval.get");
    const staleDecision = await rpc(
      host,
      secondSession,
      manifest,
      "approval.respond",
      decisionParams(fixture, displayedBeforeRestart),
      "synthetic-browser-approval-revision-operation",
    );
    expectStale(staleDecision, "approval.respond");
    assertDatabaseState(fixture, "pending", "blocked");

    const changedList = await call(
      host,
      secondSession,
      manifest,
      "approval.list",
      listParams(fixture),
    );
    const displayedAfterChange = changedList.approvals?.find(
      (row) => row.id === fixture.approvalId,
    );
    assert(displayedAfterChange, "Changed pending review disappeared after stale rejection");
    assert.notEqual(displayedAfterChange.revisionHash, displayedBeforeRestart.revisionHash);
    assert.equal(displayedAfterChange.expectedVersion, displayedBeforeRestart.expectedVersion);
    assert.equal(displayedAfterChange.details.command, "node fixture --mode revised");
    proof.changedReviewWasRetained = true;

    const current = await call(
      host,
      secondSession,
      manifest,
      "approval.get",
      lookupParams(fixture, displayedAfterChange),
    );
    assert.equal(current.approval.status, "pending");
    assert.equal(current.approval.revisionHash, displayedAfterChange.revisionHash);
    const operationKey = "synthetic-browser-approval-revision-operation";
    const denied = await call(
      host,
      secondSession,
      manifest,
      "approval.respond",
      decisionParams(fixture, displayedAfterChange, false),
      operationKey,
    );
    assert.equal(denied.status, "handled");
    assert.equal(denied.decision, "denied");
    const afterDecision = await call(
      host,
      secondSession,
      manifest,
      "approval.get",
      lookupParams(fixture, displayedAfterChange),
    );
    assert.equal(afterDecision.approval.status, "denied");
    assert.equal(afterDecision.approval.revisionHash, displayedAfterChange.revisionHash);
    const replay = await call(
      host,
      secondSession,
      manifest,
      "approval.respond",
      decisionParams(fixture, displayedAfterChange, false),
      operationKey,
    );
    assert.deepEqual(
      replay,
      denied,
      "Replaying the bound operation did not return its saved receipt",
    );
    const afterReplay = await call(
      host,
      secondSession,
      manifest,
      "approval.get",
      lookupParams(fixture, displayedAfterChange),
    );
    assert.deepEqual(afterReplay.approval, afterDecision.approval);
    const staleReceipt = await rpc(
      host,
      secondSession,
      manifest,
      "approval.respond",
      decisionParams(fixture, displayedBeforeRestart),
      operationKey,
    );
    expectStale(staleReceipt, "stale approval receipt replay");
    assertDatabaseState(fixture, "denied", "paused");
    proof.staleReviewRejectedAndPreserved = true;
    proof.freshRevisionDeniedOnce = true;
    proof.boundReceiptReplayedExactly = true;
    proof.staleReceiptCouldNotOverrideRevision = true;
    proof.modelExecution = false;
    proof.providerEnvironmentProvided = false;
    proof.legacyQueueOptIn = true;
    proof.taskCount = 1;
    console.log(JSON.stringify({ fixture: "synthetic-local-browser-approval", ...proof }));
  } finally {
    try {
      await stopDaemon(host);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      await assert.rejects(fs.access(directory), "Temporary acceptance profile was not removed");
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
