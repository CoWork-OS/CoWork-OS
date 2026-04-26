import type {
  EventType,
  EvidenceRef,
  TaskEvent,
  TaskTimelineEventV2,
  TimelineEventActor,
  TimelineEventStatus,
  TimelineEventType,
  TimelineStage,
} from "./types";

export const TIMELINE_SCHEMA_VERSION = 2 as const;

export const TIMELINE_EVENT_TYPES: readonly TimelineEventType[] = [
  "timeline_group_started",
  "timeline_group_finished",
  "timeline_step_started",
  "timeline_step_updated",
  "timeline_step_finished",
  "timeline_evidence_attached",
  "timeline_artifact_emitted",
  "timeline_command_output",
  "timeline_error",
] as const;

const TIMELINE_EVENT_SET = new Set<string>(TIMELINE_EVENT_TYPES);

const TIMELINE_STAGE_ACTIVITY_LABELS: Record<TimelineStage, string> = {
  DISCOVER: "Discovering",
  BUILD: "Building",
  VERIFY: "Checking results",
  FIX: "Fixing issues",
  DELIVER: "Preparing final response",
};

const ACTIVITY_VERB_LABELS: Record<string, string> = {
  add: "Adding",
  adapt: "Adapting",
  analyze: "Analyzing",
  apply: "Applying",
  build: "Building",
  check: "Checking",
  configure: "Configuring",
  continue: "Continuing",
  create: "Creating",
  delete: "Deleting",
  discover: "Discovering",
  ensure: "Ensuring",
  fetch: "Fetching",
  fix: "Fixing",
  generate: "Generating",
  implement: "Implementing",
  inspect: "Inspecting",
  install: "Installing",
  load: "Loading",
  modify: "Modifying",
  open: "Opening",
  parse: "Parsing",
  plan: "Planning",
  prepare: "Preparing",
  read: "Reading",
  refactor: "Refactoring",
  remove: "Removing",
  review: "Reviewing",
  run: "Running",
  search: "Searching",
  start: "Starting",
  summarize: "Summarizing",
  test: "Testing",
  update: "Updating",
  verify: "Checking",
  write: "Writing",
};

export function isTimelineEventType(value: unknown): value is TimelineEventType {
  return typeof value === "string" && TIMELINE_EVENT_SET.has(value);
}

export function formatTimelineActivityLabel(raw: string, maxLength = 72): string {
  let text = String(raw || "").trim();
  if (!text) return "";

  text = text.replace(/^["\u201c\u201d'`]+/, "").replace(/["\u201c\u201d'`]+$/, "");
  const quotedLead = text.match(/^["\u201c\u201d'`]([^"\u201c\u201d'`]{3,})["\u201c\u201d'`]/);
  if (quotedLead?.[1]) {
    text = quotedLead[1].trim();
  }
  text = (text.split(/(?<=[.!?])\s+|\s+[\u2014\u2013-]\s+/)[0] || text).trim();
  text = text.replace(/^Working on:\s*/i, "").trim();

  const upper = text.toUpperCase();
  if (upper in TIMELINE_STAGE_ACTIVITY_LABELS) {
    return TIMELINE_STAGE_ACTIVITY_LABELS[upper as TimelineStage];
  }

  if (/ing\b/i.test(text.split(/\s+/, 1)[0] || "")) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
  }

  const imperative = /^([A-Za-z]+)(\b[\s\S]*)$/.exec(text);
  if (imperative?.[1]) {
    const replacement = ACTIVITY_VERB_LABELS[imperative[1].toLowerCase()];
    if (replacement) {
      text = `${replacement}${imperative[2] || ""}`;
    }
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
}

function coerceEventStatus(value: unknown): TimelineEventStatus | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
    case "blocked":
    case "skipped":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

function coerceEventActor(value: unknown): TimelineEventActor | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "system":
    case "agent":
    case "user":
    case "tool":
    case "subagent":
      return value;
    default:
      return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function coerceNonEmptyText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = value as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.trim().length > 0) {
      return nested.message.trim();
    }
  }
  return undefined;
}

function resolveTimelineErrorMessage(payload: Record<string, unknown>): string | undefined {
  return (
    coerceNonEmptyText(payload.message) ||
    coerceNonEmptyText(payload.error) ||
    coerceNonEmptyText(payload.reason) ||
    coerceNonEmptyText(payload.display) ||
    coerceNonEmptyText(payload.failureReason)
  );
}

function deriveStepId(
  taskId: string,
  payload: Record<string, unknown>,
  fallback: string,
  defaultStepId?: string,
): string {
  if (typeof payload.stepId === "string" && payload.stepId.trim().length > 0) {
    return payload.stepId.trim();
  }
  const step = asObject(payload.step);
  if (typeof step.id === "string" && step.id.trim().length > 0) {
    return step.id.trim();
  }
  if (typeof payload.commandId === "string" && payload.commandId.trim().length > 0) {
    return `command:${payload.commandId.trim()}`;
  }
  if (typeof payload.tool === "string" && payload.tool.trim().length > 0) {
    return `tool:${payload.tool.trim()}`;
  }
  if (typeof defaultStepId === "string" && defaultStepId.trim().length > 0) {
    return defaultStepId.trim();
  }
  return `${fallback}:${taskId}`;
}

function inferLegacyTimelineType(
  legacyType: EventType,
  _payload: Record<string, unknown>,
): TimelineEventType {
  if (
    legacyType === "file_created" ||
    legacyType === "file_modified" ||
    legacyType === "file_deleted" ||
    legacyType === "artifact_created"
  ) {
    return "timeline_artifact_emitted";
  }

  if (legacyType === "command_output") {
    return "timeline_command_output";
  }

  if (legacyType === "citations_collected") {
    return "timeline_evidence_attached";
  }

  if (legacyType === "step_started") {
    return "timeline_step_started";
  }

  if (
    legacyType === "step_completed" ||
    legacyType === "step_skipped" ||
    legacyType === "task_completed" ||
    legacyType === "task_cancelled"
  ) {
    return "timeline_step_finished";
  }

  if (
    legacyType === "error" ||
    legacyType === "step_failed" ||
    legacyType === "verification_failed" ||
    legacyType === "tool_error" ||
    legacyType === "tool_protocol_violation" ||
    legacyType === "workspace_path_alias_recovery_failed" ||
    legacyType === "task_path_recovery_failed" ||
    legacyType === "follow_up_turn_recovery_blocked" ||
    legacyType === "safety_stop_triggered" ||
    legacyType === "llm_error" ||
    legacyType === "step_timeout" ||
    legacyType === "follow_up_failed"
  ) {
    return "timeline_error";
  }

  if (legacyType === "verification_pending_user_action") {
    return "timeline_step_updated";
  }

  if (legacyType === "workflow_phase_started" || legacyType === "workflow_detected") {
    return "timeline_group_started";
  }

  if (
    legacyType === "workflow_phase_completed" ||
    legacyType === "pipeline_completed" ||
    legacyType === "workflow_phase_failed"
  ) {
    return "timeline_group_finished";
  }

  return "timeline_step_updated";
}

function inferLegacyStatus(
  legacyType: EventType,
  payload: Record<string, unknown>,
): TimelineEventStatus {
  const explicit = coerceEventStatus(payload.status);
  if (explicit) return explicit;

  switch (legacyType) {
    case "task_queued":
      return "pending";
    case "task_paused":
    case "approval_requested":
    case "input_request_created":
    case "input_request_dismissed":
      return "blocked";
    case "step_started":
    case "task_created":
    case "task_resumed":
    case "task_dequeued":
    case "executing":
      return "in_progress";
    case "step_completed":
    case "verification_passed":
    case "task_completed":
    case "input_request_resolved":
      return "completed";
    case "verification_pending_user_action":
      return "blocked";
    case "step_skipped":
      return "skipped";
    case "task_cancelled":
      return "cancelled";
    case "auto_continuation_blocked":
    case "follow_up_turn_recovery_blocked":
    case "safety_stop_triggered":
    case "no_progress_circuit_breaker":
    case "workspace_path_alias_recovery_failed":
    case "task_path_recovery_failed":
      return "failed";
    case "workspace_path_alias_recovery_attempted":
    case "task_path_recovery_attempted":
      return "completed";
    case "task_path_root_pinned":
    case "task_path_rewrite_applied":
    case "tool_disable_suppressed_recoverable_path_drift":
      return "in_progress";
    case "follow_up_turn_recovery_completed":
      return "completed";
    case "error":
    case "step_failed":
    case "verification_failed":
    case "tool_error":
    case "tool_protocol_violation":
    case "llm_error":
    case "step_timeout":
    case "approval_denied":
      return "failed";
    default:
      return "in_progress";
  }
}

function inferLegacyActor(legacyType: EventType): TimelineEventActor {
  if (legacyType === "user_message" || legacyType === "user_feedback") {
    return "user";
  }
  if (legacyType === "assistant_message" || legacyType === "agent_thought") {
    return "agent";
  }
  if (
    legacyType === "tool_call" ||
    legacyType === "tool_result" ||
    legacyType === "tool_error" ||
    legacyType === "command_output"
  ) {
    return "tool";
  }
  if (
    legacyType === "agent_spawned" ||
    legacyType === "agent_completed" ||
    legacyType === "agent_failed" ||
    legacyType === "sub_agent_result"
  ) {
    return "subagent";
  }
  return "system";
}

function toEvidenceRefs(payload: Record<string, unknown>, timestamp: number): EvidenceRef[] {
  const raw = payload.evidenceRefs;
  if (Array.isArray(raw)) {
    const refs: EvidenceRef[] = [];
    raw.forEach((entry, index) => {
        const obj = asObject(entry);
        const evidenceId =
          typeof obj.evidenceId === "string" && obj.evidenceId.trim().length > 0
            ? obj.evidenceId.trim()
            : `evidence-${index + 1}`;
        const sourceType =
          obj.sourceType === "url" ||
          obj.sourceType === "file" ||
          obj.sourceType === "tool_output" ||
          obj.sourceType === "user_input" ||
          obj.sourceType === "other"
            ? obj.sourceType
            : "other";
        const sourceUrlOrPath =
          typeof obj.sourceUrlOrPath === "string" && obj.sourceUrlOrPath.trim().length > 0
            ? obj.sourceUrlOrPath.trim()
            : "";
        if (!sourceUrlOrPath) return;
        refs.push({
          evidenceId,
          sourceType,
          sourceUrlOrPath,
          snippet: typeof obj.snippet === "string" ? obj.snippet : undefined,
          capturedAt:
            typeof obj.capturedAt === "number" && Number.isFinite(obj.capturedAt)
              ? obj.capturedAt
              : timestamp,
        });
      });
    return refs;
  }

  const citations = payload.citations;
  if (!Array.isArray(citations) || citations.length === 0) return [];

  const refs: EvidenceRef[] = [];
  citations.forEach((citation, index) => {
    const obj = asObject(citation);
    const url =
      typeof obj.url === "string" && obj.url.trim().length > 0
        ? obj.url.trim()
        : typeof obj.source === "string" && obj.source.trim().length > 0
          ? obj.source.trim()
          : "";
    if (!url) return;
    const snippet =
      typeof obj.snippet === "string"
        ? obj.snippet
        : typeof obj.title === "string"
          ? obj.title
          : undefined;
    refs.push({
      evidenceId: `citation-${index + 1}`,
      sourceType: "url",
      sourceUrlOrPath: url,
      snippet,
      capturedAt: timestamp,
    });
  });

  return refs;
}

/**
 * Returns a user-facing sub-stage label for events that map to BUILD, FIX, or other stages.
 * Used to show more specific progress in the UI instead of generic stage labels.
 */
export function inferTimelineSubStageLabel(type: EventType): string | undefined {
  switch (type) {
    // BUILD: file operations
    case "file_created":
      return "Creating file";
    case "file_modified":
      return "Modifying file";
    case "file_deleted":
      return "Deleting file";
    // Preflight / workspace setup (early in task)
    case "workspace_path_alias_normalized":
    case "task_path_root_pinned":
    case "task_path_rewrite_applied":
      return "Preparing workspace";
    case "verification_preflight_policy_applied":
    case "verification_text_checklist_evaluated":
    case "verification_mode_selected":
      return "Preparing verification";
    case "task_list_verification_nudged":
      return "Preparing verification";
    // Recovery (something went wrong, retrying)
    case "step_failed":
    case "tool_error":
    case "mutation_checkpoint_retry_applied":
      return "Applying fixes";
    case "task_list_created":
    case "task_list_updated":
      return "Updating checklist";
    case "retry_started":
      return "Retrying";
    case "workspace_path_alias_recovery_attempted":
    case "workspace_path_alias_recovery_failed":
    case "task_path_recovery_attempted":
    case "task_path_recovery_failed":
    case "workspace_boundary_recovery":
      return "Restoring workspace";
    // Context / continuation
    case "continuation_decision":
    case "auto_continuation_blocked":
      return "Preparing next steps";
    case "auto_continuation_started":
      return "Continuing";
    case "context_compaction_started":
    case "context_compaction_completed":
    case "context_compaction_failed":
      return "Making room to continue";
    // Plan / contract reconciliation
    case "step_contract_escalated":
    case "plan_contract_conflict":
    case "step_contract_satisfied_by_prior_mutation":
    case "mutation_duplicate_bypass_applied":
    case "step_contract_reconciled_posthoc":
      return "Adjusting approach";
    case "execution_mode_auto_promoted":
    case "required_tool_inference_decision":
      return "Adjusting the plan";
    // Verification-related
    case "verification_failed":
    case "verification_checklist_evaluated":
    case "verification_artifact_output_downgraded":
    case "verification_missing_artifact_ignored":
      return "Verifying results";
    // Follow-up / turn / protocol
    case "follow_up_tool_lock_forced_finalization":
      return "Finalizing";
    case "tool_protocol_violation":
    case "tool_disable_suppressed_recoverable_path_drift":
      return "Resolving protocol issue";
    case "turn_window_soft_exhausted":
    case "follow_up_turn_recovery_started":
    case "follow_up_turn_recovery_completed":
    case "follow_up_turn_recovery_blocked":
    case "safety_stop_triggered":
    case "turn_policy_selected":
    case "no_progress_circuit_breaker":
      return "Managing workflow";
    default:
      return undefined;
  }
}

export function inferTimelineStageForLegacyType(type: EventType): TimelineStage | undefined {
  switch (type) {
    case "task_created":
    case "plan_created":
    case "plan_revised":
      return "DISCOVER";
    case "step_started":
    case "step_completed":
    case "tool_call":
    case "tool_result":
    case "file_created":
    case "file_modified":
    case "file_deleted":
    case "artifact_created":
    case "command_output":
    case "task_list_created":
    case "task_list_updated":
      return "BUILD";
    case "verification_started":
    case "verification_passed":
    case "verification_pending_user_action":
    case "task_list_verification_nudged":
      return "VERIFY";
    case "verification_failed":
    case "retry_started":
    case "continuation_decision":
    case "auto_continuation_started":
    case "auto_continuation_blocked":
    case "context_compaction_started":
    case "context_compaction_completed":
    case "context_compaction_failed":
    case "step_contract_escalated":
    case "execution_mode_auto_promoted":
    case "plan_contract_conflict":
    case "workspace_boundary_recovery":
    case "workspace_path_alias_normalized":
    case "workspace_path_alias_recovery_attempted":
    case "workspace_path_alias_recovery_failed":
    case "task_path_root_pinned":
    case "task_path_rewrite_applied":
    case "task_path_recovery_attempted":
    case "task_path_recovery_failed":
    case "tool_disable_suppressed_recoverable_path_drift":
    case "mutation_checkpoint_retry_applied":
    case "step_contract_satisfied_by_prior_mutation":
    case "required_tool_inference_decision":
    case "mutation_duplicate_bypass_applied":
    case "step_contract_reconciled_posthoc":
    case "verification_checklist_evaluated":
    case "verification_mode_selected":
    case "follow_up_tool_lock_forced_finalization":
    case "tool_protocol_violation":
    case "turn_window_soft_exhausted":
    case "follow_up_turn_recovery_started":
    case "follow_up_turn_recovery_completed":
    case "follow_up_turn_recovery_blocked":
    case "safety_stop_triggered":
    case "verification_preflight_policy_applied":
    case "verification_artifact_output_downgraded":
    case "verification_missing_artifact_ignored":
    case "verification_text_checklist_evaluated":
    case "no_progress_circuit_breaker":
    case "step_failed":
    case "tool_error":
      return "FIX";
    case "task_completed":
      return "DELIVER";
    default:
      return undefined;
  }
}

export function stageToGroupId(stage: TimelineStage): string {
  return `stage:${stage.toLowerCase()}`;
}

export function normalizeTaskEventToTimelineV2(params: {
  taskId: string;
  type: string;
  payload: unknown;
  timestamp: number;
  eventId: string;
  seq: number;
  defaultStepId?: string;
  explicitGroupId?: string;
}): TaskTimelineEventV2 {
  const payload = asObject(params.payload);
  const rawType = params.type;

  if (isTimelineEventType(rawType)) {
    const status =
      coerceEventStatus(payload.status) ||
      (rawType === "timeline_group_finished" || rawType === "timeline_step_finished"
        ? "completed"
        : rawType === "timeline_error"
          ? "failed"
          : "in_progress");
    const actor = coerceEventActor(payload.actor) || "system";
    const stepId = deriveStepId(params.taskId, payload, "timeline", params.defaultStepId);
    const groupId =
      (typeof payload.groupId === "string" && payload.groupId.trim().length > 0
        ? payload.groupId.trim()
        : params.explicitGroupId) || undefined;
    const eventId =
      typeof payload.eventId === "string" && payload.eventId.trim().length > 0
        ? payload.eventId.trim()
        : params.eventId;
    const ts =
      typeof payload.ts === "number" && Number.isFinite(payload.ts) ? payload.ts : params.timestamp;

    const maybeEvidenceRefs =
      rawType === "timeline_evidence_attached" ? toEvidenceRefs(payload, params.timestamp) : [];
    const nextPayloadBase =
      maybeEvidenceRefs.length > 0 ? { ...payload, evidenceRefs: maybeEvidenceRefs } : payload;
    const nextPayload =
      rawType === "timeline_error"
        ? {
            ...nextPayloadBase,
            ...(resolveTimelineErrorMessage(nextPayloadBase)
              ? { message: resolveTimelineErrorMessage(nextPayloadBase) }
              : {}),
          }
        : nextPayloadBase;

    return {
      id: eventId,
      taskId: params.taskId,
      timestamp: params.timestamp,
      type: rawType,
      payload: nextPayload,
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      eventId,
      seq: params.seq,
      ts,
      status,
      stepId,
      ...(groupId ? { groupId } : {}),
      actor,
      legacyType:
        typeof payload.legacyType === "string" ? (payload.legacyType as EventType) : undefined,
    };
  }

  const legacyType = rawType as EventType;
  const timelineType = inferLegacyTimelineType(legacyType, payload);
  const status = inferLegacyStatus(legacyType, payload);
  const actor = inferLegacyActor(legacyType);
  const stepId = deriveStepId(params.taskId, payload, "task", params.defaultStepId);
  const stage = inferTimelineStageForLegacyType(legacyType);
  const groupId =
    (typeof payload.groupId === "string" && payload.groupId.trim().length > 0
      ? payload.groupId.trim()
      : params.explicitGroupId) ||
    (stage ? stageToGroupId(stage) : undefined);

  const nextPayload: Record<string, unknown> = {
    ...payload,
    legacyType,
  };
  if (timelineType === "timeline_evidence_attached") {
    nextPayload.evidenceRefs = toEvidenceRefs(payload, params.timestamp);
  }
  if (timelineType === "timeline_error") {
    const resolvedMessage = resolveTimelineErrorMessage(nextPayload);
    if (resolvedMessage) {
      nextPayload.message = resolvedMessage;
    }
  }

  return {
    id: params.eventId,
    taskId: params.taskId,
    timestamp: params.timestamp,
    type: timelineType,
    payload: nextPayload,
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    eventId: params.eventId,
    seq: params.seq,
    ts: params.timestamp,
    status,
    stepId,
    ...(groupId ? { groupId } : {}),
    actor,
    legacyType,
  };
}

function defaultLegacyTypeForTimeline(
  type: TimelineEventType,
  status: TimelineEventStatus,
): EventType {
  switch (type) {
    case "timeline_group_started":
      return "step_started";
    case "timeline_group_finished":
      return "step_completed";
    case "timeline_step_started":
      return "step_started";
    case "timeline_step_updated":
      return "progress_update";
    case "timeline_step_finished":
      if (status === "failed") return "step_failed";
      if (status === "skipped") return "step_skipped";
      if (status === "cancelled") return "task_cancelled";
      return "step_completed";
    case "timeline_evidence_attached":
      return "citations_collected";
    case "timeline_artifact_emitted":
      return "artifact_created";
    case "timeline_command_output":
      return "command_output";
    case "timeline_error":
      return "error";
    default:
      return "progress_update";
  }
}

export function projectTimelineEventToLegacy(event: TaskEvent): TaskEvent {
  if (!isTimelineEventType(event.type)) return event;
  const payload = asObject(event.payload);
  const status = coerceEventStatus(event.status ?? payload.status) || "in_progress";
  const legacyTypeRaw = typeof payload.legacyType === "string" ? payload.legacyType : undefined;
  const legacyType =
    legacyTypeRaw && !isTimelineEventType(legacyTypeRaw)
      ? (legacyTypeRaw as EventType)
      : defaultLegacyTypeForTimeline(event.type, status);

  const legacyPayload = { ...payload };
  delete legacyPayload.legacyType;

  if (
    (legacyType === "step_started" || legacyType === "step_completed" || legacyType === "step_failed") &&
    !legacyPayload.step
  ) {
    legacyPayload.step = {
      id: event.stepId || `step:${event.taskId}`,
      description:
        (typeof payload.message === "string" && payload.message) ||
        (typeof payload.groupLabel === "string" && payload.groupLabel) ||
        "Timeline step",
    };
  }

  return {
    id: event.id,
    taskId: event.taskId,
    timestamp: event.timestamp,
    type: legacyType,
    payload: legacyPayload,
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    seq: event.seq,
    ts: event.ts,
    status: event.status,
    stepId: event.stepId,
    groupId: event.groupId,
    actor: event.actor,
    legacyType: event.legacyType,
  };
}

export function extractTimelineEvidenceRefs(event: TaskEvent): EvidenceRef[] {
  const payload = asObject(event.payload);
  const now = typeof event.timestamp === "number" ? event.timestamp : Date.now();
  return toEvidenceRefs(payload, now);
}
