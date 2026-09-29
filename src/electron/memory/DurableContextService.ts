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
import { DURABLE_CONTEXT_READS, DURABLE_CONTEXT_WRITES } from "./durable-context-units";
import { createMemoryStatementPort } from "./memory-statement-port";

export type { DurableContextDescription, DurableContextHit } from "./durable-context-sql";

type DurableContextMethod =
  | (typeof DURABLE_CONTEXT_READS)[number]
  | (typeof DURABLE_CONTEXT_WRITES)[number];

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
export class DurableContextService {
  private static dbOverride: Database.Database | null | undefined;
  private static store: {
    db: Database.Database;
    facade: AsyncStore<DurableContextStore, DurableContextMethod>;
  } | null = null;

  static setDatabaseForTests(db: Database.Database | null): void {
    this.dbOverride = db;
    this.store = null;
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
    const messages = params.messages
      .map((message) => describeMessage(message))
      .filter((message): message is HostDurableMessage => Boolean(message));
    await store.recordHistory({
      workspaceId: params.workspaceId,
      taskId: params.taskId,
      messages,
      source: params.source,
      now: Date.now(),
      largePayloadThreshold: durableSettings().largePayloadThreshold,
    });
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

  static async clearWorkspace(workspaceId: string): Promise<number> {
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
    let db: Database.Database | null;
    if (this.dbOverride !== undefined) {
      db = this.dbOverride;
    } else {
      try {
        db = DatabaseManager.getInstance().getDatabase();
      } catch {
        db = null;
      }
    }
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
