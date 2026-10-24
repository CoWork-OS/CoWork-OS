#!/usr/bin/env node
// Real Linux-container acceptance using synthetic files. No model, account or host app data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-task-computer-live-"));
process.env.COWORK_USER_DATA_DIR = path.join(folder, "profile");
process.env.COWORK_HEADLESS = "1";
const { ExecutionEnvironmentController } = require("../../dist/electron/electron/environments/ExecutionEnvironmentController.js");
const { BotDesktopManager } = require("../../dist/electron/electron/computer-use/bot-desktop-manager.js");
const { ComputerViewService } = require("../../dist/electron/electron/computer-use/computer-view-service.js");

async function main() {
  const host = path.join(folder, "workspace"); fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, "input.txt"), "synthetic input");
  const tasks = new Map();
  const manager = BotDesktopManager.configure({ dataDir: () => folder, resourcesDir: () => path.resolve("resources/bot-desktop") });
  ComputerViewService.resetForTesting({ encodeFrame: () => null });
  const workspace = { id: "synthetic-workspace", path: host, permissions: { read: true, write: true, delete: true, shell: true, network: true } };
  const daemon = {
    getTask: (id) => tasks.get(id),
    updateTask: (id, update) => tasks.set(id, { ...tasks.get(id), ...structuredClone(update) }),
    logEvent: (_id, type, event) => { if (type === "artifact_created") console.log("Published:", event.path); },
  };
  const make = (id) => {
    tasks.set(id, { id, workspaceId: workspace.id, status: "executing", agentConfig: { executionEnvironment: {
      backend: "bot-desktop", lifetime: "task", inputPaths: ["input.txt"], outputPaths: ["result.txt"],
    } } });
    return new ExecutionEnvironmentController(workspace, daemon, id);
  };
  const a = make("computer-a"), b = make("computer-b");
  let server;
  let database;
  let realDaemon;
  let registry;
  let realTask;
  try {
    console.log("Preparing two independent Linux desktops; first use may build the image.");
    await Promise.all([a.ensure(), b.ensure()]);
    assert.notEqual(tasks.get("computer-a").agentConfig.executionEnvironmentBinding.resourceId, tasks.get("computer-b").agentConfig.executionEnvironmentBinding.resourceId);
    await Promise.all([
      a.execute("write_file", { path: "result.txt", content: "first computer" }),
      b.execute("write_file", { path: "result.txt", content: "second computer" }),
    ]);
    assert.equal((await a.execute("run_command", { command: "cat input.txt && cat result.txt" })).stdout, "synthetic inputfirst computer");
    assert.equal((await b.execute("read_file", { path: "result.txt" })).content, "second computer");
    assert.equal(fs.existsSync(path.join(host, "result.txt")), false);
    await a.execute("write_file", { path: "index.html", content: '<title>Guest acceptance</title><h1>Ready in the guest</h1><button onclick="this.textContent=\'Clicked\'">Run</button>' });
    // Fixture listener is inside the guest and bound explicitly to guest loopback.
    server = await a.execute("run_command", { command: "python3 -m http.server 8765 --bind 127.0.0.1", background: true });
    const navigation = await a.execute("browser_navigate", { url: "http://127.0.0.1:8765" });
    assert.equal(navigation.success, true, JSON.stringify(navigation));
    let snapshot = await a.execute("browser_snapshot", {});
    assert.equal(snapshot.title, "Guest acceptance", JSON.stringify(snapshot));
    const button = snapshot.nodes.find((node) => node.name === "Run"); assert.ok(button);
    assert.equal((await a.execute("browser_click", { ref: button.ref })).success, true);
    snapshot = await a.execute("browser_snapshot", {});
    assert.ok(snapshot.nodes.some((node) => node.name === "Clicked"));
    const image = await a.execute("desktop_screenshot", {});
    assert.ok(image.imageBase64?.length > 100);
    const view = ComputerViewService.getInstance();
    view.takeOver("computer-a");
    await assert.rejects(a.execute("run_command", { command: "pwd" }), /taken over/);
    view.handBack("computer-a");
    await a.execute("stop_process", { process_id: server.process_id }); server = undefined;
    for (const computer of [a, b]) await computer.finish();
    for (const task of tasks.values()) {
      const binding = task.agentConfig.executionEnvironmentBinding;
      assert.equal(binding.state, "released");
      assert.equal(binding.exported.length, 1);
      assert.equal(fs.existsSync(manager.homeFolder(manager.restoreEnvironment(binding.resourceId))), false);
      let exists = true;
      try { execFileSync("docker", ["inspect", `cowork-desktop-${require("../../dist/electron/electron/computer-use/bot-desktop-manager.js").botDesktopKey(manager.restoreEnvironment(binding.resourceId))}`], { stdio: "ignore" }); } catch { exists = false; }
      assert.equal(exists, false);
    }
    // Exercise the actual coordinator/policy/SQLite boundary as well as backend conformance.
    const load = (name) => require(path.resolve("dist/electron", name));
    const { DatabaseManager } = load("electron/database/schema.js");
    const { SecureSettingsRepository } = load("electron/database/SecureSettingsRepository.js");
    const { MemoryService } = load("electron/memory/MemoryService.js");
    const { AgentDaemon } = load("electron/agent/daemon.js");
    const { WorkspaceStore, TaskStore } = load("electron/database/repositories.js");
    const { ToolRegistry } = load("electron/agent/tools/registry.js");
    database = new DatabaseManager();
    const db = database.getDatabase();
    new SecureSettingsRepository(db); MemoryService.initialize(database);
    realDaemon = new AgentDaemon(database, { startupRecovery: false });
    const realWorkspace = new WorkspaceStore(db).create("Computer acceptance", host, workspace.permissions);
    realTask = new TaskStore(db).create({ title: "Computer acceptance", prompt: "<no-memory>Write and read synthetic guest data</no-memory>",
      status: "executing", workspaceId: realWorkspace.id, agentConfig: { accessProfileId: "full_access", executionEnvironment: {
        backend: "bot-desktop", lifetime: "task", inputPaths: [], outputPaths: ["policy.txt"],
      } } });
    registry = new ToolRegistry(realDaemon.getEffectiveWorkspaceForTask(realTask.id), realDaemon, realTask.id);
    const call = async (name, input) => (await registry.executeToolWithRuntime(name, input)).result;
    assert.equal((await call("write_file", { path: "policy.txt", content: "guest through real policy" })).success, true);
    assert.equal((await call("run_command", { command: "cat policy.txt" })).stdout, "guest through real policy");
    await call("write_file", { path: "index.html", content: '<title>Policy guest browser</title><button>Guest only</button>' });
    const policyServer = await call("run_command", { command: "python3 -m http.server 8765 --bind 127.0.0.1", background: true });
    assert.equal((await call("browser_navigate", { url: "http://127.0.0.1:8765" })).success, true);
    assert.equal((await call("browser_snapshot", {})).title, "Policy guest browser");
    await call("stop_process", { process_id: policyServer.process_id });
    assert.equal(fs.existsSync(path.join(host, "policy.txt")), false);
    await assert.rejects(call("native_app", { action: "list_apps" }), /unavailable|denied|disabled|not allowed|blocked/);
    const restricted = new ToolRegistry(realDaemon.getEffectiveWorkspaceForTask(realTask.id), realDaemon, realTask.id, undefined, ["run_command"]);
    await assert.rejects(restricted.executeToolWithRuntime("run_command", { command: "pwd" }), /denied|blocked|restricted|not allowed/);
    await realDaemon.completeTask(realTask.id, "Synthetic guest work completed");
    assert.equal(realDaemon.getTask(realTask.id).agentConfig.executionEnvironmentBinding.state, "released");
    await registry.cleanup(); registry = undefined;
    await realDaemon.shutdown(); realDaemon = undefined;
    database.close(); database = undefined;
    console.log("PASS: two computers, import, commands, guest-loopback browser, click/readback, screenshot, takeover, exports, real policy/SQLite routing, host-tool denial, command restriction and completion cleanup.");
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (error) {
    console.error("Synthetic evidence retained:", folder);
    throw error;
  } finally {
    await registry?.cleanup().catch(() => undefined);
    const realBinding = realTask && realDaemon?.getTask(realTask.id)?.agentConfig?.executionEnvironmentBinding;
    if (realBinding?.owned && realBinding.state !== "released") await manager.deleteEnvironment(realBinding.resourceId).catch(() => undefined);
    await realDaemon?.shutdown().catch(() => undefined);
    database?.close();
    if (server) await a.execute("stop_process", { process_id: server.process_id }).catch(() => undefined);
    // Only resources created by this smoke test are eligible for cleanup.
    for (const task of tasks.values()) {
      const binding = task.agentConfig.executionEnvironmentBinding;
      if (binding?.owned && binding.state !== "released") await manager.deleteEnvironment(binding.resourceId).catch(() => undefined);
    }
    manager.dispose(); await a.close(); await b.close();
  }
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
