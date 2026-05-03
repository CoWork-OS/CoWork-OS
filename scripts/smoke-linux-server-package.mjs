#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(ROOT, "release");
const REQUIRED_FILES = [
  "package.json",
  "INSTALL.md",
  "bin/coworkd-node.js",
  "bin/coworkctl.js",
  "dist/daemon/daemon/main.js",
  "deploy/systemd/cowork-os-node.service",
  "deploy/systemd/cowork-os.env.example",
  "docs/vps-linux.md",
  "resources/branding/cowork-os-app-logo-dark.png",
  "resources/branding/cowork-os-app-logo-light.png",
  "resources/persona-templates/software-engineer.json",
  "node_modules/better-sqlite3/package.json",
  "node_modules/electron/package.json",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }

  return result;
}

async function findTarball() {
  const explicitPath = process.argv[2];
  if (explicitPath) return path.resolve(explicitPath);

  const names = await fs.readdir(RELEASE_DIR);
  const candidates = names
    .filter((name) => /^cowork-os-server-linux-x64-v.+\.tar\.gz$/.test(name))
    .sort()
    .reverse();

  if (candidates.length === 0) {
    throw new Error(`No Linux server tarball found in ${RELEASE_DIR}`);
  }

  return path.join(RELEASE_DIR, candidates[0]);
}

async function assertElectronBinaryInstalled(packageRoot) {
  const packageRequire = createRequire(path.join(packageRoot, "package.json"));
  const electronPath = packageRequire("electron");
  if (typeof electronPath !== "string" || electronPath.length === 0) {
    throw new Error("Expected require('electron') to resolve to an Electron binary path.");
  }

  const stat = await fs.stat(electronPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`Electron binary was not installed at ${electronPath}.`);
  }

  await fs.access(electronPath, fsConstants.X_OK);
}

async function waitForHealth(port, child, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited before health check passed with code ${child.exitCode}`);
    }

    try {
      const statusCode = await new Promise((resolve, reject) => {
        const request = http.get(
          {
            hostname: "127.0.0.1",
            port,
            path: "/health",
            timeout: 1500,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          }
        );
        request.on("timeout", () => {
          request.destroy(new Error("health request timed out"));
        });
        request.on("error", reject);
      });

      if (statusCode >= 200 && statusCode < 300) return;
      lastError = new Error(`health returned ${statusCode}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for /health: ${lastError?.message ?? "unknown error"}`);
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    console.log("[linux-server-smoke] Skipping: smoke test requires linux x64.");
    return;
  }

  const tarballPath = await findTarball();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-linux-server-smoke-"));
  let daemon = null;

  try {
    run("tar", ["-xzf", tarballPath, "-C", tempRoot]);
    const entries = await fs.readdir(tempRoot);
    const packageRoot = path.join(tempRoot, entries[0]);

    for (const relativePath of REQUIRED_FILES) {
      await fs.access(path.join(packageRoot, relativePath));
    }

    run(process.execPath, ["bin/coworkd-node.js", "--help"], { cwd: packageRoot });
    await assertElectronBinaryInstalled(packageRoot);
    run(
      process.execPath,
      [
        "-e",
        "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('better-sqlite3 ok')",
      ],
      { cwd: packageRoot }
    );

    const port = 20000 + Math.floor(Math.random() * 20000);
    const userDataDir = path.join(tempRoot, "data");
    await fs.mkdir(userDataDir, { recursive: true });

    daemon = spawn(process.execPath, ["bin/coworkd-node.js"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        COWORK_USER_DATA_DIR: userDataDir,
        COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
        COWORK_CONTROL_PLANE_PORT: String(port),
        COWORK_IMPORT_ENV_SETTINGS: "0",
      },
      stdio: "inherit",
    });

    await waitForHealth(port, daemon);
    console.log(`[linux-server-smoke] Health check passed for ${path.basename(tarballPath)}`);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (daemon.exitCode === null) daemon.kill("SIGKILL");
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[linux-server-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
