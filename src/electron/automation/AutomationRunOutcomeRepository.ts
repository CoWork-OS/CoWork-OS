import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AutomationRunOutcome,
  AutomationRunOutcomeListRequest,
  AutomationRunOutcomeSummary,
  CreateAutomationRunOutcomeInput,
} from "../../shared/types";

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class AutomationRunOutcomeRepository {
  constructor(private readonly db: Database.Database) {
    this.ensureSchema();
  }

  create(input: CreateAutomationRunOutcomeInput): AutomationRunOutcome {
    const outcome: AutomationRunOutcome = {
      id: input.id || randomUUID(),
      source: input.source,
      sourceRunId: input.sourceRunId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      agentRoleId: input.agentRoleId,
      title: input.title,
      summary: input.summary,
      usefulness: input.usefulness,
      trigger: input.trigger,
      metrics: input.metrics,
      evidenceRefs: input.evidenceRefs,
      nextAction: input.nextAction,
      notificationRecommended: input.notificationRecommended,
      notificationReason: input.notificationReason,
      notificationDeliveredAt: input.notificationDeliveredAt,
      createdAt: input.createdAt || Date.now(),
    };

    this.db
      .prepare(
        `
          INSERT INTO automation_run_outcomes (
            id, source, source_run_id, task_id, workspace_id, company_id, agent_role_id,
            title, summary, usefulness, trigger, notification_recommended, notification_reason,
            notification_delivered_at, next_action, metrics_json, evidence_refs_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        outcome.id,
        outcome.source,
        outcome.sourceRunId || null,
        outcome.taskId || null,
        outcome.workspaceId || null,
        outcome.companyId || null,
        outcome.agentRoleId || null,
        outcome.title,
        outcome.summary,
        outcome.usefulness,
        outcome.trigger,
        outcome.notificationRecommended ? 1 : 0,
        outcome.notificationReason || null,
        outcome.notificationDeliveredAt || null,
        outcome.nextAction || null,
        outcome.metrics ? JSON.stringify(outcome.metrics) : null,
        outcome.evidenceRefs ? JSON.stringify(outcome.evidenceRefs) : null,
        outcome.createdAt,
      );
    return outcome;
  }

  list(request: AutomationRunOutcomeListRequest = {}): AutomationRunOutcome[] {
    const clauses = ["1 = 1"];
    const args: unknown[] = [];
    if (request.source) {
      clauses.push("source = ?");
      args.push(request.source);
    }
    if (request.usefulness) {
      clauses.push("usefulness = ?");
      args.push(request.usefulness);
    }
    if (request.workspaceId) {
      clauses.push("workspace_id = ?");
      args.push(request.workspaceId);
    }
    if (request.companyId) {
      clauses.push("company_id = ?");
      args.push(request.companyId);
    }
    const limit = Math.min(Math.max(request.limit || 50, 1), 500);
    const offset = Math.max(request.offset || 0, 0);
    args.push(limit, offset);
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM automation_run_outcomes
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...args) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  summarize(
    input: { from?: number; to?: number; companyId?: string; workspaceId?: string } = {},
  ): AutomationRunOutcomeSummary {
    const clauses = ["1 = 1"];
    const args: unknown[] = [];
    if (typeof input.from === "number") {
      clauses.push("created_at >= ?");
      args.push(input.from);
    }
    if (typeof input.to === "number") {
      clauses.push("created_at <= ?");
      args.push(input.to);
    }
    if (input.companyId) {
      clauses.push("company_id = ?");
      args.push(input.companyId);
    }
    if (input.workspaceId) {
      clauses.push("workspace_id = ?");
      args.push(input.workspaceId);
    }
    const rows = this.db
      .prepare(
        `
          SELECT usefulness, COUNT(*) AS count
          FROM automation_run_outcomes
          WHERE ${clauses.join(" AND ")}
          GROUP BY usefulness
        `,
      )
      .all(...args) as Array<{ usefulness: string; count: number }>;
    const summary: AutomationRunOutcomeSummary = {
      total: 0,
      actionable: 0,
      informational: 0,
      lowValue: 0,
      failed: 0,
    };
    for (const row of rows) {
      summary.total += row.count;
      if (row.usefulness === "actionable") summary.actionable = row.count;
      if (row.usefulness === "informational") summary.informational = row.count;
      if (row.usefulness === "low_value") summary.lowValue = row.count;
      if (row.usefulness === "failed") summary.failed = row.count;
    }
    return summary;
  }

  markNotificationDelivered(id: string, timestamp = Date.now()): void {
    this.db
      .prepare("UPDATE automation_run_outcomes SET notification_delivered_at = ? WHERE id = ?")
      .run(timestamp, id);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_run_outcomes (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_run_id TEXT,
        task_id TEXT,
        workspace_id TEXT,
        company_id TEXT,
        agent_role_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        usefulness TEXT NOT NULL,
        trigger TEXT NOT NULL,
        notification_recommended INTEGER NOT NULL DEFAULT 0,
        notification_reason TEXT,
        notification_delivered_at INTEGER,
        next_action TEXT,
        metrics_json TEXT,
        evidence_refs_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_outcomes_created
        ON automation_run_outcomes(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_automation_outcomes_company
        ON automation_run_outcomes(company_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_automation_outcomes_workspace
        ON automation_run_outcomes(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_automation_outcomes_usefulness
        ON automation_run_outcomes(usefulness, created_at DESC);
    `);
  }

  private mapRow(row: Record<string, unknown>): AutomationRunOutcome {
    return {
      id: String(row.id),
      source: row.source as AutomationRunOutcome["source"],
      sourceRunId: typeof row.source_run_id === "string" ? row.source_run_id : undefined,
      taskId: typeof row.task_id === "string" ? row.task_id : undefined,
      workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : undefined,
      companyId: typeof row.company_id === "string" ? row.company_id : undefined,
      agentRoleId: typeof row.agent_role_id === "string" ? row.agent_role_id : undefined,
      title: String(row.title),
      summary: String(row.summary),
      usefulness: row.usefulness as AutomationRunOutcome["usefulness"],
      trigger: row.trigger as AutomationRunOutcome["trigger"],
      metrics: parseJson(row.metrics_json, undefined),
      evidenceRefs: parseJson(row.evidence_refs_json, undefined),
      nextAction: typeof row.next_action === "string" ? row.next_action : undefined,
      notificationRecommended: row.notification_recommended === 1,
      notificationReason:
        typeof row.notification_reason === "string" ? row.notification_reason : undefined,
      notificationDeliveredAt:
        typeof row.notification_delivered_at === "number"
          ? row.notification_delivered_at
          : undefined,
      createdAt: Number(row.created_at),
    };
  }
}
