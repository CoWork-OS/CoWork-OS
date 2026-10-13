import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  CalendarPlus,
  CalendarX2,
  Check,
  CornerUpRight,
  Lightbulb,
  Mail,
  MessageCircleQuestion,
  OctagonAlert,
  Repeat,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
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
/** When the outbox doesn't say, a queued reply goes out after this long. */
const DEFAULT_SEND_DELAY_MS = 30_000;

const ICONS: Record<HomeTodayIcon, LucideIcon> = {
  approval: ShieldCheck,
  question: MessageCircleQuestion,
  resume: RotateCcw,
  blocked: OctagonAlert,
  flow: Workflow,
  commitment: CalendarClock,
  calendar_hold: CalendarPlus,
  calendar_conflict: CalendarX2,
  calendar_prep: Users,
  mail_reply: Mail,
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
    | "markSuggestionStarted"
    | "snoozeSuggestion"
    | "dismissSuggestion"
    | "addSuggestionAsCommitment"
    | "completeCommitment"
    | "undoMemoryChange"
    | "answerQuestion"
    | "acceptCalendarProposal"
    | "dismissCalendarProposal"
    | "holdCalendarTimeForSuggestion"
    | "sendMailReplyDraft"
    | "undoMailReplyDraftSend"
    | "discardMailReplyDraft"
    | "saveMailDraftBody"
    | "setMailReplyDraftsEnabled"
    | "dismissMailReplyDraftsOffer"
    | "resolve"
    | "unresolve"
  >;
  onOpenSession: (taskId: string) => void;
  /**
   * Shows an approval's own review dialog over Today. False when the app doesn't hold the
   * approval (for example after a reload), and the card opens the session instead.
   */
  onReviewApproval?: (approvalId: string) => boolean;
  /** Opens an automation in the Automations view; absent where it can't be opened. */
  onOpenRoutine?: (routineId: string) => void;
  /** Starts a new task with this exact prompt; false when no task was created. */
  onStartTask: (title: string, prompt: string) => Promise<boolean>;
  /** Puts a prompt in the composer for the user to edit and send. */
  onDraftPrompt: (prompt: string) => void;
  /**
   * Puts a suggestion's prompt in the composer; sending it records the suggestion as acted
   * on, and as edited when the prompt changed.
   */
  onEditSuggestion?: (prompt: string, workspaceId: string, suggestionId: string) => void;
  /** Opens a calendar event in the browser. */
  onOpenLink?: (url: string) => void;
}

function cardTime(card: HomeTodayCard, now: number): string {
  const clock = new Date(card.at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (card.kind === "commitment") return clock;
  if (card.kind === "calendar") {
    // When it happens: the clock today, with the day after that.
    if (new Date(card.at).toDateString() === new Date(now).toDateString()) return clock;
    return `${new Date(card.at).toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
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
  onReviewApproval,
  onOpenRoutine,
  onStartTask,
  onDraftPrompt,
  onEditSuggestion,
  onOpenLink,
}: CalmHomeTodayProps) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** The reply being edited on its card, with the text so far. */
  const [editing, setEditing] = useState<{ cardId: string; text: string } | null>(null);
  /**
   * Reply text saved here, shown until the queue reloads with it. `base` is the text the
   * card had when it was saved; once the queue's text changes, the queue's text wins.
   */
  const [savedBodies, setSavedBodies] = useState<Record<string, { text: string; base: string }>>(
    {},
  );
  const shownBody = (card: HomeTodayCard): string | undefined => {
    const saved = savedBodies[card.id];
    return saved && saved.base === card.preview?.text ? saved.text : card.preview?.text;
  };
  const [, setTick] = useState(0);
  const timers = useRef<number[]>([]);
  const now = Date.now();

  // Re-render when a queued reply's undo window closes, so its Undo button goes away.
  const nextUndoEnd = today.handled.reduce<number | null>((soonest, row) => {
    const until = row.undoSend?.until;
    return until && until > now && (soonest === null || until < soonest) ? until : soonest;
  }, null);
  useEffect(() => {
    if (nextUndoEnd === null) return undefined;
    const timer = window.setTimeout(() => setTick((tick) => tick + 1), nextUndoEnd - Date.now());
    return () => window.clearTimeout(timer);
  }, [nextUndoEnd]);

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
    if (action.type === "review-approval") {
      // The same review dialog the session shows, with the same checks; never a shortcut.
      if (!onReviewApproval?.(action.approvalId)) onOpenSession(action.taskId);
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
    if (action.type === "open-link") {
      onOpenLink?.(action.url);
      return;
    }
    if (action.type === "edit-mail-draft") {
      setEditing({ cardId: card.id, text: shownBody(card) ?? card.mailDraft?.bodyText ?? "" });
      return;
    }
    if (action.type === "edit-suggestion") {
      if (onEditSuggestion) {
        onEditSuggestion(action.prompt, action.workspaceId, action.suggestionId);
      } else {
        onDraftPrompt(action.prompt);
      }
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
      } else if (action.type === "dismiss-suggestion") {
        await signals.dismissSuggestion(action.workspaceId, action.suggestionId);
        foldAway(card);
      } else if (action.type === "add-commitment") {
        if (!(await signals.addSuggestionAsCommitment(action.workspaceId, action.suggestionId))) {
          throw new Error("not saved");
        }
        foldAway(card, {
          id: `acted:${card.id}`,
          title: card.title,
          outcome: "Added as commitment",
          at: Date.now(),
        });
      } else if (action.type === "answer-question") {
        const status = await signals.answerQuestion(
          action.requestId,
          action.questionId,
          action.optionLabel,
        );
        if (status === "not_found") {
          setErrors((current) => ({
            ...current,
            [card.id]: "This question was already answered or closed.",
          }));
          return;
        }
        foldAway(card, {
          id: `acted:${card.id}`,
          title: card.title,
          outcome: `Answered: ${action.optionLabel}`,
          at: Date.now(),
          // The row opens the session, where the agent goes on with the answer.
          ...(card.primary.action.type === "open-session"
            ? { taskId: card.primary.action.taskId }
            : {}),
        });
      } else if (action.type === "accept-calendar") {
        const result = await signals.acceptCalendarProposal(action.proposalId);
        if (!result.ok) {
          setErrors((current) => ({ ...current, [card.id]: result.message }));
          return;
        }
        foldAway(card, {
          id: `acted:${card.id}`,
          title: card.title,
          outcome: action.done,
          at: Date.now(),
        });
      } else if (action.type === "dismiss-calendar") {
        await signals.dismissCalendarProposal(action.proposalId);
        foldAway(card);
      } else if (action.type === "prepare-meeting") {
        // Same as a suggestion: run exactly the prompt the card showed.
        if (!(await onStartTask(action.title, action.prompt))) return;
        // Prep has started; retiring the card is best effort.
        await signals.acceptCalendarProposal(action.proposalId).catch(() => {});
        foldAway(card, {
          id: `acted:${card.id}`,
          title: card.title,
          outcome: "Prep started",
          at: Date.now(),
        });
      } else if (action.type === "hold-for-suggestion") {
        const result = await signals.holdCalendarTimeForSuggestion({
          workspaceId: action.workspaceId,
          suggestionId: action.suggestionId,
          start: action.start,
          end: action.end,
        });
        if (!result.ok) {
          setErrors((current) => ({ ...current, [card.id]: result.message }));
          return;
        }
        foldAway(card, {
          id: `acted:${card.id}`,
          title: card.title,
          outcome: "Time held",
          at: Date.now(),
        });
      } else if (action.type === "send-mail-draft") {
        const result = await signals.sendMailReplyDraft(action.draftId);
        if (!result.ok) {
          setErrors((current) => ({ ...current, [card.id]: result.message }));
          return;
        }
        foldAway(card, {
          id: `acted:${card.id}`,
          title: card.title,
          outcome: "Sent",
          at: Date.now(),
          undoSend: {
            cardId: card.id,
            draftId: action.draftId,
            until: result.sendAfter ?? Date.now() + DEFAULT_SEND_DELAY_MS,
          },
        });
      } else if (action.type === "undo-mail-send") {
        const result = await signals.undoMailReplyDraftSend(action.draftId);
        if (!result.ok) {
          setErrors((current) => ({ ...current, [card.id]: result.message }));
          return;
        }
        // The reply comes back as a draft to edit or send again.
        foldAway(card);
      } else if (action.type === "discard-mail-draft") {
        const result = await signals.discardMailReplyDraft(action.draftId);
        if (!result.ok) {
          setErrors((current) => ({ ...current, [card.id]: result.message }));
          return;
        }
        foldAway(card);
      } else if (action.type === "set-mail-drafts") {
        await signals.setMailReplyDraftsEnabled(action.enabled);
        const row: HomeTodayHandledRow = {
          id: "acted:mail-drafts",
          title: "Reply drafts",
          outcome: action.enabled ? "Turned on" : "Turned off",
          at: Date.now(),
        };
        // Turning it on answers the offer; turning it off leaves this draft where it is.
        if (action.enabled) foldAway(card, row);
        else signals.resolve("mail_reply:drafting", row);
      } else if (action.type === "dismiss-mail-offer") {
        await signals.dismissMailReplyDraftsOffer();
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

  const saveEdit = async (card: HomeTodayCard) => {
    if (!editing || editing.cardId !== card.id || !card.mailDraft) return;
    const text = editing.text;
    setBusy(card.id);
    setErrors(({ [card.id]: _cleared, ...rest }) => rest);
    try {
      await signals.saveMailDraftBody(card.mailDraft.draftId, text);
      const base = card.preview?.text ?? "";
      setSavedBodies((current) => ({ ...current, [card.id]: { text, base } }));
      setEditing(null);
    } catch {
      setErrors((current) => ({ ...current, [card.id]: "The draft couldn't be saved." }));
    } finally {
      setBusy((current) => (current === card.id ? null : current));
    }
  };

  /** Takes back a reply still in the outbox; its card comes back to edit or send again. */
  const undoSendRow = async (row: HomeTodayHandledRow) => {
    if (!row.undoSend) return;
    setBusy(row.id);
    setErrors(({ [row.id]: _cleared, ...rest }) => rest);
    try {
      const result = await signals.undoMailReplyDraftSend(row.undoSend.draftId);
      if (!result.ok) {
        setErrors((current) => ({ ...current, [row.id]: result.message }));
        return;
      }
      signals.unresolve(row.undoSend.cardId, row.id);
    } catch {
      setErrors((current) => ({ ...current, [row.id]: "That didn't go through. Try again." }));
    } finally {
      setBusy((current) => (current === row.id ? null : current));
    }
  };

  /** Reopens a commitment memory closed on its own; the row then says it was reopened. */
  const undoRow = async (row: HomeTodayHandledRow) => {
    if (!row.undo) return;
    setBusy(row.id);
    setErrors(({ [row.id]: _cleared, ...rest }) => rest);
    try {
      const result = await signals.undoMemoryChange(row.undo.workspaceId, row.undo.changeId);
      if (!result.ok) {
        setErrors((current) => ({ ...current, [row.id]: result.error }));
        return;
      }
      signals.resolve(row.id, {
        id: `acted:${row.id}`,
        title: row.title,
        outcome: "Reopened",
        at: Date.now(),
      });
    } catch {
      setErrors((current) => ({ ...current, [row.id]: "That didn't go through. Try again." }));
    } finally {
      setBusy((current) => (current === row.id ? null : current));
    }
  };

  /** Buttons whose handler this view wasn't given stay disabled. */
  const canRun = (button: HomeTodayButton) =>
    !(button.action.type === "open-routine" && !onOpenRoutine) &&
    !(button.action.type === "open-link" && !onOpenLink);

  const renderCard = (card: HomeTodayCard, variant: "decision" | "idea") => {
    const Icon = ICONS[card.icon] || Sparkles;
    const titleId = `calm-today-${card.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const isBusy = busy === card.id;
    const isEditing = editing?.cardId === card.id;
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
        {isEditing ? (
          <div className="calm-today-card-preview">
            <label className="calm-today-card-preview-label" htmlFor={`${titleId}-reply`}>
              Your reply
            </label>
            <textarea
              id={`${titleId}-reply`}
              className="calm-today-card-editor"
              value={editing.text}
              rows={6}
              autoFocus
              onChange={(event) => {
                const text = event.target.value;
                setEditing((current) => (current ? { ...current, text } : current));
              }}
            />
          </div>
        ) : (
          card.preview && (
            <div className="calm-today-card-preview">
              <span className="calm-today-card-preview-label">{card.preview.label}</span>
              <p>{shownBody(card)}</p>
            </div>
          )
        )}
        {errors[card.id] && (
          <p className="calm-today-card-error" role="alert">
            {errors[card.id]}
          </p>
        )}
        {card.choices && (
          <div className="calm-today-card-choices" role="group" aria-label="Answer">
            {card.choices.map((choice) => (
              <button
                key={choice.label}
                type="button"
                className="calm-today-button primary"
                title={choice.hint}
                disabled={isBusy}
                onClick={() => void run(card, choice)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        )}
        {isEditing ? (
          <div className="calm-today-card-actions">
            <button
              type="button"
              className="calm-today-button primary"
              disabled={isBusy || !editing.text.trim()}
              onClick={() => void saveEdit(card)}
            >
              Save
            </button>
            <button
              type="button"
              className="calm-today-button"
              disabled={isBusy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="calm-today-card-actions">
            <button
              type="button"
              className={card.choices ? "calm-today-button" : "calm-today-button primary"}
              title={card.primary.hint}
              disabled={isBusy || !canRun(card.primary)}
              onClick={() => void run(card, card.primary)}
            >
              {card.primary.label}
            </button>
            {card.secondary && (
              <button
                type="button"
                className="calm-today-button"
                title={card.secondary.hint}
                disabled={isBusy || !canRun(card.secondary)}
                onClick={() => void run(card, card.secondary!)}
              >
                {card.secondary.label}
              </button>
            )}
            {card.more?.map((button) => (
              <button
                key={button.label}
                type="button"
                className="calm-today-button quiet"
                title={button.hint}
                disabled={isBusy || !canRun(button)}
                onClick={() => void run(card, button)}
              >
                {button.label}
              </button>
            ))}
          </div>
        )}
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
          {visible.map((card) => renderCard(card, card.offer ? "idea" : "decision"))}
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
                <span className="calm-today-handled-outcome">
                  {row.undoSend && row.undoSend.until > now ? "Sending" : row.outcome}
                </span>
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
                  <div
                    className="calm-today-handled-row"
                    title={row.detail ? `${row.title}\n${row.detail}` : row.title}
                  >
                    {content}
                    {row.undo && (
                      <button
                        type="button"
                        className="calm-today-handled-undo"
                        disabled={busy === row.id}
                        aria-label={`Undo: reopen "${row.title}"`}
                        onClick={() => void undoRow(row)}
                      >
                        Undo
                      </button>
                    )}
                    {row.undoSend && row.undoSend.until > now && (
                      <button
                        type="button"
                        className="calm-today-handled-undo"
                        disabled={busy === row.id}
                        aria-label={`Undo: don't send the reply to "${row.title}"`}
                        onClick={() => void undoSendRow(row)}
                      >
                        Undo
                      </button>
                    )}
                  </div>
                )}
                {errors[row.id] && (
                  <p className="calm-today-handled-error" role="alert">
                    {errors[row.id]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
