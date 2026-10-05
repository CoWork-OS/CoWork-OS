import crypto from "crypto";
import type Database from "better-sqlite3";
import {
  LIKE_ESCAPE_CLAUSE,
  foldSearchText,
  likeContainsPattern,
  quoteFtsTerm,
  splitSearchTokens,
} from "../database/fts-query";

/**
 * The markdown memory index as synchronous SQL: the store the memory domain's transaction
 * units run (async SQLite migration plan, DB6), on the host connection or in the database
 * worker. The host lists and reads workspace files and applies task read guards; this
 * store chunks, redacts and embeds file content, writes the index in one transaction,
 * and runs the keyword and vector candidate searches. Parsed chunk embeddings are cached
 * per connection, so the cache lives where the queries run.
 * `MarkdownMemoryIndexService` is the async facade.
 */

const TARGET_CHUNK_CHARS = 800;
const MIN_CHUNK_CHARS = 220;
const OVERLAP_LINES = 2;
const VECTOR_DIMS = 256;
const MAX_SNIPPET_CHARS = 700;

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "by",
  "as",
  "at",
  "from",
  "that",
  "this",
  "it",
  "its",
  "into",
  "about",
  "over",
  "under",
  "we",
  "you",
  "they",
  "i",
  "he",
  "she",
  "them",
  "our",
  "your",
  "my",
  "me",
  "us",
  "do",
  "does",
  "did",
  "done",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "not",
  "no",
  "yes",
]);

const SENSITIVE_REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern:
      /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]+\b/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    pattern: /\bsk-[A-Za-z0-9]{16,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_ACCESS_KEY]",
  },
  {
    pattern:
      /((?:api[_-]?key|secret|password|passwd|token|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)([^"'\s]+)(["']?)/gi,
    replacement: "$1[REDACTED]$3",
  },
];

type MarkdownChunk = {
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
};

export type MarkdownFileEntry = {
  absPath: string;
  relPath: string;
  mtime: number;
  size: number;
};

export type KeywordCandidate = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  textScore: number;
  createdAt: number;
};

export type VectorCandidate = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  vectorScore: number;
  createdAt: number;
};

type ChunkRow = {
  id: string;
  workspace_id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  embedding: string;
  mtime: number;
  updated_at: number;
};

type ParsedChunkRow = {
  id: string;
  workspaceId: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  mtime: number;
  updatedAt: number;
};

const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Search tokens in any script (RECALL-9): lower-cased, Latin accents folded, split on
 * anything but letters, digits, marks, `_` and `-`. ASCII text tokenizes exactly as the
 * earlier ASCII-only dialect did, so stored local embeddings stay comparable; non-Latin
 * words are kept instead of being stripped. A one-character token is kept only for
 * Chinese, Japanese and Korean, where one character can be a word.
 */
export function tokenizeForMemorySearch(text: string): string[] {
  return splitSearchTokens(foldSearchText(text), 1).filter(
    (token) => (token.length > 1 || CJK_CHARACTER.test(token)) && !STOP_WORDS.has(token),
  );
}

/**
 * All query tokens (at most 8), each quoted with the shared FTS quoting, joined by AND.
 * The index's `unicode61` tokenizer folds case and diacritics, so folded tokens match.
 */
export function buildMarkdownFtsQuery(raw: string): string | null {
  const tokens = tokenizeForMemorySearch(raw).slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((token) => quoteFtsTerm(token)).join(" AND ");
}

export function chunkMarkdownForIndex(
  content: string,
): Array<{ startLine: number; endLine: number; text: string }> {
  if (!content.trim()) return [];

  const lines = content.split("\n");
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];
  let cursor = 0;

  while (cursor < lines.length) {
    let end = cursor;
    let chars = 0;

    while (end < lines.length) {
      const line = lines[end];
      chars += line.length + 1;
      const boundary = line.trim() === "" || line.trimStart().startsWith("#");
      end += 1;
      if (chars >= TARGET_CHARS_OR_MIN(boundary, chars)) {
        break;
      }
    }

    const safeEnd = Math.max(end, cursor + 1);
    const text = lines.slice(cursor, safeEnd).join("\n").trim();
    if (text) {
      chunks.push({
        startLine: cursor + 1,
        endLine: safeEnd,
        text,
      });
    }

    if (safeEnd >= lines.length) {
      break;
    }
    cursor = Math.max(cursor + 1, safeEnd - OVERLAP_LINES);
  }

  return chunks;
}

function TARGET_CHARS_OR_MIN(boundary: boolean, chars: number): number {
  if (chars >= TARGET_CHUNK_CHARS) {
    return TARGET_CHUNK_CHARS;
  }
  if (boundary && chars >= MIN_CHUNK_CHARS) {
    return MIN_CHUNK_CHARS;
  }
  return Number.MAX_SAFE_INTEGER;
}

export function hashText(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function hashToken(token: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export function createLocalEmbedding(text: string): number[] {
  const tokens = tokenizeForMemorySearch(text);
  if (tokens.length === 0) return Array(VECTOR_DIMS).fill(0);

  const vec = new Float32Array(VECTOR_DIMS);
  const tokenCounts = new Map<string, number>();

  for (const token of tokens) {
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }

  for (const [token, count] of tokenCounts.entries()) {
    const weight = 1 + Math.log1p(count);
    const hashA = hashToken(token, 2166136261);
    const hashB = hashToken(token, 2654435761);
    const idxA = hashA % VECTOR_DIMS;
    const idxB = hashB % VECTOR_DIMS;
    vec[idxA] += weight;
    vec[idxB] -= weight * 0.5;
  }

  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]}_${tokens[i + 1]}`;
    const hash = hashToken(bigram, 16777619);
    const idx = hash % VECTOR_DIMS;
    vec[idx] += 0.35;
  }

  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  if (norm <= 0) {
    return Array(VECTOR_DIMS).fill(0);
  }
  const invNorm = 1 / Math.sqrt(norm);
  for (let i = 0; i < vec.length; i++) {
    vec[i] *= invNorm;
  }

  return Array.from(vec);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const dims = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let i = 0; i < dims; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / Math.sqrt(aNorm * bNorm);
}

export function normalizeBm25Rank(rank: number): number {
  const safeRank = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + safeRank);
}

export function normalizeSnippet(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_SNIPPET_CHARS) return compact;
  return compact.slice(0, MAX_SNIPPET_CHARS - 3) + "...";
}

export function redactSensitiveMarkdownContent(text: string): string {
  if (!text) return "";
  let redacted = text;
  for (const { pattern, replacement } of SENSITIVE_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => (typeof value === "number" ? value : Number(value)))
      .filter((value) => Number.isFinite(value));
  } catch {
    return [];
  }
}

/** Token overlap of a query with a chunk, with phrase and path boosts; 0 to 1. */
export function computeMarkdownOverlapScore(
  query: string,
  relPath: string,
  snippet: string,
): number {
  const queryTokens = tokenizeForMemorySearch(query);
  if (queryTokens.length === 0) return 0;

  const snippetTokenSet = new Set(tokenizeForMemorySearch(snippet));
  let overlap = 0;
  for (const token of queryTokens) {
    if (snippetTokenSet.has(token)) overlap += 1;
  }
  const overlapScore = overlap / queryTokens.length;

  const lowerQuery = query.toLowerCase();
  const lowerSnippet = snippet.toLowerCase();
  const phraseBoost = lowerQuery && lowerSnippet.includes(lowerQuery) ? 0.2 : 0;

  const pathLower = relPath.toLowerCase();
  const pathHits = queryTokens.filter((token) => pathLower.includes(token)).length;
  const pathBoost = pathHits > 0 ? Math.min(0.15, pathHits / queryTokens.length) : 0;

  return Math.min(1, overlapScore + phraseBoost + pathBoost);
}
export interface MarkdownSyncPlan {
  workspaceId: string;
  now: number;
  metadataOnly: Array<Pick<MarkdownFileEntry, "relPath" | "mtime" | "size">>;
  reindex: Array<
    Pick<MarkdownFileEntry, "relPath" | "mtime" | "size"> & { content: string; contentHash: string }
  >;
  removedPaths: string[];
}

export interface IndexedChunkRow {
  id: string;
  workspace_id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  mtime: number;
  updated_at: number;
}

const parsedChunkCache = new WeakMap<
  Database.Database,
  Map<string, { signature: string; rows: ParsedChunkRow[] }>
>();

export class MarkdownIndexStore {
  private readonly ftsAvailable: boolean;

  constructor(private readonly db: Database.Database) {
    this.ftsAvailable = this.isFtsTableAvailable();
  }

  listIndexedFiles(
    workspaceId: string,
  ): Array<{ path: string; content_hash: string; mtime: number; size: number }> {
    return this.db
      .prepare(`
        SELECT path, content_hash, mtime, size
        FROM memory_markdown_files
        WHERE workspace_id = ?
      `)
      .all(workspaceId) as Array<{
      path: string;
      content_hash: string;
      mtime: number;
      size: number;
    }>;
  }

  /** Apply one sync: metadata updates, reindexed files and removals, atomically. */
  applySync(plan: MarkdownSyncPlan): boolean {
    let indexChanged = false;
    const updateMetadata = this.db.prepare(`
      UPDATE memory_markdown_files
      SET mtime = ?, size = ?, updated_at = ?
      WHERE workspace_id = ? AND path = ?
    `);
    for (const file of plan.metadataOnly) {
      updateMetadata.run(file.mtime, file.size, plan.now, plan.workspaceId, file.relPath);
    }
    for (const item of plan.reindex) {
      this.reindexFile(plan.workspaceId, item, item.content, item.contentHash, plan.now);
      indexChanged = true;
    }
    for (const relPath of plan.removedPaths) {
      this.deleteIndexedFile(plan.workspaceId, relPath);
      indexChanged = true;
    }
    if (indexChanged) parsedChunkCache.get(this.db)?.delete(plan.workspaceId);
    return indexChanged;
  }

  /** The newest indexed files, each with its first chunk. */
  recentFirstChunks(
    workspaceId: string,
    fileLimit: number,
  ): Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    mtime: number;
  }> {
    const files = this.db
      .prepare(`
        SELECT path, mtime
        FROM memory_markdown_files
        WHERE workspace_id = ?
        ORDER BY mtime DESC
        LIMIT ?
      `)
      .all(workspaceId, fileLimit) as Array<{ path: string; mtime: number }>;
    const getFirstChunk = this.db.prepare(`
      SELECT id, path, start_line, end_line, text, mtime
      FROM memory_markdown_chunks
      WHERE workspace_id = ? AND path = ?
      ORDER BY start_line ASC
      LIMIT 1
    `);
    const chunks: Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      mtime: number;
    }> = [];
    for (const file of files) {
      const chunk = getFirstChunk.get(workspaceId, file.path) as
        | (typeof chunks)[number]
        | undefined;
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  }

  clearWorkspace(workspaceId: string): void {
    this.db
      .prepare(`
        DELETE FROM memory_markdown_chunks
        WHERE workspace_id = ?
      `)
      .run(workspaceId);
    if (this.ftsAvailable) {
      this.db
        .prepare(`
          DELETE FROM memory_markdown_chunks_fts
          WHERE workspace_id = ?
        `)
        .run(workspaceId);
    }
    this.db
      .prepare(`
        DELETE FROM memory_markdown_files
        WHERE workspace_id = ?
      `)
      .run(workspaceId);
    parsedChunkCache.get(this.db)?.delete(workspaceId);
  }

  deletePaths(workspaceId: string, relPaths: string[]): number {
    for (const relPath of relPaths) this.deleteIndexedFile(workspaceId, relPath);
    if (relPaths.length > 0) parsedChunkCache.get(this.db)?.delete(workspaceId);
    return relPaths.length;
  }

  getChunk(chunkId: string): IndexedChunkRow | undefined {
    return this.db
      .prepare(`
        SELECT id, workspace_id, path, start_line, end_line, text, mtime, updated_at
        FROM memory_markdown_chunks
        WHERE id = ?
      `)
      .get(chunkId) as IndexedChunkRow | undefined;
  }

  chunksAround(
    workspaceId: string,
    relPath: string,
    startLine: number,
    limit: number,
  ): Array<{ id: string; text: string; start_line: number; end_line: number; mtime: number }> {
    return this.db
      .prepare(`
        SELECT id, text, start_line, end_line, mtime
        FROM memory_markdown_chunks
        WHERE workspace_id = ? AND path = ?
        ORDER BY ABS(start_line - ?) ASC
        LIMIT ?
      `)
      .all(workspaceId, relPath, startLine, limit) as Array<{
      id: string;
      text: string;
      start_line: number;
      end_line: number;
      mtime: number;
    }>;
  }

  getChunks(chunkIds: string[]): IndexedChunkRow[] {
    if (chunkIds.length === 0) return [];
    return this.db
      .prepare(`
        SELECT id, workspace_id, path, start_line, end_line, text, mtime, updated_at
        FROM memory_markdown_chunks
        WHERE id IN (SELECT value FROM json_each(?))
      `)
      .all(JSON.stringify(chunkIds)) as IndexedChunkRow[];
  }

  /** Keyword and vector candidates for one query, from one snapshot. */
  searchCandidates(
    workspaceId: string,
    query: string,
    limit: number,
  ): { keyword: KeywordCandidate[]; vector: VectorCandidate[] } {
    return {
      keyword: this.searchKeyword(workspaceId, query, limit),
      vector: this.searchVector(workspaceId, query, limit),
    };
  }

  private reindexFile(
    workspaceId: string,
    file: Pick<MarkdownFileEntry, "relPath" | "mtime" | "size">,
    content: string,
    contentHash: string,
    now: number,
  ): void {
    this.deleteIndexedFile(workspaceId, file.relPath);

    const chunkRows = chunkMarkdownForIndex(content);
    const chunks: MarkdownChunk[] = [];
    for (const chunk of chunkRows) {
      const redactedText = redactSensitiveMarkdownContent(chunk.text).trim();
      if (!redactedText) continue;
      chunks.push({
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: redactedText,
        embedding: createLocalEmbedding(redactedText),
      });
    }

    const insertChunk = this.db.prepare(`
      INSERT INTO memory_markdown_chunks (
        id, workspace_id, path, start_line, end_line, text, embedding, mtime, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.ftsAvailable
      ? this.db.prepare(`
          INSERT INTO memory_markdown_chunks_fts (
            text, chunk_id, workspace_id, path, start_line, end_line
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
      : null;

    for (const chunk of chunks) {
      const chunkId = hashText(
        `${workspaceId}:${file.relPath}:${chunk.startLine}:${chunk.endLine}:${contentHash}`,
      );
      insertChunk.run(
        chunkId,
        workspaceId,
        file.relPath,
        chunk.startLine,
        chunk.endLine,
        chunk.text,
        JSON.stringify(chunk.embedding),
        file.mtime,
        now,
      );
      if (insertFts) {
        insertFts.run(
          chunk.text,
          chunkId,
          workspaceId,
          file.relPath,
          chunk.startLine,
          chunk.endLine,
        );
      }
    }

    this.db
      .prepare(`
        INSERT INTO memory_markdown_files (workspace_id, path, content_hash, mtime, size, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, path) DO UPDATE SET
          content_hash = excluded.content_hash,
          mtime = excluded.mtime,
          size = excluded.size,
          updated_at = excluded.updated_at
      `)
      .run(workspaceId, file.relPath, contentHash, file.mtime, file.size, now);
  }

  private deleteIndexedFile(workspaceId: string, relPath: string): void {
    if (this.ftsAvailable) {
      this.db
        .prepare(`
          DELETE FROM memory_markdown_chunks_fts
          WHERE workspace_id = ? AND path = ?
        `)
        .run(workspaceId, relPath);
    }
    this.db
      .prepare(`
        DELETE FROM memory_markdown_chunks
        WHERE workspace_id = ? AND path = ?
      `)
      .run(workspaceId, relPath);
    this.db
      .prepare(`
        DELETE FROM memory_markdown_files
        WHERE workspace_id = ? AND path = ?
      `)
      .run(workspaceId, relPath);
  }

  private searchKeyword(workspaceId: string, query: string, limit: number): KeywordCandidate[] {
    if (!this.ftsAvailable) {
      return this.searchKeywordFallback(workspaceId, query, limit);
    }
    const ftsQuery = buildMarkdownFtsQuery(query);
    if (!ftsQuery) return this.searchKeywordFallback(workspaceId, query, limit);

    try {
      const rows = this.db
        .prepare(`
          SELECT
            memory_markdown_chunks_fts.chunk_id AS id,
            memory_markdown_chunks_fts.path AS path,
            memory_markdown_chunks_fts.start_line AS start_line,
            memory_markdown_chunks_fts.end_line AS end_line,
            memory_markdown_chunks_fts.text AS text,
            c.mtime AS mtime,
            bm25(memory_markdown_chunks_fts) AS rank
          FROM memory_markdown_chunks_fts
          JOIN memory_markdown_chunks c ON c.id = memory_markdown_chunks_fts.chunk_id
          WHERE memory_markdown_chunks_fts MATCH ?
            AND memory_markdown_chunks_fts.workspace_id = ?
          ORDER BY rank ASC
          LIMIT ?
        `)
        .all(ftsQuery, workspaceId, limit) as Array<{
        id: string;
        path: string;
        start_line: number;
        end_line: number;
        text: string;
        mtime: number;
        rank: number;
      }>;

      const mapped = rows.map((row, index) => ({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        snippet: normalizeSnippet(row.text),
        // Use row order for stability across varying bm25 scales/signs.
        textScore: normalizeBm25Rank(index),
        createdAt: row.mtime,
      }));
      // `unicode61` keeps a run of CJK characters as one token, so a word inside it only
      // matches by substring: try the LIKE fallback when FTS finds nothing for such text.
      if (mapped.length === 0 && /[^\p{Script=Latin}\p{N}\p{P}\s]/u.test(query)) {
        return this.searchKeywordFallback(workspaceId, query, limit);
      }
      return mapped;
    } catch {
      return this.searchKeywordFallback(workspaceId, query, limit);
    }
  }

  private searchKeywordFallback(
    workspaceId: string,
    query: string,
    limit: number,
  ): KeywordCandidate[] {
    const tokens = tokenizeForMemorySearch(query).slice(0, 8);
    const raw = query.trim();
    if (tokens.length === 0 && !raw) {
      return [];
    }

    const clauses: string[] = [];
    const params: unknown[] = [workspaceId];

    if (tokens.length > 0) {
      const tokenClauses = tokens.map(() => `text LIKE ? ${LIKE_ESCAPE_CLAUSE}`).join(" OR ");
      clauses.push(`(${tokenClauses})`);
      for (const token of tokens) {
        params.push(likeContainsPattern(token));
      }
    } else {
      clauses.push(`text LIKE ? ${LIKE_ESCAPE_CLAUSE}`);
      params.push(likeContainsPattern(raw));
    }

    params.push(limit * 4);

    const rows = this.db
      .prepare(`
        SELECT id, path, start_line, end_line, text, mtime
        FROM memory_markdown_chunks
        WHERE workspace_id = ? AND ${clauses.join(" AND ")}
        ORDER BY mtime DESC
        LIMIT ?
      `)
      .all(...params) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      mtime: number;
    }>;

    return rows
      .map((row) => ({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        snippet: normalizeSnippet(row.text),
        textScore: this.computeOverlapScore(query, row.path, row.text),
        createdAt: row.mtime,
      }))
      .sort((a, b) => b.textScore - a.textScore || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  private searchVector(workspaceId: string, query: string, limit: number): VectorCandidate[] {
    const queryEmbedding = createLocalEmbedding(query);
    if (queryEmbedding.every((value) => value === 0)) return [];

    const rows = this.getParsedChunksForWorkspace(workspaceId);

    return rows
      .map((row) => {
        const score = cosineSimilarity(queryEmbedding, row.embedding);
        return {
          id: row.id,
          path: row.path,
          startLine: row.startLine,
          endLine: row.endLine,
          snippet: normalizeSnippet(row.text),
          vectorScore: Number.isFinite(score) ? Math.max(0, score) : 0,
          createdAt: row.mtime,
        };
      })
      .sort((a, b) => b.vectorScore - a.vectorScore)
      .slice(0, limit);
  }

  private computeOverlapScore(query: string, relPath: string, snippet: string): number {
    return computeMarkdownOverlapScore(query, relPath, snippet);
  }

  private getChunkSignature(workspaceId: string): string {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS max_updated
        FROM memory_markdown_chunks
        WHERE workspace_id = ?
      `)
      .get(workspaceId) as { count: number; max_updated: number } | undefined;
    if (!row) {
      return `${workspaceId}:0:0`;
    }
    return `${workspaceId}:${row.count}:${row.max_updated}`;
  }

  private getParsedChunksForWorkspace(workspaceId: string): ParsedChunkRow[] {
    const signature = this.getChunkSignature(workspaceId);
    let byWorkspace = parsedChunkCache.get(this.db);
    if (!byWorkspace) {
      byWorkspace = new Map();
      parsedChunkCache.set(this.db, byWorkspace);
    }
    const cached = byWorkspace.get(workspaceId);
    if (cached && cached.signature === signature) {
      return cached.rows;
    }

    const rows = this.db
      .prepare(`
        SELECT id, workspace_id, path, start_line, end_line, text, embedding, mtime, updated_at
        FROM memory_markdown_chunks
        WHERE workspace_id = ?
      `)
      .all(workspaceId) as ChunkRow[];

    const parsed: ParsedChunkRow[] = rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      embedding: parseEmbedding(row.embedding),
      mtime: row.mtime,
      updatedAt: row.updated_at,
    }));

    byWorkspace.set(workspaceId, {
      signature,
      rows: parsed,
    });

    return parsed;
  }

  private isFtsTableAvailable(): boolean {
    try {
      const row = this.db
        .prepare(`
          SELECT 1
          FROM sqlite_master
          WHERE type = 'table' AND name = 'memory_markdown_chunks_fts'
          LIMIT 1
        `)
        .get() as Record<string, unknown> | undefined;
      return Boolean(row);
    } catch {
      return false;
    }
  }
}
