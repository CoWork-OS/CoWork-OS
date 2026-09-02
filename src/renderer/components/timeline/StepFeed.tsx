import { useCallback, useId, useRef, type ReactNode } from "react";
import type { TimelineIndicatorSpec } from "./timeline-indicators";
import { AnimatedDisclosure } from "./AnimatedDisclosure";

interface StepFeedProps {
  title: ReactNode;
  titleTooltip?: string;
  timeLabel: string;
  hideTime?: boolean;
  indicator: TimelineIndicatorSpec;
  showConnectorAbove?: boolean;
  showConnectorBelow?: boolean;
  showBranchStub?: boolean;
  expandable: boolean;
  expanded: boolean;
  onToggle?: () => void;
  details?: ReactNode;
  replay?: boolean;
}

export function StepFeed({
  title,
  titleTooltip,
  timeLabel,
  hideTime = false,
  indicator,
  showConnectorAbove = false,
  showConnectorBelow = false,
  showBranchStub = false,
  expandable,
  expanded,
  onToggle,
  details,
  replay = false,
}: StepFeedProps) {
  const generatedId = useId().replace(/:/g, "");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastDetailsRef = useRef<ReactNode>(details);
  if (details !== undefined) lastDetailsRef.current = details;
  const visibleExpanded = expanded;

  const handleToggle = useCallback(() => {
    if (visibleExpanded) {
      const activeElement = document.activeElement;
      if (activeElement && contentRef.current?.contains(activeElement)) {
        buttonRef.current?.focus();
      }
    }
    onToggle?.();
  }, [onToggle, visibleExpanded]);

  const IndicatorIcon = indicator.icon;
  return (
    <div className="timeline-event step-feed-card">
      <div className="event-indicator">
        {showConnectorAbove && (
          <span className="event-connector event-connector-above" aria-hidden="true" />
        )}
        <span
          className={`event-indicator-icon tone-${indicator.tone} ${indicator.spin ? "spin" : ""}`}
          aria-hidden="true"
          title={indicator.label}
        >
          <IndicatorIcon size={12} strokeWidth={2} />
        </span>
        {showConnectorBelow && (
          <span className="event-connector event-connector-below" aria-hidden="true" />
        )}
        {showBranchStub && <span className="event-branch-stub" aria-hidden="true" />}
      </div>
      <div className="event-content">
        <span id={`step-feed-status-${generatedId}`} className="step-feed-sr-only">
          {indicator.label}
        </span>
        <button
          ref={buttonRef}
          type="button"
          className={`event-header ${expandable ? "expandable" : ""} ${visibleExpanded ? "expanded" : ""}`}
          onClick={expandable ? handleToggle : undefined}
          disabled={!expandable}
          aria-expanded={expandable ? visibleExpanded : undefined}
          aria-controls={expandable ? `step-feed-details-${generatedId}` : undefined}
          aria-describedby={`step-feed-status-${generatedId}`}
          id={`step-feed-toggle-${generatedId}`}
        >
          <div className="event-header-left">
            <div className="event-title" title={titleTooltip}>
              {title}
            </div>
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
                <path d="M6 9l6 6 6-6" />
              </svg>
            )}
          </div>
          {!hideTime && <div className="event-time">{timeLabel}</div>}
        </button>
        <div ref={contentRef}>
          <AnimatedDisclosure
            open={expandable && visibleExpanded}
            id={`step-feed-details-${generatedId}`}
            labelledBy={`step-feed-toggle-${generatedId}`}
            replay={replay}
            durationMs={190}
          >
            {lastDetailsRef.current}
          </AnimatedDisclosure>
        </div>
      </div>
    </div>
  );
}
