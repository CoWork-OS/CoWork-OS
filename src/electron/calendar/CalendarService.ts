/**
 * The user's Google Calendar for Today's calendar cards: upcoming events (read often, so
 * cached briefly), and the two changes a card can make on the user's click: a private hold
 * on their own calendar, and declining an event they were invited to.
 *
 * Network and settings are injected so tests drive the service with plain functions.
 */
import {
  INVITE_NAME_MAX,
  INVITE_TITLE_MAX,
  cleanInviteText,
  type CalendarEvent,
  type CalendarEventAttendee,
} from "../../shared/calendar-proposals";

export interface CalendarRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export interface CalendarServiceDeps {
  /** Whether a calendar is connected with the access these reads and writes need. */
  isConnected: () => boolean;
  request: (request: CalendarRequest) => Promise<{ data?: unknown }>;
  /** The connected account; the cache is dropped when it changes. */
  accountKey?: () => string;
  now?: () => number;
}

/** Events are re-read at most this often; the queue snapshots far more often. */
const CACHE_MS = 5 * 60 * 1000;
/** Background reads (the queue's) give up quickly; a change the user asked for waits longer. */
const BACKGROUND_TIMEOUT_MS = 4000;
/** After a failed background read, the next ones fail fast for this long. */
const FAILURE_BACKOFF_MS = 60 * 1000;
const MAX_EVENTS = 100;
const HOLD_NOTE = "Held by CoWork OS so this has time on your calendar.";

type RawEvent = {
  id?: unknown;
  summary?: unknown;
  status?: unknown;
  transparency?: unknown;
  htmlLink?: unknown;
  start?: { dateTime?: unknown; date?: unknown };
  end?: { dateTime?: unknown; date?: unknown };
  attendees?: unknown;
};

function parseTime(value: { dateTime?: unknown; date?: unknown } | undefined): {
  at: number;
  allDay: boolean;
} {
  if (typeof value?.dateTime === "string") return { at: Date.parse(value.dateTime), allDay: false };
  if (typeof value?.date === "string") return { at: Date.parse(value.date), allDay: true };
  return { at: Number.NaN, allDay: false };
}

function parseAttendees(value: unknown): CalendarEventAttendee[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): CalendarEventAttendee[] => {
    if (!raw || typeof raw !== "object") return [];
    const attendee = raw as Record<string, unknown>;
    if (typeof attendee.email !== "string" || !attendee.email) return [];
    const status = attendee.responseStatus;
    const name =
      typeof attendee.displayName === "string"
        ? cleanInviteText(attendee.displayName, INVITE_NAME_MAX)
        : "";
    return [
      {
        email: cleanInviteText(attendee.email, 254),
        ...(name ? { name } : {}),
        ...(attendee.self === true ? { self: true } : {}),
        ...(attendee.organizer === true ? { organizer: true } : {}),
        ...(status === "needsAction" ||
        status === "declined" ||
        status === "tentative" ||
        status === "accepted"
          ? { responseStatus: status }
          : {}),
      },
    ];
  });
}

/** A Google Calendar event in the shape the proposals use; null for cancelled or broken ones. */
export function toCalendarEvent(raw: RawEvent): CalendarEvent | null {
  if (typeof raw?.id !== "string" || raw.status === "cancelled") return null;
  const start = parseTime(raw.start);
  const end = parseTime(raw.end);
  if (!Number.isFinite(start.at) || !Number.isFinite(end.at)) return null;
  return {
    id: raw.id,
    title: typeof raw.summary === "string" ? cleanInviteText(raw.summary, INVITE_TITLE_MAX) : "",
    start: start.at,
    end: end.at,
    allDay: start.allDay,
    ...(raw.transparency === "transparent" ? { transparent: true } : {}),
    attendees: parseAttendees(raw.attendees),
    ...(typeof raw.htmlLink === "string" && raw.htmlLink.startsWith("https://")
      ? { htmlLink: raw.htmlLink }
      : {}),
  };
}

export class CalendarService {
  private cache: { days: number; at: number; account: string; events: CalendarEvent[] } | null =
    null;
  private inFlight: Promise<CalendarEvent[]> | null = null;
  /** Bumped when the cache is dropped, so a read already under way doesn't refill it. */
  private generation = 0;
  private failedAt = 0;

  constructor(private readonly deps: CalendarServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  isConnected(): boolean {
    return this.deps.isConnected();
  }

  /**
   * Events between now and `days` ahead, from the cache when it is recent and covers the
   * window. `fresh` re-reads, for a change the user is about to make.
   */
  async listUpcoming(days = 3, opts: { fresh?: boolean } = {}): Promise<CalendarEvent[]> {
    if (!this.deps.isConnected()) return [];
    const now = this.now();
    const to = now + days * 24 * 60 * 60 * 1000;
    const account = this.deps.accountKey?.() ?? "";
    const cache = this.cache;
    if (
      !opts.fresh &&
      cache &&
      cache.account === account &&
      now - cache.at < CACHE_MS &&
      cache.days >= days
    ) {
      return cache.events.filter((event) => event.end > now && event.start < to);
    }
    if (!opts.fresh && now - this.failedAt < FAILURE_BACKOFF_MS) {
      throw new Error("The calendar couldn't be read a moment ago.");
    }
    if (!opts.fresh && this.inFlight) return this.inFlight;
    const generation = this.generation;
    const read = (async () => {
      try {
        const result = await this.deps.request({
          method: "GET",
          path: "/calendars/primary/events",
          query: {
            timeMin: new Date(now).toISOString(),
            timeMax: new Date(to).toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: MAX_EVENTS,
          },
          ...(opts.fresh ? {} : { timeoutMs: BACKGROUND_TIMEOUT_MS }),
        });
        const items = (result.data as { items?: unknown } | undefined)?.items;
        const events = (Array.isArray(items) ? items : [])
          .map((item) => toCalendarEvent(item as RawEvent))
          .filter((event): event is CalendarEvent => event !== null);
        if (generation === this.generation) this.cache = { days, at: now, account, events };
        this.failedAt = 0;
        return events;
      } catch (error) {
        if (!opts.fresh) this.failedAt = this.now();
        throw error;
      }
    })();
    if (!opts.fresh) this.inFlight = read;
    try {
      return await read;
    } finally {
      if (this.inFlight === read) this.inFlight = null;
    }
  }

  /** A private, busy hold on the user's own calendar; no one else is invited. */
  async createHold(hold: { title: string; start: number; end: number }): Promise<CalendarEvent> {
    const title = hold.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Focus time";
    const result = await this.deps.request({
      method: "POST",
      path: "/calendars/primary/events",
      body: {
        summary: title,
        description: HOLD_NOTE,
        start: { dateTime: new Date(hold.start).toISOString() },
        end: { dateTime: new Date(hold.end).toISOString() },
        transparency: "opaque",
        visibility: "private",
      },
    });
    this.invalidate();
    const created = toCalendarEvent(result.data as RawEvent);
    if (!created) throw new Error("The calendar did not return the new hold.");
    return created;
  }

  private invalidate(): void {
    this.cache = null;
    this.generation += 1;
  }

  /**
   * Declines an event the user was invited to; the organizer is told, as when the user
   * declines in their calendar. Refused for events the user organizes or isn't invited to.
   * Only the user's own response is sent, so guests changed meanwhile are left alone.
   */
  async declineEvent(eventId: string): Promise<void> {
    const path = `/calendars/primary/events/${encodeURIComponent(eventId)}`;
    const current = await this.deps.request({ method: "GET", path });
    const raw = current.data as (RawEvent & { organizer?: { self?: unknown } }) | undefined;
    const attendees = Array.isArray(raw?.attendees)
      ? (raw.attendees as Array<Record<string, unknown>>)
      : [];
    const self = attendees.find((attendee) => attendee?.self === true);
    if (
      !self ||
      self.organizer === true ||
      raw?.organizer?.self === true ||
      typeof self.email !== "string"
    ) {
      throw new Error("You can only decline an event you were invited to.");
    }
    await this.deps.request({
      method: "PATCH",
      path,
      query: { sendUpdates: "all" },
      body: {
        attendeesOmitted: true,
        attendees: [{ email: self.email, responseStatus: "declined" }],
      },
    });
    this.invalidate();
  }
}
