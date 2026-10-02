import { describe, expect, it } from "vitest";
import {
  cleanNotificationMessage,
  cleanNotificationTitle,
  getNotificationTone,
  groupNotifications,
  type GroupableNotification,
} from "../notification-groups";

const NOW = new Date(2026, 9, 2, 15, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

function note(
  id: string,
  overrides: Partial<GroupableNotification> & Pick<GroupableNotification, "type" | "title">,
): GroupableNotification {
  return { id, message: "", read: true, createdAt: NOW - HOUR, ...overrides };
}

describe("cleanNotificationTitle", () => {
  it("drops emoji prefixes and turns routine and attention prefixes into tags", () => {
    expect(cleanNotificationTitle("⏱️ Routine: Daily Plan Builder Daily timed out")).toEqual({
      title: "Daily Plan Builder Daily timed out",
      tag: "Routine",
    });
    expect(cleanNotificationTitle("Approval needed · Exec")).toEqual({
      title: "Exec",
      tag: "Approval needed",
    });
    expect(cleanNotificationTitle("❌ CoWork OS documentation drift check failed")).toEqual({
      title: "CoWork OS documentation drift check failed",
    });
  });
});

describe("cleanNotificationMessage", () => {
  it("removes internal task ids and dangling hints", () => {
    expect(
      cleanNotificationMessage(
        "Pending work detected (7 mentions, 0 assigned tasks) Created task 076f1484-1511-4d09-bb5a-26125965f8cb. Next: ",
      ),
    ).toBe("Pending work detected (7 mentions, 0 assigned tasks)");
  });

  it("drops a raw JSON error body after the summary", () => {
    expect(
      cleanNotificationMessage(
        'OpenAI Codex token refresh failed (401): { "error": { "message": "expired" } }',
      ),
    ).toBe("OpenAI Codex token refresh failed (401)");
  });

  it("reads snake_case reason codes as words", () => {
    expect(cleanNotificationMessage("shell_permission_required")).toBe(
      "Access profile needs command tools",
    );
    expect(cleanNotificationMessage("some_new_reason")).toBe("Some new reason");
  });
});

describe("groupNotifications", () => {
  it("puts unread requests for input first and collapses same-day repeats", () => {
    const sections = groupNotifications(
      [
        note("bg-1", { type: "info", title: "Project Manager started background work" }),
        note("bg-2", {
          type: "info",
          title: "Project Manager started background work",
          createdAt: NOW - 2 * HOUR,
          read: false,
        }),
        note("ask", {
          type: "input_required",
          title: "Input needed · Scribe",
          read: false,
          createdAt: NOW - 3 * HOUR,
        }),
        note("old", {
          type: "task_failed",
          title: "❌ Routine: Daily Brief failed",
          createdAt: NOW - 3 * 24 * HOUR,
        }),
      ],
      NOW,
    );

    expect(sections.map((section) => section.label)).toEqual(["Needs you", "Today", "This week"]);
    expect(sections[0].groups[0]).toMatchObject({ title: "Scribe", needsAction: true });
    const background = sections[1].groups[0];
    expect(background.items.map((item) => item.id)).toEqual(["bg-1", "bg-2"]);
    expect(background.unread).toBe(true);
    expect(sections[2].groups[0]).toMatchObject({ title: "Daily Brief failed", tag: "Routine" });
  });

  it("keeps a read request out of Needs you", () => {
    const sections = groupNotifications(
      [note("ask", { type: "input_required", title: "Input needed · Scribe", read: true })],
      NOW,
    );
    expect(sections.map((section) => section.id)).toEqual(["today"]);
    expect(sections[0].groups[0].needsAction).toBe(false);
  });

  it("maps notification kinds to a status tone", () => {
    expect(getNotificationTone("task_completed")).toBe("success");
    expect(getNotificationTone("task_failed")).toBe("failure");
    expect(getNotificationTone("warning")).toBe("warning");
    expect(getNotificationTone("input_required")).toBe("request");
    expect(getNotificationTone("scheduled_task")).toBe("info");
  });
});
