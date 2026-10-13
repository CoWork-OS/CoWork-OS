import { describe, expect, it, vi } from "vitest";
import { CalendarService, toCalendarEvent, type CalendarRequest } from "../CalendarService";

const NOW = Date.parse("2026-10-12T09:00:00Z");

function raw(id: string, start: string, end: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    summary: `Event ${id}`,
    start: { dateTime: start },
    end: { dateTime: end },
    ...extra,
  };
}

function service(
  respond: (request: CalendarRequest) => unknown = () => ({ items: [] }),
  overrides: { connected?: boolean; now?: () => number } = {},
) {
  const request = vi.fn(async (req: CalendarRequest) => ({ data: respond(req) }));
  const calendar = new CalendarService({
    isConnected: () => overrides.connected ?? true,
    request,
    now: overrides.now ?? (() => NOW),
  });
  return { calendar, request };
}

describe("toCalendarEvent", () => {
  it("reads times, attendees and links, and drops what it can't trust", () => {
    expect(
      toCalendarEvent(
        raw("a", "2026-10-12T10:00:00Z", "2026-10-12T11:00:00Z", {
          transparency: "transparent",
          htmlLink: "https://calendar.google.com/event?eid=a",
          attendees: [
            { email: "me@example.com", self: true, responseStatus: "accepted" },
            { email: "ana@example.com", displayName: "Ana", responseStatus: "bogus" },
            { displayName: "No address" },
          ],
        }),
      ),
    ).toEqual({
      id: "a",
      title: "Event a",
      start: Date.parse("2026-10-12T10:00:00Z"),
      end: Date.parse("2026-10-12T11:00:00Z"),
      allDay: false,
      transparent: true,
      attendees: [
        { email: "me@example.com", self: true, responseStatus: "accepted" },
        { email: "ana@example.com", name: "Ana" },
      ],
      htmlLink: "https://calendar.google.com/event?eid=a",
    });
    expect(
      toCalendarEvent(
        raw("b", "2026-10-12T10:00:00Z", "2026-10-12T11:00:00Z", {
          htmlLink: "javascript:alert(1)",
        }),
      ),
    ).not.toHaveProperty("htmlLink");
    expect(
      toCalendarEvent(
        raw("c", "2026-10-12T10:00:00Z", "2026-10-12T11:00:00Z", { status: "cancelled" }),
      ),
    ).toBeNull();
    expect(toCalendarEvent({ id: "d", start: {}, end: {} })).toBeNull();
    expect(
      toCalendarEvent({ id: "e", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }),
    ).toMatchObject({ allDay: true });
  });
});

describe("CalendarService", () => {
  it("reads nothing when no calendar is connected", async () => {
    const { calendar, request } = service(undefined, { connected: false });
    await expect(calendar.listUpcoming()).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("reads upcoming events once, then from the cache until it is stale or fresh is asked", async () => {
    let now = NOW;
    const { calendar, request } = service(
      () => ({ items: [raw("a", "2026-10-12T10:00:00Z", "2026-10-12T11:00:00Z")] }),
      { now: () => now },
    );
    const [first, second] = await Promise.all([calendar.listUpcoming(), calendar.listUpcoming()]);
    expect(first.map((event) => event.id)).toEqual(["a"]);
    expect(second).toEqual(first);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toMatchObject({
      method: "GET",
      path: "/calendars/primary/events",
      query: { singleEvents: true, orderBy: "startTime", timeMin: "2026-10-12T09:00:00.000Z" },
    });

    now += 60_000;
    await calendar.listUpcoming();
    expect(request).toHaveBeenCalledOnce();
    await calendar.listUpcoming(3, { fresh: true });
    expect(request).toHaveBeenCalledTimes(2);
    now += 6 * 60_000;
    await calendar.listUpcoming();
    expect(request).toHaveBeenCalledTimes(3);
    // A longer window than the cache covers is read again.
    await calendar.listUpcoming(7);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("creates a private, busy hold with nobody invited", async () => {
    const { calendar, request } = service((req) =>
      req.method === "POST"
        ? raw("h", "2026-10-12T12:00:00Z", "2026-10-12T13:30:00Z")
        : { items: [] },
    );
    await calendar.listUpcoming();
    const created = await calendar.createHold({
      title: "  Focus:   Send the SOW ",
      start: Date.parse("2026-10-12T12:00:00Z"),
      end: Date.parse("2026-10-12T13:30:00Z"),
    });
    expect(created.id).toBe("h");
    const post = request.mock.calls[1][0];
    expect(post).toMatchObject({
      method: "POST",
      path: "/calendars/primary/events",
      body: {
        summary: "Focus: Send the SOW",
        transparency: "opaque",
        visibility: "private",
        start: { dateTime: "2026-10-12T12:00:00.000Z" },
        end: { dateTime: "2026-10-12T13:30:00.000Z" },
      },
    });
    expect(post.body).not.toHaveProperty("attendees");
    // The cache is dropped so the hold shows on the next read.
    await calendar.listUpcoming();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("declines an invitation and tells the organizer", async () => {
    const attendees = [
      { email: "boss@example.com", organizer: true, responseStatus: "accepted" },
      { email: "me@example.com", self: true, responseStatus: "accepted" },
    ];
    const { calendar, request } = service((req) =>
      req.method === "GET" ? { id: "e/1", attendees } : {},
    );
    await calendar.declineEvent("e/1");
    expect(request.mock.calls[0][0]).toEqual({
      method: "GET",
      path: "/calendars/primary/events/e%2F1",
    });
    expect(request.mock.calls[1][0]).toEqual({
      method: "PATCH",
      path: "/calendars/primary/events/e%2F1",
      query: { sendUpdates: "all" },
      body: {
        attendees: [attendees[0], { ...attendees[1], responseStatus: "declined" }],
      },
    });
  });

  it("refuses to decline an event the user organizes or wasn't invited to", async () => {
    const organizer = service(() => ({
      attendees: [{ email: "me@example.com", self: true, organizer: true }],
    }));
    await expect(organizer.calendar.declineEvent("e")).rejects.toThrow("invited to");
    const notInvited = service(() => ({ attendees: [{ email: "ana@example.com" }] }));
    await expect(notInvited.calendar.declineEvent("e")).rejects.toThrow("invited to");
    expect(organizer.request).toHaveBeenCalledOnce();
    expect(notInvited.request).toHaveBeenCalledOnce();
  });
});
