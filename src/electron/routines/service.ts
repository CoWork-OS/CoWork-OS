import { randomUUID } from "crypto";
import type { AgentConfig } from "../../shared/types";
import type {
  RoutineWorkflowApprovalRequest,
  RoutineWorkflowDefinition,
  RoutineWorkflowEventEnvelope,
  RoutineWorkflowRunRecord,
  RoutineWorkflowStepRecord,
  RoutineWorkflowTestRequest,
  WorkflowValidationResult,
} from "../../shared/routine-workflow";
import { MCPSettingsManager } from "../mcp/settings";
import { generateHookToken } from "../hooks/settings";
import type { HookMappingConfig, HooksConfig } from "../hooks/types";
import type { CronDeliveryConfig, CronEvent } from "../cron/types";
import { CHANNEL_TYPES, type ChannelType } from "../gateway/channels/types";
import type { EventTrigger, TriggerCondition, TriggerEvent, TriggerHistoryEntry } from "../triggers/types";
import type {
  Routine,
  RoutineApiTrigger,
  RoutineChannelEventTrigger,
  RoutineContextBindings,
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
import { getWorkflowCapabilities } from "./workflow/catalog";
import { RoutineWorkflowEngine } from "./workflow/engine";
import { generateRoutineWorkflowDraft } from "./workflow/generator";
import { RoutineWorkflowRepository } from "./workflow/repository";
import { validateRoutineWorkflow } from "./workflow/validation";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { getGoogleWorkspaceSettingsForAccount, hasGoogleWorkspaceTokens } from "../../shared/google-workspace";
import { RoutineWorkflowSecretStore } from "./workflow/secret-store";
import { createLogger } from "../utils/logger";

const DEFAULT_EVENT_COOLDOWN_MS = 60_000;
const DEFAULT_RUN_LIST_LIMIT = 50;
const logger = createLogger("RoutineService");

type RoutineRunRecord = RoutineRun & {
  runKey?: string;
  dedupeKey?: string;
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
      | "sendTaskMessage"
      | "createManagedSession"
      | "runTaskOnDevice"
      | "getTaskSnapshot"
      | "getManagedSessionSnapshot"
      | "onHooksConfigChanged"
      | "onTriggerMutation"
      | "executeWorkflowAction"
    >;

  private readonly workflowRepository: RoutineWorkflowRepository;
  private readonly workflowEngine: RoutineWorkflowEngine;
  private readonly workflowSecretStore = new RoutineWorkflowSecretStore();
  private workflowInboxTimer: NodeJS.Timeout | null = null;
  private workflowMaintenanceTimer: NodeJS.Timeout | null = null;
  private workflowInboxActive = 0;
  private workflowRecoveryReady = false;

  constructor(deps: RoutineServiceDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
    };
    this.ensureSchema();
    this.workflowRepository = new RoutineWorkflowRepository(this.deps.db, this.deps.now);
    this.workflowEngine = new RoutineWorkflowEngine(this.workflowRepository, {
      now: this.deps.now,
      executeAction: this.deps.executeWorkflowAction,
    });
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

  getWorkflowCapabilities() {
    return getWorkflowCapabilities();
  }

  getActiveWorkflowDefinition(routineId: string): RoutineWorkflowDefinition | null {
    const routine = this.get(routineId);
    const version = routine ? this.resolveActiveWorkflowVersion(routine) : null;
    return version ? structuredClone(version.definition) : null;
  }

  validateWorkflow(
    workflow: RoutineWorkflowDefinition,
    allowIncomplete = false,
  ): WorkflowValidationResult {
    return validateRoutineWorkflow(workflow, { allowIncomplete });
  }

  generateWorkflowDraft(prompt: string) {
    const normalized = String(prompt || "").trim();
    if (!normalized) throw new Error("Describe the workflow you want to create.");
    return generateRoutineWorkflowDraft(normalized);
  }

  saveWorkflowDraft(routineId: string, workflow: RoutineWorkflowDefinition) {
    const routine = this.get(routineId);
    if (!routine) throw new Error(`Routine not found: ${routineId}`);
    const validation = validateRoutineWorkflow(workflow, { allowIncomplete: true });
    if (validation.issues.some((issue) => issue.severity === "error")) {
      throw new Error(validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" "));
    }
    const version = this.workflowRepository.createVersion(routineId, workflow, "draft");
    this.persist(toCompatibilityRoutine({
      ...routine,
      workflow: structuredClone(workflow),
      updatedAt: this.deps.now(),
    }));
    return { version, validation };
  }

  async activateWorkflowVersion(routineId: string, versionId: string): Promise<Routine | null> {
    const routine = this.get(routineId);
    const version = this.workflowRepository.getVersion(versionId);
    if (!routine || !version || version.routineId !== routineId) return null;
    const validation = validateRoutineWorkflow(version.definition);
    if (!validation.valid) {
      throw new Error(validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" "));
    }
    this.assertWorkflowSecretsReady(version.definition);
    this.assertWorkflowAccountReady(version.definition, validation.requiredScopes);
    this.workflowRepository.activateVersion(routineId, versionId);
    const updated = toCompatibilityRoutine({
      ...routine,
      enabled: true,
      workflow: structuredClone(version.definition),
      triggers: normalizeTriggers(deriveRoutineTriggersFromWorkflow(version.definition)),
      activeWorkflowVersionId: versionId,
      updatedAt: this.deps.now(),
    });
    const synced = await this.syncRoutine(updated, routine);
    this.persist(synced);
    return synced;
  }

  listWorkflowVersions(routineId: string) {
    return this.workflowRepository.listVersions(routineId);
  }

  listWorkflowRuns(routineId?: string, limit = DEFAULT_RUN_LIST_LIMIT) {
    return this.workflowRepository.listRuns(routineId, limit);
  }

  listWorkflowRunSteps(runId: string) {
    return this.workflowRepository.listSteps(runId);
  }

  listWorkflowEvents(routineId?: string, limit = DEFAULT_RUN_LIST_LIMIT) {
    return this.workflowRepository.listEvents(routineId, limit);
  }

  listWorkflowEventSamples(source?: string, limit = 20) {
    return this.workflowRepository.listEventSamples(source, limit);
  }

  listWorkflowSecrets() {
    return this.workflowSecretStore.list();
  }

  upsertWorkflowSecret(input: { id?: string; name: string; value: string }) {
    return this.workflowSecretStore.upsert(input);
  }

  removeWorkflowSecret(id: string) {
    const referencedBy = this.list()
      .filter((routine) => routine.enabled)
      .filter((routine) => {
        const workflow = this.getActiveWorkflowDefinition(routine.id);
        return Boolean(
          workflow &&
            flattenWorkflowNodes(workflow.nodes).some(
              (node) => node.operation === "custom.webhook" && node.config.secretRef === id,
            ),
        );
      })
      .map((routine) => routine.name);
    if (referencedBy.length > 0) {
      throw new Error(
        `Turn off the flows using this secret before removing it: ${referencedBy.join(", ")}.`,
      );
    }
    return this.workflowSecretStore.remove(id);
  }

  async testWorkflow(request: RoutineWorkflowTestRequest) {
    const routine = request.routineId ? this.get(request.routineId) : null;
    const workflow = request.workflow || routine?.workflow;
    if (!workflow) throw new Error("A workflow draft is required for testing.");
    const testRoutine = routine || toCompatibilityRoutine({
      id: `workflow-test:${randomUUID()}`,
      name: "Workflow test",
      enabled: false,
      workspaceId: "workflow-test",
      instructions: "Test a deterministic workflow draft.",
      executionTarget: { kind: "workspace" },
      contextBindings: {},
      triggers: [{ id: "manual", type: "manual", enabled: true }],
      outputs: [{ kind: "task_only" }],
      approvalPolicy: { mode: "auto_safe" },
      connectorPolicy: { mode: "prefer", connectorIds: [] },
      workflow,
      createdAt: this.deps.now(),
      updatedAt: this.deps.now(),
    });
    const run = await this.workflowEngine.start({
      routine: testRoutine,
      workflow,
      workflowVersionId: routine?.activeWorkflowVersionId || `draft:${randomUUID()}`,
      trigger: request.sampleEvent || { source: "test", timestamp: this.deps.now() },
      idempotencyKey: `test:${randomUUID()}`,
      dryRun: request.dryRun !== false,
    });
    return { run, steps: this.workflowRepository.listSteps(run.id) };
  }

  enqueueWorkflowEvent(envelope: RoutineWorkflowEventEnvelope) {
    const routine = this.get(envelope.routineId);
    const version = routine ? this.resolveActiveWorkflowVersion(routine) : null;
    if (!routine || !routine.enabled || !version) {
      throw new Error("The target Routine v2 workflow is not active.");
    }
    const event = this.workflowRepository.enqueueEvent(envelope);
    void this.processWorkflowInbox();
    return event;
  }

  async respondToWorkflowApproval(request: RoutineWorkflowApprovalRequest) {
    const run = this.workflowRepository.getRun(request.runId);
    if (!run) throw new Error(`Workflow run not found: ${request.runId}`);
    const routine = this.get(run.routineId);
    const version = this.workflowRepository.getVersion(run.workflowVersionId);
    if (!routine || !version) throw new Error("The workflow definition for this run is unavailable.");
    const updated = await this.workflowEngine.respondToApproval({
      routine,
      workflow: version.definition,
      runId: run.id,
      stepId: request.stepId,
      approved: request.approved,
    });
    this.refreshRoutineRunFromWorkflow(updated.id);
    return updated;
  }

  cancelWorkflowRun(runId: string) {
    const run = this.workflowEngine.cancel(runId);
    if (run) this.refreshRoutineRunFromWorkflow(run.id);
    return run;
  }

  async retryWorkflowRun(runId: string) {
    const previous = this.workflowRepository.getRun(runId);
    if (!previous) throw new Error(`Workflow run not found: ${runId}`);
    const routine = this.get(previous.routineId);
    const version = this.workflowRepository.getVersion(previous.workflowVersionId);
    if (!routine || !version) throw new Error("The workflow definition for this run is unavailable.");
    const context = previous.context as Record<string, Any>;
    return this.startDeterministicWorkflow(routine, version.definition, version.id, {
      trigger: isPlainRecord(context.trigger) ? context.trigger : {},
      idempotencyKey: `retry:${previous.id}:${this.deps.now()}`,
      sourceSummary: `Retry of workflow run ${previous.id}`,
      triggerId: previous.triggerNodeId,
      triggerType: "manual",
    });
  }

  startWorkflowRuntime(): void {
    if (this.workflowInboxTimer) return;
    this.workflowRecoveryReady = false;
    this.workflowRepository.requeueProcessingEvents();
    this.workflowInboxTimer = setInterval(() => void this.processWorkflowInbox(), 1_000);
    this.workflowMaintenanceTimer = setInterval(
      () => this.pruneExpiredWorkflowData(),
      6 * 60 * 60 * 1_000,
    );
    this.workflowMaintenanceTimer.unref?.();
    this.pruneExpiredWorkflowData();
    void this.recoverWorkflowRuns().finally(() => {
      this.workflowRecoveryReady = true;
      void this.processWorkflowInbox();
    });
  }

  stopWorkflowRuntime(): void {
    if (this.workflowInboxTimer) clearInterval(this.workflowInboxTimer);
    if (this.workflowMaintenanceTimer) clearInterval(this.workflowMaintenanceTimer);
    this.workflowInboxTimer = null;
    this.workflowMaintenanceTimer = null;
    this.workflowRecoveryReady = false;
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
    return dedupeRoutineRuns(rows.map((row) => this.mapRunRecord(row)));
  }

  async refreshRunsForTask(taskId: string): Promise<void> {
    const normalizedTaskId = taskId.trim();
    if (!normalizedTaskId || !this.deps.getTaskSnapshot) return;
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM routine_runs
         WHERE backing_task_id = ?
           AND (
             status IN ('queued', 'running')
             OR (status = 'failed' AND error_summary LIKE 'Timed out after %')
           )
         ORDER BY updated_at DESC`,
      )
      .all(normalizedTaskId) as Any[];
    for (const row of rows) {
      await this.refreshTaskBackedRun(this.mapRunRecord(row));
    }
  }

  async reconcileStaleTimeoutRuns(): Promise<void> {
    if (!this.deps.getTaskSnapshot) return;
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM routine_runs
         WHERE backing_task_id IS NOT NULL
           AND error_summary LIKE 'Timed out after %'
           AND status IN ('failed', 'running')
         ORDER BY updated_at DESC`,
      )
      .all() as Any[];
    for (const row of rows) {
      await this.refreshTaskBackedRun(this.mapRunRecord(row));
    }
  }

  async create(input: RoutineCreate): Promise<Routine> {
    const now = this.deps.now();
    let routine = toCompatibilityRoutine({
      id: randomUUID(),
      name: input.name.trim(),
      description: clean(input.description),
      enabled: input.enabled ?? true,
      workspaceId: input.workspaceId.trim(),
      instructions: normalizeInstructions(input.instructions ?? input.prompt),
      executionTarget: normalizeExecutionTarget(input.executionTarget),
      contextBindings: normalizeContextBindings(input.contextBindings),
      triggers: normalizeTriggers(
        input.triggers?.length
          ? input.triggers
          : input.workflow
            ? deriveRoutineTriggersFromWorkflow(input.workflow)
            : [],
      ),
      outputs: normalizeOutputs(input.outputs || []),
      approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
      connectorPolicy: normalizeConnectorPolicy(input.connectorPolicy, input.connectors),
      workflow: input.workflow ? structuredClone(input.workflow) : undefined,
      activeWorkflowVersionId: input.activeWorkflowVersionId,
      createdAt: now,
      updatedAt: now,
    });

    if (routine.workflow) {
      const validation = validateRoutineWorkflow(routine.workflow, { allowIncomplete: !routine.enabled });
      if (!validation.valid) {
        throw new Error(validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" "));
      }
      if (routine.enabled) {
        this.assertWorkflowSecretsReady(routine.workflow);
        this.assertWorkflowAccountReady(routine.workflow, validation.requiredScopes);
      }
      const version = this.workflowRepository.createVersion(
        routine.id,
        routine.workflow,
        routine.enabled ? "active" : "draft",
      );
      routine = toCompatibilityRoutine({
        ...routine,
        activeWorkflowVersionId: version.status === "active" ? version.id : undefined,
      });
    }

    const synced = await this.syncRoutine(routine, null);
    this.persist(synced);
    return synced;
  }

  async update(id: string, patch: RoutinePatch): Promise<Routine | null> {
    const existing = this.get(id);
    if (!existing) return null;

    let updated = toCompatibilityRoutine({
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
      workflow: patch.workflow !== undefined ? structuredClone(patch.workflow) : existing.workflow,
      activeWorkflowVersionId: existing.activeWorkflowVersionId,
      updatedAt: this.deps.now(),
    });

    if (patch.workflow !== undefined) {
      const validation = validateRoutineWorkflow(updated.workflow!, { allowIncomplete: !updated.enabled });
      if (!validation.valid) {
        throw new Error(validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" "));
      }
      if (updated.enabled) {
        this.assertWorkflowSecretsReady(updated.workflow!);
        this.assertWorkflowAccountReady(updated.workflow!, validation.requiredScopes);
      }
      const version = this.workflowRepository.createVersion(
        updated.id,
        updated.workflow!,
        updated.enabled ? "active" : "draft",
      );
      updated = toCompatibilityRoutine({
        ...updated,
        activeWorkflowVersionId: version.status === "active" ? version.id : existing.activeWorkflowVersionId,
      });
    } else if (patch.enabled === true && !existing.enabled) {
      const activeVersion = this.resolveActiveWorkflowVersion(existing);
      if (activeVersion) {
        const validation = validateRoutineWorkflow(activeVersion.definition);
        if (!validation.valid) {
          throw new Error(
            validation.issues
              .filter((issue) => issue.severity === "error")
              .map((issue) => issue.message)
              .join(" "),
          );
        }
        this.assertWorkflowSecretsReady(activeVersion.definition);
        this.assertWorkflowAccountReady(activeVersion.definition, validation.requiredScopes);
      }
    }

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
    this.workflowRepository.deleteRoutineData(id);
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

    const workflowVersion = this.resolveActiveWorkflowVersion(routine);
    if (workflowVersion) {
      return this.startDeterministicWorkflow(
        routine,
        workflowVersion.definition,
        workflowVersion.id,
        {
          trigger: {
            source: "manual",
            timestamp: this.deps.now(),
            routineId: routine.id,
          },
          idempotencyKey: `manual:${routine.id}:${this.deps.now()}`,
          sourceSummary: "Manual workflow run",
          triggerId: manualTrigger.id,
          triggerType: manualTrigger.type,
        },
      );
    }

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
    if (this.resolveActiveWorkflowVersion(routineMatch.routine)) return;

    const runKey = `cron:${event.jobId}:${event.runAtMs ?? event.nextRunAtMs ?? this.deps.now()}`;
    const existing = this.findRunByKey(runKey);
    const startedAt = event.runAtMs ?? existing?.startedAt ?? this.deps.now();
    const backingTaskId = event.taskId ?? existing?.backingTaskId;
    const base = {
      runKey,
      routineId: routineMatch.routine.id,
      triggerId: routineMatch.trigger.id,
      triggerType: routineMatch.trigger.type,
      startedAt,
      sourceEventSummary: summarizeCronEvent(event),
      backingTaskId,
      outputStatus: mapCronOutputStatus(
        event.status,
        Boolean(backingTaskId),
        Boolean(event.taskStillRunning),
      ),
    } as const;

    if (event.action === "started") {
      this.upsertRun({
        ...base,
        status: "running",
      });
      return;
    }

    const status = mapCronStatus(event.status, Boolean(backingTaskId), Boolean(event.taskStillRunning));
    this.upsertRun({
      ...base,
      finishedAt: status === "queued" || status === "running" ? undefined : this.deps.now(),
      status,
      errorSummary: event.error,
    });
  }

  async runScheduledWorkflow(routineId: string, jobId: string, runAtMs: number) {
    const routine = this.get(routineId);
    const version = routine ? this.resolveActiveWorkflowVersion(routine) : null;
    if (!routine || !routine.enabled || !version) {
      throw new Error("Scheduled Routine v2 workflow is not active.");
    }
    const trigger = routine.triggers.find(
      (candidate): candidate is RoutineScheduleTrigger =>
        candidate.type === "schedule" && candidate.managedCronJobId === jobId,
    );
    const run = await this.startDeterministicWorkflow(routine, version.definition, version.id, {
      trigger: {
        source: "schedule",
        timestamp: runAtMs,
        jobId,
        scheduledAt: new Date(runAtMs).toISOString(),
      },
      idempotencyKey: `cron:${jobId}:${runAtMs}`,
      sourceSummary: `Scheduled workflow run at ${new Date(runAtMs).toISOString()}`,
      triggerId: trigger?.id || version.definition.starterNodeId,
      triggerType: "schedule",
    });
    return {
      runId: run.workflowRunId || run.id,
      status: run.status,
      resultText: run.artifactsSummary,
      error: run.errorSummary,
    };
  }

  async runWebhookWorkflow(
    routineId: string,
    payload: Record<string, unknown>,
    metadata?: Record<string, string>,
  ) {
    const routine = this.get(routineId);
    const version = routine ? this.resolveActiveWorkflowVersion(routine) : null;
    if (!routine || !routine.enabled || !version) {
      throw new Error("Webhook Routine v2 workflow is not active.");
    }
    const trigger = routine.triggers.find(
      (candidate): candidate is RoutineApiTrigger =>
        candidate.type === "api" &&
        (!metadata?.triggerId || candidate.id === metadata.triggerId),
    );
    const externalId = [payload.id, payload.eventId, payload.event_id, payload.deliveryId]
      .find((value): value is string | number => typeof value === "string" || typeof value === "number");
    const idempotencyKey = externalId
      ? `webhook:${routine.id}:${String(externalId)}`
      : `webhook:${routine.id}:${this.deps.now()}:${JSON.stringify(payload)}`;
    const run = await this.startDeterministicWorkflow(routine, version.definition, version.id, {
      trigger: { ...payload, source: "webhook", timestamp: this.deps.now() },
      idempotencyKey,
      sourceSummary: metadata?.hookPath ? `Webhook: ${metadata.hookPath}` : "Webhook workflow",
      triggerId: trigger?.id || version.definition.starterNodeId,
      triggerType: "api",
    });
    return {
      runId: run.workflowRunId || run.id,
      status: run.status,
    };
  }

  recordEventTriggerFire(payload: {
    trigger: EventTrigger;
    event: TriggerEvent;
    historyEntry: TriggerHistoryEntry;
  }): void {
    if (payload.historyEntry.actionResult === "workflow_queued") return;
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

  async interceptManagedEventTrigger(trigger: EventTrigger, event: TriggerEvent) {
    const routineMatch = this.findRoutineByManagedResource("managedEventTriggerId", trigger.id);
    if (!routineMatch) return { handled: false };
    const version = this.resolveActiveWorkflowVersion(routineMatch.routine);
    if (!version) return { handled: false };
    const payload = {
      ...event.fields,
      source: event.source,
      timestamp: event.timestamp,
    };
    this.enqueueWorkflowEvent({
      routineId: routineMatch.routine.id,
      triggerNodeId: version.definition.starterNodeId,
      source: event.source,
      idempotencyKey: `${trigger.id}:${event.timestamp}:${JSON.stringify(event.fields)}`,
      receivedAt: event.timestamp,
      payload,
      summary: summarizeTriggerEvent(event),
    });
    return { handled: true, actionResult: "workflow_queued" };
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
        workflow_run_id TEXT,
        output_status TEXT NOT NULL DEFAULT 'none',
        error_summary TEXT,
        artifacts_summary TEXT,
        run_key TEXT,
        dedupe_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
      ON routine_runs(routine_id, started_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_routine_runs_backing_task
      ON routine_runs(routine_id, backing_task_id);
    `);

    if (!columnExists(this.deps.db, "automation_routines", "definition_json")) {
      this.deps.db.exec("ALTER TABLE automation_routines ADD COLUMN definition_json TEXT");
    }
    if (!columnExists(this.deps.db, "routine_runs", "run_key")) {
      this.deps.db.exec("ALTER TABLE routine_runs ADD COLUMN run_key TEXT");
    }
    if (!columnExists(this.deps.db, "routine_runs", "dedupe_key")) {
      this.deps.db.exec("ALTER TABLE routine_runs ADD COLUMN dedupe_key TEXT");
    }
    if (!columnExists(this.deps.db, "routine_runs", "workflow_run_id")) {
      this.deps.db.exec("ALTER TABLE routine_runs ADD COLUMN workflow_run_id TEXT");
    }
    this.reconcileRoutineRunDedupeKeys();
    this.deps.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_routine_runs_run_key
      ON routine_runs(run_key);
      CREATE INDEX IF NOT EXISTS idx_routine_runs_workflow
      ON routine_runs(workflow_run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_runs_dedupe_key
      ON routine_runs(dedupe_key)
      WHERE dedupe_key IS NOT NULL;
    `);
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
      workflowRunId: row.workflow_run_id ? String(row.workflow_run_id) : undefined,
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
    const targetTaskId = getRoutineTargetTaskId(routine);
    const workflowMode = Boolean(routine.workflow && routine.activeWorkflowVersionId);
    const payload = {
      name: `Routine: ${routine.name}`,
      description: routine.description,
      enabled: routine.enabled && trigger.enabled,
      workspaceId: routine.workspaceId,
      taskPrompt: workflowMode
        ? `Execute active Routine v2 workflow ${routine.id}.`
        : buildRoutinePrompt(routine, "schedule"),
      taskTitle: routine.name,
      schedule: trigger.schedule,
      runMode: workflowMode
        ? ("workflow" as const)
        : targetTaskId
          ? ("thread_follow_up" as const)
          : ("new_task" as const),
      workflowRoutineId: workflowMode ? routine.id : undefined,
      targetTaskId: workflowMode ? undefined : targetTaskId,
      threadAutomation: !workflowMode && targetTaskId
        ? {
            sourceTaskId: targetTaskId,
            sourceTaskTitle: routine.contextBindings.metadata?.sourceTaskTitle,
            sourceLink: routine.contextBindings.metadata?.sourceLink,
            wakeObjective: routine.instructions,
            includeContextBrief: true,
          }
        : undefined,
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
      const targetTaskId = getRoutineTargetTaskId(routine);
      const workflowMode = Boolean(routine.workflow && routine.activeWorkflowVersionId);
      const mapping: HookMappingConfig = {
        id: managedHookMappingId,
        token,
        match: { path },
        action: workflowMode ? "workflow" : targetTaskId ? "task_message" : "agent",
        targetTaskId: workflowMode ? undefined : targetTaskId,
        name: routine.name,
        workspaceId: routine.workspaceId,
        messageTemplate: workflowMode
          ? undefined
          : buildRoutinePrompt(routine, "api", [
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

    const targetTaskId = getRoutineTargetTaskId(routine);
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
          runMode: targetTaskId ? "thread_follow_up" : "new_task",
          targetTaskId,
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

  private resolveActiveWorkflowVersion(routine: Routine) {
    if (routine.activeWorkflowVersionId) {
      const version = this.workflowRepository.getVersion(routine.activeWorkflowVersionId);
      if (version?.status === "active") return version;
    }
    return this.workflowRepository.getActiveVersion(routine.id);
  }

  private assertWorkflowAccountReady(
    workflow: RoutineWorkflowDefinition,
    requiredScopes: string[],
  ): void {
    if (requiredScopes.length === 0) return;
    const accountEmail = workflow.accountBindings?.["google-workspace"];
    const settings = getGoogleWorkspaceSettingsForAccount(
      GoogleWorkspaceSettingsManager.loadSettings(),
      accountEmail,
    );
    if (!settings.enabled || !hasGoogleWorkspaceTokens(settings)) {
      throw new Error("Connect Google Workspace before turning on this flow.");
    }
    const granted = new Set((settings.scopes || []).map((scope) => scope.toLocaleLowerCase()));
    const missing = requiredScopes.filter((scope) => !googleScopeIsCovered(scope, granted));
    if (missing.length > 0) {
      throw new Error(
        `Reconnect Google Workspace and grant the required scopes: ${missing
          .map((scope) => scope.replace("https://www.googleapis.com/auth/", ""))
          .join(", ")}.`,
      );
    }
  }

  private assertWorkflowSecretsReady(workflow: RoutineWorkflowDefinition): void {
    for (const node of flattenWorkflowNodes(workflow.nodes)) {
      if (node.operation !== "custom.webhook") continue;
      const secretRef = typeof node.config.secretRef === "string" ? node.config.secretRef.trim() : "";
      if (!secretRef) throw new Error(`Select a signing secret for ${node.name}.`);
      this.workflowSecretStore.resolve(secretRef);
    }
  }

  private async startDeterministicWorkflow(
    routine: Routine,
    workflow: RoutineWorkflowDefinition,
    workflowVersionId: string,
    params: {
      trigger: Record<string, unknown>;
      eventId?: string;
      idempotencyKey: string;
      sourceSummary: string;
      triggerId: string;
      triggerType: RoutineTrigger["type"];
      dryRun?: boolean;
    },
  ): Promise<RoutineRun> {
    const workflowRun = await this.workflowEngine.start({
      routine,
      workflow,
      workflowVersionId,
      trigger: params.trigger,
      eventId: params.eventId,
      idempotencyKey: params.idempotencyKey,
      dryRun: params.dryRun,
    });
    const run = this.upsertRun({
      runKey: `workflow:${workflowRun.id}`,
      routineId: routine.id,
      triggerId: params.triggerId,
      triggerType: params.triggerType,
      status: mapWorkflowRunStatus(workflowRun.status),
      startedAt: workflowRun.startedAt || workflowRun.createdAt,
      finishedAt: workflowRun.finishedAt,
      sourceEventSummary: params.sourceSummary,
      workflowRunId: workflowRun.id,
      outputStatus: "none",
      errorSummary: workflowRun.error,
      artifactsSummary: summarizeWorkflowRun(workflowRun, this.workflowRepository.listSteps(workflowRun.id)),
    });
    return run;
  }

  private async processWorkflowInbox(): Promise<void> {
    if (!this.workflowRecoveryReady) return;
    while (this.workflowInboxActive < 4) {
      const event = this.workflowRepository.claimNextEvent();
      if (!event) return;
      this.workflowInboxActive += 1;
      void this.processWorkflowEvent(event).finally(() => {
        this.workflowInboxActive = Math.max(0, this.workflowInboxActive - 1);
        void this.processWorkflowInbox();
      });
    }
  }

  private async processWorkflowEvent(event: ReturnType<RoutineWorkflowRepository["enqueueEvent"]>): Promise<void> {
    try {
      const routine = this.get(event.routineId);
      const version = routine ? this.resolveActiveWorkflowVersion(routine) : null;
      if (!routine || !routine.enabled || !version) {
        this.workflowRepository.updateEvent(event.id, {
          status: "cancelled",
          error: "Routine was disabled or removed before this event was processed.",
        });
        return;
      }
      const routineTrigger = routine.triggers.find((trigger) => trigger.id === event.triggerNodeId);
      const run = await this.startDeterministicWorkflow(routine, version.definition, version.id, {
        trigger: event.payload,
        eventId: event.id,
        idempotencyKey: event.idempotencyKey,
        sourceSummary: event.summary || `${event.source} event`,
        triggerId: routineTrigger?.id || event.triggerNodeId,
        triggerType: routineTrigger?.type || "manual",
      });
      this.workflowRepository.updateEvent(event.id, {
        status: run.status === "failed" ? "failed" : "completed",
        runId: run.workflowRunId,
        error: run.errorSummary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (event.attemptCount < 5) {
        this.workflowRepository.updateEvent(event.id, {
          status: "pending",
          error: message,
          availableAt: this.deps.now() + Math.min(60_000, 1_000 * 2 ** event.attemptCount),
        });
      } else {
        this.workflowRepository.updateEvent(event.id, { status: "failed", error: message });
      }
    }
  }

  private async recoverWorkflowRuns(): Promise<void> {
    for (const run of this.workflowRepository.listRecoverableRuns()) {
      const routine = this.get(run.routineId);
      const version = this.workflowRepository.getVersion(run.workflowVersionId);
      if (!routine || !version) {
        this.workflowRepository.updateRun(run.id, {
          status: "failed",
          error: "Workflow definition was unavailable during recovery.",
          finishedAt: this.deps.now(),
        });
        continue;
      }
      const recovered = this.workflowEngine.recoverInterruptedRun(version.definition, run.id);
      if (recovered?.status === "waiting_for_approval") {
        this.refreshRoutineRunFromWorkflow(run.id);
        continue;
      }
      await this.workflowEngine.continueRun(routine, version.definition, run.id).catch((error) => {
        this.workflowRepository.updateRun(run.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          finishedAt: this.deps.now(),
        });
      });
      this.refreshRoutineRunFromWorkflow(run.id);
    }
  }

  private pruneExpiredWorkflowData(): void {
    try {
      this.workflowRepository.pruneExpiredData((workflowVersionId) => {
        const version = this.workflowRepository.getVersion(workflowVersionId);
        return version?.definition.settings?.retainStepDataDays || 30;
      });
    } catch (error) {
      logger.warn("Workflow retention maintenance failed:", error);
    }
  }

  private refreshRoutineRunFromWorkflow(workflowRunId: string): void {
    const workflowRun = this.workflowRepository.getRun(workflowRunId);
    if (!workflowRun) return;
    const row = this.deps.db
      .prepare("SELECT * FROM routine_runs WHERE workflow_run_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(workflowRunId) as Any | undefined;
    if (!row) return;
    const existing = this.mapRunRecord(row);
    this.upsertRun({
      ...existing,
      workflowRunId,
      status: mapWorkflowRunStatus(workflowRun.status),
      finishedAt: workflowRun.finishedAt,
      errorSummary: workflowRun.error,
      artifactsSummary: summarizeWorkflowRun(workflowRun, this.workflowRepository.listSteps(workflowRunId)),
    });
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

      const targetTaskId = getRoutineTargetTaskId(routine);
      if (targetTaskId) {
        if (!this.deps.sendTaskMessage) {
          throw new Error("Thread follow-up execution is not available in this runtime");
        }
        await this.deps.sendTaskMessage({
          taskId: targetTaskId,
          message: params.prompt,
          agentConfig,
        });
        return {
          taskId: targetTaskId,
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
             WHERE routine_id = ?
               AND (
                 status IN ('queued', 'running')
                 OR (status = 'failed' AND backing_task_id IS NOT NULL AND error_summary LIKE 'Timed out after %')
               )
             ORDER BY updated_at DESC`,
          )
          .all(routineId)
      : this.deps.db
          .prepare(
            `SELECT * FROM routine_runs
             WHERE status IN ('queued', 'running')
                OR (status = 'failed' AND backing_task_id IS NOT NULL AND error_summary LIKE 'Timed out after %')
             ORDER BY updated_at DESC`,
          )
          .all()) as Any[];

    for (const row of rows) {
      const run = this.mapRunRecord(row);
      if (run.workflowRunId) {
        this.refreshRoutineRunFromWorkflow(run.workflowRunId);
        continue;
      }
      if (run.backingTaskId && this.deps.getTaskSnapshot && isCronTimeoutSummary(run.errorSummary)) {
        await this.refreshTaskBackedRun(run);
        continue;
      }

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
        await this.refreshTaskBackedRun(run);
      }
    }
  }

  private async refreshTaskBackedRun(run: RoutineRunRecord): Promise<void> {
    if (!run.backingTaskId || !this.deps.getTaskSnapshot) return;
    const snapshot = await this.deps.getTaskSnapshot(run.backingTaskId);
    if (!snapshot) return;
    const status = mapTaskSnapshotStatus(snapshot.status, snapshot.terminalStatus);
    const routine = this.get(run.routineId);
    const isNonTerminal = status === "queued" || status === "running";
    const isFailed = status === "failed";
    this.upsertRun({
      ...run,
      status,
      finishedAt: isNonTerminal ? undefined : snapshot.completedAt || run.finishedAt || this.deps.now(),
      outputStatus: mapTaskBackedOutputStatus(run.outputStatus, status, routine),
      errorSummary: isFailed
        ? snapshot.error || run.errorSummary
        : isCronTimeoutSummary(run.errorSummary)
          ? undefined
          : run.errorSummary,
      artifactsSummary: snapshot.resultSummary || run.artifactsSummary,
    });
  }

  private upsertRun(input: {
    id?: string;
    runKey?: string;
    routineId: string;
    triggerId: string;
    triggerType: RoutineTrigger["type"];
    status: RoutineRunStatus;
    startedAt: number;
    createdAt?: number;
    finishedAt?: number;
    sourceEventSummary?: string;
    backingTaskId?: string;
    backingManagedSessionId?: string;
    workflowRunId?: string;
    outputStatus: RoutineRun["outputStatus"];
    errorSummary?: string;
    artifactsSummary?: string;
  }): RoutineRun {
    const now = this.deps.now();
    const dedupeKey = this.computeRoutineRunDedupeKey(input);
    const existing =
      (dedupeKey ? this.findRunByDedupeKey(dedupeKey) : null) ||
      (input.runKey ? this.findRunByKey(input.runKey) : null) ||
      (input.id ? this.findRunById(input.id) : null);
    const id = existing?.id || input.id || randomUUID();
    const createdAt = existing?.createdAt || input.createdAt || now;
    this.deps.db
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
        dedupeKey || null,
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
      workflowRunId: input.workflowRunId,
      outputStatus: input.outputStatus,
      errorSummary: input.errorSummary,
      artifactsSummary: input.artifactsSummary,
      createdAt,
      updatedAt: now,
    };
  }

  private findRunByDedupeKey(dedupeKey: string): RoutineRunRecord | null {
    const row = this.deps.db
      .prepare("SELECT * FROM routine_runs WHERE dedupe_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(dedupeKey) as Any | undefined;
    return row ? this.mapRunRecord(row) : null;
  }

  private findRunByKey(runKey: string): RoutineRunRecord | null {
    const row = this.deps.db
      .prepare("SELECT * FROM routine_runs WHERE run_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(runKey) as Any | undefined;
    return row ? this.mapRunRecord(row) : null;
  }

  private findRunById(id: string): RoutineRunRecord | null {
    const row = this.deps.db.prepare("SELECT * FROM routine_runs WHERE id = ?").get(id) as
      | Any
      | undefined;
    return row ? this.mapRunRecord(row) : null;
  }

  private computeRoutineRunDedupeKey(input: {
    routineId: string;
    runKey?: string;
    backingTaskId?: string;
    backingManagedSessionId?: string;
    workflowRunId?: string;
  }): string | null {
    const normalizedManagedSessionId = String(input.backingManagedSessionId || "").trim();
    if (normalizedManagedSessionId) {
      return `managed:${input.routineId}:${normalizedManagedSessionId}`;
    }

    const normalizedWorkflowRunId = String(input.workflowRunId || "").trim();
    if (normalizedWorkflowRunId) {
      return `workflow:${input.routineId}:${normalizedWorkflowRunId}`;
    }

    const normalizedTaskId = String(input.backingTaskId || "").trim();
    if (normalizedTaskId) {
      const routine = this.get(input.routineId);
      const targetTaskId = routine ? getRoutineTargetTaskId(routine) : null;
      if (!targetTaskId || targetTaskId !== normalizedTaskId) {
        return `task:${input.routineId}:${normalizedTaskId}`;
      }
    }

    const normalizedRunKey = String(input.runKey || "").trim();
    if (normalizedRunKey) return `key:${input.routineId}:${normalizedRunKey}`;
    return null;
  }

  private reconcileRoutineRunDedupeKeys(): void {
    const rows = this.deps.db.prepare("SELECT * FROM routine_runs").all() as Any[];
    const groups = new Map<string, RoutineRunRecord[]>();
    const rowsWithoutKey: RoutineRunRecord[] = [];
    for (const row of rows) {
      const run = this.mapRunRecord(row);
      const dedupeKey = this.computeRoutineRunDedupeKey(run);
      if (!dedupeKey) {
        rowsWithoutKey.push(run);
        continue;
      }
      run.dedupeKey = dedupeKey;
      const existing = groups.get(dedupeKey) || [];
      existing.push(run);
      groups.set(dedupeKey, existing);
    }

    const updateKey = this.deps.db.prepare("UPDATE routine_runs SET dedupe_key = ? WHERE id = ?");
    const clearKey = this.deps.db.prepare("UPDATE routine_runs SET dedupe_key = NULL WHERE id = ?");
    const deleteRun = this.deps.db.prepare("DELETE FROM routine_runs WHERE id = ?");
    const apply = this.deps.db.transaction(() => {
      for (const run of rowsWithoutKey) {
        clearKey.run(run.id);
      }
      for (const [dedupeKey, runs] of groups.entries()) {
        if (runs.length === 1) {
          updateKey.run(dedupeKey, runs[0].id);
          continue;
        }
        const preferred = runs.reduce((best, candidate) => preferRoutineRun(best, candidate));
        for (const run of runs) {
          if (run.id === preferred.id) {
            updateKey.run(dedupeKey, run.id);
          } else {
            deleteRun.run(run.id);
          }
        }
      }
    });
    apply();
  }

  private mapRunRecord(row: Any): RoutineRunRecord {
    return {
      ...this.mapRunRow(row),
      runKey: row.run_key ? String(row.run_key) : undefined,
      dedupeKey: row.dedupe_key ? String(row.dedupe_key) : undefined,
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

function getRoutineTargetTaskId(routine: Routine): string | undefined {
  const metadata: RoutineContextBindings["metadata"] = routine.contextBindings.metadata || {};
  const runMode = metadata.runMode || metadata.automationRunMode;
  const targetTaskId = [
    metadata.targetTaskId,
    metadata.sourceTaskId,
    metadata.threadTaskId,
    metadata.taskId,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!targetTaskId) return undefined;
  if (
    runMode === "thread_follow_up" ||
    runMode === "continue_thread" ||
    metadata.threadAutomation === "true"
  ) {
    return targetTaskId;
  }
  return undefined;
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

function deriveRoutineTriggersFromWorkflow(workflow: RoutineWorkflowDefinition): RoutineTrigger[] {
  const starter = workflow.nodes.find((node) => node.id === workflow.starterNodeId && node.kind === "starter");
  if (!starter) return [];
  const config = starter.config;
  const value = (key: string): string | undefined => {
    const candidate = config[key];
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
    return undefined;
  };
  // Structured workflows have their own durable, deduplicated inbox. Do not
  // apply the legacy trigger cooldown or rapid source events would be lost.
  const base = { id: starter.id, enabled: true, cooldownMs: 0 };
  switch (starter.operation) {
    case "starter.schedule": {
      const kind = value("scheduleKind") || "cron";
      const expression = value("expression") || "0 9 * * 1-5";
      if (kind === "every") {
        return [{ ...base, type: "schedule", schedule: { kind: "every", everyMs: Math.max(60_000, Number(expression) * 60_000) } }];
      }
      if (kind === "at") {
        const atMs = Number.isFinite(Number(expression)) ? Number(expression) : Date.parse(expression);
        return [{ ...base, type: "schedule", schedule: { kind: "at", atMs } }];
      }
      return [{ ...base, type: "schedule", schedule: { kind: "cron", expr: expression, tz: value("timezone") } }];
    }
    case "starter.gmail_message":
      return [{
        ...base,
        type: "mailbox_event",
        provider: "gmail",
        eventType: "message_received",
        subjectContains: value("subjectContains"),
        labelContains: value("label"),
      }];
    case "starter.chat_message":
    case "starter.chat_mention":
    case "starter.chat_reaction":
    case "starter.chat_member_joined":
      return [{
        ...base,
        type: "channel_event",
        channelType: "google_chat",
        chatId: value("spaceName"),
        textContains: value("textPattern"),
        senderContains: value("sender"),
      }];
    case "starter.sheet_changed":
      return [{
        ...base,
        type: "connector_event",
        connectorId: "google-workspace",
        changeType: "sheet_changed",
        resourceUriContains: value("spreadsheetId"),
      }];
    case "starter.drive_item_added":
    case "starter.drive_file_edited":
    case "starter.drive_folder_item_edited":
    case "starter.meeting_relative":
    case "starter.meeting_outputs_ready":
    case "starter.form_response":
      return [{
        ...base,
        type: "connector_event",
        connectorId: "google-workspace",
        changeType: starter.operation.replace(/^starter\./, ""),
        resourceUriContains:
          value("folderId") || value("fileId") || value("formId") || value("calendarId"),
      }];
    case "starter.manual":
    default:
      return [{ ...base, type: "manual" }];
  }
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

function mapCronStatus(
  status?: CronEvent["status"],
  hasTaskId = false,
  taskStillRunning = false,
): RoutineRunStatus {
  if (status === "timeout" && hasTaskId && taskStillRunning) return "running";
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
  taskStillRunning = false,
): RoutineRun["outputStatus"] {
  if (!hasTaskId) return "none";
  if (status === "timeout" && taskStillRunning) return "queued";
  if (status === "error" || status === "timeout") return "failed";
  return "queued";
}

function mapTaskBackedOutputStatus(
  current: RoutineRun["outputStatus"],
  status: RoutineRunStatus,
  routine?: Routine | null,
): RoutineRun["outputStatus"] {
  if (status === "failed") return "failed";
  if (current === "failed") return routineOutputStatusAfterTaskCompletion(routine);
  return current;
}

function routineOutputStatusAfterTaskCompletion(routine?: Routine | null): RoutineRun["outputStatus"] {
  if (!routine) return "queued";
  if (routineHasWebhookResponse(routine)) return "responded";
  return routine.outputs.some((output) => output.kind !== "task_only") ? "queued" : "none";
}

function isCronTimeoutSummary(value?: string): boolean {
  return typeof value === "string" && /^Timed out after \d+s$/i.test(value.trim());
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

function dedupeRoutineRuns(runs: RoutineRunRecord[]): RoutineRun[] {
  const out: RoutineRunRecord[] = [];
  const seen = new Map<string, number>();
  for (const run of runs) {
    const key = routineRunDedupeKey(run);
    if (!key) {
      out.push(run);
      continue;
    }

    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, out.length);
      out.push(run);
      continue;
    }

    out[existingIndex] = preferRoutineRun(out[existingIndex], run);
  }
  return out;
}

function routineRunDedupeKey(run: RoutineRunRecord): string | null {
  if (run.workflowRunId) return `workflow:${run.routineId}:${run.workflowRunId}`;
  if (run.backingTaskId) return `task:${run.routineId}:${run.backingTaskId}`;
  if (run.backingManagedSessionId) return `managed:${run.routineId}:${run.backingManagedSessionId}`;
  if (run.runKey) return `key:${run.routineId}:${run.runKey}`;
  return null;
}

function mapWorkflowRunStatus(status: RoutineWorkflowRunRecord["status"]): RoutineRunStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "waiting_for_approval":
      return "needs_user_action";
    case "completed":
      return "completed";
    case "partial_success":
      return "partial_success";
    case "cancelled":
    case "failed":
      return "failed";
  }
}

function summarizeWorkflowRun(
  run: RoutineWorkflowRunRecord,
  steps: RoutineWorkflowStepRecord[],
): string {
  const completed = steps.filter((step) => step.status === "completed").length;
  const waiting = steps.filter((step) => step.status === "waiting_for_approval").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  return [
    `Workflow run ${run.id}`,
    `${completed}/${steps.length} steps completed`,
    waiting > 0 ? `${waiting} approval${waiting === 1 ? "" : "s"} pending` : "",
    failed > 0 ? `${failed} failed` : "",
  ].filter(Boolean).join(" · ");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function flattenWorkflowNodes(nodes: RoutineWorkflowDefinition["nodes"]): RoutineWorkflowDefinition["nodes"] {
  return nodes.flatMap((node) => [node, ...flattenWorkflowNodes(node.children || [])]);
}

function googleScopeIsCovered(requiredScope: string, granted: Set<string>): boolean {
  const required = requiredScope.toLocaleLowerCase();
  if (granted.has(required)) return true;
  if (required.endsWith("/gmail.readonly") && granted.has("https://www.googleapis.com/auth/gmail.modify")) {
    return true;
  }
  if (required.includes("/drive.") && granted.has("https://www.googleapis.com/auth/drive")) {
    return true;
  }
  return false;
}

function preferRoutineRun(a: RoutineRunRecord, b: RoutineRunRecord): RoutineRunRecord {
  const score = (run: RoutineRunRecord) => {
    const terminal = run.status === "completed" || run.status === "failed" ? 4 : 0;
    const needsUser = run.status === "needs_user_action" ? 3 : 0;
    const partial = run.status === "partial_success" ? 2 : 0;
    const hasEvidence = run.errorSummary || run.artifactsSummary ? 1 : 0;
    return terminal + needsUser + partial + hasEvidence;
  };
  const aScore = score(a);
  const bScore = score(b);
  if (aScore !== bScore) return bScore > aScore ? b : a;
  return b.updatedAt > a.updatedAt ? b : a;
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
