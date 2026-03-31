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
  formatTime,
  showConnectorAbove = false,
  showConnectorBelow = false,
}: ParallelGroupFeedProps) {
  const isActive =
    group.status === "in_progress" || group.lanes.some((lane) => lane.status === "in_progress");
  const [expanded, setExpanded] = useState(isActive);

  useEffect(() => {
    if (isActive) {
      setExpanded(true);
    }
  }, [isActive]);

  const indicator = useMemo(() => buildIndicatorForStatus(group.status), [group.status]);
  const groupTitle = useMemo(() => buildParallelGroupTitle(group, isActive), [group, isActive]);

  const title = (
    <span>
      {groupTitle}
      {!(groupTitle.match(/\b\d+\b/) && group.lanes.length > 0) && (
        <span className="event-title-meta"> ({group.lanes.length})</span>
      )}
    </span>
  );

  return (
    <StepFeed
      title={title}
      timeLabel={timeLabel}
      indicator={indicator}
      showConnectorAbove={showConnectorAbove}
      showConnectorBelow={showConnectorBelow}
      expandable={group.lanes.length > 0}
      expanded={expanded}
      onToggle={group.lanes.length > 0 ? () => setExpanded((prev) => !prev) : undefined}
      details={
        expanded ? (
          <div className="parallel-group-feed-details">
            {group.lanes.map((lane) => (
              <div key={lane.laneKey} className="parallel-group-feed-lane">
                <span
                  className={`parallel-group-feed-lane-dot tone-${laneTone(lane.status)}`}
                  aria-hidden="true"
                />
                <div className="parallel-group-feed-lane-title">{lane.title}</div>
                <div className="parallel-group-feed-lane-time">{formatTime(lane.startedAt)}</div>
              </div>
            ))}
          </div>
        ) : undefined
      }
    />
  );
}
