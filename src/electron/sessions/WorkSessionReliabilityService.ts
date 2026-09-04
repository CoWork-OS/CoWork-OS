import type Database from "better-sqlite3";
import type {
  TaskEvent,
  WorkSession,
  WorkSessionActivityLeaseKind,
  WorkSessionItem,
  WorkSessionOperationalMetric,
  WorkSessionProjectionUpdate,
  WorkSessionReplayEvaluationResult,
} from "../../shared/types";
import {
  WorkSessionActivityLeaseRepository,
  type WorkSessionActivityLeaseAcquireInput,
} from "../database/WorkSessionActivityLeaseRepository";
import { WorkSessionOperationalMetricsRepository } from "../database/WorkSessionOperationalMetricsRepository";
import {
  WorkSessionProjectionRepository,
  type WorkSessionProjectionOptions,
} from "../database/WorkSessionProjectionRepository";
import {
  evaluateDeterministicReplayFixtures,
  evaluateIsolatedReplay,
  type WorkSessionReplayEvaluationOptions,
} from "./WorkSessionReplayEvaluationService";
import { WorkSessionRolloutService } from "./WorkSessionRolloutService";

const PROJECTION_NAME = "work-session-vnext";
const DEFAULT_ACTIVITY_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_LEASE_MAINTENANCE_INTERVAL_MS = 10_000;
const MAX_STATUS_BY_TURN = 4_096;
const END_EVENTS = new Set([
  "llm_completed",
  "provider_request_completed",
  "assistant_message",
  "tool_result",
  "tool_error",
  "tool_blocked",
  "llm_usage",
  "llm_error",
  "llm_cancelled",
  "provider_request_failed",
  "provider_request_error",
  "retry_completed",
  "approval_granted",
  "approval_denied",
  "approval_cancelled",
  "input_response",
  "input_request_resolved",
  "input_request_dismissed",
  "wait_resolved",
  "reconnect_succeeded",
  "reconnect_failed",
  "child_completed",
  "child_session_completed",
  "child_failed",
  "child_session_failed",
  "auto_continuation_completed",
  "follow_up_turn_recovery_completed",
]);
const RESUME_EVENTS = new Set(["task_resumed", "input_response", "wait_resolved"]);
const WAIT_EVENTS = new Set([
  "approval_requested",
  "input_request_created",
  "reconnect_requested",
  "child_wait",
  "task_paused",
  "task_interrupted",
  "verification_pending_user_action",
  "auto_continuation_blocked",
  "follow_up_turn_recovery_blocked",
  "safety_stop_triggered",
  "mode_gate_blocked",
]);
const LEASE_START_EVENTS = new Set([
  ...WAIT_EVENTS,
  "llm_started",
  "provider_request_started",
  "tool_call",
  "tool_call_update",
  "retry_started",
  "llm_retry",
  "auto_continuation_started",
  "follow_up_turn_recovery_started",
  "child_started",
  "child_session_started",
]);
const TERMINAL_TASK_EVENTS = new Set(["task_completed", "task_failed", "task_cancelled"]);

export interface WorkSessionReliabilityOptions {
  now?: () => number;
  projectionCompareEveryItems?: number;
  projectionCompareEveryMs?: number;
  /** Lease lifetime used by the coordinator; repository defaults remain short for direct callers. */
  activityLeaseTtlMs?: number;
  /** Background sweep/heartbeat cadence. Set to 0 to disable automatic maintenance. */
  leaseMaintenanceIntervalMs?: number;
}

export interface WorkSessionReliabilityObservation {
  session: Pick<WorkSession, "id" | "workspaceId">;
  turnId?: string;
  event: Pick<TaskEvent, "type" | "eventId" | "id" | "payload" | "timestamp"> & {
    legacyType?: string;
  };
  item?: WorkSessionItem;
}

export interface WorkSessionReliabilityResult {
  projection?: WorkSessionProjectionUpdate<WorkSessionReliabilityProjectionState>;
  lease?: ReturnType<WorkSessionActivityLeaseRepository["acquire"]>;
  metric?: WorkSessionOperationalMetric;
  projectionError?: string;
}

export interface WorkSessionReliabilityProjectionState {
  itemCount: number;
  lastSequence: number;
  lastKind?: string;
  lastEventType?: string;
  statusByTurn: Record<string, string>;
}

function eventType(event: WorkSessionReliabilityObservation["event"]): string {
  if (typeof event.legacyType === "string" && event.legacyType.trim())
    return event.legacyType.trim();
  const payload = event.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const candidate = (payload as Record<string, unknown>).legacyType;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return String(event.type || "legacy_event");
}

function payloadRecord(event: WorkSessionReliabilityObservation["event"]): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function nestedIdentifier(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const identifier = (value as Record<string, unknown>).id;
  return typeof identifier === "string" && identifier.trim() ? identifier.trim() : undefined;
}

function operationKey(
  sessionId: string,
  kind: WorkSessionActivityLeaseKind,
  event: WorkSessionReliabilityObservation["event"],
): string {
  const payload = payloadRecord(event);
  const operation = [
    payload.activityId,
    payload.operationKey,
    payload.operationId,
    payload.requestId,
    payload.approvalId,
    payload.toolCallId,
    payload.toolUseId,
    payload.callId,
    payload.correlationId,
    payload.runId,
    payload.retryId,
    payload.continuationId,
    payload.reconnectId,
    payload.childSessionId,
    payload.childTaskId,
    payload.approvalRequestId,
    payload.inputRequestId,
    nestedIdentifier(payload, "approval"),
    nestedIdentifier(payload, "request"),
    nestedIdentifier(payload, "inputRequest"),
  ].find((value) => typeof value === "string" && value.trim());
  // Keep identity independent of provider/kind so one activity can move from
  // an LLM call to a tool, retry, wait, join, or reconnect.
  const fallback = event.eventId || event.id || `${event.type}:${event.timestamp}`;
  return `session:${sessionId}:activity:${typeof operation === "string" ? operation.trim() : fallback}`;
}

function leaseKind(type: string): WorkSessionActivityLeaseKind {
  if (type.includes("tool")) return "tool";
  if (type.includes("retry") || type.includes("continuation")) return "retry";
  if (type.includes("child") || type.includes("join")) return "join";
  if (type.includes("reconnect")) return "reconnect";
  if (type.includes("approval") || type.includes("input") || WAIT_EVENTS.has(type)) return "wait";
  return "llm";
}

function projectionOptions(
  options: WorkSessionReliabilityOptions,
): WorkSessionProjectionOptions<WorkSessionReliabilityProjectionState> {
  return {
    projectionName: PROJECTION_NAME,
    initialState: {
      itemCount: 0,
      lastSequence: 0,
      statusByTurn: {},
    },
    reduce: (state, item) => ({
      itemCount: state.itemCount + 1,
      lastSequence: item.sequence,
      lastKind: item.kind,
      lastEventType:
        item.payload && typeof item.payload.eventType === "string"
          ? item.payload.eventType
          : item.kind,
      statusByTurn: (() => {
        if (!item.status) return state.statusByTurn;
        const next = { ...state.statusByTurn, [item.turnId]: item.status };
        const keys = Object.keys(next);
        if (keys.length > MAX_STATUS_BY_TURN) {
          for (const key of keys.slice(0, keys.length - MAX_STATUS_BY_TURN)) delete next[key];
        }
        return next;
      })(),
    }),
    ...(options.projectionCompareEveryItems === undefined
      ? {}
      : { compareEveryItems: options.projectionCompareEveryItems }),
    ...(options.projectionCompareEveryMs === undefined
      ? {}
      : { compareEveryMs: options.projectionCompareEveryMs }),
  };
}

/** Coordinates Phase 5 persistence without making providers part of the contract. */
export class WorkSessionReliabilityService {
  readonly projections: WorkSessionProjectionRepository;
  readonly leases: WorkSessionActivityLeaseRepository;
  readonly metrics: WorkSessionOperationalMetricsRepository;
  readonly rollout: WorkSessionRolloutService;
  private readonly now: () => number;
  private readonly projectionOptions: WorkSessionProjectionOptions<WorkSessionReliabilityProjectionState>;
  private readonly activityLeaseTtlMs: number;
  private readonly leaseMaintenanceIntervalMs: number;
  private readonly leaseTokens = new Map<string, { token: string; ttlMs: number }>();
  private leaseMaintenanceTimer?: ReturnType<typeof setInterval>;

  constructor(db: Database.Database, options: WorkSessionReliabilityOptions = {}) {
    this.now = options.now || Date.now;
    this.projections = new WorkSessionProjectionRepository(db, { now: this.now });
    this.leases = new WorkSessionActivityLeaseRepository(db, { now: this.now });
    this.metrics = new WorkSessionOperationalMetricsRepository(db, { now: this.now });
    this.rollout = new WorkSessionRolloutService(db, this.now);
    this.activityLeaseTtlMs = Math.min(
      30 * 60_000,
      Math.max(1_000, Math.floor(options.activityLeaseTtlMs || DEFAULT_ACTIVITY_LEASE_TTL_MS)),
    );
    const requestedMaintenanceInterval = options.leaseMaintenanceIntervalMs;
    this.leaseMaintenanceIntervalMs = Number.isFinite(requestedMaintenanceInterval)
      ? Math.max(0, Math.floor(requestedMaintenanceInterval!))
      : DEFAULT_LEASE_MAINTENANCE_INTERVAL_MS;
    this.projectionOptions = projectionOptions(options);
  }

  /** Start provider-independent expiry sweeping and heartbeats for daemon work. */
  start(): void {
    if (this.leaseMaintenanceTimer || this.leaseMaintenanceIntervalMs <= 0) return;
    this.leases.startSweeper(this.leaseMaintenanceIntervalMs);
    this.leaseMaintenanceTimer = setInterval(
      () => this.maintainKnownLeases(),
      this.leaseMaintenanceIntervalMs,
    );
    this.leaseMaintenanceTimer.unref?.();
  }

  stop(): void {
    if (this.leaseMaintenanceTimer) {
      clearInterval(this.leaseMaintenanceTimer);
      this.leaseMaintenanceTimer = undefined;
    }
    this.leases.stopSweeper();
    this.leaseTokens.clear();
  }

  private maintainKnownLeases(): void {
    const now = this.now();
    for (const [leaseId, lease] of this.leaseTokens) {
      try {
        const current = this.leases.listActive().find((candidate) => candidate.id === leaseId);
        if (!current) {
          this.leaseTokens.delete(leaseId);
          continue;
        }
        if (current.expiresAt - now <= Math.max(1_000, Math.floor(lease.ttlMs / 2))) {
          const renewed = this.leases.renew(leaseId, lease.token, lease.ttlMs);
          if (renewed.token) lease.token = renewed.token;
        }
      } catch {
        // Expiry/restart races are expected. The next event can reacquire or
        // explicitly reclaim a stale lease without affecting user work.
        this.leaseTokens.delete(leaseId);
      }
    }
  }

  private isTerminalSession(sessionId: string): boolean {
    const status = this.leases.getSessionStatus(sessionId);
    return (
      status === "completed" ||
      status === "partial_success" ||
      status === "failed" ||
      status === "cancelled"
    );
  }

  observeTaskEvent(observation: WorkSessionReliabilityObservation): WorkSessionReliabilityResult {
    const type = eventType(observation.event);
    const tracksLeaseLifecycle = LEASE_START_EVENTS.has(type) || END_EVENTS.has(type);
    const kind = tracksLeaseLifecycle ? leaseKind(type) : undefined;
    const operation = kind
      ? operationKey(observation.session.id, kind, observation.event)
      : undefined;
    let lease: ReturnType<WorkSessionActivityLeaseRepository["acquire"]> | undefined;
    try {
      const terminalSession = this.isTerminalSession(observation.session.id);
      if (terminalSession && !RESUME_EVENTS.has(type)) {
        // Late telemetry must never resurrect a completed session's default
        // lease. Terminal cleanup is idempotent and handles leases emitted
        // before the terminal event committed.
        this.leases.releaseSession(observation.session.id);
      } else {
        if (LEASE_START_EVENTS.has(type) && kind && operation) {
          const input: WorkSessionActivityLeaseAcquireInput = {
            sessionId: observation.session.id,
            ...(observation.turnId ? { turnId: observation.turnId } : {}),
            kind,
            operationKey: operation,
            ttlMs: this.activityLeaseTtlMs,
          };
          lease = this.leases.acquire(input);
          if (lease.token) {
            this.leaseTokens.set(lease.id, { token: lease.token, ttlMs: this.activityLeaseTtlMs });
          }
          if (lease.token) {
            lease = this.leases.renew(lease.id, lease.token, this.activityLeaseTtlMs);
          }
        } else if (END_EVENTS.has(type) && operation) {
          // End events should close an existing operation, but must not create
          // a new lease when they arrive without a matching start event.
          lease = this.leases.releaseByOperationKey(observation.session.id, operation);
        }
        if (RESUME_EVENTS.has(type)) {
          this.leases.releaseKinds(observation.session.id, ["wait", "join", "reconnect"]);
        }
        if (TERMINAL_TASK_EVENTS.has(type)) {
          this.leases.releaseSession(observation.session.id);
        }
      }
    } catch (error) {
      // Reliability bookkeeping is fail-open for legacy event delivery: the
      // canonical item has already been committed and remains recoverable.
      try {
        this.metrics.record({
          sessionId: observation.session.id,
          workspaceId: observation.session.workspaceId,
          name: "work_session.lease_error",
          value: 1,
          unit: "error",
          dimensions: {
            kind: kind || "none",
            code:
              error && typeof error === "object" && "code" in error
                ? String((error as { code?: unknown }).code || "unknown")
                : "unknown",
          },
          idempotencyKey: `lease-error:${observation.session.id}:${observation.event.eventId || observation.event.id || `${type}:${observation.event.timestamp}`}`,
        });
      } catch {
        // Metrics remain best-effort.
      }
    }

    let metric: WorkSessionOperationalMetric | undefined;
    try {
      metric = this.metrics.record({
        sessionId: observation.session.id,
        workspaceId: observation.session.workspaceId,
        name: "work_session.event",
        value: 1,
        unit: "count",
        dimensions: { type, ...(kind ? { leaseKind: kind } : {}) },
        idempotencyKey: `event:${observation.event.eventId || observation.event.id || `${type}:${observation.event.timestamp}`}`,
        recordedAt: observation.event.timestamp,
      });
    } catch {
      // Metrics are bounded observability, never a reason to drop user work.
    }

    let projection: WorkSessionProjectionUpdate<WorkSessionReliabilityProjectionState> | undefined;
    if (observation.item) {
      try {
        projection = this.projections.projectIncremental(
          observation.session.id,
          this.projectionOptions,
        );
        if (projection.processed > 0) {
          this.metrics.record({
            sessionId: observation.session.id,
            workspaceId: observation.session.workspaceId,
            name: "work_session.projection_items",
            value: projection.processed,
            unit: "items",
            dimensions: { projection: PROJECTION_NAME },
            idempotencyKey: `projection:${observation.session.id}:${projection.cursor.lastSequence}`,
          });
        }
        if (projection.comparisonPerformed) {
          const comparisonKey =
            projection.fullRebuildChecksum || `sequence:${projection.cursor.lastSequence}`;
          this.metrics.record({
            sessionId: observation.session.id,
            workspaceId: observation.session.workspaceId,
            name: "work_session.projection_compare",
            value: 1,
            unit: "comparison",
            dimensions: {
              projection: PROJECTION_NAME,
              matched: projection.matches === true ? "true" : "false",
            },
            idempotencyKey: `projection-compare:${observation.session.id}:${comparisonKey}`,
          });
          if (projection.matches === false) {
            this.metrics.record({
              sessionId: observation.session.id,
              workspaceId: observation.session.workspaceId,
              name: "work_session.projection_mismatch",
              value: 1,
              unit: "comparison",
              dimensions: { projection: PROJECTION_NAME },
              idempotencyKey: `projection-mismatch:${observation.session.id}:${comparisonKey}`,
            });
          }
        }
      } catch (error) {
        // A projection can always be rebuilt from the canonical item stream.
        const message = error instanceof Error ? error.message : String(error);
        try {
          this.metrics.record({
            sessionId: observation.session.id,
            workspaceId: observation.session.workspaceId,
            name: "work_session.projection_error",
            value: 1,
            unit: "error",
            dimensions: { projection: PROJECTION_NAME, error: message.slice(0, 96) },
            idempotencyKey: `projection-error:${observation.session.id}:${observation.item.sequence}:${message.slice(0, 96)}`,
          });
        } catch {
          // Keep canonical event delivery fail-open.
        }
        return {
          ...(projection ? { projection } : {}),
          ...(lease ? { lease } : {}),
          ...(metric ? { metric } : {}),
          projectionError: message,
        };
      }
    }
    return {
      ...(projection ? { projection } : {}),
      ...(lease ? { lease } : {}),
      ...(metric ? { metric } : {}),
    };
  }

  /** Explicitly reclaim a lease after a daemon reconnect if its heartbeat is stale. */
  reclaimActivityLease(input: WorkSessionActivityLeaseAcquireInput) {
    const ttlMs = input.ttlMs ?? this.activityLeaseTtlMs;
    const lease = this.leases.reclaim({ ...input, ttlMs });
    if (lease.token) this.leaseTokens.set(lease.id, { token: lease.token, ttlMs });
    return lease;
  }

  projectSession(
    sessionId: string,
  ): WorkSessionProjectionUpdate<WorkSessionReliabilityProjectionState> {
    return this.projections.projectIncremental(sessionId, this.projectionOptions);
  }

  evaluateReplay(
    items: WorkSessionItem[],
    fixtureOrOptions?: string | WorkSessionReplayEvaluationOptions,
  ): WorkSessionReplayEvaluationResult {
    return evaluateIsolatedReplay(items, fixtureOrOptions);
  }

  evaluateReplayFixtureSuite(): WorkSessionReplayEvaluationResult[] {
    return evaluateDeterministicReplayFixtures();
  }
}
