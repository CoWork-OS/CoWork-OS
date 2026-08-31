import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  SupervisorExchange,
  SupervisorExchangeListQuery,
  SupervisorExchangeMessage,
  SupervisorExchangeStatus,
  SupervisorProtocolIntent,
  SupervisorActorKind,
  SupervisorEvidenceRef,
} from "../../shared/types";

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type CreateSupervisorExchangeRequest = Omit<
  SupervisorExchange,
  "id" | "createdAt" | "updatedAt" | "turnCount" | "status"
> & {
  status?: SupervisorExchangeStatus;
  turnCount?: number;
};

type AddSupervisorExchangeMessageRequest = Omit<SupervisorExchangeMessage, "id" | "createdAt">;

export class SupervisorExchangeRepository {
  constructor(private db: Database.Database) {}

  create(request: CreateSupervisorExchangeRequest): SupervisorExchange {
    const now = Date.now();
    const exchange: SupervisorExchange = {
      id: uuidv4(),
      workspaceId: request.workspaceId,
      coordinationChannelId: request.coordinationChannelId,
      sourceChannelId: request.sourceChannelId,
      sourceMessageId: request.sourceMessageId,
      sourcePeerUserId: request.sourcePeerUserId,
      workerAgentRoleId: request.workerAgentRoleId,
      supervisorAgentRoleId: request.supervisorAgentRoleId,
      linkedTaskId: request.linkedTaskId,
      escalationTarget: request.escalationTarget,
      status: request.status || "open",
      lastIntent: request.lastIntent,
      turnCount: request.turnCount ?? 0,
      terminalReason: request.terminalReason,
      evidenceRefs: request.evidenceRefs,
      humanResolution: request.humanResolution,
      createdAt: now,
      updatedAt: now,
      closedAt: request.closedAt,
    };

    this.db
      .prepare(`
        INSERT INTO supervisor_exchanges (
          id, workspace_id, coordination_channel_id, source_channel_id, source_message_id,
          source_peer_user_id, worker_agent_role_id, supervisor_agent_role_id, linked_task_id,
          escalation_target, status, last_intent, turn_count, terminal_reason,
          evidence_refs_json, human_resolution, created_at, updated_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        exchange.id,
        exchange.workspaceId,
        exchange.coordinationChannelId,
        exchange.sourceChannelId || null,
        exchange.sourceMessageId || null,
        exchange.sourcePeerUserId || null,
        exchange.workerAgentRoleId || null,
        exchange.supervisorAgentRoleId || null,
        exchange.linkedTaskId || null,
        exchange.escalationTarget || null,
        exchange.status,
        exchange.lastIntent || null,
        exchange.turnCount,
        exchange.terminalReason || null,
        exchange.evidenceRefs ? JSON.stringify(exchange.evidenceRefs) : null,
        exchange.humanResolution || null,
        exchange.createdAt,
        exchange.updatedAt,
        exchange.closedAt || null,
      );

    return exchange;
  }

  update(id: string, updates: Partial<SupervisorExchange>): SupervisorExchange | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: unknown[] = [];

    const push = (field: string, value: unknown) => {
      fields.push(`${field} = ?`);
      values.push(value);
    };

    if (updates.coordinationChannelId !== undefined) {
      push("coordination_channel_id", updates.coordinationChannelId);
    }
    if (updates.sourceChannelId !== undefined)
      push("source_channel_id", updates.sourceChannelId || null);
    if (updates.sourceMessageId !== undefined)
      push("source_message_id", updates.sourceMessageId || null);
    if (updates.sourcePeerUserId !== undefined)
      push("source_peer_user_id", updates.sourcePeerUserId || null);
    if (updates.workerAgentRoleId !== undefined)
      push("worker_agent_role_id", updates.workerAgentRoleId || null);
    if (updates.supervisorAgentRoleId !== undefined)
      push("supervisor_agent_role_id", updates.supervisorAgentRoleId || null);
    if (updates.linkedTaskId !== undefined) push("linked_task_id", updates.linkedTaskId || null);
    if (updates.escalationTarget !== undefined)
      push("escalation_target", updates.escalationTarget || null);
    if (updates.status !== undefined) push("status", updates.status);
    if (updates.lastIntent !== undefined) push("last_intent", updates.lastIntent || null);
    if (updates.turnCount !== undefined) push("turn_count", updates.turnCount);
    if (updates.terminalReason !== undefined)
      push("terminal_reason", updates.terminalReason || null);
    if (updates.evidenceRefs !== undefined) {
      push(
        "evidence_refs_json",
        updates.evidenceRefs ? JSON.stringify(updates.evidenceRefs) : null,
      );
    }
    if (updates.humanResolution !== undefined)
      push("human_resolution", updates.humanResolution || null);
    if (updates.closedAt !== undefined) push("closed_at", updates.closedAt || null);

    if (fields.length === 0) return existing;

    push("updated_at", Date.now());
    values.push(id);
    this.db
      .prepare(`UPDATE supervisor_exchanges SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findById(id);
  }

  findById(id: string): SupervisorExchange | undefined {
    const row = this.db.prepare("SELECT * FROM supervisor_exchanges WHERE id = ?").get(id) as Any;
    return row ? this.mapExchange(row) : undefined;
  }

  findBySourceMessageId(sourceMessageId: string): SupervisorExchange | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM supervisor_exchanges WHERE source_message_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sourceMessageId) as Any;
    return row ? this.mapExchange(row) : undefined;
  }

  findByDiscordMessageId(discordMessageId: string): SupervisorExchange | undefined {
    const row = this.db
      .prepare(`
        SELECT e.*
        FROM supervisor_exchanges e
        INNER JOIN supervisor_exchange_messages m ON m.exchange_id = e.id
        WHERE m.discord_message_id = ?
        LIMIT 1
      `)
      .get(discordMessageId) as Any;
    return row ? this.mapExchange(row) : undefined;
  }

  list(query: SupervisorExchangeListQuery): SupervisorExchange[] {
    const conditions = ["workspace_id = ?"];
    const params: unknown[] = [query.workspaceId];

    if (query.status) {
      if (Array.isArray(query.status)) {
        conditions.push(`status IN (${query.status.map(() => "?").join(", ")})`);
        params.push(...query.status);
      } else {
        conditions.push("status = ?");
        params.push(query.status);
      }
    }

    let sql = `SELECT * FROM supervisor_exchanges WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC`;
    if (query.limit) sql += ` LIMIT ${query.limit}`;
    const rows = this.db.prepare(sql).all(...params) as Any[];
    return rows.map((row) => this.mapExchange(row));
  }

  addMessage(request: AddSupervisorExchangeMessageRequest): SupervisorExchangeMessage | null {
    const existing = this.findMessageByDiscordMessageId(request.discordMessageId);
    if (existing) return null;

    const message: SupervisorExchangeMessage = {
      id: uuidv4(),
      exchangeId: request.exchangeId,
      discordMessageId: request.discordMessageId,
      channelId: request.channelId,
      authorUserId: request.authorUserId,
      actorKind: request.actorKind,
      intent: request.intent,
      rawContent: request.rawContent,
      createdAt: Date.now(),
    };

    this.db
      .prepare(`
        INSERT INTO supervisor_exchange_messages (
          id, exchange_id, discord_message_id, channel_id, author_user_id,
          actor_kind, intent, raw_content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.exchangeId,
        message.discordMessageId,
        message.channelId,
        message.authorUserId || null,
        message.actorKind,
        message.intent,
        message.rawContent,
        message.createdAt,
      );

    return message;
  }

  listMessages(exchangeId: string): SupervisorExchangeMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM supervisor_exchange_messages WHERE exchange_id = ? ORDER BY created_at ASC",
      )
      .all(exchangeId) as Any[];
    return rows.map((row) => this.mapMessage(row));
  }

  findMessageByDiscordMessageId(discordMessageId: string): SupervisorExchangeMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM supervisor_exchange_messages WHERE discord_message_id = ?")
      .get(discordMessageId) as Any;
    return row ? this.mapMessage(row) : undefined;
  }

  private mapExchange(row: Any): SupervisorExchange {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      coordinationChannelId: row.coordination_channel_id,
      sourceChannelId: row.source_channel_id || undefined,
      sourceMessageId: row.source_message_id || undefined,
      sourcePeerUserId: row.source_peer_user_id || undefined,
      workerAgentRoleId: row.worker_agent_role_id || undefined,
      supervisorAgentRoleId: row.supervisor_agent_role_id || undefined,
      linkedTaskId: row.linked_task_id || undefined,
      escalationTarget: row.escalation_target || undefined,
      status: row.status as SupervisorExchangeStatus,
      lastIntent: row.last_intent as SupervisorProtocolIntent | undefined,
      turnCount: Number(row.turn_count || 0),
      terminalReason: row.terminal_reason || undefined,
      evidenceRefs: safeJsonParse<SupervisorEvidenceRef[] | undefined>(
        row.evidence_refs_json,
        undefined,
      ),
      humanResolution: row.human_resolution || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at || undefined,
    };
  }

  private mapMessage(row: Any): SupervisorExchangeMessage {
    return {
      id: row.id,
      exchangeId: row.exchange_id,
      discordMessageId: row.discord_message_id,
      channelId: row.channel_id,
      authorUserId: row.author_user_id || undefined,
      actorKind: row.actor_kind as SupervisorActorKind,
      intent: row.intent as SupervisorProtocolIntent,
      rawContent: row.raw_content,
      createdAt: row.created_at,
    };
  }
}
