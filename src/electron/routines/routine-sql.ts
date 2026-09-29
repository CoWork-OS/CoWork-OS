import type Database from "better-sqlite3";
import { RoutineWorkflowStore } from "./workflow/repository";

// oxlint-disable-next-line typescript/no-explicit-any -- rows are mapped by RoutineService
type Row = any;

const ACTIVE_RUN_FILTER = `status IN ('queued', 'running')
   OR (status = 'failed' AND backing_task_id IS NOT NULL AND error_summary LIKE 'Timed out after %')`;

export interface RoutineRowInput {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  workspaceId: string;
  prompt: string;
  connectorsJson: string;
  triggersJson: string;
  definitionJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRunRowInput {
  /** Used when no existing run matches and the caller gave no id. */
  newId: string;
  id?: string;
  runKey?: string;
  dedupeKey?: string | null;
  createdAt?: number;
  now: number;
  routineId: string;
  triggerId: string;
  triggerType: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  sourceEventSummary?: string;
  backingTaskId?: string;
  backingManagedSessionId?: string;
  workflowRunId?: string;
  outputStatus: string;
  errorSummary?: string;
  artifactsSummary?: string;
}

/**
 * The routine service's SQL (async SQLite migration plan, DB6): routine rows and routine
 * run rows. `RoutineService` maps the raw rows; as services-domain units these methods
 * run in the database worker when the domain is routed there. Schema setup stays in
 * `RoutineService.ensureSchema` on the host.
 */
export class RoutineStore {
  constructor(private readonly db: Database.Database) {}

  listRoutineRows(): Row[] {
    return this.db.prepare("SELECT * FROM automation_routines ORDER BY updated_at DESC").all();
  }

  getRoutineRow(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM automation_routines WHERE id = ?").get(id);
  }

  persistRoutine(row: RoutineRowInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO automation_routines
         (id, name, description, enabled, workspace_id, prompt, connectors_json, triggers_json, definition_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.description,
        row.enabled,
        row.workspaceId,
        row.prompt,
        row.connectorsJson,
        row.triggersJson,
        row.definitionJson,
        row.createdAt,
        row.updatedAt,
      );
  }

  /** Delete a routine with its runs and workflow data, in one transaction as a unit. */
  deleteRoutine(id: string): void {
    this.db.prepare("DELETE FROM automation_routines WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM routine_runs WHERE routine_id = ?").run(id);
    new RoutineWorkflowStore(this.db, () => Date.now(), { ensureSchema: false }).deleteRoutineData(
      id,
    );
  }

  listRunRows(routineId: string | null, limit: number): Row[] {
    return routineId
      ? this.db
          .prepare(
            `SELECT * FROM routine_runs
             WHERE routine_id = ?
             ORDER BY started_at DESC, created_at DESC
             LIMIT ?`,
          )
          .all(routineId, limit)
      : this.db
          .prepare(
            `SELECT * FROM routine_runs
             ORDER BY started_at DESC, created_at DESC
             LIMIT ?`,
          )
          .all(limit);
  }

  runRowsForTask(taskId: string): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM routine_runs
         WHERE backing_task_id = ?
           AND (
             status IN ('queued', 'running')
             OR (status = 'failed' AND error_summary LIKE 'Timed out after %')
           )
         ORDER BY updated_at DESC`,
      )
      .all(taskId);
  }

  staleTimeoutRunRows(): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM routine_runs
         WHERE backing_task_id IS NOT NULL
           AND error_summary LIKE 'Timed out after %'
           AND status IN ('failed', 'running')
         ORDER BY updated_at DESC`,
      )
      .all();
  }

  activeRunRows(routineId: string | null): Row[] {
    return routineId
      ? this.db
          .prepare(
            `SELECT * FROM routine_runs
             WHERE routine_id = ?
               AND (${ACTIVE_RUN_FILTER})
             ORDER BY updated_at DESC`,
          )
          .all(routineId)
      : this.db
          .prepare(
            `SELECT * FROM routine_runs
             WHERE ${ACTIVE_RUN_FILTER}
             ORDER BY updated_at DESC`,
          )
          .all();
  }

  runRowByWorkflowRun(workflowRunId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT * FROM routine_runs WHERE workflow_run_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(workflowRunId);
  }

  runRowByKey(runKey: string): Row | undefined {
    return this.db
      .prepare("SELECT * FROM routine_runs WHERE run_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(runKey);
  }

  allRunRows(): Row[] {
    return this.db.prepare("SELECT * FROM routine_runs").all();
  }

  /**
   * Insert or replace a run, matching an existing one by dedupe key, run key or id. As a
   * unit the lookup and the write share one transaction.
   */
  upsertRunRow(input: RoutineRunRowInput): { id: string; createdAt: number } {
    const existing =
      (input.dedupeKey
        ? this.db
            .prepare(
              "SELECT id, created_at FROM routine_runs WHERE dedupe_key = ? ORDER BY updated_at DESC LIMIT 1",
            )
            .get(input.dedupeKey)
        : undefined) ||
      (input.runKey
        ? this.db
            .prepare(
              "SELECT id, created_at FROM routine_runs WHERE run_key = ? ORDER BY updated_at DESC LIMIT 1",
            )
            .get(input.runKey)
        : undefined) ||
      (input.id
        ? this.db.prepare("SELECT id, created_at FROM routine_runs WHERE id = ?").get(input.id)
        : undefined);
    const found = existing as { id: string; created_at: number } | undefined;
    const id = found?.id || input.id || input.newId;
    const createdAt = (found ? Number(found.created_at) : 0) || input.createdAt || input.now;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO routine_runs
         (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at, source_event_summary,
          backing_task_id, backing_managed_session_id, workflow_run_id, output_status, error_summary, artifacts_summary,
          run_key, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.routineId,
        input.triggerId,
        input.triggerType,
        input.status,
        input.startedAt,
        input.finishedAt || null,
        input.sourceEventSummary || null,
        input.backingTaskId || null,
        input.backingManagedSessionId || null,
        input.workflowRunId || null,
        input.outputStatus,
        input.errorSummary || null,
        input.artifactsSummary || null,
        input.runKey || null,
        input.dedupeKey || null,
        createdAt,
        input.now,
      );
    return { id, createdAt };
  }

  /** Apply a dedupe-key reconciliation plan in one transaction as a unit. */
  applyRunDedupePlan(plan: {
    clear: string[];
    set: Array<[dedupeKey: string, runId: string]>;
    remove: string[];
  }): void {
    const clearKey = this.db.prepare("UPDATE routine_runs SET dedupe_key = NULL WHERE id = ?");
    const updateKey = this.db.prepare("UPDATE routine_runs SET dedupe_key = ? WHERE id = ?");
    const deleteRun = this.db.prepare("DELETE FROM routine_runs WHERE id = ?");
    // Duplicates go first, so setting a key never meets the unique dedupe-key index.
    for (const id of plan.remove) deleteRun.run(id);
    for (const id of plan.clear) clearKey.run(id);
    for (const [dedupeKey, id] of plan.set) updateKey.run(dedupeKey, id);
  }

  /** A workflow starter's polling cursor JSON (Google Workspace starters). */
  getStarterCursorJson(routineId: string, starterNodeId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT cursor_json FROM routine_starter_cursors WHERE routine_id = ? AND starter_node_id = ?",
      )
      .get(routineId, starterNodeId) as { cursor_json?: string } | undefined;
    return row?.cursor_json;
  }

  setStarterCursorJson(
    routineId: string,
    starterNodeId: string,
    cursorJson: string,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO routine_starter_cursors
         (routine_id, starter_node_id, cursor_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(routineId, starterNodeId, cursorJson, now);
  }
}
