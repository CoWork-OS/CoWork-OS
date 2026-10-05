import type Database from "better-sqlite3";
import type { LLMMessage } from "../agent/llm";
import { estimateMessageTokens } from "../agent/context-manager";
import { DatabaseManager } from "../database/schema";
import { storeFacade, type AsyncStore } from "../database/statements/store-units";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import {
  DurableContextStore,
  ensureDurableContextSchema,
  hashText,
  isDurableContextToolResultContent,
  normalizeText,
  type DurableContextDescription,
  type DurableContextHit,
  type HostDurableMessage,
} from "./durable-context-sql";
import {
  CONVERSATION_INDEX_READS,
  CONVERSATION_INDEX_WRITES,
  DURABLE_CONTEXT_READS,
  DURABLE_CONTEXT_WRITES,
} from "./durable-context-units";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";
import {
  CONVERSATION_EVENT_TYPES,
  ConversationIndexStore,
  conversationEventKey,
  conversationRoleForType,
  extractConversationEventText,
  type ConversationEventInput,
  type ConversationHit,
  type ConversationSearchArgs,
} from "./conversation-index-sql";

export type { DurableContextDescription, DurableContextHit } from "./durable-context-sql";
export type { ConversationHit } from "./conversation-index-sql";

type DurableContextMethod =
  | (typeof DURABLE_CONTEXT_READS)[number]
  | (typeof DURABLE_CONTEXT_WRITES)[number];

type ConversationIndexMethod =
  | (typeof CONVERSATION_INDEX_READS)[number]
  | (typeof CONVERSATION_INDEX_WRITES)[number];

/** Pending live events are written in batches, at most this long after they arrive. */
const INDEX_FLUSH_DELAY_MS = 250;
const INDEX_FLUSH_BATCH = 200;
/** Events beyond this many pending are dropped (and counted) rather than buffered. */
const INDEX_MAX_PENDING = 5000;

export interface LegacyTranscriptMigrationResult {
  status: "completed" | "already_done" | "unavailable";
  spansIndexed: number;
  spansDeleted: number;
  eventsIndexed: number;
}

function firstTextBlock(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block: Any) => {
      if (block?.type === "text") return String(block.text || "");
      if (block?.type === "tool_use") {
        return `[tool_use ${block.name || "tool"} ${JSON.stringify(block.input || {})}]`;
      }
      if (block?.type === "tool_result") return `[tool_result ${String(block.content || "")}]`;
      if (block?.type === "image") return "[image attachment]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isDurableContextToolResultMessage(message: LLMMessage): boolean {
  if (!Array.isArray(message.content)) return false;
  const blocks = (message.content as readonly unknown[]).filter(
    (block): block is { type?: unknown; content?: unknown } =>
      Boolean(block) && typeof block === "object",
  );
  const toolResultBlocks = blocks.filter((block) => block?.type === "tool_result");
  if (toolResultBlocks.length === 0) return false;
  return toolResultBlocks.some((block) => isDurableContextToolResultContent(block.content));
}

function shouldSkipInjectedMessage(message: LLMMessage): boolean {
  if (isDurableContextToolResultMessage(message)) return true;
  const text = firstTextBlock(message).trimStart();
  return (
    text.startsWith("<cowork_memory_recall>") ||
    text.startsWith("<cowork_compaction_summary>") ||
    text.startsWith("<cowork_shared_context>") ||
    text.startsWith("<cowork_user_profile>") ||
    text.startsWith("<cowork_memory_repo>") ||
    text.startsWith("<cowork_structured_memory>") ||
    text.startsWith("<cowork_recall_hints>")
  );
}

function stripKnownSummaryTags(text: string): string {
  return text
    .replace(/<\/?cowork_compaction_summary>/g, "")
    .replace(/<\/?durable_context_summary[^>]*>/g, "")
    .trim();
}

function durableSettings(): {
  largePayloadThreshold: number;
} {
  const settings = MemoryFeaturesManager.loadSettings();
  return {
    largePayloadThreshold:
      typeof settings.durableContextLargePayloadThreshold === "number" &&
      Number.isFinite(settings.durableContextLargePayloadThreshold)
        ? Math.max(1, Math.floor(settings.durableContextLargePayloadThreshold))
        : 25000,
  };
}

/**
 * The host part of storing a message: everything independent of its conversation. Needs
 * the token estimator, so it stays out of the database worker.
 */
function describeMessage(message: LLMMessage): HostDurableMessage | null {
  if (!message || shouldSkipInjectedMessage(message)) return null;
  const text = normalizeText(firstTextBlock(message));
  if (!text) return null;
  const contentJson = JSON.stringify(message.content ?? "");
  return {
    role: message.role,
    text,
    contentJson,
    contentHash: hashText(`${message.role}:${text}:${contentJson}`),
    tokenCount: estimateMessageTokens(message),
  };
}

/**
 * Durable context (async SQLite migration plan, DB6). Each operation is one memory-domain
 * transaction unit over `DurableContextStore`: in the database worker when memory is
 * routed there, one host transaction otherwise. Recording history and a compaction
 * summary are single transactions. The schema is created on the host before first use.
 */
/** Sources whose callers pass the whole live history on every update. */
const FULL_HISTORY_SOURCES = new Set(["runtime_history", "executor_history"]);
const RECORDED_HISTORY_MAX_ENTRIES = 500;

interface RecordedHistoryMark {
  count: number;
  firstHash: string;
  lastHash: string;
}

function messageFingerprint(message: LLMMessage | undefined): string {
  if (!message) return "";
  return describeMessage(message)?.contentHash ?? "skipped";
}

/**
 * Durable context and the conversation index.
 *
 * - The conversation index (`indexEvent`, `searchConversation`, `recentConversation`)
 *   is the one search index over task conversations. It is fed from the task event
 *   pipeline for every task, whatever the memory settings, and is what `memory_recall`
 *   (conversations scope), the query orchestrator, Dreaming and Mission Control recall query.
 * - `durableContextEnabled` / `durableContextMode` only control the compaction-recovery
 *   layer: recording the full LLM message history and compaction summaries
 *   (`recordHistory`, `recordCompactionSummary`) and the `context_recall` tool over it
 *   (`search`, `describe`).
 */
export class DurableContextService {
  private static dbOverride: Database.Database | null | undefined;
  private static pendingEvents: ConversationEventInput[] = [];
  private static droppedEvents = 0;
  private static flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static flushing: Promise<void> | null = null;
  private static conversation: {
    db: Database.Database;
    facade: AsyncStore<ConversationIndexStore, ConversationIndexMethod>;
    port: MemoryStatementPort;
  } | null = null;
  private static migrationRun: Promise<LegacyTranscriptMigrationResult> | null = null;
  /**
   * How much of each task's full history has been recorded, so a growing history
   * sends only its new tail instead of every message on every turn. A history that
   * no longer extends the recorded prefix (compaction, rewrite) is sent whole and
   * deduplicated by content hash in the store.
   */
  private static readonly recordedHistory = new Map<string, RecordedHistoryMark>();
  private static store: {
    db: Database.Database;
    facade: AsyncStore<DurableContextStore, DurableContextMethod>;
  } | null = null;

  static setDatabaseForTests(db: Database.Database | null): void {
    this.dbOverride = db;
    this.store = null;
    this.conversation = null;
    this.recordedHistory.clear();
    this.pendingEvents = [];
    this.droppedEvents = 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  // -------------------------------------------------------------------------
  // Conversation index
  // -------------------------------------------------------------------------

  /** Whether an event type is indexed; lets callers skip work for other events. */
  static isConversationEventType(type: string): boolean {
    return CONVERSATION_EVENT_TYPES.has(type);
  }

  /**
   * Queue one task event for the conversation index. Extraction is synchronous and
   * cheap; rows are written in batches shortly after. Never throws.
   */
  static indexEvent(params: {
    workspaceId: string;
    taskId: string;
    type: string;
    payload: unknown;
    timestamp: number;
    eventId?: string | null;
    seq?: number | null;
    id?: string | null;
  }): void {
    try {
      if (!params.workspaceId || !params.taskId) return;
      const text = extractConversationEventText(params.type, params.payload);
      if (!text) return;
      if (this.pendingEvents.length >= INDEX_MAX_PENDING) {
        this.droppedEvents += 1;
        return;
      }
      this.pendingEvents.push({
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        eventKey: conversationEventKey(params),
        eventId: params.eventId ?? null,
        seq: typeof params.seq === "number" ? params.seq : null,
        type: params.type,
        role: conversationRoleForType(params.type),
        text,
        timestamp: Number(params.timestamp) || Date.now(),
      });
      this.scheduleFlush();
    } catch {
      // Indexing is best effort; the event itself is already in task_events.
    }
  }

  /** Write every queued event now (tests, shutdown, before a search that needs them). */
  static async flushIndexQueue(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) await this.flushing;
    if (this.pendingEvents.length === 0) return;
    this.flushing = (async () => {
      const facade = this.getConversation()?.facade;
      while (this.pendingEvents.length > 0) {
        const batch = this.pendingEvents.splice(0, INDEX_FLUSH_BATCH);
        if (!facade) continue;
        try {
          await facade.indexEvents(batch);
        } catch {
          // A failed batch is dropped; search simply misses those events.
        }
      }
    })().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  static async searchConversation(
    params: Omit<ConversationSearchArgs, "limit"> & { limit?: number },
  ): Promise<ConversationHit[]> {
    const query = String(params.query || "").trim();
    if (!query || !params.workspaceId) return [];
    const conversation = this.getConversation();
    if (!conversation) return [];
    await this.flushIndexQueue();
    return conversation.facade.search({
      ...params,
      query,
      taskId: params.taskId || null,
      limit: Math.min(Math.max(params.limit ?? 10, 1), 200),
    });
  }

  /**
   * One conversation-index event (`dce_…`) or compaction summary (`dcs_…`) of the
   * workspace (and task, when given), whatever the durable-context setting: the
   * expansion step of MemoryRecall's conversation lane.
   */
  static async describeConversationHit(params: {
    workspaceId: string;
    taskId?: string;
    id: string;
  }): Promise<DurableContextDescription | null> {
    const id = String(params.id || "").trim();
    if (!params.workspaceId || !/^dc[es]_[A-Za-z0-9_-]+$/.test(id)) return null;
    await this.flushIndexQueue();
    const store = this.getStore();
    if (!store) return null;
    return store.describe({
      workspaceId: params.workspaceId,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      id,
      sourceLimit: 8,
    });
  }

  /** The most recent indexed events of one task, oldest first. */
  static async recentConversation(params: {
    workspaceId: string;
    taskId: string;
    limit?: number;
  }): Promise<ConversationHit[]> {
    if (!params.workspaceId || !params.taskId) return [];
    const conversation = this.getConversation();
    if (!conversation) return [];
    await this.flushIndexQueue();
    return conversation.facade.recent({
      workspaceId: params.workspaceId,
      taskId: params.taskId,
      limit: Math.min(Math.max(params.limit ?? 20, 1), 200),
    });
  }

  /** Remove a task's conversation index rows. */
  static async deleteTaskConversation(taskId: string): Promise<number> {
    if (!taskId) return 0;
    this.pendingEvents = this.pendingEvents.filter((event) => event.taskId !== taskId);
    const conversation = this.getConversation();
    return conversation ? await conversation.facade.deleteTask(taskId) : 0;
  }

  /**
   * Retention aligned with task-event retention: index rows and durable history of
   * terminal tasks created before the cutoff, and of deleted tasks, are removed.
   */
  static async pruneConversationRetention(
    options: { retentionDays?: number; now?: number; maxTasksPerBatch?: number } = {},
  ): Promise<{ tasks: number; rows: number }> {
    const conversation = this.getConversation();
    const total = { tasks: 0, rows: 0 };
    if (!conversation) return total;
    await this.flushIndexQueue();
    const days =
      typeof options.retentionDays === "number" && Number.isFinite(options.retentionDays)
        ? Math.max(0, options.retentionDays)
        : 90;
    const cutoff = (options.now ?? Date.now()) - days * 24 * 60 * 60 * 1000;
    const maxTasks = Math.max(1, Math.floor(options.maxTasksPerBatch ?? 100));
    for (let round = 0; round < 1000; round += 1) {
      const result = await conversation.facade.pruneRetention({ cutoff, maxTasks });
      total.tasks += result.tasks;
      total.rows += result.rows;
      if (result.tasks < maxTasks) break;
    }
    return total;
  }

  /**
   * One-time move of legacy transcripts into the conversation index: index the
   * `transcript_spans` rows window by window and delete them (read compatibility keeps
   * searching the not-yet-moved rows), then backfill the index from `task_events`.
   * Bounded batches with the event loop yielding in between; resumable, since progress
   * is recorded in the database. Freed pages are left to the idle VACUUM.
   */
  static migrateLegacyTranscripts(
    options: { batchSize?: number; pauseMs?: number; log?: (message: string) => void } = {},
  ): Promise<LegacyTranscriptMigrationResult> {
    if (!this.migrationRun) {
      this.migrationRun = this.migrateLegacyTranscriptsOnce(options).finally(() => {
        this.migrationRun = null;
      });
    }
    return this.migrationRun;
  }

  private static async migrateLegacyTranscriptsOnce(options: {
    batchSize?: number;
    pauseMs?: number;
    log?: (message: string) => void;
  }): Promise<LegacyTranscriptMigrationResult> {
    const result: LegacyTranscriptMigrationResult = {
      status: "unavailable",
      spansIndexed: 0,
      spansDeleted: 0,
      eventsIndexed: 0,
    };
    const port = this.getConversation()?.port;
    if (!port) return result;
    const batch = Math.max(1, Math.floor(options.batchSize ?? 200));
    const pauseMs = Math.max(0, Math.floor(options.pauseMs ?? 10));
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
    const start = await port.unit("transcript_migrationStart", [Date.now()]);
    if (start.spans.status === "done" && start.events.status === "done") {
      result.status = "already_done";
      return result;
    }
    if (start.spans.status === "pending") {
      let cursor = start.spans.cursor;
      while (cursor < start.spans.maxRowid) {
        const upper = Math.min(cursor + batch, start.spans.maxRowid);
        const moved = await port.unit("transcript_migrateSpanWindow", [cursor, upper, Date.now()]);
        result.spansIndexed += moved.indexed;
        result.spansDeleted += moved.deleted;
        cursor = upper;
        await pause();
      }
      const finished = await port.unit("transcript_finishSpanMigration", [Date.now()]);
      result.spansDeleted += finished.deleted;
    }
    if (start.events.status === "pending") {
      let cursor = start.events.cursor;
      const eventBatch = batch * 4;
      while (cursor < start.events.maxRowid) {
        const upper = Math.min(cursor + eventBatch, start.events.maxRowid);
        const filled = await port.unit("transcript_backfillEventWindow", [
          cursor,
          upper,
          Date.now(),
        ]);
        result.eventsIndexed += filled.indexed;
        cursor = upper;
        await pause();
      }
      await port.unit("transcript_finishEventBackfill", [Date.now()]);
    }
    result.status = "completed";
    options.log?.(
      `[DurableContext] Conversation index migration: indexed ${result.spansIndexed} legacy ` +
        `transcript span(s) and deleted ${result.spansDeleted}; backfilled ` +
        `${result.eventsIndexed} task event(s).`,
    );
    return result;
  }

  private static scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushIndexQueue();
    }, INDEX_FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  /** Conversation index units for the current database, schema created on first use. */
  private static getConversation(): {
    facade: AsyncStore<ConversationIndexStore, ConversationIndexMethod>;
    port: MemoryStatementPort;
  } | null {
    const db = this.resolveDatabase();
    if (!db) return null;
    if (this.conversation?.db === db) return this.conversation;
    try {
      ensureDurableContextSchema(db);
    } catch {
      return null;
    }
    const port = createMemoryStatementPort(db);
    const facade = storeFacade<ConversationIndexStore, ConversationIndexMethod>(
      "conversation_",
      [...CONVERSATION_INDEX_READS, ...CONVERSATION_INDEX_WRITES],
      (name, args) => port.unit(name as never, args as never),
    );
    this.conversation = { db, facade, port };
    return this.conversation;
  }

  private static resolveDatabase(): Database.Database | null {
    if (this.dbOverride !== undefined) return this.dbOverride;
    try {
      return DatabaseManager.getInstance().getDatabase();
    } catch {
      return null;
    }
  }

  static isEnabled(): boolean {
    const settings = MemoryFeaturesManager.loadSettings();
    return (
      settings.durableContextEnabled === true ||
      settings.durableContextMode === "experimental" ||
      settings.durableContextMode === "on"
    );
  }

  static async recordHistory(params: {
    workspaceId: string;
    taskId: string;
    messages: LLMMessage[];
    source: string;
  }): Promise<void> {
    if (!this.isEnabled()) return;
    const store = this.getStore();
    if (!store) return;
    const incremental = FULL_HISTORY_SOURCES.has(params.source);
    const markKey = `${params.workspaceId}\u0000${params.taskId}\u0000${params.source}`;
    let startIndex = 0;
    if (incremental) {
      const mark = this.recordedHistory.get(markKey);
      if (
        mark &&
        params.messages.length >= mark.count &&
        messageFingerprint(params.messages[0]) === mark.firstHash &&
        messageFingerprint(params.messages[mark.count - 1]) === mark.lastHash
      ) {
        startIndex = mark.count;
      }
    }
    const messages = params.messages
      .slice(startIndex)
      .map((message) => describeMessage(message))
      .filter((message): message is HostDurableMessage => Boolean(message));
    if (messages.length > 0) {
      await store.recordHistory({
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        messages,
        source: params.source,
        now: Date.now(),
        largePayloadThreshold: durableSettings().largePayloadThreshold,
      });
    }
    if (incremental && params.messages.length > 0) {
      // Recorded only after the write succeeded; a failed write is retried in full.
      this.recordedHistory.delete(markKey);
      this.recordedHistory.set(markKey, {
        count: params.messages.length,
        firstHash: messageFingerprint(params.messages[0]),
        lastHash: messageFingerprint(params.messages[params.messages.length - 1]),
      });
      while (this.recordedHistory.size > RECORDED_HISTORY_MAX_ENTRIES) {
        const oldest = this.recordedHistory.keys().next().value;
        if (oldest === undefined) break;
        this.recordedHistory.delete(oldest);
      }
    }
  }

  static async recordCompactionSummary(params: {
    workspaceId: string;
    taskId: string;
    removedMessages: LLMMessage[];
    summaryBlock: string;
    contextLabel?: string;
    proactive?: boolean;
  }): Promise<string | null> {
    if (!this.isEnabled()) return null;
    const store = this.getStore();
    if (!store) return null;
    const sourceMessages = (params.removedMessages || [])
      .filter((message) => message && !shouldSkipInjectedMessage(message))
      .map((message) => describeMessage(message))
      .filter((message): message is HostDurableMessage => Boolean(message));
    const summaryText = normalizeText(stripKnownSummaryTags(params.summaryBlock || ""));
    if (sourceMessages.length === 0 || !summaryText) return null;
    return store.recordCompactionSummary({
      workspaceId: params.workspaceId,
      taskId: params.taskId,
      sourceMessages,
      summaryText,
      contextLabel: params.contextLabel,
      proactive: params.proactive,
      now: Date.now(),
      largePayloadThreshold: durableSettings().largePayloadThreshold,
    });
  }

  /** Remove the workspace's durable history and conversation index rows. */
  static async clearWorkspace(workspaceId: string): Promise<number> {
    this.pendingEvents = this.pendingEvents.filter((event) => event.workspaceId !== workspaceId);
    for (const key of this.recordedHistory.keys()) {
      if (key.startsWith(`${workspaceId}\u0000`)) this.recordedHistory.delete(key);
    }
    const store = this.getStore();
    return store ? await store.clearWorkspace(workspaceId) : 0;
  }

  static async search(params: {
    workspaceId: string;
    taskId?: string;
    query: string;
    limit?: number;
  }): Promise<DurableContextHit[]> {
    if (!this.isEnabled()) return [];
    const query = params.query.trim();
    if (!query) return [];
    const store = this.getStore();
    if (!store) return [];
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    return store.search({
      workspaceId: params.workspaceId,
      taskId: params.taskId,
      query,
      limit,
    });
  }

  static async describe(params: {
    workspaceId: string;
    taskId?: string;
    id: string;
    sourceLimit?: number;
  }): Promise<DurableContextDescription | null> {
    if (!this.isEnabled()) return null;
    const store = this.getStore();
    if (!store) return null;
    const id = params.id.trim();
    if (!id) return null;
    return store.describe({ ...params, id });
  }

  /** The unit facade for the current database, creating its schema on first use. */
  private static getStore(): AsyncStore<DurableContextStore, DurableContextMethod> | null {
    const db = this.resolveDatabase();
    if (!db) return null;
    if (this.store?.db === db) return this.store.facade;
    try {
      ensureDurableContextSchema(db);
    } catch {
      return null;
    }
    const sql = createMemoryStatementPort(db);
    const facade = storeFacade<DurableContextStore, DurableContextMethod>(
      "durable_",
      [...DURABLE_CONTEXT_READS, ...DURABLE_CONTEXT_WRITES],
      (name, args) => sql.unit(name as never, args as never),
    );
    this.store = { db, facade };
    return facade;
  }
}
