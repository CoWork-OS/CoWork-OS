import type { RefObject, MutableRefObject } from "react";
import type { TaskEvent, Task, CustomSkill } from "../../../shared/types";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import { getCompletionSummaryText, humanizeTimelineMessage } from "./task-event-presentation";
import { sanitizeToolCallTextFromAssistant } from "../../../shared/tool-call-text-sanitizer";
import {
  resolveTaskOutputSummaryFromCompletionEvent,
  hasTaskOutputs,
} from "../../utils/task-outputs";
import type { EndOfTaskArtifactCard } from "./artifact-logic";
import type { CommandOutputSession } from "../../utils/task-event-derived";

export const VIRTUALIZED_FEED_ROW_THRESHOLD = 18;

export type TaskFeedRow =
  | {
      kind: "history-control";
      key: string;
      estimatedHeight: number;
      hasMoreHistory: boolean;
      isLoading: boolean;
      error: string | null;
      revision: string;
      visiblePerfEventId: null;
    }
  | {
      kind: "leading-command-outputs";
      key: string;
      estimatedHeight: number;
      sessions: CommandOutputSession[];
      revision: string;
      visiblePerfEventId: null;
    }
  | {
      kind: "artifact-stack";
      key: string;
      estimatedHeight: number;
      artifacts: EndOfTaskArtifactCard[];
      revision: string;
      visiblePerfEventId: null;
    }
  | {
      kind: "timeline";
      key: string;
      estimatedHeight: number;
      timelineIndex: number;
      item: any;
      revision: string;
      visiblePerfEventId: string | null;
    };

export type SkillModalLaunchMode = "skill_menu" | "slash";

export type SelectedSkillModalState = {
  skill: CustomSkill;
  launchMode: SkillModalLaunchMode;
  commandName?: string;
};

export type TranscriptMode = "live" | "inspect" | "delivery";

export function getTaskFeedRowEventType(row: TaskFeedRow): string | null {
  if (row.kind === "artifact-stack" || row.kind === "history-control") return null;
  if (row.kind !== "timeline" || row.item.kind !== "event") return null;
  return getEffectiveTaskEventType(row.item.event as TaskEvent);
}

export function getTaskFeedRowEvent(row: TaskFeedRow): TaskEvent | null {
  if (row.kind === "artifact-stack" || row.kind === "history-control") return null;
  if (row.kind !== "timeline" || row.item.kind !== "event") return null;
  return row.item.event as TaskEvent;
}

export function getTaskFeedRowVisiblePerfEventId(row: TaskFeedRow): string | null {
  return row.visiblePerfEventId ?? null;
}

export const LIVE_TRANSCRIPT_TRANSIENT_RAW_EVENT_TYPES = new Set([
  "llm_output_budget",
  "llm_output_budget_escalation",
  "llm_streaming",
]);
export const MAX_AGENT_REASONING_UPDATE_COUNT = 6;

export const LIVE_TRANSCRIPT_URGENT_EFFECTIVE_EVENT_TYPES = new Set([
  "approval_requested",
  "error",
  "input_request_created",
  "step_failed",
  "task_cancelled",
  "task_completed",
  "verification_failed",
  "verification_pending_user_action",
]);
export const LIVE_TRANSCRIPT_MAX_VISIBLE_ROWS = 12;

export function getDefaultTranscriptMode(args: {
  isTaskWorking: boolean;
  isReplayMode: boolean;
  verboseSteps: boolean;
  isChatTask: boolean;
  taskStatus?: Task["status"] | null;
}): TranscriptMode {
  if (args.isReplayMode || args.verboseSteps || args.isChatTask) {
    return "inspect";
  }
  if (args.isTaskWorking) {
    return "live";
  }
  if (args.taskStatus === "completed") {
    return "delivery";
  }
  return "inspect";
}

export function shouldShowBootstrapProgressRow(args: {
  isTaskWorking: boolean;
  visibleRenderableFeedRowsLength: number;
  isChatTask: boolean;
}): boolean {
  return args.isTaskWorking && args.visibleRenderableFeedRowsLength === 0 && !args.isChatTask;
}

export function getBootstrapProgressTitle(task: Task | null | undefined): string {
  switch (task?.status) {
    case "planning":
      return "Planning the approach";
    case "executing":
      return "Thinking";
    case "interrupted":
      return "Resuming work";
    default:
      return "Thinking";
  }
}

export function isUserFacingProgressMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (/^thinking(?:\.\.\.)?$/i.test(trimmed)) return false;
  if (/^executing$/i.test(trimmed)) return false;
  if (/^progress_update$/i.test(trimmed)) return false;
  return true;
}

export interface AgentReasoningPanelState {
  activeStreamText: string;
  isStreaming: boolean;
  recentUpdates: string[];
}

export function cleanAgentReasoningText(text: string): string {
  const sanitized = sanitizeToolCallTextFromAssistant(
    String(text || "")
      .replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, "$1")
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, ""),
  ).text;
  return sanitized.replace(/\n{3,}/g, "\n\n").trim();
}

export function isAgentReasoningStreamingEvent(event: TaskEvent): boolean {
  if (event.type === "llm_streaming") return true;
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
  return event.type === "timeline_step_updated" && payload?.legacyType === "llm_streaming";
}

export function deriveAgentReasoningPanelState(args: {
  events: TaskEvent[];
  taskId?: string | null;
  isTaskWorking: boolean;
}): AgentReasoningPanelState {
  if (!args.taskId || !args.isTaskWorking) {
    return { activeStreamText: "", isStreaming: false, recentUpdates: [] };
  }

  const recentUpdates: string[] = [];
  let lastVisibleUpdate = "";

  for (const event of args.events) {
    if (event.taskId !== args.taskId || isAgentReasoningStreamingEvent(event)) continue;
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType !== "progress_update" && effectiveType !== "assistant_message") continue;
    if (effectiveType === "assistant_message" && event.payload?.internal === true) continue;
    const rawMessage = typeof event.payload?.message === "string" ? event.payload.message : "";
    if (!isUserFacingProgressMessage(rawMessage)) continue;
    const message = cleanAgentReasoningText(
      effectiveType === "progress_update" ? humanizeTimelineMessage(rawMessage) : rawMessage,
    );
    if (!message || message === lastVisibleUpdate) continue;
    lastVisibleUpdate = message;
    recentUpdates.push(message);
    if (recentUpdates.length > MAX_AGENT_REASONING_UPDATE_COUNT) {
      recentUpdates.shift();
    }
  }

  let activeStreamText = "";
  let isStreaming = false;
  for (let index = args.events.length - 1; index >= 0; index -= 1) {
    const event = args.events[index];
    if (event.taskId !== args.taskId) continue;
    const effectiveType = getEffectiveTaskEventType(event);
    if (
      effectiveType === "log" ||
      effectiveType === "llm_usage" ||
      effectiveType === "command_output"
    ) {
      continue;
    }
    if (isAgentReasoningStreamingEvent(event)) {
      const rawText =
        typeof event.payload?.text === "string"
          ? event.payload.text
          : typeof event.payload?.message === "string"
            ? event.payload.message
            : "";
      const cleaned = cleanAgentReasoningText(rawText);
      if (cleaned && !/^thinking(?:\.\.\.)?$/i.test(cleaned)) {
        activeStreamText = cleaned;
        isStreaming = event.payload?.streaming === true;
      }
    }
    break;
  }

  return { activeStreamText, isStreaming, recentUpdates };
}

export function hasAgentReasoningPanelContent(state: AgentReasoningPanelState): boolean {
  return state.activeStreamText.trim().length > 0 || state.recentUpdates.length > 0;
}

export function isTransientLiveTranscriptRow(row: TaskFeedRow): boolean {
  const event = getTaskFeedRowEvent(row);
  if (!event) return false;
  if (LIVE_TRANSCRIPT_TRANSIENT_RAW_EVENT_TYPES.has(event.type)) return true;

  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "executing" || effectiveType === "llm_streaming") {
    return true;
  }
  if (effectiveType !== "progress_update") return false;

  const payloadMessage = typeof event.payload?.message === "string" ? event.payload.message : "";
  return !isUserFacingProgressMessage(payloadMessage);
}

export function isUrgentLiveTranscriptRow(row: TaskFeedRow): boolean {
  const effectiveType = getTaskFeedRowEventType(row);
  return effectiveType ? LIVE_TRANSCRIPT_URGENT_EFFECTIVE_EVENT_TYPES.has(effectiveType) : false;
}

export function getTaskFeedRowEvents(row: TaskFeedRow): Array<{
  event: TaskEvent;
  eventIndex?: number;
  eventOrder: number;
}> {
  if (row.kind === "artifact-stack" || row.kind === "history-control") return [];
  if (row.kind !== "timeline") return [];
  if (row.item.kind === "event") {
    return [{ event: row.item.event as TaskEvent, eventIndex: row.item.eventIndex, eventOrder: 0 }];
  }
  if (row.item.kind !== "action_block" || !Array.isArray(row.item.events)) return [];
  return row.item.events.map((event: TaskEvent, eventOrder: number) => ({
    event,
    eventIndex: Array.isArray(row.item.eventIndices)
      ? row.item.eventIndices[eventOrder]
      : undefined,
    eventOrder,
  }));
}

export function collectTaskFeedRowEventStream(feedRows: TaskFeedRow[]): TaskEvent[] {
  return feedRows.flatMap((row) => getTaskFeedRowEvents(row).map((entry) => entry.event));
}

export function isDeliveryCompletionEvent(event: TaskEvent, eventStream: TaskEvent[]): boolean {
  if (getEffectiveTaskEventType(event) !== "task_completed") return false;
  const outputSummary = resolveTaskOutputSummaryFromCompletionEvent(event, eventStream);
  if (hasTaskOutputs(outputSummary)) return true;
  if (getCompletionSummaryText(event).length > 0) return true;
  return (
    event.payload?.terminalStatus === "needs_user_action" ||
    event.payload?.terminalStatus === "partial_success"
  );
}

export function isDeliveryCriticalEvent(event: TaskEvent): boolean {
  const effectiveType = getEffectiveTaskEventType(event);
  return (
    effectiveType === "error" ||
    effectiveType === "step_failed" ||
    effectiveType === "verification_failed" ||
    effectiveType === "verification_pending_user_action" ||
    event.type === "timeline_error"
  );
}

export function isDeliveryEvent(event: TaskEvent, eventStream: TaskEvent[]): boolean {
  return isDeliveryCompletionEvent(event, eventStream) || isDeliveryCriticalEvent(event);
}

function normalizeDeliveryMessageText(value: string): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detects a completion summary that is only a clipped prefix of the final
 * assistant message. Older executors persisted a 4,000-character summary even
 * though the full assistant event was already stored, so delivery mode must
 * prefer that complete event when rendering historical tasks.
 */
export function isCompletionSummaryCoveredByAssistantEvent(
  completionEvent: TaskEvent,
  assistantEvent: TaskEvent,
): boolean {
  if (getEffectiveTaskEventType(completionEvent) !== "task_completed") return false;
  if (getEffectiveTaskEventType(assistantEvent) !== "assistant_message") return false;
  if (assistantEvent.payload?.internal === true) return false;
  if (
    completionEvent.taskId &&
    assistantEvent.taskId &&
    completionEvent.taskId !== assistantEvent.taskId
  ) {
    return false;
  }
  if (
    Number.isFinite(completionEvent.timestamp) &&
    Number.isFinite(assistantEvent.timestamp) &&
    assistantEvent.timestamp > completionEvent.timestamp
  ) {
    return false;
  }
  if (
    (typeof completionEvent.payload?.terminalStatus === "string" &&
      completionEvent.payload.terminalStatus !== "ok") ||
    (Array.isArray(completionEvent.payload?.pendingChecklist) &&
      completionEvent.payload.pendingChecklist.length > 0)
  ) {
    return false;
  }

  const rawSummary =
    typeof completionEvent.payload?.resultSummary === "string"
      ? completionEvent.payload.resultSummary.trim()
      : "";
  const formattedSummary = getCompletionSummaryText(completionEvent);
  const normalizedSummary = normalizeDeliveryMessageText(rawSummary);
  const normalizedFormattedSummary = normalizeDeliveryMessageText(formattedSummary);
  const assistantText =
    typeof assistantEvent.payload?.message === "string" ? assistantEvent.payload.message : "";
  const normalizedAssistant = normalizeDeliveryMessageText(assistantText);
  if (
    !normalizedSummary ||
    !normalizedAssistant ||
    normalizedFormattedSummary !== normalizedSummary
  ) {
    return false;
  }

  const clippedPrefix = normalizedSummary.replace(/(?:\.{3}|…)$/, "");
  const normalizedPrefix = clippedPrefix.trim();
  if (!normalizedPrefix || normalizedPrefix === normalizedSummary) return false;

  // Require a meaningful prefix and a clear continuation. This avoids treating
  // a short, intentionally worded ellipsis as a clipped persisted result.
  return (
    normalizedPrefix.length >= 256 &&
    normalizedAssistant.length > normalizedPrefix.length + 16 &&
    normalizedAssistant.startsWith(normalizedPrefix)
  );
}

export function createDeliveryEventRow(
  row: TaskFeedRow,
  event: TaskEvent,
  eventIndex: number | undefined,
  eventOrder: number,
): TaskFeedRow {
  if (row.kind === "timeline" && row.item.kind === "event") return row;
  return {
    kind: "timeline",
    key: `delivery-event:${event.id || row.key}:${eventIndex ?? eventOrder}`,
    estimatedHeight: estimateTaskFeedRowHeight({ kind: "event", event }),
    timelineIndex: row.kind === "timeline" ? row.timelineIndex : eventOrder,
    item: {
      kind: "event",
      event,
      eventIndex,
    },
    revision: `${row.revision}:${event.id}:${eventIndex ?? eventOrder}`,
    visiblePerfEventId: event.id ?? row.visiblePerfEventId,
  };
}

export function isMeaningfulLiveTranscriptRow(row: TaskFeedRow): boolean {
  if (row.kind === "history-control") return false;
  if (row.kind === "leading-command-outputs") return false;
  if (row.kind !== "timeline") return true;
  if (row.item.kind !== "event") return true;
  return !isTransientLiveTranscriptRow(row);
}

export function isUserFacingLiveStatusRow(row: TaskFeedRow): boolean {
  const event = getTaskFeedRowEvent(row);
  if (!event || isTransientLiveTranscriptRow(row)) return false;

  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "step_started") return true;
  if (effectiveType !== "progress_update") return false;

  const payloadMessage = typeof event.payload?.message === "string" ? event.payload.message : "";
  return isUserFacingProgressMessage(payloadMessage);
}

export function selectVisibleTaskFeedRows(
  feedRows: TaskFeedRow[],
  transcriptMode: TranscriptMode,
): { visibleFeedRows: TaskFeedRow[]; hiddenLiveFeedRowCount: number } {
  const getHiddenContentRowCount = (visibleRows: TaskFeedRow[]) => {
    const totalContentRows = feedRows.filter((row) => row.kind !== "history-control").length;
    const visibleContentRows = visibleRows.filter((row) => row.kind !== "history-control").length;
    return Math.max(0, totalContentRows - visibleContentRows);
  };

  if (transcriptMode === "delivery") {
    const eventStream = collectTaskFeedRowEventStream(feedRows);
    const candidates: Array<{ order: number; row: TaskFeedRow }> = [];
    let finalAssistant: { order: number; row: TaskFeedRow } | null = null;
    const pushCandidate = (order: number, row: TaskFeedRow) => {
      candidates.push({ order, row });
    };

    for (const [rowIndex, row] of feedRows.entries()) {
      if (row.kind === "artifact-stack") {
        pushCandidate(rowIndex, row);
        continue;
      }
      const rowEvents = getTaskFeedRowEvents(row);
      for (const { event, eventIndex, eventOrder } of rowEvents) {
        const order = rowIndex + eventOrder / 1000;
        if (
          getEffectiveTaskEventType(event) === "assistant_message" &&
          event.payload?.internal !== true
        ) {
          finalAssistant = {
            order,
            row: createDeliveryEventRow(row, event, eventIndex, eventOrder),
          };
          continue;
        }
        if (isDeliveryEvent(event, eventStream)) {
          pushCandidate(order, createDeliveryEventRow(row, event, eventIndex, eventOrder));
        }
      }
    }

    if (finalAssistant) {
      pushCandidate(finalAssistant.order, finalAssistant.row);
    }

    const finalAssistantEvent = finalAssistant ? getTaskFeedRowEvent(finalAssistant.row) : null;
    const seenKeys = new Set<string>();
    const visibleFeedRows = candidates
      .sort((a, b) => a.order - b.order)
      .map((candidate) => candidate.row)
      .filter((row) => {
        const event = getTaskFeedRowEvent(row);
        if (
          event &&
          finalAssistantEvent &&
          isCompletionSummaryCoveredByAssistantEvent(event, finalAssistantEvent)
        ) {
          return false;
        }
        if (seenKeys.has(row.key)) return false;
        seenKeys.add(row.key);
        return true;
      });

    return {
      visibleFeedRows,
      hiddenLiveFeedRowCount: getHiddenContentRowCount(visibleFeedRows),
    };
  }

  if (transcriptMode !== "live") {
    return { visibleFeedRows: feedRows, hiddenLiveFeedRowCount: 0 };
  }
  if (feedRows.length <= 8) {
    const visibleFeedRows = feedRows.filter((row) => row.kind !== "history-control");
    return {
      visibleFeedRows,
      hiddenLiveFeedRowCount: getHiddenContentRowCount(visibleFeedRows),
    };
  }

  const keepIndexes = new Set<number>();
  const keepLastMatch = (predicate: (row: TaskFeedRow) => boolean) => {
    for (let index = feedRows.length - 1; index >= 0; index -= 1) {
      if (predicate(feedRows[index])) {
        keepIndexes.add(index);
        return;
      }
    }
  };

  let meaningfulRowsKept = 0;
  for (let index = feedRows.length - 1; index >= 0 && meaningfulRowsKept < 4; index -= 1) {
    const row = feedRows[index];
    if (!isMeaningfulLiveTranscriptRow(row)) continue;
    keepIndexes.add(index);
    meaningfulRowsKept += 1;
  }

  keepLastMatch((row) => row.kind === "timeline" && row.item.kind === "action_block");
  keepLastMatch((row) => getTaskFeedRowEventType(row) === "assistant_message");
  keepLastMatch((row) => getTaskFeedRowEventType(row) === "user_message");
  keepLastMatch((row) => row.kind === "timeline" && row.item.kind === "dispatched-agents");
  keepLastMatch((row) => row.kind === "timeline" && row.item.kind === "cli-agent-frame");
  keepLastMatch((row) => row.kind === "timeline" && row.item.kind === "canvas");
  keepLastMatch((row) => isUserFacingLiveStatusRow(row));
  keepLastMatch((row) => isUrgentLiveTranscriptRow(row));

  const visibleIndexes = [...keepIndexes].sort((a, b) => a - b);
  const cappedIndexes =
    visibleIndexes.length > LIVE_TRANSCRIPT_MAX_VISIBLE_ROWS
      ? visibleIndexes.slice(-LIVE_TRANSCRIPT_MAX_VISIBLE_ROWS)
      : visibleIndexes;
  const cappedKeepIndexes = new Set(cappedIndexes);
  const visibleFeedRows = feedRows.filter((_, index) => cappedKeepIndexes.has(index));
  return {
    visibleFeedRows,
    hiddenLiveFeedRowCount: getHiddenContentRowCount(visibleFeedRows),
  };
}

export function hasInactiveStringSetEntries(
  selectedIds: ReadonlySet<string>,
  activeIds: ReadonlySet<string>,
): boolean {
  for (const id of selectedIds) {
    if (!activeIds.has(id)) return true;
  }
  return false;
}

export function pruneStringSetToActiveIds(
  selectedIds: ReadonlySet<string>,
  activeIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  for (const id of selectedIds) {
    if (activeIds.has(id)) next.add(id);
  }
  return next;
}

export function getCommandOutputSessionsRevision(
  sessions: CommandOutputSession[] | undefined,
): string {
  if (!sessions || sessions.length === 0) return "none";
  return sessions
    .map(
      (session) =>
        `${session.id}:${session.isRunning ? 1 : 0}:${session.exitCode ?? "null"}:${session.output.length}`,
    )
    .join("|");
}

export function collectInlineRunCommandSessionIds(args: {
  events: TaskEvent[];
  eventIndices: number[];
  commandOutputSessionsByInsertIndex: Map<number, CommandOutputSession[]>;
  isEventExpanded: (event: TaskEvent) => boolean;
}): Set<string> {
  const inlineRunCommandSessionIds = new Set<string>();
  for (let idx = 0; idx < args.events.length; idx++) {
    const event = args.events[idx];
    const eventIndex = args.eventIndices[idx];
    if (
      getEffectiveTaskEventType(event) === "tool_call" &&
      event.payload?.tool === "run_command" &&
      args.isEventExpanded(event)
    ) {
      for (const session of args.commandOutputSessionsByInsertIndex.get(eventIndex) ?? []) {
        inlineRunCommandSessionIds.add(session.id);
      }
    }
  }
  return inlineRunCommandSessionIds;
}

function getEvidenceSourceSet(event: TaskEvent): Set<string> {
  const refs = Array.isArray(event.payload?.evidenceRefs) ? event.payload.evidenceRefs : [];
  const sources = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    const source = (ref as { sourceUrlOrPath?: unknown }).sourceUrlOrPath;
    if (typeof source === "string" && source.trim().length > 0) {
      sources.add(source.trim());
    }
  }
  return sources;
}

export function isRedundantTimelineEvidenceEvent(event: TaskEvent, events: TaskEvent[]): boolean {
  if (event.type !== "timeline_evidence_attached") return false;
  const sources = getEvidenceSourceSet(event);
  if (sources.size === 0) return false;

  const eventIndex = events.findIndex(
    (candidate) => candidate === event || (event.id.trim().length > 0 && candidate.id === event.id),
  );
  const previousEvents = (eventIndex >= 0 ? events.slice(0, eventIndex) : events).filter(
    (candidate) => candidate.type === "timeline_evidence_attached",
  );

  for (const previousEvent of previousEvents) {
    const previousSources = getEvidenceSourceSet(previousEvent);
    if (previousSources.size < sources.size) continue;
    let covered = true;
    for (const source of sources) {
      if (!previousSources.has(source)) {
        covered = false;
        break;
      }
    }
    if (covered) return true;
  }

  return false;
}

export function estimateTaskFeedRowHeight(
  item: any,
  options?: {
    expanded?: boolean;
    visibleEventCount?: number;
    hasVisibilityToggle?: boolean;
  },
): number {
  if (item.kind === "canvas") return 320;
  if (item.kind === "cli-agent-frame") return 240;
  if (item.kind === "dispatched-agents") return 220;
  if (item.kind === "action_block") {
    const expanded = options?.expanded === true;
    const visibleEventCount = Math.max(0, options?.visibleEventCount ?? 0);
    const hasVisibilityToggle = options?.hasVisibilityToggle === true;

    // Virtualized history views should estimate against the collapsed/windowed
    // action block that is actually rendered, not the raw hidden event count.
    if (!expanded) return 34;

    const headerHeight = 30;
    const controlsHeight = hasVisibilityToggle ? 28 : 0;
    const eventsHeight = visibleEventCount * 42;
    const paddingHeight = visibleEventCount > 0 ? 10 : 4;
    return Math.min(520, headerHeight + controlsHeight + eventsHeight + paddingHeight);
  }

  const event = item.event as TaskEvent;
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "assistant_message" || effectiveType === "user_message") {
    const messageLength =
      typeof event.payload?.message === "string" ? event.payload.message.length : 0;
    return Math.min(420, 120 + Math.ceil(messageLength / 180) * 44);
  }

  if (effectiveType === "artifact_created" || event.type === "timeline_artifact_emitted") {
    return 42;
  }

  if (effectiveType === "file_modified") {
    return event.payload?.oldPreview || event.payload?.newPreview ? 58 : 42;
  }

  if (effectiveType === "file_created") {
    return event.payload?.contentPreview ? 64 : 42;
  }

  return 84;
}

export function assignTimelineRef(
  ref: RefObject<HTMLDivElement | null> | undefined,
  node: HTMLDivElement | null,
) {
  if (!ref) return;
  (ref as MutableRefObject<HTMLDivElement | null>).current = node;
}

export function getAutoScrollTargetTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

export function shouldScheduleAutoScrollWrite(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  lastTargetTop: number | null;
}): boolean {
  const targetTop = getAutoScrollTargetTop(args.scrollHeight, args.clientHeight);
  const alreadyAtTarget = Math.abs(args.scrollTop - targetTop) < 2;
  return !(
    alreadyAtTarget &&
    args.lastTargetTop !== null &&
    Math.abs(args.lastTargetTop - targetTop) < 2
  );
}
