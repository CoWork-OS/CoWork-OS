import type { UserFact, UserFactCategory, UserProfile } from "./types";

export interface UserProfileSummarySection {
  id: UserFactCategory;
  title: string;
  facts: UserFact[];
}

const CATEGORY_ORDER: UserFactCategory[] = [
  "identity",
  "bio",
  "work",
  "goal",
  "operating",
  "voice",
  "accountability",
  "preference",
  "constraint",
  "other",
];

const CATEGORY_LABELS: Record<UserFactCategory, string> = {
  identity: "Identity",
  bio: "Profile",
  work: "Work",
  goal: "Goals",
  operating: "Operating Style",
  voice: "Voice",
  accountability: "Accountability",
  preference: "Preferences",
  constraint: "Constraints",
  other: "Other",
};

export function getUserFactCategoryLabel(category: UserFactCategory): string {
  return CATEGORY_LABELS[category] || CATEGORY_LABELS.other;
}

export function inferUserFactCategory(value: string): UserFactCategory {
  const text = value.trim().toLowerCase();
  if (!text) return "other";

  if (/\b(live in|based in|location|birthday|family|profile|bio)\b/.test(text)) {
    return "bio";
  }
  if (/\b(name|call me|preferred name|pronouns)\b/.test(text)) {
    return "identity";
  }
  if (
    /\b(work|job|company|team|role|founder|engineer|designer|researcher|building)\b/.test(text)
  ) {
    return "work";
  }
  if (/\b(goal|aim|want to|need to|trying to|plan to|focus on)\b/.test(text)) {
    return "goal";
  }
  if (
    /\b(push back|challenge me|disagree|call me out|direct recommendation|make the call)\b/.test(
      text,
    )
  ) {
    return "operating";
  }
  if (
    /\b(private chat|public writing|published content|voice mode|tone mode|write publicly)\b/.test(
      text,
    )
  ) {
    return "voice";
  }
  if (
    /\b(hold me accountable|keep me accountable|if i ignore|stalled|open loops?)\b/.test(text)
  ) {
    return "accountability";
  }
  if (/\b(prefer|like|love|dislike|hate|style|tone|format|always|usually)\b/.test(text)) {
    return "preference";
  }
  if (/\b(avoid|don't|do not|never|constraint|must not|cannot|can't|sensitive)\b/.test(text)) {
    return "constraint";
  }

  return "other";
}

export function sortUserFacts(facts: UserFact[]): UserFact[] {
  return [...facts].sort((left, right) => {
    const pinned = (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0);
    if (pinned !== 0) return pinned;
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.lastUpdatedAt - left.lastUpdatedAt;
  });
}

export function buildStructuredUserProfileSummary(
  profile: UserProfile | null | undefined,
): UserProfileSummarySection[] {
  const facts = Array.isArray(profile?.facts) ? profile.facts : [];
  const sections: UserProfileSummarySection[] = [];

  for (const category of CATEGORY_ORDER) {
    const categoryFacts = sortUserFacts(facts.filter((fact) => fact.category === category));
    if (!categoryFacts.length) continue;
    sections.push({
      id: category,
      title: getUserFactCategoryLabel(category),
      facts: categoryFacts,
    });
  }

  return sections;
}
