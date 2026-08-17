#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_RELEASE_DIR = path.join(ROOT, "release");
const MIN_DMG_BYTES = 50 * 1024 * 1024;
const MIN_EXE_BYTES = 100 * 1024 * 1024;
const MAC_LAUNCH_MS = 8_000;
const WINDOWS_LAUNCH_MS = 20_000;

function parseArgs(argv) {
  const args = {
    platform: "auto",
    releaseDir: DEFAULT_RELEASE_DIR,
    expectedVersion: undefined,
    skipLaunch: false,
    allowUnsigned: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--skip-launch") {
      args.skipLaunch = true;
      continue;
    }
    if (arg === "--allow-unsigned") {
      args.allowUnsigned = true;
      continue;
    }
    if (arg === "--platform" && argv[i + 1]) {
      args.platform = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      args.platform = arg.slice("--platform=".length);
      continue;
    }
    if (arg === "--release-dir" && argv[i + 1]) {
      args.releaseDir = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--release-dir=")) {
      args.releaseDir = path.resolve(arg.slice("--release-dir=".length));
      continue;
    }
    if (arg === "--expected-version" && argv[i + 1]) {
      args.expectedVersion = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--expected-version=")) {
      args.expectedVersion = arg.slice("--expected-version=".length);
    }
  }

  return args;
}

function usage() {
  console.log(`Usage: node scripts/smoke-desktop-artifacts.mjs [options]

Options:
  --platform=auto|mac|win       Artifact type to smoke test. Default: auto.
  --release-dir=<path>          Release artifact directory. Default: ./release.
  --expected-version=<version>  Expected app/package version. Default: package.json version.
  --skip-launch                 Windows only: install/uninstall without launch hold.
  --allow-unsigned              macOS only: accept a valid ad hoc signed app bundle.
  --help                        Show this help.
`);
}

function normalizePlatform(value) {
  const raw = String(value || "auto")
    .trim()
    .toLowerCase();
  if (raw === "auto") {
    if (process.platform === "darwin") return "mac";
    if (process.platform === "win32") return "win";
    throw new Error("Desktop artifact smoke tests only run on macOS or Windows.");
  }
  if (["mac", "macos", "darwin"].includes(raw)) return "mac";
  if (["win", "windows", "win32"].includes(raw)) return "win";
  throw new Error(`Unsupported platform: ${value}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? process.platform === "win32",
  });

  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
  return result;
}

function runStatus(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: options.encoding ?? "utf8",
    stdio: "pipe",
    shell: options.shell ?? process.platform === "win32",
  });

  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

async function listFiles(dir) {
  const names = await fs.readdir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      const fullPath = path.join(dir, name);
      const stat = await fs.stat(fullPath);
      return stat.isFile() ? { name, fullPath, size: stat.size } : null;
    }),
  );
  return entries.filter(Boolean);
}

async function findSingleFile(releaseDir, predicate, label) {
  const files = await listFiles(releaseDir);
  const matches = files.filter(predicate).sort((a, b) => b.name.localeCompare(a.name));
  if (matches.length === 0) {
    throw new Error(`No ${label} found in ${releaseDir}`);
  }
  if (matches.length > 1) {
    throw new Error(`Expected one ${label}, found: ${matches.map((file) => file.name).join(", ")}`);
  }
  return matches[0];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findSingleVersionedFile(releaseDir, predicate, label, expectedVersion) {
  const versionPattern = new RegExp(
    `(^|[^0-9A-Za-z])${escapeRegex(expectedVersion)}([^0-9A-Za-z]|$)`,
  );
  return findSingleFile(
    releaseDir,
    (file) => predicate(file) && versionPattern.test(file.name),
    `${label} for version ${expectedVersion}`,
  );
}

function readPackageVersion() {
  return JSON.parse(
    spawnSync(process.execPath, ["-p", "JSON.stringify(require('./package.json').version)"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout,
  );
}

function assertHostPlatform(platform) {
  if (platform === "mac" && process.platform !== "darwin") {
    throw new Error("macOS DMG smoke test must run on macOS.");
  }
  if (platform === "win" && process.platform !== "win32") {
    throw new Error("Windows installer smoke test must run on Windows.");
  }
}

function validateUpdaterMetadata(releaseDir) {
  run(process.execPath, ["scripts/release-artifact-names.mjs", "--check", "--dir", releaseDir]);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function validateNumbatRuntime(resourcesRoot, targetKey) {
  const numbatRoot = path.join(resourcesRoot, "numbat");
  const manifestPath = path.join(numbatRoot, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const target = manifest.targets?.[targetKey];
  if (!target?.path || !target.sha256) {
    throw new Error(`Packaged Numbat manifest has no target ${targetKey}`);
  }

  const resolvedRoot = path.resolve(numbatRoot);
  const binaryPath = path.resolve(numbatRoot, target.path);
  if (binaryPath !== resolvedRoot && !binaryPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Packaged Numbat target escapes its resource directory");
  }
  await fs.access(binaryPath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
  const actualSha256 = await sha256File(binaryPath);
  if (actualSha256.toLowerCase() !== String(target.sha256).toLowerCase()) {
    throw new Error(
      `Packaged Numbat checksum mismatch: expected ${target.sha256}, got ${actualSha256}`,
    );
  }

  for (const relativePath of ["NOTICE.md", "LICENSE.Numbat.txt", "rules/cowork-recommended"]) {
    await fs.access(path.join(numbatRoot, relativePath));
  }
  const version = run(binaryPath, ["version"], { shell: false, quiet: true });
  const expectedVersion = `numbat ${manifest.version} (schema ${manifest.schemaVersion})`;
  if (String(version.stdout || "").trim() !== expectedVersion) {
    throw new Error(`Unexpected packaged Numbat version output: ${version.stdout || ""}`);
  }
  run(
    binaryPath,
    ["rules", "check", "--rules-dir", path.join(numbatRoot, "rules", "cowork-recommended")],
    { shell: false, quiet: true },
  );
}

async function walkDirs(dir, predicate, maxDepth = 3) {
  const results = [];
  async function visit(current, depth) {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (predicate(fullPath, entry.name)) {
          results.push(fullPath);
        } else {
          await visit(fullPath, depth + 1);
        }
      }
    }
  }
  await visit(dir, 0);
  return results;
}

function plistValue(plistPath, key) {
  const result = run("/usr/libexec/PlistBuddy", ["-c", `Print:${key}`, plistPath], {
    stdio: "pipe",
    shell: false,
    quiet: true,
  });
  return String(result.stdout || "").trim();
}

function summarizeCommandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function assertMacCodeSignature(appPath, allowUnsigned) {
  const verify = runStatus("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    shell: false,
  });
  if (verify.status !== 0) {
    throw new Error(
      `macOS app bundle has an invalid code signature:\n${summarizeCommandOutput(verify)}`,
    );
  }

  const display = runStatus("codesign", ["-dvvv", appPath], { shell: false });
  const details = summarizeCommandOutput(display);
  if (display.status !== 0) {
    throw new Error(`Failed to inspect macOS app code signature:\n${details}`);
  }

  const isAdHoc = /\bSignature=adhoc\b/.test(details);
  const teamMatch = details.match(/^TeamIdentifier=(.+)$/m);
  const teamIdentifier = teamMatch?.[1]?.trim();
  const hasTeamIdentifier = Boolean(teamIdentifier && teamIdentifier !== "not set");

  if (allowUnsigned) {
    if (!isAdHoc) {
      throw new Error("Expected an unsigned macOS app to be ad hoc signed, but it was not.");
    }
    const entitlements = runStatus("codesign", ["-d", "--entitlements", ":-", appPath], {
      shell: false,
    });
    const entitlementDetails = summarizeCommandOutput(entitlements);
    if (/com\.apple\.developer\./.test(entitlementDetails)) {
      throw new Error(
        `Unsigned macOS app contains restricted developer entitlements:\n${entitlementDetails}`,
      );
    }
    console.log("[desktop-smoke] macOS app is validly ad hoc signed for unsigned distribution.");
    return;
  }

  if (isAdHoc || !hasTeamIdentifier) {
    throw new Error(
      "macOS app is not Developer ID signed. Re-run with --allow-unsigned only for unsigned fallback artifacts.",
    );
  }

  const gatekeeper = runStatus("spctl", ["-a", "-vv", appPath], { shell: false });
  if (gatekeeper.status !== 0) {
    throw new Error(`macOS Gatekeeper assessment failed:\n${summarizeCommandOutput(gatekeeper)}`);
  }
}

async function smokeLaunchMac(executablePath) {
  let spawnError = null;
  let output = "";
  const child = spawn(executablePath, [], {
    env: {
      ...process.env,
      COWORK_DESKTOP_SMOKE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  await new Promise((resolve) => setTimeout(resolve, MAC_LAUNCH_MS));
  if (spawnError) {
    throw spawnError;
  }
  if (child.exitCode !== null && child.exitCode !== 0) {
    throw new Error(
      `macOS app exited during smoke launch with code ${child.exitCode}:\n${output.trim()}`,
    );
  }
  if (child.exitCode === 0) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function smokeMac({ releaseDir, expectedVersion, allowUnsigned }) {
  const dmg = await findSingleVersionedFile(
    releaseDir,
    (file) => file.name.endsWith(".dmg") && !file.name.endsWith(".blockmap"),
    "macOS DMG",
    expectedVersion,
  );
  if (dmg.size < MIN_DMG_BYTES) {
    throw new Error(`DMG is unexpectedly small: ${dmg.size} bytes (${dmg.name})`);
  }

  validateUpdaterMetadata(releaseDir);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-mac-dmg-smoke-"));
  const mountPoint = path.join(tempRoot, "mount");
  await fs.mkdir(mountPoint, { recursive: true });
  let mounted = false;
  try {
    run("hdiutil", ["attach", dmg.fullPath, "-readonly", "-nobrowse", "-mountpoint", mountPoint], {
      shell: false,
    });
    mounted = true;

    const apps = await walkDirs(mountPoint, (_fullPath, name) => name.endsWith(".app"), 2);
    if (apps.length !== 1) {
      throw new Error(`Expected one .app inside DMG, found: ${apps.join(", ") || "none"}`);
    }

    const appPath = apps[0];
    const plistPath = path.join(appPath, "Contents", "Info.plist");
    const executableName = plistValue(plistPath, "CFBundleExecutable");
    const bundleVersion = plistValue(plistPath, "CFBundleShortVersionString");
    if (bundleVersion !== expectedVersion) {
      throw new Error(`Expected macOS app version ${expectedVersion}, found ${bundleVersion}`);
    }

    const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
    await fs.access(executablePath, fsConstants.X_OK);
    await validateNumbatRuntime(
      path.join(appPath, "Contents", "Resources"),
      `darwin-${process.arch}`,
    );
    assertMacCodeSignature(appPath, allowUnsigned);
    await smokeLaunchMac(executablePath);
    console.log(`[desktop-smoke] macOS DMG passed: ${dmg.name} (${path.basename(appPath)})`);
  } finally {
    if (mounted) {
      try {
        run("hdiutil", ["detach", mountPoint, "-force"], { shell: false });
      } catch (error) {
        console.warn(`[desktop-smoke] Failed to detach ${mountPoint}: ${error.message}`);
      }
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function powershell(command) {
  return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    shell: false,
    quiet: true,
  });
}

async function findInstalledWindowsApp(programsDir) {
  const script = `
$app = Get-ChildItem -Path '${programsDir.replaceAll("'", "''")}' -Filter 'CoWork OS.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $app) { exit 2 }
Write-Output $app.FullName
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", shell: false },
  );
  if ((result.status ?? 1) !== 0) return null;
  return String(result.stdout || "").trim();
}

function resolveWindowsProgramsDir() {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local", "Programs")
      : null,
    path.join(os.homedir(), "AppData", "Local", "Programs"),
  ].filter(Boolean);

  return candidates[0];
}

async function uninstallWindowsApp(programsDir) {
  const script = `
$uninstaller = Get-ChildItem -Path '${programsDir.replaceAll("'", "''")}' -Filter 'Uninstall CoWork OS.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($uninstaller) {
  $p = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { exit $p.ExitCode }
}
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", shell: false },
  );
  if ((result.status ?? 0) !== 0) {
    throw new Error(`Windows uninstaller failed with exit code ${result.status ?? 1}`);
  }
}

function taskkill(pid) {
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    shell: false,
  });
}

async function smokeWindows({ releaseDir, expectedVersion, skipLaunch }) {
  const installer = await findSingleVersionedFile(
    releaseDir,
    (file) => file.name.endsWith(".exe") && !/^Uninstall/i.test(file.name),
    "Windows installer",
    expectedVersion,
  );
  if (installer.size < MIN_EXE_BYTES) {
    throw new Error(`Installer is unexpectedly small: ${installer.size} bytes (${installer.name})`);
  }

  validateUpdaterMetadata(releaseDir);

  const programsDir = resolveWindowsProgramsDir();
  if (!programsDir) {
    throw new Error(
      "Could not resolve the per-user Windows Programs directory for installer smoke test.",
    );
  }

  for (const dirName of ["CoWork OS", "cowork-os"]) {
    await fs.rm(path.join(programsDir, dirName), { recursive: true, force: true });
  }

  let appExe = null;
  let child = null;
  try {
    run(installer.fullPath, ["/S"], { shell: false, stdio: "inherit" });
    appExe = await findInstalledWindowsApp(programsDir);
    if (!appExe) {
      throw new Error(`Installed app executable not found under ${programsDir}`);
    }

    const versionScript = `
$item = Get-Item '${appExe.replaceAll("'", "''")}'
Write-Output $item.VersionInfo.ProductVersion
`;
    const versionResult = powershell(versionScript);
    const installedVersion = String(versionResult.stdout || "").trim();
    if (installedVersion && !installedVersion.startsWith(expectedVersion)) {
      throw new Error(
        `Expected installed app version ${expectedVersion}, found ${installedVersion}`,
      );
    }
    await validateNumbatRuntime(
      path.join(path.dirname(appExe), "resources"),
      `win32-${process.arch}`,
    );

    if (!skipLaunch) {
      let spawnError = null;
      child = spawn(appExe, [], {
        cwd: path.dirname(appExe),
        env: {
          ...process.env,
          COWORK_DESKTOP_SMOKE: "1",
        },
        stdio: "ignore",
      });
      child.on("error", (error) => {
        spawnError = error;
      });
      await new Promise((resolve) => setTimeout(resolve, WINDOWS_LAUNCH_MS));
      if (spawnError) {
        throw spawnError;
      }
      if (child.exitCode !== null) {
        throw new Error(`Installed app exited during smoke launch with code ${child.exitCode}`);
      }
    }

    console.log(`[desktop-smoke] Windows installer passed: ${installer.name}`);
  } finally {
    if (child && child.exitCode === null) {
      taskkill(child.pid);
    }
    await uninstallWindowsApp(programsDir);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const platform = normalizePlatform(args.platform);
  assertHostPlatform(platform);
  const expectedVersion = args.expectedVersion || readPackageVersion();

  if (platform === "mac") {
    await smokeMac({
      releaseDir: args.releaseDir,
      expectedVersion,
      allowUnsigned: args.allowUnsigned,
    });
  } else {
    await smokeWindows({
      releaseDir: args.releaseDir,
      expectedVersion,
      skipLaunch: args.skipLaunch,
    });
  }
}

main().catch((error) => {
  console.error(`[desktop-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
