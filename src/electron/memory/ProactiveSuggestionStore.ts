import type Database from "better-sqlite3";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";
import { MemoryService } from "./MemoryService";
import {
  ensureSuggestionsSchema,
  type StoredSuggestion,
  type StoredSuggestionInput,
  type StoredSuggestionStatus,
  type SuggestionFeedbackAction,
  type SuggestionFeedbackInput,
  type SuggestionFeedbackRecord,
} from "./suggestions-sql";

/**
 * Async store for proactive suggestions and suggestion feedback (suggestions-sql.ts). Each
 * operation is one memory-domain transaction unit: in the database worker when memory is
 * routed there, one host transaction otherwise.
 */
export class ProactiveSuggestionStore {
  constructor(
    private readonly sql: MemoryStatementPort,
    private readonly now: () => number = Date.now,
  ) {}

  /** Create the schema on `db` (idempotent), then use the store through the memory port. */
  static open(db: Database.Database, now: () => number = Date.now): ProactiveSuggestionStore {
    ensureSuggestionsSchema(db);
    return new ProactiveSuggestionStore(createMemoryStatementPort(db), now);
  }

  insert(input: StoredSuggestionInput): Promise<boolean> {
    return this.sql.unit("suggestion_insert", [input]);
  }

  get(workspaceId: string, id: string): Promise<StoredSuggestion | null> {
    return this.sql.unit("suggestion_get", [workspaceId, id]);
  }

  /** Active, unexpired, non-private suggestions, newest first. */
  listActive(workspaceId: string, limit = 50): Promise<StoredSuggestion[]> {
    return this.sql.unit("suggestion_listActive", [workspaceId, this.now(), limit]);
  }

  setStatus(workspaceId: string, id: string, status: StoredSuggestionStatus): Promise<boolean> {
    return this.sql.unit("suggestion_setStatus", [workspaceId, id, status, this.now()]);
  }

  setSnoozedUntil(workspaceId: string, id: string, until: number | null): Promise<boolean> {
    return this.sql.unit("suggestion_setSnoozedUntil", [workspaceId, id, until, this.now()]);
  }

  insertFeedback(input: SuggestionFeedbackInput): Promise<boolean> {
    return this.sql.unit("suggestion_insertFeedback", [input]);
  }

  countFeedback(
    workspaceId: string,
    action: SuggestionFeedbackAction,
    limit = 1000,
  ): Promise<number> {
    return this.sql.unit("suggestion_countFeedback", [workspaceId, action, limit]);
  }

  listFeedback(workspaceId: string, limit = 100): Promise<SuggestionFeedbackRecord[]> {
    return this.sql.unit("suggestion_listFeedback", [workspaceId, limit]);
  }
}

let cache: { db: unknown; store: ProactiveSuggestionStore } | null = null;
let override: ProactiveSuggestionStore | null | undefined;

/** Inject a store (tests); pass undefined to return to the profile database. */
export function setProactiveSuggestionStoreForTesting(
  store: ProactiveSuggestionStore | null | undefined,
): void {
  override = store;
  cache = null;
}

/**
 * The suggestion store on the profile database the memory services use, or null when
 * memory is not initialized (CLI, tests without a database).
 */
export async function getProactiveSuggestionStore(): Promise<ProactiveSuggestionStore | null> {
  if (override !== undefined) return override;
  const db = MemoryService.getDatabase?.();
  if (!db) return null;
  if (cache?.db !== db) cache = { db, store: ProactiveSuggestionStore.open(db) };
  return cache.store;
}
