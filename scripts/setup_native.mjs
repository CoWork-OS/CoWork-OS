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
const cwdRequire = createRequire(path.join(process.cwd(), "package.json"));
const scriptRequire = createRequire(import.meta.url);

function resolveFromCwd(specifier) {
  // Try CWD first (dev/source builds), then script location (global npm install)
  try {
    return cwdRequire.resolve(specifier);
  } catch {
    try {
      return scriptRequire.resolve(specifier);
    } catch {
      return null;
    }
  }
}

/**
 * Find a file inside an npm package directory by resolving the package's
 * package.json first (which is always resolvable regardless of exports maps),
 * then constructing the file path directly.
 */
function resolvePackageFile(packageName, filePath) {
  const pkgJson = resolveFromCwd(`${packageName}/package.json`);
  if (!pkgJson) return null;
  const candidate = path.join(path.dirname(pkgJson), filePath);
  return fs.existsSync(candidate) ? candidate : null;
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

function nodeMajorVersion() {
  const major = Number.parseInt(String(process.versions.node || "").split(".")[0], 10);
  return Number.isFinite(major) ? major : null;
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

function makeElectronTargetEnv(env, electronVersion, arch = process.arch) {
  return {
    ...env,
    npm_config_runtime: "electron",
    npm_config_target: electronVersion,
    npm_config_disturl: "https://electronjs.org/headers",
    npm_config_arch: arch,
  };
}

function resolveElectronRebuildCli() {
  return resolvePackageFile("@electron/rebuild", "cli.js")
    || (() => {
      // Fallback: try resolving the main entry and deriving cli.js
      const entry = resolveFromCwd("@electron/rebuild");
      return entry ? path.join(path.dirname(entry), "cli.js") : null;
    })();
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

function shouldTryWindowsArm64X64Fallback() {
  if (!(process.platform === "win32" && process.arch === "arm64")) return false;
  const raw = String(process.env.COWORK_SETUP_SKIP_X64_FALLBACK || "")
    .trim()
    .toLowerCase();
  return raw !== "1" && raw !== "true" && raw !== "yes";
}

function tryWindowsArm64X64Fallback(
  env,
  installRootDir,
  electronInstallScript,
  electronVersion,
  electronRebuildCli
) {
  if (!shouldTryWindowsArm64X64Fallback()) return null;
  if (!electronInstallScript || !electronVersion) return null;

  console.log(
    "[cowork] Windows ARM64 detected; trying x64 Electron + native module fallback (emulation mode)."
  );

  // Force Electron's installer to fetch x64 binaries, then rebuild better-sqlite3 for x64 Electron ABI.
  const installRes = run(process.execPath, [electronInstallScript], {
    env: { ...env, npm_config_arch: "x64" },
    cwd: installRootDir,
  });
  if (installRes.status !== 0) return installRes;

  const x64ElectronEnv = makeElectronTargetEnv(env, electronVersion, "x64");
  const rebuildRes = run(
    NPM_CMD,
    ["rebuild", "--ignore-scripts=false", "better-sqlite3"],
    { env: x64ElectronEnv, cwd: installRootDir }
  );
  if (rebuildRes.status !== 0) {
    console.log(
      "[cowork] x64 npm rebuild failed; trying electron-rebuild x64 fallback."
    );
  } else {
    const testRes = testBetterSqlite3InElectron(x64ElectronEnv);
    if (testRes.status === 0) {
      console.log("[cowork] better-sqlite3 loads in Electron (x64 emulation mode).");
      return testRes;
    }

    console.log(
      "[cowork] x64 npm rebuild completed, but better-sqlite3 still did not load in Electron."
    );
  }

  if (!electronRebuildCli || !fs.existsSync(electronRebuildCli)) {
    console.log(
      "[cowork] @electron/rebuild is not installed; cannot run x64 fallback rebuild."
    );
    return { status: 1, signal: null };
  }

  const rebuildX64Res = run(
    process.execPath,
    [
      electronRebuildCli,
      "-f",
      "--only",
      "better-sqlite3",
      "--sequential",
      "--arch",
      "x64",
      "--version",
      electronVersion,
      "--module-dir",
      installRootDir,
    ],
    { env, cwd: installRootDir }
  );
  if (rebuildX64Res.status !== 0) return rebuildX64Res;

  const testRes = testBetterSqlite3InElectron(x64ElectronEnv);
  if (testRes.status === 0) {
    console.log(
      "[cowork] better-sqlite3 loads in Electron after x64 electron-rebuild fallback."
    );
  } else {
    console.log(
      "[cowork] x64 electron-rebuild fallback completed, but better-sqlite3 still did not load."
    );
  }

  return testRes;
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
  if (process.platform === "win32") {
    console.error(
      "[cowork] On Windows, inspect npm logs in %LocalAppData%\\npm-cache\\_logs\\ for detailed native build errors."
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
      // Also check via npm config for an explicit MSVC version.
      const npmRes = spawnSync(NPM_CMD, ["config", "get", "msvs_version"], {
        encoding: "utf8",
      });
      const hasMsvs =
        npmRes.status === 0 &&
        npmRes.stdout &&
        npmRes.stdout.trim() !== "undefined";
      if (!hasMsvs) {
        console.warn(
          "\n[cowork] Warning: Visual Studio C++ Build Tools were not detected.\n" +
            "Native module compilation (better-sqlite3) may fail without them.\n" +
            "Install Visual Studio Build Tools 2022 with:\n" +
            "  - Desktop development with C++\n" +
            "  - MSVC v143 build tools\n" +
            "  - Windows 10/11 SDK\n" +
            "Then set node-gyp MSVC env vars (in cmd):\n" +
            "  setx GYP_MSVS_VERSION 2022\n" +
            "  setx npm_config_msvs_version 2022\n" +
            "Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/\n"
        );
        // Don't exit — prebuilt binaries may work without compilation
      }
    }

    const pyRes = spawnSync("py", ["-3", "--version"], { encoding: "utf8" });
    const pythonRes = pyRes.status === 0
      ? pyRes
      : spawnSync("python", ["--version"], { encoding: "utf8" });
    if (pythonRes.status !== 0) {
      console.warn(
        "\n[cowork] Warning: Python 3 was not detected (`py -3` / `python`).\n" +
          "node-gyp requires Python 3 for native module builds.\n"
      );
    }

    if (process.arch === "arm64" && (nodeMajorVersion() ?? 0) >= 24) {
      console.log(
        "[cowork] Windows ARM64 + Node 24 detected. If native ARM64 rebuild fails,\n" +
          "setup will auto-try x64 Electron emulation for better compatibility."
      );
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
    const electronInstallScript = resolvePackageFile("electron", "install.js");
    const electronRebuildCli = resolveElectronRebuildCli();
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
      const electronEnv = makeElectronTargetEnv(env, electronVersion, process.arch);
      const rebuildElectronRes = run(
        NPM_CMD,
        ["rebuild", "--ignore-scripts=false", "better-sqlite3"],
        { env: electronEnv, cwd: installRootDir }
      );
      if (rebuildElectronRes.status !== 0) {
        console.log(
          "[cowork] Electron-targeted npm rebuild failed; trying fallback paths."
        );
      } else {
        const testRes = testBetterSqlite3InElectron(electronEnv);
        if (testRes.status === 0) {
          console.log("[cowork] better-sqlite3 loads in Electron.");
          return testRes;
        }

        console.log(
          "[cowork] better-sqlite3 did not load after Electron-targeted rebuild; " +
            "trying fallback paths."
        );
      }

      const winArmFallbackRes = tryWindowsArm64X64Fallback(
        env,
        installRootDir,
        electronInstallScript,
        electronVersion,
        electronRebuildCli
      );
      if (winArmFallbackRes) {
        if (winArmFallbackRes.status === 0) return winArmFallbackRes;
        console.log(
          "[cowork] Windows ARM64 x64 fallback did not fully recover; trying current-arch electron-rebuild fallback."
        );
      }
    } else {
      console.log(
        "[cowork] Could not determine Electron version; falling back to electron-rebuild."
      );
    }

    // 3) Fallback: electron-rebuild.
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
