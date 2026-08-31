import { describe, expect, it } from "vitest";
import type { UserFact, UserProfile } from "../types";
import { buildStructuredUserProfileSummary, inferUserFactCategory } from "../user-profile-summary";

function fact(overrides: Partial<UserFact>): UserFact {
  return {
    id: overrides.id || "fact",
    category: overrides.category || "other",
    value: overrides.value || "Remember this.",
    confidence: overrides.confidence ?? 0.8,
    source: overrides.source || "manual",
    firstSeenAt: overrides.firstSeenAt ?? 1,
    lastUpdatedAt: overrides.lastUpdatedAt ?? 1,
    pinned: overrides.pinned,
    lastTaskId: overrides.lastTaskId,
  };
}

describe("user-profile-summary", () => {
  it("groups facts into stable structured sections", () => {
    const profile: UserProfile = {
      updatedAt: 20,
      facts: [
        fact({ id: "pref", category: "preference", value: "Prefers concise replies." }),
        fact({ id: "identity", category: "identity", value: "Preferred name: Alex." }),
        fact({ id: "goal", category: "goal", value: "Goal: ship the launch plan." }),
        fact({ id: "pushback", category: "operating", value: "Pushback: challenge weak ideas." }),
        fact({ id: "voice", category: "voice", value: "Private voice: direct." }),
        fact({
          id: "accountability",
          category: "accountability",
          value: "Accountability: flag stale loops.",
        }),
      ],
    };

    const sections = buildStructuredUserProfileSummary(profile);

    expect(sections.map((section) => section.title)).toEqual([
      "Identity",
      "Goals",
      "Operating Style",
      "Voice",
      "Accountability",
      "Preferences",
    ]);
  });

  it("orders pinned and high-confidence facts first within a section", () => {
    const profile: UserProfile = {
      updatedAt: 20,
      facts: [
        fact({
          id: "older",
          category: "work",
          value: "Works on docs.",
          confidence: 0.9,
          lastUpdatedAt: 10,
        }),
        fact({
          id: "newer",
          category: "work",
          value: "Works on releases.",
          confidence: 0.7,
          lastUpdatedAt: 20,
        }),
        fact({
          id: "pinned",
          category: "work",
          value: "Founder.",
          confidence: 0.6,
          lastUpdatedAt: 5,
          pinned: true,
        }),
      ],
    };

    const [work] = buildStructuredUserProfileSummary(profile);

    expect(work.facts.map((entry) => entry.id)).toEqual(["pinned", "older", "newer"]);
  });

  it("infers categories for direct profile updates", () => {
    expect(inferUserFactCategory("Please call me Alex")).toBe("identity");
    expect(inferUserFactCategory("I am based in Lisbon")).toBe("bio");
    expect(inferUserFactCategory("I work on Electron apps")).toBe("work");
    expect(inferUserFactCategory("My goal is to publish weekly")).toBe("goal");
    expect(inferUserFactCategory("Please push back on weak ideas")).toBe("operating");
    expect(inferUserFactCategory("Public writing should be sharper")).toBe("voice");
    expect(inferUserFactCategory("Hold me accountable when I ignore open loops")).toBe(
      "accountability",
    );
    expect(inferUserFactCategory("I prefer concise status updates")).toBe("preference");
    expect(inferUserFactCategory("Never include emojis")).toBe("constraint");
  });
});
