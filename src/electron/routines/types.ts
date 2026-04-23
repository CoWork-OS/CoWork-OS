import type { AgentConfig } from "../../shared/types";
import type { ChannelType } from "../gateway/channels/types";
import type { CronDeliveryConfig, CronSchedule } from "../cron/types";
import type { CronService } from "../cron";
import type { EventTriggerService } from "../triggers/EventTriggerService";
import type { TriggerCondition } from "../triggers/types";
import type { HooksConfig } from "../hooks/types";

export type RoutineExecutionTargetKind =
  | "workspace"
  | "worktree"
  | "device"
  | "managed_environment";

export interface RoutineExecutionTarget {
  kind: RoutineExecutionTargetKind;
  deviceId?: string;
  managedEnvironmentId?: string;
}

export interface RoutineContextBindings {
  chatContext?: {
    channelType: ChannelType;
    channelId: string;
  };
  metadata?: Record<string, string>;
}

export interface RoutineConnectorPolicy {
  mode: "prefer" | "allowlist";
  connectorIds: string[];
}

export interface RoutineApprovalPolicy {
  mode: "inherit" | "auto_safe" | "confirm_external" | "strict_confirm";
}

export type RoutineOutput =
  | RoutineTaskOnlyOutput
  | RoutineChannelMessageOutput
  | RoutineWebhookResponseOutput
  | RoutineEmailOutput
  | RoutineGithubCommentOutput
  | RoutineIssueOrPrOutput;

export interface RoutineTaskOnlyOutput {
  kind: "task_only";
}

export interface RoutineChannelMessageOutput {
  kind: "channel_message";
  channelType?: string;
  channelDbId?: string;
  channelId?: string;
  summaryOnly?: boolean;
  deliverOnSuccess?: boolean;
  deliverOnError?: boolean;
}

export interface RoutineWebhookResponseOutput {
  kind: "webhook_response";
  statusCode?: number;
  message?: string;
  includeTaskId?: boolean;
}

export interface RoutineEmailOutput {
  kind: "email";
  to?: string;
  subject?: string;
}

export interface RoutineGithubCommentOutput {
  kind: "github_comment";
  repository?: string;
  issueNumber?: number;
}

export interface RoutineIssueOrPrOutput {
  kind: "issue_or_pr";
  repository?: string;
  mode?: "issue" | "pr";
}

export type RoutineTrigger =
  | RoutineScheduleTrigger
  | RoutineApiTrigger
  | RoutineConnectorEventTrigger
  | RoutineChannelEventTrigger
  | RoutineMailboxEventTrigger
  | RoutineGithubEventTrigger
  | RoutineManualTrigger;

export interface RoutineBaseTrigger {
  id: string;
  enabled: boolean;
}

export interface RoutineEventBaseTrigger extends RoutineBaseTrigger {
  cooldownMs?: number;
  conditions?: TriggerCondition[];
  managedEventTriggerId?: string;
}

export interface RoutineScheduleTrigger extends RoutineBaseTrigger {
  type: "schedule";
  schedule: CronSchedule;
  managedCronJobId?: string;
}

export interface RoutineApiTrigger extends RoutineBaseTrigger {
  type: "api";
  path?: string;
  token?: string;
  managedHookMappingId?: string;
}

export interface RoutineConnectorEventTrigger extends RoutineEventBaseTrigger {
  type: "connector_event";
  connectorId: string;
  changeType?: string;
  resourceUriContains?: string;
}

export interface RoutineChannelEventTrigger extends RoutineEventBaseTrigger {
  type: "channel_event";
  channelType?: string;
  chatId?: string;
  textContains?: string;
  senderContains?: string;
}

export interface RoutineMailboxEventTrigger extends RoutineEventBaseTrigger {
  type: "mailbox_event";
  eventType?: string;
  subjectContains?: string;
  provider?: string;
  labelContains?: string;
}

export interface RoutineGithubEventTrigger extends RoutineEventBaseTrigger {
  type: "github_event";
  eventName?: string;
  repository?: string;
  action?: string;
  ref?: string;
}

export interface RoutineManualTrigger extends RoutineBaseTrigger {
  type: "manual";
}

export interface RoutineDefinition {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  workspaceId: string;
  instructions: string;
  executionTarget: RoutineExecutionTarget;
  contextBindings: RoutineContextBindings;
  triggers: RoutineTrigger[];
  outputs: RoutineOutput[];
  approvalPolicy: RoutineApprovalPolicy;
  connectorPolicy: RoutineConnectorPolicy;
  createdAt: number;
  updatedAt: number;
}

/**
 * Compatibility shape used by the existing renderer and older routine payloads.
 * `prompt` mirrors `instructions`, and `connectors` mirrors `connectorPolicy.connectorIds`.
 */
export interface Routine extends RoutineDefinition {
  prompt: string;
  connectors: string[];
}

export interface RoutineCreate
  extends Omit<
    RoutineDefinition,
    "id" | "createdAt" | "updatedAt" | "instructions" | "connectorPolicy" | "triggers" | "outputs"
  > {
  triggers?: RoutineTrigger[];
  outputs?: RoutineOutput[];
  instructions?: string;
  prompt?: string;
  connectorPolicy?: Partial<RoutineConnectorPolicy>;
  connectors?: string[];
}

export type RoutinePatch = Partial<
  Omit<
    RoutineDefinition,
    "id" | "createdAt" | "updatedAt" | "instructions" | "connectorPolicy" | "triggers" | "outputs"
  >
> & {
  triggers?: RoutineTrigger[];
  outputs?: RoutineOutput[];
  instructions?: string;
  prompt?: string;
  connectorPolicy?: Partial<RoutineConnectorPolicy>;
  connectors?: string[];
};

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial_success"
  | "needs_user_action"
  | "failed";

export type RoutineOutputStatus =
  | "none"
  | "queued"
  | "sent"
  | "responded"
  | "failed";

export interface RoutineRun {
  id: string;
  routineId: string;
  triggerId: string;
  triggerType: RoutineTrigger["type"];
  status: RoutineRunStatus;
  startedAt: number;
  finishedAt?: number;
  sourceEventSummary?: string;
  backingTaskId?: string;
  backingManagedSessionId?: string;
  outputStatus: RoutineOutputStatus;
  errorSummary?: string;
  artifactsSummary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineTaskSnapshot {
  status: string;
  error?: string | null;
  resultSummary?: string | null;
  terminalStatus?: string | null;
  completedAt?: number | null;
}

export interface RoutineManagedSessionSnapshot {
  status: string;
  latestSummary?: string | null;
  completedAt?: number | null;
  backingTaskId?: string | null;
}

export interface RoutineServiceDeps {
  db: Any;
  getCronService: () => CronService | null;
  getEventTriggerService: () => EventTriggerService | null;
  loadHooksSettings: () => HooksConfig;
  saveHooksSettings: (settings: HooksConfig) => void;
  createTask?: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig?: AgentConfig;
    source?: "manual" | "cron" | "hook" | "api";
  }) => Promise<{ id: string }>;
  onHooksConfigChanged?: (settings: HooksConfig) => void;
  onTriggerMutation?: () => Promise<void> | void;
  now?: () => number;
  getTaskSnapshot?: (taskId: string) => Promise<RoutineTaskSnapshot | null> | RoutineTaskSnapshot | null;
  createManagedSession?: (params: {
    agentId?: string;
    environmentId: string;
    title: string;
    prompt: string;
  }) => Promise<{ id: string; backingTaskId?: string; workspaceId?: string }>;
  runTaskOnDevice?: (params: {
    deviceId: string;
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig?: AgentConfig;
  }) => Promise<{ id: string }>;
  getManagedSessionSnapshot?: (
    sessionId: string,
  ) => Promise<RoutineManagedSessionSnapshot | null> | RoutineManagedSessionSnapshot | null;
}

export interface CompiledRoutineTarget {
  workspaceId: string;
  agentConfig?: AgentConfig;
  chatContext?: RoutineContextBindings["chatContext"];
}

export interface CompiledRoutineOutputs {
  cronDelivery?: CronDeliveryConfig;
  webhookResponse?: RoutineWebhookResponseOutput;
}
