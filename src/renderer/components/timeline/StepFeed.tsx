import type React from "react";
import type { TimelineIndicatorSpec } from "./timeline-indicators";

interface StepFeedProps {
  title: React.ReactNode;
  timeLabel: string;
  indicator: TimelineIndicatorSpec;
  showConnectorAbove?: boolean;
  showConnectorBelow?: boolean;
  showBranchStub?: boolean;
  expandable: boolean;
  expanded: boolean;
  onToggle?: () => void;
  details?: React.ReactNode;
}

export function StepFeed({
  title,
  timeLabel,
  indicator,
  showConnectorAbove = false,
  showConnectorBelow = false,
  showBranchStub = false,
  expandable,
  expanded,
  onToggle,
  details,
}: StepFeedProps) {
  const IndicatorIcon = indicator.icon;
  return (
    <div className="timeline-event step-feed-card">
      <div className="event-indicator">
        {showConnectorAbove && <span className="event-connector event-connector-above" aria-hidden="true" />}
        <span
          className={`event-indicator-icon tone-${indicator.tone} ${indicator.spin ? "spin" : ""}`}
          aria-hidden="true"
          title={indicator.label}
        >
          <IndicatorIcon size={12} strokeWidth={2} />
        </span>
        {showConnectorBelow && <span className="event-connector event-connector-below" aria-hidden="true" />}
        {showBranchStub && <span className="event-branch-stub" aria-hidden="true" />}
      </div>
      <div className="event-content">
        <div
          className={`event-header ${expandable ? "expandable" : ""} ${expanded ? "expanded" : ""}`}
          onClick={expandable ? onToggle : undefined}
        >
          <div className="event-header-left">
            {expandable && (
              <svg
                className="event-expand-icon"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            )}
            <div className="event-title">{title}</div>
          </div>
          <div className="event-time">{timeLabel}</div>
        </div>
        {expanded && details}
      </div>
    </div>
  );
}
