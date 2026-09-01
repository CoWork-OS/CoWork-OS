import type {
  ActivityGroupViewModel,
  PlanStep,
  Task,
  TaskEvent,
  TaskImpactMetric,
  TaskOutputSummary,
  TaskStatusStripState,
  TaskStatusStripViewModel,
} from "../../shared/types";
import { formatTimelineActivityLabel, inferTimelineSubStageLabel } from "../../shared/timeline-v2";
import { isVerificationStepDescription } from "../../shared/plan-utils";
import { getEffectiveTaskEventType } from "./task-event-compat";
import { friendlyToolLaneCompletedLabel, friendlyToolRunningLabel } from "./timeline-tool-labels";
import { selectTaskStatusMetricSlots } from "./task-impact-metrics";
import { deriveApprovalEventState } from "./approval-event-state";

interface ActivityBlockSource {
  kind: "action_block";
  blockId: string;
  events: TaskEvent[];
  timestamp: number;
}

interface EventSource {
  kind: "event";
  event: TaskEvent;
}

type ActivityProjectionSource = ActivityBlockSource | EventSource;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numericRevision(event: TaskEvent): number | null {
  const payload = asObject(event.payload);
  const plan = asObject(payload.plan);
  for (const value of [payload.revision, payload.revisionNumber, plan.revision]) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  }
  return null;
}

function compareEventOrder(
  a: { event: TaskEvent; index: number },
  b: { event: TaskEvent; index: number },
): number {
  const aSeq = typeof a.event.seq === "number" ? a.event.seq : null;
  const bSeq = typeof b.event.seq === "number" ? b.event.seq : null;
  if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
  if (aSeq !== null && bSeq === null) return -1;
  if (aSeq === null && bSeq !== null) return 1;
  if (a.event.timestamp !== b.event.timestamp) return a.event.timestamp - b.event.timestamp;
  return a.index - b.index;
}

function normalizePlanStep(value: unknown, fallbackId: string): PlanStep | null {
  const step = asObject(value);
  const description =
    typeof step.description === "string"
      ? step.description.trim()
      : typeof step.title === "string"
        ? step.title.trim()
        : "";
  if (!description) return null;
  const status: PlanStep["status"] =
    step.status === "in_progress" ||
    step.status === "completed" ||
    step.status === "failed" ||
    step.status === "skipped"
      ? step.status
      : "pending";
  return {
    ...(step as unknown as PlanStep),
    id: typeof step.id === "string" && step.id.trim() ? step.id.trim() : fallbackId,
    description,
    status,
  };
}

function applyPlanDelta(current: PlanStep[], event: TaskEvent, eventIndex: number): PlanStep[] {
  const payload = asObject(event.payload);
  let next = current.map((step) => ({ ...step }));
  const removedIds = Array.isArray(payload.removedStepIds)
    ? new Set(payload.removedStepIds.filter((id): id is string => typeof id === "string"))
    : new Set<string>();
  if (removedIds.size > 0) next = next.filter((step) => !removedIds.has(step.id));

  if (payload.clearRemaining === true) {
    const activeIndex = next.findIndex((step) => step.status === "in_progress");
    next = next.filter(
      (step, index) => step.status !== "pending" || (activeIndex >= 0 && index <= activeIndex),
    );
  }

  const renamedSteps = asObject(payload.renamedSteps);
  next = next.map((step) => {
    const renamed = renamedSteps[step.id];
    return typeof renamed === "string" && renamed.trim()
      ? { ...step, description: renamed.trim() }
      : step;
  });

  const rawNewSteps = Array.isArray(payload.newSteps) ? payload.newSteps : [];
  const additions = rawNewSteps
    .map((value, index) =>
      normalizePlanStep(
        typeof value === "string" ? { description: value } : value,
        `revision:${event.id || eventIndex}:${index}`,
      ),
    )
    .filter((step): step is PlanStep => Boolean(step));
  if (additions.length > 0) {
    const activeIndex = next.findIndex((step) => step.status === "in_progress");
    if (activeIndex >= 0) next.splice(activeIndex + 1, 0, ...additions);
    else next.push(...additions);
  }
  return next;
}

/** Select the newest valid plan definition, then fold only causally newer step state. */
export function deriveRevisionAwarePlanSteps(events: TaskEvent[]): PlanStep[] {
  const ordered = events.map((event, index) => ({ event, index })).sort(compareEventOrder);
  let steps: PlanStep[] = [];
  let selectedRevision = -1;
  let selectedOrderIndex = -1;

  for (let orderIndex = 0; orderIndex < ordered.length; orderIndex += 1) {
    const { event, index } = ordered[orderIndex];
    const type = getEffectiveTaskEventType(event);
    if (type !== "plan_created" && type !== "plan_updated" && type !== "plan_revised") continue;
    const revision = numericRevision(event) ?? (type === "plan_created" ? 0 : selectedRevision + 1);
    if (revision < selectedRevision) continue;
    const payload = asObject(event.payload);
    const plan = asObject(payload.plan);
    const rawSteps = Array.isArray(plan.steps) ? plan.steps : null;
    if (rawSteps) {
      const normalized = rawSteps
        .map((step, stepIndex) => normalizePlanStep(step, `plan:${event.id}:${stepIndex}`))
        .filter((step): step is PlanStep => Boolean(step));
      if (normalized.length > 0 || rawSteps.length === 0) {
        steps = normalized;
        selectedRevision = revision;
        selectedOrderIndex = orderIndex;
      }
    } else if (steps.length > 0) {
      steps = applyPlanDelta(steps, event, index);
      selectedRevision = revision;
      selectedOrderIndex = orderIndex;
    }
  }

  if (selectedOrderIndex < 0) return [];
  const stepIndexById = new Map(steps.map((step, index) => [step.id, index]));
  for (let orderIndex = selectedOrderIndex + 1; orderIndex < ordered.length; orderIndex += 1) {
    const event = ordered[orderIndex].event;
    const type = getEffectiveTaskEventType(event);
    if (
      type !== "step_started" &&
      type !== "step_completed" &&
      type !== "step_failed" &&
      type !== "step_skipped"
    ) {
      continue;
    }
    const payload = asObject(event.payload);
    const stepPayload = asObject(payload.step);
    const stepId =
      typeof stepPayload.id === "string"
        ? stepPayload.id
        : typeof event.stepId === "string"
          ? event.stepId
          : "";
    const index = stepIndexById.get(stepId);
    if (index === undefined) continue;
    const current = steps[index];
    if (type === "step_started") {
      steps[index] = { ...current, status: "in_progress", startedAt: event.timestamp };
    } else if (type === "step_completed") {
      steps[index] = { ...current, status: "completed", completedAt: event.timestamp };
    } else if (type === "step_failed") {
      steps[index] = {
        ...current,
        status: "failed",
        completedAt: event.timestamp,
        error: typeof payload.reason === "string" ? payload.reason : current.error,
      };
    } else {
      steps[index] = { ...current, status: "skipped", completedAt: event.timestamp };
    }
  }

  return steps.filter(
    (step) =>
      step.kind !== "verification" &&
      (!isVerificationStepDescription(step.description) || step.status === "failed"),
  );
}

function activityLabel(event: TaskEvent, running: boolean): string {
  const payload = asObject(event.payload);
  const step = asObject(payload.step);
  const type = getEffectiveTaskEventType(event);
  const candidates = [payload.activityLabel, payload.message, step.description];
  if (type === "progress_update" || type === "step_started" || type === "step_completed") {
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      const label = formatTimelineActivityLabel(candidate);
      if (label) return label;
    }
  }
  if (type === "tool_call" || type === "tool_result" || type === "tool_error") {
    const tool = typeof payload.tool === "string" ? payload.tool : undefined;
    if (type === "tool_call") return friendlyToolRunningLabel(tool);
    return friendlyToolLaneCompletedLabel(tool, type === "tool_error" || eventIsFailure(event));
  }
  if (type === "approval_requested") return "Waiting for approval";
  if (type === "approval_denied") return "Approval denied";
  if (type === "approval_granted") return "Approval granted";
  if (type === "input_request_created") return "Waiting for input";
  if (type === "verification_started") return "Checking results";
  if (type === "verification_passed") return "Verification passed";
  if (type === "verification_failed") return "Verification failed";
  if (type === "error" || type === "step_failed" || event.type === "timeline_error") {
    return "An activity failed";
  }
  return (
    inferTimelineSubStageLabel(type as TaskEvent["type"]) ||
    (running ? "Working" : "Activity complete")
  );
}

function eventIsFailure(event: TaskEvent): boolean {
  const type = getEffectiveTaskEventType(event);
  return (
    type === "error" ||
    type === "tool_error" ||
    type === "step_failed" ||
    type === "verification_failed" ||
    event.status === "failed" ||
    event.type === "timeline_error"
  );
}

function eventIsBlocked(event: TaskEvent): boolean {
  const type = getEffectiveTaskEventType(event);
  return (
    type === "approval_requested" || type === "input_request_created" || event.status === "blocked"
  );
}

function resolveGroupPlanStepId(events: TaskEvent[], planSteps: PlanStep[]): string | undefined {
  const known = new Set(planSteps.map((step) => step.id));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const payload = asObject(event.payload);
    const step = asObject(payload.step);
    const stepId =
      typeof event.stepId === "string" ? event.stepId : typeof step.id === "string" ? step.id : "";
    if (known.has(stepId)) return stepId;
  }
  return planSteps.find((step) => step.status === "in_progress")?.id;
}

export function deriveActivityGroups(args: {
  timelineItems: ActivityProjectionSource[];
  fallbackEvents?: TaskEvent[];
  planSteps: PlanStep[];
  task?: Task | null;
  isReplayMode?: boolean;
}): ActivityGroupViewModel[] {
  const blocks = args.timelineItems.filter(
    (item): item is ActivityBlockSource => item.kind === "action_block",
  );
  const taskWorking =
    args.task?.status === "planning" ||
    args.task?.status === "executing" ||
    args.task?.status === "paused" ||
    args.task?.status === "blocked" ||
    args.task?.status === "interrupted";

  const groups = blocks.map((block, index) => {
    const isLatest = index === blocks.length - 1;
    const blocked = block.events.some(eventIsBlocked) && isLatest;
    const failed = block.events.some(eventIsFailure);
    const hasExplicitFinish = block.events.some(
      (event) => event.type === "timeline_group_finished",
    );
    const running =
      isLatest &&
      !hasExplicitFinish &&
      !failed &&
      !blocked &&
      (taskWorking || args.isReplayMode === true);
    const status: ActivityGroupViewModel["status"] = blocked
      ? "blocked"
      : failed
        ? "failed"
        : running
          ? "running"
          : "completed";
    const latestEvent = block.events[block.events.length - 1];
    const planStepId = resolveGroupPlanStepId(block.events, args.planSteps);
    const planStep = args.planSteps.find((step) => step.id === planStepId);
    const summary =
      status === "running"
        ? "Working"
        : status === "failed"
          ? "Activity failed"
          : status === "blocked"
            ? "Waiting"
            : planStep?.description || "Activity complete";
    return {
      id: block.blockId,
      status,
      summary,
      latestActivityLabel: latestEvent
        ? activityLabel(latestEvent, status === "running")
        : planStep?.description || summary,
      activityIds: block.events.map((event) => event.id).filter(Boolean),
      startedAt: block.events[0]?.timestamp ?? block.timestamp,
      ...(status === "running" ? {} : { finishedAt: latestEvent?.timestamp ?? block.timestamp }),
      ...(planStepId ? { planStepId } : {}),
    };
  });

  const lastUserTimestamp = (args.fallbackEvents || []).reduce(
    (latest, event) =>
      getEffectiveTaskEventType(event) === "user_message"
        ? Math.max(latest, event.timestamp)
        : latest,
    0,
  );
  const fallbackEvent = [...(args.fallbackEvents || [])].reverse().find((event) => {
    if (event.timestamp < lastUserTimestamp) return false;
    const type = getEffectiveTaskEventType(event);
    return type === "tool_call" || type === "tool_result" || type === "tool_error";
  });
  if (!fallbackEvent) return groups;

  const latestGroup = groups[groups.length - 1];
  const latestGroupTimestamp = latestGroup?.finishedAt ?? latestGroup?.startedAt ?? 0;
  const fallbackLabel = activityLabel(fallbackEvent, taskWorking);
  if (latestGroup && fallbackEvent.timestamp >= latestGroupTimestamp) {
    return [
      ...groups.slice(0, -1),
      {
        ...latestGroup,
        latestActivityLabel: fallbackLabel,
        activityIds: Array.from(new Set([...latestGroup.activityIds, fallbackEvent.id])),
      },
    ];
  }
  if (groups.length > 0) return groups;

  const failed = eventIsFailure(fallbackEvent);
  const status: ActivityGroupViewModel["status"] = failed
    ? "failed"
    : taskWorking
      ? "running"
      : "completed";
  return [
    {
      id: `activity-fallback:${fallbackEvent.taskId}`,
      status,
      summary: failed ? "Activity failed" : status === "running" ? "Working" : fallbackLabel,
      latestActivityLabel: fallbackLabel,
      activityIds: [fallbackEvent.id],
      startedAt: fallbackEvent.timestamp,
      ...(status === "running" ? {} : { finishedAt: fallbackEvent.timestamp }),
    },
  ];
}

function humanizeIdentifier(value: string): string {
  const normalized = value.replace(/[_-]+/g, " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "";
}

function deriveBlockingState(events: TaskEvent[]): {
  state: "approval" | "input";
  label: string;
  eventId: string;
} | null {
  const approval = deriveApprovalEventState(events).pendingRequests.at(-1) ?? null;
  let input: TaskEvent | null = null;
  for (const event of events) {
    const type = getEffectiveTaskEventType(event);
    if (type === "input_request_created") input = event;
    if (type === "input_request_resolved" || type === "input_request_dismissed") input = null;
  }
  if (approval) {
    const payload = asObject(approval.payload);
    const approvalPayload = asObject(payload.approval);
    const kind =
      typeof approvalPayload.type === "string"
        ? approvalPayload.type
        : typeof payload.type === "string"
          ? payload.type
          : typeof payload.tool === "string"
            ? payload.tool
            : "Approval required";
    return { state: "approval", label: humanizeIdentifier(kind), eventId: approval.id };
  }
  if (input) {
    const payload = asObject(input.payload);
    const request = asObject(payload.request);
    const question =
      typeof request.question === "string"
        ? request.question
        : typeof payload.question === "string"
          ? payload.question
          : "Your response is required";
    return {
      state: "input",
      label: formatTimelineActivityLabel(question, 64) || "Your response is required",
      eventId: input.id,
    };
  }
  return null;
}

function stripState(task: Task | null | undefined): TaskStatusStripState {
  if (!task) return "idle";
  if (task.status === "completed") return "completed";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "paused" || task.status === "interrupted") return "paused";
  if (task.status === "blocked") return "blocked";
  if (task.status === "planning" || task.status === "executing") return "working";
  return "idle";
}

function toneForState(state: TaskStatusStripState): TaskStatusStripViewModel["tone"] {
  if (state === "completed") return "success";
  if (state === "failed" || state === "cancelled") return "danger";
  if (state === "blocked" || state === "waiting_for_approval" || state === "waiting_for_input") {
    return "warning";
  }
  if (state === "working") return "active";
  return "neutral";
}

function verificationLabel(events: TaskEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = getEffectiveTaskEventType(events[index]);
    if (type === "verification_passed") return "Verification passed";
    if (type === "verification_failed") return "Verification failed";
    if (type === "verification_started") return "Verification in progress";
    if (type === "verification_pending_user_action") return "Verification needs input";
  }
  return undefined;
}

export function deriveTaskStatusStrip(args: {
  task?: Task | null;
  events: TaskEvent[];
  planSteps: PlanStep[];
  activityGroups: ActivityGroupViewModel[];
  outcomeMetrics: TaskImpactMetric[];
  outputSummary: TaskOutputSummary | null;
}): TaskStatusStripViewModel {
  const blocking = deriveBlockingState(args.events);
  let state = stripState(args.task);
  if (blocking?.state === "approval") state = "waiting_for_approval";
  if (blocking?.state === "input") state = "waiting_for_input";
  const activeIndex = args.planSteps.findIndex((step) => step.status === "in_progress");
  const failedIndex = args.planSteps.findIndex((step) => step.status === "failed");
  const pendingIndex = args.planSteps.findIndex((step) => step.status === "pending");
  const ordinalIndex =
    activeIndex >= 0 ? activeIndex : failedIndex >= 0 ? failedIndex : pendingIndex;
  const activeStep = ordinalIndex >= 0 ? args.planSteps[ordinalIndex] : undefined;
  const totalPlanSteps = args.planSteps.length;
  const currentGroup = args.activityGroups[args.activityGroups.length - 1];
  const lastUserAt = args.events.reduce(
    (latest, event) =>
      getEffectiveTaskEventType(event) === "user_message"
        ? Math.max(latest, event.timestamp)
        : latest,
    0,
  );
  const lastTerminalAt = args.events.reduce((latest, event) => {
    const type = getEffectiveTaskEventType(event);
    return type === "task_completed" || type === "task_cancelled" || type === "error"
      ? Math.max(latest, event.timestamp)
      : latest;
  }, 0);
  const recentlyCompleted = state !== "completed" || lastTerminalAt >= lastUserAt;
  const visible =
    state === "working" ||
    state === "paused" ||
    state === "blocked" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "waiting_for_approval" ||
    state === "waiting_for_input" ||
    (state === "completed" && recentlyCompleted);

  let primaryLabel = "Working";
  if (state === "waiting_for_approval") primaryLabel = "Needs approval";
  else if (state === "waiting_for_input") primaryLabel = "Waiting for input";
  else if (state === "failed") primaryLabel = "Failed";
  else if (state === "cancelled") primaryLabel = "Cancelled";
  else if (state === "paused") primaryLabel = "Paused";
  else if (state === "blocked") primaryLabel = "Blocked";
  else if (state === "completed") primaryLabel = "Completed";
  else if (totalPlanSteps > 0 && ordinalIndex >= 0) {
    primaryLabel = `Step ${ordinalIndex + 1} / ${totalPlanSteps}`;
  }

  const updatedAt = Math.max(
    args.task?.updatedAt ?? 0,
    ...args.events.map((event) => event.timestamp || 0),
  );
  return {
    visible,
    state,
    tone: toneForState(state),
    primaryLabel,
    ...(currentGroup?.latestActivityLabel
      ? { phaseLabel: currentGroup.latestActivityLabel }
      : activeStep?.description
        ? { phaseLabel: activeStep.description }
        : {}),
    compactMetricSlots: selectTaskStatusMetricSlots(args.outcomeMetrics, 2),
    planSteps: args.planSteps,
    ...(activeStep ? { activeStepId: activeStep.id } : {}),
    ...(ordinalIndex >= 0 ? { activeStepOrdinal: ordinalIndex + 1 } : {}),
    totalPlanSteps,
    ...(currentGroup ? { currentActivityGroupId: currentGroup.id } : {}),
    outputs: args.outputSummary,
    ...(verificationLabel(args.events)
      ? { verificationLabel: verificationLabel(args.events) }
      : {}),
    ...(blocking ? { blockingLabel: blocking.label, blockingEventId: blocking.eventId } : {}),
    updatedAt,
  };
}
