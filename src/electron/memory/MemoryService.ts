/**
 * Memory Service
 *
 * Core service for the persistent memory system.
 * Handles capture, compression, search, and context injection.
 */

import { WorkspaceRepository } from "../database/repository-facades";
import { isSafeExcludedPattern } from "./excluded-patterns";
import { MemoryEmbeddingRepository, MemoryRepository } from "../database/repository-facades";
import { MemorySettingsRepository } from "../database/repository-facades";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";
import { randomUUID } from "crypto";
import type { DatabaseManager } from "../database/schema";
import {
  Memory,
  MemorySettings,
  MemorySearchResult,
  MemoryTimelineEntry,
  MemoryType,
  MemoryStats,
  onMemoryEmbeddingChange,
} from "../database/repositories";
import type { MemoryEmbeddingRow } from "../database/memory-embedding-sql";
import type { CapturedMemoryResult, CapturedMemoryWrite } from "./memory-capture-sql";
import { observationContentHash } from "./memory-observation-sql";
import { LLMProviderFactory } from "../agent/llm";
import { recordLlmCallError, recordLlmCallSuccess } from "../agent/llm/usage-telemetry";
import { estimateTokens } from "../agent/context-manager";
import { InputSanitizer } from "../agent/security";
import { createLocalEmbedding } from "./local-embedding";
import { planHybridMemories, wantsSemanticStage } from "./memory-hybrid-rank";
import {
  MarkdownMemoryIndexService,
  type MarkdownMemoryReadGuard,
} from "./MarkdownMemoryIndexService";
import { MemoryTierService } from "./MemoryTierService";
import { SupermemoryService } from "./SupermemoryService";
import { SupermemoryRemoteRefRepository } from "./SupermemoryRemoteRefRepository";
import { MemoryWriter, memoryTextSalience } from "./MemoryWriter";
import { InFlightWork } from "../utils/in-flight-work";
import { MemoryObservationService } from "./MemoryObservationService";
import { MemoryWriteGate, type MemoryWriteOrigin } from "./MemoryWriteGate";
import type { CoreMemoryScopeKind } from "../../shared/types";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { createLogger } from "../utils/logger";
import { containsNoMemoryDirective } from "./no-memory-directive";
import { REDACTED_SECRET, redactSecrets } from "./sensitive-content";
import type { MemoryItemKind } from "./memory-items-types";
import { neutralizeReservedImportPrefix } from "./memory-visibility";

// Secret values are redacted before storage by `redactSecrets` (./sensitive-content);
// merely mentioning auth, tokens or `.env` no longer hides a memory.

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
const COMPRESSION_BATCH_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_SUMMARY_MAX_CHARS = 220;
const logger = createLogger("MemoryService");

type MemoryCaptureOrigin =
  | "task"
  | "tool"
  | "chronicle"
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
  skipMemoryWriteGate?: boolean;
  /**
   * Allow an explicit write to proceed when auto-capture is off: a user-enabled source
   * sync, or an explicit agent save (`memory_remember`). Auto-capture only governs automatic
   * archiving of task activity.
   */
  forceCapture?: boolean;
  /** Permit the optional external-memory mirror for this capture. */
  allowExternalMirror?: boolean;
  /** The caller knows the task or message opted out with `<no-memory>`: store nothing. */
  noMemory?: boolean;
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

export interface PromptRecallDiagnostics {
  queries: number;
  workerUnavailable: number;
  workerFailures: number;
  workerEmptyResults: number;
  workerHits: number;
  lastFailureAt: number | null;
  lastFailureMessage: string | null;
}

/** `source_ref.store` of facts written by the import API; `id` is the archive row. */
export const IMPORT_FACT_STORE = "import";

const IMPORT_HEADER_PREFIX = "[Imported from ";

/** The text of an imported archive row without its `[Imported from …]` header line. */
function importedBody(content: string): string {
  const trimmed = String(content || "").trimStart();
  if (!trimmed.startsWith(IMPORT_HEADER_PREFIX)) return trimmed.trim();
  const newline = trimmed.indexOf("\n");
  return newline === -1 ? "" : trimmed.slice(newline + 1).trim();
}

/** One line, starting with the reserved import prefix (only importers may write it). */
function normalizeImportHeader(header: string): string {
  const line = String(header || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  if (line.startsWith(IMPORT_HEADER_PREFIX)) return line;
  return `${IMPORT_HEADER_PREFIX}${line.replace(/^\[|\]$/g, "") || "an import"}]`;
}

export interface MemoryImportEntry {
  type: "observation" | "decision" | "insight";
  /** The imported text; sanitized, redacted and deduplicated by the session. */
  body: string;
  /** Provenance line, `[Imported from <source> — "<title>"]`. */
  header: string;
  /** A fact about the user: also written to `memory_items` as an `import` item. */
  fact?: { kind: MemoryItemKind; importer: string; conversationId?: string };
}

export type MemoryImportOutcome =
  | { status: "created"; memory: Memory; factItemId?: string }
  | { status: "duplicate" }
  | {
      status: "filtered";
      reason: "no_memory" | "empty" | "low_salience" | "secret_only" | "excluded";
    };

export interface MemoryImportSession {
  readonly workspaceId: string;
  /** Rows of this session are private (forced, or strict privacy mode). */
  readonly isPrivate: boolean;
  add(entry: MemoryImportEntry): Promise<MemoryImportOutcome>;
  /** Apply the storage cap; call once after the last entry. */
  finish(): Promise<{ created: number }>;
}

export class MemoryService {
  private static memoryRepo: MemoryRepository;
  private static embeddingRepo: MemoryEmbeddingRepository;
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
  // Embedding cache loads read through the async storage facade: callers share an
  // in-flight load, and a load merges into entries cached while it ran.
  private static embeddingLoads = new Map<string, Promise<void>>();
  private static importedEmbeddingsLoad: Promise<void> | null = null;
  // Bumped when the caches are invalidated, so a load that started before drops its rows.
  private static embeddingCacheGeneration = 0;
  private static embeddingBackfillInProgress = new Set<string>();
  private static initialized = false;
  private static compressionQueue: string[] = [];
  private static compressionQueueEntries = new Map<string, CompressionQueueEntry>();
  private static compressionRetryCounts = new Map<string, number>();
  private static compressionInProgress = false;
  private static compressionPauseCount = 0;
  private static compressionDrainTimer?: ReturnType<typeof setTimeout>;
  /** Pending compression retries; cleared at shutdown so none fires against a closed DB. */
  private static compressionRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private static compressionBudgetByWorkspace = new Map<string, number[]>();
  private static compressionDiagnosticsByWorkspace = new Map<string, CompressionDiagnostics>();
  private static sideChannelPolicyDepth = 0;
  private static sideChannelDuringExecution: "paused" | "limited" | "enabled" = "enabled";
  private static sideChannelMaxCallsPerWindow = 2;
  private static sideChannelCallsRemaining: number | null = null;
  private static sideChannelPolicyPaused = false;
  private static cleanupIntervalHandle?: ReturnType<typeof setInterval>;
  /**
   * Async work that writes to the database: compression batches, markdown index syncs,
   * cleanup runs and the archive migration. `drain()` waits for it before shutdown.
   */
  private static inFlight = new InFlightWork();
  /** Set by `drain()`: no new compression batch, markdown sync or cleanup starts. */
  private static draining = false;
  /** Bound for `drain()` at shutdown. */
  static readonly DRAIN_TIMEOUT_MS = 5_000;
  private static db?: import("better-sqlite3").Database;
  /** The memory domain's statement port (DB6). */
  private static sql?: MemoryStatementPort;
  private static workspaceRepo?: WorkspaceRepository;
  private static unsubscribeMemoryItemChanges?: () => void;
  private static ftsWorker: import("../database/FtsWorkerClient").FtsWorkerClient | null = null;
  private static storageEstimateByWorkspace = new Map<
    string,
    { bytes: number; measuredAt: number }
  >();
  private static readonly STORAGE_ESTIMATE_MAX_AGE_MS = 5 * 60 * 1000;
  private static readonly STORAGE_ESTIMATE_HEADROOM = 0.8;

  private static promptRecallCache = new Map<
    string,
    { results: MemorySearchResult[]; createdAt: number }
  >();
  private static readonly PROMPT_RECALL_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly PROMPT_RECALL_CACHE_MAX_ENTRIES = 32;
  private static promptRecallDiagnostics: PromptRecallDiagnostics = {
    queries: 0,
    workerUnavailable: 0,
    workerFailures: 0,
    workerEmptyResults: 0,
    workerHits: 0,
    lastFailureAt: null,
    lastFailureMessage: null,
  };

  /**
   * Initialize the memory service. `backgroundJobs: false` (desktop quiet mode) skips the
   * periodic cleanup and the deferred one-time archive cleanup.
   */
  static initialize(
    dbManager: DatabaseManager,
    options: { backgroundJobs?: boolean } = {},
  ): void {
    if (this.initialized) return;
    this.draining = false;

    const db = dbManager.getDatabase();
    this.db = db;
    this.sql = createMemoryStatementPort(db);
    MemoryWriteGate.initialize(dbManager);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.memoryRepo = new MemoryRepository(db);
    this.embeddingRepo = new MemoryEmbeddingRepository(db);
    this.settingsRepo = new MemorySettingsRepository(db);
    this.markdownIndex = new MarkdownMemoryIndexService(db);
    MemoryObservationService.initialize(db);
    // Remote ids of Supermemory copies (SEC-17), so deletes here can forget them there.
    SupermemoryRemoteRefRepository.initialize(this.sql);
    // Inspector edits (delete, redact, privacy changes) must not be served from cache, and
    // a suppressed or redacted row's Supermemory copy is forgotten.
    MemoryObservationService.onVisibilityChanged(() => {
      this.clearPromptRecallCache();
      SupermemoryService.scheduleOrphanSweep();
    });
    // A deleted or archived memory item (Memory Hub, memory_forget) loses its copy too.
    this.unsubscribeMemoryItemChanges?.();
    this.unsubscribeMemoryItemChanges = MemoryWriter.onChange((change) => {
      if (change.kind === "status") SupermemoryService.scheduleOrphanSweep();
    });
    this.initialized = true;

    if (options.backgroundJobs === false) {
      logger.info("[MemoryService] Initialized (background cleanup not started)");
      return;
    }

    // Start periodic cleanup
    // runCleanup handles and logs its own errors.
    this.cleanupIntervalHandle = setInterval(() => {
      if (this.draining) return;
      void this.inFlight.track(this.runCleanup());
    }, CLEANUP_INTERVAL_MS);

    this.scheduleArchiveCleanupMigration();

    logger.info("[MemoryService] Initialized");
  }

  private static archiveCleanupTimer?: ReturnType<typeof setTimeout>;
  private static readonly ARCHIVE_CLEANUP_DELAY_MS = 90_000;

  /**
   * The one-time archive cleanup (MemoryCleanupMigration) runs well after startup so it
   * never competes with the first task; it records a marker and is a no-op afterwards.
   */
  private static scheduleArchiveCleanupMigration(): void {
    if (this.archiveCleanupTimer) return;
    this.archiveCleanupTimer = setTimeout(() => {
      this.archiveCleanupTimer = undefined;
      if (this.draining) return;
      void this.inFlight.track(this.runArchiveCleanupMigration());
    }, MemoryService.ARCHIVE_CLEANUP_DELAY_MS);
    this.archiveCleanupTimer.unref?.();
  }

  /** Run the one-time archive cleanup now (idempotent); exposed for tests and tooling. */
  static async runArchiveCleanupMigration(): Promise<void> {
    const db = this.db;
    if (!this.initialized || !db) return;
    try {
      const { runMemoryCleanupMigration } = await import("./MemoryCleanupMigration");
      const result = await runMemoryCleanupMigration(db, {
        yieldBetweenPhases: () => new Promise((resolve) => setImmediate(resolve)),
      });
      if (!result.ran) return;
      logger.info("[MemoryService] Archive cleanup migration completed", result.counts);
      if (result.memoryIds.length > 0) {
        this.ftsWorker?.invalidateEmbeddings({ kind: "memories", memoryIds: result.memoryIds });
      }
      for (const workspaceId of result.workspaceIds) {
        this.memoryEmbeddingsByWorkspace.delete(workspaceId);
        this.embeddingsLoadedForWorkspace.delete(workspaceId);
        this.embeddingBackfillInProgress.delete(workspaceId);
        this.storageEstimateByWorkspace.delete(workspaceId);
      }
      for (const memoryId of result.memoryIds) this.importedEmbeddings.delete(memoryId);
      this.embeddingCacheGeneration += 1;
      this.promptRecallCache.clear();
    } catch (error) {
      logger.warn("[MemoryService] Archive cleanup migration failed:", error);
    }
  }

  /** The profile database, for narrow indexes kept beside memories (Playbook evidence). */
  static getDatabase(): import("better-sqlite3").Database | undefined {
    return this.initialized ? this.db : undefined;
  }

  /** The memory statement port, for services kept beside memories. */
  static getStatements(): MemoryStatementPort | undefined {
    return this.initialized ? this.sql : undefined;
  }

  static initFtsWorker(worker: import("../database/FtsWorkerClient").FtsWorkerClient): void {
    this.ftsWorker = worker;
    // The worker ranks with its own embedding cache (DB4); every persisted change
    // reaches it through the repository.
    this.unsubscribeEmbeddingChanges?.();
    this.unsubscribeEmbeddingChanges = onMemoryEmbeddingChange((change) =>
      worker.invalidateEmbeddings(change),
    );
  }

  private static unsubscribeEmbeddingChanges: (() => void) | null = null;

  /**
   * Sync workspace markdown index (kit notes, docs, etc.)
   * This is optional; failures should not impact the core memory system.
   */
  static async syncWorkspaceMarkdown(
    workspaceId: string,
    workspacePath: string,
    force = false,
    readGuard?: MarkdownMemoryReadGuard,
  ): Promise<void> {
    this.ensureInitialized();
    if (!this.markdownIndex || this.draining) return;
    await this.inFlight.track(
      this.markdownIndex.syncWorkspace(workspaceId, workspacePath, force, undefined, readGuard),
    );
  }

  /**
   * Search indexed markdown within a workspace path (best-effort).
   * Intended for retrieving durable workspace notes such as `.cowork/` memory files.
   */
  static async searchWorkspaceMarkdown(
    workspaceId: string,
    workspacePath: string,
    query: string,
    limit = 10,
    readGuard?: MarkdownMemoryReadGuard,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    if (!this.markdownIndex || this.draining) return [];
    try {
      // A search syncs the index first, so it is tracked like a sync.
      return await this.inFlight.track(
        this.markdownIndex.search(workspaceId, workspacePath, query, limit, readGuard),
      );
    } catch {
      return [];
    }
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

    // The shared hygiene of every memory producer (docs/memory-engine.md §1): `<no-memory>`
    // (in the text or known by the caller), the salience gate, then settings, redaction,
    // privacy and content-hash dedupe below.
    if (options?.noMemory || containsNoMemoryDirective(content)) {
      return null;
    }
    if (memoryTextSalience(content)) {
      return null;
    }

    // Check settings
    const settings = await this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled || (!settings.autoCapture && !options?.forceCapture)) {
      return null;
    }

    // Check privacy mode
    if (settings.privacyMode === "disabled") {
      return null;
    }

    const compressionOrigin = options?.origin ?? (taskId ? "task" : "unknown");
    const privacyPrepared = this.applyInlinePrivacy(content);
    // Secret values never reach storage; the rest of the text is kept.
    privacyPrepared.content = redactSecrets(privacyPrepared.content).text;
    // Only importers may write rows that read as imported (those are global).
    if (compressionOrigin !== "import") {
      privacyPrepared.content = neutralizeReservedImportPrefix(privacyPrepared.content);
    }

    // Check excluded patterns
    if (this.shouldExclude(privacyPrepared.content, settings)) {
      return null;
    }

    const finalIsPrivate =
      isPrivate || privacyPrepared.hadPrivateBlock || settings.privacyMode === "strict";

    // Estimate tokens
    const tokens = estimateTokens(privacyPrepared.content);

    // Truncate very long content
    const truncatedContent =
      privacyPrepared.content.length > 10000
        ? privacyPrepared.content.slice(0, 10000) + "\n[... truncated]"
        : privacyPrepared.content;

    if (!options?.skipMemoryWriteGate) {
      const gate = await MemoryWriteGate.evaluate({
        workspaceId,
        taskId,
        target: "archive",
        action: "add",
        origin: this.mapCaptureOriginToWriteOrigin(compressionOrigin),
        summary: `Save ${type} memory`,
        payload: {
          type,
          content: truncatedContent,
          isPrivate: finalIsPrivate,
          options: this.summarizeCaptureOptions(options),
        },
        proposedValue: truncatedContent,
        reason: options?.signalFamily,
      });
      if (!gate.allowed) {
        return null;
      }
    }

    // Build the whole capture on the host (id, summary, embedding, observation), then
    // write it in one transaction: in the database worker when this run uses it (DB6),
    // otherwise on the host connection.
    const createdAt = Date.now();
    const memory: Memory = {
      id: randomUUID(),
      workspaceId,
      taskId,
      type,
      content: truncatedContent,
      tokens,
      isCompressed: false,
      isPrivate: finalIsPrivate,
      createdAt,
      updatedAt: createdAt,
    };

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
    );

    // Best-effort: keep a concise local summary immediately so retrieval and prompts
    // do not need to consume the full raw payload for low-value entries.
    const localSummary = this.buildDeterministicSummary(truncatedContent);
    let embedding: { values: number[]; updatedAt: number } | undefined;
    const finalSummary = localSummary ? this.buildDeterministicSummary(localSummary) : "";
    if (finalSummary) {
      memory.summary = finalSummary;
      memory.tokens = estimateTokens(finalSummary);
      memory.isCompressed = true;
      try {
        embedding = {
          values: createLocalEmbedding(this.normalizeForEmbedding(finalSummary, finalSummary)),
          updatedAt: memory.updatedAt,
        };
      } catch {
        // The embedding backfill computes it later.
      }
    }

    let observation: ReturnType<typeof MemoryObservationService.buildMetadataFor> | undefined;
    if (MemoryFeaturesManager.loadSettings().structuredObservationsEnabled !== false) {
      try {
        observation = MemoryObservationService.buildMetadataFor(
          {
            ...memory,
            summary: localSummary || memory.summary,
            content: truncatedContent,
            isPrivate: finalIsPrivate,
          },
          {
            origin: options?.origin ?? (taskId ? "task" : "unknown"),
            captureReason: options?.signalFamily || "memory_capture",
            privacyState: finalIsPrivate
              ? privacyPrepared.hadPrivateBlock
                ? "redacted"
                : "private"
              : "normal",
          },
        );
      } catch {
        // Structured observations are an auxiliary index; memory capture should still succeed.
      }
    }

    const captureResult = await this.writeCapture({
      memory: {
        id: memory.id,
        workspaceId,
        taskId: taskId || null,
        type,
        content: truncatedContent,
        summary: memory.summary || null,
        tokens: memory.tokens,
        isCompressed: memory.isCompressed,
        isPrivate: finalIsPrivate,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      },
      ...(embedding ? { embedding } : {}),
      ...(observation ? { observation } : {}),
      // An identical capture inside the retention window is not stored again (DATA-2).
      dedupe: {
        contentHash: observationContentHash(truncatedContent),
        since: createdAt - Math.max(1, settings.retentionDays || 0) * 24 * 60 * 60 * 1000,
      },
    });
    if (captureResult?.duplicateOf) {
      const existing = await this.memoryRepo.findById(captureResult.duplicateOf);
      if (existing) return existing;
    }
    if (embedding) {
      this.cacheEmbedding(workspaceId, memory.id, embedding.values, embedding.updatedAt);
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

    if (
      !finalIsPrivate &&
      options?.allowExternalMirror !== false &&
      (await this.isExternalMemoryMirrorAllowed(workspaceId))
    ) {
      // The workspace name, not its id: a `{workspaceName}` container template must address
      // the container reads use (SEC-17).
      void this.workspaceRefFor(workspaceId)
        .then((workspace) =>
          SupermemoryService.mirrorMemory({
            workspace,
            taskId,
            memoryType: type,
            content: truncatedContent,
            createdAt: memory.createdAt,
            origin: "external_mirror",
            localRef: `archive:${memory.id}`,
          }),
        )
        .catch((error) => {
          logger.warn("[MemoryService] Failed to mirror memory to Supermemory:", error);
        });
    }

    // Enforce per-workspace storage cap (best-effort).
    await this.enforceStorageLimit(workspaceId, settings.maxStorageMb, {
      addedBytes: truncatedContent.length + (memory.summary?.length ?? 0),
    });

    return memory;
  }

  /**
   * The memory-settings and privacy gates of `capture`, for records kept in their own
   * tables beside the archive (Playbook entries, proactive suggestions and their feedback;
   * audit Phase 2 item 6). Returns the text to store, with inline `<private>` blocks and
   * secret values redacted, and whether it is private; or null when memory settings do not
   * allow keeping it (memory or auto-capture off, privacy mode `disabled`, an excluded
   * pattern, a `<no-memory>` directive). Writes nothing: no archive row, embedding,
   * compression or external mirror, and the archive write gate does not apply.
   */
  static async prepareDerivedRecord(
    workspaceId: string,
    content: string,
  ): Promise<{ content: string; isPrivate: boolean } | null> {
    this.ensureInitialized();
    if (containsNoMemoryDirective(content)) return null;
    const settings = await this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled || !settings.autoCapture) return null;
    if (settings.privacyMode === "disabled") return null;
    const prepared = this.applyInlinePrivacy(content);
    const text = neutralizeReservedImportPrefix(redactSecrets(prepared.content).text);
    if (this.shouldExclude(text, settings)) return null;
    return {
      content: text,
      isPrivate: prepared.hadPrivateBlock || settings.privacyMode === "strict",
    };
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
  static async search(
    workspaceId: string,
    query: string,
    limit = 20,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    const results = await this.withoutHiddenMemories(
      await this.searchInternal(workspaceId, query, limit),
    );
    if (this.sql && results.length > 0) {
      // Best-effort bookkeeping; it logs its own failures and never delays the search.
      void MemoryTierService.recordReferenceBatch(
        this.sql,
        results.map((r) => r.id),
      );
    }
    return results;
  }

  private static async searchInternal(
    workspaceId: string,
    query: string,
    limit = 20,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    // Include private memories — private means not shared externally, not hidden from the owner
    const lexicalLimit = this.lexicalLimitFor(limit);
    const lexicalLocal = await this.memoryRepo.search(workspaceId, query, lexicalLimit, true);
    const lexicalImportedGlobal = await this.memoryRepo.searchImportedGlobal(
      query,
      lexicalLimit,
      true,
    );
    return this.rankHybrid(workspaceId, query, limit, lexicalLocal, lexicalImportedGlobal);
  }

  private static lexicalLimitFor(limit: number): number {
    return Math.min(Math.max(limit, 5), 50);
  }

  /**
   * Rank lexical candidates together with local embedding similarity. Runs no FTS
   * itself, so async callers can supply lexical results from the FTS worker.
   */
  private static async rankHybrid(
    workspaceId: string,
    query: string,
    limit: number,
    lexicalLocal: MemorySearchResult[],
    lexicalImportedGlobal: MemorySearchResult[],
  ): Promise<MemorySearchResult[]> {
    // Kick off a background backfill for imported histories (and any other memories)
    // so semantic recall improves over time without requiring re-import.
    this.kickoffEmbeddingBackfill(workspaceId);
    this.kickoffImportedEmbeddingBackfill();

    // Hybrid (offline semantic + BM25):
    // - use lexical BM25 to get candidate set
    // - compute local embedding similarity as a second signal
    // - merge + rerank for better recall on imported memories and natural language prompts
    try {
      if (!wantsSemanticStage(query)) {
        return this.mergeLexicalOnly(lexicalLocal, lexicalImportedGlobal, limit);
      }
      await this.ensureEmbeddingsLoaded(workspaceId);
      await this.ensureImportedEmbeddingsLoaded();
      const plan = planHybridMemories({
        query,
        limit,
        lexicalLocal,
        lexicalImportedGlobal,
        workspaceEmbeddings: this.memoryEmbeddingsByWorkspace.get(workspaceId)?.entries(),
        importedEmbeddings: this.importedEmbeddings.entries(),
      });
      if ("results" in plan) return plan.results as MemorySearchResult[];
      // Semantic candidates come from embedding caches that do not track privacy: keep
      // this workspace's rows and other workspaces' non-private imported rows only.
      const details = (await this.memoryRepo.getFullDetails(plan.candidateIds)).filter(
        (memory) =>
          memory.workspaceId === workspaceId ||
          (!memory.isPrivate && this.isImportedMemoryContent(memory.content)),
      );
      return plan.rank(details) as MemorySearchResult[];
    } catch {
      return this.mergeLexicalOnly(lexicalLocal, lexicalImportedGlobal, limit);
    }
  }

  private static mapCaptureOriginToWriteOrigin(origin: MemoryCaptureOrigin): MemoryWriteOrigin {
    switch (origin) {
      case "tool":
        return "agent_tool";
      case "proactive":
        return "background";
      case "system":
        return "distill";
      case "task":
      case "chronicle":
      case "playbook":
      case "import":
      case "unknown":
      default:
        return "auto_capture";
    }
  }

  private static summarizeCaptureOptions(
    options: MemoryCaptureOptions | undefined,
  ): Record<string, unknown> | undefined {
    if (!options) return undefined;
    return {
      origin: options.origin,
      batchKey: options.batchKey,
      priority: options.priority,
      signalFamily: options.signalFamily,
      profileId: options.profileId,
      coreTraceId: options.coreTraceId,
      candidateId: options.candidateId,
      scopeKind: options.scopeKind,
      scopeRef: options.scopeRef,
      forceCapture: options.forceCapture,
    };
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

  private static ensureEmbeddingsLoaded(workspaceId: string): Promise<void> {
    if (this.embeddingsLoadedForWorkspace.has(workspaceId)) return Promise.resolve();
    let load = this.embeddingLoads.get(workspaceId);
    if (!load) {
      load = this.loadEmbeddings(workspaceId).finally(() => {
        this.embeddingLoads.delete(workspaceId);
      });
      this.embeddingLoads.set(workspaceId, load);
    }
    return load;
  }

  private static async loadEmbeddings(workspaceId: string): Promise<void> {
    // Lazy load persisted embeddings for a workspace into memory.
    // If the table doesn't exist yet (older DB), this will throw and be ignored by callers.
    const generation = this.embeddingCacheGeneration;
    try {
      const embeddings = await this.embeddingRepo.getByWorkspace(workspaceId);
      if (generation !== this.embeddingCacheGeneration) return;
      const map =
        this.memoryEmbeddingsByWorkspace.get(workspaceId) ??
        new Map<string, { updatedAt: number; embedding: Float32Array }>();
      for (const row of embeddings) {
        const cached = map.get(row.memoryId);
        if (cached && cached.updatedAt >= row.updatedAt) continue;
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
      if (generation === this.embeddingCacheGeneration) {
        this.embeddingsLoadedForWorkspace.add(workspaceId);
      }
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
        // DB4: with the FTS worker the scan runs there; embedding and upsert stay here.
        const missing = this.ftsWorker
          ? await this.ftsWorker.findMissingEmbeddings(workspaceId, batchSize)
          : await this.embeddingRepo.findMissingOrStale(workspaceId, batchSize);
        if (missing.length === 0) break;

        const rows = missing.map((mem) => ({
          memoryId: mem.memoryId,
          workspaceId,
          updatedAt: mem.updatedAt,
          embedding: createLocalEmbedding(this.normalizeForEmbedding(mem.summary, mem.content)),
        }));
        const written = new Set(await this.writeBackfillBatch(rows));
        for (const row of rows) {
          if (!written.has(row.memoryId)) continue;
          this.cacheEmbedding(workspaceId, row.memoryId, row.embedding, row.updatedAt);
        }

        // Yield to avoid monopolizing the event loop on large histories.
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      this.embeddingBackfillInProgress.delete(workspaceId);
    }
  }

  /**
   * Persist one embedding-backfill batch: in the database worker when this run uses it
   * (DB4), otherwise in one host transaction. Rows whose memory changed meanwhile are
   * skipped. Returns the ids written. Worker writes bypass the repository's change
   * notification, so the FTS worker's cache is told here.
   */
  private static async writeBackfillBatch(rows: MemoryEmbeddingRow[]): Promise<string[]> {
    if (rows.length === 0) return [];
    const { getDatabaseClient } = await import("../database/async/runtime");
    const client = await getDatabaseClient();
    if (!client) return this.embeddingRepo.upsertBackfillBatch(rows);
    const { written } = await client.execute("memory.upsertEmbeddings", { rows });
    if (written.length > 0) {
      this.ftsWorker?.invalidateEmbeddings({ kind: "memories", memoryIds: written });
    }
    return written;
  }

  /**
   * Commit one capture: in the database worker when this run uses it (DB6), otherwise in
   * one host transaction. Neither path goes through the embedding repository, so the FTS
   * worker's cache is told about the new embedding here.
   */
  private static async writeCapture(
    write: CapturedMemoryWrite,
  ): Promise<CapturedMemoryResult | undefined> {
    const { getDatabaseClient } = await import("../database/async/runtime");
    const client = await getDatabaseClient();
    const result: CapturedMemoryResult | undefined = client
      ? await client.execute("memory.capture", { write })
      : await this.memoryRepo.insertCaptured(write);
    if (write.embedding && !result?.duplicateOf) {
      this.ftsWorker?.invalidateEmbeddings({ kind: "memories", memoryIds: [write.memory.id] });
    }
    return result;
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

  private static ensureImportedEmbeddingsLoaded(): Promise<void> {
    if (this.importedEmbeddingsLoaded) return Promise.resolve();
    this.importedEmbeddingsLoad ??= this.loadImportedEmbeddings().finally(() => {
      this.importedEmbeddingsLoad = null;
    });
    return this.importedEmbeddingsLoad;
  }

  private static async loadImportedEmbeddings(): Promise<void> {
    const generation = this.embeddingCacheGeneration;
    try {
      // Load in one go; typical sizes are manageable (thousands to tens of thousands).
      const rows = await this.embeddingRepo.getImportedGlobal(200000, 0);
      if (generation !== this.embeddingCacheGeneration) return;
      for (const row of rows) {
        const cached = this.importedEmbeddings.get(row.memoryId);
        if (cached && cached.updatedAt >= row.updatedAt) continue;
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
      if (generation === this.embeddingCacheGeneration) this.importedEmbeddingsLoaded = true;
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
        const missing = this.ftsWorker
          ? await this.ftsWorker.findMissingEmbeddings(null, batchSize)
          : await this.embeddingRepo.findMissingOrStaleImportedGlobal(batchSize);
        if (missing.length === 0) break;
        const rows = missing.map((mem) => ({
          memoryId: mem.memoryId,
          workspaceId: mem.workspaceId,
          updatedAt: mem.updatedAt,
          embedding: createLocalEmbedding(this.normalizeForEmbedding(mem.summary, mem.content)),
        }));
        const written = new Set(await this.writeBackfillBatch(rows));
        for (const row of rows) {
          if (!written.has(row.memoryId)) continue;
          this.importedEmbeddings.set(row.memoryId, {
            updatedAt: row.updatedAt,
            embedding: Float32Array.from(row.embedding),
            workspaceId: row.workspaceId,
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
  static async getTimelineContext(
    memoryId: string,
    windowSize = 5,
  ): Promise<MemoryTimelineEntry[]> {
    this.ensureInitialized();
    return this.memoryRepo.getTimelineContext(memoryId, windowSize);
  }

  /**
   * Get full details - Layer 3 of progressive retrieval
   * Only called for specific memories when needed
   */
  static async getFullDetails(ids: string[]): Promise<Memory[]> {
    this.ensureInitialized();
    return this.memoryRepo.getFullDetails(ids);
  }

  /**
   * Get recent memories for a workspace
   */
  static async getRecent(workspaceId: string, limit = 20): Promise<Memory[]> {
    this.ensureInitialized();
    return this.memoryRepo.getRecentForWorkspace(workspaceId, limit, true);
  }

  /**
   * Recent memories injected into prompts. Private rows are excluded (they are shown on
   * request through search tools, not pushed into every turn), as are suppressed and
   * redacted rows.
   */
  static async getRecentForPromptRecall(workspaceId: string, limit = 20): Promise<Memory[]> {
    this.ensureInitialized();
    const recent = await this.memoryRepo.getRecentForWorkspace(workspaceId, limit, false);
    const suppressed = await MemoryObservationService.suppressedIds(recent.map((m) => m.id));
    return recent.filter(
      (memory) => !this.isPromptRecallIgnoredContent(memory.content) && !suppressed.has(memory.id),
    );
  }

  static async searchForPromptRecall(
    workspaceId: string,
    query: string,
    limit = 20,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    const results = await this.search(workspaceId, query, limit);
    if (results.length === 0) return results;

    const details = await this.memoryRepo.getFullDetails(results.map((result) => result.id));
    const suppressed = await MemoryObservationService.suppressedIds(details.map((m) => m.id));
    const ignoredIds = new Set(
      details
        .filter(
          (memory) =>
            memory.isPrivate ||
            this.isPromptRecallIgnoredContent(memory.content) ||
            suppressed.has(memory.id),
        )
        .map((memory) => memory.id),
    );
    if (ignoredIds.size === 0) return results;
    return results.filter((result) => !ignoredIds.has(result.id));
  }

  /**
   * Fast prompt-recall path: local-only BM25 with 5-token cap, no imported-global,
   * no hybrid semantic scoring, no tier tracking. Results are cached per workspace+prompt.
   */
  static async searchForPromptRecallFast(
    workspaceId: string,
    query: string,
    limit = 5,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    const cacheKey = this.getPromptRecallCacheKey(workspaceId, query);
    const cached = this.promptRecallCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < MemoryService.PROMPT_RECALL_CACHE_TTL_MS) {
      return cached.results;
    }

    const rawResults = await this.memoryRepo.searchLocalForPromptRecall(
      workspaceId,
      query,
      limit + 5,
    );

    const results = await this.filterPromptRecallRows(rawResults, limit);
    this.rememberPromptRecallResults(cacheKey, results);

    return results;
  }

  static async searchForPromptRecallAsync(
    workspaceId: string,
    query: string,
    limit = 20,
  ): Promise<MemorySearchResult[]> {
    return this.searchForPromptRecallFastAsync(workspaceId, query, limit);
  }

  static async searchForPromptRecallFastAsync(
    workspaceId: string,
    query: string,
    limit = 5,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    const cacheKey = this.getPromptRecallCacheKey(workspaceId, query);
    const cached = this.promptRecallCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < MemoryService.PROMPT_RECALL_CACHE_TTL_MS) {
      return cached.results;
    }

    this.promptRecallDiagnostics.queries += 1;
    if (!this.ftsWorker) {
      this.recordPromptRecallDiagnostic("workerUnavailable");
      logger.warn("[MemoryService] Prompt recall FTS worker unavailable; skipping sync fallback");
      return [];
    }

    try {
      const rawResults = await this.ftsWorker.searchLocalForPromptRecall(
        workspaceId,
        query,
        limit + 5,
      );
      const results = await this.filterPromptRecallRows(rawResults, limit);
      if (results.length > 0) {
        this.recordPromptRecallDiagnostic("workerHits");
        this.rememberPromptRecallResults(cacheKey, results);
      } else {
        this.recordPromptRecallDiagnostic("workerEmptyResults");
      }
      return results;
    } catch (error) {
      this.recordPromptRecallDiagnostic(
        "workerFailures",
        error instanceof Error ? error.message : String(error),
      );
      logger.warn(
        "[MemoryService] Prompt recall FTS worker failed; skipping sync fallback:",
        error,
      );
      return [];
    }
  }

  private static getPromptRecallCacheKey(workspaceId: string, query: string): string {
    const queryHash = Array.from(query.slice(0, 2500)).reduce(
      (h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0,
      0,
    );
    return `${workspaceId}:${queryHash}:${query.length}`;
  }

  private static async filterPromptRecallRows(
    rawResults: Array<MemorySearchResult & { content?: string }>,
    limit: number,
  ): Promise<MemorySearchResult[]> {
    const suppressed = await MemoryObservationService.suppressedIds(rawResults.map((r) => r.id));
    return rawResults
      .filter(
        (r) =>
          !this.isPromptRecallIgnoredContent(r.content || r.snippet || "") && !suppressed.has(r.id),
      )
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        snippet: r.snippet,
        type: r.type,
        relevanceScore: r.relevanceScore,
        createdAt: r.createdAt,
        taskId: r.taskId,
        source: "db" as const,
      }));
  }

  private static rememberPromptRecallResults(
    cacheKey: string,
    results: MemorySearchResult[],
  ): void {
    if (this.promptRecallCache.size >= MemoryService.PROMPT_RECALL_CACHE_MAX_ENTRIES) {
      const oldestKey = this.promptRecallCache.keys().next().value;
      if (oldestKey !== undefined) this.promptRecallCache.delete(oldestKey);
    }
    this.promptRecallCache.set(cacheKey, { results, createdAt: Date.now() });
  }

  static clearPromptRecallCache(): void {
    this.promptRecallCache.clear();
  }

  /** Drop results whose observation is suppressed (deleted) or redacted. */
  private static async withoutHiddenMemories<T extends { id: string }>(results: T[]): Promise<T[]> {
    if (results.length === 0) return results;
    const hidden = await MemoryObservationService.suppressedIds(results.map((r) => r.id));
    return hidden.size === 0 ? results : results.filter((r) => !hidden.has(r.id));
  }

  static getPromptRecallDiagnostics(): PromptRecallDiagnostics {
    return { ...this.promptRecallDiagnostics };
  }

  private static recordPromptRecallDiagnostic(
    field: "workerUnavailable" | "workerFailures" | "workerEmptyResults" | "workerHits",
    failureMessage?: string,
  ): void {
    this.promptRecallDiagnostics[field] += 1;
    if (failureMessage) {
      this.promptRecallDiagnostics.lastFailureAt = Date.now();
      this.promptRecallDiagnostics.lastFailureMessage = failureMessage;
    }
  }

  /**
   * Fast marker-based lookup for background services that search by known
   * content prefixes (e.g. "[SUGGESTION]", "[PLAYBOOK]"). Bypasses FTS
   * entirely — uses LIKE, no tier tracking, no hybrid scoring.
   */
  static async searchByContentMarker(
    workspaceId: string,
    marker: string,
    limit = 50,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    return this.memoryRepo.searchByContentMarker(workspaceId, marker, limit);
  }

  static async searchByContentMarkerAsync(
    workspaceId: string,
    marker: string,
    limit = 50,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    if (this.ftsWorker) {
      // The worker runs the host's LIKE query after its FTS attempt, so an empty result
      // is final. Worker errors propagate instead of rerunning the scan on the host.
      return this.ftsWorker.searchByContentMarker(workspaceId, marker, limit);
    }
    return this.searchByContentMarker(workspaceId, marker, limit);
  }

  static async searchAsync(
    workspaceId: string,
    query: string,
    limit = 20,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    if (!this.ftsWorker) return this.search(workspaceId, query, limit);

    // The whole hybrid search runs in the worker (DB4): lexical FTS, the embedding scan,
    // and the rerank. A worker failure is raised, not replaced by a host search or an
    // empty result. Embedding backfills stay host-side writes; they only start here.
    this.kickoffEmbeddingBackfill(workspaceId);
    this.kickoffImportedEmbeddingBackfill();
    let results: MemorySearchResult[];
    try {
      results = await this.ftsWorker.hybridSearch(workspaceId, query, limit, true);
    } catch (error) {
      throw new Error(
        `Memory search is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    results = await this.withoutHiddenMemories(results);
    if (results.length > 0 && this.sql) {
      // Best-effort bookkeeping; it logs its own failures and never delays the search.
      void MemoryTierService.recordReferenceBatch(
        this.sql,
        results.map((r) => r.id),
      );
    }
    return results;
  }

  /**
   * Archive lane of MemoryRecall: the same search and visibility as `searchAsync` (this
   * workspace's agent-visible rows plus non-private imported rows), but it records no
   * references: a hit that is only listed is not a use. MemoryRecall counts a use through
   * `recordPromptInjection` when an item is returned in full. Errors propagate.
   */
  static async searchForRecallAsync(
    workspaceId: string,
    query: string,
    limit = 20,
  ): Promise<MemorySearchResult[]> {
    this.ensureInitialized();
    if (!this.ftsWorker) {
      return this.withoutHiddenMemories(await this.searchInternal(workspaceId, query, limit));
    }
    this.kickoffEmbeddingBackfill(workspaceId);
    this.kickoffImportedEmbeddingBackfill();
    let results: MemorySearchResult[];
    try {
      results = await this.ftsWorker.hybridSearch(workspaceId, query, limit, true);
    } catch (error) {
      throw new Error(
        `Memory search is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.withoutHiddenMemories(results);
  }

  /**
   * Memory search for the daily briefing (audit SEC-14). The briefing can be delivered to
   * a channel, so it only sees this workspace's own rows that are neither private nor
   * suppressed / redacted: no imported rows from other workspaces, no private rows. It
   * records no references (a briefing is not a use of the memory).
   */
  static async searchForBriefingAsync(
    workspaceId: string,
    query: string,
    limit = 5,
  ): Promise<Array<MemorySearchResult & { workspaceId: string }>> {
    this.ensureInitialized();
    const candidateLimit = Math.max(limit * 3, 10);
    const candidates = this.ftsWorker
      ? await this.ftsWorker.hybridSearch(workspaceId, query, candidateLimit, true)
      : await this.searchInternal(workspaceId, query, candidateLimit);
    const visible = await this.withoutHiddenMemories(candidates);
    if (visible.length === 0) return [];
    const details = new Map(
      (await this.memoryRepo.getFullDetails(visible.map((result) => result.id))).map((memory) => [
        memory.id,
        memory,
      ]),
    );
    return visible
      .filter((result) => {
        const memory = details.get(result.id);
        return Boolean(memory && memory.workspaceId === workspaceId && !memory.isPrivate);
      })
      .slice(0, limit)
      .map((result) => ({ ...result, workspaceId }));
  }

  private static pendingPromptReferences = new Set<string>();
  private static promptReferenceFlushTimer?: ReturnType<typeof setTimeout>;
  private static readonly PROMPT_REFERENCE_FLUSH_DELAY_MS = 2_000;

  /**
   * Count a reference for memories actually injected into a prompt (audit DATA-1), so
   * retention and tier promotion see memories that recall keeps using. Ids are batched
   * into one UPDATE of reference_count / last_referenced_at; that update touches neither
   * content nor summary, so it does not rewrite the FTS index.
   */
  static recordPromptInjection(memoryIds: Iterable<string>): void {
    for (const id of memoryIds) {
      if (typeof id === "string" && id) this.pendingPromptReferences.add(id);
    }
    if (this.pendingPromptReferences.size === 0 || this.promptReferenceFlushTimer) return;
    this.promptReferenceFlushTimer = setTimeout(() => {
      this.promptReferenceFlushTimer = undefined;
      void this.flushPromptReferences();
    }, MemoryService.PROMPT_REFERENCE_FLUSH_DELAY_MS);
    this.promptReferenceFlushTimer.unref?.();
  }

  /** Write the pending prompt-injection references now. */
  static async flushPromptReferences(): Promise<void> {
    if (this.promptReferenceFlushTimer) {
      clearTimeout(this.promptReferenceFlushTimer);
      this.promptReferenceFlushTimer = undefined;
    }
    const ids = [...this.pendingPromptReferences];
    this.pendingPromptReferences.clear();
    if (ids.length === 0 || !this.sql) return;
    await MemoryTierService.recordReferenceBatch(this.sql, ids);
  }

  static async getContextForInjectionAsync(
    workspaceId: string,
    taskPrompt: string,
  ): Promise<string> {
    this.ensureInitialized();
    const featureSettings = MemoryFeaturesManager.loadSettings();
    if (featureSettings.defaultArchiveInjectionEnabled !== true) {
      return "";
    }

    const settings = await this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled) {
      return "";
    }

    const recentMemories = await this.getRecentForPromptRecall(workspaceId, 5);

    let relevantMemories: MemorySearchResult[] = [];
    if (taskPrompt && taskPrompt.length > 10) {
      try {
        const query = taskPrompt.slice(0, 2500);
        relevantMemories = await this.searchForPromptRecallFastAsync(workspaceId, query, 10);

        const recentIds = new Set(recentMemories.map((m) => m.id));
        relevantMemories = relevantMemories.filter((m) => !recentIds.has(m.id)).slice(0, 7);
      } catch {
        // Search failed, continue without relevant memories
      }
    }

    if (recentMemories.length === 0 && relevantMemories.length === 0) {
      return "";
    }
    this.recordPromptInjection([
      ...recentMemories.map((memory) => memory.id),
      ...relevantMemories.map((memory) => memory.id),
    ]);

    const parts: string[] = ["<memory_context>"];
    parts.push("The following memories from previous sessions may be relevant:");

    if (recentMemories.length > 0) {
      parts.push("\n## Recent Activity");
      recentMemories.forEach((memory) => {
        const rawText = memory.summary || this.truncate(memory.content, 150);
        const text = InputSanitizer.sanitizeMemoryContent(rawText);
        const date = new Date(memory.createdAt).toLocaleDateString();
        parts.push(`- [${memory.type}] (${date}) ${text}`);
      });
    }

    if (relevantMemories.length > 0) {
      parts.push("\n## Relevant to Current Task (Hybrid Recall)");
      relevantMemories.forEach((result) => {
        const date = new Date(result.createdAt).toLocaleDateString();
        const sanitizedSnippet = InputSanitizer.sanitizeMemoryContent(result.snippet);
        parts.push(`- [${result.type}] (${date}) ${sanitizedSnippet}`);
      });
    }

    parts.push("</memory_context>");
    return parts.join("\n");
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

  private static applyInlinePrivacy(content: string): {
    content: string;
    hadPrivateBlock: boolean;
  } {
    let hadPrivateBlock = false;
    const redacted = content.replace(/<\s*private\s*>[\s\S]*?<\s*\/\s*private\s*>/gi, () => {
      hadPrivateBlock = true;
      return "[private content redacted]";
    });
    return { content: redacted, hadPrivateBlock };
  }

  /**
   * Get or create settings for a workspace
   */
  static async getSettings(workspaceId: string): Promise<MemorySettings> {
    this.ensureInitialized();
    return this.settingsRepo.getOrCreate(workspaceId);
  }

  /**
   * Update settings for a workspace
   */
  static async updateSettings(
    workspaceId: string,
    updates: Partial<Omit<MemorySettings, "workspaceId">>,
  ): Promise<void> {
    this.ensureInitialized();
    await this.settingsRepo.update(workspaceId, updates);
  }

  /**
   * Get storage statistics for a workspace
   */
  static async getStats(workspaceId: string): Promise<MemoryStats> {
    this.ensureInitialized();
    return this.memoryRepo.getStats(workspaceId);
  }

  /**
   * Get statistics for imported memories
   */
  static async getImportedStats(
    workspaceId: string,
  ): Promise<{ count: number; totalTokens: number }> {
    this.ensureInitialized();
    return this.memoryRepo.getImportedStats(workspaceId);
  }

  /**
   * Find imported memories with pagination
   */
  static async findImported(workspaceId: string, limit = 50, offset = 0): Promise<Memory[]> {
    this.ensureInitialized();
    return this.memoryRepo.findImported(workspaceId, limit, offset);
  }

  static async deleteImportedEntry(workspaceId: string, memoryId: string): Promise<boolean> {
    this.ensureInitialized();

    const memory = await this.memoryRepo.findById(memoryId);
    if (!memory || memory.workspaceId !== workspaceId) return false;
    if (!this.isImportedMemoryContent(memory.content)) return false;

    try {
      await this.embeddingRepo.deleteByMemoryIds([memoryId]);
    } catch {
      // ignore
    }

    const deleted = await this.memoryRepo.deleteByIds(workspaceId, [memoryId]);
    if (deleted <= 0) return false;
    await this.closeImportedFacts([memoryId], "deleted");
    SupermemoryService.scheduleOrphanSweep();

    this.importedEmbeddings.delete(memoryId);
    this.memoryEmbeddingsByWorkspace.delete(workspaceId);
    this.embeddingsLoadedForWorkspace.delete(workspaceId);
    this.embeddingCacheGeneration += 1;
    this.embeddingBackfillInProgress.delete(workspaceId);
    this.promptRecallCache.clear();
    return true;
  }

  static async setImportedPromptRecallIgnored(
    workspaceId: string,
    memoryId: string,
    ignored: boolean,
  ): Promise<Memory | null> {
    this.ensureInitialized();

    const memory = await this.memoryRepo.findById(memoryId);
    if (!memory || memory.workspaceId !== workspaceId) return null;
    if (!this.isImportedMemoryContent(memory.content)) return null;

    const nextContent = ignored
      ? this.applyPromptRecallIgnoreMarker(memory.content)
      : this.stripPromptRecallIgnoreMarker(memory.content);
    if (nextContent === memory.content) return memory;

    await this.memoryRepo.update(memoryId, {
      content: nextContent,
      tokens: estimateTokens(nextContent),
    });

    try {
      await this.embeddingRepo.deleteByMemoryIds([memoryId]);
    } catch {
      // ignore
    }

    this.importedEmbeddings.delete(memoryId);
    const updated = await this.memoryRepo.findById(memoryId);
    if (updated) {
      // An ignored import is not recalled as a fact either; un-ignoring writes it again.
      if (ignored) await this.closeImportedFacts([memoryId], "archived");
      else await this.restoreImportedFact(updated);
      this.promptRecallCache.clear();
      return updated;
    }
    return null;
  }

  /**
   * Delete all imported memories for a workspace
   */
  static async deleteImported(workspaceId: string): Promise<number> {
    this.ensureInitialized();
    await this.deleteImportedFactsOfWorkspace(workspaceId);
    // Remove embeddings first (embeddings table references memories by id).
    try {
      await this.embeddingRepo.deleteImported(workspaceId);
    } catch {
      // ignore
    }
    const deleted = await this.memoryRepo.deleteImported(workspaceId);
    if (deleted > 0) SupermemoryService.scheduleOrphanSweep();
    // Clear caches for this workspace (best-effort).
    for (const [memoryId, entry] of this.importedEmbeddings.entries()) {
      if (entry.workspaceId === workspaceId) {
        this.importedEmbeddings.delete(memoryId);
      }
    }
    this.memoryEmbeddingsByWorkspace.delete(workspaceId);
    this.embeddingsLoadedForWorkspace.delete(workspaceId);
    this.embeddingCacheGeneration += 1;
    this.embeddingBackfillInProgress.delete(workspaceId);
    this.promptRecallCache.clear();
    return deleted;
  }

  /**
   * The one gated import API (docs/memory-engine.md §1): every importer (ChatGPT export,
   * pasted memories) writes through a session. Opening one checks the workspace memory
   * settings (memory off or privacy mode `disabled` refuse the import; strict privacy or
   * `forcePrivate` make the rows private, which keeps them in their workspace). Each entry
   * then passes `<no-memory>`, the salience gate, input sanitization, inline `<private>`
   * blocks, secret redaction, excluded patterns and dedupe (against every imported row
   * visible in the workspace, so a re-import or the same history imported in another
   * workspace adds nothing), and is stored with its embedding and observation sidecar in one
   * capture. Entries marked as facts about the user are also written to `memory_items` as
   * `import` items through `MemoryWriter`. `finish` applies the storage cap. Imports are
   * explicit user acts: auto-capture does not apply, and nothing is mirrored externally.
   */
  static async openImportSession(options: {
    workspaceId: string;
    forcePrivate?: boolean;
  }): Promise<MemoryImportSession> {
    this.ensureInitialized();
    const workspaceId = options.workspaceId;
    const settings = await this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled) {
      throw new Error("Memory system is disabled for this workspace. Enable it in settings first.");
    }
    if (settings.privacyMode === "disabled") {
      throw new Error(
        "Memory privacy mode is set to disabled for this workspace. Change it in settings first.",
      );
    }
    const isPrivate = options.forcePrivate === true || settings.privacyMode === "strict";
    const seen = new Set<string>();
    try {
      const rows = this.sql
        ? await this.sql.all<{ content: string }>("import_visibleImportedContents", [workspaceId])
        : [];
      for (const row of rows) {
        const body = importedBody(this.stripPromptRecallIgnoreMarker(row.content));
        if (body) seen.add(observationContentHash(body));
      }
    } catch (error) {
      // Within-session dedupe and the capture's own dedupe still apply.
      logger.warn("[MemoryService] Could not load imported rows for dedupe:", error);
    }

    let created = 0;
    const add = async (entry: MemoryImportEntry): Promise<MemoryImportOutcome> => {
      if (containsNoMemoryDirective(entry.body)) return { status: "filtered", reason: "no_memory" };
      const privacyPrepared = this.applyInlinePrivacy(
        InputSanitizer.sanitizeMemoryContent(entry.body),
      );
      const redaction = redactSecrets(privacyPrepared.content);
      const text = redaction.text.trim();
      const salience = memoryTextSalience(text);
      if (salience) return { status: "filtered", reason: salience };
      if (
        redaction.count > 0 &&
        memoryTextSalience(text.split(REDACTED_SECRET).join(" ")) !== null
      ) {
        return { status: "filtered", reason: "secret_only" };
      }
      if (this.shouldExclude(text, settings)) return { status: "filtered", reason: "excluded" };
      const bounded =
        text.length > MAX_TEXT_IMPORT_ENTRY_CHARS
          ? `${text.slice(0, MAX_TEXT_IMPORT_ENTRY_CHARS)}\n[... truncated]`
          : text;
      const bodyHash = observationContentHash(bounded);
      if (seen.has(bodyHash)) return { status: "duplicate" };
      seen.add(bodyHash);

      const header = normalizeImportHeader(entry.header);
      const content = `${header}\n${bounded}`;
      const rowIsPrivate = isPrivate || privacyPrepared.hadPrivateBlock;
      const createdAt = Date.now();
      const summary = this.buildDeterministicSummary(bounded);
      const memory: Memory = {
        id: randomUUID(),
        workspaceId,
        type: entry.type,
        content,
        summary: summary || undefined,
        tokens: estimateTokens(summary || content),
        isCompressed: Boolean(summary),
        isPrivate: rowIsPrivate,
        createdAt,
        updatedAt: createdAt,
      };
      let embedding: { values: number[]; updatedAt: number } | undefined;
      try {
        embedding = {
          values: createLocalEmbedding(this.normalizeForEmbedding(summary, bounded)),
          updatedAt: createdAt,
        };
      } catch {
        // The imported-embedding backfill computes it later.
      }
      let observation: ReturnType<typeof MemoryObservationService.buildMetadataFor> | undefined;
      if (MemoryFeaturesManager.loadSettings().structuredObservationsEnabled !== false) {
        try {
          observation = MemoryObservationService.buildMetadataFor(memory, {
            origin: "import",
            captureReason: "memory_import",
            privacyState: rowIsPrivate
              ? privacyPrepared.hadPrivateBlock
                ? "redacted"
                : "private"
              : "normal",
          });
        } catch {
          // Auxiliary index; the import still succeeds.
        }
      }
      const result = await this.writeCapture({
        memory: {
          id: memory.id,
          workspaceId,
          taskId: null,
          type: entry.type,
          content,
          summary: memory.summary ?? null,
          tokens: memory.tokens,
          isCompressed: memory.isCompressed,
          isPrivate: rowIsPrivate,
          createdAt,
          updatedAt: createdAt,
        },
        ...(embedding ? { embedding } : {}),
        ...(observation ? { observation } : {}),
        // The same imported row already in this workspace, at any age.
        dedupe: { contentHash: observationContentHash(content), since: 0 },
      });
      if (result?.duplicateOf) return { status: "duplicate" };
      if (embedding) {
        this.cacheEmbedding(workspaceId, memory.id, embedding.values, embedding.updatedAt);
        if (this.importedEmbeddingsLoaded) {
          this.importedEmbeddings.set(memory.id, {
            updatedAt: embedding.updatedAt,
            embedding: Float32Array.from(embedding.values),
            workspaceId,
          });
        }
      }
      created += 1;
      const factItemId = entry.fact
        ? await this.writeImportedFact(workspaceId, memory.id, bounded, rowIsPrivate, entry.fact)
        : undefined;
      return { status: "created", memory, ...(factItemId ? { factItemId } : {}) };
    };

    return {
      workspaceId,
      isPrivate,
      add,
      finish: async () => {
        if (created > 0) {
          this.promptRecallCache.clear();
          await this.enforceStorageLimit(workspaceId, settings.maxStorageMb, { force: true });
        }
        return { created };
      },
    };
  }

  /**
   * An imported fact about the user as a `memory_items` item: source `import` (never
   * `user_stated`), workspace scope (the import's workspace; Clear All Memories removes
   * it), private when the imported row is. `source_ref` names the archive row
   * (`{ store: "import", id }`), so deleting or ignoring the imported row forgets it.
   */
  private static async writeImportedFact(
    workspaceId: string,
    archiveId: string,
    content: string,
    isPrivate: boolean,
    fact: NonNullable<MemoryImportEntry["fact"]>,
  ): Promise<string | undefined> {
    const writer = MemoryWriter.get();
    if (!writer) return undefined;
    try {
      const result = await writer.ingest({
        content,
        kind: fact.kind,
        scope: "workspace",
        workspaceId,
        source: "import",
        sourceRef: {
          store: IMPORT_FACT_STORE,
          id: archiveId,
          importer: fact.importer,
          ...(fact.conversationId ? { conversationId: fact.conversationId } : {}),
        },
        confidence: 0.6,
        ...(isPrivate ? { privacy: "private" as const } : {}),
        originWorkspaceId: workspaceId,
        originText: content,
      });
      return result.status === "written" ? result.item.id : undefined;
    } catch (error) {
      logger.warn("[MemoryService] Imported fact was not written:", error);
      return undefined;
    }
  }

  /**
   * Close the `memory_items` facts that were imported with these archive rows (their
   * primary source ref; a fact another source also holds is left alone).
   */
  private static async closeImportedFacts(
    archiveIds: string[],
    status: "deleted" | "archived",
  ): Promise<void> {
    const writer = MemoryWriter.get();
    if (!writer || archiveIds.length === 0) return;
    for (const archiveId of archiveIds) {
      try {
        const items = await writer.repository.findBySourceRef(
          IMPORT_FACT_STORE,
          archiveId,
          status === "deleted" ? ["active", "archived", "superseded"] : ["active"],
        );
        for (const item of items) {
          if (item.source !== "import" || item.sourceRef?.store !== IMPORT_FACT_STORE) continue;
          if (item.sourceRef?.id !== archiveId) continue;
          await writer.setStatus(item.id, status);
        }
      } catch (error) {
        logger.warn("[MemoryService] Could not close imported facts:", error);
      }
    }
  }

  /** Write an un-ignored imported row's fact again (reactivation goes through ingest). */
  private static async restoreImportedFact(memory: Memory): Promise<void> {
    const writer = MemoryWriter.get();
    if (!writer) return;
    try {
      const items = await writer.repository.findBySourceRef(IMPORT_FACT_STORE, memory.id, [
        "archived",
      ]);
      const item = items.find(
        (candidate) => candidate.source === "import" && candidate.sourceRef?.id === memory.id,
      );
      if (!item) return;
      const body = importedBody(memory.content);
      if (!body) return;
      await this.writeImportedFact(memory.workspaceId, memory.id, body, memory.isPrivate, {
        kind: item.kind,
        importer: String(item.sourceRef?.importer || "import"),
        ...(typeof item.sourceRef?.conversationId === "string"
          ? { conversationId: item.sourceRef.conversationId }
          : {}),
      });
    } catch (error) {
      logger.warn("[MemoryService] Could not restore imported fact:", error);
    }
  }

  /** Every fact the import API wrote for the workspace's imported rows. */
  private static async deleteImportedFactsOfWorkspace(workspaceId: string): Promise<void> {
    const writer = MemoryWriter.get();
    if (!writer) return;
    try {
      // Pages of up to 5000; deleted items drop out of the next page.
      for (let page = 0; page < 100; page += 1) {
        const items = await writer.repository.list({
          workspaceId,
          scope: "workspace",
          sourceStore: IMPORT_FACT_STORE,
          statuses: ["active", "archived", "superseded"],
          includePrivate: true,
          limit: 5000,
        });
        let deleted = 0;
        for (const item of items) {
          if (item.source !== "import") continue;
          deleted += (await writer.setStatus(item.id, "deleted")).length;
        }
        if (deleted === 0) break;
      }
    } catch (error) {
      logger.warn("[MemoryService] Could not delete imported facts:", error);
    }
  }

  static async importFromText(options: {
    workspaceId: string;
    provider: string;
    pastedText: string;
    forcePrivate?: boolean;
  }): Promise<{
    success: boolean;
    entriesDetected: number;
    memoriesCreated: number;
    duplicatesSkipped: number;
    truncated: number;
    errors: string[];
  }> {
    this.ensureInitialized();

    const providerLabel =
      InputSanitizer.sanitizeMemoryContent(options.provider)
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[[\]]/g, "")
        .slice(0, 80) || "Other AI";
    const parsedEntries = this.extractTextImportEntries(options.pastedText);

    if (parsedEntries.length === 0) {
      throw new Error("No memory entries found. Paste the exported memories and try again.");
    }

    // Pasted memories are private unless the caller says otherwise.
    const session = await this.openImportSession({
      workspaceId: options.workspaceId,
      forcePrivate: options.forcePrivate ?? true,
    });

    const entries = parsedEntries.slice(0, MAX_TEXT_IMPORT_ENTRIES);
    const truncated = Math.max(0, parsedEntries.length - entries.length);

    let memoriesCreated = 0;
    let duplicatesSkipped = 0;
    const errors: string[] = [];

    for (const entry of entries) {
      try {
        const outcome = await session.add({
          type: "insight",
          body: entry,
          header: `[Imported from ${providerLabel} — "Memory export (pasted)"]`,
        });
        if (outcome.status === "created") memoriesCreated += 1;
        else duplicatesSkipped += 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    await session.finish();

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
  static async clearWorkspace(workspaceId: string): Promise<void> {
    this.ensureInitialized();
    await this.memoryRepo.deleteByWorkspace(workspaceId);
    try {
      await this.embeddingRepo.deleteByWorkspace(workspaceId);
    } catch {
      // ignore
    }
    void this.markdownIndex?.clearWorkspace(workspaceId).catch(() => undefined);
    this.memoryEmbeddingsByWorkspace.delete(workspaceId);
    this.embeddingsLoadedForWorkspace.delete(workspaceId);
    this.embeddingCacheGeneration += 1;
    this.embeddingBackfillInProgress.delete(workspaceId);
    this.clearCompressionStateForWorkspace(workspaceId);
    this.promptRecallCache.clear();
    SupermemoryService.scheduleOrphanSweep();
  }

  static async deleteEntries(workspaceId: string, ids: string[]): Promise<number> {
    this.ensureInitialized();
    const uniqueIds = [
      ...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean)),
    ];
    let deleted = 0;
    for (const id of uniqueIds) {
      try {
        deleted += await this.memoryRepo.deleteByWorkspaceAndId(workspaceId, id);
      } catch {
        // best-effort delete
      }
    }
    if (deleted > 0) {
      // Facts imported with these rows go with them.
      await this.closeImportedFacts(uniqueIds, "deleted");
      this.promptRecallCache.clear();
      // Their Supermemory copies go too (SEC-17).
      SupermemoryService.scheduleOrphanSweep();
    }
    return deleted;
  }

  /**
   * Replace a memory owned by a trusted, explicit source synchronizer.
   *
   * This keeps source-backed memories stable (and therefore deduplicated) while
   * refreshing their content and local embedding when the upstream document
   * changes. The workspace check prevents a source from mutating another
   * workspace's memory row.
   */
  static async replaceMemory(
    workspaceId: string,
    memoryId: string,
    content: string,
    summary?: string,
  ): Promise<Memory | null> {
    this.ensureInitialized();

    const settings = await this.settingsRepo.getOrCreate(workspaceId);
    if (!settings.enabled || settings.privacyMode === "disabled") return null;

    const current = await this.memoryRepo.findById(memoryId);
    if (!current || current.workspaceId !== workspaceId) return null;
    // A memory the user deleted or redacted in the Inspector stays that way: a source
    // re-sync must not restore its content (returning it also stops a fresh capture).
    if ((await MemoryObservationService.suppressedIds([memoryId])).has(memoryId)) return current;

    const privacyPrepared = this.applyInlinePrivacy(content);
    privacyPrepared.content = redactSecrets(privacyPrepared.content).text;
    if (this.shouldExclude(privacyPrepared.content, settings)) return null;
    const truncatedContent =
      privacyPrepared.content.length > 10000
        ? `${privacyPrepared.content.slice(0, 10000)}\n[... truncated]`
        : privacyPrepared.content;
    const finalSummary = this.buildDeterministicSummary(summary || truncatedContent);
    const updatedAt = Date.now();

    await this.memoryRepo.update(memoryId, {
      content: truncatedContent,
      summary: finalSummary || undefined,
      tokens: estimateTokens(truncatedContent),
      isCompressed: true,
    });

    try {
      await this.embeddingRepo.deleteByMemoryIds([memoryId]);
      const embedding = createLocalEmbedding(
        this.normalizeForEmbedding(finalSummary, truncatedContent),
      );
      await this.embeddingRepo.upsert(workspaceId, memoryId, embedding, updatedAt);
      this.cacheEmbedding(workspaceId, memoryId, embedding, updatedAt);
      if (this.importedEmbeddingsLoaded) {
        this.importedEmbeddings.set(memoryId, {
          updatedAt,
          embedding: Float32Array.from(embedding),
          workspaceId,
        });
      }
    } catch {
      // Search can fall back to lexical matching if local embedding refresh fails.
    }

    const updated = await this.memoryRepo.findById(memoryId);
    if (!updated) return null;

    if (MemoryFeaturesManager.loadSettings().structuredObservationsEnabled !== false) {
      try {
        await MemoryObservationService.createForMemory(updated, {
          origin: "import",
          captureReason: "box_brain_sync",
          privacyState: updated.isPrivate ? "private" : "normal",
        });
      } catch {
        // Structured observations are auxiliary and must not block source sync.
      }
    }

    this.promptRecallCache.clear();
    return updated;
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
        this.compressionDiagnosticsByWorkspace.get(workspaceId) ||
          this.createCompressionDiagnostics(),
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

  private static getCompressionDiagnosticsForWorkspace(
    workspaceId: string,
  ): CompressionDiagnostics {
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
    // While draining, a running batch stops at the next group and keeps the rest queued.
    return this.compressionPauseCount > 0 || this.draining;
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

    if (
      input.type === "observation" ||
      input.type === "insight" ||
      input.type === "screen_context"
    ) {
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
    if (type === "screen_context") {
      return tokens >= MIN_TOKENS_FOR_OBSERVATION_COMPRESSION || origin === "chronicle"
        ? "normal"
        : "low";
    }
    if (
      this.isStructuredLowValueContent(content) &&
      tokens < MIN_TOKENS_FOR_OBSERVATION_COMPRESSION
    ) {
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
  ): string {
    if (explicitBatchKey) return explicitBatchKey;
    if (taskId) return `task:${taskId}`;
    return `${origin}:${workspaceId}:${Math.floor(createdAt / COMPRESSION_BATCH_WINDOW_MS)}`;
  }

  private static isHighSignalMemoryType(type: MemoryType): boolean {
    return (
      type === "decision" ||
      type === "error" ||
      type === "preference" ||
      type === "constraint" ||
      type === "timing_preference" ||
      type === "workflow_pattern" ||
      type === "screen_context" ||
      type === "correction_rule" ||
      type === "summary"
    );
  }

  private static isStructuredLowValueContent(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return true;
    if (trimmed.includes("```")) return true;
    if (trimmed.length <= 80) return false;

    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
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

    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
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

  private static async updateMemorySummary(
    memory: Memory,
    workspaceId: string,
    summary: string,
    compressed: boolean,
  ): Promise<void> {
    const finalSummary = this.buildDeterministicSummary(summary);
    if (!finalSummary) return;

    const summaryTokens = estimateTokens(finalSummary);
    const updatedAt = Date.now();
    await this.memoryRepo.update(memory.id, {
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
      await this.embeddingRepo.upsert(workspaceId, memory.id, embedding, updatedAt);
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
    if (!this.initialized) return;
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
   * Process compression queue asynchronously (tracked, so shutdown can wait for a batch).
   */
  private static processCompressionQueue(): Promise<void> {
    return this.inFlight.track(this.runCompressionQueue());
  }

  private static async runCompressionQueue(): Promise<void> {
    if (
      !this.initialized ||
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

        const memories = (
          await Promise.all(group.memoryIds.map((memoryId) => this.memoryRepo.findById(memoryId)))
        ).filter((memory): memory is Memory => Boolean(memory));

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
      logger.error("[MemoryService] Compression queue error:", error);
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
        await this.updateMemorySummary(
          memory,
          group.workspaceId,
          this.buildDeterministicSummary(memory.content),
          true,
        );
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
    logger.info(
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
      system:
        "You write compact durable memory digests for agent work. Be factual, concise, and avoid filler.",
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
      await this.updateMemorySummary(memories[0], group.workspaceId, storageSummary, true);
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
    logger.info(
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
        settings.deepseek?.model,
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
      logger.warn("[MemoryService] Batch compression failed:", group.batchKey, error);
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
    // A digest of rows that already passed capture; an LLM-written digest is redacted again
    // so it can never reintroduce a secret value.
    const summary = neutralizeReservedImportPrefix(
      redactSecrets(this.normalizeSummaryStorageText(summaryText)).text,
    );
    if (!summary) return;

    const taskId = this.extractSharedTaskId(memories);
    const batchMemory = await this.memoryRepo.create({
      workspaceId: group.workspaceId,
      taskId,
      type: "summary",
      content: summary,
      summary,
      tokens: estimateTokens(summary),
      isCompressed: compressed,
      isPrivate: false,
    });

    await this.updateEmbeddingForMemory(batchMemory, group.workspaceId, summary);
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

  private static async updateEmbeddingForMemory(
    memory: Memory,
    workspaceId: string,
    summary: string,
  ): Promise<void> {
    try {
      const embedText = this.normalizeForEmbedding(summary, summary);
      const embedding = createLocalEmbedding(embedText);
      await this.embeddingRepo.upsert(workspaceId, memory.id, embedding, memory.updatedAt);
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
      logger.warn(
        `[MemoryService] Compression retry limit reached for batch ${group.batchKey}; giving up.`,
      );
      return;
    }

    this.compressionRetryCounts.set(group.batchKey, attempts);
    const retryDelayMs = Math.max(delayMs, COMPRESSION_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1));
    const timer = setTimeout(() => {
      this.compressionRetryTimers.delete(timer);
      if (!this.initialized) return;
      for (const memoryId of group.memoryIds) {
        if (!this.compressionQueue.includes(memoryId)) {
          this.compressionQueue.push(memoryId);
        }
      }
      this.scheduleCompressionDrain(0);
    }, retryDelayMs);
    timer.unref?.();
    this.compressionRetryTimers.add(timer);
  }

  /**
   * Run periodic cleanup based on retention policies
   */
  private static async runCleanup(): Promise<void> {
    if (!this.initialized) return;

    try {
      // Get all workspaces that have any memories (compressed or not).
      const workspacesWithMemories = await this.memoryRepo.listWorkspaceIds(5000);

      // Process each workspace
      for (const workspaceId of workspacesWithMemories) {
        const settings = await this.settingsRepo.getOrCreate(workspaceId);
        const retentionMs = settings.retentionDays * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - retentionMs;

        const deleted = await this.memoryRepo.deleteOlderThan(workspaceId, cutoff);
        if (deleted > 0) {
          logger.info(
            `[MemoryService] Cleaned up ${deleted} old memories for workspace ${workspaceId}`,
          );
        }

        await this.enforceStorageLimit(workspaceId, settings.maxStorageMb, { force: true });
      }

      // Tier promotion pass: promote short→medium→long (tiers never delete rows)
      if (this.sql) {
        await MemoryTierService.runPromotionPass(this.sql);
      }
    } catch (error) {
      logger.error("[MemoryService] Cleanup failed:", error);
    }
  }

  /**
   * Keep a workspace under its storage cap. Measuring means scanning every memory in
   * the workspace, so after a capture the last measurement plus the bytes added since
   * is trusted while it stays below 80% of the cap and is under five minutes old.
   * Deletes only lower the real size, and bulk imports and cleanup always measure.
   */
  private static async enforceStorageLimit(
    workspaceId: string,
    maxStorageMb: number,
    options: { addedBytes?: number; force?: boolean } = {},
  ): Promise<void> {
    const maxBytes = Math.max(0, Math.floor(maxStorageMb * 1024 * 1024));
    if (maxBytes <= 0) return;

    const now = Date.now();
    const estimate = this.storageEstimateByWorkspace.get(workspaceId);
    if (
      !options.force &&
      estimate &&
      now - estimate.measuredAt < MemoryService.STORAGE_ESTIMATE_MAX_AGE_MS
    ) {
      estimate.bytes += Math.max(0, options.addedBytes ?? 0);
      if (estimate.bytes < maxBytes * MemoryService.STORAGE_ESTIMATE_HEADROOM) return;
    }

    let totalBytes = await this.memoryRepo.getApproxStorageBytes(workspaceId);
    this.storageEstimateByWorkspace.set(workspaceId, { bytes: totalBytes, measuredAt: now });
    if (totalBytes <= maxBytes) return;

    let loopGuard = 0;
    while (totalBytes > maxBytes && loopGuard < 20) {
      loopGuard += 1;
      const oldest = await this.memoryRepo.getOldestForWorkspace(workspaceId, 200);
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

      const deleted = await this.memoryRepo.deleteByIds(workspaceId, idsToDelete);
      if (deleted > 0) {
        await this.embeddingRepo.deleteByMemoryIds(idsToDelete);
      } else {
        break;
      }

      totalBytes = await this.memoryRepo.getApproxStorageBytes(workspaceId);
    }
    this.storageEstimateByWorkspace.set(workspaceId, { bytes: totalBytes, measuredAt: now });
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
      // Stored patterns may predate IPC validation; never run a ReDoS-prone one (SEC-11).
      if (!isSafeExcludedPattern(pattern)) continue;
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
   * Automatic mirrors must honor the persisted workspace profile even when a
   * caller does not carry a task-local effective workspace into this service.
   * Test-only/in-memory callers may not initialize a workspace repository; in
   * that compatibility case the explicit caller option remains authoritative.
   */
  /** `{ id, name }` of a workspace for Supermemory container tags (name falls back to id). */
  private static async workspaceRefFor(workspaceId: string): Promise<{ id: string; name: string }> {
    try {
      const workspace = await this.workspaceRepo?.findById(workspaceId);
      return { id: workspaceId, name: workspace?.name || workspaceId };
    } catch {
      return { id: workspaceId, name: workspaceId };
    }
  }

  private static async isExternalMemoryMirrorAllowed(workspaceId: string): Promise<boolean> {
    if (!this.workspaceRepo) return true;
    try {
      const workspace = await this.workspaceRepo.findById(workspaceId);
      if (!workspace?.permissions) return false;
      return (
        workspace.permissions.network === true &&
        workspace.permissions.accessProfileUnavailable !== true &&
        workspace.permissions.accessNetworkMode !== "disabled" &&
        workspace.permissions.accessNetworkMode !== "on-request"
      );
    } catch {
      return false;
    }
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
   * Stop starting new work (cleanup, archive migration, compression batches, markdown
   * syncs) and wait, at most `timeoutMs`, for what is running. Shutdown awaits this before
   * `shutdown()` and before the database closes. Returns true when nothing is left running.
   */
  static async drain(timeoutMs = MemoryService.DRAIN_TIMEOUT_MS): Promise<boolean> {
    this.draining = true;
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = undefined;
    }
    if (this.compressionDrainTimer) {
      clearTimeout(this.compressionDrainTimer);
      this.compressionDrainTimer = undefined;
    }
    for (const timer of this.compressionRetryTimers) clearTimeout(timer);
    this.compressionRetryTimers.clear();
    if (this.archiveCleanupTimer) {
      clearTimeout(this.archiveCleanupTimer);
      this.archiveCleanupTimer = undefined;
    }
    const drained = await this.inFlight.drain(timeoutMs);
    if (!drained) {
      logger.warn(
        `[MemoryService] ${this.inFlight.size} memory job(s) still running after ${timeoutMs}ms; shutting down anyway`,
      );
    }
    return drained;
  }

  /**
   * Shutdown the service. Call `drain()` first to let running work finish.
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
    for (const timer of this.compressionRetryTimers) clearTimeout(timer);
    this.compressionRetryTimers.clear();
    if (this.archiveCleanupTimer) {
      clearTimeout(this.archiveCleanupTimer);
      this.archiveCleanupTimer = undefined;
    }
    if (this.promptReferenceFlushTimer) {
      clearTimeout(this.promptReferenceFlushTimer);
      this.promptReferenceFlushTimer = undefined;
    }
    this.pendingPromptReferences.clear();
    this.storageEstimateByWorkspace.clear();
    this.memoryEmbeddingsByWorkspace.clear();
    this.importedEmbeddings.clear();
    this.markdownIndex = null;
    this.importedEmbeddingsLoaded = false;
    this.importedEmbeddingBackfillInProgress = false;
    this.embeddingsLoadedForWorkspace.clear();
    this.embeddingCacheGeneration += 1;
    this.embeddingBackfillInProgress.clear();
    this.compressionQueue = [];
    this.compressionQueueEntries.clear();
    this.compressionRetryCounts.clear();
    this.compressionBudgetByWorkspace.clear();
    this.compressionDiagnosticsByWorkspace.clear();
    this.workspaceRepo = undefined;
    this.unsubscribeMemoryItemChanges?.();
    this.unsubscribeMemoryItemChanges = undefined;
    SupermemoryRemoteRefRepository.setInstance(null);
    // Work that outlived drain() is abandoned; a later initialize starts with a fresh registry.
    this.inFlight = new InFlightWork();
    this.initialized = false;
    logger.info("[MemoryService] Shutdown complete");
  }
}
