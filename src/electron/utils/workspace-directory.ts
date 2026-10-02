import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

function directorySegments(workspacePath: string, directoryPath: string): string[] {
  let root = path.resolve(workspacePath);
  let relative = path.relative(root, path.resolve(directoryPath));
  // Permission checks may return canonical paths (/private/tmp on macOS),
  // while the workspace is registered through a symlink or system alias.
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    root = fs.realpathSync(root);
    relative = path.relative(root, path.resolve(directoryPath));
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Directory is outside the workspace: ${directoryPath}`);
  }
  const segments: string[] = [];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    segments.push(current);
  }
  return segments;
}

export function workspaceDirectoryExists(workspacePath: string): boolean {
  try {
    return fs.statSync(workspacePath).isDirectory();
  } catch {
    return false;
  }
}

function missingWorkspace(workspacePath: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(
      `Workspace folder is missing: ${workspacePath}. Reconnect an existing folder before continuing.`,
    ),
    {
      code: "ENOENT",
      path: workspacePath,
    },
  );
}

/** Create descendants only. Never recreate a workspace deleted outside CoWork.
 * Non-recursive mkdir also prevents resurrection if deletion races with this operation.
 */
export async function ensureWorkspaceDirectory(
  workspacePath: string,
  directoryPath: string,
): Promise<void> {
  const segments = directorySegments(workspacePath, directoryPath);
  if (!(await fsp.stat(workspacePath).catch(() => null))?.isDirectory()) {
    throw missingWorkspace(workspacePath);
  }
  for (const directory of segments) {
    try {
      await fsp.mkdir(directory);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(await fsp.stat(directory)).isDirectory()
      )
        throw error;
    }
  }
}

export function ensureWorkspaceDirectorySync(workspacePath: string, directoryPath: string): void {
  const segments = directorySegments(workspacePath, directoryPath);
  if (!workspaceDirectoryExists(workspacePath)) throw missingWorkspace(workspacePath);
  for (const directory of segments) {
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !fs.statSync(directory).isDirectory()
      )
        throw error;
    }
  }
}
