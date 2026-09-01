import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  SessionActionAttribution,
  SessionAuditEntry,
  SessionHumanCapability,
  SessionHumanMember,
  SessionHumanRole,
  SessionInvite,
  SessionInviteAcceptInput,
  SessionInviteAcceptResult,
  SessionInviteCreateInput,
  SessionInviteCreateResult,
  SessionMemberUpdateInput,
  SessionPrincipal,
  SessionShareSnapshot,
} from "../../shared/types";
import { TaskRepository } from "../database/repositories";
import { WorkContextRepository } from "./WorkContextRepository";
import { WorkContextService } from "./WorkContextService";

type Any = any;
type InviteRole = Exclude<SessionHumanRole, "owner">;
type Metadata = Record<string, string | number | boolean | null>;

const DEFAULT_DISPLAY_NAME = "Local operator";
const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_INVITE_TTL_MS = 5 * 60 * 1000;
const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_AUDIT_METADATA_KEYS = 20;

const CAPABILITIES_BY_ROLE: Record<SessionHumanRole, ReadonlySet<SessionHumanCapability>> = {
  owner: new Set(["view", "contribute", "review", "approve", "manage"]),
  contributor: new Set(["view", "contribute", "review", "approve"]),
  reviewer: new Set(["view", "review"]),
  viewer: new Set(["view"]),
};

function normalizeRequired(value: unknown, label: string, maxLength = 200): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  return normalized;
}

function normalizeDisplayName(value: unknown): string {
  const normalized = normalizeRequired(value, "displayName", MAX_DISPLAY_NAME_LENGTH).replace(
    /\s+/g,
    " ",
  );
  return normalized;
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function parseMetadata(value: unknown): Metadata | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Metadata;
  } catch {
    return undefined;
  }
}

function normalizeMetadata(metadata?: Metadata): Metadata | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).slice(0, MAX_AUDIT_METADATA_KEYS);
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key.slice(0, 80),
      typeof value === "string" ? value.slice(0, 500) : value,
    ]),
  );
}

export class SessionMembershipService {
  private readonly contextRepo: WorkContextRepository;
  private readonly taskRepo: TaskRepository;
  private readonly workContextService: WorkContextService;
  private readonly clientPrincipals = new Map<number, string>();

  constructor(private readonly db: Database.Database) {
    this.contextRepo = new WorkContextRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.workContextService = new WorkContextService(db);
  }

  getLocalPrincipal(displayName?: string): SessionPrincipal {
    const row = this.db
      .prepare("SELECT principal_id, display_name FROM session_local_principal WHERE id = 1")
      .get() as { principal_id?: string; display_name?: string } | undefined;
    if (row?.principal_id && row.display_name) {
      return { principalId: row.principal_id, displayName: row.display_name };
    }
    const principal = {
      principalId: `local-${randomUUID()}`,
      displayName: normalizeDisplayName(displayName || DEFAULT_DISPLAY_NAME),
    };
    this.db
      .prepare(
        `INSERT INTO session_local_principal (id, principal_id, display_name, updated_at)
         VALUES (1, ?, ?, ?)`,
      )
      .run(principal.principalId, principal.displayName, Date.now());
    return principal;
  }

  principalForClient(clientId: number): string {
    return this.clientPrincipals.get(clientId) || this.getLocalPrincipal().principalId;
  }

  principalDetailsForClient(clientId: number): SessionPrincipal {
    const principalId = this.principalForClient(clientId);
    const local = this.getLocalPrincipal();
    if (principalId === local.principalId) return local;
    const row = this.db
      .prepare(
        `SELECT principal_id, display_name FROM session_human_members
         WHERE principal_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(principalId) as { principal_id?: string; display_name?: string } | undefined;
    return {
      principalId,
      displayName: row?.display_name || "Session participant",
    };
  }

  registerClientPrincipal(clientId: number, principalId: string): void {
    this.clientPrincipals.set(clientId, normalizeRequired(principalId, "principalId", 160));
  }

  ensureOwner(contextId: string): SessionHumanMember {
    const context = this.requireContext(contextId);
    const existingOwner = this.db
      .prepare(
        `SELECT * FROM session_human_members
         WHERE context_id = ? AND role = 'owner' AND status = 'active'
         ORDER BY joined_at ASC LIMIT 1`,
      )
      .get(context.id) as Any;
    if (existingOwner) return this.mapMember(existingOwner);

    const principal = this.getLocalPrincipal();
    const existingLocal = this.db
      .prepare(
        `SELECT * FROM session_human_members WHERE context_id = ? AND principal_id = ? LIMIT 1`,
      )
      .get(context.id, principal.principalId) as Any;
    if (existingLocal) {
      this.db
        .prepare(
          `UPDATE session_human_members
           SET role = 'owner', status = 'active', revoked_at = NULL,
               updated_at = ?, last_seen_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), Date.now(), existingLocal.id);
      const member = this.requireMember(existingLocal.id);
      this.recordAudit(context.id, member, "owner_created");
      return member;
    }

    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO session_human_members
           (id, context_id, principal_id, display_name, role, status, joined_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?)`,
      )
      .run(id, context.id, principal.principalId, principal.displayName, now, now, now);
    const member = this.requireMember(id);
    this.recordAudit(context.id, member, "owner_created");
    return member;
  }

  getSnapshot(contextId: string, principalId?: string): SessionShareSnapshot {
    const context = this.requireContext(contextId);
    const owner = this.ensureOwner(context.id);
    const actor = this.requireAuthorizedMember(
      context.id,
      principalId || this.getLocalPrincipal().principalId,
      "view",
    );
    const members = (
      this.db
        .prepare(`SELECT * FROM session_human_members WHERE context_id = ? ORDER BY joined_at ASC`)
        .all(context.id) as Any[]
    ).map((row) => this.mapMember(row));
    const invites =
      actor.role === "owner"
        ? (
            this.db
              .prepare(
                `SELECT * FROM session_invites
               WHERE context_id = ? AND revoked_at IS NULL AND used_at IS NULL
               ORDER BY created_at DESC LIMIT 100`,
              )
              .all(context.id) as Any[]
          ).map((row) => this.mapInvite(row))
        : [];
    return { contextId: context.id, members, invites, actor: actor || owner };
  }

  getSnapshotForTask(taskId: string, principalId?: string): SessionShareSnapshot {
    const task = this.taskRepo.findById(normalizeRequired(taskId, "taskId"));
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const context =
      this.contextRepo.findByTaskId(task.id) || this.workContextService.ensureForTask(task);
    return this.getSnapshot(context.id, principalId);
  }

  listAccessibleContexts(
    options: {
      workspaceId?: string;
      includeArchived?: boolean;
      limit?: number;
    } = {},
    principalId?: string,
  ) {
    const actorPrincipalId = principalId || this.getLocalPrincipal().principalId;
    const localPrincipalId = this.getLocalPrincipal().principalId;
    if (actorPrincipalId === localPrincipalId) return this.workContextService.list(options);
    const contexts = this.workContextService.list(options);
    const memberRows = this.db
      .prepare(
        `SELECT DISTINCT context_id FROM session_human_members
         WHERE principal_id = ? AND status = 'active'`,
      )
      .all(actorPrincipalId) as Array<{ context_id?: string }>;
    const accessible = new Set(memberRows.map((row) => String(row.context_id || "")));
    return contexts.filter((context) => accessible.has(context.id));
  }

  createInvite(input: SessionInviteCreateInput, principalId?: string): SessionInviteCreateResult {
    const context = this.requireContext(input.contextId);
    const actor = this.requireAuthorizedMember(
      context.id,
      principalId || this.getLocalPrincipal().principalId,
      "manage",
    );
    const ttl = Math.min(
      MAX_INVITE_TTL_MS,
      Math.max(
        MIN_INVITE_TTL_MS,
        Number.isFinite(input.expiresInMs)
          ? Math.floor(Number(input.expiresInMs))
          : DEFAULT_INVITE_TTL_MS,
      ),
    );
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    const invite: SessionInvite = {
      id: randomUUID(),
      contextId: context.id,
      role: input.role as InviteRole,
      createdBy: actor.principalId,
      createdAt: now,
      expiresAt: now + ttl,
    };
    this.db
      .prepare(
        `INSERT INTO session_invites
           (id, context_id, token_hash, role, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invite.id,
        invite.contextId,
        hashInviteToken(token),
        invite.role,
        invite.createdBy,
        invite.createdAt,
        invite.expiresAt,
      );
    this.recordAudit(context.id, actor, "invite_created", invite.id, { role: invite.role });
    return { invite, token };
  }

  acceptInvite(input: SessionInviteAcceptInput): SessionInviteAcceptResult {
    const token = normalizeRequired(input.token, "token", 200);
    const displayName = normalizeDisplayName(input.displayName);
    const row = this.db
      .prepare("SELECT * FROM session_invites WHERE token_hash = ? LIMIT 1")
      .get(hashInviteToken(token)) as Any;
    if (!row) throw new Error("Invite token is invalid.");
    if (row.used_at) throw new Error("Invite token has already been used.");
    if (row.revoked_at) throw new Error("Invite token has been revoked.");
    if (Number(row.expires_at) <= Date.now()) throw new Error("Invite token has expired.");

    const principal: SessionPrincipal = {
      principalId: input.principalId
        ? normalizeRequired(input.principalId, "principalId", 160)
        : `guest-${randomUUID()}`,
      displayName,
    };
    const now = Date.now();
    const memberId = randomUUID();
    const transaction = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT id, status FROM session_human_members
           WHERE context_id = ? AND principal_id = ? LIMIT 1`,
        )
        .get(row.context_id, principal.principalId) as { id?: string; status?: string } | undefined;
      if (existing?.status === "active") throw new Error("Principal is already a session member.");
      if (existing?.id) {
        this.db
          .prepare(
            `UPDATE session_human_members
             SET display_name = ?, role = ?, status = 'active', updated_at = ?,
                 joined_at = ?, revoked_at = NULL, last_seen_at = ?
             WHERE id = ?`,
          )
          .run(displayName, row.role, now, now, now, existing.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO session_human_members
               (id, context_id, principal_id, display_name, role, status, joined_at, updated_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(
            memberId,
            row.context_id,
            principal.principalId,
            displayName,
            row.role,
            now,
            now,
            now,
          );
      }
      this.db.prepare("UPDATE session_invites SET used_at = ? WHERE id = ?").run(now, row.id);
    });
    transaction();
    const member = this.requireMemberByPrincipal(row.context_id, principal.principalId);
    this.recordAudit(row.context_id, member, "member_joined", member.id, { role: member.role });
    return { member, principal };
  }

  updateMember(input: SessionMemberUpdateInput, principalId?: string): SessionHumanMember {
    const context = this.requireContext(input.contextId);
    const actor = this.requireAuthorizedMember(
      context.id,
      principalId || this.getLocalPrincipal().principalId,
      "manage",
    );
    const member = this.requireMember(normalizeRequired(input.memberId, "memberId"));
    if (member.contextId !== context.id) throw new Error("Member does not belong to this session.");
    if (member.id === actor.id && input.revoke === true) {
      throw new Error("The active owner cannot revoke their own session access.");
    }
    const nextRole = input.role || member.role;
    if (nextRole === "owner" && member.role !== "owner") {
      throw new Error("Owner transfer is not supported in local invites.");
    }
    if (member.role === "owner" && nextRole !== "owner") {
      const ownerCount = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM session_human_members
           WHERE context_id = ? AND role = 'owner' AND status = 'active'`,
        )
        .get(context.id) as { count?: number };
      if (Number(ownerCount?.count || 0) <= 1)
        throw new Error("A session must retain an active owner.");
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE session_human_members
         SET role = ?, status = ?, updated_at = ?, revoked_at = ?
         WHERE id = ?`,
      )
      .run(
        nextRole,
        input.revoke === true ? "revoked" : "active",
        now,
        input.revoke === true ? now : null,
        member.id,
      );
    const updated = this.requireMember(member.id);
    this.recordAudit(
      context.id,
      actor,
      input.revoke === true ? "member_revoked" : "member_updated",
      updated.id,
      { role: updated.role, status: updated.status },
    );
    return updated;
  }

  touchPresence(contextId: string, principalId?: string): SessionHumanMember {
    const actor = this.requireAuthorizedMember(
      contextId,
      principalId || this.getLocalPrincipal().principalId,
      "view",
    );
    const now = Date.now();
    this.db
      .prepare("UPDATE session_human_members SET last_seen_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, actor.id);
    return this.requireMember(actor.id);
  }

  listAudit(contextId: string, principalId?: string, limit = 100): SessionAuditEntry[] {
    const context = this.requireContext(contextId);
    this.requireAuthorizedMember(
      context.id,
      principalId || this.getLocalPrincipal().principalId,
      "view",
    );
    const safeLimit = Math.min(200, Math.max(1, Math.floor(Number(limit) || 100)));
    return (
      this.db
        .prepare(
          `SELECT * FROM session_audit WHERE context_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        )
        .all(context.id, safeLimit) as Any[]
    ).map((row) => this.mapAudit(row));
  }

  authorizeContextAction(
    contextId: string,
    capability: SessionHumanCapability,
    principalId?: string,
  ): SessionActionAttribution {
    const context = this.requireContext(contextId);
    this.ensureOwner(context.id);
    const member = this.requireAuthorizedMember(
      context.id,
      principalId || this.getLocalPrincipal().principalId,
      capability,
    );
    return { principalId: member.principalId, role: member.role };
  }

  authorizeTaskAction(
    taskId: string,
    capability: SessionHumanCapability,
    principalId?: string,
  ): { contextId: string; actor: SessionActionAttribution } {
    const task = this.taskRepo.findById(normalizeRequired(taskId, "taskId"));
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const context =
      this.contextRepo.findByTaskId(task.id) || this.workContextService.ensureForTask(task);
    this.ensureOwner(context.id);
    const member = this.requireAuthorizedMember(
      context.id,
      principalId || this.getLocalPrincipal().principalId,
      capability,
    );
    return { contextId: context.id, actor: { principalId: member.principalId, role: member.role } };
  }

  recordTaskAction(
    taskId: string,
    capability: SessionHumanCapability,
    action: string,
    targetId?: string,
    metadata?: Metadata,
    principalId?: string,
  ): SessionActionAttribution {
    const authorized = this.authorizeTaskAction(taskId, capability, principalId);
    const member = this.requireMemberByPrincipal(
      authorized.contextId,
      authorized.actor.principalId,
    );
    this.recordAudit(authorized.contextId, member, action, targetId, metadata);
    this.touchPresence(authorized.contextId, authorized.actor.principalId);
    return authorized.actor;
  }

  private requireContext(contextId: string) {
    const id = normalizeRequired(contextId, "contextId");
    const context = this.contextRepo.findById(id);
    if (!context) throw new Error(`WorkContext not found: ${id}`);
    return context;
  }

  private requireAuthorizedMember(
    contextId: string,
    principalId: string,
    capability: SessionHumanCapability,
  ): SessionHumanMember {
    const member = this.requireMemberByPrincipal(contextId, principalId);
    if (!CAPABILITIES_BY_ROLE[member.role].has(capability)) {
      throw new Error(`Session role '${member.role}' cannot ${capability} this session.`);
    }
    return member;
  }

  private requireMemberByPrincipal(contextId: string, principalId: string): SessionHumanMember {
    const row = this.db
      .prepare(
        `SELECT * FROM session_human_members
         WHERE context_id = ? AND principal_id = ? LIMIT 1`,
      )
      .get(contextId, normalizeRequired(principalId, "principalId", 160)) as Any;
    if (!row) throw new Error("Principal is not a member of this session.");
    if (row.status !== "active") throw new Error("Session membership has been revoked.");
    return this.mapMember(row);
  }

  private requireMember(id: string): SessionHumanMember {
    const row = this.db.prepare("SELECT * FROM session_human_members WHERE id = ?").get(id) as Any;
    if (!row) throw new Error(`Session member not found: ${id}`);
    return this.mapMember(row);
  }

  private recordAudit(
    contextId: string,
    member: SessionHumanMember,
    action: string,
    targetId?: string,
    metadata?: Metadata,
  ): void {
    const normalized = normalizeMetadata(metadata);
    this.db
      .prepare(
        `INSERT INTO session_audit
           (id, context_id, member_id, principal_id, action, target_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        contextId,
        member.id,
        member.principalId,
        action.slice(0, 120),
        targetId || null,
        normalized ? JSON.stringify(normalized) : null,
        Date.now(),
      );
  }

  private mapMember(row: Any): SessionHumanMember {
    return {
      id: String(row.id),
      contextId: String(row.context_id),
      principalId: String(row.principal_id),
      displayName: String(row.display_name),
      role: String(row.role) as SessionHumanRole,
      status: String(row.status) as SessionHumanMember["status"],
      joinedAt: Number(row.joined_at),
      updatedAt: Number(row.updated_at),
      lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : undefined,
      revokedAt: row.revoked_at ? Number(row.revoked_at) : undefined,
    };
  }

  private mapInvite(row: Any): SessionInvite {
    return {
      id: String(row.id),
      contextId: String(row.context_id),
      role: String(row.role) as InviteRole,
      createdBy: String(row.created_by),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at ? Number(row.used_at) : undefined,
      revokedAt: row.revoked_at ? Number(row.revoked_at) : undefined,
    };
  }

  private mapAudit(row: Any): SessionAuditEntry {
    return {
      id: String(row.id),
      contextId: String(row.context_id),
      memberId: row.member_id ? String(row.member_id) : undefined,
      principalId: String(row.principal_id),
      action: String(row.action),
      targetId: row.target_id ? String(row.target_id) : undefined,
      metadata: parseMetadata(row.metadata_json),
      createdAt: Number(row.created_at),
    };
  }
}
