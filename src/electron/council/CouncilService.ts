import Database from "better-sqlite3";
import { promises as fs } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  CouncilConfig,
  CouncilDeliveryConfig,
  CouncilExecutionPolicy,
  CouncilMemo,
  CouncilParticipant,
  CouncilRun,
  CouncilSourceBundle,
  CreateCouncilConfigRequest,
  MultiLlmConfig,
  MultiLlmParticipant,
  UpdateCouncilConfigRequest,
  type ChannelType,
  type Task,
} from "../../shared/types";
import type { NotificationService } from "../notifications/service";
import { resolveTaskResultText } from "../cron/result-text";
import { TaskEventRepository, TaskRepository } from "../database/repositories";
import type { CronService } from "../cron/service";
import type { CronJobCreate } from "../cron/types";

const COUNCIL_TRIGGER_PREFIX = "<cowork_council:";
const COUNCIL_TRIGGER_SUFFIX = ">";
const COUNCIL_CRON_MARKER_PREFIX = "[cowork:council:";
const COUNCIL_CRON_MARKER_SUFFIX = "]";
const MAX_SOURCE_BYTES_PER_FILE = 32_000;
const MAX_TOTAL_SOURCE_BYTES = 96_000;

const BLOCKED_PATH_PREFIXES = ["/etc", "/sys", "/proc", "/dev", "/boot", "/root", "/var/log"];
const BLOCKED_SUBDIR_NAMES = [".ssh", ".gnupg", ".aws", ".kube"];

function isSafeFilePath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (BLOCKED_PATH_PREFIXES.some((prefix) => resolved === prefix || resolved.startsWith(prefix + "/"))) {
    return false;
  }
  const home = process.env.HOME;
  if (home) {
    for (const subdir of BLOCKED_SUBDIR_NAMES) {
      const blocked = path.join(home, subdir);
      if (resolved === blocked || resolved.startsWith(blocked + "/")) {
        return false;
      }
    }
  }
  return true;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeSourceBundle(
  sourceBundle?: Partial<CouncilSourceBundle> | CouncilSourceBundle | null,
): CouncilSourceBundle {
  return {
    files: Array.isArray(sourceBundle?.files) ? sourceBundle.files.filter((item) => !!item?.path) : [],
    urls: Array.isArray(sourceBundle?.urls) ? sourceBundle.urls.filter((item) => !!item?.url) : [],
    connectors: Array.isArray(sourceBundle?.connectors)
      ? sourceBundle.connectors.filter((item) => !!item?.provider && !!item?.label)
      : [],
  };
}

function normalizeDeliveryConfig(
  deliveryConfig?: Partial<CouncilDeliveryConfig> | CouncilDeliveryConfig | null,
): CouncilDeliveryConfig {
  return {
    enabled: deliveryConfig?.enabled === true,
    channelType: deliveryConfig?.channelType,
    channelDbId: deliveryConfig?.channelDbId,
    channelId: deliveryConfig?.channelId,
  };
}

function normalizeExecutionPolicy(
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

function normalizeParticipants(participants: CouncilParticipant[]): CouncilParticipant[] {
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

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.floor(value)));
}

function isAllOllama(participants: CouncilParticipant[]): boolean {
  return participants.length > 0 && participants.every((participant) => participant.providerType === "ollama");
}

function computeParallelism(
  participants: CouncilParticipant[],
  policy: CouncilExecutionPolicy,
): number {
  if (participants.length === 0) return 1;
  if (typeof policy.maxParallelParticipants === "number" && policy.maxParallelParticipants > 0) {
    return Math.min(participants.length, Math.floor(policy.maxParallelParticipants));
  }
  if (policy.mode === "full_parallel") return participants.length;
  if (policy.mode === "capped_local") return Math.min(participants.length, 2);
  return isAllOllama(participants) ? Math.min(participants.length, 2) : participants.length;
}

function assertCouncilParticipants(participants: CouncilParticipant[]): void {
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

class CouncilConfigRepository {
  constructor(private readonly db: Database.Database) {}

  listByWorkspace(workspaceId: string): CouncilConfig[] {
    const rows = this.db
      .prepare("SELECT * FROM council_configs WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as Any[];
    return rows.map((row) => this.mapRow(row));
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
      request.participants !== undefined ? normalizeParticipants(request.participants) : existing.participants;
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
      ...(request.sourceBundle !== undefined ? { sourceBundle: normalizeSourceBundle(request.sourceBundle) } : {}),
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

class CouncilRunRepository {
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

class CouncilMemoRepository {
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
      .prepare("SELECT * FROM council_memos WHERE council_config_id = ? ORDER BY created_at DESC LIMIT 1")
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

export interface CouncilServiceDeps {
  db: Database.Database;
  getCronService: () => CronService | null;
  getNotificationService?: () => NotificationService | null;
  deliverToChannel?: (params: {
    channelType: ChannelType;
    channelDbId?: string;
    channelId: string;
    message: string;
    idempotencyKey: string;
  }) => Promise<void>;
}

export class CouncilService {
  private readonly configRepo: CouncilConfigRepository;
  private readonly runRepo: CouncilRunRepository;
  private readonly memoRepo: CouncilMemoRepository;
  private readonly taskRepo: TaskRepository;
  private readonly taskEventRepo: TaskEventRepository;
  private readonly inFlightTriggers = new Set<string>();

  constructor(private readonly deps: CouncilServiceDeps) {
    this.configRepo = new CouncilConfigRepository(deps.db);
    this.runRepo = new CouncilRunRepository(deps.db);
    this.memoRepo = new CouncilMemoRepository(deps.db);
    this.taskRepo = new TaskRepository(deps.db);
    this.taskEventRepo = new TaskEventRepository(deps.db);
  }

  static buildManagedTrigger(councilId: string): string {
    return `${COUNCIL_TRIGGER_PREFIX}${councilId}${COUNCIL_TRIGGER_SUFFIX}`;
  }

  static parseManagedTrigger(prompt: string): string | null {
    const trimmed = String(prompt || "").trim();
    if (!trimmed.startsWith(COUNCIL_TRIGGER_PREFIX) || !trimmed.endsWith(COUNCIL_TRIGGER_SUFFIX)) {
      return null;
    }
    return trimmed.slice(COUNCIL_TRIGGER_PREFIX.length, -COUNCIL_TRIGGER_SUFFIX.length).trim() || null;
  }

  list(workspaceId: string): CouncilConfig[] {
    return this.configRepo.listByWorkspace(workspaceId);
  }

  get(id: string): CouncilConfig | undefined {
    return this.configRepo.findById(id);
  }

  getMemo(id: string): CouncilMemo | undefined {
    return this.memoRepo.findById(id);
  }

  getLatestMemo(councilConfigId: string): CouncilMemo | undefined {
    return this.memoRepo.getLatestForCouncil(councilConfigId);
  }

  listRuns(councilConfigId: string, limit = 20): CouncilRun[] {
    return this.runRepo.listByCouncil(councilConfigId, limit);
  }

  async create(request: CreateCouncilConfigRequest): Promise<CouncilConfig> {
    const config = this.configRepo.create(request);
    return await this.syncManagedJob(config.id);
  }

  async update(request: UpdateCouncilConfigRequest): Promise<CouncilConfig | undefined> {
    const updated = this.configRepo.update(request);
    if (!updated) return undefined;
    return await this.syncManagedJob(updated.id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<CouncilConfig | undefined> {
    const updated = this.configRepo.update({ id, enabled });
    if (!updated) return undefined;
    return await this.syncManagedJob(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.configRepo.findById(id);
    if (!existing) return false;
    const cron = this.deps.getCronService();
    if (existing.managedCronJobId && cron) {
      await cron.remove(existing.managedCronJobId).catch(() => undefined);
    }
    return this.configRepo.delete(id);
  }

  async runNow(id: string): Promise<CouncilRun | null> {
    const config = this.configRepo.findById(id);
    if (!config?.managedCronJobId) return null;
    const cron = this.deps.getCronService();
    if (!cron) throw new Error("Scheduler service is not running");
    const result = await cron.run(config.managedCronJobId, "force");
    if (!result.ok || !result.ran) {
      return null;
    }
    return this.runRepo.findByTaskId(result.taskId) || null;
  }

  isCouncilJob(jobId: string): boolean {
    return !!this.configRepo.findByManagedCronJobId(jobId);
  }

  async prepareTaskForTrigger(triggerPrompt: string, workspaceId: string): Promise<{
    runId: string;
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig: Task["agentConfig"];
  } | null> {
    const councilId = CouncilService.parseManagedTrigger(triggerPrompt);
    if (!councilId) return null;

    if (this.inFlightTriggers.has(councilId)) {
      throw new Error(`Council ${councilId} is already being triggered`);
    }
    this.inFlightTriggers.add(councilId);

    try {
      return await this._prepareTaskForTriggerInner(councilId, workspaceId);
    } finally {
      this.inFlightTriggers.delete(councilId);
    }
  }

  private async _prepareTaskForTriggerInner(councilId: string, workspaceId: string): Promise<{
    runId: string;
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig: Task["agentConfig"];
  } | null> {
    const config = this.configRepo.findById(councilId);
    if (!config) throw new Error(`Council not found: ${councilId}`);
    const participants = normalizeParticipants(config.participants);
    assertCouncilParticipants(participants);

    const proposerSeatIndex = clampIndex(config.nextIdeaSeatIndex, participants.length);
    const sourceSnapshot = normalizeSourceBundle(config.sourceBundle);
    const run = this.runRepo.create({
      councilConfigId: config.id,
      workspaceId: config.workspaceId || workspaceId,
      proposerSeatIndex,
      sourceSnapshot,
    });

    const nextIdeaSeatIndex =
      participants.length > 0
        ? (proposerSeatIndex + 1) % participants.length
        : config.nextIdeaSeatIndex;
    this.configRepo.update({ id: config.id, nextIdeaSeatIndex });

    const multiLlmParticipants: MultiLlmParticipant[] = participants.map((participant, index) => ({
      providerType: participant.providerType,
      modelKey: participant.modelKey,
      displayName: participant.seatLabel,
      isJudge: index === clampIndex(config.judgeSeatIndex, participants.length),
      seatLabel: participant.seatLabel,
      roleInstruction: participant.roleInstruction,
      isIdeaProposer: index === proposerSeatIndex,
    }));
    const judgeSeatIndex = clampIndex(config.judgeSeatIndex, participants.length);
    const judge = participants[judgeSeatIndex];
    const maxParallelParticipants = computeParallelism(participants, config.executionPolicy);
    const multiLlmConfig: MultiLlmConfig = {
      participants: multiLlmParticipants,
      judgeProviderType: judge.providerType,
      judgeModelKey: judge.modelKey,
      maxParallelParticipants,
    };

    return {
      runId: run.id,
      title: `Council: ${config.name}`,
      prompt: await this.buildCouncilPrompt(config, proposerSeatIndex),
      workspaceId: config.workspaceId || workspaceId,
      agentConfig: {
        multiLlmMode: true,
        multiLlmConfig,
        councilMode: true,
        councilRunId: run.id,
        retainMemory: false,
        allowUserInput: false,
      },
    };
  }

  bindRunTask(runId: string, taskId: string): CouncilRun | undefined {
    return this.runRepo.bindTask(runId, taskId);
  }

  async finalizeRunForTask(taskId: string): Promise<CouncilRun | null> {
    const run = this.runRepo.findByTaskId(taskId);
    if (!run || run.memoId) return run || null;

    const config = this.configRepo.findById(run.councilConfigId);
    if (!config) return null;
    const task = this.taskRepo.findById(taskId);
    const events = this.taskEventRepo.findByTaskId(taskId);
    const resolvedText =
      resolveTaskResultText({ summary: task?.resultSummary, events }) ||
      task?.resultSummary ||
      task?.error ||
      "Council run completed without a synthesized memo.";
    const normalizedText = String(resolvedText).trim();
    const status =
      task?.status === "failed" || task?.status === "cancelled" ? "failed" : "completed";

    let delivered = false;
    let deliveryError: string | undefined;
    if (
      config.deliveryConfig.enabled &&
      config.deliveryConfig.channelType &&
      config.deliveryConfig.channelId &&
      this.deps.deliverToChannel
    ) {
      try {
        await this.deps.deliverToChannel({
          channelType: config.deliveryConfig.channelType,
          channelDbId: config.deliveryConfig.channelDbId,
          channelId: config.deliveryConfig.channelId,
          message: `**R&D Council Memo — ${config.name}**\n\n${normalizedText}`,
          idempotencyKey: `council:${run.id}`,
        });
        delivered = true;
      } catch (error: Any) {
        deliveryError = error?.message || String(error);
      }
    }

    const memo = this.memoRepo.create({
      councilRunId: run.id,
      councilConfigId: run.councilConfigId,
      workspaceId: run.workspaceId,
      taskId,
      proposerSeatIndex: run.proposerSeatIndex,
      content: normalizedText,
      delivered,
      deliveryError,
    });

    const updatedRun = this.runRepo.complete(run.id, {
      status,
      summary: normalizedText.slice(0, 1000),
      error: status === "failed" ? task?.error || deliveryError : undefined,
      memoId: memo.id,
    });

    await this.deps.getNotificationService?.()
      ?.add({
        type: status === "failed" ? "warning" : "info",
        title: `R&D Council memo: ${config.name}`,
        message:
          deliveryError && !delivered
            ? `Memo saved. Channel delivery failed: ${deliveryError}`
            : delivered
              ? "Memo saved and delivered."
              : "Memo saved in-app.",
        taskId,
        workspaceId: run.workspaceId,
      })
      .catch(() => undefined);

    return updatedRun || null;
  }

  async syncManagedJob(id: string): Promise<CouncilConfig> {
    const config = this.configRepo.findById(id);
    if (!config) throw new Error(`Council not found: ${id}`);

    const cron = this.deps.getCronService();
    if (!cron) return config;

    const job: CronJobCreate = {
      name: `Council: ${config.name}`,
      description: `${COUNCIL_CRON_MARKER_PREFIX}${config.id}${COUNCIL_CRON_MARKER_SUFFIX}`,
      enabled: config.enabled,
      schedule: config.schedule,
      workspaceId: config.workspaceId,
      taskPrompt: CouncilService.buildManagedTrigger(config.id),
      taskTitle: `Council: ${config.name}`,
      allowUserInput: false,
      maxHistoryEntries: 25,
    };

    if (config.managedCronJobId) {
      const result = await cron.update(config.managedCronJobId, {
        name: job.name,
        description: job.description,
        enabled: job.enabled,
        schedule: job.schedule,
        workspaceId: job.workspaceId,
        taskPrompt: job.taskPrompt,
        taskTitle: job.taskTitle,
        allowUserInput: false,
        maxHistoryEntries: job.maxHistoryEntries,
      });
      if (!result.ok) throw new Error(result.error);
      return this.configRepo.findById(id)!;
    }

    const added = await cron.add(job);
    if (!added.ok) throw new Error(added.error);
    const updated = this.configRepo.update({ id, managedCronJobId: added.job.id });
    if (!updated) throw new Error(`Council not found after cron sync: ${id}`);
    return updated;
  }

  private async buildCouncilPrompt(
    config: CouncilConfig,
    proposerSeatIndex: number,
  ): Promise<string> {
    const sourceContext = await this.buildSourceContext(config.sourceBundle);
    const proposer = config.participants[clampIndex(proposerSeatIndex, config.participants.length)];
    return [
      `You are part of the R&D Council "${config.name}".`,
      "",
      "Goal:",
      "Review the curated business/product context below, debate next moves, and produce a revenue-growth memo.",
      "",
      `Special role for this run: ${proposer?.seatLabel || "Seat 1"} is the rotating idea proposer.`,
      "That proposer must introduce at least one concrete new growth idea.",
      "All other participants should challenge, refine, or reject weak ideas and push toward clear actions.",
      "",
      "Boundaries:",
      "- Review only the curated sources in this prompt.",
      "- Do not roam beyond the listed files, URLs, and connector references.",
      "- Use tools only if needed to inspect the listed sources more closely.",
      "",
      "Required final memo sections:",
      "1. Executive Summary",
      "2. What We Reviewed",
      "3. Best New Idea",
      "4. Where The Models Agreed",
      "5. Where They Disagreed",
      "6. Recommended Next Actions",
      "7. Experiments To Run",
      "8. Risks / Missing Inputs",
      "",
      sourceContext,
    ].join("\n");
  }

  private async buildSourceContext(sourceBundle: CouncilSourceBundle): Promise<string> {
    const lines: string[] = ["Curated source bundle:"];

    if (sourceBundle.files.length > 0) {
      lines.push("");
      lines.push("Files:");
      let remaining = MAX_TOTAL_SOURCE_BYTES;
      for (const file of sourceBundle.files) {
        const snippet = await this.readFileSnippet(file.path, Math.min(MAX_SOURCE_BYTES_PER_FILE, remaining));
        remaining -= snippet.length;
        lines.push(`- ${file.label || path.basename(file.path)} (${file.path})`);
        lines.push(snippet ? `\n\`\`\`\n${snippet}\n\`\`\`` : "  [Could not read a text snippet]");
        if (remaining <= 0) break;
      }
    }

    if (sourceBundle.urls.length > 0) {
      lines.push("");
      lines.push("URLs:");
      for (const item of sourceBundle.urls) {
        lines.push(`- ${item.label || item.url}: ${item.url}`);
      }
    }

    if (sourceBundle.connectors.length > 0) {
      lines.push("");
      lines.push("Connector references:");
      for (const item of sourceBundle.connectors) {
        lines.push(
          `- ${item.label} [provider=${item.provider}${item.resourceId ? `, resource=${item.resourceId}` : ""}]${item.notes ? ` — ${item.notes}` : ""}`,
        );
      }
    }

    if (
      sourceBundle.files.length === 0 &&
      sourceBundle.urls.length === 0 &&
      sourceBundle.connectors.length === 0
    ) {
      lines.push("- No curated sources configured yet.");
    }

    return lines.join("\n");
  }

  private async readFileSnippet(filePath: string, maxBytes: number): Promise<string> {
    try {
      if (!isSafeFilePath(filePath)) return "";
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) return "";
      const buffer = await fs.readFile(filePath);
      const slice = buffer.subarray(0, Math.min(buffer.length, Math.max(0, maxBytes)));
      const text = slice.toString("utf8").replace(/\u0000/g, "").trim();
      return text.length > 0 ? text : "";
    } catch {
      return "";
    }
  }
}
