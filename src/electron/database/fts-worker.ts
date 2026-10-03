import { parentPort, workerData } from "worker_threads";
import Database from "better-sqlite3";
import {
  sanitizeFtsToken,
  isSafeFtsToken,
  buildMarkerFtsQuery,
  buildRelaxedTokenFtsQuery,
  buildImportedMemoryFilterSql,
} from "./fts-utils";
import {
  type EmbeddingInvalidation,
  findMissingEmbeddingRows,
  MemoryEmbeddingCache,
} from "../memory/memory-embedding-cache";
import { type HybridCandidateRow, rankHybridMemories } from "../memory/memory-hybrid-rank";
import { buildAgentVisibleMemorySql } from "../memory/memory-visibility";

interface FtsRequest {
  method:
    | "search"
    | "searchImportedGlobal"
    | "searchLocalForPromptRecall"
    | "searchByContentMarker"
    | "hybridSearch"
    | "findMissingEmbeddings"
    | "invalidateEmbeddings";
  /** Absent for notifications, which get no reply. */
  id?: string;
  args: unknown[];
}

interface FtsResponse {
  id: string;
  result?: unknown;
  error?: string;
}

const db = new Database(workerData.dbPath, { readonly: true });
db.pragma("busy_timeout = 5000");

function truncateToSnippet(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text || "";
  return text.slice(0, maxLen) + "...";
}

function search(
  workspaceId: string,
  query: string,
  limit: number,
  includePrivate: boolean,
): unknown[] {
  const privacyFilter = includePrivate ? "" : "AND m.is_private = 0";
  const raw = (query || "").trim();
  if (!raw) return [];

  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const ftsQuery = buildRelaxedTokenFtsQuery(tokens);
  if (!ftsQuery) return [];

  try {
    const stmt = db.prepare(`
      SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id,
             bm25(memories_fts) as score
      FROM memories_fts f
      JOIN memories m ON f.rowid = m.rowid
      WHERE memories_fts MATCH ? AND m.workspace_id = ? ${privacyFilter}
        AND ${buildAgentVisibleMemorySql("m.id")}
      ORDER BY score
      LIMIT ?
    `);
    const rows = stmt.all(ftsQuery, workspaceId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id,
      snippet: (row.summary as string) || truncateToSnippet(row.content as string, 200),
      content: row.content,
      type: row.type,
      relevanceScore: Math.abs(row.score as number),
      createdAt: row.created_at,
      taskId: (row.task_id as string) || undefined,
      source: "db",
    }));
  } catch {
    return [];
  }
}

function searchImportedGlobal(query: string, limit: number, includePrivate: boolean): unknown[] {
  const raw = (query || "").trim();
  if (!raw) return [];

  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const ftsQuery = buildRelaxedTokenFtsQuery(tokens);
  if (!ftsQuery) return [];

  // Imported rows are searched across workspaces, so private ones never are: the
  // owning workspace still finds them through its local lane. `includePrivate` is kept
  // for the call signature only.
  void includePrivate;

  try {
    const stmt = db.prepare(`
      SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id,
             bm25(memories_fts) as score
      FROM memories_fts f
      JOIN memories m ON f.rowid = m.rowid
      WHERE memories_fts MATCH ? AND ${buildImportedMemoryFilterSql("m.content")}
        AND m.is_private = 0 AND ${buildAgentVisibleMemorySql("m.id")}
      ORDER BY score
      LIMIT ?
    `);
    const rows = stmt.all(ftsQuery, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id,
      snippet: (row.summary as string) || truncateToSnippet(row.content as string, 200),
      content: row.content,
      type: row.type,
      relevanceScore: Math.abs(row.score as number),
      createdAt: row.created_at,
      taskId: (row.task_id as string) || undefined,
      source: "db",
    }));
  } catch {
    return [];
  }
}

function searchLocalForPromptRecall(workspaceId: string, query: string, limit: number): unknown[] {
  const raw = (query || "").trim();
  if (!raw) return [];

  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 5);

  const ftsQuery = buildRelaxedTokenFtsQuery(tokens);
  if (!ftsQuery) return [];

  try {
    const stmt = db.prepare(`
      SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id,
             bm25(memories_fts) as score
      FROM memories_fts f
      JOIN memories m ON f.rowid = m.rowid
      WHERE memories_fts MATCH ? AND m.workspace_id = ? AND m.is_private = 0
        AND ${buildAgentVisibleMemorySql("m.id")}
      ORDER BY score
      LIMIT ?
    `);
    const rows = stmt.all(ftsQuery, workspaceId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id,
      snippet: (row.summary as string) || truncateToSnippet(row.content as string, 200),
      type: row.type,
      relevanceScore: Math.abs(row.score as number),
      createdAt: row.created_at,
      taskId: (row.task_id as string) || undefined,
      source: "db",
    }));
  } catch {
    return [];
  }
}

function searchByContentMarker(workspaceId: string, marker: string, limit: number): unknown[] {
  const ftsQuery = buildMarkerFtsQuery(marker);
  if (ftsQuery) {
    try {
      const stmt = db.prepare(`
        SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id
        FROM memories_fts f
        JOIN memories m ON f.rowid = m.rowid
        WHERE memories_fts MATCH ? AND m.workspace_id = ? AND m.is_private = 0
        ORDER BY m.created_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(ftsQuery, workspaceId, limit) as Record<string, unknown>[];
      if (rows.length > 0) {
        return rows.map((row) => ({
          id: row.id,
          snippet: (row.summary as string) || truncateToSnippet(row.content as string, 200),
          type: row.type,
          relevanceScore: 1,
          createdAt: row.created_at,
          taskId: (row.task_id as string) || undefined,
          source: "db",
        }));
      }
    } catch {
      // fall through to LIKE
    }
  }

  const stmt = db.prepare(`
    SELECT id, summary, content, type, created_at, task_id
    FROM memories
    WHERE workspace_id = ? AND is_private = 0 AND (content LIKE ? OR summary LIKE ?)
    ORDER BY created_at DESC
    LIMIT ?
  `);
  const like = `%${marker}%`;
  const rows = stmt.all(workspaceId, like, like, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id,
    snippet: (row.summary as string) || truncateToSnippet(row.content as string, 200),
    type: row.type,
    relevanceScore: 1,
    createdAt: row.created_at,
    taskId: (row.task_id as string) || undefined,
    source: "db",
  }));
}

const embeddingCache = new MemoryEmbeddingCache(db);

/**
 * Full rows for hybrid candidates that the agent may see: this workspace's rows (private
 * only when asked) and other workspaces' non-private imported rows, never a suppressed
 * or redacted one. Semantic candidates come from the embedding caches, which do not
 * track privacy, so this is where it is enforced.
 */
function loadMemoryRows(
  ids: string[],
  workspaceId: string,
  includePrivate: boolean,
): HybridCandidateRow[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, summary, content, type, created_at, task_id
       FROM memories
       WHERE id IN (${ids.map(() => "?").join(", ")})
         AND ((workspace_id = ? ${includePrivate ? "" : "AND is_private = 0"})
              OR (${buildImportedMemoryFilterSql("content")} AND is_private = 0))
         AND ${buildAgentVisibleMemorySql("memories.id")}`,
    )
    .all(...ids, workspaceId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    summary: (row.summary as string) || undefined,
    content: (row.content as string) || "",
    type: row.type as string,
    createdAt: row.created_at as number,
    taskId: (row.task_id as string) || undefined,
  }));
}

/**
 * The whole hybrid memory search (DB4): lexical candidates, the semantic scan over this
 * worker's embedding cache, and the full-row rerank, the same stages the host's
 * synchronous search runs.
 */
function hybridSearch(
  workspaceId: string,
  query: string,
  limit: number,
  includePrivate: boolean,
): unknown[] {
  const lexicalLimit = Math.min(Math.max(limit, 5), 50);
  const lexicalLocal = search(workspaceId, query, lexicalLimit, includePrivate) as Array<{
    id: string;
  }>;
  const lexicalImported = searchImportedGlobal(query, lexicalLimit, includePrivate) as Array<{
    id: string;
  }>;
  return rankHybridMemories({
    query,
    limit,
    lexicalLocal,
    lexicalImportedGlobal: lexicalImported,
    workspaceEmbeddings: embeddingCache.workspace(workspaceId).entries(),
    importedEmbeddings: embeddingCache.importedGlobal().entries(),
    loadRows: (ids) => loadMemoryRows(ids, workspaceId, includePrivate),
  });
}

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  findMissingEmbeddings: (wid, lim) =>
    findMissingEmbeddingRows(
      db,
      wid as string | null,
      Math.min(Math.max(Number(lim) || 1, 1), 1_000),
    ),
  hybridSearch: (wid, q, lim, priv) =>
    hybridSearch(wid as string, q as string, lim as number, priv as boolean),
  invalidateEmbeddings: (...changes) => {
    for (const change of changes) embeddingCache.invalidate(change as EmbeddingInvalidation);
    return null;
  },
  search: (wid, q, lim, priv) => search(wid as string, q as string, lim as number, priv as boolean),
  searchImportedGlobal: (q, lim, priv) =>
    searchImportedGlobal(q as string, lim as number, priv as boolean),
  searchLocalForPromptRecall: (wid, q, lim) =>
    searchLocalForPromptRecall(wid as string, q as string, lim as number),
  searchByContentMarker: (wid, m, lim) =>
    searchByContentMarker(wid as string, m as string, lim as number),
};

parentPort?.on("message", (msg: FtsRequest) => {
  const handler = handlers[msg.method];
  if (msg.id === undefined) {
    try {
      handler?.(...msg.args);
    } catch {
      // Notifications have no reply; a failed invalidation is repaired by the periodic reload.
    }
    return;
  }
  if (!handler) {
    parentPort?.postMessage({
      id: msg.id,
      error: `Unknown method: ${msg.method}`,
    } satisfies FtsResponse);
    return;
  }
  try {
    const result = handler(...msg.args);
    parentPort?.postMessage({ id: msg.id, result } satisfies FtsResponse);
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: String(err) } satisfies FtsResponse);
  }
});
