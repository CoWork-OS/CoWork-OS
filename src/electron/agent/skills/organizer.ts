import * as fs from 'fs/promises';
import * as path from 'path';
import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { checkProjectAccess, getProjectIdFromWorkspaceRelPath, getWorkspaceRelativePosixPath } from '../../security/project-access';

/**
 * FolderOrganizer organizes files in folders
 */
export class FolderOrganizer {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {}

  /**
   * Ensure path is within workspace (security check)
   * Uses path.relative() to safely detect path traversal attacks including symlinks
   */
  private validatePath(relativePath: string): string {
    const normalizedWorkspace = path.resolve(this.workspace.path);
    const resolved = path.resolve(normalizedWorkspace, relativePath);
    const relative = path.relative(normalizedWorkspace, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Path is outside workspace boundary');
    }

    return resolved;
  }

  private async enforceProjectAccess(absolutePath: string): Promise<void> {
    const relPosix = getWorkspaceRelativePosixPath(this.workspace.path, absolutePath);
    if (relPosix === null) return;
    const projectId = getProjectIdFromWorkspaceRelPath(relPosix);
    if (!projectId) return;

    const taskGetter = (this.daemon as any)?.getTask;
    const task = typeof taskGetter === 'function' ? taskGetter.call(this.daemon, this.taskId) : null;
    const agentRoleId = task?.assignedAgentRoleId || null;
    const res = await checkProjectAccess({ workspacePath: this.workspace.path, projectId, agentRoleId });
    if (!res.allowed) {
      throw new Error(res.reason || `Access denied for project "${projectId}"`);
    }
  }

  async organize(
    relativePath: string,
    strategy: 'by_type' | 'by_date' | 'custom',
    rules?: any
  ): Promise<number> {
    const fullPath = this.validatePath(relativePath);
    await this.enforceProjectAccess(fullPath);

    switch (strategy) {
      case 'by_type':
        return await this.organizeByType(fullPath);
      case 'by_date':
        return await this.organizeByDate(fullPath);
      case 'custom':
        return await this.organizeCustom(fullPath, rules);
      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }
  }

  private async organizeByType(folderPath: string): Promise<number> {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    let changes = 0;

    const typeMap: Record<string, string> = {
      '.jpg': 'Images',
      '.jpeg': 'Images',
      '.png': 'Images',
      '.gif': 'Images',
      '.pdf': 'Documents',
      '.doc': 'Documents',
      '.docx': 'Documents',
      '.pptx': 'Documents',
      '.txt': 'Documents',
      '.xlsx': 'Spreadsheets',
      '.csv': 'Spreadsheets',
      '.mp4': 'Videos',
      '.mov': 'Videos',
      '.mp3': 'Audio',
      '.wav': 'Audio',
    };

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      const category = typeMap[ext] || 'Other';

      const sourcePath = path.join(folderPath, entry.name);
      const targetDir = path.join(folderPath, category);
      const targetPath = path.join(targetDir, entry.name);

      // Create category folder if needed
      await fs.mkdir(targetDir, { recursive: true });

      // Move file
      await fs.rename(sourcePath, targetPath);
      changes++;

      this.daemon.logEvent(this.taskId, 'file_modified', {
        action: 'organize',
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
      const month = String(date.getMonth() + 1).padStart(2, '0');

      const targetDir = path.join(folderPath, `${year}-${month}`);
      const targetPath = path.join(targetDir, entry.name);

      // Create date folder if needed
      await fs.mkdir(targetDir, { recursive: true });

      // Move file
      await fs.rename(sourcePath, targetPath);
      changes++;
    }

    return changes;
  }

  private async organizeCustom(folderPath: string, rules: any): Promise<number> {
    // TODO: Implement custom organization rules
    // For MVP, just return 0
    return 0;
  }
}
