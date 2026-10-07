/**
 * Supermemory remote ids (audit SEC-17): which remote copy belongs to which local record,
 * so a delete, suppression or purge here can forget the copy there.
 *
 * One row per remote record:
 * - `local_ref` names the local record: `archive:<memories.id>` for a mirrored archive row,
 *   `memory:<memory_items.id>` for a mirrored fact, `external:<remote id>` for a write that
 *   exists only remotely (`memory_remember` with scope `external`).
 * - `remote_kind` is `document` (`/v3/documents`, the mirror path) or `memory`
 *   (`/v4/memories`, explicit remembers); each is deleted through its own endpoint.
 * - `container_tag` is the container the write went to, so the delete addresses the same one
 *   even after the container template changes.
 *
 * There is no foreign key to the local record: the row has to outlive it until the remote
 * delete succeeded. Rows are removed by `deleteByIds` after that.
 *
 * Plain synchronous SQL over a connection the caller owns; the units in
 * `supermemory-remote-refs-units.ts` run it in one transaction (host or database worker).
 */
import type Database from "better-sqlite3";

export const SUPERMEMORY_REMOTE_KINDS = ["document", "memory"] as const;
export type SupermemoryRemoteKind = (typeof SUPERMEMORY_REMOTE_KINDS)[number];

export interface SupermemoryRemoteRef {
  id: number;
  localRef: string;
  remoteId: string;
  remoteKind: SupermemoryRemoteKind;
  containerTag: string;
  workspaceId: string | null;
  taskId: string | null;
  createdAt: number;
}

export interface SupermemoryRemoteRefInput {
  localRef: string;
  remoteId: string;
  remoteKind: SupermemoryRemoteKind;
  containerTag: string;
  workspaceId?: string | null;
  taskId?: string | null;
  createdAt: number;
}

interface RemoteRefRow {
  id: number;
  local_ref: string;
  remote_id: string;
  remote_kind: string;
  container_tag: string;
  workspace_id: string | null;
  task_id: string | null;
  created_at: number;
}

export function ensureSupermemoryRemoteRefsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supermemory_remote_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_ref TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      remote_kind TEXT NOT NULL,
      container_tag TEXT NOT NULL,
      workspace_id TEXT,
      task_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (remote_kind, remote_id)
    );
    CREATE INDEX IF NOT EXISTS idx_supermemory_remote_refs_local
      ON supermemory_remote_refs (local_ref);
    CREATE INDEX IF NOT EXISTS idx_supermemory_remote_refs_workspace
      ON supermemory_remote_refs (workspace_id);
  `);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

function toRef(row: RemoteRefRow): SupermemoryRemoteRef {
  return {
    id: row.id,
    localRef: row.local_ref,
    remoteId: row.remote_id,
    remoteKind: row.remote_kind === "memory" ? "memory" : "document",
    containerTag: row.container_tag,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS =
  "r.id, r.local_ref, r.remote_id, r.remote_kind, r.container_tag, r.workspace_id, r.task_id, r.created_at";

export class SupermemoryRemoteRefStore {
  constructor(private readonly db: Database.Database) {}

  private available(): boolean {
    return tableExists(this.db, "supermemory_remote_refs");
  }

  /** Record a remote copy; a second record of the same remote id is ignored. */
  record(input: SupermemoryRemoteRefInput): boolean {
    if (!this.available()) return false;
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO supermemory_remote_refs
             (local_ref, remote_id, remote_kind, container_tag, workspace_id, task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.localRef,
          input.remoteId,
          input.remoteKind,
          input.containerTag,
          input.workspaceId ?? null,
          input.taskId ?? null,
          input.createdAt,
        ).changes > 0
    );
  }

  /**
   * Remote copies whose local record no longer warrants one: the archive row was deleted,
   * made private, or suppressed / redacted in the inspector; the memory item was deleted,
   * archived, made private, or is gone. Remote-only rows (`external:`) are never orphans.
   */
  listOrphans(limit: number): SupermemoryRemoteRef[] {
    if (!this.available()) return [];
    const conditions: string[] = [];
    if (tableExists(this.db, "memories")) {
      const suppressed = tableExists(this.db, "memory_observation_metadata")
        ? `OR EXISTS (
             SELECT 1 FROM memory_observation_metadata om
             WHERE om.memory_id = substr(r.local_ref, 9)
               AND om.privacy_state IN ('suppressed', 'redacted')
           )`
        : "";
      conditions.push(`(
        r.local_ref LIKE 'archive:%' AND (
          NOT EXISTS (
            SELECT 1 FROM memories m
            WHERE m.id = substr(r.local_ref, 9) AND COALESCE(m.is_private, 0) = 0
          )
          ${suppressed}
        )
      )`);
    } else {
      conditions.push("r.local_ref LIKE 'archive:%'");
    }
    if (tableExists(this.db, "memory_items")) {
      conditions.push(`(
        r.local_ref LIKE 'memory:%' AND NOT EXISTS (
          SELECT 1 FROM memory_items mi
          WHERE mi.id = substr(r.local_ref, 8)
            AND mi.status = 'active'
            AND mi.privacy = 'normal'
        )
      )`);
    } else {
      conditions.push("r.local_ref LIKE 'memory:%'");
    }
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM supermemory_remote_refs r
         WHERE ${conditions.join(" OR ")}
         ORDER BY r.id
         LIMIT ?`,
      )
      .all(limit) as RemoteRefRow[];
    return rows.map(toRef);
  }

  /** Every remote copy, or those of one workspace (`workspaceId`). */
  list(filter: { workspaceId?: string | null; limit: number }): SupermemoryRemoteRef[] {
    if (!this.available()) return [];
    const rows = (
      filter.workspaceId
        ? this.db
            .prepare(
              `SELECT ${SELECT_COLUMNS} FROM supermemory_remote_refs r
               WHERE r.workspace_id = ? ORDER BY r.id LIMIT ?`,
            )
            .all(filter.workspaceId, filter.limit)
        : this.db
            .prepare(
              `SELECT ${SELECT_COLUMNS} FROM supermemory_remote_refs r ORDER BY r.id LIMIT ?`,
            )
            .all(filter.limit)
    ) as RemoteRefRow[];
    return rows.map(toRef);
  }

  /** Remote copies of the given remote ids (the `memory_forget external:<id>` path). */
  findByRemoteIds(remoteIds: string[]): SupermemoryRemoteRef[] {
    if (!this.available() || remoteIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM supermemory_remote_refs r
         WHERE r.remote_id IN (${remoteIds.map(() => "?").join(", ")})`,
      )
      .all(...remoteIds) as RemoteRefRow[];
    return rows.map(toRef);
  }

  count(): number {
    if (!this.available()) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM supermemory_remote_refs").get() as {
      n: number;
    };
    return row.n;
  }

  deleteByIds(ids: number[]): number {
    if (!this.available() || ids.length === 0) return 0;
    return this.db
      .prepare(`DELETE FROM supermemory_remote_refs WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .run(...ids).changes;
  }
}
