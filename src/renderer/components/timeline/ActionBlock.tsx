import { useCallback, useEffect, useState } from "react";
import type { TaskEvent } from "../../../shared/types";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Globe2,
  PencilLine,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import { isBrowserToolName } from "../../utils/timeline-tool-labels";

export type ActionBlockIconKind =
  | "explore"
  | "search"
  | "command"
  | "write"
  | "web"
  | "verify"
  | "approval"
  | "generate"
  | "work";

export interface ActionBlockSummary {
  /** Short summary for collapsed header, e.g. "Explored 7 files, 6 searches" */
  summary: string;
  /** Semantic icon category for the collapsed header. */
  iconKind: ActionBlockIconKind;
  /** Total number of actions in the block */
  actionCount: number;
  /** Number of steps in the block */
  stepCount: number;
  /** Number of tool calls in the block */
  toolCallCount: number;
  /** Duration in ms from first to last event in the block */
  durationMs: number;
  /** Output tokens used in the block (from llm_usage deltas) */
  outputTokens: number;
}

export interface BuildActionBlockSummaryOptions {
  /** When true, use in-progress phrasing (e.g. "Exploring files…") instead of past-tense totals */
  isActive?: boolean;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getToolName(event: TaskEvent): string {
  const payload = asObject(event.payload);
  return typeof payload.tool === "string" ? payload.tool.trim() : "";
}

function getLegacyEventType(event: TaskEvent): string {
  if (typeof event.legacyType === "string" && event.legacyType.trim()) {
    return event.legacyType.trim();
  }
  const payload = asObject(event.payload);
  return typeof payload.legacyType === "string" ? payload.legacyType.trim() : "";
}

function isToolOutcomeEvent(event: TaskEvent): boolean {
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "tool_result" || effectiveType === "tool_error") return true;

  // Timeline-v2 represents tool errors as timeline_error while retaining the
  // legacy type. Keep this compatibility path so blocked writes/lookups are
  // treated as outcomes instead of falling back to attempted tool calls.
  return event.type === "timeline_error" && getLegacyEventType(event) === "tool_error";
}

function isSuccessfulToolOutcome(event: TaskEvent): boolean {
  const effectiveType = getEffectiveTaskEventType(event);
  if (
    !isToolOutcomeEvent(event) ||
    effectiveType === "tool_error" ||
    getLegacyEventType(event) === "tool_error"
  ) {
    return false;
  }

  const payload = asObject(event.payload);
  const envelope = asObject(payload.envelope);
  const envelopeStatus = String(envelope.status || "")
    .trim()
    .toLowerCase();
  if (["error", "failed", "blocked", "cancelled"].includes(envelopeStatus)) return false;
  if (
    [event.status, payload.status]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .some((value) => ["error", "failed", "blocked", "cancelled"].includes(value))
  ) {
    return false;
  }
  if (payload.success === false || payload.isError === true || payload.is_error === true) {
    return false;
  }

  const result = asObject(payload.result);
  return result.success !== false && result.blocked !== true && !result.error;
}

function collectStepActionText(event: TaskEvent): string {
  const payload = asObject(event.payload);
  const step = asObject(payload.step);
  return [
    typeof payload.message === "string" ? payload.message : "",
    typeof payload.description === "string" ? payload.description : "",
    typeof payload.action === "string" ? payload.action : "",
    typeof step.description === "string" ? step.description : "",
    typeof step.action === "string" ? step.action : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isGenerativeStepText(text: string): boolean {
  return /\b(generate|generating|generated|draft|drafting|compose|composing|synthesize|synthesizing)\b/.test(
    text,
  );
}

/**
 * Build a human-readable summary for a block of tool/step events.
 * @param events - Events in this block (used for summary, step count, time range)
 * @param allEventsForLookup - Optional full event list for tool/token lookup when block events are filtered (e.g. summary mode excludes tool_call, llm_usage)
 */
export function buildActionBlockSummary(
  events: TaskEvent[],
  allEventsForLookup?: TaskEvent[],
  options?: BuildActionBlockSummaryOptions,
): ActionBlockSummary {
  const isActive = options?.isActive === true;
  const attemptedToolCounts = new Map<string, number>();
  const successfulToolCounts = new Map<string, number>();
  const toolOutcomeSeen = new Set<string>();
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
    const tool = getToolName(event);
    if (effectiveType === "tool_call" && tool) {
      attemptedToolCounts.set(tool, (attemptedToolCounts.get(tool) || 0) + 1);
    } else if (isToolOutcomeEvent(event) && tool) {
      toolOutcomeSeen.add(tool);
      if (isSuccessfulToolOutcome(event)) {
        successfulToolCounts.set(tool, (successfulToolCounts.get(tool) || 0) + 1);
      }
    }
  }

  // Active blocks describe work currently being attempted. Completed blocks should
  // describe effects that actually succeeded; a failed/blocked tool call must not
  // appear as a completed file write or web lookup. Keep the historical fallback
  // for old events that only persisted tool_call records and have no outcome event.
  const summaryToolCounts = new Map<string, number>();
  const toolNames = new Set([...attemptedToolCounts.keys(), ...successfulToolCounts.keys()]);
  for (const tool of toolNames) {
    const attempted = attemptedToolCounts.get(tool) || 0;
    const successful = successfulToolCounts.get(tool) || 0;
    summaryToolCounts.set(
      tool,
      !isActive && toolOutcomeSeen.has(tool) ? successful : Math.max(attempted, successful),
    );
  }

  const totalTools = Array.from(attemptedToolCounts.values()).reduce((a, b) => a + b, 0);
  const summaryTotalTools = Array.from(summaryToolCounts.values()).reduce((a, b) => a + b, 0);

  const parts: string[] = [];
  const readFiles =
    (summaryToolCounts.get("read_file") || 0) +
    (summaryToolCounts.get("read_files") || 0) +
    (summaryToolCounts.get("list_directory") || 0) +
    (summaryToolCounts.get("glob") || 0);
  const searches =
    (summaryToolCounts.get("grep") || 0) +
    (summaryToolCounts.get("search_files") || 0) +
    (summaryToolCounts.get("context_grep") || 0);
  const createdFiles = summaryToolCounts.get("write_file") || 0;
  const editedFiles = summaryToolCounts.get("edit_file") || 0;
  const writes = createdFiles + editedFiles;
  const commands =
    (summaryToolCounts.get("run_command") || 0) +
    (summaryToolCounts.get("run_skill") || 0) +
    (summaryToolCounts.get("execute_code") || 0);
  const webLookups =
    (summaryToolCounts.get("web_fetch") || 0) +
    (summaryToolCounts.get("web_search") || 0) +
    (summaryToolCounts.get("http_request") || 0) +
    Array.from(summaryToolCounts.entries()).reduce(
      (sum, [tool, count]) => sum + (isBrowserToolName(tool) ? count : 0),
      0,
    );
  let verificationSteps = 0;
  let generativeSteps = 0;
  for (const event of events) {
    const effectiveType = getEffectiveTaskEventType(event);
    if (
      effectiveType === "verification_started" ||
      effectiveType === "verification_passed" ||
      effectiveType === "verification_failed" ||
      effectiveType === "verification_pending_user_action"
    ) {
      verificationSteps += 1;
    }
    if (
      effectiveType === "step_started" ||
      effectiveType === "step_completed" ||
      event.type === "timeline_step_started" ||
      event.type === "timeline_step_updated" ||
      event.type === "timeline_step_finished"
    ) {
      if (isGenerativeStepText(collectStepActionText(event))) {
        generativeSteps += 1;
      }
    }
  }
  let approvedRequests = 0;
  for (const event of events) {
    const effectiveType = getEffectiveTaskEventType(event);
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const payloadStatus =
      typeof (payload as Record<string, unknown>).status === "string"
        ? ((payload as Record<string, unknown>).status as string)
        : "";
    if (
      effectiveType === "approval_granted" ||
      event.type === "approval_granted" ||
      event.legacyType === "approval_granted" ||
      payloadStatus === "approved"
    ) {
      approvedRequests += 1;
    }
  }

  const iconKind: ActionBlockIconKind =
    approvedRequests > 0
      ? "approval"
      : writes > 0
        ? "write"
        : commands > 0
          ? "command"
          : searches > 0 || readFiles > 0
            ? "search"
            : webLookups > 0
              ? "web"
              : verificationSteps > 0
                ? "verify"
                : generativeSteps > 0
                  ? "generate"
                  : "work";

  if (isActive) {
    if (approvedRequests > 0) {
      parts.push("Approved requests…");
    }
    if (readFiles > 0 && searches > 0) {
      parts.push("Exploring files and searching the codebase…");
    } else if (readFiles > 0) {
      parts.push("Reading files…");
    } else if (searches > 0) {
      parts.push("Searching the codebase…");
    }
    if (webLookups > 0) {
      parts.push("Gathering web sources…");
    }
    if (writes > 0) {
      if (createdFiles > 0 && editedFiles === 0) {
        parts.push("Creating files…");
      } else {
        parts.push("Editing files…");
      }
    }
    if (commands > 0) {
      parts.push("Running commands…");
    }
    if (parts.length === 0 && stepCount > 0) {
      parts.push("Working…");
    } else if (parts.length === 0 && totalTools > 0) {
      parts.push("Working…");
    }
  } else {
    if (approvedRequests > 0) {
      parts.push(`Approved ${approvedRequests} request${approvedRequests === 1 ? "" : "s"}`);
    }
    if (createdFiles > 0 && editedFiles > 0) {
      parts.push(
        `Created ${createdFiles} file${createdFiles === 1 ? "" : "s"}, edited ${editedFiles} file${editedFiles === 1 ? "" : "s"}`,
      );
    } else if (createdFiles > 0) {
      parts.push(`Created ${createdFiles} file${createdFiles === 1 ? "" : "s"}`);
    } else if (editedFiles > 0) {
      parts.push(`Edited ${editedFiles} file${editedFiles === 1 ? "" : "s"}`);
    }
    if (readFiles > 0 && searches > 0) {
      parts.push(
        `Explored ${readFiles} file${readFiles === 1 ? "" : "s"}, ${searches} search${searches === 1 ? "" : "es"}`,
      );
    } else if (readFiles > 0) {
      parts.push(`Explored ${readFiles} file${readFiles === 1 ? "" : "s"}`);
    } else if (searches > 0) {
      parts.push(`Searched ${searches} time${searches === 1 ? "" : "s"}`);
    }
    if (webLookups > 0) {
      parts.push(`${webLookups} web lookup${webLookups === 1 ? "" : "s"}`);
    }
    if (commands > 0) {
      parts.push(
        `${parts.length > 0 ? "ran" : "Ran"} ${commands} command${commands === 1 ? "" : "s"}`,
      );
    }
    if (stepCount > 0 && parts.length === 0)
      parts.push(`${stepCount} step${stepCount === 1 ? "" : "s"}`);
  }

  const summary =
    parts.length > 0
      ? parts.join(", ")
      : totalTools > 0
        ? `${summaryTotalTools > 0 ? summaryTotalTools : totalTools} action${(summaryTotalTools > 0 ? summaryTotalTools : totalTools) === 1 ? "" : "s"}`
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
          (e) =>
            e.type === "llm_usage" &&
            (e.timestamp ?? 0) >= blockStart &&
            (e.timestamp ?? 0) <= blockEnd,
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
    iconKind,
    actionCount: totalTools + stepCount || events.length,
    stepCount,
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
  iconKind: ActionBlockIconKind;
  stepCount: number;
  toolCallCount: number;
  durationMs: number;
  outputTokens: number;
  isActive: boolean;
  expanded: boolean;
  onToggle: () => void;
  showConnectorAbove?: boolean;
  showConnectorBelow?: boolean;
  /** Last step label shown centered in the header when collapsed */
  lastStepLabel?: string;
  children: React.ReactNode;
}

const ACTION_BLOCK_ICONS: Record<ActionBlockIconKind, LucideIcon> = {
  explore: Search,
  search: Search,
  command: SquareTerminal,
  write: PencilLine,
  web: Globe2,
  verify: ShieldCheck,
  approval: CircleCheck,
  generate: Sparkles,
  work: Activity,
};

const ACTION_BLOCK_ICON_LABELS: Record<ActionBlockIconKind, string> = {
  explore: "Exploration activity",
  search: "Search activity",
  command: "Command activity",
  write: "File change activity",
  web: "Web activity",
  verify: "Verification activity",
  approval: "Approved activity",
  generate: "Generation activity",
  work: "Agent activity",
};

/**
 * Collapsible block for actions (tool calls, steps) between assistant messages.
 * Cursor-style: expanded while active, collapsed when next assistant message arrives.
 */
export function ActionBlock({
  blockId,
  summary,
  iconKind,
  stepCount,
  toolCallCount,
  durationMs,
  outputTokens,
  isActive,
  expanded,
  onToggle,
  showConnectorAbove = false,
  showConnectorBelow = false,
  lastStepLabel,
  children,
}: ActionBlockProps) {
  const [localExpanded, setLocalExpanded] = useState(expanded);
  const ActivityIcon = ACTION_BLOCK_ICONS[iconKind];

  useEffect(() => {
    setLocalExpanded(expanded);
  }, [blockId, expanded]);

  const visibleExpanded = isActive ? true : localExpanded;
  const durationLabel = formatDurationMs(durationMs);
  const workedLabel = isActive
    ? durationLabel
      ? `Working for ${durationLabel}`
      : "Working"
    : durationLabel
      ? `Worked for ${durationLabel}`
      : "Worked";

  const handleToggle = useCallback(() => {
    if (!isActive) {
      setLocalExpanded((prev) => !prev);
    }
    onToggle();
  }, [isActive, onToggle]);

  return (
    <div
      className={`action-block timeline-event ${visibleExpanded ? "expanded" : "collapsed"} ${isActive ? "active" : ""}`}
    >
      <div className="event-indicator action-block-indicator">
        {showConnectorAbove && (
          <span className="event-connector event-connector-above" aria-hidden="true" />
        )}
        <span className="action-block-dot" aria-hidden="true" />
        {showConnectorBelow && (
          <span className="event-connector event-connector-below" aria-hidden="true" />
        )}
      </div>
      <div className="action-block-body event-content">
        <button
          type="button"
          className="action-block-header"
          onClick={handleToggle}
          aria-expanded={visibleExpanded}
          aria-controls={`action-block-content-${blockId}`}
          id={`action-block-toggle-${blockId}`}
        >
          <span
            className={`action-block-kind-icon kind-${iconKind}`}
            title={ACTION_BLOCK_ICON_LABELS[iconKind]}
          >
            <ActivityIcon size={16} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <span className="action-block-worked">{workedLabel}</span>
          <span className="action-block-chevron" aria-hidden="true">
            {visibleExpanded ? (
              <ChevronDown size={14} strokeWidth={2.5} />
            ) : (
              <ChevronRight size={14} strokeWidth={2.5} />
            )}
          </span>
          <span className="action-block-summary">{summary}</span>
          {!visibleExpanded && lastStepLabel && (
            <span className="action-block-last-step-label" aria-label="Last step">
              {lastStepLabel}
            </span>
          )}
          <span className="action-block-meta">
            {stepCount > 0 && (
              <span className="action-block-count">
                {stepCount} step{stepCount === 1 ? "" : "s"}
              </span>
            )}
            {toolCallCount > 0 && (
              <span className="action-block-count">
                {stepCount > 0 && <span className="action-block-stats-sep"> · </span>}
                {toolCallCount} tool call{toolCallCount === 1 ? "" : "s"}
              </span>
            )}
            {(durationMs > 0 || outputTokens > 0) && (
              <span className="action-block-stats">
                {(stepCount > 0 || toolCallCount > 0) && (durationMs > 0 || outputTokens > 0) && (
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
        <span className="action-block-rule" aria-hidden="true" />
        <div
          id={`action-block-content-${blockId}`}
          className="action-block-content"
          role="region"
          aria-labelledby={`action-block-toggle-${blockId}`}
          hidden={!visibleExpanded}
        >
          {visibleExpanded && <div className="action-block-events">{children}</div>}
        </div>
      </div>
    </div>
  );
}
