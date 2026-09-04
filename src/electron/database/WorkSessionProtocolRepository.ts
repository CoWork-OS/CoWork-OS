import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import type {
  WorkSession,
  WorkSessionActor,
  WorkSessionAggregate,
  WorkSessionCreateInput,
  WorkSessionItem,
  WorkSessionItemAppendInput,
  WorkSessionRedactionClass,
  WorkSessionReplayProjection,
  WorkSessionStatus,
  WorkSessionTurn,
  WorkSessionTurnCreateInput,
  WorkSessionTurnStatus,
} from "../../shared/types";

type DbRow = Record<string, unknown>;

const SESSION_STATUSES = new Set<WorkSessionStatus>([
  "pending",
  "executing",
  "waiting",
  "paused",
  "completed",
  "partial_success",
  "failed",
  "cancelled",
]);

const TURN_STATUSES = new Set<WorkSessionTurnStatus>([
  "pending",
  "executing",
  "waiting",
  "completed",
  "partial_success",
  "failed",
  "cancelled",
]);

const REDACTION_CLASSES = new Set<WorkSessionRedactionClass>([
  "none",
  "standard",
  "sensitive",
  "secret_redacted",
]);

const SENSITIVE_KEY =
  /(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;
const SECRET_VALUE =
  /(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|bearer\s+[A-Za-z0-9._-]{12,})/i;
const MAX_PROTOCOL_STRING_LENGTH = 16_000;
const MAX_PROTOCOL_ARRAY_ITEMS = 500;
const MAX_PROTOCOL_DEPTH = 8;

export class WorkSessionProtocolError extends Error {
  constructor(
    message: string,
    readonly code = "WORK_SESSION_PROTOCOL_ERROR",
  ) {
    super(message);
    this.name = "WorkSessionProtocolError";
  }
}

export class StaleWorkSessionTurnError extends WorkSessionProtocolError {
  constructor(
    readonly sessionId: string,
    readonly expectedTurnId: string,
    readonly currentTurnId?: string,
  ) {
    super(
      `Stale work-session turn for ${sessionId}: expected ${expectedTurnId}, current ${currentTurnId || "none"}.`,
      "STALE_TURN",
    );
    this.name = "StaleWorkSessionTurnError";
  }
}

function requiredId(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new WorkSessionProtocolError(`${label} is required`, "INVALID_ID");
  return normalized;
}

function optionalId(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function boundedText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length > MAX_PROTOCOL_STRING_LENGTH
    ? normalized.slice(0, MAX_PROTOCOL_STRING_LENGTH)
    : normalized;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeSessionStatus(value: unknown): WorkSessionStatus {
  const status = typeof value === "string" ? value : "";
  return SESSION_STATUSES.has(status as WorkSessionStatus)
    ? (status as WorkSessionStatus)
    : "pending";
}

function normalizeTurnStatus(value: unknown): WorkSessionTurnStatus {
  const status = typeof value === "string" ? value : "";
  return TURN_STATUSES.has(status as WorkSessionTurnStatus)
    ? (status as WorkSessionTurnStatus)
    : "pending";
}

function normalizeRedactionClass(value: unknown): WorkSessionRedactionClass {
  const redactionClass = typeof value === "string" ? value : "";
  return REDACTION_CLASSES.has(redactionClass as WorkSessionRedactionClass)
    ? (redactionClass as WorkSessionRedactionClass)
    : "standard";
}

function normalizeActor(value: unknown): WorkSessionActor | string {
  const actor = boundedText(value, "system");
  return actor || "system";
}

function isTerminalTurnStatus(status: WorkSessionTurnStatus): boolean {
  return (
    status === "completed" ||
    status === "partial_success" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function sessionStatusForTurn(status: WorkSessionTurnStatus): WorkSessionStatus {
  return status;
}

/**
 * Redact and bound protocol payloads before they reach the durable stream.
 * TaskEvent has its own compatibility sanitizer; this second boundary keeps
 * the canonical protocol safe even when callers append arbitrary legacy data.
 */
export function redactWorkSessionValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string" && SECRET_VALUE.test(value)) return "[redacted]";
  if (depth >= MAX_PROTOCOL_DEPTH) return "[depth-limited]";
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PROTOCOL_ARRAY_ITEMS)
      .map((item) => redactWorkSessionValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .slice(0, MAX_PROTOCOL_ARRAY_ITEMS)
        .map(([entryKey, entryValue]) => [
          entryKey,
          redactWorkSessionValue(entryValue, entryKey, depth + 1),
        ]),
    );
  }
  return String(value);
}

function redactPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const redacted = redactWorkSessionValue(payload || {}) as Record<string, unknown>;
  return redacted && typeof redacted === "object" && !Array.isArray(redacted) ? redacted : {};
}

function containsSensitiveKey(value: unknown, key = "", depth = 0): boolean {
  if (SENSITIVE_KEY.test(key)) return true;
  if (typeof value === "string" && SECRET_VALUE.test(value)) return true;
  if (depth >= MAX_PROTOCOL_DEPTH || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKey(item, key, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([entryKey, entryValue]) =>
    containsSensitiveKey(entryValue, entryKey, depth + 1),
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function checksum(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export interface WorkSessionTaskBinding {
  taskId: string;
  workspaceId: string;
  sessionId?: string;
  status?: WorkSessionStatus;
}

export interface WorkSessionUserMessageInput {
  sessionId: string;
  message: string;
  taskId?: string;
  actor?: WorkSessionActor | string;
  expectedTurnId?: string;
  idempotencyKey?: string;
  sourceEventId?: string;
  policySnapshot?: Record<string, unknown>;
}

export interface WorkSessionTerminalInput {
  sessionId: string;
  turnId: string;
  status: Extract<WorkSessionTurnStatus, "completed" | "partial_success" | "failed" | "cancelled">;
  reason?: string;
  expectedTurnId?: string;
  actor?: WorkSessionActor | string;
}

export class WorkSessionProtocolRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Atomically create the protocol aggregate's session, root turn, and first
   * session item. Repeated calls for the same task/session are idempotent.
   */
  createAggregate(input: WorkSessionCreateInput): WorkSessionAggregate {
    const workspaceId = requiredId(input.workspaceId, "workspaceId");
    const requestedSessionId = optionalId(input.id) || randomUUID();
    const taskId = optionalId(input.taskId);
    const now = Date.now();

    const create = this.db.transaction((): string => {
      const existing =
        this.findSessionRow(requestedSessionId) ||
        (taskId ? this.findSessionRowByTaskId(taskId) : undefined);
      if (existing) {
        if (String(existing.workspace_id || "") !== workspaceId) {
          throw new WorkSessionProtocolError(
            `Session ${requestedSessionId} belongs to another workspace`,
            "SESSION_WORKSPACE_CONFLICT",
          );
        }
        if (taskId && existing.task_id && String(existing.task_id) !== taskId) {
          throw new WorkSessionProtocolError(
            `Session ${requestedSessionId} is already bound to another task`,
            "SESSION_TASK_CONFLICT",
          );
        }
        if (taskId) this.bindTaskSessionInTransaction(taskId, String(existing.id));
        return String(existing.id);
      }

      this.db
        .prepare(
          `
            INSERT INTO work_sessions (
              id, task_id, workspace_id, protocol_version, status,
              current_turn_id, last_sequence, created_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, NULL, 0, ?, ?)
          `,
        )
        .run(
          requestedSessionId,
          taskId || null,
          workspaceId,
          normalizeSessionStatus(input.status),
          now,
          now,
        );

      if (input.createInitialTurn !== false) {
        const turn = this.createTurnInTransaction({
          sessionId: requestedSessionId,
          taskId,
          actor: input.actor || "system",
          idempotencyKey: input.idempotencyKey
            ? `${input.idempotencyKey}:root-turn`
            : `session:${requestedSessionId}:root-turn`,
          status: input.status === "executing" ? "executing" : "pending",
        });
        this.appendItemInTransaction({
          sessionId: requestedSessionId,
          turnId: turn.id,
          kind: "session",
          actor: input.actor || "system",
          payload: {
            event: "session.created",
            ...(input.source ? { source: boundedText(input.source) } : {}),
          },
          idempotencyKey: `session:${requestedSessionId}:created`,
          redactionClass: "standard",
          status: turn.status,
        });
      }

      if (taskId) this.bindTaskSessionInTransaction(taskId, requestedSessionId);

      return requestedSessionId;
    })();

    const aggregate = this.getAggregate(create);
    if (!aggregate) throw new WorkSessionProtocolError(`Failed to create session ${create}`);
    return aggregate;
  }

  ensureForTask(binding: WorkSessionTaskBinding): WorkSessionAggregate {
    const taskId = requiredId(binding.taskId, "taskId");
    const workspaceId = requiredId(binding.workspaceId, "workspaceId");
    const session = this.ensureSessionForTask({
      ...(binding.sessionId ? { id: binding.sessionId } : {}),
      taskId,
      workspaceId,
      status: binding.status,
    });
    return this.getAggregate(session.id)!;
  }

  /** Ensure only the session row exists, avoiding a full aggregate scan on hot event paths. */
  ensureSessionForTask(binding: WorkSessionTaskBinding & { id?: string }): WorkSession {
    const taskId = requiredId(binding.taskId, "taskId");
    const workspaceId = requiredId(binding.workspaceId, "workspaceId");
    const boundSessionId = this.findBoundSessionId(taskId);
    const requestedSessionId = boundSessionId || optionalId(binding.id || binding.sessionId);
    const existingRow =
      (requestedSessionId ? this.findSessionRow(requestedSessionId) : undefined) ||
      this.findSessionRowByTaskId(taskId);
    if (existingRow) {
      if (String(existingRow.workspace_id || "") !== workspaceId) {
        throw new WorkSessionProtocolError(
          `Session ${existingRow.id} belongs to another workspace`,
          "SESSION_WORKSPACE_CONFLICT",
        );
      }
      if (existingRow.task_id && String(existingRow.task_id) !== taskId) {
        throw new WorkSessionProtocolError(
          `Session ${existingRow.id} is already bound to another task`,
          "SESSION_TASK_CONFLICT",
        );
      }
      if (!boundSessionId) {
        this.db.transaction(() => {
          this.bindTaskSessionInTransaction(taskId, String(existingRow.id));
        })();
      }
      return this.mapSession(existingRow);
    }
    return this.createAggregate({
      ...(requestedSessionId ? { id: requestedSessionId } : {}),
      taskId,
      workspaceId,
      status: binding.status,
    }).session;
  }

  findById(sessionId: string): WorkSessionAggregate | undefined {
    const normalized = optionalId(sessionId);
    if (!normalized) return undefined;
    return this.getAggregate(normalized);
  }

  findByTaskId(taskId: string): WorkSessionAggregate | undefined {
    const normalized = optionalId(taskId);
    if (!normalized) return undefined;
    const boundSessionId = this.findBoundSessionId(normalized);
    const row = boundSessionId
      ? this.findSessionRow(boundSessionId)
      : this.findSessionRowByTaskId(normalized);
    return row ? this.getAggregate(String(row.id)) : undefined;
  }

  getCurrentTurn(sessionId: string): WorkSessionTurn | undefined {
    const session = this.getSession(sessionId);
    if (!session?.currentTurnId) return undefined;
    return this.getTurn(session.currentTurnId);
  }

  getSessionById(sessionId: string): WorkSession | undefined {
    const normalized = optionalId(sessionId);
    if (!normalized) return undefined;
    return this.getSession(normalized);
  }

  countItems(sessionId: string): number {
    const normalized = requiredId(sessionId, "sessionId");
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM work_session_items WHERE session_id = ?")
      .get(normalized) as { count?: number } | undefined;
    return Math.max(0, Number(row?.count || 0));
  }

  assertExpectedTurn(sessionId: string, expectedTurnId: string): WorkSessionTurn {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const expected = requiredId(expectedTurnId, "expectedTurnId");
    const session = this.getSession(normalizedSessionId);
    if (!session)
      throw new WorkSessionProtocolError(`WorkSession not found: ${normalizedSessionId}`);
    if (session.currentTurnId !== expected) {
      throw new StaleWorkSessionTurnError(normalizedSessionId, expected, session.currentTurnId);
    }
    const turn = this.getTurn(expected);
    if (!turn || turn.sessionId !== normalizedSessionId) {
      throw new StaleWorkSessionTurnError(normalizedSessionId, expected, session.currentTurnId);
    }
    return turn;
  }

  createTurn(input: WorkSessionTurnCreateInput): WorkSessionTurn {
    const sessionId = requiredId(input.sessionId, "sessionId");
    return this.db.transaction(() => this.createTurnInTransaction({ ...input, sessionId }))();
  }

  private createTurnInTransaction(input: WorkSessionTurnCreateInput): WorkSessionTurn {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const sessionRow = this.findSessionRow(sessionId);
    if (!sessionRow) throw new WorkSessionProtocolError(`WorkSession not found: ${sessionId}`);

    const idempotencyKey = optionalId(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.findTurnRowByIdempotency(sessionId, idempotencyKey);
      if (existing) return this.mapTurn(existing);
    }
    if (input.expectedTurnId !== undefined) {
      const expected = requiredId(input.expectedTurnId, "expectedTurnId");
      const currentTurnId = optionalId(sessionRow.current_turn_id);
      if (currentTurnId !== expected) {
        throw new StaleWorkSessionTurnError(sessionId, expected, currentTurnId);
      }
    }

    const ordinalRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM work_session_turns WHERE session_id = ?",
      )
      .get(sessionId) as DbRow | undefined;
    const ordinal = Math.max(1, Number(ordinalRow?.max_ordinal || 0) + 1);
    const id = randomUUID();
    const now = Date.now();
    const status = normalizeTurnStatus(input.status);
    this.db
      .prepare(
        `
          INSERT INTO work_session_turns (
            id, session_id, task_id, ordinal, status, actor, idempotency_key,
            started_at, completed_at, terminal_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `,
      )
      .run(
        id,
        sessionId,
        optionalId(input.taskId) || (sessionRow.task_id ? String(sessionRow.task_id) : null),
        ordinal,
        status,
        normalizeActor(input.actor),
        idempotencyKey || null,
        now,
      );
    this.db
      .prepare(
        `UPDATE work_sessions SET current_turn_id = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(id, sessionStatusForTurn(status), now, sessionId);
    const row = this.db.prepare("SELECT * FROM work_session_turns WHERE id = ?").get(id) as DbRow;
    return this.mapTurn(row);
  }

  appendItem(input: WorkSessionItemAppendInput): WorkSessionItem {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const turnId = requiredId(input.turnId, "turnId");
    return this.db.transaction(() =>
      this.appendItemInTransaction({ ...input, sessionId, turnId }),
    )();
  }

  private appendItemInTransaction(input: WorkSessionItemAppendInput): WorkSessionItem {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const turnId = requiredId(input.turnId, "turnId");
    const sessionRow = this.findSessionRow(sessionId);
    if (!sessionRow) throw new WorkSessionProtocolError(`WorkSession not found: ${sessionId}`);
    const turnRow = this.db
      .prepare("SELECT * FROM work_session_turns WHERE id = ? AND session_id = ?")
      .get(turnId, sessionId) as DbRow | undefined;
    if (!turnRow)
      throw new WorkSessionProtocolError(`Turn ${turnId} is not in session ${sessionId}`);

    const idempotencyKey = optionalId(input.idempotencyKey);
    const sourceEventId = optionalId(input.sourceEventId);
    const existing = idempotencyKey
      ? this.findItemRowByIdempotency(sessionId, idempotencyKey)
      : sourceEventId
        ? this.findItemRowBySourceEvent(sessionId, sourceEventId)
        : undefined;
    if (existing) return this.mapItem(existing);

    const lastSequence = Math.max(0, Number(sessionRow.last_sequence || 0));
    const sequence = lastSequence + 1;
    const id = randomUUID();
    const now = Date.now();
    const requestedRedactionClass = normalizeRedactionClass(input.redactionClass);
    const redactionClass =
      containsSensitiveKey(input.payload) || containsSensitiveKey(input.policySnapshot)
        ? "secret_redacted"
        : requestedRedactionClass;
    const payload = redactPayload(input.payload);
    const policySnapshot = input.policySnapshot ? redactPayload(input.policySnapshot) : undefined;
    this.db
      .prepare(
        `
          INSERT INTO work_session_items (
            id, session_id, turn_id, sequence, kind, actor, payload_json,
            causal_parent_item_id, idempotency_key, source_event_id,
            policy_snapshot_json, redaction_class, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        sessionId,
        turnId,
        sequence,
        boundedText(input.kind, "legacy_event"),
        normalizeActor(input.actor),
        JSON.stringify(payload),
        optionalId(input.causalParentItemId) || null,
        idempotencyKey || null,
        sourceEventId || null,
        policySnapshot ? JSON.stringify(policySnapshot) : null,
        redactionClass,
        input.status ? normalizeTurnStatus(input.status) : null,
        now,
      );
    this.db
      .prepare("UPDATE work_sessions SET last_sequence = ?, updated_at = ? WHERE id = ?")
      .run(sequence, now, sessionId);
    const row = this.db.prepare("SELECT * FROM work_session_items WHERE id = ?").get(id) as DbRow;
    return this.mapItem(row);
  }

  appendUserMessage(input: WorkSessionUserMessageInput): {
    turn: WorkSessionTurn;
    item: WorkSessionItem;
  } {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const message = boundedText(input.message);
    if (!message) throw new WorkSessionProtocolError("message is required", "INVALID_MESSAGE");

    const result = this.db.transaction(() => {
      const itemKey = optionalId(input.idempotencyKey);
      const sourceEventId = optionalId(input.sourceEventId);
      const existing = itemKey
        ? this.findItemRowByIdempotency(sessionId, itemKey)
        : sourceEventId
          ? this.findItemRowBySourceEvent(sessionId, sourceEventId)
          : undefined;
      if (existing) {
        const turn = this.getTurn(String(existing.turn_id));
        if (!turn) throw new WorkSessionProtocolError(`Turn missing for item ${existing.id}`);
        return { turn, item: this.mapItem(existing) };
      }
      const sessionRow = this.findSessionRow(sessionId);
      if (!sessionRow) throw new WorkSessionProtocolError(`WorkSession not found: ${sessionId}`);
      if (input.expectedTurnId !== undefined) {
        const expected = requiredId(input.expectedTurnId, "expectedTurnId");
        const current = optionalId(sessionRow.current_turn_id);
        if (current !== expected) throw new StaleWorkSessionTurnError(sessionId, expected, current);
      }

      let turn = sessionRow.current_turn_id
        ? this.getTurn(String(sessionRow.current_turn_id))
        : undefined;
      if (!turn || isTerminalTurnStatus(turn.status)) {
        turn = this.createTurnInTransaction({
          sessionId,
          taskId: input.taskId,
          actor: input.actor || "user",
          idempotencyKey: itemKey ? `${itemKey}:turn` : undefined,
          status: "executing",
        });
      } else if (turn.status === "pending" || turn.status === "waiting") {
        this.db
          .prepare("UPDATE work_session_turns SET status = ?, completed_at = NULL WHERE id = ?")
          .run("executing", turn.id);
        this.db
          .prepare("UPDATE work_sessions SET status = 'executing', updated_at = ? WHERE id = ?")
          .run(Date.now(), sessionId);
        turn = this.getTurn(turn.id)!;
      }

      const previous = this.getLastItem(sessionId);
      const item = this.appendItemInTransaction({
        sessionId,
        turnId: turn.id,
        kind: "message",
        actor: input.actor || "user",
        payload: { role: "user", message },
        causalParentItemId: previous?.id,
        idempotencyKey: itemKey,
        sourceEventId: input.sourceEventId,
        policySnapshot: input.policySnapshot,
        redactionClass: "standard",
        status: "executing",
      });
      return { turn, item };
    })();
    return result;
  }

  setTurnStatus(
    sessionId: string,
    turnId: string,
    status: WorkSessionTurnStatus,
    reason?: string,
    expectedTurnId?: string,
  ): WorkSessionTurn {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const normalizedTurnId = requiredId(turnId, "turnId");
    return this.db.transaction(() => {
      const session = this.getSession(normalizedSessionId);
      if (!session)
        throw new WorkSessionProtocolError(`WorkSession not found: ${normalizedSessionId}`);
      if (expectedTurnId !== undefined) {
        this.assertExpectedTurnInTransaction(session, expectedTurnId);
      }
      const existing = this.getTurn(normalizedTurnId);
      if (!existing || existing.sessionId !== normalizedSessionId) {
        throw new WorkSessionProtocolError(
          `Turn ${normalizedTurnId} is not in session ${normalizedSessionId}`,
        );
      }
      const nextStatus = normalizeTurnStatus(status);
      if (isTerminalTurnStatus(existing.status) && existing.status !== nextStatus) {
        throw new WorkSessionProtocolError(
          `Turn ${normalizedTurnId} is already terminal (${existing.status})`,
          "TURN_TERMINAL",
        );
      }
      const completedAt = isTerminalTurnStatus(nextStatus) ? Date.now() : null;
      this.db
        .prepare(
          `UPDATE work_session_turns
           SET status = ?, completed_at = ?, terminal_reason = ?
           WHERE id = ?`,
        )
        .run(nextStatus, completedAt, reason ? boundedText(reason) : null, normalizedTurnId);
      this.db
        .prepare(
          "UPDATE work_sessions SET status = ?, current_turn_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(sessionStatusForTurn(nextStatus), normalizedTurnId, Date.now(), normalizedSessionId);
      return this.getTurn(normalizedTurnId)!;
    })();
  }

  completeTurn(input: WorkSessionTerminalInput): WorkSessionTurn {
    const normalizedSessionId = requiredId(input.sessionId, "sessionId");
    const normalizedTurnId = requiredId(input.turnId, "turnId");
    return this.db.transaction(() => {
      const session = this.getSession(normalizedSessionId);
      if (!session)
        throw new WorkSessionProtocolError(`WorkSession not found: ${normalizedSessionId}`);
      if (input.expectedTurnId !== undefined) {
        this.assertExpectedTurnInTransaction(session, input.expectedTurnId);
      }
      const turn = this.getTurn(normalizedTurnId);
      if (!turn || turn.sessionId !== normalizedSessionId) {
        throw new WorkSessionProtocolError(
          `Turn ${normalizedTurnId} is not in session ${normalizedSessionId}`,
        );
      }
      if (isTerminalTurnStatus(turn.status)) {
        if (turn.status !== input.status) {
          throw new WorkSessionProtocolError(
            `Turn ${normalizedTurnId} is already terminal (${turn.status})`,
            "TURN_TERMINAL",
          );
        }
        return turn;
      }
      const reason = input.reason ? boundedText(input.reason) : undefined;
      this.db
        .prepare(
          `UPDATE work_session_turns
           SET status = ?, completed_at = ?, terminal_reason = ?
           WHERE id = ?`,
        )
        .run(input.status, Date.now(), reason || null, normalizedTurnId);
      this.db
        .prepare(
          "UPDATE work_sessions SET status = ?, current_turn_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.status, normalizedTurnId, Date.now(), normalizedSessionId);
      const previous = this.getLastItem(normalizedSessionId);
      this.appendItemInTransaction({
        sessionId: normalizedSessionId,
        turnId: normalizedTurnId,
        kind: "status",
        actor: input.actor || "system",
        payload: {
          event: `turn.${input.status}`,
          ...(reason ? { reason } : {}),
        },
        causalParentItemId: previous?.id,
        idempotencyKey: `turn:${normalizedTurnId}:terminal:${input.status}`,
        redactionClass: "standard",
        status: input.status,
      });
      return this.getTurn(normalizedTurnId)!;
    })();
  }

  listItems(
    sessionId: string,
    options?: { afterSequence?: number; limit?: number },
  ): WorkSessionItem[] {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const afterSequence =
      typeof options?.afterSequence === "number" && Number.isFinite(options.afterSequence)
        ? Math.max(0, Math.floor(options.afterSequence))
        : 0;
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.min(10_000, Math.max(1, Math.floor(options.limit)))
        : 10_000;
    const rows = this.db
      .prepare(
        `SELECT * FROM work_session_items
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(normalizedSessionId, afterSequence, limit) as DbRow[];
    return rows.map((row) => this.mapItem(row));
  }

  /**
   * Read the complete canonical stream in bounded pages.  `listItems` remains
   * deliberately capped so UI callers cannot accidentally materialize an
   * unbounded session, while replay/aggregate consumers can safely handle
   * sessions larger than 10,000 items.
   */
  listAllItems(sessionId: string, options?: { pageSize?: number }): WorkSessionItem[] {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const pageSize =
      typeof options?.pageSize === "number" && Number.isFinite(options.pageSize)
        ? Math.min(10_000, Math.max(1, Math.floor(options.pageSize)))
        : 10_000;
    const items: WorkSessionItem[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = this.listItems(normalizedSessionId, { afterSequence, limit: pageSize });
      if (page.length === 0) break;
      items.push(...page);
      const nextSequence = page[page.length - 1]?.sequence || afterSequence;
      if (nextSequence <= afterSequence) {
        throw new WorkSessionProtocolError(
          `Canonical item sequence did not advance for session ${normalizedSessionId}`,
          "NON_MONOTONIC_SEQUENCE",
        );
      }
      afterSequence = nextSequence;
      if (page.length < pageSize) break;
    }
    return items;
  }

  replay(sessionId: string): WorkSessionReplayProjection | undefined {
    const aggregate = this.findById(sessionId);
    if (!aggregate) return undefined;
    const turnStatuses = Object.fromEntries(aggregate.turns.map((turn) => [turn.id, turn.status]));
    const projection = {
      sessionId: aggregate.session.id,
      currentTurnId: aggregate.session.currentTurnId,
      status: aggregate.session.status,
      lastSequence: aggregate.session.lastSequence,
      turnStatuses,
      itemCount: aggregate.items.length,
    } satisfies Omit<WorkSessionReplayProjection, "checksum">;
    return { ...projection, checksum: checksum(projection) };
  }

  checksum(sessionId: string): string | undefined {
    return this.replay(sessionId)?.checksum;
  }

  private getAggregate(sessionId: string): WorkSessionAggregate | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const turns = (
      this.db
        .prepare("SELECT * FROM work_session_turns WHERE session_id = ? ORDER BY ordinal ASC")
        .all(session.id) as DbRow[]
    ).map((row) => this.mapTurn(row));
    const items = this.listAllItems(session.id);
    return {
      session,
      turns,
      items,
      checksum: checksum({ session, turns, items }),
    };
  }

  private getSession(sessionId: string): WorkSession | undefined {
    const row = this.findSessionRow(sessionId);
    return row ? this.mapSession(row) : undefined;
  }

  private getTurn(turnId: string): WorkSessionTurn | undefined {
    const row = this.db.prepare("SELECT * FROM work_session_turns WHERE id = ?").get(turnId) as
      | DbRow
      | undefined;
    return row ? this.mapTurn(row) : undefined;
  }

  getLastItem(sessionId: string): WorkSessionItem | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM work_session_items WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(sessionId) as DbRow | undefined;
    return row ? this.mapItem(row) : undefined;
  }

  /** Find the canonical item emitted for a legacy task event. */
  findItemBySourceEvent(sessionId: string, sourceEventId: string): WorkSessionItem | undefined {
    const row = this.findItemRowBySourceEvent(
      requiredId(sessionId, "sessionId"),
      requiredId(sourceEventId, "sourceEventId"),
    );
    return row ? this.mapItem(row) : undefined;
  }

  private findSessionRow(sessionId: string): DbRow | undefined {
    return this.db.prepare("SELECT * FROM work_sessions WHERE id = ?").get(sessionId) as
      | DbRow
      | undefined;
  }

  private findSessionRowByTaskId(taskId: string): DbRow | undefined {
    return this.db.prepare("SELECT * FROM work_sessions WHERE task_id = ?").get(taskId) as
      | DbRow
      | undefined;
  }

  /** Resolve the isolated canonical session associated with a task. */
  findSessionIdForTask(taskId: string): string | undefined {
    const normalized = optionalId(taskId);
    return normalized ? this.findBoundSessionId(normalized) : undefined;
  }

  /** Bind a task to a canonical protocol session without changing legacy task.session_id. */
  bindTaskSession(taskId: string, sessionId: string): void {
    const normalizedTaskId = requiredId(taskId, "taskId");
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    this.db.transaction(() => {
      this.bindTaskSessionInTransaction(normalizedTaskId, normalizedSessionId);
    })();
  }

  updateTaskSessionBinding(
    taskId: string,
    updates: {
      parentSessionId?: string;
      isolationKey?: string;
      owner?: string;
      inheritedPolicySnapshot?: Record<string, unknown>;
    },
  ): void {
    const normalizedTaskId = requiredId(taskId, "taskId");
    const existingSessionId = this.findBoundSessionId(normalizedTaskId);
    if (!existingSessionId) {
      throw new WorkSessionProtocolError(
        `Task ${normalizedTaskId} is not bound to a protocol session`,
        "TASK_SESSION_NOT_FOUND",
      );
    }
    const parentSessionId = optionalId(updates.parentSessionId);
    const isolationKey = optionalId(updates.isolationKey) || `session:${existingSessionId}`;
    const owner = boundedText(updates.owner, "system") || "system";
    const inheritedPolicySnapshot = updates.inheritedPolicySnapshot
      ? JSON.stringify(redactPayload(updates.inheritedPolicySnapshot))
      : null;
    this.db
      .prepare(
        `UPDATE work_session_task_bindings
         SET parent_session_id = ?, isolation_key = ?, owner = ?,
             inherited_policy_snapshot_json = ?, updated_at = ?
         WHERE task_id = ?`,
      )
      .run(
        parentSessionId || null,
        isolationKey,
        owner,
        inheritedPolicySnapshot,
        Date.now(),
        normalizedTaskId,
      );
  }

  private bindTaskSessionInTransaction(taskId: string, sessionId: string): void {
    const normalizedTaskId = requiredId(taskId, "taskId");
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const existing = this.db
      .prepare("SELECT session_id FROM work_session_task_bindings WHERE task_id = ?")
      .get(normalizedTaskId) as { session_id?: string } | undefined;
    if (existing?.session_id && String(existing.session_id) !== normalizedSessionId) {
      throw new WorkSessionProtocolError(
        `Task ${normalizedTaskId} is already bound to session ${existing.session_id}`,
        "TASK_SESSION_CONFLICT",
      );
    }
    const now = Date.now();
    this.db
      .prepare(
        `
          INSERT INTO work_session_task_bindings (
            task_id, session_id, parent_session_id, isolation_key,
            inherited_policy_snapshot_json, owner, created_at, updated_at
          ) VALUES (?, ?, NULL, ?, NULL, 'system', ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET updated_at = excluded.updated_at
        `,
      )
      .run(normalizedTaskId, normalizedSessionId, `session:${normalizedSessionId}`, now, now);
  }

  private findBoundSessionId(taskId: string): string | undefined {
    const row = this.db
      .prepare("SELECT session_id FROM work_session_task_bindings WHERE task_id = ?")
      .get(taskId) as { session_id?: string } | undefined;
    return row?.session_id ? String(row.session_id) : undefined;
  }

  private findTurnRowByIdempotency(sessionId: string, idempotencyKey: string): DbRow | undefined {
    return this.db
      .prepare("SELECT * FROM work_session_turns WHERE session_id = ? AND idempotency_key = ?")
      .get(sessionId, idempotencyKey) as DbRow | undefined;
  }

  private findItemRowByIdempotency(sessionId: string, idempotencyKey: string): DbRow | undefined {
    return this.db
      .prepare("SELECT * FROM work_session_items WHERE session_id = ? AND idempotency_key = ?")
      .get(sessionId, idempotencyKey) as DbRow | undefined;
  }

  private findItemRowBySourceEvent(sessionId: string, sourceEventId: string): DbRow | undefined {
    return this.db
      .prepare("SELECT * FROM work_session_items WHERE session_id = ? AND source_event_id = ?")
      .get(sessionId, sourceEventId) as DbRow | undefined;
  }

  private assertExpectedTurnInTransaction(session: WorkSession, expectedTurnId: string): void {
    const expected = requiredId(expectedTurnId, "expectedTurnId");
    if (session.currentTurnId !== expected) {
      throw new StaleWorkSessionTurnError(session.id, expected, session.currentTurnId);
    }
  }

  private mapSession(row: DbRow): WorkSession {
    return {
      id: String(row.id || ""),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      workspaceId: String(row.workspace_id || ""),
      protocolVersion: 1,
      status: normalizeSessionStatus(row.status),
      ...(row.current_turn_id ? { currentTurnId: String(row.current_turn_id) } : {}),
      lastSequence: Math.max(0, Number(row.last_sequence || 0)),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  private mapTurn(row: DbRow): WorkSessionTurn {
    return {
      id: String(row.id || ""),
      sessionId: String(row.session_id || ""),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      ordinal: Math.max(1, Number(row.ordinal || 0)),
      status: normalizeTurnStatus(row.status),
      actor: normalizeActor(row.actor),
      ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}),
      startedAt: Number(row.started_at || 0),
      ...(row.completed_at ? { completedAt: Number(row.completed_at) } : {}),
      ...(row.terminal_reason ? { terminalReason: String(row.terminal_reason) } : {}),
    };
  }

  private mapItem(row: DbRow): WorkSessionItem {
    const rawPayload = parseJson<Record<string, unknown>>(row.payload_json, {});
    const rawPolicy = row.policy_snapshot_json
      ? parseJson<Record<string, unknown>>(row.policy_snapshot_json, {})
      : undefined;
    return {
      id: String(row.id || ""),
      sessionId: String(row.session_id || ""),
      turnId: String(row.turn_id || ""),
      sequence: Math.max(1, Number(row.sequence || 0)),
      kind: boundedText(row.kind, "legacy_event") as WorkSessionItem["kind"],
      actor: normalizeActor(row.actor),
      payload: redactPayload(rawPayload),
      ...(row.causal_parent_item_id
        ? { causalParentItemId: String(row.causal_parent_item_id) }
        : {}),
      ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}),
      ...(row.source_event_id ? { sourceEventId: String(row.source_event_id) } : {}),
      ...(rawPolicy ? { policySnapshot: redactPayload(rawPolicy) } : {}),
      redactionClass: normalizeRedactionClass(row.redaction_class),
      ...(row.status ? { status: normalizeTurnStatus(row.status) } : {}),
      createdAt: Number(row.created_at || 0),
    };
  }
}
