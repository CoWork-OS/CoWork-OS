import type Database from "better-sqlite3";

// oxlint-disable-next-line typescript/no-explicit-any -- rows are mapped by ManagedSessionService
type Row = any;

/**
 * The managed session service's own SQL (async SQLite migration plan, DB6): workspace
 * memberships, the audit trail and the routine rows it reads for managed agents. As
 * services-domain units these run in the database worker when the domain is routed
 * there. Schema setup stays in `ManagedSessionService.ensureGovernanceSchema` on the host.
 */
export class ManagedStore {
  constructor(private readonly db: Database.Database) {}

  private hasTable(tableName: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .get(tableName),
    );
  }

  /** Give a workspace its first (admin) member if it has none. */
  seedMembership(workspaceId: string, principalId: string, now: number, seedId: string): void {
    const membershipCount = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM agent_workspace_memberships
         WHERE workspace_id = ?`,
      )
      .get(workspaceId) as { count?: number } | undefined;
    if ((membershipCount?.count || 0) > 0) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_workspace_memberships
         (id, workspace_id, principal_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(seedId, workspaceId, principalId, "admin", now, now);
  }

  /**
   * The principal's stored role in a workspace, seeding the workspace's first member
   * first; as a unit the seed and the read share one transaction.
   */
  workspaceRole(
    workspaceId: string,
    principalId: string,
    seedPrincipalId: string,
    now: number,
    seedId: string,
  ): string | undefined {
    this.seedMembership(workspaceId, seedPrincipalId, now, seedId);
    const row = this.db
      .prepare(
        `SELECT role
         FROM agent_workspace_memberships
         WHERE workspace_id = ? AND principal_id = ?`,
      )
      .get(workspaceId, principalId) as { role?: string } | undefined;
    return row?.role;
  }

  listMembershipRows(workspaceId: string | null): Row[] {
    return workspaceId
      ? this.db
          .prepare(
            `SELECT * FROM agent_workspace_memberships
             WHERE workspace_id = ?
             ORDER BY updated_at DESC`,
          )
          .all(workspaceId)
      : this.db
          .prepare(
            `SELECT * FROM agent_workspace_memberships
             ORDER BY updated_at DESC`,
          )
          .all();
  }

  /**
   * Set a principal's role, keeping the membership's id and creation time; as a unit the
   * lookup and the write share one transaction. Returns the membership id.
   */
  upsertMembership(input: {
    workspaceId: string;
    principalId: string;
    role: string;
    now: number;
    newId: string;
  }): string {
    const existing = this.db
      .prepare(
        `SELECT * FROM agent_workspace_memberships
         WHERE workspace_id = ? AND principal_id = ?`,
      )
      .get(input.workspaceId, input.principalId) as Row | undefined;
    const id = existing?.id ? String(existing.id) : input.newId;
    this.db
      .prepare(
        `INSERT INTO agent_workspace_memberships
         (id, workspace_id, principal_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, principal_id) DO UPDATE SET
           role = excluded.role,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.workspaceId,
        input.principalId,
        input.role,
        existing?.created_at ? Number(existing.created_at) : input.now,
        input.now,
      );
    return id;
  }

  listAuditRows(agentId: string, limit: number): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM managed_agent_audit
         WHERE agent_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(agentId, limit);
  }

  insertAudit(entry: {
    id: string;
    agentId: string;
    workspaceId: string;
    actorId: string;
    action: string;
    summary: string;
    metadataJson: string | null;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO managed_agent_audit
         (id, agent_id, workspace_id, actor_id, action, summary, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.agentId,
        entry.workspaceId,
        entry.actorId,
        entry.action,
        entry.summary,
        entry.metadataJson,
        entry.createdAt,
      );
  }

  /** Every routine row; empty when the routines table does not exist yet. */
  listRoutineRows(): Row[] {
    if (!this.hasTable("automation_routines")) return [];
    return this.db
      .prepare(
        `SELECT * FROM automation_routines
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all();
  }

  /** Enable or disable a routine row; as a unit the read and the write share one transaction. */
  setRoutineEnabled(routineId: string, enabled: boolean, now: number): void {
    const row = this.db.prepare("SELECT * FROM automation_routines WHERE id = ?").get(routineId) as
      | Row
      | undefined;
    if (!row) return;
    let definition: Row = null;
    try {
      definition = row.definition_json ? JSON.parse(String(row.definition_json)) : null;
    } catch {
      definition = null;
    }
    if (!definition || typeof definition !== "object") {
      this.db
        .prepare("UPDATE automation_routines SET enabled = ?, updated_at = ? WHERE id = ?")
        .run(enabled ? 1 : 0, now, routineId);
      return;
    }
    const nextDefinition = { ...definition, enabled, updatedAt: now };
    this.db
      .prepare(
        `UPDATE automation_routines
         SET enabled = ?, definition_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, JSON.stringify(nextDefinition), now, routineId);
  }

  /** Routine runs joined with their routine's definition; empty without both tables. */
  routineRunRowsWithDefinition(): Row[] {
    if (!this.hasTable("routine_runs") || !this.hasTable("automation_routines")) return [];
    return this.db
      .prepare(
        `SELECT rr.*, ar.definition_json
         FROM routine_runs rr
         JOIN automation_routines ar ON ar.id = rr.routine_id
         ORDER BY rr.updated_at DESC`,
      )
      .all();
  }
}
