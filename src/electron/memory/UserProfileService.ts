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
    const preferredName = this.extractPreferredNameFromFactValue(normalizedCategory, request.value);
    const normalizedValue = this.normalizeFactValue(
      preferredName ? `Preferred name: ${preferredName}` : request.value,
    );
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
      if (preferredName) {
        this.syncPreferredNameFromProfile(profile);
      }
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
    if (preferredName) {
      this.syncPreferredNameFromProfile(profile);
    }
    return next;
  }

  static updateFact(request: UpdateUserFactRequest): UserFact | null {
    const profile = this.load();
    const fact = profile.facts.find((item) => item.id === request.id);
    if (!fact) return null;
    const previousCategory = fact.category;
    const previousPreferredName = this.extractPreferredNameFromFactValue(fact.category, fact.value);

    const nextCategory = request.category
      ? this.normalizeCategory(request.category)
      : fact.category;
    const nextValue = typeof request.value === "string" ? request.value : fact.value;
    const nextPreferredName = this.extractPreferredNameFromFactValue(nextCategory, nextValue);
    fact.category = nextCategory;
    if (
      typeof request.value === "string" ||
      (previousCategory !== nextCategory && nextPreferredName)
    ) {
      const normalized = this.normalizeFactValue(
        nextPreferredName ? `Preferred name: ${nextPreferredName}` : nextValue,
      );
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
    if (
      previousPreferredName ||
      nextPreferredName ||
      (typeof request.value !== "string" &&
        previousCategory !== nextCategory &&
        previousCategory === "identity")
    ) {
      this.syncPreferredNameFromProfile(profile);
    }
    return fact;
  }

  static deleteFact(id: string): boolean {
    const profile = this.load();
    const originalLength = profile.facts.length;
    const removed = profile.facts.find((fact) => fact.id === id);
    const removedPreferredName = removed
      ? this.extractPreferredNameFromFactValue(removed.category, removed.value)
      : null;
    profile.facts = profile.facts.filter((fact) => fact.id !== id);
    if (profile.facts.length === originalLength) return false;
    this.save(profile);
    if (removedPreferredName) {
      this.syncPreferredNameFromProfile(profile);
    }
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

    const operatingFact = this.extractOperatingFact(text, taskId);
    if (operatingFact) {
      facts.push(operatingFact);
    }

    const voiceFact = this.extractVoiceFact(text, lowered, taskId);
    if (voiceFact) {
      facts.push(voiceFact);
    }

    const accountabilityFact = this.extractAccountabilityFact(text, lowered, taskId);
    if (accountabilityFact) {
      facts.push(accountabilityFact);
    }

    return this.prioritizeFactCandidates(facts).slice(0, 8);
  }

  private static extractOperatingFact(text: string, taskId?: string): AddUserFactRequest | null {
    const signalText = this.stripQuotedSegments(text);
    const signalLowered = signalText.toLowerCase();
    if (!this.isDirectPreferenceStatement(signalText)) {
      return null;
    }

    if (
      /\b(?:don't|do not|stop|avoid)\s+(?:push(?:ing)? back|challeng(?:e|ing)|argu(?:e|ing)|disagree(?:ing)?)\b/i.test(
        signalText,
      )
    ) {
      return {
        category: "operating",
        value: "Pushback: keep challenges low-friction unless the risk or waste is material.",
        confidence: 0.78,
        source: "conversation",
        taskId,
      };
    }

    if (/\b(?:push back|challenge me|disagree with me|call me out)\b/i.test(signalText)) {
      return {
        category: "operating",
        value:
          "Pushback: challenge weak ideas, unclear goals, and risky assumptions with evidence and a better move.",
        confidence: 0.82,
        source: "conversation",
        taskId,
      };
    }

    if (
      /\b(?:make the call|pick (?:one|the best)|recommend directly|default to action|don't ask permission)\b/i.test(
        signalText,
      )
    ) {
      return {
        category: "operating",
        value: "Decision style: make a clear recommendation and proceed on low-stakes choices.",
        confidence: 0.78,
        source: "conversation",
        taskId,
      };
    }

    if (
      /\b(?:ask first|check with me|don't proceed|do not proceed)\b/i.test(signalText) &&
      signalLowered.includes("before")
    ) {
      return {
        category: "operating",
        value: "Decision style: ask before proceeding when the next step changes scope or risk.",
        confidence: 0.74,
        source: "conversation",
        taskId,
      };
    }

    return null;
  }

  private static extractVoiceFact(
    text: string,
    _lowered: string,
    taskId?: string,
  ): AddUserFactRequest | null {
    const signalText = this.stripQuotedSegments(text);
    if (!this.isDirectPreferenceStatement(signalText)) {
      return null;
    }

    if (
      /\b(?:private chat|talk to me|when we chat)\b/i.test(signalText) &&
      /\b(?:blunt(?:ly)?|casual|direct|unfiltered)\b/i.test(signalText)
    ) {
      return {
        category: "voice",
        value: "Private voice: direct, casual, and candid.",
        confidence: 0.78,
        source: "conversation",
        taskId,
      };
    }

    if (/\b(?:public writing|published content|write publicly|external copy)\b/i.test(signalText)) {
      const style = signalText
        .match(
          /\b(?:public writing|published content|write publicly|external copy)[^.!?\n]{0,120}/i,
        )?.[0]
        ?.trim();
      return {
        category: "voice",
        value:
          `Public voice: ${style || "use a sharper, audience-safe voice distinct from private chat."}`.slice(
            0,
            MAX_FACT_VALUE_LENGTH,
          ),
        confidence: 0.76,
        source: "conversation",
        taskId,
      };
    }

    return null;
  }

  private static extractAccountabilityFact(
    text: string,
    _lowered: string,
    taskId?: string,
  ): AddUserFactRequest | null {
    const signalText = this.stripQuotedSegments(text);
    if (!this.isDirectPreferenceStatement(signalText)) {
      return null;
    }

    if (
      /\b(?:hold me accountable|keep me accountable|call me out if|if i ignore|stop me from)\b/i.test(
        signalText,
      )
    ) {
      return {
        category: "accountability",
        value:
          "Accountability: notice repeated asks, ignored outputs, stale open loops, and push toward the next concrete action.",
        confidence: 0.82,
        source: "conversation",
        taskId,
      };
    }

    return null;
  }

  private static isDirectPreferenceStatement(text: string): boolean {
    return /\b(?:i want you to|i don't want you to|i do not want you to|i need you to|i prefer|please|please always|for me|with me|when we work|when you respond|talk to me|hold me accountable|keep me accountable|call me out|push back on me|challenge me)\b/i.test(
      text,
    );
  }

  private static stripQuotedSegments(text: string): string {
    return String(text || "")
      .replace(/"[^"]*"/g, " ")
      .replace(/'[^']*'/g, " ")
      .replace(/`[^`]*`/g, " ");
  }

  private static prioritizeFactCandidates(facts: AddUserFactRequest[]): AddUserFactRequest[] {
    const categoryPriority: Record<UserFactCategory, number> = {
      identity: 0,
      operating: 1,
      voice: 2,
      accountability: 3,
      preference: 4,
      constraint: 5,
      goal: 6,
      work: 7,
      bio: 8,
      other: 9,
    };

    return facts.sort((left, right) => {
      const priorityDelta = categoryPriority[left.category] - categoryPriority[right.category];
      if (priorityDelta !== 0) return priorityDelta;
      return (right.confidence ?? 0.7) - (left.confidence ?? 0.7);
    });
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

  private static extractPreferredNameFromFactValue(
    category: UserFactCategory,
    value: string,
  ): string | null {
    if (category !== "identity") return null;

    const normalizedValue = this.normalizeFactValue(value);
    const preferredNameLine = sanitizePreferredNameMemoryLine(normalizedValue);
    const lineMatch = preferredNameLine?.match(/^Preferred name:\s*(.+)$/i);
    if (lineMatch?.[1]) return lineMatch[1].trim();

    return extractPreferredNameFromMessage(normalizedValue);
  }

  private static syncPreferredNameFromProfile(profile: UserProfile): void {
    const preferredName = this.sortFacts(profile.facts)
      .map((fact) => this.extractPreferredNameFromFactValue(fact.category, fact.value))
      .find((name): name is string => Boolean(name));

    try {
      PersonalityManager.setUserName(preferredName || "");
    } catch {
      // Personality settings may be unavailable in isolated tests or early startup.
    }
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
      case "operating":
        return "Operating style";
      case "voice":
        return "Voice";
      case "accountability":
        return "Accountability";
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
