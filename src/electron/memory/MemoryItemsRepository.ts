import type Database from "better-sqlite3";
import type { MemoryItemContextSearchRequest } from "./memory-context-sql";
import type { CuratedEntryMigrationRow } from "./memory-items-sql";
import type {
  ListMemoryItemsRequest,
  MemoryItem,
  MemoryItemIngestOutcome,
  MemoryItemStatus,
  MemoryItemsPage,
  MemoryItemsPageRequest,
  PreparedMemoryItemWrite,
} from "./memory-items-types";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";

function isStatementPort(
  source: Database.Database | MemoryStatementPort,
): source is MemoryStatementPort {
  return typeof (source as Partial<MemoryStatementPort>).unit === "function";
}

/**
 * Memory items (docs/memory-engine.md). Each operation is one memory-domain transaction
 * unit over `MemoryItemsStore`: in the database worker when memory is routed there, one
 * host transaction otherwise. Writes are meant to come from `MemoryWriter`, which runs
 * the salience, redaction and policy steps first.
 */
export class MemoryItemsRepository {
  private readonly sql: MemoryStatementPort;

  /** Over the profile connection, or over an existing memory statement port. */
  constructor(source: Database.Database | MemoryStatementPort) {
    this.sql = isStatementPort(source) ? source : createMemoryStatementPort(source);
  }

  ingest(write: PreparedMemoryItemWrite): Promise<MemoryItemIngestOutcome> {
    return this.sql.unit("memoryItems_ingest", [write]);
  }

  findById(id: string): Promise<MemoryItem | undefined> {
    return this.sql.unit("memoryItems_findById", [id]);
  }

  findBySourceRef(
    store: string,
    sourceId: string,
    statuses?: MemoryItemStatus[],
  ): Promise<MemoryItem[]> {
    return this.sql.unit("memoryItems_findBySourceRef", [store, sourceId, statuses]);
  }

  list(request: ListMemoryItemsRequest = {}): Promise<MemoryItem[]> {
    return this.sql.unit("memoryItems_list", [request]);
  }

  listForView(workspaceId: string, view: "user" | "workspace", limit = 200): Promise<MemoryItem[]> {
    return this.sql.unit("memoryItems_listForView", [workspaceId, view, limit]);
  }

  /** Close items by id or by legacy source ref; returns the ids that changed. */
  setStatus(
    target: { id: string } | { store: string; sourceId: string },
    status: Exclude<MemoryItemStatus, "active">,
    now = Date.now(),
  ): Promise<string[]> {
    return this.sql.unit("memoryItems_setStatus", [target, status, now]);
  }

  markUsed(ids: string[], now = Date.now()): Promise<number> {
    return this.sql.unit("memoryItems_markUsed", [ids, now]);
  }

  /** L1 recall for MemoryContextBuilder: active, user-owned items matching `query`. */
  searchForContext(request: MemoryItemContextSearchRequest): Promise<MemoryItem[]> {
    return this.sql.unit("memoryItems_contextSearch", [request]);
  }

  listCuratedForMigration(): Promise<CuratedEntryMigrationRow[]> {
    return this.sql.unit("memoryItems_listCuratedForMigration", []);
  }

  isLaneMigrationComplete(): Promise<boolean> {
    return this.sql.unit("memoryItems_laneMigrationComplete", []);
  }

  recordLaneMigration(summary: Record<string, number>, now = Date.now()): Promise<void> {
    return this.sql.unit("memoryItems_recordLaneMigration", [summary, now]);
  }

  // ---- Memory Hub ----

  listPage(request: MemoryItemsPageRequest): Promise<MemoryItemsPage> {
    return this.sql.unit("memoryItems_listPage", [request]);
  }

  revisions(
    id: string,
    max = 20,
  ): Promise<{ previous: MemoryItem[]; supersededBy: MemoryItem | null }> {
    return this.sql.unit("memoryItems_revisions", [id, max]);
  }

  setPinned(id: string, pinned: boolean, now = Date.now()): Promise<boolean> {
    return this.sql.unit("memoryItems_setPinned", [id, pinned, now]);
  }

  purgeGlobal(): Promise<number> {
    return this.sql.unit("memoryItems_purgeGlobal", []);
  }

  /** Delete the workspace's leftover kit render-state keys (retired generated kit blocks). */
  clearKitRenderState(workspaceId: string): Promise<number> {
    return this.sql.unit("memoryItems_clearKitRenderState", [workspaceId]);
  }
}
