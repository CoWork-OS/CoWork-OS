import type Database from "better-sqlite3";
import type {
  ArchiveEvidenceRow,
  CurationApplyOutcome,
  CurationApplyRequest,
  CurationLogEntry,
  CurationUndoOutcome,
} from "./memory-curation-sql";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";

function isStatementPort(
  source: Database.Database | MemoryStatementPort,
): source is MemoryStatementPort {
  return typeof (source as Partial<MemoryStatementPort>).unit === "function";
}

/**
 * The memory curator's store (docs/memory-engine.md §9): each operation is one
 * memory-domain unit over `MemoryCurationStore`. Applies and undos are meant to come from
 * `MemoryWriter`, which serializes them with every other memory write.
 */
export class MemoryCurationRepository {
  private readonly sql: MemoryStatementPort;

  constructor(source: Database.Database | MemoryStatementPort) {
    this.sql = isStatementPort(source) ? source : createMemoryStatementPort(source);
  }

  apply(request: CurationApplyRequest): Promise<CurationApplyOutcome> {
    return this.sql.unit("memoryCuration_apply", [request]);
  }

  undo(logId: string, workspaceId: string, now = Date.now()): Promise<CurationUndoOutcome> {
    return this.sql.unit("memoryCuration_undo", [logId, workspaceId, now]);
  }

  findLog(id: string): Promise<CurationLogEntry | undefined> {
    return this.sql.unit("memoryCuration_findLog", [id]);
  }

  listLog(workspaceId: string, limit = 50): Promise<CurationLogEntry[]> {
    return this.sql.unit("memoryCuration_listLog", [workspaceId, limit]);
  }

  undoneFingerprints(workspaceId: string): Promise<string[]> {
    return this.sql.unit("memoryCuration_undoneFingerprints", [workspaceId]);
  }

  archiveEvidence(workspaceId: string, since: number, limit = 300): Promise<ArchiveEvidenceRow[]> {
    return this.sql.unit("memoryCuration_archiveEvidence", [workspaceId, since, limit]);
  }

  llmTokensSince(since: number): Promise<number> {
    return this.sql.unit("memoryCuration_llmTokensSince", [since]);
  }

  dueWorkspaces(workspaceIds: string[], activeSince: number, runSince: number): Promise<string[]> {
    return this.sql.unit("memoryCuration_dueWorkspaces", [workspaceIds, activeSince, runSince]);
  }

  pendingCount(workspaceId: string): Promise<number> {
    return this.sql.unit("memoryCuration_pendingCount", [workspaceId]);
  }
}
