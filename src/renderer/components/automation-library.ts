import type { CronJob, CronRunHistoryEntry } from "../../electron/cron/types";
import type { EventTrigger, TriggerHistoryEntry } from "../../electron/triggers/types";
import type { Routine, RoutineRun } from "../../electron/routines/types";
import type { HookMappingData } from "../../shared/types";
import type { RoutineWorkflowRunRecord } from "../../shared/routine-workflow";

export type AutomationOwner = "routines" | "scheduled" | "triggers" | "hooks";
export type AutomationKind = "prompt" | "structured" | "cron" | "event" | "webhook";

export interface AutomationLibraryItem {
  key: string;
  profileScope: string;
  id: string;
  kind: AutomationKind;
  owner: AutomationOwner;
  name: string;
  description: string;
  workspaceId?: string;
  enabled: boolean | null;
  updatedAt?: number;
  triggerSummary: string;
  detail: string;
  workTarget?: string;
  schedulerOwner?: string;
  timezone?: string;
  activeVersionId?: string;
  linkedChildren: string[];
  linkageWarning?: string;
  legacyHookRevision?: string;
  legacyHookIndex?: number;
  actions: {
    run: { supported: boolean; reason?: string };
    pause: { supported: boolean; reason?: string };
    edit: { supported: boolean; reason?: string };
    review: { supported: boolean; reason?: string };
  };
}

export interface AutomationActivityItem {
  key: string;
  ownerKey: string;
  owner: AutomationOwner;
  runId: string;
  name: string;
  source: string;
  at: number;
  execution: string;
  delivery?: string;
  approval?: string;
  detail?: string;
  taskId?: string;
  workflowRunId?: string;
  workflowVersionId?: string;
  needsAttention: boolean;
  retention?: string;
}

export interface AutomationSources {
  profileScope: string;
  routines: Routine[];
  cronJobs: CronJob[];
  eventTriggers: EventTrigger[];
  hookMappings: HookMappingData[];
  hookRevision: string;
}

const available = { supported: true } as const;
const reviewOnly = { supported: true } as const;

function denied(reason: string) {
  return { supported: false, reason };
}

function claimsFor(sources: AutomationSources) {
  const claims = {
    cron: new Map<string, string[]>(),
    event: new Map<string, string[]>(),
    hook: new Map<string, string[]>(),
  };
  const add = (map: Map<string, string[]>, id: string | undefined, owner: string) => {
    if (!id) return;
    const current = map.get(id) || [];
    if (!current.includes(owner)) map.set(id, [...current, owner]);
  };
  for (const routine of sources.routines) {
    for (const trigger of routine.triggers || []) {
      if (trigger.type === "schedule") add(claims.cron, trigger.managedCronJobId, routine.id);
      if (trigger.type === "api") add(claims.hook, trigger.managedHookMappingId, routine.id);
      if ("managedEventTriggerId" in trigger)
        add(claims.event, trigger.managedEventTriggerId, routine.id);
    }
  }
  return claims;
}

function claimWarning(owners: string[] | undefined): string | undefined {
  return owners && owners.length > 1
    ? `This resource is claimed by ${owners.length} owners; review its native configuration.`
    : undefined;
}

function summarizeRoutineTriggers(routine: Routine): string {
  const triggers = routine.triggers || [];
  if (!triggers.length) return "No configured triggers";
  return triggers
    .map((trigger) => {
      let label = trigger.type.replace(/_/g, " ");
      if (trigger.type === "schedule") {
        label =
          trigger.schedule.kind === "cron"
            ? `schedule ${trigger.schedule.expr}${trigger.schedule.tz ? ` (${trigger.schedule.tz})` : ""}`
            : trigger.schedule.kind === "every"
              ? `schedule every ${trigger.schedule.everyMs} ms`
              : `schedule once ${new Date(trigger.schedule.atMs).toLocaleString()}`;
      } else if (trigger.type === "api" && trigger.path) {
        label = `webhook ${trigger.path}`;
      } else if (trigger.type === "connector_event") {
        label = `${trigger.connectorId} ${trigger.changeType || "event"}`;
      } else if (trigger.type === "channel_event") {
        label = `${trigger.channelType || "channel"} event`;
      } else if (trigger.type === "mailbox_event") {
        label = `${trigger.provider || "mailbox"} ${trigger.eventType || "event"}`;
      } else if (trigger.type === "github_event") {
        label = `GitHub ${trigger.eventName || "event"}${trigger.repository ? ` · ${trigger.repository}` : ""}`;
      }
      return `${label} · ${trigger.enabled ? "on" : "off"}`;
    })
    .join("; ");
}

export function buildAutomationLibrary(sources: AutomationSources): AutomationLibraryItem[] {
  const claims = claimsFor(sources);
  const keyFor = (owner: AutomationOwner, id: string) => `${sources.profileScope}:${owner}:${id}`;
  const items: AutomationLibraryItem[] = [];
  for (const routine of sources.routines) {
    const structured = Boolean(routine.workflow);
    const cronTrigger = routine.triggers.find(
      (trigger) => trigger.type === "schedule" && trigger.schedule.kind === "cron",
    );
    items.push({
      key: keyFor("routines", routine.id),
      profileScope: sources.profileScope,
      id: routine.id,
      kind: structured ? "structured" : "prompt",
      owner: "routines",
      name: routine.name,
      description: routine.description || (structured ? "Structured flow" : "Prompt routine"),
      workspaceId: routine.workspaceId,
      enabled: routine.enabled,
      updatedAt: routine.updatedAt,
      triggerSummary: summarizeRoutineTriggers(routine),
      detail: structured
        ? `${routine.workflow?.nodes.length || 0} steps · ${routine.activeWorkflowVersionId ? "active version" : "draft graph"}`
        : "Prompt instructions and native triggers",
      workTarget: routine.executionTarget?.kind || "workspace",
      schedulerOwner: routine.triggers.some((trigger) => trigger.type === "schedule")
        ? "Local scheduled-task engine"
        : undefined,
      timezone:
        cronTrigger?.type === "schedule" && cronTrigger.schedule.kind === "cron"
          ? cronTrigger.schedule.tz
          : undefined,
      activeVersionId: routine.activeWorkflowVersionId,
      linkedChildren: (routine.triggers || []).flatMap((trigger) => {
        if (trigger.type === "schedule" && trigger.managedCronJobId)
          return [`Scheduled task ${trigger.managedCronJobId}`];
        if (trigger.type === "api" && trigger.managedHookMappingId)
          return [`Webhook ${trigger.managedHookMappingId}`];
        if ("managedEventTriggerId" in trigger && trigger.managedEventTriggerId)
          return [`Event trigger ${trigger.managedEventTriggerId}`];
        return [];
      }),
      actions: {
        run:
          structured && !routine.activeWorkflowVersionId
            ? denied("Activate a reviewed workflow version before running this structured routine.")
            : available,
        pause: routine.triggers.some((trigger) =>
          ["connector_event", "channel_event", "mailbox_event", "github_event"].includes(
            trigger.type,
          ),
        )
          ? denied(
              "Event intake can queue through re-enable. Use the Routine editor until admission-time pause is supported.",
            )
          : available,
        edit: available,
        review: reviewOnly,
      },
    });
  }
  for (const job of sources.cronJobs) {
    const owners = claims.cron.get(job.id);
    if (owners?.length === 1) continue;
    items.push({
      key: keyFor("scheduled", job.id),
      profileScope: sources.profileScope,
      id: job.id,
      kind: "cron",
      owner: "scheduled",
      name: job.name,
      description: job.description || "Standalone scheduled task",
      workspaceId: job.workspaceId,
      enabled: job.enabled,
      updatedAt: job.updatedAtMs,
      triggerSummary:
        job.schedule.kind === "cron"
          ? `${job.schedule.expr}${job.schedule.tz ? ` (${job.schedule.tz})` : ""}`
          : job.schedule.kind === "every"
            ? `Every ${job.schedule.everyMs} ms`
            : `Once at ${new Date(job.schedule.atMs).toLocaleString()}`,
      detail: job.runMode === "thread_follow_up" ? "Continues a task thread" : "Creates a task",
      workTarget: job.runMode === "thread_follow_up" ? "Existing task thread" : "New task",
      schedulerOwner: "Local scheduled-task engine",
      timezone: job.schedule.kind === "cron" ? job.schedule.tz : undefined,
      linkedChildren: [],
      linkageWarning: claimWarning(owners),
      actions: { run: available, pause: available, edit: available, review: reviewOnly },
    });
  }
  for (const trigger of sources.eventTriggers) {
    const owners = claims.event.get(trigger.id);
    if (owners?.length === 1) continue;
    if (!trigger.action?.type) continue;
    items.push({
      key: keyFor("triggers", trigger.id),
      profileScope: sources.profileScope,
      id: trigger.id,
      kind: "event",
      owner: "triggers",
      name: trigger.name,
      description: trigger.description || "Standalone event trigger",
      workspaceId: trigger.workspaceId,
      enabled: trigger.enabled,
      updatedAt: trigger.updatedAt,
      triggerSummary: trigger.source.replace(/_/g, " "),
      detail: `${trigger.fireCount} recorded fires · ${trigger.action.type.replace(/_/g, " ")}`,
      linkedChildren: [],
      linkageWarning: claimWarning(owners),
      actions: {
        run: denied("Event triggers have no native Run now operation."),
        pause: denied(
          "Events received while disabled may remain queued and run after re-enable. Use the native editor to manage this trigger.",
        ),
        edit: available,
        review: reviewOnly,
      },
    });
  }
  sources.hookMappings.forEach((mapping, index) => {
    if (mapping.action !== "agent" && mapping.action !== "wake") return;
    const owners = mapping.id ? claims.hook.get(mapping.id) : undefined;
    if (owners?.length === 1) return;
    const legacy = !mapping.id;
    const id = mapping.id || `legacy:${sources.hookRevision}:${index}`;
    items.push({
      key: keyFor("hooks", id),
      profileScope: sources.profileScope,
      id,
      kind: "webhook",
      owner: "hooks",
      name: mapping.name || mapping.match?.path || `Webhook rule ${index + 1}`,
      description: `${mapping.action} action`,
      enabled: null,
      triggerSummary: mapping.match?.path || mapping.match?.source || "Shared webhook listener",
      detail: legacy
        ? "Legacy rule without a stable ID; the Library can open its revision-scoped row but cannot edit it"
        : "Action-bearing webhook mapping",
      linkedChildren: [],
      linkageWarning: claimWarning(owners),
      legacyHookRevision: legacy ? sources.hookRevision : undefined,
      legacyHookIndex: legacy ? index : undefined,
      actions: {
        run: denied("Webhook mappings run only when a matching request arrives."),
        pause: denied("Webhook mappings have no independent pause control; use the native editor."),
        edit: denied(
          legacy
            ? "This legacy rule has no stable ID and no individual-rule editor is available from the Library or Webhooks settings."
            : "Webhook rules are not editable from the shared receiver settings page.",
        ),
        review: reviewOnly,
      },
    });
  });
  return items.sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.name.localeCompare(b.name),
  );
}

export function hookMappingRevision(mappings: HookMappingData[]): string {
  const content = JSON.stringify(mappings);
  let hash = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function needsAttention(status: string, approval?: string): boolean {
  return (
    Boolean(approval) ||
    [
      "needs_user_action",
      "waiting_for_approval",
      "failed",
      "error",
      "timeout",
      "partial_success",
      "unknown",
    ].includes(status)
  );
}

export function buildAutomationActivity(input: {
  items: AutomationLibraryItem[];
  routineRuns: RoutineRun[];
  workflowRuns: RoutineWorkflowRunRecord[];
  cronHistory: Record<string, CronRunHistoryEntry[]>;
  eventHistory: Record<string, TriggerHistoryEntry[]>;
}): AutomationActivityItem[] {
  const names = new Map(input.items.map((item) => [item.key, item.name]));
  const ownerKeyFor = (owner: AutomationOwner, id: string) =>
    input.items.find((item) => item.owner === owner && item.id === id)?.key || `${owner}:${id}`;
  const workflowById = new Map(input.workflowRuns.map((run) => [run.id, run]));
  const linkedWorkflowIds = new Set(
    input.routineRuns.map((run) => run.workflowRunId).filter(Boolean),
  );
  const rows: AutomationActivityItem[] = [];
  for (const run of input.routineRuns) {
    const workflow = run.workflowRunId ? workflowById.get(run.workflowRunId) : undefined;
    rows.push({
      key: `routine-run:${run.id}`,
      ownerKey: ownerKeyFor("routines", run.routineId),
      owner: "routines",
      runId: run.id,
      name: names.get(ownerKeyFor("routines", run.routineId)) || "Routine",
      source: workflow ? "Routine run · linked workflow evidence" : "Routine run",
      at: run.startedAt || run.createdAt,
      execution: run.status,
      delivery: run.outputStatus,
      approval:
        run.status === "needs_user_action"
          ? "Needs user action"
          : workflow?.status === "waiting_for_approval"
            ? "Workflow approval pending"
            : undefined,
      detail: run.errorSummary || run.artifactsSummary || workflow?.error,
      taskId: run.backingTaskId,
      workflowRunId: workflow?.id,
      workflowVersionId: workflow?.workflowVersionId,
      needsAttention:
        needsAttention(run.status, run.status === "needs_user_action" ? "pending" : undefined) ||
        workflow?.status === "waiting_for_approval",
      retention: "Latest 200 Routine runs loaded",
    });
  }
  for (const run of input.workflowRuns) {
    if (linkedWorkflowIds.has(run.id)) continue;
    rows.push({
      key: `workflow-run:${run.id}`,
      ownerKey: ownerKeyFor("routines", run.routineId),
      owner: "routines",
      runId: run.id,
      name: names.get(ownerKeyFor("routines", run.routineId)) || "Structured flow",
      source: "Workflow run · no recorded Routine-run link",
      at: run.startedAt || run.createdAt,
      execution: run.status,
      approval: run.status === "waiting_for_approval" ? "Step approval pending" : undefined,
      detail: run.error,
      workflowRunId: run.id,
      workflowVersionId: run.workflowVersionId,
      needsAttention: needsAttention(
        run.status,
        run.status === "waiting_for_approval" ? "pending" : undefined,
      ),
      retention: "Latest 60 workflow runs loaded",
    });
  }
  for (const item of input.items) {
    if (item.kind === "cron") {
      (input.cronHistory[item.id] || []).forEach((run, index) =>
        rows.push({
          key: `cron-run:${item.id}:${run.runAtMs}:${index}`,
          ownerKey: item.key,
          owner: "scheduled",
          runId: String(run.runAtMs),
          name: item.name,
          source: "Scheduled task history",
          at: run.runAtMs,
          execution: run.status,
          delivery: run.deliverableStatus || run.deliveryStatus,
          detail: run.error || run.deliveryError,
          taskId: run.taskId,
          needsAttention:
            needsAttention(run.status) ||
            (run.deliverableStatus || run.deliveryStatus) === "dead_letter",
          retention: "Job-local retained history",
        }),
      );
    }
    if (item.kind === "event") {
      (input.eventHistory[item.id] || []).forEach((run) =>
        rows.push({
          key: `event-run:${item.id}:${run.id}`,
          ownerKey: item.key,
          owner: "triggers",
          runId: run.id,
          name: item.name,
          source: "Event trigger history",
          at: run.firedAt,
          execution: run.actionResult || "Fired; outcome not classified",
          taskId: run.taskId,
          needsAttention: needsAttention(run.actionResult || "unknown"),
          retention: "Latest 20 events per trigger",
        }),
      );
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}
