import { randomUUID } from "crypto";
import type {
  RoutineWorkflowDefinition,
  RoutineWorkflowEventEnvelope,
  RoutineWorkflowRunRecord,
  RoutineWorkflowStepRecord,
  RoutineWorkflowStepStatus,
} from "../../../shared/routine-workflow";

export type WorkflowVersionStatus = "draft" | "active" | "archived";

export interface WorkflowVersionRecord {
  id: string;
  routineId: string;
  versionNumber: number;
  status: WorkflowVersionStatus;
  definition: RoutineWorkflowDefinition;
  createdAt: number;
  updatedAt: number;
  activatedAt?: number;
}

export type WorkflowEventStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";

export interface WorkflowEventRecord extends Required<
  Omit<RoutineWorkflowEventEnvelope, "summary">
> {
  summary?: string;
  status: WorkflowEventStatus;
  attemptCount: number;
  runId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export class RoutineWorkflowRepository {
  constructor(
    private readonly db: Any,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.ensureSchema();
  }

  createVersion(
    routineId: string,
    definition: RoutineWorkflowDefinition,
    status: WorkflowVersionStatus = "draft",
  ): WorkflowVersionRecord {
    const now = this.now();
    const versionNumber = Number(
      this.db
        .prepare(
          "SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM routine_workflow_versions WHERE routine_id = ?",
        )
        .get(routineId)?.next_version || 1,
    );
    const record: WorkflowVersionRecord = {
      id: randomUUID(),
      routineId,
      versionNumber,
      status,
      definition: structuredClone(definition),
      createdAt: now,
      updatedAt: now,
      activatedAt: status === "active" ? now : undefined,
    };
    const insert = () => {
      if (status === "active") {
        this.db
          .prepare(
            "UPDATE routine_workflow_versions SET status = 'archived', updated_at = ? WHERE routine_id = ? AND status = 'active'",
          )
          .run(now, routineId);
      }
      this.db
        .prepare(
          `INSERT INTO routine_workflow_versions
           (id, routine_id, version_number, status, definition_json, created_at, updated_at, activated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          routineId,
          versionNumber,
          status,
          JSON.stringify(definition),
          now,
          now,
          record.activatedAt || null,
        );
    };
    this.db.transaction(insert)();
    return record;
  }

  getVersion(id: string): WorkflowVersionRecord | null {
    const row = this.db.prepare("SELECT * FROM routine_workflow_versions WHERE id = ?").get(id);
    return row ? this.mapVersion(row) : null;
  }

  getActiveVersion(routineId: string): WorkflowVersionRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM routine_workflow_versions WHERE routine_id = ? AND status = 'active' ORDER BY version_number DESC LIMIT 1",
      )
      .get(routineId);
    return row ? this.mapVersion(row) : null;
  }

  listVersions(routineId: string): WorkflowVersionRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM routine_workflow_versions WHERE routine_id = ? ORDER BY version_number DESC",
        )
        .all(routineId) as Any[]
    ).map((row) => this.mapVersion(row));
  }

  activateVersion(routineId: string, versionId: string): WorkflowVersionRecord | null {
    const existing = this.getVersion(versionId);
    if (!existing || existing.routineId !== routineId) return null;
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE routine_workflow_versions SET status = 'archived', updated_at = ? WHERE routine_id = ? AND status = 'active'",
        )
        .run(now, routineId);
      this.db
        .prepare(
          "UPDATE routine_workflow_versions SET status = 'active', updated_at = ?, activated_at = ? WHERE id = ?",
        )
        .run(now, now, versionId);
    })();
    return this.getVersion(versionId);
  }

  createRun(input: {
    routineId: string;
    workflowVersionId: string;
    triggerNodeId: string;
    eventId?: string;
    idempotencyKey?: string;
    context: Record<string, unknown>;
  }): RoutineWorkflowRunRecord {
    if (input.idempotencyKey) {
      const existing = this.findRunByIdempotencyKey(input.routineId, input.idempotencyKey);
      if (existing) return existing;
    }
    const now = this.now();
    const run: RoutineWorkflowRunRecord = {
      id: randomUUID(),
      routineId: input.routineId,
      workflowVersionId: input.workflowVersionId,
      status: "queued",
      triggerNodeId: input.triggerNodeId,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      context: structuredClone(input.context),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO routine_workflow_runs
         (id, routine_id, workflow_version_id, status, trigger_node_id, event_id, idempotency_key,
          context_json, output_json, error, started_at, finished_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        run.id,
        run.routineId,
        run.workflowVersionId,
        run.status,
        run.triggerNodeId,
        run.eventId || null,
        run.idempotencyKey || null,
        JSON.stringify(run.context),
        now,
        now,
      );
    return run;
  }

  getRun(id: string): RoutineWorkflowRunRecord | null {
    const row = this.db.prepare("SELECT * FROM routine_workflow_runs WHERE id = ?").get(id);
    return row ? this.mapRun(row) : null;
  }

  listRuns(routineId?: string, limit = 50): RoutineWorkflowRunRecord[] {
    const rows = routineId
      ? this.db
          .prepare(
            "SELECT * FROM routine_workflow_runs WHERE routine_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(routineId, limit)
      : this.db
          .prepare("SELECT * FROM routine_workflow_runs ORDER BY created_at DESC LIMIT ?")
          .all(limit);
    return (rows as Any[]).map((row) => this.mapRun(row));
  }

  listRecoverableRuns(): RoutineWorkflowRunRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM routine_workflow_runs WHERE status IN ('queued', 'running') ORDER BY created_at ASC",
        )
        .all() as Any[]
    ).map((row) => this.mapRun(row));
  }

  requeueProcessingEvents(): number {
    const result = this.db
      .prepare(
        `UPDATE routine_event_inbox
         SET status = 'pending', available_at = ?,
             error = COALESCE(error, 'Recovered after application restart.'), updated_at = ?
         WHERE status = 'processing'`,
      )
      .run(this.now(), this.now());
    return Number(result.changes || 0);
  }

  pruneExpiredData(
    retentionDaysForVersion: (workflowVersionId: string) => number,
    defaultRetentionDays = 30,
  ): { runsSanitized: number; eventsDeleted: number; samplesDeleted: number } {
    const now = this.now();
    let runsSanitized = 0;
    const terminalRuns = this.db
      .prepare(
        `SELECT id, workflow_version_id, COALESCE(finished_at, updated_at) AS retention_at
         FROM routine_workflow_runs
         WHERE status IN ('completed', 'partial_success', 'failed', 'cancelled')`,
      )
      .all() as Array<{ id: string; workflow_version_id: string; retention_at: number }>;
    const sanitizeRun = this.db.prepare(
      `UPDATE routine_workflow_runs
       SET context_json = '{}', output_json = NULL, updated_at = ?
       WHERE id = ? AND (context_json != '{}' OR output_json IS NOT NULL)`,
    );
    const deleteSteps = this.db.prepare("DELETE FROM routine_run_steps WHERE run_id = ?");
    this.db.transaction(() => {
      for (const run of terminalRuns) {
        const configuredDays = retentionDaysForVersion(String(run.workflow_version_id));
        const retentionDays = clampRetentionDays(configuredDays, defaultRetentionDays);
        if (Number(run.retention_at) > now - retentionDays * 86_400_000) continue;
        deleteSteps.run(run.id);
        const result = sanitizeRun.run(now, run.id);
        runsSanitized += Number(result.changes || 0);
      }
    })();

    const defaultCutoff = now - clampRetentionDays(defaultRetentionDays, 30) * 86_400_000;
    const eventResult = this.db
      .prepare(
        `DELETE FROM routine_event_inbox
         WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?`,
      )
      .run(defaultCutoff);
    const sampleResult = this.db
      .prepare("DELETE FROM routine_event_samples WHERE created_at < ?")
      .run(defaultCutoff);
    return {
      runsSanitized,
      eventsDeleted: Number(eventResult.changes || 0),
      samplesDeleted: Number(sampleResult.changes || 0),
    };
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        RoutineWorkflowRunRecord,
        "status" | "context" | "output" | "error" | "startedAt" | "finishedAt"
      >
    >,
  ): RoutineWorkflowRunRecord | null {
    const existing = this.getRun(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: this.now() };
    this.db
      .prepare(
        `UPDATE routine_workflow_runs
         SET status = ?, context_json = ?, output_json = ?, error = ?, started_at = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.status,
        JSON.stringify(updated.context || {}),
        updated.output ? JSON.stringify(updated.output) : null,
        updated.error || null,
        updated.startedAt || null,
        updated.finishedAt || null,
        updated.updatedAt,
        id,
      );
    return updated;
  }

  findRunByIdempotencyKey(
    routineId: string,
    idempotencyKey: string,
  ): RoutineWorkflowRunRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM routine_workflow_runs WHERE routine_id = ? AND idempotency_key = ? LIMIT 1",
      )
      .get(routineId, idempotencyKey);
    return row ? this.mapRun(row) : null;
  }

  initializeSteps(
    runId: string,
    routineId: string,
    nodes: Array<{ id: string; operation: string }>,
  ): void {
    const now = this.now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO routine_run_steps
       (id, run_id, routine_id, node_id, operation, status, attempt_count, input_json, output_json,
        error, approval_id, started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const node of nodes)
        insert.run(randomUUID(), runId, routineId, node.id, node.operation, now, now);
    })();
  }

  listSteps(runId: string): RoutineWorkflowStepRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM routine_run_steps WHERE run_id = ? ORDER BY created_at ASC")
        .all(runId) as Any[]
    ).map((row) => this.mapStep(row));
  }

  getStep(id: string): RoutineWorkflowStepRecord | null {
    const row = this.db.prepare("SELECT * FROM routine_run_steps WHERE id = ?").get(id);
    return row ? this.mapStep(row) : null;
  }

  findStep(runId: string, nodeId: string): RoutineWorkflowStepRecord | null {
    const row = this.db
      .prepare("SELECT * FROM routine_run_steps WHERE run_id = ? AND node_id = ? LIMIT 1")
      .get(runId, nodeId);
    return row ? this.mapStep(row) : null;
  }

  updateStep(
    id: string,
    patch: Partial<
      Pick<
        RoutineWorkflowStepRecord,
        | "status"
        | "attemptCount"
        | "input"
        | "output"
        | "error"
        | "approvalId"
        | "startedAt"
        | "finishedAt"
      >
    >,
  ): RoutineWorkflowStepRecord | null {
    const existing = this.getStep(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: this.now() };
    this.db
      .prepare(
        `UPDATE routine_run_steps
         SET status = ?, attempt_count = ?, input_json = ?, output_json = ?, error = ?, approval_id = ?,
             started_at = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.status,
        updated.attemptCount,
        updated.input ? JSON.stringify(updated.input) : null,
        updated.output ? JSON.stringify(updated.output) : null,
        updated.error || null,
        updated.approvalId || null,
        updated.startedAt || null,
        updated.finishedAt || null,
        updated.updatedAt,
        id,
      );
    return updated;
  }

  enqueueEvent(envelope: RoutineWorkflowEventEnvelope): WorkflowEventRecord {
    const existing = this.db
      .prepare(
        "SELECT * FROM routine_event_inbox WHERE routine_id = ? AND idempotency_key = ? LIMIT 1",
      )
      .get(envelope.routineId, envelope.idempotencyKey);
    if (existing) return this.mapEvent(existing);
    const now = this.now();
    const record: WorkflowEventRecord = {
      id: envelope.id || randomUUID(),
      routineId: envelope.routineId,
      triggerNodeId: envelope.triggerNodeId,
      source: envelope.source,
      idempotencyKey: envelope.idempotencyKey,
      receivedAt: envelope.receivedAt || now,
      availableAt: envelope.availableAt || now,
      payload: structuredClone(envelope.payload),
      summary: envelope.summary,
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO routine_event_inbox
         (id, routine_id, trigger_node_id, source, idempotency_key, status, attempt_count, received_at,
          available_at, payload_json, summary, run_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        record.id,
        record.routineId,
        record.triggerNodeId,
        record.source,
        record.idempotencyKey,
        record.receivedAt,
        record.availableAt,
        JSON.stringify(record.payload),
        record.summary || null,
        now,
        now,
      );
    this.recordEventSample(record.source, record.payload, record.summary);
    return record;
  }

  claimNextEvent(): WorkflowEventRecord | null {
    const now = this.now();
    let claimed: WorkflowEventRecord | null = null;
    this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM routine_event_inbox WHERE status = 'pending' AND available_at <= ? ORDER BY received_at ASC LIMIT 1",
        )
        .get(now);
      if (!row) return;
      this.db
        .prepare(
          "UPDATE routine_event_inbox SET status = 'processing', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(now, row.id);
      const refreshed = this.db
        .prepare("SELECT * FROM routine_event_inbox WHERE id = ?")
        .get(row.id);
      claimed = refreshed ? this.mapEvent(refreshed) : null;
    })();
    return claimed;
  }

  updateEvent(
    id: string,
    patch: { status: WorkflowEventStatus; runId?: string; error?: string; availableAt?: number },
  ): WorkflowEventRecord | null {
    const existing = this.db.prepare("SELECT * FROM routine_event_inbox WHERE id = ?").get(id);
    if (!existing) return null;
    const current = this.mapEvent(existing);
    this.db
      .prepare(
        "UPDATE routine_event_inbox SET status = ?, run_id = ?, error = ?, available_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.status,
        patch.runId ?? current.runId ?? null,
        patch.error || null,
        patch.availableAt ?? current.availableAt,
        this.now(),
        id,
      );
    const updated = this.db.prepare("SELECT * FROM routine_event_inbox WHERE id = ?").get(id);
    return updated ? this.mapEvent(updated) : null;
  }

  listEvents(routineId?: string, limit = 50): WorkflowEventRecord[] {
    const rows = routineId
      ? this.db
          .prepare(
            "SELECT * FROM routine_event_inbox WHERE routine_id = ? ORDER BY received_at DESC LIMIT ?",
          )
          .all(routineId, limit)
      : this.db
          .prepare("SELECT * FROM routine_event_inbox ORDER BY received_at DESC LIMIT ?")
          .all(limit);
    return (rows as Any[]).map((row) => this.mapEvent(row));
  }

  recordEventSample(source: string, payload: Record<string, unknown>, summary?: string): void {
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO routine_event_samples (id, source, payload_json, summary, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), source, JSON.stringify(payload), summary || null, now);
    this.db
      .prepare(
        "DELETE FROM routine_event_samples WHERE id IN (SELECT id FROM routine_event_samples WHERE source = ? ORDER BY created_at DESC LIMIT -1 OFFSET 20)",
      )
      .run(source);
  }

  listEventSamples(
    source?: string,
    limit = 20,
  ): Array<{
    id: string;
    source: string;
    payload: Record<string, unknown>;
    summary?: string;
    createdAt: number;
  }> {
    const rows = source
      ? this.db
          .prepare(
            "SELECT * FROM routine_event_samples WHERE source = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(source, limit)
      : this.db
          .prepare("SELECT * FROM routine_event_samples ORDER BY created_at DESC LIMIT ?")
          .all(limit);
    return (rows as Any[]).map((row) => ({
      id: String(row.id),
      source: String(row.source),
      payload: parseJson(row.payload_json, {}),
      summary: row.summary ? String(row.summary) : undefined,
      createdAt: Number(row.created_at),
    }));
  }

  deleteRoutineData(routineId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM routine_event_inbox WHERE routine_id = ?").run(routineId);
      this.db.prepare("DELETE FROM routine_run_steps WHERE routine_id = ?").run(routineId);
      this.db.prepare("DELETE FROM routine_workflow_runs WHERE routine_id = ?").run(routineId);
      this.db.prepare("DELETE FROM routine_workflow_versions WHERE routine_id = ?").run(routineId);
    })();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routine_workflow_versions (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        activated_at INTEGER,
        UNIQUE(routine_id, version_number)
      );
      CREATE INDEX IF NOT EXISTS idx_routine_workflow_versions_active
      ON routine_workflow_versions(routine_id, status, version_number DESC);

      CREATE TABLE IF NOT EXISTS routine_workflow_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        workflow_version_id TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_node_id TEXT NOT NULL,
        event_id TEXT,
        idempotency_key TEXT,
        context_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_workflow_runs_idempotency
      ON routine_workflow_runs(routine_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_routine_workflow_runs_routine
      ON routine_workflow_runs(routine_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS routine_run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        routine_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        input_json TEXT,
        output_json TEXT,
        error TEXT,
        approval_id TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(run_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_routine_run_steps_run ON routine_run_steps(run_id, created_at);

      CREATE TABLE IF NOT EXISTS routine_event_inbox (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        trigger_node_id TEXT NOT NULL,
        source TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        received_at INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        summary TEXT,
        run_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(routine_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_routine_event_inbox_pending
      ON routine_event_inbox(status, available_at, received_at);

      CREATE TABLE IF NOT EXISTS routine_event_samples (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        summary TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routine_event_samples_source
      ON routine_event_samples(source, created_at DESC);
    `);
  }

  private mapVersion(row: Any): WorkflowVersionRecord {
    return {
      id: String(row.id),
      routineId: String(row.routine_id),
      versionNumber: Number(row.version_number),
      status: row.status as WorkflowVersionStatus,
      definition: parseJson<RoutineWorkflowDefinition>(row.definition_json, {
        version: 1,
        starterNodeId: "",
        nodes: [],
        edges: [],
      }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      activatedAt: row.activated_at ? Number(row.activated_at) : undefined,
    };
  }

  private mapRun(row: Any): RoutineWorkflowRunRecord {
    return {
      id: String(row.id),
      routineId: String(row.routine_id),
      workflowVersionId: String(row.workflow_version_id),
      status: row.status,
      triggerNodeId: String(row.trigger_node_id),
      eventId: row.event_id ? String(row.event_id) : undefined,
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
      context: parseJson(row.context_json, {}),
      output: row.output_json ? parseJson(row.output_json, {}) : undefined,
      error: row.error ? String(row.error) : undefined,
      startedAt: row.started_at ? Number(row.started_at) : undefined,
      finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapStep(row: Any): RoutineWorkflowStepRecord {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      routineId: String(row.routine_id),
      nodeId: String(row.node_id),
      operation: String(row.operation),
      status: row.status as RoutineWorkflowStepStatus,
      attemptCount: Number(row.attempt_count || 0),
      input: row.input_json ? parseJson(row.input_json, {}) : undefined,
      output: row.output_json ? parseJson(row.output_json, {}) : undefined,
      error: row.error ? String(row.error) : undefined,
      approvalId: row.approval_id ? String(row.approval_id) : undefined,
      startedAt: row.started_at ? Number(row.started_at) : undefined,
      finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapEvent(row: Any): WorkflowEventRecord {
    return {
      id: String(row.id),
      routineId: String(row.routine_id),
      triggerNodeId: String(row.trigger_node_id),
      source: String(row.source),
      idempotencyKey: String(row.idempotency_key),
      status: row.status as WorkflowEventStatus,
      attemptCount: Number(row.attempt_count || 0),
      receivedAt: Number(row.received_at),
      availableAt: Number(row.available_at),
      payload: parseJson(row.payload_json, {}),
      summary: row.summary ? String(row.summary) : undefined,
      runId: row.run_id ? String(row.run_id) : undefined,
      error: row.error ? String(row.error) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function clampRetentionDays(value: number, fallback: number): number {
  const normalized = Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(365, Math.floor(normalized)));
}
