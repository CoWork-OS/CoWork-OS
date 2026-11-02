/**
 * Desktop wiring for SpeculativeFixService: the agent daemon runs the worker task, the
 * worktree manager isolates and later commits, opens a pull request for, or removes its
 * checkout, and the channel gateway carries replies. Every filesystem step goes through the
 * daemon's access checks for the task, as the worktree IPC handlers do.
 */
import * as path from "path";
import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import type { AutomationRuntime } from "../automation/AutomationRuntime";
import { ChannelRepository } from "../database/repository-facades";
import type { ChannelGateway } from "../gateway";
import type { ChannelType } from "../gateway/channels/types";
import { isGatewayOwnerSender } from "../gateway/gateway-sender-identity";
import { GitService } from "../git/GitService";
import { createLogger } from "../utils/logger";
import { isOpenItReply } from "./speculative-fix";
import { FileSpeculativeRunStore } from "./speculative-run-store";
import { SpeculativeFixService, setActiveSpeculativeFixService } from "./SpeculativeFixService";

const logger = createLogger("SpeculativeFix");

/** Daemon events after which a worker task may have ended. */
const WATCHED_TASK_EVENTS = ["task_completed", "task_cancelled", "task_status"] as const;

export function createSpeculativeFixRuntime(input: {
  db: Database.Database;
  agentDaemon: AgentDaemon;
  channelGateway?: ChannelGateway;
  automationRuntime: AutomationRuntime;
  userDataDir: string;
}): SpeculativeFixService {
  const { agentDaemon, automationRuntime, channelGateway, db } = input;
  const worktreeManager = agentDaemon.getWorktreeManager();

  const activeWorktree = async (taskId: string) => {
    const info = await worktreeManager.getWorktreeInfo(taskId);
    return info && info.status !== "cleaned" ? info : undefined;
  };
  const assertBaseRepository = (taskId: string, repoPath: string | undefined, label: string) => {
    if (!repoPath) throw new Error("Cannot verify the base repository path for this worktree.");
    agentDaemon.assertTaskBaseWorkspaceFilesystemAccess(taskId, repoPath, "write", label);
  };

  const service = new SpeculativeFixService({
    createTask: async ({ title, prompt, workspaceId, agentConfig }) => {
      const task = await agentDaemon.createTask({
        title,
        prompt,
        workspaceId,
        source: "hook",
        agentConfig: {
          ...agentConfig,
          backgroundSchedulerFence: automationRuntime.captureFence(),
        },
      });
      return { id: task.id };
    },
    getTask: (taskId) => agentDaemon.getTask(taskId),
    cancelTask: (taskId) => agentDaemon.cancelTask(taskId),
    logTaskEvent: (taskId, payload) => agentDaemon.logEvent(taskId, "speculative_outcome", payload),
    canIsolate: async (workspaceId) => {
      const workspace = agentDaemon.getWorkspaceById(workspaceId);
      if (!workspace || workspace.isTemp || workspace.permissions?.write !== true) return false;
      return worktreeManager.shouldUseWorktree(workspace.path, workspace.isTemp, true);
    },
    worktree: {
      commit: async (taskId, message) => {
        const info = await activeWorktree(taskId);
        if (!info) throw new Error("The run has no worktree.");
        agentDaemon.assertTaskWorkspaceFilesystemAccess(
          taskId,
          info.worktreePath,
          "write",
          "speculative fix commit",
        );
        await worktreeManager.commitTaskChanges(taskId, message);
      },
      diffStats: async (taskId) => {
        const info = await activeWorktree(taskId);
        if (!info) return null;
        agentDaemon.assertTaskWorkspaceFilesystemAccess(
          taskId,
          info.worktreePath,
          "read",
          "speculative fix diff",
        );
        // Against the commit the worktree started from: the base branch may have moved since.
        const stats = await GitService.getDiffStats(
          info.worktreePath,
          info.baseCommit || info.baseBranch,
        );
        return {
          filesChanged: stats.filesChanged,
          linesAdded: stats.linesAdded,
          linesRemoved: stats.linesRemoved,
        };
      },
      branchName: async (taskId) => (await activeWorktree(taskId))?.branchName,
      openPullRequest: async (taskId, params) => {
        const info = await activeWorktree(taskId);
        if (!info) return { success: false, error: "The run's worktree was removed." };
        agentDaemon.assertTaskWorkspaceFilesystemAccess(
          taskId,
          info.worktreePath,
          "write",
          "speculative fix pull request",
        );
        assertBaseRepository(
          taskId,
          info.repoPath || agentDaemon.getWorkspaceById(info.workspaceId)?.path,
          "git base repository",
        );
        return worktreeManager.openPullRequest(taskId, params);
      },
      discard: async (taskId) => {
        const info = await activeWorktree(taskId);
        if (!info) return;
        agentDaemon.assertTaskWorkspaceFilesystemAccess(
          taskId,
          info.worktreePath,
          "write",
          "speculative fix cleanup",
        );
        assertBaseRepository(
          taskId,
          info.repoPath || agentDaemon.getWorkspaceById(info.workspaceId)?.path,
          "git base repository cleanup",
        );
        await worktreeManager.cleanup(taskId, true);
      },
    },
    ...(channelGateway
      ? {
          postToThread: async ({ origin, text, idempotencyKey }) => {
            if (!origin.channelType || !origin.chatId) throw new Error("No thread to reply in.");
            await automationRuntime.assertOwnership();
            const messageId = await channelGateway.sendMessage(
              origin.channelType as ChannelType,
              origin.chatId,
              text,
              {
                ...(origin.channelInstanceId ? { channelDbId: origin.channelInstanceId } : {}),
                ...(origin.messageId ? { replyTo: origin.messageId } : {}),
                idempotencyKey,
              },
            );
            if (!messageId) throw new Error("The channel did not confirm the reply.");
          },
        }
      : {}),
    isOwnerSender: async ({ channelInstanceId, userId }) => {
      if (!channelInstanceId || !userId) return false;
      const channel = await new ChannelRepository(db).findById(channelInstanceId);
      return isGatewayOwnerSender(
        { userId },
        { ownerUserIds: (channel?.config as Record<string, unknown> | undefined)?.ownerUserIds },
      );
    },
    store: new FileSpeculativeRunStore(path.join(input.userDataDir, "speculative-runs.json")),
  });

  for (const type of WATCHED_TASK_EVENTS) {
    agentDaemon.on(type, (payload: { taskId?: unknown }) =>
      service.onTaskEvent(typeof payload?.taskId === "string" ? payload.taskId : undefined, type),
    );
  }

  // "open it" in the thread a draft was posted to turns that draft into a pull request.
  channelGateway?.onEvent((event) => {
    if (event.type !== "message:received" || !event.data) return;
    const data = event.data;
    const text = String(data.text ?? data.preview ?? "");
    if (!isOpenItReply(text)) return;
    void service
      .handleChannelMessage({
        channelType: event.channel || "",
        channelInstanceId: typeof data.channelId === "string" ? data.channelId : undefined,
        chatId: String(data.chatId || ""),
        userId: String(data.userId || ""),
        text,
      })
      .catch((error) => logger.warn("Could not handle an open-it reply:", error));
  });

  setActiveSpeculativeFixService(service);
  void service
    .init()
    .catch((error) => logger.warn("Speculative fix runtime failed to start:", error));
  return service;
}
