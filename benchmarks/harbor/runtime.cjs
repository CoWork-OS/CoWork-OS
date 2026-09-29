/* Bounded in-container runtime controller. It invokes only the installed coworkctl CLI. */
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const APP = "/opt/cowork-os";
const HARNESS = "/opt/cowork-os-harness";
const STATE_FILE = "/tmp/cowork-os-p04-state.json";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const RUN_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];

function minimalEnv(overrides) {
  const env = {};
  for (const key of RUN_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  env.PATH = env.PATH || "/usr/local/bin:/usr/bin:/bin";
  env.HOME = env.HOME || "/home/node";
  env.TMPDIR = env.TMPDIR || "/tmp";
  env.LANG = "C.UTF-8";
  return { ...env, ...overrides };
}
function fail(message) { throw new Error(message); }
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}
function writeState(state) {
  const temp = STATE_FILE + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temp, STATE_FILE);
  fs.chmodSync(STATE_FILE, 0o600);
}
function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === "EPERM"; }
}
function processGroupExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try { stat = fs.readFileSync(path.join("/proc", entry, "stat"), "utf8"); }
      catch { continue; }
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const state = fields[0];
      const processGroup = Number(fields[2]);
      if (processGroup === pid && state !== "Z" && state !== "X") return true;
    }
    return false;
  } catch {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return error && error.code === "EPERM"; }
  }
}
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(predicate, deadlineMs, label) {
  while (Date.now() < deadlineMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(label + " startup deadline exceeded");
}
function readToken(state) {
  let text = "";
  try { text = fs.readFileSync(state.daemonLog, "utf8"); }
  catch { return null; }
  const match = text.match(/Control Plane token: (\S+)/);
  return match ? match[1] : null;
}
function coworkctl(state, method, params, timeoutMs = 5000) {
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,100}$/.test(method)) fail("invalid Control Plane method");
  const token = readToken(state);
  if (!token) fail("owned daemon Control Plane token is unavailable");
  const command = path.join(APP, "bin", "coworkctl.js");
  const result = spawnSync(process.execPath, [command, "call", method, JSON.stringify(params || {})], {
    cwd: APP,
    env: minimalEnv({
      COWORK_CONTROL_PLANE_URL: "ws://127.0.0.1:" + state.controlPort,
      COWORK_CONTROL_PLANE_TOKEN: token,
    }),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) fail("coworkctl failed: " + String(result.error.message || result.error));
  let parsed;
  try { parsed = JSON.parse(result.stdout || "{}"); }
  catch { fail("coworkctl returned invalid JSON"); }
  if (result.status !== 0 || parsed.ok !== true) {
    const error = parsed.error || {};
    fail("coworkctl " + method + " failed: " + String(error.message || "request error").slice(0, 300));
  }
  return parsed.payload;
}
function jsonOutput(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
async function start(scenario) {
  if (!new Set(["correct", "wrong", "no-proof", "timeout"]).has(scenario)) fail("unsupported fixture case");
  if (readState()) fail("a P04 runtime is already active");
  const profile = "/tmp/cowork-os-p04-profile-" + crypto.randomUUID();
  const daemonLog = path.join(profile, "daemon.log");
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.chmodSync(profile, 0o700);
  fs.mkdirSync("/workspace", { recursive: true });
  const controlPort = await reservePort();
  const providerPort = await reservePort();
  const providerLog = path.join(profile, "provider.log");
  const providerStats = path.join(profile, "provider-stats.json");
  const providerFd = fs.openSync(providerLog, "a", 0o600);
  const provider = spawn(process.execPath, [path.join(HARNESS, "mock_ollama.cjs"), scenario, String(providerPort), providerStats], {
    cwd: HARNESS, detached: true, stdio: ["ignore", providerFd, providerFd], env: minimalEnv({}),
  });
  fs.closeSync(providerFd);
  provider.unref();
  const providerPid = provider.pid;
  const state = {
    schemaVersion: 1, scenario, profile, daemonLog, providerLog, providerStats,
    daemonPid: null, providerPid, controlPort, providerPort,
    startedAt: new Date().toISOString(), workspacePath: "/workspace",
    taskId: null, workspaceId: null,
  };
  writeState(state);
  const providerReadyAt = Date.now() + 5000;
  await waitFor(() => {
    try { return fs.readFileSync(providerLog, "utf8").includes("P04_PROVIDER_READY " + String(providerPort)); }
    catch { return false; }
  }, providerReadyAt, "local fixture provider");

  const daemonFd = fs.openSync(daemonLog, "a", 0o600);
  const daemon = spawn(process.execPath, [
    path.join(APP, "bin", "coworkd-node.js"),
    "--headless", "--enable-control-plane", "--import-env-settings",
    "--user-data-dir", profile,
  ], {
    cwd: APP,
    detached: true,
    stdio: ["ignore", daemonFd, daemonFd],
    env: minimalEnv({
      COWORK_USER_DATA_DIR: profile,
      COWORK_HEADLESS: "1",
      COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
      COWORK_CONTROL_PLANE_PORT: String(controlPort),
      COWORK_IMPORT_ENV_SETTINGS: "1",
      COWORK_LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://127.0.0.1:" + providerPort,
      OLLAMA_MODEL: "p04-fixture",
    }),
  });
  fs.closeSync(daemonFd);
  daemon.unref();
  state.daemonPid = daemon.pid;
  writeState(state);
  const deadline = Date.now() + 30000;
  await waitFor(() => {
    if (!processExists(state.daemonPid)) fail("coworkd-node exited during startup");
    try {
      const log = fs.readFileSync(daemonLog, "utf8");
      return log.includes("Control Plane listening:") && readToken(state);
    } catch { return false; }
  }, deadline, "coworkd-node");
  coworkctl(state, "config.get", {}, 5000);
  jsonOutput({ ok: true, scenario, controlPort, providerPort, nodeVersion: process.version });
}

function handleCall(method, params) {
  const state = readState();
  if (!state) fail("P04 runtime is not active");
  const result = coworkctl(state, method, params);
  if (method === "workspace.create") {
    state.workspaceId = result.workspace && result.workspace.id;
    writeState(state);
  }
  if (method === "task.create") {
    state.taskId = result.taskId || (result.task && result.task.id);
    writeState(state);
  }
  jsonOutput({ ok: true, payload: result });
}

function stopGroup(pid) {
  if (!processGroupExists(pid)) return { stopped: true, alreadyExited: true };
  try { process.kill(-pid, "SIGTERM"); }
  catch (error) { if (!error || error.code !== "ESRCH") return { stopped: false, error: String(error.message || error) }; }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && processGroupExists(pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  let forced = false;
  if (processGroupExists(pid)) {
    forced = true;
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if (!error || error.code !== "ESRCH") return { stopped: false, error: String(error.message || error), forced }; }
  }
  const finalDeadline = Date.now() + 1500;
  while (Date.now() < finalDeadline && processGroupExists(pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return { stopped: !processGroupExists(pid), forced };
}
function stop() {
  const state = readState();
  if (!state) { jsonOutput({ ok: true, cleanup: { status: "succeeded", reason: "runtime already absent" } }); return; }
  const daemon = state.daemonPid ? stopGroup(state.daemonPid) : { stopped: true, alreadyExited: true };
  const provider = stopGroup(state.providerPid);
  let profileRemoved = false;
  let providerUsage = null;
  try {
    const stats = JSON.parse(fs.readFileSync(state.providerStats, "utf8"));
    if (stats && typeof stats === "object") providerUsage = stats;
  } catch {}
  if (daemon.stopped && provider.stopped) {
    try { fs.rmSync(state.profile, { recursive: true, force: true }); profileRemoved = !fs.existsSync(state.profile); }
    catch { profileRemoved = false; }
  }
  const ok = daemon.stopped && provider.stopped && profileRemoved;
  if (ok) { try { fs.rmSync(STATE_FILE, { force: true }); } catch {} }
  jsonOutput({ ok, cleanup: {
    status: ok ? "succeeded" : "failed",
    daemonStopped: daemon.stopped,
    daemonForced: daemon.forced || false,
    providerStopped: provider.stopped,
    providerForced: provider.forced || false,
    providerUsage,
    profileRemoved,
  } });
  if (!ok) process.exitCode = 2;
}

function usage() {
  fail("usage: runtime.cjs start <case> | call <method> <json> | stop");
}

(async () => {
  try {
    const command = process.argv[2];
    if (command === "start") await start(process.argv[3]);
    else if (command === "call") {
      let params;
      try { params = JSON.parse(process.argv[4] || "{}"); }
      catch { fail("coworkctl params are invalid JSON"); }
      handleCall(process.argv[3], params);
    } else if (command === "stop") stop();
    else usage();
  } catch (error) {
    const message = String(error && error.message || error).replace(/Control Plane token: \S+/g, "Control Plane token: [redacted]").slice(0, 500);
    jsonOutput({ ok: false, error: message });
    process.exitCode = 1;
  }
})();
