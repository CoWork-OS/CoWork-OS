import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingProfileData } from "../../../shared/onboarding";

const userProfileServiceMock = vi.hoisted(() => ({
  getProfile: vi.fn(),
  deleteFact: vi.fn(),
  addFact: vi.fn(),
}));

const memoryServiceMock = vi.hoisted(() => ({
  syncWorkspaceMarkdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../memory/UserProfileService", () => ({
  UserProfileService: userProfileServiceMock,
}));

vi.mock("../../memory/MemoryService", () => ({
  MemoryService: memoryServiceMock,
}));

import { KIT_DIR_NAME } from "../../context/kit-status";
import { OnboardingProfileService } from "../OnboardingProfileService";

function buildProfile(overrides: Partial<OnboardingProfileData> = {}): OnboardingProfileData {
  return {
    assistantName: "CoWork",
    assistantTraits: ["adaptive"],
    userName: "Mesut",
    userContext: "I run product and coordinate shipping.",
    timeDrains: ["planning"],
    timeDrainsOther: "",
    priorities: ["automation"],
    prioritiesOther: "",
    workflowTools: "GitHub, Notion",
    responseStyle: "depends",
    responseStyleCustom: "",
    additionalGuidance: "Keep me moving.",
    voiceEnabled: false,
    workStyle: "planner",
    memoryEnabled: true,
    selectedProvider: "openrouter",
    detectedOllamaModel: null,
    ...overrides,
  };
}

describe("OnboardingProfileService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-onboarding-profile-"));
    userProfileServiceMock.getProfile.mockReset();
    userProfileServiceMock.deleteFact.mockReset();
    userProfileServiceMock.addFact.mockReset();
    memoryServiceMock.syncWorkspaceMarkdown.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaces onboarding-managed profile facts instead of accumulating them", () => {
    userProfileServiceMock.getProfile.mockReturnValue({
      updatedAt: Date.now(),
      facts: [
        {
          id: "legacy-context",
          category: "work",
          value: "I used to manage support queues.",
          confidence: 0.95,
          source: "manual",
          pinned: true,
          firstSeenAt: 1,
          lastUpdatedAt: 1,
        },
        {
          id: "managed-style",
          category: "preference",
          value: "Preferred response style: Detailed with context.",
          confidence: 0.95,
          source: "manual",
          pinned: true,
          firstSeenAt: 1,
          lastUpdatedAt: 1,
          lastTaskId: "onboarding-profile",
        },
        {
          id: "keep-me",
          category: "preference",
          value: "Prefers monospace screenshots.",
          confidence: 1,
          source: "manual",
          firstSeenAt: 1,
          lastUpdatedAt: 1,
        },
      ],
    });

    OnboardingProfileService.applyGlobalProfile(buildProfile());

    expect(userProfileServiceMock.deleteFact).toHaveBeenCalledWith("legacy-context");
    expect(userProfileServiceMock.deleteFact).toHaveBeenCalledWith("managed-style");
    expect(userProfileServiceMock.deleteFact).not.toHaveBeenCalledWith("keep-me");
    expect(userProfileServiceMock.addFact).toHaveBeenCalled();
    expect(
      userProfileServiceMock.addFact.mock.calls.every(
        ([request]) => request.taskId === "onboarding-profile",
      ),
    ).toBe(true);
  });

  it("overwrites stale priorities and tools sections when onboarding clears them", async () => {
    const kitRoot = path.join(tmpDir, KIT_DIR_NAME);
    fs.mkdirSync(kitRoot, { recursive: true });
    fs.writeFileSync(
      path.join(kitRoot, "PRIORITIES.md"),
      [
        "# Priorities",
        "",
        "## Onboarding Priorities",
        "<!-- cowork:auto:onboarding-priorities:start -->",
        "1. Old priority",
        "<!-- cowork:auto:onboarding-priorities:end -->",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(kitRoot, "TOOLS.md"),
      [
        "# Local Setup Notes",
        "",
        "## Onboarding Tool Stack",
        "<!-- cowork:auto:onboarding-tools:start -->",
        "- Core tools: Slack, Linear",
        "<!-- cowork:auto:onboarding-tools:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    await OnboardingProfileService.applyWorkspaceProfile(
      "workspace-1",
      tmpDir,
      buildProfile({
        priorities: [],
        prioritiesOther: "",
        workflowTools: "",
      }),
    );

    const prioritiesDoc = fs.readFileSync(path.join(kitRoot, "PRIORITIES.md"), "utf8");
    const toolsDoc = fs.readFileSync(path.join(kitRoot, "TOOLS.md"), "utf8");

    expect(prioritiesDoc).toContain("No explicit onboarding priorities recorded yet.");
    expect(prioritiesDoc).not.toContain("Old priority");
    expect(toolsDoc).toContain("No core apps or tools recorded yet.");
    expect(toolsDoc).not.toContain("Slack, Linear");
  });
});
