import type { ProactiveSuggestion, SuggestionType } from "../../shared/types";
import type { HomeSessionSummary, HomeSessions } from "./home-sessions";

/**
 * The Calm home "Today" stack: what needs the user, already prepared as one card each
 * with one decision, then what was handled without them.
 *
 * Every card action goes through an existing path: opening a session (where its own
 * approval or question UI takes over), starting a suggestion's prompt as a new task
 * (the prompt is shown on the card first), snoozing a suggestion, or marking a
 * commitment done. Nothing here runs anything on its own.
 */

export type HomeTodayKind = "session" | "commitment" | "suggestion";

export type HomeTodayAction =
  | { type: "open-session"; taskId: string }
  | {
      type: "start-suggestion";
      workspaceId: string;
      suggestionId: string;
      title: string;
      prompt: string;
    }
  | { type: "snooze-suggestion"; workspaceId: string; suggestionId: string }
  | { type: "complete-commitment"; commitmentId: string }
  | { type: "draft-prompt"; prompt: string };

export interface HomeTodayButton {
  label: string;
  action: HomeTodayAction;
}

export type HomeTodayIcon =
  | "approval"
  | "question"
  | "resume"
  | "blocked"
  | "commitment"
  | SuggestionType;

export interface HomeTodayCard {
  /** Stable across refreshes: `${kind}:${source id}`. */
  id: string;
  kind: HomeTodayKind;
  icon: HomeTodayIcon;
  /** Where it comes from, e.g. "Session", "Commitment", "Follow-up". */
  source: string;
  /** Where it stands, e.g. "Approval needed", "Due today". */
  state: string;
  title: string;
  /** One line on why it is here. */
  why: string;
  at: number;
  /** The exact prompt a "Start" button will run, shown before it runs. */
  preview?: { label: string; text: string };
  primary: HomeTodayButton;
  secondary?: HomeTodayButton;
}

export interface HomeTodayHandledRow {
  id: string;
  title: string;
  /** Short outcome shown on the right, e.g. "Done", "Started". */
  outcome: string;
  at: number;
  /** Session to open when the row is clicked. */
  taskId?: string;
}

/** A suggestion as the home loads it: the shared shape plus where it lives. */
export interface HomeTodaySuggestion extends ProactiveSuggestion {
  workspaceId: string;
  workspaceName?: string;
}

/** The fields the home reads from a due-soon commitment. */
export interface HomeTodayCommitment {
  id: string;
  text: string;
  dueAt?: number;
  lastTaskId?: string;
}

export interface HomeToday {
  /** Everything waiting on the user, most pressing first. */
  needsYou: HomeTodayCard[];
  /** One lower-key suggestion, offered when there is room. */
  idea: HomeTodayCard | null;
  handled: HomeTodayHandledRow[];
}

export const EMPTY_HOME_TODAY: HomeToday = { needsYou: [], idea: null, handled: [] };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Commitments become cards once they are due within this window, or overdue. */
export const HOME_COMMITMENT_WINDOW_HOURS = 24;
const MAX_WHY_CHARS = 180;
const MAX_PREVIEW_CHARS = 320;
const MAX_HANDLED_ROWS = 5;

const SUGGESTION_SOURCE: Record<SuggestionType, string> = {
  follow_up: "Follow-up",
  recurring_pattern: "Pattern",
  goal_aligned: "Goal",
  insight: "Insight",
  reverse_prompt: "Idea",
};

const SESSION_COPY: Record<string, { icon: HomeTodayIcon; why: string; primary: string }> = {
  "Approval needed": {
    icon: "approval",
    why: "It paused before a step that needs your OK.",
    primary: "Review",
  },
  "Response needed": {
    icon: "question",
    why: "It has a question for you before it can go on.",
    primary: "Reply",
  },
  "Resume available": {
    icon: "resume",
    why: "It stopped early and can pick up where it left off.",
    primary: "Open",
  },
  "Action needed": {
    icon: "blocked",
    why: "It's blocked until you step in.",
    primary: "Open",
  },
  Paused: { icon: "resume", why: "It's paused, waiting for you to continue.", primary: "Open" },
};

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Plain text from a short markdown description: no emphasis marks, links or headings. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Overdue", "Due today", "Due tomorrow", or "Due Thu". */
export function commitmentDueState(dueAt: number, now: number): string {
  if (dueAt < now) return "Overdue";
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY_MS);
  if (days <= 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${new Date(dueAt).toLocaleDateString(undefined, { weekday: "short" })}`;
}

function commitmentWhy(dueAt: number, now: number): string {
  if (dueAt < now) {
    const days = Math.round((startOfDay(now) - startOfDay(dueAt)) / DAY_MS);
    const when =
      days <= 0 ? `at ${formatClock(dueAt)}` : days === 1 ? "yesterday" : `${days} days ago`;
    return `You said you'd do this. It was due ${when}.`;
  }
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY_MS);
  const day =
    days <= 0
      ? "today"
      : days === 1
        ? "tomorrow"
        : `on ${new Date(dueAt).toLocaleDateString(undefined, { weekday: "short" })}`;
  return `You said you'd do this by ${formatClock(dueAt)} ${day}.`;
}

function sessionCard(session: HomeSessionSummary): HomeTodayCard {
  const label = session.attention || "Action needed";
  const copy = SESSION_COPY[label] || SESSION_COPY["Action needed"];
  return {
    id: `session:${session.id}`,
    kind: "session",
    icon: copy.icon,
    source: "Session",
    state: label,
    title: session.title,
    why: copy.why,
    at: session.updatedAt,
    primary: { label: copy.primary, action: { type: "open-session", taskId: session.id } },
  };
}

function commitmentCard(commitment: HomeTodayCommitment, now: number): HomeTodayCard | null {
  const text = clip(commitment.text || "", 160);
  if (!text || typeof commitment.dueAt !== "number") return null;
  return {
    id: `commitment:${commitment.id}`,
    kind: "commitment",
    icon: "commitment",
    source: "Commitment",
    state: commitmentDueState(commitment.dueAt, now),
    title: text,
    why: commitmentWhy(commitment.dueAt, now),
    at: commitment.dueAt,
    primary: {
      label: "Mark done",
      action: { type: "complete-commitment", commitmentId: commitment.id },
    },
    secondary: {
      label: "Work on it",
      action: { type: "draft-prompt", prompt: `Help me finish this commitment: ${text}` },
    },
  };
}

function suggestionCard(suggestion: HomeTodaySuggestion, urgent: boolean): HomeTodayCard | null {
  const prompt = suggestion.actionPrompt?.trim();
  const title = clip(plain(suggestion.title || ""), 140);
  if (!prompt || !title) return null;
  return {
    id: `suggestion:${suggestion.id}`,
    kind: "suggestion",
    icon: suggestion.type,
    source: SUGGESTION_SOURCE[suggestion.type] || "Suggestion",
    state: urgent ? "Needs you" : "Suggested",
    title,
    why: clip(plain(suggestion.description || ""), MAX_WHY_CHARS),
    at: suggestion.createdAt,
    preview: { label: "Will run", text: clip(prompt, MAX_PREVIEW_CHARS) },
    primary: {
      label: "Start",
      action: {
        type: "start-suggestion",
        workspaceId: suggestion.workspaceId,
        suggestionId: suggestion.id,
        title,
        prompt,
      },
    },
    secondary: {
      label: "Not now",
      action: {
        type: "snooze-suggestion",
        workspaceId: suggestion.workspaceId,
        suggestionId: suggestion.id,
      },
    },
  };
}

function isUrgentSuggestion(suggestion: ProactiveSuggestion): boolean {
  return suggestion.urgency === "high" || suggestion.recommendedDelivery === "nudge";
}

/**
 * Builds the Today stack. `resolved` holds card ids the user already acted on in this
 * view, so a card doesn't come back before the next load confirms it is gone, and
 * `actedRows` are the rows those actions left behind.
 */
export function buildHomeToday(input: {
  sessions: HomeSessions;
  suggestions: readonly HomeTodaySuggestion[];
  commitments: readonly HomeTodayCommitment[];
  now: number;
  resolved?: ReadonlySet<string>;
  actedRows?: readonly HomeTodayHandledRow[];
}): HomeToday {
  const { sessions, now } = input;
  const resolved = input.resolved ?? new Set<string>();
  const keep = (card: HomeTodayCard | null): card is HomeTodayCard =>
    card !== null && !resolved.has(card.id);

  const sessionCards = sessions.needsYou.map(sessionCard).filter(keep);

  const commitmentCards = input.commitments
    .map((commitment) => commitmentCard(commitment, now))
    .filter(keep)
    .sort((a, b) => a.at - b.at);

  const ranked = [...input.suggestions].sort(
    (a, b) => (b.confidence || 0) - (a.confidence || 0) || b.createdAt - a.createdAt,
  );
  const urgentCards = ranked
    .filter(isUrgentSuggestion)
    .map((suggestion) => suggestionCard(suggestion, true))
    .filter(keep);
  const idea =
    ranked
      .filter((suggestion) => !isUrgentSuggestion(suggestion))
      .map((suggestion) => suggestionCard(suggestion, false))
      .find(keep) ?? null;

  const handled: HomeTodayHandledRow[] = [
    ...(input.actedRows ?? []),
    ...sessions.handled.map((session) => ({
      id: `handled:${session.id}`,
      title: session.title,
      outcome: "Done",
      at: session.updatedAt,
      taskId: session.id,
    })),
  ].slice(0, MAX_HANDLED_ROWS);

  const needsYou = [...sessionCards, ...commitmentCards, ...urgentCards];
  if (needsYou.length === 0 && !idea && handled.length === 0) return EMPTY_HOME_TODAY;
  return { needsYou, idea, handled };
}

/** "Good morning", "Good afternoon" or "Good evening", with the name when known. */
export function homeGreeting(now: Date, name?: string): string {
  const hour = now.getHours();
  const part =
    hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : "evening";
  const trimmed = name?.trim();
  return trimmed ? `Good ${part}, ${trimmed}` : `Good ${part}`;
}

/** "Monday, October 12". */
export function formatHomeDate(now: Date): string {
  return now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

/** The line under the greeting: how much needs the user, and whether the rest is handled. */
export function homeStatusLine(today: HomeToday): string | null {
  const count = today.needsYou.length;
  const handled = today.handled.length > 0;
  if (count === 0) {
    if (handled) return "Nothing needs you. The rest is handled.";
    return today.idea ? "Nothing needs you right now." : null;
  }
  const needs = count === 1 ? "1 thing needs you." : `${count} things need you.`;
  return handled ? `${needs} The rest is handled.` : needs;
}
