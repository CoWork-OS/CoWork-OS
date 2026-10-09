import { TEAMS_REFERENCE_UNITS } from "../gateway/teams-conversation-reference-units";
import { CHANNEL_DECISION_UNITS } from "../gateway/channel-decision-units";
import { NOTIFICATION_INBOX_UNITS } from "../notifications/notification-inbox-units";
import { BOT_NOTIFICATION_UNITS } from "../notifications/bot-notification-units";
import { BOT_RESPONSIBILITY_UNITS } from "../automation/responsibility-units";
import { SCHEDULER_LEASE_UNITS } from "../automation/scheduler-lease-units";
import { DISPATCH_BUDGET_UNITS } from "../automation/dispatch-budget-units";
import { AGENT_UNITS } from "../agents/agent-units";
import { CORE_UNITS } from "../core/core-units";
import { IDENTITY_UNITS } from "../identity/identity-units";
import { MANAGED_UNITS } from "../managed/managed-units";
import { WORKSPACE_UNITS } from "../workspaces/workspace-units";
import { ACTIVITY_UNITS } from "../activity/activity-units";
import { TRIGGER_UNITS } from "../triggers/trigger-units";
import { AGENT_SIGNAL_UNITS } from "../agents/agent-signal-units";
import { ACP_UNITS } from "../acp/acp-units";
import { PACT_UNITS } from "../pact/pact-units";
import { FILE_HUB_UNITS } from "../file-hub/file-hub-units";
import { BRIEFING_UNITS } from "../briefing/briefing-units";
import { YOUTUBE_UNITS } from "../youtube/youtube-units";
import { ANSWER_SURFACE_UNITS } from "../answer-surfaces/answer-surface-units";
import { USAGE_TELEMETRY_UNITS } from "../agent/llm/usage-telemetry-units";
import { CHANNEL_HISTORY_UNITS } from "../agent/tools/channel-history-units";
import { PULSE_REPORT_UNITS } from "../telemetry/pulse-report-units";
import { TEMP_WORKSPACE_UNITS } from "../utils/temp-workspace-units";
import { ROUTINE_UNITS } from "../routines/routine-units";
import { SUBCONSCIOUS_UNITS } from "../subconscious/subconscious-units";
import { MISSION_CONTROL_UNITS } from "../mission-control/mission-control-units";
import { AUTOMATION_OUTCOME_UNITS } from "../automation/automation-outcome-units";
import { HOOK_SESSION_UNITS } from "../hooks/hook-session-units";
import { CONTEXT_POLICY_UNITS } from "../gateway/context-policy-units";
import { ORCHESTRATION_GRAPH_UNITS } from "../agent/orchestration/orchestration-graph-units";
import { ORCHESTRATION_UNITS } from "../agent/orchestration-units";
import { AGENT_SECURITY_UNITS } from "../security/numbat/agent-security-units";
import { RECURRING_APPROVAL_UNITS } from "../security/recurring-approval-units";
import { MCP_EVENT_UNITS } from "../mcp/events/mcp-event-units";

/**
 * The services domain's transaction units (async SQLite migration plan, DB6): the
 * repositories of the background and domain services, one unit module per area, routed
 * to the database worker by `COWORK_DB_WORKER_SERVICES`. Kept apart from the port so the
 * catalog registry can load it without a cycle.
 */
export const SERVICE_UNITS = {
  ...TEAMS_REFERENCE_UNITS,
  ...CHANNEL_DECISION_UNITS,
  ...NOTIFICATION_INBOX_UNITS,
  ...BOT_NOTIFICATION_UNITS,
  ...BOT_RESPONSIBILITY_UNITS,
  ...SCHEDULER_LEASE_UNITS,
  ...DISPATCH_BUDGET_UNITS,
  ...AGENT_UNITS,
  ...ROUTINE_UNITS,
  ...CORE_UNITS,
  ...SUBCONSCIOUS_UNITS,
  ...MANAGED_UNITS,
  ...IDENTITY_UNITS,
  ...WORKSPACE_UNITS,
  ...MISSION_CONTROL_UNITS,
  ...ACTIVITY_UNITS,
  ...TRIGGER_UNITS,
  ...AGENT_SIGNAL_UNITS,
  ...ACP_UNITS,
  ...PACT_UNITS,
  ...FILE_HUB_UNITS,
  ...BRIEFING_UNITS,
  ...YOUTUBE_UNITS,
  ...ANSWER_SURFACE_UNITS,
  ...USAGE_TELEMETRY_UNITS,
  ...CHANNEL_HISTORY_UNITS,
  ...PULSE_REPORT_UNITS,
  ...TEMP_WORKSPACE_UNITS,
  ...AUTOMATION_OUTCOME_UNITS,
  ...HOOK_SESSION_UNITS,
  ...CONTEXT_POLICY_UNITS,
  ...ORCHESTRATION_GRAPH_UNITS,
  ...ORCHESTRATION_UNITS,
  ...AGENT_SECURITY_UNITS,
  ...RECURRING_APPROVAL_UNITS,
  ...MCP_EVENT_UNITS,
};
