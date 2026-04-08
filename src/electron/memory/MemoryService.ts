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
import { recordLlmCallError, recordLlmCallSuccess } from "../agent/llm/usage-telemetry";
import { estimateTokens } from "../agent/context-manager";
import { InputSanitizer } from "../agent/security";
import {
  cosineSimilarity,
  createLocalEmbedding,
  tokenizeForLocalEmbedding,
} from "./local-embedding";
import { MarkdownMemoryIndexService } from "./MarkdownMemoryIndexService";
import { MemoryTierService } from "./MemoryTierService";
import type { CoreMemoryScopeKind } from "../../shared/types";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";

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
const MIN_TOKENS_FOR_OBSERVATION_COMPRESSION = 300;

// Compression batch size
const COMPRESSION_BATCH_SIZE = 10;

// Cleanup interval (1 hour)
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Compression delay between items (avoid rate limits)
const COMPRESSION_DELAY_MS = 200;
const COMPRESSION_DRAIN_DELAY_MS = 250;
const COMPRESSION_BUDGET_WINDOW_MS = 15 * 60 * 1000;
const COMPRESSION_BUDGET_MAX_CALLS = 3;
const COMPRESSION_RETRY_DELAY_MS = 2 * 60 * 1000;
const COMPRESSION_RETRY_BASE_DELAY_MS = 5_000;
const MAX_COMPRESSION_RETRIES = 3;
const MAX_TEXT_IMPORT_ENTRIES = 3000;
const MAX_TEXT_IMPORT_ENTRY_CHARS = 12000;
const PROMPT_RECALL_IGNORE_MARKER = "[cowork:prompt_recall=ignore]";
const HEARTBEAT_BATCH_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_SUMMARY_MAX_CHARS = 220;

type MemoryCaptureOrigin =
  | "task"
  | "heartbeat"
  | "tool"
  | "playbook"
  | "proactive"
  | "import"
  | "system"
  | "unknown";

type MemoryCompressionPriority = "low" | "normal" | "high";

export interface MemoryCaptureOptions {
  origin?: MemoryCaptureOrigin;
  batchKey?: string;
  priority?: MemoryCompressionPriority;
  signalFamily?: string;
  batchable?: boolean;
  profileId?: string;
  coreTraceId?: string;
  candidateId?: string;
  scopeKind?: CoreMemoryScopeKind;
  scopeRef?: string;
}

interface CompressionQueueEntry {
  workspaceId: string;
  batchKey: string;
  origin: MemoryCaptureOrigin;
  priority: MemoryCompressionPriority;
  requestedAt: number;
}

interface CompressionDiagnostics {
  captures: number;
  queued: number;
  skipped: number;
  localCompressed: number;
  batchSummaries: number;
  llmCalls: number;
  deferred: number;
  dropped: number;
  originCounts: Record<string, number>;
}

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
  private static compressionQueueEntries = new Map<string, CompressionQueueEntry>();
  private static compressionRetryCounts = new Map<string, number>();
  private static compressionInProgress = false;
  private static compressionPauseCount = 0;
  private static compressionDrainTimer?: ReturnType<typeof setTimeout>;
  private static compressionBudgetByWorkspace = new Map<string, number[]>();
  private static compressionDiagnosticsByWorkspace = new Map<string, CompressionDiagnostics>();
  private static sideChannelPolicyDepth = 0;
  private static sideChannelDuringExecution: "paused" | "limited" | "enabled" = "enabled";
  private static sideChannelMaxCallsPerWindow = 2;
  private static sideChannelCallsRemaining: number | null = null;
  private static sideChannelPolicyPaused = false;
  private static cleanupIntervalHandle?: ReturnType<typeof setInterval>;
  private static db?: import("better-sqlite3").Database;

  /**
   * Initialize the memory service
   */
  static initialize(dbManager: DatabaseManager): void {
    if (this.initialized) return;

    const db = dbManager.getDatabase();
    this.db = db;
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
    options?: MemoryCaptureOptions,
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

    const compressionOrigin = options?.origin ?? (taskId ? "task" : "unknown");
    this.recordCompressionCapture(workspaceId, compressionOrigin);
    const compressionPriority = this.deriveCompressionPriority(
      type,
      truncatedContent,
      tokens,
      compressionOrigin,
      options?.priority,
    );
    const compressionBatchKey = this.buildCompressionBatchKey(
      workspaceId,
      taskId,
      compressionOrigin,
      memory.createdAt,
      options?.batchKey,
      options?.signalFamily,
    );

    // Best-effort: keep a concise local summary immediately so retrieval and prompts
    // do not need to consume the full raw payload for low-value entries.
    const localSummary = this.buildDeterministicSummary(truncatedContent);
    if (localSummary) {
      this.updateMemorySummary(memory, workspaceId, localSummary, true);
    }

    // Queue a batched LLM digest only when the signal is worth it. Routine entries
    // stay on the local deterministic path and do not fan out into extra calls.
    if (
      !finalIsPrivate &&
      settings.compressionEnabled &&
      this.shouldQueueCompression({
        type,
        content: truncatedContent,
        tokens,
        origin: compressionOrigin,
        batchable: options?.batchable !== false,
        priority: compressionPriority,
      })
    ) {
      this.enqueueCompression(memory.id, {
        workspaceId,
        batchKey: compressionBatchKey,
        origin: compressionOrigin,
        priority: compressionPriority,
        requestedAt: memory.createdAt,
      });
    } else {
      this.recordCompressionDiagnostic(workspaceId, compressionOrigin, "skipped");
    }

    // Emit event
    memoryEvents.emit("memoryChanged", { type: "created", workspaceId });

    // Enforce per-workspace storage cap (best-effort).
    this.enforceStorageLimit(workspaceId, settings.maxStorageMb);

    return memory;
  }

  static async captureCoreMemory(
    workspaceId: string,
    taskId: string | undefined,
    type: MemoryType,
    content: string,
    isPrivate = false,
    options?: MemoryCaptureOptions,
  ): Promise<Memory | null> {
    return this.capture(workspaceId, taskId, type, content, isPrivate, {
      ...options,
      origin: options?.origin || "system",
      batchable: options?.batchable ?? false,
      priority: options?.priority || "high",
    });
  }

  /**
   * Search memories - Layer 1 of progressive retrieval
   * Returns IDs + brief snippets (~50 tokens each)
   */
  static search(workspaceId: string, query: string, limit = 20): MemorySearchResult[] {
    this.ensureInitialized();
    const results = this.searchInternal(workspaceId, query, limit);
    // Record references for tier promotion
    if (this.db && results.length > 0) {
      for (const r of results) {
        MemoryTierService.recordReference(this.db, r.id);
      }
    }
    return results;
  }

  private static searchInternal(workspaceId: string, query: string, limit = 20): MemorySearchResult[] {
    this.ensureInitialized();
    // Include private memories — private means not shared externally, not hidden from the owner
    const lexicalLimit = Math.min(Math.max(limit, 5), 50);
    const lexicalLocal = this.memoryRepo.search(workspaceId, query, lexicalLimit, true);
    const lexicalImportedGlobal = this.memoryRepo.searchImportedGlobal(query, lexicalLimit, true);

    // Kick off a background backfill for imported histories (and any other memories)
    // so semantic recall improves over time without requiring re-import.
    this.kickoffEmbeddingBackfill(workspaceId);
    this.kickoffImportedEmbeddingBackfill();

    // Hybrid (offline semantic + BM25):
    // - use lexical BM25 to get candidate set
    // - compute local embedding similarity as a second signal
    // - merge + rerank for better recall on imported memories and natural language prompts
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

      // Global semantic scan over imported-memory embeddings.
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
    // Strip import tags to reduce noise in semantic space.
    text = text.replace(/^\[Imported from [^\]]+\]\s*/i, "");
    // Keep a bounded prefix for speed and to avoid pathological inputs.
    if (text.length > 12000) text = text.slice(0, 12000);
    return text;
  }

  private static extractFirstCodeBlock(text: string): string | null {
    const match = text.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
    const block = match?.[1]?.trim();
    return block && block.length > 0 ? block : null;
  }

  private static extractTextImportEntries(pastedText: string): string[] {
    const source = this.extractFirstCodeBlock(pastedText) || pastedText;
    const lines = source.split(/\r?\n/);
    const entries: string[] = [];
    let current: string | null = null;
    const entryWithDatePattern = /^(?:[-*]\s*)?\[([^\]]{1,120})\]\s*[-—]\s*(.+)$/;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("```")) continue;

      const datedMatch = trimmed.match(entryWithDatePattern);
      if (datedMatch) {
        if (current) entries.push(current);
        const date = datedMatch[1].trim();
        const content = datedMatch[2].trim();
        current = `[${date}] - ${content}`;
        continue;
      }

      // If a line is indented, treat it as a continuation for the previous memory.
      if (current && /^\s+/.test(rawLine)) {
        current = `${current} ${trimmed}`;
        continue;
      }

      if (current) {
        entries.push(current);
        current = null;
      }

      const fallback = trimmed.replace(/^[-*]\s+/, "").trim();
      if (fallback) entries.push(fallback);
    }

    if (current) entries.push(current);

    return entries;
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

  static getRecentForPromptRecall(workspaceId: string, limit = 20): Memory[] {
    this.ensureInitialized();
    return this.memoryRepo
      .getRecentForWorkspace(workspaceId, limit, true)
      .filter((memory) => !this.isPromptRecallIgnoredContent(memory.content));
  }

  static searchForPromptRecall(workspaceId: string, query: string, limit = 20): MemorySearchResult[] {
    this.ensureInitialized();
    const results = this.search(workspaceId, query, limit);
    if (results.length === 0) return results;

    const details = this.memoryRepo.getFullDetails(results.map((result) => result.id));
    const ignoredIds = new Set(
      details
        .filter((memory) => this.isPromptRecallIgnoredContent(memory.content))
        .map((memory) => memory.id),
    );
    if (ignoredIds.size === 0) return results;
    return results.filter((result) => !ignoredIds.has(result.id));
  }

  private static isImportedMemoryContent(content: string): boolean {
    const normalized = this.stripPromptRecallIgnoreMarker(content).trimStart();
    return normalized.startsWith("[Imported from ");
  }

  private static isPromptRecallIgnoredContent(content: string): boolean {
    return content.trimStart().startsWith(PROMPT_RECALL_IGNORE_MARKER);
  }

  private static stripPromptRecallIgnoreMarker(content: string): string {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith(PROMPT_RECALL_IGNORE_MARKER)) return content;
    let rest = trimmed.slice(PROMPT_RECALL_IGNORE_MARKER.length);
    if (rest.startsWith("\r\n")) rest = rest.slice(2);
    else if (rest.startsWith("\n")) rest = rest.slice(1);
    return rest;
  }

  private static applyPromptRecallIgnoreMarker(content: string): string {
    if (this.isPromptRecallIgnoredContent(content)) return content;
    const stripped = this.stripPromptRecallIgnoreMarker(content);
    return `${PROMPT_RECALL_IGNORE_MARKER}\n${stripped}`;
  }

  /**
   * Get context for injection at task start
   * Returns a formatted string suitable for system prompt
   */
  static getContextForInjection(workspaceId: string, taskPrompt: string): string {
    this.ensureInitialized();
    const featureSettings = MemoryFeaturesManager.loadSettings();
    if (featureSettings.defaultArchiveInjectionEnabled !== true) {
      return "";
    }

    const settings = this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled) {
      return "";
    }

    // Get recent memories (summaries preferred)
    // Include private memories — they are private from external sharing, not from local agent context
    const recentMemories = this.getRecentForPromptRecall(workspaceId, 5);

    // Search for relevant memories based on task prompt
    let relevantMemories: MemorySearchResult[] = [];
    if (taskPrompt && taskPrompt.length > 10) {
      try {
        // Hybrid recall: use local embeddings + lexical search for better matches.
        // Keep the query bounded for performance.
        const query = taskPrompt.slice(0, 2500);
        relevantMemories = this.searchForPromptRecall(workspaceId, query, 10);

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
   * Get statistics for imported memories
   */
  static getImportedStats(workspaceId: string): { count: number; totalTokens: number } {
    this.ensureInitialized();
    return this.memoryRepo.getImportedStats(workspaceId);
  }

  /**
   * Find imported memories with pagination
   */
  static findImported(workspaceId: string, limit = 50, offset = 0): Memory[] {
    this.ensureInitialized();
    return this.memoryRepo.findImported(workspaceId, limit, offset);
  }

  static deleteImportedEntry(workspaceId: string, memoryId: string): boolean {
    this.ensureInitialized();

    const memory = this.memoryRepo.findById(memoryId);
    if (!memory || memory.workspaceId !== workspaceId) return false;
    if (!this.isImportedMemoryContent(memory.content)) return false;

    try {
      this.embeddingRepo.deleteByMemoryIds([memoryId]);
    } catch {
      // ignore
    }

    const deleted = this.memoryRepo.deleteByIds(workspaceId, [memoryId]);
    if (deleted <= 0) return false;

    this.importedEmbeddings.delete(memoryId);
    this.memoryEmbeddingsByWorkspace.delete(workspaceId);
    this.embeddingsLoadedForWorkspace.delete(workspaceId);
    this.embeddingBackfillInProgress.delete(workspaceId);
    memoryEvents.emit("memoryChanged", { type: "importedEntryDeleted", workspaceId });
    return true;
  }

  static setImportedPromptRecallIgnored(
    workspaceId: string,
    memoryId: string,
    ignored: boolean,
  ): Memory | null {
    this.ensureInitialized();

    const memory = this.memoryRepo.findById(memoryId);
    if (!memory || memory.workspaceId !== workspaceId) return null;
    if (!this.isImportedMemoryContent(memory.content)) return null;

    const nextContent = ignored
      ? this.applyPromptRecallIgnoreMarker(memory.content)
      : this.stripPromptRecallIgnoreMarker(memory.content);
    if (nextContent === memory.content) return memory;

    this.memoryRepo.update(memoryId, {
      content: nextContent,
      tokens: estimateTokens(nextContent),
    });

    try {
      this.embeddingRepo.deleteByMemoryIds([memoryId]);
    } catch {
      // ignore
    }

    this.importedEmbeddings.delete(memoryId);
    const updated = this.memoryRepo.findById(memoryId);
    if (updated) {
      memoryEvents.emit("memoryChanged", { type: "importedEntryUpdated", workspaceId });
      return updated;
    }
    return null;
  }

  /**
   * Delete all imported memories for a workspace
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
    for (const [memoryId, entry] of this.importedEmbeddings.entries()) {
      if (entry.workspaceId === workspaceId) {
        this.importedEmbeddings.delete(memoryId);
      }
    }
    this.memoryEmbeddingsByWorkspace.delete(workspaceId);
    this.embeddingsLoadedForWorkspace.delete(workspaceId);
    this.embeddingBackfillInProgress.delete(workspaceId);
    memoryEvents.emit("memoryChanged", { type: "importedDeleted", workspaceId });
    return deleted;
  }

  static importFromText(options: {
    workspaceId: string;
    provider: string;
    pastedText: string;
    forcePrivate?: boolean;
  }): {
    success: boolean;
    entriesDetected: number;
    memoriesCreated: number;
    duplicatesSkipped: number;
    truncated: number;
    errors: string[];
  } {
    this.ensureInitialized();

    const settings = this.settingsRepo.getOrCreate(options.workspaceId);
    if (!settings.enabled) {
      throw new Error("Memory system is disabled for this workspace. Enable it in settings first.");
    }

    const providerLabel = options.provider.trim().replace(/\s+/g, " ").slice(0, 80) || "Other AI";
    const parsedEntries = this.extractTextImportEntries(options.pastedText);

    if (parsedEntries.length === 0) {
      throw new Error("No memory entries found. Paste the exported memories and try again.");
    }

    const entries = parsedEntries.slice(0, MAX_TEXT_IMPORT_ENTRIES);
    const truncated = Math.max(0, parsedEntries.length - entries.length);

    let memoriesCreated = 0;
    let duplicatesSkipped = 0;
    const errors: string[] = [];
    const seen = new Set<string>();
    const markPrivate = options.forcePrivate ?? true;

    for (const entry of entries) {
      const signature = entry.replace(/\s+/g, " ").trim().toLowerCase();
      if (!signature) {
        duplicatesSkipped += 1;
        continue;
      }
      if (seen.has(signature)) {
        duplicatesSkipped += 1;
        continue;
      }
      seen.add(signature);

      try {
        const sanitized = InputSanitizer.sanitizeMemoryContent(entry).trim();
        if (!sanitized) {
          duplicatesSkipped += 1;
          continue;
        }

        const bounded =
          sanitized.length > MAX_TEXT_IMPORT_ENTRY_CHARS
            ? `${sanitized.slice(0, MAX_TEXT_IMPORT_ENTRY_CHARS)}\n[... truncated]`
            : sanitized;

        const content = `[Imported from ${providerLabel} — "Memory export (pasted)"]\n${bounded}`;

        const memory = this.memoryRepo.create({
          workspaceId: options.workspaceId,
          taskId: undefined,
          type: "insight",
          content,
          tokens: estimateTokens(content),
          isCompressed: false,
          isPrivate: markPrivate,
        });

        // Best-effort: keep hybrid search quality high for imported memories.
        try {
          const embedText = this.normalizeForEmbedding(memory.summary, memory.content);
          const embedding = createLocalEmbedding(embedText);
          this.embeddingRepo.upsert(options.workspaceId, memory.id, embedding, memory.updatedAt);
          this.cacheEmbedding(options.workspaceId, memory.id, embedding, memory.updatedAt);
        } catch {
          // ignore
        }

        const importedSummary = this.buildDeterministicSummary(bounded);
        if (importedSummary) {
          this.updateMemorySummary(memory, options.workspaceId, importedSummary, true);
        }

        memoriesCreated += 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (memoriesCreated > 0) {
      memoryEvents.emit("memoryChanged", { type: "created", workspaceId: options.workspaceId });
      this.enforceStorageLimit(options.workspaceId, settings.maxStorageMb);
    }

    return {
      success: errors.length === 0,
      entriesDetected: parsedEntries.length,
      memoriesCreated,
      duplicatesSkipped,
      truncated,
      errors,
    };
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
    this.clearCompressionStateForWorkspace(workspaceId);
    memoryEvents.emit("memoryChanged", { type: "cleared", workspaceId });
  }

  private static clearCompressionStateForWorkspace(workspaceId: string): void {
    this.compressionBudgetByWorkspace.delete(workspaceId);
    this.compressionDiagnosticsByWorkspace.delete(workspaceId);

    const queued = this.compressionQueue.filter((memoryId) => {
      const entry = this.compressionQueueEntries.get(memoryId);
      if (entry && entry.workspaceId === workspaceId) {
        this.compressionQueueEntries.delete(memoryId);
        return false;
      }
      return true;
    });
    this.compressionQueue = queued;
  }

  static getCompressionDiagnostics(workspaceId?: string): CompressionDiagnostics {
    this.ensureInitialized();

    if (workspaceId) {
      return this.cloneCompressionDiagnostics(
        this.compressionDiagnosticsByWorkspace.get(workspaceId) || this.createCompressionDiagnostics(),
      );
    }

    const aggregate = this.createCompressionDiagnostics();
    for (const diagnostics of this.compressionDiagnosticsByWorkspace.values()) {
      aggregate.captures += diagnostics.captures;
      aggregate.queued += diagnostics.queued;
      aggregate.skipped += diagnostics.skipped;
      aggregate.localCompressed += diagnostics.localCompressed;
      aggregate.batchSummaries += diagnostics.batchSummaries;
      aggregate.llmCalls += diagnostics.llmCalls;
      aggregate.deferred += diagnostics.deferred;
      aggregate.dropped += diagnostics.dropped;
      for (const [origin, count] of Object.entries(diagnostics.originCounts)) {
        aggregate.originCounts[origin] = (aggregate.originCounts[origin] || 0) + count;
      }
    }
    return aggregate;
  }

  private static createCompressionDiagnostics(): CompressionDiagnostics {
    return {
      captures: 0,
      queued: 0,
      skipped: 0,
      localCompressed: 0,
      batchSummaries: 0,
      llmCalls: 0,
      deferred: 0,
      dropped: 0,
      originCounts: {},
    };
  }

  private static cloneCompressionDiagnostics(
    diagnostics: CompressionDiagnostics,
  ): CompressionDiagnostics {
    return {
      captures: diagnostics.captures,
      queued: diagnostics.queued,
      skipped: diagnostics.skipped,
      localCompressed: diagnostics.localCompressed,
      batchSummaries: diagnostics.batchSummaries,
      llmCalls: diagnostics.llmCalls,
      deferred: diagnostics.deferred,
      dropped: diagnostics.dropped,
      originCounts: { ...diagnostics.originCounts },
    };
  }

  private static getCompressionDiagnosticsForWorkspace(workspaceId: string): CompressionDiagnostics {
    const existing = this.compressionDiagnosticsByWorkspace.get(workspaceId);
    if (existing) return existing;
    const created = this.createCompressionDiagnostics();
    this.compressionDiagnosticsByWorkspace.set(workspaceId, created);
    return created;
  }

  private static recordCompressionDiagnostic(
    workspaceId: string,
    origin: MemoryCaptureOrigin,
    field: keyof Omit<CompressionDiagnostics, "originCounts">,
  ): void {
    const diagnostics = this.getCompressionDiagnosticsForWorkspace(workspaceId);
    diagnostics[field] += 1;
    diagnostics.originCounts[origin] = (diagnostics.originCounts[origin] || 0) + 1;
  }

  private static recordCompressionCapture(workspaceId: string, origin: MemoryCaptureOrigin): void {
    const diagnostics = this.getCompressionDiagnosticsForWorkspace(workspaceId);
    diagnostics.captures += 1;
    diagnostics.originCounts[origin] = (diagnostics.originCounts[origin] || 0) + 1;
  }

  /**
   * Pause background compression to avoid contention during active task execution.
   */
  static pauseCompression(): void {
    this.compressionPauseCount += 1;
  }

  /**
   * Resume background compression and drain any queued items.
   */
  static resumeCompression(): void {
    if (this.compressionPauseCount > 0) {
      this.compressionPauseCount -= 1;
    }
    if (!this.isCompressionPaused() && this.compressionQueue.length > 0) {
      this.scheduleCompressionDrain(0);
    }
  }

  private static isCompressionPaused(): boolean {
    return this.compressionPauseCount > 0;
  }

  static applyExecutionSideChannelPolicy(
    mode: "paused" | "limited" | "enabled",
    maxCallsPerWindow = 2,
  ): void {
    this.sideChannelPolicyDepth += 1;
    this.sideChannelDuringExecution = mode;
    this.sideChannelMaxCallsPerWindow = Math.max(0, Math.floor(maxCallsPerWindow));
    this.sideChannelCallsRemaining = mode === "limited" ? this.sideChannelMaxCallsPerWindow : null;

    if (mode === "paused") {
      if (!this.sideChannelPolicyPaused) {
        this.pauseCompression();
        this.sideChannelPolicyPaused = true;
      }
      return;
    }

    if (this.sideChannelPolicyPaused) {
      this.sideChannelPolicyPaused = false;
      this.resumeCompression();
    }
    if (this.compressionQueue.length > 0) {
      this.scheduleCompressionDrain(0);
    }
  }

  static clearExecutionSideChannelPolicy(): void {
    if (this.sideChannelPolicyDepth > 0) {
      this.sideChannelPolicyDepth -= 1;
    }
    if (this.sideChannelPolicyDepth > 0) return;

    this.sideChannelDuringExecution = "enabled";
    this.sideChannelCallsRemaining = null;
    if (this.sideChannelPolicyPaused) {
      this.sideChannelPolicyPaused = false;
      this.resumeCompression();
    }
    if (this.compressionQueue.length > 0) {
      this.scheduleCompressionDrain(0);
    }
  }

  private static canExecuteSideChannelCall(): boolean {
    if (this.sideChannelPolicyDepth <= 0) return true;
    if (this.sideChannelDuringExecution === "enabled") return true;
    if (this.sideChannelDuringExecution === "paused") return false;
    if (this.sideChannelCallsRemaining === null) {
      this.sideChannelCallsRemaining = this.sideChannelMaxCallsPerWindow;
    }
    if (this.sideChannelCallsRemaining <= 0) return false;
    this.sideChannelCallsRemaining -= 1;
    return true;
  }

  private static shouldQueueCompression(input: {
    type: MemoryType;
    content: string;
    tokens: number;
    origin: MemoryCaptureOrigin;
    batchable: boolean;
    priority: MemoryCompressionPriority;
  }): boolean {
    if (!input.batchable) return false;
    if (input.type === "summary" || input.type === "correction_rule") return false;
    if (input.priority === "low") return false;

    const structured = this.isStructuredLowValueContent(input.content);
    if (structured && input.type === "observation") return false;

    if (input.origin === "heartbeat") {
      return input.tokens >= MIN_TOKENS_FOR_OBSERVATION_COMPRESSION || input.priority === "high";
    }

    if (input.type === "observation" || input.type === "insight") {
      return input.tokens >= MIN_TOKENS_FOR_OBSERVATION_COMPRESSION;
    }

    if (
      input.type === "decision" ||
      input.type === "error" ||
      input.type === "preference" ||
      input.type === "constraint" ||
      input.type === "timing_preference" ||
      input.type === "workflow_pattern"
    ) {
      return input.tokens >= MIN_TOKENS_FOR_COMPRESSION;
    }

    return input.tokens >= MIN_TOKENS_FOR_COMPRESSION;
  }

  private static deriveCompressionPriority(
    type: MemoryType,
    content: string,
    tokens: number,
    origin: MemoryCaptureOrigin,
    explicitPriority?: MemoryCompressionPriority,
  ): MemoryCompressionPriority {
    if (explicitPriority) return explicitPriority;

    if (type === "summary" || type === "correction_rule") return "low";
    if (type === "decision" || type === "error") {
      return tokens >= MIN_TOKENS_FOR_COMPRESSION ? "high" : "normal";
    }
    if (type === "preference" || type === "constraint" || type === "timing_preference") {
      return tokens >= 60 ? "normal" : "low";
    }
    if (type === "workflow_pattern") {
      return tokens >= 80 ? "normal" : "low";
    }
    if (origin === "heartbeat") {
      return tokens >= MIN_TOKENS_FOR_OBSERVATION_COMPRESSION ? "normal" : "low";
    }
    if (this.isStructuredLowValueContent(content) && tokens < MIN_TOKENS_FOR_OBSERVATION_COMPRESSION) {
      return "low";
    }
    if (tokens >= MIN_TOKENS_FOR_OBSERVATION_COMPRESSION) return "normal";
    return "low";
  }

  private static buildCompressionBatchKey(
    workspaceId: string,
    taskId: string | undefined,
    origin: MemoryCaptureOrigin,
    createdAt: number,
    explicitBatchKey?: string,
    signalFamily?: string,
  ): string {
    if (explicitBatchKey) return explicitBatchKey;
    if (taskId) return `task:${taskId}`;
    if (origin === "heartbeat") {
      const family = signalFamily?.trim() || "heartbeat";
      return `heartbeat:${workspaceId}:${family}:${Math.floor(createdAt / HEARTBEAT_BATCH_WINDOW_MS)}`;
    }
    return `${origin}:${workspaceId}:${Math.floor(createdAt / HEARTBEAT_BATCH_WINDOW_MS)}`;
  }

  private static isHighSignalMemoryType(type: MemoryType): boolean {
    return (
      type === "decision" ||
      type === "error" ||
      type === "preference" ||
      type === "constraint" ||
      type === "timing_preference" ||
      type === "workflow_pattern" ||
      type === "correction_rule" ||
      type === "summary"
    );
  }

  private static isStructuredLowValueContent(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return true;
    if (trimmed.includes("```")) return true;
    if (trimmed.length <= 80) return false;

    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length >= 4) {
      const bulletCount = lines.filter((line) => /^([-*]|\d+[.)])\s+/.test(line)).length;
      if (bulletCount >= 2) return true;
    }

    const colonCount = (trimmed.match(/:/g) || []).length;
    if (colonCount >= 6 && lines.length >= 3) return true;

    return false;
  }

  private static buildDeterministicSummary(content: string): string {
    const trimmed = this.stripPromptRecallIgnoreMarker(content).trim();
    if (!trimmed) return "";

    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let summary = lines.find((line) => !line.startsWith("```")) || lines[0] || trimmed;
    summary = summary.replace(/\s+/g, " ").trim();
    if (summary.length > LOCAL_SUMMARY_MAX_CHARS) {
      summary = `${summary.slice(0, LOCAL_SUMMARY_MAX_CHARS - 3)}...`;
    }
    return summary;
  }

  private static normalizeSummaryStorageText(content: string, maxChars = 1200): string {
    const trimmed = this.stripPromptRecallIgnoreMarker(content).trim();
    if (!trimmed) return "";
    const normalized = trimmed.replace(/\n{3,}/g, "\n\n");
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars - 3)}...`;
  }

  private static updateMemorySummary(
    memory: Memory,
    workspaceId: string,
    summary: string,
    compressed: boolean,
  ): void {
    const finalSummary = this.buildDeterministicSummary(summary);
    if (!finalSummary) return;

    const summaryTokens = estimateTokens(finalSummary);
    const updatedAt = Date.now();
    this.memoryRepo.update(memory.id, {
      summary: finalSummary,
      tokens: summaryTokens,
      isCompressed: compressed,
    });
    memory.summary = finalSummary;
    memory.tokens = summaryTokens;
    memory.isCompressed = compressed;
    memory.updatedAt = updatedAt;

    try {
      const embedText = this.normalizeForEmbedding(finalSummary, finalSummary);
      const embedding = createLocalEmbedding(embedText);
      this.embeddingRepo.upsert(workspaceId, memory.id, embedding, updatedAt);
      this.cacheEmbedding(workspaceId, memory.id, embedding, updatedAt);
    } catch {
      // ignore
    }
  }

  private static enqueueCompression(memoryId: string, entry: CompressionQueueEntry): void {
    if (this.compressionQueueEntries.has(memoryId)) return;
    this.compressionQueueEntries.set(memoryId, entry);
    this.compressionQueue.push(memoryId);
    this.recordCompressionDiagnostic(entry.workspaceId, entry.origin, "queued");
    this.scheduleCompressionDrain();
  }

  private static scheduleCompressionDrain(delayMs = COMPRESSION_DRAIN_DELAY_MS): void {
    if (this.compressionDrainTimer) {
      if (delayMs === 0) {
        clearTimeout(this.compressionDrainTimer);
        this.compressionDrainTimer = undefined;
      } else {
        return;
      }
    }
    this.compressionDrainTimer = setTimeout(() => {
      this.compressionDrainTimer = undefined;
      void this.processCompressionQueue();
    }, delayMs);
  }

  private static canSpendCompressionBudget(workspaceId: string): {
    allowed: boolean;
    retryAfterMs: number;
  } {
    const now = Date.now();
    const history = this.compressionBudgetByWorkspace.get(workspaceId) || [];
    const recent = history.filter((timestamp) => now - timestamp < COMPRESSION_BUDGET_WINDOW_MS);
    this.compressionBudgetByWorkspace.set(workspaceId, recent);

    if (recent.length < COMPRESSION_BUDGET_MAX_CALLS) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const oldest = recent[0] ?? now;
    const retryAfterMs = Math.max(1_000, COMPRESSION_BUDGET_WINDOW_MS - (now - oldest));
    return { allowed: false, retryAfterMs };
  }

  private static recordCompressionBudgetUse(workspaceId: string): void {
    const now = Date.now();
    const history = this.compressionBudgetByWorkspace.get(workspaceId) || [];
    history.push(now);
    this.compressionBudgetByWorkspace.set(
      workspaceId,
      history.filter((timestamp) => now - timestamp < COMPRESSION_BUDGET_WINDOW_MS),
    );
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
      const batch = this.compressionQueue.splice(0, COMPRESSION_BATCH_SIZE);
      const grouped = new Map<
        string,
        {
          workspaceId: string;
          batchKey: string;
          origin: MemoryCaptureOrigin;
          priority: MemoryCompressionPriority;
          memoryIds: string[];
          requestedAt: number;
        }
      >();

      for (const memoryId of batch) {
        const entry = this.compressionQueueEntries.get(memoryId);
        if (!entry) continue;
        const key = `${entry.workspaceId}:${entry.batchKey}`;
        const group = grouped.get(key) || {
          workspaceId: entry.workspaceId,
          batchKey: entry.batchKey,
          origin: entry.origin,
          priority: entry.priority,
          memoryIds: [],
          requestedAt: entry.requestedAt,
        };
        group.memoryIds.push(memoryId);
        if (entry.priority === "high") group.priority = "high";
        else if (entry.priority === "normal" && group.priority === "low") group.priority = "normal";
        if (entry.requestedAt < group.requestedAt) group.requestedAt = entry.requestedAt;
        grouped.set(key, group);
      }

      const deferred: string[] = [];

      for (const group of grouped.values()) {
        if (this.isCompressionPaused()) {
          deferred.push(...group.memoryIds);
          continue;
        }

        const memories = group.memoryIds
          .map((memoryId) => this.memoryRepo.findById(memoryId))
          .filter((memory): memory is Memory => Boolean(memory));

        if (memories.length === 0) {
          for (const memoryId of group.memoryIds) {
            this.compressionQueueEntries.delete(memoryId);
          }
          continue;
        }

        const budget = this.canSpendCompressionBudget(group.workspaceId);
        const shouldUseLlm = this.shouldUseLlmForCompressionBatch(group, memories);

        if (!shouldUseLlm) {
          await this.finalizeCompressionBatchLocally(group, memories);
        } else if (!budget.allowed) {
          if (group.priority === "high") {
            this.recordCompressionDiagnostic(group.workspaceId, group.origin, "deferred");
            this.scheduleCompressionRetry(group, budget.retryAfterMs);
            continue;
          }
          await this.finalizeCompressionBatchLocally(group, memories);
          this.recordCompressionDiagnostic(group.workspaceId, group.origin, "dropped");
        } else if (!this.canExecuteSideChannelCall()) {
          this.recordCompressionDiagnostic(group.workspaceId, group.origin, "deferred");
          this.scheduleCompressionRetry(group, COMPRESSION_RETRY_DELAY_MS);
          continue;
        } else {
          await this.compressMemoryBatch(group, memories);
          this.recordCompressionBudgetUse(group.workspaceId);
        }

        for (const memoryId of group.memoryIds) {
          this.compressionQueueEntries.delete(memoryId);
        }
        this.compressionRetryCounts.delete(group.batchKey);
        await new Promise((resolve) => setTimeout(resolve, COMPRESSION_DELAY_MS));
      }

      if (deferred.length > 0) {
        this.compressionQueue.unshift(...deferred);
      }

      if (this.compressionQueue.length > 0 && !this.isCompressionPaused()) {
        this.scheduleCompressionDrain();
      }
    } catch (error) {
      console.error("[MemoryService] Compression queue error:", error);
    } finally {
      this.compressionInProgress = false;
    }
  }

  private static shouldUseLlmForCompressionBatch(
    group: {
      workspaceId: string;
      batchKey: string;
      origin: MemoryCaptureOrigin;
      priority: MemoryCompressionPriority;
      memoryIds: string[];
      requestedAt: number;
    },
    memories: Memory[],
  ): boolean {
    if (group.priority === "low") return false;
    if (memories.length > 1) return true;
    const memory = memories[0];
    if (!memory) return false;
    if (memory.type === "summary" || memory.type === "correction_rule") return false;
    if (this.isStructuredLowValueContent(memory.content)) return false;
    if (this.isHighSignalMemoryType(memory.type)) {
      return memory.tokens >= MIN_TOKENS_FOR_COMPRESSION;
    }
    return memory.tokens >= MIN_TOKENS_FOR_OBSERVATION_COMPRESSION;
  }

  private static async finalizeCompressionBatchLocally(
    group: {
      workspaceId: string;
      batchKey: string;
      origin: MemoryCaptureOrigin;
      priority: MemoryCompressionPriority;
      memoryIds: string[];
      requestedAt: number;
    },
    memories: Memory[],
  ): Promise<void> {
    for (const memory of memories) {
      if (!memory.summary) {
        this.updateMemorySummary(memory, group.workspaceId, this.buildDeterministicSummary(memory.content), true);
      }
    }

    if (memories.length > 1) {
      const digest = this.buildBatchDigest(group, memories);
      await this.createBatchSummaryMemory(group, memories, digest, false);
    }

    for (const memoryId of group.memoryIds) {
      this.compressionQueueEntries.delete(memoryId);
    }

    this.recordCompressionDiagnostic(group.workspaceId, group.origin, "localCompressed");
    console.log(
      `[MemoryService] Compression batch workspace=${group.workspaceId} origin=${group.origin} batchKey=${group.batchKey} items=${memories.length} mode=local`,
    );
  }

  private static buildBatchDigest(
    group: {
      workspaceId: string;
      batchKey: string;
      origin: MemoryCaptureOrigin;
      priority: MemoryCompressionPriority;
      memoryIds: string[];
      requestedAt: number;
    },
    memories: Memory[],
  ): string {
    const lines = memories.slice(0, 8).map((memory) => {
      const summary = memory.summary || this.buildDeterministicSummary(memory.content);
      return `- [${memory.type}] ${summary}`;
    });
    const extraCount = memories.length - lines.length;
    const header = `[${group.origin} digest] ${group.batchKey}`;
    const suffix = extraCount > 0 ? `- ... ${extraCount} more` : "";
    return [header, ...lines, suffix].filter(Boolean).join("\n");
  }

  private static buildBatchSummaryPrompt(
    group: {
      workspaceId: string;
      batchKey: string;
      origin: MemoryCaptureOrigin;
      priority: MemoryCompressionPriority;
      memoryIds: string[];
      requestedAt: number;
    },
    memories: Memory[],
  ): { system: string; user: string } {
    const lines = memories.slice(0, 12).map((memory) => {
      const summary = this.buildDeterministicSummary(memory.summary || memory.content);
      return `- [${memory.type}] ${summary}`;
    });
    const truncatedCount = Math.max(0, memories.length - lines.length);
    const user = [
      `Workspace: ${group.workspaceId}`,
      `Batch key: ${group.batchKey}`,
      `Origin: ${group.origin}`,
      `Items: ${memories.length}`,
      truncatedCount > 0 ? `Additional items omitted: ${truncatedCount}` : "",
      "",
      "Summaries:",
      ...lines,
      "",
      "Write a concise durable memory digest with:",
      "Title:",
      "- one short line",
      "Highlights:",
      "- 1-4 bullets focused on durable outcomes, decisions, or blockers",
      "Open loops:",
      "- optional bullets only if there are unresolved items",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      system: "You write compact durable memory digests for agent work. Be factual, concise, and avoid filler.",
      user,
    };
  }

  private static async compressMemoryBatch(
    group: {
      workspaceId: string;
      batchKey: string;
      origin: MemoryCaptureOrigin;
      priority: MemoryCompressionPriority;
      memoryIds: string[];
      requestedAt: number;
    },
    memories: Memory[],
  ): Promise<void> {
    const { summaryText, usedLlm } = await this.generateBatchSummaryText(group, memories);
    const storageSummary = this.normalizeSummaryStorageText(summaryText);
    if (memories.length === 1) {
      this.updateMemorySummary(memories[0], group.workspaceId, storageSummary, true);
      this.recordCompressionDiagnostic(group.workspaceId, group.origin, "batchSummaries");
      if (usedLlm) {
        this.recordCompressionDiagnostic(group.workspaceId, group.origin, "llmCalls");
      }
      for (const memoryId of group.memoryIds) {
        this.compressionQueueEntries.delete(memoryId);
      }
      return;
    }

    await this.createBatchSummaryMemory(group, memories, storageSummary, true);
    for (const memoryId of group.memoryIds) {
      this.compressionQueueEntries.delete(memoryId);
    }
    this.recordCompressionDiagnostic(group.workspaceId, group.origin, "batchSummaries");
    if (usedLlm) {
      this.recordCompressionDiagnostic(group.workspaceId, group.origin, "llmCalls");
    }
    console.log(
      `[MemoryService] Compression batch workspace=${group.workspaceId} origin=${group.origin} batchKey=${group.batchKey} items=${memories.length} mode=${usedLlm ? "llm" : "deterministic"}`,
    );
  }

  private static async generateBatchSummaryText(
    group: {
      workspaceId: string;
      batchKey: string;
      origin: MemoryCaptureOrigin;
      priority: MemoryCompressionPriority;
      memoryIds: string[];
      requestedAt: number;
    },
    memories: Memory[],
  ): Promise<{ summaryText: string; usedLlm: boolean }> {
    const { system, user } = this.buildBatchSummaryPrompt(group, memories);
    let providerType = "";
    let modelId = "";

    try {
      const provider = LLMProviderFactory.createProvider();
      providerType = provider.type;
      const settings = LLMProviderFactory.getSettings();
      const azureDeployment = settings.azure?.deployment || settings.azure?.deployments?.[0];
      const azureAnthropicDeployment =
        settings.azureAnthropic?.deployment || settings.azureAnthropic?.deployments?.[0];
      modelId = LLMProviderFactory.getModelId(
        settings.modelKey,
        settings.providerType,
        settings.ollama?.model,
        settings.gemini?.model,
        settings.openrouter?.model,
        settings.openai?.model,
        azureDeployment,
        azureAnthropicDeployment,
        settings.groq?.model,
        settings.xai?.model,
        settings.kimi?.model,
        settings.customProviders,
        settings.bedrock?.model,
      );

      const response = await provider.createMessage({
        model: modelId,
        maxTokens: 160,
        system,
        messages: [
          {
            role: "user",
            content: user,
          },
        ],
      });
      recordLlmCallSuccess(
        {
          workspaceId: group.workspaceId,
          sourceKind: "memory_batch_summary",
          sourceId: group.batchKey,
          providerType,
          modelKey: modelId,
          modelId,
        },
        response.usage,
      );

      let summary = "";
      for (const content of response.content) {
        if (content.type === "text") summary += content.text;
      }
      summary = this.buildDeterministicSummary(summary);
      if (summary) return { summaryText: summary, usedLlm: true };
    } catch (error) {
      recordLlmCallError(
        {
          workspaceId: group.workspaceId,
          sourceKind: "memory_batch_summary",
          sourceId: group.batchKey,
          providerType,
          modelKey: modelId,
          modelId,
        },
        error,
      );
      console.warn("[MemoryService] Batch compression failed:", group.batchKey, error);
    }

    return { summaryText: this.buildBatchDigest(group, memories), usedLlm: false };
  }

  private static async createBatchSummaryMemory(
    group: {
      workspaceId: string;
      batchKey: string;
      origin: MemoryCaptureOrigin;
      priority: MemoryCompressionPriority;
      memoryIds: string[];
      requestedAt: number;
    },
    memories: Memory[],
    summaryText: string,
    compressed: boolean,
  ): Promise<void> {
    const summary = this.normalizeSummaryStorageText(summaryText);
    if (!summary) return;

    const taskId = this.extractSharedTaskId(memories);
    const batchMemory = this.memoryRepo.create({
      workspaceId: group.workspaceId,
      taskId,
      type: "summary",
      content: summary,
      summary,
      tokens: estimateTokens(summary),
      isCompressed: compressed,
      isPrivate: false,
    });

    this.updateEmbeddingForMemory(batchMemory, group.workspaceId, summary);
  }

  private static extractSharedTaskId(memories: Memory[]): string | undefined {
    if (memories.length === 0) return undefined;
    const firstTaskId = memories[0].taskId;
    if (!firstTaskId) return undefined;
    for (const memory of memories) {
      if (memory.taskId !== firstTaskId) return undefined;
    }
    return firstTaskId;
  }

  private static updateEmbeddingForMemory(
    memory: Memory,
    workspaceId: string,
    summary: string,
  ): void {
    try {
      const embedText = this.normalizeForEmbedding(summary, summary);
      const embedding = createLocalEmbedding(embedText);
      this.embeddingRepo.upsert(workspaceId, memory.id, embedding, memory.updatedAt);
      this.cacheEmbedding(workspaceId, memory.id, embedding, memory.updatedAt);
    } catch {
      // ignore
    }
  }

  private static scheduleCompressionRetry(
    group: {
      workspaceId: string;
      batchKey: string;
      origin: MemoryCaptureOrigin;
      priority: MemoryCompressionPriority;
      memoryIds: string[];
      requestedAt: number;
    },
    delayMs: number,
  ): void {
    const attempts = (this.compressionRetryCounts.get(group.batchKey) || 0) + 1;
    if (attempts > MAX_COMPRESSION_RETRIES) {
      this.compressionRetryCounts.delete(group.batchKey);
      this.recordCompressionDiagnostic(group.workspaceId, group.origin, "dropped");
      console.warn(
        `[MemoryService] Compression retry limit reached for batch ${group.batchKey}; giving up.`,
      );
      return;
    }

    this.compressionRetryCounts.set(group.batchKey, attempts);
    const retryDelayMs = Math.max(delayMs, COMPRESSION_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1));
    setTimeout(() => {
      for (const memoryId of group.memoryIds) {
        if (!this.compressionQueue.includes(memoryId)) {
          this.compressionQueue.push(memoryId);
        }
      }
      this.scheduleCompressionDrain(0);
    }, retryDelayMs);
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

      // Tier promotion pass: promote short→medium→long, evict stale short-tier memories
      if (this.db) {
        MemoryTierService.runPromotionPass(this.db);
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
    if (this.compressionDrainTimer) {
      clearTimeout(this.compressionDrainTimer);
      this.compressionDrainTimer = undefined;
    }
    memoryEvents.removeAllListeners();
    this.memoryEmbeddingsByWorkspace.clear();
    this.importedEmbeddings.clear();
    this.markdownIndex = null;
    this.importedEmbeddingsLoaded = false;
    this.importedEmbeddingBackfillInProgress = false;
    this.embeddingsLoadedForWorkspace.clear();
    this.embeddingBackfillInProgress.clear();
    this.compressionQueue = [];
    this.compressionQueueEntries.clear();
    this.compressionRetryCounts.clear();
    this.compressionBudgetByWorkspace.clear();
    this.compressionDiagnosticsByWorkspace.clear();
    this.initialized = false;
    console.log("[MemoryService] Shutdown complete");
  }
}
