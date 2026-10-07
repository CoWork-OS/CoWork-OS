import { isTempWorkspaceId, type Task } from "../../shared/types";
import type { CreateTaskOptions } from "../components/MainContent/main-content-types";
import { isBotConversationSeedPrompt } from "../../shared/bot-messages";

/** Cross-component signal used by the bot details rail to reveal inline history. */
export const BOT_CONVERSATION_HISTORY_OPEN_EVENT = "cowork:bot-conversation-history-open";

/** A role-assigned work task is still a task; only explicit bot chats are bot transcripts. */
export function isBotConversation(task: Pick<Task, "agentConfig"> | null | undefined): boolean {
  return task?.agentConfig?.botConversation === true;
}

export { isBotConversationSeedPrompt };

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
      typeof value === "string" && value.trim().length > 0 && !isBotConversationSeedPrompt(value),
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

function botConversationCandidates(tasks: Task[], agentRoleId?: string): Task[] {
  return tasks.filter(
    (task) =>
      isBotConversation(task) &&
      task.source !== "side_chat" &&
      task.sessionArchived !== true &&
      (!agentRoleId || task.assignedAgentRoleId === agentRoleId),
  );
}

/**
 * A recovery branch continues its source transcript, so it carries the source's messages
 * and activity even before anything is said in it. Without this, a fresh branch lost to
 * the next-older conversation, and every launch in a temporary workspace branched again
 * from further back in the bot's history.
 */
function resolveBotConversationStanding(
  task: Task,
  byId: ReadonlyMap<string, Task>,
): { visible: boolean; activityAt: number } {
  let visible = hasVisibleBotMessage(task);
  let activityAt = botConversationActivityAt(task);
  const seen = new Set<string>([task.id]);
  let current = task;
  while (isBotRecoveryBranch(current)) {
    const source = byId.get(current.branchFromTaskId!);
    // A branch only exists because its source had a transcript, even one not loaded here.
    if (!source || seen.has(source.id)) {
      visible = true;
      break;
    }
    seen.add(source.id);
    visible = visible || hasVisibleBotMessage(source);
    activityAt = Math.max(activityAt, botConversationActivityAt(source));
    current = source;
  }
  return { visible, activityAt };
}

/** Prefer a real transcript over a newer empty placeholder from a temp workspace. */
export function selectLatestBotConversation(tasks: Task[], agentRoleId?: string): Task | undefined {
  const candidates = botConversationCandidates(tasks, agentRoleId);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const standing = new Map(
    candidates.map((task) => [task.id, resolveBotConversationStanding(task, byId)]),
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
      const aStanding = standing.get(a.id)!;
      const bStanding = standing.get(b.id)!;
      const visibleDifference = Number(bStanding.visible) - Number(aStanding.visible);
      if (visibleDifference !== 0) return visibleDifference;
      return (
        bStanding.activityAt - aStanding.activityAt ||
        b.createdAt - a.createdAt ||
        b.id.localeCompare(a.id)
      );
    })[0];
}

/** The bot's conversation with the most recent message, for the roster's preview and age. */
export function selectLatestMessagedBotConversation(
  tasks: Task[],
  agentRoleId?: string,
): Task | undefined {
  return botConversationCandidates(tasks, agentRoleId)
    .filter(hasVisibleBotMessage)
    .sort(
      (a, b) =>
        botConversationActivityAt(b) - botConversationActivityAt(a) || b.id.localeCompare(a.id),
    )[0];
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
  _teams?: ReadonlyArray<{ id: string; isActive: boolean; persistent: boolean }>,
): boolean {
  // Opening an existing local conversation never repairs its team authorization.
  return isTempWorkspaceId(workspaceId) && task.workspaceId !== workspaceId;
}
