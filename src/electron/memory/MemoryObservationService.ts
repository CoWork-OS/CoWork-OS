import type Database from "better-sqlite3";
import type { Memory } from "../database/repositories";
import { storeFacade, type AsyncStore } from "../database/statements/store-units";
import { createLogger } from "../utils/logger";
import type { ObservationMetadataRow } from "./memory-capture-sql";
import { createMemoryStatementPort } from "./memory-statement-port";
import { MemoryObservationStore, type CreateOptions } from "./memory-observation-sql";
import { MEMORY_OBSERVATION_READS, MEMORY_OBSERVATION_WRITES } from "./memory-observation-units";
import type { MemoryObservationBackfillStatus } from "../../shared/types";

const logger = createLogger("MemoryObservationService");

type ObservationMethod =
  | (typeof MEMORY_OBSERVATION_READS)[number]
  | (typeof MEMORY_OBSERVATION_WRITES)[number];

/**
 * Memory observation metadata (async SQLite migration plan, DB6). Each operation is one
 * memory-domain transaction unit over `MemoryObservationStore`: in the database worker
 * when memory is routed there, one host transaction otherwise. The backfill status is
 * this process's view and stays here.
 */
export class MemoryObservationService {
  /** The observation a capture stores for `memory`, computed on the host (DB6). */
  static buildMetadataFor(memory: Memory, options: CreateOptions = {}): ObservationMetadataRow {
    return MemoryObservationStore.buildMetadataFor(memory, options);
  }

  private static store: AsyncStore<MemoryObservationStore, ObservationMethod> | null = null;
  private static status: MemoryObservationBackfillStatus = {
    total: 0,
    processed: 0,
    failed: 0,
    pending: 0,
    running: false,
  };

  static initialize(db: Database.Database): void {
    const sql = createMemoryStatementPort(db);
    this.store = storeFacade<MemoryObservationStore, ObservationMethod>(
      "observation_",
      [...MEMORY_OBSERVATION_READS, ...MEMORY_OBSERVATION_WRITES],
      (name, args) => sql.unit(name as never, args as never),
    );
  }

  static createForMemory(
    memory: Memory,
    options: CreateOptions = {},
  ): Promise<ReturnType<MemoryObservationStore["createForMemory"]>> {
    return this.requireStore().createForMemory(memory, options);
  }

  static async startBackfill(force = false): Promise<MemoryObservationBackfillStatus> {
    const store = this.requireStore();
    if (this.status.running) return this.status;
    this.status = {
      total: 0,
      processed: 0,
      failed: 0,
      pending: 0,
      running: true,
      lastRunAt: Date.now(),
    };
    try {
      const result = await store.backfill(force);
      this.status.total = result.total;
      this.status.processed = result.processed;
      this.status.failed = result.failed;
      this.status.pending = Math.max(0, result.total - result.processed - result.failed);
      if (result.lastError) this.status.lastError = result.lastError;
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.status.running = false;
      this.status.lastRunAt = Date.now();
    }
    return this.status;
  }

  static async getBackfillStatus(): Promise<MemoryObservationBackfillStatus> {
    if (!this.status.running && this.store) {
      try {
        const { total, pending } = await this.store.countBackfill();
        this.status = {
          ...this.status,
          total,
          processed: Math.max(0, total - pending),
          pending,
          running: false,
        };
      } catch (error) {
        logger.warn("[MemoryObservationService] Could not count the backfill:", error);
        this.status = {
          ...this.status,
          running: false,
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ...this.status };
  }

  static search(
    ...args: Parameters<MemoryObservationStore["search"]>
  ): Promise<ReturnType<MemoryObservationStore["search"]>> {
    return this.requireStore().search(...args);
  }

  static timeline(
    ...args: Parameters<MemoryObservationStore["timeline"]>
  ): Promise<ReturnType<MemoryObservationStore["timeline"]>> {
    return this.requireStore().timeline(...args);
  }

  static details(
    ...args: Parameters<MemoryObservationStore["details"]>
  ): Promise<ReturnType<MemoryObservationStore["details"]>> {
    return this.requireStore().details(...args);
  }

  static update(
    ...args: Parameters<MemoryObservationStore["update"]>
  ): Promise<ReturnType<MemoryObservationStore["update"]>> {
    return this.requireStore().update(...args);
  }

  static redact(
    ...args: Parameters<MemoryObservationStore["redact"]>
  ): Promise<ReturnType<MemoryObservationStore["redact"]>> {
    return this.requireStore().redact(...args);
  }

  static delete(workspaceId: string, memoryId: string): Promise<boolean> {
    return this.requireStore().delete(workspaceId, memoryId);
  }

  static async isPromptSuppressed(memoryId: string): Promise<boolean> {
    return this.store ? await this.store.isPromptSuppressed(memoryId) : false;
  }

  /** The ids among `memoryIds` hidden from prompts, in one query. */
  static async suppressedIds(memoryIds: string[]): Promise<Set<string>> {
    if (!this.store || memoryIds.length === 0) return new Set();
    return new Set(await this.store.suppressedIds(memoryIds));
  }

  private static requireStore(): AsyncStore<MemoryObservationStore, ObservationMethod> {
    if (!this.store) throw new Error("MemoryObservationService not initialized");
    return this.store;
  }
}
