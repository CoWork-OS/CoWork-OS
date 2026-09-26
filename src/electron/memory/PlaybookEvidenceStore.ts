import { createHash, randomUUID } from "crypto";
import type Database from "better-sqlite3";

/**
 * How strongly an outcome is known.
 * - observed_runtime_success: the run reached terminal `ok`; nothing more is claimed.
 * - contract_verified: terminal `ok` and the completion verifier passed.
 * - user_confirmed: the user explicitly accepted the result.
 * - failure / corrected: kept for recovery lessons; never proof of success.
 */
export type PlaybookOutcomeGrade =
  | "observed_runtime_success"
  | "contract_verified"
  | "user_confirmed"
  | "failure"
  | "corrected";

export const PLAYBOOK_SUCCESS_GRADES: readonly PlaybookOutcomeGrade[] = [
  "observed_runtime_success",
  "contract_verified",
  "user_confirmed",
];

export interface PlaybookEvidenceRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  /** Independent execution identity; the same logical execution always maps to the same key. */
  executionKey: string;
  turnId: string | null;
  terminalEventId: string | null;
  sourceMemoryId: string | null;
  /** Hash of the source memory content when recorded; a mismatch means it was edited. */
  sourceContentHash: string | null;
  outcome: "success" | "failure";
  grade: PlaybookOutcomeGrade;
  /** Approach identity (normalized tools and destinations). Empty means unknown. */
  patternKey: string;
  title: string;
  approach: string;
  requestExcerpt: string;
  toolsUsed: string[];
  sourceRefs: string[];
  createdAt: number;
  invalidatedAt: number | null;
  invalidationReason: string | null;
}

export type PlaybookEvidenceInput = Omit<
  PlaybookEvidenceRecord,
  "id" | "createdAt" | "invalidatedAt" | "invalidationReason"
>;

interface EvidenceRow {
  id: string;
  workspace_id: string;
  task_id: string;
  execution_key: string;
  turn_id: string | null;
  terminal_event_id: string | null;
  source_memory_id: string | null;
  source_content_hash: string | null;
  outcome: "success" | "failure";
  grade: PlaybookOutcomeGrade;
  pattern_key: string;
  title: string;
  approach: string;
  request_excerpt: string;
  tools_json: string;
  source_refs_json: string;
  created_at: number;
  invalidated_at: number | null;
  invalidation_reason: string | null;
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toRecord(row: EvidenceRow): PlaybookEvidenceRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    executionKey: row.execution_key,
    turnId: row.turn_id,
    terminalEventId: row.terminal_event_id,
    sourceMemoryId: row.source_memory_id,
    sourceContentHash: row.source_content_hash,
    outcome: row.outcome,
    grade: row.grade,
    patternKey: row.pattern_key,
    title: row.title,
    approach: row.approach,
    requestExcerpt: row.request_excerpt,
    toolsUsed: parseList(row.tools_json),
    sourceRefs: parseList(row.source_refs_json),
    createdAt: row.created_at,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
  };
}

export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Narrow learning index for Playbook outcomes. General memory storage stays in
 * MemoryService; this ledger only records which independent executions succeeded or
 * failed, and which later executions reinforced which earlier ones.
 */
export class PlaybookEvidenceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playbook_evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        execution_key TEXT NOT NULL,
        turn_id TEXT,
        terminal_event_id TEXT,
        source_memory_id TEXT,
        source_content_hash TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
        grade TEXT NOT NULL,
        pattern_key TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        approach TEXT NOT NULL DEFAULT '',
        request_excerpt TEXT NOT NULL DEFAULT '',
        tools_json TEXT NOT NULL DEFAULT '[]',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        invalidated_at INTEGER,
        invalidation_reason TEXT,
        UNIQUE (workspace_id, execution_key, outcome)
      );
      CREATE INDEX IF NOT EXISTS idx_playbook_evidence_workspace
        ON playbook_evidence (workspace_id, outcome, invalidated_at);
      CREATE INDEX IF NOT EXISTS idx_playbook_evidence_task
        ON playbook_evidence (workspace_id, task_id);
      CREATE TABLE IF NOT EXISTS playbook_evidence_links (
        evidence_id TEXT NOT NULL,
        reinforces_evidence_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (evidence_id, reinforces_evidence_id),
        CHECK (evidence_id <> reinforces_evidence_id)
      );
    `);
  }

  find(
    workspaceId: string,
    executionKey: string,
    outcome: "success" | "failure",
  ): PlaybookEvidenceRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM playbook_evidence WHERE workspace_id = ? AND execution_key = ? AND outcome = ?",
      )
      .get(workspaceId, executionKey, outcome) as EvidenceRow | undefined;
    return row ? toRecord(row) : null;
  }

  get(id: string): PlaybookEvidenceRecord | null {
    const row = this.db.prepare("SELECT * FROM playbook_evidence WHERE id = ?").get(id) as
      | EvidenceRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  /** Insert once per (workspace, execution, outcome); a repeat returns the existing row. */
  record(input: PlaybookEvidenceInput): { created: boolean; record: PlaybookEvidenceRecord } {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO playbook_evidence (
          id, workspace_id, task_id, execution_key, turn_id, terminal_event_id,
          source_memory_id, source_content_hash, outcome, grade, pattern_key, title,
          approach, request_excerpt, tools_json, source_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.taskId,
        input.executionKey,
        input.turnId,
        input.terminalEventId,
        input.sourceMemoryId,
        input.sourceContentHash,
        input.outcome,
        input.grade,
        input.patternKey,
        input.title,
        input.approach,
        input.requestExcerpt,
        JSON.stringify(input.toolsUsed),
        JSON.stringify(input.sourceRefs),
        this.now(),
      );
    const record = this.find(input.workspaceId, input.executionKey, input.outcome)!;
    return { created: result.changes > 0, record };
  }

  /** Active success rows for a workspace, newest first. */
  listActiveSuccesses(workspaceId: string, limit = 500): PlaybookEvidenceRecord[] {
    const placeholders = PLAYBOOK_SUCCESS_GRADES.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT * FROM playbook_evidence
           WHERE workspace_id = ? AND outcome = 'success' AND invalidated_at IS NULL
           AND grade IN (${placeholders})
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(workspaceId, ...PLAYBOOK_SUCCESS_GRADES, limit) as EvidenceRow[]
    ).map(toRecord);
  }

  listActiveFailures(workspaceId: string, limit = 200): PlaybookEvidenceRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM playbook_evidence
           WHERE workspace_id = ? AND outcome = 'failure' AND invalidated_at IS NULL
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
          "INSERT OR IGNORE INTO playbook_evidence_links (evidence_id, reinforces_evidence_id, created_at) VALUES (?, ?, ?)",
        )
        .run(evidenceId, reinforcesEvidenceId, this.now()).changes > 0
    );
  }

  /** Links whose both ends are still active, for one workspace. */
  listActiveLinks(workspaceId: string): Array<{ from: string; to: string }> {
    return this.db
      .prepare(
        `SELECT l.evidence_id AS "from", l.reinforces_evidence_id AS "to"
         FROM playbook_evidence_links l
         JOIN playbook_evidence a ON a.id = l.evidence_id
         JOIN playbook_evidence b ON b.id = l.reinforces_evidence_id
         WHERE a.workspace_id = ? AND b.workspace_id = ?
         AND a.invalidated_at IS NULL AND b.invalidated_at IS NULL`,
      )
      .all(workspaceId, workspaceId) as Array<{ from: string; to: string }>;
  }

  /**
   * Remove the human-readable text of a row whose source memory is gone or changed, so
   * deleted, cleared or redacted memory content does not survive in the ledger. The row
   * itself stays so the execution is still not counted twice.
   */
  scrub(id: string): void {
    this.db
      .prepare(
        `UPDATE playbook_evidence SET title = '', approach = '', request_excerpt = '',
         tools_json = '[]', source_refs_json = '[]' WHERE id = ?`,
      )
      .run(id);
  }

  /** Verify every row that still carries text for a workspace; scrub the unbacked ones. */
  sweepWorkspace(workspaceId: string): number {
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM playbook_evidence WHERE workspace_id = ?
           AND (title <> '' OR approach <> '' OR request_excerpt <> '')`,
        )
        .all(workspaceId) as EvidenceRow[]
    ).map(toRecord);
    let scrubbed = 0;
    for (const record of rows) {
      if (record.invalidatedAt ? this.sourceMissingOrChanged(record) : !this.verifySource(record)) {
        this.scrub(record.id);
        scrubbed++;
      }
    }
    return scrubbed;
  }

  private sourceMissingOrChanged(record: PlaybookEvidenceRecord): boolean {
    if (!record.sourceMemoryId || !record.sourceContentHash) return true;
    try {
      const row = this.db
        .prepare("SELECT content FROM memories WHERE id = ?")
        .get(record.sourceMemoryId) as { content: string } | undefined;
      return !row || hashMemoryContent(row.content) !== record.sourceContentHash;
    } catch {
      return false;
    }
  }

  invalidate(id: string, reason: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE playbook_evidence SET invalidated_at = ?, invalidation_reason = ? WHERE id = ? AND invalidated_at IS NULL",
        )
        .run(this.now(), reason, id).changes > 0
    );
  }

  /** Invalidate a task's active success evidence (e.g. after the user corrected it). */
  invalidateTaskSuccesses(workspaceId: string, taskId: string, reason: string): number {
    return this.db
      .prepare(
        `UPDATE playbook_evidence SET invalidated_at = ?, invalidation_reason = ?
         WHERE workspace_id = ? AND task_id = ? AND outcome = 'success' AND invalidated_at IS NULL`,
      )
      .run(this.now(), reason, workspaceId, taskId).changes;
  }

  /**
   * Whether the source memory still exists unchanged. Evidence whose memory was deleted
   * or edited is invalidated so old content cannot stay authoritative through the ledger.
   */
  verifySource(record: PlaybookEvidenceRecord): boolean {
    if (record.invalidatedAt) return false;
    if (!record.sourceMemoryId || !record.sourceContentHash) {
      this.invalidate(record.id, "missing_source_memory");
      this.scrub(record.id);
      return false;
    }
    let row: { content: string } | undefined;
    try {
      row = this.db
        .prepare("SELECT content FROM memories WHERE id = ?")
        .get(record.sourceMemoryId) as { content: string } | undefined;
    } catch {
      // No memories table (tests or a stripped-down profile): cannot verify.
      return false;
    }
    if (!row) {
      this.invalidate(record.id, "source_memory_deleted");
      this.scrub(record.id);
      return false;
    }
    if (hashMemoryContent(row.content) !== record.sourceContentHash) {
      this.invalidate(record.id, "source_memory_edited");
      this.scrub(record.id);
      return false;
    }
    return true;
  }
}
