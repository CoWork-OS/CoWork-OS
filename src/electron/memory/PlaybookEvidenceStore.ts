import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import {
  PlaybookEntrySqlStore,
  ensurePlaybookEntriesSchema,
  hashPlaybookContent,
  type PlaybookEntry,
  type PlaybookEntryInput,
} from "./playbook-entries-sql";

/**
 * One successful execution (a task) that a Playbook entry records. The ledger keeps
 * identities and the approach key only; readable text always comes from the source
 * entry (`playbook_entries`), so its privacy flag and deletion apply to it.
 */
export interface PlaybookEvidenceRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  /**
   * The `playbook_entries` row this execution is recorded in. Stored in the
   * `source_memory_id` column: entries migrated out of the archive keep their memory id.
   */
  sourceEntryId: string;
  /** Hash of the source entry content when recorded; a mismatch means it was edited. */
  sourceContentHash: string;
  /** Approach identity (normalized tools and destinations). Empty means unknown. */
  patternKey: string;
  createdAt: number;
  invalidatedAt: number | null;
}

export type PlaybookEvidenceInput = Pick<
  PlaybookEvidenceRecord,
  "workspaceId" | "taskId" | "sourceEntryId" | "sourceContentHash" | "patternKey"
>;

/** Result of recording one outcome: the entry and, for a success, its evidence row. */
export type PlaybookOutcomeRecordResult =
  | { status: "recorded"; entryId: string; evidenceId?: string }
  | { status: "duplicate_execution" };

/** A task the user corrected, and when (for the correction-rate metric). */
export interface PlaybookCorrection {
  taskId: string;
  at: number;
}

interface EvidenceRow {
  id: string;
  workspace_id: string;
  task_id: string;
  source_memory_id: string;
  source_content_hash: string;
  pattern_key: string;
  created_at: number;
  invalidated_at: number | null;
}

function toRecord(row: EvidenceRow): PlaybookEvidenceRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    sourceEntryId: row.source_memory_id,
    sourceContentHash: row.source_content_hash,
    patternKey: row.pattern_key,
    createdAt: row.created_at,
    invalidatedAt: row.invalidated_at,
  };
}

/** Hash of a Playbook entry's content, as evidence records it. */
export const hashMemoryContent = hashPlaybookContent;

/**
 * Narrow learning index for Playbook successes. Outcome text lives in `playbook_entries`
 * (playbook-entries-sql.ts); this ledger only records which tasks succeeded, and which
 * later successes reinforced which earlier ones.
 *
 * This is the synchronous store the memory domain's transaction units run (async SQLite
 * migration plan, DB6), on the host connection or in the database worker; services use
 * the async `PlaybookEvidenceLedger`.
 */
export class PlaybookEvidenceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
    /** Units run on a profile whose ledger schema the host already created. */
    ensureSchema = true,
  ) {
    if (ensureSchema) PlaybookEvidenceStore.ensureSchema(db);
  }

  static ensureSchema(db: Database.Database): void {
    ensurePlaybookEntriesSchema(db);
    db.exec(`
      -- The first ledger shape copied memory text and never shipped in a release; drop
      -- it so no copy outlives its memory's privacy state.
      DROP TABLE IF EXISTS playbook_evidence_links;
      DROP TABLE IF EXISTS playbook_evidence;
      CREATE TABLE IF NOT EXISTS playbook_success_evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        source_memory_id TEXT NOT NULL,
        source_content_hash TEXT NOT NULL,
        pattern_key TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        invalidated_at INTEGER,
        invalidation_reason TEXT,
        UNIQUE (workspace_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_playbook_success_evidence_active
        ON playbook_success_evidence (workspace_id, invalidated_at);
      CREATE TABLE IF NOT EXISTS playbook_success_links (
        evidence_id TEXT NOT NULL,
        reinforces_evidence_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (evidence_id, reinforces_evidence_id),
        CHECK (evidence_id <> reinforces_evidence_id)
      );
    `);
  }

  find(workspaceId: string, taskId: string): PlaybookEvidenceRecord | null {
    const row = this.db
      .prepare("SELECT * FROM playbook_success_evidence WHERE workspace_id = ? AND task_id = ?")
      .get(workspaceId, taskId) as EvidenceRow | undefined;
    return row ? toRecord(row) : null;
  }

  get(id: string): PlaybookEvidenceRecord | null {
    const row = this.db.prepare("SELECT * FROM playbook_success_evidence WHERE id = ?").get(id) as
      | EvidenceRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  /** Insert once per (workspace, task); a repeat returns the existing row. */
  record(input: PlaybookEvidenceInput): { created: boolean; record: PlaybookEvidenceRecord } {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO playbook_success_evidence (
          id, workspace_id, task_id, source_memory_id, source_content_hash, pattern_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.workspaceId,
        input.taskId,
        input.sourceEntryId,
        input.sourceContentHash,
        input.patternKey,
        this.now(),
      );
    const record = this.find(input.workspaceId, input.taskId)!;
    return { created: result.changes > 0, record };
  }

  /** Active evidence for a workspace, newest first. */
  listActive(workspaceId: string, limit = 500): PlaybookEvidenceRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM playbook_success_evidence
           WHERE workspace_id = ? AND invalidated_at IS NULL
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(workspaceId, limit) as EvidenceRow[]
    ).map(toRecord);
  }

  /** Link a later execution to an earlier one it reinforces. Returns false if already linked. */
  link(evidenceId: string, reinforcesEvidenceId: string): boolean {
    if (evidenceId === reinforcesEvidenceId) return false;
    const linked =
      this.db
        .prepare(
          "INSERT OR IGNORE INTO playbook_success_links (evidence_id, reinforces_evidence_id, created_at) VALUES (?, ?, ?)",
        )
        .run(evidenceId, reinforcesEvidenceId, this.now()).changes > 0;
    if (linked) {
      const reinforced = this.get(reinforcesEvidenceId);
      if (reinforced) this.entries().incrementReinforcement(reinforced.sourceEntryId);
    }
    return linked;
  }

  /** Links whose both ends are still active, for one workspace. */
  listActiveLinks(workspaceId: string): Array<{ from: string; to: string }> {
    return this.db
      .prepare(
        `SELECT l.evidence_id AS "from", l.reinforces_evidence_id AS "to"
         FROM playbook_success_links l
         JOIN playbook_success_evidence a ON a.id = l.evidence_id
         JOIN playbook_success_evidence b ON b.id = l.reinforces_evidence_id
         WHERE a.workspace_id = ? AND b.workspace_id = ?
         AND a.invalidated_at IS NULL AND b.invalidated_at IS NULL`,
      )
      .all(workspaceId, workspaceId) as Array<{ from: string; to: string }>;
  }

  invalidate(id: string, reason: string): boolean {
    const changed =
      this.db
        .prepare(
          "UPDATE playbook_success_evidence SET invalidated_at = ?, invalidation_reason = ? WHERE id = ? AND invalidated_at IS NULL",
        )
        .run(this.now(), reason, id).changes > 0;
    if (changed) {
      const record = this.get(id);
      if (record) this.entries().setStatus(record.sourceEntryId, "invalidated");
    }
    return changed;
  }

  /** Invalidate a task's active evidence (e.g. after the user corrected it). */
  invalidateTask(workspaceId: string, taskId: string, reason: string): number {
    const active = this.db
      .prepare(
        `SELECT id FROM playbook_success_evidence
         WHERE workspace_id = ? AND task_id = ? AND invalidated_at IS NULL`,
      )
      .all(workspaceId, taskId) as Array<{ id: string }>;
    return active.filter(({ id }) => this.invalidate(id, reason)).length;
  }

  private entries(): PlaybookEntrySqlStore {
    return new PlaybookEntrySqlStore(this.db, this.now);
  }

  /**
   * Record one outcome in one transaction: its `playbook_entries` row and, for a success,
   * its evidence row. A success for a task that already has evidence is a duplicate
   * execution and writes nothing.
   */
  recordOutcome(input: PlaybookEntryInput): PlaybookOutcomeRecordResult {
    if (input.kind === "success") {
      if (!input.taskId) return { status: "duplicate_execution" };
      if (this.find(input.workspaceId, input.taskId)) return { status: "duplicate_execution" };
    }
    const { entry } = this.entries().insert(input);
    if (input.kind !== "success") return { status: "recorded", entryId: entry.id };
    const { created, record } = this.record({
      workspaceId: input.workspaceId,
      taskId: input.taskId!,
      sourceEntryId: entry.id,
      sourceContentHash: hashPlaybookContent(entry.content),
      patternKey: input.patternKey,
    });
    if (!created) return { status: "duplicate_execution" };
    return { status: "recorded", entryId: entry.id, evidenceId: record.id };
  }

  /**
   * Tasks the user corrected since `since`: Playbook failures classified as a user
   * correction and success evidence invalidated as `corrected_by_user`. One row per task,
   * at its earliest correction.
   */
  listCorrections(workspaceId: string, since: number): PlaybookCorrection[] {
    return this.db
      .prepare(
        `SELECT task_id AS taskId, MIN(at) AS at FROM (
           SELECT task_id, created_at AS at FROM playbook_entries
           WHERE workspace_id = ? AND kind = 'failure' AND error_category = 'user_correction'
             AND task_id IS NOT NULL AND created_at >= ?
           UNION ALL
           SELECT task_id, invalidated_at AS at FROM playbook_success_evidence
           WHERE workspace_id = ? AND invalidation_reason = 'corrected_by_user'
             AND invalidated_at >= ?
         ) GROUP BY task_id`,
      )
      .all(workspaceId, since, workspaceId, since) as PlaybookCorrection[];
  }

  /**
   * Active evidence with its source entry, newest first, skipping evidence `readSource`
   * rejects (and invalidating what it invalidates). One transaction.
   */
  listReadable(
    workspaceId: string,
  ): Array<{ record: PlaybookEvidenceRecord; entry: PlaybookEntry }> {
    const readable: Array<{ record: PlaybookEvidenceRecord; entry: PlaybookEntry }> = [];
    for (const record of this.listActive(workspaceId)) {
      const entry = this.readSource(record);
      if (entry !== null) readable.push({ record, entry });
    }
    return readable;
  }

  /** Link `evidenceId` to each earlier execution; returns the ids newly linked, in order. */
  linkAll(evidenceId: string, reinforcesEvidenceIds: string[]): string[] {
    return reinforcesEvidenceIds.filter((id) => this.link(evidenceId, id));
  }

  /**
   * The source entry while it still exists unchanged and is not private. Evidence whose
   * entry was deleted (purge, retention) or edited is invalidated so old content cannot
   * stay authoritative through the ledger; a private entry is only skipped.
   */
  readSource(record: PlaybookEvidenceRecord): PlaybookEntry | null {
    if (record.invalidatedAt) return null;
    const entry = this.entries().get(record.sourceEntryId);
    if (!entry) {
      this.invalidate(record.id, "source_entry_deleted");
      return null;
    }
    if (hashPlaybookContent(entry.content) !== record.sourceContentHash) {
      this.invalidate(record.id, "source_entry_edited");
      return null;
    }
    return entry.isPrivate ? null : entry;
  }
}
