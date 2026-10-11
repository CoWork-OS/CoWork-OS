import type { Task, TaskEvent } from "./types";

export const TASK_EVENT_STATUS_MAP: Readonly<Partial<Record<string, Task["status"]>>> = {
  task_created: "pending",
  task_queued: "queued",
  task_dequeued: "planning",
  task_resumed: "executing",
  continuation_decision: "executing",
  auto_continuation_started: "executing",
  auto_continuation_blocked: "paused",
  context_compaction_started: "executing",
  context_compaction_completed: "executing",
  context_compaction_failed: "executing",
  step_contract_escalated: "executing",
  workspace_path_alias_normalized: "executing",
  workspace_path_alias_recovery_attempted: "executing",
  workspace_path_alias_recovery_failed: "executing",
  task_path_root_pinned: "executing",
  task_path_rewrite_applied: "executing",
  task_path_recovery_attempted: "executing",
  task_path_recovery_failed: "executing",
  tool_disable_suppressed_recoverable_path_drift: "executing",
  mutation_checkpoint_retry_applied: "executing",
  no_progress_circuit_breaker: "paused",
  plan_created: "planning",
  plan_revised: "planning",
  executing: "executing",
  progress_update: "executing",
  step_started: "executing",
  step_completed: "executing",
  tool_call: "executing",
  tool_result: "executing",
  tool_error: "executing",
  timeline_group_started: "executing",
  timeline_group_finished: "executing",
  timeline_step_started: "executing",
  timeline_step_updated: "executing",
  timeline_step_finished: "executing",
  timeline_evidence_attached: "executing",
  timeline_artifact_emitted: "executing",
  timeline_command_output: "executing",
  verification_passed: "executing",
  verification_pending_user_action: "executing",
  file_created: "executing",
  file_modified: "executing",
  file_deleted: "executing",
  artifact_created: "executing",
  task_list_created: "executing",
  task_list_updated: "executing",
  task_list_verification_nudged: "executing",
  task_completed: "completed",
  task_paused: "paused",
  approval_requested: "blocked",
  approval_granted: "executing",
  approval_denied: "paused",
  input_request_created: "paused",
  input_request_resolved: "executing",
  input_request_dismissed: "paused",
  llm_error: "failed",
  step_timeout: "failed",
  error: "failed",
  task_cancelled: "cancelled",
  task_interrupted: "interrupted",
};

/** Resolve payload-sensitive progress without reactivating a paused session. */
export function getTaskEventStatus(
  type: string,
  payload?: TaskEvent["payload"],
): Task["status"] | undefined {
  // Live renderer events arrive as timeline envelopes that carry the legacy type.
  const legacyType = typeof payload?.legacyType === "string" ? payload.legacyType : undefined;
  const progressType = type.startsWith("timeline_") && legacyType ? legacyType : type;
  if (progressType === "progress_update" && payload?.message === "Paused - awaiting user input") {
    return "paused";
  }
  return type === "task_status" ? payload?.status : TASK_EVENT_STATUS_MAP[type];
}
