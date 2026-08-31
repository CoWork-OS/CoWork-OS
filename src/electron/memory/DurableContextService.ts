import { createHash, randomUUID } from "crypto";
import type { LLMMessage } from "../agent/llm";
import { estimateMessageTokens, estimateTokens } from "../agent/context-manager";
import { DatabaseManager } from "../database/schema";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { InputSanitizer } from "../agent/security/input-sanitizer";

type DurableContextDatabase = Pick<
  import("better-sqlite3").Database,
  "exec" | "prepare" | "transaction"
>;

export interface DurableContextHit {
  id: string;
  kind: "message" | "summary";
  workspaceId: string;
  taskId: string;
  timestamp: number;
  snippet: string;
  summaryId?: string;
  messageId?: string;
  depth?: number;
  sourceMessageCount?: number;
}

export interface DurableContextDescription {
  id: string;
  kind: "message" | "summary";
  workspaceId: string;
  taskId: string;
  timestamp: number;
  text: string;
  depth?: number;
  sourceMessages?: Array<{
    id: string;
    seq: number;
    role: string;
    timestamp: number;
    text: string;
  }>;
  largePayload?: {
    id: string;
    byteLength: number;
    preview: string;
  };
}

interface PreparedDurableMessage {
  id: string;
  role: string;
  contentText: string;
  contentJson: string;
  contentHash: string;
  tokenCount: number;
  payload?: {
    id: string;
    contentHash: string;
    byteLength: number;
    summaryText: string;
    contentText: string;
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function normalizeText(text: string): string {
  return InputSanitizer.sanitizeMemoryContent(text).replace(/\s+/g, " ").trim();
}

function toSqlLikePattern(query: string): string {
  const compact = query.trim().replace(/[%_]/g, "\\$&");
  return `%${compact}%`;
}

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim().replace(/"/g, ""))
    .filter(Boolean)
    .slice(0, 12)
    .map((token) => `${token}*`)
    .join(" AND ");
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

function looksLikeDurableContextResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const result = record.result;
  if (result && typeof result === "object") {
    const resultRecord = result as Record<string, unknown>;
    const id = typeof resultRecord.id === "string" ? resultRecord.id : "";
    const kind = resultRecord.kind;
    if (
      (id.startsWith("dcm_") || id.startsWith("dcs_")) &&
      (kind === "message" || kind === "summary")
    ) {
      return true;
    }
  }
  const results = record.results;
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const entryRecord = entry as Record<string, unknown>;
    const id = typeof entryRecord.id === "string" ? entryRecord.id : "";
    return (
      (id.startsWith("dcm_") || id.startsWith("dcs_")) &&
      (entryRecord.kind === "message" || entryRecord.kind === "summary")
    );
  });
}

function isDurableContextToolResultContent(content: unknown): boolean {
  if (typeof content !== "string") return false;
  try {
    return looksLikeDurableContextResult(JSON.parse(content));
  } catch {
    return false;
  }
}

function isSerializedDurableContextToolResultText(text: string): boolean {
  const compact = text.trimStart();
  const prefix = "[tool_result ";
  if (!compact.startsWith(prefix)) return false;
  const payload = compact.endsWith("]")
    ? compact.slice(prefix.length, -1)
    : compact.slice(prefix.length);
  return isDurableContextToolResultContent(payload);
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

function snippet(text: string, max = 600): string {
  const compact = normalizeText(text);
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function durableHitPriority(kind: "message" | "summary", text: string, role?: string): number {
  if (kind === "summary") return 0;
  const compact = text.trimStart();
  if (compact.startsWith("[tool_result") || compact.startsWith("[tool_use")) return 40;
  if (compact.startsWith("[large_payload_ref:")) return 30;
  if (/^Execute this step:/i.test(compact)) return 20;
  if (role === "user" || role === "assistant") return 5;
  return 10;
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

function parseLargePayloadRef(contentJson: string): { payloadId?: string } | null {
  try {
    const parsed = JSON.parse(contentJson);
    if (parsed?.type === "large_payload_ref" && typeof parsed.payloadId === "string") {
      return { payloadId: parsed.payloadId };
    }
  } catch {
    // Plain legacy JSON payload.
  }
  return null;
}

export class DurableContextService {
  private static dbOverride: DurableContextDatabase | null | undefined;
  private static schemaReady = false;

  static setDatabaseForTests(db: DurableContextDatabase | null): void {
    this.dbOverride = db;
    this.schemaReady = false;
  }

  static isEnabled(): boolean {
    const settings = MemoryFeaturesManager.loadSettings();
    return (
      settings.durableContextEnabled === true ||
      settings.durableContextMode === "experimental" ||
      settings.durableContextMode === "on"
    );
  }

  static recordHistory(params: {
    workspaceId: string;
    taskId: string;
    messages: LLMMessage[];
    source: string;
  }): void {
    if (!this.isEnabled()) return;
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return;
    const conversationId = this.ensureConversation(db, params.workspaceId, params.taskId);
    const now = Date.now();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO durable_context_messages (
        id, conversation_id, workspace_id, task_id, seq, role, content_text,
        content_json, content_hash, token_count, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPayload = db.prepare(`
      INSERT OR IGNORE INTO durable_context_large_payloads (
        id, conversation_id, workspace_id, task_id, source_message_id, source_kind,
        content_hash, byte_length, summary_text, storage_path, metadata_json, content_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const nextSeq = this.getNextSeq(db, conversationId);
    let offset = 0;
    for (const message of params.messages) {
      const prepared = this.prepareMessage(conversationId, message);
      if (!prepared) continue;
      insert.run(
        prepared.id,
        conversationId,
        params.workspaceId,
        params.taskId,
        nextSeq + offset,
        prepared.role,
        prepared.contentText,
        prepared.contentJson,
        prepared.contentHash,
        prepared.tokenCount,
        params.source,
        now + offset,
      );
      if (prepared.payload) {
        insertPayload.run(
          prepared.payload.id,
          conversationId,
          params.workspaceId,
          params.taskId,
          prepared.id,
          "message",
          prepared.payload.contentHash,
          prepared.payload.byteLength,
          prepared.payload.summaryText,
          "",
          JSON.stringify({
            source: params.source,
            tokenCount: prepared.tokenCount,
            messageRole: prepared.role,
          }),
          prepared.payload.contentText,
          now + offset,
        );
      }
      this.upsertFtsRow(db, {
        id: prepared.id,
        kind: "message",
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        text: prepared.contentText,
      });
      offset += 1;
    }
  }

  static recordCompactionSummary(params: {
    workspaceId: string;
    taskId: string;
    removedMessages: LLMMessage[];
    summaryBlock: string;
    contextLabel?: string;
    proactive?: boolean;
  }): string | null {
    if (!this.isEnabled()) return null;
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return null;
    const sourceMessages = (params.removedMessages || []).filter(
      (message) => message && !shouldSkipInjectedMessage(message),
    );
    const summaryText = normalizeText(stripKnownSummaryTags(params.summaryBlock || ""));
    if (sourceMessages.length === 0 || !summaryText) return null;

    const tx = db.transaction(() => {
      const conversationId = this.ensureConversation(db, params.workspaceId, params.taskId);
      this.recordHistory({
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        messages: sourceMessages,
        source: "compaction_source",
      });

      const hashes = sourceMessages
        .map((message) => this.prepareMessage(conversationId, message)?.contentHash)
        .filter(Boolean);
      const sourceRows = hashes.length
        ? (db
            .prepare(
              `SELECT id, seq, created_at
               FROM durable_context_messages
               WHERE conversation_id = ?
                 AND content_hash IN (${hashes.map(() => "?").join(",")})
               ORDER BY seq ASC`,
            )
            .all(conversationId, ...hashes) as Array<{
            id: string;
            seq: number;
            created_at: number;
          }>)
        : [];
      const sourceIds = [...new Set(sourceRows.map((row) => row.id))];
      const now = Date.now();
      const earliestSeq = sourceRows[0]?.seq ?? null;
      const latestSeq = sourceRows[sourceRows.length - 1]?.seq ?? null;
      const parentSummaries =
        earliestSeq !== null && latestSeq !== null
          ? this.findParentSummaries(db, conversationId, earliestSeq, latestSeq, summaryText)
          : [];
      const depth = parentSummaries.length
        ? Math.max(...parentSummaries.map((summary) => summary.depth)) + 1
        : 0;
      const summaryId = `dcs_${hashText(
        `${conversationId}:${summaryText}:${sourceIds.join(",")}:${parentSummaries
          .map((summary) => summary.id)
          .join(",")}`,
      )}`;
      db.prepare(`
        INSERT OR IGNORE INTO durable_context_summaries (
          id, conversation_id, workspace_id, task_id, depth, kind, summary_text,
          token_count, earliest_seq, latest_seq, earliest_at, latest_at,
          source_message_count, context_label, proactive, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        summaryId,
        conversationId,
        params.workspaceId,
        params.taskId,
        depth,
        parentSummaries.length ? "node" : "leaf",
        summaryText,
        estimateTokens(summaryText),
        earliestSeq,
        latestSeq,
        sourceRows[0]?.created_at ?? now,
        sourceRows[sourceRows.length - 1]?.created_at ?? now,
        sourceIds.length,
        params.contextLabel || "",
        params.proactive ? 1 : 0,
        now,
      );
      const link = db.prepare(`
        INSERT OR IGNORE INTO durable_context_summary_messages (summary_id, message_id)
        VALUES (?, ?)
      `);
      for (const sourceId of sourceIds) link.run(summaryId, sourceId);

      const linkParent = db.prepare(`
        INSERT OR IGNORE INTO durable_context_summary_parents (summary_id, parent_summary_id)
        VALUES (?, ?)
      `);
      for (const parent of parentSummaries) linkParent.run(summaryId, parent.id);
      this.upsertFtsRow(db, {
        id: summaryId,
        kind: "summary",
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        text: summaryText,
      });
      return summaryId;
    });
    return tx();
  }

  static clearWorkspace(workspaceId: string): number {
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return 0;
    const tx = db.transaction(() => {
      db.prepare(
        `DELETE FROM durable_context_summary_parents
         WHERE summary_id IN (
           SELECT id FROM durable_context_summaries WHERE workspace_id = ?
         )
         OR parent_summary_id IN (
           SELECT id FROM durable_context_summaries WHERE workspace_id = ?
         )`,
      ).run(workspaceId, workspaceId);
      db.prepare(
        `DELETE FROM durable_context_summary_messages
         WHERE summary_id IN (
           SELECT id FROM durable_context_summaries WHERE workspace_id = ?
         )
         OR message_id IN (
           SELECT id FROM durable_context_messages WHERE workspace_id = ?
         )`,
      ).run(workspaceId, workspaceId);
      const payload = db
        .prepare(`DELETE FROM durable_context_large_payloads WHERE workspace_id = ?`)
        .run(workspaceId).changes;
      db.prepare(`DELETE FROM durable_context_fts WHERE workspace_id = ?`).run(workspaceId);
      const summaries = db
        .prepare(`DELETE FROM durable_context_summaries WHERE workspace_id = ?`)
        .run(workspaceId).changes;
      const messages = db
        .prepare(`DELETE FROM durable_context_messages WHERE workspace_id = ?`)
        .run(workspaceId).changes;
      const conversations = db
        .prepare(`DELETE FROM durable_context_conversations WHERE workspace_id = ?`)
        .run(workspaceId).changes;
      return payload + summaries + messages + conversations;
    });
    return tx();
  }

  static search(params: {
    workspaceId: string;
    taskId?: string;
    query: string;
    limit?: number;
  }): DurableContextHit[] {
    if (!this.isEnabled()) return [];
    const query = params.query.trim();
    if (!query) return [];
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return [];
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const ftsResults = this.searchWithFts(db, params, query, limit);
    if (ftsResults.length > 0) return ftsResults;
    const like = toSqlLikePattern(query);
    const taskClause = params.taskId ? "AND task_id = ?" : "";
    const taskValues = params.taskId ? [params.taskId] : [];
    const internalLimit = limit * 4;

    const summaries = db
      .prepare(
        `SELECT id, workspace_id, task_id, depth, summary_text, source_message_count, created_at
         FROM durable_context_summaries
         WHERE workspace_id = ?
           ${taskClause}
           AND summary_text LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(params.workspaceId, ...taskValues, like, internalLimit) as Array<
      Record<string, unknown>
    >;

    const messages = db
      .prepare(
        `SELECT id, workspace_id, task_id, role, content_text, created_at
         FROM durable_context_messages
         WHERE workspace_id = ?
           ${taskClause}
           AND content_text LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(params.workspaceId, ...taskValues, like, internalLimit) as Array<
      Record<string, unknown>
    >;

    return [
      ...summaries.map((row) => ({
        id: String(row.id),
        summaryId: String(row.id),
        kind: "summary" as const,
        workspaceId: String(row.workspace_id),
        taskId: String(row.task_id),
        timestamp: Number(row.created_at || 0),
        snippet: snippet(String(row.summary_text || "")),
        depth: Number(row.depth || 0),
        sourceMessageCount: Number(row.source_message_count || 0),
      })),
      ...messages
        .filter((row) => !isSerializedDurableContextToolResultText(String(row.content_text || "")))
        .map((row) => ({
          id: String(row.id),
          messageId: String(row.id),
          kind: "message" as const,
          workspaceId: String(row.workspace_id),
          taskId: String(row.task_id),
          timestamp: Number(row.created_at || 0),
          snippet: snippet(`${row.role}: ${row.content_text}`),
        })),
    ]
      .sort((a, b) => {
        const priorityDelta =
          durableHitPriority(a.kind, a.snippet) - durableHitPriority(b.kind, b.snippet);
        return priorityDelta || b.timestamp - a.timestamp;
      })
      .slice(0, limit);
  }

  static describe(params: {
    workspaceId: string;
    taskId?: string;
    id: string;
    sourceLimit?: number;
  }): DurableContextDescription | null {
    if (!this.isEnabled()) return null;
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return null;
    const id = params.id.trim();
    if (!id) return null;
    const taskClause = params.taskId ? "AND task_id = ?" : "";
    const taskValues = params.taskId ? [params.taskId] : [];

    if (id.startsWith("dcs_")) {
      const row = db
        .prepare(
          `SELECT id, workspace_id, task_id, depth, summary_text, created_at
           FROM durable_context_summaries
           WHERE id = ?
             AND workspace_id = ?
             ${taskClause}`,
        )
        .get(id, params.workspaceId, ...taskValues) as Record<string, unknown> | undefined;
      if (!row) return null;
      const sourceLimit = Math.min(Math.max(params.sourceLimit ?? 8, 1), 25);
      const sourceMessages = db
        .prepare(
          `SELECT m.id, m.seq, m.role, m.content_text, m.content_json, m.created_at
           FROM durable_context_summary_messages sm
           JOIN durable_context_messages m ON m.id = sm.message_id
           WHERE sm.summary_id = ?
           ORDER BY m.seq ASC
           LIMIT ?`,
        )
        .all(id, sourceLimit) as Array<Record<string, unknown>>;
      return {
        id: String(row.id),
        kind: "summary",
        workspaceId: String(row.workspace_id),
        taskId: String(row.task_id),
        timestamp: Number(row.created_at || 0),
        text: String(row.summary_text || ""),
        depth: Number(row.depth || 0),
        sourceMessages: sourceMessages.map((message) => ({
          id: String(message.id),
          seq: Number(message.seq || 0),
          role: String(message.role || ""),
          timestamp: Number(message.created_at || 0),
          text: this.describeMessageText(db, message),
        })),
      };
    }

    const row = db
      .prepare(
        `SELECT id, workspace_id, task_id, role, content_text, content_json, created_at
         FROM durable_context_messages
         WHERE id = ?
           AND workspace_id = ?
           ${taskClause}`,
      )
      .get(id, params.workspaceId, ...taskValues) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      kind: "message",
      workspaceId: String(row.workspace_id),
      taskId: String(row.task_id),
      timestamp: Number(row.created_at || 0),
      text: `${row.role}: ${this.describeMessageText(db, row)}`,
      ...this.describeLargePayload(db, String(row.content_json || "")),
    };
  }

  private static getDatabase(): DurableContextDatabase | null {
    if (this.dbOverride !== undefined) return this.dbOverride;
    try {
      return DatabaseManager.getInstance().getDatabase();
    } catch {
      return null;
    }
  }

  private static ensureSchema(db: DurableContextDatabase): boolean {
    if (this.schemaReady) return true;
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS durable_context_conversations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          session_key TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, task_id)
        );

        CREATE TABLE IF NOT EXISTS durable_context_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          content_text TEXT NOT NULL,
          content_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          token_count INTEGER NOT NULL,
          source TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(conversation_id, content_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_durable_context_messages_scope
          ON durable_context_messages(workspace_id, task_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS durable_context_summaries (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          depth INTEGER NOT NULL,
          kind TEXT NOT NULL,
          summary_text TEXT NOT NULL,
          token_count INTEGER NOT NULL,
          earliest_seq INTEGER,
          latest_seq INTEGER,
          earliest_at INTEGER,
          latest_at INTEGER,
          source_message_count INTEGER NOT NULL DEFAULT 0,
          context_label TEXT,
          proactive INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_durable_context_summaries_scope
          ON durable_context_summaries(workspace_id, task_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS durable_context_summary_messages (
          summary_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          PRIMARY KEY(summary_id, message_id)
        );

        CREATE TABLE IF NOT EXISTS durable_context_summary_parents (
          summary_id TEXT NOT NULL,
          parent_summary_id TEXT NOT NULL,
          PRIMARY KEY(summary_id, parent_summary_id)
        );

        CREATE TABLE IF NOT EXISTS durable_context_large_payloads (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          source_message_id TEXT,
          source_kind TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          summary_text TEXT,
          storage_path TEXT,
          metadata_json TEXT,
          content_text TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS durable_context_fts USING fts5(
          id UNINDEXED,
          kind UNINDEXED,
          workspace_id UNINDEXED,
          task_id UNINDEXED,
          text,
          tokenize='unicode61'
        );
      `);
      this.ensureColumn(db, "durable_context_large_payloads", "content_text", "TEXT");
      this.schemaReady = true;
      return true;
    } catch {
      return false;
    }
  }

  private static ensureConversation(
    db: DurableContextDatabase,
    workspaceId: string,
    taskId: string,
  ): string {
    const existing = db
      .prepare(
        `SELECT id FROM durable_context_conversations
         WHERE workspace_id = ? AND task_id = ?`,
      )
      .get(workspaceId, taskId) as { id?: string } | undefined;
    if (existing?.id) return existing.id;
    const id = `dcc_${hashText(`${workspaceId}:${taskId}`)}_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO durable_context_conversations (
        id, workspace_id, task_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, workspaceId, taskId, now, now);
    const row = db
      .prepare(
        `SELECT id FROM durable_context_conversations
         WHERE workspace_id = ? AND task_id = ?`,
      )
      .get(workspaceId, taskId) as { id?: string } | undefined;
    return row?.id || id;
  }

  private static getNextSeq(db: DurableContextDatabase, conversationId: string): number {
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM durable_context_messages
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as { next_seq?: number } | undefined;
    return Number(row?.next_seq || 1);
  }

  private static prepareMessage(
    conversationId: string,
    message: LLMMessage,
  ): PreparedDurableMessage | null {
    if (!message || shouldSkipInjectedMessage(message)) return null;
    const text = normalizeText(firstTextBlock(message));
    if (!text) return null;
    const contentJsonRaw = JSON.stringify(message.content ?? "");
    const originalContentHash = hashText(`${message.role}:${text}:${contentJsonRaw}`);
    const id = `dcm_${hashText(`${conversationId}:${originalContentHash}`)}`;
    const tokenCount = estimateMessageTokens(message);
    const { largePayloadThreshold } = durableSettings();
    if (tokenCount <= largePayloadThreshold) {
      return {
        id,
        role: message.role,
        contentText: text,
        contentJson: contentJsonRaw,
        contentHash: originalContentHash,
        tokenCount,
      };
    }

    const payloadId = `dcp_${hashText(`${conversationId}:${originalContentHash}`)}`;
    const summaryText = snippet(text, 1200);
    return {
      id,
      role: message.role,
      contentText: `[large_payload_ref:${payloadId}] ${summaryText}`,
      contentJson: JSON.stringify({
        type: "large_payload_ref",
        payloadId,
        contentHash: originalContentHash,
        tokenCount,
      }),
      contentHash: originalContentHash,
      tokenCount,
      payload: {
        id: payloadId,
        contentHash: originalContentHash,
        byteLength: Buffer.byteLength(text, "utf8"),
        summaryText,
        contentText: text,
      },
    };
  }

  private static findParentSummaries(
    db: DurableContextDatabase,
    conversationId: string,
    earliestSeq: number,
    latestSeq: number,
    summaryText: string,
  ): Array<{ id: string; depth: number }> {
    return db
      .prepare(
        `SELECT id, depth
         FROM durable_context_summaries
         WHERE conversation_id = ?
           AND earliest_seq IS NOT NULL
           AND latest_seq IS NOT NULL
           AND earliest_seq <= ?
           AND latest_seq >= ?
           AND summary_text != ?
         ORDER BY depth DESC, created_at DESC
         LIMIT 12`,
      )
      .all(conversationId, latestSeq, earliestSeq, summaryText) as Array<{
      id: string;
      depth: number;
    }>;
  }

  private static upsertFtsRow(
    db: DurableContextDatabase,
    row: {
      id: string;
      kind: "message" | "summary";
      workspaceId: string;
      taskId: string;
      text: string;
    },
  ): void {
    try {
      db.prepare(`DELETE FROM durable_context_fts WHERE id = ?`).run(row.id);
      db.prepare(
        `INSERT INTO durable_context_fts (id, kind, workspace_id, task_id, text)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, row.kind, row.workspaceId, row.taskId, row.text);
    } catch {
      // FTS is an acceleration path; LIKE search remains the fallback.
    }
  }

  private static searchWithFts(
    db: DurableContextDatabase,
    params: { workspaceId: string; taskId?: string },
    query: string,
    limit: number,
  ): DurableContextHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    try {
      const taskClause = params.taskId ? "AND f.task_id = ?" : "";
      const taskValues = params.taskId ? [params.taskId] : [];
      const internalLimit = limit * 4;
      const rows = db
        .prepare(
          `SELECT f.id, f.kind, f.workspace_id, f.task_id,
                  m.role, m.content_text, m.created_at AS message_created_at,
                  s.depth, s.summary_text, s.source_message_count,
                  s.created_at AS summary_created_at,
                  bm25(durable_context_fts) AS rank
           FROM durable_context_fts f
           LEFT JOIN durable_context_messages m ON f.kind = 'message' AND m.id = f.id
           LEFT JOIN durable_context_summaries s ON f.kind = 'summary' AND s.id = f.id
           WHERE durable_context_fts MATCH ?
             AND f.workspace_id = ?
             ${taskClause}
           ORDER BY rank ASC
           LIMIT ?`,
        )
        .all(ftsQuery, params.workspaceId, ...taskValues, internalLimit) as Array<
        Record<string, unknown>
      >;
      return rows
        .map((row) => {
          const kind: DurableContextHit["kind"] = row.kind === "summary" ? "summary" : "message";
          const rawText =
            kind === "summary" ? String(row.summary_text || "") : String(row.content_text || "");
          const timestamp =
            kind === "summary"
              ? Number(row.summary_created_at || 0)
              : Number(row.message_created_at || 0);
          return {
            id: String(row.id),
            ...(kind === "summary" ? { summaryId: String(row.id) } : { messageId: String(row.id) }),
            kind,
            workspaceId: String(row.workspace_id),
            taskId: String(row.task_id),
            timestamp,
            snippet:
              kind === "summary"
                ? snippet(String(row.summary_text || ""))
                : snippet(`${row.role}: ${row.content_text}`),
            durableEcho: kind === "message" && isSerializedDurableContextToolResultText(rawText),
            priority: durableHitPriority(kind, rawText, String(row.role || "")),
            rank: Number(row.rank || 0),
            ...(kind === "summary" ? { depth: Number(row.depth || 0) } : {}),
            ...(kind === "summary"
              ? { sourceMessageCount: Number(row.source_message_count || 0) }
              : {}),
          };
        })
        .filter((hit) => !hit.durableEcho)
        .sort((a, b) => {
          const priorityDelta = a.priority - b.priority;
          return priorityDelta || a.rank - b.rank || b.timestamp - a.timestamp;
        })
        .slice(0, limit)
        .map(({ durableEcho: _durableEcho, priority: _priority, rank: _rank, ...hit }) => hit);
    } catch {
      return [];
    }
  }

  private static describeMessageText(
    db: DurableContextDatabase,
    row: Record<string, unknown>,
  ): string {
    const contentText = String(row.content_text || "");
    const ref = parseLargePayloadRef(String(row.content_json || ""));
    if (!ref?.payloadId) return contentText;
    const payload = db
      .prepare(
        `SELECT summary_text, content_text, byte_length
         FROM durable_context_large_payloads
         WHERE id = ?`,
      )
      .get(ref.payloadId) as
      | { summary_text?: string; content_text?: string; byte_length?: number }
      | undefined;
    if (!payload) return contentText;
    const preview = snippet(String(payload.content_text || payload.summary_text || ""), 4000);
    return `[large payload ${ref.payloadId}, ${Number(payload.byte_length || 0)} bytes]\n${preview}`;
  }

  private static describeLargePayload(
    db: DurableContextDatabase,
    contentJson: string,
  ): Pick<DurableContextDescription, "largePayload"> {
    const ref = parseLargePayloadRef(contentJson);
    if (!ref?.payloadId) return {};
    const payload = db
      .prepare(
        `SELECT id, byte_length, summary_text, content_text
         FROM durable_context_large_payloads
         WHERE id = ?`,
      )
      .get(ref.payloadId) as
      | { id?: string; byte_length?: number; summary_text?: string; content_text?: string }
      | undefined;
    if (!payload?.id) return {};
    return {
      largePayload: {
        id: String(payload.id),
        byteLength: Number(payload.byte_length || 0),
        preview: snippet(String(payload.content_text || payload.summary_text || ""), 4000),
      },
    };
  }

  private static ensureColumn(
    db: DurableContextDatabase,
    tableName: string,
    columnName: string,
    definition: string,
  ): void {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) return;
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}
