import type { TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function getApprovalCorrelationId(event: TaskEvent): string {
  const payload = asObject(event.payload);
  const approval = asObject(payload.approval);
  const value =
    typeof payload.approvalId === "string"
      ? payload.approvalId
      : typeof approval.id === "string"
        ? approval.id
        : "";
  return value.trim();
}

export function isApprovalRequestResolvedAtEmission(event: TaskEvent): boolean {
  if (getEffectiveTaskEventType(event) !== "approval_requested") return false;
  const payload = asObject(event.payload);
  const approval = asObject(payload.approval);
  const status = String(approval.status || payload.status || "")
    .trim()
    .toLowerCase();
  return (
    payload.autoApproved === true ||
    payload.autoResolved === true ||
    payload.autoResolving === true ||
    ["approved", "granted", "denied", "rejected"].includes(status)
  );
}

/**
 * Mark a session-wide "Approve for me" request before it reaches renderer
 * state. The canonical grant still resolves it, but compact UI never flashes
 * a confirmation prompt while that asynchronous response is in flight.
 */
export function markSessionAutoResolvingApproval(
  event: TaskEvent,
  sessionAutoApproveAll: boolean,
): TaskEvent {
  if (
    !sessionAutoApproveAll ||
    getEffectiveTaskEventType(event) !== "approval_requested" ||
    event.payload?.autoApproved === true
  ) {
    return event;
  }
  return {
    ...event,
    payload: {
      ...asObject(event.payload),
      autoResolving: true,
    },
  };
}

interface OrderedApprovalEvent {
  event: TaskEvent;
  index: number;
}

function compareApprovalEventOrder(a: OrderedApprovalEvent, b: OrderedApprovalEvent): number {
  const aSeq = typeof a.event.seq === "number" ? a.event.seq : null;
  const bSeq = typeof b.event.seq === "number" ? b.event.seq : null;
  if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
  if (a.event.timestamp !== b.event.timestamp) return a.event.timestamp - b.event.timestamp;
  return a.index - b.index;
}

function approvalKey(event: TaskEvent, approvalId: string): string {
  return `${event.taskId}:${approvalId}`;
}

export interface ApprovalEventState {
  pendingRequests: TaskEvent[];
  resolvedRequestEventIds: Set<string>;
}

/**
 * Fold approval lifecycle events by task and approval ID. Legacy ID-less
 * terminal events resolve only the most recent preceding ID-less request for
 * that task, which is deterministic without guessing across concurrent IDs.
 */
export function deriveApprovalEventState(events: TaskEvent[]): ApprovalEventState {
  const ordered = events.map((event, index) => ({ event, index })).sort(compareApprovalEventOrder);
  const orderIndexByEvent = new Map(ordered.map(({ event }, index) => [event, index]));
  const pendingByKey = new Map<string, TaskEvent>();
  const pendingIdlessByTask = new Map<string, TaskEvent[]>();
  const terminalKeys = new Set<string>();
  const resolvedRequestEventIds = new Set<string>();

  for (const { event } of ordered) {
    const type = getEffectiveTaskEventType(event);
    if (type === "approval_requested") {
      if (isApprovalRequestResolvedAtEmission(event)) {
        resolvedRequestEventIds.add(event.id);
        continue;
      }
      const approvalId = getApprovalCorrelationId(event);
      if (approvalId) {
        const key = approvalKey(event, approvalId);
        if (terminalKeys.has(key)) {
          resolvedRequestEventIds.add(event.id);
          continue;
        }
        const previous = pendingByKey.get(key);
        if (previous) resolvedRequestEventIds.add(previous.id);
        pendingByKey.set(key, event);
      } else {
        const pending = pendingIdlessByTask.get(event.taskId) || [];
        pending.push(event);
        pendingIdlessByTask.set(event.taskId, pending);
      }
      continue;
    }

    if (type !== "approval_granted" && type !== "approval_denied") continue;
    const approvalId = getApprovalCorrelationId(event);
    if (approvalId) {
      const key = approvalKey(event, approvalId);
      terminalKeys.add(key);
      const request = pendingByKey.get(key);
      if (request) {
        resolvedRequestEventIds.add(request.id);
        pendingByKey.delete(key);
      }
      continue;
    }

    const pending = pendingIdlessByTask.get(event.taskId);
    const request = pending?.pop();
    if (request) resolvedRequestEventIds.add(request.id);
  }

  const pendingRequests = [
    ...pendingByKey.values(),
    ...Array.from(pendingIdlessByTask.values()).flat(),
  ].sort((a, b) =>
    compareApprovalEventOrder(
      { event: a, index: orderIndexByEvent.get(a) ?? 0 },
      { event: b, index: orderIndexByEvent.get(b) ?? 0 },
    ),
  );

  return { pendingRequests, resolvedRequestEventIds };
}
