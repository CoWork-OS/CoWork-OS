import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "../../shared/types";

interface WorkspacePathHealOptions {
  homeDir?: string;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface WorkspacePathRepair {
  workspaceId: string;
  oldPath: string;
  newPath: string;
}

function isDirectory(value: string): boolean {
  try {
    return fsSync.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function isWorkspaceArtifactSkeleton(workspacePath: string): boolean {
  if (!isDirectory(workspacePath)) return false;
  try {
    const entries = fsSync
      .readdirSync(workspacePath, { withFileTypes: true })
      .filter((entry) => entry.name !== ".DS_Store");
    return entries.length === 1 && entries[0]?.name === ".cowork" && entries[0].isDirectory();
  } catch {
    return false;
  }
}

export function findMovedDesktopWorkspacePath(
  workspacePath: string,
  homeDir: string = os.homedir(),
): string | null {
  const desktopRoot = path.resolve(homeDir, "Desktop");
  const relocatedRoot = path.join(desktopRoot, "new");
  const normalized = path.resolve(workspacePath);

  if (normalized === relocatedRoot || normalized.startsWith(`${relocatedRoot}${path.sep}`)) {
    return null;
  }
  if (!(normalized === desktopRoot || normalized.startsWith(`${desktopRoot}${path.sep}`))) {
    return null;
  }

  const relative = path.relative(desktopRoot, normalized);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  const candidate = path.join(relocatedRoot, relative);
  if (!isDirectory(candidate)) {
    return null;
  }

  if (!isDirectory(normalized) || isWorkspaceArtifactSkeleton(normalized)) {
    return candidate;
  }

  return null;
}

export function healMovedDesktopWorkspacePaths(
  workspaces: Workspace[],
  updatePath: (workspaceId: string, nextPath: string) => void,
  options: WorkspacePathHealOptions = {},
): WorkspacePathRepair[] {
  const homeDir = options.homeDir || os.homedir();
  const occupiedPaths = new Map<string, string>();
  for (const workspace of workspaces) {
    occupiedPaths.set(path.resolve(workspace.path), workspace.id);
  }

  const repairs: WorkspacePathRepair[] = [];
  for (const workspace of workspaces) {
    const candidate = findMovedDesktopWorkspacePath(workspace.path, homeDir);
    if (!candidate) continue;

    const normalizedCurrent = path.resolve(workspace.path);
    const normalizedCandidate = path.resolve(candidate);
    const owner = occupiedPaths.get(normalizedCandidate);
    if (owner && owner !== workspace.id) {
      options.log?.(
        "Skipped workspace path heal because destination already exists in the workspace registry.",
        {
          workspaceId: workspace.id,
          currentPath: workspace.path,
          candidatePath: candidate,
          destinationWorkspaceId: owner,
        },
      );
      continue;
    }

    updatePath(workspace.id, candidate);
    occupiedPaths.delete(normalizedCurrent);
    occupiedPaths.set(normalizedCandidate, workspace.id);
    repairs.push({
      workspaceId: workspace.id,
      oldPath: workspace.path,
      newPath: candidate,
    });
  }

  return repairs;
}
