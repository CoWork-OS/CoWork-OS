import type { AutomationRunOutcome, NotificationType } from "../../shared/types";

export interface AutomationNotificationPayload {
  type: NotificationType;
  title: string;
  message: string;
  taskId?: string;
  workspaceId?: string;
  recommendedDelivery?: "briefing" | "inbox" | "nudge";
  companionStyle?: "email" | "note";
  /** Fresh delivery identity used when an operator explicitly retries. */
  deliveryId?: string;
}

export function shouldNotifyAutomationOutcome(outcome: AutomationRunOutcome): boolean {
  if (!outcome.notificationRecommended) return false;
  return outcome.usefulness === "actionable" || outcome.usefulness === "failed";
}

export function buildAutomationNotification(
  outcome: AutomationRunOutcome,
): AutomationNotificationPayload | null {
  if (!shouldNotifyAutomationOutcome(outcome)) return null;
  const type: NotificationType = outcome.usefulness === "failed" ? "warning" : "info";
  const nextAction = outcome.nextAction ? ` Next: ${outcome.nextAction}` : "";
  return {
    type,
    title: outcome.title,
    message: `${outcome.summary}${nextAction}`,
    taskId: outcome.taskId,
    workspaceId: outcome.workspaceId,
    recommendedDelivery: "inbox",
    companionStyle: "note",
  };
}
