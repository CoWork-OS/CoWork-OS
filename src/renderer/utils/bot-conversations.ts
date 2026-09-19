import type { Task } from "../../shared/types";
import type { CreateTaskOptions } from "../components/MainContent/main-content-types";

/** Cross-component signal used by the bot details rail to reveal inline history. */
export const BOT_CONVERSATION_HISTORY_OPEN_EVENT = "cowork:bot-conversation-history-open";

/** A role-assigned work task is still a task; only explicit bot chats are bot transcripts. */
export function isBotConversation(task: Pick<Task, "agentConfig"> | null | undefined): boolean {
  return task?.agentConfig?.botConversation === true;
}

const DORMANT_BOT_SEED_RE = /^start (?:a )?(?:conversation|chatting) with /i;

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

/** Prefer a real transcript over a newer empty placeholder from a temp workspace. */
export function selectLatestBotConversation(tasks: Task[], agentRoleId?: string): Task | undefined {
  return tasks
    .filter(
      (task) =>
        isBotConversation(task) &&
        task.source !== "side_chat" &&
        task.sessionArchived !== true &&
        (!agentRoleId || task.assignedAgentRoleId === agentRoleId),
    )
    .sort((a, b) => {
      const visibleDifference = Number(hasVisibleBotMessage(b)) - Number(hasVisibleBotMessage(a));
      if (visibleDifference !== 0) return visibleDifference;
      return (
        (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt) ||
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
