import type { Task } from "./types";

const AUTOMATED_TITLE_PATTERNS: RegExp[] = [
  /^heartbeat:/i,
  /^chief of staff briefing$/i,
  /^routine prep:/i,
  /^follow up:/i,
  /^organize work session:/i,
];

export function hasAutomatedTaskTitle(title: string | undefined): boolean {
  const normalized = String(title || "").trim();
  return AUTOMATED_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * A background worker started by a `speculate_fix` trigger (see AgentConfig.speculative). The
 * sidebar files it with automated sessions, but it is deliberately not `isAutomatedTaskLike`:
 * that would redirect the new test files it writes into the managed output folder.
 */
export function isSpeculativeTask(task: Pick<Task, "agentConfig"> | null | undefined): boolean {
  return task?.agentConfig?.speculative === true;
}

export function isAutomatedTaskLike(task: Task | null | undefined): boolean {
  if (!task) return false;
  if (task.source === "managed_agent_panel") return false;
  if (task.source === "manual") return false;
  if (
    task.source === "cron" ||
    task.source === "improvement" ||
    task.source === "subconscious" ||
    task.source === "symphony"
  ) {
    return true;
  }
  if (hasAutomatedTaskTitle(task.title)) return true;
  if (task.source === "hook") return false;
  if (task.source === "api") {
    return Boolean(
      task.companyId || task.goalId || task.projectId || task.issueId || task.heartbeatRunId,
    );
  }
  return !!task.heartbeatRunId;
}
