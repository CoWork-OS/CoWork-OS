import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getUserDataDir } from "../../utils/user-data-dir";

interface NumbatTargetManifest {
  path: string;
  sha256: string;
}

interface NumbatManifest {
  version: string;
  commit: string;
  schemaVersion: string;
  adapterProtocol: string;
  targets: Record<string, NumbatTargetManifest>;
}

export interface ResolvedNumbatBinary {
  path: string;
  sha256: string;
  version: string;
  commit: string;
  schemaVersion: string;
  source: "environment" | "stable" | "bundled";
}

function sha256File(filePath: string): string {
  let hashPath = filePath;
  let temporaryDir: string | undefined;
  if (process.platform === "darwin") {
    temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-numbat-hash-"));
    const unsignedCopy = path.join(temporaryDir, path.basename(filePath));
    fs.copyFileSync(filePath, unsignedCopy);
    const result = spawnSync("codesign", ["--remove-signature", unsignedCopy], {
      encoding: "utf8",
      stdio: "ignore",
    });
    if (result.status === 0) hashPath = unsignedCopy;
  }

  const hash = createHash("sha256");
  try {
    const data = fs.readFileSync(hashPath);
    if (process.platform === "darwin" && data.readUInt32LE(0) === 0xfeedfacf) {
      const commandCount = data.readUInt32LE(16);
      let offset = 32;
      for (let index = 0; index < commandCount; index += 1) {
        const command = data.readUInt32LE(offset);
        const commandSize = data.readUInt32LE(offset + 4);
        if (
          command === 0x19 &&
          data.toString("ascii", offset + 8, offset + 24).startsWith("__LINKEDIT")
        ) {
          data.fill(0, offset + 32, offset + 40);
          data.fill(0, offset + 48, offset + 56);
        }
        if (commandSize < 8) break;
        offset += commandSize;
      }
    }
    hash.update(data);
    return hash.digest("hex");
  } finally {
    if (temporaryDir) fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function assertSafeBinary(filePath: string, expectedSha256: string): void {
  const linkStat = fs.lstatSync(filePath);
  if (linkStat.isSymbolicLink()) throw new Error("Numbat binary must not be a symbolic link");
  if (!linkStat.isFile()) throw new Error("Numbat runtime path is not a file");
  if (process.platform !== "win32") {
    if ((linkStat.mode & 0o022) !== 0) {
      throw new Error("Numbat binary is group- or world-writable");
    }
    if (
      typeof process.getuid === "function" &&
      linkStat.uid !== process.getuid() &&
      linkStat.uid !== 0
    ) {
      throw new Error("Numbat binary is not owned by the current user or root");
    }
    fs.accessSync(filePath, fs.constants.X_OK);
  }
  const actualSha256 = sha256File(filePath);
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error("Numbat binary checksum does not match the pinned manifest");
  }
}

function assertSafeManifest(manifestPath: string): void {
  const stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Numbat manifest must be a real file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error("Numbat manifest is group- or world-writable");
  }
}

function candidateManifestPaths(): string[] {
  const candidates: string[] = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "numbat", "manifest.json"));
  }
  candidates.push(path.resolve(__dirname, "../../../../build/numbat/manifest.json"));
  candidates.push(path.resolve(__dirname, "../../../../../build/numbat/manifest.json"));
  candidates.push(path.resolve(__dirname, "../../../../resources/numbat/manifest.json"));
  candidates.push(path.resolve(__dirname, "../../../../../resources/numbat/manifest.json"));
  return [...new Set(candidates)];
}

function loadManifest(): { manifest: NumbatManifest; path: string } {
  for (const manifestPath of candidateManifestPaths()) {
    if (!fs.existsSync(manifestPath)) continue;
    assertSafeManifest(manifestPath);
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as NumbatManifest;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.version !== "string" ||
      typeof parsed.commit !== "string" ||
      typeof parsed.schemaVersion !== "string" ||
      typeof parsed.adapterProtocol !== "string" ||
      !parsed.targets ||
      typeof parsed.targets !== "object"
    ) {
      throw new Error(`Invalid Numbat manifest: ${manifestPath}`);
    }
    return { manifest: parsed, path: manifestPath };
  }
  throw new Error("Bundled Numbat manifest is missing");
}

export function resolveNumbatBinary(): ResolvedNumbatBinary {
  const environmentPath = process.env.COWORK_NUMBAT_BINARY?.trim();
  const environmentSha256 = process.env.COWORK_NUMBAT_SHA256?.trim();
  if (environmentPath) {
    if (!environmentSha256) {
      throw new Error("COWORK_NUMBAT_SHA256 is required with COWORK_NUMBAT_BINARY");
    }
    const absolutePath = path.resolve(environmentPath);
    assertSafeBinary(absolutePath, environmentSha256);
    return {
      path: absolutePath,
      sha256: environmentSha256,
      version: "external",
      commit: "external",
      schemaVersion: "unknown",
      source: "environment",
    };
  }

  const { manifest, path: manifestPath } = loadManifest();
  const targetKey = `${process.platform}-${process.arch}`;
  const target = manifest.targets[targetKey];
  if (
    !target?.path ||
    !target.sha256 ||
    path.isAbsolute(target.path) ||
    !/^[a-f0-9]{64}$/i.test(target.sha256)
  ) {
    throw new Error(`No pinned Numbat runtime is available for ${targetKey}`);
  }

  const stableBinary = path.join(
    getUserDataDir(),
    "security",
    "numbat",
    "bin",
    process.platform === "win32" ? "numbat.exe" : "numbat",
  );
  if (fs.existsSync(stableBinary)) {
    try {
      assertSafeBinary(stableBinary, target.sha256);
      return {
        path: stableBinary,
        sha256: target.sha256,
        version: manifest.version,
        commit: manifest.commit,
        schemaVersion: manifest.schemaVersion,
        source: "stable",
      };
    } catch {
      // A stale stable copy must never shadow the pinned bundled runtime.
    }
  }

  const manifestDir = fs.realpathSync(path.dirname(manifestPath));
  const bundledPath = path.resolve(manifestDir, target.path);
  const relativeTarget = path.relative(manifestDir, bundledPath);
  if (!relativeTarget || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error("Pinned Numbat runtime must be contained in its trusted resource directory");
  }
  assertSafeBinary(bundledPath, target.sha256);
  return {
    path: bundledPath,
    sha256: target.sha256,
    version: manifest.version,
    commit: manifest.commit,
    schemaVersion: manifest.schemaVersion,
    source: "bundled",
  };
}

export function materializeStableNumbatBinary(binary: ResolvedNumbatBinary): ResolvedNumbatBinary {
  if (binary.source === "stable" || binary.source === "environment") return binary;
  const stableDir = path.join(getUserDataDir(), "security", "numbat", "bin");
  fs.mkdirSync(stableDir, { recursive: true, mode: 0o700 });
  const stablePath = path.join(stableDir, process.platform === "win32" ? "numbat.exe" : "numbat");
  const temporaryPath = `${stablePath}.${process.pid}.tmp`;
  fs.copyFileSync(binary.path, temporaryPath);
  if (process.platform !== "win32") fs.chmodSync(temporaryPath, 0o700);
  assertSafeBinary(temporaryPath, binary.sha256);
  if (process.platform === "win32") fs.rmSync(stablePath, { force: true });
  fs.renameSync(temporaryPath, stablePath);
  assertSafeBinary(stablePath, binary.sha256);
  return { ...binary, path: stablePath, source: "stable" };
}
