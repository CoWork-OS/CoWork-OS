import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import { ControlPlaneCoreService } from "./ControlPlaneCoreService";

export function attachControlPlaneTaskLifecycleSync(options: {
  agentDaemon: AgentDaemon;
  db: Database.Database;
  log?: (...args: unknown[]) => void;
}): () => void {
  const core = new ControlPlaneCoreService(options.db);
  // Listeners stay synchronous: the sync is queued and its failure is logged.
  const sync = (event: { taskId?: string }) => {
    const taskId = event?.taskId;
    if (!taskId) return;
    void core.syncTaskLifecycle(taskId).catch((error: unknown) => {
      options.log?.("[ControlPlaneTaskSync] Failed to sync task lifecycle", taskId, error);
    });
  };

  const syncStatus = (event: { taskId?: string; payload?: { status?: string } }) => {
    const status = event?.payload?.status;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "interrupted"
    ) {
      sync(event);
    }
  };

  options.agentDaemon.on("task_completed", sync);
  options.agentDaemon.on("task_cancelled", sync);
  options.agentDaemon.on("task_status", syncStatus);

  return () => {
    options.agentDaemon.off("task_completed", sync);
    options.agentDaemon.off("task_cancelled", sync);
    options.agentDaemon.off("task_status", syncStatus);
  };
}
