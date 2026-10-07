import { describe, expect, it } from "vitest";
import {
  BUILD_INSTRUCTIONS,
  isBuildPrompt,
  isBuildTask,
  stripBuildInstructions,
} from "../calm/build-task";
import { pickBuildPreviewPath } from "../calm/BuildTaskBar";
import { normalizeInitialPromptText } from "../MainContent/task-event-presentation";

const buildPrompt = `Make a tracker\n\n${BUILD_INSTRUCTIONS}`;

describe("build task detection", () => {
  it("recognises prompts started from Build", () => {
    expect(isBuildPrompt(buildPrompt)).toBe(true);
    expect(isBuildPrompt("Make a tracker")).toBe(false);
    expect(isBuildPrompt(undefined)).toBe(false);
  });

  it("checks every prompt field a task may carry", () => {
    expect(isBuildTask({ prompt: "dispatch wrapper", rawPrompt: buildPrompt })).toBe(true);
    expect(isBuildTask({ prompt: buildPrompt })).toBe(true);
    expect(isBuildTask({ prompt: "Summarise my inbox" })).toBe(false);
    expect(isBuildTask(null)).toBe(false);
  });

  it("recognises a sidebar build whose long request has truncated away its instructions", () => {
    const longPrompt = `${"x".repeat(1100)}\n\n${BUILD_INSTRUCTIONS}`;
    expect(
      isBuildTask({
        prompt: "",
        sidebarPromptPreview: longPrompt.slice(0, 1024),
        agentConfig: { taskOrigin: "build" },
      }),
    ).toBe(true);
  });
});

describe("stripBuildInstructions", () => {
  it("shows the prompt as the user wrote it", () => {
    expect(stripBuildInstructions(buildPrompt)).toBe("Make a tracker");
  });

  it("keeps the attachment summary that follows the instructions", () => {
    const withFiles = `${buildPrompt}\n\nAttached files (relative to workspace):\n- data.csv (data.csv)`;
    expect(stripBuildInstructions(withFiles)).toBe(
      "Make a tracker\n\nAttached files (relative to workspace):\n- data.csv (data.csv)",
    );
  });

  it("is applied to the task bubble text", () => {
    expect(normalizeInitialPromptText(buildPrompt)).toBe("Make a tracker");
  });
});

describe("pickBuildPreviewPath", () => {
  it("prefers the latest index.html", () => {
    expect(
      pickBuildPreviewPath([
        { path: "/w/about.html", action: "created", timestamp: 3 },
        { path: "/w/index.html", action: "modified", timestamp: 2 },
        { path: "/w/app.js", action: "created", timestamp: 4 },
      ]),
    ).toBe("/w/index.html");
  });

  it("falls back to any written HTML page and ignores deleted ones", () => {
    expect(
      pickBuildPreviewPath([
        { path: "/w/index.html", action: "deleted", timestamp: 5 },
        { path: "/w/report.html", action: "created", timestamp: 1 },
      ]),
    ).toBe("/w/report.html");
    expect(pickBuildPreviewPath([{ path: "/w/app.js", action: "created", timestamp: 1 }])).toBe(
      null,
    );
  });
});

describe("legacy build prompts", () => {
  const legacy =
    "Make a board\n\nBuild this as a self-contained interactive web app (HTML, CSS and JavaScript) and open a live preview when it is ready. Keep it clean and usable by non-developers.";

  it("are still recognised and cleaned", () => {
    expect(isBuildPrompt(legacy)).toBe(true);
    expect(stripBuildInstructions(legacy)).toBe("Make a board");
  });
});
