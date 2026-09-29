import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { estimateTokens } from "../agent/context-manager";
import type { Memory, MemorySearchResult, MemoryTimelineEntry } from "../database/repositories";
import { storeFacade, type AsyncStore } from "../database/statements/store-units";
import {
  computeMarkdownOverlapScore,
  hashText,
  normalizeSnippet,
  tokenizeForMemorySearch,
  type KeywordCandidate,
  type MarkdownFileEntry,
  type MarkdownIndexStore,
  type VectorCandidate,
} from "./markdown-index-sql";
import { MARKDOWN_INDEX_READS, MARKDOWN_INDEX_WRITES } from "./markdown-index-units";
import { createMemoryStatementPort } from "./memory-statement-port";

export {
  buildMarkdownFtsQuery,
  chunkMarkdownForIndex,
  redactSensitiveMarkdownContent,
  tokenizeForMemorySearch,
} from "./markdown-index-sql";

const SYNC_DEBOUNCE_MS = 15000;
/** Files reindexed per transaction during a sync. */
const SYNC_BATCH_FILES = 8;
const MAX_INDEXED_FILE_BYTES = 2 * 1024 * 1024;
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

/**
 * Optional task-scoped read boundary for markdown indexing and recall.
 * The index is shared across tasks, so callers must filter both new reads and
 * already-indexed results when a task has a narrower filesystem profile.
 */
export type MarkdownMemoryReadGuard = (candidatePath: string) => boolean;

type MarkdownIndexMethod =
  | (typeof MARKDOWN_INDEX_READS)[number]
  | (typeof MARKDOWN_INDEX_WRITES)[number];

/**
 * Workspace markdown memory (async SQLite migration plan, DB6). Files are listed, read and
 * checked against read guards here; indexing (chunking, redaction, embeddings) and every
 * query run as memory-domain transaction units over `MarkdownIndexStore`, in the
 * database worker when memory is routed there and on the host connection otherwise. A
 * sync writes its whole plan in one transaction.
 */
export class MarkdownMemoryIndexService {
  private readonly lastSyncByWorkspace = new Map<string, number>();
  private readonly pendingSyncByWorkspace = new Map<string, Promise<void>>();
  private readonly scheduledSyncByWorkspace = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly syncGenerationByWorkspace = new Map<string, number>();
  private readonly store: AsyncStore<MarkdownIndexStore, MarkdownIndexMethod>;

  constructor(db: Database.Database) {
    const sql = createMemoryStatementPort(db);
    this.store = storeFacade<MarkdownIndexStore, MarkdownIndexMethod>(
      "markdown_",
      [...MARKDOWN_INDEX_READS, ...MARKDOWN_INDEX_WRITES],
      (name, args) => sql.unit(name as never, args as never),
    );
  }

  async search(
    workspaceId: string,
    workspacePath: string,
    query: string,
    limit = 10,
    readGuard?: MarkdownMemoryReadGuard,
  ): Promise<MemorySearchResult[]> {
    if (limit <= 0) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    // A scoped task explicitly syncs with its guard before searching. Do not
    // schedule an unguarded background read from a scoped recall call.
    if (!readGuard) {
      this.scheduleSync(workspaceId, workspacePath);
    }

    const candidateLimit = Math.max(limit, limit * SEARCH_CANDIDATE_MULTIPLIER);
    const { keyword, vector } = await this.store.searchCandidates(
      workspaceId,
      trimmed,
      candidateLimit,
    );

    return this.mergeAndRerank(trimmed, keyword, vector)
      .filter((candidate) => this.isReadableIndexedPath(workspacePath, candidate.path, readGuard))
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

  async getRecentSnippets(
    workspaceId: string,
    workspacePath: string,
    limit = 3,
    readGuard?: MarkdownMemoryReadGuard,
  ): Promise<MemorySearchResult[]> {
    if (limit <= 0) return [];
    if (!readGuard) {
      this.scheduleSync(workspaceId, workspacePath);
    }

    const chunks = await this.store.recentFirstChunks(workspaceId, Math.max(limit * 8, limit + 16));
    const results: MemorySearchResult[] = [];
    for (const chunk of chunks) {
      if (!this.isReadableIndexedPath(workspacePath, chunk.path, readGuard)) continue;
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
      if (results.length >= limit) break;
    }
    return results;
  }

  async syncWorkspace(
    workspaceId: string,
    workspacePath: string,
    force = false,
    generation?: number,
    readGuard?: MarkdownMemoryReadGuard,
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
      const discoveredFiles = await this.listMarkdownFiles(workspacePath, readGuard);
      if (generation !== undefined && generation !== this.getSyncGeneration(workspaceId)) {
        return;
      }
      const discoveredPaths = new Set(discoveredFiles.map((file) => file.relPath));

      const existing = await this.store.listIndexedFiles(workspaceId);
      const existingByPath = new Map(existing.map((row) => [row.path, row]));

      const metadataOnly: Array<Pick<MarkdownFileEntry, "relPath" | "mtime" | "size">> = [];
      const reindex: Array<
        Pick<MarkdownFileEntry, "relPath" | "mtime" | "size"> & {
          content: string;
          contentHash: string;
        }
      > = [];

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
        const entry = { relPath: file.relPath, mtime: file.mtime, size: file.size };

        if (previous && previous.content_hash === contentHash) {
          metadataOnly.push(entry);
          continue;
        }

        reindex.push({ ...entry, content, contentHash });
      }

      if (generation !== undefined && generation !== this.getSyncGeneration(workspaceId)) {
        return;
      }

      const removedPaths = existing
        .filter((row) => !discoveredPaths.has(row.path))
        .map((row) => row.path);

      if (metadataOnly.length === 0 && reindex.length === 0 && removedPaths.length === 0) return;
      // Each batch commits on its own; a file's row, chunks and FTS entries are always
      // in one batch. Recall reads run between batches instead of waiting for the whole
      // workspace, and a cleared workspace stops the remaining batches.
      for (let offset = 0; offset === 0 || offset < reindex.length; offset += SYNC_BATCH_FILES) {
        if (generation !== undefined && generation !== this.getSyncGeneration(workspaceId)) {
          return;
        }
        await this.store.applySync({
          workspaceId,
          now,
          metadataOnly: offset === 0 ? metadataOnly : [],
          reindex: reindex.slice(offset, offset + SYNC_BATCH_FILES),
          removedPaths: offset === 0 ? removedPaths : [],
        });
        // On the host backend a batch completes synchronously; yield so timers and IPC
        // run between batches.
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
      }
    } catch (error) {
      console.warn("[MarkdownMemoryIndexService] Failed to sync markdown index:", error);
    }
  }

  async clearWorkspace(workspaceId: string): Promise<void> {
    this.bumpSyncGeneration(workspaceId);
    const timer = this.scheduledSyncByWorkspace.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.scheduledSyncByWorkspace.delete(workspaceId);
    }
    this.lastSyncByWorkspace.delete(workspaceId);
    await this.store.clearWorkspace(workspaceId);
  }

  async cleanupMissingFiles(workspaceId: string, workspacePath: string): Promise<number> {
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      return 0;
    }

    const indexed = await this.store.listIndexedFiles(workspaceId);
    if (indexed.length === 0) {
      return 0;
    }

    const missing = indexed
      .map((row) => row.path)
      .filter((relPath) => {
        const absPath = this.resolveWorkspaceFilePath(workspacePath, relPath);
        return !absPath || !fs.existsSync(absPath);
      });
    return missing.length > 0 ? await this.store.deletePaths(workspaceId, missing) : 0;
  }

  async getTimelineContext(memoryId: string, windowSize = 5): Promise<MemoryTimelineEntry[]> {
    const chunkId = this.normalizeMemoryId(memoryId);
    if (!chunkId) return [];

    const current = await this.store.getChunk(chunkId);
    if (!current) return [];

    const around = await this.store.chunksAround(
      current.workspace_id,
      current.path,
      current.start_line,
      windowSize * 2 + 1,
    );

    return around
      .sort((a, b) => a.start_line - b.start_line)
      .map((row) => ({
        id: `md:${row.id}`,
        content: row.text,
        type: "summary",
        createdAt: row.mtime,
      }));
  }

  async getDetails(memoryIds: string[]): Promise<Memory[]> {
    const chunkIds = memoryIds
      .map((id) => this.normalizeMemoryId(id))
      .filter((id): id is string => Boolean(id));
    if (chunkIds.length === 0) {
      return [];
    }
    const rows = await this.store.getChunks(chunkIds);
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

  scheduleSync(
    workspaceId: string,
    workspacePath: string,
    force = false,
    readGuard?: MarkdownMemoryReadGuard,
  ): void {
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
      this.enqueueSync(workspaceId, workspacePath, force, generation, readGuard);
    }, delay);
    this.scheduledSyncByWorkspace.set(workspaceId, timer);
  }

  isMarkdownMemoryId(memoryId: string): boolean {
    return this.normalizeMemoryId(memoryId) !== null;
  }

  private async listMarkdownFiles(
    workspacePath: string,
    readGuard?: MarkdownMemoryReadGuard,
  ): Promise<MarkdownFileEntry[]> {
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
          if (readGuard && !this.isReadablePath(absPath, readGuard)) continue;
          stack.push(absPath);
          continue;
        }
        if (!entry.isFile()) continue;

        if (readGuard && !this.isReadablePath(absPath, readGuard)) continue;

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

    return computeMarkdownOverlapScore(query, relPath, snippet);
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
    this.lastSyncByWorkspace.clear();
  }

  private enqueueSync(
    workspaceId: string,
    workspacePath: string,
    force: boolean,
    generation: number,
    readGuard?: MarkdownMemoryReadGuard,
  ): void {
    if (this.pendingSyncByWorkspace.has(workspaceId)) {
      return;
    }

    const task = Promise.resolve()
      .then(async () => {
        if (generation !== this.getSyncGeneration(workspaceId)) {
          return;
        }
        await this.syncWorkspace(workspaceId, workspacePath, force, generation, readGuard);
      })
      .finally(() => {
        this.pendingSyncByWorkspace.delete(workspaceId);
      });

    this.pendingSyncByWorkspace.set(workspaceId, task);
    void task.catch((error) => {
      console.warn("[MarkdownMemoryIndexService] Async sync failed:", error);
    });
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

  private isReadablePath(candidatePath: string, readGuard: MarkdownMemoryReadGuard): boolean {
    try {
      return readGuard(candidatePath) === true;
    } catch {
      return false;
    }
  }

  private isReadableIndexedPath(
    workspacePath: string,
    relativePath: string,
    readGuard?: MarkdownMemoryReadGuard,
  ): boolean {
    if (!readGuard) return true;
    const absolutePath = this.resolveWorkspaceFilePath(workspacePath, relativePath);
    return absolutePath ? this.isReadablePath(absolutePath, readGuard) : false;
  }
}
