#!/usr/bin/env node
/**
 * Native setup helper.
 *
 * Why this exists:
 * - The repo ships with `.npmrc` setting `ignore-scripts=true` to reduce OOM kills
 *   during `npm install`.
 * - That means Electron's postinstall (binary download) won't run automatically.
 * - We then need to (1) fetch Electron and (2) rebuild native modules (better-sqlite3)
 *   against the Electron ABI.
 *
 * This wrapper adds:
 * - Clear progress output (so "Killed: 9" is attributable to a step)
 * - Basic prerequisite check on macOS (Xcode CLT path)
 * - Conservative parallelism defaults to reduce peak memory usage
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const BETTER_SQLITE3_VERSION = "12.6.2";
const NPM_CMD = process.platform === "win32" ? "npm.cmd" : "npm";
const cwdRequire = (() => {
  try {
    return createRequire(path.join(process.cwd(), "package.json"));
  } catch {
    return createRequire(import.meta.url);
  }
})();

function resolveFromCwd(specifier) {
  try {
    return cwdRequire.resolve(specifier);
  } catch {
    return null;
  }
}

function getElectronBinaryPath() {
  try {
    const electronBinary = cwdRequire("electron");
    return typeof electronBinary === "string" && electronBinary.length > 0
      ? electronBinary
      : null;
  } catch {
    return null;
  }
}

function getInstallRootDir() {
  const electronPkgPath = resolveFromCwd("electron/package.json");
  if (!electronPkgPath) return process.cwd();

  const electronDir = path.dirname(electronPkgPath);
  const nodeModulesDir = path.dirname(electronDir);
  const installRoot = path.dirname(nodeModulesDir);
  const installRootPkg = path.join(installRoot, "package.json");

  if (fs.existsSync(installRootPkg)) return installRoot;
  return process.cwd();
}

function run(cmd, args, opts = {}) {
  const pretty = [cmd, ...(args || [])].join(" ");
  console.log(`\n[cowork] $ ${pretty}`);
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
  });
  return res;
}

function computeJobs() {
  // Users should be able to run README commands without tweaking env vars.
  // Default to 1 job on macOS for reliability (reduces peak memory).
  const raw = process.env.COWORK_SETUP_JOBS;
  if (raw != null && String(raw).trim() !== "") {
    const parsed = Number.parseInt(String(raw), 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }

  if (process.platform === "darwin") return 1;

  const cpuCount = Math.max(1, os.cpus()?.length ?? 1);
  return Math.min(2, cpuCount);
}

function baseEnvWithJobs(jobs) {
  // These influence node-gyp/make parallelism on macOS/Linux.
  // Always set safe values so global MAKEFLAGS doesn't accidentally cause OOM.
  const env = { ...process.env };
  env.npm_config_jobs = String(jobs);
  env.MAKEFLAGS = `-j${jobs}`;
  return env;
}

function isKilledByOS(res) {
  // `Killed: 9` => SIGKILL. Some wrappers surface this as exit 137.
  return res.signal === "SIGKILL" || res.status === 137;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getElectronVersion() {
  try {
    const pkgPath = resolveFromCwd("electron/package.json");
    if (!pkgPath) return null;
    const pkg = readJson(pkgPath);
    return String(pkg.version || "").trim() || null;
  } catch {
    return null;
  }
}

function getElectronModulesAbi(env) {
  const electronBinary = getElectronBinaryPath();
  if (!electronBinary) return null;

  // Use Electron's bundled Node in "run as node" mode so this doesn't start a GUI app.
  const res = spawnSync(
    electronBinary,
    ["-p", "process.versions.modules"],
    { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
  );
  if (res.status !== 0) return null;
  return String(res.stdout || "").trim() || null;
}

function testBetterSqlite3InElectron(env) {
  const electronBinary = getElectronBinaryPath();
  if (!electronBinary) return { status: 1, signal: null };

  const res = spawnSync(
    electronBinary,
    [
      "-e",
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close();console.log('ok')",
    ],
    { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
  );
  return res;
}

function ensureBetterSqlite3(env, installRootDir) {
  const pkgPath = resolveFromCwd("better-sqlite3/package.json");

  if (pkgPath && fs.existsSync(pkgPath)) {
    return { status: 0, signal: null };
  }

  console.log(
    `[cowork] better-sqlite3 is missing; installing ${BETTER_SQLITE3_VERSION}...`
  );

  if (installRootDir !== process.cwd()) {
    console.log(`[cowork] Installing better-sqlite3 from root ${installRootDir}`);
  }

  return run(
    NPM_CMD,
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--omit=dev",
      "--package-lock=false",
      "--no-save",
      `better-sqlite3@${BETTER_SQLITE3_VERSION}`,
    ],
    { env, cwd: installRootDir }
  );
}

function fail(res, context) {
  const sig = res.signal ? ` (signal ${res.signal})` : "";
  const code =
    res.status == null ? "" : ` (exit ${String(res.status).trim()})`;
  console.error(`\n[cowork] ${context} failed${sig}${code}.`);
  if (isKilledByOS(res)) {
    console.error(
      "[cowork] The OS terminated the process (usually memory pressure). " +
        "Setup will retry automatically; if it still fails after retries, " +
        "close other apps and re-run `npm run setup`."
    );
  }
  // If a child process was SIGKILL'd, `spawnSync` will surface it as `signal`
  // with `status === null`. Exit 137 (128 + 9) so shell-level retries can
  // reliably detect and retry.
  process.exit(isKilledByOS(res) ? 137 : res.status ?? 1);
}

function checkPrereqs() {
  if (process.platform === "darwin") {
    const res = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
    if (res.status !== 0) {
      console.error(
        "\n[cowork] Xcode Command Line Tools not found.\n" +
          "Install them with:\n" +
          "  xcode-select --install\n"
      );
      process.exit(1);
    }
  } else if (process.platform === "win32") {
    // Check for Visual C++ build tools (required by node-gyp for native modules)
    const res = spawnSync("where", ["cl.exe"], { encoding: "utf8" });
    if (res.status !== 0) {
      // Also check via npm config for windows-build-tools
      const npmRes = spawnSync(NPM_CMD, ["config", "get", "msvs_version"], {
        encoding: "utf8",
      });
      const hasMsvs =
        npmRes.status === 0 &&
        npmRes.stdout &&
        npmRes.stdout.trim() !== "undefined";
      if (!hasMsvs) {
        console.warn(
          "\n[cowork] Warning: Visual C++ Build Tools may not be installed.\n" +
            "Native module compilation (better-sqlite3) requires them.\n" +
            "Install with:\n" +
            "  npm install -g windows-build-tools\n" +
            "Or install Visual Studio Build Tools from:\n" +
            "  https://visualstudio.microsoft.com/visual-cpp-build-tools/\n"
        );
        // Don't exit — prebuilt binaries may work without compilation
      }
    }
  }
}

function main() {
  console.log(
    `[cowork] Native setup (${process.platform}/${process.arch}) using Node ${process.version}`
  );

  checkPrereqs();

  const userSpecifiedJobs =
    process.env.COWORK_SETUP_JOBS != null &&
    String(process.env.COWORK_SETUP_JOBS).trim() !== "";

  let jobs = computeJobs();
  console.log(
    `[cowork] Using jobs=${jobs} (set COWORK_SETUP_JOBS=N to override)`
  );

  const attempt = (attemptJobs) => {
    const env = baseEnvWithJobs(attemptJobs);
    const installRootDir = getInstallRootDir();
    const electronInstallScript = resolveFromCwd("electron/install.js");
    const electronBinary = getElectronBinaryPath();

    if (!electronInstallScript) {
      console.error(
        "[cowork] Electron install script not found. Ensure the `electron` dependency is installed."
      );
      return { status: 1, signal: null };
    }

    // 1) Ensure Electron binary exists (postinstall is often skipped due to ignore-scripts=true).
    if (electronBinary && fs.existsSync(electronBinary)) {
      console.log("[cowork] Electron binary already present; skipping electron/install.js.");
    } else {
      const installRes = run(process.execPath, [electronInstallScript], { env });
      if (installRes.status !== 0) return installRes;
    }

    // If optional dependency install was skipped/failed earlier, recover here.
    const ensureBetterRes = ensureBetterSqlite3(env, installRootDir);
    if (ensureBetterRes.status !== 0) return ensureBetterRes;

    const electronVersion = getElectronVersion();
    const electronAbi = getElectronModulesAbi(env);

    console.log(
      `[cowork] Electron: version=${electronVersion ?? "?"} modules=${
        electronAbi ?? "?"
      }`
    );

    // 2) electron-rebuild for the one module (keeps rebuild surface small).
    // 2) Prefer an Electron-targeted rebuild for better-sqlite3 (often prebuilt, lighter).
    if (electronVersion) {
      const electronEnv = {
        ...env,
        npm_config_runtime: "electron",
        npm_config_target: electronVersion,
        npm_config_disturl: "https://electronjs.org/headers",
        npm_config_arch: process.arch,
      };
      const rebuildElectronRes = run(
        NPM_CMD,
        ["rebuild", "--ignore-scripts=false", "better-sqlite3"],
        { env: electronEnv, cwd: installRootDir }
      );
      if (rebuildElectronRes.status !== 0) return rebuildElectronRes;

      const testRes = testBetterSqlite3InElectron(electronEnv);
      if (testRes.status === 0) {
        console.log("[cowork] better-sqlite3 loads in Electron.");
        return testRes;
      }

      console.log(
        "[cowork] better-sqlite3 did not load after Electron-targeted rebuild; " +
          "falling back to electron-rebuild."
      );
    } else {
      console.log(
        "[cowork] Could not determine Electron version; falling back to electron-rebuild."
      );
    }

    // 3) Fallback: electron-rebuild.
    const electronRebuildEntry = resolveFromCwd("@electron/rebuild");
    const electronRebuildCli = electronRebuildEntry
      ? path.join(path.dirname(electronRebuildEntry), "cli.js")
      : null;
    if (!electronRebuildCli || !fs.existsSync(electronRebuildCli)) {
      console.log(
        "[cowork] @electron/rebuild is not installed; skipping fallback rebuild."
      );
      return testBetterSqlite3InElectron(env);
    }

    const rebuildRes = run(
      process.execPath,
      [
        electronRebuildCli,
        "-f",
        "--only",
        "better-sqlite3",
        "--sequential",
      ],
      { env, cwd: installRootDir }
    );
    if (rebuildRes.status !== 0) return rebuildRes;

    const testRes = testBetterSqlite3InElectron(env);
    if (testRes.status === 0) {
      console.log("[cowork] better-sqlite3 loads in Electron.");
      return testRes;
    }

    console.log("[cowork] better-sqlite3 did not load after electron-rebuild.");
    return testRes;
  };

  let res = attempt(jobs);
  if (res.status !== 0 && isKilledByOS(res) && !userSpecifiedJobs && jobs > 1) {
    console.log(
      `\n[cowork] Detected SIGKILL; retrying once with jobs=1 to reduce memory...`
    );
    jobs = 1;
    res = attempt(jobs);
  }

  if (res.status !== 0) fail(res, "Native setup");

  console.log("\n[cowork] Native setup complete.");
}

main();
