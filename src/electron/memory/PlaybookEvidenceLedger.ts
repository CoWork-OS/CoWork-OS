import type Database from "better-sqlite3";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";
import {
  PlaybookEvidenceStore,
  type PlaybookEvidenceInput,
  type PlaybookEvidenceRecord,
} from "./PlaybookEvidenceStore";

/**
 * The Playbook evidence ledger for services (async SQLite migration plan, DB6). Each
 * operation is one memory-domain transaction unit over `PlaybookEvidenceStore`: in the
 * database worker when memory is routed there, one host transaction otherwise. Reading
 * active evidence with its source text (which invalidates unbacked rows) and linking a
 * set of executions are single operations.
 */
export class PlaybookEvidenceLedger {
  constructor(
    private readonly sql: MemoryStatementPort,
    private readonly now: () => number = Date.now,
  ) {}

  /** Create the ledger schema on `db`, then use the ledger through the memory port. */
  static open(db: Database.Database, now: () => number = Date.now): PlaybookEvidenceLedger {
    PlaybookEvidenceStore.ensureSchema(db);
    return new PlaybookEvidenceLedger(createMemoryStatementPort(db), now);
  }

  find(workspaceId: string, taskId: string): Promise<PlaybookEvidenceRecord | null> {
    return this.sql.unit("playbook_find", [workspaceId, taskId]);
  }

  get(id: string): Promise<PlaybookEvidenceRecord | null> {
    return this.sql.unit("playbook_get", [id]);
  }

  /** Insert once per (workspace, task); a repeat returns the existing row. */
  record(
    input: PlaybookEvidenceInput,
  ): Promise<{ created: boolean; record: PlaybookEvidenceRecord }> {
    return this.sql.unit("playbook_record", [input, this.now()]);
  }

  /** Active evidence with its source memory's content, newest first. */
  listReadable(
    workspaceId: string,
  ): Promise<Array<{ record: PlaybookEvidenceRecord; content: string }>> {
    return this.sql.unit("playbook_listReadable", [workspaceId, this.now()]);
  }

  listActiveLinks(workspaceId: string): Promise<Array<{ from: string; to: string }>> {
    return this.sql.unit("playbook_listActiveLinks", [workspaceId]);
  }

  linkAll(evidenceId: string, reinforcesEvidenceIds: string[]): Promise<string[]> {
    return this.sql.unit("playbook_linkAll", [evidenceId, reinforcesEvidenceIds, this.now()]);
  }

  invalidateTask(workspaceId: string, taskId: string, reason: string): Promise<number> {
    return this.sql.unit("playbook_invalidateTask", [workspaceId, taskId, reason, this.now()]);
  }
}
