import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  AgentSecurityDiagnostic,
  AgentSecurityEnforcement,
  AgentSecurityFinding,
  AgentSecurityFindingQuery,
  AgentSecurityFindingStatus,
} from "../../../shared/agent-security";

const MAX_QUERY_LIMIT = 500;

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export class AgentSecurityRepository {
  constructor(private readonly db: Database.Database) {}

  upsertFinding(finding: AgentSecurityFinding): void {
    this.db
      .prepare(
        `
          INSERT INTO agent_security_findings (
            finding_id, schema_version, task_id, session_id, source_agent, source_type,
            rule_id, rule_version, severity, title, status, detected_at, observed_at,
            project_path_hash, record_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(finding_id) DO UPDATE SET
            task_id = COALESCE(excluded.task_id, agent_security_findings.task_id),
            status = agent_security_findings.status,
            record_json = excluded.record_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        finding.findingId,
        finding.schemaVersion,
        finding.taskId ?? null,
        finding.sessionId ?? null,
        finding.sourceAgent,
        finding.sourceType,
        finding.ruleId,
        finding.ruleVersion,
        finding.severity,
        finding.title,
        finding.status,
        finding.detectedAt,
        finding.observedAt ?? null,
        finding.projectPathHash ?? null,
        JSON.stringify(finding.record),
        finding.createdAt,
        finding.updatedAt,
      );
  }

  listFindings(query: AgentSecurityFindingQuery = {}): AgentSecurityFinding[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.taskId) {
      clauses.push("task_id = ?");
      params.push(query.taskId);
    }
    if (query.severity) {
      clauses.push("severity = ?");
      params.push(query.severity);
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(query.limit ?? 100)));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    params.push(limit, offset);
    const rows = this.db
      .prepare(
        `
          SELECT * FROM agent_security_findings
          ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
          ORDER BY detected_at DESC, finding_id DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapFinding(row));
  }

  getFinding(findingId: string): AgentSecurityFinding | null {
    const row = this.db
      .prepare("SELECT * FROM agent_security_findings WHERE finding_id = ?")
      .get(findingId) as Record<string, unknown> | undefined;
    return row ? this.mapFinding(row) : null;
  }

  updateFindingStatus(
    findingId: string,
    status: AgentSecurityFindingStatus,
  ): AgentSecurityFinding | null {
    this.db
      .prepare("UPDATE agent_security_findings SET status = ?, updated_at = ? WHERE finding_id = ?")
      .run(status, Date.now(), findingId);
    return this.getFinding(findingId);
  }

  upsertDecision(decision: AgentSecurityEnforcement): void {
    this.db
      .prepare(
        `
          INSERT INTO agent_security_decisions (
            decision_id, schema_version, task_id, session_id, tool_call_id, decision,
            mode, reason, source_agent, finding_ids_json, rule_ids_json, host_outcome,
            record_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(decision_id) DO UPDATE SET
            task_id = COALESCE(excluded.task_id, agent_security_decisions.task_id),
            host_outcome = COALESCE(excluded.host_outcome, agent_security_decisions.host_outcome),
            record_json = excluded.record_json
        `,
      )
      .run(
        decision.decisionId,
        decision.schemaVersion,
        decision.taskId ?? null,
        decision.sessionId ?? null,
        decision.toolCallId ?? null,
        decision.decision,
        decision.mode,
        decision.reason,
        decision.sourceAgent,
        JSON.stringify(decision.findingIds),
        JSON.stringify(decision.ruleIds),
        decision.hostOutcome ?? null,
        JSON.stringify(decision.record),
        decision.createdAt,
      );
  }

  listDecisions(taskId?: string, limit = 100): AgentSecurityEnforcement[] {
    const boundedLimit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(limit)));
    const rows = taskId
      ? (this.db
          .prepare(
            "SELECT * FROM agent_security_decisions WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(taskId, boundedLimit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare("SELECT * FROM agent_security_decisions ORDER BY created_at DESC LIMIT ?")
          .all(boundedLimit) as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      decisionId: String(row.decision_id),
      schemaVersion: String(row.schema_version),
      taskId: typeof row.task_id === "string" ? row.task_id : undefined,
      sessionId: typeof row.session_id === "string" ? row.session_id : undefined,
      toolCallId: typeof row.tool_call_id === "string" ? row.tool_call_id : undefined,
      decision: row.decision === "deny" ? "deny" : "no_override",
      mode: row.mode === "enforce" ? "enforce" : "monitor",
      reason: String(row.reason),
      sourceAgent: String(row.source_agent),
      findingIds: parseStringArray(String(row.finding_ids_json)),
      ruleIds: parseStringArray(String(row.rule_ids_json)),
      hostOutcome:
        row.host_outcome === "blocked" ||
        row.host_outcome === "executed" ||
        row.host_outcome === "failed" ||
        row.host_outcome === "unknown"
          ? row.host_outcome
          : undefined,
      record: parseJsonObject(String(row.record_json)),
      createdAt: Number(row.created_at),
    }));
  }

  updateDecisionHostOutcome(
    decisionId: string,
    hostOutcome: NonNullable<AgentSecurityEnforcement["hostOutcome"]>,
  ): void {
    this.db
      .prepare("UPDATE agent_security_decisions SET host_outcome = ? WHERE decision_id = ?")
      .run(hostOutcome, decisionId);
  }

  addDiagnostic(input: Omit<AgentSecurityDiagnostic, "id" | "createdAt">): AgentSecurityDiagnostic {
    const diagnostic: AgentSecurityDiagnostic = {
      ...input,
      id: uuidv4(),
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `
          INSERT INTO agent_security_diagnostics (id, task_id, level, code, message, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        diagnostic.id,
        diagnostic.taskId ?? null,
        diagnostic.level,
        diagnostic.code,
        diagnostic.message,
        diagnostic.createdAt,
      );
    return diagnostic;
  }

  listDiagnostics(limit = 100): AgentSecurityDiagnostic[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_security_diagnostics ORDER BY created_at DESC LIMIT ?")
      .all(Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(limit)))) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row.id),
      taskId: typeof row.task_id === "string" ? row.task_id : undefined,
      level: row.level === "error" ? "error" : row.level === "warn" ? "warn" : "info",
      code: String(row.code),
      message: String(row.message),
      createdAt: Number(row.created_at),
    }));
  }

  upsertInventory(agent: {
    agentId: string;
    present: boolean;
    wired: boolean;
    liveMode?: string;
    details: Record<string, unknown>;
    checkedAt: number;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO agent_security_inventory (
            agent_id, present, wired, live_mode, details_json, checked_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET
            present = excluded.present,
            wired = excluded.wired,
            live_mode = excluded.live_mode,
            details_json = excluded.details_json,
            checked_at = excluded.checked_at
        `,
      )
      .run(
        agent.agentId,
        agent.present ? 1 : 0,
        agent.wired ? 1 : 0,
        agent.liveMode ?? null,
        JSON.stringify(agent.details),
        agent.checkedAt,
      );
  }

  listInventory(): Array<{
    agentId: string;
    present: boolean;
    wired: boolean;
    liveMode?: string;
    details: Record<string, unknown>;
    checkedAt: number;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM agent_security_inventory ORDER BY agent_id ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      agentId: String(row.agent_id),
      present: Number(row.present) === 1,
      wired: Number(row.wired) === 1,
      liveMode: typeof row.live_mode === "string" ? row.live_mode : undefined,
      details: parseJsonObject(String(row.details_json)),
      checkedAt: Number(row.checked_at),
    }));
  }

  prune(retentionDays: number): {
    findings: number;
    decisions: number;
    diagnostics: number;
  } {
    const cutoffMs = Date.now() - Math.max(1, retentionDays) * 86_400_000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const findings = this.db
      .prepare("DELETE FROM agent_security_findings WHERE detected_at < ? AND status != 'open'")
      .run(cutoffIso).changes;
    const decisions = this.db
      .prepare("DELETE FROM agent_security_decisions WHERE created_at < ?")
      .run(cutoffMs).changes;
    const diagnostics = this.db
      .prepare("DELETE FROM agent_security_diagnostics WHERE created_at < ?")
      .run(cutoffMs).changes;
    return { findings, decisions, diagnostics };
  }

  listOpenFindingTaskIds(): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT task_id FROM agent_security_findings WHERE status = 'open' AND task_id IS NOT NULL",
      )
      .all() as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  private mapFinding(row: Record<string, unknown>): AgentSecurityFinding {
    return {
      findingId: String(row.finding_id),
      schemaVersion: String(row.schema_version),
      taskId: typeof row.task_id === "string" ? row.task_id : undefined,
      sessionId: typeof row.session_id === "string" ? row.session_id : undefined,
      sourceAgent: String(row.source_agent),
      sourceType: String(row.source_type),
      ruleId: String(row.rule_id),
      ruleVersion: String(row.rule_version),
      severity:
        row.severity === "critical" ||
        row.severity === "high" ||
        row.severity === "medium" ||
        row.severity === "low"
          ? row.severity
          : "info",
      title: String(row.title),
      status:
        row.status === "acknowledged" ||
        row.status === "resolved" ||
        row.status === "false_positive"
          ? row.status
          : "open",
      detectedAt: String(row.detected_at),
      observedAt: typeof row.observed_at === "string" ? row.observed_at : undefined,
      projectPathHash:
        typeof row.project_path_hash === "string" ? row.project_path_hash : undefined,
      record: parseJsonObject(String(row.record_json)),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
