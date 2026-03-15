import type { TaskEvent } from "../../../shared/types";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";

export interface ActionBlockSummary {
  /** Short summary for collapsed header, e.g. "Explored 7 files, 6 searches" */
  summary: string;
  /** Total number of actions in the block */
  actionCount: number;
  /** Number of tool calls in the block */
  toolCallCount: number;
  /** Duration in ms from first to last event in the block */
  durationMs: number;
  /** Output tokens used in the block (from llm_usage deltas) */
  outputTokens: number;
}

/**
 * Build a human-readable summary for a block of tool/step events.
 * @param events - Events in this block (used for summary, step count, time range)
 * @param allEventsForLookup - Optional full event list for tool/token lookup when block events are filtered (e.g. summary mode excludes tool_call, llm_usage)
 */
export function buildActionBlockSummary(
  events: TaskEvent[],
  allEventsForLookup?: TaskEvent[],
): ActionBlockSummary {
  const toolCounts = new Map<string, number>();
  let stepCount = 0;

  const blockStart = events[0]?.timestamp ?? 0;
  let blockEnd = events[events.length - 1]?.timestamp ?? 0;

  // In summary mode, block may have few events; expand blockEnd to just before next boundary so we capture all tool calls and llm_usage in that phase
  if (allEventsForLookup && allEventsForLookup.length > 0 && blockStart > 0) {
    const nextBoundary = allEventsForLookup.find((e) => {
      const ts = e.timestamp ?? 0;
      if (ts <= blockStart) return false;
      const t = getEffectiveTaskEventType(e);
      return t === "user_message" || t === "assistant_message";
    });
    if (nextBoundary) {
      const nextTs = (nextBoundary.timestamp ?? 0) - 1;
      if (nextTs > blockEnd) blockEnd = nextTs;
    }
  }

  // In summary mode, block events may exclude tool_call and llm_usage; use full events in time range
  const eventsInRange =
    allEventsForLookup && allEventsForLookup.length > 0 && (blockStart > 0 || blockEnd > 0)
      ? allEventsForLookup.filter(
          (e) => (e.timestamp ?? 0) >= blockStart && (e.timestamp ?? 0) <= blockEnd,
        )
      : events;

  for (const event of events) {
    const effectiveType = getEffectiveTaskEventType(event);
    if (
      effectiveType === "step_started" ||
      effectiveType === "step_completed" ||
      effectiveType === "step_failed" ||
      event.type === "timeline_step_started" ||
      event.type === "timeline_step_updated" ||
      event.type === "timeline_step_finished"
    ) {
      stepCount += 1;
    }
  }

  for (const event of eventsInRange) {
    const effectiveType = getEffectiveTaskEventType(event);
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const tool = typeof (payload as Record<string, unknown>).tool === "string"
      ? ((payload as Record<string, unknown>).tool as string)
      : "";
    if (effectiveType === "tool_call" && tool) {
      toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
    }
  }

  const totalTools = Array.from(toolCounts.values()).reduce((a, b) => a + b, 0);

  const parts: string[] = [];
  const readFiles = (toolCounts.get("read_file") || 0) + (toolCounts.get("list_directory") || 0);
  const searches = (toolCounts.get("grep") || 0) + (toolCounts.get("search_files") || 0);
  const writes = (toolCounts.get("write_file") || 0) + (toolCounts.get("edit_file") || 0);

  if (readFiles > 0 && searches > 0) {
    parts.push(`Explored ${readFiles} file${readFiles === 1 ? "" : "s"}, ${searches} search${searches === 1 ? "" : "es"}`);
  } else if (readFiles > 0) {
    parts.push(`${readFiles} file${readFiles === 1 ? "" : "s"} read`);
  } else if (searches > 0) {
    parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
  }
  if (writes > 0) parts.push(`${writes} file${writes === 1 ? "" : "s"} modified`);
  if (stepCount > 0 && parts.length === 0) parts.push(`${stepCount} step${stepCount === 1 ? "" : "s"}`);

  const summary =
    parts.length > 0
      ? parts.join(", ")
      : totalTools > 0
        ? `${totalTools} action${totalTools === 1 ? "" : "s"}`
        : `${events.length} step${events.length === 1 ? "" : "s"}`;

  // Duration: use full events in range when available for more accurate span (summary mode may have fewer block events)
  const rangeEvents = eventsInRange.length >= 2 ? eventsInRange : events;
  const durationMs =
    rangeEvents.length >= 2
      ? Math.max(
          0,
          (rangeEvents[rangeEvents.length - 1].timestamp ?? 0) - (rangeEvents[0].timestamp ?? 0),
        )
      : 0;

  // Sum output tokens from llm_usage events in the block's time range
  let outputTokens = 0;
  const llmUsageEvents =
    allEventsForLookup && allEventsForLookup.length > 0
      ? allEventsForLookup.filter(
          (e) => e.type === "llm_usage" && (e.timestamp ?? 0) >= blockStart && (e.timestamp ?? 0) <= blockEnd,
        )
      : events.filter((e) => e.type === "llm_usage");
  for (const event of llmUsageEvents) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const delta = (payload as Record<string, unknown>).delta;
    const deltaObj = delta && typeof delta === "object" ? (delta as Record<string, unknown>) : {};
    const out = typeof deltaObj.outputTokens === "number" ? deltaObj.outputTokens : 0;
    outputTokens += Number.isFinite(out) ? out : 0;
  }

  return {
    summary,
    actionCount: totalTools + stepCount || events.length,
    toolCallCount: totalTools,
    durationMs,
    outputTokens,
  };
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1_000)}k`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toLocaleString();
}

interface ActionBlockProps {
  blockId: string;
  summary: string;
  toolCallCount: number;
  durationMs: number;
  outputTokens: number;
  isActive: boolean;
  expanded: boolean;
  onToggle: () => void;
  showConnectorAbove?: boolean;
  showConnectorBelow?: boolean;
  children: React.ReactNode;
}

/**
 * Collapsible block for actions (tool calls, steps) between assistant messages.
 * Cursor-style: expanded while active, collapsed when next assistant message arrives.
 */
export function ActionBlock({
  blockId,
  summary,
  toolCallCount,
  durationMs,
  outputTokens,
  isActive,
  expanded,
  onToggle,
  showConnectorAbove = false,
  showConnectorBelow = false,
  children,
}: ActionBlockProps) {
  return (
    <div className={`action-block timeline-event ${expanded ? "expanded" : "collapsed"} ${isActive ? "active" : ""}`}>
      <div className="event-indicator action-block-indicator">
        {showConnectorAbove && <span className="event-connector event-connector-above" aria-hidden="true" />}
        <span className="action-block-dot" aria-hidden="true" />
        {showConnectorBelow && <span className="event-connector event-connector-below" aria-hidden="true" />}
      </div>
      <div className="action-block-body event-content">
      <button
        type="button"
        className="action-block-header"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`action-block-content-${blockId}`}
        id={`action-block-toggle-${blockId}`}
      >
        <span className="action-block-chevron" aria-hidden="true">
          {expanded ? (
            <ChevronDown size={14} strokeWidth={2.5} />
          ) : (
            <ChevronRight size={14} strokeWidth={2.5} />
          )}
        </span>
        <span className="action-block-summary">{summary}</span>
        <span className="action-block-meta">
          {toolCallCount > 0 && (
            <span className="action-block-count">
              {toolCallCount} tool call{toolCallCount === 1 ? "" : "s"}
            </span>
          )}
          {(durationMs > 0 || outputTokens > 0) && (
            <span className="action-block-stats">
              {toolCallCount > 0 && (durationMs > 0 || outputTokens > 0) && (
                <span className="action-block-stats-sep"> · </span>
              )}
              {durationMs > 0 && formatDurationMs(durationMs)}
              {durationMs > 0 && outputTokens > 0 && (
                <span className="action-block-stats-sep"> · </span>
              )}
              {outputTokens > 0 && (
                <span title="Output tokens">↓ {formatTokenCount(outputTokens)} tokens</span>
              )}
            </span>
          )}
        </span>
      </button>
      <div
        id={`action-block-content-${blockId}`}
        className="action-block-content"
        role="region"
        aria-labelledby={`action-block-toggle-${blockId}`}
        hidden={!expanded}
      >
        {expanded && <div className="action-block-events">{children}</div>}
      </div>
      </div>
    </div>
  );
}
