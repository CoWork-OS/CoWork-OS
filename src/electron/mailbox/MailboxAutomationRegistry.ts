import { bindStatementContext } from "../database/statements/statement-burst";
import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { createMailboxStatementPort, type MailboxStatementPort } from "./mailbox-statement-port";
import { getCronService } from "../cron";
import { computeNextRunAtMs } from "../cron/schedule";
import type { CronEvent, CronJobCreate, CronJobPatch } from "../cron/types";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../shared/access-profiles";
import type { EventTriggerService } from "../triggers/EventTriggerService";
import type {
  EventTrigger,
  TriggerCondition,
  TriggerEvent,
  TriggerHistoryEntry,
} from "../triggers/types";
import type {
  MailboxAutomationRecord,
  MailboxForwardRecipe,
  MailboxAutomationStatus,
  MailboxRuleRecipe,
  MailboxScheduleRecipe,
} from "../../shared/mailbox";

type MailboxAutomationAuditEvent =
  | "created"
  | "updated"
  | "deleted"
  | "trigger_fired"
  | "cron_added"
  | "cron_updated"
  | "cron_started"
  | "cron_finished"
  | "cron_removed"
  | "forward_run_started"
  | "forward_run_finished";

type MailboxAutomationRegistryDeps = {
  db: Database.Database;
  triggerService?: EventTriggerService | null;
  resolveDefaultWorkspaceId: () => string | undefined;
  log?: (...args: unknown[]) => void;
  onMutation?: () => void;
};

type MailboxAutomationRow = {
  id: string;
  workspace_id: string;
  kind: MailboxAutomationRecord["kind"];
  status: MailboxAutomationStatus;
  name: string;
  description: string | null;
  thread_id: string | null;
  source: MailboxAutomationRecord["source"];
  recipe_json: string;
  backing_trigger_id: string | null;
  backing_cron_job_id: string | null;
  latest_outcome: string | null;
  latest_fire_at: number | null;
  latest_run_at: number | null;
  next_run_at: number | null;
  latest_error: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxAutomationAuditRow = {
  id: string;
  automation_id: string;
  workspace_id: string;
  event_type: MailboxAutomationAuditEvent;
  detail_json: string;
  created_at: number;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function ruleTriggerName(recipe: MailboxRuleRecipe): string {
  return recipe.name.trim();
}

function scheduleJobName(recipe: MailboxScheduleRecipe): string {
  return recipe.name.trim();
}

function forwardingJobName(recipe: MailboxForwardRecipe): string {
  return recipe.name.trim();
}

function normalizeStringArray(values: unknown, lowercase = true): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeString(value))
    .filter((value): value is string => Boolean(value))
    .map((value) => (lowercase ? value.toLowerCase() : value))
    .filter((value, index, array) => array.indexOf(value) === index);
}

export class MailboxAutomationRegistry {
  private static deps: MailboxAutomationRegistryDeps | null = null;
  private static sql: MailboxStatementPort | null = null;

  /** `deps.db` is used only to create the schema; statements go through the mailbox port. */
  static configure(deps: MailboxAutomationRegistryDeps): void {
    this.deps = deps;
    this.ensureSchema();
    this.sql = createMailboxStatementPort(deps.db);
  }

  static reset(): void {
    this.deps = null;
    this.sql = null;
  }

  private static statements(): MailboxStatementPort {
    if (!this.sql) {
      throw new Error("Mailbox automation registry is not configured");
    }
    return this.sql;
  }

  static async listAutomations(input?: {
    workspaceId?: string;
    threadId?: string;
  }): Promise<MailboxAutomationRecord[]> {
    const workspaceId = input?.workspaceId || null;
    const threadId = input?.threadId || null;
    const rows = await this.statements().all<MailboxAutomationRow>("automation_listAutomations", [
      workspaceId,
      workspaceId,
      threadId,
      threadId,
    ]);

    return rows.map((row) => this.enrichRecord(row));
  }

  static listThreadAutomations(threadId: string): Promise<MailboxAutomationRecord[]> {
    return this.listAutomations({ threadId });
  }

  static async listAutomationHistory(
    automationId: string,
    limit = 25,
  ): Promise<MailboxAutomationAuditRow[]> {
    const deps = this.getDeps();
    return (await this.statements().all("automation_listAutomationHistory_1", [
      automationId,
      Math.min(Math.max(limit, 1), 100),
    ])) as MailboxAutomationAuditRow[];
  }

  static async createRule(recipe: MailboxRuleRecipe): Promise<MailboxAutomationRecord> {
    const deps = this.getDeps();
    const workspaceId = recipe.workspaceId?.trim() || deps.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No default workspace available for mailbox automation");
    }
    const triggerService = deps.triggerService;
    if (!triggerService) {
      throw new Error("Trigger service is not available");
    }
    if (recipe.actionType === "wake_agent" && !recipe.agentRoleId?.trim()) {
      throw new Error("Missing agentRoleId for wake_agent rule");
    }

    const automationId = randomUUID();
    const now = Date.now();
    const trigger = await triggerService.addTrigger({
      name: ruleTriggerName(recipe),
      description: recipe.description,
      enabled: recipe.enabled ?? true,
      source: recipe.source || "mailbox_event",
      conditions: recipe.conditions as TriggerCondition[],
      conditionLogic: recipe.conditionLogic || "all",
      action:
        recipe.actionType === "wake_agent"
          ? {
              type: "wake_agent",
              config: {
                agentRoleId: recipe.agentRoleId || "",
                prompt: recipe.actionPrompt,
              },
            }
          : {
              type: "create_task",
              config: {
                title: recipe.actionTitle || recipe.name,
                prompt: recipe.actionPrompt,
                workspaceId,
              },
            },
      workspaceId,
      cooldownMs: recipe.cooldownMs,
    });

    const record: MailboxAutomationRecord = {
      id: automationId,
      workspaceId,
      kind: "rule",
      status: recipe.enabled === false ? "paused" : "active",
      name: recipe.name,
      description: recipe.description,
      threadId: recipe.threadId,
      source: "mailbox_event",
      rule: { ...recipe, source: "mailbox_event" },
      backingTriggerId: trigger.id,
      createdAt: now,
      updatedAt: now,
    };

    await this.insertRecord(record, {
      automationId,
      workspaceId,
      eventType: "created",
      detail: { kind: "rule", triggerId: trigger.id },
    });
    const created = await this.fetchRow(automationId);
    if (!created) {
      throw new Error("Failed to persist mailbox rule");
    }
    return this.enrichRecord(created);
  }

  static async updateRule(
    automationId: string,
    patch: Partial<MailboxRuleRecipe> & { status?: MailboxAutomationStatus },
  ): Promise<MailboxAutomationRecord | null> {
    const deps = this.getDeps();
    const row = await this.fetchRow(automationId);
    if (!row || row.kind !== "rule") return null;

    const record = this.enrichRecord(row);
    const nextRule = {
      ...(record.rule || {
        name: record.name,
        conditions: [],
        actionType: "create_task",
        actionPrompt: "",
      }),
      ...patch,
      source: "mailbox_event" as const,
    };
    const triggerService = deps.triggerService;
    if (record.backingTriggerId && triggerService) {
      const existing = triggerService.getTrigger(record.backingTriggerId);
      if (existing) {
        await triggerService.updateTrigger(record.backingTriggerId, {
          name: nextRule.name ?? record.name,
          description: nextRule.description ?? record.description,
          enabled: patch.status ? patch.status === "active" : existing.enabled,
          source: "mailbox_event",
          conditions: nextRule.conditions as TriggerCondition[],
          conditionLogic: nextRule.conditionLogic || "all",
          cooldownMs: nextRule.cooldownMs ?? existing.cooldownMs,
          action:
            nextRule.actionType === "wake_agent"
              ? {
                  type: "wake_agent",
                  config: {
                    agentRoleId: nextRule.agentRoleId || "",
                    prompt: nextRule.actionPrompt,
                  },
                }
              : {
                  type: "create_task",
                  config: {
                    title: nextRule.actionTitle || nextRule.name,
                    prompt: nextRule.actionPrompt,
                    workspaceId: record.workspaceId,
                  },
                },
        });
      }
    }

    const now = Date.now();
    const nextStatus = patch.status ?? record.status;
    await this.statements().run("automation_updateRule_1", [
      normalizeString(nextRule.name) || record.name,
      nextRule.description || null,
      nextStatus,
      nextRule.threadId || null,
      stringifyJson(nextRule),
      now,
      automationId,
    ]);
    await this.appendAudit(automationId, record.workspaceId, "updated", { patch });
    deps.onMutation?.();
    return (
      (await this.listAutomations({ workspaceId: record.workspaceId })).find(
        (item) => item.id === automationId,
      ) ?? null
    );
  }

  static async deleteRule(automationId: string): Promise<boolean> {
    const deps = this.getDeps();
    const row = await this.fetchRow(automationId);
    if (!row || row.kind !== "rule") return false;
    const record = this.enrichRecord(row);
    if (record.backingTriggerId && deps.triggerService) {
      await deps.triggerService.removeTrigger(record.backingTriggerId);
    }
    await this.markDeleted(record.id, record.workspaceId, {
      backingTriggerId: record.backingTriggerId,
    });
    return true;
  }

  static async createForward(recipe: MailboxForwardRecipe): Promise<MailboxAutomationRecord> {
    const deps = this.getDeps();
    const workspaceId = recipe.workspaceId?.trim() || deps.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No default workspace available for mailbox automation");
    }
    if (!normalizeString(recipe.targetEmail)) {
      throw new Error("Target email is required for forwarding automation");
    }
    const allowedSenders = normalizeStringArray(recipe.allowedSenders);
    const allowedDomains = normalizeStringArray(recipe.allowedDomains);
    if (allowedSenders.length === 0 && allowedDomains.length === 0) {
      throw new Error("At least one allowed sender or domain is required");
    }

    const automationId = randomUUID();
    const now = Date.now();
    const normalizedRecipe: MailboxForwardRecipe = {
      ...recipe,
      workspaceId,
      name: forwardingJobName(recipe),
      targetEmail: recipe.targetEmail.trim(),
      providerThreadId: normalizeString(recipe.providerThreadId),
      allowedSenders,
      allowedDomains,
      excludedSenders: normalizeStringArray(recipe.excludedSenders),
      excludedDomains: normalizeStringArray(recipe.excludedDomains),
      subjectKeywords: normalizeStringArray(recipe.subjectKeywords),
      attachmentKeywords: normalizeStringArray(recipe.attachmentKeywords),
      attachmentExtensions: normalizeStringArray(recipe.attachmentExtensions),
      dryRun: recipe.dryRun ?? true,
      maxMessagesPerRun: Math.max(1, Math.min(500, Number(recipe.maxMessagesPerRun || 100))),
      backfillDays: Math.max(1, Math.min(3650, Number(recipe.backfillDays || 30))),
      lookbackMinutes: Math.max(1, Math.min(7 * 24 * 60, Number(recipe.lookbackMinutes || 20))),
      forwardedLabelName: normalizeString(recipe.forwardedLabelName) || "cowork/forwarded",
      rejectedLabelName: normalizeString(recipe.rejectedLabelName) || "cowork/rejected",
      candidateLabelName: normalizeString(recipe.candidateLabelName) || "cowork/candidate",
      gmailQuery: normalizeString(recipe.gmailQuery),
      enabled: recipe.enabled ?? true,
    };

    const record: MailboxAutomationRecord = {
      id: automationId,
      workspaceId,
      kind: "forward",
      status: normalizedRecipe.enabled === false ? "paused" : "active",
      name: normalizedRecipe.name,
      description: normalizedRecipe.description,
      threadId: normalizedRecipe.threadId,
      source: "cron",
      forward: normalizedRecipe,
      nextRunAt:
        normalizedRecipe.enabled === false
          ? undefined
          : computeNextRunAtMs(normalizedRecipe.schedule, now),
      createdAt: now,
      updatedAt: now,
    };

    await this.insertRecord(record, {
      automationId,
      workspaceId,
      eventType: "created",
      detail: { kind: "forward" },
    });
    const created = await this.fetchRow(automationId);
    if (!created) {
      throw new Error("Failed to persist forwarding automation");
    }
    return this.enrichRecord(created);
  }

  static async updateForward(
    automationId: string,
    patch: Partial<MailboxForwardRecipe> & { status?: MailboxAutomationStatus },
  ): Promise<MailboxAutomationRecord | null> {
    const deps = this.getDeps();
    const row = await this.fetchRow(automationId);
    if (!row || row.kind !== "forward") return null;

    const record = this.enrichRecord(row);
    const nextForward: MailboxForwardRecipe = {
      ...(record.forward || {
        name: record.name,
        schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
        targetEmail: "",
        allowedSenders: [],
        allowedDomains: [],
      }),
      ...patch,
      workspaceId: record.workspaceId,
      allowedSenders: normalizeStringArray(
        patch.allowedSenders ?? record.forward?.allowedSenders ?? [],
      ),
      allowedDomains: normalizeStringArray(
        patch.allowedDomains ?? record.forward?.allowedDomains ?? [],
      ),
      excludedSenders: normalizeStringArray(
        patch.excludedSenders ?? record.forward?.excludedSenders ?? [],
      ),
      excludedDomains: normalizeStringArray(
        patch.excludedDomains ?? record.forward?.excludedDomains ?? [],
      ),
      subjectKeywords: normalizeStringArray(
        patch.subjectKeywords ?? record.forward?.subjectKeywords ?? [],
      ),
      attachmentKeywords: normalizeStringArray(
        patch.attachmentKeywords ?? record.forward?.attachmentKeywords ?? [],
      ),
      attachmentExtensions: normalizeStringArray(
        patch.attachmentExtensions ?? record.forward?.attachmentExtensions ?? [],
      ),
      targetEmail: normalizeString(patch.targetEmail ?? record.forward?.targetEmail) || "",
      providerThreadId: normalizeString(patch.providerThreadId ?? record.forward?.providerThreadId),
      forwardedLabelName:
        normalizeString(patch.forwardedLabelName ?? record.forward?.forwardedLabelName) ||
        "cowork/forwarded",
      rejectedLabelName:
        normalizeString(patch.rejectedLabelName ?? record.forward?.rejectedLabelName) ||
        "cowork/rejected",
      candidateLabelName:
        normalizeString(patch.candidateLabelName ?? record.forward?.candidateLabelName) ||
        "cowork/candidate",
      gmailQuery: normalizeString(patch.gmailQuery ?? record.forward?.gmailQuery),
      maxMessagesPerRun: Math.max(
        1,
        Math.min(500, Number(patch.maxMessagesPerRun ?? record.forward?.maxMessagesPerRun ?? 100)),
      ),
      backfillDays: Math.max(
        1,
        Math.min(3650, Number(patch.backfillDays ?? record.forward?.backfillDays ?? 30)),
      ),
      lookbackMinutes: Math.max(
        1,
        Math.min(
          7 * 24 * 60,
          Number(patch.lookbackMinutes ?? record.forward?.lookbackMinutes ?? 20),
        ),
      ),
      dryRun: patch.dryRun ?? record.forward?.dryRun ?? true,
      enabled: patch.enabled ?? record.forward?.enabled ?? true,
      name: normalizeString(patch.name ?? record.name) || record.name,
    };

    if (!nextForward.targetEmail) {
      throw new Error("Target email is required for forwarding automation");
    }
    if (nextForward.allowedSenders.length === 0 && nextForward.allowedDomains.length === 0) {
      throw new Error("At least one allowed sender or domain is required");
    }

    const nextStatus =
      patch.status ??
      (nextForward.enabled === false
        ? "paused"
        : record.status === "deleted"
          ? "deleted"
          : "active");
    const nextRunAt =
      nextStatus === "active" ? computeNextRunAtMs(nextForward.schedule, Date.now()) : null;
    const now = Date.now();
    await this.statements().run("automation_updateForward_1", [
      nextForward.name,
      nextForward.description || null,
      nextStatus,
      nextForward.threadId || null,
      stringifyJson(nextForward),
      nextRunAt ?? null,
      now,
      automationId,
    ]);
    await this.appendAudit(automationId, record.workspaceId, "updated", { patch });
    deps.onMutation?.();
    return (
      (await this.listAutomations({ workspaceId: record.workspaceId })).find(
        (item) => item.id === automationId,
      ) ?? null
    );
  }

  static async deleteForward(automationId: string): Promise<boolean> {
    const row = await this.fetchRow(automationId);
    if (!row || row.kind !== "forward") return false;
    await this.markDeleted(row.id, row.workspace_id, {});
    return true;
  }

  static async createSchedule(recipe: MailboxScheduleRecipe): Promise<MailboxAutomationRecord> {
    const deps = this.getDeps();
    const cron = getCronService();
    if (!cron) {
      throw new Error("Cron service is not available");
    }

    const workspaceId = recipe.workspaceId?.trim() || deps.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No default workspace available for mailbox automation");
    }
    const automationId = randomUUID();
    const now = Date.now();
    const jobName = scheduleJobName(recipe);
    const descriptionParts = [
      recipe.description,
      `mailbox-automation:${automationId}`,
      recipe.threadId ? `thread:${recipe.threadId}` : undefined,
      `kind:${recipe.kind || "schedule"}`,
    ].filter((entry): entry is string => Boolean(entry));

    const jobResult = await cron.add({
      name: jobName,
      description: descriptionParts.join(" · "),
      enabled: recipe.enabled ?? true,
      deleteAfterRun: recipe.kind === "reminder" && recipe.schedule.kind === "at",
      allowUserInput: false,
      accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
      schedule: recipe.schedule,
      workspaceId,
      taskTitle: recipe.taskTitle,
      taskPrompt: recipe.taskPrompt,
      maxHistoryEntries: 10,
    } satisfies CronJobCreate);

    if (!jobResult.ok) {
      throw new Error(jobResult.error);
    }

    return this.insertScheduleRecord({
      automationId,
      workspaceId,
      recipe,
      cronJobId: jobResult.job.id,
      status: recipe.enabled === false ? "paused" : "active",
      now,
      nextRunAt: jobResult.job.state.nextRunAtMs,
    });
  }

  static async updateSchedule(
    automationId: string,
    patch: Partial<MailboxScheduleRecipe> & { status?: MailboxAutomationStatus },
  ): Promise<MailboxAutomationRecord | null> {
    const deps = this.getDeps();
    const row = await this.fetchRow(automationId);
    if (!row || (row.kind !== "schedule" && row.kind !== "reminder")) return null;
    const record = this.enrichRecord(row);
    const cron = getCronService();
    const recipe = {
      ...(record.schedule || {
        name: record.name,
        schedule: { kind: "at", atMs: Date.now() },
        taskTitle: record.name,
        taskPrompt: "",
      }),
      ...patch,
    } as MailboxScheduleRecipe;

    if (record.backingCronJobId && cron) {
      const existing = await cron.get(record.backingCronJobId);
      if (existing) {
        const patchJob: CronJobPatch = {
          name: recipe.name,
          description: recipe.description,
          enabled: patch.status ? patch.status === "active" : existing.enabled,
          schedule: recipe.schedule,
          workspaceId: recipe.workspaceId || existing.workspaceId,
          taskPrompt: recipe.taskPrompt,
          taskTitle: recipe.taskTitle,
        };
        await cron.update(record.backingCronJobId, patchJob);
      }
    }

    const now = Date.now();
    const nextStatus = patch.status ?? record.status;
    await this.statements().run("automation_updateRule_1", [
      normalizeString(recipe.name) || record.name,
      recipe.description || null,
      nextStatus,
      recipe.threadId || null,
      stringifyJson(recipe),
      now,
      automationId,
    ]);
    await this.appendAudit(automationId, record.workspaceId, "updated", { patch });
    deps.onMutation?.();
    return (
      (await this.listAutomations({ workspaceId: record.workspaceId })).find(
        (item) => item.id === automationId,
      ) ?? null
    );
  }

  static async deleteSchedule(automationId: string): Promise<boolean> {
    const deps = this.getDeps();
    const row = await this.fetchRow(automationId);
    if (!row || (row.kind !== "schedule" && row.kind !== "reminder")) return false;
    const record = this.enrichRecord(row);
    const cron = getCronService();
    if (record.backingCronJobId && cron) {
      await cron.remove(record.backingCronJobId);
    }
    await this.markDeleted(record.id, record.workspaceId, {
      backingCronJobId: record.backingCronJobId,
    });
    return true;
  }

  static async recordTriggerFire(payload: {
    trigger: EventTrigger;
    event: TriggerEvent;
    historyEntry: TriggerHistoryEntry;
  }): Promise<void> {
    const deps = this.getDeps();
    const row = (await this.statements().get("automation_recordTriggerFire_1", [
      payload.trigger.id,
    ])) as MailboxAutomationRow | undefined;
    if (!row) return;
    const now = Date.now();
    await this.statements().run("automation_recordTriggerFire_2", [
      payload.historyEntry.actionResult || "fired",
      payload.historyEntry.firedAt,
      now,
      row.id,
    ]);
    await this.appendAudit(row.id, row.workspace_id, "trigger_fired", {
      triggerId: payload.trigger.id,
      actionResult: payload.historyEntry.actionResult,
      eventType:
        typeof payload.event.fields.eventType === "string"
          ? payload.event.fields.eventType
          : payload.event.source,
    });
  }

  static async recordCronEvent(evt: CronEvent): Promise<void> {
    const deps = this.getDeps();
    const row = (await this.statements().get("automation_recordCronEvent_1", [evt.jobId])) as
      | MailboxAutomationRow
      | undefined;
    if (!row) return;
    const cron = getCronService();
    const jobPromise = cron?.get(evt.jobId);
    const job = jobPromise ? await jobPromise : null;

    const now = Date.now();
    if (evt.action === "removed") {
      await this.statements().run("automation_recordCronEvent_2", ["deleted", now, row.id]);
      await this.appendAudit(row.id, row.workspace_id, "cron_removed", { jobId: evt.jobId });
      return;
    }

    const latestOutcome =
      evt.action === "finished" ? evt.status || row.latest_outcome || null : row.latest_outcome;
    await this.statements().run("automation_recordCronEvent_3", [
      latestOutcome,
      evt.action === "started"
        ? (evt.runAtMs ?? now)
        : evt.action === "finished"
          ? (evt.runAtMs ?? now)
          : null,
      evt.nextRunAtMs ?? job?.state.nextRunAtMs ?? row.next_run_at,
      evt.error || null,
      evt.action === "finished" && evt.status === "error"
        ? "error"
        : job?.enabled === false
          ? "paused"
          : row.status === "deleted"
            ? "deleted"
            : "active",
      now,
      row.id,
    ]);
    const auditEvent: MailboxAutomationAuditEvent =
      evt.action === "started"
        ? "cron_started"
        : evt.action === "finished"
          ? "cron_finished"
          : evt.action === "added"
            ? "cron_added"
            : "cron_updated";
    await this.appendAudit(row.id, row.workspace_id, auditEvent, {
      jobId: evt.jobId,
      status: evt.status,
      error: evt.error,
      taskId: evt.taskId,
    });
  }

  private static ensureSchema(): void {
    const deps = this.getDeps();
    deps.db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_automations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        thread_id TEXT,
        source TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        backing_trigger_id TEXT,
        backing_cron_job_id TEXT,
        latest_outcome TEXT,
        latest_fire_at INTEGER,
        latest_run_at INTEGER,
        next_run_at INTEGER,
        latest_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_workspace ON mailbox_automations(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_thread ON mailbox_automations(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_kind ON mailbox_automations(kind, status);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_trigger ON mailbox_automations(backing_trigger_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_cron ON mailbox_automations(backing_cron_job_id);

      CREATE TABLE IF NOT EXISTS mailbox_automation_audit (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_automation_audit_automation
        ON mailbox_automation_audit(automation_id, created_at DESC);
    `);
  }

  private static getDeps(): MailboxAutomationRegistryDeps {
    if (!this.deps) {
      throw new Error("Mailbox automation registry is not configured");
    }
    return this.deps;
  }

  private static async fetchRow(automationId: string): Promise<MailboxAutomationRow | undefined> {
    const deps = this.getDeps();
    return (await this.statements().get("automation_fetchRow_1", [automationId])) as
      | MailboxAutomationRow
      | undefined;
  }

  private static enrichRecord(row: MailboxAutomationRow): MailboxAutomationRecord {
    const recipe = parseJson<
      MailboxRuleRecipe | MailboxScheduleRecipe | MailboxForwardRecipe | Record<string, unknown>
    >(row.recipe_json, {});
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      kind: row.kind,
      status:
        row.status === "deleted"
          ? "deleted"
          : row.status === "error"
            ? "error"
            : row.status === "paused"
              ? "paused"
              : "active",
      name: row.name,
      description: row.description || undefined,
      threadId: row.thread_id || undefined,
      source: row.source,
      rule: row.kind === "rule" ? (recipe as MailboxRuleRecipe) : undefined,
      schedule:
        row.kind === "schedule" || row.kind === "reminder"
          ? (recipe as MailboxScheduleRecipe)
          : undefined,
      forward: row.kind === "forward" ? (recipe as MailboxForwardRecipe) : undefined,
      backingTriggerId: row.backing_trigger_id || undefined,
      backingCronJobId: row.backing_cron_job_id || undefined,
      latestOutcome: row.latest_outcome || undefined,
      latestFireAt: row.latest_fire_at || undefined,
      latestRunAt: row.latest_run_at || undefined,
      nextRunAt: row.next_run_at || undefined,
      latestError: row.latest_error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static async insertRecord(
    record: MailboxAutomationRecord,
    audit: {
      automationId: string;
      workspaceId: string;
      eventType: MailboxAutomationAuditEvent;
      detail: Record<string, unknown>;
    },
  ): Promise<void> {
    const deps = this.getDeps();
    await this.statements().run("automation_insertRecord_1", [
      record.id,
      record.workspaceId,
      record.kind,
      record.status,
      record.name,
      record.description || null,
      record.threadId || null,
      record.source,
      stringifyJson(
        record.kind === "rule"
          ? record.rule || {}
          : record.kind === "forward"
            ? record.forward || {}
            : record.schedule || {},
      ),
      record.backingTriggerId || null,
      record.backingCronJobId || null,
      record.latestOutcome || null,
      record.latestFireAt || null,
      record.latestRunAt || null,
      record.nextRunAt || null,
      record.latestError || null,
      record.createdAt,
      record.updatedAt,
    ]);
    await this.appendAudit(audit.automationId, audit.workspaceId, audit.eventType, audit.detail);
    deps.onMutation?.();
  }

  private static async insertScheduleRecord(input: {
    automationId: string;
    workspaceId: string;
    recipe: MailboxScheduleRecipe;
    cronJobId?: string;
    status: MailboxAutomationStatus;
    now: number;
    nextRunAt?: number;
  }): Promise<MailboxAutomationRecord> {
    const record: MailboxAutomationRecord = {
      id: input.automationId,
      workspaceId: input.workspaceId,
      kind: input.recipe.kind || (input.recipe.schedule.kind === "at" ? "reminder" : "schedule"),
      status: input.status,
      name: input.recipe.name,
      description: input.recipe.description,
      threadId: input.recipe.threadId,
      source: "cron",
      schedule: input.recipe,
      backingCronJobId: input.cronJobId,
      nextRunAt:
        input.nextRunAt ??
        (input.recipe.schedule.kind === "at" ? input.recipe.schedule.atMs : undefined),
      createdAt: input.now,
      updatedAt: input.now,
    };
    await this.insertRecord(record, {
      automationId: record.id,
      workspaceId: record.workspaceId,
      eventType: "created",
      detail: { kind: record.kind, cronJobId: record.backingCronJobId },
    });
    const created = await this.fetchRow(record.id);
    if (!created) {
      throw new Error("Failed to persist mailbox schedule");
    }
    return this.enrichRecord(created);
  }

  private static async appendAudit(
    automationId: string,
    workspaceId: string,
    eventType: MailboxAutomationAuditEvent,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const deps = this.getDeps();
    await this.statements().run("automation_appendAudit_1", [
      randomUUID(),
      automationId,
      workspaceId,
      eventType,
      stringifyJson(detail),
      Date.now(),
    ]);
  }

  private static async markDeleted(
    automationId: string,
    workspaceId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const deps = this.getDeps();
    await this.statements().run("automation_markDeleted_1", [Date.now(), automationId]);
    await this.appendAudit(automationId, workspaceId, "deleted", detail);
    deps.onMutation?.();
  }

  static async markForwardRunStarted(automationId: string, runAtMs: number): Promise<void> {
    const deps = this.getDeps();
    await this.statements().run("automation_markForwardRunStarted_1", [
      runAtMs,
      Date.now(),
      automationId,
    ]);
    const row = await this.fetchRow(automationId);
    if (row) {
      await this.appendAudit(automationId, row.workspace_id, "forward_run_started", { runAtMs });
    }
  }

  static async markForwardRunFinished(
    automationId: string,
    input: {
      status: MailboxAutomationStatus;
      latestOutcome?: string;
      latestError?: string | null;
      latestFireAt?: number;
      nextRunAt?: number | null;
    },
  ): Promise<void> {
    const deps = this.getDeps();
    await this.statements().run("automation_markForwardRunFinished_1", [
      input.status,
      input.latestOutcome || null,
      input.latestError || null,
      input.latestFireAt || null,
      input.nextRunAt ?? null,
      Date.now(),
      automationId,
    ]);
    const row = await this.fetchRow(automationId);
    if (row) {
      await this.appendAudit(automationId, row.workspace_id, "forward_run_finished", {
        status: input.status,
        latestOutcome: input.latestOutcome,
        latestError: input.latestError,
        latestFireAt: input.latestFireAt,
        nextRunAt: input.nextRunAt,
      });
    }
  }

  static async setForwardNextRun(automationId: string, nextRunAt?: number): Promise<void> {
    const deps = this.getDeps();
    await this.statements().run("automation_setForwardNextRun_1", [
      nextRunAt ?? null,
      Date.now(),
      automationId,
    ]);
  }
}

// Each call is one mailbox operation for the statement burst gate (DB6).
bindStatementContext(MailboxAutomationRegistry, "MailboxAutomationRegistry");
