import { isTempWorkspaceId, type AgentTeam, type Task } from "../../shared/types";
import type { CreateTaskOptions } from "../components/MainContent/main-content-types";

/** Cross-component signal used by the bot details rail to reveal inline history. */
export const BOT_CONVERSATION_HISTORY_OPEN_EVENT = "cowork:bot-conversation-history-open";

/** A role-assigned work task is still a task; only explicit bot chats are bot transcripts. */
export function isBotConversation(task: Pick<Task, "agentConfig"> | null | undefined): boolean {
  return task?.agentConfig?.botConversation === true;
}

const DORMANT_BOT_SEED_RE = /^start (?:a )?(?:conversation|chatting) with /i;
const BOT_RECOVERY_BRANCH_RE = /\b(?:reopened|repaired) bot conversation\b/i;

/** A recovery branch is the current, workspace-local continuation of an older transcript. */
export function isBotRecoveryBranch(
  task: Pick<Task, "branchFromTaskId" | "branchLabel"> | null | undefined,
): boolean {
  return Boolean(
    task?.branchFromTaskId &&
    typeof task.branchLabel === "string" &&
    BOT_RECOVERY_BRANCH_RE.test(task.branchLabel),
  );
}

function hasVisibleBotMessage(task: Task): boolean {
  const candidate = task as Task & {
    sidebarPromptPreview?: string;
    resultSummary?: string;
    userPrompt?: string;
  };
  return [candidate.resultSummary, candidate.sidebarPromptPreview, candidate.userPrompt].some(
    (value) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      !DORMANT_BOT_SEED_RE.test(value.trim()),
  );
}

function botConversationActivityAt(task: Task): number {
  // Timeout reconciliation can update a dormant blocked row hours later. That
  // maintenance write is not a new conversation turn for the bot roster.
  if (
    task.status === "blocked" &&
    task.terminalStatus === "needs_user_action" &&
    (/^No correlated reply arrived from .+ within \d+ seconds\./.test(task.error || "") ||
      /^No outstanding teammate reply is pending for this conversation\./.test(task.error || ""))
  ) {
    return task.completedAt || task.createdAt;
  }
  return task.updatedAt || task.createdAt;
}

/** Prefer a real transcript over a newer empty placeholder from a temp workspace. */
export function selectLatestBotConversation(tasks: Task[], agentRoleId?: string): Task | undefined {
  const candidates = tasks.filter(
    (task) =>
      isBotConversation(task) &&
      task.source !== "side_chat" &&
      task.sessionArchived !== true &&
      (!agentRoleId || task.assignedAgentRoleId === agentRoleId),
  );
  // A recovered conversation replaces its own source, even if that source
  // receives a late status update. It does not outrank newer, unrelated chats.
  const replacedSourceIds = new Set(
    candidates
      .filter(isBotRecoveryBranch)
      .map((task) => task.branchFromTaskId)
      .filter((id): id is string => Boolean(id)),
  );
  return candidates
    .filter((task) => !replacedSourceIds.has(task.id))
    .sort((a, b) => {
      const visibleDifference = Number(hasVisibleBotMessage(b)) - Number(hasVisibleBotMessage(a));
      if (visibleDifference !== 0) return visibleDifference;
      return (
        botConversationActivityAt(b) - botConversationActivityAt(a) ||
        b.createdAt - a.createdAt ||
        b.id.localeCompare(a.id)
      );
    })[0];
}

export function createBotConversationOptions(agentRoleId: string): CreateTaskOptions {
  return {
    // Keep the bot surface conversational, but allow task turns to use the
    // normal tool pipeline when the bot is asked to do real work.
    executionMode: "execute",
    assignedAgentRoleId: agentRoleId,
    agentConfig: {
      botConversation: true,
      conversationMode: "hybrid",
      executionMode: "execute",
      executionModeSource: "strategy",
    },
  };
}

export function getConversationActionLabels(botConversation: boolean) {
  const noun = botConversation ? "conversation" : "task";
  return {
    menu: botConversation ? "Bot options" : "Task actions",
    pin: `Pin ${noun}`,
    unpin: `Unpin ${noun}`,
    rename: `Rename ${noun}`,
    archive: `Archive ${noun}`,
    copyId: `Copy ${noun} ID`,
    copyLink: botConversation ? "Copy conversation link" : "Copy deeplink",
    fork: botConversation ? "Branch conversation" : "Fork session",
  };
}

export function shouldShowCancelledTaskBanner(input: {
  taskStatus: Task["status"] | undefined;
  isBotConversation: boolean;
}): boolean {
  return input.taskStatus === "cancelled" && !input.isBotConversation;
}

export function matchesBotConversation(
  task: Task,
  workspaceId: string,
  agentRoleId: string,
): boolean {
  return (
    isBotConversation(task) &&
    task.source !== "side_chat" &&
    task.workspaceId === workspaceId &&
    task.assignedAgentRoleId === agentRoleId
  );
}

/** Continue a mismatched bot transcript as a new branch, preserving its workspace and team. */
export function shouldReopenBotConversationInWorkspace(
  task: Pick<Task, "workspaceId" | "agentConfig">,
  workspaceId: string,
  teams: ReadonlyArray<Pick<AgentTeam, "id" | "isActive" | "persistent">>,
): boolean {
  if (!isTempWorkspaceId(workspaceId)) return false;
  if (task.workspaceId !== workspaceId) return true;
  const teamId = task.agentConfig?.botTeamId;
  return Boolean(
    teamId && !teams.some((team) => team.id === teamId && team.isActive && team.persistent),
  );
}
