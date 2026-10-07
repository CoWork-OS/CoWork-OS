import { assertSchedulerFence, type SchedulerFence } from "./scheduler-lease-store";
import type Database from "better-sqlite3";
import {
  botWorkControlRequestSchema,
  botWorkControlReadSchema,
  botWorkControlScopeSchema,
  type BotFutureControlState,
  type BotWorkControlReceipt,
} from "../../shared/bot-work-control";
export class BotWorkControlStore {
  constructor(private db: Database.Database) {}
  assertNotStopped(taskId: string): void {
    assertTaskNotStopped(this.db, taskId);
  }
  private scope(raw: unknown) {
    const request = botWorkControlReadSchema.parse(raw);
    if (!this.db.prepare("SELECT id FROM workspaces WHERE id=?").get(request.scope.workspaceId))
      throw new Error("Workspace not found");
    if (!this.db.prepare("SELECT id FROM agent_roles WHERE id=?").get(request.scope.agentRoleId))
      throw new Error("Bot not found");
    return request;
  }
  read(raw: unknown): BotWorkControlReceipt | null {
    this.scope(raw);
    return this.readPersisted(raw);
  }
  private readPersisted(raw: unknown): BotWorkControlReceipt | null {
    const request = botWorkControlReadSchema.parse(raw);
    const row = this.db
      .prepare(
        "SELECT receipt_json FROM bot_work_control_receipts WHERE workspace_id=? AND agent_role_id=? AND request_id=?",
      )
      .get(request.scope.workspaceId, request.scope.agentRoleId, request.requestId) as
      | { receipt_json: string }
      | undefined;
    return row ? JSON.parse(row.receipt_json) : null;
  }

  futurePaused(workspaceId: string, agentRoleId: string): boolean {
    return readBotFuturePaused(this.db, workspaceId, agentRoleId);
  }
  futureState(raw: unknown): BotFutureControlState {
    const { scope } = botWorkControlScopeSchema.parse(raw);
    this.scope({ scope, requestId: "state" });
    const row = this.db
      .prepare(
        "SELECT paused,version FROM bot_future_controls WHERE workspace_id=? AND agent_role_id=?",
      )
      .get(scope.workspaceId, scope.agentRoleId) as { paused: number; version: number } | undefined;
    const responsibilities = this.db
      .prepare(
        "SELECT id FROM bot_responsibilities WHERE workspace_id=? AND agent_role_id=? ORDER BY id",
      )
      .all(scope.workspaceId, scope.agentRoleId) as { id: string }[];
    return {
      scope,
      futurePaused: row?.paused === 1,
      futureControlVersion: row?.version ?? 0,
      responsibilityIds: responsibilities.map((item) => item.id),
    };
  }
  recoverable(limit = 32) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid recovery limit");
    const rows = this.db
      .prepare(`SELECT DISTINCT r.request_json,r.receipt_json
      FROM bot_work_control_receipts r,json_each(r.receipt_json,'$.tasks') t
      JOIN bot_task_stop_intents i ON i.task_id=json_extract(t.value,'$.taskId')
      WHERE i.active=1 AND i.version=json_extract(t.value,'$.stopVersion')
        AND json_extract(t.value,'$.status') IN ('requested','failed')
      ORDER BY json_extract(r.receipt_json,'$.updatedAt') LIMIT ?`)
      .all(limit) as { request_json: string; receipt_json: string }[];
    return rows.map((row) => ({
      request: botWorkControlRequestSchema.parse(JSON.parse(row.request_json)),
      receipt: JSON.parse(row.receipt_json) as BotWorkControlReceipt,
    }));
  }
  begin(
    raw: unknown,
    now: number,
    runtimeTaskIds: string[] = [],
    fence?: SchedulerFence,
  ): BotWorkControlReceipt {
    const input = botWorkControlRequestSchema.parse(raw);
    return this.db
      .transaction(() => {
        if (fence) assertSchedulerFence(this.db, fence);
        this.scope({ scope: input.scope, requestId: input.requestId });
        const old = this.db
          .prepare(
            "SELECT request_json,receipt_json FROM bot_work_control_receipts WHERE workspace_id=? AND agent_role_id=? AND request_id=?",
          )
          .get(input.scope.workspaceId, input.scope.agentRoleId, input.requestId) as
          | { request_json: string; receipt_json: string }
          | undefined;
        if (old) {
          if (old.request_json !== JSON.stringify(input))
            throw new Error("Control request identity changed");
          return JSON.parse(old.receipt_json) as BotWorkControlReceipt;
        }
        const owned = `WITH RECURSIVE owned(id) AS (
    SELECT id FROM tasks WHERE workspace_id=? AND assigned_agent_role_id=?
    UNION SELECT child.id FROM tasks child JOIN owned parent ON child.parent_task_id=parent.id WHERE child.workspace_id=?
    UNION SELECT task.id FROM orchestration_graph_nodes node JOIN orchestration_graph_runs run ON run.id=node.run_id
      JOIN owned parent ON run.root_task_id=parent.id JOIN tasks task ON task.id=node.task_id
      WHERE run.workspace_id=? AND task.workspace_id=?
   )`;
        const scopeArgs = [
          input.scope.workspaceId,
          input.scope.agentRoleId,
          input.scope.workspaceId,
          input.scope.workspaceId,
          input.scope.workspaceId,
        ];
        if (
          input.taskId &&
          !this.db
            .prepare(`${owned} SELECT id FROM owned WHERE id=?`)
            .get(...scopeArgs, input.taskId)
        )
          throw new Error("Task is outside this bot's workspace lineage");
        const selection = input.taskId
          ? `${owned}, selected(id) AS (SELECT id FROM owned WHERE id=? UNION SELECT t.id FROM tasks t JOIN selected p ON t.parent_task_id=p.id JOIN owned o ON o.id=t.id UNION SELECT t.id FROM orchestration_graph_nodes n JOIN orchestration_graph_runs r ON r.id=n.run_id JOIN selected p ON r.root_task_id=p.id JOIN tasks t ON t.id=n.task_id JOIN owned o ON o.id=t.id WHERE r.workspace_id=?) SELECT t.id,t.status FROM tasks t JOIN selected s ON s.id=t.id ORDER BY t.id`
          : `${owned} SELECT t.id,t.status FROM tasks t JOIN owned o ON o.id=t.id WHERE t.status NOT IN ('completed','failed','cancelled') OR t.id IN (SELECT value FROM json_each(?)) ORDER BY t.id`;
        const rows = this.db
          .prepare(selection)
          .all(
            ...scopeArgs,
            ...(input.taskId
              ? [input.taskId, input.scope.workspaceId]
              : [JSON.stringify(runtimeTaskIds)]),
          ) as {
          id: string;
          status: string;
        }[];
        const receipt: BotWorkControlReceipt = {
          scope: input.scope,
          requestId: input.requestId,
          action: input.action,
          recordedAt: now,
          updatedAt: now,
          status: rows.length ? "pending" : "settled",
          tasks: [],
          stillActiveTaskIds: input.action === "resume_turn" ? [] : rows.map((row) => row.id),
        };
        if (["pause_bot", "resume_bot", "stop_and_pause"].includes(input.action)) {
          const state = this.futureState({ scope: input.scope });
          if (input.action === "resume_bot") {
            if (state.futureControlVersion !== input.expectedFutureControlVersion)
              throw new Error("Bot future control version changed");
            const bot = this.db
              .prepare("SELECT is_active FROM agent_roles WHERE id=?")
              .get(input.scope.agentRoleId) as { is_active: number } | undefined;
            if (bot?.is_active !== 1) throw new Error("Bot is unavailable");
          }
          this.db
            .prepare(
              "INSERT INTO bot_future_controls(workspace_id,agent_role_id,paused,version) VALUES(?,?,?,?) ON CONFLICT(workspace_id,agent_role_id) DO UPDATE SET paused=excluded.paused,version=excluded.version",
            )
            .run(
              input.scope.workspaceId,
              input.scope.agentRoleId,
              input.action === "resume_bot" ? 0 : 1,
              state.futureControlVersion + 1,
            );
          receipt.futureControl = this.futureState({ scope: input.scope });
        }
        if (input.action === "pause_bot" || input.action === "resume_bot") {
          receipt.status = "settled";
          // Existing work continues; these IDs are an immutable admission-time snapshot.
        } else if (input.action === "resume_turn") {
          const intent = this.db
            .prepare("SELECT version FROM bot_task_stop_intents WHERE task_id=? AND active=1")
            .get(input.taskId) as { version: number } | undefined;
          const task = this.db.prepare("SELECT status FROM tasks WHERE id=?").get(input.taskId) as {
            status: string;
          };
          const pending = this.db
            .prepare(`SELECT 1 FROM bot_work_control_receipts r,json_each(r.receipt_json,'$.tasks') t
          WHERE json_extract(t.value,'$.taskId')=? AND json_extract(t.value,'$.status')='requested' LIMIT 1`)
            .get(input.taskId);
          if (!intent || intent.version !== input.expectedStopVersion)
            throw new Error("Task stop version changed");
          if (pending || !["completed", "failed", "cancelled"].includes(task.status))
            throw new Error("Task cleanup is not settled");
          this.db
            .prepare("UPDATE bot_task_stop_intents SET active=0,version=version+1 WHERE task_id=?")
            .run(input.taskId);
          receipt.status = "settled";
          receipt.tasks = [
            { taskId: input.taskId!, status: "released", stopVersion: intent.version + 1 },
          ];
        } else {
          for (const row of rows) {
            this.db
              .prepare(
                "INSERT INTO bot_task_stop_intents(task_id,requested_at,version,active) VALUES(?,?,1,1) ON CONFLICT(task_id) DO UPDATE SET requested_at=excluded.requested_at,version=version+1,active=1",
              )
              .run(row.id, now);
            const intent = this.db
              .prepare("SELECT version FROM bot_task_stop_intents WHERE task_id=?")
              .get(row.id) as { version: number };
            receipt.tasks.push({
              taskId: row.id,
              status: "requested",
              stopVersion: intent.version,
            });
          }
        }
        if (["stop_turn", "stop_bot", "stop_and_pause"].includes(input.action))
          this.closeGraphAdmission(receipt, now);
        this.db
          .prepare(
            "INSERT INTO bot_work_control_receipts(workspace_id,agent_role_id,request_id,request_json,receipt_json) VALUES(?,?,?,?,?)",
          )
          .run(
            input.scope.workspaceId,
            input.scope.agentRoleId,
            input.requestId,
            JSON.stringify(input),
            JSON.stringify(receipt),
          );
        return receipt;
      })
      .immediate();
  }
  activeGraphRoots(): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT r.root_task_id FROM orchestration_graph_runs r
      WHERE r.status='running' OR EXISTS(SELECT 1 FROM orchestration_graph_nodes n WHERE n.run_id=r.id AND n.status NOT IN ('completed','failed','cancelled'))`)
        .all() as { root_task_id: string }[]
    ).map((row) => row.root_task_id);
  }
  private closeGraphAdmission(receipt: BotWorkControlReceipt, now: number): void {
    const ids = JSON.stringify(receipt.tasks.map((item) => item.taskId));
    this.db
      .prepare(`UPDATE orchestration_graph_runs SET status=CASE WHEN status='running' THEN 'cancelled' ELSE status END,
      completed_at=COALESCE(completed_at,?),updated_at=?,metadata=json_set(COALESCE(metadata,'{}'),'$.botWorkControl',json(?))
      WHERE workspace_id=? AND root_task_id IN (SELECT value FROM json_each(?))`)
      .run(
        now,
        now,
        JSON.stringify({ scope: receipt.scope, requestId: receipt.requestId }),
        receipt.scope.workspaceId,
        ids,
      );
    this.db
      .prepare(`UPDATE orchestration_graph_nodes SET status='cancelled',completed_at=COALESCE(completed_at,?),updated_at=?,summary='Cancelled before dispatch'
      WHERE status IN ('pending','ready') AND task_id IS NULL AND remote_task_id IS NULL
      AND run_id IN (SELECT id FROM orchestration_graph_runs WHERE workspace_id=? AND root_task_id IN (SELECT value FROM json_each(?)))`)
      .run(now, now, receipt.scope.workspaceId, ids);
  }
  syncGraphs(raw: unknown, locallyStoppedTaskIds: string[], fence?: SchedulerFence): void {
    this.db
      .transaction(() => {
        if (fence) assertSchedulerFence(this.db, fence);
        const receipt = this.readPersisted(raw);
        if (!receipt) throw new Error("Control receipt not found");
        const ids = receipt.tasks
          .filter((item) => locallyStoppedTaskIds.includes(item.taskId))
          .map((item) => item.taskId);
        const versions = JSON.stringify(
          receipt.tasks.map((item) => ({ id: item.taskId, version: item.stopVersion })),
        );
        this.db
          .prepare(`UPDATE orchestration_graph_nodes SET status=(SELECT status FROM tasks WHERE id=orchestration_graph_nodes.task_id),
        completed_at=COALESCE(completed_at,?),updated_at=?,error=NULL,summary='Local work cleanup confirmed'
        WHERE status NOT IN ('completed','failed','cancelled') AND task_id IN (SELECT value FROM json_each(?))
          AND task_id IN (SELECT t.id FROM tasks t JOIN bot_task_stop_intents i ON i.task_id=t.id
            JOIN json_each(?) selected ON json_extract(selected.value,'$.id')=t.id
            WHERE t.workspace_id=? AND t.status IN ('completed','failed','cancelled') AND i.active=1 AND i.version=json_extract(selected.value,'$.version'))
          AND run_id IN (SELECT id FROM orchestration_graph_runs WHERE workspace_id=? AND root_task_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)))`)
          .run(
            Date.now(),
            Date.now(),
            JSON.stringify(ids),
            versions,
            receipt.scope.workspaceId,
            receipt.scope.workspaceId,
            versions,
          );
      })
      .immediate();
  }
  assertTarget(raw: unknown, taskId: string, fence?: SchedulerFence): void {
    if (fence) assertSchedulerFence(this.db, fence);
    const receipt = this.readPersisted(raw);
    if (!receipt || !receipt.tasks.some((item) => item.taskId === taskId))
      throw new Error("Task is outside this control receipt");
    const item = receipt.tasks.find((item) => item.taskId === taskId)!;
    const intent = this.db
      .prepare("SELECT version,active FROM bot_task_stop_intents WHERE task_id=?")
      .get(taskId) as { version: number; active: number } | undefined;
    if (!intent || intent.active !== 1 || intent.version !== item.stopVersion)
      throw new Error("Task stop version changed");
    const task = this.db.prepare("SELECT workspace_id FROM tasks WHERE id=?").get(taskId) as
      | { workspace_id: string }
      | undefined;
    if (!task || task.workspace_id !== receipt.scope.workspaceId)
      throw new Error("Task control workspace changed");
  }
  record(
    raw: unknown,
    taskId: string,
    status: "stopped" | "failed",
    error: string | null,
    now: number,
    fence?: SchedulerFence,
  ): BotWorkControlReceipt {
    return this.db
      .transaction(() => {
        if (fence) assertSchedulerFence(this.db, fence);
        const receipt = this.readPersisted(raw);
        if (!receipt) throw new Error("Control receipt not found");
        const item = receipt.tasks.find((item) => item.taskId === taskId);
        if (!item) throw new Error("Task is outside this control receipt");
        item.status = status;
        if (error) item.error = error.slice(0, 500);
        else delete item.error;
        receipt.stillActiveTaskIds = receipt.tasks
          .filter((item) => item.status === "requested" || item.status === "failed")
          .map((item) => item.taskId);
        receipt.updatedAt = now;
        receipt.status = receipt.tasks.some((item) => item.status === "requested")
          ? "pending"
          : "settled";
        this.db
          .prepare(
            "UPDATE bot_work_control_receipts SET receipt_json=? WHERE workspace_id=? AND agent_role_id=? AND request_id=?",
          )
          .run(
            JSON.stringify(receipt),
            receipt.scope.workspaceId,
            receipt.scope.agentRoleId,
            receipt.requestId,
          );
        return receipt;
      })
      .immediate();
  }
}
/** Durable revocation applies to all tasks, including legacy bot work. */
export function assertTaskNotStopped(db: Database.Database, taskId: string): void {
  if (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_task_stop_intents'")
      .get() &&
    db.prepare("SELECT task_id FROM bot_task_stop_intents WHERE task_id=? AND active=1").get(taskId)
  )
    throw new Error("Task has a persisted stop request");
}

/** Missing scope pause table is compatible with legacy database fixtures. */
export function readBotFuturePaused(
  db: Database.Database,
  workspaceId: string,
  agentRoleId: string,
): boolean {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_future_controls'")
      .get()
  )
    return false;
  const row = db
    .prepare("SELECT paused FROM bot_future_controls WHERE workspace_id=? AND agent_role_id=?")
    .get(workspaceId, agentRoleId) as { paused: number } | undefined;
  return row?.paused === 1;
}
export function assertBotFutureAdmission(
  db: Database.Database,
  task: { workspaceId: string; assignedAgentRoleId?: string; parentTaskId?: string },
  graphContinuation = false,
): void {
  if (task.parentTaskId || graphContinuation || !task.assignedAgentRoleId) return;
  if (readBotFuturePaused(db, task.workspaceId, task.assignedAgentRoleId))
    throw new Error("Bot future runs are paused");
}
