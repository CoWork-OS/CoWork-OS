/**
 * File-system side of the session handoff package. Every path is contained by the workspace,
 * checked against the workspace access policy, and rejected when it passes through a symlink.
 * Package files are created exclusively (`wx`), so an export never overwrites anything and an
 * import never replaces a file the user already has.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionHandoffManifest } from "../../shared/managed-session-schemas";
import type { ArtifactRevision, Workspace } from "../../shared/types";
import { assertWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import { getWorkspaceRelativePosixPath } from "../security/project-access";
import { WorkspaceArtifactEvidenceInspector } from "../sessions/WorkspaceArtifactEvidenceInspector";
import {
  HANDOFF_LIMITS,
  HANDOFF_PACKAGE_DIR,
  HandoffPackageError,
  handoffRestoreRefusal,
  isSensitiveArtifact,
  parseHandoffManifest,
  safeRelativeArtifactPath,
} from "./session-handoff";

export type HandoffWorkspace = Pick<Workspace, "path" | "permissions">;

export const HANDOFF_MANIFEST_FILE = "manifest.json";
const HANDOFF_ARTIFACTS_DIR = "artifacts";
const HANDOFF_PACKAGE_POSIX_DIR = HANDOFF_PACKAGE_DIR.split(path.sep).join("/");

function workspaceRoot(workspace: HandoffWorkspace): string {
  return fs.realpathSync.native(path.resolve(workspace.path));
}

/** True when any existing component between root (exclusive) and target is a symlink. */
function passesThroughSymlink(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Absolute path inside the workspace that the policy allows for `operation`. */
function containedPath(
  workspace: HandoffWorkspace,
  root: string,
  candidate: string,
  operation: "read" | "write",
  label: string,
): string {
  // Callers may name the path through the workspace's lexical root (e.g. /var/...) or its
  // canonical root (e.g. /private/var/...); both map onto the canonical root.
  const lexicalRoot = path.resolve(workspace.path);
  const relative =
    getWorkspaceRelativePosixPath(lexicalRoot, path.resolve(lexicalRoot, candidate)) ??
    getWorkspaceRelativePosixPath(root, path.resolve(root, candidate));
  if (relative === null) {
    throw new HandoffPackageError(`The ${label} must be inside the workspace`);
  }
  const resolved = path.join(root, ...relative.split("/"));
  if (passesThroughSymlink(root, resolved)) {
    throw new HandoffPackageError(`The ${label} path passes through a symlink`);
  }
  assertWorkspaceFilesystemAccess(workspace, resolved, operation, label);
  return resolved;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Read a regular file through one descriptor that refuses symlinks, up to `maxBytes`. */
function readBoundedFile(filePath: string, maxBytes: number): Buffer {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw new HandoffPackageError("not a regular file");
    if (stats.size > maxBytes) throw new HandoffPackageError("larger than the size limit");
    const data = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < stats.size) {
      const read = fs.readSync(fd, data, offset, stats.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return data.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

export interface HandoffArtifactCopy {
  relativePath: string;
  data: Buffer;
}

/**
 * Hash the latest committed revisions again and keep a copy of each one that still matches what
 * the session recorded. A file that changed afterwards, or that may hold a credential, is listed
 * but not copied.
 */
export function collectHandoffArtifacts(
  workspace: HandoffWorkspace,
  revisions: readonly ArtifactRevision[],
  warnings: string[],
  inspector = new WorkspaceArtifactEvidenceInspector({ maxBytes: HANDOFF_LIMITS.maxArtifactBytes }),
): { artifacts: SessionHandoffManifest["artifacts"]; copies: HandoffArtifactCopy[] } {
  const root = workspaceRoot(workspace);
  const lexicalRoot = path.resolve(workspace.path);
  const artifacts: SessionHandoffManifest["artifacts"] = [];
  const copies: HandoffArtifactCopy[] = [];
  let totalBytes = 0;
  for (const revision of revisions.slice(0, HANDOFF_LIMITS.maxArtifacts)) {
    // Revisions may record the path through the workspace's lexical or canonical root.
    const relative =
      getWorkspaceRelativePosixPath(lexicalRoot, path.resolve(lexicalRoot, revision.path)) ??
      getWorkspaceRelativePosixPath(root, path.resolve(root, revision.path));
    const relativePath = relative ? safeRelativeArtifactPath(relative) : undefined;
    if (!relativePath) {
      warnings.push("Skipped a file outside the workspace or with an unsafe name.");
      continue;
    }
    if (relativePath.startsWith(`${HANDOFF_PACKAGE_POSIX_DIR}/`)) continue;
    const entry = {
      path: relativePath,
      sha256: revision.sha256,
      size: revision.size,
      mimeType: revision.mimeType.slice(0, 200),
      revision: revision.revision,
      copied: false,
    };
    const snapshot = inspector.snapshot(workspace, path.join(root, relativePath));
    if (snapshot.status === "missing") {
      warnings.push(`${relativePath}: no longer exists, not copied.`);
    } else if (snapshot.status === "unavailable") {
      warnings.push(`${relativePath}: not copied (${snapshot.reason}).`);
    } else if (snapshot.sha256 !== revision.sha256 || !snapshot.data) {
      warnings.push(`${relativePath}: changed after the session recorded it, not copied.`);
    } else if (isSensitiveArtifact(relativePath, snapshot.data)) {
      warnings.push(`${relativePath}: may contain a credential, not copied.`);
    } else if (totalBytes + snapshot.data.length > HANDOFF_LIMITS.maxPackageBytes) {
      warnings.push(`${relativePath}: package size limit reached, not copied.`);
    } else {
      totalBytes += snapshot.data.length;
      copies.push({ relativePath, data: snapshot.data });
      entry.copied = true;
    }
    artifacts.push(entry);
  }
  return { artifacts, copies };
}

/** `<workspace>/.cowork/handoffs` by default, or a directory the operator chose in the workspace. */
export function resolveHandoffPackageRoot(workspace: HandoffWorkspace, targetDir?: string): string {
  const root = workspaceRoot(workspace);
  return containedPath(
    workspace,
    root,
    targetDir ? targetDir : HANDOFF_PACKAGE_DIR,
    "write",
    "handoff package directory",
  );
}

function writeIgnoreFile(directory: string): void {
  try {
    fs.writeFileSync(path.join(directory, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Write manifest.json and artifacts/ under `<packageRoot>/<packageId>/`; returns that directory. */
export function writeHandoffPackage(
  workspace: HandoffWorkspace,
  packageRoot: string,
  manifest: SessionHandoffManifest,
  copies: readonly HandoffArtifactCopy[],
): string {
  const root = workspaceRoot(workspace);
  fs.mkdirSync(packageRoot, { recursive: true });
  // Packages hold transcript excerpts and file copies; keep them out of the repository.
  if (path.relative(root, packageRoot) === HANDOFF_PACKAGE_DIR) writeIgnoreFile(packageRoot);
  const packageDir = containedPath(
    workspace,
    root,
    path.join(packageRoot, manifest.packageId),
    "write",
    "handoff package directory",
  );
  fs.mkdirSync(packageDir);
  writeIgnoreFile(packageDir);
  for (const copy of copies) {
    const target = containedPath(
      workspace,
      root,
      path.join(packageDir, HANDOFF_ARTIFACTS_DIR, ...copy.relativePath.split("/")),
      "write",
      "handoff artifact copy",
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, copy.data, { flag: "wx" });
  }
  fs.writeFileSync(
    path.join(packageDir, HANDOFF_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  return packageDir;
}

/**
 * Read and check a manifest from the target workspace's `.cowork/handoffs/`. Packages anywhere
 * else in the workspace (a cloned repository, node_modules) are not accepted.
 */
export function readHandoffPackage(
  workspace: HandoffWorkspace,
  manifestPath: string,
): { manifest: SessionHandoffManifest; packageDir: string } {
  const root = workspaceRoot(workspace);
  const resolved = containedPath(workspace, root, manifestPath, "read", "handoff manifest");
  const manifestFile =
    path.basename(resolved) === HANDOFF_MANIFEST_FILE
      ? resolved
      : path.join(resolved, HANDOFF_MANIFEST_FILE);
  const packageDir = path.dirname(manifestFile);
  if (path.dirname(packageDir) !== path.join(root, HANDOFF_PACKAGE_DIR)) {
    throw new HandoffPackageError(
      `Copy the package folder into ${HANDOFF_PACKAGE_POSIX_DIR}/ in the target workspace and import it from there`,
    );
  }
  let raw: Buffer;
  try {
    raw = readBoundedFile(manifestFile, HANDOFF_LIMITS.maxManifestBytes);
  } catch (error) {
    throw new HandoffPackageError(
      `Cannot read ${HANDOFF_MANIFEST_FILE} at ${manifestPath}: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }
  return { manifest: parseHandoffManifest(raw.toString("utf8")), packageDir };
}

export interface RestoredHandoffArtifact {
  relativePath: string;
  absolutePath: string;
  sha256: string;
  size: number;
  mimeType: string;
  alreadyPresent: boolean;
}

function existingFileDigest(target: string): string | "not_a_file" | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return undefined;
  }
  if (!stats.isFile() || stats.size > HANDOFF_LIMITS.maxArtifactBytes) return "not_a_file";
  try {
    return sha256(readBoundedFile(target, HANDOFF_LIMITS.maxArtifactBytes));
  } catch {
    return "not_a_file";
  }
}

/**
 * Copy verified package files into the workspace. A copy whose bytes do not match the manifest
 * is skipped, hidden and instruction files are never created, an existing different file is
 * kept, and the package's total size is checked before anything is written. With `dryRun`,
 * nothing is written and the result is the plan.
 */
export function restoreHandoffArtifacts(
  workspace: HandoffWorkspace,
  packageDir: string,
  manifest: SessionHandoffManifest,
  options: { dryRun?: boolean } = {},
): { restored: RestoredHandoffArtifact[]; skipped: string[] } {
  const root = workspaceRoot(workspace);
  const declaredBytes = manifest.artifacts
    .filter((artifact) => artifact.copied)
    .reduce((total, artifact) => total + artifact.size, 0);
  if (declaredBytes > HANDOFF_LIMITS.maxPackageBytes) {
    throw new HandoffPackageError("The package's files are larger than the 64 MB limit");
  }
  const packageLabel = path.relative(root, packageDir).split(path.sep).join("/");
  const restored: RestoredHandoffArtifact[] = [];
  const skipped: string[] = [];
  let restoredBytes = 0;
  for (const artifact of manifest.artifacts) {
    const relativePath = safeRelativeArtifactPath(artifact.path);
    if (!relativePath) {
      skipped.push("(a file with an unsafe path)");
      continue;
    }
    if (!artifact.copied) {
      skipped.push(`${relativePath}: not included in the package`);
      continue;
    }
    const refusal = handoffRestoreRefusal(relativePath);
    if (refusal) {
      skipped.push(
        `${relativePath}: ${refusal}; it is in ${packageLabel}/${HANDOFF_ARTIFACTS_DIR}/${relativePath}`,
      );
      continue;
    }
    let data: Buffer;
    try {
      const source = path.join(packageDir, HANDOFF_ARTIFACTS_DIR, ...relativePath.split("/"));
      if (passesThroughSymlink(packageDir, source)) throw new Error("symlink");
      data = readBoundedFile(source, Math.min(artifact.size, HANDOFF_LIMITS.maxArtifactBytes));
      if (data.length !== artifact.size) throw new Error("size");
    } catch {
      skipped.push(`${relativePath}: missing or unreadable in the package`);
      continue;
    }
    const digest = sha256(data);
    if (digest !== artifact.sha256) {
      skipped.push(`${relativePath}: checksum mismatch (the copy was changed or corrupted)`);
      continue;
    }
    if (restoredBytes + data.length > HANDOFF_LIMITS.maxPackageBytes) {
      skipped.push(`${relativePath}: package size limit reached`);
      continue;
    }
    let target: string;
    try {
      target = containedPath(
        workspace,
        root,
        path.join(root, ...relativePath.split("/")),
        "write",
        "restored handoff file",
      );
    } catch (error) {
      skipped.push(`${relativePath}: ${error instanceof Error ? error.message : "not allowed"}`);
      continue;
    }
    const base = {
      relativePath,
      absolutePath: target,
      sha256: digest,
      size: data.length,
      mimeType: artifact.mimeType,
    };
    const existing = existingFileDigest(target);
    if (existing !== undefined) {
      if (existing === digest) restored.push({ ...base, alreadyPresent: true });
      else skipped.push(`${relativePath}: kept the existing different file in this workspace`);
      continue;
    }
    if (options.dryRun) {
      restored.push({ ...base, alreadyPresent: false });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { flag: "wx" });
      // A directory swapped for a symlink between the check and the write lands elsewhere.
      if (!isWithin(root, fs.realpathSync.native(target))) {
        fs.rmSync(target, { force: true });
        throw new Error("the write left the workspace");
      }
    } catch (error) {
      skipped.push(
        `${relativePath}: could not be written (${error instanceof Error ? error.message : "error"})`,
      );
      continue;
    }
    restoredBytes += data.length;
    restored.push({ ...base, alreadyPresent: false });
  }
  return { restored, skipped };
}
