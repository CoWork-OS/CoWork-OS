#!/usr/bin/env node
// Real daemon, coordinator, permissions, SQLite and files; no model or third-party app.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-application-smoke-"));
process.env.COWORK_USER_DATA_DIR = path.join(root, "profile");
process.env.COWORK_HEADLESS = "1";
const dist = path.resolve(__dirname, "../../dist", process.env.COWORK_SMOKE_DIST || "electron");
const load = (relative) => require(path.join(dist, relative));
let manager;
let daemon;

async function main() {
  const { DatabaseManager } = load("electron/database/schema.js");
  const { SecureSettingsRepository } = load("electron/database/SecureSettingsRepository.js");
  const { WorkspaceStore, TaskStore } = load("electron/database/repositories.js");
  const { AgentDaemon } = load("electron/agent/daemon.js");
  const { ToolRegistry } = load("electron/agent/tools/registry.js");
  const { MemoryService } = load("electron/memory/MemoryService.js");
  const { ApplicationRouteSchema } = load("shared/application-execution.js");
  manager = new DatabaseManager();
  const db = manager.getDatabase();
  new SecureSettingsRepository(db);
  MemoryService.initialize(manager);
  daemon = new AgentDaemon(manager, { startupRecovery: false });
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const workspace = new WorkspaceStore(db).create("Local workspace", workspacePath, {
    read: true,
    write: true,
    delete: false,
    network: false,
    shell: false,
  });
  const task = new TaskStore(db).create({
    title: "Project notes",
    prompt: "<no-memory>Read and update the project notes</no-memory>",
    status: "executing",
    workspaceId: workspace.id,
    agentConfig: { accessProfileId: "full_access" },
  });
  // The normal executor passes the effective profile-scoped workspace to its registry.
  const registry = new ToolRegistry(daemon.getEffectiveWorkspaceForTask(task.id), daemon, task.id);
  const service = daemon.getApplicationExecutionService();
  const tool = async (action, extra = {}) =>
    (await registry.executeToolWithRuntime("application_operation", { action, ...extra })).result;
  const file = path.join(workspacePath, "notes.txt");
  fs.writeFileSync(file, "Original notes");
  const legacy = await tool("create", {
    request: {
      idempotencyKey: "legacy-read",
      capability: "cowork.tool",
      objective: "Read the project notes",
      input: { name: "read_file", arguments: { path: "notes.txt" } },
      resources: [{ kind: "file", system: "local", identity: file }],
    },
  });
  assert.equal((await tool("execute", { operationId: legacy.operationId })).status, "unverified");
  assert.match((await service.get(legacy.operationId)).result.data.output, /Original notes/);
  let loseReply = false;
  let writes = 0;
  const expected = "Revised project notes";
  const route = ApplicationRouteSchema.parse({
    id: "local-fixture.v1",
    adapterId: "local-fixture",
    adapterVersion: "1",
    capability: "fixture.notes.update",
    protocol: "native",
    control: "structured",
    environment: {
      id: "local-files",
      kind: "local",
      locality: "local",
      background: true,
      isolated: false,
    },
    resourceKinds: ["file"],
    effect: "write",
    replay: "never",
    preparationEffect: "read",
    qualified: true,
    description: "Controlled local file adapter",
    supports: {
      prepare: false,
      observe: true,
      cancel: false,
      verify: true,
      conditionalWrite: false,
      remoteFencing: false,
    },
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  });
  const result = () => ({
    kind: "artifact",
    summary: "Updated project notes",
    resources: [{ kind: "file", system: "local", identity: file, locator: file }],
    unmetCriteria: [],
  });
  service.catalog.register({
    route,
    validateInput: (input) => {
      assert.equal(input.content, expected);
    },
    readiness: async () => ({ ready: true }),
    execute: async (context) => {
      await context.tools.call("write_file", { path: "notes.txt", content: expected }, context);
      writes++;
      if (loseReply) throw new Error("Response lost after applying the file change");
      return { status: "completed", result: result() };
    },
    observe: async (context) => {
      const source = await context.tools.call("read_file", { path: "notes.txt" }, context);
      assert.match(source.content, /Revised project notes/);
      return { status: "completed", result: result() };
    },
    verify: async (context) => {
      const source = await context.tools.call("read_file", { path: "notes.txt" }, context);
      assert.match(source.content, /Revised project notes/);
      return {
        status: fs.readFileSync(file, "utf8") === expected ? "verified" : "contradicted",
        summary: "Fresh file readback matches the requested content",
        checkedAt: Date.now(),
        evidence: [{ source: file, claim: "Requested content is present in the native file" }],
      };
    },
  });
  const request = (key) => ({
    idempotencyKey: key,
    capability: route.capability,
    objective: "Update the project notes",
    input: { content: expected },
    resources: [{ kind: "file", system: "local", identity: file }],
    constraints: { backgroundRequired: true },
  });
  const first = await tool("create", { request: request("verified-write") });
  const firstOutcome = await tool("execute", { operationId: first.operationId });
  assert.equal(
    firstOutcome.status,
    "complete",
    JSON.stringify(await service.get(first.operationId)),
  );
  assert.equal(fs.readFileSync(file, "utf8"), expected);
  loseReply = true;
  const second = await tool("create", { request: request("lost-write") });
  assert.equal((await tool("execute", { operationId: second.operationId })).status, "unknown");
  await assert.rejects(
    registry.executeToolWithRuntime("write_file", {
      path: "notes.txt",
      content: "Duplicate change",
    }),
    /Reconcile pending application effects/,
  );
  assert.equal((await tool("reconcile", { operationId: second.operationId })).status, "complete");
  assert.equal(writes, 2);
  assert.equal(fs.readFileSync(file, "utf8"), expected);
  assert.equal(
    (await service.repository.attempts(second.operationId)).filter(
      (attempt) => attempt.phase === "execute",
    ).length,
    1,
  );
  const queued = await tool("create", { request: request("cancelled-proposal") });
  await daemon.cancelTask(task.id);
  assert.equal((await service.get(queued.operationId)).execution, "cancelled");
  await assert.rejects(
    tool("create", { request: request("after-cancellation") }),
    /cancelled|terminal/,
  );
  console.log(
    JSON.stringify({
      runtime: process.env.COWORK_SMOKE_DIST || "electron-build-on-node",
      passed: true,
      scenarios: [
        "legacy result stays unverified",
        "qualified result verifies through real tools",
        "lost effect blocks direct mutation",
        "original-route reconciliation avoids duplicate write",
        "task stop cancels queued application work",
      ],
    }),
  );
}
const watchdog = setTimeout(() => {
  console.error("Application execution smoke exceeded its 60-second deadline");
  process.exit(1);
}, 60_000);
async function cleanup() {
  await daemon?.shutdown();
  manager?.close();
  fs.rmSync(root, { recursive: true, force: true });
  clearTimeout(watchdog);
}
main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    process.exit(1);
  });
