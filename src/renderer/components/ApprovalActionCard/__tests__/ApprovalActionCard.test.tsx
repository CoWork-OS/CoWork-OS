import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalActionCard, attendeeInitials } from "../ApprovalActionCard";
import type { ApprovalActionCard as Card } from "../../../../shared/approval-action-card";

const card: Card = {
  kind: "calendar_event",
  provider: "google_calendar",
  operation: "create",
  title: "Proposal review with Sophie",
  attendees: ["Sophie Laurent", "ops@example.com"],
  attendeesOmitted: 1,
  location: "Zoom",
};

describe("ApprovalActionCard", () => {
  it("shows an approved receipt in place of the buttons", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalActionCard, { card, state: "approved" }),
    );
    expect(html).toContain('data-state="approved"');
    expect(html).toContain("Approved — sending invite");
    expect(html).toContain("+1 more");
    expect(html).not.toContain("approval-action-card-actions");
  });

  it("shows a declined receipt with the reply the person typed", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalActionCard, { card, state: "declined", reply: "Use 10:00 instead" }),
    );
    expect(html).toContain("Not sent");
    expect(html).toContain("Use 10:00 instead");
  });

  it("renders card text as text, never markup", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalActionCard, {
        card: { ...card, title: "<img src=x onerror=alert(1)>" },
        state: "approved",
      }),
    );
    expect(html).not.toContain("<img");
  });

  it("makes initials from names and addresses", () => {
    expect(attendeeInitials("Sophie Laurent")).toBe("SL");
    expect(attendeeInitials("ops@example.com")).toBe("O");
    expect(attendeeInitials("jean-luc.picard@example.com")).toBe("JP");
  });
});
