/**
 * Facts about the user (docs/memory-repo-phase3-design.md §5).
 *
 * With the memory folder running, the profile is a read model over it: the entries of
 * `me.md` and `MEMORY.md` (user-profile-folder.ts) plus PersonalityManager's name, and
 * facts are written there (`me.md`, the user's lines). With the folder off or unavailable,
 * the profile is the view of `memory_items` it was before: active, non-private global items
 * from the synchronous facts snapshot (`memory-facts-snapshot.ts`), written through
 * MemoryWriter. Facts are edited in the Memory Hub ("What CoWork knows").
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
import { PersonalityManager } from "../settings/personality-manager";
import { parseMemoryRepoRef } from "./repo/memory-repo-format";
import {
  PREFERRED_NAME_SUBJECT,
  memoryRepoSkipMessage,
  preferredNameEntryText,
  writableMemoryRepo,
} from "./repo/memory-repo-producers";
import {
  USER_PROFILE_FOLDER_FILES,
  UserProfileFolderModel,
  entryToUserFact,
  memoryKindForUserFactCategory,
} from "./user-profile-folder";

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

/** PersonalityManager's name as an identity fact; folder lines naming the user give way to it. */
const PERSONALITY_NAME_FACT_ID = "personality:preferred_name";

function personalityName(): string | null {
  try {
    return PersonalityManager.getUserName()?.trim() || null;
  } catch {
    return null;
  }
}

function setPersonalityName(name: string): void {
  try {
    PersonalityManager.setUserName(name);
  } catch {
    // PersonalityManager is not initialized (CLI, tests); the fact is still saved.
  }
}

function withPersonalityName(facts: UserFact[]): UserFact[] {
  const name = personalityName();
  if (!name) return facts;
  const rest = facts.filter((fact) => !/^\s*preferred name\s*:/i.test(fact.value));
  return [
    {
      id: PERSONALITY_NAME_FACT_ID,
      category: "identity",
      value: `Preferred name: ${name}`,
      confidence: 1,
      source: "manual",
      pinned: true,
      firstSeenAt: 0,
      lastUpdatedAt: 0,
    },
    ...rest,
  ];
}

function requireWriter(): MemoryWriter {
  const writer = MemoryWriter.get();
  if (!writer) throw new Error("Memory is not available yet.");
  return writer;
}

export class UserProfileService {
  /**
   * The user's facts: the memory folder's `me.md` and `MEMORY.md` entries and the
   * PersonalityManager name when the folder runs; otherwise the active, non-private global
   * memory items (snapshot).
   */
  static getProfile(): UserProfile {
    UserProfileFolderModel.install();
    const folderFacts = UserProfileFolderModel.facts();
    const source = folderFacts
      ? withPersonalityName(folderFacts)
      : MemoryFactsSnapshot.items().filter(isProfileItem).map(toUserFact);
    const facts = sortFacts(source).slice(0, MAX_FACTS);
    return {
      facts,
      updatedAt: facts.reduce((latest, fact) => Math.max(latest, fact.lastUpdatedAt), 0),
    };
  }

  /**
   * Record a fact. With the memory folder running: a line in `me.md` (`by: user` for a
   * manual fact), its category kept as a tag, and `origin` tagged when given (onboarding).
   * Otherwise a global memory item; a repeat of an active fact reinforces it. A fact naming
   * the user also sets PersonalityManager's name (the source of truth).
   */
  static async addFact(
    request: AddUserFactRequest,
    options: { origin?: "onboarding" } = {},
  ): Promise<UserFact> {
    const category: UserFactCategory = request.category || "other";
    const preferredName = extractPreferredName(category, request.value);
    const value = normalizeFactValue(
      preferredName ? `Preferred name: ${preferredName}` : request.value,
    );
    if (!value) throw new Error("Fact value is required");
    const repo = writableMemoryRepo();
    if (repo) {
      const kind = memoryKindForUserFactCategory(category);
      const manual = (request.source ?? "manual") !== "conversation";
      const result = await repo.remember({
        text: preferredName ? preferredNameEntryText(preferredName) : value,
        kind,
        scope: "global",
        by: manual ? "user" : "agent",
        // Onboarding facts live in me.md; a fact the user pins elsewhere goes to MEMORY.md.
        pinned: options.origin ? false : request.pinned === true,
        subject: preferredName ? PREFERRED_NAME_SUBJECT : null,
        taskId: options.origin ? null : (request.taskId ?? null),
        origin: options.origin ?? "memory_hub",
        skipWorkspacePolicy: manual,
        metadata: {
          ...(category !== "identity" && category !== "preference" ? { category } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
        },
      });
      if (result.status === "skipped") throw new Error(memoryRepoSkipMessage(result));
      if (preferredName) setPersonalityName(preferredName);
      await UserProfileFolderModel.refresh();
      const entry = await repo.entryAt(result.path, result.line);
      if (entry) return entryToUserFact(result.path, entry);
      throw new Error("The fact was saved but could not be read back.");
    }
    const writer = requireWriter();
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
    if (preferredName) setPersonalityName(preferredName);
    await MemoryFactsSnapshot.refresh();
    return toUserFact(result.item);
  }

  /**
   * Replace the facts tagged `origin` (onboarding) in the memory folder: forget the old
   * tagged lines, then write the new ones. Returns false when the folder is not running
   * (the caller replaces them in `memory_items`).
   */
  static async replaceTaggedFacts(
    origin: "onboarding",
    facts: AddUserFactRequest[],
  ): Promise<boolean> {
    const repo = writableMemoryRepo();
    if (!repo) return false;
    await repo.forgetWhere((entry) => entry.metadata.origin === origin, {
      files: [...USER_PROFILE_FOLDER_FILES],
      message: `Replace ${origin} facts`,
      origin,
    });
    for (const fact of facts) {
      try {
        await this.addFact(fact, { origin });
      } catch {
        // Best-effort; a duplicate or invalid fact does not block the rest.
      }
    }
    await UserProfileFolderModel.refresh();
    return true;
  }

  /**
   * Forget a fact. A folder fact (id `repo:<path>#L<n>`) loses its line, guarded by the
   * hash the profile read; a memory item and its older revisions become tombstones (a real
   * delete, as in the Memory Hub). Only global facts can be deleted here.
   */
  static async deleteFact(id: string): Promise<boolean> {
    const ref = parseMemoryRepoRef(id);
    if (ref) {
      const repo = writableMemoryRepo();
      const hash = UserProfileFolderModel.hashOf(id);
      if (!repo || !hash || !(USER_PROFILE_FOLDER_FILES as readonly string[]).includes(ref.path)) {
        return false;
      }
      const result = await repo.forget(ref.path, ref.line, { expectHash: hash, origin: "memory_hub" });
      await UserProfileFolderModel.refresh();
      return Boolean(result.removed);
    }
    const writer = MemoryWriter.get();
    if (!writer) return false;
    const item = await writer.repository.findById(id);
    if (!item || item.scope !== "global" || item.status === "deleted") return false;
    await new MemoryItemsHubService({ getWriter: () => writer }).removeItem(item, "deleted");
    await MemoryFactsSnapshot.refresh();
    return true;
  }
}
