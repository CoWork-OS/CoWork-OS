import type { Task, TaskEvent, TaskStatus, TaskTerminalStatus } from "../../shared/types";
import { TASK_EVENT_STATUS_MAP } from "../../shared/task-event-status-map";
import { getEffectiveTaskEventType } from "./task-event-compat";

const TERMINAL_REPLAY_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const VALID_TERMINAL_STATUSES = new Set<TaskTerminalStatus>([
  "ok",
  "partial_success",
  "needs_user_action",
  "awaiting_approval",
  "resume_available",
  "failed",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getReplayTerminalStatus(
  task: Task,
  status: TaskStatus,
  terminalEvent: TaskEvent | null,
): TaskTerminalStatus | undefined {
  const payload = asRecord(terminalEvent?.payload);
  const payloadTerminalStatus = payload.terminalStatus;
  if (
    typeof payloadTerminalStatus === "string" &&
    VALID_TERMINAL_STATUSES.has(payloadTerminalStatus as TaskTerminalStatus)
  ) {
    return payloadTerminalStatus as TaskTerminalStatus;
  }

  if (task.terminalStatus && VALID_TERMINAL_STATUSES.has(task.terminalStatus)) {
    return task.terminalStatus;
  }

  if (status === "completed") return "ok";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "resume_available";
  return undefined;
}

function getReplayError(task: Task, terminalEvent: TaskEvent | null): string | null | undefined {
  const payload = asRecord(terminalEvent?.payload);
  const rawError = payload.error ?? payload.message ?? payload.reason;
  if (typeof rawError === "string" && rawError.trim().length > 0) return rawError;
  return task.error;
}

function stripFinalTaskFields(task: Task, status: TaskStatus, updatedAt: number): Task {
  const {
    completedAt: _completedAt,
    terminalStatus: _terminalStatus,
    error: _error,
    resultSummary: _resultSummary,
    semanticSummary: _semanticSummary,
    bestKnownOutcome: _bestKnownOutcome,
    coreOutcome: _coreOutcome,
    dependencyOutcome: _dependencyOutcome,
    failureDomains: _failureDomains,
    stopReasons: _stopReasons,
    failureClass: _failureClass,
    verificationVerdict: _verificationVerdict,
    verificationReport: _verificationReport,
    ...taskWithoutFinalFields
  } = task;

  return {
    ...taskWithoutFinalFields,
    status,
    updatedAt,
  } as Task;
}

export function deriveReplayTaskSnapshot(task: Task | undefined, replayEvents: TaskEvent[]): Task | undefined {
  if (!task) return undefined;

  let status: TaskStatus = "pending";
  let updatedAt = task.createdAt;
  let terminalEvent: TaskEvent | null = null;

  for (const event of replayEvents) {
    updatedAt = event.timestamp || updatedAt;
    const effectiveType = getEffectiveTaskEventType(event);
    const eventStatus = TASK_EVENT_STATUS_MAP[effectiveType];
    if (!eventStatus) continue;

    status = eventStatus;
    if (TERMINAL_REPLAY_STATUSES.has(eventStatus)) {
      terminalEvent = event;
    }
  }

  if (!TERMINAL_REPLAY_STATUSES.has(status)) {
    return stripFinalTaskFields(task, status, updatedAt);
  }

  const completedAt =
    typeof terminalEvent?.timestamp === "number" && Number.isFinite(terminalEvent.timestamp)
      ? terminalEvent.timestamp
      : task.completedAt;

  return {
    ...task,
    status,
    updatedAt,
    completedAt,
    terminalStatus: getReplayTerminalStatus(task, status, terminalEvent),
    error: status === "failed" ? getReplayError(task, terminalEvent) : task.error,
  };
}
