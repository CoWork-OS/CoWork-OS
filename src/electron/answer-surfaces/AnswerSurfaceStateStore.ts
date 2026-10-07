import type Database from "better-sqlite3";
import { DatabaseManager } from "../database/schema";
import { serviceStatements } from "../database/service-statements";
import {
  ANSWER_SURFACE_STATE_SCHEMA,
  type AnswerSurfaceChange,
  type AnswerSurfaceStateRow,
} from "./answer-surface-state-sql";

type StateDatabase = Database.Database;

/**
 * Saved answer surface state (async SQLite migration plan, DB6). Each operation is one
 * services-domain unit over `AnswerSurfaceStateSqlStore`. The schema is created on the
 * host before first use; without a database reads are empty and writes are skipped, so
 * a surface still works, it just does not remember its values.
 */
export class AnswerSurfaceStateStore {
  private static dbOverride: StateDatabase | null | undefined;
  private static schemaReady = false;

  static setDatabaseForTests(db: StateDatabase | null): void {
    this.dbOverride = db;
    this.schemaReady = false;
  }

  private static ready(): StateDatabase | null {
    let db: StateDatabase | null;
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
    if (!this.schemaReady) {
      try {
        db.exec(ANSWER_SURFACE_STATE_SCHEMA);
        this.schemaReady = true;
      } catch {
        return null;
      }
    }
    return db;
  }

  static async get(taskId: string, keys: string[]): Promise<AnswerSurfaceStateRow[]> {
    const db = this.ready();
    if (!db) return [];
    return serviceStatements(db).unit("answerSurface_get", [taskId, keys]);
  }

  static async save(taskId: string, key: string, state: unknown, summary: string): Promise<void> {
    const db = this.ready();
    if (!db) return;
    await serviceStatements(db).unit("answerSurface_upsert", [
      taskId,
      key,
      JSON.stringify(state),
      summary,
      Date.now(),
    ]);
  }

  static async listUnreported(taskId: string): Promise<AnswerSurfaceChange[]> {
    const db = this.ready();
    if (!db) return [];
    return serviceStatements(db).unit("answerSurface_listUnreported", [taskId]);
  }

  static async markReported(taskId: string, keys: string[]): Promise<void> {
    const db = this.ready();
    if (!db || keys.length === 0) return;
    await serviceStatements(db).unit("answerSurface_markReported", [taskId, keys, Date.now()]);
  }

  static async deleteForTask(taskId: string): Promise<void> {
    const db = this.ready();
    if (!db) return;
    await serviceStatements(db).unit("answerSurface_deleteForTask", [taskId]);
  }
}
