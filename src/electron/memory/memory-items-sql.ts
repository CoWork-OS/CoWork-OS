import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import {
  type KitRenderState,
  type ListMemoryItemsRequest,
  type MemoryItem,
  type MemoryItemIngestOutcome,
  type MemoryItemKind,
  type MemoryItemPrivacy,
  type MemoryItemScope,
  type MemoryItemSource,
  type MemoryItemStatus,
  type MemoryItemsPage,
  type MemoryItemsPageRequest,
  type MemoryScopeKey,
  type MemorySourceRef,
  type PreparedMemoryItemWrite,
  isDerivedSubjectKey,
} from "./memory-items-types";

/**
 * Memory items as synchronous SQL: the store the memory domain's transaction units run
 * (memory-items-units.ts), on the host connection or in the database worker. Services use
 * the async `MemoryItemsRepository`; writes go through `MemoryWriter`.
 *
 * Design: docs/memory-engine.md.
 */

export const MEMORY_ITEMS_LANE_MIGRATION_KEY = "memory_items_lane_migration_v1";

/** `maintenance_state` key prefix of the last rendered kit auto-block per workspace file. */
export const KIT_RENDER_STATE_PREFIX = "kit_render_state:";

/**
 * `memory_items` and its FTS index. Additive (new tables only), idempotent, run by the
 * schema initialization. Vocabularies are validated by the units rather than CHECK
 * constraints, so later phases can add kinds without a table rebuild.
 */
export function ensureMemoryItemsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      scope_ref TEXT,
      kind TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL DEFAULT '{}',
      trust REAL NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.7,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      reinforced_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      supersedes_id TEXT,
      content_hash TEXT NOT NULL,
      privacy TEXT NOT NULL DEFAULT 'normal',
      task_id TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_active_hash
      ON memory_items(COALESCE(workspace_id, ''), scope, COALESCE(scope_ref, ''), kind, content_hash)
      WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_active_subject
      ON memory_items(COALESCE(workspace_id, ''), scope, COALESCE(scope_ref, ''), subject_key)
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_status
      ON memory_items(workspace_id, status, kind, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_scope
      ON memory_items(scope, scope_ref, status);
    CREATE INDEX IF NOT EXISTS idx_memory_items_task
      ON memory_items(task_id) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_items_expires
      ON memory_items(expires_at) WHERE expires_at IS NOT NULL;
  `);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
        content,
        subject_key,
        content='memory_items',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS memory_items_fts_insert AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_items_fts(rowid, content, subject_key)
        VALUES (NEW.rowid, NEW.content, NEW.subject_key);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_items_fts_delete AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, content, subject_key)
        VALUES ('delete', OLD.rowid, OLD.content, OLD.subject_key);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_items_fts_update
      AFTER UPDATE OF content, subject_key ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, content, subject_key)
        VALUES ('delete', OLD.rowid, OLD.content, OLD.subject_key);
        INSERT INTO memory_items_fts(rowid, content, subject_key)
        VALUES (NEW.rowid, NEW.content, NEW.subject_key);
      END;
    `);
  } catch {
    // FTS5 may be missing from a custom SQLite build; the table works without it and
    // recall falls back to LIKE (MemoryRecall, a later wave).
  }
}

interface MemoryItemRow {
  id: string;
  workspace_id: string | null;
  scope: string;
  scope_ref: string | null;
  kind: string;
  subject_key: string;
  content: string;
  source: string;
  source_ref: string | null;
  trust: number;
  confidence: number;
  status: string;
  pinned: number;
  reinforced_count: number;
  last_used_at: number | null;
  supersedes_id: string | null;
  content_hash: string;
  privacy: string;
  task_id: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function parseSourceRef(value: string | null): MemorySourceRef {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as MemorySourceRef)
      : {};
  } catch {
    return {};
  }
}

function toItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope as MemoryItemScope,
    scopeRef: row.scope_ref,
    kind: row.kind as MemoryItemKind,
    subjectKey: row.subject_key,
    content: row.content,
    source: row.source as MemoryItemSource,
    sourceRef: parseSourceRef(row.source_ref),
    trust: row.trust,
    confidence: row.confidence,
    status: row.status as MemoryItemStatus,
    pinned: row.pinned === 1,
    reinforcedCount: row.reinforced_count,
    lastUsedAt: row.last_used_at,
    supersedesId: row.supersedes_id,
    contentHash: row.content_hash,
    privacy: row.privacy as MemoryItemPrivacy,
    taskId: row.task_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQL matching rows in one (workspace, scope, scope_ref), shaped to use the partial indexes. */
const SCOPE_MATCH = "COALESCE(workspace_id, '') = ? AND scope = ? AND COALESCE(scope_ref, '') = ?";

function scopeParams(key: MemoryScopeKey): string[] {
  return [key.workspaceId ?? "", key.scope, key.scopeRef ?? ""];
}

const MAX_SOURCE_ALIASES = 20;

function refKey(ref: MemorySourceRef): string | null {
  return typeof ref.store === "string" && typeof ref.id === "string"
    ? `${ref.store}:${ref.id}`
    : null;
}

/**
 * The source ref of an item that absorbed another record's write (dedupe): the primary
 * ref is the higher-trust one, and every other record is kept in `aliases` (`store:id`), so
 * an edit, delete or repeated migration of that record still finds the item.
 */
function mergeSourceRefs(
  existing: MemorySourceRef,
  incoming: MemorySourceRef,
  incomingIsPrimary: boolean,
): MemorySourceRef {
  const primary = incomingIsPrimary ? { ...existing, ...incoming } : { ...existing };
  const aliases = new Set(
    Array.isArray(existing.aliases)
      ? existing.aliases.filter((value): value is string => typeof value === "string")
      : [],
  );
  for (const key of [refKey(existing), refKey(incoming)]) {
    if (key) aliases.add(key);
  }
  const primaryKey = refKey(primary);
  if (primaryKey) aliases.delete(primaryKey);
  const list = [...aliases].slice(-MAX_SOURCE_ALIASES);
  if (list.length > 0) primary.aliases = list;
  else delete primary.aliases;
  return primary;
}

/** Rows whose primary source ref, or one of its aliases, is `store:id`. */
const SOURCE_REF_MATCH = `((json_extract(source_ref, '$.store') = ? AND json_extract(source_ref, '$.id') = ?)
  OR EXISTS (SELECT 1 FROM json_each(memory_items.source_ref, '$.aliases') alias
             WHERE alias.value = ?))`;

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

export interface CuratedEntryMigrationRow {
  id: string;
  workspaceId: string;
  taskId: string | null;
  target: string;
  kind: string;
  content: string;
  source: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryItemsPurgeCounts {
  memoryItems: number;
}

export class MemoryItemsStore {
  constructor(private readonly db: Database.Database) {}

  findById(id: string): MemoryItem | undefined {
    const row = this.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as
      | MemoryItemRow
      | undefined;
    return row ? toItem(row) : undefined;
  }

  /** Rows that came from one legacy record (primary ref or alias), newest first. */
  findBySourceRef(store: string, id: string, statuses?: MemoryItemStatus[]): MemoryItem[] {
    const statusClause = statuses?.length
      ? ` AND status IN (${statuses.map(() => "?").join(", ")})`
      : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE ${SOURCE_REF_MATCH}
         ${statusClause}
         ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(store, id, `${store}:${id}`, ...(statuses ?? [])) as MemoryItemRow[];
    return rows.map(toItem);
  }

  list(request: ListMemoryItemsRequest = {}): MemoryItem[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (request.workspaceId !== undefined) {
      if (request.workspaceId === null) {
        where.push("workspace_id IS NULL");
      } else if (request.includeGlobal) {
        where.push("(workspace_id = ? OR workspace_id IS NULL)");
        params.push(request.workspaceId);
      } else {
        where.push("workspace_id = ?");
        params.push(request.workspaceId);
      }
    }
    if (request.scope) {
      where.push("scope = ?");
      params.push(request.scope);
    }
    if (request.scopeRef !== undefined) {
      where.push("scope_ref = ?");
      params.push(request.scopeRef);
    }
    if (request.kinds?.length) {
      where.push(`kind IN (${request.kinds.map(() => "?").join(", ")})`);
      params.push(...request.kinds);
    }
    const statuses = request.statuses?.length ? request.statuses : ["active"];
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
    if (request.subjectKey) {
      where.push("subject_key = ?");
      params.push(request.subjectKey);
    }
    if (request.sourceStore) {
      where.push("json_extract(source_ref, '$.store') = ?");
      params.push(request.sourceStore);
    }
    if (request.pinnedOnly) where.push("pinned = 1");
    if (!request.includePrivate) where.push("privacy = 'normal'");
    const limit = Math.max(1, Math.min(5000, Math.floor(request.limit ?? 200)));
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${where.join(" AND ")}
         ORDER BY pinned DESC, trust DESC, confidence DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as MemoryItemRow[];
    return rows.map(toItem);
  }

  /**
   * Active workspace items for a generated kit view: `user` is identity and preference
   * items plus anything curated into the user lane; `workspace` is everything else.
   * Private items are left out: kit files are injected into prompts.
   */
  listForView(workspaceId: string, view: "user" | "workspace", limit: number): MemoryItem[] {
    const userLane = `(kind IN ('identity', 'preference')
      OR COALESCE(json_extract(source_ref, '$.target'), '') = 'user')`;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE workspace_id = ? AND scope = 'workspace' AND status = 'active'
           AND privacy = 'normal'
           AND ${view === "user" ? userLane : `NOT ${userLane}`}
         ORDER BY pinned DESC, confidence DESC, updated_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(workspaceId, Math.max(1, Math.min(1000, Math.floor(limit)))) as MemoryItemRow[];
    return rows.map(toItem);
  }

  /**
   * Dedupe, supersede and persist one prepared write. Run inside one transaction (a unit):
   * the reads and writes below are never interleaved with another writer.
   *
   *  1. migration: a row with the same source ref exists → skip (idempotent re-run);
   *  2. live edit: the active row with the same source ref is the record being changed;
   *  3. an active row with the same content hash in the scope and kind → reinforce it;
   *  4. an active row holding the subject in the scope → supersede it, unless it has
   *     higher trust (the write is then skipped as `outranked`);
   *  5. otherwise insert.
   */
  ingest(write: PreparedMemoryItemWrite): MemoryItemIngestOutcome {
    const ref = write.sourceRef;
    const hasRef = typeof ref.store === "string" && typeof ref.id === "string";
    if (write.mode === "migration" && hasRef) {
      const existing = this.findBySourceRef(ref.store as string, ref.id as string);
      if (existing.length > 0) {
        return { action: "skipped", reason: "already_migrated", holderId: existing[0].id };
      }
    }
    const scope = scopeParams(write);
    const editTarget =
      write.mode === "live" && hasRef
        ? this.findBySourceRef(ref.store as string, ref.id as string, ["active"])[0]
        : undefined;

    if (write.status === "archived") {
      return this.insertArchived(write);
    }

    const duplicate = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE ${SCOPE_MATCH} AND kind = ? AND content_hash = ? AND status = 'active'`,
      )
      .get(...scope, write.kind, write.contentHash) as MemoryItemRow | undefined;

    if (duplicate) {
      return this.reinforce(toItem(duplicate), write, editTarget);
    }

    const holderRow = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${SCOPE_MATCH} AND subject_key = ? AND status = 'active'`,
      )
      .get(...scope, write.subjectKey) as MemoryItemRow | undefined;
    const holder = holderRow ? toItem(holderRow) : undefined;
    const holderIsEdit = Boolean(holder && editTarget && holder.id === editTarget.id);
    if (holder && !holderIsEdit && write.trust < holder.trust) {
      return { action: "skipped", reason: "outranked", holderId: holder.id };
    }

    const replaced = [editTarget, holder].filter(
      (item, index, all): item is MemoryItem =>
        Boolean(item) && all.findIndex((other) => other?.id === item?.id) === index,
    );
    for (const item of replaced) this.setStatusRow(item.id, "superseded", write.now);
    const pinned = write.pinned || replaced.some((item) => item.pinned);
    const inserted = this.insert(write, {
      supersedesId: (holder ?? editTarget)?.id ?? null,
      pinned,
    });
    return {
      action: replaced.length > 0 ? "superseded" : "inserted",
      item: inserted,
      supersededIds: replaced.map((item) => item.id),
    };
  }

  private reinforce(
    existing: MemoryItem,
    write: PreparedMemoryItemWrite,
    editTarget: MemoryItem | undefined,
  ): MemoryItemIngestOutcome {
    const supersededIds: string[] = [];
    // An edit that now says what another active row says: the edited row is replaced by
    // the existing one.
    if (editTarget && editTarget.id !== existing.id) {
      this.setStatusRow(editTarget.id, "superseded", write.now);
      supersededIds.push(editTarget.id);
    }

    let subjectKey = existing.subjectKey;
    let supersedesId = existing.supersedesId;
    // A named subject arriving for content that was stored under a derived key: adopt the
    // name, superseding a different active holder of that subject when trust allows.
    if (!write.derivedSubject && write.subjectKey !== existing.subjectKey) {
      if (isDerivedSubjectKey(existing.subjectKey)) {
        const holderRow = this.db
          .prepare(
            `SELECT * FROM memory_items
             WHERE ${SCOPE_MATCH} AND subject_key = ? AND status = 'active' AND id != ?`,
          )
          .get(...scopeParams(write), write.subjectKey, existing.id) as MemoryItemRow | undefined;
        const holder = holderRow ? toItem(holderRow) : undefined;
        if (!holder || Math.max(existing.trust, write.trust) >= holder.trust) {
          if (holder) {
            this.setStatusRow(holder.id, "superseded", write.now);
            supersededIds.push(holder.id);
            supersedesId = holder.id;
          }
          subjectKey = write.subjectKey;
        }
      }
    }

    const upgrade = write.trust > existing.trust;
    const sourceRef = mergeSourceRefs(existing.sourceRef, write.sourceRef, upgrade);
    // An edit of the same record sets confidence and pin as given; a repeat reinforces.
    const isEditOfSelf = editTarget?.id === existing.id;
    this.db
      .prepare(
        `UPDATE memory_items SET
           subject_key = ?,
           reinforced_count = reinforced_count + ?,
           confidence = CASE WHEN ? = 1 THEN ? ELSE MAX(confidence, ?) END,
           pinned = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN 1 ELSE pinned END,
           trust = MAX(trust, ?),
           source = ?,
           source_ref = ?,
           privacy = CASE WHEN ? = 'private' THEN 'private' ELSE privacy END,
           supersedes_id = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        subjectKey,
        isEditOfSelf ? 0 : 1,
        isEditOfSelf ? 1 : 0,
        write.confidence,
        write.confidence,
        isEditOfSelf ? 1 : 0,
        write.pinned ? 1 : 0,
        write.pinned ? 1 : 0,
        write.trust,
        upgrade ? write.source : existing.source,
        JSON.stringify(sourceRef),
        write.privacy,
        supersedesId,
        write.now,
        existing.id,
      );
    return {
      action: isEditOfSelf ? "updated" : "reinforced",
      item: this.findById(existing.id) as MemoryItem,
      supersededIds,
    };
  }

  private insertArchived(write: PreparedMemoryItemWrite): MemoryItemIngestOutcome {
    const item = this.insert(write, { supersedesId: null, pinned: write.pinned });
    return { action: "inserted", item, supersededIds: [] };
  }

  private insert(
    write: PreparedMemoryItemWrite,
    extra: { supersedesId: string | null; pinned: boolean },
  ): MemoryItem {
    const id = randomUUID();
    const createdAt = write.createdAt ?? write.now;
    this.db
      .prepare(
        `INSERT INTO memory_items (
           id, workspace_id, scope, scope_ref, kind, subject_key, content, source, source_ref,
           trust, confidence, status, pinned, reinforced_count, last_used_at, supersedes_id,
           content_hash, privacy, task_id, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        write.workspaceId,
        write.scope,
        write.scopeRef,
        write.kind,
        write.subjectKey,
        write.content,
        write.source,
        JSON.stringify(write.sourceRef),
        write.trust,
        write.confidence,
        write.status,
        extra.pinned ? 1 : 0,
        extra.supersedesId,
        // Archived rows sit outside the active unique indexes, so no conflict is possible.
        write.contentHash,
        write.privacy,
        write.taskId,
        write.expiresAt,
        createdAt,
        Math.max(createdAt, write.now),
      );
    return this.findById(id) as MemoryItem;
  }

  private setStatusRow(id: string, status: MemoryItemStatus, now: number): void {
    this.db
      .prepare("UPDATE memory_items SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);
  }

  /**
   * Change the status of items by id or by source ref. `deleted` applies to every revision
   * of a record and scrubs content and hash (the row stays as a tombstone until retention
   * drops it); `archived` and `superseded` apply to the active revision only. `active` is
   * refused here because reactivation must go through ingest (dedupe and supersession).
   */
  setStatus(
    target: { id: string } | { store: string; sourceId: string },
    status: Exclude<MemoryItemStatus, "active">,
    now: number,
  ): string[] {
    const rows =
      "id" in target
        ? ([this.findById(target.id)].filter(Boolean) as MemoryItem[])
        : this.findBySourceRef(
            target.store,
            target.sourceId,
            status === "deleted" ? ["active", "archived", "superseded"] : ["active"],
          );
    const changed: string[] = [];
    for (const item of rows) {
      if (item.status === status || item.status === "deleted") continue;
      if (status === "deleted") {
        this.db
          .prepare(
            `UPDATE memory_items
             SET status = 'deleted', content = '', content_hash = ?, pinned = 0, updated_at = ?
             WHERE id = ?`,
          )
          .run(`deleted:${item.id}`, now, item.id);
      } else {
        this.setStatusRow(item.id, status, now);
      }
      changed.push(item.id);
    }
    return changed;
  }

  /** Record that items were used in a prompt or answer (recall ranking, retention). */
  markUsed(ids: string[], now: number): number {
    let changed = 0;
    const statement = this.db.prepare(
      "UPDATE memory_items SET last_used_at = ? WHERE id = ? AND status = 'active'",
    );
    for (const id of ids) changed += statement.run(now, id).changes;
    return changed;
  }

  /** "Clear All Memories": every item that belongs to the workspace. */
  purgeWorkspace(workspaceId: string): number {
    return this.db.prepare("DELETE FROM memory_items WHERE workspace_id = ?").run(workspaceId)
      .changes;
  }

  /** Active curated entries not yet migrated, oldest first. */
  listCuratedForMigration(): CuratedEntryMigrationRow[] {
    if (!tableExists(this.db, "curated_memory_entries")) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.workspace_id, c.task_id, c.target, c.kind, c.content, c.source,
                c.confidence, c.created_at, c.updated_at
         FROM curated_memory_entries c
         JOIN workspaces w ON w.id = c.workspace_id
         WHERE c.status = 'active'
         ORDER BY c.updated_at ASC, c.rowid ASC`,
      )
      .all() as Array<{
      id: string;
      workspace_id: string;
      task_id: string | null;
      target: string;
      kind: string;
      content: string;
      source: string;
      confidence: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      taskId: row.task_id,
      target: row.target,
      kind: row.kind,
      content: row.content,
      source: row.source,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  isLaneMigrationComplete(): boolean {
    if (!tableExists(this.db, "maintenance_state")) return false;
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM maintenance_state WHERE key = ?")
        .get(MEMORY_ITEMS_LANE_MIGRATION_KEY),
    );
  }

  recordLaneMigration(summary: Record<string, number>, now: number): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db
      .prepare(
        `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(MEMORY_ITEMS_LANE_MIGRATION_KEY, JSON.stringify(summary), now);
  }

  // ---- Memory Hub ("What CoWork knows") and kit back-sync ----

  /**
   * One page of a workspace's items plus global items and workspace-less contact items,
   * newest first within pin and trust. Private items are included (the owner sees them).
   */
  listPage(request: MemoryItemsPageRequest): MemoryItemsPage {
    const where = ["(workspace_id = ? OR workspace_id IS NULL)"];
    const params: unknown[] = [request.workspaceId];
    const inList = (column: string, values: readonly string[] | undefined) => {
      if (!values?.length) return;
      where.push(`${column} IN (${values.map(() => "?").join(", ")})`);
      params.push(...values);
    };
    inList("kind", request.kinds);
    inList("scope", request.scopes);
    inList("status", request.statuses?.length ? request.statuses : ["active"]);
    inList("source", request.sources);
    if (request.pinnedOnly) where.push("pinned = 1");
    const query = (request.query ?? "").trim().toLowerCase();
    if (query) {
      where.push("(lower(content) LIKE ? ESCAPE '\\' OR subject_key LIKE ? ESCAPE '\\')");
      const pattern = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      params.push(pattern, pattern);
    }
    const clause = where.join(" AND ");
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM memory_items WHERE ${clause}`)
        .get(...params) as { count: number }
    ).count;
    const limit = Math.max(1, Math.min(200, Math.floor(request.limit ?? 100)));
    const offset = Math.max(0, Math.min(100_000, Math.floor(request.offset ?? 0)));
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${clause}
         ORDER BY pinned DESC, trust DESC, updated_at DESC, rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as MemoryItemRow[];
    return { items: rows.map(toItem), total };
  }

  /**
   * Older revisions of an item, newest first, following `supersedes_id` (at most `max`;
   * retention may have dropped the tail), and the revision that replaced it, if any.
   */
  revisions(id: string, max: number): { previous: MemoryItem[]; supersededBy: MemoryItem | null } {
    const previous: MemoryItem[] = [];
    const seen = new Set([id]);
    let cursor = this.findById(id)?.supersedesId ?? null;
    while (cursor && previous.length < max && !seen.has(cursor)) {
      seen.add(cursor);
      const item = this.findById(cursor);
      if (!item) break;
      previous.push(item);
      cursor = item.supersedesId;
    }
    const next = this.db
      .prepare(
        "SELECT * FROM memory_items WHERE supersedes_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(id) as MemoryItemRow | undefined;
    return { previous, supersededBy: next ? toItem(next) : null };
  }

  /** Pin or unpin an active item; returns whether it changed. */
  setPinned(id: string, pinned: boolean, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE memory_items SET pinned = ?, updated_at = ?
           WHERE id = ? AND status = 'active' AND pinned != ?`,
        )
        .run(pinned ? 1 : 0, now, id, pinned ? 1 : 0).changes > 0
    );
  }

  /** "Clear global memory": every global item and revision (workspace items untouched). */
  purgeGlobal(): number {
    return this.db
      .prepare("DELETE FROM memory_items WHERE workspace_id IS NULL AND scope = 'global'")
      .run().changes;
  }

  getKitRenderState(key: string): KitRenderState | null {
    if (!tableExists(this.db, "maintenance_state")) return null;
    const row = this.db
      .prepare("SELECT value FROM maintenance_state WHERE key = ?")
      .get(`${KIT_RENDER_STATE_PREFIX}${key}`) as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      const parsed = JSON.parse(row.value) as KitRenderState;
      return parsed && typeof parsed.hash === "string" && Array.isArray(parsed.entries)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  setKitRenderState(key: string, state: KitRenderState, now: number): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db
      .prepare(
        `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(`${KIT_RENDER_STATE_PREFIX}${key}`, JSON.stringify(state), now);
  }
}

/**
 * Task delete (memory-purge-sql.ts `purgeTaskDerivedRows`): task-scoped items always go;
 * with `purgeDerivedMemory`, items inferred from the task or quoted from third parties go
 * too, while user-stated, confirmed and curated items survive with their task link cleared.
 */
export function purgeTaskMemoryItems(
  db: Database.Database,
  taskId: string,
  purgeDerivedMemory: boolean,
): number {
  if (!tableExists(db, "memory_items")) return 0;
  let deleted = db
    .prepare("DELETE FROM memory_items WHERE scope = 'task' AND scope_ref = ?")
    .run(taskId).changes;
  if (purgeDerivedMemory) {
    deleted += db
      .prepare(
        `DELETE FROM memory_items
         WHERE task_id = ? AND source IN ('inferred', 'third_party', 'system')`,
      )
      .run(taskId).changes;
  }
  db.prepare("UPDATE memory_items SET task_id = NULL WHERE task_id = ?").run(taskId);
  return deleted;
}

/** "Clear All Memories" (memory-purge-sql.ts `purgeWorkspaceMemoryRows`). */
export function purgeWorkspaceMemoryItems(db: Database.Database, workspaceId: string): number {
  if (!tableExists(db, "memory_items")) return 0;
  if (tableExists(db, "maintenance_state")) {
    // The last rendered kit blocks quote item text; they go with the items.
    db.prepare("DELETE FROM maintenance_state WHERE key IN (?, ?)").run(
      `${KIT_RENDER_STATE_PREFIX}${workspaceId}:user`,
      `${KIT_RENDER_STATE_PREFIX}${workspaceId}:workspace`,
    );
  }
  return new MemoryItemsStore(db).purgeWorkspace(workspaceId);
}
