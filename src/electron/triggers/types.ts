/**
 * Event Trigger types — condition-based automation.
 *
 * "When X happens, do Y" rules that monitor channel messages, emails,
 * webhooks, and other events to auto-create tasks or send messages.
 */

export type TriggerSource =
  | "channel_message"
  | "email"
  | "webhook"
  | "connector_event"
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

export type TriggerActionType = "create_task" | "send_message" | "wake_agent";

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
  timestamp: number;
  fields: Record<string, string | number | boolean>;
}

export interface TriggerHistoryEntry {
  id: string;
  triggerId: string;
  firedAt: number;
  eventData: Record<string, unknown>;
  actionResult?: string;
  taskId?: string;
}

export interface EventTriggerServiceDeps {
  createTask: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
  }) => Promise<{ id: string }>;
  deliverToChannel?: (params: {
    channelType: string;
    channelId: string;
    text: string;
  }) => Promise<void>;
  wakeAgent?: (agentRoleId: string, prompt: string) => void;
  getDefaultWorkspaceId: () => string;
  log?: (...args: unknown[]) => void;
}
