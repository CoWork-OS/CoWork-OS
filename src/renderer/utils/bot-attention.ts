import type { AttentionItem } from "../../shared/attention";
import type { BotWorkView } from "../../shared/types";

/**
 * The bot surfaces (Bots home, the bot work dialog and the bot details rail) take "Needs you"
 * from the shared queue, so a bot's count agrees with Today, Team, the bell and the sidebar.
 * Working, Scheduled and Results still come from the bot work store.
 */

/**
 * Decisions in a bot's work in one workspace: its own sessions and the work they delegated,
 * as the queue attributes them (AttentionItem.ownerAgentRoleIds).
 */
export function botAttentionItems(
  items: readonly AttentionItem[],
  scope: { workspaceId: string; botId: string },
): AttentionItem[] {
  if (!scope.workspaceId || !scope.botId) return [];
  return items.filter(
    (item) =>
      Boolean(item.taskId) &&
      item.workspaceId === scope.workspaceId &&
      (item.ownerAgentRoleIds ?? []).includes(scope.botId),
  );
}

/**
 * Decisions in any of these bots' work, each counted once even when it belongs to a bot and to
 * the bot that delegated to it.
 */
export function botsAttentionCount(
  items: readonly AttentionItem[],
  workspaceId: string,
  botIds: Iterable<string>,
): number {
  const ids = new Set(botIds);
  return items.filter(
    (item) =>
      Boolean(item.taskId) &&
      item.workspaceId === workspaceId &&
      (item.ownerAgentRoleIds ?? []).some((roleId) => ids.has(roleId)),
  ).length;
}

/** The store's counts with Needs you taken from the queue; no counts until the store's load. */
export function withQueueNeedsYou(
  counts: Record<BotWorkView, number> | null,
  needsYou: number,
): Record<BotWorkView, number> | null {
  return counts ? { ...counts, needs_you: needsYou } : null;
}

/** The one line under a queue item in a bot's Needs you list. */
export function botAttentionLine(item: AttentionItem): string {
  if (item.kind === "approval") return "Waiting for your approval";
  if (item.kind === "question") {
    return item.state === "Question" ? "Has a question for you" : `Has ${item.state} for you`;
  }
  return item.state;
}
