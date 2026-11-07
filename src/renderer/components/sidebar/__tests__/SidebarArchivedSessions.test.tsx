import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task, Workspace } from "../../../../shared/types";
import {
  collapseArchivedSessions,
  formatArchivedAt,
  SidebarArchivedSessionsView,
  type SidebarArchivedSessionsViewProps,
} from "../SidebarArchivedSessions";

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.id,
    prompt: "",
    status: "completed",
    workspaceId: "ws-1",
    createdAt: 1_000,
    updatedAt: 1_000,
    sessionArchived: true,
    ...overrides,
  } as Task;
}

const workspaces = [{ id: "ws-1", name: "Website" } as Workspace];

function render(overrides: Partial<SidebarArchivedSessionsViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(SidebarArchivedSessionsView, {
      sessions: [],
      loading: false,
      loadError: null,
      hasMore: false,
      normalizedSearch: "",
      workspaces,
      restoringTaskId: null,
      restored: null,
      actionError: null,
      titleFor: (row: Task) => row.title,
      onClose: () => {},
      onUnarchive: () => {},
      onOpenRestored: () => {},
      ...overrides,
    }),
  );
}

describe("collapseArchivedSessions", () => {
  it("keeps one row per session, the newest task, most recently archived first", () => {
    const rows = collapseArchivedSessions([
      task({ id: "a1", sessionId: "s-a", updatedAt: 10, sessionArchivedAt: 100 }),
      task({ id: "a2", sessionId: "s-a", updatedAt: 20, sessionArchivedAt: 100 }),
      task({ id: "b", updatedAt: 5, sessionArchivedAt: 300 }),
      task({ id: "child", parentTaskId: "b", sessionArchivedAt: 300 }),
      task({ id: "visible", sessionArchived: undefined, sessionArchivedAt: 999 }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["b", "a2"]);
  });
});

describe("formatArchivedAt", () => {
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();

  it("uses relative time for the last day", () => {
    expect(formatArchivedAt(now - 10_000, now)).toBe("just now");
    expect(formatArchivedAt(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatArchivedAt(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });

  it("is empty without a time", () => {
    expect(formatArchivedAt(undefined, now)).toBe("");
  });

  it("adds the year only for another year", () => {
    expect(formatArchivedAt(new Date(2026, 0, 2).getTime(), now)).not.toMatch(/2026/);
    expect(formatArchivedAt(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
  });
});

describe("SidebarArchivedSessionsView", () => {
  it("lists archived sessions with their project and an Unarchive action", () => {
    const html = render({
      sessions: [task({ id: "t1", title: "Fix the login page", sessionArchivedAt: Date.now() })],
    });

    expect(html).toContain("Archived sessions");
    expect(html).toContain("Fix the login page");
    expect(html).toContain("Website · just now");
    expect(html).toContain('title="Archived just now"');
    expect(html).toContain('aria-label="Unarchive Fix the login page"');
  });

  it("explains an empty archive", () => {
    const html = render();
    expect(html).toContain("No archived sessions");
    expect(html).toContain("Sessions you archive stay here until you unarchive them.");
  });

  it("filters by the sidebar search and says when nothing matches", () => {
    const sessions = [
      task({ id: "t1", title: "Fix the login page" }),
      task({ id: "t2", title: "Draft release notes" }),
    ];

    const matching = render({ sessions, normalizedSearch: "release" });
    expect(matching).toContain("Draft release notes");
    expect(matching).not.toContain("Fix the login page");

    expect(render({ sessions, normalizedSearch: "nothing like this" })).toContain(
      "No matching archived sessions",
    );
  });

  it("offers to open a restored session and disables actions while one restores", () => {
    const html = render({
      sessions: [task({ id: "t2", title: "Draft release notes" })],
      restoringTaskId: "t2",
      restored: { taskId: "t1", title: "Fix the login page" },
    });

    expect(html).toContain("“Fix the login page” is back in your sessions.");
    expect(html).toContain(">Open</button>");
    expect(html).toContain('title="Restoring…"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Unarchive Draft release notes"/);
  });

  it("says when only the newest archived sessions are shown", () => {
    const html = render({ sessions: [task({ id: "t1" })], hasMore: true });
    expect(html).toContain("Showing the 200 most recently archived sessions.");
    expect(html).toContain("1+");
  });
});
