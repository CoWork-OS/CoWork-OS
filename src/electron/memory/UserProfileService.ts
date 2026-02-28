import { v4 as uuidv4 } from "uuid";
import {
  AddUserFactRequest,
  UpdateUserFactRequest,
  UserFact,
  UserFactCategory,
  UserProfile,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { PersonalityManager } from "../settings/personality-manager";
import {
  extractPreferredNameFromMessage,
  sanitizePreferredNameMemoryLine,
} from "../utils/preferred-name";
import { RelationshipMemoryService } from "./RelationshipMemoryService";

const MAX_FACTS = 250;
const MAX_FACT_VALUE_LENGTH = 240;

const EMPTY_PROFILE: UserProfile = {
  facts: [],
  updatedAt: 0,
};

export class UserProfileService {
  private static inMemoryProfile: UserProfile = { ...EMPTY_PROFILE };

  static getProfile(): UserProfile {
    return this.load();
  }

  static addFact(request: AddUserFactRequest): UserFact {
    const profile = this.load();
    const now = Date.now();
    const normalizedCategory = this.normalizeCategory(request.category);
    const normalizedValue = this.normalizeFactValue(request.value);
    const confidence = this.clampConfidence(
      request.confidence ?? (request.source === "manual" ? 1 : 0.7),
    );

    if (!normalizedValue) {
      throw new Error("Fact value is required");
    }

    const existing = profile.facts.find(
      (fact) =>
        fact.category === normalizedCategory &&
        this.normalizeForMatch(fact.value) === this.normalizeForMatch(normalizedValue),
    );

    if (existing) {
      existing.lastUpdatedAt = now;
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.source = request.source ?? existing.source;
      existing.lastTaskId = request.taskId ?? existing.lastTaskId;
      if (typeof request.pinned === "boolean") {
        existing.pinned = request.pinned;
      }
      this.save(profile);
      return existing;
    }

    const next: UserFact = {
      id: uuidv4(),
      category: normalizedCategory,
      value: normalizedValue,
      confidence,
      source: request.source ?? "manual",
      pinned: request.pinned === true ? true : undefined,
      firstSeenAt: now,
      lastUpdatedAt: now,
      lastTaskId: request.taskId,
    };

    profile.facts.push(next);
    if (profile.facts.length > MAX_FACTS) {
      profile.facts = this.sortFacts(profile.facts).slice(0, MAX_FACTS);
    }

    this.save(profile);
    return next;
  }

  static updateFact(request: UpdateUserFactRequest): UserFact | null {
    const profile = this.load();
    const fact = profile.facts.find((item) => item.id === request.id);
    if (!fact) return null;

    if (request.category) {
      fact.category = this.normalizeCategory(request.category);
    }
    if (typeof request.value === "string") {
      const normalized = this.normalizeFactValue(request.value);
      if (!normalized) {
        throw new Error("Fact value is required");
      }
      fact.value = normalized;
    }
    if (typeof request.confidence === "number") {
      fact.confidence = this.clampConfidence(request.confidence);
    }
    if (typeof request.pinned === "boolean") {
      fact.pinned = request.pinned;
    }
    fact.lastUpdatedAt = Date.now();

    this.save(profile);
    return fact;
  }

  static deleteFact(id: string): boolean {
    const profile = this.load();
    const originalLength = profile.facts.length;
    profile.facts = profile.facts.filter((fact) => fact.id !== id);
    if (profile.facts.length === originalLength) return false;
    this.save(profile);
    return true;
  }

  static ingestUserMessage(message: string, taskId?: string): void {
    const text = String(message || "").trim();
    if (!text) return;

    RelationshipMemoryService.ingestUserMessage(text, taskId);

    const extracted = this.extractFactsFromMessage(text, taskId);
    if (extracted.length === 0) return;

    for (const fact of extracted) {
      try {
        this.addFact(fact);
      } catch {
        // Ignore malformed extraction candidates.
      }
    }
  }

  static ingestUserFeedback(decision?: string, reason?: string, taskId?: string): void {
    const feedback = String(reason || "").trim();
    if (!feedback) return;

    RelationshipMemoryService.ingestUserFeedback(decision, feedback, taskId);

    const lowered = feedback.toLowerCase();
    const candidates: AddUserFactRequest[] = [];

    if (/\b(concise|shorter|too long|brief)\b/.test(lowered)) {
      candidates.push({
        category: "preference",
        value: "Prefers concise responses.",
        confidence: 0.85,
        source: "feedback",
        taskId,
      });
    }

    if (/\b(more detail|detailed|deeper)\b/.test(lowered)) {
      candidates.push({
        category: "preference",
        value: "Prefers detailed explanations when needed.",
        confidence: 0.85,
        source: "feedback",
        taskId,
      });
    }

    if (/\b(friendlier|warm|tone)\b/.test(lowered)) {
      candidates.push({
        category: "preference",
        value: "Prefers a warm and conversational tone.",
        confidence: 0.8,
        source: "feedback",
        taskId,
      });
    }

    if (decision && /\b(reject|deny|denied)\b/i.test(decision) && candidates.length === 0) {
      candidates.push({
        category: "constraint",
        value: `Avoid repeating previously rejected approach: ${feedback}`.slice(
          0,
          MAX_FACT_VALUE_LENGTH,
        ),
        confidence: 0.65,
        source: "feedback",
        taskId,
      });
    }

    for (const candidate of candidates) {
      try {
        this.addFact(candidate);
      } catch {
        // best-effort
      }
    }
  }

  static buildPromptContext(maxFacts = 8): string {
    const profile = this.load();
    const relationshipContext = RelationshipMemoryService.buildPromptContext({
      maxPerLayer: 2,
      maxChars: 900,
    });
    if (!profile.facts.length && !relationshipContext) return "";

    const selected = this.sortFacts(profile.facts).slice(0, Math.max(1, maxFacts));
    if (!selected.length) {
      return relationshipContext;
    }

    const lines = [
      "USER PROFILE MEMORY (soft context from prior conversations):",
      "- Use these as preferences/history hints.",
      "- If the user gives newer or conflicting info, prefer the latest user message.",
    ];

    for (const fact of selected) {
      const label = this.categoryLabel(fact.category);
      lines.push(`- ${label}: ${fact.value}`);
    }

    if (relationshipContext) {
      lines.push("");
      lines.push(relationshipContext);
    }

    return lines.join("\n");
  }

  private static extractFactsFromMessage(message: string, taskId?: string): AddUserFactRequest[] {
    const facts: AddUserFactRequest[] = [];
    const text = message.trim();
    const lowered = text.toLowerCase();

    const preferredName = extractPreferredNameFromMessage(text);
    if (preferredName) {
      facts.push({
        category: "identity",
        value: `Preferred name: ${preferredName}`,
        confidence: 0.95,
        source: "conversation",
        pinned: true,
        taskId,
      });
      try {
        PersonalityManager.setUserName(preferredName);
      } catch {
        // best-effort
      }
    }

    const preferenceMatch = text.match(
      /\b(?:i prefer|i like|i love|i dislike|i hate)\s+([^.!?\n]{3,120})/i,
    );
    if (preferenceMatch) {
      const preference = preferenceMatch[1].trim();
      if (preference.length >= 3) {
        const prefix = /\bi (?:dislike|hate)\b/i.test(lowered) ? "Dislikes" : "Prefers";
        facts.push({
          category: "preference",
          value: `${prefix}: ${preference}`.slice(0, MAX_FACT_VALUE_LENGTH),
          confidence: 0.75,
          source: "conversation",
          taskId,
        });
      }
    }

    const locationMatch = text.match(
      /\b(?:i live in|i am based in|i'm based in|i am in|i'm in)\s+([^.!?\n]{2,80})/i,
    );
    if (locationMatch) {
      facts.push({
        category: "bio",
        value: `Location: ${locationMatch[1].trim()}`.slice(0, MAX_FACT_VALUE_LENGTH),
        confidence: 0.7,
        source: "conversation",
        taskId,
      });
    }

    const goalMatch = text.match(/\b(?:my goal is|i want to|i need to)\s+([^.!?\n]{3,120})/i);
    if (goalMatch) {
      facts.push({
        category: "goal",
        value: `Goal: ${goalMatch[1].trim()}`.slice(0, MAX_FACT_VALUE_LENGTH),
        confidence: 0.65,
        source: "conversation",
        taskId,
      });
    }

    return facts.slice(0, 3);
  }

  private static normalizeCategory(category: UserFactCategory): UserFactCategory {
    return category || "other";
  }

  private static normalizeFactValue(value: string): string {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_FACT_VALUE_LENGTH);
  }

  private static normalizeForMatch(value: string): string {
    return this.normalizeFactValue(value).toLowerCase();
  }

  private static clampConfidence(confidence: number): number {
    if (!Number.isFinite(confidence)) return 0.7;
    return Math.max(0, Math.min(1, confidence));
  }

  private static categoryLabel(category: UserFactCategory): string {
    switch (category) {
      case "identity":
        return "Identity";
      case "preference":
        return "Preference";
      case "bio":
        return "Profile";
      case "work":
        return "Work context";
      case "goal":
        return "Goal";
      case "constraint":
        return "Constraint";
      default:
        return "Note";
    }
  }

  private static sortFacts(facts: UserFact[]): UserFact[] {
    return [...facts].sort((a, b) => {
      const pinScore = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (pinScore !== 0) return pinScore;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.lastUpdatedAt - a.lastUpdatedAt;
    });
  }

  private static load(): UserProfile {
    let profile: UserProfile | undefined;
    if (SecureSettingsRepository.isInitialized()) {
      try {
        const repo = SecureSettingsRepository.getInstance();
        profile = repo.load<UserProfile>("user-profile");
      } catch {
        // fallback to in-memory
      }
    }

    if (!profile || !Array.isArray(profile.facts)) {
      profile = this.inMemoryProfile;
    }

    let profileWasSanitized = false;
    const normalized: UserProfile = {
      summary: typeof profile.summary === "string" ? profile.summary : undefined,
      facts: Array.isArray(profile.facts)
        ? profile.facts
            .filter(
              (fact): fact is UserFact =>
                !!fact && typeof fact.value === "string" && typeof fact.id === "string",
            )
            .map((fact) => {
              const category = this.normalizeCategory(fact.category);
              const normalizedValue = this.normalizeFactValue(fact.value);
              const clampedConfidence = this.clampConfidence(fact.confidence);
              if (category !== fact.category) profileWasSanitized = true;
              if (normalizedValue !== fact.value) profileWasSanitized = true;
              if (clampedConfidence !== fact.confidence) profileWasSanitized = true;
              if (category === "identity") {
                const sanitizedIdentity = sanitizePreferredNameMemoryLine(normalizedValue);
                if (!sanitizedIdentity) {
                  profileWasSanitized = true;
                  return null;
                }
                if (sanitizedIdentity !== normalizedValue) profileWasSanitized = true;
                return {
                  ...fact,
                  value: sanitizedIdentity,
                  confidence: clampedConfidence,
                  category,
                };
              }
              return {
                ...fact,
                value: normalizedValue,
                confidence: clampedConfidence,
                category,
              };
            })
            .filter((fact): fact is UserFact => fact !== null)
        : [],
      updatedAt: Number.isFinite(profile.updatedAt) ? profile.updatedAt : 0,
    };

    this.inMemoryProfile = normalized;
    if (profileWasSanitized) {
      this.save(normalized);
    }
    return normalized;
  }

  private static save(profile: UserProfile): void {
    const normalized: UserProfile = {
      summary: profile.summary?.trim() || undefined,
      facts: this.sortFacts(profile.facts).slice(0, MAX_FACTS),
      updatedAt: Date.now(),
    };

    this.inMemoryProfile = normalized;

    if (!SecureSettingsRepository.isInitialized()) {
      return;
    }

    try {
      const repo = SecureSettingsRepository.getInstance();
      repo.save("user-profile", normalized);
    } catch (error) {
      console.warn("[UserProfileService] Failed to persist profile:", error);
    }
  }
}
