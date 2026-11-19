/**
 * Action cards: an approval for a calendar change shown as the event itself (title, time,
 * attendees, place) with buttons named for what happens ("Send invite"), instead of a line of
 * approval text. The main process builds the card from the request the tool will send, so the
 * card shows exactly what the approval covers. It is presentation only: the buttons still
 * answer with the approval's own option labels, and nothing on the card grants anything.
 */

export const ACTION_CARD_MAX_TITLE = 200;
export const ACTION_CARD_MAX_TEXT = 600;
export const ACTION_CARD_MAX_ATTENDEES = 12;

export type ActionCardTime = { dateTime?: string; date?: string };

export type ApprovalActionCard = {
  kind: "calendar_event";
  provider: "google_calendar" | "apple_calendar";
  operation: "create" | "update" | "delete";
  title: string;
  start?: ActionCardTime;
  end?: ActionCardTime;
  /** IANA zone the request names, shown when the times carry no offset of their own. */
  timeZone?: string;
  location?: string;
  description?: string;
  attendees: string[];
  /** Attendees beyond the ones listed, counted so none is hidden silently. */
  attendeesOmitted: number;
  /** Calendar the change lands in, when it is not the default one. */
  calendar?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Built from an escaped string: as a literal, the formatter turns the escapes into the
// invisible characters themselves.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f]", "g");

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function time(value: unknown): ActionCardTime | undefined {
  if (typeof value === "string") {
    const dateTime = text(value, 64);
    return dateTime ? { dateTime } : undefined;
  }
  const field = record(value);
  if (!field) return undefined;
  const dateTime = text(field.dateTime, 64);
  const date = text(field.date, 32);
  if (dateTime) return { dateTime };
  if (date) return { date };
  return undefined;
}

/** The first IANA-looking zone among the start's, the end's and an explicit one. */
function zone(start: unknown, end: unknown, explicit: unknown): string | undefined {
  for (const value of [record(start)?.timeZone, record(end)?.timeZone, explicit]) {
    const candidate = text(value, 64);
    if (candidate && /^[A-Za-z][A-Za-z_+\-/0-9]*$/.test(candidate)) return candidate;
  }
  return undefined;
}

function attendeeList(value: unknown): { attendees: string[]; attendeesOmitted: number } {
  if (!Array.isArray(value)) return { attendees: [], attendeesOmitted: 0 };
  const all = value
    .map((item) => {
      if (typeof item === "string") return text(item, 254);
      const entry = record(item);
      return text(entry?.displayName, 120) ?? text(entry?.email, 254);
    })
    .filter((item): item is string => Boolean(item));
  return {
    attendees: all.slice(0, ACTION_CARD_MAX_ATTENDEES),
    attendeesOmitted: Math.max(0, all.length - ACTION_CARD_MAX_ATTENDEES),
  };
}

const OPERATIONS: Record<string, ApprovalActionCard["operation"]> = {
  create_event: "create",
  update_event: "update",
  delete_event: "delete",
};

function calendarName(value: unknown): string | undefined {
  const name = text(value, 120);
  if (!name || name === "primary" || name === "(default)" || name === "(search)") return undefined;
  return name;
}

function eventCard(
  provider: ApprovalActionCard["provider"],
  operation: ApprovalActionCard["operation"],
  event: Record<string, unknown>,
  calendar: unknown,
): ApprovalActionCard | undefined {
  const title =
    text(event.summary, ACTION_CARD_MAX_TITLE) ??
    (operation === "create" ? undefined : "Calendar event");
  if (!title) return undefined;
  const start = time(event.start);
  const end = time(event.end);
  const timeZone = zone(event.start, event.end, event.timeZone);
  const location = text(event.location, ACTION_CARD_MAX_TEXT);
  const description = text(event.description, ACTION_CARD_MAX_TEXT);
  const calendarLabel = calendarName(calendar);
  return {
    kind: "calendar_event",
    provider,
    operation,
    title,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    ...attendeeList(event.attendees),
    ...(calendarLabel ? { calendar: calendarLabel } : {}),
  };
}

/**
 * The card for an approval's details, or undefined when the approval is not a calendar change
 * this card knows. Google Calendar cards come from the reviewed request (`reviewedEffect`), the
 * exact bytes the guarded send rechecks; Apple Calendar cards from the event the tool passes.
 */
export function approvalActionCardFromDetails(details: unknown): ApprovalActionCard | undefined {
  const value = record(details);
  if (!value) return undefined;

  const reviewed = record(value.reviewedEffect);
  if (reviewed?.version === 1 && reviewed.provider === "google_calendar") {
    const operation = OPERATIONS[String(reviewed.operation)];
    if (!operation) return undefined;
    // A deletion has no new event, so it shows the event as it stands before the change.
    const event = record(operation === "delete" ? reviewed.previousEvent : reviewed.event);
    return event ? eventCard("google_calendar", operation, event, reviewed.calendarId) : undefined;
  }

  const preview = record(value.calendarEventPreview);
  if (preview?.version === 1 && preview.provider === "apple_calendar") {
    const operation = OPERATIONS[String(preview.operation)];
    const event = record(preview.event);
    if (!operation || !event) return undefined;
    return eventCard("apple_calendar", operation, event, preview.calendar);
  }
  return undefined;
}

/** Revalidates a card that crossed a process boundary (stored questions, event payloads). */
export function normalizeApprovalActionCard(value: unknown): ApprovalActionCard | undefined {
  const card = record(value);
  if (!card || card.kind !== "calendar_event") return undefined;
  if (card.provider !== "google_calendar" && card.provider !== "apple_calendar") return undefined;
  if (card.operation !== "create" && card.operation !== "update" && card.operation !== "delete")
    return undefined;
  const rebuilt = eventCard(
    card.provider,
    card.operation,
    {
      summary: card.title,
      start: card.start,
      end: card.end,
      timeZone: card.timeZone,
      location: card.location,
      description: card.description,
      attendees: card.attendees,
    },
    card.calendar,
  );
  if (!rebuilt) return undefined;
  const omitted = Number(card.attendeesOmitted);
  rebuilt.attendeesOmitted += Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0;
  return rebuilt;
}

export function actionCardProviderLabel(card: ApprovalActionCard): string {
  return card.provider === "google_calendar" ? "Google Calendar" : "Apple Calendar";
}

/** What the primary button says: the effect itself, not "Allow once". */
export function actionCardVerbs(card: ApprovalActionCard): { allow: string; deny: string } {
  const invites = card.attendees.length + card.attendeesOmitted > 0;
  switch (card.operation) {
    case "create":
      return invites
        ? { allow: "Send invite", deny: "Don't send" }
        : { allow: "Add to calendar", deny: "Don't add" };
    case "update":
      return invites
        ? { allow: "Send update", deny: "Don't change" }
        : { allow: "Update event", deny: "Don't change" };
    case "delete":
      return { allow: "Delete event", deny: "Keep event" };
  }
}

/**
 * The label a card button shows for an approval option. Only the one-time allow and the plain
 * deny take the card's verbs: a broader grant ("Always allow", "Allow for this task") keeps its
 * own words so the person always sees how far it reaches.
 */
export function actionCardButtonLabel(card: ApprovalActionCard, optionLabel: string): string {
  const normalized = optionLabel.trim().toLowerCase();
  const verbs = actionCardVerbs(card);
  if (normalized === "allow once") return verbs.allow;
  if (normalized === "deny" || normalized === "deny once") return verbs.deny;
  return optionLabel;
}

/** The receipt line once the card is answered. Approval comes before the send, so it says so. */
export function actionCardReceipt(card: ApprovalActionCard, approved: boolean): string {
  const invites = card.attendees.length + card.attendeesOmitted > 0;
  if (!approved) {
    if (card.operation === "delete") return "Kept — not deleted";
    if (card.operation === "update") return "Not changed";
    return invites ? "Not sent" : "Not added";
  }
  if (card.operation === "delete") return "Approved — deleting";
  if (card.operation === "update")
    return invites ? "Approved — sending update" : "Approved — updating";
  return invites ? "Approved — sending invite" : "Approved — adding to calendar";
}

function parse(
  value: ActionCardTime | undefined,
  useWrittenClock: boolean,
): { at: Date; allDay: boolean } | undefined {
  if (!value) return undefined;
  if (value.date && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    const at = new Date(`${value.date}T00:00:00Z`);
    return Number.isNaN(at.getTime()) ? undefined : { at, allDay: true };
  }
  if (!value.dateTime) return undefined;
  // Use UTC to store written wall-clock fields without the viewer's clock changes.
  const ms = Date.parse(useWrittenClock ? `${value.dateTime}Z` : value.dateTime);
  return Number.isNaN(ms) ? undefined : { at: new Date(ms), allDay: false };
}

/** Whether a date-time names its own offset (Z or ±hh:mm); without one it is wall-clock time. */
function hasOffset(value: ActionCardTime | undefined): boolean {
  return Boolean(value?.dateTime && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.dateTime));
}

/**
 * "Tue, Nov 17 · 9:30 – 9:50 AM". Times with an offset are shown in the viewer's zone; wall-clock
 * times are shown as written with the zone the request names, so a 9:30 in Los Angeles is never
 * presented as a 9:30 here.
 */
export function formatActionCardWhen(
  card: Pick<ApprovalActionCard, "start" | "end" | "timeZone">,
  locale?: string,
  viewerTimeZone?: string,
): string {
  const useWrittenClock = Boolean(card.timeZone) && !hasOffset(card.start) && !hasOffset(card.end);
  const start = parse(card.start, useWrittenClock);
  const end = parse(card.end, useWrittenClock);
  if (!start) return "";
  const wallClock = !start.allDay && !hasOffset(card.start);
  const viewerZone = wallClock ? undefined : viewerTimeZone;
  // Calendar dates and wall-clock times keep their written fields in any viewer's zone.
  const timeZone = start.allDay || useWrittenClock ? "UTC" : viewerZone;
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
  const clock = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
  const zoneSuffix = wallClock && card.timeZone ? ` (${card.timeZone.replace(/_/g, " ")})` : "";

  if (start.allDay) {
    // All-day ends are exclusive in calendar APIs: Nov 17 → Nov 18 is the single day Nov 17.
    const lastDay = end?.allDay ? new Date(end.at.getTime() - 86_400_000) : undefined;
    if (!lastDay || lastDay.getTime() <= start.at.getTime())
      return `${day.format(start.at)} · All day`;
    return `${day.format(start.at)} – ${day.format(lastDay)} · All day`;
  }
  if (!end || end.allDay) return `${day.format(start.at)} · ${clock.format(start.at)}${zoneSuffix}`;
  const sameDay = day.format(start.at) === day.format(end.at);
  return sameDay
    ? `${day.format(start.at)} · ${clock.format(start.at)} – ${clock.format(end.at)}${zoneSuffix}`
    : `${day.format(start.at)} ${clock.format(start.at)} – ${day.format(end.at)} ${clock.format(end.at)}${zoneSuffix}`;
}
