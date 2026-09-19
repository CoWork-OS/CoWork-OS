import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
  it("shows Bots when a bot conversation view is active", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: "bot-task-1",
        isBotViewActive: true,
        onSelectTask: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toMatch(
      /class="sidebar-session-tab active"[^>]*aria-selected="true"[^>]*>Bots<\/button>/,
    );
    expect(markup).toMatch(
      /class="sidebar-session-tab "[^>]*aria-selected="false"[^>]*>Sessions<\/button>/,
    );
    expect(markup).toContain("sidebar-bots-pane");
  });

  it("marks Automations as the active main-screen destination", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: null,
        isAutomationsActive: true,
        onSelectTask: () => {},
        onOpenAutomations: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toMatch(
      /<button[^>]*class="[^"]*\bactive\b[^"]*"[^>]*aria-pressed="true"[^>]*title="Automations"/,
    );
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

  it("renders Agents as a primary destination and keeps More collapsed by default", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: null,
        isAgentsActive: true,
        onSelectTask: () => {},
        onOpenAutomations: () => {},
        onOpenIdeas: () => {},
        onOpenInboxAgent: () => {},
        onOpenAgents: () => {},
        onOpenEverydayAgent: () => {},
        onOpenHealth: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onOpenDevices: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("Agents");
    expect(markup).toContain("Everyday");
    expect(markup).toContain("More");
    expect(markup).not.toContain("Mission Control");
    expect(markup).toContain('aria-pressed="true"');
  });

  it("expands More when a nested destination is active", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: null,
        isMissionControlActive: true,
        onSelectTask: () => {},
        onOpenAutomations: () => {},
        onOpenIdeas: () => {},
        onOpenInboxAgent: () => {},
        onOpenAgents: () => {},
        onOpenEverydayAgent: () => {},
        onOpenHealth: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onOpenDevices: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Mission Control");
  });

  it("renders available app updates as a single Update button", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: null,
        updateInfo: {
          available: true,
          currentVersion: "0.5.45",
          latestVersion: "0.5.46",
          updateMode: "electron-updater",
        } as Any,
        onSelectTask: () => {},
        onOpenAutomations: () => {},
        onOpenIdeas: () => {},
        onOpenInboxAgent: () => {},
        onOpenAgents: () => {},
        onOpenEverydayAgent: () => {},
        onOpenHealth: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onOpenDevices: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toMatch(/class="[^"]*\bupdate-banner\b[^"]*"/);
    expect(markup).toContain(">Update</button>");
    expect(markup).toMatch(
      /class="sidebar-footer cli-sidebar-footer"[\s\S]*Settings[\s\S]*class="sidebar-update-actions"[\s\S]*>Update<\/button>/,
    );
    expect(markup).not.toContain("sidebar-update-slot");
    const source = readFileSync(stylesPath, "utf8");
    expect(source).toMatch(
      /\.sidebar-update-actions\s*\{[\s\S]*justify-content:\s*flex-end;[\s\S]*margin-left:\s*auto;/,
    );
    expect(markup).not.toContain("0.5.46");
    expect(markup).not.toContain("Dismiss update notification");
  });

  it("prioritizes the session title over time while a session is awaiting response", () => {
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
        onOpenAutomations: () => {},
        onOpenIdeas: () => {},
        onOpenInboxAgent: () => {},
        onOpenAgents: () => {},
        onOpenEverydayAgent: () => {},
        onOpenHealth: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onOpenDevices: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("Investigate the onboarding session");
    expect(markup).toContain("cli-task-title-row-awaiting");
    expect(markup).toContain("Awaiting response");
    expect(markup).not.toContain("cli-task-status awaiting");
    expect(markup).not.toContain("cli-session-indicator-awaiting");
    expect(markup).not.toContain("cli-task-time");
  });

  it("places active session spinners in the leading sidebar gutter", () => {
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
        onOpenMissionControl: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect((markup.match(/cli-task-status active cli-task-status-leading/g) ?? []).length).toBe(2);
    expect(markup).toContain("Active session");
    const source = readFileSync(stylesPath, "utf8");
    expect(source).toMatch(
      /\.density-focused \.cli-task-status-leading\s*\{[\s\S]*position:\s*absolute;[\s\S]*left:\s*4px;/,
    );
  });

  it("shows failed sessions by default while keeping the optional filter available", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [
          {
            id: "failed-task-1",
            title: "Recently stopped session",
            prompt: "Recently stopped session",
            status: "cancelled",
            workspaceId: "ws-1",
            createdAt: Date.now() - 2 * 60 * 1000,
            updatedAt: Date.now() - 2 * 60 * 1000,
          },
        ] as Any,
        selectedTaskId: null,
        onSelectTask: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("Recently stopped session");
    expect(markup).toContain('title="Filter sessions"');
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
        onOpenMissionControl: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("Pinned");
    expect(markup).toContain("Projects");
    expect(markup).toContain("Recents");
    expect(markup).toContain("No projects added");
    expect(markup).toContain('aria-label="Organize projects"');
    expect(markup).not.toContain('sidebar-workspace-label">cowork');
    expect(markup).toContain("Pinned session");
    expect(markup).toContain("Temporary session");
    expect(markup.indexOf("Pinned session")).toBeLessThan(markup.indexOf("Projects"));
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
        path: "/Users/mesut/Downloads/app/cowork/tmp/cowork-realistic-qa-3",
      } as Any),
    ).toBe(true);
    expect(
      isSidebarRecentWorkspace({
        id: "workspace-permanent",
        name: "glean",
        path: "/Users/mesut/Desktop/glean",
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

  it("places the completion attention dot directly before the session time", () => {
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
        onOpenAutomations: () => {},
        onOpenIdeas: () => {},
        onOpenInboxAgent: () => {},
        onOpenAgents: () => {},
        onOpenEverydayAgent: () => {},
        onOpenHealth: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onOpenDevices: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("cli-task-time-wrap");
    expect(markup).toContain("task-completion-unread-dot");
    expect(markup.indexOf("task-completion-unread-dot")).toBeLessThan(
      markup.indexOf('class="cli-task-time"'),
    );
  });

  it("marks automated task rows with a distinct icon before the session time", () => {
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
        onOpenAutomations: () => {},
        onOpenIdeas: () => {},
        onOpenInboxAgent: () => {},
        onOpenAgents: () => {},
        onOpenEverydayAgent: () => {},
        onOpenHealth: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onOpenDevices: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("cli-task-automation-icon");
    expect(markup).toContain("Automated task");
    const automatedIconIndex = markup.indexOf("cli-task-automation-icon");
    expect(automatedIconIndex).toBeGreaterThan(markup.indexOf("Update AGENTS.md"));
    expect(automatedIconIndex).toBeLessThan(
      markup.indexOf('class="cli-task-time"', automatedIconIndex),
    );
  });

  it("uses compact container-query rules when the sidebar is narrow", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(/\.sidebar\s*\{[\s\S]*container-type:\s*inline-size;[\s\S]*\}/);
    expect(source).toMatch(/@container\s*\(max-width:\s*280px\)/);
    expect(source).toMatch(
      /@container\s*\(max-width:\s*280px\)\s*\{[\s\S]*\.cli-task-time\s*\{[\s\S]*display:\s*none;[\s\S]*\}/,
    );
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
