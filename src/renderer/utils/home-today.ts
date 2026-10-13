import { rankAttention, type AttentionItem, type AttentionKind } from "../../shared/attention";
import { meetingPrepPrompt, type CalendarProposal } from "../../shared/calendar-proposals";
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
 * task (the prompt is shown on the card first), snoozing a suggestion, marking a
 * commitment done, or a calendar change the card names (the main process checks the
 * calendar again before making it). Nothing here runs anything on its own.
 */

export type HomeTodayKind = AttentionKind;

export type HomeTodayAction =
  | { type: "open-session"; taskId: string }
  /** Shows the approval's own review dialog here; opens the session when it can't. */
  | { type: "review-approval"; approvalId: string; taskId: string }
  /** Answers a single question with one of its options. */
  | { type: "answer-question"; requestId: string; questionId: string; optionLabel: string }
  | { type: "open-routine"; routineId: string }
  | {
      type: "start-suggestion";
      workspaceId: string;
      suggestionId: string;
      title: string;
      prompt: string;
    }
  | { type: "snooze-suggestion"; workspaceId: string; suggestionId: string }
  /** Never show this suggestion again. */
  | { type: "dismiss-suggestion"; workspaceId: string; suggestionId: string }
  /** Put the suggestion's prompt in the composer; sending it records whether it was edited. */
  | { type: "edit-suggestion"; workspaceId: string; suggestionId: string; prompt: string }
  /** Keep a follow-up suggestion as a commitment. */
  | { type: "add-commitment"; workspaceId: string; suggestionId: string }
  | { type: "complete-commitment"; commitmentId: string }
  | { type: "draft-prompt"; prompt: string }
  /** Hold the time or decline the event the calendar card names; `done` labels the row. */
  | { type: "accept-calendar"; proposalId: string; done: string }
  /** Stop showing a calendar card. */
  | { type: "dismiss-calendar"; proposalId: string }
  /** Start the meeting-prep prompt the card shows, then retire the card. */
  | { type: "prepare-meeting"; proposalId: string; title: string; prompt: string }
  /** Hold a free stretch on the calendar for a suggestion about making time. */
  | {
      type: "hold-for-suggestion";
      workspaceId: string;
      suggestionId: string;
      start: number;
      end: number;
    }
  | { type: "open-link"; url: string }
  /** Queue a drafted reply in the outbox; it goes out after the send delay unless undone. */
  | { type: "send-mail-draft"; draftId: string }
  /** Edit a drafted reply's text right on the card. */
  | { type: "edit-mail-draft"; draftId: string }
  | { type: "discard-mail-draft"; draftId: string }
  /** Take back a reply waiting in the outbox. */
  | { type: "undo-mail-send"; draftId: string }
  /** Turn reply drafts on or off. */
  | { type: "set-mail-drafts"; enabled: boolean }
  | { type: "dismiss-mail-offer" };

export interface HomeTodayButton {
  label: string;
  action: HomeTodayAction;
  /** More about the choice, shown as its tooltip. */
  hint?: string;
}

export type HomeTodayIcon =
  | "approval"
  | "question"
  | "resume"
  | "blocked"
  | "flow"
  | "commitment"
  | "calendar_hold"
  | "calendar_conflict"
  | "calendar_prep"
  | "mail_reply"
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
  /** A question's options, answered right on the card; the actions then only open the session. */
  choices?: HomeTodayButton[];
  /** Quieter actions after the main two (suggestions: Edit, Add as commitment, Dismiss). */
  more?: HomeTodayButton[];
  /** An offer, not a request: shown with the cards, but nothing counts it as needing you. */
  offer?: boolean;
  /** A drafted reply's id and text, which the card can edit. */
  mailDraft?: { draftId: string; bodyText: string };
}

export interface HomeTodayHandledRow {
  id: string;
  title: string;
  /** Short outcome shown on the right, e.g. "Done", "Started". */
  outcome: string;
  at: number;
  /** Session to open when the row is clicked. */
  taskId?: string;
  /** A commitment memory closed on its own, which the row can reopen. */
  undo?: { workspaceId: string; changeId: string };
  /** A reply waiting in the outbox, which the row can take back until it goes out. */
  undoSend?: { cardId: string; draftId: string; until: number };
  /** Why it was handled, for the row's tooltip. */
  detail?: string;
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
    // A question on record has its own card; this one only knows the session stopped for you.
    why: "It stopped and is waiting for you before it can go on.",
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

/** "today", "tomorrow" or "Thu". */
function dayWord(timestamp: number, now: number): string {
  const days = Math.round((startOfDay(timestamp) - startOfDay(now)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return weekday(timestamp);
}

/** "today", "tomorrow" or "on Thu". */
function dayPhrase(timestamp: number, now: number): string {
  const word = dayWord(timestamp, now);
  return word === "today" || word === "tomorrow" ? word : `on ${word}`;
}

/** A button label for holding time, e.g. "Hold 2:00 PM tomorrow". */
function holdLabel(start: number, now: number): string {
  return `Hold ${formatClock(start)} ${dayWord(start, now)}`;
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

function namesList(names: readonly string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

function calendarCard(
  item: AttentionItem,
  proposal: CalendarProposal,
  base: Pick<HomeTodayCard, "id" | "kind" | "at" | "chips">,
  now: number,
): HomeTodayCard {
  const common = {
    ...base,
    // "From your calendar" would only repeat the source.
    chips: base.chips.filter((chip) => chip.kind !== "origin"),
    source: "Calendar",
    state: item.state,
    title: item.title,
    ...(item.urgent ? {} : { offer: true }),
  };
  const dismiss = (label: string): HomeTodayButton => ({
    label,
    action: { type: "dismiss-calendar", proposalId: proposal.id },
  });
  switch (proposal.kind) {
    case "focus_hold":
      return {
        ...common,
        icon: "calendar_hold",
        why:
          `It's due by ${formatClock(proposal.dueAt)} ${dayPhrase(proposal.dueAt, now)}. ` +
          `You're free ${dayPhrase(proposal.start, now)} ` +
          `${formatClock(proposal.start)}–${formatClock(proposal.end)}.`,
        primary: {
          label: holdLabel(proposal.start, now),
          hint: "Adds a private, busy block to your calendar. Nobody is invited.",
          action: { type: "accept-calendar", proposalId: proposal.id, done: "Time held" },
        },
        secondary: dismiss("Not now"),
      };
    case "conflict": {
      const { first, second } = proposal;
      const link = second.htmlLink || first.htmlLink;
      const openLink: HomeTodayButton | null = link
        ? { label: "Open in Calendar", action: { type: "open-link", url: link } }
        : null;
      const why =
        `${first.title} runs ${formatClock(first.start)}–${formatClock(first.end)} and ` +
        `${second.title} ${formatClock(second.start)}–${formatClock(second.end)}, ` +
        `${dayPhrase(first.start, now)}.`;
      if (proposal.canDeclineSecond) {
        return {
          ...common,
          icon: "calendar_conflict",
          why,
          primary: {
            label: `Decline ${clip(second.title, 40)}`,
            hint: "Declines the invitation and lets the organizer know.",
            action: { type: "accept-calendar", proposalId: proposal.id, done: "Declined" },
          },
          secondary: dismiss("Keep both"),
          ...(openLink ? { more: [openLink] } : {}),
        };
      }
      // The user organizes the later event, or isn't on its guest list: CoWork won't change it.
      return {
        ...common,
        icon: "calendar_conflict",
        why,
        primary: openLink ?? dismiss("Got it"),
        ...(openLink ? { secondary: dismiss("Keep both") } : {}),
      };
    }
    case "meeting_prep": {
      const prompt = meetingPrepPrompt(
        proposal,
        (at) => `${formatClock(at)} ${dayPhrase(at, now)}`,
      );
      const people = proposal.attendees.length > 0 ? ` with ${namesList(proposal.attendees)}` : "";
      return {
        ...common,
        icon: "calendar_prep",
        why: `It starts ${dayPhrase(proposal.event.start, now)} at ${formatClock(proposal.event.start)}${people}.`,
        // The whole prompt, exactly as it will run.
        preview: { label: "Will run", text: prompt },
        primary: {
          label: "Prepare",
          action: {
            type: "prepare-meeting",
            proposalId: proposal.id,
            title: clip(`Prep: ${proposal.event.title}`, 140),
            prompt,
          },
        },
        secondary: dismiss("Not now"),
      };
    }
  }
}

/** The card for one attention item, or null when the item has nothing to decide here. */
export function cardForAttention(item: AttentionItem, now: number): HomeTodayCard | null {
  const base = { id: item.id, kind: item.kind, at: item.createdAt, chips: chipsFor(item) };
  switch (item.kind) {
    case "approval":
      if (!item.taskId || item.ref.type !== "approval") return null;
      return {
        ...base,
        icon: "approval",
        source: askerName(item),
        state: item.state,
        title: item.title,
        why: item.detail || "",
        primary: {
          label: "Review",
          action: { type: "review-approval", approvalId: item.ref.approvalId, taskId: item.taskId },
        },
        secondary: openSession(item.taskId, "Open session"),
      };
    case "question": {
      if (!item.taskId || item.ref.type !== "input_request") return null;
      const { requestId } = item.ref;
      const choices = item.choices;
      return {
        ...base,
        icon: "question",
        source: askerName(item),
        state: item.state,
        title: item.title,
        why: item.detail || "",
        // A question with plain options is answered right here; the rest open the session.
        ...(choices
          ? {
              choices: choices.options.map((option) => ({
                label: option.label,
                ...(option.description ? { hint: option.description } : {}),
                action: {
                  type: "answer-question" as const,
                  requestId,
                  questionId: choices.questionId,
                  optionLabel: option.label,
                },
              })),
              primary: openSession(item.taskId, "Open session"),
            }
          : { primary: openSession(item.taskId, "Answer") }),
      };
    }
    case "session": {
      if (!item.taskId) return null;
      const copy = SESSION_COPY[item.state] || SESSION_COPY["Action needed"];
      return {
        ...base,
        icon: copy.icon,
        source: askerName(item),
        state: item.state,
        title: item.title,
        why: item.detail || copy.why,
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
        preview: { label: "Will run", text: item.prompt },
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
        more: [
          // A suggestion about making time can hold a free stretch on the calendar.
          ...(item.calendarHold
            ? [
                {
                  label: holdLabel(item.calendarHold.start, now),
                  hint: "Adds a private, busy block to your calendar. Nobody is invited.",
                  action: {
                    type: "hold-for-suggestion" as const,
                    workspaceId,
                    suggestionId,
                    start: item.calendarHold.start,
                    end: item.calendarHold.end,
                  },
                },
              ]
            : []),
          {
            label: "Edit",
            action: { type: "edit-suggestion", workspaceId, suggestionId, prompt: item.prompt },
          },
          // A follow-up is something the user means to do: it can be kept as a commitment.
          ...(type === "follow_up"
            ? [
                {
                  label: "Add as commitment",
                  action: { type: "add-commitment" as const, workspaceId, suggestionId },
                },
              ]
            : []),
          {
            label: "Dismiss",
            action: { type: "dismiss-suggestion", workspaceId, suggestionId },
          },
        ],
      };
    }
    case "memory_change":
      // Handled work, not a decision: Today lists it with the handled rows.
      return null;
    case "calendar":
      if (item.ref.type !== "calendar_proposal" || !item.calendar) return null;
      return calendarCard(item, item.calendar, base, now);
    case "mail_reply":
      return mailReplyCard(item, base);
  }
}

function mailReplyCard(
  item: AttentionItem,
  base: Pick<HomeTodayCard, "id" | "kind" | "at" | "chips">,
): HomeTodayCard | null {
  const common = {
    ...base,
    // "From your inbox" would only repeat the source.
    chips: base.chips.filter((chip) => chip.kind !== "origin"),
    icon: "mail_reply" as const,
    source: "Mail",
    state: item.state,
    title: item.title,
    why: item.detail || "",
  };
  if (item.ref.type === "mail_offer") {
    return {
      ...common,
      offer: true,
      primary: { label: "Turn on", action: { type: "set-mail-drafts", enabled: true } },
      secondary: { label: "Not now", action: { type: "dismiss-mail-offer" } },
    };
  }
  if (item.ref.type !== "mail_draft" || !item.mailDraft) return null;
  const { draftId, bodyText, to, failed, copies, attachments, sendingUntil } = item.mailDraft;
  const extras = [
    copies > 0 ? `${copies} more in copy` : "",
    attachments > 0 ? (attachments === 1 ? "1 attachment" : `${attachments} attachments`) : "",
  ].filter(Boolean);
  // The whole reply and every recipient's address, exactly as it will be sent.
  const preview = {
    label: [to.length > 0 ? `To ${namesList(to)}` : "", ...extras].filter(Boolean).join(" · "),
    text: bodyText,
  };
  if (item.mailDraft.retrying) {
    return {
      ...common,
      offer: true,
      preview,
      primary: {
        label: "Cancel send",
        hint: "Stops the retries. The reply stays as a draft.",
        action: { type: "undo-mail-send", draftId },
      },
    };
  }
  if (sendingUntil) {
    return {
      ...common,
      why: `It goes out at ${formatClock(sendingUntil)}.`,
      // Waiting to go out is not a decision; it only stays undoable until then.
      offer: true,
      preview,
      primary: { label: "Undo send", action: { type: "undo-mail-send", draftId } },
    };
  }
  return {
    ...common,
    preview,
    mailDraft: { draftId, bodyText },
    primary: {
      label: failed ? "Send again" : "Send",
      hint: "Sends after a short delay. You can undo until then.",
      action: { type: "send-mail-draft", draftId },
    },
    secondary: { label: "Edit", action: { type: "edit-mail-draft", draftId } },
    more: [
      { label: "Discard draft", action: { type: "discard-mail-draft", draftId } },
      {
        label: "Stop drafting replies",
        hint: "No new drafts. The ones already made stay until you send or discard them.",
        action: { type: "set-mail-drafts", enabled: false },
      },
    ],
  };
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

  // A reply this view just sent already has a row with Undo; no second card for it.
  const sentHere = new Set(
    (input.actedRows ?? []).flatMap((row) => (row.undoSend ? [row.undoSend.draftId] : [])),
  );
  const needsYou: HomeTodayCard[] = [];
  let idea: HomeTodayCard | null = null;
  for (const item of items) {
    const card = cardForAttention(item, now);
    if (!card || resolved.has(card.id)) continue;
    if (item.mailDraft?.sendingUntil && sentHere.has(item.mailDraft.draftId)) continue;
    if (item.kind === "suggestion" && !item.urgent) {
      idea ??= card;
      continue;
    }
    needsYou.push(card);
  }

  // Commitments memory closed because they looked done: handled, but still undoable.
  const memoryRows: HomeTodayHandledRow[] = input.attention.flatMap((item) =>
    item.ref.type === "memory_change" && !resolved.has(item.id)
      ? [
          {
            id: item.id,
            title: item.title,
            outcome: "Closed for you",
            at: item.createdAt,
            undo: { workspaceId: item.ref.workspaceId, changeId: item.ref.changeId },
            detail: item.detail,
          },
        ]
      : [],
  );
  // A reply whose send failed is back as a card, so its "Sent" row would contradict it.
  const failedDrafts = new Set(
    input.attention.flatMap((item) => (item.mailDraft?.failed ? [item.mailDraft.draftId] : [])),
  );
  const handled: HomeTodayHandledRow[] = [
    ...(input.actedRows ?? []).filter(
      (row) => !row.undoSend || !failedDrafts.has(row.undoSend.draftId),
    ),
    ...[
      ...memoryRows,
      // The queue is the authority on what still waits: a session it lists is never
      // "handled", even when the renderer's copy of the task has not caught up yet.
      ...input.sessions.handled
        .filter((session) => !coveredTasks.has(session.id))
        .map((session) => ({
          id: `handled:${session.id}`,
          title: session.title,
          outcome: "Done",
          at: session.updatedAt,
          taskId: session.id,
        })),
    ].sort((a, b) => b.at - a.at),
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

/**
 * The line under the greeting: how much needs the user, and whether the rest is handled.
 * Offers (a suggested hold, meeting prep) are shown but not counted.
 */
export function homeStatusLine(today: HomeToday): string | null {
  const count = today.needsYou.filter((card) => !card.offer).length;
  const handled = today.handled.length > 0;
  if (count === 0) {
    if (handled) return "Nothing needs you. The rest is handled.";
    return today.idea || today.needsYou.length > 0 ? "Nothing needs you right now." : null;
  }
  const needs = count === 1 ? "1 thing needs you." : `${count} things need you.`;
  return handled ? `${needs} The rest is handled.` : needs;
}
