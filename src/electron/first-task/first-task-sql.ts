import type Database from "better-sqlite3";
import type { Task } from "../../shared/types";
import { TaskStore } from "../database/repositories";
import {
  readLocalRealWork,
  recordLocalRealWorkInspection,
  recordLocalRealWorkUseful,
  type LocalRealWorkState,
} from "./real-work-state";

export type FirstTaskSetupChoice = "ready" | "skipped" | "browsing_without_ai" | "connecting";

export interface FirstTaskSetupRow {
  schema_version: number;
  choice: FirstTaskSetupChoice;
  updated_at: number;
  model_ready_at: number | null;
}

export interface FirstTaskAttemptRow {
  attempt_id: string;
  mission_id: string;
  workspace_id: string;
  task_id: string;
  checked_at?: number;
  check_json?: string;
  inspected_at?: number;
  revision_requested_at?: number;
  revision_base_hashes_json?: string;
  revision_inspected_at?: number;
}

/**
 * The first-task flow's SQL (async SQLite migration plan, DB6): the setup choice, sample
 * attempts and local real-work state. As services-domain units these run in the database
 * worker when the domain is routed there; `ensureFirstTaskTables` stays on the host.
 */
export class FirstTaskStore {
  constructor(private readonly db: Database.Database) {}

  getSetup(): FirstTaskSetupRow | undefined {
    return this.db
      .prepare(
        "SELECT schema_version, choice, updated_at, model_ready_at FROM first_task_setup WHERE id = 1",
      )
      .get() as FirstTaskSetupRow | undefined;
  }

  setSetupChoice(choice: FirstTaskSetupChoice, now: number): void {
    this.db
      .prepare(
        "INSERT INTO first_task_setup (id, schema_version, choice, updated_at) VALUES (1, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET choice = excluded.choice, updated_at = excluded.updated_at",
      )
      .run(choice, now);
  }

  markModelReady(now: number): void {
    this.db.prepare("UPDATE first_task_setup SET model_ready_at = ? WHERE id = 1").run(now);
  }

  /** The attempt by id, else by task, else the latest. */
  findAttempt(attemptId?: string, taskId?: string): FirstTaskAttemptRow | undefined {
    const row = attemptId
      ? this.db.prepare("SELECT * FROM first_task_attempts WHERE attempt_id = ?").get(attemptId)
      : taskId
        ? this.db.prepare("SELECT * FROM first_task_attempts WHERE task_id = ?").get(taskId)
        : this.db
            .prepare("SELECT * FROM first_task_attempts ORDER BY created_at DESC LIMIT 1")
            .get();
    return row && typeof row === "object" ? (row as FirstTaskAttemptRow) : undefined;
  }

  attemptTaskIds(): string[] {
    return (
      this.db.prepare("SELECT task_id FROM first_task_attempts").all() as Array<{ task_id: string }>
    ).map((row) => row.task_id);
  }

  /** Create the sample task and its attempt row in one transaction. */
  createSampleAttempt(input: {
    attemptId: string;
    missionId: string;
    workspaceId: string;
    task: Omit<Task, "id" | "createdAt" | "updatedAt">;
    now: number;
  }): Task {
    const created = new TaskStore(this.db).create(input.task);
    this.db
      .prepare(
        "INSERT INTO first_task_attempts (attempt_id, mission_id, workspace_id, task_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.attemptId, input.missionId, input.workspaceId, created.id, input.now);
    return created;
  }

  clearCheck(attemptId: string): void {
    this.db
      .prepare(
        "UPDATE first_task_attempts SET checked_at = NULL, check_json = NULL WHERE attempt_id = ?",
      )
      .run(attemptId);
  }

  recordCheck(attemptId: string, checkJson: string, now: number): void {
    this.db
      .prepare("UPDATE first_task_attempts SET checked_at = ?, check_json = ? WHERE attempt_id = ?")
      .run(now, checkJson, attemptId);
  }

  markInspected(attemptId: string, revision: boolean, now: number): void {
    this.db
      .prepare(
        revision
          ? "UPDATE first_task_attempts SET revision_inspected_at = ? WHERE attempt_id = ?"
          : "UPDATE first_task_attempts SET inspected_at = ? WHERE attempt_id = ?",
      )
      .run(now, attemptId);
  }

  requestRevision(attemptId: string, baseHashesJson: string, now: number): void {
    this.db
      .prepare(
        "UPDATE first_task_attempts SET revision_requested_at = ?, revision_base_hashes_json = ?, revision_inspected_at = NULL, checked_at = NULL, check_json = NULL WHERE attempt_id = ?",
      )
      .run(now, baseHashesJson, attemptId);
  }

  cancelRevision(attemptId: string, checkJson: string, now: number): void {
    this.db
      .prepare(
        "UPDATE first_task_attempts SET revision_requested_at = NULL, revision_base_hashes_json = NULL, revision_inspected_at = NULL, checked_at = ?, check_json = ? WHERE attempt_id = ?",
      )
      .run(now, checkJson, attemptId);
  }

  readRealWork(taskId: string): LocalRealWorkState {
    return readLocalRealWork(this.db, taskId);
  }

  recordRealWorkInspection(taskId: string, now: number): LocalRealWorkState {
    return recordLocalRealWorkInspection(this.db, taskId, now);
  }

  recordRealWorkUseful(taskId: string, now: number): LocalRealWorkState {
    return recordLocalRealWorkUseful(this.db, taskId, now);
  }
}
