export const TASK_EVENT_BRIDGE_ALLOWLIST = [
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "input_request_created",
  "input_request_resolved",
  "input_request_dismissed",
  "timeline_group_started",
  "timeline_group_finished",
  "timeline_step_started",
  "timeline_step_updated",
  "timeline_step_finished",
  "timeline_evidence_attached",
  "timeline_artifact_emitted",
  "timeline_command_output",
  "timeline_error",
  "task_impact_updated",
] as const;

export type TaskEventBridgeAllowlistEvent = (typeof TASK_EVENT_BRIDGE_ALLOWLIST)[number];
