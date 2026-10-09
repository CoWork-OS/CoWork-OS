/**
 * Synthesis Agent Detection
 *
 * Identifies the Synthesis child task in collaborative runs. The Synthesis agent
 * is created by the orchestrator to gather and analyze sub-agent outputs — its
 * steps/output should be shown in the main view, not in a separate window.
 */

import type { Task } from "./types";

export const SYNTHESIS_TASK_TITLE = "Synthesis";

export function isSynthesisChildTask(task: Task): boolean {
  return task.title === SYNTHESIS_TASK_TITLE;
}

/** Title the orchestrator gives a synthesis work item that failed and was replaced by a retry. */
export const SUPERSEDED_SYNTHESIS_ITEM_TITLE = `${SYNTHESIS_TASK_TITLE} (failed)`;

function isUnsuccessfulTaskStatus(status: Task["status"]): boolean {
  return status === "failed" || status === "cancelled";
}

/** The newest synthesis child task: a retry replaces earlier attempts. */
export function getLatestSynthesisChildTask(tasks: Task[]): Task | undefined {
  let latest: Task | undefined;
  for (const task of tasks) {
    if (!isSynthesisChildTask(task)) continue;
    if (!latest || (task.createdAt ?? 0) >= (latest.createdAt ?? 0)) latest = task;
  }
  return latest;
}

/**
 * Synthesis attempts that failed but were replaced by a later attempt that
 * completed. They stay visible as history but no longer count as failures.
 */
export function getRecoveredSynthesisTaskIds(tasks: Task[]): Set<string> {
  const recovered = new Set<string>();
  const latest = getLatestSynthesisChildTask(tasks);
  if (!latest || latest.status !== "completed") return recovered;
  for (const task of tasks) {
    if (
      task.id !== latest.id &&
      isSynthesisChildTask(task) &&
      isUnsuccessfulTaskStatus(task.status)
    ) {
      recovered.add(task.id);
    }
  }
  return recovered;
}
