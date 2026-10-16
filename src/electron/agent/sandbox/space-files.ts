import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Workspace } from "../../../shared/types";
import { evaluateWorkspaceFilesystemAccess } from "../../security/access-profile-paths";
import { decodeSpaceBase64 } from "./space-client";
import { isSpaceRelativePath } from "../../../shared/space-sandbox";

export const SPACE_TRANSFER_LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = 2 * 1024 * 1024;
export interface SpaceInput {
  path: string;
  data: Buffer;
  internal?: boolean;
}

/** Portable relative paths only, with no implicit directory traversal or private configuration. */
export function spaceRelativePath(value: string): string {
  if (!isSpaceRelativePath(value)) {
    throw new Error(
      "SPACE transfers require workspace-relative files outside private configuration",
    );
  }
  return value;
}

function checkedPath(workspace: Workspace, relative: string, operation: "read" | "write"): string {
  spaceRelativePath(relative);
  const root = fs.realpathSync(workspace.path);
  // Resolve only the workspace's conventional system alias, never links below it.
  let current = root;
  for (const component of relative.split("/").slice(0, -1)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("SPACE transfer parent is not a real directory");
  }
  const target = path.join(current, path.basename(relative));
  const decision = evaluateWorkspaceFilesystemAccess(workspace, target, operation);
  if (decision.decision !== "allow")
    throw new Error(`SPACE file ${operation} denied: ${decision.reason}`);
  return target;
}

export function snapshotSpaceInputs(workspace: Workspace, paths: string[]): SpaceInput[] {
  if (paths.length > 64 || new Set(paths).size !== paths.length)
    throw new Error("Invalid SPACE input selection");
  let total = 0;
  return paths.map((relative) => {
    const target = checkedPath(workspace, relative, "read");
    const fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > FILE_LIMIT || (total += stat.size) > SPACE_TRANSFER_LIMIT) {
        throw new Error("SPACE input exceeds regular-file transfer limits");
      }
      // Read a fixed bound even if another writer grows the file after fstat.
      const data = Buffer.alloc(stat.size + 1);
      const count = fs.readSync(fd, data, 0, data.length, 0);
      const after = fs.fstatSync(fd);
      if (
        count !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        checkedPath(workspace, relative, "read") !== target ||
        fs.lstatSync(target).ino !== stat.ino ||
        fs.lstatSync(target).isSymbolicLink()
      ) {
        throw new Error("SPACE input changed while reading");
      }
      return { path: relative, data: data.subarray(0, count) };
    } finally {
      fs.closeSync(fd);
    }
  });
}

/** Pin the root and every output ancestor across remote execution. */
export type SpaceOutputBindings = Map<string, string>;
function directoryBinding(workspace: Workspace, relative: string): string {
  const root = fs.realpathSync(workspace.path);
  const parents = [root];
  for (const component of relative.split("/").slice(0, -1)) {
    parents.push(path.join(parents[parents.length - 1], component));
  }
  return JSON.stringify(
    parents.map((parent) => {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("SPACE destination changed");
      return [parent, stat.dev, stat.ino];
    }),
  );
}

export function validateSpaceOutputs(workspace: Workspace, paths: string[]): SpaceOutputBindings {
  const bindings: SpaceOutputBindings = new Map();
  if (paths.length > 64 || new Set(paths).size !== paths.length)
    throw new Error("Invalid SPACE output selection");
  for (const relative of paths) {
    const target = checkedPath(workspace, relative, "write");
    bindings.set(relative, directoryBinding(workspace, relative));
    try {
      fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      "SPACE output destinations must be new files; existing files are never replaced",
    );
  }
  return bindings;
}

/** Decode an untrusted guest manifest completely before any local publication. */
export function decodeSpaceOutputs(text: string, paths: string[]): SpaceInput[] {
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values) || values.length !== paths.length)
    throw new Error("Invalid SPACE artifact manifest");
  let total = 0;
  return values.map((value, i) => {
    if (!value || value.path !== paths[i]) throw new Error("Unexpected SPACE artifact path");
    const data = decodeSpaceBase64(value.data);
    if (
      data.length > FILE_LIMIT ||
      (total += data.length) > SPACE_TRANSFER_LIMIT ||
      value.sha256 !== createHash("sha256").update(data).digest("hex")
    ) {
      throw new Error("SPACE artifact digest or size check failed");
    }
    return { path: paths[i], data };
  });
}

/** Journal the bytes' hashes before entering this function. Publication is exclusive,
 * permission-revalidated, and never overwrites/deletes user files. A partial publish
 * is retained and reported, never rolled back by deleting possibly user-edited data. */
export function publishSpaceOutputs(
  workspace: Workspace,
  files: SpaceInput[],
  checkpoint: (relative: string) => void,
  bindings?: SpaceOutputBindings,
): void {
  const assertBinding = (relative: string) => {
    if (bindings && bindings.get(relative) !== directoryBinding(workspace, relative))
      throw new Error("SPACE destination changed during execution");
  };
  // Validate all destinations before the first publication.
  for (const file of files) assertBinding(file.path);
  for (const file of files) {
    assertBinding(file.path);
    const target = checkedPath(workspace, file.path, "write");
    const parent = fs.statSync(path.dirname(target));
    const fd = fs.openSync(
      target,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const current = fs.statSync(path.dirname(checkedPath(workspace, file.path, "write")));
      if (current.ino !== parent.ino || current.dev !== parent.dev)
        throw new Error("SPACE destination changed");
      assertBinding(file.path);
      fs.writeFileSync(fd, file.data);
      fs.fsyncSync(fd);
      const readback = Buffer.alloc(file.data.length);
      const count = fs.readSync(fd, readback, 0, readback.length, 0);
      if (count !== file.data.length || !readback.equals(file.data))
        throw new Error("SPACE artifact readback failed");
      const stat = fs.lstatSync(target);
      if (stat.ino !== fs.fstatSync(fd).ino || stat.isSymbolicLink())
        throw new Error("SPACE artifact changed during publication");
      checkpoint(file.path);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** Stage script files in the guest without forwarding their host /tmp location. */
export function spaceScriptPath(): string {
  return `.space-script-${randomUUID()}`;
}
