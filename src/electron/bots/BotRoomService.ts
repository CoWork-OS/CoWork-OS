import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type {
  BotRoom,
  BotRoomExecutionMode,
  BotRoomMember,
  BotRoomMessage,
} from "../../shared/types";

type Row = Record<string, unknown>;
const MAX_ROOM_BODY_BYTES = 256 * 1024;
const MAX_ROOM_NAME_LENGTH = 160;
const MAX_ROOM_HISTORY = 10_000;
const ROOM_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Durable room state and bounded-run primitives. Execution is deliberately
 * separate: BotCoordinatorService delivers each selected member turn.
 */
export class BotRoomService {
  constructor(
    private readonly db: Database.Database,
    private readonly agentExists: (agentId: string) => boolean = () => true,
  ) {}

  create(input: {
    name: string;
    ownerAgentId?: string;
    memberAgentIds: string[];
    executionMode?: BotRoomExecutionMode;
    maxRounds?: number;
    maxMessages?: number;
  }): BotRoom {
    const name = input.name.trim();
    if (!name) throw new Error("Bot room name is required");
    if (name.length > MAX_ROOM_NAME_LENGTH) {
      throw new Error(`Bot room name exceeds ${MAX_ROOM_NAME_LENGTH} characters`);
    }
    const members = Array.from(new Set(input.memberAgentIds.filter(Boolean)));
    if (members.length < 2) throw new Error("A bot room requires at least two members");
    if (members.length > 50) throw new Error("A bot room supports at most 50 members");
    const missing = members.filter((agentId) => !this.agentExists(agentId));
    if (missing.length) throw new Error(`Bot room members not found: ${missing.join(", ")}`);
    if (input.ownerAgentId && !members.includes(input.ownerAgentId)) {
      throw new Error("Bot room owner must be one of its members");
    }
    if (
      input.executionMode &&
      !(["sequential", "parallel", "leader"] as const).includes(input.executionMode)
    ) {
      throw new Error(`Unsupported bot room execution mode: ${input.executionMode}`);
    }
    for (const [label, value] of [
      ["maxRounds", input.maxRounds],
      ["maxMessages", input.maxMessages],
    ] as const) {
      if (value !== undefined && !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number`);
      }
    }
    const now = Date.now();
    const room: BotRoom = {
      id: randomUUID(),
      name,
      ownerAgentId: input.ownerAgentId,
      executionMode: input.executionMode || "sequential",
      maxRounds: Math.max(1, Math.min(10, Math.floor(input.maxRounds || 3))),
      maxMessages: Math.max(2, Math.min(100, Math.floor(input.maxMessages || 10))),
      epoch: 0,
      currentRound: 0,
      createdAt: now,
      updatedAt: now,
    };
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO bot_rooms (
            id, name, owner_agent_id, execution_mode, max_rounds, max_messages,
            epoch, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          room.id,
          room.name,
          room.ownerAgentId || null,
          room.executionMode,
          room.maxRounds,
          room.maxMessages,
          room.epoch,
          now,
          now,
        );
      const statement = this.db.prepare(
        `INSERT INTO bot_room_members (
          room_id, agent_id, source, last_seen_seq, status, joined_at, updated_at
        ) VALUES (?, ?, 'local', 0, 'active', ?, ?)`,
      );
      for (const agentId of members) statement.run(room.id, agentId, now, now);
    });
    insert();
    return room;
  }

  get(roomId: string): BotRoom | undefined {
    const row = this.db.prepare("SELECT * FROM bot_rooms WHERE id = ?").get(roomId) as
      | Row
      | undefined;
    return row ? this.mapRoom(row) : undefined;
  }

  list(): BotRoom[] {
    return (this.db.prepare("SELECT * FROM bot_rooms ORDER BY updated_at DESC").all() as Row[]).map(
      (row) => this.mapRoom(row),
    );
  }

  listMembers(roomId: string): BotRoomMember[] {
    return (
      this.db
        .prepare("SELECT * FROM bot_room_members WHERE room_id = ? ORDER BY joined_at ASC")
        .all(roomId) as Row[]
    ).map((row) => ({
      roomId: String(row.room_id),
      agentId: String(row.agent_id),
      source: String(row.source || "local") as BotRoomMember["source"],
      memberSessionId: row.member_session_id ? String(row.member_session_id) : undefined,
      lastSeenSeq: Number(row.last_seen_seq || 0),
      status: String(row.status || "active") as BotRoomMember["status"],
      joinedAt: Number(row.joined_at || 0),
      updatedAt: Number(row.updated_at || 0),
    }));
  }

  setMemberSession(roomId: string, agentId: string, sessionId: string): void {
    const result = this.db
      .prepare(
        `UPDATE bot_room_members SET member_session_id = ?, updated_at = ?
         WHERE room_id = ? AND agent_id = ? AND status = 'active'`,
      )
      .run(sessionId, Date.now(), roomId, agentId);
    if (result.changes === 0) throw new Error(`Active bot room member not found: ${agentId}`);
  }

  countRunMessages(roomId: string, runId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM bot_room_messages WHERE room_id = ? AND run_id = ?")
      .get(roomId, runId) as Row;
    return Number(row.count || 0);
  }

  appendUserMessage(roomId: string, body: string): BotRoomMessage {
    const room = this.requireRoom(roomId);
    const text = body.trim();
    if (!text) throw new Error("Bot room message body is required");
    this.assertBodySize(text);
    const epoch = room.epoch + 1;
    const now = Date.now();
    const append = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE bot_rooms SET epoch = ?, current_round = 0, active_run_id = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(epoch, now, roomId);
      return this.insertMessage({ roomId, epoch, round: 0, body: text, status: "delivered" });
    });
    const message = append();
    this.pruneHistory(roomId);
    return message;
  }

  startRun(roomId: string, leaseOwner: string, leaseMs = 60_000): { runId: string; epoch: number } {
    const room = this.requireRoom(roomId);
    const now = Date.now();
    const runId = randomUUID();
    const result = this.db
      .prepare(
        `UPDATE bot_rooms SET active_run_id = ?, current_round = 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(runId, leaseOwner, now + Math.max(5_000, leaseMs), now, roomId, now);
    if (result.changes === 0) throw new Error("Bot room is already being coordinated");
    return { runId, epoch: room.epoch };
  }

  advanceRound(roomId: string, runId: string): number | undefined {
    const room = this.requireRoom(roomId);
    if (room.activeRunId !== runId) return undefined;
    if (room.currentRound >= room.maxRounds) return undefined;
    const nextRound = room.currentRound + 1;
    const result = this.db
      .prepare(
        `UPDATE bot_rooms SET current_round = ?, updated_at = ?
         WHERE id = ? AND active_run_id = ? AND current_round = ?`,
      )
      .run(nextRound, Date.now(), roomId, runId, room.currentRound);
    return result.changes > 0 ? nextRound : undefined;
  }

  appendBotMessage(input: {
    roomId: string;
    runId: string;
    epoch: number;
    round?: number;
    fromAgentId: string;
    body: string;
    replyTo?: string;
    late?: boolean;
    failed?: boolean;
  }): BotRoomMessage {
    const room = this.requireRoom(input.roomId);
    this.assertBodySize(input.body);
    const round = input.round || room.currentRound;
    if (input.epoch !== room.epoch) {
      const insertLate = this.db.transaction(() =>
        this.insertMessage({
          ...input,
          round,
          status: "late",
          body: input.body.trim() || "(pass)",
        }),
      );
      const late = insertLate();
      this.pruneHistory(input.roomId);
      return late;
    }
    if (room.activeRunId !== input.runId) throw new Error("Bot room run is no longer active");
    if (round !== room.currentRound || round < 1 || round > room.maxRounds) {
      throw new Error(`Bot room round is not active: ${round}`);
    }
    const append = this.db.transaction(() => {
      const runCount = this.db
        .prepare("SELECT COUNT(*) AS count FROM bot_room_messages WHERE room_id = ? AND run_id = ?")
        .get(input.roomId, input.runId) as Row;
      if (Number(runCount.count || 0) >= room.maxMessages) {
        throw new Error(`Bot room message limit reached (${room.maxMessages})`);
      }
      const body = input.body.trim() || "(pass)";
      return this.insertMessage({
        ...input,
        round,
        body,
        status: input.failed
          ? "failed"
          : input.late
            ? "late"
            : body.toLowerCase() === "(pass)"
              ? "pass"
              : "delivered",
      });
    });
    const message = append();
    this.pruneHistory(input.roomId);
    return message;
  }

  markSeen(roomId: string, agentId: string, seq: number): void {
    this.db
      .prepare(
        `UPDATE bot_room_members SET last_seen_seq = MAX(last_seen_seq, ?), updated_at = ?
         WHERE room_id = ? AND agent_id = ?`,
      )
      .run(Math.max(0, Math.floor(seq)), Date.now(), roomId, agentId);
  }

  listMessages(roomId: string, afterSeq = 0, limit = 1_000): BotRoomMessage[] {
    if (!Number.isFinite(afterSeq) || !Number.isFinite(limit)) {
      throw new Error("Room message cursor and limit must be finite numbers");
    }
    const cursor = Math.max(0, Math.floor(afterSeq));
    const boundedLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const rows = cursor
      ? (this.db
          .prepare(
            `SELECT * FROM bot_room_messages
             WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
          )
          .all(roomId, cursor, boundedLimit) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM (
               SELECT * FROM bot_room_messages
               WHERE room_id = ? ORDER BY seq DESC LIMIT ?
             ) ORDER BY seq ASC`,
          )
          .all(roomId, boundedLimit) as Row[]);
    return rows.map((row) => this.mapMessage(row));
  }

  finishRun(roomId: string, runId: string): void {
    this.db
      .prepare(
        `UPDATE bot_rooms SET active_run_id = NULL, lease_owner = NULL,
         lease_expires_at = NULL, current_round = 0, updated_at = ?
         WHERE id = ? AND active_run_id = ?`,
      )
      .run(Date.now(), roomId, runId);
  }

  private insertMessage(input: {
    roomId: string;
    epoch: number;
    round: number;
    body: string;
    status: BotRoomMessage["status"];
    runId?: string;
    fromAgentId?: string;
    replyTo?: string;
  }): BotRoomMessage {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM bot_room_messages WHERE room_id = ?")
      .get(input.roomId) as Row;
    const message: BotRoomMessage = {
      id: randomUUID(),
      roomId: input.roomId,
      runId: input.runId,
      epoch: input.epoch,
      round: input.round,
      seq: Number(seqRow.seq || 1),
      fromAgentId: input.fromAgentId,
      body: input.body,
      status: input.status,
      replyTo: input.replyTo,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO bot_room_messages (
          id, room_id, run_id, epoch, round, seq, from_agent_id, body, status, reply_to, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.roomId,
        message.runId || null,
        message.epoch,
        message.round,
        message.seq,
        message.fromAgentId || null,
        message.body,
        message.status,
        message.replyTo || null,
        message.createdAt,
      );
    return message;
  }

  private requireRoom(roomId: string): BotRoom {
    const room = this.get(roomId);
    if (!room) throw new Error(`Bot room not found: ${roomId}`);
    return room;
  }

  private assertBodySize(body: string): void {
    if (Buffer.byteLength(body, "utf8") > MAX_ROOM_BODY_BYTES) {
      throw new Error("Bot room message exceeds the 256 KiB limit");
    }
  }

  private pruneHistory(roomId: string): void {
    const cutoff = Date.now() - ROOM_RETENTION_MS;
    this.db
      .prepare(
        `DELETE FROM bot_room_messages
         WHERE room_id = ? AND (
           created_at < ? OR id NOT IN (
             SELECT id FROM bot_room_messages
             WHERE room_id = ? ORDER BY created_at DESC LIMIT ?
           )
         )`,
      )
      .run(roomId, cutoff, roomId, MAX_ROOM_HISTORY);
  }

  private mapRoom(row: Row): BotRoom {
    return {
      id: String(row.id),
      name: String(row.name),
      ownerAgentId: row.owner_agent_id ? String(row.owner_agent_id) : undefined,
      executionMode: String(row.execution_mode || "sequential") as BotRoomExecutionMode,
      maxRounds: Number(row.max_rounds || 3),
      maxMessages: Number(row.max_messages || 10),
      epoch: Number(row.epoch || 0),
      currentRound: Number(row.current_round || 0),
      activeRunId: row.active_run_id ? String(row.active_run_id) : undefined,
      leaseExpiresAt: row.lease_expires_at ? Number(row.lease_expires_at) : undefined,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  private mapMessage(row: Row): BotRoomMessage {
    return {
      id: String(row.id),
      roomId: String(row.room_id),
      runId: row.run_id ? String(row.run_id) : undefined,
      epoch: Number(row.epoch || 0),
      round: Number(row.round || 0),
      seq: Number(row.seq || 0),
      fromAgentId: row.from_agent_id ? String(row.from_agent_id) : undefined,
      body: String(row.body || ""),
      status: String(row.status || "delivered") as BotRoomMessage["status"],
      replyTo: row.reply_to ? String(row.reply_to) : undefined,
      createdAt: Number(row.created_at || 0),
    };
  }
}
