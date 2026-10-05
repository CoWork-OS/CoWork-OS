/**
 * One-time retirement of the legacy memory data (docs/memory-engine.md §5, "Legacy
 * lanes"). Runs once per profile, deferred after startup and only after the lane
 * migration (`memory_items_lane_migration_v1`) has completed; otherwise it is skipped and
 * retried on the next start. Claimed like the other one-time jobs
 * (maintenance-claim-sql.ts), so the desktop app and the node daemon never run it together.
 *
 *  1. Safety export to `<userData>/backups/legacy-memory-<timestamp>.json.enc`, encrypted with
 *     the OS keychain (safeStorage), mode 0600. Without OS encryption it is written as
 *     `.json` without the settings blobs (they are encrypted at rest and must not be
 *     downgraded to plaintext); curated rows are kept, as the database holds them in
 *     plaintext too. Contents are never logged.
 *  2. Verification: every active curated entry, profile fact and relationship item
 *     (history items excepted) must have a `memory_items` row by source ref or alias.
 *     Missing ones are re-ingested through MemoryWriter in migration mode. A record the
 *     writer declines (salience, secret-only, outranked, ...) counts as accounted for only
 *     when the export holds it; anything else still missing aborts the run (nothing is
 *     deleted, the export is removed, and the run is retried on the next start).
 *  3. Deletion: the SecureSettings blobs `user-profile` and `relationship-memory` (only if
 *     unchanged since they were exported), then in one transaction the retired tables and
 *     the settled `pending_memory_writes` rows, together with the marker
 *     `legacy_memory_retirement_v1` (counts only).
 *
 * Kept on purpose: `adaptive-style-engine` (AdaptiveStyleEngine still keeps its debounce
 * and weekly drift bookkeeping there) and `awareness-state` (AwarenessService still owns its
 * beliefs and uses them beyond the profile bridge). No VACUUM: idle maintenance runs it.
 */
import { promises as fs } from "fs";
import path from "path";
import type { AwarenessBelief, CuratedMemoryEntry, UserFact } from "../../shared/types";
import {
  DELETE_SECURE_SETTINGS,
  SecureSettingsRepository,
} from "../database/SecureSettingsRepository";
import { getSafeStorage, type SafeStorageLike } from "../utils/safe-storage";
import { getUserDataDir } from "../utils/user-data-dir";
import { createLogger } from "../utils/logger";
import { withMaintenanceClaim } from "./maintenance-claim-sql";
import type { MemoryStatementPort } from "./memory-statement-port";
import type { MemoryCandidate, MemoryWriter } from "./MemoryWriter";
import {
  MEMORY_LANE_STORES,
  curatedEntryCandidate,
  relationshipItemCandidate,
  userFactCandidate,
  type LegacyRelationshipItem,
} from "./memory-items-lanes";
import {
  LEGACY_MEMORY_RETIREMENT_KEY,
  type CuratedExportRow,
  type LegacySourceRef,
} from "./legacy-memory-retirement-sql";

export { LEGACY_MEMORY_RETIREMENT_KEY } from "./legacy-memory-retirement-sql";

const logger = createLogger("LegacyMemoryRetirement");

/** SecureSettings categories the retirement reads; only the first two are deleted. */
export const RETIRED_SETTINGS_CATEGORIES = ["user-profile", "relationship-memory"] as const;
const EXPORTED_SETTINGS_CATEGORIES = [
  ...RETIRED_SETTINGS_CATEGORIES,
  "adaptive-style-engine",
  "awareness-state",
] as const;
export type LegacySettingsCategory = (typeof EXPORTED_SETTINGS_CATEGORIES)[number];

/** Marker of the subconscious migration that copies the improvement_* tables. */
export const SUBCONSCIOUS_MIGRATION_CATEGORY = "subconscious-migration-v1";

export interface LegacySettingsLoad {
  status: "success" | "not_found" | string;
  data?: unknown;
}

/** The SecureSettings operations the retirement needs (injected for tests). */
export interface LegacySettingsAccess {
  load(category: LegacySettingsCategory): LegacySettingsLoad;
  /**
   * Delete the category if its stored value still equals `expected` (compared as JSON).
   * Returns false, deleting nothing, when it changed.
   */
  deleteIfUnchanged(category: LegacySettingsCategory, expected: unknown): boolean;
  /** Whether the subconscious migration has copied the improvement tables. */
  subconsciousMigrationDone(): boolean;
}

export interface LegacyMemoryRetirementDeps {
  port: MemoryStatementPort;
  writer: MemoryWriter;
  /** Null when secure settings are not initialized (the run is then skipped). */
  settings: LegacySettingsAccess | null;
  /** OS keychain encryption for the export; null or unavailable writes it without blobs. */
  encryption: SafeStorageLike | null;
  /** `<userData>/backups`. */
  backupDir: string;
  now?: () => number;
  /** Yield between phases (to the event loop). */
  pause?: () => Promise<void>;
  /** Claim owner (tests); defaults to this process. */
  owner?: string;
}

export interface LegacyRetirementCounts {
  curatedRows: number;
  curatedChecked: number;
  profileFacts: number;
  relationshipItems: number;
  alreadyPresent: number;
  reingested: number;
  declined: number;
  excluded: number;
  missing: number;
}

export type LegacyMemoryRetirementResult =
  | { status: "done" }
  | { status: "not_ready" }
  | { status: "held" }
  | { status: "aborted"; reason: string; counts: LegacyRetirementCounts }
  | {
      status: "retired";
      counts: LegacyRetirementCounts;
      backup: BackupInfo;
      settingsDeleted: string[];
      droppedTables: string[];
      blockedTables: string[];
      pendingWritesDeleted: number;
    };

export interface BackupInfo {
  written: boolean;
  encrypted: boolean;
  blobsOmitted: boolean;
  file: string | null;
}

function emptyCounts(): LegacyRetirementCounts {
  return {
    curatedRows: 0,
    curatedChecked: 0,
    profileFacts: 0,
    relationshipItems: 0,
    alreadyPresent: 0,
    reingested: 0,
    declined: 0,
    excluded: 0,
    missing: 0,
  };
}

class RetirementAbort extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// ---- Legacy blob readers (the services that owned them no longer read them) ----

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Profile facts as UserProfileService normalized them on load. */
export function legacyProfileFacts(blob: unknown): UserFact[] {
  const facts = asRecord(blob)?.facts;
  if (!Array.isArray(facts)) return [];
  const out: UserFact[] = [];
  for (const entry of facts) {
    const fact = asRecord(entry);
    if (!fact || typeof fact.id !== "string" || typeof fact.value !== "string") continue;
    const value = fact.value.trim().replace(/\s+/g, " ");
    out.push({
      ...(fact as unknown as UserFact),
      category: (typeof fact.category === "string" && fact.category
        ? fact.category
        : "other") as UserFact["category"],
      value,
      confidence: Number.isFinite(Number(fact.confidence))
        ? Math.max(0, Math.min(1, Number(fact.confidence)))
        : 0.7,
      source:
        fact.source === "manual" || fact.source === "feedback" ? fact.source : "conversation",
      firstSeenAt: Number(fact.firstSeenAt) || 0,
      lastUpdatedAt: Number(fact.lastUpdatedAt) || 0,
    });
  }
  return out;
}

/**
 * Relationship items as RelationshipMemoryService normalized them on load. The source
 * normalization matters: legacy `task` items in the context and commitments layers were
 * mailbox text and must stay third-party.
 */
export function legacyRelationshipItems(blob: unknown): LegacyRelationshipItem[] {
  const items = asRecord(blob)?.items;
  if (!Array.isArray(items)) return [];
  const out: LegacyRelationshipItem[] = [];
  for (const entry of items) {
    const item = asRecord(entry);
    if (!item || typeof item.id !== "string" || typeof item.text !== "string") continue;
    const layer = item.layer as LegacyRelationshipItem["layer"];
    let source: LegacyRelationshipItem["source"] = "conversation";
    if (item.source === "mailbox" || item.source === "feedback") source = item.source;
    else if (item.source === "task") {
      source = layer === "context" || layer === "commitments" ? "mailbox" : "task";
    }
    const normalized: LegacyRelationshipItem = {
      id: item.id,
      layer,
      text: item.text.trim().replace(/\s+/g, " "),
      confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.65) || 0)),
      source,
      createdAt: Number(item.createdAt) || 0,
      updatedAt: Number(item.updatedAt) || 0,
    };
    if (typeof item.lastTaskId === "string") normalized.lastTaskId = item.lastTaskId;
    if (item.status === "open" || item.status === "done") normalized.status = item.status;
    if (typeof item.dueAt === "number" && Number.isFinite(item.dueAt)) {
      normalized.dueAt = Math.floor(item.dueAt);
    }
    if (typeof item.contactIdentityId === "string") {
      normalized.contactIdentityId = item.contactIdentityId;
    }
    if (typeof item.companyId === "string") normalized.companyId = item.companyId;
    out.push(normalized);
  }
  return out;
}

function legacyBeliefs(blob: unknown): AwarenessBelief[] {
  const beliefs = asRecord(blob)?.beliefs;
  return Array.isArray(beliefs) ? (beliefs as AwarenessBelief[]) : [];
}

function curatedCandidate(row: CuratedExportRow): MemoryCandidate {
  return curatedEntryCandidate(
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
  );
}

// ---- Export ----

function backupTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

export async function writeBackup(
  dir: string,
  now: number,
  payload: Record<string, unknown>,
  blobs: Record<string, unknown>,
  encryption: SafeStorageLike | null,
  prefix = "legacy-memory",
): Promise<BackupInfo & { path: string }> {
  let encrypt: SafeStorageLike | null = null;
  try {
    encrypt = encryption?.isEncryptionAvailable() ? encryption : null;
  } catch {
    encrypt = null;
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const base = path.join(dir, `${prefix}-${backupTimestamp(now)}`);
  const data = encrypt
    ? encrypt.encryptString(JSON.stringify({ ...payload, settings: blobs }))
    : JSON.stringify({ ...payload, settings: { omitted: "os_encryption_unavailable" } }, null, 2);
  const extension = encrypt ? ".json.enc" : ".json";
  // `wx`: never overwrite an earlier export (a suffix is added instead); the mode is set
  // again in case of a umask.
  let file = "";
  for (let attempt = 0; ; attempt += 1) {
    file = `${base}${attempt > 0 ? `-${attempt}` : ""}${extension}`;
    try {
      await fs.writeFile(file, data, { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || attempt >= 20) throw error;
    }
  }
  await fs.chmod(file, 0o600);
  return {
    written: true,
    encrypted: Boolean(encrypt),
    blobsOmitted: !encrypt,
    file: path.basename(file),
    path: file,
  };
}

// ---- Run ----

/**
 * Run the retirement once. Returns `done` when the marker exists, `not_ready` before the
 * lane migration has completed, and `held` when another process holds the claim.
 */
export async function runLegacyMemoryRetirement(
  deps: LegacyMemoryRetirementDeps,
): Promise<LegacyMemoryRetirementResult> {
  const status = await deps.port.unit("legacyRetirement_status", {});
  if (status.done) return { status: "done" };
  if (!status.laneMigrationDone) return { status: "not_ready" };
  const result = await withMaintenanceClaim(
    deps.port,
    LEGACY_MEMORY_RETIREMENT_KEY,
    () => retire(deps),
    { owner: deps.owner, now: deps.now },
  );
  return result ?? { status: "held" };
}

async function retire(deps: LegacyMemoryRetirementDeps): Promise<LegacyMemoryRetirementResult> {
  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? (async () => undefined);
  const counts = emptyCounts();
  let backupPath: string | null = null;
  try {
    const settings = deps.settings;
    if (!settings) throw new RetirementAbort("settings_unavailable");

    // Read every blob first: one that exists but cannot be read is never deleted.
    const blobs: Partial<Record<LegacySettingsCategory, unknown>> = {};
    for (const category of EXPORTED_SETTINGS_CATEGORIES) {
      const loaded = settings.load(category);
      if (loaded.status === "success") blobs[category] = loaded.data;
      else if (loaded.status !== "not_found") throw new RetirementAbort("settings_unreadable");
    }
    const includeImprovement = settings.subconsciousMigrationDone();
    const snapshot = await deps.port.unit("legacyRetirement_snapshot", { includeImprovement });
    const facts = legacyProfileFacts(blobs["user-profile"]);
    const relationship = legacyRelationshipItems(blobs["relationship-memory"]);
    counts.curatedRows = snapshot.curated.length;
    counts.profileFacts = facts.length;
    counts.relationshipItems = relationship.length;

    // 1. Safety export (skipped when there is nothing to keep).
    const hasLegacyData =
      snapshot.curated.length > 0 ||
      RETIRED_SETTINGS_CATEGORIES.some((category) => blobs[category] !== undefined);
    let backup: BackupInfo = { written: false, encrypted: false, blobsOmitted: false, file: null };
    if (hasLegacyData) {
      const exportBlobs: Record<string, unknown> = {
        userProfile: blobs["user-profile"] ?? null,
        relationshipMemory: blobs["relationship-memory"] ?? null,
        adaptiveStyle: blobs["adaptive-style-engine"] ?? null,
        awarenessBeliefs: legacyBeliefs(blobs["awareness-state"]),
      };
      try {
        const written = await writeBackup(
          deps.backupDir,
          now(),
          {
            version: 1,
            createdAt: now(),
            curatedMemoryEntries: snapshot.curated,
            pendingMemoryWrites: { settledRows: snapshot.settledPendingWrites },
            tableCounts: snapshot.tableCounts,
          },
          exportBlobs,
          deps.encryption,
        );
        backupPath = written.path;
        backup = {
          written: written.written,
          encrypted: written.encrypted,
          blobsOmitted: written.blobsOmitted,
          file: written.file,
        };
      } catch (error) {
        logger.warn(
          "Legacy memory export could not be written; nothing was deleted:",
          (error as NodeJS.ErrnoException)?.code ?? "error",
        );
        throw new RetirementAbort("export_failed");
      }
    }
    await pause();

    // 2. Verification, with re-ingest of what is missing.
    const curatedChecked = snapshot.curated.filter(
      (row) => row.status === "active" && row.workspacePresent,
    );
    counts.curatedChecked = curatedChecked.length;
    const checks: Array<{ ref: LegacySourceRef; candidate: MemoryCandidate | null; backedUp: boolean }> =
      [
        // The export always holds the curated rows.
        ...curatedChecked.map((row) => ({
          ref: { store: MEMORY_LANE_STORES.curated, id: row.id },
          candidate: curatedCandidate(row),
          backedUp: backup.written,
        })),
        ...facts.map((fact) => ({
          ref: { store: MEMORY_LANE_STORES.userProfile, id: fact.id },
          candidate: userFactCandidate(fact, { mode: "migration" }),
          backedUp: backup.encrypted,
        })),
        ...relationship.map((item) => ({
          ref: { store: MEMORY_LANE_STORES.relationship, id: item.id },
          candidate: relationshipItemCandidate(item, "migration"),
          backedUp: backup.encrypted,
        })),
      ];
    // Records the lane mapping leaves out (history items, rejected identity values) were
    // never meant to be migrated.
    const expected = checks.filter((check) => {
      if (check.candidate) return true;
      counts.excluded += 1;
      return false;
    });
    const missing = new Set(
      (
        await deps.port.unit("legacyRetirement_missingRefs", {
          refs: expected.map((check) => check.ref),
        })
      ).map((ref) => `${ref.store}:${ref.id}`),
    );
    counts.alreadyPresent = expected.length - missing.size;
    const written: LegacySourceRef[] = [];
    for (const check of expected) {
      if (!missing.has(`${check.ref.store}:${check.ref.id}`) || !check.candidate) continue;
      try {
        const outcome = await deps.writer.ingest({ ...check.candidate, mode: "migration" });
        if (outcome.status === "written" || outcome.reason === "already_migrated") {
          written.push(check.ref);
        } else if (check.backedUp) {
          counts.declined += 1;
        } else {
          counts.missing += 1;
        }
      } catch {
        counts.missing += 1;
      }
    }
    const stillMissing = await deps.port.unit("legacyRetirement_missingRefs", { refs: written });
    counts.reingested = written.length - stillMissing.length;
    counts.missing += stillMissing.length;
    if (counts.missing > 0) throw new RetirementAbort("missing_rows");
    await pause();

    // 3. Deletion: the settings blobs (only if unchanged), then the tables and the marker.
    const settingsDeleted: string[] = [];
    for (const category of RETIRED_SETTINGS_CATEGORIES) {
      if (blobs[category] === undefined) continue;
      let deleted: boolean;
      try {
        deleted = settings.deleteIfUnchanged(category, blobs[category]);
      } catch {
        // For example a refused write after an OS keychain change.
        deleted = false;
      }
      if (!deleted) throw new RetirementAbort("settings_changed");
      settingsDeleted.push(category);
    }
    const finish = await deps.port.unit("legacyRetirement_finish", {
      includeImprovement,
      curatedFingerprint: snapshot.curatedFingerprint,
      summary: {
        counts,
        settingsDeleted,
        settingsKept: ["adaptive-style-engine", "awareness-state"],
        improvementTablesIncluded: includeImprovement,
        backup,
      },
      now: Math.floor(now()),
    });
    if (finish.status === "done") return { status: "done" };
    if (finish.status === "changed") {
      // Settings may already be gone; the export of this run keeps them.
      backupPath = null;
      throw new RetirementAbort("curated_changed");
    }
    logger.info("Legacy memory data retired", {
      ...counts,
      settingsDeleted: settingsDeleted.length,
      droppedTables: finish.droppedTables.length,
      blockedTables: finish.blockedTables.length,
      pendingWritesDeleted: finish.pendingWritesDeleted,
      backupEncrypted: backup.encrypted,
      backupWritten: backup.written,
    });
    return {
      status: "retired",
      counts,
      backup,
      settingsDeleted,
      droppedTables: finish.droppedTables,
      blockedTables: finish.blockedTables,
      pendingWritesDeleted: finish.pendingWritesDeleted,
    };
  } catch (error) {
    if (!(error instanceof RetirementAbort)) throw error;
    // Nothing was deleted (or, for curated_changed, the export is kept): an export of an
    // aborted run is removed so retries do not pile them up.
    if (backupPath && error.reason !== "settings_changed") {
      await fs.rm(backupPath, { force: true }).catch(() => undefined);
    }
    logger.warn(`Legacy memory retirement skipped (${error.reason}); it will be retried`, counts);
    return { status: "aborted", reason: error.reason, counts };
  }
}

/** Production settings access over SecureSettingsRepository. */
export function loadLegacySettingsAccess(): LegacySettingsAccess | null {
  if (!SecureSettingsRepository.isInitialized()) return null;
  const repo = SecureSettingsRepository.getInstance();
  return {
    load: (category) => repo.loadWithStatus(category, { logErrors: false }),
    deleteIfUnchanged: (category, expected) => {
      const expectedJson = JSON.stringify(expected);
      const result = repo.update<object>(category, (current) =>
        current === undefined || JSON.stringify(current) === expectedJson
          ? DELETE_SECURE_SETTINGS
          : undefined,
      );
      return result.value === undefined;
    },
    subconsciousMigrationDone: () => repo.exists(SUBCONSCIOUS_MIGRATION_CATEGORY),
  };
}

/** Delay of the retirement after startup, off the hot path. */
export const LEGACY_MEMORY_RETIREMENT_DELAY_MS = 120_000;

/**
 * Run the retirement `delayMs` after startup (after the lane migration, which startup
 * awaits). Never throws; a failed or skipped run is retried on the next start. Returns a
 * function that cancels the scheduled run (call it on quit).
 */
export function scheduleLegacyMemoryRetirement(
  writer: MemoryWriter,
  port: MemoryStatementPort,
  delayMs = LEGACY_MEMORY_RETIREMENT_DELAY_MS,
): () => void {
  const timer = setTimeout(() => {
    void runLegacyMemoryRetirement({
      port,
      writer,
      settings: loadLegacySettingsAccess(),
      encryption: getSafeStorage(),
      backupDir: path.join(getUserDataDir(), "backups"),
      pause: () => new Promise((resolve) => setImmediate(resolve)),
    }).catch((error: unknown) => {
      logger.warn(
        "Legacy memory retirement failed; it will be retried on the next start:",
        error instanceof Error ? error.message : "error",
      );
    });
  }, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
