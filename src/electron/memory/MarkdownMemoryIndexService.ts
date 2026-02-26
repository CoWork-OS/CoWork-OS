import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { estimateTokens } from "../agent/context-manager";
import type { Memory, MemorySearchResult, MemoryTimelineEntry } from "../database/repositories";

const SYNC_DEBOUNCE_MS = 15000;
const MAX_INDEXED_FILE_BYTES = 2 * 1024 * 1024;
const TARGET_CHUNK_CHARS = 800;
const MIN_CHUNK_CHARS = 220;
const OVERLAP_LINES = 2;
const VECTOR_DIMS = 256;
const MAX_SNIPPET_CHARS = 700;
const SEARCH_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_VECTOR_WEIGHT = 0.55;
const DEFAULT_TEXT_WEIGHT = 0.45;
const ASYNC_SYNC_DELAY_MS = 250;
const ASYNC_SYNC_MAX_DELAY_MS = 1500;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
  "release",
]);

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

type MarkdownFileEntry = {
  absPath: string;
  relPath: string;
  mtime: number;
  size: number;
};

type KeywordCandidate = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  textScore: number;
  createdAt: number;
};

type VectorCandidate = {
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

export function tokenizeForMemorySearch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function buildMarkdownFtsQuery(raw: string): string | null {
  const tokens = tokenizeForMemorySearch(raw).slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" AND ");
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

function hashText(input: string): string {
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

function createLocalEmbedding(text: string): number[] {
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

function cosineSimilarity(a: number[], b: number[]): number {
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

function normalizeBm25Rank(rank: number): number {
  const safeRank = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + safeRank);
}

function normalizeSnippet(text: string): string {
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

function parseEmbedding(raw: string): number[] {
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

export class MarkdownMemoryIndexService {
  private readonly lastSyncByWorkspace = new Map<string, number>();
  private readonly ftsAvailable: boolean;
  private readonly pendingSyncByWorkspace = new Map<string, Promise<void>>();
  private readonly scheduledSyncByWorkspace = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly syncGenerationByWorkspace = new Map<string, number>();
  private readonly parsedChunkCacheByWorkspace = new Map<
    string,
    {
      signature: string;
      rows: ParsedChunkRow[];
    }
  >();

  constructor(private readonly db: Database.Database) {
    this.ftsAvailable = this.isFtsTableAvailable();
  }

  search(
    workspaceId: string,
    workspacePath: string,
    query: string,
    limit = 10,
  ): MemorySearchResult[] {
    if (limit <= 0) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    this.scheduleSync(workspaceId, workspacePath);

    const candidateLimit = Math.max(limit, limit * SEARCH_CANDIDATE_MULTIPLIER);
    const keyword = this.searchKeyword(workspaceId, trimmed, candidateLimit);
    const vector = this.searchVector(workspaceId, trimmed, candidateLimit);

    return this.mergeAndRerank(trimmed, keyword, vector)
      .slice(0, limit)
      .map((candidate) => ({
        id: `md:${candidate.id}`,
        snippet: candidate.snippet,
        type: "summary",
        relevanceScore: candidate.score,
        createdAt: candidate.createdAt,
        source: "markdown",
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
      }));
  }

  getRecentSnippets(workspaceId: string, workspacePath: string, limit = 3): MemorySearchResult[] {
    if (limit <= 0) return [];
    this.scheduleSync(workspaceId, workspacePath);

    const files = this.db
      .prepare(`
        SELECT path, mtime
        FROM memory_markdown_files
        WHERE workspace_id = ?
        ORDER BY mtime DESC
        LIMIT ?
      `)
      .all(workspaceId, limit) as Array<{ path: string; mtime: number }>;

    const getFirstChunk = this.db.prepare(`
      SELECT id, path, start_line, end_line, text, mtime
      FROM memory_markdown_chunks
      WHERE workspace_id = ? AND path = ?
      ORDER BY start_line ASC
      LIMIT 1
    `);

    const results: MemorySearchResult[] = [];
    for (const file of files) {
      const chunk = getFirstChunk.get(workspaceId, file.path) as
        | {
            id: string;
            path: string;
            start_line: number;
            end_line: number;
            text: string;
            mtime: number;
          }
        | undefined;
      if (!chunk) continue;
      results.push({
        id: `md:${chunk.id}`,
        snippet: normalizeSnippet(chunk.text),
        type: "summary",
        relevanceScore: 0.5,
        createdAt: chunk.mtime,
        source: "markdown",
        path: chunk.path,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
      });
    }
    return results;
  }

  scheduleSync(workspaceId: string, workspacePath: string, force = false): void {
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      return;
    }

    if (this.pendingSyncByWorkspace.has(workspaceId)) {
      return;
    }

    if (this.scheduledSyncByWorkspace.has(workspaceId)) {
      return;
    }

    const now = Date.now();
    const lastSync = this.lastSyncByWorkspace.get(workspaceId) ?? 0;
    const elapsed = now - lastSync;
    const delay = force
      ? 0
      : elapsed >= SYNC_DEBOUNCE_MS
        ? ASYNC_SYNC_DELAY_MS
        : Math.min(ASYNC_SYNC_MAX_DELAY_MS, SYNC_DEBOUNCE_MS - elapsed);
    const generation = this.getSyncGeneration(workspaceId);

    const timer = setTimeout(() => {
      this.scheduledSyncByWorkspace.delete(workspaceId);
      this.enqueueSync(workspaceId, workspacePath, force, generation);
    }, delay);
    this.scheduledSyncByWorkspace.set(workspaceId, timer);
  }

  async syncWorkspace(
    workspaceId: string,
    workspacePath: string,
    force = false,
    generation?: number,
  ): Promise<void> {
    if (generation !== undefined && generation !== this.getSyncGeneration(workspaceId)) {
      return;
    }
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      return;
    }

    const now = Date.now();
    const lastSync = this.lastSyncByWorkspace.get(workspaceId) ?? 0;
    if (!force && now - lastSync < SYNC_DEBOUNCE_MS) {
      return;
    }
    this.lastSyncByWorkspace.set(workspaceId, now);

    try {
      const discoveredFiles = await this.listMarkdownFiles(workspacePath);
      if (generation !== undefined && generation !== this.getSyncGeneration(workspaceId)) {
        return;
      }
      const discoveredPaths = new Set(discoveredFiles.map((file) => file.relPath));

      const existing = this.db
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
      const existingByPath = new Map(existing.map((row) => [row.path, row]));

      const metadataOnlyUpdates: MarkdownFileEntry[] = [];
      const filesToReindex: Array<{
        file: MarkdownFileEntry;
        content: string;
        contentHash: string;
      }> = [];

      for (const file of discoveredFiles) {
        if (generation !== undefined && generation !== this.getSyncGeneration(workspaceId)) {
          return;
        }

        const previous = existingByPath.get(file.relPath);
        if (previous && previous.mtime === file.mtime && previous.size === file.size) {
          continue;
        }

        let content = "";
        try {
          content = await fs.promises.readFile(file.absPath, "utf-8");
        } catch {
          continue;
        }
        const contentHash = hashText(content);

        if (previous && previous.content_hash === contentHash) {
          metadataOnlyUpdates.push(file);
          continue;
        }

        filesToReindex.push({
          file,
          content,
          contentHash,
        });
      }

      if (generation !== undefined && generation !== this.getSyncGeneration(workspaceId)) {
        return;
      }

      const removedPaths = existing
        .filter((row) => !discoveredPaths.has(row.path))
        .map((row) => row.path);

      let indexChanged = false;
      this.db.exec("BEGIN");
      try {
        const updateMetadata = this.db.prepare(`
          UPDATE memory_markdown_files
          SET mtime = ?, size = ?, updated_at = ?
          WHERE workspace_id = ? AND path = ?
        `);

        for (const file of metadataOnlyUpdates) {
          updateMetadata.run(file.mtime, file.size, now, workspaceId, file.relPath);
        }

        for (const item of filesToReindex) {
          this.reindexFile(workspaceId, item.file, item.content, item.contentHash, now);
          indexChanged = true;
        }

        for (const relPath of removedPaths) {
          this.deleteIndexedFile(workspaceId, relPath);
          indexChanged = true;
        }

        this.db.exec("COMMIT");
        if (indexChanged) {
          this.parsedChunkCacheByWorkspace.delete(workspaceId);
        }
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      console.warn("[MarkdownMemoryIndexService] Failed to sync markdown index:", error);
    }
  }

  clearWorkspace(workspaceId: string): void {
    this.bumpSyncGeneration(workspaceId);
    const timer = this.scheduledSyncByWorkspace.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.scheduledSyncByWorkspace.delete(workspaceId);
    }
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
    this.parsedChunkCacheByWorkspace.delete(workspaceId);
    this.lastSyncByWorkspace.delete(workspaceId);
  }

  cleanupMissingFiles(workspaceId: string, workspacePath: string): number {
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      return 0;
    }

    const indexed = this.db
      .prepare(`
        SELECT path
        FROM memory_markdown_files
        WHERE workspace_id = ?
      `)
      .all(workspaceId) as Array<{ path: string }>;

    if (indexed.length === 0) {
      return 0;
    }

    let removed = 0;
    this.db.exec("BEGIN");
    try {
      for (const row of indexed) {
        const absPath = this.resolveWorkspaceFilePath(workspacePath, row.path);
        if (!absPath || !fs.existsSync(absPath)) {
          this.deleteIndexedFile(workspaceId, row.path);
          removed += 1;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (removed > 0) {
      this.parsedChunkCacheByWorkspace.delete(workspaceId);
    }
    return removed;
  }

  isMarkdownMemoryId(memoryId: string): boolean {
    return this.normalizeMemoryId(memoryId) !== null;
  }

  getTimelineContext(memoryId: string, windowSize = 5): MemoryTimelineEntry[] {
    const chunkId = this.normalizeMemoryId(memoryId);
    if (!chunkId) return [];

    const current = this.db
      .prepare(`
        SELECT id, workspace_id, path, start_line, end_line, text, mtime
        FROM memory_markdown_chunks
        WHERE id = ?
      `)
      .get(chunkId) as
      | {
          id: string;
          workspace_id: string;
          path: string;
          start_line: number;
          end_line: number;
          text: string;
          mtime: number;
        }
      | undefined;
    if (!current) return [];

    const around = this.db
      .prepare(`
        SELECT id, text, start_line, end_line, mtime
        FROM memory_markdown_chunks
        WHERE workspace_id = ? AND path = ?
        ORDER BY ABS(start_line - ?) ASC
        LIMIT ?
      `)
      .all(current.workspace_id, current.path, current.start_line, windowSize * 2 + 1) as Array<{
      id: string;
      text: string;
      start_line: number;
      end_line: number;
      mtime: number;
    }>;

    return around
      .sort((a, b) => a.start_line - b.start_line)
      .map((row) => ({
        id: `md:${row.id}`,
        content: row.text,
        type: "summary",
        createdAt: row.mtime,
      }));
  }

  getDetails(memoryIds: string[]): Memory[] {
    const chunkIds = memoryIds
      .map((id) => this.normalizeMemoryId(id))
      .filter((id): id is string => Boolean(id));
    if (chunkIds.length === 0) {
      return [];
    }

    const placeholders = chunkIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT id, workspace_id, path, start_line, end_line, text, mtime, updated_at
        FROM memory_markdown_chunks
        WHERE id IN (${placeholders})
      `)
      .all(...chunkIds) as Array<{
      id: string;
      workspace_id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      mtime: number;
      updated_at: number;
    }>;

    const byId = new Map(rows.map((row) => [row.id, row]));
    const details: Memory[] = [];

    for (const rawId of memoryIds) {
      const chunkId = this.normalizeMemoryId(rawId);
      if (!chunkId) continue;
      const row = byId.get(chunkId);
      if (!row) continue;
      details.push({
        id: `md:${row.id}`,
        workspaceId: row.workspace_id,
        type: "summary",
        content: row.text,
        summary: `${row.path}#L${row.start_line}-${row.end_line}`,
        tokens: estimateTokens(row.text),
        isCompressed: true,
        isPrivate: false,
        createdAt: row.mtime,
        updatedAt: row.updated_at,
      });
    }

    return details;
  }

  private async listMarkdownFiles(workspacePath: string): Promise<MarkdownFileEntry[]> {
    const entries: MarkdownFileEntry[] = [];
    const stack: string[] = [workspacePath];

    while (stack.length > 0) {
      const currentDir = stack.pop()!;
      let dirEntries: fs.Dirent[] = [];
      try {
        dirEntries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of dirEntries) {
        const absPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          stack.push(absPath);
          continue;
        }
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (!MARKDOWN_EXTENSIONS.has(ext)) continue;

        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(absPath);
        } catch {
          continue;
        }
        if (stat.size > MAX_INDEXED_FILE_BYTES) continue;

        const relPath = path.relative(workspacePath, absPath).replace(/\\/g, "/");
        if (!relPath || relPath.startsWith("..")) continue;

        entries.push({
          absPath,
          relPath,
          mtime: Math.floor(stat.mtimeMs),
          size: stat.size,
        });
      }
    }

    return entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  private reindexFile(
    workspaceId: string,
    file: MarkdownFileEntry,
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

      return rows.map((row, index) => ({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        snippet: normalizeSnippet(row.text),
        // Use row order for stability across varying bm25 scales/signs.
        textScore: normalizeBm25Rank(index),
        createdAt: row.mtime,
      }));
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
      const tokenClauses = tokens.map(() => "text LIKE ?").join(" OR ");
      clauses.push(`(${tokenClauses})`);
      for (const token of tokens) {
        params.push(`%${token}%`);
      }
    } else {
      clauses.push("text LIKE ?");
      params.push(`%${raw}%`);
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

  private mergeAndRerank(
    query: string,
    keywordCandidates: KeywordCandidate[],
    vectorCandidates: VectorCandidate[],
  ): Array<{
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    score: number;
    createdAt: number;
  }> {
    const merged = new Map<
      string,
      {
        id: string;
        path: string;
        startLine: number;
        endLine: number;
        snippet: string;
        textScore: number;
        vectorScore: number;
        createdAt: number;
      }
    >();

    for (const candidate of vectorCandidates) {
      merged.set(candidate.id, {
        id: candidate.id,
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        snippet: candidate.snippet,
        textScore: 0,
        vectorScore: candidate.vectorScore,
        createdAt: candidate.createdAt,
      });
    }

    for (const candidate of keywordCandidates) {
      const existing = merged.get(candidate.id);
      if (existing) {
        existing.textScore = candidate.textScore;
        existing.snippet = candidate.snippet || existing.snippet;
        existing.createdAt = Math.max(existing.createdAt, candidate.createdAt);
      } else {
        merged.set(candidate.id, {
          id: candidate.id,
          path: candidate.path,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
          snippet: candidate.snippet,
          textScore: candidate.textScore,
          vectorScore: 0,
          createdAt: candidate.createdAt,
        });
      }
    }

    return Array.from(merged.values())
      .map((candidate) => {
        const hybridScore =
          DEFAULT_VECTOR_WEIGHT * candidate.vectorScore + DEFAULT_TEXT_WEIGHT * candidate.textScore;
        const rerankScore = this.rerank(query, candidate.path, candidate.snippet);
        const score = hybridScore * 0.75 + rerankScore * 0.25;
        return {
          id: candidate.id,
          path: candidate.path,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
          snippet: candidate.snippet,
          score,
          createdAt: candidate.createdAt,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  private rerank(query: string, relPath: string, snippet: string): number {
    const queryTokens = tokenizeForMemorySearch(query);
    if (queryTokens.length === 0) return 0;

    return this.computeOverlapScore(query, relPath, snippet);
  }

  private computeOverlapScore(query: string, relPath: string, snippet: string): number {
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

  private normalizeMemoryId(memoryId: string): string | null {
    const trimmed = memoryId.trim();
    if (!trimmed.startsWith("md:")) return null;
    const id = trimmed.slice(3).trim();
    return id || null;
  }

  shutdown(): void {
    for (const timer of this.scheduledSyncByWorkspace.values()) {
      clearTimeout(timer);
    }
    this.scheduledSyncByWorkspace.clear();

    const workspaceIds = new Set<string>([
      ...this.lastSyncByWorkspace.keys(),
      ...this.pendingSyncByWorkspace.keys(),
      ...this.syncGenerationByWorkspace.keys(),
    ]);
    for (const workspaceId of workspaceIds) {
      this.bumpSyncGeneration(workspaceId);
    }

    this.pendingSyncByWorkspace.clear();
    this.parsedChunkCacheByWorkspace.clear();
    this.lastSyncByWorkspace.clear();
  }

  private enqueueSync(
    workspaceId: string,
    workspacePath: string,
    force: boolean,
    generation: number,
  ): void {
    if (this.pendingSyncByWorkspace.has(workspaceId)) {
      return;
    }

    const task = Promise.resolve()
      .then(async () => {
        if (generation !== this.getSyncGeneration(workspaceId)) {
          return;
        }
        await this.syncWorkspace(workspaceId, workspacePath, force, generation);
      })
      .finally(() => {
        this.pendingSyncByWorkspace.delete(workspaceId);
      });

    this.pendingSyncByWorkspace.set(workspaceId, task);
    void task.catch((error) => {
      console.warn("[MarkdownMemoryIndexService] Async sync failed:", error);
    });
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
    const cached = this.parsedChunkCacheByWorkspace.get(workspaceId);
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

    this.parsedChunkCacheByWorkspace.set(workspaceId, {
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

  private getSyncGeneration(workspaceId: string): number {
    return this.syncGenerationByWorkspace.get(workspaceId) ?? 0;
  }

  private bumpSyncGeneration(workspaceId: string): number {
    const next = this.getSyncGeneration(workspaceId) + 1;
    this.syncGenerationByWorkspace.set(workspaceId, next);
    return next;
  }

  private resolveWorkspaceFilePath(workspacePath: string, relativePath: string): string | null {
    const normalizedWorkspace = path.resolve(workspacePath);
    const candidate = path.resolve(normalizedWorkspace, relativePath);
    if (candidate === normalizedWorkspace || candidate.startsWith(normalizedWorkspace + path.sep)) {
      return candidate;
    }
    return null;
  }
}
