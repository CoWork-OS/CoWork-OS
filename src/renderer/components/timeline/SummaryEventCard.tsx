import { useState } from "react";
import type { SummaryUiEvent } from "../../../shared/timeline-events";
import type { TaskEvent } from "../../../shared/types";
import { EvidenceList } from "./EvidenceList";
import { RawEventDrawer } from "./RawEventDrawer";

interface SummaryEventCardProps {
  event: SummaryUiEvent;
  allEvents: TaskEvent[];
  showConnectorAbove?: boolean;
  showConnectorBelow?: boolean;
  /** When true, evidence is expanded by default (verbose mode) */
  defaultExpanded?: boolean;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

const STATUS_ICON: Record<string, string> = {
  running: "⟳",
  success: "✓",
  error: "✕",
  waiting: "⌛",
  blocked: "⊘",
};

export function SummaryEventCard({
  event,
  allEvents,
  showConnectorAbove = false,
  showConnectorBelow = false,
  defaultExpanded = false,
}: SummaryEventCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const hasDetails = event.evidence.length > 0 || event.rawEventIds.length > 0;
  const duration = formatDuration(event.durationMs);

  return (
    <div
      className={`semantic-card summary-event-card status-${event.status} phase-${event.phase} kind-${event.actionKind.replace(".", "-")}`}
      data-event-id={event.id}
      data-testid="summary-event-card"
    >
      <div className="event-indicator">
        {showConnectorAbove && (
          <span className="event-connector event-connector-above" aria-hidden="true" />
        )}
        <span
          className={`event-indicator-icon tone-${event.status === "success" ? "success" : event.status === "error" ? "error" : event.status === "waiting" || event.status === "blocked" ? "warning" : "active"}`}
          aria-label={event.status}
        >
          {STATUS_ICON[event.status] ?? "·"}
        </span>
        {showConnectorBelow && (
          <span className="event-connector event-connector-below" aria-hidden="true" />
        )}
      </div>
      <div className="event-content summary-event-content">
        <div
          className={`event-header ${hasDetails ? "expandable" : ""} ${expanded ? "expanded" : ""}`}
          onClick={hasDetails ? () => setExpanded((v) => !v) : undefined}
          role={hasDetails ? "button" : undefined}
          tabIndex={hasDetails ? 0 : undefined}
          onKeyDown={
            hasDetails
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
                }
              : undefined
          }
        >
          <div className="event-header-left">
            {hasDetails && (
              <svg
                className={`event-expand-icon ${expanded ? "rotated" : ""}`}
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            )}
            <div className="event-title">
              {event.actor && <span className="event-actor-badge">{event.actor}</span>}
              <span className="event-summary-text">{event.summary}</span>
            </div>
          </div>
          <div className="event-meta">
            {duration && <span className="event-duration">{duration}</span>}
            <span className="event-phase-chip phase-chip-{event.phase}">{event.phase}</span>
          </div>
        </div>
        {expanded && hasDetails && (
          <div className="event-details">
            <EvidenceList evidence={event.evidence} />
            <RawEventDrawer rawEventIds={event.rawEventIds} allEvents={allEvents} />
          </div>
        )}
      </div>
    </div>
  );
}
