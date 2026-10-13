/**
 * Calendar cards for Today: what the user's calendar suggests they decide, worked out from
 * upcoming events and due commitments. Pure, so the main process builds proposals and the
 * same rules can be tested without a calendar.
 *
 * Proposals describe; they never act. Accepting one goes through the main process, which
 * recomputes the proposal from fresh events before changing anything.
 */

export interface CalendarEventAttendee {
  email: string;
  name?: string;
  self?: boolean;
  organizer?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  /** "Free" events (transparent) don't block time. */
  transparent?: boolean;
  attendees: CalendarEventAttendee[];
  htmlLink?: string;
}

export interface CalendarCommitment {
  id: string;
  text: string;
  dueAt: number;
}

export type CalendarProposal =
  | {
      kind: "focus_hold";
      id: string;
      /** The commitment the hold makes time for. */
      title: string;
      commitmentId: string;
      dueAt: number;
      start: number;
      end: number;
    }
  | {
      kind: "conflict";
      id: string;
      first: CalendarProposalEvent;
      second: CalendarProposalEvent;
      /** Whether the user is an invitee (not the organizer) of the second event and can decline it. */
      canDeclineSecond: boolean;
    }
  | {
      kind: "meeting_prep";
      id: string;
      event: CalendarProposalEvent;
      /** Other people in the meeting, by name or address. */
      attendees: string[];
    };

export interface CalendarProposalEvent {
  eventId: string;
  title: string;
  start: number;
  end: number;
  htmlLink?: string;
}

export interface CalendarWorkday {
  /** Local hour the working day starts, 0-23. */
  startHour: number;
  /** Local hour the working day ends, 1-24. */
  endHour: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const FOCUS_HOLD_MINUTES = 90;
const SLOT_STEP_MINUTES = 30;
const LOOKAHEAD_MS = 72 * HOUR;
const PREP_WINDOW_MS = 24 * HOUR;
/** Too close to prepare for, or already starting. */
const PREP_MIN_LEAD_MS = 15 * MINUTE;
const LIMITS = { conflicts: 3, prep: 3, holds: 2 } as const;
export const DEFAULT_WORKDAY: CalendarWorkday = { startHour: 9, endHour: 18 };

function declinedBySelf(event: CalendarEvent): boolean {
  return event.attendees.some((a) => a.self && a.responseStatus === "declined");
}

/** Events that take the user's time: timed, not marked free, not declined. */
export function blockingEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  return events.filter(
    (event) =>
      !event.allDay &&
      !event.transparent &&
      !declinedBySelf(event) &&
      Number.isFinite(event.start) &&
      Number.isFinite(event.end) &&
      event.end > event.start,
  );
}

function toProposalEvent(event: CalendarEvent): CalendarProposalEvent {
  return {
    eventId: event.id,
    title: event.title || "Untitled event",
    start: event.start,
    end: event.end,
    ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
  };
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * The earliest free stretch of `minutes` between `from` and `to`, inside working hours,
 * starting on a half-hour. Null when there is none.
 */
export function findFreeSlot(
  events: readonly CalendarEvent[],
  from: number,
  to: number,
  minutes = FOCUS_HOLD_MINUTES,
  workday: CalendarWorkday = DEFAULT_WORKDAY,
): { start: number; end: number } | null {
  const busy = blockingEvents(events);
  const length = minutes * MINUTE;
  const step = SLOT_STEP_MINUTES * MINUTE;
  const first = new Date(Math.ceil(from / step) * step);
  for (let start = first.getTime(); start + length <= to; start += step) {
    const day = new Date(start);
    const dayStart = new Date(day).setHours(workday.startHour, 0, 0, 0);
    const dayEnd = new Date(day).setHours(workday.endHour, 0, 0, 0);
    if (start < dayStart || start + length > dayEnd) continue;
    const slot = { start, end: start + length };
    if (!busy.some((event) => overlaps(event, slot))) return slot;
  }
  return null;
}

/** Whether a stretch is still free, e.g. before booking a hold the user saw a minute ago. */
export function isSlotFree(
  events: readonly CalendarEvent[],
  slot: { start: number; end: number },
): boolean {
  return !blockingEvents(events).some((event) => overlaps(event, slot));
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Proposals for the next few days:
 * - conflicts between two events that both take the user's time;
 * - meeting prep for meetings with other people in the next day;
 * - a focus hold before a commitment that's due soon, in the first free working stretch,
 *   unless the calendar already has time for it.
 * `dismissed` and `accepted` ids are left out.
 */
export function buildCalendarProposals(input: {
  events: readonly CalendarEvent[];
  commitments: readonly CalendarCommitment[];
  now: number;
  workday?: CalendarWorkday;
  skip?: ReadonlySet<string>;
}): CalendarProposal[] {
  const { now } = input;
  const skip = input.skip ?? new Set<string>();
  const upcoming = blockingEvents(input.events)
    .filter((event) => event.end > now && event.start < now + LOOKAHEAD_MS)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

  const conflicts: CalendarProposal[] = [];
  for (let i = 0; i < upcoming.length && conflicts.length < LIMITS.conflicts; i++) {
    for (let j = i + 1; j < upcoming.length && conflicts.length < LIMITS.conflicts; j++) {
      const [first, second] = [upcoming[i], upcoming[j]];
      if (second.start >= first.end) break;
      if (!overlaps(first, second)) continue;
      const id = `conflict:${[first.id, second.id].sort().join(":")}`;
      if (skip.has(id)) continue;
      const self = second.attendees.find((a) => a.self);
      conflicts.push({
        kind: "conflict",
        id,
        first: toProposalEvent(first),
        second: toProposalEvent(second),
        canDeclineSecond: Boolean(self && !self.organizer),
      });
    }
  }

  const prep: CalendarProposal[] = upcoming
    .filter(
      (event) =>
        event.start >= now + PREP_MIN_LEAD_MS &&
        event.start <= now + PREP_WINDOW_MS &&
        event.attendees.filter((a) => !a.self).length >= 1,
    )
    .map((event): CalendarProposal => ({
      kind: "meeting_prep",
      id: `prep:${event.id}:${event.start}`,
      event: toProposalEvent(event),
      attendees: event.attendees
        .filter((a) => !a.self)
        .map((a) => a.name?.trim() || a.email)
        .slice(0, 8),
    }))
    .filter((proposal) => !skip.has(proposal.id))
    .slice(0, LIMITS.prep);

  const holds: CalendarProposal[] = [];
  const titles = upcoming.map((event) => normalized(event.title));
  for (const commitment of [...input.commitments].sort((a, b) => a.dueAt - b.dueAt)) {
    if (holds.length >= LIMITS.holds) break;
    if (commitment.dueAt <= now || commitment.dueAt > now + LOOKAHEAD_MS) continue;
    const id = `hold:${commitment.id}`;
    if (skip.has(id)) continue;
    const text = commitment.text.trim();
    if (!text) continue;
    // Time is already set aside for it.
    if (titles.some((title) => title.includes(normalized(text)))) continue;
    const slot = findFreeSlot(
      input.events,
      now + 30 * MINUTE,
      commitment.dueAt,
      FOCUS_HOLD_MINUTES,
      input.workday,
    );
    if (!slot) continue;
    holds.push({
      kind: "focus_hold",
      id,
      title: text,
      commitmentId: commitment.id,
      dueAt: commitment.dueAt,
      ...slot,
    });
  }

  return [...conflicts, ...holds, ...prep];
}

/** The prompt a meeting-prep card starts, shown on the card before it runs. */
export function meetingPrepPrompt(
  proposal: Extract<CalendarProposal, { kind: "meeting_prep" }>,
  formatTime: (at: number) => string,
): string {
  const people = proposal.attendees.length > 0 ? ` with ${proposal.attendees.join(", ")}` : "";
  return (
    `Prepare me for my meeting "${proposal.event.title}" at ${formatTime(proposal.event.start)}${people}. ` +
    "Gather the related emails, notes and open items, then give me a short brief: the goal, " +
    "what each person likely wants, open questions, and anything I owe them."
  );
}
