import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Workspace } from "../../shared/types";
import { assertWorkspaceFilesystemAccess } from "../security/access-profile-paths";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export type WorkspaceArtifactInspection =
  | { status: "present"; path: string; sha256: string; size: number }
  | { status: "missing"; path: string }
  | {
      status: "unavailable";
      path?: string;
      reason:
        | "access_denied"
        | "outside_workspace"
        | "symlink"
        | "not_regular_file"
        | "too_large"
        | "changed_during_read"
        | "io_error";
    };

export interface WorkspaceArtifactEvidenceIo {
  realpathSync(path: string): string;
  lstatSync(path: string, options: { bigint: true }): fs.BigIntStats;
  openSync(path: string, flags: number): number;
  fstatSync(fd: number, options: { bigint: true }): fs.BigIntStats;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

const systemIo: WorkspaceArtifactEvidenceIo = {
  realpathSync: (filePath) => fs.realpathSync.native(filePath),
  lstatSync: (filePath, options) => fs.lstatSync(filePath, options),
  openSync: (filePath, flags) => fs.openSync(filePath, flags),
  fstatSync: (fd, options) => fs.fstatSync(fd, options),
  readSync: (fd, buffer, offset, length, position) =>
    fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
};

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function sameIdentityAndVersion(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function unavailable(
  reason: Extract<WorkspaceArtifactInspection, { status: "unavailable" }>["reason"],
  targetPath?: string,
): WorkspaceArtifactInspection {
  return { status: "unavailable", reason, ...(targetPath ? { path: targetPath } : {}) };
}

function containsSymlink(root: string, relative: string, io: WorkspaceArtifactEvidenceIo): boolean {
  let currentPath = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, component);
    try {
      if (io.lstatSync(currentPath, { bigint: true }).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Read and hash one exact workspace file using the workspace's normal read policy. */
export class WorkspaceArtifactEvidenceInspector {
  constructor(
    private readonly options: { maxBytes?: number; io?: WorkspaceArtifactEvidenceIo } = {},
  ) {}

  inspect(
    workspace: Pick<Workspace, "path" | "permissions">,
    rawPath: string,
  ): WorkspaceArtifactInspection {
    const maxBytes = Math.max(1, Math.floor(this.options.maxBytes ?? DEFAULT_MAX_BYTES));
    const io = this.options.io || systemIo;
    let workspaceRoot = "";
    let candidate = "";
    let relative = "";

    try {
      workspaceRoot = io.realpathSync(path.resolve(workspace.path));
      const lexicalRoot = path.resolve(workspace.path);
      const lexicalCandidate = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(lexicalRoot, rawPath);
      const lexicalRelative = path.relative(lexicalRoot, lexicalCandidate);
      const canonicalRelative = path.isAbsolute(rawPath)
        ? path.relative(workspaceRoot, lexicalCandidate)
        : lexicalRelative;
      const isWithinRoot = (candidateRelative: string) =>
        candidateRelative !== ".." &&
        !candidateRelative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(candidateRelative);
      if (!isWithinRoot(lexicalRelative) && !isWithinRoot(canonicalRelative)) {
        return unavailable("outside_workspace", rawPath);
      }
      relative = isWithinRoot(lexicalRelative) ? lexicalRelative : canonicalRelative;
      candidate = path.resolve(workspaceRoot, relative);
      if (!isWithin(workspaceRoot, candidate) || candidate === workspaceRoot) {
        return unavailable("outside_workspace", rawPath);
      }
      candidate = assertWorkspaceFilesystemAccess(
        workspace,
        candidate,
        "read",
        "completion evidence file",
      );
      if (!isWithin(workspaceRoot, path.resolve(candidate))) {
        return unavailable("outside_workspace", rawPath);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Access denied") &&
        workspaceRoot &&
        relative &&
        containsSymlink(workspaceRoot, relative, io)
      ) {
        return unavailable("symlink", rawPath);
      }
      const reason =
        error instanceof Error && error.message.includes("Access denied")
          ? "access_denied"
          : "io_error";
      return unavailable(reason, rawPath);
    }

    const components = relative.split(path.sep).filter(Boolean);
    let currentPath = workspaceRoot;
    let initialPathStats: fs.BigIntStats | undefined;
    for (const [index, component] of components.entries()) {
      currentPath = path.join(currentPath, component);
      try {
        const stats = io.lstatSync(currentPath, { bigint: true });
        if (stats.isSymbolicLink()) return unavailable("symlink", rawPath);
        if (index === components.length - 1) initialPathStats = stats;
        else if (!stats.isDirectory()) return unavailable("not_regular_file", rawPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return { status: "missing", path: candidate };
        }
        return unavailable("io_error", rawPath);
      }
    }
    if (!initialPathStats) return unavailable("not_regular_file", rawPath);
    if (!initialPathStats.isFile()) return unavailable("not_regular_file", rawPath);
    if (initialPathStats.size > BigInt(maxBytes)) return unavailable("too_large", rawPath);

    let fd: number | undefined;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      fd = io.openSync(candidate, flags);
      const openedStats = io.fstatSync(fd, { bigint: true });
      if (!openedStats.isFile() || !sameIdentityAndVersion(initialPathStats, openedStats)) {
        return unavailable("changed_during_read", rawPath);
      }

      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let bytesRead = 0;
      while (true) {
        const read = io.readSync(fd, buffer, 0, buffer.length, bytesRead);
        if (read === 0) break;
        bytesRead += read;
        if (bytesRead > maxBytes) return unavailable("too_large", rawPath);
        digest.update(buffer.subarray(0, read));
      }

      const finalFdStats = io.fstatSync(fd, { bigint: true });
      const finalPathStats = io.lstatSync(candidate, { bigint: true });
      let finalRealPath: string;
      try {
        finalRealPath = io.realpathSync(candidate);
      } catch {
        return unavailable("changed_during_read", rawPath);
      }
      if (
        finalPathStats.isSymbolicLink() ||
        !sameIdentityAndVersion(openedStats, finalFdStats) ||
        !sameIdentityAndVersion(openedStats, finalPathStats) ||
        path.resolve(finalRealPath) !== path.resolve(candidate) ||
        bytesRead !== Number(finalFdStats.size)
      ) {
        return unavailable("changed_during_read", rawPath);
      }
      assertWorkspaceFilesystemAccess(workspace, finalRealPath, "read", "completion evidence file");
      return {
        status: "present",
        path: finalRealPath,
        sha256: digest.digest("hex"),
        size: bytesRead,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { status: "missing", path: candidate };
      }
      if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
        return unavailable("symlink", rawPath);
      }
      return unavailable("io_error", rawPath);
    } finally {
      if (fd !== undefined) {
        try {
          io.closeSync(fd);
        } catch {
          // The inspection result is already determined; close errors do not add proof.
        }
      }
    }
  }
}
