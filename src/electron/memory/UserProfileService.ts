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
import { bumpHotMemoryVersion } from "./hot-memory-version";
import { MemoryWriter } from "./MemoryWriter";
import { isMemoryReadSideActive } from "./memory-read-side";
import { MEMORY_LANE_STORES, userFactCandidate } from "./memory-items-lanes";

const MAX_FACTS = 250;
const MAX_FACT_VALUE_LENGTH = 240;

const EMPTY_PROFILE: UserProfile = {
  facts: [],
  updatedAt: 0,
};

export class UserProfileService {
  private static inMemoryProfile: UserProfile = { ...EMPTY_PROFILE };
  private static profileLoadFailed = false;

  static getProfile(): UserProfile {
    return this.load();
  }

  /**
   * `options.memorySubjectKey` names the single-valued memory subject the fact sets (for
   * example `response_length` from an awareness belief), so a newer value supersedes the
   * older one in `memory_items`; `options.memoryOriginWorkspaceId` is the workspace the
   * fact was learned in, whose memory settings govern that write.
   */
  static addFact(
    request: AddUserFactRequest,
    options: { memorySubjectKey?: string | null; memoryOriginWorkspaceId?: string | null } = {},
  ): UserFact {
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
      this.mirrorFact(existing, options);
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
    this.mirrorFact(next, options);
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
    this.mirrorFact(fact);
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
    MemoryWriter.dualWriteStatus(MEMORY_LANE_STORES.userProfile, id, "deleted", "profile delete");
    if (removedPreferredName) {
      this.syncPreferredNameFromProfile(profile);
    }
    return true;
  }

  /**
   * Dual write (memory engine Phase 2): the profile stays the system of record for reads
   * this wave; each saved fact is mirrored into `memory_items` in the background.
   */
  private static mirrorFact(
    fact: UserFact,
    options: { memorySubjectKey?: string | null; memoryOriginWorkspaceId?: string | null } = {},
  ): void {
    const candidate = userFactCandidate({ ...fact }, { subjectKey: options.memorySubjectKey });
    MemoryWriter.dualWrite(
      candidate && { ...candidate, originWorkspaceId: options.memoryOriginWorkspaceId ?? null },
      "profile fact",
    );
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
    // With the memory engine's read side running, PersonalityManager follows the active
    // `preferred_name` memory item (memory-read-side.ts): user-stated names win by trust.
    if (isMemoryReadSideActive()) return;
    // Legacy path (no writer yet, node daemon): the most trusted, then newest name. Not
    // pinned-first, which reverted every newer name to the pinned onboarding one (PROMPT-7).
    const sourceRank = (fact: UserFact) =>
      fact.source === "manual" ? 2 : fact.source === "feedback" ? 1 : 0;
    const preferredName = [...profile.facts]
      .sort((a, b) => sourceRank(b) - sourceRank(a) || b.lastUpdatedAt - a.lastUpdatedAt)
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
        const result = repo.loadWithStatus<UserProfile>("user-profile", { logErrors: false });
        if (result.status === "success") {
          this.profileLoadFailed = false;
          profile = result.data;
        } else if (result.status === "not_found") {
          this.profileLoadFailed = false;
        } else {
          this.profileLoadFailed = true;
          console.warn(
            `[UserProfileService] Could not read the saved profile (${result.status}); keeping the encrypted profile intact.`,
          );
          return this.inMemoryProfile;
        }
      } catch {
        this.profileLoadFailed = true;
        console.warn(
          "[UserProfileService] Could not read the saved profile; keeping the encrypted profile intact.",
        );
        return this.inMemoryProfile;
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
    if (this.profileLoadFailed) {
      throw new Error(
        "The saved profile could not be decrypted, so CoWork OS kept it intact and did not save over it.",
      );
    }

    const normalized: UserProfile = {
      summary: profile.summary?.trim() || undefined,
      facts: this.sortFacts(profile.facts).slice(0, MAX_FACTS),
      updatedAt: Date.now(),
    };

    this.inMemoryProfile = normalized;
    bumpHotMemoryVersion();

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
