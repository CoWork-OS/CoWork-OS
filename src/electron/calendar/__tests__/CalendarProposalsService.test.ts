import { describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "../../../shared/calendar-proposals";
import {
  CalendarProposalsService,
  type CalendarProposalsDeps,
  type CalendarProposalsState,
} from "../CalendarProposalsService";

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();
const NOW = at(12, 9);
const DAY = 24 * 60 * 60 * 1000;
const me = { email: "me@example.com", self: true };

function event(id: string, start: number, end: number, extra: Partial<CalendarEvent> = {}) {
  return { id, title: `Event ${id}`, start, end, allDay: false, attendees: [], ...extra };
}

function setup(
  options: {
    events?: CalendarEvent[];
    connected?: boolean;
    state?: CalendarProposalsState;
    now?: () => number;
  } = {},
) {
  let state = options.state;
  const calendar = {
    isConnected: vi.fn(() => options.connected ?? true),
    listUpcoming: vi.fn(async () => options.events ?? []),
    createHold: vi.fn(async (hold: { title: string; start: number; end: number }) =>
      event("held", hold.start, hold.end, { title: hold.title }),
    ),
    declineEvent: vi.fn(async () => {}),
  };
  const deps: CalendarProposalsDeps = {
    calendar,
    listCommitments: () => [{ id: "c1", text: "Send the SOW", dueAt: at(13, 17) }],
    loadState: () => state,
    saveState: (next) => {
      state = next;
    },
    now: options.now ?? (() => NOW),
  };
  return { service: new CalendarProposalsService(deps), calendar, state: () => state };
}

const conflictEvents = (secondAttendees: CalendarEvent["attendees"]) => [
  event("a", at(12, 13), at(12, 14)),
  event("b", at(12, 13, 30), at(12, 14, 30), { attendees: secondAttendees }),
];

describe("CalendarProposalsService", () => {
  it("lists nothing without a calendar", async () => {
    const { service, calendar } = setup({ connected: false });
    await expect(service.list()).resolves.toEqual([]);
    expect(calendar.listUpcoming).not.toHaveBeenCalled();
  });

  it("hides a dismissed proposal for two weeks and forgets expired ones", async () => {
    const { service, state } = setup({ state: { hidden: { "hold:old": NOW - 1 } } });
    expect((await service.list()).map((p) => p.id)).toEqual(["hold:c1"]);
    service.dismiss("hold:c1");
    expect(state()).toEqual({ hidden: { "hold:c1": NOW + 14 * DAY } });
    expect(await service.list()).toEqual([]);
  });

  it("books the hold a focus card offered, from fresh events, and hides the card", async () => {
    const { service, calendar, state } = setup();
    await expect(service.accept("hold:c1")).resolves.toEqual({ ok: true, kind: "focus_hold" });
    expect(calendar.listUpcoming).toHaveBeenCalledWith(3, { fresh: true });
    expect(calendar.createHold).toHaveBeenCalledWith({
      title: "Focus: Send the SOW",
      start: at(12, 9, 30),
      end: at(12, 11),
    });
    expect(state()?.hidden).toHaveProperty("hold:c1");
  });

  it("says a proposal is gone when the calendar no longer suggests it", async () => {
    const { service, calendar } = setup();
    await expect(service.accept("conflict:a:b")).resolves.toMatchObject({
      ok: false,
      reason: "gone",
    });
    expect(calendar.createHold).not.toHaveBeenCalled();
    expect(calendar.declineEvent).not.toHaveBeenCalled();
  });

  it("declines the later event of a conflict only when the user was invited to it", async () => {
    const invited = setup({ events: conflictEvents([me]) });
    await expect(invited.service.accept("conflict:a:b")).resolves.toEqual({
      ok: true,
      kind: "conflict",
    });
    expect(invited.calendar.declineEvent).toHaveBeenCalledWith("b");

    const organizer = setup({ events: conflictEvents([{ ...me, organizer: true }]) });
    await expect(organizer.service.accept("conflict:a:b")).resolves.toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(organizer.calendar.declineEvent).not.toHaveBeenCalled();
    expect(organizer.state()).toBeUndefined();
  });

  it("reports a failed change or read without hiding the card", async () => {
    const { service, calendar, state } = setup();
    calendar.createHold.mockRejectedValueOnce(new Error("quota"));
    await expect(service.accept("hold:c1")).resolves.toEqual({
      ok: false,
      reason: "failed",
      message: "quota",
    });
    expect(state()).toBeUndefined();
    calendar.listUpcoming.mockRejectedValueOnce(new Error("offline"));
    await expect(service.accept("hold:c1")).resolves.toMatchObject({
      ok: false,
      reason: "failed",
    });
  });

  it("refuses everything when no calendar is connected", async () => {
    const { service } = setup({ connected: false });
    await expect(service.accept("hold:c1")).resolves.toMatchObject({ reason: "not_connected" });
    await expect(
      service.bookHold({ title: "x", start: NOW + DAY, end: NOW + DAY + 1000 }),
    ).resolves.toMatchObject({ reason: "not_connected" });
    await expect(service.suggestedHold()).resolves.toBeNull();
  });

  it("offers the first free 90 minutes for a suggestion's hold", async () => {
    const { service } = setup({ events: [event("busy", at(12, 9), at(12, 12))] });
    await expect(service.suggestedHold()).resolves.toEqual({
      start: at(12, 12),
      end: at(12, 13, 30),
    });
  });

  it("books a suggestion's hold only for a free, near, short stretch in the future", async () => {
    const { service, calendar } = setup({ events: [event("busy", at(12, 13), at(12, 14))] });
    const tryHold = (start: number, end: number) =>
      service.bookHold({ title: "Focus: x", start, end });
    await expect(tryHold(NOW - 1000, NOW + 1000)).resolves.toMatchObject({ reason: "not_allowed" });
    await expect(tryHold(at(12, 10), at(12, 14))).resolves.toMatchObject({ reason: "not_allowed" });
    await expect(tryHold(at(20, 10), at(20, 11))).resolves.toMatchObject({ reason: "not_allowed" });
    await expect(tryHold(at(12, 11), at(12, 10))).resolves.toMatchObject({ reason: "not_allowed" });
    await expect(tryHold(at(12, 13, 30), at(12, 15))).resolves.toMatchObject({ reason: "gone" });
    expect(calendar.createHold).not.toHaveBeenCalled();
    await expect(tryHold(at(12, 15), at(12, 16, 30))).resolves.toEqual({
      ok: true,
      kind: "focus_hold",
    });
    expect(calendar.listUpcoming).toHaveBeenLastCalledWith(8, { fresh: true });
    expect(calendar.createHold).toHaveBeenCalledWith({
      title: "Focus: x",
      start: at(12, 15),
      end: at(12, 16, 30),
    });
  });
});
