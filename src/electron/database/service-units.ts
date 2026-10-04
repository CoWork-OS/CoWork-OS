import { AGENT_UNITS } from "../agents/agent-units";
import { CORE_UNITS } from "../core/core-units";
import { IDENTITY_UNITS } from "../identity/identity-units";
import { MANAGED_UNITS } from "../managed/managed-units";
import { WORKSPACE_UNITS } from "../workspaces/workspace-units";
import { EVAL_UNITS } from "../eval/eval-units";
import { EVERYDAY_AGENT_UNITS } from "../everyday-agent/everyday-agent-units";
import { ACTIVITY_UNITS } from "../activity/activity-units";
import { COUNCIL_UNITS } from "../council/council-units";
import { TRIGGER_UNITS } from "../triggers/trigger-units";
import { AGENT_SIGNAL_UNITS } from "../agents/agent-signal-units";
import { ACP_UNITS } from "../acp/acp-units";
import { FILE_HUB_UNITS } from "../file-hub/file-hub-units";
import { FIRST_TASK_UNITS } from "../first-task/first-task-units";
import { BRIEFING_UNITS } from "../briefing/briefing-units";
import { YOUTUBE_UNITS } from "../youtube/youtube-units";
import { USAGE_TELEMETRY_UNITS } from "../agent/llm/usage-telemetry-units";
import { CHANNEL_HISTORY_UNITS } from "../agent/tools/channel-history-units";
import { PULSE_REPORT_UNITS } from "../telemetry/pulse-report-units";
import { TEMP_WORKSPACE_UNITS } from "../utils/temp-workspace-units";
import { ROUTINE_UNITS } from "../routines/routine-units";
import { SUBCONSCIOUS_UNITS } from "../subconscious/subconscious-units";
import { MISSION_CONTROL_UNITS } from "../mission-control/mission-control-units";
import { AUTOMATION_OUTCOME_UNITS } from "../automation/automation-outcome-units";
import { SUPERVISOR_UNITS } from "../supervisor/supervisor-units";
import { HOOK_SESSION_UNITS } from "../hooks/hook-session-units";
import { CONTEXT_POLICY_UNITS } from "../gateway/context-policy-units";
import { ORCHESTRATION_GRAPH_UNITS } from "../agent/orchestration/orchestration-graph-units";
import { ORCHESTRATION_UNITS } from "../agent/orchestration-units";
import { AGENT_SECURITY_UNITS } from "../security/numbat/agent-security-units";
import { RECURRING_APPROVAL_UNITS } from "../security/recurring-approval-units";

/**
 * The services domain's transaction units (async SQLite migration plan, DB6): the
 * repositories of the background and domain services, one unit module per area, routed
 * to the database worker by `COWORK_DB_WORKER_SERVICES`. Kept apart from the port so the
 * catalog registry can load it without a cycle.
 */
export const SERVICE_UNITS = {
  ...AGENT_UNITS,
  ...ROUTINE_UNITS,
  ...CORE_UNITS,
  ...SUBCONSCIOUS_UNITS,
  ...MANAGED_UNITS,
  ...IDENTITY_UNITS,
  ...WORKSPACE_UNITS,
  ...EVAL_UNITS,
  ...EVERYDAY_AGENT_UNITS,
  ...MISSION_CONTROL_UNITS,
  ...ACTIVITY_UNITS,
  ...COUNCIL_UNITS,
  ...TRIGGER_UNITS,
  ...AGENT_SIGNAL_UNITS,
  ...ACP_UNITS,
  ...FILE_HUB_UNITS,
  ...FIRST_TASK_UNITS,
  ...BRIEFING_UNITS,
  ...YOUTUBE_UNITS,
  ...USAGE_TELEMETRY_UNITS,
  ...CHANNEL_HISTORY_UNITS,
  ...PULSE_REPORT_UNITS,
  ...TEMP_WORKSPACE_UNITS,
  ...AUTOMATION_OUTCOME_UNITS,
  ...SUPERVISOR_UNITS,
  ...HOOK_SESSION_UNITS,
  ...CONTEXT_POLICY_UNITS,
  ...ORCHESTRATION_GRAPH_UNITS,
  ...ORCHESTRATION_UNITS,
  ...AGENT_SECURITY_UNITS,
  ...RECURRING_APPROVAL_UNITS,
};
