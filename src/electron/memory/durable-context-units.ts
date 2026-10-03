import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { DurableContextStore } from "./durable-context-sql";
import { ConversationIndexStore } from "./conversation-index-sql";

/**
 * Durable context units (async SQLite migration plan, DB6), part of the memory domain:
 * the compaction-recovery history (messages, summaries) and the conversation index.
 */

const store = (db: Database.Database) => new DurableContextStore(db);
const conversation = (db: Database.Database) => new ConversationIndexStore(db);

export const DURABLE_CONTEXT_READS = ["search", "describe"] as const;
export const DURABLE_CONTEXT_WRITES = [
  "recordHistory",
  "recordCompactionSummary",
  "clearWorkspace",
] as const;

export const CONVERSATION_INDEX_READS = ["search", "recent"] as const;
export const CONVERSATION_INDEX_WRITES = ["indexEvents", "deleteTask", "pruneRetention"] as const;

export const DURABLE_CONTEXT_UNITS = {
  durable_search: storeUnit(store, "search", { readonly: true }),
  durable_describe: storeUnit(store, "describe", { readonly: true }),
  durable_recordHistory: storeUnit(store, "recordHistory", { readonly: false }),
  durable_recordCompactionSummary: storeUnit(store, "recordCompactionSummary", {
    readonly: false,
  }),
  durable_clearWorkspace: storeUnit(store, "clearWorkspace", { readonly: false }),
  conversation_search: storeUnit(conversation, "search", { readonly: true }),
  conversation_recent: storeUnit(conversation, "recent", { readonly: true }),
  conversation_indexEvents: storeUnit(conversation, "indexEvents", { readonly: false }),
  conversation_deleteTask: storeUnit(conversation, "deleteTask", { readonly: false }),
  conversation_pruneRetention: storeUnit(conversation, "pruneRetention", { readonly: false }),
} satisfies UnitCatalog;
