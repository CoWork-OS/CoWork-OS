import type Database from "better-sqlite3";
import { assertTaskNotStopped } from "../../automation/BotWorkControlStore";
export interface GraphTaskAdmission {
  runId: string;
  nodeId: string;
  claimId: string;
}
export class GraphTaskAdmissionClosedError extends Error {}
/** Called only inside the task writer's IMMEDIATE transaction. */
export function assertGraphTaskAdmission(
  db: Database.Database,
  input: GraphTaskAdmission,
  workspaceId: string,
): void {
  const row = db
    .prepare(`SELECT r.root_task_id,r.workspace_id,r.status AS run_status,n.status,n.task_id,n.remote_task_id,n.metadata,t.workspace_id AS root_workspace
    FROM orchestration_graph_nodes n JOIN orchestration_graph_runs r ON r.id=n.run_id JOIN tasks t ON t.id=r.root_task_id
    WHERE n.id=? AND r.id=?`)
    .get(input.nodeId, input.runId) as
    | {
        root_task_id: string;
        workspace_id: string;
        root_workspace: string;
        run_status: string;
        status: string;
        task_id: string | null;
        remote_task_id: string | null;
        metadata: string | null;
      }
    | undefined;
  if (
    !row ||
    row.workspace_id !== workspaceId ||
    row.root_workspace !== workspaceId ||
    row.run_status !== "running" ||
    row.status !== "running" ||
    row.task_id ||
    row.remote_task_id
  )
    throw new GraphTaskAdmissionClosedError("Graph task admission is closed or already linked");
  let claim: { id?: string } | undefined;
  try {
    claim = JSON.parse(row.metadata ?? "{}").dispatchClaim;
  } catch {
    /* Invalid claim cannot grant admission. */
  }
  if (claim?.id !== input.claimId)
    throw new GraphTaskAdmissionClosedError("Graph dispatch claim changed");
  try {
    assertTaskNotStopped(db, row.root_task_id);
  } catch {
    throw new GraphTaskAdmissionClosedError("Graph root has a persisted stop request");
  }
}
export function linkGraphTaskAdmission(
  db: Database.Database,
  input: GraphTaskAdmission,
  taskId: string,
): void {
  const result = db
    .prepare(
      "UPDATE orchestration_graph_nodes SET task_id=?,updated_at=? WHERE id=? AND run_id=? AND task_id IS NULL AND remote_task_id IS NULL",
    )
    .run(taskId, Date.now(), input.nodeId, input.runId);
  if (result.changes !== 1) throw new GraphTaskAdmissionClosedError("Graph task link changed");
}
