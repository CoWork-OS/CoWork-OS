import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  Check,
  CornerUpRight,
  Lightbulb,
  MessageCircleQuestion,
  OctagonAlert,
  Repeat,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Target,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { HomeTodaySignals } from "../../hooks/useHomeTodaySignals";
import { formatHomeSessionTime } from "../../utils/home-sessions";
import type {
  HomeToday,
  HomeTodayButton,
  HomeTodayCard,
  HomeTodayHandledRow,
  HomeTodayIcon,
} from "../../utils/home-today";

/** Cards shown before "Show more"; the concept is three decisions, not a feed. */
const VISIBLE_CARDS = 3;
/** Matches the card's exit animation in calm-theme.css. */
const EXIT_MS = 220;

const ICONS: Record<HomeTodayIcon, LucideIcon> = {
  approval: ShieldCheck,
  question: MessageCircleQuestion,
  resume: RotateCcw,
  blocked: OctagonAlert,
  flow: Workflow,
  commitment: CalendarClock,
  follow_up: CornerUpRight,
  recurring_pattern: Repeat,
  goal_aligned: Target,
  insight: Lightbulb,
  reverse_prompt: Sparkles,
};

interface CalmHomeTodayProps {
  today: HomeToday;
  signals: Pick<
    HomeTodaySignals,
    "markSuggestionStarted" | "snoozeSuggestion" | "completeCommitment" | "resolve"
  >;
  onOpenSession: (taskId: string) => void;
  /** Opens an automation in the Automations view; absent where it can't be opened. */
  onOpenRoutine?: (routineId: string) => void;
  /** Starts a new task with this exact prompt; false when no task was created. */
  onStartTask: (title: string, prompt: string) => Promise<boolean>;
  /** Puts a prompt in the composer for the user to edit and send. */
  onDraftPrompt: (prompt: string) => void;
}

function cardTime(card: HomeTodayCard, now: number): string {
  if (card.kind === "commitment") {
    return new Date(card.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return formatHomeSessionTime(card.at, now);
}

/**
 * The Calm home's Today stack: up to three prepared decisions, one quieter idea,
 * then what got handled. A card that is acted on folds away and leaves a done
 * row behind.
 */
export function CalmHomeToday({
  today,
  signals,
  onOpenSession,
  onOpenRoutine,
  onStartTask,
  onDraftPrompt,
}: CalmHomeTodayProps) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const timers = useRef<number[]>([]);
  const now = Date.now();

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  const foldAway = (card: HomeTodayCard, row?: HomeTodayHandledRow) => {
    setLeaving((current) => new Set(current).add(card.id));
    timers.current.push(
      window.setTimeout(() => {
        signals.resolve(card.id, row);
        setLeaving((current) => {
          const next = new Set(current);
          next.delete(card.id);
          return next;
        });
      }, EXIT_MS),
    );
  };

  const run = async (card: HomeTodayCard, button: HomeTodayButton) => {
    const { action } = button;
    if (action.type === "open-session") {
      onOpenSession(action.taskId);
      return;
    }
    if (action.type === "open-routine") {
      onOpenRoutine?.(action.routineId);
      return;
    }
    if (action.type === "draft-prompt") {
      onDraftPrompt(action.prompt);
      return;
    }
    setBusy(card.id);
    setErrors(({ [card.id]: _cleared, ...rest }) => rest);
    try {
      if (action.type === "start-suggestion") {
        // Run exactly the prompt the card showed. When the task isn't created, the app
        // already says why (no model set up, no folder, ...), and the card stays.
        if (!(await onStartTask(action.title, action.prompt))) return;
        // The task is running; recording the suggestion as acted on is best effort.
        await signals
          .markSuggestionStarted(action.workspaceId, action.suggestionId)
          .catch(() => {});
        foldAway(card, {
          id: `acted:${card.id}`,
          title: card.title,
          outcome: "Started",
          at: Date.now(),
        });
      } else if (action.type === "snooze-suggestion") {
        await signals.snoozeSuggestion(action.workspaceId, action.suggestionId);
        foldAway(card);
      } else if (action.type === "complete-commitment") {
        if (!(await signals.completeCommitment(action.commitmentId))) {
          throw new Error("not updated");
        }
        foldAway(card, {
          id: `acted:${card.id}`,
          title: card.title,
          outcome: "Marked done",
          at: Date.now(),
        });
      }
    } catch {
      setErrors((current) => ({ ...current, [card.id]: "That didn't go through. Try again." }));
    } finally {
      setBusy((current) => (current === card.id ? null : current));
    }
  };

  const renderCard = (card: HomeTodayCard, variant: "decision" | "idea") => {
    const Icon = ICONS[card.icon] || Sparkles;
    const titleId = `calm-today-${card.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const isBusy = busy === card.id;
    return (
      <article
        key={card.id}
        className={`calm-today-card calm-today-card-${variant}${leaving.has(card.id) ? " is-leaving" : ""}`}
        aria-labelledby={titleId}
        aria-busy={isBusy || undefined}
      >
        <header className="calm-today-card-head">
          <span className={`calm-today-card-icon kind-${card.kind}`} aria-hidden="true">
            <Icon size={14} strokeWidth={2} />
          </span>
          <span className="calm-today-card-source">
            {card.source}
            <span aria-hidden="true"> · </span>
            <span className="calm-today-card-state">{card.state}</span>
          </span>
          <span className="calm-today-card-time">{cardTime(card, now)}</span>
        </header>
        {card.chips.length > 0 && (
          <ul className="calm-today-card-chips" aria-label="Details">
            {card.chips.map((chip) => (
              <li
                key={`${chip.kind}:${chip.label}`}
                className={`calm-today-chip chip-${chip.kind}`}
              >
                {chip.label}
              </li>
            ))}
          </ul>
        )}
        <h3 className="calm-today-card-title" id={titleId}>
          {card.title}
        </h3>
        {card.why && (
          <p className="calm-today-card-why">
            <Lightbulb size={14} aria-hidden="true" />
            <span>{card.why}</span>
          </p>
        )}
        {card.preview && (
          <div className="calm-today-card-preview">
            <span className="calm-today-card-preview-label">{card.preview.label}</span>
            <p>{card.preview.text}</p>
          </div>
        )}
        {errors[card.id] && (
          <p className="calm-today-card-error" role="alert">
            {errors[card.id]}
          </p>
        )}
        <div className="calm-today-card-actions">
          <button
            type="button"
            className="calm-today-button primary"
            disabled={isBusy || (card.primary.action.type === "open-routine" && !onOpenRoutine)}
            onClick={() => void run(card, card.primary)}
          >
            {card.primary.label}
          </button>
          {card.secondary && (
            <button
              type="button"
              className="calm-today-button"
              disabled={isBusy}
              onClick={() => void run(card, card.secondary!)}
            >
              {card.secondary.label}
            </button>
          )}
        </div>
      </article>
    );
  };

  const visible = expanded ? today.needsYou : today.needsYou.slice(0, VISIBLE_CARDS);
  const hiddenCount = today.needsYou.length - visible.length;
  const showIdea = today.idea && today.needsYou.length < VISIBLE_CARDS;

  return (
    <div className="calm-today">
      {(visible.length > 0 || showIdea) && (
        <section className="calm-today-cards" aria-label="Needs you">
          {visible.map((card) => renderCard(card, "decision"))}
          {hiddenCount > 0 && (
            <button type="button" className="calm-today-more" onClick={() => setExpanded(true)}>
              Show {hiddenCount} more
            </button>
          )}
          {showIdea && today.idea && renderCard(today.idea, "idea")}
        </section>
      )}

      {today.handled.length > 0 && (
        <ul className="calm-today-handled" aria-label="Handled">
          {today.handled.map((row) => {
            const content = (
              <>
                <span className="calm-today-check" aria-hidden="true">
                  <Check size={12} strokeWidth={3} />
                </span>
                <span className="calm-today-handled-title">{row.title}</span>
                <span className="calm-today-handled-outcome">{row.outcome}</span>
                <span className="calm-today-handled-time">
                  {formatHomeSessionTime(row.at, now)}
                </span>
              </>
            );
            return (
              <li key={row.id}>
                {row.taskId ? (
                  <button
                    type="button"
                    className="calm-today-handled-row"
                    onClick={() => onOpenSession(row.taskId!)}
                    title={row.title}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="calm-today-handled-row" title={row.title}>
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
