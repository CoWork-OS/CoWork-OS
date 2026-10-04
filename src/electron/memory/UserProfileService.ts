/**
 * Facts about the user, as a profile view of `memory_items` (docs/memory-engine.md §5).
 *
 * The profile is no longer a store of its own: every fact is an active, non-private global
 * memory item (identity, preference, rule, insight; commitments are listed by
 * RelationshipMemoryService). Writes go through MemoryWriter; reads come from the
 * synchronous facts snapshot (`memory-facts-snapshot.ts`), which writes refresh before
 * they return. Facts are edited in the Memory Hub ("What CoWork knows").
 */
import { randomUUID } from "crypto";
import type {
  AddUserFactRequest,
  UserFact,
  UserFactCategory,
  UserProfile,
} from "../../shared/types";
import {
  extractPreferredNameFromMessage,
  sanitizePreferredNameMemoryLine,
} from "../utils/preferred-name";
import { MemoryFactsSnapshot } from "./memory-facts-snapshot";
import { memoryWriteSkipMessage } from "./memory-item-revise";
import { userFactCandidate } from "./memory-items-lanes";
import type { MemoryItem, MemoryItemSource } from "./memory-items-types";
import { MemoryItemsHubService } from "./MemoryItemsHubService";
import { MemoryWriter } from "./MemoryWriter";

const MAX_FACTS = 250;
const MAX_FACT_VALUE_LENGTH = 240;

const FACT_CATEGORIES: ReadonlySet<UserFactCategory> = new Set([
  "identity",
  "preference",
  "bio",
  "work",
  "goal",
  "operating",
  "voice",
  "accountability",
  "constraint",
  "other",
]);

const FACT_SOURCES: Partial<Record<MemoryItemSource, UserFact["source"]>> = {
  user_stated: "manual",
  user_confirmed: "feedback",
};

/** The profile category of a memory item: recorded at write, else derived from its kind. */
export function userFactCategoryOf(item: Pick<MemoryItem, "kind" | "sourceRef">): UserFactCategory {
  const recorded = item.sourceRef.category;
  if (typeof recorded === "string" && FACT_CATEGORIES.has(recorded as UserFactCategory)) {
    return recorded as UserFactCategory;
  }
  if (item.sourceRef.beliefType === "user_goal") return "goal";
  switch (item.kind) {
    case "identity":
      return "identity";
    case "preference":
      return "preference";
    case "rule":
      return "constraint";
    default:
      return "other";
  }
}

/** A global memory item as a profile fact. The fact id is the item id. */
export function toUserFact(item: MemoryItem): UserFact {
  return {
    id: item.id,
    category: userFactCategoryOf(item),
    value: item.content,
    confidence: item.confidence,
    source: FACT_SOURCES[item.source] ?? "conversation",
    ...(item.pinned ? { pinned: true } : {}),
    firstSeenAt: item.createdAt,
    lastUpdatedAt: item.updatedAt,
    ...(item.taskId ? { lastTaskId: item.taskId } : {}),
  };
}

function isProfileItem(item: MemoryItem): boolean {
  return (
    item.scope === "global" &&
    item.status === "active" &&
    item.privacy === "normal" &&
    item.kind !== "commitment"
  );
}

function sortFacts(facts: UserFact[]): UserFact[] {
  return [...facts].sort((a, b) => {
    const pinScore = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pinScore !== 0) return pinScore;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.lastUpdatedAt - a.lastUpdatedAt;
  });
}

function normalizeFactValue(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_FACT_VALUE_LENGTH);
}

function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0.7;
  return Math.max(0, Math.min(1, confidence));
}

function extractPreferredName(category: UserFactCategory, value: string): string | null {
  if (category !== "identity") return null;
  const normalizedValue = normalizeFactValue(value);
  const preferredNameLine = sanitizePreferredNameMemoryLine(normalizedValue);
  const lineMatch = preferredNameLine?.match(/^Preferred name:\s*(.+)$/i);
  if (lineMatch?.[1]) return lineMatch[1].trim();
  return extractPreferredNameFromMessage(normalizedValue);
}

function requireWriter(): MemoryWriter {
  const writer = MemoryWriter.get();
  if (!writer) throw new Error("Memory is not available yet.");
  return writer;
}

export class UserProfileService {
  /** The user's facts: active, non-private global memory items (snapshot). */
  static getProfile(): UserProfile {
    const facts = sortFacts(MemoryFactsSnapshot.items().filter(isProfileItem).map(toUserFact)).slice(
      0,
      MAX_FACTS,
    );
    return {
      facts,
      updatedAt: facts.reduce((latest, fact) => Math.max(latest, fact.lastUpdatedAt), 0),
    };
  }

  /**
   * Record a fact as a global memory item. A repeat of an active fact reinforces it. The
   * PersonalityManager user name follows an identity fact naming the user through the
   * read side (`memory-read-side.ts`), like every other `preferred_name` write.
   */
  static async addFact(request: AddUserFactRequest): Promise<UserFact> {
    const writer = requireWriter();
    const category: UserFactCategory = request.category || "other";
    const preferredName = extractPreferredName(category, request.value);
    const value = normalizeFactValue(
      preferredName ? `Preferred name: ${preferredName}` : request.value,
    );
    if (!value) throw new Error("Fact value is required");
    const now = Date.now();
    const candidate = userFactCandidate(
      {
        id: randomUUID(),
        category,
        value,
        confidence: clampConfidence(request.confidence ?? (request.source === "manual" ? 1 : 0.7)),
        source: request.source ?? "manual",
        pinned: request.pinned === true,
        firstSeenAt: now,
        lastUpdatedAt: now,
        lastTaskId: request.taskId,
      },
      { subjectKey: preferredName ? "preferred_name" : null },
    );
    if (!candidate) throw new Error("Fact value is not a valid identity fact");
    const result = await writer.ingest({ ...candidate, originText: value });
    if (result.status === "skipped") throw new Error(memoryWriteSkipMessage(result));
    await MemoryFactsSnapshot.refresh();
    return toUserFact(result.item);
  }

  /**
   * Forget a fact: the item and its older revisions become tombstones (a real delete, as
   * in the Memory Hub). Only global facts can be deleted here.
   */
  static async deleteFact(id: string): Promise<boolean> {
    const writer = MemoryWriter.get();
    if (!writer) return false;
    const item = await writer.repository.findById(id);
    if (!item || item.scope !== "global" || item.status === "deleted") return false;
    await new MemoryItemsHubService({ getWriter: () => writer }).removeItem(item, "deleted");
    await MemoryFactsSnapshot.refresh();
    return true;
  }
}
