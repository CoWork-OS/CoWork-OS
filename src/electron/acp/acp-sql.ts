import type Database from "better-sqlite3";
import type { ACPAgentCard, ACPTask } from "./types";

/**
 * ACP persistence (async SQLite migration plan, DB6): remote agent registrations and ACP
 * tasks. The registry and the handler keep both in memory; as services-domain units these
 * writes and the startup loads run in the database worker when the domain is routed there.
 */
export class AcpStore {
  constructor(private readonly db: Database.Database) {}

  remoteAgentRows(): Array<{ id: string; card_json: string }> {
    return this.db
      .prepare(
        "SELECT id, card_json FROM acp_agents WHERE origin = 'remote' ORDER BY registered_at DESC",
      )
      .all() as Array<{ id: string; card_json: string }>;
  }

  persistRemoteAgent(card: ACPAgentCard, now: number): void {
    this.db
      .prepare(
        `INSERT INTO acp_agents (id, origin, endpoint, name, provider, status, registered_at, updated_at, card_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           endpoint = excluded.endpoint,
           name = excluded.name,
           provider = excluded.provider,
           status = excluded.status,
           updated_at = excluded.updated_at,
           card_json = excluded.card_json`,
      )
      .run(
        card.id,
        card.origin,
        card.endpoint || null,
        card.name,
        card.provider || null,
        card.status,
        card.registeredAt,
        now,
        JSON.stringify(card),
      );
  }

  deleteRemoteAgent(agentId: string): void {
    this.db.prepare("DELETE FROM acp_agents WHERE id = ?").run(agentId);
  }

  taskRows(): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT id, requester_id, assignee_id, title, prompt, status, result, error,
              cowork_task_id, remote_task_id, workspace_id, created_at, updated_at, completed_at
       FROM acp_tasks
       ORDER BY created_at DESC`,
      )
      .all() as Record<string, unknown>[];
  }

  persistTask(task: ACPTask): void {
    this.db
      .prepare(
        `INSERT INTO acp_tasks (
      id, requester_id, assignee_id, title, prompt, status, result, error,
      cowork_task_id, remote_task_id, workspace_id, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      requester_id = excluded.requester_id,
      assignee_id = excluded.assignee_id,
      title = excluded.title,
      prompt = excluded.prompt,
      status = excluded.status,
      result = excluded.result,
      error = excluded.error,
      cowork_task_id = excluded.cowork_task_id,
      remote_task_id = excluded.remote_task_id,
      workspace_id = excluded.workspace_id,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at`,
      )
      .run(
        task.id,
        task.requesterId,
        task.assigneeId,
        task.title,
        task.prompt,
        task.status,
        task.result || null,
        task.error || null,
        task.coworkTaskId || null,
        task.remoteTaskId || null,
        task.workspaceId || null,
        task.createdAt,
        task.updatedAt,
        task.completedAt || null,
      );
  }
}
