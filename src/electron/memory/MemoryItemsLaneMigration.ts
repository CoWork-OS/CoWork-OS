/**
 * One-time copy of the legacy memory lanes into `memory_items` (docs/memory-engine.md,
 * "Lane migration").
 *
 * Order matters: curated entries, then profile facts, then relationship items, then
 * awareness beliefs (oldest first, so a newer belief about a single-valued subject
 * supersedes an older one), then the adaptive response style and the stored user name.
 * Every record goes through `MemoryWriter.ingest` in `migration` mode, so the normal
 * salience, redaction, dedupe and supersession rules apply, and a record whose source ref
 * is already present is skipped. A partial run is therefore safe to repeat; the marker in
 * `maintenance_state` is written only after every lane has been read.
 *
 * The legacy stores are left untouched and stay readable until their consumers switch.
 */
import type {
  AwarenessBelief,
  CuratedMemoryEntry,
  ResponseStylePreferences,
  UserFact,
} from "../../shared/types";
import type { SettingsCategory } from "../database/SecureSettingsRepository";
import { createLogger } from "../utils/logger";
import type { MemoryWriter, MemoryCandidate, MemoryWriteResult } from "./MemoryWriter";
import {
  MEMORY_LANE_STORES,
  beliefCandidate,
  curatedEntryCandidate,
  preferredNameCandidate,
  relationshipItemCandidate,
  responseStyleCandidate,
  userFactCandidate,
} from "./memory-items-lanes";
import type { RelationshipMemoryItem } from "./RelationshipMemoryService";

const logger = createLogger("MemoryItemsLaneMigration");

export interface LegacyLaneSources {
  userProfileFacts: () => UserFact[];
  relationshipItems: () => RelationshipMemoryItem[];
  awarenessBeliefs: () => AwarenessBelief[];
  /** The current style when AdaptiveStyleEngine has adapted it at least once, else null. */
  adaptiveResponseStyle: () => { style: Partial<ResponseStylePreferences>; reason?: string } | null;
  /** The stored user name (PersonalityManager), if any. */
  userName: () => string | undefined;
}

export type LaneName =
  | "curated"
  | "userProfile"
  | "relationship"
  | "awareness"
  | "adaptiveStyle"
  | "userName";

export interface LaneCounts {
  read: number;
  written: number;
  skipped: number;
  failed: number;
}

export interface LaneMigrationResult {
  ran: boolean;
  lanes: Record<LaneName, LaneCounts>;
}

function emptyLanes(): Record<LaneName, LaneCounts> {
  const lanes = {} as Record<LaneName, LaneCounts>;
  for (const lane of [
    "curated",
    "userProfile",
    "relationship",
    "awareness",
    "adaptiveStyle",
    "userName",
  ] as const) {
    lanes[lane] = { read: 0, written: 0, skipped: 0, failed: 0 };
  }
  return lanes;
}

/**
 * Default sources: the legacy services, loaded lazily so this module stays cheap to import
 * and testable with fakes.
 */
export async function loadLegacyLaneSources(): Promise<LegacyLaneSources> {
  const [
    { UserProfileService },
    { RelationshipMemoryService },
    { SecureSettingsRepository },
    { PersonalityManager },
  ] = await Promise.all([
    import("./UserProfileService"),
    import("./RelationshipMemoryService"),
    import("../database/SecureSettingsRepository"),
    import("../settings/personality-manager"),
  ]);
  /**
   * The stored value, undefined when absent; throws when the blob exists but cannot be
   * read, so the lane counts as failed and the migration is retried rather than recorded
   * as complete with nothing copied.
   */
  const loadSetting = <T extends object>(key: SettingsCategory): T | undefined => {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("Secure settings are not initialized");
    }
    const result = SecureSettingsRepository.getInstance().loadWithStatus<T>(key, {
      logErrors: false,
    });
    if (result.status === "success") return result.data;
    if (result.status === "not_found") return undefined;
    throw new Error(`Settings ${key} could not be read (${result.status})`);
  };
  return {
    // The services normalize what they load (identity sanitizing, legacy mailbox labels);
    // the status check first makes an unreadable blob fail the lane instead of reading empty.
    userProfileFacts: () => {
      loadSetting("user-profile");
      return UserProfileService.getProfile().facts;
    },
    relationshipItems: () => {
      loadSetting("relationship-memory");
      return RelationshipMemoryService.listItems({ includeDone: true, limit: 10_000 });
    },
    // Read the persisted state directly: constructing AwarenessService here would start
    // its pollers.
    awarenessBeliefs: () => {
      const state = loadSetting<{ beliefs?: AwarenessBelief[] }>("awareness-state");
      return Array.isArray(state?.beliefs) ? state.beliefs : [];
    },
    adaptiveResponseStyle: () => {
      const state = loadSetting<{
        adaptationHistory?: Array<{ reason?: string; appliedAt?: number }>;
      }>("adaptive-style-engine");
      const history = Array.isArray(state?.adaptationHistory) ? state.adaptationHistory : [];
      if (history.length === 0) return null;
      try {
        const style = PersonalityManager.loadSettings().responseStyle;
        return style ? { style, reason: history[history.length - 1]?.reason } : null;
      } catch {
        return null;
      }
    },
    userName: () => {
      try {
        return PersonalityManager.getUserName();
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Run the lane migration once. Returns `ran: false` when the marker already exists.
 * `pause` yields between lanes so a large profile does not hold the event loop.
 */
export async function runMemoryItemsLaneMigration(
  writer: MemoryWriter,
  sources: LegacyLaneSources,
  options: { pause?: () => Promise<void> } = {},
): Promise<LaneMigrationResult> {
  const lanes = emptyLanes();
  const repository = writer.repository;
  if (await repository.isLaneMigrationComplete()) return { ran: false, lanes };
  const pause = options.pause ?? (async () => undefined);

  const ingest = async (lane: LaneName, candidate: MemoryCandidate | null): Promise<void> => {
    lanes[lane].read += 1;
    if (!candidate) {
      lanes[lane].skipped += 1;
      return;
    }
    let result: MemoryWriteResult;
    try {
      result = await writer.ingest({ ...candidate, mode: "migration" });
    } catch (error) {
      lanes[lane].failed += 1;
      logger.warn(`Memory item migration of a ${lane} record failed:`, error);
      return;
    }
    if (result.status === "written") lanes[lane].written += 1;
    else lanes[lane].skipped += 1;
  };
  const readLane = <T>(lane: LaneName, read: () => T[]): T[] => {
    try {
      return read();
    } catch (error) {
      // A lane that cannot be read (for example an undecryptable settings blob) is
      // reported; the run is not marked complete, so it is retried on the next start.
      lanes[lane].failed += 1;
      logger.warn(`Memory item migration could not read the ${lane} lane:`, error);
      return [];
    }
  };

  const curated = await repository.listCuratedForMigration();
  for (const row of curated) {
    await ingest(
      "curated",
      curatedEntryCandidate(
        {
          id: row.id,
          workspaceId: row.workspaceId,
          taskId: row.taskId,
          target: row.target as CuratedMemoryEntry["target"],
          kind: row.kind as CuratedMemoryEntry["kind"],
          content: row.content,
          source: row.source as CuratedMemoryEntry["source"],
          confidence: row.confidence,
          createdAt: row.createdAt,
        },
        "migration",
      ),
    );
  }
  await pause();

  const facts = readLane("userProfile", sources.userProfileFacts)
    .slice()
    .sort((a, b) => a.lastUpdatedAt - b.lastUpdatedAt);
  for (const fact of facts) {
    await ingest("userProfile", userFactCandidate(fact, { mode: "migration" }));
  }
  await pause();

  const relationship = readLane("relationship", sources.relationshipItems)
    .slice()
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const item of relationship) {
    await ingest("relationship", relationshipItemCandidate(item, "migration"));
  }
  await pause();

  // Oldest first: contradictions on a single-valued subject resolve to the newest belief.
  const beliefs = readLane("awareness", sources.awarenessBeliefs)
    .slice()
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const belief of beliefs) {
    await ingest("awareness", beliefCandidate(belief, "migration"));
  }
  await pause();

  const adaptive = readLane("adaptiveStyle", () => {
    const value = sources.adaptiveResponseStyle();
    return value ? [value] : [];
  });
  for (const value of adaptive) {
    await ingest(
      "adaptiveStyle",
      responseStyleCandidate(value.style, {
        source: "inferred",
        store: MEMORY_LANE_STORES.adaptiveStyle,
        reason: value.reason,
        mode: "migration",
      }),
    );
  }

  const names = readLane("userName", () => {
    const name = sources.userName();
    return name ? [name] : [];
  });
  for (const name of names) {
    // The stored name was either typed by the user or confirmed by them in settings.
    await ingest("userName", preferredNameCandidate(name, { source: "user_confirmed" }));
  }

  const failed = Object.values(lanes).reduce((total, lane) => total + lane.failed, 0);
  if (failed > 0) {
    logger.warn("Memory item lane migration incomplete; it will be retried", lanes);
    return { ran: true, lanes };
  }
  const summary: Record<string, number> = {};
  for (const [lane, counts] of Object.entries(lanes)) {
    summary[`${lane}Written`] = counts.written;
    summary[`${lane}Skipped`] = counts.skipped;
  }
  await repository.recordLaneMigration(summary);
  return { ran: true, lanes };
}
