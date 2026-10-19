import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  MissionControlEvidenceSource,
  MissionControlItem,
  MissionControlItemEvidence,
  MissionControlListRequest,
} from "../../shared/types";

type Any = any; // oxlint-disable-line typescript-eslint/no-explicit-any

export interface UpsertMissionControlItemInput {
  fingerprint: string;
  category: MissionControlItem["category"];
  severity: MissionControlItem["severity"];
  title: string;
  summary: string;
  decision?: string;
  nextStep?: string;
  agentRoleId?: string;
  agentName?: string;
  workspaceId?: string;
  workspaceName?: string;
  companyId?: string;
  companyName?: string;
  taskId?: string;
  issueId?: string;
  runId?: string;
  timestamp: number;
}

export interface ReplaceMissionControlEvidenceInput {
  sourceType: MissionControlEvidenceSource;
  sourceId?: string;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
  timestamp: number;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeScopeId(value?: string | null): string | undefined {
  return value && value !== "__all__" ? value : undefined;
}

export class MissionControlRepository {
  constructor(private readonly db: Database.Database) {}

  upsertItem(input: UpsertMissionControlItemInput): MissionControlItem {
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT id FROM mission_control_items WHERE fingerprint = ?")
      .get(input.fingerprint) as { id: string } | undefined;
    const id = existing?.id || randomUUID();

    this.db
      .prepare(
        `INSERT INTO mission_control_items (
          id, fingerprint, category, severity, title, summary, decision, next_step,
          agent_role_id, agent_name, workspace_id, workspace_name, company_id, company_name,
          task_id, issue_id, run_id, timestamp, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
          category = excluded.category,
          severity = excluded.severity,
          title = excluded.title,
          summary = excluded.summary,
          decision = excluded.decision,
          next_step = excluded.next_step,
          agent_role_id = excluded.agent_role_id,
          agent_name = excluded.agent_name,
          workspace_id = excluded.workspace_id,
          workspace_name = excluded.workspace_name,
          company_id = excluded.company_id,
          company_name = excluded.company_name,
          task_id = excluded.task_id,
          issue_id = excluded.issue_id,
          run_id = excluded.run_id,
          timestamp = excluded.timestamp,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.fingerprint,
        input.category,
        input.severity,
        input.title,
        input.summary,
        input.decision || null,
        input.nextStep || null,
        input.agentRoleId || null,
        input.agentName || null,
        normalizeScopeId(input.workspaceId) || null,
        input.workspaceName || null,
        normalizeScopeId(input.companyId) || null,
        input.companyName || null,
        input.taskId || null,
        input.issueId || null,
        input.runId || null,
        input.timestamp,
        now,
      );

    return this.getItemByFingerprint(input.fingerprint)!;
  }

  replaceEvidence(itemId: string, evidence: ReplaceMissionControlEvidenceInput[]): void {
    const remove = this.db.prepare("DELETE FROM mission_control_item_evidence WHERE item_id = ?");
    const insert = this.db.prepare(
      `INSERT INTO mission_control_item_evidence (
        id, item_id, source_type, source_id, title, summary, payload_json, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const transaction = this.db.transaction(() => {
      remove.run(itemId);
      for (const entry of evidence) {
        insert.run(
          randomUUID(),
          itemId,
          entry.sourceType,
          entry.sourceId || null,
          entry.title,
          entry.summary || null,
          entry.payload ? JSON.stringify(entry.payload) : null,
          entry.timestamp,
        );
      }
    });
    transaction();
  }

  listItems(request: MissionControlListRequest = {}): MissionControlItem[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const workspaceId = normalizeScopeId(request.workspaceId);
    const companyId = normalizeScopeId(request.companyId);
    const agentRoleId = normalizeScopeId(request.agentRoleId);

    if (workspaceId) {
      conditions.push("i.workspace_id = ?");
      params.push(workspaceId);
    }
    if (companyId) {
      conditions.push("i.company_id = ?");
      params.push(companyId);
    }
    if (agentRoleId) {
      conditions.push("i.agent_role_id = ?");
      params.push(agentRoleId);
    }
    if (request.categories?.length) {
      conditions.push(`i.category IN (${request.categories.map(() => "?").join(", ")})`);
      params.push(...request.categories);
    }
    if (request.severities?.length) {
      conditions.push(`i.severity IN (${request.severities.map(() => "?").join(", ")})`);
      params.push(...request.severities);
    }

    const limit = Math.max(1, Math.min(request.limit || 80, 200));
    const rows = this.db
      .prepare(
        `SELECT i.*, COUNT(e.id) AS evidence_count
         FROM mission_control_items i
         LEFT JOIN mission_control_item_evidence e ON e.item_id = i.id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         GROUP BY i.id
         ORDER BY i.timestamp DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Any[];
    return rows.map((row) => this.mapItem(row));
  }

  listEvidence(itemId: string): MissionControlItemEvidence[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mission_control_item_evidence
         WHERE item_id = ?
         ORDER BY timestamp DESC`,
      )
      .all(itemId) as Any[];
    return rows.map((row) => this.mapEvidence(row));
  }

  deleteTaskItemsNotIn(args: {
    taskIds: string[];
    workspaceId?: string;
    companyId?: string;
  }): void {
    const conditions = ["fingerprint LIKE 'task:%'"];
    const params: unknown[] = [];
    const workspaceId = normalizeScopeId(args.workspaceId);
    const companyId = normalizeScopeId(args.companyId);

    if (workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (companyId) {
      conditions.push("company_id = ?");
      params.push(companyId);
    }
    if (args.taskIds.length > 0) {
      conditions.push(`task_id NOT IN (${args.taskIds.map(() => "?").join(", ")})`);
      params.push(...args.taskIds);
    }

    const rows = this.db
      .prepare(`SELECT id FROM mission_control_items WHERE ${conditions.join(" AND ")}`)
      .all(...params) as Array<{ id: string }>;
    if (rows.length === 0) return;

    const deleteEvidence = this.db.prepare(
      "DELETE FROM mission_control_item_evidence WHERE item_id = ?",
    );
    const deleteItem = this.db.prepare("DELETE FROM mission_control_items WHERE id = ?");
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        deleteEvidence.run(row.id);
        deleteItem.run(row.id);
      }
    });
    transaction();
  }

  /** Remove items whose fingerprint starts with `prefix` and is not in `keep`. */
  deleteItemsByPrefixNotIn(prefix: string, keep: string[], workspaceId?: string): void {
    const conditions = ["fingerprint LIKE ? ESCAPE '\\'"];
    const params: unknown[] = [`${prefix.replace(/[\\%_]/g, "\\$&")}%`];
    const scope = normalizeScopeId(workspaceId);
    if (scope) {
      conditions.push("workspace_id = ?");
      params.push(scope);
    }
    if (keep.length > 0) {
      conditions.push(`fingerprint NOT IN (${keep.map(() => "?").join(", ")})`);
      params.push(...keep);
    }
    const rows = this.db
      .prepare(`SELECT id FROM mission_control_items WHERE ${conditions.join(" AND ")}`)
      .all(...params) as Array<{ id: string }>;
    if (rows.length === 0) return;
    const deleteEvidence = this.db.prepare(
      "DELETE FROM mission_control_item_evidence WHERE item_id = ?",
    );
    const deleteItem = this.db.prepare("DELETE FROM mission_control_items WHERE id = ?");
    this.db.transaction(() => {
      for (const row of rows) {
        deleteEvidence.run(row.id);
        deleteItem.run(row.id);
      }
    })();
  }

  private getItemByFingerprint(fingerprint: string): MissionControlItem | undefined {
    const row = this.db
      .prepare(
        `SELECT i.*, COUNT(e.id) AS evidence_count
         FROM mission_control_items i
         LEFT JOIN mission_control_item_evidence e ON e.item_id = i.id
         WHERE i.fingerprint = ?
         GROUP BY i.id`,
      )
      .get(fingerprint) as Any;
    return row ? this.mapItem(row) : undefined;
  }

  private mapItem(row: Any): MissionControlItem {
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      category: row.category,
      severity: row.severity,
      title: row.title,
      summary: row.summary,
      decision: row.decision || undefined,
      nextStep: row.next_step || undefined,
      agentRoleId: row.agent_role_id || undefined,
      agentName: row.agent_name || undefined,
      workspaceId: row.workspace_id || undefined,
      workspaceName: row.workspace_name || undefined,
      companyId: row.company_id || undefined,
      companyName: row.company_name || undefined,
      taskId: row.task_id || undefined,
      issueId: row.issue_id || undefined,
      runId: row.run_id || undefined,
      timestamp: Number(row.timestamp),
      updatedAt: Number(row.updated_at),
      evidenceCount: Number(row.evidence_count || 0),
    };
  }

  private mapEvidence(row: Any): MissionControlItemEvidence {
    return {
      id: row.id,
      itemId: row.item_id,
      sourceType: row.source_type,
      sourceId: row.source_id || undefined,
      title: row.title,
      summary: row.summary || undefined,
      payload: parseJson<Record<string, unknown> | undefined>(row.payload_json, undefined),
      timestamp: Number(row.timestamp),
    };
  }
}
