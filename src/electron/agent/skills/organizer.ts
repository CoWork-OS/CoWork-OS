import * as fs from "fs/promises";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import {
  checkProjectAccess,
  getProjectIdFromWorkspaceRelPath,
  getWorkspaceRelativePosixPath,
} from "../../security/project-access";
import { evaluateWorkspaceFilesystemAccess } from "../../security/access-profile-paths";

/**
 * FolderOrganizer organizes files in folders
 */
export class FolderOrganizer {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  /**
   * Ensure path is within workspace (security check)
   * Uses path.relative() to safely detect path traversal attacks including symlinks
   */
  private validatePath(relativePath: string): string {
    const resolved = evaluateWorkspaceFilesystemAccess(this.workspace, relativePath, "write");
    if (resolved.decision !== "allow") {
      if (resolved.reason === "profile_filesystem_denied") {
        throw new Error(`Path is denied by the active access profile: ${relativePath}`);
      }
      throw new Error("Path is outside workspace boundary");
    }
    return resolved.path;
  }

  private assertProfilePathAllowed(
    absolutePath: string,
    operation: "read" | "write" | "delete",
  ): void {
    const decision = evaluateWorkspaceFilesystemAccess(this.workspace, absolutePath, operation);
    if (decision.decision !== "allow") {
      if (decision.reason !== "profile_filesystem_denied") {
        throw new Error(`Path is outside workspace boundary: ${absolutePath}`);
      }
      throw new Error(`Path is denied by the active access profile: ${absolutePath}`);
    }
  }

  private async enforceProjectAccess(absolutePath: string): Promise<void> {
    const relPosix = getWorkspaceRelativePosixPath(this.workspace.path, absolutePath);
    if (relPosix === null) return;
    const projectId = getProjectIdFromWorkspaceRelPath(relPosix);
    if (!projectId) return;

    const taskGetter = (this.daemon as Any)?.getTask;
    const task =
      typeof taskGetter === "function" ? taskGetter.call(this.daemon, this.taskId) : null;
    const agentRoleId = task?.assignedAgentRoleId || null;
    const res = await checkProjectAccess({
      workspacePath: this.workspace.path,
      projectId,
      agentRoleId,
    });
    if (!res.allowed) {
      throw new Error(res.reason || `Access denied for project "${projectId}"`);
    }
  }

  async organize(relativePath: string, strategy: "by_type" | "by_date"): Promise<number> {
    // A caller holding a stale tool schema may still ask for "custom"; it was
    // never implemented, so reject it before any path or access check runs.
    if (strategy !== "by_type" && strategy !== "by_date") {
      throw new Error(
        `Unsupported strategy: ${String(strategy)}. organize_folder supports "by_type" and "by_date".`,
      );
    }

    const fullPath = this.validatePath(relativePath);
    // Organizing enumerates and stats source entries before it mutates them;
    // write permission alone must not imply read access.
    this.assertProfilePathAllowed(fullPath, "read");
    await this.enforceProjectAccess(fullPath);

    return strategy === "by_type"
      ? await this.organizeByType(fullPath)
      : await this.organizeByDate(fullPath);
  }

  private async organizeByType(folderPath: string): Promise<number> {
    const typeMap: Record<string, string> = {
      ".jpg": "Images",
      ".jpeg": "Images",
      ".png": "Images",
      ".gif": "Images",
      ".pdf": "Documents",
      ".doc": "Documents",
      ".docx": "Documents",
      ".pptx": "Documents",
      ".txt": "Documents",
      ".xlsx": "Spreadsheets",
      ".csv": "Spreadsheets",
      ".mp4": "Videos",
      ".mov": "Videos",
      ".mp3": "Audio",
      ".wav": "Audio",
    };

    return this.moveIntoSubfolders(
      folderPath,
      async (fileName) => typeMap[path.extname(fileName).toLowerCase()] || "Other",
    );
  }

  private async organizeByDate(folderPath: string): Promise<number> {
    return this.moveIntoSubfolders(folderPath, async (_fileName, sourcePath) => {
      const date = new Date((await fs.stat(sourcePath)).mtime);
      const month = String(date.getMonth() + 1).padStart(2, "0");
      return `${date.getFullYear()}-${month}`;
    });
  }

  /**
   * Moves each top-level file into the subfolder `pickSubfolder` names. Every move
   * is planned and policy-checked before the first file moves, so a denied path
   * cannot leave the folder half-organized. Hidden files stay where they are, and
   * a file is never moved over an existing one or into a path that is not a folder.
   */
  private async moveIntoSubfolders(
    folderPath: string,
    pickSubfolder: (fileName: string, sourcePath: string) => Promise<string>,
  ): Promise<number> {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const moves: Array<{ fileName: string; subfolder: string; sourcePath: string }> = [];

    for (const entry of entries) {
      // Dotfiles (.gitignore, .env, ...) are configuration, not files to sort away.
      if (!entry.isFile() || entry.name.startsWith(".")) continue;

      const sourcePath = path.join(folderPath, entry.name);
      const subfolder = await pickSubfolder(entry.name, sourcePath);
      const targetDir = path.join(folderPath, subfolder);

      this.assertProfilePathAllowed(sourcePath, "delete");
      this.assertProfilePathAllowed(targetDir, "write");
      this.assertProfilePathAllowed(path.join(targetDir, entry.name), "write");
      moves.push({ fileName: entry.name, subfolder, sourcePath });
    }

    let changes = 0;
    for (const { fileName, subfolder, sourcePath } of moves) {
      const targetDir = path.join(folderPath, subfolder);
      const targetPath = path.join(targetDir, fileName);
      try {
        // A file named like the subfolder (an extensionless "Other") blocks it, and
        // a same-named file already inside must not be overwritten: leave both.
        const existingDir = await lstatOrNull(targetDir);
        if (existingDir && !existingDir.isDirectory()) continue;
        if (await lstatOrNull(targetPath)) continue;

        await fs.mkdir(targetDir, { recursive: true });
        await fs.rename(sourcePath, targetPath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Moved ${changes} file(s) before failing on ${fileName}: ${reason}`);
      }
      changes++;

      this.daemon.logEvent(this.taskId, "file_modified", {
        action: "organize",
        from: fileName,
        to: path.join(subfolder, fileName),
      });
    }

    return changes;
  }
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
