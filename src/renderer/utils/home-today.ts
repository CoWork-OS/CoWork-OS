import { rankAttention, type AttentionItem, type AttentionKind } from "../../shared/attention";
import type { SuggestionType } from "../../shared/types";
import type { HomeSessionSummary, HomeSessions } from "./home-sessions";

/**
 * The Calm home "Today" stack: what needs the user, already prepared as one card each
 * with one decision, then what was handled without them.
 *
 * Cards come from the shared attention queue (shared/attention.ts), merged with the waiting
 * sessions the renderer already knows so a new one shows before the queue reloads. Every
 * card action goes through an existing path: opening a session (where its own approval or
 * question UI takes over), opening an automation, starting a suggestion's prompt as a new
 * task (the prompt is shown on the card first), snoozing a suggestion, or marking a
 * commitment done. Nothing here runs anything on its own.
 */

export type HomeTodayKind = AttentionKind;

export type HomeTodayAction =
  | { type: "open-session"; taskId: string }
  | { type: "open-routine"; routineId: string }
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
  | "flow"
  | "commitment"
  | SuggestionType;

/** A short fact under the card's header: what started the work, where it runs, its risk. */
export interface HomeTodayChip {
  kind: "origin" | "place" | "risk";
  label: string;
}

export interface HomeTodayCard {
  /** Stable across refreshes: the attention item's id. */
  id: string;
  kind: HomeTodayKind;
  icon: HomeTodayIcon;
  /** Who is asking, or what the card is about, e.g. "Ops bot", "Commitment". */
  source: string;
  /** Where it stands, e.g. "Approval needed", "Due today". */
  state: string;
  title: string;
  /** One line on why it is here. */
  why: string;
  at: number;
  chips: HomeTodayChip[];
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

export interface HomeToday {
  /** Everything waiting on the user, most pressing first. */
  needsYou: HomeTodayCard[];
  /** One lower-key suggestion, offered when there is room. */
  idea: HomeTodayCard | null;
  handled: HomeTodayHandledRow[];
}

export const EMPTY_HOME_TODAY: HomeToday = { needsYou: [], idea: null, handled: [] };

const DAY_MS = 24 * 60 * 60 * 1000;
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

function weekday(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { weekday: "short" });
}

/** "Overdue", "Due today", "Due tomorrow", or "Due Thu". */
export function commitmentDueState(dueAt: number, now: number): string {
  if (dueAt < now) return "Overdue";
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY_MS);
  if (days <= 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${weekday(dueAt)}`;
}

function commitmentWhy(dueAt: number, now: number): string {
  if (dueAt < now) {
    const days = Math.round((startOfDay(now) - startOfDay(dueAt)) / DAY_MS);
    const when =
      days <= 0 ? `at ${formatClock(dueAt)}` : days === 1 ? "yesterday" : `${days} days ago`;
    return `You said you'd do this. It was due ${when}.`;
  }
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY_MS);
  const day = days <= 0 ? "today" : days === 1 ? "tomorrow" : `on ${weekday(dueAt)}`;
  return `You said you'd do this by ${formatClock(dueAt)} ${day}.`;
}

/** Facts worth a chip: only the ones that differ from "you started it, here". */
function chipsFor(item: AttentionItem): HomeTodayChip[] {
  const chips: HomeTodayChip[] = [];
  if (item.origin.kind !== "you" && item.origin.kind !== "memory") {
    chips.push({ kind: "origin", label: item.origin.label });
  }
  if (item.place.kind === "remote") chips.push({ kind: "place", label: item.place.label });
  if (item.risk === "high") chips.push({ kind: "risk", label: "High risk" });
  return chips;
}

function askerName(item: AttentionItem): string {
  return item.actor.kind === "you" ? "Your session" : item.actor.name;
}

function openSession(taskId: string, label: string): HomeTodayButton {
  return { label, action: { type: "open-session", taskId } };
}

/** The card for one attention item, or null when the item has nothing to decide here. */
export function cardForAttention(item: AttentionItem, now: number): HomeTodayCard | null {
  const base = { id: item.id, kind: item.kind, at: item.createdAt, chips: chipsFor(item) };
  switch (item.kind) {
    case "approval":
      if (!item.taskId) return null;
      return {
        ...base,
        icon: "approval",
        source: askerName(item),
        state: item.state,
        title: item.title,
        why: item.detail || "",
        primary: openSession(item.taskId, "Review"),
      };
    case "question":
      if (!item.taskId) return null;
      return {
        ...base,
        icon: "question",
        source: askerName(item),
        state: item.state,
        title: item.title,
        why: item.detail || "",
        primary: openSession(item.taskId, "Answer"),
      };
    case "session": {
      if (!item.taskId) return null;
      const copy = SESSION_COPY[item.state] || SESSION_COPY["Action needed"];
      return {
        ...base,
        icon: copy.icon,
        source: askerName(item),
        state: item.state,
        title: item.title,
        why: copy.why,
        primary: openSession(item.taskId, copy.primary),
      };
    }
    case "flow_approval":
      if (item.ref.type !== "workflow_step") return null;
      return {
        ...base,
        icon: "flow",
        source: item.actor.name,
        state: item.state,
        title: item.title,
        why: item.detail || "",
        primary: {
          label: "Review",
          action: { type: "open-routine", routineId: item.ref.routineId },
        },
      };
    case "commitment": {
      if (item.ref.type !== "commitment" || typeof item.dueAt !== "number") return null;
      return {
        ...base,
        at: item.dueAt,
        icon: "commitment",
        source: "Commitment",
        state: commitmentDueState(item.dueAt, now),
        title: item.title,
        why: commitmentWhy(item.dueAt, now),
        primary: {
          label: "Mark done",
          action: { type: "complete-commitment", commitmentId: item.ref.commitmentId },
        },
        secondary: {
          label: "Work on it",
          action: { type: "draft-prompt", prompt: `Help me finish this commitment: ${item.title}` },
        },
      };
    }
    case "suggestion": {
      if (item.ref.type !== "suggestion" || !item.prompt) return null;
      const { suggestionId, workspaceId } = item.ref;
      const type = item.suggestionType;
      return {
        ...base,
        icon: type ?? "insight",
        source: (type && SUGGESTION_SOURCE[type]) || "Suggestion",
        state: item.state,
        title: clip(plain(item.title), 140),
        why: clip(plain(item.detail || ""), 180),
        preview: { label: "Will run", text: clip(item.prompt, MAX_PREVIEW_CHARS) },
        primary: {
          label: "Start",
          action: {
            type: "start-suggestion",
            workspaceId,
            suggestionId,
            title: clip(plain(item.title), 140),
            prompt: item.prompt,
          },
        },
        secondary: {
          label: "Not now",
          action: { type: "snooze-suggestion", workspaceId, suggestionId },
        },
      };
    }
  }
}

/** A waiting session the renderer knows about, as an attention item. */
function sessionAttention(session: HomeSessionSummary): AttentionItem {
  return {
    id: `session:${session.id}`,
    kind: "session",
    state: session.attention || "Action needed",
    title: session.title,
    createdAt: session.updatedAt,
    urgent: true,
    actor: { kind: "you", name: "You" },
    origin: { kind: "you", label: "You started it" },
    place: { kind: "local", label: "This device" },
    taskId: session.id,
    ref: { type: "task", taskId: session.id },
  };
}

/**
 * Builds the Today stack. `attention` is the shared queue's items, most pressing first.
 * Waiting sessions from `sessions` are added for tasks the queue does not cover yet.
 * `resolved` holds card ids the user already acted on in this view, so a card doesn't come
 * back before the next load confirms it is gone, and `actedRows` are the rows those actions
 * left behind.
 */
export function buildHomeToday(input: {
  attention: readonly AttentionItem[];
  sessions: HomeSessions;
  now: number;
  resolved?: ReadonlySet<string>;
  actedRows?: readonly HomeTodayHandledRow[];
}): HomeToday {
  const { now } = input;
  const resolved = input.resolved ?? new Set<string>();
  const coveredTasks = new Set(input.attention.map((item) => item.taskId).filter(Boolean));
  const items = rankAttention([
    ...input.attention,
    ...input.sessions.needsYou
      .filter((session) => !coveredTasks.has(session.id))
      .map(sessionAttention),
  ]);

  const needsYou: HomeTodayCard[] = [];
  let idea: HomeTodayCard | null = null;
  for (const item of items) {
    const card = cardForAttention(item, now);
    if (!card || resolved.has(card.id)) continue;
    if (item.kind === "suggestion" && !item.urgent) {
      idea ??= card;
      continue;
    }
    needsYou.push(card);
  }

  const handled: HomeTodayHandledRow[] = [
    ...(input.actedRows ?? []),
    // The queue is the authority on what still waits: a session it lists is never "handled",
    // even when the renderer's copy of the task has not caught up yet.
    ...input.sessions.handled
      .filter((session) => !coveredTasks.has(session.id))
      .map((session) => ({
        id: `handled:${session.id}`,
        title: session.title,
        outcome: "Done",
        at: session.updatedAt,
        taskId: session.id,
      })),
  ].slice(0, MAX_HANDLED_ROWS);

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
