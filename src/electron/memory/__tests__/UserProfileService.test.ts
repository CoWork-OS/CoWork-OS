import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../shared/types";

const mocks = vi.hoisted(() => {
  let storedProfile: UserProfile = { facts: [], updatedAt: 0 };

  return {
    get storedProfile() {
      return storedProfile;
    },
    set storedProfile(value: UserProfile) {
      storedProfile = value;
    },
    repositoryLoad: vi.fn(() => storedProfile),
    repositorySave: vi.fn((_key: string, profile: UserProfile) => {
      storedProfile = profile;
    }),
    setUserName: vi.fn(),
  };
});

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn(() => true),
    getInstance: vi.fn(() => ({
      load: mocks.repositoryLoad,
      save: mocks.repositorySave,
    })),
  },
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    setUserName: mocks.setUserName,
  },
}));

vi.mock("../RelationshipMemoryService", () => ({
  RelationshipMemoryService: {
    buildPromptContext: vi.fn(() => ""),
    ingestUserFeedback: vi.fn(),
    ingestUserMessage: vi.fn(),
  },
}));

import { UserProfileService } from "../UserProfileService";

describe("UserProfileService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedProfile = { facts: [], updatedAt: 0 };
  });

  it("canonicalizes manually added preferred names and syncs personality identity", () => {
    const fact = UserProfileService.addFact({
      category: "identity",
      value: "Please call me Alice.",
      source: "manual",
    });

    expect(fact.value).toBe("Preferred name: Alice");
    expect(mocks.setUserName).toHaveBeenCalledWith("Alice");
  });

  it("does not clear personality identity for non-name identity facts", () => {
    UserProfileService.addFact({
      category: "identity",
      value: "Pronouns: they/them",
      source: "manual",
    });

    expect(mocks.setUserName).not.toHaveBeenCalled();
  });

  it("clears personality identity when the preferred-name fact is deleted", () => {
    const fact = UserProfileService.addFact({
      category: "identity",
      value: "Call me Alex",
      source: "manual",
    });
    mocks.setUserName.mockClear();

    UserProfileService.deleteFact(fact.id);

    expect(mocks.setUserName).toHaveBeenCalledWith("");
  });

  it("syncs personality identity when an existing fact is reclassified as identity", () => {
    const fact = UserProfileService.addFact({
      category: "other",
      value: "Call me Sam",
      source: "manual",
    });
    mocks.setUserName.mockClear();

    const updated = UserProfileService.updateFact({
      id: fact.id,
      category: "identity",
    });

    expect(updated?.value).toBe("Preferred name: Sam");
    expect(mocks.setUserName).toHaveBeenCalledWith("Sam");
  });

  it("learns operating, voice, and accountability preferences from user messages", () => {
    UserProfileService.ingestUserMessage(
      "Please push back on weak ideas, talk to me in private chat bluntly, and hold me accountable if I ignore open loops.",
      "task-1",
    );

    const categories = mocks.storedProfile.facts.map((fact) => fact.category);
    expect(categories).toContain("operating");
    expect(categories).toContain("voice");
    expect(categories).toContain("accountability");
    expect(mocks.storedProfile.facts.map((fact) => fact.value)).toEqual(
      expect.arrayContaining([
        "Pushback: challenge weak ideas, unclear goals, and risky assumptions with evidence and a better move.",
        "Private voice: direct, casual, and candid.",
        "Accountability: notice repeated asks, ignored outputs, stale open loops, and push toward the next concrete action.",
      ]),
    );
  });

  it("does not treat quoted third-party preference text as the user's operating profile", () => {
    UserProfileService.ingestUserMessage(
      'This article says "push back on weak ideas" and "hold me accountable". Should we copy that?',
      "task-1",
    );

    expect(mocks.storedProfile.facts).toHaveLength(0);
  });

  it("honors explicit requests not to push back", () => {
    UserProfileService.ingestUserMessage("Please don't push back on small product ideas.", "task-1");

    expect(mocks.storedProfile.facts).toHaveLength(1);
    expect(mocks.storedProfile.facts[0]?.category).toBe("operating");
    expect(mocks.storedProfile.facts[0]?.value).toBe(
      "Pushback: keep challenges low-friction unless the risk or waste is material.",
    );
  });
});
