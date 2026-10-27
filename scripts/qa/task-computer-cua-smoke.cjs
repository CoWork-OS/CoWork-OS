const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const root = process.cwd();
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-task-computer-cua-live-"));
process.env.COWORK_USER_DATA_DIR = path.join(folder, "profile");
process.env.COWORK_HEADLESS = "1";
const load = (p) => require(path.join(root, "dist/electron", p));
const { ExecutionEnvironmentController } = load(
  "electron/environments/ExecutionEnvironmentController.js",
);
const { ComputerViewService } = load("electron/computer-use/computer-view-service.js");
const { CuaEnvironmentBackend } = load("electron/environments/environment-backends.js");
const workspace = {
  id: "cua-live",
  path: folder,
  permissions: { read: true, write: true, delete: true, shell: true, network: true },
};
let task = {
  id: randomUUID(),
  workspaceId: workspace.id,
  status: "executing",
  agentConfig: {
    executionEnvironment: {
      backend: "cua",
      lifetime: "task",
      inputPaths: ["input.txt"],
      outputPaths: ["result.txt"],
    },
  },
};
fs.writeFileSync(path.join(folder, "input.txt"), "synthetic Cua input");
const daemon = {
  getTask: () => task,
  updateTask: (_id, u) => (task = { ...task, ...structuredClone(u) }),
  logEvent: () => {},
};
ComputerViewService.resetForTesting({ encodeFrame: () => null });
const c = new ExecutionEnvironmentController(workspace, daemon, task.id);
(async () => {
  try {
    console.log("Allocating local Cua Linux computer");
    await c.ensure();
    console.log("Allocated", task.agentConfig.executionEnvironmentBinding.resourceId);
    const attached = new CuaEnvironmentBackend();
    const binding = structuredClone(task.agentConfig.executionEnvironmentBinding);
    binding.selection.space = binding.resourceId;
    binding.owned = false;
    try {
      assert.equal((await attached.allocate(binding)).resourceId, binding.resourceId);
      await attached.release(binding); // A borrowed computer must remain usable below.
    } finally {
      await attached.close();
    }
    assert.equal(
      (await c.execute("run_command", { command: "cat input.txt" })).stdout,
      "synthetic Cua input",
    );
    await c.execute("write_file", { path: "result.txt", content: "Cua acceptance passed" });
    await c.execute("write_file", {
      path: "index.html",
      content:
        "<title>Cua live acceptance</title><button onclick=\"this.textContent='Verified'\">Verify</button>",
    });
    const server = await c.execute("run_command", {
      command: "python3 -m http.server 8765 --bind 127.0.0.1",
      background: true,
    });
    await c.execute("browser_navigate", { url: "http://127.0.0.1:8765" });
    let snap = await c.execute("browser_snapshot", {});
    assert.equal(snap.title, "Cua live acceptance");
    let b = snap.nodes.find((n) => n.name === "Verify");
    assert.ok(b);
    await c.execute("browser_click", { ref: b.ref });
    snap = await c.execute("browser_snapshot", {});
    assert.ok(snap.nodes.some((n) => n.name === "Verified"));
    const shot = await c.execute("desktop_screenshot", {});
    assert.ok(shot.imageBase64?.length > 100);
    ComputerViewService.getInstance().takeOver(task.id);
    await assert.rejects(c.execute("run_command", { command: "pwd" }), /taken over/);
    ComputerViewService.getInstance().handBack(task.id);
    await c.execute("stop_process", { process_id: server.process_id });
    await c.finish();
    const completed = task.agentConfig.executionEnvironmentBinding;
    assert.equal(completed.state, "released");
    assert.equal(completed.exported.length, 1);
    fs.writeFileSync(path.join(folder, "acceptance.json"), JSON.stringify(completed, null, 2));
    console.log(
      "PASS Cua imports, commands, files, guest-loopback browser, click/readback, screenshot, takeover, export and deletion. Evidence:",
      folder,
    );
  } catch (e) {
    console.error(e);
    fs.writeFileSync(path.join(folder, "failure.json"), JSON.stringify(task, null, 2));
    console.log("Failure evidence:", folder);
    process.exitCode = 1;
  } finally {
    const binding = task.agentConfig.executionEnvironmentBinding;
    try {
      if (binding?.owned && binding.state !== "released") {
        const cleanup = new CuaEnvironmentBackend();
        try {
          await cleanup.release(binding);
        } finally {
          await cleanup.close();
        }
      }
    } finally {
      await c.close();
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
