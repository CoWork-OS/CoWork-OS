#!/usr/bin/env node
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { isIgnorableDevLogLine } from "./dev-log-utils.mjs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const DEFAULT_PORT = 5173;
const MAX_PORT_SCAN_ATTEMPTS = 25;
const REACT_READY_TIMEOUT_MS = 30_000;
const ELECTRON_SINGLE_INSTANCE_EXIT_CODE = 73;
const cwdRequire = createRequire(path.join(process.cwd(), "package.json"));

function parsePort(value, fallback = DEFAULT_PORT) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function normalizeDevLogLevel(env) {
  if (String(env.COWORK_LOG_LEVEL || "").trim().toLowerCase() !== "debug") {
    return;
  }
  env.COWORK_LOG_LEVEL = "info";
  process.stdout.write("[dev-start] COWORK_LOG_LEVEL=debug ignored for local dev; using info.\n");
}

function enableSystemCaForMacDev(env) {
  if (process.platform !== "darwin") return;
  if (String(env.COWORK_DEV_USE_SYSTEM_CA || "").trim() === "0") return;

  const nodeOptions = String(env.NODE_OPTIONS || "").trim();
  if (/(?:^|\s)--use-(?:system|bundled|openssl)-ca(?:\s|$)/.test(nodeOptions)) {
    return;
  }

  env.NODE_OPTIONS = [nodeOptions, "--use-system-ca"].filter(Boolean).join(" ");
  process.stdout.write(
    "[dev-start] Enabled NODE_OPTIONS=--use-system-ca for macOS dev TLS trust.\n",
  );
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort) {
  for (let offset = 0; offset < MAX_PORT_SCAN_ATTEMPTS; offset += 1) {
    const candidate = startPort + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to find an available dev server port starting at ${startPort} after ${MAX_PORT_SCAN_ATTEMPTS} attempts.`,
  );
}

function pipePrefixedOutput(child, label) {
  let loggedSuppressedNativeNoise = false;
  const write = (stream, chunk) => {
    const lines = chunk.toString("utf8").split(/\r?\n/);
    const trailingEmpty = lines.at(-1) === "";
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line && i === lines.length - 1 && trailingEmpty) continue;
      if (isIgnorableDevLogLine(line)) {
        if (!loggedSuppressedNativeNoise) {
          loggedSuppressedNativeNoise = true;
          process.stdout.write(
            `[${label}] [dev-start] Suppressed repeated Electron/macOS native menu warning.\n`,
          );
        }
        continue;
      }
      stream.write(`[${label}] ${line}\n`);
    }
  };

  child.stdout?.on("data", (chunk) => write(process.stdout, chunk));
  child.stderr?.on("data", (chunk) => write(process.stderr, chunk));
}

function getElectronBinaryStatus() {
  try {
    const electronPkgJson = cwdRequire.resolve("electron/package.json");
    const electronDir = path.dirname(electronPkgJson);
    if (!fs.existsSync(electronDir)) {
      return { installed: false, ready: false, binaryPath: null };
    }
  } catch {
    return { installed: false, ready: false, binaryPath: null };
  }

  try {
    const electronBinary = cwdRequire("electron");
    const hasBinaryPath = typeof electronBinary === "string" && electronBinary.length > 0;
    return {
      installed: true,
      ready: hasBinaryPath && fs.existsSync(electronBinary),
      binaryPath: hasBinaryPath ? electronBinary : null,
    };
  } catch {
    return { installed: true, ready: false, binaryPath: null };
  }
}

function findRunningElectronDevPid(electronBinary) {
  if (process.platform === "win32" || !electronBinary) return null;
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) return null;
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (
      pid !== process.pid &&
      (command === electronBinary || command.startsWith(`${electronBinary} `))
    ) {
      return pid;
    }
  }
  return null;
}

function getNativeSqliteStatus(env) {
  const electronStatus = getElectronBinaryStatus();
  if (!electronStatus.ready || !electronStatus.binaryPath) {
    return { ready: false, reason: "Electron binary is missing." };
  }

  const result = spawnSync(
    electronStatus.binaryPath,
    [
      "-e",
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close();",
    ],
    {
      cwd: process.cwd(),
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
    },
  );

  if ((result.status ?? 1) === 0) {
    return { ready: true, reason: null };
  }

  if (result.signal) {
    return {
      ready: false,
      reason:
        `Electron was terminated by ${result.signal} before it could load better-sqlite3. ` +
        "Refresh node_modules/electron/dist and retry.",
    };
  }

  const output = `${result.stderr || ""}${result.stdout || ""}`.trim();
  const firstLine = output.split(/\r?\n/).find(Boolean);
  return {
    ready: false,
    reason:
      firstLine || `better-sqlite3 failed to load in Electron (exit ${result.status ?? 1}).`,
  };
}

function repairNativeInstall(env, reason) {
  process.stdout.write(`[dev-start] ${reason} Running native setup repair.\n`);

  const result = spawnSync(process.execPath, ["scripts/setup_native_driver.mjs"], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });

  if ((result.status ?? 1) !== 0) {
    throw new Error(`Native setup repair failed with exit code ${result.status ?? 1}.`);
  }

  const repairedStatus = getElectronBinaryStatus();
  if (!repairedStatus.ready) {
    throw new Error(
      "Electron repair finished but the Electron binary is still missing. Run `npm run setup` and retry.",
    );
  }

  const sqliteStatus = getNativeSqliteStatus(env);
  if (!sqliteStatus.ready) {
    throw new Error(
      `Native setup repair finished but better-sqlite3 still does not load in Electron: ${sqliteStatus.reason}`,
    );
  }
}

function runOptionalDevBranding(env) {
  if (process.platform !== "darwin") {
    return;
  }

  const shouldSkipDevBranding = String(env.COWORK_DEV_BRAND_APP || "")
    .trim()
    .toLowerCase();
  if (["0", "false", "no", "off"].includes(shouldSkipDevBranding)) {
    process.stdout.write(
      "[dev-start] Skipping Electron.app dev branding/signing because COWORK_DEV_BRAND_APP disables it.\n",
    );
    return;
  }

  const brandResult = spawnSync(process.execPath, ["scripts/brand_electron_dev_app.mjs"], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if ((brandResult.status ?? 1) !== 0) {
    throw new Error(
      `Development Electron branding failed with exit code ${brandResult.status ?? 1}.`,
    );
  }

  const signResult = spawnSync(process.execPath, ["scripts/codesign_electron_dev.mjs"], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if ((signResult.status ?? 1) !== 0) {
    throw new Error(
      `Development Electron codesigning failed with exit code ${signResult.status ?? 1}.`,
    );
  }
}

async function waitForPort(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (value) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (open) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for dev server on port ${port}.`);
}

const requestedPort = parsePort(process.env.COWORK_DEV_SERVER_PORT);
const selectedPort = await findAvailablePort(requestedPort);
const devServerUrl = `http://127.0.0.1:${selectedPort}`;
const childEnv = {
  ...process.env,
  COWORK_DEV_SERVER_PORT: String(selectedPort),
  COWORK_DEV_SERVER_URL: devServerUrl,
};
delete childEnv.ELECTRON_RUN_AS_NODE;
normalizeDevLogLevel(childEnv);
enableSystemCaForMacDev(childEnv);

const electronStatus = getElectronBinaryStatus();
if (electronStatus.installed && !electronStatus.ready) {
  try {
    repairNativeInstall(
      childEnv,
      "Electron package is present but its binary is missing.",
    );
  } catch (error) {
    process.stderr.write(`[dev-start] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (electronStatus.installed && electronStatus.ready) {
  const runningElectronPid = findRunningElectronDevPid(electronStatus.binaryPath);
  if (runningElectronPid) {
    process.stderr.write(
      `[dev-start] Existing CoWork OS development instance detected (PID ${runningElectronPid}). ` +
        "Quit the running app before `npm run dev`; rebranding or relaunching the same Electron bundle while it is active can abort before JavaScript startup.\n",
    );
    process.exit(ELECTRON_SINGLE_INSTANCE_EXIT_CODE);
  }
  try {
    runOptionalDevBranding(childEnv);
  } catch (error) {
    process.stderr.write(`[dev-start] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const sqliteStatus = getNativeSqliteStatus(childEnv);
  if (!sqliteStatus.ready) {
    try {
      repairNativeInstall(
        childEnv,
        `better-sqlite3 is not usable in Electron: ${sqliteStatus.reason}`,
      );
    } catch (error) {
      process.stderr.write(`[dev-start] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }
}

if (selectedPort !== requestedPort) {
  process.stdout.write(
    `[dev-start] Port ${requestedPort} is busy; using ${selectedPort} instead.\n`,
  );
}

const react = spawn(
  npmCommand,
  ["run", "dev:react", "--", "--host", "127.0.0.1", "--port", String(selectedPort), "--strictPort"],
  {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["inherit", "pipe", "pipe"],
  },
);
pipePrefixedOutput(react, "react");

let electron = null;
let shuttingDown = false;
let resolvedExit = false;

function terminateChild(child, signal = "SIGTERM") {
  if (!child || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    // Ignore termination races.
  }
}

function shutdown(exitCode = 0) {
  if (resolvedExit) return;
  resolvedExit = true;
  shuttingDown = true;
  terminateChild(electron);
  terminateChild(react);
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

react.once("error", (error) => {
  process.stderr.write(`[react] Failed to start: ${error.message}\n`);
  shutdown(1);
});

react.once("exit", (code) => {
  if (shuttingDown) return;
  if (code !== 0) {
    process.stderr.write(`[dev-start] React dev server exited with code ${code ?? 1}.\n`);
    shutdown(code ?? 1);
    return;
  }
  process.stdout.write("[dev-start] React dev server exited cleanly.\n");
  shutdown(0);
});

try {
  await waitForPort(selectedPort, REACT_READY_TIMEOUT_MS);
} catch (error) {
  process.stderr.write(`[dev-start] ${error instanceof Error ? error.message : String(error)}\n`);
  shutdown(1);
}

electron = spawn(npmCommand, ["run", "dev:electron"], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: ["inherit", "pipe", "pipe"],
});
pipePrefixedOutput(electron, "electron");

electron.once("error", (error) => {
  process.stderr.write(`[electron] Failed to start: ${error.message}\n`);
  shutdown(1);
});

electron.once("exit", (code) => {
  if (shuttingDown) return;
  if (code === ELECTRON_SINGLE_INSTANCE_EXIT_CODE) {
    process.stderr.write(
      "[dev-start] Electron startup was blocked by an existing CoWork OS instance. " +
        "Quit the running app, then run `npm run dev` again.\n",
    );
    shutdown(code);
    return;
  }
  process.stdout.write(`[dev-start] Electron exited with code ${code ?? 0}.\n`);
  shutdown(code ?? 0);
});
