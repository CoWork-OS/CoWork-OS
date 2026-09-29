import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  CouncilConfig,
  CouncilDeliveryConfig,
  CouncilExecutionPolicy,
  CouncilMemo,
  CouncilParticipant,
  CouncilRun,
  CouncilSourceBundle,
  CreateCouncilConfigRequest,
  UpdateCouncilConfigRequest,
} from "../../shared/types";

// Council configs, runs and memos (async SQLite migration plan, DB6). As services-domain
// units these run in the database worker when the domain is routed there; the council
// service uses the async facades in council-repository-facades.ts.

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function normalizeSourceBundle(
  sourceBundle?: Partial<CouncilSourceBundle> | CouncilSourceBundle | null,
): CouncilSourceBundle {
  return {
    files: Array.isArray(sourceBundle?.files)
      ? sourceBundle.files.filter((item) => !!item?.path)
      : [],
    urls: Array.isArray(sourceBundle?.urls) ? sourceBundle.urls.filter((item) => !!item?.url) : [],
    connectors: Array.isArray(sourceBundle?.connectors)
      ? sourceBundle.connectors.filter((item) => !!item?.provider && !!item?.label)
      : [],
  };
}

export function normalizeDeliveryConfig(
  deliveryConfig?: Partial<CouncilDeliveryConfig> | CouncilDeliveryConfig | null,
): CouncilDeliveryConfig {
  return {
    enabled: deliveryConfig?.enabled === true,
    channelType: deliveryConfig?.channelType,
    channelDbId: deliveryConfig?.channelDbId,
    channelId: deliveryConfig?.channelId,
  };
}

export function normalizeExecutionPolicy(
  executionPolicy?: Partial<CouncilExecutionPolicy> | CouncilExecutionPolicy | null,
): CouncilExecutionPolicy {
  return {
    mode: executionPolicy?.mode || "auto",
    maxParallelParticipants:
      typeof executionPolicy?.maxParallelParticipants === "number"
        ? executionPolicy.maxParallelParticipants
        : undefined,
  };
}

export function normalizeParticipants(participants: CouncilParticipant[]): CouncilParticipant[] {
  return participants.map((participant, index) => ({
    providerType: participant.providerType,
    modelKey: String(participant.modelKey || "").trim(),
    seatLabel: String(participant.seatLabel || `Seat ${index + 1}`).trim() || `Seat ${index + 1}`,
    roleInstruction:
      typeof participant.roleInstruction === "string" && participant.roleInstruction.trim()
        ? participant.roleInstruction.trim()
        : undefined,
  }));
}

export function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.floor(value)));
}

export function assertCouncilParticipants(participants: CouncilParticipant[]): void {
  if (participants.length < 2 || participants.length > 8) {
    throw new Error("Councils must have between 2 and 8 participants.");
  }
  for (let index = 0; index < participants.length; index += 1) {
    const participant = participants[index];
    if (!participant.modelKey.trim()) {
      throw new Error(`Council participant ${index + 1} is missing a model key.`);
    }
    if (!participant.seatLabel.trim()) {
      throw new Error(`Council participant ${index + 1} is missing a seat label.`);
    }
  }
}

export class CouncilConfigStore {
  constructor(private readonly db: Database.Database) {}

  listByWorkspace(workspaceId: string): CouncilConfig[] {
    const rows = this.db
      .prepare("SELECT * FROM council_configs WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  allIds(): string[] {
    return (this.db.prepare("SELECT id FROM council_configs").all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
  }

  findById(id: string): CouncilConfig | undefined {
    const row = this.db.prepare("SELECT * FROM council_configs WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByManagedCronJobId(managedCronJobId: string): CouncilConfig | undefined {
    const row = this.db
      .prepare("SELECT * FROM council_configs WHERE managed_cron_job_id = ?")
      .get(managedCronJobId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  create(request: CreateCouncilConfigRequest): CouncilConfig {
    const now = Date.now();
    const participants = normalizeParticipants(request.participants);
    assertCouncilParticipants(participants);
    const config: CouncilConfig = {
      id: uuidv4(),
      workspaceId: request.workspaceId,
      name: request.name.trim(),
      enabled: request.enabled ?? true,
      schedule: request.schedule,
      participants,
      judgeSeatIndex: clampIndex(request.judgeSeatIndex, participants.length),
      rotatingIdeaSeatIndex: clampIndex(request.rotatingIdeaSeatIndex ?? 0, participants.length),
      sourceBundle: normalizeSourceBundle(request.sourceBundle),
      deliveryConfig: normalizeDeliveryConfig(request.deliveryConfig),
      executionPolicy: normalizeExecutionPolicy(request.executionPolicy),
      nextIdeaSeatIndex: clampIndex(request.rotatingIdeaSeatIndex ?? 0, participants.length),
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO council_configs (
          id, workspace_id, name, enabled, schedule_json, participants_json,
          judge_seat_index, rotating_idea_seat_index, source_bundle_json, delivery_config_json,
          execution_policy_json, managed_cron_job_id, next_idea_seat_index, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.id,
        config.workspaceId,
        config.name,
        config.enabled ? 1 : 0,
        JSON.stringify(config.schedule),
        JSON.stringify(config.participants),
        config.judgeSeatIndex,
        config.rotatingIdeaSeatIndex,
        JSON.stringify(config.sourceBundle),
        JSON.stringify(config.deliveryConfig),
        JSON.stringify(config.executionPolicy),
        config.managedCronJobId || null,
        config.nextIdeaSeatIndex,
        config.createdAt,
        config.updatedAt,
      );

    return config;
  }

  update(request: UpdateCouncilConfigRequest): CouncilConfig | undefined {
    const existing = this.findById(request.id);
    if (!existing) return undefined;

    const participants =
      request.participants !== undefined
        ? normalizeParticipants(request.participants)
        : existing.participants;
    assertCouncilParticipants(participants);
    const next: CouncilConfig = {
      ...existing,
      ...(request.name !== undefined ? { name: request.name.trim() } : {}),
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.schedule !== undefined ? { schedule: request.schedule } : {}),
      ...(request.participants !== undefined ? { participants } : {}),
      ...(request.judgeSeatIndex !== undefined
        ? { judgeSeatIndex: clampIndex(request.judgeSeatIndex, participants.length) }
        : {}),
      ...(request.rotatingIdeaSeatIndex !== undefined
        ? { rotatingIdeaSeatIndex: clampIndex(request.rotatingIdeaSeatIndex, participants.length) }
        : {}),
      ...(request.sourceBundle !== undefined
        ? { sourceBundle: normalizeSourceBundle(request.sourceBundle) }
        : {}),
      ...(request.deliveryConfig !== undefined
        ? { deliveryConfig: normalizeDeliveryConfig(request.deliveryConfig) }
        : {}),
      ...(request.executionPolicy !== undefined
        ? { executionPolicy: normalizeExecutionPolicy(request.executionPolicy) }
        : {}),
      ...(request.managedCronJobId !== undefined
        ? { managedCronJobId: request.managedCronJobId || undefined }
        : {}),
      ...(request.nextIdeaSeatIndex !== undefined
        ? { nextIdeaSeatIndex: clampIndex(request.nextIdeaSeatIndex, participants.length) }
        : {}),
      updatedAt: Date.now(),
    };

    this.db
      .prepare(
        `UPDATE council_configs
         SET name = ?, enabled = ?, schedule_json = ?, participants_json = ?, judge_seat_index = ?,
             rotating_idea_seat_index = ?, source_bundle_json = ?, delivery_config_json = ?,
             execution_policy_json = ?, managed_cron_job_id = ?, next_idea_seat_index = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.enabled ? 1 : 0,
        JSON.stringify(next.schedule),
        JSON.stringify(next.participants),
        next.judgeSeatIndex,
        next.rotatingIdeaSeatIndex,
        JSON.stringify(next.sourceBundle),
        JSON.stringify(next.deliveryConfig),
        JSON.stringify(next.executionPolicy),
        next.managedCronJobId || null,
        next.nextIdeaSeatIndex,
        next.updatedAt,
        next.id,
      );

    return next;
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM council_configs WHERE id = ?").run(id);
    return result.changes > 0;
  }

  private mapRow(row: Any): CouncilConfig {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      enabled: row.enabled === 1,
      schedule: parseJson(row.schedule_json, { kind: "cron", expr: "0 9,17 * * *" }),
      participants: normalizeParticipants(parseJson(row.participants_json, [])),
      judgeSeatIndex: row.judge_seat_index ?? 0,
      rotatingIdeaSeatIndex: row.rotating_idea_seat_index ?? 0,
      sourceBundle: normalizeSourceBundle(parseJson(row.source_bundle_json, {})),
      deliveryConfig: normalizeDeliveryConfig(parseJson(row.delivery_config_json, {})),
      executionPolicy: normalizeExecutionPolicy(parseJson(row.execution_policy_json, {})),
      managedCronJobId: row.managed_cron_job_id || undefined,
      nextIdeaSeatIndex: row.next_idea_seat_index ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export class CouncilRunStore {
  constructor(private readonly db: Database.Database) {}

  create(params: {
    councilConfigId: string;
    workspaceId: string;
    proposerSeatIndex: number;
    sourceSnapshot: CouncilSourceBundle;
  }): CouncilRun {
    const run: CouncilRun = {
      id: uuidv4(),
      councilConfigId: params.councilConfigId,
      workspaceId: params.workspaceId,
      status: "running",
      proposerSeatIndex: params.proposerSeatIndex,
      sourceSnapshot: params.sourceSnapshot,
      startedAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO council_runs (
          id, council_config_id, workspace_id, task_id, status, proposer_seat_index,
          summary, error, memo_id, source_snapshot_json, started_at, completed_at
        ) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        run.id,
        run.councilConfigId,
        run.workspaceId,
        run.status,
        run.proposerSeatIndex,
        JSON.stringify(run.sourceSnapshot),
        run.startedAt,
      );
    return run;
  }

  listByCouncil(councilConfigId: string, limit = 20): CouncilRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM council_runs WHERE council_config_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(councilConfigId, limit) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  findById(id: string): CouncilRun | undefined {
    const row = this.db.prepare("SELECT * FROM council_runs WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByTaskId(taskId: string): CouncilRun | undefined {
    const row = this.db.prepare("SELECT * FROM council_runs WHERE task_id = ?").get(taskId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  bindTask(runId: string, taskId: string): CouncilRun | undefined {
    this.db.prepare("UPDATE council_runs SET task_id = ? WHERE id = ?").run(taskId, runId);
    return this.findById(runId);
  }

  complete(
    runId: string,
    updates: { status: "completed" | "failed"; summary?: string; error?: string; memoId?: string },
  ): CouncilRun | undefined {
    this.db
      .prepare(
        `UPDATE council_runs
         SET status = ?, summary = ?, error = ?, memo_id = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        updates.status,
        updates.summary || null,
        updates.error || null,
        updates.memoId || null,
        Date.now(),
        runId,
      );
    return this.findById(runId);
  }

  private mapRow(row: Any): CouncilRun {
    return {
      id: row.id,
      councilConfigId: row.council_config_id,
      workspaceId: row.workspace_id,
      taskId: row.task_id || undefined,
      status: row.status,
      proposerSeatIndex: row.proposer_seat_index,
      summary: row.summary || undefined,
      error: row.error || undefined,
      memoId: row.memo_id || undefined,
      sourceSnapshot: normalizeSourceBundle(parseJson(row.source_snapshot_json, {})),
      startedAt: row.started_at,
      completedAt: row.completed_at || undefined,
    };
  }
}

export class CouncilMemoStore {
  constructor(private readonly db: Database.Database) {}

  create(params: {
    councilRunId: string;
    councilConfigId: string;
    workspaceId: string;
    taskId?: string;
    proposerSeatIndex: number;
    content: string;
    delivered: boolean;
    deliveryError?: string;
  }): CouncilMemo {
    const memo: CouncilMemo = {
      id: uuidv4(),
      councilRunId: params.councilRunId,
      councilConfigId: params.councilConfigId,
      workspaceId: params.workspaceId,
      taskId: params.taskId,
      proposerSeatIndex: params.proposerSeatIndex,
      content: params.content,
      delivered: params.delivered,
      deliveryError: params.deliveryError,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO council_memos (
          id, council_run_id, council_config_id, workspace_id, task_id, proposer_seat_index,
          content, delivered, delivery_error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memo.id,
        memo.councilRunId,
        memo.councilConfigId,
        memo.workspaceId,
        memo.taskId || null,
        memo.proposerSeatIndex,
        memo.content,
        memo.delivered ? 1 : 0,
        memo.deliveryError || null,
        memo.createdAt,
      );
    return memo;
  }

  getLatestForCouncil(councilConfigId: string): CouncilMemo | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM council_memos WHERE council_config_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(councilConfigId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findById(id: string): CouncilMemo | undefined {
    const row = this.db.prepare("SELECT * FROM council_memos WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  private mapRow(row: Any): CouncilMemo {
    return {
      id: row.id,
      councilRunId: row.council_run_id,
      councilConfigId: row.council_config_id,
      workspaceId: row.workspace_id,
      taskId: row.task_id || undefined,
      proposerSeatIndex: row.proposer_seat_index,
      content: row.content,
      delivered: row.delivered === 1,
      deliveryError: row.delivery_error || undefined,
      createdAt: row.created_at,
    };
  }
}
