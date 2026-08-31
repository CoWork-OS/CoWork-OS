import type { ControlPlaneFrame } from "./control-plane-client";

export interface WorkspaceLike {
  id?: string;
  name?: string;
  path?: string;
}

export interface TaskLike {
  id?: string;
  title?: string;
  status?: string;
  workspaceId?: string;
}

export interface ApprovalLike {
  id?: string;
  taskId?: string;
  taskTitle?: string;
  type?: string;
  description?: string;
  requestedAt?: number;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function formatWorkspace(workspace: WorkspaceLike): string {
  const id = workspace.id || "unknown";
  const name = workspace.name || "Workspace";
  const workspacePath = workspace.path ? `  ${workspace.path}` : "";
  return `${id}  ${name}${workspacePath}`;
}

export function formatTask(task: TaskLike): string {
  const id = task.id || "unknown";
  const status = task.status || "unknown";
  const title = task.title || "Untitled task";
  return `${id}  [${status}]  ${title}`;
}

export function formatApproval(approval: ApprovalLike): string {
  const id = approval.id || "unknown";
  const type = approval.type || "approval";
  const task = approval.taskTitle || approval.taskId || "unknown task";
  const description = approval.description ? `  ${approval.description}` : "";
  return `${id}  [${type}]  ${task}${description}`;
}

export function buildTaskTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return "CLI task";
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

export function extractArrayPayload<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== "object") return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

export function formatTaskEventFrame(frame: ControlPlaneFrame): string | null {
  if (frame.type !== "event") return null;
  const payload =
    frame.payload && typeof frame.payload === "object"
      ? (frame.payload as Record<string, unknown>)
      : {};
  const inner =
    payload.event && typeof payload.event === "object"
      ? (payload.event as Record<string, unknown>)
      : {};
  const eventName = frame.event || "event";
  const kind =
    stringValue(payload.kind) ||
    stringValue(payload.type) ||
    stringValue(inner.kind) ||
    stringValue(inner.type);
  const message =
    stringValue(payload.message) ||
    stringValue(payload.text) ||
    stringValue(payload.summary) ||
    stringValue(inner.message) ||
    stringValue(inner.text) ||
    stringValue(inner.summary);
  const status = stringValue(payload.status) || stringValue(inner.status);
  const taskId = stringValue(payload.taskId) || stringValue(inner.taskId);

  if (message) {
    return taskId ? `${eventName} ${taskId}: ${message}` : `${eventName}: ${message}`;
  }
  if (kind || status) {
    const label = [kind, status].filter(Boolean).join("/");
    return taskId ? `${eventName} ${taskId}: ${label}` : `${eventName}: ${label}`;
  }
  if (eventName === "heartbeat") return null;
  return taskId ? `${eventName} ${taskId}` : eventName;
}

export function isTerminalTaskFrame(frame: ControlPlaneFrame, taskId?: string): boolean {
  if (frame.type !== "event") return false;
  if (frame.event === "task.completed" || frame.event === "task.failed")
    return matchesTask(frame, taskId);
  const payload =
    frame.payload && typeof frame.payload === "object"
      ? (frame.payload as Record<string, unknown>)
      : {};
  const inner =
    payload.event && typeof payload.event === "object"
      ? (payload.event as Record<string, unknown>)
      : {};
  const status = stringValue(payload.status) || stringValue(inner.status);
  return (
    matchesTask(frame, taskId) &&
    (status === "completed" || status === "failed" || status === "cancelled")
  );
}

export function matchesTask(frame: ControlPlaneFrame, taskId?: string): boolean {
  if (!taskId) return true;
  const payload =
    frame.payload && typeof frame.payload === "object"
      ? (frame.payload as Record<string, unknown>)
      : {};
  const inner =
    payload.event && typeof payload.event === "object"
      ? (payload.event as Record<string, unknown>)
      : {};
  return stringValue(payload.taskId) === taskId || stringValue(inner.taskId) === taskId;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
