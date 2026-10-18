import type { TaskOutputSummary } from "../../shared/types";
import { getPrimaryOutputFileName } from "./task-outputs";

export function shouldShowPersistentNeedsUserActionBanner(
  payload:
    | {
        terminalStatus?: string;
        pendingChecklist?: unknown;
        verificationMessage?: unknown;
        verificationOutcome?: unknown;
      }
    | null
    | undefined,
): boolean {
  if (payload?.terminalStatus !== "needs_user_action") return false;
  if (
    Array.isArray(payload.pendingChecklist) &&
    payload.pendingChecklist.some((item) => typeof item === "string")
  ) {
    return true;
  }
  if (
    typeof payload.verificationMessage === "string" &&
    payload.verificationMessage.trim().length > 0
  ) {
    return true;
  }
  return payload.verificationOutcome === "pending_user_action";
}

export interface CompletionViewContext {
  isMainView: boolean;
  isSelectedTask: boolean;
  panelCollapsed: boolean;
}

export interface CompletionPanelDecision {
  autoOpenPanel: boolean;
  markUnseenOutput: boolean;
}

export function buildCompletionOutputMessage(summary: TaskOutputSummary): string {
  const primaryOutputName = getPrimaryOutputFileName(summary);
  if (summary.outputCount === 1) {
    return primaryOutputName || "1 file created";
  }
  if (primaryOutputName) {
    const more = summary.outputCount - 1;
    return more === 1 ? `${primaryOutputName} + 1 more` : `${primaryOutputName} + ${more} more`;
  }
  return `${summary.outputCount} files created`;
}

export function shouldTrackUnseenCompletion(
  context: Pick<CompletionViewContext, "isMainView" | "isSelectedTask">,
): boolean {
  return !(context.isMainView && context.isSelectedTask);
}

export function decideCompletionPanelBehavior(
  context: CompletionViewContext,
): CompletionPanelDecision {
  if (context.isMainView && context.isSelectedTask && context.panelCollapsed) {
    return { autoOpenPanel: true, markUnseenOutput: false };
  }
  if (!context.isMainView || context.panelCollapsed || !context.isSelectedTask) {
    return { autoOpenPanel: false, markUnseenOutput: true };
  }
  return { autoOpenPanel: false, markUnseenOutput: false };
}

export function addUniqueTaskId(taskIds: string[], taskId: string): string[] {
  return taskIds.includes(taskId) ? taskIds : [...taskIds, taskId];
}

export function removeTaskId(taskIds: string[], taskId: string): string[] {
  return taskIds.filter((id) => id !== taskId);
}

export function shouldClearUnseenOutputBadges(
  isMainView: boolean,
  rightPanelCollapsed: boolean,
): boolean {
  return isMainView && !rightPanelCollapsed;
}
