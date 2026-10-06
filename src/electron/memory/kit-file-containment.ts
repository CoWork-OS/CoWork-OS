/**
 * Containment check for the workspace kit files that memory code rewrites
 * (`.cowork/USER.md`, `.cowork/MEMORY.md`, `.cowork/MISTAKES.md`, `.cowork/LORE.md`): they
 * are touched only when they stay inside the workspace.
 */
import fsp from "fs/promises";
import path from "path";

/**
 * Kit files that carry (or once carried) generated memory blocks: the one-time strip
 * rewrites them, so each is also checked for containment.
 */
export const KIT_FILE_NAMES: readonly string[] = ["USER.md", "MEMORY.md", "MISTAKES.md", "LORE.md"];

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Whether the workspace's `.cowork` directory and kit files stay inside the workspace:
 * the directory and the files must not be symlinks, and their real paths must resolve
 * under the workspace's real path. Missing files are fine.
 */
export async function kitFilesInsideWorkspace(workspacePath: string): Promise<boolean> {
  try {
    const realWorkspace = await fsp.realpath(workspacePath);
    const root = path.join(workspacePath, ".cowork");
    const rootStat = await fsp.lstat(root).catch(() => null);
    if (!rootStat) return true;
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    if (!isInside(realWorkspace, await fsp.realpath(root))) return false;
    for (const name of KIT_FILE_NAMES) {
      const filePath = path.join(root, name);
      const stat = await fsp.lstat(filePath).catch(() => null);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      if (!isInside(realWorkspace, await fsp.realpath(filePath))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
