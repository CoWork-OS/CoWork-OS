import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { ConversationIndexStore } from "./conversation-index-sql";

/**
 * Units of the one-time move of legacy transcripts into the conversation index
 * (`DurableContextService.migrateLegacyTranscripts`), part of the memory domain. Each
 * window is one unit, so the caller yields between windows; progress is recorded in
 * `durable_context_meta`, so the migration resumes after an interruption.
 */

const conversation = (db: Database.Database) => new ConversationIndexStore(db);

export const TRANSCRIPT_UNITS = {
  transcript_migrationStart: storeUnit(conversation, "migrationStart", { readonly: false }),
  transcript_migrateSpanWindow: storeUnit(conversation, "migrateSpanWindow", { readonly: false }),
  transcript_finishSpanMigration: storeUnit(conversation, "finishSpanMigration", {
    readonly: false,
  }),
  transcript_backfillEventWindow: storeUnit(conversation, "backfillEventWindow", {
    readonly: false,
  }),
  transcript_finishEventBackfill: storeUnit(conversation, "finishEventBackfill", {
    readonly: false,
  }),
} satisfies UnitCatalog;
