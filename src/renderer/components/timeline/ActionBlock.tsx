import { useCallback, useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ChevronDown,
  CircleCheck,
  Globe2,
  ListChecks,
  PencilLine,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { useTaskDuration } from "../../hooks/useTaskDuration";
import { AnimatedDisclosure } from "./AnimatedDisclosure";
import { VirtualizedActivityList } from "./VirtualizedActivityList";

import type { ActionBlockIconKind } from "./ActionBlockSummary";

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1_000)}k`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toLocaleString();
}

function normalizeHeaderLabel(value: string): string {
  return value
    .trim()
    .replace(/[.\u2026\s]+$/, "")
    .toLowerCase();
}

/** Returns the muted latest-activity label, or "" when it would just repeat the state label. */
function resolveSecondaryHeaderLabel(label: string | undefined, primaryLabel: string): string {
  const trimmed = (label || "").trim();
  if (!trimmed) return "";
  return normalizeHeaderLabel(trimmed) === normalizeHeaderLabel(primaryLabel) ? "" : trimmed;
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
  /** Latest concrete step label used for the active compact header. */
  lastStepLabel?: string;
  /** Completed activity summary used by the compact historical row. */
  compactLabel?: string;
  /** Timestamp used to keep the current block's duration live. */
  startedAt?: number;
  replay?: boolean;
  /** Compact progressive-disclosure header used when Verbose is off. */
  minimal?: boolean;
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
  work: ListChecks,
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
 * Verbose mode may auto-open the current block; summary mode keeps it compact
 * until the user asks to inspect the action history.
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
  startedAt,
  replay = false,
  minimal = false,
  compactLabel,
  children,
}: ActionBlockProps) {
  const ActivityIcon = ACTION_BLOCK_ICONS[iconKind];
  const headerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const visibleExpanded = expanded;
  const hasLiveStartTimestamp =
    typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0;
  const liveDurationLabel = useTaskDuration(
    hasLiveStartTimestamp ? startedAt : 0,
    undefined,
    isActive && !replay && hasLiveStartTimestamp,
  );
  const durationLabel =
    isActive && !replay && hasLiveStartTimestamp ? liveDurationLabel : formatDurationMs(durationMs);
  const primaryLabel = isActive ? "Working" : summary;
  const compactSummary = compactLabel?.trim() || "";
  const usefulLastStepLabel =
    lastStepLabel &&
    !["working", "thinking", "activity", "activity complete"].includes(
      normalizeHeaderLabel(lastStepLabel),
    )
      ? lastStepLabel
      : "";
  const minimalLabel =
    (isActive && usefulLastStepLabel) ||
    (!isActive && compactSummary) ||
    usefulLastStepLabel ||
    (isActive ? "Thinking" : summary || "Activity");
  // The header pairs a bold state label with a muted "latest activity" label. When the
  // latest activity resolves to the same text (a running block whose newest event has no
  // better label than "Working"), rendering both just repeats the state twice.
  const secondaryLabel = resolveSecondaryHeaderLabel(lastStepLabel || summary, primaryLabel);

  const handleToggle = useCallback(() => {
    if (visibleExpanded) {
      const activeElement = document.activeElement;
      if (activeElement && contentRef.current?.contains(activeElement)) {
        headerRef.current?.focus();
      }
    }
    onToggle();
  }, [onToggle, visibleExpanded]);

  useEffect(() => {
    const label = labelRef.current;
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!label || replay || reducedMotion || typeof label.animate !== "function") return;
    const animation = label.animate(
      [
        { opacity: 0.35, transform: "translateY(2px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 110, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
    return () => animation.cancel();
  }, [lastStepLabel, minimalLabel, replay]);

  return (
    <div
      id={`activity-group-${blockId}`}
      className={`action-block timeline-event ${visibleExpanded ? "expanded" : "collapsed"} ${isActive ? "active" : ""} ${minimal ? "minimal" : ""} ${replay ? "replay" : ""}`}
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
          ref={headerRef}
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
          {minimal ? (
            <span
              ref={labelRef}
              className={`action-block-minimal-label ${isActive ? "current" : ""}`}
              aria-label={minimalLabel}
            >
              {minimalLabel}
            </span>
          ) : (
            <>
              <span className="action-block-worked">{primaryLabel}</span>
              {secondaryLabel ? (
                <span
                  ref={labelRef}
                  className="action-block-last-step-label"
                  aria-label={secondaryLabel}
                >
                  {secondaryLabel}
                </span>
              ) : null}
              {durationLabel ? (
                <span
                  className="action-block-meta"
                  title={`Duration: ${durationLabel}; ${stepCount} activities, ${toolCallCount} tool calls, ${formatTokenCount(outputTokens)} output tokens`}
                >
                  {durationLabel}
                </span>
              ) : null}
            </>
          )}
          <span className="action-block-chevron" aria-hidden="true">
            <ChevronDown size={14} strokeWidth={2.5} />
          </span>
        </button>
        {!minimal && <span className="action-block-rule" aria-hidden="true" />}
        <div ref={contentRef}>
          <AnimatedDisclosure
            id={`action-block-content-${blockId}`}
            className="action-block-content"
            labelledBy={`action-block-toggle-${blockId}`}
            open={visibleExpanded}
            replay={replay}
          >
            <VirtualizedActivityList replay={replay}>{children}</VirtualizedActivityList>
          </AnimatedDisclosure>
        </div>
      </div>
    </div>
  );
}
