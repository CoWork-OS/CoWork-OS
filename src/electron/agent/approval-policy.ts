import type { Task } from "../../shared/types";
import { isAutomatedTaskLike } from "../../shared/automated-task-detection";
import {
  allowsHardBlockerHumanInput,
  resolveHumanInputPolicy,
} from "../../shared/human-input-policy";

/**
 * Approval prompts are an opt-in compatibility path. CoWork's normal local
 * runtime follows the same no-prompt posture as the full-auto harnesses; set
 * COWORK_APPROVAL_PROMPTS=on when an operator explicitly wants the legacy
 * approval queue back (tests also opt into it through NODE_ENV=test).
 */
export function approvalPromptsDisabled(): boolean {
  const configured = String(process.env.COWORK_APPROVAL_PROMPTS || "")
    .trim()
    .toLowerCase();
  if (configured === "on" || configured === "enabled" || configured === "true") {
    return false;
  }
  if (configured === "off" || configured === "disabled" || configured === "false") {
    return true;
  }
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return false;
  return true;
}

/**
 * With the legacy queue off, a policy `ask` is delivered as an inline
 * "Deny / Allow once" card in the task timeline
 * (`AgentDaemon.requestAssistantApproval`). The card is only a consent surface
 * when a person can see and answer it, so every context without one keeps the
 * fail-closed denial: headless runs, `cowork run` CLI tasks (the CLI never
 * answers input requests), sub-agents, channel conversations (they use typed
 * channel decision cards instead), scheduled/automated work, and tasks
 * configured for no human input. A local desktop bot conversation is a direct
 * chat with the user, so like other bot apps it pauses and asks in the chat;
 * the pending decision also appears in that bot's Needs you view.
 */
export function canAnswerInlineApproval(
  task: Task | null | undefined,
  runtime: { headless: boolean },
): boolean {
  if (!task || runtime.headless) return false;
  const agentConfig = task.agentConfig;
  if (agentConfig?.cli?.owner === "cowork-run") return false;
  if (task.parentTaskId) return false;
  if (agentConfig?.gatewayContext) return false;
  if (isAutomatedTaskLike(task)) return false;
  return allowsHardBlockerHumanInput(resolveHumanInputPolicy({ agentConfig }));
}
