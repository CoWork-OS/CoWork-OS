import { useState } from "react";
import type { ApprovalUiEvent } from "../../../shared/timeline-events";
import type { TaskEvent } from "../../../shared/types";
import { EvidenceList } from "./EvidenceList";
import { RawEventDrawer } from "./RawEventDrawer";

interface ApprovalEventCardProps {
  event: ApprovalUiEvent;
  allEvents: TaskEvent[];
  showConnectorAbove?: boolean;
  showConnectorBelow?: boolean;
}

const RISK_LABEL: Record<string, string> = {
  high: "High risk",
  medium: "Medium risk",
  low: "Low risk",
};

const STATUS_LABEL: Record<string, string> = {
  waiting: "Waiting for approval",
  success: "Approved",
  blocked: "Denied",
};

export function ApprovalEventCard({
  event,
  allEvents,
  showConnectorAbove = false,
  showConnectorBelow = false,
}: ApprovalEventCardProps) {
  const [expanded, setExpanded] = useState(true); // Approval cards default open

  const hasDetails = event.evidence.length > 0 || event.rawEventIds.length > 0;

  return (
    <div
      className={`semantic-card approval-event-card status-${event.status} risk-${event.risk}`}
      data-event-id={event.id}
      data-testid="approval-event-card"
      role="alert"
      aria-live="polite"
    >
      <div className="event-indicator">
        {showConnectorAbove && (
          <span className="event-connector event-connector-above" aria-hidden="true" />
        )}
        <span
          className={`event-indicator-icon approval-indicator status-${event.status}`}
          aria-label={STATUS_LABEL[event.status] ?? event.status}
        >
          {event.status === "waiting" ? "⌛" : event.status === "success" ? "✓" : "⊘"}
        </span>
        {showConnectorBelow && (
          <span className="event-connector event-connector-below" aria-hidden="true" />
        )}
      </div>
      <div className="event-content approval-event-content">
        <div
          className={`event-header approval-header expandable ${expanded ? "expanded" : ""}`}
          onClick={() => setExpanded((v) => !v)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
          }}
        >
          <div className="event-header-left">
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
            <div className="event-title">
              <span className={`risk-badge risk-${event.risk}`}>{RISK_LABEL[event.risk]}</span>
              <span className="event-summary-text">{event.summary}</span>
            </div>
          </div>
          <div className="event-meta">
            <span className={`approval-status-chip status-${event.status}`}>
              {STATUS_LABEL[event.status] ?? event.status}
            </span>
          </div>
        </div>
        {expanded && hasDetails && (
          <div className="event-details approval-details">
            <EvidenceList evidence={event.evidence} />
            <RawEventDrawer rawEventIds={event.rawEventIds} allEvents={allEvents} />
          </div>
        )}
      </div>
    </div>
  );
}
