import { ipcMain } from "electron";
import { IPC_CHANNELS, type MergeReview, type WorktreeWorkspaceInfo } from "../../shared/types";
import { GitService } from "../git/GitService";
import { buildMergeReview } from "../git/merge-review";
import { TaskEventReplayRepository } from "../database/repository-facades";
import { assertWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import type { AgentDaemon } from "../agent/daemon";
import {
  validateInput,
  UUIDSchema,
  WorkspaceIdSchema,
  WorktreeSettingsSchema,
} from "../utils/validation";
import { rateLimiter, RATE_LIMIT_CONFIGS } from "../utils/rate-limiter";
import { createLogger } from "../utils/logger";

createLogger("Worktree");

function checkRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetMs = rateLimiter.getResetTime(channel);
    const resetSec = Math.ceil(resetMs / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

/**
 * Register IPC handlers for Git Worktree features.
 */
export function setupWorktreeHandlers(agentDaemon: AgentDaemon): void {
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_GET_INFO, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_WORKSPACE_INFO, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_LIST, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_MERGE, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_CLEANUP, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_GET_DIFF, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_RESOLVE_BASE_COMMIT, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_MERGE_REVIEW, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_GET_SETTINGS, RATE_LIMIT_CONFIGS.frequent);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);

  const worktreeManager = agentDaemon.getWorktreeManager();

  // ============ Worktree Handlers ============

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_WORKSPACE_INFO,
    async (_, workspaceId: unknown): Promise<WorktreeWorkspaceInfo> => {
      checkRateLimit(IPC_CHANNELS.WORKTREE_WORKSPACE_INFO);
      const id = validateInput(WorkspaceIdSchema, workspaceId, "workspace ID");
      const workspace = agentDaemon.getWorkspaceById(id);
      if (!workspace) throw new Error("Workspace not found");
      const unavailable = (reason: string): WorktreeWorkspaceInfo => ({
        workspaceId: id,
        available: false,
        reason,
        branches: [],
      });
      if (workspace.isTemp) return unavailable("Choose a Git project folder to use a worktree.");
      if (!workspace.permissions.write) return unavailable("This workspace is read-only.");
      assertWorkspaceFilesystemAccess(workspace, workspace.path, "read", "worktree repository");
      if (!(await GitService.isGitRepo(workspace.path)))
        return unavailable("Worktrees require a Git repository.");
      try {
        await GitService.getHeadCommit(workspace.path);
      } catch {
        return unavailable("Create the repository's first commit before using a worktree.");
      }
      const [currentBranch, branches] = await Promise.all([
        GitService.getCurrentBranch(workspace.path),
        GitService.getLocalBranches(workspace.path),
      ]);
      return { workspaceId: id, available: true, currentBranch, branches };
    },
  );

  ipcMain.handle(IPC_CHANNELS.WORKTREE_GET_INFO, async (_, taskId: unknown) => {
    checkRateLimit(IPC_CHANNELS.WORKTREE_GET_INFO);
    const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
    return (await worktreeManager.getWorktreeInfo(validatedTaskId)) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.WORKTREE_LIST, async (_, workspaceId: unknown) => {
    checkRateLimit(IPC_CHANNELS.WORKTREE_LIST);
    const validatedWorkspaceId = validateInput(WorkspaceIdSchema, workspaceId, "workspace ID");
    return worktreeManager.listForWorkspace(validatedWorkspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.WORKTREE_MERGE, async (_, taskId: unknown) => {
    checkRateLimit(IPC_CHANNELS.WORKTREE_MERGE);
    const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
    try {
      const info = await worktreeManager.getWorktreeInfo(validatedTaskId);
      if (info) {
        const baseRepoPath = info.repoPath || agentDaemon.getWorkspaceById(info.workspaceId)?.path;
        if (!baseRepoPath) {
          throw new Error("Cannot verify the base repository path for this worktree.");
        }
        agentDaemon.assertTaskWorkspaceFilesystemAccess(
          validatedTaskId,
          info.worktreePath,
          "write",
          "worktree merge",
        );
        agentDaemon.assertTaskBaseWorkspaceFilesystemAccess(
          validatedTaskId,
          baseRepoPath,
          "write",
          "git base repository",
        );
      }
      return await worktreeManager.mergeToBase(validatedTaskId);
    } catch (error: Any) {
      console.error(`[Worktree] Merge failed for task ${validatedTaskId}:`, error);
      return { success: false, error: error.message || "Merge failed" };
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKTREE_CLEANUP, async (_, taskId: unknown) => {
    checkRateLimit(IPC_CHANNELS.WORKTREE_CLEANUP);
    const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
    try {
      const info = await worktreeManager.getWorktreeInfo(validatedTaskId);
      if (info) {
        const baseRepoPath = info.repoPath || agentDaemon.getWorkspaceById(info.workspaceId)?.path;
        if (!baseRepoPath) {
          throw new Error("Cannot verify the base repository path for this worktree.");
        }
        agentDaemon.assertTaskWorkspaceFilesystemAccess(
          validatedTaskId,
          info.worktreePath,
          "write",
          "worktree cleanup",
        );
        agentDaemon.assertTaskBaseWorkspaceFilesystemAccess(
          validatedTaskId,
          baseRepoPath,
          "write",
          "git base repository cleanup",
        );
      }
      await worktreeManager.cleanup(validatedTaskId, true);
      return { success: true };
    } catch (error: Any) {
      console.error(`[Worktree] Cleanup failed for task ${validatedTaskId}:`, error);
      return { success: false, error: error.message || "Cleanup failed" };
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKTREE_GET_DIFF, async (_, taskId: unknown) => {
    checkRateLimit(IPC_CHANNELS.WORKTREE_GET_DIFF);
    const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
    return await worktreeManager.getDiffStats(validatedTaskId);
  });

  // Build Compare: resolve the starting branch to one commit, so every variant starts from it.
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_RESOLVE_BASE_COMMIT,
    async (_, data: unknown): Promise<{ commit: string }> => {
      checkRateLimit(IPC_CHANNELS.WORKTREE_RESOLVE_BASE_COMMIT);
      const input = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const id = validateInput(WorkspaceIdSchema, input.workspaceId, "workspace ID");
      const branch =
        typeof input.branch === "string" && input.branch.trim() && input.branch.length <= 250
          ? input.branch.trim()
          : undefined;
      const workspace = agentDaemon.getWorkspaceById(id);
      if (!workspace) throw new Error("Workspace not found");
      assertWorkspaceFilesystemAccess(workspace, workspace.path, "read", "worktree repository");
      const repoPath = await GitService.getRepoRoot(workspace.path);
      if (branch && !(await GitService.getLocalBranches(repoPath)).includes(branch)) {
        throw new Error(`Starting branch "${branch}" is unavailable.`);
      }
      return { commit: await GitService.resolveCommit(repoPath, { branch }) };
    },
  );

  // Worktree changes waiting to merge, grouped by intent, with combined-state checks.
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_MERGE_REVIEW,
    async (_, workspaceId: unknown): Promise<MergeReview> => {
      checkRateLimit(IPC_CHANNELS.WORKTREE_MERGE_REVIEW);
      const id = validateInput(WorkspaceIdSchema, workspaceId, "workspace ID");
      const workspace = agentDaemon.getWorkspaceById(id);
      if (!workspace) throw new Error("Workspace not found");
      assertWorkspaceFilesystemAccess(workspace, workspace.path, "read", "worktree repository");
      const events = new TaskEventReplayRepository(agentDaemon.getDatabase());
      return buildMergeReview(id, {
        listWorktrees: (workspace) => worktreeManager.listForWorkspace(workspace),
        getTask: (taskId) => agentDaemon.getTaskById(taskId),
        diffStats: (info) => GitService.getDiffStats(info.worktreePath, info.baseBranch),
        changedFiles: (info) => GitService.getChangedFiles(info.worktreePath, info.baseBranch),
        latestCheck: async (taskId) => {
          const [latest] = await events.findByTaskIdAndTypes(
            taskId,
            ["verification_passed", "verification_failed"],
            1,
          );
          if (!latest) return undefined;
          const type = latest.legacyType || latest.type;
          const message =
            typeof latest.payload?.message === "string"
              ? latest.payload.message.slice(0, 300)
              : undefined;
          return { passed: type === "verification_passed", ...(message ? { message } : {}) };
        },
        mergeConflicts: (repoPath, a, b) => GitService.mergeConflicts(repoPath, a, b),
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.WORKTREE_GET_SETTINGS, async () => {
    checkRateLimit(IPC_CHANNELS.WORKTREE_GET_SETTINGS);
    return worktreeManager.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.WORKTREE_SAVE_SETTINGS, async (_, settings: unknown) => {
    checkRateLimit(IPC_CHANNELS.WORKTREE_SAVE_SETTINGS);
    const validatedSettings = validateInput(WorktreeSettingsSchema, settings, "worktree settings");
    worktreeManager.saveSettings(validatedSettings);
    return { success: true };
  });
}
