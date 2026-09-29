import { createHash, randomUUID } from "crypto";
import type Database from "better-sqlite3";

/**
 * One successful execution (a task) that a Playbook memory records. The ledger keeps
 * identities and the approach key only; readable text always comes from the source
 * memory, so memory privacy, redaction and deletion apply to it.
 */
export interface PlaybookEvidenceRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  sourceMemoryId: string;
  /** Hash of the source memory content when recorded; a mismatch means it was edited. */
  sourceContentHash: string;
  /** Approach identity (normalized tools and destinations). Empty means unknown. */
  patternKey: string;
  createdAt: number;
  invalidatedAt: number | null;
}

export type PlaybookEvidenceInput = Pick<
  PlaybookEvidenceRecord,
  "workspaceId" | "taskId" | "sourceMemoryId" | "sourceContentHash" | "patternKey"
>;

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
    sourceMemoryId: row.source_memory_id,
    sourceContentHash: row.source_content_hash,
    patternKey: row.pattern_key,
    createdAt: row.created_at,
    invalidatedAt: row.invalidated_at,
  };
}

export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Narrow learning index for Playbook successes. General memory storage stays in
 * MemoryService; this ledger only records which tasks succeeded, and which later
 * successes reinforced which earlier ones.
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
        input.sourceMemoryId,
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
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO playbook_success_links (evidence_id, reinforces_evidence_id, created_at) VALUES (?, ?, ?)",
        )
        .run(evidenceId, reinforcesEvidenceId, this.now()).changes > 0
    );
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
    return (
      this.db
        .prepare(
          "UPDATE playbook_success_evidence SET invalidated_at = ?, invalidation_reason = ? WHERE id = ? AND invalidated_at IS NULL",
        )
        .run(this.now(), reason, id).changes > 0
    );
  }

  /** Invalidate a task's active evidence (e.g. after the user corrected it). */
  invalidateTask(workspaceId: string, taskId: string, reason: string): number {
    return this.db
      .prepare(
        `UPDATE playbook_success_evidence SET invalidated_at = ?, invalidation_reason = ?
         WHERE workspace_id = ? AND task_id = ? AND invalidated_at IS NULL`,
      )
      .run(this.now(), reason, workspaceId, taskId).changes;
  }

  /**
   * Active evidence with its source memory's content, newest first, skipping evidence
   * `readSource` rejects (and invalidating what it invalidates). One transaction.
   */
  listReadable(workspaceId: string): Array<{ record: PlaybookEvidenceRecord; content: string }> {
    const readable: Array<{ record: PlaybookEvidenceRecord; content: string }> = [];
    for (const record of this.listActive(workspaceId)) {
      const content = this.readSource(record);
      if (content !== null) readable.push({ record, content });
    }
    return readable;
  }

  /** Link `evidenceId` to each earlier execution; returns the ids newly linked, in order. */
  linkAll(evidenceId: string, reinforcesEvidenceIds: string[]): string[] {
    return reinforcesEvidenceIds.filter((id) => this.link(evidenceId, id));
  }

  /**
   * The source memory's content while it still exists unchanged and is not private.
   * Evidence whose memory was deleted or edited is invalidated so old content cannot stay
   * authoritative through the ledger; a private memory is only skipped.
   */
  readSource(record: PlaybookEvidenceRecord): string | null {
    if (record.invalidatedAt) return null;
    let row: { content: string; is_private: number } | undefined;
    try {
      row = this.db
        .prepare("SELECT content, is_private FROM memories WHERE id = ?")
        .get(record.sourceMemoryId) as { content: string; is_private: number } | undefined;
    } catch {
      // No memories table (a stripped-down profile): cannot verify.
      return null;
    }
    if (!row) {
      this.invalidate(record.id, "source_memory_deleted");
      return null;
    }
    if (hashMemoryContent(row.content) !== record.sourceContentHash) {
      this.invalidate(record.id, "source_memory_edited");
      return null;
    }
    return row.is_private ? null : row.content;
  }
}
