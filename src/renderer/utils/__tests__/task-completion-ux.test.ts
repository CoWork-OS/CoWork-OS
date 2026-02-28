import { describe, expect, it, vi } from "vitest";

import type { TaskOutputSummary } from "../../../shared/types";
import {
  addUniqueTaskId,
  buildTaskCompletionToast,
  decideCompletionPanelBehavior,
  removeTaskId,
  shouldClearUnseenOutputBadges,
  shouldTrackUnseenCompletion,
} from "../task-completion-ux";

const outputSummary: TaskOutputSummary = {
  created: ["artifacts/legal/negotiation-analysis.md"],
  primaryOutputPath: "artifacts/legal/negotiation-analysis.md",
  outputCount: 1,
  folders: ["artifacts/legal"],
};

describe("task completion UX helpers", () => {
  it("builds output completion toast copy with filename and action buttons", () => {
    const toast = buildTaskCompletionToast({
      taskId: "task-1",
      taskTitle: "Legal analysis",
      outputSummary,
      actionDependencies: {
        resolveWorkspacePath: async () => "/workspace",
        openFile: async () => undefined,
        showInFinder: async () => undefined,
        onViewInFiles: () => undefined,
      },
    });

    expect(toast.title).toBe("Task complete");
    expect(toast.message).toBe("1 output ready: negotiation-analysis.md");
    expect(toast.actions?.map((a) => a.label)).toEqual([
      "Open file",
      "Show in Finder",
      "View in Files",
    ]);
  });

  it("open action calls openFile with primary output path and workspace path", async () => {
    const resolveWorkspacePath = vi.fn().mockResolvedValue("/workspace");
    const openFile = vi.fn().mockResolvedValue(undefined);
    const toast = buildTaskCompletionToast({
      taskId: "task-1",
      outputSummary,
      actionDependencies: {
        resolveWorkspacePath,
        openFile,
        showInFinder: async () => undefined,
        onViewInFiles: () => undefined,
      },
    });

    await toast.actions?.[0].callback();

    expect(resolveWorkspacePath).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith("artifacts/legal/negotiation-analysis.md", "/workspace");
  });

  it("show-in-finder action calls showInFinder with primary output path and workspace path", async () => {
    const resolveWorkspacePath = vi.fn().mockResolvedValue("/workspace");
    const showInFinder = vi.fn().mockResolvedValue(undefined);
    const toast = buildTaskCompletionToast({
      taskId: "task-1",
      outputSummary,
      actionDependencies: {
        resolveWorkspacePath,
        openFile: async () => undefined,
        showInFinder,
        onViewInFiles: () => undefined,
      },
    });

    await toast.actions?.[1].callback();

    expect(resolveWorkspacePath).toHaveBeenCalledTimes(1);
    expect(showInFinder).toHaveBeenCalledWith(
      "artifacts/legal/negotiation-analysis.md",
      "/workspace",
    );
  });

  it("view-in-files action calls view callback for task selection/panel focus", () => {
    const onViewInFiles = vi.fn();
    const toast = buildTaskCompletionToast({
      taskId: "task-1",
      outputSummary,
      actionDependencies: {
        resolveWorkspacePath: async () => "/workspace",
        openFile: async () => undefined,
        showInFinder: async () => undefined,
        onViewInFiles,
      },
    });

    toast.actions?.[2].callback();
    expect(onViewInFiles).toHaveBeenCalledTimes(1);
  });

  it("returns normal completion toast when no outputs are detected", () => {
    const toast = buildTaskCompletionToast({
      taskId: "task-2",
      taskTitle: "No file task",
      outputSummary: null,
    });

    expect(toast.title).toBe("Task complete");
    expect(toast.message).toBe("No file task");
    expect(toast.actions).toBeUndefined();
  });

  it("computes output panel behavior for auto-open vs unseen badge", () => {
    expect(
      decideCompletionPanelBehavior({
        isMainView: true,
        isSelectedTask: true,
        panelCollapsed: true,
      }),
    ).toEqual({ autoOpenPanel: true, markUnseenOutput: false });

    expect(
      decideCompletionPanelBehavior({
        isMainView: true,
        isSelectedTask: true,
        panelCollapsed: false,
      }),
    ).toEqual({ autoOpenPanel: false, markUnseenOutput: false });

    expect(
      decideCompletionPanelBehavior({
        isMainView: false,
        isSelectedTask: true,
        panelCollapsed: true,
      }),
    ).toEqual({ autoOpenPanel: false, markUnseenOutput: true });
  });

  it("tracks/clears unseen output ids and completion attention predicates", () => {
    expect(addUniqueTaskId(["task-1"], "task-1")).toEqual(["task-1"]);
    expect(addUniqueTaskId(["task-1"], "task-2")).toEqual(["task-1", "task-2"]);
    expect(removeTaskId(["task-1", "task-2"], "task-1")).toEqual(["task-2"]);

    expect(shouldTrackUnseenCompletion({ isMainView: true, isSelectedTask: true })).toBe(false);
    expect(shouldTrackUnseenCompletion({ isMainView: true, isSelectedTask: false })).toBe(true);

    expect(shouldClearUnseenOutputBadges(true, false)).toBe(true);
    expect(shouldClearUnseenOutputBadges(true, true)).toBe(false);
  });
});
