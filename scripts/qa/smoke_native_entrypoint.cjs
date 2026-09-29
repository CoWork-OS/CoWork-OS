const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const daemonEntry = path.join(root, "dist/daemon/daemon/main.js");
if (!fs.existsSync(daemonEntry))
  throw new Error("Run npm run build:daemon before this smoke check.");
const WebSocket = require(path.join(root, "node_modules/ws"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-p01-runtime-"));
const profile = path.join(ownedDir, "profile");
const workspace = path.join(ownedDir, "workspace");
fs.mkdirSync(profile, { mode: 0o700 });
fs.mkdirSync(workspace, { mode: 0o700 });
let child;
let childError;
let interrupted = false;
let rawLog = "";
let requestId = 0;
const clients = [];
const evidence = { mode: "actual-node-daemon-without-model", ownedDir, checks: [] };
const childRunning = () =>
  Boolean(child?.pid && child.exitCode === null && child.signalCode === null);
function interrupt() {
  interrupted = true;
  if (childRunning()) child.kill("SIGTERM");
  for (const ws of clients) ws.terminate();
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function socket(url) {
  const ws = new WebSocket(url);
  clients.push(ws);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket timeout")), 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  return ws;
}
async function rpc(ws, method, params) {
  const id = String(++requestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("RPC timeout: " + method));
    }, 5000);
    const onMessage = (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type !== "res" || frame.id !== id) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(frame);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}
(async () => {
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    COWORK_USER_DATA_DIR: profile,
    COWORK_HEADLESS: "1",
    COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
    COWORK_CONTROL_PLANE_PORT: String(port),
  };
  // cwd must be the disposable dir: daemon startup (migrateEnvToSettings) imports and renames
  // process.cwd()/.env, which would consume the developer's real .env if cwd were the repo root.
  child = spawn(
    process.execPath,
    [daemonEntry, "--headless", "--enable-control-plane", "--user-data-dir", profile],
    { cwd: ownedDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.once("error", (error) => {
    childError = error;
  });
  child.stdout.on("data", (b) => {
    rawLog += b.toString();
  });
  child.stderr.on("data", (b) => {
    rawLog += b.toString();
  });
  const deadline = Date.now() + 30000;
  let token;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("smoke check interrupted");
    if (childError) throw childError;
    token = rawLog.match(/Control Plane token: (\S+)/)?.[1];
    if (token && rawLog.includes("Control Plane listening:")) break;
    if (child.exitCode !== null) throw new Error("owned daemon exited " + child.exitCode);
    await sleep(100);
  }
  assert(token, "owned daemon did not expose its generated local token");
  evidence.checks.push("owned daemon started with fresh profile and no provider credentials");
  const url = "ws://127.0.0.1:" + port;
  const denied = await rpc(await socket(url), "workspace.list", {});
  assert.equal(denied.ok, false);
  evidence.checks.push("unauthenticated workspace.list rejected");
  const ws = await socket(url);
  const connected = await rpc(ws, "connect", { token, deviceName: "p01-disposable-smoke" });
  assert.equal(connected.ok, true);
  const created = await rpc(ws, "workspace.create", { name: "P01 disposable", path: workspace });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const workspaceId = created.payload?.workspace?.id || created.payload?.id;
  assert(workspaceId, JSON.stringify(created.payload));
  evidence.checks.push("authenticated workspace.create persisted disposable workspace");
  const task = await rpc(ws, "task.create", {
    workspaceId,
    title: "P01 no-provider failure fixture",
    prompt: "Report the phrase P01_RUNTIME_PROBE. No external resources are needed.",
    shellAccess: false,
  });
  const listing = await rpc(ws, "task.list", {});
  assert.equal(listing.ok, true, JSON.stringify(listing.error));
  const tasks = listing.payload?.tasks || listing.payload;
  assert(Array.isArray(tasks), JSON.stringify(listing.payload));
  const fixture = tasks.find((t) => t.title === "P01 no-provider failure fixture");
  assert(fixture, "task.create did not persist task");
  for (let i = 0; i < 30 && fixture.status !== "failed"; i++) {
    await sleep(100);
    const detail = await rpc(ws, "task.get", { taskId: fixture.id });
    Object.assign(fixture, detail.payload?.task || detail.payload);
  }
  assert.equal(fixture.status, "failed");
  assert.match(String(fixture.error || ""), /API key|subscription token|provider.*config/i);
  assert.notEqual(fixture.agentConfig?.shellAccess, true);
  evidence.checks.push(
    "unconfigured model task reached native failed terminal state; shellAccess ceiling preserved",
  );
  evidence.task = { createAccepted: task.ok, taskId: fixture.id, status: fixture.status };
  assert(!interrupted, "smoke check interrupted");
  evidence.success = true;
})()
  .catch((error) => {
    evidence.success = false;
    evidence.error = error.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const ws of clients) ws.terminate();
    if (childRunning()) {
      child.kill("SIGTERM");
      for (let i = 0; i < 50 && childRunning(); i++) await sleep(100);
      if (childRunning()) {
        child.kill("SIGKILL");
        for (let i = 0; i < 20 && childRunning(); i++) await sleep(50);
      }
    }
    evidence.child = {
      pid: child?.pid,
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
      stopped: Boolean(child?.pid && !childRunning()),
    };
    if (childRunning() || interrupted) {
      evidence.success = false;
      evidence.error = interrupted ? "smoke check interrupted" : "owned daemon did not stop";
      process.exitCode = 1;
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    const sanitized = rawLog.replace(/(Control Plane token:)\s*\S+/g, "$1 [redacted]");
    fs.writeFileSync(path.join(ownedDir, "runtime.log"), sanitized, { mode: 0o600 });
    fs.writeFileSync(
      path.join(ownedDir, "evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify(evidence, null, 2));
  });
