import { ChevronRight } from "lucide-react";
import { useTaskDuration } from "../../hooks/useTaskDuration";
import { formatTurnWorkStats, type TaskTurnSummary } from "../MainContent/task-feed-logic";

interface TurnHeaderProps {
  turn: TaskTurnSummary;
  onToggle: () => void;
}

/**
 * Header of one conversation turn: "Working for 12s" while it runs, then "Worked for 4m 2s".
 * Once the turn has a final answer the header folds the turn's work away above that answer,
 * and its receipt stays in view: "Worked for 4m 2s · 8 actions · 1 approved".
 */
export function TurnHeader({ turn, onToggle }: TurnHeaderProps) {
  const isWorking = turn.status === "working";
  const duration = useTaskDuration(turn.startedAt, turn.endedAt ?? undefined, isWorking);
  const label = isWorking ? `Working for ${duration}` : `Worked for ${duration}`;
  const stats = formatTurnWorkStats(turn.stats);
  const receipt =
    stats.length > 0 ? (
      <span className="turn-header-stats">
        {stats.map((part) => (
          <span
            key={part}
            className="turn-header-stat"
            data-tone={/failed|declined/.test(part) ? "attention" : undefined}
          >
            {part}
          </span>
        ))}
      </span>
    ) : null;
  if (!turn.collapsible) {
    return (
      <div className="turn-header">
        <span className="turn-header-label">
          <span>{label}</span>
          {receipt}
        </span>
      </div>
    );
  }
  return (
    <div className="turn-header">
      <button
        type="button"
        className="turn-header-label turn-header-toggle"
        onClick={onToggle}
        aria-expanded={turn.expanded}
        title={turn.expanded ? "Hide the work for this turn" : "Show the work for this turn"}
      >
        <span>{label}</span>
        {receipt}
        <ChevronRight
          className="turn-header-chevron"
          size={14}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
