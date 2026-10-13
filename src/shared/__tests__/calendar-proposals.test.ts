import { describe, expect, it } from "vitest";
import {
  buildCalendarProposals,
  findFreeSlot,
  isSlotFree,
  meetingPrepPrompt,
  type CalendarEvent,
  type CalendarProposal,
} from "../calendar-proposals";

// Local times, so working hours mean the same in every time zone.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();
const NOW = at(12, 9);

function event(id: string, start: number, end: number, overrides: Partial<CalendarEvent> = {}) {
  return { id, title: `Event ${id}`, start, end, allDay: false, attendees: [], ...overrides };
}

const me = { email: "me@example.com", self: true };
const ana = { email: "ana@example.com", name: "Ana" };

describe("buildCalendarProposals", () => {
  it("flags two events that overlap, and whether the later one can be declined", () => {
    const proposals = buildCalendarProposals({
      events: [
        event("b", at(12, 14), at(12, 15), { attendees: [me, ana] }),
        event("a", at(12, 13, 30), at(12, 14, 30), {
          attendees: [{ ...me, organizer: true }],
        }),
      ],
      commitments: [],
      now: NOW,
    });
    const conflict = proposals.find((p) => p.kind === "conflict");
    expect(conflict).toMatchObject({
      id: "conflict:a:b",
      first: { eventId: "a" },
      second: { eventId: "b" },
      canDeclineSecond: true,
    });

    const own = buildCalendarProposals({
      events: [
        event("a", at(12, 13), at(12, 14)),
        event("b", at(12, 13, 30), at(12, 14), { attendees: [{ ...me, organizer: true }] }),
      ],
      commitments: [],
      now: NOW,
    });
    expect(own.find((p) => p.kind === "conflict")).toMatchObject({ canDeclineSecond: false });
  });

  it("ignores events that don't take time: declined, free, all-day", () => {
    const proposals = buildCalendarProposals({
      events: [
        event("a", at(12, 13), at(12, 14)),
        event("declined", at(12, 13), at(12, 14), {
          attendees: [{ ...me, responseStatus: "declined" }, ana],
        }),
        event("free", at(12, 13), at(12, 14), { transparent: true }),
        event("allday", at(12, 0), at(13, 0), { allDay: true }),
      ],
      commitments: [],
      now: NOW,
    });
    expect(proposals.filter((p) => p.kind === "conflict")).toEqual([]);
  });

  it("offers prep for meetings with other people later today, not ones about to start", () => {
    const proposals = buildCalendarProposals({
      events: [
        event("soon", at(12, 9, 10), at(12, 9, 40), { attendees: [me, ana] }),
        event("later", at(12, 15), at(12, 16), { attendees: [me, ana] }),
        event("alone", at(12, 16), at(12, 17), { attendees: [me] }),
        event("far", at(14, 10), at(14, 11), { attendees: [me, ana] }),
      ],
      commitments: [],
      now: NOW,
    });
    const prep = proposals.filter((p) => p.kind === "meeting_prep");
    expect(prep).toEqual([
      {
        kind: "meeting_prep",
        id: `prep:later:${at(12, 15)}`,
        event: { eventId: "later", title: "Event later", start: at(12, 15), end: at(12, 16) },
        attendees: ["Ana"],
      },
    ]);
  });

  it("holds the first free working stretch before a commitment is due", () => {
    const proposals = buildCalendarProposals({
      events: [event("busy", at(12, 9), at(12, 12))],
      commitments: [{ id: "c1", text: "Send the SOW", dueAt: at(13, 17) }],
      now: NOW,
    });
    expect(proposals).toEqual([
      {
        kind: "focus_hold",
        id: "hold:c1",
        title: "Send the SOW",
        commitmentId: "c1",
        dueAt: at(13, 17),
        start: at(12, 12),
        end: at(12, 13, 30),
      },
    ]);
  });

  it("skips commitments the calendar already has time for, and hidden proposals", () => {
    const events = [event("x", at(12, 13), at(12, 14), { title: "Work: send the SOW" })];
    expect(
      buildCalendarProposals({
        events,
        commitments: [{ id: "c1", text: "Send the  SOW", dueAt: at(13, 17) }],
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      buildCalendarProposals({
        events: [],
        commitments: [{ id: "c2", text: "Review deck", dueAt: at(13, 17) }],
        now: NOW,
        skip: new Set(["hold:c2"]),
      }),
    ).toEqual([]);
  });

  it("leaves out commitments already past due or far off", () => {
    expect(
      buildCalendarProposals({
        events: [],
        commitments: [
          { id: "late", text: "Late", dueAt: NOW - 1 },
          { id: "far", text: "Far", dueAt: at(20, 9) },
        ],
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe("findFreeSlot", () => {
  it("stays inside working hours and moves to the next day when today is full", () => {
    expect(findFreeSlot([], at(12, 17), at(14, 0))).toEqual({
      start: at(13, 9),
      end: at(13, 10, 30),
    });
    expect(findFreeSlot([], at(12, 17), at(12, 23))).toBeNull();
  });

  it("starts on the half hour", () => {
    expect(findFreeSlot([], at(12, 10, 5), at(12, 18), 30)).toEqual({
      start: at(12, 10, 30),
      end: at(12, 11),
    });
  });
});

describe("isSlotFree", () => {
  it("is false when a blocking event overlaps", () => {
    const events = [event("a", at(12, 13), at(12, 14))];
    expect(isSlotFree(events, { start: at(12, 13, 30), end: at(12, 15) })).toBe(false);
    expect(isSlotFree(events, { start: at(12, 14), end: at(12, 15) })).toBe(true);
  });
});

describe("meetingPrepPrompt", () => {
  it("names the meeting, its time and the people in it", () => {
    const proposal: Extract<CalendarProposal, { kind: "meeting_prep" }> = {
      kind: "meeting_prep",
      id: "prep:x:1",
      event: { eventId: "x", title: "Q4 review", start: 1, end: 2 },
      attendees: ["Ana", "ben@example.com"],
    };
    expect(meetingPrepPrompt(proposal, () => "3:00 PM today")).toMatch(
      /^Prepare me for my meeting "Q4 review" at 3:00 PM today with Ana, ben@example.com\. /,
    );
  });
});
