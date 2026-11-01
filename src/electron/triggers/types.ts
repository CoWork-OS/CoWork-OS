/**
 * Event Trigger types — condition-based automation.
 *
 * "When X happens, do Y" rules that monitor channel messages, emails,
 * webhooks, and other events to auto-create tasks or send messages.
 */

import type {
  AgentConfig,
  EventGateDecision,
  EventGateMode,
  SpeculativeFixConfig,
} from "../../shared/types";

export type TriggerSource =
  | "channel_message"
  | "email"
  | "mailbox_event"
  | "webhook"
  | "connector_event"
  | "mcp_event"
  | "github_event"
  | "file_change"
  | "cron_event";

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "matches"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "lt";

export interface TriggerCondition {
  /** Field name to evaluate (e.g. "text", "senderName", "subject", "channelType") */
  field: string;
  /** Comparison operator */
  operator: ConditionOperator;
  /** Value to compare against (regex string for "matches") */
  value: string;
}

export type TriggerActionType = "create_task" | "send_message" | "wake_agent" | "speculate_fix";

export interface TriggerAction {
  type: TriggerActionType;
  config: {
    /** For create_task: the task prompt (supports {{event.text}}, {{event.senderName}} variables) */
    prompt?: string;
    /** For create_task: task title */
    title?: string;
    /** For send_message: channel type to send to */
    channelType?: string;
    /** For send_message: channel/chat ID */
    channelId?: string;
    /** For send_message: message text */
    message?: string;
    /** For wake_agent: agent role ID */
    agentRoleId?: string;
    /** Workspace to create task in */
    workspaceId?: string;
    /** Optional per-task agent restrictions or routing hints */
    agentConfig?: AgentConfig;
    /** Routine dispatch mode */
    runMode?: "new_task" | "thread_follow_up";
    /** Existing task to receive the message when runMode is thread_follow_up */
    targetTaskId?: string;
    /**
     * Set by the `wait_for_event` tool: a temporary trigger that resumes a task parked on this
     * event. It fires once (the runtime disables it), and is removed when the wait ends.
     */
    eventWait?: { taskId: string; expiresAt: number; reason?: string };
    /**
     * For speculate_fix: reproduce the reported problem in an isolated worktree and deliver a
     * fix only when it is confirmed and small. Off unless a trigger is set to this action.
     */
    speculateFix?: SpeculativeFixConfig;
    /** MCP Events subscription bound to this trigger. */
    mcpEvent?: {
      serverId: string;
      name: string;
      arguments: Record<string, unknown>;
      delivery: "webhook" | "poll";
      /** Public HTTPS URL that forwards to the local MCP Events receiver. */
      callbackUrl?: string;
    };
  };
}

export interface EventTrigger {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  source: TriggerSource;
  conditions: TriggerCondition[];
  /** How conditions are combined: "all" = AND (default), "any" = OR */
  conditionLogic?: "all" | "any";
  action: TriggerAction;
  workspaceId: string;
  /** Cooldown in ms between firings (prevent spam). Default: 60000 (1 min) */
  cooldownMs?: number;
  lastFiredAt?: number;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TriggerEvent {
  source: TriggerSource;
  /** Stable source identity when the ingress adapter provides one (for replay dedupe). */
  eventId?: string;
  timestamp: number;
  fields: Record<string, string | number | boolean> & {
    /** Configured gateway connection that produced the event, when available. */
    channelInstanceId?: string;
  };
}

export interface TriggerHistoryEntry {
  id: string;
  triggerId: string;
  firedAt: number;
  eventData: Record<string, unknown>;
  actionResult?: string;
  taskId?: string;
  sourceLabel?: string;
  /** Semantic gate verdict, when the trigger's source is in candidate mode. */
  gateDecision?: EventGateDecision;
  /** The gate's one-line reason. */
  gateReason?: string;
  /** Thread the event belongs to, when a thread subscription received it. */
  threadKey?: string;
}

export interface SpeculateFixRequest {
  trigger: EventTrigger;
  event: TriggerEvent;
  /** Stable occurrence identity: one key never starts a second run. */
  idempotencyKey?: string;
  /** Present when a bot responsibility prepared this event; such a trigger may not speculate. */
  agentConfig?: AgentConfig;
}

export interface SpeculateFixStartResult {
  started: boolean;
  runId?: string;
  taskId?: string;
  /** Why no run started (for the trigger history). */
  reason?: string;
}

/**
 * The trigger operations routines use to manage their backing triggers. Declared here so
 * type-only consumers (routine types shared with the renderer) do not import the service.
 */
export interface EventTriggerRegistry {
  getTrigger(id: string): EventTrigger | undefined;
  addTrigger(
    input: Omit<EventTrigger, "id" | "fireCount" | "createdAt" | "updatedAt">,
  ): Promise<EventTrigger>;
  updateTrigger(id: string, updates: Partial<EventTrigger>): Promise<EventTrigger | null>;
  removeTrigger(id: string): Promise<boolean>;
}

export interface EventTriggerServiceDeps {
  getResponsibilityAccess?: () => {
    settings?: import("../../shared/types").PermissionSettingsData;
    adminPolicies?: import("../admin/policies").AdminPolicies;
  };
  createTask: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig?: AgentConfig;
  }) => Promise<{ id: string }>;
  sendTaskMessage?: (params: {
    taskId: string;
    message: string;
    agentConfig?: AgentConfig;
  }) => Promise<{ queued: boolean }>;
  deliverToChannel?: (params: {
    channelType: string;
    channelId: string;
    text: string;
    /** Present for journaled Node/Electron actions; omitted by the DB-less legacy fallback. */
    idempotencyKey?: string;
  }) => Promise<{ messageId: string }>;
  wakeAgent?: (agentRoleId: string, prompt: string) => void | Promise<void>;
  /** Starts a speculative reproduce-and-fix run; without it, speculate_fix triggers fail. */
  speculateFix?: (params: SpeculateFixRequest) => Promise<SpeculateFixStartResult>;
  getDefaultWorkspaceId: () => string;
  getActiveTaskCount?: () => number;
  log?: (...args: unknown[]) => void;
  onTriggerFired?: (payload: {
    trigger: EventTrigger;
    event: TriggerEvent;
    historyEntry: TriggerHistoryEntry;
  }) => void | Promise<void>;
  /**
   * A task parked by `wait_for_event` got its event. Without it, the event is sent to the
   * task as a follow-up message.
   */
  onEventWaitFired?: (params: {
    taskId: string;
    triggerId: string;
    event: TriggerEvent;
  }) => Promise<void>;
  /**
   * The event gate mode of an event's source (or gateway chat). Absent: explicit_only for
   * every event, today's behaviour.
   */
  resolveGateMode?: (event: TriggerEvent) => EventGateMode;
  /**
   * The semantic gate for a candidate event: one small model call over the event and the
   * user's policies. Absent in a runtime: candidate events are ignored (fail closed).
   */
  runSemanticGate?: (params: {
    trigger: EventTrigger;
    event: TriggerEvent;
  }) => Promise<{ decision: EventGateDecision; reason: string }>;
  /** Tasks subscribed to a thread that can still take a follow-up. */
  findActiveThreadSubscribers?: (threadKey: string) => Promise<string[]>;
  /** Hand a thread event to a subscribed task as an untrusted external follow-up. */
  deliverThreadEvent?: (params: {
    taskId: string;
    threadKey: string;
    event: TriggerEvent;
  }) => Promise<void>;
  /** Subscribe a task the engine created for an event's thread. */
  subscribeThread?: (threadKey: string, taskId: string) => Promise<void>;
}
