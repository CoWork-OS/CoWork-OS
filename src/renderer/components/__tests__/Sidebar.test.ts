import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sidebar, truncateSidebarTitleToFit } from "../Sidebar";

const stylesPath = fileURLToPath(new URL("../../styles/index.css", import.meta.url));

describe("Sidebar top-level destinations", () => {
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

  it("truncates sidebar titles to the available width", () => {
    const measureByCharacters = (value: string) => value.length;

    expect(
      truncateSidebarTitleToFit(
        'check the "new country for onboarding',
        25,
        measureByCharacters,
      ),
    ).toBe('check the "new country...');

    expect(
      truncateSidebarTitleToFit(
        "I need to create a presentation",
        20,
        measureByCharacters,
      ),
    ).toBe("I need to create...");

    expect(
      truncateSidebarTitleToFit(
        "Check documentation please",
        18,
        measureByCharacters,
      ),
    ).toBe("Check documenta...");
  });

  it("keeps very narrow sidebar titles compact", () => {
    const measureByCharacters = (value: string) => value.length;

    expect(
      truncateSidebarTitleToFit(
        "Presentation",
        5,
        measureByCharacters,
      ),
    ).toBe("Pr...");
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
    expect(markup).toContain("aria-pressed=\"true\"");
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

    expect(markup).toContain("aria-expanded=\"true\"");
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
      markup.indexOf("class=\"cli-task-time\""),
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
      markup.indexOf("class=\"cli-task-time\"", automatedIconIndex),
    );
  });

  it("uses compact container-query rules when the sidebar is narrow", () => {
    const source = readFileSync(stylesPath, "utf8");

    expect(source).toMatch(
      /\.sidebar\s*\{[\s\S]*container-type:\s*inline-size;[\s\S]*\}/,
    );
    expect(source).toMatch(/@container\s*\(max-width:\s*280px\)/);
    expect(source).toMatch(
      /@container\s*\(max-width:\s*280px\)\s*\{[\s\S]*\.cli-task-time\s*\{[\s\S]*display:\s*none;[\s\S]*\}/,
    );
    expect(source).toMatch(
      /@container\s*\(max-width:\s*280px\)\s*\{[\s\S]*\.cli-task-item\s*\{[\s\S]*gap:\s*4px;[\s\S]*padding-right:\s*6px\s*!important;[\s\S]*\}/,
    );
  });
});
