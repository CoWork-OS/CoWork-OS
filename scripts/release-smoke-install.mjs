#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const NPM_CMD = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_EXEC_PATH = (() => {
  const raw = process.env.npm_execpath;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return fs.existsSync(raw) ? raw : null;
})();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function spawnNpm(args, opts = {}) {
  if (NPM_EXEC_PATH) {
    return spawnSync(process.execPath, [NPM_EXEC_PATH, ...args], opts);
  }
  if (process.platform === "win32") {
    return spawnSync(NPM_CMD, args, { ...opts, shell: true });
  }
  return spawnSync(NPM_CMD, args, opts);
}

function runNpm(args, opts = {}) {
  const res = spawnNpm(args, {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? process.env,
    encoding: "utf8",
    stdio: opts.stdio ?? "pipe",
  });

  if (opts.echoOutput !== false) {
    if (typeof res.stdout === "string" && res.stdout.length > 0) process.stdout.write(res.stdout);
    if (typeof res.stderr === "string" && res.stderr.length > 0) process.stderr.write(res.stderr);
  }

  if (res.error) {
    throw res.error;
  }
  if ((res.status ?? 1) !== 0) {
    throw new Error(`npm ${args.join(" ")} failed with exit code ${res.status ?? 1}`);
  }

  return res;
}

function cleanupPath(targetPath) {
  if (!targetPath) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function main() {
  let tmpDir = null;
  let tarballPath = null;
  const suppliedTarball = process.env.COWORK_RELEASE_TARBALL;
  const packageName = process.env.COWORK_RELEASE_PACKAGE_NAME || "cowork-os";
  if (!["cowork-os", "@cowork-os/cowork-os"].includes(packageName)) {
    throw new Error("Unexpected release package name.");
  }

  try {
    if (suppliedTarball) {
      tarballPath = path.resolve(suppliedTarball);
    } else {
      const packRes = runNpm(["pack", "--ignore-scripts", "--silent"], { echoOutput: false });
      const tarball = String(packRes.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);

      if (!tarball) {
        throw new Error("npm pack did not report a tarball path.");
      }

      tarballPath = path.join(repoRoot, tarball);
    }
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`Expected tarball at ${tarballPath}`);
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-release-smoke-"));
    const testDir = path.join(tmpDir, "smoke");
    fs.mkdirSync(testDir, { recursive: true });

    runNpm(["init", "-y"], { cwd: testDir, echoOutput: false });
    runNpm(
      ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", tarballPath],
      { cwd: testDir },
    );

    const setupRes = runNpm(["run", "--prefix", `node_modules/${packageName}`, "setup"], {
      cwd: testDir,
    });
    const combinedSetupOutput = `${setupRes.stdout || ""}${setupRes.stderr || ""}`;
    fs.writeFileSync(path.join(testDir, "setup.log"), combinedSetupOutput);

    if (/^\[cowork\] setup:bootstrap/m.test(combinedSetupOutput)) {
      throw new Error(
        "Setup unexpectedly triggered dependency bootstrap fallback; electron should resolve from parent node_modules.",
      );
    }

    const smokeCheck = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/release-smoke-check.mjs")],
      {
        cwd: testDir,
        env: process.env,
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    if (typeof smokeCheck.stdout === "string" && smokeCheck.stdout.length > 0) {
      process.stdout.write(smokeCheck.stdout);
    }
    if (typeof smokeCheck.stderr === "string" && smokeCheck.stderr.length > 0) {
      process.stderr.write(smokeCheck.stderr);
    }
    if (smokeCheck.error) {
      throw smokeCheck.error;
    }
    if ((smokeCheck.status ?? 1) !== 0) {
      throw new Error(`release smoke check failed with exit code ${smokeCheck.status ?? 1}`);
    }
  } finally {
    cleanupPath(tmpDir);
    // Retained publication artifacts belong to the caller and must survive smoke checks.
    if (!suppliedTarball) cleanupPath(tarballPath);
  }
}

main();
