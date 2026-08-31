/**
 * SemanticTimeline
 *
 * Renders a list of UiTimelineEvent[] as semantic cards.
 * Supports concise (default) and verbose modes.
 *
 * - Concise: short summaries, evidence collapsed
 * - Verbose: evidence expanded by default, raw events visible
 *
 * Default display is "windowed": shows last WINDOW_SIZE events in a fixed-height
 * frame. A "Show all" toggle expands to the full list.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UiTimelineEvent } from "../../../shared/timeline-events";
import type { TaskEvent, TimelineVerbosity } from "../../../shared/types";
import { VirtualList } from "../VirtualList";
import { getGlobalMeasurer, isPretextEnabled } from "../../utils/pretext-adapter";
import { AgentEventCard } from "./AgentEventCard";
import { ApprovalEventCard } from "./ApprovalEventCard";
import { SummaryEventCard } from "./SummaryEventCard";

const WINDOW_SIZE = 6;
const VIRTUALIZE_THRESHOLD = 50;
const MAX_SHOW_ALL_EVENTS = 200;
const ESTIMATED_CARD_HEIGHT = 56;
const ESTIMATED_TEXT_LINE_HEIGHT = 18;
const TIMELINE_HORIZONTAL_CHROME = 96;

// ---------------------------------------------------------------------------
// Phase chip strip
// ---------------------------------------------------------------------------

const PHASE_ORDER = ["intake", "plan", "explore", "execute", "verify", "complete"] as const;

type TimelinePhase = (typeof PHASE_ORDER)[number];

function PhaseChips({ activePhases }: { activePhases: Set<TimelinePhase> }) {
  return (
    <div className="semantic-timeline-phases" role="navigation" aria-label="Timeline phases">
      {PHASE_ORDER.map((phase) => (
        <span
          key={phase}
          className={`phase-chip phase-chip-${phase} ${activePhases.has(phase) ? "active" : "inactive"}`}
        >
          {phase}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verbosity toggle
// ---------------------------------------------------------------------------

interface VerbosityToggleProps {
  verbosity: TimelineVerbosity;
  onChange: (v: TimelineVerbosity) => void;
}

function VerbosityToggle({ verbosity, onChange }: VerbosityToggleProps) {
  return (
    <div className="semantic-timeline-verbosity-toggle">
      <button
        type="button"
        className={`verbosity-btn ${verbosity === "summary" ? "active" : ""}`}
        onClick={() => onChange("summary")}
        aria-pressed={verbosity === "summary"}
      >
        Concise
      </button>
      <button
        type="button"
        className={`verbosity-btn ${verbosity === "verbose" ? "active" : ""}`}
        onClick={() => onChange("verbose")}
        aria-pressed={verbosity === "verbose"}
      >
        Verbose
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Show-all toggle
// ---------------------------------------------------------------------------

interface ShowAllToggleProps {
  showAll: boolean;
  totalCount: number;
  onChange: (v: boolean) => void;
}

function ShowAllToggle({ showAll, totalCount, onChange }: ShowAllToggleProps) {
  return (
    <button
      type="button"
      className="semantic-timeline-show-all-btn"
      onClick={() => onChange(!showAll)}
      aria-pressed={showAll}
    >
      {showAll ? "Show less" : `Show all (${totalCount})`}
    </button>
  );
}

function estimateTimelineCardChrome(event: UiTimelineEvent, isVerbose: boolean): number {
  let chrome = 34;

  if (event.kind === "approval") {
    chrome += 18;
  }
  if (event.kind === "agent") {
    chrome += 10;
  }

  const defaultExpanded =
    event.kind === "approval" ||
    (event.kind === "summary" && isVerbose) ||
    (event.kind === "agent" && (isVerbose || event.status === "running"));

  if (defaultExpanded) {
    chrome += 28;
    if (event.evidence.length > 0) chrome += 56;
    if (event.rawEventIds.length > 0) chrome += 48;
    if (event.kind === "agent" && event.children?.length) {
      chrome += event.children.length * 44;
    }
  }

  return chrome;
}

function MeasuredTimelineItem({
  eventId,
  onHeightChange,
  children,
}: {
  eventId: string;
  onHeightChange: (eventId: string, height: number) => void;
  children: ReactNode;
}) {
  const itemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = itemRef.current;
    if (!element) return;

    let frame = 0;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextHeight = Math.ceil(element.getBoundingClientRect().height);
        if (nextHeight > 0) onHeightChange(eventId, nextHeight);
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
  }, [eventId, onHeightChange]);

  return <div ref={itemRef}>{children}</div>;
}

// ---------------------------------------------------------------------------
// SemanticTimeline
// ---------------------------------------------------------------------------

interface SemanticTimelineProps {
  /** Semantic events produced by the timeline normalizer */
  events: UiTimelineEvent[];
  /** Raw task events (needed by RawEventDrawer for full payload display) */
  allEvents: TaskEvent[];
  /** Initial verbosity mode. Defaults to 'summary'. */
  initialVerbosity?: TimelineVerbosity;
  /** If true, hide the verbosity toggle (parent controls it externally) */
  hideVerbosityToggle?: boolean;
  /** If true, hide the phase chip strip */
  hidePhaseChips?: boolean;
}

export function SemanticTimeline({
  events,
  allEvents,
  initialVerbosity = "summary",
  hideVerbosityToggle = false,
  hidePhaseChips = false,
}: SemanticTimelineProps) {
  const [verbosity, setVerbosity] = useState<TimelineVerbosity>(initialVerbosity);
  const [showAll, setShowAll] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const [containerWidth, setContainerWidth] = useState(0);
  const useVirtual =
    events.length > VIRTUALIZE_THRESHOLD ||
    (!showAll && isPretextEnabled() && events.length > WINDOW_SIZE);

  const activePhases = useMemo(() => {
    const phases = new Set<TimelinePhase>();
    for (const event of events) {
      if (event.phase && PHASE_ORDER.includes(event.phase as TimelinePhase)) {
        phases.add(event.phase as TimelinePhase);
      }
    }
    return phases;
  }, [events]);

  const isVerbose = verbosity === "verbose";
  const isWindowed = !showAll;
  const visibleEvents = isWindowed
    ? events.slice(-WINDOW_SIZE)
    : events.slice(-MAX_SHOW_ALL_EVENTS);

  // Auto-scroll to bottom in windowed mode when events change
  useEffect(() => {
    if (isWindowed && !useVirtual && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [visibleEvents, isWindowed, useVirtual]);

  useEffect(() => {
    if (!useVirtual) return;
    const measurer = getGlobalMeasurer();
    measurer.prepare(events.map(extractMeasurableText));
  }, [events, useVirtual]);

  useEffect(() => {
    if (!useVirtual) {
      setMeasuredHeights({});
      return;
    }

    const validIds = new Set(events.map((event) => event.id));
    setMeasuredHeights((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [eventId, height] of Object.entries(prev)) {
        if (validIds.has(eventId)) {
          next[eventId] = height;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [events, useVirtual]);

  useEffect(() => {
    if (!useVirtual) return;
    const element = feedRef.current;
    if (!element) return;

    const updateWidth = () => {
      setContainerWidth(element.clientWidth);
    };

    updateWidth();

    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(element);
    return () => observer.disconnect();
  }, [useVirtual]);

  const handleMeasuredHeight = useCallback((eventId: string, height: number) => {
    setMeasuredHeights((prev) =>
      prev[eventId] === height ? prev : { ...prev, [eventId]: height },
    );
  }, []);

  const getItemHeight = useCallback(
    (event: UiTimelineEvent) => {
      const measuredHeight = measuredHeights[event.id];
      if (typeof measuredHeight === "number" && measuredHeight > 0) {
        return measuredHeight;
      }

      const textWidth = Math.max((containerWidth || 400) - TIMELINE_HORIZONTAL_CHROME, 140);
      const textHeight = getGlobalMeasurer().getHeight(
        extractMeasurableText(event),
        textWidth,
        ESTIMATED_TEXT_LINE_HEIGHT,
      );
      return Math.max(
        ESTIMATED_CARD_HEIGHT,
        Math.ceil(textHeight + estimateTimelineCardChrome(event, isVerbose)),
      );
    },
    [containerWidth, isVerbose, measuredHeights],
  );

  // ---------- Render helpers ------------------------------------------------

  const renderCard = useCallback(
    (event: UiTimelineEvent, index: number) => {
      const total = events.length;
      const showConnectorAbove = index > 0;
      const showConnectorBelow = index < total - 1;

      switch (event.kind) {
        case "summary":
          return (
            <SummaryEventCard
              event={event}
              allEvents={allEvents}
              showConnectorAbove={showConnectorAbove}
              showConnectorBelow={showConnectorBelow}
              defaultExpanded={isVerbose}
            />
          );
        case "approval":
          return (
            <ApprovalEventCard
              event={event}
              allEvents={allEvents}
              showConnectorAbove={showConnectorAbove}
              showConnectorBelow={showConnectorBelow}
            />
          );
        case "agent":
          return (
            <AgentEventCard
              event={event}
              allEvents={allEvents}
              showConnectorAbove={showConnectorAbove}
              showConnectorBelow={showConnectorBelow}
              defaultExpanded={isVerbose || event.status === "running"}
            />
          );
        default:
          return null;
      }
    },
    [allEvents, events.length, isVerbose],
  );

  if (events.length === 0) {
    return <div className="semantic-timeline semantic-timeline-empty" />;
  }

  return (
    <div className="semantic-timeline" data-verbosity={verbosity}>
      {/* Header: phase chips + verbosity toggle */}
      {(!hidePhaseChips || !hideVerbosityToggle) && (
        <div className="semantic-timeline-header">
          {!hidePhaseChips && <PhaseChips activePhases={activePhases} />}
          <div className="semantic-timeline-controls">
            {!hideVerbosityToggle && (
              <VerbosityToggle verbosity={verbosity} onChange={setVerbosity} />
            )}
            {events.length > WINDOW_SIZE && (
              <ShowAllToggle showAll={showAll} totalCount={events.length} onChange={setShowAll} />
            )}
          </div>
        </div>
      )}

      {useVirtual ? (
        <div
          ref={feedRef}
          className={`semantic-timeline-window ${isWindowed ? "windowed" : "expanded"} semantic-timeline-window-virtualized`}
          style={{ overflow: "hidden" }}
        >
          <VirtualList
            items={events}
            getItemKey={(event) => event.id}
            getItemHeight={getItemHeight}
            renderItem={(event, index) => (
              <MeasuredTimelineItem eventId={event.id} onHeightChange={handleMeasuredHeight}>
                {renderCard(event, index)}
              </MeasuredTimelineItem>
            )}
            estimatedItemHeight={ESTIMATED_CARD_HEIGHT}
            overscan={4}
            enabled
            className="semantic-timeline-feed semantic-timeline-feed-virtual"
            style={{ height: "100%" }}
            role="list"
          />
        </div>
      ) : (
        <div
          ref={feedRef}
          className={`semantic-timeline-window ${isWindowed ? "windowed" : "expanded"}`}
        >
          <div className="semantic-timeline-feed" role="list">
            {visibleEvents.map((event, index) => (
              <div key={event.id} role="listitem">
                {renderCard(event, isWindowed ? events.length - WINDOW_SIZE + index : index)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function extractMeasurableText(event: UiTimelineEvent): string {
  return event.summary ?? "";
}
