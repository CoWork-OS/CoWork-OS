#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const resourceDir = path.join(rootDir, "resources", "numbat");
const outputResourceDir = path.join(rootDir, "build", "numbat");
const sourceManifestPath = path.join(resourceDir, "source-manifest.json");
const runtimeManifestPath = path.join(outputResourceDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
const requestedTarget =
  process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length) ||
  `${process.platform}-${process.arch}`;
const verifyOnly = process.argv.includes("--verify-only");
if (fs.existsSync(runtimeManifestPath)) {
  const existingRuntimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, "utf8"));
  if (
    existingRuntimeManifest.commit === manifest.commit &&
    existingRuntimeManifest.adapterProtocol === manifest.adapterProtocol
  ) {
    manifest.targets = { ...existingRuntimeManifest.targets };
  }
}

const targets = {
  "darwin-arm64": { goos: "darwin", goarch: "arm64", extension: "" },
  "darwin-x64": { goos: "darwin", goarch: "amd64", extension: "" },
  "linux-arm64": { goos: "linux", goarch: "arm64", extension: "" },
  "linux-x64": { goos: "linux", goarch: "amd64", extension: "" },
  "win32-arm64": { goos: "windows", goarch: "arm64", extension: ".exe" },
  "win32-x64": { goos: "windows", goarch: "amd64", extension: ".exe" },
};

const goSDKs = {
  "darwin-arm64": {
    file: "go1.26.5.darwin-arm64.tar.gz",
    sha256: "efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a",
  },
  "darwin-x64": {
    file: "go1.26.5.darwin-amd64.tar.gz",
    sha256: "6231d8d3b8f5552ec6cbf6d685bdd5482e1e703214b120e89b3bf0d7bf1ef725",
  },
  "linux-arm64": {
    file: "go1.26.5.linux-arm64.tar.gz",
    sha256: "fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49",
  },
  "linux-x64": {
    file: "go1.26.5.linux-amd64.tar.gz",
    sha256: "5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053",
  },
  "win32-arm64": {
    file: "go1.26.5.windows-arm64.zip",
    sha256: "f96ee46396d69f1e231c8d981ec6a70216238a646a1f2cd74aea0d0016bbc017",
  },
  "win32-x64": {
    file: "go1.26.5.windows-amd64.zip",
    sha256: "97e6b2a833b6d89f9ff17d25419ac0a7e3b482a044e9ab18cdef834bd834fd38",
  },
};

function fail(message) {
  console.error(`[numbat-runtime] ${message}`);
  process.exit(1);
}

function normalizeMacMachO(buffer) {
  if (process.platform !== "darwin" || buffer.readUInt32LE(0) !== 0xfeedfacf) return;
  const commandCount = buffer.readUInt32LE(16);
  let offset = 32;
  for (let index = 0; index < commandCount; index += 1) {
    const command = buffer.readUInt32LE(offset);
    const commandSize = buffer.readUInt32LE(offset + 4);
    if (command === 0x19 && buffer.toString("ascii", offset + 8, offset + 24).startsWith("__LINKEDIT")) {
      buffer.fill(0, offset + 32, offset + 40);
      buffer.fill(0, offset + 48, offset + 56);
    }
    if (commandSize < 8) break;
    offset += commandSize;
  }
}

function sha256(filePath, { stripMacSignature = false } = {}) {
  let hashPath = filePath;
  let temporaryDir;
  if (stripMacSignature && process.platform === "darwin") {
    temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-numbat-hash-"));
    const unsignedCopy = path.join(temporaryDir, path.basename(filePath));
    fs.copyFileSync(filePath, unsignedCopy);
    const result = spawnSync("codesign", ["--remove-signature", unsignedCopy], {
      stdio: "ignore",
    });
    if (result.status === 0) hashPath = unsignedCopy;
  }

  const hash = createHash("sha256");
  try {
    const data = fs.readFileSync(hashPath);
    if (stripMacSignature) normalizeMacMachO(data);
    hash.update(data);
    return hash.digest("hex");
  } finally {
    if (temporaryDir) fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function verifyFile(filePath, expected, label, options = {}) {
  if (!fs.existsSync(filePath)) fail(`${label} is missing: ${filePath}`);
  const actual = sha256(filePath, options);
  if (actual !== expected) {
    fail(`${label} checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stdout || ""}${result.stderr || ""}`.trimEnd()
      : "";
    fail(`${command} exited with code ${result.status}${detail}`);
  }
  return result;
}

function tarPath(filePath) {
  if (process.platform !== "win32") return filePath;
  return path.resolve(filePath).replaceAll("\\", "/");
}

function tarSupportsForceLocal() {
  if (process.platform !== "win32") return false;
  // Windows runners may resolve either GNU tar or bsdtar; only GNU tar
  // understands --force-local, while both accept native drive paths.
  const result = spawnSync("tar", ["--help"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const help = `${result.stdout || ""}\n${result.stderr || ""}`;
  return result.status === 0 && help.includes("--force-local");
}

const useForceLocalTar = tarSupportsForceLocal();

function tarArgs(args) {
  return useForceLocalTar ? ["--force-local", ...args] : args;
}

async function download(url, outputPath, expectedSha256, label) {
  if (fs.existsSync(outputPath) && sha256(outputPath) === expectedSha256) return;
  if (process.env.COWORK_NUMBAT_OFFLINE === "1") {
    fail(`${label} is not cached and COWORK_NUMBAT_OFFLINE=1`);
  }
  console.log(`[numbat-runtime] Downloading ${label}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fail(`${label} download failed with HTTP ${response.status}`);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, Buffer.from(await response.arrayBuffer()), {
    mode: 0o600,
  });
  verifyFile(temporaryPath, expectedSha256, label);
  fs.renameSync(temporaryPath, outputPath);
}

function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

function findGo(cacheDir) {
  const explicit = process.env.COWORK_NUMBAT_GO?.trim();
  if (explicit) return path.resolve(explicit);
  const cached = path.join(
    cacheDir,
    "go-sdk",
    "go",
    "bin",
    process.platform === "win32" ? "go.exe" : "go",
  );
  if (fs.existsSync(cached)) return cached;
  const system = spawnSync("go", ["version"], {
    encoding: "utf8",
    shell: false,
  });
  if (system.status === 0 && /\bgo1\.26\.5\b/.test(system.stdout || "")) return "go";
  return "";
}

async function ensureGo(cacheDir) {
  const existing = findGo(cacheDir);
  if (existing) return existing;
  const sdk = goSDKs[hostTarget()];
  if (!sdk) fail(`No pinned Go SDK is available for build host ${hostTarget()}`);
  const archivePath = path.join(cacheDir, sdk.file);
  await download(`https://go.dev/dl/${sdk.file}`, archivePath, sdk.sha256, "Go SDK");
  const sdkRoot = path.join(cacheDir, "go-sdk");
  fs.rmSync(sdkRoot, { recursive: true, force: true });
  fs.mkdirSync(sdkRoot, { recursive: true, mode: 0o700 });
  if (sdk.file.endsWith(".zip")) {
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive",
        "-LiteralPath",
        archivePath,
        "-DestinationPath",
        sdkRoot,
        "-Force",
      ],
      { cwd: cacheDir },
    );
  } else {
    run("tar", tarArgs(["-xzf", tarPath(archivePath), "-C", tarPath(sdkRoot)]));
  }
  const resolved = findGo(cacheDir);
  if (!resolved) fail("Pinned Go SDK extraction did not produce the go executable");
  return resolved;
}

function recommendedRules(sourceRoot) {
  const outputDir = path.join(outputResourceDir, "rules", "cowork-recommended");
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
  for (const relativePath of manifest.recommendedRules) {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(sourcePath)) fail(`Pinned recommended rule is missing: ${relativePath}`);
    const ruleId = path.basename(relativePath, ".yaml");
    const source = fs.readFileSync(sourcePath, "utf8");
    if (!/\nenabled: true\n/.test(`\n${source}`)) {
      fail(`Recommended rule is not enabled upstream: ${relativePath}`);
    }
    const hardened = source.replace(
      /^enabled: true$/m,
      [
        "enabled: true",
        "enforce: true",
        `deny_message: "Blocked by CoWork OS agent security rule ${ruleId}."`,
      ].join("\n"),
    );
    fs.writeFileSync(path.join(outputDir, path.basename(relativePath)), hardened, {
      mode: 0o644,
    });
  }
}

function verifyGeneratedTarget(targetKey) {
  const target = manifest.targets?.[targetKey];
  if (!target?.path || !target.sha256) fail(`Manifest has no built target ${targetKey}`);
  const binaryPath = path.resolve(outputResourceDir, target.path);
  verifyFile(binaryPath, target.sha256, `Numbat ${targetKey} runtime`, {
    stripMacSignature: true,
  });
  if (process.platform !== "win32") {
    const stat = fs.lstatSync(binaryPath);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
      fail(`Numbat ${targetKey} runtime has unsafe file permissions`);
    }
  }
  const rulesDir = path.join(outputResourceDir, "rules", "cowork-recommended");
  for (const relativePath of manifest.recommendedRules) {
    const generated = path.join(rulesDir, path.basename(relativePath));
    if (!fs.existsSync(generated)) fail(`Generated recommended rule is missing: ${generated}`);
    const body = fs.readFileSync(generated, "utf8");
    if (!/^enforce: true$/m.test(body)) fail(`Recommended rule is not enforceable: ${generated}`);
  }
  console.log(`[numbat-runtime] Verified ${targetKey} (${target.sha256})`);
}

if (!targets[requestedTarget]) fail(`Unsupported target ${requestedTarget}`);
verifyFile(
  path.join(resourceDir, manifest.patch.path),
  manifest.patch.sha256,
  "CoWork OS Numbat adapter patch",
);
if (verifyOnly) {
  if (!fs.existsSync(runtimeManifestPath)) fail("Generated Numbat manifest is missing");
  verifyGeneratedTarget(requestedTarget);
  process.exit(0);
}

const cacheDir = path.join(os.homedir(), ".cache", "cowork-os", "numbat-build", manifest.commit);
fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
const sourceArchive = path.join(cacheDir, "numbat-source.tar.gz");
await download(manifest.source.url, sourceArchive, manifest.source.sha256, "Numbat source");
const goBinary = await ensureGo(cacheDir);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-numbat-build-"));

try {
  run("tar", tarArgs(["-xzf", tarPath(sourceArchive), "-C", tarPath(temporaryRoot)]));
  const sourceEntries = fs
    .readdirSync(temporaryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  if (sourceEntries.length !== 1) fail("Numbat source archive has an unexpected layout");
  const sourceRoot = path.join(temporaryRoot, sourceEntries[0].name);
  const patchPath = path.join(resourceDir, manifest.patch.path);
  run("git", ["apply", "--check", patchPath], { cwd: sourceRoot });
  run("git", ["apply", patchPath], { cwd: sourceRoot });

  const goCache = path.join(cacheDir, "go-build");
  const goModCache = path.join(cacheDir, "go-mod");
  fs.mkdirSync(goCache, { recursive: true, mode: 0o700 });
  fs.mkdirSync(goModCache, { recursive: true, mode: 0o700 });
  const commonEnv = {
    ...process.env,
    GOCACHE: goCache,
    GOMODCACHE: goModCache,
    GOFLAGS: "-mod=readonly",
  };
  run(goBinary, ["test", "./internal/hook", "-run", "CoworkOS", "-count=1"], {
    cwd: sourceRoot,
    env: commonEnv,
  });
  run(goBinary, ["test", "./internal/model"], {
    cwd: sourceRoot,
    env: commonEnv,
  });
  recommendedRules(sourceRoot);

  const target = targets[requestedTarget];
  const outputDir = path.join(outputResourceDir, "bin", requestedTarget);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
  const outputPath = path.join(outputDir, `numbat${target.extension}`);
  const temporaryOutput = `${outputPath}.${process.pid}.tmp`;
  run(
    goBinary,
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags",
      `-s -w -buildid= -X github.com/perplexityai/numbat/internal/version.Version=${manifest.version}`,
      "-o",
      temporaryOutput,
      "./cmd/numbat",
    ],
    {
      cwd: sourceRoot,
      env: {
        ...commonEnv,
        CGO_ENABLED: "0",
        GOOS: target.goos,
        GOARCH: target.goarch,
      },
    },
  );
  if (process.platform !== "win32") fs.chmodSync(temporaryOutput, 0o755);
  fs.renameSync(temporaryOutput, outputPath);
  const binarySha = sha256(outputPath, { stripMacSignature: true });
  manifest.targets ||= {};
  manifest.targets[requestedTarget] = {
    path: path.relative(outputResourceDir, outputPath).split(path.sep).join("/"),
    sha256: binarySha,
  };
  fs.mkdirSync(outputResourceDir, { recursive: true, mode: 0o755 });
  fs.copyFileSync(path.join(resourceDir, "NOTICE.md"), path.join(outputResourceDir, "NOTICE.md"));
  fs.copyFileSync(
    path.join(sourceRoot, "LICENSE"),
    path.join(outputResourceDir, "LICENSE.Numbat.txt"),
  );
  fs.writeFileSync(runtimeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });

  if (requestedTarget === hostTarget()) {
    const version = run(outputPath, ["version"], { capture: true });
    const expected = `numbat ${manifest.version} (schema ${manifest.schemaVersion})`;
    if ((version.stdout || "").trim() !== expected) {
      fail(`Unexpected Numbat version output: ${(version.stdout || "").trim()}`);
    }
    run(outputPath, [
      "rules",
      "check",
      "--rules-dir",
      path.join(outputResourceDir, "rules", "cowork-recommended"),
    ]);
  }
  verifyGeneratedTarget(requestedTarget);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
