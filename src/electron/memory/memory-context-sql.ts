import type Database from "better-sqlite3";
import { defineReadUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import {
  bool,
  int,
  list,
  nullableStr,
  oneOf,
  record,
  tuple,
} from "../database/statements/unit-args";
import { buildFtsMatchQuery, extractFtsTerms, likeContainsPattern } from "../database/fts-query";
import { MemoryItemsStore } from "./memory-items-sql";
import { MEMORY_ITEM_KINDS, type MemoryItem, type MemoryItemKind } from "./memory-items-types";

/**
 * L1 recall over `memory_items` for MemoryContextBuilder (docs/memory-engine.md §4): the
 * active, user-owned items of a workspace (plus global items) that match the step's
 * query, best match first. One memory-domain read unit; in the database worker when
 * memory is routed there.
 *
 * Scope filter applied here, once: `global` and the workspace's `workspace` items only.
 * Contact (third-party) and task scopes, `third_party` provenance and, unless allowed,
 * private items never match.
 */
export interface MemoryItemContextSearchRequest {
  workspaceId: string | null;
  query: string;
  includePrivate: boolean;
  kinds?: MemoryItemKind[];
  limit: number;
}

const MAX_LIMIT = 50;

export function searchMemoryItemsForContext(
  db: Database.Database,
  request: MemoryItemContextSearchRequest,
): MemoryItem[] {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(request.limit)));
  const where = [
    "m.status = 'active'",
    "m.source <> 'third_party'",
    "(m.scope = 'global' OR (m.scope = 'workspace' AND m.workspace_id = ?))",
  ];
  const params: unknown[] = [request.workspaceId ?? ""];
  if (!request.includePrivate) where.push("m.privacy = 'normal'");
  if (request.kinds?.length) {
    where.push(`m.kind IN (${request.kinds.map(() => "?").join(", ")})`);
    params.push(...request.kinds);
  }

  let ids: string[] = [];
  const match = buildFtsMatchQuery(request.query, { mode: "any", prefix: true, maxTerms: 12 });
  if (!match) return [];
  try {
    ids = (
      db
        .prepare(
          `SELECT m.id FROM memory_items_fts f
           JOIN memory_items m ON m.rowid = f.rowid
           WHERE memory_items_fts MATCH ? AND ${where.join(" AND ")}
           ORDER BY bm25(memory_items_fts), m.trust DESC, m.updated_at DESC
           LIMIT ?`,
        )
        .all(match, ...params, limit) as Array<{ id: string }>
    ).map((row) => row.id);
  } catch {
    // No FTS5 in this SQLite build: match any term with LIKE, newest and most trusted first.
    const terms = extractFtsTerms(request.query, { maxTerms: 6, minTermLength: 3 });
    if (terms.length === 0) return [];
    const likeClause = terms.map(() => "m.content LIKE ? ESCAPE '\\'").join(" OR ");
    ids = (
      db
        .prepare(
          `SELECT m.id FROM memory_items m
           WHERE (${likeClause}) AND ${where.join(" AND ")}
           ORDER BY m.trust DESC, m.updated_at DESC
           LIMIT ?`,
        )
        .all(...terms.map((term) => likeContainsPattern(term)), ...params, limit) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  }
  const store = new MemoryItemsStore(db);
  return ids
    .map((id) => store.findById(id))
    .filter((item): item is MemoryItem => item !== undefined);
}

function contextSearchRequest(value: unknown, path = "args[0]"): MemoryItemContextSearchRequest {
  const input = record(value, path);
  const field = (name: string) => `${path}.${name}`;
  return {
    workspaceId: nullableStr(input.workspaceId, field("workspaceId"), 512),
    query: String(nullableStr(input.query, field("query"), 4000) ?? ""),
    includePrivate: bool(input.includePrivate, field("includePrivate")),
    kinds:
      input.kinds === undefined || input.kinds === null
        ? undefined
        : list(
            input.kinds,
            field("kinds"),
            (entry, entryPath) => oneOf(entry, entryPath, MEMORY_ITEM_KINDS),
            20,
          ),
    limit: int(input.limit, field("limit"), 1, MAX_LIMIT),
  };
}

export const MEMORY_CONTEXT_UNITS = {
  memoryItems_contextSearch: defineReadUnit(
    tuple(contextSearchRequest),
    (db: Database.Database, [request]) => searchMemoryItemsForContext(db, request),
  ),
} satisfies UnitCatalog;
