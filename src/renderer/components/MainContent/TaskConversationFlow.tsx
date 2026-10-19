import { supersededAnswerSurfaceEvents } from "../../utils/superseded-answer-surfaces";
import { resolveBotMascot } from "../../../shared/bot-mascots";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Components } from "react-markdown";
import {
  AgentTeamRun,
  IntegrationMentionSelection,
  QuotedAssistantMessage,
  StepFeedbackAction,
  Task,
  TaskEvent,
  Workspace,
} from "../../../shared/types";
import { parseCodeBlockRunMessage } from "../../../shared/terminal-output-text";
import { type CodeBlockRunTarget } from "../../utils/code-block-runs";
import type { ChatInlineFrame } from "../../../shared/mailbox";
import { parseUserMessageAttachmentMetadata } from "../../../shared/user-message-attachments";
import { CollaborativeSummaryPanel } from "../CollaborativeSummaryPanel";
import { AgentLifecycleRow } from "../timeline/AgentLifecycleRow";
import { assignAgentGlyphs } from "../../utils/agent-glyphs";
import { type AgentLifecycleRow as AgentLifecycleRowModel } from "../../utils/agent-lifecycle-rows";
import { CliAgentFrame } from "../CliAgentFrame";
import { resolveCliAgentType } from "../../../shared/cli-agent-detection";
import { AssistantMessageContent } from "../AssistantMessageContent";
import { AutoMailComposeFrame, MailComposeFrame } from "../MailComposeFrame";
import { MemoryUsedAffordance } from "../memory/MemoryUsedAffordance";
import { type AgentContext } from "../../hooks/useAgentContext";
import {
  hasTaskOutputs,
  resolveTaskOutputSummaryFromCompletionEvent,
} from "../../utils/task-outputs";
import {
  getAgentMessageReceipt,
  parseAgentMessageProtocolResult,
} from "../../utils/agent-message-receipt";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import {
  markRendererPerfEvent,
  markRendererStartup,
  markTaskEventRenderable,
  markTaskEventVisible,
  recordRendererRender,
} from "../../utils/renderer-perf";
import { extractAttachmentNames } from "../utils/attachment-content";
import {
  type CommandOutputSession,
  type SharedTaskEventUiState,
} from "../../utils/task-event-derived";
import {
  Check as CheckIcon,
  ChevronDown,
  Ellipsis,
  Loader2,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { InlineImagePreview } from "../InlineImagePreview";
import { useVirtualList } from "../../hooks/useVirtualList";
import { isActivityBlockInLatestTurn } from "../../utils/task-turn-timing";
import { TASK_FEED_MEASUREMENT_LAYOUT_VERSION } from "./main-content-constants";
import type { SettingsTab } from "./main-content-types";
import {
  collectGeneratedImageStacks,
  estimateGeneratedImageStackHeight,
  getVisibleGeneratedImageCards,
  type GeneratedImageStack,
} from "./artifact-logic";
import { collectTurnOutputSummaries } from "./turn-outputs";
import { TurnOutputsRow } from "./TurnOutputsRow";
import {
  getAssistantBubbleStatusLabel,
  isAssistantMessageInLatestTurn,
  getCompletionSummaryText,
  normalizeInitialPromptText,
  shouldSuppressInitialPromptUserEvent,
} from "./task-event-presentation";
import {
  cleanAssistantMessageForDisplay,
  normalizeTimelineTitleMarkdownForDisplay,
} from "./markdown-normalization";
import {
  CollapsibleUserBubble,
  DeferredMarkdown,
  MessageCopyButton,
  MessageForkButton,
  MessageSpeakButton,
  UserMessageImageGallery,
  UserMessageText,
  getIntegrationMentionsSignature,
  isLastAssistantMessageEvent,
  summarizeQuotedAssistantMessage,
} from "./message-ui";
import { BotMessageAvatar } from "./BotEarlierConversations";
import { type BotMascotLookup } from "./bot-earlier-conversations";
import {
  VIRTUALIZED_FEED_ROW_THRESHOLD,
  applyTurnDisclosures,
  assignTimelineRef,
  captureTaskFeedReadingAnchor,
  collectInlineRunCommandSessionIds,
  deriveAgentReasoningPanelState,
  estimateTaskFeedRowHeight,
  getAutoScrollTargetTop,
  getBootstrapProgressTitle,
  getCommandOutputSessionsRevision,
  getStepMessageEventIds,
  getTaskFeedReadingAnchorDrift,
  getTaskFeedRowVisiblePerfEventId,
  hasAgentReasoningPanelContent,
  isPlanStepLifecycleEvent,
  isQuietActivityBlock,
  mergeAdjacentActivityBlockRows,
  selectVisibleTaskFeedRows,
  shouldShowBootstrapProgressRow,
  shouldUseTurnDisclosures,
  type TaskFeedReadingAnchor,
  type TaskFeedRow,
  type TaskTimelineItem,
  type TranscriptMode,
} from "./task-feed-logic";
import {
  canStepEventOwnParallelChildren,
  getAgentLifecycleRecapLine,
  getParallelGroupOwnerStepId,
  getTimelineEventStepId,
  renderEventDetails,
  renderEventTitle,
} from "./timeline-event-rendering";
import { CanvasPreview } from "../CanvasPreview";
import { StepFeed } from "../timeline/StepFeed";
import { ParallelGroupFeed } from "../timeline/ParallelGroupFeed";
import { ActionBlock } from "../timeline/ActionBlock";
import { TurnHeader } from "../timeline/TurnHeader";
import { FileChangeTitle } from "../timeline/FileChangeTitle";
import { summarizeFileChange } from "../timeline/file-change-row";
import { buildActionBlockSummary } from "../timeline/ActionBlockSummary";
import { truncateLabel } from "../../utils/timeline-tool-labels";
import { type ParallelGroupProjection } from "../timeline/parallel-group-projection";
import {
  resolveTimelineIndicator,
  shouldShowTimelineBranchStub,
} from "../timeline/timeline-indicators";
import {
  getDisclosureIntent,
  resolveDisclosureExpanded,
  type DisclosureIntentState,
  type DisclosureScope,
} from "../../utils/disclosure-state";
import { AgentReasoningPanel } from "./AgentReasoningPanel";
import { getAgentLifecycleRowRevision } from "./agent-lifecycle-row-revision";
import {
  getAttachmentNamesWithoutImagePreviews,
  getTruncatedTaskEventDetailId,
} from "./task-event-render-detail";

function getTaskEventPayloadRenderSignature(event: TaskEvent): string {
  const detailId = getTruncatedTaskEventDetailId(event);
  return detailId ? `truncated:${detailId}` : "full";
}

function isChatInlineFrame(value: unknown): value is ChatInlineFrame {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "mail_compose" &&
    typeof (value as { draftId?: unknown }).draftId === "string"
  );
}

function getTaskEventInlineFrames(event: TaskEvent): ChatInlineFrame[] {
  const frames = (event.payload as { inlineFrames?: unknown } | undefined)?.inlineFrames;
  return Array.isArray(frames) ? frames.filter(isChatInlineFrame) : [];
}

function getPreviousUserMessageText(events: TaskEvent[], beforeIndex: number | undefined): string {
  if (beforeIndex === undefined) return "";
  for (let index = Math.min(beforeIndex - 1, events.length - 1); index >= 0; index -= 1) {
    const event = events[index];
    if (!event || getEffectiveTaskEventType(event) !== "user_message") continue;
    const message = event.payload?.message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

function VirtualizedTaskFeedRow({
  itemKey,
  offsetTop,
  estimatedHeight,
  onHeightChange,
  visiblePerfEventId,
  visibilityEnabled,
  children,
}: {
  itemKey: string;
  offsetTop: number;
  estimatedHeight: number;
  onHeightChange: (itemKey: string, height: number) => void;
  visiblePerfEventId: string | null;
  visibilityEnabled: boolean;
  children: React.ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const visibleNotifiedEventIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return;

    let frame = 0;
    const report = () => {
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      // A row that renders nothing is 0px tall and must report it, or it keeps its estimated
      // height as a blank gap. A row inside a hidden (display: none) view has no layout boxes
      // at all; skip it so a hidden feed does not collapse every row to 0.
      if (nextHeight === 0 && element.getClientRects().length === 0) return;
      onHeightChange(itemKey, nextHeight);
      if (
        nextHeight > 0 &&
        visibilityEnabled &&
        visiblePerfEventId &&
        visibleNotifiedEventIdRef.current !== visiblePerfEventId
      ) {
        visibleNotifiedEventIdRef.current = visiblePerfEventId;
        markTaskEventVisible({ id: visiblePerfEventId }, "measured-row", visibilityEnabled);
      }
    };
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(report);
    };

    // Measure a newly mounted row before it is painted. Rows scrolled into view from above
    // otherwise show at their estimated height for a few frames and then jump into place.
    report();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => measure());
      observer.observe(element);
      return () => {
        if (frame) cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
    // estimatedHeight is the height the list lays this row out with. When the list drops a
    // stale measurement (the row's content changed) it falls back to the estimate, and the DOM
    // may not resize, so ResizeObserver stays quiet; re-measuring on that change keeps the
    // layout from holding an estimate that leaves a gap or an overlap.
  }, [estimatedHeight, itemKey, onHeightChange, visibilityEnabled, visiblePerfEventId]);

  return (
    <div
      data-task-feed-virtual-row={itemKey}
      data-task-feed-row={itemKey}
      style={{
        position: "absolute",
        top: offsetTop,
        left: 0,
        right: 0,
        minHeight: estimatedHeight,
      }}
    >
      <div ref={rowRef}>{children}</div>
    </div>
  );
}

function MeasuredTaskFeedRow({
  itemKey,
  visiblePerfEventId,
  enabled,
  children,
}: {
  itemKey: string;
  visiblePerfEventId: string | null;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const visibleNotifiedEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;

    let frame = 0;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextHeight = Math.ceil(element.getBoundingClientRect().height);
        if (
          nextHeight > 0 &&
          enabled &&
          visiblePerfEventId &&
          visibleNotifiedEventIdRef.current !== visiblePerfEventId
        ) {
          visibleNotifiedEventIdRef.current = visiblePerfEventId;
          markTaskEventVisible({ id: visiblePerfEventId }, "measured-row", enabled);
        }
      });
    };

    measure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => measure());
      observer.observe(element);
      return () => {
        if (frame) cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, visiblePerfEventId]);

  return (
    <div ref={rowRef} data-task-feed-row={itemKey}>
      {children}
    </div>
  );
}

function getTaskFeedRowsSignature(rows: TaskFeedRow[]): string {
  return rows.map((row) => `${row.key}:${row.revision}`).join("|");
}

const TaskConversationRenderedRows = memo(
  function TaskConversationRenderedRows({
    taskId,
    taskSwitchId,
    hasMoreTimelineHistory,
    isLoadingTimelineHistory,
    timelineHistoryError,
    onLoadMoreTimelineHistory,
    rendererPerfLoggingEnabled,
    visibleFeedRows,
    isChatTask,
    isTaskWorking,
    task,
    formatTime,
    isReplayMode,
    transcriptMode,
    canReturnToLiveView,
    onBackToLiveView,
    reasoningPanel,
    reasoningPanelSignature,
    mainBodyRef,
    timelineRef,
    getRenderedFeedRow,
    newActivityCount = 0,
    onNewActivityCountChange,
  }: {
    taskId: string | undefined;
    taskSwitchId?: string | null;
    hasMoreTimelineHistory?: boolean;
    isLoadingTimelineHistory?: boolean;
    timelineHistoryError?: string | null;
    onLoadMoreTimelineHistory?: (options?: { loadAll?: boolean }) => void | Promise<void>;
    rendererPerfLoggingEnabled: boolean;
    visibleFeedRows: TaskFeedRow[];
    isChatTask: boolean;
    isTaskWorking: boolean;
    task: Task | null | undefined;
    formatTime: (timestamp: number) => string;
    isReplayMode: boolean;
    transcriptMode: TranscriptMode;
    canReturnToLiveView: boolean;
    onBackToLiveView: () => void;
    reasoningPanel?: React.ReactNode;
    reasoningPanelSignature: string;
    mainBodyRef: React.RefObject<HTMLDivElement | null>;
    timelineRef: React.RefObject<HTMLDivElement | null>;
    getRenderedFeedRow: (row: TaskFeedRow) => React.ReactNode;
    newActivityCount?: number;
    onNewActivityCountChange?: React.Dispatch<React.SetStateAction<number>>;
  }) {
    recordRendererRender(
      "MainContent.taskConversationFlow",
      taskId ? `task:${taskId}` : "task:none",
      rendererPerfLoggingEnabled,
    );
    void reasoningPanelSignature;

    const historyPrependAnchorRef = useRef<{
      taskId: string | undefined;
      scrollTop: number;
      scrollHeight: number;
      rowCount: number;
      observedLoading: boolean;
    } | null>(null);
    const [suppressVirtualAutoScroll, setSuppressVirtualAutoScroll] = useState(false);
    const previousFeedTaskIdRef = useRef(taskId);
    const previousFeedRowCountRef = useRef(visibleFeedRows.length);
    const previousFeedLastRowKeyRef = useRef<string | undefined>(
      visibleFeedRows[visibleFeedRows.length - 1]?.key,
    );

    const renderableFeedRows = useMemo(() => visibleFeedRows, [visibleFeedRows]);
    const handleLoadMoreTimelineHistory = useCallback(
      (options?: { loadAll?: boolean }) => {
        // Older pages are only fetched while the user is inspecting the transcript. The
        // live view keeps every conversation message and compact action row visible without
        // exposing a separate "load all history" control.
        const container = mainBodyRef.current;
        if (container) {
          historyPrependAnchorRef.current = {
            taskId,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            rowCount: renderableFeedRows.length,
            observedLoading: false,
          };
        }
        setSuppressVirtualAutoScroll(true);
        void onLoadMoreTimelineHistory?.(options);
      },
      [mainBodyRef, onLoadMoreTimelineHistory, renderableFeedRows.length, taskId],
    );
    const startupRowsMarkedRef = useRef(false);
    const timelineRowsMarkedTaskIdsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
      if (startupRowsMarkedRef.current || visibleFeedRows.length === 0) return;
      startupRowsMarkedRef.current = true;
      markRendererStartup("first_task_rows_ready", rendererPerfLoggingEnabled, {
        rows: visibleFeedRows.length,
        taskId: taskId ?? "none",
      });
    }, [rendererPerfLoggingEnabled, taskId, visibleFeedRows.length]);
    useEffect(() => {
      const markKey = `${taskId ?? "none"}:${taskSwitchId ?? "initial"}`;
      if (
        !taskId ||
        visibleFeedRows.length === 0 ||
        timelineRowsMarkedTaskIdsRef.current.has(markKey)
      ) {
        return;
      }
      timelineRowsMarkedTaskIdsRef.current.add(markKey);
      markRendererPerfEvent("timeline_first_rows_ready", rendererPerfLoggingEnabled, {
        rows: visibleFeedRows.length,
        taskId,
        switchId: taskSwitchId,
      });
    }, [rendererPerfLoggingEnabled, taskId, taskSwitchId, visibleFeedRows.length]);
    const useVirtualizedFeed =
      transcriptMode !== "delivery" &&
      renderableFeedRows.length >= VIRTUALIZED_FEED_ROW_THRESHOLD &&
      !isReplayMode;
    const [feedRowHeights, setFeedRowHeights] = useState<Map<string, number>>(() => new Map());
    const feedRowHeightsRef = useRef<Map<string, number>>(new Map());
    const feedRowHeightSignaturesRef = useRef<Map<string, string>>(new Map());
    const pendingFeedRowHeightsRef = useRef<Map<string, number>>(new Map());
    const feedRowHeightFlushFrameRef = useRef<number | null>(null);
    const [conversationFlowOffsetTop, setConversationFlowOffsetTop] = useState(0);
    const conversationFlowRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      feedRowHeightsRef.current = feedRowHeights;
    }, [feedRowHeights]);

    useEffect(() => {
      const activeSignatures = new Map(
        renderableFeedRows.map((row) => [
          row.key,
          `${TASK_FEED_MEASUREMENT_LAYOUT_VERSION}:${row.revision}:${row.estimatedHeight}`,
        ]),
      );
      const previousSignatures = feedRowHeightSignaturesRef.current;
      feedRowHeightSignaturesRef.current = activeSignatures;
      setFeedRowHeights((prev) => {
        let changed = false;
        const next = new Map<string, number>();
        for (const [key, value] of prev.entries()) {
          const activeSignature = activeSignatures.get(key);
          if (!activeSignature || previousSignatures.get(key) !== activeSignature) {
            changed = true;
            continue;
          }
          next.set(key, value);
        }
        if (changed) {
          feedRowHeightsRef.current = next;
        }
        return changed ? next : prev;
      });
    }, [renderableFeedRows]);

    useEffect(() => {
      if (!rendererPerfLoggingEnabled) return;
      for (const row of renderableFeedRows) {
        const visiblePerfEventId = getTaskFeedRowVisiblePerfEventId(row);
        if (!visiblePerfEventId) continue;
        markTaskEventRenderable({ id: visiblePerfEventId }, rendererPerfLoggingEnabled);
      }
    }, [renderableFeedRows, rendererPerfLoggingEnabled]);

    const flushFeedRowHeights = useCallback(() => {
      feedRowHeightFlushFrameRef.current = null;
      // Take the batch before calling setState: React may run an updater more than once
      // (StrictMode, or replaying an interrupted transition) and keeps only the last result.
      // Clearing the batch inside the updater made that last run see nothing and drop the
      // measurements, leaving rows at their estimated height.
      const measured = pendingFeedRowHeightsRef.current;
      if (measured.size === 0) return;
      pendingFeedRowHeightsRef.current = new Map();
      setFeedRowHeights((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [itemKey, nextHeight] of measured.entries()) {
          const currentHeight = next.get(itemKey);
          if (currentHeight !== undefined && Math.abs(currentHeight - nextHeight) < 2) {
            continue;
          }
          next.set(itemKey, nextHeight);
          changed = true;
        }
        if (changed) {
          feedRowHeightsRef.current = next;
        }
        return changed ? next : prev;
      });
    }, []);

    const handleFeedRowHeightChange = useCallback(
      (itemKey: string, height: number) => {
        const pendingHeight = pendingFeedRowHeightsRef.current.get(itemKey);
        const currentHeight = pendingHeight ?? feedRowHeightsRef.current.get(itemKey);
        if (currentHeight !== undefined && Math.abs(currentHeight - height) < 2) {
          return;
        }
        pendingFeedRowHeightsRef.current.set(itemKey, height);
        if (feedRowHeightFlushFrameRef.current !== null) return;
        feedRowHeightFlushFrameRef.current = window.requestAnimationFrame(flushFeedRowHeights);
      },
      [flushFeedRowHeights],
    );

    useEffect(
      () => () => {
        if (feedRowHeightFlushFrameRef.current !== null) {
          cancelAnimationFrame(feedRowHeightFlushFrameRef.current);
          feedRowHeightFlushFrameRef.current = null;
        }
      },
      [],
    );

    const setConversationFlowNode = useCallback(
      (node: HTMLDivElement | null) => {
        conversationFlowRef.current = node;
        assignTimelineRef(timelineRef, node);
      },
      [timelineRef],
    );

    useEffect(() => {
      if (!useVirtualizedFeed) {
        setConversationFlowOffsetTop(0);
        return;
      }

      const flow = conversationFlowRef.current;
      if (!flow) return;

      let frame = requestAnimationFrame(() => {
        const nextOffset = Math.max(0, flow.offsetTop);
        setConversationFlowOffsetTop((prev) =>
          Math.abs(prev - nextOffset) < 1 ? prev : nextOffset,
        );
      });

      return () => {
        cancelAnimationFrame(frame);
      };
    }, [useVirtualizedFeed, renderableFeedRows.length]);

    const {
      virtualItems: virtualFeedRows,
      totalHeight: virtualFeedTotalHeight,
      visibleStartIndex,
      isAtBottom,
      scrollToBottom,
      getItemOffset: getVirtualFeedRowOffset,
      syncScrollPosition: syncVirtualFeedScroll,
    } = useVirtualList({
      items: renderableFeedRows,
      containerRef: mainBodyRef as React.RefObject<HTMLElement | null>,
      getItemHeight: (row) => feedRowHeights.get(row.key) ?? row.estimatedHeight,
      estimatedItemHeight: 160,
      // Rows are measured as they mount; a wider overscan measures them before they scroll
      // into view, so scrolling up through rows the reader has not seen yet stays steady.
      overscan: 12,
      enabled: useVirtualizedFeed,
      scrollOffsetTop: conversationFlowOffsetTop,
      suppressAutoScrollOnItemsChange: suppressVirtualAutoScroll,
      scrollAnchorKey: taskId ?? "new",
    });
    useEffect(() => {
      if (previousFeedTaskIdRef.current !== taskId) {
        previousFeedTaskIdRef.current = taskId;
        previousFeedRowCountRef.current = renderableFeedRows.length;
        previousFeedLastRowKeyRef.current = renderableFeedRows[renderableFeedRows.length - 1]?.key;
        onNewActivityCountChange?.(0);
        return;
      }
      const added = Math.max(0, renderableFeedRows.length - previousFeedRowCountRef.current);
      previousFeedRowCountRef.current = renderableFeedRows.length;
      const lastRowKey = renderableFeedRows[renderableFeedRows.length - 1]?.key;
      const previousLastRowKey = previousFeedLastRowKeyRef.current;
      previousFeedLastRowKeyRef.current = lastRowKey;
      const loadingEarlierHistory = historyPrependAnchorRef.current?.observedLoading === true;
      if (loadingEarlierHistory) return;
      // Older history loads in above the reader; only rows after the latest one are new.
      if (added > 0 && lastRowKey === previousLastRowKey) return;
      if (!useVirtualizedFeed || added === 0) {
        if (isAtBottom) onNewActivityCountChange?.(0);
        return;
      }
      if (isAtBottom) {
        onNewActivityCountChange?.(0);
      } else {
        onNewActivityCountChange?.((count) => count + added);
      }
    }, [isAtBottom, onNewActivityCountChange, renderableFeedRows, taskId, useVirtualizedFeed]);
    // A short feed is not virtualized, so the virtual list cannot report reaching the top.
    // Track it from the scroll container instead; a feed that does not overflow shows its top.
    const [isNearFeedTop, setIsNearFeedTop] = useState(false);
    useEffect(() => {
      const container = mainBodyRef.current;
      if (useVirtualizedFeed || !container) return;
      const update = () => {
        const fitsWithoutScrolling = container.scrollHeight <= container.clientHeight + 1;
        setIsNearFeedTop(fitsWithoutScrolling || container.scrollTop < 120);
      };
      update();
      container.addEventListener("scroll", update, { passive: true });
      return () => container.removeEventListener("scroll", update);
    }, [mainBodyRef, renderableFeedRows.length, useVirtualizedFeed]);
    // Earlier pages load as the user reaches the top of the step feed in any mode that shows
    // steps; the summary-only delivery view has no older steps to show. A finished bot chat
    // is delivered as its full message thread, so its older messages still scroll in.
    useEffect(() => {
      if (
        (transcriptMode === "delivery" && task?.agentConfig?.botConversation !== true) ||
        !hasMoreTimelineHistory ||
        isLoadingTimelineHistory ||
        timelineHistoryError
      ) {
        return;
      }
      const reachedTop = useVirtualizedFeed ? !isAtBottom && visibleStartIndex <= 2 : isNearFeedTop;
      if (!reachedTop) return;
      handleLoadMoreTimelineHistory({ loadAll: false });
    }, [
      handleLoadMoreTimelineHistory,
      hasMoreTimelineHistory,
      task?.agentConfig?.botConversation,
      isAtBottom,
      isLoadingTimelineHistory,
      isNearFeedTop,
      timelineHistoryError,
      transcriptMode,
      useVirtualizedFeed,
      visibleStartIndex,
    ]);
    const renderedFeedRows = useMemo(
      () => (useVirtualizedFeed ? virtualFeedRows.map((row) => row.item) : renderableFeedRows),
      [useVirtualizedFeed, virtualFeedRows, renderableFeedRows],
    );
    const renderedFeedNodeByKey = useMemo(
      () =>
        new Map(
          renderedFeedRows.map((row) => {
            const node = row.kind === "history-control" ? null : getRenderedFeedRow(row);
            return [row.key, node] as const;
          }),
        ),
      [getRenderedFeedRow, handleLoadMoreTimelineHistory, renderedFeedRows],
    );
    useEffect(() => {
      if (isLoadingTimelineHistory && historyPrependAnchorRef.current) {
        historyPrependAnchorRef.current.observedLoading = true;
      }
    }, [isLoadingTimelineHistory]);
    useLayoutEffect(() => {
      if (isLoadingTimelineHistory) return;
      const anchor = historyPrependAnchorRef.current;
      const container = mainBodyRef.current;
      if (!anchor || !container) {
        if (suppressVirtualAutoScroll) setSuppressVirtualAutoScroll(false);
        return;
      }
      if (!anchor.observedLoading && renderableFeedRows.length === anchor.rowCount) {
        return;
      }
      historyPrependAnchorRef.current = null;
      if (anchor.taskId !== taskId) {
        if (suppressVirtualAutoScroll) setSuppressVirtualAutoScroll(false);
        return;
      }

      // The reading anchor below already kept the reader's row in place as the earlier rows
      // arrived; moving the scroll position again here would jump.
      if (suppressVirtualAutoScroll) setSuppressVirtualAutoScroll(false);
    }, [
      isLoadingTimelineHistory,
      mainBodyRef,
      renderableFeedRows.length,
      suppressVirtualAutoScroll,
      taskId,
      useVirtualizedFeed,
      virtualFeedTotalHeight,
    ]);
    // Keep the row the reader is looking at in place when rows above it change: earlier
    // history arriving at the top, the feed switching to its virtualized layout, or rows above
    // the viewport being measured. Runs after every commit, before paint, so the reader never
    // sees the content shift. A reader on the latest message is followed by the bottom pin
    // instead.
    const virtualFeedListRef = useRef<HTMLDivElement | null>(null);
    const readingAnchorRef = useRef<TaskFeedReadingAnchor | null>(null);
    const captureReadingAnchor = useCallback(() => {
      readingAnchorRef.current = captureTaskFeedReadingAnchor(mainBodyRef.current, taskId);
    }, [mainBodyRef, taskId]);
    useEffect(() => {
      const container = mainBodyRef.current;
      if (!container) return;
      container.addEventListener("scroll", captureReadingAnchor, { passive: true });
      return () => container.removeEventListener("scroll", captureReadingAnchor);
    }, [captureReadingAnchor, mainBodyRef]);
    useLayoutEffect(() => {
      const container = mainBodyRef.current;
      const anchor = readingAnchorRef.current;
      // A reader following the latest message stays on it through every commit, before paint;
      // rows still loading or being measured keep growing the feed under them.
      if (container?.dataset.followingLatest === "true") {
        readingAnchorRef.current = null;
        const target = getAutoScrollTargetTop(container.scrollHeight, container.clientHeight);
        if (Math.abs(container.scrollTop - target) >= 2) {
          container.scrollTop = target;
          if (useVirtualizedFeed) syncVirtualFeedScroll();
        }
        return;
      }
      if (container && anchor && anchor.taskId === taskId) {
        let drift = getTaskFeedReadingAnchorDrift(container, anchor);
        // The virtualized list may not render the anchored row in this commit: it windows by
        // the previous scroll position, and the row moved (earlier history arrived, or the feed
        // just switched to its virtualized layout). Place it from its laid-out offset instead,
        // then re-window at once so the reader never sees the rows from the old position.
        let rewindow = false;
        const virtualList = virtualFeedListRef.current;
        if (drift === null && useVirtualizedFeed && virtualList) {
          const offset = getVirtualFeedRowOffset(
            renderableFeedRows.findIndex((row) => row.key === anchor.key),
          );
          if (offset !== null) {
            const listTop =
              virtualList.getBoundingClientRect().top - container.getBoundingClientRect().top;
            drift = listTop + offset - anchor.top;
            rewindow = true;
          }
        }
        if (drift !== null && Math.abs(drift) >= 1) {
          container.scrollTop += drift;
          // This correction can land exactly on the bottom of a feed that just shrank; it
          // must not read as the reader choosing to follow the latest message.
          container.dataset.readingAnchorAdjusted = "true";
          if (rewindow) {
            // Keep the anchor: the re-windowed commit runs this effect again and checks it.
            syncVirtualFeedScroll();
            return;
          }
        }
      }
      captureReadingAnchor();
    });
    const showBootstrapProgress = shouldShowBootstrapProgressRow({
      isTaskWorking,
      visibleRenderableFeedRowsLength: renderableFeedRows.length,
      isChatTask,
    });
    const bootstrapProgressTitle = getBootstrapProgressTitle(task);
    const bootstrapProgressTimeLabel =
      task && typeof task.createdAt === "number" && Number.isFinite(task.createdAt)
        ? formatTime(task.createdAt)
        : "";

    return (
      <div className="conversation-flow" ref={setConversationFlowNode}>
        {transcriptMode === "inspect" && canReturnToLiveView && (
          <div
            style={{
              marginBottom: 12,
              padding: "10px 12px",
              border: "1px solid var(--border-color, rgba(255,255,255,0.12))",
              borderRadius: 10,
              background: "var(--surface-secondary, rgba(255,255,255,0.04))",
              color: "var(--text-secondary, rgba(255,255,255,0.72))",
              fontSize: 12,
              lineHeight: 1.45,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span>Inspecting the full transcript.</span>
            <button type="button" className="action-block-show-all-btn" onClick={onBackToLiveView}>
              Back to live view
            </button>
          </div>
        )}
        {reasoningPanel}
        {newActivityCount > 0 && (
          <button
            type="button"
            className="activity-new-items timeline-new-activity"
            onClick={() => {
              onNewActivityCountChange?.(0);
              scrollToBottom();
            }}
          >
            {newActivityCount} new activit
            {newActivityCount === 1 ? "y" : "ies"}
          </button>
        )}
        {showBootstrapProgress ? (
          <StepFeed
            title={
              <span className="thinking-title" aria-label={bootstrapProgressTitle}>
                {bootstrapProgressTitle}
                <span className="thinking-ellipsis" aria-hidden="true">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </span>
            }
            timeLabel={bootstrapProgressTimeLabel}
            indicator={{ icon: Loader2, tone: "active", spin: true, label: "In progress" }}
            expandable={false}
            expanded={false}
          />
        ) : !useVirtualizedFeed ? (
          renderedFeedRows.map((row) => (
            <MeasuredTaskFeedRow
              key={row.key}
              itemKey={row.key}
              visiblePerfEventId={getTaskFeedRowVisiblePerfEventId(row)}
              enabled={Boolean(rendererPerfLoggingEnabled)}
            >
              {renderedFeedNodeByKey.get(row.key) ?? null}
            </MeasuredTaskFeedRow>
          ))
        ) : (
          <div
            ref={virtualFeedListRef}
            style={{ height: virtualFeedTotalHeight, position: "relative" }}
          >
            {virtualFeedRows.map((virtualRow) => (
              <VirtualizedTaskFeedRow
                key={virtualRow.item.key}
                itemKey={virtualRow.item.key}
                offsetTop={virtualRow.offsetTop}
                estimatedHeight={virtualRow.height}
                onHeightChange={handleFeedRowHeightChange}
                visiblePerfEventId={getTaskFeedRowVisiblePerfEventId(virtualRow.item)}
                visibilityEnabled={Boolean(rendererPerfLoggingEnabled)}
              >
                {renderedFeedNodeByKey.get(virtualRow.item.key) ?? null}
              </VirtualizedTaskFeedRow>
            ))}
          </div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.taskId === next.taskId &&
    prev.taskSwitchId === next.taskSwitchId &&
    prev.hasMoreTimelineHistory === next.hasMoreTimelineHistory &&
    prev.isLoadingTimelineHistory === next.isLoadingTimelineHistory &&
    prev.timelineHistoryError === next.timelineHistoryError &&
    prev.onLoadMoreTimelineHistory === next.onLoadMoreTimelineHistory &&
    prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled &&
    prev.isChatTask === next.isChatTask &&
    prev.isTaskWorking === next.isTaskWorking &&
    prev.newActivityCount === next.newActivityCount &&
    prev.onNewActivityCountChange === next.onNewActivityCountChange &&
    prev.task?.status === next.task?.status &&
    prev.task?.createdAt === next.task?.createdAt &&
    prev.formatTime === next.formatTime &&
    prev.isReplayMode === next.isReplayMode &&
    prev.transcriptMode === next.transcriptMode &&
    prev.canReturnToLiveView === next.canReturnToLiveView &&
    prev.onBackToLiveView === next.onBackToLiveView &&
    prev.reasoningPanelSignature === next.reasoningPanelSignature &&
    prev.mainBodyRef === next.mainBodyRef &&
    prev.timelineRef === next.timelineRef &&
    prev.getRenderedFeedRow === next.getRenderedFeedRow &&
    getTaskFeedRowsSignature(prev.visibleFeedRows) ===
      getTaskFeedRowsSignature(next.visibleFeedRows),
);

interface TaskConversationFlowProps {
  rendererPerfLoggingEnabled?: boolean | undefined;
  taskSwitchId?: string | null | undefined;
  hasMoreTimelineHistory?: boolean | undefined;
  isLoadingTimelineHistory?: boolean | undefined;
  timelineHistoryError?: string | null | undefined;
  onLoadMoreTimelineHistory?:
    | ((options?: { loadAll?: boolean }) => void | Promise<void>)
    | undefined;
  agentContext: AgentContext;
  onOpenSettings?: ((tab?: SettingsTab) => void) | undefined;
  childEvents: TaskEvent[];
  childTasks: Task[];
  collaborativeRun: AgentTeamRun | null;
  commandOutputSessionsByInsertIndex: Map<number, CommandOutputSession[]>;
  currentStep: {
    description: string;
  } | null;
  eventTitleMarkdownComponents: Components;
  events: TaskEvent[];
  activityGroupsById: Map<string, SharedTaskEventUiState["activityGroups"][number]>;
  disclosureIntents: DisclosureIntentState;
  toggleDisclosureIntent: (scope: DisclosureScope, id: string, isCurrent?: boolean) => void;
  handleCanvasClose: (sessionId: string) => void;
  handleMessageFeedback: (payload: {
    messageId: string;
    decision: "accepted" | "rejected";
    reason?: string;
  }) => Promise<void>;
  handleStepFeedback: (action: StepFeedbackAction, message?: string) => Promise<void>;
  isChatTask: boolean;
  isTaskWorking: boolean;
  newActivityCount: number;
  onNewActivityCountChange: React.Dispatch<React.SetStateAction<number>>;
  isReplayMode: boolean;
  codeBlockRunTarget?: CodeBlockRunTarget | undefined;
  defaultTranscriptMode: TranscriptMode;
  transcriptMode: TranscriptMode;
  lastAssistantMessage: TaskEvent | null;
  initialPromptEventId: string | null;
  trimmedPrompt: string;
  markdownComponents: Components;
  messageFeedbackMap: Map<string, "accepted" | "rejected">;
  mainBodyRef: React.RefObject<HTMLDivElement | null>;
  onOpenBrowserView?: ((url?: string) => void) | undefined;
  onForkTaskSessionFromEvent?: ((event: TaskEvent) => void) | undefined;
  onSelectChildTask?: ((taskId: string) => void) | undefined;
  onOpenChildAgentSidebar?: ((taskId: string) => void) | undefined;
  onViewTaskOutputs?: ((taskId: string, primaryOutputPath?: string) => void) | undefined;
  onOpenSpreadsheetArtifact?: ((path: string) => void) | undefined;
  onOpenDocumentArtifact?: ((path: string) => void) | undefined;
  onOpenPresentationArtifact?: ((path: string) => void) | undefined;
  onOpenWebArtifact?: ((path: string) => void) | undefined;
  parallelGroupsByAnchorEventId: Map<string, ParallelGroupProjection>;
  rejectMenuOpenFor: string | null;
  rejectMenuRef: React.RefObject<HTMLDivElement | null>;
  renderCommandOutputs: (sessions?: CommandOutputSession[]) => React.ReactNode;
  setRejectMenuOpenFor: React.Dispatch<React.SetStateAction<string | null>>;
  setStepFeedbackOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setStepFeedbackText: React.Dispatch<React.SetStateAction<string>>;
  setViewerFilePath: React.Dispatch<React.SetStateAction<string | null>>;
  formatTime: (timestamp: number) => string;
  shouldRenderTimelineEventInStepFeed: (event: TaskEvent) => boolean;
  toolCallPairing: {
    completions: Map<string, TaskEvent>;
    claimedResultIds: Set<string>;
  };
  hasEventDetails: (event: TaskEvent) => boolean;
  isEventExpanded: (event: TaskEvent) => boolean;
  stepFeedbackOpen: boolean;
  stepFeedbackSending: boolean;
  stepFeedbackText: string;
  suppressedParallelEventIds: Set<string>;
  task: Task;
  botName?: string | undefined;
  botMascotForSender?: BotMascotLookup | undefined;
  timelineItems: TaskTimelineItem[];
  timelineRef: React.RefObject<HTMLDivElement | null>;
  toggleEventExpanded: (eventId: string) => void;
  verboseSteps: boolean;
  voiceEnabled: boolean;
  wrappingUp: boolean;
  onWrapUp?: (() => void) | undefined;
  workspace: Workspace | null;
  returnToDefaultTranscript: () => void;
  openFileInPanel: (path: string) => void;
  botIcon?: string;
}

export const TaskConversationFlow = memo(function TaskConversationFlow(
  props: TaskConversationFlowProps,
) {
  const rendererPerfLoggingEnabled = props.rendererPerfLoggingEnabled;
  const taskSwitchId = props.taskSwitchId;
  const hasMoreTimelineHistory = props.hasMoreTimelineHistory;
  const isLoadingTimelineHistory = props.isLoadingTimelineHistory;
  const timelineHistoryError = props.timelineHistoryError;
  const onLoadMoreTimelineHistory = props.onLoadMoreTimelineHistory;
  const agentContext = props.agentContext;
  const onOpenSettings = props.onOpenSettings;
  const childEvents = props.childEvents;
  const childTasks = props.childTasks;
  const agentGlyphs = useMemo(() => assignAgentGlyphs(childTasks), [childTasks]);
  const childTasksById = useMemo(
    () => new Map(childTasks.map((childTask) => [childTask.id, childTask])),
    [childTasks],
  );
  const collaborativeRun = props.collaborativeRun;
  const commandOutputSessionsByInsertIndex = props.commandOutputSessionsByInsertIndex;
  const currentStep = props.currentStep;
  const eventTitleMarkdownComponents = props.eventTitleMarkdownComponents;
  const events = props.events;
  const supersededSurfaceEventIds = useMemo(() => supersededAnswerSurfaceEvents(events), [events]);
  const activityGroupsById = props.activityGroupsById;
  const disclosureIntents = props.disclosureIntents;
  const toggleDisclosureIntent = props.toggleDisclosureIntent;
  const handleCanvasClose = props.handleCanvasClose;
  const handleMessageFeedback = props.handleMessageFeedback;
  const handleStepFeedback = props.handleStepFeedback;
  const isChatTask = props.isChatTask;
  const isTaskWorking = props.isTaskWorking;
  const newActivityCount = props.newActivityCount;
  const onNewActivityCountChange = props.onNewActivityCountChange;
  const isReplayMode = props.isReplayMode;
  const codeBlockRunTarget = props.codeBlockRunTarget;
  const defaultTranscriptMode = props.defaultTranscriptMode;
  const transcriptMode = props.transcriptMode;
  const lastAssistantMessage = props.lastAssistantMessage;
  const initialPromptEventId = props.initialPromptEventId;
  const trimmedPrompt = props.trimmedPrompt;
  const markdownComponents = props.markdownComponents;
  const messageFeedbackMap = props.messageFeedbackMap;
  const mainBodyRef = props.mainBodyRef;
  const onOpenBrowserView = props.onOpenBrowserView;
  const onForkTaskSessionFromEvent = props.onForkTaskSessionFromEvent;
  const onSelectChildTask = props.onSelectChildTask;
  const onOpenChildAgentSidebar = props.onOpenChildAgentSidebar;
  const onViewTaskOutputs = props.onViewTaskOutputs;
  const onOpenSpreadsheetArtifact = props.onOpenSpreadsheetArtifact;
  const onOpenDocumentArtifact = props.onOpenDocumentArtifact;
  const onOpenPresentationArtifact = props.onOpenPresentationArtifact;
  const onOpenWebArtifact = props.onOpenWebArtifact;
  const parallelGroupsByAnchorEventId = props.parallelGroupsByAnchorEventId;
  const rejectMenuOpenFor = props.rejectMenuOpenFor;
  const rejectMenuRef = props.rejectMenuRef;
  const renderCommandOutputs = props.renderCommandOutputs;
  const setRejectMenuOpenFor = props.setRejectMenuOpenFor;
  const setStepFeedbackOpen = props.setStepFeedbackOpen;
  const setStepFeedbackText = props.setStepFeedbackText;
  const setViewerFilePath = props.setViewerFilePath;
  const formatTime = props.formatTime;
  const shouldRenderTimelineEventInStepFeed = props.shouldRenderTimelineEventInStepFeed;
  const toolCallPairing = props.toolCallPairing;
  const hasEventDetails = props.hasEventDetails;
  const isEventExpanded = props.isEventExpanded;
  const stepFeedbackOpen = props.stepFeedbackOpen;
  const stepFeedbackSending = props.stepFeedbackSending;
  const stepFeedbackText = props.stepFeedbackText;
  const suppressedParallelEventIds = props.suppressedParallelEventIds;
  const task = props.task;
  const isBotConversation = task?.agentConfig?.botConversation === true;
  // Bot transcripts follow the teammate-conversation model: keep messages and
  // user-relevant outcomes in the flow, but keep internal execution activity
  // out of the primary conversation surface.
  const isConversationOnlySurface = isChatTask || isBotConversation;
  const botName = props.botName;
  const botMascot = resolveBotMascot(props.botIcon);
  const botMascotForSender = props.botMascotForSender;
  const timelineItems = props.timelineItems;
  const timelineRef = props.timelineRef;
  const toggleEventExpanded = props.toggleEventExpanded;
  const verboseSteps = props.verboseSteps;
  const voiceEnabled = props.voiceEnabled;
  const wrappingUp = props.wrappingUp;
  const onWrapUp = props.onWrapUp;
  const workspace = props.workspace;
  const returnToDefaultTranscript = props.returnToDefaultTranscript;
  const openFileInPanel = props.openFileInPanel;

  recordRendererRender(
    "MainContent.taskConversationShell",
    task?.id ? `task:${task.id}` : "task:none",
    rendererPerfLoggingEnabled,
  );

  const stepFeedTimelineIndexPosition = new Map<number, number>();
  let stepFeedEventCount = 0;
  timelineItems.forEach((timelineItem, timelineIndex) => {
    if (isConversationOnlySurface && timelineItem.kind === "action_block") {
      return;
    }
    if (timelineItem.kind === "action_block") {
      stepFeedTimelineIndexPosition.set(timelineIndex, stepFeedEventCount);
      stepFeedEventCount += 1;
      return;
    }
    if (timelineItem.kind !== "event") return;
    const event = timelineItem.event;
    const eventId = event.id;
    if (suppressedParallelEventIds.has(eventId) && !parallelGroupsByAnchorEventId.has(eventId)) {
      return;
    }
    if (
      !parallelGroupsByAnchorEventId.has(eventId) &&
      !shouldRenderTimelineEventInStepFeed(event)
    ) {
      return;
    }
    stepFeedTimelineIndexPosition.set(timelineIndex, stepFeedEventCount);
    stepFeedEventCount += 1;
  });

  const leadingCommandOutputSessions = commandOutputSessionsByInsertIndex.get(-1) ?? [];
  const [expandedArtifactStacks, setExpandedArtifactStacks] = useState<Set<string>>(
    () => new Set(),
  );
  const expandArtifactStack = useCallback((rowKey: string) => {
    setExpandedArtifactStacks((current) => {
      if (current.has(rowKey)) return current;
      const next = new Set(current);
      next.add(rowKey);
      return next;
    });
  }, []);
  useEffect(() => {
    setExpandedArtifactStacks(new Set());
  }, [task?.id]);
  const getActionBlockRenderState = useCallback(
    (blockEvents: TaskEvent[], blockEventIndices: number[], _blockId: string) => {
      const renderableRawIndices: number[] = [];
      for (let ri = 0; ri < blockEvents.length; ri += 1) {
        const event = blockEvents[ri] as TaskEvent;
        if (
          suppressedParallelEventIds.has(event.id) &&
          !parallelGroupsByAnchorEventId.has(event.id)
        ) {
          continue;
        }
        if (
          !parallelGroupsByAnchorEventId.has(event.id) &&
          !shouldRenderTimelineEventInStepFeed(event)
        ) {
          continue;
        }
        renderableRawIndices.push(ri);
      }

      const renderableCount = renderableRawIndices.length;
      const renderableEvents = renderableRawIndices.map((ri) => blockEvents[ri] as TaskEvent);
      const visibleBlockEvents = renderableRawIndices.map((ri) => blockEvents[ri] as TaskEvent);
      const visibleBlockEventIndices = renderableRawIndices.map(
        (ri) => blockEventIndices[ri] as number,
      );
      const commandOutputsForBlock = blockEventIndices.flatMap(
        (eventIndex: number) => commandOutputSessionsByInsertIndex.get(eventIndex) ?? [],
      );

      return {
        renderableCount,
        renderableEvents,
        visibleBlockEvents,
        visibleBlockEventIndices,
        hiddenBlockEventCount: 0,
        hasBlockCommandOutputs: commandOutputsForBlock.length > 0,
        commandOutputsForBlock,
      };
    },
    [
      commandOutputSessionsByInsertIndex,
      parallelGroupsByAnchorEventId,
      shouldRenderTimelineEventInStepFeed,
      suppressedParallelEventIds,
    ],
  );
  const feedRows = useMemo<TaskFeedRow[]>(() => {
    const rows: TaskFeedRow[] = [];
    const imageStacks = collectGeneratedImageStacks(events);
    const imageStacksByAnchorIndex = new Map<number, GeneratedImageStack[]>();
    // Timeline item indices refer to the filtered live stream while stacks are computed
    // over all events, so anchor by event id when the anchor event has one.
    const imageStacksByAnchorEventId = new Map<string, GeneratedImageStack[]>();
    for (const stack of imageStacks) {
      const anchorEventId = events[stack.anchorEventIndex]?.id;
      if (anchorEventId) {
        const existing = imageStacksByAnchorEventId.get(anchorEventId) || [];
        existing.push(stack);
        imageStacksByAnchorEventId.set(anchorEventId, existing);
        continue;
      }
      const existing = imageStacksByAnchorIndex.get(stack.anchorEventIndex) || [];
      existing.push(stack);
      imageStacksByAnchorIndex.set(stack.anchorEventIndex, existing);
    }
    const getTimelineItemEvents = (item: TaskTimelineItem): TaskEvent[] =>
      item.kind === "event"
        ? [item.event]
        : item.kind === "action_block" && Array.isArray(item.events)
          ? item.events
          : [];
    const pushedImageStackKeys = new Set<string>();
    const pushImageStacksForTimelineItem = (item: TaskTimelineItem) => {
      const eventIndices =
        item.kind === "event"
          ? [item.eventIndex]
          : item.kind === "action_block" && Array.isArray(item.eventIndices)
            ? item.eventIndices
            : [];
      const itemStacks: GeneratedImageStack[] = [];
      for (const itemEvent of getTimelineItemEvents(item)) {
        const stacks = itemEvent?.id ? imageStacksByAnchorEventId.get(itemEvent.id) : undefined;
        if (stacks) itemStacks.push(...stacks);
      }
      for (const eventIndex of eventIndices) {
        if (typeof eventIndex !== "number") continue;
        const stacks = imageStacksByAnchorIndex.get(eventIndex);
        if (stacks) itemStacks.push(...stacks);
      }
      for (const stack of itemStacks) {
        const rowKey = `image-stack:${stack.anchorEventIndex}`;
        if (pushedImageStackKeys.has(rowKey)) continue;
        pushedImageStackKeys.add(rowKey);
        const expanded = expandedArtifactStacks.has(rowKey);
        rows.push({
          kind: "image-stack",
          key: rowKey,
          estimatedHeight: estimateGeneratedImageStackHeight(stack.images, expanded),
          images: stack.images,
          revision: [
            expanded ? "expanded" : "collapsed",
            stack.images.map((image) => `${image.path}:${image.eventId ?? "none"}`).join("|"),
          ].join(":"),
          visiblePerfEventId: null,
        });
      }
    };

    // Each finished turn gets one file line, placed after the last row that shows any of
    // the turn's events, so it sits under the turn's answer and never moves mid-turn.
    const turnOutputs = collectTurnOutputSummaries(events, { isTaskWorking });
    const turnIndexByEventId = new Map<string, number>();
    turnOutputs.forEach((summary, turnIndex) => {
      for (let index = summary.startIndex; index <= summary.endIndex; index += 1) {
        const eventId = events[index]?.id;
        if (eventId) turnIndexByEventId.set(eventId, turnIndex);
      }
    });
    const turnOutputsByLastTimelineIndex = new Map<number, number[]>();
    if (turnOutputs.length > 0) {
      const lastTimelineIndexByTurn = new Map<number, number>();
      timelineItems.forEach((item, timelineIndex) => {
        for (const itemEvent of getTimelineItemEvents(item)) {
          const turnIndex = itemEvent?.id ? turnIndexByEventId.get(itemEvent.id) : undefined;
          if (turnIndex !== undefined) lastTimelineIndexByTurn.set(turnIndex, timelineIndex);
        }
      });
      for (const [turnIndex, timelineIndex] of lastTimelineIndexByTurn) {
        const existing = turnOutputsByLastTimelineIndex.get(timelineIndex) || [];
        existing.push(turnIndex);
        turnOutputsByLastTimelineIndex.set(timelineIndex, existing);
      }
    }
    const pushTurnOutputsAfterTimelineItem = (timelineIndex: number) => {
      for (const turnIndex of turnOutputsByLastTimelineIndex.get(timelineIndex) ?? []) {
        const summary = turnOutputs[turnIndex];
        rows.push({
          kind: "turn-outputs",
          key: `turn-outputs:${summary.key}`,
          estimatedHeight: 44,
          files: summary.files,
          revision: summary.files.map((file) => `${file.action}:${file.path}`).join("|"),
          visiblePerfEventId: null,
        });
      }
    };
    let lastActionBlockTimelineIndex = -1;
    for (let i = timelineItems.length - 1; i >= 0; i -= 1) {
      if (timelineItems[i].kind === "action_block") {
        lastActionBlockTimelineIndex = i;
        break;
      }
    }

    if (leadingCommandOutputSessions.length > 0) {
      rows.push({
        kind: "leading-command-outputs",
        key: "command-outputs:-1",
        estimatedHeight: 180,
        sessions: leadingCommandOutputSessions,
        revision: getCommandOutputSessionsRevision(leadingCommandOutputSessions),
        visiblePerfEventId: null,
      });
    }

    timelineItems.forEach((item, timelineIndex) => {
      let visiblePerfEventId: string | null = null;
      const key =
        item.kind === "canvas"
          ? `canvas:${item.session.id}`
          : item.kind === "cli-agent-frame"
            ? `cli-agent:${item.childTask.id}`
            : item.kind === "dispatched-agents"
              ? "dispatched-agents"
              : item.kind === "agent-lifecycle"
                ? `agent-lifecycle:${item.row.id}`
                : item.kind === "action_block"
                  ? `action-block:${item.blockId}`
                  : `event:${item.event.id}`;
      if (item.kind === "event") {
        visiblePerfEventId = item.event.id;
      } else if (item.kind === "action_block") {
        const actionBlockState = getActionBlockRenderState(
          item.events as TaskEvent[],
          item.eventIndices,
          item.blockId,
        );
        if (actionBlockState.renderableCount === 0 && !actionBlockState.hasBlockCommandOutputs) {
          // Generated images and turn file lines anchored in a hidden block still surface.
          pushImageStacksForTimelineItem(item);
          pushTurnOutputsAfterTimelineItem(timelineIndex);
          return;
        }
        const visibleBlockEvents = actionBlockState.visibleBlockEvents;
        visiblePerfEventId = visibleBlockEvents[visibleBlockEvents.length - 1]?.id ?? null;
      }
      const revision =
        item.kind === "canvas"
          ? `${item.session.id}:${item.forceSnapshot ? 1 : 0}`
          : item.kind === "cli-agent-frame"
            ? `${item.childTask.id}:${item.childTask.status}:${item.childTaskEvents.length}:${
                item.childTaskEvents[item.childTaskEvents.length - 1]?.id ?? "none"
              }`
            : item.kind === "dispatched-agents"
              ? `${childTasks
                  .map((childTask) => `${childTask.id}:${childTask.status}`)
                  .join(",")}:${childEvents.length}:${collaborativeRun?.id ?? "none"}`
              : item.kind === "agent-lifecycle"
                ? getAgentLifecycleRowRevision(item.row as AgentLifecycleRowModel, childTasksById)
                : item.kind === "action_block"
                  ? `${item.blockId}:${item.events.length}:${
                      item.events[item.events.length - 1]?.id ?? "none"
                    }:${item.eventIndices
                      .map((eventIndex: number) =>
                        getCommandOutputSessionsRevision(
                          commandOutputSessionsByInsertIndex.get(eventIndex),
                        ),
                      )
                      .join("||")}`
                  : `${item.event.id}:${getEffectiveTaskEventType(item.event)}:${
                      toolCallPairing.completions.get(item.event.id)?.id ?? "none"
                    }:${getCommandOutputSessionsRevision(
                      commandOutputSessionsByInsertIndex.get(item.eventIndex),
                    )}`;

      rows.push({
        kind: "timeline",
        key,
        estimatedHeight:
          item.kind === "action_block"
            ? (() => {
                const actionBlockState = getActionBlockRenderState(
                  item.events as TaskEvent[],
                  item.eventIndices,
                  item.blockId,
                );
                if (actionBlockState.renderableCount === 0) {
                  return actionBlockState.hasBlockCommandOutputs ? 180 : 0;
                }
                const isLatestActionBlock = timelineIndex === lastActionBlockTimelineIndex;
                const isActive =
                  isLatestActionBlock &&
                  (isTaskWorking || isReplayMode) &&
                  isActivityBlockInLatestTurn(item.events as TaskEvent[], events);
                const expandSteps = verboseSteps || isReplayMode;
                const expanded = resolveDisclosureExpanded({
                  intent: getDisclosureIntent(disclosureIntents, "group", item.blockId),
                  // Compact step groups start folded to their summary ("Read files, ran
                  // a command"); verbose and replay views keep them open.
                  isCurrent: expandSteps && isActive,
                  defaultExpanded: expandSteps,
                });
                const visibleEventCount = expanded ? actionBlockState.visibleBlockEvents.length : 0;
                return estimateTaskFeedRowHeight(item, {
                  expanded,
                  visibleEventCount,
                  hasVisibilityToggle: false,
                });
              })()
            : estimateTaskFeedRowHeight(item),
        timelineIndex,
        item,
        revision,
        visiblePerfEventId,
      });
      pushImageStacksForTimelineItem(item);
      pushTurnOutputsAfterTimelineItem(timelineIndex);
    });

    return rows;
  }, [
    childEvents,
    childTasks,
    collaborativeRun?.id,
    commandOutputSessionsByInsertIndex,
    leadingCommandOutputSessions,
    hasMoreTimelineHistory,
    isLoadingTimelineHistory,
    timelineHistoryError,
    timelineItems,
    disclosureIntents,
    shouldRenderTimelineEventInStepFeed,
    suppressedParallelEventIds,
    parallelGroupsByAnchorEventId,
    toolCallPairing.completions,
    isTaskWorking,
    isReplayMode,
    getActionBlockRenderState,
    events,
    expandedArtifactStacks,
    verboseSteps,
  ]);
  const displayFeedRows = useMemo(
    () =>
      feedRows.filter((row) => {
        if (row.kind === "history-control") return true;
        if (row.kind === "leading-command-outputs") {
          return !isConversationOnlySurface && row.sessions.length > 0;
        }
        if (row.kind === "image-stack" || row.kind === "turn-outputs") {
          return Boolean(workspace?.path);
        }
        if (row.kind !== "timeline") return true;

        const { item } = row;
        if (
          item.kind === "canvas" ||
          item.kind === "cli-agent-frame" ||
          item.kind === "dispatched-agents" ||
          item.kind === "agent-lifecycle"
        ) {
          return !isConversationOnlySurface;
        }
        if (item.kind === "action_block") {
          return !isConversationOnlySurface;
        }
        if (item.kind !== "event") return true;

        const event = item.event as TaskEvent;
        const effectiveType = getEffectiveTaskEventType(event);
        const isUserMessage = effectiveType === "user_message";
        const isAssistantMessage = effectiveType === "assistant_message";
        const isCompletionSummaryMessage = getCompletionSummaryText(event).length > 0;
        const commandOutputsAfterEvent =
          item.eventIndex === undefined
            ? undefined
            : commandOutputSessionsByInsertIndex.get(item.eventIndex);
        const hasCommandOutputs = Boolean(commandOutputsAfterEvent?.length);

        if (
          isConversationOnlySurface &&
          !isUserMessage &&
          !isAssistantMessage &&
          !isCompletionSummaryMessage
        ) {
          return effectiveType === "llm_streaming" && isTaskWorking;
        }

        if (isUserMessage) {
          const suppressedInitialPrompt = shouldSuppressInitialPromptUserEvent({
            event,
            initialPromptEventId,
            trimmedPrompt,
            taskCreatedAt: task?.createdAt,
          });
          return !suppressedInitialPrompt || hasCommandOutputs;
        }

        if (isAssistantMessage || isCompletionSummaryMessage) return true;

        const parallelGroup = parallelGroupsByAnchorEventId.get(event.id);
        if (suppressedParallelEventIds.has(event.id) && !parallelGroup) {
          return hasCommandOutputs;
        }
        if (!parallelGroup && !shouldRenderTimelineEventInStepFeed(event)) {
          return hasCommandOutputs;
        }
        return true;
      }),
    [
      commandOutputSessionsByInsertIndex,
      feedRows,
      initialPromptEventId,
      isConversationOnlySurface,
      isTaskWorking,
      parallelGroupsByAnchorEventId,
      shouldRenderTimelineEventInStepFeed,
      suppressedParallelEventIds,
      task?.createdAt,
      trimmedPrompt,
      workspace?.path,
    ],
  );
  const turnDisclosuresEnabled = shouldUseTurnDisclosures({
    verboseSteps,
    isReplayMode,
    isConversationOnlySurface,
  });
  // With per-turn headers a finished task is already folded turn by turn, so the transcript
  // shows every row the turn projection kept instead of the task-wide delivery subset.
  const feedTranscriptMode: TranscriptMode =
    turnDisclosuresEnabled && transcriptMode === "delivery" ? "inspect" : transcriptMode;
  const turnProjectedFeedRows = useMemo(
    () =>
      turnDisclosuresEnabled
        ? applyTurnDisclosures(mergeAdjacentActivityBlockRows(displayFeedRows), {
            isTaskWorking,
            taskStartedAt: task?.createdAt ?? 0,
            isTurnExpanded: (turnId) =>
              resolveDisclosureExpanded({
                intent: getDisclosureIntent(disclosureIntents, "group", turnId),
                isCurrent: false,
              }),
          }).rows
        : displayFeedRows,
    [disclosureIntents, displayFeedRows, isTaskWorking, task?.createdAt, turnDisclosuresEnabled],
  );
  const { visibleFeedRows } = useMemo(
    () => selectVisibleTaskFeedRows(turnProjectedFeedRows, feedTranscriptMode),
    [feedTranscriptMode, turnProjectedFeedRows],
  );
  const reasoningPanelState = useMemo(
    () =>
      deriveAgentReasoningPanelState({
        events,
        taskId: task?.id,
        isTaskWorking,
      }),
    [events, isTaskWorking, task?.id],
  );
  const showReasoningPanel =
    transcriptMode === "live" &&
    !isConversationOnlySurface &&
    isTaskWorking &&
    hasAgentReasoningPanelContent(reasoningPanelState);
  const reasoningPanelSignature = showReasoningPanel
    ? [
        currentStep?.description || "",
        reasoningPanelState.isStreaming ? "1" : "0",
        reasoningPanelState.activeStreamText,
      ].join("::")
    : "";
  const feedRowRenderCacheRef = useRef<Map<string, { signature: string; node: React.ReactNode }>>(
    new Map(),
  );

  useEffect(() => {
    const activeKeys = new Set(visibleFeedRows.map((row) => row.key));
    for (const key of feedRowRenderCacheRef.current.keys()) {
      if (!activeKeys.has(key)) {
        feedRowRenderCacheRef.current.delete(key);
      }
    }
  }, [visibleFeedRows]);
  const lastActionBlockTimelineIndex = useMemo(() => {
    for (let i = timelineItems.length - 1; i >= 0; i -= 1) {
      if (timelineItems[i].kind === "action_block") return i;
    }
    return -1;
  }, [timelineItems]);
  // Narration between agent steps ("I'll read the config next…") isn't a reply the
  // user acts on, so it gets no copy/feedback row; the row's reserved height only
  // pushed the next step away.
  const stepMessageEventIds = useMemo(
    () => getStepMessageEventIds(timelineItems, isTaskWorking),
    [timelineItems, isTaskWorking],
  );

  const conversationFlow = useMemo(
    () => (
      <>
        {/* Conversation Flow - renders all events in order; show when we have events OR collaborative run with child tasks */}
        {(events.length > 0 || (collaborativeRun && childTasks.length > 0) || isTaskWorking) &&
          (() => {
            const getRowRenderSignature = (row: TaskFeedRow): string => {
              if (row.kind === "history-control") {
                return row.revision;
              }
              if (row.kind === "leading-command-outputs") {
                return row.revision;
              }
              if (
                row.kind === "image-stack" ||
                row.kind === "turn-outputs" ||
                row.kind === "turn-header"
              ) {
                return row.revision;
              }

              const { item, timelineIndex } = row;
              if (
                item.kind === "canvas" ||
                item.kind === "cli-agent-frame" ||
                item.kind === "agent-lifecycle"
              ) {
                return row.revision;
              }
              if (item.kind === "dispatched-agents") {
                return `${row.revision}:${wrappingUp ? 1 : 0}`;
              }
              if (item.kind === "action_block") {
                const visibleEventState = item.events
                  .map((event: TaskEvent) => {
                    const disclosure = getDisclosureIntent(disclosureIntents, "activity", event.id);
                    const parallel = parallelGroupsByAnchorEventId.has(event.id) ? 1 : 0;
                    const suppressed = suppressedParallelEventIds.has(event.id) ? 1 : 0;
                    const isLastAssistant = isLastAssistantMessageEvent(event, lastAssistantMessage)
                      ? 1
                      : 0;
                    return `${event.id}:${getTaskEventPayloadRenderSignature(event)}:${disclosure}:${parallel}:${suppressed}:${isLastAssistant}`;
                  })
                  .join("|");
                return [
                  row.revision,
                  getDisclosureIntent(disclosureIntents, "group", item.blockId),
                  timelineIndex === lastActionBlockTimelineIndex ? 1 : 0,
                  timelineIndex === lastActionBlockTimelineIndex &&
                  isActivityBlockInLatestTurn(item.events as TaskEvent[], events)
                    ? 1
                    : 0,
                  isTaskWorking ? 1 : 0,
                  isReplayMode ? 1 : 0,
                  verboseSteps ? 1 : 0,
                  visibleEventState,
                ].join(":");
              }

              const event = item.event as TaskEvent;
              const effectiveType = getEffectiveTaskEventType(event);
              return [
                row.revision,
                getDisclosureIntent(disclosureIntents, "activity", event.id),
                rejectMenuOpenFor === event.id ? 1 : 0,
                messageFeedbackMap.get(event.id) ?? "none",
                lastAssistantMessage?.id === event.id ? 1 : 0,
                stepMessageEventIds.has(event.id) ? 1 : 0,
                stepFeedbackOpen ? 1 : 0,
                stepFeedbackSending ? 1 : 0,
                stepFeedbackText,
                currentStep?.description ?? "none",
                task.status,
                task.terminalStatus ?? "none",
                lastAssistantMessage?.id === event.id &&
                isAssistantMessageInLatestTurn(event, events)
                  ? 1
                  : 0,
                isTaskWorking ? 1 : 0,
                verboseSteps ? 1 : 0,
                effectiveType,
                getTaskEventPayloadRenderSignature(event),
                parallelGroupsByAnchorEventId.has(event.id) ? 1 : 0,
                suppressedParallelEventIds.has(event.id) ? 1 : 0,
                // Bot messages show the bot's name and character, which load after the rows.
                botName ?? "",
                botMascot ?? "",
              ].join(":");
            };

            const renderFeedRow = (row: TaskFeedRow) => {
              if (row.kind === "history-control") {
                return null;
              }
              if (row.kind === "turn-header") {
                return (
                  <TurnHeader
                    turn={row.turn}
                    onToggle={() => toggleDisclosureIntent("group", row.turn.id, false)}
                  />
                );
              }
              if (row.kind === "leading-command-outputs") {
                return renderCommandOutputs(row.sessions);
              }
              if (row.kind === "turn-outputs") {
                if (!workspace?.path) return null;
                return (
                  <TurnOutputsRow
                    files={row.files}
                    workspacePath={workspace.path}
                    onOpenFile={openFileInPanel}
                    onViewAll={
                      task && onViewTaskOutputs
                        ? (primaryPath) => onViewTaskOutputs(task.id, primaryPath)
                        : undefined
                    }
                  />
                );
              }
              if (row.kind === "image-stack") {
                if (!workspace?.path) return null;
                const expanded = expandedArtifactStacks.has(row.key);
                const { visibleImages, hiddenCount } = getVisibleGeneratedImageCards(
                  row.images,
                  expanded,
                );
                return (
                  <div className="conversation-artifact-stack">
                    {visibleImages.map((image) => (
                      <div key={image.path} className="conversation-artifact-image">
                        <InlineImagePreview
                          filePath={image.path}
                          workspacePath={workspace.path}
                          onOpenViewer={setViewerFilePath}
                        />
                      </div>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        className="conversation-artifact-stack-show-more"
                        onClick={() => expandArtifactStack(row.key)}
                        aria-label={`Show ${hiddenCount} more generated images`}
                      >
                        <span>Show {hiddenCount} more</span>
                        <ChevronDown size={17} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              }

              const { item, timelineIndex } = row;
              if (item.kind === "canvas") {
                if (isConversationOnlySurface) return null;
                return (
                  <CanvasPreview
                    session={item.session}
                    onClose={() => handleCanvasClose(item.session.id)}
                    forceSnapshot={item.forceSnapshot}
                    onOpenBrowser={onOpenBrowserView}
                  />
                );
              }

              if (item.kind === "cli-agent-frame") {
                if (isConversationOnlySurface) return null;
                const agentType =
                  resolveCliAgentType(item.childTask, item.childTaskEvents) || "codex-cli";
                return (
                  <CliAgentFrame
                    task={item.childTask}
                    events={item.childTaskEvents}
                    agentType={agentType}
                    defaultExpanded={item.childTask.status === "executing"}
                    onOpenAgent={onOpenChildAgentSidebar ?? onSelectChildTask}
                  />
                );
              }

              if (item.kind === "agent-lifecycle") {
                if (isConversationOnlySurface) return null;
                const lifecycleRow = item.row as AgentLifecycleRowModel;
                const rowTasks = lifecycleRow.taskIds
                  .map((taskId) => childTasksById.get(taskId))
                  .filter((childTask): childTask is Task => Boolean(childTask));
                return (
                  <AgentLifecycleRow
                    key={lifecycleRow.id}
                    row={lifecycleRow}
                    tasks={rowTasks}
                    glyphs={agentGlyphs}
                    onOpenAgent={onOpenChildAgentSidebar ?? onSelectChildTask}
                  />
                );
              }

              if (item.kind === "dispatched-agents") {
                // Only collaborative runs keep a single team-run surface; other
                // sub-agents render as agent-lifecycle rows.
                if (isConversationOnlySurface || !collaborativeRun) return null;
                return (
                  <div key="dispatched-agents" className="collaborative-thoughts-main">
                    <CollaborativeSummaryPanel
                      collaborativeRun={collaborativeRun}
                      childTasks={childTasks}
                      childEvents={childEvents}
                      agentGlyphs={agentGlyphs}
                      userPrompt={task?.rawPrompt || task?.userPrompt || task?.prompt}
                      onSelectChildTask={onSelectChildTask}
                      onOpenChildAgentSidebar={onOpenChildAgentSidebar}
                      mainTaskCompleted={
                        !!task && ["completed", "failed", "cancelled"].includes(task.status)
                      }
                      onWrapUp={onWrapUp}
                      isWrappingUp={wrappingUp}
                    />
                  </div>
                );
              }

              if (item.kind === "action_block") {
                if (isConversationOnlySurface) return null;
                const isBlockOnlyMinimalCompletions =
                  !verboseSteps &&
                  item.events.length > 0 &&
                  item.events.every((ev: TaskEvent) => {
                    const t = getEffectiveTaskEventType(ev);
                    const out = resolveTaskOutputSummaryFromCompletionEvent(ev, events);
                    return t === "task_completed" && !hasTaskOutputs(out);
                  });
                if (isBlockOnlyMinimalCompletions) {
                  const indicatorPosition = stepFeedTimelineIndexPosition.get(timelineIndex);
                  const showConnectorAbove =
                    typeof indicatorPosition === "number" && indicatorPosition > 0;
                  const showConnectorBelow =
                    typeof indicatorPosition === "number" &&
                    indicatorPosition < stepFeedEventCount - 1;
                  const commandOutputsForBlock = item.eventIndices.flatMap(
                    (ei: number) => commandOutputSessionsByInsertIndex.get(ei) ?? [],
                  );
                  return (
                    <Fragment key={item.blockId}>
                      {item.events.map((event: TaskEvent, idx: number) => {
                        const eventIndex = item.eventIndices[idx];
                        if (!shouldRenderTimelineEventInStepFeed(event)) return null;
                        const isLastChild = idx === item.events.length - 1;
                        const showChildConnectorAbove = idx === 0 ? showConnectorAbove : true;
                        const showChildConnectorBelow = !isLastChild || showConnectorBelow;
                        return (
                          <div
                            key={event.id || `event-${eventIndex}`}
                            className="timeline-event completion-compact"
                          >
                            <div className="event-indicator">
                              {showChildConnectorAbove && (
                                <span
                                  className="event-connector event-connector-above"
                                  aria-hidden="true"
                                />
                              )}
                              <span
                                className="event-indicator-icon tone-success"
                                aria-hidden="true"
                                title="Done"
                              >
                                <CheckIcon size={12} strokeWidth={2} />
                              </span>
                              {showChildConnectorBelow && (
                                <span
                                  className="event-connector event-connector-below"
                                  aria-hidden="true"
                                />
                              )}
                            </div>
                            <div className="event-content completion-compact-content">
                              <span className="completion-compact-label">Done</span>
                              <span className="event-time-muted">
                                {formatTime(event.timestamp)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                      {renderCommandOutputs(commandOutputsForBlock)}
                    </Fragment>
                  );
                }
                const isLatestActionBlock = timelineIndex === lastActionBlockTimelineIndex;
                const isActive =
                  isLatestActionBlock &&
                  (isTaskWorking || isReplayMode) &&
                  isActivityBlockInLatestTurn(item.events as TaskEvent[], events);
                const actionBlockState = getActionBlockRenderState(
                  item.events as TaskEvent[],
                  item.eventIndices,
                  item.blockId,
                );
                const {
                  renderableCount,
                  renderableEvents,
                  visibleBlockEvents,
                  visibleBlockEventIndices,
                  hasBlockCommandOutputs,
                  commandOutputsForBlock,
                } = actionBlockState;
                if (renderableCount === 0) {
                  if (hasBlockCommandOutputs) {
                    return (
                      <Fragment key={item.blockId}>
                        {renderCommandOutputs(commandOutputsForBlock)}
                      </Fragment>
                    );
                  }
                  return null;
                }
                const {
                  summary,
                  activityPhrase,
                  iconKind,
                  stepCount,
                  toolCallCount,
                  durationMs,
                  outputTokens,
                } = buildActionBlockSummary(renderableEvents, events, {
                  isActive,
                  showApprovalNarration: verboseSteps,
                });
                if (
                  !verboseSteps &&
                  !isActive &&
                  isQuietActivityBlock(renderableEvents, toolCallCount)
                ) {
                  return null;
                }
                const projectedActivityGroup = activityGroupsById.get(item.blockId);
                const expandSteps = verboseSteps || isReplayMode;
                const expanded = resolveDisclosureExpanded({
                  intent: getDisclosureIntent(disclosureIntents, "group", item.blockId),
                  // Compact step groups start folded to their summary ("Read files, ran
                  // a command"); verbose and replay views keep them open.
                  isCurrent: expandSteps && isActive,
                  defaultExpanded: expandSteps,
                });
                const onToggle = () =>
                  toggleDisclosureIntent("group", item.blockId, expandSteps && isActive);
                const indicatorPosition = stepFeedTimelineIndexPosition.get(timelineIndex);
                const showConnectorAbove =
                  typeof indicatorPosition === "number" && indicatorPosition > 0;
                const showConnectorBelow =
                  typeof indicatorPosition === "number" &&
                  indicatorPosition < stepFeedEventCount - 1;
                // Exclude sessions shown inline inside currently visible expanded run_command frames.
                // Hidden rows must not suppress their command outputs, or terminals disappear from the windowed feed.
                const inlineRunCommandSessionIds = collectInlineRunCommandSessionIds({
                  events: visibleBlockEvents,
                  eventIndices: visibleBlockEventIndices,
                  commandOutputSessionsByInsertIndex,
                  isEventExpanded,
                });
                const lastVisibleBlockEvent = visibleBlockEvents[visibleBlockEvents.length - 1];
                const lastVisibleRenderEvent = lastVisibleBlockEvent
                  ? (toolCallPairing.completions.get(lastVisibleBlockEvent.id) ??
                    lastVisibleBlockEvent)
                  : undefined;
                const lastStepLabelRaw = lastVisibleRenderEvent
                  ? renderEventTitle(
                      lastVisibleRenderEvent,
                      workspace?.path,
                      openFileInPanel,
                      agentContext,
                      { summaryMode: !verboseSteps },
                    )
                  : undefined;
                const lastStepLabel =
                  projectedActivityGroup?.latestActivityLabel ||
                  (typeof lastStepLabelRaw === "string" ? lastStepLabelRaw : undefined);
                const isFinishedActionBlockTask =
                  task.status === "completed" ||
                  task.status === "failed" ||
                  task.status === "cancelled";
                const actionBlockDurationMs =
                  isLatestActionBlock && (isTaskWorking || isFinishedActionBlockTask)
                    ? 0
                    : durationMs;
                return (
                  <Fragment key={item.blockId}>
                    <ActionBlock
                      blockId={item.blockId}
                      summary={projectedActivityGroup?.summary || summary}
                      iconKind={iconKind}
                      stepCount={stepCount}
                      toolCallCount={toolCallCount}
                      durationMs={actionBlockDurationMs}
                      outputTokens={outputTokens}
                      isActive={isActive}
                      expanded={expanded}
                      onToggle={onToggle}
                      showConnectorAbove={showConnectorAbove}
                      showConnectorBelow={showConnectorBelow}
                      lastStepLabel={lastStepLabel}
                      compactLabel={activityPhrase}
                      startedAt={item.events[0]?.timestamp ?? item.timestamp}
                      replay={isReplayMode}
                      minimal={!verboseSteps}
                    >
                      {(() => {
                        const nestedParallelEventIds = new Set<string>();
                        // Verbose off lists one line per action. Plan-step markers drop out
                        // when there are actions to list, unless they anchor a parallel group.
                        const ownsParallelChildren = (idx: number) => {
                          const next = visibleBlockEvents[idx + 1] as TaskEvent | undefined;
                          return Boolean(next && parallelGroupsByAnchorEventId.has(next.id));
                        };
                        const isHiddenStepMarker = (event: TaskEvent, idx: number) =>
                          !verboseSteps &&
                          isPlanStepLifecycleEvent(event) &&
                          !parallelGroupsByAnchorEventId.has(event.id) &&
                          !ownsParallelChildren(idx);
                        // Compact rows show each command as its shell card. Sessions are
                        // matched to their run_command call by command text: a command logs
                        // two calls (the tool batch's and the shell's), so the second is a
                        // duplicate once the first has claimed the session.
                        const inlineCommandSessionByEventId = new Map<
                          string,
                          CommandOutputSession
                        >();
                        const duplicateCommandEventIds = new Set<string>();
                        if (!verboseSteps) {
                          const unclaimed = [...commandOutputsForBlock];
                          const claimedCommands = new Set<string>();
                          for (const event of visibleBlockEvents as TaskEvent[]) {
                            if (
                              getEffectiveTaskEventType(event) !== "tool_call" ||
                              event.payload?.tool !== "run_command"
                            ) {
                              continue;
                            }
                            const rawCommand =
                              event.payload?.input?.command ?? event.payload?.command;
                            const command = typeof rawCommand === "string" ? rawCommand.trim() : "";
                            if (!command) continue;
                            const matchIndex = unclaimed.findIndex(
                              (session) => session.command.trim() === command,
                            );
                            if (matchIndex >= 0) {
                              const [session] = unclaimed.splice(matchIndex, 1);
                              inlineCommandSessionByEventId.set(event.id, session);
                              claimedCommands.add(command);
                            } else if (claimedCommands.has(command)) {
                              duplicateCommandEventIds.add(event.id);
                            }
                          }
                        }
                        const inlineCommandSessionIds = new Set(
                          [...inlineCommandSessionByEventId.values()].map((session) => session.id),
                        );
                        const hasActionRows = visibleBlockEvents.some(
                          (event: TaskEvent, idx: number) =>
                            !isHiddenStepMarker(event, idx) &&
                            !suppressedParallelEventIds.has(event.id) &&
                            shouldRenderTimelineEventInStepFeed(event),
                        );
                        return visibleBlockEvents.map((event: TaskEvent, idx: number) => {
                          if (nestedParallelEventIds.has(event.id)) return null;

                          const eventIndex = visibleBlockEventIndices[idx];
                          const parallelGroup = parallelGroupsByAnchorEventId.get(event.id);
                          if (suppressedParallelEventIds.has(event.id) && !parallelGroup)
                            return null;
                          if (!parallelGroup && !shouldRenderTimelineEventInStepFeed(event)) {
                            return null;
                          }
                          if (hasActionRows && isHiddenStepMarker(event, idx)) return null;
                          // A command lists as its folded shell card ("Ran git status ›"),
                          // which opens to the command and its output.
                          const inlineCommandSession = inlineCommandSessionByEventId.get(event.id);
                          if (inlineCommandSession) {
                            return (
                              <Fragment key={event.id || `event-${eventIndex}`}>
                                {renderCommandOutputs([inlineCommandSession])}
                              </Fragment>
                            );
                          }
                          if (duplicateCommandEventIds.has(event.id)) return null;
                          const isLastChild = idx === visibleBlockEvents.length - 1;
                          const showChildConnectorAbove = true;
                          const showChildConnectorBelow = !isLastChild || showConnectorBelow;

                          // A finished command's output opens from its row in compact mode;
                          // only running commands keep their terminal visible under the list.
                          const perEventCmdSessions = (
                            commandOutputSessionsByInsertIndex.get(eventIndex) ?? []
                          ).filter(
                            (s: CommandOutputSession) =>
                              !inlineRunCommandSessionIds.has(s.id) &&
                              !inlineCommandSessionIds.has(s.id) &&
                              (verboseSteps || s.isRunning),
                          );

                          if (parallelGroup) {
                            const parallelDisclosureId = `parallel:${parallelGroup.groupId}`;
                            const parallelExpanded = resolveDisclosureExpanded({
                              intent: getDisclosureIntent(
                                disclosureIntents,
                                "activity",
                                parallelDisclosureId,
                              ),
                              isCurrent: false,
                            });
                            return (
                              <Fragment key={event.id || `event-${eventIndex}`}>
                                <ParallelGroupFeed
                                  group={parallelGroup}
                                  timeLabel={formatTime(parallelGroup.startedAt)}
                                  formatTime={formatTime}
                                  showConnectorAbove={showChildConnectorAbove}
                                  showConnectorBelow={showChildConnectorBelow}
                                  expanded={parallelExpanded}
                                  onToggle={() =>
                                    toggleDisclosureIntent("activity", parallelDisclosureId, false)
                                  }
                                  replay={isReplayMode}
                                />
                                {renderCommandOutputs(perEventCmdSessions)}
                              </Fragment>
                            );
                          }

                          const nestedParallelChildren: Array<{
                            event: TaskEvent;
                            eventIndex: number;
                            group: Any;
                          }> = [];
                          const parentStepId = canStepEventOwnParallelChildren(event)
                            ? getTimelineEventStepId(event)
                            : null;
                          if (parentStepId) {
                            for (
                              let childIdx = idx + 1;
                              childIdx < visibleBlockEvents.length;
                              childIdx += 1
                            ) {
                              const childEvent = visibleBlockEvents[childIdx] as TaskEvent;
                              const childParallelGroup = parallelGroupsByAnchorEventId.get(
                                childEvent.id,
                              );
                              if (!childParallelGroup) break;
                              const ownerStepId = getParallelGroupOwnerStepId(
                                childParallelGroup.groupId,
                              );
                              if (!ownerStepId || ownerStepId !== parentStepId) break;
                              nestedParallelEventIds.add(childEvent.id);
                              nestedParallelChildren.push({
                                event: childEvent,
                                eventIndex: visibleBlockEventIndices[childIdx] as number,
                                group: childParallelGroup,
                              });
                            }
                          }

                          const effectiveType = getEffectiveTaskEventType(event);
                          const outputSummary = resolveTaskOutputSummaryFromCompletionEvent(
                            event,
                            events,
                          );
                          const completionSummaryText = getCompletionSummaryText(event);
                          const isMinimalCompletion =
                            !verboseSteps &&
                            effectiveType === "task_completed" &&
                            !hasTaskOutputs(outputSummary) &&
                            completionSummaryText.length === 0;
                          if (isMinimalCompletion) {
                            return (
                              <Fragment key={event.id || `event-${eventIndex}`}>
                                <div className="timeline-event completion-compact">
                                  <div className="event-indicator">
                                    {showChildConnectorAbove && (
                                      <span
                                        className="event-connector event-connector-above"
                                        aria-hidden="true"
                                      />
                                    )}
                                    <span
                                      className="event-indicator-icon tone-success"
                                      aria-hidden="true"
                                      title="Done"
                                    >
                                      <CheckIcon size={12} strokeWidth={2} />
                                    </span>
                                    {showChildConnectorBelow && (
                                      <span
                                        className="event-connector event-connector-below"
                                        aria-hidden="true"
                                      />
                                    )}
                                  </div>
                                  <div className="event-content completion-compact-content">
                                    <span className="completion-compact-label">Done</span>
                                    <span className="event-time-muted">
                                      {formatTime(event.timestamp)}
                                    </span>
                                  </div>
                                </div>
                                {renderCommandOutputs(perEventCmdSessions)}
                              </Fragment>
                            );
                          }

                          const hasNestedChildren = nestedParallelChildren.length > 0;
                          const isExpandable = hasEventDetails(event) || hasNestedChildren;
                          const isExpanded = resolveDisclosureExpanded({
                            intent: getDisclosureIntent(disclosureIntents, "activity", event.id),
                            isCurrent: false,
                          });
                          const toolCallResultEvent = toolCallPairing.completions.get(event.id);
                          const renderEvent = toolCallResultEvent ?? event;
                          // Compact rows show file changes as "Edited name.ts +3 −1".
                          const fileChange = verboseSteps
                            ? null
                            : summarizeFileChange(
                                event,
                                toolCallResultEvent,
                                events,
                                workspace?.path,
                              );
                          const compactSearchTitle = verboseSteps
                            ? null
                            : getCompactSearchStepTitle(event, isTaskWorking && isLastChild);
                          const eventTitle = compactSearchTitle ? (
                            <span>{compactSearchTitle}</span>
                          ) : fileChange ? (
                            <FileChangeTitle
                              change={fileChange}
                              pending={!toolCallResultEvent && isTaskWorking}
                              workspacePath={workspace?.path}
                              onOpenViewer={openFileInPanel}
                            />
                          ) : (
                            renderEventTitle(
                              renderEvent,
                              workspace?.path,
                              openFileInPanel,
                              agentContext,
                              { summaryMode: !verboseSteps },
                            )
                          );
                          const eventRecapLine = getAgentLifecycleRecapLine(renderEvent);
                          const eventDetails = hasEventDetails(event)
                            ? renderEventDetails(event, voiceEnabled, markdownComponents, {
                                workspacePath: workspace?.path,
                                onOpenViewer: openFileInPanel,
                                onOpenAgent: onOpenChildAgentSidebar ?? onSelectChildTask,
                                onForkTaskSession: isBotConversation
                                  ? undefined
                                  : onForkTaskSessionFromEvent,
                                isLastAssistantMessage: isLastAssistantMessageEvent(
                                  event,
                                  lastAssistantMessage,
                                ),
                                hideVerificationSteps: true,
                                summaryMode: !verboseSteps,
                                task,
                                childTasks,
                                commandOutputSessions:
                                  commandOutputSessionsByInsertIndex.get(eventIndex) ?? [],
                                renderCommandOutput: renderCommandOutputs,
                              })
                            : undefined;

                          return (
                            <Fragment key={event.id || `event-${eventIndex}`}>
                              <StepFeed
                                title={
                                  typeof eventTitle === "string" ? (
                                    <DeferredMarkdown components={eventTitleMarkdownComponents}>
                                      {normalizeTimelineTitleMarkdownForDisplay(eventTitle)}
                                    </DeferredMarkdown>
                                  ) : (
                                    eventTitle
                                  )
                                }
                                titleTooltip={
                                  compactSearchTitle ??
                                  (typeof eventTitle === "string" ? eventTitle : undefined)
                                }
                                subtitle={eventRecapLine}
                                subtitleTooltip={eventRecapLine ?? undefined}
                                timeLabel={formatTime(event.timestamp)}
                                hideTime
                                indicator={resolveTimelineIndicator(renderEvent, {
                                  isTaskCompleted: !isTaskWorking,
                                })}
                                showConnectorAbove={showChildConnectorAbove}
                                showConnectorBelow={showChildConnectorBelow}
                                showBranchStub={shouldShowTimelineBranchStub(event)}
                                expandable={isExpandable}
                                expanded={isExpanded}
                                onToggle={
                                  isExpandable ? () => toggleEventExpanded(event.id) : undefined
                                }
                                details={
                                  isExpanded ? (
                                    <>
                                      {hasNestedChildren ? (
                                        <div className="timeline-step-child-groups">
                                          {nestedParallelChildren.map((child) => {
                                            const parallelDisclosureId = `parallel:${child.group.groupId}`;
                                            const parallelExpanded = resolveDisclosureExpanded({
                                              intent: getDisclosureIntent(
                                                disclosureIntents,
                                                "activity",
                                                parallelDisclosureId,
                                              ),
                                              isCurrent: false,
                                            });
                                            const childCmdSessions = (
                                              commandOutputSessionsByInsertIndex.get(
                                                child.eventIndex,
                                              ) ?? []
                                            ).filter(
                                              (s: CommandOutputSession) =>
                                                !inlineRunCommandSessionIds.has(s.id),
                                            );
                                            return (
                                              <Fragment
                                                key={child.event.id || `event-${child.eventIndex}`}
                                              >
                                                <ParallelGroupFeed
                                                  group={child.group}
                                                  timeLabel={formatTime(child.group.startedAt)}
                                                  formatTime={formatTime}
                                                  expanded={parallelExpanded}
                                                  onToggle={() =>
                                                    toggleDisclosureIntent(
                                                      "activity",
                                                      parallelDisclosureId,
                                                      false,
                                                    )
                                                  }
                                                  replay={isReplayMode}
                                                />
                                                {renderCommandOutputs(childCmdSessions)}
                                              </Fragment>
                                            );
                                          })}
                                        </div>
                                      ) : null}
                                      {eventDetails}
                                    </>
                                  ) : undefined
                                }
                                replay={isReplayMode}
                              />
                              {renderCommandOutputs(perEventCmdSessions)}
                            </Fragment>
                          );
                        });
                      })()}
                    </ActionBlock>
                  </Fragment>
                );
              }

              const event = item.event;
              const effectiveType = getEffectiveTaskEventType(event);
              const isUserMessage = effectiveType === "user_message";
              const isAssistantMessage = effectiveType === "assistant_message";
              const completionSummaryText = getCompletionSummaryText(event);
              const isCompletionSummaryMessage = completionSummaryText.length > 0;
              const commandOutputsAfterEvent =
                item.eventIndex === undefined
                  ? undefined
                  : commandOutputSessionsByInsertIndex.get(item.eventIndex);

              if (
                isConversationOnlySurface &&
                !isUserMessage &&
                !isAssistantMessage &&
                !isCompletionSummaryMessage
              ) {
                if (effectiveType === "llm_streaming" && isTaskWorking) {
                  const streamingText =
                    typeof event.payload?.text === "string"
                      ? event.payload.text
                      : typeof event.payload?.message === "string"
                        ? event.payload.message
                        : "";
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <div className="chat-message assistant-message">
                        <div className="chat-bubble assistant-bubble">
                          <div className="chat-bubble-content markdown-content">
                            <AssistantMessageContent
                              message={cleanAssistantMessageForDisplay(streamingText)}
                              markdownComponents={markdownComponents}
                              workspacePath={workspace?.path}
                              onOpenViewer={openFileInPanel}
                              taskId={event.taskId}
                              streaming
                            />
                          </div>
                        </div>
                      </div>
                    </Fragment>
                  );
                }
                if (commandOutputsAfterEvent && commandOutputsAfterEvent.length > 0) {
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }
                return null;
              }

              // Render user messages as chat bubbles on the right
              if (isUserMessage) {
                const isAgentInboundMessage = event.payload?.messageSource === "agent";
                if (
                  !isAgentInboundMessage &&
                  shouldSuppressInitialPromptUserEvent({
                    event,
                    initialPromptEventId,
                    trimmedPrompt,
                    taskCreatedAt: task?.createdAt,
                  })
                ) {
                  if (!commandOutputsAfterEvent || commandOutputsAfterEvent.length === 0) {
                    return null;
                  }
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }
                if (isAgentInboundMessage) {
                  const inboundMessage =
                    typeof event.payload?.message === "string"
                      ? normalizeInitialPromptText(event.payload.message)
                      : "Agent message";
                  const inboundReceipt = getAgentMessageReceipt(
                    event.payload as Record<string, unknown>,
                    { defaultStatus: "delivered" },
                  );
                  const inboundMessageId = inboundReceipt.messageId;
                  const inboundDeliveryStatus = inboundReceipt.status;
                  const inboundSenderTaskId = inboundReceipt.senderTaskId;
                  const senderLabel =
                    typeof event.payload?.senderLabel === "string" &&
                    event.payload.senderLabel.trim().length > 0
                      ? event.payload.senderLabel.trim()
                      : "Parent agent";
                  const inboundSenderMascot = isBotConversation
                    ? (botMascotForSender?.(senderLabel) ?? null)
                    : null;
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <div
                        className="agent-inbound-message"
                        data-message-id={inboundMessageId || undefined}
                        data-delivery-state={inboundDeliveryStatus || undefined}
                        data-sender-task-id={inboundSenderTaskId || undefined}
                        data-target-task-id={task?.id || undefined}
                      >
                        <div
                          className={`agent-inbound-message-label${inboundSenderMascot ? " with-avatar" : ""}`}
                        >
                          {inboundSenderMascot && <BotMessageAvatar mascot={inboundSenderMascot} />}
                          <span>Message from {senderLabel}</span>
                        </div>
                        <div
                          className={`agent-inbound-message-receipt agent-inbound-message-receipt-${inboundReceipt.status}`}
                          aria-label={`Message ${inboundReceipt.label.toLowerCase()}`}
                        >
                          <span>{inboundReceipt.label}</span>
                          {inboundReceipt.messageId ? (
                            <span
                              className="agent-message-receipt-id"
                              title={`Message ID ${inboundReceipt.messageId}`}
                            >
                              {` · ${inboundReceipt.shortMessageId}`}
                            </span>
                          ) : null}
                        </div>
                        <div className="agent-inbound-message-body markdown-content">
                          <UserMessageText
                            text={inboundMessage}
                            markdownComponents={markdownComponents}
                          />
                        </div>
                      </div>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }
                const rawMessage = event.payload?.message || "User message";
                const messageText =
                  typeof rawMessage === "string"
                    ? normalizeInitialPromptText(rawMessage)
                    : "User message";
                const messageIntegrationMentions = Array.isArray(event.payload?.integrationMentions)
                  ? (event.payload.integrationMentions as IntegrationMentionSelection[])
                  : task?.agentConfig?.integrationMentions;
                const quotedAssistantMessage = event.payload?.quotedAssistantMessage as
                  | QuotedAssistantMessage
                  | undefined;
                const surfaceOrigin = event.payload?.surfaceOrigin;
                const attachmentNames = extractAttachmentNames(rawMessage);
                const attachmentMetadata = parseUserMessageAttachmentMetadata(
                  event.payload?.images,
                );
                const nonImageAttachmentNames = getAttachmentNamesWithoutImagePreviews(
                  attachmentNames,
                  attachmentMetadata,
                );
                // Output of a code block the user ran: it already shows under the block, so the
                // message is one quiet line; the full text the agent got opens on demand.
                const codeBlockRun =
                  surfaceOrigin === "code_block" && typeof rawMessage === "string"
                    ? parseCodeBlockRunMessage(rawMessage)
                    : null;
                if (codeBlockRun) {
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <details className="code-block-run-sent">
                        <summary>
                          <span>Sent the output of</span>
                          <code>{codeBlockRun.command.split("\n")[0]}</code>
                          {codeBlockRun.exitCode !== null && codeBlockRun.exitCode !== 0 && (
                            <span>· exit code {codeBlockRun.exitCode}</span>
                          )}
                        </summary>
                        <pre className="code-block-run-sent-text">{rawMessage}</pre>
                      </details>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }
                return (
                  <Fragment key={event.id || `event-${item.eventIndex}`}>
                    <div className="chat-message user-message">
                      {(surfaceOrigin === "answer" ||
                        surfaceOrigin === "page" ||
                        surfaceOrigin === "browser_page") && (
                        <div className="user-message-surface-origin">
                          {surfaceOrigin === "page"
                            ? "Sent from an interactive page"
                            : surfaceOrigin === "browser_page"
                              ? "Sent from the browser"
                              : "Sent from a button in the answer"}
                        </div>
                      )}
                      <UserMessageImageGallery
                        attachments={attachmentMetadata}
                        workspacePath={workspace?.path}
                        onOpenViewer={openFileInPanel}
                      />
                      {quotedAssistantMessage?.message ? (
                        <div className="quoted-follow-up-shell">
                          <div className="quoted-follow-up-context">
                            <span className="quoted-follow-up-context-icon">↪</span>
                            <span className="quoted-follow-up-context-text">
                              {summarizeQuotedAssistantMessage(quotedAssistantMessage.message, 520)}
                            </span>
                          </div>
                          <div className="quoted-follow-up-reply markdown-content">
                            <UserMessageText
                              text={messageText}
                              integrationMentions={messageIntegrationMentions}
                              markdownComponents={markdownComponents}
                            />
                          </div>
                          {nonImageAttachmentNames.length > 0 && (
                            <div className="bubble-attachments quoted-follow-up-attachments">
                              {nonImageAttachmentNames.map((name, i) => (
                                <span className="bubble-attachment-chip" key={i}>
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                  >
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <path d="M14 2v6h6" />
                                  </svg>
                                  <span className="bubble-attachment-name" title={name}>
                                    {name}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <CollapsibleUserBubble>
                          <UserMessageText
                            text={messageText}
                            integrationMentions={messageIntegrationMentions}
                            markdownComponents={markdownComponents}
                          />
                          {nonImageAttachmentNames.length > 0 && (
                            <div className="bubble-attachments">
                              {nonImageAttachmentNames.map((name, i) => (
                                <span className="bubble-attachment-chip" key={i}>
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                  >
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <path d="M14 2v6h6" />
                                  </svg>
                                  <span className="bubble-attachment-name" title={name}>
                                    {name}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )}
                        </CollapsibleUserBubble>
                      )}
                      <MessageCopyButton text={messageText} />
                    </div>
                    {renderCommandOutputs(commandOutputsAfterEvent)}
                  </Fragment>
                );
              }

              // Render assistant messages as chat bubbles on the left
              if (isAssistantMessage || isCompletionSummaryMessage) {
                const messageText = isCompletionSummaryMessage
                  ? completionSummaryText
                  : event.payload?.message || "";
                const agentMessageProtocolReceipt = isBotConversation
                  ? parseAgentMessageProtocolResult(messageText)
                  : null;
                const cleanedMessageText = cleanAssistantMessageForDisplay(messageText);
                const inlineFrames = getTaskEventInlineFrames(event);
                const sourceUserMessage = getPreviousUserMessageText(events, item.eventIndex);
                const isLastAssistant = isLastAssistantMessageEvent(event, lastAssistantMessage);
                const isStepMessage = Boolean(event.id) && stepMessageEventIds.has(event.id);
                const assistantStatusLabel =
                  isLastAssistant && !isConversationOnlySurface
                    ? getAssistantBubbleStatusLabel(
                        task,
                        agentContext.getMessage("taskBlocked") || "Needs approval",
                        { event, events },
                      )
                    : "";
                const botMessageSender =
                  [
                    event.payload?.senderAgentRoleName,
                    event.payload?.fromAgentRoleName,
                    event.payload?.agentName,
                  ]
                    .find(
                      (value): value is string =>
                        typeof value === "string" && value.trim().length > 0,
                    )
                    ?.trim() ||
                  botName ||
                  "Bot";
                const isOwnBotMessage = botMessageSender === (botName || "Bot");
                // Teammates relaying through this bot show their own character when known.
                const senderMascot = isOwnBotMessage
                  ? botMascot
                  : (botMascotForSender?.(botMessageSender) ?? null);
                return (
                  <Fragment key={event.id || `event-${item.eventIndex}`}>
                    <div
                      className="chat-message assistant-message"
                      data-reply-source="assistant"
                      data-reply-event-id={event.id || undefined}
                      data-reply-task-id={event.taskId || undefined}
                    >
                      {agentMessageProtocolReceipt ? (
                        <div
                          className="agent-outbound-message-receipt"
                          data-message-id={agentMessageProtocolReceipt.messageId || undefined}
                          data-delivery-state={agentMessageProtocolReceipt.status}
                          aria-label={`Agent message ${agentMessageProtocolReceipt.label.toLowerCase()}`}
                        >
                          <div className="bot-message-attribution">
                            <BotMessageAvatar mascot={senderMascot} />
                            <span>{botMessageSender}</span>
                          </div>
                          <div
                            className={`agent-inbound-message-receipt agent-inbound-message-receipt-${agentMessageProtocolReceipt.status}`}
                          >
                            <span>{agentMessageProtocolReceipt.label}</span>
                            {agentMessageProtocolReceipt.messageId ? (
                              <span
                                className="agent-message-receipt-id"
                                title={`Message ID ${agentMessageProtocolReceipt.messageId}`}
                              >
                                {` · ${agentMessageProtocolReceipt.shortMessageId}`}
                              </span>
                            ) : null}
                          </div>
                          {agentMessageProtocolReceipt.error ? (
                            <div className="agent-outbound-message-error">
                              {agentMessageProtocolReceipt.error}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <div className="chat-bubble assistant-bubble">
                            {/* The title bar names this chat's bot; label only teammates relaying through it. */}
                            {isBotConversation && !isOwnBotMessage && (
                              <div className="bot-message-attribution">
                                <BotMessageAvatar mascot={senderMascot} />
                                <span>{botMessageSender}</span>
                              </div>
                            )}
                            {assistantStatusLabel && (
                              <div className="chat-bubble-header">
                                <span className="chat-status">{assistantStatusLabel}</span>
                              </div>
                            )}
                            <div className="chat-bubble-content markdown-content">
                              <AssistantMessageContent
                                message={cleanedMessageText}
                                markdownComponents={markdownComponents}
                                workspacePath={workspace?.path}
                                onOpenViewer={openFileInPanel}
                                taskId={event.taskId}
                                surfacesSuperseded={
                                  Boolean(event.id) && supersededSurfaceEventIds.has(event.id)
                                }
                                codeBlockRunTarget={isReplayMode ? undefined : codeBlockRunTarget}
                                messageKey={event.id || undefined}
                              />
                            </div>
                          </div>
                          {(inlineFrames.length > 0 || (isAssistantMessage && event.id)) && (
                            <div className="chat-inline-frames">
                              {inlineFrames.map((frame) => (
                                <MailComposeFrame
                                  key={`${frame.kind}:${frame.draftId}`}
                                  frame={frame}
                                />
                              ))}
                              {inlineFrames.length === 0 && isLastAssistant && !isTaskWorking && (
                                <AutoMailComposeFrame
                                  eventId={event.id}
                                  taskId={event.taskId}
                                  assistantMessage={cleanedMessageText}
                                  sourceUserMessage={sourceUserMessage}
                                  allowCreate={true}
                                />
                              )}
                            </div>
                          )}
                          {/* Icon-only actions; reply to a passage by selecting it (SelectionReplyPopover). */}
                          {!isStepMessage && (
                            <div className="message-actions">
                              <MessageCopyButton text={cleanedMessageText} />
                              <MessageSpeakButton text={messageText} voiceEnabled={voiceEnabled} />
                              {event.id &&
                                onForkTaskSessionFromEvent &&
                                !isBotConversation &&
                                isLastAssistant && (
                                  <MessageForkButton
                                    onFork={() => onForkTaskSessionFromEvent(event)}
                                  />
                                )}
                              {isLastAssistant && event.id && !isTaskWorking && (
                                <>
                                  <button
                                    type="button"
                                    className={`message-action-btn message-feedback-btn${messageFeedbackMap.get(event.id) === "accepted" ? " active" : ""}`}
                                    title="Helpful"
                                    aria-label="Helpful"
                                    aria-pressed={messageFeedbackMap.get(event.id) === "accepted"}
                                    onClick={() =>
                                      void handleMessageFeedback({
                                        messageId: event.id!,
                                        decision: "accepted",
                                      })
                                    }
                                  >
                                    <ThumbsUp size={15} strokeWidth={1.75} aria-hidden="true" />
                                  </button>
                                  <div
                                    ref={rejectMenuOpenFor === event.id ? rejectMenuRef : undefined}
                                    className="message-feedback-thumbdown-wrap"
                                  >
                                    <button
                                      type="button"
                                      className={`message-action-btn message-feedback-btn${messageFeedbackMap.get(event.id) === "rejected" ? " active" : ""}`}
                                      title="Not helpful"
                                      aria-label="Not helpful"
                                      aria-haspopup="menu"
                                      aria-expanded={rejectMenuOpenFor === event.id}
                                      onClick={() =>
                                        setRejectMenuOpenFor((v) =>
                                          v === event.id ? null : (event.id ?? null),
                                        )
                                      }
                                    >
                                      <ThumbsDown size={15} strokeWidth={1.75} aria-hidden="true" />
                                    </button>
                                    {rejectMenuOpenFor === event.id && (
                                      <div className="message-feedback-menu" role="menu">
                                        {(
                                          [
                                            ["incorrect", "Incorrect"],
                                            ["too_verbose", "Too verbose"],
                                            ["ignored_instructions", "Ignored instructions"],
                                            ["wrong_tone", "Wrong tone"],
                                            ["unsafe", "Unsafe / unwanted"],
                                          ] as const
                                        ).map(([reason, label]) => (
                                          <button
                                            key={reason}
                                            type="button"
                                            role="menuitem"
                                            className="message-feedback-reason"
                                            onClick={() =>
                                              void handleMessageFeedback({
                                                messageId: event.id!,
                                                decision: "rejected",
                                                reason,
                                              })
                                            }
                                          >
                                            {label}
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </>
                              )}
                              {isLastAssistant && isTaskWorking && !isBotConversation && (
                                <button
                                  type="button"
                                  className="message-action-btn bubble-feedback-toggle"
                                  onClick={() => setStepFeedbackOpen((o) => !o)}
                                  title="Give feedback"
                                  aria-label="Give feedback"
                                >
                                  <Ellipsis size={15} strokeWidth={1.75} aria-hidden="true" />
                                </button>
                              )}
                            </div>
                          )}
                          {/* Memory the reply used (hidden memory_used events, attributed in main). */}
                          {!isBotConversation && (
                            <MemoryUsedAffordance
                              taskId={task.id}
                              workspaceId={workspace?.id}
                              eventId={event.id}
                              onOpenMemoryHub={
                                onOpenSettings
                                  ? // App's settings opener accepts every Settings tab id.
                                    () => onOpenSettings("memory" as SettingsTab)
                                  : undefined
                              }
                            />
                          )}
                          {isLastAssistant && stepFeedbackOpen && !isBotConversation && (
                            <div className="bubble-feedback-panel">
                              {currentStep && (
                                <div className="bubble-feedback-step-label">
                                  {currentStep.description === "Thinking..." ? (
                                    <span className="thinking-title">
                                      Thinking
                                      <span className="thinking-ellipsis">
                                        <span>.</span>
                                        <span>.</span>
                                        <span>.</span>
                                      </span>
                                    </span>
                                  ) : (
                                    currentStep.description
                                  )}
                                </div>
                              )}
                              <div className="bubble-feedback-actions">
                                {currentStep && (
                                  <>
                                    <button
                                      className="bubble-feedback-btn skip"
                                      disabled={stepFeedbackSending}
                                      onClick={() => handleStepFeedback("skip")}
                                    >
                                      Skip
                                    </button>
                                    <button
                                      className="bubble-feedback-btn retry"
                                      disabled={stepFeedbackSending}
                                      onClick={() => handleStepFeedback("retry")}
                                    >
                                      Retry
                                    </button>
                                  </>
                                )}
                                <button
                                  className="bubble-feedback-btn stop"
                                  disabled={stepFeedbackSending || !currentStep}
                                  onClick={() => handleStepFeedback("stop")}
                                >
                                  Stop
                                </button>
                              </div>
                              <div className="bubble-feedback-input-row">
                                <input
                                  className="bubble-feedback-input"
                                  type="text"
                                  placeholder="Adjust direction…"
                                  value={stepFeedbackText}
                                  onChange={(e) => setStepFeedbackText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && stepFeedbackText.trim()) {
                                      handleStepFeedback("drift", stepFeedbackText.trim());
                                    }
                                  }}
                                  disabled={stepFeedbackSending}
                                />
                                <button
                                  className="bubble-feedback-btn drift"
                                  disabled={stepFeedbackSending || !stepFeedbackText.trim()}
                                  onClick={() =>
                                    handleStepFeedback("drift", stepFeedbackText.trim())
                                  }
                                >
                                  Send
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    {renderCommandOutputs(commandOutputsAfterEvent)}
                  </Fragment>
                );
              }

              const parallelGroup = parallelGroupsByAnchorEventId.get(event.id);
              if (suppressedParallelEventIds.has(event.id) && !parallelGroup) {
                if (commandOutputsAfterEvent && commandOutputsAfterEvent.length > 0) {
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }
                return null;
              }

              if (!parallelGroup && !shouldRenderTimelineEventInStepFeed(event)) {
                // Even if we're not showing steps, we may still need to render command output.
                if (commandOutputsAfterEvent && commandOutputsAfterEvent.length > 0) {
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }
                return null;
              }

              const indicatorPosition = stepFeedTimelineIndexPosition.get(timelineIndex);
              const showConnectorAbove =
                typeof indicatorPosition === "number" && indicatorPosition > 0;
              const showConnectorBelow =
                typeof indicatorPosition === "number" && indicatorPosition < stepFeedEventCount - 1;

              if (parallelGroup) {
                const parallelDisclosureId = `parallel:${parallelGroup.groupId}`;
                const parallelExpanded = resolveDisclosureExpanded({
                  intent: getDisclosureIntent(disclosureIntents, "activity", parallelDisclosureId),
                  isCurrent: false,
                });
                return (
                  <Fragment key={event.id || `event-${item.eventIndex}`}>
                    <ParallelGroupFeed
                      group={parallelGroup}
                      timeLabel={formatTime(parallelGroup.startedAt)}
                      formatTime={formatTime}
                      showConnectorAbove={showConnectorAbove}
                      showConnectorBelow={showConnectorBelow}
                      expanded={parallelExpanded}
                      onToggle={() =>
                        toggleDisclosureIntent("activity", parallelDisclosureId, false)
                      }
                      replay={isReplayMode}
                    />
                    {renderCommandOutputs(commandOutputsAfterEvent)}
                  </Fragment>
                );
              }

              const isExpandable = hasEventDetails(event);
              const isExpanded = isEventExpanded(event);
              const toolCallResultEvent2 = toolCallPairing.completions.get(event.id);
              const renderEvent2 = toolCallResultEvent2 ?? event;
              const eventTitle = renderEventTitle(
                renderEvent2,
                workspace?.path,
                openFileInPanel,
                agentContext,
                { summaryMode: !verboseSteps },
              );
              const eventRecapLine = getAgentLifecycleRecapLine(renderEvent2);

              return (
                <Fragment key={event.id || `event-${item.eventIndex}`}>
                  <StepFeed
                    title={
                      typeof eventTitle === "string" ? (
                        <DeferredMarkdown components={eventTitleMarkdownComponents}>
                          {normalizeTimelineTitleMarkdownForDisplay(eventTitle)}
                        </DeferredMarkdown>
                      ) : (
                        eventTitle
                      )
                    }
                    titleTooltip={typeof eventTitle === "string" ? eventTitle : undefined}
                    subtitle={eventRecapLine}
                    subtitleTooltip={eventRecapLine ?? undefined}
                    timeLabel={formatTime(event.timestamp)}
                    hideTime
                    indicator={resolveTimelineIndicator(renderEvent2, {
                      isTaskCompleted: !isTaskWorking,
                    })}
                    showConnectorAbove={showConnectorAbove}
                    showConnectorBelow={showConnectorBelow}
                    showBranchStub={shouldShowTimelineBranchStub(event)}
                    expandable={isExpandable}
                    expanded={isExpanded}
                    onToggle={isExpandable ? () => toggleEventExpanded(event.id) : undefined}
                    replay={isReplayMode}
                    details={
                      isExpanded
                        ? renderEventDetails(event, voiceEnabled, markdownComponents, {
                            workspacePath: workspace?.path,
                            onOpenViewer: openFileInPanel,
                            onOpenAgent: onOpenChildAgentSidebar ?? onSelectChildTask,
                            isLastAssistantMessage: isLastAssistantMessageEvent(
                              event,
                              lastAssistantMessage,
                            ),
                            hideVerificationSteps: true,
                            summaryMode: !verboseSteps,
                            task,
                            childTasks,
                            commandOutputSessions: commandOutputsAfterEvent ?? [],
                            renderCommandOutput: renderCommandOutputs,
                          })
                        : undefined
                    }
                  />
                  {renderCommandOutputs(
                    isExpanded &&
                      effectiveType === "tool_call" &&
                      event.payload?.tool === "run_command" &&
                      commandOutputsAfterEvent &&
                      commandOutputsAfterEvent.length > 0
                      ? []
                      : (commandOutputsAfterEvent ?? []),
                  )}
                </Fragment>
              );
            };

            const getRenderedFeedRow = (row: TaskFeedRow) => {
              const signature = getRowRenderSignature(row);
              const cached = feedRowRenderCacheRef.current.get(row.key);
              if (cached && cached.signature === signature) {
                return cached.node;
              }

              recordRendererRender("MainContent.feedRow", row.key, rendererPerfLoggingEnabled);
              const node = renderFeedRow(row);
              feedRowRenderCacheRef.current.set(row.key, { signature, node });
              return node;
            };

            return (
              <TaskConversationRenderedRows
                taskId={task?.id}
                taskSwitchId={taskSwitchId}
                hasMoreTimelineHistory={Boolean(hasMoreTimelineHistory)}
                isLoadingTimelineHistory={Boolean(isLoadingTimelineHistory)}
                timelineHistoryError={timelineHistoryError}
                onLoadMoreTimelineHistory={onLoadMoreTimelineHistory}
                rendererPerfLoggingEnabled={Boolean(rendererPerfLoggingEnabled)}
                visibleFeedRows={visibleFeedRows}
                isChatTask={isConversationOnlySurface}
                isTaskWorking={isTaskWorking}
                task={task}
                formatTime={formatTime}
                isReplayMode={isReplayMode}
                transcriptMode={feedTranscriptMode}
                canReturnToLiveView={defaultTranscriptMode === "live"}
                onBackToLiveView={returnToDefaultTranscript}
                reasoningPanel={
                  showReasoningPanel ? (
                    <AgentReasoningPanel currentStep={currentStep} state={reasoningPanelState} />
                  ) : null
                }
                reasoningPanelSignature={reasoningPanelSignature}
                mainBodyRef={mainBodyRef}
                timelineRef={timelineRef}
                getRenderedFeedRow={getRenderedFeedRow}
                newActivityCount={newActivityCount}
                onNewActivityCountChange={onNewActivityCountChange}
              />
            );
          })()}
      </>
    ),
    [
      agentContext,
      activityGroupsById,
      childEvents,
      childTasks,
      collaborativeRun,
      commandOutputSessionsByInsertIndex,
      currentStep,
      eventTitleMarkdownComponents,
      events,
      expandedArtifactStacks,
      disclosureIntents,
      toggleDisclosureIntent,
      expandArtifactStack,
      handleCanvasClose,
      handleMessageFeedback,
      handleStepFeedback,
      hasMoreTimelineHistory,
      isLoadingTimelineHistory,
      timelineHistoryError,
      isBotConversation,
      botName,
      botMascot,
      isConversationOnlySurface,
      isTaskWorking,
      isReplayMode,
      markdownComponents,
      mainBodyRef,
      messageFeedbackMap,
      onOpenBrowserView,
      onOpenSpreadsheetArtifact,
      onOpenDocumentArtifact,
      onOpenPresentationArtifact,
      onOpenWebArtifact,
      onSelectChildTask,
      onOpenChildAgentSidebar,
      onViewTaskOutputs,
      onLoadMoreTimelineHistory,
      parallelGroupsByAnchorEventId,
      rejectMenuOpenFor,
      rejectMenuRef,
      renderCommandOutputs,
      setStepFeedbackOpen,
      setStepFeedbackText,
      setViewerFilePath,
      openFileInPanel,
      stepFeedbackOpen,
      stepFeedbackSending,
      stepFeedbackText,
      suppressedParallelEventIds,
      task,
      task?.status,
      task?.terminalStatus,
      feedRows,
      transcriptMode,
      feedTranscriptMode,
      defaultTranscriptMode,
      lastActionBlockTimelineIndex,
      lastAssistantMessage,
      stepMessageEventIds,
      returnToDefaultTranscript,
      timelineItems,
      timelineRef,
      toggleEventExpanded,
      visibleFeedRows,
      verboseSteps,
      voiceEnabled,
      wrappingUp,
      onWrapUp,
      workspace,
      workspace?.path,
    ],
  );

  return conversationFlow;
}, areTaskConversationFlowPropsEqual);

function areTaskConversationFlowPropsEqual(
  prev: TaskConversationFlowProps,
  next: TaskConversationFlowProps,
): boolean {
  return (
    prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled &&
    prev.taskSwitchId === next.taskSwitchId &&
    prev.hasMoreTimelineHistory === next.hasMoreTimelineHistory &&
    prev.isLoadingTimelineHistory === next.isLoadingTimelineHistory &&
    prev.timelineHistoryError === next.timelineHistoryError &&
    prev.onLoadMoreTimelineHistory === next.onLoadMoreTimelineHistory &&
    prev.botName === next.botName &&
    prev.botIcon === next.botIcon &&
    prev.botMascotForSender === next.botMascotForSender &&
    prev.agentContext === next.agentContext &&
    prev.activityGroupsById === next.activityGroupsById &&
    prev.childEvents === next.childEvents &&
    prev.childTasks === next.childTasks &&
    prev.collaborativeRun === next.collaborativeRun &&
    prev.commandOutputSessionsByInsertIndex === next.commandOutputSessionsByInsertIndex &&
    prev.currentStep?.description === next.currentStep?.description &&
    prev.eventTitleMarkdownComponents === next.eventTitleMarkdownComponents &&
    prev.events === next.events &&
    prev.disclosureIntents === next.disclosureIntents &&
    prev.toggleDisclosureIntent === next.toggleDisclosureIntent &&
    prev.isChatTask === next.isChatTask &&
    prev.task?.agentConfig?.botConversation === next.task?.agentConfig?.botConversation &&
    prev.isTaskWorking === next.isTaskWorking &&
    prev.isReplayMode === next.isReplayMode &&
    prev.codeBlockRunTarget === next.codeBlockRunTarget &&
    prev.defaultTranscriptMode === next.defaultTranscriptMode &&
    prev.transcriptMode === next.transcriptMode &&
    prev.lastAssistantMessage?.id === next.lastAssistantMessage?.id &&
    prev.initialPromptEventId === next.initialPromptEventId &&
    prev.markdownComponents === next.markdownComponents &&
    prev.messageFeedbackMap === next.messageFeedbackMap &&
    prev.mainBodyRef === next.mainBodyRef &&
    prev.parallelGroupsByAnchorEventId === next.parallelGroupsByAnchorEventId &&
    prev.rejectMenuOpenFor === next.rejectMenuOpenFor &&
    prev.rejectMenuRef === next.rejectMenuRef &&
    prev.stepFeedbackOpen === next.stepFeedbackOpen &&
    prev.stepFeedbackSending === next.stepFeedbackSending &&
    prev.stepFeedbackText === next.stepFeedbackText &&
    prev.suppressedParallelEventIds === next.suppressedParallelEventIds &&
    prev.task?.id === next.task?.id &&
    prev.task?.status === next.task?.status &&
    prev.task?.terminalStatus === next.task?.terminalStatus &&
    prev.task?.prompt === next.task?.prompt &&
    prev.task?.userPrompt === next.task?.userPrompt &&
    prev.task?.rawPrompt === next.task?.rawPrompt &&
    getIntegrationMentionsSignature(prev.task?.agentConfig?.integrationMentions) ===
      getIntegrationMentionsSignature(next.task?.agentConfig?.integrationMentions) &&
    prev.timelineItems === next.timelineItems &&
    prev.timelineRef === next.timelineRef &&
    prev.verboseSteps === next.verboseSteps &&
    prev.voiceEnabled === next.voiceEnabled &&
    prev.wrappingUp === next.wrappingUp &&
    prev.onWrapUp === next.onWrapUp &&
    prev.workspace?.path === next.workspace?.path &&
    prev.toolCallPairing?.completions === next.toolCallPairing?.completions &&
    prev.toolCallPairing?.claimedResultIds === next.toolCallPairing?.claimedResultIds &&
    prev.hasEventDetails === next.hasEventDetails &&
    prev.isEventExpanded === next.isEventExpanded &&
    prev.shouldRenderTimelineEventInStepFeed === next.shouldRenderTimelineEventInStepFeed &&
    prev.formatTime === next.formatTime &&
    prev.renderCommandOutputs === next.renderCommandOutputs &&
    prev.toggleEventExpanded === next.toggleEventExpanded &&
    prev.returnToDefaultTranscript === next.returnToDefaultTranscript &&
    prev.onOpenBrowserView === next.onOpenBrowserView &&
    prev.onOpenSpreadsheetArtifact === next.onOpenSpreadsheetArtifact &&
    prev.onOpenDocumentArtifact === next.onOpenDocumentArtifact &&
    prev.onOpenPresentationArtifact === next.onOpenPresentationArtifact &&
    prev.onOpenWebArtifact === next.onOpenWebArtifact &&
    prev.onForkTaskSessionFromEvent === next.onForkTaskSessionFromEvent &&
    prev.onSelectChildTask === next.onSelectChildTask &&
    prev.onOpenChildAgentSidebar === next.onOpenChildAgentSidebar &&
    prev.onViewTaskOutputs === next.onViewTaskOutputs
  );
}

/**
 * Compact rows read searches as finished steps ("Searched for X"), in plain text so
 * glob patterns aren't taken for markdown emphasis.
 */
function getCompactSearchStepTitle(event: TaskEvent, running: boolean): string | null {
  if (getEffectiveTaskEventType(event) !== "tool_call") return null;
  const tool = event.payload?.tool;
  const input =
    event.payload?.input && typeof event.payload.input === "object" ? event.payload.input : {};
  const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
  const query = typeof input.query === "string" ? input.query.trim() : pattern;
  if ((tool === "grep" && pattern) || (tool === "search_files" && query)) {
    return `${running ? "Searching" : "Searched"} for ${truncateLabel(tool === "grep" ? pattern : query, 64)}`;
  }
  if (tool === "glob" && pattern) {
    return `${running ? "Finding" : "Found"} files matching ${truncateLabel(pattern, 64)}`;
  }
  return null;
}
