import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { BoxBrainItemStatus, BoxBrainRunStatus, BoxBrainSettings } from "../../shared/types";

export type BoxBrainRunState = BoxBrainRunStatus | "running";

export interface BoxBrainSourceRecord {
  id: string;
  workspaceId: string;
  serverId: string;
  rootFolderId: string;
  enabled: boolean;
  syncIntervalMinutes: number;
  maxItemsPerRun: number;
  includeContent: boolean;
  useBoxAiSummaries: boolean;
  improvementEnabled: boolean;
  maxContentChars: number;
  lastRunAt?: number;
  lastSuccessAt?: number;
  lastImprovementRunAt?: number;
  lastError?: string;
  lastDiscoveredCount: number;
  lastIndexedCount: number;
  lastUnchangedCount: number;
  lastSkippedCount: number;
  lastDeletedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoxBrainItemRecord {
  id: string;
  sourceId: string;
  workspaceId: string;
  boxId: string;
  boxType: string;
  name: string;
  parentId?: string;
  path?: string;
  etag?: string;
  versionId?: string;
  modifiedAt?: number;
  sizeBytes?: number;
  sourceUrl: string;
  contentHash?: string;
  memoryId?: string;
  status: BoxBrainItemStatus;
  error?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  indexedAt?: number;
  deletedAt?: number;
}

export interface BoxBrainRunRecord {
  id: string;
  sourceId: string;
  workspaceId: string;
  status: BoxBrainRunState;
  discoveredCount: number;
  indexedCount: number;
  unchangedCount: number;
  skippedCount: number;
  deletedCount: number;
  improvementRunId?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

type BoxBrainSourcePatch = Partial<
  Pick<
    BoxBrainSourceRecord,
    | "lastRunAt"
    | "lastSuccessAt"
    | "lastImprovementRunAt"
    | "lastDiscoveredCount"
    | "lastIndexedCount"
    | "lastUnchangedCount"
    | "lastSkippedCount"
    | "lastDeletedCount"
  >
> & {
  lastError?: string | null;
};

type BoxBrainItemInput = Omit<BoxBrainItemRecord, "id" | "firstSeenAt" | "lastSeenAt"> & {
  id?: string;
  firstSeenAt?: number;
  lastSeenAt?: number;
};

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class BoxBrainRepository {
  constructor(private readonly db: Database.Database) {}

  ensureSource(
    workspaceId: string,
    serverId: string,
    settings: BoxBrainSettings,
  ): BoxBrainSourceRecord {
    const existing = this.findSource(workspaceId, serverId, settings.rootFolderId);
    const now = Date.now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE box_brain_sources
           SET enabled = ?, sync_interval_minutes = ?, max_items_per_run = ?,
               include_content = ?, use_box_ai_summaries = ?, improvement_enabled = ?,
               max_content_chars = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          settings.enabled ? 1 : 0,
          settings.syncIntervalMinutes,
          settings.maxItemsPerRun,
          settings.includeContent ? 1 : 0,
          settings.useBoxAiSummaries ? 1 : 0,
          settings.improvementEnabled ? 1 : 0,
          settings.maxContentChars,
          now,
          existing.id,
        );
      return this.findSourceById(existing.id)!;
    }

    const source: BoxBrainSourceRecord = {
      id: randomUUID(),
      workspaceId,
      serverId,
      rootFolderId: settings.rootFolderId,
      enabled: settings.enabled,
      syncIntervalMinutes: settings.syncIntervalMinutes,
      maxItemsPerRun: settings.maxItemsPerRun,
      includeContent: settings.includeContent,
      useBoxAiSummaries: settings.useBoxAiSummaries,
      improvementEnabled: settings.improvementEnabled,
      maxContentChars: settings.maxContentChars,
      lastDiscoveredCount: 0,
      lastIndexedCount: 0,
      lastUnchangedCount: 0,
      lastSkippedCount: 0,
      lastDeletedCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO box_brain_sources (
          id, workspace_id, server_id, root_folder_id, enabled,
          sync_interval_minutes, max_items_per_run, include_content,
          use_box_ai_summaries, improvement_enabled, max_content_chars,
          last_discovered_count, last_indexed_count, last_unchanged_count,
          last_skipped_count, last_deleted_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.id,
        source.workspaceId,
        source.serverId,
        source.rootFolderId,
        source.enabled ? 1 : 0,
        source.syncIntervalMinutes,
        source.maxItemsPerRun,
        source.includeContent ? 1 : 0,
        source.useBoxAiSummaries ? 1 : 0,
        source.improvementEnabled ? 1 : 0,
        source.maxContentChars,
        source.lastDiscoveredCount,
        source.lastIndexedCount,
        source.lastUnchangedCount,
        source.lastSkippedCount,
        source.lastDeletedCount,
        source.createdAt,
        source.updatedAt,
      );
    return source;
  }

  findSource(
    workspaceId: string,
    serverId: string,
    rootFolderId: string,
  ): BoxBrainSourceRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM box_brain_sources
         WHERE workspace_id = ? AND server_id = ? AND root_folder_id = ?`,
      )
      .get(workspaceId, serverId, rootFolderId) as Record<string, unknown> | undefined;
    return row ? this.mapSource(row) : null;
  }

  findSourceById(id: string): BoxBrainSourceRecord | null {
    const row = this.db.prepare("SELECT * FROM box_brain_sources WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapSource(row) : null;
  }

  listSources(): BoxBrainSourceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM box_brain_sources ORDER BY updated_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapSource(row));
  }

  listDueSources(now = Date.now()): BoxBrainSourceRecord[] {
    return this.listSources().filter((source) => {
      if (!source.enabled) return false;
      if (!source.lastRunAt) return true;
      return now - source.lastRunAt >= source.syncIntervalMinutes * 60 * 1000;
    });
  }

  updateSource(id: string, patch: BoxBrainSourcePatch): BoxBrainSourceRecord | null {
    const fields: string[] = [];
    const values: unknown[] = [];
    const columns: Array<[keyof BoxBrainSourcePatch, string]> = [
      ["lastRunAt", "last_run_at"],
      ["lastSuccessAt", "last_success_at"],
      ["lastImprovementRunAt", "last_improvement_run_at"],
      ["lastError", "last_error"],
      ["lastDiscoveredCount", "last_discovered_count"],
      ["lastIndexedCount", "last_indexed_count"],
      ["lastUnchangedCount", "last_unchanged_count"],
      ["lastSkippedCount", "last_skipped_count"],
      ["lastDeletedCount", "last_deleted_count"],
    ];
    for (const [key, column] of columns) {
      if (patch[key] === undefined) continue;
      fields.push(`${column} = ?`);
      values.push(patch[key] ?? null);
    }
    if (fields.length === 0) return this.findSourceById(id);
    fields.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db
      .prepare(`UPDATE box_brain_sources SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findSourceById(id);
  }

  createRun(sourceId: string, workspaceId: string, startedAt = Date.now()): BoxBrainRunRecord {
    const run: BoxBrainRunRecord = {
      id: randomUUID(),
      sourceId,
      workspaceId,
      status: "running",
      discoveredCount: 0,
      indexedCount: 0,
      unchangedCount: 0,
      skippedCount: 0,
      deletedCount: 0,
      startedAt,
    };
    this.db
      .prepare(
        `INSERT INTO box_brain_runs (
          id, source_id, workspace_id, status, discovered_count, indexed_count,
          unchanged_count, skipped_count, deleted_count, improvement_run_id,
          error, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.sourceId,
        run.workspaceId,
        run.status,
        run.discoveredCount,
        run.indexedCount,
        run.unchangedCount,
        run.skippedCount,
        run.deletedCount,
        null,
        null,
        run.startedAt,
        null,
      );
    return run;
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        BoxBrainRunRecord,
        | "status"
        | "discoveredCount"
        | "indexedCount"
        | "unchangedCount"
        | "skippedCount"
        | "deletedCount"
        | "improvementRunId"
        | "error"
        | "completedAt"
      >
    >,
  ): BoxBrainRunRecord | null {
    const map: Array<[keyof typeof patch, string]> = [
      ["status", "status"],
      ["discoveredCount", "discovered_count"],
      ["indexedCount", "indexed_count"],
      ["unchangedCount", "unchanged_count"],
      ["skippedCount", "skipped_count"],
      ["deletedCount", "deleted_count"],
      ["improvementRunId", "improvement_run_id"],
      ["error", "error"],
      ["completedAt", "completed_at"],
    ];
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of map) {
      if (patch[key] === undefined) continue;
      fields.push(`${column} = ?`);
      values.push(patch[key] ?? null);
    }
    if (fields.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE box_brain_runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.findRunById(id);
  }

  findRunById(id: string): BoxBrainRunRecord | null {
    const row = this.db.prepare("SELECT * FROM box_brain_runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRun(row) : null;
  }

  listRuns(sourceId: string, limit = 20): BoxBrainRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM box_brain_runs
         WHERE source_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(sourceId, Math.min(Math.max(Math.floor(limit), 1), 100)) as Record<string, unknown>[];
    return rows.map((row) => this.mapRun(row));
  }

  findItem(sourceId: string, boxId: string): BoxBrainItemRecord | null {
    const row = this.db
      .prepare("SELECT * FROM box_brain_items WHERE source_id = ? AND box_id = ?")
      .get(sourceId, boxId) as Record<string, unknown> | undefined;
    return row ? this.mapItem(row) : null;
  }

  listItems(sourceId: string): BoxBrainItemRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM box_brain_items
         WHERE source_id = ? ORDER BY COALESCE(path, name), name`,
      )
      .all(sourceId) as Record<string, unknown>[];
    return rows.map((row) => this.mapItem(row));
  }

  upsertItem(input: BoxBrainItemInput): BoxBrainItemRecord {
    const existing = this.findItem(input.sourceId, input.boxId);
    const now = input.lastSeenAt ?? Date.now();
    const item: BoxBrainItemRecord = {
      ...input,
      id: existing?.id || input.id || randomUUID(),
      firstSeenAt: existing?.firstSeenAt || input.firstSeenAt || now,
      lastSeenAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO box_brain_items (
          id, source_id, workspace_id, box_id, box_type, name, parent_id, path,
          etag, version_id, modified_at, size_bytes, source_url, content_hash,
          memory_id, status, error, first_seen_at, last_seen_at, indexed_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, box_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          box_type = excluded.box_type,
          name = excluded.name,
          parent_id = excluded.parent_id,
          path = excluded.path,
          etag = excluded.etag,
          version_id = excluded.version_id,
          modified_at = excluded.modified_at,
          size_bytes = excluded.size_bytes,
          source_url = excluded.source_url,
          content_hash = excluded.content_hash,
          memory_id = excluded.memory_id,
          status = excluded.status,
          error = excluded.error,
          last_seen_at = excluded.last_seen_at,
          indexed_at = excluded.indexed_at,
          deleted_at = excluded.deleted_at`,
      )
      .run(
        item.id,
        item.sourceId,
        item.workspaceId,
        item.boxId,
        item.boxType,
        item.name,
        item.parentId || null,
        item.path || null,
        item.etag || null,
        item.versionId || null,
        item.modifiedAt ?? null,
        item.sizeBytes ?? null,
        item.sourceUrl,
        item.contentHash || null,
        item.memoryId || null,
        item.status,
        item.error || null,
        item.firstSeenAt,
        item.lastSeenAt,
        item.indexedAt || null,
        item.deletedAt || null,
      );
    return this.findItem(item.sourceId, item.boxId)!;
  }

  updateItemStatus(
    sourceId: string,
    boxId: string,
    status: BoxBrainItemStatus,
    patch: { error?: string; deletedAt?: number; lastSeenAt?: number } = {},
  ): BoxBrainItemRecord | null {
    const current = this.findItem(sourceId, boxId);
    if (!current) return null;
    return this.upsertItem({
      ...current,
      status,
      error: patch.error,
      deletedAt: patch.deletedAt,
      lastSeenAt: patch.lastSeenAt ?? current.lastSeenAt,
    });
  }

  private mapSource(row: Record<string, unknown>): BoxBrainSourceRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      serverId: String(row.server_id),
      rootFolderId: String(row.root_folder_id),
      enabled: Boolean(row.enabled),
      syncIntervalMinutes: Number(row.sync_interval_minutes || 60),
      maxItemsPerRun: Number(row.max_items_per_run || 200),
      includeContent: Boolean(row.include_content),
      useBoxAiSummaries: Boolean(row.use_box_ai_summaries),
      improvementEnabled: Boolean(row.improvement_enabled),
      maxContentChars: Number(row.max_content_chars || 10000),
      lastRunAt: optionalNumber(row.last_run_at),
      lastSuccessAt: optionalNumber(row.last_success_at),
      lastImprovementRunAt: optionalNumber(row.last_improvement_run_at),
      lastError: optionalString(row.last_error),
      lastDiscoveredCount: Number(row.last_discovered_count || 0),
      lastIndexedCount: Number(row.last_indexed_count || 0),
      lastUnchangedCount: Number(row.last_unchanged_count || 0),
      lastSkippedCount: Number(row.last_skipped_count || 0),
      lastDeletedCount: Number(row.last_deleted_count || 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapItem(row: Record<string, unknown>): BoxBrainItemRecord {
    return {
      id: String(row.id),
      sourceId: String(row.source_id),
      workspaceId: String(row.workspace_id),
      boxId: String(row.box_id),
      boxType: String(row.box_type),
      name: String(row.name),
      parentId: optionalString(row.parent_id),
      path: optionalString(row.path),
      etag: optionalString(row.etag),
      versionId: optionalString(row.version_id),
      modifiedAt: optionalNumber(row.modified_at),
      sizeBytes: optionalNumber(row.size_bytes),
      sourceUrl: String(row.source_url),
      contentHash: optionalString(row.content_hash),
      memoryId: optionalString(row.memory_id),
      status: String(row.status) as BoxBrainItemStatus,
      error: optionalString(row.error),
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      indexedAt: optionalNumber(row.indexed_at),
      deletedAt: optionalNumber(row.deleted_at),
    };
  }

  private mapRun(row: Record<string, unknown>): BoxBrainRunRecord {
    return {
      id: String(row.id),
      sourceId: String(row.source_id),
      workspaceId: String(row.workspace_id),
      status: String(row.status) as BoxBrainRunState,
      discoveredCount: Number(row.discovered_count || 0),
      indexedCount: Number(row.indexed_count || 0),
      unchangedCount: Number(row.unchanged_count || 0),
      skippedCount: Number(row.skipped_count || 0),
      deletedCount: Number(row.deleted_count || 0),
      improvementRunId: optionalString(row.improvement_run_id),
      error: optionalString(row.error),
      startedAt: Number(row.started_at),
      completedAt: optionalNumber(row.completed_at),
    };
  }
}
