import type Database from "better-sqlite3";
import { buildFtsMatchQuery, extractFtsTerms, termCoverage } from "../database/fts-query";
import { MemoryItemsStore } from "./memory-items-sql";
import type { MemoryItem, MemoryItemKind, MemoryItemScope } from "./memory-items-types";

/**
 * The `memory` lane of MemoryRecall (docs/memory-engine.md §4): lexical search over the
 * active `memory_items` a surface may see. Runs as one read unit, in the database worker
 * when memory is routed there.
 *
 * Visibility is decided here, once, in SQL:
 *  - only `active`, unexpired items;
 *  - global items, the workspace's own items, the active task's task-scoped items and,
 *    only when the surface handles that contact, the contact's items — never another
 *    workspace's items;
 *  - `private` items only when the caller asks for them (Memory Hub), or the handled
 *    contact's own items (third-party text is private by default);
 *  - a minimum trust, so `third_party` text stays out unless the caller lowers it.
 */

export interface MemoryItemRecallRequest {
  /** The workspace whose items are visible (plus global items); null = global items only. */
  workspaceId: string | null;
  /** Free text; empty lists items instead (pinned, trusted and recent first). */
  query: string;
  /** Active task: its task-scoped items become visible. */
  taskId?: string | null;
  /** Contact the surface handles: its contact-scoped items become visible. */
  contactRef?: string | null;
  kinds?: MemoryItemKind[];
  scopes?: MemoryItemScope[];
  /** Lowest trust admitted (0..1). */
  minTrust?: number;
  includePrivate?: boolean;
  /** Restrict to these item ids (expansion of earlier results). */
  ids?: string[];
  limit: number;
  /** Epoch ms used for the expiry check. */
  now: number;
}

export interface MemoryItemRecallRow {
  item: MemoryItem;
  /** Lexical relevance, higher is better; 0 for listing and id lookups. */
  lexical: number;
  /** Share of query terms found in the item (0..1). */
  coverage: number;
}

const MAX_LIMIT = 100;

function inList(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

export class MemoryRecallStore {
  constructor(private readonly db: Database.Database) {}

  searchItems(request: MemoryItemRecallRequest): MemoryItemRecallRow[] {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(request.limit)));
    const { clause, params } = this.visibility(request);
    const ids = (request.ids ?? []).filter(Boolean);
    if (ids.length > 0) {
      return this.load(
        this.db
          .prepare(
            `SELECT mi.id AS id, 0 AS lexical FROM memory_items mi
             WHERE ${clause} AND mi.id IN (${inList(ids)})
             LIMIT ?`,
          )
          .all(...params, ...ids, limit) as Array<{ id: string; lexical: number }>,
        request.query,
      );
    }

    const query = String(request.query || "").trim();
    if (!query) {
      return this.load(
        this.db
          .prepare(
            `SELECT mi.id AS id, 0 AS lexical FROM memory_items mi
             WHERE ${clause}
             ORDER BY mi.pinned DESC, mi.trust DESC, mi.confidence DESC, mi.updated_at DESC
             LIMIT ?`,
          )
          .all(...params, limit) as Array<{ id: string; lexical: number }>,
        "",
      );
    }

    const found = new Map<string, number>();
    try {
      // Precision first (every term, prefix-aware), then fill with any-term matches.
      for (const mode of ["all", "any"] as const) {
        if (found.size >= limit) break;
        const match = buildFtsMatchQuery(query, { mode, prefix: true });
        if (!match) break;
        const rows = this.db
          .prepare(
            `SELECT mi.id AS id, -bm25(memory_items_fts) AS lexical
             FROM memory_items_fts f
             JOIN memory_items mi ON mi.rowid = f.rowid
             WHERE memory_items_fts MATCH ? AND ${clause}
             ORDER BY bm25(memory_items_fts)
             LIMIT ?`,
          )
          .all(match, ...params, limit) as Array<{ id: string; lexical: number }>;
        for (const row of rows) {
          if (!found.has(row.id)) found.set(row.id, Number(row.lexical) || 0);
        }
      }
    } catch {
      // FTS5 unavailable (custom SQLite build): fall back to term matching below.
      found.clear();
      return this.likeSearch(query, clause, params, limit);
    }
    return this.load(
      [...found.entries()].map(([id, lexical]) => ({ id, lexical })),
      query,
    );
  }

  private likeSearch(
    query: string,
    clause: string,
    params: unknown[],
    limit: number,
  ): MemoryItemRecallRow[] {
    const terms = extractFtsTerms(query, { maxTerms: 8 });
    if (terms.length === 0) return [];
    const termClause = terms.map(() => "lower(mi.content) LIKE ? ESCAPE '\\'").join(" OR ");
    const termParams = terms.map(
      (term) => `%${term.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`,
    );
    const rows = this.db
      .prepare(
        `SELECT mi.id AS id, 0 AS lexical FROM memory_items mi
         WHERE ${clause} AND (${termClause})
         ORDER BY mi.trust DESC, mi.updated_at DESC
         LIMIT ?`,
      )
      .all(...params, ...termParams, limit * 3) as Array<{ id: string; lexical: number }>;
    return this.load(rows, query)
      .map((row) => ({ ...row, lexical: row.coverage }))
      .sort((a, b) => b.lexical - a.lexical)
      .slice(0, limit);
  }

  private load(rows: Array<{ id: string; lexical: number }>, query: string): MemoryItemRecallRow[] {
    const store = new MemoryItemsStore(this.db);
    const terms = query ? extractFtsTerms(query, { maxTerms: 24 }) : [];
    const result: MemoryItemRecallRow[] = [];
    for (const row of rows) {
      const item = store.findById(row.id);
      if (!item) continue;
      result.push({
        item,
        lexical: Number(row.lexical) || 0,
        coverage: terms.length > 0 ? termCoverage(`${item.content} ${item.subjectKey}`, terms) : 0,
      });
    }
    return result;
  }

  /** The one visibility predicate of the memory lane (see the file comment). */
  private visibility(request: MemoryItemRecallRequest): { clause: string; params: unknown[] } {
    const where: string[] = [
      "mi.status = 'active'",
      "(mi.expires_at IS NULL OR mi.expires_at > ?)",
    ];
    const params: unknown[] = [request.now];
    const scopeParts: string[] = ["(mi.scope = 'global' AND mi.workspace_id IS NULL)"];
    const workspaceId = request.workspaceId || null;
    if (workspaceId) {
      scopeParts.push("(mi.scope = 'workspace' AND mi.workspace_id = ?)");
      params.push(workspaceId);
      if (request.taskId) {
        scopeParts.push("(mi.scope = 'task' AND mi.workspace_id = ? AND mi.scope_ref = ?)");
        params.push(workspaceId, request.taskId);
      }
    }
    if (request.contactRef) {
      scopeParts.push(
        workspaceId
          ? "(mi.scope = 'contact' AND mi.scope_ref = ? AND (mi.workspace_id IS NULL OR mi.workspace_id = ?))"
          : "(mi.scope = 'contact' AND mi.scope_ref = ? AND mi.workspace_id IS NULL)",
      );
      params.push(request.contactRef);
      if (workspaceId) params.push(workspaceId);
    }
    where.push(`(${scopeParts.join(" OR ")})`);
    if (request.kinds?.length) {
      where.push(`mi.kind IN (${inList(request.kinds)})`);
      params.push(...request.kinds);
    }
    if (request.scopes?.length) {
      where.push(`mi.scope IN (${inList(request.scopes)})`);
      params.push(...request.scopes);
    }
    if (!request.includePrivate) {
      // Third-party text is private by default; the surface handling that contact sees it.
      if (request.contactRef) {
        where.push("(mi.privacy = 'normal' OR (mi.scope = 'contact' AND mi.scope_ref = ?))");
        params.push(request.contactRef);
      } else {
        where.push("mi.privacy = 'normal'");
      }
    }
    if (typeof request.minTrust === "number" && request.minTrust > 0) {
      where.push("mi.trust >= ?");
      params.push(request.minTrust);
    }
    return { clause: where.join(" AND "), params };
  }
}
