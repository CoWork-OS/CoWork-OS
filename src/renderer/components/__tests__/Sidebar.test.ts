import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Sidebar,
  compareSidebarWorkspaceGroups,
  getSidebarProjectSessionPreview,
  getSidebarWorkspaceSelection,
  isSidebarRecentWorkspace,
  truncateSidebarTitleToFit,
} from "../Sidebar";

const stylesPath = fileURLToPath(new URL("../../styles/index.css", import.meta.url));
const sidebarSourcePath = fileURLToPath(new URL("../Sidebar.tsx", import.meta.url));

describe("Sidebar top-level destinations", () => {
  it("shows Bots when the shell selects the Bots list", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: "bot-task-1",
        activeTab: "bots",
        onSelectTask: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("sidebar-bots-pane");
    expect(markup).not.toContain('aria-label="Search sessions"');
  });

  describe("Calm workspace switch", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const renderCalm = (activeDestinationId: string | null) => {
      vi.stubGlobal("document", {
        documentElement: { classList: { contains: (name: string) => name === "visual-calm" } },
      });
      return renderToStaticMarkup(
        React.createElement(Sidebar, {
          workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
          tasks: [] as Any,
          selectedTaskId: null,
          activeDestinationId: activeDestinationId as Any,
          onNavigate: () => {},
          onSelectTask: () => {},
          onOpenSettings: () => {},
          onTasksChanged: () => {},
        }),
      );
    };

    it("shows Home, Build, and Bots and marks the destination in view", () => {
      const markup = renderCalm("build");
      expect(markup).toContain("sidebar-panel-segments");
      expect(markup).toMatch(/aria-selected="true" class="active">Build<\/button>/);
      expect(markup).toMatch(/aria-selected="false" class="">Home<\/button>/);
      expect(markup).toContain(">Bots</button>");
    });

    it("selects no segment for destinations outside the switch", () => {
      expect(renderCalm("inbox")).not.toContain('aria-selected="true"');
    });

    it("names the primary button after what the panel shows", () => {
      const home = renderCalm("home");
      expect(home).toMatch(/data-action="session"[\s\S]*>New session<\/span>/);
      expect(home).not.toContain("sidebar-panel-kbd");

      const build = renderCalm("build");
      expect(build).toMatch(/data-action="build"[\s\S]*>New build<\/span>/);

      const agents = renderToStaticMarkup(
        React.createElement(Sidebar, {
          workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
          tasks: [] as Any,
          selectedTaskId: null,
          activeTab: "bots",
          activeDestinationId: "agents",
          onNavigate: () => {},
          onSelectTask: () => {},
          onOpenSettings: () => {},
          onTasksChanged: () => {},
        }),
      );
      expect(agents).toMatch(/data-action="bot"[\s\S]*>New bot<\/span>/);
      // The roster's own + would repeat it.
      expect(agents).not.toContain("sidebar-bot-add");
    });

    it("stays out of the modern theme", () => {
      const markup = renderToStaticMarkup(
        React.createElement(Sidebar, {
          workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
          tasks: [] as Any,
          selectedTaskId: null,
          activeDestinationId: "home",
          onNavigate: () => {},
          onSelectTask: () => {},
          onOpenSettings: () => {},
          onTasksChanged: () => {},
        }),
      );
      expect(markup).not.toContain("sidebar-panel-segments");
    });
  });

  it("leaves top-level destinations to the rail and keeps New in the panel", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: null,
        onSelectTask: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("sidebar-panel-new");
    expect(markup).not.toContain("sidebar-session-tab");
    expect(markup).not.toContain('title="Automations"');
    expect(markup).not.toContain("Mission Control");
    expect(markup).not.toContain("sidebar-more-toggle");
    expect(markup).not.toContain('title="Settings"');
  });

  it("clips sidebar titles to the available width without an ellipsis", () => {
    const measureByCharacters = (value: string) => value.length;

    expect(
      truncateSidebarTitleToFit('check the "new country for onboarding', 25, measureByCharacters),
    ).toBe('check the "new country fo');

    expect(
      truncateSidebarTitleToFit("I need to create a presentation", 20, measureByCharacters),
    ).toBe("I need to create a p");

    expect(truncateSidebarTitleToFit("Check documentation please", 18, measureByCharacters)).toBe(
      "Check documentatio",
    );
  });

  it("keeps very narrow sidebar titles compact without an ellipsis", () => {
    const measureByCharacters = (value: string) => value.length;

    expect(truncateSidebarTitleToFit("Presentation", 5, measureByCharacters)).toBe("Prese");
  });

  it("leaves the update prompt to the rail, beside Settings", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenAgents: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).not.toContain("update-banner");
    expect(markup).not.toContain(">Update</button>");
  });

  it("shows a readable paused reason and age without squeezing a status badge into the title", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [
          {
            id: "task-1",
            title: "Investigate the onboarding session",
            prompt: "Investigate the onboarding session",
            status: "paused",
            workspaceId: "ws-1",
            createdAt: Date.now() - 13 * 60 * 1000,
            updatedAt: Date.now() - 13 * 60 * 1000,
          },
        ] as Any,
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenAgents: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("Investigate the onboarding session");
    // The title is the session's keyboard/screen-reader target, not the whole row.
    expect(markup).toMatch(
      /<button type="button" class="cli-task-select-btn"[^>]*>[\s\S]*Investigate the onboarding session/,
    );
    expect(markup).not.toMatch(/class="task-item cli-task-item[^"]*"[^>]*role="button"/);
    expect(markup).toContain('class="cli-task-activity needs-you">Paused</div>');
    expect(markup).toContain("cli-task-status awaiting");
    expect(markup).not.toContain('class="cli-task-time"');
  });

  it("keeps active session indicators before the title alongside a readable running label", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [
          {
            id: "active-task-1",
            title: "Active session",
            prompt: "Active session",
            status: "executing",
            workspaceId: "ws-1",
            createdAt: Date.now() - 60 * 1000,
            updatedAt: Date.now() - 60 * 1000,
          },
          {
            id: "active-child-task-1",
            parentTaskId: "active-task-1",
            title: "Active child session",
            prompt: "Active child session",
            status: "executing",
            workspaceId: "ws-1",
            createdAt: Date.now() - 45 * 1000,
            updatedAt: Date.now() - 45 * 1000,
          },
        ] as Any,
        selectedTaskId: "active-task-1",
        onSelectTask: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect((markup.match(/cli-task-status active/g) ?? []).length).toBe(2);
    expect((markup.match(/cli-task-activity running/g) ?? []).length).toBe(2);
    expect(markup).toContain("Active session");
    expect(markup.indexOf("cli-task-status active")).toBeLessThan(
      markup.indexOf('title="Active session"'),
    );
  });

  it.each(["failed", "cancelled"])(
    "shows %s sessions without an X while keeping the optional filter available",
    (status) => {
      const markup = renderToStaticMarkup(
        React.createElement(Sidebar, {
          workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
          tasks: [
            {
              id: "failed-task-1",
              title: "Recently stopped session",
              prompt: "Recently stopped session",
              status,
              workspaceId: "ws-1",
              createdAt: Date.now() - 2 * 60 * 1000,
              updatedAt: Date.now() - 2 * 60 * 1000,
            },
          ] as Any,
          selectedTaskId: null,
          onSelectTask: () => {},
          onOpenSettings: () => {},
          onTasksChanged: () => {},
        }),
      );

      expect(markup).toContain("Recently stopped session");
      expect(markup).toContain('class="cli-task-status failed" aria-hidden="true"></span>');
      expect(markup).toContain('type="search" aria-label="Search sessions"');
      expect(markup).toContain('title="Filter sessions"');
    },
  );

  it("makes search and status filters visible without opening an extra control", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: null,
        tasks: [],
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );
    expect(markup).toContain('placeholder="Find sessions…"');
    expect(markup).toContain("aria-keyshortcuts=");
    expect(markup).toContain('aria-label="Session status"');
    expect(markup).toContain('aria-pressed="true"><span>All</span>');
    expect(markup).toContain('aria-pressed="false"><span>Running</span>');
    expect(markup).toContain('aria-pressed="false"><span>Needs you</span>');
  });

  it("keeps automated activity discoverable and its history collapsed by default", () => {
    const now = Date.now();
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: null,
        tasks: [
          {
            id: "manual",
            title: "Manual session",
            prompt: "Manual session",
            status: "completed",
            workspaceId: "ws-1",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "cron-running",
            title: "Scheduled review",
            prompt: "Review",
            source: "cron",
            status: "executing",
            workspaceId: "ws-1",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "cron-approval",
            title: "Scheduled approval",
            prompt: "Review",
            source: "cron",
            status: "blocked",
            terminalStatus: "awaiting_approval",
            workspaceId: "ws-1",
            createdAt: now,
            updatedAt: now,
          },
        ] as Any,
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );
    expect(markup).toContain('class="automated-folder-header" aria-expanded="false"');
    expect(markup).toContain("1 running · 1 needs you");
    expect(markup).toContain(
      'class="sidebar-session-state-filter running " aria-pressed="false"><span>Running</span><span class="sidebar-session-state-count">1</span>',
    );
    expect(markup).toContain(
      'class="sidebar-session-state-filter needs-you " aria-pressed="false"><span>Needs you</span><span class="sidebar-session-state-count">1</span>',
    );
    expect(markup).not.toContain('data-task-id="cron-running"');
    expect(markup).not.toContain('data-task-id="cron-approval"');
    expect(markup.indexOf("sidebar-automated-section")).toBeGreaterThan(
      markup.indexOf('data-task-id="manual"'),
    );
  });

  it("doesn't duplicate pinned automated sessions in the footer", () => {
    const now = Date.now();
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: null,
        tasks: [
          {
            id: "pinned-cron",
            title: "Pinned schedule",
            prompt: "Review",
            source: "cron",
            pinned: true,
            status: "executing",
            workspaceId: "ws-1",
            createdAt: now,
            updatedAt: now,
          },
        ] as Any,
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );
    expect(markup).toContain('data-task-id="pinned-cron"');
    expect(markup).not.toContain('class="sidebar-automated-section"');
  });

  it("keeps projects opt-in while retaining pinned and recent sessions", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-cowork", name: "cowork", path: "/workspace/cowork" } as Any,
        tasks: [
          {
            id: "pinned-task",
            title: "Pinned session",
            prompt: "Pinned session",
            status: "completed",
            workspaceId: "ws-cowork",
            pinned: true,
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now() - 60_000,
          },
          {
            id: "recent-task",
            title: "Temporary session",
            prompt: "Temporary session",
            status: "completed",
            workspaceId: "__temp_workspace__:sidebar-test",
            createdAt: Date.now() - 120_000,
            updatedAt: Date.now() - 120_000,
          },
        ] as Any,
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("Pinned");
    expect(markup).toContain("Projects");
    // Recents are grouped under day labels.
    expect(markup).toContain('aria-label="Today sessions" aria-expanded="true"');
    expect(markup).toContain("No projects added");
    expect(markup).toContain('aria-label="Organize projects"');
    expect(markup).not.toContain('sidebar-workspace-label">cowork');
    expect(markup).toContain("Pinned session");
    expect(markup).toContain("Temporary session");
    expect(markup.indexOf("Pinned session")).toBeLessThan(markup.indexOf("Projects"));
  });

  describe("collapsible recent sessions", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    const renderWithCollapsedGroups = (collapsedRecentGroups: unknown) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-05T12:00:00"));
      vi.stubGlobal("window", {
        electronAPI: {},
        localStorage: {
          getItem: () =>
            JSON.stringify({
              visibleWorkspaceIds: ["ws-project"],
              expandedWorkspaceIds: ["ws-project"],
              collapsedRecentGroups,
            }),
        },
      });
      const task = (id: string, extra: object = {}) => ({
        id,
        title: id,
        prompt: id,
        status: "completed",
        workspaceId: "__temp_workspace__:collapse-test",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...extra,
      });
      return renderToStaticMarkup(
        React.createElement(Sidebar, {
          workspace: { id: "ws-project", name: "Project", path: "/workspace/project" } as Any,
          tasks: [
            task("today-root"),
            task("today-child", { parentTaskId: "today-root" }),
            task("yesterday-root", {
              createdAt: Date.now() - 86_400_000,
              updatedAt: Date.now() - 86_400_000,
            }),
            task("pinned-root", { pinned: true }),
            task("project-root", { workspaceId: "ws-project" }),
          ] as Any,
          selectedTaskId: null,
          onSelectTask: () => {},
          onOpenSettings: () => {},
          onTasksChanged: () => {},
        }),
      );
    };

    it("restores a collapsed date group without hiding pinned, project, or other date groups", () => {
      const markup = renderWithCollapsedGroups(["Today"]);
      expect(markup).toContain('aria-label="Today sessions" aria-expanded="false"');
      expect(markup).not.toContain('data-task-id="today-root"');
      expect(markup).not.toContain('data-task-id="today-child"');
      expect(markup).toContain('aria-label="Yesterday sessions" aria-expanded="true"');
      for (const id of ["yesterday-root", "pinned-root", "project-root"]) {
        expect(markup).toContain(`data-task-id="${id}"`);
      }
    });

    it("keeps date groups expanded when the stored preference is invalid", () => {
      const markup = renderWithCollapsedGroups({ Today: true });
      expect(markup).toContain('aria-label="Today sessions" aria-expanded="true"');
      expect(markup).toContain('data-task-id="today-root"');
      expect(markup).toContain('data-task-id="today-child"');
    });
  });

  it("keeps project menu icons and labels left-aligned", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.sidebar-workspace-menu-option\s*\{[\s\S]*justify-content:\s*flex-start;[\s\S]*text-align:\s*left;/,
    );
  });

  it("keeps the project organizer menu clear of the sidebar edge", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(/\.sidebar-workspace-section-menu\s*\{[\s\S]*right:\s*-12px;/);
  });

  it("uses the project menu treatment for session actions", () => {
    const source = readFileSync(sidebarSourcePath, "utf8");
    const sessionMenu = source.match(
      /className="task-item-menu sidebar-workspace-menu sidebar-session-menu"[\s\S]*?aria-label="Session actions"[\s\S]*?<\/div>/,
    )?.[0];

    expect(sessionMenu).toContain('className="sidebar-workspace-menu-option"');
    expect(sessionMenu).toContain("<Pencil size={16} />");
    expect(sessionMenu).toContain("<Pin size={16} />");
    expect(sessionMenu).toContain("<Archive size={16} />");
    expect(sessionMenu).toContain("sidebar-workspace-menu-option-danger");
    expect(sessionMenu).not.toContain("cli-menu-prefix");
    expect(sessionMenu).not.toContain("cli-menu-option");
  });

  it("previews six project sessions and reports the remaining sessions", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => `session-${index + 1}`);

    expect(getSidebarProjectSessionPreview(sessions, false)).toEqual({
      visibleItems: sessions.slice(0, 6),
      hasMore: true,
      remainingCount: 2,
    });
    expect(getSidebarProjectSessionPreview(sessions, true)).toEqual({
      visibleItems: sessions,
      hasMore: false,
      remainingCount: 0,
    });
  });

  it("does not render a session-count badge in project rows", () => {
    expect(readFileSync(sidebarSourcePath, "utf8")).not.toContain("sidebar-workspace-count");
  });

  it("left-aligns the project session overflow action with session rows", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.sidebar-workspace-session-action\s*\{[\s\S]*justify-content:\s*flex-start\s*!important;[\s\S]*padding:\s*2px 12px 2px 40px;/,
    );
  });

  it("keeps the project session overflow action text-only", () => {
    const source = readFileSync(sidebarSourcePath, "utf8");
    const actionBlock = source.match(
      /if \(row\.kind === "workspace-session-action"\)[\s\S]*?if \(row\.kind === "workspace-header"\)/,
    )?.[0];

    expect(actionBlock).toContain("<span>{label}</span>");
    expect(actionBlock).not.toContain("Chevron");
  });

  it("uses explicit project selection and always keeps pinned projects selected", () => {
    const selected = getSidebarWorkspaceSelection({
      visibleWorkspaceIds: ["ws-folder"],
      pinnedWorkspaceIds: ["ws-pinned", "ws-folder"],
    });

    expect([...selected]).toEqual(["ws-folder", "ws-pinned"]);
  });

  it("keeps temporary workspace paths out of durable project ordering", () => {
    expect(
      isSidebarRecentWorkspace({
        id: "workspace-temp-qa",
        name: "cowork-realistic-qa-3",
        path: "/Users/alex/Downloads/app/cowork/tmp/cowork-realistic-qa-3",
      } as Any),
    ).toBe(true);
    expect(
      isSidebarRecentWorkspace({
        id: "workspace-permanent",
        name: "glean",
        path: "/Users/alex/Desktop/glean",
      } as Any),
    ).toBe(false);
  });

  it("sorts project groups deterministically instead of by last-used database order", () => {
    const groups = [
      {
        workspaceId: "workspace-zeta",
        label: "Project 10",
        path: "/projects/project-10",
        nodes: [],
        pinned: false,
        recent: false,
        current: false,
      },
      {
        workspaceId: "workspace-alpha",
        label: "Project 2",
        path: "/projects/project-2",
        nodes: [],
        pinned: false,
        recent: false,
        current: false,
      },
      {
        workspaceId: "workspace-current",
        label: "Project 99",
        path: "/projects/project-99",
        nodes: [],
        pinned: false,
        recent: false,
        current: true,
      },
    ];

    expect([...groups].sort(compareSidebarWorkspaceGroups).map((group) => group.label)).toEqual([
      "Project 99",
      "Project 2",
      "Project 10",
    ]);
  });

  it("keeps completion attention before session actions without a timestamp", () => {
    const now = Date.now();
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [
          {
            id: "task-1",
            title: "Heartbeat: Pending work from inbox",
            prompt: "Heartbeat: Pending work from inbox",
            status: "completed",
            source: "manual",
            workspaceId: "ws-1",
            createdAt: now - 60 * 1000,
            updatedAt: now - 60 * 1000,
          },
        ] as Any,
        completionAttentionTaskIds: ["task-1"],
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenAgents: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("cli-task-time-wrap");
    expect(markup).toContain("task-completion-unread-dot");
    expect(markup).not.toContain('class="cli-task-time"');
    expect(markup.indexOf("task-completion-unread-dot")).toBeLessThan(
      markup.indexOf('class="task-item-actions cli-task-actions"'),
    );
  });

  it("keeps the automated task icon before session actions without a timestamp", () => {
    const now = Date.now();
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [
          {
            id: "task-1",
            title: "Manual parent",
            prompt: "Manual parent",
            status: "completed",
            source: "manual",
            workspaceId: "ws-1",
            createdAt: now - 5 * 60 * 1000,
            updatedAt: now - 5 * 60 * 1000,
          },
          {
            id: "task-2",
            parentTaskId: "task-1",
            title: "Update AGENTS.md",
            prompt: "Update AGENTS.md",
            status: "completed",
            source: "cron",
            workspaceId: "ws-1",
            createdAt: now - 7 * 60 * 60 * 1000,
            updatedAt: now - 7 * 60 * 60 * 1000,
          },
        ] as Any,
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenAgents: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("cli-task-automation-icon");
    expect(markup).toContain("Automated task");
    expect(markup).not.toContain('class="cli-task-time"');
    const automatedIconIndex = markup.indexOf("cli-task-automation-icon");
    expect(automatedIconIndex).toBeGreaterThan(markup.indexOf("Update AGENTS.md"));
    expect(automatedIconIndex).toBeLessThan(
      markup.indexOf('class="task-item-actions cli-task-actions"', automatedIconIndex),
    );
  });

  it("uses compact container-query rules when the sidebar is narrow", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(/\.sidebar\s*\{[\s\S]*container-type:\s*inline-size;[\s\S]*\}/);
    expect(source).toMatch(/@container\s*\(max-width:\s*280px\)/);
    expect(source).toMatch(
      /@container\s*\(max-width:\s*280px\)\s*\{[\s\S]*\.cli-task-item\s*\{[\s\S]*gap:\s*4px;[\s\S]*padding-right:\s*6px\s*!important;[\s\S]*\}/,
    );
  });

  it("clips focused session titles without a CSS ellipsis", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.density-focused\s+\.cli-task-title\s*\{[^}]*text-overflow:\s*clip;[^}]*\}/,
    );
    expect(source).not.toMatch(
      /\.density-focused\s+\.cli-task-title\s*\{[^}]*text-overflow:\s*ellipsis;/,
    );
  });

  it("fades the end of clipped session titles", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.cli-task-title--faded\s*\{[^}]*-webkit-mask-image:\s*linear-gradient\([\s\S]*transparent\s+100%[\s\S]*\}/,
    );
  });
});
