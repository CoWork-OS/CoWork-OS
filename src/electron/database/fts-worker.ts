import { parentPort, workerData } from "worker_threads";
import Database from "better-sqlite3";
import { sanitizeFtsToken, isSafeFtsToken, buildMarkerFtsQuery, buildRelaxedTokenFtsQuery } from "./fts-utils";

interface FtsRequest {
  id: string;
  method: "search" | "searchImportedGlobal" | "searchLocalForPromptRecall" | "searchByContentMarker";
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


function search(workspaceId: string, query: string, limit: number, includePrivate: boolean): unknown[] {
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

  const privacyFilter = includePrivate ? "" : "AND m.is_private = 0";

  try {
    const stmt = db.prepare(`
      SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id,
             bm25(memories_fts) as score
      FROM memories_fts f
      JOIN memories m ON f.rowid = m.rowid
      WHERE memories_fts MATCH ? AND m.is_imported = 1 ${privacyFilter}
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

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  search: (wid, q, lim, priv) => search(wid as string, q as string, lim as number, priv as boolean),
  searchImportedGlobal: (q, lim, priv) => searchImportedGlobal(q as string, lim as number, priv as boolean),
  searchLocalForPromptRecall: (wid, q, lim) => searchLocalForPromptRecall(wid as string, q as string, lim as number),
  searchByContentMarker: (wid, m, lim) => searchByContentMarker(wid as string, m as string, lim as number),
};

parentPort?.on("message", (msg: FtsRequest) => {
  const handler = handlers[msg.method];
  if (!handler) {
    parentPort?.postMessage({ id: msg.id, error: `Unknown method: ${msg.method}` } satisfies FtsResponse);
    return;
  }
  try {
    const result = handler(...msg.args);
    parentPort?.postMessage({ id: msg.id, result } satisfies FtsResponse);
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: String(err) } satisfies FtsResponse);
  }
});
