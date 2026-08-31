import type { Task } from "../../shared/types";

export const SELECTED_TASK_HYDRATION_ATTEMPT_CACHE_MAX = 200;

export function hasFullTaskPrompt(task: Task | undefined): boolean {
  return Boolean(task && (task.rawPrompt || task.userPrompt || task.prompt));
}

export function shouldHydrateTaskSummary(task: Task | undefined): boolean {
  if (!task) return false;
  if (hasFullTaskPrompt(task)) return false;
  return Boolean(
    task.sidebarPromptPreview || task.title || task.resultSummary || task.semanticSummary,
  );
}

export function getTaskHydrationAttemptKey(taskId: string, task: Task | undefined): string {
  return [taskId, task?.updatedAt ?? "", task?.sidebarPromptPreview ?? ""].join(":");
}

export function getTaskIdFromHydrationAttemptKey(key: string): string {
  const separatorIndex = key.indexOf(":");
  return separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
}

export function hasTaskHydrationAttempted(
  keys: ReadonlySet<string>,
  taskId: string,
  task: Task | undefined,
): boolean {
  return keys.has(getTaskHydrationAttemptKey(taskId, task));
}

export function recordTaskHydrationAttemptSuccess(
  keys: Set<string>,
  taskId: string,
  task: Task | undefined,
  activeTaskIds: ReadonlySet<string>,
): void {
  keys.add(getTaskHydrationAttemptKey(taskId, task));
  pruneTaskHydrationAttemptKeys(keys, activeTaskIds);
}

export function pruneTaskHydrationAttemptKeys(
  keys: Set<string>,
  activeTaskIds: ReadonlySet<string>,
  maxEntries = SELECTED_TASK_HYDRATION_ATTEMPT_CACHE_MAX,
): void {
  for (const key of keys) {
    if (!activeTaskIds.has(getTaskIdFromHydrationAttemptKey(key))) {
      keys.delete(key);
    }
  }

  while (keys.size > maxEntries) {
    const oldest = keys.values().next().value;
    if (typeof oldest !== "string") break;
    keys.delete(oldest);
  }
}

export function mergeSidebarTaskSummariesWithExisting(
  existingTasks: Task[],
  summaries: Task[],
): Task[] {
  if (existingTasks.length === 0 || summaries.length === 0) return summaries;

  const existingById = new Map(existingTasks.map((task) => [task.id, task]));
  let changed = false;

  const merged = summaries.map((summary) => {
    const existing = existingById.get(summary.id);
    if (!existing || !hasFullTaskPrompt(existing) || hasFullTaskPrompt(summary)) {
      return summary;
    }

    changed = true;
    return {
      ...existing,
      ...summary,
      prompt: existing.prompt,
      rawPrompt: existing.rawPrompt,
      userPrompt: existing.userPrompt,
      sidebarPromptPreview: summary.sidebarPromptPreview ?? existing.sidebarPromptPreview,
      agentConfig: existing.agentConfig
        ? { ...existing.agentConfig, ...(summary.agentConfig || {}) }
        : summary.agentConfig,
      resultSummary: existing.resultSummary ?? summary.resultSummary,
      semanticSummary: existing.semanticSummary ?? summary.semanticSummary,
      bestKnownOutcome: existing.bestKnownOutcome,
    };
  });

  return changed ? merged : summaries;
}

export function mergeSidebarInitialPageWithSelectedTask(
  existingTasks: Task[],
  summaries: Task[],
  selectedTaskId: string | null,
): Task[] {
  const merged = mergeSidebarTaskSummariesWithExisting(existingTasks, summaries);
  if (!selectedTaskId || merged.some((task) => task.id === selectedTaskId)) {
    return merged;
  }

  const selectedTask = existingTasks.find((task) => task.id === selectedTaskId);
  return selectedTask ? [...merged, selectedTask] : merged;
}
