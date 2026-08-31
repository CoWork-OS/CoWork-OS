/**
 * Orchestration Repository
 *
 * Database persistence for DAG-based sub-agent orchestration runs.
 * Follows the same repository pattern as ImprovementCampaignRepository.
 */

import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type { ModelCapability } from "../../shared/types";

export interface OrchestrationTask {
  /** Local DAG node ID (stable across DB round-trips) */
  id: string;
  title: string;
  prompt: string;
  /** IDs of local DAG nodes that must complete before this task starts */
  dependsOn: string[];
  /** CoWork task ID once the sub-agent has been spawned */
  taskId?: string;
  status: "pending" | "spawned" | "running" | "completed" | "failed";
  output?: string;
  error?: string;
  capabilityHint?: ModelCapability;
  acpAgentId?: string;
  remoteTaskId?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface OrchestrationRun {
  id: string;
  rootTaskId: string;
  workspaceId: string;
  tasks: OrchestrationTask[];
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface RunRow {
  id: string;
  root_task_id: string;
  workspace_id: string;
  tasks: string;
  status: string;
  created_at: number;
  completed_at: number | null;
}

function rowToRun(row: RunRow): OrchestrationRun {
  return {
    id: row.id,
    rootTaskId: row.root_task_id,
    workspaceId: row.workspace_id,
    tasks: safeJsonParse<OrchestrationTask[]>(row.tasks, []),
    status: row.status as OrchestrationRun["status"],
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export class OrchestrationRepository {
  constructor(private db: Database.Database) {}

  create(
    input: Omit<OrchestrationRun, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): OrchestrationRun {
    const now = Date.now();
    const run: OrchestrationRun = {
      ...input,
      id: input.id ?? uuidv4(),
      createdAt: input.createdAt ?? now,
    };

    this.db
      .prepare(
        `INSERT INTO orchestration_runs (id, root_task_id, workspace_id, tasks, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.rootTaskId,
        run.workspaceId,
        JSON.stringify(run.tasks),
        run.status,
        run.createdAt,
        run.completedAt ?? null,
      );

    return run;
  }

  update(
    id: string,
    updates: Partial<Pick<OrchestrationRun, "tasks" | "status" | "completedAt">>,
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.tasks !== undefined) {
      fields.push("tasks = ?");
      values.push(JSON.stringify(updates.tasks));
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt);
    }

    if (fields.length === 0) return;
    values.push(id);
    this.db
      .prepare(`UPDATE orchestration_runs SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  findById(id: string): OrchestrationRun | undefined {
    const row = this.db.prepare("SELECT * FROM orchestration_runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    return row ? rowToRun(row) : undefined;
  }

  findByRootTaskId(rootTaskId: string): OrchestrationRun | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM orchestration_runs WHERE root_task_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(rootTaskId) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  findRunning(): OrchestrationRun[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestration_runs WHERE status = 'running' ORDER BY created_at DESC")
      .all() as RunRow[];
    return rows.map(rowToRun);
  }

  list(workspaceId: string, limit = 50): OrchestrationRun[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM orchestration_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(workspaceId, limit) as RunRow[];
    return rows.map(rowToRun);
  }
}
