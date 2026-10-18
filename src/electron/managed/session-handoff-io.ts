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
  parseHandoffManifest,
  safeRelativeArtifactPath,
} from "./session-handoff";

export type HandoffWorkspace = Pick<Workspace, "path" | "permissions">;

export const HANDOFF_MANIFEST_FILE = "manifest.json";
const HANDOFF_ARTIFACTS_DIR = "artifacts";

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

export interface HandoffArtifactCopy {
  relativePath: string;
  data: Buffer;
}

/**
 * Hash the latest committed revisions again and keep a copy of each one that still matches what
 * the session recorded. A file that changed afterwards is listed but not copied.
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
      warnings.push(`Skipped a file outside the workspace or with an unsafe name.`);
      continue;
    }
    if (relativePath.startsWith(`${HANDOFF_PACKAGE_DIR.split(path.sep).join("/")}/`)) continue;
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

/** Write manifest.json and artifacts/ under `<packageRoot>/<packageId>/`; returns that directory. */
export function writeHandoffPackage(
  workspace: HandoffWorkspace,
  packageRoot: string,
  manifest: SessionHandoffManifest,
  copies: readonly HandoffArtifactCopy[],
): string {
  const root = workspaceRoot(workspace);
  fs.mkdirSync(packageRoot, { recursive: true });
  if (path.relative(root, packageRoot) === HANDOFF_PACKAGE_DIR) {
    // Packages hold transcript excerpts; keep them out of the repository by default.
    try {
      fs.writeFileSync(path.join(packageRoot, ".gitignore"), "*\n", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const packageDir = containedPath(
    workspace,
    root,
    path.join(packageRoot, manifest.packageId),
    "write",
    "handoff package directory",
  );
  fs.mkdirSync(packageDir);
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

/** Read and verify a manifest that sits inside the target workspace. */
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
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(manifestFile);
  } catch {
    throw new HandoffPackageError(`No ${HANDOFF_MANIFEST_FILE} found at ${manifestPath}`);
  }
  if (!stats.isFile()) throw new HandoffPackageError("The handoff manifest is not a regular file");
  if (stats.size > HANDOFF_LIMITS.maxManifestBytes) {
    throw new HandoffPackageError("The handoff manifest is larger than the 8 MB limit");
  }
  const manifest = parseHandoffManifest(fs.readFileSync(manifestFile, "utf8"));
  return { manifest, packageDir: path.dirname(manifestFile) };
}

export interface RestoredHandoffArtifact {
  relativePath: string;
  absolutePath: string;
  sha256: string;
  size: number;
  mimeType: string;
  alreadyPresent: boolean;
}

/**
 * Copy verified package files into the workspace. A copy whose bytes do not match the manifest is
 * skipped, and an existing different file is kept rather than overwritten.
 */
export function restoreHandoffArtifacts(
  workspace: HandoffWorkspace,
  packageDir: string,
  manifest: SessionHandoffManifest,
): { restored: RestoredHandoffArtifact[]; skipped: string[] } {
  const root = workspaceRoot(workspace);
  const restored: RestoredHandoffArtifact[] = [];
  const skipped: string[] = [];
  for (const artifact of manifest.artifacts) {
    const relativePath = safeRelativeArtifactPath(artifact.path);
    if (!relativePath) {
      skipped.push(`${artifact.path.slice(0, 200)}: unsafe path`);
      continue;
    }
    if (!artifact.copied) {
      skipped.push(`${relativePath}: not included in the package`);
      continue;
    }
    let data: Buffer;
    try {
      const source = path.join(packageDir, HANDOFF_ARTIFACTS_DIR, ...relativePath.split("/"));
      if (passesThroughSymlink(packageDir, source)) throw new Error("symlink");
      const stats = fs.lstatSync(source);
      if (!stats.isFile() || stats.size !== artifact.size) throw new Error("size");
      if (stats.size > HANDOFF_LIMITS.maxArtifactBytes) throw new Error("size");
      data = fs.readFileSync(source);
    } catch {
      skipped.push(`${relativePath}: missing or unreadable in the package`);
      continue;
    }
    const digest = sha256(data);
    if (digest !== artifact.sha256) {
      skipped.push(`${relativePath}: checksum mismatch (the copy was changed or corrupted)`);
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
    if (fs.existsSync(target)) {
      let existingDigest = "";
      try {
        existingDigest = sha256(fs.readFileSync(target));
      } catch {
        // An unreadable existing file is treated as different and kept.
      }
      if (existingDigest === digest) {
        restored.push({ ...base, alreadyPresent: true });
      } else {
        skipped.push(`${relativePath}: kept the existing different file in this workspace`);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: "wx" });
    restored.push({ ...base, alreadyPresent: false });
  }
  return { restored, skipped };
}
