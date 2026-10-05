/**
 * Where the memory repo lives (docs/memory-repo-phase1-design.md §2): `~/CoWork Memory` for
 * the default profile, `<userData>/memory-repo` for any other profile or a custom data
 * directory. A configured path is validated in main; the renderer only sends it as a setting.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAccessPathWithin, isProtectedFilesystemPath } from "../../security/access-profile-paths";
import { getUserDataDir, hasNonDefaultProfile } from "../../utils/user-data-dir";

export const DEFAULT_MEMORY_REPO_DIR_NAME = "CoWork Memory";

export function defaultMemoryRepoPath(): string {
  const customDataDir =
    typeof process.env.COWORK_USER_DATA_DIR === "string" &&
    process.env.COWORK_USER_DATA_DIR.trim().length > 0;
  if (hasNonDefaultProfile() || customDataDir) return path.join(getUserDataDir(), "memory-repo");
  return path.join(os.homedir(), DEFAULT_MEMORY_REPO_DIR_NAME);
}

/** The configured path, or the default when none is set. */
export function resolveMemoryRepoPath(configured: string | null | undefined): string {
  const value = typeof configured === "string" ? configured.trim() : "";
  if (!value) return defaultMemoryRepoPath();
  const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
  return path.resolve(expanded);
}

/**
 * Why a path cannot hold the memory repo, or null when it can: it must be absolute, not a
 * filesystem root or a protected OS location, not the home directory itself, not a symlink,
 * and neither inside nor around a project workspace (memory must stay out of project folders).
 */
export function memoryRepoPathProblem(
  candidate: string,
  workspacePaths: readonly string[] = [],
): string | null {
  const raw = String(candidate || "").trim();
  if (!raw) return null;
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) return "Use an absolute path.";
  const resolved = path.resolve(expanded);
  if (resolved === path.parse(resolved).root) return "Choose a folder, not the disk root.";
  if (resolved === path.resolve(os.homedir())) return "Choose a folder inside your home folder.";
  if (isProtectedFilesystemPath(resolved)) return "That location is protected by the system.";
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return "The folder cannot be a symbolic link.";
  } catch {
    // Missing is fine: the repo is created on start.
  }
  const home = path.resolve(os.homedir());
  for (const workspacePath of workspacePaths) {
    if (!workspacePath) continue;
    // A workspace that is the home folder (or above it) is not a project folder; the
    // file-access layer still keeps the agent from writing the repo inside it.
    if (isAccessPathWithin(workspacePath, home)) continue;
    if (isAccessPathWithin(workspacePath, resolved) || isAccessPathWithin(resolved, workspacePath)) {
      return "Memory must live outside your workspaces.";
    }
  }
  return null;
}
