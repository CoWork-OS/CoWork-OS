import type { TaskEvent } from "../../../shared/types";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";

export type Payload = Record<string, unknown>;

export const payloadRecord = (value: unknown): Payload =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : {};

export function formatSignedScore(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  const normalized = Math.max(-1, Math.min(1, value));
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(2)}`;
}

export function describeLoopRisk(loopRisk: number): "low" | "medium" | "high" {
  if (!Number.isFinite(loopRisk)) return "low";
  if (loopRisk >= 0.7) return "high";
  if (loopRisk >= 0.4) return "medium";
  return "low";
}

export function getApprovalPayload(event: TaskEvent): Payload | null {
  if (!event?.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return null;
  }
  const approval = (event.payload as Payload).approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return null;
  }
  return approval as Payload;
}

export function getApprovalDescription(approval: Payload | null): string {
  const description = approval?.description;
  return typeof description === "string" ? description.trim() : "";
}

export function extractApprovalCommand(approval: Payload | null): string | null {
  const commandFromDetails = payloadRecord(approval?.details).command;
  if (typeof commandFromDetails === "string") {
    const trimmed = commandFromDetails.trim();
    if (trimmed.length > 0) return trimmed;
  }

  const description = getApprovalDescription(approval);
  if (!description) return null;

  const commandMatch = description.match(/^Run(?:ning)? command(?:\s*\([^)]+\))?:\s*([\s\S]+)$/i);
  if (!commandMatch || typeof commandMatch[1] !== "string") return null;
  const command = commandMatch[1].trim();
  return command.length > 0 ? command : null;
}

export function isRunCommandApproval(approval: Payload | null): boolean {
  if (approval?.type === "run_command") return true;
  return Boolean(extractApprovalCommand(approval));
}

export function shouldHideApprovalEventInStepFeed(event: TaskEvent): boolean {
  if (getEffectiveTaskEventType(event) !== "approval_requested") return false;
  if (event.payload?.autoApproved === true || event.payload?.autoResolving === true) return true;
  return isRunCommandApproval(getApprovalPayload(event));
}
