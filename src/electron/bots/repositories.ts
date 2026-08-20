import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type { BotEnvelope, BotRuntimeBinding } from "../../shared/types";

type Row = Record<string, unknown>;

const MAX_MESSAGE_BODY_BYTES = 256 * 1024;
const MAX_MESSAGE_JSON_BYTES = 1024 * 1024;
const MAX_MESSAGE_ARTIFACTS = 100;
const MAX_IDENTIFIER_LENGTH = 512;
const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CLAIM_LEASE_MS = 60_000;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertBoundedIdentifier(label: string, value?: string): void {
  if (value && value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_IDENTIFIER_LENGTH} characters`);
  }
}

function assertEnvelopeBounds(input: {
  fromAgentId: string;
  toAgentId: string;
  body: string;
  data?: unknown;
  artifactRefs?: string[];
  conversationId?: string;
  correlationId?: string;
  replyTo?: string;
  idempotencyKey?: string;
}): void {
  assertBoundedIdentifier("fromAgentId", input.fromAgentId);
  assertBoundedIdentifier("toAgentId", input.toAgentId);
  if (!input.fromAgentId.trim() || !input.toAgentId.trim()) {
    throw new Error("Bot message sender and recipient are required");
  }
  assertBoundedIdentifier("conversationId", input.conversationId);
  assertBoundedIdentifier("correlationId", input.correlationId);
  assertBoundedIdentifier("replyTo", input.replyTo);
  assertBoundedIdentifier("idempotencyKey", input.idempotencyKey);
  if (byteLength(input.body) > MAX_MESSAGE_BODY_BYTES) {
    throw new Error("Bot message body exceeds the 256 KiB limit");
  }
  if ((input.artifactRefs?.length || 0) > MAX_MESSAGE_ARTIFACTS) {
    throw new Error(`Bot message has more than ${MAX_MESSAGE_ARTIFACTS} artifact references`);
  }
  for (const artifactRef of input.artifactRefs || []) {
    assertBoundedIdentifier("artifactRef", artifactRef);
  }
  const dataJson = input.data === undefined ? "" : JSON.stringify(input.data);
  if (byteLength(dataJson) > MAX_MESSAGE_JSON_BYTES) {
    throw new Error("Bot message JSON data exceeds the 1 MiB limit");
  }
}

function boundedLimit(value: number | undefined, fallback: number, maximum = 1000): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("limit must be a finite number");
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class BotRuntimeBindingRepository {
  constructor(private readonly db: Database.Database) {}

  ensure(agentId: string, defaults: Partial<BotRuntimeBinding> = {}): BotRuntimeBinding {
    const existing = this.findByAgentId(agentId);
    if (existing) return existing;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO managed_agent_runtime_bindings (
          agent_id, agent_role_id, default_environment_id, canonical_session_id,
          runtime_kind, device_id, browser_profile_id, memory_scope_id, avatar_json,
          pinned, sidebar_group, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO NOTHING`,
      )
      .run(
        agentId,
        defaults.agentRoleId || null,
        defaults.defaultEnvironmentId || null,
        defaults.canonicalSessionId || null,
        defaults.runtimeKind || "local",
        defaults.deviceId || null,
        defaults.browserProfileId || null,
        defaults.memoryScopeId || null,
        defaults.avatar ? JSON.stringify(defaults.avatar) : null,
        defaults.pinned ? 1 : 0,
        defaults.sidebarGroup || null,
        defaults.sortOrder || 0,
        now,
        now,
      );
    return this.findByAgentId(agentId)!;
  }

  update(
    agentId: string,
    updates: Partial<
      Pick<
        BotRuntimeBinding,
        | "agentRoleId"
        | "defaultEnvironmentId"
        | "canonicalSessionId"
        | "runtimeKind"
        | "deviceId"
        | "browserProfileId"
        | "memoryScopeId"
        | "avatar"
        | "pinned"
        | "sidebarGroup"
        | "sortOrder"
      >
    >,
  ): BotRuntimeBinding {
    this.ensure(agentId);
    const columns: Record<string, string> = {
      agentRoleId: "agent_role_id",
      defaultEnvironmentId: "default_environment_id",
      canonicalSessionId: "canonical_session_id",
      runtimeKind: "runtime_kind",
      deviceId: "device_id",
      browserProfileId: "browser_profile_id",
      memoryScopeId: "memory_scope_id",
      avatar: "avatar_json",
      pinned: "pinned",
      sidebarGroup: "sidebar_group",
      sortOrder: "sort_order",
    };
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      fields.push(`${column} = ?`);
      if (key === "avatar") values.push(value ? JSON.stringify(value) : null);
      else if (key === "pinned") values.push(value ? 1 : 0);
      else values.push(value ?? null);
    }
    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(Date.now(), agentId);
      this.db
        .prepare(
          `UPDATE managed_agent_runtime_bindings SET ${fields.join(", ")} WHERE agent_id = ?`,
        )
        .run(...values);
    }
    return this.findByAgentId(agentId)!;
  }

  findByAgentId(agentId: string): BotRuntimeBinding | undefined {
    const row = this.db
      .prepare("SELECT * FROM managed_agent_runtime_bindings WHERE agent_id = ?")
      .get(agentId) as Row | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  list(): BotRuntimeBinding[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM managed_agent_runtime_bindings ORDER BY pinned DESC, sort_order ASC, updated_at DESC",
        )
        .all() as Row[]
    ).map((row) => this.mapRow(row));
  }

  private mapRow(row: Row): BotRuntimeBinding {
    return {
      agentId: String(row.agent_id || ""),
      agentRoleId: row.agent_role_id ? String(row.agent_role_id) : undefined,
      defaultEnvironmentId: row.default_environment_id
        ? String(row.default_environment_id)
        : undefined,
      canonicalSessionId: row.canonical_session_id ? String(row.canonical_session_id) : undefined,
      runtimeKind: String(row.runtime_kind || "local") as BotRuntimeBinding["runtimeKind"],
      deviceId: row.device_id ? String(row.device_id) : undefined,
      browserProfileId: row.browser_profile_id ? String(row.browser_profile_id) : undefined,
      memoryScopeId: row.memory_scope_id ? String(row.memory_scope_id) : undefined,
      avatar: parseJson(row.avatar_json, undefined),
      pinned: Boolean(row.pinned),
      sidebarGroup: row.sidebar_group ? String(row.sidebar_group) : undefined,
      sortOrder: Number(row.sort_order || 0),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }
}

export class BotMessageRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    input: Omit<BotEnvelope, "id" | "status" | "attempts" | "createdAt" | "updatedAt"> & {
      id?: string;
      status?: BotEnvelope["status"];
      attempts?: number;
    },
  ): BotEnvelope {
    assertEnvelopeBounds(input);
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(
        input.fromAgentId,
        input.toAgentId,
        input.idempotencyKey,
      );
      if (existing) return existing;
    }
    const now = Date.now();
    const envelope: BotEnvelope = {
      ...input,
      id: input.id || randomUUID(),
      status: input.status || "queued",
      attempts: input.attempts || 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO bot_messages (
          id, from_agent_id, to_agent_id, kind, content_type, body, data_json,
          artifact_refs_json, conversation_id, correlation_id, reply_to, source_protocol,
          source_task_id, status, attempts, max_attempts, idempotency_key, created_at,
          updated_at, claimed_at, completed_at, expires_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.id,
          envelope.fromAgentId,
          envelope.toAgentId,
          envelope.kind,
          envelope.contentType,
          envelope.body,
          envelope.data === undefined ? null : JSON.stringify(envelope.data),
          envelope.artifactRefs ? JSON.stringify(envelope.artifactRefs) : null,
          envelope.conversationId || null,
          envelope.correlationId || null,
          envelope.replyTo || null,
          envelope.sourceProtocol || "cowork",
          envelope.sourceTaskId || null,
          envelope.status,
          envelope.attempts,
          envelope.maxAttempts,
          envelope.idempotencyKey || null,
          envelope.createdAt,
          envelope.updatedAt,
          envelope.claimedAt || null,
          envelope.completedAt || null,
          envelope.expiresAt || null,
          envelope.lastError || null,
        );
    } catch (error) {
      if (input.idempotencyKey) {
        const existing = this.findByIdempotencyKey(
          input.fromAgentId,
          input.toAgentId,
          input.idempotencyKey,
        );
        if (existing) return existing;
      }
      throw error;
    }
    return envelope;
  }

  claim(id: string): BotEnvelope | undefined {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE bot_messages
         SET status = 'claimed', attempts = attempts + 1, claimed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued' AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(now, now, id, now);
    return result.changes > 0 ? this.findById(id) : undefined;
  }

  recoverStaleClaims(now = Date.now(), leaseMs = DEFAULT_CLAIM_LEASE_MS): number {
    const staleBefore = now - Math.max(5_000, leaseMs);
    return this.db
      .prepare(
        `UPDATE bot_messages
         SET status = 'queued', claimed_at = NULL, updated_at = ?,
             last_error = COALESCE(last_error, 'Recovered after an interrupted delivery')
         WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
      )
      .run(now, staleBefore).changes;
  }

  listQueuedForDelivery(limit = 100, retryBefore = Date.now()): BotEnvelope[] {
    this.expireDue();
    return (
      this.db
        .prepare(
          `SELECT * FROM bot_messages
           WHERE status = 'queued' AND updated_at <= ?
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(retryBefore, boundedLimit(limit, 100)) as Row[]
    ).map((row) => this.mapRow(row));
  }

  capQueuedInbox(
    toAgentId: string,
    maximum: number,
    sourceProtocol?: BotEnvelope["sourceProtocol"],
  ): number {
    const boundedMaximum = Math.max(1, Math.min(100_000, Math.floor(maximum)));
    const now = Date.now();
    const sourceClause = sourceProtocol ? "AND source_protocol = ?" : "";
    const values: unknown[] = sourceProtocol
      ? [now, now, toAgentId, sourceProtocol, boundedMaximum]
      : [now, now, toAgentId, boundedMaximum];
    return this.db
      .prepare(
        `UPDATE bot_messages
         SET status = 'dead_letter', completed_at = ?, updated_at = ?,
             last_error = 'Inbox capacity exceeded'
         WHERE id IN (
           SELECT id FROM bot_messages
           WHERE to_agent_id = ? AND status = 'queued' ${sourceClause}
           ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(...values).changes;
  }

  complete(id: string): BotEnvelope | undefined {
    return this.setTerminal(id, "completed");
  }

  fail(id: string, error: string): BotEnvelope | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const terminal = existing.attempts >= existing.maxAttempts;
    const status: BotEnvelope["status"] = terminal ? "dead_letter" : "queued";
    this.db
      .prepare(
        "UPDATE bot_messages SET status = ?, last_error = ?, claimed_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(status, error.slice(0, 2000), Date.now(), id);
    return this.findById(id);
  }

  expireDue(now = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE bot_messages SET status = 'expired', completed_at = ?, updated_at = ?
         WHERE status IN ('queued', 'claimed') AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(now, now, now).changes;
  }

  pruneTerminal(now = Date.now(), retentionMs = DEFAULT_TERMINAL_RETENTION_MS): number {
    const cutoff = now - Math.max(24 * 60 * 60 * 1000, retentionMs);
    return this.db
      .prepare(
        `DELETE FROM bot_messages
         WHERE status IN ('completed', 'dead_letter', 'expired', 'failed')
           AND COALESCE(completed_at, updated_at) < ?`,
      )
      .run(cutoff).changes;
  }

  findById(id: string): BotEnvelope | undefined {
    const row = this.db.prepare("SELECT * FROM bot_messages WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  findByIdempotencyKey(
    fromAgentId: string,
    toAgentId: string,
    idempotencyKey: string,
  ): BotEnvelope | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM bot_messages WHERE from_agent_id = ? AND to_agent_id = ? AND idempotency_key = ?",
      )
      .get(fromAgentId, toAgentId, idempotencyKey) as Row | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  list(params: {
    toAgentId?: string;
    fromAgentId?: string;
    conversationId?: string;
    status?: BotEnvelope["status"];
    sourceProtocol?: BotEnvelope["sourceProtocol"];
    order?: "asc" | "desc";
    limit?: number;
  }): BotEnvelope[] {
    this.expireDue();
    const where: string[] = [];
    const values: unknown[] = [];
    if (params.toAgentId) {
      where.push("to_agent_id = ?");
      values.push(params.toAgentId);
    }
    if (params.fromAgentId) {
      where.push("from_agent_id = ?");
      values.push(params.fromAgentId);
    }
    if (params.conversationId) {
      where.push("conversation_id = ?");
      values.push(params.conversationId);
    }
    if (params.status) {
      where.push("status = ?");
      values.push(params.status);
    }
    if (params.sourceProtocol) {
      where.push("source_protocol = ?");
      values.push(params.sourceProtocol);
    }
    values.push(boundedLimit(params.limit, 200));
    const rows = this.db
      .prepare(
        `SELECT * FROM bot_messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at ${params.order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(...values) as Row[];
    return rows.map((row) => this.mapRow(row));
  }

  countForRecipient(toAgentId: string, status?: BotEnvelope["status"]): number {
    this.expireDue();
    const row = status
      ? (this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM bot_messages WHERE to_agent_id = ? AND status = ?",
          )
          .get(toAgentId, status) as Row)
      : (this.db
          .prepare("SELECT COUNT(*) AS count FROM bot_messages WHERE to_agent_id = ?")
          .get(toAgentId) as Row);
    return Number(row.count || 0);
  }

  private setTerminal(id: string, status: "completed" | "expired"): BotEnvelope | undefined {
    const now = Date.now();
    this.db
      .prepare("UPDATE bot_messages SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?")
      .run(status, now, now, id);
    return this.findById(id);
  }

  private mapRow(row: Row): BotEnvelope {
    return {
      id: String(row.id || ""),
      fromAgentId: String(row.from_agent_id || ""),
      toAgentId: String(row.to_agent_id || ""),
      kind: String(row.kind || "request") as BotEnvelope["kind"],
      contentType: String(row.content_type || "text/plain") as BotEnvelope["contentType"],
      body: String(row.body || ""),
      data: parseJson(row.data_json, undefined),
      artifactRefs: parseJson(row.artifact_refs_json, undefined),
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
      correlationId: row.correlation_id ? String(row.correlation_id) : undefined,
      replyTo: row.reply_to ? String(row.reply_to) : undefined,
      sourceProtocol: row.source_protocol
        ? (String(row.source_protocol) as BotEnvelope["sourceProtocol"])
        : undefined,
      sourceTaskId: row.source_task_id ? String(row.source_task_id) : undefined,
      status: String(row.status || "queued") as BotEnvelope["status"],
      attempts: Number(row.attempts || 0),
      maxAttempts: Number(row.max_attempts || 3),
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      claimedAt: row.claimed_at ? Number(row.claimed_at) : undefined,
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
      expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
    };
  }
}
