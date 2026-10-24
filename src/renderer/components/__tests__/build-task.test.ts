import { describe, expect, it } from "vitest";
import {
  BUILD_INSTRUCTIONS,
  GUEST_BUILD_INSTRUCTIONS,
  getBuildComputerPolicyIssue,
  isBuildPrompt,
  isBuildTask,
  stripBuildInstructions,
} from "../calm/build-task";
import { BUILTIN_ACCESS_PROFILES } from "../../../shared/access-profiles";
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
  it("recognises and strips guest steering without sending guest files to host preview", () => {
    const prompt = `Make a tracker\n\n${GUEST_BUILD_INSTRUCTIONS}`;
    expect(isBuildPrompt(prompt)).toBe(true);
    expect(stripBuildInstructions(prompt)).toBe("Make a tracker");
    expect(GUEST_BUILD_INSTRUCTIONS).toContain("guest browser tools");
    expect(GUEST_BUILD_INSTRUCTIONS).not.toContain("preview_web_page");
  });
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

describe("Build computer policy admission", () => {
  it("blocks fresh computers with per-request network consent before creating a task", () => {
    expect(getBuildComputerPolicyIssue("bot-desktop", BUILTIN_ACCESS_PROFILES[0])).toMatch(
      /Access profile/,
    );
    expect(getBuildComputerPolicyIssue("cua", BUILTIN_ACCESS_PROFILES[1])).toBeTruthy();
    expect(getBuildComputerPolicyIssue("host", BUILTIN_ACCESS_PROFILES[0])).toBeNull();
  });

  it("accepts coarse network authority and refuses domain rules", () => {
    expect(getBuildComputerPolicyIssue("bot-desktop", BUILTIN_ACCESS_PROFILES[2])).toBeNull();
    expect(
      getBuildComputerPolicyIssue("cua", {
        ...BUILTIN_ACCESS_PROFILES[2],
        domainRules: [{ pattern: "example.com", access: "allow" }],
      }),
    ).toBeTruthy();
  });
});

describe("pickBuildPreviewPath", () => {
  it("waits for a guest export receipt before opening a host preview", () => {
    const files = [
      { path: "index.html", action: "created" as const, timestamp: 3 },
      {
        path: "/w/artifacts/computers/current/index.html",
        action: "created" as const,
        timestamp: 2,
      },
    ];
    expect(pickBuildPreviewPath(files, [])).toBeNull();
    expect(pickBuildPreviewPath(files, ["artifacts/computers/current/index.html"])).toBe(
      "/w/artifacts/computers/current/index.html",
    );
  });
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
