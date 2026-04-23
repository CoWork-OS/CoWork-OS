import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Circle, Loader2 } from "lucide-react";
import type { TimelineEventStatus } from "../../../shared/types";
import { StepFeed } from "./StepFeed";
import type { TimelineIndicatorSpec } from "./timeline-indicators";
import type { ParallelGroupProjection } from "./parallel-group-projection";

interface ParallelGroupFeedProps {
  group: ParallelGroupProjection;
  timeLabel: string;
  formatTime: (timestamp: number) => string;
  showConnectorAbove?: boolean;
  showConnectorBelow?: boolean;
  defaultExpanded?: boolean;
}

function buildIndicatorForStatus(status: TimelineEventStatus): TimelineIndicatorSpec {
  if (status === "failed" || status === "blocked" || status === "cancelled") {
    return {
      icon: AlertTriangle,
      tone: "error",
      label: "Parallel group failed",
    };
  }
  if (status === "completed" || status === "skipped") {
    return {
      icon: Check,
      tone: "success",
      label: "Parallel group completed",
    };
  }
  if (status === "in_progress" || status === "pending") {
    return {
      icon: Loader2,
      tone: "active",
      spin: true,
      label: "Parallel group running",
    };
  }
  return {
    icon: Circle,
    tone: "neutral",
    label: "Parallel group",
  };
}

function laneTone(status: TimelineEventStatus): "neutral" | "active" | "success" | "error" {
  if (status === "failed" || status === "blocked" || status === "cancelled") return "error";
  if (status === "completed" || status === "skipped") return "success";
  if (status === "in_progress" || status === "pending") return "active";
  return "neutral";
}

function buildParallelGroupTitle(group: ParallelGroupProjection, isActive: boolean): string {
  const count = group.lanes.length;
  const singleLaneTitle =
    count === 1 && typeof group.lanes[0]?.title === "string" ? group.lanes[0].title.trim() : "";
  if (singleLaneTitle) {
    return singleLaneTitle;
  }
  const label = typeof group.label === "string" ? group.label.trim() : "";
  if (
    label &&
    !/^tool batch(?: \(\d+\))?$/i.test(label) &&
    !/^follow-up tool batch(?: \(\d+\))?$/i.test(label) &&
    !/^tools:/i.test(label)
  ) {
    return label;
  }
  const toolNames = Array.from(
    new Set(
      group.lanes
        .map((lane) => (typeof lane.toolName === "string" ? lane.toolName.trim() : ""))
        .filter((name) => name.length > 0),
    ),
  );

  if (toolNames.length === 1) {
    const tool = toolNames[0];
    if (tool === "web_fetch" || tool === "http_request") {
      return `${isActive ? "Fetching" : "Fetched"} ${count} page${count === 1 ? "" : "s"}`;
    }
    if (tool === "web_search") {
      return `${isActive ? "Searching" : "Searched"} the web`;
    }
    if (tool === "read_file" || tool === "read_files") {
      return `${isActive ? "Reading" : "Read"} ${count} file${count === 1 ? "" : "s"}`;
    }
  }

  return isActive
    ? `Running ${count} task${count === 1 ? "" : "s"} in parallel`
    : `${count} parallel task${count === 1 ? "" : "s"} completed`;
}

export function ParallelGroupFeed({
  group,
  timeLabel,
  formatTime: _formatTime,
  showConnectorAbove = false,
  showConnectorBelow = false,
  defaultExpanded = false,
}: ParallelGroupFeedProps) {
  void _formatTime;
  const singleLane = group.lanes.length === 1 ? group.lanes[0] : null;
  const isActive =
    group.status === "in_progress" || group.lanes.some((lane) => lane.status === "in_progress");
  const hasExpandableDetails = group.lanes.length > 1;
  const [expanded, setExpanded] = useState(hasExpandableDetails && (isActive || defaultExpanded));

  useEffect(() => {
    if (!hasExpandableDetails) {
      setExpanded(false);
      return;
    }
    if (isActive || defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded, hasExpandableDetails, isActive]);

  const indicator = useMemo(() => buildIndicatorForStatus(group.status), [group.status]);
  const groupTitle = useMemo(() => buildParallelGroupTitle(group, isActive), [group, isActive]);

  if (singleLane) {
    return (
      <div className="timeline-event parallel-group-feed-single">
        <div className="parallel-group-feed-lane parallel-group-feed-single-lane">
          <span
            className={`parallel-group-feed-lane-dot tone-${laneTone(singleLane.status)}`}
            aria-hidden="true"
          />
          <div className="parallel-group-feed-lane-title" title={groupTitle}>
            {groupTitle}
          </div>
        </div>
      </div>
    );
  }

  const title = (
    <span>
      {groupTitle}
      {hasExpandableDetails && !(groupTitle.match(/\b\d+\b/) && group.lanes.length > 0) && (
        <span className="event-title-meta"> ({group.lanes.length})</span>
      )}
    </span>
  );

  return (
    <StepFeed
      title={title}
      titleTooltip={groupTitle}
      timeLabel={timeLabel}
      hideTime
      indicator={indicator}
      showConnectorAbove={showConnectorAbove}
      showConnectorBelow={showConnectorBelow}
      expandable={hasExpandableDetails}
      expanded={expanded}
      onToggle={hasExpandableDetails ? () => setExpanded((prev) => !prev) : undefined}
      details={
        hasExpandableDetails && expanded ? (
          <div className="parallel-group-feed-details">
            {group.lanes.map((lane) => (
              <div key={lane.laneKey} className="parallel-group-feed-lane">
                <span
                  className={`parallel-group-feed-lane-dot tone-${laneTone(lane.status)}`}
                  aria-hidden="true"
                />
                <div className="parallel-group-feed-lane-title" title={lane.title}>
                  {lane.title}
                </div>
              </div>
            ))}
          </div>
        ) : undefined
      }
    />
  );
}
