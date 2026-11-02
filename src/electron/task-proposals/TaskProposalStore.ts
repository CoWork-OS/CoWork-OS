import type Database from "better-sqlite3";
import { DatabaseManager } from "../database/schema";
import { serviceStatements } from "../database/service-statements";
import type { TaskProposal, TaskProposalStatus } from "../../shared/task-proposals";
import { TASK_PROPOSAL_SCHEMA } from "./task-proposal-sql";

type ProposalDatabase = Database.Database;

/**
 * Proposed tasks (services-domain units over TaskProposalSqlStore). Without a database
 * nothing is kept: proposing fails and lists are empty.
 */
export class TaskProposalStore {
  private static dbOverride: ProposalDatabase | null | undefined;
  private static schemaReady = false;

  static setDatabaseForTests(db: ProposalDatabase | null): void {
    this.dbOverride = db;
    this.schemaReady = false;
  }

  private static ready(): ProposalDatabase | null {
    let db: ProposalDatabase | null;
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
        db.exec(TASK_PROPOSAL_SCHEMA);
        this.schemaReady = true;
      } catch {
        return null;
      }
    }
    return db;
  }

  static async insert(proposal: TaskProposal): Promise<boolean> {
    const db = this.ready();
    if (!db) return false;
    return serviceStatements(db).unit("taskProposal_insert", [proposal]);
  }

  static async get(id: string): Promise<TaskProposal | null> {
    const db = this.ready();
    if (!db) return null;
    return serviceStatements(db).unit("taskProposal_get", [id]);
  }

  static async listForTask(taskId: string): Promise<TaskProposal[]> {
    const db = this.ready();
    if (!db) return [];
    return serviceStatements(db).unit("taskProposal_listForTask", [taskId]);
  }

  static async findByStartedTask(startedTaskId: string): Promise<TaskProposal | null> {
    const db = this.ready();
    if (!db) return null;
    return serviceStatements(db).unit("taskProposal_findByStartedTask", [startedTaskId]);
  }

  static async settle(
    id: string,
    status: Exclude<TaskProposalStatus, "pending">,
    decidedAt: number,
    details: { startedTaskId?: string; withdrawReason?: string } = {},
  ): Promise<boolean> {
    const db = this.ready();
    if (!db) return false;
    return serviceStatements(db).unit("taskProposal_settle", [id, status, decidedAt, details]);
  }

  static async setStartedTask(id: string, startedTaskId: string): Promise<void> {
    const db = this.ready();
    if (!db) return;
    await serviceStatements(db).unit("taskProposal_setStartedTask", [id, startedTaskId]);
  }

  static async reopen(id: string): Promise<void> {
    const db = this.ready();
    if (!db) return;
    await serviceStatements(db).unit("taskProposal_reopen", [id]);
  }
}
