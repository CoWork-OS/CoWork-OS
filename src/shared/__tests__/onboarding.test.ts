import { describe, expect, it } from "vitest";
import {
  buildOnboardingProfileFacts,
  buildOnboardingWorkspaceSummary,
  buildOnboardingUserSummary,
  getResolvedResponseStyleLabel,
  parseOnboardingSlashCommand,
  type OnboardingProfileData,
} from "../onboarding";

const baseProfile = (): OnboardingProfileData => ({
  assistantName: "Atlas",
  assistantTraits: ["sharp", "adaptive"],
  userName: "Mesut",
  userContext: "I run product, write specs, and spend too much time coordinating work.",
  timeDrains: ["planning", "other"],
  timeDrainsOther: "Switching between client updates",
  priorities: ["automation", "other"],
  prioritiesOther: "Protecting deep work blocks",
  workflowTools: "Gmail, Notion, Google Calendar, GitHub",
  responseStyle: "custom",
  responseStyleCustom: "Lead with the answer, then give tradeoffs only when needed",
  additionalGuidance: "Push back on vague requests and keep me moving.",
  voiceEnabled: true,
  workStyle: "planner",
  memoryEnabled: true,
  selectedProvider: "openrouter",
  detectedOllamaModel: null,
});

describe("onboarding slash commands", () => {
  it("matches supported onboarding commands with no arguments", () => {
    expect(parseOnboardingSlashCommand("/start")).toEqual({
      matched: true,
      command: "/start",
    });
    expect(parseOnboardingSlashCommand(" /onboard ")).toEqual({
      matched: true,
      command: "/onboard",
    });
    expect(parseOnboardingSlashCommand("/begin")).toEqual({
      matched: true,
      command: "/begin",
    });
  });

  it("rejects slash commands with extra arguments or unrelated commands", () => {
    expect(parseOnboardingSlashCommand("/onboard again")).toEqual({ matched: false });
    expect(parseOnboardingSlashCommand("/schedule daily 9am")).toEqual({ matched: false });
    expect(parseOnboardingSlashCommand("start")).toEqual({ matched: false });
  });
});

describe("onboarding profile builders", () => {
  it("builds summaries that include custom multi-select answers", () => {
    const profile = baseProfile();
    const userSummary = buildOnboardingUserSummary(profile);
    const workspaceSummary = buildOnboardingWorkspaceSummary(profile);

    expect(userSummary).toContain(
      "Biggest drains: Planning and organizing, Switching between client updates.",
    );
    expect(userSummary).toContain(
      "Top priorities: Automate repetitive tasks, Protecting deep work blocks.",
    );
    expect(userSummary).toContain("Core tools: Gmail, Notion, Google Calendar, GitHub.");
    expect(userSummary).toContain(
      "Always keep in mind: Push back on vague requests and keep me moving.",
    );

    expect(workspaceSummary.assistantStyle).toContain("Sharp and efficient");
    expect(workspaceSummary.assistantStyle).toContain("Adapts to the task");
    expect(workspaceSummary.timeDrains).toEqual([
      "Planning and organizing",
      "Switching between client updates",
    ]);
    expect(workspaceSummary.priorities).toEqual([
      "Automate repetitive tasks",
      "Protecting deep work blocks",
    ]);
  });

  it("builds pinned facts for identity, work style, and preferences", () => {
    const facts = buildOnboardingProfileFacts(baseProfile());
    const factValues = facts.map((fact) => fact.value);

    expect(factValues).toContain("Preferred name: Mesut");
    expect(factValues).toContain(
      "Current work context: I run product, write specs, and spend too much time coordinating work.",
    );
    expect(factValues).toContain(
      "Main priorities: Automate repetitive tasks, Protecting deep work blocks.",
    );
    expect(factValues).toContain("Core tools: Gmail, Notion, Google Calendar, GitHub.");
    expect(factValues).toContain(
      "Preferred response style: Lead with the answer, then give tradeoffs only when needed.",
    );
    expect(factValues).toContain(
      "Onboarding guidance: Push back on vague requests and keep me moving.",
    );
    expect(factValues).toContain("Memory is enabled for useful recurring context.");
    expect(facts.some((fact) => fact.category === "identity" && fact.pinned)).toBe(true);
    expect(facts.some((fact) => fact.category === "goal" && fact.pinned)).toBe(true);
  });

  it("resolves built-in and custom response style labels", () => {
    const customProfile = baseProfile();
    expect(getResolvedResponseStyleLabel(customProfile)).toBe(
      "Lead with the answer, then give tradeoffs only when needed",
    );

    const detailedProfile = {
      ...customProfile,
      responseStyle: "detailed" as const,
      responseStyleCustom: "",
    };
    expect(getResolvedResponseStyleLabel(detailedProfile)).toBe("Detailed with context");
  });
});
