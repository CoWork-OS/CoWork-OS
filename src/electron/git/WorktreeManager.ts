import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import { GitService } from "./GitService";
import { WorktreeInfoRepository } from "../database/repositories";
import {
  WorktreeSettings,
  DEFAULT_WORKTREE_SETTINGS,
  WorktreeInfo,
  MergeResult,
} from "../../shared/types";

const WORKTREES_DIR = ".cowork-worktrees";
const SETTINGS_KEY = "worktree_settings";

/**
 * High-level worktree lifecycle manager.
 * Handles creating, committing, merging, and cleaning up git worktrees per task.
 */
export class WorktreeManager {
  private static instance: WorktreeManager | null = null;
  private worktreeInfoRepo: WorktreeInfoRepository;
  /** Tracks workspaces where .gitignore has already been updated this session. */
  private gitignoreUpdated = new Set<string>();

  constructor(private db: Database.Database) {
    this.worktreeInfoRepo = new WorktreeInfoRepository(db);
    WorktreeManager.instance = this;
  }

  static getInstance(): WorktreeManager | null {
    return WorktreeManager.instance;
  }

  /**
   * Load worktree settings from database.
   */
  getSettings(): WorktreeSettings {
    try {
      const stmt = this.db.prepare("SELECT value FROM settings WHERE key = ?");
      const row = stmt.get(SETTINGS_KEY) as { value: string } | undefined;
      if (row) {
        return { ...DEFAULT_WORKTREE_SETTINGS, ...JSON.parse(row.value) };
      }
    } catch {
      // Settings table might not have this key yet
    }
    return { ...DEFAULT_WORKTREE_SETTINGS };
  }

  /**
   * Save worktree settings to database.
   */
  saveSettings(settings: WorktreeSettings): void {
    const stmt = this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    stmt.run(SETTINGS_KEY, JSON.stringify(settings));
  }

  /**
   * Check if worktrees should be used for a given workspace.
   * Returns false if: settings disabled, not a git repo, or workspace is temp.
   */
  async shouldUseWorktree(workspacePath: string, isTemp?: boolean): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.enabled) return false;
    if (isTemp) return false;

    try {
      return await GitService.isGitRepo(workspacePath);
    } catch {
      return false;
    }
  }

  /**
   * Create a worktree for a task.
   * The worktree is placed at: <repo-root>/.cowork-worktrees/<taskId-short>/
   */
  async createForTask(
    taskId: string,
    taskTitle: string,
    workspaceId: string,
    workspacePath: string,
  ): Promise<WorktreeInfo> {
    const settings = this.getSettings();
    const repoPath = await GitService.getRepoRoot(workspacePath);
    const baseBranch = await GitService.getCurrentBranch(repoPath);
    const baseCommit = await GitService.getHeadCommit(repoPath);
    const branchName = GitService.generateBranchName(taskTitle, settings.branchPrefix, taskId);

    // Place worktrees in a subdirectory that's gitignored
    const shortId = taskId.slice(0, 8);
    const worktreeDir = path.join(repoPath, WORKTREES_DIR);
    const worktreePath = path.join(worktreeDir, shortId);

    // Ensure the worktrees directory exists
    if (!fs.existsSync(worktreeDir)) {
      fs.mkdirSync(worktreeDir, { recursive: true });
    }

    // Clean up stale worktree directory if it exists (e.g., from a previous failed cleanup)
    if (fs.existsSync(worktreePath)) {
      try {
        await GitService.removeWorktree(repoPath, worktreePath);
      } catch {
        // removeWorktree may fail if git doesn't know about it; just remove the directory
      }
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }

    // Ensure .cowork-worktrees is in .gitignore
    await this.ensureGitignore(repoPath);

    // Create the worktree
    await GitService.createWorktree(repoPath, worktreePath, branchName);

    const info: WorktreeInfo = {
      taskId,
      workspaceId,
      repoPath,
      worktreePath,
      branchName,
      baseBranch,
      baseCommit,
      status: "active",
      createdAt: Date.now(),
    };

    this.worktreeInfoRepo.create(info);
    return info;
  }

  /**
   * Auto-commit all changes in a task's worktree.
   * Returns null if no changes to commit.
   */
  async commitTaskChanges(
    taskId: string,
    message?: string,
  ): Promise<{ sha: string; filesChanged: number } | null> {
    const info = this.worktreeInfoRepo.findByTaskId(taskId);
    if (!info) throw new Error(`No worktree found for task ${taskId}`);

    const settings = this.getSettings();
    const commitMessage = message || `${settings.commitMessagePrefix}Task ${taskId.slice(0, 8)}`;

    const result = await GitService.commitAll(info.worktreePath, commitMessage);
    if (result) {
      this.worktreeInfoRepo.update(taskId, {
        lastCommitSha: result.sha,
        lastCommitMessage: commitMessage,
      });
    }
    return result;
  }

  /**
   * Merge a task's branch back to its base branch.
   */
  async mergeToBase(taskId: string): Promise<MergeResult> {
    const info = this.worktreeInfoRepo.findByTaskId(taskId);
    if (!info) {
      return { success: false, error: `No worktree found for task ${taskId}` };
    }

    // Commit any uncommitted changes first
    const hasChanges = await GitService.hasUncommittedChanges(info.worktreePath);
    if (hasChanges) {
      const settings = this.getSettings();
      await GitService.commitAll(
        info.worktreePath,
        `${settings.commitMessagePrefix}Final changes before merge`,
      );
    }

    // Resolve repo path from persisted metadata or git.
    const repoPath = await this.resolveRepoPath(info);

    this.worktreeInfoRepo.update(taskId, { status: "merging" });

    const result = await GitService.mergeToBase(
      repoPath,
      info.branchName,
      info.baseBranch,
      `Merge ${info.branchName} into ${info.baseBranch}`,
    );

    this.worktreeInfoRepo.update(taskId, {
      status: result.success ? "merged" : "conflict",
      mergeResult: result,
    });

    // Auto-clean if enabled and merge was successful
    if (result.success) {
      const settings = this.getSettings();
      if (settings.autoCleanOnMerge) {
        await this.cleanup(taskId, true);
      }
    }

    return result;
  }

  /**
   * Clean up a worktree (remove directory and optionally delete branch).
   */
  async cleanup(taskId: string, deleteBranch?: boolean): Promise<void> {
    const info = this.worktreeInfoRepo.findByTaskId(taskId);
    if (!info) return;

    const repoPath = await this.resolveRepoPath(info);

    // Remove the worktree
    try {
      await GitService.removeWorktree(repoPath, info.worktreePath);
    } catch (error) {
      console.error(`[WorktreeManager] Failed to remove worktree for ${taskId}:`, error);
    }

    // Remove the directory if it still exists
    try {
      if (fs.existsSync(info.worktreePath)) {
        fs.rmSync(info.worktreePath, { recursive: true, force: true });
      }
    } catch (error) {
      console.error(`[WorktreeManager] Failed to remove worktree dir for ${taskId}:`, error);
    }

    // Optionally delete the branch
    if (deleteBranch) {
      try {
        await GitService.deleteBranch(repoPath, info.branchName);
      } catch (error) {
        console.error(`[WorktreeManager] Failed to delete branch ${info.branchName}:`, error);
      }
    }

    this.worktreeInfoRepo.update(taskId, { status: "cleaned" });
  }

  /**
   * Get worktree info for a task.
   */
  getWorktreeInfo(taskId: string): WorktreeInfo | undefined {
    return this.worktreeInfoRepo.findByTaskId(taskId);
  }

  /**
   * List all worktrees for a workspace.
   */
  listForWorkspace(workspaceId: string): WorktreeInfo[] {
    return this.worktreeInfoRepo.findByWorkspaceId(workspaceId);
  }

  /**
   * Get diff stats between worktree branch and base.
   */
  async getDiffStats(taskId: string) {
    const info = this.worktreeInfoRepo.findByTaskId(taskId);
    if (!info) return null;

    try {
      return await GitService.getDiffStats(info.worktreePath, info.baseBranch);
    } catch {
      return null;
    }
  }

  /**
   * Get full diff output for a task's worktree.
   */
  async getFullDiff(taskId: string): Promise<string | null> {
    const info = this.worktreeInfoRepo.findByTaskId(taskId);
    if (!info) return null;

    try {
      return await GitService.getFullDiff(info.worktreePath, info.baseBranch);
    } catch {
      return null;
    }
  }

  /**
   * Ensure .cowork-worktrees is in the .gitignore file.
   * Uses a session-level cache to avoid redundant file I/O, and writes the
   * full file content atomically to prevent partial writes from concurrent calls.
   */
  private async ensureGitignore(repoPath: string): Promise<void> {
    if (this.gitignoreUpdated.has(repoPath)) return;

    const gitignorePath = path.join(repoPath, ".gitignore");
    const entry = WORKTREES_DIR + "/";

    try {
      let content = "";
      if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, "utf-8");
      }

      if (!content.includes(entry)) {
        const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
        const updated = content + `${newline}# CoWork OS worktrees\n${entry}\n`;
        fs.writeFileSync(gitignorePath, updated, "utf-8");
      }

      this.gitignoreUpdated.add(repoPath);
    } catch (error) {
      console.error("[WorktreeManager] Failed to update .gitignore:", error);
    }
  }

  /**
   * Resolve the repository root for a worktree.
   * Prefers persisted repo metadata, then falls back to git discovery.
   */
  private async resolveRepoPath(info: WorktreeInfo): Promise<string> {
    if (info.repoPath?.trim()) {
      return info.repoPath;
    }

    try {
      const repoPath = await GitService.getRepoRoot(info.worktreePath);
      this.worktreeInfoRepo.update(info.taskId, { repoPath });
      return repoPath;
    } catch {
      // Backward-compatible fallback for older records.
      return path.resolve(info.worktreePath, "..", "..");
    }
  }
}
