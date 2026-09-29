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
 * database worker when memory is routed there, one host transaction otherwise. Listing
 * with source verification (which invalidates unbacked rows) and linking a set of
 * executions are single operations.
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

  find(
    workspaceId: string,
    executionKey: string,
    outcome: "success" | "failure",
  ): Promise<PlaybookEvidenceRecord | null> {
    return this.sql.unit("playbook_find", [workspaceId, executionKey, outcome]);
  }

  get(id: string): Promise<PlaybookEvidenceRecord | null> {
    return this.sql.unit("playbook_get", [id]);
  }

  /** Insert once per (workspace, execution, outcome); a repeat returns the existing row. */
  record(
    input: PlaybookEvidenceInput,
  ): Promise<{ created: boolean; record: PlaybookEvidenceRecord }> {
    return this.sql.unit("playbook_record", [input, this.now()]);
  }

  verifiedSuccesses(
    workspaceId: string,
    excludeExecutionKey?: string,
  ): Promise<PlaybookEvidenceRecord[]> {
    return this.sql.unit("playbook_verifiedSuccesses", [
      workspaceId,
      excludeExecutionKey,
      this.now(),
    ]);
  }

  verifiedFailures(workspaceId: string): Promise<PlaybookEvidenceRecord[]> {
    return this.sql.unit("playbook_verifiedFailures", [workspaceId, this.now()]);
  }

  listActiveLinks(workspaceId: string): Promise<Array<{ from: string; to: string }>> {
    return this.sql.unit("playbook_listActiveLinks", [workspaceId]);
  }

  linkAll(evidenceId: string, reinforcesEvidenceIds: string[]): Promise<string[]> {
    return this.sql.unit("playbook_linkAll", [evidenceId, reinforcesEvidenceIds, this.now()]);
  }

  invalidateTaskSuccesses(workspaceId: string, taskId: string, reason: string): Promise<number> {
    return this.sql.unit("playbook_invalidateTaskSuccesses", [
      workspaceId,
      taskId,
      reason,
      this.now(),
    ]);
  }

  sweepWorkspace(workspaceId: string): Promise<number> {
    return this.sql.unit("playbook_sweepWorkspace", [workspaceId, this.now()]);
  }
}
