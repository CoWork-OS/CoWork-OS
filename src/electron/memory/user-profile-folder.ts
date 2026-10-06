/**
 * The user profile as a read model over the memory folder (docs/memory-repo-phase3-design.md
 * §5): the entries of `me.md` and `MEMORY.md` as `UserFact`s, cached for the synchronous
 * `UserProfileService.getProfile()` and refreshed when the folder starts and after every
 * change to it. A fact's id is its entry ref (`repo:<path>#L<n>`); the cache keeps each
 * entry's hash, so a delete never removes a line that moved.
 */
import type { UserFact, UserFactCategory } from "../../shared/types";
import { createLogger } from "../utils/logger";
import { MemoryRepoService } from "./repo/MemoryRepoService";
import {
  MEMORY_REPO_ENTRY_FILE,
  MEMORY_REPO_ME_FILE,
  memoryRepoRef,
  type MemoryRepoEntry,
} from "./repo/memory-repo-format";
import type { MemoryItemKind } from "./memory-items-types";

const logger = createLogger("UserProfileFolder");

/** Files whose entries are facts about the user. */
export const USER_PROFILE_FOLDER_FILES = [MEMORY_REPO_ENTRY_FILE, MEMORY_REPO_ME_FILE] as const;

const CATEGORIES: ReadonlySet<UserFactCategory> = new Set([
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

const TASK_SOURCE = /^cowork:\/\/tasks\/(.+)$/;

/** The profile category of a folder entry: its `category` tag, else from its kind. */
export function userFactCategoryOfEntry(entry: Pick<MemoryRepoEntry, "kind" | "metadata">): UserFactCategory {
  const tagged = entry.metadata.category;
  if (tagged && CATEGORIES.has(tagged as UserFactCategory)) return tagged as UserFactCategory;
  switch (entry.kind) {
    case "identity":
      return "identity";
    case "preference":
    case "correction":
      return "preference";
    case "rule":
      return "constraint";
    case "project_fact":
      return "work";
    default:
      return "other";
  }
}

/** The memory kind a profile category is written with (its category is kept as a tag). */
export function memoryKindForUserFactCategory(category: UserFactCategory): MemoryItemKind {
  switch (category) {
    case "preference":
    case "operating":
    case "voice":
    case "accountability":
      return "preference";
    case "constraint":
      return "rule";
    default:
      return "identity";
  }
}

function dayToMs(day: string | undefined): number {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : 0;
}

export function entryToUserFact(relPath: string, entry: MemoryRepoEntry): UserFact {
  const added = dayToMs(entry.metadata.added);
  const task = TASK_SOURCE.exec(entry.metadata.source ?? "");
  return {
    id: memoryRepoRef(relPath, entry.line),
    category: userFactCategoryOfEntry(entry),
    value: entry.text,
    confidence: entry.by === "user" ? 1 : 0.7,
    source: entry.by === "user" ? "manual" : "conversation",
    ...(relPath === MEMORY_REPO_ENTRY_FILE ? { pinned: true } : {}),
    firstSeenAt: added,
    lastUpdatedAt: added,
    ...(task ? { lastTaskId: task[1] } : {}),
  };
}

interface FolderFacts {
  facts: UserFact[];
  /** Entry hash by fact id. */
  hashes: Map<string, string>;
}

let cache: FolderFacts | null = null;
let cacheService: MemoryRepoService | null = null;
let running: Promise<void> | null = null;
let dirty = false;
let installed: (() => void) | null = null;

async function load(service: MemoryRepoService): Promise<FolderFacts> {
  const facts: UserFact[] = [];
  const hashes = new Map<string, string>();
  for (const file of USER_PROFILE_FOLDER_FILES) {
    for (const entry of await service.entries(file)) {
      // The workspace marker line is not a fact.
      if (entry.metadata.workspace) continue;
      const fact = entryToUserFact(file, entry);
      facts.push(fact);
      hashes.set(fact.id, entry.hash);
    }
  }
  return { facts, hashes };
}

export const UserProfileFolderModel = {
  /**
   * Keep the cache current: subscribe to the running folder service (and to the service
   * changing), and load now. Idempotent; returns a function that stops it.
   */
  install(): () => void {
    if (installed) return installed;
    let unsubscribeChanges: (() => void) | null = null;
    const attach = (service: MemoryRepoService | null) => {
      unsubscribeChanges?.();
      unsubscribeChanges = service ? service.onChange(() => void UserProfileFolderModel.refresh()) : null;
      void UserProfileFolderModel.refresh();
    };
    const unsubscribeInstance = MemoryRepoService.onInstanceChange(attach);
    attach(MemoryRepoService.get());
    installed = () => {
      unsubscribeInstance();
      unsubscribeChanges?.();
      installed = null;
    };
    return installed;
  },

  /** Reload from the running folder; concurrent calls share a pass plus at most one more. */
  refresh(): Promise<void> {
    if (running) {
      dirty = true;
      return running;
    }
    running = (async () => {
      do {
        dirty = false;
        const service = MemoryRepoService.get();
        try {
          if (!service?.isReady()) {
            cache = null;
            cacheService = null;
          } else {
            const next = await load(service);
            // A restart at another path while loading: the next pass reloads.
            if (MemoryRepoService.get() === service) {
              cache = next;
              cacheService = service;
            }
          }
        } catch (error) {
          logger.warn("Refreshing the profile from the memory folder failed:", error);
        }
      } while (dirty);
    })().finally(() => {
      running = null;
    });
    return running;
  },

  /**
   * The facts, or null when the folder is off, not ready, or not loaded yet (the profile
   * then falls back to `memory_items`).
   */
  facts(): UserFact[] | null {
    const service = MemoryRepoService.get();
    if (!service?.isReady() || !cache || cacheService !== service) return null;
    return cache.facts;
  },

  /** The hash of a fact's entry when the cache knows it. */
  hashOf(id: string): string | undefined {
    return cache?.hashes.get(id);
  },

  /** Tests. */
  reset(): void {
    installed?.();
    cache = null;
    cacheService = null;
    dirty = false;
  },
};
