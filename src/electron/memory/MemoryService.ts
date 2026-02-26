/**
 * Memory Service
 *
 * Core service for the persistent memory system.
 * Handles capture, compression, search, and context injection.
 */

import { EventEmitter } from "events";
import type { DatabaseManager } from "../database/schema";
import {
  MemoryRepository,
  MemoryEmbeddingRepository,
  MemorySummaryRepository,
  MemorySettingsRepository,
  Memory,
  MemorySettings,
  MemorySearchResult,
  MemoryTimelineEntry,
  MemoryType,
  MemoryStats,
} from "../database/repositories";
import { LLMProviderFactory } from "../agent/llm";
import { estimateTokens } from "../agent/context-manager";
import { InputSanitizer } from "../agent/security";
import {
  cosineSimilarity,
  createLocalEmbedding,
  tokenizeForLocalEmbedding,
} from "./local-embedding";
import { MarkdownMemoryIndexService } from "./MarkdownMemoryIndexService";

// Privacy patterns to exclude - matches common sensitive data patterns
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /credential/i,
  /auth/i,
  /bearer\s+[a-zA-Z0-9\-_]+/i,
  /ssh[_-]?key/i,
  /private[_-]?key/i,
  /\.env/i,
  /aws[_-]?access/i,
  /aws[_-]?secret/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
  /ghp_[a-zA-Z0-9]+/i, // GitHub personal access token
  /gho_[a-zA-Z0-9]+/i, // GitHub OAuth token
  /sk-[a-zA-Z0-9]+/i, // OpenAI API key format
  /xox[baprs]-[a-zA-Z0-9-]+/i, // Slack tokens
];

// Events for reactive updates
const memoryEvents = new EventEmitter();

// Minimum tokens before compression is worthwhile
const MIN_TOKENS_FOR_COMPRESSION = 100;

// Compression batch size
const COMPRESSION_BATCH_SIZE = 10;

// Cleanup interval (1 hour)
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Compression delay between items (avoid rate limits)
const COMPRESSION_DELAY_MS = 200;

export class MemoryService {
  private static memoryRepo: MemoryRepository;
  private static embeddingRepo: MemoryEmbeddingRepository;
  private static summaryRepo: MemorySummaryRepository;
  private static settingsRepo: MemorySettingsRepository;
  private static markdownIndex: MarkdownMemoryIndexService | null = null;
  private static memoryEmbeddingsByWorkspace = new Map<
    string,
    Map<string, { updatedAt: number; embedding: Float32Array }>
  >();
  private static importedEmbeddings = new Map<
    string,
    { updatedAt: number; embedding: Float32Array; workspaceId: string }
  >();
  private static importedEmbeddingsLoaded = false;
  private static importedEmbeddingBackfillInProgress = false;
  private static embeddingsLoadedForWorkspace = new Set<string>();
  private static embeddingBackfillInProgress = new Set<string>();
  private static initialized = false;
  private static compressionQueue: string[] = [];
  private static compressionInProgress = false;
  private static compressionPauseCount = 0;
  private static cleanupIntervalHandle?: ReturnType<typeof setInterval>;

  /**
   * Initialize the memory service
   */
  static initialize(dbManager: DatabaseManager): void {
    if (this.initialized) return;

    const db = dbManager.getDatabase();
    this.memoryRepo = new MemoryRepository(db);
    this.embeddingRepo = new MemoryEmbeddingRepository(db);
    this.summaryRepo = new MemorySummaryRepository(db);
    this.settingsRepo = new MemorySettingsRepository(db);
    this.markdownIndex = new MarkdownMemoryIndexService(db);
    this.initialized = true;

    // Start periodic cleanup
    this.cleanupIntervalHandle = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);

    console.log("[MemoryService] Initialized");
  }

  /**
   * Sync workspace markdown index (kit notes, docs, etc.)
   * This is optional; failures should not impact the core memory system.
   */
  static async syncWorkspaceMarkdown(
    workspaceId: string,
    workspacePath: string,
    force = false,
  ): Promise<void> {
    this.ensureInitialized();
    if (!this.markdownIndex) return;
    await this.markdownIndex.syncWorkspace(workspaceId, workspacePath, force);
  }

  /**
   * Search indexed markdown within a workspace path (best-effort).
   * Intended for retrieving durable workspace notes such as `.cowork/` memory files.
   */
  static searchWorkspaceMarkdown(
    workspaceId: string,
    workspacePath: string,
    query: string,
    limit = 10,
  ): MemorySearchResult[] {
    this.ensureInitialized();
    if (!this.markdownIndex) return [];
    try {
      return this.markdownIndex.search(workspaceId, workspacePath, query, limit);
    } catch {
      return [];
    }
  }

  static getRecentWorkspaceMarkdownSnippets(
    workspaceId: string,
    workspacePath: string,
    limit = 3,
  ): MemorySearchResult[] {
    this.ensureInitialized();
    if (!this.markdownIndex) return [];
    try {
      return this.markdownIndex.getRecentSnippets(workspaceId, workspacePath, limit);
    } catch {
      return [];
    }
  }

  /**
   * Subscribe to memory events
   */
  static onMemoryChanged(
    callback: (data: { type: string; workspaceId: string }) => void,
  ): () => void {
    memoryEvents.on("memoryChanged", callback);
    return () => memoryEvents.off("memoryChanged", callback);
  }

  /**
   * Capture an observation from task execution
   */
  static async capture(
    workspaceId: string,
    taskId: string | undefined,
    type: MemoryType,
    content: string,
    isPrivate = false,
  ): Promise<Memory | null> {
    this.ensureInitialized();

    // Check settings
    const settings = this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled || !settings.autoCapture) {
      return null;
    }

    // Check privacy mode
    if (settings.privacyMode === "disabled") {
      return null;
    }

    // Check excluded patterns
    if (this.shouldExclude(content, settings)) {
      return null;
    }

    // Check for sensitive content
    const containsSensitive = this.containsSensitiveData(content);
    const finalIsPrivate = isPrivate || containsSensitive || settings.privacyMode === "strict";

    // Estimate tokens
    const tokens = estimateTokens(content);

    // Truncate very long content
    const truncatedContent =
      content.length > 10000 ? content.slice(0, 10000) + "\n[... truncated]" : content;

    // Create memory
    const memory = this.memoryRepo.create({
      workspaceId,
      taskId,
      type,
      content: truncatedContent,
      tokens,
      isCompressed: false,
      isPrivate: finalIsPrivate,
    });

    // Best-effort: maintain local semantic index for offline hybrid retrieval.
    // This is fast and runs locally; failures shouldn't break capture.
    try {
      const embedText = this.normalizeForEmbedding(memory.summary, memory.content);
      const embedding = createLocalEmbedding(embedText);
      this.embeddingRepo.upsert(workspaceId, memory.id, embedding, memory.updatedAt);
      this.cacheEmbedding(workspaceId, memory.id, embedding, memory.updatedAt);
    } catch {
      // ignore
    }

    // Queue for compression if enabled and large enough
    if (settings.compressionEnabled && tokens > MIN_TOKENS_FOR_COMPRESSION && !finalIsPrivate) {
      this.compressionQueue.push(memory.id);
      this.processCompressionQueue();
    }

    // Emit event
    memoryEvents.emit("memoryChanged", { type: "created", workspaceId });

    // Enforce per-workspace storage cap (best-effort).
    this.enforceStorageLimit(workspaceId, settings.maxStorageMb);

    return memory;
  }

  /**
   * Search memories - Layer 1 of progressive retrieval
   * Returns IDs + brief snippets (~50 tokens each)
   */
  static search(workspaceId: string, query: string, limit = 20): MemorySearchResult[] {
    this.ensureInitialized();
    // Include private memories — private means not shared externally, not hidden from the owner
    const lexicalLimit = Math.min(Math.max(limit, 5), 50);
    const lexicalLocal = this.memoryRepo.search(workspaceId, query, lexicalLimit, true);
    const lexicalImportedGlobal = this.memoryRepo.searchImportedGlobal(query, lexicalLimit, true);

    // Kick off a background backfill for imported ChatGPT histories (and any other memories)
    // so semantic recall improves over time without requiring re-import.
    this.kickoffEmbeddingBackfill(workspaceId);
    this.kickoffImportedEmbeddingBackfill();

    // Hybrid (offline semantic + BM25):
    // - use lexical BM25 to get candidate set
    // - compute local embedding similarity as a second signal
    // - merge + rerank for better recall on imported ChatGPT memories and natural language prompts
    try {
      const tokens = tokenizeForLocalEmbedding(query);
      if (tokens.length < 2) {
        return this.mergeLexicalOnly(lexicalLocal, lexicalImportedGlobal, limit);
      }

      this.ensureEmbeddingsLoaded(workspaceId);
      const workspaceEmbeddings = this.memoryEmbeddingsByWorkspace.get(workspaceId);
      this.ensureImportedEmbeddingsLoaded();

      const candidateIds = new Set<string>();
      for (const r of lexicalLocal) candidateIds.add(r.id);
      for (const r of lexicalImportedGlobal) candidateIds.add(r.id);

      const queryEmbedding = createLocalEmbedding(query);
      if (queryEmbedding.every((v) => v === 0)) {
        return this.mergeLexicalOnly(lexicalLocal, lexicalImportedGlobal, limit);
      }

      // Semantic candidate set: scan local embeddings and keep top K.
      const semanticK = Math.min(Math.max(limit * 3, 30), 120);
      const semanticCandidates: Array<{ id: string; score: number }> = [];
      if (workspaceEmbeddings && workspaceEmbeddings.size > 0) {
        for (const [memoryId, entry] of workspaceEmbeddings.entries()) {
          const score = cosineSimilarity(queryEmbedding, entry.embedding);
          if (!Number.isFinite(score) || score <= 0) continue;
          semanticCandidates.push({ id: memoryId, score });
        }
      }

      // Global semantic scan over imported ChatGPT embeddings.
      if (this.importedEmbeddings.size > 0) {
        for (const [memoryId, entry] of this.importedEmbeddings.entries()) {
          const score = cosineSimilarity(queryEmbedding, entry.embedding);
          if (!Number.isFinite(score) || score <= 0) continue;
          semanticCandidates.push({ id: memoryId, score });
        }
      }
      semanticCandidates.sort((a, b) => b.score - a.score);
      for (const cand of semanticCandidates.slice(0, semanticK)) {
        candidateIds.add(cand.id);
      }

      const scored: Array<{ result: MemorySearchResult; score: number }> = [];

      // Map lexical results for baseline score; keep stable if semantic is unavailable.
      const lexicalRankLocal = new Map<string, number>();
      lexicalLocal.forEach((r, idx) => lexicalRankLocal.set(r.id, idx));
      const lexicalRankImported = new Map<string, number>();
      lexicalImportedGlobal.forEach((r, idx) => lexicalRankImported.set(r.id, idx));

      const semanticScoreById = new Map<string, number>();
      for (const cand of semanticCandidates.slice(0, semanticK)) {
        semanticScoreById.set(cand.id, cand.score);
      }

      // Pull full memory rows for candidates to generate snippets.
      const candidates = this.memoryRepo.getFullDetails(Array.from(candidateIds));
      for (const mem of candidates) {
        const semantic = semanticScoreById.get(mem.id) ?? 0;
        const idxLocal = lexicalRankLocal.get(mem.id);
        const idxImported = lexicalRankImported.get(mem.id);
        const baselineLocal = idxLocal === undefined ? 0 : 1 / (1 + idxLocal);
        const baselineImported = idxImported === undefined ? 0 : 1 / (1 + idxImported);
        const baseline = Math.max(baselineLocal, baselineImported);

        // Weighted hybrid score. Favor lexical when present but allow semantic to lift matches.
        const hybrid = 0.55 * semantic + 0.45 * baseline;

        scored.push({
          result: {
            id: mem.id,
            snippet: mem.summary || this.truncate(mem.content, 200),
            type: mem.type,
            relevanceScore: hybrid,
            createdAt: mem.createdAt,
            taskId: mem.taskId,
            source: "db" as const,
          },
          score: hybrid,
        });
      }

      scored.sort((a, b) => b.score - a.score || b.result.createdAt - a.result.createdAt);
      return scored.slice(0, limit).map((s) => s.result);
    } catch {
      return this.mergeLexicalOnly(lexicalLocal, lexicalImportedGlobal, limit);
    }
  }

  private static mergeLexicalOnly(
    local: MemorySearchResult[],
    imported: MemorySearchResult[],
    limit: number,
  ): MemorySearchResult[] {
    const seen = new Set<string>();
    const out: MemorySearchResult[] = [];
    for (const r of local) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    for (const r of imported) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    return out;
  }

  private static ensureEmbeddingsLoaded(workspaceId: string): void {
    // Lazy load persisted embeddings for a workspace into memory.
    // If the table doesn't exist yet (older DB), this will throw and be ignored by callers.
    if (this.embeddingsLoadedForWorkspace.has(workspaceId)) return;
    try {
      const embeddings = this.embeddingRepo.getByWorkspace(workspaceId);
      const map = new Map<string, { updatedAt: number; embedding: Float32Array }>();
      for (const row of embeddings) {
        if (Array.isArray(row.embedding) && row.embedding.length > 0) {
          map.set(row.memoryId, {
            updatedAt: row.updatedAt,
            embedding: Float32Array.from(row.embedding),
          });
        }
      }
      this.memoryEmbeddingsByWorkspace.set(workspaceId, map);
    } catch {
      // ignore, feature will still work via in-memory embeddings computed on demand
    } finally {
      this.embeddingsLoadedForWorkspace.add(workspaceId);
    }
  }

  private static cacheEmbedding(
    workspaceId: string,
    memoryId: string,
    embedding: number[],
    updatedAt: number,
  ): void {
    let ws = this.memoryEmbeddingsByWorkspace.get(workspaceId);
    if (!ws) {
      ws = new Map();
      this.memoryEmbeddingsByWorkspace.set(workspaceId, ws);
    }
    ws.set(memoryId, { updatedAt, embedding: Float32Array.from(embedding) });
  }

  private static kickoffEmbeddingBackfill(workspaceId: string): void {
    if (this.embeddingBackfillInProgress.has(workspaceId)) return;
    this.embeddingBackfillInProgress.add(workspaceId);

    // Run asynchronously so search stays responsive.
    setTimeout(() => {
      this.runEmbeddingBackfill(workspaceId).catch(() => {
        // ignore
      });
    }, 25);
  }

  private static async runEmbeddingBackfill(workspaceId: string): Promise<void> {
    const batchSize = 250;
    const maxBatchesPerRun = 200; // hard safety cap
    try {
      for (let batch = 0; batch < maxBatchesPerRun; batch++) {
        const missing = this.embeddingRepo.findMissingOrStale(workspaceId, batchSize);
        if (missing.length === 0) break;

        for (const mem of missing) {
          const text = this.normalizeForEmbedding(mem.summary, mem.content);
          const embedding = createLocalEmbedding(text);
          // Persist and cache.
          this.embeddingRepo.upsert(workspaceId, mem.memoryId, embedding, mem.updatedAt);
          this.cacheEmbedding(workspaceId, mem.memoryId, embedding, mem.updatedAt);
        }

        // Yield to avoid monopolizing the event loop on large histories.
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      this.embeddingBackfillInProgress.delete(workspaceId);
    }
  }

  private static normalizeForEmbedding(summary: string | undefined, content: string): string {
    let text = (summary || content || "").trim();
    // Strip ChatGPT import tag to reduce noise in semantic space.
    text = text.replace(/^\[Imported from ChatGPT[^\]]*\]\s*/i, "");
    // Keep a bounded prefix for speed and to avoid pathological inputs.
    if (text.length > 12000) text = text.slice(0, 12000);
    return text;
  }

  private static ensureImportedEmbeddingsLoaded(): void {
    if (this.importedEmbeddingsLoaded) return;
    try {
      // Load in one go; typical sizes are manageable (thousands to tens of thousands).
      const rows = this.embeddingRepo.getImportedGlobal(200000, 0);
      for (const row of rows) {
        if (!Array.isArray(row.embedding) || row.embedding.length === 0) continue;
        this.importedEmbeddings.set(row.memoryId, {
          updatedAt: row.updatedAt,
          embedding: Float32Array.from(row.embedding),
          workspaceId: row.workspaceId,
        });
      }
    } catch {
      // ignore
    } finally {
      this.importedEmbeddingsLoaded = true;
    }
  }

  private static kickoffImportedEmbeddingBackfill(): void {
    if (this.importedEmbeddingBackfillInProgress) return;
    this.importedEmbeddingBackfillInProgress = true;
    setTimeout(() => {
      this.runImportedEmbeddingBackfill().catch(() => {
        // ignore
      });
    }, 25);
  }

  private static async runImportedEmbeddingBackfill(): Promise<void> {
    const batchSize = 400;
    const maxBatchesPerRun = 400;
    try {
      for (let batch = 0; batch < maxBatchesPerRun; batch++) {
        const missing = this.embeddingRepo.findMissingOrStaleImportedGlobal(batchSize);
        if (missing.length === 0) break;
        for (const mem of missing) {
          const text = this.normalizeForEmbedding(mem.summary, mem.content);
          const embedding = createLocalEmbedding(text);
          this.embeddingRepo.upsert(mem.workspaceId, mem.memoryId, embedding, mem.updatedAt);
          this.importedEmbeddings.set(mem.memoryId, {
            updatedAt: mem.updatedAt,
            embedding: Float32Array.from(embedding),
            workspaceId: mem.workspaceId,
          });
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      this.importedEmbeddingBackfillInProgress = false;
    }
  }

  /**
   * Get timeline context - Layer 2 of progressive retrieval
   * Returns surrounding memories for context
   */
  static getTimelineContext(memoryId: string, windowSize = 5): MemoryTimelineEntry[] {
    this.ensureInitialized();
    return this.memoryRepo.getTimelineContext(memoryId, windowSize);
  }

  /**
   * Get full details - Layer 3 of progressive retrieval
   * Only called for specific memories when needed
   */
  static getFullDetails(ids: string[]): Memory[] {
    this.ensureInitialized();
    return this.memoryRepo.getFullDetails(ids);
  }

  /**
   * Get memories for a specific task
   */
  static getByTask(taskId: string): Memory[] {
    this.ensureInitialized();
    return this.memoryRepo.findByTask(taskId);
  }

  /**
   * Get recent memories for a workspace
   */
  static getRecent(workspaceId: string, limit = 20): Memory[] {
    this.ensureInitialized();
    return this.memoryRepo.getRecentForWorkspace(workspaceId, limit, true);
  }

  /**
   * Get context for injection at task start
   * Returns a formatted string suitable for system prompt
   */
  static getContextForInjection(workspaceId: string, taskPrompt: string): string {
    this.ensureInitialized();

    const settings = this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled) {
      return "";
    }

    // Get recent memories (summaries preferred)
    // Include private memories — they are private from external sharing, not from local agent context
    const recentMemories = this.memoryRepo.getRecentForWorkspace(workspaceId, 5, true);

    // Search for relevant memories based on task prompt
    let relevantMemories: MemorySearchResult[] = [];
    if (taskPrompt && taskPrompt.length > 10) {
      try {
        // Hybrid recall: use local embeddings + lexical search for better matches.
        // Keep the query bounded for performance.
        const query = taskPrompt.slice(0, 2500);
        relevantMemories = this.search(workspaceId, query, 10);

        // Filter out memories that are already in recent
        const recentIds = new Set(recentMemories.map((m) => m.id));
        relevantMemories = relevantMemories.filter((m) => !recentIds.has(m.id)).slice(0, 7);
      } catch {
        // Search failed, continue without relevant memories
      }
    }

    if (recentMemories.length === 0 && relevantMemories.length === 0) {
      return "";
    }

    const parts: string[] = ["<memory_context>"];
    parts.push("The following memories from previous sessions may be relevant:");

    // Add recent memories (summaries only for token efficiency)
    if (recentMemories.length > 0) {
      parts.push("\n## Recent Activity");
      for (const memory of recentMemories) {
        const rawText = memory.summary || this.truncate(memory.content, 150);
        // Sanitize memory content to prevent injection via stored memories
        const text = InputSanitizer.sanitizeMemoryContent(rawText);
        const date = new Date(memory.createdAt).toLocaleDateString();
        parts.push(`- [${memory.type}] (${date}) ${text}`);
      }
    }

    // Add relevant memories (hybrid semantic + lexical)
    if (relevantMemories.length > 0) {
      parts.push("\n## Relevant to Current Task (Hybrid Recall)");
      for (const result of relevantMemories) {
        const date = new Date(result.createdAt).toLocaleDateString();
        // Sanitize memory content to prevent injection via stored memories
        const sanitizedSnippet = InputSanitizer.sanitizeMemoryContent(result.snippet);
        parts.push(`- [${result.type}] (${date}) ${sanitizedSnippet}`);
      }
    }

    parts.push("</memory_context>");

    return parts.join("\n");
  }

  /**
   * Get or create settings for a workspace
   */
  static getSettings(workspaceId: string): MemorySettings {
    this.ensureInitialized();
    return this.settingsRepo.getOrCreate(workspaceId);
  }

  /**
   * Update settings for a workspace
   */
  static updateSettings(
    workspaceId: string,
    updates: Partial<Omit<MemorySettings, "workspaceId">>,
  ): void {
    this.ensureInitialized();
    this.settingsRepo.update(workspaceId, updates);
    memoryEvents.emit("memoryChanged", { type: "settingsUpdated", workspaceId });
  }

  /**
   * Get storage statistics for a workspace
   */
  static getStats(workspaceId: string): MemoryStats {
    this.ensureInitialized();
    return this.memoryRepo.getStats(workspaceId);
  }

  /**
   * Get statistics for imported ChatGPT memories
   */
  static getImportedStats(workspaceId: string): { count: number; totalTokens: number } {
    this.ensureInitialized();
    return this.memoryRepo.getImportedStats(workspaceId);
  }

  /**
   * Find imported ChatGPT memories with pagination
   */
  static findImported(workspaceId: string, limit = 50, offset = 0): Memory[] {
    this.ensureInitialized();
    return this.memoryRepo.findImported(workspaceId, limit, offset);
  }

  /**
   * Delete all imported ChatGPT memories for a workspace
   */
  static deleteImported(workspaceId: string): number {
    this.ensureInitialized();
    // Remove embeddings first (embeddings table references memories by id).
    try {
      this.embeddingRepo.deleteImported(workspaceId);
    } catch {
      // ignore
    }
    const deleted = this.memoryRepo.deleteImported(workspaceId);
    // Clear caches for this workspace (best-effort).
    this.memoryEmbeddingsByWorkspace.delete(workspaceId);
    this.embeddingsLoadedForWorkspace.delete(workspaceId);
    this.embeddingBackfillInProgress.delete(workspaceId);
    memoryEvents.emit("memoryChanged", { type: "importedDeleted", workspaceId });
    return deleted;
  }

  /**
   * Delete all memories for a workspace
   */
  static clearWorkspace(workspaceId: string): void {
    this.ensureInitialized();
    this.memoryRepo.deleteByWorkspace(workspaceId);
    this.summaryRepo.deleteByWorkspace(workspaceId);
    try {
      this.embeddingRepo.deleteByWorkspace(workspaceId);
    } catch {
      // ignore
    }
    try {
      this.markdownIndex?.clearWorkspace(workspaceId);
    } catch {
      // ignore
    }
    this.memoryEmbeddingsByWorkspace.delete(workspaceId);
    this.embeddingsLoadedForWorkspace.delete(workspaceId);
    this.embeddingBackfillInProgress.delete(workspaceId);
    memoryEvents.emit("memoryChanged", { type: "cleared", workspaceId });
  }

  /**
   * Pause background LLM compression to avoid contention during active task execution.
   * Queued items are preserved and processed when resumed.
   */
  static pauseCompression(): void {
    this.compressionPauseCount += 1;
  }

  /**
   * Resume background LLM compression and drain any queued items.
   */
  static resumeCompression(): void {
    if (this.compressionPauseCount > 0) {
      this.compressionPauseCount -= 1;
    }
    if (!this.isCompressionPaused() && this.compressionQueue.length > 0) {
      this.processCompressionQueue();
    }
  }

  private static isCompressionPaused(): boolean {
    return this.compressionPauseCount > 0;
  }

  /**
   * Process compression queue asynchronously
   */
  private static async processCompressionQueue(): Promise<void> {
    if (
      this.compressionInProgress ||
      this.compressionQueue.length === 0 ||
      this.isCompressionPaused()
    ) {
      return;
    }

    this.compressionInProgress = true;

    try {
      // Process in batches
      const batch = this.compressionQueue.splice(0, COMPRESSION_BATCH_SIZE);

      for (const memoryId of batch) {
        // Check pause flag between items to yield promptly when a task starts.
        if (this.isCompressionPaused()) break;
        await this.compressMemory(memoryId);
        // Small delay to avoid overwhelming the LLM
        await new Promise((resolve) => setTimeout(resolve, COMPRESSION_DELAY_MS));
      }

      // Continue if more items (and not paused)
      if (this.compressionQueue.length > 0 && !this.isCompressionPaused()) {
        setTimeout(() => this.processCompressionQueue(), 1000);
      }
    } catch (error) {
      console.error("[MemoryService] Compression queue error:", error);
    } finally {
      this.compressionInProgress = false;
    }
  }

  /**
   * Compress a single memory using LLM
   */
  private static async compressMemory(memoryId: string): Promise<void> {
    const memory = this.memoryRepo.findById(memoryId);
    if (!memory || memory.isCompressed || memory.summary) return;

    try {
      // Get LLM provider for compression
      const provider = LLMProviderFactory.createProvider();
      const settings = LLMProviderFactory.getSettings();
      const azureDeployment = settings.azure?.deployment || settings.azure?.deployments?.[0];
      const modelId = LLMProviderFactory.getModelId(
        settings.modelKey,
        settings.providerType,
        settings.ollama?.model,
        settings.gemini?.model,
        settings.openrouter?.model,
        settings.openai?.model,
        azureDeployment,
        settings.groq?.model,
        settings.xai?.model,
        settings.kimi?.model,
        settings.customProviders,
        settings.bedrock?.model,
      );

      const response = await provider.createMessage({
        model: modelId,
        maxTokens: 100,
        system: "You are a helpful assistant that summarizes text concisely.",
        messages: [
          {
            role: "user",
            content: `Summarize this observation in 1-2 sentences (max 50 words). Focus on the key insight, decision, or action taken. Be concise and factual.

Observation:
${memory.content}

Summary:`,
          },
        ],
      });

      // Extract summary from response
      let summary = "";
      for (const content of response.content) {
        if (content.type === "text") {
          summary += content.text;
        }
      }
      summary = summary.trim();

      if (summary) {
        const summaryTokens = estimateTokens(summary);
        this.memoryRepo.update(memoryId, {
          summary,
          tokens: summaryTokens,
          isCompressed: true,
        });
      }
    } catch (error) {
      // Log but don't fail - compression is optional enhancement
      console.warn("[MemoryService] Compression failed for memory:", memoryId, error);
    }
  }

  /**
   * Run periodic cleanup based on retention policies
   */
  private static async runCleanup(): Promise<void> {
    if (!this.initialized) return;

    try {
      // Get all workspaces that have any memories (compressed or not).
      const workspacesWithMemories = this.memoryRepo.listWorkspaceIds(5000);

      // Process each workspace
      for (const workspaceId of workspacesWithMemories) {
        const settings = this.settingsRepo.getOrCreate(workspaceId);
        const retentionMs = settings.retentionDays * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - retentionMs;

        const deleted = this.memoryRepo.deleteOlderThan(workspaceId, cutoff);
        if (deleted > 0) {
          console.log(
            `[MemoryService] Cleaned up ${deleted} old memories for workspace ${workspaceId}`,
          );
        }

        this.enforceStorageLimit(workspaceId, settings.maxStorageMb);
      }
    } catch (error) {
      console.error("[MemoryService] Cleanup failed:", error);
    }
  }

  private static enforceStorageLimit(workspaceId: string, maxStorageMb: number): void {
    const maxBytes = Math.max(0, Math.floor(maxStorageMb * 1024 * 1024));
    if (maxBytes <= 0) return;

    let totalBytes = this.memoryRepo.getApproxStorageBytes(workspaceId);
    if (totalBytes <= maxBytes) return;

    let loopGuard = 0;
    while (totalBytes > maxBytes && loopGuard < 20) {
      loopGuard += 1;
      const oldest = this.memoryRepo.getOldestForWorkspace(workspaceId, 200);
      if (!oldest.length) break;

      let reclaimed = 0;
      const idsToDelete: string[] = [];
      const needToFree = totalBytes - maxBytes;
      for (const row of oldest) {
        idsToDelete.push(row.id);
        reclaimed += Math.max(1, row.approxBytes);
        if (reclaimed >= needToFree) break;
      }

      if (!idsToDelete.length) break;

      const deleted = this.memoryRepo.deleteByIds(workspaceId, idsToDelete);
      if (deleted > 0) {
        this.embeddingRepo.deleteByMemoryIds(idsToDelete);
        memoryEvents.emit("memoryChanged", { type: "pruned", workspaceId });
      } else {
        break;
      }

      totalBytes = this.memoryRepo.getApproxStorageBytes(workspaceId);
    }
  }

  /**
   * Extract search terms from task prompt
   */
  private static extractSearchTerms(prompt: string): string {
    // Remove common words and extract meaningful terms
    const stopWords = new Set([
      "a",
      "an",
      "the",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "can",
      "must",
      "shall",
      "to",
      "of",
      "in",
      "for",
      "on",
      "with",
      "at",
      "by",
      "from",
      "up",
      "about",
      "into",
      "over",
      "after",
      "beneath",
      "under",
      "above",
      "and",
      "or",
      "but",
      "if",
      "then",
      "else",
      "when",
      "where",
      "why",
      "how",
      "all",
      "each",
      "every",
      "both",
      "few",
      "more",
      "most",
      "other",
      "some",
      "such",
      "no",
      "nor",
      "not",
      "only",
      "own",
      "same",
      "so",
      "than",
      "too",
      "very",
      "just",
      "also",
      "now",
      "please",
      "help",
      "me",
      "i",
      "my",
      "want",
      "need",
      "like",
      "make",
      "create",
      "add",
      "update",
      "fix",
    ]);

    const words = prompt
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));

    // Take first 5 meaningful words for search
    return words.slice(0, 5).join(" OR ");
  }

  /**
   * Check if content should be excluded
   */
  private static shouldExclude(content: string, settings: MemorySettings): boolean {
    if (!settings.excludedPatterns || settings.excludedPatterns.length === 0) {
      return false;
    }

    for (const pattern of settings.excludedPatterns) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(content)) {
          return true;
        }
      } catch {
        // Invalid regex pattern, skip
      }
    }

    return false;
  }

  /**
   * Check if content contains sensitive data
   */
  private static containsSensitiveData(content: string): boolean {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(content)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Truncate text to specified length
   */
  private static truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + "...";
  }

  /**
   * Ensure service is initialized
   */
  private static ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("[MemoryService] Not initialized. Call MemoryService.initialize() first.");
    }
  }

  /**
   * Shutdown the service
   */
  static shutdown(): void {
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = undefined;
    }
    memoryEvents.removeAllListeners();
    this.memoryEmbeddingsByWorkspace.clear();
    this.importedEmbeddings.clear();
    this.markdownIndex = null;
    this.importedEmbeddingsLoaded = false;
    this.importedEmbeddingBackfillInProgress = false;
    this.embeddingsLoadedForWorkspace.clear();
    this.embeddingBackfillInProgress.clear();
    this.initialized = false;
    console.log("[MemoryService] Shutdown complete");
  }
}
