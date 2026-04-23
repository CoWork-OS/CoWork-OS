import { randomUUID } from "crypto";
import type { AgentConfig } from "../../shared/types";
import { MCPSettingsManager } from "../mcp/settings";
import { generateHookToken } from "../hooks/settings";
import type { HookMappingConfig, HooksConfig } from "../hooks/types";
import type { CronDeliveryConfig, CronEvent } from "../cron/types";
import { CHANNEL_TYPES, type ChannelType } from "../gateway/channels/types";
import type { EventTriggerService } from "../triggers/EventTriggerService";
import type { EventTrigger, TriggerCondition, TriggerEvent, TriggerHistoryEntry } from "../triggers/types";
import type {
  Routine,
  RoutineApiTrigger,
  RoutineChannelEventTrigger,
  RoutineConnectorEventTrigger,
  RoutineCreate,
  RoutineDefinition,
  RoutineGithubEventTrigger,
  RoutineMailboxEventTrigger,
  RoutineManualTrigger,
  RoutineOutput,
  RoutinePatch,
  RoutineRun,
  RoutineRunStatus,
  RoutineScheduleTrigger,
  RoutineServiceDeps,
  RoutineTrigger,
  RoutineWebhookResponseOutput,
} from "./types";

const DEFAULT_EVENT_COOLDOWN_MS = 60_000;
const DEFAULT_RUN_LIST_LIMIT = 50;

type RoutineRunRecord = RoutineRun & {
  runKey?: string;
};

export class RoutineService {
  private readonly deps: Required<
    Pick<
      RoutineServiceDeps,
      "db" | "getCronService" | "getEventTriggerService" | "loadHooksSettings" | "saveHooksSettings" | "now"
    >
  > &
    Pick<
      RoutineServiceDeps,
      | "createTask"
      | "createManagedSession"
      | "runTaskOnDevice"
      | "getTaskSnapshot"
      | "getManagedSessionSnapshot"
      | "onHooksConfigChanged"
      | "onTriggerMutation"
    >;

  constructor(deps: RoutineServiceDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
    };
    this.ensureSchema();
  }

  list(): Routine[] {
    const rows = this.deps.db
      .prepare("SELECT * FROM automation_routines ORDER BY updated_at DESC")
      .all() as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  get(id: string): Routine | null {
    const row = this.deps.db
      .prepare("SELECT * FROM automation_routines WHERE id = ?")
      .get(id) as Any | undefined;
    return row ? this.mapRow(row) : null;
  }

  async listRuns(routineId?: string, limit = DEFAULT_RUN_LIST_LIMIT): Promise<RoutineRun[]> {
    await this.refreshRunStatuses(routineId);
    const rows = (routineId
      ? this.deps.db
          .prepare(
            `SELECT * FROM routine_runs
             WHERE routine_id = ?
             ORDER BY started_at DESC, created_at DESC
             LIMIT ?`,
          )
          .all(routineId, limit)
      : this.deps.db
          .prepare(
            `SELECT * FROM routine_runs
             ORDER BY started_at DESC, created_at DESC
             LIMIT ?`,
          )
          .all(limit)) as Any[];
    return rows.map((row) => this.mapRunRow(row));
  }

  async create(input: RoutineCreate): Promise<Routine> {
    const now = this.deps.now();
    const routine = toCompatibilityRoutine({
      id: randomUUID(),
      name: input.name.trim(),
      description: clean(input.description),
      enabled: input.enabled ?? true,
      workspaceId: input.workspaceId.trim(),
      instructions: normalizeInstructions(input.instructions ?? input.prompt),
      executionTarget: normalizeExecutionTarget(input.executionTarget),
      contextBindings: normalizeContextBindings(input.contextBindings),
      triggers: normalizeTriggers(input.triggers || []),
      outputs: normalizeOutputs(input.outputs || []),
      approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
      connectorPolicy: normalizeConnectorPolicy(input.connectorPolicy, input.connectors),
      createdAt: now,
      updatedAt: now,
    });

    const synced = await this.syncRoutine(routine, null);
    this.persist(synced);
    return synced;
  }

  async update(id: string, patch: RoutinePatch): Promise<Routine | null> {
    const existing = this.get(id);
    if (!existing) return null;

    const updated = toCompatibilityRoutine({
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      description:
        patch.description !== undefined ? clean(patch.description) : existing.description,
      enabled: patch.enabled ?? existing.enabled,
      workspaceId: patch.workspaceId !== undefined ? patch.workspaceId.trim() : existing.workspaceId,
      instructions:
        patch.instructions !== undefined || patch.prompt !== undefined
          ? normalizeInstructions(patch.instructions ?? patch.prompt)
          : existing.instructions,
      executionTarget:
        patch.executionTarget !== undefined
          ? normalizeExecutionTarget(patch.executionTarget)
          : existing.executionTarget,
      contextBindings:
        patch.contextBindings !== undefined
          ? normalizeContextBindings(patch.contextBindings)
          : existing.contextBindings,
      triggers: patch.triggers ? normalizeTriggers(patch.triggers) : existing.triggers,
      outputs: patch.outputs ? normalizeOutputs(patch.outputs) : existing.outputs,
      approvalPolicy:
        patch.approvalPolicy !== undefined
          ? normalizeApprovalPolicy(patch.approvalPolicy)
          : existing.approvalPolicy,
      connectorPolicy:
        patch.connectorPolicy !== undefined || patch.connectors !== undefined
          ? normalizeConnectorPolicy(patch.connectorPolicy, patch.connectors)
          : existing.connectorPolicy,
      updatedAt: this.deps.now(),
    });

    const synced = await this.syncRoutine(updated, existing);
    this.persist(synced);
    return synced;
  }

  async remove(id: string): Promise<boolean> {
    const routine = this.get(id);
    if (!routine) return false;

    let hooksTouched = false;
    let eventTriggersTouched = false;
    for (const trigger of routine.triggers) {
      await this.teardownTrigger(trigger);
      if (trigger.type === "api") hooksTouched = true;
      if (isManagedEventRoutineTrigger(trigger)) eventTriggersTouched = true;
    }

    this.deps.db.prepare("DELETE FROM automation_routines WHERE id = ?").run(id);
    this.deps.db.prepare("DELETE FROM routine_runs WHERE routine_id = ?").run(id);
    if (hooksTouched) {
      this.deps.onHooksConfigChanged?.(this.deps.loadHooksSettings());
    }
    if (eventTriggersTouched) {
      await this.deps.onTriggerMutation?.();
    }
    return true;
  }

  async regenerateApiToken(routineId: string, triggerId: string): Promise<RoutineApiTrigger | null> {
    const routine = this.get(routineId);
    if (!routine) return null;

    let changed = false;
    const triggers = routine.triggers.map((trigger) => {
      if (trigger.id !== triggerId || trigger.type !== "api") return trigger;
      changed = true;
      return {
        ...trigger,
        token: generateHookToken(),
      };
    });
    if (!changed) return null;

    const updated = await this.update(routineId, { triggers });
    if (!updated) return null;
    const trigger = updated.triggers.find((candidate) => candidate.id === triggerId);
    return trigger?.type === "api" ? trigger : null;
  }

  async runNow(routineId: string): Promise<RoutineRun | null> {
    const routine = this.get(routineId);
    if (!routine || !routine.enabled) return null;

    const manualTrigger =
      routine.triggers.find((trigger): trigger is RoutineManualTrigger => trigger.type === "manual") ||
      ({
        id: `manual:${routine.id}`,
        type: "manual",
        enabled: true,
      } satisfies RoutineManualTrigger);

    const execution = await this.dispatchRoutineExecution(routine, manualTrigger, {
      prompt: buildRoutinePrompt(routine, "manual", [
        "Manual trigger context:",
        "- Triggered from the Routines settings panel.",
      ]),
      sourceSummary: "Manual run",
      source: "manual",
    });

    const run = this.upsertRun({
      runKey: `manual:${routine.id}:${this.deps.now()}`,
      routineId: routine.id,
      triggerId: manualTrigger.id,
      triggerType: manualTrigger.type,
      startedAt: this.deps.now(),
      finishedAt: execution.finishedAt,
      sourceEventSummary: "Manual run",
      backingTaskId: execution.taskId,
      backingManagedSessionId: execution.managedSessionId,
      outputStatus: execution.outputStatus,
      status: execution.status,
      errorSummary: execution.errorSummary,
      artifactsSummary: execution.artifactsSummary,
    });
    await this.refreshRunStatuses(routine.id);
    return run;
  }

  recordScheduledEvent(event: CronEvent): void {
    if (event.action !== "started" && event.action !== "finished") return;
    const routineMatch = this.findRoutineByManagedResource("managedCronJobId", event.jobId);
    if (!routineMatch) return;

    const runKey = `cron:${event.jobId}:${event.runAtMs ?? event.nextRunAtMs ?? this.deps.now()}`;
    const existing = this.findRunByKey(runKey);
    const startedAt = event.runAtMs ?? existing?.startedAt ?? this.deps.now();
    const base = {
      runKey,
      routineId: routineMatch.routine.id,
      triggerId: routineMatch.trigger.id,
      triggerType: routineMatch.trigger.type,
      startedAt,
      sourceEventSummary: summarizeCronEvent(event),
      backingTaskId: event.taskId ?? existing?.backingTaskId,
      outputStatus: mapCronOutputStatus(event.status, Boolean(event.taskId)),
    } as const;

    if (event.action === "started") {
      this.upsertRun({
        ...base,
        status: "running",
      });
      return;
    }

    this.upsertRun({
      ...base,
      finishedAt: this.deps.now(),
      status: mapCronStatus(event.status),
      errorSummary: event.error,
    });
  }

  recordEventTriggerFire(payload: {
    trigger: EventTrigger;
    event: TriggerEvent;
    historyEntry: TriggerHistoryEntry;
  }): void {
    const routineMatch = this.findRoutineByManagedResource(
      "managedEventTriggerId",
      payload.trigger.id,
    );
    if (!routineMatch) return;

    this.upsertRun({
      runKey: `event:${payload.historyEntry.id}`,
      routineId: routineMatch.routine.id,
      triggerId: routineMatch.trigger.id,
      triggerType: routineMatch.trigger.type,
      status: payload.historyEntry.taskId ? "queued" : "completed",
      startedAt: payload.historyEntry.firedAt,
      sourceEventSummary: summarizeTriggerEvent(payload.event),
      backingTaskId: payload.historyEntry.taskId,
      outputStatus: "none",
      errorSummary: payload.historyEntry.actionResult?.startsWith("error:")
        ? payload.historyEntry.actionResult
        : undefined,
      artifactsSummary: payload.historyEntry.actionResult,
    });
  }

  recordApiTriggerDispatch(payload: {
    mappingId?: string;
    path?: string;
    workspaceId?: string;
    taskId?: string;
    metadata?: Record<string, string>;
    response?: { statusCode?: number; message?: string; includeTaskId?: boolean };
  }): void {
    const mappingId = payload.mappingId || payload.metadata?.mappingId;
    const routineMatch = mappingId
      ? this.findRoutineByManagedResource("managedHookMappingId", mappingId)
      : this.findRoutineByApiPath(payload.path);
    if (!routineMatch) return;

    this.upsertRun({
      runKey: `api:${mappingId || payload.path || routineMatch.trigger.id}:${this.deps.now()}`,
      routineId: routineMatch.routine.id,
      triggerId: routineMatch.trigger.id,
      triggerType: routineMatch.trigger.type,
      status: payload.taskId ? "queued" : "completed",
      startedAt: this.deps.now(),
      sourceEventSummary: payload.path ? `API request: ${payload.path}` : "API request",
      backingTaskId: payload.taskId,
      outputStatus: routineHasWebhookResponse(routineMatch.routine)
        ? "responded"
        : "none",
      artifactsSummary: payload.response?.message,
    });
  }

  private ensureSchema(): void {
    this.deps.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        workspace_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        connectors_json TEXT NOT NULL,
        triggers_json TEXT NOT NULL,
        definition_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_routines_workspace
      ON automation_routines(workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS routine_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        source_event_summary TEXT,
        backing_task_id TEXT,
        backing_managed_session_id TEXT,
        output_status TEXT NOT NULL DEFAULT 'none',
        error_summary TEXT,
        artifacts_summary TEXT,
        run_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
      ON routine_runs(routine_id, started_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_routine_runs_run_key
      ON routine_runs(run_key);
    `);

    if (!columnExists(this.deps.db, "automation_routines", "definition_json")) {
      this.deps.db.exec("ALTER TABLE automation_routines ADD COLUMN definition_json TEXT");
    }
    if (!columnExists(this.deps.db, "routine_runs", "run_key")) {
      this.deps.db.exec("ALTER TABLE routine_runs ADD COLUMN run_key TEXT");
    }
  }

  private mapRow(row: Any): Routine {
    const createdAt = Number(row.created_at || this.deps.now());
    const updatedAt = Number(row.updated_at || createdAt);
    const definition = safeJsonParse<RoutineDefinition | null>(row.definition_json, null);
    if (definition) {
      return toCompatibilityRoutine(
        normalizeRoutineDefinition({
          ...definition,
          id: String(row.id || definition.id),
          name: String(row.name || definition.name),
          description: row.description ? String(row.description) : definition.description,
          enabled: row.enabled === undefined ? definition.enabled : Boolean(row.enabled),
          workspaceId: String(row.workspace_id || definition.workspaceId),
          createdAt,
          updatedAt,
        }),
      );
    }

    return toCompatibilityRoutine(
      normalizeRoutineDefinition({
        id: String(row.id),
        name: String(row.name),
        description: row.description ? String(row.description) : undefined,
        enabled: Boolean(row.enabled),
        workspaceId: String(row.workspace_id),
        instructions: normalizeInstructions(row.prompt),
        executionTarget: { kind: "workspace" },
        contextBindings: {},
        triggers: normalizeTriggers(safeJsonParse<RoutineTrigger[]>(row.triggers_json, [])),
        outputs: [{ kind: "task_only" }],
        approvalPolicy: { mode: "inherit" },
        connectorPolicy: {
          mode: "prefer",
          connectorIds: safeJsonParse<string[]>(row.connectors_json, []).filter(Boolean),
        },
        createdAt,
        updatedAt,
      }),
    );
  }

  private mapRunRow(row: Any): RoutineRun {
    return {
      id: String(row.id),
      routineId: String(row.routine_id),
      triggerId: String(row.trigger_id),
      triggerType: String(row.trigger_type) as RoutineTrigger["type"],
      status: String(row.status) as RoutineRunStatus,
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
      sourceEventSummary: row.source_event_summary ? String(row.source_event_summary) : undefined,
      backingTaskId: row.backing_task_id ? String(row.backing_task_id) : undefined,
      backingManagedSessionId: row.backing_managed_session_id
        ? String(row.backing_managed_session_id)
        : undefined,
      outputStatus: String(row.output_status || "none") as RoutineRun["outputStatus"],
      errorSummary: row.error_summary ? String(row.error_summary) : undefined,
      artifactsSummary: row.artifacts_summary ? String(row.artifacts_summary) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private persist(routine: Routine): void {
    this.deps.db
      .prepare(
        `INSERT OR REPLACE INTO automation_routines
         (id, name, description, enabled, workspace_id, prompt, connectors_json, triggers_json, definition_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        routine.id,
        routine.name,
        routine.description || null,
        routine.enabled ? 1 : 0,
        routine.workspaceId,
        routine.instructions,
        JSON.stringify(routine.connectorPolicy.connectorIds),
        JSON.stringify(routine.triggers),
        JSON.stringify(stripCompatibilityFields(routine)),
        routine.createdAt,
        routine.updatedAt,
      );
  }

  private async syncRoutine(routine: Routine, previous: Routine | null): Promise<Routine> {
    const previousById = new Map((previous?.triggers || []).map((trigger) => [trigger.id, trigger]));
    let hooksTouched = false;
    let eventTriggersTouched = false;

    const syncedTriggers: RoutineTrigger[] = [];
    for (const trigger of routine.triggers) {
      const previousTrigger = previousById.get(trigger.id);
      switch (trigger.type) {
        case "schedule":
          syncedTriggers.push(await this.syncScheduleTrigger(routine, trigger));
          break;
        case "api":
          syncedTriggers.push(await this.syncApiTrigger(routine, trigger));
          hooksTouched = true;
          break;
        case "connector_event":
        case "channel_event":
        case "mailbox_event":
        case "github_event":
          syncedTriggers.push(await this.syncEventTrigger(routine, trigger, previousTrigger));
          eventTriggersTouched = true;
          break;
        case "manual":
          syncedTriggers.push(trigger);
          break;
      }
      previousById.delete(trigger.id);
    }

    for (const staleTrigger of previousById.values()) {
      await this.teardownTrigger(staleTrigger);
      if (staleTrigger.type === "api") hooksTouched = true;
      if (isManagedEventRoutineTrigger(staleTrigger)) eventTriggersTouched = true;
    }

    if (hooksTouched) {
      this.deps.onHooksConfigChanged?.(this.deps.loadHooksSettings());
    }
    if (eventTriggersTouched) {
      await this.deps.onTriggerMutation?.();
    }

    return toCompatibilityRoutine({
      ...routine,
      triggers: syncedTriggers,
    });
  }

  private async syncScheduleTrigger(
    routine: Routine,
    trigger: RoutineScheduleTrigger,
  ): Promise<RoutineScheduleTrigger> {
    const cronService = this.deps.getCronService();
    if (!cronService) {
      throw new Error("Scheduled task service is not available");
    }

    const agentConfig = this.buildRoutineAgentConfig(routine);
    const payload = {
      name: `Routine: ${routine.name}`,
      description: routine.description,
      enabled: routine.enabled && trigger.enabled,
      workspaceId: routine.workspaceId,
      taskPrompt: buildRoutinePrompt(routine, "schedule"),
      taskTitle: routine.name,
      schedule: trigger.schedule,
      allowUserInput: agentConfig?.allowUserInput ?? false,
      taskAgentConfig: agentConfig,
      chatContext: routine.contextBindings.chatContext,
      delivery: buildScheduleDelivery(routine.outputs),
    };

    if (trigger.managedCronJobId) {
      const updated = await cronService.update(trigger.managedCronJobId, payload);
      if (updated.ok) {
        return trigger;
      }
    }

    const created = await cronService.add(payload);
    if (!created.ok) {
      throw new Error(created.error || "Failed to create scheduled routine trigger");
    }
    return {
      ...trigger,
      managedCronJobId: created.job.id,
    };
  }

  private async syncApiTrigger(
    routine: Routine,
    trigger: RoutineApiTrigger,
  ): Promise<RoutineApiTrigger> {
    const managedHookMappingId =
      trigger.managedHookMappingId || `routine:${routine.id}:api:${trigger.id}`;
    const path = trigger.path || `routines/${routine.id}/${trigger.id}`;
    const token = trigger.token?.trim() || generateHookToken();
    const response = getWebhookResponseOutput(routine.outputs);

    const nextTrigger: RoutineApiTrigger = {
      ...trigger,
      path,
      token,
      managedHookMappingId,
    };

    const settings = cloneHooksSettings(this.deps.loadHooksSettings());
    settings.mappings = settings.mappings.filter((mapping) => mapping.id !== managedHookMappingId);

    if (routine.enabled && trigger.enabled) {
      const mapping: HookMappingConfig = {
        id: managedHookMappingId,
        token,
        match: { path },
        action: "agent",
        name: routine.name,
        workspaceId: routine.workspaceId,
        messageTemplate: buildRoutinePrompt(routine, "api", [
          "API request context:",
          "- Source: {{source}}",
          "- Type: {{type}}",
          "- Request text: {{text}}",
        ]),
        agentConfig: this.buildRoutineAgentConfig(routine),
        metadata: {
          routineId: routine.id,
          triggerId: trigger.id,
          mappingId: managedHookMappingId,
          hookPath: path,
        },
        response: response
          ? {
              statusCode: response.statusCode,
              message: response.message,
              includeTaskId: response.includeTaskId,
            }
          : undefined,
      };
      settings.mappings.push(mapping);
    }

    this.deps.saveHooksSettings(settings);
    return nextTrigger;
  }

  private async syncEventTrigger(
    routine: Routine,
    trigger:
      | RoutineConnectorEventTrigger
      | RoutineChannelEventTrigger
      | RoutineMailboxEventTrigger
      | RoutineGithubEventTrigger,
    _previous?: RoutineTrigger,
  ): Promise<RoutineTrigger> {
    const triggerService = this.deps.getEventTriggerService();
    if (!triggerService) {
      throw new Error("Event trigger service is not available");
    }

    const source = routineTriggerSource(trigger);
    const nextTriggerId =
      trigger.managedEventTriggerId || `routine:${routine.id}:${trigger.type}:${trigger.id}`;
    const nextTrigger: EventTrigger = {
      id: nextTriggerId,
      name: `${routine.name} (${trigger.type.replace(/_/g, " ")})`,
      description: routine.description,
      enabled: routine.enabled && trigger.enabled,
      source,
      conditions: buildTriggerConditions(trigger),
      conditionLogic: "all",
      action: {
        type: "create_task",
        config: {
          title: routine.name,
          workspaceId: routine.workspaceId,
          prompt: buildTriggeredPrompt(routine, trigger),
          agentConfig: this.buildRoutineAgentConfig(routine),
        },
      },
      workspaceId: routine.workspaceId,
      cooldownMs: trigger.cooldownMs ?? DEFAULT_EVENT_COOLDOWN_MS,
      fireCount: 0,
      createdAt: this.deps.now(),
      updatedAt: this.deps.now(),
    };

    const existing = triggerService.getTrigger(nextTriggerId);
    if (existing) {
      triggerService.updateTrigger(nextTriggerId, nextTrigger);
      return {
        ...trigger,
        managedEventTriggerId: nextTriggerId,
      };
    }

    const created = triggerService.addTrigger({
      name: nextTrigger.name,
      description: nextTrigger.description,
      enabled: nextTrigger.enabled,
      source: nextTrigger.source,
      conditions: nextTrigger.conditions,
      conditionLogic: nextTrigger.conditionLogic,
      action: nextTrigger.action,
      workspaceId: nextTrigger.workspaceId,
      cooldownMs: nextTrigger.cooldownMs,
    });

    return {
      ...trigger,
      managedEventTriggerId: created.id,
    };
  }

  private async teardownTrigger(trigger: RoutineTrigger): Promise<void> {
    switch (trigger.type) {
      case "schedule":
        if (trigger.managedCronJobId) {
          await this.deps.getCronService()?.remove(trigger.managedCronJobId);
        }
        return;
      case "api":
        if (!trigger.managedHookMappingId) return;
        {
          const settings = cloneHooksSettings(this.deps.loadHooksSettings());
          settings.mappings = settings.mappings.filter(
            (mapping) => mapping.id !== trigger.managedHookMappingId,
          );
          this.deps.saveHooksSettings(settings);
        }
        return;
      case "connector_event":
      case "channel_event":
      case "mailbox_event":
      case "github_event":
        if (trigger.managedEventTriggerId) {
          this.deps.getEventTriggerService()?.removeTrigger(trigger.managedEventTriggerId);
        }
        return;
      case "manual":
        return;
    }
  }

  private buildRoutineAgentConfig(routine: Routine): AgentConfig | undefined {
    const config: AgentConfig = {};

    if (routine.connectorPolicy.mode === "allowlist" && routine.connectorPolicy.connectorIds.length > 0) {
      config.allowedTools = resolveConnectorAllowedTools(routine.connectorPolicy.connectorIds);
    }

    switch (routine.approvalPolicy.mode) {
      case "auto_safe":
        config.autonomousMode = true;
        config.allowUserInput = false;
        config.pauseForRequiredDecision = true;
        break;
      case "confirm_external":
      case "strict_confirm":
        config.autonomousMode = false;
        config.allowUserInput = true;
        config.pauseForRequiredDecision = true;
        break;
      default:
        break;
    }

    switch (routine.executionTarget.kind) {
      case "worktree":
        config.requireWorktree = true;
        break;
      case "device":
      case "managed_environment":
      case "workspace":
        break;
    }

    return Object.keys(config).length > 0 ? config : undefined;
  }

  private async dispatchRoutineExecution(
    routine: Routine,
    trigger: RoutineTrigger,
    params: {
      prompt: string;
      sourceSummary: string;
      source: "manual" | "cron" | "hook" | "api";
    },
  ): Promise<{
    taskId?: string;
    managedSessionId?: string;
    status: RoutineRunStatus;
    outputStatus: RoutineRun["outputStatus"];
    errorSummary?: string;
    artifactsSummary?: string;
    finishedAt?: number;
  }> {
    try {
      const agentConfig = this.buildRoutineAgentConfig(routine);

      if (routine.executionTarget.kind === "managed_environment") {
        if (!routine.executionTarget.managedEnvironmentId || !this.deps.createManagedSession) {
          throw new Error("Managed environment routines are not configured on this device");
        }
        const session = await this.deps.createManagedSession({
          agentId:
            typeof routine.contextBindings?.metadata?.managedAgentId === "string"
              ? routine.contextBindings.metadata.managedAgentId
              : undefined,
          environmentId: routine.executionTarget.managedEnvironmentId,
          title: routine.name,
          prompt: params.prompt,
        });
        return {
          taskId: session.backingTaskId,
          managedSessionId: session.id,
          status: session.backingTaskId ? "queued" : "running",
          outputStatus: "none",
        };
      }

      if (routine.executionTarget.kind === "device") {
        if (!routine.executionTarget.deviceId || !this.deps.runTaskOnDevice) {
          throw new Error("Remote device routines are not configured on this device");
        }
        const task = await this.deps.runTaskOnDevice({
          deviceId: routine.executionTarget.deviceId,
          title: routine.name,
          prompt: params.prompt,
          workspaceId: routine.workspaceId,
          agentConfig,
        });
        return {
          taskId: task.id,
          status: "queued",
          outputStatus: "none",
        };
      }

      if (!this.deps.createTask) {
        throw new Error(`Routine execution is unavailable for ${trigger.type} triggers`);
      }

      const task = await this.deps.createTask({
        title: routine.name,
        prompt: params.prompt,
        workspaceId: routine.workspaceId,
        agentConfig,
        source: params.source,
      });
      return {
        taskId: task.id,
        status: "queued",
        outputStatus: "none",
      };
    } catch (error) {
      return {
        status: "failed",
        outputStatus: "failed",
        errorSummary: error instanceof Error ? error.message : String(error),
        finishedAt: this.deps.now(),
      };
    }
  }

  private async refreshRunStatuses(routineId?: string): Promise<void> {
    const rows = (routineId
      ? this.deps.db
          .prepare(
            `SELECT * FROM routine_runs
             WHERE routine_id = ? AND status IN ('queued', 'running')
             ORDER BY updated_at DESC`,
          )
          .all(routineId)
      : this.deps.db
          .prepare(
            `SELECT * FROM routine_runs
             WHERE status IN ('queued', 'running')
             ORDER BY updated_at DESC`,
          )
          .all()) as Any[];

    for (const row of rows) {
      const run = this.mapRunRow(row);
      if (run.backingManagedSessionId && this.deps.getManagedSessionSnapshot) {
        const snapshot = await this.deps.getManagedSessionSnapshot(run.backingManagedSessionId);
        if (!snapshot) continue;
        const status =
          snapshot.status === "completed"
            ? "completed"
            : snapshot.status === "failed" || snapshot.status === "cancelled"
              ? "failed"
              : "running";
        this.upsertRun({
          ...run,
          status,
          finishedAt:
            status === "running" ? run.finishedAt : snapshot.completedAt || run.finishedAt || this.deps.now(),
          backingTaskId: run.backingTaskId || snapshot.backingTaskId || undefined,
          artifactsSummary: snapshot.latestSummary || run.artifactsSummary,
        });
        continue;
      }

      if (run.backingTaskId && this.deps.getTaskSnapshot) {
        const snapshot = await this.deps.getTaskSnapshot(run.backingTaskId);
        if (!snapshot) continue;
        const status = mapTaskSnapshotStatus(snapshot.status, snapshot.terminalStatus);
        this.upsertRun({
          ...run,
          status,
          finishedAt:
            status === "queued" || status === "running"
              ? run.finishedAt
              : snapshot.completedAt || run.finishedAt || this.deps.now(),
          errorSummary: snapshot.error || run.errorSummary,
          artifactsSummary: snapshot.resultSummary || run.artifactsSummary,
        });
      }
    }
  }

  private upsertRun(input: {
    runKey?: string;
    routineId: string;
    triggerId: string;
    triggerType: RoutineTrigger["type"];
    status: RoutineRunStatus;
    startedAt: number;
    finishedAt?: number;
    sourceEventSummary?: string;
    backingTaskId?: string;
    backingManagedSessionId?: string;
    outputStatus: RoutineRun["outputStatus"];
    errorSummary?: string;
    artifactsSummary?: string;
  }): RoutineRun {
    const now = this.deps.now();
    const existing = input.runKey ? this.findRunByKey(input.runKey) : null;
    const id = existing?.id || randomUUID();
    const createdAt = existing?.createdAt || now;
    this.deps.db
      .prepare(
        `INSERT OR REPLACE INTO routine_runs
         (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at, source_event_summary,
          backing_task_id, backing_managed_session_id, output_status, error_summary, artifacts_summary,
          run_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.outputStatus,
        input.errorSummary || null,
        input.artifactsSummary || null,
        input.runKey || null,
        createdAt,
        now,
      );

    return {
      id,
      routineId: input.routineId,
      triggerId: input.triggerId,
      triggerType: input.triggerType,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      sourceEventSummary: input.sourceEventSummary,
      backingTaskId: input.backingTaskId,
      backingManagedSessionId: input.backingManagedSessionId,
      outputStatus: input.outputStatus,
      errorSummary: input.errorSummary,
      artifactsSummary: input.artifactsSummary,
      createdAt,
      updatedAt: now,
    };
  }

  private findRunByKey(runKey: string): RoutineRunRecord | null {
    const row = this.deps.db
      .prepare("SELECT * FROM routine_runs WHERE run_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(runKey) as Any | undefined;
    if (!row) return null;
    return {
      ...this.mapRunRow(row),
      runKey: row.run_key ? String(row.run_key) : undefined,
    };
  }

  private findRoutineByManagedResource(
    field: "managedCronJobId" | "managedHookMappingId" | "managedEventTriggerId",
    value: string,
  ): { routine: Routine; trigger: RoutineTrigger } | null {
    for (const routine of this.list()) {
      const trigger = routine.triggers.find((candidate) => {
        if (field === "managedCronJobId" && candidate.type === "schedule") {
          return candidate.managedCronJobId === value;
        }
        if (field === "managedHookMappingId" && candidate.type === "api") {
          return candidate.managedHookMappingId === value;
        }
        if (field === "managedEventTriggerId" && isManagedEventRoutineTrigger(candidate)) {
          return candidate.managedEventTriggerId === value;
        }
        return false;
      });
      if (trigger) return { routine, trigger };
    }
    return null;
  }

  private findRoutineByApiPath(path?: string): { routine: Routine; trigger: RoutineApiTrigger } | null {
    if (!path) return null;
    const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
    for (const routine of this.list()) {
      const trigger = routine.triggers.find(
        (candidate): candidate is RoutineApiTrigger =>
          candidate.type === "api" && candidate.path?.replace(/^\/+/, "").replace(/\/+$/, "") === normalized,
      );
      if (trigger) return { routine, trigger };
    }
    return null;
  }
}

function columnExists(db: Any, tableName: string, columnName: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

function stripCompatibilityFields(routine: Routine): RoutineDefinition {
  const { prompt: _prompt, connectors: _connectors, ...definition } = routine;
  return definition;
}

function toCompatibilityRoutine(routine: RoutineDefinition): Routine {
  return {
    ...routine,
    prompt: routine.instructions,
    connectors: routine.connectorPolicy.connectorIds,
  };
}

function normalizeRoutineDefinition(input: RoutineDefinition): RoutineDefinition {
  return {
    ...input,
    name: input.name.trim(),
    description: clean(input.description),
    workspaceId: input.workspaceId.trim(),
    instructions: normalizeInstructions(input.instructions),
    executionTarget: normalizeExecutionTarget(input.executionTarget),
    contextBindings: normalizeContextBindings(input.contextBindings),
    triggers: normalizeTriggers(input.triggers || []),
    outputs: normalizeOutputs(input.outputs || []),
    approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
    connectorPolicy: normalizeConnectorPolicy(input.connectorPolicy),
  };
}

function normalizeExecutionTarget(target?: RoutineDefinition["executionTarget"]): RoutineDefinition["executionTarget"] {
  return {
    kind: target?.kind || "workspace",
    deviceId: clean(target?.deviceId),
    managedEnvironmentId: clean(target?.managedEnvironmentId),
  };
}

function normalizeContextBindings(
  bindings?: RoutineDefinition["contextBindings"],
): RoutineDefinition["contextBindings"] {
  const rawChannelType = bindings?.chatContext?.channelType?.trim();
  const normalizedChannelType = rawChannelType && CHANNEL_TYPES.includes(rawChannelType as ChannelType)
    ? (rawChannelType as ChannelType)
    : undefined;
  const chatContext =
    normalizedChannelType && bindings?.chatContext?.channelId
      ? {
          channelType: normalizedChannelType,
          channelId: bindings.chatContext.channelId.trim(),
        }
      : undefined;
  const metadata = Object.fromEntries(
    Object.entries(bindings?.metadata || {})
      .map(([key, value]) => [key.trim(), String(value).trim()])
      .filter(([key, value]) => key && value),
  );
  return {
    chatContext,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function normalizeConnectorPolicy(
  policy?: Partial<RoutineDefinition["connectorPolicy"]>,
  compatibilityConnectors?: string[],
): RoutineDefinition["connectorPolicy"] {
  const connectorIds = Array.from(
    new Set(
      (policy?.connectorIds || compatibilityConnectors || [])
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  return {
    mode: policy?.mode === "allowlist" ? "allowlist" : "prefer",
    connectorIds,
  };
}

function normalizeApprovalPolicy(
  policy?: Partial<RoutineDefinition["approvalPolicy"]>,
): RoutineDefinition["approvalPolicy"] {
  switch (policy?.mode) {
    case "auto_safe":
    case "confirm_external":
    case "strict_confirm":
      return { mode: policy.mode };
    default:
      return { mode: "inherit" };
  }
}

function normalizeOutputs(outputs: RoutineOutput[]): RoutineOutput[] {
  const normalized = outputs.map((output): RoutineOutput => {
      switch (output.kind) {
        case "channel_message":
          return {
            kind: "channel_message",
            channelType: clean(output.channelType),
            channelDbId: clean(output.channelDbId),
            channelId: clean(output.channelId),
            deliverOnSuccess: output.deliverOnSuccess ?? true,
            deliverOnError: output.deliverOnError ?? true,
            summaryOnly: output.summaryOnly ?? false,
          };
        case "webhook_response":
          return {
            kind: "webhook_response",
            statusCode: output.statusCode ?? 202,
            message: clean(output.message),
            includeTaskId: output.includeTaskId ?? true,
          };
        case "email":
          return {
            kind: "email",
            to: clean(output.to),
            subject: clean(output.subject),
          };
        case "github_comment":
          return {
            kind: "github_comment",
            repository: clean(output.repository),
            issueNumber: output.issueNumber,
          };
        case "issue_or_pr":
          {
            const mode: "issue" | "pr" | undefined =
              output.mode === "pr" ? "pr" : output.mode === "issue" ? "issue" : undefined;
          return {
            kind: "issue_or_pr",
            repository: clean(output.repository),
            mode,
          };
          }
        case "task_only":
        default:
          return { kind: "task_only" } satisfies RoutineOutput;
      }
    });
  return normalized.length > 0 ? normalized : [{ kind: "task_only" }];
}

function normalizeTriggers(triggers: RoutineTrigger[]): RoutineTrigger[] {
  return triggers.map((trigger) => {
    const base = {
      ...trigger,
      id: trigger.id || randomUUID(),
      enabled: trigger.enabled ?? true,
    } as RoutineTrigger;

    switch (base.type) {
      case "schedule":
        return {
          ...base,
          schedule:
            base.schedule.kind === "at"
              ? { kind: "at", atMs: Number(base.schedule.atMs) }
              : base.schedule.kind === "every"
                ? {
                    kind: "every",
                    everyMs: Number(base.schedule.everyMs),
                    anchorMs: base.schedule.anchorMs ? Number(base.schedule.anchorMs) : undefined,
                  }
                : {
                    kind: "cron",
                    expr: base.schedule.expr.trim(),
                    tz: clean(base.schedule.tz),
                  },
        };
      case "api":
        return {
          ...base,
          path: clean(base.path),
          token: clean(base.token),
        };
      case "connector_event":
        return {
          ...base,
          connectorId: base.connectorId.trim(),
          changeType: clean(base.changeType),
          resourceUriContains: clean(base.resourceUriContains),
          conditions: normalizeConditions(base.conditions),
        };
      case "channel_event":
        return {
          ...base,
          channelType: clean(base.channelType),
          chatId: clean(base.chatId),
          textContains: clean(base.textContains),
          senderContains: clean(base.senderContains),
          conditions: normalizeConditions(base.conditions),
        };
      case "mailbox_event":
        return {
          ...base,
          eventType: clean(base.eventType),
          subjectContains: clean(base.subjectContains),
          provider: clean(base.provider),
          labelContains: clean(base.labelContains),
          conditions: normalizeConditions(base.conditions),
        };
      case "github_event":
        return {
          ...base,
          eventName: clean(base.eventName),
          repository: clean(base.repository),
          action: clean(base.action),
          ref: clean(base.ref),
          conditions: normalizeConditions(base.conditions),
        };
      case "manual":
      default:
        return base;
    }
  });
}

function normalizeConditions(conditions?: TriggerCondition[]): TriggerCondition[] {
  return (conditions || [])
    .map((condition) => ({
      field: condition.field.trim(),
      operator: condition.operator,
      value: condition.value.trim(),
    }))
    .filter((condition) => condition.field && condition.value);
}

function cloneHooksSettings(settings: HooksConfig): HooksConfig {
  return {
    ...settings,
    presets: [...(settings.presets || [])],
    mappings: [...(settings.mappings || [])],
    gmail: settings.gmail ? { ...settings.gmail } : undefined,
    resend: settings.resend ? { ...settings.resend } : undefined,
  };
}

function buildRoutinePrompt(routine: Routine, triggerLabel: string, extraLines: string[] = []): string {
  const sections = [
    "You are running a saved CoWork Routine.",
    `Routine: ${routine.name}`,
    routine.description ? `Description: ${routine.description}` : null,
    `Trigger: ${triggerLabel}`,
    `Workspace ID: ${routine.workspaceId}`,
    routine.connectorPolicy.mode === "prefer" && routine.connectorPolicy.connectorIds.length > 0
      ? `Preferred connectors: ${routine.connectorPolicy.connectorIds.join(", ")}`
      : null,
    "",
    "Saved instructions:",
    routine.instructions,
  ];

  if (routine.contextBindings.metadata && Object.keys(routine.contextBindings.metadata).length > 0) {
    sections.push(
      "",
      "Context bindings:",
      ...Object.entries(routine.contextBindings.metadata).map(([key, value]) => `- ${key}: ${value}`),
    );
  }

  if (extraLines.length > 0) {
    sections.push("", ...extraLines);
  }

  return sections.filter(Boolean).join("\n");
}

function buildTriggeredPrompt(
  routine: Routine,
  trigger:
    | RoutineConnectorEventTrigger
    | RoutineChannelEventTrigger
    | RoutineMailboxEventTrigger
    | RoutineGithubEventTrigger,
): string {
  switch (trigger.type) {
    case "connector_event":
      return buildRoutinePrompt(routine, "connector event", [
        "Connector event context:",
        "- Connector ID: {{event.connectorId}}",
        "- Change type: {{event.changeType}}",
        "- Resource URI: {{event.resourceUri}}",
        "- Payload: {{event.payload}}",
      ]);
    case "channel_event":
      return buildRoutinePrompt(routine, "channel event", [
        "Channel event context:",
        "- Channel type: {{event.channelType}}",
        "- Chat ID: {{event.chatId}}",
        "- Sender: {{event.senderName}}",
        "- Text: {{event.text}}",
      ]);
    case "mailbox_event":
      return buildRoutinePrompt(routine, "mailbox event", [
        "Mailbox event context:",
        "- Event type: {{event.eventType}}",
        "- Provider: {{event.provider}}",
        "- Thread ID: {{event.threadId}}",
        "- Subject: {{event.subject}}",
        "- Summary: {{event.summary}}",
      ]);
    case "github_event":
      return buildRoutinePrompt(routine, "github event", [
        "GitHub event context:",
        "- Event name: {{event.eventName}}",
        "- Action: {{event.action}}",
        "- Repository: {{event.repository}}",
        "- Ref: {{event.ref}}",
        "- Resource URI: {{event.resourceUri}}",
      ]);
  }
}

function buildTriggerConditions(
  trigger:
    | RoutineConnectorEventTrigger
    | RoutineChannelEventTrigger
    | RoutineMailboxEventTrigger
    | RoutineGithubEventTrigger,
): TriggerCondition[] {
  const conditions: TriggerCondition[] = [...normalizeConditions(trigger.conditions)];
  switch (trigger.type) {
    case "connector_event":
      conditions.push({ field: "connectorId", operator: "equals", value: trigger.connectorId });
      if (trigger.changeType) {
        conditions.push({ field: "changeType", operator: "equals", value: trigger.changeType });
      }
      if (trigger.resourceUriContains) {
        conditions.push({
          field: "resourceUri",
          operator: "contains",
          value: trigger.resourceUriContains,
        });
      }
      break;
    case "channel_event":
      if (trigger.channelType) {
        conditions.push({ field: "channelType", operator: "equals", value: trigger.channelType });
      }
      if (trigger.chatId) {
        conditions.push({ field: "chatId", operator: "equals", value: trigger.chatId });
      }
      if (trigger.textContains) {
        conditions.push({ field: "text", operator: "contains", value: trigger.textContains });
      }
      if (trigger.senderContains) {
        conditions.push({
          field: "senderName",
          operator: "contains",
          value: trigger.senderContains,
        });
      }
      break;
    case "mailbox_event":
      if (trigger.eventType) {
        conditions.push({ field: "eventType", operator: "equals", value: trigger.eventType });
      }
      if (trigger.provider) {
        conditions.push({ field: "provider", operator: "equals", value: trigger.provider });
      }
      if (trigger.subjectContains) {
        conditions.push({
          field: "subject",
          operator: "contains",
          value: trigger.subjectContains,
        });
      }
      if (trigger.labelContains) {
        conditions.push({
          field: "labels",
          operator: "contains",
          value: trigger.labelContains,
        });
      }
      break;
    case "github_event":
      conditions.push({ field: "connectorId", operator: "equals", value: "github" });
      if (trigger.eventName) {
        conditions.push({ field: "eventName", operator: "equals", value: trigger.eventName });
      }
      if (trigger.repository) {
        conditions.push({ field: "repository", operator: "equals", value: trigger.repository });
      }
      if (trigger.action) {
        conditions.push({ field: "action", operator: "equals", value: trigger.action });
      }
      if (trigger.ref) {
        conditions.push({ field: "ref", operator: "equals", value: trigger.ref });
      }
      break;
  }
  return conditions;
}

function buildScheduleDelivery(outputs: RoutineOutput[]): CronDeliveryConfig | undefined {
  const channel = outputs.find((output): output is Extract<RoutineOutput, { kind: "channel_message" }> => output.kind === "channel_message");
  if (!channel?.channelType || !channel.channelId) return undefined;
  return {
    enabled: true,
    channelType: channel.channelType as CronDeliveryConfig["channelType"],
    channelDbId: channel.channelDbId,
    channelId: channel.channelId,
    deliverOnSuccess: channel.deliverOnSuccess,
    deliverOnError: channel.deliverOnError,
    summaryOnly: channel.summaryOnly,
  };
}

function getWebhookResponseOutput(outputs: RoutineOutput[]): RoutineWebhookResponseOutput | undefined {
  return outputs.find(
    (output): output is RoutineWebhookResponseOutput => output.kind === "webhook_response",
  );
}

function routineHasWebhookResponse(routine: Routine): boolean {
  return Boolean(getWebhookResponseOutput(routine.outputs));
}

function routineTriggerSource(
  trigger:
    | RoutineConnectorEventTrigger
    | RoutineChannelEventTrigger
    | RoutineMailboxEventTrigger
    | RoutineGithubEventTrigger,
): EventTrigger["source"] {
  switch (trigger.type) {
    case "channel_event":
      return "channel_message";
    case "mailbox_event":
      return "mailbox_event";
    case "github_event":
      return "github_event";
    case "connector_event":
    default:
      return "connector_event";
  }
}

function isManagedEventRoutineTrigger(
  trigger: RoutineTrigger,
): trigger is
  | RoutineConnectorEventTrigger
  | RoutineChannelEventTrigger
  | RoutineMailboxEventTrigger
  | RoutineGithubEventTrigger {
  return (
    trigger.type === "connector_event" ||
    trigger.type === "channel_event" ||
    trigger.type === "mailbox_event" ||
    trigger.type === "github_event"
  );
}

function resolveConnectorAllowedTools(connectorIds: string[]): string[] {
  const ids = connectorIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return [];
  const settings = MCPSettingsManager.loadSettings();
  const prefix = settings.toolNamePrefix || "mcp_";
  const out = new Set<string>();
  for (const connectorId of ids) {
    const server = MCPSettingsManager.getServer(connectorId);
    if (!server) {
      throw new Error(`Routine references unknown connector "${connectorId}"`);
    }
    if (!Array.isArray(server.tools) || server.tools.length === 0) {
      throw new Error(`Routine connector "${connectorId}" does not expose any tool metadata`);
    }
    for (const tool of server.tools) {
      if (tool?.name) out.add(`${prefix}${tool.name}`);
    }
  }
  if (out.size === 0) {
    throw new Error("Routine connector allowlist resolved to zero tools");
  }
  return Array.from(out);
}

function mapCronStatus(status?: CronEvent["status"]): RoutineRunStatus {
  switch (status) {
    case "ok":
      return "completed";
    case "partial_success":
      return "partial_success";
    case "needs_user_action":
      return "needs_user_action";
    case "error":
    case "timeout":
      return "failed";
    case "skipped":
      return "completed";
    default:
      return "running";
  }
}

function mapCronOutputStatus(
  status: CronEvent["status"] | undefined,
  hasTaskId: boolean,
): RoutineRun["outputStatus"] {
  if (!hasTaskId) return "none";
  if (status === "error" || status === "timeout") return "failed";
  return "queued";
}

function summarizeCronEvent(event: CronEvent): string {
  if (event.status) {
    return `Scheduled run ${event.action}: ${event.status}`;
  }
  return `Scheduled run ${event.action}`;
}

function summarizeTriggerEvent(event: TriggerEvent): string {
  switch (event.source) {
    case "channel_message":
      return `Channel event: ${String(event.fields.channelType || "")} ${String(event.fields.chatId || "")}`.trim();
    case "mailbox_event":
      return `Mailbox event: ${String(event.fields.eventType || "")}`.trim();
    case "github_event":
      return `GitHub event: ${String(event.fields.eventName || "")}`.trim();
    case "connector_event":
      return `Connector event: ${String(event.fields.connectorId || "")}`.trim();
    default:
      return event.source;
  }
}

function mapTaskSnapshotStatus(
  status: string,
  terminalStatus?: string | null,
): RoutineRunStatus {
  if (status === "pending" || status === "queued") return "queued";
  if (status === "planning" || status === "executing") return "running";
  if (status === "paused" || terminalStatus === "needs_user_action") return "needs_user_action";
  if (status === "failed" || terminalStatus === "failed") return "failed";
  if (terminalStatus === "partial_success") return "partial_success";
  if (status === "completed" || terminalStatus === "ok") return "completed";
  return "running";
}

function normalizeInstructions(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error("Routine instructions are required");
  }
  return text;
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
