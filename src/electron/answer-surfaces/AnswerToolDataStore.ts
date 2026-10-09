import type Database from "better-sqlite3";
import { DatabaseManager } from "../database/schema";
import { serviceStatements } from "../database/service-statements";
import { ANSWER_TOOL_DATA_SCHEMA, type AnswerToolDataRow } from "./tool-data-sql";

type ToolDataDatabase = Database.Database;

/**
 * Tool results kept as answer data (services-domain units over AnswerToolDataSqlStore).
 * Without a database nothing is kept and lookups find nothing, so answers that refer to a
 * tool result simply say it is unavailable.
 */
export class AnswerToolDataStore {
  private static dbOverride: ToolDataDatabase | null | undefined;
  private static schemaReady = false;

  static setDatabaseForTests(db: ToolDataDatabase | null): void {
    this.dbOverride = db;
    this.schemaReady = false;
  }

  private static ready(): ToolDataDatabase | null {
    let db: ToolDataDatabase | null;
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
        db.exec(ANSWER_TOOL_DATA_SCHEMA);
        this.schemaReady = true;
      } catch {
        return null;
      }
    }
    return db;
  }

  static async put(
    taskId: string,
    handle: string,
    toolUseId: string,
    toolName: string,
    tableJson: string,
  ): Promise<void> {
    const db = this.ready();
    if (!db) return;
    await serviceStatements(db).unit("answerToolData_put", [
      taskId,
      handle,
      toolUseId,
      toolName,
      tableJson,
      Date.now(),
    ]);
  }

  static async get(taskId: string, handle: string): Promise<AnswerToolDataRow | null> {
    const db = this.ready();
    if (!db) return null;
    return serviceStatements(db).unit("answerToolData_get", [taskId, handle]);
  }
}
