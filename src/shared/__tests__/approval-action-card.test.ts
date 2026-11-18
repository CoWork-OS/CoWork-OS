import { describe, expect, it } from "vitest";
import {
  ACTION_CARD_MAX_ATTENDEES,
  actionCardButtonLabel,
  actionCardReceipt,
  actionCardVerbs,
  approvalActionCardFromDetails,
  formatActionCardWhen,
  normalizeApprovalActionCard,
  type ApprovalActionCard,
} from "../approval-action-card";

function googleDetails(operation: string, event: Record<string, unknown>, extra = {}) {
  return {
    tool: "calendar_action",
    reviewedEffect: {
      version: 1,
      provider: "google_calendar",
      operation,
      calendarId: "primary",
      ...(operation === "delete_event" ? { previousEvent: event } : { event }),
      ...extra,
    },
  };
}

describe("approvalActionCardFromDetails", () => {
  it("draws a Google Calendar invite from the reviewed request", () => {
    const card = approvalActionCardFromDetails(
      googleDetails("create_event", {
        summary: "Proposal review with Sophie",
        start: { dateTime: "2026-11-17T09:30:00-08:00", timeZone: "America/Los_Angeles" },
        end: { dateTime: "2026-11-17T09:50:00-08:00", timeZone: "America/Los_Angeles" },
        location: "Zoom",
        attendees: [{ email: "sophie@example.com" }],
      }),
    );
    expect(card).toEqual({
      kind: "calendar_event",
      provider: "google_calendar",
      operation: "create",
      title: "Proposal review with Sophie",
      start: { dateTime: "2026-11-17T09:30:00-08:00" },
      end: { dateTime: "2026-11-17T09:50:00-08:00" },
      timeZone: "America/Los_Angeles",
      location: "Zoom",
      attendees: ["sophie@example.com"],
      attendeesOmitted: 0,
    });
  });

  it("shows a deletion as the event that stands before it", () => {
    const card = approvalActionCardFromDetails(
      googleDetails("delete_event", { summary: "Forecast call", start: { date: "2026-11-18" } }),
    );
    expect(card?.operation).toBe("delete");
    expect(card?.title).toBe("Forecast call");
    expect(card?.start).toEqual({ date: "2026-11-18" });
  });

  it("draws an Apple Calendar change from the preview the tool passes", () => {
    const card = approvalActionCardFromDetails({
      calendarEventPreview: {
        version: 1,
        provider: "apple_calendar",
        operation: "create_event",
        calendar: "Work",
        event: { summary: "Gym", start: "2026-11-18T07:00:00Z", end: "2026-11-18T08:00:00Z" },
      },
    });
    expect(card).toMatchObject({
      provider: "apple_calendar",
      operation: "create",
      title: "Gym",
      calendar: "Work",
      attendees: [],
    });
  });

  it("returns nothing for other approvals, unknown operations, or a new event with no title", () => {
    expect(approvalActionCardFromDetails({ command: "ls" })).toBeUndefined();
    expect(approvalActionCardFromDetails(null)).toBeUndefined();
    expect(
      approvalActionCardFromDetails({
        reviewedEffect: { version: 1, provider: "gmail", operation: "send_message", message: {} },
      }),
    ).toBeUndefined();
    expect(
      approvalActionCardFromDetails(googleDetails("list_events", { summary: "x" })),
    ).toBeUndefined();
    expect(
      approvalActionCardFromDetails(googleDetails("create_event", { start: "2026-11-17" })),
    ).toBeUndefined();
  });

  it("counts attendees past the cap instead of dropping them silently", () => {
    const attendees = Array.from({ length: ACTION_CARD_MAX_ATTENDEES + 3 }, (_, index) => ({
      email: `person${index}@example.com`,
    }));
    const card = approvalActionCardFromDetails(
      googleDetails("create_event", { summary: "All hands", attendees }),
    );
    expect(card?.attendees).toHaveLength(ACTION_CARD_MAX_ATTENDEES);
    expect(card?.attendeesOmitted).toBe(3);
  });

  it("strips control characters and bounds long text", () => {
    const card = approvalActionCardFromDetails(
      googleDetails("create_event", {
        summary: `Sync${String.fromCharCode(7)} ${"x".repeat(400)}`,
        location: `Room${String.fromCharCode(0)} 4`,
      }),
    );
    expect(card?.title.startsWith("Sync x")).toBe(true);
    expect(card?.title.length).toBeLessThanOrEqual(200);
    expect(card?.location).toBe("Room 4");
  });

  it("never takes a date string for a time zone", () => {
    const card = approvalActionCardFromDetails(
      googleDetails("create_event", { summary: "Offsite", start: "2026-11-17", end: "2026-11-18" }),
    );
    expect(card?.timeZone).toBeUndefined();
  });
});

describe("normalizeApprovalActionCard", () => {
  const card: ApprovalActionCard = {
    kind: "calendar_event",
    provider: "google_calendar",
    operation: "update",
    title: "Board prep",
    attendees: ["a@example.com"],
    attendeesOmitted: 2,
  };

  it("keeps a valid stored card as it was", () => {
    expect(normalizeApprovalActionCard(card)).toEqual(card);
  });

  it("refuses unknown kinds, providers and operations", () => {
    expect(normalizeApprovalActionCard({ ...card, kind: "email" })).toBeUndefined();
    expect(normalizeApprovalActionCard({ ...card, provider: "outlook" })).toBeUndefined();
    expect(normalizeApprovalActionCard({ ...card, operation: "send" })).toBeUndefined();
    expect(normalizeApprovalActionCard("card")).toBeUndefined();
  });

  it("ignores a bad omitted count", () => {
    expect(normalizeApprovalActionCard({ ...card, attendeesOmitted: -4 })?.attendeesOmitted).toBe(
      0,
    );
  });
});

describe("verbs and receipts", () => {
  const base: ApprovalActionCard = {
    kind: "calendar_event",
    provider: "google_calendar",
    operation: "create",
    title: "Review",
    attendees: [],
    attendeesOmitted: 0,
  };
  const invite = { ...base, attendees: ["sophie@example.com"] };

  it("names the effect: an invite is sent, a solo event is added", () => {
    expect(actionCardVerbs(invite)).toEqual({ allow: "Send invite", deny: "Don't send" });
    expect(actionCardVerbs(base)).toEqual({ allow: "Add to calendar", deny: "Don't add" });
    expect(actionCardVerbs({ ...base, operation: "delete" }).allow).toBe("Delete event");
  });

  it("renames only the one-time allow and the plain deny", () => {
    expect(actionCardButtonLabel(invite, "Allow once")).toBe("Send invite");
    expect(actionCardButtonLabel(invite, "Deny")).toBe("Don't send");
    // Broader grants keep their own words so their reach stays visible.
    expect(actionCardButtonLabel(invite, "Always allow")).toBe("Always allow");
    expect(actionCardButtonLabel(invite, "Allow for this task")).toBe("Allow for this task");
  });

  it("says approval, not delivery, on the receipt", () => {
    expect(actionCardReceipt(invite, true)).toBe("Approved — sending invite");
    expect(actionCardReceipt(invite, false)).toBe("Not sent");
    expect(actionCardReceipt({ ...base, operation: "delete" }, false)).toBe("Kept — not deleted");
  });
});

describe("formatActionCardWhen", () => {
  it("shows an offset time range in the viewer's zone on one day", () => {
    expect(
      formatActionCardWhen(
        {
          start: { dateTime: "2026-11-17T09:30:00-08:00" },
          end: { dateTime: "2026-11-17T09:50:00-08:00" },
        },
        "en-US",
        "America/Los_Angeles",
      ),
    ).toBe("Tue, Nov 17 · 9:30 AM – 9:50 AM");
  });

  it("shows wall-clock times as written, with the zone the request names", () => {
    expect(
      formatActionCardWhen(
        {
          start: { dateTime: "2026-11-17T09:30:00" },
          end: { dateTime: "2026-11-17T10:00:00" },
          timeZone: "America/Los_Angeles",
        },
        "en-US",
        "Asia/Tokyo",
      ),
    ).toBe("Tue, Nov 17 · 9:30 AM – 10:00 AM (America/Los Angeles)");
  });

  it("treats an all-day end as exclusive", () => {
    expect(
      formatActionCardWhen({ start: { date: "2026-11-17" }, end: { date: "2026-11-18" } }, "en-US"),
    ).toBe("Tue, Nov 17 · All day");
    expect(
      formatActionCardWhen({ start: { date: "2026-11-17" }, end: { date: "2026-11-20" } }, "en-US"),
    ).toBe("Tue, Nov 17 – Thu, Nov 19 · All day");
  });

  it("is empty without a usable start", () => {
    expect(formatActionCardWhen({}, "en-US")).toBe("");
    expect(formatActionCardWhen({ start: { dateTime: "soon" } }, "en-US")).toBe("");
  });
});
