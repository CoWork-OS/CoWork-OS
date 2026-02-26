import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { AgentDaemon } from "../agent/daemon";
import {
  validateInput,
  UUIDSchema,
  WorkspaceIdSchema,
  WorktreeSettingsSchema,
  ComparisonCreateSchema,
} from "../utils/validation";
import { rateLimiter, RATE_LIMIT_CONFIGS } from "../utils/rate-limiter";

function checkRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetMs = rateLimiter.getResetTime(channel);
    const resetSec = Math.ceil(resetMs / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

/**
 * Register IPC handlers for Git Worktree and Agent Comparison features.
 */
export function setupWorktreeHandlers(agentDaemon: AgentDaemon): void {
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_GET_INFO, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_LIST, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_MERGE, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_CLEANUP, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_GET_DIFF, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_GET_SETTINGS, RATE_LIMIT_CONFIGS.frequent);
  rateLimiter.configure(IPC_CHANNELS.WORKTREE_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.COMPARISON_CREATE, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.COMPARISON_GET, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.COMPARISON_LIST, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.COMPARISON_CANCEL, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.COMPARISON_GET_RESULT, RATE_LIMIT_CONFIGS.standard);

  const worktreeManager = agentDaemon.getWorktreeManager();

  // ============ Worktree Handlers ============

  ipcMain.handle(IPC_CHANNELS.WORKTREE_GET_INFO, async (_, taskId: unknown) => {
    checkRateLimit(IPC_CHANNELS.WORKTREE_GET_INFO);
    const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
    return worktreeManager.getWorktreeInfo(validatedTaskId) ?? null;
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

  // ============ Comparison Handlers ============

  ipcMain.handle(IPC_CHANNELS.COMPARISON_CREATE, async (_, params: unknown) => {
    checkRateLimit(IPC_CHANNELS.COMPARISON_CREATE);
    const validatedParams = validateInput(ComparisonCreateSchema, params, "comparison request");
    const comparisonService = agentDaemon.getComparisonService();
    if (!comparisonService) {
      throw new Error("Comparison service not initialized");
    }
    return await comparisonService.createSession(validatedParams);
  });

  ipcMain.handle(IPC_CHANNELS.COMPARISON_GET, async (_, sessionId: unknown) => {
    checkRateLimit(IPC_CHANNELS.COMPARISON_GET);
    const validatedSessionId = validateInput(UUIDSchema, sessionId, "comparison session ID");
    const comparisonService = agentDaemon.getComparisonService();
    if (!comparisonService) return null;
    return comparisonService.getSession(validatedSessionId) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.COMPARISON_LIST, async (_, workspaceId: unknown) => {
    checkRateLimit(IPC_CHANNELS.COMPARISON_LIST);
    const validatedWorkspaceId = validateInput(WorkspaceIdSchema, workspaceId, "workspace ID");
    const comparisonService = agentDaemon.getComparisonService();
    if (!comparisonService) return [];
    return comparisonService.listSessions(validatedWorkspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.COMPARISON_CANCEL, async (_, sessionId: unknown) => {
    checkRateLimit(IPC_CHANNELS.COMPARISON_CANCEL);
    const validatedSessionId = validateInput(UUIDSchema, sessionId, "comparison session ID");
    const comparisonService = agentDaemon.getComparisonService();
    if (!comparisonService) {
      throw new Error("Comparison service not initialized");
    }
    await comparisonService.cancelSession(validatedSessionId);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.COMPARISON_GET_RESULT, async (_, sessionId: unknown) => {
    checkRateLimit(IPC_CHANNELS.COMPARISON_GET_RESULT);
    const validatedSessionId = validateInput(UUIDSchema, sessionId, "comparison session ID");
    const comparisonService = agentDaemon.getComparisonService();
    if (!comparisonService) return null;
    const session = comparisonService.getSession(validatedSessionId);
    return session?.comparisonResult ?? null;
  });

  console.log("[Worktree] IPC handlers initialized");
}
