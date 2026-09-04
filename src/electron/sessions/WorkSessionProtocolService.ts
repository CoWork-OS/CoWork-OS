import type Database from "better-sqlite3";
import type {
  Task,
  TaskEvent,
  WorkSession,
  WorkSessionActor,
  WorkSessionAggregate,
  WorkSessionItem,
  WorkSessionItemKind,
  WorkSessionReadMode,
  WorkSessionStatus,
  WorkSessionTurn,
  WorkSessionTurnStatus,
} from "../../shared/types";
import { TaskEventRepository, TaskRepository } from "../database/repositories";
import {
  WorkSessionProtocolRepository,
  type WorkSessionTaskBinding,
} from "../database/WorkSessionProtocolRepository";
import { WorkSessionReliabilityService } from "./WorkSessionReliabilityService";

const EPHEMERAL_EVENT_TYPES = new Set(["llm_streaming"]);

const TERMINAL_EVENT_STATUS: Partial<
  Record<
    string,
    Extract<WorkSessionTurnStatus, "completed" | "partial_success" | "failed" | "cancelled">
  >
> = {
  task_completed: "completed",
  follow_up_completed: "completed",
  agent_completed: "completed",
  orchestration_run_completed: "completed",
  pipeline_completed: "completed",
  task_cancelled: "cancelled",
  task_failed: "failed",
  follow_up_failed: "failed",
  agent_failed: "failed",
  orchestration_run_failed: "failed",
  pipeline_failed: "failed",
};

const WAITING_EVENT_TYPES = new Set([
  "approval_requested",
  "input_request_created",
  "reconnect_requested",
  "child_wait",
  "verification_pending_user_action",
  "task_paused",
  "task_interrupted",
  "auto_continuation_blocked",
  "follow_up_turn_recovery_blocked",
  "safety_stop_triggered",
  "mode_gate_blocked",
]);

const EXECUTING_EVENT_TYPES = new Set([
  "executing",
  "task_resumed",
  "task_dequeued",
  "task_started",
  "step_started",
  "tool_call",
  "assistant_message",
  "user_message",
  "follow_up_tool_lock_forced_finalization",
]);

// A durable resume/continuation pulse starts a new turn when the previous
// turn is waiting. This keeps the causal boundary explicit without creating
// duplicate turns for retries of the same event.
const NEW_TURN_EVENT_TYPES = new Set([
  "task_resumed",
  "auto_continuation_started",
  "follow_up_turn_recovery_started",
]);

const STATUS_EVENT_TYPES = new Set([
  "task_created",
  "task_queued",
  "queue_updated",
  "task_status",
  "task_dequeued",
  "task_resumed",
  "task_paused",
  "task_interrupted",
  "plan_created",
  "plan_revised",
  "step_started",
  "step_completed",
  "step_failed",
  "step_skipped",
  "progress_update",
  "verification_started",
  "verification_passed",
  "verification_failed",
  "retry_started",
  "continuation_decision",
  "auto_continuation_started",
  "auto_continuation_blocked",
  "context_compaction_started",
  "context_compaction_completed",
  "context_compaction_failed",
  "no_progress_circuit_breaker",
  "follow_up_turn_recovery_started",
  "follow_up_turn_recovery_completed",
  "follow_up_turn_recovery_blocked",
  "safety_stop_triggered",
]);

function normalizeEventType(event: TaskEvent): string {
  const payload = event.payload;
  if (event.legacyType && typeof event.legacyType === "string") {
    return event.legacyType.trim() || event.type;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const legacyType = (payload as Record<string, unknown>).legacyType;
    if (typeof legacyType === "string" && legacyType.trim()) return legacyType.trim();
  }
  return String(event.type || "legacy_event");
}

function payloadRecord(event: TaskEvent): Record<string, unknown> {
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    return event.payload as Record<string, unknown>;
  }
  return event.payload === undefined ? {} : { value: event.payload };
}

function boundedMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 16_000) : undefined;
}

function actorForEvent(event: TaskEvent, eventType: string): WorkSessionActor | string {
  if (event.actor) return event.actor;
  if (eventType === "user_message" || eventType === "user_feedback") return "user";
  if (eventType === "tool_call" || eventType === "tool_result" || eventType.startsWith("tool_")) {
    return "tool";
  }
  if (eventType.startsWith("agent_") || eventType === "sub_agent_result") return "subagent";
  if (eventType === "approval_granted" || eventType === "approval_denied") return "controller";
  return "agent";
}

/** Map the existing TaskEvent vocabulary into the provider-neutral Item kind. */
export function mapTaskEventKind(eventType: string): WorkSessionItemKind {
  const normalized = eventType.trim();
  if (
    normalized === "user_message" ||
    normalized === "assistant_message" ||
    normalized === "user_feedback"
  ) {
    return "message";
  }
  if (normalized === "tool_call") return "tool_call";
  if (normalized === "tool_result") return "tool_result";
  if (
    normalized === "tool_error" ||
    normalized === "tool_warning" ||
    normalized === "tool_blocked"
  ) {
    return "error";
  }
  if (normalized.startsWith("approval_")) return "approval";
  if (normalized.startsWith("input_request") || normalized.startsWith("skill_parameter")) {
    return "input_request";
  }
  if (normalized.includes("compaction") || normalized === "context_summarized") return "compaction";
  if (
    normalized.includes("artifact") ||
    normalized.startsWith("file_") ||
    normalized === "image_generated" ||
    normalized === "diagram_created"
  ) {
    return "artifact";
  }
  if (normalized.includes("evidence") || normalized === "citations_collected") return "evidence";
  if (normalized === "error" || normalized.endsWith("_failed") || normalized.endsWith("_blocked")) {
    return "error";
  }
  if (STATUS_EVENT_TYPES.has(normalized) || normalized.startsWith("timeline_")) return "status";
  return "legacy_event";
}

function protocolStatusForTask(taskStatus: Task["status"]): WorkSessionStatus {
  switch (taskStatus) {
    case "executing":
      return "executing";
    case "paused":
    case "blocked":
    case "interrupted":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function statusForEvent(eventType: string, event: TaskEvent): WorkSessionTurnStatus | undefined {
  const payload = payloadRecord(event);
  const explicitStatus = payload.terminalStatus || payload.terminal_status;
  if (
    explicitStatus === "partial_success" ||
    explicitStatus === "failed" ||
    explicitStatus === "cancelled" ||
    explicitStatus === "completed" ||
    explicitStatus === "ok"
  ) {
    return explicitStatus === "ok" ? "completed" : (explicitStatus as WorkSessionTurnStatus);
  }
  if (
    eventType === "task_status" &&
    (payload.status === "partial_success" ||
      payload.status === "failed" ||
      payload.status === "cancelled" ||
      payload.status === "completed")
  ) {
    return payload.status as WorkSessionTurnStatus;
  }
  const terminal = TERMINAL_EVENT_STATUS[eventType];
  if (terminal) return terminal;
  if (WAITING_EVENT_TYPES.has(eventType)) return "waiting";
  if (EXECUTING_EVENT_TYPES.has(eventType)) return "executing";
  if (event.status === "blocked") return "waiting";
  if (event.status === "failed") return "failed";
  if (event.status === "cancelled") return "cancelled";
  if (event.status === "completed") return "completed";
  return undefined;
}

function isTerminalTurnStatus(status: WorkSessionTurnStatus): boolean {
  return (
    status === "completed" ||
    status === "partial_success" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function terminalReason(event: TaskEvent): string | undefined {
  const payload = payloadRecord(event);
  return boundedMessage(payload.reason || payload.error || payload.message || payload.summary);
}

export interface WorkSessionTaskEventResult {
  session: WorkSession;
  turn: WorkSessionTurn;
  item?: WorkSessionItem;
}

export class WorkSessionProtocolService {
  private readonly taskRepo: TaskRepository;
  private readonly eventRepo: TaskEventRepository;
  private readonly repository: WorkSessionProtocolRepository;
  private readonly reliability: WorkSessionReliabilityService;

  constructor(private readonly db: Database.Database) {
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
    this.repository = new WorkSessionProtocolRepository(db);
    this.reliability = new WorkSessionReliabilityService(db);
  }

  getRepository(): WorkSessionProtocolRepository {
    return this.repository;
  }

  getReliabilityService(): WorkSessionReliabilityService {
    return this.reliability;
  }

  ensureForTask(
    task: Pick<Task, "id" | "workspaceId" | "sessionId" | "status">,
  ): WorkSessionAggregate {
    const sessionId = task.sessionId?.trim() || task.id;
    const binding: WorkSessionTaskBinding = {
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId,
      status: protocolStatusForTask(task.status),
    };
    const aggregate = this.repository.ensureForTask(binding);
    // Existing task rows created before the protocol rollout may not have a
    // session_id. Backfill the stable id without changing task semantics.
    if (!task.sessionId && sessionId) {
      this.db
        .prepare(
          "UPDATE tasks SET session_id = ? WHERE id = ? AND (session_id IS NULL OR session_id = '')",
        )
        .run(sessionId, task.id);
    }
    if (aggregate.items.length <= 1) {
      this.backfillTaskEvents(task, aggregate);
    }
    return this.repository.findById(aggregate.session.id) || aggregate;
  }

  private backfillTaskEvents(
    task: Pick<Task, "id" | "workspaceId" | "sessionId" | "status">,
    aggregate: Pick<WorkSessionAggregate, "session">,
  ): void {
    const events = this.eventRepo
      .findByTaskId(task.id)
      .filter((event) => !EPHEMERAL_EVENT_TYPES.has(event.type))
      .sort((left, right) => {
        const leftSeq = typeof left.seq === "number" ? left.seq : Number.MAX_SAFE_INTEGER;
        const rightSeq = typeof right.seq === "number" ? right.seq : Number.MAX_SAFE_INTEGER;
        return (
          leftSeq - rightSeq || left.timestamp - right.timestamp || left.id.localeCompare(right.id)
        );
      });
    for (const event of events) {
      this.recordTaskEventForAggregate(task, aggregate, event);
    }
  }

  getSessionForTask(taskId: string): WorkSessionAggregate | undefined {
    const task = this.taskRepo.findById(taskId);
    if (!task) return undefined;
    return this.ensureForTask(task);
  }

  getSession(sessionId: string): WorkSessionAggregate | undefined {
    return this.repository.findById(sessionId);
  }

  /** Current cohort decision for a task's read path. */
  getReadModeForTask(taskId: string): WorkSessionReadMode {
    const task = this.taskRepo.findById(taskId);
    if (!task) return "legacy";
    return this.reliability.rollout.readMode({
      workspaceId: task.workspaceId,
      sessionId: task.sessionId || task.id,
    });
  }

  /**
   * Shared read switch for consumers migrating from Task/TaskEvent.  The
   * legacy callback remains available so rollback is a single config write,
   * without changing the canonical append/recovery path.
   */
  readWithRollout<T>(taskId: string, vnext: () => T, legacy: () => T): T {
    const task = this.taskRepo.findById(taskId);
    if (!task) return legacy();
    try {
      return this.reliability.rollout.choose(
        { workspaceId: task.workspaceId, sessionId: task.sessionId || task.id },
        vnext,
        legacy,
      );
    } catch (error) {
      // A canaried projection is never allowed to make the compatibility read
      // path unavailable. Operators can still flip the global rollback flag,
      // while an individual malformed/corrupt projection falls back for this
      // read immediately.
      try {
        this.reliability.metrics.record({
          sessionId: task.sessionId || task.id,
          workspaceId: task.workspaceId,
          name: "work_session.rollout_fallback",
          value: 1,
          unit: "fallback",
          dimensions: {
            error: error instanceof Error ? error.message.slice(0, 96) : "unknown",
          },
          idempotencyKey: `rollout-fallback:${task.id}:${Date.now()}`,
        });
      } catch {
        // Observability must never make the compatibility path fail.
      }
      return legacy();
    }
  }

  /**
   * Read the TaskEvent compatibility shape through the cohort switch. The
   * canonical item stream is the vNext source, while the caller owns the
   * legacy callback so the rollback path stays a single, atomic choice.
   */
  readTaskEvents(
    taskId: string,
    options: { limit?: number; types?: string[] } | undefined,
    legacy: () => TaskEvent[],
  ): TaskEvent[] {
    return this.readWithRollout(
      taskId,
      () => this.readCanonicalTaskEvents(taskId, options),
      legacy,
    );
  }

  private readCanonicalTaskEvents(
    taskId: string,
    options?: { limit?: number; types?: string[] },
  ): TaskEvent[] {
    const task = this.taskRepo.findById(taskId);
    if (!task) return [];
    const aggregate = this.getSessionForTask(taskId);
    if (!aggregate) return [];

    const normalizedTypes = new Set(
      (options?.types || [])
        .map((type) => (typeof type === "string" ? type.trim() : ""))
        .filter(Boolean),
    );
    const events = aggregate.items
      .filter((item) => {
        const raw = item.payload && typeof item.payload === "object" ? item.payload : {};
        // The protocol creates these bookkeeping items without a source
        // TaskEvent. They are useful for canonical replay but are not part of
        // the legacy timeline contract.
        const syntheticEvent = (raw as Record<string, unknown>).event;
        if (
          !item.sourceEventId &&
          (syntheticEvent === "session.created" ||
            (typeof syntheticEvent === "string" && syntheticEvent.startsWith("turn.")))
        ) {
          return false;
        }
        return true;
      })
      .map((item) => this.mapCanonicalItemToTaskEvent(task.id, item))
      .filter((event) => {
        if (normalizedTypes.size === 0) return true;
        const effectiveType = String(event.legacyType || event.type || "");
        return normalizedTypes.has(effectiveType);
      });

    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.min(200, Math.max(1, Math.floor(options.limit)))
        : undefined;
    return limit && events.length > limit ? events.slice(-limit) : events;
  }

  private mapCanonicalItemToTaskEvent(taskId: string, item: WorkSessionItem): TaskEvent {
    const raw =
      item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
        ? (item.payload as Record<string, unknown>)
        : {};
    const nested =
      raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : raw;
    const inferredType =
      (typeof raw.eventType === "string" && raw.eventType.trim()) ||
      (typeof raw.event === "string" && raw.event.trim()) ||
      (item.kind === "message"
        ? item.actor === "user"
          ? "user_message"
          : "assistant_message"
        : item.kind === "tool_call"
          ? "tool_call"
          : item.kind === "tool_result"
            ? "tool_result"
            : item.kind === "approval"
              ? "approval_requested"
              : item.kind === "input_request"
                ? "input_request_created"
                : item.kind === "compaction"
                  ? "context_compaction_completed"
                  : item.kind === "artifact"
                    ? "artifact_created"
                    : item.kind === "error"
                      ? "error"
                      : "legacy_event");
    const sourceType =
      typeof raw.sourceType === "string" && raw.sourceType.trim() ? raw.sourceType.trim() : "";
    const timestamp =
      typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
        ? raw.timestamp
        : item.createdAt;
    const eventId =
      (typeof raw.eventId === "string" && raw.eventId.trim() && raw.eventId.trim()) ||
      item.sourceEventId ||
      item.id;
    const event: TaskEvent = {
      id: item.sourceEventId || item.id,
      taskId,
      timestamp,
      type: (sourceType || inferredType) as TaskEvent["type"],
      payload: nested,
      schemaVersion: 2,
      eventId,
      seq:
        typeof raw.seq === "number" && Number.isFinite(raw.seq)
          ? Math.floor(raw.seq)
          : item.sequence,
      ts: timestamp,
      ...(typeof item.status === "string" ? { status: item.status as TaskEvent["status"] } : {}),
      ...(typeof nested.stepId === "string" ? { stepId: nested.stepId } : {}),
      ...(typeof nested.groupId === "string" ? { groupId: nested.groupId } : {}),
      ...(typeof item.actor === "string" ? { actor: item.actor as TaskEvent["actor"] } : {}),
    };
    if (sourceType && sourceType !== inferredType) {
      event.legacyType = inferredType as TaskEvent["legacyType"];
    }
    return event;
  }

  replay(sessionId: string) {
    return this.repository.replay(sessionId);
  }

  assertExpectedTurnForTask(taskId: string, expectedTurnId: string): WorkSessionTurn {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const session = this.ensureForTask(task);
    return this.repository.assertExpectedTurn(session.session.id, expectedTurnId);
  }

  beginUserMessage(
    taskId: string,
    message: string,
    options?: {
      expectedTurnId?: string;
      idempotencyKey?: string;
      policySnapshot?: Record<string, unknown>;
    },
  ): { session: WorkSession; turn: WorkSessionTurn; item: WorkSessionItem } {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const session = this.ensureForTask(task);
    const result = this.repository.appendUserMessage({
      sessionId: session.session.id,
      taskId: task.id,
      message,
      actor: "user",
      expectedTurnId: options?.expectedTurnId,
      idempotencyKey: options?.idempotencyKey,
      policySnapshot: options?.policySnapshot,
    });
    return { session: this.repository.findById(session.session.id)!.session, ...result };
  }

  /**
   * Dual-write one persisted TaskEvent into the canonical stream. The legacy
   * event remains the compatibility projection and is never mutated here.
   */
  recordTaskEvent(taskId: string, event: TaskEvent): WorkSessionTaskEventResult | undefined {
    if (!taskId || !event || EPHEMERAL_EVENT_TYPES.has(event.type)) return undefined;
    const task = this.taskRepo.findById(taskId);
    if (!task) return undefined;
    const session = this.repository.ensureSessionForTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: task.sessionId || task.id,
      status: protocolStatusForTask(task.status),
    });
    const sessionRef: Pick<WorkSessionAggregate, "session"> = { session };
    if (this.repository.countItems(session.id) <= 1) {
      this.backfillTaskEvents(task, sessionRef);
    }
    const currentSession = this.repository.getSessionById(session.id) || session;
    return this.recordTaskEventForAggregate(task, { session: currentSession }, event);
  }

  private recordTaskEventForAggregate(
    task: Pick<Task, "id" | "workspaceId" | "sessionId" | "status">,
    aggregate: Pick<WorkSessionAggregate, "session">,
    event: TaskEvent,
  ): WorkSessionTaskEventResult | undefined {
    const eventType = normalizeEventType(event);
    const payload = payloadRecord(event);
    const eventKey = event.eventId || event.id || `${event.taskId}:${event.timestamp}:${eventType}`;
    const idempotencyKey = `task-event:${eventKey}`;

    if (eventType === "user_message") {
      const message = boundedMessage(payload.message || payload.content || payload.text);
      if (message) {
        const result = this.repository.appendUserMessage({
          sessionId: aggregate.session.id,
          taskId: task.id,
          message,
          actor: actorForEvent(event, eventType),
          idempotencyKey,
          sourceEventId: event.eventId || event.id,
          policySnapshot: this.policySnapshot(payload),
        });
        this.reliability.observeTaskEvent({
          session: this.repository.getSessionById(aggregate.session.id)!,
          turnId: result.turn.id,
          event,
          item: result.item,
        });
        return {
          session: this.repository.getSessionById(aggregate.session.id)!,
          ...result,
        };
      }
    }

    let turn = this.repository.getCurrentTurn(aggregate.session.id);
    const eventStatus = statusForEvent(eventType, event);
    if (!turn || (turn.status === "waiting" && NEW_TURN_EVENT_TYPES.has(eventType))) {
      turn = this.repository.createTurn({
        sessionId: aggregate.session.id,
        taskId: task.id,
        actor: actorForEvent(event, eventType),
        idempotencyKey: `event-turn:${eventKey}`,
        status:
          eventStatus &&
          eventStatus !== "completed" &&
          eventStatus !== "failed" &&
          eventStatus !== "cancelled"
            ? eventStatus
            : "executing",
      });
    }

    const item = this.repository.appendItem({
      sessionId: aggregate.session.id,
      turnId: turn.id,
      kind: mapTaskEventKind(eventType),
      actor: actorForEvent(event, eventType),
      payload: {
        eventType,
        sourceType: event.type,
        eventId: event.eventId || event.id,
        timestamp: event.timestamp,
        ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
        payload,
      },
      causalParentItemId: this.repository.getLastItem(aggregate.session.id)?.id,
      idempotencyKey,
      sourceEventId: event.eventId || event.id,
      policySnapshot: this.policySnapshot(payload),
      redactionClass: "standard",
      status: eventStatus,
    });

    let finalTurn = turn;
    if (eventStatus && TERMINAL_EVENT_STATUS[eventType]) {
      finalTurn = this.repository.completeTurn({
        sessionId: aggregate.session.id,
        turnId: turn.id,
        status: eventStatus as Extract<
          WorkSessionTurnStatus,
          "completed" | "partial_success" | "failed" | "cancelled"
        >,
        reason: terminalReason(event),
        actor: actorForEvent(event, eventType),
      });
    } else if (eventStatus && eventStatus !== turn.status && !isTerminalTurnStatus(turn.status)) {
      finalTurn = this.repository.setTurnStatus(
        aggregate.session.id,
        turn.id,
        eventStatus,
        terminalReason(event),
      );
    }

    this.reliability.observeTaskEvent({
      session: this.repository.getSessionById(aggregate.session.id)!,
      turnId: finalTurn.id,
      event,
      item,
    });

    return {
      session: this.repository.getSessionById(aggregate.session.id)!,
      turn: finalTurn,
      item,
    };
  }

  private policySnapshot(payload: Record<string, unknown>): Record<string, unknown> | undefined {
    const candidate = payload.policySnapshot || payload.policy || payload.permissionSnapshot;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : undefined;
  }
}
