import type Database from "better-sqlite3";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";
import type { SupermemoryRemoteRef, SupermemoryRemoteRefInput } from "./supermemory-remote-refs-sql";

function isStatementPort(
  source: Database.Database | MemoryStatementPort,
): source is MemoryStatementPort {
  return typeof (source as Partial<MemoryStatementPort>).unit === "function";
}

/**
 * Remote ids of Supermemory copies (SEC-17, supermemory-remote-refs-sql.ts), over the
 * memory statement port. One process-wide instance, set when MemoryService initializes;
 * without it (CLI, tests) remote ids are not kept and nothing is forgotten remotely.
 */
export class SupermemoryRemoteRefRepository {
  private static instance: SupermemoryRemoteRefRepository | null = null;
  private readonly sql: MemoryStatementPort;

  constructor(source: Database.Database | MemoryStatementPort) {
    this.sql = isStatementPort(source) ? source : createMemoryStatementPort(source);
  }

  static initialize(source: Database.Database | MemoryStatementPort): SupermemoryRemoteRefRepository {
    this.instance = new SupermemoryRemoteRefRepository(source);
    return this.instance;
  }

  static get(): SupermemoryRemoteRefRepository | null {
    return this.instance;
  }

  static setInstance(instance: SupermemoryRemoteRefRepository | null): void {
    this.instance = instance;
  }

  record(input: SupermemoryRemoteRefInput): Promise<boolean> {
    return this.sql.unit("supermemoryRefs_record", [input]);
  }

  listOrphans(limit = 200): Promise<SupermemoryRemoteRef[]> {
    return this.sql.unit("supermemoryRefs_listOrphans", [limit]);
  }

  list(filter: { workspaceId?: string | null; limit?: number } = {}): Promise<SupermemoryRemoteRef[]> {
    return this.sql.unit("supermemoryRefs_list", [
      { workspaceId: filter.workspaceId ?? null, limit: filter.limit ?? 500 },
    ]);
  }

  findByRemoteIds(remoteIds: string[]): Promise<SupermemoryRemoteRef[]> {
    return this.sql.unit("supermemoryRefs_findByRemoteIds", [remoteIds]);
  }

  count(): Promise<number> {
    return this.sql.unit("supermemoryRefs_count", []);
  }

  deleteByIds(ids: number[]): Promise<number> {
    return this.sql.unit("supermemoryRefs_deleteByIds", [ids]);
  }
}
