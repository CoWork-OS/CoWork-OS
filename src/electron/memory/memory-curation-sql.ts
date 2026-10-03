import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { MemoryItemsStore } from "./memory-items-sql";
import type {
  MemoryItem,
  MemoryItemStatus,
  MemorySourceRef,
  PreparedMemoryItemWrite,
} from "./memory-items-types";

/**
 * Memory curator SQL (docs/memory-engine.md §9): applies one curation operation to
 * `memory_items` together with its audit-log row, undoes it, and reads the curator's
 * inputs. Run as memory-domain units (memory-curation-units.ts), so every apply or undo is
 * one transaction, in the database worker when memory is routed there.
 *
 * The store re-checks the safety invariants itself (defense in depth): only active,
 * global or workspace items of the requesting workspace; items the user stated or
 * confirmed only when the user accepted the change; no merge into a weaker item.
 */

export type CurationLogOrigin = "auto" | "review";

/** Sources the curator never changes on its own. */
export const CURATION_PROTECTED_SOURCES: ReadonlySet<string> = new Set([
  "user_stated",
  "user_confirmed",
]);

export type CurationItemOperation =
  | { op: "merge"; keepId: string; mergeIds: string[] }
  | { op: "resolve_conflict"; keepId: string; dropIds: string[] }
  | { op: "decay"; itemIds: string[] }
  | { op: "expire_commitment"; itemIds: string[] };

export type CurationStoreOperation =
  | CurationItemOperation
  | { op: "promote"; write: PreparedMemoryItemWrite };

export interface CurationApplyRequest {
  workspaceId: string;
  runId: string | null;
  candidateId: string | null;
  origin: CurationLogOrigin;
  fingerprint: string;
  summary: string;
  rationale: string | null;
  /** True only when the user accepted the change (review); lets it touch protected items. */
  allowProtected: boolean;
  operation: CurationStoreOperation;
  now: number;
}

export interface CurationSnapshot {
  id: string;
  kind: string;
  scope: string;
  workspaceId: string | null;
  source: string;
  content: string;
  status: MemoryItemStatus;
  pinned: boolean;
  reinforcedCount: number;
  confidence: number;
  sourceRef: MemorySourceRef;
  updatedAt: number;
}

export interface CurationLogEntry {
  id: string;
  workspaceId: string;
  runId: string | null;
  candidateId: string | null;
  op: string;
  origin: CurationLogOrigin;
  fingerprint: string;
  itemIds: string[];
  createdIds: string[];
  before: CurationSnapshot[];
  after: CurationSnapshot[];
  summary: string;
  rationale: string | null;
  hasGlobal: boolean;
  appliedAt: number;
  undoneAt: number | null;
}

export type CurationRefusal =
  | "missing"
  | "not_active"
  | "foreign"
  | "protected"
  | "mismatch"
  | "outranked"
  | "duplicate"
  | "empty";

export type CurationApplyOutcome =
  | { status: "applied"; log: CurationLogEntry; changedIds: string[] }
  | { status: "refused"; reason: CurationRefusal };

export type CurationUndoOutcome =
  | { status: "undone"; log: CurationLogEntry; changedIds: string[] }
  | { status: "refused"; reason: "missing" | "already_undone" | "changed" | "conflict" };

export interface ArchiveEvidenceRow {
  id: string;
  taskId: string | null;
  type: string;
  content: string;
  createdAt: number;
  isPrivate: boolean;
  origin: string;
}

/** Archive row types the curator reads: outcomes, decisions, errors, corrections, preferences. */
const ARCHIVE_EVIDENCE_TYPES = [
  "decision",
  "error",
  "insight",
  "preference",
  "constraint",
  "correction_rule",
  "workflow_pattern",
  "timing_preference",
];

const MAX_ALIASES = 20;

interface LogRow {
  id: string;
  workspace_id: string;
  run_id: string | null;
  candidate_id: string | null;
  op: string;
  origin: string;
  fingerprint: string;
  item_ids: string;
  created_ids: string;
  before_snapshot: string;
  after_snapshot: string;
  summary: string;
  rationale: string | null;
  has_global: number;
  applied_at: number;
  undone_at: number | null;
}

function parseArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toLogEntry(row: LogRow): CurationLogEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    op: row.op,
    origin: row.origin === "review" ? "review" : "auto",
    fingerprint: row.fingerprint,
    itemIds: parseArray<string>(row.item_ids),
    createdIds: parseArray<string>(row.created_ids),
    before: parseArray<CurationSnapshot>(row.before_snapshot),
    after: parseArray<CurationSnapshot>(row.after_snapshot),
    summary: row.summary,
    rationale: row.rationale,
    hasGlobal: row.has_global === 1,
    appliedAt: row.applied_at,
    undoneAt: row.undone_at,
  };
}

function snapshot(item: MemoryItem): CurationSnapshot {
  return {
    id: item.id,
    kind: item.kind,
    scope: item.scope,
    workspaceId: item.workspaceId,
    source: item.source,
    content: item.content,
    status: item.status,
    pinned: item.pinned,
    reinforcedCount: item.reinforcedCount,
    confidence: item.confidence,
    sourceRef: item.sourceRef,
    updatedAt: item.updatedAt,
  };
}

function refKey(ref: MemorySourceRef): string | null {
  return typeof ref.store === "string" && typeof ref.id === "string"
    ? `${ref.store}:${ref.id}`
    : null;
}

/** The keeper's source ref after a merge: every merged record becomes an alias. */
function mergeAliases(keep: MemorySourceRef, merged: MemorySourceRef[]): MemorySourceRef {
  const aliases = new Set(
    Array.isArray(keep.aliases)
      ? keep.aliases.filter((value): value is string => typeof value === "string")
      : [],
  );
  for (const ref of merged) {
    const key = refKey(ref);
    if (key) aliases.add(key);
    if (Array.isArray(ref.aliases)) {
      for (const alias of ref.aliases) if (typeof alias === "string") aliases.add(alias);
    }
  }
  const primary = refKey(keep);
  if (primary) aliases.delete(primary);
  const next: MemorySourceRef = { ...keep };
  const list = [...aliases].slice(-MAX_ALIASES);
  if (list.length > 0) next.aliases = list;
  return next;
}

function sameScope(a: MemoryItem, b: MemoryItem): boolean {
  return (
    (a.workspaceId ?? "") === (b.workspaceId ?? "") &&
    a.scope === b.scope &&
    (a.scopeRef ?? "") === (b.scopeRef ?? "")
  );
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

export class MemoryCurationStore {
  private readonly items: MemoryItemsStore;

  constructor(private readonly db: Database.Database) {
    this.items = new MemoryItemsStore(db);
  }

  /** Apply one operation and record it, atomically (the caller's unit is the transaction). */
  apply(request: CurationApplyRequest): CurationApplyOutcome {
    const operation = request.operation;
    if (operation.op === "promote") return this.applyPromotion(request, operation.write);

    const ids =
      operation.op === "merge"
        ? [operation.keepId, ...operation.mergeIds]
        : operation.op === "resolve_conflict"
          ? [operation.keepId, ...operation.dropIds]
          : operation.itemIds;
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      return { status: "refused", reason: "empty" };
    }
    if ((operation.op === "merge" || operation.op === "resolve_conflict") && ids.length < 2) {
      return { status: "refused", reason: "empty" };
    }
    const items: MemoryItem[] = [];
    for (const id of ids) {
      const item = this.items.findById(id);
      if (!item) return { status: "refused", reason: "missing" };
      if (item.status !== "active") return { status: "refused", reason: "not_active" };
      if (item.scope !== "global" && item.scope !== "workspace") {
        return { status: "refused", reason: "foreign" };
      }
      if (item.workspaceId !== null && item.workspaceId !== request.workspaceId) {
        return { status: "refused", reason: "foreign" };
      }
      items.push(item);
    }

    const now = request.now;
    const before = items.map(snapshot);
    if (operation.op === "decay" || operation.op === "expire_commitment") {
      if (!request.allowProtected && items.some((item) => isProtected(item))) {
        return { status: "refused", reason: "protected" };
      }
      if (
        operation.op === "expire_commitment" &&
        items.some((item) => item.kind !== "commitment")
      ) {
        return { status: "refused", reason: "mismatch" };
      }
      for (const item of items) this.setStatus(item.id, "archived", now);
    } else {
      const [keep, ...others] = items;
      if (others.some((item) => item.kind !== keep.kind || !sameScope(item, keep))) {
        return { status: "refused", reason: "mismatch" };
      }
      // A merge or conflict resolution changes the keeper too (aliases, reinforcement).
      if (!request.allowProtected && items.some((item) => isProtected(item))) {
        return { status: "refused", reason: "protected" };
      }
      // Never merge into a weaker item; an accepted conflict resolution may keep either side.
      const outranked = others.some((item) => item.trust > keep.trust);
      if (outranked && (operation.op === "merge" || !request.allowProtected)) {
        return { status: "refused", reason: "outranked" };
      }
      for (const item of others) this.setStatus(item.id, "superseded", now);
      if (operation.op === "merge") {
        const sourceRef = mergeAliases(
          keep.sourceRef,
          others.map((item) => item.sourceRef),
        );
        const reinforced = others.reduce((sum, item) => sum + item.reinforcedCount + 1, 0);
        this.db
          .prepare(
            `UPDATE memory_items SET
               reinforced_count = reinforced_count + ?,
               pinned = CASE WHEN ? = 1 THEN 1 ELSE pinned END,
               confidence = MAX(confidence, ?),
               source_ref = ?,
               updated_at = ?
             WHERE id = ?`,
          )
          .run(
            reinforced,
            others.some((item) => item.pinned) ? 1 : 0,
            Math.max(...others.map((item) => item.confidence)),
            JSON.stringify(sourceRef),
            now,
            keep.id,
          );
      } else {
        this.db.prepare("UPDATE memory_items SET updated_at = ? WHERE id = ?").run(now, keep.id);
      }
    }

    const after = ids.map((id) => snapshot(this.items.findById(id) as MemoryItem));
    const log = this.insertLog(request, {
      itemIds: ids,
      createdIds: [],
      before,
      after,
      hasGlobal: items.some((item) => item.workspaceId === null),
    });
    return { status: "applied", log, changedIds: ids };
  }

  private applyPromotion(
    request: CurationApplyRequest,
    write: PreparedMemoryItemWrite,
  ): CurationApplyOutcome {
    if (write.scope !== "workspace" || write.workspaceId !== request.workspaceId) {
      return { status: "refused", reason: "foreign" };
    }
    if (!request.allowProtected && CURATION_PROTECTED_SOURCES.has(write.source)) {
      return { status: "refused", reason: "protected" };
    }
    const duplicate = this.db
      .prepare(
        `SELECT 1 FROM memory_items
         WHERE COALESCE(workspace_id, '') = ? AND scope = 'workspace' AND kind = ?
           AND content_hash = ? AND status = 'active'`,
      )
      .get(write.workspaceId, write.kind, write.contentHash);
    if (duplicate) return { status: "refused", reason: "duplicate" };
    const outcome = this.items.ingest({ ...write, mode: "live", status: "active" });
    if (outcome.action === "skipped") return { status: "refused", reason: "outranked" };
    const superseded = outcome.supersededIds
      .map((id) => this.items.findById(id))
      .filter((item): item is MemoryItem => Boolean(item));
    // Rows replaced by the new fact are restored on undo.
    const before = superseded.map((item) => ({ ...snapshot(item), status: "active" as const }));
    const touched = [...outcome.supersededIds, outcome.item.id];
    const after = touched.map((id) => snapshot(this.items.findById(id) as MemoryItem));
    const log = this.insertLog(request, {
      itemIds: outcome.supersededIds,
      createdIds: [outcome.item.id],
      before,
      after,
      hasGlobal: false,
    });
    return { status: "applied", log, changedIds: touched };
  }

  /**
   * Undo an applied operation: created items are tombstoned and touched items get their
   * prior status, pin, reinforcement, confidence and provenance back. Refused when any of
   * them changed since (edited, deleted, re-curated) or when reactivating would collide
   * with an active item holding the same content or subject.
   */
  undo(logId: string, workspaceId: string, now: number): CurationUndoOutcome {
    const log = this.findLog(logId);
    if (!log || log.workspaceId !== workspaceId) return { status: "refused", reason: "missing" };
    if (log.undoneAt !== null) return { status: "refused", reason: "already_undone" };

    for (const expected of log.after) {
      const current = this.items.findById(expected.id);
      if (
        !current ||
        current.status !== expected.status ||
        current.updatedAt !== expected.updatedAt
      ) {
        return { status: "refused", reason: "changed" };
      }
    }
    const created = new Set(log.createdIds);
    const restoring = log.before.filter((entry) => entry.status === "active");
    const restoringIds = new Set(restoring.map((entry) => entry.id));
    for (const entry of restoring) {
      const item = this.items.findById(entry.id) as MemoryItem;
      if (item.status === "active") continue;
      const conflict = this.db
        .prepare(
          `SELECT id FROM memory_items
           WHERE COALESCE(workspace_id, '') = ? AND scope = ? AND COALESCE(scope_ref, '') = ?
             AND status = 'active' AND id != ?
             AND ((kind = ? AND content_hash = ?) OR subject_key = ?)`,
        )
        .all(
          item.workspaceId ?? "",
          item.scope,
          item.scopeRef ?? "",
          item.id,
          item.kind,
          item.contentHash,
          item.subjectKey,
        ) as Array<{ id: string }>;
      if (conflict.some((row) => !created.has(row.id) && !restoringIds.has(row.id))) {
        return { status: "refused", reason: "conflict" };
      }
    }

    // Deactivate first so reactivated rows never meet the active unique indexes twice.
    for (const id of log.createdIds) {
      this.db
        .prepare(
          `UPDATE memory_items
           SET status = 'deleted', content = '', content_hash = ?, pinned = 0, updated_at = ?
           WHERE id = ?`,
        )
        .run(`deleted:${id}`, now, id);
    }
    const ordered = [...log.before].sort(
      (a, b) => Number(a.status === "active") - Number(b.status === "active"),
    );
    for (const entry of ordered) {
      this.db
        .prepare(
          `UPDATE memory_items SET status = ?, pinned = ?, reinforced_count = ?, confidence = ?,
             source_ref = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          entry.status,
          entry.pinned ? 1 : 0,
          entry.reinforcedCount,
          entry.confidence,
          JSON.stringify(entry.sourceRef ?? {}),
          now,
          entry.id,
        );
    }
    this.db.prepare("UPDATE memory_curation_log SET undone_at = ? WHERE id = ?").run(now, logId);
    return {
      status: "undone",
      log: this.findLog(logId) as CurationLogEntry,
      changedIds: [...log.itemIds, ...log.createdIds],
    };
  }

  findLog(id: string): CurationLogEntry | undefined {
    const row = this.db.prepare("SELECT * FROM memory_curation_log WHERE id = ?").get(id) as
      | LogRow
      | undefined;
    return row ? toLogEntry(row) : undefined;
  }

  listLog(workspaceId: string, limit: number): CurationLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_curation_log WHERE workspace_id = ?
         ORDER BY applied_at DESC, rowid DESC LIMIT ?`,
      )
      .all(workspaceId, Math.max(1, Math.min(200, Math.floor(limit)))) as LogRow[];
    return rows.map(toLogEntry);
  }

  /** Fingerprints the user undid: the curator does not apply or propose them again. */
  undoneFingerprints(workspaceId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT fingerprint FROM memory_curation_log
         WHERE workspace_id = ? AND undone_at IS NOT NULL`,
      )
      .all(workspaceId) as Array<{ fingerprint: string }>;
    return rows.map((row) => row.fingerprint);
  }

  /**
   * Recent archive outcomes of a workspace: decisions, resolved errors, corrections,
   * preferences. Suppressed and redacted rows are left out (they are hidden from agents).
   */
  archiveEvidence(workspaceId: string, since: number, limit: number): ArchiveEvidenceRow[] {
    if (!tableExists(this.db, "memories")) return [];
    const hasMetadata = tableExists(this.db, "memory_observation_metadata");
    const rows = this.db
      .prepare(
        `SELECT m.id, m.task_id, m.type, m.content, m.created_at, m.is_private,
                ${hasMetadata ? "COALESCE(o.origin, 'unknown')" : "'unknown'"} AS origin
         FROM memories m
         ${hasMetadata ? "LEFT JOIN memory_observation_metadata o ON o.memory_id = m.id" : ""}
         WHERE m.workspace_id = ? AND m.created_at >= ?
           AND m.type IN (${ARCHIVE_EVIDENCE_TYPES.map(() => "?").join(", ")})
           ${hasMetadata ? "AND COALESCE(o.privacy_state, 'normal') NOT IN ('redacted', 'suppressed')" : ""}
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(
        workspaceId,
        since,
        ...ARCHIVE_EVIDENCE_TYPES,
        Math.max(1, Math.min(1000, Math.floor(limit))),
      ) as Array<{
      id: string;
      task_id: string | null;
      type: string;
      content: string;
      created_at: number;
      is_private: number;
      origin: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      content: row.content,
      createdAt: row.created_at,
      isPrivate: row.is_private === 1,
      origin: row.origin,
    }));
  }

  /** Tokens spent on curator LLM synthesis since `since`, across workspaces (daily budget). */
  llmTokensSince(since: number): number {
    if (!tableExists(this.db, "dreaming_runs")) return 0;
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(llm_tokens), 0) AS total FROM dreaming_runs WHERE created_at >= ?",
      )
      .get(since) as { total: number };
    return Number(row.total) || 0;
  }

  /**
   * Of the given workspaces, those due for the daily idle curation: no Dreaming run (of any
   * outcome) since `runSince` and a task created since `activeSince`. In the given order.
   * Both lookups use an index: (workspace_id, created_at) on each table.
   */
  dueWorkspaces(workspaceIds: string[], activeSince: number, runSince: number): string[] {
    if (!tableExists(this.db, "dreaming_runs") || !tableExists(this.db, "tasks")) return [];
    const recent = this.db.prepare(
      "SELECT 1 FROM dreaming_runs WHERE workspace_id = ? AND created_at >= ? LIMIT 1",
    );
    const active = this.db.prepare(
      "SELECT 1 FROM tasks WHERE workspace_id = ? AND created_at >= ? LIMIT 1",
    );
    return workspaceIds.filter(
      (workspaceId) => !recent.get(workspaceId, runSince) && active.get(workspaceId, activeSince),
    );
  }

  /** Open curator proposals of a workspace (the Memory Hub badge). */
  pendingCount(workspaceId: string): number {
    if (!tableExists(this.db, "dreaming_candidates")) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM dreaming_candidates
         WHERE workspace_id = ? AND target = 'memory_items' AND status = 'proposed'`,
      )
      .get(workspaceId) as { count: number };
    return Number(row.count) || 0;
  }

  private setStatus(id: string, status: MemoryItemStatus, now: number): void {
    this.db
      .prepare("UPDATE memory_items SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);
  }

  private insertLog(
    request: CurationApplyRequest,
    entry: {
      itemIds: string[];
      createdIds: string[];
      before: CurationSnapshot[];
      after: CurationSnapshot[];
      hasGlobal: boolean;
    },
  ): CurationLogEntry {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_curation_log (
           id, workspace_id, run_id, candidate_id, op, origin, fingerprint, item_ids,
           created_ids, before_snapshot, after_snapshot, summary, rationale, has_global,
           applied_at, undone_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        request.workspaceId,
        request.runId,
        request.candidateId,
        request.operation.op,
        request.origin,
        request.fingerprint,
        JSON.stringify(entry.itemIds),
        JSON.stringify(entry.createdIds),
        JSON.stringify(entry.before),
        JSON.stringify(entry.after),
        request.summary,
        request.rationale,
        entry.hasGlobal ? 1 : 0,
        request.now,
      );
    return this.findLog(id) as CurationLogEntry;
  }
}

function isProtected(item: MemoryItem): boolean {
  return CURATION_PROTECTED_SOURCES.has(item.source);
}
