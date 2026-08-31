import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import {
  HeartbeatDispatchKind,
  HeartbeatRun,
  HeartbeatRunEvent,
  HeartbeatRunType,
} from "../../shared/types";

interface CreateHeartbeatRunInput {
  issueId?: string;
  taskId?: string;
  agentRoleId?: string;
  workspaceId?: string;
  runType: HeartbeatRunType;
  dispatchKind?: HeartbeatDispatchKind;
  reason?: string;
  status?: HeartbeatRun["status"];
  evidenceRefs?: string[];
  costStats?: Record<string, unknown>;
  resumedFromRunId?: string;
}

interface FinishHeartbeatRunInput {
  status: HeartbeatRun["status"];
  summary?: string;
  error?: string;
  taskId?: string;
  costStats?: Record<string, unknown>;
  evidenceRefs?: string[];
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class HeartbeatRunRepository {
  private memoryRuns = new Map<string, HeartbeatRun>();
  private memoryEvents = new Map<string, HeartbeatRunEvent[]>();

  constructor(private db?: Database.Database) {}

  create(input: CreateHeartbeatRunInput): HeartbeatRun {
    const now = Date.now();
    const run: HeartbeatRun = {
      id: randomUUID(),
      issueId: input.issueId,
      taskId: input.taskId,
      agentRoleId: input.agentRoleId,
      workspaceId: input.workspaceId,
      runType: input.runType,
      dispatchKind: input.dispatchKind,
      reason: input.reason,
      status: input.status || "running",
      evidenceRefs: input.evidenceRefs,
      costStats: input.costStats,
      resumedFromRunId: input.resumedFromRunId,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };

    if (!this.db) {
      this.memoryRuns.set(run.id, run);
      return run;
    }

    this.db
      .prepare(
        `INSERT INTO heartbeat_runs (
          id, issue_id, task_id, agent_role_id, workspace_id, run_type, dispatch_kind, reason,
          status, summary, error, cost_stats, evidence_refs, resumed_from_run_id,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        run.id,
        run.issueId || null,
        run.taskId || null,
        run.agentRoleId || null,
        run.workspaceId || null,
        run.runType || "dispatch",
        run.dispatchKind || null,
        run.reason || null,
        run.status,
        run.costStats ? JSON.stringify(run.costStats) : null,
        run.evidenceRefs ? JSON.stringify(run.evidenceRefs) : null,
        run.resumedFromRunId || null,
        run.createdAt,
        run.updatedAt,
        run.startedAt || now,
      );
    return run;
  }

  finish(runId: string, input: FinishHeartbeatRunInput): HeartbeatRun | undefined {
    const now = Date.now();
    if (!this.db) {
      const existing = this.memoryRuns.get(runId);
      if (!existing) return undefined;
      const updated: HeartbeatRun = {
        ...existing,
        status: input.status,
        summary: input.summary,
        error: input.error,
        taskId: input.taskId || existing.taskId,
        completedAt: now,
        updatedAt: now,
        costStats: input.costStats || existing.costStats,
        evidenceRefs: input.evidenceRefs || existing.evidenceRefs,
      };
      this.memoryRuns.set(runId, updated);
      return updated;
    }

    this.db
      .prepare(
        `UPDATE heartbeat_runs
         SET status = ?, summary = ?, error = ?, task_id = COALESCE(?, task_id),
             cost_stats = COALESCE(?, cost_stats), evidence_refs = COALESCE(?, evidence_refs),
             updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.summary || null,
        input.error || null,
        input.taskId || null,
        input.costStats ? JSON.stringify(input.costStats) : null,
        input.evidenceRefs ? JSON.stringify(input.evidenceRefs) : null,
        now,
        now,
        runId,
      );
    return this.get(runId);
  }

  attachTask(runId: string, taskId: string): void {
    if (!this.db) {
      const existing = this.memoryRuns.get(runId);
      if (existing) {
        this.memoryRuns.set(runId, { ...existing, taskId, updatedAt: Date.now() });
      }
      return;
    }
    this.db
      .prepare("UPDATE heartbeat_runs SET task_id = ?, updated_at = ? WHERE id = ?")
      .run(taskId, Date.now(), runId);
  }

  recordEvent(runId: string, type: string, payload: Record<string, unknown>): void {
    const event: HeartbeatRunEvent = {
      id: randomUUID(),
      runId,
      timestamp: Date.now(),
      type,
      payload,
    };
    if (!this.db) {
      const list = this.memoryEvents.get(runId) || [];
      list.push(event);
      this.memoryEvents.set(runId, list);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO heartbeat_run_events (id, run_id, timestamp, type, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .run(event.id, event.runId, event.timestamp, event.type, JSON.stringify(event.payload));
  }

  reconcileInterruptedAgentRuns(
    errorMessage = "Heartbeat service restarted before run completed",
  ): number {
    const now = Date.now();
    if (!this.db) {
      let updated = 0;
      for (const [runId, run] of this.memoryRuns.entries()) {
        const isAgentHeartbeatRun =
          run.status === "running" &&
          Boolean(run.agentRoleId) &&
          (run.runType === "pulse" || (run.runType === "dispatch" && !run.issueId));
        if (!isAgentHeartbeatRun) continue;
        this.memoryRuns.set(runId, {
          ...run,
          status: "failed",
          error: errorMessage,
          updatedAt: now,
          completedAt: now,
        });
        updated += 1;
      }
      return updated;
    }

    const result = this.db
      .prepare(
        `UPDATE heartbeat_runs
         SET status = 'failed',
             error = COALESCE(error, ?),
             updated_at = ?,
             completed_at = ?
         WHERE status = 'running'
           AND agent_role_id IS NOT NULL
           AND (run_type = 'pulse' OR (run_type = 'dispatch' AND issue_id IS NULL))`,
      )
      .run(errorMessage, now, now);
    return result.changes;
  }

  get(runId: string): HeartbeatRun | undefined {
    if (!this.db) return this.memoryRuns.get(runId);
    const row = this.db.prepare("SELECT * FROM heartbeat_runs WHERE id = ?").get(runId) as Any;
    return row ? this.mapRun(row) : undefined;
  }

  listRecentDispatches(agentRoleId: string, sinceMs: number): HeartbeatRun[] {
    if (!this.db) {
      return Array.from(this.memoryRuns.values()).filter(
        (run) =>
          run.agentRoleId === agentRoleId && run.runType === "dispatch" && run.createdAt >= sinceMs,
      );
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM heartbeat_runs
         WHERE agent_role_id = ? AND run_type = 'dispatch' AND created_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(agentRoleId, sinceMs) as Any[];
    return rows.map((row) => this.mapRun(row));
  }

  getLatestRun(agentRoleId: string, runType: HeartbeatRunType): HeartbeatRun | undefined {
    if (!this.db) {
      return Array.from(this.memoryRuns.values())
        .filter((run) => run.agentRoleId === agentRoleId && run.runType === runType)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    }
    const row = this.db
      .prepare(
        `SELECT * FROM heartbeat_runs
         WHERE agent_role_id = ? AND run_type = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(agentRoleId, runType) as Any;
    return row ? this.mapRun(row) : undefined;
  }

  hasInFlightDispatch(agentRoleId: string, workspaceId?: string): boolean {
    if (!this.db) {
      return Array.from(this.memoryRuns.values()).some(
        (run) =>
          run.agentRoleId === agentRoleId &&
          run.runType === "dispatch" &&
          run.status === "running" &&
          (!workspaceId || run.workspaceId === workspaceId),
      );
    }
    const row = this.db
      .prepare(
        `SELECT id FROM heartbeat_runs
         WHERE agent_role_id = ? AND run_type = 'dispatch' AND status = 'running'
           AND (? IS NULL OR workspace_id = ?)
         LIMIT 1`,
      )
      .get(agentRoleId, workspaceId || null, workspaceId || null) as Any;
    return Boolean(row?.id);
  }

  private mapRun(row: Any): HeartbeatRun {
    return {
      id: row.id,
      issueId: row.issue_id || undefined,
      taskId: row.task_id || undefined,
      agentRoleId: row.agent_role_id || undefined,
      workspaceId: row.workspace_id || undefined,
      runType: row.run_type || undefined,
      dispatchKind: row.dispatch_kind || undefined,
      reason: row.reason || undefined,
      status: row.status,
      summary: row.summary || undefined,
      error: row.error || undefined,
      costStats: parseJson<Record<string, unknown> | undefined>(row.cost_stats, undefined),
      evidenceRefs: parseJson<string[] | undefined>(row.evidence_refs, undefined),
      resumedFromRunId: row.resumed_from_run_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
    };
  }
}
