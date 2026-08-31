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

  async organize(
    relativePath: string,
    strategy: "by_type" | "by_date" | "custom",
    rules?: Any,
  ): Promise<number> {
    const fullPath = this.validatePath(relativePath);
    // Organizing enumerates and stats source entries before it mutates them;
    // write permission alone must not imply read access.
    this.assertProfilePathAllowed(fullPath, "read");
    await this.enforceProjectAccess(fullPath);

    switch (strategy) {
      case "by_type":
        return await this.organizeByType(fullPath);
      case "by_date":
        return await this.organizeByDate(fullPath);
      case "custom":
        return await this.organizeCustom(fullPath, rules);
      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }
  }

  private async organizeByType(folderPath: string): Promise<number> {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    let changes = 0;

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

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      const category = typeMap[ext] || "Other";

      const sourcePath = path.join(folderPath, entry.name);
      const targetDir = path.join(folderPath, category);
      const targetPath = path.join(targetDir, entry.name);

      this.assertProfilePathAllowed(sourcePath, "delete");
      this.assertProfilePathAllowed(targetDir, "write");
      this.assertProfilePathAllowed(targetPath, "write");

      // Create category folder if needed
      await fs.mkdir(targetDir, { recursive: true });

      // Move file
      await fs.rename(sourcePath, targetPath);
      changes++;

      this.daemon.logEvent(this.taskId, "file_modified", {
        action: "organize",
        from: entry.name,
        to: path.join(category, entry.name),
      });
    }

    return changes;
  }

  private async organizeByDate(folderPath: string): Promise<number> {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    let changes = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const sourcePath = path.join(folderPath, entry.name);
      const stats = await fs.stat(sourcePath);
      const date = new Date(stats.mtime);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");

      const targetDir = path.join(folderPath, `${year}-${month}`);
      const targetPath = path.join(targetDir, entry.name);

      this.assertProfilePathAllowed(sourcePath, "delete");
      this.assertProfilePathAllowed(targetDir, "write");
      this.assertProfilePathAllowed(targetPath, "write");

      // Create date folder if needed
      await fs.mkdir(targetDir, { recursive: true });

      // Move file
      await fs.rename(sourcePath, targetPath);
      changes++;
    }

    return changes;
  }

  private async organizeCustom(_folderPath: string, _rules: Any): Promise<number> {
    // TODO: Implement custom organization rules
    // For MVP, just return 0
    return 0;
  }
}
