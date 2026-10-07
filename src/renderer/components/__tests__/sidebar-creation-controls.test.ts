import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../Sidebar";

const source = readFileSync(fileURLToPath(new URL("../Sidebar.tsx", import.meta.url)), "utf8");

// Follow the existing Sidebar suite's SSR and source-contract testing pattern.
describe("Sidebar creation controls", () => {
  it("shows New session and keeps New project inside the Organize projects menu", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [],
        selectedTaskId: null,
        onSelectTask: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain('data-action="session"');
    expect(markup).toContain('class="sidebar-panel-new-label">New session</span>');
    expect(markup).toContain('aria-label="Organize projects"');
    expect(markup).not.toContain('title="New project"');
    expect(markup).not.toContain('aria-label="New project"');
    expect(markup).not.toContain('<span>New project</span>');
  });

  it("wires New session to session creation, not project creation", () => {
    const sessionHandler = source.match(/const handleNewTask = \(\) => \{[\s\S]*?\n  \};/)?.[0];
    expect(sessionHandler).toContain("onNewSession();");
    expect(sessionHandler).toContain("onSelectTask(null);");
    expect(sessionHandler).not.toContain("handleAddWorkspace");
    expect(source).toContain('{ kind: "session", label: "New session", onClick: handleNewTask }');
    expect(source).toMatch(
      /className="sidebar-panel-row sidebar-panel-new"\s+onClick=\{primaryAction.onClick\}/,
    );
  });

  it("wires New project in the menu to project creation, not session creation", () => {
    const projectItem = source.match(
      /<button\s+type="button"\s+className="sidebar-workspace-menu-option"\s+role="menuitem"\s+data-menu-option="add-folder"[\s\S]*?<\/button>/,
    )?.[0];
    expect(projectItem).toBeDefined();
    expect(projectItem).toContain('<span>New project</span>');
    expect(projectItem).toContain('disabled={!hasHostMethod("createWorkspace")}');
    expect(projectItem).toContain("void handleAddWorkspace();");
    expect(projectItem).not.toContain("handleNewTask");
    expect(projectItem).not.toContain("onNewSession");

    const projectHandler = source.match(
      /const handleAddWorkspace = useCallback\(async \(\) => \{[\s\S]*?const folderName[\s\S]*?addedWorkspace = await api.createWorkspace\(/,
    )?.[0];
    expect(projectHandler).toContain("await api.selectFolder()");
    expect(projectHandler).toContain("await api.listWorkspaces()");
    expect(projectHandler).toContain("await api.createWorkspace(");
  });
});
