import { Task } from "../../../shared/types";
import { type AgentLifecycleRow as AgentLifecycleRowModel } from "../../utils/agent-lifecycle-rows";

/**
 * Render revision for a sub-agent lifecycle row. It covers every child-task field the row shows:
 * status updates land before the finished task's summary or error, so status alone would keep
 * the cached row without its outcome.
 */
export function getAgentLifecycleRowRevision(
  row: AgentLifecycleRowModel,
  childTasksById: ReadonlyMap<string, Task>,
): string {
  return JSON.stringify([
    row.id,
    row.state,
    row.taskIds.map((taskId) => {
      const childTask = childTasksById.get(taskId);
      return childTask
        ? [
            taskId,
            childTask.status,
            childTask.title,
            childTask.resultSummary ?? null,
            childTask.error ?? null,
          ]
        : [taskId, null];
    }),
  ]);
}
