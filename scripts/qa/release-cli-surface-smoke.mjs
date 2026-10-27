// Installed entrypoint acceptance with a deterministic loopback provider, never a real model.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const pkg = path.resolve(process.argv[2] || process.cwd());
assert.ok(fs.existsSync(path.join(pkg, "bin/cowork-cli.js")), "Expected an installed package");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-cli-release-smoke-"));
const inherited = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
  ]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
let requests = 0;
const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) {
    /* Drain the synthetic request. */
  }
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/tags") {
    res.end(JSON.stringify({ models: [{ name: "release-fixture", model: "release-fixture" }] }));
  } else if (req.url === "/api/show") {
    res.end(
      JSON.stringify({
        capabilities: ["completion", "tools"],
        model_info: { "general.context_length": 32768 },
      }),
    );
  } else if (req.url === "/api/chat") {
    requests++;
    res.end(
      JSON.stringify({
        model: "release-fixture",
        message: {
          role: "assistant",
          content: "I am CoWork OS. Synthetic local CLI validation passed.",
        },
        done: true,
        prompt_eval_count: 10,
        eval_count: 12,
      }),
    );
  } else {
    res.writeHead(404).end();
  }
});

function stopGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function run(entry, args, env, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pkg, "bin", entry), ...args], {
      cwd: root,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const capture = (data) => {
      output = (output + data).slice(-1024 * 1024);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup(child, "SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve(output);
      else
        reject(
          new Error(
            `${entry} ${args[0] || ""} ${timedOut ? "timed out before clean exit" : `exited ${code}`}\n${output.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")}`,
          ),
        );
    });
  });
}

async function checkLauncher(env) {
  const profile = path.join(root, "launcher-profile");
  const child = spawn(
    process.execPath,
    [path.join(pkg, "bin", "cowork.js"), "--headless", "--enable-control-plane"],
    {
      cwd: pkg,
      env: {
        ...env,
        COWORK_USER_DATA_DIR: profile,
        COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
        COWORK_CONTROL_PLANE_PORT: "0",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (data) => {
    output = (output + data).slice(-32768);
  });
  child.stderr.on("data", (data) => {
    output = (output + data).slice(-32768);
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const deadline = Date.now() + 90000;
  try {
    let discovery;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Desktop launcher exited before readiness\n${output.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")}`,
        );
      try {
        discovery = JSON.parse(
          fs.readFileSync(path.join(profile, "control-plane-local.json"), "utf8"),
        );
      } catch {
        /* Not ready yet. */
      }
      if (discovery?.url && discovery?.token) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      discovery?.token,
      `Desktop launcher did not become ready\n${output.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")}`,
    );
    assert.equal(new URL(discovery.url).hostname, "127.0.0.1");
    const WebSocket = createRequire(path.join(pkg, "package.json"))("ws");
    const socket = new WebSocket(discovery.url);
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Launcher Control Plane auth timed out")),
          10000,
        );
        socket.once("error", reject);
        socket.once("open", () =>
          socket.send(
            JSON.stringify({
              type: "req",
              id: "launcher-auth",
              method: "connect",
              params: { token: discovery.token, deviceName: "Synthetic launcher smoke" },
            }),
          ),
        );
        socket.on("message", (data) => {
          const frame = JSON.parse(String(data));
          if (frame.id !== "launcher-auth") return;
          clearTimeout(timeout);
          frame.ok ? resolve() : reject(new Error("Launcher Control Plane auth failed"));
        });
      });
    } finally {
      socket.terminate();
    }
    console.log("Installed cowork-os launcher reached its authenticated local Control Plane.");
  } finally {
    stopGroup(child, "SIGTERM");
    const force = setTimeout(() => stopGroup(child, "SIGKILL"), 5000);
    await closed;
    clearTimeout(force);
  }
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  ...inherited,
  COWORK_USER_DATA_DIR: path.join(root, "profile"),
  COWORK_IMPORT_ENV_SETTINGS: "1",
  COWORK_STARTUP_QUIET: "1",
  OLLAMA_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  OLLAMA_MODEL: "release-fixture",
};
fs.mkdirSync(env.COWORK_USER_DATA_DIR);
try {
  for (const entry of ["cowork-cli.js", "coworkctl.js", "coworkd-node.js"]) {
    assert.match(await run(entry, ["--help"], env), /Usage|CoWork OS CLI/);
  }
  for (const label of ["cold", "warm"]) {
    const output = await run(
      "cowork-cli.js",
      [
        "run",
        "who are you?",
        "--provider",
        "ollama",
        "--model",
        "release-fixture",
        "--cwd",
        root,
        "--timeout-ms",
        "60000",
      ],
      env,
    );
    assert.match(output, /Synthetic local CLI validation passed/);
    assert.match(output, /Status: completed/);
    console.log(`Installed CLI ${label} local run passed.`);
  }
  assert.ok(requests >= 2, "Expected the local provider to serve both runs");
  if (process.platform !== "linux" || env.DISPLAY || env.WAYLAND_DISPLAY) {
    await checkLauncher(env);
  } else {
    console.log("SKIP desktop launcher: Linux has no desktop display; CLI execution was verified.");
  }
  console.log(
    "PASS installed CLI entrypoints, cold/warm one-shot execution and clean exit; launcher coverage reported above; provider bound to 127.0.0.1. No real-model calls.",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
