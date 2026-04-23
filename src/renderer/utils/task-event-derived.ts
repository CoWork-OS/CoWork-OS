import type {
  PlanStep,
  SessionChecklistItem,
  SessionChecklistState,
  Task,
  TaskEvent,
  TaskOutputSummary,
  TaskStatus,
  Workspace,
} from "../../shared/types";
import { isVerificationStepDescription } from "../../shared/plan-utils";
import { buildParallelGroupProjection, type ParallelGroupProjectionResult } from "../components/timeline/parallel-group-projection";
import {
  deriveTaskOutputSummaryFromEvents,
  hasTaskOutputs,
  resolvePreferredTaskOutputSummary,
} from "./task-outputs";
import { hasAssistantMediaDirective } from "./assistant-media-directives";
import {
  filterVerboseTimelineNoise,
  shouldShowTaskEventInSummaryMode,
} from "./task-event-visibility";
import { getEffectiveTaskEventType } from "./task-event-compat";
import { normalizeEventsForTimelineUi } from "./timeline-projection";

export type RendererEventVisibility = "live" | "inspect-only" | "debug-only";

export interface CommandOutputSession {
  id: string;
  command: string;
  output: string;
  isRunning: boolean;
  exitCode: number | null;
  startTimestamp: number;
  cwd?: string;
}

export interface FileInfo {
  path: string;
  action: "created" | "modified" | "deleted";
  timestamp: number;
}

export interface ToolUsage {
  name: string;
  count: number;
  lastUsed: number;
}

export interface EventTimelineItem {
  kind: "event";
  event: TaskEvent;
  eventIndex: number;
  timestamp: number;
}

export interface ActionBlockTimelineItem {
  kind: "action_block";
  blockId: string;
  events: TaskEvent[];
  eventIndices: number[];
  timestamp: number;
}

export type BaseTimelineItem = EventTimelineItem | ActionBlockTimelineItem;

export interface ToolCallPairing {
  completions: Map<string, TaskEvent>;
  claimedResultIds: Set<string>;
}

export interface SharedTaskEventUiState {
  normalizedEvents: TaskEvent[];
  filteredEvents: TaskEvent[];
  liveEvents: TaskEvent[];
  inspectOnlyEvents: TaskEvent[];
  debugOnlyEvents: TaskEvent[];
  parallelGroupProjection: ParallelGroupProjectionResult;
  parallelGroupsByAnchorEventId: Map<string, ParallelGroupProjectionResult["groupsByAnchorEventId"] extends Map<string, infer T> ? T : never>;
  suppressedParallelEventIds: Set<string>;
  toolCallPairing: ToolCallPairing;
  baseTimelineItems: BaseTimelineItem[];
  commandOutputSessions: CommandOutputSession[];
  planSteps: PlanStep[];
  checklistState: SessionChecklistState | null;
  files: FileInfo[];
  outputSummary: TaskOutputSummary | null;
  toolUsage: ToolUsage[];
  referencedFiles: string[];
  usedToolNames: Set<string>;
  latestVisibleTaskEvent: TaskEvent | null;
}

export interface DeriveSharedTaskEventUiStateParams {
  rawEvents: TaskEvent[];
  task?: Task | null;
  workspace?: Workspace | null;
  verboseSteps?: boolean;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getAssistantStepDescription(event: TaskEvent): string {
  const payload = asObject(event.payload);
  if (typeof payload.stepDescription === "string") return payload.stepDescription;
  const step = asObject(payload.step);
  return typeof step.description === "string" ? step.description : "";
}

function shouldRevealInternalAssistantMessageInVerbose(event: TaskEvent): boolean {
  const payload = asObject(event.payload);
  if (getEffectiveTaskEventType(event) !== "assistant_message" || payload.internal !== true) {
    return false;
  }
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const stepDescription = getAssistantStepDescription(event);
  if (!message) return false;
  if (hasAssistantMediaDirective(message)) return true;
  if (isVerificationStepDescription(stepDescription)) return false;
  if (/^ok[\s.!?]*$/i.test(message) || message.length <= 12) return false;
  return true;
}

function isVerificationNoiseEvent(event: TaskEvent): boolean {
  const effectiveType = getEffectiveTaskEventType(event);
  const payload = asObject(event.payload);
  if (effectiveType === "assistant_message") {
    const message = typeof payload.message === "string" ? payload.message : "";
    return payload.internal === true && !hasAssistantMediaDirective(message);
  }

  if (
    event.type === "timeline_step_started" ||
    event.type === "timeline_step_finished" ||
    effectiveType === "step_started" ||
    effectiveType === "step_completed"
  ) {
    const step = asObject(payload.step);
    return isVerificationStepDescription(
      typeof step.description === "string" ? step.description : undefined,
    );
  }

  return effectiveType === "verification_started" || effectiveType === "verification_passed";
}

function classifyTaskEventForRenderer(
  event: TaskEvent,
  params: { taskStatus?: TaskStatus; verboseSteps?: boolean },
): RendererEventVisibility {
  if (event.type === "command_output" || event.type === "timeline_command_output") {
    return "inspect-only";
  }

  if (params.verboseSteps) {
    if (shouldRevealInternalAssistantMessageInVerbose(event)) return "live";
    if (isVerificationNoiseEvent(event)) return "debug-only";
    return "live";
  }

  if (shouldShowTaskEventInSummaryMode(event, params.taskStatus) && !isVerificationNoiseEvent(event)) {
    return "live";
  }

  return "debug-only";
}

function getCompletionSummaryText(event: TaskEvent): string {
  if (getEffectiveTaskEventType(event) !== "task_completed") return "";
  const payload = asObject(event.payload);
  const resultSummary =
    typeof payload.resultSummary === "string" ? payload.resultSummary.trim() : "";
  const semanticSummary =
    typeof payload.semanticSummary === "string" ? payload.semanticSummary.trim() : "";
  const verificationVerdict =
    typeof payload.verificationVerdict === "string" ? payload.verificationVerdict.trim() : "";
  const verificationReport =
    typeof payload.verificationReport === "string" ? payload.verificationReport.trim() : "";
  const summary = [resultSummary, semanticSummary]
    .filter((value) => value.length > 0)
    .join("\n\n");
  if (!verificationVerdict && !verificationReport) return summary;
  const verification = [
    verificationVerdict ? `Verification: ${verificationVerdict}` : "",
    verificationReport,
  ]
    .filter((value) => value.length > 0)
    .join("\n");
  return [summary, verification].filter((value) => value.length > 0).join("\n\n");
}

function derivePlanSteps(events: TaskEvent[]): PlanStep[] {
  const planEvent = events.find((event) => getEffectiveTaskEventType(event) === "plan_created");
  const planPayload = asObject(planEvent?.payload);
  const plan = asObject(planPayload.plan);
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
  const steps: PlanStep[] = rawSteps
    .filter((step): step is PlanStep => !!step && typeof step === "object")
    .map((step) => ({ ...(step as PlanStep) }));

  for (const event of events) {
    const effectiveType = getEffectiveTaskEventType(event);
    const payload = asObject(event.payload);
    const stepPayload = asObject(payload.step);
    const stepId = typeof stepPayload.id === "string" ? stepPayload.id : "";
    if (!stepId) continue;
    const step = steps.find((candidate) => candidate.id === stepId);
    if (!step) continue;

    if (effectiveType === "step_started") {
      step.status = "in_progress";
    } else if (effectiveType === "step_completed") {
      step.status = "completed";
    } else if (effectiveType === "step_failed") {
      step.status = "failed";
      if (payload.reason && !step.error) step.error = String(payload.reason);
    } else if (effectiveType === "step_skipped") {
      step.status = "skipped";
    }
  }

  return steps.filter(
    (step) => !isVerificationStepDescription(step.description) || step.status === "failed",
  );
}

function deriveChecklistState(events: TaskEvent[]): SessionChecklistState | null {
  const normalizeChecklistState = (payload: unknown): SessionChecklistState | null => {
    const payloadObject = asObject(payload);
    const checklist = asObject(payloadObject.checklist);
    const rawItems = Array.isArray(checklist.items) ? checklist.items : [];
    if (rawItems.length === 0) return null;

    const items: SessionChecklistItem[] = rawItems
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const itemObject = item as Record<string, unknown>;
        const kind: SessionChecklistItem["kind"] =
          itemObject.kind === "verification" || itemObject.kind === "other"
            ? itemObject.kind
            : "implementation";
        const status: SessionChecklistItem["status"] =
          itemObject.status === "in_progress" ||
          itemObject.status === "completed" ||
          itemObject.status === "blocked"
            ? itemObject.status
            : "pending";
        return {
          id: typeof itemObject.id === "string" ? itemObject.id : "",
          title: typeof itemObject.title === "string" ? itemObject.title : "",
          kind,
          status,
          createdAt: typeof itemObject.createdAt === "number" ? itemObject.createdAt : 0,
          updatedAt: typeof itemObject.updatedAt === "number" ? itemObject.updatedAt : 0,
        };
      })
      .filter((item) => Boolean(item.id && item.title));

    if (items.length === 0) return null;

    return {
      items,
      updatedAt: typeof checklist.updatedAt === "number" ? checklist.updatedAt : 0,
      verificationNudgeNeeded: checklist.verificationNudgeNeeded === true,
      nudgeReason:
        typeof checklist.nudgeReason === "string" && checklist.nudgeReason.trim().length > 0
          ? checklist.nudgeReason
          : null,
    };
  };

  for (const event of [...events].reverse()) {
    const effectiveType = getEffectiveTaskEventType(event);
    if (
      effectiveType === "task_list_created" ||
      effectiveType === "task_list_updated" ||
      effectiveType === "task_list_verification_nudged" ||
      event.type === "conversation_snapshot"
    ) {
      const state = normalizeChecklistState(event.payload);
      if (state) return state;
    }
  }

  return null;
}

function normalizeWorkspacePathKey(workspacePath: string | undefined, candidate: string): string {
  const normalized = candidate.replace(/\\/g, "/");
  if (!workspacePath) return normalized;
  const base = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.startsWith(`${base}/`)) {
    return normalized.slice(base.length + 1);
  }
  return normalized;
}

function deriveOutputSummary(task: Task | null | undefined, events: TaskEvent[]): TaskOutputSummary | null {
  const latestCompletionEvent = [...events]
    .reverse()
    .find((event) => getEffectiveTaskEventType(event) === "task_completed");

  return (
    resolvePreferredTaskOutputSummary({
      task,
      latestCompletionEvent,
      fallbackEvents: events,
    }) || deriveTaskOutputSummaryFromEvents(events)
  );
}

function deriveFiles(
  events: TaskEvent[],
  workspace: Workspace | null | undefined,
  outputSummary: TaskOutputSummary | null,
): FileInfo[] {
  const fileMap = new Map<string, FileInfo>();
  const directoryPaths = new Set<string>();

  for (const event of events) {
    const effectiveType = getEffectiveTaskEventType(event);
    const payload = asObject(event.payload);
    if (effectiveType === "file_created" && typeof payload.path === "string") {
      const key = normalizeWorkspacePathKey(workspace?.path, payload.path);
      if (payload.type === "directory") {
        directoryPaths.add(key);
        continue;
      }
      fileMap.set(key, { path: key, action: "created", timestamp: event.timestamp });
      continue;
    }

    if (effectiveType === "file_modified") {
      const rawPath =
        typeof payload.path === "string"
          ? payload.path
          : typeof payload.from === "string"
            ? payload.from
            : "";
      if (!rawPath) continue;
      const key = normalizeWorkspacePathKey(workspace?.path, rawPath);
      fileMap.set(key, { path: key, action: "modified", timestamp: event.timestamp });
      continue;
    }

    if ((effectiveType === "file_deleted" || effectiveType === "artifact_created") && typeof payload.path === "string") {
      const key = normalizeWorkspacePathKey(workspace?.path, payload.path);
      fileMap.set(key, {
        path: key,
        action: effectiveType === "file_deleted" ? "deleted" : "created",
        timestamp: event.timestamp,
      });
    }
  }

  if (hasTaskOutputs(outputSummary)) {
    const modifiedFallbackSet = new Set(outputSummary.modifiedFallback || []);
    const completionOutputPaths =
      outputSummary.created.length > 0
        ? outputSummary.created
        : outputSummary.modifiedFallback || [];
    completionOutputPaths.forEach((outputPath, index) => {
      const key = normalizeWorkspacePathKey(workspace?.path, outputPath);
      if (fileMap.has(key)) return;
      if (directoryPaths.has(key)) return;
      fileMap.set(key, {
        path: key,
        action: modifiedFallbackSet.has(outputPath) ? "modified" : "created",
        timestamp: Date.now() - index,
      });
    });
  }

  return [...fileMap.values()]
    .filter((file) => !file.path.endsWith("/") && !file.path.endsWith("\\"))
    .sort((a, b) => b.timestamp - a.timestamp);
}

function deriveToolUsage(events: TaskEvent[]): ToolUsage[] {
  const toolMap = new Map<string, ToolUsage>();

  for (const event of events) {
    const payload = asObject(event.payload);
    if (getEffectiveTaskEventType(event) !== "tool_call" || typeof payload.tool !== "string") {
      continue;
    }
    const existing = toolMap.get(payload.tool);
    if (existing) {
      existing.count += 1;
      existing.lastUsed = event.timestamp;
    } else {
      toolMap.set(payload.tool, {
        name: payload.tool,
        count: 1,
        lastUsed: event.timestamp,
      });
    }
  }

  return [...toolMap.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

function deriveReferencedFiles(events: TaskEvent[]): string[] {
  const files = new Set<string>();
  for (const event of events) {
    const payload = asObject(event.payload);
    const input = asObject(payload.input);
    if (getEffectiveTaskEventType(event) !== "tool_call") continue;
    if (payload.tool === "read_file" && typeof input.path === "string") {
      files.add(input.path);
    }
    if (payload.tool === "search_files" && typeof input.path === "string") {
      files.add(input.path);
    }
  }
  return [...files].slice(0, 10);
}

function deriveUsedToolNames(events: TaskEvent[]): Set<string> {
  const names = new Set<string>();
  for (const event of events) {
    const payload = asObject(event.payload);
    if (getEffectiveTaskEventType(event) === "tool_call" && typeof payload.tool === "string") {
      names.add(payload.tool);
    }
  }
  return names;
}

function deriveCommandOutputSessions(events: TaskEvent[]): CommandOutputSession[] {
  const commandOutputEvents = events.filter(
    (event) => getEffectiveTaskEventType(event) === "command_output",
  );
  if (commandOutputEvents.length === 0) return [];

  const sessions: CommandOutputSession[] = [];
  let currentSession: CommandOutputSession | null = null;
  let syntheticIdCounter = 0;

  const finalizeCurrentSession = () => {
    if (!currentSession) return;
    sessions.push(currentSession);
    currentSession = null;
  };

  for (const event of commandOutputEvents) {
    const payload = asObject(event.payload);
    const payloadType = typeof payload.type === "string" ? payload.type : "";
    const payloadCommand = typeof payload.command === "string" ? payload.command : "";
    const payloadOutput = typeof payload.output === "string" ? payload.output : "";
    const payloadCwd = typeof payload.cwd === "string" ? payload.cwd : undefined;

    if (payloadType === "start") {
      finalizeCurrentSession();
      currentSession = {
        id: event.id || `command-${event.timestamp}-${syntheticIdCounter++}`,
        command: payloadCommand,
        output: payloadOutput,
        isRunning: true,
        exitCode: null,
        startTimestamp: event.timestamp,
        cwd: payloadCwd,
      };
      continue;
    }

    if (!currentSession) {
      currentSession = {
        id: event.id || `command-${event.timestamp}-${syntheticIdCounter++}`,
        command: payloadCommand,
        output: "",
        isRunning: payloadType !== "end",
        exitCode: null,
        startTimestamp: event.timestamp,
        cwd: payloadCwd,
      };
    } else {
      if (payloadCommand) currentSession.command = payloadCommand;
      if (payloadCwd) currentSession.cwd = payloadCwd;
    }

    if (
      payloadType === "stdout" ||
      payloadType === "stderr" ||
      payloadType === "stdin" ||
      payloadType === "error"
    ) {
      currentSession.output += payloadOutput;
      continue;
    }

    if (payloadType === "end") {
      currentSession.isRunning = false;
      currentSession.exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
      finalizeCurrentSession();
    }
  }

  if (currentSession) sessions.push(currentSession);

  const maxUiOutputChars = 50 * 1024;
  return sessions.map((session) => {
    if (session.output.length <= maxUiOutputChars) return session;
    return {
      ...session,
      output: `[... earlier output truncated ...]\n\n${session.output.slice(-maxUiOutputChars)}`,
    };
  });
}

function deriveToolCallPairing(
  filteredEvents: TaskEvent[],
  suppressedParallelEventIds: Set<string>,
): ToolCallPairing {
  const callIdToEvent = new Map<string, TaskEvent>();
  const completions = new Map<string, TaskEvent>();
  const claimedResultIds = new Set<string>();

  for (const event of filteredEvents) {
    if (suppressedParallelEventIds.has(event.id)) continue;
    const effectiveType = getEffectiveTaskEventType(event);
    const payload = asObject(event.payload);
    if (effectiveType === "tool_call") {
      const ids = [
        typeof payload.id === "string" ? payload.id : "",
        typeof payload.callId === "string" ? payload.callId : "",
        typeof payload.toolUseId === "string" ? payload.toolUseId : "",
      ]
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      for (const id of ids) {
        callIdToEvent.set(id, event);
      }
      continue;
    }

    if (effectiveType !== "tool_result") continue;
    const ids = [
      typeof payload.callId === "string" ? payload.callId : "",
      typeof payload.toolUseId === "string" ? payload.toolUseId : "",
    ]
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    for (const id of ids) {
      const callEvent = callIdToEvent.get(id);
      if (!callEvent) continue;
      completions.set(callEvent.id, event);
      claimedResultIds.add(event.id);
      break;
    }
  }

  return { completions, claimedResultIds };
}

function deriveBaseTimelineItems(filteredEvents: TaskEvent[]): BaseTimelineItem[] {
  const eventItems: BaseTimelineItem[] = [];
  let currentBlock: TaskEvent[] = [];
  let currentBlockIndices: number[] = [];
  const lastCompletionSummaryByTask = new Map<string, { summary: string; timestamp: number }>();

  for (const event of filteredEvents) {
    const summary = getCompletionSummaryText(event);
    if (!summary) continue;
    lastCompletionSummaryByTask.set(event.taskId, {
      summary,
      timestamp: event.timestamp,
    });
  }

  const flushBlock = () => {
    if (currentBlock.length === 0) return;
    const firstBlockEvent = currentBlock[0];
    const firstBlockIndex = currentBlockIndices[0] ?? 0;
    const stableEventId =
      typeof firstBlockEvent?.id === "string" ? firstBlockEvent.id.trim() : "";
    const blockId =
      stableEventId.length > 0
        ? `action-block:${stableEventId}`
        : `action-block:${firstBlockEvent?.timestamp ?? 0}:${firstBlockIndex}`;
    eventItems.push({
      kind: "action_block",
      blockId,
      events: [...currentBlock],
      eventIndices: [...currentBlockIndices],
      timestamp: currentBlock[0].timestamp,
    });
    currentBlock = [];
    currentBlockIndices = [];
  };

  const isBoundaryEvent = (event: TaskEvent) => {
    const effectiveType = getEffectiveTaskEventType(event);
    return (
      effectiveType === "user_message" ||
      effectiveType === "assistant_message" ||
      effectiveType === "follow_up_completed" ||
      (effectiveType === "task_completed" && getCompletionSummaryText(event).length > 0) ||
      effectiveType === "artifact_created" ||
      effectiveType === "diagram_created" ||
      event.type === "timeline_artifact_emitted"
    );
  };

  for (let index = 0; index < filteredEvents.length; index += 1) {
    const event = filteredEvents[index];
    if (isBoundaryEvent(event)) {
      if (getEffectiveTaskEventType(event) === "assistant_message") {
        const payload = asObject(event.payload);
        const message = typeof payload.message === "string" ? payload.message.trim() : "";
        const completion = lastCompletionSummaryByTask.get(event.taskId);
        if (
          message &&
          completion &&
          completion.summary === message &&
          event.timestamp <= completion.timestamp
        ) {
          continue;
        }
      }
      flushBlock();
      eventItems.push({
        kind: "event",
        event,
        eventIndex: index,
        timestamp: event.timestamp,
      });
      continue;
    }

    currentBlock.push(event);
    currentBlockIndices.push(index);
  }

  flushBlock();
  return eventItems;
}

function getLatestVisibleTaskEvent(
  baseTimelineItems: BaseTimelineItem[],
  filteredEvents: TaskEvent[],
): TaskEvent | null {
  for (let index = baseTimelineItems.length - 1; index >= 0; index -= 1) {
    const item = baseTimelineItems[index];
    if (item.kind === "event") return item.event;
    if (item.events.length > 0) return item.events[item.events.length - 1];
  }
  return filteredEvents[filteredEvents.length - 1] ?? null;
}

export function deriveSharedTaskEventUiState(
  params: DeriveSharedTaskEventUiStateParams,
): SharedTaskEventUiState {
  const normalizedEvents = normalizeEventsForTimelineUi(params.rawEvents);
  const candidateEvents = params.verboseSteps
    ? filterVerboseTimelineNoise(normalizedEvents)
    : normalizedEvents;

  const liveEvents: TaskEvent[] = [];
  const inspectOnlyEvents: TaskEvent[] = [];
  const debugOnlyEvents: TaskEvent[] = [];

  for (const event of candidateEvents) {
    const visibility = classifyTaskEventForRenderer(event, {
      taskStatus: params.task?.status,
      verboseSteps: params.verboseSteps,
    });
    if (visibility === "live") {
      liveEvents.push(event);
    } else if (visibility === "inspect-only") {
      inspectOnlyEvents.push(event);
    } else {
      debugOnlyEvents.push(event);
    }
  }

  const parallelGroupProjection = buildParallelGroupProjection(normalizedEvents);
  const suppressedParallelEventIds = parallelGroupProjection.suppressedEventIds;
  const toolCallPairing = deriveToolCallPairing(liveEvents, suppressedParallelEventIds);
  const baseTimelineItems = deriveBaseTimelineItems(liveEvents);
  const commandOutputSessions = deriveCommandOutputSessions(normalizedEvents);
  const planSteps = derivePlanSteps(normalizedEvents);
  const checklistState = deriveChecklistState(normalizedEvents);
  const outputSummary = deriveOutputSummary(params.task, normalizedEvents);
  const files = deriveFiles(normalizedEvents, params.workspace, outputSummary);
  const toolUsage = deriveToolUsage(normalizedEvents);
  const referencedFiles = deriveReferencedFiles(normalizedEvents);
  const usedToolNames = deriveUsedToolNames(normalizedEvents);
  const latestVisibleTaskEvent = getLatestVisibleTaskEvent(baseTimelineItems, liveEvents);

  return {
    normalizedEvents,
    filteredEvents: liveEvents,
    liveEvents,
    inspectOnlyEvents,
    debugOnlyEvents,
    parallelGroupProjection,
    parallelGroupsByAnchorEventId: parallelGroupProjection.groupsByAnchorEventId,
    suppressedParallelEventIds,
    toolCallPairing,
    baseTimelineItems,
    commandOutputSessions,
    planSteps,
    checklistState,
    files,
    outputSummary,
    toolUsage,
    referencedFiles,
    usedToolNames,
    latestVisibleTaskEvent,
  };
}
