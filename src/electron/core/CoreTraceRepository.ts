import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  CoreTrace,
  CoreTraceEvent,
  ListCoreTracesRequest,
} from "../../shared/types";

type Any = any;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class CoreTraceRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    input: Omit<CoreTrace, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): CoreTrace {
    const trace: CoreTrace = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO core_traces (
          id, profile_id, workspace_id, target_key, source_surface, trace_kind, status,
          task_id, heartbeat_run_id, subconscious_run_id, summary, error, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.id,
        trace.profileId,
        trace.workspaceId || null,
        trace.targetKey || null,
        trace.sourceSurface,
        trace.traceKind,
        trace.status,
        trace.taskId || null,
        trace.heartbeatRunId || null,
        trace.subconsciousRunId || null,
        trace.summary || null,
        trace.error || null,
        trace.startedAt,
        trace.completedAt || null,
        trace.createdAt,
      );
    return trace;
  }

  update(id: string, updates: Partial<CoreTrace>): CoreTrace | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    const mapped: Record<string, string> = {
      profileId: "profile_id",
      workspaceId: "workspace_id",
      targetKey: "target_key",
      sourceSurface: "source_surface",
      traceKind: "trace_kind",
      status: "status",
      taskId: "task_id",
      heartbeatRunId: "heartbeat_run_id",
      subconsciousRunId: "subconscious_run_id",
      summary: "summary",
      error: "error",
      startedAt: "started_at",
      completedAt: "completed_at",
      createdAt: "created_at",
    };
    for (const [key, column] of Object.entries(mapped)) {
      if (!(key in updates)) continue;
      const value = (updates as Any)[key];
      fields.push(`${column} = ?`);
      values.push(value ?? null);
    }
    if (!fields.length) return existing;
    values.push(id);
    this.db.prepare(`UPDATE core_traces SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  findById(id: string): CoreTrace | undefined {
    const row = this.db.prepare("SELECT * FROM core_traces WHERE id = ?").get(id) as Any;
    return row ? this.mapTrace(row) : undefined;
  }

  list(request: ListCoreTracesRequest = {}): CoreTrace[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (request.profileId) {
      conditions.push("profile_id = ?");
      values.push(request.profileId);
    }
    if (request.workspaceId) {
      conditions.push("workspace_id = ?");
      values.push(request.workspaceId);
    }
    if (request.targetKey) {
      conditions.push("target_key = ?");
      values.push(request.targetKey);
    }
    if (request.traceKind) {
      conditions.push("trace_kind = ?");
      values.push(request.traceKind);
    }
    if (request.status) {
      conditions.push("status = ?");
      values.push(request.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, request.limit ?? 100));
    const rows = this.db
      .prepare(`SELECT * FROM core_traces ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit) as Any[];
    return rows.map((row) => this.mapTrace(row));
  }

  listByProfile(profileId: string, limit = 50): CoreTrace[] {
    return this.list({ profileId, limit });
  }

  findOpenTrace(params: {
    profileId: string;
    sourceSurface: CoreTrace["sourceSurface"];
    targetKey?: string;
    heartbeatRunId?: string;
    subconsciousRunId?: string;
  }): CoreTrace | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM core_traces
         WHERE profile_id = ?
           AND source_surface = ?
           AND status = 'running'
           AND COALESCE(target_key, '') = COALESCE(?, '')
           AND COALESCE(heartbeat_run_id, '') = COALESCE(?, '')
           AND COALESCE(subconscious_run_id, '') = COALESCE(?, '')
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(
        params.profileId,
        params.sourceSurface,
        params.targetKey || null,
        params.heartbeatRunId || null,
        params.subconsciousRunId || null,
      ) as Any;
    return row ? this.mapTrace(row) : undefined;
  }

  appendEvent(
    input: Omit<CoreTraceEvent, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): CoreTraceEvent {
    const event: CoreTraceEvent = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO core_trace_events (
          id, trace_id, phase, event_type, summary, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.traceId,
        event.phase,
        event.eventType,
        event.summary,
        event.details ? JSON.stringify(event.details) : null,
        event.createdAt,
      );
    return event;
  }

  listEvents(traceId: string): CoreTraceEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM core_trace_events WHERE trace_id = ? ORDER BY created_at ASC")
      .all(traceId) as Any[];
    return rows.map((row) => ({
      id: String(row.id),
      traceId: String(row.trace_id),
      phase: row.phase,
      eventType: String(row.event_type),
      summary: String(row.summary),
      details: parseJson<Record<string, unknown> | undefined>(row.details_json, undefined),
      createdAt: Number(row.created_at),
    }));
  }

  private mapTrace(row: Any): CoreTrace {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      workspaceId: row.workspace_id || undefined,
      targetKey: row.target_key || undefined,
      sourceSurface: row.source_surface,
      traceKind: row.trace_kind,
      status: row.status,
      taskId: row.task_id || undefined,
      heartbeatRunId: row.heartbeat_run_id || undefined,
      subconsciousRunId: row.subconscious_run_id || undefined,
      summary: row.summary || undefined,
      error: row.error || undefined,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
      createdAt: Number(row.created_at),
    };
  }
}
