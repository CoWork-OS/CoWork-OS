import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../shared/types";
import type { LoadResult } from "../../database/SecureSettingsRepository";

const mocks = vi.hoisted(() => {
  let storedProfile: UserProfile = { facts: [], updatedAt: 0 };

  return {
    get storedProfile() {
      return storedProfile;
    },
    set storedProfile(value: UserProfile) {
      storedProfile = value;
    },
    repositoryLoadWithStatus: vi.fn(
      (): LoadResult<UserProfile> => ({ status: "success", data: storedProfile }),
    ),
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
      loadWithStatus: mocks.repositoryLoadWithStatus,
      save: mocks.repositorySave,
    })),
  },
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    setUserName: mocks.setUserName,
  },
}));

import { UserProfileService } from "../UserProfileService";

describe("UserProfileService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedProfile = { facts: [], updatedAt: 0 };
    mocks.repositoryLoadWithStatus.mockImplementation(() => ({
      status: "success",
      data: mocks.storedProfile,
    }));
  });

  it("does not overwrite an encrypted profile when it cannot be decrypted", () => {
    mocks.repositoryLoadWithStatus.mockReturnValue({
      status: "decryption_failed",
      error: "Keychain service is unavailable",
    });

    expect(UserProfileService.getProfile()).toEqual({ facts: [], updatedAt: 0 });
    expect(() =>
      UserProfileService.addFact({
        category: "other",
        value: "A new fact",
        source: "manual",
      }),
    ).toThrow("kept it intact and did not save over it");
    expect(mocks.repositorySave).not.toHaveBeenCalled();
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
});
