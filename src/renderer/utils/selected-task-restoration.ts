import type { Task } from "../../shared/types";

export const SELECTED_TASK_STORAGE_PREFIX = "cowork.selectedTask";

export function selectedTaskStorageKey(workspaceId: string): string {
  const normalized = typeof workspaceId === "string" ? workspaceId.trim() : "";
  return `${SELECTED_TASK_STORAGE_PREFIX}:${normalized}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function readPersistedSelectedTaskId(
  workspaceId: string,
  storage: StorageLike | undefined = defaultStorage(),
): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(selectedTaskStorageKey(workspaceId));
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function persistSelectedTaskId(
  workspaceId: string,
  taskId: string | null,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    const key = selectedTaskStorageKey(workspaceId);
    if (taskId && taskId.trim()) storage.setItem(key, taskId.trim());
    else storage.removeItem(key);
  } catch {
    // Storage can be unavailable in private/locked-down renderer contexts;
    // selection remains fully functional for the current process.
  }
}

export function canRestoreSelectedTask(
  task: Task | null | undefined,
  workspaceId: string,
): boolean {
  return Boolean(task?.id && task.workspaceId === workspaceId);
}
