import { describe, expect, it } from "vitest";

import type { TaskOutputSummary } from "../../../shared/types";
import {
  addUniqueTaskId,
  buildCompletionOutputMessage,
  decideCompletionPanelBehavior,
  removeTaskId,
  shouldShowPersistentNeedsUserActionBanner,
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
  it("builds the dashboard output label from the primary filename", () => {
    expect(buildCompletionOutputMessage(outputSummary)).toBe("negotiation-analysis.md");
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

  it("builds output message for multiple files", () => {
    const multiOutput: TaskOutputSummary = {
      created: ["out/canvas_display.html", "out/a.png", "out/b.png", "out/c.png", "out/d.png"],
      primaryOutputPath: "out/canvas_display.html",
      outputCount: 5,
      folders: ["out"],
    };
    expect(buildCompletionOutputMessage(multiOutput)).toBe("canvas_display.html + 4 more");
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

  it("keeps the persistent warning for verification-backed needs-user-action completions", () => {
    expect(
      shouldShowPersistentNeedsUserActionBanner({
        terminalStatus: "needs_user_action",
        pendingChecklist: ["Run the final verification flow"],
      }),
    ).toBe(true);

    expect(
      shouldShowPersistentNeedsUserActionBanner({
        terminalStatus: "needs_user_action",
        verificationMessage: "Pending user action: final verification is still missing.",
      }),
    ).toBe(true);
  });

  it("suppresses the persistent verification warning for non-verification approval denials", () => {
    expect(
      shouldShowPersistentNeedsUserActionBanner({
        terminalStatus: "needs_user_action",
      }),
    ).toBe(false);
  });
});
