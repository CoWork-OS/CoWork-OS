import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomeDashboard, loadHomeCompanionInbox, hasHomeFileTarget } from "../HomeDashboard";
import { submitBuildTask } from "../calm/BuildPanel";
import { getFolderActionAvailability, type CalmFolderMenuProps } from "../calm/CalmTopBar";
import type { Workspace } from "../../../shared/types";

describe("browser-safe Home and Build actions", () => {
  it("shows Home's View all files action as unavailable when there is no file target", () => {
    const markup = renderToStaticMarkup(
      React.createElement(HomeDashboard, {
        workspace: null,
        tasks: [],
        selectedProvider: "openai",
        selectedModel: "gpt-4o-mini",
        providers: [],
        onOpenTask: vi.fn(),
        onCreateTask: vi.fn(),
        onNewSession: vi.fn(),
        onViewAllTasks: vi.fn(),
        onViewAllFiles: vi.fn(),
        onOpenScheduledTasks: vi.fn(),
        onOpenMissionControl: vi.fn(),
        onOpenEverydayAgent: vi.fn(),
        onOpenEventTriggers: vi.fn(),
        onOpenSelfImprove: vi.fn(),
        onOpenModelSettings: vi.fn(),
      }),
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain("No files are available to view yet.");
    expect(markup).toContain("View all files unavailable: no files are available yet");
  });

  it("keeps supported Companion suggestions when notification listing is unsupported", async () => {
    const workspace = {
      id: "workspace-1",
      name: "Project",
      path: "/server/private/project",
    } as Workspace;
    const suggestion = {
      id: "suggestion-1",
      type: "workflow_opportunity",
      title: "Review the open items",
      description: "There are two unfinished items.",
      confidence: 0.8,
      createdAt: 100,
      expiresAt: 200,
      workspaceId: workspace.id,
    };
    const listSuggestionsForWorkspaces = vi
      .fn()
      .mockResolvedValue([{ workspaceId: workspace.id, suggestions: [suggestion] }]);

    const result = await loadHomeCompanionInbox({
      listWorkspaces: vi.fn().mockResolvedValue([workspace]),
      listNotifications: vi.fn().mockRejectedValue(new Error("Unsupported on browser host")),
      listSuggestionsForWorkspaces,
    });

    expect(listSuggestionsForWorkspaces).toHaveBeenCalledWith([workspace.id]);
    expect(result.suggestions).toMatchObject([
      {
        id: suggestion.id,
        title: suggestion.title,
        kind: "suggestion",
        workspaceName: workspace.name,
      },
    ]);
  });

  it("reports file browsing unavailable until Home has a file target", () => {
    expect(hasHomeFileTarget(0, 0)).toBe(false);
    expect(hasHomeFileTarget(0, 1)).toBe(true);
    expect(hasHomeFileTarget(1, 0)).toBe(true);
  });

  it("preserves a failed Build admission result so the composer can keep its prompt", async () => {
    const onStart = vi.fn().mockResolvedValue(false);

    await expect(submitBuildTask(onStart, "  Create a status board  ")).resolves.toBe(false);
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0][0]).toContain("Create a status board");
  });

  it("treats browser-only folder picking as unavailable with a concrete reason", () => {
    const scope = {
      onNewFolderDisabledReason:
        "Choose an available workspace above. Selecting a computer folder requires the desktop app.",
    } as CalmFolderMenuProps;

    expect(getFolderActionAvailability(scope)).toEqual({
      available: false,
      reason: scope.onNewFolderDisabledReason,
    });
  });
});
