import type { Task } from "../../shared/types";

type TaskOwner = Pick<Task, "id" | "workspaceId">;

export interface ComposerDraftOwnerContext {
  workspaceId: string;
  taskId: string | null;
  ready: boolean;
}

/**
 * Resolve the owner used by renderer-side composer draft IPC calls.
 *
 * The selected task can change one render before the workspace state catches
 * up. Prefer the task's persisted workspace in that window, and do not issue
 * a task-scoped request until an asynchronously opened task has been hydrated.
 */
export function resolveComposerDraftOwnerContext(input: {
  currentWorkspaceId?: string | null;
  selectedTaskId?: string | null;
  selectedTask?: TaskOwner | null;
  remoteTask?: TaskOwner | null;
}): ComposerDraftOwnerContext {
  const selectedTaskId = input.selectedTaskId?.trim() || "";
  const selectedTask =
    selectedTaskId && input.selectedTask?.id === selectedTaskId ? input.selectedTask : null;
  const task = input.remoteTask ?? selectedTask;
  const waitingForSelectedTask = !input.remoteTask && Boolean(selectedTaskId) && !selectedTask;
  const workspaceId =
    task?.workspaceId?.trim() ||
    (waitingForSelectedTask ? "" : input.currentWorkspaceId?.trim() || "");

  return {
    workspaceId,
    taskId: task?.id?.trim() || null,
    ready: Boolean(workspaceId) && !waitingForSelectedTask,
  };
}
